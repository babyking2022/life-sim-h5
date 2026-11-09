import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * GPT-WORKBUDDY-0065-A：production build 前自動重建 birth bundle。
 * 來源 fixtures 或產生器版本變更時會重寫 bundle；未變更則不動檔，
 * 因此 hashed 檔名穩定、也不會靜默沿用過期資料。
 */
const birthBundlePlugin = {
  name: "p3e-0065a-birth-bundle",
  apply: "build" as const,
  buildStart() {
    const output = execFileSync(
      process.execPath,
      ["scripts/p3e-0065a-birth-bundle.mjs", "--auto"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    process.stdout.write(output);
  }
};

export default defineConfig({
  root: resolve(root, "packages/ui"),
  base: "./",
  plugins: [birthBundlePlugin],
  build: {
    target: "es2020",
    outDir: resolve(root, ".artifacts/p1c-dist"),
    emptyOutDir: true,
    minify: true,
    sourcemap: false
  },
  server: {
    fs: { allow: [root] }
  }
});
