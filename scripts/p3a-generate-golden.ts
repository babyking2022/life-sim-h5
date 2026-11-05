import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatasetEnvelope, SexPolicy } from "@life-sim/contracts";
import { P3A_LIFE_SPEC_VERSION } from "../packages/contracts/src/p3a";
import { validateDataPack } from "../packages/birth/src/validate";
import { validateIdentityPack } from "../packages/birth/src/identity/validate";
import { buildPeerGroup } from "../packages/birth/src/peer/group";
import { createBirthCertificate } from "../packages/birth/src/certificate/build";
import { createLifeFromCertificate } from "../packages/application/src/life";
import { advanceLife, createLifeLedger } from "../packages/application/src/ledger";
import { lifeDigest } from "../packages/application/src/p3a-browser";

const ROOT = process.cwd();
const BASE_DIR = join(ROOT, "fixtures", "p2a");
const IDENTITY_DIR = join(ROOT, "fixtures", "p2b");
const OUT_DIR = join(ROOT, "fixtures", "p3a");

const SEEDS = [
  "LS-TP-001", "p3a-seed-01", "p3a-seed-02", "p3a-seed-03", "p3a-seed-04", "p3a-seed-05", "p3a-seed-06", "p3a-seed-07",
  "p3a-seed-08", "p3a-seed-09", "p3a-seed-10", "p3a-seed-11", "p3a-seed-12", "p3a-seed-13", "p3a-seed-14", "p3a-seed-15",
  "p3a-seed-16", "p3a-seed-17", "p3a-seed-18", "p3a-seed-19", "p3a-seed-20", "p3a-seed-21", "p3a-seed-22", "p3a-seed-23",
  "p3a-seed-24", "p3a-seed-25", "p3a-seed-26", "p3a-seed-27", "p3a-seed-28", "p3a-seed-29", "p3a-seed-30", "p3a-seed-31",
  "p3a-seed-32", "a", "x".repeat(128), "人生-種子-005"
] as const;
const POLICIES: readonly SexPolicy[] = ["random", "female", "male"];

function readJson(path: string): DatasetEnvelope<unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as DatasetEnvelope<unknown>;
}
function loadBase() {
  const read = (file: string) => readJson(join(BASE_DIR, file));
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
function loadIdentity() {
  const read = (file: string) => readJson(join(IDENTITY_DIR, file));
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
  const base = validateDataPack(loadBase() as never);
  const identityPack = validateIdentityPack(base, loadIdentity() as never);
  const cases = [];
  let index = 0;
  for (const seed of SEEDS) {
    for (const playerSexPolicy of POLICIES) {
      index += 1;
      const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy });
      const certificate = createBirthCertificate(base, identityPack, group, seed);
      let state = createLifeFromCertificate(base, identityPack, { certificate, masterSeed: seed }).state;
      const ledger = createLifeLedger();
      ({ state } = advanceLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }));
      ({ state } = advanceLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 5 }));
      cases.push({ id: `${String(index).padStart(3, "0")}-${playerSexPolicy}`, seed, playerSexPolicy, ...lifeDigest(state, ledger) });
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const golden = {
    schemaVersion: "p3a-1",
    lifeSpecVersion: P3A_LIFE_SPEC_VERSION,
    basePackChecksum: base.packChecksum,
    identityPackChecksum: identityPack.packChecksum,
    generatedAt: "2026-10-27",
    caseCount: cases.length,
    cases
  };
  writeFileSync(join(OUT_DIR, "golden-life-vectors.v1.json"), `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  console.log(`P3A-GOLDEN-OK cases=${cases.length} stateHash=${String(cases[0]?.stateHash).slice(0, 12)}…`);
}

main();
