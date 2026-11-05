import { describe, expect, it } from "vitest";

describe("BigInt literal runtime", () => {
  it("supports native BigInt literals and arithmetic", () => {
    expect(1n + 1n).toBe(2n);
    expect(typeof 1n).toBe("bigint");
    expect(2n ** 64n).toBe(18446744073709551616n);
    expect(-1n < 0n).toBe(true);
  });
});
