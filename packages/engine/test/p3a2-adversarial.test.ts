import { describe, expect, it } from "vitest";
import type { P3ACommandRecord, P3ALifeState, VersionTuple } from "@life-sim/contracts";
import { deriveDomainState } from "../src/rng/seed";
import { benchmarkBootstrap, createBenchmarkLifeState, reconstructBenchmarkLifeState } from "../src/life/benchmark";
import {
  applyLifeCommand,
  assertLifeStateHash,
  assertLifeStateInvariants,
  createLifeState,
  deserializeLifeState,
  LifeError,
  reconstructLifeState,
  resolveLifeYear,
  resolveYear,
  serializeLifeState,
  verifyLifeReplay
} from "../src/life";

/**
 * P3-A.2 反例（P3-A.3 版）：每一條對應退修單編號，API 已改成
 * 「重建 reconstructLifeState」＋「驗證 verifyLifeReplay／deserializeLifeState(state, bootstrap)」。
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
const bootstrap = (seed = "p3a2") => ({
  versions: VERSIONS,
  origin: ORIGIN,
  birthYear: 2020,
  paceLifeYearsX10: 780,
  rngState: deriveDomainState(seed, "life")
});
const make = (seed = "p3a2"): P3ALifeState => createLifeState(bootstrap(seed));
const play = (state: P3ALifeState) => applyLifeCommand(state, { type: "SET_PLAYBACK", paused: false }).state;
const ff = (state: P3ALifeState, years: number) => applyLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: years }).state;
const cancelFastForward = (state: P3ALifeState) => applyLifeCommand(state, { type: "SET_PLAYBACK", paused: true }).state;

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
const codeOf = (action: () => unknown): string => {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof LifeError ? error.code : `OTHER:${(error as Error).name}`;
  }
};

const atFirstDecision = (seed = "p3a2"): P3ALifeState => ff(play(make(seed)), 20);
const selectedSix = (seed = "p3a2"): P3ALifeState => {
  const pending = atFirstDecision(seed);
  return applyLifeCommand(pending, { type: "SELECT_DECISION", optionId: "steady" }).state;
};
const confirmedSix = (seed = "p3a2"): P3ALifeState => applyLifeCommand(selectedSix(seed), { type: "NEXT" }).state;

const deathState = (seed = "p3a2"): P3ALifeState => {
  let state = play(createBenchmarkLifeState(bootstrap(seed), 8));
  for (let guard = 0; guard < 20 && state.phase !== "death"; guard += 1) {
    state = cancelFastForward(ff(state, 1));
    if (state.pendingDecision !== null) {
      state = applyLifeCommand(state, { type: "SELECT_DECISION", optionId: "steady" }).state;
      state = applyLifeCommand(state, { type: "NEXT" }).state;
    }
  }
  expect(state.phase).toBe("death");
  return state;
};

describe("P3-A.2 反例 1：CommandRecord before／after 必須是真正的指令前後 hash", () => {
  it("records the pre-command and post-command state hashes", () => {
    const pending = atFirstDecision("rec");
    const beforeHash = pending.stateHash;
    const selected = applyLifeCommand(pending, { type: "SELECT_DECISION", optionId: "steady" }).state;
    const afterHash = selected.stateHash;
    expect(afterHash).not.toBe(beforeHash);
    const record = selected.commandLog[0] as P3ACommandRecord;
    expect(record.stateHashBefore).toBe(beforeHash);
    expect(record.stateHashAfter).toBe(afterHash);
    expect(record.stateHashBefore).not.toBe(record.stateHashAfter);
    expect(record.stateHashAfter).toBe(selected.stateHash);

    const confirmed = applyLifeCommand(selected, { type: "NEXT" }).state;
    const confirmRecord = confirmed.commandLog[1] as P3ACommandRecord;
    expect(confirmRecord.commandType).toBe("CONFIRM_DECISION");
    expect(confirmRecord.stateHashBefore).toBe(selected.stateHash);
    expect(confirmRecord.stateHashAfter).toBe(confirmed.stateHash);
    expect(confirmed.commandLog[0]).toEqual(record);
  });

  it("starts the hashChain from the initial stateHash, not just the certificate hash", () => {
    const fresh = make("rec");
    expect(fresh.history.initialStateHash).toBe(fresh.stateHash);
    expect(fresh.hashChain).not.toBe(fresh.stateHash);
    const otherOrigin = createLifeState({ ...bootstrap("rec"), origin: { ...ORIGIN, certificateHash: "9".repeat(64) } });
    expect(fresh.hashChain).not.toBe(otherOrigin.hashChain);
    expect(fresh.history.initialStateHash).not.toBe(otherOrigin.history.initialStateHash);
  });
});

describe("P3-A.2 反例 2：history 被改成 999", () => {
  it("rejects a state whose yearsRecorded no longer matches age", () => {
    let state = make("hist");
    state = resolveYear(state);
    state = resolveYear(state);
    expect(state.history.yearsRecorded).toBe(2);
    const tampered: P3ALifeState = { ...state, history: { ...state.history, yearsRecorded: 999 } };
    expect(failCode(() => assertLifeStateInvariants(tampered))).toBe("E_P3A_HISTORY");
    expect(failCode(() => resolveLifeYear(tampered))).toBe("E_P3A_HISTORY");
    expect(failCode(() => applyLifeCommand(tampered, { type: "NEXT" }))).toBe("E_P3A_HISTORY");
    expect(failCode(() => serializeLifeState(tampered))).toBe("E_P3A_HISTORY");
    expect(codeOf(() => deserializeLifeState(serializeLifeState(state), bootstrap("hist")))).toBe("NO_ERROR");
    expect(
      failCode(() => deserializeLifeState({ ...serializeLifeState(state), history: { ...state.history, yearsRecorded: 999 } }, bootstrap("hist")))
    ).toBe("E_P3A_HISTORY");
  });
});

describe("P3-A.2 反例 3：flags 被改但保留舊 hash", () => {
  it("returns E_P3A_HASH for a year transaction on a tampered flag list", () => {
    const state = make("flags");
    const tampered: P3ALifeState = { ...state, flags: ["hacked"] };
    expect(failCode(() => assertLifeStateInvariants(tampered))).toBe("E_P3A_HASH");
    expect(failCode(() => resolveLifeYear(tampered))).toBe("E_P3A_HASH");
    expect(failCode(() => resolveYear(tampered))).toBe("E_P3A_HASH");
    expect(failCode(() => applyLifeCommand(tampered, { type: "TICK", deltaMs: 0 }))).toBe("E_P3A_HASH");
    expect(failCode(() => serializeLifeState(tampered))).toBe("E_P3A_HASH");
    expect(failCode(() => deserializeLifeState({ ...serializeLifeState(state), flags: ["hacked"] }, bootstrap("flags")))).toBe("E_P3A_HASH");
  });

  it("rejects flags that are unsorted or duplicated even when re-hashed by hand", () => {
    const state = confirmedSix("flags2");
    expect(failCode(() => assertLifeStateInvariants({ ...state, flags: ["b", "a"] }))).toBe("E_P3A_STATE");
    expect(failCode(() => assertLifeStateInvariants({ ...state, flags: ["a", "a"] }))).toBe("E_P3A_STATE");
  });
});

describe("P3-A.2 反例 4：commandLog／hashChain 任一欄被改", () => {
  const base = (): P3ALifeState => confirmedSix("log");

  const mutations: readonly (readonly [string, (record: P3ACommandRecord) => P3ACommandRecord])[] = [
    ["seq", (record) => ({ ...record, seq: record.seq + 1 })],
    ["commandType", (record) => ({ ...record, commandType: "CONFIRM_DECISION" })],
    ["payload", (record) => ({ ...record, payload: "bold" })],
    ["argsHash", (record) => ({ ...record, argsHash: "0".repeat(64) })],
    ["atYear", (record) => ({ ...record, atYear: record.atYear + 1 })],
    ["effectiveYear", (record) => ({ ...record, effectiveYear: record.effectiveYear + 1 })],
    ["auto", (record) => ({ ...record, auto: true })],
    ["policyId", (record) => ({ ...record, policyId: "auto" })],
    ["rngState", (record) => ({ ...record, rngState: [1, 2, 3, 4] as const })],
    ["rngDraws", (record) => ({ ...record, rngDraws: record.rngDraws + 1 })],
    ["stateHashBefore", (record) => ({ ...record, stateHashBefore: "1".repeat(64) })],
    ["stateHashAfter", (record) => ({ ...record, stateHashAfter: "2".repeat(64) })],
    ["chainHash", (record) => ({ ...record, chainHash: "3".repeat(64) })]
  ];

  it("rejects every single-field mutation of the command record", () => {
    const state = base();
    expect(state.commandLog).toHaveLength(2);
    const serialized = serializeLifeState(state);
    for (const [field, mutate] of mutations) {
      const record = state.commandLog[0] as P3ACommandRecord;
      const tampered: P3ALifeState = { ...state, commandLog: [mutate(record), state.commandLog[1] as P3ACommandRecord] };
      const code = failCode(() => assertLifeStateInvariants(tampered));
      expect(code, `field ${field} must be rejected`).toMatch(/^E_P3A_/);
      expect(failCode(() => resolveLifeYear(tampered))).toMatch(/^E_P3A_/);
      expect(failCode(() => deserializeLifeState({ ...serialized, commandLog: tampered.commandLog }, bootstrap("log")))).toMatch(/^E_P3A_/);
    }
  });

  it("rejects a tampered hashChain head", () => {
    const state = base();
    expect(failCode(() => assertLifeStateInvariants({ ...state, hashChain: "4".repeat(64) }))).toBe("E_P3A_HASH");
    expect(failCode(() => deserializeLifeState({ ...serializeLifeState(state), hashChain: "4".repeat(64) }, bootstrap("log")))).toBe("E_P3A_HASH");
  });

  it("rejects a forged initial chain root", () => {
    const state = base();
    expect(failCode(() => assertLifeStateInvariants({ ...state, history: { ...state.history, initialStateHash: "5".repeat(64) } }))).toBe("E_P3A_HASH");
  });
});

describe("P3-A.2 反例 5：stats=null 只能是 LifeError", () => {
  it("returns E_P3A_STATE instead of a native TypeError", () => {
    const state = make("nullstats");
    const tampered = { ...state, stats: null } as unknown as P3ALifeState;
    expect(failCode(() => assertLifeStateInvariants(tampered))).toBe("E_P3A_STATE");
    expect(failCode(() => resolveLifeYear(tampered))).toBe("E_P3A_STATE");
    expect(failCode(() => serializeLifeState(tampered))).toBe("E_P3A_STATE");
    expect(failCode(() => deserializeLifeState({ ...serializeLifeState(state), stats: null } as never, bootstrap("nullstats")))).toBe("E_P3A_STATE");
    expect(codeOf(() => reconstructLifeState({ bootstrap: bootstrap("nullstats"), targetYears: 0, commandLog: [] }))).toBe("NO_ERROR");
  });
});

describe("P3-A.2 反例 6：金錢只接受 BigInt", () => {
  it("returns E_P3A_MONEY for a Number amount on every public entry", () => {
    const state = make("money");
    const withNumber = (value: number): P3ALifeState =>
      ({ ...state, assets: { ...state.assets, balanceMicroUsd: value } }) as unknown as P3ALifeState;
    expect(failCode(() => resolveLifeYear(withNumber(1)))).toBe("E_P3A_MONEY");
    expect(failCode(() => applyLifeCommand(withNumber(1), { type: "NEXT" }))).toBe("E_P3A_MONEY");
    expect(failCode(() => serializeLifeState(withNumber(1)))).toBe("E_P3A_MONEY");
    expect(failCode(() => assertLifeStateHash(withNumber(1)))).toBe("E_P3A_MONEY");
    const serialized = serializeLifeState(state) as unknown as Record<string, unknown>;
    expect(
      failCode(() =>
        deserializeLifeState({ ...serialized, assets: { balanceMicroUsd: 1, annualIncomeMicroUsd: "0", annualExpenseMicroUsd: "0" } } as never, bootstrap("money"))
      )
    ).toBe("E_P3A_MONEY");
    expect(
      failCode(() =>
        deserializeLifeState(
           { ...serialized, assets: { balanceMicroUsd: "1000000000000000001", annualIncomeMicroUsd: "0", annualExpenseMicroUsd: "0" } } as never,
          bootstrap("money")
        )
      )
    ).toBe("E_P3A_MONEY");
  });
});

describe("P3-A.2 反例 7：phase／pending、year／age、death／lifespan 不一致", () => {
  it("rejects phase/pending mismatches", () => {
    const pending = atFirstDecision("mismatch");
    expect(failCode(() => assertLifeStateInvariants({ ...pending, phase: "life" }))).toBe("E_P3A_STATE");
    expect(failCode(() => assertLifeStateInvariants({ ...make("mismatch"), phase: "life", pendingDecision: pending.pendingDecision }))).toBe("E_P3A_STATE");
    const decision = pending.pendingDecision as NonNullable<P3ALifeState["pendingDecision"]>;
    expect(failCode(() => assertLifeStateInvariants({ ...pending, pendingDecision: { ...decision, year: pending.currentYear + 1 } }))).toBe("E_P3A_STATE");
  });

  it("rejects year/age mismatches", () => {
    const state = make("yeartest");
    expect(failCode(() => assertLifeStateInvariants({ ...state, currentYear: state.birthYear + 1 }))).toBe("E_P3A_STATE");
    expect(failCode(() => assertLifeStateInvariants({ ...state, age: 1 }))).toBe("E_P3A_STATE");
  });

  it("rejects death/lifespan mismatches", () => {
    const dead = deathState("death-mismatch");
    expect(codeOf(() => assertLifeStateInvariants(dead))).toBe("NO_ERROR");
    expect(failCode(() => assertLifeStateInvariants({ ...dead, phase: "life" }))).toBe("E_P3A_STATE");
    expect(failCode(() => assertLifeStateInvariants({ ...dead, lifespanYears: dead.age + 10 }))).toBe("E_P3A_STATE");
    expect(failCode(() => assertLifeStateInvariants({ ...make("death-mismatch2"), phase: "death" }))).toBe("E_P3A_STATE");
  });

  it("rejects a selected option that is not in the option list", () => {
    const pending = atFirstDecision("bad-option");
    const decision = pending.pendingDecision as NonNullable<P3ALifeState["pendingDecision"]>;
    expect(failCode(() => assertLifeStateInvariants({ ...pending, pendingDecision: { ...decision, selectedOptionId: "nope" } }))).toBe("E_P3A_STATE");
    const duplicated = { ...decision, options: [decision.options[0], decision.options[0]] };
    expect(failCode(() => assertLifeStateInvariants({ ...pending, pendingDecision: duplicated } as P3ALifeState))).toBe("E_P3A_STATE");
  });
});

describe("P3-A.2 反例 8：六歲選擇確認後可由 commandLog 完整重播", () => {
  it("reproduces the confirmed six-year-old state from bootstrap + commandLog", () => {
    const confirmed = confirmedSix("replay6");
    expect(confirmed.age).toBe(6);
    expect(confirmed.history.yearsRecorded).toBe(6);
    expect(confirmed.pendingDecision).toBeNull();
    expect(confirmed.commandLog).toHaveLength(2);

    const replayed = verifyLifeReplay({ bootstrap: bootstrap("replay6"), targetState: confirmed });
    expect(replayed.state.stateHash).toBe(confirmed.stateHash);
    expect(replayed.state.history.lastEntryHash).toBe(confirmed.history.lastEntryHash);
    expect(replayed.state.history.lastSnapshotHash).toBe(confirmed.history.lastSnapshotHash);
    expect(replayed.state.history.lastDeltaHash).toBe(confirmed.history.lastDeltaHash);
    expect(replayed.state.hashChain).toBe(confirmed.hashChain);
    expect(replayed.state.commandLog).toEqual(confirmed.commandLog);
    expect(replayed.state.flags).toEqual(confirmed.flags);

    const trace = reconstructLifeState({ bootstrap: bootstrap("replay6"), targetYears: 6, commandLog: confirmed.commandLog });
    expect(trace.commandsConsumed).toBe(2);
    expect(trace.yearsReplayed).toBe(6);
    expect(trace.deltas).toHaveLength(6);
  });

  it("rejects missing, extra, duplicated and reordered commands", () => {
    const confirmed = confirmedSix("replay6c");
    const log = confirmed.commandLog;
    const input = (years: number, commandLog: readonly P3ACommandRecord[]) => ({
      bootstrap: bootstrap("replay6c"),
      targetYears: years,
      commandLog
    });
    expect(failCode(() => verifyLifeReplay({ bootstrap: bootstrap("replay6c"), targetState: confirmed, commandLog: [] }))).toBe("E_P3A_ARGUMENT");
    expect(failCode(() => reconstructLifeState(input(6, [...log, ...log])))).toMatch(/^E_P3A_/);
    expect(failCode(() => reconstructLifeState(input(5, log)))).toMatch(/^E_P3A_/);
    expect(failCode(() => reconstructLifeState(input(6, [{ ...log[0], payload: "bold" } as P3ACommandRecord])))).toMatch(/^E_P3A_/);
    const divergence = errorOf(() => reconstructLifeState(input(6, [{ ...log[0], rngDraws: 99 } as P3ACommandRecord])));
    expect(divergence.code).toBe("E_P3A_HASH");
    expect(divergence.details?.divergenceSeq).toBe(1);
    expect(divergence.details?.divergenceYear).toBe(confirmed.birthYear + 6);
  });
});

describe("P3-A.2 反例 10：新生無卡片時 NEXT 不得增加 cardsSeen", () => {
  it("keeps cardsSeen at zero for a newborn with no card", () => {
    const fresh = make("cards");
    expect(fresh.history.cardsTotal).toBe(0);
    expect(fresh.playback.cardsSeen).toBe(0);
    const afterNext = applyLifeCommand(fresh, { type: "NEXT" }).state;
    expect(afterNext.playback.cardsSeen).toBe(0);
    expect(afterNext.playback.mode).toBe("playing");
    const again = applyLifeCommand(afterNext, { type: "NEXT" }).state;
    expect(again.playback.cardsSeen).toBe(0);
    expect(again.playback.mode).toBe("paused");
  });

  it("never lets cardsSeen exceed the tracked card total", () => {
    let state = play(make("cards2"));
    state = cancelFastForward(ff(state, 2));
    expect(state.history.cardsTotal).toBe(2);
    for (let index = 0; index < 2; index += 1) state = applyLifeCommand(state, { type: "NEXT" }).state;
    expect(state.playback.cardsSeen).toBe(2);
    state = applyLifeCommand(state, { type: "NEXT" }).state;
    expect(state.playback.cardsSeen).toBe(2);
    expect(state.playback.mode).toBe("playing");
  });
});

describe("P3-A.2 反例 11：paused → hidden → visible 仍是 paused", () => {
  it("restores paused after a hidden round trip", () => {
    const paused = make("hidden");
    const hidden = applyLifeCommand(paused, { type: "SET_PLAYBACK", hidden: true }).state;
    expect(hidden.playback.mode).toBe("paused");
    expect(hidden.playback.visibility).toBe("hidden");
    const visible = applyLifeCommand(hidden, { type: "SET_PLAYBACK", hidden: false }).state;
    expect(visible.playback.mode).toBe("paused");
    expect(visible.playback.visibility).toBe("visible");
    expect(applyLifeCommand(visible, { type: "TICK", deltaMs: 1000 }).state.playback.elapsedInYearMs).toBe(0);
  });

  it("does not catch up on background time and keeps elapsed", () => {
    let state = applyLifeCommand(play(make("hidden2")), { type: "TICK", deltaMs: 1000 }).state;
    const elapsed = state.playback.elapsedInYearMs;
    expect(elapsed).toBeGreaterThan(0);
    state = applyLifeCommand(state, { type: "SET_PLAYBACK", hidden: true }).state;
    expect(applyLifeCommand(state, { type: "TICK", deltaMs: 1000 }).state.playback.elapsedInYearMs).toBe(elapsed);
    state = applyLifeCommand(state, { type: "SET_PLAYBACK", hidden: false }).state;
    expect(state.playback.mode).toBe("playing");
    expect(state.playback.elapsedInYearMs).toBe(elapsed);
  });
});

describe("P3-A.2 反例 12：pending／death 不得變成 playing", () => {
  it("rejects SET_PLAYBACK paused=false while a decision is pending", () => {
    const pending = atFirstDecision("noresume");
    expect(failCode(() => applyLifeCommand(pending, { type: "SET_PLAYBACK", paused: false }))).toBe("E_P3A_PHASE");
    expect(pending.playback.mode).toBe("paused");
  });

  it("rejects SET_PLAYBACK paused=false in death and error", () => {
    const dead = deathState("noresume-death");
    expect(dead.playback.mode).toBe("paused");
    expect(failCode(() => applyLifeCommand(dead, { type: "SET_PLAYBACK", paused: false }))).toBe("E_P3A_PHASE");
    const errorState = { ...make("noresume-error"), phase: "error", errorCode: "E_P3A_STATE" } as P3ALifeState;
    expect(failCode(() => applyLifeCommand(errorState, { type: "SET_PLAYBACK", paused: false }))).toMatch(/^E_P3A_/);
    expect(failCode(() => assertLifeStateInvariants({ ...errorState, playback: { ...errorState.playback, mode: "playing" } }))).toMatch(
      /^E_P3A_(HASH|STATE)$/
    );
  });
});

describe("P3-A.2 反例 13：死亡卡讀完後 NEXT 仍是 death + paused", () => {
  it("stays dead and paused after the death card is consumed", () => {
    let state = deathState("deathcards");
    const total = state.history.cardsTotal;
    expect(total).toBeGreaterThan(0);
    for (let index = 0; index < total; index += 1) {
      state = applyLifeCommand(state, { type: "NEXT" }).state;
      expect(state.phase).toBe("death");
      expect(state.playback.mode).toBe("paused");
    }
    expect(state.playback.cardsSeen).toBe(total);
    for (let index = 0; index < 3; index += 1) {
      state = applyLifeCommand(state, { type: "NEXT" }).state;
      expect(state.phase).toBe("death");
      expect(state.playback.mode).toBe("paused");
      expect(state.playback.cardsSeen).toBe(total);
    }
  });
});

describe("P3-A.2 反例 14：TICK／1×／16×／FAST_FORWARD 同年必須一致", () => {
  it("produces identical stateHash, history heads and hashChain", () => {
    const seed = "sameness";
    const forwarded = ff(play(make(seed)), 5);
    const byTicks = (speed: number): P3ALifeState => {
      let state = applyLifeCommand(make(seed), { type: "SET_PLAYBACK", paused: false, speed }).state;
      for (let guard = 0; guard < 5000 && state.age < 5; guard += 1) {
        state = applyLifeCommand(state, { type: "TICK", deltaMs: 1000 }).state;
      }
      return state;
    };
    for (const speed of [1, 2, 4, 8, 12, 16]) {
      const ticked = byTicks(speed);
      expect(ticked.age).toBe(forwarded.age);
      expect(ticked.stateHash).toBe(forwarded.stateHash);
      expect(ticked.history.lastEntryHash).toBe(forwarded.history.lastEntryHash);
      expect(ticked.history.lastSnapshotHash).toBe(forwarded.history.lastSnapshotHash);
      expect(ticked.history.lastDeltaHash).toBe(forwarded.history.lastDeltaHash);
      expect(ticked.hashChain).toBe(forwarded.hashChain);
      expect(ticked.commandLog).toEqual(forwarded.commandLog);
    }
    const ticked16 = byTicks(16);
    expect(ticked16.playback.elapsedInYearMs).not.toBe(forwarded.playback.elapsedInYearMs);
    expect(ticked16.playback.mode).not.toBe(forwarded.playback.mode);
    expect(ticked16.stateHash).toBe(forwarded.stateHash);
  });
});

describe("P3-A.2 防禦分支：指令與建構期的固定錯誤碼", () => {
  it("keeps command validation on fixed codes", () => {
    const fresh = make("guards");
    expect(codeOf(() => applyLifeCommand(null as never, { type: "NEXT" }))).toMatch(/^E_P3A_/);
    expect(codeOf(() => applyLifeCommand(fresh, null as never))).toMatch(/^E_P3A_/);
    expect(codeOf(() => applyLifeCommand(fresh, { type: "UNKNOWN" } as never))).toBe("E_P3A_ARGUMENT");
    expect(codeOf(() => applyLifeCommand(fresh, { type: "TICK", deltaMs: -1 }))).toBe("E_P3A_DELTA");
    expect(codeOf(() => applyLifeCommand(fresh, { type: "FAST_FORWARD_STEP", maxYears: 0 }))).toBe("E_P3A_ARGUMENT");
    expect(codeOf(() => applyLifeCommand(fresh, { type: "FAST_FORWARD_STEP", maxYears: 21 }))).toBe("E_P3A_ARGUMENT");
    expect(codeOf(() => applyLifeCommand(fresh, { type: "SET_PLAYBACK", hidden: "yes" as never }))).toBe("E_P3A_ARGUMENT");
    expect(codeOf(() => applyLifeCommand(fresh, { type: "SET_PLAYBACK", paused: "no" as never }))).toBe("E_P3A_ARGUMENT");
    expect(codeOf(() => applyLifeCommand(fresh, { type: "SELECT_DECISION", optionId: 1 as never }))).toBe("E_P3A_ARGUMENT");
  });

  it("keeps decision selection on fixed codes", () => {
    const pending = atFirstDecision("guards2");
    expect(codeOf(() => applyLifeCommand(pending, { type: "SELECT_DECISION", optionId: "nope" }))).toBe("E_P3A_ARGUMENT");
    const selected = applyLifeCommand(pending, { type: "SELECT_DECISION", optionId: "steady" }).state;
    expect(codeOf(() => applyLifeCommand(selected, { type: "SELECT_DECISION", optionId: "bold" }))).toBe("E_P3A_PHASE");
  });

  it("keeps bootstrap validation on fixed codes", () => {
    expect(codeOf(() => createLifeState({ ...bootstrap(), rngState: [1, 2, 3] as never }))).toBe("E_P3A_STATE");
    expect(codeOf(() => createLifeState({ ...bootstrap(), birthYear: 1700 }))).toBe("E_P3A_STATE");
    expect(codeOf(() => createLifeState({ ...bootstrap(), paceLifeYearsX10: 0 }))).toBe("E_P3A_STATE");
    expect(codeOf(() => createLifeState({ ...bootstrap(), versions: { ...VERSIONS, saveFormatVersion: 4 } }))).toBe("E_P3A_VERSION");
  });

  it("keeps replay guards on fixed codes", () => {
    expect(codeOf(() => reconstructLifeState(null as never))).toMatch(/^E_P3A_/);
    expect(codeOf(() => reconstructLifeState({ bootstrap: bootstrap("guards3"), targetYears: -1, commandLog: [] }))).toBe("E_P3A_ARGUMENT");
    expect(codeOf(() => reconstructLifeState({ bootstrap: bootstrap("guards3"), targetYears: 100_001, commandLog: [] }))).toBe("E_P3A_ARGUMENT");
    expect(codeOf(() => reconstructLifeState({ bootstrap: bootstrap("guards3"), targetYears: 0, commandLog: null as never }))).toBe("E_P3A_ARGUMENT");
    expect(failCode(() => verifyLifeReplay({ bootstrap: bootstrap("guards3"), targetState: confirmedSix("guards3"), commandLog: [] }))).toBe("E_P3A_ARGUMENT");
    const dead = deathState("guards3");
    expect(
      failCode(() => reconstructBenchmarkLifeState({ bootstrap: benchmarkBootstrap(bootstrap("guards3"), 8), targetYears: dead.age + 1, commandLog: dead.commandLog }))
    ).toBe("E_P3A_ARGUMENT");
  });

  it("rejects a state whose playback year duration drifted from the pace contract", () => {
    const state = make("guards4");
    expect(failCode(() => assertLifeStateInvariants({ ...state, paceLifeYearsX10: 800 } as P3ALifeState))).toMatch(/^E_P3A_(PACE|HASH)$/);
    expect(
      failCode(() => assertLifeStateInvariants({ ...state, playback: { ...state.playback, previousMode: "fast_forward" as never } }))
    ).toMatch(/^E_P3A_(STATE|HASH)$/);
  });
});
