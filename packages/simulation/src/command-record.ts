import type { P3EHex64 } from "@life-sim/contracts";
import { P3EError } from "./errors";
import { computeP3ECommandArgsHash, readP3ECommand, type P3ECommand } from "./command-envelope";
import { computeP3ECommandHash } from "./year-ledger-hash";

/**
 * P3-E Command Record（H5-CTO-123-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * createP3ECommandRecord(input: unknown): P3ECommandRecord
 * readP3ECommandRecord(input: unknown): P3ECommandRecord
 * ```
 *
 * ## 為什麼是這九欄
 *
 * - `command` 保存 Replay 所需的原始輸入；
 * - `argsHash` 綁定 command payload；
 * - `commandHash` 綁定前一筆 command、前後 State 與 entry；
 * - `chainHash` 屬 Year Chain Record，**不放進來**。
 *
 * 因此沒有 timestamp／nonce／selectedOptionId／chainHash／snapshotHash／deltaHash／
 * 任意 metadata／未凍結 payload。
 *
 * ## 本模組只證明三件事
 *
 * 1. Record 形狀合法；
 * 2. `argsHash` 與 `command` 一致；
 * 3. `commandHash` 與 Record 其餘欄位一致。
 *
 * ## 本模組**不**證明（留給 Ledger Append／Replay 批次）
 *
 * - `stateHashBefore` 是目前 State；
 * - `stateHashAfter` 是合法轉移結果；
 * - `entryHash` 屬於目前年度；
 * - `index` 與 `commandLog.count` 連續；
 * - `prevCommandHash` 等於目前 `commandLog.headHash`；
 * - 命令在當前 phase 合法。
 *
 * 本批不 append Ledger、不建立 State、不執行命令、不做 replay／verify／codec。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 可驗證、可供未來 Replay 使用的 Command Record（固定九欄）。 */
export interface P3ECommandRecord {
  readonly index: number;
  readonly year: number;
  readonly command: P3ECommand;
  readonly argsHash: P3EHex64;
  readonly prevCommandHash: P3EHex64;
  readonly stateHashBefore: P3EHex64;
  readonly stateHashAfter: P3EHex64;
  readonly entryHash: P3EHex64;
  readonly commandHash: P3EHex64;
}

/* ------------------------------------------------------------------ */
/* 常數                                                                */
/* ------------------------------------------------------------------ */

/** 建立器的輸入（七欄；**沒有** `argsHash`／`commandHash`）。 */
const CREATE_KEYS = [
  "index",
  "year",
  "command",
  "prevCommandHash",
  "stateHashBefore",
  "stateHashAfter",
  "entryHash"
] as const;

/** 驗證器的輸入（九欄）。 */
const RECORD_KEYS = [
  "index",
  "year",
  "command",
  "argsHash",
  "prevCommandHash",
  "stateHashBefore",
  "stateHashAfter",
  "entryHash",
  "commandHash"
] as const;

/**
 * 六個 hash 欄位（`argsHash`／`prevCommandHash`／`stateHashBefore`／
 * `stateHashAfter`／`entryHash`／`commandHash`）全部必須是 64 位小寫 hex；
 * 逐一以 `readHex` 驗證並帶自己的精確 path。
 */
const HEX64 = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function fail(path: string): never {
  throw new P3EError("E_P3E_COMMAND", path);
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

function isExactKeys(keys: readonly string[], expected: readonly string[]): boolean {
  if (keys.length !== expected.length) return false;
  return expected.every((key) => keys.includes(key));
}

/* ------------------------------------------------------------------ */
/* 單欄讀取器                                                          */
/* ------------------------------------------------------------------ */

/** `command`：錯誤一律折成 `commandRecord.command`（不外洩底層錯誤或 path）。 */
function readCommandField(value: unknown): P3ECommand {
  try {
    return readP3ECommand(value);
  } catch {
    fail("commandRecord.command");
  }
}

function readIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail("commandRecord.index");
  return value;
}

function readYear(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("commandRecord.year");
  return value;
}

function readHex(value: unknown, key: string): P3EHex64 {
  if (typeof value !== "string" || !HEX64.test(value)) fail(`commandRecord.${key}`);
  return value;
}

/* ------------------------------------------------------------------ */
/* 共用：計算並凍結                                                    */
/* ------------------------------------------------------------------ */

interface RecordParts {
  readonly index: number;
  readonly year: number;
  readonly command: P3ECommand;
  readonly prevCommandHash: P3EHex64;
  readonly stateHashBefore: P3EHex64;
  readonly stateHashAfter: P3EHex64;
  readonly entryHash: P3EHex64;
}

