import type { MoneyString } from "./money";
import type { VersionTuple } from "./versions";

export const SUPPORTED_RNG_SPEC_VERSIONS = ["1.0.0"] as const;

export function isSupportedRngSpecVersion(value: string): boolean {
  return (SUPPORTED_RNG_SPEC_VERSIONS as readonly string[]).includes(value);
}

export function commandMetadataIssue(input: {
  auto: boolean;
  policyId: string | null;
  optionIds: readonly string[];
  selectedOptionId: string | null;
}): string | null {
  if (input.auto) {
    if (input.policyId === null || input.policyId.length === 0) return "auto=true requires non-empty policyId";
    if (input.optionIds.length === 0) return "auto=true requires at least one option";
    if (input.selectedOptionId === null || !input.optionIds.includes(input.selectedOptionId)) {
      return "auto=true requires a selected option in optionIds";
    }
  } else if (input.policyId !== null) {
    return "auto=false requires policyId=null";
  }
  if (input.optionIds.length > 0) {
    if (input.selectedOptionId === null || !input.optionIds.includes(input.selectedOptionId)) {
      return "selectedOptionId is required when optionIds is non-empty";
    }
  } else if (input.selectedOptionId !== null) {
    return "selectedOptionId must be null when optionIds is empty";
  }
  return null;
}

export type StatKey = "health" | "happiness" | "knowledge" | "relationships";
export type ContentMode = "standard" | "guardian";
export type AutoChoicePolicy = "stop" | "safe";

export interface RulesetSettings {
  contentMode: ContentMode;
  autoChoicePolicy: AutoChoicePolicy;
}

/**
 * P1-B/Core only. The full ADR-003 Effect union (schedule, education,
 * relationship, job, health, migration, grantItem) is delivered with the
 * life-rules/content phase (P3), not by this core scaffold.
 */
export type CoreEffect =
  | { kind: "stat"; stat: StatKey; delta: number }
  | { kind: "money"; deltaPppMicro: MoneyString }
  | { kind: "flag"; key: string; value: boolean | number | string };

export interface EngineCommand {
  kind: "apply_effects";
  effects: readonly CoreEffect[];
}

export interface RngCursor {
  state: readonly [number, number, number, number];
  draws: number;
}

export interface CommandRecord {
  seq: number;
  commandId: string;
  effectiveYear: number;
  auto: boolean;
  policyId: string | null;
  optionIds: readonly string[];
  selectedOptionId: string | null;
  rngCursor: RngCursor;
  command: EngineCommand;
  stateHashAfter: string;
}

export interface CommandInput {
  commandId: string;
  effectiveYear: number;
  auto: boolean;
  policyId: string | null;
  optionIds: readonly string[];
  selectedOptionId: string | null;
  command: EngineCommand;
}

export interface PlaybackState {
  paused: boolean;
  speed: 1 | 2 | 4 | 8 | 12 | 16;
  progress: number;
  openCardIds: readonly string[];
}

export interface SaveStats {
  playSeconds: number;
  years: number;
  decisions: number;
  autos: number;
}

export interface SerializedGameState {
  schemaVersion: 1;
  year: number;
  stats: Record<StatKey, number>;
  resource: MoneyString;
  flags: Record<string, boolean | number | string>;
  rngDraws: number;
}

export interface SaveEnvelope {
  magic: "LIFE1";
  saveFormatVersion: 3;
  saveId: string;
  parentSaveId?: string;
  migratedFromVersions?: VersionTuple;
  revision: number;
  writerSessionId: string;
  engineVersion: string;
  rulesetVersion: string;
  rngSpecVersion: string;
  dataVersion: string;
  contentVersion: string;
  helpPackVersion: string;
  seed: string;
  seedHash: string;
  rulesetSettings: RulesetSettings;
  playback: PlaybackState;
  state: SerializedGameState;
  rng: [number, number, number, number];
  commandLog: readonly CommandRecord[];
  stateHash: string;
  createdAt: string;
  updatedAt: string;
  stats: SaveStats;
}
