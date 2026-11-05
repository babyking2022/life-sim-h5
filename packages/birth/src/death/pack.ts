import {
  P3D_AGE_COUNT,
  P3D_CAUSE_REGISTRY,
  P3D_CONTENT_DATASET_IDS,
  P3D_DATA_VERSION_PATTERN,
  P3D_DATASET_IDS,
  P3D_DEATH_SPEC_VERSION,
  P3D_ENGINE_VERSION,
  P3D_MAX_AGE,
  P3D_MAX_CAUSE_REGISTRY_RECORDS,
  P3D_MAX_CAUSE_WEIGHT_RECORDS,
  P3D_MAX_CAUSES_PER_RECORD,
  P3D_MAX_HAZARD_PPM,
  P3D_MAX_ID_LENGTH,
  P3D_MAX_LICENSE_RECORDS,
  P3D_MAX_LINEAGE_RECORDS,
  P3D_MAX_MORTALITY_RECORDS,
  P3D_MAX_RECORD_WEIGHT,
  P3D_MAX_TEXT_LENGTH,
  P3D_MIN_AGE,
  P3D_MIN_HAZARD_PPM,
  P3D_REGION_CLASSES,
  P3D_REQUIRED_MORTALITY_RECORDS,
  P3D_RNG_SPEC_VERSION,
  P3D_SCHEMA_VERSION,
  P3D_SEXES,
  P3D_SENSITIVITIES,
  type LicenseRecord,
  type LineageRecord,
  type P3DCauseRegistryRecord,
  type P3DCauseWeightEntry,
  type P3DCauseWeightRecord,
  type P3DDatasetDescriptor,
  type P3DDatasetId,
  type P3DDeathPackManifest,
  type P3DMortalityRecord,
  type P3DRegionClass,
  type P3DSex
} from "@life-sim/contracts";
import { canonicalBytes, compareBytes, sha256Hex, utf8Encode } from "@life-sim/engine";
import { isValidatedDataPack, type ValidatedDataPack } from "../validate";
import { fail } from "./errors";
import {
  deepFreeze,
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
  type JsonObject
} from "./schema";

/**
 * P3-D 死亡資料包驗證（`validateDeathPack`）。
 *
 * 信任邊界：
 * - 所有外部輸入都是 `unknown`；只用 exact-object，拒絕未知欄位與 prototype 危險鍵；
 * - 只拋固定 `E_P3D_*`；
 * - 成功後回傳 branded（WeakSet）、deep-frozen、與原始輸入完全獨立的 snapshot；
 * - 所有 map／array／巢狀資料都是新建的，沒有可變引用留在驗證結果裡；
 * - 資料排列不影響 checksum 或抽選結果（checksum 對 canonical 排序後的紀錄計算）。
 *
 * 驗證順序（固定，錯誤碼因此可預期）：
 * 1. root → manifest（形狀／版本／base pack 綁定）
 * 2. datasets map 與每個 envelope
 * 3. 各資料集的紀錄解析
 * 4. 授權門檻（只允許 synthetic）
 * 5. lineage 圖（未知 parent／重複 parent／環／input checksum／output checksum）
 * 6. dataset checksum 與 recordCount
 * 7. 覆蓋率（mortality 剛好 172×2×121；cause age bands 完整鋪滿 0..120）
 * 8. 權重（正整數、單筆上限、總和上限）
 * 9. packChecksum
 * 10. deep-freeze → brand
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const CREATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DeathDatasetEnvelope {
  readonly schemaVersion: string;
  readonly deathDataVersion: string;
  readonly dataset: P3DDatasetId;
  readonly records: readonly unknown[];
}

export interface P3DEntityBinding {
  readonly entityId: string;
  readonly regionCode: string;
  readonly regionClass: P3DRegionClass;
}

export interface ValidatedDeathPack {
  readonly manifest: P3DDeathPackManifest;
  readonly causeRegistry: readonly P3DCauseRegistryRecord[];
  readonly causeWeights: readonly P3DCauseWeightRecord[];
  readonly mortality: readonly P3DMortalityRecord[];
  readonly licenses: readonly LicenseRecord[];
  readonly lineage: readonly LineageRecord[];
  readonly datasetChecksums: Readonly<Record<string, string>>;
  readonly packChecksum: string;
  /** `${entityId}|${sex}|${age}` → hazardPpm */
  readonly hazardIndex: Readonly<Record<string, number>>;
  /** **權威** 的 entityId → { regionCode, regionClass }；由 validated base pack 建立，不可變 */
  readonly entityIndex: Readonly<Record<string, P3DEntityBinding>>;
  /** `${regionClass}|${sex}|${age}` → 該年齡帶的死因權重（已展開 0..120） */
  readonly causeIndex: Readonly<Record<string, P3DCauseSelection>>;
}

export interface P3DCauseSelection {
  readonly causes: readonly P3DCauseWeightEntry[];
  readonly totalWeight: bigint;
}

const validatedPacks = new WeakSet<object>();

export function isValidatedDeathPack(value: unknown): value is ValidatedDeathPack {
  return typeof value === "object" && value !== null && validatedPacks.has(value);
}

const byBytes = (a: string, b: string): number => compareBytes(utf8Encode(a), utf8Encode(b));

export function mortalityKey(entityId: string, sex: P3DSex, age: number): string {
  return `${entityId}|${sex}|${age}`;
}

export function causeKey(regionClass: P3DRegionClass, sex: P3DSex, age: number): string {
  return `${regionClass}|${sex}|${age}`;
}

/* ------------------------------------------------------------------ */
/* checksums                                                          */
/* ------------------------------------------------------------------ */

/** 每個資料集的 canonical 排序鍵（決定排列不變性）。 */
function sortKeyOf(datasetId: P3DDatasetId, record: unknown): string {
  const node = record as Record<string, unknown>;
  switch (datasetId) {
    case "mortality":
      return `${node.entityId}\u0000${node.sex}\u0000${String(node.age).padStart(3, "0")}`;
    case "cause-weights":
      return `${node.regionClass}\u0000${node.sex}\u0000${String(node.ageBandMin).padStart(3, "0")}`;
    case "cause-registry":
      return String(node.causeId);
    case "licenses":
      return String(node.sourceId);
    case "lineage":
      return String(node.lineageId);
    default:
      return "";
  }
}

