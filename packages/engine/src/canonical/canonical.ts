import { ascii, compareBytes, concatBytes, u32be, utf8Encode } from "../bytes";
import { sha256Hex } from "../rng/sha256";

export type CanonicalValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class CanonicalError extends Error {
  constructor(public readonly code: "UNSAFE_NUMBER" | "UNSUPPORTED_TYPE" | "TOO_LONG") {
    super(code);
    this.name = "CanonicalError";
  }
}

const TAG = {
  null: 0x00,
  false: 0x01,
  true: 0x02,
  integer: 0x03,
  bigint: 0x04,
  string: 0x05,
  bytes: 0x06,
  array: 0x07,
  object: 0x08
} as const;

function u32Length(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) throw new CanonicalError("TOO_LONG");
  return u32be(length);
}

function encodeNumber(value: number): Uint8Array {
  if (!Number.isSafeInteger(value)) throw new CanonicalError("UNSAFE_NUMBER");
  const out = new Uint8Array(9);
  out[0] = TAG.integer;
  new DataView(out.buffer).setBigInt64(1, BigInt(value), false);
  return out;
}

function encodeBigInt(value: bigint): Uint8Array {
  const digits = utf8Encode(value.toString());
  return concatBytes(Uint8Array.of(TAG.bigint), u32Length(digits.length), digits);
}

function encodeString(value: string): Uint8Array {
  const bytes = utf8Encode(value);
  return concatBytes(Uint8Array.of(TAG.string), u32Length(bytes.length), bytes);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalBytes(value: CanonicalValue): Uint8Array {
  if (value === null) return Uint8Array.of(TAG.null);
  if (value === false) return Uint8Array.of(TAG.false);
  if (value === true) return Uint8Array.of(TAG.true);
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "bigint") return encodeBigInt(value);
  if (typeof value === "string") return encodeString(value);
  if (value instanceof Uint8Array) {
    return concatBytes(Uint8Array.of(TAG.bytes), u32Length(value.length), value);
  }
  if (Array.isArray(value)) {
    const parts: Uint8Array[] = [Uint8Array.of(TAG.array), u32Length(value.length)];
    for (const item of value) parts.push(canonicalBytes(item as CanonicalValue));
    return concatBytes(...parts);
  }
  if (typeof value === "object" && isPlainObject(value)) {
    const record = value as { readonly [key: string]: CanonicalValue };
    const keys = Object.keys(record).sort((a, b) => compareBytes(utf8Encode(a), utf8Encode(b)));
    const parts: Uint8Array[] = [Uint8Array.of(TAG.object), u32Length(keys.length)];
    for (const key of keys) {
      parts.push(encodeString(key), canonicalBytes(record[key] as CanonicalValue));
    }
    return concatBytes(...parts);
  }
  throw new CanonicalError("UNSUPPORTED_TYPE");
}

export function canonicalStateHash(value: CanonicalValue): string {
  return sha256Hex(concatBytes(ascii("LIFE1/STATE/v1"), Uint8Array.of(0), canonicalBytes(value)));
}
