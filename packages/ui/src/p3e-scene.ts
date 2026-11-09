/**
 * GPT-WORKBUDDY-0054-B｜任務一：分層動態場景（純函式、無 DOM、無第三方素材）。
 *
 * ## 為什麼是 SVG 而不是繼續用那張 AVIF
 *
 * 原本 `life-sim-village-landscape.avif` 是**單張固定一家人 + 雞**的插畫
 * （見 `assets/generated/SCENE-ATTRIBUTION.md`，且該資產授權狀態「待確認」）。
 * 任務要求：背景不得再含固定人物／雞，人物、伴侶、寵物要能隨狀態增減。
 * 因此這裡改為**原創向量分層圖**，以 `data:image/svg+xml` 當作 `.p3e-scene`
 * 的背景圖片（DOM 裡仍是 0 個子節點，不干擾左側狀態卡與既有版面）：
 *
 * - `background`：urban／rural 兩套，只有景物，**沒有任何人或雞**；
 * - `player`：male/female × child/student/young/middle/senior，身高、髮型／
 *   髮色、服裝都不同；
 * - `partner`：`hasPartner` 時才出現，站在玩家右側、不遮玩家也不遮左側資訊卡；
 * - `pet`：dog／cat 才出現，none 完全不畫。
 *
 * ## 決定性
 *
 * 外觀完全是 `(scene, seed)` 的純函式：用 FNV-1a 雜湊挑髮色，
 * **沒有 Math.random、沒有 Date、沒有每次 render 重抽**。同 seed／同狀態
 * 永遠得到同一張 SVG；不同 seed 可以有不同髮色但仍穩定。
 *
 * ## 視覺輸出
 *
 * 輸出是真正的圖片（SVG 向量圖），人物／寵物都是 `rect/circle/path/polygon`
 * 畫出來的，不是 emoji、不是文字、不是 CSS 色塊假裝。全部素材為本任務原創，
 * 沒有 CDN 熱連結、沒有 vendor 任何授權不明的像素圖。
 */

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
  readonly key: string;
}

/** 伴侶沒給性別時用與玩家相反的性別（也是確定性，不是隨機）。 */
function oppositeSex(sex: SceneSex): SceneSex {
  return sex === "male" ? "female" : "male";
}

/**
 * 外觀只由 (seed, role, sex, stage) 決定：**不會因為交了伴侶或養了寵物
 * 就改玩家的髮型／髮色**。這比「同狀態同外觀」更強：同一個人在不同
 * 關係狀態下看起來仍是同一個人，伴侶／寵物只是疊加的新圖層。
 */
function appearanceOf(
  sex: SceneSex,
  stage: SceneAgeStage,
  seed: string,
  role: "player" | "partner"
): Appearance {
  const variant = hash32(`${seed}|${role}|${sex}|${stage}`) % HAIR_COLORS.length;
  const longHair = sex === "female" && stage !== "senior";
  const hairColor = stage === "senior" ? "#d9d3c6" : (HAIR_COLORS[variant] as string);
  const topColor =
    stage === "child" ? (sex === "female" ? "#e98f9b" : "#e88b5a")
      : stage === "student" ? (sex === "female" ? "#7fa9c9" : "#5b8fb9")
        : stage === "young" ? (sex === "female" ? "#c2607a" : "#3f7d6a")
          : stage === "middle" ? (sex === "female" ? "#8f5a86" : "#40566f")
            : (sex === "female" ? "#9c8a76" : "#8a7b63");
  const skirt = sex === "female" && (stage === "student" || stage === "young" || stage === "middle");
  return {
    shape: STAGE_SHAPE[stage],
    hairColor,
    topColor,
    bottomColor: skirt ? "#b4586e" : "#3d4657",
    longHair,
    skirt,
    backpack: stage === "student",
    glasses: stage === "senior",
    cane: stage === "senior",
    key: `${sex}/${stage}/${hairColor}/${topColor}/${longHair}/${skirt}`
  };
}

/* ------------------------------------------------------------------ */
/* SVG 图层                                                            */
/* ------------------------------------------------------------------ */

export const SCENE_VIEWBOX_WIDTH = 390;
export const SCENE_VIEWBOX_HEIGHT = 220;
/** 地面线（人物脚底），与 390x844／430x932 的 190–230px 场景高度相称。 */
const GROUND_Y = 196;

