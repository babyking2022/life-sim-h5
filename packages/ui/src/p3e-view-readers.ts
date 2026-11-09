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

/**
 * 從舊 view.partner 讀取伴侶顯示名（不要求狀態）。
 * 拒絕泛稱／internal key／標記語法；找不到或不是真名回 null。
 * 姓名與狀態拆開讀取，確保「無姓名時仍能保留狀態」。
 */
function readPartnerName(view: unknown): string | null {
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
  return displayName;
}

/** 沒有正式 projection 時絕不回傳假名字。 */
export function readPartnerIdentity(view: unknown): PartnerIdentity | null {
  const root: Record<string, unknown> = isPlainRecord(view) ? view : {};
  const record = firstRecord(root, PARTNER_ROOT_KEYS);
  const displayName = readPartnerName(view);
  if (displayName === null) return null;

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

/* ------------------------------------------------------------------ */
/* D：角色即時狀態（GPT-0040-B｜view.profile）                          */
/* ------------------------------------------------------------------ */

/**
 * DEEPSEEK-0040-A 把角色即時狀態放在 `view.profile`：
 *   currentRole / residence / relationship。
 * 這裡只做安全讀取（type guard + 白名單），UI 永遠不重算狀態、不洩漏 internal key。
 */

export type ProfileRelationshipStatus =
  | "single"
  | "dating"
  | "married"
  | "divorced"
  | "widowed"
  | "unknown";

export interface ProfileRoleView {
  /** 已知 role id；未知 ID 為 ""（絕不回傳 internal key）。 */
  readonly id: string;
  /** 自然繁體標籤，如「初中生」；未知 ID 為「狀態更新中」。 */
  readonly label: string;
  /** 卡片第一欄標籤：身分或職業。 */
  readonly rowLabel: "目前身分" | "目前職業";
}

export interface ProfileResidenceView {
  readonly entityId: string;
  readonly regionCode: string;
}

export interface ProfileRelationshipView {
  /** 五種狀態之一；無效或缺失為 "unknown"。 */
  readonly status: ProfileRelationshipStatus;
  /** 現任或前任伴侶姓名（single 時為 null）。 */
  readonly personName: string | null;
  readonly sinceYear: number | null;
  /** 自然繁中整行，如「已婚 · 王小明」、「單身」。 */
  readonly label: string;
}

/** role id → 自然繁體標籤與欄位標題（0040-A 的 24 種 + 0054-A 的 27 種明確職業）。 */
const ROLE_LABELS: Readonly<Record<string, { label: string; row: "目前身分" | "目前職業" }>> = Object.freeze({
  infant: { label: "嬰兒", row: "目前身分" },
  preschool_child: { label: "幼兒", row: "目前身分" },
  primary_student: { label: "小學生", row: "目前身分" },
  junior_high_student: { label: "初中生", row: "目前身分" },
  senior_high_student: { label: "高中生", row: "目前身分" },
  university_student: { label: "大學生", row: "目前身分" },
  master_student: { label: "研究生", row: "目前身分" },
  doctoral_student: { label: "博士生", row: "目前身分" },
  general_worker: { label: "一般職員", row: "目前職業" },
  engineer: { label: "工程師", row: "目前職業" },
  software_engineer: { label: "軟體工程師", row: "目前職業" },
  accountant: { label: "會計", row: "目前職業" },
  office_worker: { label: "行政人員", row: "目前職業" },
  /* GPT-0054-B：這三個 0040-A 舊標籤與 0054-A 權威職業目錄／字典不同名
     （銷售員／農民／店主）。統一改成字典用語，讓「目前職業」、職業按鈕與
     人生紀錄顯示同一個具體職業名稱，不再同一份工作出現兩種叫法。 */
  salesperson: { label: "業務銷售", row: "目前職業" },
  designer: { label: "設計師", row: "目前職業" },
  marketer: { label: "行銷人員", row: "目前職業" },
  entrepreneur: { label: "創業者", row: "目前職業" },
  shopkeeper: { label: "自營店主", row: "目前職業" },
  cook: { label: "廚師", row: "目前職業" },
  farmer: { label: "農夫", row: "目前職業" },
  service_worker: { label: "服務業人員", row: "目前職業" },
  teacher: { label: "教師", row: "目前職業" },
  /* GPT-WORKBUDDY-0054-B：玩家明確選擇的職業（與 contracts/p3e-career.ts 對應）。
     缺少對照會顯示「狀態更新中」，導致「選完職業後目前職業沒更新」。 */
  waiter: { label: "服務生", row: "目前職業" },
  hotel_manager: { label: "旅宿主管", row: "目前職業" },
  chef: { label: "主廚", row: "目前職業" },
  factory_worker: { label: "工廠作業員", row: "目前職業" },
  driver: { label: "職業駕駛", row: "目前職業" },
  construction_worker: { label: "建築工", row: "目前職業" },
  electrician: { label: "水電技師", row: "目前職業" },
  site_supervisor: { label: "工地主任", row: "目前職業" },
  clerk: { label: "行政人員", row: "目前職業" },
  hr_specialist: { label: "人力資源專員", row: "目前職業" },
  care_worker: { label: "照顧服務員", row: "目前職業" },
  care_assistant: { label: "照護助理", row: "目前職業" },
  nurse: { label: "護理師", row: "目前職業" },
  physician: { label: "醫師", row: "目前職業" },
  lab_technician: { label: "實驗技術員", row: "目前職業" },
  freelancer: { label: "自由工作者", row: "目前職業" },
  consultant: { label: "顧問", row: "目前職業" },
  gap_year: { label: "待業", row: "目前身分" },
  retired: { label: "退休", row: "目前身分" }
});

const RELATIONSHIP_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  single: "單身",
  dating: "交往中",
  married: "已婚",
  divorced: "離異",
  widowed: "喪偶"
});

