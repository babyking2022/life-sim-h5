import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGoldenCase } from "../packages/engine/src/p1b/golden";
import type { CommandInput, GoldenCase } from "../packages/engine/src/p1b/types";

const version = (index: number) => ({
  engineVersion: `0.1.${index % 3}`,
  rulesetVersion: "p1b-1",
  rngSpecVersion: "1.0.0",
  dataVersion: "2026.10",
  contentVersion: `p1b-content-${index % 4}`,
  saveFormatVersion: 3 as const
});


const commands = (id: string, index: number): CommandInput[] => {
  const first: CommandInput = {
    commandId: `${id}-1`,
    effectiveYear: 0,
    auto: index % 2 === 0,
    policyId: index % 2 === 0 ? "safe" : null,
    optionIds: ["o1", "o2"],
    selectedOptionId: index % 3 === 0 ? "o2" : "o1",
    command: {
      kind: "apply_effects",
      effects: [
        { kind: "stat", stat: "health", delta: (index % 7) - 3 },
        { kind: "stat", stat: "happiness", delta: (index % 5) - 2 }
      ]
    }
  };
  const second: CommandInput = {
    commandId: `${id}-2`,
    effectiveYear: 1,
    auto: false,
    policyId: null,
    optionIds: [],
    selectedOptionId: null,
    command: {
      kind: "apply_effects",
      effects: [
        { kind: "money", deltaPppMicro: (index % 2 === 0 ? (index + 1) * 1000 : -((index + 1) * 1000)).toString() },
        { kind: "flag", key: `flag_${index % 7}`, value: index % 3 === 0 }
      ]
    }
  };
  if (index % 3 !== 0) return [first, second];
  return [
    first,
    second,
    {
      commandId: `${id}-3`,
      effectiveYear: 2,
      auto: true,
      policyId: "safe",
      optionIds: ["o1"],
      selectedOptionId: "o1",
      command: { kind: "apply_effects", effects: [{ kind: "stat", stat: "knowledge", delta: 2 }] }
    }
  ];
};

const cases = Array.from({ length: 100 }, (_, offset) => {
  const index = offset + 1;
  const id = `g${String(index).padStart(3, "0")}`;
  const input: GoldenCase = {
    id,
    version: version(index),
    seed: `P1B-GOLDEN-${String(index).padStart(3, "0")}`,
    rulesetSettings: {
      contentMode: index % 2 === 0 ? "standard" : "guardian",
      autoChoicePolicy: index % 3 === 0 ? "safe" : "stop"
    },
    commands: commands(id, index)
  };
  const result = runGoldenCase(input);
  return {
    ...input,
    expectedHash: result.stateHash,
    expectedCommandHashes: result.commandHashes
  };
});

const dir = join(process.cwd(), "packages", "engine", "test", "fixtures");
mkdirSync(dir, { recursive: true });
const target = join(dir, "p1b-golden.json");
writeFileSync(target, `${JSON.stringify({ generator: "p1b-golden-v3", count: cases.length, cases }, null, 2)}\n`, "utf8");
console.log(`P1B-GOLDEN-WRITTEN ${target} ${cases.length}`);
