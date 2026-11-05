import {
  P3B_CONTENT_MODES,
  P3B_MAX_TOTAL_WEIGHT,
  type P3BEventHistory,
  type P3BCandidate,
  type P3BContentMode,
  type P3BEventOccurrence,
  type P3BEventRecord,
  type P3BLifeStage,
  type P3BSelection,
  type P3BSelectionState
} from "@life-sim/contracts";
import { canonicalBytes } from "../../canonical/canonical";
import { sha256Hex } from "../../rng/sha256";
import { uniformBigIntFrom, Xoshiro128StarStar } from "../../rng/xoshiro128";
import { evaluateCondition } from "./conditions";
import { fail } from "./errors";
import { readArray, readEnum, readExactObject, readInt, readString } from "./schema";
import { readSelectionState } from "./state";
import { isValidatedEventPack, type ValidatedEventPack } from "./validate";

/**
 * 決定性候選與抽選。
 *
 * 規則（契約 §5）：
 * 1. 候選＝canonical（eventId 升冪）排序後依序過濾，輸入排列不影響結果。
 * 2. 過濾順序：contentMode → 年齡 → 人生階段 → 條件樹 → once → cooldown → exclusiveGroup。
 * 3. 權重只用安全整數，總和以 BigInt 累加；總和 ≤ 2^64-1，否則 `E_P3B_WEIGHT_TOTAL`。
 * 4. RNG：0 候選 0 draws；1 候選 0 draws；≥2 候選呼叫一次 `uniformBigInt`（每次 u64 ＝ 2 個 u32 draws）。
 */

const EVENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const MAX_HISTORY_YEAR = 100_000;

export interface SelectEventInput {
  readonly pack: ValidatedEventPack;
  readonly state: P3BSelectionState;
  readonly history: P3BEventHistory;
  readonly contentMode: P3BContentMode;
  readonly rngState: readonly [number, number, number, number];
}

export function lifeStageOfAge(age: number): P3BLifeStage {
  if (age <= 12) return "childhood";
  if (age <= 17) return "adolescence";
  if (age <= 64) return "adulthood";
  return "later_life";
}

/* ------------------------------------------------------------------ */
/* 輸入驗證                                                            */
/* ------------------------------------------------------------------ */

/** 回傳新的四字 tuple；呼叫端之後修改自己的陣列不影響輸出。 */
function readRngState(value: unknown): readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) fail("E_P3B_SELECTION", "input.rngState");
  const words: number[] = [];
  for (const word of value as readonly unknown[]) {
    if (typeof word !== "number" || !Number.isInteger(word) || word < 0 || word > 0xffffffff) {
      fail("E_P3B_SELECTION", "input.rngState");
    }
    words.push(word);
  }
  return [words[0] as number, words[1] as number, words[2] as number, words[3] as number];
}

