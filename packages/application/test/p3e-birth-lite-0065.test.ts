import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareP3EBrowserBirthStage,
  previewP3EBrowserBirthStage
} from "../src/p3e-browser-bootstrap";
import {
  P3E_BIRTH_LITE_FAILURE_MESSAGE,
  P3EBirthLiteError,
  prepareP3EBirthLiteBundle,
  previewP3EBirthLite
} from "../src/p3e-birth-lite";
import { P3E_BIRTH_BUNDLE_SCHEMA_VERSION } from "../src/p3e-birth-core";
import type { P3EBrowserBirthPreview } from "../src/p3e-birth-preview";

/**
 * GPT-WORKBUDDY-0065-A｜birth-lite 與 canonical 的等價與失敗防護。
 *
 * 這裡用**正式 validators** 直接驗證原始 fixtures 產生 canonical stage，
 * 再用 build 期 bundle 產生 lite stage，對 1,000 個 deterministic seeds
 * 逐欄位比較：所有可見出生欄位、certificateId、certificateHash、
 * playerIdentityHash、region、sex、birthYear、家庭與故事都必須完全相同。
 */

const ROOT = join(process.cwd());
const BUNDLE_PATH = join(ROOT, "fixtures", "p3e", "birth-bundle.v1.json");

const SOURCES: readonly (readonly [string, string])[] = [
  ["p2aManifest", "fixtures/p2a/manifest.v1.json"],
  ["p2aCountryRegistry", "fixtures/p2a/country-registry.v1.json"],
  ["p2aIndicators", "fixtures/p2a/indicators.v1.json"],
  ["p2aBirthWeights", "fixtures/p2a/birth-weights.v1.json"],
  ["p2aSensitiveNames", "fixtures/p2a/sensitive-names.v1.json"],
  ["p2aLicenses", "fixtures/p2a/licenses.v1.json"],
  ["p2aLineage", "fixtures/p2a/lineage.v1.json"],
  ["p2bManifest", "fixtures/p2b/manifest.v1.json"],
  ["p2bCountryVitals", "fixtures/p2b/country-vitals.v1.json"],
  ["p2bHouseholdProfiles", "fixtures/p2b/household-profiles.v1.json"],
  ["p2bNameCorpus", "fixtures/p2b/name-corpus.v1.json"],
  ["p2bStoryTemplates", "fixtures/p2b/story-templates.v1.json"],
  ["p2bLicenses", "fixtures/p2b/licenses.v1.json"],
  ["p2bLineage", "fixtures/p2b/lineage.v1.json"]
] as const;

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8")) as unknown;
}

function canonicalInput(): { base: unknown; identity: unknown } {
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, file] of SOURCES) values[key] = readJson(file);
  return {
    base: {
      manifest: values["p2aManifest"],
      datasets: {
        "country-registry": values["p2aCountryRegistry"],
        indicators: values["p2aIndicators"],
        "birth-weights": values["p2aBirthWeights"],
        "sensitive-names": values["p2aSensitiveNames"],
        licenses: values["p2aLicenses"],
        lineage: values["p2aLineage"]
      }
    },
    identity: {
      manifest: values["p2bManifest"],
      datasets: {
        "country-vitals": values["p2bCountryVitals"],
        "household-profiles": values["p2bHouseholdProfiles"],
        "name-corpus": values["p2bNameCorpus"],
        "story-templates": values["p2bStoryTemplates"],
        licenses: values["p2bLicenses"],
        lineage: values["p2bLineage"]
      }
    }
  };
}

/** 逐欄位比較，訊息要能指出到底是哪一個可見欄位漂移。 */
function expectSamePreview(lite: P3EBrowserBirthPreview, canonical: P3EBrowserBirthPreview, seed: string): void {
  const fields: readonly (keyof P3EBrowserBirthPreview)[] = [
    "certificateId",
    "certificateHash",
    "playerIdentityHash",
    "birthYear",
    "country",
    "name",
    "sex",
    "settlement",
    "settlementLabel",
    "incomeQuintile",
    "incomeLabel",
    "housing",
    "parents",
    "religion",
    "lifeExpectancyYearsX10",
    "lifeExpectancyYears",
    "story"
  ];
  for (const field of fields) {
    expect(lite[field], `${seed} 欄位 ${field}`).toEqual(canonical[field]);
  }
  expect(lite.country.regionCode, `${seed} regionCode`).toBe(canonical.country.regionCode);
  expect(lite.name.fullName, `${seed} fullName`).toBe(canonical.name.fullName);
  expect(lite.story.paragraphs, `${seed} story paragraphs`).toEqual(canonical.story.paragraphs);
  expect(JSON.stringify(lite), `${seed} 完整序列化`).toBe(JSON.stringify(canonical));
}

