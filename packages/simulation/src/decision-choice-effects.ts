import {
  applyP3EMoneyModifierDeltaForAge,
  normalizeP3EAssetsForAge,
  type P3BDecisionSpec,
  type P3BEffect,
  type P3CYearEventOutcome,
  type P3EAssets,
  type P3EErrorCode,
  type P3EStats
} from "@life-sim/contracts";
import { applyEffectOutcome, applyEventEffects, type EffectApplication } from "@life-sim/engine";
import { P3EError } from "./errors";
import { validateP3EAnnualPacks } from "./annual-packs";
import { readP3EState } from "./state-invariants";

/**
 * 玩家在 `pending_decision` 選擇 option 後的**效果事實**（H5-CTO-115-A，套件內部，
 * **不進公開 barrel**）。
 *
 * ```ts
 * resolveP3EDecisionChoice(input: unknown): P3EDecisionChoiceStage
 * ```
 *
 * ## 刻意不做
 *
 * - 不建立、不修改、不 seal 下一個 `P3ELifeState`；不產生 Command／Ledger／Chain。
 * - 不執行年度 Roll、事件抽選或死亡判定（`currentYear`／`age`／`occurrences`／三條 RNG
 *   全部保持不變——本模組連碰都不碰）。
 * - 不複製 stat clamp／Money／flag／effects 演算法：一律經過 `applyEventEffects`，
 *   摘要一律經過 `applyEffectOutcome`。
 * - 選項 effects **不得再開第二層 decision**（`openedDecisionId !== null` → `E_P3E_DECISION`）。
 *
 * ## 固定流程
 *
 * 1. `readP3EState`（shape ＋ invariants ＋ stateHash）；
 * 2. `validateP3EAnnualPacks`（event／death pack 品牌 ＋ 與 state 的 binding）；
 * 3. `pendingDecision !== null`（`readP3EState` 已凍結 `phase === "pending_decision"` ⇔ 非 null，
 *    所以這一個檢查同時涵蓋「不是 pending phase」與「缺 summary」）；
 * 4. 用 summary 的 `eventId`／`decisionId` 在**同一份** pack 找 event／decision；
 * 5. summary 的 `optionIds` 必須與 pack options 的數量、內容、順序完全一致；
 * 6. `optionId` 必須是該 decision 的合法選項；
 * 7. `applyEventEffects` ＋ `applyEffectOutcome`（折疊 seam）；
 * 8. 深層凍結的結果。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 一次決策選擇的效果事實（全部深層凍結、與輸入零共享）。 */
export interface P3EDecisionChoiceStage {
  readonly eventId: string;
  readonly decisionId: string;
  readonly selectedOptionId: string;
  /** 以 pending State 的當前值為基底套用 option effects 後的結果。 */
  readonly stats: P3EStats;
  readonly assets: P3EAssets;
  readonly flags: readonly string[];
  /** 可稽核的變動摘要（stat／money delta ＋ flag 增減），不含任何 ledger hash。 */
  readonly changes: P3CYearEventOutcome;
  readonly informational: boolean;
  /** 選擇後就沒有待決策了。 */
  readonly pendingDecisionAfter: null;
  /** 選擇後回到 life（死亡／壽命上限的優先序屬下一個年度交易批次）。 */
  readonly phaseAfter: "life";
  /** 明確標記：本次選擇不改變年度。 */
  readonly currentYearAfter: number;
  /** 明確標記：本次選擇不改變年齡。 */
  readonly ageAfter: number;
}

const INPUT_KEYS = ["state", "eventPack", "deathPack", "optionId"] as const;

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
/* 7. effects ＋ outcome（seam）                                       */
/* ------------------------------------------------------------------ */

/**
 * 套用**單一決策選項**的 effects：先用 P3-B 的 `applyEventEffects`，再用 P3-C 的
 * `applyEffectOutcome` 轉接。
 *
 * - 兩步的例外都折成固定 `P3EError`（`E_P3E_EFFECT at eventEffects`／`at eventOutcome`），
 *   不外洩 `P3BError`／`P3CError`／`MoneyError`／`TypeError`／`RangeError`；
 * - 選項 effects **不得再開第二層 decision**：`openedDecisionId !== null` → `E_P3E_DECISION at optionId`。
 *
 * **內部 seam（不進 barrel）**：合法 pack 的 option effects 已在 pack 驗證時檢查過，
 * 公開入口幾乎不會走到這三個分支；匯出讓折疊規則可以被直接測試。
 */
export function applyP3EDecisionOption(base: unknown, effects: unknown): EffectApplication {
  let outcome: unknown;
  try {
    outcome = applyEventEffects(base, effects);
  } catch {
    fail("E_P3E_EFFECT", "eventEffects");
  }
  let application: EffectApplication;
  try {
    application = applyEffectOutcome(base, outcome);
  } catch {
    fail("E_P3E_EFFECT", "eventOutcome");
  }
  // 巢狀決策：選項不得再開一個 decision。
  if (application.openedDecisionId !== null) fail("E_P3E_DECISION", "optionId");
  return application;
}

/* ------------------------------------------------------------------ */
/* 深的獨立副本                                                        */
/* ------------------------------------------------------------------ */

function copyStats(stats: P3EStats): P3EStats {
  return Object.freeze({
    health: stats.health,
    happiness: stats.happiness,
    knowledge: stats.knowledge,
    relationships: stats.relationships
  });
}

