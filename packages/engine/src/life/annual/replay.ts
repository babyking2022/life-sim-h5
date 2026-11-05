import type { P3ACommandRecord, P3CYearDelta, P3CLifeState } from "@life-sim/contracts";
import type { ValidatedEventPack } from "../events/validate";
import { applyEventLifeCommand } from "./commands";
import { EventLifeError, guard } from "./errors";
import {
  assertEventLifeApprovedVersions,
  assertEventLifeInvariants,
  assertPackBinding,
  createEventLifeState,
  createEventLifeStateForBenchmark,
  eventLifeProjection
} from "./state";
import { resolveEventYearCore } from "./transaction";

/**
 * 重播：bootstrap ＋ validated pack ＋ commandLog 是唯一權威。
 *
 * 事件選擇、effects、occurrences、selectionHash 與 RNG 都會被重新推導，
 * 因此「改 occurrences」「改 selectionHash」「換 pack」「改 pendingDecision」都無法通過驗證。
 */

const MAX_REPLAY_YEARS = 100_000;

export interface P3CEventReplayInput {
  readonly bootstrap: unknown;
  readonly targetYears: number;
  readonly commandLog: readonly P3ACommandRecord[];
}

export interface P3CEventVerifyInput {
  readonly bootstrap: unknown;
  readonly targetState: unknown;
  readonly commandLog?: readonly P3ACommandRecord[];
}

export interface P3CEventReplayTrace {
  readonly state: P3CLifeState;
  readonly deltas: readonly P3CYearDelta[];
  readonly yearsReplayed: number;
  readonly commandsConsumed: number;
}

