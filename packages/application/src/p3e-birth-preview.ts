import {
  P2B_SETTLEMENT_LABELS,
  type BirthCertificateSnapshot,
  type IncomeQuintile
} from "@life-sim/contracts";

/**
 * P3-E.1b（GPT-DEEPSEEK-0017）：正式出生預覽（Birth Preview）的呈現層。
 *
 * `previewP3EBrowserBirth`（見 `./p3e-browser-bootstrap`）在 application bootstrap
 * 內用與 `createP3EBrowserSession` **完全相同**的 `buildPeerGroup` →
 * `createBirthCertificate` 產生同一張出生證書，再交給本模組彙整成「可安全顯示」的
 * 出生卡資料。因此同一 `masterSeed` 的 preview 與正式 session 的 identity
 * （`certificateId`／`certificateHash`／`playerIdentityHash`／`regionCode`／`sex`／
 * `birthYear`）逐位元一致。
 *
 * ## 邊界
 *
 * - 本模組**只讀**已驗證完成的 `BirthCertificateSnapshot`（P2-D 公開契約）；
 *   它拿不到、也不會回傳任何 pack／dataset／manifest／抽選表；
 * - 不抽新的隨機值、不改寫任何文案、不重算證書 hash；
 * - 回傳值是深層凍結、可 JSON 序列化的純資料（無 bigint、無函式、無循環）。
 *
 * ## 語言
 *
 * 專案資料包（P2-A／P2-B）的顯示文案是**簡中**（首發語言），繁中屬後續 i18n 階段。
 * 因此除 `country.nameZhHant`（介面規格明確要求的繁中名稱，見下方對照表）外，
 * 其餘顯示字串（姓名、五分之一標籤、住房、宗教、父母職業、出生故事）都**原樣**
 * 沿用資料包輸出，preview 不做翻譯、不改寫 pack 文案。`country.nameZhHans`
 * 同時保留資料包原文，讓呼叫端能自行比對或再本地化。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 出生國／地區（繁中名稱＋資料包原文）。 */
export interface P3EBrowserBirthPreviewCountry {
  /** P2-A registry 的 regionCode（例如 `JPN`）；與 session identity 相同。 */
  readonly regionCode: string;
  /** P2-A 的大洲分組代碼（例如 `asia`）。 */
  readonly region: string;
  /** 繁中顯示名稱（對照表；未收錄代碼回退為資料包名稱）。 */
  readonly nameZhHant: string;
  /** 資料包原始顯示名稱（zh-Hans，不修改）。 */
  readonly nameZhHans: string;
}

/** 姓名（資料包原文）。 */
export interface P3EBrowserBirthPreviewName {
  readonly fullName: string;
  readonly surname: string;
  readonly givenName: string;
}

/** 住房（`id` 是 P2-B 的 housingId，`label` 是資料包原文）。 */
export interface P3EBrowserBirthPreviewHousing {
  readonly id: string;
  readonly label: string;
}

/** 父母年齡與職業（職業為資料包原文標籤）。 */
export interface P3EBrowserBirthPreviewParents {
  readonly motherAge: number;
  readonly fatherAge: number;
  readonly motherOccupationLabel: string;
  readonly fatherOccupationLabel: string;
}

/** 宗教（`id` 是 P2-B 的 religionId，`label` 是資料包原文）。 */
export interface P3EBrowserBirthPreviewReligion {
  readonly id: string;
  readonly label: string;
}

/** 出生故事（模板 id＋已代入的段落；資料包原文）。 */
export interface P3EBrowserBirthPreviewStory {
  readonly templateId: string;
  readonly paragraphs: readonly string[];
}

/** 正式出生預覽：可直接顯示的出生卡資料（不含任何 pack）。 */
export interface P3EBrowserBirthPreview {
  readonly certificateId: string;
  readonly certificateHash: string;
  readonly playerIdentityHash: string;
  readonly birthYear: number;
  readonly country: P3EBrowserBirthPreviewCountry;
  readonly name: P3EBrowserBirthPreviewName;
  readonly sex: "female" | "male";
  readonly settlement: "urban" | "rural";
  readonly settlementLabel: string;
  readonly incomeQuintile: IncomeQuintile;
  readonly incomeLabel: string;
  readonly housing: P3EBrowserBirthPreviewHousing;
  readonly parents: P3EBrowserBirthPreviewParents;
  readonly religion: P3EBrowserBirthPreviewReligion;
  /** P2-B 原始值（×10；例如 734 代表 73.4 年）。 */
  readonly lifeExpectancyYearsX10: number;
  /** 顯示用小數（`lifeExpectancyYearsX10 / 10`）。 */
  readonly lifeExpectancyYears: number;
  readonly story: P3EBrowserBirthPreviewStory;
}