/** 輸出一律給新的（凍結的）tuple，避免與輸入或其他欄位共享可變陣列。 */
function frozenRngState(values: readonly [number, number, number, number]): readonly [number, number, number, number] {
  return Object.freeze([values[0], values[1], values[2], values[3]]) as readonly [number, number, number, number];
}
function readHistory(value: unknown, currentYear: number): readonly P3BEventOccurrence[] {
  const path = "input.history";
  const node = readExactObject(value, path, ["occurrences"]);
  const occurrences = readArray(node.occurrences, `${path}.occurrences`, 0, 4096).map((entry, index) => {
    const entryPath = `${path}.occurrences[${index}]`;
    const occurrence = readExactObject(entry, entryPath, ["eventId", "lastYear", "count"]);
    return {
      eventId: readString(occurrence.eventId, `${entryPath}.eventId`, { min: 3, max: 64, pattern: EVENT_ID_PATTERN }),
      lastYear: readInt(occurrence.lastYear, `${entryPath}.lastYear`, 0, MAX_HISTORY_YEAR),
      count: readInt(occurrence.count, `${entryPath}.count`, 1, 1_000_000)
    } satisfies P3BEventOccurrence;
  });
  const ids = new Set<string>();
  for (const occurrence of occurrences) {
    if (ids.has(occurrence.eventId)) fail("E_P3B_DUPLICATE_ID", `${path}.occurrences`);
    ids.add(occurrence.eventId);
    if (occurrence.lastYear > currentYear) fail("E_P3B_SELECTION", `${path}.occurrences`);
  }
  // canonical 排序（lookup 用；不改語義）。
  return [...occurrences].sort((left, right) => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* 候選                                                                */
/* ------------------------------------------------------------------ */

export interface CandidateContext {
  readonly pack: ValidatedEventPack;
  readonly state: P3BSelectionState;
  readonly contentMode: P3BContentMode;
  readonly occurrences: readonly P3BEventOccurrence[];
}

function occurrenceOf(context: CandidateContext, eventId: string): P3BEventOccurrence | null {
  for (const entry of context.occurrences) {
    if (entry.eventId === eventId) return entry;
    if (entry.eventId > eventId) break;
  }
  return null;
}

function passesFilters(context: CandidateContext, event: P3BEventRecord): boolean {
  // 1. 內容模式：守護模式完全排除 standard 內容。
  if (context.contentMode === "guardian" && event.contentMode !== "guardian") return false;
  // 2. 年齡範圍。
  if (context.state.age < event.ageMin || context.state.age > event.ageMax) return false;
  // 3. 人生階段。
  if (!event.lifeStages.includes(lifeStageOfAge(context.state.age))) return false;
  // 4. 條件樹。
  if (event.conditions !== null && !evaluateCondition(event.conditions, context)) return false;
  // 5. once。
  const occurrence = occurrenceOf(context, event.eventId);
  if (event.once && occurrence !== null) return false;
  // 6. cooldown。
  if (occurrence !== null && event.cooldownYears > 0 && context.state.currentYear - occurrence.lastYear < event.cooldownYears) return false;
  return true;
}

/** 頂層信任邊界：exact object，先驗證再讀任何屬性。 */
function readSelectInput(value: unknown): SelectEventInput {
  const node = readExactObject(value, "input", ["pack", "state", "history", "contentMode", "rngState"]);
  return {
    pack: node.pack as SelectEventInput["pack"],
    state: node.state as SelectEventInput["state"],
    history: node.history as SelectEventInput["history"],
    contentMode: node.contentMode as SelectEventInput["contentMode"],
    rngState: node.rngState as SelectEventInput["rngState"]
  };
}

/** 篩選並 canonical 排序（eventId 升冪）。 */
export function buildCandidates(input: unknown): { readonly candidates: readonly P3BCandidate[]; readonly context: CandidateContext } {
  const bound = readSelectInput(input);
  const pack = bound.pack;
  if (!isValidatedEventPack(pack)) fail("E_P3B_TYPE", "input.pack");
  const state = readSelectionState(bound.state);
  const contentMode = readEnum(bound.contentMode, "input.contentMode", P3B_CONTENT_MODES);
  const occurrences = readHistory(bound.history, state.currentYear);
  const context: CandidateContext = { pack, state, contentMode, occurrences };

  const eligible: P3BEventRecord[] = [];
  for (const event of pack.events) if (passesFilters(context, event)) eligible.push(event);

  // exclusiveGroup 分組（先依 group 找最佳，再過濾）。
  const groupBest = new Map<string, P3BEventRecord>();
  for (const event of eligible) {
    if (event.exclusiveGroup === null) continue;
    const current = groupBest.get(event.exclusiveGroup);
    if (current === undefined || event.priority > current.priority) groupBest.set(event.exclusiveGroup, event);
  }
  const candidates: P3BCandidate[] = [];
  for (const event of eligible) {
    if (event.exclusiveGroup !== null && groupBest.get(event.exclusiveGroup)?.eventId !== event.eventId) continue;
    candidates.push({ eventId: event.eventId, weight: event.weight, priority: event.priority });
  }
  return { candidates, context };
}

/* ------------------------------------------------------------------ */
/* 抽選                                                                */
/* ------------------------------------------------------------------ */

function totalWeight(candidates: readonly P3BCandidate[]): bigint {
  let total = 0n;
  for (const candidate of candidates) total += BigInt(candidate.weight);
  if (total > P3B_MAX_TOTAL_WEIGHT) fail("E_P3B_WEIGHT_TOTAL", "input.pack");
  return total;
}

function selectionHash(input: {
  packChecksum: string;
  contentMode: P3BContentMode;
  state: P3BSelectionState;
  candidates: readonly P3BCandidate[];
  selectedEventId: string | null;
  drawsUsed: number;
  rngStateAfter: readonly number[];
}): string {
  return sha256Hex(
    canonicalBytes({
      packChecksum: input.packChecksum,
      contentMode: input.contentMode,
      currentYear: input.state.currentYear,
      age: input.state.age,
      phase: input.state.phase,
      candidates: input.candidates.map((candidate) => ({
        eventId: candidate.eventId,
        weight: candidate.weight,
        priority: candidate.priority
      })),
      selectedEventId: input.selectedEventId,
      drawsUsed: input.drawsUsed,
      rngStateAfter: [...input.rngStateAfter]
    } as never)
  );
}

/** 唯一抽選入口：純函數（不修改 input、不使用時間／Math.random）。 */
export function selectEvent(input: unknown): P3BSelection {
  const bound = readSelectInput(input);
  const rngStateBefore = readRngState(bound.rngState);
  const { candidates, context } = buildCandidates(bound);

  if (candidates.length === 0) {
    return {
      candidates,
      selectedEventId: null,
      reason: "no_candidates",
      drawsUsed: 0,
      rngStateBefore: frozenRngState(rngStateBefore),
      rngStateAfter: frozenRngState(rngStateBefore),
      selectionHash: selectionHash({
        packChecksum: bound.pack.packChecksum,
        contentMode: context.contentMode,
        state: context.state,
        candidates,
        selectedEventId: null,
        drawsUsed: 0,
        rngStateAfter: rngStateBefore
      })
    };
  }

  if (candidates.length === 1) {
    const only = candidates[0] as P3BCandidate;
    return {
      candidates,
      selectedEventId: only.eventId,
      reason: "single_candidate",
      drawsUsed: 0,
      rngStateBefore: frozenRngState(rngStateBefore),
      rngStateAfter: frozenRngState(rngStateBefore),
      selectionHash: selectionHash({
        packChecksum: bound.pack.packChecksum,
        contentMode: context.contentMode,
        state: context.state,
        candidates,
        selectedEventId: only.eventId,
        drawsUsed: 0,
        rngStateAfter: rngStateBefore
      })
    };
  }

  const total = totalWeight(candidates);
  const rng = new Xoshiro128StarStar(rngStateBefore);
  let drawsUsed = 0;
  const draw = uniformBigIntFrom(() => {
    // nextU64 內部呼叫兩次 nextU32，因此一次嘗試＝2 個 u32 draws。
    drawsUsed += 2;
    return rng.nextU64();
  }, total);

  let cumulative = 0n;
  let selected: P3BCandidate | null = null;
  for (const candidate of candidates) {
    cumulative += BigInt(candidate.weight);
    if (draw < cumulative) {
      selected = candidate;
      break;
    }
  }
  if (selected === null) fail("E_P3B_SELECTION", "input.pack");

  const rngStateAfter = rng.state;
  return {
    candidates,
    selectedEventId: selected.eventId,
    reason: "weighted",
    drawsUsed,
    rngStateBefore: frozenRngState(rngStateBefore),
    rngStateAfter: frozenRngState(rngStateAfter),
    selectionHash: selectionHash({
      packChecksum: bound.pack.packChecksum,
      contentMode: context.contentMode,
      state: context.state,
      candidates,
      selectedEventId: selected.eventId,
      drawsUsed,
      rngStateAfter
    })
  };
}

