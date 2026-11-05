import { describe, expect, it } from "vitest";
import type { SexPolicy } from "@life-sim/contracts";
import { buildPeerGroup, createBirthCertificate, validateDataPack, validateIdentityPack } from "@life-sim/birth";
import { advanceLife, createLifeLedger } from "../src/ledger";
import { createLifeFromCertificate } from "../src/life";
import { lifeDigest } from "../src/p3a-browser";
import golden from "../../../fixtures/p3a/golden-life-vectors.v1.json";
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

describe("P3-A golden vectors", () => {
  it("has at least 100 committed cases bound to the current packs", () => {
    expect(golden.caseCount).toBe(golden.cases.length);
    expect(golden.cases.length).toBeGreaterThanOrEqual(100);
    expect(golden.basePackChecksum).toBe(base.packChecksum);
    expect(golden.identityPackChecksum).toBe(identityPack.packChecksum);
  });

  it("reproduces every committed digest exactly", { timeout: 300000 }, () => {
    for (const entry of golden.cases) {
      const group = buildPeerGroup(base, identityPack, { seed: entry.seed, playerSexPolicy: entry.playerSexPolicy as SexPolicy });
      const certificate = createBirthCertificate(base, identityPack, group, entry.seed);
      const { state: initial } = createLifeFromCertificate(base, identityPack, { certificate, masterSeed: entry.seed });
      const ledger = createLifeLedger();
      let state = advanceLife(initial, ledger, { type: "SET_PLAYBACK", paused: false, speed: 1 }).state;
      state = advanceLife(state, ledger, { type: "FAST_FORWARD_STEP", maxYears: 5 }).state;
      expect(lifeDigest(state, ledger)).toEqual({
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
        rngDraws: entry.rngDraws,
        lastEntryHash: entry.lastEntryHash,
        lastSnapshotHash: entry.lastSnapshotHash,
        lastDeltaHash: entry.lastDeltaHash,
        cardsTotal: entry.cardsTotal,
        cardsSeen: entry.cardsSeen,
        playbackMode: entry.playbackMode
      });
    }
  });
});
