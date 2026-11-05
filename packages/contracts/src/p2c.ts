/**
 * P2-C 同秒出生四人契約（schema `p2c-1`）。
 *
 * PeerGroup 是「玩家 + 4 名 peer」的確定性快照：
 * - 每個 peer 的 seed 由 master seed、固定 domain separation 與 peerIndex 派生，
 *   因此生成順序不影響結果，未來新增第 5 名 peer 也不會改動 0–3。
 * - groupHash 覆蓋兩個資料包來源、玩家身分與四名 peer 的可重播內容。
 */

import type { BirthIdentity } from "./p2b";
import type { SexPolicy } from "./p2a";

export const P2C_SCHEMA_VERSION = "p2c-1" as const;
export type P2CSchemaVersion = typeof P2C_SCHEMA_VERSION;

export const P2C_PEER_SPEC_VERSION = "1.0.0" as const;
export const P2C_PEER_COUNT = 4;

export interface PeerMember {
  readonly peerIndex: number;
  readonly peerId: string;
  readonly derivedSeedHash: string;
  readonly identity: BirthIdentity;
}

export interface PeerGroup {
  readonly schemaVersion: P2CSchemaVersion;
  readonly peerSpecVersion: string;
  readonly basePackId: string;
  readonly basePackChecksum: string;
  readonly baseDataVersion: string;
  readonly identityPackId: string;
  readonly identityPackChecksum: string;
  readonly masterSeedHash: string;
  /** 只套用到玩家；四名 peer 一律以各自的派生 seed 與 random 抽性別。 */
  readonly playerSexPolicy: SexPolicy;
  readonly player: BirthIdentity;
  readonly peers: readonly PeerMember[];
  readonly groupHash: string;
}

export type P2CErrorCode =
  | "E_P2C_SCHEMA_VERSION"
  | "E_P2C_PEER_SPEC_VERSION"
  | "E_P2C_PEER_COUNT"
  | "E_P2C_PEER_INDEX"
  | "E_P2C_PEER_DUPLICATE"
  | "E_P2C_GROUP_HASH"
  | "E_P2C_GROUP_MISMATCH";

export const P2C_ERROR_CODES: readonly P2CErrorCode[] = [
  "E_P2C_SCHEMA_VERSION",
  "E_P2C_PEER_SPEC_VERSION",
  "E_P2C_PEER_COUNT",
  "E_P2C_PEER_INDEX",
  "E_P2C_PEER_DUPLICATE",
  "E_P2C_GROUP_HASH",
  "E_P2C_GROUP_MISMATCH"
];
