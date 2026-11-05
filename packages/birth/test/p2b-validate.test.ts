import { describe, expect, it } from "vitest";
import { validateIdentityPack } from "../src/identity/validate";
import { asRaw, loadPack } from "./helpers";
import { validateDataPack } from "../src/validate";
import {
  codeOfIdentity,
  identityDataset,
  identityDescriptor,
  identityRaw,
  identityRecord,
  loadIdentityPack,
  repairIdentity,
  repairIdentityChecksums,
  type MutableIdentityPack
} from "./p2b-helpers";

const base = validateDataPack(asRaw(loadPack()));
const validate = (pack: MutableIdentityPack) => validateIdentityPack(base, identityRaw(pack) as never);
const code = (pack: MutableIdentityPack) => codeOfIdentity(() => validate(pack));

describe("P2-B identity pack validation", () => {
  it("accepts the synthetic identity pack and binds it to the P2-A base pack", () => {
    const pack = validate(loadIdentityPack());
    expect(pack.vitals).toHaveLength(172);
    expect(pack.profiles).toHaveLength(13);
    expect(pack.names).toHaveLength(234);
    expect(pack.stories).toHaveLength(26);
    expect(pack.licenses).toHaveLength(4);
    expect(pack.manifest.basePackChecksum).toBe(base.packChecksum);
    expect(pack.packChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a base pack that does not match the manifest binding", () => {
    const pack = loadIdentityPack();
    pack.manifest.basePackChecksum = "0".repeat(64);
    expect(code(pack)).toBe("E_P2B_BASE_PACK_MISMATCH");

    const other = loadIdentityPack();
    other.manifest.basePackId = "other-pack";
    expect(code(other)).toBe("E_P2B_BASE_PACK_MISMATCH");
  });

  it("rejects schema, data, engine and rng version drift", () => {
    const schema = loadIdentityPack();
    schema.manifest.schemaVersion = "p2b-2";
    expect(code(schema)).toBe("E_P2B_SCHEMA_VERSION");

    const envelope = loadIdentityPack();
    identityDataset(envelope, "country-vitals").schemaVersion = "p2b-2";
    expect(code(envelope)).toBe("E_P2B_SCHEMA_VERSION");

    const data = loadIdentityPack();
    identityDataset(data, "name-corpus").dataVersion = "1.0.1";
    expect(code(data)).toBe("E_P2A_DATA_VERSION");

    const record = loadIdentityPack();
    identityRecord(record, "country-vitals", 0).dataVersion = "1.0.1";
    expect(code(record)).toBe("E_P2A_DATA_VERSION");

    const engine = loadIdentityPack();
    engine.manifest.engineVersion = "9.9.9";
    expect(code(engine)).toBe("E_P2A_ENGINE_VERSION");

    const rng = loadIdentityPack();
    rng.manifest.rngSpecVersion = "2.0.0";
    expect(code(rng)).toBe("E_P2A_RNG_SPEC_VERSION");
  });

  it("rejects missing and unknown keys", () => {
    const missing = loadIdentityPack();
    delete identityRecord(missing, "household-profiles", 0).cultureId;
    expect(code(missing)).toBe("E_P2A_MISSING_KEY");

    const unknown = loadIdentityPack();
    (identityRecord(unknown, "country-vitals", 0) as Record<string, unknown>).extra = 1;
    expect(code(unknown)).toBe("E_P2A_UNKNOWN_KEY");
  });

  it("rejects dataset map and descriptor problems", () => {
    const missing = loadIdentityPack();
    delete missing.datasets["name-corpus"];
    expect(code(missing)).toBe("E_P2A_MISSING_KEY");

    const unknown = loadIdentityPack();
    unknown.datasets["extra"] = { schemaVersion: "p2b-1", dataVersion: "1.0.0", dataset: "extra", records: [] };
    expect(code(unknown)).toBe("E_P2A_DATASET_UNKNOWN");

    const duplicate = loadIdentityPack();
    identityDescriptor(duplicate, "lineage").datasetId = "licenses";
    expect(code(duplicate)).toBe("E_P2A_DATASET_DUPLICATE");

    const wrongDataset = loadIdentityPack();
    identityDataset(wrongDataset, "name-corpus").dataset = "story-templates";
    expect(code(wrongDataset)).toBe("E_P2A_DATASET_UNKNOWN");
  });

  it("rejects checksum and record count drift", () => {
    const checksum = loadIdentityPack();
    identityDescriptor(checksum, "country-vitals").checksum = "0".repeat(64);
    expect(code(checksum)).toBe("E_P2A_CHECKSUM_MISMATCH");

    const count = loadIdentityPack();
    repairIdentityChecksums(count);
    identityDescriptor(count, "name-corpus").recordCount += 1;
    expect(code(count)).toBe("E_P2A_RECORD_COUNT");

    const pack = loadIdentityPack();
    pack.manifest.packChecksum = "0".repeat(64);
    expect(code(pack)).toBe("E_P2A_PACK_CHECKSUM_MISMATCH");
  });

  it("rejects capacity overflow", () => {
    const pack = loadIdentityPack();
    const envelope = identityDataset(pack, "story-templates");
    envelope.records = Array.from({ length: 513 }, (_, index) => structuredClone({ ...envelope.records[0], templateId: `t${index}` }));
    expect(code(pack)).toBe("E_P2A_CAPACITY");
  });

  it("rejects country vital problems", () => {
    const duplicate = loadIdentityPack();
    identityRecord(duplicate, "country-vitals", 1).entityId = "cr:CHN";
    repairIdentity(duplicate);
    expect(code(duplicate)).toBe("E_P2A_DUPLICATE_ENTITY");

    const unknown = loadIdentityPack();
    identityRecord(unknown, "country-vitals", 0).entityId = "cr:ZZZ";
    repairIdentity(unknown);
    expect(code(unknown)).toBe("E_P2A_UNKNOWN_ENTITY");

    const count = loadIdentityPack();
    identityDataset(count, "country-vitals").records.pop();
    repairIdentity(count);
    expect(code(count)).toBe("E_P2A_ENTITY_COUNT");

    const life = loadIdentityPack();
    identityRecord(life, "country-vitals", 0).lifeExpectancyYearsX10 = 200;
    expect(code(life)).toBe("E_P2B_VITAL_RANGE");

    const u5 = loadIdentityPack();
    identityRecord(u5, "country-vitals", 0).under5MortalityPer1000X10 = 3000;
    expect(code(u5)).toBe("E_P2B_VITAL_RANGE");

    const gdp = loadIdentityPack();
    identityRecord(gdp, "country-vitals", 0).gdpPerCapitaPppUsd = 50;
    expect(code(gdp)).toBe("E_P2B_VITAL_RANGE");
  });

  it("rejects household profile problems", () => {
    const duplicate = loadIdentityPack();
    identityDataset(duplicate, "household-profiles").records.push(structuredClone(identityRecord(duplicate, "household-profiles", 0)));
    repairIdentity(duplicate);
    expect(code(duplicate)).toBe("E_P2A_DUPLICATE_KEY");

    const urban = loadIdentityPack();
    identityRecord(urban, "household-profiles", 0).urbanSharePpm = 0;
    repairIdentity(urban);
    expect(code(urban)).toBe("E_P2B_PROFILE_WEIGHTS");

    const income = loadIdentityPack();
    (identityRecord(income, "household-profiles", 0).incomeQuintilePpm as number[])[0]! += 1;
    repairIdentity(income);
    expect(code(income)).toBe("E_P2B_PROFILE_WEIGHTS");

    const ages = loadIdentityPack();
    identityRecord(ages, "household-profiles", 0).motherAgeMin = 50;
    identityRecord(ages, "household-profiles", 0).motherAgeMax = 30;
    repairIdentity(ages);
    expect(code(ages)).toBe("E_P2B_PROFILE_WEIGHTS");

    const jobs = loadIdentityPack();
    (identityRecord(jobs, "household-profiles", 0).occupations as Array<Record<string, unknown>>)[0]!.weightPpm = 1;
    repairIdentity(jobs);
    expect(code(jobs)).toBe("E_P2B_PROFILE_WEIGHTS");

    const housing = loadIdentityPack();
    (identityRecord(housing, "household-profiles", 0).housing as Array<Record<string, unknown>>)[0]!.weightPpm = 1;
    repairIdentity(housing);
    expect(code(housing)).toBe("E_P2B_PROFILE_WEIGHTS");

    const religions = loadIdentityPack();
    (identityRecord(religions, "household-profiles", 0).religions as Array<Record<string, unknown>>)[0]!.weightPpm = 1;
    repairIdentity(religions);
    expect(code(religions)).toBe("E_P2B_PROFILE_WEIGHTS");

    const duplicateJob = loadIdentityPack();
    const jobsList = identityRecord(duplicateJob, "household-profiles", 0).occupations as Array<Record<string, unknown>>;
    jobsList[1]!.occupationId = jobsList[0]!.occupationId;
    repairIdentity(duplicateJob);
    expect(code(duplicateJob)).toBe("E_P2A_DUPLICATE_KEY");
  });

  it("rejects name corpus problems", () => {
    const duplicate = loadIdentityPack();
    identityDataset(duplicate, "name-corpus").records.push(structuredClone(identityRecord(duplicate, "name-corpus", 0)));
    repairIdentity(duplicate);
    expect(code(duplicate)).toBe("E_P2A_DUPLICATE_KEY");

    const sex = loadIdentityPack();
    identityRecord(sex, "name-corpus", 0).sex = "female";
    repairIdentity(sex);
    expect(code(sex)).toBe("E_P2A_ENUM");

    const given = loadIdentityPack();
    const givenRecord = identityDataset(given, "name-corpus").records.find((record) => record.kind === "given");
    if (!givenRecord) throw new Error("missing given name record");
    givenRecord.sex = "total";
    repairIdentity(given);
    expect(code(given)).toBe("E_P2A_ENUM");

    const empty = loadIdentityPack();
    identityRecord(empty, "name-corpus", 0).value = "";
    repairIdentity(empty);
    expect(code(empty)).toBe("E_P2A_PATTERN");
  });

  it("rejects story template problems", () => {
    const duplicate = loadIdentityPack();
    identityDataset(duplicate, "story-templates").records.push(structuredClone(identityRecord(duplicate, "story-templates", 0)));
    repairIdentity(duplicate);
    expect(code(duplicate)).toBe("E_P2A_DUPLICATE_KEY");

    const long = loadIdentityPack();
    (identityRecord(long, "story-templates", 0).paragraphs as string[])[0] = "x".repeat(241);
    repairIdentity(long);
    expect(code(long)).toBe("E_P2A_RANGE");
  });

  it("requires profiles, name pools and story templates for every culture in use", () => {
    const profile = loadIdentityPack();
    identityRecord(profile, "country-vitals", 0).cultureId = "unknown_culture";
    repairIdentity(profile);
    expect(code(profile)).toBe("E_P2B_HOUSEHOLD_PROFILE_MISSING");

    const names = loadIdentityPack();
    identityDataset(names, "name-corpus").records = identityDataset(names, "name-corpus").records.filter((record) => record.cultureId !== "han");
    repairIdentity(names);
    expect(code(names)).toBe("E_P2B_NAME_POOL_MISSING");

    const stories = loadIdentityPack();
    identityDataset(stories, "story-templates").records = identityDataset(stories, "story-templates").records.filter((record) => record.cultureId !== "han");
    repairIdentity(stories);
    expect(code(stories)).toBe("E_P2B_STORY_TEMPLATE_MISSING");
  });

  it("rejects license problems", () => {
    const missing = loadIdentityPack();
    identityDataset(missing, "licenses").records.pop();
    repairIdentity(missing);
    expect(code(missing)).toBe("E_P2A_LICENSE_MISSING");

    const unknownDataset = loadIdentityPack();
    identityRecord(unknownDataset, "licenses", 0).datasetId = "nope";
    repairIdentityChecksums(unknownDataset);
    expect(code(unknownDataset)).toBe("E_P2A_DATASET_UNKNOWN");

    const unknownState = loadIdentityPack();
    identityRecord(unknownState, "licenses", 0).license = "unknown";
    repairIdentityChecksums(unknownState);
    expect(code(unknownState)).toBe("E_P2A_LICENSE_UNKNOWN");

    const checksum = loadIdentityPack();
    identityRecord(checksum, "licenses", 0).checksum = "0".repeat(64);
    repairIdentityChecksums(checksum);
    expect(code(checksum)).toBe("E_P2A_LICENSE_CHECKSUM_MISMATCH");

    const kind = loadIdentityPack();
    identityRecord(kind, "licenses", 0).sourceKind = "official";
    repairIdentityChecksums(kind);
    expect(code(kind)).toBe("E_P2A_PACK_KIND");
  });

  it("rejects lineage problems", () => {
    const duplicateDataset = loadIdentityPack();
    const clone = structuredClone(identityRecord(duplicateDataset, "lineage", 0));
    clone.lineageId = "lin:copy";
    identityDataset(duplicateDataset, "lineage").records.push(clone);
    repairIdentityChecksums(duplicateDataset);
    expect(code(duplicateDataset)).toBe("E_P2A_DUPLICATE_KEY");

    const metadata = loadIdentityPack();
    identityRecord(metadata, "lineage", 0).datasetId = "licenses";
    repairIdentityChecksums(metadata);
    expect(code(metadata)).toBe("E_P2A_DATASET_UNKNOWN");

    const binding = loadIdentityPack();
    identityRecord(binding, "licenses", 0).lineageId = "lin:name-corpus";
    repairIdentityChecksums(binding);
    expect(code(binding)).toBe("E_P2A_LINEAGE_MISMATCH");

    const parent = loadIdentityPack();
    identityRecord(parent, "lineage", 0).parentLineageIds = ["lin:missing"];
    repairIdentityChecksums(parent);
    expect(code(parent)).toBe("E_P2A_LINEAGE_MISSING");

    const cycle = loadIdentityPack();
    identityRecord(cycle, "lineage", 0).parentLineageIds = ["lin:country-vitals"];
    repairIdentityChecksums(cycle);
    expect(code(cycle)).toBe("E_P2A_LINEAGE_CYCLE");

    const pair = loadIdentityPack();
    identityRecord(pair, "lineage", 0).parentLineageIds = ["lin:name-corpus"];
    repairIdentityChecksums(pair);
    expect(code(pair)).toBe("E_P2A_LINEAGE_MISMATCH");
  });

  it("rejects a license source list that does not match the manifest", () => {
    const pack = loadIdentityPack();
    pack.manifest.licenseSourceIds = [...pack.manifest.licenseSourceIds, pack.manifest.licenseSourceIds[0] as string];
    repairIdentityChecksums(pack);
    expect(code(pack)).toBe("E_P2A_MANIFEST_MISMATCH");
  });
});
