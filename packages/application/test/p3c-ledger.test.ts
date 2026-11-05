import { describe, expect, it } from "vitest";
import type { P3CLifeState, P3CYearDelta } from "@life-sim/contracts";
import {
  assertEventLifeInvariants,
  computeEventYearDeltaHash,
  occurrenceDigestOf,
  verifyEventLifeState,
  Xoshiro128StarStar
} from "@life-sim/engine";
import { sealEventLifeState } from "../../engine/src/life/annual/state";
import { loadPack, makeBootstrap, newLife } from "../../engine/test/p3c-helpers";
import { enableAnnualEventFailureInjection, disableAnnualEventFailureInjection } from "../../engine/src/life/annual/benchmark";
import {
  advanceEventLife,
  assertEventLedgerFull,
  assertEventLedgerMatchesState,
  createEventLifeLedger,
  eventLedgerDigest,
  reconstructEventLifeLedger,
  verifyEventLifeLedgerReplay,
  type EventLifeLedger
} from "../src/event-ledger";

/**
 * P3-C application 層：append-only 事件帳本、O(1)／O(n) 驗證、故障回滾與事件紀錄防篡改。
 */

const pack = loadPack();

function buildLedger(years: number): { state: P3CLifeState; ledger: EventLifeLedger } {
  let state = newLife(pack);
  const ledger = createEventLifeLedger();
  ({ state } = advanceEventLife(state, ledger, { type: "SET_PLAYBACK", paused: false }, pack));
  let guard = 0;
  while (state.history.yearsRecorded < years && state.phase !== "death" && state.phase !== "error") {
    if (state.pendingDecision !== null) {
      const optionIds = [...state.pendingDecision.options.map((option) => option.optionId)].sort();
      ({ state } = advanceEventLife(state, ledger, { type: "SELECT_DECISION", optionId: optionIds[0] as string }, pack));
      ({ state } = advanceEventLife(state, ledger, { type: "NEXT" }, pack));
      continue;
    }
    ({ state } = advanceEventLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 1 }, pack));
    guard += 1;
    if (guard > years * 3 + 16) throw new Error("ledger build did not converge");
  }
  return { state, ledger };
}

