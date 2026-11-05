/** MVP UI clock for the playable life view. It never mutates engine state itself. */

export type Speed = 1 | 2 | 4 | 8 | 16;

export interface LifeClockState {
  readonly running: boolean;
  readonly speed: Speed;
  readonly ticking: boolean;
  readonly disposed: boolean;
  readonly error: unknown | null;
}

export interface LifeClockOptions {
  readonly onTick: () => void | Promise<void>;
  readonly onStateChange?: (state: LifeClockState) => void;
  readonly baseIntervalMs?: number;
  readonly initialSpeed?: Speed;
}

export interface LifeClock {
  getState(): LifeClockState;
  setSpeed(speed: Speed): void;
  togglePause(): void;
  pause(): void;
  resume(): void;
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

  if (!SPEEDS.includes(speed)) throw new RangeError("unsupported initialSpeed");

  const snapshot = (): LifeClockState => ({ running, speed, ticking, disposed, error });
  const notify = (): void => options.onStateChange?.(snapshot());

  const clearTimer = (): void => {
    if (timer === null) return;
    globalThis.clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    clearTimer();
    if (!running || ticking || disposed) return;
    timer = globalThis.setTimeout(() => {
      timer = null;
      void runTick();
    }, baseIntervalMs / speed);
  };

  const runTick = async (): Promise<void> => {
    if (ticking || disposed) return;
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
    if (disposed || !running) return;
    running = false;
    clearTimer();
    notify();
  };

  const resume = (): void => {
    if (disposed || running) return;
    running = true;
    error = null;
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
      if (disposed) return;
      if (!SPEEDS.includes(nextSpeed)) throw new RangeError("unsupported speed");
      if (speed === nextSpeed) return;
      speed = nextSpeed;
      notify();
      schedule();
    },
    togglePause(): void {
      if (running) pause();
      else resume();
    },
    pause,
    resume,
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
