/**
 * P3-E 瀏覽器自動存檔 store V1（H5-CTO-185-A 正式主線整合；不進公開 barrel）。
 *
 * 來源：WorkBuddy 候選 `p3e-browser-autosave-store-v1-candidate.ts`（H5-CTO-184-B；
 * SHA-256 `79c51683d7ecf0cf1fe7b11def260055a34bb7cfe9f94aa559704e70c26eddd7`，
 * 經 H5-CTO-185-A 正式整合；零 import、注入式 storage 能力完整保留）。
 *
 * 職責：把「不透明的 V6 raw envelope 字串」放進瀏覽器 localStorage 類能力。
 * save layer 的邊界原則延續——本模組只搬運字串：不解析 payload、不驗證、
 * 不壓縮、不解碼、不重放（這些是 save v6 封裝與 application 重放層的職責）。
 *
 * 儲存能力（storage capability）完全由呼叫端注入——本模組**從不**觸碰
 * window / document / globalThis.localStorage / indexedDB；UI 層之後注入
 * `window.localStorage`。任何物件只要同時提供 callable 的
 * getItem / setItem / removeItem 即可（測試用 in-memory fake、SSR、
 * 未來的封裝層都適用）。
 *
 * 輸入是 exact own enumerable data fields 的普通物件：
 * - write: `{ storage, value }`
 * - read / clear: `{ storage }`
 * 欄位集合必須精確（缺、多、改名、symbol、accessor、exotic prototype、
 * 反射失敗一律拒絕）；accessor 的 getter 永不執行（值只從 descriptor.value
 * 取得）；所有對 storage 能力的屬性存取與方法呼叫都在 try/catch 邊界內——
 * DOMException、TypeError、proxy trap 錯誤永不外洩，一律折成
 * P3EBrowserAutosaveStoreError。
 *
 * 錯誤碼（全部是本模組自己的分類，無原生錯誤碼洩漏）：
 * - E_P3E_STORE_ARGUMENT    輸入形狀不合法、value 非字串或空字串
 * - E_P3E_STORE_UNAVAILABLE storage 缺少 callable 方法、屬性存取或方法
 *                           呼叫拋出非 quota 例外（含 SecurityError）
 * - E_P3E_STORE_QUOTA       setItem / removeItem 拋出 quota 類例外
 *                           （name 含 "Quota"，如 QuotaExceededError）
 * - E_P3E_STORE_TOO_LARGE   value 的 UTF-8 位元組超過 1 MiB（setItem 前拒絕）
 * - E_P3E_STORE_CORRUPT     讀到的值非字串、空字串或超過 1 MiB
 *
 * 純度：不讀時間、不用隨機、不碰 crypto／網路；不含任何 simulation
 * 業務；不鎖跨分頁、不記 revision；零 import。
 */

export const P3E_BROWSER_AUTOSAVE_KEY = "life-sim:p3e:v6:autosave";
export const P3E_BROWSER_AUTOSAVE_MAX_BYTES = 1_048_576;

export type P3EBrowserAutosaveStoreErrorCode =
  | "E_P3E_STORE_ARGUMENT"
  | "E_P3E_STORE_UNAVAILABLE"
  | "E_P3E_STORE_QUOTA"
  | "E_P3E_STORE_TOO_LARGE"
  | "E_P3E_STORE_CORRUPT";

/**
 * 最小儲存能力介面（結構型別）。真實的 `window.localStorage` 滿足此
 * 形狀；測試與替代環境可注入任意實作。方法以 `storage.<method>(...)`
 * 形式呼叫，保留原始 receiver。
 */
export type P3EBrowserStorageLike = {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
};

export class P3EBrowserAutosaveStoreError extends Error {
  readonly code: P3EBrowserAutosaveStoreErrorCode;

  constructor(code: P3EBrowserAutosaveStoreErrorCode, message: string) {
    super(message);
    this.name = "P3EBrowserAutosaveStoreError";
    this.code = code;
  }
}

function failStore(code: P3EBrowserAutosaveStoreErrorCode, message: string): never {
  throw new P3EBrowserAutosaveStoreError(code, message);
}

/**
 * 把 storage 方法呼叫拋出的任何原生例外折成分類錯誤。
 * 只讀 `error.name` 判別 quota（連讀 name 也包在 try 內——拋錯物件
 * 本身可能不合作）；訊息固定通用，不帶原生錯誤內容。
 */
function classifyStorageFailure(error: unknown, operation: string): never {
  let quota = false;
  try {
    if (typeof error === "object" && error !== null) {
      const name = (error as { name?: unknown }).name;
      if (typeof name === "string" && name.toLowerCase().includes("quota")) quota = true;
    }
  } catch {
    quota = false;
  }
  if (quota) failStore("E_P3E_STORE_QUOTA", `storage ${operation} failed: quota exceeded`);
  failStore("E_P3E_STORE_UNAVAILABLE", `storage ${operation} failed`);
}

/**
 * 在受保護的邊界內執行一次 storage 方法呼叫；任何拋出折成分類錯誤。
 */
function callStorage<T>(storage: unknown, operation: string, run: (capability: P3EBrowserStorageLike) => T): T {
  try {
    return run(storage as P3EBrowserStorageLike);
  } catch (error) {
    classifyStorageFailure(error, operation);
  }
}

/**
 * 驗證 storage 能力：必須是物件（或函式）且同時提供 callable 的
 * getItem / setItem / removeItem。屬性存取也在 try 內——惡意 proxy
 * 的 get trap 拋錯折成 E_P3E_STORE_UNAVAILABLE，不外洩。
 * 只檢查能力，不檢查 own fields——真實 localStorage 的方法在
 * prototype 上（accessor／exotic object），exact-own-fields 檢查
 * 只適用於本模組的頂層輸入物件。
 */
