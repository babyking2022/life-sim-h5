import {
  P3A_DECISION_AGES,
  P3B_MAX_AGE,
  type P3AStats,
  type P3BEffect,
  type P3BEventOccurrence,
  type P3BEventRecord,
  type P3CYearDelta,
  type P3CYearEventRecord,
  type P3CLifeState
} from "@life-sim/contracts";
import { asPppMicro, moneyAdd, moneySub } from "../../money";
import { Xoshiro128StarStar } from "../../rng/xoshiro128";
import { applyEventEffects } from "../events/effects";
import { selectEvent } from "../events/select";
import type { ValidatedEventPack } from "../events/validate";
import { applyEffectOutcome, noEventOutcome, type EffectFacts } from "./effects-adapter";
import { fail } from "./errors";
import {
  assertEventLifeInvariants,
  assertPackBinding,
  clampStat,
  computeEventYearDeltaHash,
  computeEventYearEntryHash,
  computeEventYearSnapshotHash,
  computeSelectionHash,
  eventLifeProjectionHash,
  occurrenceDigestOf,
  P3C_RNG_DRAWS_PER_YEAR,
  sealEventLifeState
} from "./state";

/**
 * 年度原子交易（事件版）。
 *
 * 一次交易依序完成：
 * 1. 驗證 pre-state、pack 綁定；
 * 2. 年度 roll（與 P3-A 完全相同的四狀態／收支規則，人生 RNG 4 抽）；
 * 3. 以 roll 後狀態 + 權威 occurrences 建立候選並決定性抽選（事件 RNG 自己的游標）；
 * 4. 產生 `selectionHash`（綁 pre-stateHash／rollStateHash／occurrenceDigest／packChecksum／selected／RNG／draws）；
 * 5. 套用普通事件 effects，或建立 pending event decision；
 * 6. 更新 occurrences；
 * 7. 產生年度 delta（entry／snapshot／card／event 全部進 deltaHash）；
 * 8. 更新 RNG、stateHash、hashChain；
 * 9. 完成全部不變量驗證後一次回傳。
 *
 * 任一步失敗都**不會**回傳任何部分結果：這個函式是純函式，輸入 state 不會被修改。
 */

/** 故障注入點（測試專用；不從 barrel 匯出）。 */
export const ANNUAL_EVENT_STAGES = ["after_roll", "after_selection", "after_effects", "after_occurrence", "before_commit"] as const;
export type AnnualEventStage = (typeof ANNUAL_EVENT_STAGES)[number];

let injectedStage: AnnualEventStage | null = null;

/** 測試專用：讓年度交易在指定階段失敗一次（每次交易都會觸發，直到設回 null）。 */
export function setAnnualEventFailureInjectionForTests(stage: AnnualEventStage | null): void {
  if (stage !== null && !(ANNUAL_EVENT_STAGES as readonly string[]).includes(stage)) fail("E_P3C_ARGUMENT", "stage");
  injectedStage = stage;
}

function tripped(stage: AnnualEventStage): void {
  if (injectedStage === stage) fail("E_P3C_STATE", `injection:${stage}`);
}

export interface AnnualEventTransactionResult {
  readonly state: P3CLifeState;
  readonly delta: P3CYearDelta;
}

/** 候選在 pack 內以 `eventId` 升冪排序，因此用二分搜尋取值。 */
function findEvent(pack: ValidatedEventPack, eventId: string): P3BEventRecord | null {
  let low = 0;
  let high = pack.events.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const event = pack.events[mid] as P3BEventRecord;
    if (event.eventId === eventId) return event;
    if (event.eventId < eventId) low = mid + 1;
    else high = mid - 1;
  }
  return null;
}

function totalWeightOf(candidates: readonly { readonly weight: number }[]): bigint {
  let total = 0n;
  for (const candidate of candidates) total += BigInt(candidate.weight);
  return total;
}

function upsertOccurrence(occurrences: readonly P3BEventOccurrence[], eventId: string, year: number): readonly P3BEventOccurrence[] {
  const next: P3BEventOccurrence[] = [];
  let placed = false;
  for (const entry of occurrences) {
    if (entry.eventId === eventId) {
      next.push({ eventId, count: entry.count + 1, lastYear: year });
      placed = true;
      continue;
    }
    if (!placed && entry.eventId > eventId) {
      next.push({ eventId, count: 1, lastYear: year });
      placed = true;
    }
    next.push({ eventId: entry.eventId, count: entry.count, lastYear: entry.lastYear });
  }
  if (!placed) next.push({ eventId, count: 1, lastYear: year });
  return next;
}

