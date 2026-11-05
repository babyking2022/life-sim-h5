import { describe, expect, it } from "vitest";
import type { CommandInput, MoneyString, PlaybackState } from "@life-sim/contracts";
import {
  P1BError,
  ReplayDivergenceError,
  createInitialState,
  recordCommands
} from "@life-sim/engine";
import { createSave, encodeSave, loadSave, serializeState } from "../src";
import { decodeSave, encodeSaveCompressed, SaveError } from "@life-sim/save";

const version = {
  engineVersion: "0.1.0",
  rulesetVersion: "p1b-1",
  rngSpecVersion: "1.0.0",
  dataVersion: "2026.10",
  contentVersion: "p1b-content-0",
  saveFormatVersion: 3 as const
};
const settings = { contentMode: "standard" as const, autoChoicePolicy: "stop" as const };
const playback: PlaybackState = { paused: false, speed: 4, progress: 0, openCardIds: [] };
const stats = { playSeconds: 10, years: 2, decisions: 1, autos: 1 };

const commands: CommandInput[] = [
  {
    commandId: "c1",
    effectiveYear: 0,
    auto: false,
    policyId: null,
    optionIds: ["o1", "o2"],
    selectedOptionId: "o1",
    command: {
      kind: "apply_effects",
      effects: [
        { kind: "stat", stat: "health", delta: 5 },
        { kind: "money", deltaPppMicro: "2500" as MoneyString }
      ]
    }
  },
  {
    commandId: "c2",
    effectiveYear: 1,
    auto: true,
    policyId: "safe",
    optionIds: ["o2"],
    selectedOptionId: "o2",
    command: { kind: "apply_effects", effects: [{ kind: "flag", key: "ok", value: true }] }
  }
];

function make(overrides: Partial<Parameters<typeof createSave>[0]> = {}) {
  return createSave({
    version,
    saveId: "save-app-1",
    revision: 0,
    writerSessionId: "writer",
    helpPackVersion: "help-1",
    seed: "P1B-APP-1",
    settings,
    playback,
    commands,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    stats,
    ...overrides
  });
}

