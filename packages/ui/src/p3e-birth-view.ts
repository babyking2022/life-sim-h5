/**
 * GPT-WORKBUDDY-0065-A｜出生卡 **共用 view**（搬移自 `p3e-real-main.ts`）。
 *
 * birth entry 與 game chunk 都呼叫同一個 `renderBirthCard`，因此 0062-B 的
 * 刷新鈕／44×44／aria 契約、0058-B 的世界狀態列、資料診斷 dataset
 * 只有一份實作，不會隨拆分漂移。這裡只有顯示層對照表與 DOM 建構，
 * 沒有任何 validators、session、場景或 pack 載入。
 */
import type { P3EBrowserBirthPreview } from "@life-sim/application";
import { element, writeBirthAudioDataset } from "./p3e-common.js";
import { COPY_SCHEMA_VERSION } from "./p3e-copy.js";

export interface BirthCardModel {
  readonly birth: P3EBrowserBirthPreview;
  readonly seed: string;
  readonly refreshCount: number;
  readonly worldStage: "loading" | "ready" | "preparing" | "error";
  readonly worldError: string | null;
  readonly startPending: boolean;
  readonly eventCopyKeys: number;
  readonly persistenceStatus: string;
  readonly persistenceError: string | null;
}

export interface BirthCardHandlers {
  readonly onRefresh: (button: HTMLButtonElement) => void;
  readonly onReroll: () => void;
  readonly onStart: () => void;
  readonly onRetry: () => void;
  readonly afterRender?: (screen: HTMLElement) => void;
}

/* ------------------------------------------------------------------ */
/* 顯示層繁中對照（只影響畫面；不改資料包、不改 fixtures）                 */
/* ------------------------------------------------------------------ */

/** 資料包已知標籤 → 繁中（字典比對；未收錄者原樣顯示）。 */
const HANT_LABELS: Readonly<Record<string, string>> = {
  农民: "農民",
  工厂工人: "工廠工人",
  服务业员工: "服務業員工",
  教师: "教師",
  店主: "店主",
  无宗教: "無宗教",
  佛教: "佛教",
  基督教: "基督教",
  民间信仰: "民間信仰",
  印度教: "印度教",
  伊斯兰教: "伊斯蘭教",
  自有住房: "自有住房",
  租住: "租住",
  与亲属合住: "與親屬合住",
  非正规住所: "非正規住所",
  城市: "城市",
  农村: "鄉村",
  最低五分之一: "最低五分之一",
  次低五分之一: "次低五分之一",
  中间五分之一: "中間五分之一",
  次高五分之一: "次高五分之一",
  最高五分之一: "最高五分之一"
};

/** 出生故事的固定片語 → 繁中（長字串優先；未收錄的樣板原樣顯示）。 */
const HANT_STORY_PHRASES: readonly (readonly [string, string])[] = [
  ["的习惯迎接这个孩子，也记住了这一天的天气。", "的習慣迎接這個孩子，也記住了這一天的天氣。"],
  ["的传统，也保留着对未来的小心愿。", "的傳統，也保留著對未來的小心願。"],
  ["的日子里慢慢安顿下来。", "的日子裡慢慢安頓下來。"],
  ["没有人知道以后会发生什么，但", "沒有人知道以後會發生什麼，但"],
  ["的这一年，从这里开始。", "的這一年，從這裡開始。"],
  ["家庭多了一个孩子：", "家庭多了一個孩子："],
  ["出生。家里属于", "出生。家裡屬於"],
  ["，父亲是", "，父親是"],
  ["，母亲是", "，母親是"],
  ["这一年，", "這一年，"],
  ["的一个", "的一個"],
  ["家里保留着", "家裡保留著"],
  ["母亲", "母親"],
  ["、父亲", "、父親"]
];

/** 資料包的大洲代碼 → 繁中（故事內的 `（europe）` 之類）。 */
const CONTINENT_LABELS: Readonly<Record<string, string>> = {
  africa: "非洲",
  americas: "美洲",
  asia: "亞洲",
  europe: "歐洲",
  oceania: "大洋洲"
};

