import type { P3ELifeState } from "@life-sim/contracts";
import { normalizeSeed, seedHash } from "@life-sim/engine";
import { P3EError } from "./errors";
import { encodeP3EState, decodeP3EState } from "./codec";
import {
  encodeP3ELedgerRecordPair,
  decodeP3ELedgerRecordPair
} from "./ledger-record-codec";
import { readP3ELedgerHistory, type P3ELedgerHistory } from "./ledger-history";

/**
 * H5-CTO-182-A：P3-E Session Payload Codec V1（正式主線整合；不進公開 barrel）。
 *
 * 來源：WorkBuddy 候選 `p3e-session-payload-codec-v1-candidate.ts`（H5-CTO-179-B）
 * （SHA-256 `dae3335af6fafc9dace38167c8957edc15300dbd57bbc9c849ced76817aeb063`，
 * 經 H5-CTO-182-A 正式整合；來源語意與測試全部保留）。
 *
 * ```ts
 * encodeP3ESessionPayload(input: unknown): string
 * decodeP3ESessionPayload(input: unknown): P3ESessionPayloadV1
 * ```
 *
 * 一個 Session Payload 把「masterSeed ＋ 已驗證 State ＋ 完整 Ledger History」
 * 綁成單一 canonical JSON 字串（wire 固定四欄、固定順序：
 * `formatVersion` → `masterSeed` → `state` → `history`）。
 *
 * ## 決定性
 *
 * - 輸出是**單一 canonical JSON 字串**：固定鍵序、無空白、無 timestamp／nonce／
 *   saveId／revision／metadata；
 * - `state` 欄位由正式 State Codec 的 canonical 投影（`encodeP3EState`）逐位元
 *   決定；`history.records` 每一筆都是正式 Pair Codec 的 canonical envelope
 *   （`encodeP3ELedgerRecordPair`），本模組**零重寫**任何投影；
 * - 相同輸入重複 `encode` 必須 byte-identical；
 *   `encode(decode(encode(x))) === encode(x)` 逐位元成立。
 *
 * ## Binding（payload 的五個一致性條件，全部通過才算合法 session）
 *
 * 1. `normalizeSeed(masterSeed) === masterSeed`（儲存的 seed 已是正規形式）；
 * 2. `seedHash(masterSeed) === state.identity.masterSeedHash`（seed 綁定 state）；
 * 3. `state.commandLog.count === history.records.length`；
 * 4. 空 History：`state.stateHash`／`commandLog.headHash`／`heads.hashChain`
 *    等於 `history.initial` 三欄；
 * 5. 非空 History：`stateHash`、`commandHeadHash`、`heads.lastSnapshotHash`／
 *    `lastDeltaHash`／`lastEntryHash`、`heads.hashChain` 與尾端 Pair 完全相等。
 *
 * ## 必須重用的原語（reuse_do_not_reimplement）
 *
 * - `encodeP3EState`／`decodeP3EState`（`./codec`）
 * - `encodeP3ELedgerRecordPair`／`decodeP3ELedgerRecordPair`（`./ledger-record-codec`）
 * - `readP3ELedgerHistory`（`./ledger-history`）
 * - `normalizeSeed`／`seedHash`（`@life-sim/engine`）
 *
 * 正式原語自己發出的 `P3EError` **原樣往外拋**（不吞掉、不重包、不換 path）；
 * 只有「payload 自身的 shape／欄位／binding 錯誤」使用本模組固定的
 * `p3eSessionPayload.*` 路徑。`normalizeSeed` 的 `SeedError` 不是 `P3EError`，
 * 由本模組折成 `E_P3E_CODEC at p3eSessionPayload.masterSeed`。
 *
 * ## 信任邊界（trust ＋ boundary）
 *
 * - **decoded state 是「宣稱的快照」而非 replay authority**：decoder 只驗證
 *   codec／history／tail binding；業務真相必須由上層應用載入後另行 replay
 *   （`replayP3ELedgerHistory`）才能接受——本模組**不**執行 replay；
 * - decode 只接受**字串**；長度上限（`P3E_SESSION_PAYLOAD_MAX_LENGTH`）
 *   **在 `JSON.parse` 之前**檢查；
 * - `JSON.parse` 後做任意層級 pollution key 掃描
 *   （`__proto__`／`constructor`／`prototype`）；
 * - encode 輸入是 **exact-object descriptor 讀取**：只接受 own enumerable
 *   data property，accessor／getter **永不執行**；missing／extra／renamed／
 *   hidden／symbol／exotic prototype／sparse array 一律拒絕；
 * - 輸出**深層凍結**、與輸入**零共享**（state 與 history 全部由本模組自身的
 *   解析／驗證結果組成）、**不修改任何輸入**；
 * - 錯誤一律是品牌化 `P3EError`（穩定 code＋path），不外洩
 *   `SyntaxError`／`TypeError`／`RangeError`。
 *
 * ## 刻意不做
 *
 * - **不**執行 replay、**不**執行命令、**不**重算或修正任何 hash、
 *   **不**重寫任何 record/state/history 驗證演算法；
 * - **不**做壓縮／localStorage／任何儲存；**不**碰 Application／UI；
 * - **不**內嵌 event/death pack（pack binding 已由 state 的 identity／packs
 *   欄位與 seedHash binding 承擔）；
 * - encode 輸出**不**另設長度上限分支：records ≤ 4096 且每筆 Pair envelope
 *   ≤ 1MiB、state wire 遠小於 1MiB，合法輸出的上限約 10.5MiB，
 *   **低於** 16MiB——16MiB 上限由 decode 邊界執行（見風險文件）；
 * - **不**進公開 barrel。
 */

