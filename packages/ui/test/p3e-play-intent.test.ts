import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLifeClock,
  type LifeClockState,
  type Speed
} from "../src/p3e-time-controller";
import {
  createDecisionPlayIntentTracker,
  isEnteringDecision,
  type DecisionPlayIntent
} from "../src/p3e-play-intent";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * GPT-0037-B P1：完整路徑的整合測試（tracker + 真正的 LifeClock）。
 *
 * 任務指定兩組：
 *  - playing 16× → pending decision → choose → focus required → choose focus
 *    → running=true, speed=16
 *  - manual paused 對照組 → 保持 running=false
 *
 * 另外驗證「普通 decision 解決後自動續播」、「讀檔落在待決策」、
 * 「換命後舊意圖不殘留」與「未選重心前不得偷跑」。
 */
async function playDecisionThenFocus(options: {
  readonly playing: boolean;
  readonly speed: Speed;
}): Promise<{ readonly final: LifeClockState; readonly ticks: number }> {
  vi.useFakeTimers();
  const onTick = vi.fn();
  const clock = createLifeClock({ onTick, baseIntervalMs: 1_600 });
  const tracker = createDecisionPlayIntentTracker();

  tracker.reset({ view: { phase: "life" } }, clock.getState().speed);
  clock.setSpeed(options.speed);
  if (!options.playing) clock.pause();

  // ---- 7 歲同年先出現 pending decision ----------------------------------
  const phaseBefore = "life";
  const phaseAfterDecision = "pending_decision";
  const beforeDecision = clock.getState();
  expect(isEnteringDecision(phaseBefore, phaseAfterDecision)).toBe(true);
  tracker.capture(beforeDecision);
  clock.pause(); // decision 為了等待玩家選擇而暫停
  expect(clock.getState().running).toBe(false);

  // ---- 解決 decision，同年立刻進 focus required -------------------------
  const intent: DecisionPlayIntent | null = tracker.take();
  expect(intent).not.toBeNull();
  expect(intent).toEqual({ resume: options.playing, speed: options.speed });
  clock.hold("life-focus-required", intent ?? undefined);

  // 未選重心前不偷跑：計時器、tickNow、resume、setSpeed 全部硬擋。
  clock.resume();
  clock.togglePause();
  clock.setSpeed(4);
  await clock.tickNow();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(clock.getState()).toMatchObject({ held: true, running: false });
  expect(onTick).not.toHaveBeenCalled();

  // ---- 選定重心 → release ------------------------------------------------
  clock.release();
  const final = clock.getState();
  const ticks = onTick.mock.calls.length;
  clock.dispose();
  return { final, ticks };
}

describe("GPT-0037-B P1：decision → 首次重心播放意圖（整合）", () => {
  it("原本播放 16×：選完重心後 running=true 且 speed=16", async () => {
    const { final, ticks } = await playDecisionThenFocus({ playing: true, speed: 16 });
    expect(final).toMatchObject({ held: false, holdReason: null, running: true, speed: 16 });
    expect(ticks).toBe(0); // release 只排程，不立刻偷跑一年
  });

  it("原本手動暫停：選完重心後仍 running=false", async () => {
    const { final, ticks } = await playDecisionThenFocus({ playing: false, speed: 16 });
    expect(final).toMatchObject({ held: false, running: false, speed: 16 });
    expect(ticks).toBe(0);
  });

  it("普通 decision（沒有 focus gate）解決後照原意圖自動續播", () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 100 });
    const tracker = createDecisionPlayIntentTracker();
    tracker.reset({ view: { phase: "life" } }, clock.getState().speed);
    clock.setSpeed(8);
    tracker.capture(clock.getState());
    clock.pause();
    const intent = tracker.take();
    expect(intent).toEqual({ resume: true, speed: 8 });
    // 沒有 hold：UI 直接把 intent 套回去
    if (clock.getState().speed !== intent!.speed) clock.setSpeed(intent!.speed);
    if (intent!.resume) clock.resume();
    expect(clock.getState()).toMatchObject({ running: true, speed: 8 });
    clock.dispose();
  });

  it("讀檔直接落在 pending_decision：沿用既有自動續播意圖", () => {
    const tracker = createDecisionPlayIntentTracker();
    tracker.reset({ view: { phase: "pending_decision" } }, 4);
    expect(tracker.take()).toEqual({ resume: true, speed: 4 });
    expect(tracker.take()).toBeNull();
  });

  it("換命／重載回出生卡後舊意圖不殘留", () => {
    const tracker = createDecisionPlayIntentTracker();
    tracker.reset({ view: { phase: "life" } }, 1);
    tracker.capture({ running: true, held: false, speed: 16 } as LifeClockState);
    expect(tracker.peek()).toEqual({ resume: true, speed: 16 });
    tracker.reset(null, 1);
    expect(tracker.take()).toBeNull();
  });

  it("已在 pending_decision 的命令不會重複擷取意圖", () => {
    expect(isEnteringDecision("pending_decision", "pending_decision")).toBe(false);
    expect(isEnteringDecision("pending_decision", "life")).toBe(false);
    expect(isEnteringDecision("life", "life")).toBe(false);
  });
});

