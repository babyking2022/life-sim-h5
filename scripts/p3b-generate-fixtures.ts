import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { P3BEventPackManifest, P3BEventRecord, P3BLicenseRecord, P3BLineageRecord } from "@life-sim/contracts";
import {
  P3B_ENGINE_VERSION,
  P3B_EVENT_SPEC_VERSION,
  P3B_RNG_SPEC_VERSION,
  P3B_SCHEMA_VERSION
} from "../packages/contracts/src/p3b";
import { computeEventsChecksum, computePackChecksum, validateEventPack } from "../packages/engine/src/life/events";

/**
 * P3-B 合成事件 fixture 產生器（deterministic）。
 *
 * 產出兩份 pack：
 * - `events.v1.json`：22 筆的主 pack（多候選加權抽選、條件、效果、抉擇）。
 * - `edge-events.v1.json`：2 筆的邊界 pack（只為覆蓋 0／1 候選與 guardian 過濾）。
 *
 * 文案全部是 `localizationKey`；授權與 lineage 由 canonical 函式算出，
 * 產生器與驗證器不可能各自維護一套規則。
 */

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "fixtures", "p3b");
const CREATED_AT = "2026-10-27T00:00:00.000Z";
const GENERATED_AT = "2026-10-27T00:00:00.000Z";
const CONTENT_PACK_VERSION = "1.0.0";

const sourceIdOf = (packId: string) => `${packId}-source`;

const stat = (key: "health" | "happiness" | "knowledge" | "relationships", delta: number) => ({ type: "stat" as const, stat: key, delta });
const money = (field: "balanceMicroUsd" | "annualIncomeMicroUsd" | "annualExpenseMicroUsd", deltaMicroUsd: string) => ({
  type: "money" as const,
  field,
  deltaMicroUsd
});
const flag = (name: string, action: "add" | "remove") => ({ type: "flag" as const, flag: name, action });
const info = () => ({ type: "informational" as const });

function makeEventFactory(sourceId: string) {
  return (
    record: Partial<P3BEventRecord> &
      Pick<P3BEventRecord, "eventId" | "kind" | "localizationKey" | "ageMin" | "ageMax" | "lifeStages" | "weight">
  ): P3BEventRecord =>
    ({
      eventSpecVersion: P3B_EVENT_SPEC_VERSION,
      contentPackVersion: CONTENT_PACK_VERSION,
      conditions: null,
      priority: 0,
      once: false,
      cooldownYears: 0,
      exclusiveGroup: null,
      contentMode: "guardian",
      effects: [info()],
      decision: null,
      sourceId,
      ...record
    }) as P3BEventRecord;
}

function buildEdgeEvents(): P3BEventRecord[] {
  const event = makeEventFactory(sourceIdOf("p3b-synthetic-edges-v1"));
  return [
    event({
      eventId: "edge.only-one",
      kind: "ordinary",
      localizationKey: "p3b.edge.only_one",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 7,
      once: true,
      effects: [stat("happiness", 1)]
    }),
    event({
      eventId: "edge.guardian-only",
      kind: "ordinary",
      localizationKey: "p3b.edge.guardian_only",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 11,
      contentMode: "guardian",
      conditions: { op: "contentMode", mode: "guardian" },
      effects: [stat("happiness", 2)]
    })
  ];
}

