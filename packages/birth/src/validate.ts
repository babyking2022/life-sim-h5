import {
  P2A_BIRTH_WEIGHT_BAND_COUNT,
  P2A_DATA_DATASET_IDS,
  P2A_DATASET_IDS,
  P2A_ENTITY_COUNT,
  P2A_MAX_BIRTH_WEIGHT_RECORDS,
  P2A_MAX_INDICATOR_RECORDS,
  P2A_MAX_LICENSE_RECORDS,
  P2A_MAX_LINEAGE_RECORDS,
  P2A_MAX_SENSITIVE_NAME_RECORDS,
  P2A_SEXES,
  P2A_SUPPORTED_ENGINE_VERSION,
  isSupportedRngSpecVersion,
  type BirthWeightRecord,
  type CountryRegionRecord,
  type DataPackManifest,
  type DatasetDescriptor,
  type DatasetEnvelope,
  type DatasetId,
  type IndicatorId,
  type IndicatorRecord,
  type LicenseRecord,
  type LineageRecord,
  type SensitiveNameRecord,
  type Sex
} from "@life-sim/contracts";
import { canonicalBytes, compareBytes, sha256Hex, utf8Encode } from "@life-sim/engine";
import { fail } from "./errors";
import { assertLicenseGate } from "./license";
import {
  P2A_RECORD_LIMITS,
  parseBirthWeight,
  parseCountryRegion,
  parseDatasetEnvelope,
  parseIndicator,
  parseLicense,
  parseLineage,
  parseManifest,
  parseSensitiveNameRecord,
  readDatasetsMap
} from "./records";
import { readExactObject } from "./schema";
import { assertRecordWeight, sumWeights } from "./weights";

export interface RawDataPack {
  readonly manifest: unknown;
  readonly datasets: unknown;
}

export type BirthShareMap = Readonly<Record<string, number>>;
export type DisplayNameMap = Readonly<Record<string, string>>;
export type DatasetChecksumMap = Readonly<Record<string, string>>;

export interface ValidatedDataPack {
  readonly manifest: DataPackManifest;
  readonly registry: readonly CountryRegionRecord[];
  readonly indicators: readonly IndicatorRecord[];
  readonly birthWeights: readonly BirthWeightRecord[];
  readonly licenses: readonly LicenseRecord[];
  readonly lineage: readonly LineageRecord[];
  readonly sensitiveNames: readonly SensitiveNameRecord[];
  readonly displayNames: DisplayNameMap;
  readonly entityIds: readonly string[];
  readonly enabledEntityIds: readonly string[];
  readonly birthShare: BirthShareMap;
  readonly birthWeightIndex: Readonly<Record<string, BirthWeightRecord>>;
  readonly datasetChecksums: DatasetChecksumMap;
  readonly packChecksum: string;
}

const validatedPacks = new WeakSet<object>();

export function isValidatedDataPack(value: unknown): value is ValidatedDataPack {
  return typeof value === "object" && value !== null && validatedPacks.has(value);
}

const byBytes = (a: string, b: string): number => compareBytes(utf8Encode(a), utf8Encode(b));

export function birthWeightKey(entityId: string, sex: Sex): string {
  return `${entityId}|${sex}`;
}

/* ------------------------------------------------------------------ */
/* checksums                                                          */
/* ------------------------------------------------------------------ */

export function computeDatasetChecksum(envelope: DatasetEnvelope<unknown>): string {
  const payload = {
    schemaVersion: envelope.schemaVersion,
    dataVersion: envelope.dataVersion,
    dataset: envelope.dataset,
    records: envelope.records as unknown as never
  };
  return sha256Hex(canonicalBytes(payload as never));
}

/**
 * manifest canonical projection：除了 `packChecksum` 本身，所有具意義欄位都納入，
 * 包含 packKind、createdAt、engineVersion、rngSpecVersion 與每個 dataset 的 fileName。
 * indicatorIds／licenseSourceIds／datasets 排序後再算，manifest 內排列順序不影響結果。
 */
