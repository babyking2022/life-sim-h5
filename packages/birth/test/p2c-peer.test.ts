import { describe, expect, it } from "vitest";
import type { PeerGroup, SexPolicy } from "@life-sim/contracts";
import { derivePeerSeed } from "../src/peer/derive";
import {
  assertPeerGroupHash,
  assertPeerGroupMatches,
  assemblePeerGroup,
  buildPeerGroup,
  buildPeerMember,
  computePeerGroupHash,
  peerGroupDigest
} from "../src/peer/group";
import { buildBirthIdentity } from "../src/identity/draw";
import { runPeerGroupCases } from "../src/p2c-browser";
import { validateIdentityPack } from "../src/identity/validate";
import { validateDataPack } from "../src/validate";
import { asRaw, codeOf, loadPack } from "./helpers";
import { identityRaw, loadAlternateBase, loadIdentityPack } from "./p2b-helpers";

const base = validateDataPack(asRaw(loadPack()));
const pack = validateIdentityPack(base, identityRaw(loadIdentityPack()) as never);
const group = (seed: string, playerSexPolicy: SexPolicy = "random") => buildPeerGroup(base, pack, { seed, playerSexPolicy });
const cloneGroup = (value: PeerGroup): PeerGroup => structuredClone(value) as PeerGroup;

