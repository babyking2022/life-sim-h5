/**
 * P3-D 死亡資料契約與決定性判定骨架（schema `p3d-1`）。
 *
 * 本批**只做純死亡規則層**：死亡資料契約、pack 驗證、每年的死亡抽選與死因抽選。
 * **不接入** P3-C 年度交易、不改 `p3c-1`／`p3a-1`／`p3b-1` 的任何語義或 Golden。
 *
 * 三條界線：
 * 1. 資料面：manifest／mortality／causes／licenses／lineage 全部 exact-object 驗證，
 *    成功後回傳 branded、deep-frozen、與原始輸入完全獨立的 snapshot。
 * 2. 判定面：`evaluateAnnualDeath` 是純函式，只用既有 Xoshiro／BigInt／canonical／SHA-256；
 *    沒有 `Math.random`、`Date.now`、浮點概率、DOM、storage、network、timer。
 * 3. 版本面：新的 `p3d-1` 契約；健康修正公式有自己的版本號（`P3D_HEALTH_RULE_VERSION`）。
 *
 * 資料全部是 **synthetic**：不含 WHO／World Happiness Report 或任何尚未取得商用確認的來源。
 * 死因只用中性 synthetic id（沒有正式文案）；`sensitivity` 本批只允許 `neutral`。
 */

export const P3D_SCHEMA_VERSION = "p3d-1" as const;
export type P3DSchemaVersion = typeof P3D_SCHEMA_VERSION;

/** 死亡語意版本（抽選規則、死因選擇規則）。 */
export const P3D_DEATH_SPEC_VERSION = "1.0.0" as const;
/** 健康修正公式版本（改公式必須升版，不得在舊版本下偷改語義）。 */
export const P3D_HEALTH_RULE_VERSION = "p3d-health-1.0.0" as const;

export const P3D_ENGINE_VERSION = "0.1.0" as const;
export const P3D_RNG_SPEC_VERSION = "1.0.0" as const;
export const P3D_DATA_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/* ------------------------------------------------------------------ */
/* 基本維度                                                            */
/* ------------------------------------------------------------------ */

export const P3D_MIN_AGE = 0;
export const P3D_MAX_AGE = 120;
/** 0..120 共 121 個年齡。 */
export const P3D_AGE_COUNT = P3D_MAX_AGE - P3D_MIN_AGE + 1;
export const P3D_MIN_HAZARD_PPM = 0;
export const P3D_MAX_HAZARD_PPM = 1_000_000;

export type P3DSex = "female" | "male";
export const P3D_SEXES: readonly P3DSex[] = ["female", "male"];

/** P2-A 的 region class（死因權重用這一層，避免 172×2×bands 的資料量）。 */
export type P3DRegionClass = "asia" | "europe" | "africa" | "americas" | "oceania" | "other";
export const P3D_REGION_CLASSES: readonly P3DRegionClass[] = ["asia", "europe", "africa", "americas", "oceania", "other"];

/** 死亡率表必須剛好覆蓋 P2-A 的 172 個 entity × 2 sex × 121 age。 */
export const P3D_BASE_ENTITY_COUNT = 172;
export const P3D_REQUIRED_MORTALITY_RECORDS = P3D_BASE_ENTITY_COUNT * P3D_SEXES.length * P3D_AGE_COUNT; // 41,624

/* ------------------------------------------------------------------ */
/* 上限（全部固定拒絕，不做靜默截斷）                                   */
/* ------------------------------------------------------------------ */

export const P3D_MAX_MORTALITY_RECORDS = P3D_REQUIRED_MORTALITY_RECORDS;
export const P3D_MAX_CAUSE_REGISTRY_RECORDS = 64;
export const P3D_MAX_CAUSE_WEIGHT_RECORDS = 4096;
export const P3D_MAX_CAUSES_PER_RECORD = 32;
export const P3D_MAX_LICENSE_RECORDS = 64;
export const P3D_MAX_LINEAGE_RECORDS = 256;
export const P3D_MAX_RECORD_WEIGHT = Number.MAX_SAFE_INTEGER;
/** 與 P2-A／P3-B 一致的 u64 定義域上限。 */
export const P3D_MAX_TOTAL_WEIGHT = (1n << 64n) - 1n;
export const P3D_MAX_ID_LENGTH = 64;
export const P3D_MAX_TEXT_LENGTH = 200;

