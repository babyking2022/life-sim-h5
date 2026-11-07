/**
 * GPT-0036-B｜顯示層對新 view 欄位的安全讀取（pure，無 DOM、無 application import）。
 *
 * DeepSeek（GPT-0036-A）會平行在 application view 新增「收入／資產百分位」與
 * 「具名伴侶」projection。本模組只用 type guard + 白名單欄位讀 `unknown`：
 *
 * - 對方欄位尚未出現 → 回傳「資料準備中」之類的自然中文，不顯示 0 百分位、
 *   不顯示假名字、不露 internal key，也不讓 UI 崩潰；
 * - 對方欄位上線（不論最終命名是 `comparisons`、`percentiles` 或扁平欄位）
 *   → 不需改 UI 即可直接吃到正式數值；UI 永遠不重算百分位、不重做姓名演算法；
 * - 所有值都經過字串／數值驗證，交給 DOM 時一律用 `textContent`。
 */

/* ------------------------------------------------------------------ */
/* 共用小工具                                                          */
/* ------------------------------------------------------------------ */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 只接受 0–99.9 的百分位；拒絕 NaN／Infinity／負值／明顯假的 100。 */
function readPercent(value: unknown): number | null {
  if (!isFiniteNumber(value)) return null;
  if (value < 0 || value > 99.9) return null;
  return Math.round(value * 10) / 10;
}

const INTERNAL_KEY_PATTERN = /(?:p3[ab]\.|ev\.|focus:|E_[A-Z0-9_]+|SET_LIFE_FOCUS|microUsd)/;

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength) return null;
  // 控制字元、標記語法、內部鍵一律不接受（姓名與比較字串都不該長這樣）。
  if (/[\u0000-\u001f\u007f<>]/.test(text) || INTERNAL_KEY_PATTERN.test(text)) return null;
  return text;
}

function firstRecord(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = source[key];
    if (isPlainRecord(value)) return value;
  }
  return null;
}

function firstValue(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== null) return source[key];
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* A/B：收入與資產比較                                                  */
/* ------------------------------------------------------------------ */

export interface ComparisonBlock {
  readonly available: boolean;
  /** 可直接放進 `textContent` 的自然繁中字串。 */
  readonly text: string;
  readonly reason: string | null;
}

export interface ComparisonView {
  readonly income: ComparisonBlock;
  readonly wealth: ComparisonBlock;
  /** projection／partial／missing；供 browser 驗收與診斷 dataset 使用。 */
  readonly source: "projection" | "partial" | "missing";
  /** 「估算」按鈕展開的簡短說明，永遠是自然中文。 */
  readonly note: string;
  readonly basisYear: number | null;
}

const COMPARISON_ROOT_KEYS = [
  "comparisons",
  "comparison",
  "percentiles",
  "percentile",
  "ranks",
  "rankings",
  "financeComparison",
  "wealthComparison",
  "distributionComparison",
  "distribution"
] as const;

const INCOME_KEYS = [
  "income",
  "incomePercentile",
  "incomeComparison",
  "incomeRank",
  "annualIncome",
  "annualIncomePercentile"
] as const;

const WEALTH_KEYS = [
  "wealth",
  "wealthPercentile",
  "wealthComparison",
  "wealthRank",
  "assets",
  "assetPercentile",
  "assetComparison",
  "balance",
  "balancePercentile",
  "netWorth"
] as const;

const FLAT_INCOME_KEYS = [
  ...INCOME_KEYS,
  "incomePercentileResult",
  "incomePercentileSummary",
  "incomePercentileText"
] as const;

const FLAT_WEALTH_KEYS = [
  ...WEALTH_KEYS,
  "wealthPercentileResult",
  "wealthPercentileSummary",
  "wealthPercentileText"
] as const;

const CHINA_KEYS = ["chinaPercent", "chinaPct", "chinaPercentile", "china"] as const;
const GLOBAL_KEYS = ["globalPercent", "globalPct", "globalPercentile", "global", "worldPercent"] as const;
const SUMMARY_KEYS = ["summary", "text", "label", "display", "displayText", "summaryText"] as const;
const REASON_KEYS = ["reason", "unavailableReason"] as const;
const BASIS_YEAR_KEYS = ["basisYear"] as const;

