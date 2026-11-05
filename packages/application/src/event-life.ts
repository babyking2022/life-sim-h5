import type { BirthCertificateSnapshot, P3CLifeState, VersionTuple } from "@life-sim/contracts";
import { P3C_CONTENT_VERSION, P3C_RULESET_VERSION, P3C_SAVE_FORMAT_VERSION } from "@life-sim/contracts";
import { assertBirthCertificateMatches, type ValidatedDataPack, type ValidatedIdentityPack } from "@life-sim/birth";
import { createEventLifeState, deriveDomainState, EventLifeError, normalizeSeed } from "@life-sim/engine";

/**
 * 由出生證書建立**綁定事件 pack** 的權威人生（schema `p3c-1`）。
 *
 * 與 `createLifeFromCertificate` 的差異：
 * - versions 換成 P3-C 的正式五元組（ruleset `p3c-1.0.0`、content `skeleton-1.1.0`、saveFormat 4）；
 * - 必須提供 validated event pack；pack 的 ID／checksum／事件數會寫進權威 state 的 `events.binding`。
 *
 * 只接受 already-validated pack：raw JSON 會被 `createEventLifeState` 以 `E_P3C_PACK` 拒絕。
 */
export interface EventLifeFromCertificateInput {
  readonly certificate: BirthCertificateSnapshot;
  readonly masterSeed: string;
  readonly eventPack: unknown;
}

export interface EventLifeBootstrapResult {
  readonly state: P3CLifeState;
}

function fail(code: "E_P3C_TYPE" | "E_P3C_ARGUMENT" | "E_P3C_CERTIFICATE" | "E_P3C_VERSION" | "E_P3C_STATE"): never {
  throw new EventLifeError(code);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function createEventLifeFromCertificate(
  base: ValidatedDataPack,
  identityPack: ValidatedIdentityPack,
  input: EventLifeFromCertificateInput
): EventLifeBootstrapResult {
  if (!isRecord(input)) fail("E_P3C_TYPE");
  const certificate = input.certificate;
  if (!isRecord(certificate)) fail("E_P3C_TYPE");
  if (typeof input.masterSeed !== "string") fail("E_P3C_ARGUMENT");
  let seed: string;
  try {
    seed = normalizeSeed(input.masterSeed);
  } catch {
    return fail("E_P3C_ARGUMENT");
  }
  try {
    assertBirthCertificateMatches(base, identityPack, certificate, seed);
  } catch {
    return fail("E_P3C_CERTIFICATE");
  }
  if (certificate.schemaVersion !== "p2d-1" || certificate.certificateSpecVersion !== "1.0.0") fail("E_P3C_VERSION");
  if (!/^cert:[0-9a-f]{24}$/.test(certificate.certificateId)) fail("E_P3C_STATE");
  if (certificate.player.birth.birthYear < 1800 || certificate.player.birth.birthYear > 2200) fail("E_P3C_STATE");
  const versions: VersionTuple = {
    engineVersion: "0.1.0",
    rulesetVersion: P3C_RULESET_VERSION,
    rngSpecVersion: "1.0.0",
    dataVersion: identityPack.manifest.dataVersion,
    contentVersion: P3C_CONTENT_VERSION,
    saveFormatVersion: P3C_SAVE_FORMAT_VERSION
  };
  return {
    state: createEventLifeState(
      {
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
      },
      input.eventPack
    )
  };
}
