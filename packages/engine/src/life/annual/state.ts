import {
  P3A_EMPTY_HISTORY_HASH,
  P3A_PACE_MINUTES,
  P3A_SPEEDS,
  P3A_STAT_MAX,
  P3A_YEAR_MS_MAX,
  P3A_YEAR_MS_MIN,
  P3C_DEFAULT_CONTENT_MODE,
  P3C_LIFE_SPEC_VERSION,
  P3C_MAX_FLAGS,
  P3C_MAX_OCCURRENCE_COUNT,
  P3C_MAX_OCCURRENCES,
  P3C_RULESET_VERSION,
  P3C_SAVE_FORMAT_VERSION,
  P3C_SCHEMA_VERSION,
  P3C_SELECTION_HASH_VERSION,
  P3C_CONTENT_VERSION,
  P3B_MAX_EVENTS,
  type P3ABootstrap,
  type P3ACommandRecord,
  type P3AStats,
  type P3BContentMode,
  type P3BEventOccurrence,
  type P3CErrorCode,
  type P3CEventPackBinding,
  type P3CLifeState,
  type P3CYearEventRecord
} from "@life-sim/contracts";
import { ascii, concatBytes, utf8Encode } from "../../bytes";
import { canonicalBytes } from "../../canonical/canonical";
import { asPppMicro, decodeMoney, MoneyError, type PppMicro } from "../../money";
import { sha256Hex } from "../../rng/sha256";
import { Xoshiro128StarStar } from "../../rng/xoshiro128";
import { isValidatedEventPack, type ValidatedEventPack } from "../events/validate";
import { computeYearDurationMs } from "../index";
import { fail } from "./errors";

/**
 * P3-C 權威 state：形狀、projection、三條 rolling hash、occurrence 摘要與建立入口。
 *
 * 所有 hash 都使用**新的 domain**（`LIFE1/P3C/*`），因此 `p3a-1` 與 `p3c-1` 的 stateHash
 * 不可能互相冒充；P3-A 的既有向量也完全不受影響。
 */

/* ------------------------------------------------------------------ */
/* Hash domain 與固定常數                                              */
/* ------------------------------------------------------------------ */

const STATE_DOMAIN = "LIFE1/P3C/STATE/v1";
const CHAIN_DOMAIN = "LIFE1/P3C/CHAIN/v1";
const CHAIN_INIT_DOMAIN = "LIFE1/P3C/CHAIN/INIT/v1";
const LOG_DOMAIN = "LIFE1/P3C/LOG/v1";
const SNAPSHOT_DOMAIN = "LIFE1/P3C/SNAPSHOT/v1";
const DELTA_DOMAIN = "LIFE1/P3C/DELTA/v1";
const OCCURRENCE_DOMAIN = "LIFE1/P3C/OCCURRENCES/v1";
const SELECTION_DOMAIN = "LIFE1/P3C/SELECTION/v1";
const EVENT_RNG_DOMAIN = "LIFE1/P3C/EVENTRNG/v1";

/** 每年固定消耗的人生 RNG 抽取次數（四狀態各一次）；事件 RNG 另計。 */
export const P3C_RNG_DRAWS_PER_YEAR = 4;
export const P3C_RNG_DRAWS_AT_BIRTH = 1;
/** 單一年度事件抽選的 draws 上限（rejection sampling 上限 128 次 × 2）。 */
export const P3C_MAX_EVENT_DRAWS_PER_YEAR = 256;

const FLAG_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const EVENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const MAX_YEAR = 100_000;
const MAX_LIFESPAN_YEARS = 100_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const clampStat = (value: number): number => Math.max(0, Math.min(P3A_STAT_MAX, value));

/* ------------------------------------------------------------------ */
/* 事件 RNG 游標                                                       */
/* ------------------------------------------------------------------ */

/**
 * 事件 RNG 的 genesis 種子：由 bootstrap 的 `rngState` 與 `birthYear` 以 domain separation 導出。
 * 刻意**不共用**人生 RNG 游標，這樣 P3-A 的 `rngDraws = initial + 4×age` 會計完全不動。
 */
export function deriveEventRngState(rngState: readonly [number, number, number, number], birthYear: number): readonly [number, number, number, number] {
  if (!Array.isArray(rngState) || rngState.length !== 4) fail("E_P3C_RNG");
  for (const word of rngState) if (!isSafeInt(word) || word < 0 || word > 0xffffffff) fail("E_P3C_RNG");
  if (!isSafeInt(birthYear)) fail("E_P3C_STATE");
  const digest = sha256Hex(
    concatBytes(
      ascii(EVENT_RNG_DOMAIN),
      Uint8Array.of(0),
      canonicalBytes({ rngState: [rngState[0], rngState[1], rngState[2], rngState[3]], birthYear } as never)
    )
  );
  const words: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    words.push(Number.parseInt(digest.slice(index * 8, index * 8 + 8), 16));
  }
  return [words[0] as number, words[1] as number, words[2] as number, words[3] as number];
}

/* ------------------------------------------------------------------ */
/* occurrence 摘要                                                     */
/* ------------------------------------------------------------------ */

export function occurrenceDigestOf(occurrences: readonly P3BEventOccurrence[]): string {
  const normalized = occurrences.map((entry) => ({ eventId: entry.eventId, count: entry.count, lastYear: entry.lastYear }));
  return sha256Hex(concatBytes(ascii(OCCURRENCE_DOMAIN), Uint8Array.of(0), canonicalBytes(normalized as never)));
}

/* ------------------------------------------------------------------ */
/* selectionHash                                                       */
/* ------------------------------------------------------------------ */

export interface P3CSelectionHashInput {
  readonly binding: P3CEventPackBinding;
  readonly contentMode: P3BContentMode;
  readonly preStateHash: string;
  readonly rollStateHash: string;
  readonly occurrenceDigest: string;
  readonly year: number;
  readonly age: number;
  readonly phase: string;
  readonly candidates: readonly { readonly eventId: string; readonly weight: number; readonly priority: number }[];
  readonly selectedEventId: string | null;
  readonly reason: string;
  readonly eventSelectionDigest: string;
  readonly drawsUsed: number;
  readonly rngStateBefore: readonly [number, number, number, number];
  readonly rngStateAfter: readonly [number, number, number, number];
}

