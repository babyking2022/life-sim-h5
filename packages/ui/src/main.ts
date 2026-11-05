import "./style.css";
import rawFrame from "../../../fixtures/ui-frame.json";

type Screen = "life" | "family" | "work" | "map" | "choice" | "settings" | "death";
type Tab = "life" | "family" | "work" | "map";
type SheetName = "choice" | "settings" | "info" | "migrate" | "share" | "rebirth";
type Frame = typeof rawFrame;
type ChromeKey = keyof Frame["chrome"];
type DisplayKey = "theme" | "language" | "reduceMotion" | "sound" | "haptics" | "speed" | "auto" | "contentMode";

interface DisplayPreferences {
  theme: "light" | "dark";
  language: "zh-CN" | "en-US";
  reduceMotion: boolean;
  sound: boolean;
  haptics: boolean;
  speed: "1x" | "2x" | "4x";
  auto: "ask" | "semi" | "full";
  contentMode: "standard" | "gentle" | "realistic";
}

interface NavState {
  route: Screen;
  sheet: SheetName | null;
  member: string | null;
}

const frame = rawFrame as Frame;
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("missing #app");

const STORAGE_KEY = "p1c-display-v1";
const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
const scrollByTab: Record<Tab, number> = { life: 0, family: 0, work: 0, map: 0 };

const display: DisplayPreferences = loadDisplay();

const state = {
  route: "life" as Screen,
  sheet: null as SheetName | null,
  member: null as string | null,
  tab: "life" as Tab,
  cardIndex: 0,
  paused: false,
  choiceId: null as string | null,
  choiceConfirmed: false,
  workTab: "education" as string,
  mapCountry: frame.map.currentCountryId,
  migrateId: null as string | null,
  deathExpanded: false
};

let sheetTriggers: Array<HTMLElement | null> = [];
let memberReturnId: string | null = null;
let renderedMember: string | null = null;
let toastTimer = 0;

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function must<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
}

function t(key: ChromeKey): string {
  return frame.chrome[key];
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function icon(name: string, className = ""): string {
  const paths: Record<string, string> = {
    calendar: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M7 2v4M17 2v4M3 9h18"/><path d="M8 13h2M14 13h2M8 17h2"/>',
    coin: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M9.3 9.2c0-1.1 1.2-1.8 2.7-1.8s2.7.7 2.7 1.8-1.2 1.8-2.7 1.8-2.7.7-2.7 1.8 1.2 1.8 2.7 1.8 2.7-.7 2.7-1.8"/>',
    leaf: '<path d="M20 4C12 4 5 8 5 16c0 2 1 4 3 4 8 0 12-7 12-16Z"/><path d="M4 21c2-6 6-9 12-12"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v11h14V10"/><path d="M9 21v-6h6v6"/>',
    family: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.4"/><path d="M3 21v-2c0-3 2.7-5 6-5s6 2 6 5v2"/><path d="M15 14c2.8.2 5 2 5 4.5V21"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    "chevron-left": '<path d="m15 6-6 6 6 6"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-up": '<path d="m6 15 6-6 6 6"/>',
    book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22V4.5Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
    share: '<path d="M12 3v11"/><path d="m8 7 4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 4v4h-4"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 20v-4h4"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 21v-2c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5v2"/><circle cx="18" cy="9" r="2.6"/><path d="M17 14c2.6.3 4.5 2 4.5 4.3V21"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="17" cy="14.5" r="1.2"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7h-5M21 7v5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8h.01"/>',
    location: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>'
  };
  return `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.chevron}</svg>`;
}

function focusSheet(sheet: HTMLElement): void {
  sheet.setAttribute("tabindex", "-1");
  window.setTimeout(() => sheet.focus(), 0);
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])"))
    .filter((node) => !node.hidden && node.offsetParent !== null);
}

function toast(message: string): void {
  const node = document.querySelector<HTMLElement>("[data-toast]");
  if (!node) return;
  node.textContent = message;
  node.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove("is-visible"), 2400);
}

/* ------------------------------------------------------------------ */
/* display preferences                                                */
/* ------------------------------------------------------------------ */

function loadDisplay(): DisplayPreferences {
  const fallback: DisplayPreferences = {
    theme: "light",
    language: "zh-CN",
    reduceMotion: prefersReducedMotion,
    sound: true,
    haptics: true,
    speed: "1x",
    auto: "ask",
    contentMode: "standard"
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DisplayPreferences>;
    return {
      theme: parsed.theme === "dark" ? "dark" : "light",
      language: parsed.language === "en-US" ? "en-US" : "zh-CN",
      reduceMotion: Boolean(parsed.reduceMotion),
      sound: parsed.sound !== false,
      haptics: parsed.haptics !== false,
      speed: parsed.speed === "2x" || parsed.speed === "4x" ? parsed.speed : "1x",
      auto: parsed.auto === "semi" || parsed.auto === "full" ? parsed.auto : "ask",
      contentMode: parsed.contentMode === "gentle" || parsed.contentMode === "realistic" ? parsed.contentMode : "standard"
    };
  } catch {
    return fallback;
  }
}

function persistDisplay(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(display));
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
}

function applyDisplay(): void {
  document.documentElement.dataset.theme = display.theme;
  document.documentElement.lang = display.language;
  document.documentElement.classList.toggle("reduce-motion", display.reduceMotion);
  const langLabel = document.querySelector<HTMLElement>("[data-language-label]");
  if (langLabel) langLabel.textContent = display.language === "zh-CN" ? "简体中文" : "English";
  document.querySelectorAll<HTMLElement>("[data-setting]").forEach((node) => {
    const key = node.dataset.setting as DisplayKey;
    if (node.getAttribute("role") === "switch") {
      const on = display[key] === true;
      node.setAttribute("aria-checked", String(on));
      node.dataset.checked = String(on);
      const text = node.querySelector<HTMLElement>("[data-switch-text]");
      if (text) text.textContent = on ? "开" : "关";
      return;
    }
    const value = String(display[key]);
    node.setAttribute("aria-pressed", String(node.dataset.value === value));
  });
  const pauseLabel = document.querySelector<HTMLElement>("[data-pause-label]");
  if (pauseLabel) pauseLabel.textContent = state.paused ? t("resume") : t("pause");
  const pauseButton = document.querySelector<HTMLElement>("[data-action='pause']");
  if (pauseButton) {
    pauseButton.setAttribute("aria-pressed", String(state.paused));
    pauseButton.setAttribute("aria-label", state.paused ? t("resume") : t("pause"));
    const svg = pauseButton.querySelector("svg");
    if (svg) svg.outerHTML = icon(state.paused ? "play" : "pause");
  }
}

/* ------------------------------------------------------------------ */
/* static scene                                                       */
/* ------------------------------------------------------------------ */

