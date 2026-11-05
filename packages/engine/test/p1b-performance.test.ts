import { describe, expect, it } from "vitest";
import type { CommandInput, MoneyString, VersionTuple } from "@life-sim/contracts";
import { assertReplay, createInitialState, recordCommands } from "../src";

const version: VersionTuple = {
  engineVersion: "0.1.0",
  rulesetVersion: "p1b-1",
  rngSpecVersion: "1.0.0",
  dataVersion: "2026.10",
  contentVersion: "p1b-perf",
  saveFormatVersion: 3
};

describe("P1-B.2 10,000 command linearity", () => {
  it("records and replays 10,000 commands without full-history rescan", () => {
    const base = createInitialState("P1B-PERF", { contentMode: "standard", autoChoicePolicy: "stop" }, "1.0.0");
    const commands: CommandInput[] = Array.from({ length: 10_000 }, (_, index) => ({
      commandId: `perf-${index}`,
      effectiveYear: index,
      auto: index % 2 === 0,
      policyId: index % 2 === 0 ? "safe" : null,
      optionIds: ["o1", "o2"],
      selectedOptionId: index % 3 === 0 ? "o2" : "o1",
      command: {
        kind: "apply_effects",
        effects: [
          { kind: "stat", stat: "health", delta: index % 2 === 0 ? 1 : -1 },
          { kind: "money", deltaPppMicro: index % 2 === 0 ? "1" as MoneyString : "-1" as MoneyString }
        ]
      }
    }));
    const recordStart = Date.now();
    const recorded = recordCommands(version, base, commands);
    const recordMs = Date.now() - recordStart;
    expect(recorded.records).toHaveLength(10_000);
    expect(recorded.hashes).toHaveLength(10_000);
    expect(new Set(recorded.hashes).size).toBe(10_000);
    const replayStart = Date.now();
    const replayed = assertReplay(version, base, recorded.records);
    const replayMs = Date.now() - replayStart;
    expect(replayed.state.year).toBe(10_000);
    expect(replayed.finalHash).toBe(recorded.stateHash);
    console.log(`P1B-PERF record=${recordMs}ms replay=${replayMs}ms commands=10000`);
    expect(recordMs).toBeLessThan(30_000);
    expect(replayMs).toBeLessThan(30_000);
  }, 60_000);
});