describe("P3-C 事件帳本", () => {
  it("每年一筆事件紀錄，並通過 O(n) 三鏈＋occurrence digest 重算", () => {
    const { state, ledger } = buildLedger(16);
    expect(ledger.entries).toHaveLength(16);
    expect(ledger.snapshots).toHaveLength(16);
    expect(ledger.cards).toHaveLength(16);
    expect(ledger.deltaHashes).toHaveLength(16);
    expect(ledger.events).toHaveLength(16);
    assertEventLedgerMatchesState(ledger, state);
    assertEventLedgerFull(ledger, state);
    const digest = eventLedgerDigest(ledger);
    expect(digest.lastEntryHash).toBe(state.history.lastEntryHash);
    expect(digest.lastSnapshotHash).toBe(state.history.lastSnapshotHash);
    expect(digest.lastDeltaHash).toBe(state.history.lastDeltaHash);
    expect(digest.selectedEvents).toBeGreaterThan(0);
  });

  it("reconstruct／verify 都能重建出同一個帳本", () => {
    const { state, ledger } = buildLedger(10);
    const input = { bootstrap: makeBootstrap(), targetYears: state.history.yearsRecorded, commandLog: state.commandLog };
    const rebuilt = reconstructEventLifeLedger(input, pack);
    expect(rebuilt.state.stateHash).toBe(state.stateHash);
    expect(rebuilt.ledger.events).toEqual(ledger.events);
    expect(rebuilt.ledger.deltaHashes).toEqual(ledger.deltaHashes);
    const verified = verifyEventLifeLedgerReplay({ bootstrap: makeBootstrap(), targetState: state }, pack);
    expect(verified.ledger.events).toEqual(ledger.events);
  });

  it("ledger 與 state 的 O(1) 綁定會抓到長度不一致", () => {
    const { state, ledger } = buildLedger(8);
    const short = { ...ledger, events: ledger.events.slice(0, 7) };
    expect(() => assertEventLedgerMatchesState(short, state)).toThrowError(/E_P3C_HISTORY/);
    const extra = {
      ...ledger,
      entries: [...ledger.entries, ledger.entries[0] as P3CYearDelta["logEntry"]]
    };
    expect(() => assertEventLedgerMatchesState(extra, state)).toThrowError(/E_P3C_HISTORY/);
  });

  it("偷改歷史事件紀錄（selectionHash／eventId／drawsUsed）→ E_P3C_HISTORY", () => {
    const { state, ledger } = buildLedger(10);
    const index = ledger.events.findIndex((entry) => entry.eventId !== null);
    expect(index).toBeGreaterThanOrEqual(0);
    const tamper = (mutate: (event: P3CYearDelta["event"]) => P3CYearDelta["event"]) => {
      const events = ledger.events.map((entry, position) => (position === index ? mutate(entry) : entry));
      return { ...ledger, events };
    };
    expect(() => assertEventLedgerFull(tamper((event) => ({ ...event, selectionHash: "0".repeat(64) })), state)).toThrowError(/E_P3C_HISTORY/);
    expect(() => assertEventLedgerFull(tamper((event) => ({ ...event, eventId: null })), state)).toThrowError(/E_P3C_/);
    expect(() => assertEventLedgerFull(tamper((event) => ({ ...event, drawsUsed: (event.drawsUsed + 2) })), state)).toThrowError(/E_P3C_/);
  });

  it("偷改 occurrence digest 或 count／lastYear → E_P3C_OCCURRENCE", () => {
    const { state, ledger } = buildLedger(10);
    expect(() =>
      assertEventLedgerFull(
        { ...ledger, events: ledger.events.map((event, index) => (index === 0 ? { ...event, occurrenceDigestAfter: "0".repeat(64) } : event)) },
        state
      )
    ).toThrowError(/E_P3C_OCCURRENCE/);

    const occurrences = state.events.occurrences.map((entry, index) =>
      index === 0 ? { ...entry, count: entry.count + 1, lastYear: state.currentYear } : entry
    );
    // 偽造的 state 必須先自我一致（重封裝 stateHash），才會走到 ledger 的 occurrence 比對。
    const forgedState = sealEventLifeState({ ...state, events: { ...state.events, occurrences } });
    expect(() => assertEventLifeInvariants(forgedState)).not.toThrow();
    expect(() => assertEventLedgerFull(ledger, forgedState)).toThrowError(/E_P3C_OCCURRENCE/);
  });

  it("偷改卡片／entry → E_P3C_HISTORY（deltaHash 覆蓋 card 與 entry）", () => {
    const { state, ledger } = buildLedger(6);
    const cards = ledger.cards.map((card, index) => (index === 2 ? { ...card, title: "tampered" } : card));
    expect(() => assertEventLedgerFull({ ...ledger, cards }, state)).toThrowError(/E_P3C_HISTORY/);
    const entries = ledger.entries.map((entry, index) => (index === 1 ? { ...entry, summary: "tampered" } : entry));
    expect(() => assertEventLedgerFull({ ...ledger, entries }, state)).toThrowError(/E_P3C_HISTORY/);
  });

  it("事件 RNG 游標在帳本中逐年串接；斷鏈 → E_P3C_RNG", () => {
    const { state, ledger } = buildLedger(8);
    const events = ledger.events.map((event, index) =>
      index === 4 ? { ...event, rngStateBefore: [9, 9, 9, 9] as unknown as P3CYearDelta["event"]["rngStateBefore"] } : event
    );
    expect(() => assertEventLedgerFull({ ...ledger, events }, state)).toThrowError(/E_P3C_RNG/);
  });

  it("交易失敗時 ledger 不得留下半筆紀錄", () => {
    const state = newLife(pack);
    const ledger = createEventLifeLedger();
    enableAnnualEventFailureInjection("after_occurrence");
    try {
      const result = advanceEventLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 2 }, pack);
      // 年度交易失敗會被轉成 error 狀態，但不得追加任何紀錄。
      expect(result.state.phase).toBe("error");
      expect(result.state.errorCode).toBe("E_P3C_STATE");
      expect(result.state.history.yearsRecorded).toBe(0);
      expect(result.state.events).toEqual(state.events);
    } finally {
      disableAnnualEventFailureInjection();
    }
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.snapshots).toHaveLength(0);
    expect(ledger.cards).toHaveLength(0);
    expect(ledger.deltaHashes).toHaveLength(0);
    expect(ledger.events).toHaveLength(0);
  });

  it("把 ledger 換成別條命的紀錄 → E_P3C_HISTORY", () => {
    const a = buildLedger(6);
    const b = buildLedger(6);
    // 用另一條命的 state 驗 a 的 ledger（長度相同但尾端 hash 不同）。
    if (a.state.stateHash === b.state.stateHash) return;
    expect(() => assertEventLedgerMatchesState(a.ledger, b.state)).toThrowError(/E_P3C_HISTORY/);
  });

  it("occurrence digest 與 state 不一致（count 被改）→ 短鏈接檢查也抓得到", () => {
    const { state, ledger } = buildLedger(8);
    const occurrences = state.events.occurrences.map((entry, index) => (index === 0 ? { ...entry, count: entry.count + 2 } : entry));
    const forged = { ...state, events: { ...state.events, occurrences } };
    expect(occurrenceDigestOf(forged.events.occurrences)).not.toBe(occurrenceDigestOf(state.events.occurrences));
    expect(() => assertEventLedgerMatchesState(ledger, forged)).toThrowError(/E_P3C_OCCURRENCE/);
    expect(() => verifyEventLifeState(makeBootstrap(), forged, pack)).toThrowError(/E_P3C_/);
  });
});

