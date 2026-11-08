import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ellipsizeName,
  readComparisonView,
  readPartnerIdentity,
  readProfileRelationship,
  readProfileResidence,
  readProfileRole
} from "../src/p3e-view-readers";
import { zhHantCountryName, ZH_HANT_BY_ISO3 } from "../src/p3e-country-hant";

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

describe("readProfileRole（GPT-0040-B 角色即時狀態）", () => {
  it("缺失或非物件時回傳 null，不假造身分", () => {
    expect(readProfileRole(null)).toBeNull();
    expect(readProfileRole({})).toBeNull();
    expect(readProfileRole({ profile: null })).toBeNull();
    expect(readProfileRole({ profile: { currentRole: null } })).toBeNull();
  });

  it("學生身分映射為「目前身分」自然繁體", () => {
    expect(readProfileRole({ profile: { currentRole: { id: "junior_high_student" } } })).toEqual({
      id: "junior_high_student",
      label: "初中生",
      rowLabel: "目前身分"
    });
    expect(readProfileRole({ profile: { currentRole: { id: "primary_student" } } })?.label).toBe("小學生");
    expect(readProfileRole({ profile: { currentRole: { id: "university_student" } } })?.label).toBe("大學生");
    expect(readProfileRole({ profile: { currentRole: { id: "doctoral_student" } } })?.label).toBe("博士生");
  });

  it("職業映射為「目前職業」自然繁體", () => {
    expect(readProfileRole({ profile: { currentRole: { id: "engineer" } } })).toEqual({
      id: "engineer",
      label: "工程師",
      rowLabel: "目前職業"
    });
    expect(readProfileRole({ profile: { currentRole: { id: "software_engineer" } } })?.label).toBe("軟體工程師");
    expect(readProfileRole({ profile: { currentRole: { id: "accountant" } } })?.label).toBe("會計");
    expect(readProfileRole({ profile: { currentRole: { id: "office_worker" } } })?.label).toBe("行政人員");
  });

  it("退休與待業屬「目前身分」", () => {
    expect(readProfileRole({ profile: { currentRole: { id: "retired" } } })?.label).toBe("退休");
    expect(readProfileRole({ profile: { currentRole: { id: "gap_year" } } })?.label).toBe("待業");
  });

  it("未知 role ID 顯示「狀態更新中」且不洩漏 internal key", () => {
    const result = readProfileRole({ profile: { currentRole: { id: "p3b.secret.role" } } });
    expect(result?.label).toBe("狀態更新中");
    expect(result?.id).toBe("");
    expect(result?.label).not.toContain("p3b.");
  });
});

describe("readProfileResidence（GPT-0040-B 居住國）", () => {
  it("讀 entityId／regionCode；兩者皆缺失回傳 null", () => {
    expect(readProfileResidence(null)).toBeNull();
    expect(readProfileResidence({ profile: { residence: {} } })).toBeNull();
    expect(
      readProfileResidence({ profile: { residence: { entityId: "cr:HRV", regionCode: "HRV" } } })
    ).toEqual({ entityId: "cr:HRV", regionCode: "HRV" });
    expect(
      readProfileResidence({ profile: { residence: { regionCode: "HRV" } } })
    ).toEqual({ entityId: "", regionCode: "HRV" });
  });
});

describe("readProfileRelationship（GPT-0040-B 情感狀態）", () => {
  it("五種狀態映射為自然繁體；只有 married／dating 帶姓名", () => {
    expect(readProfileRelationship({ profile: { relationship: { status: "single" } } })?.label).toBe("單身");
    expect(readProfileRelationship({ profile: { relationship: { status: "divorced" } } })?.label).toBe("離異");
    expect(readProfileRelationship({ profile: { relationship: { status: "widowed" } } })?.label).toBe("喪偶");
    expect(
      readProfileRelationship({ profile: { relationship: { status: "married", personName: "王小明" } } })?.label
    ).toBe("已婚 · 王小明");
    expect(
      readProfileRelationship({ profile: { relationship: { status: "dating", personName: "林美玲" } } })?.label
    ).toBe("交往中 · 林美玲");
  });

  it("married 無姓名時只顯示狀態", () => {
    expect(readProfileRelationship({ profile: { relationship: { status: "married" } } })?.label).toBe("已婚");
  });

  it("divorced／widowed 即便有前任姓名也不顯示姓名", () => {
    const divorced = readProfileRelationship({
      profile: { relationship: { status: "divorced", personName: "前妻" } }
    });
    expect(divorced?.label).toBe("離異");
    expect(divorced?.label).not.toContain("前妻");
  });

  it("無效狀態顯示「狀態更新中」，不洩漏 internal key", () => {
    const result = readProfileRelationship({ profile: { relationship: { status: "p3b.invalid" } } });
    expect(result?.status).toBe("unknown");
    expect(result?.label).toBe("狀態更新中");
    expect(result?.label).not.toContain("p3b.");
  });

  it("完全缺失時回傳 null", () => {
    expect(readProfileRelationship(null)).toBeNull();
    expect(readProfileRelationship({})).toBeNull();
  });

  it("向後相容舊 view.partner（profile.relationship 缺失時）", () => {
    const result = readProfileRelationship({ partner: { displayName: "陳怡君", status: "married" } });
    expect(result?.status).toBe("married");
    expect(result?.label).toBe("已婚 · 陳怡君");
  });
});

