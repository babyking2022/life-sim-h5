import { P3E_MAX_COMMANDS, P3E_MIN_AGE, type P3ELifeState } from "@life-sim/contracts";
import { P3EError } from "./errors";
import { readP3EState } from "./state-invariants";
import { readP3ECommandRecord, type P3ECommandRecord } from "./command-record";
import { verifyP3EYearLedgerRecord, type P3EYearLedgerRecord } from "./year-ledger-record";
import { validateP3ELedgerContinuity } from "./ledger-continuity";

/**
 * P3-E Ledger History V1（正式主線，H5-CTO-175-A 整合；不進公開 barrel）。
 *
 * 來源：WorkBuddy 候選 `ledger-history-v1-candidate.ts`
 * （SHA-256 `43fdd40009d06b0577f97d39bf3e3fd847614d7a9bfba47c214e114f8e1862e1`，
 * 經 H5-CTO-164-B 核准、H5-CTO-175-A 正式整合）。
 *
 * ```ts
 * createP3ELedgerHistory(initialState: unknown): P3ELedgerHistory
 * readP3ELedgerHistory(input: unknown): P3ELedgerHistory
 * appendP3ELedgerHistory(input: unknown): P3ELedgerHistory
 * ```
 *
 * ## 這個模組證明什麼
 *
 * 「從初始 State 開始的完整 Command Record／Year Record Pair 歷史」容器：
 *
 * 1. History shape 合法（anchor 三欄 + records 密集陣列）；
 * 2. 每個 Pair 內部合法（**全部交給正式 Record 驗證原語**）；
 * 3. 跨紀錄鏈結連續：index 逐筆 +1、第一筆接 initial anchor、後續每筆接
 *    前一筆的 `stateHashAfter`／`commandHash`／`chainHash`；
 * 4. `appendP3ELedgerHistory` 的新 Pair 與**實際 previousState** 連續
 *    （尾端完全一致 + Ledger Continuity V1.1 前置條件）；
 * 5. 容器決定性、不可變、深層凍結、與輸入零共享；
 * 6. **可信增量 append（R1）**：模組私有 `WeakSet` 品牌讓連續 append 走
 *    增量快速路徑（**單次 append 的驗證成本 O(1)**，不重驗舊 Pair），
 *    不可信輸入仍一律完整 O(n) 驗證。注意：`records = [...old, new]` 每次都是
 *    O(n) 的**參考複製**，所以連續 n 次 append 的總參考複製成本是 O(n²)；
 *    在 4096 上限下實測仍小，本模組不引入 persistent vector／rope。
 *
 * ## 這個模組**不**證明（固定責任邊界）
 *
 * - 歷史中的年度業務是否可由 seed 重播；
 * - effect、mortality、decision 的真實性；
 * - Delta／Snapshot 是否能重建完整 State；
 * - Save format 或 JSON 編碼（Save Codec／Ledger Record Codec）；
 * - Replay；
 * - Command Executor（不執行命令、不重算年度業務）；
 * - 公開 API（不進 barrel）。
 *
 * ## 必須重用的原語（不重寫其 shape／hash／連續性驗證演算法）
 *
 * - `readP3EState`（`./state-invariants`）
 * - `readP3ECommandRecord`（`./command-record`）
 * - `verifyP3EYearLedgerRecord`（`./year-ledger-record`）
 * - `validateP3ELedgerContinuity`（正式 `./ledger-continuity`）
 * - `P3E_MAX_COMMANDS`（`@life-sim/contracts`）
 *
 * 正式原語自己發出的 `P3EError` **原樣往外拋**（不吞掉、不重包）；只有
 * 「History 自身的 shape／cross-link／tail-match 錯誤」使用本模組的固定
 * `ledgerHistory` 路徑。
 *
 * ## 整合前提（風險文件同步記錄）
 *
 * 本模組 import 正式 `./ledger-continuity`。Pair 介面只描述
 * 容器欄位，**不代表**建立新 Codec——不得為了型別而複製 Ledger Record Codec
 * 的編碼／解碼邏輯。
 */

/* ------------------------------------------------------------------ */
/* 型別（固定資料模型；無 timestamp／nonce／metadata／ID／快取欄位）      */
/* ------------------------------------------------------------------ */

