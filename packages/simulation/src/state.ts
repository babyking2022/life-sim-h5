import {
  MAX_MONEY_PPP_MICRO,
  MIN_MONEY_PPP_MICRO
} from "@life-sim/engine";
import {
  P3B_MAX_DECISION_OPTIONS,
  P3E_CONTENT_VERSION,
  P3E_ENGINE_VERSION,
  P3E_EVENT_DOMAIN,
  P3E_LIFE_DOMAIN,
  P3E_LIFE_SPEC_VERSION,
  P3E_MAX_AGE,
  P3E_MAX_COMMANDS,
  P3E_MAX_FLAGS,
  P3E_MAX_OCCURRENCES,
  P3E_MIN_AGE,
  P3E_PHASES,
  P3E_RNG_SPEC_VERSION,
  P3E_ROLL_SPEC_VERSION,
  P3E_RULESET_VERSION,
  P3E_SAVE_FORMAT_VERSION,
  P3E_SCHEMA_VERSION,
  P3E_SEXES,
  P3E_STAT_MAX,
  P3E_STAT_MIN,
  P3E_DEATH_DOMAIN,
  type P3EAssets,
  type P3ECommandSummary,
  type P3EDeathPackBinding,
  type P3EErrorCode,
  type P3EEventOccurrence,
  type P3EEventPackBinding,
  type P3EHistoryHeads,
  type P3EIdentityBinding,
  type P3ELifeRngState,
  type P3ELifeState,
  type P3EPackBindings,
  type P3EPendingDecisionSummary,
  type P3ERngState,
  type P3EStats,
  type P3EU32RngState,
  type P3EWordTuple
} from "@life-sim/contracts";
import { P3EError } from "./errors";

/**
 * P3-E state 的形狀驗證與深層快照（H5-CTO-065-A，套件內部，**不進公開 barrel**）。
 *
 * 唯一入口：
 *
 * ```ts
 * readP3EStateShape(input: unknown): P3ELifeState
 * ```
 *
 * 它回傳一個與輸入**完全斷開參考**、遞迴凍結的 `P3ELifeState` 快照。輸入只會被讀一次
 * （每個欄位恰好讀一次，透過 property descriptor 取值），因此驗證期間不可能發生 TOCTOU。
 *
 * ## 本批只做「形狀 ＋ 單欄型別 ＋ 單欄範圍」
 *
 * 刻意**不驗證**（留給下一批 invariants）：
 * `currentYear === birthYear + age`、age 120 與 phase 的關係、flags／occurrences 的排序與唯一、
 * RNG draws 與 age 的關係、identity 與 pack 的交叉綁定、
 * `stateHash === computeP3EStateHash(state)`、hashChain／command replay 真實性。
 *
 * ## 信任邊界
 *
 * - 只接受 `Object.prototype` 或 `null` 原型；class 實例、`Object.create({})` 一律拒絕。
 * - 每個物件都是 **exact-object**：多餘、缺少、不可列舉（hidden）、symbol、accessor 全部拒絕。
 *   （`Object.getOwnPropertyNames` 連不可列舉鍵都算，因此 hidden 欄位逃不掉。）
 * - 每個陣列都必須**密集**：`0..n-1` ＋ `length` 之外不得有字串鍵、symbol 鍵或 accessor。
 * - 已撤銷 Proxy、`getPrototypeOf`／`ownKeys`／`getOwnPropertyDescriptor` trap、throwing getter
 *   等所有反射例外，都只會轉成固定 `P3EError`（依欄位所屬群組），不外洩 `TypeError`／`RangeError`。
 * - 輸出是新物件／新陣列並遞迴凍結，因此「驗證後修改輸入」不可能影響輸出。
 *
 * ## 錯誤碼與 path
 *
 * | 群組 | 錯誤碼 | path 例 |
 * |---|---|---|
 * | 八個版本 | `E_P3E_VERSION` | `schemaVersion` |
 * | identity | `E_P3E_IDENTITY` | `identity.sex` |
 * | event pack | `E_P3E_EVENT_PACK` | `packs.events.eventCount` |
 * | death pack | `E_P3E_DEATH_PACK` | `packs.death.entityCount` |
 * | RNG | `E_P3E_RNG` | `rng.life.state[2]` |
 * | money | `E_P3E_MONEY` | `assets.balanceMicroUsd` |
 * | phase | `E_P3E_PHASE` | `phase` |
 * | flags／頂層／`packs`／stats／stateHash | `E_P3E_STATE` | `stats.health`、`stateHash` |
 * | occurrences | `E_P3E_EVENT` | `occurrences[0].eventId` |
 * | heads | `E_P3E_HISTORY` | `heads.hashChain` |
 * | commandLog | `E_P3E_COMMAND` | `commandLog.count` |
 *
 * 每個錯誤都帶**欄位級 path**（不是整個 `state`）；只有頂層物件本身的形狀錯誤用 `state`。
 */

