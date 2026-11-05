import {
  P3B_EFFECT_TYPES,
  P3B_MAX_EFFECTS_PER_EVENT,
  P3B_MAX_FLAG_LENGTH,
  P3B_MAX_ID_LENGTH,
  type P3BDecisionOption,
  type P3BDecisionSpec,
  type P3BEffect,
  type P3BEffectOutcome
} from "@life-sim/contracts";
import { asPppMicro, moneyAdd, MoneyError, type PppMicro } from "../../money";
import { fail } from "./errors";
import { readArray, readEnum, readExactObject, readInt, readMoneyString, readObject, readString } from "./schema";
import { readSelectionState } from "./state";

/**
 * typed effects：先完整驗證，再一次套用（禁止部分成功）。
 *
 * 本批只產生 `P3BEffectOutcome`（typed delta），**不寫入 P3-A state**：
 * 年度交易整合是後續批次的事，屆時才會有權威紀錄與可重播性。
 */

const FLAG_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const DECISION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const STAT_DELTA_MAX = 100;

const MONEY_FIELDS = ["balanceMicroUsd", "annualIncomeMicroUsd", "annualExpenseMicroUsd"] as const;
const STAT_KEYS = ["health", "happiness", "knowledge", "relationships"] as const;

export function readEffect(value: unknown, path: string): P3BEffect {
  const object = readObject(value, path);
  const type = readEnum(object.type, `${path}.type`, P3B_EFFECT_TYPES);
  switch (type) {
    case "stat": {
      const node = readExactObject(object, path, ["type", "stat", "delta"]);
      return {
        type: "stat",
        stat: readEnum(node.stat, `${path}.stat`, STAT_KEYS),
        delta: readInt(node.delta, `${path}.delta`, -STAT_DELTA_MAX, STAT_DELTA_MAX)
      };
    }
    case "money": {
      const node = readExactObject(object, path, ["type", "field", "deltaMicroUsd"]);
      return {
        type: "money",
        field: readEnum(node.field, `${path}.field`, MONEY_FIELDS),
        deltaMicroUsd: readMoneyString(node.deltaMicroUsd, `${path}.deltaMicroUsd`)
      };
    }
    case "flag": {
      const node = readExactObject(object, path, ["type", "flag", "action"]);
      return {
        type: "flag",
        flag: readString(node.flag, `${path}.flag`, { min: 1, max: P3B_MAX_FLAG_LENGTH, pattern: FLAG_PATTERN }),
        action: readEnum(node.action, `${path}.action`, ["add", "remove"] as const)
      };
    }
    case "openDecision": {
      const node = readExactObject(object, path, ["type", "decisionId"]);
      return {
        type: "openDecision",
        decisionId: readString(node.decisionId, `${path}.decisionId`, { min: 3, max: P3B_MAX_ID_LENGTH, pattern: DECISION_ID_PATTERN })
      };
    }
    case "informational":
      readExactObject(object, path, ["type"]);
      return { type: "informational" };
    default:
      return fail("E_P3B_EFFECT", `${path}.type`);
  }
}

export function readEffectList(value: unknown, path: string, max: number = P3B_MAX_EFFECTS_PER_EVENT): readonly P3BEffect[] {
  const list = readArray(value, path, 0, max);
  const effects = list.map((entry, index) => readEffect(entry, `${path}[${index}]`));
  const informational = effects.filter((effect) => effect.type === "informational").length;
  if (informational > 0 && effects.length > 1) fail("E_P3B_EFFECT", `${path}[0]`);
  // openDecision 最多一個：讓 validated pack 不可能留下「必然在執行期失敗」的 effect list。
  const openDecision = effects.filter((effect) => effect.type === "openDecision").length;
  if (openDecision > 1) fail("E_P3B_DECISION", path);
  return effects;
}

export function readDecisionOption(value: unknown, path: string, maxEffects: number): P3BDecisionOption {
  const node = readExactObject(value, path, ["optionId", "labelKey", "effects"]);
  return {
    optionId: readString(node.optionId, `${path}.optionId`, { min: 3, max: P3B_MAX_ID_LENGTH, pattern: DECISION_ID_PATTERN }),
    labelKey: readString(node.labelKey, `${path}.labelKey`, { min: 1, max: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }),
    effects: readEffectList(node.effects, `${path}.effects`, maxEffects)
  };
}