function sceneSvg(): string {
  return `
    <svg class="scene-svg" viewBox="0 0 420 250" role="img" aria-label="${esc(frame.scene.alt)}" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#71c7e8"/><stop offset="0.62" stop-color="#b8e5dd"/><stop offset="1" stop-color="#f0e7b9"/>
        </linearGradient>
        <linearGradient id="roof" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#d67b43"/><stop offset="1" stop-color="#9c452d"/>
        </linearGradient>
        <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#76b552"/><stop offset="1" stop-color="#3d7e43"/>
        </linearGradient>
      </defs>
      <rect width="420" height="250" fill="url(#sky)"/>
      <circle cx="346" cy="42" r="25" fill="#ffe277" opacity="0.95"/>
      <circle cx="346" cy="42" r="34" fill="#ffe277" opacity="0.18"/>
      <g fill="#fffdf0" opacity="0.9">
        <rect x="34" y="38" width="50" height="8" rx="4"/><rect x="48" y="27" width="33" height="8" rx="4"/><rect x="60" y="47" width="38" height="7" rx="3.5"/>
        <rect x="244" y="58" width="58" height="8" rx="4"/><rect x="258" y="47" width="35" height="8" rx="4"/>
      </g>
      <path d="M0 138 45 91l36 41 44-58 54 64 40-31 55 43 40-58 58 48 48-36v86H0Z" fill="#8fbfa4" opacity="0.9"/>
      <path d="M0 166 54 126l53 38 49-25 56 31 61-22 59 33 50-27 38 18v78H0Z" fill="#6b9f77" opacity="0.9"/>
      <path d="M0 193c55-19 101-18 145-5 42 13 86 16 137 3 47-12 98-10 138 7v52H0Z" fill="url(#grass)"/>
      <g fill="#3f7d3c">
        <ellipse cx="24" cy="177" rx="21" ry="9"/><ellipse cx="65" cy="169" rx="17" ry="7"/><ellipse cx="390" cy="181" rx="25" ry="10"/>
      </g>
      <g>
        <path d="M278 109h87v70h-87Z" fill="#f0d9a6"/><path d="m268 109 54-39 55 39Z" fill="url(#roof)"/><path d="M294 124h18v25h-18Z" fill="#7e513a"/><path d="M329 126h17v17h-17Z" fill="#85c9d4"/><path d="M330 127h15v15h-15Z" fill="#e8f5e8" opacity="0.8"/><path d="M350 76h12v24h-12Z" fill="#9e5c42"/><path d="M348 74h16v7h-16Z" fill="#6f3e31"/>
        <path d="M252 179h145v7H252Z" fill="#c4a373"/><path d="M265 184v19M280 184v19M295 184v19M310 184v19M325 184v19M340 184v19M355 184v19M370 184v19M385 184v19" stroke="#895d3a" stroke-width="4"/>
      </g>
      <g>
        <path d="M92 132c0-18 8-30 19-30s19 12 19 30" fill="#3b7f48"/><rect x="108" y="128" width="7" height="53" rx="3" fill="#704431"/>
        <circle cx="86" cy="137" r="25" fill="#4d9150"/><circle cx="128" cy="128" r="28" fill="#4d9150"/><circle cx="108" cy="111" r="30" fill="#62a65e"/><circle cx="100" cy="140" r="22" fill="#5a9d58"/>
      </g>
      <g>
        <ellipse cx="180" cy="218" rx="38" ry="7" fill="#315e37" opacity="0.45"/>
        <circle cx="165" cy="164" r="12" fill="#efc9a0"/><rect x="153" y="176" width="25" height="36" rx="8" fill="#6d7e9f"/><rect x="157" y="209" width="7" height="14" rx="3" fill="#4a3f38"/><rect x="170" y="209" width="7" height="14" rx="3" fill="#4a3f38"/>
        <circle cx="194" cy="170" r="10" fill="#f0c7a0"/><rect x="184" y="180" width="21" height="31" rx="7" fill="#a25f58"/><rect x="187" y="208" width="6" height="13" rx="3" fill="#4a3f38"/><rect x="198" y="208" width="6" height="13" rx="3" fill="#4a3f38"/>
        <circle cx="216" cy="160" r="11" fill="#efc49b"/><rect x="205" y="171" width="23" height="38" rx="8" fill="#7b8d73"/><rect x="209" y="207" width="7" height="14" rx="3" fill="#4a3f38"/><rect x="222" y="207" width="7" height="14" rx="3" fill="#4a3f38"/>
      </g>
      <g>
        <ellipse cx="382" cy="218" rx="10" ry="8" fill="#fff8df"/><circle cx="391" cy="207" r="6" fill="#fff8df"/><path d="m396 206 5 2-5 2Z" fill="#e3a23a"/><path d="M389 201c-2-4 1-6 4-4" stroke="#d8633c" stroke-width="2.5" fill="none"/><path d="M376 218v8M383 218v8" stroke="#c69234" stroke-width="2"/>
      </g>
      <g fill="#fff4c9">
        <circle cx="142" cy="196" r="2"/><circle cx="162" cy="201" r="2"/><circle cx="231" cy="214" r="2"/><circle cx="250" cy="190" r="2"/><circle cx="300" cy="199" r="2"/>
      </g>
    </svg>`;
}

/* ------------------------------------------------------------------ */
/* shared fragments                                                   */
/* ------------------------------------------------------------------ */

function statBar(stat: { label: string; value: number; percent: number; tone: string; key?: string }, key: string): string {
  return `
    <div class="stat" data-stat="${esc(key)}">
      <div class="stat-head"><span class="stat-label">${esc(stat.label)}</span><strong class="stat-value">${stat.value}</strong></div>
      <div class="bar" role="progressbar" aria-label="${esc(stat.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${stat.value}">
        <span class="bar-fill tone-${esc(stat.tone)}" style="--pct:${stat.percent}%"></span>
      </div>
    </div>`;
}

function statBars(stats: Frame["stats"]): string {
  return stats.map((stat) => statBar(stat, stat.key)).join("");
}

function memberById(id: string): Frame["family"]["members"][number] | undefined {
  return frame.family.members.find((member) => member.id === id);
}

function bondBar(value: number, percent: number, tone: string, label: string): string {
  return `<div class="bar" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><span class="bar-fill tone-${esc(tone)}" style="--pct:${percent}%"></span></div>`;
}

/* ------------------------------------------------------------------ */
/* panels                                                             */
/* ------------------------------------------------------------------ */

function yearCardHtml(): string {
  const cards = frame.yearCards;
  const card = cards[state.cardIndex] ?? cards[0];
  if (!card) return "";
  return `
    <div class="card-head"><span class="tag">${esc(card.tag)}</span><span class="page-count">${esc(card.page)}</span></div>
    <h2>${esc(card.title)}</h2>
    <div class="card-lines">${card.lines.map((line) => `<p>${esc(line)}</p>`).join("")}</div>
    <div class="card-highlight"><span class="dot" aria-hidden="true"></span>${esc(card.highlight)}</div>`;
}

function panelLife(): string {
  return `
    <section class="panel" data-panel="life" id="panel-life" role="tabpanel" aria-labelledby="tab-life" tabindex="0">
      <div class="scene-frame">
        <div class="scene-media">${sceneSvg()}</div>
        <div class="scene-meta">
          <span class="tag scene-chip">${esc(frame.scene.time)}</span>
          <p class="scene-caption">${esc(frame.scene.caption)}</p>
        </div>
      </div>
      <article class="year-card" data-year-card aria-live="polite">${yearCardHtml()}</article>
      <button class="choice-teaser" type="button" data-action="open-choice">
        <span class="teaser-icon" aria-hidden="true">${icon("compass")}</span>
        <span class="teaser-copy">
          <span class="eyebrow">${esc(frame.choice.tag)}</span>
          <strong class="teaser-title">${esc(frame.choice.title)}</strong>
          <span class="teaser-note">${esc(frame.choice.description)}</span>
        </span>
        ${icon("chevron", "teaser-chevron")}
      </button>
      <article class="daily-card">
        <span class="daily-icon" aria-hidden="true">${icon("home")}</span>
        <div class="daily-copy">
          <span class="eyebrow">家里的小事</span>
          <strong>${esc(frame.family.homeValue)}</strong>
          <p>${esc(frame.family.moments[1]?.body ?? frame.family.intro)}</p>
        </div>
      </article>
      <p class="panel-footnote">${esc(frame.build.note)}</p>
    </section>`;
}

function familyTreeHtml(): string {
  const family = frame.family;
  const lookup: Array<{ id: string; name: string; role: string; tone: string; initial: string }> = [family.player, ...family.members];
  const rows = family.tree
    .map((row) => {
      const rowNodes = row.nodeIds
        .map((id) => {
          const member = lookup.find((item) => item.id === id);
          if (!member) return "";
          return `
            <button class="tree-node" type="button" data-action="open-member" data-member="${esc(member.id)}" aria-label="${esc(`${member.name} · ${member.role} · 查看详情`)}">
              <span class="avatar tone-${esc(member.tone)}" aria-hidden="true">${esc(member.initial)}</span>
              <span class="tree-copy"><strong>${esc(member.name)}</strong><span>${esc(member.role)}</span></span>
            </button>`;
        })
        .join("");
      const empty = rowNodes.length === 0 ? `<p class="tree-empty">${esc(family.childrenEmpty.title)}</p>` : "";
      return `<div class="tree-row"><span class="tree-label">${esc(row.label)}</span><div class="tree-nodes">${rowNodes || empty}</div></div>`;
    })
    .join("");
  return `<div class="tree" role="group" aria-label="${esc(family.treeLabel)}">${rows}</div>`;
}

