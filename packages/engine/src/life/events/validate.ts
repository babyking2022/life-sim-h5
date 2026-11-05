import {
  P3B_CONTENT_MODES,
  P3B_CONTENT_VERSION_PATTERN,
  P3B_ENGINE_VERSION,
  P3B_EVENT_KINDS,
  P3B_EVENT_SPEC_VERSION,
  P3B_LIFE_STAGES,
  P3B_MAX_AGE,
  P3B_MAX_EFFECTS_PER_EVENT,
  P3B_MAX_EFFECTS_PER_OPTION,
  P3B_MAX_EVENTS,
  P3B_MAX_ID_LENGTH,
  P3B_MAX_LICENSE_RECORDS,
  P3B_MAX_LINEAGE_RECORDS,
  P3B_MAX_WEIGHT,
  P3B_RNG_SPEC_VERSION,
  P3B_SCHEMA_VERSION,
  P3B_SOURCE_KINDS,
  P3B_COMMERCIAL_USES,
  P3B_LEGAL_STATUSES,
  P3B_LICENSE_STATES,
  type P3BDatasetDescriptor,
  type P3BEventPack,
  type P3BEventPackManifest,
  type P3BEventRecord,
  type P3BLicenseRecord,
  type P3BLineageRecord
} from "@life-sim/contracts";
import { canonicalBytes } from "../../canonical/canonical";
import { sha256Hex } from "../../rng/sha256";
import { readCondition } from "./conditions";
import { readDecisionSpec, readEffectList } from "./effects";
import { fail } from "./errors";
import {
  deepFreeze,
  readArray,
  readBoolean,
  readChecksum,
  readEnum,
  readExactObject,
  readInt,
  readNullableString,
  readString
} from "./schema";

/**
 * 事件 pack 驗證（P3-B 唯一入口）：
 * 形狀 → 版本 → 事件（含條件／效果／抉擇）→ 授權 → lineage → checksum →
 * canonical 排序 → 深複製＋deep-freeze → 品牌。
 *
 * 驗證器只回傳新物件（不使用結構化複製 API），因此呼叫端之後修改原始輸入
 * 不影響已驗證的 snapshot。
 */

const EVENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const LOCALIZATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CREATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const EVENT_KEYS = [
  "eventId",
  "eventSpecVersion",
  "contentPackVersion",
  "kind",
  "localizationKey",
  "ageMin",
  "ageMax",
  "lifeStages",
  "conditions",
  "weight",
  "priority",
  "once",
  "cooldownYears",
  "exclusiveGroup",
  "contentMode",
  "effects",
  "decision",
  "sourceId"
] as const;

const MANIFEST_KEYS = [
  "schemaVersion",
  "eventSpecVersion",
  "contentPackVersion",
  "eventPackId",
  "packKind",
  "createdAt",
  "engineVersion",
  "rngSpecVersion",
  "datasets",
  "licenses",
  "lineage",
  "packChecksum"
] as const;

const validatedPacks = new WeakSet<object>();

export interface ValidatedEventPack {
  readonly manifest: P3BEventPackManifest;
  /** canonical（eventId 升冪）排序、deep-freeze 後的事件。 */
  readonly events: readonly P3BEventRecord[];
  readonly datasetChecksum: string;
  readonly packChecksum: string;
  readonly sourceIds: readonly string[];
}

