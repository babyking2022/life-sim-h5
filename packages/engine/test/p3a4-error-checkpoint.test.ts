import { describe, expect, it } from "vitest";
import type { P3ALifeState, SerializedP3ALifeState, VersionTuple } from "@life-sim/contracts";
import { deriveDomainState } from "../src/rng/seed";
import { disableYearFailureInjection, enableYearFailureInjection } from "../src/life/benchmark";
import {
  applyLifeCommand,
  assertLifeStateInvariants,
  createLifeState,
  deserializeLifeState,
  LifeError,
  serializeLifeState,
  verifyLifeState
} from "../src/life";

/**
 * P3-A.4 反例 1：`phase = "error"` 是暫態終止畫面，不是合法存檔終點。
 * - error state 通過執行期 invariant；
 * - `serializeLifeState` 固定回 `E_P3A_PHASE`；
 * - 錯誤發生前最後一個 checkpoint 仍可 serialize → deserialize → verify；
 * - 不得洩漏原生 TypeError。
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
const bootstrap = (seed = "p3a4-error") => ({
  versions: VERSIONS,
  origin: ORIGIN,
  birthYear: 2020,
  paceLifeYearsX10: 780,
  rngState: deriveDomainState(seed, "life")
});
const make = (seed = "p3a4-error"): P3ALifeState => createLifeState(bootstrap(seed));
const play = (state: P3ALifeState) => applyLifeCommand(state, { type: "SET_PLAYBACK", paused: false }).state;

const errorOf = (action: () => unknown): LifeError => {
  try {
    action();
  } catch (error) {
    if (error instanceof LifeError) return error;
    throw new Error(`expected LifeError, got ${(error as Error).name}: ${(error as Error).message}`);
  }
  throw new Error("expected an error but call succeeded");
};
const failCode = (action: () => unknown): string => errorOf(action).code;
const okCode = (action: () => unknown): string => {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof LifeError ? error.code : `OTHER:${(error as Error).name}`;
  }
};

/** 用 checkpoint 的序列化結果人工拼出同一個 error state 的存檔（模擬偽造存檔）。 */
const asErrorPayload = (checkpoint: P3ALifeState, errorState: P3ALifeState): SerializedP3ALifeState => {
  const serialized = serializeLifeState(checkpoint) as unknown as Record<string, unknown>;
  return {
    ...serialized,
    phase: "error",
    errorCode: errorState.errorCode,
    pendingDecision: errorState.pendingDecision,
    playback: errorState.playback,
    stateHash: errorState.stateHash
  } as unknown as SerializedP3ALifeState;
};

describe("P3-A.4 反例 1：TICK 年度失敗後的 error 狀態不可存檔", () => {
  it("passes invariants but refuses serialization, and keeps the last checkpoint restorable", () => {
    const seed = "p3a4-tick";
    enableYearFailureInjection(1);
    try {
      let state = applyLifeCommand(make(seed), { type: "SET_PLAYBACK", paused: false, speed: 16 }).state;
      state = applyLifeCommand(state, { type: "TICK", deltaMs: 1000 }).state;
      state = applyLifeCommand(state, { type: "TICK", deltaMs: 1000 }).state;
      const checkpoint = state;
      expect(checkpoint.phase).toBe("life");
      expect(checkpoint.history.yearsRecorded).toBe(0);

      const failed = applyLifeCommand(checkpoint, { type: "TICK", deltaMs: 1000 }).state;
      expect(failed.phase).toBe("error");
      expect(failed.errorCode).toBe("E_P3A_YEAR");
      expect(failed.playback.mode).toBe("paused");
      expect(failed.playback.elapsedInYearMs).toBe(48000 - 46154);
      expect(failed.history.yearsRecorded).toBe(0);
      // 執行期 invariant 仍然通過。
      expect(okCode(() => assertLifeStateInvariants(failed))).toBe("NO_ERROR");
      // 但不是合法存檔終點。
      expect(failCode(() => serializeLifeState(failed))).toBe("E_P3A_PHASE");

      // 錯誤前最後一個 checkpoint 仍可完整存檔／還原／驗證。
      const serializedCheckpoint = serializeLifeState(checkpoint);
      const restored = deserializeLifeState(serializedCheckpoint, bootstrap(seed));
      expect(restored.stateHash).toBe(checkpoint.stateHash);
      expect(restored.playback.mode).toBe("paused");
      expect(restored.playback.speed).toBe(16);
      expect(restored.playback.elapsedInYearMs).toBe(checkpoint.playback.elapsedInYearMs);
      expect(okCode(() => verifyLifeState(bootstrap(seed), restored))).toBe("NO_ERROR");

      // 就算是人工拼出來的 error 存檔，反序列化也必須拒絕。
      expect(failCode(() => deserializeLifeState(asErrorPayload(checkpoint, failed), bootstrap(seed)))).toBe("E_P3A_PHASE");
      expect(failCode(() => verifyLifeState(bootstrap(seed), failed))).toBe("E_P3A_PHASE");
    } finally {
      disableYearFailureInjection();
    }
  });
});

describe("P3-A.4 反例 1：FAST_FORWARD 年度失敗後的 error 狀態不可存檔", () => {
  it("passes invariants but refuses serialization, and keeps the last checkpoint restorable", () => {
    const seed = "p3a4-ff";
    const checkpoint = play(make(seed));
    enableYearFailureInjection(1);
    try {
      const failed = applyLifeCommand(checkpoint, { type: "FAST_FORWARD_STEP", maxYears: 5 }).state;
      expect(failed.phase).toBe("error");
      expect(failed.errorCode).toBe("E_P3A_YEAR");
      expect(failed.history.yearsRecorded).toBe(0);
      expect(okCode(() => assertLifeStateInvariants(failed))).toBe("NO_ERROR");
      expect(failCode(() => serializeLifeState(failed))).toBe("E_P3A_PHASE");

      const serializedCheckpoint = serializeLifeState(checkpoint);
      const restored = deserializeLifeState(serializedCheckpoint, bootstrap(seed));
      expect(restored.stateHash).toBe(checkpoint.stateHash);
      expect(okCode(() => verifyLifeState(bootstrap(seed), restored))).toBe("NO_ERROR");
      expect(failCode(() => deserializeLifeState(asErrorPayload(checkpoint, failed), bootstrap(seed)))).toBe("E_P3A_PHASE");
    } finally {
      disableYearFailureInjection();
    }
  });

  it("only ever surfaces fixed LifeError codes for error-state entry points", () => {
    const seed = "p3a4-codes";
    enableYearFailureInjection(1);
    try {
      const failed = applyLifeCommand(play(make(seed)), { type: "FAST_FORWARD_STEP", maxYears: 3 }).state;
      const serialized = asErrorPayload(play(make(seed)), failed);
      const calls: readonly (readonly [string, () => unknown])[] = [
        ["serializeLifeState", () => serializeLifeState(failed)],
        ["deserializeLifeState(error)", () => deserializeLifeState(serialized, bootstrap(seed))],
        ["verifyLifeState(error)", () => verifyLifeState(bootstrap(seed), failed)],
        ["verifyLifeReplay(error)", () => verifyLifeState(null as never, failed)],
        ["assertLifeStateInvariants(null)", () => assertLifeStateInvariants(null as never)]
      ];
      for (const [label, call] of calls) {
        expect(okCode(call), label).toMatch(/^E_P3A_/);
      }
    } finally {
      disableYearFailureInjection();
    }
  });
});
