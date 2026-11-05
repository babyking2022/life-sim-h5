/**
 * P3-B 事件資料契約（schema `p3b-1`，event spec `1.0.0`）。
 *
 * 這一層只定義形狀、列舉、上限與錯誤碼；不讀檔、不驗證內容、不做抽選。
 * 執行期驗證與抽選在 `packages/engine/src/life/events/**`。
 *
 * 版本規則（與 P2-A 一致的精神）：
 * - `schemaVersion`：欄位形狀；只接受 `P3B_SCHEMA_VERSION` → 否則 `E_P3B_VERSIONS`。
 * - `eventSpecVersion`：事件語義（條件／效果／抽選規則）；只接受 `P3B_EVENT_SPEC_VERSION`。
 * - `contentPackVersion`：內容包版本（`主.次.修`）；由 pack manifest 指定，每筆事件必須一致。
 * - `rngSpecVersion`：ADR-002 的 RNG 規格；本批只支援 `1.0.0`。
 *
 * 文字一律只存 `localizationKey`，不得直接保存抄錄文案。
 */

export const P3B_SCHEMA_VERSION = "p3b-1" as const;
export type P3BSchemaVersion = typeof P3B_SCHEMA_VERSION;
export const P3B_EVENT_SPEC_VERSION = "1.0.0" as const;
export const P3B_CONTENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const P3B_ENGINE_VERSION = "0.1.0" as const;
export const P3B_RNG_SPEC_VERSION = "1.0.0" as const;

/** 容量上限：所有上限都會在驗證時固定拒絕，避免超大輸入。 */
export const P3B_MAX_EVENTS = 4096;
export const P3B_MAX_DECISION_OPTIONS = 5;
export const P3B_MAX_EFFECTS_PER_EVENT = 16;
export const P3B_MAX_EFFECTS_PER_OPTION = 8;
export const P3B_MAX_CONDITION_DEPTH = 8;
export const P3B_MAX_CONDITION_NODES = 64;
export const P3B_MAX_LICENSE_RECORDS = 64;
export const P3B_MAX_LINEAGE_RECORDS = 128;
export const P3B_MAX_FLAG_LENGTH = 64;
export const P3B_MAX_ID_LENGTH = 64;
export const P3B_MAX_LOCALIZATION_KEY_LENGTH = 160;

/** 權重：安全整數且 ≥ 1；總和必須 ≤ 2^64-1（ADR-002 的 uniformBigInt 定義域）。 */
export const P3B_MAX_WEIGHT = Number.MAX_SAFE_INTEGER;
export const P3B_MAX_TOTAL_WEIGHT = (1n << 64n) - 1n;

export const P3B_MIN_AGE = 0;
export const P3B_MAX_AGE = 120;

export type P3BEventKind = "ordinary" | "decision" | "milestone";
export const P3B_EVENT_KINDS: readonly P3BEventKind[] = ["ordinary", "decision", "milestone"];

/**
 * 內容模式：`guardian` 表示「守護模式也允許」（最嚴格仍可用）；
 * `standard` 表示「只在標準模式出現」。守護模式會完全排除 `standard` 內容。
 */
export type P3BContentMode = "standard" | "guardian";
export const P3B_CONTENT_MODES: readonly P3BContentMode[] = ["standard", "guardian"];

export type P3BLifeStage = "childhood" | "adolescence" | "adulthood" | "later_life";
export const P3B_LIFE_STAGES: readonly P3BLifeStage[] = ["childhood", "adolescence", "adulthood", "later_life"];
/** 人生階段邊界（含頭含尾）；與 P3-A 的抉擇年齡 6／12／18 不衝突。 */
export const P3B_STAGE_BOUNDS: Readonly<Record<P3BLifeStage, { readonly min: number; readonly max: number }>> = {
  childhood: { min: 0, max: 12 },
  adolescence: { min: 13, max: 17 },
  adulthood: { min: 18, max: 64 },
  later_life: { min: 65, max: 120 }
};

export type P3BStatKey = "health" | "happiness" | "knowledge" | "relationships";
export const P3B_STAT_KEYS: readonly P3BStatKey[] = ["health", "happiness", "knowledge", "relationships"];
export type P3BMoneyField = "balanceMicroUsd" | "annualIncomeMicroUsd" | "annualExpenseMicroUsd";
export const P3B_MONEY_FIELDS: readonly P3BMoneyField[] = ["balanceMicroUsd", "annualIncomeMicroUsd", "annualExpenseMicroUsd"];

