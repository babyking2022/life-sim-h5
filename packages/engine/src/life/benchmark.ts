/**
 * P3-A.4 內部 benchmark 入口。**不是公開契約，不從 `@life-sim/engine` barrel 匯出。**
 *
 * 為什麼需要它：公開 `createLifeState` 只接受核准的正式 ruleset／content，任何 `p3a-bench-*`
 * 或未知 ruleset 都會回 `E_P3A_VERSION`。效能／soak 需要 2,000～10,000 年的單一 ledger，
 * 因此改用**內部** benchmark ruleset（`p3a-bench-<years>`）與**內部**建立／驗證／序列化入口：
 * - 公開入口拿不到長壽命，也驗不了、存不了這種 state；
 * - 內部入口產生的 state 仍完全合法，可由同一個 bootstrap 從 genesis 重播驗證。
 *
 * 邊界：`packages/engine/src/index.ts` 不匯出本模組或這些內部函式；
 * `scripts/check-architecture.mjs` 檢查 production 套件不得 import 本模組；
 * `scripts/p3a-benchmark-isolation.mjs` 會實際 bundle 公開 engine，證明 bench／未知 ruleset 被拒。
 */
import type { P3ABootstrap, P3ALifeState, SerializedP3ALifeState, VersionTuple } from "@life-sim/contracts";
import {
  BENCHMARK_RULESET_PREFIX,
  createLifeStateForBenchmark,
  reconstructLifeStateForBenchmark,
  serializeLifeStateForBenchmark,
  resignLifeStateForTests,
  setYearFailureInjectionForTests,
  verifyLifeStateForBenchmark,
  type P3AReplayTrace
} from "./index";

export const BENCHMARK_MAX_LIFESPAN_YEARS = 100_000;

/** 把版本換成內部 benchmark ruleset。 */
export function benchmarkVersions(versions: VersionTuple, lifespanYears: number): VersionTuple {
  return { ...versions, rulesetVersion: `${BENCHMARK_RULESET_PREFIX}${lifespanYears}` };
}

/** 把 bootstrap 換成內部 benchmark ruleset（其餘欄位不動）。 */
export function benchmarkBootstrap(bootstrap: P3ABootstrap, lifespanYears: number): P3ABootstrap {
  return { ...bootstrap, versions: benchmarkVersions(bootstrap.versions, lifespanYears) };
}

/** 建立指定壽命的合法 state（benchmark／soak 專用）。 */
export function createBenchmarkLifeState(bootstrap: P3ABootstrap, lifespanYears: number): P3ALifeState {
  return createLifeStateForBenchmark(benchmarkBootstrap(bootstrap, lifespanYears));
}

/** 內部序列化（量測 state 大小用）；公開 `serializeLifeState` 會拒絕 benchmark ruleset。 */
export function serializeBenchmarkLifeState(state: P3ALifeState): SerializedP3ALifeState {
  return serializeLifeStateForBenchmark(state);
}

/** 內部重建／驗證（benchmark 專用）。 */
export function reconstructBenchmarkLifeState(input: { bootstrap: P3ABootstrap; targetYears: number; commandLog: P3ALifeState["commandLog"] }): P3AReplayTrace {
  return reconstructLifeStateForBenchmark(input);
}

export function verifyBenchmarkLifeState(bootstrap: P3ABootstrap, state: P3ALifeState): P3AReplayTrace {
  return verifyLifeStateForBenchmark(bootstrap, state);
}

/**
 * 讓「結算到指定年齡」的年度交易失敗一次（測試專用）。
 * 用來動態驗證年度結算失敗時的停止／elapsed／errorCode／phase／playback 行為。
 */
export function enableYearFailureInjection(age: number): void {
  setYearFailureInjectionForTests(age);
}

export function disableYearFailureInjection(): void {
  setYearFailureInjectionForTests(null);
}

/**
 * 測試專用：把改過的狀態重新封裝成自洽偽造狀態（含重算整條 hashChain 與 stateHash）。
 * 用來證明「重算所有相依 hash 的偽造」只有 genesis 重播能抓到。
 */
export function forgeRechainedLifeState(state: P3ALifeState): P3ALifeState {
  return resignLifeStateForTests(state, true);
}

/** 測試專用：只重算 stateHash（不重算 chain）。 */
export function forgeResealedLifeState(state: P3ALifeState): P3ALifeState {
  return resignLifeStateForTests(state, false);
}
