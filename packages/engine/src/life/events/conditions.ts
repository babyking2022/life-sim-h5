import {
  P3B_CONDITION_OPS,
  P3B_CONTENT_MODES,
  P3B_MAX_AGE,
  P3B_MAX_CONDITION_DEPTH,
  P3B_MAX_CONDITION_NODES,
  P3B_MAX_FLAG_LENGTH,
  P3B_MAX_ID_LENGTH,
  P3B_MAX_WEIGHT,
  P3B_PHASES,
  P3B_STAT_KEYS,
  P3B_MONEY_FIELDS,
  type P3BCondition,
  type P3BConditionOp,
  type P3BContentMode,
  type P3BSelectionState
} from "@life-sim/contracts";
import { asPppMicro, decodeMoney, MoneyError, moneyCompare, type PppMicro } from "../../money";
import { fail } from "./errors";
import { readArray, readBoolean, readEnum, readExactObject, readInt, readMoneyString, readObject, readString } from "./schema";

/**
 * 條件 DSL：白名單 operator、可序列化、沒有 callback／eval／Function／動態 import。
 *
 * 驗證（`readCondition`）與求值（`evaluateCondition`）分離：
 * - 驗證在 pack 載入時一次做完（深度、節點數、operator、欄位、型別）；
 * - 求值只接受已驗證的節點，對合法輸入是全函數（不會丟例外）。
 */

export interface ConditionLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export const DEFAULT_CONDITION_LIMITS: ConditionLimits = {
  maxDepth: P3B_MAX_CONDITION_DEPTH,
  maxNodes: P3B_MAX_CONDITION_NODES
};

const FLAG_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const EVENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

interface ReadContext {
  readonly limits: ConditionLimits;
  nodes: number;
}

function readConditionOp(value: unknown, path: string): P3BConditionOp {
  if (typeof value !== "string") fail("E_P3B_TYPE", path);
  if (!(P3B_CONDITION_OPS as readonly string[]).includes(value)) fail("E_P3B_CONDITION_OP", path);
  return value as P3BConditionOp;
}

function readChild(context: ReadContext, value: unknown, path: string, depth: number): P3BCondition {
  if (depth > context.limits.maxDepth) fail("E_P3B_CONDITION_DEPTH", path);
  return readConditionNode(context, value, path, depth);
}

function readConditionNode(context: ReadContext, value: unknown, path: string, depth: number): P3BCondition {
  context.nodes += 1;
  if (context.nodes > context.limits.maxNodes) fail("E_P3B_CONDITION_SIZE", path);
  const object = readObject(value, path);
  const op = readConditionOp(object.op, `${path}.op`);

  switch (op) {
    case "all":
    case "any": {
      const node = readExactObject(object, path, ["op", "conditions"]);
      const list = readArray(node.conditions, `${path}.conditions`, 1, context.limits.maxNodes * 2);
      const conditions = list.map((entry, index) => readChild(context, entry, `${path}.conditions[${index}]`, depth + 1));
      return op === "all" ? { op: "all", conditions } : { op: "any", conditions };
    }
    case "not": {
      const node = readExactObject(object, path, ["op", "condition"]);
      return { op: "not", condition: readChild(context, node.condition, `${path}.condition`, depth + 1) };
    }
    case "age": {
      const node = readExactObject(object, path, ["op", "min", "max"]);
      const min = readInt(node.min, `${path}.min`, 0, P3B_MAX_AGE);
      const max = readInt(node.max, `${path}.max`, 0, P3B_MAX_AGE);
      if (min > max) fail("E_P3B_RANGE", `${path}.max`);
      return { op: "age", min, max };
    }
    case "phase": {
      const node = readExactObject(object, path, ["op", "phase"]);
      return { op: "phase", phase: readEnum(node.phase, `${path}.phase`, P3B_PHASES) };
    }
    case "stat": {
      const node = readExactObject(object, path, ["op", "stat", "min", "max"]);
      const stat = readEnum(node.stat, `${path}.stat`, P3B_STAT_KEYS);
      const min = readInt(node.min, `${path}.min`, 0, 100);
      const max = readInt(node.max, `${path}.max`, 0, 100);
      if (min > max) fail("E_P3B_RANGE", `${path}.max`);
      return { op: "stat", stat, min, max };
    }
    case "money": {
      const node = readExactObject(object, path, ["op", "field", "min", "max"]);
      const field = readEnum(node.field, `${path}.field`, P3B_MONEY_FIELDS);
      const min = readMoneyString(node.min, `${path}.min`);
      const max = readMoneyString(node.max, `${path}.max`);
      if (moneyCompare(decodeMoneyOrFail(min, `${path}.min`), decodeMoneyOrFail(max, `${path}.max`)) > 0) fail("E_P3B_RANGE", `${path}.max`);
      return { op: "money", field, min, max };
    }
    case "flag": {
      const node = readExactObject(object, path, ["op", "flag", "present"]);
      const flag = readString(node.flag, `${path}.flag`, { min: 1, max: P3B_MAX_FLAG_LENGTH, pattern: FLAG_PATTERN });
      return { op: "flag", flag, present: readBoolean(node.present, `${path}.present`) };
    }
    case "happened": {
      const node = readExactObject(object, path, ["op", "eventId"]);
      const eventId = readString(node.eventId, `${path}.eventId`, { min: 3, max: P3B_MAX_ID_LENGTH, pattern: EVENT_ID_PATTERN });
      return { op: "happened", eventId };
    }
    case "cooldown": {
      const node = readExactObject(object, path, ["op", "eventId", "years"]);
      const eventId = readString(node.eventId, `${path}.eventId`, { min: 3, max: P3B_MAX_ID_LENGTH, pattern: EVENT_ID_PATTERN });
      const years = readInt(node.years, `${path}.years`, 0, P3B_MAX_AGE);
      return { op: "cooldown", eventId, years };
    }
    case "contentMode": {
      const node = readExactObject(object, path, ["op", "mode"]);
      return { op: "contentMode", mode: readEnum(node.mode, `${path}.mode`, P3B_CONTENT_MODES) };
    }
    default:
      return fail("E_P3B_CONDITION_OP", `${path}.op`);
  }
}

