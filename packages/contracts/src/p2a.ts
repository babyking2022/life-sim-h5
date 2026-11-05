/**
 * P2-A 出生資料契約（schema `p2a-1`）。
 *
 * 這一層只定義形狀、版本規則、上限與錯誤碼字串；不讀檔、不驗證內容、
 * 不做抽選。執行期驗證在 `@life-sim/birth`，抽選在 `drawBirth`。
 *
 * 版本規則：
 * - `schemaVersion`：記錄形狀（欄位、列舉、單位）。形狀一旦改變就要升版；
 *   載入器只接受 `P2A_SCHEMA_VERSION`，其他值為 `E_P2A_SCHEMA_VERSION`。
 * - `dataVersion`：資料內容（數值、筆數）。必須是 `主.次.修`；主版本必須是
 *   `SUPPORTED_DATA_MAJOR`，且 manifest、每個 dataset、每筆記錄都要一致。
 * - `rngSpecVersion`：ADR-002 的 RNG 規格版本；本批只支援 `1.0.0`。
 */

export const P2A_SCHEMA_VERSION = "p2a-1" as const;
export type P2ASchemaVersion = typeof P2A_SCHEMA_VERSION;

/** 172 個國家與地區：這是 G1 之後的產品規格，不是本批的統計值。 */
export const P2A_ENTITY_COUNT = 172;

export const P2A_DATA_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** 本版驗證器支援的 engine 版本；engine 升版時要一起更新。 */
export const P2A_SUPPORTED_ENGINE_VERSION = "0.1.0" as const;
export const SUPPORTED_DATA_MAJOR = 1;

/** 每筆權重的安全上限：JS number 只能精確表示到 2^53-1。 */
export const P2A_MAX_RECORD_WEIGHT = Number.MAX_SAFE_INTEGER;
/** 權重總和上限：ADR-002 的 uniformBigInt 定義域是 1..2^64。 */
export const P2A_MAX_TOTAL_WEIGHT = (1n << 64n) - 1n;

export const P2A_MAX_INDICATOR_RECORDS = 4096;
export const P2A_MAX_BIRTH_WEIGHT_RECORDS = 4096;
export const P2A_MAX_LICENSE_RECORDS = 64;
export const P2A_MAX_LINEAGE_RECORDS = 256;
export const P2A_MAX_SENSITIVE_NAME_RECORDS = 32;

export const P2A_WEIGHT_PPM_TOTAL = 1_000_000;
export const P2A_BIRTH_WEIGHT_BAND_COUNT = 5;

export type RegionClass = "asia" | "europe" | "africa" | "americas" | "oceania" | "other";
export const P2A_REGION_CLASSES: readonly RegionClass[] = ["asia", "europe", "africa", "americas", "oceania", "other"];

export type EntityStatus = "enabled" | "disabled";
export const P2A_ENTITY_STATUSES: readonly EntityStatus[] = ["enabled", "disabled"];

export type Sex = "female" | "male";
export const P2A_SEXES: readonly Sex[] = ["female", "male"];

export type IndicatorSex = Sex | "total";

export type IndicatorUnit = "relative_weight" | "rate_ppm" | "gram";
export type IndicatorId = "birth_share_weight" | "underweight_rate_ppm";

export interface IndicatorDefinition {
  readonly indicatorId: IndicatorId;
  readonly unit: IndicatorUnit;
  readonly sex: IndicatorSex;
  readonly min: number;
  readonly max: number;
  readonly description: string;
}

/**
 * indicator 的單位、性別與值域在契約層固定；資料層只能照這個表填。
 * `birth_share_weight` 是 172 國／地區的相對出生權重（整數），
 * `underweight_rate_ppm` 是低出生體重率（百萬分率），P2-A 只驗證不使用。
 */
export const P2A_INDICATOR_DEFINITIONS: Readonly<Record<IndicatorId, IndicatorDefinition>> = {
  birth_share_weight: {
    indicatorId: "birth_share_weight",
    unit: "relative_weight",
    sex: "total",
    min: 0,
    max: P2A_MAX_RECORD_WEIGHT,
    description: "relative birth share weight, integer, used by the deterministic birth draw"
  },
  underweight_rate_ppm: {
    indicatorId: "underweight_rate_ppm",
    unit: "rate_ppm",
    sex: "total",
    min: 0,
    max: P2A_WEIGHT_PPM_TOTAL,
    description: "low birth weight rate in parts per million"
  }
};

