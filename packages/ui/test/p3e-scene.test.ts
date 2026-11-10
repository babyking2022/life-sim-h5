import { describe, expect, it } from "vitest";
import {
  buildSceneSvg,
  describeSceneGeometry,
  describeSceneLayers,
  describeSceneParts,
  ageStageOfAge,
  lifeStageOfAge,
  DEFAULT_SCENE_VIEW,
  readSceneView,
  sceneSignature,
  sceneSvgDataUri,
  PARTNER_CENTER_X,
  PET_CENTER_X,
  PLAYER_CENTER_X,
  SCENE_SAFE_LEFT_X,
  SCENE_SAFE_BOX,
  SCENE_GROUND_Y,
  SCENE_VIEWBOX_HEIGHT,
  SCENE_VIEWBOX_WIDTH,
  type SceneAgeStage,
  type ScenePetKind,
  type SceneResidenceKind,
  type SceneSex,
  type SceneView
} from "../src/p3e-scene";
import { OPEN_PEEPS_BY_SEX } from "../src/p3e-open-peeps";

/**
 * GPT-WORKBUDDY-0054-B／0063-B｜任務一驗收：分層動態場景。
 *
 * 矩陣：2 性別 × 6 年齡階段 × 2 城鄉 × 有／無伴侶 × dog／cat／none = 144 組。
 * 全部在純函式上驗證，不需 DOM／jsdom。
 */

const SEXES: readonly SceneSex[] = ["male", "female"];
const AGE_STAGES: readonly SceneAgeStage[] = ["baby", "child", "student", "young", "middle", "senior"];
const STAGE_AGE: Readonly<Record<SceneAgeStage, number>> = Object.freeze({
  baby: 1, child: 4, student: 13, young: 28, middle: 48, senior: 68
});
const RESIDENCES: readonly SceneResidenceKind[] = ["urban", "rural"];
const PETS: readonly ScenePetKind[] = ["none", "dog", "cat"];
const HAS_PARTNER: readonly boolean[] = [false, true];

