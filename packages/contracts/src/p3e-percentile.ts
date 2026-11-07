/**
 * GPT-DEEPSEEK-0036-A｜收入與資產百分位（MVP 估算、離線、可重播）。
 *
 * ## 語意
 *
 * 回傳的是「**高於多少比例的人**」：例如 `chinaPercent = 82.4` 代表
 * 「高於中國 82.4% 的人（估算）」，**不是**「第 82 名」或「前 18%」。
 * 數值域是 `0..99.9`，一位小數；UI 可自行四捨五入成整數。
 *
 * ## 資料口徑（MVP 靜態門檻表）
 *
 * 這一輪**沒有**連接任何外部 API，也不在 bundle 放原始大型資料集；改用一份
 * 版本化的小型分位門檻表（見 `docs/gpt-0036-percentile-data.md`）：
 *
 * - 收入：World Bank PIP（Poverty and Inequality Platform）風格的
 *   **PPP 2017 國際美元、年所得** 分位門檻（`estimateIncomePercentileMicroUsd`）；
 * - 資產：World Inequality Database（WID）Income and Wealth Comparator 風格的
 *   **個人淨金融資產、PPP 國際美元** 分位門檻（`estimateWealthPercentileMicroUsd`）。
 *
 * 兩張表都是 **MVP 估算**（`estimate: true`），不是官方即時排名。基準年固定、
 * 版本號固定，因此同一個輸入永遠得到同一個輸出（可重播、離線）。
 *
 * ## 邊界
 *
 * - 收入：未滿 16 歲、`income <= 0` 或未就業（`employmentStatus` 為 `none`／`student`）
 *   → `available: false`（不把兒童或無收入者顯示成「收入第幾名」）；
 * - 資產：未滿 18 歲 → `available: false`；`balance < 0` 視為最低區間（0%），
 *   不會 crash、也不會變成 `NaN`；
 * - 所有比較都標示 `estimate: true` 並附上基準年、單位、來源與方法。
 */

/** 門檻表版本（換表就要換版本，讓 UI／報告可以標示）。 */
export const P3E_PERCENTILE_TABLE_VERSION = "p3e-percentile-1.0.0";

/** 基準年：門檻表對應的西元年（收入與資產都用同一年，避免混用）。 */
export const P3E_PERCENTILE_BASIS_YEAR = 2021;

/** 百分位計算的上下界（0–99.9，一位小數）。 */
export const P3E_PERCENTILE_MIN = 0;
export const P3E_PERCENTILE_MAX = 99.9;

/** 收入百分位可用的最低年齡（與個人經濟的 16 歲一致）。 */
export const P3E_PERCENTILE_MIN_INCOME_AGE = 16;

/** 資產百分位可用的最低年齡。 */
export const P3E_PERCENTILE_MIN_WEALTH_AGE = 18;

/** 一個分位門檻點：`percentile` 的人所得（或資產）低於 `thresholdMicroUsd`。 */
export interface P3EPercentileThresholdPoint {
  /** 0–99.9（一位小數）。 */
  readonly percentile: number;
  /** 對應的門檻金額（micro-USD；1 USD = 1,000,000 micro-USD）。 */
  readonly thresholdMicroUsd: bigint;
}

const USD = 1_000_000n;

/** 把「美元概念值」換成 micro-USD，避免表格手寫時搞錯數量級。 */
function usd(dollars: number): bigint {
  return BigInt(dollars) * USD;
}

/**
 * 中國年所得分位門檻（PPP 2017 國際美元；MVP 估算）。
 *
 * 對照：城鄉加權後的家庭人均可支配所得中位數約 3–4 萬人民幣，
 * 以 PPP 換算約 5,500 美元／年 —— 這是 p50 錨點；其餘點以 PIP 的分位形狀內插。
 */
