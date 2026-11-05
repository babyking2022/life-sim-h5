import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  P3BDatasetDescriptor,
  P3BEventPackManifest,
  P3BEventRecord,
  P3BLicenseRecord,
  P3BLineageRecord
} from "@life-sim/contracts";
import { computeEventsChecksum, computePackChecksum } from "../packages/engine/src/life/events/validate";

/**
 * P3-C fixture 產生器（synthetic，只給工程測試用）。
 *
 * 產生兩個事件 pack：
 * - `p3c-main-events-v1`：7 個事件，覆蓋「0 候選」「單候選 0 draws」「多候選加權」、
 *   once／cooldown／exclusiveGroup／contentMode／informational／decision，
 *   並且把唯一的 decision 事件鎖在 age 5（那一年只有它一個候選 → 決定性、可預測）。
 * - `p3c-edge-events-v1`：2 個事件，讓單候選／0 候選／guardian 過濾可以精準控制。
 *
 * checksum 一律由 `packages/engine` 的正式函式算出（dataset／license／lineage／pack），
 * 因此產出的 pack 可以通過 `validateEventPack`。**不是正式事件庫**。
 */

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "fixtures", "p3c");
const SOURCE_ID = "p3c-synthetic-events-v1-source";
const EDGE_SOURCE_ID = "p3c-synthetic-edges-v1-source";
const CREATED_AT = "2026-10-28T00:00:00.000Z";

type EventInit = Partial<P3BEventRecord> & Pick<P3BEventRecord, "eventId" | "localizationKey">;

function event(init: EventInit): P3BEventRecord {
  const base: P3BEventRecord = {
    eventId: init.eventId,
    eventSpecVersion: "1.0.0",
    contentPackVersion: "1.0.0",
    kind: "ordinary",
    localizationKey: init.localizationKey,
    ageMin: 0,
    ageMax: 120,
    lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
    conditions: null,
    weight: 10,
    priority: 0,
    once: false,
    cooldownYears: 0,
    exclusiveGroup: null,
    contentMode: "guardian",
    effects: [],
    decision: null,
    sourceId: SOURCE_ID
  };
  return { ...base, ...init } as P3BEventRecord;
}

const MAIN_EVENTS: readonly P3BEventRecord[] = [
  event({
    eventId: "ev.p3c.child.decision",
    localizationKey: "p3c.child.decision",
    kind: "decision",
    ageMin: 5,
    ageMax: 5,
    lifeStages: ["childhood"],
    weight: 1,
    priority: 100,
    once: true,
    exclusiveGroup: "p3c.choice",
    effects: [{ type: "openDecision", decisionId: "dec.p3c.choice" }],
    decision: {
      decisionId: "dec.p3c.choice",
      promptKey: "p3c.child.decision.prompt",
      options: [
        {
          optionId: "alpha",
          labelKey: "p3c.child.decision.alpha",
          effects: [
            { type: "stat", stat: "happiness", delta: 5 },
            { type: "flag", flag: "p3c:alpha", action: "add" }
          ]
        },
        {
          optionId: "beta",
          labelKey: "p3c.child.decision.beta",
          effects: [
            { type: "money", field: "balanceMicroUsd", deltaMicroUsd: "1000000" },
            { type: "flag", flag: "p3c:beta", action: "add" }
          ]
        }
      ]
    }
  }),
  event({
    eventId: "ev.p3c.ordinary",
    localizationKey: "p3c.ordinary",
    ageMin: 6,
    weight: 5,
    effects: [
      { type: "stat", stat: "health", delta: 2 },
      { type: "stat", stat: "happiness", delta: -1 },
      { type: "money", field: "balanceMicroUsd", deltaMicroUsd: "500000" },
      { type: "flag", flag: "p3c:ordinary", action: "add" }
    ]
  }),
  event({
    eventId: "ev.p3c.once",
    localizationKey: "p3c.once",
    ageMin: 6,
    weight: 1,
    once: true,
    effects: [{ type: "stat", stat: "knowledge", delta: 3 }]
  }),
  event({
    eventId: "ev.p3c.cooldown",
    localizationKey: "p3c.cooldown",
    ageMin: 6,
    weight: 1,
    cooldownYears: 3,
    effects: [{ type: "stat", stat: "relationships", delta: 2 }]
  }),
  event({
    eventId: "ev.p3c.informational",
    localizationKey: "p3c.informational",
    ageMin: 6,
    weight: 1,
    conditions: { op: "flag", flag: "p3c:ordinary", present: true },
    effects: [{ type: "informational" }]
  }),
  event({
    eventId: "ev.p3c.guardian.only",
    localizationKey: "p3c.guardian_only",
    ageMin: 6,
    weight: 1,
    conditions: { op: "contentMode", mode: "guardian" },
    effects: [{ type: "stat", stat: "happiness", delta: 1 }]
  }),
  event({
    eventId: "ev.p3c.late",
    localizationKey: "p3c.late",
    ageMin: 60,
    lifeStages: ["later_life"],
    weight: 1,
    effects: [{ type: "stat", stat: "health", delta: -5 }]
  })
];

