import { describe, expect, it } from "vitest";
import {
  ageStageOfAge,
  lifeStageOfAge,
  buildSceneSvg,
  describeSceneGeometry,
  readSceneView,
  sceneSignature,
  SCENE_GROUND_Y,
  SCENE_SAFE_BOX,
  SCENE_VIEWBOX_HEIGHT,
  SCENE_VIEWBOX_WIDTH,
  type SceneLifeStage,
  type ScenePetKind,
  type SceneSex,
  type SceneView
} from "../src/p3e-scene";
import { PEEP_ANCHORS } from "../src/p3e-peep-anchors";

/**
 * GPT-WORKBUDDY-DAYU-0073-A｜配件錨點與安全區的**幾何**驗收。
 *
 * 0073 回報的缺陷是「眼鏡落到脖子、拐杖浮空、人物超出可顯示區」，這些都是
 * 座標問題，字串存在與否測不出來。所以這裡全部用 `describeSceneGeometry()`
 * 回傳的場景座標做數值斷言：
 *
 *  - 人物 + 已啟用配件的總 bounds 必須落在 `SCENE_SAFE_BOX`。
 *  - 腳底必須貼齊 `SCENE_GROUND_Y`（不浮空、不陷入地面）。
 *  - 眼鏡中心＝量測到的眼睛中心，鏡框不得大於臉／頭。
 *  - 圍巾必須在眼睛下方（不遮臉），且不寬於身體。
 *  - 拐杖上端落在手的高度、下端落地、杖身在身體輪廓之外。
 *
 * 矩陣：8 個官方 Open Peeps × 20 個 derived＝28 個資產、2 性別、8 個生活階段、
 * 玩家／伴侶、4 種寵物狀態 → 由 `describeSceneGeometry()` 逐組檢查。
 */

const SEXES: readonly SceneSex[] = ["male", "female"];
const PETS: readonly ScenePetKind[] = ["none", "dog", "cat"];
const LIFE_STAGES: readonly SceneLifeStage[] = [
  "baby", "child", "primary", "teen", "university", "young", "middle", "senior"
];
/** 每個生活階段的代表年齡（與 application 的八段門檻一致）。 */
const STAGE_AGE: Readonly<Record<SceneLifeStage, number>> = Object.freeze({
  baby: 1, child: 4, primary: 8, teen: 14, university: 20, young: 30, middle: 48, senior: 70
});

function sceneOf(input: Partial<SceneView> = {}): SceneView {
  const age = input.age ?? STAGE_AGE[input.lifeStage ?? "young"];
  return {
    playerSex: "female",
    residenceKind: "rural",
    hasPartner: false,
    partnerSex: null,
    partnerAge: null,
    petKind: "none",
    phase: "alive",
    ...input,
    age,
    ageStage: ageStageOfAge(age),
    lifeStage: lifeStageOfAge(age)
  };
}

/** 收集矩陣中實際出現過的資產，確認 28 個都真的被畫出來過。 */
const SEEN_ASSETS = new Set<string>();

