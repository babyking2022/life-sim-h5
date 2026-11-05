import { describe, expect, it } from "vitest";
import type { P3ALifeState, SerializedP3ALifeState, VersionTuple } from "@life-sim/contracts";
import { deriveDomainState } from "../src/rng/seed";
import {
  applyLifeCommand,
  assertLifeStateInvariants,
  computeYearDurationMs,
  createLifeState,
  deserializeLifeState,
  LifeError,
  serializeLifeState
} from "../src/life";

/**
 * P3-A.4 反例 2：playback 是 session 狀態，存檔還原必須走明確的冷啟動政策，
 * 不得像 P3-A.3 那樣把存檔中的 playback 靜默丟棄。
 */

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
const bootstrap = (seed = "p3a4-pb") => ({
  versions: VERSIONS,
  origin: ORIGIN,
  birthYear: 2020,
  paceLifeYearsX10: 780,
  rngState: deriveDomainState(seed, "life")
});
const make = (seed = "p3a4-pb"): P3ALifeState => createLifeState(bootstrap(seed));
const play = (state: P3ALifeState) => applyLifeCommand(state, { type: "SET_PLAYBACK", paused: false }).state;
const ff = (state: P3ALifeState, years: number) => applyLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: years }).state;

const failCode = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof LifeError) return error.code;
    throw new Error(`expected LifeError, got ${(error as Error).name}: ${(error as Error).message}`);
  }
  throw new Error("expected an error but call succeeded");
};

const withPlayback = (serialized: SerializedP3ALifeState, patch: Record<string, unknown>): SerializedP3ALifeState =>
  ({ ...(serialized as unknown as Record<string, unknown>), playback: { ...(serialized.playback as unknown as Record<string, unknown>), ...patch } }) as unknown as SerializedP3ALifeState;