function buildMainEvents(): P3BEventRecord[] {
  const sourceId = sourceIdOf("p3b-synthetic-events-v1");
  const event = makeEventFactory(sourceId);
  const decisionOption = (optionId: string, labelKey: string, effects: P3BEventRecord["effects"]) => ({ optionId, labelKey, effects });
  return [
    event({
      eventId: "ev.child.first-word",
      kind: "milestone",
      localizationKey: "p3b.event.child.first_word",
      ageMin: 1,
      ageMax: 3,
      lifeStages: ["childhood"],
      weight: 30,
      priority: 10,
      once: true,
      effects: [stat("knowledge", 2), stat("happiness", 3)]
    }),
    event({
      eventId: "ev.child.playground",
      kind: "ordinary",
      localizationKey: "p3b.event.child.playground",
      ageMin: 4,
      ageMax: 11,
      lifeStages: ["childhood"],
      weight: 120,
      cooldownYears: 2,
      conditions: { op: "stat", stat: "health", min: 30, max: 100 },
      effects: [stat("relationships", 2), stat("happiness", 1)]
    }),
    event({
      eventId: "ev.child.school-choice",
      kind: "decision",
      localizationKey: "p3b.event.child.school_choice",
      ageMin: 6,
      ageMax: 6,
      lifeStages: ["childhood"],
      weight: 1,
      priority: 100,
      once: true,
      exclusiveGroup: "child.major",
      effects: [{ type: "openDecision", decisionId: "dec.child.school" }],
      decision: {
        decisionId: "dec.child.school",
        promptKey: "p3b.decision.child.school",
        options: [
          decisionOption("steady", "p3b.option.child.school.steady", [stat("knowledge", 3), flag("school:steady", "add")]),
          decisionOption("bold", "p3b.option.child.school.bold", [stat("knowledge", 1), stat("happiness", 2), flag("school:bold", "add")])
        ]
      }
    }),
    event({
      eventId: "ev.child.sibling-arrives",
      kind: "milestone",
      localizationKey: "p3b.event.child.sibling",
      ageMin: 2,
      ageMax: 8,
      lifeStages: ["childhood"],
      weight: 20,
      once: true,
      conditions: { op: "not", condition: { op: "flag", flag: "family:sibling", present: true } },
      effects: [flag("family:sibling", "add"), stat("relationships", 3)]
    }),
    event({
      eventId: "ev.child.tantrum",
      kind: "ordinary",
      localizationKey: "p3b.event.child.tantrum",
      ageMin: 2,
      ageMax: 6,
      lifeStages: ["childhood"],
      weight: 60,
      cooldownYears: 1,
      contentMode: "standard",
      effects: [stat("happiness", -2), stat("relationships", -1)]
    }),
    event({
      eventId: "ev.teen.exams",
      kind: "milestone",
      localizationKey: "p3b.event.teen.exams",
      ageMin: 12,
      ageMax: 12,
      lifeStages: ["adolescence"],
      weight: 1,
      priority: 100,
      once: true,
      effects: [stat("knowledge", 4)]
    }),
    event({
      eventId: "ev.teen.friendship",
      kind: "ordinary",
      localizationKey: "p3b.event.teen.friendship",
      ageMin: 13,
      ageMax: 17,
      lifeStages: ["adolescence"],
      weight: 90,
      cooldownYears: 2,
      effects: [stat("relationships", 2)]
    }),
    event({
      eventId: "ev.teen.part-time-job",
      kind: "ordinary",
      localizationKey: "p3b.event.teen.part_time_job",
      ageMin: 15,
      ageMax: 17,
      lifeStages: ["adolescence"],
      weight: 40,
      conditions: { op: "money", field: "balanceMicroUsd", min: "-1000000000", max: "500000000" },
      effects: [money("balanceMicroUsd", "1500000"), stat("knowledge", 1), stat("health", -1)]
    }),
    event({
      eventId: "ev.teen.risk-experiment",
      kind: "ordinary",
      localizationKey: "p3b.event.teen.risk_experiment",
      ageMin: 14,
      ageMax: 17,
      lifeStages: ["adolescence"],
      weight: 25,
      contentMode: "standard",
      effects: [stat("health", -4), stat("happiness", 2)]
    }),
    event({
      eventId: "ev.teen.major-choice",
      kind: "decision",
      localizationKey: "p3b.event.teen.major_choice",
      ageMin: 18,
      ageMax: 18,
      lifeStages: ["adulthood", "adolescence"],
      weight: 1,
      priority: 100,
      once: true,
      exclusiveGroup: "adult.major",
      effects: [{ type: "openDecision", decisionId: "dec.teen.path" }],
      decision: {
        decisionId: "dec.teen.path",
        promptKey: "p3b.decision.teen.path",
        options: [
          decisionOption("study", "p3b.option.teen.path.study", [stat("knowledge", 5), money("annualExpenseMicroUsd", "2000000")]),
          decisionOption("work", "p3b.option.teen.path.work", [money("annualIncomeMicroUsd", "3000000"), stat("knowledge", 1)]),
          decisionOption("rest", "p3b.option.teen.path.rest", [stat("health", 3), stat("happiness", 2)])
        ]
      }
    }),
    event({
      eventId: "ev.adult.first-salary",
      kind: "milestone",
      localizationKey: "p3b.event.adult.first_salary",
      ageMin: 19,
      ageMax: 24,
      lifeStages: ["adulthood"],
      weight: 50,
      once: true,
      conditions: { op: "flag", flag: "employed", present: true },
      effects: [money("balanceMicroUsd", "5000000"), stat("happiness", 3)]
    }),
    event({
      eventId: "ev.adult.promotion",
      kind: "ordinary",
      localizationKey: "p3b.event.adult.promotion",
      ageMin: 22,
      ageMax: 60,
      lifeStages: ["adulthood"],
      weight: 45,
      cooldownYears: 3,
      conditions: {
        op: "all",
        conditions: [
          { op: "flag", flag: "employed", present: true },
          { op: "stat", stat: "knowledge", min: 40, max: 100 }
        ]
      },
      effects: [money("annualIncomeMicroUsd", "4000000"), stat("happiness", 2)]
    }),
    event({
      eventId: "ev.adult.burnout",
      kind: "ordinary",
      localizationKey: "p3b.event.adult.burnout",
      ageMin: 25,
      ageMax: 60,
      lifeStages: ["adulthood"],
      weight: 30,
      cooldownYears: 4,
      conditions: { op: "stat", stat: "happiness", min: 0, max: 35 },
      effects: [stat("health", -5), stat("happiness", -3)]
    }),
    event({
      eventId: "ev.adult.housing-choice",
      kind: "decision",
      localizationKey: "p3b.event.adult.housing_choice",
      ageMin: 25,
      ageMax: 40,
      lifeStages: ["adulthood"],
      weight: 1,
      priority: 90,
      once: true,
      exclusiveGroup: "adult.major",
      effects: [{ type: "openDecision", decisionId: "dec.adult.housing" }],
      decision: {
        decisionId: "dec.adult.housing",
        promptKey: "p3b.decision.adult.housing",
        options: [
          decisionOption("rent", "p3b.option.adult.housing.rent", [money("annualExpenseMicroUsd", "9000000")]),
          decisionOption("save", "p3b.option.adult.housing.save", [money("balanceMicroUsd", "2000000")])
        ]
      }
    }),
    event({
      eventId: "ev.adult.volunteer",
      kind: "ordinary",
      localizationKey: "p3b.event.adult.volunteer",
      ageMin: 20,
      ageMax: 70,
      lifeStages: ["adulthood", "later_life"],
      weight: 25,
      conditions: { op: "flag", flag: "community:member", present: true },
      effects: [stat("relationships", 3), stat("happiness", 1)]
    }),
    event({
      eventId: "ev.adult.debt-scare",
      kind: "ordinary",
      localizationKey: "p3b.event.adult.debt_scare",
      ageMin: 20,
      ageMax: 65,
      lifeStages: ["adulthood"],
      weight: 20,
      cooldownYears: 5,
      conditions: { op: "money", field: "balanceMicroUsd", min: "-100000000000", max: "-1" },
      effects: [stat("happiness", -4), money("annualExpenseMicroUsd", "1000000")]
    }),
    event({
      eventId: "ev.any.small-win",
      kind: "ordinary",
      localizationKey: "p3b.event.any.small_win",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 70,
      conditions: { op: "cooldown", eventId: "ev.any.setback", years: 2 },
      effects: [stat("happiness", 2), money("balanceMicroUsd", "300000")]
    }),
    event({
      eventId: "ev.any.setback",
      kind: "ordinary",
      localizationKey: "p3b.event.any.setback",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 35,
      cooldownYears: 2,
      effects: [stat("happiness", -2), money("balanceMicroUsd", "-400000")]
    }),
    event({
      eventId: "ev.any.quiet-year",
      kind: "ordinary",
      localizationKey: "p3b.event.any.quiet_year",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 10,
      conditions: { op: "happened", eventId: "ev.any.setback" },
      effects: [info()]
    }),
    event({
      eventId: "ev.senior.health-check",
      kind: "ordinary",
      localizationKey: "p3b.event.senior.health_check",
      ageMin: 65,
      ageMax: 120,
      lifeStages: ["later_life"],
      weight: 80,
      cooldownYears: 2,
      effects: [stat("health", 2), money("annualExpenseMicroUsd", "800000")]
    }),
    event({
      eventId: "ev.senior.reflection",
      kind: "milestone",
      localizationKey: "p3b.event.senior.reflection",
      ageMin: 70,
      ageMax: 120,
      lifeStages: ["later_life"],
      weight: 40,
      once: true,
      effects: [stat("happiness", 4)]
    }),
    event({
      eventId: "ev.guardian.calm",
      kind: "ordinary",
      localizationKey: "p3b.event.guardian.calm",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 55,
      contentMode: "guardian",
      conditions: { op: "contentMode", mode: "guardian" },
      effects: [stat("happiness", 1)]
    })
  ];
}

