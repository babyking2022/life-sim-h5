export type VersionTuple = Readonly<{
  engineVersion: string;
  rulesetVersion: string;
  rngSpecVersion: string;
  dataVersion: string;
  contentVersion: string;
  saveFormatVersion: number;
}>;

export const CURRENT_RNG_SPEC_VERSION = "1.0.0" as const;
export type RngSpecVersion = typeof CURRENT_RNG_SPEC_VERSION;

export const RNG_DOMAINS = [
  "birth",
  "family",
  "events",
  "decisions",
  "health",
  "finance",
  "relationships",
  "migration",
  "names",
  "cosmetic"
] as const;

export type RngDomain = (typeof RNG_DOMAINS)[number];
