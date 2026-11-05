import { describe, expect, it } from "vitest";
import { validateDataPack } from "../src/validate";
import { asRaw, codeOf, dataset, loadPack, recordAt, repair, repairChecksums } from "./helpers";

describe("P2-A indicators", () => {
  it("rejects the wrong unit and sex for a known indicator", () => {
    const unit = loadPack();
    recordAt(unit, "indicators", 0).unit = "gram";
    expect(codeOf(() => validateDataPack(asRaw(unit)))).toBe("E_P2A_INDICATOR_UNIT");

    const sex = loadPack();
    recordAt(sex, "indicators", 0).sex = "female";
    expect(codeOf(() => validateDataPack(asRaw(sex)))).toBe("E_P2A_INDICATOR_SEX");
  });

  it("rejects an unsupported indicator year", () => {
    const pack = loadPack();
    recordAt(pack, "indicators", 0).year = 2023;
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_INDICATOR_YEAR");
  });

  it("rejects duplicate and missing indicator rows", () => {
    const duplicate = loadPack();
    dataset(duplicate, "indicators").records.push(structuredClone(recordAt(duplicate, "indicators", 0)));
    repair(duplicate);
    expect(codeOf(() => validateDataPack(asRaw(duplicate)))).toBe("E_P2A_INDICATOR_DUPLICATE");

    const missing = loadPack();
    dataset(missing, "indicators").records.shift();
    repair(missing);
    expect(codeOf(() => validateDataPack(asRaw(missing)))).toBe("E_P2A_INDICATOR_MISSING");
  });

  it("rejects unknown sources and a source from the wrong dataset", () => {
    const unknown = loadPack();
    recordAt(unknown, "indicators", 0).sourceId = "NOPE-SOURCE";
    repair(unknown);
    expect(codeOf(() => validateDataPack(asRaw(unknown)))).toBe("E_P2A_UNKNOWN_SOURCE");

    const mismatch = loadPack();
    recordAt(mismatch, "indicators", 0).sourceId = "SYNTH-P2A-BIRTH-WEIGHTS";
    repair(mismatch);
    expect(codeOf(() => validateDataPack(asRaw(mismatch)))).toBe("E_P2A_SOURCE_DATASET_MISMATCH");
  });

  it("rejects zero, negative and unsafe birth share weights", () => {
    const zero = loadPack();
    recordAt(zero, "indicators", 0).value = 0;
    expect(codeOf(() => validateDataPack(asRaw(zero)))).toBe("E_P2A_WEIGHT_ZERO");

    const negative = loadPack();
    recordAt(negative, "indicators", 0).value = -5;
    expect(codeOf(() => validateDataPack(asRaw(negative)))).toBe("E_P2A_WEIGHT_NEGATIVE");

    /* 2^53 不是安全整數，checksum 也不能編碼；解析階段就要以固定碼拒絕。 */
    const overflow = loadPack();
    recordAt(overflow, "indicators", 0).value = 2 ** 53;
    expect(codeOf(() => validateDataPack(asRaw(overflow)))).toBe("E_P2A_WEIGHT_OVERFLOW");
  });

  it("accepts MAX_SAFE_INTEGER as a single weight", () => {
    const pack = loadPack();
    recordAt(pack, "indicators", 0).value = Number.MAX_SAFE_INTEGER;
    const entityId = String(recordAt(pack, "indicators", 0).entityId);
    repair(pack);
    const validated = validateDataPack(asRaw(pack));
    expect(validated.birthShare[entityId]).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects an indicator for an entity that is not in the registry", () => {
    const pack = loadPack();
    recordAt(pack, "indicators", 0).entityId = "cr:ZZZ";
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_UNKNOWN_ENTITY");
  });
});

describe("P2-A birth weight records", () => {
  it("rejects bands out of order, overlapping bands and a bad ppm total", () => {
    const order = loadPack();
    const orderBands = recordAt(order, "birth-weights", 0).bands as Array<Record<string, unknown>>;
    orderBands.reverse();
    repair(order);
    expect(codeOf(() => validateDataPack(asRaw(order)))).toBe("E_P2A_BAND_ORDER");

    const overlap = loadPack();
    const overlapBands = recordAt(overlap, "birth-weights", 0).bands as Array<Record<string, unknown>>;
    (overlapBands[1] as Record<string, unknown>).minGrams = 2400;
    repair(overlap);
    expect(codeOf(() => validateDataPack(asRaw(overlap)))).toBe("E_P2A_BAND_OVERLAP");

    const total = loadPack();
    const totalBands = recordAt(total, "birth-weights", 0).bands as Array<Record<string, unknown>>;
    (totalBands[0] as Record<string, unknown>).weightPpm = 100;
    repair(total);
    expect(codeOf(() => validateDataPack(asRaw(total)))).toBe("E_P2A_BAND_WEIGHT_TOTAL");
  });

  it("rejects the wrong number of bands", () => {
    const pack = loadPack();
    const bands = recordAt(pack, "birth-weights", 0).bands as Array<Record<string, unknown>>;
    bands.pop();
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_BAND_COUNT");
  });

  it("rejects duplicate, missing and unknown-entity birth weights", () => {
    const duplicate = loadPack();
    dataset(duplicate, "birth-weights").records.push(structuredClone(recordAt(duplicate, "birth-weights", 0)));
    repair(duplicate);
    expect(codeOf(() => validateDataPack(asRaw(duplicate)))).toBe("E_P2A_INDICATOR_DUPLICATE");

    const missing = loadPack();
    dataset(missing, "birth-weights").records.shift();
    repair(missing);
    expect(codeOf(() => validateDataPack(asRaw(missing)))).toBe("E_P2A_INDICATOR_MISSING");

    const unknown = loadPack();
    recordAt(unknown, "birth-weights", 0).entityId = "cr:ZZZ";
    repair(unknown);
    expect(codeOf(() => validateDataPack(asRaw(unknown)))).toBe("E_P2A_UNKNOWN_ENTITY");
  });
});

describe("P2-A lineage", () => {
  it("requires lineage for each data dataset", () => {
    const pack = loadPack();
    const index = dataset(pack, "lineage").records.findIndex((record) => record.datasetId === "birth-weights");
    dataset(pack, "lineage").records.splice(index, 1);
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_LINEAGE_MISSING");
  });

  it("rejects an output checksum that does not match its dataset", () => {
    const pack = loadPack();
    recordAt(pack, "lineage", 0).outputChecksum = "0".repeat(64);
    repairChecksums(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_LINEAGE_MISMATCH");
  });

  it("rejects an unknown parent and a cycle", () => {
    const unknown = loadPack();
    recordAt(unknown, "lineage", 0).parentLineageIds = ["lin:missing"];
    repairChecksums(unknown);
    expect(codeOf(() => validateDataPack(asRaw(unknown)))).toBe("E_P2A_LINEAGE_MISSING");

    const cycle = loadPack();
    recordAt(cycle, "lineage", 0).parentLineageIds = ["lin:country-registry"];
    repairChecksums(cycle);
    expect(codeOf(() => validateDataPack(asRaw(cycle)))).toBe("E_P2A_LINEAGE_CYCLE");
  });
});