/* GPT-0041-B：舊 view.partner 相容映射六態回歸（不得在 UI 重新發明關係狀態機）。 */
describe("readProfileRelationship 舊 view.partner 六態映射（GPT-0041-B）", () => {
  it("single → 單身，不帶姓名、不假稱交往中", () => {
    const r = readProfileRelationship({ partner: { displayName: "某人", status: "single" } });
    expect(r?.status).toBe("single");
    expect(r?.label).toBe("單身");
    expect(r?.personName).toBeNull();
  });

  it("dating／partner／cohabit／cohabiting 都映射為 dating 且帶姓名", () => {
    for (const s of ["dating", "partner", "cohabit", "cohabiting"]) {
      const r = readProfileRelationship({ partner: { displayName: "阿芳", status: s } });
      expect(r?.status).toBe("dating");
      expect(r?.label).toBe("交往中 · 阿芳");
      expect(r?.personName).toBe("阿芳");
    }
  });

  it("married → 已婚 且帶姓名", () => {
    const r = readProfileRelationship({ partner: { displayName: "老王", status: "married" } });
    expect(r?.status).toBe("married");
    expect(r?.label).toBe("已婚 · 老王");
    expect(r?.personName).toBe("老王");
  });

  it("divorced → 離異，不顯示前任姓名", () => {
    const r = readProfileRelationship({ partner: { displayName: "前妻", status: "divorced" } });
    expect(r?.status).toBe("divorced");
    expect(r?.label).toBe("離異");
    expect(r?.personName).toBeNull();
  });

  it("widowed → 喪偶，不顯示前任姓名", () => {
    const r = readProfileRelationship({ partner: { displayName: "亡夫", status: "widowed" } });
    expect(r?.status).toBe("widowed");
    expect(r?.label).toBe("喪偶");
    expect(r?.personName).toBeNull();
  });

  it("未知 status（含 internal key）→ unknown／狀態更新中，不假稱交往中", () => {
    for (const s of ["p3b.unknown", "separated", null, undefined]) {
      const payload: Record<string, unknown> = { partner: { displayName: "某人" } };
      if (s !== undefined) payload.partner = { displayName: "某人", status: s as string };
      const r = readProfileRelationship(payload);
      expect(r?.status).toBe("unknown");
      expect(r?.label).toBe("狀態更新中");
      expect(r?.personName).toBeNull();
    }
  });
});

