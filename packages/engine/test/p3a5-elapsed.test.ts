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
 * P3-A.5 反例：年度已耗時間不變量 `0 <= elapsedInYearMs < yearDurationMs`。
 *
 * 兩個原始漏洞：
 * - 案例 A：存檔把 elapsed 設成 >= yearDuration，deserialize 接受，TICK 0ms 直接跨年；
 * - 案例 B：合法操作改 paceMinutes 讓 yearDuration 變小，但 elapsed 沒換算，TICK 0ms 直接跨年。
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
const bootstrap = (seed = "p3a5") => ({
  versions: VERSIONS,
  origin: ORIGIN,
  birthYear: 2020,
  paceLifeYearsX10: 780,
  rngState: deriveDomainState(seed, "life")
});
const make = (seed = "p3a5"): P3ALifeState => createLifeState(bootstrap(seed));
const play = (state: P3ALifeState) => applyLifeCommand(state, { type: "SET_PLAYBACK", paused: false }).state;
const tick = (state: P3ALifeState, deltaMs = 1000) => applyLifeCommand(state, { type: "TICK", deltaMs }).state;

const failCode = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof LifeError) return error.code;
    throw new Error(`expected LifeError, got ${(error as Error).name}: ${(error as Error).message}`);
  }
  throw new Error("expected an error but call succeeded");
};
const okCode = (action: () => unknown): string => {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof LifeError ? error.code : `OTHER:${(error as Error).name}`;
  }
};

const withElapsed = (serialized: SerializedP3ALifeState, elapsedInYearMs: number, patch: Record<string, unknown> = {}): SerializedP3ALifeState =>
  ({
    ...(serialized as unknown as Record<string, unknown>),
    playback: { ...(serialized.playback as unknown as Record<string, unknown>), ...patch, elapsedInYearMs }
  }) as unknown as SerializedP3ALifeState;

/** 合法地把 elapsed 累積到指定速度下的某個值。 */
const playTo = (seed: string, speed: number, ticks: number, paceMinutes?: number): P3ALifeState => {
  let state = applyLifeCommand(make(seed), {
    type: "SET_PLAYBACK",
    paused: false,
    speed,
    ...(paceMinutes === undefined ? {} : { paceMinutes })
  }).state;
  for (let index = 0; index < ticks; index += 1) state = tick(state);
  return state;
};

describe("P3-A.5 反例 1–3：反序列化必須拒絕 elapsed >= yearDurationMs", () => {
  it("rejects elapsed == yearDurationMs", () => {
    const seed = "p3a5-eq";
    const state = playTo(seed, 1, 1);
    const serialized = serializeLifeState(state);
    const duration = serialized.playback.yearDurationMs;
    expect(failCode(() => deserializeLifeState(withElapsed(serialized, duration), bootstrap(seed)))).toBe("E_P3A_STATE");
    // 直接驗證不變量也一樣（不是只有反序列化擋）。
    expect(failCode(() => assertLifeStateInvariants({ ...state, playback: { ...state.playback, elapsedInYearMs: duration } }))).toBe("E_P3A_STATE");
  });

  it("rejects elapsed > yearDurationMs", () => {
    const seed = "p3a5-gt";
    const state = playTo(seed, 1, 1);
    const serialized = serializeLifeState(state);
    const duration = serialized.playback.yearDurationMs;
    expect(failCode(() => deserializeLifeState(withElapsed(serialized, duration + 1), bootstrap(seed)))).toBe("E_P3A_STATE");
    expect(failCode(() => deserializeLifeState(withElapsed(serialized, duration * 3), bootstrap(seed)))).toBe("E_P3A_STATE");
    expect(failCode(() => assertLifeStateInvariants({ ...state, playback: { ...state.playback, elapsedInYearMs: duration + 1 } }))).toBe("E_P3A_STATE");
  });

  it("rejects elapsed == Number.MAX_SAFE_INTEGER", () => {
    const seed = "p3a5-max";
    const state = playTo(seed, 1, 1);
    const serialized = serializeLifeState(state);
    expect(failCode(() => deserializeLifeState(withElapsed(serialized, Number.MAX_SAFE_INTEGER), bootstrap(seed)))).toBe("E_P3A_STATE");
    expect(
      failCode(() => assertLifeStateInvariants({ ...state, playback: { ...state.playback, elapsedInYearMs: Number.MAX_SAFE_INTEGER } }))
    ).toBe("E_P3A_STATE");
  });
});

