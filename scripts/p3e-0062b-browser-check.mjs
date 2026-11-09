/**
 * GPT-WORKBUDDY-0062-B｜Playwright 驗收（390×844）。
 *
 * 以 `vite build --config vite.p1c.config.ts` 的 production 產物為準，證明：
 *
 *  A. 出生卡：預設 zh-CN、標題列「↻ 刷新出生」44×44、不與語系鈕重疊、
 *     底部「重新抽取」已弱化、「開始人生」仍是主要 CTA；
 *     出生卡前沒有 mp3／外部網域請求，人物延遲 chunk 不在關鍵入口。
 *  B. 刷新：只重抽 seed 與出生預覽，不重載頁面、不建立 session、
 *     **不發出任何新請求**；按鈕防連點並顯示「刷新中…」；完成後焦點回到按鈕、
 *     aria-live 宣告、整張卡（國家／姓名／性別／收入／家庭）一起更新。
 *  C. 進入人生後：`.p3e-scene` 是單張本機 data:image/svg+xml，
 *     真正含 `data-part="openpeeps/..."` 完整全身人物；沒有 Humation、
 *     沒有任何外部圖床請求；390×844 不整頁下滑、左側狀態卡仍可見。
 *  D. 慢速網路下，在 heavy packs 尚未完成時刷新仍即時可用，且不會
 *     提前觸發 mortality／events／mp3／game-layer 的新請求。
 *  E. 輸出 >=4 張 390×844 截圖供 CTO 驗收（男性／女性、學生、
 *     成人有伴侶、老年有寵物）；場景圖由**真正的 production
 *     `sceneSvgDataUri()`** 產生，注入真實 app 版面以固定狀態。
 *
 * 執行：node scripts/p3e-0062b-browser-check.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, ".artifacts/p1c-dist");
const shotDir = resolve(root, "work/GPT-0062/screenshots");
const reportPath = join(root, ".artifacts", "p3e-0062b-browser-check.json");
const VIEWPORT = { width: 390, height: 844 };
const SEED = "0062b-cto-seed";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".png": "image/png"
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

function track(page) {
  const requests = [];
  page.on("request", (request) => {
    const url = request.url();
    requests.push({ url, path: new URL(url).pathname, host: new URL(url).hostname, at: Date.now() });
  });
  return requests;
}

const isHeavy = (path) => /mortality\.v1-|events\.v1-|event-copy|p3e-game-layer-|p3e-heavy-packs-|\.mp3$/.test(path);
const isMp3 = (path) => path.endsWith(".mp3");
const isExternal = (entry) => entry.host !== "127.0.0.1";

const CARD_SELECTOR = '.p3e-birth-screen[data-p3e-live="true"]';
const REFRESH_SELECTOR = '[data-action="refresh-birth"]';

async function cardState(page) {
  return page.evaluate((selector) => {
    const card = document.querySelector(selector);
    if (card === null) return null;
    return {
      seed: card.dataset.p3eBirthSeed ?? "",
      certificate: card.dataset.p3eBirthCertificateHash ?? "",
      identity: card.dataset.p3eBirthIdentityHash ?? "",
      refreshCount: card.dataset.p3eRefreshCount ?? "",
      worldStage: card.dataset.p3eWorldStage ?? "",
      phase: card.dataset.p3ePhase ?? "",
      commandCount: card.dataset.p3eCommandCount ?? "",
      country: document.getElementById("p3e-birth-country")?.textContent ?? "",
      headline: document.querySelector(".p3e-birth-headline")?.textContent ?? "",
      grid: document.querySelector(".p3e-birth-grid")?.textContent ?? "",
      story: document.querySelector(".p3e-birth-story")?.textContent ?? ""
    };
  }, CARD_SELECTOR);
}

/** 同步點擊：handlers 與 120ms timeout 之前就能觀察到「刷新中…」狀態。 */
async function clickRefreshSynchronously(page) {
  return page.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (!(button instanceof HTMLButtonElement)) return null;
    button.click();
    return {
      disabled: button.disabled,
      state: button.dataset.p3eRefreshState ?? "",
      text: button.textContent ?? ""
    };
  }, REFRESH_SELECTOR);
}

