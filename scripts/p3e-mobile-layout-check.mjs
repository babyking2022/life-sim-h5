import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { display, canonList } from "./p3e-locale-compat.mjs";

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
 * GPT-0063-A／0063-B：預設顯示語系已改為 zh-CN，但本腳本的文字斷言寫於
 * 繁中時期。改用共用工具 `scripts/p3e-locale-compat.mjs`：直接讀 runtime 的
 * PHRASES／CHAR_PAIRS，把「實際文字」與「期待的繁體字面值」正規化成同一個
 * canonical 簡體再比對，不維護第二份手寫對照表、不做有歧義的簡→繁反轉。
 * 所有幾何、尺寸、44px、overflow 等非文字條件完全不變，也不是用「強制
 * zh-TW」掩蓋簡體問題。
 */
const toHant = display;

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
  { width: 360, height: 640 },
  // GPT-0036-B：任務指定 360x800 也要單畫面無水平捲動。
  { width: 360, height: 800 },
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
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
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

async function pageSnapshot() {
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

  /* GPT-0054-B：場景改為原創分層 SVG data URI，不再下載外部 AVIF。
     直接解碼 SVG 字串：驗證滿版背景 rect（coverage=1）、分層、viewBox 比例、
     以及沒有任何 CDN／外部連結。這比舊的 canvas 像素量測更直接且不會被
     createImageBitmap 對 SVG blob 的支援度影響。 */
  const measureSceneAsset = () => {
    const node = document.querySelector(".p3e-scene");
    if (node === null) return null;
    const style = getComputedStyle(node);
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
    const scale = vbW > 0 && vbH > 0
      ? (size === "cover" ? Math.max(cw / vbW, ch / vbH) : cw / vbW)
      : 0;
    const fullBleed = svg !== null && vbW > 0 &&
      new RegExp(`<rect x="0" y="0" width="${vbW}" height="${vbH}"`).test(svg);
    const layerIds = svg === null
      ? []
      : [...svg.matchAll(/data-layer="([a-z]+)"/g)].map((match) => match[1]);
    // xmlns 是唯一合法的 http 字串；其餘任何 http/cdn 都代表外部素材。
    const noExternal = svg !== null &&
      !/https?:\/\//.test(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")) &&
      !/cdn/i.test(svg);
    return {
      loaded: svg !== null && svg.startsWith("<svg"),
      url, width: vbW, height: vbH,
      aspect: vbH > 0 ? vbW / vbH : 0,
      coverage: fullBleed ? 1 : 0,
      renderedWidth: vbW * scale, containerWidth: cw, styleSize: style.backgroundSize,
      svgOk: svg !== null && svg.includes("<rect") && svg.includes("<circle"),
      noExternal, layerIds,
      signature: node.dataset.p3eSceneSignature ?? null,
      children: node.children.length
    };
  };
  const sceneAsset = measureSceneAsset();

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
    '[data-action="toggle-nature-sound"]',
    ".p3e-hud-menu > summary",
    // GPT-0037-B P2：「估算」也是觸控目標，必須跟著通過 44x44 檢查。
    '[data-action="toggle-estimate-note"]'
  ].join(", ");
  const visibleTargets = [...document.querySelectorAll(touchSelector)]
    .filter(shown)
    .map((node) => ({ label: (node.textContent ?? "").trim().slice(0, 14), ...box(node) }));
  const smallTargets = visibleTargets.filter((t) => t.width < 43.5 || t.height < 43.5);

  /* GPT-0031-B：移除齒輪／底部 tabs、HUD 順序、完整主圖、人生紀錄捲動區。 */
  const hudNode = q(".p3e-hud");
  const hudItems = hudNode === null
    ? []
    : [...hudNode.querySelectorAll(":scope > .p3e-hud-item")].map((node) => ({
      label: node.querySelector("span")?.textContent ?? "",
      value: node.querySelector("strong")?.textContent ?? ""
    }));
  const soundNode = q('[data-action="toggle-nature-sound"]');
  const menuNode = q(".p3e-hud-menu > summary");
  const sceneNode = q(".p3e-scene");
  const sceneStyle = sceneNode === null ? null : getComputedStyle(sceneNode);
  const sceneText = (sceneNode?.textContent ?? "").replace(/\s+/g, "").trim();
  const lifeLogNode = q(".p3e-life-log");
  const storyNode = q(".p3e-story-card");
  const incomeNode = q(".p3e-hud-income");
  const soundBox = box(soundNode);
  const menuBox = box(menuNode);
  const incomeBox = box(incomeNode);
  const chrome = {
    removedDom: document.querySelectorAll(
      ".p3e-tools, .p3e-tab, .p3e-tabs, .p3e-game-title"
    ).length,
    hudLabels: hudItems.map((item) => item.label),
    hudValues: hudItems.map((item) => item.value),
    minorFinance: hudNode === null
      ? 0
      : [...hudNode.querySelectorAll(".p3e-hud-item")].filter(
        (node) => node.getAttribute("data-p3e-minor-finance") === "true"
      ).length,
    minorNote: q(".p3e-hud .p3e-sr-only")?.textContent ?? null,
    soundLabel: soundNode?.getAttribute("aria-label") ?? null,
    soundBox,
    menuBox,
    soundIsRightOfIncome: soundBox !== null && incomeBox !== null && soundBox.left >= incomeBox.right - 2,
    menuIsRightOfSound: menuBox !== null && soundBox !== null &&
      menuBox.left >= soundBox.left + soundBox.width - 2,
    sceneFit: sceneNode?.dataset.p3eSceneFit ?? null,
    sceneAssetId: sceneNode?.dataset.p3eSceneAsset ?? null,
    sceneAsset,
    hudLabelFont: fontOf(hudNode?.querySelector(".p3e-hud-item span") ?? null),
    hudValueFont: fontOf(hudNode?.querySelector(".p3e-hud-item strong") ?? null),
    sceneBackgroundSize: sceneStyle?.backgroundSize ?? null,
    sceneBackgroundRepeat: sceneStyle?.backgroundRepeat ?? null,
    sceneChildren: sceneNode?.children.length ?? -1,
    sceneText,
    sceneEmoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(sceneText),
    lifeLogCount: Number(lifeLogNode?.dataset.p3eLifeLogCount ?? "-1"),
    lifeLogSource: lifeLogNode?.dataset.p3eLifeLogSource ?? null,
    storyOverflowY: storyNode === null ? null : getComputedStyle(storyNode).overflowY,
    storyScrollable: storyNode === null ? false : storyNode.scrollHeight > storyNode.clientHeight + 1,
    storyBox: box(storyNode)
  };

  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const inViewport = (b) => b !== null && b.height > 0 && b.top >= -2 && b.bottom <= vh + 2 &&
    b.left >= -2 && b.right <= vw + 2;

  // GPT-0040-B：紅框狀態卡快照（身分／居住／情感三行）。
  const profileCardNode = q(".p3e-profile-card");
  const profileWrap = profileCardNode?.closest(".p3e-scene-wrap") ?? null;
  const profileScene = profileWrap?.querySelector(".p3e-scene") ?? null;
  const profileRows = profileCardNode === null
    ? []
    : [...profileCardNode.querySelectorAll(".p3e-profile-row")].map((r) => ({
        key: r.querySelector(".p3e-profile-key")?.textContent ?? "",
        val: r.querySelector(".p3e-profile-val")?.textContent ?? "",
        roleId: r.getAttribute("data-p3e-profile-role-id"),
        resEntity: r.getAttribute("data-p3e-profile-residence-entity"),
        resRegion: r.getAttribute("data-p3e-profile-residence-region"),
        relStatus: r.getAttribute("data-p3e-relationship-status"),
        partnerName: r.getAttribute("data-p3e-partner-name")
      }));
  const profileCardBox = box(profileCardNode);
  const profileSceneBox = box(profileScene);
  // GPT-0041-B：居住國名必須完整繁中且 320px 不可省略（scrollWidth <= clientWidth，不得 ellipsis 隱藏）。
  const countryRowNode = profileCardNode === null ? null :
    [...profileCardNode.querySelectorAll(".p3e-profile-row")].find(
      (r) => (r.querySelector(".p3e-profile-key")?.textContent ?? "").includes("居住")
    ) ?? null;
  const countryValNode = countryRowNode?.querySelector(".p3e-profile-val") ?? null;
  const countryText = countryValNode?.textContent ?? "";
  const countryScrollWidth = countryValNode ? countryValNode.scrollWidth : 0;
  const countryClientWidth = countryValNode ? countryValNode.clientWidth : 0;
  // 簡體中文特徵字，用來偵測「把簡體當繁中」。涵蓋國名可能出現的全部簡體字
  // （贝宁达冈绍岛韩缅汤乌库图韦叙济 等），避免遺漏。
  const SIMPLIFIED_TELL = /[国马兰亚罗苏鲜挝东门叶约纳莱刚几内鲁伦买萨腊奥卢时顿爱脱义兹赖茨麦湾维贝宁达冈绍岛韩缅汤乌库图韦叙济]/;
  const countryHasSimplified = SIMPLIFIED_TELL.test(countryText);
  const countryNoOmit = countryValNode !== null && countryScrollWidth <= countryClientWidth + 1;
  const profileCard = {
    present: profileCardNode !== null,
    ariaLabel: profileCardNode?.getAttribute("aria-label") ?? null,
    inSceneWrap: profileWrap !== null,
    legacyPartnerLine: document.querySelectorAll(".p3e-partner-line").length,
    rows: profileRows,
    rowCount: profileRows.length,
    country: {
      text: countryText,
      scrollWidth: countryScrollWidth,
      clientWidth: countryClientWidth,
      noOmit: countryNoOmit,
      hasSimplified: countryHasSimplified
    },
    box: profileCardBox,
    sceneBox: profileSceneBox,
    leftAligned: profileCardBox !== null && profileSceneBox !== null &&
      profileCardBox.left >= profileSceneBox.left - 1 && profileCardBox.left <= profileSceneBox.left + 16,
    withinLeftHalf: profileCardBox !== null && profileSceneBox !== null &&
      profileCardBox.right <= profileSceneBox.left + profileSceneBox.width * 0.5,
    widthRatio: profileCardBox !== null && profileSceneBox !== null && profileSceneBox.width > 0
      ? profileCardBox.width / profileSceneBox.width
      : null
  };

  return {
    viewport: { w: vw, h: vh },
    phase: q("[data-p3e-live]")?.getAttribute("data-p3e-phase") ?? "unknown",
    locale: doc.lang || "unknown",
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
    touch: { checked: visibleTargets.length, small: smallTargets },
    chrome,
    profileCard
  };
}