describe("P3-A.5 反例 4–5：改 pace 必須按比例換算 elapsed", () => {
  it("rescales elapsed when pace goes 60 → 30", () => {
    const seed = "p3a5-p60-30";
    // pace 60（預設）、speed 16、兩次 TICK → elapsed 32000 / duration 46154
    const before = playTo(seed, 16, 2);
    expect(before.playback.paceMinutes).toBe(60);
    expect(before.playback.elapsedInYearMs).toBe(32000);
    expect(before.playback.yearDurationMs).toBe(46154);

    const after = applyLifeCommand(before, { type: "SET_PLAYBACK", paceMinutes: 30 }).state;
    expect(after.playback.paceMinutes).toBe(30);
    expect(after.playback.yearDurationMs).toBe(23077);
    expect(after.playback.elapsedInYearMs).toBe(Math.floor((32000 * 23077) / 46154));
    expect(after.playback.elapsedInYearMs).toBe(16000);
    expect(after.playback.elapsedInYearMs).toBeLessThan(after.playback.yearDurationMs);
    expect(okCode(() => assertLifeStateInvariants(after))).toBe("NO_ERROR");
  });

  it("rescales elapsed when pace goes 30 → 90", () => {
    const seed = "p3a5-p30-90";
    const before = playTo(seed, 8, 2, 30);
    expect(before.playback.paceMinutes).toBe(30);
    expect(before.playback.yearDurationMs).toBe(23077);
    expect(before.playback.elapsedInYearMs).toBe(16000);

    const after = applyLifeCommand(before, { type: "SET_PLAYBACK", paceMinutes: 90 }).state;
    expect(after.playback.paceMinutes).toBe(90);
    expect(after.playback.yearDurationMs).toBe(computeYearDurationMs(90, 780));
    expect(after.playback.elapsedInYearMs).toBe(Math.floor((16000 * computeYearDurationMs(90, 780)) / 23077));
    expect(after.playback.elapsedInYearMs).toBeLessThan(after.playback.yearDurationMs);
    expect(okCode(() => assertLifeStateInvariants(after))).toBe("NO_ERROR");
  });

  it("keeps elapsed legal for every pace transition and every legal elapsed", () => {
    const seed = "p3a5-all-pace";
    for (const fromPace of [30, 60, 90]) {
      for (const toPace of [30, 60, 90]) {
        for (const speed of [1, 16]) {
          for (const ticks of [0, 1, 3, 7]) {
            const before = playTo(seed, speed, ticks, fromPace);
            const after = applyLifeCommand(before, { type: "SET_PLAYBACK", paceMinutes: toPace }).state;
            const playback = after.playback;
            expect(playback.elapsedInYearMs, `${fromPace}->${toPace} speed=${speed} ticks=${ticks}`).toBeGreaterThanOrEqual(0);
            expect(playback.elapsedInYearMs, `${fromPace}->${toPace} speed=${speed} ticks=${ticks}`).toBeLessThan(playback.yearDurationMs);
            expect(okCode(() => assertLifeStateInvariants(after))).toBe("NO_ERROR");
          }
        }
      }
    }
  });
});

