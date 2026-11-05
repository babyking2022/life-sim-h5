import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPeerGroup,
  createBirthCertificate,
  validateDataPack,
  validateDeathPack,
  validateIdentityPack
} from "@life-sim/birth";
import { validateEventPack } from "@life-sim/engine";
import {
  type P3EAssets,
  type P3EEventOccurrence,
  type P3EHex64,
  type P3ELifeState,
  type P3EPendingDecisionSummary,
  type P3EPhase,
  type P3ERngState,
  type P3EStats
} from "@life-sim/contracts";
import * as simulation from "../src/index";
import { computeP3EStateHash } from "../src/state-hash";
import { createP3EGenesis } from "../src/genesis";
import {
  computeP3ECommandHash,
  computeP3EDeltaHash,
  computeP3EYearChainHash,
  computeP3EYearEntryHash,
  computeP3ESnapshotHash,
  type P3EYearDeltaHashInput,
  type P3EYearSnapshotHashInput
} from "../src/year-ledger-hash";

/**
 * P3-E Ledger Hash Kernel V2.2 正式測試（H5-CTO-117-A 整合）。
 *
 * 來源：WorkBuddy 候選 `year-ledger-hash-kernel-v22-candidate.test.ts`
 * （SHA-256 `6c738fc2c39084143b354297f947c8c01c233436a4e65d612df828259ebd58fa`，
 * 經 H5-CTO-116 核准）。正式化的三處修正：
 *
 * 1. import 與靜態掃描路徑改指正式檔 `src/year-ledger-hash.ts`；
 * 2. 四個 `as unknown as P3ELifeState` 雙重斷言全部移除，改成以 `P3ELifeState`
 *    的 typed annotation ＋ spread 建立完整 State（不再用斷言掩蓋缺欄位）；
 * 3. 新增「五個原語都不在公開 barrel」測試。
 *
 * `P3ELifeState` 在 `p3e-2` 有必要欄位 `pendingDecision`；本測試的 state fixture
 * 由正式 `createP3EGenesis` 產生，pending 摘要以正式型別 `P3EPendingDecisionSummary` 建構。
 */

const KERNEL_SRC = join(process.cwd(), "packages/simulation/src/year-ledger-hash.ts");
const SEED = "p3e-2-ledger-v22";
const ROOT = process.cwd();
const rj = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const base = validateDataPack({ manifest: rj("fixtures/p2a/manifest.v1.json"), datasets: {
  "country-registry": rj("fixtures/p2a/country-registry.v1.json"), indicators: rj("fixtures/p2a/indicators.v1.json"),
  "birth-weights": rj("fixtures/p2a/birth-weights.v1.json"), "sensitive-names": rj("fixtures/p2a/sensitive-names.v1.json"),
  licenses: rj("fixtures/p2a/licenses.v1.json"), lineage: rj("fixtures/p2a/lineage.v1.json")
} } as never);
const identityPack = validateIdentityPack(base, { manifest: rj("fixtures/p2b/manifest.v1.json"), datasets: {
  "country-vitals": rj("fixtures/p2b/country-vitals.v1.json"), "household-profiles": rj("fixtures/p2b/household-profiles.v1.json"),
  "name-corpus": rj("fixtures/p2b/name-corpus.v1.json"), "story-templates": rj("fixtures/p2b/story-templates.v1.json"),
  licenses: rj("fixtures/p2b/licenses.v1.json"), lineage: rj("fixtures/p2b/lineage.v1.json")
} } as never);
const eventPack = validateEventPack({ manifest: rj("fixtures/p3b/manifest.v1.json"), events: (rj("fixtures/p3b/events.v1.json") as { records: unknown[] }).records } as never);
const deathPack = validateDeathPack({ manifest: rj("fixtures/p3d/manifest.v1.json"), datasets: {
  "cause-registry": rj("fixtures/p3d/cause-registry.v1.json"), "cause-weights": rj("fixtures/p3d/cause-weights.v1.json"),
  mortality: rj("fixtures/p3d/mortality.v1.json"), licenses: rj("fixtures/p3d/licenses.v1.json"), lineage: rj("fixtures/p3d/lineage.v1.json")
} } as never, base);
const group = buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never);
const certificate = createBirthCertificate(base, identityPack, group, SEED);

