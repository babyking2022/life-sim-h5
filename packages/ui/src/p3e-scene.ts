/**
 * GPT-WORKBUDDY-0058-B｜任務一：可愛手繪分層場景（純函式、無 DOM、無 CDN）。
 *
 * ## 與 0054-B 的差異
 *
 * 0054-B 的人物是 `rect`／`circle` 拼出的僵硬幾何人形。本輪依
 * `work/GPT-0058/WORKBUDDY-DAYU-0058-B.md`，改用 Humation
 * （https://github.com/humation-labs/humation，MIT，commit 85613cf）的
 * **手繪 kawaii 視覺語言**：只 vendor 4 個必要 SVG 部件（2 個頭型、
 * 1 副老花眼鏡、1 隻貓）到 `p3e-kawaii-parts.ts`，身體／狗／背景仍為
 * 本專案原創圓潤曲線，全部以粗描邊統一風格。沒有搬入 86 個部件、
 * React 套件或編輯器；授權全文與來源見 `assets/generated/humation/`。
 *
 * ## 性別身分穩定（本輪核心）
 *
 * - head 部件**只由 sex 決定**：male → `humation/head/short`，
 *   female → `humation/head/fluffy-bob`；child／student／young／middle／
 *   senior 五階段都用同一個部件，伴侶亦同。
 * - 老化只改：髮色（灰白）、皺紋、眼鏡、身高比例、衣服顏色、手杖；
 *   **絕不因進入 senior 而切換到另一性別的頭型／身形集合**。
 * - 伴侶直接使用 `scene.partnerSex`（DeepSeek 0058-A 已把 sex 固定在
 *   `P3ELifePartner` 並投影到 `view.scene`），不再用姓名或玩家性別推測。
 *   只有投影畸形（partnerSex === null）時才走安全預設。
 *
 * ## 圖層與決定性
 *
 * `background`（urban／rural，無任何人或雞）＋`player`＋`partner`（hasPartner）
 * ＋`pet`（dog／cat／none）。外觀是 `(scene, seed)` 的純函式：FNV-1a 挑髮色，
 * 無 `Math.random`、無 `Date`、無外部請求。輸出為單張
 * `data:image/svg+xml` 背景圖，`.p3e-scene` 仍保持 0 個子節點。
 */

import { humationPart, type HumationColors, type HumationPartKey } from "./p3e-kawaii-parts.js";

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

export type SceneSex = "male" | "female";
export type SceneAgeStage = "child" | "student" | "young" | "middle" | "senior";
export type SceneResidenceKind = "urban" | "rural";
export type ScenePetKind = "none" | "dog" | "cat";
export type ScenePhase = "alive" | "dead";

/** 與 application 的 `P3EScene` 相同形狀；UI 只讀這份投影，不碰 flags。 */
export interface SceneView {
  readonly playerSex: SceneSex;
  readonly ageStage: SceneAgeStage;
  readonly residenceKind: SceneResidenceKind;
  readonly hasPartner: boolean;
  readonly partnerSex: SceneSex | null;
  readonly petKind: ScenePetKind;
  readonly phase: ScenePhase;
}