/* ------------------------------------------------------------------ */
/* 繁中地區名稱對照表                                                   */
/* ------------------------------------------------------------------ */

/**
 * regionCode → 繁中顯示名稱。
 *
 * - 這是一張**呈現層**對照表：不是資料包、不影響抽選、權重、hash 或任何規則；
 * - 以參考專案 `born-somewhere` 的繁中譯名為基準，逐一對齊本專案 P2-A registry
 *   的 172 個 regionCode；
 * - 三個敏感地區（HKG／MAC／TWN）**一律沿用資料包審核過的正式名稱**逐字轉繁，
 *   不採用其他來源的稱呼；
 * - 對照表未收錄的代碼（例如未來新增實體）回退為資料包原文，永不拋錯。
 */
export const P3E_ZH_HANT_COUNTRY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  AFG: "阿富汗",
  AGO: "安哥拉",
  ALB: "阿爾巴尼亞",
  ARE: "阿聯酋",
  ARG: "阿根廷",
  ARM: "亞美尼亞",
  AUS: "澳洲",
  AUT: "奧地利",
  AZE: "亞塞拜然",
  BDI: "蒲隆地",
  BEL: "比利時",
  BEN: "貝南",
  BFA: "布吉納法索",
  BGD: "孟加拉",
  BGR: "保加利亞",
  BHR: "巴林",
  BIH: "波士尼亞與赫塞哥維納",
  BLR: "白俄羅斯",
  BOL: "玻利維亞",
  BRA: "巴西",
  BRN: "汶萊",
  BWA: "波札那",
  CAF: "中非共和國",
  CAN: "加拿大",
  CHE: "瑞士",
  CHL: "智利",
  CHN: "中國",
  CIV: "象牙海岸",
  CMR: "喀麥隆",
  COD: "剛果民主共和國",
  COG: "剛果共和國",
  COL: "哥倫比亞",
  CPV: "維德角",
  CRI: "哥斯大黎加",
  CUB: "古巴",
  CYP: "賽普勒斯",
  CZE: "捷克",
  DEU: "德國",
  DJI: "吉布地",
  DNK: "丹麥",
  DOM: "多明尼加",
  DZA: "阿爾及利亞",
  ECU: "厄瓜多",
  EGY: "埃及",
  ERI: "厄利垂亞",
  ESP: "西班牙",
  EST: "愛沙尼亞",
  ETH: "衣索比亞",
  FIN: "芬蘭",
  FJI: "斐濟",
  FRA: "法國",
  GAB: "加彭",
  GBR: "英國",
  GEO: "喬治亞",
  GHA: "迦納",
  GIN: "幾內亞",
  GMB: "甘比亞",
  GNB: "幾內亞比索",
  GNQ: "赤道幾內亞",
  GRC: "希臘",
  GTM: "瓜地馬拉",
  GUY: "蓋亞那",
  HKG: "中國香港特別行政區",
  HND: "宏都拉斯",
  HRV: "克羅埃西亞",
  HTI: "海地",
  HUN: "匈牙利",
  IDN: "印尼",
  IND: "印度",
  IRL: "愛爾蘭",
  IRN: "伊朗",
  IRQ: "伊拉克",
  ISL: "冰島",
  ISR: "以色列",
  ITA: "義大利",
  JAM: "牙買加",
  JOR: "約旦",
  JPN: "日本",
  KAZ: "哈薩克",
  KEN: "肯亞",
  KGZ: "吉爾吉斯",
  KHM: "柬埔寨",
  KOR: "韓國",
  KWT: "科威特",
  LAO: "寮國",
  LBN: "黎巴嫩",
  LBR: "賴比瑞亞",
  LBY: "利比亞",
  LKA: "斯里蘭卡",
  LSO: "賴索托",
  LTU: "立陶宛",
  LUX: "盧森堡",
  LVA: "拉脫維亞",
  MAC: "中國澳門特別行政區",
  MAR: "摩洛哥",
  MDA: "摩爾多瓦",
  MDG: "馬達加斯加",
  MEX: "墨西哥",
  MKD: "北馬其頓",
  MLI: "馬利",
  MLT: "馬爾他",
  MMR: "緬甸",
  MNE: "蒙特內哥羅",
  MNG: "蒙古",
  MOZ: "莫三比克",
  MRT: "茅利塔尼亞",
  MUS: "模里西斯",
  MWI: "馬拉威",
  MYS: "馬來西亞",
  NAM: "納米比亞",
  NER: "尼日",
  NGA: "奈及利亞",
  NIC: "尼加拉瓜",
  NLD: "荷蘭",
  NOR: "挪威",
  NPL: "尼泊爾",
  NZL: "紐西蘭",
  OMN: "阿曼",
  PAK: "巴基斯坦",
  PAN: "巴拿馬",
  PER: "祕魯",
  PHL: "菲律賓",
  PNG: "巴布亞紐幾內亞",
  POL: "波蘭",
  PRK: "北韓",
  PRT: "葡萄牙",
  PRY: "巴拉圭",
  PSE: "巴勒斯坦",
  QAT: "卡達",
  ROU: "羅馬尼亞",
  RUS: "俄羅斯",
  RWA: "盧安達",
  SAU: "沙烏地阿拉伯",
  SDN: "蘇丹",
  SEN: "塞內加爾",
  SGP: "新加坡",
  SLB: "索羅門群島",
  SLE: "獅子山",
  SLV: "薩爾瓦多",
  SOM: "索馬利亞",
  SRB: "塞爾維亞",
  SSD: "南蘇丹",
  SUR: "蘇利南",
  SVK: "斯洛伐克",
  SVN: "斯洛維尼亞",
  SWE: "瑞典",
  SWZ: "史瓦帝尼",
  SYR: "敘利亞",
  TCD: "查德",
  TGO: "多哥",
  THA: "泰國",
  TJK: "塔吉克",
  TKM: "土庫曼",
  TLS: "東帝汶",
  TON: "東加",
  TUN: "突尼西亞",
  TUR: "土耳其",
  TWN: "中國台灣地區",
  TZA: "坦尚尼亞",
  UGA: "烏干達",
  UKR: "烏克蘭",
  URY: "烏拉圭",
  USA: "美國",
  UZB: "烏茲別克",
  VEN: "委內瑞拉",
  VNM: "越南",
  VUT: "萬那杜",
  WSM: "薩摩亞",
  YEM: "葉門",
  ZAF: "南非",
  ZMB: "尚比亞",
  ZWE: "辛巴威"
});