/* ------------------------------------------------------------------ */
/* 固定常數                                                            */
/* ------------------------------------------------------------------ */

/** 21 個契約欄位（順序即驗證與輸出的順序）。 */
const STATE_KEYS = [
  "schemaVersion",
  "rulesetVersion",
  "rollSpecVersion",
  "lifeSpecVersion",
  "contentVersion",
  "saveFormatVersion",
  "engineVersion",
  "rngSpecVersion",
  "identity",
  "packs",
  "currentYear",
  "age",
  "phase",
  "pendingDecision",
  "stats",
  "assets",
  "flags",
  "occurrences",
  "rng",
  "heads",
  "commandLog",
  "stateHash"
] as const;

const IDENTITY_KEYS = [
  "entityId",
  "regionCode",
  "sex",
  "birthYear",
  "certificateId",
  "certificateHash",
  "playerIdentityHash",
  "masterSeedHash",
  "basePackId",
  "basePackChecksum",
  "identityPackId",
  "identityPackChecksum"
] as const;

const PACKS_KEYS = ["events", "death"] as const;

const EVENT_PACK_KEYS = [
  "eventSchemaVersion",
  "eventSpecVersion",
  "contentPackVersion",
  "eventPackId",
  "eventPackChecksum",
  "datasetChecksum",
  "eventCount"
] as const;

const DEATH_PACK_KEYS = [
  "schemaVersion",
  "deathDataVersion",
  "deathSpecVersion",
  "healthRuleVersion",
  "engineVersion",
  "rngSpecVersion",
  "deathPackId",
  "deathPackChecksum",
  "basePackId",
  "basePackChecksum",
  "entityCount"
] as const;

const STAT_KEYS = ["health", "happiness", "knowledge", "relationships"] as const;
const ASSET_KEYS = ["balanceMicroUsd", "annualIncomeMicroUsd", "annualExpenseMicroUsd"] as const;
const RNG_KEYS = ["life", "events", "death"] as const;
const CURSOR_KEYS = ["domain", "initialState", "state", "semanticDraws"] as const;
const EVENTS_CURSOR_KEYS = ["domain", "initialState", "state", "u32Draws"] as const;
const HEADS_KEYS = ["lastEntryHash", "lastSnapshotHash", "lastDeltaHash", "hashChain"] as const;
const COMMAND_KEYS = ["count", "headHash"] as const;
const OCCURRENCE_KEYS = ["eventId", "count", "lastYear"] as const;
const PENDING_DECISION_KEYS = ["year", "age", "eventId", "decisionId", "selectionHash", "optionIds"] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const FLAG_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const EVENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
/** 與 P3-B 的 `DECISION_ID_PATTERN` 相同：decisionId 與 optionId 共用。 */
const DECISION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

const MIN_BIRTH_YEAR = 1800;
const MAX_BIRTH_YEAR = 2200;
const MIN_YEAR = 1800;
/** 2200 ＋ `P3E_MAX_AGE`：currentYear／lastYear 的合理上限。 */
const MAX_YEAR = 2320;
/** 一般 ID／版本字串的長度上限（只是防呆，不是契約語意）。 */
const MAX_TEXT_LENGTH = 256;
const MIN_OCCURRENCE_COUNT = 1;
const MAX_OCCURRENCE_COUNT = P3E_MAX_AGE;
const MAX_EVENT_COUNT = 4096;
/** H5-CTO-065-A：死亡包的 entityCount 固定值（P3-D synthetic pack 的 169 個 entity）。 */
const REQUIRED_DEATH_ENTITY_COUNT = 169;
const U32_MAX = 0xffffffff;

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function fail(code: P3EErrorCode, path: string): never {
  throw new P3EError(code, path);
}

