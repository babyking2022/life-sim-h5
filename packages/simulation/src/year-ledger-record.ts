import {
  P3E_DEATH_DOMAIN,
  P3E_EVENT_DOMAIN,
  P3E_LIFE_DOMAIN,
  P3E_MAX_AGE,
  P3E_MIN_AGE,
  P3E_PHASES,
  type P3EDeathRngState,
  type P3EEventRngState,
  type P3EHex64,
  type P3ELifeRngState,
  type P3EPhase,
  type P3ERngState,
  type P3EWordTuple
} from "@life-sim/contracts";
import { P3EError } from "./errors";
import { computeP3EYearChainHash, computeP3EYearEntryHash } from "./year-ledger-hash";
import { readP3ECommandRecord, type P3ECommandRecord } from "./command-record";

/**
 * P3-E Year Ledger Record（H5-CTO-125-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * createP3EYearLedgerRecord(input: unknown): P3EYearLedgerRecord
 * verifyP3EYearLedgerRecord(input: unknown): P3EYearLedgerRecord
 * ```
 *
 * 一筆 Year Record 只保存**連結用**的 hash：Command 原始輸入與 `argsHash` 已在獨立的
 * Command Record，Year Record 只留 `commandHash` 與 `entryHash` 這兩個連結點。
 * 因此沒有 command payload／argsHash／prevCommandHash／timestamp／nonce／
 * Snapshot 或 Delta 原始資料／State 物件／任意 metadata。
 *
 * ## 本批只證明
 *
 * - Year Record 自洽；
 * - `entryHash` 與欄位一致；
 * - `chainHash` 與欄位一致；
 * - Command Record 與同一筆年度／State Hash／Entry 正確連結。
 *
 * ## 本批**不**證明（留給 State Assembly／Ledger Append／Replay）
 *
 * - `stateHashBefore` 是目前 State；
 * - `stateHashAfter` 是合法轉移結果；
 * - `snapshotHash`／`deltaHash` 是由真正 State 計算；
 * - `index` 與 State 的 `commandLog.count` 連續；
 * - `prevChainHash` 是目前 State 的 `heads.hashChain`；
 * - RNG 是合法年度交易結果；
 * - Command 在目前 phase 合法。
 *
 * 本批不建立 State、不 append Ledger 陣列、不執行命令、不做 codec／replay。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 一筆獨立、可驗證的年度 Ledger 記錄（固定十四欄）。 */
export interface P3EYearLedgerRecord {
  readonly index: number;
  readonly year: number;
  readonly age: number;
  readonly phase: P3EPhase;
  readonly stateHashBefore: P3EHex64;
  readonly stateHashAfter: P3EHex64;
  readonly rngBefore: P3ERngState;
  readonly rngAfter: P3ERngState;
  readonly snapshotHash: P3EHex64;
  readonly deltaHash: P3EHex64;
  readonly entryHash: P3EHex64;
  readonly commandHash: P3EHex64;
  readonly prevChainHash: P3EHex64;
  readonly chainHash: P3EHex64;
}

/* ------------------------------------------------------------------ */
/* 常數                                                                */
/* ------------------------------------------------------------------ */

/** 建立器的輸入（十二欄；**沒有** `entryHash`／`commandHash`／`chainHash`）。 */
const CREATE_KEYS = [
  "index",
  "year",
  "age",
  "phase",
  "stateHashBefore",
  "stateHashAfter",
  "rngBefore",
  "rngAfter",
  "snapshotHash",
  "deltaHash",
  "prevChainHash",
  "commandRecord"
] as const;

/** Year Record 的十四欄。 */
const RECORD_KEYS = [
  "index",
  "year",
  "age",
  "phase",
  "stateHashBefore",
  "stateHashAfter",
  "rngBefore",
  "rngAfter",
  "snapshotHash",
  "deltaHash",
  "entryHash",
  "commandHash",
  "prevChainHash",
  "chainHash"
] as const;

/** 驗證器的 wrapper（兩欄）。 */
const WRAPPER_KEYS = ["record", "commandRecord"] as const;

/** 八個 hash 欄位。 */
const RECORD_HASH_KEYS = [
  "stateHashBefore",
  "stateHashAfter",
  "snapshotHash",
  "deltaHash",
  "entryHash",
  "commandHash",
  "prevChainHash",
  "chainHash"
] as const;

const RNG_KEYS = ["life", "events", "death"] as const;
const LIFE_CURSOR_KEYS = ["domain", "initialState", "state", "semanticDraws"] as const;
const U32_CURSOR_KEYS = ["domain", "initialState", "state", "u32Draws"] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const U32_MAX = 0xffffffff;

