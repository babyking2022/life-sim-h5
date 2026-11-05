import { describe, expect, it } from "vitest";
import type { BirthDraft } from "@life-sim/contracts";
import { drawBirth } from "../src/draw";
import { validateDataPack } from "../src/validate";
import { asRaw, codeOf, dataset, loadPack, recordAt, repair, repairChecksums, type MutablePack } from "./helpers";

const SETTINGS = { birthYear: 2024, sexPolicy: "random" as const };

function mutationOutcome(action: () => void): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof TypeError ? "TypeError" : "OTHER_ERROR";
  }
}

function frozenPack(): ReturnType<typeof validateDataPack> {
  return validateDataPack(asRaw(loadPack()));
}

describe("P2-A.1 validated pack is a deep, independent snapshot", () => {
  it("freezes the pack, manifest, every record and every exposed map", () => {
    const pack = frozenPack();
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.manifest)).toBe(true);
    expect(Object.isFrozen(pack.manifest.datasets)).toBe(true);
    expect(Object.isFrozen(pack.manifest.datasets[0])).toBe(true);
    expect(Object.isFrozen(pack.registry)).toBe(true);
    expect(Object.isFrozen(pack.registry[0])).toBe(true);
    expect(Object.isFrozen(pack.indicators[0])).toBe(true);
    expect(Object.isFrozen(pack.birthWeights[0])).toBe(true);
    expect(Object.isFrozen(pack.birthWeights[0]?.bands)).toBe(true);
    expect(Object.isFrozen(pack.birthWeights[0]?.bands[0])).toBe(true);
    expect(Object.isFrozen(pack.licenses[0])).toBe(true);
    expect(Object.isFrozen(pack.lineage[0])).toBe(true);
    expect(Object.isFrozen(pack.sensitiveNames[0])).toBe(true);
    expect(Object.isFrozen(pack.displayNames)).toBe(true);
    expect(Object.isFrozen(pack.birthShare)).toBe(true);
    expect(Object.isFrozen(pack.birthWeightIndex)).toBe(true);
    expect(Object.isFrozen(pack.datasetChecksums)).toBe(true);
    expect(Object.isFrozen(pack.entityIds)).toBe(true);
    expect(Object.isFrozen(pack.enabledEntityIds)).toBe(true);
  });

  it("throws on every attempted mutation of exposed data", () => {
    const pack = frozenPack();
    expect(mutationOutcome(() => { (pack.registry[0] as unknown as { displayNameZhHans: string }).displayNameZhHans = "HACK"; })).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.registry as unknown as unknown[]).push({}); })).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.displayNames as unknown as Record<string, string>)["cr:JPN"] = "HACK"; })).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.birthShare as unknown as Record<string, number>)["cr:JPN"] = 0; })).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.enabledEntityIds as unknown as string[]).pop(); })).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.datasetChecksums as unknown as Record<string, string>)["indicators"] = "0"; })).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.manifest as unknown as { packId: string }).packId = "HACK"; })).toBe("TypeError");
    expect(
      mutationOutcome(() => {
        const band = pack.birthWeights[0]?.bands[0] as unknown as { weightPpm: number };
        band.weightPpm = 1;
      })
    ).toBe("TypeError");
    expect(
      mutationOutcome(() => {
        const index = Object.keys(pack.birthWeightIndex)[0] as string;
        (pack.birthWeightIndex as unknown as Record<string, unknown>)[index] = {};
      })
    ).toBe("TypeError");
  });

  it("is not affected by later mutation of the raw pack", () => {
    const raw: MutablePack = loadPack();
    const pack = validateDataPack(asRaw(raw));
    const before: BirthDraft = drawBirth(pack, { seed: "p2a-seed-04", settings: SETTINGS });

    /* raw pack 在驗證後被改動，不得影響已驗證的快照 */
    const rawRecord = raw.datasets["country-registry"]?.records[0] as Record<string, unknown>;
    rawRecord.displayNameZhHans = "HACK";
    const rawBand = (raw.datasets["birth-weights"]?.records[0] as Record<string, unknown>).bands as Array<Record<string, unknown>>;
    (rawBand[0] as Record<string, unknown>).weightPpm = 1;
    (raw.manifest as unknown as { packId: string }).packId = "hacked";

    expect(pack.registry[0]).not.toBe(rawRecord);
    expect(pack.manifest).not.toBe(raw.manifest);
    expect(drawBirth(pack, { seed: "p2a-seed-04", settings: SETTINGS })).toEqual(before);
  });
});

