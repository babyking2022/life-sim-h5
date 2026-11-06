import { describe, expect, it } from "vitest";
import * as contracts from "@life-sim/contracts";
import {
  deriveDomainState,
  MAX_MONEY_PPP_MICRO,
  MIN_MONEY_PPP_MICRO,
  MoneyError,
  RngError,
  SeedError,
  Xoshiro128StarStar
} from "@life-sim/engine";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { computeP3ERollAssets, drawP3ERollDeltas, resolveP3ERoll } from "../src/roll";

/**
 * P3-E.1a-2b.1：`p3e-roll-1.0.0` 決定性年度 roll（信任邊界 ＋ Money 修正版）。
 *
 * 期待值**不**用被測函式計算：
 * - RNG 期待值一律用 engine 公開原語（`Xoshiro128StarStar`）獨立重算；
 * - 收支與 clamp 的期待值用本檔的字面值公式（不是 contracts 常數）；
 * - contracts 常數另外單獨斷言，因此「常數漂移」與「實作漂移」都會被抓到。
 */

const SPEC = contracts.P3E_ROLL_SPEC_VERSION;
const RNG_INITIAL = deriveDomainState("p3e-roll-2b-initial", "life", "1.0.0");
const RNG_STATE = deriveDomainState("p3e-roll-2b-state", "life", "1.0.0");
const OTHER_STATE = deriveDomainState("p3e-roll-2b-other", "life", "1.0.0");

const asInput = (value: unknown) => value as contracts.P3ERollInput;

/** 本檔自己的 clamp（字面值 0／100，刻意不引用 contracts）。 */
const clamp = (value: number) => Math.max(0, Math.min(100, value));

interface ManualRoll {
  readonly health: number;
  readonly happiness: number;
  readonly knowledge: number;
  readonly relationships: number;
  readonly state: contracts.P3EWordTuple;
}

/** 獨立重算：固定順序 health −3..3／happiness −3..3／knowledge 0..3／relationships −2..2。 */
function manualRoll(state: contracts.P3EWordTuple): ManualRoll {
  const rng = new Xoshiro128StarStar([state[0], state[1], state[2], state[3]]);
  const health = rng.uniformInt(-3, 3);
  const happiness = rng.uniformInt(-3, 3);
  const knowledge = rng.uniformInt(0, 3);
  const relationships = rng.uniformInt(-2, 2);
  const after = rng.state;
  return { health, happiness, knowledge, relationships, state: [after[0], after[1], after[2], after[3]] };
}

/** 抽 n 次（第 5 次之後循環回第一步的範圍），用來證明「不等於 3 次／5 次的 state」。 */
function manualN(state: contracts.P3EWordTuple, count: number): contracts.P3EWordTuple {
  const ranges = [
    [-3, 3],
    [-3, 3],
    [0, 3],
    [-2, 2]
  ] as const;
  const rng = new Xoshiro128StarStar([state[0], state[1], state[2], state[3]]);
  for (let index = 0; index < count; index += 1) {
    const range = ranges[index % ranges.length] as readonly [number, number];
    rng.uniformInt(range[0], range[1]);
  }
  const after = rng.state;
  return [after[0], after[1], after[2], after[3]];
}

function baseInput(overrides: Partial<contracts.P3ERollInput> = {}): contracts.P3ERollInput {
  return {
    rollSpecVersion: SPEC,
    age: 30,
    stats: { health: 50, happiness: 50, knowledge: 50, relationships: 50 },
    balanceMicroUsd: 5_000_000n,
    lifeRng: {
      domain: contracts.P3E_LIFE_DOMAIN,
      initialState: RNG_INITIAL,
      state: RNG_STATE,
      semanticDraws: 8
    },
    ...overrides
  };
}

const rawInput = (overrides: Partial<contracts.P3ERollInput> = {}) => ({ ...baseInput(overrides) }) as Record<string, unknown>;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** 找一個能產生指定增量組合的合法 state（決定性搜尋，不是隨機）。 */
function searchState(predicate: (roll: ManualRoll) => boolean, limit = 4000): contracts.P3EWordTuple {
  for (let index = 1; index <= limit; index += 1) {
    const candidate = deriveDomainState(`p3e-roll-2b-search-${index}`, "life", "1.0.0");
    const words: contracts.P3EWordTuple = [candidate[0], candidate[1], candidate[2], candidate[3]];
    if (predicate(manualRoll(words))) return words;
  }
  throw new Error("no candidate state found");
}

function expectP3EError(run: () => unknown, code: string, path: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error(`expected ${code} at ${path}`);
  expect(caught, `${code} at ${path}`).toBeInstanceOf(P3EError);
  const p3e = caught as P3EError;
  expect(p3e.code, path).toBe(code);
  expect(p3e.path).toBe(path);
  expect(p3e.message).toBe(`${code} at ${path}`);
  expect(p3e.name).toBe("P3EError");
  expect(isP3EError(p3e)).toBe(true);
  // 不外洩 engine 或原生例外（含 MoneyError）
  expect(caught instanceof RngError).toBe(false);
  expect(caught instanceof SeedError).toBe(false);
  expect(caught instanceof MoneyError).toBe(false);
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
}

