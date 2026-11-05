import type { VersionTuple } from "@life-sim/contracts";
import { applyCommand } from "./engine";
import { h0Bytes, stepHashBytes } from "./hash-chain";
import type { EngineState } from "./types";
import { parseCommandRecord, parseEngineState, parseVersionTuple } from "./validate";
import { P1BError, ReplayDivergenceError } from "./errors";

export interface ReplayDivergence {
  code: "DIVERGED_AT_YEAR";
  index: number;
  year: number;
  expectedHash: string;
  actualHash: string;
}

export type ReplayResult =
  | { ok: true; state: EngineState; h0: string; hashes: string[]; finalHash: string }
  | { ok: false; divergence: ReplayDivergence };

export function replay(
  version: VersionTuple,
  baseState: EngineState,
  commandLog: readonly import("@life-sim/contracts").CommandRecord[]
): ReplayResult {
  const parsedVersion = parseVersionTuple(version);
  let state = parseEngineState(baseState);
  const initial = h0Bytes(parsedVersion, state);
  let previous = initial;
  const hashes: string[] = [];
  for (let index = 0; index < commandLog.length; index += 1) {
    const record = parseCommandRecord(commandLog[index]);
    if (record.seq !== index) throw new P1BError("INVALID_COMMAND_LOG", "command seq must be contiguous");
    if (record.effectiveYear !== state.year) {
      throw new P1BError("INVALID_COMMAND_LOG", "effectiveYear mismatch");
    }
    state = applyCommand(state, record.command, record.effectiveYear);
    if (record.rngCursor.draws !== state.rngDraws || record.rngCursor.state.some((word, i) => word !== state.rng[i])) {
      throw new P1BError("INVALID_COMMAND_LOG", "rngCursor does not match state");
    }
    const actual = stepHashBytes(parsedVersion, state, record, previous);
    const actualHash = Array.from(actual, (byte) => byte.toString(16).padStart(2, "0")).join("");
    hashes.push(actualHash);
    if (actualHash !== record.stateHashAfter) {
      return {
        ok: false,
        divergence: {
          code: "DIVERGED_AT_YEAR",
          index,
          year: record.effectiveYear,
          expectedHash: record.stateHashAfter,
          actualHash
        }
      };
    }
    previous = actual;
  }
  const finalHash = Array.from(previous, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { ok: true, state, h0: toHex(initial), hashes, finalHash };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertReplay(
  version: VersionTuple,
  baseState: EngineState,
  commandLog: readonly import("@life-sim/contracts").CommandRecord[]
): { state: EngineState; h0: string; hashes: string[]; finalHash: string } {
  const result = replay(version, baseState, commandLog);
  if (!result.ok) {
    throw new ReplayDivergenceError(
      result.divergence.index,
      result.divergence.year,
      result.divergence.expectedHash,
      result.divergence.actualHash
    );
  }
  return result;
}
