import { ascii, concatBytes, readU32be, toHex, u32be, utf8Encode } from "../bytes";
import { sha256 } from "./sha256";

export type RngState = readonly [number, number, number, number];

export const FALLBACK_RNG_STATE: RngState = [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef];

export class SeedError extends Error {
  constructor(public readonly code: "EMPTY_SEED" | "SEED_TOO_LONG" | "CONTROL_CHAR" | "BAD_DOMAIN" | "BAD_SPEC") {
    super(code);
    this.name = "SeedError";
  }
}

export function normalizeSeed(input: string): string {
  if (typeof input !== "string") throw new SeedError("EMPTY_SEED");
  const text = input.normalize("NFC").trim();
  if (text.length === 0) throw new SeedError("EMPTY_SEED");
  if (utf8Encode(text).length > 128) throw new SeedError("SEED_TOO_LONG");
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f) throw new SeedError("CONTROL_CHAR");
  }
  return text;
}

export function seedDigest(seedText: string): Uint8Array {
  const text = normalizeSeed(seedText);
  const bytes = utf8Encode(text);
  return sha256(concatBytes(ascii("LIFE1/SEED/v1"), Uint8Array.of(0), u32be(bytes.length), bytes));
}

export function seedHash(seedText: string): string {
  return toHex(seedDigest(seedText));
}

export function deriveDomainState(seedText: string, domain: string, spec = "1.0.0"): RngState {
  if (!/^[a-z0-9_]{1,32}$/.test(domain)) throw new SeedError("BAD_DOMAIN");
  if (!/^[0-9A-Za-z._-]{1,32}$/.test(spec)) throw new SeedError("BAD_SPEC");
  const digest = seedDigest(seedText);
  const domainBytes = ascii(domain);
  const specBytes = ascii(spec);
  const material = concatBytes(
    ascii("LIFE1/RNG/v1"),
    Uint8Array.of(0),
    digest,
    u32be(domainBytes.length),
    domainBytes,
    u32be(specBytes.length),
    specBytes
  );
  const streamSeed = sha256(material).slice(0, 16);
  const state: RngState = [
    readU32be(streamSeed, 0),
    readU32be(streamSeed, 4),
    readU32be(streamSeed, 8),
    readU32be(streamSeed, 12)
  ];
  return state.every((word) => word === 0) ? FALLBACK_RNG_STATE : state;
}
