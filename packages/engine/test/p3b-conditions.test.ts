import { describe, expect, it } from "vitest";
import type { P3BCondition } from "@life-sim/contracts";
import { codeOf } from "./p3b-helpers";
import { CONDITION_LIMITS, evaluateCondition, readCondition, type ConditionContext } from "../src/life/events";
import { BASE_STATE } from "./p3b-helpers";

/** P3-B 條件 DSL：白名單 operator、求值語義、深度／容量上限。 */

const context = (patch: Partial<ConditionContext> = {}): ConditionContext => ({
  state: BASE_STATE,
  contentMode: "standard",
  occurrences: [],
  ...patch
});

const condition = (raw: unknown): P3BCondition => readCondition(raw, "conditions");

describe("P3-B conditions：求值", () => {
  it("evaluates age and phase", () => {
    expect(evaluateCondition(condition({ op: "age", min: 18, max: 40 }), context())).toBe(true);
    expect(evaluateCondition(condition({ op: "age", min: 0, max: 17 }), context())).toBe(false);
    expect(evaluateCondition(condition({ op: "phase", phase: "life" }), context())).toBe(true);
    expect(evaluateCondition(condition({ op: "phase", phase: "death" }), context())).toBe(false);
  });

  it("evaluates stat bounds", () => {
    expect(evaluateCondition(condition({ op: "stat", stat: "happiness", min: 0, max: 35 }), context())).toBe(false);
    expect(evaluateCondition(condition({ op: "stat", stat: "health", min: 30, max: 100 }), context())).toBe(true);
  });

  it("evaluates money bounds including negative balances", () => {
    expect(
      evaluateCondition(condition({ op: "money", field: "balanceMicroUsd", min: "-100000000000", max: "-1" }), context())
    ).toBe(false);
    expect(
      evaluateCondition(condition({ op: "money", field: "balanceMicroUsd", min: "-100000000000", max: "-1" }), context({ state: { ...BASE_STATE, assets: { ...BASE_STATE.assets, balanceMicroUsd: -5n } } }))
    ).toBe(true);
    expect(
      evaluateCondition(condition({ op: "money", field: "annualIncomeMicroUsd", min: "1000000", max: "20000000" }), context())
    ).toBe(true);
  });

  it("evaluates flags, happened and cooldown", () => {
    expect(evaluateCondition(condition({ op: "flag", flag: "employed", present: true }), context())).toBe(false);
    expect(
      evaluateCondition(condition({ op: "flag", flag: "employed", present: true }), context({ state: { ...BASE_STATE, flags: ["employed"] } }))
    ).toBe(true);
    expect(evaluateCondition(condition({ op: "flag", flag: "employed", present: false }), context())).toBe(true);

    const occurrences = [{ eventId: "ev.any.setback", lastYear: 2049, count: 1 }];
    expect(evaluateCondition(condition({ op: "happened", eventId: "ev.any.setback" }), context({ occurrences }))).toBe(true);
    expect(evaluateCondition(condition({ op: "happened", eventId: "ev.any.small-win" }), context({ occurrences }))).toBe(false);
    // cooldown：2049 → 2050 只過 1 年，要求 5 年 → false；要求 1 年 → true；沒發生過 → true。
    expect(evaluateCondition(condition({ op: "cooldown", eventId: "ev.any.setback", years: 5 }), context({ occurrences }))).toBe(false);
    expect(evaluateCondition(condition({ op: "cooldown", eventId: "ev.any.setback", years: 1 }), context({ occurrences }))).toBe(true);
    expect(evaluateCondition(condition({ op: "cooldown", eventId: "ev.any.setback", years: 5 }), context())).toBe(true);
  });

  it("evaluates contentMode and boolean composition", () => {
    expect(evaluateCondition(condition({ op: "contentMode", mode: "guardian" }), context())).toBe(false);
    expect(evaluateCondition(condition({ op: "contentMode", mode: "guardian" }), context({ contentMode: "guardian" }))).toBe(true);

    const all = condition({
      op: "all",
      conditions: [
        { op: "age", min: 18, max: 40 },
        { op: "stat", stat: "health", min: 30, max: 100 }
      ]
    });
    expect(evaluateCondition(all, context())).toBe(true);

    const any = condition({
      op: "any",
      conditions: [
        { op: "age", min: 0, max: 5 },
        { op: "stat", stat: "health", min: 30, max: 100 }
      ]
    });
    expect(evaluateCondition(any, context())).toBe(true);

    const notTrue = condition({ op: "not", condition: { op: "age", min: 0, max: 5 } });
    expect(evaluateCondition(notTrue, context())).toBe(true);
  });
});

