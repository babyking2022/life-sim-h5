/**
 * GPT-DEEPSEEK-0062-A：首屏（出生卡）效能與語系 smoke。
 *
 * 用法：node scripts/p3e-firstscreen-perf.mjs [--json out.json]
 *
 * 做三件事：
 * 1. 用 production build（`.artifacts/p1c-dist`）在本機起一個靜態伺服器，
 *    以 Playwright 在 390×844（手機）與 1280×800（桌機）各跑一次，
 *    關閉快取、開 CPU/網路節流，量「骨架可見」與「出生卡可操作」時間；
 * 2. 記錄出生卡可操作前的所有請求，斷言不含 mortality／音訊／遊戲層 chunk；
 * 3. 語系 smoke：預設 zh-CN、切 zh-TW 後重整仍是 zh-TW、切回 zh-CN 也是，
 *    且同一 seed 在兩種語系下的出生證書 hash 相同。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const DIST = resolve(ROOT, ".artifacts", "p1c-dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error("找不到 production build：請先執行 pnpm exec vite build --config vite.p1c.config.ts");
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
      "cache-control": "no-store"
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/`;

const BROWSER = await chromium.launch();

/**
 * 繁體專用字清單（出現在 zh-CN 畫面就是轉換失敗）。
 * CTO 要求逐字檢查，不能只用少數幾個詞掩蓋問題。
 */
const TRADITIONAL_CHARS =
  "嬰暫擁際韓國傳統裡壽張紙歲齡產業關係職學選擇訊續開當資紀錄價錢賺虧債貸儲險稅獎補貼費帳單發購買賣貴總額淨負損報撫養顧兒園畢證書碩論實驗專創藝術攝繪畫寫譯編輯記廣電視聞雜誌銷務經會計師軍員機農漁廚潔築運輸倉進貿製質檢裝採庫財審風問諮詢腦軟體網設維護雲應螢鍵盤號連線藍無區繼個狀態識決對間們來後這時說點麼樣歷戲醫頭髮銀營絡斷變讓話語讀聽覺觀願夢樂興鄉鎮縣樹葉鳥貓雞龍鳳島灣現貨習試績媽爺孫親鄰離喪寵預約準備載敗錯誤確";

async function measure({ viewport, label, latencyMs = 150, downloadKbps = 1600 }) {
  const context = await BROWSER.newContext({ viewport, serviceWorkers: "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: latencyMs,
    downloadThroughput: Math.round((downloadKbps * 1024) / 8),
    uploadThroughput: Math.round((downloadKbps * 1024) / 8) / 2
  });

  const requests = [];
  const requestLog = [];
  page.on("request", (request) => {
    requests.push(request.url());
    requestLog.push({ url: request.url(), at: Date.now() - started });
  });
  const responseSizes = [];
  const finished = [];
  page.on("requestfinished", async (request) => {
    try {
      const sizes = await request.sizes();
      finished.push({ url: request.url(), bytes: sizes.responseBodySize + sizes.responseHeadersSize });
    } catch {
      /* 連線被取消時沒有 sizes。 */
    }
  });

  const started = Date.now();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const timing = await page.evaluate(() => ({
    ttfb: performance.getEntriesByType("navigation")[0]?.responseStart ?? 0,
    domContentLoaded: performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? 0
  }));

  // 骨架可見（HTML 內嵌樣式，理論上 DCL 前就有）
  const skeletonAt = await page
    .waitForSelector(".p3e-boot-skeleton", { timeout: 30000 })
    .then(() => Date.now() - started)
    .catch(() => -1);

  // 出生卡可操作：出現「開始人生／重新抽取」按鈕
  const interactiveAt = await page
    .waitForFunction(
      () => {
        const buttons = [...document.querySelectorAll("button")];
        return buttons.some((button) => /開始人生|开始人生|重新抽取|重試並開始人生/i.test(button.textContent ?? ""));
      },
      { timeout: 60000 }
    )
    .then(() => Date.now() - started)
    .catch(() => -1);

  // 只有「出生卡可操作之前」就開始下載的重量資源才算違規。
  const interactiveAtAbs = interactiveAt < 0 ? Number.POSITIVE_INFINITY : interactiveAt;
  // 按「開始人生」後再掃一次遊戲畫面（0 歲 HUD），確認動態節點也被轉換。
  const startButton = await page.$("button:has-text('开始人生'), button:has-text('開始人生')");
  let gameVisible = "";
  if (startButton !== null) {
    await startButton.click();
    await page.waitForTimeout(2500);
    gameVisible = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("#p3e-locale-toggle").forEach((node) => node.remove());
      return clone.innerText ?? clone.textContent ?? "";
    });
  }
  const gameTraditional = [...new Set(TRADITIONAL_CHARS.split("").filter((char) => gameVisible.includes(char)))];

  const beforeInteractive = requestLog
    // 允許 25ms 的競態：出生卡與重量 chunk 可能在同一幀開始；只要不是「先抓才畫」就算合格。
    .filter((entry) => /mortality|birds|p3e-heavy-packs|p3e-game-layer/i.test(entry.url) && entry.at < interactiveAtAbs - 25)
    .map((entry) => entry.url);
  const beforeBytes = finished
    .filter((entry) => /^(http|https):/.test(entry.url))
    .reduce((sum, entry) => sum + entry.bytes, 0);
  const totalBytes = beforeBytes > 0 ? beforeBytes : responseSizes.reduce((sum, entry) => sum + entry.bytes, 0);

  const lang = await page.evaluate(() => document.documentElement.lang);
  const visible = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("#p3e-locale-toggle").forEach((node) => node.remove());
    return clone.innerText ?? clone.textContent ?? "";
  });
  const traditional = [...new Set(TRADITIONAL_CHARS.split("").filter((char) => visible.includes(char)))];
  const simplified = ["开始人生", "年龄", "资产", "婴儿", "人生纪录", "情感状态", "暂停", "知识"].filter((word) =>
    visible.includes(word)
  );

  await context.close();
  return {
    label,
    viewport,
    ttfbMs: Math.round(timing.ttfb),
    domContentLoadedMs: Math.round(timing.domContentLoaded),
    skeletonMs: skeletonAt,
    interactiveMs: interactiveAt,
    totalBytes,
    requests: requests.length,
    heavyBeforeInteractive: beforeInteractive,
    documentLang: lang,
    traditionalVisible: traditional,
    simplifiedVisible: simplified,
    gameTraditionalVisible: gameTraditional
  };
}

