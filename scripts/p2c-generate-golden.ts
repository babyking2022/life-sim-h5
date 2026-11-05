/**
 * 產生 P2-C PeerGroup golden（精簡 digest）。
 *
 * 用法：pnpm p2c:golden
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatasetEnvelope, SexPolicy } from "@life-sim/contracts";
import { validateIdentityPack } from "../packages/birth/src/identity/validate";
import { buildPeerGroup, peerGroupDigest } from "../packages/birth/src/peer/group";
import { validateDataPack } from "../packages/birth/src/validate";

const ROOT = process.cwd();
const BASE_DIR = join(ROOT, "fixtures", "p2a");
const IDENTITY_DIR = join(ROOT, "fixtures", "p2b");
const OUT_DIR = join(ROOT, "fixtures", "p2c");

const SEEDS = [
  "LS-TP-001",
  "p2c-seed-01",
  "p2c-seed-02",
  "p2c-seed-03",
  "p2c-seed-04",
  "p2c-seed-05",
  "p2c-seed-06",
  "p2c-seed-07",
  "p2c-seed-08",
  "p2c-seed-09",
  "p2c-seed-10",
  "p2c-seed-11",
  "p2c-seed-12",
  "p2c-seed-13",
  "p2c-seed-14",
  "p2c-seed-15",
  "p2c-seed-16",
  "p2c-seed-17",
  "p2c-seed-18",
  "p2c-seed-19",
  "p2c-seed-20",
  "p2c-seed-21",
  "p2c-seed-22",
  "p2c-seed-23",
  "p2c-seed-24",
  "p2c-seed-25",
  "p2c-seed-26",
  "p2c-seed-27",
  "p2c-seed-28",
  "p2c-seed-29",
  "p2c-seed-30",
  "p2c-seed-31",
  "a",
  "x".repeat(128),
  "  p2c-padded-seed  ",
  "人生-種子-003"
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
      const digest = peerGroupDigest(group);
      cases.push({ id: `${String(index).padStart(3, "0")}-${sexPolicy}`, seed, playerSexPolicy: sexPolicy, ...digest });
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const golden = {
    schemaVersion: "p2c-1",
    peerSpecVersion: "1.0.0",
    basePackChecksum: base.packChecksum,
    identityPackChecksum: identityPack.packChecksum,
    generatedAt: "2026-10-27",
    caseCount: cases.length,
    cases
  };
  writeFileSync(join(OUT_DIR, "golden-peer-group-vectors.v1.json"), `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  console.log(`P2C-GOLDEN-OK cases=${cases.length} groupHash=${String(cases[0]?.groupHash).slice(0, 12)}…`);
}

main();
