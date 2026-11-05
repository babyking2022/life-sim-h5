import {
  P3B_MAX_DECISION_OPTIONS,
  type P3BDecisionSpec,
  type P3EPendingDecisionSummary,
  type P3EErrorCode
} from "@life-sim/contracts";
import type { ValidatedEventPack } from "@life-sim/engine";
import { P3EError } from "./errors";
import { validateP3EAnnualPacks } from "./annual-packs";
import { resolveP3EAnnualDeath, type P3EAnnualDeathStage } from "./annual-death";
import type { P3EPendingDecision } from "./annual-event-effects";

/**
 * Pending decision → `p3e-2` State 摘要的轉接層（H5-CTO-110-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * resolveP3EAnnualPendingDecision(input: unknown): P3EAnnualPendingDecisionStage
 * ```
 *
 * 把 `resolveP3EAnnualDeath` 產生的完整 pending decision **事實**轉成 State 需要的
 * `P3EPendingDecisionSummary`，並用**同一份**已驗證事件包重新確認
 * `eventId`／`decisionId`／`optionIds`（含順序與數量）。
 *
 * ## 刻意不做
 *
 * - 不建立、不修改、不 seal 下一個 `P3ELifeState`；不產生或修改 Ledger／Command／Chain。
 * - 不接受呼叫端傳入 roll／selection／effects／death stage／pending decision 中間結果：
 *   一律重新呼叫 `resolveP3EAnnualDeath`。
 * - **不複製**任何事件抽選、effects、死亡判定或 RNG 演算法（本檔只做形狀轉換與比對）。
 * - 摘要只放六欄；prompt／label／effects／完整 event 一律不進來。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 年度死亡階段 ＋ 可持久化的 pending decision 摘要。 */
export interface P3EAnnualPendingDecisionStage {
  /** 完整、深層凍結的年度死亡階段（來自 `resolveP3EAnnualDeath`）。 */
  readonly annualDeath: P3EAnnualDeathStage;
  /** `p3e-2` State 用的摘要；死亡／age ceiling／沒有 decision 時為 `null`。 */
  readonly pendingDecisionSummary: P3EPendingDecisionSummary | null;
}

const INPUT_KEYS = ["state", "eventPack", "deathPack", "contentMode"] as const;

/** 合法 pack 的 decision options 數量下界（P3-B 的 `readDecisionSpec` 要求 ≥ 2）。 */
const MIN_PACK_OPTIONS = 2;

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function fail(code: P3EErrorCode, path: string): never {
  throw new P3EError(code, path);
}

/* ------------------------------------------------------------------ */
/* 1. input shape                                                      */
/* ------------------------------------------------------------------ */

/**
 * exact-object 四欄；任何反射失敗（已撤銷 Proxy、trap 拋錯、accessor、hidden／symbol／
 * 多餘／缺少／改名欄位、陣列、class instance、非 plain prototype）一律
 * `E_P3E_ARGUMENT at input`。只讀 descriptor：getter 不會被執行。
 */
function readRawInput(input: unknown): Record<string, unknown> {
  let record: Record<string, unknown> | null = null;
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
            if (complete) record = values;
          }
        }
      }
    }
  } catch {
    record = null;
  }
  if (record === null) fail("E_P3E_ARGUMENT", "input");
  return record;
}

/* ------------------------------------------------------------------ */
/* Summary 建立（seam）                                                */
/* ------------------------------------------------------------------ */

/** pack 內的 option 順序（呼叫端已保證 `decision !== null`；這裡只驗證數量與唯一性）。 */
function packDecisionOptions(decision: P3BDecisionSpec): readonly string[] {
  const optionIds = decision.options.map((option) => option.optionId);
  if (optionIds.length < MIN_PACK_OPTIONS || optionIds.length > P3B_MAX_DECISION_OPTIONS) {
    fail("E_P3E_DECISION", "pendingDecision");
  }
  const seen = new Set<string>();
  for (const optionId of optionIds) {
    if (seen.has(optionId)) fail("E_P3E_DECISION", "pendingDecision");
    seen.add(optionId);
  }
  return optionIds;
}

