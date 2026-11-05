import { describe, expect, it } from "vitest";
import {
  CanonicalError,
  canonicalBytes,
  canonicalStateHash,
  toHex
} from "../src";

describe("canonical binary encoding", () => {
  it("encodes primitive tags and lengths", () => {
    expect(toHex(canonicalBytes(null))).toBe("00");
    expect(toHex(canonicalBytes(false))).toBe("01");
    expect(toHex(canonicalBytes(true))).toBe("02");
    expect(toHex(canonicalBytes(0))).toBe("030000000000000000");
    expect(toHex(canonicalBytes(1))).toBe("030000000000000001");
    expect(toHex(canonicalBytes(0n))).toBe("040000000130");
    expect(toHex(canonicalBytes("é"))).toBe("0500000002c3a9");
    expect(toHex(canonicalBytes(Uint8Array.of(1, 2)))).toBe("06000000020102");
  });

  it("encodes arrays and objects with count prefixes", () => {
    expect(toHex(canonicalBytes([1, true]))).toBe("070000000203000000000000000102");
    expect(toHex(canonicalBytes({ b: ["x", true], a: 1 }))).toBe(
      "0800000002050000000161030000000000000001050000000162070000000205000000017802"
    );
    expect(toHex(canonicalBytes({}))).toBe("0800000000");
    expect(toHex(canonicalBytes([]))).toBe("0700000000");
  });

  it("sorts object keys by UTF-8 bytes, not insertion order", () => {
    expect(toHex(canonicalBytes({ b: 2, a: 1 }))).toBe(toHex(canonicalBytes({ a: 1, b: 2 })));
    expect(toHex(canonicalBytes({ "é": 1, z: 2 }))).toBe(
      "080000000205000000017a0300000000000000020500000002c3a9030000000000000001"
    );
  });

  it("rejects unsafe numbers without rounding", () => {
    for (const value of [
      2 ** 53,
      Number.MAX_SAFE_INTEGER + 1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    ]) {
      expect(() => canonicalBytes(value)).toThrow(CanonicalError);
    }
    expect(canonicalBytes(Number.MAX_SAFE_INTEGER)[0]).toBe(0x03);
    expect(canonicalBytes(Number.MIN_SAFE_INTEGER)[0]).toBe(0x03);
  });

  it("accepts unsafe integers only as BigInt", () => {
    const big = 2n ** 53n;
    const bytes = canonicalBytes(big);
    expect(bytes[0]).toBe(0x04);
    expect(toHex(bytes)).toBe("040000001039303037313939323534373430393932");
  });

  it("rejects class instances", () => {
    expect(() => canonicalBytes(new Date(0) as never)).toThrow(CanonicalError);
    expect(() => canonicalBytes(new Map() as never)).toThrow(CanonicalError);
  });

  it("hashes with the ADR-002 prefix", () => {
    expect(canonicalStateHash({ b: ["x", true], a: 1 })).toBe(
      "1626a8a958625584448aa4c92247ec133c8648cb5cf10eb692b3af2a6a3da473"
    );
  });
});
