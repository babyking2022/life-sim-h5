import { describe, expect, it } from "vitest";
import { validateDataPack } from "../src/validate";
import { asRaw, loadPack } from "./helpers";

describe("P2-A country/region registry", () => {
  it("has exactly 169 unique entities and codes", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    expect(pack.registry).toHaveLength(169);
    expect(new Set(pack.registry.map((record) => record.entityId)).size).toBe(169);
    expect(new Set(pack.registry.map((record) => record.regionCode)).size).toBe(169);
    expect(new Set(pack.registry.map((record) => record.iso3)).size).toBe(169);
    for (const record of pack.registry) {
      expect(record.entityId).toBe(`cr:${record.regionCode}`);
      expect(record.regionCode).toMatch(/^[A-Z]{3}$/);
      expect(record.status).toBe("enabled");
    }
  });

  it("每一筆 registry 都有正式名稱，且不再有敏感映射（GPT-0046-A）", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    const named = pack.registry.filter((record) => record.sensitiveNameRef === null);
    const mapped = pack.registry.filter((record) => record.sensitiveNameRef !== null);
    expect(named).toHaveLength(169);
    // HKG／MAC／TWN 已從權威來源刪除，因此敏感映射表必須是空的。
    expect(mapped).toHaveLength(0);
    for (const record of named) expect(record.displayNameZhHans).not.toBeNull();
  });

  it("resolves display names for all 169 entities and never for the removed regions", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    expect(Object.keys(pack.displayNames)).toHaveLength(169);
    expect(pack.displayNames["cr:JPN"]).toBe("日本");
    for (const code of ["cr:TWN", "cr:HKG", "cr:MAC"]) expect(pack.displayNames[code]).toBeUndefined();
  });

  it("covers every entity with both indicators and both birth weight sexes", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    expect(pack.indicators).toHaveLength(338);
    expect(pack.birthWeights).toHaveLength(338);
    for (const entityId of pack.enabledEntityIds) {
      expect(pack.birthShare[entityId]).toBeGreaterThan(0);
      expect(pack.birthWeightIndex[`${entityId}|female`]).toBeDefined();
      expect(pack.birthWeightIndex[`${entityId}|male`]).toBeDefined();
    }
  });

  it("keeps entity ids sorted for deterministic draws", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    expect(pack.entityIds).toEqual([...pack.entityIds].sort());
    expect(pack.enabledEntityIds).toEqual([...pack.enabledEntityIds].sort());
  });
});