function asPppMicroOrFail(value: bigint, path: string): PppMicro {
  try {
    return asPppMicro(value);
  } catch (error) {
    if (error instanceof MoneyError) return fail("E_P3B_MONEY", path);
    throw error;
  }
}

function decodeMoneyOrFail(value: string, path: string): PppMicro {
  try {
    return decodeMoney(value);
  } catch (error) {
    if (error instanceof MoneyError) return fail("E_P3B_MONEY", path);
    throw error;
  }
}

/** 驗證整棵條件樹；回傳新的（可凍結的）節點。 */
export function readCondition(value: unknown, path: string, limits: ConditionLimits = DEFAULT_CONDITION_LIMITS): P3BCondition {
  const context: ReadContext = { limits, nodes: 0 };
  const node = readConditionNode(context, value, path, 1);
  return node;
}

export interface ConditionContext {
  readonly state: P3BSelectionState;
  readonly contentMode: P3BContentMode;
  /** 已驗證、依 eventId 升冪的發生紀錄。 */
  readonly occurrences: readonly { readonly eventId: string; readonly lastYear: number; readonly count: number }[];
}

function occurrenceOf(context: ConditionContext, eventId: string): { lastYear: number; count: number } | null {
  for (const entry of context.occurrences) {
    if (entry.eventId === eventId) return { lastYear: entry.lastYear, count: entry.count };
    if (entry.eventId > eventId) break;
  }
  return null;
}

/** 對已驗證的條件樹求值；純函數、無隨機、無 I/O。 */
export function evaluateCondition(condition: P3BCondition, context: ConditionContext): boolean {
  switch (condition.op) {
    case "all":
      for (const child of condition.conditions) if (!evaluateCondition(child, context)) return false;
      return true;
    case "any":
      for (const child of condition.conditions) if (evaluateCondition(child, context)) return true;
      return false;
    case "not":
      return !evaluateCondition(condition.condition, context);
    case "age":
      return context.state.age >= condition.min && context.state.age <= condition.max;
    case "phase":
      return context.state.phase === condition.phase;
    case "stat": {
      const value = context.state.stats[condition.stat];
      return value >= condition.min && value <= condition.max;
    }
    case "money": {
      const value = asPppMicroOrFail(context.state.assets[condition.field], "condition.money.value");
      const min = decodeMoneyOrFail(condition.min, "condition.money.min");
      const max = decodeMoneyOrFail(condition.max, "condition.money.max");
      return moneyCompare(value, min) >= 0 && moneyCompare(value, max) <= 0;
    }
    case "flag": {
      const present = context.state.flags.includes(condition.flag);
      return present === condition.present;
    }
    case "happened": {
      return occurrenceOf(context, condition.eventId) !== null;
    }
    case "cooldown": {
      const occurrence = occurrenceOf(context, condition.eventId);
      if (occurrence === null) return true;
      return context.state.currentYear - occurrence.lastYear >= condition.years;
    }
    case "contentMode":
      return context.contentMode === condition.mode;
    default:
      return false;
  }
}

/** 供測試檢查上限用（避免把上限寫死在測試）。 */
export const CONDITION_LIMITS = { maxDepth: P3B_MAX_CONDITION_DEPTH, maxNodes: P3B_MAX_CONDITION_NODES, maxWeight: P3B_MAX_WEIGHT };