/**
 * regionCode（P2-A 的 ISO3）→ ISO2，只為了在出生卡算國旗 emoji。
 * 這是呈現層對照表：不是資料包、不影響抽選與任何規則；未收錄者顯示地球符號。
 * 三個敏感地區沿用資料包審核過的正式名稱，旗幟呈現也保守處理：
 * HKG／MAC 用特別行政區旗，TWN 不給 ISO2（顯示中性地球符號）。
 */
const ISO2_BY_REGION: Readonly<Record<string, string>> = {
  AFG: "AF",
  AGO: "AO",
  ALB: "AL",
  ARE: "AE",
  ARG: "AR",
  ARM: "AM",
  AUS: "AU",
  AUT: "AT",
  AZE: "AZ",
  BDI: "BI",
  BEL: "BE",
  BEN: "BJ",
  BFA: "BF",
  BGD: "BD",
  BGR: "BG",
  BHR: "BH",
  BIH: "BA",
  BLR: "BY",
  BOL: "BO",
  BRA: "BR",
  BRN: "BN",
  BWA: "BW",
  CAF: "CF",
  CAN: "CA",
  CHE: "CH",
  CHL: "CL",
  CHN: "CN",
  CIV: "CI",
  CMR: "CM",
  COD: "CD",
  COG: "CG",
  COL: "CO",
  CPV: "CV",
  CRI: "CR",
  CUB: "CU",
  CYP: "CY",
  CZE: "CZ",
  DEU: "DE",
  DJI: "DJ",
  DNK: "DK",
  DOM: "DO",
  DZA: "DZ",
  ECU: "EC",
  EGY: "EG",
  ERI: "ER",
  ESP: "ES",
  EST: "EE",
  ETH: "ET",
  FIN: "FI",
  FJI: "FJ",
  FRA: "FR",
  GAB: "GA",
  GBR: "GB",
  GEO: "GE",
  GHA: "GH",
  GIN: "GN",
  GMB: "GM",
  GNB: "GW",
  GNQ: "GQ",
  GRC: "GR",
  GTM: "GT",
  GUY: "GY",
  HKG: "HK",
  HND: "HN",
  HRV: "HR",
  HTI: "HT",
  HUN: "HU",
  IDN: "ID",
  IND: "IN",
  IRL: "IE",
  IRN: "IR",
  IRQ: "IQ",
  ISL: "IS",
  ISR: "IL",
  ITA: "IT",
  JAM: "JM",
  JOR: "JO",
  JPN: "JP",
  KAZ: "KZ",
  KEN: "KE",
  KGZ: "KG",
  KHM: "KH",
  KOR: "KR",
  KWT: "KW",
  LAO: "LA",
  LBN: "LB",
  LBR: "LR",
  LBY: "LY",
  LKA: "LK",
  LSO: "LS",
  LTU: "LT",
  LUX: "LU",
  LVA: "LV",
  MAC: "MO",
  MAR: "MA",
  MDA: "MD",
  MDG: "MG",
  MEX: "MX",
  MKD: "MK",
  MLI: "ML",
  MLT: "MT",
  MMR: "MM",
  MNE: "ME",
  MNG: "MN",
  MOZ: "MZ",
  MRT: "MR",
  MUS: "MU",
  MWI: "MW",
  MYS: "MY",
  NAM: "NA",
  NER: "NE",
  NGA: "NG",
  NIC: "NI",
  NLD: "NL",
  NOR: "NO",
  NPL: "NP",
  NZL: "NZ",
  OMN: "OM",
  PAK: "PK",
  PAN: "PA",
  PER: "PE",
  PHL: "PH",
  PNG: "PG",
  POL: "PL",
  PRK: "KP",
  PRT: "PT",
  PRY: "PY",
  PSE: "PS",
  QAT: "QA",
  ROU: "RO",
  RUS: "RU",
  RWA: "RW",
  SAU: "SA",
  SDN: "SD",
  SEN: "SN",
  SGP: "SG",
  SLB: "SB",
  SLE: "SL",
  SLV: "SV",
  SOM: "SO",
  SRB: "RS",
  SSD: "SS",
  SUR: "SR",
  SVK: "SK",
  SVN: "SI",
  SWE: "SE",
  SWZ: "SZ",
  SYR: "SY",
  TCD: "TD",
  TGO: "TG",
  THA: "TH",
  TJK: "TJ",
  TKM: "TM",
  TLS: "TL",
  TON: "TO",
  TUN: "TN",
  TUR: "TR",
  TZA: "TZ",
  UGA: "UG",
  UKR: "UA",
  URY: "UY",
  USA: "US",
  UZB: "UZ",
  VEN: "VE",
  VNM: "VN",
  VUT: "VU",
  WSM: "WS",
  YEM: "YE",
  ZAF: "ZA",
  ZMB: "ZM",
  ZWE: "ZW"
};