describe("P3-A.5 反例 6–7：pace 變更後 TICK 0ms 不得跨年；只改 speed 不動 elapsed", () => {
  it("does not advance age/year/history/commandLog/hashChain after a pace change + TICK 0ms", () => {
    const seed = "p3a5-tick0";
    const before = playTo(seed, 16, 2);
    const afterPace = applyLifeCommand(before, { type: "SET_PLAYBACK", paceMinutes: 30 }).state;
    const snapshot = {
      age: afterPace.age,
      currentYear: afterPace.currentYear,
      yearsRecorded: afterPace.history.yearsRecorded,
      lastEntryHash: afterPace.history.lastEntryHash,
      lastDeltaHash: afterPace.history.lastDeltaHash,
      commandLog: afterPace.commandLog.length,
      hashChain: afterPace.hashChain,
      stateHash: afterPace.stateHash,
      elapsed: afterPace.playback.elapsedInYearMs
    };
    const afterTick = tick(afterPace, 0);
    expect(afterTick.age).toBe(snapshot.age);
    expect(afterTick.currentYear).toBe(snapshot.currentYear);
    expect(afterTick.history.yearsRecorded).toBe(snapshot.yearsRecorded);
    expect(afterTick.history.lastEntryHash).toBe(snapshot.lastEntryHash);
    expect(afterTick.history.lastDeltaHash).toBe(snapshot.lastDeltaHash);
    expect(afterTick.commandLog).toHaveLength(snapshot.commandLog);
    expect(afterTick.hashChain).toBe(snapshot.hashChain);
    expect(afterTick.stateHash).toBe(snapshot.stateHash);
    expect(afterTick.playback.elapsedInYearMs).toBe(snapshot.elapsed);
    expect(okCode(() => assertLifeStateInvariants(afterTick))).toBe("NO_ERROR");
  });

  it("only changes elapsed when speed changes", () => {
    const seed = "p3a5-speed";
    const before = playTo(seed, 1, 2);
    const elapsed = before.playback.elapsedInYearMs;
    expect(elapsed).toBe(2000);
    const faster = applyLifeCommand(before, { type: "SET_PLAYBACK", speed: 16 }).state;
    expect(faster.playback.elapsedInYearMs).toBe(elapsed);
    expect(faster.playback.speed).toBe(16);
    expect(faster.playback.yearDurationMs).toBe(before.playback.yearDurationMs);
    const slower = applyLifeCommand(faster, { type: "SET_PLAYBACK", speed: 2 }).state;
    expect(slower.playback.elapsedInYearMs).toBe(elapsed);
    expect(okCode(() => assertLifeStateInvariants(slower))).toBe("NO_ERROR");
  });
});

describe("P3-A.5 反例 8–9：冷啟動政策與邊界值", () => {
  it("keeps legal speed/pace/elapsed/cardsSeen and forces paused/visible", () => {
    const seed = "p3a5-cold";
    let state = playTo(seed, 16, 2, 30);
    state = applyLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: 2 }).state;
    state = applyLifeCommand(state, { type: "SET_PLAYBACK", paused: true }).state;
    state = tick(applyLifeCommand(state, { type: "SET_PLAYBACK", paused: false }).state, 1000);
    state = applyLifeCommand(state, { type: "SET_PLAYBACK", hidden: true }).state;
    expect(state.playback.cardsSeen).toBe(0);
    const restored = deserializeLifeState(serializeLifeState(state), bootstrap(seed));
    expect(restored.playback.mode).toBe("paused");
    expect(restored.playback.visibility).toBe("visible");
    expect(restored.playback.previousMode).toBe("paused");
    expect(restored.playback.speed).toBe(state.playback.speed);
    expect(restored.playback.paceMinutes).toBe(state.playback.paceMinutes);
    expect(restored.playback.elapsedInYearMs).toBe(state.playback.elapsedInYearMs);
    expect(restored.playback.cardsSeen).toBe(state.playback.cardsSeen);
    expect(restored.playback.yearDurationMs).toBe(computeYearDurationMs(state.playback.paceMinutes, state.paceLifeYearsX10));
    expect(restored.playback.elapsedInYearMs).toBeLessThan(restored.playback.yearDurationMs);
    expect(okCode(() => assertLifeStateInvariants(restored))).toBe("NO_ERROR");
  });

  it("still restores elapsed == yearDurationMs - 1", () => {
    const seed = "p3a5-boundary";
    const state = playTo(seed, 1, 1);
    const serialized = serializeLifeState(state);
    const duration = serialized.playback.yearDurationMs;
    const restored = deserializeLifeState(withElapsed(serialized, duration - 1), bootstrap(seed));
    expect(restored.playback.elapsedInYearMs).toBe(duration - 1);
    expect(okCode(() => assertLifeStateInvariants(restored))).toBe("NO_ERROR");
    // 而且 TICK 0ms 仍然不會跨年。
    const afterTick = tick(restored, 0);
    expect(afterTick.age).toBe(restored.age);
    expect(afterTick.playback.elapsedInYearMs).toBe(duration - 1);
  });
});

