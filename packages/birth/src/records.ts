import {
  P2A_BIRTH_WEIGHT_BAND_COUNT,
  P2A_DATASET_IDS,
  P2A_DATA_VERSION_PATTERN,
  P2A_ENTITY_COUNT,
  P2A_INDICATOR_DEFINITIONS,
  P2A_INDICATOR_IDS,
  P2A_MAX_BIRTH_WEIGHT_RECORDS,
  P2A_MAX_INDICATOR_RECORDS,
  P2A_MAX_LICENSE_RECORDS,
  P2A_MAX_LINEAGE_RECORDS,
  P2A_MAX_RECORD_WEIGHT,
  P2A_MAX_SENSITIVE_NAME_RECORDS,
  P2A_MAX_TOTAL_WEIGHT,
  P2A_REGION_CLASSES,
  P2A_SCHEMA_VERSION,
  P2A_SEXES,
  P2A_SOURCE_KINDS,
  P2A_COMMERCIAL_USES,
  P2A_ENTITY_STATUSES,
  P2A_LEGAL_STATUSES,
  P2A_LICENSE_STATES,
  P2A_WEIGHT_PPM_TOTAL,
  SUPPORTED_DATA_MAJOR,
  type BirthWeightBand,
  type BirthWeightRecord,
  type CountryRegionRecord,
  type DataPackManifest,
  type DatasetDescriptor,
  type DatasetEnvelope,
  type DatasetId,
  type IndicatorRecord,
  type LicenseGrant,
  type LicenseRecord,
  type LineageRecord,
  type P2ASchemaVersion,
  type SensitiveNameRecord,
  type Sex
} from "@life-sim/contracts";
import { fail } from "./errors";
import { assertRecordWeight } from "./weights";
import {
  readArray,
  readBoolean,
  readChecksum,
  readEnum,
  readExactObject,
  readInt,
  readLiteral,
  readNullableString,
  readObject,
  readString,
  readStringArray
} from "./schema";

const ENTITY_ID = /^cr:[A-Z]{3}$/;
const REGION_CODE = /^[A-Z]{3}$/;
const SENSITIVE_REF = /^sn:[A-Z]{3}$/;
const SOURCE_ID = /^[A-Z][A-Z0-9-]{2,63}$/;
const LINEAGE_ID = /^lin:[a-z0-9-]{1,64}$/;
const BAND_ID = /^[a-z0-9][a-z0-9_]{0,31}$/;
const DATASET_ID = /^[a-z][a-z0-9-]{1,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PACK_ID = /^p2a-[a-z0-9-]{1,40}$/;
const FILE_NAME = /^[a-z0-9-]+\.v\d+\.json$/;

const INDICATOR_UNITS = ["relative_weight", "rate_ppm", "gram"] as const;
const INDICATOR_SEXES = ["female", "male", "total"] as const;

export function parseDataVersion(value: unknown, path: string): string {
  const version = readString(value, path, { min: 5, max: 32 });
  if (!P2A_DATA_VERSION_PATTERN.test(version)) fail("E_P2A_DATA_VERSION", path);
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major) || major !== SUPPORTED_DATA_MAJOR) fail("E_P2A_DATA_VERSION", path);
  return version;
}

function assertRecordDataVersion(recordVersion: string, datasetVersion: string, path: string): void {
  if (recordVersion !== datasetVersion) fail("E_P2A_DATA_VERSION", path);
}

/* ------------------------------------------------------------------ */
/* datasets                                                           */
/* ------------------------------------------------------------------ */

export function parseDatasetEnvelope<T>(
  value: unknown,
  expected: DatasetId,
  path: string,
  recordParser: (record: unknown, path: string, dataVersion: string) => T,
  maxRecords: number
): DatasetEnvelope<T> {
  const object = readExactObject(value, path, ["schemaVersion", "dataVersion", "dataset", "records"]);
  readLiteral(object.schemaVersion, `${path}.schemaVersion`, P2A_SCHEMA_VERSION);
  const dataVersion = parseDataVersion(object.dataVersion, `${path}.dataVersion`);
  const dataset = readString(object.dataset, `${path}.dataset`, { pattern: DATASET_ID });
  if (dataset !== expected) fail("E_P2A_DATASET_UNKNOWN", `${path}.dataset`);
  const records = readArray(object.records, `${path}.records`, 0, maxRecords + 1);
  if (records.length > maxRecords) fail("E_P2A_CAPACITY", `${path}.records`);
  const parsed = records.map((record, index) => recordParser(record, `${path}.records[${index}]`, dataVersion));
  return { schemaVersion: P2A_SCHEMA_VERSION as P2ASchemaVersion, dataVersion, dataset: expected, records: parsed };
}

