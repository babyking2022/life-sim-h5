/**
 * GPT-WORKBUDDY-0065-A｜事件文案字典驗證與世界錯誤文案（共用小模組）。
 *
 * `p3e-world-runtime.ts`（延遲 chunk）與 `p3e-game-main.ts`（game chunk）
 * 都要用同一份驗證與同一組可理解錯誤訊息，避免兩邊漂移；這個模組本身
 * 不含任何 pack URL／大型資料，不會把重型資產拉進出生關鍵路徑。
 */
import { describeError, isPlainRecord } from "./p3e-common.js";

export const COPY_SCHEMA_VERSION = "p3b-copy-1";
export const COPY_LOCALE = "zh-Hant";
/** 字典 key 的安全下限：77 個事件 + 58 個問題 + 172 個選項。 */
export const COPY_MIN_KEYS = 307;
/** 會透過原型鏈污染查表的危險鍵（JSON.parse 仍可能帶進來）。 */
export const DANGEROUS_COPY_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 使用字典前的最小驗證（GPT-0025-D 第 2 項）。 */
export function validateEventCopy(raw: unknown, expectedPackVersion: string): Record<string, string> {
  if (!isPlainRecord(raw)) {
    throw new Error("E_P3E_COPY_DOCUMENT：事件文案檔格式錯誤，請重新整理頁面。");
  }
  if (raw["schemaVersion"] !== COPY_SCHEMA_VERSION) {
    throw new Error("E_P3E_COPY_SCHEMA：事件文案版本不相容，請重新整理頁面。");
  }
  if (raw["locale"] !== COPY_LOCALE) {
    throw new Error("E_P3E_COPY_LOCALE：事件文案語系不符，請重新整理頁面。");
  }
  if (raw["contentPackVersion"] !== expectedPackVersion) {
    throw new Error("E_P3E_COPY_PACK：事件文案與事件包版本不符，請重新整理頁面。");
  }
  const table: unknown = raw["copy"];
  if (!isPlainRecord(table)) {
    throw new Error("E_P3E_COPY_TABLE：事件文案表格式錯誤，請重新整理頁面。");
  }
  // null-prototype：查表時 `copy["__proto__"]` 不會命中 Object.prototype。
  const validated: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(table)) {
    if (
      DANGEROUS_COPY_KEYS.has(key) ||
      key.length === 0 ||
      key !== key.trim() ||
      typeof value !== "string" ||
      value.trim().length === 0
    ) {
      throw new Error("E_P3E_COPY_ENTRY：事件文案含無效欄位，請重新整理頁面。");
    }
    validated[key] = value;
  }
  if (Object.keys(validated).length < COPY_MIN_KEYS) {
    throw new Error("E_P3E_COPY_INCOMPLETE：事件文案不完整，請重新整理頁面。");
  }
  return validated;
}

/** 把技術錯誤轉成玩家看得懂的一句話，不印出 internal key／HTTP 代碼。 */
export function friendlyWorldError(error: unknown): string {
  const raw = describeError(error);
  if (raw.startsWith("fixture fetch failed") || raw.includes("Failed to fetch")) {
    return "人生資料下載失敗，請檢查網路後重試。";
  }
  if (raw.includes("E_P3E_COPY_PACK") || raw.includes("p3b-copy")) {
    return "事件文案資料不完整，請重新載入一次。";
  }
  return "人生資料還沒準備好，請稍後重試。";
}

export function isCopyBootError(error: unknown): boolean {
  return error instanceof Error && error.name === "CopyBootError";
}

/** 固定口語中文，不把底層錯誤碼／HTTP 狀態／internal key 帶到畫面。 */
export function markCopyBootError(): Error {
  const wrapped = new Error("E_P3E_COPY_PACK：事件文案資料載入或驗證未通過，請重新整理頁面再試一次。");
  wrapped.name = "CopyBootError";
  return wrapped;
}
