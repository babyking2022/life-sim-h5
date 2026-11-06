import type {
  CommandInput,
  PlaybackState,
  SaveEnvelope,
  SaveStats,
  SerializedGameState,
  VersionTuple
} from "@life-sim/contracts";
import {
  assertReplay,
  createInitialState,
  decodeMoney,
  encodeMoney,
  recordCommands,
  ReplayDivergenceError,
  seedHash,
  type EngineState
} from "@life-sim/engine";
import { decodeSave, encodeSave, SaveError, validateSaveEnvelope } from "@life-sim/save";

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface CreateSaveInput {
  version: VersionTuple;
  saveId: string;
  parentSaveId?: string;
  migratedFromVersions?: VersionTuple;
  revision: number;
  writerSessionId: string;
  helpPackVersion: string;
  seed: string;
  settings: SaveEnvelope["rulesetSettings"];
  playback: PlaybackState;
  commands: readonly CommandInput[];
  createdAt: string;
  updatedAt: string;
  stats: SaveStats;
}

export function serializeState(state: EngineState): SerializedGameState {
  const flags: Record<string, boolean | number | string> = {};
  for (const key of Object.keys(state.flags).sort()) flags[key] = state.flags[key] as boolean | number | string;
  return {
    schemaVersion: 1,
    year: state.year,
    stats: { ...state.stats },
    resource: encodeMoney(state.resourcePppMicro),
    flags,
    rngDraws: state.rngDraws
  };
}

export function deserializeState(state: SerializedGameState, seed: string, rng: [number, number, number, number], settings: SaveEnvelope["rulesetSettings"]): EngineState {
  return {
    schemaVersion: 1,
    seed,
    year: state.year,
    stats: { ...state.stats },
    resourcePppMicro: decodeMoney(state.resource),
    flags: { ...state.flags },
    rng,
    rngDraws: state.rngDraws,
    rulesetSettings: settings
  };
}

export function createSave(input: CreateSaveInput): SaveEnvelope {
  const base = createInitialState(input.seed, input.settings, input.version.rngSpecVersion);
  const recorded = recordCommands(input.version, base, input.commands);
  const envelope: SaveEnvelope = {
    magic: "LIFE1",
    saveFormatVersion: 3,
    saveId: input.saveId,
    revision: input.revision,
    writerSessionId: input.writerSessionId,
    engineVersion: input.version.engineVersion,
    rulesetVersion: input.version.rulesetVersion,
    rngSpecVersion: input.version.rngSpecVersion,
    dataVersion: input.version.dataVersion,
    contentVersion: input.version.contentVersion,
    helpPackVersion: input.helpPackVersion,
    seed: base.seed,
    seedHash: seedHash(base.seed),
    rulesetSettings: { ...base.rulesetSettings },
    playback: input.playback,
    state: serializeState(recorded.state),
    rng: [...recorded.state.rng],
    commandLog: recorded.records,
    stateHash: recorded.stateHash,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    stats: input.stats
  };
  if (input.parentSaveId !== undefined) envelope.parentSaveId = input.parentSaveId;
  if (input.migratedFromVersions !== undefined) envelope.migratedFromVersions = input.migratedFromVersions;
  validateSaveEnvelope(envelope);
  return envelope;
}

export function loadSave(input: string | Uint8Array): { state: EngineState; hashes: string[]; h0: string; envelope: SaveEnvelope } {
  const envelope = decodeSave(input);
  if (seedHash(envelope.seed) !== envelope.seedHash) {
    throw new SaveError("E_SAVE_SEED_MISMATCH", "seedHash does not match seed");
  }
  const base = createInitialState(envelope.seed, envelope.rulesetSettings, envelope.rngSpecVersion);
  const replayed = assertReplay(
    {
      engineVersion: envelope.engineVersion,
      rulesetVersion: envelope.rulesetVersion,
      rngSpecVersion: envelope.rngSpecVersion,
      dataVersion: envelope.dataVersion,
      contentVersion: envelope.contentVersion,
      saveFormatVersion: 3
    },
    base,
    envelope.commandLog
  );
  const current = serializeState(replayed.state);
  if (
    canonical(current) !== canonical(envelope.state) ||
    canonical([...replayed.state.rng]) !== canonical(envelope.rng) ||
    canonical(replayed.state.rulesetSettings) !== canonical(envelope.rulesetSettings)
  ) {
    throw new SaveError("E_SAVE_STATE_MISMATCH", "current state snapshot does not match replay");
  }
  if (replayed.finalHash !== envelope.stateHash) {
    const index = Math.max(0, envelope.commandLog.length - 1);
    const year = envelope.commandLog.length === 0 ? base.year : envelope.commandLog[index]!.effectiveYear;
    throw new ReplayDivergenceError(index, year, envelope.stateHash, replayed.finalHash);
  }
  return { state: replayed.state, hashes: replayed.hashes, h0: replayed.h0, envelope };
}

export { decodeSave, encodeSave };

export * from "./life";
export * from "./ledger";
export * from "./event-life";
export * from "./event-ledger";
export * from "./p3e-game";
export * from "./p3e-session";
export * from "./p3e-life-log";
export * from "./p3e-life-focus";
export * from "./p3e-birth-preview";
export * from "./p3e-browser-bootstrap";
export * from "./p3e-browser-autosave-session";
export * from "./p3e-browser-portable-save";