describe("P3-B conditions：驗證", () => {
  it("rejects unknown operators with E_P3B_CONDITION_OP", () => {
    expect(codeOf(() => condition({ op: "regex", pattern: ".*" }))).toBe("E_P3B_CONDITION_OP");
    expect(codeOf(() => condition({ op: "eval", source: "1+1" }))).toBe("E_P3B_CONDITION_OP");
    expect(codeOf(() => condition({ op: "function", body: "return true" }))).toBe("E_P3B_CONDITION_OP");
  });

  it("rejects unknown fields and wrong types", () => {
    expect(codeOf(() => condition({ op: "age", min: 0, max: 10, note: "x" }))).toBe("E_P3B_UNKNOWN_KEY");
    expect(codeOf(() => condition({ op: "age", min: "0", max: 10 }))).toBe("E_P3B_TYPE");
    expect(codeOf(() => condition({ op: "flag", flag: "employed", present: "yes" }))).toBe("E_P3B_TYPE");
    expect(codeOf(() => condition({ op: "money", field: "balanceMicroUsd", min: "1.5", max: "2" }))).toBe("E_P3B_MONEY");
    expect(codeOf(() => condition({ op: "money", field: "balanceMicroUsd", min: "10", max: "1" }))).toBe("E_P3B_RANGE");
    expect(codeOf(() => condition({ op: "stat", stat: "wisdom", min: 0, max: 1 }))).toBe("E_P3B_ENUM");
    expect(codeOf(() => condition({ op: "age", min: 0, max: 999 }))).toBe("E_P3B_RANGE");
  });

  it("rejects prototypes and non-objects", () => {
    expect(codeOf(() => condition({ op: "all", conditions: [{ op: "age", min: 0, max: 1 }], constructor: {} }))).toBe("E_P3B_PROTOTYPE_KEY");
    expect(codeOf(() => condition(null))).toBe("E_P3B_TYPE");
    expect(codeOf(() => condition([]))).toBe("E_P3B_TYPE");
    expect(codeOf(() => condition("age"))).toBe("E_P3B_TYPE");
  });

  it("enforces the depth limit", () => {
    let node: Record<string, unknown> = { op: "age", min: 0, max: 120 };
    for (let depth = 0; depth < CONDITION_LIMITS.maxDepth - 1; depth += 1) node = { op: "not", condition: node };
    // 剛好在上限內
    expect(readCondition(node, "conditions").op).toBe("not");
    // 再一層就超過
    expect(codeOf(() => readCondition({ op: "not", condition: node }, "conditions"))).toBe("E_P3B_CONDITION_DEPTH");
  });

  it("enforces the node-count limit", () => {
    const leaves = Array.from({ length: CONDITION_LIMITS.maxNodes - 1 }, () => ({ op: "age", min: 0, max: 120 }));
    expect(readCondition({ op: "all", conditions: leaves }, "conditions").op).toBe("all");
    const tooMany = Array.from({ length: CONDITION_LIMITS.maxNodes + 1 }, () => ({ op: "age", min: 0, max: 120 }));
    expect(codeOf(() => readCondition({ op: "all", conditions: tooMany }, "conditions"))).toBe("E_P3B_CONDITION_SIZE");
  });
});