/* ------------------------------------------------------------------ */
/* 一、公開表面與常數                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2b 公開表面", () => {
  it("resolveP3ERoll 與 roll 內部函式都不在 simulation barrel", () => {
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.resolveP3ERoll).toBeUndefined();
    expect(surface.drawP3ERollDeltas).toBeUndefined();
    expect(surface.computeP3ERollAssets).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("roll 常數與本檔的獨立期待值一致（順序、範圍、抽樣數）", () => {
    expect(contracts.P3E_ROLL_SPEC_VERSION).toBe("p3e-roll-1.0.0");
    expect(contracts.P3E_ROLL_STEPS.map((step) => step.stat)).toEqual([
      "health",
      "happiness",
      "knowledge",
      "relationships"
    ]);
    expect(contracts.P3E_ROLL_STEPS.map((step) => [step.min, step.max])).toEqual([
      [-3, 3],
      [-3, 3],
      [0, 3],
      [-2, 2]
    ]);
    expect(contracts.P3E_ROLL_SEMANTIC_DRAWS).toBe(4);
    expect(contracts.P3E_STAT_MIN).toBe(0);
    expect(contracts.P3E_STAT_MAX).toBe(100);
  });

  it("收支常數與本檔的獨立期待值一致", () => {
    expect(contracts.P3E_INCOME_BASE_MICRO_USD).toBe(1_000_000n);
    expect(contracts.P3E_INCOME_PER_YEAR_MICRO_USD).toBe(100_000n);
    expect(contracts.P3E_EXPENSE_BASE_MICRO_USD).toBe(600_000n);
    expect(contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD).toBe(50_000n);
  });
});

/* ------------------------------------------------------------------ */
/* 二、RNG 語意                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2b roll RNG", () => {
  it("輸出 state 等於手動執行四次抽樣後的 state", () => {
    const result = resolveP3ERoll(baseInput());
    const expected = manualRoll(RNG_STATE);
    expect(result.lifeRng.state).toEqual(expected.state);
  });

  it("四次抽樣的順序與範圍：每一欄都等於手動同序抽樣的結果", () => {
    const input = baseInput();
    const result = resolveP3ERoll(input);
    const manual = manualRoll(RNG_STATE);
    expect(result.stats).toEqual({
      health: clamp(50 + manual.health),
      happiness: clamp(50 + manual.happiness),
      knowledge: clamp(50 + manual.knowledge),
      relationships: clamp(50 + manual.relationships)
    });
    // 範圍（獨立斷言，不只靠上面那條）
    expect(manual.health).toBeGreaterThanOrEqual(-3);
    expect(manual.health).toBeLessThanOrEqual(3);
    expect(manual.happiness).toBeGreaterThanOrEqual(-3);
    expect(manual.happiness).toBeLessThanOrEqual(3);
    expect(manual.knowledge).toBeGreaterThanOrEqual(0);
    expect(manual.knowledge).toBeLessThanOrEqual(3);
    expect(manual.relationships).toBeGreaterThanOrEqual(-2);
    expect(manual.relationships).toBeLessThanOrEqual(2);
  });

  it("換順序會得到不同結果（不是「四欄各自獨立亂抽」）", () => {
    const state = searchState((roll) => {
      const values = [roll.health, roll.happiness, roll.knowledge, roll.relationships];
      return new Set(values).size === 4;
    });
    const result = resolveP3ERoll(baseInput({ lifeRng: { ...baseInput().lifeRng, state } }));
    const manual = manualRoll(state);
    // health 與 happiness 交換後的結果（因為四個增量互不相同，必然不同）
    expect(result.stats.health).toBe(clamp(50 + manual.health));
    expect(result.stats.happiness).toBe(clamp(50 + manual.happiness));
    expect(result.stats.health).not.toBe(clamp(50 + manual.happiness));
    expect(result.stats.happiness).not.toBe(clamp(50 + manual.health));
  });

  it("三次抽樣與五次抽樣的 state 都不等於輸出", () => {
    const result = resolveP3ERoll(baseInput());
    expect(result.lifeRng.state).not.toEqual(manualN(RNG_STATE, 3));
    expect(result.lifeRng.state).not.toEqual(manualN(RNG_STATE, 5));
    expect(result.lifeRng.state).toEqual(manualN(RNG_STATE, 4));
  });

  it("semanticDraws 精確增加 4，semanticDrawsUsed 固定為 4", () => {
    for (const start of [0, 1, 8, 1_000]) {
      const input = baseInput({ lifeRng: { ...baseInput().lifeRng, semanticDraws: start } });
      const result = resolveP3ERoll(input);
      expect(result.lifeRng.semanticDraws).toBe(start + 4);
      expect(result.semanticDrawsUsed).toBe(4);
      expect(result.semanticDrawsUsed).toBe(contracts.P3E_ROLL_SEMANTIC_DRAWS);
    }
  });

  it("initialState 保持原值：不重推、不再次 burn、不是新推導", () => {
    const input = baseInput();
    const result = resolveP3ERoll(input);
    expect(result.lifeRng.initialState).toEqual(RNG_INITIAL);
    expect(result.lifeRng.initialState).toEqual(input.lifeRng.initialState);
    // 若把 initialState 再 burn 一次（或從它重推），state 會不同
    const burn = new Xoshiro128StarStar([RNG_INITIAL[0], RNG_INITIAL[1], RNG_INITIAL[2], RNG_INITIAL[3]]);
    burn.uniformBigInt(41n);
    expect(result.lifeRng.initialState).not.toEqual(burn.state);
    expect(result.lifeRng.state).not.toEqual(manualN(RNG_INITIAL, 4));
  });

  it("從不同的 state 起算會得到不同的抽樣與游標", () => {
    const first = resolveP3ERoll(baseInput());
    const second = resolveP3ERoll(baseInput({ lifeRng: { ...baseInput().lifeRng, state: OTHER_STATE } }));
    expect(second.lifeRng.state).toEqual(manualRoll(OTHER_STATE).state);
    expect(second.lifeRng.state).not.toEqual(first.lifeRng.state);
    // initialState 與 state 無關，兩次相同
    expect(second.lifeRng.initialState).toEqual(first.lifeRng.initialState);
  });
});

/* ------------------------------------------------------------------ */
/* 三、四狀態 clamp                                                     */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2b 四狀態 clamp", () => {
  const allPositive = searchState(
    (roll) => roll.health > 0 && roll.happiness > 0 && roll.knowledge > 0 && roll.relationships > 0
  );
  const threeNegative = searchState((roll) => roll.health < 0 && roll.happiness < 0 && roll.relationships < 0);

  it("上界：狀態 100 加正增量仍為 100", () => {
    const input = baseInput({
      stats: { health: 100, happiness: 100, knowledge: 100, relationships: 100 },
      lifeRng: { ...baseInput().lifeRng, state: allPositive }
    });
    const manual = manualRoll(allPositive);
    // 先確認這個 state 真的會把三項推過 100（否則 clamp 沒有被測到）
    expect(100 + manual.health).toBeGreaterThan(100);
    expect(100 + manual.happiness).toBeGreaterThan(100);
    expect(100 + manual.relationships).toBeGreaterThan(100);
    const result = resolveP3ERoll(input);
    expect(result.stats).toEqual({ health: 100, happiness: 100, knowledge: 100, relationships: 100 });
  });

  it("下界：狀態 0 加負增量仍為 0", () => {
    const input = baseInput({
      stats: { health: 0, happiness: 0, knowledge: 0, relationships: 0 },
      lifeRng: { ...baseInput().lifeRng, state: threeNegative }
    });
    const manual = manualRoll(threeNegative);
    expect(manual.health).toBeLessThan(0);
    expect(manual.happiness).toBeLessThan(0);
    expect(manual.relationships).toBeLessThan(0);
    const result = resolveP3ERoll(input);
    expect(result.stats.health).toBe(0);
    expect(result.stats.happiness).toBe(0);
    expect(result.stats.relationships).toBe(0);
    // knowledge 的增量是 0..3，不可能為負
    expect(result.stats.knowledge).toBe(clamp(manual.knowledge));
    expect(result.stats.knowledge).toBe(manual.knowledge);
  });

  it("中間值不 clamp：50 加增量就是 50+增量", () => {
    const manual = manualRoll(RNG_STATE);
    const result = resolveP3ERoll(baseInput());
    expect(result.stats.health).toBe(50 + manual.health);
    expect(result.stats.happiness).toBe(50 + manual.happiness);
    expect(result.stats.knowledge).toBe(50 + manual.knowledge);
    expect(result.stats.relationships).toBe(50 + manual.relationships);
    for (const value of Object.values(result.stats)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 四、收支                                                           */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2b 收支（GPT-0031-A 個人經濟生命週期）", () => {
  /**
   * 手算的基準值（knowledge = 50、沒有任何教育／工作／退休旗標、重心未設定）：
   *
   * - 0–17 歲：收入 0、支出 0；
   * - 18–22 歲：沒有工作旗標 → 收入 0、生活支出 7,000 美元；
   * - 23–64 歲：預設就業，(18,000 + 50 × 150) = 25,500 美元，
   *   再依職涯階段 0.85／1.15／1.05 調整；支出 12,000 + 50 × 40 = 14,000 美元；
   * - 65 歲以上：退休金 9,000 + min(50 × 25, 2,000) = 10,250 美元；支出 9,500 美元。
   */
  const BASE = [
    { age: 0, income: 0n, expense: 0n },
    { age: 5, income: 0n, expense: 0n },
    { age: 15, income: 0n, expense: 0n },
    { age: 16, income: 0n, expense: 0n },
    { age: 17, income: 0n, expense: 0n },
    { age: 18, income: 0n, expense: 7_000_000_000n },
    { age: 22, income: 0n, expense: 7_000_000_000n },
    { age: 23, income: 21_675_000_000n, expense: 14_000_000_000n },
    { age: 30, income: 29_325_000_000n, expense: 14_000_000_000n },
    { age: 49, income: 29_325_000_000n, expense: 14_000_000_000n },
    { age: 50, income: 26_775_000_000n, expense: 14_000_000_000n },
    { age: 64, income: 26_775_000_000n, expense: 14_000_000_000n },
    { age: 65, income: 10_250_000_000n, expense: 9_500_000_000n },
    { age: 120, income: 10_250_000_000n, expense: 9_500_000_000n }
  ] as const;

  it("0／5／15 歲：個人收入、支出、資產全部為 0（舊線性公式的兒童收入已移除）", () => {
    for (const age of [0, 5, 15]) {
      const result = resolveP3ERoll(baseInput({ age, balanceMicroUsd: 9_999_999n }));
      expect(result.assets.annualIncomeMicroUsd, `income age ${age}`).toBe(0n);
      expect(result.assets.annualExpenseMicroUsd, `expense age ${age}`).toBe(0n);
      expect(result.assets.balanceMicroUsd, `balance age ${age}`).toBe(0n);
    }
  });

  it("各年齡段的基準收支（手算值，含 16／17、18–22、23–64、65+）", () => {
    for (const item of BASE) {
      const previous = 5_000_000n;
      const result = resolveP3ERoll(baseInput({ age: item.age, balanceMicroUsd: previous }));
      expect(result.assets.annualIncomeMicroUsd, `income age ${item.age}`).toBe(item.income);
      expect(result.assets.annualExpenseMicroUsd, `expense age ${item.age}`).toBe(item.expense);
      // 0–15 歲連餘額都歸零（個人資產不是家庭財富）。
      const net = item.age < 16 ? 0n : previous + item.income - item.expense;
      expect(result.assets.balanceMicroUsd, `balance age ${item.age}`).toBe(net < 0n ? 0n : net);
    }
  });

  it("收支全部維持 bigint", () => {
    const result = resolveP3ERoll(baseInput());
    expect(typeof result.assets.balanceMicroUsd).toBe("bigint");
    expect(typeof result.assets.annualIncomeMicroUsd).toBe("bigint");
    expect(typeof result.assets.annualExpenseMicroUsd).toBe("bigint");
  });

  it("非負餘額：balance = previous + net（不會被 clamp）", () => {
    for (const item of BASE) {
      const previous = 5_000_000n;
      const result = resolveP3ERoll(baseInput({ age: item.age, balanceMicroUsd: previous }));
      const net = item.age < 16 ? 0n : previous + item.income - item.expense;
      expect(result.assets.balanceMicroUsd, `age ${item.age}`).toBe(net < 0n ? 0n : net);
    }
  });

  it("負餘額（淨負債）：net < 0 一律截到 0n，剛好清償也是 0n，多 1 microUSD 才是 1n", () => {
    for (const item of [{ age: 30, net: 15_325_000_000n }, { age: 60, net: 12_775_000_000n }, { age: 120, net: 750_000_000n }]) {
      const broke = resolveP3ERoll(baseInput({ age: item.age, balanceMicroUsd: -item.net - 1n }));
      expect(broke.assets.balanceMicroUsd, `broke age ${item.age}`).toBe(0n);
      const exact = resolveP3ERoll(baseInput({ age: item.age, balanceMicroUsd: -item.net }));
      expect(exact.assets.balanceMicroUsd, `exact age ${item.age}`).toBe(0n);
      const surplus = resolveP3ERoll(baseInput({ age: item.age, balanceMicroUsd: -item.net + 1n }));
      expect(surplus.assets.balanceMicroUsd, `surplus age ${item.age}`).toBe(1n);
    }
  });

  it("負餘額時支出仍保留完整結算值（不被改寫成實際可扣金額）", () => {
    const age = 120;
    const result = resolveP3ERoll(baseInput({ age, balanceMicroUsd: -50_000_000_000n }));
    expect(result.assets.annualIncomeMicroUsd).toBe(10_250_000_000n);
    expect(result.assets.annualExpenseMicroUsd).toBe(9_500_000_000n);
    expect(result.assets.balanceMicroUsd).toBe(0n);
    expect(result.assets.annualExpenseMicroUsd).not.toBe(9_500_000_000n - 50_000_000_000n);
  });

  it("負 balance 可以經正式 resolveP3ERoll 進入，且收支仍不消耗 RNG", () => {
    const negative = resolveP3ERoll(baseInput({ balanceMicroUsd: -1n }));
    const positive = resolveP3ERoll(baseInput({ balanceMicroUsd: 1n }));
    expect(negative.assets.balanceMicroUsd).toBe(-1n + 15_325_000_000n);
    expect(negative.lifeRng).toEqual(positive.lifeRng);
    expect(negative.stats).toEqual(positive.stats);
  });

  it("MIN_MONEY_PPP_MICRO 輸入合法，結算後為 0n", () => {
    const result = resolveP3ERoll(baseInput({ balanceMicroUsd: MIN_MONEY_PPP_MICRO }));
    expect(result.assets.balanceMicroUsd).toBe(0n);
    expect(result.assets.annualIncomeMicroUsd).toBe(29_325_000_000n);
    expect(result.assets.annualExpenseMicroUsd).toBe(14_000_000_000n);
  });

  it("恰好不超過 MAX_MONEY_PPP_MICRO 的輸出合法（邊界逐 microUSD）", () => {
    for (const item of [{ age: 30, net: 15_325_000_000n }, { age: 60, net: 12_775_000_000n }, { age: 120, net: 750_000_000n }]) {
      const previous = MAX_MONEY_PPP_MICRO - item.net;
      const ok = resolveP3ERoll(baseInput({ age: item.age, balanceMicroUsd: previous }));
      expect(ok.assets.balanceMicroUsd, `age ${item.age}`).toBe(MAX_MONEY_PPP_MICRO);
      expectP3EError(
        () => resolveP3ERoll(baseInput({ age: item.age, balanceMicroUsd: previous + 1n })),
        "E_P3E_MONEY",
        "assets.balanceMicroUsd"
      );
    }
  });

  it("Money 上界與 engine 公開常數一致（不是自己寫死的數字）", () => {
    expect(MAX_MONEY_PPP_MICRO).toBe(1_000_000_000_000_000_000n);
    expect(MIN_MONEY_PPP_MICRO).toBe(-1_000_000_000_000_000_000n);
  });

  it("內部公式函式與公開入口的結果一致（負餘額與上界也一樣）", () => {
    const direct = computeP3ERollAssets(120, 50, -100_000_000n);
    const viaEntry = resolveP3ERoll(baseInput({ age: 120, balanceMicroUsd: -100_000_000n }));
    expect(direct).toEqual(viaEntry.assets);

    const net = 15_325_000_000n;
    const directOk = computeP3ERollAssets(30, 50, MAX_MONEY_PPP_MICRO - net);
    expect(directOk.balanceMicroUsd).toBe(MAX_MONEY_PPP_MICRO);
    let caught: unknown;
    try {
      computeP3ERollAssets(30, 50, MAX_MONEY_PPP_MICRO - net + 1n);
    } catch (error) {
      caught = error;
    }
    expect(isP3EError(caught)).toBe(true);
    expect((caught as P3EError).code).toBe("E_P3E_MONEY");
    expect((caught as P3EError).path).toBe("assets.balanceMicroUsd");
  });

  it("改 age／balance 不改變 RNG 推進與 stats", () => {
    const a = resolveP3ERoll(baseInput({ age: 0, balanceMicroUsd: 0n }));
    const b = resolveP3ERoll(baseInput({ age: 120, balanceMicroUsd: 999_999_999n }));
    expect(b.lifeRng).toEqual(a.lifeRng);
    expect(b.stats).toEqual(a.stats);
    expect(b.assets.balanceMicroUsd).not.toBe(a.assets.balanceMicroUsd);
  });

  it("相同的 age／balance 逐位元相同（沒有隱藏狀態）", () => {
    const a = resolveP3ERoll(baseInput({ age: 60, balanceMicroUsd: 7n }));
    const b = resolveP3ERoll(baseInput({ age: 60, balanceMicroUsd: 7n }));
    expect(a.assets).toEqual(b.assets);
    expect(a.assets.balanceMicroUsd).toBe(7n + 26_775_000_000n - 14_000_000_000n);
  });
});

/* ------------------------------------------------------------------ */
/* 五、決定性與不可變                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2b 決定性與不可變", () => {
  it("相同輸入完全決定性（逐欄相同、物件不共用）", () => {
    const first = resolveP3ERoll(baseInput());
    const second = resolveP3ERoll(baseInput());
    expect(second).toEqual(first);
    expect(second.stats).not.toBe(first.stats);
    expect(second.assets).not.toBe(first.assets);
    expect(second.lifeRng).not.toBe(first.lifeRng);
    expect(second.lifeRng.state).not.toBe(first.lifeRng.state);
    expect(second.lifeRng.initialState).not.toBe(first.lifeRng.initialState);
  });

  it("不修改輸入（含深凍結的輸入）", () => {
    const input = baseInput();
    const before = structuredClone(input);
    resolveP3ERoll(input);
    expect(input).toEqual(before);

    const frozen = deepFreeze(structuredClone(baseInput()));
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => resolveP3ERoll(frozen)).not.toThrow();
    expect(resolveP3ERoll(frozen)).toEqual(resolveP3ERoll(baseInput()));
  });

  it("輸出與輸入不共用可觀察參考", () => {
    const input = baseInput();
    const result = resolveP3ERoll(input);
    expect(result.stats).not.toBe(input.stats);
    expect(result.lifeRng).not.toBe(input.lifeRng);
    expect(result.lifeRng.state).not.toBe(input.lifeRng.state);
    expect(result.lifeRng.initialState).not.toBe(input.lifeRng.initialState);
  });

  it("輸出深層凍結", () => {
    const result = resolveP3ERoll(baseInput());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.stats)).toBe(true);
    expect(Object.isFrozen(result.assets)).toBe(true);
    expect(Object.isFrozen(result.lifeRng)).toBe(true);
    expect(Object.isFrozen(result.lifeRng.initialState)).toBe(true);
    expect(Object.isFrozen(result.lifeRng.state)).toBe(true);

    expect(() => {
      (result as unknown as Record<string, unknown>).semanticDrawsUsed = 99;
    }).toThrow(TypeError);
    expect(() => {
      (result.stats as unknown as Record<string, unknown>).health = 0;
    }).toThrow(TypeError);
    expect(() => {
      (result.lifeRng.state as unknown as number[])[0] = 1;
    }).toThrow(TypeError);
    expect(result.semanticDrawsUsed).toBe(4);
    expect(result.stats.health).toBe(clamp(50 + manualRoll(RNG_STATE).health));
  });

  it("輸出形狀固定：沒有原始抽樣值、沒有逐年陣列", () => {
    const result = resolveP3ERoll(baseInput());
    expect(Object.keys(result).sort()).toEqual([
      "assets",
      "lifeRng",
      "rollSpecVersion",
      "semanticDrawsUsed",
      "stats"
    ]);
    expect(Object.keys(result.stats).sort()).toEqual(["happiness", "health", "knowledge", "relationships"]);
    expect(Object.keys(result.assets).sort()).toEqual([
      "annualExpenseMicroUsd",
      "annualIncomeMicroUsd",
      "balanceMicroUsd"
    ]);
    expect(Object.keys(result.lifeRng).sort()).toEqual(["domain", "initialState", "semanticDraws", "state"]);
    for (const banned of ["draws", "deltas", "raw", "history", "years", "entries", "snapshots"]) {
      expect(Object.keys(result)).not.toContain(banned);
    }
    expect(result.lifeRng.domain).toBe("life");
    expect(result.rollSpecVersion).toBe(SPEC);
  });
});

/* ------------------------------------------------------------------ */
/* 六、驗證與錯誤邊界                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2b 版本與形狀", () => {
  it("rollSpecVersion 錯誤一律 E_P3E_VERSION at rollSpecVersion", () => {
    for (const value of ["p3e-roll-9.9.9", "p3e-roll-1.0.1", "p3e-1.0.0", "1.0.0", 1, null, undefined, true]) {
      expectP3EError(
        () => resolveP3ERoll(asInput({ ...rawInput(), rollSpecVersion: value })),
        "E_P3E_VERSION",
        "rollSpecVersion"
      );
    }
  });

  it("版本檢查先於其他欄位（版本錯＋age 錯 → 版本錯）", () => {
    expectP3EError(
      () => resolveP3ERoll(asInput({ ...rawInput(), rollSpecVersion: "nope", age: -1 })),
      "E_P3E_VERSION",
      "rollSpecVersion"
    );
  });

  it("非物件／陣列／原型異常一律 E_P3E_ROLL at input", () => {
    class FakeInput {
      public rollSpecVersion = SPEC;
      public age = 30;
      public stats = baseInput().stats;
      public balanceMicroUsd = 1n;
      public lifeRng = baseInput().lifeRng;
    }
    const cases: readonly unknown[] = [
      undefined,
      null,
      42,
      "input",
      true,
      123n,
      [],
      [baseInput()],
      new Map(),
      new Date(),
      new FakeInput(),
      Object.create({ age: 30 }),
      () => baseInput()
    ];
    for (const value of cases) {
      expectP3EError(() => resolveP3ERoll(asInput(value)), "E_P3E_ROLL", "input");
    }
  });

  it("null prototype 的物件可以接受（仍要求鍵完全一致）", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, baseInput());
    expect(resolveP3ERoll(asInput(bare))).toEqual(resolveP3ERoll(baseInput()));
  });

  it("缺欄位與多欄位一律 E_P3E_ROLL at input", () => {
    for (const key of ["rollSpecVersion", "age", "stats", "balanceMicroUsd", "lifeRng"]) {
      const missing = rawInput();
      delete missing[key];
      expectP3EError(() => resolveP3ERoll(asInput(missing)), "E_P3E_ROLL", "input");
    }
    expectP3EError(() => resolveP3ERoll(asInput({ ...rawInput(), extra: 1 })), "E_P3E_ROLL", "input");

    // 鍵數相同但鍵名被換掉（不是「長度不符」，而是「集合不符」）
    const substituted = rawInput();
    delete substituted.age;
    substituted.years = 30;
    expectP3EError(() => resolveP3ERoll(asInput(substituted)), "E_P3E_ROLL", "input");

    const swappedStats = rawInput();
    const stats = { ...baseInput().stats } as Record<string, unknown>;
    delete stats.health;
    stats.healthPoints = 50;
    swappedStats.stats = stats;
    expectP3EError(() => resolveP3ERoll(asInput(swappedStats)), "E_P3E_ROLL", "stats");

    const swappedRng = rawInput();
    const lifeRng = { ...baseInput().lifeRng } as Record<string, unknown>;
    delete lifeRng.domain;
    lifeRng.domains = "life";
    swappedRng.lifeRng = lifeRng;
    expectP3EError(() => resolveP3ERoll(asInput(swappedRng)), "E_P3E_ROLL", "lifeRng");
  });

  it("不可列舉與 symbol 的多餘欄位也要拒絕", () => {
    const hidden = rawInput();
    Object.defineProperty(hidden, "hiddenExtra", { value: 1, enumerable: false, configurable: true });
    expectP3EError(() => resolveP3ERoll(asInput(hidden)), "E_P3E_ROLL", "input");

    const symbolKey = rawInput();
    Object.defineProperty(symbolKey, Symbol("extra"), { value: 1, enumerable: false, configurable: true });
    expectP3EError(() => resolveP3ERoll(asInput(symbolKey)), "E_P3E_ROLL", "input");

    // 必要欄位被改成不可列舉 = 實際缺欄位
    const nonEnumerableField = rawInput();
    Object.defineProperty(nonEnumerableField, "age", { value: 30, enumerable: false, configurable: true });
    expectP3EError(() => resolveP3ERoll(asInput(nonEnumerableField)), "E_P3E_ROLL", "input");

    const hiddenStats = rawInput();
    const stats = { ...baseInput().stats };
    Object.defineProperty(stats, "hiddenStat", { value: 1, enumerable: false, configurable: true });
    hiddenStats.stats = stats;
    expectP3EError(() => resolveP3ERoll(asInput(hiddenStats)), "E_P3E_ROLL", "stats");
  });

  it("拋例外的 getter／Proxy trap 折成固定 P3EError（不外洩原生例外）", () => {
    const throwing = rawInput();
    Object.defineProperty(throwing, "age", {
      enumerable: true,
      configurable: true,
      get() {
        throw new TypeError("boom");
      }
    });
    expectP3EError(() => resolveP3ERoll(asInput(throwing)), "E_P3E_ROLL", "input");

    const nested = rawInput();
    const badStats = { ...baseInput().stats };
    Object.defineProperty(badStats, "health", {
      enumerable: true,
      configurable: true,
      get() {
        throw new RangeError("boom");
      }
    });
    nested.stats = badStats;
    expectP3EError(() => resolveP3ERoll(asInput(nested)), "E_P3E_ROLL", "stats");

    const proxy = new Proxy({}, {
      ownKeys() {
        throw new Error("no keys");
      }
    });
    expectP3EError(() => resolveP3ERoll(asInput(proxy)), "E_P3E_ROLL", "input");
  });
});

describe("P3-E.1a-2b age 驗證", () => {
  it("非法 age 一律 E_P3E_ROLL at age", () => {
    for (const value of [-1, 121, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "30", null, undefined, 30n, true]) {
      expectP3EError(() => resolveP3ERoll(asInput({ ...rawInput(), age: value })), "E_P3E_ROLL", "age");
    }
  });

  it("age 邊界 0 與 120 合法", () => {
    expect(resolveP3ERoll(baseInput({ age: 0 })).assets.annualIncomeMicroUsd).toBe(0n);
    expect(resolveP3ERoll(baseInput({ age: 120 })).assets.annualExpenseMicroUsd).toBe(9_500_000_000n);
  });
});

describe("P3-E.1a-2b stats 驗證", () => {
  it("stats 形狀錯誤一律 E_P3E_ROLL at stats", () => {
    const cases: readonly unknown[] = [
      null,
      undefined,
      50,
      "stats",
      [],
      [50, 50, 50, 50],
      { health: 50, happiness: 50, knowledge: 50 },
      { health: 50, happiness: 50, knowledge: 50, relationships: 50, extra: 1 },
      new Map()
    ];
    for (const value of cases) {
      expectP3EError(() => resolveP3ERoll(asInput({ ...rawInput(), stats: value })), "E_P3E_ROLL", "stats");
    }
  });

  it("stats 值錯誤一律 E_P3E_ROLL at stats.<欄位>", () => {
    const bad: readonly [string, unknown][] = [
      ["health", -1],
      ["health", 101],
      ["health", 1.5],
      ["health", Number.NaN],
      ["health", "50"],
      ["health", null],
      ["happiness", -1],
      ["happiness", 101],
      ["knowledge", -1],
      ["knowledge", 101],
      ["relationships", -1],
      ["relationships", 101]
    ];
    for (const [key, value] of bad) {
      const stats = { ...baseInput().stats, [key]: value };
      expectP3EError(() => resolveP3ERoll(asInput({ ...rawInput(), stats })), "E_P3E_ROLL", `stats.${key}`);
    }
  });

  it("stats 邊界 0 與 100 合法", () => {
    const low = resolveP3ERoll(baseInput({ stats: { health: 0, happiness: 0, knowledge: 0, relationships: 0 } }));
    const high = resolveP3ERoll(baseInput({ stats: { health: 100, happiness: 100, knowledge: 100, relationships: 100 } }));
    for (const value of Object.values(low.stats)) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of Object.values(high.stats)) expect(value).toBeLessThanOrEqual(100);
  });
});

describe("P3-E.1a-2b.1 balance 驗證（允許負值，但受 Money 上下界限制）", () => {
  it("不是 bigint 一律 E_P3E_ROLL at balanceMicroUsd", () => {
    for (const value of [1, "1", null, undefined, true, {}, [], Number.NaN]) {
      expectP3EError(
        () => resolveP3ERoll(asInput({ ...rawInput(), balanceMicroUsd: value })),
        "E_P3E_ROLL",
        "balanceMicroUsd"
      );
    }
  });

  it("負 bigint 合法（−1n 不再是錯誤）", () => {
    expect(() => resolveP3ERoll(baseInput({ balanceMicroUsd: -1n }))).not.toThrow();
    expect(resolveP3ERoll(baseInput({ age: 0, balanceMicroUsd: -1n })).assets.balanceMicroUsd).toBe(0n);
  });

  it("超出 Money 上下界一律 E_P3E_MONEY at balanceMicroUsd", () => {
    for (const value of [MIN_MONEY_PPP_MICRO - 1n, MAX_MONEY_PPP_MICRO + 1n, MAX_MONEY_PPP_MICRO * 2n]) {
      expectP3EError(
        () => resolveP3ERoll(asInput({ ...rawInput(), balanceMicroUsd: value })),
        "E_P3E_MONEY",
        "balanceMicroUsd"
      );
    }
  });

  it("balance 0n 合法", () => {
    const zero = resolveP3ERoll(baseInput({ age: 0, balanceMicroUsd: 0n }));
    expect(zero.assets.balanceMicroUsd).toBe(0n);
    const aged = resolveP3ERoll(baseInput({ age: 30, balanceMicroUsd: 0n }));
    expect(aged.assets.balanceMicroUsd).toBe(15_325_000_000n);
  });
});

describe("P3-E.1a-2b lifeRng 驗證", () => {
  it("lifeRng 形狀錯誤一律 E_P3E_ROLL at lifeRng", () => {
    const cases: readonly unknown[] = [
      null,
      undefined,
      42,
      "rng",
      [],
      [1, 2, 3, 4],
      { domain: "life", initialState: RNG_INITIAL, state: RNG_STATE },
      { domain: "life", initialState: RNG_INITIAL, state: RNG_STATE, semanticDraws: 0, extra: 1 },
      new Map()
    ];
    for (const value of cases) {
      expectP3EError(() => resolveP3ERoll(asInput({ ...rawInput(), lifeRng: value })), "E_P3E_ROLL", "lifeRng");
    }
  });

  it("domain 必須是 life", () => {
    for (const domain of ["events", "p3e/death", "", null, 1]) {
      const lifeRng = { ...baseInput().lifeRng, domain };
      expectP3EError(() => resolveP3ERoll(asInput({ ...rawInput(), lifeRng })), "E_P3E_ROLL", "lifeRng.domain");
    }
  });

  it("initialState／state 必須是四個合法 u32 且不得全零", () => {
    const badWords: readonly unknown[] = [
      null,
      undefined,
      "1234",
      [],
      [1, 2, 3],
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4.5],
      [-1, 2, 3, 4],
      [1, 2, 3, 0x1_0000_0000],
      [Number.NaN, 2, 3, 4],
      ["1", 2, 3, 4],
      [0, 0, 0, 0]
    ];
    for (const words of badWords) {
      for (const field of ["initialState", "state"] as const) {
        const lifeRng = { ...baseInput().lifeRng, [field]: words };
        expectP3EError(() => resolveP3ERoll(asInput({ ...rawInput(), lifeRng })), "E_P3E_ROLL", `lifeRng.${field}`);
      }
    }
  });

  it("semanticDraws 非法與溢位一律 E_P3E_ROLL at lifeRng.semanticDraws", () => {
    const badDraws: readonly unknown[] = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "8",
      null,
      undefined,
      8n,
      Number.MAX_SAFE_INTEGER - 3,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER - 4 + 1
    ];
    for (const semanticDraws of badDraws) {
      const lifeRng = { ...baseInput().lifeRng, semanticDraws };
      expectP3EError(() => resolveP3ERoll(asInput({ ...rawInput(), lifeRng })), "E_P3E_ROLL", "lifeRng.semanticDraws");
    }
  });

  it("semanticDraws 溢位邊界：MAX-4 可以（+4 剛好等於 MAX_SAFE_INTEGER）", () => {
    const start = Number.MAX_SAFE_INTEGER - 4;
    const lifeRng = { ...baseInput().lifeRng, semanticDraws: start };
    const result = resolveP3ERoll(asInput({ ...rawInput(), lifeRng }));
    expect(result.lifeRng.semanticDraws).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(result.lifeRng.semanticDraws)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 六點五、反射邊界（必修 1：已撤銷 Proxy 與 tuple 反射）              */
/* ------------------------------------------------------------------ */

/** 已撤銷的物件 Proxy：任何反射動作（含 `Array.isArray`）都會拋原生 TypeError。 */
function revokedObject(): unknown {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
}

/** 已撤銷的陣列 Proxy。 */
function revokedWords(): unknown {
  const revocable = Proxy.revocable([1, 2, 3, 4], {});
  revocable.revoke();
  return revocable.proxy;
}

/** 以 baseInput 為底，替換 lifeRng 的單一欄位（給 tuple 反例用）。 */
function inputWithRng(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...rawInput(), lifeRng: { ...baseInput().lifeRng, ...patch } };
}

