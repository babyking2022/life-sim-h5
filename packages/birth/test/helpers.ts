import type { DataPackManifest, DatasetEnvelope, DatasetId } from "@life-sim/contracts";
import type { P2AErrorCode, P2BErrorCode, P2CErrorCode, P2DErrorCode } from "@life-sim/contracts";
import { BirthDataError } from "../src/errors";
import { computeDatasetChecksum, computePackChecksum } from "../src/validate";

import manifestJson from "../../../fixtures/p2a/manifest.v1.json";
import registryJson from "../../../fixtures/p2a/country-registry.v1.json";
import indicatorsJson from "../../../fixtures/p2a/indicators.v1.json";
import birthWeightsJson from "../../../fixtures/p2a/birth-weights.v1.json";
import sensitiveNamesJson from "../../../fixtures/p2a/sensitive-names.v1.json";
import licensesJson from "../../../fixtures/p2a/licenses.v1.json";
import lineageJson from "../../../fixtures/p2a/lineage.v1.json";

export type MutableRecord = Record<string, unknown>;

export interface MutableEnvelope {
  schemaVersion: string;
  dataVersion: string;
  dataset: string;
  records: MutableRecord[];
}

export interface MutableDescriptor {
  datasetId: string;
  fileName: string;
  recordCount: number;
  checksum: string;
}

export interface MutableManifest {
  schemaVersion: string;
  dataVersion: string;
  packId: string;
  packKind: string;
  createdAt: string;
  engineVersion: string;
  rngSpecVersion: string;
  entityCount: number;
  indicatorYear: number;
  indicatorIds: string[];
  licenseSourceIds: string[];
  datasets: MutableDescriptor[];
  packChecksum: string;
}

export interface MutablePack {
  manifest: MutableManifest;
  datasets: Record<string, MutableEnvelope>;
}

const DATASETS: Record<DatasetId, string> = {
  "country-registry": "country-registry.v1.json",
  indicators: "indicators.v1.json",
  "birth-weights": "birth-weights.v1.json",
  "sensitive-names": "sensitive-names.v1.json",
  licenses: "licenses.v1.json",
  lineage: "lineage.v1.json"
};

export function loadPack(): MutablePack {
  return structuredClone({
    manifest: manifestJson,
    datasets: {
      "country-registry": registryJson,
      indicators: indicatorsJson,
      "birth-weights": birthWeightsJson,
      "sensitive-names": sensitiveNamesJson,
      licenses: licensesJson,
      lineage: lineageJson
    }
  }) as unknown as MutablePack;
}

export function dataset(pack: MutablePack, datasetId: DatasetId): MutableEnvelope {
  const envelope = pack.datasets[datasetId];
  if (!envelope) throw new Error(`missing dataset ${datasetId}`);
  return envelope;
}

export function descriptor(pack: MutablePack, datasetId: DatasetId): MutableDescriptor {
  const entry = pack.manifest.datasets.find((item) => item.datasetId === datasetId);
  if (!entry) throw new Error(`missing descriptor ${datasetId}`);
  return entry;
}

function checksumOf(pack: MutablePack, datasetId: string): string {
  return computeDatasetChecksum(pack.datasets[datasetId] as unknown as DatasetEnvelope<unknown>);
}

/** 只重算 manifest 的 dataset checksum / recordCount 與 packChecksum。 */
export function repairChecksums(pack: MutablePack): MutablePack {
  for (const entry of pack.manifest.datasets) {
    entry.checksum = checksumOf(pack, entry.datasetId);
    entry.recordCount = (pack.datasets[entry.datasetId]?.records ?? []).length;
  }
  pack.manifest.packChecksum = computePackChecksum(pack.manifest as unknown as DataPackManifest);
  return pack;
}

/**
 * 先讓 license.checksum 與 lineage.outputChecksum 跟著 data dataset 走，
 * 再重算所有 checksum。資料集內容被改動時用這個，才不會先撞到 checksum 錯誤。
 */
export function repair(pack: MutablePack): MutablePack {
  for (const license of dataset(pack, "licenses").records) {
    license.checksum = checksumOf(pack, String(license.datasetId));
  }
  for (const record of dataset(pack, "lineage").records) {
    record.outputChecksum = checksumOf(pack, String(record.datasetId));
  }
  return repairChecksums(pack);
}

export function asRaw(pack: MutablePack): { manifest: unknown; datasets: unknown } {
  return { manifest: pack.manifest, datasets: pack.datasets };
}

export function recordAt(pack: MutablePack, datasetId: DatasetId, index: number): MutableRecord {
  const record = dataset(pack, datasetId).records[index];
  if (!record) throw new Error(`missing record ${datasetId}[${index}]`);
  return record;
}

export const FIXTURE_DATASET_FILES = DATASETS;

export function codeOf(action: () => unknown): P2AErrorCode | P2BErrorCode | P2CErrorCode | P2DErrorCode | "NO_ERROR" {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    if (error instanceof BirthDataError) return error.code;
    throw error;
  }
}