/** 投影缺席／畸形時的安全預設值（自然、穩定、不猜測人物狀態）。 */
export const DEFAULT_SCENE_VIEW: SceneView = Object.freeze({
  playerSex: "female",
  ageStage: "child",
  residenceKind: "rural",
  hasPartner: false,
  partnerSex: null,
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

/** 單一角色的真實 SVG 部件 key 清單（供矩陣測試直接斷言，不看 DOM）。 */
export interface ScenePartDescriptor {
  readonly role: "player" | "partner";
  readonly sex: SceneSex;
  readonly ageStage: SceneAgeStage;
  readonly head: string;
  readonly glasses: string | null;
  readonly body: string;
  readonly parts: readonly string[];
}

/* ------------------------------------------------------------------ */
/* 安全讀取（白名單）                                                   */
/* ------------------------------------------------------------------ */

const SEXES: readonly string[] = ["male", "female"];
const AGE_STAGES: readonly string[] = ["child", "student", "young", "middle", "senior"];
const RESIDENCES: readonly string[] = ["urban", "rural"];
const PETS: readonly string[] = ["none", "dog", "cat"];
const PHASES: readonly string[] = ["alive", "dead"];

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick<T extends string>(value: unknown, allowed: readonly string[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : fallback;
}

/**
 * 由 `session.view` 讀出場景投影。只認 `view.scene` 的公開欄位，
 * **不解析 flags、不猜測人物狀態**；缺欄位就用安全預設值。
 */
export function readSceneView(view: unknown): SceneView {
  const scene = record(record(view).scene);
  return Object.freeze({
    playerSex: pick<SceneSex>(scene.playerSex, SEXES, DEFAULT_SCENE_VIEW.playerSex),
    ageStage: pick<SceneAgeStage>(scene.ageStage, AGE_STAGES, DEFAULT_SCENE_VIEW.ageStage),
    residenceKind: pick<SceneResidenceKind>(scene.residenceKind, RESIDENCES, DEFAULT_SCENE_VIEW.residenceKind),
    hasPartner: scene.hasPartner === true,
    partnerSex:
      typeof scene.partnerSex === "string" && SEXES.includes(scene.partnerSex)
        ? (scene.partnerSex as SceneSex)
        : null,
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

const HAIR_COLORS: readonly string[] = [
  "#3a2a20", "#5a3a22", "#7b4b2a", "#2f2a28", "#8a6a3f", "#4b3326"
];
const SENIOR_HAIR = "#d9d3c6";
const STROKE = "#4a3b32";
const SKIN = "#f8d3ad";
const BLUSH = "#e98f9b";

interface StageShape {
  readonly height: number;
  readonly headRadius: number;
  readonly bodyHeight: number;
}

const STAGE_SHAPE: Readonly<Record<SceneAgeStage, StageShape>> = Object.freeze({
  child: Object.freeze({ height: 52, headRadius: 11, bodyHeight: 20 }),
  student: Object.freeze({ height: 68, headRadius: 12, bodyHeight: 28 }),
  young: Object.freeze({ height: 94, headRadius: 14, bodyHeight: 38 }),
  middle: Object.freeze({ height: 91, headRadius: 14, bodyHeight: 36 }),
  senior: Object.freeze({ height: 84, headRadius: 13, bodyHeight: 33 })
});

interface Appearance {
  readonly shape: StageShape;
  readonly hairColor: string;
  readonly topColor: string;
  readonly bottomColor: string;
  readonly longHair: boolean;
  readonly skirt: boolean;
  readonly backpack: boolean;
  readonly glasses: boolean;
  readonly cane: boolean;
  readonly headPart: HumationPartKey;
  readonly partKeys: readonly string[];
  readonly key: string;
}

/**
 * 性別專用的 Humation 頭型部件。**五個年齡階段共用同一個 key**，
 * 老化不會切到另一性別的部件集合。
 */
export function headPartOf(sex: SceneSex): HumationPartKey {
  return sex === "male" ? "head/short" : "head/fluffy-bob";
}

/** 伴侶沒給性別時的安全預設（正常路徑一律直接用 scene.partnerSex）。 */
function oppositeSex(sex: SceneSex): SceneSex {
  return sex === "male" ? "female" : "male";
}

/**
 * 外觀只由 (seed, role, sex, stage) 決定：不會因為交了伴侶或養了寵物
 * 就改玩家的髮型／髮色。同一個人在不同關係狀態下仍是同一個人。
 */
function appearanceOf(
  sex: SceneSex,
  stage: SceneAgeStage,
  seed: string,
  role: "player" | "partner"
): Appearance {
  const variant = hash32(`${seed}|${role}|${sex}|${stage}`) % HAIR_COLORS.length;
  const hairColor = stage === "senior" ? SENIOR_HAIR : (HAIR_COLORS[variant] as string);
  const topColor =
    stage === "child" ? (sex === "female" ? "#e98f9b" : "#e88b5a")
      : stage === "student" ? (sex === "female" ? "#7fa9c9" : "#5b8fb9")
        : stage === "young" ? (sex === "female" ? "#c2607a" : "#3f7d6a")
          : stage === "middle" ? (sex === "female" ? "#8f5a86" : "#40566f")
            : (sex === "female" ? "#9c8a76" : "#8a7b63");
  // 性別外觀旗標固定，不隨年齡翻轉；只作為 variant 指紋的一部分。
  const longHair = sex === "female";
  const skirt = sex === "female";
  const glasses = stage === "senior";
  const headPart = headPartOf(sex);
  const bodyPart = `original/body/${skirt ? "dress" : "trousers"}`;
  const partKeys: readonly string[] = Object.freeze([
    `humation/${headPart}`,
    bodyPart,
    ...(glasses ? ["humation/glasses/round"] : []),
    ...(stage === "student" ? ["original/item/school-bag"] : []),
    ...(stage === "senior" ? ["original/item/cane", "original/face/wrinkles"] : [])
  ]);
  return {
    shape: STAGE_SHAPE[stage],
    hairColor,
    topColor,
    bottomColor: skirt ? "#b4586e" : "#3d4657",
    longHair,
    skirt,
    backpack: stage === "student",
    glasses,
    cane: stage === "senior",
    headPart,
    partKeys,
    key: `${sex}/${stage}/${hairColor}/${topColor}/${longHair}/${skirt}`
  };
}

function partColors(look: Appearance): HumationColors {
  return Object.freeze({
    stroke: STROKE,
    hair: look.hairColor,
    skin: SKIN,
    clothes: look.topColor,
    bottom: look.bottomColor,
    background: "none"
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
    // 城市：天際線、窗戶、路燈、人行道、花壇。
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
    // 農村：遠山、梯田、瓦頂屋舍、樹、籬笆；仍然沒有人或雞。
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
      // 兩棟瓦頂屋舍（三角形屋頂 + 門窗）。
      `<polygon points="24,128 66,100 108,128" fill="#a5573f"/>` +
      rect(32, 128, 68, 44, "#e4cf9f") + rect(58, 144, 18, 28, "#8a6a44") +
      rect(38, 138, 14, 12, "#8ec4d6") + rect(84, 138, 12, 12, "#8ec4d6") +
      `<polygon points="270,134 306,110 342,134" fill="#a5573f"/>` +
      rect(278, 134, 56, 38, "#e4cf9f") + rect(300, 148, 14, 24, "#8a6a44") +
      // 樹。
      rect(196, 142, 9, 32, "#7b5b3a") + `<circle cx="200" cy="136" r="22" fill="#6f9a5a"/>` +
      `<circle cx="188" cy="128" r="13" fill="#7faa67"/>` +
      fence +
      rect(0, 173, SCENE_VIEWBOX_WIDTH, 3, "#8a6a44");
  }
  return `${head}${scenery}</g>`;
}

/**
 * 人物：Humation 手繪頭型部件 + 原創圓潤身體。
 * 頭型由 sex 固定；年齡只改髮色、皺紋、眼鏡、身高比例、衣服、手杖。
 */
function personLayer(
  seed: string,
  role: "player" | "partner",
  sex: SceneSex,
  stage: SceneAgeStage,
  centerX: number
): string {
  const look = appearanceOf(sex, stage, seed, role);
  const { height, headRadius } = look.shape;
  const headSize = Math.round(headRadius * 2.55);
  const headScale = headSize / 80;
  const headLeft = Math.round(centerX - headSize / 2);
  const headTop = GROUND_Y - height;
  const bodyTop = Math.round(headTop + headSize * 0.82);
  const legHeight = Math.round(height * 0.26);
  const bodyBottom = GROUND_Y - legHeight;
  const bodyHalf = Math.round(headRadius * 0.98);
  const colors = partColors(look);
  const parts: string[] = [];

  // 影子與學生背包（在身體後面）。
  parts.push(`<ellipse cx="${centerX}" cy="${GROUND_Y + 2}" rx="${Math.round(headRadius * 1.5)}" ry="4" fill="rgba(74,59,50,0.20)"/>`);
  if (look.backpack) {
    parts.push(`<g data-part="original/item/school-bag"><path d="M${centerX - bodyHalf - 9} ${bodyTop + 5} q-5 0 -5 7 l0 ${Math.max(8, bodyBottom - bodyTop - 14)} q0 6 6 6 l5 0 Z" fill="#c9763f" stroke="${STROKE}" stroke-width="1.4" stroke-linejoin="round"/></g>`);
  }

  // 腿／裙：性別固定，完全不隨年齡切換。
  if (look.skirt) {
    parts.push(`<g data-part="original/body/dress"><path d="M${centerX - bodyHalf} ${bodyBottom - 2} L${centerX + bodyHalf} ${bodyBottom - 2} L${centerX + bodyHalf + 7} ${GROUND_Y - 6} Q${centerX} ${GROUND_Y} ${centerX - bodyHalf - 7} ${GROUND_Y - 6} Z" fill="${look.bottomColor}" stroke="${STROKE}" stroke-width="1.6" stroke-linejoin="round"/></g>`);
    for (const dx of [-6, 2]) {
      parts.push(rect(centerX + dx, GROUND_Y - legHeight, 4, legHeight - 3, SKIN, ` rx="2" stroke="${STROKE}" stroke-width="1"`));
    }
  } else {
    parts.push(`<g data-part="original/body/trousers">`);
    for (const dx of [-bodyHalf + 1, 1]) {
      parts.push(rect(centerX + dx, bodyBottom - 3, Math.max(4, bodyHalf - 2), legHeight + 1, look.bottomColor, ` rx="3" stroke="${STROKE}" stroke-width="1.3"`));
    }
    parts.push(`</g>`);
  }
  // 圓頭鞋。
  for (const dx of [-bodyHalf + 1, 2]) {
    parts.push(`<ellipse cx="${centerX + dx + Math.max(2, bodyHalf / 2)}" cy="${GROUND_Y - 1}" rx="5" ry="3" fill="${STROKE}"/>`);
  }

  // 身體：圓肩、圓下襬的手繪曲線（不是方塊）。
  const left = centerX - bodyHalf;
  const right = centerX + bodyHalf;
  parts.push(`<path d="M${left + 2} ${bodyTop + 3} Q${left} ${bodyTop - 2} ${centerX - 4} ${bodyTop - 2} Q${centerX} ${bodyTop - 3} ${centerX + 4} ${bodyTop - 2} Q${right} ${bodyTop - 2} ${right - 2} ${bodyTop + 3} L${right + 1} ${bodyBottom - 3} Q${centerX} ${bodyBottom + 3} ${left - 1} ${bodyBottom - 3} Z" fill="${look.topColor}" stroke="${STROKE}" stroke-width="1.7" stroke-linejoin="round"/>`);
  parts.push(`<path d="M${centerX - 3} ${bodyTop - 1} q3 7 6 0" fill="none" stroke="#f7e7cc" stroke-width="1.6" stroke-linecap="round"/>`);
  // 圓潤手臂 + 圓手。
  for (const side of [-1, 1]) {
    const sx = centerX + side * (bodyHalf + 1);
    parts.push(`<path d="M${sx} ${bodyTop + 5} q${side * 5} 7 ${side * 3} ${Math.max(9, bodyBottom - bodyTop - 9)}" fill="none" stroke="${look.topColor}" stroke-width="6" stroke-linecap="round"/>`);
    parts.push(`<path d="M${sx} ${bodyTop + 5} q${side * 5} 7 ${side * 3} ${Math.max(9, bodyBottom - bodyTop - 9)}" fill="none" stroke="${STROKE}" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>`);
    parts.push(`<circle cx="${sx + side * 3}" cy="${bodyTop + 5 + Math.max(9, bodyBottom - bodyTop - 9)}" r="3.6" fill="${SKIN}" stroke="${STROKE}" stroke-width="1.2"/>`);
  }

  // 頭：Humation 手繪部件（80×80 → headSize）。
  const headTransform = `translate(${headLeft} ${headTop}) scale(${headScale.toFixed(4)})`;
  parts.push(`<g data-part="humation/${look.headPart}" transform="${headTransform}">${humationPart(look.headPart, colors)}</g>`);
  // 老化特徵只疊加，不換部件：腮紅／皺紋／眼鏡。
  if (stage === "senior") {
    parts.push(`<g data-part="original/face/wrinkles" transform="${headTransform}"><path d="M14 53 q4 -2 8 1 M58 53 q4 -3 8 0 M36 66 q4 2 8 0" fill="none" stroke="${STROKE}" stroke-width="1.4" stroke-linecap="round" opacity="0.45"/></g>`);
    parts.push(`<g data-part="humation/glasses/round" transform="${headTransform}">${humationPart("glasses/round", colors)}</g>`);
  } else {
    parts.push(`<g data-part="original/face/blush" transform="${headTransform}"><ellipse cx="20" cy="52" rx="6" ry="3.4" fill="${BLUSH}" opacity="0.32"/><ellipse cx="60" cy="52" rx="6" ry="3.4" fill="${BLUSH}" opacity="0.32"/></g>`);
  }
  // 手杖（年齡特徵，不影響性別部件）。
  if (look.cane) {
    const caneX = centerX + bodyHalf + 12;
    parts.push(`<g data-part="original/item/cane"><path d="M${caneX} ${bodyTop + 10} L${caneX} ${GROUND_Y - 2} M${caneX} ${bodyTop + 10} q0 -6 -6 -6" fill="none" stroke="#7b5b3a" stroke-width="2.4" stroke-linecap="round"/></g>`);
  }

  return `<g data-layer="${role}" data-sex="${sex}" data-age-stage="${stage}" data-variant="${look.key}" data-parts="${look.partKeys.join(" ")}">${parts.join("")}</g>`;
}

/** 寵物：貓用 Humation 手繪部件；狗為原創圓潤手繪（Humation 沒有狗部件）。 */
function petLayer(pet: Exclude<ScenePetKind, "none">): string {
  const size = 38;
  const x = PET_CENTER_X - size / 2;
  const y = GROUND_Y - size + 2;
  const scale = size / 80;
  const shadow = `<ellipse cx="${PET_CENTER_X}" cy="${GROUND_Y + 1}" rx="17" ry="3" fill="rgba(74,59,50,0.20)"/>`;
  if (pet === "cat") {
    return `<g data-layer="pet" data-pet="cat" data-part="humation/cat/tabby">${shadow}` +
      `<g data-part="humation/cat/tabby" transform="translate(${x} ${y}) scale(${scale.toFixed(4)})">` +
      humationPart("cat/tabby", Object.freeze({
        stroke: STROKE, hair: "#a9713f", skin: SKIN,
        clothes: "#ffffff", bottom: STROKE, background: "none"
      })) +
      `</g><polygon points="${PET_CENTER_X + 12},${GROUND_Y - 9} ${PET_CENTER_X + 16},${GROUND_Y - 3} ${PET_CENTER_X + 8},${GROUND_Y - 3}" fill="#e2a94d" stroke="${STROKE}" stroke-width="0.8"/></g>`;
  }
  // 狗：圓身、垂耳、翹尾、項圈，全部曲線與粗描邊，與 Humation 風格一致。
  const cx = PET_CENTER_X;
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

function partnerIdentity(scene: SceneView): { sex: SceneSex; stage: SceneAgeStage } {
  // 正常路徑：直接用 application 投影的伴侶性別，不重新推測。
  const sex = scene.partnerSex ?? oppositeSex(scene.playerSex);
  const stage: SceneAgeStage =
    scene.ageStage === "child" || scene.ageStage === "student" ? "young" : scene.ageStage;
  return { sex, stage };
}

/** 每個角色實際用到的 SVG 部件 key（矩陣測試直接檢查這個，而不是只看 DOM 有圖）。 */
export function describeSceneParts(scene: SceneView, seed = ""): readonly ScenePartDescriptor[] {
  const descriptor = (role: "player" | "partner", sex: SceneSex, stage: SceneAgeStage): ScenePartDescriptor => {
    const look = appearanceOf(sex, stage, seed, role);
    return Object.freeze({
      role,
      sex,
      ageStage: stage,
      head: `humation/${look.headPart}`,
      glasses: look.glasses ? "humation/glasses/round" : null,
      body: `original/body/${look.skirt ? "dress" : "trousers"}`,
      parts: look.partKeys
    });
  };
  const list = [descriptor("player", scene.playerSex, scene.ageStage)];
  if (scene.hasPartner) {
    const partner = partnerIdentity(scene);
    list.push(descriptor("partner", partner.sex, partner.stage));
  }
  return Object.freeze(list);
}

/** 這一幀有哪些層、各自的穩定外觀指紋（供測試／smoke 斷言，不解析 SVG）。 */
export function describeSceneLayers(scene: SceneView, seed = ""): readonly SceneLayerDescriptor[] {
  const player = appearanceOf(scene.playerSex, scene.ageStage, seed, "player");
  const partner = partnerIdentity(scene);
  return Object.freeze([
    Object.freeze({ layer: "background" as const, visible: true, key: `${scene.residenceKind}/${scene.phase}` }),
    Object.freeze({
      layer: "player" as const,
      visible: true,
      key: `${player.headPart}/${player.hairColor}/${player.key}`
    }),
    Object.freeze({
      layer: "partner" as const,
      visible: scene.hasPartner,
      key: scene.hasPartner
        ? `${headPartOf(partner.sex)}/${appearanceOf(partner.sex, partner.stage, seed, "partner").key}`
        : "none"
    }),
    Object.freeze({
      layer: "pet" as const,
      visible: scene.petKind !== "none",
      key: scene.petKind === "cat" ? "humation/cat/tabby" : scene.petKind
    })
  ]);
}

/** 產生完整分層 SVG（單張本機圖片，無外部資源、無 emoji、無文字）。 */
export function buildSceneSvg(scene: SceneView, seed = ""): string {
  const layers: string[] = [backgroundLayer(scene)];
  layers.push(personLayer(seed, "player", scene.playerSex, scene.ageStage, PLAYER_CENTER_X));
  if (scene.hasPartner) {
    const partner = partnerIdentity(scene);
    layers.push(personLayer(seed, "partner", partner.sex, partner.stage, PARTNER_CENTER_X));
  }
  if (scene.petKind !== "none") layers.push(petLayer(scene.petKind));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SCENE_VIEWBOX_WIDTH} ${SCENE_VIEWBOX_HEIGHT}" ` +
    `width="${SCENE_VIEWBOX_WIDTH}" height="${SCENE_VIEWBOX_HEIGHT}" preserveAspectRatio="xMidYMid slice">` +
    `<title>Layered life scene</title>${layers.join("")}</svg>`;
}

/** CSS `background-image` 用的 data URI（本地生成，無 CDN、無第三方檔案）。 */
export function sceneSvgDataUri(scene: SceneView, seed = ""): string {
  // encodeURIComponent 不會逃逸 ( ) ' ，但 SVG 裡的 rgba(...) 含括號；
  // 補齊這三個字元才能放進 CSS url("...")，也讓 url() 擷取正則不截斷。
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
