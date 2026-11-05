/**
 * H5-CTO-184-A：P3-E Save Envelope V6（正式主線整合；不進公開 barrel）。
 *
 * 來源：WorkBuddy 候選 `p3e-save-envelope-v6-candidate.ts`
 * （H5-CTO-182-B／-R1；SHA-256 `203742ab3d8945c5a2e0f95d350d888076383a1515023401a3614a8ab7cde389`，
 * 經 H5-CTO-184-A 正式整合；R1 的 descriptor.value-only 邊界完整保留）。
 *
 * 儲存層只負責**搬運** P3-E session payload：信封是固定的四欄 canonical
 * JSON（`magic` → `saveFormatVersion` → `payloadFormat` → `payload`），
 * payload 是**不透明**的 canonical session payload 字串——本檔**不解析、
 * 不信任、不驗證** payload 內容；應用層必須自行 decode payload 並重放
 * ledger 後才能接受 state。
 *
 * ## reuse（不重製）
 * - `MAX_EXPANDED_BYTES`／`MAX_COMPRESSED_BYTES`／`SaveError`／`failSave`
 *   來自 `./errors`；
 * - `inflateBounded` 來自 `./envelope`（串流式有界 inflate：展開上限、
 *   損壞、串接／尾端 gzip 成員都在那裡攔截）；
 * - gzip 壓縮用 `pako` 的 `gzip`（預設 header 寫死 mtime=0、固定 OS
 *   byte → 相同輸入 byte-identical）。
 *
 * ## 邊界
 * - 錯誤碼只有三種：形狀／JSON／UTF-8／gzip／magic／payloadFormat 錯誤是
 *   `E_SAVE_INVALID`；`saveFormatVersion` 不是 6 是
 *   `E_SAVE_UNSUPPORTED_VERSION`；任何大小上限是 `E_SAVE_TOO_LARGE`。
 *   原生錯誤（SyntaxError／TypeError／URIError…）一律折成 SaveError，
 *   決不外洩。
 * - 大小檢查在 parse／inflate 之前盡可能先做：gzip 輸入先查壓縮長度與
 *   ISIZE，raw 輸入先查 byte 長度，payload 在驗證時查 UTF-8 byte 長度。
 * - 物件輸入必須是「exact own enumerable data fields」：own 屬性名恰等於
 *   期望鍵集、無 symbol 鍵、descriptor 必須是可列舉 data descriptor
 *   （accessor 直接拒絕、getter 永不執行）、prototype 是
 *   `Object.prototype` 或 `null`。
 * - decode 輸出深層凍結、與輸入零共享參考；不修改任何輸入。
 * - 本檔不 import `@life-sim/simulation` 或任何 simulation 路徑——儲存層
 *   與模擬層完全隔離（integration rule）。
 */
import { gzip } from "pako";
import { MAX_COMPRESSED_BYTES, MAX_EXPANDED_BYTES, SaveError, failSave } from "./errors";
import { inflateBounded } from "./envelope";

/* ------------------------------ 常數 ------------------------------ */

/** 信封 magic（與 legacy format 3 相同，版本欄位才是分歧點）。 */
export const P3E_SAVE_V6_MAGIC = "LIFE1";

/** 信封格式版本。 */
export const P3E_SAVE_V6_FORMAT_VERSION = 6 as const;

/** payload 格式標籤（對應 P3-E session payload codec v1 的 wire）。 */
export const P3E_SAVE_V6_PAYLOAD_FORMAT = "p3e-session-payload-1";

/** payload 的 UTF-8 byte 上限（= session payload 的 16 MiB 上限）。 */
export const P3E_SAVE_V6_PAYLOAD_MAX_BYTES = 16_777_216;

/** canonical 信封的四個欄位（固定順序）。 */
const ENVELOPE_KEYS = ["magic", "saveFormatVersion", "payloadFormat", "payload"] as const;

/** 信封形狀。 */
export interface P3ESaveEnvelopeV6 {
  readonly magic: typeof P3E_SAVE_V6_MAGIC;
  readonly saveFormatVersion: typeof P3E_SAVE_V6_FORMAT_VERSION;
  readonly payloadFormat: typeof P3E_SAVE_V6_PAYLOAD_FORMAT;
  readonly payload: string;
}