function unavailable(text: string, reason: string | null): ComparisonBlock {
  return { available: false, text, reason };
}

/** 由單一 projection 物件（或已格式化字串）讀出一塊比較資訊。 */
function readComparisonBlock(raw: unknown, fallbackText: string): ComparisonBlock | null {
  if (raw === undefined || raw === null) return null;

  if (typeof raw === "string") {
    const text = safeText(raw, 96);
    if (text === null) return unavailable(fallbackText, "invalid");
    if (/不可用|準備中|暫不估算|估算中|尚未/.test(text)) return unavailable(text, "unavailable-text");
    if (/高於/.test(text) && /%/.test(text)) return { available: true, text, reason: null };
    return unavailable(fallbackText, "unrecognized-text");
  }

  if (typeof raw === "number") {
    // 單一數字不可能是完整的「中國／全球」比較，寧可顯示自然文案也不編造。
    return unavailable(fallbackText, "scalar");
  }

  if (!isPlainRecord(raw)) return unavailable(fallbackText, "invalid");

  const reasonValue = firstValue(raw, REASON_KEYS);
  const reason = typeof reasonValue === "string" ? safeText(reasonValue, 48) : null;
  if (raw["available"] === false) return unavailable(fallbackText, reason ?? "unavailable");

  const summary = safeText(firstValue(raw, SUMMARY_KEYS), 96);
  if (summary !== null && /高於/.test(summary) && /%/.test(summary)) {
    return { available: true, text: summary, reason: null };
  }
  if (summary !== null && /不可用|準備中|暫不估算/.test(summary)) {
    return unavailable(summary, reason ?? "unavailable-text");
  }

  const china = readPercent(firstValue(raw, CHINA_KEYS));
  const global = readPercent(firstValue(raw, GLOBAL_KEYS));
  if (china !== null && global !== null) {
    return {
      available: true,
      text: `高於中國 ${Math.round(china)}%｜高於全球 ${Math.round(global)}%`,
      reason: null
    };
  }
  return unavailable(fallbackText, reason ?? "incomplete");
}

const ESTIMATE_NOTE =
  "這是依靜態門檻表所做的 MVP 估算，不是即時排行；兒童與沒有收入的人不會列入比較。";

/** 把 projection 的 unavailable reason 變成看得懂的中文，不顯示底線命名。 */
function reasonText(reason: string | null, kind: "income" | "wealth"): string {
  switch (reason) {
    case "no_income":
      return kind === "income" ? "目前沒有收入，暫不比較" : "目前沒有資產可比較";
    case "not_employed":
      return "尚未就業，暫不比較收入";
    case "age_below_minimum":
      return kind === "income" ? "未成年，暫不估算收入" : "未成年，暫不估算資產";
    default:
      return kind === "income" ? "收入比較估算準備中" : "資產比較估算準備中";
  }
}

/** DeepSeek 的正式 projection 把 meta 放在各欄位裡。 */
function fieldBasisYear(raw: unknown): number | null {
  if (!isPlainRecord(raw)) return null;
  const meta = firstRecord(raw, ["meta"]);
  if (meta === null) return null;
  const year = firstValue(meta, BASIS_YEAR_KEYS);
  return isFiniteNumber(year) && year >= 1900 && year <= 2100 ? Math.round(year) : null;
}

/**
 * 讀整塊比較 view。未成年一律顯示自然文案（絕不顯示 0 百分位），
 * HUD 主列的 `—` 由 render 原本邏輯處理，這裡只負責 compact strip。
 */
