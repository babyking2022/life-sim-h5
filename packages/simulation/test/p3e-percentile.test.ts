import { describe, expect, it } from "vitest";
import * as contracts from "@life-sim/contracts";

/**
 * GPT-DEEPSEEK-0036-A｜收入與資產百分位（MVP 估算）單元測試。
 *
 * 覆蓋：
 * - 門檻表本身（單調、版本、基準年、口徑）；
 * - 插值單調、邊界（0／負值／極大值／剛好等於門檻）；
 * - 兒童與未就業的 unavailable；
 * - 同輸入同輸出（可重播）；
 * - 字串格式是「高於中國 X%｜高於全球 Y%」。
 */

const USD = 1_000_000n;

function income(age: number, dollarsPerYear: number, status = "employed") {
  return contracts.estimateIncomePercentileMicroUsd({
    age,
    annualIncomeMicroUsd: BigInt(dollarsPerYear) * USD,
    employmentStatus: status
  });
}

function wealth(age: number, dollars: number) {
  return contracts.estimateWealthPercentileMicroUsd({ age, balanceMicroUsd: BigInt(dollars) * USD });
}

describe("GPT-0036-A 百分位門檻表", () => {
  it("四張表都存在、版本與基準年固定、百分位嚴格遞增且門檻嚴格遞增", () => {
    const tables = [
      contracts.P3E_INCOME_THRESHOLDS_CHINA,
      contracts.P3E_INCOME_THRESHOLDS_GLOBAL,
      contracts.P3E_WEALTH_THRESHOLDS_CHINA,
      contracts.P3E_WEALTH_THRESHOLDS_GLOBAL
    ];
    expect(contracts.P3E_PERCENTILE_TABLE_VERSION).toBe("p3e-percentile-1.0.0");
    expect(contracts.P3E_PERCENTILE_BASIS_YEAR).toBe(2021);
    for (const table of tables) {
      expect(table.length).toBeGreaterThanOrEqual(6);
      for (let index = 1; index < table.length; index += 1) {
        const previous = table[index - 1] as contracts.P3EPercentileThresholdPoint;
        const current = table[index] as contracts.P3EPercentileThresholdPoint;
        expect(current.percentile, `percentile #${index}`).toBeGreaterThan(previous.percentile);
        expect(current.thresholdMicroUsd, `threshold #${index}`).toBeGreaterThan(previous.thresholdMicroUsd);
      }
      expect((table[table.length - 1] as contracts.P3EPercentileThresholdPoint).percentile).toBe(99.9);
      expect(Object.isFrozen(table)).toBe(true);
    }
  });

  it("插值單調：收入越高，百分位不減", () => {
    let previous = -1;
    for (const dollars of [500, 1_200, 2_600, 5_500, 11_000, 21_000, 32_000, 90_000, 300_000, 1_000_000]) {
      const result = income(30, dollars);
      expect(result.available).toBe(true);
      if (!result.available) return;
      expect(result.chinaPercent, `china ${dollars}`).toBeGreaterThanOrEqual(previous);
      previous = result.chinaPercent;
    }
  });

  it("門檻點本身對應到表格上的百分位（誤差 <= 0.05）", () => {
    const table = contracts.P3E_INCOME_THRESHOLDS_CHINA;
    for (const point of table) {
      const value = contracts.percentileFromThresholds(point.thresholdMicroUsd, table);
      expect(Math.abs(value - point.percentile), `p${point.percentile}`).toBeLessThanOrEqual(0.05);
    }
  });

  it("邊界：極大值封頂 99.9、0 與負資產落在最低區間且不 crash", () => {
    expect(contracts.percentileFromThresholds(10n ** 15n, contracts.P3E_INCOME_THRESHOLDS_CHINA)).toBe(99.9);
    expect(contracts.percentileFromThresholds(0n, contracts.P3E_WEALTH_THRESHOLDS_CHINA)).toBe(0);
    const negative = wealth(30, -50_000);
    expect(negative.available).toBe(true);
    if (!negative.available) return;
    expect(negative.chinaPercent).toBe(0);
    expect(negative.globalPercent).toBe(0);
    expect(Number.isNaN(negative.chinaPercent)).toBe(false);
  });
});

