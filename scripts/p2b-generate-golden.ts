/**
 * 產生 P2-B 出生身分 golden vectors（確定性）。
 *
 * 用法：pnpm p2b:golden
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatasetEnvelope, SexPolicy } from "@life-sim/contracts";
import { buildBirthIdentity } from "../packages/birth/src/identity/draw";
import { validateIdentityPack } from "../packages/birth/src/identity/validate";
import { validateDataPack } from "../packages/birth/src/validate";

const ROOT = process.cwd();
const BASE = join(ROOT, "fixtures", "p2a");
const IDENTITY = join(ROOT, "fixtures", "p2b");

const SEEDS = [
  "LS-TP-001",
  "p2b-seed-01",
  "p2b-seed-02",
  "p2b-seed-03",
  "p2b-seed-04",
  "p2b-seed-05",
  "p2b-seed-06",
  "p2b-seed-07",
  "p2b-seed-08",
  "p2b-seed-09",
  "p2b-seed-10",
  "p2b-seed-11",
  "p2b-seed-12",
  "p2b-seed-13",
  "p2b-seed-14",
  "p2b-seed-15",
  "p2b-seed-16",
  "p2b-seed-17",
  "p2b-seed-18",
  "p2b-seed-19",
  "p2b-seed-20",
  "p2b-seed-21",
  "p2b-seed-22",
  "p2b-seed-23",
  "p2b-seed-24",
  "p2b-seed-25",
  "p2b-seed-26",
  "p2b-seed-27",
  "p2b-seed-28",
  "p2b-seed-29",
  "p2b-seed-30",
  "p2b-seed-31",
  "p2b-seed-32",
  "p2b-seed-33",
  "  p2b-padded-seed  ",
  "人生-種子-002"
] as const;

const POLICIES: readonly SexPolicy[] = ["random", "female", "male"];

function readBase() {
  const read = (file: string) => JSON.parse(readFileSync(join(BASE, file), "utf8")) as DatasetEnvelope<unknown>;
  return {
    manifest: JSON.parse(readFileSync(join(BASE, "manifest.v1.json"), "utf8")),
    datasets: {
      "country-registry": read("country-registry.v1.json"),
      indicators: read("indicators.v1.json"),
      "birth-weights": read("birth-weights.v1.json"),
      "sensitive-names": read("sensitive-names.v1.json"),
      licenses: read("licenses.v1.json"),
      lineage: read("lineage.v1.json")
    }
  };
}

function readIdentity() {
  const read = (file: string) => JSON.parse(readFileSync(join(IDENTITY, file), "utf8")) as DatasetEnvelope<unknown>;
  return {
    manifest: JSON.parse(readFileSync(join(IDENTITY, "manifest.v1.json"), "utf8")),
    datasets: {
      "country-vitals": read("country-vitals.v1.json"),
      "household-profiles": read("household-profiles.v1.json"),
      "name-corpus": read("name-corpus.v1.json"),
      "story-templates": read("story-templates.v1.json"),
      licenses: read("licenses.v1.json"),
      lineage: read("lineage.v1.json")
    }
  };
}

function main(): void {
  const base = validateDataPack(readBase());
  const identityPack = validateIdentityPack(base, readIdentity() as never);
  const cases = [];
  let index = 0;
  for (const seed of SEEDS) {
    for (const sexPolicy of POLICIES) {
      index += 1;
      cases.push({
        id: `${String(index).padStart(3, "0")}-${sexPolicy}`,
        seed,
        sexPolicy,
        identity: buildBirthIdentity(base, identityPack, { seed, sexPolicy })
      });
    }
  }
  const golden = {
    schemaVersion: identityPack.manifest.schemaVersion,
    dataVersion: identityPack.manifest.dataVersion,
    packId: identityPack.manifest.packId,
    packChecksum: identityPack.packChecksum,
    basePackId: identityPack.manifest.basePackId,
    basePackChecksum: identityPack.manifest.basePackChecksum,
    generatedAt: "2026-10-27",
    caseCount: cases.length,
    cases
  };
  writeFileSync(join(IDENTITY, "golden-identity-vectors.v1.json"), `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  console.log(`P2B-GOLDEN-OK cases=${cases.length} packChecksum=${identityPack.packChecksum.slice(0, 12)}…`);
}

main();
