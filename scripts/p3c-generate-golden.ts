import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { P3BEventPack } from "@life-sim/contracts";
import { P3C_CONTENT_VERSION, P3C_LIFE_SPEC_VERSION, P3C_RULESET_VERSION } from "../packages/contracts/src/p3c";
import type { EventLifeCaseInput, EventLifeDigest } from "../packages/application/src/p3c-browser";
import { runEventLifeCases } from "../packages/application/src/p3c-browser";

/**
 * P3-C golden 產生器。
 *
 * 兩個 section（同一份程式、同一組出生資料，只換事件 pack）：
 * 1. `p3b-main`：P3-B 主 pack（22 個事件），36 seeds × 3 policy = 108 組、20 年。
 *    覆蓋真實事件庫的加權抽選、once／cooldown／exclusiveGroup／guardian 過濾。
 * 2. `p3c-fixture`：P3-C fixture pack（7 個事件），6 seeds × 3 policy = 18 組、12 年。
 *    刻意讓 age 1–4 是 0 候選、age 5 是單候選 decision（0 draws），
 *    因此 golden 一定覆蓋「0 候選」「單候選」「事件抉擇 SELECT＋CONFIRM」「informational」。
 *
 * digest 覆蓋 stateHash／hashChain／三條 rolling head／occurrences／事件 RNG／逐年 eventId
 * 與 selectionHash 串接 digest。**不得覆寫 P3-A 的 108 組向量**。
 */

const ROOT = process.cwd();
const BASE_DIR = join(ROOT, "fixtures", "p2a");
const IDENTITY_DIR = join(ROOT, "fixtures", "p2b");
const OUT_DIR = join(ROOT, "fixtures", "p3c");

const SEEDS = [
  "LS-TP-001", "p3a-seed-01", "p3a-seed-02", "p3a-seed-03", "p3a-seed-04", "p3a-seed-05", "p3a-seed-06", "p3a-seed-07",
  "p3a-seed-08", "p3a-seed-09", "p3a-seed-10", "p3a-seed-11", "p3a-seed-12", "p3a-seed-13", "p3a-seed-14", "p3a-seed-15",
  "p3a-seed-16", "p3a-seed-17", "p3a-seed-18", "p3a-seed-19", "p3a-seed-20", "p3a-seed-21", "p3a-seed-22", "p3a-seed-23",
  "p3a-seed-24", "p3a-seed-25", "p3a-seed-26", "p3a-seed-27", "p3a-seed-28", "p3a-seed-29", "p3a-seed-30", "p3a-seed-31",
  "p3a-seed-32", "a", "x".repeat(128), "人生-種子-005"
] as const;
const POLICIES = ["random", "female", "male"] as const;
const FIXTURE_SEEDS = ["LS-TP-001", "p3c-seed-01", "p3c-seed-02", "p3c-seed-03", "p3c-seed-04", "p3c-seed-05"] as const;

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

const base = {
  manifest: readJson(BASE_DIR, "manifest.v1.json"),
  datasets: {
    "country-registry": readJson(BASE_DIR, "country-registry.v1.json"),
    indicators: readJson(BASE_DIR, "indicators.v1.json"),
    "birth-weights": readJson(BASE_DIR, "birth-weights.v1.json"),
    "sensitive-names": readJson(BASE_DIR, "sensitive-names.v1.json"),
    licenses: readJson(BASE_DIR, "licenses.v1.json"),
    lineage: readJson(BASE_DIR, "lineage.v1.json")
  }
};
const identity = {
  manifest: readJson(IDENTITY_DIR, "manifest.v1.json"),
  datasets: {
    "country-vitals": readJson(IDENTITY_DIR, "country-vitals.v1.json"),
    "household-profiles": readJson(IDENTITY_DIR, "household-profiles.v1.json"),
    "name-corpus": readJson(IDENTITY_DIR, "name-corpus.v1.json"),
    "story-templates": readJson(IDENTITY_DIR, "story-templates.v1.json"),
    licenses: readJson(IDENTITY_DIR, "licenses.v1.json"),
    lineage: readJson(IDENTITY_DIR, "lineage.v1.json")
  }
};

interface SectionSpec {
  readonly id: string;
  readonly dir: string;
  readonly manifestFile: string;
  readonly eventsFile: string;
  readonly years: number;
  readonly seeds: readonly string[];
}

const SECTIONS: readonly SectionSpec[] = [
  {
    id: "p3b-main",
    dir: join(ROOT, "fixtures", "p3b"),
    manifestFile: "manifest.v1.json",
    eventsFile: "events.v1.json",
    years: 20,
    seeds: SEEDS
  },
  {
    id: "p3c-fixture",
    dir: join(ROOT, "fixtures", "p3c"),
    manifestFile: "manifest.v1.json",
    eventsFile: "events.v1.json",
    years: 12,
    seeds: FIXTURE_SEEDS
  }
];

const sections = SECTIONS.map((spec) => {
  const manifest = readJson(spec.dir, spec.manifestFile) as { eventPackId: string; packChecksum: string; contentPackVersion: string };
  const pack = {
    manifest,
    events: (readJson(spec.dir, spec.eventsFile) as { records: unknown[] }).records
  };
  const cases: EventLifeCaseInput[] = [];
  for (const seed of spec.seeds) {
    for (const playerSexPolicy of POLICIES) {
      cases.push({ seed, playerSexPolicy, years: spec.years, optionPolicy: "canonical-first" });
    }
  }
  const digests = runEventLifeCases(base, identity, pack as unknown as P3BEventPack, cases);
  return {
    id: spec.id,
    manifestFile: spec.manifestFile,
    eventsFile: spec.eventsFile,
    eventPackId: manifest.eventPackId,
    eventPackChecksum: manifest.packChecksum,
    contentPackVersion: manifest.contentPackVersion,
    years: spec.years,
    optionPolicy: "canonical-first",
    cases: cases.map((entry, index) => ({
      id: `${spec.id}-${String(index + 1).padStart(3, "0")}-${entry.playerSexPolicy}`,
      seed: entry.seed,
      playerSexPolicy: entry.playerSexPolicy,
      years: entry.years,
      optionPolicy: entry.optionPolicy,
      ...(digests[index] as EventLifeDigest)
    }))
  };
});

mkdirSync(OUT_DIR, { recursive: true });
const golden = {
  schemaVersion: "p3c-1",
  lifeSpecVersion: P3C_LIFE_SPEC_VERSION,
  rulesetVersion: P3C_RULESET_VERSION,
  contentVersion: P3C_CONTENT_VERSION,
  generatedAt: "2026-10-28",
  caseCount: sections.reduce((sum, section) => sum + section.cases.length, 0),
  sections
};
writeFileSync(join(OUT_DIR, "golden-event-life-vectors.v1.json"), `${JSON.stringify(golden, null, 2)}\n`, "utf8");
console.log(
  `P3C-GOLDEN-OK sections=${sections.length} cases=${golden.caseCount} ` +
    sections.map((section) => `${section.id}:${section.cases.length}`).join(" ")
);
