import {
  clearP3EBrowserAutosaveSession,
  createP3EBrowserSession,
  exportP3EBrowserPortableSave,
  prepareP3EBrowserWorld,
  previewP3EBrowserBirth,
  restoreP3EBrowserAutosaveSession,
  restoreP3EBrowserPortableSave,
  runP3EPlaySessionCommand,
  saveP3EBrowserAutosaveSession,
  type P3EBrowserBirthPreview,
  type P3EBrowserWorld,
  type P3EPlaySession
} from "@life-sim/application";
import { createLifeClock, type Speed } from "./p3e-time-controller.js";

/**
 * H5-CTO-176-A／H5-CTO-188-A／GPT-0017-D：真實 P3-E runtime 的瀏覽器垂直切片。
 *
 * 預設路徑（沒有 `?preview=fixture`）就是這支程式：
 *
 * 1. **出生卡**：先用正式 application 的
 *    `previewP3EBrowserBirth({ world, masterSeed })` 顯示這條命會出生在誰家
 *    （國旗／繁中國名、姓名、性別、城鄉、收入、住房、父母年齡與職業、宗教、
 *    預期壽命、出生故事），**不建立 session**，clock 暫停；
 * 2. **開始人生**才用同一個 seed 呼叫 `createP3EBrowserSession` 建立 age 0
 *    session 並寫入 autosave（preview 與 session 的 certificateId／hash／
 *    regionCode／sex／birthYear 因此逐位元一致）；
 * 3. 之後逐年推進、待決策選擇、死亡；死亡後按「重新開始」回到出生卡（新 seed）。
 *
 * ## seed 規則（訂單第 2、7、8 項）
 *
 * - `?seed=` 合法時一律以它為準（固定測試／官方 golden 走這條）；
 * - 其次讀 UI 自有 key `life-sim:p3e:active-seed`，reload 會回到同一段人生；
 *   出生卡階段就立刻寫入，所以重新整理看到的是同一張卡；
 * - 都沒有 active seed 時，先用舊常數 `DEFAULT_SEED` 嘗試恢復上一版存檔，
 *   成功就補寫 active seed（相容舊玩家）；
 * - **只有確認沒有任何舊存檔**，才用 `crypto.getRandomValues` 產生真正隨機的
 *   seed（`life-` 開頭）建立出生預覽；全新使用者不會被固定在 `DEFAULT_SEED`
 *   的同一個國家／家庭／身分。需要 golden 決定性時一律用 `?seed=` 開頁；
 * - 「重新抽取」與死亡後的「重新開始」同樣換一個新的隨機 seed。
 *
 * ## 其他
 *
 * - 所有 pack 只驗證一次（`prepareP3EBrowserWorld`），每條命重用已驗證 pack；
 * - 遊戲狀態只存在本模組的 `session` 變數；畫面只從 `session.view` 或出生預覽渲染；
 * - 金錢維持 base10 字串，不轉 number；
 * - localStorage 只在 UI 取得且包在 try/catch；存取失敗一律降級為 ephemeral
 *   （可預覽、可玩、不中斷）並顯示非阻塞警告；
 * - 壞存檔／錯 seed 不靜默刪除，一律顯示恢復動作（由使用者明確清除）；
 * - 資料包文案是簡中：UI **只在顯示層**把已知標籤（城鄉／五分之一／住房／宗教／
 *   職業）與出生故事的固定片語轉繁中；姓名、地名等資料值原樣呈現，`fixtures/`、
 *   資料包與 engine 完全不動。
 * - GPT-0025-D：事件標題／決策問題／選項按鈕的繁中文字由獨立 JSON 資產
 *   `fixtures/p3b/event-copy.zh-Hant.v1.json`（307 keys）提供，與其他 pack 同批
 *   `fetch` 載入、驗證通過後才合併進顯示層查表；字典優先於舊 `DISPLAY_TEXT`。
 *   查不到對照時顯示中性中文而非 internal key；字典載入或驗證失敗則直接顯示
 *   可理解的啟動錯誤並停在錯誤頁，不讓玩家看到內部代碼。
 */

/* ------------------------------------------------------------------ */
/* fixtures（以 URL 形式載入，避免把 3MB pack 打進初始 JS）                 */
/* ------------------------------------------------------------------ */

const PACK_URLS = {
  p2aManifest: new URL("../../../fixtures/p2a/manifest.v1.json", import.meta.url).href,
  p2aCountryRegistry: new URL("../../../fixtures/p2a/country-registry.v1.json", import.meta.url).href,
  p2aIndicators: new URL("../../../fixtures/p2a/indicators.v1.json", import.meta.url).href,
  p2aBirthWeights: new URL("../../../fixtures/p2a/birth-weights.v1.json", import.meta.url).href,
  p2aSensitiveNames: new URL("../../../fixtures/p2a/sensitive-names.v1.json", import.meta.url).href,
  p2aLicenses: new URL("../../../fixtures/p2a/licenses.v1.json", import.meta.url).href,
  p2aLineage: new URL("../../../fixtures/p2a/lineage.v1.json", import.meta.url).href,
  p2bManifest: new URL("../../../fixtures/p2b/manifest.v1.json", import.meta.url).href,
  p2bCountryVitals: new URL("../../../fixtures/p2b/country-vitals.v1.json", import.meta.url).href,
  p2bHouseholdProfiles: new URL("../../../fixtures/p2b/household-profiles.v1.json", import.meta.url).href,
  p2bNameCorpus: new URL("../../../fixtures/p2b/name-corpus.v1.json", import.meta.url).href,
  p2bStoryTemplates: new URL("../../../fixtures/p2b/story-templates.v1.json", import.meta.url).href,
  p2bLicenses: new URL("../../../fixtures/p2b/licenses.v1.json", import.meta.url).href,
  p2bLineage: new URL("../../../fixtures/p2b/lineage.v1.json", import.meta.url).href,
  p3bManifest: new URL("../../../fixtures/p3b/manifest.v1.json", import.meta.url).href,
  p3bEvents: new URL("../../../fixtures/p3b/events.v1.json", import.meta.url).href,
  // GPT-0025-D：顯示層繁中字典維持獨立 JSON 資產（new URL + fetch），
  // 不靜態 import 進主 JS，也不進 P3-B 事件 checksum。
  p3bEventCopy: new URL("../../../fixtures/p3b/event-copy.zh-Hant.v1.json", import.meta.url).href,
  p3dManifest: new URL("../../../fixtures/p3d/manifest.v1.json", import.meta.url).href,
  p3dCauseRegistry: new URL("../../../fixtures/p3d/cause-registry.v1.json", import.meta.url).href,
  p3dCauseWeights: new URL("../../../fixtures/p3d/cause-weights.v1.json", import.meta.url).href,
  p3dMortality: new URL("../../../fixtures/p3d/mortality.v1.json", import.meta.url).href,
  p3dLicenses: new URL("../../../fixtures/p3d/licenses.v1.json", import.meta.url).href,
  p3dLineage: new URL("../../../fixtures/p3d/lineage.v1.json", import.meta.url).href
} as const;

