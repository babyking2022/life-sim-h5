import { isSupportedRngSpecVersion, type CoreEffect, type EngineCommand, type RulesetSettings } from "@life-sim/contracts";
import { asPppMicro, decodeMoney, moneyAdd } from "../money";
import { deriveDomainState, normalizeSeed } from "../rng/seed";
import type { EngineState } from "./types";
import { parseCommand, parseEffect, parseRulesetSettings } from "./validate";
import { P1BError } from "./errors";

const MAX_YEAR = 1_000_000;
const MAX_STAT = 1000;

function cloneState(state: EngineState): EngineState {
  return {
    ...state,
    stats: { ...state.stats },
    flags: { ...state.flags },
    rng: [state.rng[0], state.rng[1], state.rng[2], state.rng[3]],
    rulesetSettings: { ...state.rulesetSettings }
  };
}

export function createInitialState(seedText: string, settings: RulesetSettings, rngSpecVersion: string): EngineState {
  if (!isSupportedRngSpecVersion(rngSpecVersion)) {
    throw new P1BError("UNSUPPORTED_RNG_SPEC", `unsupported rngSpecVersion: ${rngSpecVersion}`);
  }
  const seed = normalizeSeed(seedText);
  const parsedSettings = parseRulesetSettings(settings);
  return {
    schemaVersion: 1,
    seed,
    year: 0,
    stats: { health: 500, happiness: 500, knowledge: 500, relationships: 500 },
    resourcePppMicro: asPppMicro(0n),
    flags: {},
    rng: deriveDomainState(seed, "events", rngSpecVersion),
    rngDraws: 0,
    rulesetSettings: parsedSettings
  };
}

export function applyEffect(state: EngineState, effect: CoreEffect): EngineState {
  const parsed = parseEffect(effect);
  const next = cloneState(state);
  switch (parsed.kind) {
    case "stat": {
      const value = next.stats[parsed.stat] + parsed.delta;
      next.stats = { ...next.stats, [parsed.stat]: Math.max(0, Math.min(MAX_STAT, value)) };
      return next;
    }
    case "money": {
      next.resourcePppMicro = moneyAdd(next.resourcePppMicro, decodeMoney(parsed.deltaPppMicro));
      return next;
    }
    case "flag": {
      next.flags = { ...next.flags, [parsed.key]: parsed.value };
      return next;
    }
  }
}

export function applyEffects(state: EngineState, effects: readonly CoreEffect[]): EngineState {
  if (!Array.isArray(effects) || effects.length < 1 || effects.length > 64) {
    throw new P1BError("INVALID_EFFECT", "effects must be 1..64 items");
  }
  const validated = effects.map(parseEffect);
  let next = cloneState(state);
  for (const effect of validated) next = applyEffect(next, effect);
  return next;
}

export function applyCommand(state: EngineState, command: EngineCommand, effectiveYear: number): EngineState {
  const parsed = parseCommand(command);
  if (!Number.isSafeInteger(effectiveYear) || effectiveYear !== state.year) {
    throw new P1BError("INVALID_COMMAND_LOG", "effectiveYear does not match current year");
  }
  const next = applyEffects(state, parsed.effects);
  const year = next.year + 1;
  if (year > MAX_YEAR) throw new P1BError("INVALID_STATE", "year out of range");
  next.year = year;
  return next;
}
