import { describe, expect, it } from "vitest";
import { evaluateAnnualDeath } from "../src/death/evaluate";
import { validateDeathPack, type ValidatedDeathPack } from "../src/death/pack";
import { DeathDataError } from "../src/death/errors";
import { BASE, codeOf, deathRaw, deathRecords, entityIds, loadDeathPack, recAt, repairDeath, validated, type DeathMutable } from "./p3d-helpers";

/**
 * P3-D.1（H5-CTO-041）信任邊界修正的獨立反例。
 *
 * 三個缺口：
 * 1. `entityId` 與 `regionCode` 沒有綁定 → 任意 entity 可以借用別人的 regionCode／regionClass；
 * 2. `manifest.licenses` 與 `datasets.licenses.records` 沒有比對 → 只在 manifest 宣稱
 *    WHO／official 也能通過（manifest 陣列不在 `packChecksum` projection 內）；
 * 3. `manifest.lineage` 與 `datasets.lineage.records` 沒有比對 → 只在 manifest 把
 *    `outputChecksum` 換成 64 個 0 也能通過。
 */

const pack = validated();

const entityOf = (regionCode: string): string => {
  const record = BASE.registry.find((entry) => entry.regionCode === regionCode);
  if (record === undefined) throw new Error(`test fixture: no entity for ${regionCode}`);
  return record.entityId;
};

const regionOf = (entityId: string): string => {
  const record = BASE.registry.find((entry) => entry.entityId === entityId);
  if (record === undefined) throw new Error(`test fixture: no region for ${entityId}`);
  return record.regionCode;
};

function inputFor(entityId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entityId,
    regionCode: regionOf(entityId),
    sex: "female",
    age: 30,
    calendarYear: 2026,
    health: 50,
    rngState: [1, 2, 3, 4],
    ...overrides
  };
}

describe("P3-D.1 必修 1：entityId 與 regionCode 綁定", () => {
  it("entityIndex 由 validated base pack 建立，且是 deep-frozen", () => {
    expect(Object.isFrozen(pack.entityIndex)).toBe(true);
    expect(Object.keys(pack.entityIndex).length).toBe(BASE.entityIds.length);
    for (const entityId of BASE.entityIds) {
      const binding = pack.entityIndex[entityId];
      expect(binding).toEqual({ entityId, regionCode: regionOf(entityId), regionClass: BASE.registry.find((entry) => entry.entityId === entityId)?.region });
      expect(Object.isFrozen(binding)).toBe(true);
    }
  });

  it("cr:AFG + ALB（跨 region 混搭）→ E_P3D_ENTITY", () => {
    const afghanistan = entityOf("AFG");
    const albania = entityOf("ALB");
    expect(regionOf(afghanistan)).toBe("AFG");
    expect(regionOf(albania)).toBe("ALB");
    expect(codeOf(() => evaluateAnnualDeath(inputFor(afghanistan, { regionCode: "ALB" }), pack))).toBe("E_P3D_ENTITY");
  });

  it("同一個 region class、不同 entity 的 regionCode 混搭也拒絕", () => {
    // 找出兩個同在 africa 的 entity（同 regionClass、不同 regionCode）。
    const africaEntities = BASE.registry.filter((entry) => entry.region === "africa").map((entry) => entry.regionCode);
    expect(africaEntities.length).toBeGreaterThan(1);
    const [first, second] = africaEntities as [string, string];
    expect(pack.entityIndex[entityOf(first)]?.regionClass).toBe(pack.entityIndex[entityOf(second)]?.regionClass);
    expect(codeOf(() => evaluateAnnualDeath(inputFor(entityOf(first), { regionCode: second }), pack))).toBe("E_P3D_ENTITY");
    expect(codeOf(() => evaluateAnnualDeath(inputFor(entityOf(second), { regionCode: first }), pack))).toBe("E_P3D_ENTITY");
  });

  it("regionClass 只能來自 entity 綁定：同 region 的合法輸入得到該 region 的死因分布", () => {
    const africaCodes = BASE.registry.filter((entry) => entry.region === "africa").map((entry) => entry.regionCode);
    const results = new Set<string>();
    for (const regionCode of africaCodes.slice(0, 3)) {
      const result = evaluateAnnualDeath(inputFor(entityOf(regionCode)), pack);
      expect(result.regionClass).toBe("africa");
      results.add(result.regionClass);
    }
    expect([...results]).toEqual(["africa"]);
  });

  it("未知 entity → E_P3D_ENTITY；未知 regionCode 也 → E_P3D_ENTITY", () => {
    expect(codeOf(() => evaluateAnnualDeath(inputFor(entityIds()[0] as string, { entityId: "cr:ZZZ" }), pack))).toBe("E_P3D_ENTITY");
    expect(codeOf(() => evaluateAnnualDeath(inputFor(entityIds()[0] as string, { regionCode: "ZZZ" }), pack))).toBe("E_P3D_ENTITY");
  });

  it("錯配在消耗 RNG 之前就被拒絕（同一份 rngState 之後仍得到原本的合法結果）", () => {
    const entityId = entityOf("AFG");
    const state = [11, 22, 33, 44];
    const legal = evaluateAnnualDeath(inputFor(entityId, { rngState: state }), pack);
    for (const wrong of ["ALB", "DZA", "ZZZ"]) {
      expect(codeOf(() => evaluateAnnualDeath(inputFor(entityId, { regionCode: wrong, rngState: state }), pack))).toBe("E_P3D_ENTITY");
    }
    // 錯配沒有推進任何可觀察狀態：同一份輸入再跑一次結果完全相同。
    expect(evaluateAnnualDeath(inputFor(entityId, { rngState: state }), pack)).toEqual(legal);
    // 輸入陣列也沒有被就地修改。
    expect(state).toEqual([11, 22, 33, 44]);
  });
});