/* ------------------------------------------------------------------ */
/* 反射邊界：嚴格物件與密集陣列                                        */
/* ------------------------------------------------------------------ */

/**
 * 讀一個 exact-object；任何反射失敗都回 `null`（呼叫端再折成固定 `P3EError`）。
 *
 * 只用 `getOwnPropertyDescriptor` 取值：accessor（含 throwing getter）一律拒絕，
 * 因此呼叫端的 getter **永遠不會被執行**。
 */
function readExactObjectOrNull(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const names = Object.getOwnPropertyNames(value);
    // 多餘（含不可列舉）或缺少的欄位：自有鍵總數必須剛好等於契約欄位數。
    if (names.length !== keys.length) return null;
    // 必要欄位必須可列舉：否則序列化（JSON）後會無聲消失。
    if (Object.keys(value).length !== keys.length) return null;
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (!names.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

/** 讀一個密集陣列；稀疏、額外鍵、symbol、accessor、超長或反射失敗都回 `null`。 */
function readDenseArrayOrNull(value: unknown, maxLength: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) return null;
    const names = Object.getOwnPropertyNames(value);
    // 額外字串鍵（含不可列舉）會讓自有鍵數多於 length ＋ 1。
    if (names.length !== length + 1) return null;
    // 每個索引都必須可列舉（否則序列化後會無聲消失）。
    if (Object.keys(value).length !== length) return null;
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!names.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return null;
  }
}

function readExactObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  code: P3EErrorCode
): Record<string, unknown> {
  const record = readExactObjectOrNull(value, keys);
  if (record === null) fail(code, path);
  return record;
}

/* ------------------------------------------------------------------ */
/* 單欄讀取器                                                          */
/* ------------------------------------------------------------------ */

function readVersion<T extends string>(value: unknown, path: string, expected: T): T {
  if (value !== expected) fail("E_P3E_VERSION", path);
  return expected;
}

function readVersionNumber<T extends number>(value: unknown, path: string, expected: T): T {
  if (value !== expected) fail("E_P3E_VERSION", path);
  return expected;
}

function readText(value: unknown, path: string, code: P3EErrorCode): string {
  if (typeof value !== "string") fail(code, path);
  if (value.length === 0 || value.length > MAX_TEXT_LENGTH) fail(code, path);
  for (const char of value) {
    const point = char.codePointAt(0) as number;
    if (point < 0x20 || point === 0x7f) fail(code, path);
  }
  return value;
}

function readHex64(value: unknown, path: string, code: P3EErrorCode): string {
  if (typeof value !== "string" || !HEX64.test(value)) fail(code, path);
  return value;
}

function readInt(value: unknown, path: string, code: P3EErrorCode, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(code, path);
  if (value < min || value > max) fail(code, path);
  return value;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], path: string, code: P3EErrorCode): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(code, path);
  return value as T;
}

/** `min` 由呼叫端給（餘額可負；收支不得為負）；上界一律是 Money 契約最大值。 */
function readMoney(value: unknown, path: string, min: bigint): bigint {
  if (typeof value !== "bigint") fail("E_P3E_MONEY", path);
  if (value < min || value > MAX_MONEY_PPP_MICRO) fail("E_P3E_MONEY", path);
  return value;
}

/* ------------------------------------------------------------------ */
/* 群組讀取器                                                          */
/* ------------------------------------------------------------------ */

function readIdentity(value: unknown): P3EIdentityBinding {
  const code: P3EErrorCode = "E_P3E_IDENTITY";
  const record = readExactObject(value, "identity", IDENTITY_KEYS, code);
  const text = (key: string) => readText(record[key], `identity.${key}`, code);
  const hex = (key: string) => readHex64(record[key], `identity.${key}`, code);
  return {
    entityId: text("entityId"),
    regionCode: text("regionCode"),
    sex: readEnum(record.sex, P3E_SEXES, "identity.sex", code),
    birthYear: readInt(record.birthYear, "identity.birthYear", code, MIN_BIRTH_YEAR, MAX_BIRTH_YEAR),
    certificateId: text("certificateId"),
    certificateHash: hex("certificateHash"),
    // H5-CTO-067-A-R1：runtime 收緊成 64 位小寫 hex。contracts 仍型別成 string，
    // 但權威來源（P2-D `assertPlayerShape`、P2-B 的 `sha256Hex`）本來就是 64-hex。
    playerIdentityHash: hex("playerIdentityHash"),
    masterSeedHash: hex("masterSeedHash"),
    basePackId: text("basePackId"),
    basePackChecksum: hex("basePackChecksum"),
    identityPackId: text("identityPackId"),
    identityPackChecksum: hex("identityPackChecksum")
  };
}

