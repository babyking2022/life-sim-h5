import type { IdentityPackManifest } from "@life-sim/contracts";
import { computeIdentityDatasetChecksum, computeIdentityPackChecksum } from "../src/identity/validate";
import { validateDataPack, type ValidatedDataPack } from "../src/validate";
import { asRaw, loadPack, repair, type MutablePack } from "./helpers";

import identityManifest from "../../../fixtures/p2b/manifest.v1.json";
import vitalsJson from "../../../fixtures/p2b/country-vitals.v1.json";
import profilesJson from "../../../fixtures/p2b/household-profiles.v1.json";
import namesJson from "../../../fixtures/p2b/name-corpus.v1.json";
import storiesJson from "../../../fixtures/p2b/story-templates.v1.json";
import licensesJson from "../../../fixtures/p2b/licenses.v1.json";
import lineageJson from "../../../fixtures/p2b/lineage.v1.json";

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

export interface MutableIdentityManifest {
  schemaVersion: string;
  dataVersion: string;
  packId: string;
  packKind: string;
  createdAt: string;
  engineVersion: string;
  rngSpecVersion: string;
  basePackId: string;
  basePackChecksum: string;
  baseDataVersion: string;
  entityCount: number;
  licenseSourceIds: string[];
  datasets: MutableDescriptor[];
  packChecksum: string;
}

export interface MutableIdentityPack {
  manifest: MutableIdentityManifest;
  datasets: Record<string, MutableEnvelope>;
}

export function loadIdentityPack(): MutableIdentityPack {
  return structuredClone({
    manifest: identityManifest,
    datasets: {
      "country-vitals": vitalsJson,
      "household-profiles": profilesJson,
      "name-corpus": namesJson,
      "story-templates": storiesJson,
      licenses: licensesJson,
      lineage: lineageJson
    }
  }) as unknown as MutableIdentityPack;
}

export function identityDataset(pack: MutableIdentityPack, datasetId: string): MutableEnvelope {
  const envelope = pack.datasets[datasetId];
  if (!envelope) throw new Error(`missing identity dataset ${datasetId}`);
  return envelope;
}

export function identityDescriptor(pack: MutableIdentityPack, datasetId: string): MutableDescriptor {
  const entry = pack.manifest.datasets.find((item) => item.datasetId === datasetId);
  if (!entry) throw new Error(`missing identity descriptor ${datasetId}`);
  return entry;
}

export function identityRecord(pack: MutableIdentityPack, datasetId: string, index: number): MutableRecord {
  const record = identityDataset(pack, datasetId).records[index];
  if (!record) throw new Error(`missing identity record ${datasetId}[${index}]`);
  return record;
}

function checksumOf(pack: MutableIdentityPack, datasetId: string): string {
  return computeIdentityDatasetChecksum(pack.datasets[datasetId] as never);
}

export function repairIdentityChecksums(pack: MutableIdentityPack): MutableIdentityPack {
  for (const entry of pack.manifest.datasets) {
    entry.checksum = checksumOf(pack, entry.datasetId);
    entry.recordCount = (pack.datasets[entry.datasetId]?.records ?? []).length;
  }
  pack.manifest.packChecksum = computeIdentityPackChecksum(pack.manifest as unknown as IdentityPackManifest);
  return pack;
}

export function repairIdentity(pack: MutableIdentityPack): MutableIdentityPack {
  for (const license of identityDataset(pack, "licenses").records) {
    license.checksum = checksumOf(pack, String(license.datasetId));
  }
  for (const record of identityDataset(pack, "lineage").records) {
    record.outputChecksum = checksumOf(pack, String(record.datasetId));
  }
  return repairIdentityChecksums(pack);
}

export function identityRaw(pack: MutableIdentityPack): { manifest: unknown; datasets: unknown } {
  return { manifest: pack.manifest, datasets: pack.datasets };
}

/** 第二個合法但不同的 base pack（不同 packId／packChecksum），用來測 base 交換。 */
export function loadAlternateBase(): ValidatedDataPack {
  const mutable: MutablePack = loadPack();
  mutable.manifest.packId = "p2a-synthetic-alternate";
  repair(mutable);
  return validateDataPack(asRaw(mutable));
}

export function codeOfIdentity(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return (error as { code?: string }).code ?? "OTHER";
  }
}