function copyAssets(assets: P3EAssets): P3EAssets {
  return Object.freeze({
    balanceMicroUsd: assets.balanceMicroUsd,
    annualIncomeMicroUsd: assets.annualIncomeMicroUsd,
    annualExpenseMicroUsd: assets.annualExpenseMicroUsd
  });
}

function copyOutcome(outcome: P3CYearEventOutcome): P3CYearEventOutcome {
  return Object.freeze({
    statDelta: copyStats(outcome.statDelta),
    moneyDelta: Object.freeze({
      balanceMicroUsd: outcome.moneyDelta.balanceMicroUsd,
      annualIncomeMicroUsd: outcome.moneyDelta.annualIncomeMicroUsd,
      annualExpenseMicroUsd: outcome.moneyDelta.annualExpenseMicroUsd
    }),
    flagsAdded: Object.freeze([...outcome.flagsAdded]),
    flagsRemoved: Object.freeze([...outcome.flagsRemoved]),
    informational: outcome.informational,
    openedDecisionId: outcome.openedDecisionId
  });
}

/* ------------------------------------------------------------------ */
/* 4–5. 與 pack 的交叉比對                                             */
/* ------------------------------------------------------------------ */

/** 依 summary 的 `eventId`／`decisionId` 找到同一份 pack 的 decision。 */
function decisionFor(
  pack: { readonly events: readonly { readonly eventId: string; readonly decision: P3BDecisionSpec | null }[] },
  eventId: string,
  decisionId: string
): P3BDecisionSpec {
  const event = pack.events.find((entry) => entry.eventId === eventId);
  if (event === undefined) fail("E_P3E_DECISION", "pendingDecision");
  if (event.decision === null) fail("E_P3E_DECISION", "pendingDecision");
  if (event.decision.decisionId !== decisionId) fail("E_P3E_DECISION", "pendingDecision");
  return event.decision;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把「玩家在 pending decision 選了某個 option」套用成效果事實。
 *
 * 失敗一律是 `P3EError`：不是 pending phase／缺 summary → `E_P3E_PHASE at phase`；
 * summary 與 pack 不一致 → `E_P3E_DECISION at pendingDecision`；
 * optionId 不合法 → `E_P3E_DECISION at optionId`；engine 例外折成 `E_P3E_EFFECT`。
 * 不建立 State、不修改輸入。
 */
export function resolveP3EDecisionChoice(input: unknown): P3EDecisionChoiceStage {
  const raw = readRawInput(input);

  // 1. state（shape ＋ invariants ＋ stateHash）
  const state = readP3EState(raw.state);

  // 2. event／death pack 品牌與 binding
  const packs = validateP3EAnnualPacks({
    state,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack
  });

  // 3. pending summary（`readP3EState` 保證 phase === "pending_decision" ⇔ 非 null，
  //    因此這一個檢查同時涵蓋「不是 pending phase」與「缺 summary」。）
  const pending = state.pendingDecision;
  if (pending === null) fail("E_P3E_PHASE", "phase");

  // 4. 用 summary 找同一份 pack 的 decision
  const decision = decisionFor(packs.eventPack, pending.eventId, pending.decisionId);

  // 5. summary 的 optionIds 必須與 pack 完全一致（數量、內容、順序）
  const packOptionIds = decision.options.map((option) => option.optionId);
  if (pending.optionIds.length !== packOptionIds.length) fail("E_P3E_DECISION", "pendingDecision");
  for (let index = 0; index < packOptionIds.length; index += 1) {
    if (pending.optionIds[index] !== packOptionIds[index]) fail("E_P3E_DECISION", "pendingDecision");
  }

  // 6. optionId 必須是這個 decision 的合法選項
  const optionId = raw.optionId;
  if (typeof optionId !== "string") fail("E_P3E_DECISION", "optionId");
  const optionIndex = packOptionIds.indexOf(optionId);
  if (optionIndex === -1) fail("E_P3E_DECISION", "optionId");
  const option = decision.options[optionIndex] as { readonly effects: readonly P3BEffect[] };

  // 7. 以 pending State 的當前值為基底套用 option effects
  const application = applyP3EDecisionOption(
    {
      currentYear: state.currentYear,
      age: state.age,
      phase: state.phase,
      stats: { ...state.stats },
      assets: { ...state.assets },
      flags: [...state.flags]
    },
    option.effects
  );

  // 8. 深層凍結的結果
  // GPT-0032-A：決策選項的持續性 money effects 一樣寫成 modifier 旗標，
  // 且 0–15 歲的個人財務在正式 transition 邊界歸零。
  // GPT-0033-A：兒童（0–15 歲）的決策 money effects 不寫個人 modifier。
  const flagsAfter = applyP3EMoneyModifierDeltaForAge(state.age, application.flags, application.outcome.moneyDelta);
  return Object.freeze({
    eventId: pending.eventId,
    decisionId: pending.decisionId,
    selectedOptionId: optionId,
    stats: copyStats(application.stats),
    assets: copyAssets(normalizeP3EAssetsForAge(state.age, application.assets)),
    flags: Object.freeze([...flagsAfter]),
    changes: copyOutcome(application.outcome),
    informational: application.informational,
    pendingDecisionAfter: null,
    phaseAfter: "life",
    currentYearAfter: state.currentYear,
    ageAfter: state.age
  });
}
