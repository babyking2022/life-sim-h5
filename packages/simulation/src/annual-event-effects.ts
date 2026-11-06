import {
  P3E_MAX_OCCURRENCES,
  type P3BEffect,
  type P3BEventRecord,
  type P3BSelectionState,
  type P3CYearEventOutcome,
  applyP3EMoneyModifierDeltaForAge,
  normalizeP3EAssetsForAge,
  type P3EAssets,
  type P3EErrorCode,
  type P3EEventOccurrence,
  type P3EStats
} from "@life-sim/contracts";
import {
  applyEffectOutcome,
  applyEventEffects,
  noEventOutcome,
  type EffectApplication,
  type ValidatedEventPack
} from "@life-sim/engine";
import { P3EError } from "./errors";
import { validateP3EAnnualPacks } from "./annual-packs";
import {
  resolveP3EAnnualEventSelection,
  type P3EAnnualEventSelection
} from "./annual-event-selection";

/**
 * 年度事件 effects 與 occurrences 轉接層（H5-CTO-087-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * resolveP3EAnnualEventEffects(input: unknown): P3EAnnualEventEffects
 * ```
 *
 * 組合四件已凍結的東西：`validateP3EAnnualPacks` → `resolveP3EAnnualEventSelection`
 * → `applyEventEffects`（P3-B）→ `applyEffectOutcome`（P3-C 轉接）。
 *
 * ## 刻意不做
 *
 * - **不建立、不修改、不 seal `P3ELifeState`**；死亡判定、phase 決定、年度交易落地全部留給下一批。
 * - 不碰 Ledger／Chain／Command／Codec／Replay（Ledger 由並行的 WorkBuddy Agent B 負責）。
 * - 不複製 stat／money／flag 的 effect 演算法：一律經過 `applyEventEffects`；
 *   變動摘要一律經過 `applyEffectOutcome`。
 * - 不接受呼叫端傳入的 selection／roll 中間結果：一律**重新**走一次
 *   `resolveP3EAnnualEventSelection`，避免偽造未品牌化的中間物件。
 * - pending decision 只以**事實物件**回傳；`p3e-2` 起 State 有的是固定大小的
 *   `pendingDecision` **摘要**，把事實轉成摘要的工作屬於 `pending-decision-persistence.ts`。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

export interface P3EPendingDecisionOption {
  readonly optionId: string;
  readonly labelKey: string;
  /** 選項 effects 的獨立深層凍結快照。 */
  readonly effects: readonly P3BEffect[];
}

/** 事件開啟的待決策事實（不含任何 State 欄位、不含 ledger hash）。 */
export interface P3EPendingDecision {
  readonly eventId: string;
  readonly decisionId: string;
  readonly promptKey: string;
  readonly options: readonly P3EPendingDecisionOption[];
  /** 本次抽選的 `selectionHash`，把決策綁在「這一年這一次抽選」上。 */
  readonly selectionHash: string;
}

/** 一年事件套用後的事實（全部深層凍結、與輸入零共享）。 */
export interface P3EAnnualEventEffects {
  /** 完整的 event selection 結果（含 roll、候選、draws、游標）。 */
  readonly selection: P3EAnnualEventSelection;
  readonly selectedEventId: string | null;
  /** 事件套用後的 stats（無事件時等於 Roll 後值）。 */
  readonly stats: P3EStats;
  /** 事件套用後的 assets（無事件時等於 Roll 後值）。 */
  readonly assets: P3EAssets;
  /** 事件套用後的 flags（升冪；無事件時與原 state 相同）。 */
  readonly flags: readonly string[];
  /** 更新後的 occurrences（eventId 升冪、唯一；無事件時內容不變但仍是新副本）。 */
  readonly occurrences: readonly P3EEventOccurrence[];
  readonly informational: boolean;
  readonly openedDecision: P3EPendingDecision | null;
  /** 可稽核的變動摘要（stat／money delta ＋ flag 增減），**不含**任何 ledger hash。 */
  readonly changes: P3CYearEventOutcome;
}

/** 驗證「下一個 State」的 occurrence 上限時需要的資訊。 */
export interface P3EAnnualOccurrenceLimits {
  readonly birthYear: number;
  readonly ageAfter: number;
  readonly currentYearAfter: number;
  readonly eventCount: number;
}

const INPUT_KEYS = ["state", "eventPack", "deathPack", "contentMode"] as const;

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
/* 5. 事件查找（seam）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 在**同一個** validated pack 裡找出已抽中的事件。
 *
 * **內部 seam（不進 barrel）**：`resolveP3EAnnualEventEffects` 走的就是這支函式；
 * 另外匯出是為了讓「抽中的 id 不在 pack 裡」這條錯誤（合法 pack ＋ 合法 selection 之下
 * 不可能發生）可以被直接測試。
 */
export function findP3EEvent(pack: ValidatedEventPack, eventId: string): P3BEventRecord {
  for (const event of pack.events) {
    if (event.eventId === eventId) return event;
  }
  fail("E_P3E_EVENT", "selectedEventId");
}

