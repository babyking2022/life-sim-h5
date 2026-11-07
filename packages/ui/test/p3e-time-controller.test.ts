import { afterEach, describe, expect, it, vi } from "vitest";
import { createLifeClock } from "../src/p3e-time-controller";

afterEach(() => {
  vi.useRealTimers();
});

describe("createLifeClock", () => {
  it("runs at the selected multiplier", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 1_600 });

    clock.setSpeed(16);
    await vi.advanceTimersByTimeAsync(99);
    expect(onTick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTick).toHaveBeenCalledTimes(1);
    clock.dispose();
  });

  it("pauses and resumes without ticking while paused", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 100 });

    clock.pause();
    await vi.advanceTimersByTimeAsync(500);
    expect(onTick).not.toHaveBeenCalled();
    clock.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(1);
    clock.dispose();
  });

  it("supports an immediate manual tick while paused", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick });

    clock.pause();
    await clock.tickNow();
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(clock.getState().running).toBe(false);
    clock.dispose();
  });

  it("disposes its pending work", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 10 });

    clock.dispose();
    await vi.advanceTimersByTimeAsync(100);
    await clock.tickNow();
    expect(onTick).not.toHaveBeenCalled();
    expect(clock.getState().disposed).toBe(true);
  });

  it("never overlaps asynchronous ticks", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const onTick = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const clock = createLifeClock({ onTick, baseIntervalMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    expect(onTick).toHaveBeenCalledTimes(1);
    const manual = clock.tickNow();
    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(1);
    release?.();
    await manual;
    clock.dispose();
  });

  it("pauses after a tick error instead of leaking a rejection", async () => {
    vi.useFakeTimers();
    const clock = createLifeClock({
      baseIntervalMs: 10,
      onTick: () => {
        throw new Error("tick failed");
      }
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(clock.getState().running).toBe(false);
    expect(clock.getState().error).toBeInstanceOf(Error);
    clock.dispose();
  });
});

/**
 * GPT-0036-B D：首次人生重心必選暫停。
 * `hold()` 必須真的清掉計時器並封鎖所有推進入口，`release()` 只能回到
 * 「觸發前」的播放狀態，不能把原本手動暫停的玩家無條件變成自動播放。
 */
describe("createLifeClock：必選暫停 hold/release", () => {
  it("hold 後跨越多個 interval 都不 tick，且 resume／setSpeed／tickNow 全部無效", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 100, initialSpeed: 1 });
    clock.setSpeed(4);

    clock.hold("life-focus-required");
    expect(clock.getState()).toMatchObject({
      running: false,
      held: true,
      holdReason: "life-focus-required",
      speed: 4
    });

    clock.resume();
    clock.togglePause();
    clock.setSpeed(16);
    await clock.tickNow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTick).not.toHaveBeenCalled();
    expect(clock.getState().speed).toBe(4);
    expect(clock.getState().running).toBe(false);
    clock.dispose();
  });

  it("原本正在播放：release 後回到同一速度繼續", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 100 });
    clock.setSpeed(8);

    clock.hold("life-focus-required");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).not.toHaveBeenCalled();

    clock.release();
    expect(clock.getState()).toMatchObject({ running: true, held: false, holdReason: null, speed: 8 });
    // 100 / 8 = 12.5ms；fake timer 可能取整到 12ms，只驗證下一個 interval 內會恢復。
    await vi.advanceTimersByTimeAsync(13);
    expect(onTick).toHaveBeenCalledTimes(1);
    clock.dispose();
  });

  it("原本手動暫停：release 後仍保持暫停", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 100 });
    clock.setSpeed(2);
    clock.pause();

    clock.hold("life-focus-required");
    clock.release();
    expect(clock.getState()).toMatchObject({ running: false, held: false, speed: 2 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).not.toHaveBeenCalled();
    clock.dispose();
  });

  it("重複 hold 不會覆寫原本的播放狀態", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 100 });
    clock.hold("life-focus-required");
    clock.hold("again");
    expect(clock.getState().holdReason).toBe("life-focus-required");
    clock.release();
    expect(clock.getState().running).toBe(true);
    clock.dispose();
  });
});

/**
 * GPT-0037-B P1：decision 會先 pause()，所以解除必選重心時必須繼承
 * 「進入 decision 前」的播放意圖，而不是 hold 當下的 running=false。
 * 下面兩組就是任務指定的 playing 16× 與 manual paused 對照組。
 */
describe("createLifeClock：decision → 首次重心播放意圖", () => {
  it("playing 16× → decision 暫停 → hold(intent) → release 回到 running 16×", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 1_600 });
    clock.setSpeed(16);
    expect(clock.getState()).toMatchObject({ running: true, speed: 16 });

    // decision 為了等待玩家選擇而 pause()；在此之前 UI 已擷取 intent。
    const decisionIntent = { resume: true, speed: 16 as const };
    clock.pause();
    expect(clock.getState().running).toBe(false);

    clock.hold("life-focus-required", decisionIntent);
    await clock.tickNow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTick).not.toHaveBeenCalled();
    expect(clock.getState()).toMatchObject({ held: true, running: false, speed: 16 });

    clock.release();
    expect(clock.getState()).toMatchObject({
      held: false,
      holdReason: null,
      running: true,
      speed: 16
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(1);
    clock.dispose();
  });

  it("manual paused 對照組：hold(intent resume:false) → release 仍暫停", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 100, initialSpeed: 16 });
    clock.pause();

    clock.hold("life-focus-required", { resume: false, speed: 16 });
    clock.release();
    expect(clock.getState()).toMatchObject({
      held: false,
      running: false,
      speed: 16
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTick).not.toHaveBeenCalled();
    clock.dispose();
  });

  it("decision 期間被改過速度：release 回到 decision 前的速度", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 100 });
    clock.setSpeed(16);
    clock.pause();
    clock.setSpeed(4); // 玩家在 decision 等待期間改了速度

    clock.hold("life-focus-required", { resume: true, speed: 16 });
    expect(clock.getState().speed).toBe(4);
    clock.release();
    expect(clock.getState()).toMatchObject({ running: true, speed: 16 });
    clock.dispose();
  });

  it("intent 未指定 resume 時仍沿用 hold 當下的 running", () => {
    vi.useFakeTimers();
    const clock = createLifeClock({ onTick: vi.fn(), baseIntervalMs: 100 });
    clock.pause();
    clock.hold("life-focus-required", { speed: 8 });
    clock.release();
    expect(clock.getState()).toMatchObject({ running: false, speed: 8 });
    clock.dispose();
  });

  it("非法 intent 速度直接擋下，不留下半套 hold 狀態", () => {
    vi.useFakeTimers();
    const clock = createLifeClock({ onTick: vi.fn(), baseIntervalMs: 100 });
    expect(() => clock.hold("life-focus-required", { speed: 3 as never })).toThrow(RangeError);
    expect(clock.getState()).toMatchObject({ held: false, running: true });
    clock.dispose();
  });

  it("第二次 hold 沒有 intent 時回到讀取 running 的既有行為", () => {
    vi.useFakeTimers();
    const clock = createLifeClock({ onTick: vi.fn(), baseIntervalMs: 100 });
    clock.pause();
    clock.hold("life-focus-required", { resume: true, speed: 8 });
    clock.release();
    expect(clock.getState().speed).toBe(8);
    clock.hold("life-focus-required");
    clock.release();
    expect(clock.getState()).toMatchObject({ running: true, speed: 8 });
    clock.dispose();
  });
});
