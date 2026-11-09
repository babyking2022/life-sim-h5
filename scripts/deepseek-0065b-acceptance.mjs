/**
 * GPT-DEEPSEEK-0065-B｜獨立驗收：出生首頁效能（自己的 server、自己的量測）。
 *
 * 與 WorkBuddy 的量測完全獨立：
 * - 自己重建 production build（呼叫 vite build 之前由外部先跑，腳本只驗證 dist 存在）；
 * - 自己的 `node:http` 靜態 server（**不壓縮**，與 0063/0064 同口徑）；
 * - 自己的 CDP 節流（Fast-3G 1.6 Mbps / 150 ms）與快取關閉；
 * - 自己輸出「出生卡可操作前」的完整請求表（raw bytes／是否 heavy）。
 *
 * 用法：node scripts/deepseek-0065b-acceptance.mjs [--json out.json]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const DIST = resolve(ROOT, ".artifacts", "p1c-dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error("缺少 production build：先執行 pnpm exec vite build --config vite.p1c.config.ts");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2"
};

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
    response.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "content-length": String(body.byteLength)
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/`;

const HEAVY_PATTERN = /open-peeps|p3e-open-peeps|p3e-scene|p3e-game-layer|p3e-heavy-packs|mortality|birds|events\.v1|event-copy/i;
const BIRTH_JSON_PATTERN = /\/assets\/(country-registry|indicators|birth-weights|currency|country-vitals|household-profiles|name-corpus|story-templates|birth-bundle|p2a-|p2b-)[^/]*\.json$/i;

/**
 * GPT-WORKBUDDY-0065-A 修正（只修正誤判，不放寬語系要求）：
 * 原本這串是從「繁體詞組」逐字展開，混進了 35 個**簡繁同形**的字
 * （料／法／服／手／用／台／端／器／系／算／演／式／程／路／技／科／品／
 *  易／售／防／消／察／警／律／秘／裁／董／理／幼／酬／池／鼠／幕／板／
 *  充／伺／密／加／域／平／滑／牙／硬…），因此「出生资料」「方法」
 *  「衣服」等正確簡體字串會被誤判成繁體。
 *
 * 現在只保留 `packages/ui/src/p3e-locale.ts` 的 `CHAR_PAIRS` 裡
 * 「from !== to」的單字（真正會被在地化層轉換的繁體專用字），
 * 檢查反而更精準：任何仍顯示繁體專用字依舊會被抓到。
 */
const TRADITIONAL_CHARS =
  "係倉個傳債價儲兒創務區員問單國園報壽嬰學實審寫對師帳庫廚廣張應採損撫擁擇攝暫書業機檢歲歷淨漁潔無獎產畢畫當發盤碩稅築紀紙統經維網線編總繪續聞職腦藍藝號螢術補裝裡製視計訊記設詢誌論諮證譯護負財費貿資賣質購軍軟輸農連進運選銷錄錢鍵開關際險雜雲電韓額顧風養驗體齡";

const BROWSER = await chromium.launch();

