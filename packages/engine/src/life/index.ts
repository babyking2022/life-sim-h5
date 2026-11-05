import {
  P3A_CONTENT_VERSION,
  P3A_DECISION_AGES,
  P3A_EMPTY_HISTORY_HASH,
  P3A_ERROR_CODES,
  P3A_FAST_FORWARD_MAX_YEARS,
  P3A_LIFE_SPEC_VERSION,
  P3A_MAX_DELTA_MS,
  P3A_PACE_MINUTES,
  P3A_RULESET_VERSION,
  P3A_SCHEMA_VERSION,
  P3A_SPEEDS,
  P3A_STAT_MAX,
  P3A_YEAR_MS_MAX,
  P3A_YEAR_MS_MIN,
  type P3ABootstrap,
  type P3ACommand,
  type P3ACommandRecord,
  type P3ADecisionOption,
  type P3ALifeState,
  type P3APendingDecision,
  type P3APlaybackMode,
  type P3AReconstructInput,
  type P3AStats,
  type P3AVerifyInput,
  type P3AYearCard,
  type P3AYearDelta,
  type SerializedP3ALifeState
} from "@life-sim/contracts";
import { ascii, concatBytes, utf8Encode } from "../bytes";
import { canonicalBytes } from "../canonical/canonical";
import {
  asPppMicro,
  MoneyError,
  moneyAdd,
  moneyCompare,
  moneySub,
  encodeMoney,
  decodeMoney,
  type PppMicro
} from "../money";
import { sha256Hex } from "../rng/sha256";
import { Xoshiro128StarStar } from "../rng/xoshiro128";

/* ------------------------------------------------------------------ */
/* 錯誤契約                                                            */
/* ------------------------------------------------------------------ */

export interface LifeErrorDetails {
  readonly divergenceYear?: number;
  readonly divergenceSeq?: number;
  readonly expectedHash?: string;
  readonly actualHash?: string;
  readonly field?: string;
}

/**
 * 唯一允許外洩的 P3-A 錯誤型別。所有公開入口只回 `E_P3A_*`；
 * 原生 TypeError／SyntaxError／RangeError／CanonicalError／MoneyError 一律被轉成固定碼。
 */
export class LifeError extends Error {
  readonly details: LifeErrorDetails | undefined;
  constructor(public readonly code: string, details?: LifeErrorDetails) {
    super(code);
    this.name = "LifeError";
    this.details = details;
  }
}

function fail(code: string, details?: LifeErrorDetails): never {
  throw new LifeError(code, details);
}

/** 把任何非 LifeError 轉成固定碼；MoneyError 一律 E_P3A_MONEY。 */
function normalizeError(error: unknown): never {
  if (error instanceof LifeError) throw error;
  if (error instanceof MoneyError) throw new LifeError("E_P3A_MONEY");
  throw new LifeError("E_P3A_STATE");
}

/** 公開入口的統一護欄：不得讓原生例外穿透。 */
function guard<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    return normalizeError(error);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const clampStat = (value: number): number => Math.max(0, Math.min(P3A_STAT_MAX, value));

/** 每年固定消耗的遊戲 RNG 抽取次數（四狀態各一次）。 */
const RNG_DRAWS_PER_YEAR = 4;
const RNG_DRAWS_AT_BIRTH = 1;

/* ------------------------------------------------------------------ */
/* 金錢：只走既有 money module                                          */
/* ------------------------------------------------------------------ */

/** runtime 金錢只接受 bigint；Number 1 不是合法金錢。 */
function moneyOrFail(value: unknown): PppMicro {
  try {
    return asPppMicro(value as bigint);
  } catch (error) {
    if (error instanceof MoneyError) return fail("E_P3A_MONEY");
    throw error;
  }
}

