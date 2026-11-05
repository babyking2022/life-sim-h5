import {
  P2A_SUPPORTED_ENGINE_VERSION,
  P2B_ALL_DATASET_IDS,
  P2B_DATASET_IDS,
  P2B_ENTITY_COUNT,
  P2B_HOUSING_TYPES,
  P2B_MAX_HOUSEHOLD_RECORDS,
  P2B_MAX_LICENSE_RECORDS,
  P2B_MAX_LINEAGE_RECORDS,
  P2B_MAX_NAME_RECORDS,
  P2B_MAX_STORY_RECORDS,
  P2B_MAX_VITAL_RECORDS,
  P2B_NAME_KINDS,
  P2B_NAME_SEXES,
  P2B_SCHEMA_VERSION,
  P2B_SCRIPTS,
  P2B_SURNAME_ORDERS,
  P2B_WEIGHT_PPM_TOTAL,
  isSupportedRngSpecVersion,
  type CountryVitalRecord,
  type HouseholdProfileRecord,
  type HousingShare,
  type IdentityDatasetDescriptor,
  type IdentityPackManifest,
  type LicenseRecord,
  type LineageRecord,
  type NameRecord,
  type OccupationShare,
  type P2BAllDatasetId,
  type P2BSchemaVersion,
  type ReligionShare,
  type StoryTemplateRecord
} from "@life-sim/contracts";
import { canonicalBytes, compareBytes, sha256Hex, utf8Encode } from "@life-sim/engine";
import { fail } from "../errors";
import { assertLicenseGate } from "../license";
import { parseDataVersion, parseLicense, parseLineage } from "../records";
import { readArray, readChecksum, readEnum, readExactObject, readInt, readObject, readString } from "../schema";
import { sumWeights } from "../weights";
import { deepFreeze, isValidatedDataPack, type ValidatedDataPack } from "../validate";

const ENTITY_ID = /^cr:[A-Z]{3}$/;
const CULTURE_ID = /^[a-z][a-z0-9_]{1,31}$/;
const TEMPLATE_ID = /^[a-z][a-z0-9_]{1,31}$/;
const OCCUPATION_ID = /^[a-z][a-z0-9_]{1,31}$/;
const RELIGION_ID = /^[a-z][a-z0-9_]{1,31}$/;
const SOURCE_ID = /^[A-Z][A-Z0-9-]{2,63}$/;
const DATASET_ID = /^[a-z][a-z0-9-]{1,31}$/;
const PACK_ID = /^p2b-[a-z0-9-]{1,40}$/;
const FILE_NAME = /^[a-z0-9-]+\.v\d+\.json$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const NAME_VALUE = /^[^\u0000-\u001f\u007f]+$/;
const TEXT_VALUE = /^[^\u0000-\u001f\u007f]*[^\u0000-\u001f\u007f]$/;

export interface RawIdentityPack {
  readonly manifest: unknown;
  readonly datasets: unknown;
}

export interface NamePools {
  readonly surname: readonly string[];
  readonly female: readonly string[];
  readonly male: readonly string[];
}

export interface ValidatedIdentityPack {
  readonly manifest: IdentityPackManifest;
  readonly vitals: readonly CountryVitalRecord[];
  readonly profiles: readonly HouseholdProfileRecord[];
  readonly names: readonly NameRecord[];
  readonly stories: readonly StoryTemplateRecord[];
  readonly licenses: readonly LicenseRecord[];
  readonly lineage: readonly LineageRecord[];
  readonly vitalsByEntity: Readonly<Record<string, CountryVitalRecord>>;
  readonly profileByCulture: Readonly<Record<string, HouseholdProfileRecord>>;
  readonly namePoolsByCulture: Readonly<Record<string, NamePools>>;
  readonly storiesByCulture: Readonly<Record<string, readonly StoryTemplateRecord[]>>;
  readonly datasetChecksums: Readonly<Record<string, string>>;
  readonly packChecksum: string;
}

const validatedIdentityPacks = new WeakSet<object>();

export function isValidatedIdentityPack(value: unknown): value is ValidatedIdentityPack {
  return typeof value === "object" && value !== null && validatedIdentityPacks.has(value);
}

const byBytes = (left: string, right: string): number => compareBytes(utf8Encode(left), utf8Encode(right));
const createIndex = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const STORY_PLACEHOLDERS = new Set(["name", "place", "income", "religion", "motherJob", "fatherJob", "country"]);
const PLACEHOLDER = /\{([^{}]*)\}/g;

function assertStoryPlaceholders(text: string, path: string): void {
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null = PLACEHOLDER.exec(text);
  while (match !== null) {
    const token = match[1] as string;
    if (!STORY_PLACEHOLDERS.has(token)) fail("E_P2B_STORY_PLACEHOLDER", `${path}.{${token}}`);
    match = PLACEHOLDER.exec(text);
  }
  const stripped = text.replace(PLACEHOLDER, "");
  if (stripped.includes("{") || stripped.includes("}")) fail("E_P2B_STORY_PLACEHOLDER", path);
}

