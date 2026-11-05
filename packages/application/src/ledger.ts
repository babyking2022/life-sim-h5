import { P3A_EMPTY_HISTORY_HASH } from "@life-sim/contracts";
import type {
  P3ACommand,
  P3ALifeLogEntry,
  P3ALifeState,
  P3AReconstructInput,
  P3AVerifyInput,
  P3AYearCard,
  P3AYearDelta,
  P3AYearSnapshot
} from "@life-sim/contracts";
import {
  applyLifeCommand,
  computeYearDeltaHash,
  computeYearEntryHash,
  computeYearSnapshotHash,
  LifeError,
  reconstructLifeState,
  verifyLifeReplay,
  type P3AReplayTrace
} from "@life-sim/engine";

/**
 * Append-only 歷史帳本（application 層）。engine 的 state 不再持有逐年陣列，
 * 因此每年交易複製的歷史筆數為 0；歷史只在此處以 push 追加。
 *
 * - `entries`／`snapshots`／`cards`：逐年紀錄。
 * - `deltaHashes`：每年一筆，覆蓋該年 entry ＋ snapshot ＋ card 的每一個權威欄位，
 *   因此卡片（cardId／year／kind／title）也受防篡改保護；尾端必須等於 `state.history.lastDeltaHash`。
 *
 * state 只保存固定大小的摘要；ledger 與 state 不一致一律 `E_P3A_HISTORY`。
 */
export interface LifeLedger {
  readonly entries: P3ALifeLogEntry[];
  readonly snapshots: P3AYearSnapshot[];
  readonly cards: P3AYearCard[];
  readonly deltaHashes: string[];
}

export function createLifeLedger(): LifeLedger {
  return { entries: [], snapshots: [], cards: [], deltaHashes: [] };
}

function fail(code: string): never {
  throw new LifeError(code);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function guard<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof LifeError) throw error;
    throw new LifeError("E_P3A_HISTORY");
  }
}

function assertLedgerShape(ledger: unknown): asserts ledger is LifeLedger {
  if (!isRecord(ledger)) fail("E_P3A_HISTORY");
  const { entries, snapshots, cards, deltaHashes } = ledger as Record<string, unknown>;
  if (!Array.isArray(entries) || !Array.isArray(snapshots) || !Array.isArray(cards) || !Array.isArray(deltaHashes)) fail("E_P3A_HISTORY");
}

function assertStateShape(state: unknown): asserts state is P3ALifeState {
  if (!isRecord(state)) fail("E_P3A_HISTORY");
  const record = state as Record<string, unknown>;
  if (!isRecord(record.history)) fail("E_P3A_HISTORY");
  if (!Array.isArray(record.commandLog)) fail("E_P3A_HISTORY");
  if (!isRecord(record.playback)) fail("E_P3A_HISTORY");
}

/**
 * O(1) 綁定檢查：長度、尾端 hash（entry／snapshot／delta）、卡片數。
 * 供每一次交易前後使用；完整逐筆重算請用 `assertLifeLedgerFull`。
 */