/**
 * 依 canonical 排序鍵排好紀錄（排列不變性）。
 *
 * 排序鍵只用已驗證的 ASCII 欄位（entityId／sex／age／regionClass／causeId／
 * sourceId／lineageId，全部符合 `ID_PATTERN` 或固定 enum），因此 JS 字串比較
 * 與 UTF-8 byte 比較的次序相同。**排序鍵只算一次**：41,624 筆的 mortality
 * 若在每次比較都做 `utf8Encode`，光是排序就會吃掉數百毫秒。
 */
function canonicalRecords(datasetId: P3DDatasetId, records: readonly unknown[]): readonly unknown[] {
  const keyed = records.map((record) => ({ record, key: sortKeyOf(datasetId, record) }));
  keyed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return keyed.map((entry) => entry.record);
}

export function computeDeathDatasetChecksum(manifest: P3DDeathPackManifest, datasetId: P3DDatasetId, records: readonly unknown[]): string {
  // mortality 有 41,624 筆：用專用的列投影（純 ASCII、前綴長度、單一 join），
  // 避免通用遞迴投影在每筆紀錄上做 key 排序與多次字串配置。
  if (datasetId === "mortality") {
    const rows = (records as readonly P3DMortalityRecord[]).map(
      (record) => `${record.entityId}\u0000${record.sex}\u0000${record.age}\u0000${record.hazardPpm}`
    );
    rows.sort();
    let body = "";
    for (const row of rows) body += `${row.length}:${row}`;
    const header = `${DATASET_DIGEST_DOMAIN}\u0000${manifest.deathDataVersion}\u0000${datasetId}\u0000${records.length}\n`;
    return sha256Hex(utf8Encode(header + body));
  }
  const sorted = canonicalRecords(datasetId, records);
  let body = "";
  for (const record of sorted) {
    const row = canonicalRowText(record);
    body += `${row.length}:${row}`;
  }
  const header = `${DATASET_DIGEST_DOMAIN}\u0000${manifest.deathDataVersion}\u0000${datasetId}\u0000${records.length}\n`;
  return sha256Hex(utf8Encode(header + body));
}

/** 資料集 checksum 的 domain separator（契約 §5.2）。 */
export const DATASET_DIGEST_DOMAIN = "LIFE1/P3D/DATASET/v1";

/**
 * 紀錄的 canonical 文字投影（prefix-free，因此可唯一解碼）。
 *
 * ```
 * null       → n
 * false/true → f / t
 * 整數        → i<十進位>;
 * 字串        → s<UTF-16 長度>:<原字元>;
 * 陣列        → a<元素數>[<元素>…]
 * 物件        → o<欄位數>{<key><value>…}   // key 以 UTF-16 code unit 排序
 * ```
 *
 * 為什麼不用共用的 `canonicalBytes`：mortality 有 41,624 筆，`canonicalBytes`
 * 每個葉節點都會配置一個 `Uint8Array` 並逐層 concat，實測約 525 ms；
 * 這個投影只做字串串接，一次 `utf8Encode` ＋ 一次 SHA-256（約 40 ms）。
 * 兩者都是 injective 且跨引擎一致；P3-D 的 checksum domain 因此獨立、可稽核。
 */
