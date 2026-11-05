import type { P3CYearEventOutcome } from "@life-sim/contracts";
import type { P3EAnnualPendingDecisionStage } from "./pending-decision-persistence";
import type { P3EDecisionChoiceStage } from "./decision-choice-effects";
import type { P3EPendingDecision } from "./annual-event-effects";

/**
 * P3-E.1b-2m：Command Presentation Outcome V1（H5-CTO-173-A）。
 *
 * 把**已驗證的內部 stage**（`resolveP3EAnnualPendingDecision`／`resolveP3EDecisionChoice`
 * 的回傳值）轉成一份**獨立、深層凍結**的呈現用 outcome，供 application／UI 顯示。
 *
 * ## 輸入邊界
 *
 * - 只接受**已經驗證過**的內部 stage；本模組**不**驗證 input、state、pack 或 binding。
 * - **不**重跑 Roll／事件抽選／死亡／effects；**不**計算任何 hash；**不**讀取或回傳
 *   pack、候選清單、RNG 游標、mortality draw 或選項 effects。
 *
 * ## 輸出邊界
 *
 * - 全部欄位都是新建立的獨立副本（不與 stage 共享可變參考）；輸出深層凍結。
 * - `pendingDecision` 只保留顯示所需欄位（`eventId`／`decisionId`／`promptKey`／
 *   `selectionHash`／`options[{optionId,labelKey}]`），**不含**任何選項 effects。
 * - `changes` 是 `P3CYearEventOutcome` 的獨立副本（stat／money delta ＋ flag 增減），
 *   不含任何 ledger hash。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 年度事件抽選原因（與 P3-B 的 `P3BSelectionReason` 相同）。 */
export type P3ESelectionReason = "no_candidates" | "single_candidate" | "weighted" | "age_out_of_range";

/** 死亡結果（只保留呈現需要的 reason 與 causeId）。 */
export interface P3EAdvanceYearDeathOutcome {
  readonly reason: "mortality" | "age_ceiling";
  readonly causeId: string | null;
}

/** 待決策的顯示資訊（不含選項 effects）。 */
export interface P3EOutcomeDecisionOption {
  readonly optionId: string;
  readonly labelKey: string;
}

/** 待決策的顯示摘要（不含選項 effects、不含完整 event）。 */
export interface P3EOutcomePendingDecision {
  readonly eventId: string;
  readonly decisionId: string;
  readonly promptKey: string;
  readonly selectionHash: string;
  readonly options: readonly P3EOutcomeDecisionOption[];
}

/** `ADVANCE_YEAR` 的呈現結果。 */
export interface P3EAdvanceYearOutcome {
  readonly kind: "advance_year";
  readonly contentMode: "standard" | "guardian";
  readonly selectedEventId: string | null;
  readonly selectionReason: P3ESelectionReason;
  readonly selectionHash: string;
  readonly changes: P3CYearEventOutcome;
  readonly pendingDecision: P3EOutcomePendingDecision | null;
  readonly death: P3EAdvanceYearDeathOutcome | null;
}

/** `CHOOSE_DECISION` 的呈現結果。 */
export interface P3EChooseDecisionOutcome {
  readonly kind: "choose_decision";
  readonly eventId: string;
  readonly decisionId: string;
  readonly selectedOptionId: string;
  readonly changes: P3CYearEventOutcome;
  readonly informational: boolean;
}

/** 一次命令交易的呈現結果。 */
export type P3ECommandOutcome = P3EAdvanceYearOutcome | P3EChooseDecisionOutcome;

/* ------------------------------------------------------------------ */
/* 深層凍結與獨立副本                                                  */
/* ------------------------------------------------------------------ */

/** 遞迴凍結（stage 已凍結；這裡只保證本模組新建的物件也被凍結）。 */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** `P3CYearEventOutcome` 的獨立副本（陣列也複製，不與 stage 共享）。 */
function copyChanges(changes: P3CYearEventOutcome): P3CYearEventOutcome {
  return {
    statDelta: {
      health: changes.statDelta.health,
      happiness: changes.statDelta.happiness,
      knowledge: changes.statDelta.knowledge,
      relationships: changes.statDelta.relationships
    },
    moneyDelta: {
      balanceMicroUsd: changes.moneyDelta.balanceMicroUsd,
      annualIncomeMicroUsd: changes.moneyDelta.annualIncomeMicroUsd,
      annualExpenseMicroUsd: changes.moneyDelta.annualExpenseMicroUsd
    },
    flagsAdded: [...changes.flagsAdded],
    flagsRemoved: [...changes.flagsRemoved],
    informational: changes.informational,
    openedDecisionId: changes.openedDecisionId
  };
}

/** 待決策事實 → 顯示摘要（**去掉**每個 option 的 effects）。 */
function copyPendingDecision(pending: P3EPendingDecision): P3EOutcomePendingDecision {
  return {
    eventId: pending.eventId,
    decisionId: pending.decisionId,
    promptKey: pending.promptKey,
    selectionHash: pending.selectionHash,
    options: pending.options.map((option) => ({
      optionId: option.optionId,
      labelKey: option.labelKey
    }))
  };
}

/** 死亡事實 → 呈現結果（age ceiling 的 causeId 固定為 null）。 */
function copyDeath(
  stage: P3EAnnualPendingDecisionStage["annualDeath"]
): P3EAdvanceYearDeathOutcome | null {
  if (!stage.diedThisYear || stage.deathReason === null) return null;
  if (stage.deathReason === "age_ceiling") return { reason: "age_ceiling", causeId: null };
  return { reason: "mortality", causeId: stage.mortality.causeId };
}

/* ------------------------------------------------------------------ */
/* 兩個建立器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 由**年度** stage 建立 `ADVANCE_YEAR` 的呈現結果。
 *
 * 只讀 `stage.annualDeath` 的既有事實：不重跑任何模擬步驟、不重新抽選、不重算 hash。
 */
export function buildP3EAdvanceYearOutcome(
  stage: P3EAnnualPendingDecisionStage
): P3EAdvanceYearOutcome {
  const annual = stage.annualDeath;
  const effects = annual.effects;
  const pendingFacts = annual.pendingDecisionAfterDeath;

  return deepFreeze({
    kind: "advance_year" as const,
    contentMode: effects.selection.contentMode,
    selectedEventId: effects.selectedEventId,
    selectionReason: effects.selection.reason,
    selectionHash: effects.selection.selectionHash,
    changes: copyChanges(effects.changes),
    pendingDecision: pendingFacts === null ? null : copyPendingDecision(pendingFacts),
    death: copyDeath(annual)
  });
}

/**
 * 由**決策** stage 建立 `CHOOSE_DECISION` 的呈現結果。
 *
 * 只讀 `stage` 的既有事實：不重跑 effects、不重算 hash、不回傳任何 option effects。
 */
export function buildP3EChooseDecisionOutcome(
  stage: P3EDecisionChoiceStage
): P3EChooseDecisionOutcome {
  return deepFreeze({
    kind: "choose_decision" as const,
    eventId: stage.eventId,
    decisionId: stage.decisionId,
    selectedOptionId: stage.selectedOptionId,
    changes: copyChanges(stage.changes),
    informational: stage.informational
  });
}
