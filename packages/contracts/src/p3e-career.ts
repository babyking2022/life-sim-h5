/**
 * GPT-DEEPSEEK-0054-A｜資料化職業目錄（MVP）。
 *
 * ## 為什麼要有這張表
 *
 * 0040 的 `currentRole` 是「依既有 job choice 的池子決定性抽取」，玩家看不到、
 * 也不能選職業。這一張表把職業變成**正式資料**：
 *
 * - 6 個分類（一般服務／技術工種／行政商務／教育醫療／科技工程／創業自由業）；
 * - 24 個職業，每個都有穩定 `id`、繁中名稱 key、學歷／知識門檻、基礎年收入、
 *   分類與 `employmentKind`；
 * - 事件包用這張表**產生**兩階段決策：
 *   1. `ev.career.field`：選分類（6 個選項）；
 *   2. `ev.career.<field>.<tier>`：從該分類「符合學歷門檻」的職業裡選一個
 *      （entry＝未完成大學、degree＝已完成大學以上），因此不符合條件的職業
 *      根本不會出現在選項裡（不是靠 UI 隱藏）。
 *
 * ## 與其他模組的關係
 *
 * - 選職業時寫入 `job:<id>` 旗標（canonical state，可存檔／重播）；
 * - `p3e-profile` 的 `currentRole.id` 直接等於職業 id；
 * - 年收入效果用既有的 `money("annualIncomeMicroUsd", …)` 機制（會變成
 *   `income:mod:` 旗標），因此 economy 不需要新的分支；
 * - 名稱只放顯示層字典（`p3b.option.career.*`），不在 canonical state 裡塞中文。
 */

export const P3E_CAREER_SPEC_VERSION = "p3e-career-1.0.0";

export type P3ECareerCategoryId = "service" | "trade" | "office" | "care" | "tech" | "independent";

export type P3ECareerTier = "entry" | "degree";

export type P3ECareerEmploymentKind = "employed" | "self_employed";

export interface P3ECareerCategory {
  readonly id: P3ECareerCategoryId;
  /** 顯示層字典 key（繁中名稱）。 */
  readonly labelKey: string;
  /** 畫面上的短說明 key。 */
  readonly hintKey: string;
}

export interface P3ECareer {
  /** 穩定 id（同時是 `job:<id>` 旗標與 `currentRole.id`）。 */
  readonly id: string;
  readonly category: P3ECareerCategoryId;
  /** 顯示層字典 key（`p3b.career.<id>`）。 */
  readonly labelKey: string;
  /** 需要的學歷層級：0＝不拘、1＝大學、2＝研究所（碩／博）。 */
  readonly minEducation: 0 | 1 | 2;
  /** 需要的知識值（MVP：與 tier 一起當門檻）。 */
  readonly minKnowledge: number;
  /** 基礎年收入（micro-USD，1 USD = 1_000_000）。 */
  readonly baseAnnualIncomeMicroUsd: bigint;
  readonly employmentKind: P3ECareerEmploymentKind;
  /** 這個職業屬於哪一個決策 tier（entry＝未完成大學、degree＝大學以上）。 */
  readonly tier: P3ECareerTier;
}

export const P3E_CAREER_CATEGORIES: readonly P3ECareerCategory[] = Object.freeze([
  Object.freeze({ id: "service", labelKey: "p3b.career.category.service", hintKey: "p3b.career.category.service.hint" }),
  Object.freeze({ id: "trade", labelKey: "p3b.career.category.trade", hintKey: "p3b.career.category.trade.hint" }),
  Object.freeze({ id: "office", labelKey: "p3b.career.category.office", hintKey: "p3b.career.category.office.hint" }),
  Object.freeze({ id: "care", labelKey: "p3b.career.category.care", hintKey: "p3b.career.category.care.hint" }),
  Object.freeze({ id: "tech", labelKey: "p3b.career.category.tech", hintKey: "p3b.career.category.tech.hint" }),
  Object.freeze({
    id: "independent",
    labelKey: "p3b.career.category.independent",
    hintKey: "p3b.career.category.independent.hint"
  })
]);

const career = (
  id: string,
  category: P3ECareerCategoryId,
  minEducation: 0 | 1 | 2,
  minKnowledge: number,
  annualIncomeUsd: number,
  employmentKind: P3ECareerEmploymentKind = "employed"
): P3ECareer =>
  Object.freeze({
    id,
    category,
    labelKey: `p3b.career.${id}`,
    minEducation,
    minKnowledge,
    baseAnnualIncomeMicroUsd: BigInt(annualIncomeUsd) * 1_000_000n,
    employmentKind,
    tier: minEducation === 0 ? "entry" : "degree"
  });

