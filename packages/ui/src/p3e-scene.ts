/**
 * GPT-WORKBUDDY-0063-B／DAYU-0073-A｜精確年齡 × 年齡專用全身人物場景（純函式、無 DOM、無 CDN）。
 *
 * ## 為什麼重寫
 *
 * 0062-B 讓 0–22 歲共用同一張「官方成人 Standing」Open Peeps，只靠縮放表達
 * 年齡。CTO 由 `work/GPT-0062/screenshots/00-真实开局-390x844.png` 判定：
 * 0 歲嬰兒其實是縮小的成年女性、學生是縮小的成年男性，不合格。
 *
 * 0063-B 的修法：
 * - application 的 `view.scene` 現在提供**精確 `age`**、六段 `ageStage`、
 *   八段 `lifeStage` 與 `partnerAge`（正式 session/view，不從畫面文字反解析）。
 * - 0–22 歲改用 20 個**本專案衍生**的年齡專用全身 SVG（baby／child／primary／
 *   teen／university × 4 identity series），沿用 Open Peeps CC0 手繪筆觸；
 *   來源與「非官方原件」標示見 `assets/generated/open-peeps/derived/DERIVED-SOURCE.md`。
 * - 23 歲以上才沿用 0062-B 的 8 個官方成人 Standing 成品。
 *
 * ## 0073-A：改用「量測錨點」而不是全域比例
 *
 * 0073 回報的三個缺陷（人物與配件超出可顯示區、姿勢怪異、眼鏡落到脖子）根因是
 * 配件位置用 `top + 人物高度 × 固定比例` 猜。官方 Open Peeps 的 `viewBox` 只是
 * **寬高**、不是內容範圍，頭身比／眼睛高度／手的位置每個資產都不一樣；
 * derived 人物又是另一套座標系。同一個比例不可能對。
 *
 * 現在：
 * - 每個資產都有 `PEEP_ANCHORS`（`p3e-peep-anchors.ts`，由 `scripts/p3e-0073-peep-anchors.mjs`
 *   渲染後量測）：可見內容範圍、頭框、眼睛中心／眼距、肩線、手、腳底。
 * - 配件（眼鏡／圍巾／拐杖）在**資產自己的座標系**裡畫，直接吃眼睛／肩線／手
 *   的座標，所以永遠黏在正確的身體部位；縮放與翻譯只作用在外層 `<g>`。
 * - 人物 + 已啟用配件的**總 bounds** 才決定 scale／translate：先滿足身高，
 *   再被「安全區寬度／可用高度」夾住，腳底一律貼齊 `SCENE_GROUND_Y`。
 * - 根 SVG 由 `slice` 改成 `xMidYMax meet`，CSS 用 `contain`，所以手機上不會
 *   再把人物裁掉（背景可另外 cover）。
 *
 * ## identity 穩定
 *
 * - `(seed, role, sex)` 決定 series、膚色、基礎髮色、衣著色；**不含年齡、
 *   伴侶／寵物狀態**，所以同一人跨 0→65 歲是同一個人，只合理換比例與服裝。
 * - 伴侶直接用 `scene.partnerSex`；伴侶年齡用 `scene.partnerAge`（正式投影）
 *   推導 lifeStage，玩家 6 歲時旁邊不會出現成年伴侶，也不會切換性別。
 *
 * ## 圖層與決定性
 *
 * `background`（urban／rural）＋`player`＋`partner`＋`pet`（dog／cat／none）。
 * 外觀是 `(scene, seed)` 的純函式（FNV-1a），無 `Math.random`、無 `Date`、
 * 無外部網域。輸出為單張 `data:image/svg+xml` 背景圖，`.p3e-scene` 仍是 0 個子節點。
 */

import {
  OPEN_PEEPS_ASSETS,
  OPEN_PEEPS_BY_SEX,
  openPeepsAsset,
  openPeepsMarkup,
  type OpenPeepsAsset,
  type OpenPeepsColors,
  type OpenPeepsKey
} from "./p3e-open-peeps.js";
import {
  DERIVED_PEEPS_ASSETS,
  derivedPeepAsset,
  derivedPeepMarkup,
  derivedPeepOf,
  type DerivedLifeStage,
  type DerivedPeepAsset,
  type DerivedPeepColors,
  type DerivedSeries
} from "./p3e-open-peeps-derived.js";
import { peepAnchors, type PeepAnchors, type PeepBox } from "./p3e-peep-anchors.js";

export type { PeepAnchors, PeepBox };

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

export type SceneSex = "male" | "female";
/** 0063-B：0–2 baby、3–5 child、6–22 student、23–39 young、40–59 middle、60+ senior。 */
export type SceneAgeStage = "baby" | "child" | "student" | "young" | "middle" | "senior";
/** student 再切小學／青少年／大學，讓人物尺寸與服裝真的跟著成長。 */
export type SceneLifeStage =
  | "baby"
  | "child"
  | "primary"
  | "teen"
  | "university"
  | "young"
  | "middle"
  | "senior";
export type SceneResidenceKind = "urban" | "rural";
export type ScenePetKind = "none" | "dog" | "cat";
export type ScenePhase = "alive" | "dead";

/** 與 application 的 `P3EScene` 相同形狀；UI 只讀這份投影，不碰 flags。 */
export interface SceneView {
  readonly playerSex: SceneSex;
  /** 正式 `state.age` 的精確年齡；死亡後凍結。 */
  readonly age: number;
  readonly ageStage: SceneAgeStage;
  readonly lifeStage: SceneLifeStage;
  readonly residenceKind: SceneResidenceKind;
  readonly hasPartner: boolean;
  readonly partnerSex: SceneSex | null;
  readonly partnerAge: number | null;
  readonly petKind: ScenePetKind;
  readonly phase: ScenePhase;
}

/** 投影缺席／畸形時的安全預設值：0 歲嬰兒，不猜測人物狀態。 */
export const DEFAULT_SCENE_VIEW: SceneView = Object.freeze({
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
});

export type SceneLayerId = "background" | "player" | "partner" | "pet";

export interface SceneLayerDescriptor {
  readonly layer: SceneLayerId;
  readonly visible: boolean;
  /** 穩定外觀指紋：同 seed／同狀態相同，狀態改變時可觀察到差異。 */
  readonly key: string;
}

/** 單一角色實際用到的資產／部件 key（矩陣測試直接斷言，不看 DOM）。 */
export interface ScenePartDescriptor {
  readonly role: "player" | "partner";
  readonly sex: SceneSex;
  readonly age: number;
  readonly ageStage: SceneAgeStage;
  readonly lifeStage: SceneLifeStage;
  /** `openpeeps/<official>` 或 `openpeeps-derived/<derived>`。 */
  readonly asset: string;
  /** 成人是 `openpeeps/pose/standing/*`；嬰幼兒／學生永遠是衍生 body key。 */
  readonly body: string;
  readonly head: string;
  readonly face: string;
  /** identity 髮型 key：衍生階段同一 series 跨年齡完全相同。 */
  readonly hair: string;
  readonly glasses: string | null;
  readonly derived: boolean;
  /** 跨年齡不變的身分指紋（性別／series／膚色／基礎髮色／衣著色）。 */
  readonly identity: string;
  readonly parts: readonly string[];
}

/** 場景座標裡的配件幾何（測試直接斷言這些數字，不看字串）。 */
export interface SceneGlassesGeometry {
  /** 兩眼中心連線的中點。 */
  readonly cx: number;
  readonly cy: number;
  /** 單片鏡框的半寬／半高。 */
  readonly rx: number;
  readonly ry: number;
  /** 兩眼到臉中線的距離（鏡片中心距離）。 */
  readonly halfGap: number;
  readonly box: PeepBox;
}

