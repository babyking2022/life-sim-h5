import { describe, expect, it } from "vitest";
import type { P3ALifeState, VersionTuple } from "@life-sim/contracts";
import { deriveDomainState } from "../src/rng/seed";
import { createBenchmarkLifeState, serializeBenchmarkLifeState } from "../src/life/benchmark";
import {
  applyLifeCommand,
  assertLifeStateHash,
  computeYearDeltaHash,
  computeYearDurationMs,
  computeYearEntryHash,
  computeYearSnapshotHash,
  createLifeState,
  deserializeLifeState,
  LifeError,
  reconstructLifeState,
  resolveLifeYear,
  resolveYear,
  serializeLifeState,
  verifyLifeState
} from "../src/life";

const VERSIONS: VersionTuple = {
  engineVersion: "0.1.0",
  rulesetVersion: "p3a-1.0.1",
  rngSpecVersion: "1.0.0",
  dataVersion: "1.0.0",
  contentVersion: "skeleton-1.0.1",
  saveFormatVersion: 3
};
const ORIGIN = {
  certificateHash: "a".repeat(64),
  certificateId: `cert:${"b".repeat(24)}`,
  playerIdentityHash: "c".repeat(64),
  masterSeedHash: "d".repeat(64),
  basePackId: "p2a-synthetic-20261027",
  basePackChecksum: "e".repeat(64),
  identityPackId: "p2b-synthetic-20261027",
  identityPackChecksum: "f".repeat(64)
};
const bootstrap = (seed = "p3a1") => ({ versions: VERSIONS, origin: ORIGIN, birthYear: 2020, paceLifeYearsX10: 780, rngState: deriveDomainState(seed, "life") });
const make = (seed = "p3a1"): P3ALifeState => createLifeState(bootstrap(seed));
const codeOf = (action: () => unknown): string => {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof LifeError ? error.code : "OTHER";
  }
};
const play = (state: P3ALifeState) => applyLifeCommand(state, { type: "SET_PLAYBACK", paused: false }).state;
const ff = (state: P3ALifeState, years: number) => applyLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: years }).state;
const yearsHash = (seed: string, years: number): string => {
  let state = make(seed);
  for (let index = 0; index < years; index += 1) state = resolveYear(state);
  return state.stateHash;
};

