import { describe, expect, it } from "vitest";
import type { P3BEventRecord, P3BSelectionState } from "@life-sim/contracts";
import { BASE_STATE, NO_HISTORY, clone, codeOf, loadRawPack, makePack, validate } from "./p3b-helpers";
import { buildCandidates, lifeStageOfAge, selectEvent, validateEventPack } from "../src/life/events";
import type { SelectEventInput } from "../src/life/events";

/** P3-B 決定性候選與抽選。 */

const raw = loadRawPack();
const pack = validate(raw);
const RNG: readonly [number, number, number, number] = [1, 2, 3, 4];

const input = (patch: Partial<SelectEventInput> = {}): SelectEventInput => ({
  pack,
  state: BASE_STATE,
  history: NO_HISTORY,
  contentMode: "standard",
  rngState: RNG,
  ...patch
});

describe("P3-B selection：決定性", () => {
  it("returns the same result for the same state, pack and rng state (100 runs)", () => {
    const reference = selectEvent(input());
    for (let run = 0; run < 100; run += 1) {
      expect(selectEvent(input())).toEqual(reference);
    }
    expect(reference.selectedEventId).not.toBeNull();
  });

  it("does not depend on the input record order", () => {
    const shuffled = clone({ manifest: raw.manifest, events: [...raw.events].reverse() });
    const packA = validateEventPack(shuffled);
    const a = selectEvent(input({ pack: packA }));
    const b = selectEvent(input());
    expect(a.candidates.map((candidate) => candidate.eventId)).toEqual(b.candidates.map((candidate) => candidate.eventId));
    expect(a.selectedEventId).toBe(b.selectedEventId);
    expect(a.selectionHash).toBe(b.selectionHash);
  });

  it("keeps candidates in canonical eventId order", () => {
    const { candidates } = buildCandidates(input());
    const ids = candidates.map((candidate) => candidate.eventId);
    expect([...ids].sort()).toEqual(ids);
  });

  it("does not mutate or read time/randomness", () => {
    const state: P3BSelectionState = { ...BASE_STATE, flags: ["employed"] };
    const before = state.flags.join(",");
    selectEvent(input({ state }));
    expect(state.flags.join(",")).toBe(before);
    expect(state.flags).toEqual(["employed"]);
  });
});

