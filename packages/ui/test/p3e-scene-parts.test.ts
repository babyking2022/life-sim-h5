import { describe, expect, it } from "vitest";
import {
  buildSceneSvg,
  describeSceneParts,
  ageStageOfAge,
  lifeStageOfAge,
  openPeepsAssetOf,
  sceneSignature,
  sceneSvgDataUri,
  SCENE_DERIVED_PEEPS_ASSETS,
  SCENE_OPEN_PEEPS_ASSETS,
  type SceneAgeStage,
  type SceneSex,
  type SceneView
} from "../src/p3e-scene";
import { OPEN_PEEPS_BY_SEX, openPeepsMarkup } from "../src/p3e-open-peeps";
import {
  DERIVED_BY_STAGE,
  DERIVED_PEEPS_PROVENANCE,
  derivedPeepMarkup
} from "../src/p3e-open-peeps-derived";

/**
 * GPT-WORKBUDDY-0063-B｜人物驗收：真正檢查資產／部件 key 的年齡矩陣。
 *
 * 0062-B 的舊測試只證明「五個年齡共用同一張官方成人 Standing」，正是 CTO
 * 判定不合格的原因。本輪改為：
 *  - 2 性別 × 6 年齡階段 × 玩家／伴侶 = 24 組，逐組斷言實際 asset／body key；
 *  - baby／child 的 body 必須是 `openpeeps-derived/body/onesie-*|toddler-*`，
 *    **不得**出現官方成人 `openpeeps/pose/standing/*`；
 *  - student 三段（primary／teen／university）不得用 business-only key；
 *  - 每個 descriptor 的部件 key 都要真的出現在該角色 SVG 的 data-part 上；
 *  - 同一 seed 跨 0→80 歲性別／identity／膚色／髮型 series 不變；
 *  - 伴侶用 scene.partnerSex + partnerAge，未成年玩家旁邊不會出現成年伴侶。
 */

const SEXES: readonly SceneSex[] = ["male", "female"];
const AGE_STAGES: readonly SceneAgeStage[] = ["baby", "child", "student", "young", "middle", "senior"];
const STAGE_AGE: Readonly<Record<SceneAgeStage, number>> = Object.freeze({
  baby: 1, child: 4, student: 13, young: 28, middle: 48, senior: 68
});

/** 一律以精確 age 為準產生一致的 ageStage／lifeStage，模擬正式 view.scene。 */
function sceneOf(input: Partial<SceneView> = {}): SceneView {
  const age = input.age ?? STAGE_AGE[input.ageStage ?? "young"];
  return {
    playerSex: "male",
    residenceKind: "urban",
    hasPartner: true,
    partnerSex: "female",
    partnerAge: age,
    petKind: "none",
    phase: "alive",
    ...input,
    age,
    ageStage: ageStageOfAge(age),
    lifeStage: lifeStageOfAge(age)
  };
}

/** 取出某個角色圖層的 SVG 片段（0073 起人物與配件都 inline 在同一座標系的 <g data-part>）。 */
function roleGroup(svg: string, role: "player" | "partner"): string {
  const start = svg.indexOf(`<g data-layer="${role}"`);
  expect(start).toBeGreaterThan(-1);
  const end = svg.indexOf(`</g><g data-layer="`, start + 1);
  return end === -1 ? svg.slice(start) : svg.slice(start, end);
}

function partKeysIn(fragment: string): string[] {
  return [...fragment.matchAll(/data-part="([^"]+)"/g)].map((match) => match[1] as string);
}