export type P3BPhase = "life" | "pending_decision" | "death" | "error";
export const P3B_PHASES: readonly P3BPhase[] = ["life", "pending_decision", "death", "error"];

/* ------------------------------------------------------------------ */
/* 條件 DSL（白名單、可序列化、無 callback）                            */
/* ------------------------------------------------------------------ */

export type P3BConditionOp = "all" | "any" | "not" | "age" | "phase" | "stat" | "money" | "flag" | "happened" | "cooldown" | "contentMode";
export const P3B_CONDITION_OPS: readonly P3BConditionOp[] = [
  "all",
  "any",
  "not",
  "age",
  "phase",
  "stat",
  "money",
  "flag",
  "happened",
  "cooldown",
  "contentMode"
];

export interface P3BConditionAll {
  readonly op: "all";
  readonly conditions: readonly P3BCondition[];
}
export interface P3BConditionAny {
  readonly op: "any";
  readonly conditions: readonly P3BCondition[];
}
export interface P3BConditionNot {
  readonly op: "not";
  readonly condition: P3BCondition;
}
export interface P3BConditionAge {
  readonly op: "age";
  readonly min: number;
  readonly max: number;
}
export interface P3BConditionPhase {
  readonly op: "phase";
  readonly phase: P3BPhase;
}
export interface P3BConditionStat {
  readonly op: "stat";
  readonly stat: P3BStatKey;
  readonly min: number;
  readonly max: number;
}
export interface P3BConditionMoney {
  readonly op: "money";
  readonly field: P3BMoneyField;
  /** 十進位整數字串（可負），與 MoneyString 同一格式。 */
  readonly min: string;
  readonly max: string;
}
export interface P3BConditionFlag {
  readonly op: "flag";
  readonly flag: string;
  readonly present: boolean;
}
export interface P3BConditionHappened {
  readonly op: "happened";
  readonly eventId: string;
}
export interface P3BConditionCooldown {
  readonly op: "cooldown";
  readonly eventId: string;
  readonly years: number;
}
export interface P3BConditionContentMode {
  readonly op: "contentMode";
  readonly mode: P3BContentMode;
}

export type P3BCondition =
  | P3BConditionAll
  | P3BConditionAny
  | P3BConditionNot
  | P3BConditionAge
  | P3BConditionPhase
  | P3BConditionStat
  | P3BConditionMoney
  | P3BConditionFlag
  | P3BConditionHappened
  | P3BConditionCooldown
  | P3BConditionContentMode;

/* ------------------------------------------------------------------ */
/* typed effects                                                      */
/* ------------------------------------------------------------------ */

export type P3BEffectType = "stat" | "money" | "flag" | "openDecision" | "informational";
export const P3B_EFFECT_TYPES: readonly P3BEffectType[] = ["stat", "money", "flag", "openDecision", "informational"];

export interface P3BEffectStat {
  readonly type: "stat";
  readonly stat: P3BStatKey;
  readonly delta: number;
}
export interface P3BEffectMoney {
  readonly type: "money";
  readonly field: P3BMoneyField;
  /** 十進位整數字串（可負）；套用時走 money module 與 BigInt。 */
  readonly deltaMicroUsd: string;
}
export interface P3BEffectFlag {
  readonly type: "flag";
  readonly flag: string;
  readonly action: "add" | "remove";
}
export interface P3BEffectOpenDecision {
  readonly type: "openDecision";
  readonly decisionId: string;
}
export interface P3BEffectInformational {
  readonly type: "informational";
}

export type P3BEffect = P3BEffectStat | P3BEffectMoney | P3BEffectFlag | P3BEffectOpenDecision | P3BEffectInformational;

/* ------------------------------------------------------------------ */
/* 抉擇                                                                */
/* ------------------------------------------------------------------ */

export interface P3BDecisionOption {
  readonly optionId: string;
  readonly labelKey: string;
  readonly effects: readonly P3BEffect[];
}
export interface P3BDecisionSpec {
  readonly decisionId: string;
  readonly promptKey: string;
  readonly options: readonly P3BDecisionOption[];
}

/* ------------------------------------------------------------------ */
/* 事件紀錄                                                            */
/* ------------------------------------------------------------------ */

