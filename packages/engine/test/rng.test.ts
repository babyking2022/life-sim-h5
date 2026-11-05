import { describe, expect, it } from "vitest";
import {
  RngError,
  SeedError,
  Xoshiro128StarStar,
  createDomainRng,
  deriveDomainState,
  normalizeSeed,
  sha256Hex,
  uniformBigIntFrom,
  utf8Encode,
  weightedChoice
} from "../src";

function hex(values: readonly number[]): string[] {
  return values.map((value) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`);
}

function u32(rng: Xoshiro128StarStar, count: number): number[] {
  return Array.from({ length: count }, () => rng.nextU32());
}

describe("seed normalization", () => {
  it("normalizes NFC, trims, and keeps a stable seed", () => {
    expect(normalizeSeed("  LS-TP-001  ")).toBe("LS-TP-001");
    expect(normalizeSeed("e\u0301")).toBe("\u00e9");
    expect(normalizeSeed("e\u0301")).toBe(normalizeSeed("\u00e9"));
  });

  it("rejects empty, control characters, and overlong seeds", () => {
    expect(() => normalizeSeed("")).toThrow(SeedError);
    expect(() => normalizeSeed("   ")).toThrow(SeedError);
    expect(() => normalizeSeed("a\u0000b")).toThrow(SeedError);
    expect(() => normalizeSeed("a".repeat(129))).toThrow(SeedError);
  });

  it("accepts exactly 128 UTF-8 bytes and rejects 129 with multibyte text", () => {
    expect(normalizeSeed("é".repeat(64))).toBe("é".repeat(64));
    expect(() => normalizeSeed("é".repeat(64) + "a")).toThrow(SeedError);
    expect(normalizeSeed("a".repeat(128))).toBe("a".repeat(128));
    expect(() => normalizeSeed("a".repeat(129))).toThrow(SeedError);
  });

  it("encodes UTF-8 length in bytes", () => {
    expect(utf8Encode("abc")).toEqual(Uint8Array.of(0x61, 0x62, 0x63));
    expect(utf8Encode("\u00e9")).toEqual(Uint8Array.of(0xc3, 0xa9));
    expect(utf8Encode("\u{1f600}")).toEqual(Uint8Array.of(0xf0, 0x9f, 0x98, 0x80));
  });
});

describe("ADR-002 fixed vectors", () => {
  it("matches events domain first 8 uint32", () => {
    expect(hex(u32(createDomainRng("LS-TP-001", "events"), 8))).toEqual([
      "0x42C0E09B", "0x5D49C060", "0x3F5F2763", "0xE86C92E5",
      "0x7A9DA716", "0x4994162F", "0x2E4D1E39", "0x2FD48A58"
    ]);
  });

  it("matches birth domain first 8 uint32", () => {
    expect(hex(u32(createDomainRng("LS-TP-001", "birth"), 8))).toEqual([
      "0x4F3348AF", "0x02C6B443", "0xF0E79364", "0xC37605E7",
      "0x5B78950D", "0xD14D4DAA", "0xA43D287C", "0x10F0BDD3"
    ]);
  });

  it("matches weights domain first 8 uint32", () => {
    expect(hex(u32(createDomainRng("LS-TP-001", "weights"), 8))).toEqual([
      "0x8A51D84A", "0x6B2123F6", "0x412857FA", "0x52AB3C4F",
      "0x7D9BDBE5", "0x168C1D31", "0xF2420031", "0x9BF8F8EA"
    ]);
  });

  it("matches uniformInt sequences", () => {
    const events = createDomainRng("LS-TP-001", "events");
    expect(Array.from({ length: 10 }, () => events.uniformInt(1, 6))).toEqual([3, 4, 6, 3, 5, 1, 2, 1, 4, 3]);
    const birth = createDomainRng("LS-TP-001", "birth");
    expect(Array.from({ length: 10 }, () => birth.uniformInt(0, 99))).toEqual([79, 27, 66, 55, 31, 18, 33, 53, 53, 3]);
  });

  it("matches weightedChoice sequence", () => {
    const rng = createDomainRng("LS-TP-001", "weights");
    const items = [0, 1, 2, 3] as const;
    const result = Array.from({ length: 10 }, () => weightedChoice(items, [1, 2, 3, 4], rng));
    expect(result).toEqual([0, 3, 2, 1, 3, 1, 3, 3, 2, 1]);
  });

  it("matches all-zero fallback vector", () => {
    const rng = new Xoshiro128StarStar([0, 0, 0, 0]);
    expect(hex(u32(rng, 8))).toEqual([
      "0x92DCF72A", "0x00544CB2", "0x046D0FF3", "0x7192E3D9",
      "0xBA2B8389", "0x12BE2F0F", "0x4B522E7E", "0x5B4901AF"
    ]);
  });
});

describe("RNG invariants", () => {
  it("does not share a sequence across domains", () => {
    const a = createDomainRng("LS-TP-001", "events");
    const b = createDomainRng("LS-TP-001", "birth");
    expect(u32(a, 4)).not.toEqual(u32(b, 4));
  });

  it("is deterministic for the same seed and domain", () => {
    const a = u32(createDomainRng("same-seed", "events"), 12);
    const b = u32(createDomainRng("same-seed", "events"), 12);
    expect(a).toEqual(b);
  });

  it("rejects malformed RNG state", () => {
    const badStates: unknown[] = [
      null,
      {},
      [],
      [1],
      [1, 2, 3],
      [1, 2, 3, 4, 5],
      [Number.NaN, 1, 2, 3],
      [1.5, 1, 2, 3],
      [-1, 1, 2, 3],
      [0x100000000, 1, 2, 3]
    ];
    for (const state of badStates) {
      expect(() => new Xoshiro128StarStar(state), String(state)).toThrow(RngError);
    }
    expect(() => new Xoshiro128StarStar([0, 0, 0])).toThrow(RngError);
    expect(() => new Xoshiro128StarStar([0, 0, 0, 1])).not.toThrow();
    expect(() => new Xoshiro128StarStar([0, 0, 0, 0])).not.toThrow();
  });

  it("rejects int32-outside and wide ranges without consuming", () => {
    const rng = createDomainRng("LS-TP-001", "events");
    const before = rng.state;
    expect(() => rng.uniformInt(-2147483649, -2147483648)).toThrow(RngError);
    expect(() => rng.uniformInt(2147483647, 2147483648)).toThrow(RngError);
    expect(() => rng.uniformInt(0, 0x100000000)).toThrow(RngError);
    expect(() => rng.chancePpm(-1)).toThrow(RngError);
    expect(() => rng.chancePpm(1_000_001)).toThrow(RngError);
    expect(rng.state).toEqual(before);
    expect(rng.uniformInt(-2147483648, 2147483647)).toBeGreaterThanOrEqual(-2147483648);
    expect(rng.uniformInt(2147483647, 2147483647)).toBe(2147483647);
  });

  it("rejects weighted inputs outside 1..4096 before consuming", () => {
    const rng = createDomainRng("LS-TP-001", "weights");
    const before = rng.state;
    const p4096 = Array.from({ length: 4096 }, (_, i) => i);
    const p4097 = Array.from({ length: 4097 }, (_, i) => i);
    expect(weightedChoice(p4096, Array.from({ length: 4096 }, () => 1), rng)).toBeGreaterThanOrEqual(0);
    const after4096 = rng.state;
    expect(() => weightedChoice(p4097, Array.from({ length: 4097 }, () => 1), rng)).toThrow(RngError);
    expect(rng.state).toEqual(after4096);
    expect(() => weightedChoice([1], [], rng)).toThrow(RngError);
    expect(rng.state).toEqual(after4096);
    expect(before).not.toEqual(after4096);
  });

  it("rejects invalid uniformBigInt ranges without consuming", () => {
    const rng = createDomainRng("LS-TP-001", "events");
    const before = rng.state;
    expect(() => rng.uniformBigInt(0n)).toThrow(RngError);
    expect(() => rng.uniformBigInt((1n << 64n) + 1n)).toThrow(RngError);
    expect(rng.state).toEqual(before);
    expect(rng.uniformBigInt(1n)).toBe(0n);
    expect(rng.uniformBigInt(1n << 64n)).toBeLessThan(1n << 64n);
    expect(rng.uniformBigInt(1n << 63n)).toBeLessThan(1n << 63n);
  });

  it("rejects once then accepts, and exhausts after 128 rejections", () => {
    const n = 3n;
    const limit = ((1n << 64n) / n) * n;
    let calls = 0;
    const accepted = uniformBigIntFrom(() => {
      calls += 1;
      return calls === 1 ? limit : 0n;
    }, n);
    expect(accepted).toBe(0n);
    expect(calls).toBe(2);

    let rejectedCalls = 0;
    let error: unknown;
    try {
      uniformBigIntFrom(() => {
        rejectedCalls += 1;
        return limit;
      }, n);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RngError);
    expect((error as RngError).code).toBe("REJECTION_EXHAUSTED");
    expect(rejectedCalls).toBe(128);
  });

  it("validates weighted choices", () => {
    const rng = createDomainRng("LS-TP-001", "weights");
    expect(() => weightedChoice([1], [], rng)).toThrow();
    expect(() => weightedChoice([1, 2], [0, 0], rng)).toThrow();
    expect(() => weightedChoice([1], [-1], rng)).toThrow();
    expect(() => weightedChoice([1], [0x100000000], rng)).toThrow();
    expect(weightedChoice(["only"], [1], rng)).toBe("only");
  });

  it("keeps state serializable", () => {
    const state = deriveDomainState("LS-TP-001", "events");
    expect(state).toHaveLength(4);
    expect(state.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff)).toBe(true);
  });
});

describe("SHA-256", () => {
  it("matches known vectors", () => {
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(utf8Encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(utf8Encode("The quick brown fox jumps over the lazy dog"))).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
    );
  });
});