describe("P3-A.3 life state and time contract", () => {
  it("creates a paused 0-100 state with pace-derived year duration", () => {
    const state = make();
    expect(state.stats).toEqual({ health: 50, happiness: 50, knowledge: 50, relationships: 50 });
    expect(state.age).toBe(0);
    expect(state.phase).toBe("life");
    expect(state.playback.mode).toBe("paused");
    expect(state.playback.visibility).toBe("visible");
    expect(state.playback.yearDurationMs).toBe(computeYearDurationMs(60, 780));
    expect(state.assets.balanceMicroUsd).toBe(0n);
    expect(state.history).toEqual({
      yearsRecorded: 0,
      cardsTotal: 0,
      lastEntryHash: "0".repeat(64),
      lastSnapshotHash: "0".repeat(64),
      lastDeltaHash: "0".repeat(64),
      initialStateHash: state.stateHash
    });
  });

  it("computes pace duration with integer rounding and clamping", () => {
    expect(computeYearDurationMs(30, 780)).toBe(23077);
    expect(computeYearDurationMs(60, 780)).toBe(46154);
    expect(computeYearDurationMs(90, 1500)).toBe(36000);
    expect(computeYearDurationMs(90, 100)).toBe(120000);
  });

  it("resolves years deterministically with fixed-size state and a delta", () => {
    const first = resolveLifeYear(make("det"));
    expect(first.state.age).toBe(1);
    expect(first.delta.logEntry.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.state.history.yearsRecorded).toBe(1);
    expect(first.state.history.lastEntryHash).toBe(first.delta.logEntry.entryHash);
    expect(first.state.history.lastSnapshotHash).toBe(first.delta.snapshot.snapshotHash);
    expect(first.state.history.lastDeltaHash).toBe(first.delta.deltaHash);
    expect(first.state.history.lastEntryHash).not.toBe("0".repeat(64));
    expect(resolveLifeYear(make("det")).state.stateHash).toBe(first.state.stateHash);
    for (let index = 0; index < 20; index += 1) expect(yearsHash("det", 5)).toBe(yearsHash("det", 5));
  });

  it("recomputes the three rolling year chains from the delta payload", () => {
    const first = resolveLifeYear(make("chain"));
    const second = resolveLifeYear(first.state);
    const delta = second.delta;
    expect(
      computeYearEntryHash(first.state.history.lastEntryHash, {
        seq: 2,
        year: delta.year,
        age: delta.age,
        entryId: delta.logEntry.entryId,
        summary: delta.logEntry.summary
      })
    ).toBe(delta.logEntry.entryHash);
    expect(
      computeYearSnapshotHash(first.state.history.lastSnapshotHash, {
        year: delta.snapshot.year,
        age: delta.snapshot.age,
        stats: delta.snapshot.stats,
        balanceMicroUsd: delta.snapshot.balanceMicroUsd,
        phase: delta.snapshot.phase
      })
    ).toBe(delta.snapshot.snapshotHash);
    expect(
      computeYearDeltaHash(first.state.history.lastDeltaHash, {
        entry: { ...delta.logEntry },
        snapshot: { ...delta.snapshot },
        card: { ...delta.card }
      })
    ).toBe(delta.deltaHash);
  });

  it("keeps TICK and FAST_FORWARD identical at the same year", () => {
    let ticked = play(make("same"));
    for (let guard = 0; guard < 2000 && ticked.age < 5; guard += 1) ticked = applyLifeCommand(ticked, { type: "TICK", deltaMs: 1000 }).state;
    const forwarded = ff(play(make("same")), 5);
    expect(ticked.currentYear).toBe(forwarded.currentYear);
    expect(ticked.stateHash).toBe(forwarded.stateHash);
    expect(ticked.commandLog).toEqual(forwarded.commandLog);
    expect(ticked.hashChain).toBe(forwarded.hashChain);
    expect(ticked.history.lastEntryHash).toBe(forwarded.history.lastEntryHash);
    expect(ticked.history.lastSnapshotHash).toBe(forwarded.history.lastSnapshotHash);
    expect(ticked.history.lastDeltaHash).toBe(forwarded.history.lastDeltaHash);
  });

  it("keeps pace and speed from changing outcomes", () => {
    const baseline = ff(play(make("pace")), 3).stateHash;
    for (const pace of [30, 60, 90]) {
      for (const speed of [1, 16]) {
        let state = applyLifeCommand(make("pace"), { type: "SET_PLAYBACK", paceMinutes: pace, speed, paused: false }).state;
        state = ff(state, 3);
        expect(state.stateHash).toBe(baseline);
      }
    }
  });

  it("stops at the six-year decision, pauses, and blocks NEXT until a choice", () => {
    const state = ff(play(make("dec")), 20);
    expect(state.phase).toBe("pending_decision");
    expect(state.age).toBe(6);
    expect(state.playback.mode).toBe("paused");
    const before = JSON.stringify(serializeLifeState(state));
    expect(codeOf(() => applyLifeCommand(state, { type: "NEXT" }))).toBe("E_P3A_ARGUMENT");
    expect(JSON.stringify(serializeLifeState(state))).toBe(before);

    const selected = applyLifeCommand(state, { type: "SELECT_DECISION", optionId: "steady" }).state;
    expect(selected.stateHash).not.toBe(state.stateHash);
    expect(selected.commandLog).toHaveLength(1);
    expect(selected.commandLog[0]?.commandType).toBe("SELECT_DECISION");
    expect(selected.pendingDecision?.selectedOptionId).toBe("steady");

    const confirmed = applyLifeCommand(selected, { type: "NEXT" }).state;
    expect(confirmed.phase).toBe("life");
    expect(confirmed.playback.mode).toBe("paused");
    expect(confirmed.commandLog).toHaveLength(2);
    expect(confirmed.commandLog[1]?.commandType).toBe("CONFIRM_DECISION");
    expect(confirmed.pendingDecision).toBeNull();
    expect(assertLifeStateHash(confirmed)).toBeUndefined();
  });

  it("deserializes with genesis verification", () => {
    const state = ff(play(make("json")), 2);
    const revived = deserializeLifeState(serializeLifeState(state), bootstrap("json"));
    expect(revived.stateHash).toBe(state.stateHash);
    expect(revived.assets).toEqual(state.assets);
    expect(revived.history).toEqual(state.history);
    expect(codeOf(() => deserializeLifeState(serializeLifeState(state), bootstrap("other")))).toMatch(/^E_P3A_/);
  });

  it("keeps state size fixed over thousands of years", () => {
    const run = (years: number) => {
      let state = createBenchmarkLifeState(bootstrap("perf-state"), years + 5);
      const started = performance.now();
      for (let index = 0; index < years; index += 1) {
        state = resolveLifeYear(state).state;
        if (state.pendingDecision !== null) {
          state = applyLifeCommand(state, { type: "SELECT_DECISION", optionId: "steady" }).state;
          state = applyLifeCommand(state, { type: "NEXT" }).state;
        }
      }
      return {
        elapsed: performance.now() - started,
        bytes: JSON.stringify(serializeBenchmarkLifeState(state)).length,
        arrayFields: Object.entries(state)
          .filter(([, value]) => Array.isArray(value))
          .map(([key]) => key),
        years: state.history.yearsRecorded
      };
    };
    const small = run(300);
    const large = run(1200);
    expect(large.years).toBe(1200);
    expect(JSON.stringify(large.arrayFields)).toBe(JSON.stringify(small.arrayFields));
    expect(large.bytes - small.bytes).toBeLessThanOrEqual(64);
  }, 120000);

  it("verifies a state by replaying from genesis", () => {
    const state = ff(play(make("verify")), 3);
    const trace = verifyLifeState(bootstrap("verify"), state);
    expect(trace.state.stateHash).toBe(state.stateHash);
    expect(trace.yearsReplayed).toBe(3);
    const rebuilt = reconstructLifeState({ bootstrap: bootstrap("verify"), targetYears: 3, commandLog: state.commandLog });
    expect(rebuilt.state.stateHash).toBe(state.stateHash);
  });
});
