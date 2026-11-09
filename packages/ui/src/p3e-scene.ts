/**
 * GPT-WORKBUDDY-0063-B｜精確年齡 × 年齡專用全身人物場景（純函式、無 DOM、無 CDN）。
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
 * - 嬰兒是坐姿大頭連身衣，body key 永遠是 `openpeeps-derived/body/onesie-*`，
 *   **不可能**等於官方成人 `openpeeps/pose/standing/*`；學生 body key 是
 *   school／teen／campus，沒有 blazer／suit／business-only。
 *
 * ## identity 穩定
 *
 * - `(seed, role, sex)` 決定 series、膚色、基礎髮色、衣著色；**不含年齡、
 *   伴侶／寵物狀態**，所以同一人跨 0→65 歲是同一個人，只合理換比例與服裝。
 * - 衍生資產與官方成人資產都用同一個 series index，成長時不「換成另一個人」。
 * - 伴侶直接用 `scene.partnerSex`；伴侶年齡用 `scene.partnerAge`（正式投影）
 *   推導 lifeStage，玩家 6 歲時旁邊不會出現成年伴侶，也不會切換性別。
 * - 4 種服裝款式對男女都開放，沒有「女性固定裙子、男性固定褲子」。
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

/** 各生活階段的真實人物高度：明顯成長，但每個階段都大且清楚。 */
const STAGE_HEIGHT: Readonly<Record<SceneLifeStage, number>> = Object.freeze({
  baby: 100,
  child: 116,
  primary: 130,
  teen: 144,
  university: 152,
  young: 158,
  middle: 152,
  senior: 142
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
  readonly viewBox: string;
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
  let viewBox: string;
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
    viewBox = info.viewBox;
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
    viewBox = info.viewBox;
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
    viewBox,
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
/* SVG 圖層                                                            */
/* ------------------------------------------------------------------ */

export const SCENE_VIEWBOX_WIDTH = 390;
export const SCENE_VIEWBOX_HEIGHT = 220;
/** 地面線（人物腳底），與 390×844／430×932 的 190–230px 場景高度相稱。 */
const GROUND_Y = 196;

/** 左側狀態卡在 390px 寬時約占 x=16..173；人物全部排在安全區右側。 */
export const SCENE_SAFE_LEFT_X = 190;
export const PLAYER_CENTER_X = 232;
export const PARTNER_CENTER_X = 300;
export const PET_CENTER_X = 352;

function rect(x: number, y: number, w: number, h: number, fill: string, extra = ""): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
}

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
    const widths = [42, 34, 50, 30, 44, 38, 46];
    let x = 4;
    for (let i = 0; i < widths.length; i += 1) {
      const w = widths[i] as number;
      const h = 62 + ((i * 17) % 46);
      buildings.push(rect(x, GROUND_Y - 26 - h, w, h + 26, i % 2 === 0 ? "#7f8fa0" : "#94a1ac"));
      for (let wy = GROUND_Y - 18 - h; wy < GROUND_Y - 34; wy += 16) {
        for (let wx = x + 7; wx < x + w - 6; wx += 13) {
          buildings.push(rect(wx, wy, 5, 7, dead ? "#c9bdae" : "#f5df9d"));
        }
      }
      x += w + 3;
    }
    scenery =
      rect(0, 118, SCENE_VIEWBOX_WIDTH, 44, distant) +
      buildings.join("") +
      rect(0, GROUND_Y - 26, SCENE_VIEWBOX_WIDTH, 26, "#8d7f6b") +
      rect(0, GROUND_Y, SCENE_VIEWBOX_WIDTH, SCENE_VIEWBOX_HEIGHT - GROUND_Y, ground) +
      rect(0, GROUND_Y + 12, SCENE_VIEWBOX_WIDTH, 3, "#b39a72") +
      rect(54, 132, 4, 64, "#5b5347") + `<circle cx="56" cy="130" r="7" fill="#f6d97f"/>` +
      rect(186, 138, 4, 58, "#5b5347") + `<circle cx="188" cy="136" r="7" fill="#f6d97f"/>` +
      rect(0, GROUND_Y + 18, SCENE_VIEWBOX_WIDTH, 6, "#7f9a63") +
      rect(0, GROUND_Y + 2, 28, 14, "#6f8a55") +
      rect(360, GROUND_Y + 2, 30, 14, "#6f8a55");
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
      rect(0, GROUND_Y - 24, SCENE_VIEWBOX_WIDTH, 24, "#aebd78") +
      rect(0, GROUND_Y, SCENE_VIEWBOX_WIDTH, SCENE_VIEWBOX_HEIGHT - GROUND_Y, ground) +
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

/** 成人增量配件：只畫在原創前景層，不修改任何官方／衍生 SVG 筆觸。 */
function ageAccessories(look: Appearance, centerX: number, width: number): string {
  const top = GROUND_Y - look.height;
  const parts: string[] = [];
  if (look.scarf) {
    const sy = top + look.height * 0.235;
    const half = Math.max(9, width * 0.24);
    parts.push(`<g data-part="original/item/scarf"><path d="M${(centerX - half).toFixed(1)} ${sy.toFixed(1)} q${half.toFixed(1)} 8 ${(half * 2).toFixed(1)} 0 l-3 9 q-${(half - 3).toFixed(1)} -4 -${(half * 2 - 6).toFixed(1)} 0 Z" fill="#e2a94d" stroke="${STROKE}" stroke-width="1.2" stroke-linejoin="round"/></g>`);
  }
  if (look.glassesOn) {
    const gy = top + look.height * 0.168;
    const gap = Math.max(5, width * 0.11);
    const r = Math.max(3.5, width * 0.075);
    parts.push(`<g data-part="original/item/reading-glasses"><circle cx="${(centerX - gap).toFixed(1)}" cy="${gy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${STROKE}" stroke-width="1.5"/><circle cx="${(centerX + gap).toFixed(1)}" cy="${gy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${STROKE}" stroke-width="1.5"/><path d="M${(centerX - gap + r).toFixed(1)} ${gy.toFixed(1)} h${(gap * 2 - r * 2).toFixed(1)}" fill="none" stroke="${STROKE}" stroke-width="1.4"/></g>`);
    parts.push(`<g data-part="original/face/wrinkles"><path d="M${(centerX - gap - r - 3).toFixed(1)} ${(gy + r + 3).toFixed(1)} q3 -2 6 0 M${(centerX + gap + r - 3).toFixed(1)} ${(gy + r + 3).toFixed(1)} q3 -2 6 0" fill="none" stroke="${STROKE}" stroke-width="1.1" stroke-linecap="round" opacity="0.5"/></g>`);
  }
  if (look.cane) {
    const cx = centerX + width * 0.52 + 4;
    parts.push(`<g data-part="original/item/cane"><path d="M${cx.toFixed(1)} ${(top + look.height * 0.42).toFixed(1)} L${cx.toFixed(1)} ${GROUND_Y - 1} M${cx.toFixed(1)} ${(top + look.height * 0.42).toFixed(1)} q0 -7 -7 -7" fill="none" stroke="#7b5b3a" stroke-width="2.6" stroke-linecap="round"/></g>`);
  }
  return parts.join("");
}

/**
 * 人物：一張**完整全身 SVG**（衍生或官方）直接縮放擺放；沒有混搭頭身。
 * viewBox 緊貼人物，所以 look.height 就是畫面上的真實人物高度。
 */
function personLayer(
  seed: string,
  role: "player" | "partner",
  sex: SceneSex,
  age: number,
  ageStage: SceneAgeStage,
  lifeStage: SceneLifeStage,
  centerX: number
): string {
  const look = appearanceOf(sex, lifeStage, seed, role);
  const numbers = look.viewBox.split(" ").map(Number).filter(Number.isFinite);
  const vbWidth = numbers.length >= 4 ? (numbers[2] as number) : (numbers[0] as number);
  const vbHeight = numbers.length >= 4 ? (numbers[3] as number) : (numbers[1] as number);
  const height = look.height;
  const width = height * (vbWidth / vbHeight);
  const x = centerX - width / 2;
  const y = GROUND_Y - height;
  const parts: string[] = [];
  parts.push(`<ellipse cx="${centerX}" cy="${GROUND_Y + 2}" rx="${(width * 0.42).toFixed(1)}" ry="4" fill="rgba(74,59,50,0.20)"/>`);
  // 柔和色塊讓線稿在場景中更清楚，但仍然不遮左側狀態卡。
  parts.push(`<ellipse cx="${centerX}" cy="${(GROUND_Y - height * 0.48).toFixed(1)}" rx="${(width * 0.52).toFixed(1)}" ry="${(height * 0.47).toFixed(1)}" fill="${look.clothesColor}" opacity="0.16"/>`);
  parts.push(
    `<svg data-part="${look.asset}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" ` +
    `width="${width.toFixed(2)}" height="${height.toFixed(2)}" viewBox="0 0 ${vbWidth} ${vbHeight}" ` +
    `preserveAspectRatio="xMidYMid meet" overflow="visible">${look.markup}</svg>`
  );
  parts.push(ageAccessories(look, centerX, width));
  return `<g data-layer="${role}" data-sex="${sex}" data-age="${age}" ` +
    `data-age-stage="${ageStage}" data-life-stage="${lifeStage}" ` +
    `data-body="${look.body}" data-asset="${look.asset}" data-derived="${look.derived}" ` +
    `data-identity="${look.identity}" data-variant="${look.key}" ` +
    `data-parts="${look.partKeys.join(" ")}">${parts.join("")}</g>`;
}

/** 寵物：dog／cat 皆為本專案原創圓潤手繪曲線（0062-B 起不再使用 Humation 貓部件）。 */
function petLayer(pet: Exclude<ScenePetKind, "none">): string {
  const cx = PET_CENTER_X;
  const shadow = `<ellipse cx="${cx}" cy="${GROUND_Y + 1}" rx="17" ry="3" fill="rgba(74,59,50,0.20)"/>`;
  if (pet === "cat") {
    const bodyY = GROUND_Y - 19;
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
  const bodyY = GROUND_Y - 20;
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

/** 產生完整分層 SVG（單張本機圖片，無外部資源、無 emoji、無文字）。 */
export function buildSceneSvg(scene: SceneView, seed = ""): string {
  const layers: string[] = [backgroundLayer(scene)];
  layers.push(personLayer(
    seed, "player", scene.playerSex, scene.age, scene.ageStage, scene.lifeStage, PLAYER_CENTER_X
  ));
  if (scene.hasPartner) {
    const partner = partnerIdentity(scene);
    layers.push(personLayer(
      seed, "partner", partner.sex, partner.age, partner.ageStage, partner.lifeStage, PARTNER_CENTER_X
    ));
  }
  if (scene.petKind !== "none") layers.push(petLayer(scene.petKind));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SCENE_VIEWBOX_WIDTH} ${SCENE_VIEWBOX_HEIGHT}" ` +
    `width="${SCENE_VIEWBOX_WIDTH}" height="${SCENE_VIEWBOX_HEIGHT}" ` +
    `data-age="${scene.age}" data-life-stage="${scene.lifeStage}" preserveAspectRatio="xMidYMid slice">` +
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
