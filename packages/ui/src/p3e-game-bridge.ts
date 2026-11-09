/**
 * GPT-WORKBUDDY-0065-A｜birth entry → game chunk 的**單次**交付橋樑。
 *
 * 訂單要求「連點開始只 import 一次、只建一個 session」。這個模組保存
 * 由 birth entry 準備好的完整世界（正式 validators 驗證過），game chunk
 * 載入後取走一次；`setGameHandoff` 冪等，重複呼叫不會覆寫或重建。
 */

export interface GameHandoff {
  /** 出生卡上的 seed（也可能是回訪玩家的 active／pinned seed）。 */
  readonly seed: string;
  /** 是否已有明確 seed（active／pinned）；影響 restore 順序。 */
  readonly knownSeed: boolean;
  /** 是否由使用者按「開始人生」明確開新命（false = 回訪玩家 restore）。 */
  readonly startNewLife: boolean;
  /** `P3EBrowserWorld`：application 的不可偽造 handle（此處視為 opaque）。 */
  readonly world: unknown;
  /** `P3EBrowserBirthStage`：完整 validators 驗證過的出生 stage。 */
  readonly birthStage: unknown;
  readonly eventCopy: Readonly<Record<string, string>>;
  readonly eventCopyKeys: number;
  readonly countryRegistry: readonly Readonly<Record<string, unknown>>[];
  readonly storage: Storage | null;
}

let pending: GameHandoff | null = null;

/** 只有第一次生效；連點／重繪都不會改寫交付內容。 */
export function setGameHandoff(handoff: GameHandoff): void {
  if (pending === null) pending = handoff;
}

/** game chunk 取走交付（取走後清空，避免重複建立 session）。 */
export function takeGameHandoff(): GameHandoff | null {
  const value = pending;
  pending = null;
  return value;
}

export function hasGameHandoff(): boolean {
  return pending !== null;
}
