import { describe, expect, it } from "vitest";
import {
  buildSceneSvg,
  describeSceneParts,
  headPartOf,
  sceneSignature,
  type SceneAgeStage,
  type SceneSex,
  type SceneView
} from "../src/p3e-scene";

/**
 * GPT-WORKBUDDY-0058-B｜任務一第 5 項：真正檢查 SVG **部件 key** 的矩陣測試。
 *
 * 2 性別 × 5 年齡階段 × 玩家／伴侶 = 20 組；每組都斷言：
 * - 頭型部件 key 只由性別決定，五個年齡階段（含 senior）完全相同；
 * - 伴侶直接用 scene.partnerSex，不用玩家性別或姓名重新推測；
 * - descriptor 的每個部件 key 真的出現在該角色的 SVG `<g>` 裡（不是只看有圖）。
 */

const SEXES: readonly SceneSex[] = ["male", "female"];
const AGE_STAGES: readonly SceneAgeStage[] = ["child", "student", "young", "middle", "senior"];

function sceneOf(input: Partial<SceneView> = {}): SceneView {
  return {
    playerSex: "male",
    ageStage: "young",
    residenceKind: "urban",
    hasPartner: true,
    partnerSex: "female",
    petKind: "none",
    phase: "alive",
    ...input
  };
}

/** 取出某個角色圖層的 SVG 片段（含所有巢狀 <g data-part>）。 */
function roleGroup(svg: string, role: "player" | "partner"): string {
  const start = svg.indexOf(`<g data-layer="${role}"`);
  expect(start).toBeGreaterThan(-1);
  const end = svg.indexOf(`</g><g data-layer="`, start + 1);
  return end === -1 ? svg.slice(start) : svg.slice(start, end);
}

function partKeysIn(fragment: string): string[] {
  return [...fragment.matchAll(/data-part="([^"]+)"/g)].map((match) => match[1] as string);
}