/** 符合 p3e-2 的正式 genesis（`pendingDecision` 由正式 genesis 設為 null）。 */
const GENESIS: P3ELifeState = createP3EGenesis({ masterSeed: SEED, basePack: base, identityPack, certificate, eventPack, deathPack });

const HEX64 = /^[0-9a-f]{64}$/;
const ZERO = "0".repeat(64) as P3EHex64;
const AAAA = "a".repeat(64) as P3EHex64;

/** 正式合法的 pending decision 摘要（六欄；eventId／decisionId 符合正式樣式規則）。 */
function pendingOf(year: number, age: number, over: Partial<P3EPendingDecisionSummary> = {}): P3EPendingDecisionSummary {
  return {
    year,
    age,
    eventId: "ev.test.pending",
    decisionId: "dec.test.choose",
    selectionHash: "b".repeat(64) as P3EHex64,
    optionIds: ["dec.opt.alpha", "dec.opt.beta"],
    ...over
  };
}

/** 測試用 RNG 反例：指定 tuple 字位 +1（structuredClone 保持輸入不變）。 */
function bumpRng(r: P3ERngState, channel: "life" | "events" | "death", tuple: "initialState" | "state", word: number): P3ERngState {
  const c = structuredClone(r) as unknown as Record<string, Record<string, unknown>>;
  const ch = c[channel] as Record<string, unknown>;
  const arr = ch[tuple] as number[];
  ch[tuple] = arr.map((v, i) => (i === word ? v + 1 : v));
  return c as unknown as P3ERngState;
}

/** 推進一年並進入 `pending_decision`（必要欄位以正式型別帶入，非雙重型別斷言）。 */
function enterPending(state: P3ELifeState): P3ELifeState {
  const year = state.currentYear + 1;
  const age = state.age + 1;
  return {
    ...state,
    age,
    currentYear: year,
    phase: "pending_decision",
    pendingDecision: pendingOf(year, age),
    rng: bumpRng(state.rng, "life", "state", 0)
  };
}

/** 下一次由 pending 清空（回到 life，pendingDecision 為 null）。 */
function clearPending(state: P3ELifeState): P3ELifeState {
  return {
    ...state,
    age: state.age + 1,
    currentYear: state.currentYear + 1,
    phase: "life",
    pendingDecision: null,
    rng: bumpRng(state.rng, "life", "state", 1)
  };
}

const snapIn = (s: P3ELifeState, index = 1): P3EYearSnapshotHashInput => ({
  index, year: s.currentYear, age: s.age, phase: s.phase, stats: s.stats, assets: s.assets, rng: s.rng,
  flags: s.flags, occurrences: s.occurrences, pendingDecision: s.pendingDecision
});

const deltaIn = (b: P3ELifeState, a: P3ELifeState, index = 1): P3EYearDeltaHashInput => ({
  index,
  yearBefore: b.currentYear, yearAfter: a.currentYear, ageBefore: b.age, ageAfter: a.age,
  phaseBefore: b.phase, phaseAfter: a.phase,
  statsBefore: b.stats, statsAfter: a.stats, assetsBefore: b.assets, assetsAfter: a.assets,
  rngBefore: b.rng, rngAfter: a.rng,
  flagsBefore: b.flags, flagsAfter: a.flags,
  occurrencesBefore: b.occurrences, occurrencesAfter: a.occurrences,
  pendingDecisionBefore: b.pendingDecision, pendingDecisionAfter: a.pendingDecision
});

const entryIn = (b: P3ELifeState, a: P3ELifeState, sh: P3EHex64, snap: P3EHex64, delta: P3EHex64, index = 1) => ({
  index,
  year: a.currentYear,
  age: a.age,
  phase: a.phase,
  stateHashBefore: sh,
  rngBefore: b.rng,
  rngAfter: a.rng,
  snapshotHash: snap,
  deltaHash: delta
});

const cmdIn = (a: P3ELifeState, entryHash: P3EHex64, shBefore: P3EHex64, shAfter: P3EHex64) => ({
  prevCommandHash: GENESIS.commandLog.headHash,
  index: 1,
  year: a.currentYear,
  command: "annual_roll",
  argsHash: AAAA,
  stateHashBefore: shBefore,
  stateHashAfter: shAfter,
  entryHash
});

