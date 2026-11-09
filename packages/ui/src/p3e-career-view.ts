/**
 * GPT-WORKBUDDY-0054-B｜任務二：兩階段職業決策的顯示層投影（純函式）。
 *
 * DeepSeek（0054-A）已在事件包建立兩階段正式決策：
 *
 * 1. `dec.adult.career-field`：六個分類（6 個選項）；
 * 2. `dec.adult.career-<field>-<entry|degree>`：該分類＋該學歷 tier 的具體職業。
 *
 * 事件包**已經把不符合學歷條件的職業排除在選項之外**（模擬層就擋掉），
 * 所以 UI 永遠不會一次塞 24+ 個按鈕。這裡負責：
 *
 * - 辨識目前是第幾階段；
 * - 每個職業按鈕顯示「職業名稱 + 預估年收入（CNY）」；
 * - 對任何「不屬於本分類／本學歷層級或不在權威目錄」的選項做防禦性停用，
 *   並給自然繁中說明（不印 internal key、不印 microUsd、不印 `$`）；
 * - 需要較高知識的職業給自然提示，但**不停用**，避免把所有選項都鎖死造成死局；
 * - 提供分類階段的提示文案，讓手機兩欄卡片讀得懂。
 *
 * 年收入數字的唯一權威來源是 `p3e-career.ts` 的 `P3E_CAREERS`；這裡的顯示層
 * 對照表由 `p3e-career-view.test.ts` 逐筆對事件包的 `deltaMicroUsd` 驗證，
 * 避免兩邊漂移。換算固定 `1 USD = 7.2 CNY`，只在顯示層發生。
 */

import { careerIncomeLabel } from "./p3e-cny.js";

/* ------------------------------------------------------------------ */
/* 顯示層職業目錄對照（與 contracts/p3e-career.ts 的 27 筆一致）          */
/* ------------------------------------------------------------------ */

export type CareerCategoryId = "service" | "trade" | "office" | "care" | "tech" | "independent";
export type CareerTier = "entry" | "degree";

export interface CareerEstimate {
  readonly id: string;
  /** 繁中名稱（字典查不到時的降級保險，永遠不印 raw key）。 */
  readonly name: string;
  readonly category: CareerCategoryId;
  readonly tier: CareerTier;
  readonly minEducation: 0 | 1 | 2;
  readonly minKnowledge: number;
  /** 基礎年收入（USD／年）；乘 1_000_000 即 micro-USD。 */
  readonly annualIncomeUsd: number;
}

const estimate = (
  id: string,
  name: string,
  category: CareerCategoryId,
  minEducation: 0 | 1 | 2,
  minKnowledge: number,
  annualIncomeUsd: number
): CareerEstimate =>
  Object.freeze({
    id, name, category, minEducation, minKnowledge, annualIncomeUsd,
    tier: minEducation === 0 ? "entry" : "degree"
  });

/** 27 種職業（6 分類），與權威目錄逐筆對應。 */
export const CAREER_ESTIMATES: readonly CareerEstimate[] = Object.freeze([
  /* 一般服務 */
  estimate("waiter", "服務生", "service", 0, 0, 6_000),
  estimate("cook", "廚師", "service", 0, 0, 9_000),
  estimate("hotel_manager", "旅宿主管", "service", 1, 25, 22_000),
  estimate("chef", "主廚", "service", 1, 30, 28_000),
  /* 技術工種 */
  estimate("factory_worker", "工廠作業員", "trade", 0, 0, 8_000),
  estimate("driver", "職業駕駛", "trade", 0, 0, 9_000),
  estimate("construction_worker", "建築工", "trade", 0, 5, 11_000),
  estimate("electrician", "水電技師", "trade", 1, 25, 20_000),
  estimate("site_supervisor", "工地主任", "trade", 1, 25, 24_000),
  /* 行政商務 */
  estimate("clerk", "行政人員", "office", 0, 0, 10_000),
  estimate("salesperson", "業務銷售", "office", 0, 5, 12_000),
  estimate("accountant", "會計", "office", 1, 30, 24_000),
  estimate("hr_specialist", "人力資源專員", "office", 1, 25, 22_000),
  /* 教育醫療 */
  estimate("care_worker", "照顧服務員", "care", 0, 10, 11_000),
  estimate("care_assistant", "照護助理", "care", 0, 5, 9_000),
  estimate("teacher", "教師", "care", 1, 35, 22_000),
  estimate("nurse", "護理師", "care", 1, 35, 26_000),
  estimate("physician", "醫師", "care", 2, 55, 42_000),
  /* 科技工程 */
  estimate("lab_technician", "實驗技術員", "tech", 0, 15, 14_000),
  estimate("designer", "設計師", "tech", 0, 20, 16_000),
  estimate("engineer", "工程師", "tech", 1, 40, 30_000),
  estimate("software_engineer", "軟體工程師", "tech", 1, 40, 34_000),
  /* 創業自由業 */
  estimate("farmer", "農夫", "independent", 0, 0, 7_000),
  estimate("shopkeeper", "自營店主", "independent", 0, 5, 10_000),
  estimate("freelancer", "自由工作者", "independent", 0, 15, 13_000),
  estimate("entrepreneur", "創業者", "independent", 1, 25, 30_000),
  estimate("consultant", "顧問", "independent", 1, 30, 26_000)
]);

