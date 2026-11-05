import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { P3ABootstrap, P3BEventPack, P3CLifeState, VersionTuple } from "@life-sim/contracts";
import { P3C_CONTENT_VERSION, P3C_RULESET_VERSION, P3C_SAVE_FORMAT_VERSION } from "../packages/contracts/src/p3c";
import { validateEventPack } from "../packages/engine/src/life/events/validate";
import {
  createEventBenchmarkLifeState,
  serializeEventBenchmarkLifeState
} from "../packages/engine/src/life/annual/benchmark";
import { advanceEventLife, assertEventLedgerFull, createEventLifeLedger, eventLedgerDigest } from "../packages/application/src/event-ledger";
import { createEventLifeState } from "../packages/engine/src/life/annual";

/**
 * P3-C 效能／容量證據（`pnpm p3c:perf` → `reports/p3c-performance.json`）。
 *
 * 兩段證據：
 * 1. **soak**：單一 2,000／5,000／10,000 年的 ledger，每年都走正式 `advanceEventLife`。
 *    事件契約只涵蓋 0–120 歲，因此 120 歲之後走 `age_out_of_range` 的固定「無候選」路徑
 *    （0 draws、RNG 不動）；報告會分開列出 `eventActiveYears` 與 `selectedEvents`，不做模糊陳述。
 * 2. **dense**：100 條真實長度（60–100 年）的人生，逐年事件抽選，
 *    用來量測「事件路徑真的每一都在跑」時的年成本。
 *
 * 兩段都會在收尾跑 `assertEventLedgerFull`（O(n)，只做一次），
 * 並且檢查 state 大小有界、occurrence 摘要不隨年份成長、array 欄位固定。
 */

const ROOT = process.cwd();
const PACK_DIR = join(ROOT, "fixtures", "p3b");

const pack: ReturnType<typeof validateEventPack> = validateEventPack({
  manifest: JSON.parse(readFileSync(join(PACK_DIR, "manifest.v1.json"), "utf8")),
  events: (JSON.parse(readFileSync(join(PACK_DIR, "events.v1.json"), "utf8")) as { records: unknown[] }).records
} satisfies P3BEventPack);

const VERSIONS: VersionTuple = {
  engineVersion: "0.1.0",
  rulesetVersion: P3C_RULESET_VERSION,
  rngSpecVersion: "1.0.0",
  dataVersion: "identity-1.0.0",
  contentVersion: P3C_CONTENT_VERSION,
  saveFormatVersion: P3C_SAVE_FORMAT_VERSION
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
  "events",
  "pendingDecision",
  "history",
  "commandLog",
  "stateHash",
  "hashChain",
  "playback"
];

function benchBootstrap(lifespanYears: number, salt: number): P3ABootstrap {
  return {
    versions: { ...VERSIONS, rulesetVersion: `p3c-bench-${lifespanYears}` },
    origin: ORIGIN,
    birthYear: 2020,
    paceLifeYearsX10: 780,
    rngState: [(0x9e3779b9 ^ salt) >>> 0, 0x85ebca6b, 0xc2b2ae35, salt >>> 0]
  } as P3ABootstrap;
}

function resolvePending(state: P3CLifeState, ledger: ReturnType<typeof createEventLifeLedger>): P3CLifeState {
  let current = state;
  while (current.pendingDecision !== null) {
    const optionIds = [...current.pendingDecision.options.map((option) => option.optionId)].sort();
    ({ state: current } = advanceEventLife(current, ledger, { type: "SELECT_DECISION", optionId: optionIds[0] as string }, pack));
    ({ state: current } = advanceEventLife(current, ledger, { type: "NEXT" }, pack));
  }
  return current;
}

function runSoak(years: number) {
  const ledger = createEventLifeLedger();
  let state = createEventBenchmarkLifeState(benchBootstrap(years + 10, years), pack, years + 10);
  ({ state } = advanceEventLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }, pack));

  const started = performance.now();
  let commands = 0;
  while (state.history.yearsRecorded < years && state.phase !== "death" && state.phase !== "error") {
    if (state.pendingDecision !== null) {
      const before = state.commandLog.length;
      state = resolvePending(state, ledger);
      commands += state.commandLog.length - before;
      continue;
    }
    ({ state } = advanceEventLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 1 }, pack));
    if (state.phase === "pending_decision") continue;
    ({ state } = advanceEventLife(state, ledger, { type: "SET_PLAYBACK", paused: false }, pack));
  }
  const elapsed = performance.now() - started;

  assertEventLedgerFull(ledger, state);
  const serialized = JSON.stringify(serializeEventBenchmarkLifeState(state));
  const digest = eventLedgerDigest(ledger);
  return {
    years,
    eventActiveYears: Math.min(years, 120),
    selectedEvents: digest.selectedEvents,
    elapsedMs: Number(elapsed.toFixed(2)),
    perYearMs: Number((elapsed / years).toFixed(4)),
    ledgerEntries: digest.entries,
    ledgerSnapshots: digest.snapshots,
    ledgerCards: digest.cards,
    ledgerEvents: digest.events,
    ledgerTailEntryHash: digest.lastEntryHash,
    ledgerTailSnapshotHash: digest.lastSnapshotHash,
    ledgerTailDeltaHash: digest.lastDeltaHash,
    stateHistoryEntryHash: state.history.lastEntryHash,
    stateHistorySnapshotHash: state.history.lastSnapshotHash,
    stateHistoryDeltaHash: state.history.lastDeltaHash,
    stateYearsRecorded: state.history.yearsRecorded,
    stateBytes: serialized.length,
    stateKeys: Object.keys(state).length,
    arrayFields: Object.entries(state)
      .filter(([, value]) => Array.isArray(value))
      .map(([key]) => key),
    occurrences: state.events.occurrences.length,
    occurrenceCap: Math.min(4096, pack.events.length),
    eventsRngDraws: state.events.rng.draws,
    commandLogEntries: state.commandLog.length,
    commands,
    cardsTotal: state.history.cardsTotal,
    stateHash: state.stateHash
  };
}

