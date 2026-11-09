import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAREER_CATEGORY_IDS,
  CAREER_ESTIMATES,
  CAREER_ESTIMATE_BY_ID,
  buildCareerOptionViews,
  careerCategoryHintKey,
  careerIncomeMicroUsd,
  careerListNote,
  parseCareerDecision,
  type CareerOptionInput
} from "../src/p3e-career-view";
import { readProfileRole } from "../src/p3e-view-readers";

/**
 * GPT-WORKBUDDY-0054-B｜任務二驗收：兩階段職業決策 + CNY 年收入 + 無 internal key 外洩。
 *
 * 事件包（DeepSeek 0054-A）是權威來源；這裡逐筆比對 `deltaMicroUsd`，
 * 確保 UI 顯示層對照表不會與正式模擬資料漂移。
 */

interface PackOption {
  readonly optionId: string;
  readonly labelKey: string;
  readonly effects: readonly { readonly type: string; readonly field?: string; readonly deltaMicroUsd?: string }[];
}
interface PackDecision {
  readonly decisionId: string;
  readonly options: readonly PackOption[];
}
interface PackRecord {
  readonly decision?: PackDecision;
}

const readPack = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../fixtures/p3b/${name}`, import.meta.url)), "utf8")
  ) as unknown;

const events = readPack("events.v1.json") as { readonly records: readonly PackRecord[] };
const copy = (readPack("event-copy.zh-Hant.v1.json") as { readonly copy: Readonly<Record<string, string>> }).copy;

const DECISIONS: readonly PackDecision[] = events.records.flatMap((record) =>
  // 事件包的非決策紀錄可能是 null，不是單純缺欄位。
  record.decision === undefined || record.decision === null ? [] : [record.decision]
);
const decisionOf = (id: string): PackDecision => {
  const found = DECISIONS.find((decision) => decision.decisionId === id);
  if (found === undefined) throw new Error(`missing decision ${id}`);
  return found;
};

/** 模擬 p3e-real-main.ts 的 friendlyKey：字典優先，找不到不洩漏 raw key。 */
function translate(key: string): string {
  const fromCopy = copy[key];
  if (typeof fromCopy === "string" && fromCopy.length > 0) return fromCopy;
  if (/^[A-Za-z0-9._:-]+$/.test(key.trim())) return "人生的一段插曲";
  return key.trim();
}

const inputsOf = (decision: PackDecision): readonly CareerOptionInput[] =>
  decision.options.map((option) => ({ optionId: option.optionId, labelKey: option.labelKey }));

/** 畫面文字不得外洩：$、microUsd、事件／決策／flag key。 */
const FORBIDDEN_RE = /\$|microUsd|p3[ab]\.|ev\.|dec\.|job:|career:|pet:|annualIncome/i;

function assertClean(text: string): void {
  expect(FORBIDDEN_RE.test(text)).toBe(false);
}

describe("GPT-0054-B 職業目錄：與事件包逐筆一致", () => {
  it("27 種職業、6 個分類、ID 唯一、entry/degree 兩層", () => {
    expect(CAREER_ESTIMATES).toHaveLength(27);
    expect(CAREER_CATEGORY_IDS).toHaveLength(6);
    expect(new Set(CAREER_ESTIMATES.map((entry) => entry.id)).size).toBe(27);
    for (const entry of CAREER_ESTIMATES) {
      expect(CAREER_CATEGORY_IDS).toContain(entry.category);
      expect(["entry", "degree"]).toContain(entry.tier);
      expect(entry.tier).toBe(entry.minEducation === 0 ? "entry" : "degree");
      expect(entry.annualIncomeUsd).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(CAREER_ESTIMATE_BY_ID[entry.id]).toBe(entry);
    }
  });

  it("每個兩階段職業選項的年收入 micro-USD 與事件包 deltaMicroUsd 完全相同", () => {
    const jobDecisions = DECISIONS.filter((decision) => {
      const info = parseCareerDecision(decision.decisionId);
      return info?.stage === "job";
    });
    expect(jobDecisions).toHaveLength(12);

    let checked = 0;
    for (const decision of jobDecisions) {
      const info = parseCareerDecision(decision.decisionId);
      expect(info).not.toBeNull();
      for (const option of decision.options) {
        const money = option.effects.find((effect) => effect.type === "money" && effect.field === "annualIncomeMicroUsd");
        expect(money?.deltaMicroUsd).toBeDefined();
        const entry = CAREER_ESTIMATE_BY_ID[option.optionId];
        expect(entry, `missing estimate for ${option.optionId}`).toBeDefined();
        expect(careerIncomeMicroUsd(entry!)).toBe(money!.deltaMicroUsd!);
        // 分類／學歷層級也必須與決策 ID 一致，否則 UI 會防禦性停用正式選項。
        expect(entry!.category).toBe(info!.category);
        expect(entry!.tier).toBe(info!.tier);
        checked += 1;
      }
    }
    expect(checked).toBe(27);
  });

  it("事件包 27 個職業選項沒有任何一個被 UI 目錄漏接或多列", () => {
    const ids = DECISIONS.filter((decision) => parseCareerDecision(decision.decisionId)?.stage === "job")
      .flatMap((decision) => decision.options.map((option) => option.optionId));
    expect(new Set(ids).size).toBe(27);
    expect([...ids].sort()).toEqual([...CAREER_ESTIMATES.map((entry) => entry.id)].sort());
  });

  it("選完職業後「目前職業」立即顯示具體名稱，人生紀錄也有對應的繁中選項文案", () => {
    // UI 的 friendlyChosenOption 會用 ev.adult.career-<category>-<tier> 組回 labelKey。
    const jobDecisionByOption = new Map<string, string>();
    for (const decision of DECISIONS) {
      const info = parseCareerDecision(decision.decisionId);
      if (info?.stage !== "job") continue;
      for (const option of decision.options) jobDecisionByOption.set(option.optionId, decision.decisionId);
    }
    for (const entry of CAREER_ESTIMATES) {
      const role = readProfileRole({ profile: { currentRole: { id: entry.id } } });
      expect(role, `missing role label for ${entry.id}`).not.toBeNull();
      expect(role!.id).toBe(entry.id);
      expect(role!.rowLabel).toBe("目前職業");
      expect(role!.label.length).toBeGreaterThan(0);
      expect(role!.label).not.toBe("狀態更新中");
      assertClean(role!.label);

      const decisionId = jobDecisionByOption.get(entry.id);
      expect(decisionId).toBeDefined();
      // UI 的 friendlyChosenOption 會把 ev.adult.career-<category>-<tier> 組回
      // p3b.option.<suffix>.<optionId>，正是事件包的 labelKey；人生紀錄因此顯示具體職業名。
      const labelKey = `p3b.option.${decisionId!.replace(/^dec\./, "")}.${entry.id}`;
      const option = DECISIONS.find((d) => d.decisionId === decisionId)!
        .options.find((o) => o.optionId === entry.id)!;
      expect(option.labelKey).toBe(labelKey);
      expect(copy[labelKey]).toBe(entry.name);
      expect(copy[labelKey]).toBe(role!.label);
      assertClean(copy[labelKey]!);
    }
  });
});

describe("GPT-0054-B 兩階段決策辨識", () => {
  it("第一階段 dec.adult.career-field → category", () => {
    expect(parseCareerDecision("dec.adult.career-field")).toEqual({
      stage: "category", category: null, tier: null
    });
  });

  it("第二階段 12 個 dec.adult.career-<category>-<tier> → job", () => {
    const found = DECISIONS.map((decision) => decision.decisionId)
      .filter((id) => parseCareerDecision(id)?.stage === "job");
    expect(found).toHaveLength(12);
    for (const id of found) {
      const info = parseCareerDecision(id);
      expect(info?.stage).toBe("job");
      expect(CAREER_CATEGORY_IDS).toContain(info!.category);
      expect(["entry", "degree"]).toContain(info!.tier);
    }
    expect(parseCareerDecision("dec.adult.career-tech-degree")).toEqual({
      stage: "job", category: "tech", tier: "degree"
    });
  });

  it("非兩階段職業決策（pivot / first-job / 青少年事件 / 寵物）回 null，走原本 renderPending", () => {
    for (const id of [
      "dec.adult.career-pivot", "dec.adult.first-job", "dec.adult.first-pet",
      "dec.teen.path", "dec.child.school", "dec.adult.relationship",
      "dec.adult.career-field.extra", "dec.adult.career-unknown-entry", "dec.adult.career-tech-phd", ""
    ]) {
      expect(parseCareerDecision(id)).toBeNull();
    }
  });

  it("分類提示與清單說明是自然繁中，沒有 internal key", () => {
    for (const category of CAREER_CATEGORY_IDS) {
      const key = careerCategoryHintKey(category);
      expect(key).toBe(`p3b.career.category.${category}.hint`);
      expect(typeof copy[key]).toBe("string");
      assertClean(copy[key]!);
    }
    const categoryNote = careerListNote(parseCareerDecision("dec.adult.career-field")!);
    const jobNote = careerListNote(parseCareerDecision("dec.adult.career-tech-degree")!);
    expect(categoryNote).toContain("先選一個工作領域");
    expect(jobNote).toContain("學歷");
    assertClean(categoryNote);
    assertClean(jobNote);
  });
});

describe("GPT-0054-B 職業選項顯示（兩欄卡片）", () => {
  it("第一階段：6 個分類卡片顯示領域名稱 + 自然提示，沒有收入金額", () => {
    const info = parseCareerDecision("dec.adult.career-field")!;
    const views = buildCareerOptionViews(inputsOf(decisionOf("dec.adult.career-field")), info, {
      translate, knowledge: 20
    });
    expect(views).toHaveLength(6);
    for (const view of views) {
      expect(view.disabled).toBe(false);
      expect(view.incomeText).toBeNull();
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.note).not.toBeNull();
      assertClean(view.label);
      assertClean(view.note!);
      // 字典查不到時也不能印 raw key。
      expect(view.label).not.toMatch(/^p3b\./);
      expect(view.note).not.toMatch(/^p3b\./);
    }
  });

  it("第二階段：每個職業顯示名稱 + 預估年收入 CNY，沒有 $／microUsd／internal key", () => {
    for (const decision of DECISIONS) {
      const info = parseCareerDecision(decision.decisionId);
      if (info?.stage !== "job") continue;
      const views = buildCareerOptionViews(inputsOf(decision), info, { translate, knowledge: 999 });
      expect(views).toHaveLength(decision.options.length);
      for (const view of views) {
        expect(view.disabled).toBe(false);
        expect(view.incomeText).toContain("CNY");
        expect(view.incomeText).toContain("預估年收入");
        expect(view.label.length).toBeGreaterThan(0);
        assertClean(view.label);
        assertClean(view.incomeText!);
        if (view.note !== null) assertClean(view.note);
      }
    }
    const tech = buildCareerOptionViews(
      inputsOf(decisionOf("dec.adult.career-tech-degree")),
      parseCareerDecision("dec.adult.career-tech-degree")!,
      { translate, knowledge: 999 }
    );
    expect(tech.map((view) => view.label)).toEqual(["工程師", "軟體工程師"]);
    expect(tech[1]?.incomeText).toBe("預估年收入 CNY 24.5萬");
  });

  it("不符合分類／學歷層級或不在目錄的選項被停用並用自然繁中說明", () => {
    const info = parseCareerDecision("dec.adult.career-tech-degree")!;
    const views = buildCareerOptionViews(
      [
        { optionId: "waiter", labelKey: "p3b.option.adult.career-service-entry.waiter" }, // 錯分類 + 錯 tier
        { optionId: "designer", labelKey: "p3b.option.adult.career-tech-entry.designer" }, // 對分類、錯 tier
        { optionId: "ghost_job", labelKey: "p3b.option.adult.career-tech-degree.ghost_job" } // 不在目錄
      ],
      info,
      { translate, knowledge: 999 }
    );
    expect(views).toHaveLength(3);
    for (const view of views) {
      expect(view.disabled).toBe(true);
      expect(view.incomeText).toBeNull();
      expect(view.note).toBe("目前學歷還不適合這份工作");
      assertClean(view.label);
      assertClean(view.note!);
    }
    // 已知職業仍用自然名稱，不印 raw key。
    expect(views[0]?.label).toBe("服務生");
  });

  it("知識不足只給提示、不停用，避免所有選項被鎖死", () => {
    const info = parseCareerDecision("dec.adult.career-tech-degree")!;
    const views = buildCareerOptionViews(
      inputsOf(decisionOf("dec.adult.career-tech-degree")), info, { translate, knowledge: 0 }
    );
    expect(views.every((view) => view.disabled === false)).toBe(true);
    expect(views.every((view) => view.note === "需要較高的專業知識")).toBe(true);
    expect(views.every((view) => view.incomeText?.includes("CNY"))).toBe(true);
  });

  it("字典缺漏／回傳 raw key 時降級為自然繁中名稱，不外洩 internal key", () => {
    const info = parseCareerDecision("dec.adult.career-care-degree")!;
    const rawTranslate = (key: string): string => key;
    const views = buildCareerOptionViews(
      inputsOf(decisionOf("dec.adult.career-care-degree")), info,
      { translate: rawTranslate, knowledge: 999 }
    );
    expect(views.map((view) => view.label)).toEqual(["教師", "護理師", "醫師"]);
    for (const view of views) {
      assertClean(view.label);
      assertClean(view.incomeText ?? "");
    }
  });
});
