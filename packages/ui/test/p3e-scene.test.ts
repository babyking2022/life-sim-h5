import { describe, expect, it } from "vitest";
import {
  buildSceneSvg,
  describeSceneLayers,
  DEFAULT_SCENE_VIEW,
  readSceneView,
  sceneSignature,
  sceneSvgDataUri,
  PARTNER_CENTER_X,
  PET_CENTER_X,
  PLAYER_CENTER_X,
  SCENE_SAFE_LEFT_X,
  SCENE_VIEWBOX_HEIGHT,
  SCENE_VIEWBOX_WIDTH,
  type SceneAgeStage,
  type ScenePetKind,
  type SceneResidenceKind,
  type SceneSex,
  type SceneView
} from "../src/p3e-scene";

/**
 * GPT-WORKBUDDY-0054-B｜任務一驗收：分層動態場景。
 *
 * 矩陣：2 性別 × 5 年齡階段 × 2 城鄉 × 有／無伴侶 × dog／cat／none = 120 組。
 * 全部在純函式上驗證，不需 DOM／jsdom。
 */

const SEXES: readonly SceneSex[] = ["male", "female"];
const AGE_STAGES: readonly SceneAgeStage[] = ["child", "student", "young", "middle", "senior"];
const RESIDENCES: readonly SceneResidenceKind[] = ["urban", "rural"];
const PETS: readonly ScenePetKind[] = ["none", "dog", "cat"];
const HAS_PARTNER: readonly boolean[] = [false, true];

function sceneOf(input: Partial<SceneView> = {}): SceneView {
  return {
    playerSex: "female",
    ageStage: "young",
    residenceKind: "rural",
    hasPartner: false,
    partnerSex: null,
    petKind: "none",
    phase: "alive",
    ...input
  };
}

/** SVG 是「圖片」，人物／寵物都是向量形狀，不是 emoji 也不是文字標籤。 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const INTERNAL_KEY_RE = /(?:p3[ab]\.|ev\.|dec\.|microUsd|\$[A-Za-z_]|job:|pet:|career:)/;

describe("GPT-0054-B 場景：完整狀態矩陣", () => {
  it("2 性別 × 5 年齡 × 2 城鄉 × 伴侶有無 × 寵物三態 = 120 組都畫出正確分層", () => {
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

              // 同 seed／同狀態 → 同一張圖（不每次 render 改髮型）。
              expect(buildSceneSvg(scene, "seed-matrix")).toBe(svg);
              expect(sceneSignature(scene, "seed-matrix")).toBe(sceneSignature(scene, "seed-matrix"));
            }
          }
        }
      }
    }
    expect(count).toBe(120);
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

  it("玩家在 5 個年齡階段、2 個性別都有顯著不同外觀（身高／髮型髮色／服裝）", () => {
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
    expect(variants.size).toBe(10);
    // 老年一定是灰白髮（與其它階段不同）。
    const seniorSvg = buildSceneSvg(sceneOf({ ageStage: "senior" }), "seed-look");
    expect(seniorSvg).toContain("#d9d3c6");
    expect(seniorSvg).toContain("<circle"); // 眼鏡也是向量畫的
    // 女性長髮、男性短髮形狀不同。
    const femaleSvg = buildSceneSvg(sceneOf({ playerSex: "female", ageStage: "young" }), "seed-look");
    const maleSvg = buildSceneSvg(sceneOf({ playerSex: "male", ageStage: "young" }), "seed-look");
    expect(femaleSvg).toContain("/true/true");
    expect(maleSvg).toContain("/false/false");
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
    expect(readSceneView(null).ageStage).toBe("child");
    expect(readSceneView({}).petKind).toBe("none");
    // 即使底層有 pet:dog flag，沒有 scene 投影也不該自己猜。
    expect(readSceneView({ flags: ["pet:dog"], state: { age: 40 } }).petKind).toBe("none");
    // 畸形欄位逐一套用安全白名單預設，不把奇怪值直接畫出來。
    expect(readSceneView({ scene: { ageStage: "bogus", playerSex: "x", petKind: "bird" } })).toEqual(
      DEFAULT_SCENE_VIEW
    );
    expect(DEFAULT_SCENE_VIEW.ageStage).toBe("child");
    expect(DEFAULT_SCENE_VIEW.petKind).toBe("none");
  });
});