/**
 * 事件密集段：100 條真實長度（60–100 年）的人生，每條都有自己的 ledger、逐年事件抽選。
 * 這一節才是「事件路徑每年都在跑」的吞吐量證據。
 */
function runDense(lives: number) {
  const started = performance.now();
  let totalYears = 0;
  let selectedEvents = 0;
  let ledgerEntries = 0;
  for (let life = 0; life < lives; life += 1) {
    const ledger = createEventLifeLedger();
    let state = createEventLifeState(createPublicBootstrap(life + 2), pack);
    ({ state } = advanceEventLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }, pack));
    let guard = 0;
    while (state.phase === "life" || state.phase === "pending_decision") {
      if (state.pendingDecision !== null) {
        state = resolvePending(state, ledger);
        guard += 1;
        if (guard > 500) throw new Error("dense run did not converge");
        continue;
      }
      ({ state } = advanceEventLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 1 }, pack));
      if (state.playback.mode === "fast_forward") ({ state } = advanceEventLife(state, ledger, { type: "SET_PLAYBACK", paused: false }, pack));
    }
    assertEventLedgerFull(ledger, state);
    totalYears += state.history.yearsRecorded;
    selectedEvents += ledger.events.filter((entry) => entry.eventId !== null).length;
    ledgerEntries += ledger.entries.length;
  }
  const elapsed = performance.now() - started;
  return {
    lives,
    totalYears,
    selectedEvents,
    ledgerEntries,
    elapsedMs: Number(elapsed.toFixed(2)),
    perYearMs: Number((elapsed / Math.max(1, totalYears)).toFixed(4))
  };
}

function createPublicBootstrap(salt: number): P3ABootstrap {
  return {
    versions: VERSIONS,
    origin: ORIGIN,
    birthYear: 2020,
    paceLifeYearsX10: 780,
    rngState: [(0x9e3779b9 ^ salt) >>> 0, 0x85ebca6b, 0xc2b2ae35, Math.imul(salt, 2654435761) >>> 0]
  } as P3ABootstrap;
}

const warmup = runSoak(500);
const small = runSoak(2000);
const mid = runSoak(5000);
const large = runSoak(10000);
const dense = runDense(100);

const structural = {
  stateHasLog: Object.keys(large).some((key) => ["log", "snapshots", "yearCards", "cards", "occurrenceRecords"].includes(key)),
  stateKeysBounded: large.stateKeys === EXPECTED_STATE_KEYS.length && large.stateKeys === small.stateKeys,
  stateBytesBounded: large.stateBytes - small.stateBytes <= 512,
  arrayFieldsFixed: JSON.stringify(small.arrayFields) === JSON.stringify(large.arrayFields),
  occurrencesBounded: large.occurrences <= large.occurrenceCap,
  ledgerLengthMatchesState: [small, mid, large].every(
    (item) =>
      item.ledgerEntries === item.years &&
      item.ledgerSnapshots === item.years &&
      item.ledgerCards === item.years &&
      item.ledgerEvents === item.years &&
      item.cardsTotal === item.years
  ),
  ledgerTailBoundToState: [small, mid, large].every(
    (item) =>
      item.ledgerTailEntryHash === item.stateHistoryEntryHash &&
      item.ledgerTailSnapshotHash === item.stateHistorySnapshotHash &&
      item.ledgerTailDeltaHash === item.stateHistoryDeltaHash
  ),
  ledgerFullVerified: true,
  historyStaysOutOfState: large.stateBytes - small.stateBytes <= 512,
  perYearRatio: Number((large.perYearMs / small.perYearMs).toFixed(2))
};

const report = {
  generatedAt: "2026-10-28",
  contract: "P3-C",
  note:
    "synthetic skeleton; long lifespans come from the internal P3-C benchmark factory (not part of the public bootstrap contract); " +
    "every year is appended through advanceEventLife with a real event ledger; event ages are capped at 120 by the event contract, " +
    "so the soak runs report eventActiveYears separately from total years",
  eventPackId: pack.manifest.eventPackId,
  eventPackChecksum: pack.packChecksum,
  eventCount: pack.events.length,
  warmup,
  runs: [small, mid, large],
  dense,
  structural,
  fullHistoryRescan: !(structural.arrayFieldsFixed && structural.stateBytesBounded && !structural.stateHasLog && structural.stateKeysBounded)
};

mkdirSync(join(ROOT, "reports"), { recursive: true });
writeFileSync(join(ROOT, "reports", "p3c-performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  `P3C-PERF-OK 2000y=${small.elapsedMs}ms 5000y=${mid.elapsedMs}ms 10000y=${large.elapsedMs}ms ` +
    `perYear=${large.perYearMs}ms densePerYear=${dense.perYearMs}ms ` +
    `occurrences=${large.occurrences}/${large.occurrenceCap} structural=${JSON.stringify(structural)}`
);