export const P3E_INCOME_THRESHOLDS_CHINA: readonly P3EPercentileThresholdPoint[] = Object.freeze([
  Object.freeze({ percentile: 10, thresholdMicroUsd: usd(1_200) }),
  Object.freeze({ percentile: 25, thresholdMicroUsd: usd(2_600) }),
  Object.freeze({ percentile: 50, thresholdMicroUsd: usd(5_500) }),
  Object.freeze({ percentile: 75, thresholdMicroUsd: usd(11_000) }),
  Object.freeze({ percentile: 90, thresholdMicroUsd: usd(21_000) }),
  Object.freeze({ percentile: 95, thresholdMicroUsd: usd(32_000) }),
  Object.freeze({ percentile: 99, thresholdMicroUsd: usd(90_000) }),
  Object.freeze({ percentile: 99.9, thresholdMicroUsd: usd(300_000) })
]);

/** 全球年所得分位門檻（PPP 2017 國際美元；MVP 估算）。 */
export const P3E_INCOME_THRESHOLDS_GLOBAL: readonly P3EPercentileThresholdPoint[] = Object.freeze([
  Object.freeze({ percentile: 10, thresholdMicroUsd: usd(800) }),
  Object.freeze({ percentile: 25, thresholdMicroUsd: usd(1_700) }),
  Object.freeze({ percentile: 50, thresholdMicroUsd: usd(3_400) }),
  Object.freeze({ percentile: 75, thresholdMicroUsd: usd(7_800) }),
  Object.freeze({ percentile: 90, thresholdMicroUsd: usd(18_000) }),
  Object.freeze({ percentile: 95, thresholdMicroUsd: usd(30_000) }),
  Object.freeze({ percentile: 99, thresholdMicroUsd: usd(95_000) }),
  Object.freeze({ percentile: 99.9, thresholdMicroUsd: usd(450_000) })
]);

/** 中國個人淨金融資產分位門檻（PPP 國際美元；MVP 估算）。 */
export const P3E_WEALTH_THRESHOLDS_CHINA: readonly P3EPercentileThresholdPoint[] = Object.freeze([
  Object.freeze({ percentile: 10, thresholdMicroUsd: usd(0) }),
  Object.freeze({ percentile: 25, thresholdMicroUsd: usd(2_000) }),
  Object.freeze({ percentile: 50, thresholdMicroUsd: usd(12_000) }),
  Object.freeze({ percentile: 75, thresholdMicroUsd: usd(45_000) }),
  Object.freeze({ percentile: 90, thresholdMicroUsd: usd(140_000) }),
  Object.freeze({ percentile: 95, thresholdMicroUsd: usd(300_000) }),
  Object.freeze({ percentile: 99, thresholdMicroUsd: usd(1_000_000) }),
  Object.freeze({ percentile: 99.9, thresholdMicroUsd: usd(5_000_000) })
]);

/** 全球個人淨金融資產分位門檻（PPP 國際美元；MVP 估算）。 */
export const P3E_WEALTH_THRESHOLDS_GLOBAL: readonly P3EPercentileThresholdPoint[] = Object.freeze([
  Object.freeze({ percentile: 10, thresholdMicroUsd: usd(0) }),
  Object.freeze({ percentile: 25, thresholdMicroUsd: usd(500) }),
  Object.freeze({ percentile: 50, thresholdMicroUsd: usd(4_000) }),
  Object.freeze({ percentile: 75, thresholdMicroUsd: usd(25_000) }),
  Object.freeze({ percentile: 90, thresholdMicroUsd: usd(110_000) }),
  Object.freeze({ percentile: 95, thresholdMicroUsd: usd(250_000) }),
  Object.freeze({ percentile: 99, thresholdMicroUsd: usd(1_000_000) }),
  Object.freeze({ percentile: 99.9, thresholdMicroUsd: usd(6_000_000) })
]);