/**
 * `selectionHash` 的 canonical projection（CTO 裁決 3）：
 * domain／version、pre-stateHash、occurrenceDigest、eventPackChecksum、選中的 eventId（或無事件）、
 * RNG before／after、drawsUsed 全部在內；另外加上 rollStateHash 與 P3-B 的抽選 digest。
 */
export function computeSelectionHash(input: P3CSelectionHashInput): string {
  const projection = {
    domain: "LIFE1/P3C/SELECTION",
    selectionHashVersion: P3C_SELECTION_HASH_VERSION,
    schemaVersion: P3C_SCHEMA_VERSION,
    rulesetVersion: P3C_RULESET_VERSION,
    lifeSpecVersion: P3C_LIFE_SPEC_VERSION,
    eventSchemaVersion: input.binding.eventSchemaVersion,
    eventSpecVersion: input.binding.eventSpecVersion,
    contentPackVersion: input.binding.contentPackVersion,
    eventPackId: input.binding.eventPackId,
    eventPackChecksum: input.binding.eventPackChecksum,
    datasetChecksum: input.binding.datasetChecksum,
    contentMode: input.contentMode,
    preStateHash: input.preStateHash,
    rollStateHash: input.rollStateHash,
    occurrenceDigest: input.occurrenceDigest,
    year: input.year,
    age: input.age,
    phase: input.phase,
    candidates: input.candidates.map((candidate) => ({
      eventId: candidate.eventId,
      weight: candidate.weight,
      priority: candidate.priority
    })),
    selectedEventId: input.selectedEventId,
    reason: input.reason,
    eventSelectionDigest: input.eventSelectionDigest,
    drawsUsed: input.drawsUsed,
    rngStateBefore: [input.rngStateBefore[0], input.rngStateBefore[1], input.rngStateBefore[2], input.rngStateBefore[3]],
    rngStateAfter: [input.rngStateAfter[0], input.rngStateAfter[1], input.rngStateAfter[2], input.rngStateAfter[3]]
  };
  return sha256Hex(concatBytes(ascii(SELECTION_DOMAIN), Uint8Array.of(0), canonicalBytes(projection as never)));
}

/* ------------------------------------------------------------------ */
/* state projection 與 stateHash                                       */
/* ------------------------------------------------------------------ */

function projectionEvents(state: P3CLifeState) {
  const events = state.events;
  return {
    binding: {
      eventSchemaVersion: events.binding.eventSchemaVersion,
      eventSpecVersion: events.binding.eventSpecVersion,
      contentPackVersion: events.binding.contentPackVersion,
      eventPackId: events.binding.eventPackId,
      eventPackChecksum: events.binding.eventPackChecksum,
      datasetChecksum: events.binding.datasetChecksum,
      eventCount: events.binding.eventCount
    },
    contentMode: events.contentMode,
    occurrences: events.occurrences.map((entry) => ({ eventId: entry.eventId, count: entry.count, lastYear: entry.lastYear })),
    // P3-C.1：initialState 是權威欄位，必須進 projection／stateHash。
    rng: {
      domain: events.rng.domain,
      initialState: [...events.rng.initialState],
      state: [...events.rng.state],
      draws: events.rng.draws
    }
  };
}

function projectionPending(state: P3CLifeState) {
  const pending = state.pendingDecision;
  if (pending === null) return null;
  return {
    decisionId: pending.decisionId,
    year: pending.year,
    prompt: pending.prompt,
    source: pending.source,
    eventId: pending.eventId,
    selectionHash: pending.selectionHash,
    occurrenceDigestBefore: pending.occurrenceDigestBefore,
    selectedOptionId: pending.selectedOptionId,
    options: pending.options.map((option) => ({
      optionId: option.optionId,
      label: option.label,
      effects: option.effects.map((effect) => canonicalEffect(effect))
    }))
  };
}

function canonicalEffect(effect: unknown): unknown {
  const node = effect as Record<string, unknown>;
  switch (node.type) {
    case "stat":
      return { type: "stat", stat: node.stat, delta: node.delta };
    case "money":
      return { type: "money", field: node.field, deltaMicroUsd: node.deltaMicroUsd };
    case "flag":
      return { type: "flag", flag: node.flag, action: node.action };
    case "openDecision":
      return { type: "openDecision", decisionId: node.decisionId };
    default:
      return { type: "informational" };
  }
}

function projection(state: P3CLifeState) {
  return {
    schemaVersion: state.schemaVersion,
    lifeSpecVersion: state.lifeSpecVersion,
    versions: {
      engineVersion: state.versions.engineVersion,
      rulesetVersion: state.versions.rulesetVersion,
      rngSpecVersion: state.versions.rngSpecVersion,
      dataVersion: state.versions.dataVersion,
      contentVersion: state.versions.contentVersion,
      saveFormatVersion: state.versions.saveFormatVersion
    },
    origin: {
      certificateHash: state.origin.certificateHash,
      certificateId: state.origin.certificateId,
      playerIdentityHash: state.origin.playerIdentityHash,
      masterSeedHash: state.origin.masterSeedHash,
      basePackId: state.origin.basePackId,
      basePackChecksum: state.origin.basePackChecksum,
      identityPackId: state.origin.identityPackId,
      identityPackChecksum: state.origin.identityPackChecksum
    },
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
      balanceMicroUsd: state.assets.balanceMicroUsd.toString(),
      annualIncomeMicroUsd: state.assets.annualIncomeMicroUsd.toString(),
      annualExpenseMicroUsd: state.assets.annualExpenseMicroUsd.toString()
    },
    flags: [...state.flags],
    rng: { domain: state.rng.domain, state: [...state.rng.state], draws: state.rng.draws },
    events: projectionEvents(state),
    pendingDecision: projectionPending(state),
    history: {
      yearsRecorded: state.history.yearsRecorded,
      cardsTotal: state.history.cardsTotal,
      lastEntryHash: state.history.lastEntryHash,
      lastSnapshotHash: state.history.lastSnapshotHash,
      lastDeltaHash: state.history.lastDeltaHash
    }
  };
}