/** Genesis anchor：初始 State 的三個 hash 連結點（純 `string` 欄位）。 */
export interface P3ELedgerHistoryAnchor {
  readonly stateHash: string;
  readonly commandHeadHash: string;
  readonly chainHash: string;
}

/** 一筆已驗證的 Command Record／Year Record Pair（容器只保存兩個正式 Record）。 */
export interface P3ELedgerHistoryRecordPair {
  readonly commandRecord: P3ECommandRecord;
  readonly yearRecord: P3EYearLedgerRecord;
}

/** 從初始 State 開始的完整歷史（紀錄數以 `records.length` 為準）。 */
export interface P3ELedgerHistory {
  readonly initial: P3ELedgerHistoryAnchor;
  readonly records: readonly P3ELedgerHistoryRecordPair[];
}

/** `readP3ELedgerHistory` 的輸入兩欄。 */
const HISTORY_KEYS = ["initial", "records"] as const;

/** Anchor 的三欄。 */
const ANCHOR_KEYS = ["stateHash", "commandHeadHash", "chainHash"] as const;

/** Pair 的兩欄。 */
const PAIR_KEYS = ["commandRecord", "yearRecord"] as const;

/** `appendP3ELedgerHistory` 的輸入四欄。 */
const APPEND_KEYS = ["history", "previousState", "commandRecord", "yearRecord"] as const;

const HEX64 = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* 模組私有可信集合（H5-CTO-175-A-R1：消除重複完整重驗）                  */
/* ------------------------------------------------------------------ */

/**
 * 模組私有可信品牌：只有本模組三個入口**完成深層凍結之後**的輸出會被加入。
 *
 * - 刻意不 export、不進 barrel、沒有任何對外存取器——外部程式碼無法把任意
 *   物件標記為可信；
 * - `appendP3ELedgerHistory` 只對集合內的 history 走增量快速路徑（跳過 O(n)
 *   完整重驗，僅驗 previousState、目前尾端與新 Pair continuity）；
 * - `readP3ELedgerHistory` 不因輸入看起來 frozen 就跳過驗證：外部
 *   `structuredClone` 複製品或 frozen 偽造物即使內容相同也不在集合內，
 *   一律完整 O(n) 驗證；
 * - 品牌存在於模組閉包內（`WeakSet`），隨 History 物件被 GC 一併回收，
 *   不引入任何計數或 metadata 欄位。
 */
const trustedHistories = new WeakSet<object>();

/**
 * 這個 History 是不是「本模組自己產生、已驗證、已深層凍結」的那一份？
 *
 * `WeakSet.has` 對非物件一律回 `false`（不拋例外），因此這裡不需要先做型別判斷；
 * 外部程式碼無法把任意物件塞進集合，也無法偽造品牌。
 */
function isTrustedHistory(value: unknown): value is P3ELedgerHistory {
  return trustedHistories.has(value as object);
}

/* ------------------------------------------------------------------ */
/* 固定錯誤路徑（全部 E_P3E_HISTORY；design 報告完整列出）               */
/* ------------------------------------------------------------------ */

