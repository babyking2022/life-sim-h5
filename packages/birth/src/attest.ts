import type { ValidatedIdentityPack } from "./identity/validate";
import type { ValidatedDataPack } from "./validate";

/**
 * GPT-WORKBUDDY-0065-A｜出生 pack 的「已驗證」品牌與 build-time 信任轉移。
 *
 * 原本 `validate.ts`／`identity/validate.ts` 各自持有 WeakSet，讓
 * `drawBirth`／`buildBirthIdentity`／`buildPeerGroup`／`createBirthCertificate`
 * 只接受**正式 validators 產生**的 pack。0065-A 的 CTO 架構把「靜態資料
 * 驗證」移到 build 期，出生頁執行期只做 JSON 解析＋版本／欄位／內容雜湊
 * 檢查，因此這裡把兩個 WeakSet 集中到一個**極小、無 validator 依賴**的模組：
 *
 * - `isValidatedDataPack`／`isValidatedIdentityPack`：行為與原本完全相同；
 * - `attestBuildTimeBirthPacks`：只供 `@life-sim/application/birth-lite` 在
 *   **內容雜湊驗證通過後**呼叫，把 build 期已由正式 validators 正規化的
 *   bundle 資料標記為已驗證，讓同一份出生核心可以接受它。
 *
 * ## 信任邊界（重要）
 *
 * 1. 完整世界（`prepareP3EBrowserWorld`／`prepareP3EBrowserBirthStage`／
 *    `completeP3EBrowserWorld`）**永不**呼叫 attest；正式 session、
 *    save/load/replay 依舊只用正式 validators 產生的 pack。
 * 2. attest 不改變任何資料、不重算 checksum、不抽隨機值；它只把同一份
 *    已正規化物件放進 WeakSet。
 * 3. 這個函式是公開的，因此呼叫端必須先驗證 bundle 版本與內容雜湊；
 *    `birth-lite` 就是唯一正式呼叫點。
 */

const validatedDataPacks = new WeakSet<object>();
const validatedIdentityPacks = new WeakSet<object>();

export function isValidatedDataPack(value: unknown): value is ValidatedDataPack {
  return typeof value === "object" && value !== null && validatedDataPacks.has(value);
}

export function isValidatedIdentityPack(value: unknown): value is ValidatedIdentityPack {
  return typeof value === "object" && value !== null && validatedIdentityPacks.has(value);
}

/** 正式 validators 產生 pack 後呼叫（品牌來源不變，只是搬到共用模組）。 */
export function markValidatedDataPack(value: ValidatedDataPack): void {
  validatedDataPacks.add(value);
}

/** 正式 validators 產生 pack 後呼叫（品牌來源不變，只是搬到共用模組）。 */
export function markValidatedIdentityPack(value: ValidatedIdentityPack): void {
  validatedIdentityPacks.add(value);
}

/**
 * build 期已驗證 bundle 的信任轉移。**只在 `birth-lite` 通過內容雜湊後呼叫**。
 * 兩個 pack 會被深層凍結，避免執行期被改動後仍帶著品牌。
 */
export function attestBuildTimeBirthPacks(base: ValidatedDataPack, identity: ValidatedIdentityPack): void {
  deepFreezeBirthBundle(base);
  deepFreezeBirthBundle(identity);
  validatedDataPacks.add(base);
  validatedIdentityPacks.add(identity);
}

function deepFreezeBirthBundle(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreezeBirthBundle((value as Record<string, unknown>)[key]);
  }
}
