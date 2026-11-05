import { P2C_PEER_COUNT } from "@life-sim/contracts";
import { ascii, concatBytes, normalizeSeed, seedDigest, seedHash, sha256Hex } from "@life-sim/engine";
import { fail } from "../errors";

export interface DerivedPeerSeed {
  readonly peerSeed: string;
  readonly peerId: string;
  readonly derivedSeedHash: string;
}

export function assertPeerIndex(peerIndex: number): void {
  if (!Number.isInteger(peerIndex) || peerIndex < 0 || peerIndex >= P2C_PEER_COUNT) fail("E_P2C_PEER_INDEX", "peerIndex");
}

export const P2C_MAX_DERIVABLE_PEER_INDEX = 0xffff_ffff;

/** 派生用安全整數（0..2^32-1）：未來新增第 5 名 peer 時，0–3 的 seed 不會改變。 */
function assertDerivableIndex(peerIndex: number): void {
  if (!Number.isSafeInteger(peerIndex) || peerIndex < 0 || peerIndex > P2C_MAX_DERIVABLE_PEER_INDEX) {
    fail("E_P2C_PEER_INDEX", "peerIndex");
  }
}

/**
 * peer seed = SHA-256("LIFE1/PEERSEED/v1" ‖ 0x00 ‖ seedDigest(masterSeed) ‖ 0x00 ‖ ascii(peerIndex))
 *
 * 只依賴 master seed 與 peerIndex，不含生成順序、時間或裝置資料；
 * 因此 0–3 的結果與其他 peer 是否存在無關，未來新增第 5 名也不會改變既有結果。
 */
export function derivePeerSeed(masterSeed: string, peerIndex: number): DerivedPeerSeed {
  assertDerivableIndex(peerIndex);
  let seed: string;
  try {
    seed = normalizeSeed(masterSeed);
  } catch {
    return fail("E_P2A_SEED", "masterSeed");
  }
  const digest = sha256Hex(
    concatBytes(ascii("LIFE1/PEERSEED/v1"), Uint8Array.of(0), seedDigest(seed), Uint8Array.of(0), ascii(String(peerIndex)))
  );
  const peerSeed = `peer-${digest.slice(0, 32)}`;
  return {
    peerSeed,
    peerId: `peer-${peerIndex}-${digest.slice(32, 44)}`,
    derivedSeedHash: seedHash(peerSeed)
  };
}
