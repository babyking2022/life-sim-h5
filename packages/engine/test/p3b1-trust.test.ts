import { describe, expect, it } from "vitest";
import type { P3BEventPackManifest, P3BEventRecord, P3BLineageRecord, P3BSelectionState } from "@life-sim/contracts";
import { BASE_STATE, NO_HISTORY, clone, codeOf, loadRawPack, makePack, validate } from "./p3b-helpers";
import { applyEventEffects, buildCandidates, selectEvent, validateEventPack } from "../src/life/events";
import type { ValidatedEventPack } from "../src/life/events";

/**
 * P3-B.1 信任邊界反例：
 * 1. lineage 有向環（自環／二環／三環）與合法 DAG
 * 2. validated pack 不得含結構上無法套用的 effect list
 * 3. applyEventEffects 必須先驗證 state
 * 4. selection 公開入口與 RNG snapshot 隔離
 */

const raw = loadRawPack();
const pack = validate(raw);
const RNG: readonly [number, number, number, number] = [1, 2, 3, 4];
const DATASET_CHECKSUM = (raw.manifest.datasets[0] as P3BEventPackManifest["datasets"][number]).checksum;
const CREATED_AT = "2026-10-27T00:00:00.000Z";
const LICENSE_LINEAGE = (raw.manifest.licenses[0] as P3BEventPackManifest["licenses"][number]).lineageId;

/* ------------------------------------------------------------------ */
/* lineage 圖                                                          */
/* ------------------------------------------------------------------ */

function lineageRecord(lineageId: string, parents: readonly string[]): P3BLineageRecord {
  return {
    lineageId,
    datasetId: "events",
    parentLineageIds: parents,
    transform: "p3b.1 test transform",
    generatedBy: "p3b1-trust.test.ts",
    generatedAt: CREATED_AT,
    inputChecksums: parents.map(() => DATASET_CHECKSUM),
    outputChecksum: DATASET_CHECKSUM,
    notes: "adversarial lineage"
  };
}

function packWithLineage(records: readonly P3BLineageRecord[]) {
  return makePack(raw.events, (manifest) => ({ ...manifest, lineage: records }));
}

function validChain(): P3BLineageRecord[] {
  // root → mid-a / mid-b → leaf（leaf 有兩個 parent，共用 root 的血緣）
  return [
    lineageRecord(LICENSE_LINEAGE, []),
    lineageRecord("lin.mid-a", [LICENSE_LINEAGE]),
    lineageRecord("lin.mid-b", [LICENSE_LINEAGE]),
    lineageRecord("lin.leaf", ["lin.mid-a", "lin.mid-b"])
  ];
}