const bumpStats = (s: P3EStats, k: keyof P3EStats): P3EStats => ({ ...s, [k]: (s[k] as number) + 1 });
const bumpAssets = (a: P3EAssets, k: keyof P3EAssets): P3EAssets => ({ ...a, [k]: (a[k] as bigint) + 1n });
const OCC = (eventId: string, count: number, lastYear: number): P3EEventOccurrence => ({ eventId, count, lastYear });

/* ------------------------------- 決定性 ------------------------------- */
describe("determinism: 100 identical runs for all five", () => {
  it("same input yields identical hashes", () => {
    const a = enterPending(GENESIS);
    const snap = computeP3ESnapshotHash(snapIn(a));
    const delta = computeP3EDeltaHash(deltaIn(GENESIS, a));
    const entry = computeP3EYearEntryHash(entryIn(GENESIS, a, ZERO, snap, delta));
    const cmd = computeP3ECommandHash(cmdIn(a, entry, ZERO, ZERO));
    const chain = computeP3EYearChainHash({ prevChainHash: ZERO, index: 1, year: a.currentYear, entryHash: entry, stateHashAfter: ZERO, commandHash: cmd });
    for (let i = 0; i < 100; i += 1) {
      expect(computeP3ESnapshotHash(snapIn(a))).toBe(snap);
      expect(computeP3EDeltaHash(deltaIn(GENESIS, a))).toBe(delta);
      expect(computeP3EYearEntryHash(entryIn(GENESIS, a, ZERO, snap, delta))).toBe(entry);
      expect(computeP3ECommandHash(cmdIn(a, entry, ZERO, ZERO))).toBe(cmd);
      expect(computeP3EYearChainHash({ prevChainHash: ZERO, index: 1, year: a.currentYear, entryHash: entry, stateHashAfter: ZERO, commandHash: cmd })).toBe(chain);
    }
  });
});

/* --------------------------- 五 domain 互異 --------------------------- */
describe("five domains are distinct", () => {
  it("snapshot/delta/entry/command/chain hashes differ pairwise", () => {
    const a = enterPending(GENESIS);
    const snap = computeP3ESnapshotHash(snapIn(a));
    const delta = computeP3EDeltaHash(deltaIn(GENESIS, a));
    const entry = computeP3EYearEntryHash(entryIn(GENESIS, a, ZERO, snap, delta));
    const cmd = computeP3ECommandHash(cmdIn(a, entry, ZERO, ZERO));
    const chain = computeP3EYearChainHash({ prevChainHash: ZERO, index: 1, year: a.currentYear, entryHash: entry, stateHashAfter: ZERO, commandHash: cmd });
    const hs = [snap, delta, entry, cmd, chain];
    for (let i = 0; i < hs.length; i += 1) for (let j = i + 1; j < hs.length; j += 1) expect(hs[i]).not.toBe(hs[j]);
  });
});

/* ------------------- Snapshot：pendingDecision 九類反例 ------------------- */
describe("snapshot pendingDecision counter-examples (H5-CTO-114-B)", () => {
  const pendingState = enterPending(GENESIS);
  const base0 = snapIn(pendingState);
  const h0 = computeP3ESnapshotHash(base0);
  const pd1 = pendingState.pendingDecision as P3EPendingDecisionSummary;
  const re = (pd: P3EPendingDecisionSummary | null): P3EHex64 => computeP3ESnapshotHash({ ...base0, pendingDecision: pd });
  const pdChanged = (over: Partial<P3EPendingDecisionSummary>): P3EPendingDecisionSummary => ({ ...pd1, ...over });

  it("null and non-null produce different snapshotHash", () => {
    expect(re(null)).not.toBe(h0);
    expect(base0.pendingDecision).not.toBeNull();
  });
  it("pendingDecision.year and .age change alter snapshotHash", () => {
    expect(re(pdChanged({ year: pd1.year + 1 }))).not.toBe(h0);
    expect(re(pdChanged({ age: pd1.age + 1 }))).not.toBe(h0);
  });
  it("pendingDecision.eventId, .decisionId and .selectionHash change alter snapshotHash", () => {
    expect(re(pdChanged({ eventId: "ev.test.other" }))).not.toBe(h0);
    expect(re(pdChanged({ decisionId: "dec.test.other" }))).not.toBe(h0);
    expect(re(pdChanged({ selectionHash: "c".repeat(64) as P3EHex64 }))).not.toBe(h0);
  });
  it("pendingDecision.optionIds element, order and length changes alter snapshotHash", () => {
    expect(re(pdChanged({ optionIds: ["dec.opt.alpha", "dec.opt.gamma"] }))).not.toBe(h0);
    expect(re(pdChanged({ optionIds: ["dec.opt.beta", "dec.opt.alpha"] }))).not.toBe(h0);
    expect(re(pdChanged({ optionIds: ["dec.opt.alpha", "dec.opt.beta", "dec.opt.gamma"] }))).not.toBe(h0);
    expect(re(pdChanged({ optionIds: ["dec.opt.alpha"] }))).not.toBe(h0);
  });
  it("null -> pending and pending -> null both alter snapshotHash", () => {
    expect(computeP3ESnapshotHash(snapIn(GENESIS))).not.toBe(h0);
    expect(re(null)).not.toBe(h0);
  });
});

