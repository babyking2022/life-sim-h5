/**
 * GPT-WORKBUDDY-0058-B：從 vendor 的少量 Humation SVG 部件產生最小核心常數。
 *
 * 這支工具**只讀本機已 vendor 的 4 個 SVG**（`assets/generated/humation/`），
 * 不在執行期連網、不下載、不複製 86 個部件、不引入 React／編輯器。
 * 輸出 `packages/ui/src/p3e-kawaii-parts.ts`：把 SVG 部件內層轉成精簡字串，
 * 並把 Humation 的 CSS 色彩變數換成 `{{slot}}` 佔位符，由顯示層注入顏色。
 *
 * 用法：node scripts/p3e-0058b-vendor-parts.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = resolve(root, "assets/generated/humation");
const output = resolve(root, "packages/ui/src/p3e-kawaii-parts.ts");

const SPEC = [
  { key: "head/short", file: "head_003.svg" },
  { key: "head/fluffy-bob", file: "head_001.svg" },
  { key: "glasses/round", file: "glasses_001.svg" },
  { key: "cat/tabby", file: "cat_001.svg" }
];

/** 取出 <svg> 內層、降數字精度、壓掉標籤間空白、把 CSS 變數改為佔位符。 */
function compactSvg(source) {
  const inner = source
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .trim();
  return inner
    .replace(/-?\d+\.\d+/g, (value) => String(Math.round(Number(value) * 100) / 100))
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .replace(
      /var\(--hm-(stroke|hair|skin|clothes|bottom|background)(?:\s*,\s*[^)]*)?\)/g,
      "{{$1}}"
    );
}

const entries = SPEC.map(({ key, file }) => {
  const raw = readFileSync(resolve(vendorDir, file), "utf8");
  const compact = compactSvg(raw);
  if (compact.includes("<svg") || compact.includes("</svg>")) {
    throw new Error(`unexpected nested svg in ${file}`);
  }
  return { key, file, compact, bytes: Buffer.byteLength(raw), compactBytes: Buffer.byteLength(compact) };
});

const header = `/**
 * GPT-WORKBUDDY-0058-B｜Humation 最小 SVG 部件核心（**自動產生，勿手改**）。
 *
 * 來源：https://github.com/humation-labs/humation
 * Commit：85613cfac2d600c05847f403fc275336ab1fa240
 * 套件：packages/assets-humation-1（Humation 1，86 個部件）
 * 授權：MIT（程式與素材皆為 MIT，Copyright (c) 2026 Humation contributors）。
 *       完整授權文字保留在 assets/generated/humation/LICENSE.md，
 *       並於 assets/generated/SCENE-ATTRIBUTION.md 記載。
 *
 * 本專案只取 4 個必要部件（2 個頭型、1 副老花眼鏡、1 隻貓），
 * **沒有**搬入 86 個部件、React 套件、avatar builder 或整個示範網站。
 * 每個部件都是 80×80 viewBox 的手繪 SVG；顏色變數已轉成 {{slot}} 佔位符，
 * 由 p3e-scene.ts 注入確定性色彩，輸出仍是單張本機 data:image/svg+xml。
 *
 * 重新產生：node scripts/p3e-0058b-vendor-parts.mjs
 * 原始未修改 SVG：assets/generated/humation/*.svg
 */

/** 來源對照（供測試與 attribution 稽核）。 */
export const HUMATION_VENDORED_PARTS = Object.freeze([
${entries.map((e) => `  Object.freeze({ key: "${e.key}", source: "${e.file}", originalBytes: ${e.bytes}, compactBytes: ${e.compactBytes} })`).join(",\n")}
] as const);

export type HumationPartKey = ${entries.map((e) => `"${e.key}"`).join(" | ")};

/** 部件內層（無 <svg> 外殼、數字精度 2 位、CSS 變數改佔位符）。 */
const RAW_PARTS: Readonly<Record<HumationPartKey, string>> = Object.freeze({
${entries.map((e) => `  "${e.key}": ${JSON.stringify(e.compact)}`).join(",\n")}
});

export interface HumationColors {
  readonly stroke: string;
  readonly hair: string;
  readonly skin: string;
  readonly clothes: string;
  readonly bottom: string;
  readonly background: string;
}

/** 注入顏色後回傳部件內層 SVG；沒有用到的 slot 會被安全移除。 */
export function humationPart(key: HumationPartKey, colors: HumationColors): string {
  return RAW_PARTS[key].replace(/\\{\\{(stroke|hair|skin|clothes|bottom|background)\\}\\}/g, (_match, slot: string) =>
    colors[slot as keyof HumationColors] ?? "#4a3b32"
  );
}
`;

writeFileSync(output, header, "utf8");
console.log(
  `generated ${output} (${Buffer.byteLength(header)} bytes, ${entries.length} parts, ` +
    `raw ${entries.reduce((n, e) => n + e.bytes, 0)} → compact ${entries.reduce((n, e) => n + e.compactBytes, 0)} bytes)`
);