/* ------------------------------------------------------------------ */
/* 格式常數                                                            */
/* ------------------------------------------------------------------ */

/** 本格式的固定版本（wire 中的數字型別）。 */
export const P3E_SESSION_PAYLOAD_FORMAT_VERSION = 6 as const;

/** 解碼輸入的字串長度上限（UTF-16 code units；在 `JSON.parse` 之前檢查）。 */
export const P3E_SESSION_PAYLOAD_MAX_LENGTH = 16_777_216;

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 已驗證、深層凍結的 Session Payload（decoded state 是宣稱的快照，非 replay authority）。 */
export interface P3ESessionPayloadV1 {
  readonly formatVersion: typeof P3E_SESSION_PAYLOAD_FORMAT_VERSION;
  readonly masterSeed: string;
  readonly state: P3ELifeState;
  /* 引號屬性名：`history` 撞 BOM 全域掃描名單（PropertySignature 屬性名不在
   * 該掃描器的參考位置排除清單），字面量形式語意相同且不再被誤判。 */
  readonly "history": P3ELedgerHistory;
}

/**
 * Binding 檢查所需的 state 欄位（`P3ELifeState` 與「已通過 `encodeP3EState`
 * 的 canonical 投影」都滿足此形狀；金額型別差異不影響 binding 比較）。
 */
interface SessionBindingFields {
  readonly stateHash: string;
  readonly identity: { readonly masterSeedHash: string };
  readonly commandLog: { readonly count: number; readonly headHash: string };
  readonly heads: {
    readonly hashChain: string;
    readonly lastSnapshotHash: string;
    readonly lastDeltaHash: string;
    readonly lastEntryHash: string;
  };
}

/** 尾端 Pair 在 binding 比較中實際讀取的欄位（兩份正式 Record 都滿足此形狀）。 */
interface TailPairFields {
  readonly commandRecord: { readonly commandHash: string };
  readonly yearRecord: {
    readonly stateHashAfter: string;
    readonly chainHash: string;
    readonly snapshotHash: string;
    readonly deltaHash: string;
    readonly entryHash: string;
  };
}

/* ------------------------------------------------------------------ */
/* 常數                                                                */
/* ------------------------------------------------------------------ */

/** encode 輸入的三欄（descriptor 讀取，順序不敏感、數量與鍵名精確）。 */
const INPUT_KEYS = ["masterSeed", "state", "history"] as const;