/* GPT-0043-B：舊 view.partner 無姓名六態（狀態讀取與姓名讀取拆開，不回 null、不假造姓名）。 */
describe("readProfileRelationship 舊 view.partner 無姓名六態（GPT-0043-B）", () => {
  const noNameCases = [
    { status: "single", expected: "single", label: "單身" },
    { status: "dating", expected: "dating", label: "交往中" },
    { status: "married", expected: "married", label: "已婚" },
    { status: "divorced", expected: "divorced", label: "離異" },
    { status: "widowed", expected: "widowed", label: "喪偶" }
  ];
  for (const c of noNameCases) {
    it(`${c.status} 無姓名時仍保留狀態，不帶姓名、不假稱交往中`, () => {
      const r = readProfileRelationship({ partner: { status: c.status } });
      expect(r?.status).toBe(c.expected);
      expect(r?.label).toBe(c.label);
      expect(r?.personName).toBeNull();
    });
  }

  it("widowed 無姓名（{partner:{status:\"widowed\"}}）不再回 null", () => {
    const r = readProfileRelationship({ partner: { status: "widowed" } });
    expect(r).not.toBeNull();
    expect(r?.status).toBe("widowed");
    expect(r?.label).toBe("喪偶");
    expect(r?.personName).toBeNull();
  });

  it("未知 status 無姓名 → unknown／狀態更新中，不假稱交往中", () => {
    const r = readProfileRelationship({ partner: { status: "separated" } });
    expect(r?.status).toBe("unknown");
    expect(r?.label).toBe("狀態更新中");
    expect(r?.personName).toBeNull();
  });

  it("無 status、有姓名 → 仍映射為 unknown，不帶姓名（不假造狀態）", () => {
    const r = readProfileRelationship({ partner: { displayName: "某人" } });
    expect(r?.status).toBe("unknown");
    expect(r?.label).toBe("狀態更新中");
    expect(r?.personName).toBeNull();
  });

  it("partner 記錄完全不存在 → 回 null（無可用資訊）", () => {
    expect(readProfileRelationship({ partner: {} })).toBeNull();
    expect(readProfileRelationship({})).toBeNull();
  });
});

/* GPT-0043-B：居住國必須是真正 zh-Hant（來源＝ Intl.DisplayNames，非簡→繁逐字替換）。 */
describe("zhHantCountryName（GPT-0043-B 居住國真正 zh-Hant 來源）", () => {
  it("關鍵回歸國家回傳真正 zh-Hant，無簡體", () => {
    expect(zhHantCountryName("CHN")).toBe("中國");
    expect(zhHantCountryName("HRV")).toBe("克羅埃西亞");
    expect(zhHantCountryName("USA")).toBe("美國");
    expect(zhHantCountryName("GBR")).toBe("英國");
    expect(zhHantCountryName("JPN")).toBe("日本");
    expect(zhHantCountryName("DEU")).toBe("德國");
  });

  it("任務指定的八個權威期望值（GPT-0043-B §1）", () => {
    expect(zhHantCountryName("HRV")).toBe("克羅埃西亞");
    expect(zhHantCountryName("UZB")).toBe("烏茲別克");
    expect(zhHantCountryName("AUS")).toBe("澳洲");
    expect(zhHantCountryName("ITA")).toBe("義大利");
    expect(zhHantCountryName("ETH")).toBe("衣索比亞");
    expect(zhHantCountryName("SAU")).toBe("沙烏地阿拉伯");
    expect(zhHantCountryName("CIV")).toBe("象牙海岸");
    expect(zhHantCountryName("BIH")).toBe("波士尼亞與赫塞哥維納");
  });

  it("最長常見國名為完整繁中：波士尼亞與赫塞哥維納", () => {
    expect(zhHantCountryName("BIH")).toBe("波士尼亞與赫塞哥維納");
  });

  it("查無或空 region code（含已移除的 TWN／HKG／MAC）回空字串（由呼叫方回退未知地區）", () => {
    expect(zhHantCountryName("")).toBe("");
    expect(zhHantCountryName("XXX")).toBe("");
    expect(zhHantCountryName("TWN")).toBe("");
    expect(zhHantCountryName("HKG")).toBe("");
    expect(zhHantCountryName("MAC")).toBe("");
  });

  it("completeness：registry 全部實體皆能取得非空繁中國名（不以簡體特徵 regex 證明全表）", () => {
    const regPath = new URL("../../../fixtures/p2a/country-registry.v1.json", import.meta.url);
    const registry = JSON.parse(readFileSync(regPath, "utf8"));
    const records = Array.isArray(registry)
      ? registry
      : registry.countries ?? registry.records ?? Object.values(registry);
    const missing = records
      .map((r: { regionCode?: string }) => r.regionCode)
      .filter((iso3: string) => typeof iso3 === "string" && zhHantCountryName(iso3) === "");
    expect(missing).toEqual([]);
  });

  it("靜態表 169 條（GPT-0046-B：已移除 TWN／HKG／MAC），且無先前漏掉的簡體「别」（針對性回歸守門，非全表證明）", () => {
    const entries = Object.entries(ZH_HANT_BY_ISO3 as Record<string, string>);
    expect(entries.length).toBe(169);
    const bad = entries.filter(([, v]) => v.includes("别"));
    expect(bad).toEqual([]);
  });
});
