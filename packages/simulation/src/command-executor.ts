import {
  P3E_LIFE_FOCUS_FIRST_AGE,
  readP3ELifeFocus,
  type P3ELifeState
} from "@life-sim/contracts";
import { P3EError } from "./errors";
import { readP3EState } from "./state-invariants";
import { readP3ECommand } from "./command-envelope";
import { resolveP3EAnnualPendingDecision } from "./pending-decision-persistence";
import { resolveP3EDecisionChoice } from "./decision-choice-effects";
import {
  assembleP3EAnnualStateCoreDraft,
  assembleP3EDecisionStateCoreDraft,
  assembleP3ELifeFocusStateCoreDraft
} from "./state-core-draft";
import {
  appendP3ELedgerTransition,
  type P3ELedgerAppendResult
} from "./ledger-append";
import {
  buildP3EAdvanceYearOutcome,
  buildP3EChooseDecisionOutcome,
  buildP3ESetLifeFocusOutcome,
  type P3ECommandOutcome
} from "./command-outcome";

/**
 * P3-E Command Executor V1（正式主線，H5-CTO-163-A 整合；H5-CTO-173-A 加入 outcome）。
 *
 * 來源：WorkBuddy 候選 `command-executor-v1-candidate.ts`
 * （SHA-256 `32aed09d72b37bb89e709ac7d277787fbd9da3865265756f6c84f62ef371362f`，
 * 經 H5-CTO-153-B 核准、H5-CTO-163-A 正式整合；H5-CTO-173-A 只在尾端追加 `outcome`）。
 *
 * ```ts
 * executeP3ECommand(input: unknown): P3ECommandExecutionResult
 * // { state, commandRecord, yearRecord, outcome }
 * ```
 *
 * input 是 **exact-object 四欄**：`state`／`eventPack`／`deathPack`／`command`。
 * 前三項 `state`／`commandRecord`／`yearRecord` 與 Ledger Append V1 **完全相同**
 * （逐位元不變、深層凍結、與輸入零共享）；第四項 `outcome` 是呈現用結果，
 * 只從同一次已驗證的 stage 建立，不重跑任何模擬步驟。
 *
 * ## 這個模組證明什麼
 *
 * 給定「一個合法 State、綁定一致的 event／death pack、一筆 command」，本模組
 * 執行**一整個命令交易**：
 *
 * - `ADVANCE_YEAR`：年度 Roll → 事件抽選 → effects → 死亡判定 → pending 摘要 →
 *   Core Draft → Ledger Append；
 * - `CHOOSE_DECISION`：option effects → Core Draft → Ledger Append。
 *
 * 全部業務計算都由正式原語完成，本模組只做**編排**。
 *
 * ## 這個模組**不**證明（固定責任邊界）
 *
 * - 不複製或重寫 Roll／RNG／事件抽選／effects／mortality／pending summary／
 *   Core Draft 組裝／State Hash／Ledger Hash／Record 建立／Continuity；
 * - 不建立 Codec／Replay；
 * - 不修改公開 barrel（`packages/simulation/src/index.ts`）；
 * - 不接受外部 stage、coreDraft、material、Command Record、Year Record 或任何
 *   預先計算的 hash——這些全部由本模組在交易內即時產生；
 * - 不修改正式共用資料夾。
 *
 * ## 固定執行順序
 *
 * 1. input 層：descriptor-only exact-object 四欄（失敗 → `E_P3E_ARGUMENT at
 *    commandExecution.input`）；
 * 2. `readP3EState(state)`；
 * 3. `readP3ECommand(command)`；
 * 4. 依 `command.type` 分派：
 *    - `ADVANCE_YEAR` → `resolveP3EAnnualPendingDecision` →
 *      `assembleP3EAnnualStateCoreDraft` → `appendP3ELedgerTransition`；
 *    - `CHOOSE_DECISION` → `resolveP3EDecisionChoice` →
 *      `assembleP3EDecisionStateCoreDraft` → `appendP3ELedgerTransition`。
 *
 * 底層正式原語發出的 `P3EError` **原樣外傳**（不統一重包）；input 層的反射失敗
 * （revoked Proxy、trap 拋錯、accessor、hidden／symbol／多欄／少欄、陣列、
 * class instance、非 plain prototype）折成固定的
 * `E_P3E_ARGUMENT at commandExecution.input`；不外洩 `TypeError`／`RangeError`／
 * `SyntaxError`。
 *
 * ## 收支語意（2g 基線）
 *
 * 本模組同步了 2g 已核准的 `state-invariants.ts`（年度收支不再必須等於基準公式），
 * 因此決策選項（如 `rent`：`annualExpenseMicroUsd` +9,000,000）與年度事件的
 * money effects 都會**原樣保留**在最終 State——不得把 effects 後收支改回基準公式。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/**
 * 輸出型別（P3-E.1b-2m 起）：前三項與 Ledger Append V1 **完全相同**，
 * 第四項 `outcome` 是本次命令的呈現結果。
 *
 * 前三項的內容、深層凍結與零共享語意不因 `outcome` 而改變。
 */
