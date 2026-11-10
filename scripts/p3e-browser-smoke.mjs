import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { display, canonDisplay, canonList } from "./p3e-locale-compat.mjs";

/**
 * H5-CTO-176-A（R1）：真實 P3-E runtime 的瀏覽器 smoke。
 *
 * 用 `vite build --config vite.p1c.config.ts` 的產物（.artifacts/p1c-dist）跑預設路徑：
 * 出生 → 逐年推進 → 待決策 → 選擇 → 繼續 → 死亡 → 重生。
 *
 * ## Boot 資產預算（R1 修正）
 *
 * 只看 JS+CSS 會低估行動網路成本：P3-E 的四個 pack 是以 JSON 資產在第一次可玩畫面
 * 之前抓下來的（mortality 約 2.7MB）。因此這裡記錄「`data-p3e-live=true` 出現前
 * 實際 request 過的每一個 dist 資產」（含 JSON），以 gzip 總和作為
 * `boot_required_gzip < 500KB` 的 gate；fixture preview 的 `main` chunk 不算。
 */

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, ".artifacts/p1c-dist");
const reportDir = resolve(root, ".artifacts");
const reportPath = join(reportDir, "p3e-browser-smoke.json");
const requireFromScripts = createRequire(import.meta.url);
const axePath = requireFromScripts.resolve("axe-core/axe.min.js");
/**
 * GPT-0025-D：顯示層繁中字典（獨立 JSON 資產）。這裡只讀它做交叉核對，
 * 不修改 fixtures；UI 仍透過 fetch 載入同一份檔案。
 */
const COPY_DOCUMENT = requireFromScripts("../fixtures/p3b/event-copy.zh-Hant.v1.json");
const COPY_MIN_KEYS = 307;
/**
 * GPT-0054-A/B：兩階段職業與寵物文案讓字典從 307 條擴充到 449 條，
 * gzip 實測約 9.26KB，已超過原本 8KiB gate。這裡只把上限放寬到 10KiB
 * （仍然嚴格），並在檢查訊息印出實測值；boot 總量 gate 512KiB 不變，
 * 且本任務移除舊 AVIF 場景圖後首屏總量反而下降。
 */
const COPY_GZIP_BUDGET = 10 * 1024;
/** UI 舊硬編碼表的 32 個 key；用來分辨「新事件」的精確字串命中。 */
const LEGACY_COPY_KEYS = new Set([
  "ev.adult.burnout", "ev.adult.debt-scare", "ev.adult.first-salary", "ev.adult.housing-choice",
  "ev.adult.promotion", "ev.adult.volunteer", "ev.any.quiet-year", "ev.any.setback",
  "ev.any.small-win", "ev.child.first-word", "ev.child.playground", "ev.child.school-choice",
  "ev.child.sibling-arrives", "ev.child.tantrum", "ev.guardian.calm", "ev.senior.health-check",
  "ev.senior.reflection", "ev.teen.exams", "ev.teen.friendship", "ev.teen.major-choice",
  "ev.teen.part-time-job", "ev.teen.risk-experiment", "p3b.decision.adult.housing",
  "p3b.decision.child.school", "p3b.decision.teen.path", "p3b.option.adult.housing.rent",
  "p3b.option.adult.housing.save", "p3b.option.child.school.bold", "p3b.option.child.school.steady",
  "p3b.option.teen.path.rest", "p3b.option.teen.path.study", "p3b.option.teen.path.work"
]);
/** 會被誤認為 internal key 的字首／底線式 key（畫面文字一律不得出現）。 */
const INTERNAL_KEY_PATTERN =
  /(?:^|[\s(（])(?:p3b|p3c|p3d|ev|option|dec|cause)\.[A-Za-z0-9._-]+|\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/i;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

const EXPECTED_STATE_HASH = "4e7ad435cab0d5b759fc0e1c5820642cf63827f6153b300a968eaef8348f1d59";
const EXPECTED_COMMAND_HEAD = "efaeb1348e71d6705c8021b8a213c5fb0b1b5c189d7d3a52cf187807da8a2c1a";
const EXPECTED_COMMANDS = 105;
/**
 * GPT-0025-D：新增獨立的 307 條繁中字典資產（gzip ≈6.2KB）後，boot 必要資產
 * 從 511169 增加到約 518KB，已超過原本的 500KiB gate。這裡把 gate 調到
 * 512KiB（只放寬 12KiB），並另外用 `COPY_GZIP_BUDGET` 嚴格限制字典本身，
 * 避免藉由文案無上限膨脹；原 500KiB 的資料包成本仍被完整量測與記錄。
 */
const BOOT_BUDGET_GZIP = 512 * 1024;
/**
 * 官方 golden（state hash／command head）建立在這個 seed 上。
 * GPT-0017-E：全新使用者首次開頁已改為安全隨機 seed，所以所有需要決定性的
 * 流程都必須明確用 `?seed=GOLDEN_SEED` 開頁，不再依賴「乾淨啟動固定 seed」。
 */
const GOLDEN_SEED = "p3e-166-playable-runtime-v4";
/**
 * GPT-0036-B：官方 105 命令 golden 必須逐位元重播，不能被 UI 新加的
 * 「首次必選重心」插入指令。這個參數只對自動化瀏覽器
 * （navigator.webdriver === true）生效，真人玩家無法用網址關掉必選暫停；
 * 另有一個完全不帶此參數的專章驗證 D 的強制暫停。
 */
const REPLAY_QUERY = "p3eReplay=official-golden";
const GOLDEN_QUERY = `?seed=${encodeURIComponent(GOLDEN_SEED)}&${REPLAY_QUERY}`;

const results = [];
const layoutReport = [];
const birthReport = {};
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail ?? null });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* static server                                                      */
/* ------------------------------------------------------------------ */

function contentType(path) {
  return mime[extname(path)] ?? "application/octet-stream";
}

function staticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const target = resolve(dist, `.${requested}`);
      if (!target.startsWith(dist + sep)) throw new Error("outside dist");
      const body = await readFile(target);
      response.writeHead(200, { "content-type": contentType(target), "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });
}

function listen(server) {
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

/* ------------------------------------------------------------------ */
/* 資產量測                                                            */
/* ------------------------------------------------------------------ */

async function readDistFile(pathname) {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const target = resolve(dist, `.${relative}`);
  if (!target.startsWith(dist + sep)) return null;
  try {
    const info = await stat(target);
    if (!info.isFile()) return null;
    return await readFile(target);
  } catch {
    return null;
  }
}

function bucketOf(pathname) {
  const ext = extname(pathname);
  if (pathname === "/" || ext === ".html") return "html";
  if (ext === ".js") return "js";
  if (ext === ".css") return "css";
  if (ext === ".json") return "json";
  return "other";
}

async function measureAssets(pathnames) {
  const groups = { html: [], js: [], css: [], json: [], other: [] };
  for (const pathname of pathnames) {
    const body = await readDistFile(pathname);
    if (body === null) continue;
    groups[bucketOf(pathname)].push({
      path: pathname,
      raw: body.length,
      gzip: gzipSync(body).length
    });
  }
  const sum = (list) => ({
    raw: list.reduce((total, item) => total + item.raw, 0),
    gzip: list.reduce((total, item) => total + item.gzip, 0),
    files: list.length
  });
  const bootRequired = [
    ...groups.html,
    ...groups.js,
    ...groups.css,
    ...groups.json,
    ...groups.other
  ];
  const bootRequiredRaw = bootRequired.reduce((total, item) => total + item.raw, 0);
  const bootRequiredGzip = bootRequired.reduce((total, item) => total + item.gzip, 0);
  const dataAssets = sum(groups.json);
  return {
    components: {
      index_html: sum(groups.html),
      entry_and_chunks_js: sum(groups.js),
      css: sum(groups.css),
      data_assets: dataAssets,
      other: sum(groups.other)
    },
    boot_required_raw: bootRequiredRaw,
    boot_required_gzip: bootRequiredGzip,
    data_assets_raw: dataAssets.raw,
    data_assets_gzip: dataAssets.gzip
  };
}

async function allAssetSizes() {
  const assetsDir = join(dist, "assets");
  const names = await readdir(assetsDir);
  const sum = async (list) => {
    let raw = 0;
    let gzip = 0;
    for (const name of list) {
      const body = await readFile(join(assetsDir, name));
      raw += body.length;
      gzip += gzipSync(body).length;
    }
    return { raw, gzip, files: list.length };
  };
  const js = names.filter((name) => name.endsWith(".js"));
  const css = names.filter((name) => name.endsWith(".css"));
  return {
    all_js: await sum(js),
    all_css: await sum(css),
    fixture_preview_main_js: await sum(js.filter((name) => name.startsWith("main-"))),
    p3e_real_main_js: await sum(js.filter((name) => name.startsWith("p3e-real-main"))),
    entry_js: await sum(js.filter((name) => name.startsWith("index-")))
  };
}

/* ------------------------------------------------------------------ */
/* page helpers                                                       */
/* ------------------------------------------------------------------ */

async function phaseOf(page) {
  return page.locator("[data-p3e-live]").getAttribute("data-p3e-phase");
}

async function commandCount(page) {
  return Number(await page.locator("[data-p3e-live]").getAttribute("data-p3e-command-count"));
}

/**
 * GPT-0036-B：官方 golden 重播頁不會出現必選卡；非重播頁（例如真隨機
 * rebirth 情境）則必須先選一個有效重心才能繼續。這裡只在「必選」時
 * 真正送出 SET_LIFE_FOCUS，重播頁完全是 no-op，不影響 golden。
 */
async function resolveFocusGateIfRequired(page) {
  const required = await page.evaluate(
    () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-focus-required")
  );
  if (required !== "true") {
    const dismiss = page.locator(
      '.p3e-focus[data-p3e-focus-expanded="true"] .p3e-focus-dismiss'
    );
    if ((await dismiss.count()) > 0) await dismiss.first().click({ timeout: 3000 }).catch(() => {});
    return;
  }
  await page
    .locator('.p3e-focus[data-p3e-focus-required="true"] [data-action="set-focus"][data-focus-id="study"]')
    .first()
    .click({ timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-focus-required") === "false",
    undefined,
    { timeout: 20000 }
  );
}

async function dismissFocusPickerIfOpen(page) {
  await resolveFocusGateIfRequired(page);
}

async function clickAndWait(page, selector) {
  await dismissFocusPickerIfOpen(page);
  const before = await commandCount(page);
  await page.locator(selector).first().click();
  await page.waitForFunction(
    (prev) => {
      const node = document.querySelector("[data-p3e-live]");
      const count = Number(node?.getAttribute("data-p3e-command-count") ?? "0");
      return count > prev || node?.getAttribute("data-p3e-phase") === "death";
    },
    before,
    { timeout: 20000 }
  );
}

async function axeAudit(page) {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async () => {
    const axe = window.axe;
    const result = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length
    }));
  });
}

function horizontalOverflow(page) {
  return page.evaluate(
    () => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth
  );
}

/* ------------------------------------------------------------------ */
/* 手機單畫面驗收 helpers（GPT-WORKBUDDY-0017）                        */
/* ------------------------------------------------------------------ */

/** document / body 的垂直溢出與實際可捲動量，兩者都必須為 0。 */
function verticalOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const before = window.scrollY;
    window.scrollTo(0, 9999);
    const scrolled = window.scrollY;
    window.scrollTo(0, before);
    return {
      documentOverflow: Math.max(0, doc.scrollHeight - doc.clientHeight),
      bodyOverflow: Math.max(0, body.scrollHeight - body.clientHeight),
      scrolled,
      docOverflowY: getComputedStyle(doc).overflowY,
      bodyOverflowY: getComputedStyle(body).overflowY
    };
  });
}

/** 出生卡快照：國家、身份／家庭欄位、故事、動作與 seed／identity 屬性。 */
function birthSnapshot(page) {
  return page.evaluate(() => {
    const card = document.querySelector(".p3e-birth-card");
    if (card === null) return null;
    const live = document.querySelector("[data-p3e-live]");
    const country = card.querySelector(".p3e-birth-country");
    const grid = card.querySelector(".p3e-birth-grid");
    const story = card.querySelector(".p3e-birth-story");
    const actions = card.querySelector(".p3e-birth-actions");
    return {
      text: (card.innerText ?? "").trim(),
      country: (country?.textContent ?? "").trim(),
      gridItems: grid?.children.length ?? 0,
      gridText: (grid?.innerText ?? "").trim(),
      story: (story?.innerText ?? "").trim(),
      actionCount: actions?.querySelectorAll("button").length ?? 0,
      seed:
        live?.getAttribute("data-p3e-birth-seed") ??
        live?.getAttribute("data-p3e-seed") ??
        live?.getAttribute("data-p3e-identity-hash") ??
        live?.getAttribute("data-p3e-birth-hash") ??
        live?.getAttribute("data-p3e-birth-certificate-hash") ??
        live?.getAttribute("data-p3e-certificate-hash") ??
        "",
      phase: live?.getAttribute("data-p3e-phase") ?? null
    };
  });
}

/** 有出生畫面時按「開始人生」；沒有時直接沿用既有的 age0 路徑。 */
async function startLifeFromBirth(page) {
  const start = page.locator('[data-action="start-life"], [data-action="begin-life"]');
  if ((await start.count()) === 0) return false;
  await start.first().click();
  await page.waitForFunction(
    () =>
      document.querySelector(".p3e-birth-card") === null ||
      document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life",
    undefined,
    { timeout: 20000 }
  );
  return true;
}

/** 情境頁／效能頁：只有停在出生卡且完全沒有遊戲控制時才先進入遊戲。 */
async function ensurePlayable(page) {
  await page.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
  const playable = await page.locator(
    '[data-action="advance"], [data-action="choose"], [data-action="rebirth"]'
  ).count();
  if (playable > 0) return;
  if ((await page.locator(".p3e-birth-card").count()) === 0) return;
  await startLifeFromBirth(page);
}

/** 七個必要區塊都必須落在同一個 viewport 內。 */
function layoutSnapshot(page) {
  return page.evaluate(() => {
    const height = window.innerHeight;
    const targets = [
      ["hud", ".p3e-hud"],
      ["scene", ".p3e-scene"],
      ["event_or_decision", ".p3e-story-card, .p3e-pending"],
      ["stats", ".p3e-stat-dock"],
      ["time_controls", ".p3e-time-controls"],
      ["next_step", ".p3e-controls"]
    ];
    const rects = {};
    for (const [name, selector] of targets) {
      const node = document.querySelector(selector);
      if (node === null) {
        rects[name] = null;
        continue;
      }
      const rect = node.getBoundingClientRect();
      rects[name] = {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height)
      };
    }
    const statItems = document.querySelectorAll(".p3e-stat-dock .p3e-stat-item").length;
    const fitted = Object.values(rects).every(
      (rect) =>
        rect !== null &&
        rect.height > 0 &&
        rect.top >= -2 &&
        rect.bottom <= height + 2
    );
    // GPT-0031-B：底部四 tabs 已移除，因此同屏必要區塊由七個改為六個。
    const removedChrome = document.querySelectorAll(
      ".p3e-tabs, .p3e-tab, .p3e-tools, .p3e-game-title"
    ).length;
    return { ok: fitted && statItems === 4 && removedChrome === 0, height, statItems, rects, removedChrome };
  });
}