function checkActor(scene: SceneView, seed: string): void {
  for (const actor of describeSceneGeometry(scene, seed)) {
    SEEN_ASSETS.add(actor.assetKey);
    const label = `${actor.role}/${actor.assetKey}@${scene.lifeStage}`;
    const contentWidth = actor.content.right - actor.content.left;

    // --- A. 人物 + 配件完整落在安全顯示區 -----------------------------
    expect(actor.bounds.left, `${label} left`).toBeGreaterThanOrEqual(SCENE_SAFE_BOX.left - 0.01);
    expect(actor.bounds.right, `${label} right`).toBeLessThanOrEqual(SCENE_SAFE_BOX.right + 0.01);
    expect(actor.bounds.top, `${label} top`).toBeGreaterThanOrEqual(SCENE_SAFE_BOX.top - 0.01);
    expect(actor.bounds.bottom, `${label} bottom`).toBeLessThanOrEqual(SCENE_SAFE_BOX.bottom + 0.01);
    // 也不可超出場景 viewBox（多一層保險，避免安全區常數被改壞）。
    expect(actor.bounds.left).toBeGreaterThanOrEqual(0);
    expect(actor.bounds.right).toBeLessThanOrEqual(SCENE_VIEWBOX_WIDTH);
    expect(actor.bounds.top).toBeGreaterThanOrEqual(0);
    expect(actor.bounds.bottom).toBeLessThanOrEqual(SCENE_VIEWBOX_HEIGHT);

    // --- B. 腳底貼地 ---------------------------------------------------
    expect(actor.content.bottom, `${label} ground`).toBeLessThanOrEqual(SCENE_GROUND_Y + 0.01);
    expect(actor.content.bottom, `${label} floating`).toBeGreaterThan(SCENE_GROUND_Y - 4);

    // --- C. 眼睛在頭框內 -----------------------------------------------
    expect(actor.eye.cx).toBeGreaterThan(actor.head.left);
    expect(actor.eye.cx).toBeLessThan(actor.head.right);
    expect(actor.eye.cy).toBeGreaterThan(actor.head.top);
    expect(actor.eye.cy).toBeLessThan(actor.head.bottom);

    // --- D. 眼鏡：中心＝眼睛中心，鏡框隨頭部縮放 -----------------------
    if (scene.lifeStage === "senior") {
      expect(actor.glasses, `${label} glasses`).not.toBeNull();
      const glasses = actor.glasses!;
      expect(Math.abs(glasses.cx - actor.eye.cx)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(glasses.cy - actor.eye.cy)).toBeLessThanOrEqual(0.01);
      const headWidth = actor.head.right - actor.head.left;
      // 鏡片半寬不可超過頭寬的 1/3，也不會小到框不住眼睛。
      expect(glasses.rx).toBeLessThanOrEqual(headWidth * 0.34);
      expect(glasses.rx).toBeGreaterThanOrEqual(actor.eye.radius * 1.1);
      // 眼鏡不得超出安全區。
      expect(glasses.box.left).toBeGreaterThanOrEqual(SCENE_SAFE_BOX.left - 0.01);
      expect(glasses.box.right).toBeLessThanOrEqual(SCENE_SAFE_BOX.right + 0.01);
      expect(glasses.box.top).toBeGreaterThanOrEqual(SCENE_SAFE_BOX.top - 0.01);
    } else {
      expect(actor.glasses, `${label} glasses only on senior`).toBeNull();
    }

    // --- E. 圍巾：在眼睛下方、不遮臉、不寬於身體 -----------------------
    if (scene.lifeStage === "middle" || scene.lifeStage === "senior") {
      expect(actor.scarf, `${label} scarf`).not.toBeNull();
      const scarf = actor.scarf!;
      // 巾身（含打結）必須整個在眼睛下方至少一個瞳孔直徑，不能蓋到臉。
      expect(scarf.box.top, `${label} scarf covers face`)
        .toBeGreaterThan(actor.eye.cy + actor.eye.radius);
      // 也要在肩線之上（落在頸肩，不是胸口）。
      expect(scarf.cy - actor.content.top).toBeLessThan((actor.content.bottom - actor.content.top) * 0.32);
      // 不寬於人物本體。
      expect(scarf.halfWidth * 2).toBeLessThan(contentWidth);
      expect(scarf.box.left).toBeGreaterThanOrEqual(SCENE_SAFE_BOX.left - 0.01);
      expect(scarf.box.right).toBeLessThanOrEqual(SCENE_SAFE_BOX.right + 0.01);
    } else {
      expect(actor.scarf, `${label} scarf only on middle/senior`).toBeNull();
    }

    // --- F. 拐杖：上端在手、下端落地、杖身在身體之外 -------------------
    if (scene.lifeStage === "senior") {
      expect(actor.cane, `${label} cane`).not.toBeNull();
      const cane = actor.cane!;
      // 下端踩在地面（content 的腳底）。
      expect(Math.abs(cane.bottom - actor.content.bottom)).toBeLessThanOrEqual(0.5);
      // 上端（握把）在身體上半部、高於地面至少 1/3 身高。
      const height = actor.content.bottom - actor.content.top;
      expect(cane.top).toBeGreaterThan(actor.content.top + height * 0.3);
      expect(cane.top).toBeLessThan(actor.content.bottom - height * 0.2);
      // 杖身一定在身體輪廓的左右之外，不會穿過身體中央。
      const outside = cane.x < actor.content.left - 0.4 || cane.x > actor.content.right + 0.4;
      expect(outside, `${label} cane inside body`).toBe(true);
      expect(cane.box.left).toBeGreaterThanOrEqual(SCENE_SAFE_BOX.left - 0.01);
      expect(cane.box.right).toBeLessThanOrEqual(SCENE_SAFE_BOX.right + 0.01);
    } else {
      expect(actor.cane, `${label} cane only on senior`).toBeNull();
    }
  }
}