/* ------------------- Delta：pendingDecision 九類反例 ------------------- */
describe("delta pendingDecision counter-examples (H5-CTO-114-B)", () => {
  const pendingState = enterPending(GENESIS);
  const pendingState2 = enterPending(pendingState);
  const clearedState = clearPending(pendingState);
  const d0 = deltaIn(pendingState, pendingState2);
  const h0 = computeP3EDeltaHash(d0);
  const pd2 = pendingState2.pendingDecision as P3EPendingDecisionSummary;
  const re = (over: Partial<P3EYearDeltaHashInput>): P3EHex64 => computeP3EDeltaHash({ ...d0, ...over } as P3EYearDeltaHashInput);
  const pdChanged = (over: Partial<P3EPendingDecisionSummary>): P3EPendingDecisionSummary => ({ ...pd2, ...over });

  it("null -> pending and pending -> null both alter deltaHash", () => {
    const dNull = deltaIn(GENESIS, pendingState);
    const hNull = computeP3EDeltaHash(dNull);
    expect(computeP3EDeltaHash({ ...dNull, pendingDecisionBefore: pd2 })).not.toBe(hNull);
    expect(re({ pendingDecisionBefore: null })).not.toBe(h0);
    expect(re({ pendingDecisionAfter: null })).not.toBe(h0);
    // pending → null 的真實 delta（清空 pendingDecision 後仍與 base 不同）
    const clearedDelta = deltaIn(pendingState, clearedState);
    expect(clearedDelta.pendingDecisionBefore).not.toBeNull();
    expect(clearedDelta.pendingDecisionAfter).toBeNull();
    expect(computeP3EDeltaHash(clearedDelta)).not.toBe(h0);
  });
  it("pending -> different pending alters deltaHash on both sides", () => {
    expect(re({ pendingDecisionAfter: pdChanged({ decisionId: "dec.test.other" }) })).not.toBe(h0);
    expect(re({ pendingDecisionBefore: pdChanged({ eventId: "ev.test.other" }) })).not.toBe(h0);
  });
  it("pendingDecision.year and .age change alter deltaHash", () => {
    expect(re({ pendingDecisionAfter: pdChanged({ year: pd2.year + 1 }) })).not.toBe(h0);
    expect(re({ pendingDecisionAfter: pdChanged({ age: pd2.age + 1 }) })).not.toBe(h0);
  });
  it("pendingDecision.eventId, .decisionId and .selectionHash change alter deltaHash", () => {
    expect(re({ pendingDecisionAfter: pdChanged({ eventId: "ev.test.other" }) })).not.toBe(h0);
    expect(re({ pendingDecisionAfter: pdChanged({ decisionId: "dec.test.other" }) })).not.toBe(h0);
    expect(re({ pendingDecisionAfter: pdChanged({ selectionHash: "c".repeat(64) as P3EHex64 }) })).not.toBe(h0);
  });
  it("pendingDecision.optionIds element, order and length changes alter deltaHash", () => {
    expect(re({ pendingDecisionAfter: pdChanged({ optionIds: ["dec.opt.alpha", "dec.opt.gamma"] }) })).not.toBe(h0);
    expect(re({ pendingDecisionAfter: pdChanged({ optionIds: ["dec.opt.beta", "dec.opt.alpha"] }) })).not.toBe(h0);
    expect(re({ pendingDecisionAfter: pdChanged({ optionIds: ["dec.opt.alpha", "dec.opt.beta", "dec.opt.gamma"] }) })).not.toBe(h0);
    expect(re({ pendingDecisionAfter: pdChanged({ optionIds: ["dec.opt.alpha"] }) })).not.toBe(h0);
    expect(re({ pendingDecisionBefore: pdChanged({ optionIds: ["dec.opt.beta", "dec.opt.alpha"] }) })).not.toBe(h0);
  });
  it("normal year enters pending_decision then next year clears it", () => {
    const before = GENESIS;
    const entering = enterPending(before);
    const cleared = clearPending(entering);
    expect(before.pendingDecision).toBeNull();
    expect(entering.phase).toBe("pending_decision");
    expect(entering.pendingDecision).not.toBeNull();
    expect(cleared.phase).toBe("life");
    expect(cleared.pendingDecision).toBeNull();
    const enterHash = computeP3EDeltaHash(deltaIn(before, entering));
    const clearHash = computeP3EDeltaHash(deltaIn(entering, cleared));
    expect(enterHash).not.toBe(clearHash);
    expect(enterHash).not.toBe(computeP3EDeltaHash(deltaIn(before, cleared)));
  });
});

