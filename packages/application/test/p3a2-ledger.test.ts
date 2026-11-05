import { describe, expect, it } from "vitest";
import type { P3ALifeState, VersionTuple } from "@life-sim/contracts";
import { createLifeState, deriveDomainState, LifeError, resolveLifeYear, serializeLifeState } from "@life-sim/engine";
import {
  advanceLife,
  assertLifeLedgerFull,
  assertLifeLedgerMatchesState,
  createLifeLedger,
  lifeLedgerDigest,
  verifyLifeLedgerReplay,
  type LifeLedger
} from "../src/ledger";
import { lifeDigest } from "../src/p3a-browser";

/**
 * P3-A.2 反例（P3-A.3 版）：history 與 LifeLedger 綁定（退修單第 5 點、反例 9／15）。
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
const bootstrap = (seed = "p3a2-ledger") => ({
  versions: VERSIONS,
  origin: ORIGIN,
  birthYear: 2020,
  paceLifeYearsX10: 780,
  rngState: deriveDomainState(seed, "life")
});
const make = (seed = "p3a2-ledger"): P3ALifeState => createLifeState(bootstrap(seed));

const failCode = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof LifeError) return error.code;
    throw new Error(`expected LifeError, got ${(error as Error).name}: ${(error as Error).message}`);
  }
  throw new Error("expected an error but call succeeded");
};

const advanceYears = (years: number, seed = "p3a2-ledger"): { state: P3ALifeState; ledger: LifeLedger } => {
  const ledger = createLifeLedger();
  let state = make(seed);
  ({ state } = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }));
  let guard = 0;
  while (state.history.yearsRecorded < years && guard < 500) {
    guard += 1;
    ({ state } = advanceLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 1 }));
    if (state.phase === "pending_decision") {
      ({ state } = advanceLife(state, ledger, { type: "SELECT_DECISION", optionId: "steady" }));
      ({ state } = advanceLife(state, ledger, { type: "NEXT" }));
    }
  }
  return { state, ledger };
};

const copyLedger = (ledger: LifeLedger): LifeLedger => ({
  entries: [...ledger.entries],
  snapshots: [...ledger.snapshots],
  cards: [...ledger.cards],
  deltaHashes: [...ledger.deltaHashes]
});

describe("P3-A.2 反例 9：state 已有兩年但 ledger 為空", () => {
  it("returns E_P3A_HISTORY before any transaction", () => {
    let state = make("empty-ledger");
    state = resolveLifeYear(state).state;
    state = resolveLifeYear(state).state;
    expect(state.history.yearsRecorded).toBe(2);
    const ledger = createLifeLedger();
    expect(failCode(() => assertLifeLedgerMatchesState(ledger, state))).toBe("E_P3A_HISTORY");
    expect(failCode(() => advanceLife(state, ledger, { type: "NEXT" }))).toBe("E_P3A_HISTORY");
    expect(ledger.entries).toHaveLength(0);
  });

  it("returns E_P3A_HISTORY when ledger length, card count or tail hash disagree", () => {
    const { state, ledger } = advanceYears(3, "tail");
    expect(ledger.entries).toHaveLength(3);
    expect(ledger.cards).toHaveLength(3);
    expect(assertLifeLedgerFull(ledger, state)).toBeUndefined();

    const shortCards = copyLedger(ledger);
    shortCards.cards.pop();
    expect(failCode(() => assertLifeLedgerMatchesState(shortCards, state))).toBe("E_P3A_HISTORY");

    const staleTail = copyLedger(ledger);
    const last = staleTail.entries[staleTail.entries.length - 1];
    staleTail.entries[staleTail.entries.length - 1] = { ...last!, entryHash: "0".repeat(64) };
    expect(failCode(() => assertLifeLedgerMatchesState(staleTail, state))).toBe("E_P3A_HISTORY");
  });
});

describe("P3-A.2 反例 15：ledger 舊紀錄被改動必須被偵測", () => {
  it("detects a modified entry, snapshot or card through the full chain check", () => {
    const { state, ledger } = advanceYears(6, "tamper-ledger");
    expect(ledger.entries).toHaveLength(6);
    expect(assertLifeLedgerFull(ledger, state)).toBeUndefined();

    const tamperedSummary = copyLedger(ledger);
    tamperedSummary.entries[2] = { ...tamperedSummary.entries[2]!, summary: `${tamperedSummary.entries[2]!.summary}!` };
    expect(failCode(() => assertLifeLedgerFull(tamperedSummary, state))).toBe("E_P3A_HISTORY");

    const tamperedStats = copyLedger(ledger);
    tamperedStats.snapshots[1] = { ...tamperedStats.snapshots[1]!, stats: { ...tamperedStats.snapshots[1]!.stats, health: 1 } };
    expect(failCode(() => assertLifeLedgerFull(tamperedStats, state))).toBe("E_P3A_HISTORY");

    const tamperedCard = copyLedger(ledger);
    tamperedCard.cards[4] = { ...tamperedCard.cards[4]!, year: tamperedCard.cards[4]!.year + 1 };
    expect(failCode(() => assertLifeLedgerFull(tamperedCard, state))).toBe("E_P3A_HISTORY");

    // digest 也走同一條驗證，不會把竄改後的帳本當成正常。
    expect(failCode(() => lifeDigest(state, tamperedStats))).toBe("E_P3A_HISTORY");
  });

  it("keeps the ledger tails bound to the state heads", () => {
    const { state, ledger } = advanceYears(4, "tamper-root");
    const digest = lifeLedgerDigest(ledger);
    expect(digest.entries).toBe(4);
    expect(digest.lastEntryHash).toBe(state.history.lastEntryHash);
    expect(digest.lastSnapshotHash).toBe(state.history.lastSnapshotHash);
    expect(digest.lastDeltaHash).toBe(state.history.lastDeltaHash);
  });
});

describe("P3-A.2 ledger 綁定與原子性", () => {
  it("appends exactly one entry per year and keeps tail hashes in sync", () => {
    const ledger = createLifeLedger();
    let state = make("sync");
    ({ state } = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }));
    for (let year = 1; year <= 5; year += 1) {
      ({ state } = advanceLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 1 }));
      expect(ledger.entries).toHaveLength(year);
      expect(ledger.snapshots).toHaveLength(year);
      expect(ledger.cards).toHaveLength(year);
      expect(ledger.deltaHashes).toHaveLength(year);
      expect(state.history.yearsRecorded).toBe(year);
      expect(state.history.cardsTotal).toBe(year);
      expect(assertLifeLedgerMatchesState(ledger, state)).toBeUndefined();
    }
    expect(assertLifeLedgerFull(ledger, state)).toBeUndefined();
  });

  it("leaves the ledger untouched when a command fails", () => {
    const { state, ledger } = advanceYears(2, "atomic");
    const before = ledger.entries.length;
    expect(failCode(() => advanceLife(state, ledger, { type: "SELECT_DECISION", optionId: "steady" }))).toBe("E_P3A_PHASE");
    expect(ledger.entries).toHaveLength(before);
    expect(ledger.snapshots).toHaveLength(before);
    expect(ledger.cards).toHaveLength(before);
    expect(ledger.deltaHashes).toHaveLength(before);
    expect(assertLifeLedgerMatchesState(ledger, state)).toBeUndefined();
  });

  it("keeps cardsSeen within the real ledger card count", () => {
    const { state, ledger } = advanceYears(3, "cards-bound");
    const paused = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: true }).state;
    const advanced = advanceLife(paused, ledger, { type: "NEXT" }).state;
    expect(advanced.playback.cardsSeen).toBeLessThanOrEqual(ledger.cards.length);
    expect(ledger.cards).toHaveLength(3);
    expect(assertLifeLedgerMatchesState(ledger, advanced)).toBeUndefined();
  });
});

describe("P3-A.2 重播必須以 commandLog 為唯一權威", () => {
  it("rebuilds state and ledger from bootstrap + commandLog", () => {
    const { state, ledger } = advanceYears(6, "replay-ledger");
    expect(state.commandLog).toHaveLength(2);
    const replayed = verifyLifeLedgerReplay({ bootstrap: bootstrap("replay-ledger"), targetState: state });
    expect(replayed.state.stateHash).toBe(state.stateHash);
    expect(replayed.ledger.entries).toEqual(ledger.entries);
    expect(replayed.ledger.snapshots).toEqual(ledger.snapshots);
    expect(replayed.ledger.cards).toEqual(ledger.cards);
    expect(replayed.ledger.deltaHashes).toEqual(ledger.deltaHashes);
    expect(assertLifeLedgerFull(replayed.ledger, replayed.state)).toBeUndefined();
    expect(replayed.commandsConsumed).toBe(2);
    expect(serializeLifeState(replayed.state)).toEqual(serializeLifeState(state));
  });

  it("does not accept an independent decision list any more", () => {
    const { state } = advanceYears(6, "replay-ledger2");
    const input = { bootstrap: bootstrap("replay-ledger2"), targetState: state, decisions: [{ year: 2026, optionId: "steady" }] };
    const replayed = verifyLifeLedgerReplay(input as never);
    expect(replayed.state.stateHash).toBe(state.stateHash);
  });
});
