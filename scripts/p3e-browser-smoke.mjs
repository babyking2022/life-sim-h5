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

const results = [];
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
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
  const bootMs = Date.now() - bootStarted;
  const boot = await measureAssets([...bootRequests.keys()]);

  // 1. 預設路徑是 real runtime，不是 fixture 文案
  const bodyText = (await page.locator("body").innerText()) ?? "";
  check("default_is_real_not_fixture", !bodyText.includes("靜態選擇") && !bodyText.includes("固定後果"));
  check("default_uses_real_session", (await phaseOf(page)) === "life");

  // 2. age 0 / life
  check("age0_life_initial", bodyText.includes("年齡 0") && (await phaseOf(page)) === "life");

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
    deathText.includes("reason") && (deathText.includes("mortality") || deathText.includes("age_ceiling"))
  );
  check("run_to_death_with_51_commands", finalCount === EXPECTED_COMMANDS, `commands=${finalCount}`);
  check("final_state_hash", finalStateHash === EXPECTED_STATE_HASH, finalStateHash ?? "null");
  check("final_command_head", finalHead === EXPECTED_COMMAND_HEAD, finalHead ?? "null");

  // 7. 重生
  await page.locator('[data-action="rebirth"]').click();
  await page.waitForSelector("[data-p3e-phase='life']", { timeout: 20000 });
  const rebirthText = (await page.locator("body").innerText()) ?? "";
  check("rebirth_returns_age0", rebirthText.includes("年齡 0") && (await commandCount(page)) === 0);

  // 8. 三個窄幅 viewport 不得水平溢出
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 430, height: 932 }
  ]) {
    await page.setViewportSize(viewport);
    const overflow = await horizontalOverflow(page);
    check(
      `viewport_${viewport.width}x${viewport.height}_no_horizontal_overflow`,
      overflow <= 1,
      `overflow=${overflow}`
    );
  }

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

  async function openScenario(scenarioPage, seed) {
    const query = seed === undefined ? "" : `?seed=${encodeURIComponent(seed)}`;
    await scenarioPage.goto(`${baseUrl}/${query}`, { waitUntil: "domcontentloaded" });
    await scenarioPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
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

  // 9. 重生：舊死亡存檔被新存檔取代
  {
    const { scenarioContext, scenarioPage } = await newScenarioPage();
    await openScenario(scenarioPage);
    await runToPhase(scenarioPage, "death");
    const deathRaw = await readStoredSave(scenarioPage);
    await scenarioPage.locator('[data-action="rebirth"]').click();
    await scenarioPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-command-count") === "0",
      undefined,
      { timeout: 20000 }
    );
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
      `count=${reborn.count}`
    );
    await scenarioContext.close();
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
      await perfPage.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
      await perfPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
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
