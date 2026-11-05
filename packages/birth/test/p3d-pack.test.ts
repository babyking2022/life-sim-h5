import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { P3D_CAUSE_REGISTRY, P3D_REQUIRED_MORTALITY_RECORDS } from "@life-sim/contracts";
import {
  isValidatedDeathPack,
  causeSelectionOf,
  entityBindingOf,
  assertEntityRegionBinding,
  hazardPpmOf,
  validateDeathPack
} from "../src/death/pack";
import { DeathDataError } from "../src/death/errors";
import {
  BASE,
  codeOf,
  deathRaw,
  deathRecords,
  entityIds,
  loadDeathPack,
  recAt,
  regionCodeOf,
  repairDeath,
  validated,
  type DeathMutable,
  type DeathMutablePack
} from "./p3d-helpers";

const pack = validated();
const clone = <T>(value: T): T => structuredClone(value) as T;

interface BreakOptions {
  readonly repair?: boolean;
  readonly licenses?: boolean;
  readonly lineage?: boolean;
}

/** 每次都從乾淨的 fixture 開始，改壞後（可選）repair，再驗證。 */
function broken(mutate: (pack: DeathMutablePack) => void, options: BreakOptions = {}): DeathMutablePack {
  const draft = loadDeathPack();
  mutate(draft);
  if (options.repair !== false) {
    const repairOptions: { licenses?: boolean; lineage?: boolean } = {};
    if (options.licenses === false) repairOptions.licenses = false;
    if (options.lineage === false) repairOptions.lineage = false;
    repairDeath(draft, repairOptions);
  }
  return draft;
}

function codeFor(mutate: (pack: DeathMutablePack) => void, options: BreakOptions = {}): string {
  return codeOf(() => validateDeathPack(deathRaw(broken(mutate, options)), BASE));
}

const mortality = (draft: DeathMutablePack) => deathRecords(draft, "mortality");
const causeWeights = (draft: DeathMutablePack) => deathRecords(draft, "cause-weights");
const causeRegistry = (draft: DeathMutablePack) => deathRecords(draft, "cause-registry");
const licenses = (draft: DeathMutablePack) => deathRecords(draft, "licenses");
const lineage = (draft: DeathMutablePack) => deathRecords(draft, "lineage");

