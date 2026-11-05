/**
 * P3-A.4 benchmark 隔離探針（只能被 `scripts/p3a-benchmark-isolation.mjs` 匯入）。
 *
 * 這裡刻意使用**內部**入口（`life/benchmark`）：公開 barrel 拿不到長壽命，
 * 這個檔案證明「benchmark 仍能完成 2k／5k／10k」，而公開入口同時拒絕 benchmark ruleset。
 */
import type { P3ABootstrap, P3ALifeState, VersionTuple } from "@life-sim/contracts";
import { deriveDomainState } from "../packages/engine/src/rng/seed";
import {
  benchmarkBootstrap,
  createBenchmarkLifeState,
  serializeBenchmarkLifeState,
  verifyBenchmarkLifeState
} from "../packages/engine/src/life/benchmark";
import { advanceLife, assertLifeLedgerFull, createLifeLedger, lifeLedgerDigest } from "../packages/application/src/ledger";

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

export function baseBootstrap(seed = "p3a4-isolation"): P3ABootstrap {
  return {
    versions: VERSIONS,
    origin: ORIGIN,
    birthYear: 2020,
    paceLifeYearsX10: 780,
    rngState: deriveDomainState(seed, "life")
  };
}

/** 用內部入口建立指定壽命的 state（公開入口會拒絕）。 */
export function makeBenchState(lifespanYears: number, seed = "p3a4-isolation"): P3ALifeState {
  return createBenchmarkLifeState(baseBootstrap(seed), lifespanYears);
}

export function benchBootstrap(lifespanYears: number, seed = "p3a4-isolation"): P3ABootstrap {
  return benchmarkBootstrap(baseBootstrap(seed), lifespanYears);
}

/** 內部序列化（公開序列化會拒絕 benchmark ruleset）。 */
export function serializeBench(state: P3ALifeState): string {
  return JSON.stringify(serializeBenchmarkLifeState(state));
}

/** 內部驗證（公開驗證會拒絕 benchmark ruleset）。 */
export function verifyBench(lifespanYears: number, state: P3ALifeState, seed = "p3a4-isolation"): boolean {
  const trace = verifyBenchmarkLifeState(benchBootstrap(lifespanYears, seed), state);
  return trace.state.stateHash === state.stateHash;
}

/** 跑滿指定年數（每年走正式 application API），回傳 ledger 摘要。 */
export function runBenchmark(years: number): {
  years: number;
  yearsRecorded: number;
  ledgerEntries: number;
  ledgerTailDeltaHash: string;
  stateDeltaHash: string;
  stateHashValid: boolean;
} {
  const ledger = createLifeLedger();
  let state = makeBenchState(years + 10);
  ({ state } = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }));
  let guard = 0;
  while (state.history.yearsRecorded < years && guard < years * 2 + 10) {
    guard += 1;
    ({ state } = advanceLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 1 }));
    if (state.phase === "pending_decision") {
      ({ state } = advanceLife(state, ledger, { type: "SELECT_DECISION", optionId: "steady" }));
      ({ state } = advanceLife(state, ledger, { type: "NEXT" }));
    }
  }
  assertLifeLedgerFull(ledger, state);
  const digest = lifeLedgerDigest(ledger);
  return {
    years,
    yearsRecorded: state.history.yearsRecorded,
    ledgerEntries: digest.entries,
    ledgerTailDeltaHash: digest.lastDeltaHash,
    stateDeltaHash: state.history.lastDeltaHash,
    stateHashValid: verifyBench(years + 10, state)
  };
}