const DEFAULT_SEED = "p3e-166-playable-runtime-v4";
const SEED_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** UI 自有的 active seed key（與 application autosave 的 `life-sim:p3e:v6:autosave` 分開）。 */
const ACTIVE_SEED_KEY = "life-sim:p3e:active-seed";

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
function toHantLabel(value: string): string {
  return HANT_LABELS[value] ?? value;
}

/** 國旗 emoji（未收錄地區或非 ISO2 一律回地球符號）。 */
function flagOf(regionCode: string): string {
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

type TabKey = "life" | "family" | "work" | "map";

/** autosave 狀態（對應 `data-p3e-persistence-status`）。 */
type PersistenceStatus =
  | "restored"
  | "saved"
  | "saving"
  | "missing"
  | "unavailable"
  | "save-error"
  | "restore-error"
  | "cleared"
  | "ephemeral";

/* ------------------------------------------------------------------ */
/* 模組狀態（只有 session；沒有全域遊戲狀態）                              */
/* ------------------------------------------------------------------ */

let world: P3EBrowserWorld | null = null;
let session: P3EPlaySession | null = null;
/**
 * GPT-0025-D：驗證過的顯示層繁中字典（null-prototype，避免 `__proto__` 之類
 * 的 key 透過原型鏈查到非字串值）。`loadWorld()` 成功後才有值；
 * 驗證失敗會直接讓 boot 顯示啟動錯誤，不會默默降到 internal key。
 */
let eventCopy: Readonly<Record<string, string>> | null = null;
let eventCopyKeys = 0;
let activeTab: TabKey = "life";
let busy = false;
let focusAdvanceAfterRender = false;
let fastForwarding = false;

/** 這條命的 seed（`?seed=` > active seed > DEFAULT_SEED）。出生卡階段就已確定。 */
let activeSeed: string | null = null;
/** 出生卡階段的 seed／預覽；session 建立後清空。 */
let birthSeed: string | null = null;
let birthPreview: P3EBrowserBirthPreview | null = null;

/** UI 取得的最小儲存能力；null 代表不可用（ephemeral 模式）。 */
let storage: Storage | null = null;
let persistenceStatus: PersistenceStatus = "missing";
let persistenceError: string | null = null;
/** true 表示存檔損壞／seed 不符；使用者必須明確按「清除並重新開始」。 */
let recoveryNeeded = false;
/** false 表示目前的命不寫入 autosave（restore 失敗的保護狀態）。 */
let persistenceEnabled = true;
/** 每次成功提交 session 就 +1；dataset 只暴露這個單調序號。 */
let persistenceGeneration = 0;
/** 已排程的 idle flush handle（同時只能有一個；coalescing 靠這個）。 */
let saveHandle: number | null = null;
/** 最近一次成功寫入的 generation；較舊的 flush 不得覆寫。 */
let savedGeneration = -1;
/** 最近一次 portable 匯出的「檔名|MIME」字串（只作 UI 狀態，供 E2E 觀察）。 */
let lastExport: string | null = null;
/** 最近一次 portable 匯入結果（ok／error／null；只作 UI 狀態）。 */
let lastImport: "ok" | "error" | null = null;

const PORTABLE_FILENAME = "life-sim-p3e-v6.json";
const PORTABLE_MIME = "application/json";

const app: HTMLDivElement = (() => {
  const found = document.querySelector<HTMLDivElement>("#app");
  if (found === null) throw new Error("missing #app");
  return found;
})();

const lifeClock = createLifeClock({
  baseIntervalMs: 6000,
  initialSpeed: 1,
  onTick: async () => {
    if (session?.view.controls.canAdvanceYear === true) advanceYear();
    else lifeClock.pause();
  },
  onStateChange: () => {
    if (session !== null && !busy) render();
  }
});
// 世界資料載入前先停住；boot 完成後才開始推進正式 session。
lifeClock.pause();

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `?seed=` 的固定測試能力：合法才採用，其餘一律忽略。 */
function readPinnedSeed(): string | null {
  const raw = new URLSearchParams(window.location.search).get("seed");
  return raw !== null && SEED_PATTERN.test(raw) ? raw : null;
}

/**
 * 真正隨機的 birth seed：`crypto.getRandomValues` 取 10 bytes → 20 hex。
 *
 * 用於「全新使用者的第一次開頁」、「重新抽取」與死亡後的「重新開始」；
 * 只有 `?seed=` 釘住、既有 active seed 或成功還原的舊存檔才走決定性路徑
 * （官方 golden 統一以 `?seed=p3e-166-playable-runtime-v4` 開頁）。
 */
function randomSeed(): string {
  const bytes = new Uint8Array(10);
  const source = window.crypto;
  if (typeof source === "object" && source !== null && typeof source.getRandomValues === "function") {
    source.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `life-${hex}`;
}

/** UI 自有 active seed（reload 恢復同一段人生）；失敗一律視為沒有。 */
function readActiveSeed(): string | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(ACTIVE_SEED_KEY);
    return raw !== null && SEED_PATTERN.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 寫入 active seed；儲存不可用時靜默略過（只是 UX 便利，不影響遊戲）。 */
function writeActiveSeed(seed: string): void {
  if (storage === null) return;
  try {
    storage.setItem(ACTIVE_SEED_KEY, seed);
  } catch {
    // 配額／權限問題：不中斷遊戲，下次開頁就退回舊常數或出生卡。
  }
}

/**
 * 目前這段人生的 seed：`?seed=` > active seed > `DEFAULT_SEED`。
 * 最後一層只是防線：正常流程在 `boot()`／`showBirth()` 就已寫入 activeSeed；
 * 全新開頁的隨機 seed 也由 `showBirth()` 立即寫入，不會退回舊常數。
 */
function readSeed(): string {
  return readPinnedSeed() ?? activeSeed ?? DEFAULT_SEED;
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; path?: unknown; message?: unknown };
    if (typeof record.code === "string") {
      return typeof record.path === "string" ? `${record.code} at ${record.path}` : record.code;
    }
    if (typeof record.message === "string") return record.message;
  }
  return "E_UNKNOWN";
}

function formatMicroUsd(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  if (!/^\d+$/.test(digits)) return value;
  const padded = digits.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = padded.slice(-6, -4);
  return `${negative ? "-" : ""}$${whole}.${cents}`;
}

function ageStage(age: number): { label: string; icon: string } {
  if (age <= 2) return { label: "嬰兒", icon: "👶" };
  if (age <= 12) return { label: "童年", icon: "🧒" };
  if (age <= 17) return { label: "少年", icon: "🧑" };
  if (age <= 39) return { label: "青年", icon: "🧑" };
  if (age <= 64) return { label: "中年", icon: "🧔" };
  return { label: "晚年", icon: "🧓" };
}

/* ------------------------------------------------------------------ */
/* GPT-0025-D：顯示層文案字典（舊表的補充／覆蓋來源）                      */
/* ------------------------------------------------------------------ */