/** wire 的固定四欄（decode 頂層檢查；encode 以此順序輸出）。 */
const WIRE_KEYS = ["formatVersion", "masterSeed", "state", "history"] as const;

/** wire 中 history 容器的兩欄（其餘 shape 交給 `readP3ELedgerHistory`）。 */
const HISTORY_CONTAINER_KEYS = ["initial", "records"] as const;

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/* ------------------------------------------------------------------ */
/* 錯誤（固定錯誤路徑；全部 E_P3E_CODEC）                               */
/* ------------------------------------------------------------------ */

/** 頂層 shape（非字串／超長／壞 JSON／pollution／非 exact-object 欄位）。 */
const PATH_INPUT = "p3eSessionPayload.input";
/** `formatVersion` 不是數字 6。 */
const PATH_FORMAT_VERSION = "p3eSessionPayload.formatVersion";
/** `masterSeed` 非字串、未正規化或 normalizeSeed 拒絕。 */
const PATH_MASTER_SEED = "p3eSessionPayload.masterSeed";
/** history 容器（decode：非 exact-object {initial, records} 或 records 非陣列）。 */
const PATH_HISTORY = "p3eSessionPayload.history";
/** `seedHash(masterSeed) !== state.identity.masterSeedHash`。 */
const PATH_BINDING_SEED_HASH = "p3eSessionPayload.binding.seedHash";
/** `state.commandLog.count !== history.records.length`。 */
const PATH_BINDING_COUNT = "p3eSessionPayload.binding.count";
/** 空 History 時三個 anchor 不相等。 */
const PATH_BINDING_EMPTY_ANCHOR = "p3eSessionPayload.binding.emptyAnchor";
/** 非空 History 時六個尾端 head 不相等。 */
const PATH_BINDING_TAIL = "p3eSessionPayload.binding.tail";

function failCodec(path: string): never {
  throw new P3EError("E_P3E_CODEC", path);
}

/* ------------------------------------------------------------------ */
/* 信任邊界：exact-object descriptor 讀取（getter 永不執行）             */
/* ------------------------------------------------------------------ */

/**
 * 把輸入讀成「自有、可列舉、全部是 data property」的鍵值集合。
 *
 * 任何反射失敗（revoked Proxy、trap 拋錯、symbol 鍵、不可列舉鍵、accessor／
 * getter、陣列、非 Object prototype）都回 `null`，呼叫端再折成固定 `P3EError`；
 * 因為只用 `getOwnPropertyDescriptor` 取值，**呼叫端的 getter 永遠不會被執行**。
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

/** 確認 descriptor 鍵值集合恰好包含 `expected`（不多、不少）。 */
function hasExactMapKeys(record: ReadonlyMap<string, unknown>, expected: readonly string[]): boolean {
  if (record.size !== expected.length) return false;
  for (const key of expected) {
    if (!record.has(key)) return false;
  }
  return true;
}

/** JSON 解析後的 plain object（污染鍵由 `hasNoPollution` 負責）。 */
function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasExactRecordKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
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
 * 逐層走物件與陣列，任何一層命中就回 `false`。
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

/** 深層凍結（輸入來自 JSON.parse，無循環參照）。 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    deepFreeze(record[key]);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* masterSeed 讀取（normalizeSeed 原語；SeedError 折成 E_P3E_CODEC）     */
/* ------------------------------------------------------------------ */

/**
 * masterSeed 必須是字串，且 `normalizeSeed(masterSeed) === masterSeed`
 * （儲存的 seed 已是正規形式；未正規化的輸入——如帶空白或非 NFC——一律拒絕）。
 * `normalizeSeed` 的 `SeedError` 不是 `P3EError`，在此折成固定路徑。
 */
function readMasterSeed(value: unknown): string {
  if (typeof value !== "string") failCodec(PATH_MASTER_SEED);
  let normalizedEqualsInput = true;
  try {
    normalizedEqualsInput = normalizeSeed(value) === value;
  } catch {
    normalizedEqualsInput = false;
  }
  if (!normalizedEqualsInput) failCodec(PATH_MASTER_SEED);
  return value;
}