function decodeMoneyOrFail(value: unknown): PppMicro {
  try {
    return decodeMoney(value);
  } catch (error) {
    if (error instanceof MoneyError) return fail("E_P3A_MONEY");
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 時間                                                                */
/* ------------------------------------------------------------------ */

export function computeYearDurationMs(paceMinutes: number, paceLifeYearsX10: number): number {
  return guard(() => {
    if (!(P3A_PACE_MINUTES as readonly number[]).includes(paceMinutes)) fail("E_P3A_PACE");
    if (!isSafeInt(paceLifeYearsX10) || paceLifeYearsX10 <= 0) fail("E_P3A_STATE");
    const raw = Math.round((paceMinutes * 60_000 * 10) / paceLifeYearsX10);
    return Math.max(P3A_YEAR_MS_MIN, Math.min(P3A_YEAR_MS_MAX, raw));
  });
}

/* ------------------------------------------------------------------ */
/* Hash                                                                */
/* ------------------------------------------------------------------ */

const STATE_DOMAIN = "LIFE1/P3A/STATE/v3";
const CHAIN_DOMAIN = "LIFE1/P3A/CHAIN/v3";
const CHAIN_INIT_DOMAIN = "LIFE1/P3A/CHAIN/INIT/v3";
const LOG_DOMAIN = "LIFE1/P3A/LOG/v3";
const SNAPSHOT_DOMAIN = "LIFE1/P3A/SNAPSHOT/v3";
const DELTA_DOMAIN = "LIFE1/P3A/DELTA/v1";

export interface P3AYearEntryPayload {
  readonly seq: number;
  readonly year: number;
  readonly age: number;
  readonly entryId: string;
  readonly summary: string;
}

export interface P3AYearSnapshotPayload {
  readonly year: number;
  readonly age: number;
  readonly stats: P3AStats;
  readonly balanceMicroUsd: string;
  readonly phase: string;
}

export interface P3AYearDeltaPayload {
  readonly entry: { readonly seq: number; readonly year: number; readonly age: number; readonly entryId: string; readonly summary: string; readonly entryHash: string };
  readonly snapshot: {
    readonly year: number;
    readonly age: number;
    readonly stats: P3AStats;
    readonly balanceMicroUsd: string;
    readonly phase: string;
    readonly snapshotHash: string;
  };
  readonly card: { readonly cardId: string; readonly year: number; readonly kind: string; readonly title: string };
}

/**
 * 年度 entry hash：串接上一個 entry head。
 * 公開給 application 的 ledger 驗證使用；輸入不合法只回 `E_P3A_HISTORY`。
 */
export function computeYearEntryHash(prevEntryHash: string, payload: P3AYearEntryPayload): string {
  return guard(() => {
    if (!isHash(prevEntryHash)) fail("E_P3A_HISTORY");
    if (!isSafeInt(payload.seq) || payload.seq < 1) fail("E_P3A_HISTORY");
    if (!isSafeInt(payload.year) || !isSafeInt(payload.age) || payload.age < 0) fail("E_P3A_HISTORY");
    if (typeof payload.entryId !== "string" || payload.entryId.length === 0) fail("E_P3A_HISTORY");
    if (typeof payload.summary !== "string") fail("E_P3A_HISTORY");
    return sha256Hex(
      concatBytes(
        ascii(LOG_DOMAIN),
        Uint8Array.of(0),
        utf8Encode(prevEntryHash),
        Uint8Array.of(0),
        canonicalBytes({
          seq: payload.seq,
          year: payload.year,
          age: payload.age,
          entryId: payload.entryId,
          summary: payload.summary
        } as never)
      )
    );
  });
}

/** 年度 snapshot hash：串接上一個 snapshot head。 */
export function computeYearSnapshotHash(prevSnapshotHash: string, payload: P3AYearSnapshotPayload): string {
  return guard(() => {
    if (!isHash(prevSnapshotHash)) fail("E_P3A_HISTORY");
    if (!isSafeInt(payload.year) || !isSafeInt(payload.age) || payload.age < 0) fail("E_P3A_HISTORY");
    if (!["life", "pending_decision", "death", "error"].includes(payload.phase)) fail("E_P3A_HISTORY");
    const stats = payload.stats as unknown as Record<string, unknown>;
    if (!isRecord(stats)) fail("E_P3A_HISTORY");
    for (const key of ["health", "happiness", "knowledge", "relationships"]) {
      if (!isSafeInt(stats[key]) || (stats[key] as number) < 0 || (stats[key] as number) > P3A_STAT_MAX) fail("E_P3A_HISTORY");
    }
    const balance = decodeMoneyOrFail(payload.balanceMicroUsd);
    return sha256Hex(
      concatBytes(
        ascii(SNAPSHOT_DOMAIN),
        Uint8Array.of(0),
        utf8Encode(prevSnapshotHash),
        Uint8Array.of(0),
        canonicalBytes({
          year: payload.year,
          age: payload.age,
          stats: {
            health: payload.stats.health,
            happiness: payload.stats.happiness,
            knowledge: payload.stats.knowledge,
            relationships: payload.stats.relationships
          },
          balanceMicroUsd: balance.toString(),
          phase: payload.phase
        } as never)
      )
    );
  });
}

/**
 * 年度 delta hash：同時覆蓋 entry、snapshot 與 card 的每一個權威欄位。
 * 卡片沒有自己的鏈，而是被這條 rolling hash 包住，尾端綁 `history.lastDeltaHash`。
 */
export function computeYearDeltaHash(prevDeltaHash: string, payload: P3AYearDeltaPayload): string {
  return guard(() => {
    if (!isHash(prevDeltaHash)) fail("E_P3A_HISTORY");
    if (!isHash(payload.entry.entryHash) || !isHash(payload.snapshot.snapshotHash)) fail("E_P3A_HISTORY");
    if (!["summary", "decision", "milestone"].includes(payload.card.kind)) fail("E_P3A_HISTORY");
    if (typeof payload.card.cardId !== "string" || payload.card.cardId.length === 0) fail("E_P3A_HISTORY");
    if (typeof payload.card.title !== "string") fail("E_P3A_HISTORY");
    if (!isSafeInt(payload.card.year)) fail("E_P3A_HISTORY");
    if (!isSafeInt(payload.entry.seq) || payload.entry.seq < 1) fail("E_P3A_HISTORY");
    if (typeof payload.entry.entryId !== "string" || typeof payload.entry.summary !== "string") fail("E_P3A_HISTORY");
    if (!isSafeInt(payload.entry.year) || !isSafeInt(payload.entry.age)) fail("E_P3A_HISTORY");
    if (!isSafeInt(payload.snapshot.year) || !isSafeInt(payload.snapshot.age)) fail("E_P3A_HISTORY");
    const balance = decodeMoneyOrFail(payload.snapshot.balanceMicroUsd);
    return sha256Hex(
      concatBytes(
        ascii(DELTA_DOMAIN),
        Uint8Array.of(0),
        utf8Encode(prevDeltaHash),
        Uint8Array.of(0),
        canonicalBytes({
          entry: {
            seq: payload.entry.seq,
            year: payload.entry.year,
            age: payload.entry.age,
            entryId: payload.entry.entryId,
            summary: payload.entry.summary,
            entryHash: payload.entry.entryHash
          },
          snapshot: {
            year: payload.snapshot.year,
            age: payload.snapshot.age,
            stats: {
              health: payload.snapshot.stats.health,
              happiness: payload.snapshot.stats.happiness,
              knowledge: payload.snapshot.stats.knowledge,
              relationships: payload.snapshot.stats.relationships
            },
            balanceMicroUsd: balance.toString(),
            phase: payload.snapshot.phase,
            snapshotHash: payload.snapshot.snapshotHash
          },
          card: {
            cardId: payload.card.cardId,
            year: payload.card.year,
            kind: payload.card.kind,
            title: payload.card.title
          }
        } as never)
      )
    );
  });
}

function projectionOrigin(origin: P3ALifeState["origin"]) {
  return {
    certificateHash: origin.certificateHash,
    certificateId: origin.certificateId,
    playerIdentityHash: origin.playerIdentityHash,
    masterSeedHash: origin.masterSeedHash,
    basePackId: origin.basePackId,
    basePackChecksum: origin.basePackChecksum,
    identityPackId: origin.identityPackId,
    identityPackChecksum: origin.identityPackChecksum
  };
}

function projectionVersions(versions: P3ALifeState["versions"]) {
  return {
    engineVersion: versions.engineVersion,
    rulesetVersion: versions.rulesetVersion,
    rngSpecVersion: versions.rngSpecVersion,
    dataVersion: versions.dataVersion,
    contentVersion: versions.contentVersion,
    saveFormatVersion: versions.saveFormatVersion
  };
}

function projectionDecision(pending: P3APendingDecision | null) {
  if (pending === null) return null;
  return {
    decisionId: pending.decisionId,
    year: pending.year,
    prompt: pending.prompt,
    options: pending.options.map((option) => ({ optionId: option.optionId, label: option.label })),
    selectedOptionId: pending.selectedOptionId
  };
}

/**
 * stateHash 的完整 projection。
 * 不含 playback（含 cardsSeen／visibility）、commandLog、hashChain、history.initialStateHash
 * 與任何逐年歷史陣列；`history` 的固定摘要欄位必須在內。
 */
function projection(state: P3ALifeState) {
  return {
    schemaVersion: state.schemaVersion,
    lifeSpecVersion: state.lifeSpecVersion,
    versions: projectionVersions(state.versions),
    origin: projectionOrigin(state.origin),
    birthYear: state.birthYear,
    currentYear: state.currentYear,
    age: state.age,
    phase: state.phase,
    errorCode: state.errorCode,
    lifespanYears: state.lifespanYears,
    paceLifeYearsX10: state.paceLifeYearsX10,
    stats: {
      health: state.stats.health,
      happiness: state.stats.happiness,
      knowledge: state.stats.knowledge,
      relationships: state.stats.relationships
    },
    assets: {
      balanceMicroUsd: moneyOrFail(state.assets.balanceMicroUsd).toString(),
      annualIncomeMicroUsd: moneyOrFail(state.assets.annualIncomeMicroUsd).toString(),
      annualExpenseMicroUsd: moneyOrFail(state.assets.annualExpenseMicroUsd).toString()
    },
    flags: [...state.flags],
    rng: { domain: state.rng.domain, state: [...state.rng.state], draws: state.rng.draws },
    pendingDecision: projectionDecision(state.pendingDecision),
    history: {
      yearsRecorded: state.history.yearsRecorded,
      cardsTotal: state.history.cardsTotal,
      lastEntryHash: state.history.lastEntryHash,
      lastSnapshotHash: state.history.lastSnapshotHash,
      lastDeltaHash: state.history.lastDeltaHash
    }
  };
}

/** 內部用：只算 projection hash，不做驗證。不得外流成「重簽」工具。 */
function projectionHash(state: P3ALifeState): string {
  return sha256Hex(concatBytes(ascii(STATE_DOMAIN), Uint8Array.of(0), canonicalBytes(projection(state) as never)));
}

/** 以既有內容重封一個 provisional state（stateHash 不在 projection 內）。 */
function seal(state: P3ALifeState): P3ALifeState {
  return { ...state, stateHash: projectionHash(state) };
}

/** hashChain 的根：由 initial stateHash 建立，不是只用 certificateHash。 */
function chainRoot(initialStateHash: string): string {
  return sha256Hex(concatBytes(ascii(CHAIN_INIT_DOMAIN), Uint8Array.of(0), utf8Encode(initialStateHash)));
}

function chainFor(prevChain: string, record: Omit<P3ACommandRecord, "chainHash">): string {
  return sha256Hex(
    concatBytes(ascii(CHAIN_DOMAIN), Uint8Array.of(0), utf8Encode(prevChain), Uint8Array.of(0), canonicalBytes(record as never))
  );
}

/* ------------------------------------------------------------------ */
/* 狀態形狀與不變量                                                     */
/* ------------------------------------------------------------------ */

/**
 * 版本形狀檢查（寬鬆）：只確認六個欄位存在且 rngSpec／saveFormat 是支援值。
 * `phase`／歷史等不變量用它，因此內部 benchmark ruleset 的 state 也能被驗證。
 */
function assertVersionShape(versions: unknown): asserts versions is P3ABootstrap["versions"] {
  if (!isRecord(versions)) fail("E_P3A_VERSION");
  const record = versions as Record<string, unknown>;
  for (const key of ["engineVersion", "rulesetVersion", "rngSpecVersion", "dataVersion", "contentVersion"]) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) fail("E_P3A_VERSION");
  }
  if (record.rngSpecVersion !== "1.0.0") fail("E_P3A_VERSION");
  if (record.saveFormatVersion !== 3) fail("E_P3A_VERSION");
}

/**
 * 正式版本允許清單（嚴格）：公開信任邊界只接受核准的 ruleset／content 組合。
 * 未知或 `p3a-bench-*` 的 ruleset 一律 `E_P3A_VERSION`，不得被當成目前規則執行。
 */
function assertApprovedVersions(versions: P3ABootstrap["versions"]): void {
  assertVersionShape(versions);
  if (versions.rulesetVersion !== P3A_RULESET_VERSION) fail("E_P3A_VERSION");
  if (versions.contentVersion !== P3A_CONTENT_VERSION) fail("E_P3A_VERSION");
}

function assertRngWords(value: unknown, code: string): asserts value is readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) fail(code);
  for (const word of value as readonly unknown[]) {
    if (!isSafeInt(word) || (word as number) < 0 || (word as number) > 0xffffffff) fail(code);
  }
}

function assertBootstrap(bootstrap: unknown, allowBenchmark: boolean): asserts bootstrap is P3ABootstrap {
  if (!isRecord(bootstrap)) fail("E_P3A_TYPE");
  const value = bootstrap as Record<string, unknown>;
  // 正式 genesis 不接受任意壽命；benchmark 專用入口不在公開 barrel。
  if ("lifespanYears" in value) fail("E_P3A_ARGUMENT");
  assertVersionShape(value.versions);
  if (!allowBenchmark) assertApprovedVersions(value.versions as P3ABootstrap["versions"]);
  const origin = value.origin as Record<string, unknown>;
  if (!isRecord(origin)) fail("E_P3A_STATE");
  for (const key of ["certificateHash", "playerIdentityHash", "masterSeedHash", "basePackChecksum", "identityPackChecksum"]) {
    if (!isHash(origin[key])) fail("E_P3A_STATE");
  }
  if (typeof origin.certificateId !== "string" || !/^cert:[0-9a-f]{24}$/.test(origin.certificateId)) fail("E_P3A_STATE");
  if (typeof origin.basePackId !== "string" || origin.basePackId.length === 0) fail("E_P3A_STATE");
  if (typeof origin.identityPackId !== "string" || origin.identityPackId.length === 0) fail("E_P3A_STATE");
  if (!isSafeInt(value.birthYear) || value.birthYear < 1800 || value.birthYear > 2200) fail("E_P3A_STATE");
  if (!isSafeInt(value.paceLifeYearsX10) || value.paceLifeYearsX10 < 100 || value.paceLifeYearsX10 > 1500) fail("E_P3A_STATE");
  assertRngWords(value.rngState, "E_P3A_STATE");
}

