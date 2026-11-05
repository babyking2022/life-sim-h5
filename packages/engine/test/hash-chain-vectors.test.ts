import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRecord, VersionTuple } from "@life-sim/contracts";
import {
  applyCommand,
  h0Bytes,
  h0Hex,
  h0InputBytes,
  sha256Hex,
  stepHashBytes,
  stepInputBytes,
  toHex,
  type EngineState
} from "../src";

interface VectorFile {
  generator: string;
  version: VersionTuple;
  baseState: { resourcePppMicro: string };
  stateAfterFirst: { resourcePppMicro: string };
  stateAfterSecond: { resourcePppMicro: string };
  firstCommand: Omit<CommandRecord, "stateHashAfter">;
  secondCommand: Omit<CommandRecord, "stateHashAfter">;
  h0InputHex: string;
  h0: string;
  h1InputHex: string;
  h1: string;
  h2InputHex: string;
  h2: string;
}

const vectors = JSON.parse(
  readFileSync(join(process.cwd(), "packages", "engine", "test", "fixtures", "hash-chain-vectors.json"), "utf8")
) as VectorFile;

function state(input: { resourcePppMicro: string }, year: number, stats: EngineState["stats"], flags: EngineState["flags"]): EngineState {
  return {
    schemaVersion: 1,
    seed: "P1B-VECTOR",
    year,
    stats,
    resourcePppMicro: BigInt(input.resourcePppMicro) as EngineState["resourcePppMicro"],
    flags,
    rng: [1, 2, 3, 4],
    rngDraws: 0,
    rulesetSettings: { contentMode: "standard", autoChoicePolicy: "stop" }
  };
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

const base = state(vectors.baseState, 0, { health: 500, happiness: 500, knowledge: 500, relationships: 500 }, {});
const firstState = state(vectors.stateAfterFirst, 1, { health: 505, happiness: 500, knowledge: 500, relationships: 500 }, {});
const secondState = state(vectors.stateAfterSecond, 2, { health: 505, happiness: 500, knowledge: 500, relationships: 500 }, { vec: "ok" });
const firstRecord: CommandRecord = { ...vectors.firstCommand, stateHashAfter: vectors.h1 };
const secondRecord: CommandRecord = { ...vectors.secondCommand, stateHashAfter: vectors.h2 };

describe("independent H0/H1/H2 byte vectors", () => {
  it("matches the independent H0 bytes and hash", () => {
    expect(toHex(h0InputBytes(vectors.version, base))).toBe(vectors.h0InputHex);
    expect(h0Hex(vectors.version, base)).toBe(vectors.h0);
    expect(sha256Hex(h0InputBytes(vectors.version, base))).toBe(vectors.h0);
  });

  it("matches H1 step input bytes and hash", () => {
    const officialState = applyCommand(base, firstRecord.command, 0);
    expect(officialState).toEqual(firstState);
    const input = stepInputBytes(vectors.version, officialState, firstRecord, h0Bytes(vectors.version, base));
    expect(toHex(input)).toBe(vectors.h1InputHex);
    expect(sha256Hex(input)).toBe(vectors.h1);
    expect(toHex(stepHashBytes(vectors.version, officialState, firstRecord, h0Bytes(vectors.version, base)))).toBe(vectors.h1);
  });

  it("matches H2 step input bytes and hash using H1 as 32 raw bytes", () => {
    const officialState = applyCommand(firstState, secondRecord.command, 1);
    expect(officialState).toEqual(secondState);
    const input = stepInputBytes(vectors.version, officialState, secondRecord, hexBytes(vectors.h1));
    expect(toHex(input)).toBe(vectors.h2InputHex);
    expect(sha256Hex(input)).toBe(vectors.h2);
    expect(toHex(stepHashBytes(vectors.version, officialState, secondRecord, hexBytes(vectors.h1)))).toBe(vectors.h2);
  });
});
