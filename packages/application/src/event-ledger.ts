import {
  P3A_EMPTY_HISTORY_HASH,
  type P3ACommand,
  type P3BEventOccurrence,
  type P3CLifeState,
  type P3CYearDelta
} from "@life-sim/contracts";
import {
  applyEventLifeCommand,
  assertEventLifeInvariants,
  computeEventYearDeltaHash,
  computeEventYearEntryHash,
  computeEventYearSnapshotHash,
  EventLifeError,
  occurrenceDigestOf,
  P3C_MAX_EVENT_DRAWS_PER_YEAR,
  reconstructEventLifeState,
  verifyEventLifeReplay,
  Xoshiro128StarStar,
  type P3CEventReplayInput,
  type P3CEventReplayTrace,
  type P3CEventVerifyInput
} from "@life-sim/engine";

/**
 * 事件版 append-only 歷史帳本（application 層）。
 *
 * 與 P3-A 的 `LifeLedger` 同一個隔離原則：**逐年歷史只在這裡**，state 只保存固定大小的摘要
 * （occurrence summary）。額外多一條 `events`：每年一筆事件稽核紀錄，
 * 因此「完整事件紀錄留 ledger、摘要進 state」的裁決在此落地。
 *
 * 三條 rolling hash（entry／snapshot／delta）都用 P3-C 的 domain，
 * 且 `deltaHash` 覆蓋 event 紀錄（selectionHash／RNG／draws／occurrence digest／effects 增量）。
 */
export interface EventLifeLedger {
  readonly entries: P3CYearDelta["logEntry"][];
  readonly snapshots: P3CYearDelta["snapshot"][];
  readonly cards: P3CYearDelta["card"][];
  readonly deltaHashes: string[];
  readonly events: P3CYearDelta["event"][];
}

export function createEventLifeLedger(): EventLifeLedger {
  return { entries: [], snapshots: [], cards: [], deltaHashes: [], events: [] };
}

function fail(code: "E_P3C_HISTORY" | "E_P3C_OCCURRENCE" | "E_P3C_RNG" | "E_P3C_STATE", path?: string): never {
  throw new EventLifeError(code, path);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function guard<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof EventLifeError) throw error;
    throw new EventLifeError("E_P3C_HISTORY");
  }
}

function assertLedgerShape(ledger: unknown): asserts ledger is EventLifeLedger {
  if (!isRecord(ledger)) fail("E_P3C_HISTORY");
  const { entries, snapshots, cards, deltaHashes, events } = ledger as Record<string, unknown>;
  if (!Array.isArray(entries) || !Array.isArray(snapshots) || !Array.isArray(cards) || !Array.isArray(deltaHashes) || !Array.isArray(events)) {
    fail("E_P3C_HISTORY");
  }
}

function assertStateShape(state: unknown): asserts state is P3CLifeState {
  if (!isRecord(state)) fail("E_P3C_HISTORY");
  const record = state as Record<string, unknown>;
  if (!isRecord(record.history)) fail("E_P3C_HISTORY");
  if (!Array.isArray(record.commandLog)) fail("E_P3C_HISTORY");
  if (!isRecord(record.playback)) fail("E_P3C_HISTORY");
  if (!isRecord(record.events)) fail("E_P3C_HISTORY");
}

/**
 * O(1) 綁定檢查：長度、尾端 hash（entry／snapshot／delta）、卡片數、occurrence 摘要的 digest。
 * 供每一次交易前後使用（**不**掃描歷史）；完整逐筆重算請用 `assertEventLedgerFull`。
 */
