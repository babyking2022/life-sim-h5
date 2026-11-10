/**
 * 開發用預覽：把 buildSceneSvg 的輸出直接放進 390×220 的框內截圖，
 * 用來快速檢查人物／配件幾何（不啟動整個遊戲）。
 *
 * 用法：node scripts/p3e-0073-preview.mjs [outDir]
 */
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const outDir = resolve(root, process.argv[2] ?? ".artifacts/0073-preview");
await mkdir(outDir, { recursive: true });
const bundlePath = resolve(root, ".artifacts/0073-preview-bundle.mjs");
await build({
  stdin: {
    contents: `export { buildSceneSvg, readSceneView } from "./packages/ui/src/p3e-scene.ts";`,
    resolveDir: root,
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: bundlePath,
  logLevel: "silent"
});
const { buildSceneSvg, readSceneView } = await import(`file://${bundlePath.replace(/\\/g, "/")}`);

const cases = [
  ["baby", { age: 1, playerSex: "male", residenceKind: "rural", hasPartner: false, partnerSex: null, partnerAge: null, petKind: "none", phase: "alive" }],
  ["child", { age: 4, playerSex: "female", residenceKind: "urban", hasPartner: false, partnerSex: null, partnerAge: null, petKind: "dog", phase: "alive" }],
  ["primary", { age: 8, playerSex: "male", residenceKind: "urban", hasPartner: true, partnerSex: "female", partnerAge: 8, petKind: "none", phase: "alive" }],
  ["teen", { age: 15, playerSex: "female", residenceKind: "rural", hasPartner: false, partnerSex: null, partnerAge: null, petKind: "cat", phase: "alive" }],
  ["university", { age: 20, playerSex: "male", residenceKind: "urban", hasPartner: true, partnerSex: "male", partnerAge: 21, petKind: "none", phase: "alive" }],
  ["young", { age: 30, playerSex: "female", residenceKind: "urban", hasPartner: true, partnerSex: "male", partnerAge: 32, petKind: "dog", phase: "alive" }],
  ["middle", { age: 48, playerSex: "male", residenceKind: "rural", hasPartner: true, partnerSex: "female", partnerAge: 46, petKind: "cat", phase: "alive" }],
  ["senior", { age: 68, playerSex: "female", residenceKind: "urban", hasPartner: true, partnerSex: "male", partnerAge: 70, petKind: "dog", phase: "alive" }]
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 220 }, deviceScaleFactor: 2 });
for (const [name, scene] of cases) {
  // buildSceneSvg 需要 ageStage/lifeStage；用 readSceneView 正規化。
  const view = readSceneView({ scene });
  const real = buildSceneSvg(view, `preview-${name}`);
  const html = `<html><body style="margin:0;background:#123">
    <div style="position:relative;width:390px;height:220px;background-color:#f7dca9;background-image:url('data:image/svg+xml,${encodeURIComponent(real)}');background-size:contain;background-position:center bottom;background-repeat:no-repeat;">
      <div style="position:absolute;top:8px;left:8px;width:42%;height:70px;background:rgba(20,26,20,.62);border-radius:10px"></div>
    </div></body></html>`;
  await page.setContent(html);
  await page.screenshot({ path: resolve(outDir, `${name}.png`) });
  await writeFile(resolve(outDir, `${name}.svg`), real, "utf8");

  console.log("wrote", name);
}
await browser.close();