/* ------------------------------------------------------------------ */
/* registry                                                           */
/* ------------------------------------------------------------------ */

export function parseCountryRegion(value: unknown, path: string, dataVersion: string): CountryRegionRecord {
  const object = readExactObject(value, path, [
    "entityId",
    "iso3",
    "regionCode",
    "displayNameZhHans",
    "sensitiveNameRef",
    "region",
    "status",
    "dataVersion"
  ]);
  const entityId = readString(object.entityId, `${path}.entityId`, { pattern: ENTITY_ID });
  const regionCode = readString(object.regionCode, `${path}.regionCode`, { pattern: REGION_CODE });
  const iso3 = object.iso3 === null ? null : readString(object.iso3, `${path}.iso3`, { pattern: REGION_CODE });
  const displayName = readNullableString(object.displayNameZhHans, `${path}.displayNameZhHans`, { min: 1, max: 64 });
  const sensitiveNameRef =
    object.sensitiveNameRef === null ? null : readString(object.sensitiveNameRef, `${path}.sensitiveNameRef`, { pattern: SENSITIVE_REF });
  const region = readEnum(object.region, `${path}.region`, P2A_REGION_CLASSES);
  const status = readEnum(object.status, `${path}.status`, P2A_ENTITY_STATUSES);
  const recordVersion = parseDataVersion(object.dataVersion, `${path}.dataVersion`);
  assertRecordDataVersion(recordVersion, dataVersion, `${path}.dataVersion`);

  /* 恰好一個：直接寫死名字，或指向可審核的敏感名稱映射。 */
  if ((displayName === null) === (sensitiveNameRef === null)) fail("E_P2A_REGISTRY_CODE", `${path}.displayNameZhHans`);
  if (iso3 !== null && iso3 !== regionCode) fail("E_P2A_REGISTRY_CODE", `${path}.regionCode`);
  if (entityId !== `cr:${regionCode}`) fail("E_P2A_REGISTRY_CODE", `${path}.entityId`);

  return { entityId, iso3, regionCode, displayNameZhHans: displayName, sensitiveNameRef, region, status, dataVersion: recordVersion };
}

/* ------------------------------------------------------------------ */
/* indicators                                                         */
/* ------------------------------------------------------------------ */

export function parseIndicator(value: unknown, path: string, dataVersion: string): IndicatorRecord {
  const object = readExactObject(value, path, [
    "indicatorId",
    "entityId",
    "year",
    "sex",
    "unit",
    "value",
    "sourceId",
    "dataVersion"
  ]);
  const indicatorId = readEnum(object.indicatorId, `${path}.indicatorId`, P2A_INDICATOR_IDS);
  const definition = P2A_INDICATOR_DEFINITIONS[indicatorId];
  const entityId = readString(object.entityId, `${path}.entityId`, { pattern: ENTITY_ID });
  const year = readInt(object.year, `${path}.year`, 1900, 2200);
  const sex = readEnum(object.sex, `${path}.sex`, INDICATOR_SEXES);
  const unit = readEnum(object.unit, `${path}.unit`, INDICATOR_UNITS);
  let indicatorValue: number;
  if (indicatorId === "birth_share_weight") {
    if (typeof object.value !== "number" || !Number.isInteger(object.value)) fail("E_P2A_TYPE", `${path}.value`);
    indicatorValue = assertRecordWeight(object.value, `${path}.value`);
  } else {
    indicatorValue = readInt(object.value, `${path}.value`, definition.min, definition.max);
  }
  const sourceId = readString(object.sourceId, `${path}.sourceId`, { pattern: SOURCE_ID });
  const recordVersion = parseDataVersion(object.dataVersion, `${path}.dataVersion`);
  assertRecordDataVersion(recordVersion, dataVersion, `${path}.dataVersion`);
  if (unit !== definition.unit) fail("E_P2A_INDICATOR_UNIT", `${path}.unit`);
  if (sex !== definition.sex) fail("E_P2A_INDICATOR_SEX", `${path}.sex`);
  return { indicatorId, entityId, year, sex, unit, value: indicatorValue, sourceId, dataVersion: recordVersion };
}

