/**
 * GPT-WORKBUDDY-0062-B｜由官方 Open Peeps CC0 全身 SVG 產生最小 TS 常數模組。
 *
 * - 只讀 `assets/generated/open-peeps/*.svg`（由 openpeeps.com 官方
 *   "Grab and go / Standing" 區下載後原樣保存），**不在執行期連網**。
 * - 壓縮：去 XML 宣告／註解／title／desc、去 <svg> 外殼、降路徑與 transform
 *   的數字精度至 2 位、去多餘空白、把身體／頭部的黑白填色換成色彩佔位符。
 *   **不改繪圖筆觸、不重畫人物。**
 * - 輸出：`packages/ui/src/p3e-open-peeps.ts`、
 *   `assets/generated/open-peeps/SOURCE.md`、`.artifacts/p3e-0062b-assets.json`。
 *
 * 執行：node scripts/p3e-0062b-vendor-peeps.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetDir = join(root, "assets/generated/open-peeps");
const outTs = join(root, "packages/ui/src/p3e-open-peeps.ts");
const outSource = join(assetDir, "SOURCE.md");
const outReport = join(root, ".artifacts/p3e-0062b-assets.json");
const RETRIEVED = "2026-11-09";
const OFFICIAL = "https://www.openpeeps.com/";
const LEGALCODE = "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt";
const PEEPSTUDIO = "https://github.com/Hantuhan/peepstudio";
const PEEPSTUDIO_SHA = "3bad422845c470ae11531b765fe88451cdb2b66f";
const HOME_SHA = "35043e7dc1460850db46ae0d0fd36937846a3bd289ddedbb9ec047597f3de2b7";

/** key → 官方來源網址（皆為 openpeeps.com 官方 Webflow CDN）。 */
const SPEC = [
  { key: "male-a", file: "male-a.svg", sex: "male", url: "https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5361909b55b0502657e357_peep-standing-11.svg" },
  { key: "male-b", file: "male-b.svg", sex: "male", url: "https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5362a27488c217864c784d_peep-standing-20.svg" },
  { key: "male-c", file: "male-c.svg", sex: "male", url: "https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5362c164109d10570651c3_peep-standing-21.svg" },
  { key: "male-d", file: "male-d.svg", sex: "male", url: "https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5361ccd3992383f7595afc_peep-standing-13.svg" },
  { key: "female-a", file: "female-a.svg", sex: "female", url: "https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5360d39b55b049be5795a1_peep-standing-5.svg" },
  { key: "female-b", file: "female-b.svg", sex: "female", url: "https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5361568e2493c0fa0ae191_peep-standing-9.svg" },
  { key: "female-c", file: "female-c.svg", sex: "female", url: "https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5360ba550b761a0bfabd32_peep-standing-4.svg" },
  { key: "female-d", file: "female-d.svg", sex: "female", url: "https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e53633a7371bbe22da4c986_peep-standing-25.svg" }
];

const round2 = (value) => String(Math.round(Number(value) * 100) / 100);
const roundNumbers = (text) => text.replace(/-?\d+\.\d+/g, round2);