/**
 * GPT-0025-D：把字典中最長的標題／問題／選項直接注入目前的決策卡，
 * 在同一個 evaluate 內完成量測（避免自動時間流動重繪覆蓋注入值）。
 */
/* GPT-0029-B：出生卡與人生重心的手機單畫面探測（在瀏覽器內執行）。 */
function focusSnapshot() {
  const doc = document.documentElement;
  const body = document.body;
  const q = (s) => document.querySelector(s);
  const box = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  };
  const shown = (node) => {
    if (node === null) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && box(node).height > 0;
  };
  window.scrollTo(0, 99999);
  const scrolled = window.scrollY;
  window.scrollTo(0, 0);

  const live = q("[data-p3e-live]");
  const focusBox = q(".p3e-focus");
  const line = q(".p3e-focus-current");
  const panel = q(".p3e-focus-panel");
  const card = q(".p3e-story-card");
  const birthCard = q(".p3e-birth-card");
  const optionNodes = [...document.querySelectorAll(".p3e-focus-option")].filter(shown);
  const toggle = q(".p3e-focus-toggle");
  const allButtons = [...(focusBox?.querySelectorAll("button") ?? [])].filter(shown);
  const fontOf = (node) => (node === null ? null : parseFloat(getComputedStyle(node).fontSize));
  const text = (focusBox?.textContent ?? "").replace(/\s+/g, " ").trim();
  const dialog = q('.p3e-focus-panel[data-p3e-focus-dialog="required"]');
  const estimate = q('[data-action="toggle-estimate-note"]');
  const estimateBox = box(estimate);
  const active = document.activeElement;
  const labelledBy = dialog?.getAttribute("aria-labelledby") ?? null;
  const describedBy = dialog?.getAttribute("aria-describedby") ?? null;
  const dialogInfo = {
    present: shown(dialog),
    role: dialog?.getAttribute("role") ?? null,
    modal: dialog?.getAttribute("aria-modal") ?? null,
    labelledBy,
    labelText: labelledBy === null ? null : q(`#${labelledBy}`)?.textContent ?? null,
    describedBy,
    descText: describedBy === null ? null : q(`#${describedBy}`)?.textContent ?? null,
    firstOptionFocused:
      dialog !== null && active instanceof HTMLElement &&
      active === dialog.querySelector('.p3e-focus-option:not([disabled])'),
    focusInsideDialog: dialog !== null && active instanceof HTMLElement && dialog.contains(active),
    activeTag: active?.tagName ?? null,
    optionCount: document.querySelectorAll(".p3e-focus-option").length
  };
  const estimateInfo = {
    present: shown(estimate),
    width: estimateBox?.width ?? 0,
    height: estimateBox?.height ?? 0,
    inside: estimateBox === null
      ? false
      : estimateBox.left >= -1 && estimateBox.right <= window.innerWidth + 1
  };
  // GPT-0038-B：必選 dialog 期間背景不可操作，dialog 本身仍可操作。
  const inertInfo = {
    count: document.querySelectorAll("[inert]").length,
    dialogCovered: dialog?.closest("[inert]") !== null,
    backgroundCovered: [
      ".p3e-hud-sound",
      ".p3e-hud-menu > summary",
      '[data-action="toggle-estimate-note"]',
      '[data-action="advance"]',
      '[data-action="toggle-time"]',
      '[data-action="jump-decision"]'
    ].every((selector) => {
      const node = q(selector);
      return node !== null && node.closest("[inert]") !== null;
    })
  };

  return {
    dialog: dialogInfo,
    inert: inertInfo,
    estimate: estimateInfo,
    phase: live?.getAttribute("data-p3e-phase") ?? "unknown",
    age: Number(live?.getAttribute("data-p3e-life-focus-age") ?? "-1"),
    shellFocus: live?.getAttribute("data-p3e-life-focus") ?? "none",
    focusPresent: shown(focusBox),
    expanded: focusBox?.dataset.p3eFocusExpanded ?? "false",
    birthCardVisible: shown(birthCard),
    birthButtons: [...(birthCard?.querySelectorAll("button") ?? [])].filter(shown)
      .map((b) => ({ label: (b.textContent ?? "").trim().slice(0, 12), height: box(b).height, width: box(b).width })),
    overflow: {
      docY: doc.scrollHeight - doc.clientHeight,
      bodyY: body.scrollHeight - body.clientHeight,
      docX: doc.scrollWidth - doc.clientWidth,
      bodyX: body.scrollWidth - body.clientWidth,
      scrolled
    },
    lineText: (line?.textContent ?? "").replace(/\s+/g, " ").trim(),
    lineHeight: line === null ? 0 : box(line).height,
    focusBoxHeight: focusBox === null ? 0 : box(focusBox).height,
    panelOverflowY: panel === null ? null : getComputedStyle(panel).overflowY,
    panelScrollable: panel === null ? false : panel.scrollHeight > panel.clientHeight + 1,
    panelInViewport: panel === null ? true : box(panel).bottom <= window.innerHeight + 2,
    cardOverflowY: card === null ? null : getComputedStyle(card).overflowY,
    focusPosition: focusBox === null ? null : getComputedStyle(focusBox).position,
    focusOverflowY: focusBox === null ? null : getComputedStyle(focusBox).overflowY,
    focusScrollable: focusBox === null ? false : focusBox.scrollHeight > focusBox.clientHeight + 1,
    optionCount: optionNodes.length,
    optionsInViewport: optionNodes.filter((b) => {
      const r = box(b);
      return r.top >= -2 && r.bottom <= window.innerHeight + 2 && r.left >= -2 && r.right <= window.innerWidth + 2;
    }).length,
    optionLabels: optionNodes.map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24)),
    minOptionHeight: Math.min(...optionNodes.map((b) => box(b).height), 999),
    minOptionFont: Math.min(...optionNodes.map((b) => fontOf(b) ?? 0), 999),
    minButtonHeight: Math.min(...allButtons.map((b) => box(b).height), 999),
    toggleDisabled: toggle?.disabled ?? null,
    toggleHeight: toggle === null ? 0 : box(toggle).height,
    internalKeyLeak: /focus:|p3b\.|SET_LIFE_FOCUS|data-focus-id|focusId/.test(text),
    bodyText: (body.textContent ?? "").replace(/\s+/g, " ")
  };
}