export function readComparisonView(view: unknown, age: number): ComparisonView {
  const root: Record<string, unknown> = isPlainRecord(view) ? view : {};
  const container =
    firstRecord(root, COMPARISON_ROOT_KEYS) ?? (isPlainRecord(root["comparison"]) ? root["comparison"] : null);

  const incomeFallback =
    age < 16 ? "未成年，暫不估算收入" : "收入比較估算準備中";
  const wealthFallback =
    age < 18 ? "未成年，暫不估算資產" : "資產比較估算準備中";

  const incomeRaw =
    (container === null ? undefined : firstValue(container, INCOME_KEYS)) ??
    firstValue(root, FLAT_INCOME_KEYS);
  const wealthRaw =
    (container === null ? undefined : firstValue(container, WEALTH_KEYS)) ??
    firstValue(root, FLAT_WEALTH_KEYS);

  const income = readComparisonBlock(incomeRaw, incomeFallback) ?? unavailable(incomeFallback, "missing");
  const wealth = readComparisonBlock(wealthRaw, wealthFallback) ?? unavailable(wealthFallback, "missing");

  // projection 未提供時，即使對方給了值也不該把兒童算進去。
  const guardedIncome = age < 16
    ? unavailable(incomeFallback, "age_below_minimum")
    : income.available ? income : unavailable(reasonText(income.reason, "income"), income.reason);
  const guardedWealth = age < 18
    ? unavailable(wealthFallback, "age_below_minimum")
    : wealth.available ? wealth : unavailable(reasonText(wealth.reason, "wealth"), wealth.reason);

  const source: ComparisonView["source"] =
    guardedIncome.available && guardedWealth.available
      ? "projection"
      : incomeRaw === undefined && wealthRaw === undefined
        ? "missing"
        : "partial";

  const meta = firstRecord(root, ["percentileMeta"]) ??
    (container === null ? null : firstRecord(container, ["meta", "metadata"]));
  let basisYear: number | null = null;
  if (meta !== null) {
    const rawYear = firstValue(meta, BASIS_YEAR_KEYS);
    if (isFiniteNumber(rawYear) && rawYear >= 1900 && rawYear <= 2100) basisYear = Math.round(rawYear);
  }
  // GPT-DEEPSEEK-0036-A 正式形狀：meta 放在 income／wealth 各自欄位內。
  if (basisYear === null) basisYear = fieldBasisYear(incomeRaw) ?? fieldBasisYear(wealthRaw);
  const note = basisYear === null ? ESTIMATE_NOTE : `以 ${basisYear} 年為基準的 MVP 估算，不是即時排行。`;

  return { income: guardedIncome, wealth: guardedWealth, source, note, basisYear };
}

/* ------------------------------------------------------------------ */
/* C：具名伴侶                                                          */
/* ------------------------------------------------------------------ */

export interface PartnerIdentity {
  readonly displayName: string;
  readonly status: string | null;
  readonly sinceYear: number | null;
}

const PARTNER_ROOT_KEYS = [
  "partner",
  "partnerView",
  "partnerIdentity",
  "relationship",
  "relationshipPartner",
  "significantOther",
  "companion"
] as const;

const PARTNER_NAME_KEYS = [
  "displayName",
  "name",
  "nameZhHant",
  "displayNameZhHant",
  "fullName",
  "partnerName"
] as const;

const PARTNER_STATUS_KEYS = ["status", "relationshipStatus"] as const;
const PARTNER_YEAR_KEYS = ["sinceYear", "startYear", "establishedYear"] as const;

/** 沒有正式 projection 時絕不回傳假名字。 */
export function readPartnerIdentity(view: unknown): PartnerIdentity | null {
  const root: Record<string, unknown> = isPlainRecord(view) ? view : {};
  const record = firstRecord(root, PARTNER_ROOT_KEYS);
  const rawName =
    (record === null ? undefined : firstValue(record, PARTNER_NAME_KEYS)) ??
    firstValue(root, ["partnerDisplayName", "partnerName"]);
  const displayName = safeText(rawName, 64);
  if (displayName === null) return null;
  // 泛稱不是名字：對方若還沒生成姓名，寧可不顯示。
  if (/^(伴侶|對象|朋友|未知|無|none|null|unknown)$/i.test(displayName)) return null;
  if (!/[\u3400-\u9fffA-Za-z]/.test(displayName)) return null;

  const rawStatus = record === null ? undefined : firstValue(record, PARTNER_STATUS_KEYS);
  const status = safeText(rawStatus, 32);
  const rawYear = record === null ? undefined : firstValue(record, PARTNER_YEAR_KEYS);
  const sinceYear = isFiniteNumber(rawYear) && rawYear >= 0 && rawYear <= 9999 ? Math.round(rawYear) : null;
  return { displayName, status, sinceYear };
}

/** 視覺省略，但完整姓名仍留在 `title`／`aria-label`。 */
export function ellipsizeName(name: string, maxLength = 12): string {
  return name.length <= maxLength ? name : `${name.slice(0, maxLength - 1)}…`;
}
