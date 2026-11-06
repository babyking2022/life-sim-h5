import {
  replaceP3ELifeFocusFlag,
  type P3ELifeFocusId,
  P3E_DEATH_DOMAIN,
  P3E_EVENT_DOMAIN,
  P3E_LIFE_DOMAIN,
  type P3EAssets,
  type P3EDeathRngState,
  type P3EErrorCode,
  type P3EEventOccurrence,
  type P3EEventRngState,
  type P3EIdentityBinding,
  type P3ELifeRngState,
  type P3ELifeState,
  normalizeP3EAssetsForAge,
  type P3EPackBindings,
  type P3EPendingDecisionSummary,
  type P3EPhase,
  type P3ERngState,
  type P3EStats,
  type P3EWordTuple
} from "@life-sim/contracts";
import { P3EError } from "./errors";
import type { P3EAnnualPendingDecisionStage } from "./pending-decision-persistence";
import type { P3EDecisionChoiceStage } from "./decision-choice-effects";

/**
 * P3-E State Core Draft（正式主線，H5-CTO-135-A 整合；套件內部，**不進公開 barrel**）。
 *
 * 來源：WorkBuddy 候選 `state-core-draft-v11-candidate.ts`
 * （SHA-256 `b62987b1983ce87ccc183774331718bbff71c48c7abda5004c0b4e758dd6c170`，
 * 經 H5-CTO-127-B／H5-CTO-135-A 核准）。正式化只做四件事：改檔名與字樣、
 * 修正兩處註解排版、把「候選錯誤」改成「固定 P3-E 錯誤」；**業務邏輯逐字保留**。
 *
 * ```ts
 * assembleP3EAnnualStateCoreDraft(previous, stage): P3EStateCoreDraft
 * assembleP3EDecisionStateCoreDraft(previous, stage): P3EStateCoreDraft
 * ```
 *
 * 本模組保留候選 V1／V1.1 的全部映射規則、19 欄 Draft 形狀、phase 優先序、
 * 深層凍結與零共享，只強化三處**信任邊界**：
 *
 * 1. **RNG domain 完整性**：三條 RNG 的 `previous`／`before`／`after` 必須逐段對到
 *    正式 domain 常數（`P3E_LIFE_DOMAIN`／`P3E_EVENT_DOMAIN`／`P3E_DEATH_DOMAIN`）。
 *    這是 **runtime 字串比對**——型別雖是 literal，但 runtime 值仍可能來自未驗證的
 *    輸入，型別斷言不能取代它。
 * 2. **Pending 摘要與完整事實交叉比對**：`stage.pendingDecisionSummary` 必須與
 *    `stage.annualDeath.pendingDecisionAfterDeath`（含完整 options）逐欄一致。
 * 3. **Decision 的 `selectedOptionId`** 必須屬於 `previous.pendingDecision.optionIds`。
 *
 * 刻意不做：**不做 seal／hash**（不呼叫 stateHash、不碰 Ledger／Command／Chain）、
 * **不重跑任何演算法**（不重跑 Roll、不重抽事件、不重套 effects、不重跑死亡判定、
 * 不重套 option effects）、**不查事件包**（決策路徑只比對 previous 摘要與已完成 stage）、
 * **不修改輸入**（輸出全是新建的深層凍結物件）、**不進公開 barrel**。
 */

/**
 * State 的**核心業務欄位**（不含 hash-chain heads／command 摘要／stateHash）。
 *
 * 這是 seal 之前的骨架：整合者拿到它之後，自行負責 heads／commandLog／stateHash 的封存。
 */
export type P3EStateCoreDraft = Omit<P3ELifeState, "heads" | "commandLog" | "stateHash">;

/** 本模組用到的年度 Roll 視圖（**結構相容**即可；刻意不 import Roll 模組）。 */
type P3ECoreDraftRollView = Pick<
  P3EAnnualPendingDecisionStage["annualDeath"]["effects"]["selection"]["roll"],
  "yearBefore" | "yearAfter" | "ageBefore" | "ageAfter" | "lifeRngBefore" | "lifeRngAfter" | "semanticDrawsUsed"
