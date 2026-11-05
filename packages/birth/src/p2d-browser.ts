import type { SexPolicy } from "@life-sim/contracts";
import { certificateDigest, createBirthCertificate, type CertificateDigest } from "./certificate/build";
import { validateIdentityPack } from "./identity/validate";
import { buildPeerGroup } from "./peer/group";
import { validateDataPack } from "./validate";

export interface CertificateBrowserCase {
  readonly seed: string;
  readonly playerSexPolicy: string;
}

/** P2-D 跨瀏覽器 golden 入口：兩個資料包由呼叫端傳入。 */
export function runCertificateCases(baseRaw: unknown, identityRaw: unknown, cases: readonly CertificateBrowserCase[]): CertificateDigest[] {
  const base = validateDataPack(baseRaw as never);
  const pack = validateIdentityPack(base, identityRaw as never);
  return cases.map((item) => {
    const group = buildPeerGroup(base, pack, { seed: item.seed, playerSexPolicy: item.playerSexPolicy as SexPolicy });
    return certificateDigest(createBirthCertificate(base, pack, group, item.seed));
  });
}