/** `readP3ELedgerHistory` 頂層 shape（非 exact-object {initial, records}）。 */
const PATH_INPUT = "ledgerHistory.input";
/** Anchor shape；`createP3ELedgerHistory` 的非初始 State（count !== 0）。 */
const PATH_INITIAL = "ledgerHistory.initial";
const PATH_INITIAL_STATE_HASH = "ledgerHistory.initial.stateHash";
const PATH_INITIAL_COMMAND_HEAD = "ledgerHistory.initial.commandHeadHash";
const PATH_INITIAL_CHAIN = "ledgerHistory.initial.chainHash";
/** `records` shape（非陣列／稀疏／accessor／symbol／額外鍵）。 */
const PATH_RECORDS = "ledgerHistory.records";
/** `records.length` 超過 `P3E_MAX_COMMANDS`（4096）。 */
const PATH_RECORDS_LENGTH = "ledgerHistory.records.length";
/** Pair shape（非 exact-object {commandRecord, yearRecord}）。 */
const PATH_PAIR = "ledgerHistory.records.pair";
/** 第 N 筆 index !== N（兩份 Record 任一）。 */
const PATH_INDEX = "ledgerHistory.records.index";
/** `stateHashBefore` 與 anchor／前一筆 `stateHashAfter` 斷鏈。 */
const PATH_STATE_HASH_BEFORE = "ledgerHistory.records.stateHashBefore";
/** `prevCommandHash` 與 anchor／前一筆 `commandHash` 斷鏈。 */
const PATH_PREV_COMMAND_HASH = "ledgerHistory.records.prevCommandHash";
/** `prevChainHash` 與 anchor／前一筆 `chainHash` 斷鏈。 */
const PATH_PREV_CHAIN_HASH = "ledgerHistory.records.prevChainHash";
/** `appendP3ELedgerHistory` 頂層 shape（非 exact-object 四欄）。 */
const PATH_APPEND_INPUT = "ledgerHistory.append.input";
/** `previousState.commandLog.count` 與 History 尾端不一致。 */
const PATH_APPEND_COUNT = "ledgerHistory.append.count";
/** `previousState.stateHash` 與尾端不一致。 */
const PATH_APPEND_STATE_HASH = "ledgerHistory.append.stateHash";
/** `previousState.commandLog.headHash` 與尾端不一致。 */
const PATH_APPEND_COMMAND_HEAD = "ledgerHistory.append.commandHead";
/** `previousState.heads.hashChain` 與尾端不一致。 */
const PATH_APPEND_CHAIN_HEAD = "ledgerHistory.append.chainHead";
/** 三個 ledger heads（snapshot／delta／entry）與尾端不一致。 */
const PATH_APPEND_LEDGER_HEADS = "ledgerHistory.append.ledgerHeads";

function failHistory(path: string): never {
  throw new P3EError("E_P3E_HISTORY", path);
}

/* ------------------------------------------------------------------ */
/* 信任邊界：exact-object 且只讀 descriptor                            */
/* ------------------------------------------------------------------ */

/**
 * 把輸入讀成「自有、可列舉、全部是 data property」的鍵值集合。
 *
 * 任何反射失敗（已撤銷 Proxy、trap 拋錯、`getPrototypeOf` 例外、symbol 鍵、
 * 不可列舉鍵、accessor／getter、陣列、非 Object prototype）都回 `null`，呼叫端再
 * 折成固定 `P3EError`；因為只用 `getOwnPropertyDescriptor` 取值，**呼叫端的 getter
 * 永遠不會被執行**。
 */
function readOwnDataRecord(input: unknown): Map<string, unknown> | null {
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
    return values;
  } catch {
    return null;
  }
}

/** 確認鍵值集合恰好包含 `expected`（不多、不少）。 */
function hasExactKeys(record: ReadonlyMap<string, unknown>, expected: readonly string[]): boolean {
  if (record.size !== expected.length) return false;
  for (const key of expected) {
    if (!record.has(key)) return false;
  }
  return true;
}

/**
 * 讀成「密集、無額外鍵、全部 data property」的陣列。
 *
 * - 長度**先**於一切逐項檢查：`length > P3E_MAX_COMMANDS` 直接回 `"over-limit"`
 *   （不在超長陣列上做 `getOwnPropertyNames`／逐項 descriptor 讀取）；
 * - `names.length === length + 1`（恰好只有 "length" 這個非索引自有欄位）；
 * - `keys.length === length`（無不可列舉索引、無額外可列舉鍵）；
 * - 每個索引都必須是 data property（accessor 拒絕、getter 不執行）；
 * - 任何反射失敗（revoked Proxy 等）回 `null`，不外洩原生例外。
 */
function readDenseRecords(value: unknown): { readonly items: readonly unknown[] } | "over-limit" | null {
  try {
    if (!Array.isArray(value)) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    if (value.length > P3E_MAX_COMMANDS) return "over-limit";
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1) return null;
    if (Object.keys(value).length !== value.length) return null;
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return null;
      items.push(descriptor.value);
    }
    return { items };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 單欄讀取器                                                          */
/* ------------------------------------------------------------------ */

function readHex(value: unknown, path: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) failHistory(path);
  return value;
}