/* ------------------------------------------------------------------ */
/* birth weights                                                      */
/* ------------------------------------------------------------------ */

function parseBand(value: unknown, path: string): BirthWeightBand {
  const object = readExactObject(value, path, ["bandId", "minGrams", "maxGrams", "weightPpm"]);
  return {
    bandId: readString(object.bandId, `${path}.bandId`, { pattern: BAND_ID }),
    minGrams: readInt(object.minGrams, `${path}.minGrams`, 300, 7000),
    maxGrams: readInt(object.maxGrams, `${path}.maxGrams`, 300, 7000),
    weightPpm: readInt(object.weightPpm, `${path}.weightPpm`, 1, P2A_WEIGHT_PPM_TOTAL)
  };
}

export function parseBirthWeight(value: unknown, path: string, dataVersion: string): BirthWeightRecord {
  const object = readExactObject(value, path, [
    "entityId",
    "sex",
    "year",
    "meanGrams",
    "sdGrams",
    "bands",
    "sourceId",
    "dataVersion"
  ]);
  const entityId = readString(object.entityId, `${path}.entityId`, { pattern: ENTITY_ID });
  const sex = readEnum(object.sex, `${path}.sex`, P2A_SEXES) as Sex;
  const year = readInt(object.year, `${path}.year`, 1900, 2200);
  const meanGrams = readInt(object.meanGrams, `${path}.meanGrams`, 1500, 5000);
  const sdGrams = readInt(object.sdGrams, `${path}.sdGrams`, 100, 1500);
  const bandsRaw = readArray(object.bands, `${path}.bands`, 1, P2A_BIRTH_WEIGHT_BAND_COUNT);
  if (bandsRaw.length !== P2A_BIRTH_WEIGHT_BAND_COUNT) fail("E_P2A_BAND_COUNT", `${path}.bands`);
  const bands = bandsRaw.map((band, index) => parseBand(band, `${path}.bands[${index}]`));
  const sourceId = readString(object.sourceId, `${path}.sourceId`, { pattern: SOURCE_ID });
  const recordVersion = parseDataVersion(object.dataVersion, `${path}.dataVersion`);
  assertRecordDataVersion(recordVersion, dataVersion, `${path}.dataVersion`);

  let previous: BirthWeightBand | null = null;
  let totalPpm = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index] as BirthWeightBand;
    if (band.minGrams > band.maxGrams) fail("E_P2A_BAND_RANGE", `${path}.bands[${index}]`);
    if (previous !== null) {
      if (band.minGrams <= previous.minGrams) fail("E_P2A_BAND_ORDER", `${path}.bands[${index}].minGrams`);
      if (band.minGrams <= previous.maxGrams) fail("E_P2A_BAND_OVERLAP", `${path}.bands[${index}].minGrams`);
    }
    totalPpm += band.weightPpm;
    previous = band;
  }
  if (totalPpm !== P2A_WEIGHT_PPM_TOTAL) fail("E_P2A_BAND_WEIGHT_TOTAL", `${path}.bands`);

  return { entityId, sex, year, meanGrams, sdGrams, bands, sourceId, dataVersion: recordVersion };
}

/* ------------------------------------------------------------------ */
/* licenses                                                           */
/* ------------------------------------------------------------------ */