describe("P3-E.1a-2b.1 反射邊界：已撤銷的 Proxy", () => {
  it("已撤銷的頂層 Proxy → E_P3E_ROLL at input（不外洩 TypeError）", () => {
    expectP3EError(() => resolveP3ERoll(asInput(revokedObject())), "E_P3E_ROLL", "input");
  });

  it("已撤銷的 stats Proxy → E_P3E_ROLL at stats", () => {
    expectP3EError(() => resolveP3ERoll(asInput({ ...rawInput(), stats: revokedObject() })), "E_P3E_ROLL", "stats");
  });

  it("已撤銷的 lifeRng Proxy → E_P3E_ROLL at lifeRng", () => {
    expectP3EError(() => resolveP3ERoll(asInput({ ...rawInput(), lifeRng: revokedObject() })), "E_P3E_ROLL", "lifeRng");
  });

  it("已撤銷的 initialState Proxy → E_P3E_ROLL at lifeRng.initialState", () => {
    expectP3EError(
      () => resolveP3ERoll(asInput(inputWithRng({ initialState: revokedWords() }))),
      "E_P3E_ROLL",
      "lifeRng.initialState"
    );
  });

  it("已撤銷的 state Proxy → E_P3E_ROLL at lifeRng.state", () => {
    expectP3EError(() => resolveP3ERoll(asInput(inputWithRng({ state: revokedWords() }))), "E_P3E_ROLL", "lifeRng.state");
  });

  it("getPrototypeOf／ownKeys／欄位讀取會拋錯的 Proxy 都只回固定錯誤", () => {
    const protoThrows = new Proxy({}, {
      getPrototypeOf() {
        throw new TypeError("proto");
      }
    });
    expectP3EError(() => resolveP3ERoll(asInput(protoThrows)), "E_P3E_ROLL", "input");

    const ownKeysThrows = new Proxy({}, {
      ownKeys() {
        throw new TypeError("ownKeys");
      }
    });
    expectP3EError(() => resolveP3ERoll(asInput(ownKeysThrows)), "E_P3E_ROLL", "input");

    const getThrows = new Proxy({ ...baseInput() }, {
      get() {
        throw new TypeError("get");
      }
    });
    expectP3EError(() => resolveP3ERoll(asInput(getThrows)), "E_P3E_ROLL", "input");

    const descriptorThrows = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new TypeError("gopd");
      }
    });
    expectP3EError(() => resolveP3ERoll(asInput(descriptorThrows)), "E_P3E_ROLL", "input");
  });
});

