import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  P3DCauseRegistryRecord,
  P3DCauseWeightEntry,
  P3DCauseWeightRecord,
  P3DDatasetDescriptor,
  P3DDatasetId,
  P3DDeathPackManifest,
  P3DMortalityRecord,
  P3DRegionClass
} from "@life-sim/contracts";
import {
  P3D_CAUSE_REGISTRY,
  P3D_DEATH_SPEC_VERSION,
  P3D_ENGINE_VERSION,
  P3D_REGION_CLASSES,
  P3D_RNG_SPEC_VERSION,
  P3D_SCHEMA_VERSION,
  P3D_SEXES
} from "../packages/contracts/src/p3d";
import { sha256Hex } from "../packages/engine/src/rng/sha256";
import { utf8Encode } from "../packages/engine/src/bytes";
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../packages/birth/src/death/pack";

/**
 * P3-D synthetic fixture 產生器。
 *
 * 產生 `fixtures/p3d/`：
 * - `cause-registry.v1.json`（8 個中性 synthetic 死因，逐欄等於契約 registry）
 * - `cause-weights.v1.json`（6 regionClass × 2 sex × 9 age bands，完整鋪滿 0..120）
 * - `mortality.v1.json`（172 entity × 2 sex × 121 age = 41,624 筆，每筆恰好一次）
 * - `licenses.v1.json`（每個內容資料集恰好一筆 synthetic 授權）
 * - `lineage.v1.json`（每個內容資料集恰好一筆 lineage，outputChecksum 綁 dataset checksum）
 * - `manifest.v1.json`（綁 P2-A base pack，含 packChecksum）
 *
 * 全部資料都是 synthetic：沒有任何 WHO／World Happiness Report／GBD 或未取得商用確認的來源。
 * 數值用**整數**產生（沒有浮點概率），因此同一份腳本在任何機器都得到同樣的檔案。
 */

const ROOT = process.cwd();
const BASE_DIR = join(ROOT, "fixtures", "p2a");
const OUT_DIR = join(ROOT, "fixtures", "p3d");

const DEATH_PACK_ID = "p3d-synthetic-mortality-v1";
const DEATH_DATA_VERSION = "1.0.0";
const CREATED_AT = "2026-10-28";
const PPM = 1_000_000;

/* ------------------------------------------------------------------ */
/* base pack（只讀 entity 與 region class）                             */
/* ------------------------------------------------------------------ */

interface BaseEntity {
  readonly entityId: string;
  readonly regionCode: string;
  readonly region: P3DRegionClass;
}

function loadBaseEntities(): { entities: readonly BaseEntity[]; packId: string; packChecksum: string } {
  const manifest = JSON.parse(readFileSync(join(BASE_DIR, "manifest.v1.json"), "utf8")) as { packId: string; packChecksum: string };
  const registry = JSON.parse(readFileSync(join(BASE_DIR, "country-registry.v1.json"), "utf8")) as {
    records: { entityId: string; regionCode: string; region: string }[];
  };
  const entities = registry.records.map((record) => ({
    entityId: record.entityId,
    regionCode: record.regionCode,
    region: record.region as P3DRegionClass
  }));
  return { entities, packId: manifest.packId, packChecksum: manifest.packChecksum };
}

/* ------------------------------------------------------------------ */
/* 決定性整數抖動                                                       */
/* ------------------------------------------------------------------ */

/** 由字串導出 0..(mod-1) 的整數（SHA-256 前 8 個 hex，不再使用任何浮點亂數）。 */
function hashInt(key: string, mod: number): number {
  const digest = sha256Hex(utf8Encode(key));
  return Number.parseInt(digest.slice(0, 8), 16) % mod;
}

/* ------------------------------------------------------------------ */
/* mortality                                                           */
/* ------------------------------------------------------------------ */

/** region class 的 0 歲基準 hazard（ppm）。 */
const REGION_BASE_PPM: Readonly<Record<P3DRegionClass, number>> = {
  asia: 5_200,
  europe: 3_800,
  africa: 9_600,
  americas: 6_400,
  oceania: 5_000,
  other: 7_000
};

/** sex 倍率（ppm）：female 較低。 */
const SEX_FACTOR_PPM: Readonly<Record<string, number>> = { female: 820_000, male: 1_000_000 };

