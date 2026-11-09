/**
 * GPT-WORKBUDDY-0065-A｜birth bundle 產生／新鮮度檢查入口。
 *
 * `p3e-0065a-generate-entry.ts` 需要 import 正式 validators（TypeScript 源碼），
 * 因此沿用專案既有 `generate:golden` 模式：先用 esbuild 把 TS 打包成
 * `.artifacts/p3e-0065a-generate.mjs`，再由 Node 執行。
 *
 * - `--auto`   （vite.p1c.config.ts buildStart）來源變更就自動重建；
 * - `--check`  （vite.config.ts buildStart）來源變更但 bundle 過期 → exit 1；
 * - `--force`  無條件重建。
 *
 * 沒有任何參數時視為 `--check` 的相反：單純拒絕，避免「靜默過期」。
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outfile = resolve(root, ".artifacts", "p3e-0065a-generate.mjs");
mkdirSync(resolve(root, ".artifacts"), { recursive: true });

await build({
  entryPoints: [resolve(root, "scripts", "p3e-0065a-generate-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  logLevel: "silent"
});

const module = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
module.run(process.argv.slice(2));