describe("P3-E.1a-2b.1 反射邊界：tuple", () => {
  it("length getter 拋錯的 tuple → E_P3E_ROLL at 對應 path", () => {
    const badLength = new Proxy([1, 2, 3, 4], {
      get(target, key, receiver) {
        if (key === "length") throw new TypeError("length");
        return Reflect.get(target, key, receiver);
      }
    });
    for (const field of ["initialState", "state"] as const) {
      expectP3EError(
        () => resolveP3ERoll(asInput(inputWithRng({ [field]: badLength }))),
        "E_P3E_ROLL",
        `lifeRng.${field}`
      );
    }
  });

  it("ownKeys trap 拋錯的 tuple → E_P3E_ROLL at 對應 path", () => {
    const badKeys = new Proxy([1, 2, 3, 4], {
      ownKeys() {
        throw new TypeError("ownKeys");
      }
    });
    expectP3EError(() => resolveP3ERoll(asInput(inputWithRng({ state: badKeys }))), "E_P3E_ROLL", "lifeRng.state");
    expectP3EError(
      () => resolveP3ERoll(asInput(inputWithRng({ initialState: badKeys }))),
      "E_P3E_ROLL",
      "lifeRng.initialState"
    );
  });

  it("索引 accessor（throwing getter）一律拒絕，而且 getter 不會被呼叫", () => {
    let invoked = false;
    const words: number[] = [1, 2, 3, 4];
    Object.defineProperty(words, "1", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        throw new Error("boom");
      }
    });
    expectP3EError(() => resolveP3ERoll(asInput(inputWithRng({ state: words }))), "E_P3E_ROLL", "lifeRng.state");
    expect(invoked).toBe(false);
  });

  it("額外字串鍵、不可列舉的隱藏鍵、symbol 鍵都被拒絕", () => {
    const extra: unknown[] = [1, 2, 3, 4];
    Object.defineProperty(extra, "extra", { value: 1, enumerable: true, configurable: true });
    expectP3EError(() => resolveP3ERoll(asInput(inputWithRng({ state: extra }))), "E_P3E_ROLL", "lifeRng.state");

    const hidden: unknown[] = [1, 2, 3, 4];
    Object.defineProperty(hidden, "hidden", { value: 1, enumerable: false, configurable: true });
    expectP3EError(
      () => resolveP3ERoll(asInput(inputWithRng({ initialState: hidden }))),
      "E_P3E_ROLL",
      "lifeRng.initialState"
    );

    const tagged: unknown[] = [1, 2, 3, 4];
    Object.defineProperty(tagged, Symbol("tag"), { value: 1, enumerable: false, configurable: true });
    expectP3EError(() => resolveP3ERoll(asInput(inputWithRng({ state: tagged }))), "E_P3E_ROLL", "lifeRng.state");
  });

  it("稀疏 tuple（有洞）也被拒絕", () => {
    const sparse: number[] = [1, 2, 3, 4];
    delete sparse[1];
    expectP3EError(() => resolveP3ERoll(asInput(inputWithRng({ state: sparse }))), "E_P3E_ROLL", "lifeRng.state");
  });

  it("ownKeys 回報的鍵名不是 0..3＋length 時被拒絕", () => {
    const fakeKeys = new Proxy([1, 2, 3, 4], {
      ownKeys: () => ["a", "b", "c", "d", "length"]
    });
    expectP3EError(() => resolveP3ERoll(asInput(inputWithRng({ state: fakeKeys }))), "E_P3E_ROLL", "lifeRng.state");
  });

  it("getOwnPropertyDescriptor 回 undefined 的 tuple 被拒絕（不會誤讀）", () => {
    const missingDescriptor = new Proxy([1, 2, 3, 4], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "0") return undefined;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    expectP3EError(
      () => resolveP3ERoll(asInput(inputWithRng({ initialState: missingDescriptor }))),
      "E_P3E_ROLL",
      "lifeRng.initialState"
    );
  });

  it("合法的 tuple 仍然可以通過（含凍結的 tuple）", () => {
    const frozen = Object.freeze([RNG_STATE[0], RNG_STATE[1], RNG_STATE[2], RNG_STATE[3]]);
    const result = resolveP3ERoll(asInput(inputWithRng({ state: frozen })));
    expect(result.lifeRng.state).toEqual(manualRoll(RNG_STATE).state);
    const normal = resolveP3ERoll(asInput(inputWithRng({ state: [...RNG_STATE] })));
    expect(normal.lifeRng.state).toEqual(result.lifeRng.state);
  });
});

