import { fail } from "./errors";

/**
 * P3-D 的嚴格讀取器（`E_P3D_*`）。
 *
 * 與 P2-A 的 `packages/birth/src/schema.ts` 同一個精神，但：
 * - 只拋 `E_P3D_*`；
 * - 額外統一拒絕 prototype 危險鍵（`__proto__`／`constructor`／`prototype`）；
 * - 所有函式都把輸入當 `unknown`，不做隱含轉型。
 */

export type JsonObject = { readonly [key: string]: unknown };

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function readObject(value: unknown, path: string): JsonObject {
  if (!isPlainObject(value)) fail("E_P3D_TYPE", path);
  return value;
}

/**
 * 嚴格物件：先擋 prototype 危險鍵，再檢查缺少的 key（依宣告順序），最後檢查多出的 key。
 * 因此同一份資料的錯誤碼與路徑是穩定的。
 *
 * `keySet` 可預先計算（熱路徑：mortality 有 40,898 筆，每次重建 Set 會多出四萬次配置）。
 */
export function readExactObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  keySet: ReadonlySet<string> = new Set(keys)
): JsonObject {
  const object = readObject(value, path);
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    if (FORBIDDEN_KEYS.has(key)) fail("E_P3D_PROTOTYPE_KEY", `${path}.${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) fail("E_P3D_MISSING_KEY", `${path}.${key}`);
  }
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    if (!keySet.has(key)) fail("E_P3D_UNKNOWN_KEY", `${path}.${key}`);
  }
  return object;
}

export interface StringRule {
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
}

export function readString(value: unknown, path: string, rule: StringRule = {}): string {
  if (typeof value !== "string") fail("E_P3D_TYPE", path);
  if (rule.pattern && !rule.pattern.test(value)) fail("E_P3D_PATTERN", path);
  if (rule.min !== undefined && value.length < rule.min) fail("E_P3D_RANGE", path);
  if (rule.max !== undefined && value.length > rule.max) fail("E_P3D_RANGE", path);
  return value;
}

export function readNullableString(value: unknown, path: string, rule: StringRule = {}): string | null {
  if (value === null) return null;
  return readString(value, path, rule);
}

/** 安全整數＋範圍；NaN／Infinity／浮點／非數字全部固定拒絕。 */
export function readInt(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number") fail("E_P3D_TYPE", path);
  if (!Number.isFinite(value)) fail("E_P3D_RANGE", path);
  if (!Number.isInteger(value)) fail("E_P3D_RANGE", path);
  if (!Number.isSafeInteger(value)) fail("E_P3D_RANGE", path);
  if (value < min || value > max) fail("E_P3D_RANGE", path);
  return value;
}

export function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("E_P3D_TYPE", path);
  return value;
}

export function readArray(value: unknown, path: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value)) fail("E_P3D_TYPE", path);
  if (value.length < min) fail("E_P3D_RANGE", path);
  if (value.length > max) fail("E_P3D_RANGE", path);
  return value;
}

export function readEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string") fail("E_P3D_TYPE", path);
  if (!(allowed as readonly string[]).includes(value)) fail("E_P3D_ENUM", path);
  return value as T;
}

export function readLiteral<T extends string>(value: unknown, path: string, expected: T): T {
  if (typeof value !== "string") fail("E_P3D_TYPE", path);
  if (value !== expected) fail("E_P3D_SCHEMA_VERSION", path);
  return expected;
}

export function readChecksum(value: unknown, path: string): string {
  return readString(value, path, { pattern: /^[0-9a-f]{64}$/ });
}

/** 深凍結：物件、陣列與其所有子節點都不可變（驗證後的 snapshot 與輸入完全獨立）。 */
export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value) as T;
  }
  return value;
}