describe("P3-A.4 反例 2：playback 冷啟動還原政策", () => {
  it("keeps speed/pace/elapsed/cardsSeen but forces paused/visible/previousMode", () => {
    const seed = "p3a4-playing";
    let state = applyLifeCommand(make(seed), { type: "SET_PLAYBACK", paused: false, speed: 16, paceMinutes: 30 }).state;
    state = applyLifeCommand(state, { type: "TICK", deltaMs: 1000 }).state;
    expect(state.playback.mode).toBe("playing");
    expect(state.playback.speed).toBe(16);
    expect(state.playback.paceMinutes).toBe(30);
    expect(state.playback.elapsedInYearMs).toBe(16000);
    expect(state.playback.previousMode).toBe("playing");

    const restored = deserializeLifeState(serializeLifeState(state), bootstrap(seed));
    expect(restored.playback.mode).toBe("paused");
    expect(restored.playback.visibility).toBe("visible");
    expect(restored.playback.previousMode).toBe("paused");
    expect(restored.playback.speed).toBe(16);
    expect(restored.playback.paceMinutes).toBe(30);
    expect(restored.playback.elapsedInYearMs).toBe(16000);
    expect(restored.playback.cardsSeen).toBe(0);
    expect(restored.playback.yearDurationMs).toBe(computeYearDurationMs(30, state.paceLifeYearsX10));
    // 權威玩法狀態必須完全一致。
    expect(restored.stateHash).toBe(state.stateHash);
    expect(restored.history).toEqual(state.history);
    expect(restored.commandLog).toEqual(state.commandLog);
    expect(restored.flags).toEqual(state.flags);
    expect(assertLifeStateInvariants(restored)).toBeUndefined();
  });

  it("restores fast_forward and hidden sessions as paused + visible", () => {
    const seed = "p3a4-ff-hidden";
    const forwarded = ff(play(make(seed)), 3);
    expect(forwarded.playback.mode).toBe("fast_forward");
    const restoredForward = deserializeLifeState(serializeLifeState(forwarded), bootstrap(seed));
    expect(restoredForward.playback.mode).toBe("paused");
    expect(restoredForward.playback.visibility).toBe("visible");
    expect(restoredForward.playback.elapsedInYearMs).toBe(forwarded.playback.elapsedInYearMs);

    const hidden = applyLifeCommand(play(make(seed)), { type: "SET_PLAYBACK", hidden: true }).state;
    expect(hidden.playback.visibility).toBe("hidden");
    const restoredHidden = deserializeLifeState(serializeLifeState(hidden), bootstrap(seed));
    expect(restoredHidden.playback.visibility).toBe("visible");
    expect(restoredHidden.playback.mode).toBe("paused");
    expect(restoredHidden.playback.previousMode).toBe("paused");
  });

  it("keeps cardsSeen and the pending decision, and death stays paused", () => {
    const seed = "p3a4-cards";
    let state = play(make(seed));
    state = applyLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: 2 }).state;
    state = applyLifeCommand(state, { type: "SET_PLAYBACK", paused: true }).state;
    state = applyLifeCommand(state, { type: "NEXT" }).state;
    expect(state.playback.cardsSeen).toBe(1);
    const restored = deserializeLifeState(serializeLifeState(state), bootstrap(seed));
    expect(restored.playback.cardsSeen).toBe(1);
    expect(restored.history.cardsTotal).toBe(2);
    expect(restored.playback.mode).toBe("paused");

    const pending = ff(play(make(seed)), 20);
    expect(pending.phase).toBe("pending_decision");
    const restoredPending = deserializeLifeState(serializeLifeState(pending), bootstrap(seed));
    expect(restoredPending.phase).toBe("pending_decision");
    expect(restoredPending.pendingDecision).toEqual(pending.pendingDecision);
    expect(restoredPending.playback.mode).toBe("paused");

    const deathSeed = "p3a4-death";
    const cancel = (value: P3ALifeState) => applyLifeCommand(value, { type: "SET_PLAYBACK", paused: true }).state;
    let walk = play(make(deathSeed));
    for (let guard = 0; guard < 200 && walk.phase !== "death"; guard += 1) {
      walk = cancel(ff(walk, 20));
      if (walk.phase === "pending_decision") {
        walk = applyLifeCommand(walk, { type: "SELECT_DECISION", optionId: "steady" }).state;
        walk = applyLifeCommand(walk, { type: "NEXT" }).state;
      }
    }
    expect(walk.phase).toBe("death");
    const restoredDeath = deserializeLifeState(serializeLifeState(walk), bootstrap(deathSeed));
    expect(restoredDeath.phase).toBe("death");
    expect(restoredDeath.playback.mode).toBe("paused");
    expect(restoredDeath.stateHash).toBe(walk.stateHash);
  });

  it("rejects illegal playback fields with fixed codes", () => {
    const seed = "p3a4-invalid";
    const state = ff(play(make(seed)), 2);
    const serialized = serializeLifeState(state);
    expect(failCode(() => deserializeLifeState(withPlayback(serialized, { speed: 3 }), bootstrap(seed)))).toBe("E_P3A_SPEED");
    expect(failCode(() => deserializeLifeState(withPlayback(serialized, { paceMinutes: 45 }), bootstrap(seed)))).toBe("E_P3A_PACE");
    expect(failCode(() => deserializeLifeState(withPlayback(serialized, { elapsedInYearMs: -1 }), bootstrap(seed)))).toBe("E_P3A_STATE");
    expect(failCode(() => deserializeLifeState(withPlayback(serialized, { cardsSeen: 99 }), bootstrap(seed)))).toBe("E_P3A_HISTORY");
    expect(failCode(() => deserializeLifeState(withPlayback(serialized, { mode: "stopped" }), bootstrap(seed)))).toBe("E_P3A_STATE");
    expect(failCode(() => deserializeLifeState(withPlayback(serialized, { visibility: "gone" }), bootstrap(seed)))).toBe("E_P3A_STATE");
    expect(failCode(() => deserializeLifeState(withPlayback(serialized, { previousMode: "fast_forward" }), bootstrap(seed)))).toBe("E_P3A_STATE");
    expect(failCode(() => deserializeLifeState(withPlayback(serialized, { yearDurationMs: 9999 }), bootstrap(seed)))).toBe("E_P3A_PACE");
    expect(failCode(() => deserializeLifeState(withPlayback(serialized, { elapsedInYearMs: "0" }), bootstrap(seed)))).toBe("E_P3A_STATE");
  });
});
