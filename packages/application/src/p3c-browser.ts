import type { P3BEventPack, P3CLifeState, SexPolicy } from "@life-sim/contracts";
import { canonicalBytes, occurrenceDigestOf, sha256Hex, validateEventPack } from "@life-sim/engine";
import { buildPeerGroup, createBirthCertificate, validateDataPack, validateIdentityPack } from "@life-sim/birth";
import { createEventLifeFromCertificate } from "./event-life";
import {
  advanceEventLife,
  assertEventLedgerFull,
  createEventLifeLedger,
  eventLedgerDigest,
  type EventLifeLedger
} from "./event-ledger";

/**
 * P3-C 瀏覽器／golden 入口。
 *
 * 與 P3-A 的 `p3a-browser.ts` 同一模式：純 JSON 進、可逐位元比對的 digest 出。
 * 不讀系統時間、不用 Math.random；同一份 pack ＋ 同一份案例在任何引擎都得到相同結果。
 *
 * `optionPolicy` 是**測試/示範用的玩家策略**，不是引擎行為：
 * - `canonical-first`：選 `optionId` 升冪第一個選項（走正式 SELECT_DECISION ＋ CONFIRM 流程）。
 * 引擎本身永遠不會自動選項（見契約 §5）。
 */
export interface EventLifeCaseInput {
  readonly seed: string;
  readonly playerSexPolicy: string;
  /** 要前進幾年（以 FAST_FORWARD_STEP maxYears=1 逐年推進）。 */
  readonly years: number;
  /** 事件抉擇的示範策略；目前只支援 `canonical-first`。 */
  readonly optionPolicy?: string;
}

export interface EventLifeDigest {
  readonly certificateHash: string;
  readonly masterSeedHash: string;
  readonly birthYear: number;
  readonly age: number;
  readonly phase: string;
  readonly stateHash: string;
  readonly hashChain: string;
  readonly commandCount: number;
  readonly entries: number;
  readonly snapshots: number;
  readonly cards: number;
  readonly eventRecords: number;
  readonly selectedEvents: number;
  readonly eventsRngDraws: number;
  /** P3-C.1：genesis 事件 RNG（權威欄位，必須跨引擎一致）。 */
  readonly eventsRngInitialState: readonly number[];
  readonly eventsRngState: readonly number[];
  readonly occurrenceDigest: string;
  readonly occurrences: readonly string[];
  readonly lastEntryHash: string;
  readonly lastSnapshotHash: string;
  readonly lastDeltaHash: string;
  readonly cardsTotal: number;
  readonly cardsSeen: number;
  readonly playbackMode: string;
  /** 逐年選中的 eventId（未抽中記 `-`），用於跨引擎逐位元比對。 */
  readonly eventTrail: readonly string[];
  /** 逐年 selectionHash 的串接 digest（避免 golden 檔膨脹）。 */
  readonly selectionTrailDigest: string;
}

function trailDigest(values: readonly string[]): string {
  return sha256Hex(canonicalBytes({ selectionHashes: [...values] } as never));
}

export function eventLifeDigest(state: P3CLifeState, ledger: EventLifeLedger, selectionHashes: readonly string[]): EventLifeDigest {
  assertEventLedgerFull(ledger, state);
  const digest = eventLedgerDigest(ledger);
  return {
    certificateHash: state.origin.certificateHash,
    masterSeedHash: state.origin.masterSeedHash,
    birthYear: state.birthYear,
    age: state.age,
    phase: state.phase,
    stateHash: state.stateHash,
    hashChain: state.hashChain,
    commandCount: state.commandLog.length,
    entries: digest.entries,
    snapshots: digest.snapshots,
    cards: digest.cards,
    eventRecords: digest.events,
    selectedEvents: digest.selectedEvents,
    eventsRngDraws: state.events.rng.draws,
    eventsRngInitialState: [
      state.events.rng.initialState[0],
      state.events.rng.initialState[1],
      state.events.rng.initialState[2],
      state.events.rng.initialState[3]
    ],
    eventsRngState: [state.events.rng.state[0], state.events.rng.state[1], state.events.rng.state[2], state.events.rng.state[3]],
    occurrenceDigest: occurrenceDigestOf(state.events.occurrences),
    occurrences: state.events.occurrences.map((entry) => `${entry.eventId}:${entry.count}:${entry.lastYear}`),
    lastEntryHash: digest.lastEntryHash,
    lastSnapshotHash: digest.lastSnapshotHash,
    lastDeltaHash: digest.lastDeltaHash,
    cardsTotal: state.history.cardsTotal,
    cardsSeen: state.playback.cardsSeen,
    playbackMode: state.playback.mode,
    eventTrail: ledger.events.map((entry) => entry.eventId ?? "-"),
    selectionTrailDigest: trailDigest(selectionHashes)
  };
}

export function runEventLifeCases(
  baseRaw: unknown,
  identityRaw: unknown,
  packRaw: unknown,
  cases: readonly EventLifeCaseInput[]
): EventLifeDigest[] {
  const base = validateDataPack(baseRaw as never);
  const identityPack = validateIdentityPack(base, identityRaw as never);
  const pack = validateEventPack(packRaw as P3BEventPack);
  return cases.map((item) => {
    if (item.optionPolicy !== undefined && item.optionPolicy !== "canonical-first") {
      throw new Error(`unsupported optionPolicy: ${item.optionPolicy}`);
    }
    const group = buildPeerGroup(base, identityPack, { seed: item.seed, playerSexPolicy: item.playerSexPolicy as SexPolicy });
    const certificate = createBirthCertificate(base, identityPack, group, item.seed);
    let { state } = createEventLifeFromCertificate(base, identityPack, { certificate, masterSeed: item.seed, eventPack: pack });
    const ledger = createEventLifeLedger();

    ({ state } = advanceEventLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }, pack));
    let guardCounter = 0;
    while (state.history.yearsRecorded < item.years && state.phase !== "death" && state.phase !== "error") {
      if (state.pendingDecision !== null) {
        const optionIds = state.pendingDecision.options.map((option) => option.optionId).sort();
        const pick = optionIds[0] as string;
        ({ state } = advanceEventLife(state, ledger, { type: "SELECT_DECISION", optionId: pick }, pack));
        ({ state } = advanceEventLife(state, ledger, { type: "NEXT" }, pack));
        continue;
      }
      ({ state } = advanceEventLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 1 }, pack));
      guardCounter += 1;
      if (guardCounter > item.years * 3 + 16) throw new Error("event life case did not converge");
    }
    const selectionHashes = ledger.events.map((entry) => entry.selectionHash);
    return eventLifeDigest(state, ledger, selectionHashes);
  });
}