/** 取繁中名稱；對照表未收錄時回退為資料包原文（永不拋錯）。 */
function zhHantCountryName(regionCode: string, nameZhHans: string): string {
  if (!Object.prototype.hasOwnProperty.call(P3E_ZH_HANT_COUNTRY_NAMES, regionCode)) return nameZhHans;
  return P3E_ZH_HANT_COUNTRY_NAMES[regionCode] ?? nameZhHans;
}

/* ------------------------------------------------------------------ */
/* 深層凍結                                                            */
/* ------------------------------------------------------------------ */

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把已驗證的出生證書彙整成可安全顯示的出生預覽。
 *
 * 純函式：不讀 pack、不抽隨機值、不改寫證書；輸出深層凍結且可 JSON 序列化。
 * 同一張證書永遠得到逐位元相同的預覽。
 */
export function buildP3EBirthPreview(certificate: BirthCertificateSnapshot): P3EBrowserBirthPreview {
  const player = certificate.player;
  const family = player.family;

  return deepFreeze({
    certificateId: certificate.certificateId,
    certificateHash: certificate.certificateHash,
    playerIdentityHash: player.identityHash,
    birthYear: player.birth.birthYear,
    country: {
      regionCode: player.birth.regionCode,
      region: player.birth.region,
      nameZhHant: zhHantCountryName(player.birth.regionCode, player.birth.displayNameZhHans),
      nameZhHans: player.birth.displayNameZhHans
    },
    name: {
      fullName: player.name.fullName,
      surname: player.name.surname,
      givenName: player.name.givenName
    },
    sex: player.birth.sex,
    settlement: family.settlement,
    settlementLabel: P2B_SETTLEMENT_LABELS[family.settlement],
    /* 證書在建立時已由 assertFamilyShape 驗證 incomeQuintile ∈ 1..5。 */
    incomeQuintile: family.incomeQuintile as IncomeQuintile,
    incomeLabel: family.incomeLabel,
    housing: { id: family.housing, label: family.housingLabel },
    parents: {
      motherAge: family.motherAge,
      fatherAge: family.fatherAge,
      motherOccupationLabel: family.motherOccupationLabel,
      fatherOccupationLabel: family.fatherOccupationLabel
    },
    religion: { id: family.religionId, label: family.religionLabel },
    lifeExpectancyYearsX10: player.vitals.lifeExpectancyYearsX10,
    lifeExpectancyYears: player.vitals.lifeExpectancyYearsX10 / 10,
    story: {
      templateId: player.story.templateId,
      paragraphs: [...player.story.paragraphs]
    }
  });
}
