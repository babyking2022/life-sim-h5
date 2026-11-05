import { describe, expect, it } from "vitest";
import type { CommandInput, CommandRecord, MoneyString, VersionTuple } from "@life-sim/contracts";
import {
  P1BError,
  ReplayDivergenceError,
  assertReplay,
  createInitialState,
  recordCommands,
  replay
} from "../src";

const version: VersionTuple = {
  engineVersion: "0.1.0",
  rulesetVersion: "p1b-1",
  rngSpecVersion: "1.0.0",
  dataVersion: "2026.10",
  contentVersion: "p1b-replay",
  saveFormatVersion: 3
};
const settings = { contentMode: "standard" as const, autoChoicePolicy: "stop" as const };

const input: CommandInput = {
  commandId: "c1",
  effectiveYear: 0,
  auto: false,
  policyId: null,
  optionIds: ["o1"],
  selectedOptionId: "o1",
  command: { kind: "apply_effects", effects: [{ kind: "money", deltaPppMicro: "1" as MoneyString }] }
};

function setup() {
  const base = createInitialState("P1B-REPLAY", settings, "1.0.0");
  const recorded = recordCommands(version, base, [input]);
  return { base, recorded };
}

describe("P1-B.2 replay paths", () => {
  it("replays successfully and returns H0/hashes", () => {
    const { base, recorded } = setup();
    const result = assertReplay(version, base, recorded.records);
    expect(result.state.year).toBe(1);
    expect(result.h0).toBe(recorded.h0);
    expect(result.hashes).toEqual(recorded.hashes);
    expect(result.finalHash).toBe(recorded.stateHash);
  });

  it("reports the first divergence at its effectiveYear", () => {
    const { base, recorded } = setup();
    const broken: CommandRecord = { ...recorded.records[0]!, stateHashAfter: "f".repeat(64) };
    const result = replay(version, base, [broken]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.divergence.code).toBe("DIVERGED_AT_YEAR");
      expect(result.divergence.index).toBe(0);
      expect(result.divergence.year).toBe(0);
    }
    expect(() => assertReplay(version, base, [broken])).toThrow(ReplayDivergenceError);
  });

  it("rejects effectiveYear and rngCursor mismatches as validation errors", () => {
    const { base, recorded } = setup();
    expect(() => replay(version, base, [{ ...recorded.records[0]!, effectiveYear: 999 }])).toThrow(P1BError);
    expect(() =>
      replay(version, base, [{ ...recorded.records[0]!, rngCursor: { state: [9, 9, 9, 9], draws: 0 } }])
    ).toThrow(P1BError);
  });

  it("rejects non-contiguous command sequence", () => {
    const { base, recorded } = setup();
    expect(() => replay(version, base, [{ ...recorded.records[0]!, seq: 7 }])).toThrow(P1BError);
  });
});