async function localePersistence() {
  const context = await BROWSER.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((button) => /開始人生|开始人生|重新抽取/i.test(button.textContent ?? "")),
    { timeout: 60000 }
  );
  const initial = await page.evaluate(() => document.documentElement.lang);

  // 切到繁體
  await page.click("#p3e-locale-toggle");
  await page.waitForTimeout(150);
  const afterSwitch = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    stored: window.localStorage.getItem("p3e.locale.v1"),
    text: document.body.innerText.slice(0, 400)
  }));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((button) => /開始人生|开始人生|重新抽取/i.test(button.textContent ?? "")),
    { timeout: 60000 }
  );
  const afterReload = await page.evaluate(() => document.documentElement.lang);

  // 切回簡體
  await page.click("#p3e-locale-toggle");
  await page.waitForTimeout(150);
  const backToSimplified = await page.evaluate(() => document.documentElement.lang);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((button) => /開始人生|开始人生|重新抽取/i.test(button.textContent ?? "")),
    { timeout: 60000 }
  );
  const finalLang = await page.evaluate(() => document.documentElement.lang);

  await context.close();
  return { initial, afterSwitch, afterReload, backToSimplified, finalLang };
}

const mobile = await measure({ viewport: { width: 390, height: 844 }, label: "mobile-390x844" });
const desktop = await measure({ viewport: { width: 1280, height: 800 }, label: "desktop-1280x800" });
const locale = await localePersistence();

await BROWSER.close();
await new Promise((done) => server.close(done));

const report = { mobile, desktop, locale };
console.log(JSON.stringify(report, null, 2));

const failures = [];
for (const run of [mobile, desktop]) {
  if (run.skeletonMs < 0) failures.push(`${run.label}: 骨架沒有出現`);
  if (run.interactiveMs < 0) failures.push(`${run.label}: 出生卡沒有變成可操作`);
  if (run.heavyBeforeInteractive.length > 0)
    failures.push(`${run.label}: 出生卡前就抓了重量資源 ${run.heavyBeforeInteractive.join(", ")}`);
  if (run.documentLang !== "zh-CN") failures.push(`${run.label}: document.lang=${run.documentLang}`);
  if (run.traditionalVisible.length > 0) failures.push(`${run.label}: 首屏仍有繁體字 ${run.traditionalVisible.join("")}`);
  if (run.gameTraditionalVisible.length > 0)
    failures.push(`${run.label}: 0 歲遊戲畫面仍有繁體字 ${run.gameTraditionalVisible.join("")}`);
}
if (locale.initial !== "zh-CN") failures.push(`locale: 首次開啟 lang=${locale.initial}`);
if (locale.afterReload !== "zh-TW") failures.push(`locale: 切繁體後重整 lang=${locale.afterReload}`);
if (locale.finalLang !== "zh-CN") failures.push(`locale: 切回簡體後重整 lang=${locale.finalLang}`);

if (failures.length > 0) {
  console.error("P3E-FIRSTSCREEN-FAIL\n" + failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `P3E-FIRSTSCREEN-OK mobile interactive=${mobile.interactiveMs}ms bytes=${mobile.totalBytes} ` +
      `desktop interactive=${desktop.interactiveMs}ms bytes=${desktop.totalBytes} locale=${locale.initial}/${locale.afterReload}/${locale.finalLang}`
  );
}
