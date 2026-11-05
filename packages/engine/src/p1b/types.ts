import type { CommandInput, RulesetSettings, VersionTuple } from "@life-sim/contracts";
import type { PppMicro } from "../money";
import type { RngState } from "../rng/seed";

export interface EngineState {
  schemaVersion: 1;
  seed: string;
  year: number;
  stats: Readonly<Record<"health" | "happiness" | "knowledge" | "relationships", number>>;
  resourcePppMicro: PppMicro;
  flags: Readonly<Record<string, boolean | number | string>>;
  rng: RngState;
  rngDraws: number;
  rulesetSettings: RulesetSettings;
}

export interface GoldenCase {
  id: string;
  version: VersionTuple;
  seed: string;
  rulesetSettings: RulesetSettings;
  commands: readonly CommandInput[];
}

export interface GoldenResult {
  id: string;
  stateHash: string;
  commandHashes: readonly string[];
}