describe("GPT-0036-A 百分位可用性（unavailable 規則）", () => {
  it("未滿 16 歲：收入 unavailable（不把兒童顯示成收入第幾名）", () => {
    for (const age of [0, 5, 15]) {
      const result = income(age, 12_000);
      expect(result.available, `age ${age}`).toBe(false);
      if (result.available) return;
      expect(result.reason).toBe("age_below_minimum");
    }
    expect(income(16, 12_000).available).toBe(true);
  });

  it("收入 <= 0 或未就業：available: false 並且有明確 reason", () => {
    const zero = income(30, 0);
    expect(zero.available).toBe(false);
    if (!zero.available) expect(zero.reason).toBe("no_income");

    const negative = contracts.estimateIncomePercentileMicroUsd({
      age: 30,
      annualIncomeMicroUsd: -1n,
      employmentStatus: "employed"
    });
    expect(negative.available).toBe(false);

    const notEmployed = income(30, 12_000, "none");
    expect(notEmployed.available).toBe(false);
    if (!notEmployed.available) expect(notEmployed.reason).toBe("not_employed");

    const student = income(30, 12_000, "student");
    expect(student.available).toBe(false);
  });

  it("未滿 18 歲：資產 unavailable；18 歲起可用（含 0 與負值）", () => {
    for (const age of [0, 12, 17]) {
      const result = wealth(age, 50_000);
      expect(result.available, `age ${age}`).toBe(false);
      if (result.available) return;
      expect(result.reason).toBe("age_below_minimum");
    }
    expect(wealth(18, 0).available).toBe(true);
    expect(wealth(18, -1).available).toBe(true);
  });
});

describe("GPT-0036-A 百分位輸出（決定性、口徑、字串）", () => {
  it("同輸入同輸出（可重播）", () => {
    const first = income(35, 29_325);
    const second = income(35, 29_325);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("輸出附上『估算』口徑：estimate／基準年／單位／價格基準／方法／版本", () => {
    const result = income(35, 29_325);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.meta.estimate).toBe(true);
    expect(result.meta.basisYear).toBe(2021);
    expect(result.meta.currency).toBe("USD");
    expect(result.meta.unit).toBe("micro-USD");
    expect(result.meta.priceBasis).toBe("ppp-2017");
    expect(result.meta.method).toBe("static-threshold-monotone-interpolation");
    expect(result.meta.tableVersion).toBe(contracts.P3E_PERCENTILE_TABLE_VERSION);
    expect(result.meta.metric).toBe("annual-income");
    // GPT-DEEPSEEK-0037-A：metadata 必須自帶來源，且明示是 MVP 估算占位。
    expect(result.meta.dataStatus).toBe("mvp_estimate");
    expect(result.meta.sourceLabel).toContain("World Bank PIP");
    expect(result.meta.sourceUrl).toBe("https://pip.worldbank.org/");
    expect(result.chinaPercent).toBeGreaterThanOrEqual(0);
    expect(result.chinaPercent).toBeLessThanOrEqual(99.9);
  });

  it("資產 metadata 指向 WID comparator（不是收入來源）", () => {
    const result = wealth(30, 50_000);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.meta.metric).toBe("net-financial-wealth");
    expect(result.meta.dataStatus).toBe("mvp_estimate");
    expect(result.meta.sourceLabel).toContain("World Inequality Database");
    expect(result.meta.sourceUrl).toBe("https://wid.world/");
  });

  it("字串格式固定為『高於中國 X%｜高於全球 Y%』（可用時）與『估算不可用』（不可用時）", () => {
    const available = income(35, 29_325);
    expect(contracts.formatPercentileSummary(available)).toMatch(/^高於中國 \d+%｜高於全球 \d+%$/);
    const unavailable = income(5, 0);
    expect(contracts.formatPercentileSummary(unavailable)).toBe("估算不可用");
  });
});