export function parseLicense(value: unknown, path: string): LicenseRecord {
  const object = readExactObject(value, path, [
    "sourceId",
    "datasetId",
    "datasetLabel",
    "sourceKind",
    "sourceName",
    "sourceUrl",
    "version",
    "retrievedAt",
    "license",
    "licenseId",
    "commercialUse",
    "legalStatus",
    "evidence",
    "grant",
    "checksum",
    "lineageId",
    "notes"
  ]);
  const grantRaw = object.grant === null ? null : readExactObject(object.grant, `${path}.grant`, ["granted", "evidence", "grantedAt"]);
  const grant: LicenseGrant | null = grantRaw
    ? {
        granted: readBoolean(grantRaw.granted, `${path}.grant.granted`),
        evidence: readString(grantRaw.evidence, `${path}.grant.evidence`, { max: 512 }),
        grantedAt: readString(grantRaw.grantedAt, `${path}.grant.grantedAt`, { pattern: DATE })
      }
    : null;
  return {
    sourceId: readString(object.sourceId, `${path}.sourceId`, { pattern: SOURCE_ID }),
    datasetId: readString(object.datasetId, `${path}.datasetId`, { pattern: DATASET_ID }),
    datasetLabel: readString(object.datasetLabel, `${path}.datasetLabel`, { min: 1, max: 96 }),
    sourceKind: readEnum(object.sourceKind, `${path}.sourceKind`, P2A_SOURCE_KINDS),
    sourceName: readString(object.sourceName, `${path}.sourceName`, { min: 1, max: 160 }),
    sourceUrl: readNullableString(object.sourceUrl, `${path}.sourceUrl`, { max: 512 }),
    version: readString(object.version, `${path}.version`, { min: 1, max: 32 }),
    retrievedAt: readString(object.retrievedAt, `${path}.retrievedAt`, { pattern: DATE }),
    license: readEnum(object.license, `${path}.license`, P2A_LICENSE_STATES),
    licenseId: readNullableString(object.licenseId, `${path}.licenseId`, { max: 64 }),
    commercialUse: readEnum(object.commercialUse, `${path}.commercialUse`, P2A_COMMERCIAL_USES),
    legalStatus: readEnum(object.legalStatus, `${path}.legalStatus`, P2A_LEGAL_STATUSES),
    evidence: readStringArray(object.evidence, `${path}.evidence`, 0, 16),
    grant,
    checksum: readChecksum(object.checksum, `${path}.checksum`),
    lineageId: readString(object.lineageId, `${path}.lineageId`, { pattern: LINEAGE_ID }),
    notes: readString(object.notes, `${path}.notes`, { max: 512 })
  };
}

export function parseLineage(value: unknown, path: string): LineageRecord {
  const object = readExactObject(value, path, [
    "lineageId",
    "datasetId",
    "parentLineageIds",
    "transform",
    "generatedBy",
    "generatedAt",
    "inputChecksums",
    "outputChecksum",
    "notes"
  ]);
  const parentLineageIds = readArray(object.parentLineageIds, `${path}.parentLineageIds`, 0, 8).map((id, index) =>
    readString(id, `${path}.parentLineageIds[${index}]`, { pattern: LINEAGE_ID })
  );
  const inputChecksums = readArray(object.inputChecksums, `${path}.inputChecksums`, 0, 8).map((checksum, index) =>
    readChecksum(checksum, `${path}.inputChecksums[${index}]`)
  );
  return {
    lineageId: readString(object.lineageId, `${path}.lineageId`, { pattern: LINEAGE_ID }),
    datasetId: readString(object.datasetId, `${path}.datasetId`, { pattern: DATASET_ID }),
    parentLineageIds,
    transform: readString(object.transform, `${path}.transform`, { min: 1, max: 64 }),
    generatedBy: readString(object.generatedBy, `${path}.generatedBy`, { min: 1, max: 160 }),
    generatedAt: readString(object.generatedAt, `${path}.generatedAt`, { pattern: DATE }),
    inputChecksums,
    outputChecksum: readChecksum(object.outputChecksum, `${path}.outputChecksum`),
    notes: readString(object.notes, `${path}.notes`, { max: 512 })
  };
}

export function parseSensitiveNameRecord(value: unknown, path: string): SensitiveNameRecord {
  const record = readExactObject(value, path, ["entityId", "displayNameZhHans", "reviewStatus", "reviewedBy", "reviewedAt", "note"]);
  return {
    entityId: readString(record.entityId, `${path}.entityId`, { pattern: ENTITY_ID }),
    displayNameZhHans: readString(record.displayNameZhHans, `${path}.displayNameZhHans`, { min: 1, max: 64 }),
    reviewStatus: readEnum(record.reviewStatus, `${path}.reviewStatus`, ["approved", "pending", "rejected"] as const),
    reviewedBy: readString(record.reviewedBy, `${path}.reviewedBy`, { min: 1, max: 64 }),
    reviewedAt: readString(record.reviewedAt, `${path}.reviewedAt`, { pattern: DATE }),
    note: readString(record.note, `${path}.note`, { max: 512 })
  };
}

/* ------------------------------------------------------------------ */
/* manifest                                                           */
/* ------------------------------------------------------------------ */