/* ------------------------------------------------------------------ */
/* 資料集與死因 registry                                                */
/* ------------------------------------------------------------------ */

export const P3D_DATASET_IDS = ["cause-registry", "cause-weights", "mortality", "licenses", "lineage"] as const;
export type P3DDatasetId = (typeof P3D_DATASET_IDS)[number];
/** 內容資料集（不含 licenses／lineage）：每個都必須有對應授權與 lineage。 */
export const P3D_CONTENT_DATASET_IDS: readonly P3DDatasetId[] = ["cause-registry", "cause-weights", "mortality"];

/** 本批只允許中性 synthetic 死因；敏感內容要另外走內容審核批次。 */
export type P3DSensitivity = "neutral";
export const P3D_SENSITIVITIES: readonly P3DSensitivity[] = ["neutral"];

export interface P3DCauseDefinition {
  readonly causeId: string;
  /** 只有 localization key，不得是文案。 */
  readonly labelKey: string;
  readonly sensitivity: P3DSensitivity;
  /** 是否可出現在分享卡（本批只記錄旗標，不實作分享）。 */
  readonly shareSafe: boolean;
}

/** 固定死因 registry（中性、synthetic、無正式文案）。 */
export const P3D_CAUSE_REGISTRY: readonly P3DCauseDefinition[] = [
  { causeId: "cause.neutral.circulatory", labelKey: "p3d.cause.neutral.circulatory", sensitivity: "neutral", shareSafe: true },
  { causeId: "cause.neutral.respiratory", labelKey: "p3d.cause.neutral.respiratory", sensitivity: "neutral", shareSafe: true },
  { causeId: "cause.neutral.infection", labelKey: "p3d.cause.neutral.infection", sensitivity: "neutral", shareSafe: true },
  { causeId: "cause.neutral.neoplasm", labelKey: "p3d.cause.neutral.neoplasm", sensitivity: "neutral", shareSafe: false },
  { causeId: "cause.neutral.neurological", labelKey: "p3d.cause.neutral.neurological", sensitivity: "neutral", shareSafe: false },
  { causeId: "cause.neutral.digestive", labelKey: "p3d.cause.neutral.digestive", sensitivity: "neutral", shareSafe: true },
  { causeId: "cause.neutral.external", labelKey: "p3d.cause.neutral.external", sensitivity: "neutral", shareSafe: false },
  { causeId: "cause.neutral.other", labelKey: "p3d.cause.neutral.other", sensitivity: "neutral", shareSafe: true }
];

export const P3D_CAUSE_IDS: readonly string[] = P3D_CAUSE_REGISTRY.map((entry) => entry.causeId);

/* ------------------------------------------------------------------ */
/* 資料紀錄                                                            */
/* ------------------------------------------------------------------ */

export interface P3DMortalityRecord {
  readonly entityId: string;
  readonly sex: P3DSex;
  readonly age: number;
  /** 0–1,000,000 的安全整數（ppm）。 */
  readonly hazardPpm: number;
}

export interface P3DCauseWeightEntry {
  readonly causeId: string;
  readonly weight: number;
}

export interface P3DCauseWeightRecord {
  readonly regionClass: P3DRegionClass;
  readonly sex: P3DSex;
  readonly ageBandMin: number;
  readonly ageBandMax: number;
  readonly causes: readonly P3DCauseWeightEntry[];
}

export interface P3DCauseRegistryRecord {
  readonly causeId: string;
  readonly labelKey: string;
  readonly sensitivity: P3DSensitivity;
  readonly shareSafe: boolean;
}

/* ------------------------------------------------------------------ */
/* manifest                                                            */
/* ------------------------------------------------------------------ */

export interface P3DDatasetDescriptor {
  readonly datasetId: P3DDatasetId;
  readonly fileName: string;
  readonly recordCount: number;
  readonly checksum: string;
}

