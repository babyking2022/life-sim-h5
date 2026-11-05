import { describe, expect, it } from "vitest";
import type { P3ALifeState, VersionTuple } from "@life-sim/contracts";
import { deriveDomainState } from "../src/rng/seed";
import {
  applyLifeCommand,
  assertLifeStateInvariants,
  createLifeState,
  LifeError,
  serializeLifeState
} from "../src/life";

/**
 * P3-A.6 反例：`visibility = "hidden"` 時 `FAST_FORWARD_STEP` 必須在年度迴圈**之前**
 * 以 `E_P3A_PHASE` 拒絕，且不得有任何副作用（P3-A.5 只把最後 mode 改回 paused，仍會跑完 3 年）。
 *
 * 另外驗證反向條件：`visible` + `paused` 仍必須可以正常快轉（避免過度封鎖）。
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
const bootstrap = (seed = "p3a6") => ({
  versions: VERSIONS,
  origin: ORIGIN,
  birthYear: 2020,
  paceLifeYearsX10: 780,
  rngState: deriveDomainState(seed, "life")
});
const make = (seed = "p3a6"): P3ALifeState => createLifeState(bootstrap(seed));
const play = (state: P3ALifeState) => applyLifeCommand(state, { type: "SET_PLAYBACK", paused: false }).state;
const hide = (state: P3ALifeState) => applyLifeCommand(state, { type: "SET_PLAYBACK", hidden: true }).state;

const failError = (action: () => unknown): LifeError => {
  try {
    action();
  } catch (error) {
    if (error instanceof LifeError) return error;
    throw new Error(`expected LifeError, got ${(error as Error).name}: ${(error as Error).message}`);
  }
  throw new Error("expected an error but call succeeded");
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
};

/** 取出一份「權威 + 顯示」完整快照，用來證明呼叫前後沒有任何欄位變動。 */
const snapshot = (state: P3ALifeState) => ({
  age: state.age,
  currentYear: state.currentYear,
  phase: state.phase,
  errorCode: state.errorCode,
  stats: { ...state.stats },
  assets: {
    balanceMicroUsd: state.assets.balanceMicroUsd.toString(),
    annualIncomeMicroUsd: state.assets.annualIncomeMicroUsd.toString(),
    annualExpenseMicroUsd: state.assets.annualExpenseMicroUsd.toString()
  },
  flags: [...state.flags],
  rng: { domain: state.rng.domain, state: [...state.rng.state], draws: state.rng.draws },
  pendingDecision: state.pendingDecision === null ? null : JSON.parse(JSON.stringify(state.pendingDecision)),
  history: { ...state.history },
  commandLogLength: state.commandLog.length,
  commandLog: JSON.parse(JSON.stringify(state.commandLog)),
  stateHash: state.stateHash,
  hashChain: state.hashChain,
  playback: { ...state.playback },
  serialized: JSON.stringify(serializeLifeState(state))
});

