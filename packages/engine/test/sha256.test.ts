import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex, utf8Encode } from "../src";

function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 0xff);
}

function nodeSha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("SHA-256 independent vectors", () => {
  it("matches Node crypto at padding and block boundaries", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1000]) {
      const input = bytes(length);
      expect(sha256Hex(input), `length ${length}`).toBe(nodeSha256(input));
    }
  });

  it("matches Node crypto for a multi-block large input", () => {
    const input = bytes(100_000);
    expect(sha256Hex(input)).toBe(nodeSha256(input));
    expect(sha256Hex(utf8Encode("abc"))).toBe(nodeSha256(utf8Encode("abc")));
  });
});