/** 24 個正式職業（每個分類 4 個，entry／degree 各 2）。 */
export const P3E_CAREERS: readonly P3ECareer[] = Object.freeze([
  /* 一般服務 */
  career("waiter", "service", 0, 0, 6_000),
  career("cook", "service", 0, 0, 9_000),
  career("hotel_manager", "service", 1, 25, 22_000),
  career("chef", "service", 1, 30, 28_000),
  /* 技術工種 */
  career("factory_worker", "trade", 0, 0, 8_000),
  career("driver", "trade", 0, 0, 9_000),
  career("construction_worker", "trade", 0, 5, 11_000),
  career("electrician", "trade", 1, 25, 20_000),
  career("site_supervisor", "trade", 1, 25, 24_000),
  /* 行政商務 */
  career("clerk", "office", 0, 0, 10_000),
  career("salesperson", "office", 0, 5, 12_000),
  career("accountant", "office", 1, 30, 24_000),
  career("hr_specialist", "office", 1, 25, 22_000),
  /* 教育醫療 */
  career("care_worker", "care", 0, 10, 11_000),
  career("care_assistant", "care", 0, 5, 9_000),
  career("teacher", "care", 1, 35, 22_000),
  career("nurse", "care", 1, 35, 26_000),
  career("physician", "care", 2, 55, 42_000),
  /* 科技工程 */
  career("lab_technician", "tech", 0, 15, 14_000),
  career("designer", "tech", 0, 20, 16_000),
  career("engineer", "tech", 1, 40, 30_000),
  career("software_engineer", "tech", 1, 40, 34_000),
  /* 創業自由業 */
  career("farmer", "independent", 0, 0, 7_000),
  career("shopkeeper", "independent", 0, 5, 10_000),
  career("freelancer", "independent", 0, 15, 13_000),
  career("entrepreneur", "independent", 1, 25, 30_000),
  career("consultant", "independent", 1, 30, 26_000)
]);

export const P3E_CAREER_BY_ID: Readonly<Record<string, P3ECareer>> = Object.freeze(
  Object.fromEntries(P3E_CAREERS.map((entry) => [entry.id, entry]))
);

/** `job:<id>` 旗標前綴（選職業時寫入 canonical state）。 */
export const P3E_CAREER_FLAG_PREFIX = "job:";

/** 已完成「選分類 → 選職業」流程的旗標（避免重複觸發）。 */
export const P3E_CAREER_CHOSEN_FLAG = "career:chosen";

/** 選分類時寫入的旗標前綴。 */
export const P3E_CAREER_FIELD_FLAG_PREFIX = "career:field:";

export function careerFlag(careerId: string): string {
  return `${P3E_CAREER_FLAG_PREFIX}${careerId}`;
}

/** 從 flags 找出玩家選過的職業（沒有就是 null）。 */
export function readP3ECareerId(flags: readonly string[]): string | null {
  for (const entry of P3E_CAREERS) {
    if (flags.includes(careerFlag(entry.id))) return entry.id;
  }
  return null;
}

/** 依分類取職業。 */
export function careersOfCategory(category: P3ECareerCategoryId): readonly P3ECareer[] {
  return P3E_CAREERS.filter((entry) => entry.category === category);
}

/** 依分類與 tier 取職業（決策選項就是這一份清單）。 */
export function careersOfTier(category: P3ECareerCategoryId, tier: P3ECareerTier): readonly P3ECareer[] {
  return P3E_CAREERS.filter((entry) => entry.category === category && entry.tier === tier);
}

/** 學歷層級（0＝高中以下、1＝大學、2＝研究所）。 */
export function readP3EEducationTier(flags: readonly string[]): 0 | 1 | 2 {
  if (flags.includes("edu:doctorate") || flags.includes("edu:master")) return 2;
  if (flags.includes("edu:university")) return 1;
  return 0;
}

/** 這個職業在目前 flags／知識下能不能選。 */
export function isP3ECareerEligible(entry: P3ECareer, flags: readonly string[], knowledge: number): boolean {
  return readP3EEducationTier(flags) >= entry.minEducation && knowledge >= entry.minKnowledge;
}