function normalizeProfile(record: HouseholdProfileRecord): HouseholdProfileRecord {
  return {
    ...record,
    occupations: [...record.occupations].sort((left, right) => byBytes(left.occupationId, right.occupationId)),
    housing: [...record.housing].sort((left, right) => byBytes(left.housingId, right.housingId)),
    religions: [...record.religions].sort((left, right) => byBytes(left.religionId, right.religionId))
  };
}

/* ------------------------------------------------------------------ */
/* checksums                                                          */
/* ------------------------------------------------------------------ */

export interface IdentityEnvelopeLike {
  readonly schemaVersion: string;
  readonly dataVersion: string;
  readonly dataset: string;
  readonly records: readonly unknown[];
}

export function computeIdentityDatasetChecksum(envelope: IdentityEnvelopeLike): string {
  return sha256Hex(canonicalBytes(envelope as never));
}

export function identityPackChecksumProjection(manifest: IdentityPackManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    dataVersion: manifest.dataVersion,
    packId: manifest.packId,
    packKind: manifest.packKind,
    createdAt: manifest.createdAt,
    engineVersion: manifest.engineVersion,
    rngSpecVersion: manifest.rngSpecVersion,
    basePackId: manifest.basePackId,
    basePackChecksum: manifest.basePackChecksum,
    baseDataVersion: manifest.baseDataVersion,
    entityCount: manifest.entityCount,
    licenseSourceIds: [...manifest.licenseSourceIds].sort(byBytes),
    datasets: manifest.datasets
      .map((descriptor) => ({
        datasetId: descriptor.datasetId,
        fileName: descriptor.fileName,
        recordCount: descriptor.recordCount,
        checksum: descriptor.checksum
      }))
      .sort((left, right) => byBytes(left.datasetId, right.datasetId))
  };
}

export function computeIdentityPackChecksum(manifest: IdentityPackManifest): string {
  return sha256Hex(canonicalBytes(identityPackChecksumProjection(manifest) as never));
}

/* ------------------------------------------------------------------ */
/* parsing                                                            */
/* ------------------------------------------------------------------ */

function parseDatasetDescriptor(value: unknown, path: string): IdentityDatasetDescriptor {
  const object = readExactObject(value, path, ["datasetId", "fileName", "recordCount", "checksum"]);
  const datasetId = readString(object.datasetId, `${path}.datasetId`, { pattern: DATASET_ID });
  if (!(P2B_ALL_DATASET_IDS as readonly string[]).includes(datasetId)) fail("E_P2A_DATASET_UNKNOWN", `${path}.datasetId`);
  return {
    datasetId: datasetId as P2BAllDatasetId,
    fileName: readString(object.fileName, `${path}.fileName`, { pattern: FILE_NAME }),
    recordCount: readInt(object.recordCount, `${path}.recordCount`, 0, 100000),
    checksum: readChecksum(object.checksum, `${path}.checksum`)
  };
}

export function parseIdentityManifest(value: unknown, path: string): IdentityPackManifest {
  const object = readExactObject(value, path, [
    "schemaVersion",
    "dataVersion",
    "packId",
    "packKind",
    "createdAt",
    "engineVersion",
    "rngSpecVersion",
    "basePackId",
    "basePackChecksum",
    "baseDataVersion",
    "entityCount",
    "licenseSourceIds",
    "datasets",
    "packChecksum"
  ]);
  const schemaVersion = readString(object.schemaVersion, `${path}.schemaVersion`, { max: 16 });
  if (schemaVersion !== P2B_SCHEMA_VERSION) fail("E_P2B_SCHEMA_VERSION", `${path}.schemaVersion`);
  const licenseSourceIds = readArray(object.licenseSourceIds, `${path}.licenseSourceIds`, 1, P2B_MAX_LICENSE_RECORDS).map((sourceId, index) =>
    readString(sourceId, `${path}.licenseSourceIds[${index}]`, { pattern: SOURCE_ID })
  );
  const datasets = readArray(object.datasets, `${path}.datasets`, P2B_ALL_DATASET_IDS.length, P2B_ALL_DATASET_IDS.length).map(
    (descriptor, index) => parseDatasetDescriptor(descriptor, `${path}.datasets[${index}]`)
  );
  const manifest: IdentityPackManifest = {
    schemaVersion: P2B_SCHEMA_VERSION as P2BSchemaVersion,
    dataVersion: parseDataVersion(object.dataVersion, `${path}.dataVersion`),
    packId: readString(object.packId, `${path}.packId`, { pattern: PACK_ID }),
    packKind: readEnum(object.packKind, `${path}.packKind`, ["synthetic", "official"] as const),
    createdAt: readString(object.createdAt, `${path}.createdAt`, { pattern: DATE }),
    engineVersion: readString(object.engineVersion, `${path}.engineVersion`, { pattern: VERSION }),
    rngSpecVersion: readString(object.rngSpecVersion, `${path}.rngSpecVersion`, { max: 32 }),
    basePackId: readString(object.basePackId, `${path}.basePackId`, { min: 1, max: 64 }),
    basePackChecksum: readChecksum(object.basePackChecksum, `${path}.basePackChecksum`),
    baseDataVersion: parseDataVersion(object.baseDataVersion, `${path}.baseDataVersion`),
    entityCount: readInt(object.entityCount, `${path}.entityCount`, 1, 512),
    licenseSourceIds,
    datasets,
    packChecksum: readChecksum(object.packChecksum, `${path}.packChecksum`)
  };
  if (manifest.entityCount !== P2B_ENTITY_COUNT) fail("E_P2A_ENTITY_COUNT", `${path}.entityCount`);
  return manifest;
}