const COPY_SCHEMA_VERSION = "p3b-copy-1";
const COPY_LOCALE = "zh-Hant";
/** 字典 key 的安全下限：77 個事件 + 58 個問題 + 172 個選項。 */
const COPY_MIN_KEYS = 307;
/** 會透過原型鏈污染查表的危險鍵（JSON.parse 仍可能帶進來）。 */
const DANGEROUS_COPY_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 死因 id → 繁中（顯示層對照；資料包與引擎不動）。 */
const DEATH_CAUSE_TEXT: Readonly<Record<string, string>> = {
  "cause.neutral.circulatory": "心血管相關疾病",
  "cause.neutral.respiratory": "呼吸系統相關疾病",
  "cause.neutral.infection": "感染性疾病",
  "cause.neutral.neoplasm": "腫瘤相關疾病",
  "cause.neutral.neurological": "神經系統相關疾病",
  "cause.neutral.digestive": "消化系統相關疾病",
  "cause.neutral.external": "意外與外在因素",
  "cause.neutral.other": "其他健康因素"
};

function friendlyDeathCause(causeId: string): string {
  if (Object.prototype.hasOwnProperty.call(DEATH_CAUSE_TEXT, causeId)) {
    return DEATH_CAUSE_TEXT[causeId] ?? "其他健康因素";
  }
  return "其他健康因素";
}

/** JSON.parse 的結果也須確認是普通物件，不接受陣列／自訂原型。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 使用字典前的最小驗證（GPT-0025-D 第 2 項）。任何一項不符就 throw，
 * 由 `boot()` 統一轉成可理解的啟動錯誤，**不會**讓畫面顯示 internal key。
 */
function validateEventCopy(raw: unknown, expectedPackVersion: string): Record<string, string> {
  if (!isPlainRecord(raw)) {
    throw new Error("E_P3E_COPY_DOCUMENT：事件文案檔格式錯誤，請重新整理頁面。");
  }
  if (raw["schemaVersion"] !== COPY_SCHEMA_VERSION) {
    throw new Error("E_P3E_COPY_SCHEMA：事件文案版本不相容，請重新整理頁面。");
  }
  if (raw["locale"] !== COPY_LOCALE) {
    throw new Error("E_P3E_COPY_LOCALE：事件文案語系不符，請重新整理頁面。");
  }
  if (raw["contentPackVersion"] !== expectedPackVersion) {
    throw new Error("E_P3E_COPY_PACK：事件文案與事件包版本不符，請重新整理頁面。");
  }
  const table: unknown = raw["copy"];
  if (!isPlainRecord(table)) {
    throw new Error("E_P3E_COPY_TABLE：事件文案表格式錯誤，請重新整理頁面。");
  }
  // null-prototype：查表時 `copy["__proto__"]` 不會命中 Object.prototype。
  const validated: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(table)) {
    if (
      DANGEROUS_COPY_KEYS.has(key) ||
      key.length === 0 ||
      key !== key.trim() ||
      typeof value !== "string" ||
      value.trim().length === 0
    ) {
      throw new Error("E_P3E_COPY_ENTRY：事件文案含無效欄位，請重新整理頁面。");
    }
    validated[key] = value;
  }
  if (Object.keys(validated).length < COPY_MIN_KEYS) {
    throw new Error("E_P3E_COPY_INCOMPLETE：事件文案不完整，請重新整理頁面。");
  }
  return validated;
}

/** 舊的少數硬編碼；字典優先覆蓋／補充，這裡保留作為降級保險。 */
const DISPLAY_TEXT: Readonly<Record<string, string>> = {
  "ev.adult.burnout": "工作帶來了倦怠感",
  "ev.adult.debt-scare": "債務壓力突然逼近",
  "ev.adult.first-salary": "領到人生第一份薪水",
  "ev.adult.housing-choice": "面臨居住安排的重要選擇",
  "ev.adult.promotion": "在工作上獲得晉升",
  "ev.adult.volunteer": "參加了一次志工活動",
  "ev.any.quiet-year": "平靜地度過了一年",
  "ev.any.setback": "遇到了一次挫折",
  "ev.any.small-win": "收穫了一個小小的成功",
  "ev.child.first-word": "說出了人生第一句話",
  "ev.child.playground": "在遊樂場交到了新朋友",
  "ev.child.school-choice": "面臨入學方式的選擇",
  "ev.child.sibling-arrives": "家裡迎來了新的手足",
  "ev.child.tantrum": "因為不順心而大哭了一場",
  "ev.guardian.calm": "在家人的照顧下平靜成長",
  "ev.senior.health-check": "完成了一次健康檢查",
  "ev.senior.reflection": "回望自己走過的人生",
  "ev.teen.exams": "迎來了一場重要考試",
  "ev.teen.friendship": "交到了一位知心朋友",
  "ev.teen.major-choice": "面臨未來方向的重要選擇",
  "ev.teen.part-time-job": "開始了人生第一份打工",
  "ev.teen.risk-experiment": "嘗試了一次冒險",
  "p3b.decision.adult.housing": "你要怎麼安排接下來的住處？",
  "p3b.decision.child.school": "你希望選擇哪一種學習方式？",
  "p3b.decision.teen.path": "高中階段結束了，下一步要怎麼走？",
  "p3b.option.adult.housing.rent": "先租房，換取自己的生活空間",
  "p3b.option.adult.housing.save": "暫時不搬，把錢存下來",
  "p3b.option.child.school.bold": "選擇更多元、充滿挑戰的學習環境",
  "p3b.option.child.school.steady": "選擇穩定、按部就班的學習環境",
  "p3b.option.teen.path.rest": "先休息一年，重新思考方向",
  "p3b.option.teen.path.study": "繼續升學，累積知識",
  "p3b.option.teen.path.work": "開始工作，累積實務經驗"
};

/**
 * 顯示層查表：驗證過的字典 > 舊硬編碼表。
 *
 * 字典是 null-prototype，舊表則用 hasOwnProperty 明確檢查，兩者都不會讓
 * `__proto__`／`constructor` 之類的 key 查到原型鏈上的非字串值。
 */
function friendlyKey(value: string): string {
  const fromCopy = eventCopy === null ? undefined : eventCopy[value];
  if (typeof fromCopy === "string" && fromCopy.length > 0) return fromCopy;
  if (Object.prototype.hasOwnProperty.call(DISPLAY_TEXT, value)) {
    const legacy = DISPLAY_TEXT[value];
    if (typeof legacy === "string" && legacy.length > 0) return legacy;
  }
  const trimmed = value.trim();
  if (trimmed === "") return "平凡的一年";
  // 找不到對照時也不把 internal key 外洩到畫面（p3b.／ev.／option.／底線式…）。
  if (/^[A-Za-z0-9._:-]+$/.test(trimmed)) return "人生的一段插曲";
  return trimmed.replace(/^event[._-]?/i, "").trim() || "平凡的一年";
}

/**
 * CHOOSE_DECISION 的 outcome 只有 `eventId` + `selectedOptionId`，
 * 但字典的 key 是 `p3b.option.<eventId 去掉 ev.>.<optionId>`；
 * 這裡純在顯示層組回 labelKey，讓「你已經做出了選擇」也顯示自然繁中。
 */
function friendlyChosenOption(outcome: {
  readonly eventId: string;
  readonly selectedOptionId: string;
}): string {
  const suffix = outcome.eventId.replace(/^ev\./, "");
  const label = friendlyKey(`p3b.option.${suffix}.${outcome.selectedOptionId}`);
  return label === "人生的一段插曲" ? "做出了當時的選擇" : label;
}

/* ------------------------------------------------------------------ */
/* 持久化（localStorage 只在 UI 取得、且全部包在 try/catch）               */
/* ------------------------------------------------------------------ */