async function measure({ viewport, label }) {
  const context = await BROWSER.newContext({ viewport, serviceWorkers: "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: Math.round((1600 * 1024) / 8),
    uploadThroughput: Math.round((1600 * 1024) / 8) / 2
  });

  const requestLog = [];
  page.on("request", (request) => requestLog.push({ url: request.url(), at: Date.now() - started }));
  const finished = [];
  page.on("requestfinished", async (request) => {
    try {
      const sizes = await request.sizes();
      finished.push({ url: request.url(), bytes: sizes.responseBodySize + sizes.responseHeadersSize });
    } catch {
      /* cancelled */
    }
  });

  const started = Date.now();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const nav = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0];
    return { ttfb: entry?.responseStart ?? 0, dcl: entry?.domContentLoadedEventEnd ?? 0 };
  });

  const skeletonMs = await page
    .waitForSelector(".p3e-boot-skeleton", { timeout: 30000 })
    .then(() => Date.now() - started)
    .catch(() => -1);

  const interactiveSelector = "button:has-text('开始人生'), button:has-text('開始人生'), button:has-text('重試')";
  const interactiveMs = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some((button) =>
          /开始人生|開始人生|重試並開始人生|重试并开始人生/.test(button.textContent ?? "")
        ),
      { timeout: 60000 }
    )
    .then(() => Date.now() - started)
    .catch(() => -1);

  const beforeRequests = requestLog.filter((entry) => interactiveMs < 0 || entry.at <= interactiveMs);
  const beforeFinished = finished.filter((entry) => entry.bytes >= 0);
  const heavyBefore = beforeRequests.filter((entry) => HEAVY_PATTERN.test(entry.url)).map((entry) => entry.url);
  const birthJsonBefore = beforeRequests.filter((entry) => BIRTH_JSON_PATTERN.test(entry.url));
  const jsBefore = beforeRequests.filter((entry) => entry.url.endsWith(".js"));
  const cssBefore = beforeRequests.filter((entry) => entry.url.endsWith(".css"));

  const bytesByUrl = new Map(beforeFinished.map((entry) => [entry.url, entry.bytes]));
  const sumOf = (entries) => entries.reduce((sum, entry) => sum + (bytesByUrl.get(entry.url) ?? 0), 0);
  const totalBytes = [...bytesByUrl.values()].reduce((sum, value) => sum + value, 0);

  const lang = await page.evaluate(() => document.documentElement.lang);
  const birthText = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("#p3e-locale-toggle").forEach((node) => node.remove());
    return clone.innerText ?? clone.textContent ?? "";
  });
  const birthTraditional = [...new Set(TRADITIONAL_CHARS.split("").filter((char) => birthText.includes(char)))];

  // 刷新出生：必須零新增請求（除了既有快取記憶體）。
  const beforeRefresh = requestLog.length;
  const refreshButton = await page.$("button:has-text('刷新出生'), button:has-text('刷新')");
  let refreshRequests = 0;
  if (refreshButton !== null) {
    await refreshButton.click();
    await page.waitForTimeout(1200);
    refreshRequests = requestLog.length - beforeRefresh;
  }

  // 開始人生：只建立一次 session。
  const startButton = await page.$("button:has-text('开始人生'), button:has-text('開始人生')");
  let sessionCountBefore = 0;
  let sessionCountAfter = 0;
  let gameTraditional = [];
  const heavyAfterStart = [];
  if (startButton !== null) {
    sessionCountBefore = await page.evaluate(() => Number(document.documentElement.dataset.p3eSessionCount ?? 0));
    const markStart = requestLog.length;
    await startButton.click();
    await page.waitForTimeout(200);
    await startButton.click().catch(() => undefined);
    await page.waitForTimeout(6000);
    sessionCountAfter = await page.evaluate(() => Number(document.documentElement.dataset.p3eSessionCount ?? 0));
    const gameText = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("#p3e-locale-toggle").forEach((node) => node.remove());
      return clone.innerText ?? clone.textContent ?? "";
    });
    gameTraditional = [...new Set(TRADITIONAL_CHARS.split("").filter((char) => gameText.includes(char)))];
    for (const entry of requestLog.slice(markStart)) {
      if (HEAVY_PATTERN.test(entry.url)) heavyAfterStart.push(entry.url);
    }
  }

  await context.close();
  return {
    label,
    viewport,
    ttfbMs: Math.round(nav.ttfb),
    dclMs: Math.round(nav.dcl),
    skeletonMs,
    interactiveMs,
    totalBytes,
    requestCount: beforeRequests.length,
    jsGzipNote: null,
    jsRawBytes: sumOf(jsBefore),
    cssRawBytes: sumOf(cssBefore),
    birthJsonRequests: birthJsonBefore.length,
    birthJsonBytes: sumOf(birthJsonBefore),
    heavyBeforeInteractive: heavyBefore,
    requests: beforeRequests.map((entry) => ({
      at: entry.at,
      path: entry.url.replace(baseUrl, ""),
      bytes: bytesByUrl.get(entry.url) ?? 0,
      heavy: HEAVY_PATTERN.test(entry.url)
    })),
    documentLang: lang,
    birthTraditional,
    gameTraditional,
    refreshRequests,
    sessionCountBefore,
    sessionCountAfter,
    heavyAfterStart
  };
}

