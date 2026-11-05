import { describe, expect, it } from "vitest";
import type { P3ALifeState, VersionTuple } from "@life-sim/contracts";
import { createLifeState, deriveDomainState, LifeError, serializeLifeState } from "@life-sim/engine";
import {
  advanceLife,
  assertLifeLedgerFull,
  assertLifeLedgerMatchesState,
  createLifeLedger,
  lifeLedgerDigest,
  reconstructLifeLedger,
  verifyLifeLedgerReplay,
  type LifeLedger
} from "../src/ledger";

/**
 * P3-A.3 反例 5：卡片 cardId／year／kind／title 任一被修改都必須被拒絕，
 * 包含「只重算非相關鏈」的攻擊方式。
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
const bootstrap = (seed = "p3a3-card") => ({
  versions: VERSIONS,
  origin: ORIGIN,
  birthYear: 2020,
  paceLifeYearsX10: 780,
  rngState: deriveDomainState(seed, "life")
});
const make = (seed = "p3a3-card"): P3ALifeState => createLifeState(bootstrap(seed));

const failCode = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof LifeError) return error.code;
    throw new Error(`expected LifeError, got ${(error as Error).name}: ${(error as Error).message}`);
  }
  throw new Error("expected an error but call succeeded");
};

const advanceYears = (years: number, seed = "p3a3-card"): { state: P3ALifeState; ledger: LifeLedger } => {
  const ledger = createLifeLedger();
  let state = make(seed);
  ({ state } = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }));
  let guard = 0;
  while (state.history.yearsRecorded < years && guard < 200) {
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

describe("P3-A.3 反例 5：卡片欄位必須納入 ledger 防篡改", () => {
  const fields: readonly (readonly [string, (card: { cardId: string; year: number; kind: string; title: string }) => unknown])[] = [
    ["cardId", (card) => ({ ...card, cardId: `${card.cardId}-x` })],
    ["year", (card) => ({ ...card, year: card.year + 1 })],
    ["kind", (card) => ({ ...card, kind: card.kind === "summary" ? "milestone" : "summary" })],
    ["title", (card) => ({ ...card, title: `${card.title}!` })]
  ];

  it("rejects every single-field card mutation", () => {
    const { state, ledger } = advanceYears(6, "card-fields");
    expect(ledger.cards).toHaveLength(6);
    expect(assertLifeLedgerFull(ledger, state)).toBeUndefined();
    for (const [field, mutate] of fields) {
      const tampered = copyLedger(ledger);
      tampered.cards[2] = mutate(tampered.cards[2]!) as never;
      const code = failCode(() => assertLifeLedgerFull(tampered, state));
      expect(code, `card.${field} must be rejected`).toBe("E_P3A_HISTORY");
    }
  });

  it("rejects a card mutation even when the entry chain is recomputed consistently", () => {
    const { state, ledger } = advanceYears(6, "card-cross");
    const tampered = copyLedger(ledger);
    tampered.cards[3] = { ...tampered.cards[3]!, title: "偽造標題" };
    // 只重算 entry 鏈（卡片不是 entry 的一部分）→ delta 鏈仍然不符。
    expect(failCode(() => assertLifeLedgerFull(tampered, state))).toBe("E_P3A_HISTORY");
    // O(1) 綁定檢查只看尾端，但把尾端卡片改掉就會立刻被抓。
    const tailTampered = copyLedger(ledger);
    tailTampered.cards[tailTampered.cards.length - 1] = {
      ...tailTampered.cards[tailTampered.cards.length - 1]!,
      cardId: "tampered"
    };
    expect(failCode(() => assertLifeLedgerFull(tailTampered, state))).toBe("E_P3A_HISTORY");
    // 直接改 delta hash 也一樣。
    const deltaTampered = copyLedger(ledger);
    deltaTampered.deltaHashes[deltaTampered.deltaHashes.length - 1] = "f".repeat(64);
    expect(failCode(() => assertLifeLedgerMatchesState(deltaTampered, state))).toBe("E_P3A_HISTORY");
  });

  it("keeps the card rolling head bound to the state", () => {
    const { state, ledger } = advanceYears(5, "card-head");
    const digest = lifeLedgerDigest(ledger);
    expect(digest.lastDeltaHash).toBe(state.history.lastDeltaHash);
    expect(digest.cards).toBe(state.history.cardsTotal);
    expect(digest.lastDeltaHash).not.toBe("0".repeat(64));
  });
});

describe("P3-A.3 重建與驗證 API 分離", () => {
  it("reconstrues the ledger without a target state", () => {
    const { state, ledger } = advanceYears(6, "reconstruct");
    const rebuilt = reconstructLifeLedger({ bootstrap: bootstrap("reconstruct"), targetYears: 6, commandLog: state.commandLog });
    expect(rebuilt.state.stateHash).toBe(state.stateHash);
    expect(rebuilt.ledger.deltaHashes).toEqual(ledger.deltaHashes);
  });

  it("verifies a state from genesis and rejects a mismatching bootstrap", () => {
    const { state } = advanceYears(6, "verify");
    expect(verifyLifeLedgerReplay({ bootstrap: bootstrap("verify"), targetState: state }).state.stateHash).toBe(state.stateHash);
    expect(failCode(() => verifyLifeLedgerReplay({ bootstrap: bootstrap("other"), targetState: state }))).toMatch(/^E_P3A_/);
  });

  it("verifies the unconfirmed six-year-old state and its ledger", () => {
    const ledger = createLifeLedger();
    let state = make("unconfirmed-open");
    ({ state } = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }));
    while (state.history.yearsRecorded < 6) {
      ({ state } = advanceLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 1 }));
    }
    ({ state } = advanceLife(state, ledger, { type: "SELECT_DECISION", optionId: "bold" }));
    expect(state.pendingDecision?.selectedOptionId).toBe("bold");
    expect(assertLifeLedgerMatchesState(ledger, state)).toBeUndefined();
    const verified = verifyLifeLedgerReplay({ bootstrap: bootstrap("unconfirmed-open"), targetState: state });
    expect(verified.state.stateHash).toBe(state.stateHash);
    expect(verified.state.pendingDecision?.selectedOptionId).toBe("bold");
    expect(verified.commandsConsumed).toBe(1);
    expect(serializeLifeState(verified.state)).toEqual(serializeLifeState(state));
  });
});

describe("P3-A.3 ledger 公開 API 的畸形輸入矩陣", () => {
  const okCode = (action: () => unknown): string => {
    try {
      action();
      return "NO_ERROR";
    } catch (error) {
      return error instanceof LifeError ? error.code : `OTHER:${(error as Error).name}`;
    }
  };

  it("never leaks a native TypeError from ledger APIs", () => {
    const { state, ledger } = advanceYears(3, "matrix");
    const values: readonly unknown[] = [null, undefined, 0, "x", true, [], {}, { entries: [], snapshots: [], cards: [] }];
    for (const value of values) {
      const calls: readonly (readonly [string, () => unknown])[] = [
        ["assertLifeLedgerMatchesState(ledger)", () => assertLifeLedgerMatchesState(value as never, state)],
        ["assertLifeLedgerMatchesState(state)", () => assertLifeLedgerMatchesState(ledger, value as never)],
        ["assertLifeLedgerFull", () => assertLifeLedgerFull(value as never, state)],
        ["lifeLedgerDigest", () => lifeLedgerDigest(value as never)],
        ["advanceLife(state)", () => advanceLife(value as never, ledger, { type: "NEXT" })],
        ["advanceLife(ledger)", () => advanceLife(state, value as never, { type: "NEXT" })],
        ["advanceLife(command)", () => advanceLife(state, ledger, value as never)],
        ["reconstructLifeLedger", () => reconstructLifeLedger(value as never)],
        ["verifyLifeLedgerReplay", () => verifyLifeLedgerReplay(value as never)]
      ];
      for (const [label, call] of calls) {
        expect(okCode(call), `${label} with ${String(value)}`).toMatch(/^E_P3A_/);
      }
    }
  });

  it("handles an empty ledger and a zero-year reconstruction", () => {
    const empty = createLifeLedger();
    expect(lifeLedgerDigest(empty)).toEqual({
      entries: 0,
      snapshots: 0,
      cards: 0,
      lastEntryHash: "0".repeat(64),
      lastSnapshotHash: "0".repeat(64),
      lastDeltaHash: "0".repeat(64)
    });
    const rebuilt = reconstructLifeLedger({ bootstrap: bootstrap("empty"), targetYears: 0, commandLog: [] });
    expect(rebuilt.state.age).toBe(0);
    expect(rebuilt.ledger.entries).toHaveLength(0);
    expect(rebuilt.yearsReplayed).toBe(0);
    expect(rebuilt.commandsConsumed).toBe(0);
  });
});