export interface P3BEventRecord {
  readonly eventId: string;
  readonly eventSpecVersion: string;
  readonly contentPackVersion: string;
  readonly kind: P3BEventKind;
  readonly localizationKey: string;
  readonly ageMin: number;
  readonly ageMax: number;
  readonly lifeStages: readonly P3BLifeStage[];
  readonly conditions: P3BCondition | null;
  readonly weight: number;
  readonly priority: number;
  readonly once: boolean;
  readonly cooldownYears: number;
  readonly exclusiveGroup: string | null;
  readonly contentMode: P3BContentMode;
  readonly effects: readonly P3BEffect[];
  readonly decision: P3BDecisionSpec | null;
  readonly sourceId: string;
}

/* ------------------------------------------------------------------ */
/* 授權／lineage（與 P2 同一精神，但 dataset 固定為 events）             */
/* ------------------------------------------------------------------ */

export type P3BLicenseState = "granted" | "permission_required" | "not_allowed" | "unknown";
export type P3BCommercialUse = "allowed" | "not_allowed" | "unknown";
export type P3BLegalStatus = "cleared" | "pending" | "rejected" | "unknown";
export type P3BSourceKind = "synthetic" | "official" | "research" | "aggregator";

export const P3B_LICENSE_STATES: readonly P3BLicenseState[] = ["granted", "permission_required", "not_allowed", "unknown"];
export const P3B_COMMERCIAL_USES: readonly P3BCommercialUse[] = ["allowed", "not_allowed", "unknown"];
export const P3B_LEGAL_STATUSES: readonly P3BLegalStatus[] = ["cleared", "pending", "rejected", "unknown"];
export const P3B_SOURCE_KINDS: readonly P3BSourceKind[] = ["synthetic", "official", "research", "aggregator"];

export interface P3BLicenseGrant {
  readonly granted: boolean;
  readonly evidence: string;
  readonly grantedAt: string;
}

export interface P3BLicenseRecord {
  readonly sourceId: string;
  readonly datasetId: "events";
  readonly datasetLabel: string;
  readonly sourceKind: P3BSourceKind;
  readonly sourceName: string;
  readonly sourceUrl: string | null;
  readonly version: string;
  readonly retrievedAt: string;
  readonly license: P3BLicenseState;
  readonly licenseId: string | null;
  readonly commercialUse: P3BCommercialUse;
  readonly legalStatus: P3BLegalStatus;
  readonly evidence: readonly string[];
  readonly grant: P3BLicenseGrant | null;
  readonly checksum: string;
  readonly lineageId: string;
  readonly notes: string;
}

export interface P3BLineageRecord {
  readonly lineageId: string;
  readonly datasetId: "events";
  readonly parentLineageIds: readonly string[];
  readonly transform: string;
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly inputChecksums: readonly string[];
  readonly outputChecksum: string;
  readonly notes: string;
}

/* ------------------------------------------------------------------ */
/* pack                                                                */
/* ------------------------------------------------------------------ */

export interface P3BDatasetDescriptor {
  readonly datasetId: "events";
  readonly fileName: string;
  readonly recordCount: number;
  readonly checksum: string;
}

export interface P3BEventPackManifest {
  readonly schemaVersion: P3BSchemaVersion;
  readonly eventSpecVersion: string;
  readonly contentPackVersion: string;
  readonly eventPackId: string;
  readonly packKind: "synthetic" | "official";
  readonly createdAt: string;
  readonly engineVersion: string;
  readonly rngSpecVersion: string;
  readonly datasets: readonly P3BDatasetDescriptor[];
  readonly licenses: readonly P3BLicenseRecord[];
  readonly lineage: readonly P3BLineageRecord[];
  readonly packChecksum: string;
}

export interface P3BEventPack {
  readonly manifest: P3BEventPackManifest;
  readonly events: readonly P3BEventRecord[];
}

/* ------------------------------------------------------------------ */
/* 抽選                                                                */
/* ------------------------------------------------------------------ */

/** 每個事件目前的發生狀況（由 application／未來年度交易維護）。 */
export interface P3BEventOccurrence {
  readonly eventId: string;
  readonly lastYear: number;
  readonly count: number;
}
export interface P3BEventHistory {
  readonly occurrences: readonly P3BEventOccurrence[];
}

export type P3BSelectionReason = "no_candidates" | "single_candidate" | "weighted";

export interface P3BCandidate {
  readonly eventId: string;
  readonly weight: number;
  readonly priority: number;
}