describe("P3-D 死亡資料包：基本形狀與完整性", () => {
  it("合法 fixture 通過驗證並回傳 branded pack", () => {
    expect(isValidatedDeathPack(pack)).toBe(true);
    expect(isValidatedDeathPack({})).toBe(false);
    expect(pack.manifest.schemaVersion).toBe("p3d-1");
    expect(pack.manifest.deathSpecVersion).toBe("1.0.0");
    expect(pack.manifest.packKind).toBe("synthetic");
    expect(pack.manifest.basePackId).toBe(BASE.manifest.packId);
    expect(pack.manifest.basePackChecksum).toBe(BASE.packChecksum);
    expect(pack.manifest.entityCount).toBe(BASE.entityIds.length);
    expect(pack.packChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.mortality.length).toBe(P3D_REQUIRED_MORTALITY_RECORDS);
    expect(pack.causeRegistry.length).toBe(P3D_CAUSE_REGISTRY.length);
    expect(pack.licenses.length).toBe(3);
    expect(pack.lineage.length).toBe(3);
    for (const datasetId of ["cause-registry", "cause-weights", "mortality", "licenses", "lineage"] as const) {
      expect(pack.datasetChecksums[datasetId]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("172 entity × 2 sex × 121 age 完整覆蓋，且每個 entity×sex×age 恰好一筆", () => {
    const actualKeys = new Set<string>();
    for (const record of pack.mortality) actualKeys.add(`${record.entityId}|${record.sex}|${record.age}`);
    const expectedKeys = new Set<string>();
    for (const entityId of entityIds()) {
      for (const sex of ["female", "male"] as const) {
        for (let age = 0; age <= 120; age += 1) expectedKeys.add(`${entityId}|${sex}|${age}`);
      }
    }
    expect(pack.mortality.length).toBe(P3D_REQUIRED_MORTALITY_RECORDS);
    expect(actualKeys.size).toBe(expectedKeys.size);
    let missing = 0;
    for (const key of expectedKeys) if (!actualKeys.has(key)) missing += 1;
    expect(missing).toBe(0);
    const entities = new Set(pack.mortality.map((record) => record.entityId));
    expect(entities.size).toBe(172);
    let rangeViolations = 0;
    for (const key of expectedKeys) {
      const hazard = pack.hazardIndex[key];
      if (typeof hazard !== "number" || hazard < 0 || hazard > 1_000_000) rangeViolations += 1;
    }
    expect(rangeViolations).toBe(0);
  });

  it("age bands 完整鋪滿 0..120、不重疊，且每個 regionClass×sex 都有對應死因", () => {
    let missing = 0;
    let badWeight = 0;
    for (const regionClass of ["asia", "europe", "africa", "americas", "oceania", "other"] as const) {
      for (const sex of ["female", "male"] as const) {
        for (let age = 0; age <= 120; age += 1) {
          const selection = pack.causeIndex[`${regionClass}|${sex}|${age}`];
          if (selection === undefined || selection.causes.length === 0) missing += 1;
          else if (selection.totalWeight <= 0n) badWeight += 1;
        }
      }
    }
    expect(missing).toBe(0);
    expect(badWeight).toBe(0);
  });

  it("validated pack 是 deep-frozen，且沒有可變引用", () => {
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.mortality)).toBe(true);
    expect(Object.isFrozen(recAt(pack.mortality, 0))).toBe(true);
    expect(Object.isFrozen(pack.causeWeights)).toBe(true);
    expect(Object.isFrozen(recAt(pack.causeWeights, 0))).toBe(true);
    expect(Object.isFrozen(recAt(pack.causeWeights, 0).causes)).toBe(true);
    expect(Object.isFrozen(pack.manifest)).toBe(true);
    expect(Object.isFrozen(pack.manifest.datasets)).toBe(true);
    expect(Object.isFrozen(recAt(pack.manifest.licenses, 0))).toBe(true);
    expect(Object.isFrozen(pack.hazardIndex)).toBe(true);
    expect(Object.isFrozen(pack.causeIndex)).toBe(true);
    expect(() => {
      (recAt(pack.mortality, 0) as { hazardPpm: number }).hazardPpm = 1;
    }).toThrowError(TypeError);
  });

  it("驗證後突變原始輸入不影響 validated pack", () => {
    const raw = loadDeathPack();
    const validatedOnce = validateDeathPack(deathRaw(raw), BASE);
    const before = validatedOnce.packChecksum;
    const firstHazard = recAt(validatedOnce.mortality, 0).hazardPpm;
    recAt(mortality(raw), 0).hazardPpm = 999_999;
    recAt(causeWeights(raw), 0).causes[0].weight = 1;
    raw.manifest.deathPackId = "mutated-after-validation";
    expect(validatedOnce.packChecksum).toBe(before);
    expect(recAt(validatedOnce.mortality, 0).hazardPpm).toBe(firstHazard);
    expect(validatedOnce.manifest.deathPackId).not.toBe("mutated-after-validation");
  });

  it("資料表重新排列後 checksum 與抽選索引完全不變", () => {
    const draft = loadDeathPack();
    for (const datasetId of ["mortality", "cause-weights", "cause-registry", "licenses", "lineage"] as const) {
      deathRecords(draft, datasetId).reverse();
    }
    draft.manifest.datasets.reverse();
    const reordered = validateDeathPack(deathRaw(draft), BASE);
    expect(reordered.packChecksum).toBe(pack.packChecksum);
    expect(reordered.datasetChecksums).toEqual(pack.datasetChecksums);
    expect(reordered.hazardIndex[`${entityIds()[0]}|female|30`]).toBe(pack.hazardIndex[`${entityIds()[0]}|female|30`]);
    expect(reordered.entityIndex).toEqual(pack.entityIndex);
  });
});

/* ------------------------------------------------------------------ */
/* 覆蓋率反例                                                          */
/* ------------------------------------------------------------------ */

describe("P3-D 死亡資料包：覆蓋率反例", () => {
  it("少一筆（不 repair）→ checksum／recordCount 先擋", () => {
    expect(codeFor((draft) => mortality(draft).pop(), { repair: false })).toBe("E_P3D_CHECKSUM");
  });

  it("少一筆（repair 後）→ 覆蓋率不足", () => {
    expect(codeFor((draft) => mortality(draft).pop())).toBe("E_P3D_COVERAGE");
  });

  it("多一筆重複的 entity×sex×age → 重複", () => {
    expect(
      codeFor((draft) => {
        const records = mortality(draft);
        const first = recAt<DeathMutable>(records, 0);
        const second = recAt<DeathMutable>(records, 1);
        second.entityId = first.entityId;
        second.sex = first.sex;
        second.age = first.age;
      })
    ).toBe("E_P3D_DUPLICATE");
  });

  it("真的多一筆（總數超過上限）→ 固定錯誤碼", () => {
    expect(
      codeFor((draft) => {
        const records = mortality(draft);
        records.push({ ...recAt<DeathMutable>(records, 0) });
      })
    ).toBe("E_P3D_RANGE");
  });

  it("未知 entity → E_P3D_ENTITY", () => {
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(mortality(draft), 0).entityId = "cr:ZZZ";
      })
    ).toBe("E_P3D_ENTITY");
  });

  it("121 歲的 mortality 紀錄越界 → E_P3D_RANGE", () => {
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(mortality(draft), 0).age = 121;
      })
    ).toBe("E_P3D_RANGE");
  });

  it("age band 重疊與空洞全部拒絕", () => {
    // 重疊：把第一個 band 的 max 往上擴。
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(causeWeights(draft), 0).ageBandMax = 1;
      })
    ).toBe("E_P3D_AGE_BAND");

    // 空洞：刪掉 0..0 這個 band → 起點不是 0。
    expect(codeFor((draft) => causeWeights(draft).shift())).toBe("E_P3D_AGE_BAND");

    // 空洞：把中間某個 band 的下界往上移。
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(causeWeights(draft), 2).ageBandMin = 6;
      })
    ).toBe("E_P3D_AGE_BAND");
  });

  it("age band 逆序與邊界錯誤全部拒絕", () => {
    // 逆序：min > max。
    expect(
      codeFor((draft) => {
        const band = recAt<DeathMutable>(causeWeights(draft), 1);
        band.ageBandMin = 9;
        band.ageBandMax = 4;
      })
    ).toBe("E_P3D_AGE_BAND");

    // 邊界錯誤：最後一個 band 沒收在 120。
    expect(
      codeFor((draft) => {
        const records = causeWeights(draft);
        recAt<DeathMutable>(records, records.length - 1).ageBandMax = 119;
      })
    ).toBe("E_P3D_AGE_BAND");

    // 邊界錯誤：age band 起點超出 0..120。
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(causeWeights(draft), 0).ageBandMin = -1;
      })
    ).toBe("E_P3D_RANGE");
  });

  it("cause 重複、未知 cause 與 registry 變動全部拒絕", () => {
    expect(
      codeFor((draft) => {
        const band = recAt<DeathMutable>(causeWeights(draft), 0);
        band.causes.push({ ...recAt(band.causes as DeathMutable[], 0) });
      })
    ).toBe("E_P3D_DUPLICATE");

    expect(
      codeFor((draft) => {
        recAt(recAt<DeathMutable>(causeWeights(draft), 0).causes as DeathMutable[], 0).causeId = "cause.unknown.karma";
      })
    ).toBe("E_P3D_CAUSE");

    // cause registry 被改成不同內容 → E_P3D_CAUSE。
    expect(
      codeFor((draft) => {
        const record = recAt<DeathMutable>(causeRegistry(draft), 0);
        record.shareSafe = !record.shareSafe;
      })
    ).toBe("E_P3D_CAUSE");

    // cause registry 少一個 → 覆蓋率。
    expect(codeFor((draft) => causeRegistry(draft).pop())).toBe("E_P3D_COVERAGE");
  });

  it.each([
    ["零", 0],
    ["負", -1],
    ["超安全整數", Number.MAX_SAFE_INTEGER + 2],
    ["大於 2^53", 2 ** 60],
    ["浮點", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY]
  ])("cause 權重為 %s 時拒絕", (_label, weight) => {
    expect(
      codeFor((draft) => {
        recAt(recAt<DeathMutable>(causeWeights(draft), 0).causes as DeathMutable[], 0).weight = weight as number;
      }, { repair: false })
    ).toBe("E_P3D_RANGE");
  });

  it.each([
    ["-1", -1, "E_P3D_RANGE"],
    ["1,000,001", 1_000_001, "E_P3D_RANGE"],
    ["NaN", Number.NaN, "E_P3D_RANGE"],
    ["Infinity", Number.POSITIVE_INFINITY, "E_P3D_RANGE"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "E_P3D_RANGE"],
    ["1.5", 1.5, "E_P3D_RANGE"],
    ["MAX_SAFE_INTEGER+2", Number.MAX_SAFE_INTEGER + 2, "E_P3D_RANGE"],
    ["字串", "12", "E_P3D_TYPE"],
    ["null", null, "E_P3D_TYPE"]
  ])("mortality hazardPpm 為 %s 時拒絕", (_label, value, code) => {
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(mortality(draft), 5).hazardPpm = value;
      }, { repair: false })
    ).toBe(code);
  });

  it("mortality sex 不是 female／male → E_P3D_ENUM", () => {
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(mortality(draft), 0).sex = "other";
      })
    ).toBe("E_P3D_ENUM");
  });
});