function poolHas(sex: SceneSex, assetKey: string): boolean {
  return (OPEN_PEEPS_BY_SEX[sex] as readonly string[]).includes(assetKey.replace(/^openpeeps\//, ""));
}

const OFFICIAL_STANDING = "openpeeps/pose/standing/";
const BUSINESS_ONLY = /blazer|suit|business/i;

describe("GPT-0063-B 年齡專用全身人物：真實資產／部件 key 矩陣", () => {
  it("2 性別 × 6 年齡 × 玩家／伴侶 = 24 組，資產與部件 key 都正確落在 SVG 上", () => {
    let checked = 0;
    for (const sex of SEXES) {
      for (const ageStage of AGE_STAGES) {
        // 伴侶故意與玩家同性：能抓到「用 oppositeSex 偷偷推測」的錯誤。
        const scene = sceneOf({ playerSex: sex, partnerSex: sex, ageStage });
        const descriptors = describeSceneParts(scene, "seed-parts");
        expect(descriptors).toHaveLength(2);
        expect(descriptors.map((entry) => entry.role)).toEqual(["player", "partner"]);
        expect(descriptors.map((entry) => entry.sex)).toEqual([sex, sex]);

        const svg = buildSceneSvg(scene, "seed-parts");
        for (const entry of descriptors) {
          expect(entry.age).toBe(scene.age);
          expect(entry.ageStage).toBe(scene.ageStage);
          expect(entry.lifeStage).toBe(scene.lifeStage);
          if (entry.derived) {
            expect(entry.asset).toMatch(/^openpeeps-derived\//);
            expect(entry.body).toMatch(/^openpeeps-derived\/body\//);
            expect(entry.head).toMatch(/^openpeeps-derived\/head\//);
            expect(entry.face).toMatch(/^openpeeps-derived\/face\//);
            expect(entry.hair).toMatch(/^openpeeps-derived\/hair\//);
            expect(entry.parts.some((key) => key.startsWith(OFFICIAL_STANDING))).toBe(false);
          } else {
            expect(entry.asset).toMatch(/^openpeeps\//);
            expect(poolHas(sex, entry.asset)).toBe(true);
            expect(entry.head).toMatch(/^openpeeps\/head\//);
            expect(entry.body).toMatch(/^openpeeps\/pose\/standing\//);
            expect(entry.face).toMatch(/^openpeeps\/face\//);
          }
          expect(entry.parts).toContain(entry.asset);
          expect(entry.parts).toContain(entry.head);
          expect(entry.parts).toContain(entry.body);
          expect(entry.parts).toContain(entry.face);
          expect(entry.parts).toContain(entry.hair);
          // senior 只加眼鏡／手杖／圍巾／皺紋，不換性別角色池。
          expect(entry.glasses).toBe(scene.lifeStage === "senior" ? "original/item/reading-glasses" : null);

          // 部件 key 必須真的出現在該角色的 SVG 圖層內，不是只看 DOM 有圖。
          const fragment = roleGroup(svg, entry.role);
          const present = partKeysIn(fragment);
          for (const key of entry.parts) expect(present).toContain(key);
          expect(fragment).toContain(`data-asset="${entry.asset}"`);
          expect(fragment).toContain(`data-body="${entry.body}"`);
          expect(fragment).toContain(`data-sex="${sex}"`);
          expect(fragment).toContain(`data-age="${scene.age}"`);
          expect(fragment).toContain(`data-age-stage="${scene.ageStage}"`);
          expect(fragment).toContain(`data-life-stage="${scene.lifeStage}"`);
          expect(fragment).toContain(`<g data-part="${entry.asset}">`);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(24);
  });

  it("0063-B 核心：baby／child 不用成人 standing body，student 不用 business-only key", () => {
    const ageBody: readonly (readonly [number, string])[] = [
      [0, "onesie"], [1, "onesie"], [2, "onesie"],
      [3, "toddler"], [4, "toddler"], [5, "toddler"],
      [6, "school"], [11, "school"],
      [12, "teen"], [17, "teen"],
      [18, "campus"], [22, "campus"]
    ];
    for (const [age, expected] of ageBody) {
      for (const sex of SEXES) {
        const scene = sceneOf({ age, playerSex: sex, hasPartner: false });
        const [player] = describeSceneParts(scene, "seed-age-keys");
        expect(player).toBeDefined();
        expect(player!.derived).toBe(true);
        expect(player!.asset.startsWith("openpeeps-derived/")).toBe(true);
        expect(player!.body).toContain(expected);
        expect(player!.body.startsWith("openpeeps-derived/body/")).toBe(true);
        expect(player!.body).not.toMatch(/standing|adult/i);
        expect(player!.body).not.toMatch(BUSINESS_ONLY);
        expect(player!.parts.some((key) => key.startsWith(OFFICIAL_STANDING))).toBe(false);
        expect(player!.parts.some((key) => BUSINESS_ONLY.test(key))).toBe(false);
        const fragment = roleGroup(buildSceneSvg(scene, "seed-age-keys"), "player");
        expect(fragment).not.toContain(`data-part="${OFFICIAL_STANDING}`);
        expect(fragment).toContain(`data-part="${player!.body}"`);
      }
    }
    // 嬰兒是坐姿（不是站立的縮小成人）。
    const baby = describeSceneParts(sceneOf({ age: 0, hasPartner: false }), "s")[0]!;
    expect(baby.parts).toContain("openpeeps-derived/pose/sitting");
    // 三個學生階段的 body key 必須互不相同。
    const studentBodies = [6, 13, 18].map(
      (age) => describeSceneParts(sceneOf({ age, hasPartner: false }), "s")[0]!.body
    );
    expect(new Set(studentBodies).size).toBe(3);
    // 23 歲以上才回到官方成人 Standing 成品。
    for (const age of [23, 39, 40, 59, 60, 80]) {
      const [adult] = describeSceneParts(sceneOf({ age, hasPartner: false }), "s");
      expect(adult!.derived).toBe(false);
      expect(adult!.body.startsWith(OFFICIAL_STANDING)).toBe(true);
    }
  });

  it("同一 seed 跨 0→80 歲：性別／identity／膚色／髮型 series 不變，只換合理比例服裝", () => {
    const ages = [0, 3, 6, 13, 18, 25, 45, 65];
    for (const sex of SEXES) {
      const rows = ages.map(
        (age) => describeSceneParts(sceneOf({ age, playerSex: sex, hasPartner: false }), "seed-identity")[0]!
      );
      expect(new Set(rows.map((row) => row.sex)).size).toBe(1);
      expect(rows.every((row) => row.sex === sex)).toBe(true);
      expect(new Set(rows.map((row) => row.identity)).size).toBe(1);
      // 0–22 歲五個衍生階段共用同一個 identity 髮型 key。
      expect(new Set(rows.slice(0, 5).map((row) => row.hair)).size).toBe(1);
      // 每個年齡用不同資產，不是同一張成人圖縮放。
      expect(new Set(rows.map((row) => row.asset)).size).toBeGreaterThanOrEqual(6);
      // 逐年齡外觀真的不同，但同 seed 重算逐位元相同（reload 一致）。
      const signatures = ages.map((age) =>
        sceneSignature(sceneOf({ age, playerSex: sex, hasPartner: false }), "seed-identity")
      );
      expect(new Set(signatures).size).toBe(ages.length);
      for (const age of ages) {
        const scene = sceneOf({ age, playerSex: sex, hasPartner: false });
        expect(buildSceneSvg(scene, "seed-identity")).toBe(buildSceneSvg(scene, "seed-identity"));
      }
    }
    expect(openPeepsAssetOf("male", "seed-age", "player")).not.toBe(
      openPeepsAssetOf("female", "seed-age", "player")
    );
    // 兩個性別各有 4 種不同衣著／姿勢，衍生 4 個 series 也對男女都開放。
    expect(OPEN_PEEPS_BY_SEX.male).toHaveLength(4);
    expect(OPEN_PEEPS_BY_SEX.female).toHaveLength(4);
    for (const stage of ["baby", "child", "primary", "teen", "university"] as const) {
      expect(DERIVED_BY_STAGE[stage]).toHaveLength(4);
      for (const sex of SEXES) {
        const key = describeSceneParts(
          sceneOf({ age: stage === "baby" ? 1 : stage === "child" ? 4 : stage === "primary" ? 8 : stage === "teen" ? 15 : 20, playerSex: sex, hasPartner: false }),
          `seed-${sex}-${stage}`
        )[0]!.asset;
        expect(key.startsWith("openpeeps-derived/")).toBe(true);
      }
    }
    const maleHeads = new Set(OPEN_PEEPS_BY_SEX.male.map((key) => SCENE_OPEN_PEEPS_ASSETS.find((a) => a.key === key)?.head));
    const femaleHeads = new Set(OPEN_PEEPS_BY_SEX.female.map((key) => SCENE_OPEN_PEEPS_ASSETS.find((a) => a.key === key)?.head));
    expect(maleHeads.size).toBeGreaterThanOrEqual(3);
    expect(femaleHeads.size).toBeGreaterThanOrEqual(3);
    expect([...maleHeads].some((head) => femaleHeads.has(head))).toBe(false);
  });

  it("伴侶直接使用 scene.partnerSex 與 partnerAge；未成年玩家旁邊不會出現成年伴侶", () => {
    const cases: readonly (readonly [SceneSex, SceneSex])[] = [
      ["male", "female"], ["female", "male"], ["male", "male"], ["female", "female"]
    ];
    for (const [playerSex, partnerSex] of cases) {
      const scene = sceneOf({ playerSex, partnerSex, ageStage: "senior" });
      const descriptors = describeSceneParts(scene, "seed-partner");
      expect(descriptors[0]?.sex).toBe(playerSex);
      expect(descriptors[1]?.sex).toBe(partnerSex);
      expect(poolHas(playerSex, descriptors[0]!.asset)).toBe(true);
      expect(poolHas(partnerSex, descriptors[1]!.asset)).toBe(true);
      const svg = buildSceneSvg(scene, "seed-partner");
      const partner = roleGroup(svg, "partner");
      expect(partner).toContain(`data-sex="${partnerSex}"`);
      expect(partner).toContain(`data-asset="${descriptors[1]!.asset}"`);
      expect(partner).toContain('data-part="original/item/reading-glasses"');
    }
    // 6 歲玩家 + 7 歲伴侶：兩人都是小學生衍生人物，不會有成人 standing body。
    const minor = sceneOf({ age: 6, playerSex: "female", partnerSex: "male", partnerAge: 7 });
    const [player, partner] = describeSceneParts(minor, "seed-minor-partner");
    expect(player!.lifeStage).toBe("primary");
    expect(partner!.age).toBe(7);
    expect(partner!.lifeStage).toBe("primary");
    expect(partner!.derived).toBe(true);
    expect(partner!.body).toContain("school");
    const minorSvg = buildSceneSvg(minor, "seed-minor-partner");
    expect(roleGroup(minorSvg, "partner")).not.toContain(`data-part="${OFFICIAL_STANDING}`);
    // 伴侶性別在 young → middle → senior 都不變。
    for (const age of [25, 45, 65]) {
      const grown = sceneOf({ age, partnerSex: "male", hasPartner: true });
      expect(describeSceneParts(grown, "seed-partner")[1]!.sex).toBe("male");
    }
  });

  it("伴侶／寵物狀態變更不會換掉玩家；只有新伴侶身分可換伴侶外觀", () => {
    const base = sceneOf({ playerSex: "female", partnerSex: "male", ageStage: "middle" });
    const alone = sceneOf({ playerSex: "female", partnerSex: null, hasPartner: false, ageStage: "middle", petKind: "dog" });
    expect(describeSceneParts(alone, "seed-stable")[0]).toEqual(describeSceneParts(base, "seed-stable")[0]);

    const playerAssets = new Set<string>();
    const partnerAssets = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const seed = `seed-stable|partner-identity=partner-${i}`;
      const parts = describeSceneParts(base, seed);
      playerAssets.add(parts[0]!.asset);
      partnerAssets.add(parts[1]!.asset);
    }
    expect(playerAssets.size).toBe(1);
    expect(partnerAssets.size).toBeGreaterThan(1);
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
    expect(catSvg).toContain('data-part="original/pet/cat"');
    expect(dogSvg).not.toContain('data-part="original/pet/cat"');
    expect(catSvg).not.toContain('data-part="original/pet/dog"');
    // 0062-B 起完全沒有 Humation runtime 部件。
    expect(dogSvg).not.toContain("humation");
    expect(catSvg).not.toContain("humation");
  });

  it("同 seed＋同狀態外觀完全一致；不同 seed 只改穩定變體，不改性別池", () => {
    const scene = sceneOf({ playerSex: "female", partnerSex: "male", ageStage: "middle", petKind: "cat" });
    expect(sceneSignature(scene, "seed-A")).toBe(sceneSignature(scene, "seed-A"));
    expect(buildSceneSvg(scene, "seed-A")).toBe(buildSceneSvg(scene, "seed-A"));
    expect(sceneSvgDataUri(scene, "seed-A")).toBe(sceneSvgDataUri(scene, "seed-A"));
    const signatures = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const seed = `seed-${i}`;
      signatures.add(sceneSignature(scene, seed));
      for (const entry of describeSceneParts(scene, seed)) {
        if (!entry.derived) expect(poolHas(entry.sex, entry.asset)).toBe(true);
      }
    }
    expect(signatures.size).toBeGreaterThan(1);
  });

  it("20 個衍生資產都標示 project-original，沒有官方原件混充或外部網域", () => {
    expect(SCENE_DERIVED_PEEPS_ASSETS).toHaveLength(20);
    expect(SCENE_OPEN_PEEPS_ASSETS).toHaveLength(8);
    expect(DERIVED_PEEPS_PROVENANCE.officialAssetCount).toBe(0);
    expect(DERIVED_PEEPS_PROVENANCE.derivedAssetCount).toBe(20);
    expect(DERIVED_PEEPS_PROVENANCE.origin).toBe("project-original-derivative");
    const colors = { ink: "#111111", clothes: "#6d9bb5", hair: "#333333", skin: "#f6d3b0" };
    for (const asset of SCENE_DERIVED_PEEPS_ASSETS) {
      expect(asset.derived).toBe("project-original");
      expect(asset.body).toMatch(/^openpeeps-derived\/body\//);
      expect(asset.hair).toMatch(/^openpeeps-derived\/hair\//);
      expect(asset.pose).not.toMatch(/standing/);
      expect(asset.viewBox).toMatch(/^0 0 \d+ \d+$/);
      expect(asset.source).toMatch(/^derived\/.*\.svg$/);
      const markup = derivedPeepMarkup(asset.key, colors);
      expect(markup).not.toContain("{{");
      expect(markup).toContain(`data-part="${asset.body}"`);
      expect(markup).toContain(`data-part="${asset.pose}"`);
      expect(markup).toContain(`data-part="${asset.hair}"`);
      expect(markup).not.toContain("http://");
      expect(markup).not.toContain("https://");
    }
    // 官方 8 個成品仍是唯一擁有 `openpeeps/pose/standing/` 的資產。
    for (const asset of SCENE_OPEN_PEEPS_ASSETS) {
      expect(asset.sourceId).toMatch(/^official\/peep-standing-\d+$/);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.rawBytes).toBeGreaterThan(1000);
      expect(asset.pose).toMatch(/^pose\/standing\//);
      expect(asset.head).toMatch(/^head\//);
      const markup = openPeepsMarkup(asset.key, colors);
      expect(markup).not.toContain("{{");
      expect(markup).toContain('data-part="openpeeps/');
      expect(markup).not.toContain("http://");
      expect(markup).not.toContain("https://");
    }
    const uri = sceneSvgDataUri(sceneOf(), "seed-uri");
    expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
    expect(uri).not.toContain("openpeeps.com");
    expect(uri).not.toContain("github");
    expect(uri).not.toContain("cdn.prod.website-files.com");
  });
});