function readEventPack(value: unknown): P3EEventPackBinding {
  const code: P3EErrorCode = "E_P3E_EVENT_PACK";
  const record = readExactObject(value, "packs.events", EVENT_PACK_KEYS, code);
  const text = (key: string) => readText(record[key], `packs.events.${key}`, code);
  return {
    eventSchemaVersion: text("eventSchemaVersion"),
    eventSpecVersion: text("eventSpecVersion"),
    contentPackVersion: text("contentPackVersion"),
    eventPackId: text("eventPackId"),
    eventPackChecksum: readHex64(record.eventPackChecksum, "packs.events.eventPackChecksum", code),
    datasetChecksum: readHex64(record.datasetChecksum, "packs.events.datasetChecksum", code),
    eventCount: readInt(record.eventCount, "packs.events.eventCount", code, 1, MAX_EVENT_COUNT)
  };
}

function readDeathPack(value: unknown): P3EDeathPackBinding {
  const code: P3EErrorCode = "E_P3E_DEATH_PACK";
  const record = readExactObject(value, "packs.death", DEATH_PACK_KEYS, code);
  const text = (key: string) => readText(record[key], `packs.death.${key}`, code);
  const hex = (key: string) => readHex64(record[key], `packs.death.${key}`, code);
  const schemaVersion = text("schemaVersion");
  const deathDataVersion = text("deathDataVersion");
  const deathSpecVersion = text("deathSpecVersion");
  const healthRuleVersion = text("healthRuleVersion");
  const engineVersion = text("engineVersion");
  const rngSpecVersion = text("rngSpecVersion");
  const deathPackId = text("deathPackId");
  const deathPackChecksum = hex("deathPackChecksum");
  const basePackId = text("basePackId");
  const basePackChecksum = hex("basePackChecksum");
  // entityCount 是固定值（P3-D synthetic pack），放在最後檢查以維持固定的欄位驗證順序。
  if (record.entityCount !== REQUIRED_DEATH_ENTITY_COUNT) fail(code, "packs.death.entityCount");
  return {
    schemaVersion,
    deathDataVersion,
    deathSpecVersion,
    healthRuleVersion,
    engineVersion,
    rngSpecVersion,
    deathPackId,
    deathPackChecksum,
    basePackId,
    basePackChecksum,
    entityCount: REQUIRED_DEATH_ENTITY_COUNT
  };
}

function readPacks(value: unknown): P3EPackBindings {
  const record = readExactObject(value, "packs", PACKS_KEYS, "E_P3E_STATE");
  return { events: readEventPack(record.events), death: readDeathPack(record.death) };
}

function readStats(value: unknown): P3EStats {
  const code: P3EErrorCode = "E_P3E_STATE";
  const record = readExactObject(value, "stats", STAT_KEYS, code);
  const stat = (key: string) => readInt(record[key], `stats.${key}`, code, P3E_STAT_MIN, P3E_STAT_MAX);
  return {
    health: stat("health"),
    happiness: stat("happiness"),
    knowledge: stat("knowledge"),
    relationships: stat("relationships")
  };
}

function readAssets(value: unknown): P3EAssets {
  const record = readExactObject(value, "assets", ASSET_KEYS, "E_P3E_MONEY");
  return {
    balanceMicroUsd: readMoney(record.balanceMicroUsd, "assets.balanceMicroUsd", MIN_MONEY_PPP_MICRO),
    annualIncomeMicroUsd: readMoney(record.annualIncomeMicroUsd, "assets.annualIncomeMicroUsd", 0n),
    annualExpenseMicroUsd: readMoney(record.annualExpenseMicroUsd, "assets.annualExpenseMicroUsd", 0n)
  };
}