/* --------------------------- 逐欄變更敏感性 --------------------------- */
describe("per-field sensitivity", () => {
  const a = enterPending(GENESIS);
  const snap = computeP3ESnapshotHash(snapIn(a));
  const delta = computeP3EDeltaHash(deltaIn(GENESIS, a));
  const entry = computeP3EYearEntryHash(entryIn(GENESIS, a, ZERO, snap, delta));
  const cmd = computeP3ECommandHash(cmdIn(a, entry, ZERO, ZERO));
  const chain = computeP3EYearChainHash({ prevChainHash: ZERO, index: 1, year: a.currentYear, entryHash: entry, stateHashAfter: ZERO, commandHash: cmd });

  it("snapshot: any authoritative field change alters snapshotHash", () => {
    const m = (k: keyof P3EYearSnapshotHashInput, v: unknown) => computeP3ESnapshotHash({ ...snapIn(a), [k]: v } as never);
    expect(m("index", a.currentYear + 7)).not.toBe(snap);
    expect(m("year", a.currentYear + 1)).not.toBe(snap);
    expect(m("age", a.age + 1)).not.toBe(snap);
    expect(m("phase", "death" as P3EPhase)).not.toBe(snap);
    expect(m("stats", { ...a.stats, health: a.stats.health + 1 })).not.toBe(snap);
    expect(m("assets", { ...a.assets, balanceMicroUsd: a.assets.balanceMicroUsd + 1n })).not.toBe(snap);
    expect(m("flags", [...a.flags, "p3e:flag-new"])).not.toBe(snap);
    expect(m("occurrences", [...a.occurrences, OCC("ev.test.audit", 1, 2001)])).not.toBe(snap);
  });
  it("delta: any authoritative field change alters deltaHash", () => {
    const d0 = deltaIn(GENESIS, a);
    const h = computeP3EDeltaHash(d0);
    const m = (k: keyof P3EYearDeltaHashInput, v: unknown) => computeP3EDeltaHash({ ...d0, [k]: v } as never);
    expect(m("index", d0.index + 1)).not.toBe(h);
    expect(m("yearBefore", d0.yearBefore + 1)).not.toBe(h);
    expect(m("yearAfter", d0.yearAfter + 1)).not.toBe(h);
    expect(m("ageBefore", d0.ageBefore + 1)).not.toBe(h);
    expect(m("ageAfter", d0.ageAfter + 1)).not.toBe(h);
    expect(m("phaseBefore", "death" as P3EPhase)).not.toBe(h);
    expect(m("phaseAfter", "death" as P3EPhase)).not.toBe(h);
    expect(m("statsBefore", bumpStats(d0.statsBefore, "health"))).not.toBe(h);
    expect(m("statsAfter", bumpStats(d0.statsAfter, "health"))).not.toBe(h);
    expect(m("assetsBefore", bumpAssets(d0.assetsBefore, "balanceMicroUsd"))).not.toBe(h);
    expect(m("assetsAfter", bumpAssets(d0.assetsAfter, "balanceMicroUsd"))).not.toBe(h);
    expect(m("rngBefore", d0.rngAfter)).not.toBe(h);
    expect(m("rngAfter", d0.rngBefore)).not.toBe(h);
    expect(m("flagsBefore", ["p3e:flag-x"])).not.toBe(h);
    expect(m("flagsAfter", ["p3e:flag-y"])).not.toBe(h);
    expect(m("occurrencesBefore", [OCC("ev.test.audit", 1, 2001)])).not.toBe(h);
    expect(m("occurrencesAfter", [OCC("ev.test.audit", 2, 2002)])).not.toBe(h);
  });
  it("delta: every RNG tuple word change alters deltaHash", () => {
    const d0 = deltaIn(GENESIS, a);
    const h = computeP3EDeltaHash(d0);
    for (const ch of ["life", "events", "death"] as const) for (const t of ["initialState", "state"] as const) for (let w = 0; w < 4; w += 1) {
      expect(computeP3EDeltaHash({ ...d0, rngBefore: bumpRng(d0.rngBefore, ch, t, w) })).not.toBe(h);
    }
  });
  it("entry: any authoritative field change alters entryHash", () => {
    const b = entryIn(GENESIS, a, ZERO, snap, delta);
    const m = (k: keyof typeof b, v: unknown) => computeP3EYearEntryHash({ ...b, [k]: v } as never);
    expect(m("index", b.index + 1)).not.toBe(entry);
    expect(m("year", b.year + 1)).not.toBe(entry);
    expect(m("age", b.age + 1)).not.toBe(entry);
    expect(m("phase", "death" as P3EPhase)).not.toBe(entry);
    expect(m("stateHashBefore", AAAA)).not.toBe(entry);
    expect(m("rngBefore", a.rng)).not.toBe(entry);
    expect(m("rngAfter", GENESIS.rng)).not.toBe(entry);
    expect(m("snapshotHash", AAAA)).not.toBe(entry);
    expect(m("deltaHash", AAAA)).not.toBe(entry);
  });
  it("command: any authoritative field change alters commandHash", () => {
    const b = cmdIn(a, entry, ZERO, ZERO);
    const m = (k: keyof typeof b, v: unknown) => computeP3ECommandHash({ ...b, [k]: v } as never);
    expect(m("prevCommandHash", AAAA)).not.toBe(cmd);
    expect(m("index", 2)).not.toBe(cmd);
    expect(m("year", a.currentYear + 1)).not.toBe(cmd);
    expect(m("command", "other")).not.toBe(cmd);
    expect(m("argsHash", ZERO)).not.toBe(cmd);
    expect(m("stateHashBefore", AAAA)).not.toBe(cmd);
    expect(m("stateHashAfter", AAAA)).not.toBe(cmd);
    expect(m("entryHash", AAAA)).not.toBe(cmd);
  });
  it("chain: any authoritative field change alters chainHash", () => {
    const b = { prevChainHash: ZERO, index: 1, year: a.currentYear, entryHash: entry, stateHashAfter: ZERO, commandHash: cmd };
    const m = (k: keyof typeof b, v: unknown) => computeP3EYearChainHash({ ...b, [k]: v } as never);
    expect(m("prevChainHash", AAAA)).not.toBe(chain);
    expect(m("index", 2)).not.toBe(chain);
    expect(m("year", a.currentYear + 1)).not.toBe(chain);
    expect(m("entryHash", AAAA)).not.toBe(chain);
    expect(m("stateHashAfter", AAAA)).not.toBe(chain);
    expect(m("commandHash", AAAA)).not.toBe(chain);
  });
});