>;

/**
 * 「完整待決策事實」視圖（**結構相容**即可；刻意不 import events 模組）。
 *
 * 取自年度 stage 的既有欄位，因此本模組與事件／決策演算法保持**零編譯期相依**。
 */
type P3ECoreDraftPendingView = NonNullable<
  P3EAnnualPendingDecisionStage["annualDeath"]["pendingDecisionAfterDeath"]
>;

const ANNUAL_ROLL_PATH = "stateCoreDraft.annual.roll";
const ANNUAL_LIFE_RNG_PATH = "stateCoreDraft.annual.rng.life";
const ANNUAL_EVENT_RNG_PATH = "stateCoreDraft.annual.rng.events";
const ANNUAL_DEATH_RNG_PATH = "stateCoreDraft.annual.rng.death";
const ANNUAL_PENDING_PATH = "stateCoreDraft.annual.pendingDecision";
const DECISION_PHASE_PATH = "stateCoreDraft.decision.phase";
const DECISION_PENDING_PATH = "stateCoreDraft.decision.pendingDecision";
const DECISION_IDENTITY_PATH = "stateCoreDraft.decision.identity";
const DECISION_YEAR_AGE_PATH = "stateCoreDraft.decision.yearAge";
const DECISION_AFTER_PATH = "stateCoreDraft.decision.after";

function fail(code: P3EErrorCode, path: string): never {
  throw new P3EError(code, path);
}

