import "./style.css";
import { takeGameHandoff, type GameHandoff } from "./p3e-game-bridge.js";
import {
  clearP3EBrowserAutosaveSession,
  completeP3EBrowserWorld,
  createP3EBrowserSession,
  exportP3EBrowserPortableSave,
  prepareP3EBrowserBirthStage,
  previewP3EBrowserBirthStage,
  restoreP3EBrowserAutosaveSession,
  restoreP3EBrowserPortableSave,
  runP3EPlaySessionCommand,
  saveP3EBrowserAutosaveSession,
  P3E_LIFE_FOCUS_FIRST_AGE,
  P3E_LIFE_FOCUS_OPTIONS,
  isP3ELifeFocusId,
  p3eLifeFocusLabel,
  readP3ELifeFocus,
  type P3EBrowserBirthPreview,
  type P3EBrowserBirthStage,
  type P3EBrowserWorld,
  type P3ELifeFocusId,
  type P3EPlaySession
} from "@life-sim/application";
import { createLifeClock, type Speed } from "./p3e-time-controller.js";
import {
  createDecisionPlayIntentTracker,
  isEnteringDecision,
  type DecisionPlayIntent
} from "./p3e-play-intent.js";
import type {
  ComparisonView,
  PartnerIdentity,
  ProfileResidenceView
} from "./p3e-view-readers.js";
import { birthCountryRecords, buildBirthStageInput, loadBirthPacks } from "./p3e-birth-packs.js";

/* ------------------------------------------------------------------ */
/* GPT-WORKBUDDY-0058-B｜任務二第 6 項：遊戲專用程式的延遲 chunk         */
/* ------------------------------------------------------------------ */

/**
 * 出生卡的關鍵路徑只有 index.html → bootstrap.ts → 本模組 →
 * `p3e-birth-packs.ts`（14 個小 JSON）。下面所有遊戲專用純函式都改成
 * 經由 `ensureGameLayer()` 動態載入；Vite 會把它們（0062-B 起含完整
 * Open Peeps 全身人物常數、職業目錄、CNY 換算、國家名表、mp3 URL）
 * 拆成獨立 chunk，不會進入出生卡關鍵路徑。
 *
 * 用同名的薄 wrapper 轉發，讓既有 render／決策程式碼完全不用改呼叫點；
 * 在 layer 尚未 ready 的極端情況（不會發生，因為進入遊戲前一定 await）
 * 也只回安全的佔位值，不拋錯、不顯示 internal key。
 */
type GameLayer = typeof import("./p3e-game-layer.js");
let gameLayer: GameLayer | null = null;

async function ensureGameLayer(): Promise<GameLayer> {
  if (gameLayer === null) gameLayer = await import("./p3e-game-layer.js");
  return gameLayer;
}

const SAFE_SCENE = Object.freeze({
  playerSex: "female",
  age: 0,
  ageStage: "baby",
  lifeStage: "baby",
  residenceKind: "rural",
  hasPartner: false,
  partnerSex: null,
  partnerAge: null,
  petKind: "none",
  phase: "alive"
}) as ReturnType<GameLayer["readSceneView"]>;

function financeDisplay(value: string, minor: boolean, compact: boolean): string {
  return gameLayer === null ? "—" : gameLayer.financeDisplay(value, minor, compact);
}
function readSceneView(view: unknown): ReturnType<GameLayer["readSceneView"]> {
  return gameLayer === null ? SAFE_SCENE : gameLayer.readSceneView(view);
}
function sceneSignature(...args: Parameters<GameLayer["sceneSignature"]>): string {
  return gameLayer === null ? "" : gameLayer.sceneSignature(...args);
}
function sceneSvgDataUri(...args: Parameters<GameLayer["sceneSvgDataUri"]>): string {
  return gameLayer === null ? "" : gameLayer.sceneSvgDataUri(...args);
}
function describeSceneLayers(
  ...args: Parameters<GameLayer["describeSceneLayers"]>
): ReturnType<GameLayer["describeSceneLayers"]> {
  return gameLayer === null
    ? (Object.freeze([]) as ReturnType<GameLayer["describeSceneLayers"]>)
    : gameLayer.describeSceneLayers(...args);
}
function describeSceneParts(
  ...args: Parameters<GameLayer["describeSceneParts"]>
): ReturnType<GameLayer["describeSceneParts"]> {
  return gameLayer === null
    ? (Object.freeze([]) as ReturnType<GameLayer["describeSceneParts"]>)
    : gameLayer.describeSceneParts(...args);
}
function parseCareerDecision(
  ...args: Parameters<GameLayer["parseCareerDecision"]>
): ReturnType<GameLayer["parseCareerDecision"]> {
  return gameLayer === null ? null : gameLayer.parseCareerDecision(...args);
}
function careerListNote(...args: Parameters<GameLayer["careerListNote"]>): string {
  return gameLayer === null ? "" : gameLayer.careerListNote(...args);
}
function buildCareerOptionViews(
  ...args: Parameters<GameLayer["buildCareerOptionViews"]>
): ReturnType<GameLayer["buildCareerOptionViews"]> | null {
  return gameLayer === null ? null : gameLayer.buildCareerOptionViews(...args);
}
function readComparisonView(view: unknown, age: number): ComparisonView {
  if (gameLayer !== null) return gameLayer.readComparisonView(view, age);
  const empty = Object.freeze({ available: false, text: "—", reason: null });
  return Object.freeze({ income: empty, wealth: empty, source: "missing", note: "", basisYear: null });
}
function readProfileRelationship(
  ...args: Parameters<GameLayer["readProfileRelationship"]>
): ReturnType<GameLayer["readProfileRelationship"]> {
  return gameLayer === null ? null : gameLayer.readProfileRelationship(...args);
}
function readProfileResidence(
  ...args: Parameters<GameLayer["readProfileResidence"]>
): ReturnType<GameLayer["readProfileResidence"]> {
  return gameLayer === null ? null : gameLayer.readProfileResidence(...args);
}
function readProfileRole(
  ...args: Parameters<GameLayer["readProfileRole"]>
): ReturnType<GameLayer["readProfileRole"]> {
  return gameLayer === null ? null : gameLayer.readProfileRole(...args);
}
function zhHantCountryName(iso3: string): string {
  return gameLayer === null ? "" : gameLayer.zhHantCountryName(iso3);
}

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
/* fixtures（GPT-0058-B：兩階段載入，避免把 3MB pack 打進初始 JS）          */
/* ------------------------------------------------------------------ */

/**
 * 第一階段的 14 個 base／identity URL 在 `p3e-birth-packs.ts`；
 * events／death（含 2.61MB mortality）與 mp3 在延遲 chunk
 * `p3e-heavy-packs.ts`／`p3e-game-layer.ts`。這個模組不再持有任何
 * mortality／mp3 的字串，出生卡關鍵路徑因此不會引用它們。
 */

const DEFAULT_SEED = "p3e-166-playable-runtime-v4";
const SEED_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** application 的 autosave key（見 `p3e-browser-autosave-store`）；只用來判斷是否為回訪玩家。 */
const AUTOSAVE_PRESENCE_KEY = "life-sim:p3e:v6:autosave";
const WORLD_FAILURE_HEADING =
  "遊戲啟動失敗：完整人生資料還沒準備好。請重新整理頁面，或按下方按鈕重試一次。";
/** UI 自有的 active seed key（與 application autosave 的 `life-sim:p3e:v6:autosave` 分開）。 */
const ACTIVE_SEED_KEY = "life-sim:p3e:active-seed";

/* ------------------------------------------------------------------ */
/* GPT-0031-B：直立 HUD 與背景自然音                                    */
/* ------------------------------------------------------------------ */

/**
 * 個人財務在 16 歲以前只做「呈現保護」：HUD 顯示 `—` 並附上可存取說明。
 * 底層資料由 GPT-0031-A（application／simulation）修正，UI 不改任何公式。
 */
const PERSONAL_FINANCE_AGE = 16;
/** 自然音偏好：獨立、版本化 key，不進存檔 wire、不複製人生歷史到 localStorage。 */
const NATURE_SOUND_PREF_KEY = "life-sim:p3e:v1:nature-sound";
const NATURE_SOUND_VOLUME = 0.15;
/**
 * 以 `new URL(..., import.meta.url)` 讓 Vite 把音檔包成本機 hashed asset，
 * 執行期路徑永遠是本站，不會向 GitHub／Freesound 發請求。
 */
/** 音檔 URL 移到延遲 chunk `p3e-game-layer.ts`：出生卡關鍵路徑不引用 mp3。 */

/**
 * GPT-0036-B：官方 106 命令 golden 的「重播驗證模式」。
 *
 * 只給 browser smoke／mobile layout 的自動化重播使用：一般瀏覽器
 * `navigator.webdriver` 是 false，真人玩家無法用網址關掉必選暫停。
 * 這個模式純粹讓既有 official golden 逐位元驗證不被 UI 插入的
 * `SET_LIFE_FOCUS` 指令破壞；公開測試網址完全沒有這個參數，D 的
 * 強制暫停一律完整生效。
 */
const OFFICIAL_REPLAY =
  typeof navigator !== "undefined" &&
  navigator.webdriver === true &&
  new URLSearchParams(window.location.search).get("p3eReplay") === "official-golden";