/* ------------------------------------------------------------------ */
/* 授權與 lineage                                                      */
/* ------------------------------------------------------------------ */

describe("P3-D 死亡資料包：授權與 lineage", () => {
  it("授權缺失 → 固定錯誤碼", () => {
    expect(codeFor((draft) => licenses(draft).pop())).toBe("E_P3D_LICENSE");
  });

  it("授權綁錯 dataset → E_P3D_LICENSE", () => {
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(licenses(draft), 0).datasetId = "mortality";
      })
    ).toBe("E_P3D_LICENSE");
  });

  it("授權 checksum 與資料集不一致 → E_P3D_LICENSE", () => {
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(licenses(draft), 0).checksum = "a".repeat(64);
      }, { licenses: false })
    ).toBe("E_P3D_LICENSE");
  });

  it("非 synthetic 來源或禁止來源 → E_P3D_CONTENT", () => {
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(licenses(draft), 0).sourceKind = "official";
      })
    ).toBe("E_P3D_CONTENT");

    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(licenses(draft), 0).sourceName = "WHO mortality database";
      })
    ).toBe("E_P3D_CONTENT");

    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(licenses(draft), 0).sourceName = "World Happiness Report 2024";
      })
    ).toBe("E_P3D_CONTENT");

    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(licenses(draft), 0).notes = "derived from GBD estimates";
      })
    ).toBe("E_P3D_CONTENT");

    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(licenses(draft), 0).sourceUrl = "https://example.test/data.csv";
      })
    ).toBe("E_P3D_CONTENT");

    expect(
      codeFor((draft) => {
        draft.manifest.packKind = "official";
      })
    ).toBe("E_P3D_CONTENT");
  });

  it.each([
    ["permission_required", { license: "permission_required" }],
    ["not_allowed", { license: "not_allowed" }],
    ["unknown license", { license: "unknown" }],
    ["legalStatus pending", { legalStatus: "pending" }],
    ["commercialUse unknown", { commercialUse: "unknown" }],
    ["empty evidence", { evidence: [] }],
    ["null licenseId", { licenseId: null }]
  ])("授權狀態 %s 不通過 → E_P3D_LICENSE", (_label, patch) => {
    expect(
      codeFor((draft) => {
        Object.assign(recAt<DeathMutable>(licenses(draft), 0), patch);
      })
    ).toBe("E_P3D_LICENSE");
  });

  it("lineage checksum 錯綁 → E_P3D_LINEAGE", () => {
    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(lineage(draft), 0).outputChecksum = "b".repeat(64);
      }, { lineage: false })
    ).toBe("E_P3D_LINEAGE");

    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(lineage(draft), 1).inputChecksums = ["c".repeat(64)];
      }, { lineage: false })
    ).toBe("E_P3D_LINEAGE");

    expect(
      codeFor((draft) => {
        recAt<DeathMutable>(licenses(draft), 0).lineageId = "lin.p3d.missing";
      })
    ).toBe("E_P3D_LINEAGE");
  });

  it("lineage 未知 parent、重複 parent、環 → E_P3D_LINEAGE", () => {
    const causeRegistryChecksum = pack.datasetChecksums["cause-registry"] as string;
    const causeWeightsChecksum = pack.datasetChecksums["cause-weights"] as string;

    expect(
      codeFor((draft) => {
        const record = recAt<DeathMutable>(lineage(draft), 1);
        record.parentLineageIds = ["lin.p3d.unknown"];
        record.inputChecksums = ["d".repeat(64)];
      })
    ).toBe("E_P3D_LINEAGE");

    expect(
      codeFor((draft) => {
        const record = recAt<DeathMutable>(lineage(draft), 1);
        record.parentLineageIds = ["lin.p3d.cause-registry", "lin.p3d.cause-registry"];
        record.inputChecksums = [causeRegistryChecksum, causeRegistryChecksum];
      })
    ).toBe("E_P3D_LINEAGE");

    // 環：cause-registry ↔ cause-weights 互為 parent。
    expect(
      codeFor((draft) => {
        const root = recAt<DeathMutable>(lineage(draft), 0);
        root.parentLineageIds = ["lin.p3d.cause-weights"];
        root.inputChecksums = [causeWeightsChecksum];
      })
    ).toBe("E_P3D_LINEAGE");

    // 自己指自己。
    expect(
      codeFor((draft) => {
        const root = recAt<DeathMutable>(lineage(draft), 0);
        root.parentLineageIds = ["lin.p3d.cause-registry"];
        root.inputChecksums = [root.outputChecksum];
      })
    ).toBe("E_P3D_LINEAGE");
  });
});

