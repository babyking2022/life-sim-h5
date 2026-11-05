import { describe, expect, it } from "vitest";
import { BirthDataError } from "../src/errors";
import { assertRecordWeight, pickWeightedIndex, sumWeights } from "../src/weights";

function codeOf(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof BirthDataError ? error.code : "OTHER";
  }
}

describe("P2-A integer weights", () => {
  it("accepts positive safe integers including MAX_SAFE_INTEGER", () => {
    expect(assertRecordWeight(1, "w")).toBe(1);
    expect(assertRecordWeight(Number.MAX_SAFE_INTEGER, "w")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("has fixed codes for zero, negative and overflow", () => {
    expect(codeOf(() => assertRecordWeight(0, "w"))).toBe("E_P2A_WEIGHT_ZERO");
    expect(codeOf(() => assertRecordWeight(-1, "w"))).toBe("E_P2A_WEIGHT_NEGATIVE");
    expect(codeOf(() => assertRecordWeight(2 ** 53, "w"))).toBe("E_P2A_WEIGHT_OVERFLOW");
    expect(codeOf(() => assertRecordWeight(1.5, "w"))).toBe("E_P2A_TYPE");
    expect(codeOf(() => assertRecordWeight("3", "w"))).toBe("E_P2A_TYPE");
  });

  it("sums with BigInt and rejects totals above 2^64-1", () => {
    expect(sumWeights([1, 2, 3])).toBe(6n);
    expect(codeOf(() => sumWeights([0]))).toBe("E_P2A_WEIGHT_ZERO");
    expect(codeOf(() => sumWeights(Array.from({ length: 4096 }, () => Number.MAX_SAFE_INTEGER)))).toBe(
      "E_P2A_WEIGHT_TOTAL_OVERFLOW"
    );
  });

  it("picks the first bucket that covers the ticket", () => {
    expect(pickWeightedIndex([1, 1], () => 0n)).toBe(0);
    expect(pickWeightedIndex([1, 1], () => 1n)).toBe(1);
    expect(pickWeightedIndex([1, 2, 3], () => 2n)).toBe(1);
    expect(pickWeightedIndex([1, 2, 3], () => 5n)).toBe(2);
  });
});