describe("P2-A.1 license is bound to exactly one lineage", () => {
  it("rejects a license that points at another dataset's lineage", () => {
    const pack = loadPack();
    recordAt(pack, "licenses", 0).lineageId = "lin:indicators";
    repairChecksums(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_LINEAGE_MISMATCH");
  });

  it("rejects a license whose lineage output checksum is wrong", () => {
    const pack = loadPack();
    recordAt(pack, "lineage", 0).outputChecksum = "0".repeat(64);
    repairChecksums(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_LINEAGE_MISMATCH");
  });

  it("rejects two lineages for the same dataset", () => {
    const pack = loadPack();
    const duplicate = structuredClone(recordAt(pack, "lineage", 0));
    duplicate.lineageId = "lin:registry-copy";
    dataset(pack, "lineage").records.push(duplicate);
    repairChecksums(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_DUPLICATE_KEY");
  });

  it("rejects a lineage for a metadata dataset", () => {
    const pack = loadPack();
    recordAt(pack, "lineage", 0).datasetId = "licenses";
    repairChecksums(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_DATASET_UNKNOWN");
  });
});

describe("P2-A.1 parent lineage and input checksums", () => {
  it("requires parent and input checksum counts to match", () => {
    const missingInputs = loadPack();
    recordAt(missingInputs, "lineage", 1).parentLineageIds = ["lin:country-registry"];
    repairChecksums(missingInputs);
    expect(codeOf(() => validateDataPack(asRaw(missingInputs)))).toBe("E_P2A_LINEAGE_MISMATCH");

    const extraInputs = loadPack();
    recordAt(extraInputs, "lineage", 1).inputChecksums = ["a".repeat(64)];
    repairChecksums(extraInputs);
    expect(codeOf(() => validateDataPack(asRaw(extraInputs)))).toBe("E_P2A_LINEAGE_MISMATCH");
  });

  it("requires each input checksum to equal its parent output checksum", () => {
    const pack = loadPack();
    recordAt(pack, "lineage", 1).parentLineageIds = ["lin:country-registry"];
    recordAt(pack, "lineage", 1).inputChecksums = ["b".repeat(64)];
    repairChecksums(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_LINEAGE_MISMATCH");
  });

  it("accepts a consistent parent and input checksum pair", () => {
    const pack = loadPack();
    const parent = recordAt(pack, "lineage", 0);
    const child = recordAt(pack, "lineage", 1);
    child.parentLineageIds = [String(parent.lineageId)];
    child.inputChecksums = [String(parent.outputChecksum)];
    repair(pack);
    const validated = validateDataPack(asRaw(pack));
    expect(validated.lineage[1]?.parentLineageIds).toEqual(["lin:country-registry"]);
    expect(() => drawBirth(validated, { seed: "p2a-seed-05", settings: SETTINGS })).not.toThrow();
  });

  it("keeps unknown parents, cycles and checksum errors on fixed codes", () => {
    const unknown = loadPack();
    recordAt(unknown, "lineage", 1).parentLineageIds = ["lin:missing"];
    repairChecksums(unknown);
    expect(codeOf(() => validateDataPack(asRaw(unknown)))).toBe("E_P2A_LINEAGE_MISSING");

    const cycle = loadPack();
    recordAt(cycle, "lineage", 0).parentLineageIds = ["lin:country-registry"];
    repairChecksums(cycle);
    expect(codeOf(() => validateDataPack(asRaw(cycle)))).toBe("E_P2A_LINEAGE_CYCLE");
  });
});

describe("P2-A.1 manifest canonical projection", () => {
  it("rejects tampering with createdAt, fileName, packId and packKind without recompute", () => {
    const created = loadPack();
    created.manifest.createdAt = "2026-10-28";
    expect(codeOf(() => validateDataPack(asRaw(created)))).toBe("E_P2A_PACK_CHECKSUM_MISMATCH");

    const file = loadPack();
    descriptorOf(file, "indicators").fileName = "indicators.v2.json";
    expect(codeOf(() => validateDataPack(asRaw(file)))).toBe("E_P2A_PACK_CHECKSUM_MISMATCH");

    const packId = loadPack();
    packId.manifest.packId = "p2a-synthetic-other";
    expect(codeOf(() => validateDataPack(asRaw(packId)))).toBe("E_P2A_PACK_CHECKSUM_MISMATCH");

    const kind = loadPack();
    kind.manifest.packKind = "official";
    expect(codeOf(() => validateDataPack(asRaw(kind)))).toBe("E_P2A_PACK_KIND");
  });

  it("rejects tampering with engineVersion and rngSpecVersion", () => {
    const engine = loadPack();
    engine.manifest.engineVersion = "9.9.9";
    expect(codeOf(() => validateDataPack(asRaw(engine)))).toBe("E_P2A_ENGINE_VERSION");

    const rng = loadPack();
    rng.manifest.rngSpecVersion = "2.0.0";
    expect(codeOf(() => validateDataPack(asRaw(rng)))).toBe("E_P2A_RNG_SPEC_VERSION");

    const recomputed = loadPack();
    recomputed.manifest.engineVersion = "9.9.9";
    repairChecksums(recomputed);
    expect(codeOf(() => validateDataPack(asRaw(recomputed)))).toBe("E_P2A_ENGINE_VERSION");
  });

  it("keeps the checksum stable across dataset order and accepts a re-sorted manifest", () => {
    const pack = loadPack();
    pack.manifest.datasets = [...pack.manifest.datasets].reverse();
    repairChecksums(pack);
    const validated = validateDataPack(asRaw(pack));
    expect(validated.packChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(() => drawBirth(validated, { seed: "p2a-seed-06", settings: SETTINGS })).not.toThrow();
  });
});

function descriptorOf(pack: MutablePack, datasetId: "indicators"): { fileName: string } {
  const entry = pack.manifest.datasets.find((item) => item.datasetId === datasetId);
  if (!entry) throw new Error(`missing descriptor ${datasetId}`);
  return entry;
}
