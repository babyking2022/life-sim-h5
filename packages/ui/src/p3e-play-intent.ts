import type { LifeClockHoldIntent, LifeClockState, Speed } from "./p3e-time-controller.js";

/**
 * GPT-0037-B P1：decision → 首次必選重心之間的「播放意圖」傳遞。
 *
 * 這一層是純邏輯（不碰 DOM、不碰 engine），讓完整路徑可以在 Node 單測裡
 * 與 `createLifeClock` 一起跑，不必只靠瀏覽器觀察。
 *
 * 問題背景：7 歲同年先出現 pending decision 時，UI 會先 `pause()` 等玩家
 * 選擇；如果解除必選重心時才去讀 `clock.running`，看到的會是這個「被動
 * 暫停」而不是玩家原本的播放意圖。解法是在進入 decision 前擷取
 * `{ resume, speed }`，解決 decision 後交給 `hold()` 繼承。
 *
 * GPT-0038-B：「下一個決定」快轉同樣會先 `pause()`，因此 jump 必須在
 * 暫停之前 `arm()` 跳轉前的播放意圖，讓 `capture()` 優先繼承；找不到
 * decision（死亡／錯誤／換命／讀檔／匯入／復原）時用 `disarm()` 清除，
 * 任何 `reset()`／`take()` 也都會連同 armed 一起清掉。
 */
export type DecisionPlayIntent = Required<LifeClockHoldIntent>;

/** 只需要 view.phase；刻意不依賴完整的 P3EPlaySession 型別。 */
export interface SessionPhaseLike {
  readonly view: { readonly phase: string };
}

export interface DecisionPlayIntentTracker {
  /** 換命／讀檔／重載後重設；讀進來就是待決策時沿用既有「自動續播」。 */
  reset(current: SessionPhaseLike | null, speed: Speed): void;
  /**
   * GPT-0038-B：點「下一個決定」之前先記住跳轉前的播放意圖。
   * 快轉過程本身是暫停的，不能用 `capture()` 當下的 clock 覆蓋這份意圖。
   */
  arm(intent: DecisionPlayIntent): void;
  /** 死亡／錯誤／換命／讀檔／匯入／復原／沒有找到 decision 時清除 armed。 */
  disarm(): void;
  /** 只在「剛進入 pending decision」時呼叫；有 armed 時優先繼承跳轉前意圖。 */
  capture(before: LifeClockState): void;
  /** 取用並清空；每個 decision 只消費者一次，避免污染後續必選重心。 */
  take(): DecisionPlayIntent | null;
  /** 只讀取目前值（測試與診斷用），不清空。 */
  peek(): DecisionPlayIntent | null;
  /** 只讀取尚未被 capture 消費的跳轉意圖（測試與診斷用）。 */
  peekArmed(): DecisionPlayIntent | null;
}

export function isEnteringDecision(phaseBefore: string, phaseAfter: string): boolean {
  return phaseAfter === "pending_decision" && phaseBefore !== "pending_decision";
}

export function createDecisionPlayIntentTracker(): DecisionPlayIntentTracker {
  let intent: DecisionPlayIntent | null = null;
  /** GPT-0038-B：jump 前預置、尚未交給 decision 的播放意圖。 */
  let armed: DecisionPlayIntent | null = null;
  return {
    reset(current, speed): void {
      // 任何換命／讀檔／重載都要連同 armed 一起清掉，避免污染下一條命。
      armed = null;
      // 讀檔直接落在待決策時沒有「進入 decision 前」的畫面可讀，
      // 沿用 0036-B 既有的「解決 decision 後自動續播」行為。
      intent = current !== null && current.view.phase === "pending_decision"
        ? { resume: true, speed }
        : null;
    },
    arm(next): void {
      armed = next;
    },
    disarm(): void {
      armed = null;
    },
    capture(before): void {
      // 快轉逐年 advance 時 clock 已被動暫停；有 armed 就必須用它，
      // 而不是把「快轉過程的 paused」誤記成玩家原本手動暫停。
      const override = armed;
      armed = null;
      intent = override ?? { resume: before.running && !before.held, speed: before.speed };
    },
    take(): DecisionPlayIntent | null {
      const current = intent;
      intent = null;
      armed = null; // decision 已解決，任何殘留的 jump 意圖都不該再被沿用
      return current;
    },
    peek(): DecisionPlayIntent | null {
      return intent;
    },
    peekArmed(): DecisionPlayIntent | null {
      return armed;
    }
  };
}
