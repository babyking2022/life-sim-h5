import type { P3ELifeState, P3EPhase, P3ERngState } from "@life-sim/contracts";
import { P3E_MAX_COMMANDS } from "@life-sim/contracts";
import { P3EError } from "./errors";
import { readP3EState } from "./state-invariants";
import { readP3ECommandRecord, type P3ECommandRecord } from "./command-record";
import { verifyP3EYearLedgerRecord, type P3EYearLedgerRecord } from "./year-ledger-record";

/**
 * P3-E Ledger Continuity Preconditions（正式主線，H5-CTO-149-A 整合）。
 *
 * 來源：WorkBuddy 候選 `ledger-continuity-v11-candidate.ts`
 * （SHA-256 `a018a990b5a3e6b99abfd05f4248ea7a0f72451a5c8981e749bc2dff682c23b7`，
 * 經 H5-CTO-143-B-R1／H5-CTO-149-A 核准）。正式化只改檔名、字樣與註解排版；
 * **業務邏輯逐字保留**。
 *
 * ```ts
 * validateP3ELedgerContinuity(input: unknown): P3ELedgerContinuityFacts
 * ```
 *
 * ## 本版（相對 V1）的三項修正
 *
 * 1. **`yearRecord` 的輸入契約修正**：`yearRecord` 直接就是正式的 14 欄
 *    `P3EYearLedgerRecord`，**不再**要求呼叫端傳入 `yearRecord: { record: ... }`
 *    巢狀 wrapper。本模組在內部自行組出正式驗證所需的 wrapper。
 * 2. **不得執行巢狀 getter**：`raw.yearRecord` 以 descriptor 讀取後直接交給正式
 *    `verifyP3EYearLedgerRecord`；正式原語的 `readExactDataObject` 本身是
 *    descriptor-only 的，因此 `yearRecord` 上的 accessor **永遠不會被執行**，
 *    revoked Proxy 也不會外洩原生例外。
 * 3. **Command 數量上限**：正式契約 `P3E_MAX_COMMANDS = 4096`。
 *    `readP3EState` 允許 `commandLog.count` 等於 4096，但此時**不能再建立第
 *    4097 筆命令**。本層在計算下一個 index **之前**先擋下，固定回
 *    `E_P3E_HISTORY at ledgerContinuity.index`。
 *
 * ## 這個模組證明什麼
 *
 * 給定「已驗證的 previous `P3ELifeState`」、「一筆 Command Record」與「一筆 Year
 * Ledger Record」，確認**三份紀錄在連續性上前後一致**：
 *
 * 1. `index` 連續（= `previousState.commandLog.count + 1`）；
 * 2. Command 鏈接續（`prevCommandHash` = `previousState.commandLog.headHash`）；
 * 3. State 前值一致（兩份 `stateHashBefore` 都 = `previousState.stateHash`）；
 * 4. Year Chain 前值一致（`prevChainHash` = `previousState.heads.hashChain`）；
 * 5. RNG 前值逐欄一致（`rngBefore` = `previousState.rng`）；
 * 6. 命令在目前 phase 合法（`ADVANCE_YEAR`／`CHOOSE_DECISION` 各自的規則）。
 *
 * ## 這個模組**不**證明什麼（固定責任邊界）
 *
 * - 不驗證 `stateHashAfter` 是否為合法 State 轉移；
 * - 不驗證 `snapshotHash`／`deltaHash` 是否由真實 State 計算；
 * - 不驗證 `ADVANCE_YEAR` 的 `rngAfter` 是否為合法年度 RNG 轉移；
 * - 不驗證下一個 State 的 stats／assets／flags／occurrences／pendingDecision；
 * - **不做** State seal、Ledger append、Codec、Replay；
 * - **不建立**也不 seal 下一個 State。
 *
 * ## 必須重用的正式原語（不重寫其 shape／hash 驗證演算法）
 *
 * - `readP3EState`（`./state-invariants`）
 * - `readP3ECommandRecord`（`./command-record`）
 * - `verifyP3EYearLedgerRecord`（`./year-ledger-record`）
 *
 * 這三個原語自己發出的 `P3EError` **原樣往外拋**，不吞掉、不重包；
 * 只有「Continuity 自身不一致」才使用本模組的固定錯誤路徑。
 *
 * ## 輸入
 *
 * exact-object 三欄：`previousState`／`commandRecord`／`yearRecord`。
 *
 * `yearRecord` **直接就是正式的 14 欄 `P3EYearLedgerRecord`**（`index`／`year`／
 * `age`／`phase`／`stateHashBefore`／`stateHashAfter`／`rngBefore`／`rngAfter`／
 * `snapshotHash`／`deltaHash`／`entryHash`／`commandHash`／`prevChainHash`／
 * `chainHash`），**不接受** `{ record: ... }` 巢狀 wrapper。
 *
 * 本模組在內部組出正式驗證所需的 wrapper，等價於：
 *
 * ```ts
 * verifyP3EYearLedgerRecord({ record: raw.yearRecord, commandRecord })
 * ```
 *
 * 既有的 command↔year 交叉連結（index／year／前後 stateHash／commandHash）
 * **全部交給正式原語**，本模組不重寫。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 已驗證的 Continuity facts（輸出為獨立、深層凍結的快照）。 */