describe("P2-C.1 peer group", () => {
  it("builds the player plus four deterministic peers", () => {
    const result = group("p2c-peer-01");
    expect(result.schemaVersion).toBe("p2c-1");
    expect(result.peerSpecVersion).toBe("1.0.0");
    expect(result.peers).toHaveLength(4);
    expect(result.peers.map((member) => member.peerIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(result.peers.map((member) => member.peerId)).size).toBe(4);
    for (const member of result.peers) {
      expect(member.derivedSeedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(member.peerId).toMatch(/^peer-[0-3]-[0-9a-f]{12}$/);
      expect(member.identity.identityHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(result.groupHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("keeps the player identity identical to the standalone P2-B.1 result", () => {
    for (const seed of ["p2c-peer-02", "  p2c-peer-02  ", "人生-種子-003"]) {
      expect(group(seed).player).toEqual(buildBirthIdentity(base, pack, { seed }));
    }
  });

  it("is identical across repeated runs", () => {
    const first = group("p2c-peer-03");
    for (let run = 0; run < 20; run += 1) expect(group("p2c-peer-03")).toEqual(first);
  });

  it("normalises padded and Unicode seeds", () => {
    expect(group("  p2c-peer-04  ")).toEqual(group("p2c-peer-04"));
  });

  it("derives peer seeds from the master seed and peerIndex only", () => {
    const result = group("p2c-peer-05");
    for (let index = 0; index < 4; index += 1) {
      const derived = derivePeerSeed("p2c-peer-05", index);
      expect(result.peers[index]?.peerId).toBe(derived.peerId);
      expect(result.peers[index]?.derivedSeedHash).toBe(derived.derivedSeedHash);
    }
    expect(derivePeerSeed("p2c-peer-05", 4).peerId).not.toBe(derivePeerSeed("p2c-peer-05", 3).peerId);
    expect(derivePeerSeed("p2c-peer-05", 0xffff_ffff).peerId).toMatch(/^peer-4294967295-/);
  });

  it("is invariant to the generation order of peers", () => {
    const result = group("p2c-peer-06");
    const reversed = [...result.peers].reverse();
    expect(assemblePeerGroup(base, pack, "p2c-peer-06", result.player, reversed, "random")).toEqual(result);
    const shuffled = [result.peers[2], result.peers[0], result.peers[3], result.peers[1]] as typeof result.peers;
    expect(assemblePeerGroup(base, pack, "p2c-peer-06", result.player, shuffled, "random")).toEqual(result);
  });

  it("keeps peer ids unique across many groups", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      for (const member of group(`p2c-peer-uid-${index}`).peers) ids.add(member.peerId);
    }
    expect(ids.size).toBe(400);
  });

  it("recomputes and verifies the group hash", () => {
    const result = group("p2c-peer-07");
    const { groupHash, ...payload } = result;
    expect(computePeerGroupHash(payload)).toBe(groupHash);
    expect(() => assertPeerGroupHash(result)).not.toThrow();
    expect(() => assertPeerGroupMatches(base, pack, "p2c-peer-07", result)).not.toThrow();
    expect(codeOf(() => assertPeerGroupMatches(base, pack, "p2c-peer-07-wrong", result))).toBe("E_P2C_GROUP_MISMATCH");
  });

  it("detects a tampered peer or player", () => {
    const tamperedPeer = cloneGroup(group("p2c-peer-08"));
    (tamperedPeer.peers[0] as unknown as { identity: { identityHash: string } }).identity.identityHash = "0".repeat(64);
    expect(codeOf(() => assertPeerGroupHash(tamperedPeer))).toBe("E_P2C_GROUP_HASH");

    const tamperedPlayer = cloneGroup(group("p2c-peer-08"));
    (tamperedPlayer.player as unknown as { name: { fullName: string } }).name.fullName = "被改掉的名字";
    expect(codeOf(() => assertPeerGroupHash(tamperedPlayer))).toBe("E_P2C_GROUP_HASH");

    const tamperedIndex = cloneGroup(group("p2c-peer-08"));
    (tamperedIndex.peers[0] as unknown as { peerIndex: number }).peerIndex = 3;
    expect(codeOf(() => assertPeerGroupHash(tamperedIndex))).toBe("E_P2C_PEER_INDEX");
  });

  it("rejects bad packs, bad seeds and bad peer indexes", () => {
    expect(codeOf(() => buildPeerGroup(loadAlternateBase(), pack, { seed: "x" }))).toBe("E_P2B_BASE_PACK_MISMATCH");
    expect(codeOf(() => buildPeerGroup(asRaw(loadPack()) as never, pack, { seed: "x" }))).toBe("E_P2A_PACK_NOT_VALIDATED");
    expect(codeOf(() => buildPeerGroup(base, loadIdentityPack() as never, { seed: "x" }))).toBe("E_P2B_PACK_NOT_VALIDATED");
    expect(codeOf(() => buildPeerGroup(base, pack, { seed: "" }))).toBe("E_P2A_SEED");
    expect(codeOf(() => buildPeerGroup(base, pack, { seed: "x", playerSexPolicy: "other" as never }))).toBe("E_P2A_SEX_POLICY");
    expect(codeOf(() => buildPeerMember(base, pack, "x", 4))).toBe("E_P2C_PEER_INDEX");
    expect(codeOf(() => buildPeerMember(base, pack, "x", -1))).toBe("E_P2C_PEER_INDEX");
    expect(codeOf(() => buildPeerMember(base, pack, "x", 1.5))).toBe("E_P2C_PEER_INDEX");
  });

  it("rejects duplicate, missing or extra peers", () => {
    const result = group("p2c-peer-09");
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-09", result.player, result.peers.slice(0, 3), "random"))).toBe("E_P2C_PEER_COUNT");
    const duplicateIndex = cloneGroup(result).peers as unknown as Array<{ peerIndex: number }>;
    duplicateIndex[3]!.peerIndex = 2;
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-09", result.player, duplicateIndex as never, "random"))).toBe("E_P2C_PEER_INDEX");
    const duplicateId = cloneGroup(result).peers as unknown as Array<{ peerId: string }>;
    duplicateId[3]!.peerId = duplicateId[0]!.peerId;
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-09", result.player, duplicateId as never, "random"))).toBe("E_P2C_PEER_DUPLICATE");
    const extra = [...result.peers, structuredClone(result.peers[0])] as unknown as PeerGroup["peers"];
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-09", result.player, extra, "random"))).toBe("E_P2C_PEER_COUNT");
  });

  it("does not modify the validated packs or the player", () => {
    const playerBefore = JSON.stringify(buildBirthIdentity(base, pack, { seed: "p2c-peer-10" }));
    const checksumBefore = pack.packChecksum;
    const result = group("p2c-peer-10");
    expect(JSON.stringify(result.player)).toBe(playerBefore);
    expect(pack.packChecksum).toBe(checksumBefore);
    expect(Object.isFrozen(pack)).toBe(true);
  });

  it("digests match the group", () => {
    const result = group("p2c-peer-11", "female");
    const digest = peerGroupDigest(result);
    expect(digest.groupHash).toBe(result.groupHash);
    expect(digest.peers.map((peer) => peer.identityHash)).toEqual(result.peers.map((member) => member.identity.identityHash));
  });

  it("covers the three player sex policies and keeps peer sex independent", () => {
    const randomGroup = group("p2c-peer-12", "random");
    const femaleGroup = group("p2c-peer-12", "female");
    const maleGroup = group("p2c-peer-12", "male");
    expect(femaleGroup.player.birth.sex).toBe("female");
    expect(maleGroup.player.birth.sex).toBe("male");
    for (const other of [femaleGroup, maleGroup]) {
      expect(other.playerSexPolicy).not.toBe("random");
      expect(other.peers).toEqual(randomGroup.peers);
    }
    expect(femaleGroup.groupHash).not.toBe(maleGroup.groupHash);
    const peers = randomGroup.peers;
    expect(peers.some((member) => member.identity.birth.sex === "female")).toBe(true);
    expect(peers.some((member) => member.identity.birth.sex === "male")).toBe(true);
  });

  it("rejects a player or peers from another seed", () => {
    const seedA = group("p2c-seed-a");
    const seedB = group("p2c-seed-b");
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-seed-a", seedB.player, seedA.peers, "random"))).toBe("E_P2C_GROUP_MISMATCH");
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-seed-a", seedA.player, seedB.peers, "random"))).toBe("E_P2C_GROUP_MISMATCH");
  });

  it("rejects tampered peerId, derivedSeedHash or identity in assemblePeerGroup", () => {
    const result = group("p2c-peer-13");
    const badPeerId = cloneGroup(result).peers as unknown as Array<{ peerId: string }>;
    badPeerId[0]!.peerId = "peer-0-000000000000";
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-13", result.player, badPeerId as never, "random"))).toBe("E_P2C_GROUP_MISMATCH");

    const badSeedHash = cloneGroup(result).peers as unknown as Array<{ derivedSeedHash: string }>;
    badSeedHash[1]!.derivedSeedHash = "a".repeat(64);
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-13", result.player, badSeedHash as never, "random"))).toBe("E_P2C_GROUP_MISMATCH");

    const badIdentity = cloneGroup(result).peers as unknown as Array<{ identity: { name: { fullName: string } } }>;
    badIdentity[2]!.identity.name.fullName = "被改掉的名字";
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-13", result.player, badIdentity as never, "random"))).toBe("E_P2C_GROUP_MISMATCH");
  });

  it("rejects invalid sexPolicy and invalid player/member shape", () => {
    const result = group("p2c-peer-14");
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-14", result.player, result.peers, "other" as never))).toBe("E_P2A_SEX_POLICY");
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-14", null as never, result.peers, "random"))).toBe("E_P2A_TYPE");
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-14", result.player, null as never, "random"))).toBe("E_P2A_TYPE");
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-14", result.player, [null, null, null, null] as never, "random"))).toBe("E_P2A_TYPE");
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-14", result.player, result.peers, 42 as never))).toBe("E_P2A_SEX_POLICY");
  });

  it("never throws a native TypeError for bad input", () => {
    const failures = [
      () => buildPeerGroup(base, pack, null as never),
      () => buildPeerGroup(base, pack, [] as never),
      () => buildPeerGroup(base, pack, {} as never),
      () => buildPeerGroup(base, pack, { seed: 42 } as never),
      () => buildPeerGroup(base, pack, { seed: null } as never),
      () => assertPeerGroupHash(null as never),
      () => assertPeerGroupHash({} as never),
      () => assertPeerGroupMatches(base, pack, "x", null as never),
      () => assertPeerGroupMatches(base, pack, "x", {} as never),
      () => assertPeerGroupHash({ ...group("p2c-peer-15"), peers: null } as never)
    ];
    for (const action of failures) {
      let threw = false;
      try {
        action();
      } catch (error) {
        threw = true;
        expect((error as Error).name).toBe("BirthDataError");
        expect((error as { code?: string }).code).toBeTruthy();
      }
      expect(threw).toBe(true);
    }
  });

  it("rejects non-safe-integer peer indexes", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(codeOf(() => derivePeerSeed("p2c-seed", bad))).toBe("E_P2C_PEER_INDEX");
    }
    expect(derivePeerSeed("p2c-seed", 0xffff_ffff).peerId).toMatch(/^peer-4294967295-/);
    expect(derivePeerSeed("p2c-seed", 0).peerId).toMatch(/^peer-0-/);
  });

  it("does not sign a valid group for bad data (hash is not identity proof)", () => {
    const result = group("p2c-peer-16");
    const forged = cloneGroup(result);
    (forged.peers[0] as unknown as { identity: { identityHash: string } }).identity.identityHash = "b".repeat(64);
    const payload = { ...forged } as unknown as Record<string, unknown>;
    delete payload.groupHash;
    const resigned = { ...forged, groupHash: computePeerGroupHash(payload as never) };
    expect(() => assertPeerGroupHash(resigned)).not.toThrow();
    expect(codeOf(() => assertPeerGroupMatches(base, pack, "p2c-peer-16", resigned))).toBe("E_P2C_GROUP_MISMATCH");
    expect(codeOf(() => assemblePeerGroup(base, pack, "p2c-peer-16", forged.player, forged.peers, "random"))).toBe("E_P2C_GROUP_MISMATCH");
  });

  it("exposes the browser entry", () => {
    const [digest] = runPeerGroupCases(asRaw(loadPack()), identityRaw(loadIdentityPack()), [{ seed: "p2c-peer-browser", playerSexPolicy: "random" }]);
    expect(digest).toEqual(peerGroupDigest(group("p2c-peer-browser")));
  });

  it("reports schema and spec version mismatches", () => {
    const result = cloneGroup(group("p2c-peer-17"));
    (result as unknown as { schemaVersion: string }).schemaVersion = "p2c-2";
    expect(codeOf(() => assertPeerGroupHash(result))).toBe("E_P2C_SCHEMA_VERSION");
    const spec = cloneGroup(group("p2c-peer-17"));
    (spec as unknown as { peerSpecVersion: string }).peerSpecVersion = "2.0.0";
    expect(codeOf(() => assertPeerGroupHash(spec))).toBe("E_P2C_PEER_SPEC_VERSION");
  });
});