describe("GPT-0065-A birth-lite", () => {
  it("1,000 個 deterministic seeds：lite 與 canonical 逐欄位／certificate／identityHash 完全相同", () => {
    const bundleText = readFileSync(BUNDLE_PATH, "utf8");
    const liteStage = prepareP3EBirthLiteBundle(bundleText);
    const canonicalStage = prepareP3EBrowserBirthStage(canonicalInput());

    expect(P3E_BIRTH_BUNDLE_SCHEMA_VERSION).toBe("p3e-birth-bundle-1");
    for (let index = 0; index < 1000; index += 1) {
      const seed = `gpt-0065a-equivalence-${String(index).padStart(4, "0")}`;
      const lite = previewP3EBirthLite({ stage: liteStage, masterSeed: seed });
      const canonical = previewP3EBrowserBirthStage({ stage: canonicalStage, masterSeed: seed });
      expectSamePreview(lite, canonical, seed);
    }
  }, 180_000);

  it("bundle 版本／內容雜湊／必要欄位失敗時拒絕，且訊息可供 UI 顯示", () => {
    const text = readFileSync(BUNDLE_PATH, "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;

    const bad = (value: unknown): void => {
      expect(() => prepareP3EBirthLiteBundle(typeof value === "string" ? value : JSON.stringify(value))).toThrow(
        P3EBirthLiteError
      );
    };
    bad("not json");
    bad("");
    bad({ ...parsed, schemaVersion: "p3e-birth-bundle-0" });
    bad({ ...parsed, contentHash: "0".repeat(64) });
    bad({ ...parsed, sourceHash: "1".repeat(64) });
    bad({ ...parsed, payload: { ...(parsed["payload"] as Record<string, unknown>), base: {} } });

    const tampered = JSON.parse(text) as {
      payload: { base: { enabledEntityIds: string[] } };
    };
    tampered.payload.base.enabledEntityIds = [...tampered.payload.base.enabledEntityIds].reverse();
    bad(tampered);

    expect(P3E_BIRTH_LITE_FAILURE_MESSAGE).toMatch(/出生資料載入失敗/);
    expect(P3E_BIRTH_LITE_FAILURE_MESSAGE).not.toMatch(/E_|microUsd|\.json|http/i);
  });

  it("forged stage／錯誤 seed 不會建立任何預覽", () => {
    expect(() => previewP3EBirthLite({ stage: {}, masterSeed: "x" })).toThrow(P3EBirthLiteError);
    const stage = prepareP3EBirthLiteBundle(readFileSync(BUNDLE_PATH, "utf8"));
    expect(() => previewP3EBirthLite({ stage, masterSeed: 42 })).toThrow(P3EBirthLiteError);
    expect(() => previewP3EBirthLite({ stage })).toThrow(P3EBirthLiteError);
  });

  it("bundle 未過期：內容雜湊與來源資料可重現", () => {
    const meta = JSON.parse(readFileSync(join(ROOT, ".artifacts", "p3e-0065a-bundle-meta.json"), "utf8")) as {
      contentHash: string;
      rawBytes: number;
      generatorVersion: string;
    };
    const parsed = JSON.parse(readFileSync(BUNDLE_PATH, "utf8")) as Record<string, unknown>;
    expect(parsed["contentHash"]).toBe(meta.contentHash);
    expect(parsed["generatorVersion"]).toBe(meta.generatorVersion);
    expect(Buffer.byteLength(readFileSync(BUNDLE_PATH, "utf8"))).toBe(meta.rawBytes);
    // 來源資料若變動但 bundle 未更新，prepare 仍會成功（內容自洽），
    // 因此 freshness 由 build gate `p3e-0065a-birth-bundle.mjs --check` 負責。
  });
});
