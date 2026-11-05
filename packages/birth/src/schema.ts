import { fail } from "./errors";

export type JsonObject = { readonly [key: string]: unknown };

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readObject(value: unknown, path: string): JsonObject {
  if (!isPlainObject(value)) fail("E_P2A_TYPE", path);
  return value;
}

/**
 * 嚴格物件：先檢查缺少的 key（依宣告順序），再檢查多出的 key（依實際順序），
 * 因此同一份資料的錯誤碼與路徑是穩定的。
 */
export function readExactObject(value: unknown, path: string, keys: readonly string[]): JsonObject {
  const object = readObject(value, path);
  const allowed = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) fail("E_P2A_MISSING_KEY", `${path}.${key}`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail("E_P2A_UNKNOWN_KEY", `${path}.${key}`);
  }
  return object;
}

export interface StringRule {
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
}

export function readString(value: unknown, path: string, rule: StringRule = {}): string {
  if (typeof value !== "string") fail("E_P2A_TYPE", path);
  if (rule.pattern && !rule.pattern.test(value)) fail("E_P2A_PATTERN", path);
  if (rule.min !== undefined && value.length < rule.min) fail("E_P2A_RANGE", path);
  if (rule.max !== undefined && value.length > rule.max) fail("E_P2A_RANGE", path);
  return value;
}

export function readNullableString(value: unknown, path: string, rule: StringRule = {}): string | null {
  if (value === null) return null;
  return readString(value, path, rule);
}

export function readInt(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail("E_P2A_TYPE", path);
  if (!Number.isSafeInteger(value)) fail("E_P2A_RANGE", path);
  if (value < min || value > max) fail("E_P2A_RANGE", path);
  return value;
}

export function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("E_P2A_TYPE", path);
  return value;
}

export function readArray(value: unknown, path: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value)) fail("E_P2A_TYPE", path);
  if (value.length < min) fail("E_P2A_RANGE", path);
  if (value.length > max) fail("E_P2A_RANGE", path);
  return value;
}

export function readStringArray(value: unknown, path: string, min: number, max: number): readonly string[] {
  const array = readArray(value, path, min, max);
  return array.map((entry, index) => readString(entry, `${path}[${index}]`, { min: 1, max: 256 }));
}

export function readEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string") fail("E_P2A_TYPE", path);
  if (!(allowed as readonly string[]).includes(value)) fail("E_P2A_ENUM", path);
  return value as T;
}

export function readLiteral<T extends string>(value: unknown, path: string, expected: T): T {
  if (typeof value !== "string") fail("E_P2A_TYPE", path);
  if (value !== expected) fail("E_P2A_SCHEMA_VERSION", path);
  return expected;
}

export function readChecksum(value: unknown, path: string): string {
  return readString(value, path, { pattern: /^[0-9a-f]{64}$/ });
}