function requireStorageCapability(storage: unknown): void {
  let capable = false;
  try {
    if ((typeof storage === "object" && storage !== null) || typeof storage === "function") {
      const record = storage as Record<string, unknown>;
      capable =
        typeof record["getItem"] === "function" &&
        typeof record["setItem"] === "function" &&
        typeof record["removeItem"] === "function";
    }
  } catch {
    capable = false;
  }
  if (!capable) {
    failStore("E_P3E_STORE_UNAVAILABLE", "storage must supply callable getItem, setItem and removeItem");
  }
}

/**
 * exact own enumerable data fields：own 屬性名恰等於期望鍵集、無
 * symbol、全部是可列舉 data descriptor（accessor 拒絕且 getter 永不
 * 執行——值只從 descriptor.value 取得）、prototype 是
 * `Object.prototype` 或 `null`。任何反射失敗（例如 revoked Proxy）
 * 折成 E_P3E_STORE_ARGUMENT。
 */
function readExactInputFields(input: unknown, expected: readonly string[]): Map<string, unknown> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      failStore("E_P3E_STORE_ARGUMENT", "input must be an object");
    }
    const names = Object.getOwnPropertyNames(input);
    if (Object.getOwnPropertySymbols(input).length > 0) {
      failStore("E_P3E_STORE_ARGUMENT", "symbol-keyed fields are not allowed");
    }
    const expectedSet = new Set(expected);
    if (names.length !== expectedSet.size || names.some((name) => !expectedSet.has(name))) {
      failStore("E_P3E_STORE_ARGUMENT", "input must have exactly the fields " + expected.join(", "));
    }
    const fields = new Map<string, unknown>();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const name of names) {
      const descriptor = descriptors[name];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        typeof descriptor.get === "function" ||
        typeof descriptor.set === "function"
      ) {
        failStore("E_P3E_STORE_ARGUMENT", `${name} must be an own enumerable data field`);
      }
      fields.set(name, descriptor.value);
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      failStore("E_P3E_STORE_ARGUMENT", "exotic prototype is not allowed");
    }
    return fields;
  } catch (error) {
    if (error instanceof P3EBrowserAutosaveStoreError) throw error;
    failStore("E_P3E_STORE_ARGUMENT", "input is not inspectable");
  }
}

/**
 * write 的 value：必須是非空字串，UTF-8 位元組 ≤ 1 MiB。
 * 非字串／空字串 → E_P3E_STORE_ARGUMENT；超過上限 →
 * E_P3E_STORE_TOO_LARGE（在 setItem 之前拒絕）。
 */
function validatedAutosaveValue(value: unknown): string {
  if (typeof value !== "string") {
    failStore("E_P3E_STORE_ARGUMENT", "value must be a string");
  }
  if (value.length === 0) {
    failStore("E_P3E_STORE_ARGUMENT", "value must be a non-empty string");
  }
  if (new TextEncoder().encode(value).length > P3E_BROWSER_AUTOSAVE_MAX_BYTES) {
    failStore("E_P3E_STORE_TOO_LARGE", "value exceeds 1 MiB");
  }
  return value;
}

/**
 * 寫入：一次 `setItem(P3E_BROWSER_AUTOSAVE_KEY, value)`，值逐位元組
 * 原樣儲存（opaque raw V6 envelope 字串）。不修改任何輸入。
 */
export function writeP3EBrowserAutosave(input: unknown): void {
  const fields = readExactInputFields(input, ["storage", "value"]);
  const value = validatedAutosaveValue(fields.get("value"));
  const storage = fields.get("storage");
  requireStorageCapability(storage);
  callStorage(storage, "setItem", (capability) => capability.setItem(P3E_BROWSER_AUTOSAVE_KEY, value));
}

/**
 * 讀取：`getItem(P3E_BROWSER_AUTOSAVE_KEY)`。
 * - 缺失（null）→ `null`
 * - 非字串、空字串、UTF-8 超 1 MiB → E_P3E_STORE_CORRUPT
 * （寫入路徑永不產生這些值；出現即視為儲存層被外部改動）
 * - 其餘 → 原樣字串（opaque，呼叫端自行交給 V6 decoder）
 */
export function readP3EBrowserAutosave(input: unknown): string | null {
  const fields = readExactInputFields(input, ["storage"]);
  const storage = fields.get("storage");
  requireStorageCapability(storage);
  const raw = callStorage(storage, "getItem", (capability) => capability.getItem(P3E_BROWSER_AUTOSAVE_KEY));
  if (raw === null) return null;
  if (typeof raw !== "string") {
    failStore("E_P3E_STORE_CORRUPT", "stored autosave value is not a string");
  }
  if (raw.length === 0) {
    failStore("E_P3E_STORE_CORRUPT", "stored autosave value is empty");
  }
  if (new TextEncoder().encode(raw).length > P3E_BROWSER_AUTOSAVE_MAX_BYTES) {
    failStore("E_P3E_STORE_CORRUPT", "stored autosave value exceeds 1 MiB");
  }
  return raw;
}

/**
 * 清除：一次 `removeItem(P3E_BROWSER_AUTOSAVE_KEY)`，鍵不存在時
 * 同樣成功（冪等）。quota／其他例外折類如 write。
 */
export function clearP3EBrowserAutosave(input: unknown): void {
  const fields = readExactInputFields(input, ["storage"]);
  const storage = fields.get("storage");
  requireStorageCapability(storage);
  callStorage(storage, "removeItem", (capability) => capability.removeItem(P3E_BROWSER_AUTOSAVE_KEY));
}