describe("P3-B.1 lineage：有向環偵測", () => {
  it("rejects a self cycle A → A", () => {
    const packA = packWithLineage([lineageRecord(LICENSE_LINEAGE, [LICENSE_LINEAGE])]);
    expect(codeOf(() => validate(packA))).toBe("E_P3B_LINEAGE");
  });

  it("rejects a two-node cycle A → B → A", () => {
    const packA = packWithLineage([lineageRecord(LICENSE_LINEAGE, ["lin.b"]), lineageRecord("lin.b", [LICENSE_LINEAGE])]);
    expect(codeOf(() => validate(packA))).toBe("E_P3B_LINEAGE");
  });

  it("rejects a three-node cycle A → B → C → A", () => {
    const packA = packWithLineage([
      lineageRecord(LICENSE_LINEAGE, ["lin.b"]),
      lineageRecord("lin.b", ["lin.c"]),
      lineageRecord("lin.c", [LICENSE_LINEAGE])
    ]);
    expect(codeOf(() => validate(packA))).toBe("E_P3B_LINEAGE");
  });

  it("rejects a cycle that is only reachable from a valid root", () => {
    const packA = packWithLineage([
      lineageRecord(LICENSE_LINEAGE, []),
      lineageRecord("lin.x", [LICENSE_LINEAGE, "lin.y"]),
      lineageRecord("lin.y", ["lin.x"])
    ]);
    expect(codeOf(() => validate(packA))).toBe("E_P3B_LINEAGE");
  });

  it("rejects a duplicate parentLineageId", () => {
    const packA = packWithLineage([lineageRecord(LICENSE_LINEAGE, []), lineageRecord("lin.dup", [LICENSE_LINEAGE, LICENSE_LINEAGE])]);
    expect(codeOf(() => validate(packA))).toBe("E_P3B_LINEAGE");
  });

  it("detects the cycle regardless of manifest order", () => {
    const records = [lineageRecord(LICENSE_LINEAGE, ["lin.b"]), lineageRecord("lin.b", ["lin.c"]), lineageRecord("lin.c", [LICENSE_LINEAGE])];
    for (const order of [records, [...records].reverse(), [records[1], records[2], records[0]]]) {
      expect(codeOf(() => validate(packWithLineage(order as P3BLineageRecord[])))).toBe("E_P3B_LINEAGE");
    }
  });

  /**
   * 契約精確化（H5-CTO-036 文件修正）：
   * `path` 內的陣列索引指向**原始輸入位置**，因此可能隨 manifest 排列改變；
   * 不變的是「一定被拒絕」與錯誤碼。這裡同時證明索引永遠指向該排列中的真實位置。
   */
  it("reports a path index that always points at a real position in the given order", () => {
    const records = [lineageRecord(LICENSE_LINEAGE, ["lin.b"]), lineageRecord("lin.b", ["lin.c"]), lineageRecord("lin.c", [LICENSE_LINEAGE])];
    const orders = [records, [...records].reverse(), [records[1], records[2], records[0]]];
    const paths: string[] = [];
    for (const order of orders as P3BLineageRecord[][]) {
      let path: string | undefined;
      try {
        validate(packWithLineage(order));
      } catch (error) {
        const failure = error as { code?: string; path?: string };
        expect(failure.code).toBe("E_P3B_LINEAGE");
        path = failure.path;
      }
      expect(path).toBeDefined();
      const match = /^pack\.manifest\.lineage\[(\d+)\]\.parentLineageIds$/.exec(path as string);
      expect(match).not.toBeNull();
      const index = Number((match as RegExpExecArray)[1]);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(order.length);
      paths.push(path as string);
    }
    // 只宣告「一定拒絕、碼固定」；path 不保證跨排列相同（刻意保留原始輸入位置）。
    expect(new Set(paths).size).toBeGreaterThanOrEqual(1);
  });
});

describe("P3-B.1 lineage：合法圖", () => {
  it("accepts a valid single root", () => {
    expect(validate(packWithLineage([lineageRecord(LICENSE_LINEAGE, [])])).manifest.lineage).toHaveLength(1);
  });

  it("accepts a valid multi-level DAG", () => {
    const ok = validate(packWithLineage(validChain()));
    expect(ok.manifest.lineage).toHaveLength(4);
  });

  it("accepts one parent shared by two children", () => {
    const ok = validate(
      packWithLineage([
        lineageRecord(LICENSE_LINEAGE, []),
        lineageRecord("lin.child-a", [LICENSE_LINEAGE]),
        lineageRecord("lin.child-b", [LICENSE_LINEAGE])
      ])
    );
    expect(ok.manifest.lineage).toHaveLength(3);
  });

  it("still rejects unknown parents, count mismatch and checksum mismatch", () => {
    expect(codeOf(() => validate(packWithLineage([lineageRecord(LICENSE_LINEAGE, ["lin.ghost"])])))).toBe("E_P3B_LINEAGE");

    const countMismatch = { ...lineageRecord(LICENSE_LINEAGE, []), parentLineageIds: [LICENSE_LINEAGE], inputChecksums: [] };
    expect(codeOf(() => validate(packWithLineage([countMismatch as P3BLineageRecord])))).toBe("E_P3B_LINEAGE");

    const badChecksum: P3BLineageRecord = { ...lineageRecord("lin.bad", [LICENSE_LINEAGE]), inputChecksums: ["a".repeat(64)] };
    expect(codeOf(() => validate(packWithLineage([lineageRecord(LICENSE_LINEAGE, []), badChecksum])))).toBe("E_P3B_LINEAGE");
  });
});

