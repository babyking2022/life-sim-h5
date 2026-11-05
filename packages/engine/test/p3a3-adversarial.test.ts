import { describe, expect, it } from "vitest";
import type { P3ACommandRecord, P3ALifeState, VersionTuple } from "@life-sim/contracts";
import { deriveDomainState } from "../src/rng/seed";
import {
  benchmarkBootstrap,
  createBenchmarkLifeState,
  disableYearFailureInjection,
  enableYearFailureInjection,
  forgeRechainedLifeState,
  forgeResealedLifeState,
  verifyBenchmarkLifeState
} from "../src/life/benchmark";
import {
  applyLifeCommand,
  assertLifeStateInvariants,
  createLifeState,
  deserializeLifeState,
  LifeError,
  reconstructLifeState,
  serializeLifeState,
  verifyLifeReplay,
  verifyLifeState,
  computeLifeStateHash,
  computeYearDeltaHash,
  computeYearEntryHash,
  computeYearSnapshotHash,
  assertRuleCommandLog,
  resolveLifeYear,
  resolveYear
} from "../src/life";

/**
 * P3-A.3 反例：對應 H5-CTO-030 退修單第三節 1–9。
 * 全部都是「修正前必須失敗」的獨立反例；不是為了讓現況通過而寫。
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
const bootstrap = (seed = "p3a3") => ({
  versions: VERSIONS,
  origin: ORIGIN,
  birthYear: 2020,
  paceLifeYearsX10: 780,
  rngState: deriveDomainState(seed, "life")
});
const make = (seed = "p3a3"): P3ALifeState => createLifeState(bootstrap(seed));
const play = (state: P3ALifeState) => applyLifeCommand(state, { type: "SET_PLAYBACK", paused: false }).state;
const ff = (state: P3ALifeState, years: number) => applyLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: years }).state;

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

const pendingSix = (seed = "p3a3"): P3ALifeState => ff(play(make(seed)), 20);
const selectedSix = (seed = "p3a3"): P3ALifeState => {
  const pending = pendingSix(seed);
  return applyLifeCommand(pending, { type: "SELECT_DECISION", optionId: "steady" }).state;
};
const confirmedSix = (seed = "p3a3"): P3ALifeState => applyLifeCommand(selectedSix(seed), { type: "NEXT" }).state;

describe("P3-A.3 反例 1：「已選未確認」狀態必須能 serialize→deserialize→重播", () => {
  it("round-trips the selected-but-unconfirmed state through serialization", () => {
    const selected = selectedSix("sel1");
    expect(selected.phase).toBe("pending_decision");
    expect(selected.pendingDecision?.selectedOptionId).toBe("steady");
    expect(selected.commandLog).toHaveLength(1);
    expect(selected.commandLog[0]?.commandType).toBe("SELECT_DECISION");
    expect(okCode(() => assertLifeStateInvariants(selected))).toBe("NO_ERROR");

    const serialized = serializeLifeState(selected);
    const restored = deserializeLifeState(serialized, bootstrap("sel1"));
    expect(restored.stateHash).toBe(selected.stateHash);
    expect(restored.pendingDecision).toEqual(selected.pendingDecision);
    expect(restored.commandLog).toEqual(selected.commandLog);
    expect(restored.hashChain).toBe(selected.hashChain);
    expect(restored.flags).toEqual(selected.flags);
  });

  it("reconstructs the selected-but-unconfirmed state from bootstrap + commandLog", () => {
    const selected = selectedSix("sel2");
    const rebuilt = reconstructLifeState({ bootstrap: bootstrap("sel2"), targetYears: 6, commandLog: selected.commandLog });
    expect(rebuilt.state.stateHash).toBe(selected.stateHash);
    expect(rebuilt.state.pendingDecision).toEqual(selected.pendingDecision);
    expect(rebuilt.state.commandLog).toEqual(selected.commandLog);
    expect(rebuilt.commandsConsumed).toBe(1);

    const verified = verifyLifeReplay({ bootstrap: bootstrap("sel2"), targetState: selected });
    expect(verified.state.stateHash).toBe(selected.stateHash);
    expect(verified.state.history.lastDeltaHash).toBe(selected.history.lastDeltaHash);
  });
});

describe("P3-A.3 反例 2：已確認狀態必須能 deserialize→重播", () => {
  it("round-trips the confirmed state and replays it exactly", () => {
    const confirmed = confirmedSix("conf1");
    expect(confirmed.pendingDecision).toBeNull();
    expect(confirmed.commandLog).toHaveLength(2);
    expect(confirmed.commandLog.map((record) => record.commandType)).toEqual(["SELECT_DECISION", "CONFIRM_DECISION"]);

    const restored = deserializeLifeState(serializeLifeState(confirmed), bootstrap("conf1"));
    expect(restored.stateHash).toBe(confirmed.stateHash);
    expect(restored.flags).toEqual(confirmed.flags);
    expect(restored.commandLog).toEqual(confirmed.commandLog);

    const rebuilt = reconstructLifeState({ bootstrap: bootstrap("conf1"), targetYears: 6, commandLog: confirmed.commandLog });
    expect(rebuilt.state.stateHash).toBe(confirmed.stateHash);
    expect(rebuilt.commandsConsumed).toBe(2);
    expect(rebuilt.state.flags).toEqual(confirmed.flags);
  });

  it("also replays a state after the child has moved into year seven", () => {
    const confirmed = confirmedSix("conf2");
    const later = ff(applyLifeCommand(confirmed, { type: "SET_PLAYBACK", paused: false }).state, 1);
    expect(later.age).toBe(7);
    const rebuilt = reconstructLifeState({ bootstrap: bootstrap("conf2"), targetYears: 7, commandLog: later.commandLog });
    expect(rebuilt.state.stateHash).toBe(later.stateHash);
    expect(okCode(() => verifyLifeReplay({ bootstrap: bootstrap("conf2"), targetState: later }))).toBe("NO_ERROR");
  });
});

describe("P3-A.3 反例 3：改欄位後重算整條 chain 仍必須被拒絕", () => {
  const forgedBeforeAfter = (): P3ALifeState => {
    const confirmed = confirmedSix("forge1");
    const records = confirmed.commandLog.map((record, index) => {
      if (index === 0) {
        return {
          ...record,
          stateHashBefore: "1".repeat(64),
          stateHashAfter: "2".repeat(64)
        };
      }
      return { ...record, stateHashBefore: "2".repeat(64) };
    });
    return forgeRechainedLifeState({ ...confirmed, commandLog: records });
  };

  it("rejects a structurally consistent, fully re-chained before/after forgery", () => {
    const forged = forgedBeforeAfter();
    // 狀態自洽：形狀、鏈、stateHash 全部合法。
    expect(okCode(() => assertLifeStateInvariants(forged))).toBe("NO_ERROR");
    expect(okCode(() => serializeLifeState(forged))).toBe("NO_ERROR");
    // 只有從 genesis 重播才能證明紀錄不是真的。
    expect(failCode(() => verifyLifeReplay({ bootstrap: bootstrap("forge1"), targetState: forged }))).toBe("E_P3A_HASH");
    expect(failCode(() => deserializeLifeState(serializeLifeState(forged), bootstrap("forge1")))).toBe("E_P3A_HASH");
  });

  it("rejects a forged initialStateHash with a re-chained log", () => {
    const confirmed = confirmedSix("forge2");
    const forged = forgeRechainedLifeState({
      ...confirmed,
      history: { ...confirmed.history, initialStateHash: "6".repeat(64) }
    });
    expect(okCode(() => assertLifeStateInvariants(forged))).toBe("NO_ERROR");
    expect(failCode(() => verifyLifeReplay({ bootstrap: bootstrap("forge2"), targetState: forged }))).toBe("E_P3A_HASH");
    expect(failCode(() => deserializeLifeState(serializeLifeState(forged), bootstrap("forge2")))).toBe("E_P3A_HASH");
  });

  it("rejects a forged payload/argsHash with a re-chained log", () => {
    const confirmed = confirmedSix("forge3");
    const record = confirmed.commandLog[0] as P3ACommandRecord;
    const forged = forgeRechainedLifeState({
      ...confirmed,
      commandLog: confirmed.commandLog.map((item, index) =>
        index === 0 ? { ...(record as P3ACommandRecord), payload: "bold", argsHash: item.argsHash } : item
      )
    });
    // argsHash 還是舊的 → 結構層就抓到。
    expect(failCode(() => assertLifeStateInvariants(forged))).toBe("E_P3A_HASH");
    expect(failCode(() => verifyLifeReplay({ bootstrap: bootstrap("forge3"), targetState: forged }))).toMatch(/^E_P3A_/);
  });

  it("rejects a forged year / rng cursor with a re-chained log", () => {
    const confirmed = confirmedSix("forge4");
    const forged = forgeRechainedLifeState({
      ...confirmed,
      commandLog: confirmed.commandLog.map((item, index) =>
        index === 0 ? { ...item, atYear: item.atYear + 1, effectiveYear: item.effectiveYear + 1 } : { ...item, atYear: item.atYear + 1, effectiveYear: item.effectiveYear + 1 }
      )
    });
    expect(failCode(() => verifyLifeReplay({ bootstrap: bootstrap("forge4"), targetState: forged }))).toMatch(/^E_P3A_/);
    expect(failCode(() => deserializeLifeState(serializeLifeState(forged), bootstrap("forge4")))).toMatch(/^E_P3A_/);
  });
});

describe("P3-A.3 反例 4：targetState 任一權威欄位被改都必須被拒絕", () => {
  const base = (): P3ALifeState => confirmedSix("target");

  const cases: readonly (readonly [string, (state: P3ALifeState) => P3ALifeState])[] = [
    ["stats", (state) => ({ ...state, stats: { ...state.stats, health: state.stats.health + 1 } })],
    ["assets", (state) => ({ ...state, assets: { ...state.assets, balanceMicroUsd: state.assets.balanceMicroUsd + 1n } })],
    ["flags", (state) => ({ ...state, flags: [...state.flags, "zzz"] })],
    ["rng", (state) => ({ ...state, rng: { ...state.rng, draws: state.rng.draws + 4 } })],
    ["history.lastEntryHash", (state) => ({ ...state, history: { ...state.history, lastEntryHash: "7".repeat(64) } })],
    ["history.lastDeltaHash", (state) => ({ ...state, history: { ...state.history, lastDeltaHash: "8".repeat(64) } })],
    ["commandLog", (state) => ({ ...state, commandLog: state.commandLog.slice(0, 1) })],
    ["hashChain", (state) => ({ ...state, hashChain: "9".repeat(64) })],
    ["phase", (state) => ({ ...state, phase: "death" as P3ALifeState["phase"] })]
  ];

  it("rejects every forged targetState field even after re-signing", () => {
    for (const [field, mutate] of cases) {
      const forged = forgeResealedLifeState(mutate(base()));
      const code = failCode(() => verifyLifeReplay({ bootstrap: bootstrap("target"), targetState: forged }));
      expect(code, `field ${field} must be rejected`).toMatch(/^E_P3A_/);
    }
  });

  it("rejects a targetState whose stats are null or whose commandLog is empty", () => {
    const state = base();
    const nullStats = { ...state, stats: null } as unknown as P3ALifeState;
    expect(failCode(() => verifyLifeReplay({ bootstrap: bootstrap("target"), targetState: nullStats }))).toBe("E_P3A_STATE");
    const emptyLog = forgeRechainedLifeState({ ...state, commandLog: [] });
    expect(failCode(() => verifyLifeReplay({ bootstrap: bootstrap("target"), targetState: emptyLog }))).toMatch(/^E_P3A_/);
    const badChain = { ...state, hashChain: "not-a-hash" } as P3ALifeState;
    expect(failCode(() => verifyLifeReplay({ bootstrap: bootstrap("target"), targetState: badChain }))).toBe("E_P3A_HASH");
  });
});

describe("P3-A.3 反例 6：所有公開 API 的畸形輸入只能回固定 LifeError", () => {
  const values: readonly unknown[] = [
    null,
    undefined,
    0,
    1,
    "",
    "state",
    true,
    [],
    [{}],
    {},
    { history: null },
    { commandLog: null },
    { history: {}, commandLog: [] }
  ];

  it("never leaks a native TypeError from any exported entry", () => {
    const state = make("matrix");
    const serialized = serializeLifeState(state);
    for (const value of values) {
      const calls: readonly (readonly [string, () => unknown])[] = [
        ["assertLifeStateShape", () => assertLifeStateInvariants(value as P3ALifeState)],
        ["assertRuleCommandLog", () => assertRuleCommandLog(value as P3ALifeState)],
        ["computeLifeStateHash", () => computeLifeStateHash(value as P3ALifeState)],
        ["serializeLifeState", () => serializeLifeState(value as P3ALifeState)],
        ["deserializeLifeState(serialized)", () => deserializeLifeState(serialized, value as never)],
        ["deserializeLifeState(bootstrap)", () => deserializeLifeState(value as never, bootstrap("matrix"))],
        ["createLifeState", () => createLifeState(value as never)],
        ["resolveLifeYear", () => resolveLifeYear(value as P3ALifeState)],
        ["resolveYear", () => resolveYear(value as P3ALifeState)],
        ["applyLifeCommand(state)", () => applyLifeCommand(state, value as never)],
        ["applyLifeCommand(state2)", () => applyLifeCommand(value as P3ALifeState, { type: "NEXT" })],
        ["reconstructLifeState", () => reconstructLifeState(value as never)],
        ["verifyLifeReplay", () => verifyLifeReplay(value as never)],
        ["verifyLifeState", () => verifyLifeState(value as never, value as never)],
        [
          "reconstructLifeState.targetYears",
          () => reconstructLifeState({ bootstrap: bootstrap("matrix"), targetYears: value as never, commandLog: [] })
        ],
        [
          "reconstructLifeState.commandLog",
          () => reconstructLifeState({ bootstrap: bootstrap("matrix"), targetYears: 0, commandLog: value as never })
        ]
      ];
      for (const [label, call] of calls) {
        if (label === "reconstructLifeState.targetYears" && (value === 0 || value === 1)) continue;
        if (label === "reconstructLifeState.commandLog" && Array.isArray(value)) continue;
        const code = okCode(call);
        expect(code, `${label} with ${String(value)} must be a fixed LifeError`).toMatch(/^E_P3A_/);
      }
    }
  });
});

describe("P3-A.3 反例 7：hidden 與 paused 不得同時指定", () => {
  it("rejects hidden=false together with paused=true and leaves the state untouched", () => {
    const playing = play(make("combo"));
    const hidden = applyLifeCommand(playing, { type: "SET_PLAYBACK", hidden: true }).state;
    expect(hidden.playback.mode).toBe("paused");
    const before = JSON.stringify(serializeLifeState(hidden));
    expect(failCode(() => applyLifeCommand(hidden, { type: "SET_PLAYBACK", hidden: false, paused: true }))).toBe("E_P3A_ARGUMENT");
    expect(JSON.stringify(serializeLifeState(hidden))).toBe(before);
    // 也拒絕 hidden=true + paused=false 這種相反組合。
    expect(failCode(() => applyLifeCommand(hidden, { type: "SET_PLAYBACK", hidden: true, paused: false }))).toBe("E_P3A_ARGUMENT");
  });

  it("keeps single-field transitions working", () => {
    const playing = play(make("combo2"));
    const hidden = applyLifeCommand(playing, { type: "SET_PLAYBACK", hidden: true }).state;
    const visible = applyLifeCommand(hidden, { type: "SET_PLAYBACK", hidden: false }).state;
    expect(visible.playback.visibility).toBe("visible");
    expect(visible.playback.mode).toBe("playing");
    const paused = applyLifeCommand(visible, { type: "SET_PLAYBACK", paused: true }).state;
    expect(paused.playback.mode).toBe("paused");
  });
});

describe("P3-A.3 反例 8：年度結算失敗路徑（動態注入）", () => {
  it("stops the TICK loop, keeps elapsed, sets errorCode and pauses", () => {
    enableYearFailureInjection(1);
    try {
      // pace 780 → yearDurationMs 46154；speed 16、delta 1000 → 每次 16000ms
      let state = applyLifeCommand(make("fail-tick"), { type: "SET_PLAYBACK", paused: false, speed: 16 }).state;
      state = applyLifeCommand(state, { type: "TICK", deltaMs: 1000 }).state;
      state = applyLifeCommand(state, { type: "TICK", deltaMs: 1000 }).state;
      expect(state.phase).toBe("life");
      state = applyLifeCommand(state, { type: "TICK", deltaMs: 1000 }).state;
      expect(state.phase).toBe("error");
      expect(state.errorCode).toBe("E_P3A_YEAR");
      expect(state.playback.mode).toBe("paused");
      expect(state.playback.elapsedInYearMs).toBe(48000 - 46154);
      expect(state.history.yearsRecorded).toBe(0);
      expect(okCode(() => assertLifeStateInvariants(state))).toBe("NO_ERROR");
      // 已進 error 的狀態不得再推進。
      const again = applyLifeCommand(state, { type: "TICK", deltaMs: 1000 }).state;
      expect(again.phase).toBe("error");
      expect(again.playback.elapsedInYearMs).toBe(state.playback.elapsedInYearMs);
    } finally {
      disableYearFailureInjection();
    }
  });

  it("stops a fast-forward run on the failing year", () => {
    enableYearFailureInjection(2);
    try {
      const state = applyLifeCommand(play(make("fail-ff")), { type: "FAST_FORWARD_STEP", maxYears: 5 }).state;
      expect(state.phase).toBe("error");
      expect(state.errorCode).toBe("E_P3A_YEAR");
      expect(state.playback.mode).toBe("paused");
      expect(state.history.yearsRecorded).toBe(1);
      expect(ff(state, 3).history.yearsRecorded).toBe(1);
    } finally {
      disableYearFailureInjection();
    }
  });

  it("does not inject anything once disabled", () => {
    disableYearFailureInjection();
    const state = ff(play(make("fail-off")), 3);
    expect(state.phase).toBe("life");
    expect(state.errorCode).toBeNull();
    expect(state.history.yearsRecorded).toBe(3);
  });
});

describe("P3-A.3 反例 9：正式 bootstrap 不接受任意壽命", () => {
  it("rejects a bootstrap carrying lifespanYears", () => {
    const withLifespan = { ...bootstrap("lifespan"), lifespanYears: 100 } as unknown as Parameters<typeof createLifeState>[0];
    expect(failCode(() => createLifeState(withLifespan))).toBe("E_P3A_ARGUMENT");
    expect(failCode(() => reconstructLifeState({ bootstrap: withLifespan, targetYears: 0, commandLog: [] }))).toBe("E_P3A_ARGUMENT");
    expect(failCode(() => verifyLifeState(withLifespan, make("lifespan")))).toBe("E_P3A_ARGUMENT");
  });

  it("rejects a malformed benchmark ruleset version", () => {
    for (const suffix of ["0", "abc", "100001", "-5", "01"]) {
      const bad = {
        ...bootstrap("bad-bench"),
        versions: { ...VERSIONS, rulesetVersion: `p3a-bench-${suffix}` }
      } as Parameters<typeof createLifeState>[0];
      expect(failCode(() => createLifeState(bad)), `suffix ${suffix}`).toBe("E_P3A_VERSION");
    }
  });

  it("only the internal benchmark factory can create a long-lived legal state", () => {
    const benchBootstrap = benchmarkBootstrap(bootstrap("bench"), 500);
    const state = createBenchmarkLifeState(bootstrap("bench"), 500);
    expect(state.lifespanYears).toBe(500);
    expect(state.versions.rulesetVersion).toBe("p3a-bench-500");
    expect(okCode(() => assertLifeStateInvariants(state))).toBe("NO_ERROR");
    // 公開入口拒絕 benchmark ruleset（建立／驗證／序列化都一樣）。
    expect(failCode(() => verifyLifeState(benchBootstrap, state))).toBe("E_P3A_VERSION");
    expect(failCode(() => serializeLifeState(state))).toBe("E_P3A_VERSION");
    // 內部入口仍可從 genesis 重播驗證。
    expect(okCode(() => verifyBenchmarkLifeState(benchBootstrap, state))).toBe("NO_ERROR");
    // 用正式 ruleset 的 bootstrap 驗證同一個 state 也會失敗。
    expect(failCode(() => verifyLifeState(bootstrap("bench"), state))).toBe("E_P3A_VERSION");
  });
});

describe("P3-A.3 年度 hash 工具的輸入驗證", () => {
  const entry = { seq: 1, year: 2021, age: 1, entryId: "year-2021", summary: "s" };
  const stats = { health: 50, happiness: 50, knowledge: 50, relationships: 50 };
  const zero = "0".repeat(64);

  it("rejects malformed entry/snapshot/delta payloads with fixed codes", () => {
    expect(failCode(() => computeYearEntryHash("nope", entry))).toBe("E_P3A_HISTORY");
    expect(failCode(() => computeYearEntryHash(zero, { ...entry, seq: 0 }))).toBe("E_P3A_HISTORY");
    expect(failCode(() => computeYearEntryHash(zero, { ...entry, entryId: "" }))).toBe("E_P3A_HISTORY");
    expect(failCode(() => computeYearSnapshotHash("nope", { year: 2021, age: 1, stats, balanceMicroUsd: "0", phase: "life" }))).toBe("E_P3A_HISTORY");
    expect(failCode(() => computeYearSnapshotHash(zero, { year: 2021, age: 1, stats, balanceMicroUsd: "0", phase: "nope" }))).toBe("E_P3A_HISTORY");
    expect(
      failCode(() => computeYearSnapshotHash(zero, { year: 2021, age: 1, stats: { ...stats, health: 101 }, balanceMicroUsd: "0", phase: "life" }))
    ).toBe("E_P3A_HISTORY");
    expect(
      failCode(() => computeYearDeltaHash("nope", { entry: { ...entry, entryHash: zero }, snapshot: { year: 2021, age: 1, stats, balanceMicroUsd: "0", phase: "life", snapshotHash: zero }, card: { cardId: "c", year: 2021, kind: "summary", title: "t" } }))
    ).toBe("E_P3A_HISTORY");
    const goodDelta = {
      entry: { ...entry, entryHash: zero },
      snapshot: { year: 2021, age: 1, stats, balanceMicroUsd: "0", phase: "life", snapshotHash: zero },
      card: { cardId: "c", year: 2021, kind: "summary", title: "t" }
    };
    expect(failCode(() => computeYearDeltaHash(zero, { ...goodDelta, card: { ...goodDelta.card, kind: "nope" } }))).toBe("E_P3A_HISTORY");
    expect(failCode(() => computeYearDeltaHash(zero, { ...goodDelta, card: { ...goodDelta.card, cardId: "" } }))).toBe("E_P3A_HISTORY");
    expect(failCode(() => computeYearDeltaHash(zero, { ...goodDelta, entry: { ...goodDelta.entry, seq: 0 } }))).toBe("E_P3A_HISTORY");
    expect(failCode(() => computeYearDeltaHash(zero, { ...goodDelta, snapshot: { ...goodDelta.snapshot, balanceMicroUsd: "01" } }))).toBe("E_P3A_MONEY");
    expect(okCode(() => computeYearDeltaHash(zero, goodDelta))).toBe("NO_ERROR");
  });

  it("accepts an explicit commandLog equal to the target state's log", () => {
    const confirmed = confirmedSix("explicit-log");
    expect(okCode(() => verifyLifeReplay({ bootstrap: bootstrap("explicit-log"), targetState: confirmed, commandLog: [...confirmed.commandLog] }))).toBe(
      "NO_ERROR"
    );
  });
});
