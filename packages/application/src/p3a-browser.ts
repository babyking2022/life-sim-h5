import type { P3ALifeState, SexPolicy } from "@life-sim/contracts";
import { buildPeerGroup, createBirthCertificate, validateDataPack, validateIdentityPack } from "@life-sim/birth";
import { serializeLifeState } from "@life-sim/engine";
import { createLifeFromCertificate } from "./life";
import { advanceLife, assertLifeLedgerFull, createLifeLedger, lifeLedgerDigest, type LifeLedger } from "./ledger";

export interface LifeCaseInput {
  readonly seed: string;
  readonly playerSexPolicy: string;
}

export interface LifeDigest {
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
  readonly rngDraws: number;
  readonly lastEntryHash: string;
  readonly lastSnapshotHash: string;
  readonly lastDeltaHash: string;
  readonly cardsTotal: number;
  readonly cardsSeen: number;
  readonly playbackMode: string;
}

export function lifeDigest(state: P3ALifeState, ledger: LifeLedger): LifeDigest {
  assertLifeLedgerFull(ledger, state);
  const ledgerDigest = lifeLedgerDigest(ledger);
  return {
    certificateHash: state.origin.certificateHash,
    masterSeedHash: state.origin.masterSeedHash,
    birthYear: state.birthYear,
    age: state.age,
    phase: state.phase,
    stateHash: state.stateHash,
    hashChain: state.hashChain,
    commandCount: state.commandLog.length,
    entries: ledgerDigest.entries,
    snapshots: ledgerDigest.snapshots,
    cards: ledgerDigest.cards,
    rngDraws: state.rng.draws,
    lastEntryHash: ledgerDigest.lastEntryHash,
    lastSnapshotHash: ledgerDigest.lastSnapshotHash,
    lastDeltaHash: ledgerDigest.lastDeltaHash,
    cardsTotal: state.history.cardsTotal,
    cardsSeen: state.playback.cardsSeen,
    playbackMode: state.playback.mode
  };
}

export function runLifeCases(baseRaw: unknown, identityRaw: unknown, cases: readonly LifeCaseInput[]): LifeDigest[] {
  const base = validateDataPack(baseRaw as never);
  const identityPack = validateIdentityPack(base, identityRaw as never);
  return cases.map((item) => {
    const group = buildPeerGroup(base, identityPack, { seed: item.seed, playerSexPolicy: item.playerSexPolicy as SexPolicy });
    const certificate = createBirthCertificate(base, identityPack, group, item.seed);
    let { state } = createLifeFromCertificate(base, identityPack, { certificate, masterSeed: item.seed });
    const ledger = createLifeLedger();
    ({ state } = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }));
    ({ state } = advanceLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 5 }));
    serializeLifeState(state);
    return lifeDigest(state, ledger);
  });
}