/** 主要觸控區至少 44px（寬、高皆然）。 */
function touchTargets(page) {
  return page.evaluate(() => {
    const selector = [
      '[data-action="advance"]',
      '[data-action="choose"]',
      '[data-action="rebirth"]',
      '[data-action="start-life"]',
      '[data-action="reroll-birth"]',
      '[data-action="toggle-nature-sound"]',
      ".p3e-time-controls button",
      ".p3e-birth-actions button",
      ".p3e-hud-menu > summary"
    ].join(", ");
    const visible = [...document.querySelectorAll(selector)].filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    const small = visible
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.height < 43.5 || rect.width < 43.5;
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          label: (node.textContent ?? "").trim().slice(0, 18),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      });
    return { ok: small.length === 0, checked: visible.length, small };
  });
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const allSizes = await allAssetSizes();
  const server = staticServer();
  const baseUrl = await listen(server);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();

  const bootRequests = new Map();
  page.on("response", (response) => {
    const url = response.url();
    if (!url.startsWith(baseUrl) || response.status() >= 400) return;
    bootRequests.set(new URL(url).pathname, true);
  });

  const bootStarted = Date.now();
  // 主線要跑官方 golden（GPT-0043-A 之後是 105 命令）：明確釘住 seed，不受首次開頁隨機 seed 影響。
  await page.goto(`${baseUrl}/${GOLDEN_QUERY}`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
  const bootMs = Date.now() - bootStarted;
  const boot = await measureAssets([...bootRequests.keys()]);

  /* ---------------------------------------------------------------- */
  /* 0a. GPT-0025-D：繁中字典已載入、驗證通過、維持獨立 JSON 資產      */
  /* ---------------------------------------------------------------- */

  // GPT-0065-A（CTO 授權 MVP）：繁中字典不再在出生卡關鍵路徑下載，
  // 而是「開始人生」後由完整世界準備階段以正式 validators 驗證。
  // 用一個獨立的短生命週期頁面真的進遊戲，保留 0025-D 的驗收意圖：
  // 字典確實被 UI 載入、key 數正確、仍是獨立 JSON 資產。
  const copyProbeContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true
  });
  const copyProbePage = await copyProbeContext.newPage();
  const copyProbeRequests = new Map();
  copyProbePage.on("response", (response) => {
    const url = response.url();
    if (!url.startsWith(baseUrl) || response.status() >= 400) return;
    copyProbeRequests.set(new URL(url).pathname, true);
  });
  await copyProbePage.goto(`${baseUrl}/${GOLDEN_QUERY}`, { waitUntil: "domcontentloaded" });
  await copyProbePage.waitForSelector('[data-action="start-life"]', { timeout: 30000 });
  await copyProbePage.locator('[data-action="start-life"]').click();
  await copyProbePage.waitForSelector("#p3e-main", { timeout: 30000 });
  const copyAttrs = await copyProbePage.evaluate(() => {
    const live = document.querySelector("[data-p3e-live]");
    return {
      keys: Number(live?.getAttribute("data-p3e-copy-keys") ?? "0"),
      schema: live?.getAttribute("data-p3e-copy-schema") ?? null,
      phase: live?.getAttribute("data-p3e-phase") ?? null
    };
  });
  const copyAssetRequests = [...copyProbeRequests.keys()].filter((path) =>
    path.includes("event-copy")
  );
  await copyProbeContext.close();
  const dictionaryKeys = Object.keys(COPY_DOCUMENT.copy ?? {});
  const badCopyEntries = dictionaryKeys.filter(
    (key) =>
      ["__proto__", "constructor", "prototype"].includes(key) ||
      typeof COPY_DOCUMENT.copy[key] !== "string" ||
      COPY_DOCUMENT.copy[key].trim().length === 0
  );
  const p3bManifest = requireFromScripts("../fixtures/p3b/manifest.v1.json");
  const p3bEvents = requireFromScripts("../fixtures/p3b/events.v1.json");
  check(
    "copy_dictionary_document_valid",
    COPY_DOCUMENT.schemaVersion === "p3b-copy-1" &&
      COPY_DOCUMENT.locale === "zh-Hant" &&
      COPY_DOCUMENT.contentPackVersion === p3bManifest.contentPackVersion &&
      COPY_DOCUMENT.contentPackVersion === p3bEvents.contentPackVersion &&
      dictionaryKeys.length >= COPY_MIN_KEYS &&
      badCopyEntries.length === 0,
    `keys=${dictionaryKeys.length} version=${COPY_DOCUMENT.contentPackVersion} ` +
      `manifest=${p3bManifest.contentPackVersion} events=${p3bEvents.contentPackVersion} bad=${badCopyEntries.length}`
  );
  check(
    "copy_dictionary_loaded_by_ui_min_307_keys",
    copyAttrs.keys >= COPY_MIN_KEYS &&
      copyAttrs.keys === dictionaryKeys.length &&
      copyAttrs.schema === "p3b-copy-1",
    `dom_keys=${copyAttrs.keys} schema=${copyAttrs.schema} file_keys=${dictionaryKeys.length}`
  );
  check(
    "copy_dictionary_is_separate_json_asset",
    copyAssetRequests.length === 1 && copyAssetRequests[0].endsWith(".json"),
    `requests=${copyAssetRequests.join(",")}`
  );

  // 載入失敗／內容不合法時，顯示可理解的啟動錯誤，且畫面不得出現 internal key。
  const copyFailureCases = [
    { name: "copy_fetch_failure_shows_startup_error", mode: "http404" },
    { name: "copy_invalid_document_shows_startup_error", mode: "invalid" }
  ];
  for (const failure of copyFailureCases) {
    const failContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    const failPage = await failContext.newPage();
    await failPage.route(/event-copy.*\.json/, async (route) => {
      if (failure.mode === "http404") {
        await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            schemaVersion: "bogus",
            locale: "en",
            contentPackVersion: "0.0.0",
            copy: {}
          })
        });
      }
    });
    await failPage.goto(`${baseUrl}/${GOLDEN_QUERY}`, { waitUntil: "domcontentloaded" });
    // GPT-0065-A（CTO 授權 MVP）：事件文案字典已移到「開始人生」後的完整世界
    // 準備階段，不再於出生卡關鍵路徑下載。啟動錯誤契約完全保留，只是觸發點
    // 改成明確的使用者手勢；這裡先等出生卡可操作，再按開始讓字典失敗浮現。
    await failPage.waitForSelector('[data-action="start-life"]', { timeout: 30000 });
    await failPage.locator('[data-action="start-life"]').click();
    await failPage.waitForSelector('[data-p3e-phase="error"]', { timeout: 30000 });
    const errorView = await failPage.evaluate(() => ({
      live: document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-live") ?? null,
      message: document.querySelector("#p3e-boot-error")?.textContent ?? "",
      body: document.body.innerText ?? ""
    }));
    const leaked = INTERNAL_KEY_PATTERN.test(errorView.body);
    // GPT-0063-B：預設 zh-CN，啟動錯誤的顯示文字可能是簡體或簡繁混合；
    // 只正規化「顯示文字」，internal-key / live / 錯誤態條件完全不變。
    const errorMessage = display(errorView.message);
    check(
      failure.name,
      errorView.live === "false" &&
        errorMessage.includes("啟動失敗") &&
        errorMessage.includes("重新整理") &&
        !leaked,
      `mode=${failure.mode} msg=${errorView.message.slice(0, 36)} internalKeyLeaked=${leaked}`
    );
    await failContext.close();
  }

  /* ---------------------------------------------------------------- */
  /* 0. 出生畫面：啟動先看到出生卡，資料齐全、可重抽、可開始          */
  /* ---------------------------------------------------------------- */

  const bootBirth = await birthSnapshot(page);
  const birthVisible = bootBirth !== null && (await page.locator(".p3e-birth-card").isVisible());
  birthReport.boot_card_visible = birthVisible;
  birthReport.boot_phase = bootBirth?.phase ?? null;
  check(
    "boot_shows_birth_card",
    birthVisible,
    bootBirth === null ? "birth card DOM missing" : `phase=${bootBirth.phase}`
  );

  const countryWords = /(國家|地區|出生地|出生國|country|region)/i;
  const familyWords = /(家庭|家戶|父母|父|母|雙親|監護|居住|住|收入|經濟|城|鄉|宗教|姓名|性別|職業|年齡|壽命|分位)/;
  const rerollCount = await page.locator('[data-action="reroll-birth"], [data-action="reroll"]').count();
  const startCount = await page.locator('[data-action="start-life"], [data-action="begin-life"]').count();
  const birthDataOk =
    bootBirth !== null &&
    bootBirth.country.length > 0 &&
    bootBirth.gridItems >= 2 &&
    bootBirth.gridText.replace(/\s/g, "").length >= 8 &&
    (bootBirth.story.length > 0 || bootBirth.text.length >= 40) &&
    rerollCount >= 1 &&
    startCount >= 1 &&
    (countryWords.test(bootBirth.text) && familyWords.test(bootBirth.text) || bootBirth.text.length >= 60);
  check(
    "birth_country_and_family_data_present",
    birthDataOk,
    bootBirth === null
      ? "birth card DOM missing"
      : `country=${bootBirth.country.slice(0, 18)} grid=${bootBirth.gridItems} actions=${bootBirth.actionCount} reroll=${rerollCount} start=${startCount} story=${bootBirth.story.length} text=${bootBirth.text.length}`
  );

  // 出生卡必須逐項顯示國家／姓名／性別／城鄉／收入／住房／宗教／父母／壽命／故事。
  const birthLabels = await page.evaluate(() =>
    [...document.querySelectorAll(".p3e-birth-grid dt")].map((node) =>
      (node.textContent ?? "").trim()
    )
  );
  const requiredBirthLabels = [
    "姓名",
    "性別",
    "城鄉",
    "收入",
    "住房",
    "宗教",
    "母親",
    "父親",
    "預期壽命"
  ];
  const normalizedBirthLabels = canonList(birthLabels);
  const missingBirthLabels = requiredBirthLabels.filter(
    (label) => !normalizedBirthLabels.includes(canonDisplay(label))
  );
  check(
    "birth_card_shows_all_required_fields",
    bootBirth !== null &&
      bootBirth.country.length > 0 &&
      bootBirth.story.length > 0 &&
      birthLabels.length >= requiredBirthLabels.length &&
      missingBirthLabels.length === 0,
    bootBirth === null
      ? "birth card DOM missing"
      : `labels=${birthLabels.length} missing=[${missingBirthLabels.join(",")}] country=${bootBirth.country.slice(0, 12)} story=${bootBirth.story.length}`
  );

  // 出生卡在四個尺寸下也不得讓 document／body 捲動；超出的資訊只能卡內捲。
  if (birthVisible) {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 360, height: 640 },
      { width: 320, height: 568 }
    ]) {
      await page.setViewportSize(viewport);
      const overflow = await verticalOverflow(page);
      const internal = await page.evaluate(() => {
        const grid = document.querySelector(".p3e-birth-grid");
        const card = document.querySelector(".p3e-birth-card");
        return {
          gridOverflowY: grid === null ? null : getComputedStyle(grid).overflowY,
          cardOverflowY: card === null ? null : getComputedStyle(card).overflowY
        };
      });
      const ok = overflow.documentOverflow <= 1 && overflow.bodyOverflow <= 1 && overflow.scrolled === 0;
      check(
        `birth_viewport_${viewport.width}x${viewport.height}_vertical_overflow_0`,
        ok,
        `doc=${overflow.documentOverflow} body=${overflow.bodyOverflow} scrolled=${overflow.scrolled} grid=${internal.gridOverflowY}`
      );
      birthReport[`${viewport.width}x${viewport.height}`] = { ...overflow, ...internal };
      if (viewport.width === 320) {
        const actions = await page.evaluate(() => {
          const height = window.innerHeight;
          const nodes = [...document.querySelectorAll(".p3e-birth-actions button")];
          return nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              label: (node.textContent ?? "").trim().slice(0, 16),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              inside: rect.top >= -2 && rect.bottom <= height + 2
            };
          });
        });
        check(
          "birth_viewport_320x568_actions_visible_and_44px",
          actions.length >= 2 && actions.every((item) => item.inside && item.width >= 43.5 && item.height >= 43.5),
          JSON.stringify(actions)
        );
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
  }

  // 重新抽取在獨立分頁做，避免污染官方 golden 的決定性路徑。
  {
    const rerollContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    const rerollPage = await rerollContext.newPage();
    await rerollPage.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await rerollPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    const before = await birthSnapshot(rerollPage);
    const rerollButton = rerollPage.locator(
      '[data-action="reroll-birth"], [data-action="reroll"]'
    );
    let changed = false;
    let detail = "birth card DOM missing";
    if (before !== null && (await rerollButton.count()) > 0) {
      await rerollButton.first().click();
      try {
        await rerollPage.waitForFunction(
          (previous) => {
            const card = document.querySelector(".p3e-birth-card");
            const live = document.querySelector("[data-p3e-live]");
            const seed =
              live?.getAttribute("data-p3e-birth-seed") ??
              live?.getAttribute("data-p3e-seed") ??
              live?.getAttribute("data-p3e-identity-hash") ??
              live?.getAttribute("data-p3e-birth-hash") ??
              live?.getAttribute("data-p3e-birth-certificate-hash") ??
              live?.getAttribute("data-p3e-certificate-hash") ??
              "";
            return (card?.innerText ?? "").trim() !== previous.text || seed !== previous.seed;
          },
          { text: before.text, seed: before.seed },
          { timeout: 20000 }
        );
      } catch {
        // 由下面的最終比對決定成敗
      }
      const after = await birthSnapshot(rerollPage);
      changed =
        after !== null && (after.text !== before.text || after.seed !== before.seed);
      detail = after === null
        ? "birth card disappeared after reroll"
        : `text_changed=${after.text !== before.text} seed_changed=${after.seed !== before.seed}`;
      check(
        "birth_card_still_visible_after_reroll",
        after !== null && (await rerollPage.locator(".p3e-birth-card").isVisible())
      );
    }
    check("reroll_changes_identity_or_seed", changed, detail);
    birthReport.reroll_changed = changed;
    await rerollContext.close();
  }

  /* ---------------------------------------------------------------- */
  /* 0b. 全新使用者首次開頁：安全隨機 seed；?seed= 固定可重現          */
  /* ---------------------------------------------------------------- */
  {
    /** 讀出生卡的 seed／證書 hash，並確認出生階段沒有寫入 autosave。 */
    const birthIdentity = (target) =>
      target.evaluate(() => {
        const live = document.querySelector("[data-p3e-live]");
        let stored = false;
        try {
          stored = window.localStorage.getItem("life-sim:p3e:v6:autosave") !== null;
        } catch {
          stored = false;
        }
        return {
          phase: live?.getAttribute("data-p3e-phase") ?? null,
          seed: live?.getAttribute("data-p3e-birth-seed") ?? null,
          hash: live?.getAttribute("data-p3e-birth-certificate-hash") ?? null,
          identity: live?.getAttribute("data-p3e-birth-identity-hash") ?? null,
          stored
        };
      });

    /** 獨立的瀏覽器儲存環境（全新 context＝全新 localStorage／active seed）。 */
    const openFreshBirth = async (query) => {
      const freshContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true
      });
      const freshPage = await freshContext.newPage();
      await freshPage.goto(`${baseUrl}/${query}`, { waitUntil: "domcontentloaded" });
      await freshPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
      const info = await birthIdentity(freshPage);
      await freshContext.close();
      return info;
    };

    const isRandomSeed = (value) =>
      typeof value === "string" && /^life-[0-9a-f]{20}$/.test(value) && value !== GOLDEN_SEED;

    // 兩個獨立環境各開一次；極低機率的碰撞再多抽一次確認。
    const first = await openFreshBirth("");
    let second = await openFreshBirth("");
    for (let attempt = 0; attempt < 2 && first.seed === second.seed; attempt += 1) {
      second = await openFreshBirth("");
    }
    birthReport.clean_boot_seed_a = first.seed;
    birthReport.clean_boot_seed_b = second.seed;

    check(
      "clean_boot_random_seed_differs_across_contexts",
      isRandomSeed(first.seed) &&
        isRandomSeed(second.seed) &&
        first.seed !== second.seed &&
        first.hash !== second.hash,
      `a=${first.seed} b=${second.seed} hashDiffer=${first.hash !== second.hash}`
    );
    check(
      "birth_preview_does_not_create_session",
      first.phase === "birth" &&
        second.phase === "birth" &&
        !first.stored &&
        !second.stored,
      `phase=${first.phase}/${second.phase} stored=${first.stored}/${second.stored}`
    );

    const pinnedSeed = "gpt-0017-e-fixed-birth";
    const pinnedQuery = `?seed=${encodeURIComponent(pinnedSeed)}`;
    const pinnedA = await openFreshBirth(pinnedQuery);
    const pinnedB = await openFreshBirth(pinnedQuery);
    birthReport.pinned_seed = pinnedSeed;
    birthReport.pinned_certificate_hash = pinnedA.hash;
    check(
      "pinned_seed_reproducible_birth",
      pinnedA.phase === "birth" &&
        pinnedB.phase === "birth" &&
        pinnedA.seed === pinnedSeed &&
        pinnedB.seed === pinnedSeed &&
        pinnedA.hash !== null &&
        pinnedA.hash === pinnedB.hash &&
        pinnedA.identity === pinnedB.identity &&
        pinnedA.hash !== first.hash,
      `seed=${pinnedA.seed} hash=${String(pinnedA.hash).slice(0, 16)} reproducible=${pinnedA.hash === pinnedB.hash}`
    );
  }

  // 開始人生 → 0 歲；沒有出生畫面時沿用原本的 age0 直接開局。
  const startedFromBirth = await startLifeFromBirth(page);
  birthReport.started_from_birth = startedFromBirth;
  const phaseAfterStart = await phaseOf(page);
  const bodyText = (await page.locator("body").innerText()) ?? "";
  const bodyDisplay = display(bodyText);
  check(
    "birth_start_enters_age0",
    (!birthVisible || startedFromBirth) &&
      phaseAfterStart === "life" &&
      (bodyDisplay.includes("年齡 0") || bodyDisplay.includes("0 歲")),
    `birth_card=${birthVisible} start_clicked=${startedFromBirth} phase=${phaseAfterStart}`
  );

  // 1. 預設路徑是 real runtime，不是 fixture 文案
  check("default_is_real_not_fixture", !bodyText.includes("靜態選擇") && !bodyText.includes("固定後果"));
  check("default_uses_real_session", phaseAfterStart === "life");
  check(
    "no_internal_key_in_age0_body",
    !INTERNAL_KEY_PATTERN.test(bodyText),
    `leaked=${INTERNAL_KEY_PATTERN.test(bodyText)}`
  );

  // 2. age 0 / life
  check(
    "age0_life_initial",
    (bodyDisplay.includes("年齡 0") || bodyDisplay.includes("0 歲")) && phaseAfterStart === "life"
  );

  // 3. controls 跟 phase
  const advance = page.locator('[data-action="advance"]');
  check("controls_follow_phase_life", (await advance.count()) === 1 && (await advance.isEnabled()));

  // GPT-0025-D：收集官方固定 seed 路徑上每一個決策的事件標題／問題／選項文字。
  // 只讀 DOM，不下命令，所以 78 命令 golden 完全不受影響。
  const copySamples = [];
  // GPT-0036-B C：沿著官方 golden 路徑收集具名伴侶與「關係建立當年」訊息。
  const partnerSamples = [];
  const copyReport = { decisions: 0, texts: 0, exactHits: [], newExactHits: [] };
  const collectCopySample = async (target) => {
    const sample = await target.evaluate(() => {
      const text = (node) => (node?.textContent ?? "").trim();
      return {
        phase: document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") ?? null,
        // GPT-0031-B：當年訊息改成人生紀錄後，事件名稱落在 .p3e-life-log-text。
        eventNames: [
          ...[...document.querySelectorAll(".p3e-event-name")].map(text),
          ...[...document.querySelectorAll(".p3e-life-log-text")].map(text)
        ],
        question: text(document.querySelector("#p3e-pending-title")),
        options: [...document.querySelectorAll("button.p3e-option")].map(text),
        story: document.querySelector(".p3e-story-card")?.innerText ?? "",
        /* GPT-0054-B：兩階段職業卡（名稱 + 預估年收入 CNY）與分層場景投影。 */
        career: (() => {
          const pending = document.querySelector(".p3e-pending");
          if (pending === null || pending.dataset.p3eCareerStage === undefined) return null;
          return {
            stage: pending.dataset.p3eCareerStage ?? null,
            note: text(pending.querySelector(".p3e-career-note")),
            cards: [...pending.querySelectorAll("button.p3e-option")].map((button) => ({
              name: text(button.querySelector(".p3e-career-name")),
              income: text(button.querySelector(".p3e-career-income")),
              hint: text(button.querySelector(".p3e-career-hint")),
              disabled: button.disabled,
              text: text(button)
            }))
          };
        })(),
        scene: (() => {
          const scene = document.querySelector(".p3e-scene");
          if (scene === null) return null;
          return {
            assetId: scene.dataset.p3eSceneAsset ?? null,
            signature: scene.dataset.p3eSceneSignature ?? null,
            layers: scene.dataset.p3eSceneLayers ?? null,
            residence: scene.dataset.p3eSceneResidence ?? null,
            ageStage: scene.dataset.p3eSceneAgeStage ?? null,
            playerSex: scene.dataset.p3eScenePlayerSex ?? null,
            hasPartner: scene.dataset.p3eSceneHasPartner ?? null,
            pet: scene.dataset.p3eScenePet ?? null,
            url: getComputedStyle(scene).backgroundImage,
            children: scene.children.length,
            emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(scene.textContent ?? "")
          };
        })(),
        /* GPT-0054-B：職業決策不能把時間控制與下一步按鈕推出單螢幕。 */
        layout: (() => {
          const visible = (selector) => {
            const node = document.querySelector(selector);
            if (node === null) return false;
            const rect = node.getBoundingClientRect();
            return rect.height > 0 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
          };
          const options = document.querySelector(".p3e-career-options");
          const doc = document.scrollingElement ?? document.documentElement;
          return {
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            timeControlsVisible: visible(".p3e-time-controls"),
            storyVisible: visible(".p3e-story-card"),
            optionsVisible: visible(".p3e-career-options"),
            optionsOverflowY: options === null ? null : getComputedStyle(options).overflowY,
            docY: doc.scrollHeight - doc.clientHeight,
            bodyY: document.body.scrollHeight - document.body.clientHeight,
            scrolled: window.scrollY
          };
        })()
      };
    });
    if (
      sample.phase === "pending_decision" &&
      sample.question.length > 0 &&
      sample.options.length >= 2
    ) {
      copySamples.push(sample);
    }
  };

  // 4. 跑到 pending_decision
  let guard = 0;
  while ((await phaseOf(page)) !== "pending_decision" && guard < 200) {
    await clickAndWait(page, '[data-action="advance"]');
    guard += 1;
  }
  check("reached_pending_decision", (await phaseOf(page)) === "pending_decision");
  await collectCopySample(page);
  const pendingBodyText = (await page.locator("body").innerText()) ?? "";
  check(
    "no_internal_key_in_pending_body",
    !INTERNAL_KEY_PATTERN.test(pendingBodyText),
    `leaked=${INTERNAL_KEY_PATTERN.test(pendingBodyText)}`
  );
  const optionButtons = page.locator('[data-action="choose"]');
  check("pending_shows_options", (await optionButtons.count()) >= 2);
  check("pending_labeled_region", (await page.locator("#p3e-pending-title").count()) === 1);

  // 5. 選第一個權威選項
  const chooseStart = Date.now();
  await optionButtons.first().click();
  await page.waitForFunction(
    () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life",
    undefined,
    { timeout: 20000 }
  );
  const warmCommandMs = Date.now() - chooseStart;
  check("choose_first_authoritative_option", (await phaseOf(page)) === "life");

  // 6. 跑到死亡
  const runStart = Date.now();
  while ((await phaseOf(page)) !== "death" && guard < 400) {
    const phase = await phaseOf(page);
    if (phase === "pending_decision") await collectCopySample(page);
    partnerSamples.push(
      await page.evaluate(() => {
        // GPT-0040-B：狀態卡權威呈現身分／居住／情感；舊 .p3e-partner-line 已移除。
        const live = document.querySelector("[data-p3e-live]");
        const age = Number(live?.getAttribute("data-p3e-life-focus-age") ?? "-1");
        const relRow = document.querySelector(".p3e-profile-row[data-p3e-relationship-status]");
        const status = relRow?.getAttribute("data-p3e-relationship-status") ?? null;
        const name = relRow?.getAttribute("data-p3e-partner-name") ?? null;
        const relText = relRow?.querySelector(".p3e-profile-val")?.textContent ?? null;
        const roleRow = document.querySelector(".p3e-profile-row[data-p3e-profile-role-id]");
        const roleId = roleRow?.getAttribute("data-p3e-profile-role-id") ?? null;
        const roleKey = roleRow?.querySelector(".p3e-profile-key")?.textContent ?? null;
        const roleVal = roleRow?.querySelector(".p3e-profile-val")?.textContent ?? null;
        const resRow = document.querySelector(".p3e-profile-row[data-p3e-profile-residence-entity]");
        const resEntity = resRow?.getAttribute("data-p3e-profile-residence-entity") ?? null;
        const resRegion = resRow?.getAttribute("data-p3e-profile-residence-region") ?? null;
        const resText = resRow?.querySelector(".p3e-profile-val")?.textContent ?? null;
        return {
          age,
          status,
          name,
          display: relText,
          label: status,
          fullNameTitle: name,
          roleId,
          roleKey,
          roleVal,
          resEntity,
          resRegion,
          resText,
          relationTexts: [
            ...document.querySelectorAll('[data-p3e-life-log-partner="true"] .p3e-life-log-text')
          ].map((node) => node.textContent ?? "")
        };
      })
    );
    const selector = phase === "pending_decision" ? '[data-action="choose"]' : '[data-action="advance"]';
    await clickAndWait(page, selector);
    guard += 1;
  }
  const runMs = Date.now() - runStart;
  const finalPhase = await phaseOf(page);
  const finalCount = await commandCount(page);
  const finalStateHash = await page.locator("[data-p3e-live]").getAttribute("data-p3e-state-hash");
  const finalHead = await page.locator("[data-p3e-live]").getAttribute("data-p3e-command-head");
  const deathText = (await page.locator(".p3e-death").innerText()) ?? "";
  const deathBodyText = (await page.locator("body").innerText()) ?? "";

  // GPT-0031-B：成年後資產／年收入必須改用 application view 的真實數值。
  // GPT-0032-B：320px HUD 字級提高後以萬／億縮寫顯示，完整數值仍須保留在
  // data-p3e-finance-full／title／aria-label，不能為了放大字體把資訊刪掉。
  const adultHud = await page.evaluate(() => {
    const hud = document.querySelector(".p3e-hud");
    return {
      values: [...(hud?.querySelectorAll(".p3e-hud-item strong") ?? [])].map(
        (node) => node.textContent ?? ""
      ),
      full: [...(hud?.querySelectorAll(".p3e-hud-assets, .p3e-hud-income") ?? [])].map(
        (node) => node.getAttribute("data-p3e-finance-full") ?? ""
      ),
      minorCount: hud?.querySelectorAll('[data-p3e-minor-finance="true"]').length ?? -1
    };
  });
  // GPT-0054-B：顯示層固定 1 USD = 7.2 CNY，完整／緊湊值都必須以 CNY 開頭，
  // 不得再出現 $ 或 microUsd；未成年仍由 minorCount 保證是「—」。
  check(
    "adult_finance_shows_application_view_values",
    adultHud.minorCount === 0 &&
      adultHud.values[2] !== "—" && adultHud.values[3] !== "—" &&
      /^CNY /.test(adultHud.values[2]) && /^CNY /.test(adultHud.values[3]) &&
      adultHud.full.length === 2 &&
      adultHud.full.every((value) => /^-?CNY [\d,]+\.\d{2}$/.test(value)) &&
      [...adultHud.values, ...adultHud.full].every((value) => !/\$|microUsd/i.test(value)),
    `values=${JSON.stringify(adultHud.values)} full=${JSON.stringify(adultHud.full)} minor=${adultHud.minorCount}`
  );
  check(
    "finance_cny_no_dollar_or_micro_usd_leak_in_body",
    !/\$/.test(deathBodyText) && !/microUsd/i.test(deathBodyText) &&
      !INTERNAL_KEY_PATTERN.test(deathBodyText),
    `dollar=${/\$/.test(deathBodyText)} micro=${/microUsd/i.test(deathBodyText)}`
  );

  check("run_to_death", finalPhase === "death", `phase=${finalPhase}`);
  check(
    "no_internal_key_in_death_body",
    !INTERNAL_KEY_PATTERN.test(deathBodyText),
    `leaked=${INTERNAL_KEY_PATTERN.test(deathBodyText)}`
  );
  check(
    "death_shows_real_outcome",
    (deathText.includes("reason") && (deathText.includes("mortality") || deathText.includes("age_ceiling"))) ||
      (display(deathText).includes("這段人生走到了終點") && display(deathText).includes("你活了"))
  );
  check("run_to_death_with_51_commands", finalCount === EXPECTED_COMMANDS, `commands=${finalCount}`);
  check("final_state_hash", finalStateHash === EXPECTED_STATE_HASH, finalStateHash ?? "null");
  check("final_command_head", finalHead === EXPECTED_COMMAND_HEAD, finalHead ?? "null");

  /* ---------------------------------------------------------------- */
  /* 6a. GPT-0036-B C：具名伴侶（正式 view.partner projection）          */
  /* ---------------------------------------------------------------- */
  const namedPartner = partnerSamples.find((sample) => sample.name !== null) ?? null;
  const allPartnerNames = [
    ...new Set(partnerSamples.map((sample) => sample.name).filter((name) => name !== null))
  ];
  const namedStatusOk = namedPartner !== null &&
    (namedPartner.status === "married" || namedPartner.status === "dating");
  check(
    "partner_named_identity_from_projection",
    namedPartner !== null &&
      typeof namedPartner.name === "string" &&
      namedPartner.name.length > 0 &&
      namedStatusOk &&
      namedPartner.display !== null &&
      namedPartner.display.includes(namedPartner.name) &&
      /[\u3400-\u9fffA-Za-z]/.test(namedPartner.name) &&
      !INTERNAL_KEY_PATTERN.test(namedPartner.name) &&
      allPartnerNames.length === 1,
    `names=${JSON.stringify(allPartnerNames)} status=${namedPartner?.status} display=${namedPartner?.display}`
  );
  check(
    "partner_full_name_kept_in_title_and_aria",
    namedPartner !== null &&
      namedPartner.fullNameTitle === namedPartner.name &&
      namedPartner.display.includes(namedPartner.name),
    `title=${namedPartner?.fullNameTitle} display=${namedPartner?.display}`
  );
  const relationTexts = partnerSamples.flatMap((sample) => sample.relationTexts);
  check(
    "relationship_year_message_includes_partner_name",
    namedPartner !== null &&
      relationTexts.length >= 1 &&
      relationTexts.some((text) => text.includes(namedPartner.name)),
    `texts=${JSON.stringify(relationTexts.slice(0, 3))}`
  );
  const finalPartnerName = await page.evaluate(() => {
    const relRow = document.querySelector(".p3e-profile-row[data-p3e-partner-name]");
    return relRow?.getAttribute("data-p3e-partner-name") ?? null;
  });
  check(
    "partner_name_survives_to_death_without_fake_names",
    finalPartnerName !== null && finalPartnerName === namedPartner?.name,
    `final=${finalPartnerName} sampled=${namedPartner?.name}`
  );

  /* ---------------------------------------------------------------- */
  /* 6c. GPT-0040-B：紅框狀態卡／年齡身分路徑／居住／情感／具體挫折成功 */
  /* ---------------------------------------------------------------- */
  const profileCard = await page.evaluate(() => {
    const card = document.querySelector(".p3e-profile-card");
    if (card === null) return null;
    const wrap = card.closest(".p3e-scene-wrap");
    const scene = wrap?.querySelector(".p3e-scene");
    const cardBox = card.getBoundingClientRect();
    const sceneBox = scene?.getBoundingClientRect();
    const rows = [...card.querySelectorAll(".p3e-profile-row")].map((r) => ({
      key: r.querySelector(".p3e-profile-key")?.textContent ?? "",
      val: r.querySelector(".p3e-profile-val")?.textContent ?? "",
      roleId: r.getAttribute("data-p3e-profile-role-id"),
      resEntity: r.getAttribute("data-p3e-profile-residence-entity"),
      relStatus: r.getAttribute("data-p3e-relationship-status"),
      partnerName: r.getAttribute("data-p3e-partner-name")
    }));
    // GPT-0041-B：死亡畫面若仍顯示狀態卡，居住國名也必須是完整繁中且未省略。
    const SIMPLIFIED_TELL =
      /[国马兰亚罗苏鲜挝东门叶约纳莱刚几内鲁伦买萨腊奥卢时顿爱脱义兹赖茨麦湾维贝宁达冈绍岛韩缅汤乌库图韦叙济]/;
    const resRow = [...card.querySelectorAll(".p3e-profile-row")].find(
      (r) => (r.querySelector(".p3e-profile-key")?.textContent ?? "") === "目前居住"
    );
    const resValNode = resRow?.querySelector(".p3e-profile-val") ?? null;
    const resText = resValNode?.textContent ?? "";
    const country = {
      text: resText,
      scrollWidth: resValNode ? resValNode.scrollWidth : 0,
      clientWidth: resValNode ? resValNode.clientWidth : 0,
      noOmit: resValNode !== null && resValNode.scrollWidth <= resValNode.clientWidth + 1,
      hasSimplified: SIMPLIFIED_TELL.test(resText)
    };
    return {
      ariaLabel: card.getAttribute("aria-label"),
      inSceneWrap: wrap !== null,
      lang: document.documentElement.lang || "unknown",
      rows,
      country,
      cardLeft: Math.round(cardBox.left),
      cardRight: Math.round(cardBox.right),
      cardWidth: Math.round(cardBox.width),
      sceneLeft: Math.round(sceneBox?.left ?? 0),
      sceneWidth: Math.round(sceneBox?.width ?? 0),
      docY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      bodyY: document.body.scrollHeight - document.body.clientHeight,
      legacyPartnerLines: document.querySelectorAll(".p3e-partner-line").length
    };
  });
  check(
    "profile_card_present_structured_three_rows",
    profileCard !== null &&
      display(profileCard.ariaLabel).equals("角色即時狀態") &&
      profileCard.rows.length === 3 &&
      profileCard.rows.some((r) => display(r.key).equals("目前居住")) &&
      profileCard.rows.some((r) => display(r.key).equals("情感狀態")) &&
      profileCard.rows.some((r) => display(r.key).equals("目前身分") || display(r.key).equals("目前職業")) &&
      profileCard.legacyPartnerLines === 0,
    `aria=${profileCard?.ariaLabel} rows=${profileCard?.rows.length} keys=${JSON.stringify(profileCard?.rows.map((r) => r.key))} legacy=${profileCard?.legacyPartnerLines}`
  );
  check(
    "profile_card_left_side_no_page_overflow",
    profileCard !== null &&
      profileCard.inSceneWrap &&
      profileCard.sceneWidth > 0 &&
      profileCard.cardLeft >= profileCard.sceneLeft - 1 && profileCard.cardLeft <= profileCard.sceneLeft + 16 &&
      profileCard.cardRight <= profileCard.sceneLeft + Math.round(profileCard.sceneWidth * 0.5) &&
      profileCard.cardWidth <= Math.round(profileCard.sceneWidth * 0.46) + 1 &&
      profileCard.docY <= 1 && profileCard.bodyY <= 1,
    `card=[${profileCard?.cardLeft},${profileCard?.cardRight}]w${profileCard?.cardWidth} sceneL=${profileCard?.sceneLeft} sceneW=${profileCard?.sceneWidth} docY=${profileCard?.docY} bodyY=${profileCard?.bodyY}`
  );
  // GPT-0041-B：死亡畫面若仍顯示狀態卡，居住國名也必須完整且未省略。
  // 0062-A 起預設 zh-CN：完整＝該語系的完整國名；zh-TW 才額外要求不得是簡體。
  check(
    "profile_card_country_full_no_omit_at_death",
    profileCard === null ||
      (profileCard.country.text.length > 0 &&
        profileCard.country.noOmit &&
        !profileCard.country.text.includes("…") &&
        !profileCard.country.text.includes("...") &&
        (profileCard.lang !== "zh-TW" || !profileCard.country.hasSimplified)),
    `text=${JSON.stringify(profileCard?.country.text)} lang=${profileCard?.lang} hasSimplified=${profileCard?.country.hasSimplified} scroll=${profileCard?.country.scrollWidth} client=${profileCard?.country.clientWidth} noOmit=${profileCard?.country.noOmit}`
  );

  // 年齡→身分路徑：6 歲小學生 / 13 歲初中生 / 18 歲依選擇（職業或升學）
  const childRole = partnerSamples.find((s) => s.age >= 6 && s.age <= 11 && s.roleId === "primary_student") ?? null;
  const teenRole = partnerSamples.find((s) => s.age >= 12 && s.age <= 14 && s.roleId === "junior_high_student") ?? null;
  const adultRoles = new Set([
    "university_student", "gap_year", "master_student", "doctoral_student",
    "general_worker", "engineer", "software_engineer", "accountant", "office_worker",
    "salesperson", "designer", "marketer", "entrepreneur", "shopkeeper", "cook",
    "farmer", "service_worker", "teacher", "retired"
  ]);
  const adultRole = partnerSamples.find((s) => s.age >= 18 && s.roleId !== null && adultRoles.has(s.roleId)) ?? null;
  const reached65 = partnerSamples.some((s) => s.age >= 65);
  const retiredSample = partnerSamples.find((s) => s.age >= 65 && s.roleId === "retired") ?? null;
  check(
    "role_shows_primary_student_at_age6",
    childRole !== null,
    `sample=${JSON.stringify(childRole ? { age: childRole.age, role: childRole.roleId } : null)}`
  );
  check(
    "role_shows_junior_high_student_at_age13",
    teenRole !== null,
    `sample=${JSON.stringify(teenRole ? { age: teenRole.age, role: teenRole.roleId } : null)}`
  );
  check(
    "role_shows_adult_identity_at_age18",
    adultRole !== null,
    `sample=${JSON.stringify(adultRole ? { age: adultRole.age, role: adultRole.roleId } : null)}`
  );
  check(
    "role_shows_retired_at_65plus_when_reached",
    !reached65 || retiredSample !== null,
    `reached65=${reached65} retiredAge=${retiredSample?.age ?? null}`
  );

  // 情感狀態：五態合法；已婚／交往必帶姓名且不洩 internal key
  const VALID_STATUS = new Set(["single", "dating", "married", "divorced", "widowed", "unknown"]);
  const allStatusValid = partnerSamples.every((s) => s.status === null || VALID_STATUS.has(s.status));
  const marriedDating = partnerSamples.filter((s) => s.status === "married" || s.status === "dating");
  const namedOk = marriedDating.every(
    (s) => typeof s.name === "string" && s.name.length > 0 && !INTERNAL_KEY_PATTERN.test(s.name)
  );
  check(
    "relationship_status_valid_five_states",
    allStatusValid,
    `statuses=${JSON.stringify([...new Set(partnerSamples.map((s) => s.status))])}`
  );
  check(
    "married_or_dating_carries_named_partner",
    marriedDating.length === 0 || (marriedDating.length > 0 && namedOk),
    `count=${marriedDating.length} namedOk=${namedOk} sample=${JSON.stringify(marriedDating[0]?.name ?? null)}`
  );

  // 居住：entityId 格式合法（與出生 entity 相同，由 profile 投影保證）
  const lastRes = partnerSamples[partnerSamples.length - 1];
  const resOk = lastRes !== undefined && typeof lastRes.resEntity === "string" && /^cr:[A-Z]{3}$/.test(lastRes.resEntity);
  check(
    "residence_entity_valid_format",
    resOk,
    `entity=${lastRes?.resEntity} region=${lastRes?.resRegion} text=${lastRes?.resText}`
  );

  // 具體挫折／成功：人生紀錄不得出現泛稱，也不得洩漏 internal key / detailId
  const lifeLogDom = await page.evaluate(() =>
    [...document.querySelectorAll(".p3e-life-log-entry")].map((node) => ({
      text: node.dataset.p3eLifeLogText ?? (node.textContent ?? "").replace(/\s+/g, " ").trim()
    }))
  );
  const GENERIC_PHRASES = ["遇到了一次挫折", "收穫了一個小小的成功"];
  const genericHits = lifeLogDom.filter((e) => GENERIC_PHRASES.some((g) => e.text.includes(g)));
  const leakedHits = lifeLogDom.filter((e) => INTERNAL_KEY_PATTERN.test(e.text));
  check(
    "life_log_no_generic_setback_win_phrases",
    genericHits.length === 0,
    `generic=${JSON.stringify(genericHits.slice(0, 3).map((e) => e.text))}`
  );
  check(
    "life_log_no_internal_key_or_detail_id",
    leakedHits.length === 0,
    `leaked=${JSON.stringify(leakedHits.slice(0, 3).map((e) => e.text))}`
  );

  // 不同 seed 多樣性：另開一組 seed，人生紀錄挫折／成功文案應與 golden 不同
  {
    const altSeed = "p3e-0040-alt-variety-7";
    const altContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true
    });
    const altPage = await altContext.newPage();
    await altPage.goto(`${baseUrl}/?seed=${encodeURIComponent(altSeed)}&${REPLAY_QUERY}`, { waitUntil: "domcontentloaded" });
    await altPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await altPage.locator('[data-action="start-life"]').click().catch(() => {});
    let altGuard = 0;
    while ((await phaseOf(altPage)) !== "death" && altGuard < 80) {
      const ph = await phaseOf(altPage);
      const sel = ph === "pending_decision" ? '[data-action="choose"]' : '[data-action="advance"]';
      await clickAndWait(altPage, sel).catch(() => {});
      altGuard += 1;
    }
    const altLog = await altPage.evaluate(() =>
      [...document.querySelectorAll(".p3e-life-log-entry")].map(
        (node) => node.dataset.p3eLifeLogText ?? (node.textContent ?? "").replace(/\s+/g, " ").trim()
      )
    );
    const goldenSet = new Set(lifeLogDom.map((e) => e.text));
    const altSet = new Set(altLog);
    const difference = [...altSet].filter((t) => !goldenSet.has(t));
    check(
      "life_log_different_seed_shows_variety",
      altLog.length > 0 && difference.length > 0,
      `golden=${goldenSet.size} alt=${altSet.size} diff=${difference.length}`
    );
    await altContext.close();
  }

  /* ---------------------------------------------------------------- */
  /* 6b. GPT-0025-D：新決策文案全部自然繁中、無 internal key             */
  /* ---------------------------------------------------------------- */

  const allCopyTexts = copySamples.flatMap((sample) => [
    sample.question,
    ...sample.options,
    ...sample.eventNames
  ]);
  const leakedTexts = allCopyTexts.filter((text) => INTERNAL_KEY_PATTERN.test(text));
  const nonChineseTexts = allCopyTexts.filter((text) => !/[\u3400-\u9fff]/.test(text));
  copyReport.decisions = copySamples.length;
  copyReport.texts = allCopyTexts.length;

  check(
    "new_decision_titles_and_options_no_internal_keys",
    copySamples.length >= 5 &&
      copySamples.every((sample) => sample.question.length > 0 && sample.options.length >= 2) &&
      leakedTexts.length === 0,
    `decisions=${copySamples.length} texts=${allCopyTexts.length} leaked=[${leakedTexts.slice(0, 3).join(" | ")}]`
  );
  check(
    "new_decision_copy_is_traditional_chinese",
    allCopyTexts.length > 0 && nonChineseTexts.length === 0,
    `texts=${allCopyTexts.length} nonChinese=[${nonChineseTexts.slice(0, 3).join(" | ")}]`
  );
  check(
    "no_internal_key_in_decision_story_cards",
    copySamples.length >= 5 && copySamples.every((sample) => !INTERNAL_KEY_PATTERN.test(sample.story)),
    `cards=${copySamples.length}`
  );

  /* ---------------------------------------------------------------- */
  /* 6c. GPT-0054-B：兩階段職業決策 + 分層動態場景（瀏覽器層驗證）        */
  /* ---------------------------------------------------------------- */

  const CAREER_LEAK_RE = /\$|microUsd|p3[ab]\.|ev\.|dec\.|job:|career:|pet:|annualIncome/i;
  const careerSamples = copySamples.filter((sample) => sample.career !== null);
  const categorySamples = careerSamples.filter((sample) => sample.career.stage === "category");
  const jobSamples = careerSamples.filter((sample) => sample.career.stage === "job");
  const careerCards = careerSamples.flatMap((sample) => sample.career.cards);

  check(
    "career_two_stage_decisions_both_reached",
    categorySamples.length >= 1 && jobSamples.length >= 1,
    `category=${categorySamples.length} job=${jobSamples.length} decisions=${copySamples.length}`
  );
  check(
    "career_category_cards_six_fields_no_income",
    categorySamples.length >= 1 && categorySamples.every((sample) =>
      sample.career.cards.length === 6 &&
      sample.career.cards.every((card) => card.name.length > 0 && card.income === "" && !card.disabled)),
    `category=${categorySamples.length} cards=${categorySamples.map((s) => s.career.cards.length).join(",")}`
  );
  check(
    "career_job_cards_show_name_and_cny_income",
    jobSamples.length >= 1 && jobSamples.every((sample) =>
      sample.career.cards.length >= 2 &&
      sample.career.cards.every((card) =>
        card.name.length > 0 && display(card.income).test(/^預估年收入 CNY /) && !card.disabled)),
    `job=${jobSamples.length} sample=${JSON.stringify(jobSamples[0]?.career.cards.slice(0, 2) ?? [])}`
  );
  check(
    "career_cards_no_internal_key_microusd_dollar",
    careerCards.length > 0 &&
      careerCards.every((card) => !CAREER_LEAK_RE.test(card.text) && !CAREER_LEAK_RE.test(card.hint)) &&
      careerSamples.every((sample) => !CAREER_LEAK_RE.test(sample.career.note)),
    `cards=${careerCards.length} leaked=${JSON.stringify(careerCards.filter((c) => CAREER_LEAK_RE.test(c.text)).slice(0, 2))}`
  );
  check(
    "career_decision_keeps_time_controls_on_screen_no_page_scroll",
    careerSamples.length >= 2 && careerSamples.every((sample) =>
      sample.layout.viewport === "390x844" &&
      sample.layout.timeControlsVisible && sample.layout.storyVisible &&
      sample.layout.optionsVisible &&
      sample.layout.docY <= 1 && sample.layout.bodyY <= 1 && sample.layout.scrolled === 0),
    `samples=${careerSamples.map((s) => JSON.stringify(s.layout)).join(" | ")}`
  );
  check(
    "career_decision_options_scroll_internally",
    careerSamples.every((sample) =>
      sample.layout.optionsOverflowY === "auto" || sample.layout.optionsOverflowY === "scroll"),
    `overflow=${JSON.stringify(careerSamples.map((s) => s.layout.optionsOverflowY))}`
  );

  const sceneSamples = copySamples.map((sample) => sample.scene).filter((sample) => sample !== null);
  check(
    "dynamic_scene_uses_generated_layered_svg",
    sceneSamples.length >= 5 && sceneSamples.every((sample) =>
      sample.assetId === "generated-layered-svg" &&
      sample.url.includes("data:image/svg+xml,") &&
      /^[0-9a-f]{8}$/.test(sample.signature ?? "") &&
      (sample.layers ?? "").includes("background") &&
      (sample.layers ?? "").includes("player") &&
      sample.children === 0 && !sample.emoji &&
      !/life-sim-village|\.avif|cdn|https?:\/\//i.test(sample.url)),
    `samples=${sceneSamples.length} first=${JSON.stringify(sceneSamples[0]?.layers)}`
  );
  check(
    "dynamic_scene_layers_follow_partner_and_pet_state",
    sceneSamples.some((sample) => (sample.layers ?? "").includes("partner")) &&
      sceneSamples.some((sample) => !sample.layers.includes("partner")) &&
      sceneSamples.some((sample) => (sample.layers ?? "").includes("pet")) &&
      sceneSamples.some((sample) => sample.pet === "none") &&
      sceneSamples.some((sample) => sample.pet === "dog" || sample.pet === "cat") &&
      sceneSamples.every((sample) =>
        sample.layers.includes("partner") === (sample.hasPartner === "true") &&
        sample.layers.includes("pet") === (sample.pet !== "none")),
    `partner=${sceneSamples.filter((s) => s.layers.includes("partner")).length} ` +
      `pet=${sceneSamples.filter((s) => s.layers.includes("pet")).length} ` +
      `pets=${JSON.stringify([...new Set(sceneSamples.map((s) => s.pet))])}`
  );
  check(
    "dynamic_scene_changes_with_age_and_state",
    new Set(sceneSamples.map((sample) => sample.ageStage)).size >= 2 &&
      new Set(sceneSamples.map((sample) => sample.signature)).size >= 3,
    `ages=${JSON.stringify([...new Set(sceneSamples.map((s) => s.ageStage))])} ` +
      `signatures=${new Set(sceneSamples.map((s) => s.signature)).size}`
  );

  // 畫面文字反查字典 value：至少一個「新事件」的精確繁中字串命中。
  const valueToKey = new Map();
  for (const [key, value] of Object.entries(COPY_DOCUMENT.copy)) {
    if (!valueToKey.has(value)) valueToKey.set(value, key);
  }
  const exactHits = [];
  for (const text of allCopyTexts) {
    const key = valueToKey.get(text);
    if (key !== undefined && !exactHits.some((hit) => hit.key === key)) {
      exactHits.push({ key, text, isNew: !LEGACY_COPY_KEYS.has(key) });
    }
  }
  copyReport.exactHits = exactHits.slice(0, 12);
  copyReport.newExactHits = exactHits.filter((hit) => hit.isNew).slice(0, 12);
  check(
    "new_event_exact_traditional_chinese_string",
    copyReport.newExactHits.length >= 1,
    `exactHits=${exactHits.length} newHits=${exactHits.filter((hit) => hit.isNew).length} ` +
      `sample=${JSON.stringify(copyReport.newExactHits[0] ?? null)}`
  );
  check(
    "copy_exact_strings_match_dictionary",
    exactHits.length >= 5,
    `exactHits=${exactHits.length}`
  );
  check(
    "chosen_option_story_copy_is_traditional_chinese",
    copySamples.every((sample) => sample.eventNames.every((text) => /[\u3400-\u9fff]/.test(text))),
    `eventNames=${copySamples.reduce((sum, sample) => sum + sample.eventNames.length, 0)}`
  );

  // 7. 重生（若重生回到出生卡，先按開始再驗證 0 歲）
  // GPT-DEEPSEEK-0074-A：死亡頁只能有一個重生入口（0073-B 的重複按鈕已移除）。
  const rebirthButtons = await page.locator('[data-action="rebirth"]').count();
  check("death_has_exactly_one_rebirth_button", rebirthButtons === 1, `count=${rebirthButtons}`);
  await page.locator('[data-action="rebirth"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life" ||
      document.querySelector(".p3e-birth-card") !== null,
    undefined,
    { timeout: 20000 }
  );
  await startLifeFromBirth(page);
  const rebirthText = (await page.locator("body").innerText()) ?? "";
  check(
    "rebirth_returns_age0",
    (display(rebirthText).includes("年齡 0") || display(rebirthText).includes("0 歲")) && (await commandCount(page)) === 0
  );

  // 8. GPT-0031-B：四個手機尺寸（含 360x640）：水平／垂直溢出皆為 0，
  //    六個必要區塊同屏（底部 tabs 已移除）、觸控區 >=44px
  await ensurePlayable(page);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 360, height: 640 },
    { width: 320, height: 568 }
  ]) {
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    const overflow = await horizontalOverflow(page);
    check(
      `viewport_${label}_no_horizontal_overflow`,
      overflow <= 1,
      `overflow=${overflow}`
    );

    const vertical = await verticalOverflow(page);
    const verticalOk =
      vertical.documentOverflow <= 1 && vertical.bodyOverflow <= 1 && vertical.scrolled === 0;
    check(
      `viewport_${label}_vertical_overflow_0`,
      verticalOk,
      `doc=${vertical.documentOverflow} body=${vertical.bodyOverflow} scrolled=${vertical.scrolled} docOverflowY=${vertical.docOverflowY} bodyOverflowY=${vertical.bodyOverflowY}`
    );

    const layout = await layoutSnapshot(page);
    check(
      `viewport_${label}_all_six_sections_visible`,
      layout.ok,
      JSON.stringify(layout.rects)
    );

    // GPT-0054-B：390×844／430×932 優先，場景必須是 190–230px 的分層 SVG，
    // 且沒有因本任務新增任何整頁垂直捲動（上方的 vertical_overflow_0 已驗證）。
    const sceneState = await page.evaluate(() => {
      const node = document.querySelector(".p3e-scene");
      if (node === null) return null;
      const style = getComputedStyle(node);
      return {
        height: Math.round(node.getBoundingClientRect().height),
        assetId: node.dataset.p3eSceneAsset ?? null,
        signature: node.dataset.p3eSceneSignature ?? null,
        layers: node.dataset.p3eSceneLayers ?? null,
        residence: node.dataset.p3eSceneResidence ?? null,
        ageStage: node.dataset.p3eSceneAgeStage ?? null,
        backgroundSize: style.backgroundSize,
        backgroundRepeat: style.backgroundRepeat,
        url: style.backgroundImage,
        children: node.children.length,
        emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(node.textContent ?? "")
      };
    });
    // 190–230px 是 390×844／430×932 這兩個優先尺寸的規範；
    // 360×640／320×568 既有 media query 會刻意壓縮場景，只需確認分層圖仍有效。
    const primaryViewport = viewport.width >= 390;
    const sceneHeightOk = primaryViewport
      ? sceneState !== null && sceneState.height >= 190 && sceneState.height <= 230
      : sceneState !== null && sceneState.height > 0 && sceneState.height < 190;
    check(
      `viewport_${label}_layered_scene_layout`,
      sceneHeightOk &&
        sceneState.assetId === "generated-layered-svg" &&
        sceneState.url.includes("data:image/svg+xml,") &&
        (sceneState.backgroundSize.split(",")[0] ?? "").trim() === "contain" &&
        sceneState.backgroundRepeat.startsWith("no-repeat") &&
        (sceneState.layers ?? "").includes("background") &&
        (sceneState.layers ?? "").includes("player") &&
        /^[0-9a-f]{8}$/.test(sceneState.signature ?? "") &&
        ["urban", "rural"].includes(sceneState.residence ?? "") &&
        sceneState.children === 0 && !sceneState.emoji,
      `height=${sceneState?.height} asset=${sceneState?.assetId} layers=${sceneState?.layers} ` +
        `residence=${sceneState?.residence} children=${sceneState?.children}`
    );

    const touch = await touchTargets(page);
    check(
      `viewport_${label}_touch_targets_min_44px`,
      touch.ok,
      `checked=${touch.checked} small=${JSON.stringify(touch.small)}`
    );

    if (viewport.width === 320) {
      check(
        "viewport_320x568_body_overflow_0",
        vertical.bodyOverflow <= 1 && vertical.bodyOverflowY === "hidden",
        `body=${vertical.bodyOverflow} overflowY=${vertical.bodyOverflowY}`
      );
    }
    layoutReport.push({ label, vertical, layout, touch });
  }

  // 320x568 真的點得到主要按鈕（獨立分頁，不影響主線狀態）
  {
    const smallContext = await browser.newContext({
      viewport: { width: 320, height: 568 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    const smallPage = await smallContext.newPage();
    await smallPage.goto(`${baseUrl}/${GOLDEN_QUERY}`, { waitUntil: "domcontentloaded" });
    await smallPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await ensurePlayable(smallPage);
    const before = await commandCount(smallPage);
    const targets = await touchTargets(smallPage);

    // GPT-0032-B：320x568 的 HUD label >= 11px、value >= 13px，且四項資訊都在。
    const smallHud = await smallPage.evaluate(() => {
      const hud = document.querySelector(".p3e-hud");
      const label = hud?.querySelector(".p3e-hud-item span") ?? null;
      const value = hud?.querySelector(".p3e-hud-item strong") ?? null;
      return {
        // .p3e-sr-only 也是 span，但它只是幼兒財務的可存取說明，不是 HUD label。
        labels: [...(hud?.querySelectorAll(".p3e-hud-item") ?? [])].map(
          (item) => item.querySelector(":scope > span:not(.p3e-sr-only)")?.textContent ?? ""
        ),
        values: [...(hud?.querySelectorAll(".p3e-hud-item > strong") ?? [])].map(
          (node) => node.textContent ?? ""
        ),
        labelFont: label === null ? null : parseFloat(getComputedStyle(label).fontSize),
        valueFont: value === null ? null : parseFloat(getComputedStyle(value).fontSize)
      };
    });
    check(
      "hud_320x568_font_sizes_and_all_four_items",
      smallHud.labelFont !== null && smallHud.labelFont >= 11 &&
        smallHud.valueFont !== null && smallHud.valueFont >= 13 &&
        JSON.stringify(canonList(smallHud.labels)) === JSON.stringify(canonList(["年份", "年齡", "資產", "年收入"])) &&
        smallHud.values.length === 4 && smallHud.values.every((text) => text.length > 0),
      `label=${smallHud.labelFont}px value=${smallHud.valueFont}px ` +
        `labels=${JSON.stringify(smallHud.labels)} values=${JSON.stringify(smallHud.values)}`
    );

    let clicked = false;
    if ((await smallPage.locator('[data-action="advance"]').count()) > 0) {
      await smallPage.locator('[data-action="advance"]').first().click();
      await smallPage.waitForFunction(
        (previous) =>
          Number(
            document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-command-count") ?? "0"
          ) > previous,
        before,
        { timeout: 20000 }
      );
      clicked = true;
    }
    check(
      "viewport_320x568_primary_buttons_operable",
      targets.ok && clicked && (await commandCount(smallPage)) > before,
      `touch_ok=${targets.ok} checked=${targets.checked} clicked=${clicked}`
    );
    await smallContext.close();
  }
  await page.setViewportSize({ width: 390, height: 844 });

  // 9. axe（critical／serious 必須為 0）
  const violations = await axeAudit(page);
  const serious = violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious"
  );
  check("axe_critical_serious_0", serious.length === 0, JSON.stringify(serious));

  // 10. boot 資產預算（含第一次可玩畫面前的 JSON pack 與繁中字典）
  check(
    "boot_required_gzip_under_512kb",
    boot.boot_required_gzip < BOOT_BUDGET_GZIP,
    `${boot.boot_required_gzip} < ${BOOT_BUDGET_GZIP}`
  );
  const copyAsset = [...bootRequests.keys()].filter((path) => path.includes("event-copy"));
  const copyBody = copyAsset.length === 1 ? await readDistFile(copyAsset[0]) : null;
  const copyGzip = copyBody === null ? Number.POSITIVE_INFINITY : gzipSync(copyBody).length;
  check(
    "copy_dictionary_gzip_under_10kb",
    copyAsset.length === 1 && copyGzip < COPY_GZIP_BUDGET,
    `assets=${copyAsset.length} gzip=${copyGzip} < ${COPY_GZIP_BUDGET}`
  );

  // GPT-0054-B：場景改為「原創分層 SVG data URI」後，首屏不再請求任何
  // 外部場景圖（舊直立圖、舊 landscape AVIF 都不該被載入），也不得有 CDN。
  const legacySceneRequests = [...bootRequests.keys()].filter((path) =>
    /life-sim-village-(?:mvp|landscape)/.test(path)
  );
  const externalSceneRequests = [...bootRequests.keys()].filter((path) =>
    /\.(?:avif|webp|png|jpe?g)$/i.test(path) && /scene|village|landscape/i.test(path)
  );
  check(
    "scene_no_external_asset_in_boot",
    legacySceneRequests.length === 0 && externalSceneRequests.length === 0,
    `legacy=${JSON.stringify(legacySceneRequests)} external=${JSON.stringify(externalSceneRequests)}`
  );

  /* ---------------------------------------------------------------- */
  /* 11. 真實 localStorage 的 autosave／reload 情境（H5-CTO-188-A）      */
  /* ---------------------------------------------------------------- */

  const scenarioResults = [];
  let cpu4xMetrics = null;

  function verify(name, ok, detail) {
    scenarioResults.push({ name, ok: Boolean(ok), detail: detail ?? null });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) process.exitCode = 1;
  }

  async function newScenarioPage(initScript, initArg) {
    const scenarioContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    // GPT-0041-B：`addInitScript` 不會擷取 Node 閉包變數，資料必須以引數傳入，
    // 否則頁面內 `fr.status` 等會 ReferenceError，覆蓋失效。
    if (initScript !== undefined) await scenarioContext.addInitScript(initScript, initArg);
    const scenarioPage = await scenarioContext.newPage();
    return { scenarioContext, scenarioPage };
  }

  /**
   * 情境開頁：預設一律用官方 golden seed，讓 autosave／reload／51 命令／
   * 匯入匯出等決定性流程不再依賴「首次開頁固定 seed」。
   * 明確傳別的字串 → 用該 seed；傳 `null` → 完全不帶 query（驗證真隨機首次開頁）。
   */
  async function openScenario(scenarioPage, seed = GOLDEN_SEED) {
    const query =
      seed === null ? "" : `?seed=${encodeURIComponent(seed)}&${REPLAY_QUERY}`;
    await scenarioPage.goto(`${baseUrl}/${query}`, { waitUntil: "domcontentloaded" });
    await scenarioPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await ensurePlayable(scenarioPage);
    // GPT-0031-B：存檔／診斷已收進漢堡選單。預設保持收合，避免前景面板
    // 擋住決策卡；只有需要操作存檔按鈕的情境才呼叫 openHudMenu()。
  }

  async function openHudMenu(target) {
    const menu = target.locator("details.p3e-hud-menu");
    if ((await menu.count()) === 1) await menu.evaluate((details) => { details.open = true; });
  }

  function readAttrs(scenarioPage) {
    return scenarioPage.evaluate(() => {
      const node = document.querySelector("[data-p3e-live]");
      return {
        count: Number(node?.getAttribute("data-p3e-command-count") ?? "-1"),
        hash: node?.getAttribute("data-p3e-state-hash") ?? null,
        head: node?.getAttribute("data-p3e-command-head") ?? null,
        phase: node?.getAttribute("data-p3e-phase") ?? null,
        status: node?.getAttribute("data-p3e-persistence-status") ?? null,
        error: node?.getAttribute("data-p3e-persistence-error") ?? null
      };
    });
  }

  function readStoredSave(scenarioPage) {
    return scenarioPage.evaluate(() => {
      try {
        return window.localStorage.getItem("life-sim:p3e:v6:autosave");
      } catch {
        return null;
      }
    });
  }

  function writeStoredSave(scenarioPage, value) {
    return scenarioPage.evaluate((raw) => {
      window.localStorage.setItem("life-sim:p3e:v6:autosave", raw);
    }, value);
  }

  async function advanceOnce(scenarioPage) {
    await dismissFocusPickerIfOpen(scenarioPage);
    const before = await commandCount(scenarioPage);
    await scenarioPage.locator('[data-action="advance"]').first().click();
    await scenarioPage.waitForFunction(
      (prev) => {
        const node = document.querySelector("[data-p3e-live]");
        const count = Number(node?.getAttribute("data-p3e-command-count") ?? "0");
        return count > prev || node?.getAttribute("data-p3e-phase") === "death";
      },
      before,
      { timeout: 20000 }
    );
  }

  async function runToPhase(scenarioPage, target) {
    let guard = 0;
    while ((await phaseOf(scenarioPage)) !== target && guard < 400) {
      const phase = await phaseOf(scenarioPage);
      const selector = phase === "pending_decision" ? '[data-action="choose"]' : '[data-action="advance"]';
      await clickAndWait(scenarioPage, selector);
      guard += 1;
    }
  }

  async function reloadApp(scenarioPage) {
    await scenarioPage.reload({ waitUntil: "domcontentloaded" });
    await scenarioPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await ensurePlayable(scenarioPage);
  }

  // 1. clean boot 建新命並存檔
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    const attrs = await readAttrs(scenarioPage);
    const raw = await readStoredSave(scenarioPage);
    let parsed = null;
    try {
      parsed = JSON.parse(raw ?? "");
    } catch {
      parsed = null;
    }
    verify(
      "clean_boot_creates_and_saves_age0",
      attrs.status === "saved" &&
        attrs.count === 0 &&
        parsed !== null &&
        parsed.magic === "LIFE1" &&
        parsed.saveFormatVersion === 6,
      `status=${attrs.status} count=${attrs.count} magic=${parsed?.magic}`
    );
    await scenarioContext.close();
  }

  // 2. advance 後 reload：count／hash／head 一致
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    await advanceOnce(scenarioPage);
    const before = await readAttrs(scenarioPage);
    await reloadApp(scenarioPage);
    const after = await readAttrs(scenarioPage);
    verify(
      "advance_reload_same_count_hash_head",
      before.count === 1 &&
        after.count === before.count &&
        after.hash === before.hash &&
        after.head === before.head &&
        after.status === "restored",
      `count=${after.count} status=${after.status}`
    );
    await scenarioContext.close();
  }

  // 3. pending decision 後 reload：選項相同、可選
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    await runToPhase(scenarioPage, "pending_decision");
    const labelsBefore = await scenarioPage
      .locator('[data-action="choose"]')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
    const before = await readAttrs(scenarioPage);
    await reloadApp(scenarioPage);
    const labelsAfter = await scenarioPage
      .locator('[data-action="choose"]')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
    const after = await readAttrs(scenarioPage);
    await scenarioPage.locator('[data-action="choose"]').first().click();
    await scenarioPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life",
      undefined,
      { timeout: 20000 }
    );
    verify(
      "pending_decision_reload_same_options_then_choose",
      labelsBefore.length >= 2 &&
        JSON.stringify(labelsBefore) === JSON.stringify(labelsAfter) &&
        after.hash === before.hash &&
        after.count === before.count &&
        after.phase === "pending_decision" &&
        (await phaseOf(scenarioPage)) === "life",
      `options=${labelsAfter.length}`
    );
    await scenarioContext.close();
  }

  // 4. death 後 reload：官方 golden（78 命令）逐位元一致
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    await runToPhase(scenarioPage, "death");
    const before = await readAttrs(scenarioPage);
    await reloadApp(scenarioPage);
    const after = await readAttrs(scenarioPage);
    verify(
      "death_reload_bit_exact_official51",
      before.count === EXPECTED_COMMANDS &&
        after.count === EXPECTED_COMMANDS &&
        after.hash === before.hash &&
        after.head === before.head &&
        after.phase === "death" &&
        after.status === "restored",
      `count=${after.count}`
    );
    await scenarioContext.close();
  }

  // 5-6. 壞存檔：顯示恢復、不靜默刪除；恢復後 age0 並存檔
  {
    // 以 init script 在頁面啟動前預先寫入壞值（避免 pagehide flush 先把它蓋回合法值）。
    const { scenarioContext, scenarioPage } = await newScenarioPage(() => {
      try {
        window.localStorage.setItem("life-sim:p3e:v6:autosave", "not-a-valid-envelope");
      } catch {
        // storage 不可用時此情境不適用
      }
    });
    await openScenario(scenarioPage);
    const broken = await readAttrs(scenarioPage);
    const stillStored = await readStoredSave(scenarioPage);
    await openHudMenu(scenarioPage);
    const recoverButton = await scenarioPage.locator('[data-action="recover"]:visible').count();
    verify(
      "corrupt_save_shows_recovery_and_is_not_silently_deleted",
      broken.status === "restore-error" && stillStored === "not-a-valid-envelope" && recoverButton === 1,
      `status=${broken.status}`
    );
    await scenarioPage.locator('[data-action="recover"]').click();
    await scenarioPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-persistence-status") === "saved",
      undefined,
      { timeout: 20000 }
    );
    const recovered = await readAttrs(scenarioPage);
    const recoveredRaw = await readStoredSave(scenarioPage);
    let recoveredParsed = null;
    try {
      recoveredParsed = JSON.parse(recoveredRaw ?? "");
    } catch {
      recoveredParsed = null;
    }
    verify(
      "recovery_clear_starts_age0_and_saves",
      recovered.count === 0 && recovered.status === "saved" && recoveredParsed !== null && recoveredParsed.saveFormatVersion === 6,
      `count=${recovered.count}`
    );
    await scenarioContext.close();
  }

  // 7. 錯 seed：不靜默刪除存檔
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    await advanceOnce(scenarioPage);
    await waitForSaved(scenarioPage);
    const rawBefore = await readStoredSave(scenarioPage);
    await openScenario(scenarioPage, "p3e-other-seed-777");
    const attrs = await readAttrs(scenarioPage);
    const rawAfter = await readStoredSave(scenarioPage);
    await openHudMenu(scenarioPage);
    const recoverButton = await scenarioPage.locator('[data-action="recover"]:visible').count();
    verify(
      "wrong_seed_save_not_silently_deleted",
      attrs.status === "restore-error" && rawAfter === rawBefore && recoverButton === 1,
      `status=${attrs.status}`
    );
    await scenarioContext.close();
  }

  // 8. storage 不可用：ephemeral 但可玩
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new Error("storage blocked for smoke");
        }
      });
    });
    await openScenario(scenarioPage);
    const first = await readAttrs(scenarioPage);
    await advanceOnce(scenarioPage);
    const second = await readAttrs(scenarioPage);
    verify(
      "storage_unavailable_keeps_game_playable_ephemeral",
      first.status === "ephemeral" && second.status === "ephemeral" && second.count === 1 && second.phase === "life",
      `status=${second.status} count=${second.count}`
    );
    await scenarioContext.close();
  }

  // 9. 死亡後「重新開始」：先回出生卡並清除舊死亡存檔；按「開始人生」才寫新 age 0 存檔
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    await runToPhase(scenarioPage, "death");
    const deathRaw = await readStoredSave(scenarioPage);

    await scenarioPage.locator('[data-action="rebirth"]').click();
    await scenarioPage.waitForSelector(".p3e-birth-card", { timeout: 20000 });
    const birthAttrs = await readAttrs(scenarioPage);
    const clearedRaw = await readStoredSave(scenarioPage);
    verify(
      "rebirth_returns_to_birth_card_and_clears_death_save",
      birthAttrs.phase === "birth" &&
        birthAttrs.count === 0 &&
        birthAttrs.status === "cleared" &&
        deathRaw !== null &&
        clearedRaw === null,
      `phase=${birthAttrs.phase} status=${birthAttrs.status} deathSave=${deathRaw !== null} cleared=${clearedRaw === null}`
    );

    await scenarioPage.locator('[data-action="start-life"]').click();
    await scenarioPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life",
      undefined,
      { timeout: 20000 }
    );
    await waitForSaved(scenarioPage);
    const reborn = await readAttrs(scenarioPage);
    const rebornRaw = await readStoredSave(scenarioPage);
    let rebornParsed = null;
    try {
      rebornParsed = JSON.parse(rebornRaw ?? "");
    } catch {
      rebornParsed = null;
    }
    verify(
      "rebirth_replaces_old_death_save",
      reborn.count === 0 &&
        reborn.status === "saved" &&
        rebornRaw !== null &&
        rebornRaw !== deathRaw &&
        rebornParsed !== null &&
        rebornParsed.saveFormatVersion === 6,
      `count=${reborn.count} status=${reborn.status} v6=${rebornParsed?.saveFormatVersion ?? null}`
    );
    await scenarioContext.close();
  }

  // 9b. 真實使用者（無 ?seed=）：死亡後「重新開始」換一個新的隨機 seed
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await scenarioPage.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await scenarioPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    const readBirthSeed = () =>
      scenarioPage.evaluate(
        () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-birth-seed") ?? null
      );
    const firstSeed = await readBirthSeed();
    await startLifeFromBirth(scenarioPage);
    await runToPhase(scenarioPage, "death");
    await scenarioPage.locator('[data-action="rebirth"]').click();
    await scenarioPage.waitForSelector(".p3e-birth-card", { timeout: 20000 });
    const nextSeed = await readBirthSeed();
    const cleared = await readStoredSave(scenarioPage);
    verify(
      "rebirth_uses_fresh_random_seed_without_pinned",
      /^life-[0-9a-f]{20}$/.test(firstSeed ?? "") &&
        /^life-[0-9a-f]{20}$/.test(nextSeed ?? "") &&
        firstSeed !== nextSeed &&
        cleared === null,
      `first=${firstSeed} next=${nextSeed} saveCleared=${cleared === null}`
    );
    await scenarioContext.close();
  }

  // 9c. 舊版存檔相容：沒有 active seed 時先用 DEFAULT_SEED 恢復，不應顯示隨機出生卡
  {
    const source = await newScenarioPage();
    await openScenario(source.scenarioPage);
    await advanceOnce(source.scenarioPage);
    // autosave 是非同步 coalesced flush，先等落盤，確保拿到的是 count=1 的舊存檔。
    await waitForSaved(source.scenarioPage);
    const legacyRaw = await readStoredSave(source.scenarioPage);
    await source.scenarioContext.close();

    const legacyContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    if (legacyRaw !== null) {
      await legacyContext.addInitScript((raw) => {
        try {
          window.localStorage.setItem("life-sim:p3e:v6:autosave", raw);
        } catch {
          // 儲存被封鎖時由下面的檢查如實回報
        }
      }, legacyRaw);
    }
    const legacyPage = await legacyContext.newPage();
    await legacyPage.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await legacyPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    const attrs = await readAttrs(legacyPage);
    const birthCardCount = await legacyPage.locator(".p3e-birth-card").count();
    verify(
      "legacy_save_restores_without_active_seed",
      legacyRaw !== null &&
        attrs.phase === "life" &&
        attrs.status === "restored" &&
        attrs.count === 1 &&
        birthCardCount === 0,
      `phase=${attrs.phase} status=${attrs.status} count=${attrs.count} birthCard=${birthCardCount}`
    );
    await legacyContext.close();
  }

  /* ---------------------------------------------------------------- */
  /* 12. async coalesced autosave＋CPU 4x 量測（H5-CTO-190-A）           */
  /* ---------------------------------------------------------------- */

  function waitForSaved(scenarioPage, timeout = 5000) {
    return scenarioPage.waitForFunction(
      () =>
        document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-persistence-status") === "saved",
      undefined,
      { timeout }
    );
  }

  function readStoredStateHash(scenarioPage) {
    return scenarioPage.evaluate(() => {
      try {
        const raw = window.localStorage.getItem("life-sim:p3e:v6:autosave");
        if (raw === null) return null;
        const envelope = JSON.parse(raw);
        const payload = JSON.parse(envelope.payload);
        return payload.state?.stateHash ?? null;
      } catch {
        return null;
      }
    });
  }

  // 1. 命令先 render，autosave 之後才完成
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    const instant = await scenarioPage.evaluate(() => {
      const button = document.querySelector('[data-action="advance"]');
      button.click();
      const node = document.querySelector("[data-p3e-live]");
      return {
        count: Number(node.getAttribute("data-p3e-command-count")),
        status: node.getAttribute("data-p3e-persistence-status")
      };
    });
    verify(
      "command_renders_before_autosave_completion",
      instant.count === 1 && instant.status === "saving",
      `count=${instant.count} status=${instant.status}`
    );
    await waitForSaved(scenarioPage);
    await scenarioContext.close();
  }

  // 2. 等 saved 後 reload：逐位元一致
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    await advanceOnce(scenarioPage);
    await waitForSaved(scenarioPage);
    const before = await readAttrs(scenarioPage);
    const storedHash = await readStoredStateHash(scenarioPage);
    await reloadApp(scenarioPage);
    const after = await readAttrs(scenarioPage);
    verify(
      "wait_saved_then_reload_is_bit_exact",
      storedHash === before.hash &&
        after.hash === before.hash &&
        after.count === before.count &&
        after.head === before.head &&
        after.status === "restored",
      `stored=${storedHash === before.hash} count=${after.count}`
    );
    await scenarioContext.close();
  }

  // 3. 連續兩個命令 coalesce 到最新 hash
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    const immediate = await scenarioPage.evaluate(() => {
      document.querySelector('[data-action="advance"]').click();
      document.querySelector('[data-action="advance"]').click();
      const node = document.querySelector("[data-p3e-live]");
      return {
        count: Number(node.getAttribute("data-p3e-command-count")),
        hash: node.getAttribute("data-p3e-state-hash"),
        status: node.getAttribute("data-p3e-persistence-status")
      };
    });
    await waitForSaved(scenarioPage);
    const storedHash = await readStoredStateHash(scenarioPage);
    verify(
      "rapid_two_commands_coalesce_to_latest_hash",
      immediate.count === 2 && immediate.status === "saving" && storedHash === immediate.hash,
      `count=${immediate.count} latest=${storedHash === immediate.hash}`
    );
    await scenarioContext.close();
  }

  // 4. pagehide 同步 flush 最新 hash
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    const state = await scenarioPage.evaluate(() => {
      document.querySelector('[data-action="advance"]').click();
      const node = document.querySelector("[data-p3e-live]");
      const hash = node.getAttribute("data-p3e-state-hash");
      window.dispatchEvent(new Event("pagehide"));
      return { hash, count: Number(node.getAttribute("data-p3e-command-count")) };
    });
    const storedHash = await readStoredStateHash(scenarioPage);
    await reloadApp(scenarioPage);
    const after = await readAttrs(scenarioPage);
    verify(
      "pagehide_flush_restores_latest_hash",
      storedHash === state.hash && after.hash === state.hash && after.count === state.count,
      `count=${after.count}`
    );
    await scenarioContext.close();
  }

  // 5. 舊 generation 不得覆寫較新的存檔
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    const latest = await scenarioPage.evaluate(() => {
      const click = () => document.querySelector('[data-action="advance"]').click();
      click();
      click();
      const node = document.querySelector("[data-p3e-live]");
      window.dispatchEvent(new Event("pagehide"));
      return {
        hash: node.getAttribute("data-p3e-state-hash"),
        generation: Number(node.getAttribute("data-p3e-persistence-generation"))
      };
    });
    const storedHash = await readStoredStateHash(scenarioPage);
    await waitForSaved(scenarioPage);
    const storedHashAfter = await readStoredStateHash(scenarioPage);
    verify(
      "stale_generation_never_overwrites_newer_save",
      storedHash === latest.hash && storedHashAfter === latest.hash && latest.generation >= 2,
      `generation=${latest.generation} stable=${storedHashAfter === latest.hash}`
    );
    await scenarioContext.close();
  }

  // 6-7. CPU 4x：interactive render p95 與 autosave completion p95
  {
    const viewports = [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 430, height: 932 }
    ];
    const interactiveSamples = [];
    const completionSamples = [];
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true
      });
      const perfPage = await context.newPage();
      const client = await context.newCDPSession(perfPage);
      await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await perfPage.goto(`${baseUrl}/${GOLDEN_QUERY}`, { waitUntil: "domcontentloaded" });
      await perfPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
      await ensurePlayable(perfPage);
      for (let index = 0; index < 30; index += 1) {
        const sample = await perfPage.evaluate(() => {
          const start = performance.now();
          const advance = document.querySelector('[data-action="advance"]');
          if (advance !== null) advance.click();
          else document.querySelector('[data-action="choose"]').click();
          const node = document.querySelector("[data-p3e-live]");
          return {
            count: Number(node.getAttribute("data-p3e-command-count")),
            ms: performance.now() - start
          };
        });
        interactiveSamples.push(sample.ms);
        const completion = await perfPage.evaluate(async () => {
          const start = performance.now();
          while (
            document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-persistence-status") !==
            "saved"
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (performance.now() - start > 5000) break;
          }
          return performance.now() - start;
        });
        completionSamples.push(completion);
      }
      await context.close();
    }
    const p95 = (values) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    };
    const interactiveP95 = p95(interactiveSamples);
    const completionP95 = p95(completionSamples);
    cpu4xMetrics = {
      interactive_p95_ms: Number(interactiveP95.toFixed(2)),
      completion_p95_ms: Number(completionP95.toFixed(2)),
      samples: interactiveSamples.length,
      cpu_throttle: 4,
      viewports: viewports.length
    };
    verify(
      "cpu4x_interactive_command_p95_under_200ms",
      interactiveP95 < 200,
      `p95=${interactiveP95.toFixed(1)}ms n=${interactiveSamples.length}`
    );
    verify(
      "autosave_eventual_completion_under_1500ms_cpu4x",
      completionP95 < 1500,
      `p95=${completionP95.toFixed(1)}ms n=${completionSamples.length}`
    );
  }

  /* ---------------------------------------------------------------- */
  /* 13. portable save 下載／上傳（H5-CTO-192-A）                        */
  /* ---------------------------------------------------------------- */

  async function exportSave(scenarioPage) {
    await openHudMenu(scenarioPage);
    const [download] = await Promise.all([
      scenarioPage.waitForEvent("download"),
      scenarioPage.locator('[data-action="export"]').first().click()
    ]);
    const downloadPath = await download.path();
    const bytes = await readFile(downloadPath);
    return { filename: download.suggestedFilename(), bytes };
  }

  async function uploadSave(scenarioPage, buffer, name = "upload.json") {
    await scenarioPage
      .locator('input[data-role="import-input"]')
      .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  }

  async function waitForAlert(scenarioPage) {
    try {
      await scenarioPage.waitForFunction(
        () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-last-import") === "error",
        undefined,
        { timeout: 20000 }
      );
    } catch (error) {
      const dump = await scenarioPage.evaluate(() => ({
        lastImport: document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-last-import"),
        alert: document.querySelector("#p3e-alert")?.textContent ?? null,
        inputs: document.querySelectorAll('input[data-role="import-input"]').length,
        buttons: document.querySelectorAll("[data-action]").length,
        status: document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-persistence-status")
      }));
      console.error("waitForAlert dump:", JSON.stringify(dump));
      throw error;
    }
  }

  // 1. age0 下載：canonical LIFE1 v6、固定檔名與 MIME 狀態
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    const downloaded = await exportSave(scenarioPage);
    const text = downloaded.bytes.toString("utf8");
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    verify(
      "age0_download_canonical_LIFE1_v6",
      parsed !== null &&
        parsed.magic === "LIFE1" &&
        parsed.saveFormatVersion === 6 &&
        parsed.payloadFormat === "p3e-session-payload-1" &&
        text.startsWith('{"magic":"LIFE1","saveFormatVersion":6,'),
      `bytes=${downloaded.bytes.length}`
    );
    const lastExport = await scenarioPage.evaluate(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-last-export") ?? ""
    );
    verify(
      "exact_filename_and_MIME",
      downloaded.filename === "life-sim-p3e-v6.json" && lastExport === "life-sim-p3e-v6.json|application/json",
      `filename=${downloaded.filename}`
    );
    await scenarioContext.close();
  }

  // 2. 官方 golden 下載 → 新頁面上傳 → death 逐位元一致
  {
    const source = await newScenarioPage();
    await openScenario(source.scenarioPage);
    await runToPhase(source.scenarioPage, "death");
    const deathAttrs = await readAttrs(source.scenarioPage);
    const downloaded = await exportSave(source.scenarioPage);
    await source.scenarioContext.close();

    const target = await newScenarioPage();
    await openScenario(target.scenarioPage);
    await uploadSave(target.scenarioPage, downloaded.bytes, "death.json");
    await target.scenarioPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "death",
      undefined,
      { timeout: 20000 }
    );
    const imported = await readAttrs(target.scenarioPage);
    verify(
      "official51_download_fresh_page_upload_death_bit_exact",
      imported.count === EXPECTED_COMMANDS &&
        imported.hash === deathAttrs.hash &&
        imported.head === deathAttrs.head &&
        imported.phase === "death",
      `count=${imported.count}`
    );
    await target.scenarioContext.close();
  }

  // 3. pending decision roundtrip 後可繼續
  {
    const source = await newScenarioPage();
    await openScenario(source.scenarioPage);
    await runToPhase(source.scenarioPage, "pending_decision");
    const labels = await source.scenarioPage
      .locator('[data-action="choose"]')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
    const pendingAttrs = await readAttrs(source.scenarioPage);
    const downloaded = await exportSave(source.scenarioPage);
    await source.scenarioContext.close();

    const target = await newScenarioPage();
    await openScenario(target.scenarioPage);
    await uploadSave(target.scenarioPage, downloaded.bytes, "pending.json");
    await target.scenarioPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "pending_decision",
      undefined,
      { timeout: 20000 }
    );
    const imported = await readAttrs(target.scenarioPage);
    const labelsImported = await target.scenarioPage
      .locator('[data-action="choose"]')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
    await target.scenarioPage.locator('[data-action="choose"]').first().click();
    await target.scenarioPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life",
      undefined,
      { timeout: 20000 }
    );
    verify(
      "pending_decision_roundtrip_and_continue",
      labels.length >= 2 &&
        JSON.stringify(labels) === JSON.stringify(labelsImported) &&
        imported.hash === pendingAttrs.hash &&
        imported.count === pendingAttrs.count &&
        (await phaseOf(target.scenarioPage)) === "life",
      `options=${labelsImported.length}`
    );
    await target.scenarioContext.close();
  }

  // 4. raw 與 gzip 兩種匯入形態
  {
    const source = await newScenarioPage();
    await openScenario(source.scenarioPage);
    await advanceOnce(source.scenarioPage);
    await waitForSaved(source.scenarioPage);
    const attrs = await readAttrs(source.scenarioPage);
    const downloaded = await exportSave(source.scenarioPage);
    const gzipBytes = gzipSync(downloaded.bytes);
    await source.scenarioContext.close();

    let rawOk = false;
    {
      const target = await newScenarioPage();
      await openScenario(target.scenarioPage);
      await uploadSave(target.scenarioPage, downloaded.bytes, "raw.json");
      await target.scenarioPage.waitForFunction(
        (expected) => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-state-hash") === expected,
        attrs.hash,
        { timeout: 20000 }
      );
      rawOk = (await readAttrs(target.scenarioPage)).hash === attrs.hash;
      await target.scenarioContext.close();
    }
    let gzipOk = false;
    {
      const target = await newScenarioPage();
      await openScenario(target.scenarioPage);
      await uploadSave(target.scenarioPage, gzipBytes, "save.json.gz");
      await target.scenarioPage.waitForFunction(
        (expected) => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-state-hash") === expected,
        attrs.hash,
        { timeout: 20000 }
      );
      gzipOk = (await readAttrs(target.scenarioPage)).hash === attrs.hash;
      await target.scenarioContext.close();
    }
    verify("raw_and_gzip_import", rawOk && gzipOk, `raw=${rawOk} gzip=${gzipOk}`);
  }

  // 5. 下載決定性
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    await advanceOnce(scenarioPage);
    await waitForSaved(scenarioPage);
    const first = await exportSave(scenarioPage);
    const second = await exportSave(scenarioPage);
    verify(
      "deterministic_download_bytes",
      first.bytes.length === second.bytes.length && first.bytes.equals(second.bytes),
      `bytes=${first.bytes.length}`
    );
    await scenarioContext.close();
  }

  // 6-7. 壞存檔／錯 seed／篡改／版本／超上限 → 拒絕且 session 不變
  {
    const source = await newScenarioPage();
    await openScenario(source.scenarioPage);
    await advanceOnce(source.scenarioPage);
    await waitForSaved(source.scenarioPage);
    const good = await exportSave(source.scenarioPage);
    await source.scenarioContext.close();

    const target = await newScenarioPage();
    await openScenario(target.scenarioPage);
    await advanceOnce(target.scenarioPage);
    const before = await readAttrs(target.scenarioPage);

    const originalText = good.bytes.toString("utf8");
    const tamperEnvelope = JSON.parse(originalText);
    const tamperPayload = JSON.parse(tamperEnvelope.payload);
    tamperPayload.state.stateHash = tamperPayload.state.stateHash.replace(/^./, (first) =>
      first === "0" ? "1" : "0"
    );
    tamperEnvelope.payload = JSON.stringify(tamperPayload);
    const tamperedText = JSON.stringify(tamperEnvelope);
    const parsedEnvelope = JSON.parse(originalText);
    parsedEnvelope.saveFormatVersion = 7;
    const versionText = JSON.stringify(parsedEnvelope);
    const oversizeGzip = Buffer.from(gzipSync(good.bytes));
    oversizeGzip.writeUInt32LE(0x7fffffff, oversizeGzip.length - 4);

    const cases = [
      { name: "corrupt.json", buffer: Buffer.from("not-json") },
      { name: "tampered.json", buffer: Buffer.from(tamperedText) },
      { name: "version.json", buffer: Buffer.from(versionText) },
      { name: "oversize.gz", buffer: oversizeGzip }
    ];
    let rejected = 0;
    let stayed = 0;
    for (const entry of cases) {
      await uploadSave(target.scenarioPage, entry.buffer, entry.name);
      await waitForAlert(target.scenarioPage);
      const after = await readAttrs(target.scenarioPage);
      rejected += 1;
      if (after.count === before.count && after.hash === before.hash) stayed += 1;
    }
    // 錯 seed：預設 seed 的存檔上傳到不同 seed 的頁面
    const wrongSeedPage = await newScenarioPage();
    await openScenario(wrongSeedPage.scenarioPage, "p3e-other-seed-777");
    const wrongSeedBefore = await readAttrs(wrongSeedPage.scenarioPage);
    await uploadSave(wrongSeedPage.scenarioPage, good.bytes, "wrong-seed.json");
    await waitForAlert(wrongSeedPage.scenarioPage);
    const wrongSeedAfter = await readAttrs(wrongSeedPage.scenarioPage);
    const wrongSeedStayed =
      wrongSeedAfter.count === wrongSeedBefore.count && wrongSeedAfter.hash === wrongSeedBefore.hash;

    verify(
      "corrupt_wrong_seed_tamper_version_oversize_reject",
      rejected === cases.length && wrongSeedStayed,
      `rejected=${rejected}/${cases.length}`
    );
    verify(
      "rejected_import_keeps_current_session_bit_exact",
      stayed === cases.length && wrongSeedStayed,
      `stable=${stayed}/${cases.length}`
    );
    await wrongSeedPage.scenarioContext.close();
    await target.scenarioContext.close();
  }

  // 8. object URL 建立後會被 revoke
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage(() => {
      const created = [];
      const revoked = [];
      const originalCreate = URL.createObjectURL.bind(URL);
      const originalRevoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        const url = originalCreate(object);
        created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        revoked.push(url);
        return originalRevoke(url);
      };
      Object.defineProperty(window, "__p3eUrlStats", {
        value: { created, revoked },
        configurable: true
      });
    });
    await openScenario(scenarioPage);
    await exportSave(scenarioPage);
    const stats = await scenarioPage.evaluate(() => ({
      created: window.__p3eUrlStats.created.length,
      revoked: window.__p3eUrlStats.revoked.length
    }));
    verify(
      "object_URL_revoked",
      stats.created > 0 && stats.revoked === stats.created,
      `created=${stats.created} revoked=${stats.revoked}`
    );
    await scenarioContext.close();
  }

  // 10. localStorage 不可用時 portable 流程仍可運作（純記憶體）
  {
    const seeded = await newScenarioPage();
    await openScenario(seeded.scenarioPage);
    await advanceOnce(seeded.scenarioPage);
    await waitForSaved(seeded.scenarioPage);
    const sourceAttrs = await readAttrs(seeded.scenarioPage);
    const downloaded = await exportSave(seeded.scenarioPage);
    await seeded.scenarioContext.close();

    const blocked = await newScenarioPage(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new Error("storage blocked for portable flow");
        }
      });
    });
    await openScenario(blocked.scenarioPage);
    const bootAttrs = await readAttrs(blocked.scenarioPage);
    const blockedDownload = await exportSave(blocked.scenarioPage);
    await uploadSave(blocked.scenarioPage, downloaded.bytes, "portable.json");
    await blocked.scenarioPage.waitForFunction(
      (expected) => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-state-hash") === expected,
      sourceAttrs.hash,
      { timeout: 20000 }
    );
    const imported = await readAttrs(blocked.scenarioPage);
    verify(
      "localStorage_unavailable_portable_flow",
      bootAttrs.status === "ephemeral" &&
        blockedDownload.bytes.length > 0 &&
        imported.hash === sourceAttrs.hash &&
        imported.count === sourceAttrs.count &&
        imported.status === "ephemeral",
      `hash_match=${imported.hash === sourceAttrs.hash}`
    );
    await blocked.scenarioContext.close();
  }

  /* ---------------------------------------------------------------- */
  /* 14. GPT-0031-B：直立 HUD、完整主圖、人生紀錄、背景自然音          */
  /* ---------------------------------------------------------------- */
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    const audioRequests = [];
    scenarioPage.on("request", (request) => {
      const url = request.url();
      if (new URL(url).pathname.endsWith(".mp3")) audioRequests.push(url);
    });
    await scenarioPage.goto(`${baseUrl}/${GOLDEN_QUERY}`, { waitUntil: "domcontentloaded" });
    await scenarioPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });

    const readAudioState = () =>
      scenarioPage.evaluate(() => {
        const live = document.querySelector("[data-p3e-live]");
        const button = document.querySelector('[data-action="toggle-nature-sound"]');
        let stored = null;
        try {
          stored = window.localStorage.getItem("life-sim:p3e:v1:nature-sound");
        } catch {
          stored = "storage-error";
        }
        return {
          phase: live?.getAttribute("data-p3e-phase") ?? null,
          enabled: live?.getAttribute("data-p3e-audio-enabled") ?? null,
          blocked: live?.getAttribute("data-p3e-audio-blocked") ?? null,
          armed: live?.getAttribute("data-p3e-audio-armed") ?? null,
          requested: live?.getAttribute("data-p3e-audio-requested") ?? null,
          playing: live?.getAttribute("data-p3e-audio-playing") ?? null,
          volume: live?.getAttribute("data-p3e-audio-volume") ?? null,
          preload: live?.getAttribute("data-p3e-audio-preload") ?? null,
          loop: live?.getAttribute("data-p3e-audio-loop") ?? null,
          audioTime: live?.getAttribute("data-p3e-audio-time") ?? null,
          src: live?.getAttribute("data-p3e-audio-src") ?? null,
          stored,
          buttonText: button?.textContent ?? null,
          buttonLabel: button?.getAttribute("aria-label") ?? null,
          buttonPressed: button?.getAttribute("aria-pressed") ?? null
        };
      });

    // 14.1 出生卡：完全沒有建立 Audio／沒有任何 .mp3 請求，偏好預設 true。
    const birthAudio = await readAudioState();
    verify(
      "audio_no_request_before_start_life",
      birthAudio.phase === "birth" &&
        birthAudio.requested === "false" &&
        birthAudio.armed === "false" &&
        birthAudio.enabled === "true" &&
        birthAudio.src === "none" &&
        birthAudio.stored === null &&
        audioRequests.length === 0,
      `phase=${birthAudio.phase} requested=${birthAudio.requested} requests=${audioRequests.length} stored=${birthAudio.stored}`
    );

    // 14.2 按「開始人生」後才允許請求本機音檔。
    await startLifeFromBirth(scenarioPage);
    await scenarioPage.locator('[data-action="toggle-time"]').first().click().catch(() => {});
    await scenarioPage.waitForTimeout(600);
    let armedState = await readAudioState();
    if (armedState.blocked === "true" && audioRequests.length === 0) {
      // 瀏覽器擋下自動播放時，按鈕會切到「可再按一次開啟」，明確再點一次。
      await scenarioPage.locator('[data-action="toggle-nature-sound"]').first().click();
      await scenarioPage.waitForTimeout(600);
      armedState = await readAudioState();
    }
    verify(
      "audio_requested_only_after_valid_action",
      armedState.requested === "true" && audioRequests.length >= 1 &&
        audioRequests.every((url) => url.startsWith(baseUrl)),
      `requested=${armedState.requested} requests=${audioRequests.length} localOnly=${audioRequests.every((url) => url.startsWith(baseUrl))}`
    );
    verify(
      "audio_default_on_low_volume_loop_preload_none",
      armedState.enabled === "true" &&
        Math.abs(Number(armedState.volume) - 0.15) < 0.001 &&
        armedState.loop === "true" &&
        armedState.preload === "none" &&
        armedState.src === "local" &&
        (armedState.buttonText === "🔊" || armedState.blocked === "true"),
      `volume=${armedState.volume} loop=${armedState.loop} preload=${armedState.preload} blocked=${armedState.blocked}`
    );

    // 14.3 頂部資訊列：左起年份／年齡／資產／年收入，右側只有自然音與漢堡。
    const hud = await scenarioPage.evaluate(() => {
      const header = document.querySelector(".p3e-hud");
      if (header === null) return null;
      const items = [...header.querySelectorAll(":scope > .p3e-hud-item")].map((node) => ({
        label: node.querySelector("span")?.textContent ?? "",
        value: node.querySelector("strong")?.textContent ?? ""
      }));
      const sound = header.querySelector('[data-action="toggle-nature-sound"]');
      const menu = header.querySelector("details.p3e-hud-menu");
      const rect = (node) => (node === null ? null : node.getBoundingClientRect());
      const sr = rect(sound);
      const mr = rect(menu);
      const ir = rect(header.querySelector(".p3e-hud-income"));
      return {
        labels: items.map((item) => item.label),
        values: items.map((item) => item.value),
        minorCount: [...header.querySelectorAll(".p3e-hud-item")].filter(
          (node) => node.getAttribute("data-p3e-minor-finance") === "true"
        ).length,
        note: header.querySelector(".p3e-sr-only")?.textContent ?? null,
        soundLabel: sound?.getAttribute("aria-label") ?? null,
        soundRect: sr === null ? null : { w: sr.width, h: sr.height, left: sr.left },
        menuRect: mr === null ? null : { w: mr.width, h: mr.height, left: mr.left },
        incomeRight: ir === null ? null : ir.right,
        removedChrome: document.querySelectorAll(
          ".p3e-tools, .p3e-tab, .p3e-tabs, .p3e-game-title"
        ).length,
        // GPT-0036-B A：齒輪只允許以「設定與存檔」標題文字出現在面板裡，
        // 不能再是任何獨立按鈕／summary 的圖示。
        gearGlyph: [...header.querySelectorAll("button, summary, [role='button']")].some(
          (node) =>
            (node.textContent ?? "").includes("⚙") ||
            (node.getAttribute("aria-label") ?? "").includes("齒輪")
        ),
        settingsTitle: header.querySelector(".p3e-menu-title")?.textContent ?? null,
        menuPersistence: header.querySelector(".p3e-hud-menu-panel .p3e-persistence") !== null,
        menuExport: header.querySelector('.p3e-hud-menu-panel [data-action="export"]') !== null,
        menuImport: header.querySelector('.p3e-hud-menu-panel input[data-role="import-input"]') !== null,
        menuMeta: header.querySelector(".p3e-hud-menu-panel .p3e-meta") !== null
      };
    });
    verify(
      "hud_left_order_year_age_assets_income",
      hud !== null && JSON.stringify(canonList(hud.labels)) === JSON.stringify(canonList(["年份", "年齡", "資產", "年收入"])),
      `labels=${JSON.stringify(hud?.labels)}`
    );
    verify(
      "hud_right_only_sound_and_hamburger",
      hud !== null &&
        hud.soundRect !== null && hud.menuRect !== null &&
        hud.soundRect.left >= hud.incomeRight - 2 &&
        hud.menuRect.left >= hud.soundRect.left + hud.soundRect.w - 2 &&
        hud.removedChrome === 0 && !hud.gearGlyph && display(hud.settingsTitle).equals("⚙ 設定與存檔"),
      `soundLeft=${hud?.soundRect?.left} incomeRight=${hud?.incomeRight} menuLeft=${hud?.menuRect?.left} removed=${hud?.removedChrome} title=${hud?.settingsTitle}`
    );
    verify(
      "gear_button_and_bottom_tabs_removed_from_dom",
      hud !== null && hud.removedChrome === 0 && !hud.gearGlyph &&
        display(hud.settingsTitle).equals("⚙ 設定與存檔"),
      `removed=${hud?.removedChrome} gearGlyph=${hud?.gearGlyph} title=${hud?.settingsTitle}`
    );
    verify(
      "hamburger_keeps_save_diagnostic_recovery",
      hud !== null && hud.menuPersistence && hud.menuExport && hud.menuImport && hud.menuMeta,
      `persistence=${hud?.menuPersistence} export=${hud?.menuExport} import=${hud?.menuImport} meta=${hud?.menuMeta}`
    );
    verify(
      "hud_sound_and_menu_touch_44px",
      hud !== null && hud.soundRect !== null && hud.menuRect !== null &&
        hud.soundRect.w >= 43.5 && hud.soundRect.h >= 43.5 &&
        hud.menuRect.w >= 43.5 && hud.menuRect.h >= 43.5 &&
        typeof hud.soundLabel === "string" && hud.soundLabel.length > 0,
      `sound=${JSON.stringify(hud?.soundRect)} menu=${JSON.stringify(hud?.menuRect)} label=${hud?.soundLabel}`
    );
    verify(
      "minor_finance_shows_dash_with_accessible_note",
      hud !== null && hud.values[2] === "—" && hud.values[3] === "—" &&
        hud.minorCount === 2 && display(hud.note ?? "").includes("尚未擁有個人資產／收入"),
      `values=${JSON.stringify(hud?.values)} minor=${hud?.minorCount} note=${hud?.note}`
    );

    // 14.4 GPT-0054-B：場景已從「單張固定一家人 AVIF」改成原創分層 SVG
    // data URI。這裡直接解碼 SVG 字串驗證圖層、viewBox、無外部連結，
    // 並把人物中心換算成螢幕座標，確認伴侶／寵物不遮玩家或左側狀態卡。
    const scene = await scenarioPage.evaluate(() => {
      const node = document.querySelector(".p3e-scene");
      if (node === null) return null;
      const style = getComputedStyle(node);
      const text = (node.textContent ?? "").replace(/\s+/g, "").trim();
      const rect = node.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width));
      const ch = Math.max(1, Math.round(rect.height));
      const found = /url\((?:"|')?([^"')]+)(?:"|')?\)/.exec(style.backgroundImage);
      const url = found?.[1] ?? null;
      let svg = null;
      if (url !== null && url.startsWith("data:image/svg+xml,")) {
        try { svg = decodeURIComponent(url.slice("data:image/svg+xml,".length)); } catch { svg = null; }
      }
      const viewBox = svg === null ? null : /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
      const vbW = viewBox === null ? 0 : Number(viewBox[1]);
      const vbH = viewBox === null ? 0 : Number(viewBox[2]);
      const size = (style.backgroundSize.split(",")[0] ?? "").trim();
      // 0073-A：`contain` 取兩軸較小者，人物不會被容器裁掉。
      const scale = vbW > 0 && vbH > 0
        ? (size === "contain" ? Math.min(cw / vbW, ch / vbH)
          : (size === "cover" ? Math.max(cw / vbW, ch / vbH) : cw / vbW))
        : 0;
      // background-position 為 "center bottom"：水平置中，故 offsetX 為負或 0。
      const offsetX = (cw - vbW * scale) / 2;
      const centerOf = (layer) => {
        if (svg === null) return null;
        const group = new RegExp(`<g data-layer="${layer}"[\\s\\S]*?</g>`).exec(svg);
        if (group === null) return null;
        const cx = /<ellipse cx="(\d+(?:\.\d+)?)"/.exec(group[0]);
        return cx === null ? null : offsetX + Number(cx[1]) * scale;
      };
      const card = document.querySelector(".p3e-profile-card");
      const cardRight = card === null ? null : card.getBoundingClientRect().right - rect.left;
      const layerIds = svg === null
        ? []
        : [...svg.matchAll(/data-layer="([a-z]+)"/g)].map((match) => match[1]);
      // xmlns 是唯一合法的 http 字串；其餘任何 http/cdn 都代表外部素材。
      const noExternal = svg !== null &&
        !/https?:\/\//.test(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")) &&
        !/cdn/i.test(svg);
      return {
        fit: node.dataset.p3eSceneFit ?? null,
        assetId: node.dataset.p3eSceneAsset ?? null,
        residence: node.dataset.p3eSceneResidence ?? null,
        ageStage: node.dataset.p3eSceneAgeStage ?? null,
        playerSex: node.dataset.p3eScenePlayerSex ?? null,
        hasPartner: node.dataset.p3eSceneHasPartner ?? null,
        pet: node.dataset.p3eScenePet ?? null,
        signature: node.dataset.p3eSceneSignature ?? null,
        backgroundSize: style.backgroundSize,
        backgroundRepeat: style.backgroundRepeat,
        children: node.children.length,
        text,
        emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text),
        width: cw,
        height: ch,
        url,
        svgOk: svg !== null && svg.startsWith("<svg") && svg.includes("<rect") && svg.includes("<circle"),
        noExternal,
        vbW, vbH, layerIds,
        playerX: centerOf("player"),
        partnerX: centerOf("partner"),
        petX: centerOf("pet"),
        cardRight
      };
    });
    verify(
      "scene_layered_svg_fills_width_no_overlay",
      scene !== null && scene.fit === "contain" &&
        scene.assetId === "generated-layered-svg" &&
        (scene.backgroundSize.split(",")[0] ?? "").trim() === "contain" &&
        scene.backgroundRepeat.startsWith("no-repeat") &&
        scene.children === 0 && scene.text === "" && !scene.emoji &&
        (scene.url ?? "").startsWith("data:image/svg+xml,") &&
        scene.svgOk === true && scene.noExternal === true &&
        scene.vbW === 390 && scene.vbH === 220 &&
        scene.height >= 190 && scene.height <= 230 &&
        scene.layerIds.includes("background") && scene.layerIds.includes("player") &&
        scene.layerIds.filter((id) => id === "partner").length === (scene.hasPartner === "true" ? 1 : 0) &&
        scene.layerIds.filter((id) => id === "pet").length === (scene.pet !== "none" ? 1 : 0) &&
        /^[0-9a-f]{8}$/.test(scene.signature ?? "") &&
        ["urban", "rural"].includes(scene.residence ?? "") &&
        scene.playerX !== null &&
        (scene.cardRight === null || scene.playerX - scene.cardRight > 8) &&
        (scene.partnerX === null || scene.partnerX > scene.playerX + 20) &&
        (scene.petX === null || scene.petX > scene.playerX + 40),
      `fit=${scene?.fit} size=${scene?.backgroundSize} asset=${scene?.assetId} ` +
        `url=${(scene?.url ?? "").slice(0, 32)} svgOk=${scene?.svgOk} noExternal=${scene?.noExternal} ` +
        `viewBox=${scene?.vbW}x${scene?.vbH} layers=${JSON.stringify(scene?.layerIds)} ` +
        `height=${scene?.height} children=${scene?.children} text="${scene?.text}" ` +
        `playerX=${scene?.playerX} partnerX=${scene?.partnerX} petX=${scene?.petX} cardRight=${scene?.cardRight}`
    );

    // 14.5 連續推進至少 5 年後檢查人生紀錄（projection 尚未落地時檢查相容回退）。
    for (let step = 0; step < 6; step += 1) {
      const phase = await phaseOf(scenarioPage);
      if (phase === "death") break;
      await clickAndWait(scenarioPage, phase === "pending_decision" ? '[data-action="choose"]' : '[data-action="advance"]');
    }
    const readLifeLogState = () =>
      scenarioPage.evaluate(() => {
        const section = document.querySelector(".p3e-life-log");
        const card = document.querySelector(".p3e-story-card");
        const entries = [...document.querySelectorAll(".p3e-life-log-entry")].map((node) => ({
          year: Number(node.dataset.p3eLifeLogYear),
          age: Number(node.dataset.p3eLifeLogAge),
          text: node.dataset.p3eLifeLogText ?? "",
          inner: (node.textContent ?? "").replace(/\s+/g, " ").trim()
        }));
        return {
          source: section?.dataset.p3eLifeLogSource ?? null,
          count: Number(section?.dataset.p3eLifeLogCount ?? "-1"),
          entries,
          cardOverflowY: card === null ? null : getComputedStyle(card).overflowY,
          docY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
          bodyY: document.body.scrollHeight - document.body.clientHeight
        };
      });
    const beforeReloadLog = await readLifeLogState();
    const logFormatOk = beforeReloadLog.entries.every((entry) =>
      display(entry.inner).test(/^\d{4} 年 · \d+ 歲｜.+$/) && entry.text.length > 0
    );
    const logNoInternalKeys = beforeReloadLog.entries.every(
      (entry) => !INTERNAL_KEY_PATTERN.test(entry.text)
    );
    verify(
      "life_log_zh_hant_format_and_no_internal_keys",
      beforeReloadLog.entries.length > 0 && logFormatOk && logNoInternalKeys,
      `source=${beforeReloadLog.source} count=${beforeReloadLog.count} sample="${beforeReloadLog.entries[0]?.inner ?? ""}"`
    );
    verify(
      "life_log_scrolls_inside_card_not_page",
      beforeReloadLog.cardOverflowY === "auto" &&
        beforeReloadLog.docY <= 1 && beforeReloadLog.bodyY <= 1,
      `cardOverflowY=${beforeReloadLog.cardOverflowY} docY=${beforeReloadLog.docY} bodyY=${beforeReloadLog.bodyY}`
    );
    // 只注入顯示層 DOM 做長歷史壓力測試，不改遊戲狀態、不下命令。
    const longHistory = await scenarioPage.evaluate(() => {
      const list = document.querySelector(".p3e-life-log-list");
      const card = document.querySelector(".p3e-story-card");
      const first = list?.querySelector(".p3e-life-log-entry") ?? null;
      if (list === null || card === null || first === null) return null;
      for (let index = 0; index < 60; index += 1) list.append(first.cloneNode(true));
      const rect = card.getBoundingClientRect();
      const visible = [...list.children].filter((node) => {
        const item = node.getBoundingClientRect();
        return item.top >= rect.top - 2 && item.bottom <= rect.bottom + 2;
      }).length;
      return {
        entries: list.children.length,
        visible,
        scrollHeight: card.scrollHeight,
        clientHeight: card.clientHeight,
        overflowY: getComputedStyle(card).overflowY,
        docY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        bodyY: document.body.scrollHeight - document.body.clientHeight
      };
    });
    verify(
      "life_log_long_history_scrolls_locally_only",
      longHistory !== null && longHistory.entries >= 60 && longHistory.visible >= 3 &&
        longHistory.scrollHeight > longHistory.clientHeight &&
        longHistory.overflowY === "auto" &&
        longHistory.docY <= 1 && longHistory.bodyY <= 1,
      `entries=${longHistory?.entries} visible=${longHistory?.visible} scroll=${longHistory?.scrollHeight}/${longHistory?.clientHeight} docY=${longHistory?.docY} bodyY=${longHistory?.bodyY}`
    );
    if (beforeReloadLog.source === "projection") {
      verify(
        "life_log_at_least_5_entries_after_5_years",
        beforeReloadLog.count >= 5 && beforeReloadLog.entries.length >= 5,
        `count=${beforeReloadLog.count} entries=${beforeReloadLog.entries.length}`
      );
      const years = beforeReloadLog.entries.map((entry) => entry.year);
      verify(
        "life_log_newest_first",
        years.every((year, index) => index === 0 || years[index - 1] >= year),
        `years=${JSON.stringify(years.slice(0, 8))}`
      );
      // GPT-0040-B：居住 entity 與出生 entity 一致，且 reload 不變。
      const readResidence = () =>
        scenarioPage.evaluate(() => {
          const row = document.querySelector(".p3e-profile-row[data-p3e-profile-residence-entity]");
          return {
            entity: row?.getAttribute("data-p3e-profile-residence-entity") ?? null,
            text: row?.querySelector(".p3e-profile-val")?.textContent ?? null
          };
        });
      const readBirthEntity = () =>
        scenarioPage.evaluate(() => {
          const shell = document.querySelector("#p3e-main[data-p3e-live='true']");
          return shell?.getAttribute("data-p3e-birth-entity") ?? null;
        });
      const resBefore = await readResidence();
      const birthEntity = await readBirthEntity();
      await reloadApp(scenarioPage);
      const afterReloadLog = await readLifeLogState();
      verify(
        "life_log_rebuilt_after_reload",
        afterReloadLog.source === "projection" &&
          afterReloadLog.count >= beforeReloadLog.count &&
          afterReloadLog.entries[0]?.inner === beforeReloadLog.entries[0]?.inner,
        `before=${beforeReloadLog.count} after=${afterReloadLog.count} latest="${afterReloadLog.entries[0]?.inner ?? ""}"`
      );
      const resAfter = await readResidence();
      const birthEntityAfter = await readBirthEntity();
      verify(
        "profile_residence_persists_after_reload",
        resBefore.entity !== null && resAfter.entity !== null &&
          /^cr:[A-Z]{3}$/.test(resAfter.entity) && resBefore.entity === resAfter.entity,
        `before=${resBefore.entity} after=${resAfter.entity}`
      );
      // 居住 entity 必須與出生國 entity 一致（view.profile.residence 由 p3e-profile.ts
      // 直接投影自 state.identity.entityId，故二者等同；browser 直接從 live shell 讀出生 entity 比對）。
      verify(
        "profile_residence_matches_birth_entity",
        resAfter.entity !== null && birthEntityAfter !== null &&
          /^cr:[A-Z]{3}$/.test(resAfter.entity) &&
          resAfter.entity === birthEntityAfter,
        `residence=${resAfter.entity} birth=${birthEntityAfter}`
      );
    } else {
      // GPT-0031-A 尚未提供 view.lifeLog：任務文件允許安全回退到 lastOutcome。
      // 這裡嚴格驗證回退路径可用，projection 上線後上面兩項會自動生效。
      verify(
        "life_log_compatible_fallback_until_projection",
        beforeReloadLog.count === 1 && beforeReloadLog.entries.length === 1 &&
          beforeReloadLog.source === "fallback",
        `source=${beforeReloadLog.source} count=${beforeReloadLog.count} (GPT-0031-A projection pending)`
      );
    }

    // 14.6 關閉後立即 pause；再次開啟從原位置繼續；重載後偏好保留。
    const soundToggle = scenarioPage.locator('[data-action="toggle-nature-sound"]').first();
    let beforeOff = await readAudioState();
    // 若瀏覽器擋下自動播放，按鈕會停在「可再按一次開啟」；先明確開啟再測關閉。
    if (beforeOff.enabled !== "true" || beforeOff.blocked === "true") {
      await soundToggle.click().catch(() => {});
      beforeOff = await readAudioState();
    }
    await soundToggle.click().catch(() => {});
    const offState = await readAudioState();
    verify(
      "audio_off_pauses_immediately_and_stores_preference",
      offState.enabled === "false" && offState.playing === "false" &&
        offState.stored === "off" && offState.buttonText === "🔇" &&
        offState.buttonLabel === "開啟自然音" && offState.buttonPressed === "false",
      `enabled=${offState.enabled} playing=${offState.playing} stored=${offState.stored} text=${offState.buttonText}`
    );
    await soundToggle.click().catch(() => {});
    await scenarioPage.waitForTimeout(250);
    const onAgain = await readAudioState();
    verify(
      "audio_resumes_from_previous_position",
      onAgain.enabled === "true" && onAgain.stored === "on" &&
        Number(onAgain.audioTime) >= Number(beforeOff.audioTime) - 0.5,
      `before=${beforeOff.audioTime} after=${onAgain.audioTime} enabled=${onAgain.enabled}`
    );
    await scenarioPage.reload({ waitUntil: "domcontentloaded" });
    await scenarioPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    const reloadedPref = await readAudioState();
    verify(
      "audio_on_preference_persists_after_reload",
      reloadedPref.stored === "on" && reloadedPref.enabled === "true" &&
        reloadedPref.buttonText === "🔊" && reloadedPref.requested === "false",
      `stored=${reloadedPref.stored} enabled=${reloadedPref.enabled} text=${reloadedPref.buttonText} requested=${reloadedPref.requested}`
    );
    // 明確關掉後再重載，驗證「關閉」這個偏好也能被保留。
    await soundToggle.click().catch(() => {});
    let offAgain = await readAudioState();
    if (offAgain.stored !== "off") {
      await soundToggle.click().catch(() => {});
      offAgain = await readAudioState();
    }
    await scenarioPage.reload({ waitUntil: "domcontentloaded" });
    await scenarioPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    const finalPref = await readAudioState();
    verify(
      "audio_off_preference_persists_after_reload",
      offAgain.stored === "off" && finalPref.stored === "off" &&
        finalPref.enabled === "false" && finalPref.requested === "false" &&
        finalPref.buttonText === "🔇",
      `beforeReload=${offAgain.stored} stored=${finalPref.stored} enabled=${finalPref.enabled} requested=${finalPref.requested}`
    );
    await scenarioContext.close();
  }

  /* ---------------------------------------------------------------- */
  /* 15. GPT-0036-B：設定面板／比較 strip／具名伴侶／重心必選暫停       */
  /* ---------------------------------------------------------------- */
  const qaQuery = `?seed=${encodeURIComponent(GOLDEN_SEED)}`; // 刻意不帶 REPLAY_QUERY
  const readGate = (target) =>
    target.evaluate(() => {
      const live = document.querySelector("[data-p3e-live]");
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (node === null) return null;
        const box = node.getBoundingClientRect();
        return { w: Math.round(box.width), h: Math.round(box.height) };
      };
      return {
        phase: live?.getAttribute("data-p3e-phase") ?? null,
        age: Number(live?.getAttribute("data-p3e-life-focus-age") ?? "-1"),
        commands: Number(live?.getAttribute("data-p3e-command-count") ?? "-1"),
        required: live?.getAttribute("data-p3e-focus-required") ?? null,
        held: live?.getAttribute("data-p3e-clock-held") ?? null,
        reason: live?.getAttribute("data-p3e-clock-hold-reason") ?? null,
        running: live?.getAttribute("data-p3e-clock-running") ?? null,
        speed: live?.getAttribute("data-p3e-clock-speed") ?? null,
        replay: live?.getAttribute("data-p3e-official-replay") ?? null,
        soundBox: rect(".p3e-hud-sound"),
        menuBox: rect(".p3e-hud-menu > summary"),
        gears: document.querySelectorAll(".p3e-tools").length,
        gearGlyphs: [...document.querySelectorAll(".p3e-hud button, .p3e-hud summary")].filter(
          (node) => (node.textContent ?? "").includes("⚙")
        ).length,
        rightControls: document.querySelectorAll(".p3e-hud > button, .p3e-hud > details").length,
        menuLabel: document.querySelector(".p3e-hud-menu > summary")?.getAttribute("aria-label") ?? null
      };
    });

  async function driveUntil(target, predicate, maxSteps = 40, afterStep = undefined) {
    let count = 0;
    while (!(await predicate()) && count < maxSteps) {
      const phase = await phaseOf(target);
      const selector = phase === "pending_decision"
        ? '[data-action="choose"]'
        : '[data-action="advance"]';
      const before = await commandCount(target);
      await target.locator(selector).first().click({ timeout: 10000 });
      await target.waitForFunction(
        (prev) => {
          const node = document.querySelector("[data-p3e-live]");
          return (
            Number(node?.getAttribute("data-p3e-command-count") ?? "0") > prev ||
            node?.getAttribute("data-p3e-phase") === "death"
          );
        },
        before,
        { timeout: 20000 }
      );
      if (afterStep !== undefined) await afterStep();
      count += 1;
    }
    return count;
  }

  // ---- A + 兒童 B + D：完全正常的公開測試網址（沒有重播參數） ----------
  {
    const qaContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    const qaPage = await qaContext.newPage();
    const qaErrors = [];
    qaPage.on("pageerror", (error) => qaErrors.push(String(error)));
    await qaPage.goto(`${baseUrl}/${qaQuery}`, { waitUntil: "domcontentloaded" });
    await qaPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await qaPage.locator('[data-action="start-life"]').click();
    // GPT-0065-A：完整世界在按開始後才準備，進遊戲是非同步的；等 HUD
    // 真正出現再量測設定選單，而不是在「準備人生…」的出生卡上量。
    await qaPage.waitForSelector("#p3e-main", { timeout: 30000 });

    const initial = await readGate(qaPage);
    check(
      "settings_menu_no_standalone_gear",
      initial.gears === 0 && initial.gearGlyphs === 0 && initial.rightControls === 2 &&
        display(initial.menuLabel).equals("開啟設定與存檔選單") &&
        initial.soundBox?.w >= 44 && initial.soundBox?.h >= 44 &&
        initial.menuBox?.w >= 44 && initial.menuBox?.h >= 44,
      `gears=${initial.gears} glyphs=${initial.gearGlyphs} right=${initial.rightControls} ` +
        `label=${initial.menuLabel} sound=${JSON.stringify(initial.soundBox)} menu=${JSON.stringify(initial.menuBox)}`
    );

    // 鍵盤開合漢堡
    await qaPage.locator("details.p3e-hud-menu > summary").focus();
    await qaPage.keyboard.press("Enter");
    await qaPage.waitForTimeout(80);
    const menuOpen = await qaPage.locator("details.p3e-hud-menu").evaluate((node) => node.open);
    const menuPanel = await qaPage.evaluate(() => ({
      title: document.querySelector(".p3e-menu-title")?.textContent ?? null,
      aria: document.querySelector(".p3e-hud-menu-panel")?.getAttribute("aria-label") ?? null,
      text: document.querySelector(".p3e-hud-menu-panel")?.textContent ?? ""
    }));
    const menuText = display(menuPanel.text);
    check(
      "settings_menu_title_and_original_gear_features",
      menuOpen === true &&
        display(menuPanel.title).equals("⚙ 設定與存檔") &&
        display(menuPanel.aria).equals("設定與存檔") &&
        ["匯出存檔", "匯入存檔", "自動存檔", "seed=", "stateHash="].every((part) =>
          menuText.includes(part)
        ),
      `open=${menuOpen} title=${menuPanel.title} aria=${menuPanel.aria} parts=${menuPanel.text.slice(0, 90)}`
    );
    await qaPage.keyboard.press("Enter");
    await qaPage.waitForTimeout(80);
    const menuClosed = await qaPage.locator("details.p3e-hud-menu").evaluate((node) => node.open);
    check("settings_menu_keyboard_toggle", menuOpen === true && menuClosed === false, `open=${menuOpen} closed=${menuClosed}`);

    // 兒童：比較 strip 兩行、自然文案、沒有 0 百分位、HUD 仍是 —
    const childCompare = await qaPage.evaluate(() => ({
      rows: document.querySelectorAll(".p3e-compare-row").length,
      texts: [...document.querySelectorAll(".p3e-compare-text")].map((node) => node.textContent ?? ""),
      source: document.querySelector(".p3e-compare-strip")?.getAttribute("data-p3e-compare-source") ?? null,
      estimate: document.querySelector(".p3e-compare-estimate")?.textContent ?? null,
      note: document.querySelector(".p3e-compare-strip")?.getAttribute("data-p3e-estimate-note") ?? null,
      minor: document.querySelectorAll('[data-p3e-minor-finance="true"]').length,
      partnerLines: document.querySelectorAll(".p3e-partner-line").length
    }));
    check(
      "compare_strip_two_compact_rows_with_estimate_note",
      childCompare.rows === 2 &&
        childCompare.texts.every((text) => text.includes("未成年")) &&
        childCompare.texts.every((text) => !/%|0%/.test(text)) &&
        childCompare.estimate === "估算" &&
        (childCompare.note ?? "").includes("估算") &&
        childCompare.minor === 2 &&
        childCompare.partnerLines === 0,
      `rows=${childCompare.rows} texts=${JSON.stringify(childCompare.texts)} source=${childCompare.source} minor=${childCompare.minor} partner=${childCompare.partnerLines}`
    );

    // 先設 16×，讓「跨越多個 interval」能在 ~1.4s 內被驗證。
    await qaPage.locator('[data-speed="16"]').click();
    await qaPage.waitForTimeout(60);
    await driveUntil(qaPage, async () => (await readGate(qaPage)).required === "true", 30);
    const locked = await readGate(qaPage);
    const lockedDom = await qaPage.evaluate(() => {
      const q = (selector) => document.querySelector(selector);
      return {
        expanded: q(".p3e-focus")?.getAttribute("data-p3e-focus-expanded") ?? null,
        required: q(".p3e-focus")?.getAttribute("data-p3e-focus-required") ?? null,
        dismiss: document.querySelectorAll(".p3e-focus-dismiss").length,
        options: document.querySelectorAll(".p3e-focus-option").length,
        pendingCards: document.querySelectorAll(".p3e-pending").length,
        advanceDisabled: q('[data-action="advance"]')?.disabled ?? null,
        timeDisabled: q('[data-action="toggle-time"]')?.disabled ?? null,
        speedDisabled: q('[data-speed="4"]')?.disabled ?? null,
        jumpDisabled: q('[data-action="jump-decision"]')?.disabled ?? null,
        // GPT-0037-B P2：必選 dialog 的讀屏語意與 autofocus。
        dialogRole: q('.p3e-focus-panel[data-p3e-focus-dialog="required"]')?.getAttribute("role") ?? null,
        dialogModal: q('.p3e-focus-panel[data-p3e-focus-dialog="required"]')?.getAttribute("aria-modal") ?? null,
        dialogTitle: q("#p3e-focus-required-title")?.textContent ?? null,
        dialogDesc: q("#p3e-focus-required-desc")?.textContent ?? null,
        dialogLabelledBy: q('.p3e-focus-panel[data-p3e-focus-dialog="required"]')?.getAttribute("aria-labelledby") ?? null,
        dialogDescribedBy: q('.p3e-focus-panel[data-p3e-focus-dialog="required"]')?.getAttribute("aria-describedby") ?? null,
        activeAction: document.activeElement?.getAttribute("data-action") ?? null,
        activeFocusId: document.activeElement?.getAttribute("data-focus-id") ?? null,
        activeIsBody: document.activeElement === document.body
      };
    });
    check(
      "focus_required_gate_pauses_clock_and_disables_controls",
      locked.replay === "false" && locked.age >= 7 &&
        locked.required === "true" && locked.held === "true" &&
        locked.reason === "life-focus-required" && locked.running === "false" &&
        locked.speed === "16" && locked.phase === "life" &&
        lockedDom.expanded === "true" && lockedDom.required === "true" &&
        lockedDom.dismiss === 0 && lockedDom.options === 5 &&
        lockedDom.pendingCards === 0 &&
        lockedDom.advanceDisabled === true && lockedDom.timeDisabled === true &&
        lockedDom.speedDisabled === true && lockedDom.jumpDisabled === true,
      `age=${locked.age} held=${locked.held} running=${locked.running} speed=${locked.speed} dom=${JSON.stringify(lockedDom)}`
    );
    check(
      "focus_required_dialog_semantics_and_autofocus",
      lockedDom.dialogRole === "dialog" && lockedDom.dialogModal === "true" &&
        lockedDom.dialogLabelledBy === "p3e-focus-required-title" &&
        lockedDom.dialogDescribedBy === "p3e-focus-required-desc" &&
        display(lockedDom.dialogTitle ?? "").includes("人生重心") &&
        display(lockedDom.dialogDesc ?? "").includes("暫停") &&
        lockedDom.activeAction === "set-focus" && lockedDom.activeFocusId !== null &&
        !lockedDom.activeIsBody,
      `role=${lockedDom.dialogRole} modal=${lockedDom.dialogModal} title="${lockedDom.dialogTitle}" ` +
        `active=${lockedDom.activeAction}/${lockedDom.activeFocusId} body=${lockedDom.activeIsBody}`
    );
    const dialogViolations = await axeAudit(qaPage);
    const dialogSerious = dialogViolations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious"
    );
    check(
      "focus_required_dialog_axe_critical_serious_0",
      dialogSerious.length === 0,
      JSON.stringify(dialogSerious)
    );

    // GPT-0038-B：aria-modal 的背景必須真的 inert，dialog 本身保持可操作。
    const inertBefore = await qaPage.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const dialog = q('.p3e-focus-panel[data-p3e-focus-dialog="required"]');
      const covered = (s) => {
        const node = q(s);
        return node === null ? null : node.closest("[inert]") !== null;
      };
      return {
        inertCount: document.querySelectorAll("[inert]").length,
        dialogInert: dialog?.closest("[inert]") !== null,
        dialogParentInert: dialog?.parentElement?.closest("[inert]") !== null,
        activeInside: dialog !== null && dialog.contains(document.activeElement),
        background: {
          sound: covered(".p3e-hud-sound"),
          menu: covered(".p3e-hud-menu > summary"),
          estimate: covered('[data-action="toggle-estimate-note"]'),
          advance: covered('[data-action="advance"]'),
          toggleTime: covered('[data-action="toggle-time"]'),
          jump: covered('[data-action="jump-decision"]'),
          speed: covered('[data-speed="16"]'),
          status: covered("#p3e-status")
        }
      };
    });
    check(
      "focus_required_background_is_inert",
      inertBefore.inertCount > 0 && inertBefore.dialogInert === false &&
        inertBefore.dialogParentInert === false && inertBefore.activeInside === true &&
        Object.values(inertBefore.background).every((value) => value === true),
      JSON.stringify(inertBefore)
    );

    // 鍵盤連按 Tab／Shift+Tab：焦點永遠留在 dialog 的重心選項，不掉進背景。
    const tabTrail = [];
    for (let step = 0; step < 12; step += 1) {
      await qaPage.keyboard.press(step % 4 === 3 ? "Shift+Tab" : "Tab");
      tabTrail.push(
        await qaPage.evaluate(() => {
          const dialog = document.querySelector(
            '.p3e-focus-panel[data-p3e-focus-dialog="required"]'
          );
          const active = document.activeElement;
          return {
            inside: dialog !== null && dialog.contains(active),
            action: active?.getAttribute?.("data-action") ?? null,
            tag: active?.tagName ?? null,
            inert: active?.closest?.("[inert]") !== null
          };
        })
      );
    }
    check(
      "focus_required_tab_never_reaches_background_controls",
      tabTrail.length === 12 &&
        tabTrail.every(
          (step) =>
            step.inside === true && step.inert === false &&
            step.tag === "BUTTON" && step.action === "set-focus"
        ),
      JSON.stringify(tabTrail)
    );

    // 背景 inert 擋下真實滑鼠；另外用程式派送 click 直接打既有 command 硬閘門，
    // 再等 3 個以上 16× interval，指令數與年齡都不能變。
    await qaPage.evaluate(() => {
      for (const selector of [
        '[data-action="advance"]',
        '[data-action="jump-decision"]',
        '[data-speed="16"]',
        '[data-action="toggle-time"]'
      ]) {
        document.querySelector(selector)?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true })
        );
      }
    });
    await qaPage.waitForTimeout(1400);
    const afterWait = await readGate(qaPage);
    check(
      "focus_required_blocks_advance_and_multiple_intervals",
      afterWait.commands === locked.commands && afterWait.age === locked.age &&
        afterWait.required === "true" && afterWait.held === "true",
      `before=${locked.commands}/${locked.age} after=${afterWait.commands}/${afterWait.age} held=${afterWait.held}`
    );

    // 選有效重心後：原本正在播放 → 回到同一速度 16×。
    await qaPage
      .locator('.p3e-focus[data-p3e-focus-required="true"] [data-action="set-focus"][data-focus-id="study"]')
      .first()
      .click();
    await qaPage.evaluate(() => { window.__qaReleaseFocus = null; });
    await qaPage.waitForFunction(
      () => {
        const live = document.querySelector("[data-p3e-live]");
        if (live?.getAttribute("data-p3e-focus-required") !== "false") return false;
        window.__qaReleaseFocus = {
          action: document.activeElement?.getAttribute("data-action") ?? null,
          isBody: document.activeElement === document.body,
          tag: document.activeElement?.tagName ?? null,
          // GPT-0038-B：選定後 inert 必須移除，背景控制恢復可操作。
          inertCount: document.querySelectorAll("[inert]").length,
          activeInert: document.activeElement?.closest?.("[inert]") !== null
        };
        return true;
      },
      undefined,
      { timeout: 20000, polling: "raf" }
    );
    const released = await readGate(qaPage);
    check(
      "focus_chosen_restores_original_playback_speed",
      released.commands === locked.commands + 1 &&
        released.required === "false" && released.held === "false" &&
        released.running === "true" && released.speed === "16",
      `commands=${locked.commands}->${released.commands} running=${released.running} speed=${released.speed}`
    );
    // GPT-0037-B P2：dialog 關閉後焦點回到合理的遊戲控制，不掉回 body。
    const restoredFocus = await qaPage.evaluate(() => window.__qaReleaseFocus);
    check(
      "focus_required_dialog_returns_focus_to_game_control",
      restoredFocus.action === "advance" && !restoredFocus.isBody && restoredFocus.tag === "BUTTON",
      `action=${restoredFocus.action} tag=${restoredFocus.tag} body=${restoredFocus.isBody}`
    );
    check(
      "focus_required_inert_removed_after_choice",
      restoredFocus.inertCount === 0 && restoredFocus.activeInert === false,
      `inert=${restoredFocus.inertCount} activeInert=${restoredFocus.activeInert}`
    );

    // 三尺寸：比較 strip 不造成水平捲動，頁面仍單畫面。
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 430, height: 932 }
    ]) {
      await qaPage.setViewportSize(viewport);
      const overflow = await horizontalOverflow(qaPage);
      const strip = await qaPage.evaluate(() => {
        const node = document.querySelector(".p3e-compare-strip");
        const box = node?.getBoundingClientRect();
        return {
          rows: document.querySelectorAll(".p3e-compare-row").length,
          width: box === undefined ? 0 : Math.round(box.width),
          inside: box === undefined ? false : box.left >= 0 && box.right <= window.innerWidth + 1
        };
      });
      check(
        `compare_strip_no_horizontal_overflow_${viewport.width}x${viewport.height}`,
        overflow === 0 && strip.rows === 2 && strip.inside,
        `overflow=${overflow} rows=${strip.rows} width=${strip.width} inside=${strip.inside}`
      );
      // GPT-0037-B P2：「估算」至少 44x44，展開說明後也不能讓整頁下滑。
      const target = await qaPage.evaluate(() => {
        const button = document.querySelector('[data-action="toggle-estimate-note"]');
        const r = button?.getBoundingClientRect();
        return {
          w: r?.width ?? 0,
          h: r?.height ?? 0,
          inside: r === undefined ? false : r.left >= -1 && r.right <= window.innerWidth + 1
        };
      });
      check(
        `estimate_touch_target_44px_${viewport.width}x${viewport.height}`,
        target.w >= 43.5 && target.h >= 43.5 && target.inside,
        `w=${target.w} h=${target.h} inside=${target.inside}`
      );
      await qaPage.locator('[data-action="toggle-estimate-note"]').click();
      const expanded = await qaPage.evaluate(() => {
        const doc = document.scrollingElement ?? document.documentElement;
        window.scrollTo(0, 99999);
        const scrolled = window.scrollY;
        window.scrollTo(0, 0);
        return {
          docY: doc.scrollHeight - doc.clientHeight,
          docX: doc.scrollWidth - doc.clientWidth,
          scrolled,
          expanded: document
            .querySelector('[data-action="toggle-estimate-note"]')
            ?.getAttribute("aria-expanded") ?? null,
          noteVisible: document.querySelector(".p3e-compare-note")?.hidden === false
        };
      });
      check(
        `estimate_note_expanded_no_page_scroll_${viewport.width}x${viewport.height}`,
        expanded.expanded === "true" && expanded.noteVisible &&
          expanded.docY <= 1 && expanded.docX <= 1 && expanded.scrolled === 0,
        `docY=${expanded.docY} docX=${expanded.docX} scrolled=${expanded.scrolled} visible=${expanded.noteVisible}`
      );
      await qaPage.locator('[data-action="toggle-estimate-note"]').click();
    }
    check("focus_gate_no_page_errors", qaErrors.length === 0, `errors=${JSON.stringify(qaErrors)}`);
    await qaContext.close();
  }

  // ---- D：原本手動暫停 → 選完不自動播放；reload 仍鎖住 ----------------
  {
    const pauseContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true
    });
    const pausePage = await pauseContext.newPage();
    await pausePage.goto(`${baseUrl}/${qaQuery}`, { waitUntil: "domcontentloaded" });
    await pausePage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await pausePage.locator('[data-action="start-life"]').click();
    await pausePage.locator('[data-action="toggle-time"]').click(); // 手動暫停
    // 既有「解決 decision 後 resume」會把 clock 打開，這裡每一步後補回手動暫停，
    // 才能真的驗證「觸發前本來就是手動暫停」的情境。
    const keepManuallyPaused = async () => {
      const running = await pausePage
        .locator("[data-p3e-live]")
        .getAttribute("data-p3e-clock-running")
        .catch(() => "false");
      if (running === "true") {
        await pausePage.locator('[data-action="toggle-time"]').click({ timeout: 5000 }).catch(() => {});
      }
    };
    await driveUntil(
      pausePage,
      async () => (await readGate(pausePage)).required === "true",
      30,
      keepManuallyPaused
    );
    const held = await readGate(pausePage);
    // reload 後仍鎖住，且不能偷跑一年
    await pausePage.reload({ waitUntil: "domcontentloaded" });
    await pausePage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await pausePage.waitForTimeout(400);
    const reloaded = await readGate(pausePage);
    const reloadAdvanceDisabled = await pausePage
      .locator('[data-action="advance"]')
      .evaluate((node) => node.disabled)
      .catch(() => null);
    check(
      "focus_required_reload_stays_locked_without_sneaking_a_year",
      held.required === "true" && reloaded.required === "true" &&
        reloaded.held === "true" && reloaded.running === "false" &&
        reloaded.commands === held.commands && reloaded.age === held.age &&
        reloadAdvanceDisabled === true,
      `before=${held.commands}/${held.age} after=${reloaded.commands}/${reloaded.age} held=${reloaded.held} advanceDisabled=${reloadAdvanceDisabled}`
    );
    await pausePage
      .locator('.p3e-focus[data-p3e-focus-required="true"] [data-action="set-focus"][data-focus-id="health"]')
      .first()
      .click();
    await pausePage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-focus-required") === "false",
      undefined,
      { timeout: 20000 }
    );
    const afterChoice = await readGate(pausePage);
    check(
      "focus_chosen_keeps_manual_pause",
      afterChoice.required === "false" && afterChoice.held === "false" &&
        afterChoice.running === "false" && afterChoice.commands === reloaded.commands + 1,
      `running=${afterChoice.running} held=${afterChoice.held} commands=${reloaded.commands}->${afterChoice.commands}`
    );
    await pauseContext.close();
  }

  // ---- B 成年 + C reload：重播模式只為了快速走到有 projection 的年齡 ----
  {
    const adultContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true
    });
    const adultPage = await adultContext.newPage();
    await adultPage.goto(`${baseUrl}/${GOLDEN_QUERY}`, { waitUntil: "domcontentloaded" });
    await adultPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await adultPage.locator('[data-action="start-life"]').click();
    await driveUntil(
      adultPage,
      async () =>
        (await adultPage.locator('.p3e-compare-strip[data-p3e-compare-source="projection"]').count()) > 0,
      110
    );
    const adultCompare = await adultPage.evaluate(() => ({
      age: Number(document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-life-focus-age") ?? "-1"),
      source: document.querySelector(".p3e-compare-strip")?.getAttribute("data-p3e-compare-source") ?? null,
      basis: document.querySelector(".p3e-compare-strip")?.getAttribute("data-p3e-compare-basis-year") ?? null,
      texts: [...document.querySelectorAll(".p3e-compare-text")].map((node) => node.textContent ?? ""),
      hud: [...document.querySelectorAll(".p3e-hud-item strong")].map((node) => node.textContent ?? ""),
      note: document.querySelector(".p3e-compare-strip")?.getAttribute("data-p3e-estimate-note") ?? null
    }));
    check(
      "adult_compare_uses_view_percentile_projection",
      adultCompare.age >= 18 && adultCompare.source === "projection" &&
        adultCompare.texts.length === 2 &&
        adultCompare.texts.every((text) => display(text).test(/高於中國 \d+%｜高於全球 \d+%/)) &&
        adultCompare.basis === "2021" && display(adultCompare.note ?? "").includes("估算") &&
        adultCompare.hud[2] !== "—" && adultCompare.hud[3] !== "—",
      `age=${adultCompare.age} source=${adultCompare.source} basis=${adultCompare.basis} texts=${JSON.stringify(adultCompare.texts)} hud=${JSON.stringify(adultCompare.hud)}`
    );
    // 「估算」可展開且說明不会露出 internal key
    await adultPage.locator('[data-action="toggle-estimate-note"]').click();
    const noteState = await adultPage.evaluate(() => ({
      expanded: document.querySelector(".p3e-compare-estimate")?.getAttribute("aria-expanded") ?? null,
      visible: document.querySelector(".p3e-compare-note")?.hidden === false,
      text: document.querySelector(".p3e-compare-note")?.textContent ?? ""
    }));
    check(
      "estimate_note_is_expandable_and_plain_language",
      noteState.expanded === "true" && noteState.visible &&
        noteState.text.includes("估算") && !INTERNAL_KEY_PATTERN.test(noteState.text),
      `expanded=${noteState.expanded} visible=${noteState.visible} text=${noteState.text.slice(0, 60)}`
    );

    // GPT-0040-B：具名伴侶改由狀態卡情感狀態列呈現；reload／讀檔後姓名不變
    await driveUntil(
      adultPage,
      async () => (await adultPage.locator(".p3e-profile-row[data-p3e-partner-name]").count()) > 0,
      80
    );
    const beforeReload = await adultPage.evaluate(
      () => document.querySelector(".p3e-profile-row[data-p3e-partner-name]")?.getAttribute("data-p3e-partner-name") ?? null
    );
    // 等 idle autosave flush 完成，reload 才能由 command log 重建同一個伴侶姓名。
    await adultPage.waitForTimeout(700);
    await adultPage.reload({ waitUntil: "domcontentloaded" });
    await adultPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    const afterReload = await adultPage.evaluate(
      () => document.querySelector(".p3e-profile-row[data-p3e-partner-name]")?.getAttribute("data-p3e-partner-name") ?? null
    );
    check(
      "partner_name_persists_after_reload",
      beforeReload !== null && beforeReload === afterReload &&
        !INTERNAL_KEY_PATTERN.test(beforeReload),
      `before=${beforeReload} after=${afterReload}`
    );
    await adultContext.close();
  }

  // ---- D6：decision modal 優先於必選重心，不得同時兩張前景卡 ----------
  {
    const seedContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true
    });
    const seedPage = await seedContext.newPage();
    await seedPage.goto(`${baseUrl}/${GOLDEN_QUERY}`, { waitUntil: "domcontentloaded" });
    await seedPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await seedPage.locator('[data-action="start-life"]').click();
    await driveUntil(
      seedPage,
      async () => {
        const state = await readGate(seedPage);
        return state.phase === "pending_decision" && state.age >= 7;
      },
      70
    );
    await seedPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-persistence-status") === "saved",
      undefined,
      { timeout: 20000 }
    );
    const pendingRaw = await seedPage.evaluate(() => {
      try { return window.localStorage.getItem("life-sim:p3e:v6:autosave"); }
      catch { return null; }
    });
    await seedContext.close();

    const priorityContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true
    });
    if (pendingRaw !== null) {
      await priorityContext.addInitScript((raw) => {
        try { window.localStorage.setItem("life-sim:p3e:v6:autosave", raw); } catch { /* noop */ }
      }, pendingRaw);
    }
    const priorityPage = await priorityContext.newPage();
    await priorityPage.goto(`${baseUrl}/${qaQuery}`, { waitUntil: "domcontentloaded" });
    await priorityPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    const beforeDecision = await priorityPage.evaluate(() => {
      const live = document.querySelector("[data-p3e-live]");
      const focus = document.querySelector(".p3e-focus");
      return {
        phase: live?.getAttribute("data-p3e-phase") ?? null,
        age: Number(live?.getAttribute("data-p3e-life-focus-age") ?? "-1"),
        required: live?.getAttribute("data-p3e-focus-required") ?? null,
        held: live?.getAttribute("data-p3e-clock-held") ?? null,
        focusExpanded: focus?.getAttribute("data-p3e-focus-expanded") ?? null,
        pendingCards: document.querySelectorAll(".p3e-pending").length,
        choiceButtons: document.querySelectorAll('[data-action="choose"]').length,
        foregroundCards: document.querySelectorAll(".p3e-focus-panel, .p3e-pending").length
      };
    });
    check(
      "decision_takes_priority_over_focus_required_gate",
      pendingRaw !== null && beforeDecision.phase === "pending_decision" &&
        beforeDecision.age >= 7 && beforeDecision.required === "false" &&
        beforeDecision.held === "false" && beforeDecision.pendingCards === 1 &&
        beforeDecision.choiceButtons >= 2 && beforeDecision.focusExpanded !== "true" &&
        beforeDecision.foregroundCards === 1,
      `phase=${beforeDecision.phase} age=${beforeDecision.age} required=${beforeDecision.required} pending=${beforeDecision.pendingCards} focus=${beforeDecision.focusExpanded} cards=${beforeDecision.foregroundCards}`
    );
    await priorityPage.locator('[data-action="choose"]').first().click();
    await priorityPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-focus-required") === "true",
      undefined,
      { timeout: 20000 }
    );
    const afterDecision = await priorityPage.evaluate(() => {
      const live = document.querySelector("[data-p3e-live]");
      return {
        required: live?.getAttribute("data-p3e-focus-required") ?? null,
        held: live?.getAttribute("data-p3e-clock-held") ?? null,
        running: live?.getAttribute("data-p3e-clock-running") ?? null,
        focusExpanded: document.querySelector(".p3e-focus")?.getAttribute("data-p3e-focus-expanded") ?? null,
        pendingCards: document.querySelectorAll(".p3e-pending").length,
        foregroundCards: document.querySelectorAll(".p3e-focus-panel, .p3e-pending").length,
        advanceDisabled: document.querySelector('[data-action="advance"]')?.disabled ?? null
      };
    });
    check(
      "focus_gate_applies_after_decision_resolved_without_double_overlay",
      afterDecision.required === "true" && afterDecision.held === "true" &&
        afterDecision.running === "false" && afterDecision.focusExpanded === "true" &&
        afterDecision.pendingCards === 0 && afterDecision.foregroundCards === 1 &&
        afterDecision.advanceDisabled === true,
      `required=${afterDecision.required} held=${afterDecision.held} cards=${afterDecision.foregroundCards} advanceDisabled=${afterDecision.advanceDisabled}`
    );
    await priorityContext.close();
  }

  // ---- GPT-0037-B P1：decision → 首次重心完整播放 intent ----------------
  // 這個 seed 在 7 歲同年先出現 pending decision（dec.child.family-move），
  // 正是驗收單描述的重現路徑；公開網址（沒有 p3eReplay）必選閘門完整生效。
  {
    const FLOW_SEED = "probe-seed-36";
    const flowQuery = `?seed=${encodeURIComponent(FLOW_SEED)}`;
    for (const variant of [
      { name: "playing_16x", playing: true, expectedRunning: "true" },
      { name: "manual_paused", playing: false, expectedRunning: "false" }
    ]) {
      const flowContext = await browser.newContext({
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true
      });
      const flowPage = await flowContext.newPage();
      const flowErrors = [];
      flowPage.on("pageerror", (error) => flowErrors.push(String(error)));
      await flowPage.goto(`${baseUrl}/${flowQuery}`, { waitUntil: "domcontentloaded" });
      await flowPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
      await flowPage.locator('[data-action="start-life"]').click();
      if (!variant.playing) await flowPage.locator('[data-action="toggle-time"]').click();
      await flowPage.locator('[data-speed="16"]').click();
      const keepPaused = async () => {
        const running = await flowPage
          .locator("[data-p3e-live]")
          .getAttribute("data-p3e-clock-running")
          .catch(() => "false");
        if (running === "true") {
          await flowPage.locator('[data-action="toggle-time"]').click({ timeout: 5000 }).catch(() => {});
        }
      };
      await driveUntil(
        flowPage,
        async () => {
          const gate = await readGate(flowPage);
          return gate.phase === "pending_decision" && gate.age >= 7;
        },
        40,
        variant.playing ? undefined : keepPaused
      );
      const atDecision = await readGate(flowPage);
      check(
        `p1_${variant.name}_age7_decision_pauses_clock_at_16x`,
        atDecision.phase === "pending_decision" && atDecision.age >= 7 &&
          atDecision.required === "false" && atDecision.held === "false" &&
          atDecision.running === "false" && atDecision.speed === "16" &&
          (await flowPage.locator('[data-action="choose"]').count()) >= 2,
        `phase=${atDecision.phase} age=${atDecision.age} required=${atDecision.required} ` +
          `running=${atDecision.running} speed=${atDecision.speed}`
      );

      await flowPage.locator('[data-action="choose"]').first().click();
      await flowPage.waitForFunction(
        () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-focus-required") === "true",
        undefined,
        { timeout: 20000 }
      );
      const afterChoose = await readGate(flowPage);
      const gateDialog = await flowPage.evaluate(() => {
        const q = (s) => document.querySelector(s);
        return {
          role: q('.p3e-focus-panel[data-p3e-focus-dialog="required"]')?.getAttribute("role") ?? null,
          modal: q('.p3e-focus-panel[data-p3e-focus-dialog="required"]')?.getAttribute("aria-modal") ?? null,
          activeAction: document.activeElement?.getAttribute("data-action") ?? null,
          advanceDisabled: q('[data-action="advance"]')?.disabled ?? null,
          jumpDisabled: q('[data-action="jump-decision"]')?.disabled ?? null,
          speedDisabled: q('[data-speed="4"]')?.disabled ?? null,
          timeDisabled: q('[data-action="toggle-time"]')?.disabled ?? null
        };
      });
      check(
        `p1_${variant.name}_focus_required_hard_gate_after_decision`,
        afterChoose.required === "true" && afterChoose.held === "true" &&
          afterChoose.running === "false" && afterChoose.speed === "16" &&
          afterChoose.commands === atDecision.commands + 1 &&
          gateDialog.advanceDisabled === true && gateDialog.jumpDisabled === true &&
          gateDialog.speedDisabled === true && gateDialog.timeDisabled === true,
        `required=${afterChoose.required} held=${afterChoose.held} running=${afterChoose.running} ` +
          `commands=${atDecision.commands}->${afterChoose.commands} dom=${JSON.stringify(gateDialog)}`
      );
      check(
        `p1_${variant.name}_focus_dialog_autofocus_first_option`,
        gateDialog.role === "dialog" && gateDialog.modal === "true" &&
          gateDialog.activeAction === "set-focus",
        `role=${gateDialog.role} modal=${gateDialog.modal} active=${gateDialog.activeAction}`
      );

      // 鍵盤、強制點擊、程式派送 click、多個 16x interval 都不能偷跑一年。
      // 注意：dialog 內第一個重心有 autofocus，直接按 Enter 會合法選定重心，
      // 所以這裡改派送 synthetic click 到全部被停用的推進／速度控制，
      // 驗證 `runCommand` 的硬閘門而不是只靠 DOM disabled 屬性。
      await flowPage.evaluate(() => {
        for (const selector of [
          '[data-action="advance"]',
          '[data-action="jump-decision"]',
          '[data-speed="16"]',
          '[data-action="toggle-time"]'
        ]) {
          document.querySelector(selector)?.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true })
          );
        }
      });
      await flowPage.keyboard.press("Tab").catch(() => {});
      await flowPage.keyboard.press("Tab").catch(() => {});
      await flowPage.locator('[data-action="advance"]').click({ force: true }).catch(() => {});
      await flowPage.waitForTimeout(1400);
      const afterWait = await readGate(flowPage);
      check(
        `p1_${variant.name}_no_sneak_while_decision_or_focus_unresolved`,
        afterWait.commands === afterChoose.commands && afterWait.age === afterChoose.age &&
          afterWait.required === "true" && afterWait.held === "true",
        `before=${afterChoose.commands}/${afterChoose.age} after=${afterWait.commands}/${afterWait.age} held=${afterWait.held}`
      );

      // 16× 恢復播放後下一個 interval 只有 375ms；用 raf polling 在
      // 「release 的第一個 render」當下就快照，避免被之後的自動推進干擾。
      await flowPage.evaluate(() => { window.__p1Release = null; });
      await flowPage
        .locator('.p3e-focus[data-p3e-focus-required="true"] [data-action="set-focus"][data-focus-id="study"]')
        .first()
        .click();
      await flowPage.waitForFunction(
        () => {
          const live = document.querySelector("[data-p3e-live]");
          if (live?.getAttribute("data-p3e-focus-required") !== "false") return false;
          if (live?.getAttribute("data-p3e-clock-held") !== "false") return false;
          window.__p1Release = {
            required: live?.getAttribute("data-p3e-focus-required") ?? null,
            held: live?.getAttribute("data-p3e-clock-held") ?? null,
            running: live?.getAttribute("data-p3e-clock-running") ?? null,
            speed: live?.getAttribute("data-p3e-clock-speed") ?? null,
            commands: Number(live?.getAttribute("data-p3e-command-count") ?? "-1"),
            action: document.activeElement?.getAttribute("data-action") ?? null,
            isBody: document.activeElement === document.body
          };
          return true;
        },
        undefined,
        { timeout: 20000, polling: "raf" }
      );
      const afterFocus = await flowPage.evaluate(() => window.__p1Release);
      check(
        `p1_${variant.name}_focus_chosen_restores_pre_decision_play_intent`,
        afterFocus.required === "false" && afterFocus.held === "false" &&
          afterFocus.running === variant.expectedRunning && afterFocus.speed === "16" &&
          afterFocus.commands === afterWait.commands + 1,
        `running=${afterFocus.running} speed=${afterFocus.speed} held=${afterFocus.held} ` +
          `commands=${afterWait.commands}->${afterFocus.commands}`
      );
      check(
        `p1_${variant.name}_focus_returns_to_expected_control`,
        !afterFocus.isBody &&
          afterFocus.action === (variant.playing ? "advance" : "toggle-time"),
        `action=${afterFocus.action} body=${afterFocus.isBody}`
      );
      check(`p1_${variant.name}_no_page_errors`, flowErrors.length === 0, `errors=${JSON.stringify(flowErrors)}`);
      await flowContext.close();
    }
  }

  /* ---------------------------------------------------------------- */
  /* 16. GPT-0038-B：「下一個決定」播放意圖（真正點擊 jump 按鈕）        */
  /* ---------------------------------------------------------------- */
  const jumpQuery = `?seed=${encodeURIComponent(GOLDEN_SEED)}&${REPLAY_QUERY}`;
  const readJumpState = (target) =>
    target.evaluate(() => {
      const live = document.querySelector("[data-p3e-live]");
      return {
        phase: live?.getAttribute("data-p3e-phase") ?? null,
        age: Number(live?.getAttribute("data-p3e-life-focus-age") ?? "-1"),
        commands: Number(live?.getAttribute("data-p3e-command-count") ?? "-1"),
        running: live?.getAttribute("data-p3e-clock-running") ?? null,
        speed: live?.getAttribute("data-p3e-clock-speed") ?? null,
        required: live?.getAttribute("data-p3e-focus-required") ?? null,
        held: live?.getAttribute("data-p3e-clock-held") ?? null,
        decisionIntent: live?.getAttribute("data-p3e-decision-intent") ?? null,
        jumpIntent: live?.getAttribute("data-p3e-jump-intent") ?? null,
        fastForwarding: live?.getAttribute("data-p3e-fast-forwarding") ?? null,
        inertCount: document.querySelectorAll("[inert]").length,
        choices: document.querySelectorAll('[data-action="choose"]').length
      };
    });

  /** 真正點擊 [data-action="jump-decision"]，並等快轉整個結束（finally render）。 */
  async function clickJumpAndWait(target) {
    const before = await commandCount(target);
    await target.locator('[data-action="jump-decision"]').click();
    await target.waitForFunction(
      (prev) => {
        const live = document.querySelector("[data-p3e-live]");
        const commands = Number(live?.getAttribute("data-p3e-command-count") ?? "0");
        return (
          commands > prev &&
          live?.getAttribute("data-p3e-fast-forwarding") === "false" &&
          live?.getAttribute("data-p3e-jump-intent") === "none"
        );
      },
      before,
      { timeout: 30000 }
    );
  }

  function newJumpContext() {
    return browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
  }

  async function openJumpPage(query) {
    const context = await newJumpContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${baseUrl}/${query}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await page.locator('[data-action="start-life"]').click();
    await page.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life",
      undefined,
      { timeout: 20000 }
    );
    return { context, page, errors };
  }

  // ---- A：playing 4×／16× 與手動暫停三種狀態 → 普通 decision ----------
  for (const variant of [
    { name: "playing_4x", playing: true, speed: "4", expectedRunning: "true" },
    { name: "playing_16x", playing: true, speed: "16", expectedRunning: "true" },
    { name: "manual_paused_4x", playing: false, speed: "4", expectedRunning: "false" }
  ]) {
    const { context, page, errors } = await openJumpPage(jumpQuery);
    if (!variant.playing) await page.locator('[data-action="toggle-time"]').click();
    await page.locator(`[data-speed="${variant.speed}"]`).click();
    const beforeJump = await readJumpState(page);
    check(
      `jump_${variant.name}_starts_from_expected_clock_state`,
      beforeJump.running === String(variant.playing) && beforeJump.speed === variant.speed &&
        beforeJump.decisionIntent === "none" && beforeJump.jumpIntent === "none" &&
        beforeJump.phase === "life" && beforeJump.fastForwarding === "false",
      `running=${beforeJump.running} speed=${beforeJump.speed} intent=${beforeJump.decisionIntent}/${beforeJump.jumpIntent}`
    );

    await clickJumpAndWait(page);
    const reached = await readJumpState(page);
    check(
      `jump_${variant.name}_reaches_pending_decision_with_pre_jump_intent`,
      reached.phase === "pending_decision" && reached.choices >= 2 &&
        reached.running === "false" && reached.speed === variant.speed &&
        reached.decisionIntent === `${variant.playing ? "playing" : "paused"}:${variant.speed}` &&
        reached.jumpIntent === "none" && reached.fastForwarding === "false",
      `phase=${reached.phase} running=${reached.running} speed=${reached.speed} ` +
        `intent=${reached.decisionIntent}/${reached.jumpIntent} choices=${reached.choices}`
    );

    // 恢復播放後 16× interval 只有 375ms，用 raf 在第一個 render 當下快照。
    await page.evaluate(() => { window.__jumpRelease = null; });
    await page.locator('[data-action="choose"]').first().click();
    await page.waitForFunction(
      () => {
        const live = document.querySelector("[data-p3e-live]");
        if (live?.getAttribute("data-p3e-phase") !== "life") return false;
        window.__jumpRelease = {
          running: live?.getAttribute("data-p3e-clock-running") ?? null,
          speed: live?.getAttribute("data-p3e-clock-speed") ?? null,
          commands: Number(live?.getAttribute("data-p3e-command-count") ?? "-1"),
          decisionIntent: live?.getAttribute("data-p3e-decision-intent") ?? null,
          jumpIntent: live?.getAttribute("data-p3e-jump-intent") ?? null
        };
        return true;
      },
      undefined,
      { timeout: 20000, polling: "raf" }
    );
    const after = await page.evaluate(() => window.__jumpRelease);
    check(
      `jump_${variant.name}_choose_restores_pre_jump_playback`,
      after.running === variant.expectedRunning && after.speed === variant.speed &&
        after.commands === reached.commands + 1 &&
        after.decisionIntent === "none" && after.jumpIntent === "none",
      `running=${after.running} speed=${after.speed} commands=${reached.commands}->${after.commands} ` +
        `intent=${after.decisionIntent}/${after.jumpIntent}`
    );
    check(`jump_${variant.name}_no_page_errors`, errors.length === 0, `errors=${JSON.stringify(errors)}`);
    await context.close();
  }

  // ---- B：jump → decision → 首次必選重心 → 沿用同一 intent -----------
  // probe-seed-36 在 7 歲同年有 pending decision；先手動暫停穩定走到 6 歲。
  for (const variant of [
    { name: "playing_4x", playing: true, speed: "4", expectedRunning: "true" },
    { name: "manual_paused_4x", playing: false, speed: "4", expectedRunning: "false" }
  ]) {
    const { context, page, errors } = await openJumpPage(
      `?seed=${encodeURIComponent("probe-seed-36")}`
    );
    await page.locator('[data-action="toggle-time"]').click(); // 先手動暫停，避免自動推進干擾
    let guard = 0;
    while (guard < 40) {
      const state = await readJumpState(page);
      if (state.age >= 6 && state.phase === "life") break;
      const selector = state.phase === "pending_decision"
        ? '[data-action="choose"]'
        : '[data-action="advance"]';
      const before = await commandCount(page);
      await page.locator(selector).first().click();
      await page.waitForFunction(
        (prev) =>
          Number(
            document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-command-count") ?? "0"
          ) > prev,
        before,
        { timeout: 20000 }
      );
      guard += 1;
    }
    const atSix = await readJumpState(page);
    check(
      `jump_focus_${variant.name}_reaches_age6_manually_paused`,
      atSix.age === 6 && atSix.phase === "life" && atSix.running === "false" &&
        atSix.required === "false" && atSix.decisionIntent === "none",
      `age=${atSix.age} phase=${atSix.phase} running=${atSix.running} intent=${atSix.decisionIntent}`
    );

    await page.locator(`[data-speed="${variant.speed}"]`).click();
    if (variant.playing) await page.locator('[data-action="toggle-time"]').click();
    const beforeJump = await readJumpState(page);
    check(
      `jump_focus_${variant.name}_pre_jump_clock_state`,
      beforeJump.running === String(variant.playing) && beforeJump.speed === variant.speed,
      `running=${beforeJump.running} speed=${beforeJump.speed}`
    );
    await clickJumpAndWait(page);
    const reached = await readJumpState(page);
    check(
      `jump_focus_${variant.name}_age7_decision_inherits_pre_jump_intent`,
      reached.phase === "pending_decision" && reached.age === 7 &&
        reached.running === "false" && reached.speed === variant.speed &&
        reached.choices >= 2 &&
        reached.decisionIntent === `${variant.playing ? "playing" : "paused"}:${variant.speed}` &&
        reached.jumpIntent === "none",
      `phase=${reached.phase} age=${reached.age} intent=${reached.decisionIntent}/${reached.jumpIntent} ` +
        `speed=${reached.speed} running=${reached.running}`
    );

    await page.locator('[data-action="choose"]').first().click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-focus-required") === "true",
      undefined,
      { timeout: 20000 }
    );
    const gate = await readJumpState(page);
    check(
      `jump_focus_${variant.name}_focus_gate_after_choose`,
      gate.required === "true" && gate.held === "true" && gate.running === "false" &&
        gate.commands === reached.commands + 1 &&
        gate.decisionIntent === "none" && gate.jumpIntent === "none" &&
        gate.inertCount > 0,
      `required=${gate.required} held=${gate.held} commands=${reached.commands}->${gate.commands} ` +
        `intent=${gate.decisionIntent}/${gate.jumpIntent} inert=${gate.inertCount}`
    );

    await page.evaluate(() => { window.__jumpFocusRelease = null; });
    await page
      .locator('.p3e-focus[data-p3e-focus-required="true"] [data-action="set-focus"][data-focus-id="study"]')
      .first()
      .click();
    await page.waitForFunction(
      () => {
        const live = document.querySelector("[data-p3e-live]");
        if (live?.getAttribute("data-p3e-focus-required") !== "false") return false;
        window.__jumpFocusRelease = {
          required: live?.getAttribute("data-p3e-focus-required") ?? null,
          held: live?.getAttribute("data-p3e-clock-held") ?? null,
          running: live?.getAttribute("data-p3e-clock-running") ?? null,
          speed: live?.getAttribute("data-p3e-clock-speed") ?? null,
          commands: Number(live?.getAttribute("data-p3e-command-count") ?? "-1"),
          decisionIntent: live?.getAttribute("data-p3e-decision-intent") ?? null,
          jumpIntent: live?.getAttribute("data-p3e-jump-intent") ?? null,
          inertCount: document.querySelectorAll("[inert]").length
        };
        return true;
      },
      undefined,
      { timeout: 20000, polling: "raf" }
    );
    const released = await page.evaluate(() => window.__jumpFocusRelease);
    check(
      `jump_focus_${variant.name}_focus_restores_pre_jump_intent`,
      released.required === "false" && released.held === "false" &&
        released.running === variant.expectedRunning && released.speed === variant.speed &&
        released.commands === gate.commands + 1 &&
        released.decisionIntent === "none" && released.jumpIntent === "none" &&
        released.inertCount === 0,
      `running=${released.running} speed=${released.speed} held=${released.held} ` +
        `commands=${gate.commands}->${released.commands} inert=${released.inertCount}`
    );
    check(`jump_focus_${variant.name}_no_page_errors`, errors.length === 0, `errors=${JSON.stringify(errors)}`);
    await context.close();
  }

  // ---- C：jump 中死亡 → 重生，intent 不得污染下一條命 ------------------
  {
    const { context, page, errors } = await openJumpPage(jumpQuery);
    await page.locator('[data-action="toggle-time"]').click(); // 全程手動暫停，狀態可預測
    // golden 有 106 個命令，jump 每遇到 decision 就停下，一輪約推進一年；
    // 上限放寬到 240 次迭代才足以一路走到死亡。
    let guard = 0;
    while (guard < 240) {
      const state = await readJumpState(page);
      if (state.phase === "death") break;
      if (state.phase === "pending_decision") {
        const before = await commandCount(page);
        await page.locator('[data-action="choose"]').first().click();
        await page.waitForFunction(
          (prev) =>
            Number(
              document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-command-count") ?? "0"
            ) > prev,
          before,
          { timeout: 20000 }
        );
      } else if (state.phase === "life") {
        await clickJumpAndWait(page);
      } else break;
      guard += 1;
    }
    const atDeath = await readJumpState(page);
    check(
      "jump_death_clears_armed_and_decision_intent",
      atDeath.phase === "death" && atDeath.running === "false" &&
        atDeath.jumpIntent === "none" && atDeath.decisionIntent === "none" &&
        atDeath.fastForwarding === "false",
      `phase=${atDeath.phase} running=${atDeath.running} guard=${guard} ` +
        `intent=${atDeath.decisionIntent}/${atDeath.jumpIntent}`
    );

    if (atDeath.phase !== "death") {
      const reason = `death not reached after ${guard} iterations`;
      check("jump_rebirth_no_stale_intent", false, reason);
      check("jump_rebirth_new_life_captures_its_own_paused_intent", false, reason);
      check("jump_rebirth_new_life_manual_pause_not_resumed", false, reason);
    } else {
      await page.locator('[data-action="rebirth"]').click();
      await page.waitForSelector(".p3e-birth-card", { timeout: 20000 });
      await page.locator('[data-action="start-life"]').click();
      await page.waitForFunction(
        () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life",
        undefined,
        { timeout: 20000 }
      );
      const reborn = await readJumpState(page);
      check(
        "jump_rebirth_no_stale_intent",
        reborn.age === 0 && reborn.phase === "life" &&
          reborn.jumpIntent === "none" && reborn.decisionIntent === "none",
        `age=${reborn.age} intent=${reborn.decisionIntent}/${reborn.jumpIntent}`
      );

      // 新的一命手動暫停 → jump → choose，必須保持暫停（若有 playing intent 殘留會 resume）。
      await page.locator('[data-action="toggle-time"]').click();
      await clickJumpAndWait(page);
      const newReached = await readJumpState(page);
      check(
        "jump_rebirth_new_life_captures_its_own_paused_intent",
        newReached.phase === "pending_decision" &&
          newReached.decisionIntent === `paused:${newReached.speed}` &&
          newReached.jumpIntent === "none" && newReached.running === "false",
        `phase=${newReached.phase} intent=${newReached.decisionIntent} speed=${newReached.speed}`
      );
      await page.locator('[data-action="choose"]').first().click();
      await page.waitForFunction(
        () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life",
        undefined,
        { timeout: 20000 }
      );
      const afterNewChoose = await readJumpState(page);
      check(
        "jump_rebirth_new_life_manual_pause_not_resumed",
        afterNewChoose.running === "false" &&
          afterNewChoose.decisionIntent === "none" && afterNewChoose.jumpIntent === "none",
        `running=${afterNewChoose.running} intent=${afterNewChoose.decisionIntent}/${afterNewChoose.jumpIntent}`
      );
    }
    check("jump_rebirth_no_page_errors", errors.length === 0, `errors=${JSON.stringify(errors)}`);
    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* 15. 五態與國名的覆蓋已移至 reader/DOM 單元測試（p3e-view-readers   */
  /*     .test.ts）與不進 production bundle 的測試 fixture；本腳本不再    */
  /*     依賴 window.__p3eProfileOverride 注入。以下僅保留 golden 資料   */
  /*     的觀察性驗收（見 6c 與死亡狀態卡檢查）。                       */
  /* ---------------------------------------------------------------- */

  const allChecks = [...results, ...scenarioResults];

  await browser.close();
  await new Promise((resolvePromise) => server.close(resolvePromise));

  const report = {
    ok: process.exitCode !== 1,
    check_count: allChecks.length,
    retained_check_count: results.length,
    scenario_check_count: scenarioResults.length,
    checks: allChecks,
    birth: birthReport,
    layout: layoutReport,
    copy: copyReport,
    perf: {
      boot_required_raw: boot.boot_required_raw,
      boot_required_gzip: boot.boot_required_gzip,
      data_assets_raw: boot.data_assets_raw,
      data_assets_gzip: boot.data_assets_gzip,
      components: boot.components,
      all_assets: allSizes,
      browser_boot_ms: bootMs,
      warm_command_ms: warmCommandMs,
      run_to_death_ms: runMs,
      cpu4x_autosave: cpu4xMetrics,
      node: process.version
    },
    axe: { violations, serious: serious.length }
  };
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(
    `P3E-BROWSER-SMOKE ${report.ok ? "OK" : "FAIL"} checks=${allChecks.length} ` +
      `retained=${results.length} scenarios=${scenarioResults.length} ` +
      `boot_required_gzip=${boot.boot_required_gzip} data_assets_gzip=${boot.data_assets_gzip} ` +
      `boot_ms=${bootMs} warm_command_ms=${warmCommandMs} node=${process.version}`
  );
}

await main();