/** 四個字逐一比對（固定 4 個，不看長度）。 */
function sameWords(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < 4; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * domain 的 **runtime** 字串比對。
 *
 * 刻意收 `string`（不是 literal union）：參數放寬成 `string` 之後，這個比對在
 * runtime 才發生，**型別斷言無法取代它**。若把參數型別收成 literal，
 * 型別系統就會把它視為恆真，`as` 之類的斷言就能偽裝通過。
 */
function sameDomain(left: string, right: string): boolean {
  return left === right;
}

/** 逐項檢查；任何一項為 false 就回 false（不做短路以外的任何推論）。 */
function allTrue(checks: readonly boolean[]): boolean {
  for (const check of checks) {
    if (!check) return false;
  }
  return true;
}

function copyWords(words: P3EWordTuple): P3EWordTuple {
  const copy: [number, number, number, number] = [words[0], words[1], words[2], words[3]];
  return Object.freeze(copy);
}

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

function copyIdentity(identity: P3EIdentityBinding): P3EIdentityBinding {
  return Object.freeze({
    entityId: identity.entityId,
    regionCode: identity.regionCode,
    sex: identity.sex,
    birthYear: identity.birthYear,
    certificateId: identity.certificateId,
    certificateHash: identity.certificateHash,
    playerIdentityHash: identity.playerIdentityHash,
    masterSeedHash: identity.masterSeedHash,
    basePackId: identity.basePackId,
    basePackChecksum: identity.basePackChecksum,
    identityPackId: identity.identityPackId,
    identityPackChecksum: identity.identityPackChecksum
  });
}

function copyPacks(packs: P3EPackBindings): P3EPackBindings {
  return Object.freeze({
    events: Object.freeze({ ...packs.events }),
    death: Object.freeze({ ...packs.death })
  });
}

function copyFlags(flags: readonly string[]): readonly string[] {
  return Object.freeze([...flags]);
}

function copyOccurrences(occurrences: readonly P3EEventOccurrence[]): readonly P3EEventOccurrence[] {
  return Object.freeze(
    occurrences.map((entry) =>
      Object.freeze({ eventId: entry.eventId, count: entry.count, lastYear: entry.lastYear })
    )
  );
}

function copyPendingSummary(summary: P3EPendingDecisionSummary | null): P3EPendingDecisionSummary | null {
  if (summary === null) return null;
  return Object.freeze({
    year: summary.year,
    age: summary.age,
    eventId: summary.eventId,
    decisionId: summary.decisionId,
    selectionHash: summary.selectionHash,
    optionIds: Object.freeze([...summary.optionIds])
  });
}

function copyLifeRng(rng: P3ELifeRngState): P3ELifeRngState {
  return Object.freeze({
    domain: rng.domain,
    initialState: copyWords(rng.initialState),
    state: copyWords(rng.state),
    semanticDraws: rng.semanticDraws
  });
}

function copyEventRng(rng: P3EEventRngState): P3EEventRngState {
  return Object.freeze({
    domain: rng.domain,
    initialState: copyWords(rng.initialState),
    state: copyWords(rng.state),
    u32Draws: rng.u32Draws
  });
}

function copyDeathRng(rng: P3EDeathRngState): P3EDeathRngState {
  return Object.freeze({
    domain: rng.domain,
    initialState: copyWords(rng.initialState),
    state: copyWords(rng.state),
    u32Draws: rng.u32Draws
  });
}

function copyRng(rng: P3ERngState): P3ERngState {
  return Object.freeze({
    life: copyLifeRng(rng.life),
    events: copyEventRng(rng.events),
    death: copyDeathRng(rng.death)
  });
}

/** 版本八欄（純 literal，沒有可變結構；仍逐欄列出避免漏搬）。 */
function copyVersions(previous: P3ELifeState): Pick<
  P3EStateCoreDraft,
  | "schemaVersion" | "rulesetVersion" | "rollSpecVersion" | "lifeSpecVersion"
  | "contentVersion" | "saveFormatVersion" | "engineVersion" | "rngSpecVersion"
> {
  return {
    schemaVersion: previous.schemaVersion,
    rulesetVersion: previous.rulesetVersion,
    rollSpecVersion: previous.rollSpecVersion,
    lifeSpecVersion: previous.lifeSpecVersion,
    contentVersion: previous.contentVersion,
    saveFormatVersion: previous.saveFormatVersion,
    engineVersion: previous.engineVersion,
    rngSpecVersion: previous.rngSpecVersion
  };
}

/** 年度路徑的 phase 優先序：**死亡 > 待決策 > 生活**。 */
function annualPhase(diedThisYear: boolean, summary: P3EPendingDecisionSummary | null): P3EPhase {
  if (diedThisYear) return "death";
  if (summary !== null) return "pending_decision";
  return "life";
}

/**
 * 年度路徑的 pending 一致性（強化版）。
 *
 * 1. `diedThisYear` 時，**摘要與完整事實都必須是 `null`**；
 * 2. 兩者必須**同為 `null` 或同為非 `null`**；
 * 3. 非 `null` 時：摘要的 `year`／`age` 必須等於 Roll 後的值；
 *    `eventId`／`decisionId`／`selectionHash` 必須等於完整事實；
 *    `optionIds` 的**數量**、**內容**與**順序**都必須等於完整事實的 options。
 */
function pendingFactsAgree(
  summary: P3EPendingDecisionSummary | null,
  pending: P3ECoreDraftPendingView | null,
  roll: P3ECoreDraftRollView,
  diedThisYear: boolean
): boolean {
  if (diedThisYear) return summary === null && pending === null;
  if (summary === null && pending === null) return true;
  if (summary === null || pending === null) return false;
  if (summary.year !== roll.yearAfter) return false;
  if (summary.age !== roll.ageAfter) return false;
  if (!sameDomain(summary.eventId, pending.eventId)) return false;
  if (!sameDomain(summary.decisionId, pending.decisionId)) return false;
  if (!sameDomain(summary.selectionHash, pending.selectionHash)) return false;
  const pendingOptionIds = pending.options.map((option) => option.optionId);
  if (summary.optionIds.length !== pendingOptionIds.length) return false;
  for (let index = 0; index < pendingOptionIds.length; index += 1) {
    if (summary.optionIds[index] !== pendingOptionIds[index]) return false;
  }
  return true;
}

/**
 * 年度路徑：把「已驗證的 previous `P3ELifeState`」＋「`P3EAnnualPendingDecisionStage`」
 * 組裝成下一個 State 的核心業務欄位。
 *
 * 映射：八個版本欄位／`identity`／`packs` 沿用 previous（獨立凍結副本）；
 * `currentYear`／`age` 取年度 Roll 後；`stats`／`assets`／`flags`／`occurrences` 取年度
 * effects 後；`rng.life` 取 Roll 後游標；`rng.events`／`rng.death` 取抽選／判定後游標
 * （已含實際 draws）；`pendingDecision` 取 stage 的 `pendingDecisionSummary`；
 * `phase` 依「死亡 > 待決策 > 生活」決定。
 *
 * 一致性防線（任一項不符 → 固定 P3-E 錯誤，**不得靜默修正**）：
 * 1. Roll 前後的 year／age 必須自洽、與 previous 對齊，且死亡判定的 age／calendarYear
 *    必須等於 Roll 後的值；
 * 2. 三條 RNG 的 **domain** 必須逐段對到正式常數，且 before 游標必須等於 previous 的
 *    游標，after 游標的 draw 數必須等於 `before + 本次實際 draws`（life 是
 *    `semanticDraws`，events／death 是 `u32Draws`）；
 * 3. pending 摘要必須與完整待決策事實（`pendingDecisionAfterDeath`）逐欄一致；
 *    死亡年度兩者都必須是 `null`。
 */
export function assembleP3EAnnualStateCoreDraft(
  previous: P3ELifeState,
  stage: P3EAnnualPendingDecisionStage
): P3EStateCoreDraft {
  const annualDeath = stage.annualDeath;
  const selection = annualDeath.effects.selection;
  const roll = selection.roll;
  const summary = stage.pendingDecisionSummary;

  // 1. Roll 後 year／age：必須自洽、與 previous 對齊、且與死亡判定一致
  if (
    !allTrue([
      roll.yearBefore === previous.currentYear,
      roll.ageBefore === previous.age,
      roll.yearAfter === roll.yearBefore + 1,
      roll.ageAfter === roll.ageBefore + 1,
      annualDeath.mortality.age === roll.ageAfter,
      annualDeath.mortality.calendarYear === roll.yearAfter
    ])
  ) {
    fail("E_P3E_STATE", ANNUAL_ROLL_PATH);
  }

  // 2a. life RNG：domain 鏈、before 游標、after 語意抽樣數
  if (
    !allTrue([
      sameDomain(previous.rng.life.domain, P3E_LIFE_DOMAIN),
      sameDomain(roll.lifeRngBefore.domain, previous.rng.life.domain),
      sameDomain(roll.lifeRngAfter.domain, roll.lifeRngBefore.domain),
      sameWords(roll.lifeRngBefore.initialState, previous.rng.life.initialState),
      sameWords(roll.lifeRngBefore.state, previous.rng.life.state),
      roll.lifeRngBefore.semanticDraws === previous.rng.life.semanticDraws,
      sameWords(roll.lifeRngAfter.initialState, roll.lifeRngBefore.initialState),
      roll.lifeRngAfter.semanticDraws === roll.lifeRngBefore.semanticDraws + roll.semanticDrawsUsed
    ])
  ) {
    fail("E_P3E_RNG", ANNUAL_LIFE_RNG_PATH);
  }

  // 2b. event RNG：domain 鏈、before 游標、after u32 數
  if (
    !allTrue([
      sameDomain(previous.rng.events.domain, P3E_EVENT_DOMAIN),
      sameDomain(selection.eventRngBefore.domain, previous.rng.events.domain),
      sameDomain(selection.eventRngAfter.domain, selection.eventRngBefore.domain),
      sameWords(selection.eventRngBefore.initialState, previous.rng.events.initialState),
      sameWords(selection.eventRngBefore.state, previous.rng.events.state),
      selection.eventRngBefore.u32Draws === previous.rng.events.u32Draws,
      sameWords(selection.eventRngAfter.initialState, selection.eventRngBefore.initialState),
      selection.eventRngAfter.u32Draws === selection.eventRngBefore.u32Draws + selection.u32DrawsUsed
    ])
  ) {
    fail("E_P3E_RNG", ANNUAL_EVENT_RNG_PATH);
  }

  // 2c. death RNG：domain 鏈、before 游標、after u32 數，且游標等於 P3-D 回填值
  if (
    !allTrue([
      sameDomain(previous.rng.death.domain, P3E_DEATH_DOMAIN),
      sameDomain(annualDeath.deathRngBefore.domain, previous.rng.death.domain),
      sameDomain(annualDeath.deathRngAfter.domain, annualDeath.deathRngBefore.domain),
      sameWords(annualDeath.deathRngBefore.initialState, previous.rng.death.initialState),
      sameWords(annualDeath.deathRngBefore.state, previous.rng.death.state),
      annualDeath.deathRngBefore.u32Draws === previous.rng.death.u32Draws,
      sameWords(annualDeath.deathRngAfter.initialState, annualDeath.deathRngBefore.initialState),
      annualDeath.deathRngAfter.u32Draws === annualDeath.deathRngBefore.u32Draws + annualDeath.u32DrawsUsed,
      sameWords(annualDeath.deathRngAfter.state, annualDeath.mortality.rngStateAfter)
    ])
  ) {
    fail("E_P3E_RNG", ANNUAL_DEATH_RNG_PATH);
  }

  // 3. pending 摘要與完整待決策事實的交叉比對
  if (!pendingFactsAgree(summary, annualDeath.pendingDecisionAfterDeath, roll, annualDeath.diedThisYear)) {
    fail("E_P3E_STATE", ANNUAL_PENDING_PATH);
  }

  return Object.freeze({
    ...copyVersions(previous),
    identity: copyIdentity(previous.identity),
    packs: copyPacks(previous.packs),
    currentYear: roll.yearAfter,
    age: roll.ageAfter,
    phase: annualPhase(annualDeath.diedThisYear, summary),
    pendingDecision: copyPendingSummary(summary),
    stats: copyStats(annualDeath.effects.stats),
    // GPT-0032-A：0–15 歲的個人財務必須是 0（effects 之後、封存之前的最後一道）。
    assets: copyAssets(normalizeP3EAssetsForAge(roll.ageAfter, annualDeath.effects.assets)),
    flags: copyFlags(annualDeath.effects.flags),
    occurrences: copyOccurrences(annualDeath.effects.occurrences),
    rng: Object.freeze({
      life: copyLifeRng(roll.lifeRngAfter),
      events: copyEventRng(selection.eventRngAfter),
      death: copyDeathRng(annualDeath.deathRngAfter)
    })
  });
}

/**
 * 決策路徑：把「已驗證的 pending previous `P3ELifeState`」＋「`P3EDecisionChoiceStage`」
 * 組裝成下一個 State 的核心業務欄位。
 *
 * 映射：八個版本欄位／`identity`／`packs` 沿用 previous（獨立凍結副本）；
 * `currentYear`／`age` **不變**；`stats`／`assets`／`flags` 取 Decision Choice Stage；
 * `occurrences` **不變**（獨立凍結副本）；三條 RNG **完全不變**（獨立凍結副本）；
 * `phase` 固定為 `"life"`；`pendingDecision` 固定為 `null`。
 *
 * 一致性防線（任一項不符 → 固定 P3-E 錯誤，**不得靜默修正**）：
 *
 * 1. previous 的 phase 必須是 `"pending_decision"`，且 `pendingDecision` 不得是 `null`；
 * 2. stage 的 `eventId`／`decisionId` 必須等於 previous 摘要的同名欄位，且
 *    `selectedOptionId` 必須屬於 previous 摘要的 `optionIds`；
 * 3. stage 的 `currentYearAfter`／`ageAfter` 必須等於 previous；
 * 4. stage 的 `pendingDecisionAfter` 必須是 `null`，`phaseAfter` 必須是 `"life"`。
 *
 * 不重查事件包、不重套 option effects：只比對 previous 摘要與已完成 stage。
 */
export function assembleP3EDecisionStateCoreDraft(
  previous: P3ELifeState,
  stage: P3EDecisionChoiceStage
): P3EStateCoreDraft {
  // 1. previous 必須真的處於待決策
  if (previous.phase !== "pending_decision") fail("E_P3E_PHASE", DECISION_PHASE_PATH);
  const pending = previous.pendingDecision;
  if (pending === null) fail("E_P3E_STATE", DECISION_PENDING_PATH);

  // 2. stage 必須對應到同一個 pending 摘要，且選項必須是合法選項之一
  if (
    !allTrue([
      stage.eventId === pending.eventId,
      stage.decisionId === pending.decisionId,
      pending.optionIds.includes(stage.selectedOptionId)
    ])
  ) {
    fail("E_P3E_DECISION", DECISION_IDENTITY_PATH);
  }

  // 3. 決策不改變年度與年齡
  if (!allTrue([stage.currentYearAfter === previous.currentYear, stage.ageAfter === previous.age])) {
    fail("E_P3E_STATE", DECISION_YEAR_AGE_PATH);
  }

  // 4. 選擇後必須清空待決策並回到 life
  if (!allTrue([stage.pendingDecisionAfter === null, stage.phaseAfter === "life"])) {
    fail("E_P3E_STATE", DECISION_AFTER_PATH);
  }

  return Object.freeze({
    ...copyVersions(previous),
    identity: copyIdentity(previous.identity),
    packs: copyPacks(previous.packs),
    currentYear: previous.currentYear,
    age: previous.age,
    phase: "life",
    pendingDecision: null,
    stats: copyStats(stage.stats),
    assets: copyAssets(stage.assets),
    flags: copyFlags(stage.flags),
    occurrences: copyOccurrences(previous.occurrences),
    rng: copyRng(previous.rng)
  });
}

/* ------------------------------------------------------------------ */
/* GPT-0029-B：人生重心（第三種命令）                                  */
/* ------------------------------------------------------------------ */

/**
 * 重心路徑：只替換 `flags` 裡的 focus 旗標，**不推進年度、不消耗 RNG、
 * 不改 phase／stats／assets／occurrences**。
 *
 * 這是刻意的最小轉移：重心是玩家的年度取向，不是一次模擬年。所有其他欄位
 * 沿用 previous（獨立深層凍結副本），因此 `materializeP3ETransition` 的
 * snapshot／delta／entry hash 仍完全由正式原語計算，且 replay 只要重送
 * 同一筆 `SET_LIFE_FOCUS` command 就會得到逐位元相同的 State。
 *
 * 輸入驗證（年齡／phase／同年至多一次）由 `command-executor` 負責；
 * 本函式只接受已驗證的 `focusId` 與 `changedYear`。
 */
export function assembleP3ELifeFocusStateCoreDraft(
  previous: P3ELifeState,
  focusId: P3ELifeFocusId,
  changedYear: number
): P3EStateCoreDraft {
  return Object.freeze({
    ...copyVersions(previous),
    identity: copyIdentity(previous.identity),
    packs: copyPacks(previous.packs),
    currentYear: previous.currentYear,
    age: previous.age,
    phase: previous.phase,
    pendingDecision: copyPendingSummary(previous.pendingDecision),
    stats: copyStats(previous.stats),
    assets: copyAssets(previous.assets),
    flags: copyFlags(replaceP3ELifeFocusFlag(previous.flags, focusId, changedYear)),
    occurrences: copyOccurrences(previous.occurrences),
    rng: copyRng(previous.rng)
  });
}
