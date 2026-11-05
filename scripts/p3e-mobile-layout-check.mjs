import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * GPT-0025-B — 手機直立版單欄視覺驗收。
 *
 * 以 `pnpm build:ui` 的產物（.artifacts/p1c-dist）實測
 * 320x568 / 390x844 / 430x932 / 537x976 / 720x900 五個尺寸，
 * 每個尺寸都走過 life / pending_decision / death 三種 phase。
 *
 * 這個腳本只讀 DOM 與 computed style，不修改任何遊戲資料或引擎。
 * 用法：corepack pnpm build:ui && node scripts/p3e-mobile-layout-check.mjs
 */

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, ".artifacts/p1c-dist");
const outDir = resolve(root, ".artifacts/mobile-layout");
const reportPath = join(outDir, "report.json");
const GOLDEN_SEED = "p3e-166-playable-runtime-v4";

/**
 * GPT-0025-D：字典中最長的標題／問題／選項，用來做「長文案不破版」的壓力測試。
 * 固定 seed 只會遇到 28 個決策的一部分，直接注入最長字串才能覆蓋最壞情況。
 */
const requireFromScripts = createRequire(import.meta.url);
const COPY_DOCUMENT = requireFromScripts("../fixtures/p3b/event-copy.zh-Hant.v1.json");
const longest = (prefix) =>
  Object.entries(COPY_DOCUMENT.copy)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({ key, value, length: [...value].length }))
    .sort((a, b) => b.length - a.length)[0];
const LONGEST_COPY = {
  title: longest("ev."),
  question: longest("p3b.decision."),
  option: longest("p3b.option.")
};

const viewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 537, height: 976 },
  { width: 720, height: 900 }
];

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
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
    server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${server.address().port}`));
  });
}

/* ------------------------------------------------------------------ */
/* page-side measurement                                              */
/* ------------------------------------------------------------------ */

function pageSnapshot() {
  const doc = document.documentElement;
  const body = document.body;
  const q = (s) => document.querySelector(s);
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return {
      top: Math.round(r.top * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
      left: Math.round(r.left * 10) / 10,
      right: Math.round(r.right * 10) / 10,
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10
    };
  };
  const shown = (node) => {
    if (node === null) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && box(node).height > 0;
  };
  const fontOf = (node) => (node === null ? null : parseFloat(getComputedStyle(node).fontSize));

  window.scrollTo(0, 99999);
  const scrolled = window.scrollY;
  window.scrollTo(0, 0);

  const life = q(".p3e-life");
  const lifeStyle = life === null ? null : getComputedStyle(life);
  const lifeChildren = life === null ? [] : [...life.children].filter(shown).map((n) => ({
    tag: n.className,
    ...box(n)
  }));
  const tracks = lifeStyle === null ? [] : lifeStyle.gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
  const oneColumn =
    lifeChildren.length > 0 &&
    (lifeStyle.display === "flex" ? lifeStyle.flexDirection === "column" : tracks.length === 1) &&
    lifeChildren.every((c) => Math.abs(c.left - lifeChildren[0].left) <= 1.5 &&
      Math.abs(c.right - lifeChildren[0].right) <= 1.5);

  const parts = {
    hud: box(q(".p3e-hud")),
    scene: box(q(".p3e-scene")),
    story: box(q(".p3e-story-card")),
    statDock: box(q(".p3e-stat-dock")),
    timeControls: box(q(".p3e-time-controls")),
    controls: box(q(".p3e-controls")),
    tabs: box(q(".p3e-tabs")),
    death: box(q(".p3e-death")),
    rebirth: box(q('[data-action="rebirth"]'))
  };

  const statDock = q(".p3e-stat-dock");
  const statItems = statDock === null ? [] : [...statDock.querySelectorAll(".p3e-stat-item")].map(box);
  const statOneRow = statItems.length === 4 && statItems.every((s) => Math.abs(s.top - statItems[0].top) <= 2);

  const tc = q(".p3e-time-controls");
  const tcBox = box(tc);
  const timeButtons = tc === null ? [] : [...tc.querySelectorAll("button")].map((button) => ({
    label: (button.textContent ?? "").trim(),
    ...box(button),
    clipped:
      tcBox === null ||
      box(button).left < tcBox.left - 1 ||
      box(button).right > tcBox.right + 1 ||
      box(button).right > window.innerWidth + 1 ||
      box(button).bottom > window.innerHeight + 1
  }));
  const tcScroll = tc === null ? 0 : tc.scrollWidth - tc.clientWidth;

  const optionButtons = [...document.querySelectorAll(".p3e-option")].filter(shown).map(box);
  const speedButtons = [...document.querySelectorAll(".p3e-speed-button")].filter(shown).map(box);
  const storyBox = parts.story;
  const optionsVisibleInCard = storyBox === null ? 0 : optionButtons.filter((b) =>
    b.top >= storyBox.top - 1 && b.bottom <= storyBox.bottom + 1 && b.top < window.innerHeight
  ).length;
  const optionFont = fontOf(q(".p3e-option"));
  const speedFont = fontOf(q(".p3e-speed-button"));

  const touchSelector = [
    '[data-action="advance"]',
    '[data-action="choose"]',
    '[data-action="rebirth"]',
    ".p3e-time-controls button",
    ".p3e-tab",
    ".p3e-hud-menu > summary",
    ".p3e-tools > summary"
  ].join(", ");
  const visibleTargets = [...document.querySelectorAll(touchSelector)]
    .filter(shown)
    .map((node) => ({ label: (node.textContent ?? "").trim().slice(0, 14), ...box(node) }));
  const smallTargets = visibleTargets.filter((t) => t.width < 43.5 || t.height < 43.5);

  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const inViewport = (b) => b !== null && b.height > 0 && b.top >= -2 && b.bottom <= vh + 2 &&
    b.left >= -2 && b.right <= vw + 2;

  return {
    viewport: { w: vw, h: vh },
    phase: q("[data-p3e-live]")?.getAttribute("data-p3e-phase") ?? "unknown",
    overflow: {
      docY: doc.scrollHeight - doc.clientHeight,
      bodyY: body.scrollHeight - body.clientHeight,
      docX: doc.scrollWidth - doc.clientWidth,
      bodyX: body.scrollWidth - body.clientWidth,
      scrolled,
      docOverflowY: getComputedStyle(doc).overflowY,
      bodyOverflowY: getComputedStyle(body).overflowY
    },
    life: {
      display: lifeStyle?.display ?? null,
      columns: tracks,
      oneColumn,
      children: lifeChildren
    },
    parts,
    sectionsVisible: {
      hud: inViewport(parts.hud),
      scene: inViewport(parts.scene),
      story: inViewport(parts.story),
      statDock: shown(statDock) && inViewport(parts.statDock),
      timeControls: shown(tc) && inViewport(parts.timeControls),
      controls: shown(q(".p3e-controls")) && inViewport(parts.controls),
      tabs: inViewport(parts.tabs),
      death: shown(q(".p3e-death")),
      rebirth: inViewport(parts.rebirth)
    },
    sceneRatio: parts.scene === null ? null : Math.round((parts.scene.height / vh) * 1000) / 10,
    statDock: {
      visible: shown(statDock),
      height: parts.statDock?.height ?? 0,
      items: statItems.length,
      oneRow: statOneRow
    },
    timeControls: {
      visible: shown(tc),
      scrollOverflow: tcScroll,
      buttons: timeButtons,
      allButtonsShown: timeButtons.length === 7 && timeButtons.every((b) => !b.clipped),
      minButtonWidth: Math.min(...timeButtons.map((b) => b.width), 999)
    },
    options: {
      count: optionButtons.length,
      visibleInCard: optionsVisibleInCard,
      rects: optionButtons,
      minHeight: Math.min(...optionButtons.map((b) => b.height), 999),
      font: optionFont,
      speedFont,
      speedHeight: Math.min(...speedButtons.map((b) => b.height), 999)
    },
    fonts: {
      storyP: fontOf(q(".p3e-story-card p")),
      deathP: fontOf(q(".p3e-death p")),
      hint: fontOf(q(".p3e-hint")),
      option: optionFont
    },
    touch: { checked: visibleTargets.length, small: smallTargets }
  };
}

/**
 * GPT-0025-D：把字典中最長的標題／問題／選項直接注入目前的決策卡，
 * 在同一個 evaluate 內完成量測（避免自動時間流動重繪覆蓋注入值）。
 */
function longestCopyProbe(payload) {
  const question = document.querySelector("#p3e-pending-title");
  const eventName = document.querySelector(".p3e-event-name");
  const options = [...document.querySelectorAll("button.p3e-option")];
  const card = document.querySelector(".p3e-story-card");
  if (question !== null) question.textContent = payload.question;
  if (eventName !== null) eventName.textContent = payload.title;
  for (const option of options) option.textContent = payload.option;

  const doc = document.scrollingElement ?? document.documentElement;
  const body = document.body;
  window.scrollTo(0, 99999);
  const scrolled = window.scrollY;
  window.scrollTo(0, 0);
  const cardRect = card === null ? null : card.getBoundingClientRect();
  const first = options.length > 0 ? options[0].getBoundingClientRect() : null;
  return {
    docY: doc.scrollHeight - doc.clientHeight,
    bodyY: body.scrollHeight - body.clientHeight,
    docX: doc.scrollWidth - doc.clientWidth,
    scrolled,
    questionText: question?.textContent ?? "",
    optionCount: options.length,
    minOptionHeight: Math.min(...options.map((node) => node.getBoundingClientRect().height), 999),
    firstOptionInCard:
      first !== null && cardRect !== null
        ? first.top >= cardRect.top - 2 && first.top < cardRect.bottom
        : false,
    cardOverflowY: card === null ? null : getComputedStyle(card).overflowY
  };
}

/* ------------------------------------------------------------------ */
/* checks                                                            */
/* ------------------------------------------------------------------ */

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function evaluate(label, phase, s) {
  const prefix = `${label}_${phase}`;
  const o = s.overflow;
  check(
    `${prefix}_no_page_scroll`,
    o.docY <= 1 && o.bodyY <= 1 && o.docX <= 1 && o.bodyX <= 1 && o.scrolled === 0,
    `docY=${o.docY} bodyY=${o.bodyY} docX=${o.docX} bodyX=${o.bodyX} scrolled=${o.scrolled}`
  );
  check(`${prefix}_single_column`, s.life.oneColumn, `display=${s.life.display} cols=${JSON.stringify(s.life.columns)}`);
  check(`${prefix}_scene_under_30pct`, s.sceneRatio !== null && s.sceneRatio <= 30, `scene=${s.parts.scene?.height}px ${s.sceneRatio}%`);
  check(
    `${prefix}_hud_scene_story_tabs_visible`,
    s.sectionsVisible.hud && s.sectionsVisible.scene && s.sectionsVisible.story && s.sectionsVisible.tabs,
    JSON.stringify(s.sectionsVisible)
  );
  check(`${prefix}_touch_targets_44px`, s.touch.small.length === 0, `checked=${s.touch.checked} small=${JSON.stringify(s.touch.small)}`);
  check(
    `${prefix}_body_text_readable`,
    (s.fonts.storyP === null || s.fonts.storyP >= 13.9) && (s.fonts.hint === null || s.fonts.hint >= 13.9),
    JSON.stringify(s.fonts)
  );

  if (phase === "death") {
    check(
      `${prefix}_no_useless_status_or_speed`,
      !s.statDock.visible && !s.timeControls.visible,
      `stat=${s.statDock.visible} time=${s.timeControls.visible}`
    );
    check(
      `${prefix}_scene_summary_restart_vertical`,
      s.sectionsVisible.scene && s.sectionsVisible.death && s.sectionsVisible.rebirth &&
        s.parts.scene.bottom <= s.parts.death.top + 2 &&
        s.parts.rebirth.top > s.parts.death.top &&
        s.parts.rebirth.bottom <= s.parts.death.bottom + 2,
      `scene=${JSON.stringify(s.parts.scene)} death=${JSON.stringify(s.parts.death)} rebirth=${JSON.stringify(s.parts.rebirth)}`
    );
  } else {
    // 待決策時 .p3e-controls 只剩提示（沒有可按的「下一步」），
    // 設計上讓位給選項卡；其餘六個區塊仍必須同屏。
    const required = phase === "pending_decision"
      ? ["hud", "scene", "story", "statDock", "timeControls", "tabs"]
      : ["hud", "scene", "story", "statDock", "timeControls", "controls", "tabs"];
    check(
      `${prefix}_main_sections_visible`,
      required.every((key) => s.sectionsVisible[key]),
      `required=${required.join("+")} ${JSON.stringify(s.sectionsVisible)}`
    );
    check(
      `${prefix}_stats_one_compact_row`,
      s.statDock.oneRow && s.statDock.height <= 72,
      `height=${s.statDock.height} items=${s.statDock.items} oneRow=${s.statDock.oneRow}`
    );
    check(
      `${prefix}_time_buttons_not_clipped`,
      s.timeControls.allButtonsShown && s.timeControls.scrollOverflow <= 1 && s.timeControls.minButtonWidth >= 43.5,
      `buttons=${s.timeControls.buttons.length} overflow=${s.timeControls.scrollOverflow} minW=${s.timeControls.minButtonWidth} clipped=${JSON.stringify(s.timeControls.buttons.filter((b) => b.clipped).map((b) => b.label))}`
    );
    if (phase === "pending_decision") {
      check(
        `${prefix}_options_more_prominent_than_playback`,
        s.options.count >= 2 && s.options.visibleInCard >= 1 &&
          s.options.minHeight >= s.options.speedHeight + 8 &&
          s.options.font >= s.options.speedFont + 1,
        `options=${s.options.count} visible=${s.options.visibleInCard} optH=${s.options.minHeight} speedH=${s.options.speedHeight} optFont=${s.options.font} speedFont=${s.options.speedFont}`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* driver                                                            */
/* ------------------------------------------------------------------ */

async function phaseOf(page) {
  return page.locator("[data-p3e-live]").getAttribute("data-p3e-phase");
}

async function commandCount(page) {
  return Number(await page.locator("[data-p3e-live]").getAttribute("data-p3e-command-count"));
}

async function clickAndWait(page, selector) {
  // 時間自動流動會在 render 後自動 resume；按鈕可能在點擊瞬間被重繪換掉。
  // 因此接受 command count 增加／phase 改變，並在重繪競態時重試一次。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await commandCount(page);
    const beforePhase = await phaseOf(page);
    if (beforePhase === "death") return;
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) return;
    // 故事卡是可內捲容器且 h2 sticky；把目標移到中間，避免被標題擋住點擊。
    await locator.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" }));
    await locator.click();
    try {
      await page.waitForFunction(
        ([prev, phase]) => {
          const node = document.querySelector("[data-p3e-live]");
          const count = Number(node?.getAttribute("data-p3e-command-count") ?? "0");
          const now = node?.getAttribute("data-p3e-phase") ?? "unknown";
          return count > prev || now !== phase || now === "death";
        },
        [before, beforePhase],
        { timeout: 4000 }
      );
      return;
    } catch {
      const nowPhase = await phaseOf(page);
      if (nowPhase === "death") return;
      if (attempt === 2) {
        const dump = await page.evaluate(() => ({
          phase: document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase"),
          count: document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-command-count"),
          buttons: [...document.querySelectorAll("button")].map((b) => ({
            label: (b.textContent ?? "").trim().slice(0, 14),
            action: b.dataset.action ?? null,
            disabled: b.disabled
          }))
        }));
        throw new Error(`clickAndWait stalled: ${JSON.stringify(dump)}`);
      }
    }
  }
}

async function runTo(page, target, maxSteps = 400) {
  let steps = 0;
  while ((await phaseOf(page)) !== target && steps < maxSteps) {
    const phase = await phaseOf(page);
    const selector = phase === "pending_decision" ? '[data-action="choose"]' : '[data-action="advance"]';
    if (steps % 10 === 0) {
      console.log(`  ... runTo(${target}) step=${steps} phase=${phase} commands=${await commandCount(page)}`);
    }
    await clickAndWait(page, selector);
    steps += 1;
  }
  return steps;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = staticServer();
  const baseUrl = await listen(server);
  const browser = await chromium.launch();
  const report = {
    viewports: [],
    checks: [],
    longestCopy: {
      title: LONGEST_COPY.title,
      question: LONGEST_COPY.question,
      option: LONGEST_COPY.option,
      probes: []
    }
  };

  for (const viewport of viewports) {
    const label = `${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/?seed=${encodeURIComponent(GOLDEN_SEED)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    const start = page.locator('[data-action="start-life"], [data-action="begin-life"]');
    if ((await start.count()) > 0) {
      await start.first().click();
      await page.waitForFunction(
        () => document.querySelector(".p3e-birth-card") === null ||
          document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life",
        undefined,
        { timeout: 20000 }
      );
    }
    // 時間自動流動會在每次 render 後自動 resume，這裡不暫停；
    // 量測本身是同步的 page.evaluate，phase 推進則用 waitForFunction 追蹤。

    const phases = [];
    for (const phase of ["life", "pending_decision", "death"]) {
      if (phase !== "life") await runTo(page, phase);
      const actual = await phaseOf(page);
      const snapshot = await page.evaluate(pageSnapshot);
      const shot = join(outDir, `${label}-${actual}.png`);
      await page.screenshot({ path: shot });
      evaluate(label, actual, snapshot);
      phases.push({ phase: actual, screenshot: shot, ...snapshot });

      if (actual === "pending_decision") {
        const probe = await page.evaluate(longestCopyProbe, {
          title: LONGEST_COPY.title.value,
          question: LONGEST_COPY.question.value,
          option: LONGEST_COPY.option.value
        });
        report.longestCopy.probes.push({ label, ...probe });
        check(
          `${label}_longest_copy_no_page_scroll`,
          probe.docY <= 1 &&
            probe.bodyY <= 1 &&
            probe.docX <= 1 &&
            probe.scrolled === 0 &&
            probe.questionText === LONGEST_COPY.question.value,
          `docY=${probe.docY} bodyY=${probe.bodyY} docX=${probe.docX} scrolled=${probe.scrolled}`
        );
        check(
          `${label}_longest_copy_options_still_tappable`,
          probe.optionCount >= 2 &&
            probe.minOptionHeight >= 43.5 &&
            probe.firstOptionInCard &&
            probe.cardOverflowY !== "visible",
          `options=${probe.optionCount} minH=${probe.minOptionHeight} inCard=${probe.firstOptionInCard} cardOverflow=${probe.cardOverflowY}`
        );
      }
    }
    report.viewports.push({ label, phases });
    await context.close();
  }

  report.checks = checks;
  report.summary = {
    checks: checks.length,
    pass: checks.filter((c) => c.ok).length,
    fail: checks.filter((c) => !c.ok).map((c) => c.name)
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nSUMMARY ${report.summary.pass}/${report.summary.checks} PASS`);
  if (report.summary.fail.length > 0) console.log(`FAIL: ${report.summary.fail.join(", ")}`);
  console.log(`report: ${reportPath}`);

  await browser.close();
  await new Promise((done) => server.close(done));
}

main().catch((error) => {
  console.error(error);
  // 瀏覽器／HTTP server 仍握著 handle，錯誤時必須明確結束程序，避免掛住。
  process.exit(1);
});
