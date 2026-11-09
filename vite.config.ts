import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";

/**
 * GPT-WORKBUDDY-0065-A：lib build 也檢查 birth bundle 新鮮度。
 * 來源資料變更但 bundle 未更新時直接讓 build 失敗（UI build 則自動更新），
 * 兩條 build 路徑都不允許靜默沿用過期資料。
 */
const birthBundleCheckPlugin = {
  name: "p3e-0065a-birth-bundle-check",
  apply: "build" as const,
  buildStart() {
    const output = execFileSync(
      process.execPath,
      ["scripts/p3e-0065a-birth-bundle.mjs", "--check"],
      { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    process.stdout.write(output);
  }
};

export default defineConfig({
  plugins: [birthBundleCheckPlugin],
  build: {
    target: "es2020",
    outDir: ".artifacts/dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: "packages/engine/src/smoke.ts",
      formats: ["es"],
      fileName: () => "engine-smoke.js"
    }
  }
});
