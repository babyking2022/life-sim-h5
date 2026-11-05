import { describe, expect, it } from "vitest";
import { certificateDigest, createBirthCertificate } from "../src/certificate/build";
import { buildPeerGroup } from "../src/peer/group";
import { validateIdentityPack } from "../src/identity/validate";
import { validateDataPack } from "../src/validate";
import { asRaw, loadPack } from "./helpers";
import { identityRaw, loadIdentityPack } from "./p2b-helpers";
import golden from "../../../fixtures/p2d/golden-certificate-vectors.v1.json";

const base = validateDataPack(asRaw(loadPack()));
const pack = validateIdentityPack(base, identityRaw(loadIdentityPack()) as never);

describe("P2-D birth certificate golden vectors", () => {
  it("has at least 108 committed cases bound to the current packs", () => {
    expect(golden.caseCount).toBe(golden.cases.length);
    expect(golden.cases.length).toBeGreaterThanOrEqual(108);
    expect(golden.basePackChecksum).toBe(base.packChecksum);
    expect(golden.identityPackChecksum).toBe(pack.packChecksum);
  });

  it("reproduces every committed digest exactly", { timeout: 120000 }, () => {
    for (const entry of golden.cases) {
      const group = buildPeerGroup(base, pack, { seed: entry.seed, playerSexPolicy: entry.playerSexPolicy as "random" | "female" | "male" });
      const certificate = createBirthCertificate(base, pack, group, entry.seed);
      expect(certificateDigest(certificate)).toEqual({
        certificateId: entry.certificateId,
        masterSeedHash: entry.masterSeedHash,
        playerIdentityHash: entry.playerIdentityHash,
        peerGroupHash: entry.peerGroupHash,
        certificateHash: entry.certificateHash
      });
    }
  });
});