/* ------------------------------------------------------------------ */
/* Binding（payload 五個一致性條件）                                    */
/* ------------------------------------------------------------------ */

/**
 * 驗證 masterSeed ↔ state ↔ history 的五個 binding 條件（固定順序：
 * seedHash → count → 空 anchor／非空尾端）。全部通過後 payload 才算合法。
 */
function assertPayloadBindings(
  masterSeed: string,
  state: SessionBindingFields,
  ledger: P3ELedgerHistory
): void {
  if (seedHash(masterSeed) !== state.identity.masterSeedHash) failCodec(PATH_BINDING_SEED_HASH);
  if (state.commandLog.count !== ledger.records.length) failCodec(PATH_BINDING_COUNT);

  if (ledger.records.length === 0) {
    if (
      state.stateHash !== ledger.initial.stateHash ||
      state.commandLog.headHash !== ledger.initial.commandHeadHash ||
      state.heads.hashChain !== ledger.initial.chainHash
    ) {
      failCodec(PATH_BINDING_EMPTY_ANCHOR);
    }
    return;
  }

  const tail = ledger.records[ledger.records.length - 1] as unknown as TailPairFields;
  if (
    state.stateHash !== tail.yearRecord.stateHashAfter ||
    state.commandLog.headHash !== tail.commandRecord.commandHash ||
    state.heads.hashChain !== tail.yearRecord.chainHash ||
    state.heads.lastSnapshotHash !== tail.yearRecord.snapshotHash ||
    state.heads.lastDeltaHash !== tail.yearRecord.deltaHash ||
    state.heads.lastEntryHash !== tail.yearRecord.entryHash
  ) {
    failCodec(PATH_BINDING_TAIL);
  }
}

/* ------------------------------------------------------------------ */
/* History wire（encode：容器投影；decode：envelope 逐筆解碼）           */
/* ------------------------------------------------------------------ */

/**
 * encode 的 history 容器投影：`initial` 三欄手寫（固定順序
 * `stateHash` → `commandHeadHash` → `chainHash`）、`records` 每筆都是
 * 正式 Pair Codec 的 canonical envelope 原樣嵌入（`JSON.parse` 保留鍵序，
 * 本模組零重寫任何 Pair 投影）。
 */
function historyWireProjection(ledger: P3ELedgerHistory): unknown {
  return {
    initial: {
      stateHash: ledger.initial.stateHash,
      commandHeadHash: ledger.initial.commandHeadHash,
      chainHash: ledger.initial.chainHash
    },
    records: ledger.records.map((pair) => JSON.parse(encodeP3ELedgerRecordPair(pair)))
  };
}

/**
 * decode 的 history 容器：exact-object 兩欄（`initial`／`records`）＋
 * `records` 必須是陣列；每筆 envelope 交給正式 Pair Codec 解碼
 * （`JSON.stringify` 的輸入是 JSON.parse 的純資料，無 getter 風險），
 * 最後由 `readP3ELedgerHistory` 做完整驗證（Pair 內部＋跨紀錄鏈結；
 * 其 `ledgerHistory.*` 錯誤路徑原樣外拋）。容器自身的錯誤固定
 * `p3eSessionPayload.history`。
 */
function readHistoryWire(value: unknown): P3ELedgerHistory {
  const container = asPlainRecord(value);
  if (container === null) failCodec(PATH_HISTORY);
  if (!hasExactRecordKeys(container, HISTORY_CONTAINER_KEYS)) {
    failCodec(PATH_HISTORY);
  }
  const initial = container.initial;
  if (typeof initial !== "object" || initial === null || Array.isArray(initial)) {
    failCodec(PATH_HISTORY);
  }
  if (!Array.isArray(container.records)) failCodec(PATH_HISTORY);
  const records = container.records.map((envelope) => decodeP3ELedgerRecordPair(JSON.stringify(envelope)));
  return readP3ELedgerHistory({ initial, records });
}