function acquireStorage(): Storage | null {
  try {
    const candidate = window.localStorage;
    return typeof candidate === "object" && candidate !== null ? candidate : null;
  } catch {
    return null;
  }
}

/** 同步寫入目前 session（boot／flush／pagehide／恢復）；失敗只降級、不回滾命令。 */
function persistCurrentSession(): boolean {
  if (storage === null || session === null || !persistenceEnabled) return false;
  if (persistenceGeneration < savedGeneration) return false; // 舊 flush 不得覆寫較新的存檔
  const generation = persistenceGeneration;
  try {
    saveP3EBrowserAutosaveSession({ storage, session });
    persistenceStatus = "saved";
    persistenceError = null;
    savedGeneration = generation;
    return true;
  } catch (error) {
    persistenceStatus = "save-error";
    persistenceError = describeError(error);
    return false;
  }
}

/** 取消已排程的 idle flush（恢復／重生前呼叫，避免 stale write）。 */
function cancelScheduledSave(): void {
  if (saveHandle === null) return;
  if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(saveHandle);
  else window.clearTimeout(saveHandle);
  saveHandle = null;
}

/** 空閒時寫入「目前最新的 session」；較舊的 flush 一律丟棄。 */
function flushAutosave(): void {
  saveHandle = null;
  if (persistenceGeneration < savedGeneration) {
    return;
  }
  if (persistCurrentSession() || persistenceStatus === "save-error") updatePersistenceDom();
}

/**
 * 排程一次 idle autosave（單一 writer、coalescing）。
 *
 * 命令路徑只 commit＋render，然後呼叫這個函式；實際 encode＋localStorage
 * 寫入延後到 requestIdleCallback（fallback setTimeout 0）。連續命令只會保留
 * 最新 session，flush 時寫的永遠是目前最新狀態。
 */
function scheduleAutosave(): void {
  if (storage === null || session === null || !persistenceEnabled) return;
  persistenceStatus = "saving";
  if (saveHandle !== null) return;
  const run = (): void => flushAutosave();
  if (typeof window.requestIdleCallback === "function") {
    saveHandle = window.requestIdleCallback(run, { timeout: 200 });
  } else {
    saveHandle = window.setTimeout(run, 0);
  }
}

/** pagehide／visibilitychange 用的同步 flush（只寫最新 session）。 */
function flushAutosaveNow(): void {
  cancelScheduledSave();
  if (storage === null || session === null || !persistenceEnabled) return;
  persistCurrentSession();
  updatePersistenceDom();
}

/* ------------------------------------------------------------------ */
/* 可攜式存檔檔（下載／上傳；與 autosave 的 1 MiB 限制無關）              */
/* ------------------------------------------------------------------ */

/** 匯出目前 session 為 canonical raw V6 envelope，觸發瀏覽器下載。 */
function downloadPortableSave(): void {
  if (session === null) return;
  let url: string | null = null;
  try {
    const raw = exportP3EBrowserPortableSave({ session });
    const blob = new Blob([raw], { type: PORTABLE_MIME });
    url = URL.createObjectURL(blob);
    const anchor = element("a");
    anchor.href = url;
    anchor.download = PORTABLE_FILENAME;
    anchor.rel = "noopener";
    app.append(anchor);
    anchor.click();
    anchor.remove();
    lastExport = `${PORTABLE_FILENAME}|${PORTABLE_MIME}`;
    persistenceError = null;
  } catch (error) {
    showAlert(describeError(error));
  } finally {
    if (url !== null) URL.revokeObjectURL(url);
    render();
  }
}

/**
 * 從使用者選取的檔案還原 session。
 *
 * 只有正式 `restoreP3EBrowserPortableSave` 成功才替換 session；失敗時目前
 * session 逐位元不變，只顯示受控錯誤。成功後取消 stale autosave、替換
 * session、重新排程存檔並 render。
 */
function importPortableSaveFile(file: File): void {
  if (world === null || session === null) return;
  void file
    .arrayBuffer()
    .then((buffer) => {
      try {
        const restored = restoreP3EBrowserPortableSave({
          world,
          masterSeed: readSeed(),
          data: new Uint8Array(buffer)
        });
        cancelScheduledSave();
        session = restored;
        persistenceGeneration += 1;
        alertText = null;
        persistenceError = null;
        if (storage !== null && persistenceEnabled) persistenceStatus = "saving";
        lastImport = "ok";
        scheduleAutosave();
        render();
      } catch (error) {
        lastImport = "error";
        showAlert(describeError(error));
        render();
      }
    })
    .catch((error: unknown) => {
      lastImport = "error";
      showAlert(describeError(error));
      render();
    });
}
/** 明確清除 autosave（恢復動作／重生）；失敗原樣拋給呼叫端處理。 */
function clearAutosave(): void {
  if (storage === null) return;
  clearP3EBrowserAutosaveSession({ storage });
}

/**
 * 使用者明確觸發的恢復：先清除壞存檔，再開新的一命並存檔。
 * 只有這個動作會刪除既有 autosave（壞存檔／錯 seed 不靜默刪除）。
 */
function recoverAutosave(): void {
  if (busy || world === null || storage === null) return;
  busy = true;
  try {
    cancelScheduledSave();
    clearAutosave();
    persistenceEnabled = true;
    recoveryNeeded = false;
    persistenceError = null;
    session = startLife(readSeed());
    persistenceGeneration += 1;
    persistenceStatus = "cleared";
    persistCurrentSession();
    focusAdvanceAfterRender = true;
  } catch (error) {
    persistenceStatus = "save-error";
    persistenceError = describeError(error);
  } finally {
    busy = false;
    render();
  }
}

/* ------------------------------------------------------------------ */
/* 資料載入（pack 只驗證一次）                                           */
/* ------------------------------------------------------------------ */

async function loadJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
  return response.json();
}

async function loadWorld(): Promise<P3EBrowserWorld> {
  const keys = Object.keys(PACK_URLS) as (keyof typeof PACK_URLS)[];
  const loaded = await Promise.all(keys.map((key) => loadJson(PACK_URLS[key])));
  const data: Record<string, unknown> = {};
  keys.forEach((key, index) => {
    data[key] = loaded[index];
  });

  const events = data["p3bEvents"] as { records: unknown[]; contentPackVersion?: unknown };
  const p3bManifest = data["p3bManifest"] as { contentPackVersion?: unknown };

  // GPT-0025-D：同一批載入的繁中字典必須與 P3-B events／manifest 的
  // contentPackVersion 完全一致，且通過最小驗證後才寫進模組狀態。
  // 驗證失敗會 throw → boot() 顯示啟動錯誤，不會降到 internal key。
  const packVersion = p3bManifest?.contentPackVersion;
  if (
    typeof packVersion !== "string" ||
    packVersion.length === 0 ||
    events?.contentPackVersion !== packVersion
  ) {
    throw new Error("E_P3E_COPY_PACK：事件包與 manifest 版本不一致，請重新整理頁面。");
  }
  const validatedCopy = validateEventCopy(data["p3bEventCopy"], packVersion);
  eventCopy = validatedCopy;
  eventCopyKeys = Object.keys(validatedCopy).length;

  return prepareP3EBrowserWorld({
    base: {
      manifest: data["p2aManifest"],
      datasets: {
        "country-registry": data["p2aCountryRegistry"],
        indicators: data["p2aIndicators"],
        "birth-weights": data["p2aBirthWeights"],
        "sensitive-names": data["p2aSensitiveNames"],
        licenses: data["p2aLicenses"],
        lineage: data["p2aLineage"]
      }
    },
    identity: {
      manifest: data["p2bManifest"],
      datasets: {
        "country-vitals": data["p2bCountryVitals"],
        "household-profiles": data["p2bHouseholdProfiles"],
        "name-corpus": data["p2bNameCorpus"],
        "story-templates": data["p2bStoryTemplates"],
        licenses: data["p2bLicenses"],
        lineage: data["p2bLineage"]
      }
    },
    events: { manifest: data["p3bManifest"], events: events.records },
    death: {
      manifest: data["p3dManifest"],
      datasets: {
        "cause-registry": data["p3dCauseRegistry"],
        "cause-weights": data["p3dCauseWeights"],
        mortality: data["p3dMortality"],
        licenses: data["p3dLicenses"],
        lineage: data["p3dLineage"]
      }
    }
  });
}

