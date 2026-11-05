import { describe, expect, it } from "vitest";
import { validateDataPack } from "../src/validate";
import { asRaw, codeOf, dataset, descriptor, loadPack, recordAt, repair, repairChecksums } from "./helpers";

describe("P2-A pack validation", () => {
  it("accepts the synthetic fixture pack", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    expect(pack.registry).toHaveLength(172);
    expect(pack.indicators).toHaveLength(344);
    expect(pack.birthWeights).toHaveLength(344);
    expect(pack.licenses).toHaveLength(4);
    expect(pack.lineage).toHaveLength(4);
    expect(pack.enabledEntityIds).toHaveLength(172);
    expect(pack.entityIds).toHaveLength(172);
    expect(pack.packChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects unknown and missing keys", () => {
    const extra = loadPack();
    (extra.manifest as unknown as Record<string, unknown>).extra = true;
    expect(codeOf(() => validateDataPack(asRaw(extra)))).toBe("E_P2A_UNKNOWN_KEY");

    const missing = loadPack();
    delete recordAt(missing, "country-registry", 0).entityId;
    expect(codeOf(() => validateDataPack(asRaw(missing)))).toBe("E_P2A_MISSING_KEY");
  });

  it("rejects schema and data version drift", () => {
    const schema = loadPack();
    schema.manifest.schemaVersion = "p2a-2";
    expect(codeOf(() => validateDataPack(asRaw(schema)))).toBe("E_P2A_SCHEMA_VERSION");

    const data = loadPack();
    data.manifest.dataVersion = "2.0.0";
    expect(codeOf(() => validateDataPack(asRaw(data)))).toBe("E_P2A_DATA_VERSION");

    const record = loadPack();
    recordAt(record, "country-registry", 0).dataVersion = "1.0.1";
    expect(codeOf(() => validateDataPack(asRaw(record)))).toBe("E_P2A_DATA_VERSION");
  });

  it("rejects wrong types, enums and patterns", () => {
    const type = loadPack();
    recordAt(type, "country-registry", 0).status = 42;
    expect(codeOf(() => validateDataPack(asRaw(type)))).toBe("E_P2A_TYPE");

    const enumPack = loadPack();
    recordAt(enumPack, "country-registry", 0).region = "moon";
    expect(codeOf(() => validateDataPack(asRaw(enumPack)))).toBe("E_P2A_ENUM");

    const pattern = loadPack();
    recordAt(pattern, "country-registry", 0).entityId = "xx";
    expect(codeOf(() => validateDataPack(asRaw(pattern)))).toBe("E_P2A_PATTERN");
  });

  it("rejects a dataset envelope with the wrong dataset id", () => {
    const pack = loadPack();
    dataset(pack, "country-registry").dataset = "indicators";
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_DATASET_UNKNOWN");
  });

  it("rejects duplicate entity ids and region codes", () => {
    const pack = loadPack();
    const first = recordAt(pack, "country-registry", 0);
    const second = recordAt(pack, "country-registry", 1);
    second.entityId = first.entityId;
    second.regionCode = first.regionCode;
    second.iso3 = first.iso3;
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_DUPLICATE_ENTITY");
  });

  it("rejects a registry entry that has both a name and a sensitive ref", () => {
    const pack = loadPack();
    const hkg = recordAt(pack, "country-registry", 0);
    hkg.displayNameZhHans = "X";
    hkg.sensitiveNameRef = "sn:HKG";
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_REGISTRY_CODE");
  });

  it("rejects a registry that is not exactly 172 entities", () => {
    const pack = loadPack();
    dataset(pack, "country-registry").records.pop();
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_ENTITY_COUNT");

    const manifestCount = loadPack();
    manifestCount.manifest.entityCount = 171;
    expect(codeOf(() => validateDataPack(asRaw(manifestCount)))).toBe("E_P2A_ENTITY_COUNT");
  });

  it("detects dataset checksum and record count drift", () => {
    const pack = loadPack();
    repair(pack);
    recordAt(pack, "country-registry", 2).displayNameZhHans = "changed";
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_CHECKSUM_MISMATCH");

    const count = loadPack();
    repair(count);
    descriptor(count, "indicators").recordCount += 1;
    expect(codeOf(() => validateDataPack(asRaw(count)))).toBe("E_P2A_RECORD_COUNT");
  });

  it("detects manifest and pack checksum drift", () => {
    const pack = loadPack();
    pack.manifest.packChecksum = "0".repeat(64);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_PACK_CHECKSUM_MISMATCH");

    const duplicate = loadPack();
    const lineageDescriptor = descriptor(duplicate, "lineage");
    lineageDescriptor.datasetId = "licenses";
    expect(codeOf(() => validateDataPack(asRaw(duplicate)))).toBe("E_P2A_DATASET_DUPLICATE");
  });

  it("rejects an unknown dataset key and a missing dataset", () => {
    const unknown = loadPack();
    unknown.datasets["extra"] = { schemaVersion: "p2a-1", dataVersion: "1.0.0", dataset: "extra", records: [] };
    expect(codeOf(() => validateDataPack(asRaw(unknown)))).toBe("E_P2A_DATASET_UNKNOWN");

    const missing = loadPack();
    delete missing.datasets.indicators;
    expect(codeOf(() => validateDataPack(asRaw(missing)))).toBe("E_P2A_MISSING_KEY");
  });

  it("rejects an oversized dataset (capacity)", () => {
    const pack = loadPack();
    const envelope = dataset(pack, "indicators");
    envelope.records = Array.from({ length: 4097 }, () => structuredClone(envelope.records[0] as Record<string, unknown>));
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_CAPACITY");
  });

  it("rejects a synthetic pack that carries a non-synthetic source", () => {
    const pack = loadPack();
    const license = recordAt(pack, "licenses", 0);
    license.sourceKind = "official";
    repairChecksums(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_PACK_KIND");
  });
});
