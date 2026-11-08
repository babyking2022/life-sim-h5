import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDataPack } from "../src/validate";
import { asRaw, codeOf, dataset, loadPack, repair } from "./helpers";

/**
 * GPT-DEEPSEEK-0046-A：HKG／MAC／TWN 已依使用者要求從遊戲資料中**刪除**。
 *
 * 因此這一組測試從「三個敏感名稱的映射」改成：
 *
 * 1. 這三個名稱／代碼不再出現在正式資料或程式碼裡；
 * 2. 敏感名稱映射表是空的（但機制仍然存在）；
 * 3. 如果有人把某個實體標成敏感，驗證器仍然會拒絕缺漏／未審核／重複／未知的映射。
 */

const REMOVED_NAMES = ["中国香港特别行政区", "中国澳门特别行政区", "中国台湾地区"];
const REMOVED_CODES = ["cr:HKG", "cr:MAC", "cr:TWN"];
const ROOT = process.cwd();

interface MutableEntity {
  entityId: string;
  displayNameZhHans: string | null;
  sensitiveNameRef: string | null;
}

function entityOf(pack: ReturnType<typeof loadPack>, entityId: string): MutableEntity {
  const record = dataset(pack, "country-registry").records.find(
    (entry) => (entry as unknown as MutableEntity).entityId === entityId
  ) as unknown as MutableEntity | undefined;
  if (record === undefined) throw new Error(`missing ${entityId}`);
  return record;
}

function mappingRecord(entityId: string, reviewStatus: "approved" | "pending") {
  return {
    entityId,
    displayNameZhHans: "日本",
    reviewStatus,
    reviewedBy: "test",
    reviewedAt: "2026-11-01",
    note: "test"
  };
}

describe("P2-A sensitive naming（0046-A 之後）", () => {
  it("keeps the three removed names out of the fixtures and the generator", () => {
    const files = [
      join(ROOT, "fixtures", "p2a", "country-registry.v1.json"),
      join(ROOT, "fixtures", "p2a", "indicators.v1.json"),
      join(ROOT, "fixtures", "p2a", "birth-weights.v1.json"),
      join(ROOT, "fixtures", "p2a", "sensitive-names.v1.json")
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const name of REMOVED_NAMES) expect(text, file).not.toContain(name);
      for (const code of REMOVED_CODES) expect(text, file).not.toContain(code);
    }

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
      );
    for (const file of walk(join(ROOT, "packages", "birth", "src"))) {
      const text = readFileSync(file, "utf8");
      for (const name of REMOVED_NAMES) expect(text, file).not.toContain(name);
    }

    const generator = readFileSync(join(ROOT, "scripts", "p2a-generate-fixtures.ts"), "utf8");
    for (const name of REMOVED_NAMES) expect(generator).not.toContain(name);
  });

  it("keeps the mapping table empty but present", () => {
    const mapping = JSON.parse(readFileSync(join(ROOT, "fixtures", "p2a", "sensitive-names.v1.json"), "utf8")) as {
      records: unknown[];
    };
    expect(mapping.records).toHaveLength(0);
  });

  it("rejects a sensitive entity without a mapping entry", () => {
    const pack = loadPack();
    const jpn = entityOf(pack, "cr:JPN");
    jpn.displayNameZhHans = null;
    jpn.sensitiveNameRef = "sn:JPN";
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_SENSITIVE_NAME_MISSING");
  });

  it("rejects an unapproved mapping entry", () => {
    const pack = loadPack();
    const jpn = entityOf(pack, "cr:JPN");
    jpn.displayNameZhHans = null;
    jpn.sensitiveNameRef = "sn:JPN";
    dataset(pack, "sensitive-names").records.push(mappingRecord("cr:JPN", "pending"));
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_SENSITIVE_NAME_UNREVIEWED");
  });

  it("rejects an approved mapping whose entity is still named", () => {
    const pack = loadPack();
    // 實體仍有名稱 → 這條映射沒有對應的敏感實體。
    dataset(pack, "sensitive-names").records.push(mappingRecord("cr:JPN", "approved"));
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_SENSITIVE_NAME_MISSING");
  });

  it("rejects duplicated mapping entries", () => {
    const duplicated = loadPack();
    const jpn = entityOf(duplicated, "cr:JPN");
    jpn.displayNameZhHans = null;
    jpn.sensitiveNameRef = "sn:JPN";
    dataset(duplicated, "sensitive-names").records.push(
      mappingRecord("cr:JPN", "approved"),
      mappingRecord("cr:JPN", "approved")
    );
    repair(duplicated);
    expect(codeOf(() => validateDataPack(asRaw(duplicated)))).toBe("E_P2A_SENSITIVE_NAME_DUPLICATED");
  });

  it("rejects an unknown entity in the mapping table", () => {
    const pack = loadPack();
    dataset(pack, "sensitive-names").records.push(mappingRecord("cr:ZZZ", "approved"));
    repair(pack);
    expect(codeOf(() => validateDataPack(asRaw(pack)))).toBe("E_P2A_UNKNOWN_ENTITY");
  });
});