function startLife(seed: string): P3EPlaySession {
  if (world === null) throw new Error("world not ready");
  return createP3EBrowserSession({ world, masterSeed: seed });
}

/* ------------------------------------------------------------------ */
/* 出生卡（GPT-0017-D）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 顯示出生卡：用正式 `previewP3EBrowserBirth` 產生資料，**不建立 session**，
 * clock 保持暫停。seed 會立刻寫進 UI 自有 active seed key，reload 回到同一張卡。
 */
function showBirth(seed: string): void {
  const currentWorld = world;
  if (currentWorld === null) throw new Error("world not ready");
  birthSeed = seed;
  activeSeed = seed;
  writeActiveSeed(seed);
  birthPreview = previewP3EBrowserBirth({ world: currentWorld, masterSeed: seed });
  session = null;
  lifeClock.pause();
  renderBirth();
}

/** 重新抽取：換一個真正隨機的 seed，出生資料（國名／姓名／家庭）一起更新。 */
function rerollBirth(): void {
  if (busy || world === null) return;
  busy = true;
  try {
    alertText = null;
    showBirth(randomSeed());
  } catch (error) {
    showAlert(describeError(error));
    renderBirth();
  } finally {
    busy = false;
  }
}

/** 開始人生：才建立正式 age 0 session（與 preview 同一個 seed）並寫入 autosave。 */
function startLifeFromCard(): void {
  const seed = birthSeed;
  if (busy || seed === null || world === null) return;
  busy = true;
  try {
    session = startLife(seed);
    birthSeed = null;
    birthPreview = null;
    activeSeed = seed;
    writeActiveSeed(seed);
    alertText = null;
    recoveryNeeded = false;
    persistenceEnabled = true;
    persistenceGeneration += 1;
    if (storage === null) {
      // 沒有儲存能力：可玩但只存在記憶體（ephemeral）。
      persistenceStatus = "ephemeral";
      persistenceEnabled = false;
    } else {
      persistCurrentSession();
    }
    focusAdvanceAfterRender = true;
    if (session.view.controls.canAdvanceYear) lifeClock.resume();
    else lifeClock.pause();
  } catch (error) {
    showAlert(describeError(error));
  } finally {
    busy = false;
    render();
  }
}

/**
 * 出生卡：一個畫面、卡片內局部捲動。
 *
 * class／`data-action`／`data-p3e-*` 全部依既定契約（style.css 與 smoke）：
 * `.p3e-birth-screen/card/hero/country/grid/story/actions`、
 * `data-action="reroll-birth"`、`data-action="start-life"`，並在畫面根節點掛
 * `data-p3e-live`／`data-p3e-phase`／`data-p3e-birth-seed` 等診斷屬性。
 */
