/**
 * 產生 P2-D 出生證書 golden（精簡 digest）。
 *
 * 用法：pnpm p2d:golden
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatasetEnvelope, SexPolicy } from "@life-sim/contracts";
import { certificateDigest, createBirthCertificate } from "../packages/birth/src/certificate/build";
import { validateIdentityPack } from "../packages/birth/src/identity/validate";
import { buildPeerGroup } from "../packages/birth/src/peer/group";
import { validateDataPack } from "../packages/birth/src/validate";

const ROOT = process.cwd();
const BASE_DIR = join(ROOT, "fixtures", "p2a");
const IDENTITY_DIR = join(ROOT, "fixtures", "p2b");
const OUT_DIR = join(ROOT, "fixtures", "p2d");

const SEEDS = [
  "LS-TP-001",
  "p2d-seed-01",
  "p2d-seed-02",
  "p2d-seed-03",
  "p2d-seed-04",
  "p2d-seed-05",
  "p2d-seed-06",
  "p2d-seed-07",
  "p2d-seed-08",
  "p2d-seed-09",
  "p2d-seed-10",
  "p2d-seed-11",
  "p2d-seed-12",
  "p2d-seed-13",
  "p2d-seed-14",
  "p2d-seed-15",
  "p2d-seed-16",
  "p2d-seed-17",
  "p2d-seed-18",
  "p2d-seed-19",
  "p2d-seed-20",
  "p2d-seed-21",
  "p2d-seed-22",
  "p2d-seed-23",
  "p2d-seed-24",
  "p2d-seed-25",
  "p2d-seed-26",
  "p2d-seed-27",
  "p2d-seed-28",
  "p2d-seed-29",
  "p2d-seed-30",
  "p2d-seed-31",
  "a",
  "x".repeat(128),
  "  p2d-padded-seed  ",
  "人生-種子-004"
] as const;

const POLICIES: readonly SexPolicy[] = ["random", "female", "male"];

function readBase() {
  const read = (file: string) => JSON.parse(readFileSync(join(BASE_DIR, file), "utf8")) as DatasetEnvelope<unknown>;
  return {
    manifest: JSON.parse(readFileSync(join(BASE_DIR, "manifest.v1.json"), "utf8")),
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
  const read = (file: string) => JSON.parse(readFileSync(join(IDENTITY_DIR, file), "utf8")) as DatasetEnvelope<unknown>;
  return {
    manifest: JSON.parse(readFileSync(join(IDENTITY_DIR, "manifest.v1.json"), "utf8")),
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
      const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: sexPolicy });
      const certificate = createBirthCertificate(base, identityPack, group, seed);
      cases.push({ id: `${String(index).padStart(3, "0")}-${sexPolicy}`, seed, playerSexPolicy: sexPolicy, ...certificateDigest(certificate) });
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const golden = {
    schemaVersion: "p2d-1",
    certificateSpecVersion: "1.0.0",
    basePackChecksum: base.packChecksum,
    identityPackChecksum: identityPack.packChecksum,
    generatedAt: "2026-10-27",
    caseCount: cases.length,
    cases
  };
  writeFileSync(join(OUT_DIR, "golden-certificate-vectors.v1.json"), `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  console.log(`P2D-GOLDEN-OK cases=${cases.length} certificateHash=${String(cases[0]?.certificateHash).slice(0, 12)}…`);
}

main();
