/** MVP UI clock for the playable life view. It never mutates engine state itself. */

export type Speed = 1 | 2 | 4 | 8 | 16;

export interface LifeClockState {
  readonly running: boolean;
  readonly speed: Speed;
  readonly ticking: boolean;
  readonly disposed: boolean;
  readonly error: unknown | null;
  /** GPT-0036-B：必選暫停點（例如首次人生重心）正在鎖住 clock。 */
  readonly held: boolean;
  readonly holdReason: string | null;
}

export interface LifeClockOptions {
  readonly onTick: () => void | Promise<void>;
  readonly onStateChange?: (state: LifeClockState) => void;
  readonly baseIntervalMs?: number;
  readonly initialSpeed?: Speed;
}

/**
 * GPT-0037-B P1：呼叫端可以把「進入必選暫停之前」的播放意圖交給 hold。
 *
 * 7 歲同年先出現 pending decision 時，decision 會先 `pause()`；如果只用
 * hold 當下的 `running` 判斷，會把「播放中」誤記成「手動暫停」。
 * 傳入 intent 才能讓解除後回到 decision 前的速度／播放狀態。
 */
export interface LifeClockHoldIntent {
  /** 進入必選暫停前是否正在播放；省略時以 hold 當下的 running 為準。 */
  readonly resume?: boolean;
  /** 解除後要回復的速度；省略時沿用目前速度。 */
  readonly speed?: Speed;
}

export interface LifeClock {
  getState(): LifeClockState;
  setSpeed(speed: Speed): void;
  togglePause(): void;
  pause(): void;
  resume(): void;
  /**
   * GPT-0036-B：必選暫停點。立刻清除下一次計時器、記住原本是否在播放，
   * 並在解除前封鎖 resume／setSpeed／togglePause／tickNow／自動 tick。
   * GPT-0037-B：`intent` 由呼叫端繼承 decision 前的播放意圖。
   */
  hold(reason: string, intent?: LifeClockHoldIntent): void;
  /** 解除必選暫停；只有觸發前正在播放才回到同一速度繼續，否則保持手動暫停。 */
  release(): void;
  tickNow(): Promise<void>;
  dispose(): void;
}

const SPEEDS: readonly Speed[] = [1, 2, 4, 8, 16];

export function createLifeClock(options: LifeClockOptions): LifeClock {
  const baseIntervalMs = options.baseIntervalMs ?? 6_000;
  if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) {
    throw new RangeError("baseIntervalMs must be a positive finite number");
  }

  let running = true;
  let speed: Speed = options.initialSpeed ?? 1;
  let ticking = false;
  let disposed = false;
  let error: unknown | null = null;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let held = false;
  let holdReason: string | null = null;
  /** 觸發必選暫停前是否正在播放（速度本身在 hold 期間不會被改動）。 */
  let resumeAfterHold = false;
  /** GPT-0037-B：解除時要回復的速度；null 表示沿用目前速度。 */
  let holdResumeSpeed: Speed | null = null;

  if (!SPEEDS.includes(speed)) throw new RangeError("unsupported initialSpeed");

  const snapshot = (): LifeClockState => ({
    running,
    speed,
    ticking,
    disposed,
    error,
    held,
    holdReason
  });
  const notify = (): void => options.onStateChange?.(snapshot());

  const clearTimer = (): void => {
    if (timer === null) return;
    globalThis.clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    clearTimer();
    if (!running || ticking || disposed || held) return;
    timer = globalThis.setTimeout(() => {
      timer = null;
      void runTick();
    }, baseIntervalMs / speed);
  };

  const runTick = async (): Promise<void> => {
    if (ticking || disposed || held) return;
    ticking = true;
    clearTimer();
    notify();
    try {
      await options.onTick();
      error = null;
    } catch (caught) {
      error = caught;
      running = false;
    } finally {
      ticking = false;
      notify();
      schedule();
    }
  };

  const pause = (): void => {
    if (disposed || held || !running) return;
    running = false;
    clearTimer();
    notify();
  };

  const resume = (): void => {
    if (disposed || held || running) return;
    running = true;
    error = null;
    notify();
    schedule();
  };

  /** 必選暫停：記住原本播放狀態後立刻清掉下一次計時器。 */
  const hold = (reason: string, intent?: LifeClockHoldIntent): void => {
    if (disposed || held) return;
    const targetSpeed = intent?.speed;
    if (targetSpeed !== undefined && !SPEEDS.includes(targetSpeed)) {
      throw new RangeError("unsupported hold speed");
    }
    // GPT-0037-B：decision 會先 pause()，所以不能只讀 hold 當下的 running。
    resumeAfterHold = intent?.resume ?? running;
    holdResumeSpeed = targetSpeed ?? null;
    held = true;
    holdReason = reason;
    running = false;
    ticking = false;
    clearTimer();
    notify();
  };

  const release = (): void => {
    if (disposed || !held) return;
    held = false;
    holdReason = null;
    const shouldResume = resumeAfterHold;
    const restoreSpeed = holdResumeSpeed;
    resumeAfterHold = false;
    holdResumeSpeed = null;
    // GPT-0037-B：回到 decision 前的速度（decision 期間可能被玩家改過）。
    if (restoreSpeed !== null) speed = restoreSpeed;
    if (shouldResume) {
      running = true;
      error = null;
    }
    notify();
    schedule();
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") pause();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  schedule();

  return {
    getState: snapshot,
    setSpeed(nextSpeed: Speed): void {
      if (disposed || held) return;
      if (!SPEEDS.includes(nextSpeed)) throw new RangeError("unsupported speed");
      if (speed === nextSpeed) return;
      speed = nextSpeed;
      notify();
      schedule();
    },
    togglePause(): void {
      if (held) return;
      if (running) pause();
      else resume();
    },
    pause,
    resume,
    hold(reason: string, intent?: LifeClockHoldIntent): void {
      hold(reason, intent);
    },
    release,
    tickNow: runTick,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      running = false;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      notify();
    }
  };
}
