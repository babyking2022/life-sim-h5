import { chromium, webkit } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, ".artifacts/p1c-dist");
const buildId = process.env.P1C_BUILD_ID ?? "p1c1-20261027";
const outDir = resolve(root, "artifacts/ui", buildId);
const reportDir = resolve(root, "reports");
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const viewports = [
  { width: 320, height: 568, label: "320x568" },
  { width: 360, height: 640, label: "360x640" },
  { width: 390, height: 844, label: "390x844" },
  { width: 430, height: 932, label: "430x932" }
];

const screens = [
  { key: "life", route: "life", file: "ui-01-life" },
  { key: "choice", route: "choice", file: "ui-02-choice" },
  { key: "family", route: "family", file: "ui-03-family" },
  { key: "work", route: "work", file: "ui-04-work" },
  { key: "map", route: "map", file: "ui-05-map" },
  { key: "settings", route: "settings", file: "ui-06-settings" },
  { key: "death", route: "death", file: "ui-07-death" }
];

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
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("server address"));
      else resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

/* ------------------------------------------------------------------ */
/* page helpers                                                       */
/* ------------------------------------------------------------------ */

async function waitForUi(page) {
  await page.waitForSelector("#app .app-shell", { state: "visible" });
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
  await page.waitForTimeout(120);
}

/**
 * Single authoritative measurement pass. Everything the acceptance ticket
 * asks for is computed here: overflow, clipped/ellipsis text, font sizes,
 * tap targets, next/tab/scene sizes, dock geometry and 480px shell width.
 */
async function measure(page) {
  return page.evaluate(() => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (node.closest(".sr-only") || node.closest("[hidden]")) return false;
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node || !isVisible(node)) return null;
      const box = node.getBoundingClientRect();
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        bottom: Math.round(box.bottom),
        right: Math.round(box.right)
      };
    };
    const hasOwnText = (node) => Array.from(node.childNodes).some((child) => child.nodeType === 3 && (child.textContent ?? "").trim().length > 0);

    const minTextViolations = [];
    const bodyViolations = [];
    const headingViolations = [];
    const bodySelectors = "p, .card-lines p, .sheet-intro, .panel-intro, .panel-footnote, .moment-card p, .member-copy p, .empty-state p, .detail-note, .relation-head, .job-card p, .place-card p, .opening-card p, .setting-copy span";
    const headingSelectors = "h1, h2, h3, .section-head h2, .death-hero h1";

    for (const node of document.querySelectorAll("body *")) {
      if (!isVisible(node) || !hasOwnText(node)) continue;
      const size = parseFloat(getComputedStyle(node).fontSize);
      const label = (node.textContent ?? "").trim().slice(0, 24);
      if (size < 11.5) minTextViolations.push({ tag: node.tagName, className: String(node.className).slice(0, 40), size, text: label });
      if (node.matches(bodySelectors) && size < 13.5) bodyViolations.push({ tag: node.tagName, size, text: label });
      if (node.matches(headingSelectors) && size < 17.5) headingViolations.push({ tag: node.tagName, size, text: label });
    }

    const smallTapTargets = [];
    for (const node of document.querySelectorAll("button, [role='tab'], a[href], [role='switch']")) {
      if (!isVisible(node)) continue;
      const box = node.getBoundingClientRect();
      if (box.width < 43.5 || box.height < 43.5) {
        smallTapTargets.push({
          label: ((node.textContent ?? "").trim() || node.getAttribute("aria-label") || node.dataset.action || "").slice(0, 20),
          width: Math.round(box.width),
          height: Math.round(box.height)
        });
      }
    }

    const clipped = [];
    const ellipsis = [];
    for (const node of document.querySelectorAll("h1,h2,h3,p,strong,span,button,small,blockquote,dt,dd")) {
      if (!isVisible(node) || !hasOwnText(node)) continue;
      const style = getComputedStyle(node);
      if (style.textOverflow === "ellipsis") ellipsis.push((node.textContent ?? "").trim().slice(0, 24));
      const clips = style.overflowX !== "visible";
      if (clips && node.scrollWidth > node.clientWidth + 1) {
        clipped.push({ text: (node.textContent ?? "").trim().slice(0, 24), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth });
      }
    }

    const criticalText = [];
    for (const selector of ["[data-year]", "[data-assets]", "[data-income]", ".stat-label", ".next-label", ".tab span", ".next-button", ".metric-value"]) {
      for (const node of document.querySelectorAll(selector)) {
        if (!isVisible(node)) continue;
        const style = getComputedStyle(node);
        if (style.textOverflow === "ellipsis" || node.scrollWidth > node.clientWidth + 1) {
          criticalText.push({ selector, text: (node.textContent ?? "").trim().slice(0, 24), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth });
        }
      }
    }

    const tabs = Array.from(document.querySelectorAll("[data-tab]")).map((node) => rect(`[data-tab="${node.getAttribute("data-tab")}"]`));
    const buttonOverlap = tabs.some((a, index) =>
      tabs.slice(index + 1).some((b) => a && b && a.right > b.x + 1 && b.right > a.x + 1 && a.bottom > b.y + 1 && b.bottom > a.y + 1)
    );

    const nextBox = rect(".next-button");
    const tabBox = rect("[data-tab='life']");
    const sceneBox = rect(".scene-frame");
    const dockBox = rect(".bottom-stack");

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      verticalScrollable: document.documentElement.scrollHeight > window.innerHeight + 2,
      minTextViolations,
      bodyViolations,
      headingViolations,
      smallTapTargets,
      clipped,
      ellipsis,
      criticalText,
      buttonOverlap,
      boxes: {
        topbar: rect(".topbar"),
        stage: rect(".stage"),
        status: rect(".status-strip"),
        dock: dockBox,
        next: nextBox,
        scene: sceneBox,
        tab: tabBox,
        shell: rect(".app-shell"),
        sheet: rect("[data-sheet]:not([hidden])"),
        death: rect("[data-screen='death']:not([hidden])")
      },
      sizes: {
        nextHeight: nextBox ? nextBox.height : null,
        tabHeight: tabBox ? tabBox.height : null,
        sceneHeight: sceneBox ? sceneBox.height : null,
        shellWidth: rect(".app-shell") ? rect(".app-shell").width : null
      }
    };
  });
}

async function axeScan(page) {
  const source = await readFile(axePath, "utf8");
  await page.addScriptTag({ content: source });
  return page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const result = await axe.run(document, { resultTypes: ["violations"] });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.length,
      targets: violation.nodes.map((node) => node.target)
    }));
  });
}

/* ------------------------------------------------------------------ */
/* suites                                                             */
/* ------------------------------------------------------------------ */

async function shoot(page, relative, fullPage = false) {
  await page.screenshot({ path: resolve(root, relative), fullPage });
}

