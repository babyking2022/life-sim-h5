/**
 * P2-D 出生證書／出生結果快照契約（schema `p2d-1`）。
 *
 * 證書只彙整已驗證的 P2-C.1 PeerGroup（玩家＋四名同秒 peers），
 * 不再抽任何新的隨機值；因此同一 PeerGroup 產生的證書逐位元相同。
 */

import type { SexPolicy } from "./p2a";

export const P2D_SCHEMA_VERSION = "p2d-1" as const;
export type P2DSchemaVersion = typeof P2D_SCHEMA_VERSION;

export const P2D_CERTIFICATE_SPEC_VERSION = "1.0.0" as const;

export interface CertificateNameSummary {
  readonly fullName: string;
  readonly surname: string;
  readonly givenName: string;
  readonly cultureId: string;
  readonly script: string;
}

export interface CertificateBirthSummary {
  readonly entityId: string;
  readonly regionCode: string;
  readonly region: string;
  readonly displayNameZhHans: string;
  readonly birthYear: number;
  readonly sex: "female" | "male";
  readonly weightGrams: number;
  readonly weightBandId: string;
}

export interface CertificateFamilySummary {
  readonly settlement: "urban" | "rural";
  readonly urban: boolean;
  readonly incomeQuintile: number;
  readonly incomeLabel: string;
  readonly housing: string;
  readonly housingLabel: string;
  readonly religionId: string;
  readonly religionLabel: string;
  readonly motherAge: number;
  readonly fatherAge: number;
  readonly motherOccupationLabel: string;
  readonly fatherOccupationLabel: string;
}

export interface CertificateVitalsSummary {
  readonly lifeExpectancyYearsX10: number;
  readonly under5MortalityPer1000X10: number;
  readonly gdpPerCapitaPppUsd: number;
}

export interface CertificateStorySummary {
  readonly templateId: string;
  readonly paragraphs: readonly string[];
}

export interface CertificatePlayerSummary {
  readonly identityHash: string;
  /** 證書編號（P2-B.1 產生，不是真實登記編號）。 */
  readonly certificateNumber: string;
  readonly name: CertificateNameSummary;
  readonly birth: CertificateBirthSummary;
  readonly family: CertificateFamilySummary;
  readonly vitals: CertificateVitalsSummary;
  readonly story: CertificateStorySummary;
}

export interface CertificatePeerSummary {
  readonly peerIndex: number;
  readonly peerId: string;
  readonly identityHash: string;
  readonly entityId: string;
  readonly regionCode: string;
  readonly region: string;
  readonly displayNameZhHans: string;
  readonly birthYear: number;
  readonly sex: "female" | "male";
  readonly weightGrams: number;
  readonly weightBandId: string;
  readonly fullName: string;
}

export interface CertificatePacks {
  readonly basePackId: string;
  readonly basePackChecksum: string;
  readonly baseDataVersion: string;
  readonly identityPackId: string;
  readonly identityPackChecksum: string;
  /** peer 資料包版本（PeerGroup peerSpecVersion）。 */
  readonly peerSpecVersion: string;
  readonly peerGroupHash: string;
}

/** 證書內容（不含 certificateHash）；hash 由這整個 payload 計算。 */
export interface CertificatePayload {
  readonly schemaVersion: P2DSchemaVersion;
  readonly certificateSpecVersion: string;
  readonly certificateId: string;
  readonly masterSeedHash: string;
  readonly playerSexPolicy: SexPolicy;
  readonly packs: CertificatePacks;
  readonly player: CertificatePlayerSummary;
  /** 四名同秒出生角色，固定依 peerIndex 0–3 排序。 */
  readonly peers: readonly CertificatePeerSummary[];
}

export interface BirthCertificateSnapshot extends CertificatePayload {
  readonly certificateHash: string;
}

export type P2DErrorCode =
  | "E_P2D_SCHEMA_VERSION"
  | "E_P2D_CERTIFICATE_SPEC_VERSION"
  | "E_P2D_SHAPE"
  | "E_P2D_HASH"
  | "E_P2D_MISMATCH"
  | "E_P2D_PACK_MISMATCH";

export const P2D_ERROR_CODES: readonly P2DErrorCode[] = [
  "E_P2D_SCHEMA_VERSION",
  "E_P2D_CERTIFICATE_SPEC_VERSION",
  "E_P2D_SHAPE",
  "E_P2D_HASH",
  "E_P2D_MISMATCH",
  "E_P2D_PACK_MISMATCH"
];