function familyListHtml(): string {
  const family = frame.family;
  const partner = family.members.find((member) => member.role === family.partnerLabel);
  return `
    <div class="section-head"><span class="eyebrow">${esc(family.subheading)}</span><h2>${esc(family.heading)}</h2><p>${esc(family.intro)}</p></div>
    ${familyTreeHtml()}
    <div class="card-block">
      <h3>${esc(family.partnerLabel)}</h3>
      ${partner
        ? `<article class="member-card">
            <span class="avatar tone-${esc(partner.tone)}" aria-hidden="true">${esc(partner.initial)}</span>
            <div class="member-copy"><strong>${esc(partner.name)}</strong><span class="member-role">${esc(partner.role)} · ${partner.age} 岁</span><p>${esc(partner.note)}</p></div>
            <span class="member-bond">${partner.bond}</span>
          </article>`
        : `<p class="empty-state">${esc(family.partnerEmpty)}</p>`}
    </div>
    <div class="card-block">
      <h3>${esc(family.childrenLabel)}</h3>
      <div class="empty-state">
        <strong>${esc(family.childrenEmpty.title)}</strong>
        <p>${esc(family.childrenEmpty.body)}</p>
      </div>
    </div>
    <div class="card-block">
      <h3>${esc(family.relationshipsLabel)}</h3>
      <div class="relation-list">
        ${family.relationships
          .map(
            (relation) => `<div class="relation-row">
              <div class="relation-head"><span>${esc(relation.label)}</span><strong>${relation.value}</strong></div>
              ${bondBar(relation.value, relation.percent, relation.tone, relation.label)}
              <span class="relation-note">${esc(relation.note)}</span>
            </div>`
          )
          .join("")}
      </div>
    </div>
    <div class="home-band"><span>${esc(family.homeLabel)}</span><strong>${esc(family.homeValue)}</strong></div>
    <div class="moment-list">
      ${family.moments.map((moment) => `<article class="moment-card"><span class="tag">${esc(moment.tag)}</span><h3>${esc(moment.title)}</h3><p>${esc(moment.body)}</p></article>`).join("")}
    </div>
    <p class="panel-footnote">${esc(family.homeNote)}</p>`;
}

function familyDetailHtml(member: Frame["family"]["members"][number]): string {
  const detail = frame.family.detail;
  return `
    <div class="detail-head">
      <button class="back-button" type="button" data-action="close-member">${icon("chevron-left")}<span>${esc(detail.back)}</span></button>
      <span class="eyebrow">${esc(detail.detailLabel)}</span>
    </div>
    <article class="detail-card">
      <div class="detail-person">
        <span class="avatar avatar-lg tone-${esc(member.tone)}" aria-hidden="true">${esc(member.initial)}</span>
        <h2 data-member-title>${esc(member.name)}<small>${esc(member.role)}</small></h2>
      </div>
      <dl class="fact-grid">
        <div><dt>${esc(detail.ageLabel)}</dt><dd>${member.age} 岁</dd></div>
        <div><dt>${esc(detail.relationLabel)}</dt><dd>${member.bond}</dd></div>
      </dl>
      ${bondBar(member.bond, member.bond, member.tone, detail.relationLabel)}
      <p class="detail-note">${esc(member.note)}</p>
      <p class="detail-bond">${esc(member.bondNote)}</p>
    </article>
    <h3 class="subsection-title">${esc(detail.eventsLabel)}</h3>
    <div class="moment-list">
      ${member.events.map((event) => `<article class="moment-card"><span class="tag">${esc(event.tag)}</span><h3>${esc(event.title)}</h3><p>${esc(event.body)}</p></article>`).join("")}
    </div>
    <button class="primary-button" type="button" data-action="close-member">${esc(detail.back)}</button>`;
}

function panelFamily(): string {
  const member = state.member ? memberById(state.member) : undefined;
  const body = member ? familyDetailHtml(member) : familyListHtml();
  return `
    <section class="panel" data-panel="family" id="panel-family" role="tabpanel" aria-labelledby="tab-family" tabindex="0">
      ${body}
    </section>`;
}

function workEducationHtml(): string {
  const edu = frame.work.education;
  return `
    <article class="job-card">
      <div class="job-top"><span class="job-icon" aria-hidden="true">${icon("book")}</span><div><span class="tag">${esc(edu.period)}</span><h3>${esc(edu.level)}</h3></div></div>
      <p>${esc(edu.school)}</p>
      <p class="muted">${esc(edu.note)}</p>
    </article>
    <dl class="fact-grid fact-grid-wide">
      ${edu.rows.map((row) => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join("")}
    </dl>`;
}

function workCareerHtml(): string {
  const career = frame.work.career;
  return `
    <article class="job-card">
      <div class="job-top"><span class="job-icon" aria-hidden="true">${icon("briefcase")}</span><div><span class="tag">${esc(career.jobTag)}</span><h3>${esc(career.jobTitle)}</h3></div></div>
      <p>${esc(career.employer)} · ${esc(career.period)}</p>
      <p class="muted">${esc(career.note)}</p>
    </article>
    <section class="card-block" aria-labelledby="skill-title"><h3 id="skill-title">正在积累</h3>
      ${career.skills
        .map(
          (skill) => `<div class="skill-line"><div class="relation-head"><span>${esc(skill.label)}</span><strong>${skill.value}</strong></div>${bondBar(skill.value, skill.percent, skill.tone, skill.label)}</div>`
        )
        .join("")}
    </section>`;
}

function workIncomeHtml(): string {
  const income = frame.work.income;
  return `
    <article class="job-card">
      <span class="eyebrow">${esc(income.totalLabel)}</span>
      <p class="income-value">${esc(income.total)}</p>
      <p class="muted">${esc(income.note)}</p>
    </article>
    <dl class="fact-grid fact-grid-wide">
      ${income.breakdown.map((row) => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join("")}
    </dl>`;
}

function workJobsHtml(): string {
  const jobs = frame.work.jobs;
  return `
    <p class="panel-intro">${esc(jobs.intro)}</p>
    <div class="opening-list">
      ${jobs.openings
        .map(
          (opening) => `<article class="opening-card">
            <div class="opening-head"><div><span class="tag">${esc(opening.tag)}</span><h3>${esc(opening.title)}</h3><span class="muted">${esc(opening.employer)}</span></div><strong class="opening-pay">${esc(opening.pay)}</strong></div>
            <p>${esc(opening.note)}</p>
            <button class="secondary-button" type="button" data-action="job-detail" data-job="${esc(opening.id)}">${esc(jobs.action)}</button>
          </article>`
        )
        .join("")}
    </div>
    <p class="panel-footnote">${esc(jobs.sheetNote)}</p>`;
}

function workRetireHtml(): string {
  const retire = frame.work.retire;
  return `
    <p class="panel-intro">${esc(retire.intro)}</p>
    <div class="retire-grid">
      <div><span class="muted">${esc(retire.currentAgeLabel)}</span><strong>${esc(retire.currentAge)}</strong></div>
      <div><span class="muted">${esc(retire.retireAgeLabel)}</span><strong>${esc(retire.retireAge)}</strong></div>
      <div><span class="muted">${esc(retire.yearsLabel)}</span><strong>${esc(retire.years)}</strong></div>
    </div>
    <p class="status-line">${esc(retire.status)}</p>
    <dl class="fact-grid fact-grid-wide">
      ${retire.projection.map((row) => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join("")}
    </dl>
    <button class="secondary-button" type="button" data-action="retire-detail">${esc(retire.action)}</button>
    <p class="panel-footnote">${esc(retire.sheetNote)}</p>`;
}

function workPaneHtml(): string {
  if (state.workTab === "education") return workEducationHtml();
  if (state.workTab === "career") return workCareerHtml();
  if (state.workTab === "income") return workIncomeHtml();
  if (state.workTab === "jobs") return workJobsHtml();
  return workRetireHtml();
}

function panelWork(): string {
  const work = frame.work;
  return `
    <section class="panel" data-panel="work" id="panel-work" role="tabpanel" aria-labelledby="tab-work" tabindex="0" hidden>
      <div class="section-head"><span class="eyebrow">${esc(work.subheading)}</span><h2>${esc(work.heading)}</h2><p>${esc(work.intro)}</p></div>
      <div class="segmented work-tabs" role="group" aria-label="工作子区">
        ${work.tabs
          .map((tab) => `<button type="button" data-action="work-tab" data-work-tab="${esc(tab.id)}" aria-pressed="${state.workTab === tab.id}">${esc(tab.label)}</button>`)
          .join("")}
      </div>
      <div class="work-pane" data-work-pane="${esc(state.workTab)}">${workPaneHtml()}</div>
      <div class="moment-list">
        ${work.log.map((item) => `<article class="moment-card"><span class="tag">${esc(item.tag)}</span><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p></article>`).join("")}
      </div>
      <p class="panel-footnote">${esc(work.note)}</p>
    </section>`;
}

