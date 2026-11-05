import { P3C_ERROR_CODES, type P3CErrorCode } from "@life-sim/contracts";

/**
 * 唯一允許外洩的 P3-C 錯誤型別。
 *
 * 公開入口一律只回 `E_P3C_*`；`MoneyError`、`EventPackError`、原生 TypeError／RangeError
 * 都在 `guard()` 被轉成固定碼。錯誤物件只有 `code` 與 `path`，不含時間、亂數或資料內容。
 */
export class EventLifeError extends Error {
  readonly path: string | undefined;
  constructor(
    public readonly code: P3CErrorCode,
    path?: string
  ) {
    super(path === undefined ? code : `${code} at ${path}`);
    this.name = "EventLifeError";
    this.path = path;
  }
}

export function fail(code: P3CErrorCode, path?: string): never {
  throw new EventLifeError(code, path);
}

const KNOWN = new Set<string>(P3C_ERROR_CODES);

function isKnownCodedError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" && KNOWN.has((error as { code: string }).code);
}

/**
 * 公開入口護欄：任何非 `EventLifeError` 都不得穿透。
 * `E_P3B_*`（事件 pack／抽選／effects 的固定碼）也一律折成 `E_P3C_*`，
 * 因此呼叫端不需要同時處理兩套錯誤碼。
 */
export function guard<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof EventLifeError) throw error;
    if (isKnownCodedError(error)) {
      const code = (error as { code: string }).code;
      // 事件層的固定碼：金錢問題仍是金錢問題，其餘視為事件層拒絕。
      if (code === "E_P3B_MONEY") fail("E_P3C_MONEY");
      if (code === "E_P3B_CHECKSUM" || code === "E_P3B_LICENSE" || code === "E_P3B_LINEAGE" || code === "E_P3B_SOURCE" || code === "E_P3B_VERSIONS") {
        fail("E_P3C_PACK");
      }
      if (code === "E_P3B_DECISION") fail("E_P3C_DECISION");
      if (code === "E_P3B_SELECTION" || code === "E_P3B_WEIGHT" || code === "E_P3B_WEIGHT_TOTAL" || code === "E_P3B_DUPLICATE_ID") {
        fail("E_P3C_SELECTION");
      }
      if (code === "E_P3B_EFFECT" || code === "E_P3B_RANGE" || code === "E_P3B_ENUM") fail("E_P3C_EFFECT");
      fail("E_P3C_STATE");
    }
    if (typeof error === "object" && error !== null && (error as { name?: string }).name === "MoneyError") fail("E_P3C_MONEY");
    fail("E_P3C_STATE");
  }
}
