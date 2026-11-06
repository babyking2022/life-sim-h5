import { describe, expect, it } from "vitest";
import * as contracts from "@life-sim/contracts";

/**
 * GPT-0031-A／GPT-0032-A｜個人經濟生命週期（純規則測試）。
 *
 * 重點：
 *
 * - 金額尺度：所有基準值都用「美元 × 1,000,000」表示，這裡同時斷言
 *   **micro-USD 精確值**與**換算後美元區間**，防止 10^6 尺度回歸；
 * - 0–15 歲個人經濟全 0；16／17 歲只有明確兼職才有錢；
 * - 18–22／23–64／65+ 依教育、知識、工作旗標、人生重心產生不同結果；
 * - 持續性 modifier 只來自明確旗標（`income:mod:`／`expense:mod:`），
 *   切換重心／轉職／退休時不會把基準差誤當永久加成。
 */

const NO_FLAGS: readonly string[] = [];
const USD = 1_000_000n;

function base(age: number, knowledge = 50, flags: readonly string[] = NO_FLAGS, focus: string | null = null) {
  return contracts.computeP3EBaseEconomy(age, knowledge, flags, focus);
}

function dollars(value: bigint): number {
  return Number(value) / 1e6;
}

function annualEconomy(input: {
  age: number;
  knowledge?: number;
  flags?: readonly string[];
  lifeFocusId?: string | null;
  previousBalanceMicroUsd?: bigint;
}) {
  return contracts.computeP3EAnnualEconomy({
    age: input.age,
    knowledge: input.knowledge ?? 50,
    flags: input.flags ?? NO_FLAGS,
    lifeFocusId: input.lifeFocusId ?? null,
    previousBalanceMicroUsd: input.previousBalanceMicroUsd ?? 0n
  });
}

describe("GPT-0031-A 就業狀態推導", () => {
  it("0–15 歲一律 none（沒有任何工作狀態）", () => {
    for (const age of [0, 3, 5, 12, 15]) {
      expect(contracts.deriveP3EEmploymentStatus(age, NO_FLAGS), `age ${age}`).toBe("none");
      expect(contracts.deriveP3EEmploymentStatus(age, ["job:corp", "teen:earned"]), `age ${age} flags`).toBe("none");
    }
  });

  it("16／17 歲：只有明確兼職旗標才有 part_time，其餘是 none／student", () => {
    expect(contracts.deriveP3EEmploymentStatus(16, NO_FLAGS)).toBe("none");
    expect(contracts.deriveP3EEmploymentStatus(17, NO_FLAGS)).toBe("none");
    expect(contracts.deriveP3EEmploymentStatus(16, ["teen:earned"])).toBe("part_time");
    expect(contracts.deriveP3EEmploymentStatus(17, ["edu:university"])).toBe("student");
    expect(contracts.deriveP3EEmploymentStatus(17, ["edu:university", "teen:earned"])).toBe("part_time");
  });

  it("18–22 歲：在學 0、就業／自營／兼職有各自的狀態", () => {
    expect(contracts.deriveP3EEmploymentStatus(18, NO_FLAGS)).toBe("none");
    expect(contracts.deriveP3EEmploymentStatus(20, ["edu:university"])).toBe("student");
    expect(contracts.deriveP3EEmploymentStatus(20, ["job:corp"])).toBe("employed");
    expect(contracts.deriveP3EEmploymentStatus(21, ["side:business"])).toBe("self_employed");
    expect(contracts.deriveP3EEmploymentStatus(22, ["teen:earned"])).toBe("part_time");
    expect(contracts.deriveP3EEmploymentStatus(20, ["retired"])).toBe("retired");
  });

  it("23–64 歲：預設就業，退休／在學／自營／兼職各自優先", () => {
    expect(contracts.deriveP3EEmploymentStatus(23, NO_FLAGS)).toBe("employed");
    expect(contracts.deriveP3EEmploymentStatus(40, NO_FLAGS)).toBe("employed");
    expect(contracts.deriveP3EEmploymentStatus(64, NO_FLAGS)).toBe("employed");
    expect(contracts.deriveP3EEmploymentStatus(40, ["retired"])).toBe("retired");
    expect(contracts.deriveP3EEmploymentStatus(40, ["pension:safe"])).toBe("retired");
    expect(contracts.deriveP3EEmploymentStatus(40, ["study:self"])).toBe("student");
    expect(contracts.deriveP3EEmploymentStatus(40, ["job:startup"])).toBe("self_employed");
    expect(contracts.deriveP3EEmploymentStatus(40, ["teen:earned"])).toBe("part_time");
    // edu:* 在 23 歲以後是學歷而不是在學。
    expect(contracts.deriveP3EEmploymentStatus(40, ["edu:master"])).toBe("employed");
  });

  it("65 歲以上：預設退休；working:senior 可工作到 71 歲", () => {
    expect(contracts.deriveP3EEmploymentStatus(65, NO_FLAGS)).toBe("retired");
    expect(contracts.deriveP3EEmploymentStatus(80, NO_FLAGS)).toBe("retired");
    expect(contracts.deriveP3EEmploymentStatus(65, ["working:senior"])).toBe("employed");
    expect(contracts.deriveP3EEmploymentStatus(71, ["working:senior"])).toBe("employed");
    expect(contracts.deriveP3EEmploymentStatus(72, ["working:senior"])).toBe("retired");
    expect(contracts.deriveP3EEmploymentStatus(66, ["working:senior", "retired"])).toBe("retired");
  });
});