/** 四個合法 u32（密集、data property），且**不得全零**。 */
function readWords(value: unknown, path: string): P3EWordTuple {
  const items = readDenseArrayOrNull(value, 4);
  if (items === null || items.length !== 4) fail("E_P3E_RNG", path);
  const words = items.map((item, index) => readInt(item, `${path}[${index}]`, "E_P3E_RNG", 0, U32_MAX));
  if (words.every((word) => word === 0)) fail("E_P3E_RNG", path);
  return words as unknown as P3EWordTuple;
}

function readLifeCursor(value: unknown): P3ELifeRngState {
  const path = "rng.life";
  const record = readExactObject(value, path, CURSOR_KEYS, "E_P3E_RNG");
  if (record.domain !== P3E_LIFE_DOMAIN) fail("E_P3E_RNG", `${path}.domain`);
  return {
    domain: P3E_LIFE_DOMAIN,
    initialState: readWords(record.initialState, `${path}.initialState`),
    state: readWords(record.state, `${path}.state`),
    semanticDraws: readInt(record.semanticDraws, `${path}.semanticDraws`, "E_P3E_RNG", 1, Number.MAX_SAFE_INTEGER)
  };
}

function readU32Cursor<Domain extends string>(
  value: unknown,
  path: string,
  domain: Domain
): P3EU32RngState<Domain> {
  const record = readExactObject(value, path, EVENTS_CURSOR_KEYS, "E_P3E_RNG");
  if (record.domain !== domain) fail("E_P3E_RNG", `${path}.domain`);
  return {
    domain,
    initialState: readWords(record.initialState, `${path}.initialState`),
    state: readWords(record.state, `${path}.state`),
    u32Draws: readInt(record.u32Draws, `${path}.u32Draws`, "E_P3E_RNG", 0, Number.MAX_SAFE_INTEGER)
  };
}

function readRng(value: unknown): P3ERngState {
  const record = readExactObject(value, "rng", RNG_KEYS, "E_P3E_RNG");
  return {
    life: readLifeCursor(record.life),
    events: readU32Cursor(record.events, "rng.events", P3E_EVENT_DOMAIN),
    death: readU32Cursor(record.death, "rng.death", P3E_DEATH_DOMAIN)
  };
}

function readHeads(value: unknown): P3EHistoryHeads {
  const code: P3EErrorCode = "E_P3E_HISTORY";
  const record = readExactObject(value, "heads", HEADS_KEYS, code);
  const hex = (key: string) => readHex64(record[key], `heads.${key}`, code);
  return {
    lastEntryHash: hex("lastEntryHash"),
    lastSnapshotHash: hex("lastSnapshotHash"),
    lastDeltaHash: hex("lastDeltaHash"),
    hashChain: hex("hashChain")
  };
}

function readCommandLog(value: unknown): P3ECommandSummary {
  const code: P3EErrorCode = "E_P3E_COMMAND";
  const record = readExactObject(value, "commandLog", COMMAND_KEYS, code);
  return {
    count: readInt(record.count, "commandLog.count", code, 0, P3E_MAX_COMMANDS),
    headHash: readHex64(record.headHash, "commandLog.headHash", code)
  };
}

function readPendingDecision(value: unknown): P3EPendingDecisionSummary | null {
  const code: P3EErrorCode = "E_P3E_DECISION";
  if (value === null) return null;
  const record = readExactObject(value, "pendingDecision", PENDING_DECISION_KEYS, code);

  const eventId = record.eventId;
  if (typeof eventId !== "string" || !EVENT_ID_PATTERN.test(eventId)) fail(code, "pendingDecision.eventId");
  const decisionId = record.decisionId;
  if (typeof decisionId !== "string" || !DECISION_ID_PATTERN.test(decisionId)) {
    fail(code, "pendingDecision.decisionId");
  }

  const rawOptions = readDenseArrayOrNull(record.optionIds, P3B_MAX_DECISION_OPTIONS);
  if (rawOptions === null || rawOptions.length === 0) fail(code, "pendingDecision.optionIds");
  const seen = new Set<string>();
  const optionIds = rawOptions.map((item, index) => {
    const path = `pendingDecision.optionIds[${index}]`;
    if (typeof item !== "string" || !DECISION_ID_PATTERN.test(item)) fail(code, path);
    // 唯一性（順序由呼叫端負責，這裡只保證不重複）。
    if (seen.has(item)) fail(code, path);
    seen.add(item);
    return item;
  });

  return {
    year: readInt(record.year, "pendingDecision.year", code, MIN_YEAR, MAX_YEAR),
    age: readInt(record.age, "pendingDecision.age", code, P3E_MIN_AGE, P3E_MAX_AGE),
    eventId,
    decisionId,
    selectionHash: readHex64(record.selectionHash, "pendingDecision.selectionHash", code),
    optionIds
  };
}