const RNG_BEFORE_PATH = "yearLedgerRecord.rngBefore";
const RNG_AFTER_PATH = "yearLedgerRecord.rngAfter";

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function failHistory(path: string): never {
  throw new P3EError("E_P3E_HISTORY", path);
}

/* ------------------------------------------------------------------ */
/* 信任邊界：exact-object 且只讀 descriptor                            */
/* ------------------------------------------------------------------ */

/**
 * 讀成「自有、可列舉、全部是 data property」的鍵值集合；任何反射失敗回 `null`。
 *
 * 只用 `getOwnPropertyDescriptor` 取值，因此呼叫端的 accessor／getter **不會被執行**。
 */
function readExactDataObject(value: unknown, keys: readonly string[]): Map<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== keys.length) return null;
    if (Object.keys(value).length !== keys.length) return null;
    const values = new Map<string, unknown>();
    for (const key of keys) {
      if (!names.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      values.set(key, descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
}

/** 讀一個密集四元組（u32、不全零）；稀疏／額外鍵／accessor／symbol／超界都回 `null`。 */
function readDenseWords(value: unknown): readonly number[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    if (value.length !== 4) return null;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== 5) return null;
    if (Object.keys(value).length !== 4) return null;
    // 前面的長度／可列舉檢查已保證四個索引都存在，這裡不再重複檢查。
    const words: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return null;
      const word = descriptor.value;
      if (typeof word !== "number" || !Number.isSafeInteger(word)) return null;
      if (word < 0 || word > U32_MAX) return null;
      words.push(word);
    }
    if (words.every((word) => word === 0)) return null;
    return words;
  } catch {
    return null;
  }
}

function freezeWords(words: readonly number[]): P3EWordTuple {
  return Object.freeze([words[0] as number, words[1] as number, words[2] as number, words[3] as number]);
}

/* ------------------------------------------------------------------ */
/* RNG 讀取器（模組內部專用；不進 barrel，也不改既有 State reader）      */
/* ------------------------------------------------------------------ */

function readDraws(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function readLifeCursor(value: unknown, path: string): P3ELifeRngState {
  const record = readExactDataObject(value, LIFE_CURSOR_KEYS);
  if (record === null) failHistory(path);
  if (record.get("domain") !== P3E_LIFE_DOMAIN) failHistory(path);
  const initialWords = readDenseWords(record.get("initialState"));
  if (initialWords === null) failHistory(path);
  const words = readDenseWords(record.get("state"));
  if (words === null) failHistory(path);
  const semanticDraws = readDraws(record.get("semanticDraws"));
  if (semanticDraws === null) failHistory(path);
  return Object.freeze({
    domain: P3E_LIFE_DOMAIN,
    initialState: freezeWords(initialWords),
    state: freezeWords(words),
    semanticDraws
  });
}

function readU32Cursor<Domain extends string>(
  value: unknown,
  path: string,
  domain: Domain
): { readonly domain: Domain; readonly initialState: P3EWordTuple; readonly state: P3EWordTuple; readonly u32Draws: number } {
  const record = readExactDataObject(value, U32_CURSOR_KEYS);
  if (record === null) failHistory(path);
  if (record.get("domain") !== domain) failHistory(path);
  const initialWords = readDenseWords(record.get("initialState"));
  if (initialWords === null) failHistory(path);
  const words = readDenseWords(record.get("state"));
  if (words === null) failHistory(path);
  const u32Draws = readDraws(record.get("u32Draws"));
  if (u32Draws === null) failHistory(path);
  return Object.freeze({ domain, initialState: freezeWords(initialWords), state: freezeWords(words), u32Draws });
}

/**
 * 驗證完整 `P3ERngState`：三游標、六個密集四元組（u32、不全零）、正式 domain、
 * 非負安全整數 draws。任何問題統一折成 `E_P3E_HISTORY at <path>`。
 */
function readRngState(value: unknown, path: string): P3ERngState {
  const cursors = readExactDataObject(value, RNG_KEYS);
  if (cursors === null) failHistory(path);
  const life = readLifeCursor(cursors.get("life"), path);
  const events: P3EEventRngState = readU32Cursor(cursors.get("events"), path, P3E_EVENT_DOMAIN);
  const death: P3EDeathRngState = readU32Cursor(cursors.get("death"), path, P3E_DEATH_DOMAIN);
  return Object.freeze({ life, events, death });
}

/* ------------------------------------------------------------------ */
/* 單欄讀取器                                                          */
/* ------------------------------------------------------------------ */

/** `commandRecord`：任何問題（含其自身 argsHash／commandHash 不合法）都折成連結錯誤。 */
function readCommandRecordField(value: unknown): P3ECommandRecord {
  try {
    return readP3ECommandRecord(value);
  } catch {
    failHistory("yearLedgerRecord.commandRecord");
  }
}

function readIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) failHistory("yearLedgerRecord.index");
  return value;
}