export interface SceneScarfGeometry {
  readonly cx: number;
  readonly cy: number;
  readonly halfWidth: number;
  readonly bandHeight: number;
  readonly box: PeepBox;
}

export interface SceneCaneGeometry {
  /** 杖身 x（在身體外側）。 */
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
  readonly hookRadius: number;
  readonly side: "left" | "right";
  readonly box: PeepBox;
}

/** 一個角色在場景座標裡的完整幾何：給測試與瀏覽器驗收用。 */
export interface SceneActorGeometry {
  readonly role: "player" | "partner";
  readonly asset: string;
  readonly assetKey: string;
  readonly scale: number;
  /** 人物本體（不含配件）在場景座標的範圍。 */
  readonly content: PeepBox;
  /** 人物 + 已啟用配件在場景座標的總範圍。 */
  readonly bounds: PeepBox;
  readonly head: PeepBox;
  readonly eye: { readonly cx: number; readonly cy: number; readonly halfGap: number; readonly radius: number };
  readonly glasses: SceneGlassesGeometry | null;
  readonly scarf: SceneScarfGeometry | null;
  readonly cane: SceneCaneGeometry | null;
}

/* ------------------------------------------------------------------ */
/* 安全讀取（白名單）                                                   */
/* ------------------------------------------------------------------ */

