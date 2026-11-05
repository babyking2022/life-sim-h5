import { describe, expect, it } from "vitest";
import type { P3BEffect } from "@life-sim/contracts";
import { BASE_STATE, codeOf } from "./p3b-helpers";
import { applyEventEffects, readEffectList, readDecisionSpec } from "../src/life/events";

/** P3-B typed effects：先完整驗證、再一次套用（禁止部分成功）。 */

const apply = (effects: readonly unknown[]) => applyEventEffects(BASE_STATE, effects as readonly P3BEffect[]);

describe("P3-B effects：stat", () => {
  it("applies integer deltas and clamps to 0..100", () => {
    expect(apply([{ type: "stat", stat: "health", delta: -15 }]).stats.health).toBe(45);
    expect(
      apply([
        { type: "stat", stat: "health", delta: -60 },
        { type: "stat", stat: "health", delta: -60 }
      ]).stats.health
    ).toBe(0);
    expect(
      apply([
        { type: "stat", stat: "happiness", delta: 60 },
        { type: "stat", stat: "happiness", delta: 60 }
      ]).stats.happiness
    ).toBe(100);
  });

  it("rejects non-integer and out-of-range deltas", () => {
    expect(codeOf(() => apply([{ type: "stat", stat: "health", delta: 1.5 }]))).toBe("E_P3B_TYPE");
    expect(codeOf(() => apply([{ type: "stat", stat: "health", delta: 101 }]))).toBe("E_P3B_RANGE");
    expect(codeOf(() => apply([{ type: "stat", stat: "wisdom", delta: 1 }]))).toBe("E_P3B_ENUM");
  });
});

describe("P3-B effects：money", () => {
  it("adds and subtracts micro-USD with BigInt", () => {
    const income = apply([{ type: "money", field: "annualIncomeMicroUsd", deltaMicroUsd: "3000000" }]);
    expect(income.assets.annualIncomeMicroUsd).toBe(15_000_000n);
    const balance = apply([{ type: "money", field: "balanceMicroUsd", deltaMicroUsd: "-400000" }]);
    expect(balance.assets.balanceMicroUsd).toBe(-400_000n);
  });

  it("allows a negative balance (net debt)", () => {
    const outcome = apply([
      { type: "money", field: "balanceMicroUsd", deltaMicroUsd: "-900000000" },
      { type: "money", field: "balanceMicroUsd", deltaMicroUsd: "-100000000" }
    ]);
    expect(outcome.assets.balanceMicroUsd).toBe(-1_000_000_000n);
    expect(outcome.assets.balanceMicroUsd < 0n).toBe(true);
  });

  it("rejects malformed or out-of-range money", () => {
    expect(codeOf(() => apply([{ type: "money", field: "balanceMicroUsd", deltaMicroUsd: 1 }]))).toBe("E_P3B_TYPE");
    expect(codeOf(() => apply([{ type: "money", field: "balanceMicroUsd", deltaMicroUsd: "1.5" }]))).toBe("E_P3B_MONEY");
    expect(codeOf(() => apply([{ type: "money", field: "balanceMicroUsd", deltaMicroUsd: "0x10" }]))).toBe("E_P3B_MONEY");
    expect(codeOf(() => apply([{ type: "money", field: "balanceMicroUsd", deltaMicroUsd: "99999999999999999999999" }]))).toBe("E_P3B_MONEY");
    expect(codeOf(() => apply([{ type: "money", field: "balanceMicroUsd", deltaMicroUsd: "1".repeat(40) }]))).toBe("E_P3B_MONEY");
    expect(codeOf(() => apply([{ type: "money", field: "wallet", deltaMicroUsd: "1" }]))).toBe("E_P3B_ENUM");
  });
});

describe("P3-B effects：flag", () => {
  it("adds, removes and keeps flags sorted and unique", () => {
    const added = apply([
      { type: "flag", flag: "school:steady", action: "add" },
      { type: "flag", flag: "family:sibling", action: "add" }
    ]);
    expect(added.flags).toEqual(["family:sibling", "school:steady"]);

    const withFlags = applyEventEffects({ ...BASE_STATE, flags: ["b:one", "a:two"] }, [
      { type: "flag", flag: "a:two", action: "remove" }
    ]);
    expect(withFlags.flags).toEqual(["b:one"]);
  });

  it("rejects invalid flag names", () => {
    expect(codeOf(() => apply([{ type: "flag", flag: "Not Valid", action: "add" }]))).toBe("E_P3B_PATTERN");
    expect(codeOf(() => apply([{ type: "flag", flag: "", action: "add" }]))).toBe("E_P3B_PATTERN");
    expect(codeOf(() => apply([{ type: "flag", flag: "ok", action: "toggle" }]))).toBe("E_P3B_ENUM");
  });
});