export interface P3DDeathPackManifest {
  readonly schemaVersion: P3DSchemaVersion;
  readonly deathPackId: string;
  readonly deathDataVersion: string;
  readonly deathSpecVersion: string;
  readonly packKind: "synthetic";
  readonly createdAt: string;
  readonly engineVersion: string;
  readonly rngSpecVersion: string;
  /** 綁定的 P2-A base pack；驗證時必須與傳入的 validated base pack 一致。 */
  readonly basePackId: string;
  readonly basePackChecksum: string;
  readonly entityCount: number;
  readonly datasets: readonly P3DDatasetDescriptor[];
  readonly licenses: readonly unknown[];
  readonly lineage: readonly unknown[];
  readonly packChecksum: string;
}

/* ------------------------------------------------------------------ */
/* 判定結果                                                            */
/* ------------------------------------------------------------------ */

export interface P3DAnnualDeathInput {
  readonly entityId: string;
  readonly regionCode: string;
  readonly sex: P3DSex;
  readonly age: number;
  readonly calendarYear: number;
  /** 0–100 的整數；越高越健康。 */
  readonly health: number;
  readonly rngState: readonly [number, number, number, number];
}

export interface P3DAnnualDeathResult {
  readonly entityId: string;
  readonly regionCode: string;
  readonly regionClass: P3DRegionClass;
  readonly sex: P3DSex;
  readonly age: number;
  readonly calendarYear: number;
  readonly health: number;
  readonly baseHazardPpm: number;
  readonly adjustedHazardPpm: number;
  readonly healthFactorPpm: number;
  readonly died: boolean;
  readonly causeId: string | null;
  /** 均勻抽樣值（0 ≤ draw < 1,000,000），十進位字串避免 BigInt 序列化問題。 */
  readonly mortalityDraw: string;
  readonly rngStateBefore: readonly [number, number, number, number];
  readonly rngStateAfter: readonly [number, number, number, number];
  /** 實際推進的 u32 次數（每次 u64 抽樣 = 2 次）。 */
  readonly drawsUsed: number;
  readonly digest: string;
  readonly deathSpecVersion: string;
  readonly healthRuleVersion: string;
  readonly deathPackId: string;
  readonly deathPackChecksum: string;
  readonly basePackId: string;
  readonly basePackChecksum: string;
}

/* ------------------------------------------------------------------ */
/* 固定錯誤碼                                                          */
/* ------------------------------------------------------------------ */

export type P3DErrorCode =
  | "E_P3D_TYPE"
  | "E_P3D_MISSING_KEY"
  | "E_P3D_UNKNOWN_KEY"
  | "E_P3D_PROTOTYPE_KEY"
  | "E_P3D_SCHEMA_VERSION"
  | "E_P3D_VERSIONS"
  | "E_P3D_PATTERN"
  | "E_P3D_RANGE"
  | "E_P3D_ENUM"
  | "E_P3D_DUPLICATE"
  | "E_P3D_COVERAGE"
  | "E_P3D_CHECKSUM"
  | "E_P3D_LICENSE"
  | "E_P3D_LINEAGE"
  | "E_P3D_BASE_PACK"
  | "E_P3D_ENTITY"
  | "E_P3D_AGE_BAND"
  | "E_P3D_CAUSE"
  | "E_P3D_WEIGHT"
  | "E_P3D_PACK"
  | "E_P3D_STATE"
  | "E_P3D_RNG"
  | "E_P3D_CONTENT";

export const P3D_ERROR_CODES: readonly P3DErrorCode[] = [
  "E_P3D_TYPE",
  "E_P3D_MISSING_KEY",
  "E_P3D_UNKNOWN_KEY",
  "E_P3D_PROTOTYPE_KEY",
  "E_P3D_SCHEMA_VERSION",
  "E_P3D_VERSIONS",
  "E_P3D_PATTERN",
  "E_P3D_RANGE",
  "E_P3D_ENUM",
  "E_P3D_DUPLICATE",
  "E_P3D_COVERAGE",
  "E_P3D_CHECKSUM",
  "E_P3D_LICENSE",
  "E_P3D_LINEAGE",
  "E_P3D_BASE_PACK",
  "E_P3D_ENTITY",
  "E_P3D_AGE_BAND",
  "E_P3D_CAUSE",
  "E_P3D_WEIGHT",
  "E_P3D_PACK",
  "E_P3D_STATE",
  "E_P3D_RNG",
  "E_P3D_CONTENT"
];