const SEXES: readonly string[] = ["male", "female"];
const AGE_STAGES: readonly string[] = ["baby", "child", "student", "young", "middle", "senior"];
const LIFE_STAGES: readonly string[] = [
  "baby", "child", "primary", "teen", "university", "young", "middle", "senior"
];
const RESIDENCES: readonly string[] = ["urban", "rural"];
const PETS: readonly string[] = ["none", "dog", "cat"];
const PHASES: readonly string[] = ["alive", "dead"];
const DERIVED_STAGES: readonly SceneLifeStage[] = ["baby", "child", "primary", "teen", "university"];
const SERIES_KEYS: readonly DerivedSeries[] = ["a", "b", "c", "d"];

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick<T extends string>(value: unknown, allowed: readonly string[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : fallback;
}

function pickOrNull<T extends string>(value: unknown, allowed: readonly string[]): T | null {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : null;
}

/** 與 application `sceneAgeStageOf` 完全相同的六段閾值。 */
export function ageStageOfAge(age: number): SceneAgeStage {
  if (age <= 2) return "baby";
  if (age <= 5) return "child";
  if (age <= 22) return "student";
  if (age <= 39) return "young";
  if (age <= 59) return "middle";
  return "senior";
}

/** 與 application `sceneLifeStageOf` 完全相同的八段閾值。 */
export function lifeStageOfAge(age: number): SceneLifeStage {
  if (age <= 2) return "baby";
  if (age <= 5) return "child";
  if (age <= 11) return "primary";
  if (age <= 17) return "teen";
  if (age <= 22) return "university";
  if (age <= 39) return "young";
  if (age <= 59) return "middle";
  return "senior";
}

function isDerivedStage(stage: SceneLifeStage): stage is DerivedLifeStage {
  return DERIVED_STAGES.includes(stage);
}

/** 舊投影（只有 ageStage）用的代表年齡，讓缺 age 時也不會把嬰兒畫成成人。 */
const AGE_STAGE_REPRESENTATIVE: Readonly<Record<SceneAgeStage, number>> = Object.freeze({
  baby: 0,
  child: 4,
  student: 13,
  young: 28,
  middle: 48,
  senior: 68
});

function readAge(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 130
    ? Math.floor(value)
    : fallback;
}

/**
 * 由 `session.view` 讀出場景投影。只認 `view.scene` 的公開欄位，
 * **不解析 flags、不從畫面文字反解析年齡**；缺欄位就用安全預設值。
 * 若 `age` 存在，一律以它重新正規化 `ageStage`／`lifeStage`，
 * 杜絕「HUD 0 歲但場景塞成人」的不一致。
 */
export function readSceneView(view: unknown): SceneView {
  const scene = record(record(view).scene);
  const projectedStage = pickOrNull<SceneAgeStage>(scene.ageStage, AGE_STAGES);
  const fallbackAge = AGE_STAGE_REPRESENTATIVE[projectedStage ?? DEFAULT_SCENE_VIEW.ageStage] as number;
  const agePresent = typeof scene.age === "number" && Number.isFinite(scene.age) &&
    scene.age >= 0 && scene.age <= 130;
  const age = readAge(scene.age, fallbackAge);
  const ageStage = agePresent
    ? ageStageOfAge(age)
    : (projectedStage ?? DEFAULT_SCENE_VIEW.ageStage);
  const projectedLifeStage = pickOrNull<SceneLifeStage>(scene.lifeStage, LIFE_STAGES);
  const lifeStage = agePresent
    ? lifeStageOfAge(age)
    : (projectedLifeStage ?? lifeStageOfAge(age));
  const hasPartner = scene.hasPartner === true;
  return Object.freeze({
    playerSex: pick<SceneSex>(scene.playerSex, SEXES, DEFAULT_SCENE_VIEW.playerSex),
    age,
    ageStage,
    lifeStage,
    residenceKind: pick<SceneResidenceKind>(scene.residenceKind, RESIDENCES, DEFAULT_SCENE_VIEW.residenceKind),
    hasPartner,
    partnerSex: pickOrNull<SceneSex>(scene.partnerSex, SEXES),
    // 舊投影沒有 partnerAge 時用同年齡，避免未成年玩家旁邊出現成年伴侶。
    partnerAge: hasPartner ? readAge(scene.partnerAge, age) : null,
    petKind: pick<ScenePetKind>(scene.petKind, PETS, DEFAULT_SCENE_VIEW.petKind),
    phase: pick<ScenePhase>(scene.phase, PHASES, DEFAULT_SCENE_VIEW.phase)
  });
}

/* ------------------------------------------------------------------ */
/* 決定性外觀                                                          */
/* ------------------------------------------------------------------ */

/** FNV-1a 32-bit：純字串雜湊，無隨機、無時間。 */
export function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const SKIN_TONES: readonly string[] = ["#f6d3b0", "#efc39d", "#dba77f", "#b9815c", "#8f5e42"];
const HAIR_COLORS: readonly string[] = ["#3a2a20", "#5a3a22", "#7b4b2a", "#2f2a28", "#8a6a3f", "#4b3326"];
const CLOTHES_COLORS: readonly string[] = [
  "#6d9bb5", "#c97a68", "#7fa77c", "#b58a55", "#8a78a6", "#4f8f86", "#d0a24f", "#7089a3"
];
const SENIOR_HAIR = "#d9d3c6";
const INK = "#3f332b";
const STROKE = "#4a3b32";
const BLUSH = "#e98f9b";
const SCARF_FILL = "#e2a94d";
const SCARF_SHADE = "#c8893a";
const CANE_WOOD = "#8a5f3a";

/**
 * 各生活階段的**目標人物內容高度**（不是外框高度）。實際高度還會被
 * 「安全區可用高度」與「slot 寬度」夾住，見 `actorLayoutOf()`。
 */
const STAGE_HEIGHT: Readonly<Record<SceneLifeStage, number>> = Object.freeze({
  baby: 104,
  child: 120,
  primary: 136,
  teen: 150,
  university: 158,
  young: 166,
  middle: 160,
  senior: 150
});

/** 衍生 SVG 內建的年齡配件 key（與 data-part 一致，供測試直接斷言）。 */
const DERIVED_ITEM_KEYS: Readonly<Record<DerivedLifeStage, readonly string[]>> = Object.freeze({
  baby: Object.freeze([] as string[]),
  child: Object.freeze(["openpeeps-derived/item/toddler-bib"]),
  primary: Object.freeze([
    "openpeeps-derived/item/school-bag-straps",
    "openpeeps-derived/item/neckerchief"
  ]),
  teen: Object.freeze([
    "openpeeps-derived/item/hood",
    "openpeeps-derived/item/crossbody-bag"
  ]),
  university: Object.freeze([
    "openpeeps-derived/item/backpack",
    "openpeeps-derived/item/cardigan"
  ])
});

/** 新伴侶可帶入穩定姓名／身分；玩家永遠只用前半段 seed。 */
const PARTNER_SEED_MARK = "|partner-identity=";

function seedForRole(seed: string, role: "player" | "partner"): string {
  const at = seed.indexOf(PARTNER_SEED_MARK);
  const base = at === -1 ? seed : seed.slice(0, at);
  if (role === "player") return base;
  return at === -1 ? `${base}|partner` : `${base}|partner${seed.slice(at)}`;
}

/** 性別角色池 + 穩定 seed → 官方成人資產。identity 只由 (seed, role, sex) 决定。 */
export function openPeepsAssetOf(sex: SceneSex, seed: string, role: "player" | "partner"): OpenPeepsKey {
  const pool = OPEN_PEEPS_BY_SEX[sex];
  const index = hash32(`${seed}|${role}|${sex}|series`) % pool.length;
  return pool[index] as OpenPeepsKey;
}

/** 穩定 identity series（a／b／c／d），衍生與官方資產共用。 */
export function identitySeriesOf(sex: SceneSex, seed: string, role: "player" | "partner"): DerivedSeries {
  const base = seedForRole(seed, role);
  return SERIES_KEYS[hash32(`${base}|${role}|${sex}|series`) % SERIES_KEYS.length] as DerivedSeries;
}

interface Appearance {
  readonly assetKey: string;
  /** `openpeeps/<key>` 或 `openpeeps-derived/<key>`。 */
  readonly asset: string;
  readonly body: string;
  readonly head: string;
  readonly face: string;
  readonly hair: string;
  readonly glasses: string | null;
  readonly derived: boolean;
  readonly identity: string;
  readonly partKeys: readonly string[];
  readonly height: number;
  readonly markup: string;
  readonly hairColor: string;
  readonly clothesColor: string;
  readonly skinColor: string;
  readonly glassesOn: boolean;
  readonly cane: boolean;
  readonly scarf: boolean;
  readonly key: string;
}

interface PeepColors {
  readonly ink: string;
  readonly clothes: string;
  readonly hair: string;
  readonly skin: string;
}

/**
 * 外觀只由 (seed, role, sex) 決定身份；lifeStage 只允許比例、合理服裝、
 * 老年白髮與配件增量。交伴侶／養寵物不會改玩家的角色資產。
 */
function appearanceOf(
  sex: SceneSex,
  lifeStage: SceneLifeStage,
  seed: string,
  role: "player" | "partner"
): Appearance {
  const base = seedForRole(seed, role);
  const series = identitySeriesOf(sex, base, role);
  const seriesIndex = SERIES_KEYS.indexOf(series);
  const skinColor = SKIN_TONES[hash32(`${base}|${role}|${sex}|skin`) % SKIN_TONES.length] as string;
  const hairBase = HAIR_COLORS[hash32(`${base}|${role}|${sex}|hair`) % HAIR_COLORS.length] as string;
  const hairColor = lifeStage === "senior" ? SENIOR_HAIR : hairBase;
  const clothesColor = CLOTHES_COLORS[hash32(`${base}|${role}|${sex}|clothes`) % CLOTHES_COLORS.length] as string;
  const colors: PeepColors = Object.freeze({
    ink: INK, clothes: clothesColor, hair: hairColor, skin: skinColor
  });

  const derived = isDerivedStage(lifeStage);
  let assetKey: string;
  let body: string;
  let head: string;
  let face: string;
  let hair: string;
  let markup: string;
  let assetParts: readonly string[];

  if (derived) {
    const key = derivedPeepOf(lifeStage, series);
    const info: DerivedPeepAsset = derivedPeepAsset(key);
    assetKey = key;
    body = info.body;
    head = info.head;
    face = info.face;
    hair = info.hair;
    markup = derivedPeepMarkup(key, colors as DerivedPeepColors);
    assetParts = Object.freeze([
      info.pose,
      info.body,
      info.head,
      info.face,
      info.hair,
      ...DERIVED_ITEM_KEYS[info.stage]
    ]);
  } else {
    const key = OPEN_PEEPS_BY_SEX[sex][seriesIndex] as OpenPeepsKey;
    const info: OpenPeepsAsset = openPeepsAsset(key);
    assetKey = key;
    const groups: readonly string[] = info.groups;
    body = `openpeeps/${groups.find((group) => group.startsWith("pose/")) ?? "pose/standing"}`;
    head = `openpeeps/${groups.find((group) => group.startsWith("head/")) ?? "head"}`;
    face = `openpeeps/${groups.find((group) => group.startsWith("face/")) ?? "face"}`;
    hair = head;
    markup = openPeepsMarkup(key, colors as OpenPeepsColors);
    assetParts = Object.freeze(groups.map((group) => `openpeeps/${group}`));
  }

  const glassesOn = lifeStage === "senior";
  const cane = lifeStage === "senior";
  const scarf = lifeStage === "middle" || lifeStage === "senior";
  const partKeys: readonly string[] = Object.freeze([
    derived ? `openpeeps-derived/${assetKey}` : `openpeeps/${assetKey}`,
    body,
    head,
    face,
    hair,
    ...assetParts,
    ...(scarf ? ["original/item/scarf"] : []),
    ...(glassesOn ? ["original/item/reading-glasses", "original/face/wrinkles"] : []),
    ...(cane ? ["original/item/cane"] : [])
  ]);
  const identity = `${sex}/${series}/${skinColor}/${hairBase}/${clothesColor}`;
  return {
    assetKey,
    asset: derived ? `openpeeps-derived/${assetKey}` : `openpeeps/${assetKey}`,
    body,
    head,
    face,
    hair,
    glasses: glassesOn ? "original/item/reading-glasses" : null,
    derived,
    identity,
    partKeys,
    height: STAGE_HEIGHT[lifeStage],
    markup,
    hairColor,
    clothesColor,
    skinColor,
    glassesOn,
    cane,
    scarf,
    key: `${sex}/${lifeStage}/${assetKey}/${hairColor}/${clothesColor}/${skinColor}/${identity}`
  };
}

/** 伴侶沒給性別時的安全預設（正常路徑一律直接用 scene.partnerSex）。 */
function oppositeSex(sex: SceneSex): SceneSex {
  return sex === "male" ? "female" : "male";
}

/**
 * 伴侶的年齡直接來自正式投影 `scene.partnerAge`；玩家未成年時伴侶也是
 * 同年齡層，不會突然出現成年伴侶。性別永遠用 `scene.partnerSex`。
 */
function partnerIdentity(scene: SceneView): {
  readonly sex: SceneSex;
  readonly age: number;
  readonly ageStage: SceneAgeStage;
  readonly lifeStage: SceneLifeStage;
} {
  const sex = scene.partnerSex ?? oppositeSex(scene.playerSex);
  const age = scene.partnerAge ?? scene.age;
  return Object.freeze({
    sex,
    age,
    ageStage: ageStageOfAge(age),
    lifeStage: lifeStageOfAge(age)
  });
}

/* ------------------------------------------------------------------ */
/* 場景座標與安全區                                                     */
/* ------------------------------------------------------------------ */

export const SCENE_VIEWBOX_WIDTH = 390;
export const SCENE_VIEWBOX_HEIGHT = 220;
/** 地面線（腳底）。 */
export const SCENE_GROUND_Y = 196;
/** 左側狀態卡在 390px 寬時約占 x=16..173；人物全部排在安全區右側。 */
export const SCENE_SAFE_LEFT_X = 190;
/** 右緣留 4px 給描邊與拐杖勾。 */
export const SCENE_SAFE_RIGHT_X = 386;
/** 上緣留 6px 給頭髮／帽兜。 */
export const SCENE_SAFE_TOP_Y = 6;
/** 下緣：地面再加 6px 給腳底陰影。 */
export const SCENE_SAFE_BOTTOM_Y = 202;

export const PLAYER_CENTER_X = 230;
export const PARTNER_CENTER_X = 308;
export const PET_CENTER_X = 356;

/** 每個角色可用的水平額度（保證不會跨到隔壁角色）。 */
interface PeepSlot {
  readonly centerX: number;
  readonly maxWidth: number;
  /** 拐杖放在身體哪一側（外側，避免擋住隔壁的人）。 */
  readonly caneSide: "left" | "right";
}

const PLAYER_SLOT: PeepSlot = Object.freeze({ centerX: PLAYER_CENTER_X, maxWidth: 80, caneSide: "left" });
const PARTNER_SLOT: PeepSlot = Object.freeze({ centerX: PARTNER_CENTER_X, maxWidth: 68, caneSide: "right" });

function rect(x: number, y: number, w: number, h: number, fill: string, extra = ""): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
}