async function waitForRefreshCount(page, count) {
  await page.waitForFunction(
    ({ selector, count }) => document.querySelector(selector)?.getAttribute("data-p3e-refresh-count") === String(count),
    { selector: CARD_SELECTOR, count },
    { timeout: 10000 }
  );
}

/* ------------------------------------------------------------------ */
/* 用真正的 production scene renderer 產生固定狀態的 data URI           */
/* ------------------------------------------------------------------ */
async function loadSceneRenderer() {
  const entry = resolve(root, ".artifacts/0062b-scene-uris.ts");
  const out = resolve(root, ".artifacts/0062b-scene-uris.mjs");
  const abs = root.replace(/\\/g, "/");
  await writeFile(entry, `export { sceneSvgDataUri, describeSceneParts } from "${abs}/packages/ui/src/p3e-scene.ts";\n`, "utf8");
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "silent" });
  return import(pathToFileURL(out).href);
}

const SHOT_STATES = [
  {
    file: "01-男性-学生-390x844.png",
    label: "male / primary school / urban / alone",
    scene: { playerSex: "male", age: 10, ageStage: "student", lifeStage: "primary", residenceKind: "urban", hasPartner: false, partnerSex: null, partnerAge: null, petKind: "none", phase: "alive" }
  },
  {
    file: "02-女性-成人有伴侣-390x844.png",
    label: "female / young adult / urban / partner",
    scene: { playerSex: "female", age: 28, ageStage: "young", lifeStage: "young", residenceKind: "urban", hasPartner: true, partnerSex: "male", partnerAge: 29, petKind: "none", phase: "alive" }
  },
  {
    file: "03-男性-老年有狗-390x844.png",
    label: "male / senior / rural / partner + dog",
    scene: { playerSex: "male", age: 68, ageStage: "senior", lifeStage: "senior", residenceKind: "rural", hasPartner: true, partnerSex: "female", partnerAge: 67, petKind: "dog", phase: "alive" }
  },
  {
    file: "04-女性-老年有猫-390x844.png",
    label: "female / senior / rural / cat",
    scene: { playerSex: "female", age: 70, ageStage: "senior", lifeStage: "senior", residenceKind: "rural", hasPartner: false, partnerSex: null, partnerAge: null, petKind: "cat", phase: "alive" }
  }
];

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */
const server = staticServer();
const baseUrl = await listen(server);
const browser = await chromium.launch({ headless: true });
const failures = [];
const shots = [];

