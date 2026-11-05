import { P3E_ERROR_CODES, type P3EErrorCode } from "@life-sim/contracts";

/**
 * P3-E 唯一的錯誤型別（P3-E.1a-1.1：改用**不可偽造的私有品牌**）。
 *
 * - 品牌是模組內的 `WeakSet`：只有真正執行過本建構子的實例会被加入；
 *   `Object.create(P3EError.prototype)`、改 prototype、只偽造 `code`／`name` 的物件
 *   都不在集合裡，因此 `isP3EError` 一律回 `false`。
 * - `isP3EError` 同時要求 `instanceof` 與品牌，兩者都成立才算。
 * - 建構時驗證錯誤碼：非法碼一律折成 `E_P3E_TYPE at code`。
 */

const LEGAL_CODES: ReadonlySet<string> = new Set(P3E_ERROR_CODES);
const BRAND: WeakSet<object> = new WeakSet<object>();

export class P3EError extends Error {
  public readonly code: P3EErrorCode;
  public readonly path: string;

  constructor(code: P3EErrorCode, path: string) {
    const legal = typeof code === "string" && LEGAL_CODES.has(code);
    super(legal ? `${code} at ${path}` : "E_P3E_TYPE at code");
    this.name = "P3EError";
    this.code = legal ? code : "E_P3E_TYPE";
    this.path = legal ? path : "code";
    BRAND.add(this);
  }
}

/** 只有「真正建構過」且仍是同一個 prototype 的實例才算。 */
export function isP3EError(value: unknown): value is P3EError {
  return value instanceof P3EError && typeof value === "object" && value !== null && BRAND.has(value);
}
