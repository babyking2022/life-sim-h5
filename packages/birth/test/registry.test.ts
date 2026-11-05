import { describe, expect, it } from "vitest";
import { validateDataPack } from "../src/validate";
import { asRaw, loadPack } from "./helpers";

describe("P2-A country/region registry", () => {
  it("has exactly 172 unique entities and codes", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    expect(pack.registry).toHaveLength(172);
    expect(new Set(pack.registry.map((record) => record.entityId)).size).toBe(172);
    expect(new Set(pack.registry.map((record) => record.regionCode)).size).toBe(172);
    expect(new Set(pack.registry.map((record) => record.iso3)).size).toBe(172);
    for (const record of pack.registry) {
      expect(record.entityId).toBe(`cr:${record.regionCode}`);
      expect(record.regionCode).toMatch(/^[A-Z]{3}$/);
      expect(record.status).toBe("enabled");
    }
  });

  it("splits named entities from the reviewable sensitive mapping", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    const named = pack.registry.filter((record) => record.sensitiveNameRef === null);
    const mapped = pack.registry.filter((record) => record.sensitiveNameRef !== null);
    expect(named).toHaveLength(169);
    expect(mapped).toHaveLength(3);
    expect(mapped.map((record) => record.regionCode).sort()).toEqual(["HKG", "MAC", "TWN"]);
    for (const record of named) expect(record.displayNameZhHans).not.toBeNull();
    for (const record of mapped) expect(record.displayNameZhHans).toBeNull();
  });

  it("resolves display names for every entity (including the mapping)", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    expect(Object.keys(pack.displayNames)).toHaveLength(172);
    expect(pack.displayNames["cr:HKG"]).toBe("中国香港特别行政区");
    expect(pack.displayNames["cr:MAC"]).toBe("中国澳门特别行政区");
    expect(pack.displayNames["cr:TWN"]).toBe("中国台湾地区");
    expect(pack.displayNames["cr:JPN"]).toBe("日本");
  });

  it("covers every entity with both indicators and both birth weight sexes", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    expect(pack.indicators).toHaveLength(344);
    expect(pack.birthWeights).toHaveLength(344);
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
