import { describe, expect, it } from "vitest";
import type { BirthCertificateSnapshot } from "@life-sim/contracts";
import {
  assertBirthCertificateHash,
  assertBirthCertificateMatches,
  certificateDigest,
  computeCertificateHash,
  createBirthCertificate
} from "../src/certificate/build";
import { buildPeerGroup, computePeerGroupHash } from "../src/peer/group";
import { validateIdentityPack } from "../src/identity/validate";
import { validateDataPack } from "../src/validate";
import { asRaw, codeOf, loadPack } from "./helpers";
import { identityRaw, loadAlternateBase, loadIdentityPack } from "./p2b-helpers";

const base = validateDataPack(asRaw(loadPack()));
const pack = validateIdentityPack(base, identityRaw(loadIdentityPack()) as never);
const group = (seed: string, playerSexPolicy: "random" | "female" | "male" = "random") => buildPeerGroup(base, pack, { seed, playerSexPolicy });
const certificateFor = (seed: string, policy: "random" | "female" | "male" = "random") =>
  createBirthCertificate(base, pack, group(seed, policy), seed);
const clone = <T>(value: T): T => structuredClone(value) as T;

describe("P2-D birth certificate", () => {
  it("summarises the validated PeerGroup without drawing new values", () => {
    const peerGroup = group("p2d-cert-01");
    const certificate = createBirthCertificate(base, pack, peerGroup, "p2d-cert-01");
    expect(certificate.schemaVersion).toBe("p2d-1");
    expect(certificate.certificateSpecVersion).toBe("1.0.0");
    expect(certificate.certificateId).toMatch(/^cert:[0-9a-f]{24}$/);
    expect(certificate.masterSeedHash).toBe(peerGroup.masterSeedHash);
    expect(certificate.player.identityHash).toBe(peerGroup.player.identityHash);
    expect(certificate.player.certificateNumber).toBe(peerGroup.player.certificate.fullNumber);
    expect(certificate.player.birth.birthYear).toBe(peerGroup.player.birth.birthYear);
    expect(certificate.player.birth.entityId).toBe(peerGroup.player.birth.entityId);
    expect(certificate.player.name.fullName).toBe(peerGroup.player.name.fullName);
    expect(certificate.player.family.incomeQuintile).toBe(peerGroup.player.household.incomeQuintile);
    expect(certificate.player.story.paragraphs).toEqual(peerGroup.player.story.paragraphs);
    expect(certificate.packs.basePackChecksum).toBe(base.packChecksum);
    expect(certificate.packs.identityPackChecksum).toBe(pack.packChecksum);
    expect(certificate.packs.peerGroupHash).toBe(peerGroup.groupHash);
    expect(certificate.packs.peerSpecVersion).toBe("1.0.0");
    expect(certificate.peers).toHaveLength(4);
    expect(certificate.peers.map((peer) => peer.peerIndex)).toEqual([0, 1, 2, 3]);
    for (const [index, peer] of certificate.peers.entries()) {
      const source = peerGroup.peers[index];
      expect(peer.peerId).toBe(source?.peerId);
      expect(peer.identityHash).toBe(source?.identity.identityHash);
      expect(peer.fullName).toBe(source?.identity.name.fullName);
      expect(peer.entityId).toBe(source?.identity.birth.entityId);
    }
    expect(certificate.certificateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(JSON.stringify(certificate))).toEqual(certificate);
  });

  it("is deterministic across runs and policies", () => {
    expect(certificateFor("p2d-cert-02")).toEqual(certificateFor("p2d-cert-02"));
    const female = certificateFor("p2d-cert-02", "female");
    const male = certificateFor("p2d-cert-02", "male");
    expect(female.player.birth.sex).toBe("female");
    expect(male.player.birth.sex).toBe("male");
    expect(female.peers).toEqual(male.peers);
    expect(female.certificateHash).not.toBe(male.certificateHash);
  });

  it("verifies hash and full replay", () => {
    const certificate = certificateFor("p2d-cert-03");
    expect(() => assertBirthCertificateHash(certificate)).not.toThrow();
    expect(() => assertBirthCertificateMatches(base, pack, certificate, "p2d-cert-03")).not.toThrow();
    expect(codeOf(() => assertBirthCertificateMatches(base, pack, certificate, "p2d-cert-wrong"))).toBe("E_P2D_MISMATCH");
  });

  it("detects a tampered field and a re-signed hash", () => {
    const tampered = clone(certificateFor("p2d-cert-04"));
    (tampered.player.birth as unknown as { weightGrams: number }).weightGrams += 1;
    expect(codeOf(() => assertBirthCertificateHash(tampered))).toBe("E_P2D_HASH");

    const resigned = clone(certificateFor("p2d-cert-04"));
    (resigned.player.birth as unknown as { weightGrams: number }).weightGrams += 1;
    const payload = { ...resigned } as unknown as Record<string, unknown>;
    delete payload.certificateHash;
    (resigned as unknown as { certificateHash: string }).certificateHash = computeCertificateHash(payload as never);
    expect(() => assertBirthCertificateHash(resigned)).not.toThrow();
    expect(codeOf(() => assertBirthCertificateMatches(base, pack, resigned, "p2d-cert-04"))).toBe("E_P2D_MISMATCH");
  });

  it("rejects a group from another seed, tampered peers or a different pack", () => {
    const seedA = group("p2d-cert-a");
    const seedB = group("p2d-cert-b");
    expect(codeOf(() => createBirthCertificate(base, pack, seedB, "p2d-cert-a"))).toBe("E_P2C_GROUP_MISMATCH");

    const tampered = clone(seedA);
    (tampered.peers[0] as unknown as { peerId: string }).peerId = "peer-0-000000000000";
    expect(codeOf(() => createBirthCertificate(base, pack, tampered, "p2d-cert-a"))).toBe("E_P2C_GROUP_HASH");

    const resigned = clone(seedA);
    (resigned.peers[0] as unknown as { peerId: string }).peerId = "peer-0-000000000000";
    const resignedPayload = { ...resigned } as unknown as Record<string, unknown>;
    delete resignedPayload.groupHash;
    (resigned as unknown as { groupHash: string }).groupHash = computePeerGroupHash(resignedPayload as never);
    expect(codeOf(() => createBirthCertificate(base, pack, resigned, "p2d-cert-a"))).toBe("E_P2C_GROUP_MISMATCH");

    const alternateBase = loadAlternateBase();
    expect(codeOf(() => createBirthCertificate(alternateBase, pack, seedA, "p2d-cert-a"))).toBe("E_P2B_BASE_PACK_MISMATCH");

    const wrongPack = clone(seedA);
    (wrongPack as unknown as { basePackChecksum: string }).basePackChecksum = "0".repeat(64);
    expect(codeOf(() => createBirthCertificate(base, pack, wrongPack, "p2d-cert-a"))).toBe("E_P2D_PACK_MISMATCH");
  });

  it("rejects invalid policy and malformed input with fixed codes", () => {
    const certificate = certificateFor("p2d-cert-05");
    const badPolicy = clone(certificate);
    (badPolicy as unknown as { playerSexPolicy: string }).playerSexPolicy = "other";
    expect(codeOf(() => assertBirthCertificateMatches(base, pack, badPolicy, "p2d-cert-05"))).toBe("E_P2A_SEX_POLICY");
    expect(codeOf(() => createBirthCertificate(base, pack, null as never, "x"))).toBe("E_P2A_TYPE");
    expect(codeOf(() => createBirthCertificate(base, pack, [] as never, "x"))).toBe("E_P2A_TYPE");
    expect(codeOf(() => createBirthCertificate(base, pack, group("p2d-cert-05"), 42 as never))).toBe("E_P2A_SEED");
    expect(codeOf(() => assertBirthCertificateHash(null as never))).toBe("E_P2A_TYPE");
    expect(codeOf(() => assertBirthCertificateHash({} as never))).toBe("E_P2D_SCHEMA_VERSION");
    expect(codeOf(() => assertBirthCertificateMatches(base, pack, null as never, "x"))).toBe("E_P2A_TYPE");
    expect(codeOf(() => assertBirthCertificateMatches(base, pack, {} as never, "x"))).toBe("E_P2D_SCHEMA_VERSION");
  });

  it("does not mutate the packs, peer group or identities", () => {
    const peerGroup = group("p2d-cert-06");
    const groupBefore = JSON.stringify(peerGroup);
    const checksumBefore = pack.packChecksum;
    const certificate = createBirthCertificate(base, pack, peerGroup, "p2d-cert-06");
    expect(JSON.stringify(peerGroup)).toBe(groupBefore);
    expect(pack.packChecksum).toBe(checksumBefore);
    expect(Object.isFrozen(pack)).toBe(true);
    expect(certificateDigest(certificate).certificateHash).toBe(certificate.certificateHash);
  });

  it("digest matches the certificate", () => {
    const certificate = certificateFor("p2d-cert-07", "female");
    const digest = certificateDigest(certificate);
    expect(digest.certificateId).toBe(certificate.certificateId);
    expect(digest.masterSeedHash).toBe(certificate.masterSeedHash);
    expect(digest.playerIdentityHash).toBe(certificate.player.identityHash);
    expect(digest.peerGroupHash).toBe(certificate.packs.peerGroupHash);
  });
});