function renderBirth(): void {
  const birth = birthPreview;
  const seed = birthSeed;
  if (birth === null || seed === null) return;

  const screen = element("main", "p3e-birth-screen");
  screen.dataset["p3eLive"] = "true";
  screen.dataset["p3ePhase"] = "birth";
  screen.dataset["p3eCopyKeys"] = String(eventCopyKeys);
  screen.dataset["p3eCopySchema"] = COPY_SCHEMA_VERSION;
  screen.dataset["p3eBirthSeed"] = seed;
  screen.dataset["p3eBirthCertificateHash"] = birth.certificateHash;
  screen.dataset["p3eBirthIdentityHash"] = birth.playerIdentityHash;
  screen.dataset["p3eCommandCount"] = "0";
  screen.dataset["p3ePersistenceStatus"] = persistenceStatus;
  screen.dataset["p3ePersistenceError"] = persistenceError ?? "";

  const card = element("article", "p3e-birth-card");
  card.setAttribute("aria-labelledby", "p3e-birth-country");

  const hero = element("header", "p3e-birth-hero");
  const country = element("h1", "p3e-birth-country");
  country.id = "p3e-birth-country";
  const flag = element("span", "p3e-birth-flag", flagOf(birth.country.regionCode));
  flag.setAttribute("aria-hidden", "true");
  country.append(flag, element("span", undefined, birth.country.nameZhHant));
  const headline = element(
    "p",
    "p3e-birth-headline",
    `${birth.name.fullName} · ${sexText(birth)} · ${birth.birthYear} 年`
  );
  hero.append(element("p", "p3e-birth-caption", "出生地"), country, headline);

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
  const reroll = element("button", "p3e-primary", "重新抽取");
  reroll.type = "button";
  reroll.dataset["action"] = "reroll-birth";
  reroll.addEventListener("click", rerollBirth);
  const start = element("button", "p3e-primary", "開始人生");
  start.type = "button";
  start.dataset["action"] = "start-life";
  start.addEventListener("click", startLifeFromCard);
  actions.append(reroll, start);

  card.append(hero, grid, story, actions);
  screen.append(card);
  app.replaceChildren(screen);
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

function runCommand(command: unknown): void {
  if (session === null || busy) return;
  busy = true;
  setControlsDisabled(true);
  try {
    const result = runP3EPlaySessionCommand({ session, command });
    session = result.session;
    if (!session.view.controls.canAdvanceYear) lifeClock.pause();
    persistenceGeneration += 1;
    if (storage !== null && persistenceEnabled) persistenceStatus = "saving";
    focusAdvanceAfterRender = true;
  } catch (error) {
    showAlert(describeError(error));
  } finally {
    busy = false;
    render();
  }
  // 先讓畫面更新（命令已提交），再把最新 session 排進 idle autosave。
  scheduleAutosave();
}

function advanceYear(): void {
  runCommand({ type: "ADVANCE_YEAR", contentMode: "standard" });
}

async function jumpToNextDecision(): Promise<void> {
  if (session === null || busy || fastForwarding || !session.view.controls.canAdvanceYear) return;
  lifeClock.pause();
  fastForwarding = true;
  try {
    for (let index = 0; index < 120; index += 1) {
      if (session === null || !session.view.controls.canAdvanceYear || session.view.phase === "death") break;
      advanceYear();
      if ((index + 1) % 8 === 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
  } finally {
    fastForwarding = false;
    render();
  }
}

function chooseOption(optionId: string): void {
  runCommand({ type: "CHOOSE_DECISION", optionId });
  if (session?.view.controls.canAdvanceYear === true) lifeClock.resume();
}

/**
 * 死亡後的「重新開始」：清掉上一條命的 autosave，回到出生卡（新的隨機 seed）。
 *
 * 依訂單第 10 項：死亡後重新開始回出生卡；出生階段 clock 暫停，使用者按
 * 「開始人生」才建立新的 age 0 session（`startLifeFromCard`）。
 * `?seed=` 固定測試時仍沿用被釘住的 seed，維持可重播性。
 */
function rebirth(): void {
  if (busy) return;
  busy = true;
  try {
    cancelScheduledSave();
    if (storage !== null && persistenceEnabled) {
      // 順序：先清掉上一條命的 autosave，再回出生卡；新命開始時才寫新存檔。
      try {
        clearAutosave();
      } catch (error) {
        persistenceStatus = "save-error";
        persistenceError = describeError(error);
        return; // 清除失敗：留在目前死亡畫面，不動 session
      }
    }
    persistenceEnabled = true;
    recoveryNeeded = false;
    persistenceGeneration += 1;
    persistenceStatus = "cleared";
    session = null;
    showBirth(readPinnedSeed() ?? randomSeed());
  } catch (error) {
    showAlert(describeError(error));
    render();
  } finally {
    busy = false;
  }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

let alertText: string | null = null;

function showAlert(message: string): void {
  alertText = message;
}

function setControlsDisabled(disabled: boolean): void {
  app.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = disabled || button.dataset["p3eLocked"] === "true";
  });
}

function render(): void {
  if (session === null) return;
  const view = session.view;

  const shell = element("main", "p3e-shell p3e-game-shell");
  shell.id = "p3e-main";
  shell.setAttribute("aria-labelledby", "p3e-title");
  shell.dataset["p3eLive"] = "true";
  shell.dataset["p3ePhase"] = view.phase;
  shell.dataset["p3eCopyKeys"] = String(eventCopyKeys);
  shell.dataset["p3eCopySchema"] = COPY_SCHEMA_VERSION;
  shell.dataset["p3eStateHash"] = session.state.stateHash;
  shell.dataset["p3eCommandCount"] = String(session.state.commandLog.count);
  shell.dataset["p3eCommandHead"] = session.state.commandLog.headHash;
  shell.dataset["p3ePersistenceStatus"] = persistenceStatus;
  shell.dataset["p3ePersistenceError"] = persistenceError ?? "";
  shell.dataset["p3ePersistenceGeneration"] = String(persistenceGeneration);
  shell.dataset["p3eLastExport"] = lastExport ?? "";
  shell.dataset["p3eLastImport"] = lastImport ?? "";

  const header = element("header", "p3e-hud");
  const title = element("h1", "p3e-game-title", "人生模擬");
  title.id = "p3e-title";
  const year = element("div", "p3e-hud-item p3e-hud-year");
  year.append(element("span", undefined, "年份"), element("strong", undefined, String(view.currentYear)));
  const age = element("div", "p3e-hud-item p3e-hud-age");
  age.append(element("span", undefined, "年齡"), element("strong", undefined, `${view.age} 歲`));
  const balance = element("div", "p3e-hud-item p3e-hud-assets");
  balance.append(element("span", undefined, "資產"), element("strong", undefined, formatMicroUsd(view.assets.balanceMicroUsd)));
  const income = element("div", "p3e-hud-item p3e-hud-income");
  income.append(element("span", undefined, "年收入"), element("strong", undefined, formatMicroUsd(view.assets.annualIncomeMicroUsd)));
  const menu = element("details", "p3e-hud-menu");
  const menuSummary = element("summary", undefined, "☰");
  menuSummary.setAttribute("aria-label", "開啟選單");
  menu.append(menuSummary, element("p", undefined, "公開測試版 · 進度自動儲存在本機"));
  const status = element("p", "p3e-status", `${view.currentYear} 年，${view.age} 歲`);
  status.id = "p3e-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  header.append(title, year, age, balance, income, menu, status);

  const alert = element("p", "p3e-alert");
  alert.id = "p3e-alert";
  alert.setAttribute("role", "alert");
  alert.setAttribute("aria-live", "assertive");
  alert.hidden = alertText === null;
  alert.textContent = alertText ?? "";
  if (alertText !== null) {
    status.textContent = `${status.textContent ?? ""} · 錯誤：${alertText}`;
  }

  const tabs = renderTabs();

  const content = element("section", "p3e-content");
  content.setAttribute("aria-label", "目前分頁內容");
  if (activeTab === "life") {
    content.append(renderLife(view, session));
  } else {
    content.append(renderPlaceholder(activeTab));
  }

  const tools = element("details", "p3e-tools");
  const toolsSummary = element("summary", undefined, "存檔與測試資訊");
  const notice = element(
    "p",
    "p3e-mvp-notice",
    "MVP 公開測試版 · 遊戲內容使用虛構／合成資料，不代表真實人口統計。"
  );
  const technical = element(
    "p",
    "p3e-meta",
    `seed=${readSeed()} · commands=${session.state.commandLog.count} · stateHash=${session.state.stateHash}`
  );
  tools.append(toolsSummary, notice, renderPersistence(), technical);

  shell.append(header, alert, content, tools, tabs);
  app.replaceChildren(shell);

  const advance = shell.querySelector<HTMLButtonElement>('[data-action="advance"]');
  if (focusAdvanceAfterRender && advance !== null) {
    advance.focus();
    focusAdvanceAfterRender = false;
  }
}

/** 存檔狀態訊息（error 決定 role=alert 或 status）。 */
function persistenceMessage(): { text: string; error: boolean } {
  switch (persistenceStatus) {
    case "restored":
      return { text: "已載入上次的自動存檔。", error: false };
    case "saved":
      return { text: "已自動存檔。", error: false };
    case "saving":
      return { text: "存檔中…（畫面已更新）", error: false };
    case "missing":
      return { text: "找不到存檔，已開始新的一命。", error: false };
    case "unavailable":
      return { text: "瀏覽器儲存不可用；這一命只在記憶體中，重新整理後會消失。", error: false };
    case "ephemeral":
      return { text: "目前是暫時性命（未存檔），重新整理後會消失。", error: false };
    case "save-error":
      return { text: `存檔失敗，遊戲仍可繼續：${persistenceError ?? "E_UNKNOWN"}`, error: true };
    case "restore-error":
      return { text: `存檔無法載入（未刪除）：${persistenceError ?? "E_UNKNOWN"}`, error: true };
    case "cleared":
      return { text: "已清除舊存檔並開始新的一命。", error: false };
  }
}

/** 自動存檔狀態區；壞存檔時提供明確恢復按鈕（鍵盤可達）＋可攜式存檔下載／上傳。 */
function renderPersistence(): HTMLElement {
  const section = element("section", "p3e-persistence");
  section.setAttribute("aria-label", "自動存檔與可攜式存檔");
  const info = persistenceMessage();
  const line = element("p", "p3e-persistence-line", info.text);
  line.setAttribute("role", info.error ? "alert" : "status");
  line.setAttribute("aria-live", info.error ? "assertive" : "polite");
  section.append(line);

  const exportButton = element("button", "p3e-primary", "匯出存檔");
  exportButton.type = "button";
  exportButton.dataset["action"] = "export";
  exportButton.addEventListener("click", downloadPortableSave);

  const fileInput = element("input", "p3e-file-input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json,application/gzip,.gz";
  fileInput.hidden = true;
  fileInput.dataset["role"] = "import-input";
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file !== undefined) importPortableSaveFile(file);
  });

  const importButton = element("button", "p3e-primary", "匯入存檔");
  importButton.type = "button";
  importButton.dataset["action"] = "import";
  importButton.addEventListener("click", () => fileInput.click());

  section.append(exportButton, importButton, fileInput);

  if (recoveryNeeded) {
    const button = element("button", "p3e-primary", "清除存檔並重新開始");
    button.type = "button";
    button.dataset["action"] = "recover";
    button.addEventListener("click", recoverAutosave);
    section.append(button);
  }
  return section;
}