export const CAREER_ESTIMATE_BY_ID: Readonly<Record<string, CareerEstimate>> = Object.freeze(
  Object.fromEntries(CAREER_ESTIMATES.map((entry) => [entry.id, entry]))
);

export const CAREER_CATEGORY_IDS: readonly CareerCategoryId[] = Object.freeze([
  "service", "trade", "office", "care", "tech", "independent"
]);

/** 與事件包 `deltaMicroUsd` 完全相同的 micro-USD 字串。 */
export function careerIncomeMicroUsd(entry: CareerEstimate): string {
  return (BigInt(entry.annualIncomeUsd) * 1_000_000n).toString();
}

/* ------------------------------------------------------------------ */
/* 兩階段決策辨識                                                      */
/* ------------------------------------------------------------------ */

export interface CareerDecisionInfo {
  readonly stage: "category" | "job";
  readonly category: CareerCategoryId | null;
  readonly tier: CareerTier | null;
}

const JOB_DECISION_RE = /^dec\.adult\.career-(service|trade|office|care|tech|independent)-(entry|degree)$/;

/** 不是職業決策就回 null（一般事件走原本的 renderPending）。 */
export function parseCareerDecision(decisionId: string): CareerDecisionInfo | null {
  if (decisionId === "dec.adult.career-field") {
    return Object.freeze({ stage: "category", category: null, tier: null });
  }
  const matched = JOB_DECISION_RE.exec(decisionId);
  if (matched === null) return null;
  const category = matched[1] as CareerCategoryId;
  if (!CAREER_CATEGORY_IDS.includes(category)) return null;
  const tier = matched[2] as CareerTier;
  return Object.freeze({ stage: "job", category, tier });
}

export function careerCategoryHintKey(category: CareerCategoryId): string {
  return `p3b.career.category.${category}.hint`;
}

/** 決策區頂端的自然繁中說明（解釋為什麼看不到某些工作）。 */
export function careerListNote(info: CareerDecisionInfo): string {
  return info.stage === "category"
    ? "先選一個工作領域，下一步再挑具體職業。"
    : "已依你的學歷列出可勝任的工作；需要更高學歷的工作不會出現在這裡。";
}

/* ------------------------------------------------------------------ */
/* 單一選項的顯示投影                                                   */
/* ------------------------------------------------------------------ */

export interface CareerOptionView {
  readonly optionId: string;
  readonly label: string;
  /** `預估年收入 CNY x.x萬`；分類階段沒有金額。 */
  readonly incomeText: string | null;
  /** 分類提示／知識需求說明／停用原因（一律自然繁中）。 */
  readonly note: string | null;
  readonly disabled: boolean;
}

export interface CareerOptionInput {
  readonly optionId: string;
  readonly labelKey: string;
}

export interface CareerViewContext {
  /** 顯示層字典查詢（傳入 UI 的 friendlyKey，保證不洩漏 internal key）。 */
  readonly translate: (key: string) => string;
  /** `view.stats.knowledge`（公開投影）。 */
  readonly knowledge: number;
}

function safeLabel(translate: (key: string) => string, labelKey: string, fallback: string): string {
  const text = translate(labelKey);
  // friendlyKey 找不到對照時會回中性中文；這裡再擋一次 raw key 形狀。
  if (typeof text !== "string" || text.length === 0 || /^[A-Za-z0-9._:-]+$/.test(text.trim())) return fallback;
  return text;
}

export function buildCareerOptionViews(
  options: readonly CareerOptionInput[],
  info: CareerDecisionInfo,
  context: CareerViewContext
): readonly CareerOptionView[] {
  return Object.freeze(options.map((option) => {
    if (info.stage === "category") {
      const category = option.optionId.replace(/^field-/, "") as CareerCategoryId;
      const hint = CAREER_CATEGORY_IDS.includes(category)
        ? safeLabel(context.translate, careerCategoryHintKey(category), "先累積經驗，再慢慢找方向")
        : "先累積經驗，再慢慢找方向";
      return Object.freeze({
        optionId: option.optionId,
        label: safeLabel(context.translate, option.labelKey, "一個工作領域"),
        incomeText: null,
        note: hint,
        disabled: false
      });
    }

    const entry = CAREER_ESTIMATE_BY_ID[option.optionId];
    // 防禦：事件包已經過濾，這裡再擋「不屬於本分類／本學歷層級／不在目錄」的選項。
    const mismatched =
      entry === undefined || entry.category !== info.category || entry.tier !== info.tier;
    if (mismatched) {
      return Object.freeze({
        optionId: option.optionId,
        label: safeLabel(context.translate, option.labelKey, entry?.name ?? "這份工作"),
        incomeText: null,
        note: "目前學歷還不適合這份工作",
        disabled: true
      });
    }
    const note = entry.minKnowledge > context.knowledge ? "需要較高的專業知識" : null;
    return Object.freeze({
      optionId: option.optionId,
      label: safeLabel(context.translate, option.labelKey, entry.name),
      incomeText: careerIncomeLabel(careerIncomeMicroUsd(entry)),
      note,
      disabled: false
    });
  }));
}