function projectionHash(state: P3CLifeState): string {
  return sha256Hex(concatBytes(ascii(STATE_DOMAIN), Uint8Array.of(0), canonicalBytes(projection(state) as never)));
}

/** 內部用：只算 projection hash（不驗證）。供交易計算 rollStateHash。 */
export function eventLifeProjectionHash(state: P3CLifeState): string {
  return projectionHash(state);
}

/** 權威欄位投影（給重播比對用；playback 刻意不在內）。 */
export function eventLifeProjection(state: P3CLifeState): Record<string, unknown> {
  return projection(state) as unknown as Record<string, unknown>;
}

/** 重新封裝 stateHash（不含 chain；`hashChain` 不在 projection 內）。 */
export function sealEventLifeState(state: P3CLifeState): P3CLifeState {
  return { ...state, stateHash: projectionHash(state) };
}

export function eventLifeChainRoot(initialStateHash: string): string {
  return sha256Hex(concatBytes(ascii(CHAIN_INIT_DOMAIN), Uint8Array.of(0), utf8Encode(initialStateHash)));
}

export function eventLifeChainFor(prevChain: string, record: Omit<P3ACommandRecord, "chainHash">): string {
  return sha256Hex(
    concatBytes(ascii(CHAIN_DOMAIN), Uint8Array.of(0), utf8Encode(prevChain), Uint8Array.of(0), canonicalBytes(record as never))
  );
}

/* ------------------------------------------------------------------ */
/* 年度 hash（entry／snapshot／delta）                                  */
/* ------------------------------------------------------------------ */

export interface P3CEventYearEntryPayload {
  readonly seq: number;
  readonly year: number;
  readonly age: number;
  readonly entryId: string;
  readonly summary: string;
}

export interface P3CEventYearSnapshotPayload {
  readonly year: number;
  readonly age: number;
  readonly stats: P3AStats;
  readonly balanceMicroUsd: string;
  readonly phase: string;
}

export interface P3CEventYearDeltaPayload {
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
  readonly event: P3CYearEventRecord;
}

export function computeEventYearEntryHash(prevEntryHash: string, payload: P3CEventYearEntryPayload): string {
  if (!isHash(prevEntryHash)) fail("E_P3C_HISTORY");
  if (!isSafeInt(payload.seq) || payload.seq < 1) fail("E_P3C_HISTORY");
  if (!isSafeInt(payload.year) || !isSafeInt(payload.age) || payload.age < 0) fail("E_P3C_HISTORY");
  if (typeof payload.entryId !== "string" || payload.entryId.length === 0) fail("E_P3C_HISTORY");
  if (typeof payload.summary !== "string") fail("E_P3C_HISTORY");
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
}

export function computeEventYearSnapshotHash(prevSnapshotHash: string, payload: P3CEventYearSnapshotPayload): string {
  if (!isHash(prevSnapshotHash)) fail("E_P3C_HISTORY");
  if (!isSafeInt(payload.year) || !isSafeInt(payload.age) || payload.age < 0) fail("E_P3C_HISTORY");
  if (!["life", "pending_decision", "death", "error"].includes(payload.phase)) fail("E_P3C_HISTORY");
  for (const key of ["health", "happiness", "knowledge", "relationships"] as const) {
    const value = payload.stats[key];
    if (!isSafeInt(value) || value < 0 || value > P3A_STAT_MAX) fail("E_P3C_HISTORY");
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
}

/**
 * 年度 delta hash：entry ＋ snapshot ＋ card ＋ **event 稽核紀錄**。
 * 事件的 selectionHash／RNG／draws／occurrence digest／effects 增量全部被這條 rolling hash 包住。
 */
export function computeEventYearDeltaHash(prevDeltaHash: string, payload: P3CEventYearDeltaPayload): string {
  if (!isHash(prevDeltaHash)) fail("E_P3C_HISTORY");
  if (!isHash(payload.entry.entryHash) || !isHash(payload.snapshot.snapshotHash)) fail("E_P3C_HISTORY");
  if (!["summary", "decision", "milestone"].includes(payload.card.kind)) fail("E_P3C_HISTORY");
  if (typeof payload.card.cardId !== "string" || payload.card.cardId.length === 0) fail("E_P3C_HISTORY");
  if (typeof payload.card.title !== "string") fail("E_P3C_HISTORY");
  if (!isSafeInt(payload.card.year)) fail("E_P3C_HISTORY");
  if (!isSafeInt(payload.entry.seq) || payload.entry.seq < 1) fail("E_P3C_HISTORY");
  if (!isSafeInt(payload.entry.year) || !isSafeInt(payload.entry.age)) fail("E_P3C_HISTORY");
  if (!isSafeInt(payload.snapshot.year) || !isSafeInt(payload.snapshot.age)) fail("E_P3C_HISTORY");
  const balance = decodeMoneyOrFail(payload.snapshot.balanceMicroUsd);
  const event = payload.event;
  if (!isHash(event.selectionHash) || !isHash(event.occurrenceDigestBefore) || !isHash(event.occurrenceDigestAfter)) fail("E_P3C_HISTORY");
  if (!isSafeInt(event.drawsUsed) || event.drawsUsed < 0 || event.drawsUsed > P3C_MAX_EVENT_DRAWS_PER_YEAR) fail("E_P3C_HISTORY");
  if (!isSafeInt(event.candidateCount) || event.candidateCount < 0) fail("E_P3C_HISTORY");
  if (typeof event.totalWeight !== "string") fail("E_P3C_HISTORY");
  if (event.eventId !== null && (typeof event.eventId !== "string" || !EVENT_ID_PATTERN.test(event.eventId))) fail("E_P3C_HISTORY");
  const eventProjection = {
    eventId: event.eventId,
    reason: event.reason,
    drawsUsed: event.drawsUsed,
    rngStateBefore: [event.rngStateBefore[0], event.rngStateBefore[1], event.rngStateBefore[2], event.rngStateBefore[3]],
    rngStateAfter: [event.rngStateAfter[0], event.rngStateAfter[1], event.rngStateAfter[2], event.rngStateAfter[3]],
    selectionHash: event.selectionHash,
    occurrenceDigestBefore: event.occurrenceDigestBefore,
    occurrenceDigestAfter: event.occurrenceDigestAfter,
    candidateCount: event.candidateCount,
    totalWeight: event.totalWeight,
    outcome: {
      statDelta: {
        health: event.outcome.statDelta.health,
        happiness: event.outcome.statDelta.happiness,
        knowledge: event.outcome.statDelta.knowledge,
        relationships: event.outcome.statDelta.relationships
      },
      moneyDelta: {
        balanceMicroUsd: decodeMoneyOrFail(event.outcome.moneyDelta.balanceMicroUsd).toString(),
        annualIncomeMicroUsd: decodeMoneyOrFail(event.outcome.moneyDelta.annualIncomeMicroUsd).toString(),
        annualExpenseMicroUsd: decodeMoneyOrFail(event.outcome.moneyDelta.annualExpenseMicroUsd).toString()
      },
      flagsAdded: [...event.outcome.flagsAdded],
      flagsRemoved: [...event.outcome.flagsRemoved],
      informational: event.outcome.informational,
      openedDecisionId: event.outcome.openedDecisionId
    }
  };
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
        card: { cardId: payload.card.cardId, year: payload.card.year, kind: payload.card.kind, title: payload.card.title },
        event: eventProjection
      } as never)
    )
  );
}