/**
 * GPT-0038-B：「下一個決定」快轉過程一定先 pause()，若 capture() 直接讀
 * 當下 clock 就會把「跳轉前播放中」誤記成手動暫停。這裡用真正的
 * LifeClock 重現 jump → pending decision → choose →（重心）→ release。
 */
describe("GPT-0038-B：jumpToNextDecision 播放意圖", () => {
  it("jump 前播放 16×：capture 不被快轉的 paused 狀態覆蓋", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 1_600 });
    const tracker = createDecisionPlayIntentTracker();
    clock.setSpeed(16);
    expect(clock.getState().running).toBe(true);

    // jump 開頭：先 arm 跳轉前意圖，接著 pause() 才逐年快轉。
    tracker.arm({ resume: true, speed: clock.getState().speed });
    expect(tracker.peekArmed()).toEqual({ resume: true, speed: 16 });
    clock.pause();
    expect(clock.getState().running).toBe(false);

    // 進入 pending_decision 時 runCommand 呼叫 capture(paused clock)。
    tracker.capture(clock.getState());
    expect(tracker.peek()).toEqual({ resume: true, speed: 16 });
    expect(tracker.peekArmed()).toBeNull(); // armed 只消費一次
    expect(tracker.take()).toEqual({ resume: true, speed: 16 });
    clock.dispose();
  });

  it("jump 前手動暫停：選擇 decision 後保持 paused", async () => {
    vi.useFakeTimers();
    const clock = createLifeClock({ onTick: vi.fn(), baseIntervalMs: 1_600 });
    const tracker = createDecisionPlayIntentTracker();
    clock.setSpeed(4);
    clock.pause();
    tracker.arm({ resume: false, speed: 4 });
    tracker.capture(clock.getState()); // 快轉中的 clock 剛好也是 paused
    const intent = tracker.take();
    expect(intent).toEqual({ resume: false, speed: 4 });
    clock.hold("life-focus-required", intent ?? undefined);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(clock.getState()).toMatchObject({ held: true, running: false });
    clock.release();
    expect(clock.getState()).toMatchObject({ held: false, running: false, speed: 4 });
    clock.dispose();
  });

  it("jump → decision → focus-required：選完重心回到 jump 前速度且不偷跑", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = createLifeClock({ onTick, baseIntervalMs: 1_600 });
    const tracker = createDecisionPlayIntentTracker();
    clock.setSpeed(16);
    tracker.arm({ resume: true, speed: 16 });
    clock.pause();
    tracker.capture(clock.getState());
    const intent = tracker.take();
    clock.hold("life-focus-required", intent ?? undefined);
    clock.resume();
    await clock.tickNow();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onTick).not.toHaveBeenCalled();
    expect(clock.getState()).toMatchObject({ held: true, running: false });
    clock.release();
    expect(clock.getState()).toMatchObject({ held: false, running: true, speed: 16 });
    expect(onTick).not.toHaveBeenCalled(); // release 只排程，不立刻偷跑一年
    clock.dispose();
  });

  it("沒有 armed 時 capture 維持既有行為（讀當下 clock）", () => {
    const tracker = createDecisionPlayIntentTracker();
    tracker.reset({ view: { phase: "life" } }, 1);
    tracker.capture({ running: false, held: false, speed: 8 } as LifeClockState);
    expect(tracker.take()).toEqual({ resume: false, speed: 8 });
  });

  it("jump 沒找到 decision（死亡／錯誤）：disarm 後 armed 不殘留", () => {
    const tracker = createDecisionPlayIntentTracker();
    tracker.arm({ resume: true, speed: 16 });
    expect(tracker.peekArmed()).not.toBeNull();
    tracker.disarm();
    expect(tracker.peekArmed()).toBeNull();
    expect(tracker.take()).toBeNull();
  });

  it("換命／讀檔／重生：reset 連同 armed 一起清掉，不污染下一條命", () => {
    const tracker = createDecisionPlayIntentTracker();
    tracker.arm({ resume: true, speed: 16 });
    tracker.reset(null, 1);
    expect(tracker.peekArmed()).toBeNull();
    expect(tracker.peek()).toBeNull();
    // 新的一命是手動暫停，不能被上一條命的 playing intent 打開。
    tracker.capture({ running: false, held: false, speed: 1 } as LifeClockState);
    expect(tracker.take()).toEqual({ resume: false, speed: 1 });
  });

  it("decision 解決後 take() 會清掉任何殘留 armed", () => {
    const tracker = createDecisionPlayIntentTracker();
    tracker.arm({ resume: true, speed: 16 });
    tracker.capture({ running: false, held: false, speed: 16 } as LifeClockState);
    tracker.arm({ resume: true, speed: 8 }); // 模擬下一次跳轉又 arm 了
    expect(tracker.take()).toEqual({ resume: true, speed: 16 });
    expect(tracker.peekArmed()).toBeNull();
  });
});