/** 用正式 `computeP3ECommandArgsHash` 與 `computeP3ECommandHash` 算並凍結九欄。 */
function buildRecord(parts: RecordParts): P3ECommandRecord {
  const argsHash = computeP3ECommandArgsHash(parts.command);
  const commandHash = computeP3ECommandHash({
    prevCommandHash: parts.prevCommandHash,
    index: parts.index,
    year: parts.year,
    command: parts.command.type,
    argsHash,
    stateHashBefore: parts.stateHashBefore,
    stateHashAfter: parts.stateHashAfter,
    entryHash: parts.entryHash
  });
  return Object.freeze({
    index: parts.index,
    year: parts.year,
    command: parts.command,
    argsHash,
    prevCommandHash: parts.prevCommandHash,
    stateHashBefore: parts.stateHashBefore,
    stateHashAfter: parts.stateHashAfter,
    entryHash: parts.entryHash,
    commandHash
  });
}

/* ------------------------------------------------------------------ */
/* 建立器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 建立 Command Record（**不接受**呼叫端提供 `argsHash`／`commandHash`）。
 *
 * 輸入 exact-object 七欄：`index`／`year`／`command`／`prevCommandHash`／
 * `stateHashBefore`／`stateHashAfter`／`entryHash`。
 *
 * 流程固定：exact-object → `readP3ECommand` → `computeP3ECommandArgsHash`
 * → `computeP3ECommandHash` → 九欄 → 遞迴凍結（與輸入零共享）。
 */
export function createP3ECommandRecord(input: unknown): P3ECommandRecord {
  const record = readOwnDataRecord(input);
  if (record === null) fail("commandRecord");
  if (!isExactKeys(record.keys, CREATE_KEYS)) fail("commandRecord");

  return buildRecord({
    index: readIndex(record.values.get("index")),
    year: readYear(record.values.get("year")),
    command: readCommandField(record.values.get("command")),
    prevCommandHash: readHex(record.values.get("prevCommandHash"), "prevCommandHash"),
    stateHashBefore: readHex(record.values.get("stateHashBefore"), "stateHashBefore"),
    stateHashAfter: readHex(record.values.get("stateHashAfter"), "stateHashAfter"),
    entryHash: readHex(record.values.get("entryHash"), "entryHash")
  });
}

/* ------------------------------------------------------------------ */
/* 驗證器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 驗證 Command Record 並回傳獨立的凍結快照。
 *
 * 驗證順序：Shape／primitive → Command → 重算 `argsHash` 比對 → 重算 `commandHash` 比對。
 *
 * 錯誤一律是 `E_P3E_COMMAND`：形狀／`index`／`year`／`command` 帶精確 path，
 * `argsHash` 不一致 → `commandRecord.argsHash`，
 * `commandHash` 不一致 → `commandRecord.commandHash`。
 */
export function readP3ECommandRecord(input: unknown): P3ECommandRecord {
  const record = readOwnDataRecord(input);
  if (record === null) fail("commandRecord");
  if (!isExactKeys(record.keys, RECORD_KEYS)) fail("commandRecord");

  const index = readIndex(record.values.get("index"));
  const year = readYear(record.values.get("year"));
  const command = readCommandField(record.values.get("command"));
  const prevCommandHash = readHex(record.values.get("prevCommandHash"), "prevCommandHash");
  const stateHashBefore = readHex(record.values.get("stateHashBefore"), "stateHashBefore");
  const stateHashAfter = readHex(record.values.get("stateHashAfter"), "stateHashAfter");
  const entryHash = readHex(record.values.get("entryHash"), "entryHash");
  const argsHash = readHex(record.values.get("argsHash"), "argsHash");
  const commandHash = readHex(record.values.get("commandHash"), "commandHash");

  // 3. argsHash 必須與 command 一致
  if (computeP3ECommandArgsHash(command) !== argsHash) fail("commandRecord.argsHash");

  // 4. commandHash 必須與其餘欄位一致
  const expectedCommandHash = computeP3ECommandHash({
    prevCommandHash,
    index,
    year,
    command: command.type,
    argsHash,
    stateHashBefore,
    stateHashAfter,
    entryHash
  });
  if (expectedCommandHash !== commandHash) fail("commandRecord.commandHash");

  return Object.freeze({
    index,
    year,
    command,
    argsHash,
    prevCommandHash,
    stateHashBefore,
    stateHashAfter,
    entryHash,
    commandHash
  });
}
