import { gzip, Inflate } from "pako";
import type { SaveEnvelope } from "@life-sim/contracts";
import { MAX_COMPRESSED_BYTES, MAX_EXPANDED_BYTES, SaveError, failSave } from "./errors";
import { validateSaveEnvelope } from "./validate";

function gzipSize(bytes: Uint8Array): number {
  if (bytes.length < 4) failSave("E_SAVE_INVALID", "truncated gzip");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, true);
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : input;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Inflate with an output cap enforced while bytes are produced. */
export function inflateBounded(input: Uint8Array): Uint8Array {
  const inflator = new Inflate({ chunkSize: 64 * 1024 });
  let total = 0;
  const chunks: Uint8Array[] = [];
  inflator.onData = (chunk) => {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    total += bytes.length;
    if (total > MAX_EXPANDED_BYTES) {
      throw new SaveError("E_SAVE_TOO_LARGE", "expanded save exceeds 20 MiB");
    }
    chunks.push(bytes);
  };
  try {
    inflator.push(input, true);
  } catch (error) {
    if (error instanceof SaveError) throw error;
    failSave("E_SAVE_INVALID", "corrupt gzip");
  }
  if (inflator.err !== 0) failSave("E_SAVE_INVALID", "corrupt gzip");
  const strm = (inflator as unknown as { strm?: { avail_in?: number } }).strm;
  if (strm && typeof strm.avail_in === "number" && strm.avail_in > 0) {
    failSave("E_SAVE_INVALID", "concatenated or trailing gzip members");
  }
  if (total > MAX_EXPANDED_BYTES) failSave("E_SAVE_TOO_LARGE", "expanded save exceeds 20 MiB");
  return concat(chunks, total);
}

export function encodeSave(envelope: SaveEnvelope): string {
  const raw = JSON.stringify(envelope);
  if (new TextEncoder().encode(raw).length > MAX_EXPANDED_BYTES) {
    throw new SaveError("E_SAVE_TOO_LARGE", "expanded save exceeds 20 MiB");
  }
  const normalized = JSON.stringify(validateSaveEnvelope(envelope));
  if (new TextEncoder().encode(normalized).length > MAX_EXPANDED_BYTES) {
    throw new SaveError("E_SAVE_TOO_LARGE", "expanded save exceeds 20 MiB");
  }
  return normalized;
}

export function encodeSaveCompressed(envelope: SaveEnvelope): Uint8Array {
  const raw = encodeSave(envelope);
  const compressed = gzip(raw);
  if (compressed.length > MAX_COMPRESSED_BYTES) {
    throw new SaveError("E_SAVE_TOO_LARGE", "compressed save exceeds 5 MiB");
  }
  return compressed;
}

export function decodeSave(input: string | Uint8Array): SaveEnvelope {
  const compressedBytes = toBytes(input);
  let bytes = compressedBytes;
  if (isGzip(compressedBytes)) {
    if (compressedBytes.length > MAX_COMPRESSED_BYTES) {
      failSave("E_SAVE_TOO_LARGE", "compressed input exceeds 5 MiB");
    }
    const declared = gzipSize(compressedBytes);
    if (declared > MAX_EXPANDED_BYTES) failSave("E_SAVE_TOO_LARGE", "expanded save exceeds 20 MiB");
    bytes = inflateBounded(compressedBytes);
  } else if (compressedBytes.length > MAX_EXPANDED_BYTES) {
    failSave("E_SAVE_TOO_LARGE", "raw input exceeds 20 MiB");
  }
  if (bytes.length > MAX_EXPANDED_BYTES) failSave("E_SAVE_TOO_LARGE", "expanded save exceeds 20 MiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    failSave("E_SAVE_INVALID", "invalid JSON");
  }
  return validateSaveEnvelope(parsed);
}