export interface P3BSelection {
  /** 篩選後、canonical（eventId 升冪）排序的候選。 */
  readonly candidates: readonly P3BCandidate[];
  readonly selectedEventId: string | null;
  readonly reason: P3BSelectionReason;
  /** 實際消耗的 u32 抽樣數（0 / 0 / 2×attempts）。 */
  readonly drawsUsed: number;
  readonly rngStateBefore: readonly [number, number, number, number];
  readonly rngStateAfter: readonly [number, number, number, number];
  /** 決策用：候選集合與結果的 canonical hash。 */
  readonly selectionHash: string;
}

/** effects 套用結果（本批只產生 typed delta，不寫入 P3-A state）。 */
export interface P3BEffectOutcome {
  readonly stats: { readonly health: number; readonly happiness: number; readonly knowledge: number; readonly relationships: number };
  readonly assets: { readonly balanceMicroUsd: bigint; readonly annualIncomeMicroUsd: bigint; readonly annualExpenseMicroUsd: bigint };
  readonly flags: readonly string[];
  readonly openedDecisionId: string | null;
  readonly informational: boolean;
}

/**
 * 抽選只需要 state 的這幾個欄位；與完整 `P3ALifeState` 解耦，
 * 讓事件模組不依賴 P3-A 的 hash／history／commandLog。
 */
export interface P3BSelectionState {
  readonly currentYear: number;
  readonly age: number;
  readonly phase: P3BPhase;
  readonly stats: { readonly health: number; readonly happiness: number; readonly knowledge: number; readonly relationships: number };
  readonly assets: { readonly balanceMicroUsd: bigint; readonly annualIncomeMicroUsd: bigint; readonly annualExpenseMicroUsd: bigint };
  readonly flags: readonly string[];
}

/** 序列化版本：金錢用十進位字串（瀏覽器／golden 邊界）。 */
export interface SerializedP3BSelectionState {
  readonly currentYear: number;
  readonly age: number;
  readonly phase: P3BPhase;
  readonly stats: { readonly health: number; readonly happiness: number; readonly knowledge: number; readonly relationships: number };
  readonly assets: { readonly balanceMicroUsd: string; readonly annualIncomeMicroUsd: string; readonly annualExpenseMicroUsd: string };
  readonly flags: readonly string[];
}

export type P3BErrorCode =
  | "E_P3B_TYPE"
  | "E_P3B_MISSING_KEY"
  | "E_P3B_UNKNOWN_KEY"
  | "E_P3B_PROTOTYPE_KEY"
  | "E_P3B_VERSIONS"
  | "E_P3B_PATTERN"
  | "E_P3B_RANGE"
  | "E_P3B_ENUM"
  | "E_P3B_DUPLICATE_ID"
  | "E_P3B_CHECKSUM"
  | "E_P3B_LICENSE"
  | "E_P3B_LINEAGE"
  | "E_P3B_SOURCE"
  | "E_P3B_CONDITION_OP"
  | "E_P3B_CONDITION_DEPTH"
  | "E_P3B_CONDITION_SIZE"
  | "E_P3B_EFFECT"
  | "E_P3B_MONEY"
  | "E_P3B_WEIGHT"
  | "E_P3B_WEIGHT_TOTAL"
  | "E_P3B_DECISION"
  | "E_P3B_SELECTION";

export const P3B_ERROR_CODES: readonly P3BErrorCode[] = [
  "E_P3B_TYPE",
  "E_P3B_MISSING_KEY",
  "E_P3B_UNKNOWN_KEY",
  "E_P3B_PROTOTYPE_KEY",
  "E_P3B_VERSIONS",
  "E_P3B_PATTERN",
  "E_P3B_RANGE",
  "E_P3B_ENUM",
  "E_P3B_DUPLICATE_ID",
  "E_P3B_CHECKSUM",
  "E_P3B_LICENSE",
  "E_P3B_LINEAGE",
  "E_P3B_SOURCE",
  "E_P3B_CONDITION_OP",
  "E_P3B_CONDITION_DEPTH",
  "E_P3B_CONDITION_SIZE",
  "E_P3B_EFFECT",
  "E_P3B_MONEY",
  "E_P3B_WEIGHT",
  "E_P3B_WEIGHT_TOTAL",
  "E_P3B_DECISION",
  "E_P3B_SELECTION"
];