function n(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/* ------------------------------------------------------------------ */
/* 配件幾何（資產座標系）                                               */
/* ------------------------------------------------------------------ */

interface GlassesSpec {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly halfGap: number;
  readonly temple: number;
  readonly strokeWidth: number;
  readonly box: PeepBox;
}

interface ScarfSpec {
  readonly cx: number;
  readonly cy: number;
  readonly halfWidth: number;
  readonly bandHeight: number;
  readonly strokeWidth: number;
  readonly box: PeepBox;
}

interface CaneSpec {
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
  readonly hookRadius: number;
  readonly side: "left" | "right";
  readonly strokeWidth: number;
  readonly box: PeepBox;
}

/** 線寬跟著人物大小走，所以縮放後所有階段的線重看起來一致。 */
function strokeOf(anchors: PeepAnchors): number {
  const contentHeight = anchors.content.bottom - anchors.content.top;
  return Math.max(1, contentHeight * 0.0125);
}

/**
 * 眼鏡：鏡片中心**就是**量測到的眼睛中心（含左右眼距），
 * 鏡框大小由頭寬與眼距決定，不隨全身高度縮放。
 */
function glassesSpecOf(anchors: PeepAnchors, strokeWidth: number): GlassesSpec {
  const headWidth = anchors.head.right - anchors.head.left;
  // 眼距是「兩眼中心距離」的量測值，鏡片半徑以它為基準，鏡框才會剛好框住眼睛。
  const halfGap = anchors.eye.halfGap;
  const rx = Math.min(headWidth * 0.26, Math.max(halfGap * 1.12, anchors.eye.radius * 1.4));
  const ry = rx * 0.86;
  const cx = anchors.eye.cx;
  const cy = anchors.eye.cy;
  const temple = Math.min(headWidth * 0.1, Math.max(rx * 0.45, 1.6));
  return {
    cx,
    cy,
    rx,
    ry,
    halfGap,
    temple,
    // 鏡框線比人物輪廓細一級，否則小尺寸下整片糊成墨鏡。
    strokeWidth: Math.max(anchors.eye.radius * 0.34, strokeWidth * 0.42),
    box: {
      left: cx - halfGap - rx - temple,
      top: cy - ry - strokeWidth,
      right: cx + halfGap + rx + temple,
      bottom: cy + ry + strokeWidth
    }
  };
}

/**
 * 圍巾：繞在**頸部**而不是胸口 —— 上緣緊貼量測到的下巴（head.bottom），
 * 寬度取肩寬的一半左右（不會變成橫在胸前的木板），下襬垂到鎖骨。
 */
function scarfSpecOf(anchors: PeepAnchors, strokeWidth: number): ScarfSpec {
  const headWidth = anchors.head.right - anchors.head.left;
  const contentHeight = anchors.content.bottom - anchors.content.top;
  // 頸圈只比下巴略窄：headWidth 的 0.44，永遠比肩線窄，不會變成橫在胸前的木板。
  const halfWidth = headWidth * 0.40;
  const bandHeight = Math.max(strokeWidth * 2, contentHeight * 0.019);
  const sag = bandHeight * 0.55;
  const cx = anchors.eye.cx;
  // 巾身中心貼在下巴正下方：下巴用**臉部**量測框（face.bottom），不是 head.bottom
  // ——長髮／帽兜資產的 head 群組會一路包到肩膀，用它會把圍巾畫到胸口。
  const chin = Math.min(anchors.face.bottom, anchors.head.bottom);
  const cy = chin + bandHeight * 0.9;
  const tailEndX = cx + halfWidth * 0.66;
  const tailEndY = cy + sag + bandHeight * 2.6;
  // 邊界要蓋住「巾身 + 打結 + 巾尾」三個元素（含外描邊），供安全區計算使用。
  const outer = strokeWidth * 1.5 + 0.5;
  return {
    cx,
    cy,
    halfWidth,
    bandHeight,
    strokeWidth,
    box: {
      left: cx - halfWidth - outer - bandHeight * 0.5,
      top: cy - sag * 0.45 - bandHeight * 0.5 - outer,
      right: Math.max(cx + halfWidth, tailEndX) + outer + bandHeight * 0.41,
      bottom: tailEndY + bandHeight * 0.41 + outer
    }
  };
}

/**
 * 拐杖：杖身貼在量測到的手／袖口外緣（`hand.left` 或 `hand.right`），
 * 上端在手的高度，下端一定踩在地面。放在身體外側，不會穿過身體中央。
 */
function caneSpecOf(anchors: PeepAnchors, side: "left" | "right", strokeWidth: number): CaneSpec {
  const contentHeight = anchors.content.bottom - anchors.content.top;
  // 杖身一定要在**整個身體輪廓之外**：只用手的高度會讓杖身埋進裙襬／大衣裡
  // （實測 female-c 的 hand.left 在身體內側 36 單位），整支拐杖就看不見了。
  const outer = side === "right"
    ? Math.max(anchors.hand.right, anchors.content.right)
    : Math.min(anchors.hand.left, anchors.content.left);
  const x = side === "right" ? outer + strokeWidth * 1.4 : outer - strokeWidth * 1.4;
  const handX = side === "right" ? anchors.hand.right : anchors.hand.left;
  // 握把向身體內側彎，末端剛好落在手的位置，看起來是「握著」而不是「插在身旁」。
  const hookRadius = Math.min(
    Math.max(Math.abs(x - handX), strokeWidth * 1.6),
    contentHeight * 0.075
  );
  const top = anchors.hand.y;
  const bottom = anchors.ground;
  // 握把末端：左側拐杖往右（+x）彎向手，右側拐杖往左（-x）彎向手。
  const handEndX = side === "left" ? x + hookRadius : x - hookRadius;
  return {
    x,
    top,
    bottom,
    hookRadius,
    side,
    strokeWidth,
    box: {
      left: Math.min(x, handEndX) - strokeWidth,
      top: top - hookRadius * 0.25 - strokeWidth,
      right: Math.max(x, handEndX) + strokeWidth,
      bottom: bottom + strokeWidth
    }
  };
}

function unionBox(boxes: readonly PeepBox[]): PeepBox {
  return boxes.reduce<PeepBox>((acc, box) => ({
    left: Math.min(acc.left, box.left),
    top: Math.min(acc.top, box.top),
    right: Math.max(acc.right, box.right),
    bottom: Math.max(acc.bottom, box.bottom)
  }), boxes[0] as PeepBox);
}

/* ------------------------------------------------------------------ */
/* 角色版面（scale／translate 由總 bounds 決定）                        */
/* ------------------------------------------------------------------ */

interface ActorLayout {
  readonly anchors: PeepAnchors;
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
  /** 資產座標 → 場景座標。 */
  readonly bounds: PeepBox;
  readonly content: PeepBox;
  readonly glasses: GlassesSpec | null;
  readonly scarf: ScarfSpec | null;
  readonly cane: CaneSpec | null;
}

function toScene(box: PeepBox, layout: ActorLayout): PeepBox {
  return {
    left: layout.translateX + box.left * layout.scale,
    top: layout.translateY + box.top * layout.scale,
    right: layout.translateX + box.right * layout.scale,
    bottom: layout.translateY + box.bottom * layout.scale
  };
}

/**
 * 先以目標身高決定 scale，再被「可用高度」與 slot 寬度夾住，
 * 最後把**總 bounds 的底端**貼到地面、把人物本體置中到 slot 中心。
 * 若配件讓總寬度超出安全區，整組水平內縮，不靠 `overflow:hidden` 遮掩。
 */
function actorLayoutOf(look: Appearance, slot: PeepSlot): ActorLayout {
  const anchors = peepAnchors(look.assetKey);
  const strokeWidth = strokeOf(anchors);
  const glasses = look.glassesOn ? glassesSpecOf(anchors, strokeWidth) : null;
  const scarf = look.scarf ? scarfSpecOf(anchors, strokeWidth) : null;
  const cane = look.cane ? caneSpecOf(anchors, slot.caneSide, strokeWidth) : null;

  const content = anchors.content;
  const contentHeight = Math.max(1, content.bottom - content.top);
  const parts: PeepBox[] = [content];
  if (glasses !== null) parts.push(glasses.box);
  if (scarf !== null) parts.push(scarf.box);
  if (cane !== null) parts.push(cane.box);
  const union = unionBox(parts);
  const unionWidth = Math.max(1, union.right - union.left);
  const unionHeight = Math.max(1, union.bottom - union.top);

  const maxHeight = SCENE_GROUND_Y - SCENE_SAFE_TOP_Y;
  const scale = Math.min(
    look.height / contentHeight,
    maxHeight / unionHeight,
    slot.maxWidth / unionWidth
  );

  const contentCenterX = (content.left + content.right) / 2;
  let translateX = slot.centerX - contentCenterX * scale;
  let translateY = SCENE_GROUND_Y - union.bottom * scale;

  // 水平再夾一次：配件（拐杖勾）讓總寬度偏一邊時，整組往安全區內縮。
  const left = translateX + union.left * scale;
  const right = translateX + union.right * scale;
  if (left < SCENE_SAFE_LEFT_X) translateX += SCENE_SAFE_LEFT_X - left;
  else if (right > SCENE_SAFE_RIGHT_X) translateX -= right - SCENE_SAFE_RIGHT_X;
  if (translateY + union.top * scale < SCENE_SAFE_TOP_Y) {
    translateY = SCENE_SAFE_TOP_Y - union.top * scale;
  }

  const layout: ActorLayout = {
    anchors,
    scale,
    translateX,
    translateY,
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    content: { left: 0, top: 0, right: 0, bottom: 0 },
    glasses,
    scarf,
    cane
  };
  return {
    ...layout,
    bounds: toScene(union, layout),
    content: toScene(content, layout)
  };
}

/* ------------------------------------------------------------------ */
/* 配件 SVG（直接畫在資產座標系，黏在量測到的身體部位）                  */
/* ------------------------------------------------------------------ */

function glassesMarkup(spec: GlassesSpec): string {
  const sw = n(spec.strokeWidth);
  const leftCx = spec.cx - spec.halfGap;
  const rightCx = spec.cx + spec.halfGap;
  const innerLeft = leftCx + spec.rx;
  const innerRight = rightCx - spec.rx;
  const bridge = innerRight > innerLeft
    ? `<path d="M${n(innerLeft)} ${n(spec.cy)} L${n(innerRight)} ${n(spec.cy)}"/>`
    : `<path d="M${n(innerLeft)} ${n(spec.cy)} q${n((innerRight - innerLeft) / 2)} ${n(-spec.ry * 0.32)} ${n(innerRight - innerLeft)} 0"/>`;
  const templeY = spec.cy - spec.ry * 0.18;
  const leftArm = `<path d="M${n(leftCx - spec.rx)} ${n(templeY)} L${n(leftCx - spec.rx - spec.temple)} ${n(templeY - spec.temple * 0.18)}"/>`;
  const rightArm = `<path d="M${n(rightCx + spec.rx)} ${n(templeY)} L${n(rightCx + spec.rx + spec.temple)} ${n(templeY - spec.temple * 0.18)}"/>`;
  return `<g data-part="original/item/reading-glasses" fill="none" stroke="${STROKE}" stroke-width="${sw}" ` +
    `stroke-linecap="round">` +
    `<ellipse cx="${n(leftCx)}" cy="${n(spec.cy)}" rx="${n(spec.rx)}" ry="${n(spec.ry)}"/>` +
    `<ellipse cx="${n(rightCx)}" cy="${n(spec.cy)}" rx="${n(spec.rx)}" ry="${n(spec.ry)}"/>` +
    bridge + leftArm + rightArm +
    `</g>`;
}

/** 眼角細紋：貼在鏡框下緣外側，不是憑空畫在臉上。 */
function wrinkleMarkup(spec: GlassesSpec): string {
  const sw = n(spec.strokeWidth * 0.7);
  const y = spec.cy + spec.ry + spec.strokeWidth * 1.3;
  const len = spec.rx * 0.55;
  return `<g data-part="original/face/wrinkles" fill="none" stroke="${STROKE}" stroke-width="${sw}" ` +
    `stroke-linecap="round" opacity="0.55">` +
    `<path d="M${n(spec.cx - spec.halfGap - len)} ${n(y)} q${n(len * 0.5)} ${n(-spec.ry * 0.16)} ${n(len)} 0"/>` +
    `<path d="M${n(spec.cx + spec.halfGap - len * 0.5)} ${n(y)} q${n(len * 0.5)} ${n(-spec.ry * 0.16)} ${n(len)} 0"/>` +
    `</g>`;
}

/**
 * 圍巾畫法：用「雙描邊緞帶」——先畫一條較粗的深色線，再在上面疊一條較細的
 * 巾色線，得到有外框、圓頭、沿曲線走的圍巾，而不是一片平板或多邊形。
 * 巾身沿頸部微垂，巾尾從右前側垂到鎖骨下方。
 */
function scarfRibbon(path: string, bandWidth: number, outer: number): string {
  return `<path d="${path}" fill="none" stroke="${STROKE}" stroke-width="${n(bandWidth + outer)}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${path}" fill="none" stroke="${SCARF_FILL}" stroke-width="${n(bandWidth)}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>`;
}

function scarfMarkup(spec: ScarfSpec): string {
  const outer = Math.max(0.6, spec.strokeWidth * 1.35);
  const sag = spec.bandHeight * 0.55;
  const left = spec.cx - spec.halfWidth;
  const right = spec.cx + spec.halfWidth;
  // 頸圈：兩端略高、中央下垂，貼著鎖骨上緣走。
  const band = `M${n(left)} ${n(spec.cy - sag * 0.45)} Q${n(spec.cx)} ${n(spec.cy + sag * 1.6)} ` +
    `${n(right)} ${n(spec.cy - sag * 0.45)}`;
  // 巾尾：從右前側繞下來，末端收在鎖骨下方。
  const tailX = spec.cx + spec.halfWidth * 0.42;
  const tailEndX = spec.cx + spec.halfWidth * 0.66;
  const tail = `M${n(tailX)} ${n(spec.cy + sag * 0.4)} ` +
    `Q${n(tailX + spec.halfWidth * 0.3)} ${n(spec.cy + sag + spec.bandHeight * 1.4)} ` +
    `${n(tailEndX)} ${n(spec.cy + sag + spec.bandHeight * 2.6)}`;
  // 打結處的小結：一顆圓點，讓巾身與巾尾有實體連接。
  const knot = `<circle cx="${n(tailX)}" cy="${n(spec.cy + sag * 0.35)}" r="${n(spec.bandHeight * 0.62)}" ` +
    `fill="${SCARF_SHADE}" stroke="${STROKE}" stroke-width="${n(outer)}"/>`;
  return `<g data-part="original/item/scarf">` +
    scarfRibbon(tail, spec.bandHeight * 0.82, outer) +
    scarfRibbon(band, spec.bandHeight, outer) +
    knot +
    `</g>`;
}

function caneMarkup(spec: CaneSpec): string {
  const sw = n(spec.strokeWidth * 1.5);
  const handX = spec.side === "left" ? spec.x + spec.hookRadius : spec.x - spec.hookRadius;
  // 握把從杖身頂端向身體內側彎到手的位置：看起來是手握著拐杖。
  const curl = spec.hookRadius * 0.5;
  const shaftTop = spec.top + curl;
  const path = `M${n(spec.x)} ${n(spec.bottom)} L${n(spec.x)} ${n(shaftTop)} ` +
    `Q${n(spec.x)} ${n(spec.top - curl * 0.5)} ${n(handX)} ${n(spec.top)}`;
  return `<g data-part="original/item/cane" fill="none" stroke="${CANE_WOOD}" stroke-width="${sw}" ` +
    `stroke-linecap="round"><path d="${path}"/></g>`;
}

function accessoryMarkupOf(layout: ActorLayout): string {
  const parts: string[] = [];
  if (layout.scarf !== null) parts.push(scarfMarkup(layout.scarf));
  if (layout.glasses !== null) {
    parts.push(glassesMarkup(layout.glasses));
    parts.push(wrinkleMarkup(layout.glasses));
  }
  if (layout.cane !== null) parts.push(caneMarkup(layout.cane));
  return parts.join("");
}

/* ------------------------------------------------------------------ */
/* 背景                                                                */
/* ------------------------------------------------------------------ */

/** 背景：只有景物，沒有任何固定人物或雞；urban / rural 顯著不同。 */
function backgroundLayer(scene: SceneView): string {
  const dead = scene.phase === "dead";
  const sky = dead ? "#c6b7a6" : "#f7dca9";
  const sun = dead ? "#d8c0a0" : "#f6b95c";
  const distant = dead ? "#a99a8d" : "#e7b98a";
  const ground = dead ? "#9c8f7c" : "#c9a978";
  const head = `<g data-layer="background" data-residence="${scene.residenceKind}" data-phase="${scene.phase}">` +
    rect(0, 0, SCENE_VIEWBOX_WIDTH, SCENE_VIEWBOX_HEIGHT, sky) +
    `<circle cx="322" cy="38" r="21" fill="${sun}"/>`;

  let scenery: string;
  if (scene.residenceKind === "urban") {
    const buildings: string[] = [];
    // 建物必須鋪滿整個 viewBox 寬度：留白會在右緣出現一條硬邊的遠景色塊。
    const widths = [42, 34, 50, 30, 44, 38, 46, 40, 28];
    let x = 4;
    for (let i = 0; i < widths.length; i += 1) {
      const w = widths[i] as number;
      const h = 62 + ((i * 17) % 46);
      buildings.push(rect(x, SCENE_GROUND_Y - 26 - h, w, h + 26, i % 2 === 0 ? "#7f8fa0" : "#94a1ac"));
      for (let wy = SCENE_GROUND_Y - 18 - h; wy < SCENE_GROUND_Y - 34; wy += 16) {
        for (let wx = x + 7; wx < x + w - 6; wx += 13) {
          buildings.push(rect(wx, wy, 5, 7, dead ? "#c9bdae" : "#f5df9d"));
        }
      }
      x += w + 3;
    }
    scenery =
      rect(0, 118, SCENE_VIEWBOX_WIDTH, 44, distant) +
      buildings.join("") +
      rect(0, SCENE_GROUND_Y - 26, SCENE_VIEWBOX_WIDTH, 26, "#8d7f6b") +
      rect(0, SCENE_GROUND_Y, SCENE_VIEWBOX_WIDTH, SCENE_VIEWBOX_HEIGHT - SCENE_GROUND_Y, ground) +
      rect(0, SCENE_GROUND_Y + 12, SCENE_VIEWBOX_WIDTH, 3, "#b39a72") +
      rect(54, 132, 4, 64, "#5b5347") + `<circle cx="56" cy="130" r="7" fill="#f6d97f"/>` +
      rect(186, 138, 4, 58, "#5b5347") + `<circle cx="188" cy="136" r="7" fill="#f6d97f"/>` +
      rect(0, SCENE_GROUND_Y + 18, SCENE_VIEWBOX_WIDTH, 6, "#7f9a63") +
      rect(0, SCENE_GROUND_Y + 2, 28, 14, "#6f8a55") +
      rect(360, SCENE_GROUND_Y + 2, 30, 14, "#6f8a55");
  } else {
    let fields = "";
    for (let i = 0; i < 5; i += 1) {
      fields += rect(0, 132 + i * 13, SCENE_VIEWBOX_WIDTH, 6, i % 2 === 0 ? "#a8b46d" : "#94a35d");
    }
    let fence = "";
    for (let fx = 6; fx < 380; fx += 26) fence += rect(fx, 172, 3, 20, "#8a6a44");
    scenery =
      `<path d="M0 122 Q60 84 118 120 T236 116 T390 112 L390 150 L0 150 Z" fill="${distant}"/>` +
      fields +
      rect(0, SCENE_GROUND_Y - 24, SCENE_VIEWBOX_WIDTH, 24, "#aebd78") +
      rect(0, SCENE_GROUND_Y, SCENE_VIEWBOX_WIDTH, SCENE_VIEWBOX_HEIGHT - SCENE_GROUND_Y, ground) +
      `<polygon points="24,128 66,100 108,128" fill="#a5573f"/>` +
      rect(32, 128, 68, 44, "#e4cf9f") + rect(58, 144, 18, 28, "#8a6a44") +
      rect(38, 138, 14, 12, "#8ec4d6") + rect(84, 138, 12, 12, "#8ec4d6") +
      `<polygon points="270,134 306,110 342,134" fill="#a5573f"/>` +
      rect(278, 134, 56, 38, "#e4cf9f") + rect(300, 148, 14, 24, "#8a6a44") +
      rect(196, 142, 9, 32, "#7b5b3a") + `<circle cx="200" cy="136" r="22" fill="#6f9a5a"/>` +
      `<circle cx="188" cy="128" r="13" fill="#7faa67"/>` +
      fence +
      rect(0, 173, SCENE_VIEWBOX_WIDTH, 3, "#8a6a44");
  }
  return `${head}${scenery}</g>`;
}

/* ------------------------------------------------------------------ */
/* 人物圖層                                                            */
/* ------------------------------------------------------------------ */

/**
 * 人物：一張完整全身 SVG（衍生或官方）＋在**同一座標系**畫的配件，
 * 外層只有一個 `translate() scale()`，所以配件不可能相對身體漂移。
 */
function personLayer(
  seed: string,
  role: "player" | "partner",
  sex: SceneSex,
  age: number,
  ageStage: SceneAgeStage,
  lifeStage: SceneLifeStage,
  slot: PeepSlot
): string {
  const look = appearanceOf(sex, lifeStage, seed, role);
  const layout = actorLayoutOf(look, slot);
  const content = layout.content;
  const contentWidth = content.right - content.left;
  const contentHeight = content.bottom - content.top;
  const centerX = (content.left + content.right) / 2;

  const shadow = `<ellipse cx="${n(centerX)}" cy="${n(SCENE_GROUND_Y + 2)}" rx="${n(Math.max(9, contentWidth * 0.42))}" ry="4" fill="rgba(74,59,50,0.20)"/>`;
  // 柔和色塊讓線稿在場景中更清楚，但限制在人物內容框內，不會變成頭上的光暈。
  const halo = `<ellipse cx="${n(centerX)}" cy="${n((content.top + content.bottom) / 2)}" ` +
    `rx="${n(contentWidth * 0.56)}" ry="${n(contentHeight * 0.5)}" fill="${look.clothesColor}" opacity="0.12"/>`;

  return `<g data-layer="${role}" data-sex="${sex}" data-age="${age}" ` +
    `data-age-stage="${ageStage}" data-life-stage="${lifeStage}" ` +
    `data-body="${look.body}" data-asset="${look.asset}" data-derived="${look.derived}" ` +
    `data-identity="${look.identity}" data-variant="${look.key}" ` +
    `data-parts="${look.partKeys.join(" ")}" ` +
    `data-scale="${n(layout.scale)}" data-bounds="${n(layout.bounds.left)},${n(layout.bounds.top)},${n(layout.bounds.right)},${n(layout.bounds.bottom)}">` +
    shadow + halo +
    `<g transform="translate(${n(layout.translateX)} ${n(layout.translateY)}) scale(${n(layout.scale)})">` +
    `<g data-part="${look.asset}">${look.markup}</g>` +
    accessoryMarkupOf(layout) +
    `</g></g>`;
}

/** 寵物：dog／cat 皆為本專案原創圓潤手繪曲線（0062-B 起不再使用 Humation 貓部件）。 */
function petLayer(pet: Exclude<ScenePetKind, "none">): string {
  const cx = PET_CENTER_X;
  const shadow = `<ellipse cx="${cx}" cy="${SCENE_GROUND_Y + 1}" rx="17" ry="3" fill="rgba(74,59,50,0.20)"/>`;
  if (pet === "cat") {
    const bodyY = SCENE_GROUND_Y - 19;
    const fur = "#d7a15c";
    const parts: string[] = [shadow];
    parts.push(`<path d="M${cx + 13} ${bodyY + 3} q14 -1 11 -17" fill="none" stroke="${STROKE}" stroke-width="3.4" stroke-linecap="round"/>`);
    parts.push(`<ellipse cx="${cx + 4}" cy="${bodyY + 6}" rx="15" ry="11" fill="${fur}" stroke="${STROKE}" stroke-width="1.6"/>`);
    parts.push(`<circle cx="${cx - 11}" cy="${bodyY - 2}" r="10" fill="${fur}" stroke="${STROKE}" stroke-width="1.6"/>`);
    parts.push(`<polygon points="${cx - 19},${bodyY - 9} ${cx - 16},${bodyY - 20} ${cx - 9},${bodyY - 11}" fill="${fur}" stroke="${STROKE}" stroke-width="1.4"/>`);
    parts.push(`<polygon points="${cx - 4},${bodyY - 11} ${cx - 1},${bodyY - 20} ${cx + 2},${bodyY - 8}" fill="${fur}" stroke="${STROKE}" stroke-width="1.4"/>`);
    parts.push(`<circle cx="${cx - 14}" cy="${bodyY - 3}" r="1.5" fill="${STROKE}"/>`);
    parts.push(`<circle cx="${cx - 8}" cy="${bodyY - 3}" r="1.5" fill="${STROKE}"/>`);
    parts.push(`<ellipse cx="${cx - 11}" cy="${bodyY + 2}" rx="2.6" ry="1.9" fill="${BLUSH}"/>`);
    parts.push(`<path d="M${cx - 13} ${bodyY + 4} l-7 -2 M${cx - 13} ${bodyY + 6} l-7 2 M${cx - 9} ${bodyY + 4} l7 -2 M${cx - 9} ${bodyY + 6} l7 2" fill="none" stroke="${STROKE}" stroke-width="0.9"/>`);
    for (const lx of [cx - 4, cx + 2, cx + 10, cx + 16]) {
      parts.push(rect(lx, bodyY + 13, 4, 7, "#a9713f", ` rx="2" stroke="${STROKE}" stroke-width="1"`));
    }
    return `<g data-layer="pet" data-pet="cat" data-part="original/pet/cat">${parts.join("")}</g>`;
  }
  const bodyY = SCENE_GROUND_Y - 20;
  const fur = "#b98249";
  const dark = "#8a5a30";
  const parts: string[] = [shadow];
  parts.push(`<path d="M${cx + 18} ${bodyY + 4} q12 -3 9 -15" fill="none" stroke="${dark}" stroke-width="4" stroke-linecap="round"/>`);
  for (const lx of [cx - 10, cx - 3, cx + 7, cx + 14]) {
    parts.push(rect(lx, bodyY + 12, 5, 10, dark, ` rx="2.5" stroke="${STROKE}" stroke-width="1"`));
  }
  parts.push(`<path d="M${cx - 15} ${bodyY + 2} q0 -8 10 -8 l14 0 q10 0 10 8 l0 10 q0 6 -10 6 l-14 0 q-10 0 -10 -6 Z" fill="${fur}" stroke="${STROKE}" stroke-width="1.7" stroke-linejoin="round"/>`);
  parts.push(`<circle cx="${cx - 15}" cy="${bodyY + 1}" r="11" fill="${fur}" stroke="${STROKE}" stroke-width="1.7"/>`);
  parts.push(`<ellipse cx="${cx - 24}" cy="${bodyY + 3}" rx="4.6" ry="9" fill="${dark}" stroke="${STROKE}" stroke-width="1.2"/>`);
  parts.push(`<ellipse cx="${cx - 7}" cy="${bodyY + 3}" rx="4.2" ry="8" fill="${dark}" stroke="${STROKE}" stroke-width="1.2"/>`);
  parts.push(`<circle cx="${cx - 19}" cy="${bodyY - 1}" r="1.6" fill="${STROKE}"/>`);
  parts.push(`<circle cx="${cx - 11}" cy="${bodyY - 1}" r="1.6" fill="${STROKE}"/>`);
  parts.push(`<ellipse cx="${cx - 15}" cy="${bodyY + 5}" rx="3" ry="2.2" fill="${STROKE}"/>`);
  parts.push(`<polygon points="${cx + 2},${bodyY + 11} ${cx + 6},${bodyY + 17} ${cx - 2},${bodyY + 17}" fill="#e2a94d" stroke="${STROKE}" stroke-width="0.8"/>`);
  return `<g data-layer="pet" data-pet="dog" data-part="original/pet/dog">${parts.join("")}</g>`;
}

/* ------------------------------------------------------------------ */
/* 公開入口                                                            */
/* ------------------------------------------------------------------ */

/** 每個角色實際用到的資產／部件 key（矩陣測試直接檢查這個）。 */
export function describeSceneParts(scene: SceneView, seed = ""): readonly ScenePartDescriptor[] {
  const descriptor = (
    role: "player" | "partner",
    sex: SceneSex,
    age: number,
    ageStage: SceneAgeStage,
    lifeStage: SceneLifeStage
  ): ScenePartDescriptor => {
    const look = appearanceOf(sex, lifeStage, seed, role);
    return Object.freeze({
      role,
      sex,
      age,
      ageStage,
      lifeStage,
      asset: look.asset,
      body: look.body,
      head: look.head,
      face: look.face,
      hair: look.hair,
      glasses: look.glasses,
      derived: look.derived,
      identity: look.identity,
      parts: look.partKeys
    });
  };
  const list = [
    descriptor("player", scene.playerSex, scene.age, scene.ageStage, scene.lifeStage)
  ];
  if (scene.hasPartner) {
    const partner = partnerIdentity(scene);
    list.push(descriptor("partner", partner.sex, partner.age, partner.ageStage, partner.lifeStage));
  }
  return Object.freeze(list);
}

/** 每個角色在場景座標裡的實際幾何（不含寵物）。測試與瀏覽器驗收共用。 */
export function describeSceneGeometry(scene: SceneView, seed = ""): readonly SceneActorGeometry[] {
  const build = (
    role: "player" | "partner",
    sex: SceneSex,
    lifeStage: SceneLifeStage,
    slot: PeepSlot
  ): SceneActorGeometry => {
    const look = appearanceOf(sex, lifeStage, seed, role);
    const layout = actorLayoutOf(look, slot);
    const anchors = layout.anchors;
    const eye = {
      cx: layout.translateX + anchors.eye.cx * layout.scale,
      cy: layout.translateY + anchors.eye.cy * layout.scale,
      halfGap: anchors.eye.halfGap * layout.scale,
      radius: anchors.eye.radius * layout.scale
    };
    return Object.freeze({
      role,
      asset: look.asset,
      assetKey: look.assetKey,
      scale: layout.scale,
      content: Object.freeze(layout.content),
      bounds: Object.freeze(layout.bounds),
      head: Object.freeze(toScene(anchors.head, layout)),
      eye: Object.freeze(eye),
      glasses: layout.glasses === null ? null : Object.freeze({
        cx: eye.cx,
        cy: eye.cy,
        rx: layout.glasses.rx * layout.scale,
        ry: layout.glasses.ry * layout.scale,
        halfGap: eye.halfGap,
        box: Object.freeze(toScene(layout.glasses.box, layout))
      }),
      scarf: layout.scarf === null ? null : Object.freeze({
        cx: layout.translateX + layout.scarf.cx * layout.scale,
        cy: layout.translateY + layout.scarf.cy * layout.scale,
        halfWidth: layout.scarf.halfWidth * layout.scale,
        bandHeight: layout.scarf.bandHeight * layout.scale,
        box: Object.freeze(toScene(layout.scarf.box, layout))
      }),
      cane: layout.cane === null ? null : Object.freeze({
        x: layout.translateX + layout.cane.x * layout.scale,
        top: layout.translateY + layout.cane.top * layout.scale,
        bottom: layout.translateY + layout.cane.bottom * layout.scale,
        hookRadius: layout.cane.hookRadius * layout.scale,
        side: layout.cane.side,
        box: Object.freeze(toScene(layout.cane.box, layout))
      })
    });
  };
  const list = [build("player", scene.playerSex, scene.lifeStage, PLAYER_SLOT)];
  if (scene.hasPartner) {
    const partner = partnerIdentity(scene);
    list.push(build("partner", partner.sex, partner.lifeStage, PARTNER_SLOT));
  }
  return Object.freeze(list);
}

/** 場景安全顯示區（配件與人物都必須落在這個矩形內）。 */
export const SCENE_SAFE_BOX: PeepBox = Object.freeze({
  left: SCENE_SAFE_LEFT_X,
  top: SCENE_SAFE_TOP_Y,
  right: SCENE_SAFE_RIGHT_X,
  bottom: SCENE_SAFE_BOTTOM_Y
});

/** 這一幀有哪些層、各自的穩定外觀指紋（供測試／smoke 斷言，不解析 SVG）。 */
export function describeSceneLayers(scene: SceneView, seed = ""): readonly SceneLayerDescriptor[] {
  const player = appearanceOf(scene.playerSex, scene.lifeStage, seed, "player");
  const partner = partnerIdentity(scene);
  return Object.freeze([
    Object.freeze({ layer: "background" as const, visible: true, key: `${scene.residenceKind}/${scene.phase}` }),
    Object.freeze({
      layer: "player" as const,
      visible: true,
      key: `${player.asset}/${player.hairColor}/${player.key}`
    }),
    Object.freeze({
      layer: "partner" as const,
      visible: scene.hasPartner,
      key: scene.hasPartner
        ? appearanceOf(partner.sex, partner.lifeStage, seed, "partner").asset
        : "none"
    }),
    Object.freeze({
      layer: "pet" as const,
      visible: scene.petKind !== "none",
      key: scene.petKind === "none" ? "none" : `original/pet/${scene.petKind}`
    })
  ]);
}

/**
 * 產生完整分層 SVG（單張本機圖片，無外部資源、無 emoji、無文字）。
 *
 * 根節點用 `xMidYMax meet`：SVG 依容器等比縮放、貼底對齊，**不會**像 `slice`
 * 那樣為了填滿而裁掉頭頂或腳底。CSS 端再以 `background-size: contain` 搭配
 * 天空色底色，讓多出來的極窄邊界與天空同色。
 */
export function buildSceneSvg(scene: SceneView, seed = ""): string {
  const layers: string[] = [backgroundLayer(scene)];
  layers.push(personLayer(
    seed, "player", scene.playerSex, scene.age, scene.ageStage, scene.lifeStage, PLAYER_SLOT
  ));
  if (scene.hasPartner) {
    const partner = partnerIdentity(scene);
    layers.push(personLayer(
      seed, "partner", partner.sex, partner.age, partner.ageStage, partner.lifeStage, PARTNER_SLOT
    ));
  }
  if (scene.petKind !== "none") layers.push(petLayer(scene.petKind));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SCENE_VIEWBOX_WIDTH} ${SCENE_VIEWBOX_HEIGHT}" ` +
    `width="${SCENE_VIEWBOX_WIDTH}" height="${SCENE_VIEWBOX_HEIGHT}" ` +
    `data-age="${scene.age}" data-life-stage="${scene.lifeStage}" preserveAspectRatio="xMidYMax meet">` +
    `<title>Layered life scene</title>${layers.join("")}</svg>`;
}

/** CSS `background-image` 用的 data URI（本地生成，無 CDN、無第三方檔案）。 */
export function sceneSvgDataUri(scene: SceneView, seed = ""): string {
  const encoded = encodeURIComponent(buildSceneSvg(scene, seed))
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/'/g, "%27");
  return `data:image/svg+xml,${encoded}`;
}

/** 穩定簽名：同 seed／同狀態相同；用於 smoke 驗證 reload 後外觀不變。 */
export function sceneSignature(scene: SceneView, seed = ""): string {
  return hash32(buildSceneSvg(scene, seed)).toString(16).padStart(8, "0");
}

/** 供應鏈稽核用：實際打包的官方資產清單（key／來源／大小）。 */
export const SCENE_OPEN_PEEPS_ASSETS: typeof OPEN_PEEPS_ASSETS = OPEN_PEEPS_ASSETS;
/** 供應鏈稽核用：實際打包的**本專案衍生**資產清單（非官方原件）。 */
export const SCENE_DERIVED_PEEPS_ASSETS: typeof DERIVED_PEEPS_ASSETS = DERIVED_PEEPS_ASSETS;