/* ------------------------------------------------------------------ */
/* 金錢                                                                */
/* ------------------------------------------------------------------ */

function decodeMoneyOrFail(value: unknown): PppMicro {
  if (typeof value !== "string") fail("E_P3C_MONEY");
  try {
    return decodeMoney(value);
  } catch (error) {
    if (error instanceof MoneyError) fail("E_P3C_MONEY");
    fail("E_P3C_MONEY");
  }
}

function moneyOrFail(value: unknown): PppMicro {
  if (typeof value !== "bigint") fail("E_P3C_MONEY");
  try {
    return asPppMicro(value);
  } catch (error) {
    if (error instanceof MoneyError) fail("E_P3C_MONEY");
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 版本                                                                */
/* ------------------------------------------------------------------ */

export function isEventLifeState(value: unknown): value is P3CLifeState {
  return isRecord(value) && value.schemaVersion === P3C_SCHEMA_VERSION;
}

function assertVersionShape(versions: unknown): void {
  if (!isRecord(versions)) fail("E_P3C_VERSION");
  const record = versions as Record<string, unknown>;
  for (const key of ["engineVersion", "rulesetVersion", "rngSpecVersion", "dataVersion", "contentVersion"]) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) fail("E_P3C_VERSION");
  }
  if (record.rngSpecVersion !== "1.0.0") fail("E_P3C_VERSION");
}

/** 公開信任邊界只接受 P3-C 的正式版本組合。 */
export function assertEventLifeApprovedVersions(versions: unknown): void {
  assertVersionShape(versions);
  const record = versions as Record<string, unknown>;
  if (record.rulesetVersion !== P3C_RULESET_VERSION) fail("E_P3C_VERSION");
  if (record.contentVersion !== P3C_CONTENT_VERSION) fail("E_P3C_VERSION");
  if (record.saveFormatVersion !== P3C_SAVE_FORMAT_VERSION) fail("E_P3C_VERSION");
}

/* ------------------------------------------------------------------ */
/* 形狀與不變量                                                         */
/* ------------------------------------------------------------------ */

function assertOriginShape(origin: unknown): void {
  if (!isRecord(origin)) fail("E_P3C_STATE");
  const record = origin as Record<string, unknown>;
  for (const key of ["certificateHash", "playerIdentityHash", "masterSeedHash", "basePackChecksum", "identityPackChecksum"]) {
    if (!isHash(record[key])) fail("E_P3C_STATE");
  }
  if (typeof record.certificateId !== "string" || !/^cert:[0-9a-f]{24}$/.test(record.certificateId)) fail("E_P3C_STATE");
  if (typeof record.basePackId !== "string" || record.basePackId.length === 0) fail("E_P3C_STATE");
  if (typeof record.identityPackId !== "string" || record.identityPackId.length === 0) fail("E_P3C_STATE");
}

function assertStatsShape(stats: unknown, code: P3CErrorCode): void {
  if (!isRecord(stats)) fail(code);
  for (const key of ["health", "happiness", "knowledge", "relationships"] as const) {
    const value = (stats as Record<string, unknown>)[key];
    if (!isSafeInt(value) || value < 0 || value > P3A_STAT_MAX) fail(code);
  }
}

function assertWords(value: unknown, code: P3CErrorCode): void {
  if (!Array.isArray(value) || value.length !== 4) fail(code);
  for (const word of value as readonly unknown[]) {
    if (!isSafeInt(word) || (word as number) < 0 || (word as number) > 0xffffffff) fail(code);
  }
}