/* ------------------------------ 輔助 ------------------------------ */

function toUtf8Bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

/** strict fatal UTF-8 decode：任何不合法 byte 序列折成 E_SAVE_INVALID。 */
function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failSave("E_SAVE_INVALID", "malformed UTF-8");
  }
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** gzip 尾端的 ISIZE（實際長度 mod 2^32，little-endian）。 */
function gzipISize(bytes: Uint8Array): number {
  if (bytes.length < 4) failSave("E_SAVE_INVALID", "truncated gzip");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, true);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) deepFreeze(record[key]);
  }
  return value;
}

/**
 * exact own enumerable data fields：own 屬性名恰等於期望鍵集、無 symbol、
 * 全部是可列舉 data descriptor（accessor 拒絕且 getter 永不執行）、
 * prototype 是 `Object.prototype` 或 `null`。回傳「欄位 → 值」映射。
 *
 * Proxy 邊界（H5-CTO-182-B-R1 修正；H5-CTO-184-A 正式整合保留）：**所有**反射操作（Reflect.ownKeys、
 * getPrototypeOf、getOwnPropertyDescriptor）都在單一 try/catch 邊界內，
 * 值**只**從 `descriptor.value` 取得——絕不透過屬性存取（`record[name]`）、
 * `Reflect.get` 或任何會觸發 get trap 的路徑讀值。任何 proxy trap 或反射
 * 失敗（例如 revoked Proxy、ownKeys/getPrototypeOf/getOwnPropertyDescriptor
 * trap 拋錯）折成 E_SAVE_INVALID，原生錯誤決不外洩。
 */
function readExactOwnDataFields(input: unknown, expected: readonly string[]): Map<string, unknown> {
  let fields: Map<string, unknown>;
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      failSave("E_SAVE_INVALID", "envelope input must be an object");
    }
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key === "symbol")) {
      failSave("E_SAVE_INVALID", "symbol-keyed fields are not allowed");
    }
    const names = keys.filter((key): key is string => typeof key === "string");
    const expectedSet = new Set(expected);
    if (names.length !== expectedSet.size || names.some((name) => !expectedSet.has(name))) {
      failSave("E_SAVE_INVALID", "envelope input must have exactly the fields " + expected.join(", "));
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      failSave("E_SAVE_INVALID", "exotic prototype is not allowed");
    }
    fields = new Map<string, unknown>();
    const objectInput = input as object;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(objectInput, name);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        typeof descriptor.get === "function" ||
        typeof descriptor.set === "function"
      ) {
        failSave("E_SAVE_INVALID", `${name} must be an own enumerable data field`);
      }
      // 值只取自 descriptor.value——永不執行 getter / get trap。
      fields.set(name, descriptor.value);
    }
  } catch (error) {
    if (error instanceof SaveError) throw error;
    failSave("E_SAVE_INVALID", "envelope input is not inspectable");
  }
  return fields;
}

function failInvalid(message: string): never {
  failSave("E_SAVE_INVALID", message);
}

/** payload 必須是字串且 UTF-8 byte 長度不超過上限（不透明、不解析）。 */
function readPayload(value: unknown): string {
  if (typeof value !== "string") failInvalid("payload must be a string");
  if (toUtf8Bytes(value).length > P3E_SAVE_V6_PAYLOAD_MAX_BYTES) {
    failSave("E_SAVE_TOO_LARGE", "payload exceeds 16 MiB");
  }
  return value;
}

/** 以固定欄位順序組出深層凍結的信封（新物件、與輸入零共享）。 */
function buildEnvelope(payload: string): P3ESaveEnvelopeV6 {
  return deepFreeze({
    magic: P3E_SAVE_V6_MAGIC,
    saveFormatVersion: P3E_SAVE_V6_FORMAT_VERSION,
    payloadFormat: P3E_SAVE_V6_PAYLOAD_FORMAT,
    payload
  });
}

/* ------------------------------ API ------------------------------ */

/**
 * 由不透明 payload 字串建立 canonical v6 信封。輸入必須是 exact own
 * enumerable data fields 且**恰好只有 `payload`** 一欄。
 */
