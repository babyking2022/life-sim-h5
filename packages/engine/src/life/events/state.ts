import { P3B_MAX_AGE, P3B_MAX_FLAG_LENGTH, P3B_PHASES, type P3BSelectionState } from "@life-sim/contracts";
import { asPppMicro, MoneyError, type PppMicro } from "../../money";
import { fail } from "./errors";
import { readArray, readEnum, readExactObject, readInt, readString } from "./schema";

/**
 * 抽選與 effects 共用的 state 驗證器（P3-B.1 信任邊界）。
 *
 * 任何欄位在使用前都必須先過這裡；因此 NaN、Infinity、浮點、錯誤 money、重複或非法 flag、
 * 未知鍵、危險鍵、陣列、null、自訂 prototype 全部是固定 `E_P3B_*`，不會出現 native TypeError。
 */

const FLAG_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const MAX_FLAGS = 256;
const MAX_YEAR = 100_000;

const STATE_KEYS = ["currentYear", "age", "phase", "stats", "assets", "flags"] as const;
const STAT_KEYS = ["health", "happiness", "knowledge", "relationships"] as const;
const ASSET_KEYS = ["balanceMicroUsd", "annualIncomeMicroUsd", "annualExpenseMicroUsd"] as const;

function readMoneyField(node: Record<string, unknown>, key: (typeof ASSET_KEYS)[number], path: string): PppMicro {
  const value = node[key];
  // 只接受真正的 bigint；字串／number／NaN 一律拒絕。
  if (typeof value !== "bigint") fail("E_P3B_MONEY", path);
  try {
    return asPppMicro(value);
  } catch (error) {
    if (error instanceof MoneyError) return fail("E_P3B_MONEY", path);
    throw error;
  }
}

/** 驗證並回傳新的 state（不共享任何可變結構）。 */
export function readSelectionState(value: unknown, path = "input.state"): P3BSelectionState {
  const node = readExactObject(value, path, STATE_KEYS);
  const statsNode = readExactObject(node.stats, `${path}.stats`, STAT_KEYS);
  const assetsNode = readExactObject(node.assets, `${path}.assets`, ASSET_KEYS);

  const flags = readArray(node.flags, `${path}.flags`, 0, MAX_FLAGS).map((entry, index) =>
    readString(entry, `${path}.flags[${index}]`, { min: 1, max: P3B_MAX_FLAG_LENGTH, pattern: FLAG_PATTERN })
  );
  const seen = new Set<string>();
  for (const flag of flags) {
    if (seen.has(flag)) fail("E_P3B_SELECTION", `${path}.flags`);
    seen.add(flag);
  }

  return {
    currentYear: readInt(node.currentYear, `${path}.currentYear`, 0, MAX_YEAR),
    age: readInt(node.age, `${path}.age`, 0, P3B_MAX_AGE),
    phase: readEnum(node.phase, `${path}.phase`, P3B_PHASES),
    stats: {
      health: readInt(statsNode.health, `${path}.stats.health`, 0, 100),
      happiness: readInt(statsNode.happiness, `${path}.stats.happiness`, 0, 100),
      knowledge: readInt(statsNode.knowledge, `${path}.stats.knowledge`, 0, 100),
      relationships: readInt(statsNode.relationships, `${path}.stats.relationships`, 0, 100)
    },
    assets: {
      balanceMicroUsd: readMoneyField(assetsNode, "balanceMicroUsd", `${path}.assets.balanceMicroUsd`),
      annualIncomeMicroUsd: readMoneyField(assetsNode, "annualIncomeMicroUsd", `${path}.assets.annualIncomeMicroUsd`),
      annualExpenseMicroUsd: readMoneyField(assetsNode, "annualExpenseMicroUsd", `${path}.assets.annualExpenseMicroUsd`)
    },
    flags
  };
}

export const STATE_LIMITS = { maxFlags: MAX_FLAGS, maxYear: MAX_YEAR };