/* ------------------------------------------------------------------ */
/* Encode                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把 `{masterSeed, state, history}` 編成 canonical JSON 字串。
 *
 * 固定順序：exact-object descriptor 三欄（getter 永不執行）→ masterSeed
 * 正規形式 → `encodeP3EState`（正式原語；state 驗證錯誤原樣外拋）→
 * `readP3ELedgerHistory`（正式原語；history 驗證錯誤原樣外拋）→
 * binding 五檢 → 固定鍵序 canonical JSON。
 *
 * **不**接受預先編碼的 state/history、**不**重算或修正任何 hash、
 * **不**加 metadata、**不**修改輸入。
 */
export function encodeP3ESessionPayload(input: unknown): string {
  const record = readOwnDataRecord(input);
  if (record === null) failCodec(PATH_INPUT);
  if (!hasExactMapKeys(record, INPUT_KEYS)) failCodec(PATH_INPUT);

  const masterSeed = readMasterSeed(record.get("masterSeed"));

  // 正式 State Codec：先驗證、再取 canonical 投影（驗證錯誤原樣外拋）。
  const stateWire = encodeP3EState(record.get("state"));
  const state = JSON.parse(stateWire) as unknown as SessionBindingFields;

  // 正式 History 原語：完整驗證並回傳深層凍結快照（錯誤原樣外拋）。
  const ledger = readP3ELedgerHistory(record.get("history"));

  assertPayloadBindings(masterSeed, state, ledger);

  return JSON.stringify({
    formatVersion: P3E_SESSION_PAYLOAD_FORMAT_VERSION,
    masterSeed,
    state,
    history: historyWireProjection(ledger)
  });
}

/* ------------------------------------------------------------------ */
/* Decode                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把 canonical JSON 字串解回深層凍結、與輸入零共享的 `P3ESessionPayloadV1`。
 *
 * 固定順序：string → 長度上限（**`JSON.parse` 之前**）→ `JSON.parse` →
 * 任意層級 pollution 掃描 → 頂層 exact-object 四欄 → `formatVersion` →
 * `masterSeed` → `decodeP3EState`（正式原語；錯誤原樣外拋）→ history
 * 容器＋`readP3ELedgerHistory`（正式原語；錯誤原樣外拋）→ binding 五檢 →
 * 深層凍結輸出。
 *
 * **信任邊界**：回傳的 `state` 是「宣稱的快照」——本模組只保證 codec／
 * history／tail binding 一致，**不**執行 replay；業務真相由上層應用載入後
 * 另行重放才能接受。
 */
export function decodeP3ESessionPayload(input: unknown): P3ESessionPayloadV1 {
  if (typeof input !== "string") failCodec(PATH_INPUT);
  if (input.length > P3E_SESSION_PAYLOAD_MAX_LENGTH) failCodec(PATH_INPUT);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    failCodec(PATH_INPUT);
  }

  if (!hasNoPollution(parsed)) failCodec(PATH_INPUT);

  const record = asPlainRecord(parsed);
  if (record === null) failCodec(PATH_INPUT);
  if (!hasExactRecordKeys(record, WIRE_KEYS)) failCodec(PATH_INPUT);

  if (record.formatVersion !== P3E_SESSION_PAYLOAD_FORMAT_VERSION) failCodec(PATH_FORMAT_VERSION);
  const masterSeed = readMasterSeed(record.masterSeed);

  // 正式 State Codec：string 進、驗證過的 state 出（錯誤原樣外拋）。
  const state = decodeP3EState(JSON.stringify(record.state));

  // 正式 History 原語：容器檢查 → 逐筆 Pair envelope 解碼 → 完整驗證。
  const ledger = readHistoryWire(record.history);

  assertPayloadBindings(masterSeed, state, ledger);

  return deepFreeze({
    formatVersion: P3E_SESSION_PAYLOAD_FORMAT_VERSION,
    masterSeed,
    state,
    history: ledger
  });
}
