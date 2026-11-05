import {
  P3A_PACE_MINUTES,
  P3A_SPEEDS,
  P3A_YEAR_MS_MAX,
  P3A_YEAR_MS_MIN,
  P3C_SCHEMA_VERSION,
  type P3CLifeState,
  type SerializedP3CLifeState
} from "@life-sim/contracts";
import { asPppMicro, decodeMoney, encodeMoney, MoneyError } from "../../money";
import { computeYearDurationMs } from "../index";
import { guard } from "./errors";
import { EventLifeError } from "./errors";
import {
  assertEventLifeApprovedVersions,
  assertEventLifeInvariants,
  createEventLifeState
} from "./state";
import { verifyEventLifeReplay } from "./replay";

/**
 * 存檔邊界（P3-C）。
 *
 * - 只接受「正式版本 ＋ 非 error」的狀態；`phase = "error"` 是暫態終止畫面（P3-A.4 不變）。
 * - `p3a-1` 的序列化狀態**不會**被當成 `p3c-1`：`schemaVersion` 不符就是 `E_P3C_VERSION`
 *   （反之 `p3a` 入口也會拒絕 `p3c-1`，兩邊都不會靜默誤讀）。
 * - 反序列化是信任邊界：必須提供 bootstrap 與 validated pack，並從 genesis 重播比對；
 *   playback 依冷啟動政策還原後再跑一次完整 invariant。
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function fail(code: "E_P3C_TYPE" | "E_P3C_STATE" | "E_P3C_PHASE" | "E_P3C_SPEED" | "E_P3C_PACE" | "E_P3C_HISTORY" | "E_P3C_MONEY" | "E_P3C_VERSION", path?: string): never {
  throw new EventLifeError(code, path);
}

function decodeMoneyOrFail(value: unknown): bigint {
  if (typeof value !== "string") fail("E_P3C_MONEY");
  try {
    return asPppMicro(decodeMoney(value));
  } catch (error) {
    if (error instanceof MoneyError) fail("E_P3C_MONEY");
    throw error;
  }
}

/** 存檔邊界：拒絕 error 狀態與未核准版本。 */
export function serializeEventLifeState(state: unknown): SerializedP3CLifeState {
  return serializeInternal(state, false);
}

/** 內部序列化（benchmark ruleset 用）。不從 barrel 匯出。 */
export function serializeEventLifeStateForBenchmark(state: unknown): SerializedP3CLifeState {
  return serializeInternal(state, true);
}

function serializeInternal(state: unknown, allowBenchmark: boolean): SerializedP3CLifeState {
  return guard(() => {
    assertEventLifeInvariants(state);
    if (!allowBenchmark) assertEventLifeApprovedVersions(state.versions);
    if (state.phase === "error") fail("E_P3C_PHASE", "phase");
    return {
      ...state,
      assets: {
        balanceMicroUsd: encodeMoney(asPppMicro(state.assets.balanceMicroUsd)) as never,
        annualIncomeMicroUsd: encodeMoney(asPppMicro(state.assets.annualIncomeMicroUsd)) as never,
        annualExpenseMicroUsd: encodeMoney(asPppMicro(state.assets.annualExpenseMicroUsd)) as never
      }
    } as unknown as SerializedP3CLifeState;
  });
}

/** 低階解析：只還原金錢型別與形狀（不做信任宣告）。 */
function parseEventLifeState(serialized: unknown): P3CLifeState {
  if (!isRecord(serialized)) fail("E_P3C_TYPE", "serialized");
  if (serialized.schemaVersion !== P3C_SCHEMA_VERSION) fail("E_P3C_VERSION", "serialized.schemaVersion");
  const assets = serialized.assets;
  if (!isRecord(assets)) fail("E_P3C_MONEY", "serialized.assets");
  const state = {
    ...(serialized as unknown as P3CLifeState),
    assets: {
      balanceMicroUsd: decodeMoneyOrFail(assets.balanceMicroUsd),
      annualIncomeMicroUsd: decodeMoneyOrFail(assets.annualIncomeMicroUsd),
      annualExpenseMicroUsd: decodeMoneyOrFail(assets.annualExpenseMicroUsd)
    }
  } as P3CLifeState;
  assertEventLifeInvariants(state);
  return state;
}

/**
 * 冷啟動還原政策（與 P3-A 相同）：保留 speed／paceMinutes／elapsedInYearMs／cardsSeen；
 * 強制 `paused`／`visible`／`previousMode = paused`；`yearDurationMs` 依 pace 契約重算。
 */
function coldStartPlayback(raw: unknown, state: P3CLifeState): P3CLifeState["playback"] {
  if (!isRecord(raw)) fail("E_P3C_TYPE", "playback");
  const record = raw as Record<string, unknown>;
  if (!["playing", "paused", "fast_forward"].includes(record.mode as string)) fail("E_P3C_STATE", "playback.mode");
  if (!["visible", "hidden"].includes(record.visibility as string)) fail("E_P3C_STATE", "playback.visibility");
  if (record.previousMode !== "playing" && record.previousMode !== "paused") fail("E_P3C_STATE", "playback.previousMode");
  if (!(P3A_SPEEDS as readonly number[]).includes(record.speed as number)) fail("E_P3C_SPEED", "playback.speed");
  if (!(P3A_PACE_MINUTES as readonly number[]).includes(record.paceMinutes as number)) fail("E_P3C_PACE", "playback.paceMinutes");
  if (!isSafeInt(record.elapsedInYearMs) || (record.elapsedInYearMs as number) < 0) fail("E_P3C_STATE", "playback.elapsedInYearMs");
  if (!isSafeInt(record.cardsSeen) || (record.cardsSeen as number) < 0) fail("E_P3C_HISTORY", "playback.cardsSeen");
  const paceMinutes = record.paceMinutes as number;
  const yearDurationMs = computeYearDurationMs(paceMinutes, state.paceLifeYearsX10);
  if (yearDurationMs < P3A_YEAR_MS_MIN || yearDurationMs > P3A_YEAR_MS_MAX) fail("E_P3C_PACE", "playback.yearDurationMs");
  if ((record.elapsedInYearMs as number) >= yearDurationMs) fail("E_P3C_STATE", "playback.elapsedInYearMs");
  return {
    mode: "paused",
    visibility: "visible",
    previousMode: "paused",
    speed: record.speed as P3CLifeState["playback"]["speed"],
    paceMinutes: paceMinutes as P3CLifeState["playback"]["paceMinutes"],
    yearDurationMs,
    elapsedInYearMs: record.elapsedInYearMs as number,
    cardsSeen: record.cardsSeen as number
  };
}

/**
 * 反序列化（信任邊界）：bootstrap ＋ pack 必填，genesis 重播比對後才回傳。
 * 舊的 `p3a-1` 存檔會在這裡被 `E_P3C_VERSION` 明確拒絕，不會被靜默升級。
 */
export function deserializeEventLifeState(serialized: unknown, bootstrap: unknown, pack: unknown): P3CLifeState {
  return guard(() => {
    const parsed = parseEventLifeState(serialized);
    // 先確認 bootstrap 可以建立同一條命（版本／origin／birthYear／pace 都要一致）。
    const probe = createEventLifeState(bootstrap, pack);
    if (probe.origin.certificateHash !== parsed.origin.certificateHash) fail("E_P3C_STATE", "origin");
    const trace = verifyEventLifeReplay({ bootstrap, targetState: parsed }, pack);
    const merged: P3CLifeState = { ...trace.state, playback: coldStartPlayback(parsed.playback, trace.state) };
    assertEventLifeInvariants(merged);
    return merged;
  });
}
