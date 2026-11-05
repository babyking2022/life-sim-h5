import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { P3ALifeState, VersionTuple } from "@life-sim/contracts";
import { deriveDomainState } from "../packages/engine/src/rng/seed";
import { createBenchmarkLifeState, serializeBenchmarkLifeState } from "../packages/engine/src/life/benchmark";
import { advanceLife, assertLifeLedgerFull, createLifeLedger, lifeLedgerDigest } from "../packages/application/src/ledger";

/**
 * P3-A.3 效能證據。
 *
 * 合法性：`P3ABootstrap` 不接受任意壽命，所以長壽命 fixture 只能透過**內部 benchmark factory**
 * （`packages/engine/src/life/benchmark.ts`，不在 `@life-sim/engine` barrel）建立；
 * 產生出來的 state 仍然完全合法（stateHash／history head／hashChain 一致）。
 *
 * 帳本：每年都走正式 application API `advanceLife`，由 engine 回傳的 delta 追加，
 * 不使用 `ledgerEntries += 1` 之類的假計數；收尾跑 `assertLifeLedgerFull` 重算三條鏈。
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

const EXPECTED_STATE_KEYS = [
  "schemaVersion",
  "lifeSpecVersion",
  "versions",
  "origin",
  "birthYear",
  "currentYear",
  "age",
  "phase",
  "errorCode",
  "lifespanYears",
  "paceLifeYearsX10",
  "stats",
  "assets",
  "flags",
  "rng",
  "pendingDecision",
  "history",
  "commandLog",
  "stateHash",
  "hashChain",
  "playback"
];

function stateHasLog(state: P3ALifeState): boolean {
  const keys = Object.keys(state);
  if (keys.some((key) => key === "log" || key === "snapshots" || key === "yearCards" || key === "cards")) return true;
  return keys.length !== EXPECTED_STATE_KEYS.length || keys.some((key) => !EXPECTED_STATE_KEYS.includes(key));
}

function run(years: number) {
  const ledger = createLifeLedger();
  let state = createBenchmarkLifeState(
    {
      versions: VERSIONS,
      origin: ORIGIN,
      birthYear: 2020,
      paceLifeYearsX10: 780,
      rngState: deriveDomainState("p3a-perf", "life")
    },
    years + 10
  );
  let commands = 0;
  ({ state } = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }));

  const started = performance.now();
  while (state.history.yearsRecorded < years) {
    ({ state } = advanceLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 1 }));
    if (state.phase === "pending_decision") {
      ({ state } = advanceLife(state, ledger, { type: "SELECT_DECISION", optionId: "steady" }));
      commands += 1;
      ({ state } = advanceLife(state, ledger, { type: "NEXT" }));
    }
  }
  const elapsed = performance.now() - started;

  // 逐筆重算 ledger 的三條 hash chain（O(n)，只在收尾做一次）。
  assertLifeLedgerFull(ledger, state);

  const serialized = JSON.stringify(serializeBenchmarkLifeState(state));
  const digest = lifeLedgerDigest(ledger);
  const arrayFields = Object.entries(state)
    .filter(([, value]) => Array.isArray(value))
    .map(([key]) => key);
  return {
    years,
    elapsedMs: Number(elapsed.toFixed(2)),
    perYearMs: Number((elapsed / years).toFixed(4)),
    ledgerEntries: digest.entries,
    ledgerSnapshots: digest.snapshots,
    ledgerCards: digest.cards,
    ledgerDeltaHashes: ledger.deltaHashes.length,
    ledgerTailEntryHash: digest.lastEntryHash,
    ledgerTailSnapshotHash: digest.lastSnapshotHash,
    ledgerTailDeltaHash: digest.lastDeltaHash,
    stateHistoryEntryHash: state.history.lastEntryHash,
    stateHistorySnapshotHash: state.history.lastSnapshotHash,
    stateHistoryDeltaHash: state.history.lastDeltaHash,
    stateYearsRecorded: state.history.yearsRecorded,
    stateBytes: serialized.length,
    arrayFields,
    stateKeys: Object.keys(state).length,
    stateHasLog: stateHasLog(state),
    commandLogEntries: state.commandLog.length,
    commands,
    historyYears: state.history.yearsRecorded,
    cardsTotal: state.history.cardsTotal,
    stateHash: state.stateHash
  };
}

const warmup = run(500);
const small = run(2000);
const mid = run(5000);
const large = run(10000);
const structural = {
  stateHasLog: large.stateHasLog,
  arrayFieldsEqual: JSON.stringify(small.arrayFields) === JSON.stringify(large.arrayFields),
  stateKeysBounded: large.stateKeys === small.stateKeys && large.stateKeys === EXPECTED_STATE_KEYS.length,
  stateBytesBounded: large.stateBytes - small.stateBytes <= 64,
  ledgerLengthMatchesState: [small, mid, large].every(
    (item) =>
      item.ledgerEntries === item.years &&
      item.ledgerSnapshots === item.years &&
      item.ledgerCards === item.years &&
      item.ledgerDeltaHashes === item.years &&
      item.cardsTotal === item.years
  ),
  ledgerTailBoundToState: [small, mid, large].every(
    (item) =>
      item.ledgerTailEntryHash === item.stateHistoryEntryHash &&
      item.ledgerTailSnapshotHash === item.stateHistorySnapshotHash &&
      item.ledgerTailDeltaHash === item.stateHistoryDeltaHash
  ),
  ledgerFullVerified: true,
  historyStaysOutOfState: large.stateBytes - small.stateBytes <= 64,
  perYearRatio: Number((large.perYearMs / small.perYearMs).toFixed(2))
};
const report = {
  generatedAt: "2026-10-27",
  contract: "P3-A.3",
  note:
    "synthetic skeleton; long lifespan comes from the internal benchmark factory (not part of the public bootstrap contract); every year is appended through advanceLife with a real LifeLedger",
  warmup,
  runs: [small, mid, large],
  structural,
  fullHistoryRescan: !(structural.arrayFieldsEqual && structural.stateBytesBounded && !structural.stateHasLog && structural.stateKeysBounded)
};
mkdirSync(join(process.cwd(), "reports"), { recursive: true });
writeFileSync(join(process.cwd(), "reports", "p3a-performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  `P3A-PERF-OK 2000y=${small.elapsedMs}ms 5000y=${mid.elapsedMs}ms 10000y=${large.elapsedMs}ms perYear=${large.perYearMs}ms ledger=${large.ledgerEntries} structural=${JSON.stringify(structural)}`
);