/** 估算結果的中繼資料（UI 要顯示「估算」與資料口徑）。 */
export interface P3EPercentileMeta {
  readonly estimate: true;
  readonly tableVersion: string;
  readonly basisYear: number;
  readonly currency: "USD";
  readonly unit: "micro-USD";
  readonly priceBasis: "ppp-2017";
  readonly method: "static-threshold-monotone-interpolation";
  readonly metric: "annual-income" | "net-financial-wealth";
  /**
   * 資料狀態（GPT-DEEPSEEK-0037-A）：目前一律是 `mvp_estimate` ——
   * 門檻表是人工建立的 MVP 估算占位，**不是**已下載的官方逐分位表。
   */
  readonly dataStatus: "mvp_estimate";
  /** 來源名稱（UI 可顯示「資料來源：…（估算）」）。 */
  readonly sourceLabel: string;
  /** 來源網址（可追溯）。 */
  readonly sourceUrl: string;
}

/** 可用的估算結果。 */
export interface P3EPercentileEstimate {
  readonly available: true;
  /** 高於中國多少比例的人（0–99.9，一位小數）。 */
  readonly chinaPercent: number;
  /** 高於全球多少比例的人（0–99.9，一位小數）。 */
  readonly globalPercent: number;
  readonly meta: P3EPercentileMeta;
}

/** 不可用的原因（UI 顯示「—」或「估算中」而不是假數字）。 */
export type P3EPercentileUnavailableReason = "age_below_minimum" | "no_income" | "not_employed";

/** 不可用時的回傳值。 */
export interface P3EPercentileUnavailable {
  readonly available: false;
  readonly reason: P3EPercentileUnavailableReason;
}

export type P3EPercentileResult = P3EPercentileEstimate | P3EPercentileUnavailable;

const META_INCOME: P3EPercentileMeta = Object.freeze({
  estimate: true,
  tableVersion: P3E_PERCENTILE_TABLE_VERSION,
  basisYear: P3E_PERCENTILE_BASIS_YEAR,
  currency: "USD",
  unit: "micro-USD",
  priceBasis: "ppp-2017",
  method: "static-threshold-monotone-interpolation",
  metric: "annual-income",
  dataStatus: "mvp_estimate",
  sourceLabel: "World Bank PIP (Poverty and Inequality Platform)",
  sourceUrl: "https://pip.worldbank.org/"
});

const META_WEALTH: P3EPercentileMeta = Object.freeze({
  ...META_INCOME,
  metric: "net-financial-wealth",
  sourceLabel: "World Inequality Database (WID) Income and Wealth Comparator",
  sourceUrl: "https://wid.world/"
});

function roundPercent(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  if (rounded < P3E_PERCENTILE_MIN) return P3E_PERCENTILE_MIN;
  if (rounded > P3E_PERCENTILE_MAX) return P3E_PERCENTILE_MAX;
  return rounded;
}

/**
 * 在分位門檻表上做**單調**插值，回傳「高於多少比例的人」。
 *
 * - 小於或等於第一個門檻：落在最低區間；若第一個門檻是 0（資產表），
 *   則「0 或負值」= 0%（最低），並從 `0%` 線性上升到第二個門檻的百分位；
 * - 高於最後一個門檻：固定 `99.9`；
 * - 介於兩個門檻之間：以 `(threshold, percentile)` 兩點線性內插。
 *
 * 全程沒有浮點誤差累積問題（只用於顯示的一位小數），且輸入越大輸出單調不減。
 */