export function assertEventLedgerMatchesState(ledger: EventLifeLedger, state: P3CLifeState): void {
  return guard(() => {
    assertLedgerShape(ledger);
    assertStateShape(state);
    const { entries, snapshots, cards, deltaHashes, events } = ledger;
    if (entries.length !== snapshots.length || entries.length !== cards.length || entries.length !== deltaHashes.length) fail("E_P3C_HISTORY");
    if (entries.length !== events.length) fail("E_P3C_HISTORY");
    if (entries.length !== state.history.yearsRecorded) fail("E_P3C_HISTORY");
    if (cards.length !== state.history.cardsTotal) fail("E_P3C_HISTORY");
    if (state.playback.cardsSeen > cards.length) fail("E_P3C_HISTORY");
    if (entries.length === 0) {
      if (state.history.lastEntryHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3C_HISTORY");
      if (state.history.lastSnapshotHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3C_HISTORY");
      if (state.history.lastDeltaHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3C_HISTORY");
      if (state.events.occurrences.length !== 0) fail("E_P3C_OCCURRENCE");
      // P3-C.1：零年度時事件 RNG 必須還停在 genesis。
      assertEventRngAtGenesis(state);
      return;
    }
    const tailEntry = entries[entries.length - 1] as EventLifeLedger["entries"][number];
    const tailSnapshot = snapshots[snapshots.length - 1] as EventLifeLedger["snapshots"][number];
    if (!isRecord(tailEntry) || !isRecord(tailSnapshot)) fail("E_P3C_HISTORY");
    if (tailEntry.entryHash !== state.history.lastEntryHash) fail("E_P3C_HISTORY");
    if (tailSnapshot.snapshotHash !== state.history.lastSnapshotHash) fail("E_P3C_HISTORY");
    if ((deltaHashes[deltaHashes.length - 1] as string) !== state.history.lastDeltaHash) fail("E_P3C_HISTORY");
    // occurrence summary 必須等於「最後一年 event 紀錄」宣稱的 digest（O(1)）。
    const tailEvent = events[events.length - 1] as EventLifeLedger["events"][number];
    if (occurrenceDigestOf(state.events.occurrences) !== tailEvent.occurrenceDigestAfter) fail("E_P3C_OCCURRENCE");
    // P3-C.1 O(1)：ledger 尾端的 RNG after 必須綁回 state 的 current RNG。
    if (!sameWords(tailEvent.rngStateAfter, state.events.rng.state)) fail("E_P3C_RNG");
  });
}

/** 零年度：current RNG 必須等於 genesis，draws 必須為 0。 */
function assertEventRngAtGenesis(state: P3CLifeState): void {
  if (!sameWords(state.events.rng.initialState, state.events.rng.state)) fail("E_P3C_RNG");
  if (state.events.rng.draws !== 0) fail("E_P3C_RNG");
}

function isWordTuple(value: unknown): value is readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) return false;
  for (const word of value as readonly unknown[]) {
    if (typeof word !== "number" || !Number.isSafeInteger(word) || word < 0 || word > 0xffffffff) return false;
  }
  return true;
}

function sameWords(left: unknown, right: unknown): boolean {
  if (!isWordTuple(left) || !isWordTuple(right)) return false;
  for (let index = 0; index < 4; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** 單一年度 drawsUsed 的合法範圍與抽選規則（0／2×嘗試次數，上限 256）。 */
function assertDrawsUsed(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > P3C_MAX_EVENT_DRAWS_PER_YEAR) {
    fail("E_P3C_RNG");
  }
  if (value % 2 !== 0) fail("E_P3C_RNG");
}

/**
 * `reason` 與 `candidateCount`／`drawsUsed`／RNG 轉移的固定對應規則（P3-C.2）。
 *
 * | reason | candidateCount | drawsUsed | before → after |
 * |---|---|---|---|
 * | `no_candidates` | 0 | 0 | 必須相同 |
 * | `single_candidate` | 1 | 0 | 必須相同 |
 * | `age_out_of_range` | 0 | 0 | 必須相同 |
 * | `weighted` | ≥ 2 | ≥ 2、偶數、≤ 256 | 必須等於實際 Xoshiro 推進 `drawsUsed` 次的結果 |
 */
const EVENT_SELECTION_REASONS = ["no_candidates", "single_candidate", "weighted", "age_out_of_range"] as const;
type EventSelectionReason = (typeof EVENT_SELECTION_REASONS)[number];

function assertReasonRule(event: EventLifeLedger["events"][number]): void {
  const reason = event.reason as unknown;
  if (typeof reason !== "string" || !(EVENT_SELECTION_REASONS as readonly string[]).includes(reason)) fail("E_P3C_RNG");
  const typed = reason as EventSelectionReason;

  if (typeof event.candidateCount !== "number" || !Number.isSafeInteger(event.candidateCount) || event.candidateCount < 0) {
    fail("E_P3C_RNG");
  }
  const count = event.candidateCount;
  const draws = event.drawsUsed;
  assertDrawsUsed(draws);

  switch (typed) {
    case "no_candidates":
    case "age_out_of_range":
      if (count !== 0) fail("E_P3C_RNG");
      if (draws !== 0) fail("E_P3C_RNG");
      if (!sameWords(event.rngStateBefore, event.rngStateAfter)) fail("E_P3C_RNG");
      return;
    case "single_candidate":
      if (count !== 1) fail("E_P3C_RNG");
      if (draws !== 0) fail("E_P3C_RNG");
      if (!sameWords(event.rngStateBefore, event.rngStateAfter)) fail("E_P3C_RNG");
      return;
    case "weighted":
      if (count < 2) fail("E_P3C_RNG");
      if (draws < 2) fail("E_P3C_RNG");
      if (event.eventId === null) fail("E_P3C_RNG");
      return;
    default:
      fail("E_P3C_RNG");
  }
}

/**
 * 單筆 `before → after` 必須真的是 Xoshiro 執行 `drawsUsed` 次 `nextU32()` 後的結果（P3-C.2）。
 *
 * 這是唯一能抓到「中間一筆 after 與下一筆 before 一起改成同一個值」的檢查：
 * 相鄰鏈接、總 draws、三條 hash 全部可以重算成自洽，但 RNG 轉移本身推不出來。
 */
function assertRngTransition(event: EventLifeLedger["events"][number], index: number): void {
  if (!isWordTuple(event.rngStateBefore) || !isWordTuple(event.rngStateAfter)) fail("E_P3C_RNG");
  const rng = new Xoshiro128StarStar(event.rngStateBefore);
  for (let draw = 0; draw < event.drawsUsed; draw += 1) rng.nextU32();
  if (!sameWords(rng.state, event.rngStateAfter)) {
    fail("E_P3C_RNG", `events[${index}].rngStateAfter`);
  }
  // `weighted` 的結果必須真的消耗 RNG（0 draws 已被 reason 規則擋下，這裡再確保狀態確實改變）。
  if (event.reason === "weighted" && sameWords(event.rngStateBefore, event.rngStateAfter)) fail("E_P3C_RNG");
}

/**
 * O(n) 完整驗證：
 * 1. state 本身先通過完整 invariant（`assertEventLifeInvariants`）。
 * 2. 逐年重算 entry／snapshot／delta 三條 hash chain（任何欄位被改都會被抓）。
 * 3. 逐年重播 occurrence digest，最後必須等於 state 的 occurrence summary digest。
 * 4. **事件 RNG 綁定 genesis 與最終 state（P3-C.1）**：
 *    - 第一筆 `rngStateBefore === state.events.rng.initialState`；
 *    - 每筆 before 等於上一筆 after；
 *    - 最後一筆 after 等於 `state.events.rng.state`；
 *    - `Σ drawsUsed === state.events.rng.draws`；
 *    - 零年度時 current === initialState 且 draws === 0。
 * 5. **每一筆的 RNG 轉移必須可重算（P3-C.2）**：
 *    以 `new Xoshiro128StarStar(before)` 呼叫 `nextU32()` 恰好 `drawsUsed` 次，
 *    結果必須逐字等於 `after`；並驗 `reason`／`candidateCount`／`drawsUsed` 的固定對應。
 *    這一條是唯一能抓到「中間一筆 after 與下一筆 before 一起被改」的檢查
 *    （相鄰鏈接、總 draws 與三條 hash 都可以被一起重算成自洽）。
 */
export function assertEventLedgerFull(ledger: EventLifeLedger, state: P3CLifeState): void {
  return guard(() => {
    // 1) state 必須先自洽；否則後面的比對沒有意義。
    assertEventLifeInvariants(state);
    assertEventLedgerMatchesState(ledger, state);
    let entryHead: string = P3A_EMPTY_HISTORY_HASH;
    let snapshotHead: string = P3A_EMPTY_HISTORY_HASH;
    let deltaHead: string = P3A_EMPTY_HISTORY_HASH;
    let occurrences: readonly P3BEventOccurrence[] = [];
    let totalDraws = 0;
    let previousRngAfter: unknown = null;

    // 零年度：ledger 必須全空，RNG 必須停在 genesis。
    if (ledger.entries.length === 0) {
      assertEventRngAtGenesis(state);
      if (ledger.deltaHashes.length !== 0 || ledger.events.length !== 0) fail("E_P3C_HISTORY");
      return;
    }

    if (!sameWords((ledger.events[0] as EventLifeLedger["events"][number]).rngStateBefore, state.events.rng.initialState)) {
      fail("E_P3C_RNG");
    }

    for (let index = 0; index < ledger.entries.length; index += 1) {
      const entry = ledger.entries[index] as EventLifeLedger["entries"][number];
      const snapshot = ledger.snapshots[index] as EventLifeLedger["snapshots"][number];
      const card = ledger.cards[index] as EventLifeLedger["cards"][number];
      const event = ledger.events[index] as EventLifeLedger["events"][number];
      if (!isRecord(entry) || !isRecord(snapshot) || !isRecord(card) || !isRecord(event)) fail("E_P3C_HISTORY");
      const expectedSeq = index + 1;
      const expectedAge = index + 1;
      const expectedYear = state.birthYear + expectedAge;
      if (entry.seq !== expectedSeq) fail("E_P3C_HISTORY");
      if (entry.age !== expectedAge || snapshot.age !== expectedAge) fail("E_P3C_HISTORY");
      if (entry.year !== expectedYear || snapshot.year !== expectedYear || card.year !== expectedYear) fail("E_P3C_HISTORY");

      // occurrence digest 逐年串接（必須與當時的摘要一致）。
      if (event.occurrenceDigestBefore !== occurrenceDigestOf(occurrences)) fail("E_P3C_OCCURRENCE");
      if (event.eventId !== null) {
        const next: P3BEventOccurrence[] = [];
        let placed = false;
        for (const item of occurrences) {
          if (item.eventId === event.eventId) {
            next.push({ eventId: item.eventId, count: item.count + 1, lastYear: expectedYear });
            placed = true;
            continue;
          }
          if (!placed && item.eventId > event.eventId) {
            next.push({ eventId: event.eventId, count: 1, lastYear: expectedYear });
            placed = true;
          }
          next.push(item);
        }
        if (!placed) next.push({ eventId: event.eventId, count: 1, lastYear: expectedYear });
        occurrences = next;
      }
      if (event.occurrenceDigestAfter !== occurrenceDigestOf(occurrences)) fail("E_P3C_OCCURRENCE");

      // 事件 RNG 游標逐年串接（P3-C.1）：before 必須等於上一筆 after，draws 只能累加。
      if (!isWordTuple(event.rngStateBefore) || !isWordTuple(event.rngStateAfter)) fail("E_P3C_RNG");
      if (previousRngAfter !== null && !sameWords(event.rngStateBefore, previousRngAfter)) fail("E_P3C_RNG");
      // P3-C.2：reason／candidateCount／drawsUsed 的固定對應，以及真正的 RNG 轉移。
      assertReasonRule(event);
      assertRngTransition(event, index);
      previousRngAfter = event.rngStateAfter;
      totalDraws += event.drawsUsed;

      entryHead = computeEventYearEntryHash(entryHead, {
        seq: entry.seq,
        year: entry.year,
        age: entry.age,
        entryId: entry.entryId,
        summary: entry.summary
      });
      if (entryHead !== entry.entryHash) fail("E_P3C_HISTORY");
      snapshotHead = computeEventYearSnapshotHash(snapshotHead, {
        year: snapshot.year,
        age: snapshot.age,
        stats: snapshot.stats,
        balanceMicroUsd: snapshot.balanceMicroUsd,
        phase: snapshot.phase
      });
      if (snapshotHead !== snapshot.snapshotHash) fail("E_P3C_HISTORY");
      deltaHead = computeEventYearDeltaHash(deltaHead, {
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
        event
      });
      if (deltaHead !== (ledger.deltaHashes[index] as string)) fail("E_P3C_HISTORY");
    }

    if (entryHead !== state.history.lastEntryHash) fail("E_P3C_HISTORY");
    if (snapshotHead !== state.history.lastSnapshotHash) fail("E_P3C_HISTORY");
    if (deltaHead !== state.history.lastDeltaHash) fail("E_P3C_HISTORY");
    // 最後一筆 after 必須等於 state 的 current RNG，總 draws 必須等於 state 的累計 draws。
    if (!sameWords(previousRngAfter, state.events.rng.state)) fail("E_P3C_RNG");
    if (totalDraws !== state.events.rng.draws) fail("E_P3C_RNG");
    if (occurrenceDigestOf(state.events.occurrences) !== occurrenceDigestOf(occurrences)) fail("E_P3C_OCCURRENCE");
    if (JSON.stringify(state.events.occurrences) !== JSON.stringify(occurrences)) fail("E_P3C_OCCURRENCE");
  });
}

export function eventLedgerDigest(ledger: EventLifeLedger): {
  entries: number;
  snapshots: number;
  cards: number;
  events: number;
  lastEntryHash: string;
  lastSnapshotHash: string;
  lastDeltaHash: string;
  selectedEvents: number;
} {
  return guard(() => {
    assertLedgerShape(ledger);
    const { entries, snapshots, cards, deltaHashes, events } = ledger;
    return {
      entries: entries.length,
      snapshots: snapshots.length,
      cards: cards.length,
      events: events.length,
      lastEntryHash: entries.length === 0 ? P3A_EMPTY_HISTORY_HASH : (entries[entries.length - 1] as EventLifeLedger["entries"][number]).entryHash,
      lastSnapshotHash:
        snapshots.length === 0 ? P3A_EMPTY_HISTORY_HASH : (snapshots[snapshots.length - 1] as EventLifeLedger["snapshots"][number]).snapshotHash,
      lastDeltaHash: deltaHashes.length === 0 ? P3A_EMPTY_HISTORY_HASH : (deltaHashes[deltaHashes.length - 1] as string),
      selectedEvents: events.filter((entry) => entry.eventId !== null).length
    };
  });
}

function appendDeltas(ledger: EventLifeLedger, deltas: readonly P3CYearDelta[]): void {
  for (const delta of deltas) {
    ledger.entries.push(delta.logEntry);
    ledger.snapshots.push(delta.snapshot);
    ledger.cards.push(delta.card);
    ledger.deltaHashes.push(delta.deltaHash);
    ledger.events.push(delta.event);
  }
}

export interface EventLifeAdvanceResult {
  readonly state: P3CLifeState;
  readonly ledger: EventLifeLedger;
}

/**
 * 唯一建議入口：驗證 state／ledger 綁定與 pack → 執行指令 → 一次追加 delta → 再次驗證。
 * 失敗時 ledger 不得留下部分修改（長度全部回捲）。
 */
export function advanceEventLife(state: P3CLifeState, ledger: EventLifeLedger, command: P3ACommand, pack: unknown): EventLifeAdvanceResult {
  return guard(() => {
    assertEventLedgerMatchesState(ledger, state);
    const before = {
      entries: ledger.entries.length,
      snapshots: ledger.snapshots.length,
      cards: ledger.cards.length,
      deltaHashes: ledger.deltaHashes.length,
      events: ledger.events.length
    };
    const result = applyEventLifeCommand(state, command, pack);
    try {
      appendDeltas(ledger, result.deltas);
      assertEventLedgerMatchesState(ledger, result.state);
    } catch (error) {
      ledger.entries.length = before.entries;
      ledger.snapshots.length = before.snapshots;
      ledger.cards.length = before.cards;
      ledger.deltaHashes.length = before.deltaHashes;
      ledger.events.length = before.events;
      throw error instanceof EventLifeError ? error : new EventLifeError("E_P3C_HISTORY");
    }
    return { state: result.state, ledger };
  });
}

export interface EventLifeReplayResult {
  readonly state: P3CLifeState;
  readonly ledger: EventLifeLedger;
  readonly yearsReplayed: number;
  readonly commandsConsumed: number;
}

function ledgerFromTrace(trace: P3CEventReplayTrace): EventLifeLedger {
  const ledger = createEventLifeLedger();
  appendDeltas(ledger, trace.deltas);
  assertEventLedgerFull(ledger, trace.state);
  return ledger;
}

/** 重建 ledger（不宣告已驗證）；正式驗證請用 `verifyEventLifeLedgerReplay`。 */
export function reconstructEventLifeLedger(input: P3CEventReplayInput, pack: unknown): EventLifeReplayResult {
  return guard(() => {
    const trace = reconstructEventLifeState(input, pack);
    return { state: trace.state, ledger: ledgerFromTrace(trace), yearsReplayed: trace.yearsReplayed, commandsConsumed: trace.commandsConsumed };
  });
}

/** 驗證：targetState 必填，從 genesis 重播並逐欄比對後重建 ledger。 */
export function verifyEventLifeLedgerReplay(input: P3CEventVerifyInput, pack: unknown): EventLifeReplayResult {
  return guard(() => {
    const trace = verifyEventLifeReplay(input, pack);
    return { state: trace.state, ledger: ledgerFromTrace(trace), yearsReplayed: trace.yearsReplayed, commandsConsumed: trace.commandsConsumed };
  });
}