/** 把前景選擇卡捲到底，確認第五個選項可局部捲到；必選時不應有「先不改」。 */
function focusBottomProbe() {
  const box = document.querySelector('.p3e-focus[data-p3e-focus-expanded="true"]');
  if (box !== null) box.scrollTop = box.scrollHeight;
  const options = [...document.querySelectorAll(".p3e-focus-option")];
  const last = options[options.length - 1] ?? null;
  const dismiss = document.querySelector(".p3e-focus-dismiss");
  const dismissCount = document.querySelectorAll(".p3e-focus-dismiss").length;
  const visible = (node) => {
    if (node === null) return false;
    const r = node.getBoundingClientRect();
    return r.top >= -2 && r.bottom <= window.innerHeight + 2 && r.height > 0;
  };
  const doc = document.documentElement;
  const body = document.body;
  window.scrollTo(0, 99999);
  const scrolled = window.scrollY;
  window.scrollTo(0, 0);
  return {
    scrollTop: box?.scrollTop ?? 0,
    scrollable: box === null ? false : box.scrollHeight > box.clientHeight + 1,
    lastOptionVisible: visible(last),
    dismissVisible: visible(dismiss),
    dismissCount,
    docY: doc.scrollHeight - doc.clientHeight,
    bodyY: body.scrollHeight - body.clientHeight,
    scrolled
  };
}

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