export function canonicalRowText(value: unknown): string {
  if (value === null) return "n";
  if (value === true) return "t";
  if (value === false) return "f";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("E_P3D_RANGE", "record.number");
    return `i${value};`;
  }
  if (typeof value === "string") return `s${value.length}:${value};`;
  if (Array.isArray(value)) return `a${value.length}[${value.map((entry) => canonicalRowText(entry)).join("")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    let out = `o${keys.length}{`;
    for (const key of keys) out += `s${key.length}:${key};${canonicalRowText(record[key])}`;
    return `${out}}`;
  }
  return fail("E_P3D_TYPE", "record");
}

/** manifest projection：除了 packChecksum 以外全部具意義欄位，陣列排序後再算。 */
export function deathPackChecksumProjection(manifest: P3DDeathPackManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    deathPackId: manifest.deathPackId,
    deathDataVersion: manifest.deathDataVersion,
    deathSpecVersion: manifest.deathSpecVersion,
    packKind: manifest.packKind,
    createdAt: manifest.createdAt,
    engineVersion: manifest.engineVersion,
    rngSpecVersion: manifest.rngSpecVersion,
    basePackId: manifest.basePackId,
    basePackChecksum: manifest.basePackChecksum,
    entityCount: manifest.entityCount,
    datasets: [...manifest.datasets]
      .map((descriptor) => ({
        datasetId: descriptor.datasetId,
        fileName: descriptor.fileName,
        recordCount: descriptor.recordCount,
        checksum: descriptor.checksum
      }))
      .sort((left, right) => byBytes(left.datasetId, right.datasetId))
  };
}

export function computeDeathPackChecksum(manifest: P3DDeathPackManifest): string {
  return sha256Hex(canonicalBytes(deathPackChecksumProjection(manifest) as never));
}

/* ------------------------------------------------------------------ */
/* 紀錄解析                                                            */
/* ------------------------------------------------------------------ */

const MORTALITY_KEYS = ["entityId", "sex", "age", "hazardPpm"] as const;
const MORTALITY_KEY_SET: ReadonlySet<string> = new Set(MORTALITY_KEYS);
const CAUSE_REGISTRY_KEYS = ["causeId", "labelKey", "sensitivity", "shareSafe"] as const;
const CAUSE_WEIGHT_KEYS = ["regionClass", "sex", "ageBandMin", "ageBandMax", "causes"] as const;
const CAUSE_ENTRY_KEYS = ["causeId", "weight"] as const;

const LICENSE_KEYS = [
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
] as const;

const LINEAGE_KEYS = [
  "lineageId",
  "datasetId",
  "parentLineageIds",
  "transform",
  "generatedBy",
  "generatedAt",
  "inputChecksums",
  "outputChecksum",
  "notes"
] as const;

function readMortality(value: unknown, path: string): P3DMortalityRecord {
  const node = readExactObject(value, path, MORTALITY_KEYS, MORTALITY_KEY_SET);
  return {
    entityId: readString(node.entityId, `${path}.entityId`, { min: 1, max: P3D_MAX_ID_LENGTH, pattern: ID_PATTERN }),
    sex: readEnum(node.sex, `${path}.sex`, P3D_SEXES),
    age: readInt(node.age, `${path}.age`, P3D_MIN_AGE, P3D_MAX_AGE),
    hazardPpm: readInt(node.hazardPpm, `${path}.hazardPpm`, P3D_MIN_HAZARD_PPM, P3D_MAX_HAZARD_PPM)
  };
}

function readCauseRegistryRecord(value: unknown, path: string): P3DCauseRegistryRecord {
  const node = readExactObject(value, path, CAUSE_REGISTRY_KEYS);
  return {
    causeId: readString(node.causeId, `${path}.causeId`, { min: 1, max: P3D_MAX_ID_LENGTH, pattern: ID_PATTERN }),
    labelKey: readString(node.labelKey, `${path}.labelKey`, { min: 1, max: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }),
    sensitivity: readEnum(node.sensitivity, `${path}.sensitivity`, P3D_SENSITIVITIES),
    shareSafe: readBoolean(node.shareSafe, `${path}.shareSafe`)
  };
}

function readCauseEntry(value: unknown, path: string): P3DCauseWeightEntry {
  const node = readExactObject(value, path, CAUSE_ENTRY_KEYS);
  return {
    causeId: readString(node.causeId, `${path}.causeId`, { min: 1, max: P3D_MAX_ID_LENGTH, pattern: ID_PATTERN }),
    weight: readInt(node.weight, `${path}.weight`, 1, P3D_MAX_RECORD_WEIGHT)
  };
}

function readCauseWeightRecord(value: unknown, path: string): P3DCauseWeightRecord {
  const node = readExactObject(value, path, CAUSE_WEIGHT_KEYS);
  const causes = readArray(node.causes, `${path}.causes`, 1, P3D_MAX_CAUSES_PER_RECORD).map((entry, index) =>
    readCauseEntry(entry, `${path}.causes[${index}]`)
  );
  return {
    regionClass: readEnum(node.regionClass, `${path}.regionClass`, P3D_REGION_CLASSES),
    sex: readEnum(node.sex, `${path}.sex`, P3D_SEXES),
    ageBandMin: readInt(node.ageBandMin, `${path}.ageBandMin`, P3D_MIN_AGE, P3D_MAX_AGE),
    ageBandMax: readInt(node.ageBandMax, `${path}.ageBandMax`, P3D_MIN_AGE, P3D_MAX_AGE),
    causes
  };
}

function readLicense(value: unknown, path: string): LicenseRecord {
  const node = readExactObject(value, path, LICENSE_KEYS);
  const evidence = readArray(node.evidence, `${path}.evidence`, 0, 16).map((entry, index) =>
    readString(entry, `${path}.evidence[${index}]`, { min: 1, max: P3D_MAX_TEXT_LENGTH })
  );
  const grantNode = node.grant === null ? null : readExactObject(node.grant, `${path}.grant`, ["granted", "evidence", "grantedAt"]);
  return {
    sourceId: readString(node.sourceId, `${path}.sourceId`, { min: 1, max: P3D_MAX_ID_LENGTH, pattern: ID_PATTERN }),
    datasetId: readString(node.datasetId, `${path}.datasetId`, { min: 1, max: P3D_MAX_ID_LENGTH }),
    datasetLabel: readString(node.datasetLabel, `${path}.datasetLabel`, { min: 1, max: P3D_MAX_TEXT_LENGTH }),
    sourceKind: readEnum(node.sourceKind, `${path}.sourceKind`, ["synthetic", "official", "research", "aggregator"] as const),
    sourceName: readString(node.sourceName, `${path}.sourceName`, { min: 1, max: P3D_MAX_TEXT_LENGTH }),
    sourceUrl: readNullableString(node.sourceUrl, `${path}.sourceUrl`, { min: 0, max: P3D_MAX_TEXT_LENGTH }),
    version: readString(node.version, `${path}.version`, { min: 1, max: 32 }),
    retrievedAt: readString(node.retrievedAt, `${path}.retrievedAt`, { min: 1, max: 32 }),
    license: readEnum(node.license, `${path}.license`, ["granted", "permission_required", "not_allowed", "unknown"] as const),
    licenseId: node.licenseId === null ? null : readString(node.licenseId, `${path}.licenseId`, { min: 1, max: P3D_MAX_ID_LENGTH }),
    commercialUse: readEnum(node.commercialUse, `${path}.commercialUse`, ["allowed", "not_allowed", "unknown"] as const),
    legalStatus: readEnum(node.legalStatus, `${path}.legalStatus`, ["cleared", "pending", "rejected", "unknown"] as const),
    evidence,
    grant:
      grantNode === null
        ? null
        : {
            granted: readBoolean(grantNode.granted, `${path}.grant.granted`),
            evidence: readString(grantNode.evidence, `${path}.grant.evidence`, { min: 1, max: P3D_MAX_TEXT_LENGTH }),
            grantedAt: readString(grantNode.grantedAt, `${path}.grant.grantedAt`, { min: 1, max: 32 })
          },
    checksum: readChecksum(node.checksum, `${path}.checksum`),
    lineageId: readString(node.lineageId, `${path}.lineageId`, { min: 1, max: P3D_MAX_ID_LENGTH }),
    notes: readString(node.notes, `${path}.notes`, { min: 0, max: P3D_MAX_TEXT_LENGTH })
  };
}

function readLineage(value: unknown, path: string): LineageRecord {
  const node = readExactObject(value, path, LINEAGE_KEYS);
  return {
    lineageId: readString(node.lineageId, `${path}.lineageId`, { min: 1, max: P3D_MAX_ID_LENGTH, pattern: ID_PATTERN }),
    datasetId: readString(node.datasetId, `${path}.datasetId`, { min: 1, max: P3D_MAX_ID_LENGTH }),
    parentLineageIds: readArray(node.parentLineageIds, `${path}.parentLineageIds`, 0, 32).map((entry, index) =>
      readString(entry, `${path}.parentLineageIds[${index}]`, { min: 1, max: P3D_MAX_ID_LENGTH, pattern: ID_PATTERN })
    ),
    transform: readString(node.transform, `${path}.transform`, { min: 1, max: P3D_MAX_TEXT_LENGTH }),
    generatedBy: readString(node.generatedBy, `${path}.generatedBy`, { min: 1, max: P3D_MAX_TEXT_LENGTH }),
    generatedAt: readString(node.generatedAt, `${path}.generatedAt`, { min: 1, max: 32 }),
    inputChecksums: readArray(node.inputChecksums, `${path}.inputChecksums`, 0, 32).map((entry, index) =>
      readChecksum(entry, `${path}.inputChecksums[${index}]`)
    ),
    outputChecksum: readChecksum(node.outputChecksum, `${path}.outputChecksum`),
    notes: readString(node.notes, `${path}.notes`, { min: 0, max: P3D_MAX_TEXT_LENGTH })
  };
}

/* ------------------------------------------------------------------ */
/* 授權門檻（只允許 synthetic）                                         */
/* ------------------------------------------------------------------ */

function assertSyntheticLicense(record: LicenseRecord, path: string): void {
  if (record.license === "unknown") fail("E_P3D_LICENSE", `${path}.license`);
  if (record.license === "not_allowed") fail("E_P3D_LICENSE", `${path}.license`);
  if (record.license === "permission_required") fail("E_P3D_LICENSE", `${path}.license`);
  if (record.legalStatus !== "cleared") fail("E_P3D_LICENSE", `${path}.legalStatus`);
  if (record.commercialUse !== "allowed") fail("E_P3D_LICENSE", `${path}.commercialUse`);
  if (record.evidence.length === 0) fail("E_P3D_LICENSE", `${path}.evidence`);
  if (record.licenseId === null || record.licenseId.trim().length === 0) fail("E_P3D_LICENSE", `${path}.licenseId`);
  // 本批資料全部 synthetic，不得引用非 synthetic 來源。
  if (record.sourceKind !== "synthetic") fail("E_P3D_CONTENT", `${path}.sourceKind`);
  if (record.sourceUrl !== null) fail("E_P3D_CONTENT", `${path}.sourceUrl`);

  const label = `${record.sourceName} ${record.datasetLabel} ${record.notes}`;
  for (const forbidden of FORBIDDEN_SOURCE_MARKERS) {
    if (forbidden.test(label)) fail("E_P3D_CONTENT", `${path}.sourceName`);
  }
}

/**
 * 明確禁止的來源標記（尚未取得商用確認）。
 * 用字界比對，避免 `who` 誤中 `whole` 之類的英文字。
 */
const FORBIDDEN_SOURCE_MARKERS: readonly RegExp[] = [/\bwho\b/i, /\bworld happiness report\b/i, /\bworldhappiness\b/i, /\bgbd\b/i];

/* ------------------------------------------------------------------ */
/* 主驗證入口                                                          */
/* ------------------------------------------------------------------ */

const MANIFEST_KEYS = [
  "schemaVersion",
  "deathPackId",
  "deathDataVersion",
  "deathSpecVersion",
  "packKind",
  "createdAt",
  "engineVersion",
  "rngSpecVersion",
  "basePackId",
  "basePackChecksum",
  "entityCount",
  "datasets",
  "licenses",
  "lineage",
  "packChecksum"
] as const;

const ENVELOPE_KEYS = ["schemaVersion", "deathDataVersion", "dataset", "records"] as const;
const DESCRIPTOR_KEYS = ["datasetId", "fileName", "recordCount", "checksum"] as const;

function readManifest(value: unknown, base: ValidatedDataPack): P3DDeathPackManifest {
  const node = readExactObject(value, "pack.manifest", MANIFEST_KEYS);
  const schemaVersion = readLiteral(node.schemaVersion, "pack.manifest.schemaVersion", P3D_SCHEMA_VERSION);
  readLiteral(node.deathSpecVersion, "pack.manifest.deathSpecVersion", P3D_DEATH_SPEC_VERSION);
  readLiteral(node.engineVersion, "pack.manifest.engineVersion", P3D_ENGINE_VERSION);
  readLiteral(node.rngSpecVersion, "pack.manifest.rngSpecVersion", P3D_RNG_SPEC_VERSION);
  if (node.packKind !== "synthetic") fail("E_P3D_CONTENT", "pack.manifest.packKind");

  const deathPackId = readString(node.deathPackId, "pack.manifest.deathPackId", {
    min: 1,
    max: P3D_MAX_ID_LENGTH,
    pattern: ID_PATTERN
  });
  const deathDataVersion = readString(node.deathDataVersion, "pack.manifest.deathDataVersion", {
    min: 5,
    max: 16,
    pattern: P3D_DATA_VERSION_PATTERN
  });
  const createdAt = readString(node.createdAt, "pack.manifest.createdAt", { min: 10, max: 10, pattern: CREATED_AT_PATTERN });

  const basePackId = readString(node.basePackId, "pack.manifest.basePackId", { min: 1, max: P3D_MAX_ID_LENGTH });
  const basePackChecksum = readChecksum(node.basePackChecksum, "pack.manifest.basePackChecksum");
  // 綁定必須與傳入的 validated base pack 一致。
  if (basePackId !== base.manifest.packId) fail("E_P3D_BASE_PACK", "pack.manifest.basePackId");
  if (basePackChecksum !== base.packChecksum) fail("E_P3D_BASE_PACK", "pack.manifest.basePackChecksum");

  const entityCount = readInt(node.entityCount, "pack.manifest.entityCount", 1, 4096);
  if (entityCount !== base.entityIds.length) fail("E_P3D_BASE_PACK", "pack.manifest.entityCount");

  const datasets = readArray(node.datasets, "pack.manifest.datasets", P3D_DATASET_IDS.length, P3D_DATASET_IDS.length).map(
    (entry, index): P3DDatasetDescriptor => {
      const path = `pack.manifest.datasets[${index}]`;
      const descriptor = readExactObject(entry, path, DESCRIPTOR_KEYS);
      return {
        datasetId: readEnum(descriptor.datasetId, `${path}.datasetId`, P3D_DATASET_IDS),
        fileName: readString(descriptor.fileName, `${path}.fileName`, { min: 5, max: 64, pattern: FILE_NAME_PATTERN }),
        recordCount: readInt(descriptor.recordCount, `${path}.recordCount`, 0, P3D_MAX_MORTALITY_RECORDS),
        checksum: readChecksum(descriptor.checksum, `${path}.checksum`)
      };
    }
  );
  const licenseRecords = readArray(node.licenses, "pack.manifest.licenses", 1, P3D_MAX_LICENSE_RECORDS).map((entry, index) =>
    readLicense(entry, `pack.manifest.licenses[${index}]`)
  );
  const lineageRecords = readArray(node.lineage, "pack.manifest.lineage", 1, P3D_MAX_LINEAGE_RECORDS).map((entry, index) =>
    readLineage(entry, `pack.manifest.lineage[${index}]`)
  );
  const packChecksum = readChecksum(node.packChecksum, "pack.manifest.packChecksum");

  return {
    schemaVersion,
    deathPackId,
    deathDataVersion,
    deathSpecVersion: P3D_DEATH_SPEC_VERSION,
    packKind: "synthetic",
    createdAt,
    engineVersion: P3D_ENGINE_VERSION,
    rngSpecVersion: P3D_RNG_SPEC_VERSION,
    basePackId,
    basePackChecksum,
    entityCount,
    datasets,
    licenses: licenseRecords,
    lineage: lineageRecords,
    packChecksum
  };
}

function readDatasetsMap(value: unknown): JsonObject {
  const node = readObject(value, "pack.datasets");
  for (const key of Object.keys(node)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) fail("E_P3D_PROTOTYPE_KEY", `pack.datasets.${key}`);
  }
  for (const datasetId of P3D_DATASET_IDS) {
    if (!Object.prototype.hasOwnProperty.call(node, datasetId)) fail("E_P3D_MISSING_KEY", `pack.datasets.${datasetId}`);
  }
  for (const key of Object.keys(node)) {
    if (!(P3D_DATASET_IDS as readonly string[]).includes(key)) fail("E_P3D_UNKNOWN_KEY", `pack.datasets.${key}`);
  }
  return node;
}

function readEnvelope(value: unknown, datasetId: P3DDatasetId, deathDataVersion: string, max: number): readonly unknown[] {
  const path = `pack.datasets.${datasetId}`;
  const node = readExactObject(value, path, ENVELOPE_KEYS);
  readLiteral(node.schemaVersion, `${path}.schemaVersion`, P3D_SCHEMA_VERSION);
  const version = readString(node.deathDataVersion, `${path}.deathDataVersion`, {
    min: 5,
    max: 16,
    pattern: P3D_DATA_VERSION_PATTERN
  });
  if (version !== deathDataVersion) fail("E_P3D_VERSIONS", `${path}.deathDataVersion`);
  const dataset = readEnum(node.dataset, `${path}.dataset`, P3D_DATASET_IDS);
  if (dataset !== datasetId) fail("E_P3D_VERSIONS", `${path}.dataset`);
  return readArray(node.records, `${path}.records`, 0, max);
}

export interface RawDeathPack {
  readonly manifest: unknown;
  readonly datasets: unknown;
}

export function validateDeathPack(raw: unknown, basePack: unknown): ValidatedDeathPack {
  if (!isValidatedDataPack(basePack)) fail("E_P3D_BASE_PACK", "basePack");
  const base = basePack;
  const root = readExactObject(raw, "pack", ["manifest", "datasets"]);

  const manifest = readManifest(root.manifest, base);
  const datasetMap = readDatasetsMap(root.datasets);

  const causeRegistryRaw = readEnvelope(datasetMap["cause-registry"], "cause-registry", manifest.deathDataVersion, P3D_MAX_CAUSE_REGISTRY_RECORDS);
  const causeWeightsRaw = readEnvelope(datasetMap["cause-weights"], "cause-weights", manifest.deathDataVersion, P3D_MAX_CAUSE_WEIGHT_RECORDS);
  const mortalityRaw = readEnvelope(datasetMap.mortality, "mortality", manifest.deathDataVersion, P3D_MAX_MORTALITY_RECORDS);
  const licensesRaw = readEnvelope(datasetMap.licenses, "licenses", manifest.deathDataVersion, P3D_MAX_LICENSE_RECORDS);
  const lineageRaw = readEnvelope(datasetMap.lineage, "lineage", manifest.deathDataVersion, P3D_MAX_LINEAGE_RECORDS);

  const causeRegistry = causeRegistryRaw.map((entry, index) => readCauseRegistryRecord(entry, `pack.datasets.cause-registry.records[${index}]`));
  const causeWeights = causeWeightsRaw.map((entry, index) => readCauseWeightRecord(entry, `pack.datasets.cause-weights.records[${index}]`));
  const mortality = mortalityRaw.map((entry, index) => readMortality(entry, `pack.datasets.mortality.records[${index}]`));
  const licenses = licensesRaw.map((entry, index) => readLicense(entry, `pack.datasets.licenses.records[${index}]`));
  const lineage = lineageRaw.map((entry, index) => readLineage(entry, `pack.datasets.lineage.records[${index}]`));

  /* 4) 授權：manifest 副本必須與 datasets 副本逐欄一致，且只允許 synthetic。 */
  assertManifestCopies(manifest, licenses, lineage);
  for (let index = 0; index < licenses.length; index += 1) {
    assertSyntheticLicense(licenses[index] as LicenseRecord, `pack.datasets.licenses.records[${index}]`);
  }

  /* 6a) dataset checksum 與 recordCount。 */
  const datasetsById = new Map<P3DDatasetId, P3DDatasetDescriptor>();
  for (const descriptor of manifest.datasets) {
    if (datasetsById.has(descriptor.datasetId)) fail("E_P3D_DUPLICATE", `pack.manifest.datasets.${descriptor.datasetId}`);
    datasetsById.set(descriptor.datasetId, descriptor);
  }
  const recordsByDataset: Readonly<Record<P3DDatasetId, readonly unknown[]>> = {
    "cause-registry": causeRegistry,
    "cause-weights": causeWeights,
    mortality,
    licenses,
    lineage
  };
  const datasetChecksums: Record<string, string> = {};
  for (const datasetId of P3D_DATASET_IDS) {
    const descriptor = datasetsById.get(datasetId) as P3DDatasetDescriptor;
    const records = recordsByDataset[datasetId];
    if (records.length !== descriptor.recordCount) fail("E_P3D_CHECKSUM", `pack.manifest.datasets.${datasetId}.recordCount`);
    const checksum = computeDeathDatasetChecksum(manifest, datasetId, records);
    if (checksum !== descriptor.checksum) fail("E_P3D_CHECKSUM", `pack.manifest.datasets.${datasetId}.checksum`);
    datasetChecksums[datasetId] = checksum;
  }

  /* 5) lineage 圖：未知 parent、重複 parent、環、input checksum、output checksum。 */
  assertLineage(lineage, licenses, datasetChecksums, datasetsById);

  /* 3a) 死因 registry 必須與契約的固定 registry 完全相同。 */
  assertCauseRegistry(causeRegistry);

  /* 7a) mortality 覆蓋率：剛好 172×2×121、每個 entity×sex×age 恰好一筆。 */
  const hazardIndex = buildHazardIndex(mortality, base);

  /* 7b) cause age bands：每個 regionClass×sex 都必須完整鋪滿 0..120。 */
  const causeIndex = buildCauseIndex(causeWeights);

  /* 8) 權重上限：單筆由 readInt 保證（1..MAX_SAFE_INTEGER）；
        總和上限 2^64−1 由「每筆 ≤ 2^53−1、每帶最多 8 個 registry 死因」
        可證明成立（8 × (2^53−1) ≈ 7.2×10^16 < 2^64−1 ≈ 1.8×10^19），
        因此不做永遠不會觸發的執行期分支（契約 §7.3 有證明）。 */

  /* 9) packChecksum。 */
  if (computeDeathPackChecksum(manifest) !== manifest.packChecksum) fail("E_P3D_CHECKSUM", "pack.manifest.packChecksum");

  /* 10) deep-freeze → brand。 */
  const validated: ValidatedDeathPack = deepFreeze({
    manifest,
    causeRegistry,
    causeWeights,
    mortality,
    licenses,
    lineage,
    datasetChecksums,
    packChecksum: manifest.packChecksum,
    hazardIndex,
    entityIndex: buildEntityIndex(base),
    causeIndex
  });
  validatedPacks.add(validated);
  return validated;
}

/** 死因 registry 必須逐欄等於契約定義（順序不影響）。 */
function assertCauseRegistry(records: readonly P3DCauseRegistryRecord[]): void {
  const expected = [...P3D_CAUSE_REGISTRY].sort((left, right) => byBytes(left.causeId, right.causeId));
  const actual = [...records].sort((left, right) => byBytes(left.causeId, right.causeId));
  if (actual.length !== expected.length) fail("E_P3D_COVERAGE", "pack.datasets.cause-registry.records");
  const seen = new Set<string>();
  for (let index = 0; index < actual.length; index += 1) {
    const record = actual[index] as P3DCauseRegistryRecord;
    const wanted = expected[index] as P3DCauseRegistryRecord;
    if (seen.has(record.causeId)) fail("E_P3D_DUPLICATE", `pack.datasets.cause-registry.records[${index}].causeId`);
    seen.add(record.causeId);
    if (
      record.causeId !== wanted.causeId ||
      record.labelKey !== wanted.labelKey ||
      record.sensitivity !== wanted.sensitivity ||
      record.shareSafe !== wanted.shareSafe
    ) {
      fail("E_P3D_CAUSE", `pack.datasets.cause-registry.records[${index}]`);
    }
  }
}

function buildEntityIndex(base: ValidatedDataPack): Readonly<Record<string, P3DEntityBinding>> {
  const index: Record<string, P3DEntityBinding> = {};
  for (const record of base.registry) {
    const region = (record as { region?: unknown }).region;
    const regionCode = (record as { regionCode?: unknown }).regionCode;
    const entityId = (record as { entityId?: unknown }).entityId;
    if (typeof regionCode !== "string" || typeof entityId !== "string") fail("E_P3D_BASE_PACK", "basePack.registry");
    if (typeof region !== "string" || !(P3D_REGION_CLASSES as readonly string[]).includes(region)) {
      fail("E_P3D_BASE_PACK", "basePack.registry.region");
    }
    // 同一個 entity 只能有一個綁定；regionCode 可以重複（多個 entity 共用一個 region 代碼）。
    if (Object.prototype.hasOwnProperty.call(index, entityId)) fail("E_P3D_BASE_PACK", "basePack.registry.entityId");
    index[entityId] = { entityId, regionCode, regionClass: region as P3DRegionClass };
  }
  if (Object.keys(index).length !== base.entityIds.length) fail("E_P3D_BASE_PACK", "basePack.registry");
  return index;
}

/**
 * manifest 內的 `licenses`／`lineage` 是 `datasets.*.records` 的副本。
 * 兩者必須**排列無關、逐欄完全一致**（P3-D.1 信任邊界）。
 *
 * 為什麼要驗：manifest 陣列不在 `packChecksum` projection 內（見 §5.3），
 * 若不比對，攻擊者可以只在 manifest 宣稱 `official`／WHO 或把 lineage 的
 * `outputChecksum` 換成 64 個 0，而 datasets 副本仍是合法的 synthetic。
 */
function assertManifestCopies(
  manifest: P3DDeathPackManifest,
  licenses: readonly LicenseRecord[],
  lineage: readonly LineageRecord[]
): void {
  const sortedLicenses = [...(manifest.licenses as LicenseRecord[])].sort((left, right) => byBytes(left.sourceId, right.sourceId));
  const datasetLicenses = [...licenses].sort((left, right) => byBytes(left.sourceId, right.sourceId));
  if (sortedLicenses.length !== datasetLicenses.length) fail("E_P3D_LICENSE", "pack.manifest.licenses");
  if (JSON.stringify(sortedLicenses) !== JSON.stringify(datasetLicenses)) fail("E_P3D_LICENSE", "pack.manifest.licenses");

  const sortedLineage = [...(manifest.lineage as LineageRecord[])].sort((left, right) => byBytes(left.lineageId, right.lineageId));
  const datasetLineage = [...lineage].sort((left, right) => byBytes(left.lineageId, right.lineageId));
  if (sortedLineage.length !== datasetLineage.length) fail("E_P3D_LINEAGE", "pack.manifest.lineage");
  if (JSON.stringify(sortedLineage) !== JSON.stringify(datasetLineage)) fail("E_P3D_LINEAGE", "pack.manifest.lineage");
}

function buildHazardIndex(records: readonly P3DMortalityRecord[], base: ValidatedDataPack): Readonly<Record<string, number>> {
  if (records.length !== P3D_REQUIRED_MORTALITY_RECORDS) fail("E_P3D_COVERAGE", "pack.datasets.mortality.records");
  const entities = new Set(base.entityIds);
  const index: Record<string, number> = {};
  for (let position = 0; position < records.length; position += 1) {
    const record = records[position] as P3DMortalityRecord;
    if (!entities.has(record.entityId)) fail("E_P3D_ENTITY", `pack.datasets.mortality.records[${position}].entityId`);
    const key = mortalityKey(record.entityId, record.sex, record.age);
    if (Object.prototype.hasOwnProperty.call(index, key)) fail("E_P3D_DUPLICATE", `pack.datasets.mortality.records[${position}]`);
    index[key] = record.hazardPpm;
  }
  const expected = base.entityIds.length * P3D_SEXES.length * P3D_AGE_COUNT;
  if (Object.keys(index).length !== expected) fail("E_P3D_COVERAGE", "pack.datasets.mortality.records");
  return index;
}

function buildCauseIndex(records: readonly P3DCauseWeightRecord[]): Readonly<Record<string, P3DCauseSelection>> {
  const groups = new Map<string, P3DCauseWeightRecord[]>();
  const seenBands = new Set<string>();
  for (let position = 0; position < records.length; position += 1) {
    const record = records[position] as P3DCauseWeightRecord;
    if (record.ageBandMin > record.ageBandMax) fail("E_P3D_AGE_BAND", `pack.datasets.cause-weights.records[${position}].ageBandMin`);
    const groupKey = `${record.regionClass}|${record.sex}`;
    const bandKey = `${groupKey}|${record.ageBandMin}`;
    if (seenBands.has(bandKey)) fail("E_P3D_DUPLICATE", `pack.datasets.cause-weights.records[${position}]`);
    seenBands.add(bandKey);
    const bucket = groups.get(groupKey);
    if (bucket === undefined) groups.set(groupKey, [record]);
    else bucket.push(record);
  }

  const index: Record<string, P3DCauseSelection> = {};
  for (const regionClass of P3D_REGION_CLASSES) {
    for (const sex of P3D_SEXES) {
      const groupKey = `${regionClass}|${sex}`;
      const bucket = groups.get(groupKey) ?? [];
      if (bucket.length === 0) fail("E_P3D_COVERAGE", `pack.datasets.cause-weights.${groupKey}`);
      const bands = [...bucket].sort((left, right) => left.ageBandMin - right.ageBandMin);
      let expectedMin = P3D_MIN_AGE;
      for (const band of bands) {
        if (band.ageBandMin !== expectedMin) fail("E_P3D_AGE_BAND", `pack.datasets.cause-weights.${groupKey}`);
        if (band.ageBandMin > band.ageBandMax) fail("E_P3D_AGE_BAND", `pack.datasets.cause-weights.${groupKey}`);
        expectedMin = band.ageBandMax + 1;
        assertCauseWeights(band, groupKey);
        for (let age = band.ageBandMin; age <= band.ageBandMax; age += 1) {
          const key = causeKey(regionClass, sex, age);
          if (Object.prototype.hasOwnProperty.call(index, key)) fail("E_P3D_DUPLICATE", `pack.datasets.cause-weights.${key}`);
          let total = 0n;
          for (const cause of band.causes) total += BigInt(cause.weight);
          index[key] = { causes: band.causes, totalWeight: total };
        }
      }
      if (expectedMin !== P3D_MAX_AGE + 1) fail("E_P3D_AGE_BAND", `pack.datasets.cause-weights.${groupKey}`);
    }
  }
  return index;
}

function assertCauseWeights(record: P3DCauseWeightRecord, groupKey: string): void {
  const seen = new Set<string>();
  for (const entry of record.causes) {
    if (!P3D_CAUSE_REGISTRY.some((definition) => definition.causeId === entry.causeId)) {
      fail("E_P3D_CAUSE", `pack.datasets.cause-weights.${groupKey}`);
    }
    if (seen.has(entry.causeId)) fail("E_P3D_DUPLICATE", `pack.datasets.cause-weights.${groupKey}`);
    seen.add(entry.causeId);
    if (entry.weight < 1 || !Number.isSafeInteger(entry.weight)) fail("E_P3D_WEIGHT", `pack.datasets.cause-weights.${groupKey}`);
  }
}

/* ------------------------------------------------------------------ */
/* lineage                                                             */
/* ------------------------------------------------------------------ */

function assertLineage(
  lineage: readonly LineageRecord[],
  licenses: readonly LicenseRecord[],
  datasetChecksums: Readonly<Record<string, string>>,
  datasetsById: ReadonlyMap<P3DDatasetId, P3DDatasetDescriptor>
): void {
  const byId = new Map<string, LineageRecord>();
  for (let position = 0; position < lineage.length; position += 1) {
    const record = lineage[position] as LineageRecord;
    if (byId.has(record.lineageId)) fail("E_P3D_DUPLICATE", `pack.datasets.lineage.records[${position}].lineageId`);
    const parents = new Set<string>();
    for (const parent of record.parentLineageIds) {
      if (parents.has(parent)) fail("E_P3D_LINEAGE", `pack.datasets.lineage.records[${position}].parentLineageIds`);
      parents.add(parent);
    }
    if (record.inputChecksums.length !== record.parentLineageIds.length) {
      fail("E_P3D_LINEAGE", `pack.datasets.lineage.records[${position}].inputChecksums`);
    }
    byId.set(record.lineageId, record);
  }

  // 未知 parent 與 input checksum 對應。
  for (const record of lineage) {
    for (let parentIndex = 0; parentIndex < record.parentLineageIds.length; parentIndex += 1) {
      const parentId = record.parentLineageIds[parentIndex] as string;
      const parent = byId.get(parentId);
      if (parent === undefined) fail("E_P3D_LINEAGE", `pack.datasets.lineage.${record.lineageId}.parentLineageIds`);
      if (parent.outputChecksum !== record.inputChecksums[parentIndex]) {
        fail("E_P3D_LINEAGE", `pack.datasets.lineage.${record.lineageId}.inputChecksums`);
      }
    }
  }

  // 環偵測（白／灰／黑顯式堆疊；不遞迴）。
  const colour = new Map<string, 0 | 1 | 2>();
  const parentsOf = (id: string): readonly string[] => (byId.get(id) as LineageRecord).parentLineageIds;
  for (const id of byId.keys()) colour.set(id, 0);
  for (const root of [...byId.keys()].sort(byBytes)) {
    if (colour.get(root) !== 0) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    colour.set(root, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; next: number };
      const parents = parentsOf(frame.id);
      if (frame.next >= parents.length) {
        colour.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const parent = parents[frame.next] as string;
      frame.next += 1;
      const parentColour = colour.get(parent);
      if (parentColour === undefined) continue;
      if (parentColour === 1) fail("E_P3D_LINEAGE", `pack.datasets.lineage.${frame.id}.parentLineageIds`);
      if (parentColour === 0) {
        colour.set(parent, 1);
        stack.push({ id: parent, next: 0 });
      }
    }
  }

  // 每個內容資料集必須有授權與 lineage，且 outputChecksum 必須等於該資料集的 checksum。
  for (const datasetId of P3D_CONTENT_DATASET_IDS) {
    const descriptor = datasetsById.get(datasetId) as P3DDatasetDescriptor;
    const licence = licenses.filter((record) => record.datasetId === datasetId);
    if (licence.length !== 1) fail("E_P3D_LICENSE", `pack.datasets.licenses.${datasetId}`);
    const record = licence[0] as LicenseRecord;
    if (record.checksum !== datasetChecksums[datasetId]) fail("E_P3D_LICENSE", `pack.datasets.licenses.${datasetId}.checksum`);
    const lineageRecord = lineage.find((entry) => entry.lineageId === record.lineageId);
    if (lineageRecord === undefined) fail("E_P3D_LINEAGE", `pack.datasets.licenses.${datasetId}.lineageId`);
    if (lineageRecord.datasetId !== datasetId) fail("E_P3D_LINEAGE", `pack.datasets.lineage.${record.lineageId}.datasetId`);
    if (lineageRecord.outputChecksum !== descriptor.checksum) {
      fail("E_P3D_LINEAGE", `pack.datasets.lineage.${record.lineageId}.outputChecksum`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 查詢（evaluate 用；全部是 O(1) 查表）                                */
/* ------------------------------------------------------------------ */

export function hazardPpmOf(pack: ValidatedDeathPack, entityId: string, sex: P3DSex, age: number): number {
  const key = mortalityKey(entityId, sex, age);
  const hazard = pack.hazardIndex[key];
  if (hazard === undefined) fail("E_P3D_ENTITY", "mortality");
  return hazard;
}

/**
 * entityId → 已驗證的 { regionCode, regionClass }（P3-D.1）。
 * `regionClass` 只能從這裡取得，**不得**只相信呼叫端傳入的 `regionCode`。
 */
export function entityBindingOf(pack: ValidatedDeathPack, entityId: string): P3DEntityBinding {
  const binding = pack.entityIndex[entityId];
  if (binding === undefined) fail("E_P3D_ENTITY", "entityId");
  return binding;
}

/** 驗證輸入的 regionCode 確實屬於該 entityId（在消耗任何 RNG 之前呼叫）。 */
export function assertEntityRegionBinding(pack: ValidatedDeathPack, entityId: string, regionCode: string): P3DEntityBinding {
  const binding = entityBindingOf(pack, entityId);
  if (binding.regionCode !== regionCode) fail("E_P3D_ENTITY", "regionCode");
  return binding;
}

export function causeSelectionOf(pack: ValidatedDeathPack, regionClass: P3DRegionClass, sex: P3DSex, age: number): P3DCauseSelection {
  const key = causeKey(regionClass, sex, age);
  const selection = pack.causeIndex[key];
  if (selection === undefined) fail("E_P3D_AGE_BAND", "cause-weights");
  return selection;
}
