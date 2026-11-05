import { describe, expect, it } from "vitest";
import type { MoneyString, RulesetSettings } from "@life-sim/contracts";
import {
  P1BError,
  applyEffects,
  createInitialState,
  parseCommandInput,
  parseCommandRecord
} from "../src";

const settings: RulesetSettings = { contentMode: "standard", autoChoicePolicy: "stop" };



describe("P1-B.2 validation edge cases", () => {
  it("rejects malformed command records", () => {
    const record = {
      seq: 0,
      commandId: "c1",
      effectiveYear: 0,
      auto: false,
      policyId: null,
      optionIds: [],
      selectedOptionId: null,
      rngCursor: { state: createInitialState("P1B-VALIDATION", settings, "1.0.0").rng, draws: 0 },
      command: { kind: "apply_effects", effects: [{ kind: "stat", stat: "health", delta: 1 }] },
      stateHashAfter: "a".repeat(64)
    };
    expect(parseCommandRecord(record)).toEqual(record);
    for (const value of [
      { ...record, seq: -1 },
      { ...record, commandId: "bad id" },
      { ...record, stateHashAfter: "a".repeat(63) },
      { ...record, command: { kind: "apply_effects", effects: [] } },
      { ...record, rngCursor: { state: [1, 2, 3], draws: 0 } }
    ]) {
      expect(() => parseCommandRecord(value)).toThrow(P1BError);
    }
  });

  it("rejects empty and oversized effect arrays before applying", () => {
    const base = createInitialState("P1B-VALIDATION-2", settings, "1.0.0");
    expect(() => applyEffects(base, [])).toThrow(P1BError);
    expect(() =>
      applyEffects(
        base,
        Array.from({ length: 65 }, () => ({ kind: "stat" as const, stat: "health" as const, delta: 1 }))
      )
    ).toThrow(P1BError);
    expect(() => applyEffects(base, [{ kind: "flag", key: "ok", value: "yes" }])).not.toThrow();
    expect(() => applyEffects(base, [{ kind: "money", deltaPppMicro: "1.0" as MoneyString }])).toThrow();
  });

  it("rejects stat and year overflow without mutation", () => {
    const base = createInitialState("P1B-VALIDATION-3", settings, "1.0.0");
    const high = { ...base, stats: { ...base.stats, health: 1000 } };
    expect(applyEffects(high, [{ kind: "stat", stat: "health", delta: 10 }]).stats.health).toBe(1000);
    const low = { ...base, stats: { ...base.stats, health: 0 } };
    expect(applyEffects(low, [{ kind: "stat", stat: "health", delta: -10 }]).stats.health).toBe(0);
    expect(high.stats.health).toBe(1000);
  });

  it("enforces auto/policy/options cross-field rules", () => {
    const base = {
      commandId: "c1",
      effectiveYear: 0,
      auto: false,
      policyId: null,
      optionIds: ["o1"],
      selectedOptionId: "o1",
      command: { kind: "apply_effects" as const, effects: [{ kind: "stat" as const, stat: "health" as const, delta: 1 }] }
    };
    expect(parseCommandInput(base)).toEqual(base);
    for (const value of [
      { ...base, auto: true, policyId: null },
      { ...base, auto: true, policyId: "safe", optionIds: [], selectedOptionId: null },
      { ...base, auto: true, policyId: "safe", selectedOptionId: null },
      { ...base, auto: false, policyId: "safe" },
      { ...base, optionIds: [], selectedOptionId: "o1" },
      { ...base, selectedOptionId: null }
    ]) {
      expect(() => parseCommandInput(value)).toThrow(P1BError);
    }
  });
});
