/**
 * GPT-WORKBUDDY-0058-B｜任務二驗收：Playwright **網路攔截**測試。
 *
 * 用 `vite build --config vite.p1c.config.ts` 的產物，證明：
 *  1. HTML 到達就顯示靜態骨架（把主 JS 延遲 350ms 觀察）；
 *  2. 出生卡在 mortality 完成前就出現，且慢速網路下早完整世界至少 1 秒；
 *  3. 出生卡前完全沒有 mp3 請求；
 *  4. 玩家提前按「開始人生」→「準備人生…」→ 完成後自動開局一次；
 *  5. 所有請求去重：連點／重繪不會重複下載 2.61MB mortality；
 *  6. 死亡資料失敗時出生卡仍可看、顯示人類可理解的重試按鈕，重試後自動開局；
 *  7. 進入遊戲後 mortality 與 mp3 都能正常取得，音檔維持 preload="none"。
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, ".artifacts/p1c-dist");
const reportPath = join(root, ".artifacts", "p3e-0058b-network-check.json");
const SEED = "p3e-166-playable-runtime-v4";
const QUERY = `?seed=${SEED}`;
const INTERNAL_KEY = /(?:E_P3E_|E_P3D_|p3[ab]\.|microUsd|\bdec\.|\bev\.|job:|career:)/;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif"
};

function staticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const target = resolve(dist, `.${requested}`);
      if (!target.startsWith(dist + sep)) throw new Error("outside dist");
      const body = await readFile(target);
      response.writeHead(200, {
        "content-type": mime[extname(target)] ?? "application/octet-stream",
        "cache-control": "no-store"
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });
}

function listen(server) {
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      done(`http://127.0.0.1:${address.port}`);
    });
  });
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const isMortality = (path) => /mortality\.v1-.*\.json/.test(path);
const isMp3 = (path) => path.endsWith(".mp3");

/** 為頁面裝上記錄器，回傳可查詢的請求清單。 */
function track(page) {
  const requests = [];
  const responses = [];
  page.on("request", (request) => {
    requests.push({ path: new URL(request.url()).pathname, at: Date.now(), ok: true });
  });
  page.on("response", (response) => {
    responses.push({ path: new URL(response.url()).pathname, status: response.status(), at: Date.now() });
  });
  return { requests, responses };
}

const count = (log, predicate, before = Infinity) =>
  log.filter((item) => predicate(item.path) && item.at <= before).length;

async function makeContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true
  });
  return context;
}

const server = staticServer();
const baseUrl = await listen(server);
const browser = await chromium.launch({ headless: true });