function assertOriginShape(origin: unknown): void {
  if (!isRecord(origin)) fail("E_P3A_STATE");
  const record = origin as Record<string, unknown>;
  for (const key of ["certificateHash", "playerIdentityHash", "masterSeedHash", "basePackChecksum", "identityPackChecksum"]) {
    if (!isHash(record[key])) fail("E_P3A_STATE");
  }
  if (typeof record.certificateId !== "string" || !/^cert:[0-9a-f]{24}$/.test(record.certificateId)) fail("E_P3A_STATE");
  if (typeof record.basePackId !== "string" || record.basePackId.length === 0) fail("E_P3A_STATE");
  if (typeof record.identityPackId !== "string" || record.identityPackId.length === 0) fail("E_P3A_STATE");
}

function assertStatsShape(stats: unknown, code: string): void {
  if (!isRecord(stats)) fail(code);
  const record = stats as Record<string, unknown>;
  for (const key of ["health", "happiness", "knowledge", "relationships"]) {
    if (!isSafeInt(record[key]) || (record[key] as number) < 0 || (record[key] as number) > P3A_STAT_MAX) fail(code);
  }
}

function assertHistoryShape(history: unknown): void {
  if (!isRecord(history)) fail("E_P3A_HISTORY");
  const record = history as Record<string, unknown>;
  if (!isSafeInt(record.yearsRecorded) || (record.yearsRecorded as number) < 0) fail("E_P3A_HISTORY");
  if (!isSafeInt(record.cardsTotal) || (record.cardsTotal as number) < 0) fail("E_P3A_HISTORY");
  if (!isHash(record.lastEntryHash) || !isHash(record.lastSnapshotHash) || !isHash(record.lastDeltaHash)) fail("E_P3A_HISTORY");
  if (!isHash(record.initialStateHash)) fail("E_P3A_HISTORY");
}

function assertPlaybackShape(playback: unknown, paceLifeYearsX10: number): void {
  if (!isRecord(playback)) fail("E_P3A_TYPE");
  const record = playback as Record<string, unknown>;
  if (!["playing", "paused", "fast_forward"].includes(record.mode as string)) fail("E_P3A_STATE");
  if (!["visible", "hidden"].includes(record.visibility as string)) fail("E_P3A_STATE");
  if (record.previousMode !== "playing" && record.previousMode !== "paused") fail("E_P3A_STATE");
  if (!(P3A_SPEEDS as readonly number[]).includes(record.speed as number)) fail("E_P3A_SPEED");
  if (!(P3A_PACE_MINUTES as readonly number[]).includes(record.paceMinutes as number)) fail("E_P3A_PACE");
  if (!isSafeInt(record.yearDurationMs) || (record.yearDurationMs as number) < P3A_YEAR_MS_MIN || (record.yearDurationMs as number) > P3A_YEAR_MS_MAX) {
    fail("E_P3A_PACE");
  }
  if (record.yearDurationMs !== computeYearDurationMs(record.paceMinutes as number, paceLifeYearsX10)) fail("E_P3A_PACE");
  if (!isSafeInt(record.elapsedInYearMs) || (record.elapsedInYearMs as number) < 0) fail("E_P3A_STATE");
  // P3-A.5 年度已耗時間不變量：0 <= elapsedInYearMs < yearDurationMs。
  // 否則 TICK 0ms 就會直接跨年（存檔邊界與 pace 變更都必須維持這個約束）。
  if ((record.elapsedInYearMs as number) >= (record.yearDurationMs as number)) fail("E_P3A_STATE");
  if (!isSafeInt(record.cardsSeen) || (record.cardsSeen as number) < 0) fail("E_P3A_STATE");
}

export function assertLifeStateShape(state: P3ALifeState): void {
  return guard(() => {
    if (!isRecord(state as unknown)) fail("E_P3A_TYPE");
    if (state.schemaVersion !== P3A_SCHEMA_VERSION) fail("E_P3A_VERSION");
    if (state.lifeSpecVersion !== P3A_LIFE_SPEC_VERSION) fail("E_P3A_VERSION");
    assertVersionShape(state.versions);
    assertOriginShape(state.origin);
    if (!isSafeInt(state.birthYear) || state.birthYear < 1800 || state.birthYear > 2200) fail("E_P3A_STATE");
    if (!isSafeInt(state.currentYear) || !isSafeInt(state.age)) fail("E_P3A_STATE");
    if (state.age < 0) fail("E_P3A_STATE");
    if (!["life", "pending_decision", "death", "error"].includes(state.phase as string)) fail("E_P3A_PHASE");
    if (!isSafeInt(state.lifespanYears) || state.lifespanYears <= 0 || state.lifespanYears > 100_000) fail("E_P3A_STATE");
    if (!isSafeInt(state.paceLifeYearsX10) || state.paceLifeYearsX10 <= 0) fail("E_P3A_STATE");
    assertStatsShape(state.stats, "E_P3A_STATE");
    if (!isRecord(state.assets as unknown)) fail("E_P3A_MONEY");
    moneyOrFail(state.assets.balanceMicroUsd);
    moneyOrFail(state.assets.annualIncomeMicroUsd);
    moneyOrFail(state.assets.annualExpenseMicroUsd);
    if (!Array.isArray(state.flags)) fail("E_P3A_STATE");
    for (const flag of state.flags) if (typeof flag !== "string" || flag.length === 0) fail("E_P3A_STATE");
    if (!isRecord(state.rng as unknown)) fail("E_P3A_RNG");
    if (state.rng.domain !== "life") fail("E_P3A_RNG");
    assertRngWords(state.rng.state, "E_P3A_RNG");
    if (!isSafeInt(state.rng.draws) || state.rng.draws < 0) fail("E_P3A_RNG");
    if (state.pendingDecision !== null) assertDecision(state.pendingDecision);
    assertHistoryShape(state.history);
    if (!Array.isArray(state.commandLog)) fail("E_P3A_STATE");
    if (!isHash(state.stateHash) || !isHash(state.hashChain)) fail("E_P3A_HASH");
    assertPlaybackShape(state.playback, state.paceLifeYearsX10);
  });
}

function assertDecision(value: unknown): asserts value is P3APendingDecision {
  if (!isRecord(value)) fail("E_P3A_STATE");
  const record = value as Record<string, unknown>;
  if (typeof record.decisionId !== "string" || record.decisionId.length === 0) fail("E_P3A_STATE");
  if (typeof record.prompt !== "string") fail("E_P3A_STATE");
  if (!isSafeInt(record.year)) fail("E_P3A_STATE");
  if (!Array.isArray(record.options) || record.options.length < 2) fail("E_P3A_STATE");
  const ids: string[] = [];
  for (const option of record.options as unknown[]) {
    if (!isRecord(option)) fail("E_P3A_STATE");
    const entry = option as Record<string, unknown>;
    const optionId = entry.optionId;
    if (typeof optionId !== "string" || optionId.length === 0) fail("E_P3A_STATE");
    if (typeof entry.label !== "string") fail("E_P3A_STATE");
    ids.push(optionId);
  }
  if (new Set(ids).size !== ids.length) fail("E_P3A_STATE");
  if (record.selectedOptionId !== null && typeof record.selectedOptionId !== "string") fail("E_P3A_STATE");
  if (typeof record.selectedOptionId === "string" && !ids.includes(record.selectedOptionId)) fail("E_P3A_STATE");
}

function canPlay(state: P3ALifeState): boolean {
  return state.phase === "life" && state.pendingDecision === null;
}

/**
 * 完整狀態驗證：形狀 ＋ 跨欄位一致性 ＋ 規則 commandLog/hashChain ＋ stateHash。
 * 這只證明「狀態自洽」，不證明「歷史是真的」——後者只有 `verifyLifeReplay`／`verifyLifeState`
 * 從 genesis 重播才能證明。
 */