/** focus gate 讀取「首次必選」狀態的共用判斷（decision 優先、死亡不鎖）。 */
function isFocusRequired(current: P3EPlaySession | null): boolean {
  if (current === null || OFFICIAL_REPLAY) return false;
  const state = current.state;
  if (state.phase === "pending_decision" || state.phase === "death") return false;
  if (state.age < P3E_LIFE_FOCUS_FIRST_AGE) return false;
  return readP3ELifeFocus(state.flags) === null;
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
/**
 * GPT-WORKBUDDY-0058-B：兩階段 world 準備狀態。
 *
 * - `birthStage`：第一階段（base＋identity）的公開 application handle，
 *   出生卡只需這個，不必等 2.61MB mortality；
 * - `fullWorldPromise`：第二階段的**唯一** promise；重繪／連點都共用，
 *   因此 events／death 永遠只驗證一次、JSON 請求也由 fetch cache 去重；
 * - `startPending`：玩家已按「開始人生」但世界還沒好，完成後自動開局一次；
 * - `fullWorldError`：人類可理解的失敗訊息（不顯示 internal key）。
 */
let birthStage: P3EBrowserBirthStage | null = null;
let fullWorldPromise: Promise<P3EBrowserWorld> | null = null;
let fullWorldError: string | null = null;
let startPending = false;
/** 背景準備失敗時記住「玩家本來就想開局」，重試成功後自動接續一次。 */
let retryStartIntent = false;
/**
 * GPT-WORKBUDDY-0062-B：出生卡標題列的刷新按鈕。
 * `birthRefreshPending` 是連點閘門；`birthRefreshCount` 只做可觀測診斷，
 * 不進 seed／存檔／命令，單純讓 smoke 能證明「連點只刷新一次」。
 */
let birthRefreshPending = false;
let birthRefreshCount = 0;
let session: P3EPlaySession | null = null;
/**
 * GPT-0025-D：驗證過的顯示層繁中字典（null-prototype，避免 `__proto__` 之類
 * 的 key 透過原型鏈查到非字串值）。`loadWorld()` 成功後才有值；
 * 驗證失敗會直接讓 boot 顯示啟動錯誤，不會默默降到 internal key。
 */
let eventCopy: Readonly<Record<string, string>> | null = null;
let eventCopyKeys = 0;
/** GPT-0040-B：國家注册表記錄（loadWorld 成功後才有值），用來查「目前居住」的繁中國名與旗幟。 */
let countryRegistry: ReadonlyArray<Readonly<Record<string, unknown>>> = [];
/**
 * GPT-0031-B：漢堡選單開合是純 UI 呈現狀態，跨 render 保留，
 * 讓「匯出／匯入存檔」與壞存檔復原在命令後仍可連續操作。
 */
let hudMenuOpen = false;
/**
 * 重心選擇面板的呈現狀態（純 UI，不進存檔、不產生 command）：
 * null＝交給系統判斷（7 歲首次進入可操作階段時自動展開一次）、
 * true＝玩家主動展開、false＝玩家按「先不改」收起。
 */
let focusPickerOpen: boolean | null = null;
let busy = false;
let focusAdvanceAfterRender = false;
let fastForwarding = false;
/** GPT-0037-B P2：必選 dialog 是否正在顯示，用來在關閉時把焦點送回遊戲控制。 */
let focusDialogWasOpen = false;

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

/**
 * GPT-0031-B：自然音完全屬於 UI 呈現層，不進 session、不進存檔、不進 replay。
 * - `enabled`：版本化 localStorage 偏好，第一次使用預設 true；
 * - `armed`：玩家已按「開始人生」／做過有效操作（或親自按開關），才允許建立 Audio；
 * - `blocked`：瀏覽器擋下自動播放時不報錯，按鈕改成「可再按一次開啟」；
 * - `requested`：Audio 元素已建立並設好本機 src（供 headless 驗收請求時機）。
 */
let natureSoundEnabled = readNatureSoundPreference();
let natureSoundArmed = false;
let natureSoundBlocked = false;
let natureSoundRequested = false;
let natureSoundAudio: HTMLAudioElement | null = null;

const PORTABLE_FILENAME = "life-sim-p3e-v6.json";
const PORTABLE_MIME = "application/json";

const app: HTMLDivElement = (() => {
  const found = document.querySelector<HTMLDivElement>("#app");
  if (found === null) throw new Error("missing #app");
  return found;
})();

/** clock 狀態通知若發生在 render 內（gate 自己觸發），不要再巢狀 render 一次。 */
let suppressClockRender = false;

/**
 * GPT-0037-B P1／GPT-0038-B：進入 pending decision「之前」的播放意圖。
 *
 * decision 會為了等待玩家選擇而 `pause()`，若之後同年還要首次必選重心，
 * hold 不能再讀取這個被動暫停後的 `running=false`。這份意圖由
 * `runCommand` 在進入 decision 前擷取，並在 decision 解決後交給
 * `hold()`（或普通 decision 的續播）使用；一經取用即清空。
 *
 * 0038-B：「下一個決定」快轉過程也必須 `pause()`，所以 jump 會先用
 * `arm()` 把跳轉前的 `{ running, speed }` 預置進 tracker，進入 decision
 * 時由 `capture()` 優先繼承，而不是把快轉中的 paused 狀態誤記成手動暫停。
 * 純邏輯放在 `p3e-play-intent.ts`，可在 Node 單測裡跑完整路徑。
 */
const decisionPlayIntent = createDecisionPlayIntentTracker();

/** 只作診斷用的 dataset 字串（`none`／`playing:16`／`paused:4`）。 */
function describeIntent(intent: DecisionPlayIntent | null): string {
  return intent === null ? "none" : `${intent.resume ? "playing" : "paused"}:${intent.speed}`;
}

const lifeClock = createLifeClock({
  baseIntervalMs: 6000,
  initialSpeed: 1,
  onTick: async () => {
    if (session?.view.controls.canAdvanceYear === true) advanceYear();
    else lifeClock.pause();
  },
  onStateChange: () => {
    if (session !== null && !busy && !suppressClockRender) render();
  }
});
// 世界資料載入前先停住；boot 完成後才開始推進正式 session。
lifeClock.pause();

/** 換命／讀檔／重載時重設意圖；讀進來就是待決策時沿用「自動續播」既有行為。 */
function resetDecisionPlayIntent(current: P3EPlaySession | null): void {
  decisionPlayIntent.reset(current, lifeClock.getState().speed);
}

/** 普通 decision 解決後：只回到 decision 前的播放狀態與速度。 */
function applyDecisionPlayIntent(intent: DecisionPlayIntent): void {
  const clock = lifeClock.getState();
  if (clock.held || clock.disposed) return;
  if (clock.speed !== intent.speed) lifeClock.setSpeed(intent.speed);
  if (intent.resume) {
    if (!clock.running) lifeClock.resume();
  } else if (clock.running) {
    lifeClock.pause();
  }
}

/**
 * GPT-0036-B D：唯一的「必選重心」閘門。每次 session／phase 改變後都要同步：
 * 需要選 → 立刻 hold（clock 會記住原本播放狀態並清除計時器）；
 * 已選定或改成 pending decision → release（只回到觸發前的播放狀態）。
 *
 * GPT-0037-B P1：`holdIntent` 只由「剛解決 decision」的路徑傳入，讓 hold
 * 繼承 decision 前的播放意圖，而不是 decision 被動暫停後的 running=false。
 * GPT-0038-B：jump 直接撞上必選重心（沒有先遇到 decision）時，改繼承
 * 尚未被 capture 消費的 jump 前意圖；這份 armed 會在 jump 結束時清除。
 */
function syncFocusGate(holdIntent?: DecisionPlayIntent | null): void {
  const required = isFocusRequired(session);
  const clock = lifeClock.getState();
  if (required === (clock.held && clock.holdReason === "life-focus-required")) return;
  suppressClockRender = true;
  try {
    if (required) {
      lifeClock.hold(
        "life-focus-required",
        holdIntent ?? decisionPlayIntent.peekArmed() ?? undefined
      );
    } else if (clock.held && clock.holdReason === "life-focus-required") lifeClock.release();
  } finally {
    suppressClockRender = false;
  }
}

/** boot／開始人生／讀檔後統一決定 clock，避免「偷跑一年」或無條件 resume。 */
function syncClockAfterSession(): void {
  resetDecisionPlayIntent(session);
  syncFocusGate();
  if (!lifeClock.getState().held && session !== null && session.view.controls.canAdvanceYear) {
    lifeClock.resume();
  } else {
    lifeClock.pause();
  }
}

/** held 時只允許設定重心；其他指令一律不進 engine（包含鍵盤、計時器、快轉）。 */
function isSetLifeFocusCommand(command: unknown): boolean {
  return isPlainRecord(command) && command["type"] === "SET_LIFE_FOCUS";
}

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

/* GPT-WORKBUDDY-0054-B：顯示層固定 1 USD = 7.2 CNY（見 p3e-cny.ts）。
   內部 microUsd 與百分位演算法完全不動；這裡只把「要畫到 DOM 的字串」換成 CNY。
   GPT-0032-B 的萬／億縮寫保留（量級不失真），完整值仍放在 title／aria-label。
   未成年「—」與換算都集中在 financeDisplay，避免在 DOM 分支各自漏接。 */

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
/* GPT-0031-B｜背景自然音                                               */
/* ------------------------------------------------------------------ */

/** 第一次使用預設 true；localStorage 不可用也不影響遊戲。 */
function readNatureSoundPreference(): boolean {
  try {
    const raw = window.localStorage.getItem(NATURE_SOUND_PREF_KEY);
    if (raw === "off") return false;
    if (raw === "on") return true;
  } catch {
    // 隱私模式／配額限制：偏好只降級成「每次預設開啟」，不報錯。
  }
  return true;
}

function writeNatureSoundPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(NATURE_SOUND_PREF_KEY, enabled ? "on" : "off");
  } catch {
    // 偏好保存失敗不影響自動存檔、遊戲時鐘或任何按鈕。
  }
}

/** 「看起來是開啟」＝偏好開啟且沒有被瀏覽器擋下。 */
function natureSoundOn(): boolean {
  return natureSoundEnabled && !natureSoundBlocked;
}

/**
 * 只在 `armed` 之後建立 Audio 元素並設定本機 src。
 * `preload="none"` 讓首頁／出生卡完全不下載音檔；`loop` 直接沿用上游
 * 已做好的無縫循環。
 */
function createNatureSoundAudio(): HTMLAudioElement {
  const audio = new Audio();
  audio.preload = "none";
  audio.loop = true;
  audio.volume = NATURE_SOUND_VOLUME;
  // 只有進入遊戲（game layer 已載入）後才可能走到這裡；不讓空 src 觸發請求。
  if (gameLayer !== null) audio.src = gameLayer.NATURE_SOUND_URL;
  audio.addEventListener("play", syncNatureSoundDom);
  audio.addEventListener("pause", syncNatureSoundDom);
  natureSoundRequested = true;
  natureSoundAudio = audio;
  return audio;
}

/** 把音訊狀態寫到根節點，讓 headless 也能驗證狀態而不必真的輸出聲音。 */
function writeNatureSoundDataset(shell: HTMLElement | null): void {
  if (shell === null) return;
  const audio = natureSoundAudio;
  shell.dataset["p3eAudioEnabled"] = String(natureSoundEnabled);
  shell.dataset["p3eAudioBlocked"] = String(natureSoundBlocked);
  shell.dataset["p3eAudioArmed"] = String(natureSoundArmed);
  shell.dataset["p3eAudioRequested"] = String(natureSoundRequested);
  shell.dataset["p3eAudioPlaying"] = String(audio !== null && !audio.paused);
  shell.dataset["p3eAudioVolume"] = String(audio?.volume ?? NATURE_SOUND_VOLUME);
  shell.dataset["p3eAudioTime"] = String(audio?.currentTime ?? 0);
  shell.dataset["p3eAudioPreload"] = audio?.preload ?? "none";
  shell.dataset["p3eAudioLoop"] = String(audio?.loop ?? true);
  shell.dataset["p3eAudioSrc"] = natureSoundRequested ? "local" : "none";
}

/** 只更新按鈕與 dataset，不重建整個畫面（避免昂貴的同步版面計算）。 */
function syncNatureSoundDom(): void {
  const shell = app.querySelector<HTMLElement>("[data-p3e-live]");
  writeNatureSoundDataset(shell);
  const button = shell?.querySelector<HTMLButtonElement>('[data-action="toggle-nature-sound"]') ?? null;
  if (button === null) return;
  const on = natureSoundOn();
  const label = on ? "關閉自然音" : "開啟自然音";
  button.textContent = on ? "🔊" : "🔇";
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(on));
  button.title = label;
  button.dataset["p3eAudio"] = on ? "on" : "off";
}

function startNatureSound(): void {
  if (!natureSoundArmed || !natureSoundEnabled) return;
  natureSoundBlocked = false;
  try {
    const audio = natureSoundAudio ?? createNatureSoundAudio();
    const pending = audio.play();
    if (typeof pending?.catch === "function") {
      void pending.catch(() => {
        // 手機瀏覽器擋自動播放：不報錯、不卡住遊戲，按鈕改成可再按一次開啟。
        natureSoundBlocked = true;
        syncNatureSoundDom();
      });
    }
  } catch {
    natureSoundBlocked = true;
  }
  syncNatureSoundDom();
}

/** 玩家按「開始人生」或第一次有效操作後才允許載入／播放音檔。 */
function armNatureSound(): void {
  if (natureSoundArmed) return;
  natureSoundArmed = true;
  startNatureSound();
}

function pauseNatureSound(): void {
  const audio = natureSoundAudio;
  if (audio !== null) {
    try {
      audio.pause(); // 不重置 currentTime，再開啟時從剛才的位置繼續。
    } catch {
      // 音效失敗不影響任何遊戲行為。
    }
  }
  syncNatureSoundDom();
}

function toggleNatureSound(): void {
  if (natureSoundOn()) {
    natureSoundEnabled = false;
    writeNatureSoundPreference(false);
    pauseNatureSound();
  } else {
    natureSoundEnabled = true;
    natureSoundBlocked = false;
    writeNatureSoundPreference(true);
    natureSoundArmed = true;
    startNatureSound();
  }
}

/* ------------------------------------------------------------------ */
/* GPT-0031-B｜人生紀錄（相容型 type guard，不修改 application 型別）    */
/* ------------------------------------------------------------------ */

interface LifeLogEntryLike {
  readonly year: number;
  readonly age: number;
  readonly kind: string;
  readonly ids: readonly string[];
  /** GPT-0040-B：具體挫折／小確幸變體 ID（p3b.detail.<kind>.<stage>.<1..4>），無則 null。 */
  readonly detailId: string | null;
}

/**
 * GPT-0040-B：detailId 格式守門。DEEPSEEK-0040-A 的 32 條 ID 皆是此形，
 * 但這裡只用格式守門，不依賴 application 匯出（UI 不重算、不洩漏）。
 */
const DETAIL_ID_RE =
  /^p3b\.detail\.(setback|small-win)\.(childhood|adolescence|adulthood|later_life)\.[1-4]$/;

/** 文案若仍含此類內部鍵模式，視為不安全，退回泛稱。 */
const COPY_INTERNAL_KEY_PATTERN = /(?:p3[ab]\.|ev\.|focus:|E_[A-Z0-9_]+|SET_LIFE_FOCUS|microUsd)/;

/** projection 可能把公開 ID 放在不同欄位；全部以白名單讀取，絕不列印未知欄位。 */
const LIFE_LOG_ID_KEYS = [
  "eventId",
  "selectedEventId",
  "optionId",
  "selectedOptionId",
  "decisionId",
  "focusId",
  "causeId",
  "publicId",
  "labelKey",
  "titleId",
  "copyId",
  "id"
] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readLifeLogEntry(raw: unknown): LifeLogEntryLike | null {
  if (!isPlainRecord(raw)) return null;
  const year = raw["year"];
  const age = raw["age"];
  if (!isFiniteNumber(year) || !isFiniteNumber(age)) return null;
  const kind = typeof raw["kind"] === "string" ? raw["kind"] : "advance_year";
  const ids: string[] = [];
  for (const key of LIFE_LOG_ID_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  }
  const nested = raw["ids"];
  if (Array.isArray(nested)) {
    for (const value of nested) {
      if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
    }
  }
  const detailRaw = raw["detailId"];
  const detailId = typeof detailRaw === "string" && DETAIL_ID_RE.test(detailRaw) ? detailRaw : null;
  return { year, age, kind, ids, detailId };
}