export const P2A_INDICATOR_IDS: readonly IndicatorId[] = ["birth_share_weight", "underweight_rate_ppm"];

/* ------------------------------------------------------------------ */
/* license                                                            */
/* ------------------------------------------------------------------ */

export type LicenseState = "granted" | "permission_required" | "not_allowed" | "unknown";
export type CommercialUse = "allowed" | "not_allowed" | "unknown";
export type LegalStatus = "cleared" | "pending" | "rejected" | "unknown";
export type SourceKind = "synthetic" | "official" | "research" | "aggregator";

export const P2A_LICENSE_STATES: readonly LicenseState[] = ["granted", "permission_required", "not_allowed", "unknown"];
export const P2A_COMMERCIAL_USES: readonly CommercialUse[] = ["allowed", "not_allowed", "unknown"];
export const P2A_LEGAL_STATUSES: readonly LegalStatus[] = ["cleared", "pending", "rejected", "unknown"];
export const P2A_SOURCE_KINDS: readonly SourceKind[] = ["synthetic", "official", "research", "aggregator"];

export interface LicenseGrant {
  readonly granted: boolean;
  readonly evidence: string;
  readonly grantedAt: string;
}

export interface LicenseRecord {
  readonly sourceId: string;
  readonly datasetId: string;
  readonly datasetLabel: string;
  readonly sourceKind: SourceKind;
  readonly sourceName: string;
  readonly sourceUrl: string | null;
  readonly version: string;
  readonly retrievedAt: string;
  readonly license: LicenseState;
  readonly licenseId: string | null;
  readonly commercialUse: CommercialUse;
  readonly legalStatus: LegalStatus;
  readonly evidence: readonly string[];
  readonly grant: LicenseGrant | null;
  readonly checksum: string;
  readonly lineageId: string;
  readonly notes: string;
}

/* ------------------------------------------------------------------ */
/* records                                                            */
/* ------------------------------------------------------------------ */

export interface CountryRegionRecord {
  readonly entityId: string;
  readonly iso3: string | null;
  readonly regionCode: string;
  readonly displayNameZhHans: string | null;
  readonly sensitiveNameRef: string | null;
  readonly region: RegionClass;
  readonly status: EntityStatus;
  readonly dataVersion: string;
}

export interface IndicatorRecord {
  readonly indicatorId: IndicatorId;
  readonly entityId: string;
  readonly year: number;
  readonly sex: IndicatorSex;
  readonly unit: IndicatorUnit;
  readonly value: number;
  readonly sourceId: string;
  readonly dataVersion: string;
}

export interface BirthWeightBand {
  readonly bandId: string;
  readonly minGrams: number;
  readonly maxGrams: number;
  readonly weightPpm: number;
}

export interface BirthWeightRecord {
  readonly entityId: string;
  readonly sex: Sex;
  readonly year: number;
  readonly meanGrams: number;
  readonly sdGrams: number;
  readonly bands: readonly BirthWeightBand[];
  readonly sourceId: string;
  readonly dataVersion: string;
}

export interface LineageRecord {
  readonly lineageId: string;
  readonly datasetId: string;
  readonly parentLineageIds: readonly string[];
  readonly transform: string;
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly inputChecksums: readonly string[];
  readonly outputChecksum: string;
  readonly notes: string;
}

export type SensitiveNameReviewStatus = "approved" | "pending" | "rejected";

export interface SensitiveNameRecord {
  readonly entityId: string;
  readonly displayNameZhHans: string;
  readonly reviewStatus: SensitiveNameReviewStatus;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly note: string;
}

export interface SensitiveNameTable {
  readonly schemaVersion: P2ASchemaVersion;
  readonly dataVersion: string;
  readonly entries: readonly SensitiveNameRecord[];
}

/* ------------------------------------------------------------------ */
/* datasets / manifest                                                */
/* ------------------------------------------------------------------ */

export const P2A_DATASET_IDS = [
  "country-registry",
  "indicators",
  "birth-weights",
  "sensitive-names",
  "licenses",
  "lineage"
] as const;

export type DatasetId = (typeof P2A_DATASET_IDS)[number];

export const P2A_DATA_DATASET_IDS: readonly DatasetId[] = ["country-registry", "indicators", "birth-weights", "sensitive-names"];

export interface DatasetDescriptor {
  readonly datasetId: DatasetId;
  readonly fileName: string;
  readonly recordCount: number;
  readonly checksum: string;
}