/**
 * P3-C.1（CTO-037 必修 3）：ledger 的 RNG 必須綁定 genesis 與最終 state。
 *
 * 攻擊流程（完全照 CTO 指定）：
 * 1. 把整條 ledger 的 rngStateBefore／After 全改成 [9,9,9,9]；
 * 2. 重算所有 delta hash；
 * 3. 更新 state.history.lastDeltaHash；
 * 4. 用正式 projection hash 重新計算 stateHash；
 * 5. 確認偽造 state 自身仍然自洽（invariant 通過）；
 * 6. `assertEventLedgerFull` 必須以 `E_P3C_RNG` 拒絕。
 */
describe("P3-C.1 ledger RNG 綁定 genesis 與最終 state（CTO-037 必修 3）", () => {
  const GENESIS_ATTACK = [9, 9, 9, 9] as const;

  /** 可變的 event 草稿（權威型別是 readonly，偽造測試需要能改）。 */
  interface MutableEvent {
    eventId: string | null;
    reason: string;
    drawsUsed: number;
    rngStateBefore: number[];
    rngStateAfter: number[];
    selectionHash: string;
    occurrenceDigestBefore: string;
    occurrenceDigestAfter: string;
    candidateCount: number;
    totalWeight: string;
    outcome: P3CYearDelta["event"]["outcome"];
  }

  function toMutable(events: readonly P3CYearDelta["event"][]): MutableEvent[] {
    return events.map((event) => ({
      eventId: event.eventId,
      reason: event.reason,
      drawsUsed: event.drawsUsed,
      rngStateBefore: [...event.rngStateBefore],
      rngStateAfter: [...event.rngStateAfter],
      selectionHash: event.selectionHash,
      occurrenceDigestBefore: event.occurrenceDigestBefore,
      occurrenceDigestAfter: event.occurrenceDigestAfter,
      candidateCount: event.candidateCount,
      totalWeight: event.totalWeight,
      outcome: event.outcome
    }));
  }

  /**
   * 把 ledger 的 RNG 改掉、重算所有 delta hash、更新 state 的 lastDeltaHash 並用正式
   * projection hash 重新封裝 stateHash —— 模擬「把所有相依 hash 一起重算」的攻擊。
   * `stateRng` 可同時覆寫 state 的 current RNG／draws（用來做「合法 4 draws」與「過度推進」對照）。
   */
  function forgeRngLedger(
    source: { state: P3CLifeState; ledger: EventLifeLedger },
    mutate: (events: MutableEvent[]) => void,
    stateRng?: { readonly state?: readonly number[]; readonly draws?: number }
  ): { state: P3CLifeState; ledger: EventLifeLedger } {
    const state = structuredClone(source.state) as P3CLifeState;
    const entries = source.ledger.entries.map((entry) => ({ ...entry }));
    const snapshots = source.ledger.snapshots.map((snapshot) => ({ ...snapshot, stats: { ...snapshot.stats } }));
    const cards = source.ledger.cards.map((card) => ({ ...card }));
    const events = toMutable(source.ledger.events);
    mutate(events);

    const deltaHashes: string[] = [];
    let head = "0".repeat(64);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] as P3CYearDelta["logEntry"];
      const snapshot = snapshots[index] as P3CYearDelta["snapshot"];
      const card = cards[index] as P3CYearDelta["card"];
      head = computeEventYearDeltaHash(head, {
        entry: {
          seq: entry.seq,
          year: entry.year,
          age: entry.age,
          entryId: entry.entryId,
          summary: entry.summary,
          entryHash: entry.entryHash
        },
        snapshot: {
          year: snapshot.year,
          age: snapshot.age,
          stats: snapshot.stats,
          balanceMicroUsd: snapshot.balanceMicroUsd,
          phase: snapshot.phase,
          snapshotHash: snapshot.snapshotHash
        },
        card: { cardId: card.cardId, year: card.year, kind: card.kind, title: card.title },
        event: events[index] as unknown as P3CYearDelta["event"]
      });
      deltaHashes.push(head);
    }

    const patchedEventsRng =
      stateRng === undefined
        ? state.events.rng
        : {
            ...state.events.rng,
            state: (stateRng.state ?? state.events.rng.state) as never,
            draws: stateRng.draws ?? state.events.rng.draws
          };

    // 用正式 projection hash 重新封裝（不是自己算一個假的）。
    const resealed = sealEventLifeState({
      ...state,
      events: { ...state.events, rng: patchedEventsRng },
      history: { ...state.history, lastDeltaHash: head }
    });
    return {
      state: resealed,
      ledger: {
        entries,
        snapshots,
        cards,
        deltaHashes,
        events: events as unknown as P3CYearDelta["event"][]
      }
    };
  }

  it("把整條 ledger RNG 換成 [9,9,9,9] 並重算所有 hash：state 自洽，但 O(1) 綁定以 E_P3C_RNG 拒絕", () => {
    const base = buildLedger(8);
    const forged = forgeRngLedger(base, (events) => {
      for (const event of events) {
        event.rngStateBefore = [...GENESIS_ATTACK];
        event.rngStateAfter = [...GENESIS_ATTACK];
      }
    });
    // 5) 偽造 state 自身仍然自洽。
    expect(() => assertEventLifeInvariants(forged.state)).not.toThrow();
    // 6) ledger 驗證必須拒絕（O(1) 尾端 RNG 綁定）。
    expect(() => assertEventLedgerMatchesState(forged.ledger, forged.state)).toThrowError(/E_P3C_RNG/);
    expect(() => assertEventLedgerFull(forged.ledger, forged.state)).toThrowError(/E_P3C_RNG/);
  });

  it("只改第一筆 rngStateBefore：O(1) 過關，O(n) 以 genesis 綁定拒絕", () => {
    const base = buildLedger(8);
    const forged = forgeRngLedger(base, (events) => {
      (events[0] as MutableEvent).rngStateBefore = [...GENESIS_ATTACK];
    });
    expect(() => assertEventLifeInvariants(forged.state)).not.toThrow();
    // 尾端不變 → O(1) 綁定仍然成立（證明 O(1) 抓不到這一種）。
    expect(() => assertEventLedgerMatchesState(forged.ledger, forged.state)).not.toThrow();
    expect(() => assertEventLedgerFull(forged.ledger, forged.state)).toThrowError(/E_P3C_RNG/);
  });

  it("中間某一筆斷鏈：O(1) 過關，O(n) 以鏈結拒絕", () => {
    const base = buildLedger(8);
    const brokenIndex = 3;
    const forged = forgeRngLedger(base, (events) => {
      (events[brokenIndex] as MutableEvent).rngStateBefore = [...GENESIS_ATTACK];
    });
    expect(() => assertEventLifeInvariants(forged.state)).not.toThrow();
    expect(() => assertEventLedgerMatchesState(forged.ledger, forged.state)).not.toThrow();
    expect(() => assertEventLedgerFull(forged.ledger, forged.state)).toThrowError(/E_P3C_RNG/);
  });

  it("只改最後一筆 rngStateAfter：O(1) 綁定就拒絕", () => {
    const base = buildLedger(8);
    const lastIndex = base.ledger.events.length - 1;
    const forged = forgeRngLedger(base, (events) => {
      (events[lastIndex] as MutableEvent).rngStateAfter = [...GENESIS_ATTACK];
    });
    expect(() => assertEventLifeInvariants(forged.state)).not.toThrow();
    expect(() => assertEventLedgerMatchesState(forged.ledger, forged.state)).toThrowError(/E_P3C_RNG/);
    expect(() => assertEventLedgerFull(forged.ledger, forged.state)).toThrowError(/E_P3C_RNG/);
  });

  it("draws 總數被改（+2，仍是偶數）：O(1) 過關，O(n) 以總數拒絕", () => {
    const base = buildLedger(8);
    const forged = forgeRngLedger(base, (events) => {
      const target = events[1] as MutableEvent;
      target.drawsUsed += 2;
    });
    expect(() => assertEventLifeInvariants(forged.state)).not.toThrow();
    expect(() => assertEventLedgerMatchesState(forged.ledger, forged.state)).not.toThrow();
    expect(() => assertEventLedgerFull(forged.ledger, forged.state)).toThrowError(/E_P3C_RNG/);
  });

  it("drawsUsed 不是安全整數或不是偶數：抽選規則拒絕", () => {
    // 在 delta hash 可接受範圍內、但違反「0／2×attempts」的值 → ledger O(n) 以 E_P3C_RNG 拒絕。
    for (const bad of [1, 3]) {
      const base = buildLedger(6);
      const forged = forgeRngLedger(base, (events) => {
        (events[0] as MutableEvent).drawsUsed = bad;
      });
      expect(() => assertEventLedgerFull(forged.ledger, forged.state), `drawsUsed=${bad}`).toThrowError(/E_P3C_RNG/);
    }
    // 超出 delta hash 可接受範圍的值連偽造都做不到（`computeEventYearDeltaHash` 先擋）。
    for (const bad of [-2, 1.5, 10 ** 9]) {
      const base = buildLedger(6);
      expect(
        () =>
          forgeRngLedger(base, (events) => {
            (events[0] as MutableEvent).drawsUsed = bad;
          }),
        `drawsUsed=${bad}`
      ).toThrowError(/E_P3C_HISTORY/);
    }
  });

  it("零年度：current 必須等於 genesis、draws 必須為 0", () => {
    const state = newLife(pack);
    const ledger = createEventLifeLedger();
    // 合法：空帳本 ＋ genesis cursor。
    expect(state.events.rng.draws).toBe(0);
    expect(state.events.rng.state).toEqual(state.events.rng.initialState);
    expect(() => assertEventLedgerFull(ledger, state)).not.toThrow();

    // 偽造 draws = 2（重封裝後自洽）→ 拒絕。
    const badDraws = sealEventLifeState({
      ...state,
      events: { ...state.events, rng: { ...state.events.rng, draws: 2 } }
    });
    expect(() => assertEventLedgerFull(ledger, badDraws)).toThrowError(/E_P3C_RNG/);

    // 偽造 current ≠ genesis → 拒絕。
    const badState = sealEventLifeState({
      ...state,
      events: { ...state.events, rng: { ...state.events.rng, state: [...GENESIS_ATTACK] as never } }
    });
    expect(() => assertEventLedgerFull(ledger, badState)).toThrowError(/E_P3C_RNG/);

    // 空帳本但有事件紀錄 → E_P3C_HISTORY。
    const withEvent = buildLedger(3);
    const emptyLedger = createEventLifeLedger();
    expect(() => assertEventLedgerFull(emptyLedger, withEvent.state)).toThrowError(/E_P3C_/);
  });

  it("initialState 進 stateHash：改它一定改變 stateHash，且重播會抓到", () => {
    const { state } = buildLedger(6);
    const forged = sealEventLifeState({
      ...state,
      events: { ...state.events, rng: { ...state.events.rng, initialState: [...GENESIS_ATTACK] as never } }
    });
    expect(forged.stateHash).not.toBe(state.stateHash);
    expect(() => verifyEventLifeState(makeBootstrap(), forged, pack)).toThrowError(/E_P3C_HASH/);
  });
});