interface BuiltPack {
  readonly packId: string;
  readonly manifestFileName: string;
  readonly eventsFileName: string;
  readonly manifest: P3BEventPackManifest;
  readonly events: readonly P3BEventRecord[];
}

function buildPack(packId: string, manifestFileName: string, eventsFileName: string, events: readonly P3BEventRecord[]): BuiltPack {
  const sorted = [...events].sort((left, right) => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0));
  const eventsChecksum = computeEventsChecksum(sorted);
  const sourceId = sourceIdOf(packId);
  const license: P3BLicenseRecord = {
    sourceId,
    datasetId: "events",
    datasetLabel: `${packId} synthetic event pack`,
    sourceKind: "synthetic",
    sourceName: "life-sim synthetic generator",
    sourceUrl: null,
    version: CONTENT_PACK_VERSION,
    retrievedAt: CREATED_AT,
    license: "granted",
    licenseId: "synthetic-generated",
    commercialUse: "allowed",
    legalStatus: "cleared",
    evidence: ["generated by scripts/p3b-generate-fixtures.ts for engineering tests only"],
    grant: null,
    checksum: eventsChecksum,
    lineageId: `lin.${packId}.events`,
    notes: "synthetic skeleton; not production content"
  };
  const lineage: P3BLineageRecord = {
    lineageId: `lin.${packId}.events`,
    datasetId: "events",
    parentLineageIds: [],
    transform: "deterministic synthetic event pack v1 (no external input)",
    generatedBy: "scripts/p3b-generate-fixtures.ts",
    generatedAt: GENERATED_AT,
    inputChecksums: [],
    outputChecksum: eventsChecksum,
    notes: "no upstream dataset; values are authored for engineering tests"
  };
  const manifestWithoutChecksum: P3BEventPackManifest = {
    schemaVersion: P3B_SCHEMA_VERSION,
    eventSpecVersion: P3B_EVENT_SPEC_VERSION,
    contentPackVersion: CONTENT_PACK_VERSION,
    eventPackId: packId,
    packKind: "synthetic",
    createdAt: CREATED_AT,
    engineVersion: P3B_ENGINE_VERSION,
    rngSpecVersion: P3B_RNG_SPEC_VERSION,
    datasets: [{ datasetId: "events", fileName: eventsFileName, recordCount: sorted.length, checksum: eventsChecksum }],
    licenses: [license],
    lineage: [lineage],
    packChecksum: "0".repeat(64)
  };
  const manifest: P3BEventPackManifest = { ...manifestWithoutChecksum, packChecksum: computePackChecksum(manifestWithoutChecksum) };
  // 自我驗證：產生器產出的東西必須通過驗證器。
  validateEventPack({ manifest, events: sorted as P3BEventRecord[] });
  return { packId, manifestFileName, eventsFileName, manifest, events: sorted };
}