/** 讀 Anchor：exact-object 三欄 + 三個 64 位小寫 hex。 */
function readAnchor(value: unknown): P3ELedgerHistoryAnchor {
  const record = readOwnDataRecord(value);
  if (record === null) failHistory(PATH_INITIAL);
  if (!hasExactKeys(record, ANCHOR_KEYS)) failHistory(PATH_INITIAL);
  return Object.freeze({
    stateHash: readHex(record.get("stateHash"), PATH_INITIAL_STATE_HASH),
    commandHeadHash: readHex(record.get("commandHeadHash"), PATH_INITIAL_COMMAND_HEAD),
    chainHash: readHex(record.get("chainHash"), PATH_INITIAL_CHAIN)
  });
}

/**
 * 讀一個 Pair：exact-object 兩欄後**全部交給正式 Record 驗證原語**。
 *
 * 順序刻意是「先 command record、再 year record」：`verifyP3EYearLedgerRecord`
 * 內部會把 command record 的錯誤折成 `yearLedgerRecord.commandRecord`；先單獨
 * 驗一次，才能讓 **command record 自身的**錯誤以原樣 path 外露。兩個原語的
 * `P3EError` 都原樣往外拋（不吞掉、不重包）。
 */
function readPair(value: unknown): P3ELedgerHistoryRecordPair {
  const record = readOwnDataRecord(value);
  if (record === null) failHistory(PATH_PAIR);
  if (!hasExactKeys(record, PAIR_KEYS)) failHistory(PATH_PAIR);
  const commandRecord = readP3ECommandRecord(record.get("commandRecord"));
  const yearRecord = verifyP3EYearLedgerRecord({
    record: record.get("yearRecord"),
    commandRecord
  });
  return Object.freeze({ commandRecord, yearRecord });
}

/* ------------------------------------------------------------------ */
/* 跨紀錄鏈結                                                          */
/* ------------------------------------------------------------------ */

/**
 * 驗證完整跨紀錄鏈結（Pair 內部一致性已由正式原語保證，這裡只做「 Pair 與
 * Pair 之間、Pair 與 anchor 之間」的連續性）：
 *
 * - 第 N 筆（0-based `position`）的 index 必須是 `position + 1`（兩份 Record）；
 * - 第一筆的 `stateHashBefore`／`prevCommandHash`／`prevChainHash` 必須等於
 *   initial anchor 的 `stateHash`／`commandHeadHash`／`chainHash`；
 * - 後續每筆必須等於前一筆的 `stateHashAfter`／`commandHash`／`chainHash`。
 */
function assertCrossLinks(initial: P3ELedgerHistoryAnchor, pairs: readonly P3ELedgerHistoryRecordPair[]): void {
  let expectedStateHash: string = initial.stateHash;
  let expectedPrevCommandHash: string = initial.commandHeadHash;
  let expectedPrevChainHash: string = initial.chainHash;
  let expectedIndex = 1;
  for (const pair of pairs) {
    if (pair.commandRecord.index !== expectedIndex || pair.yearRecord.index !== expectedIndex) {
      failHistory(PATH_INDEX);
    }
    if (
      pair.commandRecord.stateHashBefore !== expectedStateHash ||
      pair.yearRecord.stateHashBefore !== expectedStateHash
    ) {
      failHistory(PATH_STATE_HASH_BEFORE);
    }
    if (pair.commandRecord.prevCommandHash !== expectedPrevCommandHash) {
      failHistory(PATH_PREV_COMMAND_HASH);
    }
    if (pair.yearRecord.prevChainHash !== expectedPrevChainHash) {
      failHistory(PATH_PREV_CHAIN_HASH);
    }
    expectedStateHash = pair.yearRecord.stateHashAfter;
    expectedPrevCommandHash = pair.commandRecord.commandHash;
    expectedPrevChainHash = pair.yearRecord.chainHash;
    expectedIndex += 1;
  }
}

/* ------------------------------------------------------------------ */
/* append 的尾端一致性                                                 */
/* ------------------------------------------------------------------ */

/**
 * `appendP3ELedgerHistory` 固定步驟 c：previousState 必須與 History 目前尾端
 * 完全一致。
 *
 * 空 History：`count === 0` + 三個 anchor 連結（stateHash／commandHead／chain）。
 *
 * 非空 History：`count === records.length` + `stateHash` 等於尾端
 * `stateHashAfter` + `commandLog.headHash` 等於尾端 `commandHash` +
 * `heads.hashChain` 等於尾端 `chainHash` + 三個 ledger heads 等於尾端的
 * `snapshotHash`／`deltaHash`／`entryHash`。
 */
