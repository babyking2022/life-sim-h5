/**
 * P3-C 內部 benchmark／測試入口。**不是公開契約，不從 `@life-sim/engine` barrel 匯出。**
 *
 * 邊界與 P3-A 的 `life/benchmark.ts` 相同：
 * - 公開 `createEventLifeState` 不接受任意壽命、也不接受 `p3c-bench-*` ruleset；
 * - 長壽命 soak 與 10,000 年效能只能透過這裡的內部入口建立；
 * - `scripts/check-architecture.mjs` 的 benchmark-isolation 檢查會擋下 production 套件誤用本模組；
 *   本檔本身不被 `life/annual/index.ts` 匯出。
 */
import type { P3ABootstrap, P3ACommandRecord, P3CLifeState, SerializedP3CLifeState } from "@life-sim/contracts";
import type { ValidatedEventPack } from "../events/validate";
import { serializeEventLifeStateForBenchmark } from "./codec";
import {
  reconstructEventLifeStateForBenchmark,
  verifyEventLifeStateForBenchmark,
  type P3CEventReplayTrace
} from "./replay";
import {
  createEventLifeStateForBenchmark,
  eventLifeChainFor,
  eventLifeChainRoot,
  sealEventLifeState
} from "./state";
import { setAnnualEventFailureInjectionForTests, type AnnualEventStage } from "./transaction";

/** 內部 benchmark ruleset 前綴（與 `state.ts` 的檢查一致）。 */
export const EVENT_BENCHMARK_RULESET_PREFIX = "p3c-bench-";

/** 建立指定壽命的合法事件人生狀態（benchmark／soak 專用）。 */
export function createEventBenchmarkLifeState(bootstrap: unknown, pack: unknown, lifespanYears: number): P3CLifeState {
  return createEventLifeStateForBenchmark(bootstrap, pack, lifespanYears);
}

/** 內部序列化（量測 state 大小用）；公開 `serializeEventLifeState` 會拒絕 benchmark ruleset。 */
export function serializeEventBenchmarkLifeState(state: unknown): SerializedP3CLifeState {
  return serializeEventLifeStateForBenchmark(state);
}

export function reconstructEventBenchmarkLifeState(
  input: { bootstrap: P3ABootstrap; targetYears: number; commandLog: readonly P3ACommandRecord[] },
  pack: ValidatedEventPack,
  lifespanYears: number
): P3CEventReplayTrace {
  return reconstructEventLifeStateForBenchmark(input, pack, lifespanYears);
}

export function verifyEventBenchmarkLifeState(bootstrap: P3ABootstrap, state: P3CLifeState, pack: ValidatedEventPack): P3CEventReplayTrace {
  return verifyEventLifeStateForBenchmark(bootstrap, state, pack);
}

/** 讓年度交易在指定階段失敗（測試專用）。 */
export function enableAnnualEventFailureInjection(stage: AnnualEventStage): void {
  setAnnualEventFailureInjectionForTests(stage);
}

export function disableAnnualEventFailureInjection(): void {
  setAnnualEventFailureInjectionForTests(null);
}

/**
 * 測試專用：把改過的狀態重新封裝成「自洽」的偽造狀態。
 * - `rechain = false` 只重算 stateHash；
 * - `rechain = true` 連整條 hashChain 一起重算，模擬「改了欄位又把相依 hash 全部重算」的攻擊。
 * 只有 genesis 重播能抓到這種偽造，因此不得從公開 barrel 匯出。
 */
export function forgeEventLifeState(state: P3CLifeState, rechain: boolean): P3CLifeState {
  let chain = eventLifeChainRoot(state.history.initialStateHash);
  const records = state.commandLog.map((record) => {
    if (!rechain) return record;
    const nextChain = eventLifeChainFor(chain, {
      seq: record.seq,
      commandType: record.commandType,
      payload: record.payload,
      argsHash: record.argsHash,
      atYear: record.atYear,
      effectiveYear: record.effectiveYear,
      auto: record.auto,
      policyId: record.policyId,
      rngState: record.rngState,
      rngDraws: record.rngDraws,
      stateHashBefore: record.stateHashBefore,
      stateHashAfter: record.stateHashAfter
    });
    chain = nextChain;
    return { ...record, chainHash: nextChain };
  });
  return sealEventLifeState({ ...state, commandLog: records, hashChain: rechain ? chain : state.hashChain });
}
