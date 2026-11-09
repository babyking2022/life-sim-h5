import {
  P2D_CERTIFICATE_SPEC_VERSION,
  P2D_SCHEMA_VERSION,
  type BirthCertificateSnapshot,
  type CertificatePayload,
  type PeerGroup
} from "@life-sim/contracts";
import { ascii, canonicalBytes, concatBytes, sha256Hex } from "@life-sim/engine";
import { fail } from "../errors";
import { isValidatedDataPack, isValidatedIdentityPack } from "../attest";
import type { ValidatedIdentityPack } from "../identity/validate";
import { assertPeerGroupMatches, buildPeerGroup } from "../peer/group";
import type { ValidatedDataPack } from "../validate";

const HASH = /^[0-9a-f]{64}$/;
const CERT_ID = /^cert:[0-9a-f]{24}$/;
const PEER_ID = /^peer-([0-3])-([0-9a-f]{12})$/;
const SEXES = ["female", "male"] as const;
const SETTLEMENTS = ["urban", "rural"] as const;
const SEX_POLICIES: readonly string[] = ["random", "female", "male"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function requireShape(condition: boolean, path: string): void {
  if (!condition) fail("E_P2D_SHAPE", path);
}

function assertStringFields(record: Record<string, unknown>, fields: readonly string[], path: string): void {
  for (const field of fields) requireShape(isText(record[field]), `${path}.${field}`);
}

function assertSafeIntFields(record: Record<string, unknown>, fields: readonly string[], path: string): void {
  for (const field of fields) requireShape(isSafeInt(record[field]), `${path}.${field}`);
}

function assertHashFields(record: Record<string, unknown>, fields: readonly string[], path: string): void {
  for (const field of fields) requireShape(isHash(record[field]), `${path}.${field}`);
}

function assertNameShape(value: unknown, path: string): void {
  requireShape(isRecord(value), path);
  const name = value as Record<string, unknown>;
  assertStringFields(name, ["fullName", "surname", "givenName", "cultureId", "script"], path);
}

function assertBirthShape(value: unknown, path: string): void {
  requireShape(isRecord(value), path);
  const birth = value as Record<string, unknown>;
  assertStringFields(birth, ["entityId", "regionCode", "region", "displayNameZhHans", "weightBandId"], path);
  requireShape(isSafeInt(birth.birthYear), `${path}.birthYear`);
  requireShape(SEXES.includes(birth.sex as (typeof SEXES)[number]), `${path}.sex`);
  requireShape(isSafeInt(birth.weightGrams), `${path}.weightGrams`);
}

function assertFamilyShape(value: unknown, path: string): void {
  requireShape(isRecord(value), path);
  const family = value as Record<string, unknown>;
  requireShape(SETTLEMENTS.includes(family.settlement as (typeof SETTLEMENTS)[number]), `${path}.settlement`);
  requireShape(typeof family.urban === "boolean", `${path}.urban`);
  requireShape(isSafeInt(family.incomeQuintile) && family.incomeQuintile >= 1 && family.incomeQuintile <= 5, `${path}.incomeQuintile`);
  assertStringFields(
    family,
    ["incomeLabel", "housing", "housingLabel", "religionId", "religionLabel", "motherOccupationLabel", "fatherOccupationLabel"],
    path
  );
  requireShape(isSafeInt(family.motherAge), `${path}.motherAge`);
  requireShape(isSafeInt(family.fatherAge), `${path}.fatherAge`);
}

function assertVitalsShape(value: unknown, path: string): void {
  requireShape(isRecord(value), path);
  assertSafeIntFields(value as Record<string, unknown>, ["lifeExpectancyYearsX10", "under5MortalityPer1000X10", "gdpPerCapitaPppUsd"], path);
}

function assertStoryShape(value: unknown, path: string): void {
  requireShape(isRecord(value), path);
  const story = value as Record<string, unknown>;
  requireShape(isText(story.templateId), `${path}.templateId`);
  requireShape(Array.isArray(story.paragraphs), `${path}.paragraphs`);
  for (let index = 0; index < (story.paragraphs as unknown[]).length; index += 1) {
    requireShape(typeof (story.paragraphs as unknown[])[index] === "string", `${path}.paragraphs[${index}]`);
  }
}

function assertPlayerShape(value: unknown, path: string): void {
  requireShape(isRecord(value), path);
  const player = value as Record<string, unknown>;
  requireShape(isHash(player.identityHash), `${path}.identityHash`);
  requireShape(isText(player.certificateNumber), `${path}.certificateNumber`);
  assertNameShape(player.name, `${path}.name`);
  assertBirthShape(player.birth, `${path}.birth`);
  assertFamilyShape(player.family, `${path}.family`);
  assertVitalsShape(player.vitals, `${path}.vitals`);
  assertStoryShape(player.story, `${path}.story`);
}

function assertPeerShape(value: unknown, expectedIndex: number, path: string): void {
  requireShape(isRecord(value), path);
  const peer = value as Record<string, unknown>;
  requireShape(isSafeInt(peer.peerIndex) && peer.peerIndex === expectedIndex, `${path}.peerIndex`);
  const match = typeof peer.peerId === "string" ? PEER_ID.exec(peer.peerId) : null;
  requireShape(match !== null && Number(match[1]) === expectedIndex, `${path}.peerId`);
  requireShape(isHash(peer.identityHash), `${path}.identityHash`);
  assertStringFields(peer, ["entityId", "regionCode", "region", "displayNameZhHans", "weightBandId", "fullName"], path);
  requireShape(isSafeInt(peer.birthYear), `${path}.birthYear`);
  requireShape(SEXES.includes(peer.sex as (typeof SEXES)[number]), `${path}.sex`);
  requireShape(isSafeInt(peer.weightGrams), `${path}.weightGrams`);
}

/**
 * 共用結構驗證器（不含 certificateHash）：所有公開 API 都先跑這一段，
 * 確保缺欄位、null、陣列、錯誤型別與非安全整數不會被重新簽 hash 後接受。
 */
export function assertCertificatePayloadShape(payload: unknown): asserts payload is CertificatePayload {
  if (!isRecord(payload)) fail("E_P2A_TYPE", "certificate");
  if (payload.schemaVersion !== P2D_SCHEMA_VERSION) fail("E_P2D_SCHEMA_VERSION", "certificate.schemaVersion");
  if (payload.certificateSpecVersion !== P2D_CERTIFICATE_SPEC_VERSION) {
    fail("E_P2D_CERTIFICATE_SPEC_VERSION", "certificate.certificateSpecVersion");
  }
  requireShape(typeof payload.certificateId === "string" && CERT_ID.test(payload.certificateId), "certificate.certificateId");
  requireShape(isHash(payload.masterSeedHash), "certificate.masterSeedHash");
  if (typeof payload.playerSexPolicy !== "string" || !SEX_POLICIES.includes(payload.playerSexPolicy)) {
    fail("E_P2A_SEX_POLICY", "certificate.playerSexPolicy");
  }
  const packs = payload.packs;
  requireShape(isRecord(packs), "certificate.packs");
  const packsRecord = packs as Record<string, unknown>;
  assertStringFields(packsRecord, ["basePackId", "baseDataVersion", "identityPackId", "peerSpecVersion"], "certificate.packs");
  assertHashFields(packsRecord, ["basePackChecksum", "identityPackChecksum", "peerGroupHash"], "certificate.packs");
  assertPlayerShape(payload.player, "certificate.player");
  requireShape(Array.isArray(payload.peers) && payload.peers.length === 4, "certificate.peers");
  const peers = payload.peers as unknown[];
  for (let position = 0; position < peers.length; position += 1) {
    assertPeerShape(peers[position], position, `certificate.peers[${position}]`);
  }
}

function assertCertificateShape(certificate: unknown): asserts certificate is BirthCertificateSnapshot {
  assertCertificatePayloadShape(certificate);
  requireShape(isHash((certificate as { certificateHash?: unknown }).certificateHash), "certificate.certificateHash");
}

export interface CertificateDigest {
  readonly certificateId: string;
  readonly masterSeedHash: string;
  readonly playerIdentityHash: string;
  readonly peerGroupHash: string;
  readonly certificateHash: string;
}

export function computeCertificateHash(payload: CertificatePayload): string {
  assertCertificatePayloadShape(payload);
  return sha256Hex(concatBytes(ascii("LIFE1/BIRTHCERTIFICATE/v1"), Uint8Array.of(0), canonicalBytes(payload as never)));
}

/** 每次建立／驗證證書都重新確認兩個 pack 的綁定與 packKind 規則。 */
function assertPackBinding(base: unknown, pack: unknown): void {
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

function summarize(group: PeerGroup): BirthCertificateSnapshot {
  const player = group.player;
  const payload: CertificatePayload = {
    schemaVersion: P2D_SCHEMA_VERSION,
    certificateSpecVersion: P2D_CERTIFICATE_SPEC_VERSION,
    certificateId: `cert:${group.groupHash.slice(0, 24)}`,
    masterSeedHash: group.masterSeedHash,
    playerSexPolicy: group.playerSexPolicy,
    packs: {
      basePackId: group.basePackId,
      basePackChecksum: group.basePackChecksum,
      baseDataVersion: group.baseDataVersion,
      identityPackId: group.identityPackId,
      identityPackChecksum: group.identityPackChecksum,
      peerSpecVersion: group.peerSpecVersion,
      peerGroupHash: group.groupHash
    },
    player: {
      identityHash: player.identityHash,
      certificateNumber: player.certificate.fullNumber,
      name: {
        fullName: player.name.fullName,
        surname: player.name.surname,
        givenName: player.name.givenName,
        cultureId: player.name.cultureId,
        script: player.name.script
      },
      birth: {
        entityId: player.birth.entityId,
        regionCode: player.birth.regionCode,
        region: player.birth.region,
        displayNameZhHans: player.birth.displayNameZhHans,
        birthYear: player.birth.birthYear,
        sex: player.birth.sex,
        weightGrams: player.birth.weightGrams,
        weightBandId: player.birth.weightBandId
      },
      family: {
        settlement: player.place.settlement,
        urban: player.place.urban,
        incomeQuintile: player.household.incomeQuintile,
        incomeLabel: player.household.incomeLabel,
        housing: player.household.housing,
        housingLabel: player.household.housingLabel,
        religionId: player.religion.religionId,
        religionLabel: player.religion.label,
        motherAge: player.parents.motherAge,
        fatherAge: player.parents.fatherAge,
        motherOccupationLabel: player.parents.motherOccupationLabel,
        fatherOccupationLabel: player.parents.fatherOccupationLabel
      },
      vitals: {
        lifeExpectancyYearsX10: player.vitals.lifeExpectancyYearsX10,
        under5MortalityPer1000X10: player.vitals.under5MortalityPer1000X10,
        gdpPerCapitaPppUsd: player.vitals.gdpPerCapitaPppUsd
      },
      story: { templateId: player.story.templateId, paragraphs: [...player.story.paragraphs] }
    },
    peers: [...group.peers]
      .sort((left, right) => left.peerIndex - right.peerIndex)
      .map((member) => ({
        peerIndex: member.peerIndex,
        peerId: member.peerId,
        identityHash: member.identity.identityHash,
        entityId: member.identity.birth.entityId,
        regionCode: member.identity.birth.regionCode,
        region: member.identity.birth.region,
        displayNameZhHans: member.identity.birth.displayNameZhHans,
        birthYear: member.identity.birth.birthYear,
        sex: member.identity.birth.sex,
        weightGrams: member.identity.birth.weightGrams,
        weightBandId: member.identity.birth.weightBandId,
        fullName: member.identity.name.fullName
      }))
  };
  return { ...payload, certificateHash: computeCertificateHash(payload) };
}

/**
 * 公開建立 API：先確認 group 與 master seed／packs 相符，再彙整證書。
 * 不抽任何新的隨機值，也不修改傳入的 pack／PeerGroup。
 */
export function createBirthCertificate(
  base: ValidatedDataPack,
  pack: ValidatedIdentityPack,
  group: PeerGroup,
  masterSeed: string
): BirthCertificateSnapshot {
  assertPackBinding(base, pack);
  if (!isRecord(group)) fail("E_P2A_TYPE", "group");
  if (typeof masterSeed !== "string") fail("E_P2A_SEED", "masterSeed");
  if (group.basePackChecksum !== base.packChecksum || group.identityPackChecksum !== pack.packChecksum) {
    fail("E_P2D_PACK_MISMATCH", "group");
  }
  assertPeerGroupMatches(base, pack, masterSeed, group);
  return summarize(group);
}

/** 只證明記錄未被意外改動；不是身分證明。 */
export function assertBirthCertificateHash(certificate: BirthCertificateSnapshot): void {
  assertCertificateShape(certificate);
  const { certificateHash, ...payload } = certificate;
  if (computeCertificateHash(payload as CertificatePayload) !== certificateHash) fail("E_P2D_HASH", "certificate.certificateHash");
}

/** 配合外部 master seed 重跑整個證書並逐位元比對（唯一能證明可重播的檢查）。 */
export function assertBirthCertificateMatches(
  base: ValidatedDataPack,
  pack: ValidatedIdentityPack,
  certificate: BirthCertificateSnapshot,
  masterSeed: string
): void {
  assertPackBinding(base, pack);
  assertCertificateShape(certificate);
  if (typeof masterSeed !== "string") fail("E_P2A_SEED", "masterSeed");
  const policy = certificate.playerSexPolicy;
  const group = buildPeerGroup(base, pack, { seed: masterSeed, playerSexPolicy: policy });
  const expected = summarize(group);
  if (JSON.stringify(expected) !== JSON.stringify(certificate)) fail("E_P2D_MISMATCH", "certificate");
  assertBirthCertificateHash(certificate);
}

/** Golden 用的精簡 digest；先做完整結構驗證。 */
export function certificateDigest(certificate: BirthCertificateSnapshot): CertificateDigest {
  assertCertificateShape(certificate);
  return {
    certificateId: certificate.certificateId,
    masterSeedHash: certificate.masterSeedHash,
    playerIdentityHash: certificate.player.identityHash,
    peerGroupHash: certificate.packs.peerGroupHash,
    certificateHash: certificate.certificateHash
  };
}