export function assertLifeStateInvariants(state: P3ALifeState): void {
  return guard(() => {
    assertLifeStateShape(state);

    if (state.currentYear !== state.birthYear + state.age) fail("E_P3A_STATE");
    if (state.history.yearsRecorded !== state.age) fail("E_P3A_HISTORY");
    if (state.history.cardsTotal < state.history.yearsRecorded) fail("E_P3A_HISTORY");
    if (state.playback.cardsSeen > state.history.cardsTotal) fail("E_P3A_HISTORY");

    const initialDraws = state.rng.draws - RNG_DRAWS_PER_YEAR * state.history.yearsRecorded;
    if (initialDraws !== 0 && initialDraws !== RNG_DRAWS_AT_BIRTH) fail("E_P3A_RNG");

    if (state.history.yearsRecorded === 0) {
      if (state.history.lastEntryHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3A_HISTORY");
      if (state.history.lastSnapshotHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3A_HISTORY");
      if (state.history.lastDeltaHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3A_HISTORY");
    }

    for (let index = 1; index < state.flags.length; index += 1) {
      if (!((state.flags[index - 1] as string) < (state.flags[index] as string))) fail("E_P3A_STATE");
    }

    if (state.phase === "pending_decision") {
      const pending = state.pendingDecision;
      if (pending === null) fail("E_P3A_STATE");
      if (pending.year !== state.currentYear) fail("E_P3A_STATE");
      if (state.age >= state.lifespanYears) fail("E_P3A_STATE");
    } else if (state.pendingDecision !== null) {
      fail("E_P3A_STATE");
    }

    if (state.phase === "life" && state.age >= state.lifespanYears) fail("E_P3A_STATE");
    if (state.phase === "death" && state.age < state.lifespanYears) fail("E_P3A_STATE");
    if (state.phase === "error") {
      const errorCode = state.errorCode;
      if (errorCode === null) fail("E_P3A_STATE");
      if (!(P3A_ERROR_CODES as readonly string[]).includes(errorCode)) fail("E_P3A_STATE");
    } else if (state.errorCode !== null) {
      fail("E_P3A_STATE");
    }

    const playback = state.playback;
    if (playback.visibility === "hidden" && playback.mode !== "paused") fail("E_P3A_STATE");
    if (playback.mode === "playing" && !canPlay(state)) fail("E_P3A_STATE");
    if (playback.mode === "fast_forward" && !canPlay(state)) fail("E_P3A_STATE");
    if (state.phase !== "life" && playback.mode !== "paused") fail("E_P3A_STATE");
    if (state.pendingDecision !== null && playback.mode !== "paused") fail("E_P3A_STATE");

    assertRuleCommandLog(state);
    if (projectionHash(state) !== state.stateHash) fail("E_P3A_HASH");
  });
}

/**
 * 逐筆驗證規則 commandLog 與 hashChain（結構層）。
 * 只保證「紀錄彼此串得起來，且與 state 的 head 一致」；重新串鏈的語義偽造要靠 genesis 重播。
 */
export function assertRuleCommandLog(state: P3ALifeState): void {
  return guard(() => {
    if (!isRecord(state as unknown)) fail("E_P3A_TYPE");
    if (!Array.isArray(state.commandLog)) fail("E_P3A_TYPE");
    if (!isRecord(state.history as unknown)) fail("E_P3A_HISTORY");
    if (!isHash(state.history.initialStateHash)) fail("E_P3A_HISTORY");
    if (!isHash(state.hashChain)) fail("E_P3A_HASH");
    if (!isSafeInt(state.birthYear) || !isSafeInt(state.currentYear)) fail("E_P3A_STATE");

    let chain = chainRoot(state.history.initialStateHash);
    let previousAfter: string | null = null;
    let previousYear: number | null = null;
    let openSelectionYear: number | null = null;
    let openSelectionOption: string | null = null;

    for (let index = 0; index < state.commandLog.length; index += 1) {
      const record = state.commandLog[index] as P3ACommandRecord;
      if (!isRecord(record as unknown)) fail("E_P3A_TYPE");
      if (record.seq !== index + 1) fail("E_P3A_STATE");
      if (record.commandType !== "SELECT_DECISION" && record.commandType !== "CONFIRM_DECISION") fail("E_P3A_STATE");
      if (typeof record.payload !== "string" || record.payload.length === 0) fail("E_P3A_STATE");
      if (!isHash(record.argsHash)) fail("E_P3A_STATE");
      if (!isSafeInt(record.atYear) || !isSafeInt(record.effectiveYear)) fail("E_P3A_STATE");
      if (record.effectiveYear !== record.atYear) fail("E_P3A_STATE");
      if (record.atYear > state.currentYear) fail("E_P3A_STATE");
      if (typeof record.auto !== "boolean") fail("E_P3A_STATE");
      if (record.policyId !== null && typeof record.policyId !== "string") fail("E_P3A_STATE");
      assertRngWords(record.rngState, "E_P3A_RNG");
      if (!isSafeInt(record.rngDraws) || record.rngDraws < 0) fail("E_P3A_RNG");
      if (!isHash(record.stateHashBefore) || !isHash(record.stateHashAfter)) fail("E_P3A_HASH");
      if (record.stateHashBefore === record.stateHashAfter) fail("E_P3A_HASH");
      // 同一年內的連續指令中間不會有年度交易，因此 before 必須接上上一筆 after。
      if (previousAfter !== null && record.atYear === previousYear && record.stateHashBefore !== previousAfter) fail("E_P3A_HASH");
      if (!isHash(record.chainHash)) fail("E_P3A_HASH");

      const ageAtDecision = record.atYear - state.birthYear;
      if (ageAtDecision < 0) fail("E_P3A_STATE");
      const initialDraws = state.rng.draws - RNG_DRAWS_PER_YEAR * state.history.yearsRecorded;
      if (record.rngDraws !== initialDraws + RNG_DRAWS_PER_YEAR * ageAtDecision) fail("E_P3A_RNG");

      if (record.commandType === "SELECT_DECISION") {
        if (openSelectionYear !== null) fail("E_P3A_STATE");
        openSelectionYear = record.atYear;
        openSelectionOption = record.payload;
      } else {
        if (openSelectionYear === null || openSelectionYear !== record.atYear) fail("E_P3A_STATE");
        if (record.payload !== openSelectionOption) fail("E_P3A_STATE");
        openSelectionYear = null;
        openSelectionOption = null;
      }

      const expectedArgs = sha256Hex(canonicalBytes({ type: record.commandType, optionId: record.payload } as never));
      if (expectedArgs !== record.argsHash) fail("E_P3A_HASH");

      const expectedChain = chainFor(chain, {
        seq: record.seq,
        commandType: record.commandType,
        payload: record.payload,
        argsHash: record.argsHash,
        atYear: record.atYear,
        effectiveYear: record.effectiveYear,
        auto: record.auto,
        policyId: record.policyId,
        rngState: record.rngState,
        rngDraws: record.rngDraws,
        stateHashBefore: record.stateHashBefore,
        stateHashAfter: record.stateHashAfter
      });
      if (expectedChain !== record.chainHash) fail("E_P3A_HASH");
      chain = record.chainHash;
      previousAfter = record.stateHashAfter;
      previousYear = record.atYear;
    }
    if (chain !== state.hashChain) fail("E_P3A_HASH");

    // 紀錄尾端必須與目前的 pendingDecision 狀態一致。
    const pending = state.pendingDecision;
    if (openSelectionYear !== null) {
      if (pending === null) fail("E_P3A_STATE");
      if (pending.selectedOptionId === null) fail("E_P3A_STATE");
      if (pending.year !== openSelectionYear) fail("E_P3A_STATE");
      if (pending.selectedOptionId !== openSelectionOption) fail("E_P3A_STATE");
    } else if (pending !== null && pending.selectedOptionId !== null) {
      fail("E_P3A_STATE");
    }
  });
}

/** 完整驗證後回傳可信的 stateHash；不提供只重算、不驗證的公開 API。 */
export function computeLifeStateHash(state: P3ALifeState): string {
  return guard(() => {
    assertLifeStateInvariants(state);
    return state.stateHash;
  });
}

export function assertLifeStateHash(state: P3ALifeState): void {
  return guard(() => {
    assertLifeStateInvariants(state);
  });
}

/* ------------------------------------------------------------------ */
/* 建立                                                                */
/* ------------------------------------------------------------------ */

/**
 * 正式建立入口：只接受核准的 ruleset／content；壽命一律由 RNG 規則抽 60–100。
 * `lifespanYears` 不得出現在 bootstrap；`p3a-bench-*` 與未知 ruleset 一律 `E_P3A_VERSION`。
 */
export function createLifeState(bootstrap: P3ABootstrap): P3ALifeState {
  return createLifeStateInternal(bootstrap, false);
}

/**
 * 內部建立入口（給 benchmark 模組用）：允許 `p3a-bench-<years>` ruleset。
 * **不從 `@life-sim/engine` barrel 匯出。**
 */
export function createLifeStateForBenchmark(bootstrap: P3ABootstrap): P3ALifeState {
  return createLifeStateInternal(bootstrap, true);
}

function createLifeStateInternal(bootstrap: P3ABootstrap, allowBenchmark: boolean): P3ALifeState {
  return guard(() => {
    assertBootstrap(bootstrap, allowBenchmark);
    const rng = new Xoshiro128StarStar(bootstrap.rngState);
    const benchmarkYears = allowBenchmark ? benchmarkLifespan(bootstrap.versions.rulesetVersion) : null;
    if (benchmarkYears !== null) return buildLifeState(bootstrap, benchmarkYears, rng.state, 0);
    const lifespanYears = 60 + Number(rng.uniformBigInt(41n));
    return buildLifeState(bootstrap, lifespanYears, rng.state, RNG_DRAWS_AT_BIRTH);
  });
}

/** 內部 benchmark ruleset 前綴；不屬於公開契約（不從 barrel 匯出）。 */
export const BENCHMARK_RULESET_PREFIX = "p3a-bench-";
const BENCHMARK_MAX_LIFESPAN_YEARS = 100_000;

/** 解析內部 benchmark ruleset 版本；不是 benchmark 版本就回 null。 */
function benchmarkLifespan(rulesetVersion: string): number | null {
  if (!rulesetVersion.startsWith(BENCHMARK_RULESET_PREFIX)) return null;
  const suffix = rulesetVersion.slice(BENCHMARK_RULESET_PREFIX.length);
  if (!/^[1-9][0-9]{0,5}$/.test(suffix)) fail("E_P3A_VERSION");
  const years = Number(suffix);
  if (!Number.isSafeInteger(years) || years < 1 || years > BENCHMARK_MAX_LIFESPAN_YEARS) fail("E_P3A_VERSION");
  return years;
}

function buildLifeState(
  bootstrap: P3ABootstrap,
  lifespanYears: number,
  rngState: readonly [number, number, number, number],
  draws: number
): P3ALifeState {
  const draft: P3ALifeState = {
    schemaVersion: P3A_SCHEMA_VERSION,
    lifeSpecVersion: P3A_LIFE_SPEC_VERSION,
    versions: bootstrap.versions,
    origin: bootstrap.origin,
    birthYear: bootstrap.birthYear,
    currentYear: bootstrap.birthYear,
    age: 0,
    phase: "life",
    errorCode: null,
    lifespanYears,
    paceLifeYearsX10: bootstrap.paceLifeYearsX10,
    stats: { health: 50, happiness: 50, knowledge: 50, relationships: 50 },
    assets: { balanceMicroUsd: asPppMicro(0n), annualIncomeMicroUsd: asPppMicro(0n), annualExpenseMicroUsd: asPppMicro(0n) },
    flags: [],
    rng: { domain: "life", state: rngState, draws },
    pendingDecision: null,
    history: {
      yearsRecorded: 0,
      cardsTotal: 0,
      lastEntryHash: P3A_EMPTY_HISTORY_HASH,
      lastSnapshotHash: P3A_EMPTY_HISTORY_HASH,
      lastDeltaHash: P3A_EMPTY_HISTORY_HASH,
      initialStateHash: P3A_EMPTY_HISTORY_HASH
    },
    commandLog: [],
    stateHash: P3A_EMPTY_HISTORY_HASH,
    hashChain: P3A_EMPTY_HISTORY_HASH,
    playback: {
      mode: "paused",
      visibility: "visible",
      previousMode: "paused",
      speed: 1,
      paceMinutes: 60,
      yearDurationMs: computeYearDurationMs(60, bootstrap.paceLifeYearsX10),
      elapsedInYearMs: 0,
      cardsSeen: 0
    }
  };
  // initialStateHash 不在 projection 內，因此不會循環依賴。
  const initialStateHash = projectionHash(draft);
  return {
    ...draft,
    history: { ...draft.history, initialStateHash },
    stateHash: initialStateHash,
    hashChain: chainRoot(initialStateHash)
  };
}

function decisionFor(year: number): P3APendingDecision {
  const options: P3ADecisionOption[] = [
    { optionId: "steady", label: "維持現狀（skeleton）" },
    { optionId: "bold", label: "嘗試改變（skeleton）" }
  ];
  return { decisionId: `decision-${year}`, year, prompt: `第 ${year} 年：skeleton 抉擇`, options, selectedOptionId: null };
}

/* ------------------------------------------------------------------ */
/* 年度交易                                                            */
/* ------------------------------------------------------------------ */

let injectedYearFailureAge: number | null = null;

/**
 * 測試專用：讓「結算到指定年齡」的年度交易失敗（不從公開 barrel 匯出）。
 * 用來動態證明年度結算失敗時的停止／elapsed／errorCode／phase／playback 行為。
 */
export function setYearFailureInjectionForTests(age: number | null): void {
  if (age !== null && (!isSafeInt(age) || age < 0)) fail("E_P3A_ARGUMENT");
  injectedYearFailureAge = age;
}

/**
 * 唯一年度交易入口：回傳新狀態與 year delta；歷史由呼叫端的 append-only ledger 保存。
 * 年度 entry／snapshot／delta hash 都串接上一個 head，不是只 hash 當年資料。
 */
export function resolveLifeYear(state: P3ALifeState): { state: P3ALifeState; delta: P3AYearDelta } {
  return guard(() => {
    assertLifeStateInvariants(state);
    return resolveYearCore(state);
  });
}

/**
 * 內部年度交易核心：呼叫端必須先驗證邊界狀態（公開入口或已驗證的指令鏈）。
 */
function resolveYearCore(state: P3ALifeState): { state: P3ALifeState; delta: P3AYearDelta } {
  if (state.phase !== "life") fail("E_P3A_PHASE");
  if (state.pendingDecision !== null) fail("E_P3A_PHASE");

  const newAge = state.age + 1;
  const newYear = state.currentYear + 1;
  if (!Number.isSafeInteger(newAge) || !Number.isSafeInteger(newYear)) fail("E_P3A_STATE");
  if (injectedYearFailureAge !== null && newAge === injectedYearFailureAge) fail("E_P3A_YEAR");

  const rng = new Xoshiro128StarStar(state.rng.state);
  const healthDelta = rng.uniformInt(-3, 3);
  const happinessDelta = rng.uniformInt(-3, 3);
  const knowledgeDelta = rng.uniformInt(0, 3);
  const relationshipsDelta = rng.uniformInt(-2, 2);
  const stats: P3AStats = {
    health: clampStat(state.stats.health + healthDelta),
    happiness: clampStat(state.stats.happiness + happinessDelta),
    knowledge: clampStat(state.stats.knowledge + knowledgeDelta),
    relationships: clampStat(state.stats.relationships + relationshipsDelta)
  };

  const income = asPppMicro(1_000_000n + BigInt(newAge) * 100_000n);
  const expense = asPppMicro(600_000n + BigInt(newAge) * 50_000n);
  const zero = asPppMicro(0n);
  const rawBalance = moneySub(moneyAdd(asPppMicro(state.assets.balanceMicroUsd), income), expense);
  const balance: PppMicro = moneyCompare(rawBalance, zero) < 0 ? zero : rawBalance;
  const assets = { balanceMicroUsd: balance, annualIncomeMicroUsd: income, annualExpenseMicroUsd: expense };

  const phase = newAge >= state.lifespanYears ? "death" : P3A_DECISION_AGES.includes(newAge) ? "pending_decision" : "life";
  const pendingDecision = phase === "pending_decision" ? decisionFor(newYear) : null;
  const seq = state.history.yearsRecorded + 1;
  const entryId = `year-${newYear}`;
  const summary = `skeleton 年度交易：${newYear}（age ${newAge}）`;
  const card: P3AYearCard = {
    cardId: `year-${newYear}`,
    year: newYear,
    kind: phase === "pending_decision" ? "decision" : "summary",
    title: `第 ${newYear} 年（skeleton）`
  };
  const balanceText = balance.toString();

  const entryHash = computeYearEntryHash(state.history.lastEntryHash, { seq, year: newYear, age: newAge, entryId, summary });
  const snapshotHash = computeYearSnapshotHash(state.history.lastSnapshotHash, {
    year: newYear,
    age: newAge,
    stats,
    balanceMicroUsd: balanceText,
    phase
  });
  const deltaHash = computeYearDeltaHash(state.history.lastDeltaHash, {
    entry: { seq, year: newYear, age: newAge, entryId, summary, entryHash },
    snapshot: { year: newYear, age: newAge, stats, balanceMicroUsd: balanceText, phase, snapshotHash },
    card
  });

  const next = seal({
    ...state,
    currentYear: newYear,
    age: newAge,
    phase,
    pendingDecision,
    stats,
    assets,
    rng: { domain: "life", state: rng.state, draws: state.rng.draws + RNG_DRAWS_PER_YEAR },
    history: {
      yearsRecorded: seq,
      cardsTotal: state.history.cardsTotal + 1,
      lastEntryHash: entryHash,
      lastSnapshotHash: snapshotHash,
      lastDeltaHash: deltaHash,
      initialStateHash: state.history.initialStateHash
    },
    // 年度結算遇到抉擇／死亡時時間必須暫停，不得沿用 playing／fast_forward。
    playback: { ...state.playback, mode: phase === "life" ? state.playback.mode : "paused" }
  });

  const delta: P3AYearDelta = {
    year: newYear,
    age: newAge,
    card,
    logEntry: { seq, year: newYear, age: newAge, entryId, summary, entryHash },
    snapshot: { year: newYear, age: newAge, stats, balanceMicroUsd: balanceText, phase, snapshotHash },
    deltaHash
  };
  return { state: next, delta };
}

export function resolveYear(state: P3ALifeState): P3ALifeState {
  return resolveLifeYear(state).state;
}

/* ------------------------------------------------------------------ */
/* 指令                                                                */
/* ------------------------------------------------------------------ */

function markError(state: P3ALifeState, error: unknown): P3ALifeState {
  const code = error instanceof LifeError && (P3A_ERROR_CODES as readonly string[]).includes(error.code) ? error.code : "E_P3A_STATE";
  return seal({
    ...state,
    phase: "error",
    errorCode: code,
    pendingDecision: null,
    playback: { ...state.playback, mode: "paused" }
  });
}

/** SELECT_DECISION：只記錄選擇，不套用效果。 */
function commitSelection(state: P3ALifeState, optionId: string): P3ALifeState {
  const decision = state.pendingDecision as P3APendingDecision;
  const before = state.stateHash;
  const selected = seal({ ...state, pendingDecision: { ...decision, selectedOptionId: optionId } });
  return appendWithRecord(selected, {
    seq: state.commandLog.length + 1,
    commandType: "SELECT_DECISION",
    payload: optionId,
    argsHash: sha256Hex(canonicalBytes({ type: "SELECT_DECISION", optionId } as never)),
    atYear: state.currentYear,
    effectiveYear: state.currentYear,
    auto: false,
    policyId: null,
    rngState: state.rng.state,
    rngDraws: state.rng.draws,
    stateHashBefore: before,
    stateHashAfter: selected.stateHash
  });
}

/** CONFIRM_DECISION：套用選擇效果並清掉 pendingDecision。 */
function commitConfirmation(state: P3ALifeState): P3ALifeState {
  const decision = state.pendingDecision as P3APendingDecision;
  const optionId = decision.selectedOptionId as string;
  const before = state.stateHash;
  const flags = [...state.flags, `decision:${decision.decisionId}:${optionId}`].sort();
  const confirmed = seal({
    ...state,
    pendingDecision: null,
    phase: "life",
    flags,
    playback: { ...state.playback, mode: "paused" }
  });
  return appendWithRecord(confirmed, {
    seq: state.commandLog.length + 1,
    commandType: "CONFIRM_DECISION",
    payload: optionId,
    argsHash: sha256Hex(canonicalBytes({ type: "CONFIRM_DECISION", optionId } as never)),
    atYear: state.currentYear,
    effectiveYear: state.currentYear,
    auto: false,
    policyId: null,
    rngState: state.rng.state,
    rngDraws: state.rng.draws,
    stateHashBefore: before,
    stateHashAfter: confirmed.stateHash
  });
}

function appendWithRecord(state: P3ALifeState, record: Omit<P3ACommandRecord, "chainHash">): P3ALifeState {
  const chainHash = chainFor(state.hashChain, record);
  // commandLog／hashChain 不在 projection 內，因此 stateHashAfter 就是指令後的 stateHash。
  return { ...state, commandLog: [...state.commandLog, { ...record, chainHash }], hashChain: chainHash };
}

export function applyLifeCommand(state: P3ALifeState, command: P3ACommand): { state: P3ALifeState; deltas: readonly P3AYearDelta[] } {
  return guard(() => {
    assertLifeStateInvariants(state);
    if (!isRecord(command as unknown)) fail("E_P3A_TYPE");
    const type = (command as Record<string, unknown>).type;
    if (typeof type !== "string") fail("E_P3A_TYPE");
    switch (type) {
      case "TICK":
        return applyTick(state, (command as Extract<P3ACommand, { type: "TICK" }>).deltaMs);
      case "NEXT":
        return applyNext(state);
      case "SELECT_DECISION":
        return applySelect(state, (command as Extract<P3ACommand, { type: "SELECT_DECISION" }>).optionId);
      case "FAST_FORWARD_STEP":
        return applyFastForward(state, (command as Extract<P3ACommand, { type: "FAST_FORWARD_STEP" }>).maxYears);
      case "SET_PLAYBACK":
        return applySetPlayback(state, command as Extract<P3ACommand, { type: "SET_PLAYBACK" }>);
      default:
        return fail("E_P3A_ARGUMENT");
    }
  });
}

function applyTick(state: P3ALifeState, deltaMs: unknown): { state: P3ALifeState; deltas: readonly P3AYearDelta[] } {
  if (!isSafeInt(deltaMs) || deltaMs < 0 || deltaMs > P3A_MAX_DELTA_MS) fail("E_P3A_DELTA");
  if (state.playback.mode !== "playing") return { state, deltas: [] };

  let current = state;
  const deltas: P3AYearDelta[] = [];
  let elapsed = state.playback.elapsedInYearMs + (deltaMs as number) * state.playback.speed;
  while (elapsed >= current.playback.yearDurationMs && current.phase === "life" && current.pendingDecision === null) {
    elapsed -= current.playback.yearDurationMs;
    try {
      const result = resolveYearCore(current);
      current = result.state;
      deltas.push(result.delta);
    } catch (error) {
      // 年度結算錯誤：停止迴圈、保留 elapsed、寫入 errorCode 並暫停。
      current = markError(current, error);
      break;
    }
  }
  // 停在抉擇／死亡／錯誤時模擬時間不再推進：超出整年的時間無法套用（TICK 0ms 不得因此跨年），
  // 只保留不足一年的部分。正常情況下 elapsed 已小於 yearDurationMs，這裡是 no-op。
  while (elapsed >= current.playback.yearDurationMs) elapsed -= current.playback.yearDurationMs;
  const mode: P3APlaybackMode = canPlay(current) ? "playing" : "paused";
  return { state: { ...current, playback: { ...current.playback, mode, elapsedInYearMs: elapsed } }, deltas };
}

function applyNext(state: P3ALifeState): { state: P3ALifeState; deltas: readonly P3AYearDelta[] } {
  if (state.playback.mode === "fast_forward") fail("E_P3A_ARGUMENT");
  if (state.playback.visibility === "hidden") fail("E_P3A_PHASE");

  if (state.pendingDecision !== null) {
    const decision = state.pendingDecision as P3APendingDecision;
    if (decision.selectedOptionId === null) fail("E_P3A_ARGUMENT");
    return { state: commitConfirmation(state), deltas: [] };
  }
  if (state.playback.cardsSeen < state.history.cardsTotal) {
    // 只切卡，不推進年份，也不改播放模式。
    return { state: { ...state, playback: { ...state.playback, cardsSeen: state.playback.cardsSeen + 1 } }, deltas: [] };
  }
  if (!canPlay(state)) {
    // 死亡／錯誤：卡片讀完後仍是 paused，不得變回 playing。
    return { state: { ...state, playback: { ...state.playback, mode: "paused" } }, deltas: [] };
  }
  const mode: P3APlaybackMode = state.playback.mode === "playing" ? "paused" : "playing";
  return {
    state: { ...state, playback: { ...state.playback, mode, previousMode: mode === "playing" ? "playing" : "paused" } },
    deltas: []
  };
}

function applySelect(state: P3ALifeState, optionId: unknown): { state: P3ALifeState; deltas: readonly P3AYearDelta[] } {
  if (typeof optionId !== "string" || optionId.length === 0) fail("E_P3A_ARGUMENT");
  if (state.phase !== "pending_decision" || state.pendingDecision === null) fail("E_P3A_PHASE");
  const decision = state.pendingDecision as P3APendingDecision;
  if (decision.selectedOptionId !== null) fail("E_P3A_PHASE");
  if (!decision.options.some((option) => option.optionId === optionId)) fail("E_P3A_ARGUMENT");
  return { state: commitSelection(state, optionId), deltas: [] };
}

function applyFastForward(state: P3ALifeState, maxYears: unknown): { state: P3ALifeState; deltas: readonly P3AYearDelta[] } {
  // P3-A.6 信任邊界：背景隱藏即暫停，不得在 hidden 狀態快轉。
  // 必須在任何 RNG／年度結算／history／hash／delta 變更之前拒絕（與 hidden 下的 NEXT 一致）。
  if (state.playback.visibility === "hidden") fail("E_P3A_PHASE");

  const years = maxYears === undefined ? 1 : maxYears;
  if (!isSafeInt(years) || (years as number) < 1 || (years as number) > P3A_FAST_FORWARD_MAX_YEARS) fail("E_P3A_ARGUMENT");

  let current = state;
  const deltas: P3AYearDelta[] = [];
  for (let index = 0; index < (years as number); index += 1) {
    if (!canPlay(current)) break;
    try {
      const result = resolveYearCore(current);
      current = result.state;
      deltas.push(result.delta);
    } catch (error) {
      current = markError(current, error);
      break;
    }
  }
  // 遇抉擇／死亡／錯誤一律 paused；跑滿 maxYears 才是 fast_forward。
  const mode: P3APlaybackMode = canPlay(current) ? "fast_forward" : "paused";
  return { state: { ...current, playback: { ...current.playback, mode, previousMode: "paused" } }, deltas };
}

function applySetPlayback(
  state: P3ALifeState,
  command: Extract<P3ACommand, { type: "SET_PLAYBACK" }>
): { state: P3ALifeState; deltas: readonly P3AYearDelta[] } {
  let speed = state.playback.speed;
  if (command.speed !== undefined) {
    if (!isSafeInt(command.speed) || !(P3A_SPEEDS as readonly number[]).includes(command.speed)) fail("E_P3A_SPEED");
    speed = command.speed as (typeof P3A_SPEEDS)[number];
  }
  let paceMinutes = state.playback.paceMinutes;
  if (command.paceMinutes !== undefined) {
    if (!isSafeInt(command.paceMinutes) || !(P3A_PACE_MINUTES as readonly number[]).includes(command.paceMinutes)) fail("E_P3A_PACE");
    paceMinutes = command.paceMinutes as (typeof P3A_PACE_MINUTES)[number];
  }
  if (command.paused !== undefined && typeof command.paused !== "boolean") fail("E_P3A_ARGUMENT");
  if (command.hidden !== undefined && typeof command.hidden !== "boolean") fail("E_P3A_ARGUMENT");
  // 同一指令同時指定 hidden 與 paused 會產生互相矛盾的結果，一律拒絕。
  if (command.hidden !== undefined && command.paused !== undefined) fail("E_P3A_ARGUMENT");

  let mode: P3APlaybackMode = state.playback.mode;
  let visibility = state.playback.visibility;
  let previousMode = state.playback.previousMode;

  if (command.hidden === true) {
    visibility = "hidden";
    previousMode = mode === "playing" ? "playing" : "paused";
    mode = "paused";
  } else if (command.hidden === false) {
    visibility = "visible";
    mode = canPlay(state) && previousMode === "playing" ? "playing" : "paused";
  } else if (command.paused === true) {
    mode = "paused";
    previousMode = "paused";
  } else if (command.paused === false) {
    // pending／death／error 一律不得強制 playing。
    if (!canPlay(state)) fail("E_P3A_PHASE");
    if (state.playback.visibility === "hidden") fail("E_P3A_PHASE");
    mode = "playing";
    previousMode = "playing";
  }

  // P3-A.5：改 pace 時必須把「本年度已耗時間」按比例換算到新的年度長度，
  // 否則 elapsed 可能 >= 新 yearDurationMs，TICK 0ms 就會直接跨年。
  // 只改 speed 時 elapsed 不動（speed 只影響後續累積速度）。
  const oldDuration = state.playback.yearDurationMs;
  const newDuration = computeYearDurationMs(paceMinutes, state.paceLifeYearsX10);
  const elapsedInYearMs =
    paceMinutes === state.playback.paceMinutes
      ? state.playback.elapsedInYearMs
      : Math.floor((state.playback.elapsedInYearMs * newDuration) / oldDuration);

  return {
    state: {
      ...state,
      playback: {
        ...state.playback,
        mode,
        visibility,
        previousMode,
        speed,
        paceMinutes,
        yearDurationMs: newDuration,
        elapsedInYearMs
      }
    },
    deltas: []
  };
}

/* ------------------------------------------------------------------ */
/* 序列化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 存檔邊界：只接受「正式版本 ＋ 非 error」的狀態。
 * `phase = "error"` 是暫態終止畫面，不是合法存檔終點（應用程式只能保存錯誤前最後一個 checkpoint）。
 */
export function serializeLifeState(state: P3ALifeState): SerializedP3ALifeState {
  return serializeLifeStateInternal(state, false);
}

/** 內部序列化（benchmark 用）：允許內部 benchmark ruleset，但仍拒絕 error。 */
export function serializeLifeStateForBenchmark(state: P3ALifeState): SerializedP3ALifeState {
  return serializeLifeStateInternal(state, true);
}

function serializeLifeStateInternal(state: P3ALifeState, allowBenchmark: boolean): SerializedP3ALifeState {
  return guard(() => {
    assertLifeStateInvariants(state);
    if (!allowBenchmark) assertApprovedVersions(state.versions);
    if (state.phase === "error") fail("E_P3A_PHASE");
    return {
      ...state,
      assets: {
        balanceMicroUsd: encodeMoney(asPppMicro(state.assets.balanceMicroUsd)) as never,
        annualIncomeMicroUsd: encodeMoney(asPppMicro(state.assets.annualIncomeMicroUsd)) as never,
        annualExpenseMicroUsd: encodeMoney(asPppMicro(state.assets.annualExpenseMicroUsd)) as never
      }
    } as unknown as SerializedP3ALifeState;
  });
}

/** 低階解析：只還原金錢型別與形狀，不做信任宣告（不對外公開）。 */
function parseLifeState(serialized: SerializedP3ALifeState): P3ALifeState {
  if (!isRecord(serialized as unknown)) fail("E_P3A_TYPE");
  if (serialized.schemaVersion !== P3A_SCHEMA_VERSION) fail("E_P3A_VERSION");
  const assets = serialized.assets as unknown as Record<string, unknown>;
  if (!isRecord(assets)) fail("E_P3A_MONEY");
  const state: P3ALifeState = {
    ...(serialized as unknown as P3ALifeState),
    assets: {
      balanceMicroUsd: decodeMoneyOrFail(assets.balanceMicroUsd),
      annualIncomeMicroUsd: decodeMoneyOrFail(assets.annualIncomeMicroUsd),
      annualExpenseMicroUsd: decodeMoneyOrFail(assets.annualExpenseMicroUsd)
    }
  };
  assertLifeStateInvariants(state);
  return state;
}

/**
 * 冷啟動還原政策：playback 不是玩法權威，但存檔中的 playback **不得靜默丟棄**。
 * 保留 speed／paceMinutes／elapsedInYearMs／cardsSeen；強制 `paused`／`visible`／`previousMode = paused`；
 * `yearDurationMs` 一律依 pace 契約重算。
 */
function coldStartPlayback(raw: unknown, state: P3ALifeState): P3ALifeState["playback"] {
  if (!isRecord(raw)) fail("E_P3A_TYPE");
  const record = raw as Record<string, unknown>;
  if (!["playing", "paused", "fast_forward"].includes(record.mode as string)) fail("E_P3A_STATE");
  if (!["visible", "hidden"].includes(record.visibility as string)) fail("E_P3A_STATE");
  if (record.previousMode !== "playing" && record.previousMode !== "paused") fail("E_P3A_STATE");
  if (!(P3A_SPEEDS as readonly number[]).includes(record.speed as number)) fail("E_P3A_SPEED");
  if (!(P3A_PACE_MINUTES as readonly number[]).includes(record.paceMinutes as number)) fail("E_P3A_PACE");
  if (!isSafeInt(record.yearDurationMs) || (record.yearDurationMs as number) < P3A_YEAR_MS_MIN || (record.yearDurationMs as number) > P3A_YEAR_MS_MAX) {
    fail("E_P3A_PACE");
  }
  if (!isSafeInt(record.elapsedInYearMs) || (record.elapsedInYearMs as number) < 0) fail("E_P3A_STATE");
  if (!isSafeInt(record.cardsSeen) || (record.cardsSeen as number) < 0) fail("E_P3A_HISTORY");
  const paceMinutes = record.paceMinutes as number;
  const yearDurationMs = computeYearDurationMs(paceMinutes, state.paceLifeYearsX10);
  // 信任邊界同樣套用年度已耗時間不變量：0 <= elapsed < yearDurationMs。
  if ((record.elapsedInYearMs as number) >= yearDurationMs) fail("E_P3A_STATE");
  return {
    mode: "paused",
    visibility: "visible",
    previousMode: "paused",
    speed: record.speed as P3ALifeState["playback"]["speed"],
    paceMinutes: paceMinutes as P3ALifeState["playback"]["paceMinutes"],
    yearDurationMs,
    elapsedInYearMs: record.elapsedInYearMs as number,
    cardsSeen: record.cardsSeen as number
  };
}

/**
 * 反序列化是信任邊界：必須提供 genesis bootstrap，並從 genesis 實際重播比對權威玩法狀態；
 * playback 依冷啟動政策還原後，再跑一次完整 invariant。
 */
export function deserializeLifeState(serialized: SerializedP3ALifeState, bootstrap: P3ABootstrap): P3ALifeState {
  return guard(() => {
    const parsed = parseLifeState(serialized);
    const trace = verifyLifeReplayInternal({ bootstrap, targetState: parsed, commandLog: parsed.commandLog }, false);
    const merged: P3ALifeState = { ...trace.state, playback: coldStartPlayback(parsed.playback, trace.state) };
    assertLifeStateInvariants(merged);
    return merged;
  });
}

/* ------------------------------------------------------------------ */
/* 重播：bootstrap ＋ commandLog（唯一權威）                             */
/* ------------------------------------------------------------------ */

const MAX_REPLAY_YEARS = 100_000;

export interface P3AReplayTrace {
  readonly state: P3ALifeState;
  readonly deltas: readonly P3AYearDelta[];
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

/** 重建：只負責產生狀態，不做「這份狀態是否被偽造」的宣告。 */
export function reconstructLifeState(input: P3AReconstructInput): P3AReplayTrace {
  return reconstructLifeStateInternal(input, false);
}

/** 內部重建（benchmark 用）：允許內部 benchmark ruleset。不從 barrel 匯出。 */
export function reconstructLifeStateForBenchmark(input: P3AReconstructInput): P3AReplayTrace {
  return reconstructLifeStateInternal(input, true);
}

function reconstructLifeStateInternal(input: P3AReconstructInput, allowBenchmark: boolean): P3AReplayTrace {
  return guard(() => {
    if (!isRecord(input as unknown)) fail("E_P3A_TYPE");
    const targetYears = input.targetYears;
    if (!isSafeInt(targetYears) || targetYears < 0 || targetYears > MAX_REPLAY_YEARS) fail("E_P3A_ARGUMENT");
    if (!Array.isArray(input.commandLog)) fail("E_P3A_ARGUMENT");
    const log = input.commandLog as readonly P3ACommandRecord[];

    let state = createLifeStateInternal(input.bootstrap, allowBenchmark);
    const deltas: P3AYearDelta[] = [];
    let index = 0;

    const consume = (): void => {
      const atSeq = index + 1;
      const record = log[index] as P3ACommandRecord | undefined;
      if (record === undefined || !isRecord(record as unknown)) {
        fail("E_P3A_ARGUMENT", { divergenceYear: state.currentYear, divergenceSeq: atSeq });
      }
      const given = record as P3ACommandRecord;
      const pending = state.pendingDecision;
      const selectYear = state.currentYear;
      let next: P3ALifeState;
      if (given.commandType === "SELECT_DECISION") {
        if (pending === null) fail("E_P3A_ARGUMENT", { divergenceYear: selectYear, divergenceSeq: atSeq });
        if (pending.selectedOptionId !== null) fail("E_P3A_ARGUMENT", { divergenceYear: selectYear, divergenceSeq: atSeq });
        next = applyLifeCommand(state, { type: "SELECT_DECISION", optionId: given.payload }).state;
      } else if (given.commandType === "CONFIRM_DECISION") {
        if (pending === null) fail("E_P3A_ARGUMENT", { divergenceYear: selectYear, divergenceSeq: atSeq });
        if (pending.selectedOptionId === null) fail("E_P3A_ARGUMENT", { divergenceYear: selectYear, divergenceSeq: atSeq });
        next = applyLifeCommand(state, { type: "NEXT" }).state;
      } else {
        fail("E_P3A_ARGUMENT", { divergenceYear: selectYear, divergenceSeq: atSeq });
      }
      const applied = next as P3ALifeState;
      const produced = applied.commandLog[applied.commandLog.length - 1] as P3ACommandRecord | undefined;
      if (produced === undefined) fail("E_P3A_STATE");
      const actual = produced as P3ACommandRecord;
      if (!sameRecord(given, actual)) {
        fail("E_P3A_HASH", {
          divergenceYear: actual.atYear,
          divergenceSeq: actual.seq,
          expectedHash: actual.chainHash,
          actualHash: given.chainHash
        });
      }
      index += 1;
      state = applied;
    };

    while (true) {
      const head = log[index] as P3ACommandRecord | undefined;
      if (head !== undefined && isRecord(head as unknown)) {
        if (head.commandType === "SELECT_DECISION" && state.pendingDecision !== null && state.pendingDecision.selectedOptionId === null) {
          consume();
          continue;
        }
        if (head.commandType === "CONFIRM_DECISION" && state.pendingDecision !== null && state.pendingDecision.selectedOptionId !== null) {
          consume();
          continue;
        }
      }
      if (state.history.yearsRecorded >= targetYears) break;
      if (state.pendingDecision !== null) {
        // 需要先解決這個抉擇，但紀錄沒有對應指令。
        fail("E_P3A_ARGUMENT", { divergenceYear: state.currentYear, divergenceSeq: index + 1 });
      }
      if (state.phase !== "life") {
        fail("E_P3A_ARGUMENT", { divergenceYear: state.currentYear, divergenceSeq: index + 1 });
      }
      const result = resolveLifeYear(state);
      state = result.state;
      deltas.push(result.delta);
    }

    if (index < log.length) {
      fail("E_P3A_ARGUMENT", { divergenceYear: state.currentYear, divergenceSeq: index + 1 });
    }

    return { state, deltas, yearsReplayed: state.history.yearsRecorded, commandsConsumed: index };
  });
}

/** 舊名稱相容：等於 `reconstructLifeState`（重建，不代表已驗證）。 */
export function replayLifeState(input: P3AReconstructInput): P3ALifeState {
  return reconstructLifeState(input).state;
}

/** 權威欄位指紋：playback 是刻意排除的暫態欄位（契約明列），其餘全部必須相同。 */
function authoritativeFingerprint(state: P3ALifeState): Record<string, unknown> {
  return {
    projection: projection(state),
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

function firstDifferingField(expected: P3ALifeState, actual: P3ALifeState): string | null {
  const left = authoritativeFingerprint(expected);
  const right = authoritativeFingerprint(actual);
  for (const key of FINGERPRINT_KEYS) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return key;
  }
  return null;
}

/**
 * 驗證：targetState 必填。先完整驗證 targetState，再從 genesis 重播，
 * 逐欄比對所有權威欄位（projection／initialStateHash／commandLog／hashChain／stateHash）。
 * error 狀態是暫態終止畫面，不是合法存檔終點，因此不接受為驗證目標。
 */
export function verifyLifeReplay(input: P3AVerifyInput): P3AReplayTrace {
  return verifyLifeReplayInternal(input, false);
}

/** 內部驗證（benchmark 用）：允許內部 benchmark ruleset。不從 barrel 匯出。 */
export function verifyLifeReplayForBenchmark(input: P3AVerifyInput): P3AReplayTrace {
  return verifyLifeReplayInternal(input, true);
}

function verifyLifeReplayInternal(input: P3AVerifyInput, allowBenchmark: boolean): P3AReplayTrace {
  return guard(() => {
    if (!isRecord(input as unknown)) fail("E_P3A_TYPE");
    const target = input.targetState;
    if (!isRecord(target as unknown)) fail("E_P3A_TYPE");
    assertLifeStateInvariants(target);
    if (!allowBenchmark) assertApprovedVersions(target.versions);
    if (target.phase === "error") fail("E_P3A_PHASE");
    if (!isRecord(input.bootstrap as unknown)) fail("E_P3A_TYPE");
    if (input.commandLog !== undefined) {
      if (!Array.isArray(input.commandLog)) fail("E_P3A_ARGUMENT");
      if (input.commandLog.length !== target.commandLog.length) fail("E_P3A_ARGUMENT");
    }
    const log = input.commandLog === undefined ? target.commandLog : input.commandLog;
    const trace = reconstructLifeStateInternal({ bootstrap: input.bootstrap, targetYears: target.history.yearsRecorded, commandLog: log }, allowBenchmark);
    const field = firstDifferingField(target, trace.state);
    if (field !== null) {
      const divergence = trace.state.commandLog.length >= target.commandLog.length ? target.commandLog.length + 1 : trace.state.commandLog.length + 1;
      fail("E_P3A_HASH", {
        divergenceYear: trace.state.currentYear,
        divergenceSeq: divergence,
        expectedHash: target.stateHash,
        actualHash: trace.state.stateHash,
        field
      });
    }
    return trace;
  });
}

/** 驗證便利入口：等於 `verifyLifeReplay({ bootstrap, targetState: state })`。 */
export function verifyLifeState(bootstrap: P3ABootstrap, state: P3ALifeState): P3AReplayTrace {
  return guard(() => verifyLifeReplay({ bootstrap, targetState: state }));
}

/** 內部驗證便利入口（benchmark 用）。不從 barrel 匯出。 */
export function verifyLifeStateForBenchmark(bootstrap: P3ABootstrap, state: P3ALifeState): P3AReplayTrace {
  return guard(() => verifyLifeReplayForBenchmark({ bootstrap, targetState: state }));
}

/* ------------------------------------------------------------------ */
/* 測試專用：重簽（偽造）輔助                                            */
/* ------------------------------------------------------------------ */

/**
 * 測試專用：把一個被改過的狀態重新封裝成「自洽」的偽造狀態。
 * - `rechain = true` 會依 `history.initialStateHash` 重算整條 hashChain 與 stateHash，
 *   模擬「改了欄位又把所有相依 hash 一起重算」的攻擊。
 * - 這正是必須靠 genesis 重播才能抓到的情況；不得從公開 barrel 匯出。
 */
export function resignLifeStateForTests(state: P3ALifeState, rechain: boolean): P3ALifeState {
  return guard(() => {
    if (!isRecord(state as unknown)) fail("E_P3A_TYPE");
    if (!Array.isArray(state.commandLog)) fail("E_P3A_TYPE");
    let chain = chainRoot(state.history.initialStateHash);
    const records: P3ACommandRecord[] = [];
    for (let index = 0; index < state.commandLog.length; index += 1) {
      const record = state.commandLog[index] as P3ACommandRecord;
      if (!rechain) {
        records.push(record);
        continue;
      }
      const nextChain = chainFor(chain, {
        seq: record.seq,
        commandType: record.commandType,
        payload: record.payload,
        argsHash: record.argsHash,
        atYear: record.atYear,
        effectiveYear: record.effectiveYear,
        auto: record.auto,
        policyId: record.policyId,
        rngState: record.rngState,
        rngDraws: record.rngDraws,
        stateHashBefore: record.stateHashBefore,
        stateHashAfter: record.stateHashAfter
      });
      records.push({ ...record, chainHash: nextChain });
      chain = nextChain;
    }
    const forged: P3ALifeState = { ...state, commandLog: records, hashChain: rechain ? chain : state.hashChain };
    return seal(forged);
  });
}