/**
 * GPT-0040-B：detailId → 顯示層字典的具體文案。
 * 字典找不到、ID 非法或文案仍含 internal key 時回 null，改走泛稱 fallback，
 * 絕不直接把 detailId 顯示給玩家。
 */
function detailCopyFor(detailId: string): string | null {
  const copy = eventCopy === null ? undefined : eventCopy[detailId];
  if (typeof copy !== "string" || copy.trim().length === 0) return null;
  if (COPY_INTERNAL_KEY_PATTERN.test(copy)) return null;
  return copy;
}

/**
 * 安全讀取可選 `view.lifeLog`。GPT-0031-A 尚未落地時回傳 null，
 * UI 會回退到最後一個 outcome；正式 projection 上線後不需改 UI。
 */
function readLifeLog(view: P3EPlaySession["view"]): readonly LifeLogEntryLike[] | null {
  const source: unknown = (view as unknown as Record<string, unknown>)["lifeLog"];
  if (!Array.isArray(source) || source.length === 0) return null;
  const entries: LifeLogEntryLike[] = [];
  for (const raw of source) {
    const entry = readLifeLogEntry(raw);
    if (entry !== null) entries.push(entry);
  }
  if (entries.length === 0) return null;
  // 官方 projection 可「最新在前」或「明確順序」；這裡統一一律最新在上。
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first !== undefined && last !== undefined && first.year < last.year) entries.reverse();
  return entries.slice(0, 256);
}

/** 缺少 projection 的過渡期：用既有 lastOutcome 組出單條紀錄，仍不露內部 ID。 */
function fallbackLifeLog(current: P3EPlaySession): readonly LifeLogEntryLike[] {
  const last = current.lastOutcome;
  if (last === null) return [];
  const year = current.view.currentYear;
  const age = current.view.age;
  if (last.kind === "advance_year") {
    if (last.death !== null) return [{ year, age, kind: "death", ids: [], detailId: null }];
    return [{ year, age, kind: "advance_year", ids: last.selectedEventId === null ? [] : [last.selectedEventId], detailId: null }];
  }
  if (last.kind === "choose_decision") {
    return [{ year, age, kind: "choose_decision", ids: [friendlyChosenOption(last)], detailId: null }];
  }
  return [{ year, age, kind: "set_life_focus", ids: [last.focusId], detailId: null }];
}

/** 只接受字典查得到的自然中文；查不到就回 null，絕不外洩 internal key。 */
function firstFriendlyLabel(ids: readonly string[]): string | null {
  for (const id of ids) {
    const label = friendlyKey(id);
    if (label !== "人生的一段插曲" && label !== "平凡的一年" && label.length > 0) return label;
  }
  return null;
}

/**
 * 公開 ID → 專案既有繁中名稱。相容 GPT-0031-A 的
 * `birth | year | event | decision | focus | death` 六種 kind，
 * 也相容舊 `advance_year | choose_decision | set_life_focus` 命名。
 */
function lifeLogText(entry: LifeLogEntryLike): string {
  // GPT-0040-B：優先顯示具體變體文案（detailId → 字典），不再顯示泛稱。
  // 缺少 detailId 的舊存檔會自然落到下方泛稱 fallback。
  if (entry.detailId !== null) {
    const copy = detailCopyFor(entry.detailId);
    if (copy !== null) return copy;
  }
  const kind = entry.kind.toLowerCase();
  // 過渡期回退會直接放入已翻譯好的中文（不是 internal key）。
  const natural = entry.ids.find((id) => /[\u3400-\u9fff]/.test(id));
  if (natural !== undefined) {
    return kind.includes("decision") || kind.includes("choice") || kind.includes("option")
      ? `做出了選擇：${natural}`
      : natural;
  }
  if (kind.includes("death") || kind === "end") return "這段人生走到了終點";
  if (kind === "birth") return "出生，人生故事正要開始";
  if (kind === "year") return "平安的一年";
  if (kind.includes("focus")) {
    for (const id of entry.ids) {
      if (isP3ELifeFocusId(id)) return `把人生重心放在${p3eLifeFocusLabel(id, entry.age)}`;
    }
    return "調整了人生重心";
  }
  if (kind.includes("decision") || kind.includes("choice") || kind.includes("option")) {
    // 決策紀錄優先組回 `p3b.option.<event>.<option>` 的繁中選項名稱。
    const eventId = entry.ids.find((id) => id.startsWith("ev."));
    const optionId = entry.ids.find((id) => /^[a-z0-9][a-z0-9_-]{0,23}$/i.test(id));
    if (eventId !== undefined && optionId !== undefined) {
      const composed = `p3b.option.${eventId.replace(/^ev\./, "")}.${optionId}`;
      const label = friendlyKey(composed);
      if (label !== "人生的一段插曲" && label !== "平凡的一年") return `做出了選擇：${label}`;
    }
    const label = firstFriendlyLabel(entry.ids.filter((id) => id.startsWith("ev.")));
    return label === null ? "做出了當時的選擇" : `做出了選擇：${label}`;
  }
  const eventIds = entry.ids.filter((id) => id.startsWith("ev."));
  return firstFriendlyLabel(eventIds.length > 0 ? eventIds : entry.ids) ?? "平凡的一年";
}

