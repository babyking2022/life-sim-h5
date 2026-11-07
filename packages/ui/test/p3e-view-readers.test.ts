import { describe, expect, it } from "vitest";
import {
  ellipsizeName,
  readComparisonView,
  readPartnerIdentity
} from "../src/p3e-view-readers";

/**
 * GPT-0036-B：UI 只用相容型 type guard 接 DeepSeek 的平行 projection。
 * 這些測試刻意涵蓋「對方檔案還沒上線」以及「欄位命名不同」兩種情況。
 */
describe("readComparisonView（收入／資產比較）", () => {
  it("projection 缺席時顯示自然文案，不顯示 0 百分位或 internal key", () => {
    const result = readComparisonView({ age: 40 }, 40);
    expect(result.source).toBe("missing");
    expect(result.income.available).toBe(false);
    expect(result.wealth.available).toBe(false);
    expect(result.income.text).toContain("準備中");
    expect(result.wealth.text).toContain("準備中");
    expect(result.income.text).not.toMatch(/0%/);
    expect(result.note).toContain("估算");
  });

  it("兒童永不顯示百分位，即使 projection 給了數值", () => {
    const view = {
      comparisons: {
        income: { available: true, chinaPercent: 88, globalPercent: 92 },
        wealth: { available: true, chinaPercent: 70, globalPercent: 80 }
      }
    };
    const child = readComparisonView(view, 9);
    expect(child.income.text).toContain("未成年");
    expect(child.wealth.text).toContain("未成年");
    expect(child.income.text).not.toMatch(/%/);
    const teen = readComparisonView(view, 16);
    expect(teen.income.available).toBe(true);
    expect(teen.wealth.text).toContain("未成年"); // 資產門檻 18 歲
  });

  it("接受 DeepSeek 的 available/chinaPercent/globalPercent 形狀", () => {
    const result = readComparisonView(
      {
        percentiles: {
          income: { available: true, chinaPercent: 72.4, globalPercent: 88.1, meta: { basisYear: 2021 } },
          wealth: { available: true, chinaPercent: 65, globalPercent: 74 }
        }
      },
      40
    );
    expect(result.source).toBe("projection");
    expect(result.income.text).toBe("高於中國 72%｜高於全球 88%");
    expect(result.wealth.text).toBe("高於中國 65%｜高於全球 74%");
  });

  it("接受 percentile 匯出的現成字串與扁平欄位", () => {
    const byString = readComparisonView(
      {
        incomeComparison: "高於中國 72%｜高於全球 88%",
        assetComparison: "高於中國 65%｜高於全球 74%"
      },
      40
    );
    expect(byString.source).toBe("projection");
    expect(byString.income.text).toContain("高於中國 72%");
    expect(byString.wealth.text).toContain("高於全球 74%");
  });

  it("unavailable reason 與惡意／畸形值都不會變成假數字", () => {
    const result = readComparisonView(
      {
        comparisons: {
          income: { available: false, reason: "no_income" },
          wealth: { available: true, chinaPercent: Number.NaN, globalPercent: 500 }
        }
      },
      40
    );
    expect(result.income.available).toBe(false);
    expect(result.income.reason).toBe("no_income");
    expect(result.wealth.available).toBe(false);
    expect(result.wealth.text).not.toMatch(/500/);
    const leaked = readComparisonView(
      { comparisons: { income: "p3b.ev.secret 高於中國 99%" } },
      40
    );
    expect(leaked.income.available).toBe(false);
  });

  it("基準年出现在估算说明中", () => {
    const result = readComparisonView({ percentileMeta: { basisYear: 2021 } }, 40);
    expect(result.basisYear).toBe(2021);
    expect(result.note).toContain("2021");
  });

  it("直接吃 GPT-DEEPSEEK-0036-A 的正式 view.percentiles 形狀", () => {
    const view = {
      percentiles: {
        income: {
          available: true,
          chinaPercent: 72.4,
          globalPercent: 88.1,
          summary: "高於中國 72%｜高於全球 88%",
          reason: null,
          meta: { basisYear: 2021, estimate: true }
        },
        wealth: {
          available: true,
          chinaPercent: 65,
          globalPercent: 74,
          summary: "高於中國 65%｜高於全球 74%",
          reason: null,
          meta: { basisYear: 2021, estimate: true }
        }
      }
    };
    const adult = readComparisonView(view, 40);
    expect(adult.source).toBe("projection");
    expect(adult.basisYear).toBe(2021);
    expect(adult.note).toContain("2021");
    expect(adult.income.text).toBe("高於中國 72%｜高於全球 88%");
    expect(adult.wealth.text).toBe("高於中國 65%｜高於全球 74%");

    const noIncome = readComparisonView(
      {
        percentiles: {
          income: { available: false, reason: "no_income", summary: "估算不可用" },
          wealth: { available: true, chinaPercent: 10, globalPercent: 12 }
        }
      },
      40
    );
    expect(noIncome.income.text).toContain("沒有收入");
    expect(noIncome.income.text).not.toMatch(/no_income/);
    expect(readComparisonView(view, 9).income.text).toContain("未成年");
  });
});

describe("readPartnerIdentity（具名伴侶）", () => {
  it("沒有 partner 欄位時回傳 null，不產生假名字", () => {
    expect(readPartnerIdentity({ age: 30 })).toBeNull();
    expect(readPartnerIdentity(null)).toBeNull();
    expect(readPartnerIdentity({ partner: null })).toBeNull();
  });

  it("讀取正式 projection 的 displayName／status／sinceYear", () => {
    const partner = readPartnerIdentity({
      partner: { displayName: "陳怡君", status: "partner", sinceYear: 2038 }
    });
    expect(partner).toEqual({ displayName: "陳怡君", status: "partner", sinceYear: 2038 });
  });

  it("相容不同命名，但拒絕泛稱、internal key 與標記語法", () => {
    expect(readPartnerIdentity({ partnerView: { name: "王大明" } })?.displayName).toBe("王大明");
    expect(readPartnerIdentity({ partner: { displayName: "伴侶" } })).toBeNull();
    expect(readPartnerIdentity({ partner: { displayName: "ev.adult.relationship" } })).toBeNull();
    expect(readPartnerIdentity({ partner: { displayName: "<img src=x>" } })).toBeNull();
    expect(readPartnerIdentity({ partner: { displayName: "未知" } })).toBeNull();
  });

  it("过长姓名视觉省略，但原始名字完整保留", () => {
    const long = "歐陽娜娜娜娜娜娜娜娜娜娜娜";
    expect(readPartnerIdentity({ partner: { displayName: long } })?.displayName).toBe(long);
    const short = ellipsizeName(long, 8);
    expect(short.endsWith("…")).toBe(true);
    expect(short.length).toBe(8);
    expect(ellipsizeName("陳怡君")).toBe("陳怡君");
  });
});