/** 讀 `view.profile.currentRole`，未知 ID 顯示「狀態更新中」，不洩漏 internal key。 */
export function readProfileRole(view: unknown): ProfileRoleView | null {
  const root: Record<string, unknown> = isPlainRecord(view) ? view : {};
  const profile = firstRecord(root, ["profile"]);
  const role = profile === null ? null : firstRecord(profile, ["currentRole"]);
  if (role === null) return null;
  const rawId = role["id"];
  if (typeof rawId !== "string" || rawId.length === 0) return null;
  const mapped = ROLE_LABELS[rawId];
  if (mapped !== undefined) return { id: rawId, label: mapped.label, rowLabel: mapped.row };
  return { id: "", label: "狀態更新中", rowLabel: "目前身分" };
}

/** 讀 `view.profile.residence`；國家名與旗幟由 UI 用注册表查。 */
export function readProfileResidence(view: unknown): ProfileResidenceView | null {
  const root: Record<string, unknown> = isPlainRecord(view) ? view : {};
  const profile = firstRecord(root, ["profile"]);
  const residence = profile === null ? null : firstRecord(profile, ["residence"]);
  if (residence === null) return null;
  const entityId = typeof residence["entityId"] === "string" ? (residence["entityId"] as string) : null;
  const regionCode = typeof residence["regionCode"] === "string" ? (residence["regionCode"] as string) : null;
  if (entityId === null && regionCode === null) return null;
  return { entityId: entityId ?? "", regionCode: regionCode ?? "" };
}

/**
 * 讀 `view.profile.relationship`（UI 權威情感狀態來源）。
 * 同時向後相容舊 `view.partner`：只有在 `profile.relationship` 完全缺失時才退回。
 * 只有 married／dating 才在整行帶姓名；divorced／widowed 只顯示狀態。
 */
export function readProfileRelationship(view: unknown): ProfileRelationshipView | null {
  const root: Record<string, unknown> = isPlainRecord(view) ? view : {};
  const profile = firstRecord(root, ["profile"]);
  const rel = profile === null ? null : firstRecord(profile, ["relationship"]);
  if (rel !== null) {
    const rawStatus = rel["status"];
    const status: ProfileRelationshipStatus =
      typeof rawStatus === "string" && RELATIONSHIP_STATUS_LABELS[rawStatus] !== undefined
        ? (rawStatus as ProfileRelationshipStatus)
        : "unknown";
    const personName = safeText(rel["personName"], 64);
    const rawYear = rel["sinceYear"];
    const sinceYear = isFiniteNumber(rawYear) && rawYear >= 0 && rawYear <= 9999 ? Math.round(rawYear) : null;
    let label: string;
    if (status === "unknown") {
      label = "狀態更新中";
    } else {
      const base = RELATIONSHIP_STATUS_LABELS[status] as string;
      label = status === "married" || status === "dating"
        ? personName === null ? base : `${base} · ${personName}`
        : base;
    }
    return { status, personName, sinceYear, label };
  }
  // 向後相容：舊 view.partner（無 view.profile.relationship 時）。
  // 狀態與姓名拆開讀取：沒有姓名時仍要保留狀態（single/dating/married/divorced/widowed/unknown）；
  // 只有 married／dating 才在整行帶姓名，絕不假造姓名（GPT-0043-B）。
  const partnerRecord = firstRecord(
    isPlainRecord(view) ? (view as Record<string, unknown>) : {},
    PARTNER_ROOT_KEYS
  );
  if (partnerRecord !== null) {
    const rawStatus = firstValue(partnerRecord, PARTNER_STATUS_KEYS);
    const name = readPartnerName(view);
    // 既無狀態也無姓名 → 無可用資訊，回 null（與舊行為一致）；
    // 只要任一存在，就據狀態映射（無姓名時照樣保留 single/dating/married/divorced/widowed/unknown）。
    if (rawStatus === undefined && name === null) return null;
    const status = mapLegacyPartnerStatus(typeof rawStatus === "string" ? rawStatus : null);
    const base = RELATIONSHIP_STATUS_LABELS[status] ?? "狀態更新中";
    const showName = (status === "married" || status === "dating") && name !== null && name.length > 0;
    const label = showName ? `${base} · ${name}` : base;
    const rawYear = firstValue(partnerRecord, PARTNER_YEAR_KEYS);
    const sinceYear = isFiniteNumber(rawYear) && rawYear >= 0 && rawYear <= 9999 ? Math.round(rawYear) : null;
    return { status, personName: showName ? name : null, sinceYear, label };
  }
  return null;
}

/**
 * 舊 view.partner 的 status 字串 → 五態之一（unknown 兜底）。
 * married→married；dating/partner/cohabit/cohabiting→dating；
 * divorced→divorced；widowed→widowed；single→single；其餘→unknown。
 * 不得在 UI 重新發明關係狀態機，只做既有正式型別的安全映射。
 */
function mapLegacyPartnerStatus(raw: string | null): ProfileRelationshipStatus {
  if (raw === null) return "unknown";
  switch (raw) {
    case "married":
      return "married";
    case "dating":
    case "partner":
    case "cohabit":
    case "cohabiting":
      return "dating";
    case "divorced":
      return "divorced";
    case "widowed":
      return "widowed";
    case "single":
      return "single";
    default:
      return "unknown";
  }
}
