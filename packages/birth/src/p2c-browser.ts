import type { SexPolicy } from "@life-sim/contracts";
import { validateIdentityPack } from "./identity/validate";
import { buildPeerGroup, peerGroupDigest, type PeerGroupDigest } from "./peer/group";
import { validateDataPack } from "./validate";

export interface PeerGroupBrowserCase {
  readonly seed: string;
  readonly playerSexPolicy: string;
}

/** P2-C 跨瀏覽器 golden 入口：兩個資料包由呼叫端傳入。 */
export function runPeerGroupCases(baseRaw: unknown, identityRaw: unknown, cases: readonly PeerGroupBrowserCase[]): PeerGroupDigest[] {
  const base = validateDataPack(baseRaw as never);
  const pack = validateIdentityPack(base, identityRaw as never);
  return cases.map((item) => {
    const group = buildPeerGroup(base, pack, { seed: item.seed, playerSexPolicy: item.playerSexPolicy as SexPolicy });
    return peerGroupDigest(group);
  });
}