export function assertLifeLedgerMatchesState(ledger: LifeLedger, state: P3ALifeState): void {
  return guard(() => {
    assertLedgerShape(ledger);
    assertStateShape(state);
    const { entries, snapshots, cards, deltaHashes } = ledger;
    if (entries.length !== snapshots.length || entries.length !== cards.length || entries.length !== deltaHashes.length) {
      fail("E_P3A_HISTORY");
    }
    if (entries.length !== state.history.yearsRecorded) fail("E_P3A_HISTORY");
    if (cards.length !== state.history.cardsTotal) fail("E_P3A_HISTORY");
    if (state.playback.cardsSeen > cards.length) fail("E_P3A_HISTORY");
    if (entries.length === 0) {
      if (state.history.lastEntryHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3A_HISTORY");
      if (state.history.lastSnapshotHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3A_HISTORY");
      if (state.history.lastDeltaHash !== P3A_EMPTY_HISTORY_HASH) fail("E_P3A_HISTORY");
      return;
    }
    const tailEntry = entries[entries.length - 1] as P3ALifeLogEntry;
    const tailSnapshot = snapshots[snapshots.length - 1] as P3AYearSnapshot;
    if (!isRecord(tailEntry) || !isRecord(tailSnapshot)) fail("E_P3A_HISTORY");
    if (tailEntry.entryHash !== state.history.lastEntryHash) fail("E_P3A_HISTORY");
    if (tailSnapshot.snapshotHash !== state.history.lastSnapshotHash) fail("E_P3A_HISTORY");
    if ((deltaHashes[deltaHashes.length - 1] as string) !== state.history.lastDeltaHash) fail("E_P3A_HISTORY");
  });
}

/**
 * O(n) 完整驗證：逐年重算 entry／snapshot／delta 三條 hash chain。
 * 任何舊紀錄（含卡片 cardId／year／kind／title）被改動、或只重算部分鏈，都會被抓到。
 */
export function assertLifeLedgerFull(ledger: LifeLedger, state: P3ALifeState): void {
  return guard(() => {
    assertLifeLedgerMatchesState(ledger, state);
    let entryHead: string = P3A_EMPTY_HISTORY_HASH;
    let snapshotHead: string = P3A_EMPTY_HISTORY_HASH;
    let deltaHead: string = P3A_EMPTY_HISTORY_HASH;
    for (let index = 0; index < ledger.entries.length; index += 1) {
      const entry = ledger.entries[index] as P3ALifeLogEntry;
      const snapshot = ledger.snapshots[index] as P3AYearSnapshot;
      const card = ledger.cards[index] as P3AYearCard;
      if (!isRecord(entry) || !isRecord(snapshot) || !isRecord(card)) fail("E_P3A_HISTORY");
      const expectedSeq = index + 1;
      const expectedAge = index + 1;
      const expectedYear = state.birthYear + expectedAge;
      if (entry.seq !== expectedSeq) fail("E_P3A_HISTORY");
      if (entry.age !== expectedAge || snapshot.age !== expectedAge) fail("E_P3A_HISTORY");
      if (entry.year !== expectedYear || snapshot.year !== expectedYear || card.year !== expectedYear) fail("E_P3A_HISTORY");
      entryHead = computeYearEntryHash(entryHead, {
        seq: entry.seq,
        year: entry.year,
        age: entry.age,
        entryId: entry.entryId,
        summary: entry.summary
      });
      if (entryHead !== entry.entryHash) fail("E_P3A_HISTORY");
      snapshotHead = computeYearSnapshotHash(snapshotHead, {
        year: snapshot.year,
        age: snapshot.age,
        stats: snapshot.stats,
        balanceMicroUsd: snapshot.balanceMicroUsd,
        phase: snapshot.phase
      });
      if (snapshotHead !== snapshot.snapshotHash) fail("E_P3A_HISTORY");
      deltaHead = computeYearDeltaHash(deltaHead, {
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
        card: { cardId: card.cardId, year: card.year, kind: card.kind, title: card.title }
      });
      if (deltaHead !== (ledger.deltaHashes[index] as string)) fail("E_P3A_HISTORY");
    }
    if (entryHead !== state.history.lastEntryHash) fail("E_P3A_HISTORY");
    if (snapshotHead !== state.history.lastSnapshotHash) fail("E_P3A_HISTORY");
    if (deltaHead !== state.history.lastDeltaHash) fail("E_P3A_HISTORY");
  });
}

export function lifeLedgerDigest(ledger: LifeLedger): {
  entries: number;
  snapshots: number;
  cards: number;
  lastEntryHash: string;
  lastSnapshotHash: string;
  lastDeltaHash: string;
} {
  return guard(() => {
    assertLedgerShape(ledger);
    const { entries, snapshots, cards, deltaHashes } = ledger;
    return {
      entries: entries.length,
      snapshots: snapshots.length,
      cards: cards.length,
      lastEntryHash: entries.length === 0 ? P3A_EMPTY_HISTORY_HASH : (entries[entries.length - 1] as P3ALifeLogEntry).entryHash,
      lastSnapshotHash:
        snapshots.length === 0 ? P3A_EMPTY_HISTORY_HASH : (snapshots[snapshots.length - 1] as P3AYearSnapshot).snapshotHash,
      lastDeltaHash: deltaHashes.length === 0 ? P3A_EMPTY_HISTORY_HASH : (deltaHashes[deltaHashes.length - 1] as string)
    };
  });
}

function appendDeltas(ledger: LifeLedger, deltas: readonly P3AYearDelta[]): void {
  for (const delta of deltas) {
    ledger.entries.push(delta.logEntry);
    ledger.snapshots.push(delta.snapshot);
    ledger.cards.push(delta.card);
    ledger.deltaHashes.push(delta.deltaHash);
  }
}

export interface LifeAdvanceResult {
  readonly state: P3ALifeState;
  readonly ledger: LifeLedger;
}

/**
 * 唯一建議入口：驗證 state 與 ledger 綁定 → 執行指令 → 一次追加 delta → 再次驗證。
 * 失敗時 ledger 不得留下部分修改。
 */
export function advanceLife(state: P3ALifeState, ledger: LifeLedger, command: P3ACommand): LifeAdvanceResult {
  return guard(() => {
    assertLifeLedgerMatchesState(ledger, state);
    const before = {
      entries: ledger.entries.length,
      snapshots: ledger.snapshots.length,
      cards: ledger.cards.length,
      deltaHashes: ledger.deltaHashes.length
    };
    const result = applyLifeCommand(state, command);
    try {
      appendDeltas(ledger, result.deltas);
      assertLifeLedgerMatchesState(ledger, result.state);
    } catch (error) {
      ledger.entries.length = before.entries;
      ledger.snapshots.length = before.snapshots;
      ledger.cards.length = before.cards;
      ledger.deltaHashes.length = before.deltaHashes;
      throw error instanceof LifeError ? error : new LifeError("E_P3A_HISTORY");
    }
    return { state: result.state, ledger };
  });
}

export interface LifeReplayResult {
  readonly state: P3ALifeState;
  readonly ledger: LifeLedger;
  readonly yearsReplayed: number;
  readonly commandsConsumed: number;
}

function ledgerFromTrace(trace: P3AReplayTrace): LifeLedger {
  const ledger = createLifeLedger();
  appendDeltas(ledger, trace.deltas);
  assertLifeLedgerFull(ledger, trace.state);
  return ledger;
}

/** 重建 ledger（不宣告已驗證）；正式驗證請用 `verifyLifeLedgerReplay`。 */
export function reconstructLifeLedger(input: P3AReconstructInput): LifeReplayResult {
  return guard(() => {
    const trace = reconstructLifeState(input);
    return {
      state: trace.state,
      ledger: ledgerFromTrace(trace),
      yearsReplayed: trace.yearsReplayed,
      commandsConsumed: trace.commandsConsumed
    };
  });
}

/** 驗證：targetState 必填，從 genesis 重播並逐欄比對後重建 ledger。 */
export function verifyLifeLedgerReplay(input: P3AVerifyInput): LifeReplayResult {
  return guard(() => {
    const trace = verifyLifeReplay(input);
    return {
      state: trace.state,
      ledger: ledgerFromTrace(trace),
      yearsReplayed: trace.yearsReplayed,
      commandsConsumed: trace.commandsConsumed
    };
  });
}