describe("P3-B effects：decision 與 informational", () => {
  it("opens at most one decision", () => {
    const outcome = apply([{ type: "openDecision", decisionId: "dec.child.school" }]);
    expect(outcome.openedDecisionId).toBe("dec.child.school");
    expect(
      codeOf(() =>
        apply([
          { type: "openDecision", decisionId: "dec.child.school" },
          { type: "openDecision", decisionId: "dec.teen.path" }
        ])
      )
    ).toBe("E_P3B_DECISION");
  });

  it("marks informational events and forbids mixing", () => {
    const outcome = apply([{ type: "informational" }]);
    expect(outcome.informational).toBe(true);
    expect(codeOf(() => apply([{ type: "informational" }, { type: "stat", stat: "health", delta: 1 }]))).toBe("E_P3B_EFFECT");
  });

  it("rejects unknown effect types", () => {
    expect(codeOf(() => apply([{ type: "teleport", to: "mars" }]))).toBe("E_P3B_ENUM");
    expect(codeOf(() => apply([{ type: "stat", stat: "health", delta: 1, extra: true }]))).toBe("E_P3B_UNKNOWN_KEY");
  });
});

describe("P3-B effects：原子性與不可變性", () => {
  it("rejects the whole list when any effect is invalid (no partial application)", () => {
    const effects = [
      { type: "stat", stat: "health", delta: -10 },
      { type: "money", field: "balanceMicroUsd", deltaMicroUsd: "not-a-number" },
      { type: "flag", flag: "ok", action: "add" }
    ];
    expect(codeOf(() => apply(effects))).toBe("E_P3B_MONEY");
    // 輸入 state 完全沒被動到。
    expect(BASE_STATE.stats.health).toBe(60);
    expect(BASE_STATE.flags).toEqual([]);
  });

  it("does not mutate the input state", () => {
    const state = { ...BASE_STATE, flags: ["keep:me"] };
    applyEventEffects(state, [
      { type: "stat", stat: "health", delta: -5 },
      { type: "flag", flag: "keep:me", action: "remove" }
    ]);
    expect(state.stats.health).toBe(60);
    expect(state.flags).toEqual(["keep:me"]);
  });

  it("is deterministic for repeated calls", () => {
    const effects: P3BEffect[] = [
      { type: "stat", stat: "happiness", delta: 3 },
      { type: "money", field: "balanceMicroUsd", deltaMicroUsd: "123456" },
      { type: "flag", flag: "z:last", action: "add" },
      { type: "flag", flag: "a:first", action: "add" }
    ];
    const first = applyEventEffects(BASE_STATE, effects);
    const second = applyEventEffects(BASE_STATE, effects);
    expect(first).toEqual(second);
    expect(first.flags).toEqual(["a:first", "z:last"]);
  });
});

describe("P3-B effects：型別與抉擇規格", () => {
  it("validates effect lists and decision specs", () => {
    expect(readEffectList([], "effects")).toEqual([]);
    expect(readEffectList([], "effects", 0)).toEqual([]);
    expect(
      readDecisionSpec(
        {
          decisionId: "dec.test",
          promptKey: "p3b.decision.test",
          options: [
            { optionId: "a.one", labelKey: "p3b.option.test.a", effects: [] },
            { optionId: "b.two", labelKey: "p3b.option.test.b", effects: [] }
          ]
        },
        "decision",
        5,
        8
      ).options
    ).toHaveLength(2);

    expect(
      codeOf(() =>
        readDecisionSpec(
          {
            decisionId: "dec.test",
            promptKey: "p3b.decision.test",
            options: [
              { optionId: "a.one", labelKey: "p3b.option.test.a", effects: [] },
              { optionId: "a.one", labelKey: "p3b.option.test.b", effects: [] }
            ]
          },
          "decision",
          5,
          8
        )
      )
    ).toBe("E_P3B_DUPLICATE_ID");

    expect(
      codeOf(() =>
        readDecisionSpec(
          {
            decisionId: "dec.test",
            promptKey: "p3b.decision.test",
            options: [{ optionId: "a.one", labelKey: "你在學校的選擇", effects: [] }]
          },
          "decision",
          5,
          8
        )
      )
    ).toBe("E_P3B_RANGE");
  });
});