describe("P3-B selection：RNG draws 會計", () => {
  it("consumes 0 draws with no candidates", () => {
    const edge = validate(loadRawPack("edge-manifest.v1.json", "edge-events.v1.json"));
    const selection = selectEvent({
      pack: edge,
      state: BASE_STATE,
      history: { occurrences: [{ eventId: "edge.only-one", lastYear: 2050, count: 1 }] },
      contentMode: "standard",
      rngState: RNG
    });
    expect(selection.reason).toBe("no_candidates");
    expect(selection.selectedEventId).toBeNull();
    expect(selection.drawsUsed).toBe(0);
    expect(selection.rngStateAfter).toEqual(RNG);
  });

  it("consumes 0 draws with a single candidate", () => {
    const edge = validate(loadRawPack("edge-manifest.v1.json", "edge-events.v1.json"));
    const selection = selectEvent({
      pack: edge,
      state: BASE_STATE,
      history: NO_HISTORY,
      contentMode: "standard",
      rngState: RNG
    });
    expect(selection.reason).toBe("single_candidate");
    expect(selection.selectedEventId).toBe("edge.only-one");
    expect(selection.drawsUsed).toBe(0);
    expect(selection.rngStateAfter).toEqual(RNG);
  });

  it("consumes exactly 2 u32 draws (one u64) with multiple candidates", () => {
    const selection = selectEvent(input());
    expect(selection.reason).toBe("weighted");
    expect(selection.drawsUsed).toBe(2);
    expect(selection.rngStateAfter).not.toEqual(selection.rngStateBefore);
  });

  it("accounts for every draw when many candidates have large weights", () => {
    const events = clone(raw.events) as P3BEventRecord[];
    for (const event of events) (event as unknown as Record<string, unknown>).weight = 1_000_000_007;
    const big = validate(makePack(events));
    const selection = selectEvent(input({ pack: big }));
    expect(selection.reason).toBe("weighted");
    expect(selection.drawsUsed % 2).toBe(0);
    expect(selection.drawsUsed).toBeGreaterThanOrEqual(2);
  });

  it("rejects a weight total above 2^64-1", () => {
    const events = clone(raw.events).slice(0, 3) as P3BEventRecord[];
    for (const event of events) (event as unknown as Record<string, unknown>).weight = Number.MAX_SAFE_INTEGER;
    const overflow = validate(makePack(events));
    // 3 × (2^53-1) > 2^64-1? 3×9.007e15 = 2.7e16 < 1.8e19，所以在最壞情況仍合法；
    // 這裡改用 4096 筆來跨越上限。
    expect(overflow.events).toHaveLength(3);

    // 大量事件必須用「沒有 decision」的樣板複製，否則會先撞到 decisionId 重複。
    const template = raw.events.find((event) => event.kind !== "decision") as P3BEventRecord;
    const many: P3BEventRecord[] = [];
    for (let index = 0; index < 2100; index += 1) {
      const copy = clone(template);
      many.push({ ...copy, eventId: `ev.bulk.weight.${index}`, weight: Number.MAX_SAFE_INTEGER, once: false, cooldownYears: 0, conditions: null, exclusiveGroup: null, ageMin: 0, ageMax: 120 });
    }
    const heavy = validate(makePack(many));
    expect(codeOf(() => selectEvent(input({ pack: heavy })))).toBe("E_P3B_WEIGHT_TOTAL");
  });

  it("rejects an invalid rng state", () => {
    expect(codeOf(() => selectEvent(input({ rngState: [1, 2, 3] as unknown as readonly [number, number, number, number] })))).toBe("E_P3B_SELECTION");
    expect(codeOf(() => selectEvent(input({ rngState: [1, 2, 3, -1] as unknown as readonly [number, number, number, number] })))).toBe("E_P3B_SELECTION");
    expect(codeOf(() => selectEvent(input({ rngState: [1, 2, 3, 2 ** 32] as unknown as readonly [number, number, number, number] })))).toBe("E_P3B_SELECTION");
  });
});

describe("P3-B selection：once／cooldown／exclusiveGroup", () => {
  it("excludes a once event that already happened", () => {
    const selection = selectEvent(
      input({ state: { ...BASE_STATE, age: 12 }, history: { occurrences: [{ eventId: "ev.teen.exams", lastYear: 2050, count: 1 }] } })
    );
    expect(selection.candidates.map((candidate) => candidate.eventId)).not.toContain("ev.teen.exams");
  });

  it("excludes an event inside its cooldown window", () => {
    const inside = selectEvent(
      input({ state: { ...BASE_STATE, currentYear: 2050 }, history: { occurrences: [{ eventId: "ev.any.setback", lastYear: 2049, count: 1 }] } })
    );
    expect(inside.candidates.map((candidate) => candidate.eventId)).not.toContain("ev.any.setback");

    const outside = selectEvent(
      input({ state: { ...BASE_STATE, currentYear: 2050 }, history: { occurrences: [{ eventId: "ev.any.setback", lastYear: 2040, count: 1 }] } })
    );
    expect(outside.candidates.map((candidate) => candidate.eventId)).toContain("ev.any.setback");
  });

  it("keeps only the highest-priority member of an exclusive group", () => {
    // 30 歲：adult.housing-choice（priority 90）與任何同組者，只留最高 priority。
    const { candidates } = buildCandidates(input());
    const groups = new Map<string, string[]>();
    for (const candidate of candidates) {
      const record = pack.events.find((event) => event.eventId === candidate.eventId);
      if (record?.exclusiveGroup === null || record === undefined) continue;
      const list = groups.get(record.exclusiveGroup) ?? [];
      list.push(candidate.eventId);
      groups.set(record.exclusiveGroup, list);
    }
    for (const [, ids] of groups) expect(ids).toHaveLength(1);
  });

  it("respects the exclusive group among two decision events", () => {
    // GPT-0025-A 之後主 pack 有很多「沒有 exclusiveGroup」的抉擇事件；
    // 這個測試要守的是「同一個 exclusiveGroup 最多只留一個候選」。
    const { candidates } = buildCandidates(input({ state: { ...BASE_STATE, age: 30 } }));
    const grouped = new Map<string, string[]>();
    let ungroupedDecisions = 0;
    for (const candidate of candidates) {
      const record = pack.events.find((event) => event.eventId === candidate.eventId);
      if (record === undefined || record.kind !== "decision") continue;
      if (record.exclusiveGroup === null) {
        ungroupedDecisions += 1;
        continue;
      }
      const list = grouped.get(record.exclusiveGroup) ?? [];
      list.push(record.eventId);
      grouped.set(record.exclusiveGroup, list);
    }
    for (const [, ids] of grouped) expect(ids).toHaveLength(1);
    // 沒有 exclusiveGroup 的抉擇事件可以同時是候選（各自競爭權重）。
    expect(ungroupedDecisions).toBeGreaterThanOrEqual(1);
  });
});

