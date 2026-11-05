import {
  commandMetadataIssue,
  isMoneyString,
  isSupportedRngSpecVersion,
  type CommandInput,
  type CommandRecord,
  type CoreEffect,
  type EngineCommand,
  type RngCursor,
  type RulesetSettings,
  type StatKey,
  type VersionTuple
} from "@life-sim/contracts";
import { asPppMicro } from "../money";
import { normalizeSeed } from "../rng/seed";
import { Xoshiro128StarStar } from "../rng/xoshiro128";
import type { EngineState } from "./types";
import { P1BError } from "./errors";

const MAX_YEAR = 1_000_000;
const MAX_STAT = 1000;
const MAX_FLAGS = 64;
const MAX_DRAWS = 1_000_000;
const MAX_OPTIONS = 16;
const MAX_EFFECTS = 64;
const STAT_KEYS = ["health", "happiness", "knowledge", "relationships"] as const;
const EFFECT_KEYS: Record<CoreEffect["kind"], readonly string[]> = {
  stat: ["kind", "stat", "delta"],
  money: ["kind", "deltaPppMicro"],
  flag: ["kind", "key", "value"]
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fail(code: ConstructorParameters<typeof P1BError>[0], message: string): never {
  throw new P1BError(code, message);
}

export function exactKeys(value: unknown, keys: readonly string[], code: ConstructorParameters<typeof P1BError>[0], label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(code, `${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail(code, `${label} has unknown or missing fields`);
  }
  return value;
}

export function safeInt(value: unknown, min: number, max: number, code: ConstructorParameters<typeof P1BError>[0], label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(code, `${label} must be a safe integer in [${min}, ${max}]`);
  }
  return value;
}

export function nonEmptyString(value: unknown, code: ConstructorParameters<typeof P1BError>[0], label: string, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(code, `${label} must be a string`);
  return value;
}

export function parseRulesetSettings(value: unknown): RulesetSettings {
  const record = exactKeys(value, ["contentMode", "autoChoicePolicy"], "INVALID_STATE", "rulesetSettings");
  if (record.contentMode !== "standard" && record.contentMode !== "guardian") fail("INVALID_STATE", "bad contentMode");
  if (record.autoChoicePolicy !== "stop" && record.autoChoicePolicy !== "safe") fail("INVALID_STATE", "bad autoChoicePolicy");
  return { contentMode: record.contentMode, autoChoicePolicy: record.autoChoicePolicy };
}

export function parseVersionTuple(value: unknown): VersionTuple {
  const record = exactKeys(
    value,
    ["engineVersion", "rulesetVersion", "rngSpecVersion", "dataVersion", "contentVersion", "saveFormatVersion"],
    "INVALID_VERSION",
    "version"
  );
  const rngSpecVersion = nonEmptyString(record.rngSpecVersion, "INVALID_VERSION", "rngSpecVersion", 32);
  if (!isSupportedRngSpecVersion(rngSpecVersion)) {
    fail("UNSUPPORTED_RNG_SPEC", `unsupported rngSpecVersion: ${rngSpecVersion}`);
  }
  return {
    engineVersion: nonEmptyString(record.engineVersion, "INVALID_VERSION", "engineVersion", 32),
    rulesetVersion: nonEmptyString(record.rulesetVersion, "INVALID_VERSION", "rulesetVersion", 32),
    rngSpecVersion,
    dataVersion: nonEmptyString(record.dataVersion, "INVALID_VERSION", "dataVersion", 32),
    contentVersion: nonEmptyString(record.contentVersion, "INVALID_VERSION", "contentVersion", 32),
    saveFormatVersion: safeInt(record.saveFormatVersion, 3, 3, "INVALID_VERSION", "saveFormatVersion")
  };
}

export function parseRngState(value: unknown): [number, number, number, number] {
  try {
    return [...new Xoshiro128StarStar(value).state] as [number, number, number, number];
  } catch {
    return fail("INVALID_STATE", "rng state must be exactly four uint32");
  }
}

export function parseStats(value: unknown): Record<StatKey, number> {
  const record = exactKeys(value, STAT_KEYS, "INVALID_STATE", "stats");
  const stats = {} as Record<StatKey, number>;
  for (const key of STAT_KEYS) stats[key] = safeInt(record[key], 0, MAX_STAT, "INVALID_STATE", key);
  return stats;
}

export function parseFlags(value: unknown): Record<string, boolean | number | string> {
  if (!isRecord(value)) fail("INVALID_STATE", "flags must be an object");
  const keys = Object.keys(value);
  if (keys.length > MAX_FLAGS) fail("INVALID_STATE", "too many flags");
  const flags: Record<string, boolean | number | string> = {};
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) fail("INVALID_STATE", `bad flag key: ${key}`);
    const item = value[key];
    if (typeof item === "boolean" || typeof item === "string") {
      if (typeof item === "string" && (item.length === 0 || item.length > 64)) fail("INVALID_STATE", "bad flag string");
      flags[key] = item;
    } else if (typeof item === "number" && Number.isSafeInteger(item) && Math.abs(item) <= 1_000_000_000) {
      flags[key] = item;
    } else {
      fail("INVALID_STATE", `bad flag value: ${key}`);
    }
  }
  return flags;
}

export function parseEngineState(value: unknown): EngineState {
  const record = exactKeys(
    value,
    ["schemaVersion", "seed", "year", "stats", "resourcePppMicro", "flags", "rng", "rngDraws", "rulesetSettings"],
    "INVALID_STATE",
    "state"
  );
  if (record.schemaVersion !== 1) fail("INVALID_STATE", "schemaVersion must be 1");
  let seed: string;
  try {
    seed = normalizeSeed(record.seed as string);
  } catch {
    return fail("INVALID_STATE", "bad seed");
  }
  if (typeof record.resourcePppMicro !== "bigint") fail("INVALID_STATE", "resource must be bigint");
  return {
    schemaVersion: 1,
    seed,
    year: safeInt(record.year, 0, MAX_YEAR, "INVALID_STATE", "year"),
    stats: parseStats(record.stats),
    resourcePppMicro: asPppMicro(record.resourcePppMicro),
    flags: parseFlags(record.flags),
    rng: parseRngState(record.rng),
    rngDraws: safeInt(record.rngDraws, 0, MAX_DRAWS, "INVALID_STATE", "rngDraws"),
    rulesetSettings: parseRulesetSettings(record.rulesetSettings)
  };
}

export function parseEffect(value: unknown): CoreEffect {
  if (!isRecord(value)) fail("INVALID_EFFECT", "effect must be an object");
  const kind = value.kind;
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(EFFECT_KEYS, kind)) {
    fail("INVALID_EFFECT", "unknown effect kind");
  }
  const record = exactKeys(value, EFFECT_KEYS[kind as CoreEffect["kind"]]!, "INVALID_EFFECT", "effect");
  switch (kind as CoreEffect["kind"]) {
    case "stat":
      if (!STAT_KEYS.includes(record.stat as StatKey)) fail("INVALID_EFFECT", "bad stat key");
      return {
        kind: "stat",
        stat: record.stat as StatKey,
        delta: safeInt(record.delta, -100, 100, "INVALID_EFFECT", "delta")
      };
    case "money":
      if (!isMoneyString(record.deltaPppMicro)) fail("INVALID_EFFECT", "money delta must be MoneyString");
      return { kind: "money", deltaPppMicro: record.deltaPppMicro };
    case "flag":
      if (typeof record.key !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(record.key)) fail("INVALID_EFFECT", "bad flag key");
      if (typeof record.value === "boolean") return { kind: "flag", key: record.key, value: record.value };
      if (typeof record.value === "string" && record.value.length > 0 && record.value.length <= 64) {
        return { kind: "flag", key: record.key, value: record.value };
      }
      if (typeof record.value === "number" && Number.isSafeInteger(record.value) && Math.abs(record.value) <= 1_000_000_000) {
        return { kind: "flag", key: record.key, value: record.value };
      }
      return fail("INVALID_EFFECT", "bad flag value");
  }
}

export function parseCommand(value: unknown): EngineCommand {
  const record = exactKeys(value, ["kind", "effects"], "INVALID_COMMAND", "command");
  if (record.kind !== "apply_effects") fail("INVALID_COMMAND", "unknown command kind");
  if (!Array.isArray(record.effects) || record.effects.length < 1 || record.effects.length > MAX_EFFECTS) {
    fail("INVALID_COMMAND", "effects must be 1..64 items");
  }
  return { kind: "apply_effects", effects: record.effects.map(parseEffect) };
}

export function parseRngCursor(value: unknown): RngCursor {
  const record = exactKeys(value, ["state", "draws"], "INVALID_COMMAND_LOG", "rngCursor");
  return { state: parseRngState(record.state), draws: safeInt(record.draws, 0, MAX_DRAWS, "INVALID_COMMAND_LOG", "rngCursor.draws") };
}

export function parseOptionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) fail("INVALID_COMMAND_LOG", "optionIds must be at most 16");
  const ids = value.map((item) => nonEmptyString(item, "INVALID_COMMAND_LOG", "optionId", 64));
  if (new Set(ids).size !== ids.length) fail("INVALID_COMMAND_LOG", "optionIds must be unique");
  return ids;
}

export function parseCommandInput(value: unknown): CommandInput {
  const record = exactKeys(
    value,
    ["commandId", "effectiveYear", "auto", "policyId", "optionIds", "selectedOptionId", "command"],
    "INVALID_COMMAND",
    "command input"
  );
  const commandId = nonEmptyString(record.commandId, "INVALID_COMMAND", "commandId", 64);
  if (!/^[A-Za-z0-9._:-]+$/.test(commandId)) fail("INVALID_COMMAND", "bad commandId");
  const optionIds = parseOptionIds(record.optionIds);
  const selected = record.selectedOptionId;
  if (selected !== null && (typeof selected !== "string" || !optionIds.includes(selected))) {
    fail("INVALID_COMMAND", "selectedOptionId must be null or in optionIds");
  }
  if (typeof record.auto !== "boolean") fail("INVALID_COMMAND", "auto must be boolean");
  if (record.policyId !== null && (typeof record.policyId !== "string" || record.policyId.length > 64)) {
    fail("INVALID_COMMAND", "policyId must be null or string");
  }
  const issue = commandMetadataIssue({
    auto: record.auto,
    policyId: record.policyId,
    optionIds,
    selectedOptionId: selected
  });
  if (issue) fail("INVALID_COMMAND", issue);
  return {
    commandId,
    effectiveYear: safeInt(record.effectiveYear, 0, MAX_YEAR, "INVALID_COMMAND", "effectiveYear"),
    auto: record.auto,
    policyId: record.policyId,
    optionIds,
    selectedOptionId: selected,
    command: parseCommand(record.command)
  };
}

export function parseCommandRecord(value: unknown): CommandRecord {
  const record = exactKeys(
    value,
    ["seq", "commandId", "effectiveYear", "auto", "policyId", "optionIds", "selectedOptionId", "rngCursor", "command", "stateHashAfter"],
    "INVALID_COMMAND_LOG",
    "command record"
  );
  const hash = record.stateHashAfter;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) fail("INVALID_COMMAND_LOG", "bad stateHashAfter");
  const input = parseCommandInput({
    commandId: record.commandId,
    effectiveYear: record.effectiveYear,
    auto: record.auto,
    policyId: record.policyId,
    optionIds: record.optionIds,
    selectedOptionId: record.selectedOptionId,
    command: record.command
  });
  return {
    seq: safeInt(record.seq, 0, 1_000_000, "INVALID_COMMAND_LOG", "seq"),
    ...input,
    rngCursor: parseRngCursor(record.rngCursor),
    stateHashAfter: hash
  };
}