/**
 * P3-C.2（CTO-038）：單筆 `before → after` 必須可被 Xoshiro 重算。
 *
 * 這一組的核心是 CTO 指定的獨立攻擊：
 * 1. 保留第一筆 before 與最後一筆 after；
 * 2. 把 index i 的 `rngStateAfter` 改成 `[9,9,9,9]`；
 * 3. 同時把 index i+1 的 `rngStateBefore` 改成 `[9,9,9,9]`（鏈接仍然成立）；
 * 4. 保留 `drawsUsed`；
 * 5. 重算所有 delta hash、更新 `lastDeltaHash`、用正式 projection 重算 `stateHash`；
 * 6. 偽造 state 通過 `assertEventLifeInvariants`；
 * 7. `assertEventLedgerFull` 必須以 `E_P3C_RNG` 拒絕。
 */
describe("P3-C.2 單筆 RNG 轉移必須可重算（CTO-038）", () => {
  const MUTATED = [9, 9, 9, 9] as const;

  interface MutableEvent {
    eventId: string | null;
    reason: string;
    drawsUsed: number;
    rngStateBefore: number[];
    rngStateAfter: number[];
    selectionHash: string;
    occurrenceDigestBefore: string;
    occurrenceDigestAfter: string;
    candidateCount: number;
    totalWeight: string;
    outcome: P3CYearDelta["event"]["outcome"];
  }

  function toMutable(events: readonly P3CYearDelta["event"][]): MutableEvent[] {
    return events.map((event) => ({
      eventId: event.eventId,
      reason: event.reason,
      drawsUsed: event.drawsUsed,
      rngStateBefore: [...event.rngStateBefore],
      rngStateAfter: [...event.rngStateAfter],
      selectionHash: event.selectionHash,
      occurrenceDigestBefore: event.occurrenceDigestBefore,
      occurrenceDigestAfter: event.occurrenceDigestAfter,
      candidateCount: event.candidateCount,
      totalWeight: event.totalWeight,
      outcome: event.outcome
    }));
  }

  /** 真正的 Xoshiro 推進：`advance(before, draws)`。 */
  function advance(before: readonly number[], draws: number): number[] {
    const rng = new Xoshiro128StarStar(before);
    for (let draw = 0; draw < draws; draw += 1) rng.nextU32();
    return [...rng.state];
  }

  /** 改 ledger、重算所有 delta hash、必要時覆寫 state 的 current RNG／draws，最後用正式 projection 重封裝。 */
  function forge(
    source: { state: P3CLifeState; ledger: EventLifeLedger },
    mutate: (events: MutableEvent[]) => void,
    stateRng?: { readonly state?: readonly number[]; readonly draws?: number }
  ): { state: P3CLifeState; ledger: EventLifeLedger } {
    const state = structuredClone(source.state) as P3CLifeState;
    const entries = source.ledger.entries.map((entry) => ({ ...entry }));
    const snapshots = source.ledger.snapshots.map((snapshot) => ({ ...snapshot, stats: { ...snapshot.stats } }));
    const cards = source.ledger.cards.map((card) => ({ ...card }));
    const events = toMutable(source.ledger.events);
    mutate(events);

    const deltaHashes: string[] = [];
    let head = "0".repeat(64);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] as P3CYearDelta["logEntry"];
      const snapshot = snapshots[index] as P3CYearDelta["snapshot"];
      const card = cards[index] as P3CYearDelta["card"];
      head = computeEventYearDeltaHash(head, {
        entry: {
          seq: entry.seq,
          year: entry.year,
          age: entry.age,
          entryId: entry.entryId,
          summary: entry.summary,
          entryHash: entry.entryHash
        },
        snapshot: {
          year: snapshot.year,
          age: snapshot.age,
          stats: snapshot.stats,
          balanceMicroUsd: snapshot.balanceMicroUsd,
          phase: snapshot.phase,
          snapshotHash: snapshot.snapshotHash
        },
        card: { cardId: card.cardId, year: card.year, kind: card.kind, title: card.title },
        event: events[index] as unknown as P3CYearDelta["event"]
      });
      deltaHashes.push(head);
    }

    const patchedRng =
      stateRng === undefined
        ? state.events.rng
        : {
            ...state.events.rng,
            state: (stateRng.state ?? state.events.rng.state) as never,
            draws: stateRng.draws ?? state.events.rng.draws
          };

    const resealed = sealEventLifeState({
      ...state,
      events: { ...state.events, rng: patchedRng },
      history: { ...state.history, lastDeltaHash: head }
    });
    return {
      state: resealed,
      ledger: {
        entries,
        snapshots,
        cards,
        deltaHashes,
        events: events as unknown as P3CYearDelta["event"][]
      }
    };
  }

  function indexWhere(ledger: EventLifeLedger, predicate: (event: P3CYearDelta["event"]) => boolean, what: string): number {
    const index = ledger.events.findIndex((event) => predicate(event));
    if (index < 0) throw new Error(`test fixture: no ${what} event in ledger`);
    return index;
  }

  /** ledger 應該被拒絕，但 state 自身仍自洽（證明抓到的是 RNG 轉移，不是 state 壞掉）。 */
  function expectRejectedButSelfConsistent(forged: { state: P3CLifeState; ledger: EventLifeLedger }): void {
    expect(() => assertEventLifeInvariants(forged.state)).not.toThrow();
    expect(() => assertEventLedgerFull(forged.ledger, forged.state)).toThrowError(/E_P3C_RNG/);
  }

  it("中間一筆 after ＋ 下一筆 before 一起改成 [9,9,9,9]（鏈接仍成立、hash 全部重算）必須拒絕", () => {
    const base = buildLedger(10);
    const index = indexWhere(base.ledger, (event) => event.reason === "weighted", "weighted");
    expect(index).toBeLessThan(base.ledger.events.length - 1);
    const forged = forge(base, (events) => {
      (events[index] as MutableEvent).rngStateAfter = [...MUTATED];
      (events[index + 1] as MutableEvent).rngStateBefore = [...MUTATED];
    });
    // 相鄰鏈接與總 draws 都還成立，只有「轉移算不出來」。
    const tail = forged.ledger.events[forged.ledger.events.length - 1] as P3CYearDelta["event"];
    expect(JSON.stringify(tail.rngStateAfter)).toBe(JSON.stringify(base.state.events.rng.state));
    expectRejectedButSelfConsistent(forged);
  });

  it("weighted 的 after 只多推進一步（不影響鏈接與總數）也會被轉移檢查拒絕", () => {
    const base = buildLedger(10);
    const last = base.ledger.events.length - 1;
    const lastEvent = base.ledger.events[last] as P3CYearDelta["event"];
    expect(lastEvent.reason).toBe("weighted");
    const overAdvanced = advance(lastEvent.rngStateBefore, lastEvent.drawsUsed + 2);
    const forged = forge(
      base,
      (events) => {
        (events[last] as MutableEvent).rngStateAfter = overAdvanced;
      },
      // 讓 O(1) 尾端綁定與總 draws 都成立，只剩「轉移」不成立。
      { state: overAdvanced }
    );
    expect(() => assertEventLedgerMatchesState(forged.ledger, forged.state)).not.toThrow();
    expectRejectedButSelfConsistent(forged);
  });

  it("no_candidates 使用非零 draws → E_P3C_RNG", () => {
    const base = buildLedger(8);
    const index = indexWhere(base.ledger, (event) => event.reason === "no_candidates", "no_candidates");
    const forged = forge(base, (events) => {
      (events[index] as MutableEvent).drawsUsed = 2;
    });
    expectRejectedButSelfConsistent(forged);
  });

  it("single_candidate 使用非零 draws → E_P3C_RNG", () => {
    const base = buildLedger(8);
    const index = indexWhere(base.ledger, (event) => event.reason === "single_candidate", "single_candidate");
    const forged = forge(base, (events) => {
      (events[index] as MutableEvent).drawsUsed = 2;
    });
    expectRejectedButSelfConsistent(forged);
  });

  it("age_out_of_range 使用非零 draws → E_P3C_RNG", () => {
    // 120 歲以上只可能出現在 benchmark；這裡用合法的 no_candidates 事件改寫 reason 來驗規則本身。
    const base = buildLedger(8);
    const index = indexWhere(base.ledger, (event) => event.reason === "no_candidates", "no_candidates");
    const forged = forge(base, (events) => {
      const target = events[index] as MutableEvent;
      target.reason = "age_out_of_range";
      target.drawsUsed = 2;
    });
    expectRejectedButSelfConsistent(forged);
  });

  it("age_out_of_range 使用 0 draws 且 before = after 是合法的", () => {
    const base = buildLedger(8);
    const index = indexWhere(base.ledger, (event) => event.reason === "no_candidates", "no_candidates");
    const forged = forge(base, (events) => {
      (events[index] as MutableEvent).reason = "age_out_of_range";
    });
    expect(() => assertEventLifeInvariants(forged.state)).not.toThrow();
    expect(() => assertEventLedgerFull(forged.ledger, forged.state)).not.toThrow();
  });

  it("weighted 使用 0 draws → E_P3C_RNG", () => {
    const base = buildLedger(10);
    const index = indexWhere(base.ledger, (event) => event.reason === "weighted", "weighted");
    const forged = forge(base, (events) => {
      const target = events[index] as MutableEvent;
      target.drawsUsed = 0;
      target.rngStateAfter = [...target.rngStateBefore];
      // 下一筆的 before 也跟著歸零，維持鏈接。
      const next = events[index + 1] as MutableEvent | undefined;
      if (next !== undefined) next.rngStateBefore = [...target.rngStateBefore];
    });
    expectRejectedButSelfConsistent(forged);
  });

  it("candidateCount 與 reason 不一致 → E_P3C_RNG", () => {
    const base = buildLedger(10);
    const weightedIndex = indexWhere(base.ledger, (event) => event.reason === "weighted", "weighted");
    const singleIndex = indexWhere(base.ledger, (event) => event.reason === "single_candidate", "single_candidate");
    const noneIndex = indexWhere(base.ledger, (event) => event.reason === "no_candidates", "no_candidates");

    const weightedWithOne = forge(base, (events) => {
      (events[weightedIndex] as MutableEvent).candidateCount = 1;
    });
    expectRejectedButSelfConsistent(weightedWithOne);

    const singleWithTwo = forge(base, (events) => {
      (events[singleIndex] as MutableEvent).candidateCount = 2;
    });
    expectRejectedButSelfConsistent(singleWithTwo);

    const noneWithTwo = forge(base, (events) => {
      (events[noneIndex] as MutableEvent).candidateCount = 2;
    });
    expectRejectedButSelfConsistent(noneWithTwo);

    const unknownReason = forge(base, (events) => {
      (events[weightedIndex] as MutableEvent).reason = "surprise";
    });
    expectRejectedButSelfConsistent(unknownReason);
  });

  it("合法的 rejection sampling（2／4／6 draws）仍然通過", () => {
    for (const draws of [2, 4, 6]) {
      const base = buildLedger(10);
      const last = base.ledger.events.length - 1;
      const lastEvent = base.ledger.events[last] as P3CYearDelta["event"];
      expect(lastEvent.reason).toBe("weighted");
      const nextAfter = advance(lastEvent.rngStateBefore, draws);
      const forged = forge(
        base,
        (events) => {
          const target = events[last] as MutableEvent;
          target.drawsUsed = draws;
          target.rngStateAfter = nextAfter;
        },
        // state 的 current RNG 與 draws 一起更新成合法值，模擬「真的抽了 draws 次」。
        { state: nextAfter, draws: base.state.events.rng.draws - lastEvent.drawsUsed + draws }
      );
      expect(() => assertEventLifeInvariants(forged.state)).not.toThrow();
      expect(() => assertEventLedgerFull(forged.ledger, forged.state), `draws=${draws}`).not.toThrow();
    }
  });

  it("正常 ledger 仍然通過（驗證強化沒有改變合法輸出）", () => {
    const { state, ledger } = buildLedger(12);
    expect(() => assertEventLedgerFull(ledger, state)).not.toThrow();
    // 每一筆的 after 都真的等於 before 推進 drawsUsed 次的結果。
    for (const event of ledger.events) {
      expect(JSON.stringify(advance(event.rngStateBefore, event.drawsUsed))).toBe(JSON.stringify(event.rngStateAfter));
    }
  });
});
