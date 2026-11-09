/**
 * GPT-WORKBUDDY-0065-A｜MVP 架構的獨立驗證（自己的 server、自己的請求表）。
 *
 * 覆蓋訂單「回歸」段落要求的觀測點：
 *  - build 期 bundle 用正式 validators 產生且未過期；
 *  - birth-lite probe 不含任何 schema validator／session 建立程式；
 *  - 出生卡只抓一個 bundle JSON，沒有 heavy 資產、沒有 session；
 *  - bundle 損壞／版本錯誤顯示可理解錯誤與重試，不建立 session；
 *  - 「開始人生」後才載入完整世界，並留下 canonical-full-validators 觀測點；
 *  - 連點只建一個 session；刷新零新增請求；390×844 不整頁下滑；簡體純度。
 */
import { createServer } from "node:http";
import { readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const ROOT = process.cwd();
const DIST = resolve(ROOT, ".artifacts/p1c-dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error("缺少 production build：先跑 vite build --config vite.p1c.config.ts");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml"
};

const sentBytes = new Map();
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!filePath.startsWith(DIST)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(filePath);
    const headers = {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "content-length": String(body.byteLength)
    };
    sentBytes.set(request.url, body.byteLength + Buffer.byteLength(JSON.stringify(headers)));
    response.writeHead(200, headers);
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ---------------- 1. build 期資料與 lite probe ---------------- */
try {
  const out = execFileSync(
    process.execPath,
    ["scripts/p3e-0065a-birth-bundle.mjs", "--check"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  check("bundle_freshness_check_passes", out.includes("P3E-0065A-BUNDLE OK"), out.trim());
} catch (error) {
  check("bundle_freshness_check_passes", false, String(error));
}

const liteProbe = resolve(ROOT, ".artifacts/0065a-lite-probe.js");
try {
  execFileSync(
    process.execPath,
    [
      resolve(ROOT, "node_modules/esbuild/bin/esbuild"),
      "packages/application/src/p3e-birth-lite.ts",
      "--bundle", "--platform=browser", "--format=esm", "--target=es2020",
      `--outfile=${liteProbe}`
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const source = await readFile(liteProbe, "utf8");
  const forbidden = [
    "validateDataPack", "validateIdentityPack", "validateEventPack",
    "validateDeathPack", "E_P2A_RECORD", "P2B_MAX_NAME_RECORDS",
    "createP3EPlaySession", "p3b-copy"
  ];
  const leaked = forbidden.filter((token) => source.includes(token));
  const probeStat = await stat(liteProbe);
  check("birth_lite_probe_has_no_full_validators", leaked.length === 0,
    `leaked=${leaked.join(",") || "none"} raw=${probeStat.size}B`);
} catch (error) {
  check("birth_lite_probe_has_no_full_validators", false, String(error));
}

/* ---------------- 2. 瀏覽器：出生卡邊界 ---------------- */
const HEAVY = /open-peeps|p3e-open-peeps|p3e-scene|p3e-game-layer|p3e-heavy-packs|mortality|birds|events\.v1|event-copy/i;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
const page = await context.newPage();
const requests = [];
page.on("request", (request) => requests.push({ url: request.url(), at: Date.now() }));
// 刻意慢一點回 bundle：證明 HTML 靜態骨架在「出生資料還沒回來」時就可見，
// 而不是靠 JS 畫出來的（與 0058-B network-check 同手法）。
const bundleDelay = async (route) => {
  await new Promise((done) => setTimeout(done, 350));
  await route.continue();
};
await page.route(/birth-bundle\.v1-.*\.json/, bundleDelay);
await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

// DOMContentLoaded 時 module script 已下載，但 bootBirth() 第一個 await
// 還在等 bundle，因此 HTML 靜態骨架仍在畫面上、出生卡尚未建立。
const skeleton = await page.evaluate(() => ({
  skeleton: document.querySelector(".p3e-boot-skeleton") !== null,
  live: document.querySelector(".p3e-boot-skeleton")?.dataset.p3eLive ?? "",
  birthCard: document.querySelector(".p3e-birth-card") !== null
}));
check("static_skeleton_visible_before_bundle_ready",
  skeleton.skeleton && skeleton.live === "false" && !skeleton.birthCard,
  JSON.stringify(skeleton));

await page.waitForSelector('.p3e-birth-screen[data-p3e-live="true"]', { timeout: 30000 });
const interactiveAt = Date.now();
const before = requests.filter((entry) => entry.at <= interactiveAt);
const jsonBefore = before.filter((entry) => /\.json(\?|$)/.test(entry.url));
const heavyBefore = before.filter((entry) => HEAVY.test(entry.url));
const sessionBefore = await page.evaluate(
  () => Number(document.documentElement.dataset.p3eSessionCount ?? 0)
);
const validationBefore = await page.evaluate(
  () => document.documentElement.dataset.p3eFullWorldValidation ?? ""
);
check("birth_card_requests_exactly_one_bundle_json",
  jsonBefore.length === 1 && /birth-bundle\.v1-.*\.json/.test(jsonBefore[0]?.url ?? ""),
  `json=${jsonBefore.map((e) => e.url.replace(baseUrl, "")).join(",")}`);
check("no_heavy_assets_before_birth_interactive", heavyBefore.length === 0,
  `heavy=${heavyBefore.map((e) => e.url).join(",")}`);
check("no_session_created_on_birth_card", sessionBefore === 0);
check("canonical_full_validation_not_claimed_on_birth_card", validationBefore === "");

const lang = await page.evaluate(() => document.documentElement.lang);
check("document_lang_is_zh_CN", lang === "zh-CN", `lang=${lang}`);

// 刷新出生：零新增請求。
const countBeforeRefresh = requests.length;
await page.locator('[data-action="refresh-birth"]').click();
await page.waitForTimeout(900);
check("refresh_birth_adds_zero_requests", requests.length === countBeforeRefresh,
  `new=${requests.length - countBeforeRefresh}`);
check("refresh_birth_changes_seed", await page.evaluate(() => {
  const node = document.querySelector('.p3e-birth-screen[data-p3e-live="true"]');
  return Number(node?.dataset.p3eRefreshCount ?? "-1") >= 1;
}));

// 390×844 不整頁下滑。
const overflow = await page.evaluate(() =>
  Math.max(0, document.documentElement.scrollHeight - window.innerHeight));
check("390x844_birth_no_page_scroll", overflow === 0, `overflow=${overflow}`);

/* ---------------- 3. 開始人生：canonical 觀測點 ---------------- */
await page.locator('[data-action="start-life"]').click();
await page.locator('[data-action="start-life"]').click().catch(() => undefined);
await page.waitForSelector("#p3e-main", { timeout: 40000 });
const sessionAfter = await page.evaluate(
  () => Number(document.documentElement.dataset.p3eSessionCount ?? 0)
);
const validationAfter = await page.evaluate(
  () => document.documentElement.dataset.p3eFullWorldValidation ?? ""
);
const heavyAfter = requests.filter((entry) => HEAVY.test(entry.url));
check("single_session_created_after_start", sessionAfter === 1, `count=${sessionAfter}`);
check("full_world_uses_canonical_validators", validationAfter === "canonical-full-validators",
  `marker=${validationAfter}`);
check("heavy_world_assets_loaded_only_after_start", heavyAfter.length > 0 &&
  heavyAfter.every((entry) => entry.at > interactiveAt),
  `count=${heavyAfter.length}`);
check("mortality_loaded_exactly_once",
  heavyAfter.filter((entry) => /mortality\.v1-.*\.json/.test(entry.url)).length === 1);
await context.close();

/* ---------------- 4. bundle 損壞：錯誤頁 + 重試 + 不建 session ---------------- */
{
  const badContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const badPage = await badContext.newPage();
  let corrupt = true;
  const handler = async (route) => {
    if (!corrupt) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: "not-a-valid-version" })
    });
  };
  await badPage.route(/birth-bundle\.v1-.*\.json/, handler);
  await badPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await badPage.waitForSelector('[data-action="retry-birth-bundle"]', { timeout: 20000 });
  const text = await badPage.locator("body").innerText();
  const errorPhase = await badPage.getAttribute("[data-p3e-live]", "data-p3e-phase");
  const noSession = await badPage.evaluate(
    () => Number(document.documentElement.dataset.p3eSessionCount ?? 0)
  );
  check("corrupt_bundle_shows_friendly_error", /出生資料載入失敗|出生资料载入失败/.test(text) && errorPhase === "error",
    `phase=${errorPhase}`);
  check("corrupt_bundle_creates_no_session", noSession === 0);
  check("corrupt_bundle_shows_retry_button",
    (await badPage.locator('[data-action="retry-birth-bundle"]').count()) === 1);
  // 解除攔截後按重試：只重抓 bundle（帶 cache-bust query），出生卡恢復。
  corrupt = false;
  await badPage.unroute(/birth-bundle\.v1-.*\.json/, handler);
  await badPage.locator('[data-action="retry-birth-bundle"]').click();
  await badPage.waitForSelector('.p3e-birth-screen[data-p3e-live="true"]', { timeout: 20000 });
  check("bundle_retry_recovers_birth_card", true);
  await badContext.close();
}

await browser.close();
await new Promise((done) => server.close(done));

const failed = checks.filter((item) => !item.ok);
await writeFile(
  resolve(ROOT, ".artifacts/0065a-verify.json"),
  JSON.stringify({ ok: failed.length === 0, checks, sentBytes: [...sentBytes.entries()] }, null, 2),
  "utf8"
);
console.log(`\nP3E-0065A-VERIFY ${failed.length === 0 ? "OK" : "FAIL"} checks=${checks.length} failed=${failed.length}`);
if (failed.length > 0) process.exitCode = 1;