const RECORD_FIELDS = [
  "seq",
  "commandType",
  "payload",
  "argsHash",
  "atYear",
  "effectiveYear",
  "auto",
  "policyId",
  "rngDraws",
  "stateHashBefore",
  "stateHashAfter",
  "chainHash"
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function fail(code: "E_P3C_ARGUMENT" | "E_P3C_HASH" | "E_P3C_PHASE" | "E_P3C_TYPE", path?: string): never {
  throw new EventLifeError(code, path);
}

function sameRngWords(a: readonly number[], b: readonly number[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
  for (let index = 0; index < 4; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function sameRecord(expected: P3ACommandRecord, actual: P3ACommandRecord): boolean {
  if (!isRecord(expected as unknown)) return false;
  for (const field of RECORD_FIELDS) {
    if (expected[field] !== actual[field]) return false;
  }
  return sameRngWords(expected.rngState, actual.rngState);
}

function createStateForReplay(bootstrap: unknown, pack: unknown, allowBenchmark: boolean, lifespanYears: number): P3CLifeState {
  return allowBenchmark ? createEventLifeStateForBenchmark(bootstrap, pack, lifespanYears) : createEventLifeState(bootstrap, pack);
}

interface ReplayOptions {
  readonly allowBenchmark: boolean;
  readonly lifespanYears: number;
}

function reconstructInternal(input: unknown, pack: unknown, options: ReplayOptions): P3CEventReplayTrace {
  if (!isRecord(input)) fail("E_P3C_TYPE", "input");
  const raw = input as Record<string, unknown>;
  const targetYears = raw.targetYears;
  if (!isSafeInt(targetYears) || targetYears < 0 || targetYears > MAX_REPLAY_YEARS) fail("E_P3C_ARGUMENT", "targetYears");
  if (!Array.isArray(raw.commandLog)) fail("E_P3C_ARGUMENT", "commandLog");
  const records = raw.commandLog as readonly P3ACommandRecord[];
  const boundPack = pack as ValidatedEventPack;

  let state = createStateForReplay(raw.bootstrap, pack, options.allowBenchmark, options.lifespanYears);
  const deltas: P3CYearDelta[] = [];
  let index = 0;

  /** 吃掉一筆必須與重播結果逐欄相同的指令。 */
  const consume = (kind: "SELECT_DECISION" | "CONFIRM_DECISION"): void => {
    const given = records[index] as P3ACommandRecord;
    const next =
      kind === "SELECT_DECISION"
        ? applyEventLifeCommand(state, { type: "SELECT_DECISION", optionId: given.payload }, pack).state
        : applyEventLifeCommand(state, { type: "NEXT" }, pack).state;
    const produced = next.commandLog[next.commandLog.length - 1];
    if (produced === undefined) fail("E_P3C_ARGUMENT", `commandLog[${index}]`);
    if (!sameRecord(given, produced)) fail("E_P3C_HASH", `commandLog[${index}]`);
    index += 1;
    state = next;
  };

  while (true) {
    const head = records[index];
    if (head !== undefined && isRecord(head as unknown)) {
      const pending = state.pendingDecision;
      if (head.commandType === "SELECT_DECISION" && pending !== null && pending.selectedOptionId === null) {
        consume("SELECT_DECISION");
        continue;
      }
      if (head.commandType === "CONFIRM_DECISION" && pending !== null && pending.selectedOptionId !== null) {
        consume("CONFIRM_DECISION");
        continue;
      }
    }
    if (state.history.yearsRecorded >= targetYears) break;
    if (state.pendingDecision !== null) fail("E_P3C_ARGUMENT", `commandLog[${index}]`);
    if (state.phase !== "life") fail("E_P3C_ARGUMENT", `commandLog[${index}]`);
    const result = resolveEventYearCore(state, boundPack);
    state = result.state;
    deltas.push(result.delta);
  }

  if (index < records.length) fail("E_P3C_ARGUMENT", `commandLog[${index}]`);
  return { state, deltas, yearsReplayed: state.history.yearsRecorded, commandsConsumed: index };
}

/** 重建：只負責產生狀態，不宣告可信。 */
export function reconstructEventLifeState(input: unknown, pack: unknown): P3CEventReplayTrace {
  return guard(() => reconstructInternal(input, pack, { allowBenchmark: false, lifespanYears: 0 }));
}

/** 內部重建（benchmark ruleset）。不從 barrel 匯出。 */
export function reconstructEventLifeStateForBenchmark(input: unknown, pack: unknown, lifespanYears: number): P3CEventReplayTrace {
  return guard(() => reconstructInternal(input, pack, { allowBenchmark: true, lifespanYears }));
}

function authoritativeFingerprint(state: P3CLifeState): Record<string, unknown> {
  return {
    projection: eventLifeProjection(state),
    initialStateHash: state.history.initialStateHash,
    commandLog: state.commandLog.map((record) => ({
      seq: record.seq,
      commandType: record.commandType,
      payload: record.payload,
      argsHash: record.argsHash,
      atYear: record.atYear,
      effectiveYear: record.effectiveYear,
      auto: record.auto,
      policyId: record.policyId,
      rngState: [...record.rngState],
      rngDraws: record.rngDraws,
      stateHashBefore: record.stateHashBefore,
      stateHashAfter: record.stateHashAfter,
      chainHash: record.chainHash
    })),
    hashChain: state.hashChain,
    stateHash: state.stateHash
  };
}

const FINGERPRINT_KEYS = ["projection", "initialStateHash", "commandLog", "hashChain", "stateHash"] as const;

function firstDifferingField(expected: P3CLifeState, actual: P3CLifeState): string | null {
  const left = authoritativeFingerprint(expected);
  const right = authoritativeFingerprint(actual);
  for (const key of FINGERPRINT_KEYS) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return key;
  }
  return null;
}

function verifyInternal(input: unknown, pack: unknown, options: ReplayOptions, requireApprovedVersions: boolean): P3CEventReplayTrace {
  if (!isRecord(input)) fail("E_P3C_TYPE", "input");
  const raw = input as Record<string, unknown>;
  const target = raw.targetState;
  assertEventLifeInvariants(target);
  if (requireApprovedVersions) assertEventLifeApprovedVersions(target.versions);
  if (target.phase === "error") fail("E_P3C_PHASE", "targetState.phase");
  assertPackBinding(target, pack);
  if (!isRecord(raw.bootstrap)) fail("E_P3C_TYPE", "bootstrap");
  let log = target.commandLog;
  if (raw.commandLog !== undefined) {
    if (!Array.isArray(raw.commandLog)) fail("E_P3C_ARGUMENT", "commandLog");
    if (raw.commandLog.length !== target.commandLog.length) fail("E_P3C_ARGUMENT", "commandLog");
    log = raw.commandLog as readonly P3ACommandRecord[];
  }
  const trace = reconstructInternal(
    { bootstrap: raw.bootstrap, targetYears: target.history.yearsRecorded, commandLog: log },
    pack,
    options
  );
  const field = firstDifferingField(target, trace.state);
  if (field !== null) throw new EventLifeError("E_P3C_HASH", `field:${field}`);
  return trace;
}

/**
 * 驗證：targetState 必填，先完整驗證，再從 genesis 重播並逐欄比對。
 * `phase = "error"` 不是合法存檔終點，因此不接受為驗證目標。
 */
export function verifyEventLifeReplay(input: unknown, pack: unknown): P3CEventReplayTrace {
  return guard(() => verifyInternal(input, pack, { allowBenchmark: false, lifespanYears: 0 }, true));
}

/** 便利入口：`verifyEventLifeReplay({ bootstrap, targetState: state })`。 */
export function verifyEventLifeState(bootstrap: unknown, state: unknown, pack: unknown): P3CEventReplayTrace {
  return guard(() => verifyEventLifeReplay({ bootstrap, targetState: state }, pack));
}

/** 驗證便利入口（benchmark ruleset 用）。不從 barrel 匯出。 */
export function verifyEventLifeStateForBenchmark(bootstrap: unknown, state: unknown, pack: unknown): P3CEventReplayTrace {
  return guard(() => {
    if (!isRecord(state)) fail("E_P3C_TYPE", "state");
    const lifespanYears = (state as Record<string, unknown>).lifespanYears;
    if (!isSafeInt(lifespanYears) || lifespanYears < 1) fail("E_P3C_ARGUMENT", "state.lifespanYears");
    return verifyInternal({ bootstrap, targetState: state }, pack, { allowBenchmark: true, lifespanYears }, false);
  });
}
