import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataPackManifest, P3DErrorCode } from "@life-sim/contracts";
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../src/death/pack";
import { DeathDataError } from "../src/death/errors";
import { validateDeathPack } from "../src/death/pack";
import { validateDataPack } from "../src/validate";
import { asRaw, loadPack } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type DeathMutable = Record<string, any>;

export interface DeathMutablePack {
  manifest: DeathMutable;
  datasets: {
    "cause-registry": DeathMutable;
    "cause-weights": DeathMutable;
    mortality: DeathMutable;
    licenses: DeathMutable;
    lineage: DeathMutable;
  };
}

const P3D_DIR = join(process.cwd(), "fixtures", "p3d");

/** mortality 有 41,624 筆，用執行期讀檔避免把巨型字面型別塞進 tsc。 */
function readJson(fileName: string): unknown {
  return JSON.parse(readFileSync(join(P3D_DIR, fileName), "utf8"));
}

export function loadDeathPack(): DeathMutablePack {
  // JSON.parse 每次都產生全新物件，不需要再 structuredClone（2.7MB 的 mortality 很貴）。
  return {
    manifest: readJson("manifest.v1.json"),
    datasets: {
      "cause-registry": readJson("cause-registry.v1.json"),
      "cause-weights": readJson("cause-weights.v1.json"),
      mortality: readJson("mortality.v1.json"),
      licenses: readJson("licenses.v1.json"),
      lineage: readJson("lineage.v1.json")
    }
  } as DeathMutablePack;
}

export function deathRaw(pack: DeathMutablePack): { manifest: unknown; datasets: unknown } {
  return { manifest: pack.manifest, datasets: pack.datasets };
}

export function deathRecords(pack: DeathMutablePack, datasetId: keyof DeathMutablePack["datasets"]): DeathMutable[] {
  return pack.datasets[datasetId].records as DeathMutable[];
}

/** 取第 `index` 筆；測試資料缺失時直接讓測試失敗（避免條件式跳過）。 */
export function recAt<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`test fixture: no record at index ${index}`);
  return value;
}

function checksumOf(pack: DeathMutablePack, datasetId: string): string {
  return computeDeathDatasetChecksum(
    pack.manifest as never,
    datasetId as never,
    deathRecords(pack, datasetId as keyof DeathMutablePack["datasets"])
  );
}

/**
 * 把授權／lineage／descriptors／packChecksum 全部重算成「內容一致」的狀態。
 * 資料集內容被改動時用這個，才不會先撞到 checksum 錯誤而測不到真正的規則。
 *
 * `licenses: false` / `lineage: false` 可以保留某一層的錯綁，用來測
 * 「checksum 一致但語意錯」的路徑。
 */
export function repairDeath(
  pack: DeathMutablePack,
  options: { licenses?: boolean; lineage?: boolean } = {}
): DeathMutablePack {
  const fixLicenses = options.licenses !== false;
  const fixLineage = options.lineage !== false;
  const content = ["cause-registry", "cause-weights", "mortality"];
  // 每個資料集只算一次 checksum：mortality 有 41,624 筆，重算是這裡最大的成本。
  const cache = new Map<string, string>();
  const checksumCached = (datasetId: string): string => {
    const hit = cache.get(datasetId);
    if (hit !== undefined) return hit;
    const value = checksumOf(pack, datasetId);
    cache.set(datasetId, value);
    return value;
  };
  if (fixLicenses) {
    for (const record of deathRecords(pack, "licenses")) {
      if (content.includes(record.datasetId)) record.checksum = checksumCached(record.datasetId);
    }
  }
  if (fixLineage) {
    for (const record of deathRecords(pack, "lineage")) {
      record.outputChecksum = checksumCached(record.datasetId);
      record.inputChecksums = record.parentLineageIds.map((parentId: string) => {
        const parent = deathRecords(pack, "lineage").find((entry) => entry.lineageId === parentId);
        return parent === undefined ? "0".repeat(64) : checksumCached(parent.datasetId);
      });
    }
  }
  for (const descriptor of pack.manifest.datasets) {
    descriptor.recordCount = deathRecords(pack, descriptor.datasetId).length;
    descriptor.checksum = checksumCached(descriptor.datasetId);
  }
  // P3-D.1：manifest 的 licenses／lineage 是 datasets 的副本，必須逐欄一致。
  // 只改 datasets 時把副本同步過去，才測得到真正想測的規則（要測 manifest-only
  // 偽造時請用 repair:false，因為這兩個陣列不在 packChecksum projection 內）。
  pack.manifest.licenses = structuredClone(deathRecords(pack, "licenses"));
  pack.manifest.lineage = structuredClone(deathRecords(pack, "lineage"));
  pack.manifest.packChecksum = computeDeathPackChecksum(pack.manifest as never);
  return pack;
}

/** 驗證 P2-A base pack（169 entities）；只做一次。 */
function buildBase() {
  return validateDataPack(asRaw(loadPack()));
}

/** 只驗證一次的 base pack（P2-A 169 entities）。 */
export const BASE = buildBase();

/** 每次都是全新的 validated death pack（避免測試之間互相影響）。 */
export function validated(): ReturnType<typeof validateDeathPack> {
  return validateDeathPack(deathRaw(loadDeathPack()), BASE);
}

export function codeOf(action: () => unknown): P3DErrorCode | "NO_ERROR" {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    if (error instanceof DeathDataError) return error.code;
    throw error;
  }
}

/** 依 entityId 取 base pack 的 regionCode（evaluate 需要）。 */
export function regionCodeOf(entityId: string): string {
  const record = BASE.registry.find((entry) => entry.entityId === entityId);
  if (record === undefined) throw new Error(`test fixture: unknown entity ${entityId}`);
  return record.regionCode;
}

export function entityIds(): readonly string[] {
  return BASE.entityIds;
}

export type { DataPackManifest };