try {
  /* ================================================================ */
  /* A. 慢速 mortality：骨架 → 出生卡 → 準備人生… → 自動開局         */
  /* ================================================================ */
  {
    const context = await makeContext(browser);
    const page = await context.newPage();
    const log = track(page);
    await page.route(/p3e-real-main-.*\.js/, async (route) => {
      await new Promise((done) => setTimeout(done, 350));
      await route.continue();
    });
    await page.route(/mortality\.v1-.*\.json/, async (route) => {
      await new Promise((done) => setTimeout(done, 2500));
      await route.continue();
    });

    await page.goto(`${baseUrl}/${QUERY}`, { waitUntil: "domcontentloaded" });
    const skeleton = await page.evaluate(
      () => document.querySelector(".p3e-boot-skeleton") !== null &&
        document.querySelector(".p3e-boot-skeleton")?.textContent?.includes("正在準備出生資料")
    );
    check("static_skeleton_visible_before_main_js", skeleton === true);

    await page.waitForSelector(".p3e-birth-card", { timeout: 20000 });
    const birthAt = Date.now();
    const stageAtBirth = await page.getAttribute("[data-p3e-live='true']", "data-p3e-world-stage");
    const birthMp3 = count(log.requests, isMp3, birthAt);
    const mortalityResponsesAtBirth = count(log.responses, isMortality, birthAt);
    check("birth_card_visible_before_mortality_response", mortalityResponsesAtBirth === 0,
      `mortalityResponses=${mortalityResponsesAtBirth} stage=${stageAtBirth}`);
    check("birth_card_world_stage_is_loading", stageAtBirth === "loading", `stage=${stageAtBirth}`);
    check("no_mp3_request_before_birth_card", birthMp3 === 0, `mp3=${birthMp3}`);
    check("birth_card_has_no_internal_key", !INTERNAL_KEY.test((await page.locator("body").innerText()) ?? ""));

    // 玩家在世界還沒準備好時就按「開始人生」。
    await page.locator('[data-action="start-life"]').click();
    const preparing = await page.locator('[data-action="start-life"]').textContent();
    const preparingDisabled = await page.locator('[data-action="start-life"]').isDisabled();
    check("start_button_shows_preparing_life", (preparing ?? "").includes("準備人生") && preparingDisabled,
      `text=${preparing} disabled=${preparingDisabled}`);
    check("no_mp3_request_while_preparing", count(log.requests, isMp3) === 0,
      `mp3=${count(log.requests, isMp3)}`);

    await page.waitForSelector("#p3e-main", { timeout: 30000 });
    const gameAt = Date.now();
    const commandCount = await page.getAttribute("#p3e-main", "data-p3e-command-count");
    const preload = await page.getAttribute("#p3e-main", "data-p3e-audio-preload");
    const mortalityRequests = count(log.requests, isMortality);
    const mortalityOk = log.responses.some((item) => isMortality(item.path) && item.status === 200);
    check("birth_card_at_least_1s_earlier_than_world", gameAt - birthAt >= 1000,
      `deltaMs=${gameAt - birthAt}`);
    check("auto_started_once_after_world_ready", commandCount === "0", `commandCount=${commandCount}`);
    check("mortality_requested_exactly_once", mortalityRequests === 1, `requests=${mortalityRequests}`);
    check("mortality_asset_served_ok_after_game", mortalityOk, `ok=${mortalityOk}`);
    check("audio_preload_still_none", preload === "none", `preload=${preload}`);

    // 進入遊戲後音檔本身可以被正常取得（不論瀏覽器是否允許自動播放）。
    const mp3Path = log.requests.find((item) => isMp3(item.path))?.path ?? null;
    const mp3Status = mp3Path === null
      ? await page.evaluate(async () => {
          const list = performance.getEntriesByType("resource").map((entry) => entry.name);
          const hit = list.find((name) => name.endsWith(".mp3"));
          if (hit === undefined) return 0;
          return (await fetch(hit)).status;
        })
      : await page.evaluate(async (path) => (await fetch(path)).status, mp3Path);
    check("mp3_asset_fetchable_after_user_gesture", mp3Status === 200, `status=${mp3Status}`);
    check("no_mp3_request_before_start_click", birthMp3 === 0, `mp3=${birthMp3}`);
    await context.close();
  }

  /* ================================================================ */
  /* B. 連點／重繪去重：2.61MB mortality 只下載一次                    */
  /* ================================================================ */
  {
    const context = await makeContext(browser);
    const page = await context.newPage();
    const log = track(page);
    await page.goto(`${baseUrl}/${QUERY}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".p3e-birth-card", { timeout: 20000 });
    await page.evaluate(() => {
      const reroll = document.querySelector('[data-action="reroll-birth"]');
      for (let i = 0; i < 2; i += 1) reroll?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const start = document.querySelector('[data-action="start-life"]');
      for (let i = 0; i < 3; i += 1) start?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForSelector("#p3e-main", { timeout: 30000 });
    const mortalityRequests = count(log.requests, isMortality);
    const eventsRequests = count(log.requests, (path) => /events\.v1-.*\.json/.test(path));
    const copyRequests = count(log.requests, (path) => /event-copy.*\.json/.test(path));
    const commandCount = await page.getAttribute("#p3e-main", "data-p3e-command-count");
    check("rapid_clicks_do_not_redownload_mortality", mortalityRequests === 1, `requests=${mortalityRequests}`);
    check("rapid_clicks_do_not_redownload_events_or_copy", eventsRequests === 1 && copyRequests === 1,
      `events=${eventsRequests} copy=${copyRequests}`);
    check("rapid_clicks_create_only_one_session", commandCount === "0", `commandCount=${commandCount}`);
    await context.close();
  }

  /* ================================================================ */
  /* C. 死亡資料失敗：出生卡仍可看、人類可理解的重試後自動開局         */
  /* ================================================================ */
  {
    const context = await makeContext(browser);
    const page = await context.newPage();
    const log = track(page);
    let failedOnce = false;
    await page.route(/mortality\.v1-.*\.json/, async (route) => {
      if (!failedOnce) {
        failedOnce = true;
        // 故意慢一點失敗：確保「開始人生」是在 world 仍在準備時按下，
        // 失敗才會落在同一起 promise 上，而不是使用者已看到錯誤後又按一次。
        await new Promise((done) => setTimeout(done, 900));
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
        return;
      }
      await route.continue();
    });
    await page.goto(`${baseUrl}/${QUERY}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".p3e-birth-card", { timeout: 20000 });
    await page.locator('[data-action="start-life"]').click();
    await page.waitForSelector('[data-action="retry-world"]', { timeout: 20000 });
    const errorText = await page.locator(".p3e-world-status").textContent();
    const bodyText = await page.locator("body").innerText();
    const stage = await page.getAttribute("[data-p3e-live='true']", "data-p3e-world-stage");
    check("failure_keeps_birth_card_visible",
      (await page.locator(".p3e-birth-card").isVisible()) && stage === "error", `stage=${stage}`);
    check("failure_shows_human_readable_retry", (errorText ?? "").length > 0 && !INTERNAL_KEY.test(bodyText ?? ""),
      `message=${errorText}`);
    check("failure_shows_retry_button", (await page.locator('[data-action="retry-world"]').count()) >= 1);
    // 失敗狀態必須「黏住」等使用者明確重試：不能自己偷偷再抓一次 mortality 或開局。
    check("failure_does_not_auto_retry_or_start", count(log.requests, isMortality) === 1 &&
      (await page.locator("#p3e-main").count()) === 0,
      `mortality=${count(log.requests, isMortality)} game=${await page.locator("#p3e-main").count()}`);

    await page.locator('[data-action="retry-world"]').click();
    await page.waitForSelector("#p3e-main", { timeout: 30000 });
    const commandCount = await page.getAttribute("#p3e-main", "data-p3e-command-count");
    const mortalityRequests = count(log.requests, isMortality);
    const eventsRequests = count(log.requests, (path) => /events\.v1-.*\.json/.test(path));
    check("retry_refetches_only_failed_mortality", mortalityRequests === 2 && eventsRequests === 1,
      `mortality=${mortalityRequests} events=${eventsRequests}`);
    check("retry_auto_starts_once", commandCount === "0", `commandCount=${commandCount}`);
    await context.close();
  }

  /* ================================================================ */
  /* D. 390×844 不新增整頁垂直捲動                                    */
  /* ================================================================ */
  {
    const context = await makeContext(browser);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/${QUERY}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".p3e-birth-card", { timeout: 20000 });
    const overflow = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    );
    check("390x844_birth_no_page_scroll", overflow === 0, `overflow=${overflow}`);
    await page.locator('[data-action="start-life"]').click();
    await page.waitForSelector("#p3e-main", { timeout: 30000 });
    const gameOverflow = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    );
    check("390x844_game_no_page_scroll", gameOverflow === 0, `overflow=${gameOverflow}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

await writeFile(reportPath, JSON.stringify({ ok: checks.every((item) => item.ok), checks }, null, 2), "utf8");
const failed = checks.filter((item) => !item.ok);
console.log(`\nP3E-0058B-NETWORK ${failed.length === 0 ? "OK" : "FAIL"} checks=${checks.length} failed=${failed.length}`);
if (failed.length > 0) process.exitCode = 1;