/** 兩個四字 tuple 是否逐字相同（先驗證，不是靠 `===`）。 */
function sameWords(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== 4 || right.length !== 4) return false;
  for (let index = 0; index < 4; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** 事件 pack 綁定：事件數量上限與 checksum 都必須自洽。 */
export function assertBindingShape(binding: unknown): void {
  if (!isRecord(binding)) fail("E_P3C_PACK");
  const record = binding as Record<string, unknown>;
  if (record.eventSchemaVersion !== "p3b-1") fail("E_P3C_PACK");
  if (record.eventSpecVersion !== "1.0.0") fail("E_P3C_PACK");
  if (typeof record.contentPackVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(record.contentPackVersion)) fail("E_P3C_PACK");
  if (typeof record.eventPackId !== "string" || !EVENT_ID_PATTERN.test(record.eventPackId)) fail("E_P3C_PACK");
  if (!isHash(record.eventPackChecksum)) fail("E_P3C_PACK");
  if (!isHash(record.datasetChecksum)) fail("E_P3C_PACK");
  if (!isSafeInt(record.eventCount) || record.eventCount < 0 || record.eventCount > P3B_MAX_EVENTS) fail("E_P3C_PACK");
}

/**
 * occurrence summary 的完整驗證（含 CTO 裁決 5 的三個上限）。
 * `yearsRecorded` 由 state 提供；`eventCount` 由綁定提供（建立時已對包驗證過）。
 */
export function assertOccurrences(
  occurrences: unknown,
  context: { readonly yearsRecorded: number; readonly currentYear: number; readonly birthYear: number; readonly eventCount: number }
): void {
  if (!Array.isArray(occurrences)) fail("E_P3C_OCCURRENCE");
  const bound = Math.min(P3C_MAX_OCCURRENCES, context.eventCount, context.yearsRecorded);
  if (occurrences.length > bound) fail("E_P3C_OCCURRENCE");
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const entry of occurrences as readonly unknown[]) {
    if (!isRecord(entry)) fail("E_P3C_OCCURRENCE");
    const record = entry as Record<string, unknown>;
    const eventId = record.eventId;
    if (typeof eventId !== "string" || !EVENT_ID_PATTERN.test(eventId)) fail("E_P3C_OCCURRENCE");
    if (seen.has(eventId)) fail("E_P3C_OCCURRENCE");
    seen.add(eventId);
    if (previous !== null && !(previous < eventId)) fail("E_P3C_OCCURRENCE");
    previous = eventId;
    const count = record.count;
    const lastYear = record.lastYear;
    if (!isSafeInt(count) || count < 1 || count > P3C_MAX_OCCURRENCE_COUNT) fail("E_P3C_OCCURRENCE");
    if (!isSafeInt(lastYear) || lastYear < 0 || lastYear > MAX_YEAR) fail("E_P3C_OCCURRENCE");
    if (lastYear > context.currentYear) fail("E_P3C_OCCURRENCE");
    if (lastYear < context.birthYear + 1) fail("E_P3C_OCCURRENCE");
    // 每年最多一個事件：count 不可能超過「出生到 lastYear 的年度數」。
    if (count > lastYear - context.birthYear) fail("E_P3C_OCCURRENCE");
  }
}

function assertEventsShape(events: unknown, context: { yearsRecorded: number; currentYear: number; birthYear: number }): void {
  if (!isRecord(events)) fail("E_P3C_OCCURRENCE");
  const record = events as Record<string, unknown>;
  assertBindingShape(record.binding);
  if (record.contentMode !== "standard" && record.contentMode !== "guardian") fail("E_P3C_STATE");
  if (!isRecord(record.rng)) fail("E_P3C_RNG", "events.rng");
  const rng = record.rng as Record<string, unknown>;
  if (rng.domain !== "events") fail("E_P3C_RNG", "events.rng.domain");
  // P3-C.1：genesis cursor 與 current cursor 都必須是合法的四字 tuple。
  assertWords(rng.initialState, "E_P3C_RNG");
  assertWords(rng.state, "E_P3C_RNG");
  if (!isSafeInt(rng.draws) || rng.draws < 0) fail("E_P3C_RNG", "events.rng.draws");
  if (rng.draws > P3C_MAX_EVENT_DRAWS_PER_YEAR * context.yearsRecorded) fail("E_P3C_RNG", "events.rng.draws");
  // 零年度時 current 必須等於 genesis，draws 必須為 0。
  if (context.yearsRecorded === 0) {
    if (rng.draws !== 0) fail("E_P3C_RNG", "events.rng.draws");
    if (!sameWords(rng.initialState, rng.state)) fail("E_P3C_RNG", "events.rng.state");
  }
  assertOccurrences(record.occurrences, {
    yearsRecorded: context.yearsRecorded,
    currentYear: context.currentYear,
    birthYear: context.birthYear,
    eventCount: (record.binding as Record<string, unknown>).eventCount as number
  });
}

function assertPlaybackShape(playback: unknown, paceLifeYearsX10: number): void {
  if (!isRecord(playback)) fail("E_P3C_TYPE");
  const record = playback as Record<string, unknown>;
  if (!["playing", "paused", "fast_forward"].includes(record.mode as string)) fail("E_P3C_STATE");
  if (!["visible", "hidden"].includes(record.visibility as string)) fail("E_P3C_STATE");
  if (record.previousMode !== "playing" && record.previousMode !== "paused") fail("E_P3C_STATE");
  if (!(P3A_SPEEDS as readonly number[]).includes(record.speed as number)) fail("E_P3C_SPEED");
  if (!(P3A_PACE_MINUTES as readonly number[]).includes(record.paceMinutes as number)) fail("E_P3C_PACE");
  if (!isSafeInt(record.yearDurationMs)) fail("E_P3C_PACE");
  if ((record.yearDurationMs as number) < P3A_YEAR_MS_MIN || (record.yearDurationMs as number) > P3A_YEAR_MS_MAX) fail("E_P3C_PACE");
  if (record.yearDurationMs !== computeYearDurationMs(record.paceMinutes as number, paceLifeYearsX10)) fail("E_P3C_PACE");
  if (!isSafeInt(record.elapsedInYearMs) || (record.elapsedInYearMs as number) < 0) fail("E_P3C_STATE");
  if ((record.elapsedInYearMs as number) >= (record.yearDurationMs as number)) fail("E_P3C_STATE");
  if (!isSafeInt(record.cardsSeen) || (record.cardsSeen as number) < 0) fail("E_P3C_STATE");
}

function assertPendingDecision(value: unknown): void {
  if (!isRecord(value)) fail("E_P3C_STATE");
  const record = value as Record<string, unknown>;
  if (typeof record.decisionId !== "string" || record.decisionId.length === 0) fail("E_P3C_STATE");
  if (record.source !== "event" && record.source !== "skeleton") fail("E_P3C_DECISION");
  if (record.source === "event" && typeof record.eventId !== "string") fail("E_P3C_DECISION");
  if (record.source === "skeleton" && (typeof record.eventId !== "string" || !record.eventId.startsWith("skeleton.decision."))) {
    fail("E_P3C_DECISION");
  }
  if (typeof record.eventId !== "string" || !EVENT_ID_PATTERN.test(record.eventId)) fail("E_P3C_DECISION");
  if (!isHash(record.selectionHash)) fail("E_P3C_DECISION");
  if (!isHash(record.occurrenceDigestBefore)) fail("E_P3C_DECISION");
  if (typeof record.prompt !== "string") fail("E_P3C_STATE");
  if (!isSafeInt(record.year)) fail("E_P3C_STATE");
  if (!Array.isArray(record.options) || record.options.length < 2) fail("E_P3C_STATE");
  const ids: string[] = [];
  for (const option of record.options as readonly unknown[]) {
    if (!isRecord(option)) fail("E_P3C_STATE");
    const entry = option as Record<string, unknown>;
    if (typeof entry.optionId !== "string" || entry.optionId.length === 0) fail("E_P3C_STATE");
    if (typeof entry.label !== "string") fail("E_P3C_STATE");
    if (!Array.isArray(entry.effects)) fail("E_P3C_EFFECT");
    for (const effect of entry.effects as readonly unknown[]) {
      if (!isRecord(effect) || typeof effect.type !== "string") fail("E_P3C_EFFECT");
    }
    ids.push(entry.optionId);
  }
  if (new Set(ids).size !== ids.length) fail("E_P3C_STATE");
  if (record.selectedOptionId !== null && typeof record.selectedOptionId !== "string") fail("E_P3C_STATE");
  if (typeof record.selectedOptionId === "string" && !ids.includes(record.selectedOptionId)) fail("E_P3C_DECISION");
}

