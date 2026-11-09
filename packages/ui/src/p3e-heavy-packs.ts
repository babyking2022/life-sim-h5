/**
 * GPT-WORKBUDDY-0058-B｜第二階段（**延遲 chunk**）：events＋death＋文案字典。
 *
 * 本模組只會被 `await import("./p3e-heavy-packs.js")` 載入，因此
 * `mortality.v1.json` 的 URL 不會出現在出生卡的關鍵路徑 JS 裡。
 * 所有請求仍走 `loadJsonCached`，與第一階段共用同一份去重快取。
 */
import { loadJsonCached } from "./p3e-fetch-cache.js";

export const HEAVY_PACK_KEYS = [
  "p3bManifest",
  "p3bEvents",
  "p3bEventCopy",
  "p3dManifest",
  "p3dCauseRegistry",
  "p3dCauseWeights",
  "p3dMortality",
  "p3dLicenses",
  "p3dLineage"
] as const;

export type HeavyPackKey = (typeof HEAVY_PACK_KEYS)[number];

const HEAVY_PACK_URLS: Readonly<Record<HeavyPackKey, string>> = Object.freeze({
  p3bManifest: new URL("../../../fixtures/p3b/manifest.v1.json", import.meta.url).href,
  p3bEvents: new URL("../../../fixtures/p3b/events.v1.json", import.meta.url).href,
  // GPT-0025-D：顯示層繁中字典維持獨立 JSON 資產，不靜態 import 進主 JS。
  p3bEventCopy: new URL("../../../fixtures/p3b/event-copy.zh-Hant.v1.json", import.meta.url).href,
  p3dManifest: new URL("../../../fixtures/p3d/manifest.v1.json", import.meta.url).href,
  p3dCauseRegistry: new URL("../../../fixtures/p3d/cause-registry.v1.json", import.meta.url).href,
  p3dCauseWeights: new URL("../../../fixtures/p3d/cause-weights.v1.json", import.meta.url).href,
  p3dMortality: new URL("../../../fixtures/p3d/mortality.v1.json", import.meta.url).href,
  p3dLicenses: new URL("../../../fixtures/p3d/licenses.v1.json", import.meta.url).href,
  p3dLineage: new URL("../../../fixtures/p3d/lineage.v1.json", import.meta.url).href
});

export type HeavyPackData = Readonly<Record<HeavyPackKey, unknown>>;

export async function loadHeavyPacks(): Promise<HeavyPackData> {
  const loaded = await Promise.all(
    HEAVY_PACK_KEYS.map((key) => {
      const pending = loadJsonCached(HEAVY_PACK_URLS[key]);
      if (key !== "p3bEventCopy") return pending;
      // 文案字典失敗是不可降級的啟動錯誤（既有 GPT-0025-D 行為）：
      // 標上名字，讓 UI 顯示既有「啟動失敗」頁並附上重試按鈕。
      return pending.catch((error: unknown) => {
        const wrapped = new Error(error instanceof Error ? error.message : String(error));
        wrapped.name = "CopyBootError";
        throw wrapped;
      });
    })
  );
  const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  HEAVY_PACK_KEYS.forEach((key, index) => {
    data[key] = loaded[index];
  });
  return Object.freeze(data) as HeavyPackData;
}

/** 交給 application `completeP3EBrowserWorld` 的 events／death 兩欄。 */
export function buildCompleteWorldPacks(data: HeavyPackData): { events: unknown; death: unknown } {
  const events = data.p3bEvents as { records?: unknown[] } | null;
  return {
    events: { manifest: data.p3bManifest, events: events?.records ?? [] },
    death: {
      manifest: data.p3dManifest,
      datasets: {
        "cause-registry": data.p3dCauseRegistry,
        "cause-weights": data.p3dCauseWeights,
        mortality: data.p3dMortality,
        licenses: data.p3dLicenses,
        lineage: data.p3dLineage
      }
    }
  };
}
