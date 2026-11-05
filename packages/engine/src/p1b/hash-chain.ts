import type {
  CommandInput,
  CommandRecord,
  CoreEffect,
  VersionTuple
} from "@life-sim/contracts";
import { ascii, concatBytes, toHex } from "../bytes";
import { canonicalBytes, type CanonicalValue } from "../canonical/canonical";
import { sha256 } from "../rng/sha256";
import { applyCommand } from "./engine";
import type { EngineState } from "./types";
import { P1BError } from "./errors";
import { parseCommandInput, parseCommandRecord, parseEngineState, parseVersionTuple } from "./validate";

export const H0_PREFIX = ascii("LIFE1/P1B/H0/v1");
export const STEP_PREFIX = ascii("LIFE1/P1B/H/v1");
export const HASH_BYTES = 32;

function versionProjection(version: VersionTuple): Record<string, unknown> {
  return {
    engineVersion: version.engineVersion,
    rulesetVersion: version.rulesetVersion,
    rngSpecVersion: version.rngSpecVersion,
    dataVersion: version.dataVersion,
    contentVersion: version.contentVersion,
    saveFormatVersion: version.saveFormatVersion
  };
}

export function stateProjection(state: EngineState): Record<string, unknown> {
  return {
    schemaVersion: state.schemaVersion,
    seed: state.seed,
    year: state.year,
    stats: { ...state.stats },
    resourcePppMicro: state.resourcePppMicro,
    flags: { ...state.flags },
    rng: [...state.rng],
    rngDraws: state.rngDraws,
    rulesetSettings: { ...state.rulesetSettings }
  };
}

function effectProjection(effect: CoreEffect): Record<string, unknown> {
  switch (effect.kind) {
    case "stat":
      return { kind: effect.kind, stat: effect.stat, delta: effect.delta };
    case "money":
      return { kind: effect.kind, deltaPppMicro: effect.deltaPppMicro };
    case "flag":
      return { kind: effect.kind, key: effect.key, value: effect.value };
  }
}

function commandProjection(record: CommandRecord): Record<string, unknown> {
  return {
    seq: record.seq,
    commandId: record.commandId,
    effectiveYear: record.effectiveYear,
    auto: record.auto,
    policyId: record.policyId,
    optionIds: [...record.optionIds],
    selectedOptionId: record.selectedOptionId,
    rngCursor: {
      state: [...record.rngCursor.state],
      draws: record.rngCursor.draws
    },
    command: {
      kind: record.command.kind,
      effects: record.command.effects.map(effectProjection)
    }
  };
}

export function h0InputBytes(version: VersionTuple, baseState: EngineState): Uint8Array {
  const parsedVersion = parseVersionTuple(version);
  const parsedState = parseEngineState(baseState);
  const payload = canonicalBytes({
    version: versionProjection(parsedVersion),
    state: stateProjection(parsedState)
  } as unknown as CanonicalValue);
  return concatBytes(H0_PREFIX, Uint8Array.of(0), payload);
}

export function h0Bytes(version: VersionTuple, baseState: EngineState): Uint8Array {
  return sha256(h0InputBytes(version, baseState));
}

export function h0Hex(version: VersionTuple, baseState: EngineState): string {
  return toHex(h0Bytes(version, baseState));
}

export function stepInputBytes(
  version: VersionTuple,
  stateAfter: EngineState,
  record: CommandRecord,
  previousHash: Uint8Array
): Uint8Array {
  if (!(previousHash instanceof Uint8Array) || previousHash.length !== HASH_BYTES) {
    throw new P1BError("INVALID_COMMAND_LOG", "previous hash must be 32 bytes");
  }
  const parsedVersion = parseVersionTuple(version);
  const parsedState = parseEngineState(stateAfter);
  const parsedRecord = parseCommandRecord(record);
  const payload = canonicalBytes({
    version: versionProjection(parsedVersion),
    state: stateProjection(parsedState),
    command: commandProjection(parsedRecord)
  } as unknown as CanonicalValue);
  return concatBytes(STEP_PREFIX, Uint8Array.of(0), previousHash, payload);
}

export function stepHashBytes(
  version: VersionTuple,
  stateAfter: EngineState,
  record: CommandRecord,
  previousHash: Uint8Array
): Uint8Array {
  return sha256(stepInputBytes(version, stateAfter, record, previousHash));
}

export interface ChainResult {
  h0: string;
  h0Bytes: Uint8Array;
  hashes: string[];
  finalHash: string;
  finalBytes: Uint8Array;
}

export function computeChain(version: VersionTuple, baseState: EngineState, commandLog: readonly CommandRecord[]): ChainResult {
  const parsedVersion = parseVersionTuple(version);
  let state = parseEngineState(baseState);
  const initial = h0Bytes(parsedVersion, state);
  let previous = initial;
  const hashes: string[] = [];
  for (let index = 0; index < commandLog.length; index += 1) {
    const record = parseCommandRecord(commandLog[index]);
    if (record.seq !== index) throw new P1BError("INVALID_COMMAND_LOG", "command seq must be contiguous");
    if (record.effectiveYear !== state.year) throw new P1BError("INVALID_COMMAND_LOG", "effectiveYear mismatch");
    state = applyCommand(state, record.command, record.effectiveYear);
    if (record.rngCursor.draws !== state.rngDraws || record.rngCursor.state.some((word, i) => word !== state.rng[i])) {
      throw new P1BError("INVALID_COMMAND_LOG", "rngCursor does not match state");
    }
    previous = stepHashBytes(parsedVersion, state, record, previous);
    hashes.push(toHex(previous));
  }
  return { h0: toHex(initial), h0Bytes: initial, hashes, finalHash: toHex(previous), finalBytes: previous };
}

export interface RecordedCommands {
  records: CommandRecord[];
  state: EngineState;
  h0: string;
  hashes: string[];
  stateHash: string;
}

export function recordCommands(version: VersionTuple, baseState: EngineState, inputs: readonly CommandInput[]): RecordedCommands {
  const parsedVersion = parseVersionTuple(version);
  let state = parseEngineState(baseState);
  const initial = h0Bytes(parsedVersion, state);
  let previous = initial;
  const records: CommandRecord[] = [];
  const hashes: string[] = [];
  const ids = new Set<string>();
  for (const rawInput of inputs) {
    const input = parseCommandInput(rawInput);
    if (ids.has(input.commandId)) throw new P1BError("INVALID_COMMAND_LOG", "duplicate commandId");
    ids.add(input.commandId);
    if (input.effectiveYear !== state.year) throw new P1BError("INVALID_COMMAND_LOG", "effectiveYear mismatch");
    state = applyCommand(state, input.command, input.effectiveYear);
    const record: CommandRecord = {
      seq: records.length,
      commandId: input.commandId,
      effectiveYear: input.effectiveYear,
      auto: input.auto,
      policyId: input.policyId,
      optionIds: input.optionIds,
      selectedOptionId: input.selectedOptionId,
      rngCursor: { state: [...state.rng], draws: state.rngDraws },
      command: input.command,
      stateHashAfter: "0".repeat(64)
    };
    previous = stepHashBytes(parsedVersion, state, record, previous);
    record.stateHashAfter = toHex(previous);
    hashes.push(record.stateHashAfter);
    records.push(record);
  }
  return { records, state, h0: toHex(initial), hashes, stateHash: toHex(previous) };
}
