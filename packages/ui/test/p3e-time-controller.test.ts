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