export function isValidatedEventPack(value: unknown): value is ValidatedEventPack {
  return typeof value === "object" && value !== null && validatedPacks.has(value);
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

function readLifeStages(value: unknown, path: string): readonly P3BEventRecord["lifeStages"][number][] {
  const list = readArray(value, path, 1, P3B_LIFE_STAGES.length);
  const stages = list.map((entry, index) => readEnum(entry, `${path}[${index}]`, P3B_LIFE_STAGES));
  if (new Set(stages).size !== stages.length) fail("E_P3B_DUPLICATE_ID", path);
  return stages;
}

function readEvent(value: unknown, path: string, contentPackVersion: string): P3BEventRecord {
  const node = readExactObject(value, path, EVENT_KEYS);
  const eventId = readString(node.eventId, `${path}.eventId`, { min: 3, max: P3B_MAX_ID_LENGTH, pattern: EVENT_ID_PATTERN });
  const eventSpecVersion = readString(node.eventSpecVersion, `${path}.eventSpecVersion`, { min: 1, max: 32 });
  if (eventSpecVersion !== P3B_EVENT_SPEC_VERSION) fail("E_P3B_VERSIONS", `${path}.eventSpecVersion`);
  const packVersion = readString(node.contentPackVersion, `${path}.contentPackVersion`, { min: 5, max: 32, pattern: P3B_CONTENT_VERSION_PATTERN });
  if (packVersion !== contentPackVersion) fail("E_P3B_VERSIONS", `${path}.contentPackVersion`);

  const kind = readEnum(node.kind, `${path}.kind`, P3B_EVENT_KINDS);
  const localizationKey = readString(node.localizationKey, `${path}.localizationKey`, {
    min: 1,
    max: 160,
    pattern: LOCALIZATION_KEY_PATTERN
  });
  const ageMin = readInt(node.ageMin, `${path}.ageMin`, 0, P3B_MAX_AGE);
  const ageMax = readInt(node.ageMax, `${path}.ageMax`, 0, P3B_MAX_AGE);
  if (ageMin > ageMax) fail("E_P3B_RANGE", `${path}.ageMax`);
  const lifeStages = readLifeStages(node.lifeStages, `${path}.lifeStages`);
  const conditions = node.conditions === null ? null : readCondition(node.conditions, `${path}.conditions`);
  const weight = readInt(node.weight, `${path}.weight`, 1, P3B_MAX_WEIGHT);
  const priority = readInt(node.priority, `${path}.priority`, 0, 1000);
  const once = readBoolean(node.once, `${path}.once`);
  const cooldownYears = readInt(node.cooldownYears, `${path}.cooldownYears`, 0, P3B_MAX_AGE);
  const exclusiveGroup = readNullableString(node.exclusiveGroup, `${path}.exclusiveGroup`, {
    min: 2,
    max: P3B_MAX_ID_LENGTH,
    pattern: EVENT_ID_PATTERN
  });
  const contentMode = readEnum(node.contentMode, `${path}.contentMode`, P3B_CONTENT_MODES);
  const effects = readEffectList(node.effects, `${path}.effects`, P3B_MAX_EFFECTS_PER_EVENT);
  const decision = node.decision === null ? null : readDecisionSpec(node.decision, `${path}.decision`, 5, P3B_MAX_EFFECTS_PER_OPTION);
  const sourceId = readString(node.sourceId, `${path}.sourceId`, { min: 2, max: P3B_MAX_ID_LENGTH, pattern: EVENT_ID_PATTERN });

  // kind 與 decision 必須一致；openDecision 的 id 必須等於 decision.decisionId。
  if (kind === "decision" && decision === null) fail("E_P3B_DECISION", `${path}.decision`);
  if (kind !== "decision" && decision !== null) fail("E_P3B_DECISION", `${path}.decision`);
  if (decision !== null) {
    const opened = effects.filter((effect) => effect.type === "openDecision");
    if (opened.length !== 1) fail("E_P3B_DECISION", `${path}.effects`);
    if ((opened[0] as { decisionId: string }).decisionId !== decision.decisionId) fail("E_P3B_DECISION", `${path}.effects`);
  } else if (effects.some((effect) => effect.type === "openDecision")) {
    fail("E_P3B_DECISION", `${path}.effects`);
  }

  return {
    eventId,
    eventSpecVersion,
    contentPackVersion: packVersion,
    kind,
    localizationKey,
    ageMin,
    ageMax,
    lifeStages,
    conditions,
    weight,
    priority,
    once,
    cooldownYears,
    exclusiveGroup,
    contentMode,
    effects,
    decision,
    sourceId
  };
}

/* ------------------------------------------------------------------ */
/* 授權／lineage                                                       */
/* ------------------------------------------------------------------ */

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

function readLicense(value: unknown, path: string): P3BLicenseRecord {
  const node = readExactObject(value, path, LICENSE_KEYS);
  const datasetId = readString(node.datasetId, `${path}.datasetId`, { min: 1, max: 16 });
  if (datasetId !== "events") fail("E_P3B_LICENSE", `${path}.datasetId`);
  const evidence = readArray(node.evidence, `${path}.evidence`, 0, 8).map((entry, index) =>
    readString(entry, `${path}.evidence[${index}]`, { min: 1, max: 256 })
  );
  let grant: P3BLicenseRecord["grant"] = null;
  if (node.grant !== null) {
    const grantNode = readExactObject(node.grant, `${path}.grant`, ["granted", "evidence", "grantedAt"]);
    grant = {
      granted: readBoolean(grantNode.granted, `${path}.grant.granted`),
      evidence: readString(grantNode.evidence, `${path}.grant.evidence`, { min: 0, max: 256 }),
      grantedAt: readString(grantNode.grantedAt, `${path}.grant.grantedAt`, { min: 1, max: 40 })
    };
  }
  return {
    sourceId: readString(node.sourceId, `${path}.sourceId`, { min: 2, max: P3B_MAX_ID_LENGTH, pattern: EVENT_ID_PATTERN }),
    datasetId: "events",
    datasetLabel: readString(node.datasetLabel, `${path}.datasetLabel`, { min: 1, max: 120 }),
    sourceKind: readEnum(node.sourceKind, `${path}.sourceKind`, P3B_SOURCE_KINDS),
    sourceName: readString(node.sourceName, `${path}.sourceName`, { min: 1, max: 160 }),
    sourceUrl: readNullableString(node.sourceUrl, `${path}.sourceUrl`, { min: 1, max: 400 }),
    version: readString(node.version, `${path}.version`, { min: 1, max: 40 }),
    retrievedAt: readString(node.retrievedAt, `${path}.retrievedAt`, { min: 10, max: 40, pattern: CREATED_AT_PATTERN }),
    license: readEnum(node.license, `${path}.license`, P3B_LICENSE_STATES),
    licenseId: readNullableString(node.licenseId, `${path}.licenseId`, { min: 1, max: 120 }),
    commercialUse: readEnum(node.commercialUse, `${path}.commercialUse`, P3B_COMMERCIAL_USES),
    legalStatus: readEnum(node.legalStatus, `${path}.legalStatus`, P3B_LEGAL_STATUSES),
    evidence,
    grant,
    checksum: readChecksum(node.checksum, `${path}.checksum`),
    lineageId: readString(node.lineageId, `${path}.lineageId`, { min: 2, max: P3B_MAX_ID_LENGTH, pattern: EVENT_ID_PATTERN }),
    notes: readString(node.notes, `${path}.notes`, { min: 0, max: 400 })
  };
}

/** 授權門檻；順序固定（與 P2 同一精神），錯誤碼一律 `E_P3B_LICENSE`。 */
function assertLicenseGate(record: P3BLicenseRecord, path: string): void {
  if (record.license === "unknown" || record.license === "not_allowed") fail("E_P3B_LICENSE", `${path}.license`);
  if (record.license === "permission_required") {
    if (record.grant === null || record.grant.granted !== true) fail("E_P3B_LICENSE", `${path}.grant`);
    if (record.grant.evidence.trim().length === 0) fail("E_P3B_LICENSE", `${path}.grant.evidence`);
  }
  if (record.legalStatus !== "cleared") fail("E_P3B_LICENSE", `${path}.legalStatus`);
  if (record.commercialUse !== "allowed") fail("E_P3B_LICENSE", `${path}.commercialUse`);
  if (record.evidence.length === 0) fail("E_P3B_LICENSE", `${path}.evidence`);
  if (record.licenseId === null || record.licenseId.trim().length === 0) fail("E_P3B_LICENSE", `${path}.licenseId`);
}

function readLineageRecord(value: unknown, path: string): P3BLineageRecord {
  const node = readExactObject(value, path, [
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
  const datasetId = readString(node.datasetId, `${path}.datasetId`, { min: 1, max: 16 });
  if (datasetId !== "events") fail("E_P3B_LINEAGE", `${path}.datasetId`);
  const parentLineageIds = readArray(node.parentLineageIds, `${path}.parentLineageIds`, 0, P3B_MAX_LINEAGE_RECORDS).map((entry, index) =>
    readString(entry, `${path}.parentLineageIds[${index}]`, { min: 2, max: P3B_MAX_ID_LENGTH })
  );
  const inputChecksums = readArray(node.inputChecksums, `${path}.inputChecksums`, 0, P3B_MAX_LINEAGE_RECORDS).map((entry, index) =>
    readChecksum(entry, `${path}.inputChecksums[${index}]`)
  );
  if (parentLineageIds.length !== inputChecksums.length) fail("E_P3B_LINEAGE", `${path}.inputChecksums`);
  return {
    lineageId: readString(node.lineageId, `${path}.lineageId`, { min: 2, max: P3B_MAX_ID_LENGTH, pattern: EVENT_ID_PATTERN }),
    datasetId: "events",
    parentLineageIds,
    transform: readString(node.transform, `${path}.transform`, { min: 1, max: 200 }),
    generatedBy: readString(node.generatedBy, `${path}.generatedBy`, { min: 1, max: 120 }),
    generatedAt: readString(node.generatedAt, `${path}.generatedAt`, { min: 10, max: 40, pattern: CREATED_AT_PATTERN }),
    inputChecksums,
    outputChecksum: readChecksum(node.outputChecksum, `${path}.outputChecksum`),
    notes: readString(node.notes, `${path}.notes`, { min: 0, max: 400 })
  };
}

/* ------------------------------------------------------------------ */
/* checksum                                                            */
/* ------------------------------------------------------------------ */

/** events dataset 的 canonical checksum（鍵排序、整數/bigint 有 tag）。 */
export function computeEventsChecksum(events: readonly P3BEventRecord[]): string {
  return sha256Hex(canonicalBytes(events as never));
}

/** manifest canonical projection：除了 packChecksum 本身，所有具意義欄位都納入。 */
export function packChecksumProjection(manifest: P3BEventPackManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    eventSpecVersion: manifest.eventSpecVersion,
    contentPackVersion: manifest.contentPackVersion,
    eventPackId: manifest.eventPackId,
    packKind: manifest.packKind,
    createdAt: manifest.createdAt,
    engineVersion: manifest.engineVersion,
    rngSpecVersion: manifest.rngSpecVersion,
    datasets: manifest.datasets.map((dataset) => ({
      datasetId: dataset.datasetId,
      fileName: dataset.fileName,
      recordCount: dataset.recordCount,
      checksum: dataset.checksum
    })),
    licenses: manifest.licenses.map((license) => ({
      sourceId: license.sourceId,
      datasetId: license.datasetId,
      datasetLabel: license.datasetLabel,
      sourceKind: license.sourceKind,
      sourceName: license.sourceName,
      sourceUrl: license.sourceUrl,
      version: license.version,
      retrievedAt: license.retrievedAt,
      license: license.license,
      licenseId: license.licenseId,
      commercialUse: license.commercialUse,
      legalStatus: license.legalStatus,
      evidence: [...license.evidence],
      grant: license.grant === null ? null : { ...license.grant },
      checksum: license.checksum,
      lineageId: license.lineageId,
      notes: license.notes
    })),
    lineage: manifest.lineage.map((record) => ({
      lineageId: record.lineageId,
      datasetId: record.datasetId,
      parentLineageIds: [...record.parentLineageIds],
      transform: record.transform,
      generatedBy: record.generatedBy,
      generatedAt: record.generatedAt,
      inputChecksums: [...record.inputChecksums],
      outputChecksum: record.outputChecksum,
      notes: record.notes
    }))
  };
}

export function computePackChecksum(manifest: P3BEventPackManifest): string {
  return sha256Hex(canonicalBytes(packChecksumProjection(manifest) as never));
}

/* ------------------------------------------------------------------ */
/* pack                                                                */
/* ------------------------------------------------------------------ */

function readManifest(value: unknown): P3BEventPackManifest {
  const path = "pack.manifest";
  const node = readExactObject(value, path, MANIFEST_KEYS);
  const schemaVersion = readString(node.schemaVersion, `${path}.schemaVersion`, { min: 1, max: 16 });
  if (schemaVersion !== P3B_SCHEMA_VERSION) fail("E_P3B_VERSIONS", `${path}.schemaVersion`);
  const eventSpecVersion = readString(node.eventSpecVersion, `${path}.eventSpecVersion`, { min: 1, max: 32 });
  if (eventSpecVersion !== P3B_EVENT_SPEC_VERSION) fail("E_P3B_VERSIONS", `${path}.eventSpecVersion`);
  const contentPackVersion = readString(node.contentPackVersion, `${path}.contentPackVersion`, {
    min: 5,
    max: 32,
    pattern: P3B_CONTENT_VERSION_PATTERN
  });
  const engineVersion = readString(node.engineVersion, `${path}.engineVersion`, { min: 1, max: 16 });
  if (engineVersion !== P3B_ENGINE_VERSION) fail("E_P3B_VERSIONS", `${path}.engineVersion`);
  const rngSpecVersion = readString(node.rngSpecVersion, `${path}.rngSpecVersion`, { min: 1, max: 16 });
  if (rngSpecVersion !== P3B_RNG_SPEC_VERSION) fail("E_P3B_VERSIONS", `${path}.rngSpecVersion`);

  const datasets = readArray(node.datasets, `${path}.datasets`, 1, 1).map((entry, index) => {
    const datasetPath = `${path}.datasets[${index}]`;
    const datasetNode = readExactObject(entry, datasetPath, ["datasetId", "fileName", "recordCount", "checksum"]);
    const datasetId = readString(datasetNode.datasetId, `${datasetPath}.datasetId`, { min: 1, max: 16 });
    if (datasetId !== "events") fail("E_P3B_VERSIONS", `${datasetPath}.datasetId`);
    return {
      datasetId: "events" as const,
      fileName: readString(datasetNode.fileName, `${datasetPath}.fileName`, { min: 3, max: 120, pattern: /^[A-Za-z0-9._-]+\.json$/ }),
      recordCount: readInt(datasetNode.recordCount, `${datasetPath}.recordCount`, 0, P3B_MAX_EVENTS),
      checksum: readChecksum(datasetNode.checksum, `${datasetPath}.checksum`)
    } satisfies P3BDatasetDescriptor;
  });

  const licenses = readArray(node.licenses, `${path}.licenses`, 1, P3B_MAX_LICENSE_RECORDS).map((entry, index) =>
    readLicense(entry, `${path}.licenses[${index}]`)
  );
  const lineage = readArray(node.lineage, `${path}.lineage`, 1, P3B_MAX_LINEAGE_RECORDS).map((entry, index) =>
    readLineageRecord(entry, `${path}.lineage[${index}]`)
  );

  const packKind = readEnum(node.packKind, `${path}.packKind`, ["synthetic", "official"] as const);
  const manifest: P3BEventPackManifest = {
    schemaVersion: P3B_SCHEMA_VERSION,
    eventSpecVersion: P3B_EVENT_SPEC_VERSION,
    contentPackVersion,
    eventPackId: readString(node.eventPackId, `${path}.eventPackId`, { min: 3, max: P3B_MAX_ID_LENGTH, pattern: EVENT_ID_PATTERN }),
    packKind,
    createdAt: readString(node.createdAt, `${path}.createdAt`, { min: 24, max: 24, pattern: CREATED_AT_PATTERN }),
    engineVersion: P3B_ENGINE_VERSION,
    rngSpecVersion: P3B_RNG_SPEC_VERSION,
    datasets,
    licenses,
    lineage,
    packChecksum: readChecksum(node.packChecksum, `${path}.packChecksum`)
  };
  return manifest;
}

/**
 * 驗證整個事件 pack。回傳 deep-freeze 的新物件；輸入之後被修改不影響結果。
 */
export function validateEventPack(raw: unknown): ValidatedEventPack {
  const pack = readExactObject(raw, "pack", ["manifest", "events"]);
  const manifest = readManifest(pack.manifest);
  const contentPackVersion = manifest.contentPackVersion;

  const rawEvents = readArray(pack.events, "pack.events", 0, P3B_MAX_EVENTS);
  const events = rawEvents.map((entry, index) => readEvent(entry, `pack.events[${index}]`, contentPackVersion));

  const eventIds = new Set<string>();
  const decisionIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as P3BEventRecord;
    if (eventIds.has(event.eventId)) fail("E_P3B_DUPLICATE_ID", `pack.events[${index}].eventId`);
    eventIds.add(event.eventId);
    if (event.decision !== null) {
      if (decisionIds.has(event.decision.decisionId)) fail("E_P3B_DUPLICATE_ID", `pack.events[${index}].decision.decisionId`);
      decisionIds.add(event.decision.decisionId);
    }
  }

  // canonical 排序：輸入排列順序不影響之後的候選與抽選。
  const sorted = [...events].sort((left, right) => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0));

  const datasetChecksum = computeEventsChecksum(sorted);
  const descriptor = manifest.datasets[0] as P3BDatasetDescriptor;
  if (descriptor.recordCount !== sorted.length) fail("E_P3B_CHECKSUM", "pack.manifest.datasets[0].recordCount");
  if (descriptor.checksum !== datasetChecksum) fail("E_P3B_CHECKSUM", "pack.manifest.datasets[0].checksum");

  // 授權：一筆一來源、不可重複、全部必須過 gate，且 checksum 必須等於 dataset checksum。
  const sourceIds = new Set<string>();
  for (let index = 0; index < manifest.licenses.length; index += 1) {
    const license = manifest.licenses[index] as P3BLicenseRecord;
    const path = `pack.manifest.licenses[${index}]`;
    if (sourceIds.has(license.sourceId)) fail("E_P3B_DUPLICATE_ID", `${path}.sourceId`);
    sourceIds.add(license.sourceId);
    assertLicenseGate(license, path);
    if (license.checksum !== datasetChecksum) fail("E_P3B_CHECKSUM", `${path}.checksum`);
    if (manifest.packKind === "synthetic" && license.sourceKind !== "synthetic") fail("E_P3B_SOURCE", `${path}.sourceKind`);
  }

  // lineage：唯一、父節點存在、輸出 checksum 必須等於 dataset checksum。
  const lineageById = new Map<string, P3BLineageRecord>();
  for (let index = 0; index < manifest.lineage.length; index += 1) {
    const record = manifest.lineage[index] as P3BLineageRecord;
    const path = `pack.manifest.lineage[${index}]`;
    if (lineageById.has(record.lineageId)) fail("E_P3B_DUPLICATE_ID", `${path}.lineageId`);
    lineageById.set(record.lineageId, record);
    if (record.outputChecksum !== datasetChecksum) fail("E_P3B_LINEAGE", `${path}.outputChecksum`);
  }
  for (let index = 0; index < manifest.lineage.length; index += 1) {
    const record = manifest.lineage[index] as P3BLineageRecord;
    const path = `pack.manifest.lineage[${index}]`;
    for (let parentIndex = 0; parentIndex < record.parentLineageIds.length; parentIndex += 1) {
      const parentId = record.parentLineageIds[parentIndex] as string;
      const parent = lineageById.get(parentId);
      if (parent === undefined) fail("E_P3B_LINEAGE", `${path}.parentLineageIds[${parentIndex}]`);
      if (parent.outputChecksum !== (record.inputChecksums[parentIndex] as string)) fail("E_P3B_LINEAGE", `${path}.inputChecksums[${parentIndex}]`);
    }
  }
  for (let index = 0; index < manifest.licenses.length; index += 1) {
    const license = manifest.licenses[index] as P3BLicenseRecord;
    if (!lineageById.has(license.lineageId)) fail("E_P3B_LINEAGE", `pack.manifest.licenses[${index}].lineageId`);
  }

  // 重複的 parentLineageId 與任何有向環（含自我循環）都必須拒絕。
  //
  // 保證不變的是「一定被拒絕」與錯誤碼 `E_P3B_LINEAGE`：遍歷順序固定
  // （lineageId 升冪、parent 升冪），因此**是否偵測到環**與 manifest 排列無關。
  //
  // 但錯誤 `path` 裡的陣列索引是**原始輸入位置**（見下方 `manifest.lineage.findIndex(...)`），
  // 所以 path **不保證**在任何排列下都相同；也不可以為了讓 path 一致而回報錯誤的位置。
  const sortedIds = [...lineageById.keys()].sort();
  const parentsOf = (id: string): readonly string[] =>
    [...(lineageById.get(id) as P3BLineageRecord).parentLineageIds].sort();
  for (const id of sortedIds) {
    const parents = parentsOf(id);
    if (new Set(parents).size !== parents.length) {
      fail("E_P3B_LINEAGE", `pack.manifest.lineage[${manifest.lineage.findIndex((record) => record.lineageId === id)}].parentLineageIds`);
    }
  }
  const color = new Map<string, 0 | 1 | 2>();
  for (const id of sortedIds) color.set(id, 0);
  for (const root of sortedIds) {
    if (color.get(root) !== 0) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    color.set(root, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; next: number };
      const parents = parentsOf(frame.id);
      if (frame.next >= parents.length) {
        color.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const parent = parents[frame.next] as string;
      frame.next += 1;
      const parentColor = color.get(parent);
      if (parentColor === undefined) continue; // 未知 parent 已在上面處理
      if (parentColor === 1) {
        // 找到環：回報環上「目前這條 back edge 的父節點」在**原始輸入**中的位置。
        // 這個索引不是排列不變量（不是「環上最小的 lineageId」）；錯誤碼才是固定契約。
        fail("E_P3B_LINEAGE", `pack.manifest.lineage[${manifest.lineage.findIndex((record) => record.lineageId === parent)}].parentLineageIds`);
      }
      if (parentColor === 0) {
        color.set(parent, 1);
        stack.push({ id: parent, next: 0 });
      }
    }
  }

  // 每個事件的 sourceId 必須有授權紀錄。
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index] as P3BEventRecord;
    if (!sourceIds.has(event.sourceId)) fail("E_P3B_SOURCE", `pack.events[${index}].sourceId`);
  }

  if (computePackChecksum(manifest) !== manifest.packChecksum) fail("E_P3B_CHECKSUM", "pack.manifest.packChecksum");

  const validated: ValidatedEventPack = deepFreeze({
    manifest,
    events: sorted,
    datasetChecksum,
    packChecksum: manifest.packChecksum,
    sourceIds: [...sourceIds].sort()
  });
  validatedPacks.add(validated);
  return validated;
}

export type { P3BEventPack };