/** 局部變數刻意命名為 `ledger`（不是 `history`）：`history` 是 DOM/BOM 全域名，
 *  P3-E 架構掃描的 purity 檢查會把該識別字視為污染。 */
function assertTailMatch(ledger: P3ELedgerHistory, previousState: P3ELifeState): void {
  if (ledger.records.length === 0) {
    if (previousState.commandLog.count !== 0) failHistory(PATH_APPEND_COUNT);
    if (previousState.stateHash !== ledger.initial.stateHash) failHistory(PATH_APPEND_STATE_HASH);
    if (previousState.commandLog.headHash !== ledger.initial.commandHeadHash) {
      failHistory(PATH_APPEND_COMMAND_HEAD);
    }
    if (previousState.heads.hashChain !== ledger.initial.chainHash) failHistory(PATH_APPEND_CHAIN_HEAD);
    return;
  }
  const tail = ledger.records[ledger.records.length - 1] as P3ELedgerHistoryRecordPair;
  if (previousState.commandLog.count !== ledger.records.length) failHistory(PATH_APPEND_COUNT);
  if (previousState.stateHash !== tail.yearRecord.stateHashAfter) failHistory(PATH_APPEND_STATE_HASH);
  if (previousState.commandLog.headHash !== tail.commandRecord.commandHash) {
    failHistory(PATH_APPEND_COMMAND_HEAD);
  }
  if (previousState.heads.hashChain !== tail.yearRecord.chainHash) failHistory(PATH_APPEND_CHAIN_HEAD);
  if (
    previousState.heads.lastSnapshotHash !== tail.yearRecord.snapshotHash ||
    previousState.heads.lastDeltaHash !== tail.yearRecord.deltaHash ||
    previousState.heads.lastEntryHash !== tail.yearRecord.entryHash
  ) {
    failHistory(PATH_APPEND_LEDGER_HEADS);
  }
}

/* ------------------------------------------------------------------ */
/* 入口一：createP3ELedgerHistory                                       */
/* ------------------------------------------------------------------ */

/**
 * 從 Genesis 初始 State 建立空 History。
 *
 * - `readP3EState` 先完整驗證（錯誤原樣外拋）；本模組「complete-from-genesis」
 *   的定義下，create 必須同時要求 `commandLog.count === 0` **且**
 *   `age === P3E_MIN_AGE`——合法的 age > 0、count = 0 State 不是完整歷史的
 *   合法起點。其餘 Genesis 完整性（heads／commandLog hash）交給
 *   `readP3EState` 的 genesis 不變量，本模組不重寫；
 * - 非 Genesis State → `E_P3E_HISTORY at ledgerHistory.initial`；
 * - anchor 取 `stateHash`／`commandLog.headHash`／`heads.hashChain`；
 * - 回傳 `records = []` 的深層凍結、與輸入零共享 History，並加入模組私有
 *   可信集合（後續 append 走增量快速路徑）。
 */
export function createP3ELedgerHistory(initialState: unknown): P3ELedgerHistory {
  const state = readP3EState(initialState);
  if (state.commandLog.count !== 0) failHistory(PATH_INITIAL);
  if (state.age !== P3E_MIN_AGE) failHistory(PATH_INITIAL);
  const ledger = Object.freeze({
    initial: Object.freeze({
      stateHash: state.stateHash,
      commandHeadHash: state.commandLog.headHash,
      chainHash: state.heads.hashChain
    }),
    records: Object.freeze([])
  });
  trustedHistories.add(ledger);
  return ledger;
}

/* ------------------------------------------------------------------ */
/* 入口二：readP3ELedgerHistory                                         */
/* ------------------------------------------------------------------ */

/**
 * 驗證完整 History 並回傳獨立、深層凍結的快照。
 *
 * 固定順序：頂層 exact-object 兩欄 → Anchor（三欄 + hex）→ records 密集陣列
 * （長度上限先檢查）→ 逐 Pair 正式原語驗證 → 完整跨紀錄鏈結 → 凍結快照。
 *
 * 不排序、不補洞、不修正、不重新計算任何外部傳入的 Record。
 */