/* --------------------------- 單向無循環方向 --------------------------- */
describe("one-way no-cycle direction", () => {
  const a = enterPending(GENESIS);
  const snap = computeP3ESnapshotHash(snapIn(a));
  const delta = computeP3EDeltaHash(deltaIn(GENESIS, a));
  const entry = computeP3EYearEntryHash(entryIn(GENESIS, a, ZERO, snap, delta));

  it("commandHash change does NOT require recomputing entryHash", () => {
    const c1 = computeP3ECommandHash(cmdIn(a, entry, ZERO, ZERO));
    const c2 = computeP3ECommandHash(cmdIn(a, entry, ZERO, AAAA));
    expect(c1).not.toBe(c2);
    expect(computeP3EYearEntryHash(entryIn(GENESIS, a, ZERO, snap, delta))).toBe(entry);
  });
  it("commandHash change changes chainHash", () => {
    const c1 = computeP3ECommandHash(cmdIn(a, entry, ZERO, ZERO));
    const c2 = computeP3ECommandHash(cmdIn(a, entry, ZERO, AAAA));
    const h1 = computeP3EYearChainHash({ prevChainHash: ZERO, index: 1, year: a.currentYear, entryHash: entry, stateHashAfter: ZERO, commandHash: c1 });
    const h2 = computeP3EYearChainHash({ prevChainHash: ZERO, index: 1, year: a.currentYear, entryHash: entry, stateHashAfter: ZERO, commandHash: c2 });
    expect(h1).not.toBe(h2);
  });
  it("full construction order: no cycle, commandLog/hashChain do not alter stateHash", () => {
    const before = GENESIS;
    const shBefore = computeP3EStateHash(before);
    const after = enterPending(before);
    const index = 1;
    const year = after.currentYear;
    const snapshotHash = computeP3ESnapshotHash(snapIn(after));
    const deltaHash = computeP3EDeltaHash(deltaIn(before, after));
    const entryHash = computeP3EYearEntryHash(entryIn(before, after, shBefore, snapshotHash, deltaHash));
    const withHeads: P3ELifeState = { ...after, heads: { ...after.heads, lastSnapshotHash: snapshotHash, lastDeltaHash: deltaHash, lastEntryHash: entryHash } };
    const shAfter = computeP3EStateHash(withHeads);
    const commandHash = computeP3ECommandHash(cmdIn(after, entryHash, shBefore, shAfter));
    const chainHash = computeP3EYearChainHash({ prevChainHash: before.heads.hashChain, index, year, entryHash, stateHashAfter: shAfter, commandHash });
    const finalState: P3ELifeState = { ...withHeads, commandLog: { count: after.commandLog.count + 1, headHash: commandHash }, heads: { ...withHeads.heads, hashChain: chainHash } };
    expect(computeP3EStateHash(finalState)).toBe(shAfter);
    expect(shAfter).not.toBe(shBefore);
  });
  it("full construction order with pending cleared: stateHash still stable", () => {
    const before = enterPending(GENESIS);
    const shBefore = computeP3EStateHash(before);
    const after = clearPending(before);
    const snapshotHash = computeP3ESnapshotHash(snapIn(after));
    const deltaHash = computeP3EDeltaHash(deltaIn(before, after));
    const entryHash = computeP3EYearEntryHash(entryIn(before, after, shBefore, snapshotHash, deltaHash));
    const withHeads: P3ELifeState = { ...after, heads: { ...after.heads, lastSnapshotHash: snapshotHash, lastDeltaHash: deltaHash, lastEntryHash: entryHash } };
    const shAfter = computeP3EStateHash(withHeads);
    const commandHash = computeP3ECommandHash(cmdIn(after, entryHash, shBefore, shAfter));
    const chainHash = computeP3EYearChainHash({ prevChainHash: before.heads.hashChain, index: 1, year: after.currentYear, entryHash, stateHashAfter: shAfter, commandHash });
    const finalState: P3ELifeState = { ...withHeads, commandLog: { count: after.commandLog.count + 1, headHash: commandHash }, heads: { ...withHeads.heads, hashChain: chainHash } };
    expect(computeP3EStateHash(finalState)).toBe(shAfter);
    expect(shAfter).not.toBe(shBefore);
  });
});

