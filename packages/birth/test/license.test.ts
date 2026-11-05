import { describe, expect, it } from "vitest";
import type { LicenseRecord } from "@life-sim/contracts";
import { BirthDataError } from "../src/errors";
import { assertLicenseGate } from "../src/license";
import { validateDataPack } from "../src/validate";
import { asRaw, dataset, loadPack, recordAt, repair, repairChecksums } from "./helpers";

function license(overrides: Partial<LicenseRecord> = {}): LicenseRecord {
  return {
    sourceId: "SYNTH-TEST-1",
    datasetId: "indicators",
    datasetLabel: "test",
    sourceKind: "synthetic",
    sourceName: "test source",
    sourceUrl: null,
    version: "1.0.0",
    retrievedAt: "2026-10-27",
    license: "granted",
    licenseId: "SYNTHETIC-TEST-ONLY-1.0",
    commercialUse: "allowed",
    legalStatus: "cleared",
    evidence: ["docs/p2a/license-registry.md#synthetic-test-data"],
    grant: null,
    checksum: "a".repeat(64),
    lineageId: "lin:test",
    notes: "",
    ...overrides
  };
}

function gateCode(record: LicenseRecord): string {
  try {
    assertLicenseGate(record, "test");
    return "OK";
  } catch (error) {
    return error instanceof BirthDataError ? error.code : "OTHER";
  }
}

describe("P2-A license gate", () => {
  it("passes a fully granted synthetic license", () => {
    expect(gateCode(license())).toBe("OK");
  });

  it("blocks unknown and not_allowed licenses", () => {
    expect(gateCode(license({ license: "unknown" }))).toBe("E_P2A_LICENSE_UNKNOWN");
    expect(gateCode(license({ license: "not_allowed" }))).toBe("E_P2A_LICENSE_NOT_ALLOWED");
  });

  it("requires a grant and evidence for permission_required", () => {
    expect(gateCode(license({ license: "permission_required" }))).toBe("E_P2A_LICENSE_PERMISSION_MISSING");
    expect(
      gateCode(license({ license: "permission_required", grant: { granted: false, evidence: "x", grantedAt: "2026-10-27" } }))
    ).toBe("E_P2A_LICENSE_PERMISSION_MISSING");
    expect(
      gateCode(license({ license: "permission_required", grant: { granted: true, evidence: "", grantedAt: "2026-10-27" } }))
    ).toBe("E_P2A_LICENSE_EVIDENCE_MISSING");
    expect(
      gateCode(license({ license: "permission_required", grant: { granted: true, evidence: "mail", grantedAt: "2026-10-27" }, evidence: [] }))
    ).toBe("E_P2A_LICENSE_EVIDENCE_MISSING");
    expect(gateCode(license({ license: "permission_required", grant: { granted: true, evidence: "mail", grantedAt: "2026-10-27" } }))).toBe("OK");
  });

  it("requires cleared, commercial and evidence for granted licenses", () => {
    expect(gateCode(license({ legalStatus: "pending" }))).toBe("E_P2A_LICENSE_LEGAL_PENDING");
    expect(gateCode(license({ legalStatus: "rejected" }))).toBe("E_P2A_LICENSE_LEGAL_PENDING");
    expect(gateCode(license({ commercialUse: "not_allowed" }))).toBe("E_P2A_LICENSE_COMMERCIAL_BLOCKED");
    expect(gateCode(license({ commercialUse: "unknown" }))).toBe("E_P2A_LICENSE_COMMERCIAL_BLOCKED");
    expect(gateCode(license({ evidence: [] }))).toBe("E_P2A_LICENSE_EVIDENCE_MISSING");
    expect(gateCode(license({ licenseId: null }))).toBe("E_P2A_LICENSE_EVIDENCE_MISSING");
  });

  it("rejects an unknown, not_allowed or unapproved source inside a pack", () => {
    const unknown = loadPack();
    recordAt(unknown, "licenses", 0).license = "unknown";
    repairChecksums(unknown);
    expect(() => validateDataPack(asRaw(unknown))).toThrowError(BirthDataError);

    const blocked = loadPack();
    recordAt(blocked, "licenses", 1).license = "not_allowed";
    repairChecksums(blocked);
    expect(() => validateDataPack(asRaw(blocked))).toThrowError(/E_P2A_LICENSE_NOT_ALLOWED/);

    const pending = loadPack();
    recordAt(pending, "licenses", 2).legalStatus = "pending";
    repairChecksums(pending);
    expect(() => validateDataPack(asRaw(pending))).toThrowError(/E_P2A_LICENSE_LEGAL_PENDING/);
  });

  it("rejects a license whose checksum does not match its dataset", () => {
    const pack = loadPack();
    recordAt(pack, "licenses", 0).checksum = "0".repeat(64);
    repairChecksums(pack);
    let code = "NO_ERROR";
    try {
      validateDataPack(asRaw(pack));
    } catch (error) {
      code = error instanceof BirthDataError ? error.code : "OTHER";
    }
    expect(code).toBe("E_P2A_LICENSE_CHECKSUM_MISMATCH");
  });

  it("rejects a data dataset with no license record", () => {
    const pack = loadPack();
    dataset(pack, "licenses").records.pop();
    repair(pack);
    let code = "NO_ERROR";
    try {
      validateDataPack(asRaw(pack));
    } catch (error) {
      code = error instanceof BirthDataError ? error.code : "OTHER";
    }
    expect(code).toBe("E_P2A_LICENSE_MISSING");
  });

  it("does not ship WHO, World Happiness Report or other unconfirmed sources", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    for (const record of pack.licenses) {
      const text = `${record.sourceId} ${record.sourceName} ${record.datasetLabel}`.toLowerCase();
      expect(text).not.toContain("who");
      expect(text).not.toContain("world happiness");
      expect(text).not.toContain("whr");
      expect(record.sourceKind).toBe("synthetic");
      expect(record.licenseId).toBe("SYNTHETIC-TEST-ONLY-1.0");
    }
  });
});
