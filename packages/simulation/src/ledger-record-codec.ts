import type { P3ERngState, P3EWordTuple } from "@life-sim/contracts";
import { P3EError } from "./errors";
import { readP3ECommandRecord, type P3ECommandRecord } from "./command-record";
import { verifyP3EYearLedgerRecord, type P3EYearLedgerRecord } from "./year-ledger-record";
import type { P3ECommand } from "./command-envelope";

/**
 * P3-E Ledger Record Pair 決定性 Codec（H5-CTO-151-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * encodeP3ELedgerRecordPair(input: unknown): string
 * decodeP3ELedgerRecordPair(input: unknown): P3ELedgerRecordPair
 * ```
 *
 * 一筆 Pair 只含兩份紀錄：`commandRecord`（九欄）與 `yearRecord`（十四欄）。
 * 頂層 canonical JSON 固定三欄、固定順序：`formatVersion` → `commandRecord` → `yearRecord`。
 *
 * ## 刻意不做
 *
 * - **不**編碼 State、Ledger 陣列；**不** append、**不**執行命令、**不** seal State、**不**做 Replay；
 * - **不**重算或修正任何 hash（一切交給 `readP3ECommandRecord`／`verifyP3EYearLedgerRecord`）；
 * - **不**加 timestamp／nonce／metadata；
 * - **不**對原始輸入 `JSON.stringify`，也**不**用 spread 自動收錄權威欄位——projection 逐欄手寫；
 * - **不**修改既有 State Codec。
 *
 * ## 錯誤邊界
 *
 * | 情況 | 錯誤 |
 * |---|---|
 * | 非字串／超長／壞 JSON／pollution keys | `E_P3E_CODEC at input` |
 * | 頂層不是 exact-object 三欄／encode 的輸入不是兩欄 | `E_P3E_CODEC at ledgerPair` |
 * | `formatVersion` 不是 `p3e-ledger-pair-1` | `E_P3E_CODEC at formatVersion` |
 * | Command Record 自身錯誤 | **原樣** `E_P3E_COMMAND` |
 * | Year Record 或 Command↔Year 連結錯誤 | **原樣** `E_P3E_HISTORY` |
 *
 * 不會把所有錯誤統一吞掉重包成 `E_P3E_CODEC`，也不外洩 `SyntaxError`／`TypeError`／`RangeError`。
 */

/* ------------------------------------------------------------------ */
/* 格式常數                                                            */
/* ------------------------------------------------------------------ */

/** 本 codec 的固定格式版本。 */
export const P3E_LEDGER_PAIR_FORMAT_VERSION = "p3e-ledger-pair-1" as const;
export type P3ELedgerPairFormatVersion = typeof P3E_LEDGER_PAIR_FORMAT_VERSION;

/** 與既有 State Codec 對齊的輸入長度上限（UTF-16 code units）。 */
export const P3E_LEDGER_PAIR_MAX_LENGTH = 1_048_576;

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 一筆 Pair：Command Record ＋ Year Ledger Record（皆為正式驗證過的快照）。 */
export interface P3ELedgerRecordPair {
  readonly commandRecord: P3ECommandRecord;
  readonly yearRecord: P3EYearLedgerRecord;
}

/* ------------------------------------------------------------------ */
/* 常數                                                                */
/* ------------------------------------------------------------------ */

const PAIR_KEYS = ["commandRecord", "yearRecord"] as const;
const ENVELOPE_KEYS = ["formatVersion", "commandRecord", "yearRecord"] as const;
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function failCodec(path: string): never {
  throw new P3EError("E_P3E_CODEC", path);
}

/* ------------------------------------------------------------------ */
/* 信任邊界：exact-object 且只讀 descriptor                            */
/* ------------------------------------------------------------------ */

interface OwnDataRecord {
  readonly keys: readonly string[];
  readonly values: ReadonlyMap<string, unknown>;
}

/**
 * 讀成「自有、可列舉、全部是 data property」的鍵值集合；任何反射失敗回 `null`。
 *
 * 只用 `getOwnPropertyDescriptor` 取值，因此呼叫端的 accessor／getter **不會被執行**。
 */
function readOwnDataRecord(input: unknown): OwnDataRecord | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input) as object | null;
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(input).length !== 0) return null;
    const keys = Object.getOwnPropertyNames(input);
    if (Object.keys(input).length !== keys.length) return null;
    const values = new Map<string, unknown>();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      values.set(key, descriptor.value);
    }
    return { keys, values };
  } catch {
    return null;
  }
}

/** JSON 解析後的 plain object（不檢查污染鍵；污染鍵由 `assertNoPollution` 負責）。 */
function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.keys(record).length !== keys.length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return false;
  }
  return true;
}

/**
 * 任意層級的 pollution key 掃描（`__proto__`／`constructor`／`prototype`）。
 *
 * `JSON.parse` 會把 `"__proto__": {...}` 變成**自有**屬性，因此掃自有鍵就夠；
 * 這裡逐層走物件與陣列，任何一層命中就回 `false`。
 */
