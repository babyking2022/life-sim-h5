/**
 * GPT-WORKBUDDY-0054-B｜顯示層貨幣換算（MVP 固定匯率）。
 *
 * ## 原則
 *
 * - 內部 `microUsd`（base10 字串／bigint）與既有百分位演算法**完全不動**，
 *   存檔、golden、replay 不受影響；這裡只在「要畫到 DOM 上」時做一次換算。
 * - 固定 `1 USD = 7.2 CNY`，不呼叫任何匯率 API、不讀時間、不用 Math.random。
 * - 金額一律以 `CNY` 開頭（例如 `CNY 12.8萬`、`CNY 2,588,952.96`），
 *   不再出現 `$`，也不會把 `microUsd` 之類的 internal key 帶到畫面。
 * - 未成年（未滿 16 歲）的「—」由呼叫端判定，這裡不負責；無效輸入也回「—」，
 *   絕不把原始字串直接印出去（避免 internal key 外洩）。
 *
 * ## 為什麼用 BigInt
 *
 * `microUsd` 是 6 位小數的定點整數字串。乘以 7.2 若轉成浮點數會在
 * 大金額時掉精度；這裡改用整數運算：`microCny = microUsd * 72 / 10`，
 * 與內部值同為定點整數，換算結果逐位元穩定。
 */

/** 固定 MVP 匯率：1 USD = 7.2 CNY（以整數比例 72/10 表示）。 */
export const CNY_PER_USD_NUMERATOR = 72n;
export const CNY_PER_USD_DENOMINATOR = 10n;

/** 1 CNY = 1_000_000 micro-CNY（與 micro-USD 同尺度）。 */
export const MICRO_PER_UNIT = 1_000_000n;

/** 顯示層貨幣標籤。 */
export const CNY_LABEL = "CNY";

/** 自然中性的缺值／無效值顯示（未成年與無法解析時共用）。 */
export const CNY_PLACEHOLDER = "—";

/** 萬／億門檻（以 micro-CNY 計）。 */
const WAN_MICRO = 10_000n * MICRO_PER_UNIT;
const YI_MICRO = 100_000_000n * MICRO_PER_UNIT;

/** 把 base10 micro-USD 字串換算成 micro-CNY；無法解析時回 null。 */
export function cnyMicroFromUsdMicro(value: string): bigint | null {
  if (typeof value !== "string") return null;
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  if (!/^\d+$/.test(digits)) return null;
  const micro = (BigInt(digits) * CNY_PER_USD_NUMERATOR) / CNY_PER_USD_DENOMINATOR;
  return negative ? -micro : micro;
}

/** 千分位（純字串處理，不轉浮點數）。 */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** micro-CNY → 完整金額字串，例如 `CNY 2,588,952.96`。 */
export function formatCnyFromMicro(micro: bigint): string {
  const sign = micro < 0n ? "-" : "";
  const abs = micro < 0n ? -micro : micro;
  const whole = abs / MICRO_PER_UNIT;
  const cents = (abs % MICRO_PER_UNIT) / 10_000n;
  return `${sign}${CNY_LABEL} ${groupThousands(whole.toString())}.${cents.toString().padStart(2, "0")}`;
}

/**
 * micro-CNY → 緊湊金額字串。
 *
 * `CNY 1.2億` / `CNY 12.8萬` / 小於一萬時回到完整 `CNY 3,456.00`。
 * 完整值另由 `formatCnyFromMicro` 放在 title／aria-label，資訊不刪減。
 */
export function formatCompactCnyFromMicro(micro: bigint): string {
  const sign = micro < 0n ? "-" : "";
  const abs = micro < 0n ? -micro : micro;
  if (abs >= YI_MICRO) {
    return `${sign}${CNY_LABEL} ${(Number(abs / MICRO_PER_UNIT) / 100_000_000).toFixed(1)}億`;
  }
  if (abs >= WAN_MICRO) {
    return `${sign}${CNY_LABEL} ${(Number(abs / MICRO_PER_UNIT) / 10_000).toFixed(1)}萬`;
  }
  return formatCnyFromMicro(micro);
}

/** micro-USD 字串 → 完整 CNY 金額（無效輸入回「—」，不印原始字串）。 */
export function formatCnyFromUsdMicro(value: string): string {
  const micro = cnyMicroFromUsdMicro(value);
  return micro === null ? CNY_PLACEHOLDER : formatCnyFromMicro(micro);
}

/** micro-USD 字串 → 緊湊 CNY 金額（無效輸入回「—」）。 */
export function formatCompactCnyFromUsdMicro(value: string): string {
  const micro = cnyMicroFromUsdMicro(value);
  return micro === null ? CNY_PLACEHOLDER : formatCompactCnyFromMicro(micro);
}

/** 職業按鈕上的「預估年收入」文案；明確標 CNY，不含任何 internal key。 */
export function careerIncomeLabel(baseAnnualIncomeMicroUsd: string): string {
  return `預估年收入 ${formatCompactCnyFromUsdMicro(baseAnnualIncomeMicroUsd)}`;
}

/**
 * HUD／狀態卡的統一入口：未成年一律「—」，**不會因為換算就恢復兒童收入／資產**。
 * 百分位文字另由 `readComparisonView` 處理，這裡絕不把百分比當貨幣。
 */
export function financeDisplay(value: string, minor: boolean, compact: boolean): string {
  if (minor) return CNY_PLACEHOLDER;
  return compact ? formatCompactCnyFromUsdMicro(value) : formatCnyFromUsdMicro(value);
}