/** 左侧状态卡在 390px 宽时约占 x=16..173；人物全部排在安全区右侧。 */
export const SCENE_SAFE_LEFT_X = 190;
export const PLAYER_CENTER_X = 232;
export const PARTNER_CENTER_X = 300;
export const PET_CENTER_X = 352;

const SKIN = "#f3c99c";
const EYE = "#3a2c24";

function rect(x: number, y: number, w: number, h: number, fill: string, extra = ""): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
}

/** 背景：只有景物，没有任何固定人物或鸡；urban / rural 显著不同。 */
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
    // 城市：天际线、窗户、路灯、人行道、花坛。
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
    // 农村：远山、梯田、瓦顶屋舍、树、篱笆；仍然没有人或鸡。
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
      // 两栋瓦顶屋舍（三角形屋顶 + 门窗）。
      `<polygon points="24,128 66,100 108,128" fill="#a5573f"/>` +
      rect(32, 128, 68, 44, "#e4cf9f") + rect(58, 144, 18, 28, "#8a6a44") +
      rect(38, 138, 14, 12, "#8ec4d6") + rect(84, 138, 12, 12, "#8ec4d6") +
      `<polygon points="270,134 306,110 342,134" fill="#a5573f"/>` +
      rect(278, 134, 56, 38, "#e4cf9f") + rect(300, 148, 14, 24, "#8a6a44") +
      // 树。
      rect(196, 142, 9, 32, "#7b5b3a") + `<circle cx="200" cy="136" r="22" fill="#6f9a5a"/>` +
      `<circle cx="188" cy="128" r="13" fill="#7faa67"/>` +
      fence +
      rect(0, 173, SCENE_VIEWBOX_WIDTH, 3, "#8a6a44");
  }
  return `${head}${scenery}</g>`;
}