function renderLifeLog(current: P3EPlaySession, partner: PartnerIdentity | null): HTMLElement {
  const projection = readLifeLog(current.view);
  const entries = projection ?? fallbackLifeLog(current);
  const section = element("section", "p3e-life-log");
  const birthYear = current.view.currentYear - current.view.age;
  section.setAttribute("aria-label", "人生紀錄");
  section.dataset["p3eLifeLogSource"] = projection === null ? "fallback" : "projection";
  section.dataset["p3eLifeLogCount"] = String(entries.length);
  if (entries.length === 0) {
    section.append(element("p", "p3e-life-log-empty", `${current.view.currentYear} 年，你的人生故事正要開始。`));
    return section;
  }
  const list = element("ol", "p3e-life-log-list");
  let partnerNamed = false;
  for (const entry of entries) {
    let text = lifeLogText(entry);
    // GPT-0036-B C：關係建立當年的訊息必須帶入具名伴侶；全部走 textContent。
    if (
      partner !== null && !partnerNamed &&
      partner.sinceYear === entry.year &&
      !text.includes(partner.displayName)
    ) {
      text = `${text} · 與${partner.displayName}開始交往`;
      partnerNamed = true;
    }
    const item = element("li", "p3e-life-log-entry");
    item.dataset["p3eLifeLogYear"] = String(entry.year);
    item.dataset["p3eLifeLogAge"] = String(entry.age);
    item.dataset["p3eLifeLogText"] = text;
    if (text.includes(partner?.displayName ?? "\u0000")) item.dataset["p3eLifeLogPartner"] = "true";
    item.append(
      element("span", "p3e-life-log-when", `${entry.year} 年 · ${entry.age} 歲`),
      element("span", "p3e-life-log-sep", "｜"),
      element("span", "p3e-life-log-text", text)
    );
    list.append(item);
  }
  if (partner !== null && !partnerNamed && partner.sinceYear !== null) {
    // projection 節錄後沒有留下當年紀錄時，仍補一筆具名關係訊息。
    const item = element("li", "p3e-life-log-entry");
    const text = `與${partner.displayName}開始交往`;
    item.dataset["p3eLifeLogYear"] = String(partner.sinceYear);
    item.dataset["p3eLifeLogAge"] = String(partner.sinceYear - birthYear);
    item.dataset["p3eLifeLogText"] = text;
    item.dataset["p3eLifeLogPartner"] = "true";
    item.append(
      element("span", "p3e-life-log-when", `${partner.sinceYear} 年`),
      element("span", "p3e-life-log-sep", "｜"),
      element("span", "p3e-life-log-text", text)
    );
    list.prepend(item);
  }
  section.append(list);
  return section;
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
        resetDecisionPlayIntent(session);
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
    resetDecisionPlayIntent(session);
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
/* 資料載入（GPT-0058-B：兩階段 + 請求去重）                              */
/* ------------------------------------------------------------------ */

/** 把技術錯誤轉成玩家看得懂的一句話，不印出 internal key／HTTP 代碼。 */
function friendlyWorldError(error: unknown): string {
  const raw = describeError(error);
  if (raw.startsWith("fixture fetch failed") || raw.includes("Failed to fetch")) {
    return "人生資料下載失敗，請檢查網路後重試。";
  }
  if (raw.includes("E_P3E_COPY_PACK") || raw.includes("p3b-copy")) {
    return "事件文案資料不完整，請重新載入一次。";
  }
  return "人生資料還沒準備好，請稍後重試。";
}

function isCopyBootError(error: unknown): boolean {
  return error instanceof Error && error.name === "CopyBootError";
}

function markCopyBootError(): Error {
  // 固定口語中文，不把底層錯誤碼／HTTP 狀態／internal key 帶到畫面。
  const wrapped = new Error("E_P3E_COPY_PACK：事件文案資料載入或驗證未通過，請重新整理頁面再試一次。");
  wrapped.name = "CopyBootError";
  return wrapped;
}

/**
 * 第二階段：events＋death 背景載入 → 驗證 → 產生正式 world。
 *
 * - 只會有一個 promise（`fullWorldPromise`）；連點／重繪／reroll 都共用；
 * - 所有 JSON 請求走 `loadJsonCached`，2.61MB mortality 永遠只下載一次；
 * - 同時預先載入遊戲層 chunk，讓「開始人生」不需再等一次網路；
 * - 驗證失敗不留半套 world，但**出生卡仍然可看**，並提供重試。
 */
async function ensureFullWorld(): Promise<P3EBrowserWorld> {
  if (world !== null) return world;
  if (fullWorldPromise !== null) return fullWorldPromise;
  const stage = birthStage;
  if (stage === null) throw new Error("birth stage not ready");

  const pending = (async (): Promise<P3EBrowserWorld> => {
    const gamePromise = ensureGameLayer();
    const heavyModule = await import("./p3e-heavy-packs.js");
    const heavy = await heavyModule.loadHeavyPacks();

    const events = heavy.p3bEvents as { records: unknown[]; contentPackVersion?: unknown } | null;
    const p3bManifest = heavy.p3bManifest as { contentPackVersion?: unknown } | null;
    // GPT-0025-D：字典必須與 events／manifest 的 contentPackVersion 一致。
    const packVersion = p3bManifest?.contentPackVersion;
    if (
      typeof packVersion !== "string" ||
      packVersion.length === 0 ||
      events?.contentPackVersion !== packVersion
    ) {
      throw markCopyBootError();
    }
    let validatedCopy: Readonly<Record<string, string>>;
    try {
      validatedCopy = validateEventCopy(heavy.p3bEventCopy, packVersion);
    } catch {
      throw markCopyBootError();
    }
    eventCopy = validatedCopy;
    eventCopyKeys = Object.keys(validatedCopy).length;

    const packs = heavyModule.buildCompleteWorldPacks(heavy);
    const completed = completeP3EBrowserWorld({
      stage,
      events: packs.events,
      death: packs.death
    });
    await gamePromise;
    world = completed;
    fullWorldError = null;
    // 出生卡還在畫面上：重繪一次，讓 copyKeys／world-stage dataset 跟上。
    if (session === null && birthPreview !== null && !startPending) renderBirth();
    return completed;
  })();

  fullWorldPromise = pending;
  try {
    return await pending;
  } catch (error) {
    // 清掉失敗的 world promise 才能重試；JSON 快取仍保留已成功的部分。
    fullWorldPromise = null;
    fullWorldError = friendlyWorldError(error);
    throw error;
  }
}

/** 背景準備失敗：文案字典錯誤沿用既有啟動錯誤頁，其餘留在出生卡並給重試。 */
function onWorldFailure(error: unknown): void {
  fullWorldError = friendlyWorldError(error);
  retryStartIntent = retryStartIntent || startPending;
  startPending = false;
  if (isCopyBootError(error)) {
    renderBootError(describeError(error));
    return;
  }
  if (session === null && birthPreview !== null) {
    renderBirth();
    return;
  }
  // 回訪玩家還在骨架階段：顯示可理解的錯誤頁與重試按鈕。
  if (session === null) renderBootError(fullWorldError, WORLD_FAILURE_HEADING);
}

/** 重試按鈕：不重新建立 session，只重跑第二階段（成功後才繼續原本的開局意圖）。 */
function retryWorld(): void {
  if (busy) return;
  const seed = birthSeed;
  const wantsStart = retryStartIntent || startPending;
  retryStartIntent = false;
  fullWorldError = null;
  fullWorldPromise = null;
  startPending = false;
  if (session === null && birthPreview !== null && seed !== null) renderBirth();
  void ensureFullWorld()
    .then(() => {
      if (session !== null) return;
      if (wantsStart && seed !== null && birthPreview !== null) {
        beginLife(seed);
        return;
      }
      // 沒有出生卡（回訪玩家停在骨架／錯誤頁）：重新走一次啟動決策來 restore。
      void boot();
    })
    .catch(onWorldFailure);
}

/** GPT-0065-A：可觀測的 session 建立次數；連點「開始人生」只會是 1。 */
function markSessionCreated(): void {
  const root = document.documentElement;
  root.dataset["p3eSessionCount"] = String(Number(root.dataset["p3eSessionCount"] ?? "0") + 1);
}

function startLife(seed: string): P3EPlaySession {
  if (world === null) throw new Error("world not ready");
  const created = createP3EBrowserSession({ world, masterSeed: seed });
  markSessionCreated();
  return created;
}

/* ------------------------------------------------------------------ */
/* 出生卡（GPT-0017-D）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 顯示出生卡：用 application 公開的**第一階段** API
 * `previewP3EBrowserBirthStage`（與正式開局逐位元一致）產生資料，
 * **不建立 session**、不等 mortality、clock 保持暫停。
 */
function showBirth(seed: string): void {
  const stage = birthStage;
  if (stage === null) throw new Error("birth stage not ready");
  birthSeed = seed;
  activeSeed = seed;
  writeActiveSeed(seed);
  birthPreview = previewP3EBrowserBirthStage({ stage, masterSeed: seed });
  session = null;
  // 回到出生卡時解除上一條命可能還在的必選暫停，clock 仍保持暫停。
  resetDecisionPlayIntent(null);
  focusDialogWasOpen = false;
  syncFocusGate();
  lifeClock.pause();
  renderBirth();
}

/** 重新抽取（底部次要動作）：換一個真正隨機的 seed，整張出生卡一起更新。 */
function rerollBirth(): void {
  if (busy || birthStage === null) return;
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

/** `aria-live` 宣告：放在 #app 外，卡片重繪不會把 live region 一起拆掉。 */
function announceBirthRefresh(count: number): void {
  let node = document.getElementById("p3e-birth-announcer");
  if (node === null) {
    node = document.createElement("div");
    node.id = "p3e-birth-announcer";
    node.className = "sr-only";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.append(node);
  }
  // 帶次數可讓連續兩次刷新都真的被 screen reader 宣告（內容不同）。
  node.textContent = `已刷新出生，第 ${count} 次`;
}

/**
 * GPT-WORKBUDDY-0062-B｜出生卡標題列的「↻ 刷新出生」。
 *
 * - 只呼叫 `showBirth(randomSeed())`：重新抽 seed 與第一階段出生預覽，
 *   **不重載頁面、不重新下載任何 pack、不建立 session**；
 * - 連點由 `birthRefreshPending`＋`disabled` 雙閘門擋住；
 * - 先畫出短暫可見的「刷新中…」狀態，再在下一幀重繪；
 * - 完成後把焦點放回新的刷新按鈕，並用 aria-live 宣告。
 */
function refreshBirth(source: HTMLButtonElement): void {
  if (busy || birthRefreshPending || birthStage === null) return;
  birthRefreshPending = true;
  source.disabled = true;
  source.dataset["p3eRefreshState"] = "loading";
  const label = source.querySelector<HTMLElement>(".p3e-birth-refresh-label");
  if (label !== null) label.textContent = "刷新中…";
  window.setTimeout(() => {
    try {
      alertText = null;
      birthRefreshCount += 1;
      showBirth(randomSeed());
      announceBirthRefresh(birthRefreshCount);
      document.querySelector<HTMLButtonElement>('[data-action="refresh-birth"]')
        ?.focus({ preventScroll: true });
    } catch (error) {
      showAlert(describeError(error));
      renderBirth();
    } finally {
      birthRefreshPending = false;
    }
  }, 120);
}

/**
 * 開始人生（GPT-0058-B 狀態機）：
 * - 完整世界已 ready → 立刻開局；
 * - 尚未完成 → 按鈕顯示「準備人生…」，完成後**自動開局一次**；
 * - 連點不會建立第二個 session（`startPending` + `session !== null` 雙閘門）；
 * - 失敗 → 出生卡顯示人類可理解訊息與重試按鈕；
 * - 失敗後再按「開始人生」一律視為**明確重試**，統一走 `retryWorld()`，
 *   不會在錯誤訊息尚未清除時暗中再起一份 world promise。
 */
function startLifeFromCard(): void {
  const seed = birthSeed;
  if (busy || seed === null || session !== null) return;
  if (fullWorldError !== null) {
    retryWorld();
    return;
  }
  if (world === null) {
    if (startPending) return;
    startPending = true;
    renderBirth();
    void ensureFullWorld()
      .then(() => {
        if (startPending && session === null) beginLife(seed);
      })
      .catch(onWorldFailure);
    return;
  }
  beginLife(seed);
}

/** 真正建立 age 0 session；整个流程只允許執行一次。 */
function beginLife(seed: string): void {
  if (session !== null || world === null) return;
  startPending = false;
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
    // 明確的使用者手勢：現在才允許建立 Audio 並請求本機音檔。
    armNatureSound();
    syncClockAfterSession();
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
 * `data-action="refresh-birth"`（0062-B 標題列主要刷新）、
 * `data-action="reroll-birth"`（弱化的底部次要動作）、`data-action="start-life"`，
 * 並在畫面根節點掛 `data-p3e-live`／`data-p3e-phase`／`data-p3e-birth-seed`
 * ／`data-p3e-refresh-count` 等診斷屬性。
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
  screen.dataset["p3eRefreshCount"] = String(birthRefreshCount);
  screen.dataset["p3ePersistenceStatus"] = persistenceStatus;
  screen.dataset["p3ePersistenceError"] = persistenceError ?? "";
  // GPT-0058-B：讓 smoke／網路攔截測試能直接觀察兩階段載入狀態。
  const worldStage = fullWorldError !== null
    ? "error"
    : world !== null ? "ready" : startPending ? "preparing" : "loading";
  screen.dataset["p3eWorldStage"] = worldStage;
  screen.dataset["p3eWorldError"] = fullWorldError ?? "";

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
  refresh.addEventListener("click", () => refreshBirth(refresh));
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
  reroll.addEventListener("click", rerollBirth);
  // 世界還在背景準備時顯示「準備人生…」；失敗時另有明確的重試按鈕。
  const start = element(
    "button",
    "p3e-primary",
    startPending ? "準備人生…" : fullWorldError !== null ? "重試並開始人生" : "開始人生"
  );
  start.type = "button";
  start.dataset["action"] = "start-life";
  start.disabled = startPending;
  start.addEventListener("click", startLifeFromCard);
  actions.append(reroll, start);
  if (fullWorldError !== null) {
    const retry = element("button", "p3e-primary", "重試載入");
    retry.type = "button";
    retry.dataset["action"] = "retry-world";
    retry.addEventListener("click", retryWorld);
    actions.append(retry);
  }
  const status = element(
    "p",
    "p3e-world-status",
    fullWorldError !== null
      ? fullWorldError
      : startPending
        ? "正在準備完整人生資料，完成後會自動開始。"
        : world !== null
          ? "人生資料已準備完成。"
          : "正在背景準備人生資料，出生資料已可查看。"
  );
  status.dataset["p3eWorldStatus"] = worldStage;
  status.setAttribute("role", "status");

  card.append(hero, grid, story, status, actions);
  screen.append(card);
  app.replaceChildren(screen);
  // 出生卡階段也可以觀察音訊狀態，但這裡完全不建立 Audio、不下載音檔。
  writeNatureSoundDataset(screen);
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

function runCommand(command: unknown, focusHoldIntent?: DecisionPlayIntent | null): void {
  if (session === null || busy) return;
  // GPT-0036-B D：這是真正的硬閘門，不是視覺遮罩。即使有人直接呼叫
  // advanceYear()、用鍵盤觸發按鈕或讓 clock tick，指令也進不了 engine。
  if (lifeClock.getState().held && !isSetLifeFocusCommand(command)) return;
  // GPT-0037-B P1：在 decision 造成的 pause() 之前擷取「是否播放」與速度。
  const phaseBefore = session.view.phase;
  const clockBefore = lifeClock.getState();
  busy = true;
  setControlsDisabled(true);
  try {
    const result = runP3EPlaySessionCommand({ session, command });
    session = result.session;
    if (isEnteringDecision(phaseBefore, session.view.phase)) {
      decisionPlayIntent.capture(clockBefore);
    }
    // 每次命令後重新判断必選閘門：SET_LIFE_FOCUS 會 release，
    // 第一次推進到 7 歲則會 hold（並記住原本播放狀態）。
    syncFocusGate(focusHoldIntent);
    // 從舊存檔直接進遊戲時，第一個成功命令也算「第一次有效操作」。
    armNatureSound();
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

/**
 * GPT-0038-B：「下一個決定」是使用者指定的主要玩法。
 *
 * 快轉本身必須暫停逐年推進（不讓計時器並行偷跑），但這會讓 `runCommand`
 * 在進入 pending decision 時看到 `running=false`。因此先在 `pause()` 之前
 * 擷取跳轉前的 `{ running, speed }` 並 `arm()` 到 decision intent tracker；
 * `capture()` 會優先繼承這份意圖。沒有找到 decision（死亡／錯誤／換命／
 * 讀檔／匯入／復原）時一律 `disarm()`，不污染下一條命。
 * 既有 command／hold 硬閘門完全保留。
 */
async function jumpToNextDecision(): Promise<void> {
  if (session === null || busy || fastForwarding || !session.view.controls.canAdvanceYear) return;
  const clockBefore = lifeClock.getState();
  if (clockBefore.held || clockBefore.disposed) return;
  decisionPlayIntent.arm({
    resume: clockBefore.running && !clockBefore.held,
    speed: clockBefore.speed
  });
  lifeClock.pause(); // 快轉期間不排程任何 tick
  fastForwarding = true;
  let foundDecision = false;
  let failed = false;
  try {
    for (let index = 0; index < 120; index += 1) {
      if (session === null || !session.view.controls.canAdvanceYear || session.view.phase === "death") break;
      advanceYear();
      if (session !== null && session.view.phase === "pending_decision") {
        foundDecision = true;
        break;
      }
      if ((index + 1) % 8 === 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
  } catch (error) {
    failed = true;
    showAlert(describeError(error));
  } finally {
    if (
      failed ||
      !foundDecision ||
      session === null ||
      session.view.phase !== "pending_decision"
    ) {
      decisionPlayIntent.disarm();
    }
    fastForwarding = false;
    render();
  }
}

function chooseOption(optionId: string): void {
  // GPT-0037-B P1：先取出「進入 decision 前」的播放意圖再解決 decision。
  // 若同年立刻進 focus-required hold，這個意圖會由 hold 繼承；
  // 若是普通 decision，則由這裡回到原本的播放狀態與速度。
  const captured = decisionPlayIntent.take();
  // 防呆：萬一沒有可繼承的意圖（例如外部替換 session），沿用既有「自動續播」，
  // 也避免 hold 誤讀 decision 被動暫停後的 running=false。
  const intent: DecisionPlayIntent = captured ?? {
    resume: true,
    speed: lifeClock.getState().speed
  };
  runCommand({ type: "CHOOSE_DECISION", optionId }, intent);
  if (session?.view.controls.canAdvanceYear === true && !lifeClock.getState().held) {
    applyDecisionPlayIntent(intent);
  }
}

/** 設定／更改人生重心：走正式 command，狀態進 state flags、存檔、replay 與 state hash。 */
function setLifeFocus(focusId: P3ELifeFocusId): void {
  focusPickerOpen = null;
  runCommand({ type: "SET_LIFE_FOCUS", focusId });
}

/** 玩家主動展開選擇面板（純 UI 呈現狀態，不是遊戲狀態）。 */
function toggleFocusPicker(): void {
  focusPickerOpen = true;
  render();
}

/** 「先不改」：收起面板且本命不再自動跳出；玩家仍可按「選擇重心」回來設定。 */
function dismissFocusPicker(): void {
  focusPickerOpen = false;
  render();
}

/**
 * GPT-0029-B：人生重心區塊。
 *
 * - 0–6 歲完全不顯示；
 * - 滿 7 歲第一次自動展開一次清楚的選擇面板，之後不再每年強迫跳出；
 * - 選定後只佔一行「目前重心：…」，另有「更改」入口；
 * - 同一模擬年已改過、待決策或死亡時，選項按鈕直接停用；
 * - 展開時是貼在 HUD 下方的固定前景卡，只有這張卡可以局部捲動；
 * - 待決策／死亡階段一律收起，避免前景卡擋住決策選項或「重新開始」。
 */
function renderFocusSection(current: P3EPlaySession): HTMLElement | null {
  const state = current.state;
  if (state.age < P3E_LIFE_FOCUS_FIRST_AGE) return null;
  const snapshot = readP3ELifeFocus(state.flags);
  const label = snapshot === null ? null : p3eLifeFocusLabel(snapshot.focusId, state.age);
  const changedThisYear = snapshot !== null && snapshot.changedYear === state.currentYear;
  const canChange = state.phase === "life" && !changedThisYear;
  // GPT-0036-B D：只要滿 7 歲且還沒設定，不論何時讀檔／reload 都是必選。
  // OFFICIAL_REPLAY 只保留給自動化重播官方 golden 指令序列。
  const required = isFocusRequired(current);
  const firstTime = snapshot === null && state.age >= P3E_LIFE_FOCUS_FIRST_AGE && !OFFICIAL_REPLAY;
  const expanded =
    state.phase === "life" &&
    (required || focusPickerOpen === true || (focusPickerOpen === null && firstTime));

  const box = element("section", "p3e-focus");
  box.setAttribute("aria-label", "人生重心");
  box.dataset["p3eFocus"] = snapshot?.focusId ?? "none";
  box.dataset["p3eFocusChangedYear"] = snapshot === null ? "" : String(snapshot.changedYear);
  box.dataset["p3eFocusExpanded"] = expanded ? "true" : "false";
  box.dataset["p3eFocusRequired"] = String(required);
  box.dataset["p3eFocusGate"] = required ? "required" : "optional";
  if (required) box.classList.add("p3e-focus-required");

  const line = element("p", "p3e-focus-current");
  if (label === null) {
    line.append(
      element(
        "span",
        undefined,
        required ? "還沒有設定人生重心，請先選擇。" : "上學了，還沒有設定人生重心。"
      )
    );
  } else {
    line.append(element("span", undefined, "目前重心："), element("strong", undefined, label));
  }
  if (!expanded) {
    const toggle = element("button", "p3e-focus-toggle", label === null ? "選擇重心" : "更改");
    toggle.type = "button";
    toggle.dataset["action"] = "toggle-focus";
    toggle.disabled = !canChange;
    toggle.addEventListener("click", toggleFocusPicker);
    line.append(toggle);
  }
  box.append(line);

  if (!expanded) {
    if (changedThisYear) box.append(element("p", "p3e-focus-note", "今年已經調整過重心，明年才能再改。"));
    return box;
  }

  const panel = element("div", "p3e-focus-panel");
  panel.setAttribute("aria-label", required ? "必選人生重心" : "調整人生重心");
  // GPT-0037-B P2：首次必選是真正的 modal dialog，讀屏要能唸出標題與說明，
  // 且開啟後鍵盤焦點必須落在可選重心而不是掉回 body。
  if (required) {
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "p3e-focus-required-title");
    panel.setAttribute("aria-describedby", "p3e-focus-required-desc");
    panel.dataset["p3eFocusDialog"] = "required";
    panel.tabIndex = -1;
  }
  const panelTitle = element(
    "h3",
    undefined,
    required ? "先選一個人生重心，時間才會繼續" : label === null ? "上學了，想先把心力放在哪裡？" : "想把心力改放在哪裡？"
  );
  if (required) panelTitle.id = "p3e-focus-required-title";
  panel.append(panelTitle);
  const panelNote = element(
    "p",
    "p3e-focus-note",
    required
      ? "這是上學後一定要做的選擇；選好之前時間會暫停，選完就會照原本速度繼續。"
      : "每年至多調整一次；不同重心會慢慢改變狀態，也會讓相關事件更容易遇到。"
  );
  if (required) panelNote.id = "p3e-focus-required-desc";
  panel.append(panelNote);
  const options = element("div", "p3e-focus-options");
  const icons: Readonly<Record<P3ELifeFocusId, string>> = {
    study: "📚",
    growth: "🌱",
    family: "👨‍👩‍👧",
    hobby: "🎨",
    health: "❤️"
  };
  for (const option of P3E_LIFE_FOCUS_OPTIONS) {
    const button = element("button", "p3e-focus-option");
    button.type = "button";
    button.dataset["action"] = "set-focus";
    button.dataset["focusId"] = option.focusId;
    button.disabled = !canChange;
    if (snapshot?.focusId === option.focusId) button.setAttribute("aria-current", "true");
    const optionLabel = p3eLifeFocusLabel(option.focusId, state.age);
    button.append(
      element("span", "p3e-focus-option-title", `${icons[option.focusId]} ${optionLabel}`),
      element("span", "p3e-focus-option-summary", option.summary)
    );
    button.addEventListener("click", () => setLifeFocus(option.focusId));
    options.append(button);
  }
  panel.append(options);
  // GPT-0036-B D：還沒設定重心時完全移除「先不改」；只有玩家主動更改
  // 已設定的重心（不必強制暫停）才有返回的次要按鈕。
  if (!required && snapshot !== null) {
    const dismiss = element("button", "p3e-focus-dismiss", "返回");
    dismiss.type = "button";
    dismiss.dataset["action"] = "toggle-focus";
    dismiss.addEventListener("click", dismissFocusPicker);
    panel.append(dismiss);
  }
  box.append(panel);
  return box;
}

/**
 * 真正開始一段新人生（GPT-DEEPSEEK-0073-B）。
 *
 * ## 清除（只清本局）
 *
 * - autosave（`life-sim:p3e:v6:autosave`）與 active seed（`life-sim:p3e:active-seed`）；
 * - 記憶體 session、出生預覽、待決策、排程儲存、play intent／focus 提示、
 *   clock（回到暫停）、busy／error 與本局 UI 狀態（選單開合）。
 * - **保留**使用者偏好：語言（`p3e.locale.v1`）與自然音設定（`life-sim:p3e:v1:nature-sound`）。
 *
 * ## URL
 *
 * 公開玩家不應該因為網址上的 `?seed=` 回到同一個人：重開時用
 * `history.replaceState` 移除 `seed` 與只服務測試的固定參數
 * （`pinnedSeed`／`preview`／`fixture`），保留正常路徑，然後抽新的隨機 seed。
 *
 * ## 失敗處理
 *
 * 清除 storage 失敗時**不假裝成功**：顯示可重試訊息、保持舊資料不被部分覆寫、
 * 停在目前畫面（死亡頁或遊戲中），session 不動。
 */
function restartLife(options: { readonly confirm: boolean } = { confirm: true }): boolean {
  if (busy) return false;
  if (options.confirm && session !== null && session.state.phase !== "death") {
    const ok = window.confirm("要放棄這一局，重新開始一段新人生嗎？");
    if (!ok) return false;
  }
  busy = true;
  try {
    cancelScheduledSave();
    // 1) 清除本局 storage；任何一步失敗都停在原狀，不做部分覆寫。
    try {
      if (storage !== null) {
        clearAutosave();
        storage.removeItem(ACTIVE_SEED_KEY);
        if (storage.getItem(ACTIVE_SEED_KEY) !== null) throw new Error("active seed not cleared");
      }
    } catch (error) {
      persistenceStatus = "save-error";
      persistenceError = describeError(error);
      showAlert("無法清除本局存檔，請再試一次（舊資料尚未被覆寫）。");
      render();
      return false;
    }

    // 2) 記憶體狀態：本局全部歸零，偏好不動。
    persistenceEnabled = true;
    recoveryNeeded = false;
    persistenceGeneration += 1;
    persistenceStatus = "cleared";
    persistenceError = null;
    session = null;
    birthPreview = null;
    fullWorldError = null;
    fullWorldPromise = null;
    startPending = false;
    retryStartIntent = false;
    hudMenuOpen = false;
    resetDecisionPlayIntent(null);
    lifeClock.pause();

    // 3) URL：移除 pinned／測試參數，公開玩家不會回到同一人。
    stripPinnedSeedFromUrl();

    // 4) 新 seed → 新出生卡（clock 暫停；按下「開始人生」才建立 session）。
    showBirth(randomSeed());
    return true;
  } catch (error) {
    showAlert(describeError(error));
    render();
    return false;
  } finally {
    busy = false;
  }
}

/** 保留死亡流程原本的呼叫點（死亡後不需要二次確認）。 */
function rebirth(options: { readonly confirm: boolean } = { confirm: false }): void {
  restartLife({ confirm: options.confirm });
}

/**
 * 從網址移除 `seed` 與只服務測試的固定參數（用 `history.replaceState` 保留路徑）。
 *
 * 只動 query string，不新增歷史紀錄、不重新載入頁面。
 */
function stripPinnedSeedFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    let changed = false;
    for (const key of ["seed", "pinnedSeed", "preview", "fixture"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (changed) {
      const search = url.searchParams.toString();
      window.history.replaceState(null, "", url.pathname + (search.length > 0 ? `?${search}` : "") + url.hash);
    }
  } catch {
    /* 沒有 history API（罕見）時忽略：新 seed 仍會產生新人物。 */
  }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* GPT-0036-B B/C：收入資產比較 strip 與具名伴侶（純顯示層）              */
/* ------------------------------------------------------------------ */

/**
 * HUD 主列下方的兩行 compact strip。數值完全來自 application projection，
 * UI 不重算百分位；unavailable 顯示自然中文，兒童絕不顯示 0 百分位。
 * 「估算」是可點的簡短說明，不寫成精確即時排行。
 */
function renderComparisonStrip(comparison: ComparisonView): HTMLElement {
  const strip = element("section", "p3e-compare-strip");
  strip.setAttribute("aria-label", "收入與資產比較估算");
  strip.dataset["p3eCompareSource"] = comparison.source;
  strip.dataset["p3eCompareBasisYear"] =
    comparison.basisYear === null ? "" : String(comparison.basisYear);
  strip.dataset["p3eEstimateNote"] = comparison.note;

  const row = (label: string, block: ComparisonView["income"], kind: string): HTMLElement => {
    const line = element("div", `p3e-compare-row p3e-compare-${kind}`);
    line.dataset["p3eCompareAvailable"] = String(block.available);
    line.append(
      element("span", "p3e-compare-label", label),
      element("span", "p3e-compare-text", block.text)
    );
    if (!block.available) line.classList.add("p3e-compare-unavailable");
    line.title = `${label}：${block.text}`;
    return line;
  };
  strip.append(row("收入", comparison.income, "income"), row("資產", comparison.wealth, "wealth"));

  const estimate = element("button", "p3e-compare-estimate", "估算");
  estimate.type = "button";
  estimate.dataset["action"] = "toggle-estimate-note";
  estimate.setAttribute("aria-expanded", "false");
  estimate.setAttribute("aria-label", `估算說明：${comparison.note}`);
  const note = element("p", "p3e-compare-note", comparison.note);
  note.hidden = true;
  estimate.addEventListener("click", () => {
    const expanded = estimate.getAttribute("aria-expanded") === "true";
    estimate.setAttribute("aria-expanded", String(!expanded));
    note.hidden = expanded;
  });
  strip.append(estimate, note);
  return strip;
}

let alertText: string | null = null;

function showAlert(message: string): void {
  alertText = message;
}

function setControlsDisabled(disabled: boolean): void {
  app.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = disabled || button.dataset["p3eLocked"] === "true";
  });
}

/**
 * GPT-0038-B：`aria-modal="true"` 必須真的讓背景不可操作。
 *
 * 只對「不在 dialog 祖先鏈上、也不是 dialog 子樹」的分支設 `inert`；
 * dialog 本身與其祖先（`.p3e-focus` → content → shell）仍需保持可操作，
 * 所以沿著祖先鏈往下遞迴、旁支才標記。整棵 DOM 每次 render 都重建，
 * 新 shell 沒有舊標記；開頭的清除只是防禦性收尾。
 */
function setBackgroundInert(shell: HTMLElement, dialog: HTMLElement | null): void {
  shell.querySelectorAll<HTMLElement>("[inert]").forEach((node) => node.removeAttribute("inert"));
  if (dialog === null || !shell.contains(dialog)) return;
  const ancestors = new Set<Element>();
  for (let node: Element | null = dialog; node !== null && node !== shell; node = node.parentElement) {
    ancestors.add(node);
  }
  const mark = (node: Element, insideDialog: boolean): void => {
    if (insideDialog || node === dialog) {
      for (const child of Array.from(node.children)) mark(child, true);
      return;
    }
    if (ancestors.has(node)) {
      for (const child of Array.from(node.children)) mark(child, false);
      return;
    }
    // inert 會套用整棵子樹：HUD 音效／漢堡、比較 strip 的估算、時間控制
    // 都不再接受 Tab 或滑鼠操作。命令硬閘門仍由 runCommand 獨立把守。
    node.setAttribute("inert", "");
  };
  for (const child of Array.from(shell.children)) mark(child, false);
}

function render(): void {
  if (session === null) return;
  // 任何 render（命令、讀檔、reload、clock 通知）都重新同步必選閘門，
  // 這是唯一入口，避免各路徑漏掉而讓 clock 偷跑一年。
  syncFocusGate();
  const clockState = lifeClock.getState();
  const focusRequired = isFocusRequired(session);
  const view = session.view;
  // 直接讀取舊 DOM 的開合狀態，避免 `toggle` 事件尚未派送時重建把選單關掉。
  const existingMenu = app.querySelector<HTMLDetailsElement>("details.p3e-hud-menu");
  if (existingMenu !== null) hudMenuOpen = existingMenu.open;

  const shell = element("main", "p3e-shell p3e-game-shell");
  shell.id = "p3e-main";
  // GPT-0031-B：佔位標題移除後，改用 aria-label 保留可存取名稱。
  shell.setAttribute("aria-label", "人生模擬");
  shell.dataset["p3eLive"] = "true";
  // GPT-0040-B：直接從 live session 暴露出生國 entity，供 browser 驗收比對「居住國 == 出生國」。
  shell.dataset["p3eBirthEntity"] = session.state.identity.entityId;
  shell.dataset["p3eBirthRegion"] = session.state.identity.regionCode;
  shell.dataset["p3ePhase"] = view.phase;
  shell.dataset["p3eCopyKeys"] = String(eventCopyKeys);
  shell.dataset["p3eCopySchema"] = COPY_SCHEMA_VERSION;
  shell.dataset["p3eLifeFocus"] = readP3ELifeFocus(session.state.flags)?.focusId ?? "none";
  shell.dataset["p3eLifeFocusAge"] = String(session.state.age);
  // GPT-0036-B D：讓 browser 驗收能直接觀察「必選暫停」與 clock 狀態。
  shell.dataset["p3eFocusRequired"] = String(focusRequired);
  shell.dataset["p3eClockHeld"] = String(clockState.held);
  shell.dataset["p3eClockHoldReason"] = clockState.holdReason ?? "";
  shell.dataset["p3eClockRunning"] = String(clockState.running);
  shell.dataset["p3eClockSpeed"] = String(clockState.speed);
  // GPT-0038-B：播放意圖診斷快照（純 UI，不進 session／存檔／replay），
  // 讓 browser 驗收能直接看到「跳轉前」與「快轉過程」不是同一份 intent。
  shell.dataset["p3eDecisionIntent"] = describeIntent(decisionPlayIntent.peek());
  shell.dataset["p3eJumpIntent"] = describeIntent(decisionPlayIntent.peekArmed());
  shell.dataset["p3eFastForwarding"] = String(fastForwarding);
  shell.dataset["p3eOfficialReplay"] = String(OFFICIAL_REPLAY);
  shell.dataset["p3eStateHash"] = session.state.stateHash;
  shell.dataset["p3eCommandCount"] = String(session.state.commandLog.count);
  shell.dataset["p3eCommandHead"] = session.state.commandLog.headHash;
  shell.dataset["p3ePersistenceStatus"] = persistenceStatus;
  shell.dataset["p3ePersistenceError"] = persistenceError ?? "";
  shell.dataset["p3ePersistenceGeneration"] = String(persistenceGeneration);
  shell.dataset["p3eLastExport"] = lastExport ?? "";
  shell.dataset["p3eLastImport"] = lastImport ?? "";

  /* GPT-0031-B：HUD 左起年份／年齡／資產／年收入，右側只有自然音與漢堡。
     16 歲以前資產與年收入只做呈現保護（底層由 GPT-0031-A 修正）。 */
  const header = element("header", "p3e-hud");
  const minorFinance = view.age < PERSONAL_FINANCE_AGE;
  const year = element("div", "p3e-hud-item p3e-hud-year");
  year.append(element("span", undefined, "年份"), element("strong", undefined, String(view.currentYear)));
  const age = element("div", "p3e-hud-item p3e-hud-age");
  age.append(element("span", undefined, "年齡"), element("strong", undefined, `${view.age} 歲`));
  const balanceFull = financeDisplay(view.assets.balanceMicroUsd, minorFinance, false);
  const incomeFull = financeDisplay(view.assets.annualIncomeMicroUsd, minorFinance, false);
  const balanceValue = financeDisplay(view.assets.balanceMicroUsd, minorFinance, true);
  const incomeValue = financeDisplay(view.assets.annualIncomeMicroUsd, minorFinance, true);
  const balance = element("div", "p3e-hud-item p3e-hud-assets");
  balance.append(element("span", undefined, "資產"), element("strong", undefined, balanceValue));
  balance.setAttribute("aria-label", `資產：${minorFinance ? "尚未擁有個人資產" : balanceFull}`);
  balance.title = minorFinance ? "尚未擁有個人資產／收入" : `資產 ${balanceFull}`;
  balance.dataset["p3eFinanceFull"] = balanceFull;
  const income = element("div", "p3e-hud-item p3e-hud-income");
  income.append(element("span", undefined, "年收入"), element("strong", undefined, incomeValue));
  income.setAttribute("aria-label", `年收入：${minorFinance ? "尚未擁有個人收入" : incomeFull}`);
  income.title = minorFinance ? "尚未擁有個人資產／收入" : `年收入 ${incomeFull}`;
  income.dataset["p3eFinanceFull"] = incomeFull;
  if (minorFinance) {
    for (const [item, label] of [[balance, "資產"], [income, "年收入"]] as const) {
      item.dataset["p3eValue"] = "—";
      item.dataset["p3eMinorFinance"] = "true";
      item.setAttribute("aria-label", `${label}：尚未擁有個人資產／收入`);
      item.title = "尚未擁有個人資產／收入";
      item.append(element("span", "p3e-sr-only", "尚未擁有個人資產／收入"));
    }
  }

  const soundButton = element("button", "p3e-hud-sound", "🔊");
  soundButton.type = "button";
  soundButton.dataset["action"] = "toggle-nature-sound";
  soundButton.addEventListener("click", toggleNatureSound);

  const menu = element("details", "p3e-hud-menu");
  menu.open = hudMenuOpen;
  menu.addEventListener("toggle", () => {
    hudMenuOpen = menu.open;
  });
  const menuSummary = element("summary", undefined, "☰");
  // GPT-0036-B A：齒輪完全收進漢堡，面板本身就是「設定與存檔」。
  menuSummary.setAttribute("aria-label", "開啟設定與存檔選單");
  menuSummary.dataset["action"] = "toggle-settings-menu";
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
  const menuPanel = element("div", "p3e-hud-menu-panel");
  menuPanel.setAttribute("aria-label", "設定與存檔");
  menuPanel.dataset["p3eSettingsTitle"] = "⚙ 設定與存檔";
  const menuTitle = element("h2", "p3e-menu-title", "⚙ 設定與存檔");
  menuTitle.dataset["p3eMenuTitle"] = "設定與存檔";
  /*
   * GPT-DEEPSEEK-0073-B：任何階段（包含卡在決策或存檔損壞）都能從選單重開。
   * 進行中的新人生需要一次確認；死亡後不用確認（死亡頁自己也有醒目按鈕）。
   */
  const restartButton = element("button", "p3e-secondary p3e-menu-restart", "重新開始一段新人生");
  restartButton.type = "button";
  restartButton.dataset["action"] = "restart-life";
  restartButton.dataset["p3eRestart"] = "menu";
  restartButton.addEventListener("click", () => {
    const ok = restartLife({ confirm: true });
    if (ok) {
      menu.open = false;
      hudMenuOpen = false;
    }
  });
  menuPanel.append(
    menuTitle,
    element("p", "p3e-menu-note", "公開測試版 · 進度自動儲存在本機"),
    restartButton,
    renderPersistence(),
    notice,
    technical
  );
  menu.append(menuSummary, menuPanel);

  const status = element("p", "p3e-status", `${view.currentYear} 年，${view.age} 歲`);
  status.id = "p3e-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  header.append(year, age, balance, income, soundButton, menu, status);

  const alert = element("p", "p3e-alert");
  alert.id = "p3e-alert";
  alert.setAttribute("role", "alert");
  alert.setAttribute("aria-live", "assertive");
  alert.hidden = alertText === null;
  alert.textContent = alertText ?? "";
  if (alertText !== null) {
    status.textContent = `${status.textContent ?? ""} · 錯誤：${alertText}`;
  }

  const content = element("section", "p3e-content");
  content.setAttribute("aria-label", "人生主畫面");
  content.append(renderLife(view, session));

  // GPT-0036-B B：比較資訊在 HUD 主列下方自成兩行 compact strip，
  // 不擠進年份／年齡／資產／年收入四個欄位，也不增加整頁下滑。
  const comparisonStrip = renderComparisonStrip(readComparisonView(view as unknown, view.age));

  // 底部四個 tabs 與獨立齒輪（.p3e-tools）已完全移除；存檔／診斷／復原
  // 全部收進上面的漢堡選單，保留壞存檔的明確復原能力。
  shell.append(header, comparisonStrip, alert, content);
  // GPT-0037-B P2：整棵 DOM 每次 render 都重建，先記住 dialog 裡原本聚焦的
  // 重心 id，重建後才能把焦點放回同一個選項，不掉回 body。
  const dialogBefore = app.querySelector<HTMLElement>(
    '.p3e-focus-panel[data-p3e-focus-dialog="required"]'
  );
  const activeBefore = document.activeElement;
  const activeFocusId =
    dialogBefore !== null && activeBefore instanceof HTMLElement && dialogBefore.contains(activeBefore)
      ? activeBefore.dataset["focusId"] ?? null
      : null;
  app.replaceChildren(shell);
  syncNatureSoundDom();

  /* GPT-0037-B P2：必選 dialog 的 autofocus 與關閉後的焦點回歸。 */
  const requiredDialog = shell.querySelector<HTMLElement>(
    '.p3e-focus-panel[data-p3e-focus-dialog="required"]'
  );
  // GPT-0038-B：先讓背景 inert，再把焦點放進 dialog；關閉時整棵 DOM 重建，
  // 新 shell 沒有 inert，既有 focus return 自然恢復背景可操作。
  setBackgroundInert(shell, requiredDialog);
  if (requiredDialog !== null) {
    const sameOption = activeFocusId === null
      ? null
      : requiredDialog.querySelector<HTMLButtonElement>(
        `[data-action="set-focus"][data-focus-id="${activeFocusId}"]:not([disabled])`
      );
    const firstOption = requiredDialog.querySelector<HTMLButtonElement>(
      '[data-action="set-focus"]:not([disabled])'
    );
    (sameOption ?? firstOption ?? requiredDialog).focus({ preventScroll: true });
    focusDialogWasOpen = true;
    focusAdvanceAfterRender = false; // dialog 開啟期間由 dialog 擁有鍵盤焦點
  } else if (focusDialogWasOpen) {
    focusDialogWasOpen = false;
    // 仍暫停 → 暫停／繼續鍵；恢復播放 → 主要控制（下一步）。
    // 必須分兩次 querySelector：逗號選擇器會回傳 DOM 順序最前面的
    // toggle-time，而不是播放中該優先的「下一步」。
    const preferred = clockState.running
      ? '[data-action="advance"]:not([disabled])'
      : '[data-action="toggle-time"]:not([disabled])';
    const fallback = clockState.running
      ? '[data-action="toggle-time"]:not([disabled])'
      : '[data-action="advance"]:not([disabled])';
    const target =
      shell.querySelector<HTMLButtonElement>(preferred) ??
      shell.querySelector<HTMLButtonElement>(fallback);
    target?.focus({ preventScroll: true });
    focusAdvanceAfterRender = false;
  }

  const advance = shell.querySelector<HTMLButtonElement>('[data-action="advance"]');
  if (focusAdvanceAfterRender && advance !== null) {
    // 單畫面本來就 overflow:hidden，focus 一律不需要 scroll-into-view。
    // 7 歲第一次出現固定前景重心卡時，「下一步」被前景卡遮住，對它 focus()
    // 會強制一次同步版面計算（CPU 4x 下約 250ms），鍵盤焦點也落在看不見的
    // 按鈕；此時直接略過，讓 Tab 依 DOM 順序先到重心卡。
    const pickerOpen =
      shell.querySelector('.p3e-focus[data-p3e-focus-expanded="true"]') !== null;
    if (!pickerOpen) advance.focus({ preventScroll: true });
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

/* ------------------------------------------------------------------ */
/* GPT-0040-B｜場景左側角色即時狀態卡                                    */
/* ------------------------------------------------------------------ */

interface ResidenceDisplay {
  readonly name: string;
  readonly flag: string;
}

/** 由居住 entityId／regionCode 取真正繁中國名與旗幟；找不到回「未知地區」。 */
function resolveResidenceDisplay(residence: ProfileResidenceView): ResidenceDisplay {
  const fallback: ResidenceDisplay = { name: "未知地區", flag: "🌐" };
  // 把 entityId（cr:XXX）或 regionCode 轉成 ISO3，作為查表 key。
  const iso3FromEntity = residence.entityId.startsWith("cr:") ? residence.entityId.slice(3) : "";
  const iso3 = residence.regionCode !== "" ? residence.regionCode : iso3FromEntity;
  // 1) 優先靜態繁中對照表（含臺灣／香港／澳門等 registry 的 displayNameZhHans 為 null 的敏感地區）。
  if (iso3 !== "") {
    const hant = zhHantCountryName(iso3);
    if (hant !== "") return { name: hant, flag: flagOf(iso3) };
  }
  // 2) registry 有紀錄且 displayNameZhHans 存在時，才退回（經 toHantLabel）。
  if (countryRegistry.length > 0) {
    const record = countryRegistry.find((r) => {
      const entityId = typeof r["entityId"] === "string" ? (r["entityId"] as string) : null;
      const regionCode = typeof r["regionCode"] === "string" ? (r["regionCode"] as string) : null;
      const rIso3 = typeof r["iso3"] === "string" ? (r["iso3"] as string) : null;
      if (residence.entityId !== "" && entityId === residence.entityId) return true;
      if (residence.regionCode !== "" && (regionCode === residence.regionCode || rIso3 === residence.regionCode)) return true;
      return false;
    });
    if (record !== undefined) {
      const regionCode = typeof record["regionCode"] === "string" ? (record["regionCode"] as string) : iso3;
      const rawName = typeof record["displayNameZhHans"] === "string" ? (record["displayNameZhHans"] as string) : null;
      if (rawName !== null && rawName.trim().length > 0) {
        return { name: toHantLabel(rawName), flag: flagOf(regionCode) };
      }
    }
  }
  return fallback;
}

/** 狀態卡單行（鍵＋值），值過長只做視覺省略，完整文字留在 title／aria-label。 */
function profileRow(key: string, value: string, title: string): HTMLElement {
  const row = element("div", "p3e-profile-row");
  const k = element("span", "p3e-profile-key", key);
  const v = element("span", "p3e-profile-val", value);
  v.title = title;
  v.setAttribute("aria-label", title);
  row.append(k, v);
  return row;
}

/**
 * 場景左上角的緊湊 HUD 狀態卡（三行：身分／居住／情感）。
 * 讀 `view.profile` 的正式投影，UI 不重算；任何欄位缺失都走安全 placeholder。
 * 注：GPT-0043-B 已移除舊有的 `window.__p3eProfileOverride` 測試注入入口（不進 production bundle）。
 *     五態與國名的覆蓋改由 reader/DOM 單元測試與不進 bundle 的測試 fixture 負責。
 */
function renderProfileCard(view: unknown): HTMLElement {
  const card = element("aside", "p3e-profile-card");
  card.setAttribute("aria-label", "角色即時狀態");

  const effectiveView = view;
  const role = readProfileRole(effectiveView);
  const roleKey = role?.rowLabel ?? "目前身分";
  const roleVal = role?.label ?? "狀態更新中";
  const roleRow = profileRow(roleKey, roleVal, `${roleKey}：${roleVal}`);
  // GPT-0040-B：為 browser/mobile 驗收提供決定性屬性，取代已移除的舊伴侶列。
  if (role !== null && role.id !== "") roleRow.dataset["p3eProfileRoleId"] = role.id;
  card.append(roleRow);

  const residence = readProfileResidence(effectiveView);
  let residenceText = "未知地區";
  let residenceTitle = "未知地區";
  let residenceEntity = "";
  let residenceRegion = "";
  if (residence !== null) {
    const disp = resolveResidenceDisplay(residence);
    residenceText = `${disp.flag} ${disp.name}`;
    residenceTitle = disp.name;
    residenceEntity = residence.entityId;
    residenceRegion = residence.regionCode;
  }
  const residenceRow = profileRow("目前居住", residenceText, `目前居住：${residenceTitle}`);
  if (residenceEntity !== "") residenceRow.dataset["p3eProfileResidenceEntity"] = residenceEntity;
  if (residenceRegion !== "") residenceRow.dataset["p3eProfileResidenceRegion"] = residenceRegion;
  card.append(residenceRow);

  const relationship = readProfileRelationship(effectiveView);
  const relLabel = relationship?.label ?? "狀態更新中";
  const relRow = profileRow("情感狀態", relLabel, `情感狀態：${relLabel}`);
  if (relationship !== null) {
    relRow.dataset["p3eRelationshipStatus"] = relationship.status;
    if (relationship.personName !== null) relRow.dataset["p3ePartnerName"] = relationship.personName;
  }
  card.append(relRow);

  return card;
}

function renderLife(view: P3EPlaySession["view"], current: P3EPlaySession): HTMLElement {
  const root = element("div", "p3e-life");
  /* GPT-WORKBUDDY-0062-B：完整 Open Peeps 全身人物場景（urban/rural 背景 +
     玩家 + 伴侶 + 寵物）。仍是單張本機 SVG data URI，場景節點 0 個子節點、
     不疊文字／emoji；左側狀態卡與六段單屏版面完全不受影響。
     外觀由 view.scene + seed 決定：玩家只用出生 seed，伴侶額外帶
     `|partner-identity=<displayName>`，因此交往／養寵物不會換掉玩家，
     新伴侶才會拿到新的穩定外觀。所有素材為官方 CC0、隨本站自託管。 */
  const sceneView = readSceneView(view);
  const partnerName = view.partner?.displayName ?? "";
  const sceneSeed = `${readSeed()}|partner-identity=${partnerName}`;
  const scene = element("section", `p3e-scene p3e-scene-${view.phase}`);
  scene.setAttribute("aria-label", `${view.currentYear} 年的生活場景`);
  scene.dataset["p3eSceneFit"] = "contain";
  scene.dataset["p3eSceneAsset"] = "generated-layered-svg";
  scene.dataset["p3eSceneResidence"] = sceneView.residenceKind;
  // 0063-B：精確年齡／生活階段直接來自正式 view.scene，讓 HUD 與人物畫面
  // 可以在 smoke 裡逐歲比對，杜絕「HUD 0 歲但場景注入成人」的舊缺失。
  scene.dataset["p3eSceneAge"] = String(sceneView.age);
  scene.dataset["p3eSceneAgeStage"] = sceneView.ageStage;
  scene.dataset["p3eSceneLifeStage"] = sceneView.lifeStage;
  scene.dataset["p3eScenePlayerSex"] = sceneView.playerSex;
  scene.dataset["p3eSceneHasPartner"] = String(sceneView.hasPartner);
  scene.dataset["p3eScenePet"] = sceneView.petKind;
  scene.dataset["p3eSceneLayers"] = describeSceneLayers(sceneView, sceneSeed)
    .filter((layer) => layer.visible)
    .map((layer) => layer.layer)
    .join(",");
  // 0062-B：把真正使用的官方全身資產 key 暴露到 DOM，供 CTO／smoke 驗收。
  scene.dataset["p3eScenePeeps"] = describeSceneParts(sceneView, sceneSeed)
    .map((entry) => entry.asset)
    .join(",");
  scene.dataset["p3eSceneSignature"] = sceneSignature(sceneView, sceneSeed);
  // 0073-A：`cover` 會為了填滿容器而裁掉左右／上下，把站在安全區邊緣的人物與
  // 拐杖切掉。改成 `contain`：整張場景等比縮到容器內、貼底對齊，人物與配件
  // 永遠完整。`contain` 在極寬扁的容器（例如 320×568）會留左右縫隙，所以底下
  // 再墊一層「天空 → 遠景 → 地面」的同色漸層，縫隙看起來是場景的延伸。
  const dead = sceneView.phase === "dead";
  const sky = dead ? "#c6b7a6" : "#f7dca9";
  const ground = dead ? "#9c8f7c" : "#c9a978";
  scene.style.backgroundColor = sky;
  // 漸層只有「天空 → 地面」兩段，分界對齊 SVG 的地面線 196/220≈89%，
  // 這樣左右縫隙的天地線和圖裡完全一致，不會出現浮在半空的色塊。
  scene.style.backgroundImage =
    `url("${sceneSvgDataUri(sceneView, sceneSeed)}"), ` +
    `linear-gradient(180deg, ${sky} 0 89%, ${ground} 89% 100%)`;
  scene.style.backgroundSize = "contain, cover";
  scene.style.backgroundRepeat = "no-repeat, no-repeat";
  scene.style.backgroundPosition = "center bottom, center bottom";

  // GPT-0040-B：狀態卡是 scene 的 overlay，但為了不讓 scene 多出子層
  // （破壞既有「場景只剩一張圖」的視覺與指標），改放在 scene-wrap 裡與 scene 疊合。
  const sceneWrap = element("div", "p3e-scene-wrap");
  sceneWrap.append(scene, renderProfileCard(view));

  // GPT-0040-B：情感狀態改由 view.profile.relationship 權威來源；
  // 關係建立當年的人生紀錄仍帶姓名（由 relationship 的 personName 推導）。
  const relationship = readProfileRelationship(view);
  const partner: PartnerIdentity | null =
    relationship !== null && relationship.personName !== null
      ? { displayName: relationship.personName, status: relationship.status, sinceYear: relationship.sinceYear }
      : null;

  const story = element("section", "p3e-story-card");
  story.append(element("h2", undefined, view.phase === "pending_decision" ? "重要抉擇" : "人生紀錄"));

  // 重要決定卡／重新開始永遠排在最前面，玩家不必往下捲就能立即點選。
  if (view.phase === "pending_decision" && view.pendingDecision !== null) {
    story.append(renderPending(view.pendingDecision, view.stats.knowledge));
  }

  const last = current.lastOutcome;
  if (view.phase === "death") {
    const death = element("div", "p3e-death");
    /*
     * GPT-DEEPSEEK-0073-B：死亡摘要最前方就是「重新開始一段新人生」，
     * 手機首屏不必尋找、不必捲動（死亡後不需要二次確認）。
     */
    const restartFirst = element("button", "p3e-primary p3e-restart-life", "重新開始一段新人生");
    restartFirst.type = "button";
    restartFirst.dataset["action"] = "rebirth";
    restartFirst.dataset["p3eRestart"] = "death";
    restartFirst.addEventListener("click", () => rebirth({ confirm: false }));
    death.append(restartFirst);
    death.append(element("h3", undefined, "這段人生走到了終點"));
    const deathOutcome = last !== null && last.kind === "advance_year" ? last.death : null;
    const causeText =
      deathOutcome?.causeId === null || deathOutcome?.causeId === undefined
        ? ""
        : ` 原因：${friendlyDeathCause(deathOutcome.causeId)}`;
    death.append(element("p", undefined, `你活了 ${view.age} 年。${causeText}`));
    // GPT-DEEPSEEK-0074-A：死亡摘要只有這一個主按鈕（最前方、免二次確認）；
    // 第二個同功能按鈕已移除，死亡頁永遠只有一個 [data-action="rebirth"]。
    story.append(death);
  }

  const focusSection = renderFocusSection(current);
  if (focusSection !== null) story.append(focusSection);

  // 人生紀錄放在決定卡之後，卡內捲動；頁面本身永遠不因紀錄變長而捲動。
  story.append(renderLifeLog(current, partner));

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
  const held = lifeClock.getState().held;
  if (view.controls.canAdvanceYear) {
    const advance = element("button", "p3e-primary p3e-next-button", "下一步");
    advance.type = "button";
    advance.dataset["action"] = "advance";
    // GPT-0036-B D：未選重心前，連按鈕本身都是 disabled（不是只有遮罩）。
    advance.disabled = held;
    advance.dataset["p3eAdvanceLocked"] = String(held);
    advance.addEventListener("click", advanceYear);
    controls.append(advance);
  } else if (view.phase === "pending_decision") {
    controls.append(element("p", "p3e-hint", "請先做出選擇"));
  } else if (view.phase === "death") {
    controls.append(element("p", "p3e-hint", "這條命已結束"));
  }

  root.append(sceneWrap, story, statDock, timeControls, controls);
  return root;
}

function renderTimeControls(view: P3EPlaySession["view"]): HTMLElement {
  const section = element("section", "p3e-time-controls");
  section.setAttribute("aria-label", "時間控制");
  const state = lifeClock.getState();
  const pause = element("button", "p3e-time-toggle", state.running ? "❚❚ 暫停" : "▶ 繼續");
  pause.type = "button";
  pause.dataset["action"] = "toggle-time";
  pause.disabled = view.phase === "death" || state.held;
  pause.addEventListener("click", () => lifeClock.togglePause());
  section.append(pause);
  const speeds: readonly Speed[] = [1, 2, 4, 8, 16];
  for (const speed of speeds) {
    const button = element("button", "p3e-speed-button", `${speed}×`);
    button.type = "button";
    button.dataset["speed"] = String(speed);
    button.setAttribute("aria-pressed", String(state.speed === speed));
    button.disabled = view.phase === "death" || state.held;
    button.addEventListener("click", () => lifeClock.setSpeed(speed));
    section.append(button);
  }
  const jump = element("button", "p3e-jump-button", "下一個決定 »");
  jump.type = "button";
  jump.dataset["action"] = "jump-decision";
  jump.disabled = !view.controls.canAdvanceYear || fastForwarding || state.held;
  jump.addEventListener("click", () => void jumpToNextDecision());
  section.append(jump);
  return section;
}

function renderPending(
  pending: NonNullable<P3EPlaySession["view"]["pendingDecision"]>,
  knowledge: number
): HTMLElement {
  const section = element("div", "p3e-pending");
  section.setAttribute("aria-labelledby", "p3e-pending-title");
  const heading = element("h2", undefined, friendlyKey(pending.promptKey !== "" ? pending.promptKey : pending.eventId));
  heading.id = "p3e-pending-title";
  section.append(heading);

  /* GPT-WORKBUDDY-0054-B：兩階段職業決策改用緊湊兩欄卡片。
     分類階段顯示領域名稱 + 自然繁中提示；具體職業階段顯示職業名稱 +
     預估年收入（CNY）。事件包已先依學歷過濾，這裡再對「不屬於本分類／
     本學歷層級或不在權威目錄」的選項做防禦性停用並給自然說明。
     決策區自己可捲動，不會把時間控制與下一步按鈕推出螢幕。 */
  const career = parseCareerDecision(pending.decisionId);
  const options = element(
    "div",
    career === null ? "p3e-options p3e-choice-list" : "p3e-options p3e-choice-list p3e-career-options"
  );
  if (career !== null) {
    section.dataset["p3eCareerStage"] = career.stage;
    section.append(element("p", "p3e-career-note", careerListNote(career)));
  }
  const careerViews =
    career === null
      ? null
      : buildCareerOptionViews(pending.options, career, { translate: friendlyKey, knowledge });

  pending.options.forEach((option, index) => {
    const button = element("button", "p3e-option");
    button.type = "button";
    button.dataset["action"] = "choose";
    button.dataset["optionId"] = option.optionId;
    button.dataset["optionIndex"] = String(index);
    const view = careerViews === null ? null : careerViews[index];
    if (view !== undefined && view !== null) {
      button.append(element("strong", "p3e-career-name", view.label));
      if (view.incomeText !== null) button.append(element("span", "p3e-career-income", view.incomeText));
      if (view.note !== null) button.append(element("small", "p3e-career-hint", view.note));
      button.disabled = view.disabled;
      if (view.disabled) {
        button.dataset["p3eCareerDisabled"] = "true";
        button.setAttribute("aria-disabled", "true");
      }
    } else {
      button.textContent = friendlyKey(option.labelKey !== "" ? option.labelKey : option.optionId);
    }
    button.addEventListener("click", () => chooseOption(option.optionId));
    options.append(button);
  });
  section.append(options);
  return section;
}

/* ------------------------------------------------------------------ */
/* 啟動                                                                */
/* ------------------------------------------------------------------ */

function renderBootError(message: string, headingText?: string): void {
  alertText = message;
  const shell = element("main", "p3e-shell");
  shell.dataset["p3eLive"] = "false";
  shell.dataset["p3ePhase"] = "error";
  shell.dataset["p3eCopyKeys"] = String(eventCopyKeys);
  // GPT-0025-D：文案字典驗證失敗時，明確告訴玩家發生什麼事，
  // 且停在這裡不進遊戲，避免任何 internal key 被當成文字顯示。
  const heading = element(
    "p",
    "p3e-alert",
    headingText ?? "遊戲啟動失敗：必要的事件文案載入或驗證未通過。為了不讓畫面出現內部代碼，人生還沒有開始。請重新整理頁面再試一次。"
  );
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
  // GPT-0058-B：失敗時也要給玩家一個人類可理解、可實際重試的動作，
  // 而不是只能重新整理整個頁面（仍保留上方「重新整理」文案相容既有驗收）。
  const retry = element("button", "p3e-primary", "重試載入");
  retry.type = "button";
  retry.dataset["action"] = "retry-world";
  retry.addEventListener("click", retryWorld);
  shell.append(element("h1", undefined, "人生模擬"), heading, detail, retry);
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
/**
 * 回訪玩家（已有 autosave）不需要先看到出生卡：維持 HTML 骨架直到完整世界
 * ready 再 restore，避免「出生卡閃一下才進遊戲」。這裡只檢查 key 是否存在，
 * **不讀取／不解析存檔內容**；真正的 restore 仍走 application 公開 API。
 */
function hasStoredAutosave(store: Storage | null): boolean {
  if (store === null) return false;
  try {
    return store.getItem(AUTOSAVE_PRESENCE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * 啟動（GPT-WORKBUDDY-0058-B）：兩階段，出生卡不被死亡資料阻塞。
 *
 * 1. index.html 的靜態骨架在 HTML 到達時就已可見（不依賴 JS）；
 * 2. **第一階段**只抓 base＋identity 14 個小 JSON，驗證後立刻顯示出生卡；
 * 3. **第二階段** events＋death（含 2.61MB mortality）在出生卡顯示後
 *    背景載入；「開始人生」會等它完成，或顯示「準備人生…」後自動開局；
 * 4. 回訪玩家（有 autosave）等完整世界 ready 才 restore，避免半套 session。
 *
 * seed 與 restore 的既有優先順序、壞存檔保護、ephemeral 降級全部保留。
 */
async function boot(): Promise<void> {
  // ==================================================================
  // GPT-WORKBUDDY-0065-A：birth entry 交付的完整世界。
  // prepareFullWorld() 已在「開始人生」後用原始 fixtures + 正式 validators
  // 產生 P3EBrowserWorld；這裡不再重跑兩階段下載，也不會建立第二個 session。
  // ==================================================================
  const handoff: GameHandoff | null = takeGameHandoff();
  if (handoff !== null) {
    world = handoff.world as P3EBrowserWorld;
    birthStage = handoff.birthStage as P3EBrowserBirthStage;
    eventCopy = handoff.eventCopy;
    eventCopyKeys = handoff.eventCopyKeys;
    countryRegistry = handoff.countryRegistry as ReadonlyArray<Readonly<Record<string, unknown>>>;
    storage = handoff.storage;
    fullWorldError = null;
    try {
      await ensureGameLayer();
    } catch (error) {
      renderBootError(describeError(error), WORLD_FAILURE_HEADING);
      return;
    }
    if (handoff.startNewLife) {
      // 明確的使用者手勢：beginLife 會建立唯一一條 age-0 session 並 arm 音訊。
      beginLife(handoff.seed);
      return;
    }
    // 回訪玩家：只 restore，不 arm 音訊、不建立新 session。
    activeSeed = handoff.seed;
    writeActiveSeed(handoff.seed);
    try {
      const restored = restoreP3EBrowserAutosaveSession({
        storage,
        world,
        masterSeed: handoff.seed
      });
      if (restored === null) {
        showBirth(handoff.seed);
        return;
      }
      session = restored;
      markSessionCreated();
      persistenceGeneration += 1;
      savedGeneration = persistenceGeneration;
      persistenceStatus = "restored";
      syncClockAfterSession();
      render();
    } catch (error) {
      // 壞存檔／版本／seed／replay 不符：不刪除、不覆寫，沿用 0031-B 以來的
      // 「明確恢復」契約——開一條暫時新命並在遊戲畫面顯示 recover 動作，
      // 不退回出生卡、不靜默清掉存檔。這裡刻意不呼叫 beginLife()，
      // 因為它會把 recoveryNeeded／persistenceEnabled 重設掉。
      persistenceStatus = "restore-error";
      persistenceError = describeError(error);
      recoveryNeeded = true;
      persistenceEnabled = false;
      session = startLife(handoff.seed);
      persistenceGeneration += 1;
      syncClockAfterSession();
      render();
    }
    return;
  }

  // 沒有交付（例如直接載入 game chunk）：保留原本的兩階段啟動相容路徑。
  try {
    // ===== 第一階段：base＋identity =====
    const birthData = await loadBirthPacks();
    birthStage = prepareP3EBrowserBirthStage(buildBirthStageInput(birthData));
    countryRegistry = birthCountryRecords(birthData).filter(
      (record): record is Record<string, unknown> => isPlainRecord(record)
    ) as ReadonlyArray<Readonly<Record<string, unknown>>>;
    storage = acquireStorage();
    const pinned = readPinnedSeed();
    const stored = readActiveSeed();
    const knownSeed = pinned ?? stored;

    // 新使用者：立刻把骨架換成真正的出生卡，這裡完全沒等到 mortality。
    // 已有存檔的回訪玩家：維持骨架，等完整世界 ready 再 restore（不閃出生卡）。
    const previewSeed = knownSeed ?? randomSeed();
    if (!hasStoredAutosave(storage)) showBirth(previewSeed);

    // ===== 第二階段：背景準備完整世界（不阻塞上面的出生卡）=====
    let full: P3EBrowserWorld;
    try {
      full = await ensureFullWorld();
    } catch (error) {
      onWorldFailure(error);
      return;
    }
    world = full;
    await ensureGameLayer();

    if (storage === null) {
      // 儲存不可用：可預覽、可玩的暫時性命＋非阻塞警告（ephemeral）。
      persistenceStatus = "unavailable";
      persistenceEnabled = false;
      showBirth(knownSeed ?? previewSeed);
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
        syncClockAfterSession();
        render();
        return;
      }
      if (restored === null) {
        // 確認沒有舊存檔：維持剛剛顯示的出生卡（新安全隨機 seed）。
        persistenceStatus = "missing";
        if (birthPreview === null) showBirth(previewSeed);
        else renderBirth();
        return;
      }
      activeSeed = DEFAULT_SEED;
      writeActiveSeed(DEFAULT_SEED);
      session = restored;
      persistenceGeneration += 1;
      savedGeneration = persistenceGeneration;
      persistenceStatus = "restored";
      syncClockAfterSession();
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
        // 有 active seed 但還沒有存檔（例如出生卡階段 reload）：同一張卡。
        persistenceStatus = "missing";
        if (birthPreview === null) showBirth(knownSeed);
        else renderBirth();
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
    syncClockAfterSession();
    render();
  } catch (error) {
    // 第一階段（base／identity）就失敗：沒有出生卡可顯示，沿用既有啟動錯誤頁。
    renderBootError(describeError(error));
  }
}

/**
 * GPT-0038-B：Tab 的最小 focus containment（背景 inert 之外的第二道保險）。
 * 必選 dialog 開啟時，Tab／Shift+Tab 只在 dialog 的可聚焦元素間循環，
 * 絕不落到 HUD 音效、漢堡、估算或時間控制；關閉後不攔截任何按鍵。
 */
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Tab") return;
    const dialog = app.querySelector<HTMLElement>(
      '.p3e-focus-panel[data-p3e-focus-dialog="required"]'
    );
    if (dialog === null) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
          'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    if (!dialog.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  },
  true
);

// 離開頁面／切到背景時盡力同步 flush 最新 session（不阻塞正常路徑）。
window.addEventListener("pagehide", () => flushAutosaveNow());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushAutosaveNow();
});

/**
 * GPT-WORKBUDDY-0065-A：game chunk 只由 birth entry 動態 import 一次。
 * `startP3EGame` 冪等，連點「開始人生」也不會建立第二個 session。
 */
let gameBooted = false;
export function startP3EGame(): void {
  if (gameBooted) return;
  gameBooted = true;
  void boot();
}

void startP3EGame();
