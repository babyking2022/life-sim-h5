/**
 * P2-B 出生身分契約（schema `p2b-1`）。
 *
 * 身分包是「疊在 P2-A 資料包上」的獨立 pack：它不改 P2-A 的 6 個 dataset，
 * 只用 basePackId／basePackChecksum 綁定，所以 P2-A 的 48 組 golden 不會被動到。
 *
 * 每個出生模組使用自己的 RNG domain：
 * - 姓名 → `names`
 * - 家庭（城鄉、收入、父母、住宅、宗教）→ `family`
 * - 出生證書編號／故事 → 由 seed 與固定資料 hash 推導，不消耗任何 RNG
 */

export const P2B_SCHEMA_VERSION = "p2b-1" as const;
export type P2BSchemaVersion = typeof P2B_SCHEMA_VERSION;

/** GPT-DEEPSEEK-0046-A：169（HKG／MAC／TWN 已從權威來源刪除，原 172 = 169 + 3）。 */
export const P2B_ENTITY_COUNT = 169;

export const P2B_DATASET_IDS = ["country-vitals", "household-profiles", "name-corpus", "story-templates"] as const;
export type P2BDatasetId = (typeof P2B_DATASET_IDS)[number];

export const P2B_ALL_DATASET_IDS = [...P2B_DATASET_IDS, "licenses", "lineage"] as const;
export type P2BAllDatasetId = (typeof P2B_ALL_DATASET_IDS)[number];

export const P2B_MAX_VITAL_RECORDS = 169;
export const P2B_MAX_HOUSEHOLD_RECORDS = 64;
export const P2B_MAX_NAME_RECORDS = 4096;
export const P2B_MAX_STORY_RECORDS = 512;
export const P2B_MAX_LICENSE_RECORDS = 64;
export const P2B_MAX_LINEAGE_RECORDS = 64;

export const P2B_WEIGHT_PPM_TOTAL = 1_000_000;

export const P2B_INCOME_QUINTILES = [1, 2, 3, 4, 5] as const;
export type IncomeQuintile = (typeof P2B_INCOME_QUINTILES)[number];
export const P2B_INCOME_LABELS: Readonly<Record<IncomeQuintile, string>> = {
  1: "最低五分之一",
  2: "次低五分之一",
  3: "中間五分之一",
  4: "次高五分之一",
  5: "最高五分之一"
};

export const P2B_SETTLEMENTS = ["urban", "rural"] as const;
export type Settlement = (typeof P2B_SETTLEMENTS)[number];
export const P2B_SETTLEMENT_LABELS: Readonly<Record<Settlement, string>> = {
  urban: "城市",
  rural: "农村"
};

export const P2B_HOUSING_TYPES = ["owned", "rented", "shared", "informal"] as const;
export type HousingType = (typeof P2B_HOUSING_TYPES)[number];
export const P2B_HOUSING_LABELS: Readonly<Record<HousingType, string>> = {
  owned: "自有住房",
  rented: "租住",
  shared: "与亲属合住",
  informal: "非正规住所"
};

export const P2B_NAME_KINDS = ["surname", "given"] as const;
export type NameKind = (typeof P2B_NAME_KINDS)[number];

export const P2B_NAME_SEXES = ["female", "male", "total"] as const;
export type NameSex = (typeof P2B_NAME_SEXES)[number];

export const P2B_SCRIPTS = ["han", "latin", "cyrillic", "arabic", "devanagari", "kana", "hangul"] as const;
export type NameScript = (typeof P2B_SCRIPTS)[number];

export const P2B_SURNAME_ORDERS = ["family_first", "given_first"] as const;
export type SurnameOrder = (typeof P2B_SURNAME_ORDERS)[number];

export interface CountryVitalRecord {
  readonly entityId: string;
  readonly cultureId: string;
  readonly lifeExpectancyYearsX10: number;
  readonly under5MortalityPer1000X10: number;
  readonly gdpPerCapitaPppUsd: number;
  readonly dataVersion: string;
}

export interface OccupationShare {
  readonly occupationId: string;
  readonly label: string;
  readonly weightPpm: number;
}

export interface HousingShare {
  readonly housingId: HousingType;
  readonly weightPpm: number;
}

export interface ReligionShare {
  readonly religionId: string;
  readonly label: string;
  readonly weightPpm: number;
}

export interface HouseholdProfileRecord {
  readonly cultureId: string;
  readonly script: NameScript;
  readonly surnameOrder: SurnameOrder;
  readonly urbanSharePpm: number;
  readonly incomeQuintilePpm: readonly number[];
  readonly motherAgeMin: number;
  readonly motherAgeMax: number;
  readonly fatherAgeMin: number;
  readonly fatherAgeMax: number;
  readonly occupations: readonly OccupationShare[];
  readonly housing: readonly HousingShare[];
  readonly religions: readonly ReligionShare[];
  readonly dataVersion: string;
}

export interface NameRecord {
  readonly cultureId: string;
  readonly kind: NameKind;
  readonly sex: NameSex;
  readonly value: string;
  readonly dataVersion: string;
}

export interface StoryTemplateRecord {
  readonly templateId: string;
  readonly cultureId: string;
  readonly paragraphs: readonly string[];
  readonly dataVersion: string;
}