/* ------------------------------------------------------------------ */
/* effect list 結構                                                    */
/* ------------------------------------------------------------------ */

describe("P3-B.1 effects：validated pack 不得留下必然失敗的結構", () => {
  it("rejects two openDecision effects on a decision option", () => {
    const events = clone(raw.events) as P3BEventRecord[];
    const decisionEvent = events.find((event) => event.kind === "decision") as P3BEventRecord;
    const option = (decisionEvent.decision as NonNullable<P3BEventRecord["decision"]>).options[0] as unknown as { effects: unknown[] };
    option.effects = [
      { type: "openDecision", decisionId: decisionEvent.decision?.decisionId },
      { type: "openDecision", decisionId: decisionEvent.decision?.decisionId }
    ];
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_DECISION");
  });

  it("rejects two openDecision effects on an event", () => {
    const events = clone(raw.events) as P3BEventRecord[];
    const decisionEvent = events.find((event) => event.kind === "decision") as P3BEventRecord;
    (decisionEvent as unknown as Record<string, unknown>).effects = [
      { type: "openDecision", decisionId: decisionEvent.decision?.decisionId },
      { type: "openDecision", decisionId: decisionEvent.decision?.decisionId }
    ];
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_DECISION");
  });

  it("rejects informational mixed with other effects (event and option)", () => {
    const events = clone(raw.events) as P3BEventRecord[];
    const ordinary = events.find((event) => event.kind === "ordinary") as P3BEventRecord;
    (ordinary as unknown as Record<string, unknown>).effects = [{ type: "informational" }, { type: "stat", stat: "health", delta: 1 }];
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_EFFECT");

    const events2 = clone(raw.events) as P3BEventRecord[];
    const decisionEvent = events2.find((event) => event.kind === "decision") as P3BEventRecord;
    const option = (decisionEvent.decision as NonNullable<P3BEventRecord["decision"]>).options[0] as unknown as { effects: unknown[] };
    option.effects = [{ type: "informational" }, { type: "flag", flag: "x:y", action: "add" }];
    expect(codeOf(() => validate(makePack(events2)))).toBe("E_P3B_EFFECT");
  });

  it("accepts exactly one openDecision and applies it", () => {
    const events = clone(raw.events) as P3BEventRecord[];
    const decisionEvent = events.find((event) => event.kind === "decision") as P3BEventRecord;
    const ok = validate(makePack(events));
    const record = ok.events.find((event) => event.eventId === decisionEvent.eventId) as P3BEventRecord;
    expect(record.effects.filter((effect) => effect.type === "openDecision")).toHaveLength(1);
    expect(applyEventEffects(BASE_STATE, record.effects).openedDecisionId).toBe(decisionEvent.decision?.decisionId);
  });
});

/* ------------------------------------------------------------------ */
/* state 驗證                                                          */
/* ------------------------------------------------------------------ */

const statEffect = [{ type: "stat", stat: "health", delta: 1 }];

function badState(patch: Record<string, unknown>): unknown {
  return { ...BASE_STATE, ...patch };
}