function parseEnvelope<T>(
  value: unknown,
  expected: P2BAllDatasetId,
  path: string,
  parser: (record: unknown, path: string, dataVersion: string) => T,
  maxRecords: number
): { schemaVersion: P2BSchemaVersion; dataVersion: string; dataset: P2BAllDatasetId; records: readonly T[] } {
  const object = readExactObject(value, path, ["schemaVersion", "dataVersion", "dataset", "records"]);
  const schemaVersion = readString(object.schemaVersion, `${path}.schemaVersion`, { max: 16 });
  if (schemaVersion !== P2B_SCHEMA_VERSION) fail("E_P2B_SCHEMA_VERSION", `${path}.schemaVersion`);
  const dataVersion = parseDataVersion(object.dataVersion, `${path}.dataVersion`);
  const dataset = readString(object.dataset, `${path}.dataset`, { pattern: DATASET_ID });
  if (dataset !== expected) fail("E_P2A_DATASET_UNKNOWN", `${path}.dataset`);
  const records = readArray(object.records, `${path}.records`, 0, maxRecords + 1);
  if (records.length > maxRecords) fail("E_P2A_CAPACITY", `${path}.records`);
  return {
    schemaVersion: P2B_SCHEMA_VERSION as P2BSchemaVersion,
    dataVersion,
    dataset: expected,
    records: records.map((record, index) => parser(record, `${path}.records[${index}]`, dataVersion))
  };
}

function assertRecordDataVersion(recordVersion: string, datasetVersion: string, path: string): void {
  if (recordVersion !== datasetVersion) fail("E_P2A_DATA_VERSION", path);
}

function parseVital(value: unknown, path: string, dataVersion: string): CountryVitalRecord {
  const object = readExactObject(value, path, [
    "entityId",
    "cultureId",
    "lifeExpectancyYearsX10",
    "under5MortalityPer1000X10",
    "gdpPerCapitaPppUsd",
    "dataVersion"
  ]);
  const lifeExpectancyYearsX10 = readInt(object.lifeExpectancyYearsX10, `${path}.lifeExpectancyYearsX10`, 0, 10000);
  if (lifeExpectancyYearsX10 < 300 || lifeExpectancyYearsX10 > 1000) fail("E_P2B_VITAL_RANGE", `${path}.lifeExpectancyYearsX10`);
  const under5MortalityPer1000X10 = readInt(object.under5MortalityPer1000X10, `${path}.under5MortalityPer1000X10`, 0, 10000);
  if (under5MortalityPer1000X10 > 2000) fail("E_P2B_VITAL_RANGE", `${path}.under5MortalityPer1000X10`);
  const gdpPerCapitaPppUsd = readInt(object.gdpPerCapitaPppUsd, `${path}.gdpPerCapitaPppUsd`, 0, 1000000000);
  if (gdpPerCapitaPppUsd < 100 || gdpPerCapitaPppUsd > 200000) fail("E_P2B_VITAL_RANGE", `${path}.gdpPerCapitaPppUsd`);
  const version = parseDataVersion(object.dataVersion, `${path}.dataVersion`);
  assertRecordDataVersion(version, dataVersion, `${path}.dataVersion`);
  return {
    entityId: readString(object.entityId, `${path}.entityId`, { pattern: ENTITY_ID }),
    cultureId: readString(object.cultureId, `${path}.cultureId`, { pattern: CULTURE_ID }),
    lifeExpectancyYearsX10,
    under5MortalityPer1000X10,
    gdpPerCapitaPppUsd,
    dataVersion: version
  };
}

function parseShare(value: unknown, path: string, idKey: string, idPattern: RegExp, idField: string): { id: string; weightPpm: number; label?: string } {
  const keys = idKey === "housingId" ? [idKey, "weightPpm"] : [idKey, "label", "weightPpm"];
  const object = readExactObject(value, path, keys);
  const id = readString(object[idKey], `${path}.${idField}`, { pattern: idPattern });
  const label = keys.includes("label") ? readString(object.label, `${path}.label`, { min: 1, max: 64 }) : undefined;
  const weightPpm = readInt(object.weightPpm, `${path}.weightPpm`, 1, P2B_WEIGHT_PPM_TOTAL);
  return label === undefined ? { id, weightPpm } : { id, label, weightPpm };
}