function parseDescriptor(value: unknown, path: string): DatasetDescriptor {
  const object = readExactObject(value, path, ["datasetId", "fileName", "recordCount", "checksum"]);
  const datasetId = readString(object.datasetId, `${path}.datasetId`, { pattern: DATASET_ID });
  if (!(P2A_DATASET_IDS as readonly string[]).includes(datasetId)) fail("E_P2A_DATASET_UNKNOWN", `${path}.datasetId`);
  return {
    datasetId: datasetId as DatasetId,
    fileName: readString(object.fileName, `${path}.fileName`, { pattern: FILE_NAME }),
    recordCount: readInt(object.recordCount, `${path}.recordCount`, 0, 100000),
    checksum: readChecksum(object.checksum, `${path}.checksum`)
  };
}

export function parseManifest(value: unknown, path: string): DataPackManifest {
  const object = readExactObject(value, path, [
    "schemaVersion",
    "dataVersion",
    "packId",
    "packKind",
    "createdAt",
    "engineVersion",
    "rngSpecVersion",
    "entityCount",
    "indicatorYear",
    "indicatorIds",
    "licenseSourceIds",
    "datasets",
    "packChecksum"
  ]);
  readLiteral(object.schemaVersion, `${path}.schemaVersion`, P2A_SCHEMA_VERSION);
  const indicatorIdsRaw = readArray(object.indicatorIds, `${path}.indicatorIds`, 1, P2A_INDICATOR_IDS.length);
  const indicatorIds = indicatorIdsRaw.map((id, index) => readEnum(id, `${path}.indicatorIds[${index}]`, P2A_INDICATOR_IDS));
  const licenseSourceIdsRaw = readArray(object.licenseSourceIds, `${path}.licenseSourceIds`, 1, P2A_MAX_LICENSE_RECORDS);
  const licenseSourceIds = licenseSourceIdsRaw.map((id, index) =>
    readString(id, `${path}.licenseSourceIds[${index}]`, { pattern: SOURCE_ID })
  );
  const datasetsRaw = readArray(object.datasets, `${path}.datasets`, P2A_DATASET_IDS.length, P2A_DATASET_IDS.length);
  const datasets = datasetsRaw.map((descriptor, index) => parseDescriptor(descriptor, `${path}.datasets[${index}]`));

  const manifest: DataPackManifest = {
    schemaVersion: P2A_SCHEMA_VERSION as P2ASchemaVersion,
    dataVersion: parseDataVersion(object.dataVersion, `${path}.dataVersion`),
    packId: readString(object.packId, `${path}.packId`, { pattern: PACK_ID }),
    packKind: readEnum(object.packKind, `${path}.packKind`, ["synthetic", "official"] as const),
    createdAt: readString(object.createdAt, `${path}.createdAt`, { pattern: DATE }),
    engineVersion: readString(object.engineVersion, `${path}.engineVersion`, { pattern: VERSION }),
    rngSpecVersion: readString(object.rngSpecVersion, `${path}.rngSpecVersion`, { max: 32 }),
    entityCount: readInt(object.entityCount, `${path}.entityCount`, 1, 512),
    indicatorYear: readInt(object.indicatorYear, `${path}.indicatorYear`, 1900, 2200),
    indicatorIds,
    licenseSourceIds,
    datasets,
    packChecksum: readChecksum(object.packChecksum, `${path}.packChecksum`)
  };

  if (manifest.entityCount !== P2A_ENTITY_COUNT) fail("E_P2A_ENTITY_COUNT", `${path}.entityCount`);
  return manifest;
}

/** 供工具與測試重建資料包時使用的上限表。 */
export const P2A_RECORD_LIMITS = {
  entityCount: P2A_ENTITY_COUNT,
  indicators: P2A_MAX_INDICATOR_RECORDS,
  birthWeights: P2A_MAX_BIRTH_WEIGHT_RECORDS,
  licenses: P2A_MAX_LICENSE_RECORDS,
  lineage: P2A_MAX_LINEAGE_RECORDS,
  sensitiveNames: P2A_MAX_SENSITIVE_NAME_RECORDS,
  maxWeight: P2A_MAX_RECORD_WEIGHT,
  maxTotalWeight: P2A_MAX_TOTAL_WEIGHT
} as const;

export function readDatasetsMap(value: unknown, path: string): Readonly<Record<string, unknown>> {
  return readObject(value, path);
}