function readFlags(value: unknown): readonly string[] {
  const items = readDenseArrayOrNull(value, P3E_MAX_FLAGS);
  if (items === null) fail("E_P3E_STATE", "flags");
  return items.map((item, index) => {
    if (typeof item !== "string" || !FLAG_PATTERN.test(item)) fail("E_P3E_STATE", `flags[${index}]`);
    return item;
  });
}

function readOccurrences(value: unknown): readonly P3EEventOccurrence[] {
  const items = readDenseArrayOrNull(value, P3E_MAX_OCCURRENCES);
  if (items === null) fail("E_P3E_EVENT", "occurrences");
  return items.map((item, index) => {
    const path = `occurrences[${index}]`;
    const record = readExactObject(item, path, OCCURRENCE_KEYS, "E_P3E_EVENT");
    const eventId = record.eventId;
    if (typeof eventId !== "string" || !EVENT_ID_PATTERN.test(eventId)) fail("E_P3E_EVENT", `${path}.eventId`);
    return {
      eventId,
      count: readInt(record.count, `${path}.count`, "E_P3E_EVENT", MIN_OCCURRENCE_COUNT, MAX_OCCURRENCE_COUNT),
      lastYear: readInt(record.lastYear, `${path}.lastYear`, "E_P3E_EVENT", MIN_YEAR, MAX_YEAR)
    };
  });
}

/* ------------------------------------------------------------------ */
/* 深層凍結                                                            */
/* ------------------------------------------------------------------ */

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* 唯一入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 驗證並回傳 `P3ELifeState` 的**獨立深層快照**。
 *
 * 只做 shape ＋ 單欄型別／範圍；不做任何跨欄位不變量（見檔頭清單）。
 * 每個欄位只讀一次；所有物件／陣列都是新建的，回傳值遞迴凍結且與輸入無共享參考。
 */
export function readP3EStateShape(input: unknown): P3ELifeState {
  const record = readExactObject(input, "state", STATE_KEYS, "E_P3E_STATE");
  const state: P3ELifeState = {
    schemaVersion: readVersion(record.schemaVersion, "schemaVersion", P3E_SCHEMA_VERSION),
    rulesetVersion: readVersion(record.rulesetVersion, "rulesetVersion", P3E_RULESET_VERSION),
    rollSpecVersion: readVersion(record.rollSpecVersion, "rollSpecVersion", P3E_ROLL_SPEC_VERSION),
    lifeSpecVersion: readVersion(record.lifeSpecVersion, "lifeSpecVersion", P3E_LIFE_SPEC_VERSION),
    contentVersion: readVersion(record.contentVersion, "contentVersion", P3E_CONTENT_VERSION),
    saveFormatVersion: readVersionNumber(record.saveFormatVersion, "saveFormatVersion", P3E_SAVE_FORMAT_VERSION),
    engineVersion: readVersion(record.engineVersion, "engineVersion", P3E_ENGINE_VERSION),
    rngSpecVersion: readVersion(record.rngSpecVersion, "rngSpecVersion", P3E_RNG_SPEC_VERSION),
    identity: readIdentity(record.identity),
    packs: readPacks(record.packs),
    currentYear: readInt(record.currentYear, "currentYear", "E_P3E_STATE", MIN_YEAR, MAX_YEAR),
    age: readInt(record.age, "age", "E_P3E_STATE", P3E_MIN_AGE, P3E_MAX_AGE),
    phase: readEnum(record.phase, P3E_PHASES, "phase", "E_P3E_PHASE"),
    pendingDecision: readPendingDecision(record.pendingDecision),
    stats: readStats(record.stats),
    assets: readAssets(record.assets),
    flags: readFlags(record.flags),
    occurrences: readOccurrences(record.occurrences),
    rng: readRng(record.rng),
    heads: readHeads(record.heads),
    commandLog: readCommandLog(record.commandLog),
    stateHash: readHex64(record.stateHash, "stateHash", "E_P3E_STATE")
  };
  return deepFreeze(state);
}