export function packChecksumProjection(manifest: DataPackManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    dataVersion: manifest.dataVersion,
    packId: manifest.packId,
    packKind: manifest.packKind,
    createdAt: manifest.createdAt,
    engineVersion: manifest.engineVersion,
    rngSpecVersion: manifest.rngSpecVersion,
    entityCount: manifest.entityCount,
    indicatorYear: manifest.indicatorYear,
    indicatorIds: [...manifest.indicatorIds].sort(byBytes),
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

export function computePackChecksum(manifest: DataPackManifest): string {
  return sha256Hex(canonicalBytes(packChecksumProjection(manifest) as never));
}

/* ------------------------------------------------------------------ */
/* validation                                                         */
/* ------------------------------------------------------------------ */

export function validateDataPack(raw: RawDataPack): ValidatedDataPack {
  const root = readExactObject(raw, "pack", ["manifest", "datasets"]);
  const manifest = parseManifest(root.manifest, "pack.manifest");
  const datasetMap = readDatasetsMap(root.datasets, "pack.datasets");

  for (const datasetId of P2A_DATASET_IDS) {
    if (!Object.prototype.hasOwnProperty.call(datasetMap, datasetId)) fail("E_P2A_MISSING_KEY", `pack.datasets.${datasetId}`);
  }
  for (const key of Object.keys(datasetMap)) {
    if (!(P2A_DATASET_IDS as readonly string[]).includes(key)) fail("E_P2A_DATASET_UNKNOWN", `pack.datasets.${key}`);
  }

  const datasetPath = (datasetId: DatasetId): string => `pack.datasets.${datasetId}`;

  if (manifest.engineVersion !== P2A_SUPPORTED_ENGINE_VERSION) fail("E_P2A_ENGINE_VERSION", "pack.manifest.engineVersion");
  if (!isSupportedRngSpecVersion(manifest.rngSpecVersion)) fail("E_P2A_RNG_SPEC_VERSION", "pack.manifest.rngSpecVersion");

  /* --- manifest descriptors ------------------------------------- */
  const descriptors = new Map<DatasetId, DatasetDescriptor>();
  for (let index = 0; index < manifest.datasets.length; index += 1) {
    const descriptor = manifest.datasets[index] as DatasetDescriptor;
    if (descriptors.has(descriptor.datasetId)) fail("E_P2A_DATASET_DUPLICATE", `pack.manifest.datasets[${index}].datasetId`);
    descriptors.set(descriptor.datasetId, descriptor);
  }
  /* 6 個 descriptor 且 datasetId 不得重複，所以缺漏已被上面的 duplicate 檢查擋掉。 */

  /* --- envelopes + checksums ------------------------------------ */
  const registryEnvelope = parseDatasetEnvelope(
    datasetMap["country-registry"],
    "country-registry",
    datasetPath("country-registry"),
    parseCountryRegion,
    P2A_ENTITY_COUNT
  );
  const indicatorEnvelope = parseDatasetEnvelope(
    datasetMap.indicators,
    "indicators",
    datasetPath("indicators"),
    parseIndicator,
    P2A_MAX_INDICATOR_RECORDS
  );
  const birthWeightEnvelope = parseDatasetEnvelope(
    datasetMap["birth-weights"],
    "birth-weights",
    datasetPath("birth-weights"),
    parseBirthWeight,
    P2A_MAX_BIRTH_WEIGHT_RECORDS
  );
  const sensitiveEnvelope = parseDatasetEnvelope(
    datasetMap["sensitive-names"],
    "sensitive-names",
    datasetPath("sensitive-names"),
    (record, path) => parseSensitiveNameRecord(record, path),
    P2A_MAX_SENSITIVE_NAME_RECORDS
  );
  const licenseEnvelope = parseDatasetEnvelope(datasetMap.licenses, "licenses", datasetPath("licenses"), (record, path) => parseLicense(record, path), P2A_MAX_LICENSE_RECORDS);
  const lineageEnvelope = parseDatasetEnvelope(datasetMap.lineage, "lineage", datasetPath("lineage"), (record, path) => parseLineage(record, path), P2A_MAX_LINEAGE_RECORDS);

  const datasetChecksums: Record<string, string> = {};
  const checkEnvelope = (envelope: DatasetEnvelope<unknown>, datasetId: DatasetId): void => {
    const descriptor = descriptors.get(datasetId) as DatasetDescriptor;
    if (envelope.dataVersion !== manifest.dataVersion) fail("E_P2A_DATA_VERSION", `${datasetPath(datasetId)}.dataVersion`);
    if (envelope.records.length !== descriptor.recordCount) fail("E_P2A_RECORD_COUNT", `${datasetPath(datasetId)}.records`);
    const checksum = computeDatasetChecksum(envelope);
    datasetChecksums[datasetId] = checksum;
    if (checksum !== descriptor.checksum) fail("E_P2A_CHECKSUM_MISMATCH", `${datasetPath(datasetId)}.records`);
  };
  checkEnvelope(registryEnvelope, "country-registry");
  checkEnvelope(indicatorEnvelope, "indicators");
  checkEnvelope(birthWeightEnvelope, "birth-weights");
  checkEnvelope(sensitiveEnvelope, "sensitive-names");
  checkEnvelope(licenseEnvelope, "licenses");
  checkEnvelope(lineageEnvelope, "lineage");

  /* --- registry -------------------------------------------------- */
  const registry = registryEnvelope.records;
  if (registry.length !== P2A_ENTITY_COUNT) fail("E_P2A_ENTITY_COUNT", `${datasetPath("country-registry")}.records`);
  const registryById = new Map<string, CountryRegionRecord>();
  for (let index = 0; index < registry.length; index += 1) {
    const record = registry[index] as CountryRegionRecord;
    const path = `${datasetPath("country-registry")}.records[${index}]`;
    /* 解析時已保證 entityId === `cr:` + regionCode，所以 entityId 唯一即 regionCode 唯一。 */
    if (registryById.has(record.entityId)) fail("E_P2A_DUPLICATE_ENTITY", `${path}.entityId`);
    registryById.set(record.entityId, record);
  }

  /* --- sensitive names ------------------------------------------ */
  const sensitiveNames = sensitiveEnvelope.records;
  const sensitiveById = new Map<string, SensitiveNameRecord>();
  for (let index = 0; index < sensitiveNames.length; index += 1) {
    const entry = sensitiveNames[index] as SensitiveNameRecord;
    const path = `${datasetPath("sensitive-names")}.records[${index}]`;
    if (sensitiveById.has(entry.entityId)) fail("E_P2A_SENSITIVE_NAME_DUPLICATED", `${path}.entityId`);
    const entity = registryById.get(entry.entityId);
    if (!entity) fail("E_P2A_UNKNOWN_ENTITY", `${path}.entityId`);
    if (entry.reviewStatus !== "approved") fail("E_P2A_SENSITIVE_NAME_UNREVIEWED", `${path}.reviewStatus`);
    sensitiveById.set(entry.entityId, entry);
  }
  const displayNames: Record<string, string> = {};
  for (const entity of registry) {
    if (entity.sensitiveNameRef === null) {
      if (entity.displayNameZhHans === null) fail("E_P2A_SENSITIVE_NAME_MISSING", `pack.datasets.country-registry.${entity.entityId}`);
      displayNames[entity.entityId] = entity.displayNameZhHans;
      continue;
    }
    if (entity.sensitiveNameRef !== `sn:${entity.regionCode}`) {
      fail("E_P2A_SENSITIVE_NAME_MISSING", `pack.datasets.country-registry.${entity.entityId}`);
    }
    const entry = sensitiveById.get(entity.entityId);
    if (!entry) fail("E_P2A_SENSITIVE_NAME_MISSING", `pack.datasets.country-registry.${entity.entityId}`);
    displayNames[entity.entityId] = entry.displayNameZhHans;
  }
  for (const entry of sensitiveById.keys()) {
    const entity = registryById.get(entry);
    if (!entity || entity.sensitiveNameRef === null) fail("E_P2A_SENSITIVE_NAME_MISSING", `pack.datasets.sensitive-names.${entry}`);
  }

  /* --- licenses (needed by indicators) -------------------------- */
  const licenses = licenseEnvelope.records;
  const licenseBySourceId = new Map<string, LicenseRecord>();
  const licenseByDatasetId = new Map<string, LicenseRecord>();
  for (let index = 0; index < licenses.length; index += 1) {
    const license = licenses[index] as LicenseRecord;
    const path = `${datasetPath("licenses")}.records[${index}]`;
    if (licenseBySourceId.has(license.sourceId)) fail("E_P2A_DUPLICATE_KEY", `${path}.sourceId`);
    if (licenseByDatasetId.has(license.datasetId)) fail("E_P2A_DUPLICATE_KEY", `${path}.datasetId`);
    if (!(P2A_DATA_DATASET_IDS as readonly string[]).includes(license.datasetId)) fail("E_P2A_DATASET_UNKNOWN", `${path}.datasetId`);
    /* descriptor 一定存在（見上面 6 筆檢查），這裡只驗 dataset 種類。 */
    licenseBySourceId.set(license.sourceId, license);
    licenseByDatasetId.set(license.datasetId, license);
  }
  for (const datasetId of P2A_DATA_DATASET_IDS) {
    if (!licenseByDatasetId.has(datasetId)) fail("E_P2A_LICENSE_MISSING", `pack.datasets.${datasetId}`);
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

  /* --- indicators ------------------------------------------------ */
  const indicators = indicatorEnvelope.records;
  const indicatorKeys = new Set<string>();
  const indicatorYear = manifest.indicatorYear;
  for (let index = 0; index < indicators.length; index += 1) {
    const record = indicators[index] as IndicatorRecord;
    const path = `${datasetPath("indicators")}.records[${index}]`;
    const key = `${record.indicatorId}|${record.entityId}`;
    if (indicatorKeys.has(key)) fail("E_P2A_INDICATOR_DUPLICATE", `${path}.entityId`);
    indicatorKeys.add(key);
    if (!(manifest.indicatorIds as readonly string[]).includes(record.indicatorId)) fail("E_P2A_INDICATOR_UNKNOWN", `${path}.indicatorId`);
    if (!registryById.has(record.entityId)) fail("E_P2A_UNKNOWN_ENTITY", `${path}.entityId`);
    if (record.year !== indicatorYear) fail("E_P2A_INDICATOR_YEAR", `${path}.year`);
    const license = licenseBySourceId.get(record.sourceId);
    if (!license) fail("E_P2A_UNKNOWN_SOURCE", `${path}.sourceId`);
    if (license.datasetId !== "indicators") fail("E_P2A_SOURCE_DATASET_MISMATCH", `${path}.sourceId`);
  }
  for (const entity of registry) {
    for (const indicatorId of manifest.indicatorIds) {
      if (!indicatorKeys.has(`${indicatorId}|${entity.entityId}`)) fail("E_P2A_INDICATOR_MISSING", `pack.datasets.indicators.${indicatorId}.${entity.entityId}`);
    }
  }
  const indicatorById = new Map<IndicatorId, Map<string, IndicatorRecord>>();
  for (const record of indicators) {
    const bucket = indicatorById.get(record.indicatorId) ?? new Map<string, IndicatorRecord>();
    bucket.set(record.entityId, record);
    indicatorById.set(record.indicatorId, bucket);
  }
  const shareById = indicatorById.get("birth_share_weight");
  if (!shareById) fail("E_P2A_INDICATOR_MISSING", "pack.datasets.indicators.birth_share_weight");
  for (const entity of registry) {
    if (entity.status !== "enabled") continue;
    assertRecordWeight(shareById.get(entity.entityId)?.value, `pack.datasets.indicators.birth_share_weight.${entity.entityId}`);
  }

  /* --- birth weights -------------------------------------------- */
  const birthWeights = birthWeightEnvelope.records;
  const birthWeightIndex: Record<string, BirthWeightRecord> = {};
  for (let index = 0; index < birthWeights.length; index += 1) {
    const record = birthWeights[index] as BirthWeightRecord;
    const path = `${datasetPath("birth-weights")}.records[${index}]`;
    const key = birthWeightKey(record.entityId, record.sex);
    if (Object.prototype.hasOwnProperty.call(birthWeightIndex, key)) fail("E_P2A_INDICATOR_DUPLICATE", `${path}.entityId`);
    if (!registryById.has(record.entityId)) fail("E_P2A_UNKNOWN_ENTITY", `${path}.entityId`);
    if (record.year !== indicatorYear) fail("E_P2A_INDICATOR_YEAR", `${path}.year`);
    if (record.bands.length !== P2A_BIRTH_WEIGHT_BAND_COUNT) fail("E_P2A_BAND_COUNT", `${path}.bands`);
    const license = licenseBySourceId.get(record.sourceId);
    if (!license) fail("E_P2A_UNKNOWN_SOURCE", `${path}.sourceId`);
    if (license.datasetId !== "birth-weights") fail("E_P2A_SOURCE_DATASET_MISMATCH", `${path}.sourceId`);
    birthWeightIndex[key] = record;
  }
  for (const entity of registry) {
    if (entity.status !== "enabled") continue;
    for (const sex of P2A_SEXES) {
      if (!Object.prototype.hasOwnProperty.call(birthWeightIndex, birthWeightKey(entity.entityId, sex))) {
        fail("E_P2A_INDICATOR_MISSING", `pack.datasets.birth-weights.${entity.entityId}.${sex}`);
      }
    }
  }

  /* --- lineage --------------------------------------------------- */
  const lineage = lineageEnvelope.records;
  const lineageById = new Map<string, LineageRecord>();
  const lineageByDataset = new Map<string, LineageRecord>();
  for (let index = 0; index < lineage.length; index += 1) {
    const record = lineage[index] as LineageRecord;
    const path = `${datasetPath("lineage")}.records[${index}]`;
    if (lineageById.has(record.lineageId)) fail("E_P2A_DUPLICATE_KEY", `${path}.lineageId`);
    if (!(P2A_DATA_DATASET_IDS as readonly string[]).includes(record.datasetId)) fail("E_P2A_DATASET_UNKNOWN", `${path}.datasetId`);
    if (lineageByDataset.has(record.datasetId)) fail("E_P2A_DUPLICATE_KEY", `${path}.datasetId`);
    lineageById.set(record.lineageId, record);
    lineageByDataset.set(record.datasetId, record);
  }
  for (const datasetId of P2A_DATA_DATASET_IDS) {
    if (!lineageByDataset.has(datasetId)) fail("E_P2A_LINEAGE_MISSING", `pack.datasets.lineage.${datasetId}`);
  }

  /* license 只能解析到自己 datasetId 的那一筆 lineage；不得用 find(datasetId) 任取。 */
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

  /* 父節點必須存在，再檢查成環，最後才是一對一的 input checksum 對應。 */
  for (const record of lineage) {
    for (const parentId of record.parentLineageIds) {
      if (!lineageById.has(parentId)) fail("E_P2A_LINEAGE_MISSING", `pack.datasets.lineage.${record.lineageId}.parentLineageIds`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (lineageId: string): void => {
    if (visited.has(lineageId)) return;
    if (visiting.has(lineageId)) fail("E_P2A_LINEAGE_CYCLE", `pack.datasets.lineage.${lineageId}`);
    visiting.add(lineageId);
    const record = lineageById.get(lineageId);
    if (record) for (const parentId of record.parentLineageIds) visit(parentId);
    visiting.delete(lineageId);
    visited.add(lineageId);
  };
  for (const lineageId of lineageById.keys()) visit(lineageId);
  for (const record of lineage) {
    const path = `pack.datasets.lineage.${record.lineageId}`;
    if (record.parentLineageIds.length !== record.inputChecksums.length) fail("E_P2A_LINEAGE_MISMATCH", `${path}.inputChecksums`);
    for (let index = 0; index < record.parentLineageIds.length; index += 1) {
      const parent = lineageById.get(record.parentLineageIds[index] as string) as LineageRecord;
      if (parent.outputChecksum !== record.inputChecksums[index]) fail("E_P2A_LINEAGE_MISMATCH", `${path}.inputChecksums[${index}]`);
    }
  }

  /* --- manifest cross-checks ------------------------------------ */
  const expectedSources = [...licenseBySourceId.keys()].sort(byBytes);
  if (expectedSources.length !== manifest.licenseSourceIds.length || expectedSources.some((sourceId, index) => sourceId !== [...manifest.licenseSourceIds].sort(byBytes)[index])) {
    fail("E_P2A_MANIFEST_MISMATCH", "pack.manifest.licenseSourceIds");
  }
  /* indicator 清單已由「每筆 record 必須在 manifest、每個 manifest id 必須有 record」雙向檢查覆蓋。 */
  if (computePackChecksum(manifest) !== manifest.packChecksum) fail("E_P2A_PACK_CHECKSUM_MISMATCH", "pack.manifest.packChecksum");

  /* --- derived, deterministic maps ------------------------------ */
  const entityIds = registry.map((record) => record.entityId).sort(byBytes);
  const enabledEntityIds = registry
    .filter((record) => record.status === "enabled")
    .map((record) => record.entityId)
    .sort(byBytes);
  if (enabledEntityIds.length === 0) fail("E_P2A_NO_CANDIDATES", "pack.datasets.country-registry");
  const birthShare: Record<string, number> = {};
  for (const entityId of enabledEntityIds) {
    birthShare[entityId] = assertRecordWeight(shareById.get(entityId)?.value, `pack.datasets.indicators.birth_share_weight.${entityId}`);
  }
  /* 169 筆權重的總和一定要用 BigInt 檢查一次，避免之後抽樣才爆。 */
  sumWeights(enabledEntityIds.map((entityId) => birthShare[entityId] as number));

  const pack: ValidatedDataPack = {
    manifest,
    registry,
    indicators,
    birthWeights,
    licenses,
    lineage,
    sensitiveNames,
    displayNames,
    entityIds,
    enabledEntityIds,
    birthShare,
    birthWeightIndex,
    datasetChecksums,
    packChecksum: manifest.packChecksum
  };
  /* 深度凍結：pack、manifest、每筆記錄、陣列、bands、displayNames、birthShare、
     birthWeightIndex、datasetChecksums 全部不可變；驗證後任何外部修改都會拋錯。 */
  deepFreeze(pack);
  validatedPacks.add(pack);
  return pack;
}

/**
 * 遞迴凍結。所有被凍結的物件都是解析時新建的（不參照 raw pack），
 * 所以 raw pack 之後被改動也不會影響已驗證的快照。
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  const record = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) deepFreeze(record[key]);
  return value;
}

/** 給工具用的上限表；測試與產生器都讀同一份。 */
export const P2A_LIMITS = P2A_RECORD_LIMITS;