describe("application save coordination", () => {
  it("creates, encodes, decodes, and replays a save", () => {
    const envelope = make();
    const raw = encodeSave(envelope);
    const compressed = encodeSaveCompressed(envelope);
    const loadedRaw = loadSave(raw);
    const loadedCompressed = loadSave(compressed);
    expect(loadedRaw.state.year).toBe(2);
    expect(loadedRaw.state.stats.health).toBe(505);
    expect(loadedRaw.state.resourcePppMicro).toBe(2500n);
    expect(loadedRaw.state.flags).toEqual({ ok: true });
    expect(loadedCompressed.state).toEqual(loadedRaw.state);
    expect(loadedRaw.envelope.stateHash).toBe(envelope.stateHash);
    expect(loadedRaw.envelope.magic).toBe("LIFE1");
  });

  it("does not carry display preferences in the formal save", () => {
    const envelope = make();
    expect((envelope as unknown as Record<string, unknown>).locale).toBeUndefined();
    expect((envelope as unknown as Record<string, unknown>).theme).toBeUndefined();
    expect((envelope as unknown as Record<string, unknown>).volume).toBeUndefined();
  });

  it("changes hash with metadata, settings, version, and RNG state", () => {
    const first = make();
    const autoChanged = make({ commands: [commands[0]!, { ...commands[1]!, auto: false, policyId: null }] });
    const optionChanged = make({ commands: [{ ...commands[0]!, selectedOptionId: "o2" }, commands[1]!] });
    const settingsChanged = make({ settings: { contentMode: "guardian", autoChoicePolicy: "safe" } });
    const versionChanged = make({ version: { ...version, contentVersion: "other" } });
    expect(autoChanged.stateHash).not.toBe(first.stateHash);
    expect(optionChanged.stateHash).not.toBe(first.stateHash);
    expect(settingsChanged.stateHash).not.toBe(first.stateHash);
    expect(versionChanged.stateHash).not.toBe(first.stateHash);

    const base = createInitialState("P1B-APP-RNG", settings, "1.0.0");
    const changedRng = { ...base, rng: [(base.rng[0] + 1) >>> 0, base.rng[1], base.rng[2], base.rng[3]] as const };
    const original = recordCommands(version, base, commands);
    const changed = recordCommands(version, changedRng, commands);
    expect(changed.stateHash).not.toBe(original.stateHash);
  });

  it("rejects effectiveYear before replay and does not report DIVERGED_AT_YEAR", () => {
    const envelope = make();
    const broken = JSON.parse(encodeSave(envelope)) as { commandLog: Array<{ effectiveYear: number }> };
    broken.commandLog[0]!.effectiveYear = 999;
    expect(() => loadSave(JSON.stringify(broken))).toThrow(P1BError);
    try {
      loadSave(JSON.stringify(broken));
    } catch (error) {
      expect(error).toBeInstanceOf(P1BError);
      expect((error as P1BError).message).toContain("effectiveYear");
    }
  });

  it("reports final hash divergence as DIVERGED_AT_YEAR", () => {
    const envelope = make();
    const broken = JSON.parse(encodeSave(envelope)) as { stateHash: string };
    broken.stateHash = "f".repeat(64);
    try {
      loadSave(JSON.stringify(broken));
      throw new Error("expected divergence");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayDivergenceError);
      expect((error as ReplayDivergenceError).code).toBe("DIVERGED_AT_YEAR");
    }
  });

  it("serializes current state with seed/rng/settings at envelope top level", () => {
    const state = createInitialState("P1B-APP-2", settings, "1.0.0");
    expect(serializeState(state).year).toBe(0);
    const envelope = decodeSave(encodeSave(make()));
    expect(envelope.seed).toBe("P1B-APP-1");
    expect(envelope.rng).toHaveLength(4);
    expect(envelope.rulesetSettings).toEqual(settings);
  });

  it("treats reordered flags as the same current state", () => {
    const flagCommands: CommandInput[] = [
      {
        ...commands[0]!,
        command: {
          kind: "apply_effects",
          effects: [
            { kind: "flag", key: "a", value: true },
            { kind: "flag", key: "b", value: true }
          ]
        }
      }
    ];
    const envelope = make({ commands: flagCommands });
    const parsed = JSON.parse(encodeSave(envelope)) as { state: { flags: Record<string, boolean> } };
    parsed.state.flags = { b: true, a: true };
    expect(loadSave(JSON.stringify(parsed)).state.flags).toEqual({ a: true, b: true });
  });

  it("reports a real current-state mismatch as E_SAVE_STATE_MISMATCH", () => {
    const parsed = JSON.parse(encodeSave(make())) as { state: { year: number } };
    parsed.state.year = 99;
    try {
      loadSave(JSON.stringify(parsed));
      throw new Error("expected state mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(SaveError);
      expect((error as SaveError).code).toBe("E_SAVE_STATE_MISMATCH");
    }
  });

  it("reports a seedHash mismatch as E_SAVE_SEED_MISMATCH", () => {
    const parsed = JSON.parse(encodeSave(make())) as { seedHash: string };
    parsed.seedHash = "f".repeat(64);
    try {
      loadSave(JSON.stringify(parsed));
      throw new Error("expected seed mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(SaveError);
      expect((error as SaveError).code).toBe("E_SAVE_SEED_MISMATCH");
    }
  });

  it("rejects a forged unsupported rngSpecVersion with E_SAVE_UNSUPPORTED_VERSION", () => {
    const broken = JSON.parse(encodeSave(make())) as { rngSpecVersion: string };
    broken.rngSpecVersion = "2.0.0";
    try {
      loadSave(JSON.stringify(broken));
      throw new Error("expected unsupported version");
    } catch (error) {
      expect(error).toBeInstanceOf(SaveError);
      expect((error as SaveError).code).toBe("E_SAVE_UNSUPPORTED_VERSION");
    }
  });
});