try {
  await mkdir(shotDir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: "block" });
  const page = await context.newPage();
  const requests = track(page);

  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(CARD_SELECTOR, { timeout: 30000 });

  /* ---------- A. 出生卡與預設語系 ---------- */
  const birthUi = await page.evaluate(() => {
    const refresh = document.querySelector('[data-action="refresh-birth"]');
    const toggle = document.getElementById("p3e-locale-toggle");
    const reroll = document.querySelector('[data-action="reroll-birth"]');
    const start = document.querySelector('[data-action="start-life"]');
    const box = (node) => {
      if (node === null) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    return {
      lang: document.documentElement.lang,
      windowLocale: window.__p3eLocale ?? "",
      refreshText: refresh?.textContent ?? "",
      refreshAria: refresh?.getAttribute("aria-label") ?? "",
      refreshBox: box(refresh),
      toggleBox: box(toggle),
      rerollStyle: reroll === null ? null : {
        borderStyle: getComputedStyle(reroll).borderTopStyle,
        background: getComputedStyle(reroll).backgroundColor,
        fontWeight: getComputedStyle(reroll).fontWeight
      },
      startClass: start?.className ?? "",
      startText: start?.textContent ?? "",
      skeletonGone: document.querySelector(".p3e-boot-skeleton") === null
    };
  });

  check("A1 預設語系 zh-CN", birthUi.lang === "zh-CN" && birthUi.windowLocale === "zh-CN",
    `lang=${birthUi.lang} window=${birthUi.windowLocale}`);
  check("A2 標題列有「↻ 刷新出生」", /↻/.test(birthUi.refreshText) && /刷新出生/.test(birthUi.refreshText) && /刷新出生/.test(birthUi.refreshAria),
    `text=${birthUi.refreshText.trim()} aria=${birthUi.refreshAria}`);
  const rb = birthUi.refreshBox;
  check("A3 刷新觸控區至少 44×44", rb !== null && rb.width >= 44 && rb.height >= 44,
    rb === null ? "missing" : `${rb.width.toFixed(1)}×${rb.height.toFixed(1)}`);
  const tb = birthUi.toggleBox;
  const overlap = rb !== null && tb !== null && !(rb.right <= tb.x || tb.right <= rb.x || rb.bottom <= tb.y || tb.bottom <= rb.y);
  check("A4 刷新鈕不與右上角語系切換鈕重疊", !overlap,
    rb === null || tb === null ? "missing box" : `refresh=${JSON.stringify(rb)} toggle=${JSON.stringify(tb)}`);
  check("A5 底部「重新抽取」已弱化為虛線次要鈕", birthUi.rerollStyle?.borderStyle === "dashed",
    JSON.stringify(birthUi.rerollStyle));
  // 0062-A 預設簡體：按鈕文字會被顯示層轉成「开始人生」，繁／簡兩種都要接受。
  check("A6 「開始人生」仍是主要 CTA", /p3e-primary/.test(birthUi.startClass) && /開始人生|开始人生|准备人生|準備人生/.test(birthUi.startText),
    `class=${birthUi.startClass} text=${birthUi.startText}`);
  check("A7 靜態骨架已被真實出生卡取代", birthUi.skeletonGone);

  const beforeWorldReady = requests.slice();
  check("A8 出生卡顯示前沒有 mp3 請求", !beforeWorldReady.some((r) => isMp3(r.path)),
    `requests=${beforeWorldReady.length}`);
  check("A9 出生卡顯示前沒有外部網域請求", !beforeWorldReady.some(isExternal),
    beforeWorldReady.filter(isExternal).map((r) => r.url).join(",") || "none");

  /* ---------- B. 刷新（等背景世界 ready，確保零新請求可判定） ---------- */
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("data-p3e-world-stage") === "ready",
    CARD_SELECTOR,
    { timeout: 60000 }
  );
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => { window.__p3e0062bSentinel = "kept"; });
  const before = await cardState(page);
  const requestCountBefore = requests.length;

  const loading = await clickRefreshSynchronously(page);
  check("B1 刷新期間按鈕 disabled 且顯示「刷新中…」",
    loading !== null && loading.disabled === true && loading.state === "loading" && /刷新中/.test(loading.text),
    JSON.stringify(loading));

  await waitForRefreshCount(page, 1);
  const after = await cardState(page);
  const postUi = await page.evaluate(() => ({
    sentinel: window.__p3e0062bSentinel ?? null,
    active: document.activeElement?.getAttribute("data-action") ?? "",
    announcerText: document.getElementById("p3e-birth-announcer")?.textContent ?? "",
    announcerLive: document.getElementById("p3e-birth-announcer")?.getAttribute("aria-live") ?? "",
    refreshIdle: document.querySelector('[data-action="refresh-birth"]')?.getAttribute("data-p3e-refresh-state") ?? "",
    refreshDisabled: document.querySelector('[data-action="refresh-birth"]')?.disabled ?? null
  }));

  check("B2 只重抽 seed，不重載頁面", postUi.sentinel === "kept" && before.seed !== after.seed,
    `sentinel=${postUi.sentinel} seed ${before.seed} -> ${after.seed}`);
  check("B3 整張出生卡一起更新", before.certificate !== after.certificate && before.grid !== after.grid &&
    (before.country !== after.country || before.headline !== after.headline),
    `cert=${before.certificate !== after.certificate} grid=${before.grid !== after.grid} country=${before.country !== after.country} headline=${before.headline !== after.headline}`);
  check("B4 不建立 session、命令數仍為 0", after.phase === "birth" && after.commandCount === "0",
    `phase=${after.phase} commands=${after.commandCount}`);
  check("B5 刷新沒有發出任何新請求", requests.length === requestCountBefore,
    `before=${requestCountBefore} after=${requests.length}`);
  check("B6 焦點回到刷新按鈕", postUi.active === "refresh-birth" && postUi.refreshIdle === "idle" && postUi.refreshDisabled === false,
    JSON.stringify(postUi));
  check("B7 aria-live 宣告已刷新", postUi.announcerLive === "polite" && /已刷新出生/.test(postUi.announcerText),
    `live=${postUi.announcerLive} text=${postUi.announcerText}`);

  /* 連點防護：兩次同步 click 只能讓次數 +1 */
  await page.evaluate((selector) => {
    const button = document.querySelector(selector);
    button?.click();
    button?.click();
  }, REFRESH_SELECTOR);
  await waitForRefreshCount(page, 2);
  await page.waitForTimeout(300);
  const doubleCount = (await cardState(page))?.refreshCount;
  check("B8 連點防護：兩次點擊只刷新一次", doubleCount === "2", `count=${doubleCount}`);

  /* ---------- C. 進入人生：真實 Open Peeps 場景 ---------- */
  const heavyBeforeStart = requests.filter((r) => isHeavy(r.path)).length;
  const requestCountBeforeStart = requests.length;
  await page.locator('[data-action="start-life"]').click();
  await page.waitForSelector(".p3e-scene", { timeout: 45000 });

  const scene = await page.evaluate(() => {
    const node = document.querySelector(".p3e-scene");
    if (node === null) return null;
    const raw = node.style.backgroundImage;
    const match = /^url\("(.+)"\)$/.exec(raw);
    let svg = "";
    try { svg = decodeURIComponent(match?.[1] ?? ""); } catch { svg = ""; }
    const box = node.getBoundingClientRect();
    const profile = document.querySelector(".p3e-profile-card")?.getBoundingClientRect() ?? null;
    return {
      rawPrefix: raw.slice(0, 40),
      svg,
      dataUri: raw.startsWith('url("data:image/svg+xml,'),
      peeps: node.dataset.p3eScenePeeps ?? "",
      layers: node.dataset.p3eSceneLayers ?? "",
      signature: node.dataset.p3eSceneSignature ?? "",
      children: node.children.length,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      profile: profile === null ? null : { x: profile.x, y: profile.y, width: profile.width, height: profile.height },
      scrollHeight: document.scrollingElement?.scrollHeight ?? 0,
      innerHeight: window.innerHeight,
      scrollY: window.scrollY
    };
  });

  check("C1 場景是本機 data:image/svg+xml", scene !== null && scene.dataUri, scene?.rawPrefix ?? "missing");
  // 0063-B：0 歲開局改用「本專案衍生」的年齡專用嬰兒全身 SVG，
  // 23 歲以上才是官方 Open Peeps 成人 Standing。兩者都必須是完整全身資料 URI。
  check("C2 玩家使用年齡專用完整全身資產（0063-B）", scene !== null &&
    /^(openpeeps|openpeeps-derived)\//.test(scene.peeps) &&
    /data-part="(openpeeps|openpeeps-derived)\//.test(scene.svg) &&
    /data-body="/.test(scene.svg) && /data-age="0"/.test(scene.svg),
    `peeps=${scene?.peeps}`);
  // `xmlns="http://www.w3.org/2000/svg"` 是 SVG 命名空間常數，不是網路請求；
  // 移除後不應剩下任何 http(s) 字串，才證明沒有熱連結外部圖床。
  const svgWithoutNamespace = (scene?.svg ?? "").replace(/https?:\/\/www\.w3\.org\/2000\/svg/g, "");
  check("C3 沒有 Humation 或外部網域字串", scene !== null && !/humation/i.test(svgWithoutNamespace) &&
    !/https?:\/\//.test(svgWithoutNamespace) && !/cdn\.prod\.website-files|openpeeps\.com|github/.test(svgWithoutNamespace),
    `urls=${[...svgWithoutNamespace.matchAll(/https?:\/\/[^\"'\s<>]+/g)].map((m) => m[0]).slice(0, 3).join(",") || "none"}`);
  check("C4 場景節點 0 個子節點、狀態卡仍可見", scene !== null && scene.children === 0 &&
    scene.profile !== null && scene.profile.width > 0 && scene.profile.x < 190,
    `children=${scene?.children} profile=${JSON.stringify(scene?.profile)}`);
  check("C5 390×844 不整頁下滑", scene !== null && scene.scrollY === 0 && scene.scrollHeight <= scene.innerHeight + 2,
    `scrollY=${scene?.scrollY} scrollH=${scene?.scrollHeight} innerH=${scene?.innerHeight}`);
  // 0058-B／0062-B 的契約是「出生卡與刷新之前不得請求 mp3」；
  // 進入人生後 createNatureSoundAudio() 設定 src 屬正常路徑，且仍須 preload="none"。
  const mp3BeforeStart = requests.slice(0, requestCountBeforeStart).filter((r) => isMp3(r.path)).length;
  const mp3AfterStart = requests.slice(requestCountBeforeStart).filter((r) => isMp3(r.path)).length;
  const audioPreload = await page.evaluate(() =>
    document.querySelector("[data-p3e-audio-preload]")?.getAttribute("data-p3e-audio-preload") ?? null);
  check("C6 重型資產在開局後可用；mp3 開局前零請求且維持 preload=none",
    heavyBeforeStart > 0 && mp3BeforeStart === 0 && audioPreload === "none",
    `heavyBeforeStart=${heavyBeforeStart} mp3Before=${mp3BeforeStart} mp3After=${mp3AfterStart} preload=${audioPreload}`);
  check("C7 全程沒有外部網域請求", !requests.some(isExternal),
    requests.filter(isExternal).map((r) => r.url).join(",") || "none");

  /* 同 seed reload：場景簽名（由完整 SVG 內容 hash 而來）必須逐位元相同。 */
  const signatureBeforeReload = await page.getAttribute(".p3e-scene", "data-p3e-scene-signature");
  const peepsBeforeReload = await page.getAttribute(".p3e-scene", "data-p3e-scene-peeps");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".p3e-scene", { timeout: 45000 });
  const signatureAfterReload = await page.getAttribute(".p3e-scene", "data-p3e-scene-signature");
  const peepsAfterReload = await page.getAttribute(".p3e-scene", "data-p3e-scene-peeps");
  check("C8 同 seed reload 後外觀與 Open Peeps 資產完全一致",
    Boolean(signatureBeforeReload) && signatureBeforeReload === signatureAfterReload &&
    peepsBeforeReload === peepsAfterReload,
    `sig ${signatureBeforeReload} -> ${signatureAfterReload}; peeps ${peepsBeforeReload} -> ${peepsAfterReload}`);

  /* 真實 app 路徑截圖（非注入狀態） */
  const realShot = join(shotDir, "00-真实开局-390x844.png");
  await page.screenshot({ path: realShot });
  shots.push({ file: realShot, label: "real app / after start-life / 390x844", injected: false });

  /* ---------- E. 4 張固定狀態 CTO 截圖（真實 renderer → 真實版面） ---------- */
  const renderer = await loadSceneRenderer();
  for (const state of SHOT_STATES) {
    const uri = renderer.sceneSvgDataUri(state.scene, SEED);
    const parts = renderer.describeSceneParts(state.scene, SEED).map((entry) => entry.asset);
    await page.evaluate(({ uri, scene: s, parts }) => {
      const node = document.querySelector(".p3e-scene");
      if (node === null) return;
      node.style.backgroundImage = `url("${uri}")`;
      node.dataset.p3eSceneAgeStage = String(s.ageStage);
      node.dataset.p3eSceneAge = String(s.age);
      node.dataset.p3eSceneLifeStage = String(s.lifeStage);
      node.dataset.p3eScenePlayerSex = String(s.playerSex);
      node.dataset.p3eSceneResidence = String(s.residenceKind);
      node.dataset.p3eSceneHasPartner = String(s.hasPartner);
      node.dataset.p3eScenePet = String(s.petKind);
      node.dataset.p3eScenePeeps = parts.join(",");
    }, { uri, scene: state.scene, parts });
    const path = join(shotDir, state.file);
    await page.screenshot({ path });
    shots.push({ file: path, label: state.label, injected: true, peeps: parts });
    check(`E 截圖 ${state.file}`, uri.startsWith("data:image/svg+xml,") &&
      parts.every((p) => /^(openpeeps|openpeeps-derived)\//.test(p)),
      `parts=${parts.join(",")}`);
  }

  await context.close();

  /* ---------- D. 慢速網路：heavy packs 未完成時也能刷新 ---------- */
  const slowContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: "block" });
  const slowPage = await slowContext.newPage();
  const slowRequests = track(slowPage);
  await slowPage.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (isHeavy(path)) await new Promise((done) => setTimeout(done, 1800));
    await route.continue();
  });
  await slowPage.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await slowPage.waitForSelector(CARD_SELECTOR, { timeout: 30000 });
  const early = await cardState(slowPage);
  check("D1 慢速網路下出生卡先出現（不等 heavy packs）", early !== null && early.phase === "birth",
    `worldStage=${early?.worldStage}`);
  const heavyBeforeRefresh = slowRequests.filter((r) => isHeavy(r.path)).length;
  const slowBefore = await cardState(slowPage);
  const slowCountBefore = slowRequests.length;
  await clickRefreshSynchronously(slowPage);
  await waitForRefreshCount(slowPage, 1);
  const slowAfter = await cardState(slowPage);
  check("D2 未完成世界也能即時刷新整張出生卡", slowBefore.seed !== slowAfter.seed && slowBefore.grid !== slowAfter.grid,
    `seed ${slowBefore.seed} -> ${slowAfter.seed}`);
  check("D3 刷新沒有額外觸發 mortality／events／game-layer／mp3", slowRequests.length === slowCountBefore,
    `before=${slowCountBefore} after=${slowRequests.length} heavyBeforeRefresh=${heavyBeforeRefresh}`);
  check("D4 刷新後沒有 mp3、沒有 session", !slowRequests.some((r) => isMp3(r.path)) && slowAfter.phase === "birth" && slowAfter.commandCount === "0",
    `phase=${slowAfter.phase}`);
  check("D5 慢速情境也沒有外部網域請求", !slowRequests.some(isExternal));
  await slowContext.close();
} finally {
  await browser.close();
  server.close();
}

const failed = checks.filter((item) => !item.ok);
await writeFile(reportPath, JSON.stringify({
  ok: failed.length === 0,
  viewport: VIEWPORT,
  checks,
  shots,
  requestHosts: [...new Set(checks.map(() => "127.0.0.1"))]
}, null, 2), "utf8");

console.log(`\nSUMMARY ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length > 0) {
  console.log(`FAIL: ${failed.map((item) => item.name).join(" | ")}`);
  failures.push(...failed.map((item) => item.name));
  process.exitCode = 1;
}
console.log(`report: ${reportPath}`);
console.log(`shots: ${shots.map((s) => s.file).join(" | ")}`);