describe("P3-E.1a-2b RNG 邊界", () => {
  it("非法 state 的 RNG 例外折成 E_P3E_RNG at rng", () => {
    const badStates: readonly unknown[] = [
      [1, 2, 3],
      [1, 2, 3, 0x1_0000_0000],
      [1, 2, 3, -1],
      [1.5, 2, 3, 4],
      "abcd",
      null,
      undefined
    ];
    for (const value of badStates) {
      expectP3EError(() => drawP3ERollDeltas(value as contracts.P3EWordTuple), "E_P3E_RNG", "rng");
    }
  });

  it("全零 tuple 交給 engine 時走 fallback（公開入口已在前面拒絕）", () => {
    const zero: contracts.P3EWordTuple = [0, 0, 0, 0];
    // engine 的 validateState 會把全零換成 FALLBACK_RNG_STATE，因此這裡不會拋
    const draws = drawP3ERollDeltas(zero);
    const manual = manualRoll([0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef]);
    expect(draws.state).toEqual(manual.state);
    // 但公開入口不接受全零游標
    expectP3EError(
      () => resolveP3ERoll(asInput({ ...rawInput(), lifeRng: { ...baseInput().lifeRng, state: zero } })),
      "E_P3E_ROLL",
      "lifeRng.state"
    );
  });

  it("drawP3ERollDeltas 是純函式且不改輸入", () => {
    const state: contracts.P3EWordTuple = [RNG_STATE[0], RNG_STATE[1], RNG_STATE[2], RNG_STATE[3]];
    const snapshot = [...state];
    const first = drawP3ERollDeltas(state);
    const second = drawP3ERollDeltas(state);
    expect(second).toEqual(first);
    expect([...state]).toEqual(snapshot);
    expect(Object.isFrozen(first.state)).toBe(true);
  });
});