function currentCountry(): Frame["map"]["countries"][number] {
  const current = frame.map.countries.find((country) => country.id === frame.map.currentCountryId);
  return current ?? frame.map.countries[0]!;
}

function selectedCountry(): Frame["map"]["countries"][number] {
  const selected = frame.map.countries.find((country) => country.id === state.mapCountry);
  return selected ?? currentCountry();
}

function panelMap(): string {
  const map = frame.map;
  const country = selectedCountry();
  const positions = [
    { left: "18%", top: "62%" },
    { left: "58%", top: "34%" },
    { left: "33%", top: "28%" },
    { left: "72%", top: "70%" },
    { left: "48%", top: "80%" }
  ];
  return `
    <section class="panel" data-panel="map" id="panel-map" role="tabpanel" aria-labelledby="tab-map" tabindex="0" hidden>
      <div class="section-head"><span class="eyebrow">${esc(map.subheading)}</span><h2>${esc(map.heading)}</h2><p>${esc(map.intro)}</p></div>
      <article class="country-now">
        <div><span class="eyebrow">${esc(map.currentLabel)}</span><strong data-current-country>${esc(currentCountry().name)}</strong><span class="muted">${esc(currentCountry().region)}</span></div>
        <span class="badge">${esc(map.currentBadge)}</span>
      </article>
      <div class="card-block">
        <h3>${esc(map.statsLabel)}</h3>
        <div class="country-head"><strong data-country-name>${esc(country.name)}</strong><span class="muted" data-country-region>${esc(country.region)}</span></div>
        <dl class="stat-grid" data-country-stats>
          ${country.stats.map((stat) => `<div><dt>${esc(stat.label)}</dt><dd>${esc(stat.value)}</dd></div>`).join("")}
        </dl>
        <p class="muted" data-country-note>${esc(country.note)}</p>
      </div>
      <div class="chip-row" role="group" aria-label="${esc(map.switchLabel)}">
        ${map.countries
          .map((item) => `<button type="button" class="chip" data-action="map-country" data-country="${esc(item.id)}" aria-pressed="${state.mapCountry === item.id}">${esc(item.name)}</button>`)
          .join("")}
      </div>
      <div class="map-board" role="img" aria-label="静态地图示意">
        <div class="map-grid" aria-hidden="true"></div>
        <svg class="map-route" viewBox="0 0 320 180" aria-hidden="true"><path d="M55 110 105 65 160 105 238 55 190 145Z"/></svg>
        ${map.places
          .map(
            (place, index) =>
              `<span class="map-pin tone-${esc(place.tone)} ${place.current ? "map-pin-current" : ""}" style="left:${positions[index]?.left ?? "50%"};top:${positions[index]?.top ?? "50%"}"><span class="pin-index" aria-hidden="true">${index + 1}</span></span>`
          )
          .join("")}
      </div>
      <div class="place-list">
        ${map.places
          .map(
            (place, index) => `<article class="place-card ${place.current ? "is-current" : ""}"><span class="place-index" aria-hidden="true">${index + 1}</span><div><span class="tag">${esc(place.kind)}</span><h3>${esc(place.name)}</h3><p>${esc(place.note)}</p></div><span class="distance">${esc(place.distance)}</span></article>`
          )
          .join("")}
      </div>
      <button class="primary-button" type="button" data-action="open-migrate">${icon("location")}<span>${esc(map.migrate.label)}</span></button>
      <p class="panel-footnote">${esc(map.note)} ${esc(map.legend)}</p>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* sheets                                                             */
/* ------------------------------------------------------------------ */

function choiceSheet(): string {
  const choice = frame.choice;
  return `
    <div class="sheet-layer" data-sheet="choice" hidden>
      <div class="sheet-backdrop" data-action="close-sheet" aria-hidden="true"></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="choice-title" aria-describedby="choice-desc">
        <div class="sheet-grip" aria-hidden="true"></div>
        <div class="sheet-head">
          <div><span class="eyebrow">${esc(choice.tag)}</span><h2 id="choice-title">${esc(choice.title)}</h2></div>
          <button class="icon-button" type="button" data-action="close-sheet" aria-label="${esc(t("close"))}">${icon("close")}</button>
        </div>
        <div class="pause-badge" role="status">
          <span class="pause-badge-icon" aria-hidden="true">${icon("pause")}</span>
          <span class="pause-badge-copy"><strong>${esc(choice.pausedBadge)}</strong><span>${esc(choice.pausedNote)}</span></span>
          <span class="pause-badge-time"><span>${esc(choice.remainingLabel)}</span><strong>${esc(choice.remainingValue)}</strong></span>
        </div>
        <p class="sheet-intro" id="choice-desc">${esc(choice.description)}</p>
        <div class="choice-list">
          ${frame.choices
            .map(
              (option) => `<button class="choice-option tone-${esc(option.tone)}" type="button" data-action="select-choice" data-choice="${esc(option.id)}" aria-pressed="false">
                <span class="choice-icon" aria-hidden="true">${icon(option.icon)}</span>
                <span class="choice-copy"><strong>${esc(option.title)}</strong><span>${esc(option.description)}</span></span>
                <span class="choice-check" aria-hidden="true">${icon("check")}</span>
              </button>`
            )
            .join("")}
        </div>
        <p class="choice-hint" data-choice-hint>${esc(choice.disabledHint)}</p>
        <div class="choice-consequence" data-consequence hidden>
          <span class="eyebrow">${esc(choice.consequenceKicker)}</span>
          <h3 data-consequence-title></h3>
          <p data-consequence-body></p>
          <small>${esc(choice.consequenceNote)}</small>
        </div>
        <button class="primary-button" type="button" data-action="confirm-choice" disabled>${esc(choice.confirm)}</button>
        <p class="sheet-note">${esc(choice.consequenceNote)}</p>
      </section>
    </div>`;
}

function settingControl(item: Frame["settings"]["groups"][number]["items"][number]): string {
  const key = item.id as DisplayKey;
  if (item.kind === "switch") {
    const on = display[key] === true;
    return `<button class="switch" type="button" role="switch" aria-checked="${on}" data-action="toggle-setting" data-setting="${esc(item.id)}" aria-label="${esc(item.label)}" aria-describedby="setting-desc-${esc(item.id)}">
      <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
      <span class="switch-text" data-switch-text>${on ? "开" : "关"}</span>
    </button>`;
  }
  return `<div class="segmented" role="group" aria-label="${esc(item.label)}" id="setting-${esc(item.id)}">
    ${item.options
      .map(
        (option) => `<button type="button" data-action="set-option" data-setting="${esc(item.id)}" data-value="${esc(option.value)}" aria-pressed="${String(display[key]) === option.value}">${esc(option.label)}</button>`
      )
      .join("")}
  </div>`;
}

function settingsSheet(): string {
  const settings = frame.settings;
  return `
    <div class="sheet-layer" data-sheet="settings" hidden>
      <div class="sheet-backdrop" data-action="close-sheet" aria-hidden="true"></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="sheet-grip" aria-hidden="true"></div>
        <div class="sheet-head">
          <div><span class="eyebrow">P1-C.1</span><h2 id="settings-title">${esc(settings.heading)}</h2></div>
          <button class="icon-button" type="button" data-action="close-sheet" aria-label="${esc(settings.closeLabel)}">${icon("close")}</button>
        </div>
        <p class="sheet-intro">${esc(settings.subheading)}</p>
        ${settings.groups
          .map(
            (group) => `<section class="settings-group" aria-label="${esc(group.label)}">
              <h3>${esc(group.label)}</h3>
              ${group.items
                .map(
                  (item) => `<div class="setting-row">
                    <div class="setting-copy"><strong>${esc(item.label)}</strong><span id="setting-desc-${esc(item.id)}">${esc(item.description)}</span></div>
                    ${settingControl(item)}
                  </div>`
                )
                .join("")}
            </section>`
          )
          .join("")}
        <section class="settings-group" aria-label="${esc(settings.save.label)}">
          <h3>${esc(settings.save.label)}</h3>
          <div class="save-card">
            <strong>${esc(settings.save.status)}</strong>
            <p>${esc(settings.save.description)}</p>
            <dl class="fact-grid fact-grid-wide">
              ${settings.save.items.map((row) => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join("")}
            </dl>
          </div>
        </section>
        <section class="settings-group" aria-label="${esc(settings.about.label)}">
          <h3>${esc(settings.about.label)}</h3>
          <button class="link-row" type="button" data-action="open-info" data-info="about">
            <span class="link-copy"><strong>${esc(settings.about.label)}</strong><span>${esc(settings.about.description)}</span></span>
            ${icon("chevron")}
          </button>
        </section>
        <p class="storage-note">${esc(settings.storageNote)}</p>
        <button class="secondary-button" type="button" data-action="open-death">${esc(settings.summaryLabel)}<span class="button-sub">${esc(settings.summaryDescription)}</span></button>
        <span class="sr-only" data-language-label>简体中文</span>
      </section>
    </div>`;
}

function infoSheet(): string {
  return `
    <div class="sheet-layer" data-sheet="info" hidden>
      <div class="sheet-backdrop" data-action="close-sheet" aria-hidden="true"></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="info-title">
        <div class="sheet-grip" aria-hidden="true"></div>
        <div class="sheet-head">
          <div><span class="eyebrow">详情</span><h2 id="info-title" data-info-title>详情</h2></div>
          <button class="icon-button" type="button" data-action="close-sheet" aria-label="${esc(t("close"))}">${icon("close")}</button>
        </div>
        <p class="sheet-intro" data-info-intro></p>
        <dl class="fact-grid fact-grid-wide" data-info-list></dl>
        <p class="sheet-note" data-info-note></p>
        <button class="primary-button" type="button" data-action="close-sheet">${esc(t("close"))}</button>
      </section>
    </div>`;
}

function migrateSheet(): string {
  const migrate = frame.map.migrate;
  return `
    <div class="sheet-layer" data-sheet="migrate" hidden>
      <div class="sheet-backdrop" data-action="close-sheet" aria-hidden="true"></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="migrate-title">
        <div class="sheet-grip" aria-hidden="true"></div>
        <div class="sheet-head">
          <div><span class="eyebrow">${esc(frame.map.currentLabel)}</span><h2 id="migrate-title">${esc(migrate.title)}</h2></div>
          <button class="icon-button" type="button" data-action="close-sheet" aria-label="${esc(t("close"))}">${icon("close")}</button>
        </div>
        <p class="sheet-intro">${esc(migrate.intro)}</p>
        <div class="choice-list">
          ${migrate.items
            .map(
              (item) => `<button class="migrate-option" type="button" data-action="select-migrate" data-migrate="${esc(item.id)}" aria-pressed="false">
                <span class="migrate-head"><strong>${esc(item.name)}</strong><span class="migrate-cost">${esc(item.cost)}</span></span>
                <span class="muted">${esc(item.note)}</span>
                <span class="requirement-list">${item.requirements.map((req) => `<span class="req-chip">${esc(req)}</span>`).join("")}</span>
              </button>`
            )
            .join("")}
        </div>
        <p class="choice-hint" data-migrate-hint>${esc(migrate.disabledHint)}</p>
        <div class="choice-consequence" data-migrate-consequence hidden>
          <span class="eyebrow">${esc(migrate.consequenceTitle)}</span>
          <p>${esc(migrate.consequenceBody)}</p>
          <small>${esc(migrate.note)}</small>
        </div>
        <button class="primary-button" type="button" data-action="confirm-migrate" disabled>${esc(migrate.confirm)}</button>
        <p class="sheet-note">${esc(migrate.note)}</p>
      </section>
    </div>`;
}

function shareSheet(): string {
  const share = frame.death.share;
  return `
    <div class="sheet-layer" data-sheet="share" hidden>
      <div class="sheet-backdrop" data-action="close-sheet" aria-hidden="true"></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div class="sheet-grip" aria-hidden="true"></div>
        <div class="sheet-head">
          <div><span class="eyebrow">${esc(frame.death.kicker)}</span><h2 id="share-title">${esc(share.sheetTitle)}</h2></div>
          <button class="icon-button" type="button" data-action="close-sheet" aria-label="${esc(t("close"))}">${icon("close")}</button>
        </div>
        <div class="share-card">
          <span class="eyebrow">${esc(frame.death.years)} · ${esc(frame.death.yearsLabel)}</span>
          <strong>${esc(share.title)}</strong>
          <p>${esc(share.body)}</p>
        </div>
        <button class="primary-button" type="button" data-action="copy-share">${icon("share")}<span>${esc(share.copyLabel)}</span></button>
        <p class="sheet-note">${esc(share.note)}</p>
      </section>
    </div>`;
}

function rebirthSheet(): string {
  const rebirth = frame.death.rebirth;
  return `
    <div class="sheet-layer" data-sheet="rebirth" hidden>
      <div class="sheet-backdrop" data-action="close-sheet" aria-hidden="true"></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="rebirth-title">
        <div class="sheet-grip" aria-hidden="true"></div>
        <div class="sheet-head">
          <div><span class="eyebrow">${esc(frame.death.kicker)}</span><h2 id="rebirth-title">${esc(rebirth.sheetTitle)}</h2></div>
          <button class="icon-button" type="button" data-action="close-sheet" aria-label="${esc(t("close"))}">${icon("close")}</button>
        </div>
        <p class="sheet-intro">${esc(rebirth.body)}</p>
        <div class="sheet-actions">
          <button class="secondary-button" type="button" data-action="close-sheet">${esc(rebirth.cancel)}</button>
          <button class="primary-button" type="button" data-action="confirm-rebirth">${esc(rebirth.confirm)}</button>
        </div>
      </section>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* death screen                                                       */
/* ------------------------------------------------------------------ */

function curveSvg(): string {
  const curve = frame.death.curve;
  const width = 320;
  const height = 132;
  const padX = 12;
  const padY = 14;
  const line = (values: number[]): string =>
    values
      .map((value, index) => {
        const x = padX + (index * (width - padX * 2)) / Math.max(values.length - 1, 1);
        const y = height - padY - (value / 100) * (height - padY * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  return `
    <svg class="curve-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(curve.heading)}：${esc(curve.legendHappiness)}与${esc(curve.legendMoney)}">
      <line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" class="curve-axis"/>
      <polyline points="${line(curve.money)}" class="curve-line curve-money"/>
      <polyline points="${line(curve.happiness)}" class="curve-line curve-happiness"/>
    </svg>
    <div class="curve-legend">
      <span class="legend-item"><span class="legend-dot tone-amber" aria-hidden="true"></span>${esc(curve.legendHappiness)}</span>
      <span class="legend-item"><span class="legend-dot tone-aqua" aria-hidden="true"></span>${esc(curve.legendMoney)}</span>
      <span class="legend-years">${curve.labels.map((label) => esc(label)).join(" · ")}</span>
    </div>`;
}

function deathScreen(): string {
  const death = frame.death;
  return `
    <main class="death-screen" data-screen="death" hidden aria-labelledby="death-title">
      <header class="death-top">
        <span class="eyebrow">${esc(death.kicker)}</span>
        <button class="icon-button" type="button" data-action="close-death" aria-label="${esc(death.backLabel)}">${icon("close")}</button>
      </header>
      <div class="death-body">
        <div class="death-hero">
          <span class="death-sun" aria-hidden="true">${icon("sun")}</span>
          <h1 id="death-title">${esc(death.title)}</h1>
          <p>${esc(death.subtitle)}</p>
        </div>
        <div class="death-numbers">
          <div><strong>${esc(death.years)}</strong><span>${esc(death.yearsLabel)}</span></div>
          <div><strong>${esc(death.places)}</strong><span>${esc(death.placesLabel)}</span></div>
          <div><strong>${esc(death.people)}</strong><span>${esc(death.peopleLabel)}</span></div>
        </div>
        <h2 class="subsection-title">${esc(death.summaryLabel)}</h2>
        <div class="death-summary">
          ${death.summary.map((item) => `<div><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong></div>`).join("")}
        </div>
        <h2 class="subsection-title">${esc(death.family.heading)}</h2>
        <div class="death-people">
          ${death.family.members.map((member) => `<div class="person-chip"><strong>${esc(member.name)}</strong><span>${esc(member.role)}</span></div>`).join("")}
        </div>
        <p class="panel-footnote">${esc(death.family.note)}</p>
        <h2 class="subsection-title">${esc(death.money.heading)}</h2>
        <div class="death-money"><strong>${esc(death.money.value)}</strong>
          <dl class="fact-grid fact-grid-wide">${death.money.items.map((item) => `<div><dt>${esc(item.label)}</dt><dd>${esc(item.value)}</dd></div>`).join("")}</dl>
          <p class="panel-footnote">${esc(death.money.note)}</p>
        </div>
        <h2 class="subsection-title">${esc(death.children.heading)}</h2>
        <div class="empty-state"><strong>${esc(death.children.value)}</strong><p>${esc(death.children.note)}</p></div>
        <h2 class="subsection-title">${esc(death.map.heading)}</h2>
        <div class="death-map">
          <div class="chip-row">${death.map.countries.map((country) => `<span class="chip is-static">${esc(country)}</span>`).join("")}<span class="muted">${esc(death.map.placesLabel)} ${esc(death.map.places)}</span></div>
          ${curveSvg()}
          <p class="panel-footnote">${esc(death.map.note)} ${esc(death.curve.note)}</p>
        </div>
        <h2 class="subsection-title">状态</h2>
        <div class="death-stats">${death.stats.map((stat, index) => statBar({ ...stat, key: `death-${index}` }, `death-${index}`)).join("")}</div>
        <button class="secondary-button" type="button" data-action="toggle-death-more" aria-expanded="false" aria-controls="death-more">
          ${icon("chevron-down", "toggle-icon")}<span data-death-more-label>${esc(death.expandLabel)}</span>
        </button>
        <div class="death-more" id="death-more" hidden>
          <dl class="fact-grid fact-grid-wide">${death.more.map((item) => `<div><dt>${esc(item.label)}</dt><dd>${esc(item.value)}</dd></div>`).join("")}</dl>
        </div>
        <blockquote>${esc(death.quote)}</blockquote>
        <p class="panel-footnote">${esc(death.note)}</p>
      </div>
      <div class="death-actions">
        <button class="secondary-button" type="button" data-action="open-share">${icon("share")}<span>${esc(death.share.label)}</span></button>
        <button class="primary-button" type="button" data-action="open-rebirth">${icon("refresh")}<span>${esc(death.rebirth.label)}</span></button>
      </div>
    </main>`;
}

/* ------------------------------------------------------------------ */
/* shell                                                              */
/* ------------------------------------------------------------------ */

app.innerHTML = `
  <div class="app-shell">
    <div class="orientation-guard" role="alertdialog" aria-labelledby="orientation-title" aria-describedby="orientation-hint">
      <div class="orientation-icon" aria-hidden="true">${icon("compass")}</div>
      <h2 id="orientation-title">${esc(t("orientation"))}</h2>
      <p id="orientation-hint">${esc(t("orientationHint"))}</p>
    </div>
    <div class="app-main" data-app-main>
      <header class="topbar">
        <h1 class="sr-only">人生 · 静态互动壳</h1>
        <div class="top-metrics">
          <div class="metric" data-metric="year">
            <span class="metric-icon" aria-hidden="true">${icon("calendar")}</span>
            <span class="metric-copy"><span class="metric-label">${esc(t("year"))}</span><span class="metric-value"><strong data-year>${frame.header.year}</strong><small>${frame.header.age}岁</small></span></span>
          </div>
          <div class="metric" data-metric="assets">
            <span class="metric-icon" aria-hidden="true">${icon("coin")}</span>
            <span class="metric-copy"><span class="metric-label">${esc(t("assets"))}</span><strong class="metric-value" data-assets>${esc(frame.header.assetsText)}</strong></span>
          </div>
          <div class="metric" data-metric="income">
            <span class="metric-icon" aria-hidden="true">${icon("leaf")}</span>
            <span class="metric-copy"><span class="metric-label">${esc(t("income"))}</span><strong class="metric-value" data-income>${esc(frame.header.incomeText)}</strong></span>
          </div>
        </div>
        <div class="top-actions">
          <button class="icon-button" type="button" data-action="pause" aria-pressed="false" aria-label="${esc(t("pause"))}">${icon("pause")}<span class="sr-only" data-pause-label>${esc(t("pause"))}</span></button>
          <button class="icon-button" type="button" data-action="settings" aria-label="${esc(t("settings"))}" aria-haspopup="dialog">${icon("gear")}</button>
        </div>
      </header>
      <main class="stage">
        ${panelLife()}
        ${panelFamily()}
        ${panelWork()}
        ${panelMap()}
      </main>
      <footer class="bottom-stack">
        <section class="status-strip" aria-label="人物状态">${statBars(frame.stats)}</section>
        <button class="next-button" type="button" data-action="next"><span class="next-label">${esc(frame.nextStates.cards)}</span>${icon("chevron")}</button>
        <nav class="tabs" role="tablist" aria-label="主要页面">
          <button class="tab" id="tab-life" type="button" role="tab" data-tab="life" aria-selected="true" aria-controls="panel-life">${icon("home")}<span>${esc(t("life"))}</span></button>
          <button class="tab" id="tab-family" type="button" role="tab" data-tab="family" aria-selected="false" aria-controls="panel-family" tabindex="-1">${icon("family")}<span>${esc(t("family"))}</span></button>
          <button class="tab" id="tab-work" type="button" role="tab" data-tab="work" aria-selected="false" aria-controls="panel-work" tabindex="-1">${icon("briefcase")}<span>${esc(t("work"))}</span></button>
          <button class="tab" id="tab-map" type="button" role="tab" data-tab="map" aria-selected="false" aria-controls="panel-map" tabindex="-1">${icon("map")}<span>${esc(t("map"))}</span></button>
        </nav>
      </footer>
    </div>
    ${deathScreen()}
    ${choiceSheet()}
    ${settingsSheet()}
    ${infoSheet()}
    ${migrateSheet()}
    ${shareSheet()}
    ${rebirthSheet()}
    <div class="toast" data-toast role="status" aria-live="polite"></div>
  </div>`;

applyDisplay();
wireEvents();
initNavigation();

/* ------------------------------------------------------------------ */
/* navigation                                                         */
/* ------------------------------------------------------------------ */

function urlFor(next: NavState): string {
  const screen = next.route === "life" ? "" : `?screen=${next.route}`;
  return `${window.location.pathname}${screen}`;
}

function currentNav(): NavState {
  return { route: state.route, sheet: state.sheet, member: state.member };
}

function pushNav(patch: Partial<NavState>): void {
  const next: NavState = { ...currentNav(), ...patch };
  history.pushState(next, "", urlFor(next));
  applyNav(next);
}

function navigateTo(route: Screen): void {
  if (state.route === route && state.sheet === null && state.member === null) return;
  pushNav({ route, sheet: null, member: null });
}

function applyNav(next: NavState): void {
  state.route = next.route;
  state.sheet = next.sheet;
  state.member = next.member;
  syncUI();
}

function syncUI(): void {
  const isDeath = state.route === "death";
  document.body.classList.toggle("is-death", isDeath);
  document.body.classList.toggle("has-sheet", state.sheet !== null);
  must<HTMLElement>("[data-app-main]").hidden = isDeath;
  must<HTMLElement>("[data-screen='death']").hidden = !isDeath;
  if (!isDeath) setTab(state.route === "choice" || state.route === "settings" ? "life" : (state.route as Tab));
  if (!isDeath && state.tab === "family" && renderedMember !== state.member) renderPanel("family");
  document.querySelectorAll<HTMLElement>("[data-sheet]").forEach((sheet) => {
    sheet.hidden = sheet.dataset.sheet !== state.sheet;
  });
  const main = must<HTMLElement>("[data-app-main]");
  if (state.sheet) main.setAttribute("inert", "");
  else main.removeAttribute("inert");
  updateNext();
  if (state.route === "death") renderDeathState();
}

function setTab(tab: Tab): void {
  if (state.tab !== tab) {
    scrollByTab[state.tab] = window.scrollY;
    state.tab = tab;
  }
  document.querySelectorAll<HTMLElement>("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    const selected = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  const target = scrollByTab[tab];
  window.requestAnimationFrame(() => window.scrollTo(0, target));
}

function updateNext(): void {
  const button = document.querySelector<HTMLButtonElement>("[data-action='next']");
  if (!button) return;
  const label = button.querySelector<HTMLElement>(".next-label");
  let text = frame.nextStates.cards;
  let disabled = false;
  if (state.route === "choice" || state.sheet === "choice") {
    text = state.choiceId ? frame.nextStates.choiceReady : frame.nextStates.choiceBlocked;
    disabled = !state.choiceId;
  } else if (state.route === "death") {
    text = frame.nextStates.summary;
  } else if (state.cardIndex >= frame.yearCards.length - 1) {
    text = state.paused ? frame.nextStates.resume : frame.nextStates.paused;
  }
  if (label) label.textContent = text;
  button.disabled = disabled;
  button.dataset.state = disabled ? "blocked" : "ready";
}

function openSheet(name: SheetName, trigger?: HTMLElement | null): void {
  const sheet = document.querySelector<HTMLElement>(`[data-sheet="${name}"]`);
  if (!sheet) return;
  sheetTriggers.push(trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  if (name === "choice") resetChoice();
  pushNav({ sheet: name });
  focusSheet(sheet);
}

function closeSheet(): void {
  const historyState = history.state as NavState | null;
  if (historyState?.sheet) {
    history.back();
    return;
  }
  pushNav({ sheet: null });
  focusLastTrigger();
}

function focusLastTrigger(): void {
  const trigger = sheetTriggers.pop() ?? null;
  if (trigger && document.contains(trigger) && trigger.offsetParent !== null) trigger.focus();
}

function openMember(id: string, trigger: HTMLElement | null): void {
  memberReturnId = id;
  pushNav({ route: "family", member: id });
  document.querySelector<HTMLElement>("[data-action='close-member']")?.focus();
  void trigger;
}

function closeMember(): void {
  const historyState = history.state as NavState | null;
  if (historyState?.member) {
    history.back();
    return;
  }
  pushNav({ member: null });
  focusMemberButton();
}

function focusMemberButton(): void {
  const id = memberReturnId;
  memberReturnId = null;
  if (!id) return;
  document.querySelector<HTMLElement>(`[data-member="${id}"]`)?.focus();
}

function renderPanel(tab: Tab): void {
  const panel = document.querySelector<HTMLElement>(`[data-panel="${tab}"]`);
  if (!panel) return;
  const html = tab === "life" ? panelLife() : tab === "family" ? panelFamily() : tab === "work" ? panelWork() : panelMap();
  panel.outerHTML = html;
  const fresh = document.querySelector<HTMLElement>(`[data-panel="${tab}"]`);
  if (fresh) fresh.hidden = state.tab !== tab;
  if (tab === "family") renderedMember = state.member;
}

function renderDeathState(): void {
  const button = document.querySelector<HTMLElement>("[data-action='toggle-death-more']");
  if (!button) return;
  button.setAttribute("aria-expanded", String(state.deathExpanded));
  const label = button.querySelector<HTMLElement>("[data-death-more-label]");
  if (label) label.textContent = state.deathExpanded ? frame.death.collapseLabel : frame.death.expandLabel;
  const iconNode = button.querySelector<SVGElement>("svg");
  if (iconNode) iconNode.outerHTML = icon(state.deathExpanded ? "chevron-up" : "chevron-down", "toggle-icon");
  const more = document.querySelector<HTMLElement>("#death-more");
  if (more) more.hidden = !state.deathExpanded;
}

/* ------------------------------------------------------------------ */
/* choice                                                             */
/* ------------------------------------------------------------------ */

function selectedChoice(): Frame["choices"][number] | undefined {
  return frame.choices.find((choice) => choice.id === state.choiceId);
}

function resetChoice(): void {
  state.choiceId = null;
  state.choiceConfirmed = false;
  document.querySelectorAll<HTMLButtonElement>("[data-choice]").forEach((button) => {
    button.classList.remove("is-selected", "is-confirmed");
    button.setAttribute("aria-pressed", "false");
  });
  const confirm = document.querySelector<HTMLButtonElement>("[data-action='confirm-choice']");
  if (confirm) {
    confirm.disabled = true;
    confirm.textContent = frame.choice.confirm;
    confirm.classList.remove("is-confirmed");
  }
  const hint = document.querySelector<HTMLElement>("[data-choice-hint]");
  if (hint) hint.textContent = frame.choice.disabledHint;
  const consequence = document.querySelector<HTMLElement>("[data-consequence]");
  if (consequence) consequence.hidden = true;
  updateNext();
}

function selectChoice(id: string): void {
  const choice = frame.choices.find((item) => item.id === id);
  if (!choice) return;
  state.choiceId = id;
  state.choiceConfirmed = false;
  document.querySelectorAll<HTMLButtonElement>("[data-choice]").forEach((button) => {
    const active = button.dataset.choice === id;
    button.classList.toggle("is-selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const confirm = document.querySelector<HTMLButtonElement>("[data-action='confirm-choice']");
  if (confirm) {
    confirm.disabled = false;
    confirm.textContent = frame.choice.confirm;
    confirm.classList.remove("is-confirmed");
  }
  const hint = document.querySelector<HTMLElement>("[data-choice-hint]");
  if (hint) hint.textContent = frame.choice.selectedHint.replace("{choice}", choice.title);
  const consequence = document.querySelector<HTMLElement>("[data-consequence]");
  if (consequence) consequence.hidden = true;
  updateNext();
}

function confirmChoice(): void {
  const choice = selectedChoice();
  if (!choice || state.choiceConfirmed) return;
  state.choiceConfirmed = true;
  document.querySelectorAll<HTMLButtonElement>("[data-choice]").forEach((button) => {
    button.classList.toggle("is-confirmed", button.dataset.choice === choice.id);
  });
  document.querySelectorAll<HTMLElement>("[data-consequence-title]").forEach((node) => {
    node.textContent = choice.consequenceTitle;
  });
  document.querySelectorAll<HTMLElement>("[data-consequence-body]").forEach((node) => {
    node.textContent = choice.consequenceBody;
  });
  const consequence = document.querySelector<HTMLElement>("[data-consequence]");
  if (consequence) consequence.hidden = false;
  const confirm = document.querySelector<HTMLButtonElement>("[data-action='confirm-choice']");
  if (confirm) {
    confirm.disabled = true;
    confirm.textContent = "已确认";
    confirm.classList.add("is-confirmed");
  }
  const hint = document.querySelector<HTMLElement>("[data-choice-hint]");
  if (hint) hint.textContent = `已确认：${choice.title} · 年份仍为 ${frame.header.year}`;
  updateNext();
}

/* ------------------------------------------------------------------ */
/* info / migrate / share                                             */
/* ------------------------------------------------------------------ */

function showInfo(title: string, intro: string, rows: { label: string; value: string }[], note: string, trigger: HTMLElement | null): void {
  const titleNode = document.querySelector<HTMLElement>("[data-info-title]");
  const introNode = document.querySelector<HTMLElement>("[data-info-intro]");
  const listNode = document.querySelector<HTMLElement>("[data-info-list]");
  const noteNode = document.querySelector<HTMLElement>("[data-info-note]");
  if (titleNode) titleNode.textContent = title;
  if (introNode) introNode.textContent = intro;
  if (listNode) {
    listNode.innerHTML = rows.map((row) => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join("");
  }
  if (noteNode) noteNode.textContent = note;
  openSheet("info", trigger);
}

function openJobDetail(id: string, trigger: HTMLElement | null): void {
  const opening = frame.work.jobs.openings.find((item) => item.id === id);
  if (!opening) return;
  showInfo(
    opening.title,
    `${opening.employer} · ${opening.pay} · ${opening.tag}`,
    opening.requirements.map((req, index) => ({ label: `条件 ${index + 1}`, value: req })),
    opening.note,
    trigger
  );
}

function openRetireDetail(trigger: HTMLElement | null): void {
  const retire = frame.work.retire;
  showInfo(
    retire.action,
    retire.status,
    retire.projection.map((row) => ({ label: row.label, value: row.value })),
    retire.sheetNote,
    trigger
  );
}

function openAbout(trigger: HTMLElement | null): void {
  const about = frame.settings.about;
  showInfo(about.label, about.description, about.items.map((row) => ({ label: row.label, value: row.value })), about.note, trigger);
}

function resetMigrate(): void {
  state.migrateId = null;
  document.querySelectorAll<HTMLButtonElement>("[data-migrate]").forEach((button) => {
    button.classList.remove("is-selected");
    button.setAttribute("aria-pressed", "false");
  });
  const hint = document.querySelector<HTMLElement>("[data-migrate-hint]");
  if (hint) hint.textContent = frame.map.migrate.disabledHint;
  const confirm = document.querySelector<HTMLButtonElement>("[data-action='confirm-migrate']");
  if (confirm) {
    confirm.disabled = true;
    confirm.textContent = frame.map.migrate.confirm;
  }
  const consequence = document.querySelector<HTMLElement>("[data-migrate-consequence]");
  if (consequence) consequence.hidden = true;
}

function selectMigrate(id: string): void {
  const item = frame.map.migrate.items.find((entry) => entry.id === id);
  if (!item) return;
  state.migrateId = id;
  document.querySelectorAll<HTMLButtonElement>("[data-migrate]").forEach((button) => {
    const active = button.dataset.migrate === id;
    button.classList.toggle("is-selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const hint = document.querySelector<HTMLElement>("[data-migrate-hint]");
  if (hint) hint.textContent = frame.map.migrate.selectedHint.replace("{choice}", item.name);
  const confirm = document.querySelector<HTMLButtonElement>("[data-action='confirm-migrate']");
  if (confirm) confirm.disabled = false;
}

function confirmMigrate(): void {
  if (!state.migrateId) return;
  const consequence = document.querySelector<HTMLElement>("[data-migrate-consequence]");
  if (consequence) consequence.hidden = false;
  const confirm = document.querySelector<HTMLButtonElement>("[data-action='confirm-migrate']");
  if (confirm) {
    confirm.disabled = true;
    confirm.textContent = "已记录";
  }
  toast("移居申请已记录（静态演示）");
}

/* ------------------------------------------------------------------ */
/* next / pause                                                       */
/* ------------------------------------------------------------------ */

function nextCard(): void {
  if (state.route === "death") return;
  if (state.route === "choice") {
    if (state.choiceId && !state.choiceConfirmed) confirmChoice();
    return;
  }
  if (state.route !== "life") {
    pushNav({ route: "life", member: null });
    return;
  }
  if (state.cardIndex < frame.yearCards.length - 1) {
    state.cardIndex += 1;
    const card = document.querySelector<HTMLElement>("[data-year-card]");
    if (card) {
      card.innerHTML = yearCardHtml();
      card.classList.remove("card-flash");
      void card.offsetWidth;
      card.classList.add("card-flash");
    }
    toast(frame.nextStates.hintCards);
    updateNext();
    return;
  }
  togglePause();
}

function togglePause(): void {
  state.paused = !state.paused;
  applyDisplay();
  updateNext();
  toast(state.paused ? frame.nextStates.hintPaused : frame.nextStates.hintResume);
}

/* ------------------------------------------------------------------ */
/* settings                                                           */
/* ------------------------------------------------------------------ */

function toggleSetting(id: string): void {
  if (id === "reduceMotion" || id === "sound" || id === "haptics") {
    display[id] = !display[id];
  } else {
    return;
  }
  persistDisplay();
  applyDisplay();
  toast(`显示偏好已更新 · ${id}`);
}

function setOption(id: string, value: string): void {
  if (id === "theme" && (value === "light" || value === "dark")) display.theme = value;
  else if (id === "language" && (value === "zh-CN" || value === "en-US")) display.language = value;
  else if (id === "speed" && (value === "1x" || value === "2x" || value === "4x")) display.speed = value;
  else if (id === "auto" && (value === "ask" || value === "semi" || value === "full")) display.auto = value;
  else if (id === "contentMode" && (value === "standard" || value === "gentle" || value === "realistic")) display.contentMode = value;
  else return;
  persistDisplay();
  applyDisplay();
  toast(`已选择：${value}`);
}

/* ------------------------------------------------------------------ */
/* events                                                             */
/* ------------------------------------------------------------------ */

function wireEvents(): void {
  document.addEventListener("click", (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (!action) return;
    const sheetOpen = state.sheet !== null;
    if (sheetOpen && !target.closest(`[data-sheet="${state.sheet}"]`) && action !== "close-sheet") return;
    switch (action) {
      case "next":
        nextCard();
        break;
      case "pause":
        togglePause();
        break;
      case "settings":
        openSheet("settings", target);
        break;
      case "open-choice":
        openSheet("choice", target);
        break;
      case "close-sheet":
        closeSheet();
        break;
      case "select-choice":
        selectChoice(target.dataset.choice ?? "");
        break;
      case "confirm-choice":
        confirmChoice();
        break;
      case "open-member":
        openMember(target.dataset.member ?? "", target);
        break;
      case "close-member":
        closeMember();
        break;
      case "work-tab":
        state.workTab = target.dataset.workTab ?? "education";
        renderPanel("work");
        document.querySelector<HTMLElement>(`[data-work-tab="${state.workTab}"]`)?.focus();
        break;
      case "job-detail":
        openJobDetail(target.dataset.job ?? "", target);
        break;
      case "retire-detail":
        openRetireDetail(target);
        break;
      case "map-country":
        state.mapCountry = target.dataset.country ?? "cn";
        renderPanel("map");
        document.querySelector<HTMLElement>(`[data-country="${state.mapCountry}"]`)?.focus();
        break;
      case "open-migrate":
        resetMigrate();
        openSheet("migrate", target);
        break;
      case "select-migrate":
        selectMigrate(target.dataset.migrate ?? "");
        break;
      case "confirm-migrate":
        confirmMigrate();
        break;
      case "open-info":
        openAbout(target);
        break;
      case "toggle-setting":
        toggleSetting(target.dataset.setting ?? "");
        break;
      case "set-option":
        setOption(target.dataset.setting ?? "", target.dataset.value ?? "");
        break;
      case "open-death":
        pushNav({ route: "death", sheet: null, member: null });
        break;
      case "close-death":
        pushNav({ route: "life", sheet: null, member: null });
        break;
      case "toggle-death-more":
        state.deathExpanded = !state.deathExpanded;
        renderDeathState();
        document.querySelector<HTMLElement>("[data-action='toggle-death-more']")?.focus();
        break;
      case "open-share":
        openSheet("share", target);
        break;
      case "copy-share":
        toast(frame.death.share.copiedToast);
        break;
      case "open-rebirth":
        openSheet("rebirth", target);
        break;
      case "confirm-rebirth":
        sheetTriggers = [];
        pushNav({ route: "life", sheet: null, member: null });
        toast(frame.death.rebirth.toast);
        break;
      default:
        break;
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => navigateTo(button.dataset.tab as Tab));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]"));
      const index = tabs.indexOf(button);
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
      event.preventDefault();
      tabs[next]?.focus();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.sheet) {
        event.preventDefault();
        closeSheet();
        return;
      }
      if (state.member) {
        event.preventDefault();
        closeMember();
        return;
      }
      return;
    }
    if (event.key !== "Tab" || !state.sheet) return;
    const sheet = document.querySelector<HTMLElement>(`[data-sheet="${state.sheet}"]`);
    if (!sheet) return;
    const items = focusables(sheet);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !sheet.contains(active)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.addEventListener("focusin", (event) => {
    if (!state.sheet) return;
    const sheet = document.querySelector<HTMLElement>(`[data-sheet="${state.sheet}"]`);
    if (!sheet) return;
    if (event.target instanceof Node && !sheet.contains(event.target)) {
      focusables(sheet)[0]?.focus();
    }
  });

  window.addEventListener("popstate", (event) => {
    const before = state.sheet;
    const next = (event.state as NavState | null) ?? { route: "life", sheet: null, member: null };
    applyNav(next);
    if (before !== next.sheet) focusLastTrigger();
    if (!next.member) focusMemberButton();
  });
}

/* ------------------------------------------------------------------ */
/* init                                                               */
/* ------------------------------------------------------------------ */

function initNavigation(): void {
  const requested = new URLSearchParams(window.location.search).get("screen") as Screen | null;
  const allowed: Screen[] = ["life", "family", "work", "map", "choice", "settings", "death"];
  const route = requested && allowed.includes(requested) ? requested : "life";
  const base: NavState = { route: "life", sheet: null, member: null };
  history.replaceState(base, "", urlFor(base));
  const initial: NavState = {
    route,
    sheet: route === "choice" || route === "settings" ? (route as SheetName) : null,
    member: null
  };
  if (route === "life") {
    applyNav(base);
  } else {
    history.pushState(initial, "", urlFor(initial));
    applyNav(initial);
  }
  if (initial.sheet === "choice") resetChoice();
  if (initial.sheet) {
    const sheet = document.querySelector<HTMLElement>(`[data-sheet="${initial.sheet}"]`);
    if (sheet) focusSheet(sheet);
  }
  applyDisplay();
}