describe("GPT-0032-A 金額尺度（micro-USD 與美元雙重斷言）", () => {
  it("0、5、15 歲：收入、支出都是 0", () => {
    for (const age of [0, 5, 15]) {
      const economy = base(age);
      expect(economy.annualIncomeMicroUsd, `income age ${age}`).toBe(0n);
      expect(economy.annualExpenseMicroUsd, `expense age ${age}`).toBe(0n);
    }
  });

  it("16／17 歲兼職 = 每年 2,400 美元（不是 2 美元、也不是 2,400 micro-USD）", () => {
    for (const age of [16, 17]) {
      const partTime = base(age, 50, ["teen:earned"]);
      expect(partTime.annualIncomeMicroUsd).toBe(2_400n * USD);
      expect(dollars(partTime.annualIncomeMicroUsd)).toBe(2_400);
      expect(partTime.annualExpenseMicroUsd).toBe(0n);
    }
  });

  it("23–64 歲全職：每年數千到數萬美元（知識 50 ⇒ 29,325 美元）", () => {
    const peak = base(35);
    expect(peak.status).toBe("employed");
    // (18,000 + 50 × 150) × 1.15 = 29,325 美元
    expect(peak.annualIncomeMicroUsd).toBe(29_325n * USD);
    expect(dollars(peak.annualIncomeMicroUsd)).toBe(29_325);
    // 支出：12,000 + 50 × 40 = 14,000 美元
    expect(peak.annualExpenseMicroUsd).toBe(14_000n * USD);

    for (const age of [23, 30, 45, 60, 64]) {
      const income = dollars(base(age).annualIncomeMicroUsd);
      expect(income, `age ${age} 年收入應在數千～數萬美元`).toBeGreaterThanOrEqual(10_000);
      expect(income, `age ${age} 年收入不該是數十萬美元`).toBeLessThanOrEqual(60_000);
    }
  });

  it("18–22 歲就業起薪 14,000 美元；在學 0 收入、7,000 美元支出", () => {
    const worker = base(20, 0, ["job:early"]);
    expect(worker.annualIncomeMicroUsd).toBe(14_000n * USD);
    expect(dollars(worker.annualIncomeMicroUsd)).toBe(14_000);

    const student = base(20, 50, ["edu:university"]);
    expect(student.annualIncomeMicroUsd).toBe(0n);
    expect(student.annualExpenseMicroUsd).toBe(7_000n * USD);
  });

  it("65 歲以上退休金 9,000 美元＋知識加成（封頂 2,000），且不隨年齡成長", () => {
    const at65 = base(65, 50);
    expect(at65.annualIncomeMicroUsd).toBe((9_000n + 50n * 25n) * USD);
    expect(dollars(at65.annualIncomeMicroUsd)).toBe(10_250);
    expect(base(100, 50).annualIncomeMicroUsd).toBe(at65.annualIncomeMicroUsd);
    expect(dollars(base(65, 100).annualIncomeMicroUsd)).toBe(11_000);
    expect(at65.annualExpenseMicroUsd).toBe(9_500n * USD);
    expect(base(65).annualIncomeMicroUsd).toBeLessThan(base(40).annualIncomeMicroUsd);
  });

  it("教育／知識／重心／自營都會改變成年收入（仍不是同一條曲線）", () => {
    const plain = base(35);
    const university = base(35, 50, ["edu:university"]);
    const master = base(35, 50, ["edu:master"]);
    const highKnowledge = base(35, 80);
    const studyFocus = base(35, 50, NO_FLAGS, "study");
    const hobbyFocus = base(35, 50, NO_FLAGS, "hobby");

    expect(university.annualIncomeMicroUsd).toBe(((18_000n + 50n * 150n + 3_000n) * 1_150_000n) / 1_000_000n * USD);
    expect(master.annualIncomeMicroUsd).toBe(((18_000n + 50n * 150n + 6_000n) * 1_150_000n) / 1_000_000n * USD);
    expect(highKnowledge.annualIncomeMicroUsd).toBeGreaterThan(plain.annualIncomeMicroUsd);
    expect(studyFocus.annualIncomeMicroUsd).toBeGreaterThan(plain.annualIncomeMicroUsd);
    expect(hobbyFocus.annualIncomeMicroUsd).toBeLessThan(plain.annualIncomeMicroUsd);

    const selfEmployed = base(40, 50, ["job:startup"]);
    expect(selfEmployed.annualIncomeMicroUsd).toBeGreaterThan(base(40).annualIncomeMicroUsd);
    expect(selfEmployed.annualExpenseMicroUsd).toBeGreaterThan(base(40).annualExpenseMicroUsd);
  });
});

