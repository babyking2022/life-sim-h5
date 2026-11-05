import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { P3BEventHistory, P3BEventPackManifest, P3BEventRecord } from "@life-sim/contracts";
import type { EventCaseDigest, EventCaseInput } from "../packages/engine/src/life/events/browser";
import { runEventCases } from "../packages/engine/src/life/events/browser";

/**
 * P3-B golden 產生器：固定 pack、固定狀態、固定 RNG state → 逐位元可比的 selection digest。
 *
 * 兩份 pack：
 * - 主 pack：24 個案例，全部走加權抽選（含 once／cooldown／exclusiveGroup／guardian 過濾）。
 * - 邊界 pack：4 個案例，覆蓋 0 候選、1 候選（0 draws）與 2 候選（2 draws）。
 *
 * 同一個檔案由 Node 測試與 Chromium／WebKit golden 共用。
 */

const ROOT = process.cwd();
const DIR = join(ROOT, "fixtures", "p3b");

interface CaseSpec {
  readonly id: string;
  readonly contentMode: "standard" | "guardian";
  readonly age: number;
  readonly currentYear: number;
  readonly stats: { health: number; happiness: number; knowledge: number; relationships: number };
  readonly assets: { balanceMicroUsd: string; annualIncomeMicroUsd: string; annualExpenseMicroUsd: string };
  readonly flags: readonly string[];
  readonly history: readonly { eventId: string; lastYear: number; count: number }[];
  readonly rngState: readonly [number, number, number, number];
}

const baseStats = { health: 60, happiness: 60, knowledge: 50, relationships: 50 };
const baseAssets = { balanceMicroUsd: "0", annualIncomeMicroUsd: "12000000", annualExpenseMicroUsd: "9000000" };

const mainSpecs: readonly CaseSpec[] = [
  { id: "case-01-infant-standard", contentMode: "standard", age: 2, currentYear: 2022, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [1, 2, 3, 4] },
  { id: "case-02-infant-guardian", contentMode: "guardian", age: 2, currentYear: 2022, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [5, 6, 7, 8] },
  { id: "case-03-school-decision", contentMode: "standard", age: 6, currentYear: 2026, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [9, 10, 11, 12] },
  { id: "case-04-school-decision-guardian", contentMode: "guardian", age: 6, currentYear: 2026, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [13, 14, 15, 16] },
  { id: "case-05-sibling-flag", contentMode: "standard", age: 8, currentYear: 2028, stats: baseStats, assets: baseAssets, flags: ["family:sibling"], history: [], rngState: [17, 18, 19, 20] },
  { id: "case-06-teen-standard", contentMode: "standard", age: 13, currentYear: 2033, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [21, 22, 23, 24] },
  { id: "case-07-teen-negative-balance", contentMode: "standard", age: 16, currentYear: 2036, stats: { ...baseStats, knowledge: 70 }, assets: { ...baseAssets, balanceMicroUsd: "-1" }, flags: ["school:steady"], history: [], rngState: [25, 26, 27, 28] },
  { id: "case-08-exams-year", contentMode: "standard", age: 12, currentYear: 2032, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [29, 30, 31, 32] },
  { id: "case-09-adult-employed", contentMode: "standard", age: 25, currentYear: 2045, stats: { ...baseStats, knowledge: 70 }, assets: { ...baseAssets, annualIncomeMicroUsd: "20000000" }, flags: ["employed"], history: [{ eventId: "ev.teen.exams", lastYear: 2032, count: 1 }], rngState: [33, 34, 35, 36] },
  { id: "case-10-adult-guardian", contentMode: "guardian", age: 25, currentYear: 2045, stats: { ...baseStats, knowledge: 70 }, assets: { ...baseAssets, annualIncomeMicroUsd: "20000000" }, flags: ["employed"], history: [], rngState: [37, 38, 39, 40] },
  { id: "case-11-low-happiness", contentMode: "standard", age: 30, currentYear: 2050, stats: { ...baseStats, happiness: 20 }, assets: baseAssets, flags: ["employed"], history: [], rngState: [41, 42, 43, 44] },
  { id: "case-12-promotion-cooldown", contentMode: "standard", age: 30, currentYear: 2050, stats: { ...baseStats, knowledge: 80 }, assets: { ...baseAssets, annualIncomeMicroUsd: "30000000" }, flags: ["employed"], history: [{ eventId: "ev.adult.promotion", lastYear: 2049, count: 1 }], rngState: [45, 46, 47, 48] },
  { id: "case-13-community-flag", contentMode: "standard", age: 30, currentYear: 2050, stats: baseStats, assets: baseAssets, flags: ["community:member"], history: [], rngState: [49, 50, 51, 52] },
  { id: "case-14-setback-cooldown", contentMode: "standard", age: 40, currentYear: 2060, stats: baseStats, assets: baseAssets, flags: [], history: [{ eventId: "ev.any.setback", lastYear: 2059, count: 1 }], rngState: [53, 54, 55, 56] },
  { id: "case-15-debt", contentMode: "standard", age: 20, currentYear: 2040, stats: baseStats, assets: { ...baseAssets, balanceMicroUsd: "-500000000" }, flags: [], history: [], rngState: [57, 58, 59, 60] },
  { id: "case-16-senior-standard", contentMode: "standard", age: 70, currentYear: 2090, stats: { ...baseStats, health: 45 }, assets: { ...baseAssets, annualIncomeMicroUsd: "6000000" }, flags: [], history: [], rngState: [61, 62, 63, 64] },
  { id: "case-17-senior-guardian", contentMode: "guardian", age: 70, currentYear: 2090, stats: { ...baseStats, health: 45 }, assets: { ...baseAssets, annualIncomeMicroUsd: "6000000" }, flags: [], history: [], rngState: [65, 66, 67, 68] },
  { id: "case-18-late-life-100", contentMode: "standard", age: 100, currentYear: 2120, stats: { ...baseStats, health: 20, happiness: 40 }, assets: baseAssets, flags: [], history: [], rngState: [69, 70, 71, 72] },
  { id: "case-19-exams-taken", contentMode: "standard", age: 12, currentYear: 2032, stats: baseStats, assets: baseAssets, flags: [], history: [{ eventId: "ev.teen.exams", lastYear: 2032, count: 1 }], rngState: [73, 74, 75, 76] },
  { id: "case-20-no-promotion-knowledge", contentMode: "standard", age: 45, currentYear: 2065, stats: { ...baseStats, knowledge: 30 }, assets: baseAssets, flags: ["employed"], history: [], rngState: [77, 78, 79, 80] },
  { id: "case-21-all-zero-rng", contentMode: "standard", age: 3, currentYear: 2023, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [0, 0, 0, 0] },
  { id: "case-22-high-happiness", contentMode: "standard", age: 55, currentYear: 2075, stats: { health: 90, happiness: 95, knowledge: 88, relationships: 92 }, assets: { ...baseAssets, balanceMicroUsd: "123456789" }, flags: ["employed", "community:member"], history: [], rngState: [81, 82, 83, 84] },
  { id: "case-23-guardian-teen", contentMode: "guardian", age: 15, currentYear: 2035, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [85, 86, 87, 88] },
  { id: "case-24-tantrum-age", contentMode: "standard", age: 4, currentYear: 2024, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [89, 90, 91, 92] }
];

