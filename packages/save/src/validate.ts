import {
  commandMetadataIssue,
  isMoneyString,
  isSupportedRngSpecVersion,
  type CommandRecord,
  type CoreEffect,
  type EngineCommand,
  type PlaybackState,
  type SaveEnvelope,
  type SaveStats,
  type SerializedGameState,
  type VersionTuple
} from "@life-sim/contracts";
import { failSave } from "./errors";

const MAX_YEAR = 1_000_000;
const MAX_EFFECTS = 64;
const MAX_OPTIONS = 16;
const STAT_KEYS = ["health", "happiness", "knowledge", "relationships"] as const;
const EFFECT_KEYS: Record<CoreEffect["kind"], readonly string[]> = {
  stat: ["kind", "stat", "delta"],
  money: ["kind", "deltaPppMicro"],
  flag: ["kind", "key", "value"]
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = [], label = "object"): Record<string, unknown> {
  if (!isRecord(value)) failSave("E_SAVE_INVALID", `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) {
    failSave("E_SAVE_INVALID", `${label} has unknown or missing fields`);
  }
  return value;
}

function safeInt(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    failSave("E_SAVE_INVALID", `${label} must be a safe integer in [${min}, ${max}]`);
  }
  return value;
}

function text(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) failSave("E_SAVE_INVALID", `${label} must be a string`);
  return value;
}

function rngState(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) failSave("E_SAVE_INVALID", "rng must be four uint32");
  return value.map((word) => safeInt(word, 0, 0xffffffff, "rng word")) as [number, number, number, number];
}

function versionShape(value: unknown): VersionTuple {
  const record = exact(value, ["engineVersion", "rulesetVersion", "rngSpecVersion", "dataVersion", "contentVersion", "saveFormatVersion"], [], "version");
  return {
    engineVersion: text(record.engineVersion, "engineVersion", 32),
    rulesetVersion: text(record.rulesetVersion, "rulesetVersion", 32),
    rngSpecVersion: text(record.rngSpecVersion, "rngSpecVersion", 32),
    dataVersion: text(record.dataVersion, "dataVersion", 32),
    contentVersion: text(record.contentVersion, "contentVersion", 32),
    saveFormatVersion: safeInt(record.saveFormatVersion, 3, 3, "saveFormatVersion")
  };
}

function version(value: unknown): VersionTuple {
  const parsed = versionShape(value);
  if (!isSupportedRngSpecVersion(parsed.rngSpecVersion)) {
    failSave("E_SAVE_UNSUPPORTED_VERSION", `unsupported rngSpecVersion: ${parsed.rngSpecVersion}`);
  }
  return parsed;
}

function settings(value: unknown) {
  const record = exact(value, ["contentMode", "autoChoicePolicy"], [], "rulesetSettings");
  if (record.contentMode !== "standard" && record.contentMode !== "guardian") failSave("E_SAVE_INVALID", "bad contentMode");
  if (record.autoChoicePolicy !== "stop" && record.autoChoicePolicy !== "safe") failSave("E_SAVE_INVALID", "bad autoChoicePolicy");
  return { contentMode: record.contentMode, autoChoicePolicy: record.autoChoicePolicy } as const;
}

function stats(value: unknown) {
  const record = exact(value, STAT_KEYS, [], "stats");
  return Object.fromEntries(STAT_KEYS.map((key) => [key, safeInt(record[key], 0, 1000, key)])) as Record<(typeof STAT_KEYS)[number], number>;
}

function flags(value: unknown) {
  if (!isRecord(value)) failSave("E_SAVE_INVALID", "flags must be object");
  const keys = Object.keys(value);
  if (keys.length > 64) failSave("E_SAVE_INVALID", "too many flags");
  const result: Record<string, boolean | number | string> = {};
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) failSave("E_SAVE_INVALID", "bad flag key");
    const item = value[key];
    if (typeof item === "boolean") result[key] = item;
    else if (typeof item === "string" && item.length > 0 && item.length <= 64) result[key] = item;
    else if (typeof item === "number" && Number.isSafeInteger(item) && Math.abs(item) <= 1_000_000_000) result[key] = item;
    else failSave("E_SAVE_INVALID", "bad flag value");
  }
  return result;
}

function gameState(value: unknown): SerializedGameState {
  const record = exact(value, ["schemaVersion", "year", "stats", "resource", "flags", "rngDraws"], [], "state");
  if (record.schemaVersion !== 1) failSave("E_SAVE_INVALID", "schemaVersion must be 1");
  if (!isMoneyString(record.resource)) failSave("E_SAVE_INVALID", "resource must be MoneyString");
  return {
    schemaVersion: 1,
    year: safeInt(record.year, 0, MAX_YEAR, "year"),
    stats: stats(record.stats),
    resource: record.resource,
    flags: flags(record.flags),
    rngDraws: safeInt(record.rngDraws, 0, 1_000_000, "rngDraws")
  };
}

function coreEffect(value: unknown): CoreEffect {
  if (!isRecord(value)) failSave("E_SAVE_INVALID", "effect must be object");
  const kind = value.kind;
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(EFFECT_KEYS, kind)) {
    failSave("E_SAVE_INVALID", "unknown effect kind");
  }
  const record = exact(value, EFFECT_KEYS[kind as CoreEffect["kind"]], [], "effect");
  switch (kind as CoreEffect["kind"]) {
    case "stat":
      if (!STAT_KEYS.includes(record.stat as (typeof STAT_KEYS)[number])) failSave("E_SAVE_INVALID", "bad stat");
      return { kind: "stat", stat: record.stat as (typeof STAT_KEYS)[number], delta: safeInt(record.delta, -100, 100, "delta") };
    case "money":
      if (!isMoneyString(record.deltaPppMicro)) failSave("E_SAVE_INVALID", "bad money delta");
      return { kind: "money", deltaPppMicro: record.deltaPppMicro };
    case "flag":
      if (typeof record.key !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(record.key)) failSave("E_SAVE_INVALID", "bad flag key");
      if (typeof record.value === "boolean") return { kind: "flag", key: record.key, value: record.value };
      if (typeof record.value === "string" && record.value.length > 0 && record.value.length <= 64) return { kind: "flag", key: record.key, value: record.value };
      if (typeof record.value === "number" && Number.isSafeInteger(record.value) && Math.abs(record.value) <= 1_000_000_000) return { kind: "flag", key: record.key, value: record.value };
      return failSave("E_SAVE_INVALID", "bad flag value");
  }
}

function command(value: unknown): EngineCommand {
  const record = exact(value, ["kind", "effects"], [], "command");
  if (record.kind !== "apply_effects") failSave("E_SAVE_INVALID", "bad command kind");
  if (!Array.isArray(record.effects) || record.effects.length < 1 || record.effects.length > MAX_EFFECTS) failSave("E_SAVE_INVALID", "bad effects");
  return { kind: "apply_effects", effects: record.effects.map(coreEffect) };
}

function commandRecord(value: unknown): CommandRecord {
  const record = exact(
    value,
    ["seq", "commandId", "effectiveYear", "auto", "policyId", "optionIds", "selectedOptionId", "rngCursor", "command", "stateHashAfter"],
    [],
    "command record"
  );
  const commandId = text(record.commandId, "commandId", 64);
  if (!/^[A-Za-z0-9._:-]+$/.test(commandId)) failSave("E_SAVE_INVALID", "bad commandId");
  if (!Array.isArray(record.optionIds) || record.optionIds.length > MAX_OPTIONS) failSave("E_SAVE_INVALID", "bad optionIds");
  const optionIds = record.optionIds.map((item) => text(item, "optionId", 64));
  if (new Set(optionIds).size !== optionIds.length) failSave("E_SAVE_INVALID", "duplicate optionId");
  const selected = record.selectedOptionId;
  if (selected !== null && (typeof selected !== "string" || !optionIds.includes(selected))) failSave("E_SAVE_INVALID", "bad selectedOptionId");
  if (typeof record.auto !== "boolean") failSave("E_SAVE_INVALID", "auto must be boolean");
  if (record.policyId !== null && (typeof record.policyId !== "string" || record.policyId.length > 64)) failSave("E_SAVE_INVALID", "bad policyId");
  const issue = commandMetadataIssue({ auto: record.auto, policyId: record.policyId, optionIds, selectedOptionId: selected });
  if (issue) failSave("E_SAVE_INVALID", issue);
  if (typeof record.stateHashAfter !== "string" || !/^[0-9a-f]{64}$/.test(record.stateHashAfter)) failSave("E_SAVE_INVALID", "bad stateHashAfter");
  const cursor = exact(record.rngCursor, ["state", "draws"], [], "rngCursor");
  return {
    seq: safeInt(record.seq, 0, 1_000_000, "seq"),
    commandId,
    effectiveYear: safeInt(record.effectiveYear, 0, MAX_YEAR, "effectiveYear"),
    auto: record.auto,
    policyId: record.policyId,
    optionIds,
    selectedOptionId: selected,
    rngCursor: { state: rngState(cursor.state), draws: safeInt(cursor.draws, 0, 1_000_000, "rngCursor.draws") },
    command: command(record.command),
    stateHashAfter: record.stateHashAfter
  };
}

function playback(value: unknown): PlaybackState {
  const record = exact(value, ["paused", "speed", "progress", "openCardIds"], [], "playback");
  if (typeof record.paused !== "boolean") failSave("E_SAVE_INVALID", "paused must be boolean");
  if (![1, 2, 4, 8, 12, 16].includes(record.speed as number)) failSave("E_SAVE_INVALID", "bad playback speed");
  if (!Array.isArray(record.openCardIds) || record.openCardIds.length > 64) failSave("E_SAVE_INVALID", "bad openCardIds");
  return {
    paused: record.paused,
    speed: record.speed as PlaybackState["speed"],
    progress: safeInt(record.progress, 0, 1_000_000_000, "progress"),
    openCardIds: record.openCardIds.map((item) => text(item, "openCardId", 64))
  };
}

function saveStats(value: unknown): SaveStats {
  const record = exact(value, ["playSeconds", "years", "decisions", "autos"], [], "stats");
  return {
    playSeconds: safeInt(record.playSeconds, 0, 1_000_000_000, "playSeconds"),
    years: safeInt(record.years, 0, MAX_YEAR, "years"),
    decisions: safeInt(record.decisions, 0, 1_000_000, "decisions"),
    autos: safeInt(record.autos, 0, 1_000_000, "autos")
  };
}

function timestamp(value: unknown, label: string): string {
  const textValue = text(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(textValue)) failSave("E_SAVE_INVALID", `bad ${label}`);
  return textValue;
}

export function validateSaveEnvelope(value: unknown): SaveEnvelope {
  const record = exact(
    value,
    [
      "magic", "saveFormatVersion", "saveId", "revision", "writerSessionId",
      "engineVersion", "rulesetVersion", "rngSpecVersion", "dataVersion", "contentVersion",
      "helpPackVersion", "seed", "seedHash", "rulesetSettings", "playback", "state", "rng",
      "commandLog", "stateHash", "createdAt", "updatedAt", "stats"
    ],
    ["parentSaveId", "migratedFromVersions"],
    "SaveEnvelope"
  );
  if (record.magic !== "LIFE1") failSave("E_SAVE_INVALID", "magic must be LIFE1");
  safeInt(record.saveFormatVersion, 3, 3, "saveFormatVersion");
  const currentVersion = version({
    engineVersion: record.engineVersion,
    rulesetVersion: record.rulesetVersion,
    rngSpecVersion: record.rngSpecVersion,
    dataVersion: record.dataVersion,
    contentVersion: record.contentVersion,
    saveFormatVersion: record.saveFormatVersion
  });
  const parentSaveId = record.parentSaveId === undefined ? undefined : text(record.parentSaveId, "parentSaveId", 128);
  const migratedFromVersions = record.migratedFromVersions === undefined ? undefined : versionShape(record.migratedFromVersions);
  if (!Array.isArray(record.commandLog) || record.commandLog.length > 1_000_000) failSave("E_SAVE_INVALID", "bad commandLog");
  if (typeof record.seedHash !== "string" || !/^[0-9a-f]{64}$/.test(record.seedHash)) failSave("E_SAVE_INVALID", "bad seedHash");
  if (typeof record.stateHash !== "string" || !/^[0-9a-f]{64}$/.test(record.stateHash)) failSave("E_SAVE_INVALID", "bad stateHash");
  const commandLog = record.commandLog.map(commandRecord);
  if (new Set(commandLog.map((item) => item.commandId)).size !== commandLog.length) failSave("E_SAVE_INVALID", "duplicate commandId");
  const envelope: SaveEnvelope = {
    magic: "LIFE1",
    saveFormatVersion: 3,
    saveId: text(record.saveId, "saveId", 128),
    revision: safeInt(record.revision, 0, 1_000_000, "revision"),
    writerSessionId: text(record.writerSessionId, "writerSessionId", 128),
    engineVersion: currentVersion.engineVersion,
    rulesetVersion: currentVersion.rulesetVersion,
    rngSpecVersion: currentVersion.rngSpecVersion,
    dataVersion: currentVersion.dataVersion,
    contentVersion: currentVersion.contentVersion,
    helpPackVersion: text(record.helpPackVersion, "helpPackVersion", 32),
    seed: text(record.seed, "seed", 128),
    seedHash: record.seedHash,
    rulesetSettings: settings(record.rulesetSettings),
    playback: playback(record.playback),
    state: gameState(record.state),
    rng: rngState(record.rng),
    commandLog,
    stateHash: record.stateHash,
    createdAt: timestamp(record.createdAt, "createdAt"),
    updatedAt: timestamp(record.updatedAt, "updatedAt"),
    stats: saveStats(record.stats)
  };
  if (parentSaveId !== undefined) envelope.parentSaveId = parentSaveId;
  if (migratedFromVersions !== undefined) envelope.migratedFromVersions = migratedFromVersions;
  return envelope;
}

export type { SaveEnvelope };