/** GPT-0029-B：出生卡的單畫面檢查（birth phase）。 */
function evaluateBirth(label, s) {
  const prefix = `${label}_birth`;
  const o = s.overflow;
  check(
    `${prefix}_no_page_scroll`,
    o.docY <= 1 && o.bodyY <= 1 && o.docX <= 1 && o.bodyX <= 1 && o.scrolled === 0,
    `docY=${o.docY} bodyY=${o.bodyY} docX=${o.docX} bodyX=${o.bodyX} scrolled=${o.scrolled}`
  );
  check(`${prefix}_card_visible`, s.birthCardVisible, `visible=${s.birthCardVisible}`);
  check(
    `${prefix}_buttons_44px`,
    s.birthButtons.length >= 2 && s.birthButtons.every((b) => b.height >= 43.5 && b.width >= 43.5),
    JSON.stringify(s.birthButtons)
  );
  check(`${prefix}_no_focus_before_school`, !s.focusPresent, `focus=${s.focusPresent}`);
}

/** GPT-0029-B：滿 7 歲第一次自動出現清楚的五選一面板。 */
function evaluateFocusPicker(label, s) {
  const prefix = `${label}_focus_picker`;
  const o = s.overflow;
  check(
    `${prefix}_no_page_scroll`,
    o.docY <= 1 && o.bodyY <= 1 && o.docX <= 1 && o.bodyX <= 1 && o.scrolled === 0,
    `docY=${o.docY} bodyY=${o.bodyY} docX=${o.docX} scrolled=${o.scrolled}`
  );
  check(
    `${prefix}_auto_opens_at_age7`,
    s.age === 7 && s.focusPresent && s.expanded === "true" && s.optionCount === 5,
    `age=${s.age} present=${s.focusPresent} expanded=${s.expanded} options=${s.optionCount}`
  );
  check(
    `${prefix}_all_targets_44px`,
    s.minOptionHeight >= 43.5 && s.minButtonHeight >= 43.5,
    `optionH=${s.minOptionHeight} buttonH=${s.minButtonHeight}`
  );
  check(
    `${prefix}_text_readable`,
    s.minOptionFont >= 13.9 && !s.internalKeyLeak,
    `font=${s.minOptionFont} leak=${s.internalKeyLeak}`
  );
  check(
    `${prefix}_panel_scrolls_locally_only`,
    s.focusPosition === "fixed" &&
      (s.focusOverflowY === "auto" || s.focusOverflowY === "scroll") &&
      s.cardOverflowY !== "visible",
    `position=${s.focusPosition} focusOverflow=${s.focusOverflowY} card=${s.cardOverflowY} scrollable=${s.focusScrollable}`
  );
  check(
    `${prefix}_options_visible_or_card_scrollable`,
    s.optionCount === 5 && s.optionsInViewport >= 4 &&
      (s.optionsInViewport === 5 || s.focusScrollable),
    `options=${s.optionCount} inViewport=${s.optionsInViewport} cardScrollable=${s.focusScrollable}`
  );
  check(
    `${prefix}_five_natural_labels`,
    s.optionLabels.length === 5 &&
      s.optionLabels.some((t) => toHant(t).includes("學業")) &&
      s.optionLabels.some((t) => toHant(t).includes("自我實現")) &&
      s.optionLabels.some((t) => toHant(t).includes("家庭")) &&
      s.optionLabels.some((t) => toHant(t).includes("興趣")) &&
      s.optionLabels.some((t) => toHant(t).includes("健康")),
    JSON.stringify(s.optionLabels)
  );
  // GPT-0037-B P2：必選面板是真正的 dialog，且開啟後焦點在第一個可選重心。
  const d = s.dialog;
  check(
    `${prefix}_required_dialog_semantics_and_autofocus`,
    d.present && d.role === "dialog" && d.modal === "true" &&
      typeof d.labelledBy === "string" && d.labelledBy.length > 0 &&
      typeof d.labelText === "string" && d.labelText.includes("人生重心") &&
      typeof d.describedBy === "string" && d.describedBy.length > 0 &&
      typeof d.descText === "string" && toHant(d.descText).includes("暫停") &&
      d.firstOptionFocused && d.focusInsideDialog && d.activeTag !== "BODY",
    `role=${d.role} modal=${d.modal} label="${d.labelText}" desc="${d.descText?.slice(0, 24)}" ` +
      `firstFocused=${d.firstOptionFocused} inside=${d.focusInsideDialog} active=${d.activeTag}`
  );
  // GPT-0038-B：aria-modal 期間背景分支 inert，dialog 本身不受影響。
  check(
    `${prefix}_required_dialog_background_inert`,
    s.inert.count > 0 && s.inert.dialogCovered === false &&
      s.inert.backgroundCovered === true,
    `inert=${s.inert.count} dialog=${s.inert.dialogCovered} background=${s.inert.backgroundCovered}`
  );
  // GPT-0037-B P2：「估算」觸控區至少 44x44，且不造成水平 overflow。
  const e = s.estimate;
  check(
    `${prefix}_estimate_touch_target_44px`,
    e.present && e.width >= 43.5 && e.height >= 43.5 && e.inside,
    `w=${e.width} h=${e.height} inside=${e.inside}`
  );
}