const edgeSpecs: readonly CaseSpec[] = [
  { id: "edge-01-single-candidate", contentMode: "standard", age: 30, currentYear: 2050, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [101, 102, 103, 104] },
  { id: "edge-02-no-candidate", contentMode: "standard", age: 30, currentYear: 2050, stats: baseStats, assets: baseAssets, flags: [], history: [{ eventId: "edge.only-one", lastYear: 2050, count: 1 }], rngState: [105, 106, 107, 108] },
  { id: "edge-03-two-candidates-guardian", contentMode: "guardian", age: 30, currentYear: 2050, stats: baseStats, assets: baseAssets, flags: [], history: [], rngState: [109, 110, 111, 112] },
  { id: "edge-04-single-after-once", contentMode: "guardian", age: 30, currentYear: 2050, stats: baseStats, assets: baseAssets, flags: [], history: [{ eventId: "edge.only-one", lastYear: 2050, count: 1 }], rngState: [113, 114, 115, 116] }
];

function toCase(spec: CaseSpec): EventCaseInput {
  return {
    id: spec.id,
    contentMode: spec.contentMode,
    history: { occurrences: spec.history } as P3BEventHistory,
    rngState: spec.rngState,
    state: {
      currentYear: spec.currentYear,
      age: spec.age,
      phase: "life",
      stats: spec.stats,
      assets: spec.assets,
      flags: spec.flags
    }
  };
}

function loadPack(manifestFile: string, eventsFile: string): { manifest: P3BEventPackManifest; records: P3BEventRecord[] } {
  const manifest = JSON.parse(readFileSync(join(DIR, manifestFile), "utf8")) as P3BEventPackManifest;
  const dataset = JSON.parse(readFileSync(join(DIR, eventsFile), "utf8")) as { records: P3BEventRecord[] };
  return { manifest, records: dataset.records };
}

function buildPackSection(manifestFile: string, eventsFile: string, specs: readonly CaseSpec[]) {
  const pack = loadPack(manifestFile, eventsFile);
  const cases = specs.map(toCase);
  const digests = runEventCases({ manifest: pack.manifest, events: pack.records }, cases);
  return {
    packId: pack.manifest.eventPackId,
    manifestFile,
    eventsFile,
    packChecksum: pack.manifest.packChecksum,
    datasetChecksum: pack.manifest.datasets[0]?.checksum ?? "",
    cases: cases.map((entry, index) => {
      const digest = digests[index] as EventCaseDigest;
      return {
        id: entry.id,
        contentMode: entry.contentMode,
        state: entry.state,
        history: entry.history,
        rngState: entry.rngState,
        candidateIds: digest.candidateIds,
        selectedEventId: digest.selectedEventId,
        reason: digest.reason,
        drawsUsed: digest.drawsUsed,
        rngStateAfter: digest.rngStateAfter,
        selectionHash: digest.selectionHash
      };
    })
  };
}

const main = loadPack("manifest.v1.json", "events.v1.json");
const golden = {
  schemaVersion: "p3b-1",
  eventSpecVersion: main.manifest.eventSpecVersion,
  contentPackVersion: main.manifest.contentPackVersion,
  packs: [
    buildPackSection("manifest.v1.json", "events.v1.json", mainSpecs),
    buildPackSection("edge-manifest.v1.json", "edge-events.v1.json", edgeSpecs)
  ]
};

writeFileSync(join(DIR, "golden-event-vectors.v1.json"), `${JSON.stringify(golden, null, 2)}\n`, "utf8");
const total = golden.packs.reduce((sum, pack) => sum + pack.cases.length, 0);
console.log(`P3B-GOLDEN-OK packs=${golden.packs.length} cases=${total}`);
