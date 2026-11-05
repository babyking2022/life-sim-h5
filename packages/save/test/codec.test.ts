import { describe, expect, it } from "vitest";
import { gzip } from "pako";
import type { MoneyString, SaveEnvelope } from "@life-sim/contracts";
import {
  MAX_COMPRESSED_BYTES,
  MAX_EXPANDED_BYTES,
  SaveError,
  decodeSave,
  encodeSave,
  encodeSaveCompressed,
  validateSaveEnvelope
} from "../src";

const envelope: SaveEnvelope = {
  magic: "LIFE1",
  saveFormatVersion: 3,
  saveId: "save-1",
  revision: 1,
  writerSessionId: "writer-1",
  engineVersion: "0.1.0",
  rulesetVersion: "p1b-1",
  rngSpecVersion: "1.0.0",
  dataVersion: "2026.10",
  contentVersion: "p1b-content-0",
  helpPackVersion: "help-1",
  seed: "P1B-SAVE",
  seedHash: "a".repeat(64),
  rulesetSettings: { contentMode: "standard", autoChoicePolicy: "stop" },
  playback: { paused: false, speed: 4, progress: 0, openCardIds: [] },
  state: {
    schemaVersion: 1,
    year: 0,
    stats: { health: 500, happiness: 500, knowledge: 500, relationships: 500 },
    resource: "0" as MoneyString,
    flags: {},
    rngDraws: 0
  },
  rng: [1, 2, 3, 4],
  commandLog: [],
  stateHash: "0".repeat(64),
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  stats: { playSeconds: 0, years: 0, decisions: 0, autos: 0 }
};

function largeEnvelope(count: number): SaveEnvelope {
  const commandLog = Array.from({ length: count }, (_, index) => ({
    seq: index,
    commandId: `c${index}`,
    effectiveYear: 0,
    auto: false,
    policyId: null,
    optionIds: [],
    selectedOptionId: null,
    rngCursor: { state: [1, 2, 3, 4] as [number, number, number, number], draws: 0 },
    command: { kind: "apply_effects" as const, effects: [{ kind: "flag" as const, key: "same", value: true }] },
    stateHashAfter: "0".repeat(64)
  }));
  return { ...envelope, commandLog };
}


