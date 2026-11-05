import {
  P3C_MAX_FLAGS,
  type MoneyString,
  type P3AStats,
  type P3BEffectOutcome,
  type P3CYearEventOutcome
} from "@life-sim/contracts";
import { asPppMicro, encodeMoney, moneySub, MoneyError } from "../../money";
import { fail } from "./errors";
import { EVENT_ID_PATTERN, FLAG_PATTERN, moneyOrFail } from "./state";

/**
 * P3-B → P3-A 的整合轉接層。
 *
 * `applyEventEffects` 保持**純底層函式**（回傳 `P3BEffectOutcome`）：它不知道 P3-A 的 state、
 * history、hashChain。這一層負責：
 * 1. 把 `P3BEffectOutcome` 的「絕對值」換算成年度增量（stat／money／flag）；
 * 2. 驗證 outcome 本身（範圍、型別、flag pattern／數量），因此偽造的 outcome 不會被接受；
 * 3. 產生可直接寫進年度 delta 與 `deltaHash` 的稽核紀錄。
 *
 * 它**不**重算 effects：重算與套用都在交易內用 validated pack 的資料完成，
 * 這一層只做「結果 → 權威 state 欄位」的映射與再驗證。
 */

export const P3C_STAT_KEYS = ["health", "happiness", "knowledge", "relationships"] as const;
const ASSET_KEYS = ["balanceMicroUsd", "annualIncomeMicroUsd", "annualExpenseMicroUsd"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

export interface EffectFacts {
  readonly stats: P3AStats;
  readonly assets: {
    readonly balanceMicroUsd: bigint;
    readonly annualIncomeMicroUsd: bigint;
    readonly annualExpenseMicroUsd: bigint;
  };
  readonly flags: readonly string[];
}

export interface EffectApplication {
  readonly stats: P3AStats;
  readonly assets: EffectFacts["assets"];
  readonly flags: readonly string[];
  readonly openedDecisionId: string | null;
  readonly informational: boolean;
  readonly outcome: P3CYearEventOutcome;
}

function encodeDelta(value: bigint): MoneyString {
  try {
    return encodeMoney(asPppMicro(value)) as unknown as MoneyString;
  } catch (error) {
    if (error instanceof MoneyError) fail("E_P3C_MONEY");
    throw error;
  }
}

/**
 * 驗證公開轉接層的 `base`（呼叫端傳進來的「事件套用前狀態」）。
 * 這是信任邊界：stats、money、flags 都必須合法，而且 flags 必須符合
 * pattern／唯一／嚴格遞增／≤ 256，否則直接拒絕（不得靜默正規化）。
 */
function readBaseFacts(value: unknown): EffectFacts {
  if (!isRecord(value)) fail("E_P3C_EFFECT");
  const node = value as Record<string, unknown>;

  if (!isRecord(node.stats)) fail("E_P3C_EFFECT");
  const stats = node.stats as Record<string, unknown>;
  for (const key of P3C_STAT_KEYS) {
    const stat = stats[key];
    if (!isSafeInt(stat) || stat < 0 || stat > 100) fail("E_P3C_EFFECT");
  }

  if (!isRecord(node.assets)) fail("E_P3C_MONEY");
  const assets = node.assets as Record<string, unknown>;
  // 只接受真正的 bigint；字串／number／NaN 一律 E_P3C_MONEY。
  for (const key of ASSET_KEYS) {
    if (typeof assets[key] !== "bigint") fail("E_P3C_MONEY");
    moneyOrFail(assets[key]);
  }

  if (!Array.isArray(node.flags)) fail("E_P3C_EFFECT");
  const flags = node.flags as readonly unknown[];
  if (flags.length > P3C_MAX_FLAGS) fail("E_P3C_EFFECT");
  let previous: string | null = null;
  for (const flag of flags) {
    if (typeof flag !== "string" || !FLAG_PATTERN.test(flag)) fail("E_P3C_EFFECT");
    // base 的 flags 必須嚴格遞增：同時保證「唯一」與「已排序」。
    if (previous !== null && !(previous < flag)) fail("E_P3C_EFFECT");
    previous = flag;
  }

  return value as unknown as EffectFacts;
}

function readOutcome(value: unknown): P3BEffectOutcome {
  if (!isRecord(value)) fail("E_P3C_EFFECT");
  const node = value as Record<string, unknown>;
  if (!isRecord(node.stats)) fail("E_P3C_EFFECT");
  const stats = node.stats as Record<string, unknown>;
  for (const key of P3C_STAT_KEYS) {
    const stat = stats[key];
    if (!isSafeInt(stat) || stat < 0 || stat > 100) fail("E_P3C_EFFECT");
  }
  if (!isRecord(node.assets)) fail("E_P3C_MONEY");
  const assets = node.assets as Record<string, unknown>;
  for (const key of ASSET_KEYS) {
    if (typeof assets[key] !== "bigint") fail("E_P3C_MONEY");
    moneyOrFail(assets[key]);
  }
  if (!Array.isArray(node.flags)) {
    fail("E_P3C_EFFECT");
  }
  const flags = node.flags as readonly unknown[];
  if (flags.length > P3C_MAX_FLAGS) fail("E_P3C_EFFECT");
  const seen = new Set<string>();
  for (const flag of flags) {
    if (typeof flag !== "string" || !FLAG_PATTERN.test(flag)) fail("E_P3C_EFFECT");
    // P3-C.1：重複值必須**在 Set 去重之前**就被拒絕，不得靜默正規化。
    if (seen.has(flag)) fail("E_P3C_EFFECT");
    seen.add(flag);
  }
  if (node.openedDecisionId !== null && (typeof node.openedDecisionId !== "string" || !EVENT_ID_PATTERN.test(node.openedDecisionId))) {
    fail("E_P3C_DECISION");
  }
  if (typeof node.informational !== "boolean") fail("E_P3C_EFFECT");
  return value as unknown as P3BEffectOutcome;
}

/**
 * 把 `P3BEffectOutcome` 映射成 P3-A 權威欄位與年度增量。
 * 不修改 `base`；回傳全新物件（陣列也複製）。
 *
 * `base` 與 `outcome` 都是信任邊界：先驗證 base，再驗證 outcome，
 * 兩者都不合法時只會得到固定 `E_P3C_*`（不外洩原生 TypeError／MoneyError）。
 */
export function applyEffectOutcome(baseInput: unknown, outcome: unknown): EffectApplication {
  const base = readBaseFacts(baseInput);
  const validated = readOutcome(outcome);

  const stats: P3AStats = {
    health: validated.stats.health,
    happiness: validated.stats.happiness,
    knowledge: validated.stats.knowledge,
    relationships: validated.stats.relationships
  };
  const assets = {
    balanceMicroUsd: moneyOrFail(validated.assets.balanceMicroUsd),
    annualIncomeMicroUsd: moneyOrFail(validated.assets.annualIncomeMicroUsd),
    annualExpenseMicroUsd: moneyOrFail(validated.assets.annualExpenseMicroUsd)
  };

  // 重複值已經在 readOutcome 被拒絕，因此這裡只是 canonical 排序。
  const nextFlags = [...(validated.flags as readonly string[])].sort();
  if (nextFlags.length > P3C_MAX_FLAGS) fail("E_P3C_EFFECT");
  const before = new Set(base.flags);
  const after = new Set(nextFlags);
  const flagsAdded = nextFlags.filter((flag) => !before.has(flag));
  const flagsRemoved = base.flags.filter((flag) => !after.has(flag));

  const statDelta: P3AStats = {
    health: stats.health - base.stats.health,
    happiness: stats.happiness - base.stats.happiness,
    knowledge: stats.knowledge - base.stats.knowledge,
    relationships: stats.relationships - base.stats.relationships
  };
  const outcomeRecord: P3CYearEventOutcome = {
    statDelta,
    moneyDelta: {
      balanceMicroUsd: encodeDelta(moneySub(asPppMicro(assets.balanceMicroUsd), asPppMicro(base.assets.balanceMicroUsd))),
      annualIncomeMicroUsd: encodeDelta(moneySub(asPppMicro(assets.annualIncomeMicroUsd), asPppMicro(base.assets.annualIncomeMicroUsd))),
      annualExpenseMicroUsd: encodeDelta(moneySub(asPppMicro(assets.annualExpenseMicroUsd), asPppMicro(base.assets.annualExpenseMicroUsd)))
    },
    flagsAdded,
    flagsRemoved,
    informational: validated.informational,
    openedDecisionId: validated.openedDecisionId
  };

  return { stats, assets, flags: nextFlags, openedDecisionId: validated.openedDecisionId, informational: validated.informational, outcome: outcomeRecord };
}

/** 沒有事件的年度：增量全為 0，狀態原樣保留。 */
export function noEventOutcome(): P3CYearEventOutcome {
  return {
    statDelta: { health: 0, happiness: 0, knowledge: 0, relationships: 0 },
    moneyDelta: {
      balanceMicroUsd: "0" as unknown as MoneyString,
      annualIncomeMicroUsd: "0" as unknown as MoneyString,
      annualExpenseMicroUsd: "0" as unknown as MoneyString
    },
    flagsAdded: [],
    flagsRemoved: [],
    informational: false,
    openedDecisionId: null
  };
}