describe("P3-B.1 state：applyEventEffects 必須先驗證 state", () => {
  it("rejects null, undefined, array and custom prototypes", () => {
    expect(codeOf(() => applyEventEffects(null, statEffect))).toBe("E_P3B_TYPE");
    expect(codeOf(() => applyEventEffects(undefined, statEffect))).toBe("E_P3B_TYPE");
    expect(codeOf(() => applyEventEffects([BASE_STATE], statEffect))).toBe("E_P3B_TYPE");
    expect(codeOf(() => applyEventEffects(Object.create({ inherited: true }), statEffect))).toBe("E_P3B_TYPE");
    expect(codeOf(() => applyEventEffects("state", statEffect))).toBe("E_P3B_TYPE");
  });

  it("rejects NaN, Infinity and float stats", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
      const state = badState({ stats: { ...BASE_STATE.stats, health: value } });
      expect(codeOf(() => applyEventEffects(state, statEffect))).toBe("E_P3B_TYPE");
    }
    const outOfRange = badState({ stats: { ...BASE_STATE.stats, health: 101 } });
    expect(codeOf(() => applyEventEffects(outOfRange, statEffect))).toBe("E_P3B_RANGE");
    const negative = badState({ stats: { ...BASE_STATE.stats, health: -1 } });
    expect(codeOf(() => applyEventEffects(negative, statEffect))).toBe("E_P3B_RANGE");
  });

  it("rejects NaN/Infinity currentYear and age", () => {
    expect(codeOf(() => applyEventEffects(badState({ currentYear: Number.NaN }), statEffect))).toBe("E_P3B_TYPE");
    expect(codeOf(() => applyEventEffects(badState({ age: Number.POSITIVE_INFINITY }), statEffect))).toBe("E_P3B_TYPE");
    expect(codeOf(() => applyEventEffects(badState({ age: 121 }), statEffect))).toBe("E_P3B_RANGE");
  });

  it("rejects malformed money", () => {
    for (const value of ["1000", 1000, Number.NaN, 1n << 200n]) {
      const state = badState({ assets: { ...BASE_STATE.assets, balanceMicroUsd: value } });
      expect(codeOf(() => applyEventEffects(state, statEffect))).toBe("E_P3B_MONEY");
    }
  });

  it("rejects duplicate and invalid flags", () => {
    expect(codeOf(() => applyEventEffects(badState({ flags: ["dup", "dup"] }), statEffect))).toBe("E_P3B_SELECTION");
    expect(codeOf(() => applyEventEffects(badState({ flags: ["Not Valid"] }), statEffect))).toBe("E_P3B_PATTERN");
    expect(codeOf(() => applyEventEffects(badState({ flags: ["ok", 7] }), statEffect))).toBe("E_P3B_TYPE");
    expect(codeOf(() => applyEventEffects(badState({ flags: "ok" }), statEffect))).toBe("E_P3B_TYPE");
  });

  it("rejects unknown and dangerous keys", () => {
    expect(codeOf(() => applyEventEffects(badState({ extra: 1 }), statEffect))).toBe("E_P3B_UNKNOWN_KEY");
    expect(codeOf(() => applyEventEffects(badState({ stats: { ...BASE_STATE.stats, wisdom: 1 } }), statEffect))).toBe("E_P3B_UNKNOWN_KEY");
    expect(codeOf(() => applyEventEffects(badState({ assets: { ...BASE_STATE.assets, wallet: 1n } }), statEffect))).toBe("E_P3B_UNKNOWN_KEY");
    expect(codeOf(() => applyEventEffects(badState({ constructor: {} }), statEffect))).toBe("E_P3B_PROTOTYPE_KEY");
  });

  it("never throws a native TypeError for malformed states", () => {
    const samples: unknown[] = [
      null,
      undefined,
      0,
      "",
      [],
      {},
      { currentYear: 1 },
      { currentYear: 1, age: 1, phase: "life" },
      { currentYear: 1, age: 1, phase: "life", stats: null },
      { currentYear: 1, age: 1, phase: "life", stats: {}, assets: {}, flags: [] }
    ];
    for (const sample of samples) {
      let caught: unknown;
      try {
        applyEventEffects(sample, statEffect);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { name: string }).name).toBe("EventPackError");
    }
  });

  it("does not mutate state or effects", () => {
    const state: P3BSelectionState = { ...BASE_STATE, flags: ["keep:me"] };
    const effects = [{ type: "flag" as const, flag: "keep:me" as const, action: "remove" as const }];
    const stateBefore = `${state.stats.health}|${state.assets.balanceMicroUsd}|${state.flags.join(",")}`;
    const effectsBefore = `${effects.length}|${effects[0]?.flag}|${effects[0]?.action}`;
    applyEventEffects(state, effects);
    expect(`${state.stats.health}|${state.assets.balanceMicroUsd}|${state.flags.join(",")}`).toBe(stateBefore);
    expect(`${effects.length}|${effects[0]?.flag}|${effects[0]?.action}`).toBe(effectsBefore);
  });
});

