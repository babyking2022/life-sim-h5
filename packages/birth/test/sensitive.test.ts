import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDataPack } from "../src/validate";
import { asRaw, codeOf, dataset, loadPack, recordAt, repair } from "./helpers";

const NAMES = ["中国香港特别行政区", "中国澳门特别行政区", "中国台湾地区"];
const ROOT = process.cwd();

describe("P2-A sensitive naming", () => {
  it("keeps the three sensitive names out of source code and the registry file", () => {
    const registry = readFileSync(join(ROOT, "fixtures", "p2a", "country-registry.v1.json"), "utf8");
    for (const name of NAMES) expect(registry).not.toContain(name);

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
    for (const file of walk(join(ROOT, "packages", "birth", "src"))) {
      const text = readFileSync(file, "utf8");
      for (const name of NAMES) expect(text).not.toContain(name);
    }

    const generator = readFileSync(join(ROOT, "scripts", "p2a-generate-fixtures.ts"), "utf8");
    for (const name of NAMES) expect(generator).not.toContain(name);
  });

  it("keeps the mapping table small, reviewable and approved", () => {
    const mapping = JSON.parse(readFileSync(join(ROOT, "fixtures", "p2a", "sensitive-names.v1.json"), "utf8"));
    expect(mapping.records).toHaveLength(3);
    for (const record of mapping.records) {
      expect(record.reviewStatus).toBe("approved");
      expect(record.reviewedBy.length).toBeGreaterThan(0);
      expect(record.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(NAMES).toContain(record.displayNameZhHans);
    }
  });

  it("rejects a sensitive entity without a mapping entry", () => {
    const pack = loadPack();
    const index = dataset(pack, "sensitive-names").records.findIndex((record) => record.entityId === "cr:HKG");
    dataset(pack, "sensitive-names").records.splice(index, 1);
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_SENSITIVE_NAME_MISSING");
  });

  it("rejects an unapproved mapping entry", () => {
    const pack = loadPack();
    const record = dataset(pack, "sensitive-names").records.find((entry) => entry.entityId === "cr:MAC");
    if (!record) throw new Error("missing MAC mapping");
    record.reviewStatus = "pending";
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_SENSITIVE_NAME_UNREVIEWED");
  });

  it("rejects duplicated and unknown mapping entries", () => {
    const duplicate = loadPack();
    dataset(duplicate, "sensitive-names").records.push(structuredClone(recordAt(duplicate, "sensitive-names", 0)));
    repair(duplicate);
    expect(codeOf(() => validateDataPack(asRaw(duplicate)))).toBe("E_P2A_SENSITIVE_NAME_DUPLICATED");

    const unknown = loadPack();
    const extra = structuredClone(recordAt(unknown, "sensitive-names", 0));
    extra.entityId = "cr:ZZZ";
    dataset(unknown, "sensitive-names").records.push(extra);
    repair(unknown);
    expect(codeOf(() => validateDataPack(asRaw(unknown)))).toBe("E_P2A_UNKNOWN_ENTITY");
  });
});