/** 人物：身高、发型／发色、服装随性别与年龄阶段显著变化。 */
function personLayer(
  scene: SceneView,
  seed: string,
  role: "player" | "partner",
  sex: SceneSex,
  stage: SceneAgeStage,
  centerX: number
): string {
  const look = appearanceOf(sex, stage, seed, role);
  const { height, headRadius, bodyHeight } = look.shape;
  const topY = GROUND_Y - height;
  const headCY = topY + headRadius;
  const bodyY = topY + headRadius * 2;
  const legY = bodyY + bodyHeight;
  const legH = GROUND_Y - legY;
  const bodyW = Math.round(headRadius * 1.7);
  const bodyX = Math.round(centerX - bodyW / 2);
  const headX = centerX;
  const parts: string[] = [];

  // 影子。
  parts.push(`<ellipse cx="${centerX}" cy="${GROUND_Y + 2}" rx="${Math.round(headRadius * 1.5)}" ry="4" fill="rgba(44,38,26,0.22)"/>`);
  // 学生背包（在身体后面）。
  if (look.backpack) {
    parts.push(rect(bodyX - 8, bodyY + 4, 9, Math.round(bodyHeight * 0.8), "#c9763f"));
  }
  // 腿／裙子。
  if (look.skirt) {
    parts.push(`<polygon points="${bodyX},${legY - 2} ${bodyX + bodyW},${legY - 2} ${bodyX + bodyW + 7},${legY + Math.round(legH * 0.72)} ${bodyX - 7},${legY + Math.round(legH * 0.72)}" fill="${look.bottomColor}"/>`);
    parts.push(rect(Math.round(centerX - 6), legY + Math.round(legH * 0.6), 4, Math.round(legH * 0.4), SKIN));
    parts.push(rect(Math.round(centerX + 2), legY + Math.round(legH * 0.6), 4, Math.round(legH * 0.4), SKIN));
  } else {
    parts.push(rect(Math.round(centerX - bodyW / 2 + 1), legY, Math.round(bodyW / 2 - 2), legH, look.bottomColor));
    parts.push(rect(Math.round(centerX + 1), legY, Math.round(bodyW / 2 - 2), legH, look.bottomColor));
    parts.push(rect(Math.round(centerX - bodyW / 2 - 1), GROUND_Y - 4, Math.round(bodyW / 2), 4, "#4a3c31"));
    parts.push(rect(Math.round(centerX + 1), GROUND_Y - 4, Math.round(bodyW / 2), 4, "#4a3c31"));
  }
  // 身体。
  parts.push(rect(bodyX, bodyY, bodyW, bodyHeight, look.topColor));
  // 领口／钮扣。
  parts.push(rect(Math.round(centerX - 2), bodyY, 4, Math.min(9, bodyHeight), "#f3e6c8"));
  // 手臂。
  parts.push(rect(bodyX - 5, bodyY + 3, 5, Math.round(bodyHeight * 0.72), look.topColor));
  parts.push(rect(bodyX + bodyW, bodyY + 3, 5, Math.round(bodyHeight * 0.72), look.topColor));
  parts.push(`<circle cx="${bodyX - 2}" cy="${bodyY + Math.round(bodyHeight * 0.78)}" r="3.4" fill="${SKIN}"/>`);
  parts.push(`<circle cx="${bodyX + bodyW + 2}" cy="${bodyY + Math.round(bodyHeight * 0.78)}" r="3.4" fill="${SKIN}"/>`);
  // 头。
  parts.push(`<circle cx="${headX}" cy="${headCY}" r="${headRadius}" fill="${SKIN}"/>`);
  // 发型：男性短发（弧形），女性长发（两侧长条 + 顶部）。
  if (look.longHair) {
    parts.push(rect(Math.round(headX - headRadius - 2), headCY - 4, 5, Math.round(headRadius * 1.9), look.hairColor));
    parts.push(rect(Math.round(headX + headRadius - 3), headCY - 4, 5, Math.round(headRadius * 1.9), look.hairColor));
    parts.push(`<path d="M${headX - headRadius} ${headCY} a${headRadius} ${headRadius} 0 0 1 ${headRadius * 2} 0 Z" fill="${look.hairColor}"/>`);
  } else {
    parts.push(`<path d="M${headX - headRadius} ${headCY + 1} a${headRadius} ${headRadius} 0 0 1 ${headRadius * 2} 0 Z" fill="${look.hairColor}"/>`);
    parts.push(rect(Math.round(headX - headRadius), headCY - 1, 3, 3, look.hairColor));
    parts.push(rect(Math.round(headX + headRadius - 3), headCY - 1, 3, 3, look.hairColor));
  }
  // 眼睛。
  const eyeY = headCY + 2;
  parts.push(`<circle cx="${Math.round(headX - headRadius * 0.36)}" cy="${eyeY}" r="1.5" fill="${EYE}"/>`);
  parts.push(`<circle cx="${Math.round(headX + headRadius * 0.36)}" cy="${eyeY}" r="1.5" fill="${EYE}"/>`);
  // 老年眼镜 + 手杖。
  if (look.glasses) {
    parts.push(`<circle cx="${Math.round(headX - headRadius * 0.36)}" cy="${eyeY}" r="3.6" fill="none" stroke="#6b6257" stroke-width="1"/>`);
    parts.push(`<circle cx="${Math.round(headX + headRadius * 0.36)}" cy="${eyeY}" r="3.6" fill="none" stroke="#6b6257" stroke-width="1"/>`);
  }
  if (look.cane) {
    parts.push(rect(Math.round(centerX + bodyW + 8), bodyY + 6, 2, GROUND_Y - bodyY - 6, "#7b5b3a"));
  }
  return `<g data-layer="${role}" data-sex="${sex}" data-age-stage="${stage}" data-variant="${look.key}">${parts.join("")}</g>`;
}

/** 宠物：狗（垂耳 + 直尾）与猫（尖耳 + 卷尾）形状明显不同；none 不输出。 */
function petLayer(pet: Exclude<ScenePetKind, "none">): string {
  const x = PET_CENTER_X - 14;
  const bodyY = GROUND_Y - 18;
  const fur = pet === "dog" ? "#a9713f" : "#d99a55";
  const dark = pet === "dog" ? "#7d4f2a" : "#a9703a";
  const parts: string[] = [];
  parts.push(`<ellipse cx="${x + 14}" cy="${GROUND_Y + 1}" rx="16" ry="3" fill="rgba(44,38,26,0.2)"/>`);
  // 四条腿。
  for (const lx of [x + 3, x + 10, x + 18, x + 25]) parts.push(rect(lx, bodyY + 12, 4, 7, dark));
  // 身体。
  parts.push(rect(x + 1, bodyY, 27, 14, fur));
  if (pet === "cat") {
    parts.push(rect(x + 7, bodyY + 3, 3, 8, dark));
    parts.push(rect(x + 16, bodyY + 3, 3, 8, dark));
    parts.push(`<path d="M${x + 28} ${bodyY + 10} q10 -2 7 -12" fill="none" stroke="${dark}" stroke-width="3" stroke-linecap="round"/>`);
  } else {
    parts.push(`<rect x="${x + 28}" y="${bodyY + 2}" width="10" height="3" fill="${dark}"/>`);
  }
  // 头。
  parts.push(`<circle cx="${x + 2}" cy="${bodyY + 5}" r="9" fill="${fur}"/>`);
  if (pet === "cat") {
    parts.push(`<polygon points="${x - 5},${bodyY - 2} ${x - 1},${bodyY - 11} ${x + 3},${bodyY - 3}" fill="${fur}"/>`);
    parts.push(`<polygon points="${x + 4},${bodyY - 3} ${x + 8},${bodyY - 11} ${x + 10},${bodyY - 1}" fill="${fur}"/>`);
  } else {
    parts.push(`<ellipse cx="${x - 5}" cy="${bodyY + 6}" rx="3.5" ry="7" fill="${dark}"/>`);
  }
  parts.push(`<circle cx="${x - 1}" cy="${bodyY + 3}" r="1.4" fill="${EYE}"/>`);
  parts.push(`<circle cx="${x + 4}" cy="${bodyY + 3}" r="1.4" fill="${EYE}"/>`);
  return `<g data-layer="pet" data-pet="${pet}">${parts.join("")}</g>`;
}