/** 只更新自動存檔相關 DOM（idle flush 完成後用，不重建整個畫面）。 */
function updatePersistenceDom(): void {
  const shell = app.querySelector<HTMLElement>("[data-p3e-live]");
  if (shell === null) return;
  shell.dataset["p3ePersistenceStatus"] = persistenceStatus;
  shell.dataset["p3ePersistenceError"] = persistenceError ?? "";
  shell.dataset["p3ePersistenceGeneration"] = String(persistenceGeneration);
  const old = shell.querySelector("section.p3e-persistence");
  if (old !== null) old.replaceWith(renderPersistence());
}

function renderTabs(): HTMLElement {  const nav = element("nav", "p3e-tabs");
  nav.setAttribute("aria-label", "分頁");
  const tabs: { key: TabKey; label: string }[] = [
    { key: "life", label: "人生" },
    { key: "family", label: "家族" },
    { key: "work", label: "工作" },
    { key: "map", label: "地圖" }
  ];
  for (const tab of tabs) {
    const button = element("button", "p3e-tab", tab.label);
    button.type = "button";
    button.dataset["tab"] = tab.key;
    button.setAttribute("aria-current", tab.key === activeTab ? "page" : "false");
    button.addEventListener("click", () => {
      activeTab = tab.key;
      render();
    });
    nav.append(button);
  }
  return nav;
}

function renderPlaceholder(tab: TabKey): HTMLElement {
  const labels: Record<Exclude<TabKey, "life">, string> = {
    family: "家族",
    work: "工作",
    map: "地圖"
  };
  const section = element("section", "p3e-placeholder");
  section.append(
    element("h2", undefined, labels[tab as Exclude<TabKey, "life">] ?? tab),
    element("p", undefined, "尚未接入正式資料")
  );
  return section;
}

function renderLife(view: P3EPlaySession["view"], current: P3EPlaySession): HTMLElement {
  const root = element("div", "p3e-life");
  const stage = ageStage(view.age);
  const scene = element("section", `p3e-scene p3e-scene-${view.phase}`);
  scene.setAttribute("aria-label", `${view.currentYear} 年的生活場景`);
  const sceneCopy = element("div", "p3e-scene-copy");
  sceneCopy.append(
    element("span", undefined, `${view.identity.regionCode} · ${stage.label}`),
    element("strong", undefined, `${view.age} 歲的你`)
  );
  const character = element("div", "p3e-character-stage");
  character.dataset["ageStage"] = stage.label;
  character.setAttribute("aria-label", `${stage.label}人物`);
  character.append(element("span", undefined, stage.icon));
  scene.append(sceneCopy, character);

  const story = element("section", "p3e-story-card");
  story.append(element("h2", undefined, view.phase === "pending_decision" ? "重要抉擇" : "當年訊息"));
  const last = current.lastOutcome;
  if (last === null) {
    story.append(element("p", undefined, `${view.currentYear} 年，你的人生故事正要開始。`));
  } else if (last.kind === "advance_year") {
    const eventName = last.selectedEventId === null ? "平凡的一年" : friendlyKey(last.selectedEventId);
    story.append(element("p", undefined, `${view.currentYear} 年，你 ${view.age} 歲。`));
    story.append(element("strong", "p3e-event-name", eventName));
  } else {
    story.append(element("p", undefined, "你已經做出了選擇。"));
    story.append(element("strong", "p3e-event-name", friendlyChosenOption(last)));
  }

  if (view.phase === "pending_decision" && view.pendingDecision !== null) {
    story.append(renderPending(view.pendingDecision));
  }

  if (view.phase === "death") {
    const death = element("div", "p3e-death");
    death.append(element("h3", undefined, "這段人生走到了終點"));
    const deathOutcome = last !== null && last.kind === "advance_year" ? last.death : null;
    const causeText =
      deathOutcome?.causeId === null || deathOutcome?.causeId === undefined
        ? ""
        : ` 原因：${friendlyDeathCause(deathOutcome.causeId)}`;
    death.append(element("p", undefined, `你活了 ${view.age} 年。${causeText}`));
    const again = element("button", "p3e-primary", "重新開始");
    again.type = "button";
    again.dataset["action"] = "rebirth";
    again.addEventListener("click", rebirth);
    death.append(again);
    story.append(death);
  }

  const statDock = element("section", "p3e-stat-dock");
  statDock.setAttribute("aria-label", "人物狀態");
  const statRows: [string, string, number][] = [
    ["❤️", "健康", view.stats.health],
    ["🙂", "幸福", view.stats.happiness],
    ["📘", "知識", view.stats.knowledge],
    ["👥", "人際", view.stats.relationships]
  ];
  for (const [icon, label, value] of statRows) {
    const item = element("div", "p3e-stat-item");
    item.append(element("span", "p3e-stat-label", `${icon} ${label}`), element("strong", undefined, String(value)));
    const meter = element("span", "p3e-stat-meter");
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", `${label}狀態`);
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    meter.setAttribute("aria-valuenow", String(value));
    const fill = element("i");
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    meter.append(fill);
    item.append(meter);
    statDock.append(item);
  }

  const timeControls = renderTimeControls(view);
  const controls = element("section", "p3e-controls");
  controls.setAttribute("aria-label", "操作");
  if (view.controls.canAdvanceYear) {
    const advance = element("button", "p3e-primary p3e-next-button", "下一步");
    advance.type = "button";
    advance.dataset["action"] = "advance";
    advance.addEventListener("click", advanceYear);
    controls.append(advance);
  } else if (view.phase === "pending_decision") {
    controls.append(element("p", "p3e-hint", "請先做出選擇"));
  } else if (view.phase === "death") {
    controls.append(element("p", "p3e-hint", "這條命已結束"));
  }

  root.append(scene, story, statDock, timeControls, controls);
  return root;
}