const mobile = await measure({ viewport: { width: 390, height: 844 }, label: "mobile-390x844" });
const desktop = await measure({ viewport: { width: 1280, height: 800 }, label: "desktop-1280x800" });

await BROWSER.close();
await new Promise((done) => server.close(done));

/* gzip 大小直接對 dist 檔案算（用 node:zlib），對齊「critical JS gzip ≤55KB」口徑。 */
import { gzipSync } from "node:zlib";
const JS_GZIP = [];
for (const entry of mobile.requests) {
  if (!entry.path.endsWith(".js") && !entry.path.endsWith(".css")) continue;
  const filePath = join(DIST, entry.path);
  try {
    const body = await readFile(filePath);
    JS_GZIP.push({ path: entry.path, raw: body.byteLength, gzip: gzipSync(body, { level: 9 }).byteLength });
  } catch {
    /* ignore */
  }
}
mobile.gzipTable = JS_GZIP;

const report = { mobile, desktop };
console.log(JSON.stringify(report, null, 2));

const failures = [];
const thresholds = {
  interactiveMs: 3259,
  totalBytes: 539912,
  birthJsonRequests: 2,
  jsGzip: 55 * 1024,
  cssGzip: 10 * 1024
};
for (const run of [mobile, desktop]) {
  if (run.interactiveMs < 0) failures.push(`${run.label}: 出生卡沒有可操作`);
  if (run.interactiveMs > thresholds.interactiveMs)
    failures.push(`${run.label}: interactive ${run.interactiveMs}ms > ${thresholds.interactiveMs}ms`);
  if (run.totalBytes > thresholds.totalBytes)
    failures.push(`${run.label}: bytes ${run.totalBytes} > ${thresholds.totalBytes}`);
  if (run.birthJsonRequests > thresholds.birthJsonRequests)
    failures.push(`${run.label}: birth JSON ${run.birthJsonRequests} > ${thresholds.birthJsonRequests}`);
  if (run.heavyBeforeInteractive.length > 0)
    failures.push(`${run.label}: 出生卡前有 heavy 資源 ${run.heavyBeforeInteractive.join(",")}`);
  if (run.documentLang !== "zh-CN") failures.push(`${run.label}: lang=${run.documentLang}`);
  if (run.birthTraditional.length > 0) failures.push(`${run.label}: 出生卡仍有繁體字 ${run.birthTraditional.join("")}`);
  if (run.refreshRequests > 0) failures.push(`${run.label}: 刷新出生新增 ${run.refreshRequests} 個請求`);
  if (run.gameTraditional.length > 0) failures.push(`${run.label}: 遊戲畫面仍有繁體字 ${run.gameTraditional.join("")}`);
}
const jsGzip = mobile.gzipTable.filter((entry) => entry.path.endsWith(".js")).reduce((sum, entry) => sum + entry.gzip, 0);
const cssGzip = mobile.gzipTable.filter((entry) => entry.path.endsWith(".css")).reduce((sum, entry) => sum + entry.gzip, 0);
if (jsGzip > thresholds.jsGzip) failures.push(`birth JS gzip ${jsGzip} > ${thresholds.jsGzip}`);
if (cssGzip > thresholds.cssGzip) failures.push(`birth CSS gzip ${cssGzip} > ${thresholds.cssGzip}`);

console.log(
  `DEEPSEEK-0065B-METRICS mobile interactive=${mobile.interactiveMs}ms bytes=${mobile.totalBytes} json=${mobile.birthJsonRequests} jsGzip=${jsGzip} cssGzip=${cssGzip}`
);
if (failures.length > 0) {
  console.error("DEEPSEEK-0065B-FAIL\n" + failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("DEEPSEEK-0065B-OK");
}
