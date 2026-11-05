import type { P3DErrorCode } from "@life-sim/contracts";

/**
 * 唯一允許外洩的 P3-D 錯誤型別。
 *
 * message 只含固定錯誤碼與固定路徑，不含時間、隨機值或資料內容，
 * 因此同一份壞資料在任何瀏覽器／Node 都得到相同字串。
 * 不得讓 TypeError／RangeError／原生例外穿透。
 */
export class DeathDataError extends Error {
  constructor(
    public readonly code: P3DErrorCode,
    public readonly path: string
  ) {
    super(`${code} at ${path}`);
    this.name = "DeathDataError";
  }
}

export function fail(code: P3DErrorCode, path: string): never {
  throw new DeathDataError(code, path);
}

/** 把任何非 DeathDataError 折成固定碼（公開入口的最後一道護欄）。 */
export function guardDeath<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof DeathDataError) throw error;
    throw new DeathDataError("E_P3D_STATE", "internal");
  }
}

export function isDeathDataError(error: unknown): error is DeathDataError {
  return error instanceof DeathDataError;
}