function readYear(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) failHistory("yearLedgerRecord.year");
  return value;
}

function readAge(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) failHistory("yearLedgerRecord.age");
  if (value < P3E_MIN_AGE || value > P3E_MAX_AGE) failHistory("yearLedgerRecord.age");
  return value;
}

function readPhase(value: unknown): P3EPhase {
  if (typeof value !== "string") failHistory("yearLedgerRecord.phase");
  if (!(P3E_PHASES as readonly string[]).includes(value)) failHistory("yearLedgerRecord.phase");
  return value as P3EPhase;
}

function readHex(value: unknown, key: string): P3EHex64 {
  if (typeof value !== "string" || !HEX64.test(value)) failHistory(`yearLedgerRecord.${key}`);
  return value;
}

/* ------------------------------------------------------------------ */
/* 共用：連結檢查與 chain 計算                                          */
/* ------------------------------------------------------------------ */

interface RecordParts {
  readonly index: number;
  readonly year: number;
  readonly age: number;
  readonly phase: P3EPhase;
  readonly stateHashBefore: P3EHex64;
  readonly stateHashAfter: P3EHex64;
  readonly rngBefore: P3ERngState;
  readonly rngAfter: P3ERngState;
  readonly snapshotHash: P3EHex64;
  readonly deltaHash: P3EHex64;
  readonly prevChainHash: P3EHex64;
  readonly commandRecord: P3ECommandRecord;
}

/** Command Record 的年度／State Hash／Entry 必須與這筆年度一致。 */
function assertCommandLink(parts: RecordParts): void {
  const command = parts.commandRecord;
  if (command.index !== parts.index) failHistory("yearLedgerRecord.commandRecord");
  if (command.year !== parts.year) failHistory("yearLedgerRecord.commandRecord");
  if (command.stateHashBefore !== parts.stateHashBefore) failHistory("yearLedgerRecord.commandRecord");
  if (command.stateHashAfter !== parts.stateHashAfter) failHistory("yearLedgerRecord.commandRecord");
}

function entryHashOf(parts: RecordParts): P3EHex64 {
  return computeP3EYearEntryHash({
    index: parts.index,
    year: parts.year,
    age: parts.age,
    phase: parts.phase,
    stateHashBefore: parts.stateHashBefore,
    rngBefore: parts.rngBefore,
    rngAfter: parts.rngAfter,
    snapshotHash: parts.snapshotHash,
    deltaHash: parts.deltaHash
  });
}

function chainHashOf(parts: RecordParts, entryHash: P3EHex64): P3EHex64 {
  return computeP3EYearChainHash({
    prevChainHash: parts.prevChainHash,
    index: parts.index,
    year: parts.year,
    entryHash,
    stateHashAfter: parts.stateHashAfter,
    commandHash: parts.commandRecord.commandHash
  });
}

function freezeRecord(parts: RecordParts, entryHash: P3EHex64, chainHash: P3EHex64): P3EYearLedgerRecord {
  return Object.freeze({
    index: parts.index,
    year: parts.year,
    age: parts.age,
    phase: parts.phase,
    stateHashBefore: parts.stateHashBefore,
    stateHashAfter: parts.stateHashAfter,
    rngBefore: parts.rngBefore,
    rngAfter: parts.rngAfter,
    snapshotHash: parts.snapshotHash,
    deltaHash: parts.deltaHash,
    entryHash,
    commandHash: parts.commandRecord.commandHash,
    prevChainHash: parts.prevChainHash,
    chainHash
  });
}

/* ------------------------------------------------------------------ */
/* 建立器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 建立 Year Ledger Record。
 *
 * 輸入 exact-object 十二欄；流程固定：
 * shape → `readP3ECommandRecord` → 連結檢查（index／year／前後 stateHash）
 * → `computeP3EYearEntryHash` → `entryHash` 必須等於 Command Record 的 `entryHash`
 * → `commandHash` 取自 Command Record → `computeP3EYearChainHash` → 十四欄凍結。
 */
