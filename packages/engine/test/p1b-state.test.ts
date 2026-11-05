import { describe, expect, it } from "vitest";
import type { CommandInput, CoreEffect, MoneyString, RulesetSettings, VersionTuple } from "@life-sim/contracts";
import {
  P1BError,
  applyCommand,
  applyEffects,
  computeChain,
  createInitialState,
  h0Hex,
  h0InputBytes,
  parseCommandInput,
  parseEffect,
  parseEngineState,
  recordCommands,
  replay,
  stepInputBytes
} from "../src";

const version: VersionTuple = {
  engineVersion: "0.1.0",
  rulesetVersion: "p1b-1",
  rngSpecVersion: "1.0.0",
  dataVersion: "2026.10",
  contentVersion: "p1b-content-0",
  saveFormatVersion: 3
};
const settings: RulesetSettings = { contentMode: "standard", autoChoicePolicy: "stop" };

function command(overrides: Partial<CommandInput> = {}): CommandInput {
  return {
    commandId: "c1",
    effectiveYear: 0,
    auto: false,
    policyId: null,
    optionIds: ["o1", "o2"],
    selectedOptionId: "o1",
    command: {
      kind: "apply_effects",
      effects: [
        { kind: "stat", stat: "health", delta: 10 },
        { kind: "money", deltaPppMicro: "1500000" as MoneyString },
        { kind: "flag", key: "ready", value: true }
      ]
    },
    ...overrides
  };
}

describe("P1-B.2 pure state machine", () => {
  it("applies approved effects in order without mutating input", () => {
    const base = createInitialState("P1B-STATE-1", settings, "1.0.0");
    const effects: CoreEffect[] = [
      { kind: "stat", stat: "health", delta: 10 },
      { kind: "money", deltaPppMicro: "1500000" as MoneyString },
      { kind: "flag", key: "ready", value: true }
    ];
    const next = applyEffects(base, effects);
    expect(base.stats.health).toBe(500);
    expect(base.resourcePppMicro).toBe(0n);
    expect(next.stats.health).toBe(510);
    expect(next.resourcePppMicro).toBe(1_500_000n);
    expect(next.flags).toEqual({ ready: true });
  });

  it("rejects unknown, extra, float, unsafe, and out-of-range effects", () => {
    for (const effect of [
      { kind: "unknown" },
      { kind: "stat", stat: "health", delta: 1, extra: true },
      { kind: "stat", stat: "health", delta: 1.5 },
      { kind: "stat", stat: "health", delta: 101 },
      { kind: "stat", stat: "bad", delta: 1 },
      { kind: "money", deltaPppMicro: "1.0" },
      { kind: "flag", key: "ok", value: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      expect(() => parseEffect(effect), JSON.stringify(effect)).toThrow(P1BError);
    }
  });

  it("checks effectiveYear before applying and increments year once", () => {
    const base = createInitialState("P1B-STATE-2", settings, "1.0.0");
    const next = applyCommand(base, command().command, 0);
    expect(base.year).toBe(0);
    expect(next.year).toBe(1);
    expect(() => applyCommand(base, command().command, 999)).toThrow(P1BError);
    expect(() => applyCommand(base, command().command, 1.5)).toThrow(P1BError);
  });

  it("rejects unsupported rngSpecVersion", () => {
    expect(createInitialState("P1B-STATE-3", settings, "1.0.0").rng).toHaveLength(4);
    expect(() => createInitialState("P1B-STATE-3", settings, "2.0.0")).toThrow(P1BError);
  });

  it("rejects unknown rngSpec in H0, step, record, chain, and replay", () => {
    const base = createInitialState("P1B-STATE-RNG", settings, "1.0.0");
    const good = recordCommands(version, base, [command()]);
    const badVersion = { ...version, rngSpecVersion: "2.0.0" };
    expect(() => h0InputBytes(badVersion, base)).toThrow(P1BError);
    expect(() => stepInputBytes(badVersion, good.state, good.records[0]!, new Uint8Array(32))).toThrow(P1BError);
    expect(() => recordCommands(badVersion, base, [command()])).toThrow(P1BError);
    expect(() => computeChain(badVersion, base, good.records)).toThrow(P1BError);
    expect(() => replay(badVersion, base, good.records)).toThrow(P1BError);
  });

  it("builds incremental H0/H1/H2 without presentation", () => {
    const base = createInitialState("P1B-CHAIN-1", settings, "1.0.0");
    const first = command();
    const second = command({ commandId: "c2", effectiveYear: 1, command: { kind: "apply_effects", effects: [{ kind: "stat", stat: "happiness", delta: -5 }] } });
    const recorded = recordCommands(version, base, [first, second]);
    const chain = computeChain(version, base, recorded.records);
    expect(chain.h0).toBe(recorded.h0);
    expect(chain.hashes).toEqual(recorded.hashes);
    expect(chain.finalHash).toBe(recorded.stateHash);
    expect(chain.hashes[0]).not.toBe(chain.h0);
    expect(chain.hashes[1]).not.toBe(chain.hashes[0]);
    expect(h0Hex(version, base)).toBe(chain.h0);
  });

  it("hashes version, RNG, settings, command metadata, and command effects", () => {
    const base = createInitialState("P1B-CHAIN-2", settings, "1.0.0");
    const h0 = h0Hex(version, base);
    const changedVersion = h0Hex({ ...version, contentVersion: "other" }, base);
    const changedRng = h0Hex(version, { ...base, rng: [(base.rng[0] + 1) >>> 0, base.rng[1], base.rng[2], base.rng[3]] });
    const changedSettings = h0Hex(version, createInitialState("P1B-CHAIN-2", { contentMode: "guardian", autoChoicePolicy: "safe" }, "1.0.0"));
    expect(changedVersion).not.toBe(h0);
    expect(changedRng).not.toBe(h0);
    expect(changedSettings).not.toBe(h0);

    const first = recordCommands(version, base, [command()]);
    const changedAuto = recordCommands(version, base, [command({ auto: true, policyId: "safe" })]);
    const changedOption = recordCommands(version, base, [command({ selectedOptionId: "o2" })]);
    expect(changedAuto.stateHash).not.toBe(first.stateHash);
    expect(changedOption.stateHash).not.toBe(first.stateHash);
  });

  it("rejects effectiveYear mismatches in commandLog", () => {
    const base = createInitialState("P1B-CHAIN-3", settings, "1.0.0");
    expect(() => recordCommands(version, base, [command({ effectiveYear: 999 })])).toThrow(P1BError);
    expect(() => parseCommandInput({ ...command(), effectiveYear: Number.MAX_SAFE_INTEGER + 1 })).toThrow(P1BError);
    expect(() => recordCommands(version, base, [command(), command({ commandId: "c2", effectiveYear: 0 })])).toThrow(P1BError);
  });

  it("rejects malformed state and command metadata", () => {
    const base = createInitialState("P1B-STATE-4", settings, "1.0.0");
    expect(() => parseEngineState({ ...base, year: 1.5 })).toThrow(P1BError);
    expect(() => parseEngineState({ ...base, rng: [1, 2, 3] })).toThrow(P1BError);
    expect(() => parseEngineState({ ...base, extra: true })).toThrow(P1BError);
    expect(() => parseCommandInput({ ...command(), optionIds: ["o1", "o1"] })).toThrow(P1BError);
    expect(() => parseCommandInput({ ...command(), selectedOptionId: "o3" })).toThrow(P1BError);
  });
});