/* ------------------------- 靜態掃描：型別不存在證明 ------------------------- */
describe("static scan: no forbidden dependency in input types", () => {
  const src = readFileSync(KERNEL_SRC, "utf8");
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const block = (name: string): string => {
    const s = src.indexOf(`function ${name}`);
    const n = src.indexOf("\nexport function ", s + 10);
    return stripComments(src.slice(s, n < 0 ? src.length : n));
  };

  it("snapshot/delta/entry inputs exclude forbidden fields", () => {
    const snap = block("computeP3ESnapshotHash");
    expect(snap).not.toContain("stateHash");
    expect(snap).not.toContain("lastEntryHash");
    expect(snap).not.toContain("lastSnapshotHash");
    expect(snap).not.toContain("lastDeltaHash");
    expect(snap).not.toContain("hashChain");
    expect(snap).not.toContain("commandHash");
    const delta = block("computeP3EDeltaHash");
    expect(delta).not.toContain("stateHashAfter");
    expect(delta).not.toContain("lastEntryHash");
    const entry = block("computeP3EYearEntryHash");
    expect(entry).not.toContain("stateHashAfter");
    expect(entry).not.toContain("commandHash");
    expect(entry).not.toContain("chainHash");
  });
  it("command projection includes entryHash (necessary, no cycle)", () => {
    expect(block("computeP3ECommandHash")).toContain("entryHash: input.entryHash");
  });
  it("source has no time/random/self-canonicalizer/stringify dependency", () => {
    const code = stripComments(src);
    for (const token of ["Date.now", "Math.random", "performance.now", "JSON.stringify", "JSON.parse"]) {
      expect(code).not.toContain(token);
    }
  });
  it("pendingDecision projection is hand-written with independent optionIds array", () => {
    const pd = block("pendingDecisionProjection");
    expect(pd).toContain("year: pending.year");
    expect(pd).toContain("age: pending.age");
    expect(pd).toContain("eventId: pending.eventId");
    expect(pd).toContain("decisionId: pending.decisionId");
    expect(pd).toContain("selectionHash: pending.selectionHash");
    expect(pd).toContain("optionIds: [...pending.optionIds]");
    expect(pd).not.toContain("JSON.stringify");
  });
});

