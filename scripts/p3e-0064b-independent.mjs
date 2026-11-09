/**
 * GPT-WORKBUDDY-0064-B｜**獨立**速度與功能驗收。
 *
 * 刻意不讀、不改、不依賴 DeepSeek 的 `p3e-firstscreen-perf.mjs` 量測結果：
 * 這裡自行從 production build 起 server，用 CDP 關快取、Fast-3G
 * (1.6 Mbps / 150 ms RTT)、390×844 量一條全新的請求時間軸，並以
 * 「出生卡可操作 **之前** 發起的請求」為唯一 bytes / 請求數口徑。
 * 量完只讀不點「開始人生」，避免把按下後才下載的遊戲資源算進出生前。
 *
 * 檢查：
 *  A. 出生卡可操作 ≤3,259 ms、出生前 bytes ≤539,912 B、出生 JSON ≤2 請求、
 *     出生前沒有 Open Peeps / game layer / events / mortality / mp3（請求 + 內容）
 *  B. 刷新出生：整張卡更新、零新增請求、不建立 session、防連點、焦點/aria-live
 *  C. fresh context 語系：預設 zh-CN、切 zh-TW 重整保留、切回 zh-CN 重整保留、
 *     不出現簡繁混合、同 seed 的 certificate/identity hash 不因語系改變
 *
 * 用法：node scripts/p3e-0064b-independent.mjs
 * 輸出：.artifacts/p3e-0064b-independent.json
 */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { gzipSync } from "node:zlib";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, ".artifacts/p1c-dist");
const reportPath = join(root, ".artifacts", "p3e-0064b-independent.json");
const VIEWPORT = { width: 390, height: 844 };
const FIXED_SEED = "p3e-0064b-independent-seed";

const LIMIT_INTERACTIVE_MS = 3259;
const LIMIT_BEFORE_BYTES = 539912;
const LIMIT_BIRTH_JSON_REQUESTS = 2;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2"
};

if (!existsSync(join(dist, "index.html"))) {
  console.error("找不到 production build：.artifacts/p1c-dist/index.html");
  process.exit(1);
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

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
      done(`http://127.0.0.1:${address.port}/`);
    });
  });
}

/** 出生卡可操作以前不該出現的資產／chunk（只看 URL 路徑）。 */
const HEAVY_PATH_RE =
  /(open-?peeps|p3e-scene|p3e-game-layer|p3e-heavy-packs|events\.v1|event-copy|mortality|birds|\.mp3)/i;