export function createP3ESaveEnvelopeV6(input: unknown): P3ESaveEnvelopeV6 {
  const fields = readExactOwnDataFields(input, ["payload"]);
  return buildEnvelope(readPayload(fields.get("payload")));
}

/**
 * 驗證任意值是否為合法的 v6 信封：exact 四欄、magic／payloadFormat 相符、
 * `saveFormatVersion` 必須是 6（否則 E_SAVE_UNSUPPORTED_VERSION）、payload
 * 是字串且不超過 UTF-8 byte 上限。回傳固定欄位順序的新凍結物件。
 */
export function validateP3ESaveEnvelopeV6(input: unknown): P3ESaveEnvelopeV6 {
  const fields = readExactOwnDataFields(input, ENVELOPE_KEYS);
  if (fields.get("magic") !== P3E_SAVE_V6_MAGIC) failInvalid("magic must be LIFE1");
  if (fields.get("saveFormatVersion") !== P3E_SAVE_V6_FORMAT_VERSION) {
    failSave("E_SAVE_UNSUPPORTED_VERSION", "saveFormatVersion must be 6");
  }
  if (fields.get("payloadFormat") !== P3E_SAVE_V6_PAYLOAD_FORMAT) {
    failInvalid("payloadFormat must be p3e-session-payload-1");
  }
  return buildEnvelope(readPayload(fields.get("payload")));
}

/**
 * canonical raw JSON：欄位順序固定（magic → saveFormatVersion →
 * payloadFormat → payload）、無空白；byte 長度不超過 raw 上限（20 MiB）。
 */
export function encodeP3ESaveEnvelopeV6(input: unknown): string {
  const envelope = validateP3ESaveEnvelopeV6(input);
  const raw = JSON.stringify(envelope);
  if (toUtf8Bytes(raw).length > MAX_EXPANDED_BYTES) {
    failSave("E_SAVE_TOO_LARGE", "raw save exceeds 20 MiB");
  }
  return raw;
}

/**
 * deterministic gzip：相同輸入永遠得到相同 byte（pako 預設 header 寫死
 * mtime=0 與固定 OS byte）；壓縮結果不超過 compressed 上限（5 MiB）。
 */
export function encodeP3ESaveEnvelopeV6Compressed(input: unknown): Uint8Array {
  const raw = encodeP3ESaveEnvelopeV6(input);
  const compressed = gzip(raw);
  if (compressed.length > MAX_COMPRESSED_BYTES) {
    failSave("E_SAVE_TOO_LARGE", "compressed save exceeds 5 MiB");
  }
  return compressed;
}

/**
 * 解碼 raw JSON 字串／bytes 或 gzip bytes 成深層凍結的 v6 信封。
 *
 * 大小檢查在 parse／inflate 之前先做；gzip 走串流式有界 inflate
 * （展開上限、損壞、串接／尾端成員由 `inflateBounded` 攔截）並核對
 * ISIZE 與實際展開長度；UTF-8 decode 是 strict fatal；JSON.parse 失敗
 * 折成 E_SAVE_INVALID。payload 保持不透明——本函式**不**解析 payload。
 */
export function decodeP3ESaveEnvelopeV6(input: unknown): P3ESaveEnvelopeV6 {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = toUtf8Bytes(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    failInvalid("save input must be a string or Uint8Array");
  }
  let text: string;
  if (isGzip(bytes)) {
    if (bytes.length > MAX_COMPRESSED_BYTES) {
      failSave("E_SAVE_TOO_LARGE", "compressed input exceeds 5 MiB");
    }
    const declared = gzipISize(bytes);
    if (declared > MAX_EXPANDED_BYTES) {
      failSave("E_SAVE_TOO_LARGE", "expanded save exceeds 20 MiB");
    }
    const expanded = inflateBounded(bytes);
    if (expanded.length !== declared) failInvalid("bad ISIZE");
    text = decodeUtf8Strict(expanded);
  } else {
    if (bytes.length > MAX_EXPANDED_BYTES) {
      failSave("E_SAVE_TOO_LARGE", "raw input exceeds 20 MiB");
    }
    text = decodeUtf8Strict(bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    failInvalid("invalid JSON");
  }
  return validateP3ESaveEnvelopeV6(parsed);
}