function hasNoPollution(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (Array.isArray(value)) return value.every((item) => hasNoPollution(item));
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (POLLUTION_KEYS.has(key)) return false;
    if (!hasNoPollution((value as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Canonical projection（逐欄手寫，不用 spread）                       */
/* ------------------------------------------------------------------ */

function wordsProjection(words: P3EWordTuple): number[] {
  return [words[0], words[1], words[2], words[3]];
}

function rngProjection(rng: P3ERngState): unknown {
  return {
    life: {
      domain: rng.life.domain,
      initialState: wordsProjection(rng.life.initialState),
      state: wordsProjection(rng.life.state),
      semanticDraws: rng.life.semanticDraws
    },
    events: {
      domain: rng.events.domain,
      initialState: wordsProjection(rng.events.initialState),
      state: wordsProjection(rng.events.state),
      u32Draws: rng.events.u32Draws
    },
    death: {
      domain: rng.death.domain,
      initialState: wordsProjection(rng.death.initialState),
      state: wordsProjection(rng.death.state),
      u32Draws: rng.death.u32Draws
    }
  };
}

function commandProjection(command: P3ECommand): unknown {
  if (command.type === "ADVANCE_YEAR") return { type: command.type, contentMode: command.contentMode };
  if (command.type === "CHOOSE_DECISION") return { type: command.type, optionId: command.optionId };
  return { type: command.type, focusId: command.focusId };
}

/** Command Record 的固定九欄（順序固定）。 */
function commandRecordProjection(record: P3ECommandRecord): unknown {
  return {
    index: record.index,
    year: record.year,
    command: commandProjection(record.command),
    argsHash: record.argsHash,
    prevCommandHash: record.prevCommandHash,
    stateHashBefore: record.stateHashBefore,
    stateHashAfter: record.stateHashAfter,
    entryHash: record.entryHash,
    commandHash: record.commandHash
  };
}

/** Year Record 的固定十四欄（順序固定）。 */
function yearRecordProjection(record: P3EYearLedgerRecord): unknown {
  return {
    index: record.index,
    year: record.year,
    age: record.age,
    phase: record.phase,
    stateHashBefore: record.stateHashBefore,
    stateHashAfter: record.stateHashAfter,
    rngBefore: rngProjection(record.rngBefore),
    rngAfter: rngProjection(record.rngAfter),
    snapshotHash: record.snapshotHash,
    deltaHash: record.deltaHash,
    entryHash: record.entryHash,
    commandHash: record.commandHash,
    prevChainHash: record.prevChainHash,
    chainHash: record.chainHash
  };
}

/* ------------------------------------------------------------------ */
/* Encode                                                              */
/* ------------------------------------------------------------------ */

/** `commandRecord`：自身錯誤原樣外露（`E_P3E_COMMAND`）。 */
function readCommandRecordField(value: unknown): P3ECommandRecord {
  return readP3ECommandRecord(value);
}

/** `yearRecord`：自身與連結錯誤原樣外露（`E_P3E_HISTORY`）。 */
function readYearRecordField(record: unknown, commandRecord: P3ECommandRecord): P3EYearLedgerRecord {
  return verifyP3EYearLedgerRecord({ record, commandRecord });
}

/**
 * 把一筆 `{commandRecord, yearRecord}` 編成 canonical JSON 字串。
 *
 * 順序固定：exact-object 兩欄 → `readP3ECommandRecord` → `verifyP3EYearLedgerRecord`
 * → 逐欄手寫 projection → `JSON.stringify(projection)`。
 *
 * **不**接受外部預先編碼的 pair、**不**重算或修正任何 hash、**不**加 metadata。
 */
export function encodeP3ELedgerRecordPair(input: unknown): string {
  const raw = readOwnDataRecord(input);
  if (raw === null) failCodec("ledgerPair");
  for (const key of PAIR_KEYS) {
    if (!raw.values.has(key)) failCodec("ledgerPair");
  }
  if (raw.keys.length !== PAIR_KEYS.length) failCodec("ledgerPair");

  const commandRecord = readCommandRecordField(raw.values.get("commandRecord"));
  const yearRecord = readYearRecordField(raw.values.get("yearRecord"), commandRecord);

  return JSON.stringify({
    formatVersion: P3E_LEDGER_PAIR_FORMAT_VERSION,
    commandRecord: commandRecordProjection(commandRecord),
    yearRecord: yearRecordProjection(yearRecord)
  });
}

/* ------------------------------------------------------------------ */
/* Decode                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把 canonical JSON 字串解回一筆 Pair。
 *
 * 順序固定：string → 長度 → `JSON.parse` → 任意層級 pollution 掃描 → 頂層 exact-object
 * 三欄 → `formatVersion` → 取出兩筆（**不修補缺欄或 hash**）→ `readP3ECommandRecord`
 * → `verifyP3EYearLedgerRecord` → 獨立、遞迴凍結的 Pair。
 */
export function decodeP3ELedgerRecordPair(input: unknown): P3ELedgerRecordPair {
  if (typeof input !== "string") failCodec("input");
  if (input.length > P3E_LEDGER_PAIR_MAX_LENGTH) failCodec("input");

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    failCodec("input");
  }

  if (!hasNoPollution(parsed)) failCodec("input");

  const envelope = asPlainRecord(parsed);
  if (envelope === null) failCodec("ledgerPair");
  if (!hasExactKeys(envelope, ENVELOPE_KEYS)) failCodec("ledgerPair");
  if (envelope.formatVersion !== P3E_LEDGER_PAIR_FORMAT_VERSION) failCodec("formatVersion");

  const commandRecord = readCommandRecordField(envelope.commandRecord);
  const yearRecord = readYearRecordField(envelope.yearRecord, commandRecord);

  return Object.freeze({ commandRecord, yearRecord });
}