export function percentileFromThresholds(
  valueMicroUsd: bigint,
  thresholds: readonly P3EPercentileThresholdPoint[]
): number {
  if (thresholds.length === 0) return P3E_PERCENTILE_MIN;
  const first = thresholds[0] as P3EPercentileThresholdPoint;
  // 第一段的下界：門檻若是 0（資產表），最低點就是 0% 而不是表格上的 percentile。
  const floorValue = first.thresholdMicroUsd > 0n ? first.thresholdMicroUsd : 0n;
  const floorPercentile = first.thresholdMicroUsd > 0n ? first.percentile : P3E_PERCENTILE_MIN;
  if (valueMicroUsd <= floorValue) {
    if (floorValue <= 0n) return P3E_PERCENTILE_MIN;
    const scaled = floorPercentile * (Number(valueMicroUsd < 0n ? 0n : valueMicroUsd) / Number(floorValue));
    return roundPercent(scaled);
  }
  for (let index = 0; index < thresholds.length - 1; index += 1) {
    const lower = thresholds[index] as P3EPercentileThresholdPoint;
    const upper = thresholds[index + 1] as P3EPercentileThresholdPoint;
    const lowerValue = index === 0 && first.thresholdMicroUsd <= 0n ? 0n : lower.thresholdMicroUsd;
    const lowerPercentile = index === 0 && first.thresholdMicroUsd <= 0n ? P3E_PERCENTILE_MIN : lower.percentile;
    if (valueMicroUsd <= upper.thresholdMicroUsd) {
      const span = upper.thresholdMicroUsd - lowerValue;
      if (span <= 0n) return roundPercent(upper.percentile);
      const ratio = Number(valueMicroUsd - lowerValue) / Number(span);
      return roundPercent(lowerPercentile + (upper.percentile - lowerPercentile) * ratio);
    }
  }
  return P3E_PERCENTILE_MAX;
}

/**
 * 收入百分位（「高於中國 X%｜高於全球 Y%」）。
 *
 * @param input.age              角色年齡
 * @param input.annualIncomeMicroUsd 目前 `assets.annualIncomeMicroUsd`
 * @param input.employmentStatus 個人經濟的就業狀態（`none`／`student` 視為未就業）
 */
export function estimateIncomePercentileMicroUsd(input: {
  readonly age: number;
  readonly annualIncomeMicroUsd: bigint;
  readonly employmentStatus: string;
}): P3EPercentileResult {
  if (input.age < P3E_PERCENTILE_MIN_INCOME_AGE) {
    return Object.freeze({ available: false as const, reason: "age_below_minimum" as const });
  }
  if (input.annualIncomeMicroUsd <= 0n) {
    return Object.freeze({ available: false as const, reason: "no_income" as const });
  }
  if (input.employmentStatus === "none" || input.employmentStatus === "student") {
    return Object.freeze({ available: false as const, reason: "not_employed" as const });
  }
  return Object.freeze({
    available: true as const,
    chinaPercent: percentileFromThresholds(input.annualIncomeMicroUsd, P3E_INCOME_THRESHOLDS_CHINA),
    globalPercent: percentileFromThresholds(input.annualIncomeMicroUsd, P3E_INCOME_THRESHOLDS_GLOBAL),
    meta: META_INCOME
  });
}

/**
 * 資產百分位（「高於中國 X%｜高於全球 Y%」）。
 *
 * `balanceMicroUsd` 是個人淨金融資產的近似值；負值落在最低區間（0%），
 * 不會拋錯、也不會出現 `NaN`。
 */
export function estimateWealthPercentileMicroUsd(input: {
  readonly age: number;
  readonly balanceMicroUsd: bigint;
}): P3EPercentileResult {
  if (input.age < P3E_PERCENTILE_MIN_WEALTH_AGE) {
    return Object.freeze({ available: false as const, reason: "age_below_minimum" as const });
  }
  const value = input.balanceMicroUsd < 0n ? 0n : input.balanceMicroUsd;
  return Object.freeze({
    available: true as const,
    chinaPercent: percentileFromThresholds(value, P3E_WEALTH_THRESHOLDS_CHINA),
    globalPercent: percentileFromThresholds(value, P3E_WEALTH_THRESHOLDS_GLOBAL),
    meta: META_WEALTH
  });
}

/** 把估算結果組成 UI 直接可用的字串（`高於中國 82%｜高於全球 91%`）。 */
export function formatPercentileSummary(result: P3EPercentileResult): string {
  if (!result.available) return "估算不可用";
  const china = Math.round(result.chinaPercent);
  const global = Math.round(result.globalPercent);
  return `高於中國 ${china}%｜高於全球 ${global}%`;
}