/** 資料包標籤 → 繁中；未收錄者原樣顯示（不改資料）。 */
export function toHantLabel(value: string): string {
  return HANT_LABELS[value] ?? value;
}

/** 國旗 emoji（未收錄地區或非 ISO2 一律回地球符號）。 */
export function flagOf(regionCode: string): string {
  const iso2 = ISO2_BY_REGION[regionCode];
  if (iso2 === undefined || iso2.length !== 2) return "🌐";
  return String.fromCodePoint(
    0x1f1e6 + (iso2.charCodeAt(0) - 65),
    0x1f1e6 + (iso2.charCodeAt(1) - 65)
  );
}

/** 城鄉／性別的人話。 */
function settlementText(birth: P3EBrowserBirthPreview): string {
  return toHantLabel(birth.settlementLabel);
}

function sexText(birth: P3EBrowserBirthPreview): string {
  return birth.sex === "female" ? "女" : "男";
}

/**
 * 出生故事的**顯示層**繁中化。
 *
 * 資料包給的是已代入的簡中段落（含姓名、地名、職業、宗教、國家名）。這裡：
 * 1. 先把姓名整段保護起來（姓名是資料，不在 UI 轉換）；
 * 2. 只替換固定片語（已知樣板）與已知標籤／國名／大洲代碼；
 * 3. 未收錄的樣板或標籤原樣顯示，永不猜測。
 */
function localizeStory(paragraphs: readonly string[], birth: P3EBrowserBirthPreview): string[] {
  const name = birth.name.fullName;
  const guard = "\u0000name\u0000";
  const continent = CONTINENT_LABELS[birth.country.region] ?? birth.country.region;
  const settlement = birth.settlementLabel;
  const place = settlement.length > 0 ? `${settlement}（${birth.country.region}）` : "";
  const localizedPlace = settlement.length > 0 ? `${toHantLabel(settlement)}（${continent}）` : "";
  const labelPairs: readonly (readonly [string, string])[] = [
    [birth.incomeLabel, toHantLabel(birth.incomeLabel)],
    [birth.religion.label, toHantLabel(birth.religion.label)],
    [birth.parents.motherOccupationLabel, toHantLabel(birth.parents.motherOccupationLabel)],
    [birth.parents.fatherOccupationLabel, toHantLabel(birth.parents.fatherOccupationLabel)],
    [settlement, toHantLabel(settlement)],
    [birth.country.nameZhHans, birth.country.nameZhHant]
  ];

  return paragraphs.map((paragraph) => {
    let text = paragraph;
    if (name.length > 0) text = text.split(name).join(guard);
    for (const [from, to] of HANT_STORY_PHRASES) {
      if (from !== to) text = text.split(from).join(to);
    }
    if (place.length > 0) text = text.split(place).join(localizedPlace);
    for (const [from, to] of labelPairs) {
      if (from.length > 0 && from !== to) text = text.split(from).join(to);
    }
    return text.split(guard).join(name);
  });
}