describe("GPT-0073-A 場景幾何：配件錨點與安全顯示區", () => {
  it("2 性別 × 8 生活階段 × 玩家／伴侶 × 3 種寵物狀態，全部通過幾何斷言", () => {
    let checked = 0;
    for (const playerSex of SEXES) {
      for (const lifeStage of LIFE_STAGES) {
        for (const hasPartner of [false, true]) {
          for (const petKind of PETS) {
            const scene = sceneOf({
              playerSex,
              lifeStage,
              hasPartner,
              partnerSex: playerSex === "male" ? "female" : "male",
              petKind
            });
            checkActor(scene, `geo-${playerSex}-${lifeStage}-${hasPartner}-${petKind}`);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(2 * 8 * 2 * PETS.length);
  });

  it("玩家與伴侶同時在場時不互相重疊，配件也不會跑到對方身上", () => {
    for (const playerSex of SEXES) {
      for (const lifeStage of LIFE_STAGES) {
        const scene = sceneOf({
          playerSex,
          lifeStage,
          hasPartner: true,
          partnerSex: playerSex === "male" ? "female" : "male"
        });
        const [player, partner] = describeSceneGeometry(scene, `pair-${playerSex}-${lifeStage}`);
        expect(player).toBeDefined();
        expect(partner).toBeDefined();
        // 玩家完整在伴侶左邊。
        expect(player!.content.right).toBeLessThanOrEqual(partner!.content.left + 0.01);
        expect(player!.bounds.right).toBeLessThanOrEqual(partner!.content.left + 0.01);
        // 玩家的拐杖在左側、伴侶的拐杖在右側（外側），不會夾在中間。
        if (player!.cane !== null) expect(player!.cane.x).toBeLessThan(player!.content.left);
        if (partner!.cane !== null) expect(partner!.cane.x).toBeGreaterThan(partner!.content.right);
      }
    }
  });

  it("不同 seed 會輪到不同的角色資產，28 個人物資產全部被實際畫過", () => {
    // 固定 seed 序列，逐一跑遍生活階段；先把矩陣裡會出現的資產收集起來。
    SEEN_ASSETS.clear();
    for (const playerSex of SEXES) {
      for (const lifeStage of LIFE_STAGES) {
        for (let seed = 0; seed < 32; seed += 1) {
          checkActor(
            sceneOf({ playerSex, lifeStage, hasPartner: true, partnerSex: playerSex }),
            `asset-${seed}`
          );
        }
      }
    }
    const expected = Object.keys(PEEP_ANCHORS).sort();
    const missing = expected.filter((key) => !SEEN_ASSETS.has(key));
    expect(missing).toEqual([]);
    expect(SEEN_ASSETS.size).toBe(expected.length);
  });

  it("配件在 SVG 裡是同一座標系的一層，不是外掛的固定 offset", () => {
    const senior = buildSceneSvg(sceneOf({ lifeStage: "senior" }), "geo-svg");
    // 配件圖層真的存在。
    expect(senior).toContain('data-part="original/item/reading-glasses"');
    expect(senior).toContain('data-part="original/item/scarf"');
    expect(senior).toContain('data-part="original/item/cane"');
    // 只有一個 transform（translate+scale），配件與人物本體共用它。
    const playerGroup = /<g data-layer="player"[\s\S]*?<g transform="([^"]+)"/.exec(senior)?.[1] ?? "";
    expect(playerGroup).toMatch(/^translate\([-\d.]+ [-\d.]+\) scale\([\d.]+\)$/);
    const transformCount = (senior.match(/<g transform="translate\([-\d.]+ [-\d.]+\) scale\(/g) ?? []).length;
    expect(transformCount).toBeGreaterThanOrEqual(1);
    // 中年：只有圍巾，不會多出眼鏡／拐杖。
    const middle = buildSceneSvg(sceneOf({ lifeStage: "middle" }), "geo-svg");
    expect(middle).toContain('data-part="original/item/scarf"');
    expect(middle).not.toContain('data-part="original/item/cane"');
    expect(middle).not.toContain('data-part="original/item/reading-glasses"');
    // 青年：沒有額外配件（背包／開襟衫是 university 資產自帶的部件）。
    const young = buildSceneSvg(sceneOf({ lifeStage: "young" }), "geo-svg");
    expect(young).not.toContain('data-part="original/item/scarf"');
    expect(young).not.toContain('data-part="original/item/cane"');
  });

  it("根場景使用不裁切人物的 preserveAspectRatio，且輸出仍是單張圖片", () => {
    const svg = buildSceneSvg(sceneOf({ hasPartner: true, petKind: "dog" }), "geo-fit");
    expect(svg).toContain('preserveAspectRatio="xMidYMax meet"');
    expect(svg).not.toContain("slice");
    expect(svg.match(/<svg /g)?.length).toBe(1);
    // 幾何與簽名都是純函式：同輸入同輸出。
    expect(sceneSignature(sceneOf({ hasPartner: true, petKind: "dog" }), "geo-fit"))
      .toBe(sceneSignature(sceneOf({ hasPartner: true, petKind: "dog" }), "geo-fit"));
  });

  it("readSceneView 的正式投影不會產生非法幾何", () => {
    const view = readSceneView({ scene: { age: 68, playerSex: "male", hasPartner: true, partnerSex: "female", partnerAge: 66, petKind: "cat" } });
    for (const actor of describeSceneGeometry(view, "geo-read")) {
      expect(Number.isFinite(actor.scale)).toBe(true);
      expect(actor.scale).toBeGreaterThan(0);
      expect(actor.content.right).toBeGreaterThan(actor.content.left);
      expect(actor.content.bottom).toBeGreaterThan(actor.content.top);
      expect(actor.bounds.top).toBeLessThanOrEqual(actor.content.top);
      expect(actor.bounds.bottom).toBeGreaterThanOrEqual(actor.content.bottom);
    }
  });
});