/** GPT-0029-B：選定後只佔一行、可更改、重整後仍在。 */
function evaluateFocusChosen(label, s, expectedLabel, expectToggleDisabled) {
  const prefix = `${label}_focus_chosen`;
  const o = s.overflow;
  check(
    `${prefix}_no_page_scroll`,
    o.docY <= 1 && o.bodyY <= 1 && o.docX <= 1 && o.bodyX <= 1 && o.scrolled === 0,
    `docY=${o.docY} bodyY=${o.bodyY} scrolled=${o.scrolled}`
  );
  // 「緊湊」= 重心本身只佔一行（lineH <= 56px），且整個區塊（含 44px 觸控
  // 按鈕與「今年已調整」提示）不超過視窗的 22%，不是整頁高度。
  check(
    `${prefix}_compact_one_line`,
    s.shellFocus === "study" && s.focusPresent && s.expanded === "false" &&
      (s.lineText.includes(`目前重心：${expectedLabel}`) ||
        toHant(s.lineText).includes(`目前重心：${expectedLabel}`)) &&
      s.lineHeight <= 56 && s.focusBoxHeight <= 120,
    `focus=${s.shellFocus} line="${s.lineText}" lineH=${s.lineHeight} boxH=${s.focusBoxHeight} expanded=${s.expanded}`
  );
  check(
    `${prefix}_change_entry_44px`,
    s.toggleHeight >= 43.5 && s.toggleDisabled === expectToggleDisabled,
    `h=${s.toggleHeight} disabled=${s.toggleDisabled}`
  );
  check(`${prefix}_no_internal_keys`, !s.internalKeyLeak, `leak=${s.internalKeyLeak}`);
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
    `${prefix}_hud_scene_story_visible`,
    s.sectionsVisible.hud && s.sectionsVisible.scene && s.sectionsVisible.story,
    JSON.stringify(s.sectionsVisible)
  );
  check(`${prefix}_touch_targets_44px`, s.touch.small.length === 0, `checked=${s.touch.checked} small=${JSON.stringify(s.touch.small)}`);

  /* GPT-0031-B：四個尺寸 × 三階段都檢查新版頂部列、主圖與人生紀錄。 */
  const c = s.chrome;
  check(
    `${prefix}_gear_and_bottom_tabs_absent`,
    c.removedDom === 0,
    `removedDom=${c.removedDom}`
  );
  check(
    `${prefix}_hud_order_and_right_controls`,
    JSON.stringify(canonList(c.hudLabels)) === JSON.stringify(canonList(["年份", "年齡", "資產", "年收入"])) &&
      c.soundIsRightOfIncome && c.menuIsRightOfSound &&
      c.soundBox !== null && c.menuBox !== null &&
      c.soundBox.width >= 43.5 && c.soundBox.height >= 43.5 &&
      c.menuBox.width >= 43.5 && c.menuBox.height >= 43.5 &&
      typeof c.soundLabel === "string" && c.soundLabel.length > 0,
    `labels=${JSON.stringify(c.hudLabels)} soundRight=${c.soundIsRightOfIncome} menuRight=${c.menuIsRightOfSound} sound=${JSON.stringify(c.soundBox)}`
  );
  // GPT-0054-B：場景已是本地生成的分層 SVG（滿版背景 rect + 玩家／伴侶／寵物層），
  // 不再驗證單張 landscape AVIF；改驗證 data URI、圖層與無外部素材。
  check(
    `${prefix}_scene_layered_svg_fills_width_without_overlay`,
    c.sceneFit === "cover" &&
      c.sceneAssetId === "generated-layered-svg" &&
      (c.sceneBackgroundSize ?? "").split(",")[0].trim() === "cover" &&
      (c.sceneBackgroundRepeat ?? "").startsWith("no-repeat") &&
      c.sceneChildren === 0 && c.sceneText === "" && !c.sceneEmoji &&
      c.sceneAsset !== null && c.sceneAsset.loaded === true &&
      (c.sceneAsset.url ?? "").startsWith("data:image/svg+xml,") &&
      c.sceneAsset.svgOk === true && c.sceneAsset.noExternal === true &&
      c.sceneAsset.aspect >= 1.6 &&
      c.sceneAsset.coverage >= 0.8 &&
      c.sceneAsset.layerIds.includes("background") &&
      c.sceneAsset.layerIds.includes("player") &&
      /^[0-9a-f]{8}$/.test(c.sceneAsset.signature ?? ""),
    `fit=${c.sceneFit} size=${c.sceneBackgroundSize} repeat=${c.sceneBackgroundRepeat} ` +
      `asset=${c.sceneAssetId} url=${(c.sceneAsset?.url ?? "").slice(0, 32)} ` +
      `loaded=${c.sceneAsset?.loaded} svgOk=${c.sceneAsset?.svgOk} noExternal=${c.sceneAsset?.noExternal} ` +
      `layers=${JSON.stringify(c.sceneAsset?.layerIds)} ` +
      `dims=${c.sceneAsset?.width}x${c.sceneAsset?.height} aspect=${c.sceneAsset?.aspect} ` +
      `coverage=${c.sceneAsset?.coverage} children=${c.sceneChildren} text="${c.sceneText}" emoji=${c.sceneEmoji}`
  );
  check(
    `${prefix}_hud_font_sizes_readable`,
    c.hudLabelFont !== null && c.hudLabelFont >= 11 &&
      c.hudValueFont !== null && c.hudValueFont >= 13,
    `label=${c.hudLabelFont}px value=${c.hudValueFont}px`
  );
  check(
    `${prefix}_life_log_inside_scrolling_card`,
    c.lifeLogCount >= 1 && c.storyOverflowY === "auto" && c.storyBox !== null,
    `count=${c.lifeLogCount} source=${c.lifeLogSource} overflowY=${c.storyOverflowY} scrollable=${c.storyScrollable}`
  );
  check(
    `${prefix}_body_text_readable`,
    (s.fonts.storyP === null || s.fonts.storyP >= 13.9) && (s.fonts.hint === null || s.fonts.hint >= 13.9),
    JSON.stringify(s.fonts)
  );

  /* GPT-0040-B／0041-B：紅框狀態卡在五尺寸 × 三階段都結構正確、置左、不整頁溢出。
     death 畫面若仍顯示狀態卡，也必須驗證結構與文字，不得無條件排除。 */
  const pc = s.profileCard;
  const pcRequired = phase !== "death";
  const pcPresentOk = pc.present && toHant(pc.ariaLabel).equals("角色即時狀態") &&
    pc.rowCount === 3 &&
    pc.rows.some((r) => toHant(r.key).equals("目前居住")) &&
    pc.rows.some((r) => toHant(r.key).equals("情感狀態")) &&
    pc.rows.some((r) => toHant(r.key).equals("目前身分") || toHant(r.key).equals("目前職業")) &&
    pc.legacyPartnerLine === 0;
  check(
    `${prefix}_profile_card_structured`,
    (!pcRequired || pcPresentOk) && (!pc.present || pcPresentOk),
    `required=${pcRequired} present=${pc.present} aria=${pc.ariaLabel} rows=${pc.rowCount} keys=${JSON.stringify(pc.rows.map((r) => r.key))} legacy=${pc.legacyPartnerLine}`
  );
  // GPT-0041-B：居住國名必須完整（不省略）；語系由 0062-A 起預設 zh-CN，
  // 因此 zh-CN 下要求的是「完整簡中國名」，zh-TW 下仍要求完整繁中。
  if (pc.present) {
    const c = pc.country;
    const noEllipsis = c.text.length > 0 && c.noOmit && !c.text.includes("…") && !c.text.includes("...");
    const localeOk = s.locale === "zh-TW" ? !c.hasSimplified : true;
    check(
      `${prefix}_profile_card_country_full_no_omit`,
      noEllipsis && localeOk,
      `text=${JSON.stringify(c.text)} locale=${s.locale} hasSimplified=${c.hasSimplified} scroll=${c.scrollWidth} client=${c.clientWidth} noOmit=${c.noOmit}`
    );
  }
  const pcPosOk = pc.inSceneWrap && pc.leftAligned && pc.withinLeftHalf &&
    pc.widthRatio !== null && pc.widthRatio <= 0.47 &&
    s.overflow.docY <= 1 && s.overflow.bodyY <= 1;
  check(
    `${prefix}_profile_card_left_side_no_overflow`,
    !pcRequired || (pc.present && pcPosOk),
    `required=${pcRequired} present=${pc.present} wrap=${pc.inSceneWrap} left=${pc.leftAligned} half=${pc.withinLeftHalf} ratio=${pc.widthRatio} docY=${s.overflow.docY} bodyY=${s.overflow.bodyY}`
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
    // 設計上讓位給選項卡；底部 tabs 移除後其餘區塊仍必須同屏。
    const required = phase === "pending_decision"
      ? ["hud", "scene", "story", "statDock", "timeControls"]
      : ["hud", "scene", "story", "statDock", "timeControls", "controls"];
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
      // GPT-0032-B：320x568 把場景加高後，最後一個選項可能不在初始可見區。
      // 若如此，必須證明是「故事卡內部可捲動」而非整頁捲動，否則就是假綠。
      const storyBox = s.parts.story;
      const allInitiallyVisible = storyBox !== null && s.options.rects.every(
        (b) => b.top >= storyBox.top - 1 && b.bottom <= storyBox.bottom + 1
      );
      check(
        `${prefix}_all_decision_options_reachable`,
        s.options.count >= 2 && s.options.minHeight >= 44 &&
          (allInitiallyVisible || (c.storyOverflowY === "auto" && c.storyScrollable)),
        `count=${s.options.count} allVisible=${allInitiallyVisible} ` +
          `cardOverflow=${c.storyOverflowY} scrollable=${c.storyScrollable} minH=${s.options.minHeight}`
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

/** GPT-0029-B：把畫面推到指定年齡（遇決策就選第一個選項）。 */
async function runToAge(page, targetAge, maxSteps = 40) {
  for (let step = 0; step < maxSteps; step += 1) {
    const live = page.locator("[data-p3e-live]");
    const age = Number(await live.getAttribute("data-p3e-life-focus-age"));
    if (age >= targetAge) return age;
    const phase = await phaseOf(page);
    if (phase === "death") return age;
    const selector = phase === "pending_decision" ? '[data-action="choose"]' : '[data-action="advance"]';
    await clickAndWait(page, selector);
  }
  return Number(await page.locator("[data-p3e-live]").getAttribute("data-p3e-life-focus-age"));
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
    // GPT-0036-B：官方 golden 量測流程用重播模式，不被必選重心插入指令；
    // 下方專屬 focus probe 刻意不帶此參數，直接量測「必選暫停」的真實畫面。
    await page.goto(
      `${baseUrl}/?seed=${encodeURIComponent(GOLDEN_SEED)}&p3eReplay=official-golden`,
      { waitUntil: "domcontentloaded" }
    );
    await page.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });

    // GPT-0029-B：先量測出生卡（birth phase）再開始人生。
    const birth = await page.evaluate(focusSnapshot);
    evaluateBirth(label, birth);
    await page.screenshot({ path: join(outDir, `${label}-birth.png`) });

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

      // GPT-0029-B：0–6 歲的主畫面（life phase）也不能出現重心區塊。
      if (actual === "life") {
        const early = await page.evaluate(focusSnapshot);
        if (early.age < 7) {
          check(
            `${label}_life_no_focus_before_school`,
            !early.focusPresent && early.shellFocus === "none",
            `age=${early.age} present=${early.focusPresent}`
          );
        }
      }

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
    /* ---------------------------------------------------------------- */
    /* GPT-0029-B：人生重心專屬 probe（乾淨 context，不干擾既有 golden 量測） */
    /* ---------------------------------------------------------------- */
    const focusContext = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    const focusPage = await focusContext.newPage();
    await focusPage.goto(`${baseUrl}/?seed=${encodeURIComponent(GOLDEN_SEED)}`, { waitUntil: "domcontentloaded" });
    await focusPage.waitForSelector("[data-p3e-live='true']", { timeout: 30000 });
    await focusPage.locator('[data-action="start-life"], [data-action="begin-life"]').first().click();
    await focusPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") === "life",
      undefined,
      { timeout: 20000 }
    );

    const age7 = await runToAge(focusPage, 7);
    const picker = await focusPage.evaluate(focusSnapshot);
    evaluateFocusPicker(label, picker);
    // GPT-0038-B：七個尺寸都實測 Tab 不會離開必選 dialog。
    await focusPage.keyboard.press("Tab");
    const tabState = await focusPage.evaluate(() => {
      const dialog = document.querySelector(
        '.p3e-focus-panel[data-p3e-focus-dialog="required"]'
      );
      const active = document.activeElement;
      return {
        inside: dialog !== null && dialog.contains(active),
        action: active?.getAttribute?.("data-action") ?? null,
        inert: active?.closest?.("[inert]") !== null
      };
    });
    check(
      `${label}_focus_picker_tab_stays_inside_dialog`,
      tabState.inside === true && tabState.inert === false && tabState.action === "set-focus",
      `inside=${tabState.inside} action=${tabState.action} inert=${tabState.inert}`
    );
    await focusPage.screenshot({ path: join(outDir, `${label}-focus-picker.png`) });
    const bottom = await focusPage.evaluate(focusBottomProbe);
    check(
      `${label}_focus_picker_local_scroll_reaches_last_option`,
      bottom.lastOptionVisible && bottom.dismissCount === 0 &&
        bottom.docY <= 1 && bottom.bodyY <= 1 && bottom.scrolled === 0,
      `last=${bottom.lastOptionVisible} dismissCount=${bottom.dismissCount} scrollTop=${bottom.scrollTop} scrollable=${bottom.scrollable} docY=${bottom.docY}`
    );
    // GPT-0036-B D：必選畫面必須真的把 clock 與所有推進控制鎖住。
    const gate = await focusPage.evaluate(() => {
      const live = document.querySelector("[data-p3e-live]");
      const q = (selector) => document.querySelector(selector);
      return {
        required: live?.getAttribute("data-p3e-focus-required") ?? null,
        held: live?.getAttribute("data-p3e-clock-held") ?? null,
        running: live?.getAttribute("data-p3e-clock-running") ?? null,
        advanceDisabled: q('[data-action="advance"]')?.disabled ?? null,
        timeDisabled: q('[data-action="toggle-time"]')?.disabled ?? null,
        speedDisabled: q('[data-speed="4"]')?.disabled ?? null,
        compareRows: document.querySelectorAll(".p3e-compare-row").length,
        settingsTitle: q(".p3e-menu-title")?.textContent ?? null,
        standaloneGears: document.querySelectorAll(".p3e-tools").length
      };
    });
    check(
      `${label}_focus_required_gate_and_new_chrome`,
      gate.required === "true" && gate.held === "true" && gate.running === "false" &&
        gate.advanceDisabled === true && gate.timeDisabled === true && gate.speedDisabled === true &&
        gate.compareRows === 2 && toHant(gate.settingsTitle).equals("⚙ 設定與存檔") &&
        gate.standaloneGears === 0,
      `required=${gate.required} held=${gate.held} advance=${gate.advanceDisabled} rows=${gate.compareRows} title=${gate.settingsTitle}`
    );
    await focusPage.evaluate(() => {
      const box = document.querySelector('.p3e-focus[data-p3e-focus-expanded="true"]');
      if (box !== null) box.scrollTop = 0;
    });

    await focusPage.locator('[data-action="set-focus"][data-focus-id="study"]').first().click();
    await focusPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-life-focus") === "study",
      undefined,
      { timeout: 15000 }
    );
    const chosen = await focusPage.evaluate(focusSnapshot);
    evaluateFocusChosen(label, chosen, "學業", true);
    await focusPage.screenshot({ path: join(outDir, `${label}-focus-chosen.png`) });

    // 重心必須進正式存檔：等 autosave 落盤後重整，畫面仍要是同一個重心。
    await focusPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-persistence-status") === "saved",
      undefined,
      { timeout: 20000 }
    );
    await focusPage.reload({ waitUntil: "domcontentloaded" });
    await focusPage.waitForFunction(
      () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-life-focus") === "study",
      undefined,
      { timeout: 20000 }
    );
    const restored = await focusPage.evaluate(focusSnapshot);
    check(
      `${label}_focus_survives_reload`,
      restored.shellFocus === "study" &&
        restored.lineText.includes("目前重心：") &&
        restored.overflow.docY <= 1 && restored.overflow.bodyY <= 1,
      `focus=${restored.shellFocus} line="${restored.lineText}" docY=${restored.overflow.docY}`
    );

    const age18 = await runToAge(focusPage, 18);
    const adult = await focusPage.evaluate(focusSnapshot);
    check(
      `${label}_focus_adult_label_is_work`,
      age18 >= 18 && adult.shellFocus === "study" && adult.lineText.includes("目前重心：工作") &&
        !adult.lineText.includes("目前重心：學業") && adult.overflow.docY <= 1,
      `age=${age18} line="${adult.lineText}" docY=${adult.overflow.docY}`
    );
    await focusPage.screenshot({ path: join(outDir, `${label}-focus-adult.png`) });

    report.viewports.push({ label, phases, birth, focus: { age7, picker, chosen, restored, age18, adult } });
    await focusContext.close();
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