describe("save codec and capacity", () => {
  it("roundtrips raw and gzip JSON", () => {
    expect(decodeSave(encodeSave(envelope))).toEqual(envelope);
    expect(decodeSave(encodeSaveCompressed(envelope))).toEqual(envelope);
  });

  it("rejects non-gzip raw input over 20 MiB and gzip input over 5 MiB", () => {
    expect(() => decodeSave(new Uint8Array(MAX_EXPANDED_BYTES + 1))).toThrow(SaveError);
    const gzipOverLimit = new Uint8Array(MAX_COMPRESSED_BYTES + 1);
    gzipOverLimit[0] = 0x1f;
    gzipOverLimit[1] = 0x8b;
    expect(() => decodeSave(gzipOverLimit)).toThrow(SaveError);
  });

  it("rejects declared expanded ISIZE over 20 MiB before inflate", () => {
    const compressed = encodeSaveCompressed(envelope);
    const copy = new Uint8Array(compressed);
    new DataView(copy.buffer).setUint32(copy.length - 4, MAX_EXPANDED_BYTES + 1, true);
    expect(() => decodeSave(copy)).toThrow(SaveError);
  });

  it("stops a real 21 MiB inflate even when ISIZE is forged to 1", () => {
    const payload = new Uint8Array(MAX_EXPANDED_BYTES + 1024 * 1024);
    const compressed = gzip(payload);
    const forged = new Uint8Array(compressed);
    new DataView(forged.buffer).setUint32(forged.length - 4, 1, true);
    expect(() => decodeSave(forged)).toThrow(SaveError);
  }, 20_000);

  it("rejects corrupt and concatenated gzip as SaveError", () => {
    const compressed = encodeSaveCompressed(envelope);
    const corrupt = new Uint8Array(compressed);
    corrupt[20] = (corrupt[20] ?? 0) ^ 0xff;
    expect(() => decodeSave(corrupt)).toThrow(SaveError);
    const concatenated = new Uint8Array(compressed.length * 2);
    concatenated.set(compressed, 0);
    concatenated.set(compressed, compressed.length);
    expect(() => decodeSave(concatenated)).toThrow(SaveError);
  });

  it("rejects missing and extra contract fields", () => {
    expect(() => validateSaveEnvelope({ ...envelope, extra: true })).toThrow(SaveError);
    const missing = { ...envelope } as Record<string, unknown>;
    delete missing.playback;
    expect(() => validateSaveEnvelope(missing)).toThrow(SaveError);
    expect(() => validateSaveEnvelope({ ...envelope, locale: "zh-CN" })).toThrow(SaveError);
    expect(() => validateSaveEnvelope({ ...envelope, revision: 1.5 })).toThrow(SaveError);
    expect(() => validateSaveEnvelope({ ...envelope, stateHash: "0".repeat(63) })).toThrow(SaveError);
  });

  it("requires full command metadata", () => {
    const record = {
      seq: 0,
      commandId: "c1",
      effectiveYear: 0,
      auto: false,
      policyId: null,
      optionIds: ["o1"],
      selectedOptionId: "o1",
      rngCursor: { state: [1, 2, 3, 4], draws: 0 },
      command: { kind: "apply_effects", effects: [{ kind: "stat", stat: "health", delta: 1 }] },
      stateHashAfter: "0".repeat(64)
    };
    expect(() => validateSaveEnvelope({ ...envelope, commandLog: [record] })).not.toThrow();
    const missing = { ...record } as Record<string, unknown>;
    delete missing.rngCursor;
    expect(() => validateSaveEnvelope({ ...envelope, commandLog: [missing] })).toThrow(SaveError);
  });

  it("rejects malformed state, unsupported rng version, and effects", () => {
    expect(() => validateSaveEnvelope({ ...envelope, state: { ...envelope.state, resource: "1.0" } })).toThrow(SaveError);
    expect(() => validateSaveEnvelope({ ...envelope, state: { ...envelope.state, stats: { health: 1 } } })).toThrow(SaveError);
    expect(() => validateSaveEnvelope({ ...envelope, rngSpecVersion: "2.0.0" })).toThrow(SaveError);
    const commandLog = [
      {
        seq: 0,
        commandId: "c1",
        effectiveYear: 0,
        auto: false,
        policyId: null,
        optionIds: [],
        selectedOptionId: null,
        rngCursor: { state: [1, 2, 3, 4], draws: 0 },
        command: { kind: "apply_effects", effects: [{ kind: "unknown" }] },
        stateHashAfter: "0".repeat(64)
      }
    ];
    expect(() => validateSaveEnvelope({ ...envelope, commandLog })).toThrow(SaveError);
  });

  it("roundtrips 5-20 MiB raw and compressed valid saves", () => {
    const large = largeEnvelope(18_000);
    const raw = encodeSave(large);
    const rawBytes = new TextEncoder().encode(raw).length;
    expect(rawBytes).toBeGreaterThan(MAX_COMPRESSED_BYTES);
    expect(rawBytes).toBeLessThanOrEqual(MAX_EXPANDED_BYTES);
    expect(decodeSave(raw).commandLog).toHaveLength(18_000);
    expect(decodeSave(new TextEncoder().encode(raw)).commandLog).toHaveLength(18_000);
    const compressed = encodeSaveCompressed(large);
    expect(compressed.length).toBeLessThanOrEqual(MAX_COMPRESSED_BYTES);
    expect(decodeSave(compressed).commandLog).toHaveLength(18_000);
  }, 30_000);
});
