import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

const EXPECTED_STATE_HASH = "9418bd66908eed8abaae458ccf914af43cbca730eb0b9fb73937f9232480eb48";
const EXPECTED_COMMAND_HEAD = "cf0cc74720628ad5aa5fd367241b8b43b530802187ad2f5ff12a57a00b28b60f";
const EXPECTED_COMMANDS = 51;
const BOOT_BUDGET_GZIP = 500 * 1024;
/**
 * 官方 golden（state hash／command head）建立在這個 seed 上。
 * GPT-0017-E：全新使用者首次開頁已改為安全隨機 seed，所以所有需要決定性的
 * 流程都必須明確用 `?seed=GOLDEN_SEED` 開頁，不再依賴「乾淨啟動固定 seed」。
 */
const GOLDEN_SEED = "p3e-166-playable-runtime-v4";
const GOLDEN_QUERY = `?seed=${encodeURIComponent(GOLDEN_SEED)}`;

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

async function clickAndWait(page, selector) {
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
      ["next_step", ".p3e-controls"],
      ["bottom_nav", ".p3e-tabs"]
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
    return { ok: fitted && statItems === 4, height, statItems, rects };
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
      ".p3e-time-controls button",
      ".p3e-tab",
      ".p3e-birth-actions button",
      ".p3e-tools > summary"
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
  // 主線要跑官方 51 命令 golden：明確釘住 seed，不受首次開頁隨機 seed 影響。
  await page.goto(`${baseUrl}/${GOLDEN_QUERY}`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
  const bootMs = Date.now() - bootStarted;
  const boot = await measureAssets([...bootRequests.keys()]);

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
  const missingBirthLabels = requiredBirthLabels.filter((label) => !birthLabels.includes(label));
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

  // 出生卡在三個尺寸下也不得讓 document／body 捲動；超出的資訊只能卡內捲。
  if (birthVisible) {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 430, height: 932 },
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

  // 重新抽取在獨立分頁做，避免污染官方 51 命令的決定性路徑。
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
  check(
    "birth_start_enters_age0",
    (!birthVisible || startedFromBirth) &&
      phaseAfterStart === "life" &&
      (bodyText.includes("年齡 0") || bodyText.includes("0 歲")),
    `birth_card=${birthVisible} start_clicked=${startedFromBirth} phase=${phaseAfterStart}`
  );

  // 1. 預設路徑是 real runtime，不是 fixture 文案
  check("default_is_real_not_fixture", !bodyText.includes("靜態選擇") && !bodyText.includes("固定後果"));
  check("default_uses_real_session", phaseAfterStart === "life");

  // 2. age 0 / life
  check(
    "age0_life_initial",
    (bodyText.includes("年齡 0") || bodyText.includes("0 歲")) && phaseAfterStart === "life"
  );

  // 3. controls 跟 phase
  const advance = page.locator('[data-action="advance"]');
  check("controls_follow_phase_life", (await advance.count()) === 1 && (await advance.isEnabled()));

  // 4. 跑到 pending_decision
  let guard = 0;
  while ((await phaseOf(page)) !== "pending_decision" && guard < 200) {
    await clickAndWait(page, '[data-action="advance"]');
    guard += 1;
  }
  check("reached_pending_decision", (await phaseOf(page)) === "pending_decision");
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

  check("run_to_death", finalPhase === "death", `phase=${finalPhase}`);
  check(
    "death_shows_real_outcome",
    (deathText.includes("reason") && (deathText.includes("mortality") || deathText.includes("age_ceiling"))) ||
      (deathText.includes("這段人生走到了終點") && deathText.includes("你活了"))
  );
  check("run_to_death_with_51_commands", finalCount === EXPECTED_COMMANDS, `commands=${finalCount}`);
  check("final_state_hash", finalStateHash === EXPECTED_STATE_HASH, finalStateHash ?? "null");
  check("final_command_head", finalHead === EXPECTED_COMMAND_HEAD, finalHead ?? "null");

  // 7. 重生（若重生回到出生卡，先按開始再驗證 0 歲）
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
    (rebirthText.includes("年齡 0") || rebirthText.includes("0 歲")) && (await commandCount(page)) === 0
  );

  // 8. 三個手機尺寸：水平／垂直溢出皆為 0，七個區塊同屏、觸控區 >=44px
  await ensurePlayable(page);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 430, height: 932 },
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
      `viewport_${label}_all_seven_sections_visible`,
      layout.ok,
      JSON.stringify(layout.rects)
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

  // 10. boot 資產預算（含第一次可玩畫面前的 JSON pack）
  check(
    "boot_required_gzip_under_500kb",
    boot.boot_required_gzip < BOOT_BUDGET_GZIP,
    `${boot.boot_required_gzip} < ${BOOT_BUDGET_GZIP}`
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

  async function newScenarioPage(initScript) {
    const scenarioContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    if (initScript !== undefined) await scenarioContext.addInitScript(initScript);
    const scenarioPage = await scenarioContext.newPage();
    return { scenarioContext, scenarioPage };
  }

  /**
   * 情境開頁：預設一律用官方 golden seed，讓 autosave／reload／51 命令／
   * 匯入匯出等決定性流程不再依賴「首次開頁固定 seed」。
   * 明確傳別的字串 → 用該 seed；傳 `null` → 完全不帶 query（驗證真隨機首次開頁）。
   */
  async function openScenario(scenarioPage, seed = GOLDEN_SEED) {
    const query = seed === null ? "" : `?seed=${encodeURIComponent(seed)}`;
    await scenarioPage.goto(`${baseUrl}/${query}`, { waitUntil: "domcontentloaded" });
    await scenarioPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await ensurePlayable(scenarioPage);
    // MVP v2 把技術性存檔操作收進 details；測試情境需先展開才能點擊。
    const tools = scenarioPage.locator("details.p3e-tools");
    if ((await tools.count()) === 1) await tools.evaluate((details) => { details.open = true; });
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
    const tools = scenarioPage.locator("details.p3e-tools");
    if ((await tools.count()) === 1) await tools.evaluate((details) => { details.open = true; });
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

  // 4. death 後 reload：官方 51 逐位元一致
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    await runToPhase(scenarioPage, "death");
    const before = await readAttrs(scenarioPage);
    await reloadApp(scenarioPage);
    const after = await readAttrs(scenarioPage);
    verify(
      "death_reload_bit_exact_official51",
      before.count === 51 &&
        after.count === 51 &&
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
    const recoverButton = await scenarioPage.locator('[data-action="recover"]').count();
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
    const recoverButton = await scenarioPage.locator('[data-action="recover"]').count();
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
    const tools = scenarioPage.locator("details.p3e-tools");
    if ((await tools.count()) === 1) await tools.evaluate((details) => { details.open = true; });
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

  // 2. official 51 下載 → 新頁面上傳 → death 逐位元一致
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
      imported.count === 51 &&
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