describe("P3-A.6 反例：hidden 狀態的快轉必須在迴圈前被拒絕（無副作用）", () => {
  it("returns E_P3A_PHASE and leaves every field untouched", () => {
    const hidden = hide(play(make("p3a6-hidden")));
    expect(hidden.playback.visibility).toBe("hidden");
    expect(hidden.playback.mode).toBe("paused");
    const before = snapshot(hidden);

    const error = failError(() => applyLifeCommand(hidden, { type: "FAST_FORWARD_STEP", maxYears: 3 }));
    expect(error.code).toBe("E_P3A_PHASE");

    const after = snapshot(hidden);
    // 1. 固定錯誤碼已驗；2. age；3. currentYear；4. stats／assets／flags；
    // 5. RNG；6. pendingDecision／phase；7. history；8. stateHash／hashChain；
    // 9. commandLog；11. playback；以及完整序列化結果。
    expect(after.age).toBe(before.age);
    expect(after.age).toBe(0);
    expect(after.currentYear).toBe(before.currentYear);
    expect(after.phase).toBe(before.phase);
    expect(after.errorCode).toBe(before.errorCode);
    expect(after.stats).toEqual(before.stats);
    expect(after.assets).toEqual(before.assets);
    expect(after.flags).toEqual(before.flags);
    expect(after.rng).toEqual(before.rng);
    expect(after.pendingDecision).toEqual(before.pendingDecision);
    expect(after.history).toEqual(before.history);
    expect(after.commandLogLength).toBe(before.commandLogLength);
    expect(after.commandLog).toEqual(before.commandLog);
    expect(after.stateHash).toBe(before.stateHash);
    expect(after.hashChain).toBe(before.hashChain);
    expect(after.playback).toEqual(before.playback);
    expect(after.serialized).toBe(before.serialized);
    expect(okCode(() => assertLifeStateInvariants(hidden))).toBe("NO_ERROR");
  });

  it("does not touch a frozen input state (no in-place mutation)", () => {
    const hidden = hide(play(make("p3a6-frozen")));
    const frozen = deepFreeze(structuredClone(hidden));
    const before = JSON.stringify(serializeLifeState(frozen));
    // 深凍結後若有人嘗試寫入，strict mode 會丟 TypeError；這裡必須只有 LifeError。
    const error = failError(() => applyLifeCommand(frozen, { type: "FAST_FORWARD_STEP", maxYears: 5 }));
    expect(error.code).toBe("E_P3A_PHASE");
    expect(JSON.stringify(serializeLifeState(frozen))).toBe(before);
    expect(frozen.age).toBe(0);
    expect(frozen.history.yearsRecorded).toBe(0);
    expect(frozen.history.cardsTotal).toBe(0);
    expect(frozen.playback.visibility).toBe("hidden");
    expect(frozen.playback.mode).toBe("paused");
  });

  it("rejects hidden fast-forward in every game phase", () => {
    // 一般生活期
    expect(failError(() => applyLifeCommand(hide(play(make("p3a6-phase"))), { type: "FAST_FORWARD_STEP", maxYears: 1 })).code).toBe("E_P3A_PHASE");

    // 待抉擇（六歲）
    let pending = play(make("p3a6-pending"));
    while (pending.history.yearsRecorded < 6) pending = applyLifeCommand(pending, { type: "FAST_FORWARD_STEP", maxYears: 1 }).state;
    expect(pending.phase).toBe("pending_decision");
    const hiddenPending = applyLifeCommand(pending, { type: "SET_PLAYBACK", hidden: true }).state;
    const beforePending = JSON.stringify(serializeLifeState(hiddenPending));
    expect(failError(() => applyLifeCommand(hiddenPending, { type: "FAST_FORWARD_STEP", maxYears: 2 })).code).toBe("E_P3A_PHASE");
    expect(JSON.stringify(serializeLifeState(hiddenPending))).toBe(beforePending);
    expect(hiddenPending.pendingDecision).toEqual(pending.pendingDecision);
  });

  it("keeps visible + paused fast-forward working", () => {
    const paused = applyLifeCommand(make("p3a6-visible"), { type: "SET_PLAYBACK", paused: true }).state;
    expect(paused.playback.visibility).toBe("visible");
    expect(paused.playback.mode).toBe("paused");
    const result = applyLifeCommand(paused, { type: "FAST_FORWARD_STEP", maxYears: 3 });
    expect(result.deltas).toHaveLength(3);
    expect(result.state.age).toBe(3);
    expect(result.state.history.yearsRecorded).toBe(3);
    expect(result.state.history.cardsTotal).toBe(3);
    expect(result.state.stateHash).not.toBe(paused.stateHash);
    expect(result.state.playback.mode).toBe("fast_forward");
    // 快轉結果仍必須通過完整不變量。
    expect(okCode(() => assertLifeStateInvariants(result.state))).toBe("NO_ERROR");
  });

  it("hides the same way as NEXT and forced resume when a decision is pending", () => {
    const pending = (() => {
      let state = play(make("p3a6-consistency"));
      while (state.history.yearsRecorded < 6) state = applyLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: 1 }).state;
      return state;
    })();
    const hidden = applyLifeCommand(pending, { type: "SET_PLAYBACK", hidden: true }).state;
    // NEXT、強制 playing、快轉在 hidden 下都是 E_P3A_PHASE。
    expect(failError(() => applyLifeCommand(hidden, { type: "NEXT" })).code).toBe("E_P3A_PHASE");
    expect(failError(() => applyLifeCommand(hidden, { type: "SET_PLAYBACK", paused: false })).code).toBe("E_P3A_PHASE");
    expect(failError(() => applyLifeCommand(hidden, { type: "FAST_FORWARD_STEP", maxYears: 1 })).code).toBe("E_P3A_PHASE");
  });
});

function okCode(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof LifeError ? error.code : `OTHER:${(error as Error).name}`;
  }
}