function renderTimeControls(view: P3EPlaySession["view"]): HTMLElement {
  const section = element("section", "p3e-time-controls");
  section.setAttribute("aria-label", "時間控制");
  const state = lifeClock.getState();
  const pause = element("button", "p3e-time-toggle", state.running ? "❚❚ 暫停" : "▶ 繼續");
  pause.type = "button";
  pause.dataset["action"] = "toggle-time";
  pause.disabled = view.phase === "death";
  pause.addEventListener("click", () => lifeClock.togglePause());
  section.append(pause);
  const speeds: readonly Speed[] = [1, 2, 4, 8, 16];
  for (const speed of speeds) {
    const button = element("button", "p3e-speed-button", `${speed}×`);
    button.type = "button";
    button.dataset["speed"] = String(speed);
    button.setAttribute("aria-pressed", String(state.speed === speed));
    button.disabled = view.phase === "death";
    button.addEventListener("click", () => lifeClock.setSpeed(speed));
    section.append(button);
  }
  const jump = element("button", "p3e-jump-button", "下一個決定 »");
  jump.type = "button";
  jump.dataset["action"] = "jump-decision";
  jump.disabled = !view.controls.canAdvanceYear || fastForwarding;
  jump.addEventListener("click", () => void jumpToNextDecision());
  section.append(jump);
  return section;
}

function renderPending(
  pending: NonNullable<P3EPlaySession["view"]["pendingDecision"]>
): HTMLElement {
  const section = element("div", "p3e-pending");
  section.setAttribute("aria-labelledby", "p3e-pending-title");
  const heading = element("h2", undefined, friendlyKey(pending.promptKey !== "" ? pending.promptKey : pending.eventId));
  heading.id = "p3e-pending-title";
  section.append(heading);
  const options = element("div", "p3e-options p3e-choice-list");
  pending.options.forEach((option, index) => {
    const button = element("button", "p3e-option", friendlyKey(option.labelKey !== "" ? option.labelKey : option.optionId));
    button.type = "button";
    button.dataset["action"] = "choose";
    button.dataset["optionId"] = option.optionId;
    button.dataset["optionIndex"] = String(index);
    button.addEventListener("click", () => chooseOption(option.optionId));
    options.append(button);
  });
  section.append(options);
  return section;
}

/* ------------------------------------------------------------------ */
/* 啟動                                                                */
/* ------------------------------------------------------------------ */

function renderBootError(message: string): void {
  alertText = message;
  const shell = element("main", "p3e-shell");
  shell.dataset["p3eLive"] = "false";
  shell.dataset["p3ePhase"] = "error";
  shell.dataset["p3eCopyKeys"] = String(eventCopyKeys);
  // GPT-0025-D：文案字典驗證失敗時，明確告訴玩家發生什麼事，
  // 且停在這裡不進遊戲，避免任何 internal key 被當成文字顯示。
  const heading = element("p", "p3e-alert", "遊戲啟動失敗：必要的事件文案載入或驗證未通過。為了不讓畫面出現內部代碼，人生還沒有開始。請重新整理頁面再試一次。");
  heading.id = "p3e-boot-error";
  heading.setAttribute("role", "alert");
  heading.setAttribute("aria-live", "assertive");
  // 詳細資訊也轉成口語中文：不把 E_XXX 或 HTTP 狀態這類技術代碼丟給玩家。
  const friendlyDetail = message
    .replace(/^E_[A-Z0-9_]+[:：]\s*/, "")
    .replace(/^fixture fetch failed:\s*\d+/i, "資料下載失敗")
    .trim();
  const detail = element(
    "p",
    "p3e-boot-error-detail",
    friendlyDetail === "" ? "請檢查網路連線後再試一次。" : friendlyDetail
  );
  shell.append(element("h1", undefined, "人生模擬"), heading, detail);
  app.replaceChildren(shell);
}

/**
 * 啟動：先決定 seed，再決定「恢復存檔」或「出生卡」。
 *
 * 順序（訂單第 1、2、7、8、9 項）：
 *
 * 1. `?seed=` → 固定測試；
 * 2. UI 自有 active seed → reload 回到同一段人生；
 * 3. 都沒有 → 先用 `DEFAULT_SEED` 嘗試恢復上一版存檔，成功就補寫 active seed；
 * 4. 仍然沒有存檔 → 出生卡（新的安全隨機 seed），不建立 session；
 *    golden 決定性流程請用 `?seed=p3e-166-playable-runtime-v4` 開頁；
 * 5. 有存檔 → 正式 restore（degrade：壞存檔不刪、顯示恢復動作）。
 *
 * 任何 restore 失敗都沿用既有保護：`persistenceEnabled = false`，不覆寫原存檔，
 * 並顯示「清除存檔並重新開始」；儲存不可用時全程 ephemeral。
 */
async function boot(): Promise<void> {
  try {
    world = await loadWorld();
    storage = acquireStorage();
    const pinned = readPinnedSeed();
    const stored = readActiveSeed();
    const knownSeed = pinned ?? stored;

    if (storage === null) {
      // 儲存不可用：可預覽、可玩的暫時性命＋非阻塞警告（ephemeral）。
      persistenceStatus = "unavailable";
      persistenceEnabled = false;
      showBirth(knownSeed ?? randomSeed());
      return;
    }

    if (knownSeed === null) {
      // 沒有 active seed：先嘗試用舊常數恢復上一版存檔（相容舊玩家）。
      let restored: P3EPlaySession | null = null;
      try {
        restored = restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: DEFAULT_SEED });
      } catch (error) {
        persistenceStatus = "restore-error";
        persistenceError = describeError(error);
        recoveryNeeded = true;
        persistenceEnabled = false;
        activeSeed = DEFAULT_SEED;
        session = startLife(DEFAULT_SEED);
        persistenceGeneration += 1;
        if (session.view.controls.canAdvanceYear) lifeClock.resume();
        else lifeClock.pause();
        render();
        return;
      }
      if (restored === null) {
        // 確認沒有舊存檔：全新使用者用安全隨機 seed 建立出生預覽
        // （只有預覽，不建立 age 0 session、不寫 autosave）。
        persistenceStatus = "missing";
        showBirth(randomSeed());
        return;
      }
      activeSeed = DEFAULT_SEED;
      writeActiveSeed(DEFAULT_SEED);
      session = restored;
      persistenceGeneration += 1;
      savedGeneration = persistenceGeneration;
      persistenceStatus = "restored";
      if (session.view.controls.canAdvanceYear) lifeClock.resume();
      else lifeClock.pause();
      render();
      return;
    }

    activeSeed = knownSeed;
    writeActiveSeed(knownSeed);
    try {
      const restored = restoreP3EBrowserAutosaveSession({
        storage,
        world,
        masterSeed: knownSeed
      });
      if (restored === null) {
        // 有 active seed 但還沒有存檔（例如出生卡階段 reload）：回到同一張卡。
        persistenceStatus = "missing";
        showBirth(knownSeed);
        return;
      }
      session = restored;
      persistenceGeneration += 1;
      savedGeneration = persistenceGeneration;
      persistenceStatus = "restored";
    } catch (error) {
      // 壞存檔／版本／seed／replay 不符：不刪除、不覆寫，要求明確恢復。
      persistenceStatus = "restore-error";
      persistenceError = describeError(error);
      recoveryNeeded = true;
      persistenceEnabled = false;
      session = startLife(knownSeed);
      persistenceGeneration += 1;
    }
    if (session.view.controls.canAdvanceYear) lifeClock.resume();
    else lifeClock.pause();
    render();
  } catch (error) {
    renderBootError(describeError(error));
  }
}

// 離開頁面／切到背景時盡力同步 flush 最新 session（不阻塞正常路徑）。
window.addEventListener("pagehide", () => flushAutosaveNow());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushAutosaveNow();
});

void boot();