/* ------------------------- 輸入不變 / hex / bigint ------------------------- */
describe("safety and encoding", () => {
  const a = enterPending(GENESIS);
  it("inputs are not mutated", () => {
    const s = snapIn(a);
    const before = structuredClone(s);
    computeP3ESnapshotHash(s);
    expect(s).toEqual(before);
    const e = entryIn(GENESIS, a, ZERO, AAAA, AAAA);
    const eb = structuredClone(e);
    computeP3EYearEntryHash(e);
    expect(e).toEqual(eb);
  });
  it("all outputs are 64-char lowercase hex", () => {
    const snap = computeP3ESnapshotHash(snapIn(a));
    const delta = computeP3EDeltaHash(deltaIn(GENESIS, a));
    const entry = computeP3EYearEntryHash(entryIn(GENESIS, a, ZERO, snap, delta));
    const cmd = computeP3ECommandHash(cmdIn(a, entry, ZERO, ZERO));
    const chain = computeP3EYearChainHash({ prevChainHash: ZERO, index: 1, year: a.currentYear, entryHash: entry, stateHashAfter: ZERO, commandHash: cmd });
    for (const h of [snap, delta, entry, cmd, chain]) expect(h).toMatch(HEX64);
  });
  it("bigint and number produce different hashes", () => {
    const s = snapIn(a);
    const big = computeP3ESnapshotHash(s);
    const num = computeP3ESnapshotHash({ ...s, assets: { ...s.assets, balanceMicroUsd: 1 as unknown as bigint } } as never);
    expect(num).not.toBe(big);
  });
  it("key insertion order does not affect result", () => {
    const s = snapIn(a);
    const reordered = computeP3ESnapshotHash({ pendingDecision: s.pendingDecision, occurrences: s.occurrences, flags: s.flags, rng: s.rng, assets: s.assets, stats: s.stats, phase: s.phase, age: s.age, year: s.year, index: 1 });
    expect(reordered).toBe(computeP3ESnapshotHash(s));
  });
});

/* --------------------------- 公開表面：不進 barrel --------------------------- */
describe("public surface: the five primitives stay package-internal", () => {
  it("五個原語都不在 @life-sim/simulation 的公開表面", () => {
    const imported = [
      computeP3ESnapshotHash,
      computeP3EDeltaHash,
      computeP3EYearEntryHash,
      computeP3ECommandHash,
      computeP3EYearChainHash
    ];
    for (const fn of imported) expect(typeof fn).toBe("function");

    const surface = simulation as unknown as Record<string, unknown>;
    for (const name of [
      "computeP3ESnapshotHash",
      "computeP3EDeltaHash",
      "computeP3EYearEntryHash",
      "computeP3ECommandHash",
      "computeP3EYearChainHash"
    ]) {
      expect(surface[name], name).toBeUndefined();
    }
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });
});