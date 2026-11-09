import {
  P2C_PEER_COUNT,
  P2C_PEER_SPEC_VERSION,
  P2C_SCHEMA_VERSION,
  type BirthIdentity,
  type PeerGroup,
  type PeerMember,
  type SexPolicy
} from "@life-sim/contracts";
import { ascii, canonicalBytes, concatBytes, normalizeSeed, seedHash, sha256Hex } from "@life-sim/engine";
import { fail } from "../errors";
import { buildBirthIdentity } from "../identity/draw";
import { isValidatedDataPack, isValidatedIdentityPack } from "../attest";
import type { ValidatedIdentityPack } from "../identity/validate";
import type { ValidatedDataPack } from "../validate";
import { assertPeerIndex, derivePeerSeed } from "./derive";

const SEX_POLICIES: readonly SexPolicy[] = ["random", "female", "male"];
const HASH = /^[0-9a-f]{64}$/;
const PEER_ID = /^peer-([0-3])-([0-9a-f]{12})$/;

export interface PeerGroupInput {
  readonly seed: string;
  /** 只控制玩家本人；四名 peer 一律用自己的派生 seed、以 random 抽性別。 */
  readonly playerSexPolicy?: SexPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSeedOrFail(seed: unknown): string {
  if (typeof seed !== "string") return fail("E_P2A_SEED", "masterSeed");
  try {
    return normalizeSeed(seed);
  } catch {
    return fail("E_P2A_SEED", "masterSeed");
  }
}

function assertPlayerSexPolicy(value: unknown): SexPolicy {
  if (typeof value !== "string" || !SEX_POLICIES.includes(value as SexPolicy)) fail("E_P2A_SEX_POLICY", "playerSexPolicy");
  return value as SexPolicy;
}

/** 每次建立或組合 PeerGroup 都重新確認兩個 pack 的綁定與 packKind 規則。 */
function assertPacks(base: unknown, pack: unknown): void {
  if (!isValidatedDataPack(base)) fail("E_P2A_PACK_NOT_VALIDATED", "basePack");
  if (!isValidatedIdentityPack(pack)) fail("E_P2B_PACK_NOT_VALIDATED", "identityPack");
  if (
    pack.manifest.basePackId !== base.manifest.packId ||
    pack.manifest.basePackChecksum !== base.packChecksum ||
    pack.manifest.baseDataVersion !== base.manifest.dataVersion
  ) {
    fail("E_P2B_BASE_PACK_MISMATCH", "basePack");
  }
  if (pack.manifest.packKind === "official" && base.manifest.packKind !== "official") fail("E_P2B_PACK_KIND", "basePack");
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildPeerMember(base: ValidatedDataPack, pack: ValidatedIdentityPack, masterSeed: string, peerIndex: number): PeerMember {
  assertPacks(base, pack);
  assertPeerIndex(peerIndex);
  const seed = normalizeSeedOrFail(masterSeed);
  const derived = derivePeerSeed(seed, peerIndex);
  /* peer 性別一律 random：玩家選 female／male 不會讓四名 peer 全部變成同一性別。 */
  const identity = buildBirthIdentity(base, pack, { seed: derived.peerSeed, sexPolicy: "random" });
  return { peerIndex, peerId: derived.peerId, derivedSeedHash: derived.derivedSeedHash, identity };
}

export function computePeerGroupHash(group: Omit<PeerGroup, "groupHash">): string {
  return sha256Hex(concatBytes(ascii("LIFE1/PEERGROUP/v1"), Uint8Array.of(0), canonicalBytes(group as never)));
}

function assertPeerShape(member: unknown, path: string): asserts member is PeerMember {
  if (!isRecord(member)) fail("E_P2A_TYPE", path);
  assertPeerIndex(member.peerIndex as number);
  const match = typeof member.peerId === "string" ? PEER_ID.exec(member.peerId) : null;
  if (!match) fail("E_P2C_GROUP_MISMATCH", `${path}.peerId`);
  if (Number(match[1]) !== member.peerIndex) fail("E_P2C_GROUP_MISMATCH", `${path}.peerId`);
  if (typeof member.derivedSeedHash !== "string" || !HASH.test(member.derivedSeedHash)) fail("E_P2C_GROUP_MISMATCH", `${path}.derivedSeedHash`);
  if (!isRecord(member.identity)) fail("E_P2A_TYPE", `${path}.identity`);
}

/**
 * 內部使用：呼叫端保證 player 與 members 都是剛由 buildBirthIdentity 產生。
 * 公開 API 請用 assemblePeerGroup（會完整重驗）。
 */
function assembleCore(
  base: ValidatedDataPack,
  pack: ValidatedIdentityPack,
  seed: string,
  player: BirthIdentity,
  members: readonly PeerMember[],
  playerSexPolicy: SexPolicy
): PeerGroup {
  const sorted = [...members].sort((left, right) => left.peerIndex - right.peerIndex);
  const payload = {
    schemaVersion: P2C_SCHEMA_VERSION,
    peerSpecVersion: P2C_PEER_SPEC_VERSION,
    basePackId: base.manifest.packId,
    basePackChecksum: base.packChecksum,
    baseDataVersion: base.manifest.dataVersion,
    identityPackId: pack.manifest.packId,
    identityPackChecksum: pack.packChecksum,
    masterSeedHash: seedHash(seed),
    playerSexPolicy,
    player,
    peers: sorted
  };
  return { ...payload, groupHash: computePeerGroupHash(payload) };
}

function assertMembersAreRecords(members: readonly unknown[]): void {
  for (const member of members) if (!isRecord(member)) fail("E_P2A_TYPE", "peers");
}

function assertCanonicalPeers(members: readonly PeerMember[]): void {
  if (members.length !== P2C_PEER_COUNT) fail("E_P2C_PEER_COUNT", "peers");
  assertMembersAreRecords(members);
  const seenIndexes = new Set<number>();
  const seenPeerIds = new Set<string>();
  for (const member of members) {
    if (typeof member.peerId === "string") {
      if (seenPeerIds.has(member.peerId)) fail("E_P2C_PEER_DUPLICATE", "peers");
      seenPeerIds.add(member.peerId);
    }
  }
  for (let position = 0; position < members.length; position += 1) {
    const member = members[position] as PeerMember;
    assertPeerIndex(member.peerIndex as number);
    if (member.peerIndex !== position) fail("E_P2C_PEER_INDEX", `peers[${position}].peerIndex`);
    if (seenIndexes.has(member.peerIndex)) fail("E_P2C_PEER_INDEX", `peers[${position}].peerIndex`);
    seenIndexes.add(member.peerIndex);
    assertPeerShape(member, `peers[${position}]`);
  }
}

/**
 * 公開組裝：不信任輸入，重新產生玩家與每一名 peer 並逐位元比對。
 * 任何與 masterSeed／派生 seed 不符的資料都會得到 E_P2C_GROUP_MISMATCH，
 * 不會替錯誤資料簽出新的 groupHash。
 */
export function assemblePeerGroup(
  base: ValidatedDataPack,
  pack: ValidatedIdentityPack,
  masterSeed: string,
  player: BirthIdentity,
  members: readonly PeerMember[],
  playerSexPolicy: SexPolicy = "random"
): PeerGroup {
  assertPacks(base, pack);
  const seed = normalizeSeedOrFail(masterSeed);
  const policy = assertPlayerSexPolicy(playerSexPolicy);
  if (!Array.isArray(members)) fail("E_P2A_TYPE", "peers");
  if (!isRecord(player)) fail("E_P2A_TYPE", "player");
  if (members.length !== P2C_PEER_COUNT) fail("E_P2C_PEER_COUNT", "peers");
  assertMembersAreRecords(members);
  const sorted = [...members].sort((left, right) => left.peerIndex - right.peerIndex);
  assertCanonicalPeers(sorted);

  const expectedPlayer = buildBirthIdentity(base, pack, { seed, sexPolicy: policy });
  if (!sameIdentity(expectedPlayer, player)) fail("E_P2C_GROUP_MISMATCH", "player");
  if (player.identityPackChecksum !== pack.packChecksum) fail("E_P2C_GROUP_MISMATCH", "player");

  for (const member of sorted) {
    const derived = derivePeerSeed(seed, member.peerIndex);
    if (member.peerId !== derived.peerId) fail("E_P2C_GROUP_MISMATCH", `peers[${member.peerIndex}].peerId`);
    if (member.derivedSeedHash !== derived.derivedSeedHash) fail("E_P2C_GROUP_MISMATCH", `peers[${member.peerIndex}].derivedSeedHash`);
    const expectedIdentity = buildBirthIdentity(base, pack, { seed: derived.peerSeed, sexPolicy: "random" });
    if (!sameIdentity(expectedIdentity, member.identity)) fail("E_P2C_GROUP_MISMATCH", `peers[${member.peerIndex}].identity`);
  }
  return assembleCore(base, pack, seed, player, sorted, policy);
}

export function buildPeerGroup(base: ValidatedDataPack, pack: ValidatedIdentityPack, input: PeerGroupInput): PeerGroup {
  assertPacks(base, pack);
  if (!isRecord(input)) fail("E_P2A_TYPE", "input");
  const seed = normalizeSeedOrFail(input.seed);
  const policy = assertPlayerSexPolicy(input.playerSexPolicy ?? "random");
  const player = buildBirthIdentity(base, pack, { seed, sexPolicy: policy });
  const members: PeerMember[] = [];
  for (let peerIndex = 0; peerIndex < P2C_PEER_COUNT; peerIndex += 1) {
    members.push(buildPeerMember(base, pack, seed, peerIndex));
  }
  return assembleCore(base, pack, seed, player, members, policy);
}

/**
 * 確認「記錄之後沒有意外變動」：重算 groupHash 並比對。
 * 這不是身分證明——沒有 master seed 時無法證明內容正確。
 */
export function assertPeerGroupHash(group: PeerGroup): void {
  if (!isRecord(group)) fail("E_P2A_TYPE", "group");
  if (group.schemaVersion !== P2C_SCHEMA_VERSION) fail("E_P2C_SCHEMA_VERSION", "group.schemaVersion");
  if (group.peerSpecVersion !== P2C_PEER_SPEC_VERSION) fail("E_P2C_PEER_SPEC_VERSION", "group.peerSpecVersion");
  if (typeof group.groupHash !== "string" || !HASH.test(group.groupHash)) fail("E_P2C_GROUP_HASH", "group.groupHash");
  if (!Array.isArray(group.peers)) fail("E_P2A_TYPE", "group.peers");
  assertMembersAreRecords(group.peers);
  assertCanonicalPeers(group.peers as readonly PeerMember[]);
  if (!isRecord(group.player)) fail("E_P2A_TYPE", "group.player");
  const payload = {
    schemaVersion: group.schemaVersion,
    peerSpecVersion: group.peerSpecVersion,
    basePackId: group.basePackId,
    basePackChecksum: group.basePackChecksum,
    baseDataVersion: group.baseDataVersion,
    identityPackId: group.identityPackId,
    identityPackChecksum: group.identityPackChecksum,
    masterSeedHash: group.masterSeedHash,
    playerSexPolicy: group.playerSexPolicy,
    player: group.player,
    peers: group.peers
  };
  if (computePeerGroupHash(payload) !== group.groupHash) fail("E_P2C_GROUP_HASH", "group.groupHash");
}

/**
 * 配合外部 master seed 證明可重播：重跑整個群組並逐位元比對。
 * 這是唯一能證明「內容與 seed 相符」的檢查。
 */
export function assertPeerGroupMatches(base: ValidatedDataPack, pack: ValidatedIdentityPack, masterSeed: string, group: PeerGroup): void {
  if (!isRecord(group)) fail("E_P2A_TYPE", "group");
  if (group.schemaVersion !== P2C_SCHEMA_VERSION) fail("E_P2C_SCHEMA_VERSION", "group.schemaVersion");
  if (group.peerSpecVersion !== P2C_PEER_SPEC_VERSION) fail("E_P2C_PEER_SPEC_VERSION", "group.peerSpecVersion");
  const policy = assertPlayerSexPolicy(group.playerSexPolicy);
  const rebuilt = buildPeerGroup(base, pack, { seed: masterSeed, playerSexPolicy: policy });
  assertPeerGroupHash(group);
  if (!sameIdentity(rebuilt, group)) fail("E_P2C_GROUP_MISMATCH", "group");
}

export interface PeerGroupDigest {
  readonly masterSeedHash: string;
  readonly playerIdentityHash: string;
  readonly peers: readonly { readonly peerIndex: number; readonly peerId: string; readonly derivedSeedHash: string; readonly identityHash: string }[];
  readonly groupHash: string;
}

/** Golden 用的精簡 digest（不保存完整 identity）。 */
export function peerGroupDigest(group: PeerGroup): PeerGroupDigest {
  return {
    masterSeedHash: group.masterSeedHash,
    playerIdentityHash: group.player.identityHash,
    peers: [...group.peers]
      .sort((left, right) => left.peerIndex - right.peerIndex)
      .map((member) => ({
        peerIndex: member.peerIndex,
        peerId: member.peerId,
        derivedSeedHash: member.derivedSeedHash,
        identityHash: member.identity.identityHash
      })),
    groupHash: group.groupHash
  };
}
