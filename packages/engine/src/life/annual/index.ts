/**
 * P3-C 年度事件整合（schema `p3c-1`）。
 *
 * 公開入口（透過 `@life-sim/engine` barrel）：建立、年度交易、指令、存檔、重播與驗證。
 * **不從 barrel 匯出**：benchmark 專用入口、故障注入、偽造輔助（見 `./benchmark.ts`）。
 */
export { EventLifeError, guard as guardEventLife } from "./errors";
export {
  ANNUAL_EVENT_STAGES,
  resolveEventLifeYear,
  type AnnualEventStage,
  type AnnualEventTransactionResult
} from "./transaction";
export {
  applyEventLifeCommand,
  type EventLifeCommandResult
} from "./commands";
export {
  applyEffectOutcome,
  noEventOutcome,
  type EffectApplication,
  type EffectFacts
} from "./effects-adapter";
export {
  P3C_MAX_EVENT_DRAWS_PER_YEAR,
  P3C_RNG_DRAWS_AT_BIRTH,
  P3C_RNG_DRAWS_PER_YEAR,
  assertBindingShape,
  assertEventLifeApprovedVersions,
  assertEventLifeInvariants,
  assertEventLifeShape,
  assertEventRuleCommandLog,
  assertOccurrences,
  assertPackBinding,
  bindEventPack,
  computeEventYearDeltaHash,
  computeEventYearEntryHash,
  computeEventYearSnapshotHash,
  computeSelectionHash,
  createEventLifeState,
  deriveEventRngState,
  eventLifeProjection,
  eventLifeProjectionHash,
  isEventLifeState,
  occurrenceDigestOf,
  type P3CEventYearDeltaPayload,
  type P3CEventYearEntryPayload,
  type P3CEventYearSnapshotPayload,
  type P3CSelectionHashInput
} from "./state";
export { serializeEventLifeState, deserializeEventLifeState } from "./codec";
export {
  reconstructEventLifeState,
  verifyEventLifeReplay,
  verifyEventLifeState,
  type P3CEventReplayInput,
  type P3CEventReplayTrace,
  type P3CEventVerifyInput
} from "./replay";