describe("P3-D.1 必修 2：manifest.licenses 必須等於 datasets.licenses", () => {
  function forgedManifest(mutate: (license: DeathMutable) => void): string {
    const draft = loadDeathPack();
    mutate(recAt<DeathMutable>(draft.manifest.licenses, 0));
    // manifest.licenses 不在 packChecksum projection 內，因此不需要 repair。
    return codeOf(() => validateDeathPack(deathRaw(draft), BASE));
  }

  it("只改 manifest 的 sourceKind／sourceName／sourceUrl／checksum／datasetId／lineageId 全部拒絕", () => {
    expect(forgedManifest((license) => { license.sourceKind = "official"; })).toBe("E_P3D_LICENSE");
    expect(forgedManifest((license) => { license.sourceName = "WHO mortality database"; })).toBe("E_P3D_LICENSE");
    expect(forgedManifest((license) => { license.sourceUrl = "https://who.int/x.csv"; })).toBe("E_P3D_LICENSE");
    expect(forgedManifest((license) => { license.checksum = "0".repeat(64); })).toBe("E_P3D_LICENSE");
    expect(forgedManifest((license) => { license.datasetId = "mortality"; })).toBe("E_P3D_LICENSE");
    expect(forgedManifest((license) => { license.lineageId = "lin.p3d.forged"; })).toBe("E_P3D_LICENSE");
  });

  it("manifest 宣稱 WHO／official、datasets 保持 synthetic → E_P3D_LICENSE", () => {
    const draft = loadDeathPack();
    const license = recAt<DeathMutable>(draft.manifest.licenses, 0);
    license.sourceKind = "official";
    license.sourceName = "WHO mortality database";
    license.license = "permission_required";
    // datasets 那一份完全沒動（仍是 synthetic／granted）。
    expect(recAt<DeathMutable>(deathRecords(draft, "licenses"), 0).sourceKind).toBe("synthetic");
    expect(codeOf(() => validateDeathPack(deathRaw(draft), BASE))).toBe("E_P3D_LICENSE");
  });

  it("兩份都宣稱 WHO → 仍然拒絕（E_P3D_CONTENT，經 repair 同步）", () => {
    const draft = loadDeathPack();
    const license = recAt<DeathMutable>(deathRecords(draft, "licenses"), 0);
    license.sourceKind = "official";
    license.sourceName = "WHO mortality database";
    repairDeath(draft);
    expect(recAt<DeathMutable>(draft.manifest.licenses, 0).sourceKind).toBe("official");
    expect(codeOf(() => validateDeathPack(deathRaw(draft), BASE))).toBe("E_P3D_CONTENT");
  });

  it("manifest.licenses 只重新排列（內容相同）必須通過", () => {
    const draft = loadDeathPack();
    draft.manifest.licenses.reverse();
    expect(codeOf(() => validateDeathPack(deathRaw(draft), BASE))).toBe("NO_ERROR");
  });

  it("manifest.licenses 少一筆或多一筆 → E_P3D_LICENSE", () => {
    const dropped = loadDeathPack();
    dropped.manifest.licenses.pop();
    expect(codeOf(() => validateDeathPack(deathRaw(dropped), BASE))).toBe("E_P3D_LICENSE");

    const duplicated = loadDeathPack();
    duplicated.manifest.licenses.push(structuredClone(recAt<DeathMutable>(duplicated.manifest.licenses, 0)));
    expect(codeOf(() => validateDeathPack(deathRaw(duplicated), BASE))).toBe("E_P3D_LICENSE");
  });
});

