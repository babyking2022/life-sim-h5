import { describe, expect, it } from "vitest";
import type { BirthCertificateSnapshot, SexPolicy } from "@life-sim/contracts";
import { buildPeerGroup, createBirthCertificate, validateDataPack, validateIdentityPack } from "@life-sim/birth";
import { LifeError, serializeLifeState } from "@life-sim/engine";
import { createLifeFromCertificate } from "../src/life";
import { lifeDigest } from "../src/p3a-browser";
import { createLifeLedger } from "../src/ledger";
import baseJson from "../../../fixtures/p2a/manifest.v1.json";
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
  manifest: baseJson,
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
const certificateFor = (seed: string, policy: SexPolicy = "random"): BirthCertificateSnapshot => {
  const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: policy });
  return createBirthCertificate(base, identityPack, group, seed);
};
const codeOf = (action: () => unknown): string => {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof LifeError ? error.code : "OTHER";
  }
};

describe("P3-A birth wiring", () => {
  it("creates a life state from a valid P2-D.1 certificate", () => {
    const certificate = certificateFor("p3a-wire-01");
    const { state } = createLifeFromCertificate(base, identityPack, { certificate, masterSeed: "p3a-wire-01" });
    expect(state.origin.certificateHash).toBe(certificate.certificateHash);
    expect(state.origin.playerIdentityHash).toBe(certificate.player.identityHash);
    expect(state.origin.masterSeedHash).toBe(certificate.masterSeedHash);
    expect(state.birthYear).toBe(certificate.player.birth.birthYear);
    expect(state.currentYear).toBe(certificate.player.birth.birthYear);
    expect(state.age).toBe(0);
    expect(state.phase).toBe("life");
    expect(state.origin.identityPackChecksum).toBe(identityPack.packChecksum);
  });

  it("rejects a cross-seed certificate", () => {
    const certificate = certificateFor("p3a-wire-02");
    expect(codeOf(() => createLifeFromCertificate(base, identityPack, { certificate, masterSeed: "p3a-wire-other" }))).toBe("E_P3A_CERTIFICATE");
  });

  it("rejects a tampered certificate", () => {
    const certificate = structuredClone(certificateFor("p3a-wire-03")) as BirthCertificateSnapshot;
    (certificate.player.birth as unknown as { weightGrams: number }).weightGrams += 1;
    expect(codeOf(() => createLifeFromCertificate(base, identityPack, { certificate, masterSeed: "p3a-wire-03" }))).toBe("E_P3A_CERTIFICATE");
  });

  it("rejects a wrong pack and bad input", () => {
    const certificate = certificateFor("p3a-wire-04");
    expect(codeOf(() => createLifeFromCertificate({} as never, identityPack, { certificate, masterSeed: "p3a-wire-04" }))).toBe("E_P3A_CERTIFICATE");
    expect(codeOf(() => createLifeFromCertificate(base, identityPack, null as never))).toBe("E_P3A_TYPE");
    expect(codeOf(() => createLifeFromCertificate(base, identityPack, { certificate, masterSeed: 42 } as never))).toBe("E_P3A_ARGUMENT");
    expect(codeOf(() => createLifeFromCertificate(base, identityPack, { certificate, masterSeed: "" }))).toBe("E_P3A_ARGUMENT");
  });

  it("does not mutate the certificate or packs", () => {
    const certificate = certificateFor("p3a-wire-05");
    const before = JSON.stringify(certificate);
    const packBefore = identityPack.packChecksum;
    createLifeFromCertificate(base, identityPack, { certificate, masterSeed: "p3a-wire-05" });
    expect(JSON.stringify(certificate)).toBe(before);
    expect(identityPack.packChecksum).toBe(packBefore);
  });

  it("never stores the raw seed in shareable state", () => {
    const seed = "p3a-secret-seed";
    const certificate = certificateFor(seed);
    const { state } = createLifeFromCertificate(base, identityPack, { certificate, masterSeed: seed });
    const json = JSON.stringify(serializeLifeState(state));
    expect(json).not.toContain(seed);
    expect(state.origin.masterSeedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lifeDigest(state, createLifeLedger()).masterSeedHash).toBe(state.origin.masterSeedHash);
  });
});