function writePack(pack: BuiltPack): void {
  writeFileSync(join(OUT_DIR, pack.manifestFileName), `${JSON.stringify(pack.manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    join(OUT_DIR, pack.eventsFileName),
    `${JSON.stringify(
      { schemaVersion: P3B_SCHEMA_VERSION, contentPackVersion: CONTENT_PACK_VERSION, dataset: "events", records: pack.events },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const main = buildPack("p3b-synthetic-events-v1", "manifest.v1.json", "events.v1.json", buildMainEvents());
  const edge = buildPack("p3b-synthetic-edges-v1", "edge-manifest.v1.json", "edge-events.v1.json", buildEdgeEvents());
  writePack(main);
  writePack(edge);

  const reloaded = JSON.parse(readFileSync(join(OUT_DIR, "manifest.v1.json"), "utf8")) as P3BEventPackManifest;
  if (reloaded.packChecksum !== main.manifest.packChecksum) throw new Error("manifest roundtrip mismatch");
  const eventsFile = JSON.parse(readFileSync(join(OUT_DIR, "events.v1.json"), "utf8")) as { records: unknown[] };
  if (eventsFile.records.length !== main.events.length) throw new Error("events file mismatch");
  console.log(
    `P3B-FIXTURES-OK main=${main.events.length} edge=${edge.events.length} ` +
      `mainChecksum=${main.manifest.packChecksum.slice(0, 12)}… edgeChecksum=${edge.manifest.packChecksum.slice(0, 12)}…`
  );
}

main();
