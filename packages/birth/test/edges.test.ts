import { describe, expect, it } from "vitest";
import * as birth from "../src/index";
import { drawBirth } from "../src/draw";
import { runBirthCases } from "../src/p2a-browser";
import { validateDataPack } from "../src/validate";
import { pickWeightedIndex } from "../src/weights";
import { asRaw, codeOf, dataset, loadPack, recordAt, repair, repairChecksums } from "./helpers";

const SETTINGS = { birthYear: 2024, sexPolicy: "random" as const };

function validated() {
  return validateDataPack(asRaw(loadPack()));
}

describe("P2-A.1 edge cases", () => {
  it("rejects invalid draw inputs and long seeds", () => {
    const pack = validated();
    expect(codeOf(() => drawBirth(pack, null as never))).toBe("E_P2A_TYPE");
    expect(codeOf(() => drawBirth(pack, { seed: 42 as never, settings: SETTINGS }))).toBe("E_P2A_SEED");
    expect(codeOf(() => drawBirth(pack, { seed: "x", settings: null as never }))).toBe("E_P2A_TYPE");
    expect(codeOf(() => drawBirth(pack, { seed: "s".repeat(129), settings: SETTINGS }))).toBe("E_P2A_SEED");
  });

  it("handles empty and out-of-range weight tickets", () => {
    expect(codeOf(() => pickWeightedIndex([], () => 0n))).toBe("E_P2A_NO_CANDIDATES");
    expect(codeOf(() => pickWeightedIndex([1, 1], () => 2n))).toBe("E_P2A_WEIGHT_OVERFLOW");
  });

  it("accepts a registry with a null iso3 (custom region code)", () => {
    const pack = loadPack();
    recordAt(pack, "country-registry", 0).iso3 = null;
    repair(pack);
    const result = validateDataPack(asRaw(pack));
    expect(result.registry[0]?.iso3).toBeNull();
  });

  it("rejects a band whose min is greater than its max", () => {
    const pack = loadPack();
    const bands = recordAt(pack, "birth-weights", 0).bands as Array<Record<string, unknown>>;
    (bands[0] as Record<string, unknown>).minGrams = 3000;
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_BAND_RANGE");
  });

  it("rejects non-integer indicator values and malformed grants", () => {
    const fractional = loadPack();
    recordAt(fractional, "indicators", 0).value = 1.5;
    expect(codeOf(() => validateDataPack(asRaw(fractional)))).toBe("E_P2A_TYPE");

    const grant = loadPack();
    recordAt(grant, "licenses", 0).grant = { granted: true };
    expect(codeOf(() => validateDataPack(asRaw(grant)))).toBe("E_P2A_MISSING_KEY");

    const lineage = loadPack();
    recordAt(lineage, "lineage", 0).parentLineageIds = "x";
    expect(codeOf(() => validateDataPack(asRaw(lineage)))).toBe("E_P2A_TYPE");
  });

  it("accepts an official pack when every source is official", () => {
    const pack = loadPack();
    pack.manifest.packKind = "official";
    for (const license of dataset(pack, "licenses").records) license.sourceKind = "official";
    repairChecksums(pack);
    expect(validateDataPack(asRaw(pack)).manifest.packKind).toBe("official");
  });

  it("rejects duplicate license source ids in the manifest", () => {
    const pack = loadPack();
    pack.manifest.licenseSourceIds = [...pack.manifest.licenseSourceIds, pack.manifest.licenseSourceIds[0] as string];
    repairChecksums(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_MANIFEST_MISMATCH");
  });

  it("rejects indicator rows that the manifest does not declare", () => {
    const pack = loadPack();
    pack.manifest.indicatorIds = ["birth_share_weight"];
    repairChecksums(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_INDICATOR_UNKNOWN");
  });

  it("rejects a sensitive ref that points at the wrong mapping", () => {
    const pack = loadPack();
    const record = dataset(pack, "country-registry").records.find((item) => item.entityId === "cr:HKG");
    if (!record) throw new Error("missing HKG");
    record.sensitiveNameRef = "sn:MAC";
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_SENSITIVE_NAME_MISSING");
  });

  it("rejects a pack with no enabled entities", () => {
    const pack = loadPack();
    for (const record of dataset(pack, "country-registry").records) record.status = "disabled";
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_NO_CANDIDATES");
  });

  it("exposes the public barrel and the browser entry", () => {
    expect(typeof birth.drawBirth).toBe("function");
    expect(typeof birth.validateDataPack).toBe("function");
    expect(typeof birth.computePackChecksum).toBe("function");
    expect(typeof birth.packChecksumProjection).toBe("function");
    const pack = validated();
    const [draft] = runBirthCases(asRaw(loadPack()), [{ seed: "p2a-seed-09", birthYear: 2024, sexPolicy: "random" }]);
    expect(draft).toEqual(drawBirth(pack, { seed: "p2a-seed-09", settings: SETTINGS }));
  });
});