async function runScreenshotSuite(browser, baseUrl) {
  const results = [];
  for (const viewport of viewports) {
    for (const screen of screens) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/?preview=fixture&screen=${screen.route}`, { waitUntil: "networkidle" });
      await waitForUi(page);
      const metrics = await measure(page);
      const relative = `artifacts/ui/${buildId}/${screen.file}-${viewport.label}.png`;
      await shoot(page, relative);
      results.push({ viewport: viewport.label, screen: screen.key, screenshot: relative, metrics });
      await context.close();
    }
  }
  return results;
}

async function runZoomSuite(browser, baseUrl) {
  const results = [];
  for (const screen of screens) {
    const context = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/?preview=fixture&screen=${screen.route}`, { waitUntil: "networkidle" });
    await waitForUi(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page.waitForTimeout(200);
    const metrics = await measure(page);
    const relative = `artifacts/ui/${buildId}/${screen.file}-200-360x640.png`;
    /* fullPage 截圖把 sticky 元素釘在首屏，會蓋住內容；截圖時改成 static 才能看到完整版面。 */
    await page.addStyleTag({ content: ".topbar,.bottom-stack,.death-top,.death-actions{position:static !important}" });
    await page.waitForTimeout(80);
    await shoot(page, relative, true);
    results.push({ screen: screen.key, screenshot: relative, metrics });
    await context.close();
  }
  return results;
}

async function runAxeSuite(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const findings = [];
  for (const screen of screens) {
    await page.goto(`${baseUrl}/?preview=fixture&screen=${screen.route}`, { waitUntil: "networkidle" });
    await waitForUi(page);
    const violations = await axeScan(page);
    findings.push({ screen: screen.key, violations });
  }
  await context.close();
  return findings;
}