export function assertEventLifeShape(state: unknown): asserts state is P3CLifeState {
  if (!isRecord(state)) fail("E_P3C_TYPE");
  const value = state as Record<string, unknown>;
  if (value.schemaVersion !== P3C_SCHEMA_VERSION) fail("E_P3C_VERSION");
  if (value.lifeSpecVersion !== P3C_LIFE_SPEC_VERSION) fail("E_P3C_VERSION");
  assertVersionShape(value.versions);
  if ((value.versions as Record<string, unknown>).saveFormatVersion !== P3C_SAVE_FORMAT_VERSION) fail("E_P3C_VERSION");
  assertOriginShape(value.origin);
  if (!isSafeInt(value.birthYear) || value.birthYear < 1800 || value.birthYear > 2200) fail("E_P3C_STATE");
  if (!isSafeInt(value.currentYear) || !isSafeInt(value.age) || (value.age as number) < 0) fail("E_P3C_STATE");
  if (!["life", "pending_decision", "death", "error"].includes(value.phase as string)) fail("E_P3C_PHASE");
  if (!isSafeInt(value.lifespanYears) || (value.lifespanYears as number) <= 0 || (value.lifespanYears as number) > MAX_LIFESPAN_YEARS) {
    fail("E_P3C_STATE");
  }
  if (!isSafeInt(value.paceLifeYearsX10) || (value.paceLifeYearsX10 as number) <= 0) fail("E_P3C_STATE");
  assertStatsShape(value.stats, "E_P3C_STATE");
  if (!isRecord(value.assets)) fail("E_P3C_MONEY");
  const assets = value.assets as Record<string, unknown>;
  moneyOrFail(assets.balanceMicroUsd);
  moneyOrFail(assets.annualIncomeMicroUsd);
  moneyOrFail(assets.annualExpenseMicroUsd);
  if (!Array.isArray(value.flags)) fail("E_P3C_STATE");
  for (const flag of value.flags as readonly unknown[]) {
    if (typeof flag !== "string" || !FLAG_PATTERN.test(flag)) fail("E_P3C_STATE");
  }
  if (!isRecord(value.rng)) fail("E_P3C_RNG");
  const rng = value.rng as Record<string, unknown>;
  if (rng.domain !== "life") fail("E_P3C_RNG", "rng.domain");
  assertWords(rng.state, "E_P3C_RNG");
  if (!isSafeInt(rng.draws) || (rng.draws as number) < 0) fail("E_P3C_RNG");
  const history = value.history;
  if (!isRecord(history)) fail("E_P3C_HISTORY");
  const meta = history as Record<string, unknown>;
  if (!isSafeInt(meta.yearsRecorded) || (meta.yearsRecorded as number) < 0) fail("E_P3C_HISTORY");
  if (!isSafeInt(meta.cardsTotal) || (meta.cardsTotal as number) < 0) fail("E_P3C_HISTORY");
  if (!isHash(meta.lastEntryHash) || !isHash(meta.lastSnapshotHash) || !isHash(meta.lastDeltaHash)) fail("E_P3C_HISTORY");
  if (!isHash(meta.initialStateHash)) fail("E_P3C_HISTORY");
  assertEventsShape(value.events, {
    yearsRecorded: meta.yearsRecorded as number,
    currentYear: value.currentYear as number,
    birthYear: value.birthYear as number
  });
  if (value.pendingDecision !== null) assertPendingDecision(value.pendingDecision);
  if (!Array.isArray(value.commandLog)) fail("E_P3C_STATE");
  if (!isHash(value.stateHash) || !isHash(value.hashChain)) fail("E_P3C_HASH");
  assertPlaybackShape(value.playback, value.paceLifeYearsX10 as number);
}

/**
 * 完整驗證：形狀 ＋ 跨欄位一致性 ＋ 年度不變量 ＋ 指令鏈 ＋ stateHash。
 * 只證明「狀態自洽」；歷史真實性要 `verifyEventLifeReplay`（genesis 重播）。
 */
