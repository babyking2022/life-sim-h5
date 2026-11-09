import { describe, expect, it } from "vitest";
import {
  CNY_LABEL,
  CNY_PER_USD_DENOMINATOR,
  CNY_PER_USD_NUMERATOR,
  CNY_PLACEHOLDER,
  careerIncomeLabel,
  cnyMicroFromUsdMicro,
  financeDisplay,
  formatCompactCnyFromMicro,
  formatCompactCnyFromUsdMicro,
  formatCnyFromMicro,
  formatCnyFromUsdMicro
} from "../src/p3e-cny";

/**
 * GPT-WORKBUDDY-0054-B｜任務三驗收：收入／資產顯示為 CNY。
 *
 * 內部 microUsd 與百分位演算法完全不動；這裡只驗證「顯示層」的固定
 * 1 USD = 7.2 CNY 換算、CNY 標籤、未成年「—」、以及不外洩 internal key。
 */

/** 畫面上絕對不可以出現的東西：$、microUsd 欄位名、事件／決策／flag key。 */
const FORBIDDEN_RE = /\$|microUsd|p3[ab]\.|ev\.|dec\.|job:|career:|pet:|annualIncome/i;

describe("GPT-0054-B CNY：固定匯率 1 USD = 7.2 CNY", () => {
  it("匯率以整數比例 72/10 表示，micro-USD → micro-CNY 定點換算精確", () => {
    expect(CNY_PER_USD_NUMERATOR).toBe(72n);
    expect(CNY_PER_USD_DENOMINATOR).toBe(10n);
    expect(cnyMicroFromUsdMicro("1000000")).toBe(7_200_000n);
    expect(cnyMicroFromUsdMicro("0")).toBe(0n);
    expect(cnyMicroFromUsdMicro("-1000000")).toBe(-7_200_000n);
    // 大金額仍逐位元精確（若用浮點數這裡會掉精度）。
    expect(cnyMicroFromUsdMicro("999999999999999")).toBe(7_199_999_999_999_992n);
    expect(formatCnyFromUsdMicro("999999999999999")).toBe("CNY 7,199,999,999.99");
  });

  it("完整金額以 CNY 開頭、有千分位與兩位小數，不再出現 $", () => {
    expect(formatCnyFromUsdMicro("1000000")).toBe("CNY 7.20");
    expect(formatCnyFromUsdMicro("359576800000")).toBe("CNY 2,588,952.96");
    expect(formatCnyFromMicro(7_200_000n)).toBe("CNY 7.20");
    expect(formatCnyFromMicro(-7_200_000n)).toBe("-CNY 7.20");
    for (const text of [
      formatCnyFromUsdMicro("1000000"),
      formatCnyFromUsdMicro("359576800000"),
      formatCnyFromMicro(7_200_000n)
    ]) {
      expect(text.startsWith(`${CNY_LABEL} `)).toBe(true);
      expect(FORBIDDEN_RE.test(text)).toBe(false);
    }
  });

  it("緊湊金額使用萬／億，且一律帶 CNY 標籤", () => {
    expect(formatCompactCnyFromUsdMicro("12000000000")).toBe("CNY 8.6萬");
    expect(formatCompactCnyFromUsdMicro("34000000000")).toBe("CNY 24.5萬");
    expect(formatCompactCnyFromUsdMicro("20000000000000")).toBe("CNY 1.4億");
    expect(formatCompactCnyFromMicro(86400n * 1_000_000n)).toBe("CNY 8.6萬");
    // 小於一萬時回到完整金額，不硬套「萬」。
    expect(formatCompactCnyFromUsdMicro("1000000")).toBe("CNY 7.20");
    for (const text of [
      formatCompactCnyFromUsdMicro("12000000000"),
      formatCompactCnyFromUsdMicro("20000000000000"),
      formatCompactCnyFromUsdMicro("1000000")
    ]) {
      expect(text).toContain(CNY_LABEL);
      expect(FORBIDDEN_RE.test(text)).toBe(false);
    }
  });

  it("未成年收入／資產一律「—」，不會因換算恢復兒童金額", () => {
    expect(CNY_PLACEHOLDER).toBe("—");
    for (const value of ["0", "1000000", "34000000000", "-5000000", "garbage"]) {
      expect(financeDisplay(value, true, false)).toBe("—");
      expect(financeDisplay(value, true, true)).toBe("—");
    }
    // 成年才正常換算。
    expect(financeDisplay("1000000", false, false)).toBe("CNY 7.20");
    expect(financeDisplay("12000000000", false, true)).toBe("CNY 8.6萬");
  });

  it("無效／畸形值回「—」，絕不把原始 microUsd 或 internal key 印到畫面", () => {
    const invalid = [
      "", "abc", "12.5", "1e6", "NaN", "undefined", "null",
      "microUsd", "$100", "-", "--1", " 1000000", "1000000 ", "0x10",
      "p3b.career.software_engineer", "annualIncomeMicroUsd"
    ];
    for (const value of invalid) {
      expect(cnyMicroFromUsdMicro(value)).toBeNull();
      expect(formatCnyFromUsdMicro(value)).toBe("—");
      expect(formatCompactCnyFromUsdMicro(value)).toBe("—");
      expect(financeDisplay(value, false, true)).toBe("—");
      expect(financeDisplay(value, false, false)).toBe("—");
    }
    expect(cnyMicroFromUsdMicro(42 as unknown as string)).toBeNull();
    expect(cnyMicroFromUsdMicro(null as unknown as string)).toBeNull();
  });

  it("職業按鈕收入文案明確標 CNY，沒有 $／internal key", () => {
    const label = careerIncomeLabel("34000000000");
    expect(label).toBe("預估年收入 CNY 24.5萬");
    expect(label).toContain(CNY_LABEL);
    expect(FORBIDDEN_RE.test(label)).toBe(false);
    expect(careerIncomeLabel("bogus")).toBe("預估年收入 —");
  });

  it("百分位文字不被誤當成貨幣：CNY 輸出不含百分比符號，也不接受百分比字串", () => {
    expect(financeDisplay("85%", false, true)).toBe("—");
    expect(financeDisplay("top 10%", false, false)).toBe("—");
    for (const text of [
      formatCnyFromUsdMicro("1000000"),
      formatCompactCnyFromUsdMicro("34000000000"),
      careerIncomeLabel("34000000000")
    ]) {
      expect(text).not.toContain("%");
    }
  });
});