function axeHtml(violations) {
  const rows = violations
    .map((violation) => `<tr><td>${violation.impact}</td><td>${violation.id}</td><td>${violation.help}</td><td>${violation.nodes}</td><td><code>${violation.targets.map((target) => target.join(" ")).join(" | ")}</code></td></tr>`)
    .join("");
  const critical = violations.filter((violation) => violation.impact === "critical").length;
  const serious = violations.filter((violation) => violation.impact === "serious").length;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>P1-C.1 axe report</title><style>body{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;padding:24px;background:#faf4e7;color:#2f2a24}table{border-collapse:collapse;width:100%;background:#fff}th,td{padding:8px;border:1px solid #c9a473;text-align:left;vertical-align:top}code{word-break:break-all}.ok{color:#23645b;font-weight:700}.bad{color:#a72d24;font-weight:700}</style></head><body><h1>P1-C.1 axe accessibility report</h1><p class="${critical + serious === 0 ? "ok" : "bad"}">critical=${critical}, serious=${serious}, total=${violations.length}（Chromium 390x844，七畫面）</p><table><thead><tr><th>impact</th><th>id</th><th>help</th><th>nodes</th><th>targets</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No violations.</td></tr>'}</tbody></table></body></html>`;
}

/* ------------------------------------------------------------------ */
/* interactions (Chromium)                                            */
/* ------------------------------------------------------------------ */

const text = (page, selector) => page.locator(selector).first().innerText();

async function runInteractions(browser, baseUrl, makeCheck) {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const check = makeCheck("chromium");
  await page.goto(`${baseUrl}/?preview=fixture&screen=life`, { waitUntil: "networkidle" });
  await waitForUi(page);
  const year = await text(page, "[data-year]");

  /* UI-I01 tab switch keeps scroll */
  await page.locator("[data-tab='map']").click();
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.waitForTimeout(60);
  await page.locator("[data-tab='family']").click();
  await page.locator("[data-tab='map']").click();
  await page.waitForTimeout(120);
  const restored = await page.evaluate(() => Math.round(window.scrollY));
  check("UI-I01 four tabs switch and restore scroll", restored >= 100 && restored <= 140, `scrollY=${restored} (expect ~120)`);

  /* UI-I02 next only switches cards */
  await page.locator("[data-tab='life']").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  const pageBefore = await text(page, "[data-year-card] .page-count");
  await page.locator("[data-action='next']").click();
  const pageAfter = await text(page, "[data-year-card] .page-count");
  const yearAfterNext = await text(page, "[data-year]");
  check("UI-I02 next switches card only", pageBefore === "1/3" && pageAfter === "2/3" && yearAfterNext === year, `${pageBefore} -> ${pageAfter}; year ${year} -> ${yearAfterNext}`);

  await page.locator("[data-action='next']").click();
  const lastPage = await text(page, "[data-year-card] .page-count");
  const pausedLabel = await text(page, "[data-action='next'] .next-label");
  check("UI-3.1 cards exhausted -> 暂停", lastPage === "3/3" && pausedLabel === "暂停", `${lastPage}, label=${pausedLabel}`);
  await page.locator("[data-action='next']").click();
  const resumeLabel = await text(page, "[data-action='next'] .next-label");
  check("UI-3.1 paused -> 继续", resumeLabel === "继续", `label=${resumeLabel}`);
  await page.locator("[data-action='next']").click();
  const pauseAgain = await text(page, "[data-action='next'] .next-label");
  check("UI-3.1 resumed -> 暂停", pauseAgain === "暂停", `label=${pauseAgain}`);

  /* UI-I03 / I04 choice */
  await page.locator("[data-action='open-choice']").click();
  await page.waitForTimeout(120);
  const badge = await text(page, ".pause-badge-copy strong");
  const remaining = await text(page, ".pause-badge-time strong");
  const disabledBefore = await page.locator("[data-action='confirm-choice']").isDisabled();
  const hintBefore = await text(page, "[data-choice-hint]");
  await page.locator("[data-choice='study']").click();
  const pressed = await page.locator("[data-choice='study']").getAttribute("aria-pressed");
  const enabledAfter = await page.locator("[data-action='confirm-choice']").isEnabled();
  const nextBlockedLabel = await text(page, "[data-action='next'] .next-label");
  check("UI-I03 choice disabled until selected", disabledBefore && pressed === "true" && enabledAfter, `disabled=${disabledBefore}, pressed=${pressed}, enabled=${enabledAfter}, hint="${hintBefore}"`);
  check("UI-02 重大抉择显示时间已暂停", badge === "时间已暂停" && remaining === "00:00", `badge=${badge}, remaining=${remaining}`);
  check("UI-3.1 choice route drives next label", nextBlockedLabel === "确认选择", `label=${nextBlockedLabel}`);
  await page.locator("[data-action='confirm-choice']").click();
  const consequenceVisible = await page.locator("[data-consequence]").isVisible();
  const consequenceTitle = await text(page, "[data-consequence-title]");
  const yearAfterChoice = await text(page, "[data-year]");
  check("UI-I04 confirm shows static consequence", consequenceVisible && consequenceTitle.includes("升学") && yearAfterChoice === year, `visible=${consequenceVisible}, title=${consequenceTitle}, year=${yearAfterChoice}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  const focusAfterChoice = await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.action : null));
  check("UI-A02 Escape closes sheet and restores trigger focus", focusAfterChoice === "open-choice", `active=${focusAfterChoice}`);

  /* UI-I05 pause / resume */
  await page.locator("[data-action='pause']").click();
  const pausedAria = await page.locator("[data-action='pause']").getAttribute("aria-pressed");
  const pausedName = await page.locator("[data-action='pause']").getAttribute("aria-label");
  await page.locator("[data-action='pause']").click();
  const resumedAria = await page.locator("[data-action='pause']").getAttribute("aria-pressed");
  check("UI-I05 pause/resume state sync", pausedAria === "true" && pausedName === "继续" && resumedAria === "false", `pressed=${pausedAria}, label=${pausedName}`);

  /* UI-I06 settings */
  await page.locator("[data-action='settings']").click();
  await page.waitForTimeout(120);
  const settingsText = await text(page, "[data-sheet='settings']");
  const hasAllGroups = ["语言", "主题", "声音与触感", "速度", "自动抉择", "内容模式", "存档", "关于"].every((word) => settingsText.includes(word));
  const saveButtons = await page.locator("[data-sheet='settings'] [data-action='save'], [data-sheet='settings'] [data-action='save-game']").count();
  check("UI-06 settings shows all sections", hasAllGroups, `sections ok=${hasAllGroups}`);
  check("P1-C.1 存档 section is read-only (no save button)", saveButtons === 0, `save buttons=${saveButtons}`);

  await page.locator("[data-action='set-option'][data-setting='theme'][data-value='dark']").click();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.locator("[data-action='set-option'][data-setting='theme'][data-value='light']").click();
  const themeBack = await page.evaluate(() => document.documentElement.dataset.theme);
  check("UI-I06 theme switch immediate", theme === "dark" && themeBack === "light", `${theme} -> ${themeBack}`);

  await page.locator("[data-action='set-option'][data-setting='language'][data-value='en-US']").click();
  const lang = await page.evaluate(() => document.documentElement.lang);
  await page.locator("[data-action='set-option'][data-setting='language'][data-value='zh-CN']").click();
  const langBack = await page.evaluate(() => document.documentElement.lang);
  check("UI-06 language switch updates document.lang", lang === "en-US" && langBack === "zh-CN", `${lang} -> ${langBack}`);

  await page.locator("[data-action='set-option'][data-setting='speed'][data-value='2x']").click();
  await page.locator("[data-action='set-option'][data-setting='auto'][data-value='full']").click();
  await page.locator("[data-action='set-option'][data-setting='contentMode'][data-value='gentle']").click();
  const pressedStates = await page.evaluate(() => ({
    speed: document.querySelector("[data-setting='speed'][data-value='2x']")?.getAttribute("aria-pressed"),
    auto: document.querySelector("[data-setting='auto'][data-value='full']")?.getAttribute("aria-pressed"),
    content: document.querySelector("[data-setting='contentMode'][data-value='gentle']")?.getAttribute("aria-pressed")
  }));
  check("UI-06 speed / auto / content mode selectable", pressedStates.speed === "true" && pressedStates.auto === "true" && pressedStates.content === "true", JSON.stringify(pressedStates));

  await page.locator("[data-setting='sound']").click();
  const soundOff = await page.locator("[data-setting='sound']").getAttribute("aria-checked");
  await page.locator("[data-setting='sound']").click();
  const soundOn = await page.locator("[data-setting='sound']").getAttribute("aria-checked");
  const haptics = await page.locator("[data-setting='haptics']").getAttribute("aria-checked");
  await page.locator("[data-setting='haptics']").click();
  const hapticsOff = await page.locator("[data-setting='haptics']").getAttribute("aria-checked");
  await page.locator("[data-setting='haptics']").click();
  check("UI-06 sound / haptics toggles", soundOff === "false" && soundOn === "true" && haptics === "true" && hapticsOff === "false", `sound ${soundOff}/${soundOn}, haptics ${haptics}/${hapticsOff}`);
  const yearAfterSettings = await text(page, "[data-year]");
  check("UI-I06 settings never change game values", yearAfterSettings === year, `year=${yearAfterSettings}`);

  /* focus trap + inert */
  const focusInside = [];
  for (let index = 0; index < 24; index += 1) {
    await page.keyboard.press("Tab");
    focusInside.push(await page.evaluate(() => {
      const sheet = document.querySelector("[data-sheet='settings']");
      return Boolean(sheet && document.activeElement && sheet.contains(document.activeElement));
    }));
  }
  const shiftInside = [];
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("Shift+Tab");
    shiftInside.push(await page.evaluate(() => {
      const sheet = document.querySelector("[data-sheet='settings']");
      return Boolean(sheet && document.activeElement && sheet.contains(document.activeElement));
    }));
  }
  check("UI-A02 Tab cycles inside the sheet", focusInside.every(Boolean), `24/24 inside=${focusInside.filter(Boolean).length}`);
  check("UI-A02 Shift+Tab cycles inside the sheet", shiftInside.every(Boolean), `6/6 inside=${shiftInside.filter(Boolean).length}`);

  const backgroundFocusable = await page.evaluate(() => {
    const tab = document.querySelector("[data-tab='map']");
    if (!(tab instanceof HTMLElement)) return { reached: true };
    tab.focus();
    return { reached: document.activeElement === tab, inert: document.querySelector("[data-app-main]")?.hasAttribute("inert") };
  });
  check("UI-A02 modal blocks background focus (inert)", backgroundFocusable.reached === false && backgroundFocusable.inert === true, JSON.stringify(backgroundFocusable));

  /* about subpage */
  await page.locator("[data-action='open-info']").click();
  await page.waitForTimeout(120);
  const aboutTitle = await text(page, "[data-info-title]");
  const aboutVisible = await page.locator("[data-sheet='info']").isVisible();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  const focusBackToAbout = await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.info : null));
  check("UI-06 about opens detail subpage and closes", aboutVisible && aboutTitle === "关于" && focusBackToAbout === "about", `title=${aboutTitle}, focus=${focusBackToAbout}`);

  /* close via button returns focus to trigger */
  await page.locator("[data-sheet='settings'] button[data-action='close-sheet']").click();
  await page.waitForTimeout(120);
  const settingsClosed = await page.locator("[data-sheet='settings']").isHidden();
  const focusAfterClose = await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.action : null));
  check("UI-A02 close button returns focus to trigger", settingsClosed && focusAfterClose === "settings", `closed=${settingsClosed}, focus=${focusAfterClose}`);

  /* browser back closes sheet + restores focus */
  await page.locator("[data-action='settings']").click();
  await page.waitForTimeout(120);
  await page.goBack();
  await page.waitForTimeout(160);
  const backClosed = await page.locator("[data-sheet='settings']").isHidden();
  const focusAfterBack = await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.action : null));
  check("UI-I08 browser back closes sheet first", backClosed, `closed=${backClosed}`);
  check("UI-A02 back restores trigger focus", focusAfterBack === "settings", `focus=${focusAfterBack}`);

  /* family tree + detail + back */
  await page.locator("[data-tab='family']").click();
  await page.waitForTimeout(120);
  const treeNodes = await page.locator("[data-action='open-member']").count();
  const partnerText = await page.locator(".card-block").first().innerText();
  const childrenText = await page.locator(".card-block").nth(1).innerText();
  check("UI-03 family tree renders members and partner", treeNodes === 4 && partnerText.includes("陈雨"), `nodes=${treeNodes}`);
  check("UI-03 children empty state", childrenText.includes("还没有子女"), `text="${childrenText.slice(0, 20)}"`);

  await page.locator("[data-member='father']").click();
  await page.waitForTimeout(140);
  const detailName = await text(page, "[data-member-title]");
  const detailVisible = await page.locator("[data-member-title]").isVisible();
  check("UI-03 member detail opens", detailVisible && detailName.includes("林知远"), `name=${detailName}`);
  const backButton = page.locator("[data-action='close-member']").last();
  await backButton.click();
  await page.waitForTimeout(180);
  const listBack = await page.locator("[data-action='open-member']").first().isVisible();
  const focusBack = await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.member : null));
  check("UI-03 member detail returns and restores focus", listBack && focusBack === "father", `list=${listBack}, focus=${focusBack}`);

  /* work sub sections */
  await page.locator("[data-tab='work']").click();
  await page.waitForTimeout(120);
  const workTabCount = await page.locator("[data-action='work-tab']").count();
  const paneResults = [];
  for (const key of ["education", "career", "income", "jobs", "retire"]) {
    await page.locator(`[data-work-tab='${key}']`).click();
    await page.waitForTimeout(80);
    paneResults.push(await page.locator(`[data-work-pane='${key}']`).isVisible());
  }
  check("UI-04 five work sub sections switch", workTabCount === 5 && paneResults.every(Boolean), `tabs=${workTabCount}, panes=${paneResults.join(",")}`);

  await page.locator("[data-work-tab='jobs']").click();
  await page.waitForTimeout(80);
  await page.locator("[data-action='job-detail']").first().click();
  await page.waitForTimeout(140);
  const jobDetailTitle = await text(page, "[data-info-title]");
  const jobDetailVisible = await page.locator("[data-sheet='info']").isVisible();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  await page.locator("[data-work-tab='retire']").click();
  await page.waitForTimeout(80);
  await page.locator("[data-action='retire-detail']").click();
  await page.waitForTimeout(140);
  const retireVisible = await page.locator("[data-sheet='info']").isVisible();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  check("UI-04 job / retire details open", jobDetailVisible && jobDetailTitle.includes("学徒") && retireVisible, `job=${jobDetailTitle}, retire=${retireVisible}`);

  /* map country switch + migrate */
  await page.locator("[data-tab='map']").click();
  await page.waitForTimeout(120);
  const countryChips = await page.locator("[data-action='map-country']").count();
  const statsBefore = await text(page, "[data-country-name]");
  await page.locator("[data-country='jp']").click();
  await page.waitForTimeout(120);
  const statsAfter = await text(page, "[data-country-name]");
  const currentStill = await text(page, "[data-current-country]");
  check("UI-05 country switch updates stats", countryChips === 3 && statsBefore === "中国" && statsAfter === "日本" && currentStill === "中国", `${statsBefore} -> ${statsAfter}; current=${currentStill}`);

  await page.locator("[data-action='open-migrate']").click();
  await page.waitForTimeout(140);
  const migrateVisible = await page.locator("[data-sheet='migrate']").isVisible();
  const migrateDisabled = await page.locator("[data-action='confirm-migrate']").isDisabled();
  await page.locator("[data-migrate='jp']").click();
  const migrateEnabled = await page.locator("[data-action='confirm-migrate']").isEnabled();
  await page.locator("[data-action='confirm-migrate']").click();
  const migrateConsequence = await page.locator("[data-migrate-consequence]").isVisible();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  const migrateFocus = await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.action : null));
  check("UI-05 migrate sheet select + confirm", migrateVisible && migrateDisabled && migrateEnabled && migrateConsequence, `visible=${migrateVisible}, disabled=${migrateDisabled}, enabled=${migrateEnabled}, consequence=${migrateConsequence}`);
  check("UI-05 migrate sheet restores focus", migrateFocus === "open-migrate", `focus=${migrateFocus}`);

  /* death / summary / share / rebirth */
  await page.locator("[data-action='settings']").click();
  await page.waitForTimeout(120);
  const summaryButton = page.locator("[data-action='open-death']");
  await summaryButton.scrollIntoViewIfNeeded();
  await summaryButton.click();
  await page.waitForTimeout(160);
  const deathVisible = await page.locator("[data-screen='death']").isVisible();
  const deathTitle = await text(page, "#death-title");
  check("UI-07 death summary opens", deathVisible && deathTitle.length > 0, `title=${deathTitle}`);

  const moreHiddenBefore = await page.locator("#death-more").isHidden();
  await page.locator("[data-action='toggle-death-more']").scrollIntoViewIfNeeded();
  await page.locator("[data-action='toggle-death-more']").click();
  const expandedAfter = await page.locator("#death-more").isVisible();
  const expandedAria = await page.locator("[data-action='toggle-death-more']").getAttribute("aria-expanded");
  const moreLabel = await text(page, "[data-death-more-label]");
  check("UI-07 expand more", moreHiddenBefore && expandedAfter && expandedAria === "true" && moreLabel === "收起更多", `hiddenBefore=${moreHiddenBefore}, visible=${expandedAfter}, aria=${expandedAria}, label=${moreLabel}`);

  await page.locator("[data-action='open-share']").click();
  await page.waitForTimeout(140);
  const shareVisible = await page.locator("[data-sheet='share']").isVisible();
  await page.locator("[data-action='copy-share']").click();
  await page.waitForTimeout(120);
  const toastVisible = await page.locator("[data-toast].is-visible").isVisible();
  check("UI-07 share card + copy feedback", shareVisible && toastVisible, `sheet=${shareVisible}, toast=${toastVisible}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);

  await page.locator("[data-action='open-rebirth']").click();
  await page.waitForTimeout(140);
  const rebirthVisible = await page.locator("[data-sheet='rebirth']").isVisible();
  await page.locator("[data-action='confirm-rebirth']").click();
  await page.waitForTimeout(180);
  const backToLife = await page.locator("[data-panel='life']").isVisible();
  const deathHidden = await page.locator("[data-screen='death']").isHidden();
  check("UI-07 rebirth returns to life", rebirthVisible && backToLife && deathHidden, `sheet=${rebirthVisible}, life=${backToLife}`);

  /* keyboard main flow */
  const keyboard = await page.evaluate(() => {
    document.body.focus();
    return true;
  });
  void keyboard;
  await page.keyboard.press("Tab");
  let reachedSettings = false;
  for (let index = 0; index < 40; index += 1) {
    const current = await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.action ?? document.activeElement.dataset.tab ?? document.activeElement.tagName : ""));
    if (current === "settings") {
      reachedSettings = true;
      break;
    }
    await page.keyboard.press("Tab");
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(140);
  const keyboardOpened = await page.locator("[data-sheet='settings']").isVisible();
  await page.keyboard.press("Tab");
  const keyboardFocusInSheet = await page.evaluate(() => {
    const sheet = document.querySelector("[data-sheet='settings']");
    return Boolean(sheet && document.activeElement && sheet.contains(document.activeElement));
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(140);
  const keyboardClosed = await page.locator("[data-sheet='settings']").isHidden();
  check("UI-A02 keyboard opens settings, traps and closes", reachedSettings && keyboardOpened && keyboardFocusInSheet && keyboardClosed, `reached=${reachedSettings}, open=${keyboardOpened}, trapped=${keyboardFocusInSheet}, closed=${keyboardClosed}`);

  await page.locator("[data-action='next']").focus();
  const cardBeforeKeyboard = await text(page, "[data-year-card] .page-count");
  const labelBeforeKeyboard = await text(page, "[data-action='next'] .next-label");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  const cardAfterKeyboard = await text(page, "[data-year-card] .page-count");
  const labelAfterKeyboard = await text(page, "[data-action='next'] .next-label");
  check(
    "UI-A02 keyboard can operate main action",
    cardBeforeKeyboard !== cardAfterKeyboard || labelBeforeKeyboard !== labelAfterKeyboard,
    `${cardBeforeKeyboard} -> ${cardAfterKeyboard}; ${labelBeforeKeyboard} -> ${labelAfterKeyboard}`
  );

  /* reduced motion */
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("[data-action='settings']").click();
  await page.waitForTimeout(120);
  const reducedDuration = await page.evaluate(() => getComputedStyle(document.querySelector("[data-sheet='settings']")).animationDuration);
  check("UI-A06 prefers-reduced-motion disables animation", parseFloat(reducedDuration) <= 0.001, reducedDuration);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await context.close();

  /* landscape guard */
  const landscape = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  const landscapePage = await landscape.newPage();
  await landscapePage.goto(`${baseUrl}/?preview=fixture&screen=life`, { waitUntil: "networkidle" });
  await landscapePage.waitForSelector(".orientation-guard", { state: "visible" });
  const guardVisible = await landscapePage.locator(".orientation-guard").isVisible();
  const guardText = await landscapePage.locator(".orientation-guard h2").innerText();
  await shoot(landscapePage, `artifacts/ui/${buildId}/landscape-guard-640x360.png`);
  check("UI-L07 landscape shows portrait guard", guardVisible && guardText.includes("请竖屏"), `${guardVisible}/${guardText}`);
  await landscape.close();

  /* 320x568 minimum screen: full main flow */
  const small = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const smallPage = await small.newPage();
  await smallPage.goto(`${baseUrl}/?preview=fixture&screen=life`, { waitUntil: "networkidle" });
  await waitForUi(smallPage);
  await smallPage.locator("[data-action='next']").click();
  const smallCard = await text(smallPage, "[data-year-card] .page-count");
  await smallPage.locator("[data-action='open-choice']").click();
  await smallPage.waitForTimeout(120);
  const smallSheet = await smallPage.locator("[data-sheet='choice']").isVisible();
  await smallPage.locator("[data-choice='work']").click();
  await smallPage.locator("[data-action='confirm-choice']").click();
  const smallConsequence = await smallPage.locator("[data-consequence]").isVisible();
  await smallPage.keyboard.press("Escape");
  await smallPage.waitForTimeout(120);
  await smallPage.locator("[data-tab='family']").click();
  const smallFamily = await smallPage.locator("[data-panel='family']").isVisible();
  await smallPage.locator("[data-tab='map']").click();
  const smallMap = await smallPage.locator("[data-panel='map']").isVisible();
  await smallPage.locator("[data-action='settings']").click();
  await smallPage.waitForTimeout(120);
  const smallSettings = await smallPage.locator("[data-sheet='settings']").isVisible();
  await smallPage.keyboard.press("Escape");
  await smallPage.waitForTimeout(120);
  const smallMetrics = await measure(smallPage);
  check(
    "UI-L03 320x568 can finish card -> choice -> family -> map -> settings",
    smallCard === "2/3" && smallSheet && smallConsequence && smallFamily && smallMap && smallSettings,
    `card=${smallCard}, choice=${smallSheet}, family=${smallFamily}, map=${smallMap}, settings=${smallSettings}`
  );
  check(
    "UI-L03 320x568 has no horizontal overflow and scrolls vertically",
    !smallMetrics.horizontalOverflow && smallMetrics.verticalScrollable && smallMetrics.minTextViolations.length === 0 && smallMetrics.smallTapTargets.length === 0,
    `overflow=${smallMetrics.horizontalOverflow}, scrollable=${smallMetrics.verticalScrollable}, smallText=${smallMetrics.minTextViolations.length}, smallTaps=${smallMetrics.smallTapTargets.length}`
  );
  await small.close();

  return check.list;
}

/* ------------------------------------------------------------------ */
/* WebKit core flow                                                   */
/* ------------------------------------------------------------------ */

async function runWebkitFlow(baseUrl, makeCheck) {
  const check = makeCheck("webkit");
  const browser = await webkit.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    const rendered = [];
    for (const screen of screens) {
      await page.goto(`${baseUrl}/?preview=fixture&screen=${screen.route}`, { waitUntil: "networkidle" });
      await waitForUi(page);
      const visible = await page.locator("#app .app-shell").isVisible();
      rendered.push(visible);
    }
    check("WebKit renders all seven screens", rendered.every(Boolean), `${rendered.filter(Boolean).length}/7`);

    await page.goto(`${baseUrl}/?preview=fixture&screen=life`, { waitUntil: "networkidle" });
    await waitForUi(page);
    await page.locator("[data-action='next']").click();
    const card = await page.locator("[data-year-card] .page-count").innerText();
    check("WebKit next switches card", card === "2/3", `page=${card}`);

    await page.locator("[data-action='open-choice']").click();
    await page.waitForTimeout(140);
    const badge = await page.locator(".pause-badge-copy strong").innerText();
    await page.locator("[data-choice='study']").click();
    await page.locator("[data-action='confirm-choice']").click();
    const consequence = await page.locator("[data-consequence]").isVisible();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(140);
    check("WebKit choice flow", badge === "时间已暂停" && consequence, `badge=${badge}, consequence=${consequence}`);

    await page.locator("[data-action='settings']").click();
    await page.waitForTimeout(140);
    await page.locator("[data-action='set-option'][data-setting='theme'][data-value='dark']").click();
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    const trapped = await page.evaluate(() => {
      const sheet = document.querySelector("[data-sheet='settings']");
      return Boolean(sheet && document.activeElement && sheet.contains(document.activeElement));
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(140);
    const closed = await page.locator("[data-sheet='settings']").isHidden();
    const focusBack = await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.action : null));
    check("WebKit settings theme + focus return", theme === "dark" && trapped && closed && focusBack === "settings", `theme=${theme}, trapped=${trapped}, closed=${closed}, focus=${focusBack}`);

    await page.locator("[data-tab='family']").click();
    await page.waitForTimeout(120);
    await page.locator("[data-member='mother']").click();
    await page.waitForTimeout(160);
    const mother = await page.locator("[data-member-title]").innerText();
    await page.locator("[data-action='close-member']").last().click();
    await page.waitForTimeout(180);
    const backList = await page.locator("[data-action='open-member']").first().isVisible();
    check("WebKit family detail open/back", mother.includes("周岚") && backList, `name=${mother}, list=${backList}`);

    await page.locator("[data-tab='map']").click();
    await page.waitForTimeout(120);
    await page.locator("[data-country='ca']").click();
    await page.waitForTimeout(120);
    const country = await page.locator("[data-country-name]").innerText();
    await page.locator("[data-action='open-migrate']").click();
    await page.waitForTimeout(140);
    await page.locator("[data-migrate='ca']").click();
    await page.locator("[data-action='confirm-migrate']").click();
    const migrated = await page.locator("[data-migrate-consequence]").isVisible();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(140);
    check("WebKit country switch + migrate sheet", country === "加拿大" && migrated, `country=${country}, migrated=${migrated}`);

    await page.goto(`${baseUrl}/?preview=fixture&screen=death`, { waitUntil: "networkidle" });
    await waitForUi(page);
    await page.locator("[data-action='open-share']").click();
    await page.waitForTimeout(140);
    const share = await page.locator("[data-sheet='share']").isVisible();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(140);
    await shoot(page, `artifacts/ui/${buildId}/webkit-ui-07-death-390x844.png`);
    check("WebKit death share sheet", share, `share=${share}`);

    await page.goto(`${baseUrl}/?preview=fixture&screen=life`, { waitUntil: "networkidle" });
    await waitForUi(page);
    await shoot(page, `artifacts/ui/${buildId}/webkit-ui-01-life-390x844.png`);
  } finally {
    await context.close();
    await browser.close();
  }
  return check.list;
}

/* ------------------------------------------------------------------ */
/* performance                                                        */
/* ------------------------------------------------------------------ */

async function runPerformance(browser, baseUrl, makeCheck) {
  const check = makeCheck("chromium");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(`${baseUrl}/?preview=fixture&screen=life`, { waitUntil: "networkidle" });
  await waitForUi(page);

  const fcp = await page.evaluate(() => {
    const entry = performance.getEntriesByName("first-contentful-paint")[0];
    return entry ? Math.round(entry.startTime) : -1;
  });

  const tabLatency = await page.evaluate(async () => {
    const target = document.querySelector("[data-tab='work']");
    if (!(target instanceof HTMLElement)) return -1;
    const start = performance.now();
    target.click();
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    return Math.round((performance.now() - start) * 10) / 10;
  });

  const scroll = await page.evaluate(async () => {
    const frames = [];
    let last = performance.now();
    let y = 0;
    for (let index = 0; index < 60; index += 1) {
      y += 24;
      window.scrollTo(0, y);
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    const sorted = frames.slice(1).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const worst = sorted[sorted.length - 1] ?? 0;
    return { medianFrameMs: Math.round(median * 10) / 10, worstFrameMs: Math.round(worst * 10) / 10, fps: Math.round(1000 / Math.max(median, 0.1)) };
  });

  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await page.evaluate(() => {
    const memory = performance.memory;
    if (!memory) return { supported: false };
    return { supported: true, usedMB: Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10, limitMB: Math.round((memory.jsHeapSizeLimit / 1048576) * 10) / 10 };
  });

  check("UI-P01 FCP < 1500ms", fcp >= 0 && fcp < 1500, `${fcp}ms`);
  check("UI-P02 tab switch < 100ms", tabLatency >= 0 && tabLatency < 100, `${tabLatency}ms`);
  check("UI-P03 scroll >= 50fps", scroll.fps >= 50, `${scroll.fps}fps, median ${scroll.medianFrameMs}ms, worst ${scroll.worstFrameMs}ms`);
  check("UI-P04 JS heap < 120MB", heap.supported ? heap.usedMB < 120 : true, heap.supported ? `${heap.usedMB}MB / limit ${heap.limitMB}MB` : "not exposed by this browser");

  await context.close();
  return { fcp, tabLatency, scroll, heap, checks: check.list };
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await mkdir(reportDir, { recursive: true });

const server = staticServer();
const baseUrl = await listen(server);
const browser = await chromium.launch();
let failed = false;

try {
  const screenshots = await runScreenshotSuite(browser, baseUrl);
  const zoom = await runZoomSuite(browser, baseUrl);
  const axe = await runAxeSuite(browser, baseUrl);
  const checks = [];

  const chromiumChecks = await runInteractions(browser, baseUrl, (engine) => {
    const list = [];
    const fn = (name, pass, detail) => {
      list.push({ engine, name, pass: Boolean(pass), detail });
    };
    fn.list = list;
    return fn;
  });
  for (const item of chromiumChecks) checks.push(item);

  const webkitChecks = await runWebkitFlow(baseUrl, (engine) => {
    const list = [];
    const fn = (name, pass, detail) => {
      list.push({ engine, name, pass: Boolean(pass), detail });
    };
    fn.list = list;
    return fn;
  });
  for (const item of webkitChecks) checks.push(item);

  const performanceResult = await runPerformance(browser, baseUrl, (engine) => {
    const list = [];
    const fn = (name, pass, detail) => {
      list.push({ engine, name, pass: Boolean(pass), detail });
    };
    fn.list = list;
    return fn;
  });
  for (const item of performanceResult.checks) checks.push(item);

  const allMetrics = [...screenshots, ...zoom.map((item) => ({ ...item, viewport: "200%" }))];
  const smallText = allMetrics.reduce((count, item) => count + item.metrics.minTextViolations.length, 0);
  const bodyText = allMetrics.reduce((count, item) => count + item.metrics.bodyViolations.length, 0);
  const headingText = allMetrics.reduce((count, item) => count + item.metrics.headingViolations.length, 0);
  const smallTaps = allMetrics.reduce((count, item) => count + item.metrics.smallTapTargets.length, 0);
  const clipped = allMetrics.reduce((count, item) => count + item.metrics.clipped.length, 0);
  const ellipsis = allMetrics.reduce((count, item) => count + item.metrics.ellipsis.length, 0);
  const criticalText = allMetrics.reduce((count, item) => count + item.metrics.criticalText.length, 0);
  const overflows = allMetrics.filter((item) => item.metrics.horizontalOverflow).length;
  const overlaps = allMetrics.filter((item) => item.metrics.buttonOverlap).length;
  const nextSizes = screenshots.map((item) => item.metrics.sizes.nextHeight).filter((value) => value !== null);
  const tabSizes = screenshots.map((item) => item.metrics.sizes.tabHeight).filter((value) => value !== null);
  /* 180-240px 是 100% 字級的版面規格；200% 模式允許縱向長高（規則要求可增加垂直滾動） */
  const sceneSizes = screenshots.filter((item) => item.screen === "life").map((item) => item.metrics.sizes.sceneHeight);
  const badNext = nextSizes.filter((value) => value < 51.5).length;
  const badTabs = tabSizes.filter((value) => value < 55.5).length;
  const badScene = sceneSizes.filter((value) => value === null || value < 179.5 || value > 240.5).length;

  const axeViolations = axe.flatMap((item) => item.violations);
  const axeCritical = axeViolations.filter((violation) => violation.impact === "critical").length;
  const axeSerious = axeViolations.filter((violation) => violation.impact === "serious").length;
  const interactionFailures = checks.filter((item) => !item.pass);

  /* desktop phone frame */
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const desktopPage = await desktopContext.newPage();
  await desktopPage.goto(`${baseUrl}/?preview=fixture&screen=life`, { waitUntil: "networkidle" });
  await waitForUi(desktopPage);
  const desktopMetrics = await measure(desktopPage);
  await shoot(desktopPage, `artifacts/ui/${buildId}/desktop-frame-1280x900.png`);
  const shellWidth = desktopMetrics.sizes.shellWidth ?? 0;
  const shellBox = desktopMetrics.boxes.shell;
  const centered = shellBox ? Math.abs(shellBox.x - (1280 - shellWidth) / 2) <= 2 : false;
  checks.push({ engine: "chromium", name: "UI-L04 desktop frame <= 480px and centered", pass: shellWidth > 0 && shellWidth <= 480 && centered, detail: `width=${shellWidth}, x=${shellBox?.x ?? "?"}` });
  await desktopContext.close();

  failed = overflows > 0 || clipped > 0 || ellipsis > 0 || criticalText > 0 || smallText > 0 || bodyText > 0 || headingText > 0 || smallTaps > 0 || overlaps > 0 || badNext > 0 || badTabs > 0 || badScene > 0 || axeCritical + axeSerious > 0 || checks.some((item) => !item.pass);

  const validation = {
    buildId,
    generatedAt: new Date().toISOString(),
    viewports: viewports.map((viewport) => viewport.label),
    screens: screens.map((screen) => screen.key),
    screenshotCount: screenshots.length,
    zoomScreenshotCount: zoom.length,
    screenshots,
    zoom,
    axe,
    checks,
    performance: performanceResult,
    summary: {
      horizontalOverflow: overflows,
      clippedText: clipped,
      ellipsisText: ellipsis,
      criticalTextTruncated: criticalText,
      minFontViolations: smallText,
      bodyFontViolations: bodyText,
      headingFontViolations: headingText,
      smallTapTargets: smallTaps,
      buttonOverlap: overlaps,
      nextHeightViolations: badNext,
      tabHeightViolations: badTabs,
      sceneHeightViolations: badScene,
      axeCritical,
      axeSerious,
      axeTotal: axeViolations.length,
      interactionTotal: checks.length,
      interactionFailures: interactionFailures.length,
      webkitFailures: checks.filter((item) => item.engine === "webkit" && !item.pass).length
    }
  };
  await writeFile(join(reportDir, "ui-validation.json"), JSON.stringify(validation, null, 2));

  const rows = (items) =>
    items
      .map((item) => `<tr><td>${item.engine}</td><td>${item.name}</td><td class="${item.pass ? "ok" : "bad"}">${item.pass ? "PASS" : "FAIL"}</td><td>${item.detail}</td></tr>`)
      .join("");
  const summary = validation.summary;
  const sizeRows = screenshots
    .map(
      (item) => `<tr><td>${item.screen}</td><td>${item.viewport}</td><td>${item.metrics.sizes.sceneHeight ?? "-"}</td><td>${item.metrics.sizes.nextHeight ?? "-"}</td><td>${item.metrics.sizes.tabHeight ?? "-"}</td><td class="${item.metrics.horizontalOverflow ? "bad" : "ok"}">${item.metrics.horizontalOverflow ? "overflow" : "ok"}</td><td class="${item.metrics.clipped.length ? "bad" : "ok"}">${item.metrics.clipped.length}</td><td>${item.metrics.documentHeight}px</td></tr>`
    )
    .join("");
  const zoomRows = zoom
    .map(
      (item) => `<tr><td>${item.screen}</td><td>${item.metrics.horizontalOverflow ? "overflow" : "ok"}</td><td>${item.metrics.clipped.length}</td><td>${item.metrics.ellipsis.length}</td><td>${item.metrics.criticalText.length}</td><td>${item.metrics.documentWidth}x${item.metrics.documentHeight}</td></tr>`
    )
    .join("");
  const cards = [...screenshots, ...zoom]
    .map((item) => `<figure><img src="../${item.screenshot}" alt="${item.screen} ${item.viewport}" loading="lazy"><figcaption>${item.screen} · ${item.viewport}</figcaption></figure>`)
    .join("");
  const perfRows = [
    ["FCP", `${performanceResult.fcp}ms`, "target < 1500ms"],
    ["tab switch", `${performanceResult.tabLatency}ms`, "target < 100ms"],
    ["scroll", `${performanceResult.scroll.fps}fps (median frame ${performanceResult.scroll.medianFrameMs}ms, worst ${performanceResult.scroll.worstFrameMs}ms)`, "target >= 50fps"],
    ["JS heap", performanceResult.heap.supported ? `${performanceResult.heap.usedMB}MB / limit ${performanceResult.heap.limitMB}MB` : "not exposed", "target < 120MB"]
  ]
    .map((row) => `<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td></tr>`)
    .join("");

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>P1-C.1 UI validation</title><style>
    body{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:22px;background:#f7efdf;color:#2f2a24}h1{margin:0 0 4px}p.sub{color:#6d6255}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}.summary div{background:#fff8e8;border:1px solid #c9a473;border-radius:8px;padding:10px}.summary strong{display:block;font-size:20px}.ok{color:#23645b;font-weight:700}.bad{color:#a72d24;font-weight:700}table{border-collapse:collapse;width:100%;background:#fff8e8;margin-bottom:14px}th,td{border:1px solid #d4b989;padding:7px;text-align:left;vertical-align:top}th{background:#efe0c2}figure{margin:0;background:#fff8e8;border:1px solid #c9a473;border-radius:8px;padding:7px}figure img{width:100%;display:block;border-radius:5px}figcaption{font-size:12px;color:#6d6255;padding-top:4px}.note{background:#fff4cd;border-left:4px solid #d89a2a;padding:8px 10px;margin:12px 0}h2{margin-top:22px}</style></head><body>
    <h1>P1-C.1 手機直立式 H5 靜態互動殼 · UI 驗收</h1>
    <p class="sub">buildId: <code>${buildId}</code> · 28 張正式截圖 + ${zoom.length} 張 200% 截圖 + 輔助截圖 · ${new Date().toISOString()}</p>
    <div class="summary">
      <div><strong class="${summary.horizontalOverflow ? "bad" : "ok"}">${summary.horizontalOverflow}</strong>橫向 overflow</div>
      <div><strong class="${summary.minFontViolations + summary.bodyFontViolations + summary.headingFontViolations ? "bad" : "ok"}">${summary.minFontViolations + summary.bodyFontViolations + summary.headingFontViolations}</strong>字級違規</div>
      <div><strong class="${summary.smallTapTargets ? "bad" : "ok"}">${summary.smallTapTargets}</strong>&lt;44px 操作區</div>
      <div><strong class="${summary.clippedText + summary.ellipsisText + summary.criticalTextTruncated ? "bad" : "ok"}">${summary.clippedText + summary.ellipsisText + summary.criticalTextTruncated}</strong>裁切／省略號</div>
      <div><strong class="${summary.nextHeightViolations + summary.tabHeightViolations + summary.sceneHeightViolations ? "bad" : "ok"}">${summary.nextHeightViolations + summary.tabHeightViolations + summary.sceneHeightViolations}</strong>52／56／180-240 違規</div>
      <div><strong class="${summary.axeCritical + summary.axeSerious ? "bad" : "ok"}">${summary.axeCritical + summary.axeSerious}</strong>axe critical/serious</div>
      <div><strong class="${summary.interactionFailures ? "bad" : "ok"}">${summary.interactionFailures}</strong>互動失敗（${summary.interactionTotal} 項）</div>
      <div><strong class="${summary.webkitFailures ? "bad" : "ok"}">${summary.webkitFailures}</strong>WebKit 失敗</div>
    </div>
    <div class="note">截圖只放在 <code>artifacts/ui/${buildId}/</code>；<code>reviews/ui-baselines/</code> 未被建立或覆寫。200% 模式為 root font-size 200% 的整頁截圖。</div>
    <h2>互動 / 相容性 / 效能檢查（Chromium + WebKit）</h2>
    <table><thead><tr><th>引擎</th><th>檢查</th><th>結果</th><th>細節</th></tr></thead><tbody>${rows(checks)}</tbody></table>
    <h2>效能（Chromium 390x844，本地靜態伺服器）</h2>
    <table><thead><tr><th>項目</th><th>實測</th><th>門檻</th></tr></thead><tbody>${perfRows}</tbody></table>
    <h2>尺寸檢查（4 視窗 × 7 畫面）</h2>
    <table><thead><tr><th>畫面</th><th>尺寸</th><th>場景高</th><th>下一步高</th><th>tab 高</th><th>橫向</th><th>裁切元素</th><th>頁面高</th></tr></thead><tbody>${sizeRows}</tbody></table>
    <h2>200% 文字模式（360x640）</h2>
    <table><thead><tr><th>畫面</th><th>橫向</th><th>裁切</th><th>省略號</th><th>關鍵文字截斷</th><th>文件尺寸</th></tr></thead><tbody>${zoomRows}</tbody></table>
    <h2>截圖（28 張正式尺寸 + ${zoom.length} 張 200%）</h2><div class="grid">${cards}</div></body></html>`;
  await writeFile(join(reportDir, "ui-validation.html"), html, "utf8");

  await writeFile(join(reportDir, "axe-ui.json"), JSON.stringify(axe, null, 2));
  await writeFile(join(reportDir, "axe-ui.html"), axeHtml(axeViolations), "utf8");

  console.log(`P1C1-UI screenshots=${screenshots.length} zoom=${zoom.length} horizontalOverflow=${summary.horizontalOverflow} clipped=${summary.clippedText} ellipsis=${summary.ellipsisText} criticalTruncated=${summary.criticalTextTruncated}`);
  console.log(`P1C1-SIZE minFont=${summary.minFontViolations} body=${summary.bodyFontViolations} heading=${summary.headingFontViolations} taps=${summary.smallTapTargets} next=${summary.nextHeightViolations} tabs=${summary.tabHeightViolations} scene=${summary.sceneHeightViolations} overlap=${summary.buttonOverlap}`);
  console.log(`P1C1-AXE critical=${summary.axeCritical} serious=${summary.axeSerious} total=${summary.axeTotal}`);
  console.log(`P1C1-PERF fcp=${performanceResult.fcp}ms tab=${performanceResult.tabLatency}ms fps=${performanceResult.scroll.fps} heap=${performanceResult.heap.supported ? performanceResult.heap.usedMB + "MB" : "n/a"}`);
  console.log(`P1C1-CHECKS total=${checks.length} failures=${summary.interactionFailures} webkit=${checks.filter((item) => item.engine === "webkit").length}`);
  for (const item of checks) console.log(`P1C1-CHECK ${item.pass ? "PASS" : "FAIL"} [${item.engine}] ${item.name} :: ${item.detail}`);
  if (overflows) console.log("P1C1-OVERFLOW", JSON.stringify(allMetrics.filter((item) => item.metrics.horizontalOverflow).map((item) => ({ screen: item.screen, viewport: item.viewport }))));
  if (smallText) console.log("P1C1-SMALL-TEXT", JSON.stringify(allMetrics.flatMap((item) => item.metrics.minTextViolations).slice(0, 10)));
  if (smallTaps) console.log("P1C1-SMALL-TAP", JSON.stringify(allMetrics.flatMap((item) => item.metrics.smallTapTargets).slice(0, 10)));
  if (clipped) console.log("P1C1-CLIPPED", JSON.stringify(allMetrics.flatMap((item) => item.metrics.clipped).slice(0, 10)));
} finally {
  await browser.close();
  await closeServer(server);
}

if (failed) process.exitCode = 1;