describe("P3-D.1 必修 3：manifest.lineage 必須等於 datasets.lineage", () => {
  function forgedLineage(mutate: (record: DeathMutable) => void): string {
    const draft = loadDeathPack();
    mutate(recAt<DeathMutable>(draft.manifest.lineage, 0));
    return codeOf(() => validateDeathPack(deathRaw(draft), BASE));
  }

  it("只改 manifest 的 outputChecksum／parents／inputChecksums／datasetId／lineageId 全部拒絕", () => {
    expect(forgedLineage((record) => { record.outputChecksum = "0".repeat(64); })).toBe("E_P3D_LINEAGE");
    expect(forgedLineage((record) => { record.parentLineageIds = ["lin.p3d.cause-weights"]; })).toBe("E_P3D_LINEAGE");
    expect(forgedLineage((record) => { record.inputChecksums = ["1".repeat(64)]; })).toBe("E_P3D_LINEAGE");
    expect(forgedLineage((record) => { record.datasetId = "mortality"; })).toBe("E_P3D_LINEAGE");
    expect(forgedLineage((record) => { record.lineageId = "lin.p3d.forged"; })).toBe("E_P3D_LINEAGE");
  });

  it("manifest lineage outputChecksum 改成 64 個 0、datasets 保持原值 → E_P3D_LINEAGE", () => {
    const draft = loadDeathPack();
    recAt<DeathMutable>(draft.manifest.lineage, 0).outputChecksum = "0".repeat(64);
    expect(recAt<DeathMutable>(deathRecords(draft, "lineage"), 0).outputChecksum).not.toBe("0".repeat(64));
    expect(codeOf(() => validateDeathPack(deathRaw(draft), BASE))).toBe("E_P3D_LINEAGE");
  });

  it("manifest.lineage 只重新排列（內容相同）必須通過", () => {
    const draft = loadDeathPack();
    draft.manifest.lineage.reverse();
    expect(codeOf(() => validateDeathPack(deathRaw(draft), BASE))).toBe("NO_ERROR");
  });

  it("manifest.lineage 少一筆 → E_P3D_LINEAGE", () => {
    const draft = loadDeathPack();
    draft.manifest.lineage.pop();
    expect(codeOf(() => validateDeathPack(deathRaw(draft), BASE))).toBe("E_P3D_LINEAGE");
  });
});

describe("P3-D.1 必修 4：production barrel 不得外洩內部符號", () => {
  it("@life-sim/birth 只公開白名單，內部 helper 與 browser harness 都拿不到", async () => {
    const birth = (await import("../src/index")) as unknown as Record<string, unknown>;
    for (const name of ["validateDeathPack", "isValidatedDeathPack", "evaluateAnnualDeath", "DeathDataError", "isDeathDataError"]) {
      expect(typeof birth[name], name).toBe("function");
    }
    for (const name of [
      "failDeath",
      "guardDeath",
      "readDeathExactObject",
      "deepFreezeDeath",
      "isPlainDeathObject",
      "hazardPpmOf",
      "entityBindingOf",
      "assertEntityRegionBinding",
      "causeSelectionOf",
      "mortalityKey",
      "causeKey",
      "computeDeathDatasetChecksum",
      "computeDeathPackChecksum",
      "deathPackChecksumProjection",
      "canonicalRowText",
      "DATASET_DIGEST_DOMAIN",
      "runDeathCases",
      "projectDeathResult",
      "adjustHazardPpm",
      "healthFactorPpm",
      "P3D_DIGEST_DOMAIN"
    ]) {
      expect(birth[name], name).toBeUndefined();
    }
  });

  it("內部模組仍然可以直接 import（測試與產生腳本用）", async () => {
    const internal = await import("../src/death/pack");
    expect(typeof internal.hazardPpmOf).toBe("function");
    expect(typeof internal.computeDeathPackChecksum).toBe("function");
    const browser = await import("../src/death/browser");
    expect(typeof browser.runDeathCases).toBe("function");
    const evaluate = await import("../src/death/evaluate");
    expect(typeof evaluate.healthFactorPpm).toBe("function");
  });

  it("未驗證的 pack 不能進入 evaluateAnnualDeath", () => {
    const raw = deathRaw(loadDeathPack());
    expect(codeOf(() => evaluateAnnualDeath(inputFor(entityIds()[0] as string), raw as never))).toBe("E_P3D_PACK");
    // 只有 validateDeathPack 的產物有品牌。
    const fresh: ValidatedDeathPack = validateDeathPack(raw, BASE);
    expect(codeOf(() => evaluateAnnualDeath(inputFor(entityIds()[0] as string), fresh))).toBe("NO_ERROR");
  });

  it("所有驗證失敗仍只拋 DeathDataError", () => {
    for (const mutate of [
      (draft: ReturnType<typeof loadDeathPack>) => {
        recAt<DeathMutable>(draft.manifest.licenses, 0).sourceKind = "official";
      },
      (draft: ReturnType<typeof loadDeathPack>) => {
        recAt<DeathMutable>(draft.manifest.lineage, 0).outputChecksum = "0".repeat(64);
      }
    ]) {
      const draft = loadDeathPack();
      mutate(draft);
      let caught: unknown = null;
      try {
        validateDeathPack(deathRaw(draft), BASE);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DeathDataError);
      expect((caught as DeathDataError).code).toMatch(/^E_P3D_/);
    }
  });
});
