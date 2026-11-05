import type { LicenseRecord } from "@life-sim/contracts";
import { fail } from "./errors";

/**
 * 授權門檻（P2-A 唯一入口）。順序固定，錯誤碼因此可預期：
 * 1. unknown / not_allowed 直接拒絕；
 * 2. permission_required 必須有 grant.granted 與證據；
 * 3. 法務狀態必須 cleared；
 * 4. 商用必須 allowed；
 * 5. evidence 與 licenseId 必須存在。
 */
export function assertLicenseGate(record: LicenseRecord, path: string): void {
  switch (record.license) {
    case "unknown":
      fail("E_P2A_LICENSE_UNKNOWN", `${path}.license`);
      break;
    case "not_allowed":
      fail("E_P2A_LICENSE_NOT_ALLOWED", `${path}.license`);
      break;
    case "permission_required":
      if (record.grant === null || record.grant.granted !== true) fail("E_P2A_LICENSE_PERMISSION_MISSING", `${path}.grant`);
      if (record.grant.evidence.trim().length === 0 || record.evidence.length === 0) {
        fail("E_P2A_LICENSE_EVIDENCE_MISSING", `${path}.grant.evidence`);
      }
      break;
    case "granted":
      break;
  }
  if (record.legalStatus !== "cleared") fail("E_P2A_LICENSE_LEGAL_PENDING", `${path}.legalStatus`);
  if (record.commercialUse !== "allowed") fail("E_P2A_LICENSE_COMMERCIAL_BLOCKED", `${path}.commercialUse`);
  if (record.evidence.length === 0) fail("E_P2A_LICENSE_EVIDENCE_MISSING", `${path}.evidence`);
  if (record.licenseId === null || record.licenseId.trim().length === 0) fail("E_P2A_LICENSE_EVIDENCE_MISSING", `${path}.licenseId`);
}
