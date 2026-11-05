import type { GoldenCase, GoldenResult } from "./types";
import { createInitialState } from "./engine";
import { recordCommands } from "./hash-chain";
import { parseRulesetSettings, parseVersionTuple } from "./validate";

export function runGoldenCase(input: GoldenCase): GoldenResult {
  const version = parseVersionTuple(input.version);
  const settings = parseRulesetSettings(input.rulesetSettings);
  const base = createInitialState(input.seed, settings, version.rngSpecVersion);
  const recorded = recordCommands(version, base, input.commands);
  return {
    id: input.id,
    stateHash: recorded.stateHash,
    commandHashes: recorded.hashes
  };
}
