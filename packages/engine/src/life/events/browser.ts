import type { P3BContentMode, P3BEventHistory, P3BPhase, SerializedP3BSelectionState } from "@life-sim/contracts";
import { decodeMoney, MoneyError } from "../../money";
import { selectEvent } from "./select";
import { fail } from "./errors";
import { validateEventPack, type ValidatedEventPack } from "./validate";

/**
 * 瀏覽器／golden 入口：把純 JSON 的案例轉成抽選輸入，回傳可逐位元比對的 digest。
 * 不讀系統時間、不用 Math.random；同一份 pack 與案例在任何引擎都得到相同結果。
 */

export interface EventCaseInput {
  readonly id: string;
  readonly contentMode: P3BContentMode;
  readonly state: SerializedP3BSelectionState;
  readonly history: P3BEventHistory;
  readonly rngState: readonly [number, number, number, number];
}

export interface EventCaseDigest {
  readonly id: string;
  readonly candidateIds: readonly string[];
  readonly selectedEventId: string | null;
  readonly reason: string;
  readonly drawsUsed: number;
  readonly rngStateAfter: readonly number[];
  readonly selectionHash: string;
}

function decodeAssets(state: SerializedP3BSelectionState): {
  balanceMicroUsd: bigint;
  annualIncomeMicroUsd: bigint;
  annualExpenseMicroUsd: bigint;
} {
  try {
    return {
      balanceMicroUsd: decodeMoney(state.assets.balanceMicroUsd),
      annualIncomeMicroUsd: decodeMoney(state.assets.annualIncomeMicroUsd),
      annualExpenseMicroUsd: decodeMoney(state.assets.annualExpenseMicroUsd)
    };
  } catch (error) {
    if (error instanceof MoneyError) return fail("E_P3B_MONEY", "case.state.assets");
    throw error;
  }
}

export function runEventCases(rawPack: unknown, cases: readonly EventCaseInput[]): EventCaseDigest[] {
  const pack: ValidatedEventPack = validateEventPack(rawPack);
  return cases.map((entry) => {
    const selection = selectEvent({
      pack,
      contentMode: entry.contentMode,
      history: entry.history,
      rngState: entry.rngState,
      state: {
        currentYear: entry.state.currentYear,
        age: entry.state.age,
        phase: entry.state.phase as P3BPhase,
        stats: entry.state.stats,
        assets: decodeAssets(entry.state),
        flags: entry.state.flags
      }
    });
    return {
      id: entry.id,
      candidateIds: selection.candidates.map((candidate) => candidate.eventId),
      selectedEventId: selection.selectedEventId,
      reason: selection.reason,
      drawsUsed: selection.drawsUsed,
      rngStateAfter: [...selection.rngStateAfter],
      selectionHash: selection.selectionHash
    };
  });
}

export { validateEventPack };