export function assertEventLifeInvariants(state: unknown, verifyHash = true): asserts state is P3CLifeState {
  assertEventLifeShape(state);
  const value = state as P3CLifeState;
  if (value.currentYear !== value.birthYear + value.age) fail("E_P3C_STATE");
  if (value.history.yearsRecorded !== value.age) fail("E_P3C_HISTORY");
  if (value.history.cardsTotal < value.history.yearsRecorded) fail("E_P3C_HISTORY");
  if (value.playback.cardsSeen > value.history.cardsTotal) fail("E_P3C_HISTORY");
  if (value.flags.length > P3C_MAX_FLAGS) fail("E_P3C_STATE");
  for (let index = 0; index < value.flags.length; index += 1) {
    if (index > 0 && !((value.flags[index - 1] as string) < (value.flags[index] as string))) fail("E_P3C_STATE");
  }

  const initialDraws = value.rng.draws - P3C_RNG_DRAWS_PER_YEAR * value.history.yearsRecorded;
  if (initialDraws !== 0 && initialDraws !== P3C_RNG_DRAWS_AT_BIRTH) fail("E_P3C_RNG", "rng.draws");

  if (value.history.yearsRecorded === 0) {
    if (value.events.occurrences.length !== 0) fail("E_P3C_OCCURRENCE");
    if (value.history.lastEntryHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3C_HISTORY");
    if (value.history.lastSnapshotHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3C_HISTORY");
    if (value.history.lastDeltaHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3C_HISTORY");
  }

  if (value.phase === "pending_decision") {
    const pending = value.pendingDecision;
    if (pending === null) fail("E_P3C_STATE");
    if (pending.year !== value.currentYear) fail("E_P3C_STATE");
    if (value.age >= value.lifespanYears) fail("E_P3C_STATE");
  } else if (value.pendingDecision !== null) {
    fail("E_P3C_STATE");
  }

  if (value.phase === "life" && value.age >= value.lifespanYears) fail("E_P3C_STATE");
  if (value.phase === "death" && value.age < value.lifespanYears) fail("E_P3C_STATE");
  if (value.phase === "error") {
    if (value.errorCode === null) fail("E_P3C_STATE");
  } else if (value.errorCode !== null) {
    fail("E_P3C_STATE");
  }

  const playback = value.playback;
  const canPlay = value.phase === "life" && value.pendingDecision === null;
  if (playback.visibility === "hidden" && playback.mode !== "paused") fail("E_P3C_STATE");
  if (playback.mode !== "paused" && !canPlay) fail("E_P3C_STATE");
  if (value.phase !== "life" && playback.mode !== "paused") fail("E_P3C_STATE");

  assertEventRuleCommandLog(value);
  if (verifyHash && projectionHash(value) !== value.stateHash) fail("E_P3C_HASH");
}

/** 逐筆驗證規則 commandLog 與 hashChain（結構層）。 */
export function assertEventRuleCommandLog(state: P3CLifeState): void {
  if (!isRecord(state as unknown)) fail("E_P3C_TYPE");
  if (!Array.isArray(state.commandLog)) fail("E_P3C_TYPE");
  if (!isHash(state.history.initialStateHash)) fail("E_P3C_HISTORY");
  if (!isHash(state.hashChain)) fail("E_P3C_HASH");

  let chain = eventLifeChainRoot(state.history.initialStateHash);
  let previousAfter: string | null = null;
  let previousYear: number | null = null;
  let openSelectionYear: number | null = null;
  let openSelectionOption: string | null = null;
  const initialDraws = state.rng.draws - P3C_RNG_DRAWS_PER_YEAR * state.history.yearsRecorded;

  for (let index = 0; index < state.commandLog.length; index += 1) {
    const record = state.commandLog[index] as P3ACommandRecord;
    if (!isRecord(record as unknown)) fail("E_P3C_TYPE");
    if (record.seq !== index + 1) fail("E_P3C_STATE");
    if (record.commandType !== "SELECT_DECISION" && record.commandType !== "CONFIRM_DECISION") fail("E_P3C_STATE");
    if (typeof record.payload !== "string" || record.payload.length === 0) fail("E_P3C_STATE");
    if (!isHash(record.argsHash)) fail("E_P3C_STATE");
    if (!isSafeInt(record.atYear) || !isSafeInt(record.effectiveYear)) fail("E_P3C_STATE");
    if (record.effectiveYear !== record.atYear) fail("E_P3C_STATE");
    if (record.atYear > state.currentYear) fail("E_P3C_STATE");
    if (typeof record.auto !== "boolean") fail("E_P3C_STATE");
    if (record.policyId !== null && typeof record.policyId !== "string") fail("E_P3C_STATE");
    assertWords(record.rngState, "E_P3C_RNG");
    if (!isSafeInt(record.rngDraws) || record.rngDraws < 0) fail("E_P3C_RNG");
    if (!isHash(record.stateHashBefore) || !isHash(record.stateHashAfter)) fail("E_P3C_HASH");
    if (record.stateHashBefore === record.stateHashAfter) fail("E_P3C_HASH");
    if (previousAfter !== null && record.atYear === previousYear && record.stateHashBefore !== previousAfter) fail("E_P3C_HASH");
    if (!isHash(record.chainHash)) fail("E_P3C_HASH");

    const ageAtDecision = record.atYear - state.birthYear;
    if (ageAtDecision < 0) fail("E_P3C_STATE");
    // 人生 RNG 仍然固定每年 4 抽：事件 RNG 走自己的游標，不動這條會計。
    if (record.rngDraws !== initialDraws + P3C_RNG_DRAWS_PER_YEAR * ageAtDecision) fail("E_P3C_RNG");

    if (record.commandType === "SELECT_DECISION") {
      if (openSelectionYear !== null) fail("E_P3C_STATE");
      openSelectionYear = record.atYear;
      openSelectionOption = record.payload;
    } else {
      if (openSelectionYear === null || openSelectionYear !== record.atYear) fail("E_P3C_STATE");
      if (record.payload !== openSelectionOption) fail("E_P3C_STATE");
      openSelectionYear = null;
      openSelectionOption = null;
    }

    const expectedChain = eventLifeChainFor(chain, {
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
    if (expectedChain !== record.chainHash) fail("E_P3C_HASH");
    chain = record.chainHash;
    previousAfter = record.stateHashAfter;
    previousYear = record.atYear;
  }
  if (chain !== state.hashChain) fail("E_P3C_HASH");

  const pending = state.pendingDecision;
  if (openSelectionYear !== null) {
    if (pending === null) fail("E_P3C_STATE");
    if (pending.selectedOptionId === null) fail("E_P3C_STATE");
    if (pending.year !== openSelectionYear) fail("E_P3C_STATE");
    if (pending.selectedOptionId !== openSelectionOption) fail("E_P3C_STATE");
  } else if (pending !== null && pending.selectedOptionId !== null) {
    fail("E_P3C_STATE");
  }
}

/* ------------------------------------------------------------------ */
/* pack 綁定                                                           */
/* ------------------------------------------------------------------ */

/** 由 validated pack 產生權威綁定（唯一入口；raw pack 會被 `isValidatedEventPack` 拒絕）。 */
export function bindEventPack(pack: unknown): P3CEventPackBinding {
  if (!isValidatedEventPack(pack)) fail("E_P3C_PACK");
  const manifest = pack.manifest;
  return {
    eventSchemaVersion: manifest.schemaVersion,
    eventSpecVersion: manifest.eventSpecVersion,
    contentPackVersion: manifest.contentPackVersion,
    eventPackId: manifest.eventPackId,
    eventPackChecksum: pack.packChecksum,
    datasetChecksum: pack.datasetChecksum,
    eventCount: pack.events.length
  };
}

function sameBinding(left: P3CEventPackBinding, right: P3CEventPackBinding): boolean {
  return (
    left.eventSchemaVersion === right.eventSchemaVersion &&
    left.eventSpecVersion === right.eventSpecVersion &&
    left.contentPackVersion === right.contentPackVersion &&
    left.eventPackId === right.eventPackId &&
    left.eventPackChecksum === right.eventPackChecksum &&
    left.datasetChecksum === right.datasetChecksum &&
    left.eventCount === right.eventCount
  );
}

/**
 * state 的綁定必須與本次交易使用的 pack 完全一致。
 * 任何替換（同 ID 不同 checksum、同 checksum 不同欄位）都會在讀事件之前被拒絕。
 */
export function assertPackBinding(state: P3CLifeState, pack: unknown): asserts pack is ValidatedEventPack {
  if (!isValidatedEventPack(pack)) fail("E_P3C_PACK");
  if (!sameBinding(state.events.binding, bindEventPack(pack))) fail("E_P3C_PACK");
}

/**
 * 綁定前的語意前置檢查（O(pack)，只在建立人生時跑一次）：
 * P3-C 的抉擇只能開一層，因此 pack 內任何 decision option 的 effects 都不得再 `openDecision`。
 * 這種 pack 在 P3-B 是合法的，但接進年度交易會在 CONFIRM 時無法收斂，所以在綁定時就拒絕。
 */
export function assertEventPackLifeEligible(pack: ValidatedEventPack): void {
  for (const event of pack.events) {
    if (event.decision === null) continue;
    for (const option of event.decision.options) {
      if (option.effects.some((effect) => effect.type === "openDecision")) fail("E_P3C_PACK", `pack.events.${event.eventId}.${option.optionId}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 建立                                                                */
/* ------------------------------------------------------------------ */

const BOOTSTRAP_FORBIDDEN_KEYS = ["lifespanYears", "events", "eventPack", "eventPackId", "eventPackChecksum"] as const;

function assertBootstrap(bootstrap: unknown, allowBenchmark: boolean): asserts bootstrap is P3ABootstrap {
  if (!isRecord(bootstrap)) fail("E_P3C_TYPE");
  const value = bootstrap as Record<string, unknown>;
  for (const key of BOOTSTRAP_FORBIDDEN_KEYS) {
    // raw pack 不得夾帶在 bootstrap 內；事件 pack 只能以 validated 形式另外傳入。
    if (key in value) fail("E_P3C_ARGUMENT");
  }
  assertVersionShape(value.versions);
  if (!allowBenchmark) assertEventLifeApprovedVersions(value.versions);
  assertOriginShape(value.origin);
  if (!isSafeInt(value.birthYear) || (value.birthYear as number) < 1800 || (value.birthYear as number) > 2200) fail("E_P3C_STATE");
  if (!isSafeInt(value.paceLifeYearsX10) || (value.paceLifeYearsX10 as number) < 100 || (value.paceLifeYearsX10 as number) > 1500) fail("E_P3C_STATE");
  assertWords(value.rngState, "E_P3C_STATE");
}

const BENCHMARK_RULESET_PREFIX = "p3c-bench-";

/** 內部建立核心：呼叫端必須先驗證 bootstrap 與 pack。 */
function buildEventLifeState(
  bootstrap: P3ABootstrap,
  pack: ValidatedEventPack,
  lifespanYears: number,
  rngState: readonly [number, number, number, number],
  draws: number
): P3CLifeState {
  const binding = bindEventPack(pack);
  const eventRngState = deriveEventRngState(bootstrap.rngState, bootstrap.birthYear);
  const draft: P3CLifeState = {
    schemaVersion: P3C_SCHEMA_VERSION,
    lifeSpecVersion: P3C_LIFE_SPEC_VERSION,
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
    events: {
      binding,
      contentMode: P3C_DEFAULT_CONTENT_MODE,
      occurrences: [],
      // P3-C.1：genesis 事件 RNG 是權威欄位；current = genesis、draws = 0。
      rng: { domain: "events", initialState: eventRngState, state: eventRngState, draws: 0 }
    },
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
  const initialStateHash = projectionHash(draft);
  return {
    ...draft,
    history: { ...draft.history, initialStateHash },
    stateHash: initialStateHash,
    hashChain: eventLifeChainRoot(initialStateHash)
  };
}

/**
 * 建立綁定事件 pack 的權威人生狀態。
 * 拒絕：缺少 pack、raw（未驗證）pack、錯誤版本、bootstrap 夾帶 pack。
 */
export function createEventLifeState(bootstrap: unknown, pack: unknown): P3CLifeState {
  assertBootstrap(bootstrap, false);
  if (!isValidatedEventPack(pack)) fail("E_P3C_PACK");
  assertEventPackLifeEligible(pack);
  const rng = new Xoshiro128StarStar(bootstrap.rngState);
  const lifespanYears = 60 + Number(rng.uniformBigInt(41n));
  return buildEventLifeState(bootstrap, pack, lifespanYears, rng.state, P3C_RNG_DRAWS_AT_BIRTH);
}

/** 內部 benchmark 建立入口（指定壽命）。不從 barrel 匯出。 */
export function createEventLifeStateForBenchmark(bootstrap: unknown, pack: unknown, lifespanYears: number): P3CLifeState {
  assertBootstrap(bootstrap, true);
  if (!isValidatedEventPack(pack)) fail("E_P3C_PACK");
  assertEventPackLifeEligible(pack);
  if (!isSafeInt(lifespanYears) || lifespanYears < 1 || lifespanYears > MAX_LIFESPAN_YEARS) fail("E_P3C_ARGUMENT");
  const rng = new Xoshiro128StarStar(bootstrap.rngState);
  return buildEventLifeState(bootstrap, pack, lifespanYears as number, rng.state, 0);
}

export { clampStat, FLAG_PATTERN, EVENT_ID_PATTERN, decodeMoneyOrFail, moneyOrFail, BENCHMARK_RULESET_PREFIX };
export type { PppMicro };
