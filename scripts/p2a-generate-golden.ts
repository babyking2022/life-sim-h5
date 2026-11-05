/**
 * 產生 P2-A golden vectors（確定性）。
 *
 * 用法：pnpm p2a:golden
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BirthDraft, DatasetEnvelope } from "@life-sim/contracts";
import { drawBirth } from "../packages/birth/src/draw";
import { validateDataPack } from "../packages/birth/src/validate";

const ROOT = process.cwd();
const DIR = join(ROOT, "fixtures", "p2a");

const SEEDS = [
  "LS-TP-001",
  "p2a-seed-01",
  "p2a-seed-02",
  "p2a-seed-03",
  "p2a-seed-04",
  "p2a-seed-05",
  "p2a-seed-06",
  "p2a-seed-07",
  "p2a-seed-08",
  "p2a-seed-09",
  "p2a-seed-10",
  "  p2a-padded-seed  ",
  "人生-種子-001",
  "p2a/seed:with:punct",
  "p2a-seed-14",
  "p2a-seed-15"
] as const;

const POLICIES = ["random", "female", "male"] as const;

function readDataset(file: string): DatasetEnvelope<unknown> {
  return JSON.parse(readFileSync(join(DIR, file), "utf8")) as DatasetEnvelope<unknown>;
}

function main(): void {
  const raw = {
    manifest: JSON.parse(readFileSync(join(DIR, "manifest.v1.json"), "utf8")),
    datasets: {
      "country-registry": readDataset("country-registry.v1.json"),
      indicators: readDataset("indicators.v1.json"),
      "birth-weights": readDataset("birth-weights.v1.json"),
      "sensitive-names": readDataset("sensitive-names.v1.json"),
      licenses: readDataset("licenses.v1.json"),
      lineage: readDataset("lineage.v1.json")
    }
  };
  const pack = validateDataPack(raw);
  const cases = [];
  let index = 0;
  for (const seed of SEEDS) {
    for (const sexPolicy of POLICIES) {
      index += 1;
      const draft: BirthDraft = drawBirth(pack, { seed, settings: { birthYear: pack.manifest.indicatorYear, sexPolicy } });
      cases.push({
        id: `${String(index).padStart(3, "0")}-${sexPolicy}`,
        seed,
        birthYear: pack.manifest.indicatorYear,
        sexPolicy,
        draft
      });
    }
  }
  const golden = {
    schemaVersion: pack.manifest.schemaVersion,
    dataVersion: pack.manifest.dataVersion,
    packId: pack.manifest.packId,
    packChecksum: pack.packChecksum,
    generatedAt: "2026-10-27",
    caseCount: cases.length,
    cases
  };
  writeFileSync(join(DIR, "golden-birth-vectors.v1.json"), `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  console.log(`P2A-GOLDEN-OK cases=${cases.length} packChecksum=${pack.packChecksum.slice(0, 16)}…`);
}

main();