const EDGE_EVENTS: readonly P3BEventRecord[] = [
  {
    ...event({
      eventId: "ev.p3c.edge.solo",
      localizationKey: "p3c.edge.solo",
      ageMin: 1,
      ageMax: 1,
      lifeStages: ["childhood"],
      weight: 7,
      once: true,
      sourceId: EDGE_SOURCE_ID,
      effects: [
        { type: "stat", stat: "happiness", delta: 1 },
        { type: "flag", flag: "p3c:edge", action: "add" }
      ]
    })
  },
  event({
    eventId: "ev.p3c.edge.guardian",
    localizationKey: "p3c.edge.guardian",
    ageMin: 2,
    weight: 11,
    sourceId: EDGE_SOURCE_ID,
    conditions: { op: "contentMode", mode: "guardian" },
    effects: [{ type: "stat", stat: "health", delta: -1 }]
  })
];

interface PackSection {
  readonly eventPackId: string;
  readonly eventsFile: string;
  readonly manifestFile: string;
  readonly sourceId: string;
  readonly events: readonly P3BEventRecord[];
  readonly datasetLabel: string;
  readonly transform: string;
}

function licenseFor(eventPackId: string, sourceId: string, checksum: string, datasetLabel: string): P3BLicenseRecord {
  return {
    sourceId,
    datasetId: "events",
    datasetLabel,
    sourceKind: "synthetic",
    sourceName: "life-sim P3-C synthetic fixture generator",
    sourceUrl: null,
    version: "1.0.0",
    retrievedAt: CREATED_AT,
    license: "granted",
    licenseId: "synthetic-generated",
    commercialUse: "allowed",
    legalStatus: "cleared",
    evidence: ["generated by scripts/p3c-generate-fixtures.ts for engineering tests only"],
    grant: null,
    checksum,
    lineageId: `lin.${eventPackId}.events`,
    notes: "synthetic skeleton; not production content"
  };
}

function lineageFor(eventPackId: string, checksum: string, transform: string): P3BLineageRecord {
  return {
    lineageId: `lin.${eventPackId}.events`,
    datasetId: "events",
    parentLineageIds: [],
    transform,
    generatedBy: "scripts/p3c-generate-fixtures.ts",
    generatedAt: CREATED_AT,
    inputChecksums: [],
    outputChecksum: checksum,
    notes: "no upstream dataset; values are authored for engineering tests"
  };
}

function writePack(section: PackSection): void {
  const sorted = [...section.events].sort((left, right) => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0));
  const datasetChecksum = computeEventsChecksum(sorted);
  const dataset: P3BDatasetDescriptor = {
    datasetId: "events",
    fileName: section.eventsFile,
    recordCount: sorted.length,
    checksum: datasetChecksum
  };
  const manifestWithoutChecksum = {
    schemaVersion: "p3b-1" as const,
    eventSpecVersion: "1.0.0",
    contentPackVersion: "1.0.0",
    eventPackId: section.eventPackId,
    packKind: "synthetic" as const,
    createdAt: CREATED_AT,
    engineVersion: "0.1.0",
    rngSpecVersion: "1.0.0",
    datasets: [dataset],
    licenses: [licenseFor(section.eventPackId, section.sourceId, datasetChecksum, section.datasetLabel)],
    lineage: [lineageFor(section.eventPackId, datasetChecksum, section.transform)]
  };
  const packChecksum = computePackChecksum(manifestWithoutChecksum as P3BEventPackManifest);
  const manifest: P3BEventPackManifest = { ...manifestWithoutChecksum, packChecksum } as P3BEventPackManifest;
  writeFileSync(
    join(OUT_DIR, section.eventsFile),
    `${JSON.stringify({ schemaVersion: "p3b-1", contentPackVersion: "1.0.0", dataset: "events", records: sorted }, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(join(OUT_DIR, section.manifestFile), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `${section.eventPackId}: events=${sorted.length} datasetChecksum=${datasetChecksum.slice(0, 12)}… packChecksum=${packChecksum.slice(0, 12)}…`
  );
}

mkdirSync(OUT_DIR, { recursive: true });
writePack({
  eventPackId: "p3c-main-events-v1",
  eventsFile: "events.v1.json",
  manifestFile: "manifest.v1.json",
  sourceId: SOURCE_ID,
  events: MAIN_EVENTS,
  datasetLabel: "p3c-main-events-v1 synthetic event pack",
  transform: "deterministic synthetic P3-C event pack v1 (no external input)"
});
writePack({
  eventPackId: "p3c-edge-events-v1",
  eventsFile: "edge-events.v1.json",
  manifestFile: "edge-manifest.v1.json",
  sourceId: EDGE_SOURCE_ID,
  events: EDGE_EVENTS,
  datasetLabel: "p3c-edge-events-v1 synthetic edge-case pack",
  transform: "deterministic synthetic P3-C edge pack v1 (single/no candidate control)"
});
console.log("P3C-FIXTURES-OK");