/* ------------------------------------------------------------------ */
/* 信任邊界                                                            */
/* ------------------------------------------------------------------ */

describe("P3-D 死亡資料包：信任邊界", () => {
  it("base pack 不是 validated 品牌 → E_P3D_BASE_PACK", () => {
    const raw = loadDeathPack();
    expect(codeOf(() => validateDeathPack(deathRaw(raw), structuredClone(BASE)))).toBe("E_P3D_BASE_PACK");
    expect(codeOf(() => validateDeathPack(deathRaw(raw), { manifest: {}, datasets: {} }))).toBe("E_P3D_BASE_PACK");
    expect(codeOf(() => validateDeathPack(deathRaw(raw), null))).toBe("E_P3D_BASE_PACK");
  });

  it("base pack 綁定不一致 → E_P3D_BASE_PACK", () => {
    expect(
      codeFor((draft) => {
        draft.manifest.basePackChecksum = "e".repeat(64);
      })
    ).toBe("E_P3D_BASE_PACK");
    expect(
      codeFor((draft) => {
        draft.manifest.basePackId = "p2a-other";
      })
    ).toBe("E_P3D_BASE_PACK");
    expect(
      codeFor((draft) => {
        draft.manifest.entityCount = 171;
      })
    ).toBe("E_P3D_BASE_PACK");
  });

  it("prototype 危險鍵 → E_P3D_PROTOTYPE_KEY", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(
        codeOf(() => {
          const raw = loadDeathPack();
          Object.defineProperty(recAt<DeathMutable>(mortality(raw), 0), key, { value: 1, enumerable: true, configurable: true });
          return validateDeathPack(deathRaw(raw), BASE);
        }),
        key
      ).toBe("E_P3D_PROTOTYPE_KEY");
    }

    expect(
      codeOf(() => {
        const raw = loadDeathPack();
        Object.defineProperty(raw.manifest, "__proto__", { value: {}, enumerable: true, configurable: true });
        return validateDeathPack(deathRaw(raw), BASE);
      })
    ).toBe("E_P3D_PROTOTYPE_KEY");

    expect(
      codeOf(() => {
        const raw = loadDeathPack();
        Object.defineProperty(raw.datasets, "constructor", { value: {}, enumerable: true, configurable: true });
        return validateDeathPack(deathRaw(raw), BASE);
      })
    ).toBe("E_P3D_PROTOTYPE_KEY");
  });

  it("null／array／object 混淆與未知欄位 → 固定錯誤碼", () => {
    expect(codeOf(() => validateDeathPack(null, BASE))).toBe("E_P3D_TYPE");
    expect(codeOf(() => validateDeathPack([], BASE))).toBe("E_P3D_TYPE");
    expect(codeOf(() => validateDeathPack({}, BASE))).toBe("E_P3D_MISSING_KEY");
    expect(codeOf(() => validateDeathPack({ manifest: {}, datasets: {} }, BASE))).toBe("E_P3D_MISSING_KEY");

    expect(
      codeOf(() => {
        const raw = loadDeathPack();
        (raw.manifest as DeathMutable).extra = 1;
        return validateDeathPack(deathRaw(raw), BASE);
      })
    ).toBe("E_P3D_UNKNOWN_KEY");

    expect(
      codeOf(() => {
        const raw = loadDeathPack();
        recAt<DeathMutable>(deathRecords(raw, "mortality"), 0).extra = 1;
        return validateDeathPack(deathRaw(raw), BASE);
      })
    ).toBe("E_P3D_UNKNOWN_KEY");

    expect(
      codeOf(() => {
        const raw = loadDeathPack();
        raw.datasets.mortality = [] as unknown as DeathMutable;
        return validateDeathPack(deathRaw(raw), BASE);
      })
    ).toBe("E_P3D_TYPE");

    expect(
      codeOf(() => {
        const raw = loadDeathPack();
        delete (raw.datasets as Record<string, unknown>).licenses;
        return validateDeathPack(deathRaw(raw), BASE);
      })
    ).toBe("E_P3D_MISSING_KEY");

    expect(
      codeOf(() => {
        const raw = loadDeathPack();
        (raw.datasets as Record<string, unknown>).extra = raw.datasets.mortality;
        return validateDeathPack(deathRaw(raw), BASE);
      })
    ).toBe("E_P3D_UNKNOWN_KEY");
  });

  it("schema／spec／data 版本錯誤 → 固定錯誤碼", () => {
    expect(
      codeFor((draft) => {
        draft.manifest.schemaVersion = "p3d-2";
      })
    ).toBe("E_P3D_SCHEMA_VERSION");
    expect(
      codeFor((draft) => {
        draft.manifest.deathSpecVersion = "2.0.0";
      })
    ).toBe("E_P3D_SCHEMA_VERSION");
    expect(
      codeFor((draft) => {
        draft.manifest.engineVersion = "9.9.9";
      })
    ).toBe("E_P3D_SCHEMA_VERSION");
    expect(
      codeFor((draft) => {
        draft.datasets.mortality.schemaVersion = "p3c-1";
      })
    ).toBe("E_P3D_SCHEMA_VERSION");
    expect(
      codeFor((draft) => {
        draft.datasets.mortality.deathDataVersion = "2.0.0";
      })
    ).toBe("E_P3D_VERSIONS");
    expect(
      codeFor((draft) => {
        draft.datasets.mortality.dataset = "licenses";
      })
    ).toBe("E_P3D_VERSIONS");
    expect(
      codeFor((draft) => {
        draft.manifest.deathDataVersion = "1.0";
      })
    ).toBe("E_P3D_PATTERN");
  });

  it("packChecksum 被改 → E_P3D_CHECKSUM", () => {
    const draft = loadDeathPack();
    draft.manifest.packChecksum = "f".repeat(64);
    expect(codeOf(() => validateDeathPack(deathRaw(draft), BASE))).toBe("E_P3D_CHECKSUM");
  });

  it("所有失敗都只拋 DeathDataError（沒有原生 TypeError）", () => {
    const mutators: ((draft: DeathMutablePack) => void)[] = [
      (draft) => {
        recAt<DeathMutable>(mortality(draft), 0).hazardPpm = null;
      },
      (draft) => {
        recAt<DeathMutable>(causeWeights(draft), 0).causes = "x" as never;
      },
      (draft) => {
        recAt<DeathMutable>(lineage(draft), 0).parentLineageIds = 1 as never;
      },
      (draft) => {
        draft.manifest.datasets = null as never;
      }
    ];
    for (const mutate of mutators) {
      const draft = loadDeathPack();
      mutate(draft);
      let caught: unknown = null;
      try {
        validateDeathPack(deathRaw(draft), BASE);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DeathDataError);
      expect((caught as Error).name).toBe("DeathDataError");
      expect((caught as DeathDataError).code).toMatch(/^E_P3D_/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 查表 API                                                            */
/* ------------------------------------------------------------------ */

describe("P3-D 死亡資料包：查表 API", () => {
  it("hazard / regionClass / causeSelection 都是 O(1) 且缺資料時固定報錯", () => {
    const entityId = entityIds()[0] as string;
    const regionCode = regionCodeOf(entityId);
    expect(typeof pack.hazardIndex[`${entityId}|female|0`]).toBe("number");
    expect(pack.entityIndex[entityId]).toBeTruthy();
    expect(hazardPpmOf(pack, entityId, "female", 0)).toBe(pack.hazardIndex[`${entityId}|female|0`]);
    expect(entityBindingOf(pack, entityId)).toEqual({
      entityId,
      regionCode,
      regionClass: BASE.registry.find((entry) => entry.entityId === entityId)?.region
    });
    expect(assertEntityRegionBinding(pack, entityId, regionCode)).toEqual(entityBindingOf(pack, entityId));
    expect(causeSelectionOf(pack, "asia", "female", 0).causes.length).toBeGreaterThan(0);
    expect(codeOf(() => hazardPpmOf(pack, "cr:ZZZ", "female", 0))).toBe("E_P3D_ENTITY");
    expect(codeOf(() => entityBindingOf(pack, "ZZZ"))).toBe("E_P3D_ENTITY");
    expect(codeOf(() => assertEntityRegionBinding(pack, entityId, "ALB"))).toBe("E_P3D_ENTITY");
    expect(codeOf(() => causeSelectionOf(pack, "asia", "female", 200))).toBe("E_P3D_AGE_BAND");
  });

  it("fixture 檔名與 manifest descriptor 一致", () => {
    const dir = join(process.cwd(), "fixtures", "p3d");
    for (const descriptor of pack.manifest.datasets) {
      const text = readFileSync(join(dir, descriptor.fileName), "utf8");
      expect(text.length).toBeGreaterThan(0);
    }
    expect(pack.manifest.datasets.map((entry) => entry.datasetId).sort()).toEqual([
      "cause-registry",
      "cause-weights",
      "licenses",
      "lineage",
      "mortality"
    ]);
  });

  it("clone 過的乾淨 pack 仍然可以驗證（fixture 本身是自洽的）", () => {
    const draft = clone(loadDeathPack());
    expect(codeOf(() => validateDeathPack(deathRaw(draft), BASE))).toBe("NO_ERROR");
  });
});