function skeletonDecision(year: number, sequence: number): {
  decisionId: string;
  year: number;
  prompt: string;
  options: readonly { optionId: string; label: string; effects: readonly P3BEffect[] }[];
  selectedOptionId: null;
  source: "skeleton";
  eventId: string;
  selectionHash: string;
  occurrenceDigestBefore: string;
} {
  return {
    decisionId: `decision-${year}`,
    year,
    prompt: `第 ${year} 年：skeleton 抉擇`,
    options: [
      { optionId: "steady", label: "維持現狀（skeleton）", effects: [] },
      { optionId: "bold", label: "嘗試改變（skeleton）", effects: [] }
    ],
    selectedOptionId: null,
    source: "skeleton",
    // skeleton 抉擇不是事件產生的：用固定的 sentinel 讓欄位形狀一致、且可被明確辨識。
    eventId: `skeleton.decision.${sequence}`,
    selectionHash: "0".repeat(64),
    occurrenceDigestBefore: "0".repeat(64)
  };
}

/**
 * 年度交易核心：呼叫端必須先驗證邊界狀態（公開入口或已驗證的指令鏈）。
 */
export function resolveEventYearCore(state: P3CLifeState, pack: ValidatedEventPack): AnnualEventTransactionResult {
  assertPackBinding(state, pack);
  if (state.phase !== "life") fail("E_P3C_PHASE");
  if (state.pendingDecision !== null) fail("E_P3C_PHASE");

  const newAge = state.age + 1;
  const newYear = state.currentYear + 1;
  if (!Number.isSafeInteger(newAge) || !Number.isSafeInteger(newYear)) fail("E_P3C_STATE");

  const preStateHash = state.stateHash;

  /* 1) 年度 roll：與 P3-A 完全相同的規則（人生 RNG 固定 4 抽）。 */
  const lifeRng = new Xoshiro128StarStar(state.rng.state);
  const healthDelta = lifeRng.uniformInt(-3, 3);
  const happinessDelta = lifeRng.uniformInt(-3, 3);
  const knowledgeDelta = lifeRng.uniformInt(0, 3);
  const relationshipsDelta = lifeRng.uniformInt(-2, 2);
  const rolledStats: P3AStats = {
    health: clampStat(state.stats.health + healthDelta),
    happiness: clampStat(state.stats.happiness + happinessDelta),
    knowledge: clampStat(state.stats.knowledge + knowledgeDelta),
    relationships: clampStat(state.stats.relationships + relationshipsDelta)
  };
  const income = asPppMicro(1_000_000n + BigInt(newAge) * 100_000n);
  const expense = asPppMicro(600_000n + BigInt(newAge) * 50_000n);
  const rawBalance = moneySub(moneyAdd(asPppMicro(state.assets.balanceMicroUsd), income), expense);
  const balance = rawBalance < 0n ? asPppMicro(0n) : asPppMicro(rawBalance);
  const rolledAssets = { balanceMicroUsd: balance, annualIncomeMicroUsd: income, annualExpenseMicroUsd: expense };

  const rolled: P3CLifeState = {
    ...state,
    currentYear: newYear,
    age: newAge,
    stats: rolledStats,
    assets: rolledAssets,
    rng: { domain: "life", state: lifeRng.state, draws: state.rng.draws + P3C_RNG_DRAWS_PER_YEAR }
  };
  const rollStateHash = eventLifeProjectionHash(rolled);
  tripped("after_roll");

  /* 2) 候選與決定性抽選：候選來自 roll 後狀態 + 權威 occurrences。 */
  const occurrencesBefore = state.events.occurrences;
  const occurrenceDigestBefore = occurrenceDigestOf(occurrencesBefore);
  const selectionState = {
    currentYear: newYear,
    age: newAge,
    phase: "life" as const,
    stats: rolledStats,
    assets: rolledAssets,
    flags: [...state.flags]
  };
  // 事件契約只涵蓋 0..P3B_MAX_AGE 歲；超出範圍一律固定「無候選、0 draws、RNG 不動」，
  // 這樣 10,000 年 benchmark 不會被事件 DSL 的年齡上限擋住，語義也不會漂移。
  const beyondEventRange = newAge > P3B_MAX_AGE;
  const selection = beyondEventRange
    ? {
        candidates: [] as readonly { eventId: string; weight: number; priority: number }[],
        selectedEventId: null,
        reason: "age_out_of_range" as const,
        drawsUsed: 0,
        rngStateBefore: state.events.rng.state,
        rngStateAfter: state.events.rng.state,
        selectionHash: "0".repeat(64)
      }
    : selectEvent({
        pack,
        state: selectionState,
        history: { occurrences: occurrencesBefore },
        contentMode: state.events.contentMode,
        rngState: state.events.rng.state
      });
  tripped("after_selection");

  /* 3) selectionHash：綁定 pre-state、roll-state、occurrenceDigest、packChecksum、結果、RNG、draws。 */
  const selectionHash = computeSelectionHash({
    binding: state.events.binding,
    contentMode: state.events.contentMode,
    preStateHash,
    rollStateHash,
    occurrenceDigest: occurrenceDigestBefore,
    year: newYear,
    age: newAge,
    phase: "life",
    candidates: selection.candidates,
    selectedEventId: selection.selectedEventId,
    reason: selection.reason,
    eventSelectionDigest: selection.selectionHash,
    drawsUsed: selection.drawsUsed,
    rngStateBefore: selection.rngStateBefore,
    rngStateAfter: selection.rngStateAfter
  });

  /* 4) 套用事件 effects 或建立 pending decision。 */
  const facts: EffectFacts = { stats: rolledStats, assets: rolledAssets, flags: [...state.flags] };
  let stats = rolledStats;
  let assets: EffectFacts["assets"] = rolledAssets;
  let flags: readonly string[] = [...state.flags];
  let occurrencesAfter: readonly P3BEventOccurrence[] = occurrencesBefore;
  let openedDecisionId: string | null = null;
  let openedOptions: readonly { optionId: string; label: string; effects: readonly P3BEffect[] }[] = [];
  let openedDecisionIdFromEvent: string | null = null;
  let outcome = noEventOutcome();

  const selectedEventId = selection.selectedEventId;
  if (selectedEventId !== null) {
    const event = findEvent(pack, selectedEventId);
    if (event === null) fail("E_P3C_PACK", "pack.events");
    const effectOutcome = applyEventEffects(selectionState, event.effects);
    const applied = applyEffectOutcome(facts, effectOutcome);
    stats = applied.stats;
    assets = applied.assets;
    flags = applied.flags;
    outcome = applied.outcome;
    openedDecisionId = applied.openedDecisionId;
    if (event.decision !== null) {
      if (openedDecisionId !== event.decision.decisionId) fail("E_P3C_DECISION", "pack.events");
      openedDecisionIdFromEvent = event.decision.decisionId;
      openedOptions = event.decision.options.map((option) => ({ optionId: option.optionId, label: option.labelKey, effects: option.effects }));
    } else if (openedDecisionId !== null) {
      fail("E_P3C_DECISION", "pack.events");
    }
    occurrencesAfter = upsertOccurrence(occurrencesBefore, selectedEventId, newYear);
  }
  tripped("after_effects");

  const occurrenceDigestAfter = occurrenceDigestOf(occurrencesAfter);
  tripped("after_occurrence");

  /* 5) phase：死亡優先，其次事件抉擇，最後才是 P3-A 的 skeleton 抉擇年齡。 */
  const diesThisYear = newAge >= state.lifespanYears;
  let phase: P3CLifeState["phase"];
  let pendingDecision: P3CLifeState["pendingDecision"] = null;
  if (diesThisYear) {
    phase = "death";
  } else if (openedDecisionIdFromEvent !== null) {
    phase = "pending_decision";
    pendingDecision = {
      decisionId: openedDecisionIdFromEvent,
      year: newYear,
      prompt: `第 ${newYear} 年：事件抉擇`,
      options: openedOptions.map((option) => ({
        optionId: option.optionId,
        label: option.label,
        effects: option.effects
      })),
      selectedOptionId: null,
      source: "event",
      eventId: selectedEventId as string,
      selectionHash,
      occurrenceDigestBefore
    };
  } else if (P3A_DECISION_AGES.includes(newAge)) {
    phase = "pending_decision";
    // skeleton 抉擇沿用 P3-A 的形狀，但欄位補齊（eventId／selectionHash／occurrenceDigestBefore 用 sentinel）。
    pendingDecision = skeletonDecision(newYear, newAge);
  } else {
    phase = "life";
  }

  /* 6) 年度 delta 與 three-rolling hash。 */
  const seq = state.history.yearsRecorded + 1;
  const entryId = `year-${newYear}`;
  const summary =
    selectedEventId === null
      ? `skeleton 年度交易：${newYear}（age ${newAge}）`
      : `skeleton 年度交易：${newYear}（age ${newAge}）event=${selectedEventId}`;
  const card = {
    cardId: `year-${newYear}`,
    year: newYear,
    kind: (phase === "pending_decision" ? "decision" : "summary") as "decision" | "summary",
    title: `第 ${newYear} 年（skeleton）`
  };
  // P3-C.1：snapshot 必須反映「事件套用後」的最終權威 state，
  // 因此 balance 一律取最終 assets（不是事件 effects 前的 roll 餘額）。
  const balanceText = assets.balanceMicroUsd.toString();

  const totalWeight = totalWeightOf(selection.candidates);
  const eventRecord: P3CYearEventRecord = {
    eventId: selectedEventId,
    reason: selection.reason,
    drawsUsed: selection.drawsUsed,
    rngStateBefore: selection.rngStateBefore,
    rngStateAfter: selection.rngStateAfter,
    selectionHash,
    occurrenceDigestBefore,
    occurrenceDigestAfter,
    candidateCount: selection.candidates.length,
    totalWeight: totalWeight.toString(),
    outcome
  };

  const entryHash = computeEventYearEntryHash(state.history.lastEntryHash, { seq, year: newYear, age: newAge, entryId, summary });
  const snapshotHash = computeEventYearSnapshotHash(state.history.lastSnapshotHash, {
    year: newYear,
    age: newAge,
    stats,
    balanceMicroUsd: balanceText,
    phase
  });
  const deltaHash = computeEventYearDeltaHash(state.history.lastDeltaHash, {
    entry: { seq, year: newYear, age: newAge, entryId, summary, entryHash },
    snapshot: { year: newYear, age: newAge, stats, balanceMicroUsd: balanceText, phase, snapshotHash },
    card,
    event: eventRecord
  });
  tripped("before_commit");

  const next = sealEventLifeState({
    ...state,
    currentYear: newYear,
    age: newAge,
    phase,
    errorCode: null,
    pendingDecision,
    stats,
    assets,
    flags,
    rng: { domain: "life", state: lifeRng.state, draws: state.rng.draws + P3C_RNG_DRAWS_PER_YEAR },
    events: {
      binding: state.events.binding,
      contentMode: state.events.contentMode,
      occurrences: occurrencesAfter,
      // P3-C.1：只更新 current state 與 draws；genesis initialState 永遠不變。
      rng: {
        domain: "events",
        initialState: state.events.rng.initialState,
        state: selection.rngStateAfter,
        draws: state.events.rng.draws + selection.drawsUsed
      }
    },
    history: {
      yearsRecorded: seq,
      cardsTotal: state.history.cardsTotal + 1,
      lastEntryHash: entryHash,
      lastSnapshotHash: snapshotHash,
      lastDeltaHash: deltaHash,
      initialStateHash: state.history.initialStateHash
    },
    playback: { ...state.playback, mode: phase === "life" ? state.playback.mode : "paused" }
  });

  // 提交前最後一次完整不變量驗證（hash 已在上面算過，這裡不再重算）。
  assertEventLifeInvariants(next, false);

  const delta: P3CYearDelta = {
    year: newYear,
    age: newAge,
    card,
    logEntry: { seq, year: newYear, age: newAge, entryId, summary, entryHash },
    snapshot: { year: newYear, age: newAge, stats, balanceMicroUsd: balanceText, phase, snapshotHash },
    event: eventRecord,
    deltaHash
  };
  return { state: next, delta };
}

/** 公開年度入口：先驗證 pre-state，再跑交易。 */
export function resolveEventLifeYear(state: unknown, pack: unknown): AnnualEventTransactionResult {
  assertEventLifeInvariants(state);
  assertPackBinding(state, pack);
  return resolveEventYearCore(state, pack as ValidatedEventPack);
}
