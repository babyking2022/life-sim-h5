import { describe, expect, it } from "vitest";
import type { P3CLifeState } from "@life-sim/contracts";
import { applyEventLifeCommand, resolveEventLifeYear } from "../src/life/annual";
import { ANNUAL_EVENT_STAGES, type AnnualEventStage } from "../src/life/annual/transaction";
import { disableAnnualEventFailureInjection, enableAnnualEventFailureInjection } from "../src/life/annual/benchmark";
import { driveYears, loadPack } from "./p3c-helpers";

/**
 * P3-C 年度原子交易：抽選後／effects 後／occurrence 後／ledger 提交前的故障注入
 * 都不得留下部分結果。
 */

const pack = loadPack();

function snapshot(state: unknown): string {
  return JSON.stringify(state, (_key, value) => (typeof value === "bigint" ? `${value.toString()}n` : value));
}

function withInjection<T>(stage: AnnualEventStage, action: () => T): T {
  enableAnnualEventFailureInjection(stage);
  try {
    return action();
  } finally {
    disableAnnualEventFailureInjection();
  }
}

describe("P3-C 年度交易故障注入", () => {
  it("交易是純函式：任何階段失敗時輸入 state 完全不變", () => {
    const state = driveYears(pack, 3).state;
    const before = snapshot(state);
    for (const stage of ANNUAL_EVENT_STAGES) {
      expect(() => withInjection(stage, () => resolveEventLifeYear(state, pack))).toThrowError(/E_P3C_/);
      expect(snapshot(state)).toBe(before);
    }
  });

  it("失敗時不消耗 RNG、不增加 occurrences、不產生 pending decision、不產生 delta", () => {
    const state = driveYears(pack, 3).state;
    const rngBefore = JSON.stringify(state.events.rng);
    const occurrencesBefore = JSON.stringify(state.events.occurrences);
    const rngLifeBefore = JSON.stringify(state.rng);
    const pendingBefore = state.pendingDecision === null ? "null" : JSON.stringify(state.pendingDecision);
    for (const stage of ANNUAL_EVENT_STAGES) {
      let result: unknown;
      try {
        result = withInjection(stage, () => resolveEventLifeYear(state, pack));
      } catch (error) {
        expect(error).toBeDefined();
      }
      expect(result).toBeUndefined();
      expect(JSON.stringify(state.events.rng)).toBe(rngBefore);
      expect(JSON.stringify(state.events.occurrences)).toBe(occurrencesBefore);
      expect(JSON.stringify(state.rng)).toBe(rngLifeBefore);
      expect(state.pendingDecision === null ? "null" : JSON.stringify(state.pendingDecision)).toBe(pendingBefore);
    }
  });

  it("經指令層（FAST_FORWARD_STEP）失敗時不追加任何 delta，並停在錯誤前的年度", () => {
    const state = driveYears(pack, 3).state;
    const yearsBefore = state.history.yearsRecorded;
    for (const stage of ANNUAL_EVENT_STAGES) {
      const result = withInjection(stage, () => applyEventLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: 3 }, pack));
      expect(result.deltas).toHaveLength(0);
      expect(result.state.history.yearsRecorded).toBe(yearsBefore);
      expect(result.state.phase).toBe("error");
      expect(result.state.errorCode).toBe("E_P3C_STATE");
      expect(result.state.pendingDecision).toBeNull();
      expect(result.state.events).toEqual(state.events);
      expect(result.state.history.lastDeltaHash).toBe(state.history.lastDeltaHash);
      assertNoHashDrift(result.state, state);
    }
  });

  it("中途失敗會保留先前已成功的年度（transaction-per-year 的原子性）", () => {
    const start = driveYears(pack, 3).state;
    const good = applyEventLifeCommand(start, { type: "FAST_FORWARD_STEP", maxYears: 1 }, pack);
    expect(good.deltas).toHaveLength(1);
    const next = good.state;
    const bad = withInjection("before_commit", () => applyEventLifeCommand(next, { type: "FAST_FORWARD_STEP", maxYears: 1 }, pack));
    expect(bad.deltas).toHaveLength(0);
    expect(bad.state.history.yearsRecorded).toBe(next.history.yearsRecorded);
    assertNoHashDrift(bad.state, next);
  });

  it("注入只影響一次呼叫（關掉之後年度交易恢復正常）", () => {
    const state = driveYears(pack, 3).state;
    enableAnnualEventFailureInjection("after_selection");
    expect(() => resolveEventLifeYear(state, pack)).toThrowError(/E_P3C_/);
    disableAnnualEventFailureInjection();
    const ok = resolveEventLifeYear(state, pack);
    expect(ok.state.history.yearsRecorded).toBe(state.history.yearsRecorded + 1);
  });

  it("非法的注入階段名稱 → E_P3C_ARGUMENT", () => {
    expect(() => enableAnnualEventFailureInjection("nope" as never)).toThrowError(/E_P3C_ARGUMENT/);
    disableAnnualEventFailureInjection();
  });
});

function assertNoHashDrift(failed: P3CLifeState, before: P3CLifeState): void {
  expect(failed.history.lastEntryHash).toBe(before.history.lastEntryHash);
  expect(failed.history.lastSnapshotHash).toBe(before.history.lastSnapshotHash);
  expect(failed.history.lastDeltaHash).toBe(before.history.lastDeltaHash);
  expect(failed.history.cardsTotal).toBe(before.history.cardsTotal);
}