export function readDecisionSpec(value: unknown, path: string, maxOptions: number, maxEffects: number): P3BDecisionSpec {
  const node = readExactObject(value, path, ["decisionId", "promptKey", "options"]);
  const decisionId = readString(node.decisionId, `${path}.decisionId`, { min: 3, max: P3B_MAX_ID_LENGTH, pattern: DECISION_ID_PATTERN });
  const promptKey = readString(node.promptKey, `${path}.promptKey`, { min: 1, max: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ });
  const options = readArray(node.options, `${path}.options`, 2, maxOptions).map((entry, index) =>
    readDecisionOption(entry, `${path}.options[${index}]`, maxEffects)
  );
  const ids = options.map((option) => option.optionId);
  if (new Set(ids).size !== ids.length) fail("E_P3B_DUPLICATE_ID", `${path}.options`);
  return { decisionId, promptKey, options };
}

function asPppMicroOrFail(value: bigint, path: string): PppMicro {
  try {
    return asPppMicro(value);
  } catch (error) {
    if (error instanceof MoneyError) return fail("E_P3B_MONEY", path);
    throw error;
  }
}

function moneyOrFail(action: () => PppMicro, path: string): PppMicro {
  try {
    return action();
  } catch (error) {
    if (error instanceof MoneyError) return fail("E_P3B_MONEY", path);
    throw error;
  }
}

function clampStat(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * 套用 effects：先驗證全部 effect，再於區域變數算出結果，最後一次回傳。
 * 任何一個 effect 不合法都會在「尚未產生任何結果」前丟出固定錯誤碼。
 */
export function applyEventEffects(state: unknown, effects: unknown): P3BEffectOutcome {
  // 1. 先驗證 state，再完整驗證 effects（兩者都當 unknown 處理，不靠 TypeScript 型別）。
  const base = readSelectionState(state, "state");
  const validated = readEffectList(effects, "effects", P3B_MAX_EFFECTS_PER_EVENT);

  // 2. 在區域變數上算出完整結果。
  let health = base.stats.health;
  let happiness = base.stats.happiness;
  let knowledge = base.stats.knowledge;
  let relationships = base.stats.relationships;
  let balance = base.assets.balanceMicroUsd;
  let income = base.assets.annualIncomeMicroUsd;
  let expense = base.assets.annualExpenseMicroUsd;
  const flags = new Set(base.flags);
  let openedDecisionId: string | null = null;
  let informational = false;

  for (let index = 0; index < validated.length; index += 1) {
    const effect = validated[index] as P3BEffect;
    const path = `effects[${index}]`;
    switch (effect.type) {
      case "stat":
        if (effect.stat === "health") health = clampStat(health + effect.delta);
        else if (effect.stat === "happiness") happiness = clampStat(happiness + effect.delta);
        else if (effect.stat === "knowledge") knowledge = clampStat(knowledge + effect.delta);
        else relationships = clampStat(relationships + effect.delta);
        break;
      case "money": {
        const delta = moneyOrFail(() => asPppMicro(BigInt(effect.deltaMicroUsd)), `${path}.deltaMicroUsd`);
        if (effect.field === "balanceMicroUsd") balance = moneyOrFail(() => moneyAdd(asPppMicroOrFail(balance, `${path}.balanceMicroUsd`), delta), path);
        else if (effect.field === "annualIncomeMicroUsd") income = moneyOrFail(() => moneyAdd(asPppMicroOrFail(income, `${path}.annualIncomeMicroUsd`), delta), path);
        else expense = moneyOrFail(() => moneyAdd(asPppMicroOrFail(expense, `${path}.annualExpenseMicroUsd`), delta), path);
        break;
      }
      case "flag":
        if (effect.action === "add") flags.add(effect.flag);
        else flags.delete(effect.flag);
        break;
      case "openDecision":
        if (openedDecisionId !== null) fail("E_P3B_DECISION", path);
        openedDecisionId = effect.decisionId;
        break;
      case "informational":
        informational = true;
        break;
      default:
        fail("E_P3B_EFFECT", path);
    }
  }

  // 3. 一次回傳（沒有任何部分套用）。
  return {
    stats: { health, happiness, knowledge, relationships },
    assets: {
      // 允許負的 balance（淨負債），但仍必須落在 Money 契約範圍內。
      balanceMicroUsd: moneyOrFail(() => asPppMicro(balance), "effects.balanceMicroUsd"),
      annualIncomeMicroUsd: moneyOrFail(() => asPppMicro(income), "effects.annualIncomeMicroUsd"),
      annualExpenseMicroUsd: moneyOrFail(() => asPppMicro(expense), "effects.annualExpenseMicroUsd")
    },
    flags: [...flags].sort(),
    openedDecisionId,
    informational
  };
}