/** 明確的資產內容標記；不出現在 birth critical chunk 才算真正切開。 */
const ASSET_MARKERS = [
  { name: "Open Peeps 官方部件 key", re: /data-part="openpeeps\// },
  { name: "Open Peeps 衍生部件 key", re: /openpeeps-derived\// },
  { name: "mortality 資產 URL", re: /mortality\.v1[^"'`]*\.json/ },
  { name: "mp3 資產 URL", re: /birds-[^"'`]*\.mp3/ },
  { name: "events 資產 URL", re: /events\.v1[^"'`]*\.json/ }
];
/** 繁體專用字：出現在 zh-CN 畫面就是簡繁混合。 */
const TRADITIONAL_CHARS =
  "嬰暫擁際韓國傳統裡壽張紙歲齡產業關係職學選擇訊續開當資紀錄價錢賺虧債貸儲險稅獎補貼費帳單發購買賣貴總額淨負損報撫養顧兒園畢證書碩論實驗專創藝術攝繪畫寫譯編輯記廣電視聞雜誌銷務經會計師軍員機農漁廚潔築運輸倉進貿製質檢裝採庫財審風問諮詢腦軟體網設維護雲應螢鍵盤號連線藍無區繼個狀態識決對間們來後這時說點麼樣歷戲醫頭髮銀營絡斷變讓話語讀聽覺觀願夢樂興鄉鎮縣樹葉鳥貓雞龍鳳島灣現貨習試績媽爺孫親鄰離喪寵預約準備載敗錯誤確";

/**
 * 從執行期語系表推導「應該被轉成簡體」的繁體字集合，並補上常用但表內
 * 未映射的字。只用手寫的短字表會漏掉國家名等專有名詞（例如「亞／與／納」），
 * 那會把真實的簡繁混合誤判成通過。
 */
function hantScanSet() {
  const source = readFileSync(join(root, "packages/ui/src/p3e-locale.ts"), "utf8");
  const start = source.indexOf("const CHAR_PAIRS");
  const asConst = source.indexOf("] as const", start);
  const end = asConst > 0 ? asConst : source.indexOf("]);", start);
  const pairs = [...source.slice(start, end).matchAll(/\[\s*"([^"]+)",\s*"([^"]+)"\s*\]/g)]
    .map((match) => [match[1], match[2]])
    .filter(([hant, simplified]) => hant !== simplified);
  const mapped = new Set(pairs.map(([hant]) => hant));
  const scan = new Set(mapped);
  for (const char of TRADITIONAL_CHARS) scan.add(char);
  for (const char of "亞與納臺麵髒瞭") scan.add(char);
  return { mapped, scan, mappedCount: pairs.length };
}
const HANT_SCAN = hantScanSet();
function traditionalIn(text) {
  return [...new Set([...HANT_SCAN.scan].filter((char) => text.includes(char)))];
}

const server = staticServer();
const baseUrl = await listen(server);
const BROWSER = await chromium.launch();

/** 追蹤一條完整請求時間軸；bytes 由 request.sizes() 與 request 物件配對。 */
function track(page, started) {
  const records = [];
  const byRequest = new Map();
  page.on("request", (request) => {
    let path = "";
    try {
      path = new URL(request.url()).pathname;
    } catch {
      path = request.url();
    }
    const record = {
      url: request.url(),
      path,
      type: request.resourceType(),
      at: Date.now() - started,
      bytes: 0,
      finishedAt: null
    };
    records.push(record);
    byRequest.set(request, record);
  });
  page.on("requestfinished", async (request) => {
    try {
      const sizes = await request.sizes();
      const record = byRequest.get(request);
      if (record !== undefined) {
        record.bytes = sizes.responseBodySize + sizes.responseHeadersSize;
        record.finishedAt = Date.now() - started;
      }
    } catch {
      /* 取消的請求沒有 sizes。 */
    }
  });
  return records;
}

async function throttledContext(extra = {}) {
  const context = await BROWSER.newContext({
    viewport: VIEWPORT,
    serviceWorkers: "block",
    ...extra
  });
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
  return { context, page };
}

function cardState(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.p3e-birth-screen[data-p3e-live="true"]');
    if (card === null) return null;
    return {
      seed: card.dataset.p3eBirthSeed ?? "",
      certificate: card.dataset.p3eBirthCertificateHash ?? "",
      identity: card.dataset.p3eBirthIdentityHash ?? "",
      refreshCount: Number(card.dataset.p3eRefreshCount ?? "-1"),
      worldStage: card.dataset.p3eWorldStage ?? "",
      phase: card.dataset.p3ePhase ?? "",
      commandCount: card.dataset.p3eCommandCount ?? "",
      country: document.getElementById("p3e-birth-country")?.textContent ?? "",
      headline: document.querySelector(".p3e-birth-headline")?.textContent ?? "",
      grid: document.querySelector(".p3e-birth-grid")?.textContent ?? "",
      story: document.querySelector(".p3e-birth-story")?.textContent ?? "",
      scrollHeight: document.documentElement.scrollHeight
    };
  });
}

function visibleText(page) {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("#p3e-locale-toggle").forEach((node) => node.remove());
    return clone.innerText ?? clone.textContent ?? "";
  });
}

/* ------------------------------------------------------------------ *
 * A. 嚴格首屏效能量測（不點開始人生）
 * ------------------------------------------------------------------ */
const { context: perfContext, page: perfPage } = await throttledContext();
const started = Date.now();
const perfRequests = track(perfPage, started);
await perfPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
const timing = await perfPage.evaluate(() => ({
  ttfb: performance.getEntriesByType("navigation")[0]?.responseStart ?? 0,
  dcl: performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? 0
}));
const skeletonMs = await perfPage
  .waitForSelector(".p3e-boot-skeleton", { timeout: 30000 })
  .then(() => Date.now() - started)
  .catch(() => -1);
const interactiveMs = await perfPage
  .waitForFunction(
    () => {
      const card = document.querySelector('.p3e-birth-screen[data-p3e-live="true"]');
      const button = [...document.querySelectorAll("button")].find(
        (item) => /開始人生|开始人生/.test(item.textContent ?? "") && !item.disabled
      );
      return card !== null && button !== undefined;
    },
    { timeout: 60000 }
  )
  .then(() => Date.now() - started)
  .catch(() => -1);

// 讓「出生卡可操作前已發起」的請求完成，但篩選仍以發起時間為準。
// 0063 既有驗收允許 25ms 同幀競態（出生卡與背景 chunk 可能同一幀開始）；
// 這裡同時給出「既有 25ms 口徑」與「嚴格 0ms 口徑」，避免口徑不同造成假回歸。
await perfPage.waitForTimeout(1500);
const RACE_MS = 25;
const strictBefore = perfRequests.filter((record) => record.at <= interactiveMs);
const before = perfRequests.filter((record) => record.at <= interactiveMs - RACE_MS);
const strictBeforeBytes = strictBefore.reduce((sum, record) => sum + record.bytes, 0);
const beforeBytes = before.reduce((sum, record) => sum + record.bytes, 0);
const allBytes = perfRequests.reduce((sum, record) => sum + record.bytes, 0);
const birthJson = before.filter((record) => /\.json(\?|$)/i.test(record.path));
const heavyBefore = before.filter((record) => HEAVY_PATH_RE.test(record.path));
const heavyStrictRace = strictBefore.filter(
  (record) => HEAVY_PATH_RE.test(record.path) && record.at > interactiveMs - RACE_MS
);
const externalBefore = before.filter((record) => {
  try {
    return !["127.0.0.1", "localhost"].includes(new URL(record.url).hostname);
  } catch {
    return false;
  }
});

// 內容掃描：出生前載入的 JS/CSS 不得內含遊戲資產內容。
const contentHits = [];
const criticalAssets = [];
for (const record of before) {
  if (!/\.(js|css)(\?|$)/i.test(record.path)) continue;
  const file = resolve(dist, `.${decodeURIComponent(record.path)}`);
  if (!file.startsWith(dist + sep)) continue;
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    continue;
  }
  criticalAssets.push({
    path: record.path,
    rawBytes: Buffer.byteLength(text),
    gzipBytes: gzipSync(text).length,
    bytes: record.bytes
  });
  for (const marker of ASSET_MARKERS) {
    if (marker.re.test(text)) contentHits.push({ path: record.path, marker: marker.name });
  }
}

const perf = {
  viewport: VIEWPORT,
  condition: "production build / no-cache / Fast-3G 1.6Mbps / 150ms RTT / 390x844",
  ttfbMs: Math.round(timing.ttfb),
  dclMs: Math.round(timing.dcl),
  skeletonMs,
  interactiveMs,
  raceWindowMs: RACE_MS,
  beforeInteractiveRequests: before.length,
  beforeInteractiveBytes: beforeBytes,
  strictBeforeInteractiveRequests: strictBefore.length,
  strictBeforeInteractiveBytes: strictBeforeBytes,
  allRequests: perfRequests.length,
  allBytes,
  birthJsonRequests: birthJson.length,
  birthJsonPaths: birthJson.map((record) => record.path),
  heavyBeforeInteractive: heavyBefore.map((record) => record.path),
  heavyStrictRace: heavyStrictRace.map((record) => ({ path: record.path, at: record.at, interactiveMs })),
  externalBeforeInteractive: externalBefore.map((record) => record.url),
  contentHits,
  criticalAssets,
  requestTimeline: perfRequests.map((record) => ({
    path: record.path,
    type: record.type,
    at: record.at,
    finishedAt: record.finishedAt,
    bytes: record.bytes,
    beforeInteractive: record.at <= interactiveMs - RACE_MS,
    strictBeforeInteractive: record.at <= interactiveMs
  }))
};

check(
  "A1 出生卡可操作 ≤3,259 ms",
  interactiveMs >= 0 && interactiveMs <= LIMIT_INTERACTIVE_MS,
  `interactive=${interactiveMs}ms (0063 baseline 4,661–4,722ms)`
);
check(
  "A2 出生前 transferred bytes ≤539,912 B",
  beforeBytes <= LIMIT_BEFORE_BYTES && strictBeforeBytes <= LIMIT_BEFORE_BYTES,
  `25ms口徑=${beforeBytes} B, 嚴格0ms=${strictBeforeBytes} B (0063 baseline 878,167–878,769 B); 全部請求=${allBytes} B`
);
check(
  "A3 出生 JSON 最多 2 請求",
  birthJson.length <= LIMIT_BIRTH_JSON_REQUESTS,
  `count=${birthJson.length} paths=${birthJson.map((r) => r.path).join(", ") || "none"}`
);
check(
  "A4 出生卡前沒有 Open Peeps / game layer / events / mortality / mp3 請求",
  heavyBefore.length === 0,
  `25ms口徑違規=${heavyBefore.length}; 同幀競態(0ms口徑)=${heavyStrictRace.map((r) => `${r.path}@${r.at}ms`).join(", ") || "none"}`
);
check(
  "A5 出生 critical JS/CSS 內容不含遊戲資產（25ms 口徑）",
  contentHits.length === 0,
  contentHits.length === 0
    ? `criticalAssets=${criticalAssets.map((a) => `${a.path}:${a.gzipBytes}Bgz`).join(", ")}`
    : JSON.stringify(contentHits)
);
check(
  "A6 出生卡前沒有外部網域請求",
  externalBefore.length === 0,
  externalBefore.length === 0 ? "none" : externalBefore.map((r) => r.url).join(", ")
);
check("A7 靜態骨架先於出生卡", skeletonMs >= 0 && skeletonMs <= interactiveMs, `skeleton=${skeletonMs}ms`);

/* ------------------------------------------------------------------ *
 * B. 刷新出生（同一條 HTTP 連線上下文，等待網路安靜後量「零新增請求」）
 * ------------------------------------------------------------------ */
async function waitNetworkQuiet(records, quietMs = 700, maxMs = 25000) {
  const start = Date.now();
  let lastCount = records.length;
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((done) => setTimeout(done, 250));
    if (records.length !== lastCount) {
      lastCount = records.length;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
}

await waitNetworkQuiet(perfRequests);
const beforeCard = await cardState(perfPage);
const requestCountBeforeRefresh = perfRequests.length;

// 同步點擊兩次：在 120ms timeout 前就能觀察 disabled／「刷新中…」與連點防護。
const clickResult = await perfPage.evaluate(() => {
  const button = document.querySelector('[data-action="refresh-birth"]');
  if (button === null) return null;
  const beforeText = button.textContent ?? "";
  button.click();
  button.click();
  return {
    beforeText,
    disabled: button.disabled,
    state: button.getAttribute("data-p3e-refresh-state") ?? "",
    text: button.textContent ?? ""
  };
});
check(
  "B1 刷新期間按鈕防連點（disabled + 刷新中）",
  clickResult !== null && clickResult.disabled === true && clickResult.state === "loading" && /刷新中/.test(clickResult.text),
  clickResult === null ? "button missing" : JSON.stringify(clickResult)
);

await perfPage
  .waitForFunction(
    () => document.querySelector('[data-action="refresh-birth"]')?.getAttribute("data-p3e-refresh-state") === "idle",
    { timeout: 15000 }
  )
  .catch(() => {});
await perfPage.waitForTimeout(350);
const afterCard = await cardState(perfPage);
const refreshUi = await perfPage.evaluate(() => ({
  active: document.activeElement?.getAttribute("data-action") ?? "",
  announcer: document.querySelector('[aria-live="polite"]')?.textContent ?? ""
}));

const cardChanged =
  beforeCard !== null &&
  afterCard !== null &&
  beforeCard.seed !== afterCard.seed &&
  beforeCard.certificate !== afterCard.certificate &&
  (beforeCard.country !== afterCard.country ||
    beforeCard.grid !== afterCard.grid ||
    beforeCard.story !== afterCard.story ||
    beforeCard.headline !== afterCard.headline);
check("B2 整張出生卡一起更新（seed / certificate / 國家 / 家庭 / 故事）", cardChanged,
  `seed ${beforeCard?.seed} → ${afterCard?.seed}; country ${JSON.stringify(beforeCard?.country)} → ${JSON.stringify(afterCard?.country)}`);
check(
  "B3 連點兩次只刷新一次",
  beforeCard !== null && afterCard !== null && afterCard.refreshCount === beforeCard.refreshCount + 1,
  `count ${beforeCard?.refreshCount} → ${afterCard?.refreshCount}`
);
check(
  "B4 不建立 session（phase=birth、commandCount=0）",
  afterCard?.phase === "birth" && afterCard?.commandCount === "0",
  `phase=${afterCard?.phase} commands=${afterCard?.commandCount}`
);
check(
  "B5 刷新零新增請求",
  perfRequests.length === requestCountBeforeRefresh,
  `before=${requestCountBeforeRefresh} after=${perfRequests.length}`
);
check("B6 焦點回到刷新按鈕", refreshUi.active === "refresh-birth", `active=${refreshUi.active}`);
check("B7 aria-live 宣告已刷新", /已刷新|刷新/.test(refreshUi.announcer), `announcer=${JSON.stringify(refreshUi.announcer)}`);
check(
  "B8 390×844 出生卡不整頁下滑",
  afterCard !== null && afterCard.scrollHeight <= VIEWPORT.height + 1,
  `scrollHeight=${afterCard?.scrollHeight}`
);

await perfContext.close();

/* ------------------------------------------------------------------ *
 * C. fresh context 語系（兩個獨立 context，固定 seed 比對 hash）
 * ------------------------------------------------------------------ */
async function localeRun(seedUrl) {
  const { context, page } = await throttledContext();
  await page.goto(seedUrl, { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(
      () => document.querySelector('.p3e-birth-screen[data-p3e-live="true"]') !== null,
      { timeout: 60000 }
    )
    .catch(() => {});
  const initial = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    stored: window.localStorage.getItem("p3e.locale.v1"),
    certificate: document.querySelector('.p3e-birth-screen[data-p3e-live="true"]')?.dataset.p3eBirthCertificateHash ?? "",
    identity: document.querySelector('.p3e-birth-screen[data-p3e-live="true"]')?.dataset.p3eBirthIdentityHash ?? "",
    seed: document.querySelector('.p3e-birth-screen[data-p3e-live="true"]')?.dataset.p3eBirthSeed ?? ""
  }));
  const initialText = await visibleText(page);
  await context.close();
  return { initial, initialText };
}

const seedUrl = `${baseUrl}?seed=${encodeURIComponent(FIXED_SEED)}`;
const first = await localeRun(seedUrl);
check("C1 fresh context 預設 zh-CN", first.initial.lang === "zh-CN", `lang=${first.initial.lang}`);
const mixedAtDefault = traditionalIn(first.initialText);
check("C2 預設畫面沒有繁體殘留（簡繁混合）", mixedAtDefault.length === 0, `chars=${mixedAtDefault.join("") || "none"}`);

// 同一 context 內切換、重整、切回、再重整。
const { context: localeContext, page: localePage } = await throttledContext();
await localePage.goto(seedUrl, { waitUntil: "domcontentloaded" });
await localePage
  .waitForFunction(() => document.querySelector('.p3e-birth-screen[data-p3e-live="true"]') !== null, { timeout: 60000 })
  .catch(() => {});
await localePage.click("#p3e-locale-toggle");
await localePage.waitForTimeout(200);
const afterSwitch = await localePage.evaluate(() => ({
  lang: document.documentElement.lang,
  stored: window.localStorage.getItem("p3e.locale.v1")
}));
const twCard = await localePage.evaluate(() => ({
  certificate: document.querySelector('.p3e-birth-screen[data-p3e-live="true"]')?.dataset.p3eBirthCertificateHash ?? "",
  identity: document.querySelector('.p3e-birth-screen[data-p3e-live="true"]')?.dataset.p3eBirthIdentityHash ?? "",
  seed: document.querySelector('.p3e-birth-screen[data-p3e-live="true"]')?.dataset.p3eBirthSeed ?? ""
}));
const twText = await visibleText(localePage);
// 只放真正的簡體專用詞；「刷新出生」簡繁同形，放進來會造成假陽性。
const simplifiedInTw = ["开始人生", "年龄", "资产", "婴儿", "人生纪录", "情感状态", "暂停", "知识", "准备人生"].filter(
  (word) => twText.includes(word)
);
await localePage.reload({ waitUntil: "domcontentloaded" });
await localePage
  .waitForFunction(() => document.querySelector('.p3e-birth-screen[data-p3e-live="true"]') !== null, { timeout: 60000 })
  .catch(() => {});
const afterReloadTw = await localePage.evaluate(() => document.documentElement.lang);
await localePage.click("#p3e-locale-toggle");
await localePage.waitForTimeout(200);
const backToCn = await localePage.evaluate(() => document.documentElement.lang);
await localePage.reload({ waitUntil: "domcontentloaded" });
await localePage
  .waitForFunction(() => document.querySelector('.p3e-birth-screen[data-p3e-live="true"]') !== null, { timeout: 60000 })
  .catch(() => {});
const finalCn = await localePage.evaluate(() => document.documentElement.lang);
const cnText = await visibleText(localePage);
const mixedAtFinal = traditionalIn(cnText);
await localeContext.close();

check("C3 切 zh-TW 後 lang/localStorage 正確", afterSwitch.lang === "zh-TW" && afterSwitch.stored === "zh-TW",
  JSON.stringify(afterSwitch));
check("C4 zh-TW 重整仍是 zh-TW", afterReloadTw === "zh-TW", `lang=${afterReloadTw}`);
check("C5 zh-TW 畫面沒有簡體殘留", simplifiedInTw.length === 0, `words=${simplifiedInTw.join(",") || "none"}`);
check("C6 切回 zh-CN 並重整仍是 zh-CN", backToCn === "zh-CN" && finalCn === "zh-CN", `switch=${backToCn} reload=${finalCn}`);
check("C7 切回後仍無繁體殘留", mixedAtFinal.length === 0, `chars=${mixedAtFinal.join("") || "none"}`);
check(
  "C8 語系不改 seed / certificate / identity hash",
  first.initial.seed === twCard.seed &&
    first.initial.certificate === twCard.certificate &&
    first.initial.identity === twCard.identity &&
    first.initial.certificate.length > 0,
  `seed=${first.initial.seed} cert=${first.initial.certificate.slice(0, 12)} vs ${twCard.certificate.slice(0, 12)}`
);
// 靜態證據：語系單字表本身是否有缺口（不依賴隨機國家名）。
const localeGaps = [..."亞與納臺"].filter((char) => !HANT_SCAN.mapped.has(char));
check(
  "C9 語系單字表覆蓋常見繁體字（國名等專有名詞）",
  localeGaps.length === 0,
  `未映射=${localeGaps.join("") || "none"}; 已映射配對=${HANT_SCAN.mappedCount}`
);

await BROWSER.close();
await new Promise((done) => server.close(done));

const failed = checks.filter((item) => !item.ok);
const report = {
  generatedAt: new Date().toISOString(),
  condition: perf.condition,
  limits: {
    interactiveMs: LIMIT_INTERACTIVE_MS,
    beforeBytes: LIMIT_BEFORE_BYTES,
    birthJsonRequests: LIMIT_BIRTH_JSON_REQUESTS
  },
  perf,
  hantScan: {
    mappedPairs: HANT_SCAN.mappedCount,
    scanChars: HANT_SCAN.scan.size,
    unmappedCommonChars: localeGaps
  },
  refresh: { beforeCard, afterCard, requestCountBeforeRefresh, requestCountAfterRefresh: perfRequests.length, clickResult, refreshUi },
  locale: {
    first: { initial: first.initial, traditionalChars: mixedAtDefault },
    afterSwitch,
    afterReloadTw,
    backToCn,
    finalCn,
    simplifiedInTw,
    traditionalAtFinal: mixedAtFinal,
    twCard
  },
  checks,
  failed: failed.length,
  total: checks.length
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`SUMMARY ${checks.length - failed.length}/${checks.length} PASS report=${reportPath}`);
if (failed.length > 0) {
  console.error("P3E-0064B-INDEPENDENT-FAIL\n" + failed.map((item) => `${item.name}: ${item.detail}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("P3E-0064B-INDEPENDENT-OK");
}
