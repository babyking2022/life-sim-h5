import type { BirthCertificateSnapshot, P3ALifeState, VersionTuple } from "@life-sim/contracts";
import { P3A_CONTENT_VERSION, P3A_RULESET_VERSION } from "@life-sim/contracts";
import { assertBirthCertificateMatches, type ValidatedDataPack, type ValidatedIdentityPack } from "@life-sim/birth";
import { createLifeState, deriveDomainState, LifeError, normalizeSeed } from "@life-sim/engine";

export interface LifeFromCertificateInput {
  readonly certificate: BirthCertificateSnapshot;
  readonly masterSeed: string;
}

export interface LifeBootstrapResult {
  readonly state: P3ALifeState;
}

function fail(code: string): never {
  throw new LifeError(code);
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function createLifeFromCertificate(
  base: ValidatedDataPack,
  identityPack: ValidatedIdentityPack,
  input: LifeFromCertificateInput
): LifeBootstrapResult {
  if (!isRecord(input)) fail("E_P3A_TYPE");
  const certificate = input.certificate;
  if (!isRecord(certificate)) fail("E_P3A_TYPE");
  if (typeof input.masterSeed !== "string") fail("E_P3A_ARGUMENT");
  let seed: string;
  try {
    seed = normalizeSeed(input.masterSeed);
  } catch {
    return fail("E_P3A_ARGUMENT");
  }
  try {
    assertBirthCertificateMatches(base, identityPack, certificate, seed);
  } catch {
    return fail("E_P3A_CERTIFICATE");
  }
  if (certificate.schemaVersion !== "p2d-1" || certificate.certificateSpecVersion !== "1.0.0") fail("E_P3A_VERSION");
  if (!/^cert:[0-9a-f]{24}$/.test(certificate.certificateId)) fail("E_P3A_STATE");
  if (certificate.player.birth.birthYear < 1800 || certificate.player.birth.birthYear > 2200) fail("E_P3A_STATE");
  const versions: VersionTuple = {
    engineVersion: "0.1.0",
    rulesetVersion: P3A_RULESET_VERSION,
    rngSpecVersion: "1.0.0",
    dataVersion: identityPack.manifest.dataVersion,
    contentVersion: P3A_CONTENT_VERSION,
    saveFormatVersion: 3
  };
  return {
    state: createLifeState({
      versions,
      origin: {
        certificateHash: certificate.certificateHash,
        certificateId: certificate.certificateId,
        playerIdentityHash: certificate.player.identityHash,
        masterSeedHash: certificate.masterSeedHash,
        basePackId: certificate.packs.basePackId,
        basePackChecksum: certificate.packs.basePackChecksum,
        identityPackId: certificate.packs.identityPackId,
        identityPackChecksum: certificate.packs.identityPackChecksum
      },
      birthYear: certificate.player.birth.birthYear,
      paceLifeYearsX10: certificate.player.vitals.lifeExpectancyYearsX10,
      rngState: deriveDomainState(seed, "life")
    })
  };
}