function parseProfile(value: unknown, path: string, dataVersion: string): HouseholdProfileRecord {
  const object = readExactObject(value, path, [
    "cultureId",
    "script",
    "surnameOrder",
    "urbanSharePpm",
    "incomeQuintilePpm",
    "motherAgeMin",
    "motherAgeMax",
    "fatherAgeMin",
    "fatherAgeMax",
    "occupations",
    "housing",
    "religions",
    "dataVersion"
  ]);
  const urbanSharePpm = readInt(object.urbanSharePpm, `${path}.urbanSharePpm`, 0, P2B_WEIGHT_PPM_TOTAL);
  if (urbanSharePpm < 1 || urbanSharePpm > P2B_WEIGHT_PPM_TOTAL - 1) fail("E_P2B_PROFILE_WEIGHTS", `${path}.urbanSharePpm`);

  const incomeRaw = readArray(object.incomeQuintilePpm, `${path}.incomeQuintilePpm`, 5, 5);
  const incomeQuintilePpm = incomeRaw.map((entry, index) => readInt(entry, `${path}.incomeQuintilePpm[${index}]`, 1, P2B_WEIGHT_PPM_TOTAL));
  if (sumWeights(incomeQuintilePpm) !== BigInt(P2B_WEIGHT_PPM_TOTAL)) fail("E_P2B_PROFILE_WEIGHTS", `${path}.incomeQuintilePpm`);

  const motherAgeMin = readInt(object.motherAgeMin, `${path}.motherAgeMin`, 14, 80);
  const motherAgeMax = readInt(object.motherAgeMax, `${path}.motherAgeMax`, 14, 80);
  const fatherAgeMin = readInt(object.fatherAgeMin, `${path}.fatherAgeMin`, 14, 80);
  const fatherAgeMax = readInt(object.fatherAgeMax, `${path}.fatherAgeMax`, 14, 80);
  if (motherAgeMin > motherAgeMax) fail("E_P2B_PROFILE_WEIGHTS", `${path}.motherAgeMin`);
  if (fatherAgeMin > fatherAgeMax) fail("E_P2B_PROFILE_WEIGHTS", `${path}.fatherAgeMin`);

  const occupationsRaw = readArray(object.occupations, `${path}.occupations`, 1, 8);
  const occupations: OccupationShare[] = occupationsRaw.map((entry, index) => {
    const share = parseShare(entry, `${path}.occupations[${index}]`, "occupationId", OCCUPATION_ID, "occupationId");
    return { occupationId: share.id, label: share.label as string, weightPpm: share.weightPpm };
  });
  const housingRaw = readArray(object.housing, `${path}.housing`, 1, P2B_HOUSING_TYPES.length);
  const housing: HousingShare[] = housingRaw.map((entry, index) => {
    const share = parseShare(entry, `${path}.housing[${index}]`, "housingId", /^(owned|rented|shared|informal)$/, "housingId");
    return { housingId: share.id as HousingShare["housingId"], weightPpm: share.weightPpm };
  });
  const religionsRaw = readArray(object.religions, `${path}.religions`, 1, 6);
  const religions: ReligionShare[] = religionsRaw.map((entry, index) => {
    const share = parseShare(entry, `${path}.religions[${index}]`, "religionId", RELIGION_ID, "religionId");
    return { religionId: share.id, label: share.label as string, weightPpm: share.weightPpm };
  });

  for (const [key, weights] of [
    ["occupations", occupations.map((entry) => entry.weightPpm)],
    ["housing", housing.map((entry) => entry.weightPpm)],
    ["religions", religions.map((entry) => entry.weightPpm)]
  ] as const) {
    if (sumWeights(weights) !== BigInt(P2B_WEIGHT_PPM_TOTAL)) fail("E_P2B_PROFILE_WEIGHTS", `${path}.${key}`);
  }
  if (new Set(occupations.map((entry) => entry.occupationId)).size !== occupations.length) fail("E_P2A_DUPLICATE_KEY", `${path}.occupations`);
  if (new Set(housing.map((entry) => entry.housingId)).size !== housing.length) fail("E_P2A_DUPLICATE_KEY", `${path}.housing`);
  if (new Set(religions.map((entry) => entry.religionId)).size !== religions.length) fail("E_P2A_DUPLICATE_KEY", `${path}.religions`);

  const version = parseDataVersion(object.dataVersion, `${path}.dataVersion`);
  assertRecordDataVersion(version, dataVersion, `${path}.dataVersion`);
  return {
    cultureId: readString(object.cultureId, `${path}.cultureId`, { pattern: CULTURE_ID }),
    script: readEnum(object.script, `${path}.script`, P2B_SCRIPTS),
    surnameOrder: readEnum(object.surnameOrder, `${path}.surnameOrder`, P2B_SURNAME_ORDERS),
    urbanSharePpm,
    incomeQuintilePpm,
    motherAgeMin,
    motherAgeMax,
    fatherAgeMin,
    fatherAgeMax,
    occupations,
    housing,
    religions,
    dataVersion: version
  };
}