export function readP3ELedgerHistory(input: unknown): P3ELedgerHistory {
  const record = readOwnDataRecord(input);
  if (record === null) failHistory(PATH_INPUT);
  if (!hasExactKeys(record, HISTORY_KEYS)) failHistory(PATH_INPUT);

  const initial = readAnchor(record.get("initial"));

  const dense = readDenseRecords(record.get("records"));
  if (dense === null) failHistory(PATH_RECORDS);
  if (dense === "over-limit") failHistory(PATH_RECORDS_LENGTH);

  const pairs: P3ELedgerHistoryRecordPair[] = [];
  for (const item of dense.items) {
    pairs.push(readPair(item));
  }

  assertCrossLinks(initial, pairs);

  const snapshot = Object.freeze({ initial, records: Object.freeze(pairs) });
  trustedHistories.add(snapshot);
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* 入口三：appendP3ELedgerHistory                                       */
/* ------------------------------------------------------------------ */

/**
 * 把一筆新的 Command Record／Year Record Pair append 到 History 尾端。
 *
 * input 固定四欄：`history`／`previousState`／`commandRecord`／`yearRecord`。
 * 固定順序：
 *
 * a. 取得現有歷史——**可信快速路徑（H5-CTO-164-B-R1）**：若 `history` 是本
 *    模組產生、已深層凍結且存在於模組私有可信集合（`trustedHistories`），
 *    **不得**再次完整呼叫 `readP3ELedgerHistory`，直接使用該可信 history，
 *    僅驗證 previousState、目前尾端與新 Pair continuity（單次 append 只做
 *    O(1) 增量驗證；但 `records=[...old,new]` 仍是 O(n) 參考複製，連續 append
 *    的總參考複製成本為 O(n²)，4096 上限下可接受）；其他任何輸入（含外部 `structuredClone`
 *    複製品與 frozen 偽造物）一律走 `readP3ELedgerHistory` 完整 O(n) 驗證，
 *    並改用其可信凍結快照；
 * b. `readP3EState(previousState)`；
 * c. previousState 與 History 目前尾端完全一致（`assertTailMatch`）；
 * d. `validateP3ELedgerContinuity({ previousState, commandRecord, yearRecord })`
 *    （正式 `./ledger-continuity`；錯誤原樣外拋）；
 * e. 把已驗證的深層凍結 Pair 淺複製 append 到**新的** records 陣列
 *    （目前上限 4096 筆，刻意不引入 chunk tree／rope／persistent vector；
 *    允許結構共享已驗證、已深層凍結的 initial 與舊 Pair，不共享任何可變物件）；
 * f. 回傳**新的**外層深層凍結 History，並加入可信集合（可繼續可信 append）。
 *
 * 不修改傳入 History、records、Pair 或 Record。
 */
export function appendP3ELedgerHistory(input: unknown): P3ELedgerHistory {
  const record = readOwnDataRecord(input);
  if (record === null) failHistory(PATH_APPEND_INPUT);
  if (!hasExactKeys(record, APPEND_KEYS)) failHistory(PATH_APPEND_INPUT);

  // a. 可信 history → 增量快速路徑；其他 → 完整 O(n) 驗證。
  //    局部命名 `ledger`／`rawHistory`（避開 DOM/BOM 全域 `history`）。
  const rawHistory = record.get("history");
  const ledger = isTrustedHistory(rawHistory)
    ? rawHistory
    : readP3ELedgerHistory(rawHistory);

  // b. 驗證 previousState（正式原語；錯誤原樣外拋）。
  const previousState = readP3EState(record.get("previousState"));

  // c. previousState 必須與 History 目前尾端完全一致。
  assertTailMatch(ledger, previousState);

  // d. Ledger Continuity（正式原語；內部自行重驗三份資料，錯誤原樣外拋）。
  const facts = validateP3ELedgerContinuity({
    previousState,
    commandRecord: record.get("commandRecord"),
    yearRecord: record.get("yearRecord")
  });

  // e + f. append 已驗證的 Pair，回傳新的深層凍結 History（加入可信集合）。
  const pair: P3ELedgerHistoryRecordPair = Object.freeze({
    commandRecord: facts.commandRecord,
    yearRecord: facts.yearRecord
  });
  const records: P3ELedgerHistoryRecordPair[] = [...ledger.records, pair];
  const next = Object.freeze({ initial: ledger.initial, records: Object.freeze(records) });
  trustedHistories.add(next);
  return next;
}