describe("P3-A.5 反例 11／P3-A.6 修正：背景隱藏時不得執行快轉", () => {
  it("rejects FAST_FORWARD_STEP in a hidden session without touching the state", () => {
    const seed = "p3a5-hidden-ff";
    const hidden = applyLifeCommand(play(make(seed)), { type: "SET_PLAYBACK", hidden: true }).state;
    expect(hidden.playback.visibility).toBe("hidden");
    const before = JSON.stringify(serializeLifeState(hidden));
    expect(failCode(() => applyLifeCommand(hidden, { type: "FAST_FORWARD_STEP", maxYears: 3 }))).toBe("E_P3A_PHASE");
    expect(JSON.stringify(serializeLifeState(hidden))).toBe(before);
    expect(hidden.age).toBe(0);
    expect(okCode(() => assertLifeStateInvariants(hidden))).toBe("NO_ERROR");
  });
});

describe("P3-A.5 反例 10：所有公開指令的結果都必須符合完整不變量", () => {
  it("keeps the invariant across a long mixed command sequence", () => {
    const seed = "p3a5-sequence";
    let state = play(make(seed));
    const speeds: readonly number[] = [1, 16, 2, 8, 12, 4];
    const paces: readonly number[] = [30, 90, 60];
    let applied = 0;
    let rejected = 0;
    for (let step = 0; step < 140; step += 1) {
      const kind = step % 7;
      const speed = speeds[step % speeds.length] as number;
      const pace = paces[step % paces.length] as number;
      const command =
        kind === 0
          ? { type: "TICK" as const, deltaMs: (step * 37) % 1001 }
          : kind === 1
            ? { type: "SET_PLAYBACK" as const, speed }
            : kind === 2
              ? { type: "SET_PLAYBACK" as const, paceMinutes: pace }
              : kind === 3
                ? { type: "FAST_FORWARD_STEP" as const, maxYears: 1 + (step % 3) }
                : kind === 4
                  ? { type: "SELECT_DECISION" as const, optionId: "steady" }
                  : kind === 5
                    ? { type: "SET_PLAYBACK" as const, paused: state.playback.mode === "playing" }
                    : { type: "SET_PLAYBACK" as const, hidden: state.playback.visibility === "visible" };
      try {
        state = applyLifeCommand(state, command).state;
        applied += 1;
      } catch (error) {
        // 非法指令必須是固定碼，且狀態不得被改動。
        expect(error).toBeInstanceOf(LifeError);
        rejected += 1;
      }
      expect(okCode(() => assertLifeStateInvariants(state)), `step ${step} (${command.type})`).toBe("NO_ERROR");
      expect(state.playback.elapsedInYearMs, `step ${step}`).toBeLessThan(state.playback.yearDurationMs);
      if (state.phase === "death") break;
    }
    expect(applied).toBeGreaterThan(20);
    expect(rejected).toBeGreaterThan(0);
  });
});
