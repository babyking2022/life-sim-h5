import { MONEY_STRING_MAX_LENGTH, isMoneyString } from "@life-sim/contracts";
import { fail } from "./errors";

/**
 * 嚴格、無原型鏈風險的 JSON 讀取器（engine 本地版；不依賴 birth 套件）。
 *
 * 規則：
 * - 只接受 plain object（prototype 是 Object.prototype 或 null）。
 * - 先檢查 `__proto__`／`constructor`／`prototype` 這類危險鍵（`E_P3B_PROTOTYPE_KEY`），
 *   再檢查缺少與多出的鍵，錯誤碼與路徑因此穩定。
 * - 所有讀取器只回傳新值，不修改輸入。
 */

export type JsonObject = { readonly [key: string]: unknown };

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function readObject(value: unknown, path: string): JsonObject {
  if (!isPlainObject(value)) fail("E_P3B_TYPE", path);
  return value;
}

/** 先擋危險鍵，再擋缺少／多餘鍵。 */
export function readExactObject(value: unknown, path: string, keys: readonly string[]): JsonObject {
  const object = readObject(value, path);
  for (const key of Object.keys(object)) {
    if (DANGEROUS_KEYS.has(key)) fail("E_P3B_PROTOTYPE_KEY", `${path}.${key}`);
  }
  const allowed = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) fail("E_P3B_MISSING_KEY", `${path}.${key}`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail("E_P3B_UNKNOWN_KEY", `${path}.${key}`);
  }
  return object;
}

export interface StringRule {
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
}

export function readString(value: unknown, path: string, rule: StringRule = {}): string {
  if (typeof value !== "string") fail("E_P3B_TYPE", path);
  if (rule.pattern && !rule.pattern.test(value)) fail("E_P3B_PATTERN", path);
  if (rule.min !== undefined && value.length < rule.min) fail("E_P3B_RANGE", path);
  if (rule.max !== undefined && value.length > rule.max) fail("E_P3B_RANGE", path);
  return value;
}

export function readNullableString(value: unknown, path: string, rule: StringRule = {}): string | null {
  if (value === null) return null;
  return readString(value, path, rule);
}

export function readInt(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail("E_P3B_TYPE", path);
  if (!Number.isSafeInteger(value)) fail("E_P3B_RANGE", path);
  if (value < min || value > max) fail("E_P3B_RANGE", path);
  return value;
}

export function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("E_P3B_TYPE", path);
  return value;
}

export function readArray(value: unknown, path: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value)) fail("E_P3B_TYPE", path);
  if (value.length < min) fail("E_P3B_RANGE", path);
  if (value.length > max) fail("E_P3B_RANGE", path);
  return value;
}

export function readEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string") fail("E_P3B_TYPE", path);
  if (!(allowed as readonly string[]).includes(value)) fail("E_P3B_ENUM", path);
  return value as T;
}

export function readChecksum(value: unknown, path: string): string {
  return readString(value, path, { pattern: /^[0-9a-f]{64}$/ });
}

/** 十進位整數字串（可負）；與 MoneyString 同一格式，用於條件與 effect 金額。 */
export function readMoneyString(value: unknown, path: string): string {
  if (!isMoneyString(value)) {
    if (typeof value !== "string") fail("E_P3B_TYPE", path);
    fail("E_P3B_MONEY", path);
  }
  if ((value as string).length > MONEY_STRING_MAX_LENGTH) fail("E_P3B_MONEY", path);
  return value as string;
}

/** 深凍結；只走訪自有可列舉屬性，不碰原型鏈。 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