export interface DataPackManifest {
  readonly schemaVersion: P2ASchemaVersion;
  readonly dataVersion: string;
  readonly packId: string;
  readonly packKind: "synthetic" | "official";
  readonly createdAt: string;
  readonly engineVersion: string;
  readonly rngSpecVersion: string;
  readonly entityCount: number;
  readonly indicatorYear: number;
  readonly indicatorIds: readonly IndicatorId[];
  readonly licenseSourceIds: readonly string[];
  readonly datasets: readonly DatasetDescriptor[];
  readonly packChecksum: string;
}

/** 每個 dataset 檔案的共同外殼；`records` 的內容依 datasetId 不同。 */
export interface DatasetEnvelope<T> {
  readonly schemaVersion: P2ASchemaVersion;
  readonly dataVersion: string;
  readonly dataset: DatasetId;
  readonly records: readonly T[];
}

/* ------------------------------------------------------------------ */
/* draw                                                               */
/* ------------------------------------------------------------------ */

export type SexPolicy = "random" | "female" | "male";

export interface BirthDrawSettings {
  readonly birthYear: number;
  readonly sexPolicy: SexPolicy;
}

export interface BirthDrawInput {
  readonly seed: string;
  readonly settings: BirthDrawSettings;
}

export interface RngCursorSnapshot {
  readonly state: readonly [number, number, number, number];
  readonly draws: number;
}

export interface BirthDraft {
  readonly schemaVersion: P2ASchemaVersion;
  readonly dataVersion: string;
  readonly entityId: string;
  readonly regionCode: string;
  readonly region: RegionClass;
  readonly displayNameZhHans: string;
  readonly sex: Sex;
  readonly birthYear: number;
  readonly weightBandId: string;
  readonly weightGrams: number;
  readonly weightBandIndex: number;
  readonly rng: RngCursorSnapshot;
  readonly drawHash: string;
}

/* ------------------------------------------------------------------ */
/* error codes                                                        */
/* ------------------------------------------------------------------ */

/**
 * 固定錯誤碼。測試與 UI 只依賴 code；message 只作除錯，不含時間或隨機值。
 */
export type P2AErrorCode =
  | "E_P2A_SCHEMA_VERSION"
  | "E_P2A_DATA_VERSION"
  | "E_P2A_TYPE"
  | "E_P2A_MISSING_KEY"
  | "E_P2A_UNKNOWN_KEY"
  | "E_P2A_ENUM"
  | "E_P2A_PATTERN"
  | "E_P2A_RANGE"
  | "E_P2A_DUPLICATE_ENTITY"
  | "E_P2A_DUPLICATE_KEY"
  | "E_P2A_UNKNOWN_ENTITY"
  | "E_P2A_ENTITY_COUNT"
  | "E_P2A_REGISTRY_CODE"
  | "E_P2A_SENSITIVE_NAME_MISSING"
  | "E_P2A_SENSITIVE_NAME_UNREVIEWED"
  | "E_P2A_SENSITIVE_NAME_DUPLICATED"
  | "E_P2A_CAPACITY"
  | "E_P2A_WEIGHT_ZERO"
  | "E_P2A_WEIGHT_NEGATIVE"
  | "E_P2A_WEIGHT_OVERFLOW"
  | "E_P2A_WEIGHT_TOTAL_OVERFLOW"
  | "E_P2A_NO_CANDIDATES"
  | "E_P2A_INDICATOR_UNIT"
  | "E_P2A_INDICATOR_YEAR"
  | "E_P2A_INDICATOR_SEX"
  | "E_P2A_INDICATOR_UNKNOWN"
  | "E_P2A_INDICATOR_MISSING"
  | "E_P2A_INDICATOR_DUPLICATE"
  | "E_P2A_BAND_ORDER"
  | "E_P2A_BAND_OVERLAP"
  | "E_P2A_BAND_WEIGHT_TOTAL"
  | "E_P2A_BAND_COUNT"
  | "E_P2A_UNKNOWN_SOURCE"
  | "E_P2A_SOURCE_DATASET_MISMATCH"
  | "E_P2A_LICENSE_UNKNOWN"
  | "E_P2A_LICENSE_NOT_ALLOWED"
  | "E_P2A_LICENSE_PERMISSION_MISSING"
  | "E_P2A_LICENSE_EVIDENCE_MISSING"
  | "E_P2A_LICENSE_LEGAL_PENDING"
  | "E_P2A_LICENSE_COMMERCIAL_BLOCKED"
  | "E_P2A_LICENSE_CHECKSUM_MISMATCH"
  | "E_P2A_LICENSE_MISSING"
  | "E_P2A_INDICATOR_COVERAGE"
  | "E_P2A_BAND_RANGE"
  | "E_P2A_LINEAGE_MISSING"
  | "E_P2A_LINEAGE_MISMATCH"
  | "E_P2A_LINEAGE_CYCLE"
  | "E_P2A_CHECKSUM_MISMATCH"
  | "E_P2A_MANIFEST_MISMATCH"
  | "E_P2A_PACK_CHECKSUM_MISMATCH"
  | "E_P2A_PACK_NOT_VALIDATED"
  | "E_P2A_ENGINE_VERSION"
  | "E_P2A_RNG_SPEC_VERSION"
  | "E_P2A_DATASET_UNKNOWN"
  | "E_P2A_DATASET_DUPLICATE"
  | "E_P2A_RECORD_COUNT"
  | "E_P2A_PACK_KIND"
  | "E_P2A_YEAR_UNSUPPORTED"
  | "E_P2A_SEX_POLICY"
  | "E_P2A_SEED";

