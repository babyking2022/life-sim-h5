/**
 * GPT-WORKBUDDY-0058-B｜任務二第 6 項：遊戲專用程式的延遲 chunk 邊界。
 *
 * 出生卡只用得到 application 的 birth stage API 與 `p3e-birth-packs.ts`；
 * 場景（0062-B 起為完整 Open Peeps 全身人物，含 `p3e-open-peeps.ts`）、
 * 職業目錄、CNY 顯示、view readers、國家名表、自然音檔 URL 全部集中在這裡，
 * 由 `ensureGameLayer()` 動態 import。
 * Vite build 後這些內容會落在獨立的 chunk，不進首屏關鍵路徑。
 */
export * from "./p3e-view-readers.js";
export * from "./p3e-country-hant.js";
export * from "./p3e-cny.js";
export * from "./p3e-scene.js";
export * from "./p3e-career-view.js";

/** `preload="none"`；只有進入遊戲的使用者手勢後才會真正請求這個本機音檔。 */
export const NATURE_SOUND_URL: string = new URL(
  "../../../assets/audio/birds.mp3",
  import.meta.url
).href;
