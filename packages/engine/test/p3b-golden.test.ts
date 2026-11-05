import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { P3BEventPackManifest, P3BEventRecord } from "@life-sim/contracts";
import { runEventCases, type EventCaseInput } from "../src/life/events/browser";
import { validateEventPack } from "../src/life/events";

/**
 * P3-B golden：Node 與 Chromium／WebKit 共用同一份 `golden-event-vectors.v1.json`。
 * 這裡驗 Node 端能逐位元重現；`pnpm test:p3b-browser` 驗兩個瀏覽器引擎一致。
 */

const ROOT = process.cwd();
const DIR = join(ROOT, "fixtures", "p3b");

interface GoldenCase {
  readonly id: string;
  readonly contentMode: "standard" | "guardian";
  readonly state: {
    currentYear: number;
    age: number;
    phase: string;
    stats: { health: number; happiness: number; knowledge: number; relationships: number };
    assets: { balanceMicroUsd: string; annualIncomeMicroUsd: string; annualExpenseMicroUsd: string };
    flags: readonly string[];
  };
  readonly history: { occurrences: readonly { eventId: string; lastYear: number; count: number }[] };
  readonly rngState: readonly [number, number, number, number];
  readonly candidateIds: readonly string[];
  readonly selectedEventId: string | null;
  readonly reason: string;
  readonly drawsUsed: number;
  readonly rngStateAfter: readonly number[];
  readonly selectionHash: string;
}

interface GoldenPack {
  readonly packId: string;
  readonly manifestFile: string;
  readonly eventsFile: string;
  readonly packChecksum: string;
  readonly datasetChecksum: string;
  readonly cases: readonly GoldenCase[];
}

const golden = JSON.parse(readFileSync(join(DIR, "golden-event-vectors.v1.json"), "utf8")) as {
  schemaVersion: string;
  eventSpecVersion: string;
  contentPackVersion: string;
  packs: readonly GoldenPack[];
};

function loadPack(section: GoldenPack): { manifest: P3BEventPackManifest; events: P3BEventRecord[] } {
  return {
    manifest: JSON.parse(readFileSync(join(DIR, section.manifestFile), "utf8")) as P3BEventPackManifest,
    events: (JSON.parse(readFileSync(join(DIR, section.eventsFile), "utf8")) as { records: P3BEventRecord[] }).records
  };
}

function run(section: GoldenPack) {
  const pack = loadPack(section);
  const cases: EventCaseInput[] = section.cases.map((entry) => ({
    id: entry.id,
    contentMode: entry.contentMode,
    state: entry.state as EventCaseInput["state"],
    history: entry.history as unknown as EventCaseInput["history"],
    rngState: entry.rngState
  }));
  return { pack, digests: runEventCases(pack, cases) };
}

describe("P3-B golden：Node 端重現", () => {
  it("reproduces every golden digest bit-for-bit", () => {
    expect(golden.packs).toHaveLength(2);
    for (const section of golden.packs) {
      const { digests } = run(section);
      expect(digests).toHaveLength(section.cases.length);
      for (let index = 0; index < section.cases.length; index += 1) {
        const expected = section.cases[index] as GoldenCase;
        const actual = digests[index] as NonNullable<(typeof digests)[number]>;
        expect(actual.id).toBe(expected.id);
        expect(actual.candidateIds).toEqual(expected.candidateIds);
        expect(actual.selectedEventId).toBe(expected.selectedEventId);
        expect(actual.reason).toBe(expected.reason);
        expect(actual.drawsUsed).toBe(expected.drawsUsed);
        expect(actual.rngStateAfter).toEqual(expected.rngStateAfter);
        expect(actual.selectionHash).toBe(expected.selectionHash);
      }
    }
  });

  it("is independent of record order and repetition", () => {
    for (const section of golden.packs) {
      const pack = loadPack(section);
      const cases: EventCaseInput[] = section.cases.map((entry) => ({
        id: entry.id,
        contentMode: entry.contentMode,
        state: entry.state as EventCaseInput["state"],
        history: entry.history as unknown as EventCaseInput["history"],
        rngState: entry.rngState
      }));
      const first = runEventCases(pack, cases);
      const second = runEventCases(pack, cases);
      expect(second).toEqual(first);

      const reversed = validateEventPack({ manifest: pack.manifest, events: [...pack.events].reverse() });
      const third = runEventCases({ manifest: pack.manifest, events: [...reversed.events] }, cases);
      expect(third).toEqual(first);
    }
  });

  it("keeps every golden case's pack checksum", () => {
    for (const section of golden.packs) {
      const pack = loadPack(section);
      expect(pack.manifest.packChecksum).toBe(section.packChecksum);
      expect(pack.manifest.datasets[0]?.checksum).toBe(section.datasetChecksum);
      expect(pack.manifest.eventPackId).toBe(section.packId);
    }
  });

  it("covers the zero / single / weighted draw branches", () => {
    const reasons = new Set(golden.packs.flatMap((section) => section.cases.map((entry) => entry.reason)));
    expect(reasons.has("no_candidates")).toBe(true);
    expect(reasons.has("single_candidate")).toBe(true);
    expect(reasons.has("weighted")).toBe(true);
    const zeroDraws = golden.packs.flatMap((section) => section.cases).filter((entry) => entry.drawsUsed === 0);
    expect(zeroDraws.length).toBeGreaterThanOrEqual(3);
  });
});
