import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    environment: "node",
    /*
     * P3-C：測試數與檔案數變多（58 檔／592 項），v8 覆蓋率instrumentation 會讓單一測試變慢 2–3 倍。
     * 預設 5s 逾時在滿載平行執行時會讓重的 P2-A 驗證測試偶發 timeout（不是行為問題）。
     * 這裡只放寬逾時，沒有改任何測試語義或覆蓋率門檻。
     */
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: ".artifacts/coverage",
      include: ["packages/engine/src/**/*.ts", "packages/birth/src/**/*.ts"],
      exclude: ["packages/engine/src/smoke.ts"],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
        /* P2-A.1：birth 套件自己的門檻，不靠 engine 覆蓋率拉高總體數字。 */
        "packages/birth/src/**/*.ts": {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90
        }
      }
    }
  }
});