/* ------------------------------------------------------------------ */
/* 公开入口                                                            */
/* ------------------------------------------------------------------ */

/** 这一帧有哪些层、各自的稳定外观指纹（供测试／smoke 断言，不解析 SVG）。 */
export function describeSceneLayers(scene: SceneView, seed = ""): readonly SceneLayerDescriptor[] {
  const partnerSex = scene.partnerSex ?? oppositeSex(scene.playerSex);
  const partnerStage: SceneAgeStage =
    scene.ageStage === "child" || scene.ageStage === "student" ? "young" : scene.ageStage;
  return Object.freeze([
    Object.freeze({ layer: "background" as const, visible: true, key: `${scene.residenceKind}/${scene.phase}` }),
    Object.freeze({
      layer: "player" as const,
      visible: true,
      key: appearanceOf(scene.playerSex, scene.ageStage, seed, "player").key
    }),
    Object.freeze({
      layer: "partner" as const,
      visible: scene.hasPartner,
      key: scene.hasPartner ? appearanceOf(partnerSex, partnerStage, seed, "partner").key : "none"
    }),
    Object.freeze({
      layer: "pet" as const,
      visible: scene.petKind !== "none",
      key: scene.petKind
    })
  ]);
}

/** 产生完整分层 SVG（原创向量图，无任何外部资源、无 emoji、无文字）。 */
export function buildSceneSvg(scene: SceneView, seed = ""): string {
  const layers: string[] = [backgroundLayer(scene)];
  layers.push(personLayer(scene, seed, "player", scene.playerSex, scene.ageStage, PLAYER_CENTER_X));
  if (scene.hasPartner) {
    const partnerSex = scene.partnerSex ?? oppositeSex(scene.playerSex);
    const partnerStage: SceneAgeStage =
      scene.ageStage === "child" || scene.ageStage === "student" ? "young" : scene.ageStage;
    layers.push(personLayer(scene, seed, "partner", partnerSex, partnerStage, PARTNER_CENTER_X));
  }
  if (scene.petKind !== "none") layers.push(petLayer(scene.petKind));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SCENE_VIEWBOX_WIDTH} ${SCENE_VIEWBOX_HEIGHT}" ` +
    `width="${SCENE_VIEWBOX_WIDTH}" height="${SCENE_VIEWBOX_HEIGHT}" preserveAspectRatio="xMidYMid slice">` +
    `<title>Layered life scene</title>${layers.join("")}</svg>`;
}

/** CSS `background-image` 用的 data URI（本地生成，无 CDN、无第三方档案）。 */
export function sceneSvgDataUri(scene: SceneView, seed = ""): string {
  // encodeURIComponent 不會逃逸 ( ) ' ，但 SVG 裡的 rgba(...) 含括號；
  // 補齊這三個字元才能放進 CSS url("...")，也讓 url() 擷取正則不截斷。
  const encoded = encodeURIComponent(buildSceneSvg(scene, seed))
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/'/g, "%27");
  return `data:image/svg+xml,${encoded}`;
}

/** 稳定签名：同 seed／同状态相同；用于 smoke 验证 reload 后外观不变。 */
export function sceneSignature(scene: SceneView, seed = ""): string {
  return hash32(buildSceneSvg(scene, seed)).toString(16).padStart(8, "0");
}