export interface P3ECommandExecutionResult extends P3ELedgerAppendResult {
  /** 本次命令的呈現結果（獨立、深層凍結；不含任何內部 stage 資料）。 */
  readonly outcome: P3ECommandOutcome;
}

/** 呈現結果型別：由 `command-executor` 統一再匯出（barrel 不直接依賴 outcome 模組）。 */
export type {
  P3EAdvanceYearOutcome,
  P3EChooseDecisionOutcome,
  P3ESetLifeFocusOutcome,
  P3ECommandOutcome
} from "./command-outcome";

/* ------------------------------------------------------------------ */
/* 固定錯誤路徑                                                             */
/* ------------------------------------------------------------------ */

const INPUT_KEYS = ["state", "eventPack", "deathPack", "command"] as const;
const PATH_INPUT = "commandExecution.input";

function failInput(): never {
  throw new P3EError("E_P3E_ARGUMENT", PATH_INPUT);
}

/* ------------------------------------------------------------------ */
/* 信任邊界：input 的 descriptor-only exact-object 讀取                  */
/* ------------------------------------------------------------------ */

/**
 * input 層：exact-object 四欄，只讀 descriptor。
 *
 * - accessor（getter／setter）**不會被執行**（只取 data property 的 `value`）；
 * - symbol 鍵、不可列舉的額外欄位、多欄、少欄、改名 → 拒絕；
 * - 陣列、class instance、非 plain prototype → 拒絕；
 * - 任何反射失敗（revoked Proxy、trap 拋錯）→ 折成
 *   `E_P3E_ARGUMENT at commandExecution.input`。
 *
 * 這一步**不是**業務驗證：`state`／`command`／兩個 pack 的合法性全部交給後續的
 * 正式原語（`readP3EState`／`readP3ECommand`／pack 驗證）把關。
 */
function readInput(input: unknown): {
  readonly state: unknown;
  readonly eventPack: unknown;
  readonly deathPack: unknown;
  readonly command: unknown;
} {
  let record: {
    state: unknown;
    eventPack: unknown;
    deathPack: unknown;
    command: unknown;
  } | null = null;
  try {
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const proto = Object.getPrototypeOf(input) as object | null;
      if (proto === Object.prototype || proto === null) {
        if (Object.getOwnPropertySymbols(input).length === 0) {
          const names = Object.getOwnPropertyNames(input);
          if (names.length === INPUT_KEYS.length && Object.keys(input).length === INPUT_KEYS.length) {
            const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            let complete = true;
            for (const key of INPUT_KEYS) {
              if (!names.includes(key)) {
                complete = false;
                break;
              }
              const descriptor = Object.getOwnPropertyDescriptor(input, key);
              if (descriptor === undefined || !("value" in descriptor)) {
                complete = false;
                break;
              }
              values[key] = descriptor.value;
            }
            if (complete) {
              record = {
                state: values.state,
                eventPack: values.eventPack,
                deathPack: values.deathPack,
                command: values.command
              };
            }
          }
        }
      }
    }
  } catch {
    record = null;
  }
  if (record === null) failInput();
  return record;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把 Append V1 的三項結果與 outcome 包成凍結的四項輸出。
 *
 * 前三項**原樣轉出**（同一個凍結物件參考），只有外層包裝與 `outcome` 是本模組新建的。
 */
