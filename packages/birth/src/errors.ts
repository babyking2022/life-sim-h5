import type { P2AErrorCode, P2BErrorCode, P2CErrorCode, P2DErrorCode } from "@life-sim/contracts";

/**
 * 固定錯誤碼 + 固定路徑。message 只作除錯，不含時間、隨機值或資料內容，
 * 因此同一份壞資料在任何瀏覽器／Node 都會得到相同字串。
 */
export class BirthDataError extends Error {
  constructor(
    public readonly code: P2AErrorCode | P2BErrorCode | P2CErrorCode | P2DErrorCode,
    public readonly path: string
  ) {
    super(`${code} at ${path}`);
    this.name = "BirthDataError";
  }
}

export function fail(code: P2AErrorCode | P2BErrorCode | P2CErrorCode | P2DErrorCode, path: string): never {
  throw new BirthDataError(code, path);
}
