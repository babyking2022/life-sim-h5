import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { P3BEventPackManifest, P3BEventRecord, P3BSelectionState } from "@life-sim/contracts";
import {
  computeEventsChecksum,
  computePackChecksum,
  validateEventPack,
  type ValidatedEventPack
} from "../src/life/events";
import { EventPackError } from "../src/life/events";

/** 測試共用：讀 fixtures、組合法／非法 pack、取固定 state。 */

const FIXTURE_DIR = join(process.cwd(), "fixtures", "p3b");

export interface RawPack {
  readonly manifest: P3BEventPackManifest;
  readonly events: readonly P3BEventRecord[];
}

export function loadRawPack(manifestFile = "manifest.v1.json", eventsFile = "events.v1.json"): RawPack {
  const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, manifestFile), "utf8")) as P3BEventPackManifest;
  const dataset = JSON.parse(readFileSync(join(FIXTURE_DIR, eventsFile), "utf8")) as { records: P3BEventRecord[] };
  return { manifest, events: dataset.records };
}

/** 深複製一份 raw JSON（測試會就地改欄位）。 */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 用給定 events 重建 manifest 的 checksum（讓負向測試可以只改想改的欄位）。
 * `patchManifest` 可在重算 checksum 之後覆寫欄位（用於 checksum 不符的測試）。
 */
export function makePack(
  events: readonly P3BEventRecord[],
  patchManifest?: (manifest: P3BEventPackManifest) => P3BEventPackManifest
): RawPack {
  const base = loadRawPack();
  const sorted = [...events].sort((left, right) => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0));
  // 非法事件（型別／範圍錯誤）會讓 canonicalBytes 失敗；這裡吞掉，
  // 因為驗證器會在比對 checksum 之前就先報事件本身的錯誤。
  let checksum = "0".repeat(64);
  try {
    checksum = computeEventsChecksum(sorted);
  } catch {
    checksum = "0".repeat(64);
  }
  const license = clone(base.manifest.licenses[0] as P3BEventPackManifest["licenses"][number]);
  const lineage = clone(base.manifest.lineage[0] as P3BEventPackManifest["lineage"][number]);
  const withChecksum = { ...license, checksum };
  const lineageWithChecksum = { ...lineage, outputChecksum: checksum };
  const manifest: P3BEventPackManifest = {
    ...clone(base.manifest),
    datasets: [{ datasetId: "events", fileName: "events.v1.json", recordCount: sorted.length, checksum }],
    licenses: [withChecksum],
    lineage: [lineageWithChecksum],
    packChecksum: "0".repeat(64)
  };
  const patched = patchManifest ? patchManifest(clone(manifest)) : manifest;
  const finalManifest = { ...patched, packChecksum: computePackChecksum(patched) };
  return { manifest: finalManifest, events: sorted };
}

export function datasetOf(manifest: P3BEventPackManifest): P3BEventPackManifest["datasets"][number] {
  return manifest.datasets[0] as P3BEventPackManifest["datasets"][number];
}

export function licenseOf(manifest: P3BEventPackManifest): P3BEventPackManifest["licenses"][number] {
  return manifest.licenses[0] as P3BEventPackManifest["licenses"][number];
}

export function lineageOf(manifest: P3BEventPackManifest): P3BEventPackManifest["lineage"][number] {
  return manifest.lineage[0] as P3BEventPackManifest["lineage"][number];
}

export function validate(pack: RawPack): ValidatedEventPack {
  return validateEventPack({ manifest: pack.manifest, events: pack.events });
}

/** 取出錯誤碼；非 EventPackError 直接讓測試失敗（避免 native TypeError 混進來）。 */
export function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof EventPackError) return error.code;
    throw new Error(`expected EventPackError, got ${(error as Error).name}: ${(error as Error).message}`);
  }
  throw new Error("expected an error but call succeeded");
}

export function pathOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof EventPackError) return error.path;
    throw new Error(`expected EventPackError, got ${(error as Error).name}: ${(error as Error).message}`);
  }
  throw new Error("expected an error but call succeeded");
}

export const BASE_STATE: P3BSelectionState = {
  currentYear: 2050,
  age: 30,
  phase: "life",
  stats: { health: 60, happiness: 60, knowledge: 50, relationships: 50 },
  assets: { balanceMicroUsd: 0n, annualIncomeMicroUsd: 12_000_000n, annualExpenseMicroUsd: 9_000_000n },
  flags: []
};

export const NO_HISTORY = { occurrences: [] } as const;

export function stateWith(patch: Partial<P3BSelectionState>): P3BSelectionState {
  return { ...BASE_STATE, ...patch };
}