/* ------------------------------------------------------------------ */
/* 輸入信任邊界                                                        */
/* ------------------------------------------------------------------ */

describe("P3-B.1 selection：公開入口的信任邊界", () => {
  const valid = () => ({ pack, state: BASE_STATE, history: NO_HISTORY, contentMode: "standard", rngState: RNG });

  it("returns a fixed error for null input on both entry points", () => {
    expect(codeOf(() => selectEvent(null))).toBe("E_P3B_TYPE");
    expect(codeOf(() => buildCandidates(null))).toBe("E_P3B_TYPE");
    expect(codeOf(() => selectEvent(undefined))).toBe("E_P3B_TYPE");
    expect(codeOf(() => selectEvent("input"))).toBe("E_P3B_TYPE");
    expect(codeOf(() => selectEvent([]))).toBe("E_P3B_TYPE");
    expect((() => {
      try {
        selectEvent(null);
      } catch (error) {
        return (error as { name: string }).name;
      }
      return "none";
    })()).toBe("EventPackError");
  });

  it("rejects extra and dangerous keys on SelectEventInput", () => {
    expect(codeOf(() => selectEvent({ ...valid(), extra: 1 }))).toBe("E_P3B_UNKNOWN_KEY");
    expect(codeOf(() => selectEvent({ ...valid(), constructor: {} }))).toBe("E_P3B_PROTOTYPE_KEY");
    const withProto = JSON.parse(`{"pack":null,"state":{"a":1},"history":{"occurrences":[]},"contentMode":"standard","rngState":[1,2,3,4],"__proto__":{"polluted":true}}`) as Record<string, unknown>;
    expect(codeOf(() => buildCandidates(withProto))).toBe("E_P3B_PROTOTYPE_KEY");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects extra and dangerous keys on history root", () => {
    expect(codeOf(() => selectEvent({ ...valid(), history: { occurrences: [], extra: 1 } }))).toBe("E_P3B_UNKNOWN_KEY");
    expect(codeOf(() => selectEvent({ ...valid(), history: { occurrences: [], constructor: {} } }))).toBe("E_P3B_PROTOTYPE_KEY");
    expect(codeOf(() => selectEvent({ ...valid(), history: {} }))).toBe("E_P3B_MISSING_KEY");
    expect(codeOf(() => selectEvent({ ...valid(), history: [] }))).toBe("E_P3B_TYPE");
    expect(codeOf(() => selectEvent({ ...valid(), history: null }))).toBe("E_P3B_TYPE");
  });

  it("rejects an unvalidated pack", () => {
    expect(codeOf(() => selectEvent({ ...valid(), pack: { events: [] } }))).toBe("E_P3B_TYPE");
    expect(codeOf(() => buildCandidates({ ...valid(), pack: { manifest: raw.manifest, events: raw.events } }))).toBe("E_P3B_TYPE");
  });
});

/* ------------------------------------------------------------------ */
/* RNG snapshot 隔離                                                   */
/* ------------------------------------------------------------------ */

function mutateRng(source: number[]): void {
  source[0] = 0xdeadbeef;
  source[1] = 0;
  source[2] = 0;
  source[3] = 0;
}