describe("P2-D.1 certificate shape validation", () => {
  const valid = certificateFor("p2d1-shape-01");
  const payloadOf = (certificate: BirthCertificateSnapshot): Record<string, unknown> => {
    const copy = structuredClone(certificate) as unknown as Record<string, unknown>;
    delete copy.certificateHash;
    return copy;
  };
  const forged = (mutate: (draft: Record<string, unknown>) => void): BirthCertificateSnapshot => {
    const draft = structuredClone(valid) as unknown as Record<string, unknown>;
    mutate(draft);
    draft.certificateHash = "0".repeat(64);
    return draft as unknown as BirthCertificateSnapshot;
  };

  it("rejects a missing player.birth even with a re-signed hash", () => {
    const draft = payloadOf(valid);
    delete (draft.player as Record<string, unknown>).birth;
    expect(codeOf(() => computeCertificateHash(draft as never))).toBe("E_P2D_SHAPE");
    expect(codeOf(() => assertBirthCertificateHash(forged((item) => { delete (item.player as Record<string, unknown>).birth; })))).toBe(
      "E_P2D_SHAPE"
    );
  });

  it("rejects missing packs even with a re-signed hash", () => {
    const draft = payloadOf(valid);
    delete draft.packs;
    expect(codeOf(() => computeCertificateHash(draft as never))).toBe("E_P2D_SHAPE");
    expect(codeOf(() => assertBirthCertificateHash(forged((item) => { delete item.packs; })))).toBe("E_P2D_SHAPE");
  });

  it("rejects a player that is an empty object", () => {
    const draft = payloadOf(valid);
    draft.player = {};
    expect(codeOf(() => computeCertificateHash(draft as never))).toBe("E_P2D_SHAPE");
    expect(codeOf(() => assertBirthCertificateHash(forged((item) => { item.player = {}; })))).toBe("E_P2D_SHAPE");
  });

  it("rejects peers that only keep peerIndex", () => {
    const draft = payloadOf(valid);
    draft.peers = [0, 1, 2, 3].map((peerIndex) => ({ peerIndex }));
    expect(codeOf(() => computeCertificateHash(draft as never))).toBe("E_P2D_SHAPE");
    expect(codeOf(() => assertBirthCertificateHash(forged((item) => { item.peers = [0, 1, 2, 3].map((peerIndex) => ({ peerIndex })); })))).toBe(
      "E_P2D_SHAPE"
    );
  });

  it("rejects an invalid certificateId even with a re-signed hash", () => {
    const draft = payloadOf(valid);
    draft.certificateId = "cert:XYZ";
    expect(codeOf(() => computeCertificateHash(draft as never))).toBe("E_P2D_SHAPE");
    expect(codeOf(() => assertBirthCertificateHash(forged((item) => { item.certificateId = "cert:XYZ"; })))).toBe("E_P2D_SHAPE");
  });

  it("rejects an invalid playerSexPolicy even with a re-signed hash", () => {
    const draft = payloadOf(valid);
    draft.playerSexPolicy = "other";
    expect(codeOf(() => computeCertificateHash(draft as never))).toBe("E_P2A_SEX_POLICY");
    expect(codeOf(() => assertBirthCertificateHash(forged((item) => { item.playerSexPolicy = "other"; })))).toBe("E_P2A_SEX_POLICY");
  });

  it("rejects non-safe numbers and wrong enums without leaking lower-level errors", () => {
    const cases: Array<(draft: Record<string, unknown>) => void> = [
      (draft) => { (draft.player as Record<string, unknown>).birth = { ...(draft.player as { birth: object }).birth, weightGrams: Number.NaN }; },
      (draft) => { (draft.player as Record<string, unknown>).birth = { ...(draft.player as { birth: object }).birth, weightGrams: Number.POSITIVE_INFINITY }; },
      (draft) => { (draft.player as Record<string, unknown>).birth = { ...(draft.player as { birth: object }).birth, weightGrams: 1.5 }; },
      (draft) => { (draft.player as Record<string, unknown>).birth = { ...(draft.player as { birth: object }).birth, birthYear: 2 ** 53 }; },
      (draft) => { (draft.player as Record<string, unknown>).birth = { ...(draft.player as { birth: object }).birth, sex: "x" }; },
      (draft) => { (draft.player as Record<string, unknown>).family = { ...(draft.player as { family: object }).family, incomeQuintile: 6 }; },
      (draft) => { (draft.player as Record<string, unknown>).story = { ...(draft.player as { story: object }).story, paragraphs: [1, 2] }; },
      (draft) => { (draft.peers as Array<Record<string, unknown>>)[0] = { ...(draft.peers as Array<Record<string, unknown>>)[0], peerIndex: 3 }; }
    ];
    for (const mutate of cases) {
      const draft = payloadOf(valid);
      mutate(draft);
      let code = "NO_ERROR";
      let name = "";
      try {
        computeCertificateHash(draft as never);
      } catch (error) {
        name = (error as Error).name;
        code = (error as { code?: string }).code ?? "OTHER";
      }
      expect(name).toBe("BirthDataError");
      expect(["E_P2D_SHAPE", "E_P2A_SEX_POLICY"]).toContain(code);
    }
  });

  it("computeCertificateHash rejects null, arrays and missing fields with fixed codes", () => {
    expect(codeOf(() => computeCertificateHash(null as never))).toBe("E_P2A_TYPE");
    expect(codeOf(() => computeCertificateHash([] as never))).toBe("E_P2A_TYPE");
    expect(codeOf(() => computeCertificateHash({} as never))).toBe("E_P2D_SCHEMA_VERSION");
    expect(codeOf(() => computeCertificateHash({ ...payloadOf(valid), player: undefined } as never))).toBe("E_P2D_SHAPE");
  });

  it("certificateDigest rejects null, arrays and missing fields with fixed codes", () => {
    expect(codeOf(() => certificateDigest(null as never))).toBe("E_P2A_TYPE");
    expect(codeOf(() => certificateDigest([] as never))).toBe("E_P2A_TYPE");
    expect(codeOf(() => certificateDigest({} as never))).toBe("E_P2D_SCHEMA_VERSION");
    expect(codeOf(() => certificateDigest({ ...valid, peers: [] } as never))).toBe("E_P2D_SHAPE");
  });

  it("keeps every committed valid golden unchanged", () => {
    expect(valid.certificateHash).toBe(certificateFor("p2d1-shape-01").certificateHash);
  });
});