export interface P3ELedgerContinuityFacts {
  /** 連續性索引（= `previousState.commandLog.count + 1`）。 */
  readonly index: number;
  /** 本次命令的種類。 */
  readonly commandType: "ADVANCE_YEAR" | "CHOOSE_DECISION" | "SET_LIFE_FOCUS";
  /** 已驗證的 previous State（深層凍結快照）。 */
  readonly previousState: P3ELifeState;
  /** 已驗證的 Command Record（深層凍結快照）。 */
  readonly commandRecord: P3ECommandRecord;
  /** 已驗證的 Year Ledger Record（深層凍結快照）。 */
  readonly yearRecord: P3EYearLedgerRecord;
  /** 本次命令套用後的 phase（Year Record 的 phase）。 */
  readonly resultingPhase: P3EPhase;
}

/** Continuity 輸入的三欄。 */
interface ContinuityInput {
  readonly previousState: unknown;
  readonly commandRecord: unknown;
  readonly yearRecord: unknown;
}

const INPUT_KEYS = ["previousState", "commandRecord", "yearRecord"] as const;

/* ------------------------------------------------------------------ */
/* 固定 Continuity 錯誤路徑                                             */
/* ------------------------------------------------------------------ */

const PATH_INDEX = "ledgerContinuity.index";
const PATH_PREV_COMMAND_HASH = "ledgerContinuity.prevCommandHash";
const PATH_STATE_HASH_BEFORE = "ledgerContinuity.stateHashBefore";
const PATH_PREV_CHAIN_HASH = "ledgerContinuity.prevChainHash";
const PATH_YEAR_AGE = "ledgerContinuity.yearAge";
const PATH_RNG_BEFORE = "ledgerContinuity.rngBefore";
const PATH_RNG_AFTER = "ledgerContinuity.rngAfter";
const PATH_COMMAND = "ledgerContinuity.command";
const PATH_INPUT = "ledgerContinuity.input";

function failHistory(path: string): never {
  throw new P3EError("E_P3E_HISTORY", path);
}

function failRng(path: string): never {
  throw new P3EError("E_P3E_RNG", path);
}