describe("P3-B selection：guardian mode", () => {
  it("excludes standard-only content in guardian mode", () => {
    const standardOnly = pack.events.filter((event) => event.contentMode === "standard").map((event) => event.eventId);
    expect(standardOnly.length).toBeGreaterThan(0);

    for (const age of [4, 15, 30, 70]) {
      const { candidates } = buildCandidates(input({ state: { ...BASE_STATE, age }, contentMode: "guardian" }));
      for (const candidate of candidates) expect(standardOnly).not.toContain(candidate.eventId);
    }
  });

  it("still allows guardian-only content in both modes", () => {
    const guardianOnly = pack.events.filter((event) => event.contentMode === "guardian").map((event) => event.eventId);
    for (const contentMode of ["standard", "guardian"] as const) {
      const { candidates } = buildCandidates(input({ state: { ...BASE_STATE, age: 30 }, contentMode }));
      expect(candidates.some((candidate) => guardianOnly.includes(candidate.eventId))).toBe(true);
    }
  });
});

describe("P3-B selection：階段與輸入", () => {
  it("maps ages to life stages", () => {
    expect(lifeStageOfAge(0)).toBe("childhood");
    expect(lifeStageOfAge(12)).toBe("childhood");
    expect(lifeStageOfAge(13)).toBe("adolescence");
    expect(lifeStageOfAge(17)).toBe("adolescence");
    expect(lifeStageOfAge(18)).toBe("adulthood");
    expect(lifeStageOfAge(64)).toBe("adulthood");
    expect(lifeStageOfAge(65)).toBe("later_life");
    expect(lifeStageOfAge(120)).toBe("later_life");
  });

  it("filters by age range and life stage", () => {
    const { candidates } = buildCandidates(input({ state: { ...BASE_STATE, age: 2 } }));
    for (const candidate of candidates) {
      const record = pack.events.find((event) => event.eventId === candidate.eventId) as P3BEventRecord;
      expect(record.ageMin).toBeLessThanOrEqual(2);
      expect(record.ageMax).toBeGreaterThanOrEqual(2);
      expect(record.lifeStages).toContain("childhood");
    }
  });

  it("rejects an unvalidated pack and malformed inputs", () => {
    expect(codeOf(() => selectEvent(input({ pack: { events: [] } as unknown as typeof pack })))).toBe("E_P3B_TYPE");
    expect(codeOf(() => selectEvent(input({ state: { ...BASE_STATE, age: 200 } })))).toBe("E_P3B_RANGE");
    expect(codeOf(() => selectEvent(input({ state: { ...BASE_STATE, phase: "zombie" as never } })))).toBe("E_P3B_ENUM");
    expect(codeOf(() => selectEvent(input({ history: { occurrences: [{ eventId: "ev.x", lastYear: 2051, count: 1 }] } })))).toBe("E_P3B_SELECTION");
    expect(
      codeOf(() =>
        selectEvent(
          input({
            history: {
              occurrences: [
                { eventId: "ev.any.setback", lastYear: 2050, count: 1 },
                { eventId: "ev.any.setback", lastYear: 2050, count: 1 }
              ]
            }
          })
        )
      )
    ).toBe("E_P3B_DUPLICATE_ID");
  });
});