function sealCommandResult(
  base: P3ELedgerAppendResult,
  outcome: P3ECommandOutcome
): P3ECommandExecutionResult {
  return Object.freeze({
    state: base.state,
    commandRecord: base.commandRecord,
    yearRecord: base.yearRecord,
    outcome
  });
}

/**
 * 執行一次完整的命令交易。
 *
 * 失敗時**不回傳任何部分結果**：整個交易要嘛四項全部建立，要嘛拋出 `P3EError`。
 * 前三項與 Ledger Append V1 完全相同（深層凍結、與輸入零共享）；
 * 第四項 `outcome` 由已驗證的 stage 建立，同樣深層凍結、且與 stage 零共享。
 */
export function executeP3ECommand(input: unknown): P3ECommandExecutionResult {
  // 1. input 層：descriptor-only exact-object 四欄
  const raw = readInput(input);

  // 2. 驗證 State（正式原語；錯誤原樣外傳）
  const state: P3ELifeState = readP3EState(raw.state);

  // 3. 驗證 Command（正式原語；錯誤原樣外傳）
  const command = readP3ECommand(raw.command);

  // 4. 依命令類型分派（readP3ECommand 保證 type 只有這兩種）
  if (command.type === "ADVANCE_YEAR") {
    // 年度路徑：Roll → 事件抽選 → effects → 死亡判定 → pending 摘要
    //（不接受任何外部中間結果；全部由 resolveP3EAnnualPendingDecision 內部重跑）
    const stage = resolveP3EAnnualPendingDecision({
      state,
      eventPack: raw.eventPack,
      deathPack: raw.deathPack,
      contentMode: command.contentMode
    });
    const coreDraft = assembleP3EAnnualStateCoreDraft(state, stage);
    const outcome = buildP3EAdvanceYearOutcome(stage);
    return sealCommandResult(appendP3ELedgerTransition(state, command, coreDraft), outcome);
  }

  if (command.type === "SET_LIFE_FOCUS") {
    // 重心路徑（GPT-0029-B）：只換 focus flag，不推進模擬年。
    // 門檻全部落在正式 State 上，replay 用同一筆 command 會得到相同結果。
    if (state.age < P3E_LIFE_FOCUS_FIRST_AGE) {
      throw new P3EError("E_P3E_COMMAND", "commandExecution.lifeFocus.age");
    }
    if (state.phase !== "life") {
      throw new P3EError("E_P3E_PHASE", "commandExecution.lifeFocus.phase");
    }
    const current = readP3ELifeFocus(state.flags);
    if (current !== null && current.changedYear === state.currentYear) {
      // 同一個模擬年至多更改一次。
      throw new P3EError("E_P3E_COMMAND", "commandExecution.lifeFocus.yearLimit");
    }
    const coreDraft = assembleP3ELifeFocusStateCoreDraft(state, command.focusId, state.currentYear);
    const outcome = buildP3ESetLifeFocusOutcome(command.focusId, state.currentYear);
    return sealCommandResult(appendP3ELedgerTransition(state, command, coreDraft), outcome);
  }

  // 決策路徑：以 pending State 為基底套用 option effects
  const stage = resolveP3EDecisionChoice({
    state,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack,
    optionId: command.optionId
  });
  const coreDraft = assembleP3EDecisionStateCoreDraft(state, stage);
  const outcome = buildP3EChooseDecisionOutcome(stage);
  return sealCommandResult(appendP3ELedgerTransition(state, command, coreDraft), outcome);
}
