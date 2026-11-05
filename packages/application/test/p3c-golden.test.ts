import { describe, expect, it } from "vitest";
import { buildPeerGroup, createBirthCertificate, validateDataPack, validateIdentityPack } from "@life-sim/birth";
import { validateEventPack } from "@life-sim/engine";
import { createEventLifeFromCertificate } from "../src/event-life";
import { advanceEventLife, createEventLifeLedger } from "../src/event-ledger";
import { eventLifeDigest } from "../src/p3c-browser";
import golden from "../../../fixtures/p3c/golden-event-life-vectors.v1.json";
import baseManifest from "../../../fixtures/p2a/manifest.v1.json";
import registry from "../../../fixtures/p2a/country-registry.v1.json";
import indicators from "../../../fixtures/p2a/indicators.v1.json";
import birthWeights from "../../../fixtures/p2a/birth-weights.v1.json";
import sensitiveNames from "../../../fixtures/p2a/sensitive-names.v1.json";
import baseLicenses from "../../../fixtures/p2a/licenses.v1.json";
import baseLineage from "../../../fixtures/p2a/lineage.v1.json";
import identityManifest from "../../../fixtures/p2b/manifest.v1.json";
import vitals from "../../../fixtures/p2b/country-vitals.v1.json";
import profiles from "../../../fixtures/p2b/household-profiles.v1.json";
import names from "../../../fixtures/p2b/name-corpus.v1.json";
import stories from "../../../fixtures/p2b/story-templates.v1.json";
import identityLicenses from "../../../fixtures/p2b/licenses.v1.json";
import identityLineage from "../../../fixtures/p2b/lineage.v1.json";
import p3bManifest from "../../../fixtures/p3b/manifest.v1.json";
import p3bEvents from "../../../fixtures/p3b/events.v1.json";
import p3cManifest from "../../../fixtures/p3c/manifest.v1.json";
import p3cEvents from "../../../fixtures/p3c/events.v1.json";

/**
 * P3-C golden vectors：Node 端逐位元重算，並驗證兩個 section 的覆蓋面。
 */

const base = validateDataPack({
  manifest: baseManifest,
  datasets: {
    "country-registry": registry,
    indicators,
    "birth-weights": birthWeights,
    "sensitive-names": sensitiveNames,
    licenses: baseLicenses,
    lineage: baseLineage
  }
} as never);
const identityPack = validateIdentityPack(base, {
  manifest: identityManifest,
  datasets: {
    "country-vitals": vitals,
    "household-profiles": profiles,
    "name-corpus": names,
    "story-templates": stories,
    licenses: identityLicenses,
    lineage: identityLineage
  }
} as never);

const packs: Record<string, unknown> = {
  "p3b-main": { manifest: p3bManifest, events: (p3bEvents as { records: unknown[] }).records },
  "p3c-fixture": { manifest: p3cManifest, events: (p3cEvents as { records: unknown[] }).records }
};

function runCase(packId: string, entry: (typeof golden.sections)[number]["cases"][number]) {
  const pack = validateEventPack(packs[packId]);
  const group = buildPeerGroup(base, identityPack, { seed: entry.seed, playerSexPolicy: entry.playerSexPolicy as never });
  const certificate = createBirthCertificate(base, identityPack, group, entry.seed);
  let { state } = createEventLifeFromCertificate(base, identityPack, { certificate, masterSeed: entry.seed, eventPack: pack });
  const ledger = createEventLifeLedger();
  ({ state } = advanceEventLife(state, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }, pack));
  let guardCounter = 0;
  while (state.history.yearsRecorded < entry.years && state.phase !== "death" && state.phase !== "error") {
    if (state.pendingDecision !== null) {
      const optionIds = [...state.pendingDecision.options.map((option) => option.optionId)].sort();
      ({ state } = advanceEventLife(state, ledger, { type: "SELECT_DECISION", optionId: optionIds[0] as string }, pack));
      ({ state } = advanceEventLife(state, ledger, { type: "NEXT" }, pack));
      continue;
    }
    ({ state } = advanceEventLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 1 }, pack));
    guardCounter += 1;
    if (guardCounter > entry.years * 3 + 16) throw new Error("golden case did not converge");
  }
  return eventLifeDigest(state, ledger, ledger.events.map((event) => event.selectionHash));
}

describe("P3-C golden vectors", () => {
  it("兩個 section 都有足夠案例，且綁定目前的 pack", () => {
    expect(golden.caseCount).toBe(golden.sections.reduce((sum, section) => sum + section.cases.length, 0));
    expect(golden.caseCount).toBe(126);
    const main = golden.sections.find((section) => section.id === "p3b-main");
    const fixture = golden.sections.find((section) => section.id === "p3c-fixture");
    expect(main?.cases.length).toBe(108);
    expect(fixture?.cases.length).toBe(18);
    const mainPack = validateEventPack(packs["p3b-main"]);
    expect(main?.eventPackChecksum).toBe(mainPack.packChecksum);
    expect(main?.eventPackId).toBe(p3bManifest.eventPackId);
    const fixturePack = validateEventPack(packs["p3c-fixture"]);
    expect(fixture?.eventPackChecksum).toBe(fixturePack.packChecksum);
  });

  it("fixture section 覆蓋 0 候選、單候選與事件抉擇", () => {
    const fixture = golden.sections.find((section) => section.id === "p3c-fixture");
    expect(fixture).toBeDefined();
    const trails = (fixture?.cases ?? []).map((entry) => entry.eventTrail);
    expect(trails.some((trail) => trail.filter((id) => id === "-").length >= 3)).toBe(true);
    expect(trails.some((trail) => trail.includes("ev.p3c.child.decision"))).toBe(true);
    expect(trails.some((trail) => trail.includes("ev.p3c.informational"))).toBe(true);
  });

  it("reproduces every committed digest exactly", { timeout: 600000 }, () => {
    for (const section of golden.sections) {
      for (const entry of section.cases) {
        const actual = runCase(section.id, entry);
        expect(actual).toEqual({
          certificateHash: entry.certificateHash,
          masterSeedHash: entry.masterSeedHash,
          birthYear: entry.birthYear,
          age: entry.age,
          phase: entry.phase,
          stateHash: entry.stateHash,
          hashChain: entry.hashChain,
          commandCount: entry.commandCount,
          entries: entry.entries,
          snapshots: entry.snapshots,
          cards: entry.cards,
          eventRecords: entry.eventRecords,
          selectedEvents: entry.selectedEvents,
          eventsRngDraws: entry.eventsRngDraws,
          eventsRngInitialState: entry.eventsRngInitialState,
          eventsRngState: entry.eventsRngState,
          occurrenceDigest: entry.occurrenceDigest,
          occurrences: entry.occurrences,
          lastEntryHash: entry.lastEntryHash,
          lastSnapshotHash: entry.lastSnapshotHash,
          lastDeltaHash: entry.lastDeltaHash,
          cardsTotal: entry.cardsTotal,
          cardsSeen: entry.cardsSeen,
          playbackMode: entry.playbackMode,
          eventTrail: entry.eventTrail,
          selectionTrailDigest: entry.selectionTrailDigest
        });
      }
    }
  });
});