function failCommand(path: string): never {
  throw new P3EError("E_P3E_COMMAND", path);
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

/** 讀成 exact-object 的三欄輸入；任一不符 → `E_P3E_HISTORY at ledgerContinuity.input`。 */
function readContinuityInput(input: unknown): ContinuityInput {
  const record = readOwnDataRecord(input);
  if (record === null) failHistory(PATH_INPUT);
  const keys = [...record.keys()];
  for (const key of INPUT_KEYS) {
    if (!keys.includes(key)) failHistory(PATH_INPUT);
  }
  if (keys.length !== INPUT_KEYS.length) failHistory(PATH_INPUT);
  return {
    previousState: record.get("previousState"),
    commandRecord: record.get("commandRecord"),
    yearRecord: record.get("yearRecord")
  };
}

/* ------------------------------------------------------------------ */
/* RNG 逐欄比對                                                        */
/* ------------------------------------------------------------------ */

/**
 * 四字 tuple 逐位元比對。
 *
 * 用「收集布林再 `every`」而不是短路鏈：兩邊的 tuple 長度都由正式原語保證是 4，
 * 因此不需要長度分支，也不會留下永遠走不到的比較迴圈。
 */
function sameWords(left: readonly number[], right: readonly number[]): boolean {
  const checks: boolean[] = [];
  for (let index = 0; index < left.length; index += 1) {
    checks.push(left[index] === right[index]);
  }
  return checks.every((value) => value);
}

/**
 * `domain` 的比對刻意放寬成 `string`：型別雖是 literal，但 runtime 值仍可能來自
 * 未驗證的輸入，**型別斷言不得代替 runtime 比對**。
 */
function sameDomain(left: string, right: string): boolean {
  return left === right;
}

/**
 * `rngBefore`／`rngAfter` 必須與 `previousState.rng` 逐欄完全一致：
 * 三個 domain、六個 tuple 的全部字位、semanticDraws／u32Draws。
 */
function sameRngState(left: P3ERngState, right: P3ERngState): boolean {
  const checks: boolean[] = [
    sameDomain(left.life.domain, right.life.domain),
    sameDomain(left.events.domain, right.events.domain),
    sameDomain(left.death.domain, right.death.domain),
    sameWords(left.life.initialState, right.life.initialState),
    sameWords(left.life.state, right.life.state),
    sameWords(left.events.initialState, right.events.initialState),
    sameWords(left.events.state, right.events.state),
    sameWords(left.death.initialState, right.death.initialState),
    sameWords(left.death.state, right.death.state),
    left.life.semanticDraws === right.life.semanticDraws,
    left.events.u32Draws === right.events.u32Draws,
    left.death.u32Draws === right.death.u32Draws
  ];
  return checks.every((value) => value);
}

/* ------------------------------------------------------------------ */
/* 輸出快照                                                            */
/* ------------------------------------------------------------------ */

/** 建立輸出快照（深層凍結、與輸入斷開）。 */
function buildFacts(facts: P3ELedgerContinuityFacts): P3ELedgerContinuityFacts {
  return Object.freeze({
    index: facts.index,
    commandType: facts.commandType,
    previousState: facts.previousState,
    commandRecord: facts.commandRecord,
    yearRecord: facts.yearRecord,
    resultingPhase: facts.resultingPhase
  });
}

/* ------------------------------------------------------------------ */
/* 命令合法性                                                          */
/* ------------------------------------------------------------------ */

/**
 * `ADVANCE_YEAR`：previous 必須還活著且未滿 120；year/age 必須各加一；
 * phase 可為 life／pending_decision／death。
 */
function checkAdvanceYear(previous: P3ELifeState, yearRecord: P3EYearLedgerRecord): void {
  if (previous.age >= 120) failCommand(PATH_COMMAND);
  if (previous.phase !== "life") failCommand(PATH_COMMAND);
  if (yearRecord.year !== previous.currentYear + 1) failHistory(PATH_YEAR_AGE);
  if (yearRecord.age !== previous.age + 1) failHistory(PATH_YEAR_AGE);
}

/** `CHOOSE_DECISION`：year/age 不變、phase 回到 life、rngAfter 完全不動。 */
function checkChooseDecision(previous: P3ELifeState, yearRecord: P3EYearLedgerRecord): void {
  if (yearRecord.year !== previous.currentYear) failHistory(PATH_YEAR_AGE);
  if (yearRecord.age !== previous.age) failHistory(PATH_YEAR_AGE);
  if (yearRecord.phase !== "life") failHistory(PATH_YEAR_AGE);
  if (!sameRngState(yearRecord.rngAfter, previous.rng)) failRng(PATH_RNG_AFTER);
}

/**
 * `SET_LIFE_FOCUS`（GPT-0029-B）：重心不是一次模擬年，所以 year／age／phase
 * 全部不變，RNG 游標也完全不動。年齡門檻與「同年至多一次」屬於業務驗證，
 * 由 `command-executor` 負責；這裡只守住 ledger 連續性。
 */
function checkSetLifeFocus(previous: P3ELifeState, yearRecord: P3EYearLedgerRecord): void {
  if (yearRecord.year !== previous.currentYear) failHistory(PATH_YEAR_AGE);
  if (yearRecord.age !== previous.age) failHistory(PATH_YEAR_AGE);
  if (yearRecord.phase !== previous.phase) failHistory(PATH_YEAR_AGE);
  if (!sameRngState(yearRecord.rngAfter, previous.rng)) failRng(PATH_RNG_AFTER);
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 驗證 Ledger Continuity 的前置條件，回傳獨立、深層凍結的已驗證 facts bundle。
 *
 * **不會**建立或 seal 下一個 State。
 */
export function validateP3ELedgerContinuity(input: unknown): P3ELedgerContinuityFacts {
  const raw = readContinuityInput(input);

  // 1. 三個正式原語：底層 P3EError 原樣往外拋（不吞掉、不重包）。
  //
  //    順序刻意是「先 command record、再 year record」：`verifyP3EYearLedgerRecord`
  //    內部會再跑一次 `readP3ECommandRecord`，但它會把該錯誤折成
  //    `yearLedgerRecord.commandRecord`。先單獨驗一次 command record，才能讓
  //    **command record 自身的**錯誤以原樣 path 外露。
  const previousState = readP3EState(raw.previousState);

  // 2. Command 數量上限（本版新增）。
  //
  //    正式契約 `P3E_MAX_COMMANDS = 4096`。`readP3EState` 允許
  //    `commandLog.count` 等於 4096，但此時**不能再建立第 4097 筆命令**。
  //    這個檢查刻意擺在**所有後續 continuity 比對之前**（也在 command record
  //    與 year record 的驗證之前），因此 count 已經滿載時不會先建立出
  //    index 4097 的紀錄。
  if (previousState.commandLog.count >= P3E_MAX_COMMANDS) failHistory(PATH_INDEX);

  const commandRecord = readP3ECommandRecord(raw.commandRecord);

  // `yearRecord` 直接就是正式的 14 欄 record；wrapper 由本模組在內部組出。
  // 正式原語的 `readExactDataObject` 是 descriptor-only 的，因此
  // `yearRecord` 上的 accessor 不會被執行、revoked Proxy 不會外洩原生例外。
  const yearRecord = verifyP3EYearLedgerRecord({
    record: raw.yearRecord,
    commandRecord
  });

  // 3. index 連續（兩份紀錄的 index 必須都是 previous 的下一個）
  const expectedIndex = previousState.commandLog.count + 1;
  if (commandRecord.index !== expectedIndex || yearRecord.index !== expectedIndex) {
    failHistory(PATH_INDEX);
  }

  // 3. Command 鏈
  if (commandRecord.prevCommandHash !== previousState.commandLog.headHash) {
    failHistory(PATH_PREV_COMMAND_HASH);
  }

  // 4. State 前值（兩處）
  if (
    commandRecord.stateHashBefore !== previousState.stateHash ||
    yearRecord.stateHashBefore !== previousState.stateHash
  ) {
    failHistory(PATH_STATE_HASH_BEFORE);
  }

  // 5. Year Chain 前值
  if (yearRecord.prevChainHash !== previousState.heads.hashChain) failHistory(PATH_PREV_CHAIN_HASH);

  // 6. RNG 前值
  if (!sameRngState(yearRecord.rngBefore, previousState.rng)) failRng(PATH_RNG_BEFORE);

  // 7. 命令合法性
  const commandType = commandRecord.command.type;
  if (commandType === "ADVANCE_YEAR") {
    checkAdvanceYear(previousState, yearRecord);
  } else if (commandType === "SET_LIFE_FOCUS") {
    checkSetLifeFocus(previousState, yearRecord);
  } else {
    // 剩下只可能是 `CHOOSE_DECISION`；`readP3ECommandRecord` 已保證沒有第四種。
    const pending = previousState.pendingDecision;
    if (previousState.phase !== "pending_decision" || pending === null) failCommand(PATH_COMMAND);
    if (!pending.optionIds.includes(commandRecord.command.optionId)) failCommand(PATH_COMMAND);
    checkChooseDecision(previousState, yearRecord);
  }

  return buildFacts({
    index: expectedIndex,
    commandType,
    previousState,
    commandRecord,
    yearRecord,
    resultingPhase: yearRecord.phase
  });
}