function parseName(value: unknown, path: string, dataVersion: string): NameRecord {
  const object = readExactObject(value, path, ["cultureId", "kind", "sex", "value", "dataVersion"]);
  const kind = readEnum(object.kind, `${path}.kind`, P2B_NAME_KINDS);
  const sex = readEnum(object.sex, `${path}.sex`, P2B_NAME_SEXES);
  if (kind === "surname" && sex !== "total") fail("E_P2A_ENUM", `${path}.sex`);
  if (kind === "given" && sex === "total") fail("E_P2A_ENUM", `${path}.sex`);
  const version = parseDataVersion(object.dataVersion, `${path}.dataVersion`);
  assertRecordDataVersion(version, dataVersion, `${path}.dataVersion`);
  return {
    cultureId: readString(object.cultureId, `${path}.cultureId`, { pattern: CULTURE_ID }),
    kind,
    sex,
    value: readString(object.value, `${path}.value`, { min: 1, max: 40, pattern: NAME_VALUE }),
    dataVersion: version
  };
}

function parseStory(value: unknown, path: string, dataVersion: string): StoryTemplateRecord {
  const object = readExactObject(value, path, ["templateId", "cultureId", "paragraphs", "dataVersion"]);
  const paragraphsRaw = readArray(object.paragraphs, `${path}.paragraphs`, 1, 4);
  const paragraphs = paragraphsRaw.map((paragraph, index) => readString(paragraph, `${path}.paragraphs[${index}]`, { min: 1, max: 240, pattern: TEXT_VALUE }));
  for (let index = 0; index < paragraphs.length; index += 1) assertStoryPlaceholders(paragraphs[index] as string, `${path}.paragraphs[${index}]`);
  const version = parseDataVersion(object.dataVersion, `${path}.dataVersion`);
  assertRecordDataVersion(version, dataVersion, `${path}.dataVersion`);
  return {
    templateId: readString(object.templateId, `${path}.templateId`, { pattern: TEMPLATE_ID }),
    cultureId: readString(object.cultureId, `${path}.cultureId`, { pattern: CULTURE_ID }),
    paragraphs,
    dataVersion: version
  };
}

/* ------------------------------------------------------------------ */
/* validation                                                         */
/* ------------------------------------------------------------------ */

