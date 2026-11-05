import { describe, expect, it } from "vitest";
import type { P3ALifeState, VersionTuple } from "@life-sim/contracts";
import { applyLifeCommand, createLifeState, deriveDomainState, LifeError } from "@life-sim/engine";
import { advanceLife, assertLifeLedgerMatchesState, createLifeLedger, lifeLedgerDigest, type LifeLedger } from "../src/ledger";

/**
 * P3-A.6 反例（application 層）：hidden 狀態下 `advanceLife(…, FAST_FORWARD_STEP)` 必須
 * 在 engine 的年度迴圈之前以 `E_P3A_PHASE` 拒絕，且 ledger 不得有任何新增（第 10 項）。
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
const bootstrap = (seed = "p3a6-ledger") => ({
  versions: VERSIONS,
  origin: ORIGIN,
  birthYear: 2020,
  paceLifeYearsX10: 780,
  rngState: deriveDomainState(seed, "life")
});
const make = (seed = "p3a6-ledger"): P3ALifeState => createLifeState(bootstrap(seed));

const failCode = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof LifeError) return error.code;
    throw new Error(`expected LifeError, got ${(error as Error).name}: ${(error as Error).message}`);
  }
  throw new Error("expected an error but call succeeded");
};

const ledgerSizes = (ledger: LifeLedger) => ({
  entries: ledger.entries.length,
  snapshots: ledger.snapshots.length,
  cards: ledger.cards.length,
  deltaHashes: ledger.deltaHashes.length,
  digest: lifeLedgerDigest(ledger)
});

describe("P3-A.6 反例：hidden 快轉不得產生任何 delta 或 ledger 紀錄", () => {
  it("leaves the ledger untouched and throws E_P3A_PHASE", () => {
    const ledger = createLifeLedger();
    let state = make("p3a6-ledger");
    ({ state } = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }));
    ({ state } = advanceLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 2 }));
    const beforeState = state;
    const beforeLedger = ledgerSizes(ledger);
    expect(beforeLedger.entries).toBe(2);

    const hidden = advanceLife(beforeState, ledger, { type: "SET_PLAYBACK", hidden: true }).state;
    expect(hidden.playback.visibility).toBe("hidden");
    const hiddenSizes = ledgerSizes(ledger);

    expect(failCode(() => advanceLife(hidden, ledger, { type: "FAST_FORWARD_STEP", maxYears: 3 }))).toBe("E_P3A_PHASE");
    expect(ledgerSizes(ledger)).toEqual(hiddenSizes);
    expect(ledger.entries).toHaveLength(hiddenSizes.entries);
    expect(assertLifeLedgerMatchesState(ledger, hidden)).toBeUndefined();
    // 狀態本身也沒有變（advanceLife 不會回傳新狀態，呼叫端原本的 hidden 必須維持原樣）。
    expect(hidden.age).toBe(beforeState.age);
    expect(hidden.history.yearsRecorded).toBe(beforeState.history.yearsRecorded);
    expect(hidden.stateHash).toBe(applyLifeCommand(hidden, { type: "TICK", deltaMs: 0 }).state.stateHash);
  });

  it("keeps the ledger growing for visible + paused fast-forward", () => {
    const ledger = createLifeLedger();
    let state = make("p3a6-ledger-visible");
    ({ state } = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: true }));
    const before = ledgerSizes(ledger);
    const result = advanceLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 2 });
    expect(result.state.age).toBe(2);
    expect(ledger.entries).toHaveLength(before.entries + 2);
    expect(ledger.cards).toHaveLength(before.cards + 2);
    expect(ledger.deltaHashes).toHaveLength(before.deltaHashes + 2);
    expect(assertLifeLedgerMatchesState(ledger, result.state)).toBeUndefined();
  });
});