export interface IdentityDatasetDescriptor {
  readonly datasetId: P2BAllDatasetId;
  readonly fileName: string;
  readonly recordCount: number;
  readonly checksum: string;
}

export interface IdentityPackManifest {
  readonly schemaVersion: P2BSchemaVersion;
  readonly dataVersion: string;
  readonly packId: string;
  readonly packKind: "synthetic" | "official";
  readonly createdAt: string;
  readonly engineVersion: string;
  readonly rngSpecVersion: string;
  readonly basePackId: string;
  readonly basePackChecksum: string;
  readonly baseDataVersion: string;
  readonly entityCount: number;
  readonly licenseSourceIds: readonly string[];
  readonly datasets: readonly IdentityDatasetDescriptor[];
  readonly packChecksum: string;
}

export interface IdentityDatasetEnvelope<T> {
  readonly schemaVersion: P2BSchemaVersion;
  readonly dataVersion: string;
  readonly dataset: P2BDatasetId;
  readonly records: readonly T[];
}

export interface BirthName {
  readonly cultureId: string;
  readonly script: NameScript;
  readonly surname: string;
  readonly givenName: string;
  readonly fullName: string;
}

export interface BirthPlace {
  readonly settlement: Settlement;
  readonly urban: boolean;
  readonly entityId: string;
  readonly regionCode: string;
  readonly region: string;
}

export interface BirthHousehold {
  readonly incomeQuintile: IncomeQuintile;
  readonly incomeLabel: string;
  readonly housing: HousingType;
  readonly housingLabel: string;
}

export interface BirthParents {
  readonly motherAge: number;
  readonly fatherAge: number;
  readonly motherOccupationId: string;
  readonly motherOccupationLabel: string;
  readonly fatherOccupationId: string;
  readonly fatherOccupationLabel: string;
}

export interface BirthReligion {
  readonly religionId: string;
  readonly label: string;
  readonly none: boolean;
}

export interface BirthVitals {
  readonly lifeExpectancyYearsX10: number;
  readonly under5MortalityPer1000X10: number;
  readonly gdpPerCapitaPppUsd: number;
}

export interface BirthCertificate {
  readonly prefix: string;
  readonly serial: string;
  readonly checkChar: string;
  readonly fullNumber: string;
}

export interface BirthStory {
  readonly templateId: string;
  readonly paragraphs: readonly string[];
}

export interface IdentityRngCursors {
  readonly names: { readonly state: readonly [number, number, number, number]; readonly draws: number };
  readonly family: { readonly state: readonly [number, number, number, number]; readonly draws: number };
}

export interface BirthIdentity {
  readonly schemaVersion: P2BSchemaVersion;
  readonly dataVersion: string;
  readonly basePackId: string;
  readonly basePackChecksum: string;
  readonly baseDataVersion: string;
  readonly identityPackId: string;
  readonly identityPackChecksum: string;
  readonly seedHash: string;
  readonly birth: {
    readonly schemaVersion: string;
    readonly dataVersion: string;
    readonly entityId: string;
    readonly regionCode: string;
    readonly region: string;
    readonly displayNameZhHans: string;
    readonly sex: "female" | "male";
    readonly birthYear: number;
    readonly weightBandId: string;
    readonly weightGrams: number;
    readonly weightBandIndex: number;
    readonly rng: { readonly state: readonly [number, number, number, number]; readonly draws: number };
    readonly drawHash: string;
  };
  readonly name: BirthName;
  readonly place: BirthPlace;
  readonly household: BirthHousehold;
  readonly parents: BirthParents;
  readonly religion: BirthReligion;
  readonly vitals: BirthVitals;
  readonly certificate: BirthCertificate;
  readonly story: BirthStory;
  readonly rng: IdentityRngCursors;
  readonly identityHash: string;
}

/* ------------------------------------------------------------------ */
/* error codes（P2-B 專屬；結構性錯誤沿用 P2-A 的固定碼）              */
/* ------------------------------------------------------------------ */

export type P2BErrorCode =
  | "E_P2B_SCHEMA_VERSION"
  | "E_P2B_BASE_PACK_MISMATCH"
  | "E_P2B_PACK_KIND"
  | "E_P2B_UNKNOWN_CULTURE"
  | "E_P2B_STORY_PLACEHOLDER"
  | "E_P2B_NAME_POOL_MISSING"
  | "E_P2B_HOUSEHOLD_PROFILE_MISSING"
  | "E_P2B_STORY_TEMPLATE_MISSING"
  | "E_P2B_VITAL_RANGE"
  | "E_P2B_PROFILE_WEIGHTS"
  | "E_P2B_PACK_NOT_VALIDATED";

export const P2B_ERROR_CODES: readonly P2BErrorCode[] = [
  "E_P2B_SCHEMA_VERSION",
  "E_P2B_BASE_PACK_MISMATCH",
  "E_P2B_PACK_KIND",
  "E_P2B_UNKNOWN_CULTURE",
  "E_P2B_STORY_PLACEHOLDER",
  "E_P2B_NAME_POOL_MISSING",
  "E_P2B_HOUSEHOLD_PROFILE_MISSING",
  "E_P2B_STORY_TEMPLATE_MISSING",
  "E_P2B_VITAL_RANGE",
  "E_P2B_PROFILE_WEIGHTS",
  "E_P2B_PACK_NOT_VALIDATED"
];