describe("GPT-0032-A 持續性 modifier（明確來源，不猜測）", () => {
  it("讀寫 modifier 旗標（累計、可為負、維持升冪、0 時移除）", () => {
    let flags = contracts.replaceP3EMoneyModifierFlag(NO_FLAGS, "income", 3_000n * USD);
    expect(flags).toEqual(["income:mod:3000000000"]);
    expect(contracts.readP3EMoneyModifierMicroUsd(flags, "income")).toBe(3_000n * USD);

    flags = contracts.applyP3EMoneyModifierDelta(flags, { annualIncomeMicroUsd: "-500000000", annualExpenseMicroUsd: 0n });
    expect(contracts.readP3EMoneyModifierMicroUsd(flags, "income")).toBe(2_500n * USD);

    flags = contracts.applyP3EMoneyModifierDelta(flags, { annualIncomeMicroUsd: -2_500n * USD, annualExpenseMicroUsd: 0n });
    expect(contracts.readP3EMoneyModifierMicroUsd(flags, "income")).toBe(0n);
    expect(flags).toEqual([]);

    // 壞格式忽略、不拋錯。
    expect(contracts.readP3EMoneyModifierMicroUsd(["income:mod:oops"], "income")).toBe(0n);
  });

  it("年度結算只加明確 modifier；沒有 modifier 時就是基準值", () => {
    const baseline = base(40);
    const plain = annualEconomy({ age: 40, previousBalanceMicroUsd: 10n * USD });
    expect(plain.annualIncomeMicroUsd).toBe(baseline.annualIncomeMicroUsd);
    expect(plain.balanceMicroUsd).toBe(10n * USD + baseline.annualIncomeMicroUsd - baseline.annualExpenseMicroUsd);

    const withRaise = annualEconomy({
      age: 40,
      flags: ["income:mod:3000000000"],
      previousBalanceMicroUsd: 0n
    });
    expect(withRaise.annualIncomeMicroUsd).toBe(baseline.annualIncomeMicroUsd + 3_000n * USD);
  });

  it("切換重心不會把基準差誤當永久加成（study → hobby）", () => {
    const studyBase = base(35, 50, NO_FLAGS, "study");
    const hobbyBase = base(35, 50, NO_FLAGS, "hobby");
    // 玩家在 study 重心下累積了 0 modifier，隔年切到 hobby：
    const next = annualEconomy({ age: 36, lifeFocusId: "hobby" });
    expect(next.annualIncomeMicroUsd).toBe(base(36, 50, NO_FLAGS, "hobby").annualIncomeMicroUsd);
    expect(next.annualIncomeMicroUsd).toBeLessThan(studyBase.annualIncomeMicroUsd);
    expect(next.annualIncomeMicroUsd).not.toBe(hobbyBase.annualIncomeMicroUsd + (studyBase.annualIncomeMicroUsd - hobbyBase.annualIncomeMicroUsd));
  });

  it("轉職／退休：基準差不會變成永久事件加成（employed → retired）", () => {
    const employed = annualEconomy({ age: 64, previousBalanceMicroUsd: 100_000n * USD });
    const retired = annualEconomy({ age: 65, flags: ["retired"], previousBalanceMicroUsd: employed.balanceMicroUsd });
    const retiredBase = base(65, 50, ["retired"]);
    expect(retired.annualIncomeMicroUsd).toBe(retiredBase.annualIncomeMicroUsd);
    expect(retired.annualIncomeMicroUsd).toBeLessThan(employed.annualIncomeMicroUsd);
  });

  it("學生 → 就業：收入跳到新狀態的基準，不會疊加學生期的差額", () => {
    const student = annualEconomy({ age: 22, flags: ["edu:university"], previousBalanceMicroUsd: 0n });
    expect(student.annualIncomeMicroUsd).toBe(0n);
    const worker = annualEconomy({ age: 23, flags: ["edu:university"], previousBalanceMicroUsd: 0n });
    expect(worker.annualIncomeMicroUsd).toBe(base(23, 50, ["edu:university"]).annualIncomeMicroUsd);
    expect(worker.annualIncomeMicroUsd).toBeGreaterThan(0n);
  });

  it("真正的事件加薪跨狀態仍然保留（employed → self-employed）", () => {
    const raise = 3_000n * USD;
    const flags = contracts.replaceP3EMoneyModifierFlag(NO_FLAGS, "income", raise);
    const selfEmployed = annualEconomy({ age: 41, flags: [...flags, "job:startup"], previousBalanceMicroUsd: 0n });
    expect(selfEmployed.annualIncomeMicroUsd).toBe(base(41, 50, ["job:startup"]).annualIncomeMicroUsd + raise);
  });

  it("0–15 歲：modifier 也不會讓兒童有錢（權威歸零）", () => {
    const flags = contracts.replaceP3EMoneyModifierFlag(NO_FLAGS, "income", 5_000n * USD);
    expect(annualEconomy({ age: 10, flags, previousBalanceMicroUsd: 9n * USD })).toEqual(contracts.P3E_ZERO_ASSETS);
    expect(contracts.normalizeP3EAssetsForAge(15, { balanceMicroUsd: 1n, annualIncomeMicroUsd: 2n, annualExpenseMicroUsd: 3n })).toEqual(
      contracts.P3E_ZERO_ASSETS
    );
    const teen = { balanceMicroUsd: 1n, annualIncomeMicroUsd: 2n, annualExpenseMicroUsd: 3n };
    expect(contracts.normalizeP3EAssetsForAge(16, teen)).toBe(teen);
  });
});