function compact(raw, key) {
  let s = raw
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<desc>[\s\S]*?<\/desc>/g, "");
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(s);
  if (vb === null) throw new Error(`${key}: missing viewBox`);
  const width = Number(vb[1]);
  const height = Number(vb[2]);
  const openEnd = s.indexOf(">", s.indexOf("<svg"));
  const close = s.lastIndexOf("</svg>");
  let inner = s.slice(openEnd + 1, close);

  // Sketch 匯出的官方 SVG：body/pose 的黑白路徑在 <g id="Head"> 之前，
  // head/face/accessories 在之後。兩段各自換色，才能得到膚色＋衣著＋髮色。
  const headAt = inner.indexOf('<g id="Head"');
  if (headAt < 0) throw new Error(`${key}: missing Head group`);
  const bodyPart = inner.slice(0, headAt);
  const headPart = inner.slice(headAt);
  const recolor = (part, ink, fill) => part
    .replace(/fill="#000000"/g, `fill="${ink}"`)
    .replace(/fill="#FFFFFF"/g, `fill="${fill}"`);
  let markup = recolor(bodyPart, "{{ink}}", "{{clothes}}") + recolor(headPart, "{{hair}}", "{{skin}}");

  // 只降精度、去空白與無用的容器 id；不改 path 指令本身。
  // 在官方真實群組上標 data-part，讓矩陣測試能直接檢查 Open Peeps 部件 key。
  markup = markup
    .replace(/ d="([^"]+)"/g, (_m, d) => ` d="${roundNumbers(d)}"`)
    .replace(/transform="([^"]+)"/g, (_m, t) => ` transform="${roundNumbers(t)}"`)
    // 官方 Sketch 匯出的群組 id 轉成 data-part 後，其餘 id 全數移除：
    // 包含 Sketch 圖層名稱裡的 emoji id（🎨-Background／🖍-Ink），
    // 這些只是中繼資料，不是可見人物或 emoji 貼圖；移除不影響任何筆觸。
    .replace(/<g id="((?:pose|head|face|facial-hair|accessories)\/[^"]+)"/g,
      (_m, id) => `<g data-part="openpeeps/${id}"`)
    .replace(/\s+id="[^"]*"/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!markup.includes("{{ink}}") || !markup.includes("{{skin}}")) {
    throw new Error(`${key}: color placeholders missing`);
  }
  return { markup, width, height };
}