/** `aria-live` 宣告：放在 #app 外，卡片重繪不會把 live region 一起拆掉。 */
export function announceBirthRefresh(count: number): void {
  let node = document.getElementById("p3e-birth-announcer");
  if (node === null) {
    node = document.createElement("div");
    node.id = "p3e-birth-announcer";
    node.className = "sr-only";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.append(node);
  }
  node.textContent = `已刷新出生，第 ${count} 次`;
}

export function renderBirthCard(app: HTMLElement, model: BirthCardModel, handlers: BirthCardHandlers): void {
  const birth = model.birth;
  const seed = model.seed;

  const screen = element("main", "p3e-birth-screen");
  screen.dataset["p3eLive"] = "true";
  screen.dataset["p3ePhase"] = "birth";
  screen.dataset["p3eCopyKeys"] = String(model.eventCopyKeys);
  screen.dataset["p3eCopySchema"] = COPY_SCHEMA_VERSION;
  screen.dataset["p3eBirthSeed"] = seed;
  screen.dataset["p3eBirthCertificateHash"] = birth.certificateHash;
  screen.dataset["p3eBirthIdentityHash"] = birth.playerIdentityHash;
  screen.dataset["p3eCommandCount"] = "0";
  screen.dataset["p3eRefreshCount"] = String(model.refreshCount);
  screen.dataset["p3ePersistenceStatus"] = model.persistenceStatus;
  screen.dataset["p3ePersistenceError"] = model.persistenceError ?? "";
  // GPT-0058-B：讓 smoke／網路攔截測試能直接觀察兩階段載入狀態。
  const worldStage = model.worldStage;
  screen.dataset["p3eWorldStage"] = worldStage;
  screen.dataset["p3eWorldError"] = model.worldError ?? "";

  const card = element("article", "p3e-birth-card");
  card.setAttribute("aria-labelledby", "p3e-birth-country");

  // GPT-WORKBUDDY-0062-B：標題列右上角放主要刷新動作；標題文字仍在同一列左側，
  // 固定語系切換鈕（top:8px）不與 44×44 重新整理鈕重疊（hero 上方留白）。
  const hero = element("header", "p3e-birth-hero");
  const titleRow = element("div", "p3e-birth-title-row");
  const titleText = element("div", "p3e-birth-title-text");
  const country = element("h1", "p3e-birth-country");
  country.id = "p3e-birth-country";
  const flag = element("span", "p3e-birth-flag", flagOf(birth.country.regionCode));
  flag.setAttribute("aria-hidden", "true");
  country.append(flag, element("span", undefined, birth.country.nameZhHant));
  titleText.append(element("p", "p3e-birth-caption", "出生地"), country);

  const refresh = element("button", "p3e-birth-refresh");
  refresh.type = "button";
  refresh.dataset["action"] = "refresh-birth";
  refresh.dataset["p3eRefreshState"] = "idle";
  refresh.setAttribute("aria-label", "刷新出生資料");
  const refreshIcon = element("span", "p3e-birth-refresh-icon", "↻");
  refreshIcon.setAttribute("aria-hidden", "true");
  refresh.append(refreshIcon, element("span", "p3e-birth-refresh-label", "刷新出生"));
  refresh.addEventListener("click", () => handlers.onRefresh(refresh));
  titleRow.append(titleText, refresh);

  const headline = element(
    "p",
    "p3e-birth-headline",
    `${birth.name.fullName} · ${sexText(birth)} · ${birth.birthYear} 年`
  );
  hero.append(titleRow, headline);

  const grid = element("dl", "p3e-birth-grid");
  grid.setAttribute("aria-label", "出生資料");
  // 卡片內局部捲動（CSS overflow-y:auto）：鍵盤也要能捲動，否則 axe 會報
  // scrollable-region-focusable（serious）。
  grid.tabIndex = 0;
  const rows: readonly (readonly [string, string])[] = [
    ["姓名", birth.name.fullName],
    ["性別", sexText(birth)],
    ["城鄉", settlementText(birth)],
    ["收入", toHantLabel(birth.incomeLabel)],
    ["住房", toHantLabel(birth.housing.label)],
    ["宗教", toHantLabel(birth.religion.label)],
    ["母親", `${birth.parents.motherAge} 歲 · ${toHantLabel(birth.parents.motherOccupationLabel)}`],
    ["父親", `${birth.parents.fatherAge} 歲 · ${toHantLabel(birth.parents.fatherOccupationLabel)}`],
    ["預期壽命", `${birth.lifeExpectancyYears} 年`]
  ];
  for (const [label, value] of rows) {
    grid.append(element("dt", undefined, label), element("dd", undefined, value));
  }

  const story = element("div", "p3e-birth-story");
  story.setAttribute("aria-label", "出生故事");
  story.tabIndex = 0;
  for (const paragraph of localizeStory(birth.story.paragraphs, birth)) {
    story.append(element("p", undefined, paragraph));
  }

  const actions = element("div", "p3e-birth-actions");
  // 0062-B：底部「重新抽取」降為次要文字鈕，避免與標題列刷新、開始人生
  // 形成兩個同權重主要按鈕；`data-action` 保留給既有 smoke 與鍵盤流程。
  const reroll = element("button", "p3e-birth-reroll-secondary", "重新抽取");
  reroll.type = "button";
  reroll.dataset["action"] = "reroll-birth";
  reroll.setAttribute("aria-label", "重新抽取一次出生資料（次要）");
  reroll.addEventListener("click", () => handlers.onReroll());
  // 世界還在背景準備時顯示「準備人生…」；失敗時另有明確的重試按鈕。
  const start = element(
    "button",
    "p3e-primary",
    model.startPending ? "準備人生…" : model.worldStage === "error" ? "重試並開始人生" : "開始人生"
  );
  start.type = "button";
  start.dataset["action"] = "start-life";
  start.disabled = model.startPending;
  start.addEventListener("click", () => handlers.onStart());
  actions.append(reroll, start);
  if (model.worldStage === "error") {
    const retry = element("button", "p3e-primary", "重試載入");
    retry.type = "button";
    retry.dataset["action"] = "retry-world";
    retry.addEventListener("click", () => handlers.onRetry());
    actions.append(retry);
  }
  const status = element(
    "p",
    "p3e-world-status",
    model.worldStage === "error"
      ? (model.worldError ?? "人生資料還沒準備好，請稍後重試。")
      : model.startPending
        ? "正在準備完整人生資料，完成後會自動開始。"
        : model.worldStage === "ready"
          ? "人生資料已準備完成。"
          : "正在背景準備人生資料，出生資料已可查看。"
  );
  status.dataset["p3eWorldStatus"] = worldStage;
  status.setAttribute("role", "status");

  card.append(hero, grid, story, status, actions);
  screen.append(card);
  app.replaceChildren(screen);
  // 出生卡階段完全不建立 Audio、不下載音檔；只寫入可觀察的預設 dataset。
  writeBirthAudioDataset(screen);
  handlers.afterRender?.(screen);
}


/**
 * birth bundle 解析／版本／內容雜湊失敗時的**唯一**錯誤頁。
 * 不建立 session、不顯示 internal key／HTTP 狀態／hash，提供可重試按鈕。
 */
export function renderBirthLoadError(
  app: HTMLElement,
  message: string,
  onRetry: () => void,
  action: string = "retry-birth-bundle"
): void {
  const shell = element("main", "p3e-shell");
  shell.dataset["p3eLive"] = "false";
  shell.dataset["p3ePhase"] = "error";
  shell.dataset["p3eCopyKeys"] = "0";
  const heading = element("p", "p3e-alert", message);
  heading.id = "p3e-boot-error";
  heading.setAttribute("role", "alert");
  heading.setAttribute("aria-live", "assertive");
  const detail = element("p", "p3e-boot-error-detail", "請檢查網路連線後再試一次；人生還沒有開始。");
  const retry = element("button", "p3e-primary", "重試載入");
  retry.type = "button";
  retry.dataset["action"] = action;
  retry.addEventListener("click", onRetry);
  shell.append(element("h1", undefined, "人生模擬"), heading, detail, retry);
  app.replaceChildren(shell);
}