export function validateIdentityPack(base: ValidatedDataPack, raw: RawIdentityPack): ValidatedIdentityPack {
  if (!isValidatedDataPack(base)) fail("E_P2A_PACK_NOT_VALIDATED", "basePack");
  const root = readExactObject(raw, "identityPack", ["manifest", "datasets"]);
  const manifest = parseIdentityManifest(root.manifest, "identityPack.manifest");
  if (
    manifest.basePackId !== base.manifest.packId ||
    manifest.basePackChecksum !== base.packChecksum ||
    manifest.baseDataVersion !== base.manifest.dataVersion
  ) {
    fail("E_P2B_BASE_PACK_MISMATCH", "identityPack.manifest");
  }
  if (manifest.packKind === "official" && base.manifest.packKind !== "official") fail("E_P2B_PACK_KIND", "identityPack.manifest.packKind");
  if (manifest.engineVersion !== P2A_SUPPORTED_ENGINE_VERSION) fail("E_P2A_ENGINE_VERSION", "identityPack.manifest.engineVersion");
  if (!isSupportedRngSpecVersion(manifest.rngSpecVersion)) fail("E_P2A_RNG_SPEC_VERSION", "identityPack.manifest.rngSpecVersion");

  const datasetMap = readObject(root.datasets, "identityPack.datasets");
  for (const datasetId of P2B_ALL_DATASET_IDS) {
    if (!Object.prototype.hasOwnProperty.call(datasetMap, datasetId)) fail("E_P2A_MISSING_KEY", `identityPack.datasets.${datasetId}`);
  }
  for (const key of Object.keys(datasetMap)) {
    if (!(P2B_ALL_DATASET_IDS as readonly string[]).includes(key)) fail("E_P2A_DATASET_UNKNOWN", `identityPack.datasets.${key}`);
  }
  const datasetPath = (datasetId: P2BAllDatasetId): string => `identityPack.datasets.${datasetId}`;

  const descriptors = new Map<P2BAllDatasetId, IdentityDatasetDescriptor>();
  for (let index = 0; index < manifest.datasets.length; index += 1) {
    const descriptor = manifest.datasets[index] as IdentityDatasetDescriptor;
    if (descriptors.has(descriptor.datasetId)) fail("E_P2A_DATASET_DUPLICATE", `identityPack.manifest.datasets[${index}].datasetId`);
    descriptors.set(descriptor.datasetId, descriptor);
  }

  const vitalsEnvelope = parseEnvelope(datasetMap["country-vitals"], "country-vitals", datasetPath("country-vitals"), parseVital, P2B_MAX_VITAL_RECORDS);
  const profileEnvelope = parseEnvelope(
    datasetMap["household-profiles"],
    "household-profiles",
    datasetPath("household-profiles"),
    parseProfile,
    P2B_MAX_HOUSEHOLD_RECORDS
  );
  const nameEnvelope = parseEnvelope(datasetMap["name-corpus"], "name-corpus", datasetPath("name-corpus"), parseName, P2B_MAX_NAME_RECORDS);
  const storyEnvelope = parseEnvelope(datasetMap["story-templates"], "story-templates", datasetPath("story-templates"), parseStory, P2B_MAX_STORY_RECORDS);
  const licenseEnvelope = parseEnvelope(
    datasetMap.licenses,
    "licenses",
    datasetPath("licenses"),
    (record, path) => parseLicense(record, path),
    P2B_MAX_LICENSE_RECORDS
  );
  const lineageEnvelope = parseEnvelope(
    datasetMap.lineage,
    "lineage",
    datasetPath("lineage"),
    (record, path) => parseLineage(record, path),
    P2B_MAX_LINEAGE_RECORDS
  );

  const datasetChecksums = createIndex<string>();
  const checkEnvelope = (datasetId: P2BAllDatasetId, envelope: { schemaVersion: string; dataVersion: string; dataset: string; records: readonly unknown[] }): void => {
    const descriptor = descriptors.get(datasetId) as IdentityDatasetDescriptor;
    if (envelope.dataVersion !== manifest.dataVersion) fail("E_P2A_DATA_VERSION", `${datasetPath(datasetId)}.dataVersion`);
    if (envelope.records.length !== descriptor.recordCount) fail("E_P2A_RECORD_COUNT", `${datasetPath(datasetId)}.records`);
    const checksum = computeIdentityDatasetChecksum(envelope);
    datasetChecksums[datasetId] = checksum;
    if (checksum !== descriptor.checksum) fail("E_P2A_CHECKSUM_MISMATCH", `${datasetPath(datasetId)}.records`);
  };
  checkEnvelope("country-vitals", vitalsEnvelope);
  checkEnvelope("household-profiles", profileEnvelope);
  checkEnvelope("name-corpus", nameEnvelope);
  checkEnvelope("story-templates", storyEnvelope);
  checkEnvelope("licenses", licenseEnvelope);
  checkEnvelope("lineage", lineageEnvelope);

  /* --- country vitals -------------------------------------------------- */
  const vitals = vitalsEnvelope.records;
  if (vitals.length !== P2B_ENTITY_COUNT) fail("E_P2A_ENTITY_COUNT", datasetPath("country-vitals"));
  const vitalsByEntity = createIndex<CountryVitalRecord>();
  const baseEntities = new Set(base.entityIds);
  for (let index = 0; index < vitals.length; index += 1) {
    const record = vitals[index] as CountryVitalRecord;
    const path = `${datasetPath("country-vitals")}.records[${index}]`;
    if (Object.prototype.hasOwnProperty.call(vitalsByEntity, record.entityId)) fail("E_P2A_DUPLICATE_ENTITY", `${path}.entityId`);
    if (!baseEntities.has(record.entityId)) fail("E_P2A_UNKNOWN_ENTITY", `${path}.entityId`);
    vitalsByEntity[record.entityId] = record;
  }
  for (const entityId of base.entityIds) {
    if (!Object.prototype.hasOwnProperty.call(vitalsByEntity, entityId)) fail("E_P2A_ENTITY_COUNT", `${datasetPath("country-vitals")}.${entityId}`);
  }

  /* --- household profiles ---------------------------------------------- */
  const profiles = profileEnvelope.records;
  const profileByCulture = createIndex<HouseholdProfileRecord>();
  for (let index = 0; index < profiles.length; index += 1) {
    const record = profiles[index] as HouseholdProfileRecord;
    const path = `${datasetPath("household-profiles")}.records[${index}]`;
    if (Object.prototype.hasOwnProperty.call(profileByCulture, record.cultureId)) fail("E_P2A_DUPLICATE_KEY", `${path}.cultureId`);
    profileByCulture[record.cultureId] = normalizeProfile(record);
  }

  /* --- names ------------------------------------------------------------ */
  const names = nameEnvelope.records;
  const pools = createIndex<{ surname: string[]; female: string[]; male: string[] }>();
  const seenNames = new Set<string>();
  for (let index = 0; index < names.length; index += 1) {
    const record = names[index] as NameRecord;
    const path = `${datasetPath("name-corpus")}.records[${index}]`;
    const key = `${record.cultureId}|${record.kind}|${record.sex}|${record.value}`;
    if (seenNames.has(key)) fail("E_P2A_DUPLICATE_KEY", path);
    seenNames.add(key);
    const pool = pools[record.cultureId] ?? { surname: [], female: [], male: [] };
    if (record.kind === "surname") pool.surname.push(record.value);
    else if (record.sex === "female") pool.female.push(record.value);
    else if (record.sex === "male") pool.male.push(record.value);
    pools[record.cultureId] = pool;
  }
  const namePoolsByCulture = createIndex<NamePools>();
  for (const [cultureId, pool] of Object.entries(pools)) {
    namePoolsByCulture[cultureId] = {
      surname: [...pool.surname].sort(byBytes),
      female: [...pool.female].sort(byBytes),
      male: [...pool.male].sort(byBytes)
    };
  }

  /* --- story templates -------------------------------------------------- */
  const stories = storyEnvelope.records;
  const storyByCulture = createIndex<StoryTemplateRecord[]>();
  for (let index = 0; index < stories.length; index += 1) {
    const record = stories[index] as StoryTemplateRecord;
    const path = `${datasetPath("story-templates")}.records[${index}]`;
    const bucket = storyByCulture[record.cultureId] ?? [];
    if (bucket.some((entry) => entry.templateId === record.templateId)) fail("E_P2A_DUPLICATE_KEY", `${path}.templateId`);
    bucket.push(record);
    storyByCulture[record.cultureId] = bucket;
  }
  const storiesByCulture = createIndex<readonly StoryTemplateRecord[]>();
  for (const [cultureId, bucket] of Object.entries(storyByCulture)) {
    storiesByCulture[cultureId] = [...bucket].sort((left, right) => byBytes(left.templateId, right.templateId));
  }

  /* --- culture coverage ------------------------------------------------- */
  for (const record of vitals) {
    const cultureId = record.cultureId;
    if (!Object.prototype.hasOwnProperty.call(profileByCulture, cultureId)) {
      fail("E_P2B_HOUSEHOLD_PROFILE_MISSING", `identityPack.datasets.household-profiles.${cultureId}`);
    }
    const pool = namePoolsByCulture[cultureId];
    if (!pool || pool.surname.length === 0 || pool.female.length === 0 || pool.male.length === 0) {
      fail("E_P2B_NAME_POOL_MISSING", `identityPack.datasets.name-corpus.${cultureId}`);
    }
    if (!storiesByCulture[cultureId] || (storiesByCulture[cultureId] as readonly StoryTemplateRecord[]).length === 0) {
      fail("E_P2B_STORY_TEMPLATE_MISSING", `identityPack.datasets.story-templates.${cultureId}`);
    }
  }

  const usedCultures = new Set(vitals.map((record) => record.cultureId));
  for (const cultureId of Object.keys(profileByCulture)) {
    if (!usedCultures.has(cultureId)) fail("E_P2B_UNKNOWN_CULTURE", `identityPack.datasets.household-profiles.${cultureId}`);
  }
  for (const record of names) {
    if (!usedCultures.has(record.cultureId)) fail("E_P2B_UNKNOWN_CULTURE", `identityPack.datasets.name-corpus.${record.cultureId}`);
  }
  for (const record of stories) {
    if (!usedCultures.has(record.cultureId)) fail("E_P2B_UNKNOWN_CULTURE", `identityPack.datasets.story-templates.${record.cultureId}`);
  }

  /* --- licenses --------------------------------------------------------- */
  const licenses = licenseEnvelope.records;
  const licenseBySourceId = new Map<string, LicenseRecord>();
  const licenseByDatasetId = new Map<string, LicenseRecord>();
  for (let index = 0; index < licenses.length; index += 1) {
    const license = licenses[index] as LicenseRecord;
    const path = `${datasetPath("licenses")}.records[${index}]`;
    if (licenseBySourceId.has(license.sourceId)) fail("E_P2A_DUPLICATE_KEY", `${path}.sourceId`);
    if (licenseByDatasetId.has(license.datasetId)) fail("E_P2A_DUPLICATE_KEY", `${path}.datasetId`);
    if (!(P2B_DATASET_IDS as readonly string[]).includes(license.datasetId)) fail("E_P2A_DATASET_UNKNOWN", `${path}.datasetId`);
    licenseBySourceId.set(license.sourceId, license);
    licenseByDatasetId.set(license.datasetId, license);
  }
  for (const datasetId of P2B_DATASET_IDS) {
    if (!licenseByDatasetId.has(datasetId)) fail("E_P2A_LICENSE_MISSING", `identityPack.datasets.${datasetId}`);
  }
  for (let index = 0; index < licenses.length; index += 1) {
    const license = licenses[index] as LicenseRecord;
    const path = `${datasetPath("licenses")}.records[${index}]`;
    assertLicenseGate(license, path);
    if (license.checksum !== datasetChecksums[license.datasetId]) fail("E_P2A_LICENSE_CHECKSUM_MISMATCH", `${path}.checksum`);
  }
  if (manifest.packKind === "synthetic") {
    for (let index = 0; index < licenses.length; index += 1) {
      if ((licenses[index] as LicenseRecord).sourceKind !== "synthetic") fail("E_P2A_PACK_KIND", `${datasetPath("licenses")}.records[${index}].sourceKind`);
    }
  } else {
    for (let index = 0; index < licenses.length; index += 1) {
      if ((licenses[index] as LicenseRecord).sourceKind === "synthetic") fail("E_P2A_PACK_KIND", `${datasetPath("licenses")}.records[${index}].sourceKind`);
    }
  }

  /* --- lineage ---------------------------------------------------------- */
  const lineage = lineageEnvelope.records;
  const lineageById = new Map<string, LineageRecord>();
  const lineageByDataset = new Map<string, LineageRecord>();
  for (let index = 0; index < lineage.length; index += 1) {
    const record = lineage[index] as LineageRecord;
    const path = `${datasetPath("lineage")}.records[${index}]`;
    if (lineageById.has(record.lineageId)) fail("E_P2A_DUPLICATE_KEY", `${path}.lineageId`);
    if (!(P2B_DATASET_IDS as readonly string[]).includes(record.datasetId)) fail("E_P2A_DATASET_UNKNOWN", `${path}.datasetId`);
    if (lineageByDataset.has(record.datasetId)) fail("E_P2A_DUPLICATE_KEY", `${path}.datasetId`);
    lineageById.set(record.lineageId, record);
    lineageByDataset.set(record.datasetId, record);
  }
  for (const datasetId of P2B_DATASET_IDS) {
    if (!lineageByDataset.has(datasetId)) fail("E_P2A_LINEAGE_MISSING", `identityPack.datasets.lineage.${datasetId}`);
  }
  for (let index = 0; index < licenses.length; index += 1) {
    const license = licenses[index] as LicenseRecord;
    const path = `${datasetPath("licenses")}.records[${index}]`;
    const lineageRecord = lineageById.get(license.lineageId);
    if (!lineageRecord) fail("E_P2A_LINEAGE_MISSING", `${path}.lineageId`);
    if (lineageRecord.datasetId !== license.datasetId) fail("E_P2A_LINEAGE_MISMATCH", `${path}.lineageId`);
    if (lineageByDataset.get(license.datasetId)?.lineageId !== lineageRecord.lineageId) fail("E_P2A_LINEAGE_MISMATCH", `${path}.lineageId`);
    if (lineageRecord.outputChecksum !== license.checksum) fail("E_P2A_LINEAGE_MISMATCH", `${path}.lineageId`);
    if (lineageRecord.outputChecksum !== datasetChecksums[license.datasetId]) fail("E_P2A_LINEAGE_MISMATCH", `${path}.lineageId`);
  }
  for (const record of lineage) {
    for (const parentId of record.parentLineageIds) {
      if (!lineageById.has(parentId)) fail("E_P2A_LINEAGE_MISSING", `${datasetPath("lineage")}.${record.lineageId}.parentLineageIds`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (lineageId: string): void => {
    if (visited.has(lineageId)) return;
    if (visiting.has(lineageId)) fail("E_P2A_LINEAGE_CYCLE", `${datasetPath("lineage")}.${lineageId}`);
    visiting.add(lineageId);
    const record = lineageById.get(lineageId);
    if (record) for (const parentId of record.parentLineageIds) visit(parentId);
    visiting.delete(lineageId);
    visited.add(lineageId);
  };
  for (const lineageId of lineageById.keys()) visit(lineageId);
  for (const record of lineage) {
    const path = `${datasetPath("lineage")}.${record.lineageId}`;
    if (record.parentLineageIds.length !== record.inputChecksums.length) fail("E_P2A_LINEAGE_MISMATCH", `${path}.inputChecksums`);
    for (let index = 0; index < record.parentLineageIds.length; index += 1) {
      const parent = lineageById.get(record.parentLineageIds[index] as string) as LineageRecord;
      if (parent.outputChecksum !== record.inputChecksums[index]) fail("E_P2A_LINEAGE_MISMATCH", `${path}.inputChecksums[${index}]`);
    }
  }

  /* --- manifest cross-checks -------------------------------------------- */
  const expectedSources = [...licenseBySourceId.keys()].sort(byBytes);
  const manifestSources = [...manifest.licenseSourceIds].sort(byBytes);
  if (expectedSources.length !== manifestSources.length || expectedSources.some((sourceId, index) => sourceId !== manifestSources[index])) {
    fail("E_P2A_MANIFEST_MISMATCH", "identityPack.manifest.licenseSourceIds");
  }
  if (computeIdentityPackChecksum(manifest) !== manifest.packChecksum) fail("E_P2A_PACK_CHECKSUM_MISMATCH", "identityPack.manifest.packChecksum");

  const pack: ValidatedIdentityPack = {
    manifest,
    vitals,
    profiles,
    names,
    stories,
    licenses,
    lineage,
    vitalsByEntity,
    profileByCulture,
    namePoolsByCulture,
    storiesByCulture,
    datasetChecksums,
    packChecksum: manifest.packChecksum
  };
  deepFreeze(pack);
  validatedIdentityPacks.add(pack);
  return pack;
}

export const P2B_LIMITS = {
  entityCount: P2B_ENTITY_COUNT,
  vitals: P2B_MAX_VITAL_RECORDS,
  profiles: P2B_MAX_HOUSEHOLD_RECORDS,
  names: P2B_MAX_NAME_RECORDS,
  stories: P2B_MAX_STORY_RECORDS,
  licenses: P2B_MAX_LICENSE_RECORDS,
  lineage: P2B_MAX_LINEAGE_RECORDS
} as const;