export const P2A_ERROR_CODES: readonly P2AErrorCode[] = [
  "E_P2A_SCHEMA_VERSION",
  "E_P2A_DATA_VERSION",
  "E_P2A_TYPE",
  "E_P2A_MISSING_KEY",
  "E_P2A_UNKNOWN_KEY",
  "E_P2A_ENUM",
  "E_P2A_PATTERN",
  "E_P2A_RANGE",
  "E_P2A_DUPLICATE_ENTITY",
  "E_P2A_DUPLICATE_KEY",
  "E_P2A_UNKNOWN_ENTITY",
  "E_P2A_ENTITY_COUNT",
  "E_P2A_REGISTRY_CODE",
  "E_P2A_SENSITIVE_NAME_MISSING",
  "E_P2A_SENSITIVE_NAME_UNREVIEWED",
  "E_P2A_SENSITIVE_NAME_DUPLICATED",
  "E_P2A_CAPACITY",
  "E_P2A_WEIGHT_ZERO",
  "E_P2A_WEIGHT_NEGATIVE",
  "E_P2A_WEIGHT_OVERFLOW",
  "E_P2A_WEIGHT_TOTAL_OVERFLOW",
  "E_P2A_NO_CANDIDATES",
  "E_P2A_INDICATOR_UNIT",
  "E_P2A_INDICATOR_YEAR",
  "E_P2A_INDICATOR_SEX",
  "E_P2A_INDICATOR_UNKNOWN",
  "E_P2A_INDICATOR_MISSING",
  "E_P2A_INDICATOR_DUPLICATE",
  "E_P2A_BAND_ORDER",
  "E_P2A_BAND_OVERLAP",
  "E_P2A_BAND_WEIGHT_TOTAL",
  "E_P2A_BAND_COUNT",
  "E_P2A_UNKNOWN_SOURCE",
  "E_P2A_SOURCE_DATASET_MISMATCH",
  "E_P2A_LICENSE_UNKNOWN",
  "E_P2A_LICENSE_NOT_ALLOWED",
  "E_P2A_LICENSE_PERMISSION_MISSING",
  "E_P2A_LICENSE_EVIDENCE_MISSING",
  "E_P2A_LICENSE_LEGAL_PENDING",
  "E_P2A_LICENSE_COMMERCIAL_BLOCKED",
  "E_P2A_LICENSE_CHECKSUM_MISMATCH",
  "E_P2A_LICENSE_MISSING",
  "E_P2A_INDICATOR_COVERAGE",
  "E_P2A_BAND_RANGE",
  "E_P2A_LINEAGE_MISSING",
  "E_P2A_LINEAGE_MISMATCH",
  "E_P2A_LINEAGE_CYCLE",
  "E_P2A_CHECKSUM_MISMATCH",
  "E_P2A_MANIFEST_MISMATCH",
  "E_P2A_PACK_CHECKSUM_MISMATCH",
  "E_P2A_PACK_NOT_VALIDATED",
  "E_P2A_ENGINE_VERSION",
  "E_P2A_RNG_SPEC_VERSION",
  "E_P2A_DATASET_UNKNOWN",
  "E_P2A_DATASET_DUPLICATE",
  "E_P2A_RECORD_COUNT",
  "E_P2A_PACK_KIND",
  "E_P2A_YEAR_UNSUPPORTED",
  "E_P2A_SEX_POLICY",
  "E_P2A_SEED"
];