export function createP3EYearLedgerRecord(input: unknown): P3EYearLedgerRecord {
  const record = readExactDataObject(input, CREATE_KEYS);
  if (record === null) failHistory("yearLedgerRecord");

  const parts: RecordParts = {
    index: readIndex(record.get("index")),
    year: readYear(record.get("year")),
    age: readAge(record.get("age")),
    phase: readPhase(record.get("phase")),
    stateHashBefore: readHex(record.get("stateHashBefore"), "stateHashBefore"),
    stateHashAfter: readHex(record.get("stateHashAfter"), "stateHashAfter"),
    rngBefore: readRngState(record.get("rngBefore"), RNG_BEFORE_PATH),
    rngAfter: readRngState(record.get("rngAfter"), RNG_AFTER_PATH),
    snapshotHash: readHex(record.get("snapshotHash"), "snapshotHash"),
    deltaHash: readHex(record.get("deltaHash"), "deltaHash"),
    prevChainHash: readHex(record.get("prevChainHash"), "prevChainHash"),
    commandRecord: readCommandRecordField(record.get("commandRecord"))
  };

  assertCommandLink(parts);

  const entryHash = entryHashOf(parts);
  if (entryHash !== parts.commandRecord.entryHash) failHistory("yearLedgerRecord.entryHash");

  return freezeRecord(parts, entryHash, chainHashOf(parts, entryHash));
}

/* ------------------------------------------------------------------ */
/* 驗證器                                                              */
/* ------------------------------------------------------------------ */

function readRecordField(value: unknown, key: string): P3EHex64 {
  return readHex(value, key);
}

/**
 * 驗證 `{ record, commandRecord }` 並回傳獨立的深層凍結快照。
 *
 * 驗證順序：wrapper shape → 十四欄 shape → primitive／phase／RNG／八個 hash 格式
 * → `readP3ECommandRecord` → 交叉比對（index／year／前後 stateHash／commandHash）
 * → 重算 `entryHash` → 重算 `chainHash`。
 */
export function verifyP3EYearLedgerRecord(input: unknown): P3EYearLedgerRecord {
  const wrapper = readExactDataObject(input, WRAPPER_KEYS);
  if (wrapper === null) failHistory("yearLedgerRecord");

  const record = readExactDataObject(wrapper.get("record"), RECORD_KEYS);
  if (record === null) failHistory("yearLedgerRecord");

  const index = readIndex(record.get("index"));
  const year = readYear(record.get("year"));
  const age = readAge(record.get("age"));
  const phase = readPhase(record.get("phase"));
  const rngBefore = readRngState(record.get("rngBefore"), RNG_BEFORE_PATH);
  const rngAfter = readRngState(record.get("rngAfter"), RNG_AFTER_PATH);

  const hashes = new Map<string, P3EHex64>();
  for (const key of RECORD_HASH_KEYS) hashes.set(key, readRecordField(record.get(key), key));

  const parts: RecordParts = {
    index,
    year,
    age,
    phase,
    stateHashBefore: hashes.get("stateHashBefore") as P3EHex64,
    stateHashAfter: hashes.get("stateHashAfter") as P3EHex64,
    rngBefore,
    rngAfter,
    snapshotHash: hashes.get("snapshotHash") as P3EHex64,
    deltaHash: hashes.get("deltaHash") as P3EHex64,
    prevChainHash: hashes.get("prevChainHash") as P3EHex64,
    commandRecord: readCommandRecordField(wrapper.get("commandRecord"))
  };

  // 2. 交叉比對：Command Record 的 index／year／前後 State Hash
  assertCommandLink(parts);

  // 3. 由 Year Record 欄位重算 entryHash
  const entryHash = entryHashOf(parts);

  // 4. 與 Year Record 儲存的 entryHash 比對
  if (entryHash !== hashes.get("entryHash")) failHistory("yearLedgerRecord.entryHash");

  // 5. Command Record 的 entryHash 必須指向**同一個**重算結果。
  //    不可只靠 commandHash 間接判斷：攻擊者可以讓 Command Record 與 Year Record
  //    各自完全自洽（換掉 entryHash、重算 commandHash、再重算 chainHash），
  //    只有這一步直接比對 entryHash 才能攔住它。
  if (parts.commandRecord.entryHash !== entryHash) failHistory("yearLedgerRecord.commandRecord");

  // 6. 比對 commandHash
  if (parts.commandRecord.commandHash !== hashes.get("commandHash")) {
    failHistory("yearLedgerRecord.commandRecord");
  }

  // 7. 重算 chainHash 並比對
  const chainHash = chainHashOf(parts, entryHash);
  if (chainHash !== hashes.get("chainHash")) failHistory("yearLedgerRecord.chainHash");

  return freezeRecord(parts, entryHash, chainHash);
}