/**
 * 以整數遞迴產生 hazard 曲線（Gompertz 形狀，全程整數）：
 * `hazard(0) = level`，`step(0) = max(1, level/180)`，每歲 `hazard += step`、`step = max(1, step×113/100)`。
 */
function hazardAtAge(level: number, age: number): number {
  let hazard = level;
  let step = Math.max(1, Math.floor(level / 180));
  for (let index = 0; index < age; index += 1) {
    hazard += step;
    step = Math.max(1, Math.floor((step * 113) / 100));
    if (hazard > PPM) return PPM;
  }
  return Math.min(PPM, hazard);
}

function buildMortality(entities: readonly BaseEntity[]): readonly P3DMortalityRecord[] {
  const records: P3DMortalityRecord[] = [];
  for (const entity of entities) {
    const regionBase = REGION_BASE_PPM[entity.region] ?? 7_000;
    for (const sex of P3D_SEXES) {
      // 每個 entity×sex 一個 ±12% 的固定抖動。
      const jitterPpm = 880_000 + hashInt(`p3d:mortality:${entity.entityId}:${sex}`, 240_001);
      const level = Math.max(1, Math.floor((regionBase * (SEX_FACTOR_PPM[sex] as number) * jitterPpm) / (PPM * PPM)));
      for (let age = 0; age <= 120; age += 1) {
        // 年齡層再疊一個 ±4% 的固定抖動，讓表格不是完全平滑但仍單調可解釋。
        const ageJitter = 960 + hashInt(`p3d:mortality:${entity.entityId}:${sex}:${age}`, 81);
        const hazardPpm = Math.min(PPM, Math.max(0, Math.floor((hazardAtAge(level, age) * ageJitter) / 1_000)));
        records.push({ entityId: entity.entityId, sex, age, hazardPpm });
      }
    }
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* cause weights                                                       */
/* ------------------------------------------------------------------ */

/** 9 個 age band，完整鋪滿 0..120（不重疊、無空洞）。 */
const AGE_BANDS: readonly { min: number; max: number }[] = [
  { min: 0, max: 0 },
  { min: 1, max: 4 },
  { min: 5, max: 14 },
  { min: 15, max: 29 },
  { min: 30, max: 44 },
  { min: 45, max: 59 },
  { min: 60, max: 74 },
  { min: 75, max: 89 },
  { min: 90, max: 120 }
];

/** 每個 band 的死因基準權重（中性、synthetic；順序對應 P3D_CAUSE_REGISTRY）。 */
const BAND_BASE_WEIGHTS: readonly (readonly number[])[] = [
  [4, 8, 40, 2, 6, 6, 22, 30], // 0   infant
  [3, 12, 38, 3, 6, 6, 18, 24], // 1-4
  [3, 8, 26, 6, 8, 6, 26, 20], // 5-14
  [6, 6, 12, 8, 8, 8, 30, 18], // 15-29
  [16, 8, 8, 14, 8, 10, 24, 12], // 30-44
  [26, 10, 7, 20, 9, 12, 10, 8], // 45-59
  [34, 15, 8, 22, 10, 10, 5, 6], // 60-74
  [40, 20, 10, 16, 12, 8, 3, 5], // 75-89
  [46, 24, 12, 8, 14, 6, 2, 4] // 90-120
];

function buildCauseWeights(): readonly P3DCauseWeightRecord[] {
  const records: P3DCauseWeightRecord[] = [];
  for (const regionClass of P3D_REGION_CLASSES) {
    for (const sex of P3D_SEXES) {
      for (let bandIndex = 0; bandIndex < AGE_BANDS.length; bandIndex += 1) {
        const band = AGE_BANDS[bandIndex] as { min: number; max: number };
        const base = BAND_BASE_WEIGHTS[bandIndex] as readonly number[];
        const causes: P3DCauseWeightEntry[] = P3D_CAUSE_REGISTRY.map((definition, causeIndex) => {
          const jitter = 850 + hashInt(`p3d:cause:${regionClass}:${sex}:${band.min}:${definition.causeId}`, 301);
          const weight = Math.max(1, Math.floor(((base[causeIndex] as number) * jitter) / 1_000));
          return { causeId: definition.causeId, weight };
        });
        records.push({
          regionClass,
          sex,
          ageBandMin: band.min,
          ageBandMax: band.max,
          causes
        });
      }
    }
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* licenses / lineage                                                  */
/* ------------------------------------------------------------------ */

function buildLicenses(datasetChecksums: Readonly<Record<string, string>>) {
  return [
    {
      sourceId: "SYNTH-P3D-CAUSE-REGISTRY",
      datasetId: "cause-registry",
      datasetLabel: "p3d synthetic cause registry",
      sourceKind: "synthetic" as const,
      sourceName: "life-sim synthetic death pack generator",
      sourceUrl: null,
      version: "1.0.0",
      retrievedAt: CREATED_AT,
      license: "granted" as const,
      licenseId: "synthetic-generated",
      commercialUse: "allowed" as const,
      legalStatus: "cleared" as const,
      evidence: ["generated by scripts/p3d-generate-fixtures.ts; no external mortality source"],
      grant: null,
      checksum: datasetChecksums["cause-registry"] as string,
      lineageId: "lin.p3d.cause-registry",
      notes: "synthetic neutral cause ids only; no reviewed copy text"
    },
    {
      sourceId: "SYNTH-P3D-CAUSE-WEIGHTS",
      datasetId: "cause-weights",
      datasetLabel: "p3d synthetic cause weight table",
      sourceKind: "synthetic" as const,
      sourceName: "life-sim synthetic death pack generator",
      sourceUrl: null,
      version: "1.0.0",
      retrievedAt: CREATED_AT,
      license: "granted" as const,
      licenseId: "synthetic-generated",
      commercialUse: "allowed" as const,
      legalStatus: "cleared" as const,
      evidence: ["authored integer weights for engineering tests only"],
      grant: null,
      checksum: datasetChecksums["cause-weights"] as string,
      lineageId: "lin.p3d.cause-weights",
      notes: "weights are authored, not derived from any real cause-of-death table"
    },
    {
      sourceId: "SYNTH-P3D-MORTALITY",
      datasetId: "mortality",
      datasetLabel: "p3d synthetic mortality hazard table",
      sourceKind: "synthetic" as const,
      sourceName: "life-sim synthetic death pack generator",
      sourceUrl: null,
      version: "1.0.0",
      retrievedAt: CREATED_AT,
      license: "granted" as const,
      licenseId: "synthetic-generated",
      commercialUse: "allowed" as const,
      legalStatus: "cleared" as const,
      evidence: ["integer Gompertz-shaped hazard generated from a fixed seed string"],
      grant: null,
      checksum: datasetChecksums.mortality as string,
      lineageId: "lin.p3d.mortality",
      notes: "not a life table; synthetic engineering values only"
    }
  ];
}

function buildLineage(datasetChecksums: Readonly<Record<string, string>>) {
  return [
    {
      lineageId: "lin.p3d.cause-registry",
      datasetId: "cause-registry",
      parentLineageIds: [],
      transform: "copy of the P3-D contract cause registry (no external input)",
      generatedBy: "scripts/p3d-generate-fixtures.ts",
      generatedAt: CREATED_AT,
      inputChecksums: [],
      outputChecksum: datasetChecksums["cause-registry"] as string,
      notes: "single root; registry must equal the contract definition"
    },
    {
      lineageId: "lin.p3d.cause-weights",
      datasetId: "cause-weights",
      parentLineageIds: ["lin.p3d.cause-registry"],
      transform: "deterministic integer weights over the contract cause registry",
      generatedBy: "scripts/p3d-generate-fixtures.ts",
      generatedAt: CREATED_AT,
      inputChecksums: [datasetChecksums["cause-registry"] as string],
      outputChecksum: datasetChecksums["cause-weights"] as string,
      notes: "bands tile 0..120 for every regionClass × sex"
    },
    {
      lineageId: "lin.p3d.mortality",
      datasetId: "mortality",
      parentLineageIds: [],
      transform: "integer Gompertz-shaped hazard per entity × sex × age",
      generatedBy: "scripts/p3d-generate-fixtures.ts",
      generatedAt: CREATED_AT,
      inputChecksums: [],
      outputChecksum: datasetChecksums.mortality as string,
      notes: "covers all 172 base-pack entities; no external mortality source"
    }
  ];
}

/* ------------------------------------------------------------------ */
/* 寫檔                                                                */
/* ------------------------------------------------------------------ */

/** 小檔用縮排 JSON（可讀）。大檔（mortality）用「一筆一行」的 compact JSON。 */
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main(): void {
  const base = loadBaseEntities();
  const causeRegistry: P3DCauseRegistryRecord[] = P3D_CAUSE_REGISTRY.map((definition) => ({
    causeId: definition.causeId,
    labelKey: definition.labelKey,
    sensitivity: definition.sensitivity,
    shareSafe: definition.shareSafe
  }));
  const causeWeights = buildCauseWeights();
  const mortality = buildMortality(base.entities);

  const provisional: P3DDeathPackManifest = {
    schemaVersion: P3D_SCHEMA_VERSION,
    deathPackId: DEATH_PACK_ID,
    deathDataVersion: DEATH_DATA_VERSION,
    deathSpecVersion: P3D_DEATH_SPEC_VERSION,
    packKind: "synthetic",
    createdAt: CREATED_AT,
    engineVersion: P3D_ENGINE_VERSION,
    rngSpecVersion: P3D_RNG_SPEC_VERSION,
    basePackId: base.packId,
    basePackChecksum: base.packChecksum,
    entityCount: base.entities.length,
    datasets: [],
    licenses: [],
    lineage: [],
    packChecksum: "0".repeat(64)
  };

  const datasetChecksums: Record<string, string> = {
    "cause-registry": computeDeathDatasetChecksum(provisional, "cause-registry", causeRegistry),
    "cause-weights": computeDeathDatasetChecksum(provisional, "cause-weights", causeWeights),
    mortality: computeDeathDatasetChecksum(provisional, "mortality", mortality)
  };

  const licenses = buildLicenses(datasetChecksums);
  const lineage = buildLineage(datasetChecksums);
  datasetChecksums.licenses = computeDeathDatasetChecksum(provisional, "licenses", licenses);
  datasetChecksums.lineage = computeDeathDatasetChecksum(provisional, "lineage", lineage);

  const descriptors: P3DDatasetDescriptor[] = [
    { datasetId: "cause-registry", fileName: "cause-registry.v1.json", recordCount: causeRegistry.length, checksum: datasetChecksums["cause-registry"] as string },
    { datasetId: "cause-weights", fileName: "cause-weights.v1.json", recordCount: causeWeights.length, checksum: datasetChecksums["cause-weights"] as string },
    { datasetId: "mortality", fileName: "mortality.v1.json", recordCount: mortality.length, checksum: datasetChecksums.mortality as string },
    { datasetId: "licenses", fileName: "licenses.v1.json", recordCount: licenses.length, checksum: datasetChecksums.licenses as string },
    { datasetId: "lineage", fileName: "lineage.v1.json", recordCount: lineage.length, checksum: datasetChecksums.lineage as string }
  ];

  const manifest: P3DDeathPackManifest = {
    ...provisional,
    datasets: descriptors,
    licenses,
    lineage,
    packChecksum: "0".repeat(64)
  };
  manifest.packChecksum = computeDeathPackChecksum(manifest);

  mkdirSync(OUT_DIR, { recursive: true });
  writeDatasetFile("cause-registry", causeRegistry);
  writeDatasetFile("cause-weights", causeWeights);
  writeDatasetFile("mortality", mortality);
  writeDatasetFile("licenses", licenses);
  writeDatasetFile("lineage", lineage);
  writeJson(join(OUT_DIR, "manifest.v1.json"), manifest);

  console.log(
    `P3D-FIXTURES-OK entities=${base.entities.length} mortality=${mortality.length} ` +
      `causeWeights=${causeWeights.length} causes=${causeRegistry.length} packChecksum=${manifest.packChecksum.slice(0, 12)}…`
  );

  function writeDatasetFile(datasetId: P3DDatasetId, records: readonly unknown[]): void {
    const body = records.map((record) => JSON.stringify(record)).join(",\n");
    const text = `{\n  "schemaVersion": "p3d-1",\n  "deathDataVersion": "${DEATH_DATA_VERSION}",\n  "dataset": "${datasetId}",\n  "records": [\n${body}\n  ]\n}\n`;
    writeFileSync(join(OUT_DIR, `${datasetId}.v1.json`), text, "utf8");
  }
}

void writeJson;
main();
