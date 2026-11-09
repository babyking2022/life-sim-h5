/**
 * GPT-WORKBUDDY-0058-B｜任務二第 7 項：Vite build 後的**關鍵路徑**檢查。
 *
 * 以 `.artifacts/p1c-dist/index.html` 為根，沿著靜態 import 建立「出生卡
 * 關鍵路徑」的 chunk 閉包（bootstrap 必經的 `p3e-real-main` 也算），確認：
 *   1. 關鍵路徑 chunk 沒有任何 mortality JSON／birds mp3 的**資產 URL**；
 *   2. 這些資產 URL 只出現在延遲 chunk（heavy-packs / game-layer）；
 *   3. dist 裡 mortality JSON 與 mp3 檔案都存在且非空（進遊戲後能取得）；
 *   4. HTML 內含不需任何 fetch 的靜態啟動骨架。
 *
 * 注意：application 的驗證程式碼本來就有 `mortality` 這個 dataset **欄位名**，
 * 因此這裡刻意只檢查 hashed 資產檔名，不把欄位名誤判成資產引用。
 */
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, ".artifacts/p1c-dist");
const assetsDir = join(dist, "assets");
const reportPath = join(root, ".artifacts", "p3e-0058b-critical-path.json");

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const html = await readFile(join(dist, "index.html"), "utf8");
const files = (await readdir(assetsDir)).filter((name) => name.endsWith(".js"));
const byName = new Map(files.map((name) => [name, ""]));
for (const name of files) byName.set(name, await readFile(join(assetsDir, name), "utf8"));

/** 只抽出靜態 import／from 的 JS 依賴；`import("...")` 動態載入不算。 */
function staticDeps(source) {
  const deps = new Set();
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.\/[^"']+\.js)["']/g)) {
    deps.add(basename(match[1]));
  }
  return [...deps];
}

const entry = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => basename(m[1]));
check("index_html_has_single_entry_script", entry.length === 1, entry.join(","));

// BFS：entry 的靜態閉包。0065-A 起 birth entry 已靜態併入 entry，
// 完整 game runtime（p3e-game-main-*）改成按「開始人生」後才動態載入；
// 這裡保留相容：若 Vite 仍拆出 p3e-birth-main-* 也一併算進關鍵路徑。
const critical = new Set();
const queue = [...entry];
const dynamicBirthChunks = files.filter((name) => name.startsWith("p3e-birth-main-"));
for (const name of dynamicBirthChunks) queue.push(name);
while (queue.length > 0) {
  const name = queue.shift();
  if (critical.has(name) || !byName.has(name)) continue;
  critical.add(name);
  for (const dep of staticDeps(byName.get(name) ?? "")) queue.push(dep);
}

const MORTALITY_ASSET = /mortality\.v1-[A-Za-z0-9_-]+\.json/;
const AUDIO_ASSET = /birds-[A-Za-z0-9_-]+\.mp3|\.mp3/;
const criticalText = [...critical].map((name) => byName.get(name) ?? "").join("\n");
const delayed = files.filter((name) => !critical.has(name));
const delayedText = delayed.map((name) => byName.get(name) ?? "").join("\n");

check(
  "birth_critical_path_has_no_mortality_asset_url",
  !MORTALITY_ASSET.test(criticalText),
  `critical=${[...critical].join(",")}`
);
check(
  "birth_critical_path_has_no_mp3_asset_url",
  !AUDIO_ASSET.test(criticalText),
  `criticalChunks=${critical.size}`
);
check(
  "heavy_assets_only_referenced_by_deferred_chunks",
  MORTALITY_ASSET.test(delayedText) && AUDIO_ASSET.test(delayedText),
  `deferred=${delayed.join(",")}`
);
check(
  "game_layer_and_heavy_packs_are_separate_chunks",
  delayed.some((n) => n.startsWith("p3e-game-layer-")) &&
    delayed.some((n) => n.startsWith("p3e-heavy-packs-")),
  `deferred=${delayed.join(",")}`
);
const gameChunks = files.filter((n) => n.startsWith("p3e-game-main-"));
check(
  "game_runtime_is_deferred_from_birth_critical_path",
  gameChunks.length > 0 && gameChunks.every((n) => !critical.has(n)),
  `gameChunks=${gameChunks.join(",")} critical=${[...critical].join(",")}`
);
check(
  "html_contains_static_boot_skeleton",
  html.includes("p3e-boot-skeleton") && html.includes("正在準備出生資料") &&
    html.includes('data-p3e-live="false"'),
  `skeleton=${html.includes("p3e-boot-skeleton")}`
);

const mortalityFiles = (await readdir(assetsDir)).filter((n) => /^mortality\.v1-.*\.json$/.test(n));
const audioFiles = (await readdir(assetsDir)).filter((n) => n.endsWith(".mp3"));
const mortalityStat = mortalityFiles[0] ? await stat(join(assetsDir, mortalityFiles[0])) : null;
const audioStat = audioFiles[0] ? await stat(join(assetsDir, audioFiles[0])) : null;
check(
  "mortality_and_mp3_assets_present_after_build",
  mortalityFiles.length === 1 && audioFiles.length === 1 &&
    (mortalityStat?.size ?? 0) > 1_000_000 && (audioStat?.size ?? 0) > 100_000,
  `mortality=${mortalityFiles[0] ?? "missing"}(${mortalityStat?.size ?? 0}B) ` +
    `mp3=${audioFiles[0] ?? "missing"}(${audioStat?.size ?? 0}B)`
);

const sizes = [...critical].map((name) => ({
  name,
  bytes: Buffer.byteLength(byName.get(name) ?? ""),
  gzip: gzipSync(Buffer.from(byName.get(name) ?? "")).length
}));
const totalBytes = sizes.reduce((n, item) => n + item.bytes, 0);
const totalGzip = sizes.reduce((n, item) => n + item.gzip, 0);
const delayedBytes = delayed.reduce((n, name) => n + Buffer.byteLength(byName.get(name) ?? ""), 0);
check(
  "birth_critical_js_smaller_than_pre_0058b_main_bundle",
  totalBytes < 373_988,
  `critical=${totalBytes}B (gzip ${totalGzip}B) vs baseline 373988B; deferred=${delayedBytes}B`
);

await writeFile(
  reportPath,
  JSON.stringify({
    ok: checks.every((item) => item.ok),
    checks,
    criticalChunks: [...critical],
    deferredChunks: delayed,
    sizes,
    totalBytes,
    totalGzip,
    delayedBytes,
    mortality: mortalityFiles[0] ?? null,
    mp3: audioFiles[0] ?? null
  }, null, 2),
  "utf8"
);

const failed = checks.filter((item) => !item.ok);
console.log(`\nP3E-0058B-CRITICAL-PATH ${failed.length === 0 ? "OK" : "FAIL"} checks=${checks.length} failed=${failed.length}`);
if (failed.length > 0) process.exitCode = 1;