/** 一律以精確 age 為準產生一致的 ageStage／lifeStage，模擬正式 view.scene。 */
function sceneOf(input: Partial<SceneView> = {}): SceneView {
  const age = input.age ?? STAGE_AGE[input.ageStage ?? "young"];
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

/** SVG 是「圖片」，人物／寵物都是向量形狀，不是 emoji 也不是文字標籤。 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const INTERNAL_KEY_RE = /(?:p3[ab]\.|ev\.|dec\.|microUsd|\$[A-Za-z_]|job:|pet:|career:)/;

describe("GPT-0054-B 場景：完整狀態矩陣", () => {
  it("2 性別 × 6 年齡 × 2 城鄉 × 伴侶有無 × 寵物三態 = 144 組都畫出正確分層", () => {
    let count = 0;
    for (const playerSex of SEXES) {
      for (const ageStage of AGE_STAGES) {
        for (const residenceKind of RESIDENCES) {
          for (const hasPartner of HAS_PARTNER) {
            for (const petKind of PETS) {
              const scene = sceneOf({ playerSex, ageStage, residenceKind, hasPartner, petKind });
              const svg = buildSceneSvg(scene, "seed-matrix");
              const layers = describeSceneLayers(scene, "seed-matrix");
              count += 1;

              // 輸出必須是真正的 SVG 圖片，不是 emoji／文字／internal key。
              expect(svg.startsWith("<svg")).toBe(true);
              expect(svg).toContain("xmlns=\"http://www.w3.org/2000/svg\"");
              expect(svg).toContain("<rect");
              expect(EMOJI_RE.test(svg)).toBe(false);
              expect(INTERNAL_KEY_RE.test(svg)).toBe(false);

              // 背景 + 玩家永遠存在；伴侶／寵物依照投影開關。
              expect(svg).toContain("data-layer=\"background\"");
              expect(svg).toContain("data-layer=\"player\"");
              expect(svg).toContain(`data-residence="${residenceKind}"`);
              expect(svg.includes("data-layer=\"partner\"")).toBe(hasPartner);
              expect(svg.includes("data-layer=\"pet\"")).toBe(petKind !== "none");
              if (petKind !== "none") expect(svg).toContain(`data-pet="${petKind}"`);

              // descriptor 與 SVG 一致。
              expect(layers.find((layer) => layer.layer === "background")?.visible).toBe(true);
              expect(layers.find((layer) => layer.layer === "player")?.visible).toBe(true);
              expect(layers.find((layer) => layer.layer === "partner")?.visible).toBe(hasPartner);
              expect(layers.find((layer) => layer.layer === "pet")?.visible).toBe(petKind !== "none");

              // 0063-B：頂層 SVG 的精確年齡／生活階段必須與投影一致。
              expect(svg).toContain(`data-age="${scene.age}"`);
              expect(svg).toContain(`data-life-stage="${scene.lifeStage}"`);
              expect(svg).toContain(`data-age-stage="${scene.ageStage}"`);

              // 同 seed／同狀態 → 同一張圖（不每次 render 改髮型）。
              expect(buildSceneSvg(scene, "seed-matrix")).toBe(svg);
              expect(sceneSignature(scene, "seed-matrix")).toBe(sceneSignature(scene, "seed-matrix"));
            }
          }
        }
      }
    }
    expect(count).toBe(144);
  });

  it("背景層不含任何固定人物／雞，也不含人物用色", () => {
    for (const residenceKind of RESIDENCES) {
      const svg = buildSceneSvg(sceneOf({ residenceKind }), "seed-bg");
      const start = svg.indexOf("<g data-layer=\"background\"");
      const end = svg.indexOf("</g>", start);
      const background = svg.slice(start, end);
      expect(start).toBeGreaterThan(-1);
      expect(background).toContain(`data-residence="${residenceKind}"`);
      expect(background).not.toContain("data-layer=\"player\"");
      expect(background).not.toContain("data-layer=\"partner\"");
      expect(background).not.toContain("data-layer=\"pet\"");
      // 人物皮膚色、眼睛色只會出現在人物／寵物層。
      expect(background).not.toContain("#f3c99c");
      expect(background).not.toContain("#3a2c24");
    }
    // urban / rural 必須是兩套明顯不同的背景。
    expect(buildSceneSvg(sceneOf({ residenceKind: "urban" }), "s")).not.toBe(
      buildSceneSvg(sceneOf({ residenceKind: "rural" }), "s")
    );
  });

  it("玩家在 6 個年齡階段、2 個性別都有顯著不同外觀（身高／髮型髮色／服裝）", () => {
    const variants = new Set<string>();
    for (const playerSex of SEXES) {
      for (const ageStage of AGE_STAGES) {
        const svg = buildSceneSvg(sceneOf({ playerSex, ageStage }), "seed-look");
        const matched = /data-layer="player"[^>]*data-variant="([^"]+)"/.exec(svg);
        expect(matched).not.toBeNull();
        variants.add(matched?.[1] ?? "");
        expect(svg).toContain(`data-age-stage="${ageStage}"`);
        expect(svg).toContain(`data-sex="${playerSex}"`);
      }
    }
    expect(variants.size).toBe(12);
    // 老年一定是灰白髮（與其它階段不同）。
    const seniorSvg = buildSceneSvg(sceneOf({ ageStage: "senior" }), "seed-look");
    expect(seniorSvg).toContain("#d9d3c6");
    expect(seniorSvg).toContain("<circle"); // 眼鏡也是向量畫的
    // 0062-B：兩個性別使用不同池的完整 Open Peeps 全身資產，且都是本地 SVG。
    const femaleSvg = buildSceneSvg(sceneOf({ playerSex: "female", ageStage: "young" }), "seed-look");
    const maleSvg = buildSceneSvg(sceneOf({ playerSex: "male", ageStage: "young" }), "seed-look");
    const femaleAsset = /data-layer="player"[^>]*data-asset="openpeeps\/([^"]+)"/.exec(femaleSvg)?.[1] ?? "";
    const maleAsset = /data-layer="player"[^>]*data-asset="openpeeps\/([^"]+)"/.exec(maleSvg)?.[1] ?? "";
    expect((OPEN_PEEPS_BY_SEX.female as readonly string[]).includes(femaleAsset)).toBe(true);
    expect((OPEN_PEEPS_BY_SEX.male as readonly string[]).includes(maleAsset)).toBe(true);
    expect(femaleAsset).not.toBe(maleAsset);
    expect(femaleSvg).toContain(`<g data-part="openpeeps/${femaleAsset}">`);
    expect(maleSvg).toContain(`<g data-part="openpeeps/${maleAsset}">`);
  });

  it("伴侶與寵物不遮住玩家、也不遮左側狀態卡", () => {
    expect(SCENE_SAFE_LEFT_X).toBeGreaterThan(173);
    expect(PLAYER_CENTER_X).toBeGreaterThan(SCENE_SAFE_LEFT_X);
    expect(PARTNER_CENTER_X - PLAYER_CENTER_X).toBeGreaterThanOrEqual(48);
    expect(PET_CENTER_X).toBeGreaterThan(PARTNER_CENTER_X);
    expect(PET_CENTER_X + 30).toBeLessThanOrEqual(SCENE_VIEWBOX_WIDTH);
    // 場景高度落在任務要求的約 190–230px。
    expect(SCENE_VIEWBOX_HEIGHT).toBeGreaterThanOrEqual(190);
    expect(SCENE_VIEWBOX_HEIGHT).toBeLessThanOrEqual(230);

    const without = buildSceneSvg(sceneOf({ hasPartner: false, petKind: "none" }), "seed-x");
    const withPartner = buildSceneSvg(sceneOf({ hasPartner: true, petKind: "dog" }), "seed-x");
    // 玩家層完全不被改寫，只是多了伴侶／寵物兩層。
    const playerGroup = /<g data-layer="player"[\s\S]*?<\/g>/.exec(without)?.[0];
    expect(playerGroup).toBeDefined();
    expect(withPartner).toContain(playerGroup ?? "IMPOSSIBLE");
  });

  it("dog 與 cat 是不同形狀，none 完全不出現寵物層", () => {
    const dog = buildSceneSvg(sceneOf({ petKind: "dog" }), "seed-pet");
    const cat = buildSceneSvg(sceneOf({ petKind: "cat" }), "seed-pet");
    expect(dog).not.toBe(cat);
    expect(dog).toContain("<polygon"); // 貓用三角形耳朵與捲尾；狗用垂耳與直尾
    expect(cat).toContain("<polygon");
    expect(dog).toContain("data-pet=\"dog\"");
    expect(cat).toContain("data-pet=\"cat\"");
    expect(buildSceneSvg(sceneOf({ petKind: "none" }), "seed-pet")).not.toContain("data-layer=\"pet\"");
  });

  it("同 seed 穩定、不同 seed 可有多樣但仍各自穩定（無 Math.random）", () => {
    const scene = sceneOf({ hasPartner: true, petKind: "cat" });
    const baseline = sceneSignature(scene, "seed-A");
    for (let i = 0; i < 8; i += 1) expect(sceneSignature(scene, "seed-A")).toBe(baseline);
    const signatures = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const seed = `seed-${i}`;
      signatures.add(sceneSignature(scene, seed));
      expect(sceneSignature(scene, seed)).toBe(sceneSignature(scene, seed));
    }
    expect(signatures.size).toBeGreaterThan(1);
  });

  it("死亡狀態仍有穩定投影，且與存活狀態不同", () => {
    const alive = buildSceneSvg(sceneOf({ phase: "alive" }), "seed-dead");
    const dead = buildSceneSvg(sceneOf({ phase: "dead" }), "seed-dead");
    expect(dead).not.toBe(alive);
    expect(dead).toContain("data-phase=\"dead\"");
    expect(buildSceneSvg(sceneOf({ phase: "dead" }), "seed-dead")).toBe(dead);
  });

  it("data URI 是本地生成的 SVG，沒有 CDN／外部連結", () => {
    const uri = sceneSvgDataUri(sceneOf({ residenceKind: "urban", petKind: "dog" }), "seed-uri");
    expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
    expect(uri).not.toContain("http://");
    expect(uri).not.toContain("https://");
    expect(uri).not.toContain("cdn");
    expect(decodeURIComponent(uri.slice("data:image/svg+xml,".length))).toContain("<svg");
  });

  it("readSceneView 只認 view.scene 公開投影，不解析 flags、畸形值安全回退", () => {
    expect(readSceneView({ scene: sceneOf({ ageStage: "senior", petKind: "cat" }) })).toEqual(
      sceneOf({ ageStage: "senior", petKind: "cat" })
    );
    expect(readSceneView(null).ageStage).toBe("baby");
    expect(readSceneView(null).lifeStage).toBe("baby");
    expect(readSceneView(null).age).toBe(0);
    expect(readSceneView({}).petKind).toBe("none");
    // 即使底層有 pet:dog flag，沒有 scene 投影也不該自己猜。
    expect(readSceneView({ flags: ["pet:dog"], state: { age: 40 } }).petKind).toBe("none");
    // 畸形欄位逐一套用安全白名單預設，不把奇怪值直接畫出來。
    expect(readSceneView({ scene: { ageStage: "bogus", playerSex: "x", petKind: "bird" } })).toEqual(
      DEFAULT_SCENE_VIEW
    );
    expect(DEFAULT_SCENE_VIEW.ageStage).toBe("baby");
    expect(DEFAULT_SCENE_VIEW.petKind).toBe("none");
  });

  it("0063-B readSceneView 以精確 age 為準：拒絕 HUD 0 歲但場景塞成人", () => {
    // 故意給矛盾的 ageStage／lifeStage；formal age 必須勝出。
    const forged = readSceneView({
      scene: { ...sceneOf({ age: 0 }), ageStage: "senior", lifeStage: "senior" }
    });
    expect(forged.age).toBe(0);
    expect(forged.ageStage).toBe("baby");
    expect(forged.lifeStage).toBe("baby");
    const [baby] = describeSceneParts(forged, "seed-forged");
    expect(baby!.derived).toBe(true);
    expect(baby!.body).toContain("onesie");
    expect(buildSceneSvg(forged, "seed-forged")).not.toContain('data-part="openpeeps/pose/standing/');

    // 逐歲邊界：age → ageStage／lifeStage 與 application 完全一致。
    for (const [age, ageStage, lifeStage] of [
      [0, "baby", "baby"], [2, "baby", "baby"],
      [3, "child", "child"], [5, "child", "child"],
      [6, "student", "primary"], [11, "student", "primary"],
      [12, "student", "teen"], [17, "student", "teen"],
      [18, "student", "university"], [22, "student", "university"],
      [23, "young", "young"], [39, "young", "young"],
      [40, "middle", "middle"], [59, "middle", "middle"],
      [60, "senior", "senior"], [80, "senior", "senior"]
    ] as const) {
      expect(ageStageOfAge(age)).toBe(ageStage);
      expect(lifeStageOfAge(age)).toBe(lifeStage);
      const view = readSceneView({ scene: { ...sceneOf({ age }), age: age, ageStage: "bogus", lifeStage: "bogus" } });
      expect(view.ageStage).toBe(ageStage);
      expect(view.lifeStage).toBe(lifeStage);
    }
  });

  it("0073-A 每個年齡的人物＋配件都完整落在安全區，腳底貼地、身高足夠", () => {
    for (const age of [0, 3, 6, 13, 18, 25, 45, 65]) {
      for (const playerSex of SEXES) {
        for (const hasPartner of HAS_PARTNER) {
          const scene = sceneOf({ age, playerSex, hasPartner, petKind: "dog" });
          const actors = describeSceneGeometry(scene, "seed-safe");
          expect(actors.length).toBe(hasPartner ? 2 : 1);
          for (const actor of actors) {
            // 人物本體 + 眼鏡／圍巾／拐杖的總範圍，全部要在安全區內。
            expect(actor.bounds.left).toBeGreaterThanOrEqual(SCENE_SAFE_BOX.left - 0.01);
            expect(actor.bounds.right).toBeLessThanOrEqual(SCENE_SAFE_BOX.right + 0.01);
            expect(actor.bounds.top).toBeGreaterThanOrEqual(SCENE_SAFE_BOX.top - 0.01);
            expect(actor.bounds.bottom).toBeLessThanOrEqual(SCENE_SAFE_BOX.bottom + 0.01);
            // 腳底貼齊地面（不可浮空、不可踩進地面以下）。
            expect(actor.content.bottom).toBeGreaterThan(SCENE_GROUND_Y - 4);
            expect(actor.content.bottom).toBeLessThanOrEqual(SCENE_GROUND_Y + 0.01);
            // 「大且清楚」：玩家至少 95px、伴侶至少 85px（伴侶 slot 較窄，
            // 嬰兒坐姿又特別寬，會被寬度夾住）。
            const height = actor.content.bottom - actor.content.top;
            expect(height).toBeGreaterThanOrEqual(actor.role === "player" ? 95 : 85);
            // 不可超出場景 viewBox。
            expect(actor.bounds.left).toBeGreaterThanOrEqual(0);
            expect(actor.bounds.right).toBeLessThanOrEqual(SCENE_VIEWBOX_WIDTH);
          }
          // 兩人不可互相重疊（玩家在左、伴侶在右）。
          if (hasPartner) {
            expect(actors[0]!.content.right).toBeLessThanOrEqual(actors[1]!.content.left + 0.01);
          }
        }
      }
    }
  });
});