describe("GPT-0058-B 可愛人物：真實 SVG 部件 key 矩陣", () => {
  it("2 性別 × 5 年齡 × 玩家／伴侶 = 20 組，頭型部件只由性別決定", () => {
    let checked = 0;
    for (const sex of SEXES) {
      for (const ageStage of AGE_STAGES) {
        // 伴侶故意與玩家同性：這樣能抓到「用 oppositeSex 偷偷推測」的錯誤。
        const scene = sceneOf({ playerSex: sex, partnerSex: sex, ageStage });
        const descriptors = describeSceneParts(scene, "seed-parts");
        expect(descriptors).toHaveLength(2);
        expect(descriptors.map((entry) => entry.role)).toEqual(["player", "partner"]);
        expect(descriptors.map((entry) => entry.sex)).toEqual([sex, sex]);

        const expectedHead = `humation/${headPartOf(sex)}`;
        const expectedBody = `original/body/${sex === "female" ? "dress" : "trousers"}`;
        const svg = buildSceneSvg(scene, "seed-parts");
        for (const entry of descriptors) {
          // 伴侶不會在兒／學生期出現，投影沿用既有規則映射到 young；
          // 這不影響性別部件，頭型仍然只由 partnerSex 決定。
          const expectedStage: SceneAgeStage =
            entry.role === "partner" && (ageStage === "child" || ageStage === "student")
              ? "young"
              : ageStage;
          expect(entry.head).toBe(expectedHead);
          expect(entry.body).toBe(expectedBody);
          expect(entry.ageStage).toBe(expectedStage);
          // senior 只加眼鏡／皺紋，不換頭型、不換身形集合。
          expect(entry.glasses).toBe(expectedStage === "senior" ? "humation/glasses/round" : null);
          expect(entry.parts).toContain(expectedHead);
          expect(entry.parts).toContain(expectedBody);

          // 部件 key 必須真的出現在該角色的 SVG 圖層內。
          const fragment = roleGroup(svg, entry.role);
          const present = partKeysIn(fragment);
          for (const key of entry.parts) expect(present).toContain(key);
          expect(fragment).toContain(`data-sex="${sex}"`);
          expect(fragment).toContain(`data-age-stage="${expectedStage}"`);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(20);
  });

  it("同一性別跨 child→senior 五階段，head 與 body 部件 key 永不改變", () => {
    for (const sex of SEXES) {
      const heads = new Set<string>();
      const bodies = new Set<string>();
      for (const ageStage of AGE_STAGES) {
        const [player] = describeSceneParts(
          sceneOf({ playerSex: sex, partnerSex: sex, hasPartner: false, ageStage }),
          "seed-age"
        );
        expect(player).toBeDefined();
        heads.add(player!.head);
        bodies.add(player!.body);
      }
      expect(heads.size).toBe(1);
      expect(bodies.size).toBe(1);
      expect([...heads][0]).toBe(`humation/${headPartOf(sex)}`);
    }
    // 兩個性別用的是不同的 Humation 頭型部件。
    expect(headPartOf("male")).not.toBe(headPartOf("female"));
  });

  it("伴侶直接使用 scene.partnerSex，不由玩家性別或姓名推測", () => {
    const cases: readonly (readonly [SceneSex, SceneSex])[] = [
      ["male", "female"],
      ["female", "male"],
      ["male", "male"],
      ["female", "female"]
    ];
    for (const [playerSex, partnerSex] of cases) {
      const scene = sceneOf({ playerSex, partnerSex, ageStage: "senior" });
      const descriptors = describeSceneParts(scene, "seed-partner");
      expect(descriptors[0]?.head).toBe(`humation/${headPartOf(playerSex)}`);
      expect(descriptors[1]?.head).toBe(`humation/${headPartOf(partnerSex)}`);
      expect(descriptors[1]?.sex).toBe(partnerSex);
      const svg = buildSceneSvg(scene, "seed-partner");
      expect(roleGroup(svg, "partner")).toContain(`data-sex="${partnerSex}"`);
      expect(roleGroup(svg, "partner")).toContain(`data-part="humation/${headPartOf(partnerSex)}"`);
      // senior 也不會讓伴侶換性別部件。
      expect(roleGroup(svg, "partner")).toContain("data-part=\"humation/glasses/round\"");
    }
  });

  it("沒有伴侶時不出現伴侶部件；dog／cat 部件依狀態出現", () => {
    const single = sceneOf({ hasPartner: false, petKind: "none" });
    expect(describeSceneParts(single, "s")).toHaveLength(1);
    const singleSvg = buildSceneSvg(single, "s");
    expect(singleSvg).not.toContain('data-layer="partner"');
    expect(singleSvg).not.toContain('data-layer="pet"');

    const dogSvg = buildSceneSvg(sceneOf({ hasPartner: false, petKind: "dog" }), "s");
    const catSvg = buildSceneSvg(sceneOf({ hasPartner: false, petKind: "cat" }), "s");
    expect(dogSvg).toContain('data-part="original/pet/dog"');
    expect(catSvg).toContain('data-part="humation/cat/tabby"');
    expect(dogSvg).not.toContain('data-part="humation/cat/tabby"');
    expect(catSvg).not.toContain('data-part="original/pet/dog"');
  });

  it("同 seed＋同狀態外觀一致；不同 seed 只改顏色，不改任何部件 key", () => {
    const scene = sceneOf({ playerSex: "female", partnerSex: "male", ageStage: "middle", petKind: "cat" });
    expect(sceneSignature(scene, "seed-A")).toBe(sceneSignature(scene, "seed-A"));
    const keys = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const seed = `seed-${i}`;
      const parts = describeSceneParts(scene, seed).flatMap((entry) => entry.parts);
      keys.add(parts.join("|"));
      expect(buildSceneSvg(scene, seed)).toBe(buildSceneSvg(scene, seed));
    }
    expect(keys.size).toBe(1);
    const signatures = new Set(Array.from({ length: 12 }, (_, i) => sceneSignature(scene, `seed-${i}`)));
    expect(signatures.size).toBeGreaterThan(1);
  });
});