/**
 * 用**同一份**已驗證事件包重新確認 pending decision 事實，並建立 `p3e-2` 摘要。
 *
 * 比對項目（任何不一致 → `E_P3E_DECISION at pendingDecision`）：
 *
 * 1. `eventId` 必須存在於 pack；
 * 2. 該 event 必須有 `decision`，且 `decisionId` 一致；
 * 3. `selectionHash` 必須等於本次抽選的 `selectionHash`；
 * 4. pack 的 option 數量必須是 `2..P3B_MAX_DECISION_OPTIONS` 且不重複
 *    （**不採用** State shape 層允許的 1-option 放寬）；
 * 5. 事實的 `options` 數量與**每一個** `optionId`（含順序）都必須等於 pack。
 *
 * **內部 seam（不進 barrel）**：公開入口下這些不一致不可能發生（事實就是從同一個 pack
 * 與同一次抽選產生的），匯出讓折疊規則可以被直接測試。
 */
export function buildP3EPendingDecisionSummary(
  pack: ValidatedEventPack,
  openedDecision: P3EPendingDecision,
  selectionHash: string,
  year: number,
  age: number
): P3EPendingDecisionSummary {
  const event = pack.events.find((entry) => entry.eventId === openedDecision.eventId);
  if (event === undefined) fail("E_P3E_DECISION", "pendingDecision");
  if (event.decision === null) fail("E_P3E_DECISION", "pendingDecision");
  if (event.decision.decisionId !== openedDecision.decisionId) fail("E_P3E_DECISION", "pendingDecision");
  if (openedDecision.selectionHash !== selectionHash) fail("E_P3E_DECISION", "pendingDecision");

  const optionIds = packDecisionOptions(event.decision);
  if (openedDecision.options.length !== optionIds.length) fail("E_P3E_DECISION", "pendingDecision");
  for (let index = 0; index < optionIds.length; index += 1) {
    if (openedDecision.options[index]?.optionId !== optionIds[index]) fail("E_P3E_DECISION", "pendingDecision");
  }

  return Object.freeze({
    year,
    age,
    eventId: event.eventId,
    decisionId: event.decision.decisionId,
    selectionHash,
    optionIds: Object.freeze([...optionIds])
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 跑一次年度死亡階段，並把結果轉成「可持久化的 pending decision 摘要」。
 *
 * 摘要規則：
 *
 * - 死亡（`mortality`）或 age ceiling → `null`（即使事件原本開啟 decision 也不持久化）；
 * - 未死亡且沒有 decision → `null`；
 * - 未死亡且有 decision → 六欄摘要，`year`／`age` 取 Roll 後值，其餘取自
 *   selection／opened decision，`optionIds` 依**pack 原順序**。
 *
 * 失敗一律是 `P3EError`；不會建立或 seal State，也不會修改輸入。
 */
export function resolveP3EAnnualPendingDecision(input: unknown): P3EAnnualPendingDecisionStage {
  const raw = readRawInput(input);

  // 同一份已驗證事件包（用於重新確認 event／decision／options）
  const packs = validateP3EAnnualPacks({
    state: raw.state,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack
  });

  // 一律重跑死亡階段（含 roll／selection／effects），不接受任何中間結果
  const annualDeath = resolveP3EAnnualDeath({
    state: raw.state,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack,
    contentMode: raw.contentMode
  });

  const openedDecision = annualDeath.effects.openedDecision;
  const pendingDecisionSummary =
    annualDeath.diedThisYear || openedDecision === null
      ? null
      : buildP3EPendingDecisionSummary(
          packs.eventPack,
          openedDecision,
          annualDeath.effects.selection.selectionHash,
          annualDeath.effects.selection.roll.yearAfter,
          annualDeath.effects.selection.roll.ageAfter
        );

  return Object.freeze({ annualDeath, pendingDecisionSummary });
}