/* ------------------------------------------------------------------ */
/* 5. effects ＋ outcome（seam）                                       */
/* ------------------------------------------------------------------ */

/**
 * 先用 P3-B 的 `applyEventEffects` 算 effects，再用 P3-C 的 `applyEffectOutcome` 轉接。
 *
 * 兩步的例外都折成固定 `P3EError`（`E_P3E_EFFECT at eventEffects`／`E_P3E_EFFECT at eventOutcome`），
 * 不外洩 `P3BError`／`P3CError`／`MoneyError`／`TypeError`／`RangeError`。
 *
 * **內部 seam（不進 barrel）**：合法 pack 的 effects 已在 pack 驗證時檢查過，因此公開入口
 * 幾乎不會走到這兩個 catch；匯出讓錯誤折疊可以被直接測試。
 */
export function applyP3EEventEffectsAndOutcome(selectionState: unknown, effects: unknown): EffectApplication {
  let outcome: unknown;
  try {
    outcome = applyEventEffects(selectionState, effects);
  } catch {
    fail("E_P3E_EFFECT", "eventEffects");
  }
  try {
    return applyEffectOutcome(selectionState, outcome);
  } catch {
    fail("E_P3E_EFFECT", "eventOutcome");
  }
}

/* ------------------------------------------------------------------ */
/* 6. occurrences                                                      */
/* ------------------------------------------------------------------ */

/**
 * 「下一個 State」的 occurrence 不變量：eventId 升冪唯一、長度上限、
 * `lastYear` 範圍、`count` 上限、`Σcount <= age`。
 *
 * **內部 seam（不進 barrel）**：對合法輸入而言這些條件天然成立（見風險文件 R-02），
 * 匯出讓每一條上限都能被獨立測試。
 */
export function assertP3EAnnualOccurrences(
  occurrences: readonly P3EEventOccurrence[],
  limits: P3EAnnualOccurrenceLimits
): void {
  if (occurrences.length > Math.min(P3E_MAX_OCCURRENCES, limits.eventCount, limits.ageAfter)) {
    fail("E_P3E_EVENT", "occurrences");
  }
  let previous: string | null = null;
  let total = 0;
  for (const entry of occurrences) {
    if (previous !== null && !(previous < entry.eventId)) fail("E_P3E_EVENT", "occurrences");
    previous = entry.eventId;
    if (entry.lastYear < limits.birthYear + 1 || entry.lastYear > limits.currentYearAfter) {
      fail("E_P3E_EVENT", "occurrences");
    }
    if (entry.count < 1 || entry.count > entry.lastYear - limits.birthYear) {
      fail("E_P3E_EVENT", "occurrences");
    }
    total += entry.count;
  }
  if (total > limits.ageAfter) fail("E_P3E_EVENT", "occurrences");
}

/** 把 occurrences 的陣列與每個項目都凍結（新物件、新陣列）。 */
function freezeOccurrences(occurrences: readonly P3EEventOccurrence[]): readonly P3EEventOccurrence[] {
  return Object.freeze(occurrences.map((entry) => Object.freeze({ eventId: entry.eventId, count: entry.count, lastYear: entry.lastYear })));
}

/** 複製一份 occurrences（新物件、新陣列；不改原陣列或原項目）。 */
function copyOccurrences(occurrences: readonly P3EEventOccurrence[]): P3EEventOccurrence[] {
  return occurrences.map((entry) => ({
    eventId: entry.eventId,
    count: entry.count,
    lastYear: entry.lastYear
  }));
}

/** 累加／新增一筆 occurrence，並維持 eventId 升冪（不修改原陣列或原項目）。 */
function updateOccurrences(
  occurrences: readonly P3EEventOccurrence[],
  eventId: string,
  lastYear: number
): P3EEventOccurrence[] {
  const next: P3EEventOccurrence[] = occurrences.map((entry) =>
    entry.eventId === eventId
      ? { eventId: entry.eventId, count: entry.count + 1, lastYear }
      : { eventId: entry.eventId, count: entry.count, lastYear: entry.lastYear }
  );
  // 已存在：eventId 沒變，位置也就沒變 → 直接回傳。
  if (occurrences.some((entry) => entry.eventId === eventId)) return next;
  // 新事件：插到第一個 eventId 比自己大的位置（保持升冪，不需要再 sort）。
  const position = next.findIndex((entry) => eventId < entry.eventId);
  if (position === -1) next.push({ eventId, count: 1, lastYear });
  else next.splice(position, 0, { eventId, count: 1, lastYear });
  return next;
}

/* ------------------------------------------------------------------ */
/* 深層凍結的獨立副本                                                  */
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
/* Decision                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把「事件有 decision 且 effects 剛好開啟自己」轉成待決策事實。
 *
 * P3-B 的 pack 驗證其實已經保證「decision 與 openDecision 必須一致」，但年度交易仍要
 * 自己防守（工作單要求），因此這裡是第二道檢查。
 *
 * **內部 seam（不進 barrel）**：合法的 validated pack 不會讓這兩條檢查失敗，
 * 匯出是為了讓不一致的兩條錯誤可以被直接測試。
 */
