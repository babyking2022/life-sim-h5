import { describe, expect, it } from "vitest";
import { buildPeerGroup, peerGroupDigest } from "../src/peer/group";
import { validateIdentityPack } from "../src/identity/validate";
import { validateDataPack } from "../src/validate";
import { asRaw, loadPack } from "./helpers";
import { identityRaw, loadIdentityPack } from "./p2b-helpers";
import golden from "../../../fixtures/p2c/golden-peer-group-vectors.v1.json";

const base = validateDataPack(asRaw(loadPack()));
const pack = validateIdentityPack(base, identityRaw(loadIdentityPack()) as never);

describe("P2-C peer group golden vectors", () => {
  it("has at least 100 committed cases bound to the current packs", () => {
    expect(golden.caseCount).toBe(golden.cases.length);
    expect(golden.cases.length).toBeGreaterThanOrEqual(100);
    expect(golden.basePackChecksum).toBe(base.packChecksum);
    expect(golden.identityPackChecksum).toBe(pack.packChecksum);
  });

  it("reproduces every committed digest exactly", { timeout: 120000 }, () => {
    for (const entry of golden.cases) {
      const group = buildPeerGroup(base, pack, { seed: entry.seed, playerSexPolicy: entry.playerSexPolicy as "random" | "female" | "male" });
      expect(peerGroupDigest(group)).toEqual({
        masterSeedHash: entry.masterSeedHash,
        playerIdentityHash: entry.playerIdentityHash,
        peers: entry.peers,
        groupHash: entry.groupHash
      });
    }
  });
});
