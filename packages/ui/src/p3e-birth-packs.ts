/**
 * GPT-WORKBUDDY-0058-B｜第一階段：出生卡真正需要的 base＋identity。
 *
 * 這裡**故意不含** `mortality.v1.json`、`events.v1.json`、`birds.mp3`：
 * 那些資源的路徑放在延遲 chunk `p3e-heavy-packs.ts`／`p3e-game-layer.ts`，
 * 出生卡的關鍵路徑（HTML → bootstrap → p3e-real-main → 本模組）不會引用它們。
 */
import { loadJsonCached } from "./p3e-fetch-cache.js";

export const BIRTH_PACK_KEYS = [
  "p2aManifest",
  "p2aCountryRegistry",
  "p2aIndicators",
  "p2aBirthWeights",
  "p2aSensitiveNames",
  "p2aLicenses",
  "p2aLineage",
  "p2bManifest",
  "p2bCountryVitals",
  "p2bHouseholdProfiles",
  "p2bNameCorpus",
  "p2bStoryTemplates",
  "p2bLicenses",
  "p2bLineage"
] as const;

export type BirthPackKey = (typeof BIRTH_PACK_KEYS)[number];

const BIRTH_PACK_URLS: Readonly<Record<BirthPackKey, string>> = Object.freeze({
  p2aManifest: new URL("../../../fixtures/p2a/manifest.v1.json", import.meta.url).href,
  p2aCountryRegistry: new URL("../../../fixtures/p2a/country-registry.v1.json", import.meta.url).href,
  p2aIndicators: new URL("../../../fixtures/p2a/indicators.v1.json", import.meta.url).href,
  p2aBirthWeights: new URL("../../../fixtures/p2a/birth-weights.v1.json", import.meta.url).href,
  p2aSensitiveNames: new URL("../../../fixtures/p2a/sensitive-names.v1.json", import.meta.url).href,
  p2aLicenses: new URL("../../../fixtures/p2a/licenses.v1.json", import.meta.url).href,
  p2aLineage: new URL("../../../fixtures/p2a/lineage.v1.json", import.meta.url).href,
  p2bManifest: new URL("../../../fixtures/p2b/manifest.v1.json", import.meta.url).href,
  p2bCountryVitals: new URL("../../../fixtures/p2b/country-vitals.v1.json", import.meta.url).href,
  p2bHouseholdProfiles: new URL("../../../fixtures/p2b/household-profiles.v1.json", import.meta.url).href,
  p2bNameCorpus: new URL("../../../fixtures/p2b/name-corpus.v1.json", import.meta.url).href,
  p2bStoryTemplates: new URL("../../../fixtures/p2b/story-templates.v1.json", import.meta.url).href,
  p2bLicenses: new URL("../../../fixtures/p2b/licenses.v1.json", import.meta.url).href,
  p2bLineage: new URL("../../../fixtures/p2b/lineage.v1.json", import.meta.url).href
});

export type BirthPackData = Readonly<Record<BirthPackKey, unknown>>;

/** 只抓 14 個小型 JSON；所有請求都走 promise 快取，重繪不會重抓。 */
export async function loadBirthPacks(): Promise<BirthPackData> {
  const loaded = await Promise.all(BIRTH_PACK_KEYS.map((key) => loadJsonCached(BIRTH_PACK_URLS[key])));
  const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  BIRTH_PACK_KEYS.forEach((key, index) => {
    data[key] = loaded[index];
  });
  return Object.freeze(data) as BirthPackData;
}

/** 交給 application `prepareP3EBrowserBirthStage` 的精確兩欄輸入。 */
export function buildBirthStageInput(data: BirthPackData): { base: unknown; identity: unknown } {
  return {
    base: {
      manifest: data.p2aManifest,
      datasets: {
        "country-registry": data.p2aCountryRegistry,
        indicators: data.p2aIndicators,
        "birth-weights": data.p2aBirthWeights,
        "sensitive-names": data.p2aSensitiveNames,
        licenses: data.p2aLicenses,
        lineage: data.p2aLineage
      }
    },
    identity: {
      manifest: data.p2bManifest,
      datasets: {
        "country-vitals": data.p2bCountryVitals,
        "household-profiles": data.p2bHouseholdProfiles,
        "name-corpus": data.p2bNameCorpus,
        "story-templates": data.p2bStoryTemplates,
        licenses: data.p2bLicenses,
        lineage: data.p2bLineage
      }
    }
  };
}

/** 出生卡階段就能取得國家註冊表（不必等 mortality）。 */
export function birthCountryRecords(data: BirthPackData): readonly unknown[] {
  const raw = data.p2aCountryRegistry;
  return typeof raw === "object" && raw !== null && Array.isArray((raw as { records?: unknown }).records)
    ? ((raw as { records: unknown[] }).records)
    : [];
}