export function resolveP3EPendingDecision(
  event: P3BEventRecord,
  application: EffectApplication,
  selectionHash: string
): P3EPendingDecision | null {
  const decision = event.decision;
  if (decision === null) {
    // 沒有 decision 的事件不得開啟決策（避免產生無法收斂的 pending 狀態）。
    if (application.openedDecisionId !== null) fail("E_P3E_DECISION", "eventDecision");
    return null;
  }
  // 有 decision 就必須剛好開啟自己（巢狀／錯 id 一律拒絕）。
  if (application.openedDecisionId !== decision.decisionId) fail("E_P3E_DECISION", "eventDecision");
  return Object.freeze({
    eventId: event.eventId,
    decisionId: decision.decisionId,
    promptKey: decision.promptKey,
    options: Object.freeze(
      decision.options.map((option) =>
        Object.freeze({
          optionId: option.optionId,
          labelKey: option.labelKey,
          effects: Object.freeze(option.effects.map((effect) => Object.freeze({ ...effect }) as P3BEffect))
        })
      )
    ),
    selectionHash
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 對一個合法 state 做「Roll → 事件抽選 → 套用 effects → 更新 occurrences」。
 *
 * 順序固定：input shape → `validateP3EAnnualPacks` → `resolveP3EAnnualEventSelection`
 * →（無事件：Roll 後值 ＋ 原 flags／occurrences）或（有事件：找事件 → effects → outcome
 * → decision → occurrence）→ 深層凍結結果。
 *
 * 失敗一律是 `P3EError`，不會回傳部分結果，也不會修改輸入。
 */
export function resolveP3EAnnualEventEffects(input: unknown): P3EAnnualEventEffects {
  const raw = readRawInput(input);

  // 2. 年度 packs（取得品牌 event pack 與已驗證的 state）
  const packs = validateP3EAnnualPacks({
    state: raw.state,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack
  });
  const state = packs.state;

  // 3. 一律重跑 selection（不接受呼叫端傳入的中間結果）
  const selection = resolveP3EAnnualEventSelection({
    state: raw.state,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack,
    contentMode: raw.contentMode
  });
  const roll = selection.roll;

  const limits: P3EAnnualOccurrenceLimits = {
    birthYear: state.identity.birthYear,
    ageAfter: roll.ageAfter,
    currentYearAfter: roll.yearAfter,
    eventCount: state.packs.events.eventCount
  };

  // 4. 沒有事件：Roll 後值 ＋ 原 flags／occurrences，不套用任何 effects
  if (selection.selectedEventId === null) {
    const occurrences = copyOccurrences(state.occurrences);
    assertP3EAnnualOccurrences(occurrences, limits);
    return Object.freeze({
      selection,
      selectedEventId: null,
      stats: copyStats(roll.statsAfter),
      assets: copyAssets(normalizeP3EAssetsForAge(roll.ageAfter, roll.assetsAfter)),
      flags: Object.freeze([...state.flags]),
      occurrences: freezeOccurrences(occurrences),
      informational: false,
      openedDecision: null,
      changes: copyOutcome(noEventOutcome())
    });
  }

  // 5. 有事件：同一個 pack 裡找事件，用 Roll 後的值當 effects 基底
  const event = findP3EEvent(packs.eventPack, selection.selectedEventId);
  const effectState: P3BSelectionState = {
    currentYear: roll.yearAfter,
    age: roll.ageAfter,
    phase: "life",
    stats: copyStats(roll.statsAfter),
    assets: copyAssets(roll.assetsAfter),
    flags: [...state.flags]
  };
  const application = applyP3EEventEffectsAndOutcome(effectState, event.effects);
  // GPT-0032-A：持續性收入／支出效果寫成明確 modifier 旗標（不靠下一輪猜測）。
  // GPT-0033-A：0–15 歲的 money effects 不寫個人 modifier（否則會在 16 歲後漏出）。
  const flagsAfter = applyP3EMoneyModifierDeltaForAge(roll.ageAfter, application.flags, application.outcome.moneyDelta);
  const openedDecision = resolveP3EPendingDecision(event, application, selection.selectionHash);

  // 6. occurrences
  const occurrences = updateOccurrences(state.occurrences, event.eventId, roll.yearAfter);
  assertP3EAnnualOccurrences(occurrences, limits);

  // 7. 獨立、深層凍結的結果
  return Object.freeze({
    selection,
    selectedEventId: event.eventId,
    stats: copyStats(application.stats),
    // GPT-0032-A：0–15 歲的個人財務在這裡就歸零（涵蓋所有未來的 money effects）。
    assets: copyAssets(normalizeP3EAssetsForAge(roll.ageAfter, application.assets)),
    flags: Object.freeze([...flagsAfter]),
    occurrences: freezeOccurrences(occurrences),
    informational: application.informational,
    openedDecision,
    changes: copyOutcome(application.outcome)
  });
}