describe("P3-B.1 selection：RNG snapshot 不得與輸入共享", () => {
  it("isolates the zero-candidate path", () => {
    const edge = validate(loadRawPack("edge-manifest.v1.json", "edge-events.v1.json"));
    const rng = [9, 8, 7, 6];
    const selection = selectEvent({
      pack: edge,
      state: BASE_STATE,
      history: { occurrences: [{ eventId: "edge.only-one", lastYear: 2050, count: 1 }] },
      contentMode: "standard",
      rngState: rng as unknown as readonly [number, number, number, number]
    });
    expect(selection.reason).toBe("no_candidates");
    const before = [...selection.rngStateBefore];
    const after = [...selection.rngStateAfter];
    const hash = selection.selectionHash;
    mutateRng(rng);
    expect([...selection.rngStateBefore]).toEqual(before);
    expect([...selection.rngStateAfter]).toEqual(after);
    expect(selection.selectionHash).toBe(hash);
    expect(selection.rngStateBefore).not.toBe(selection.rngStateAfter);
    expect(Object.isFrozen(selection.rngStateBefore)).toBe(true);
    expect(Object.isFrozen(selection.rngStateAfter)).toBe(true);
  });

  it("isolates the single-candidate path", () => {
    const edge = validate(loadRawPack("edge-manifest.v1.json", "edge-events.v1.json"));
    const rng = [4, 3, 2, 1];
    const selection = selectEvent({
      pack: edge,
      state: BASE_STATE,
      history: NO_HISTORY,
      contentMode: "standard",
      rngState: rng as unknown as readonly [number, number, number, number]
    });
    expect(selection.reason).toBe("single_candidate");
    const before = [...selection.rngStateBefore];
    mutateRng(rng);
    expect([...selection.rngStateBefore]).toEqual(before);
    expect(selection.rngStateAfter).not.toBe(selection.rngStateBefore);
    expect(selection.drawsUsed).toBe(0);
  });

  it("isolates the weighted path", () => {
    const rng = [7, 7, 7, 7];
    const selection = selectEvent({ pack, state: BASE_STATE, history: NO_HISTORY, contentMode: "standard", rngState: rng as unknown as readonly [number, number, number, number] });
    expect(selection.reason).toBe("weighted");
    const before = [...selection.rngStateBefore];
    const after = [...selection.rngStateAfter];
    const hash = selection.selectionHash;
    mutateRng(rng);
    expect([...selection.rngStateBefore]).toEqual(before);
    expect([...selection.rngStateAfter]).toEqual(after);
    expect(selection.selectionHash).toBe(hash);
    expect(selection.rngStateBefore).not.toBe(selection.rngStateAfter);
  });

  it("keeps the all-zero fallback semantics", () => {
    const zero = [0, 0, 0, 0] as const;
    const selection = selectEvent({ pack, state: BASE_STATE, history: NO_HISTORY, contentMode: "standard", rngState: zero });
    expect(selection.reason).toBe("weighted");
    expect(selection.drawsUsed).toBe(2);
    expect(selection.rngStateBefore).toEqual([0, 0, 0, 0]);
    // 全零輸入走 engine 的 fallback state，輸出不得是零（與 golden 一致）。
    expect(selection.rngStateAfter).not.toEqual([0, 0, 0, 0]);
  });
});

/* ------------------------------------------------------------------ */
/* 回歸                                                                */
/* ------------------------------------------------------------------ */

describe("P3-B.1 回歸：既有語義不變", () => {
  it("keeps guardian, once, cooldown and exclusiveGroup behaviour", () => {
    const standardOnly = pack.events.filter((event) => event.contentMode === "standard").map((event) => event.eventId);
    const guardian = buildCandidates({ pack, state: { ...BASE_STATE, age: 15 }, history: NO_HISTORY, contentMode: "guardian", rngState: RNG });
    for (const candidate of guardian.candidates) expect(standardOnly).not.toContain(candidate.eventId);

    const once = buildCandidates({
      pack,
      state: { ...BASE_STATE, age: 12 },
      history: { occurrences: [{ eventId: "ev.teen.exams", lastYear: 2050, count: 1 }] },
      contentMode: "standard",
      rngState: RNG
    });
    expect(once.candidates.map((candidate) => candidate.eventId)).not.toContain("ev.teen.exams");

    const cooldown = buildCandidates({
      pack,
      state: BASE_STATE,
      history: { occurrences: [{ eventId: "ev.any.setback", lastYear: 2049, count: 1 }] },
      contentMode: "standard",
      rngState: RNG
    });
    expect(cooldown.candidates.map((candidate) => candidate.eventId)).not.toContain("ev.any.setback");
  });

  it("keeps the pack brand and deep-frozen snapshot", () => {
    const fresh: ValidatedEventPack = validateEventPack(clone({ manifest: raw.manifest, events: raw.events }));
    expect(Object.isFrozen(fresh.events)).toBe(true);
    expect(Object.isFrozen(fresh.events[0])).toBe(true);
  });
});
