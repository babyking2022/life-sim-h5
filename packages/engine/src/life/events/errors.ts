import type { P3BErrorCode } from "@life-sim/contracts";

/**
 * P3-B 的唯一錯誤型別：固定錯誤碼 ＋ 固定路徑。
 * message 只包含 code 與 path（不含時間、亂數或資料內容），因此同一份資料
 * 在任何編譯器／Node 版本的訊息都相同。
 */
export class EventPackError extends Error {
  constructor(
    public readonly code: P3BErrorCode,
    public readonly path: string
  ) {
    super(`${code} at ${path}`);
    this.name = "EventPackError";
  }
}

export function fail(code: P3BErrorCode, path: string): never {
  throw new EventPackError(code, path);
}