function partIds(raw) {
  const groups = [...new Set([...raw.matchAll(/<g id="((?:pose|head|face|facial-hair|accessories)\/[^"]+)"/g)].map((m) => m[1]))];
  const find = (prefix) => groups.find((id) => id.startsWith(prefix)) ?? null;
  return {
    groups,
    pose: find("pose/"),
    head: find("head/"),
    face: find("face/"),
    accessory: find("accessories/") ?? find("facial-hair/")
  };
}

const records = SPEC.map((entry) => {
  const buf = readFileSync(join(assetDir, entry.file));
  const raw = buf.toString("utf8");
  const { markup, width, height } = compact(raw, entry.key);
  return Object.freeze({
    ...entry,
    sourceFile: entry.file.replace(/\.svg$/, ""),
    width,
    height,
    rawBytes: buf.length,
    compactBytes: Buffer.byteLength(markup, "utf8"),
    sha256: createHash("sha256").update(buf).digest("hex"),
    markup,
    ...partIds(raw)
  });
});

const keys = records.map((r) => r.key);
const keyUnion = keys.map((k) => `"${k}"`).join(" | ");
// runtime 只留穩定 sourceId；完整官方來源 URL 放在 SOURCE.md／SCENE-ATTRIBUTION.md，
// 讓打包後的 JS 完全不含任何外部網域字串，也不可能被誤當成熱連結。
const assetLines = records.map((r) => {
  const sourceId = `official/${/(_peep-standing-[^"?]+)\.svg/.exec(r.url)?.[1]?.slice(1) ?? r.key}`;
  return `  Object.freeze({ key: "${r.key}", sex: "${r.sex}", source: "${r.file}", sourceId: "${sourceId}", ` +
    `viewBox: "${r.width} ${r.height}", groups: Object.freeze(${JSON.stringify(r.groups)}), ` +
    `pose: ${JSON.stringify(r.pose)}, head: ${JSON.stringify(r.head)}, face: ${JSON.stringify(r.face)}, ` +
    `accessory: ${JSON.stringify(r.accessory)}, rawBytes: ${r.rawBytes}, compactBytes: ${r.compactBytes}, ` +
    `sha256: "${r.sha256}" })`;
}).join(",\n");
const rawLines = records.map((r) => `  "${r.key}": ${JSON.stringify(r.markup)}`).join(",\n");

const ts = `/**
 * GPT-WORKBUDDY-0062-B｜Open Peeps 完整全身人物最小核心（**自動產生，勿手改**）。
 *
 * 來源：Open Peeps by Pablo Stanley（CC0 1.0 public domain）。
 * 取得日期：${RETRIEVED}。8 個官方 "Grab and go / Standing" 全身 SVG，
 * 原檔、來源 URL、SHA-256 與 CC0 證據見 assets/generated/open-peeps/SOURCE.md。
 * 沒有搬入 PeepStudio 的 153 模板／516 atoms／Next.js／Supabase／Konva／帳號功能。
 *
 * 只由 p3e-scene.ts 使用；該模組經 p3e-game-layer.ts 延遲載入，
 * 不會進入出生卡關鍵路徑。執行期沒有任何外部網域請求。
 *
 * 重新產生：node scripts/p3e-0062b-vendor-peeps.mjs
 */

/** 官方素材對照（供矩陣測試與 attribution 稽核）。 */
export const OPEN_PEEPS_ASSETS = Object.freeze([
${assetLines}
] as const);

export type OpenPeepsKey = ${keyUnion};
export type OpenPeepsSex = "male" | "female";

/** 每個性別都有 4 個衣著／姿勢不同的完整角色，不把性別綁死在單一服裝。 */
export const OPEN_PEEPS_BY_SEX: Readonly<Record<OpenPeepsSex, readonly OpenPeepsKey[]>> = Object.freeze({
  male: Object.freeze(["male-a", "male-b", "male-c", "male-d"] as const),
  female: Object.freeze(["female-a", "female-b", "female-c", "female-d"] as const)
});

/** 官方 SVG 內層（去外殼、數字精度 2 位、黑白填色改成色彩佔位符）。 */
const RAW_PEEPS: Readonly<Record<OpenPeepsKey, string>> = Object.freeze({
${rawLines}
});

export interface OpenPeepsColors {
  readonly ink: string;
  readonly clothes: string;
  readonly hair: string;
  readonly skin: string;
}

export type OpenPeepsAsset = (typeof OPEN_PEEPS_ASSETS)[number];

export function openPeepsAsset(key: OpenPeepsKey): OpenPeepsAsset {
  return OPEN_PEEPS_ASSETS.find((entry) => entry.key === key) as OpenPeepsAsset;
}

/** 注入穩定色彩後回傳完整官方全身 SVG 的內層；沒有重畫任何筆觸。 */
export function openPeepsMarkup(key: OpenPeepsKey, colors: OpenPeepsColors): string {
  return RAW_PEEPS[key].replace(/\\{\\{(ink|clothes|hair|skin)\\}\\}/g, (_match, slot: string) =>
    colors[slot as keyof OpenPeepsColors] ?? "#4a3b32"
  );
}
`;
writeFileSync(outTs, ts, "utf8");

const totalRaw = records.reduce((sum, r) => sum + r.rawBytes, 0);
const totalCompact = records.reduce((sum, r) => sum + r.compactBytes, 0);
const tsBytes = statSync(outTs).size;
const gzipOf = (text) => gzipSync(Buffer.from(text, "utf8"), { level: 9 }).length;
const totalRawGzip = records.reduce((sum, r) => sum + gzipOf(readFileSync(join(assetDir, r.file), "utf8")), 0);
const totalCompactGzip = records.reduce((sum, r) => sum + gzipOf(r.markup), 0);

let source = `# Open Peeps CC0 素材來源與證據｜GPT-WORKBUDDY-0062-B\n\n`;
source += `- 取得日期：**${RETRIEVED}**（UTC+8）。\n`;
source += `- 官方站：${OFFICIAL}；作者：Pablo Stanley。\n`;
source += `- 素材取自官方站「Grab and go! / Standing」的 ready-to-download 全身 SVG，\n`;
source += `  由官方 Webflow CDN 下載後**原樣保存**；本站執行期只用 build 後的本機向量，不熱連結外部網域。\n`;
source += `- 授權：**CC0 1.0 Universal（public domain dedication）**。官方站原文：\n\n`;
source += `  > "Free for commercial and personal use under CC0 License."\n>\n`;
source += `  > "The library is in the public domain under the CC0 License. This means you can copy, modify, distribute, remix, burn, and use the work, even for commercial purposes, without asking permission."\n\n`;
source += `- 法律全文：\`CC0-1.0-legalcode.txt\`（取自 ${LEGALCODE}）。\n`;
source += `- 取得當時官網 HTML 快照 SHA-256：\`${HOME_SHA}\`（83,921 bytes，存於本機建置快取，不隨網站發布）。\n`;
source += `- 組合器參考：${PEEPSTUDIO}（commit \`${PEEPSTUDIO_SHA}\`）。\n`;
source += `  **本輪沒有從該 repo 搬任何 SVG、模板、Next.js、Supabase、Konva 或帳號功能**，\n`;
source += `  只參考其「Open Peeps 全身角色」概念；其 153 模板／516 atoms 亦未隨本站打包。\n\n`;
source += `## 實際使用的 8 個官方全身 SVG（curated 最小集合）\n\n`;
source += `| 本機 key | 性別分組 | 上游部件 id | 本機檔名 | 官方來源 URL | bytes | SHA-256 |\n`;
source += `| --- | --- | --- | --- | --- | --- | --- |\n`;
for (const r of records) {
  source += `| \`${r.key}\` | ${r.sex} | \`${r.pose}\` / \`${r.head}\` | \`${r.file}\` | ${r.url} | ${r.rawBytes.toLocaleString("en-US")} | \`${r.sha256}\` |\n`;
}
source += `\n## 使用範圍與大小\n\n`;
source += `- 玩家與伴侶**都**使用這 8 個完整全身 Open Peeps 成品；不再混用 Humation 頭部或自畫身體。\n`;
source += `- 城市／農村背景、狗／貓、眼鏡／手杖／背包等年齡配件為本專案原創輕量向量，沿用同一描邊配色。\n`;
source += `- 建置腳本 \`scripts/p3e-0062b-vendor-peeps.mjs\` 只讀本機這 8 個 SVG，產出 \`packages/ui/src/p3e-open-peeps.ts\`。\n`;
source += `  壓縮只做去註解／去中繼標籤／降數字精度／把黑白填色換成色彩佔位符，**不改繪圖筆觸**。\n`;
source += `- 原始合計 ${totalRaw.toLocaleString("en-US")} bytes（gzip ${totalRawGzip.toLocaleString("en-US")}）；\n`;
source += `  精簡後 ${totalCompact.toLocaleString("en-US")} bytes（gzip ${totalCompactGzip.toLocaleString("en-US")}）；\n`;
source += `  產生的 TS 模組 ${tsBytes.toLocaleString("en-US")} bytes。\n`;
source += `- 產出的常數只在 \`p3e-scene.ts\` 使用，並由 \`p3e-game-layer.ts\` 延遲載入，不在出生卡關鍵路徑。\n`;
/* 0063-B 的衍生人物段落：重跑本腳本不會把它洗掉（幂等）。 */
const derivedDoc = join(assetDir, "derived", "DERIVED-SOURCE.md");
const DERIVED_HEADING = "## GPT-WORKBUDDY-0063-B｜本專案衍生年齡專用人物";
if (existsSync(derivedDoc) && !source.includes(DERIVED_HEADING)) {
  source += `\n${DERIVED_HEADING}（**非官方原件**）\n\n` +
    `官方 Open Peeps 集合沒有嬰兒／幼童／學生全身角色；0063-B 另以 CC0 允許的\n` +
    `modify / remix 方式建立 **20 個本專案衍生** SVG，供 0–22 歲使用。\n` +
    `完整清單、逐檔 SHA-256、授權依據與「非刻板衣著」說明見\n` +
    `\`derived/DERIVED-SOURCE.md\`；官方 8 個成人成品仍是上表，不混為一談。\n`;
}
writeFileSync(outSource, source, "utf8");

writeFileSync(outReport, JSON.stringify({
  retrieved: RETRIEVED,
  official: OFFICIAL,
  license: "CC0-1.0",
  officialPageSha256: HOME_SHA,
  peepstudio: { url: PEEPSTUDIO, commit: PEEPSTUDIO_SHA, assetsVendored: 0 },
  assets: records.map(({ markup, ...r }) => ({ ...r, rawGzip: gzipOf(readFileSync(join(assetDir, r.file), "utf8")), compactGzip: gzipOf(markup) })),
  totals: { rawBytes: totalRaw, rawGzip: totalRawGzip, compactBytes: totalCompact, compactGzip: totalCompactGzip, tsBytes }
}, null, 2) + "\n", "utf8");

console.log(`P3E-0062B-VENDOR OK assets=${records.length} raw=${totalRaw}B rawGzip=${totalRawGzip}B compact=${totalCompact}B compactGzip=${totalCompactGzip}B ts=${tsBytes}B`);
for (const r of records) console.log(`  ${r.key}: ${r.rawBytes}B -> ${r.compactBytes}B ${r.pose} / ${r.head}`);
