/**
 * 公開 barrel。
 *
 * 刻意**不**匯出：
 * - `createLifeStateWithLifespan`（任意壽命只給 benchmark 用）
 * - `setYearFailureInjectionForTests`（年度失敗注入只給測試用）
 * - `./life/benchmark`
 * - P3-C 的 `./life/annual/benchmark`（任意壽命、故障注入、偽造輔助一律不外流）
 * 這樣正式出生、存檔、重播與 production bundle 都無法傳入任意壽命或注入故障。
 */
export * from "./bytes";
export * from "./canonical/canonical";
export * from "./money";
export * from "./p1b";
export {
  LifeError,
  computeYearDurationMs,
  computeYearEntryHash,
  computeYearSnapshotHash,
  computeYearDeltaHash,
  assertLifeStateShape,
  assertLifeStateInvariants,
  assertRuleCommandLog,
  assertLifeStateHash,
  computeLifeStateHash,
  createLifeState,
  resolveLifeYear,
  resolveYear,
  applyLifeCommand,
  serializeLifeState,
  deserializeLifeState,
  reconstructLifeState,
  replayLifeState,
  verifyLifeReplay,
  verifyLifeState
} from "./life";
export type {
  LifeErrorDetails,
  P3AReplayTrace,
  P3AYearEntryPayload,
  P3AYearSnapshotPayload,
  P3AYearDeltaPayload
} from "./life";
export * from "./life/events";
export {
  EventLifeError,
  ANNUAL_EVENT_STAGES,
  resolveEventLifeYear,
  applyEventLifeCommand,
  applyEffectOutcome,
  noEventOutcome,
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
  serializeEventLifeState,
  deserializeEventLifeState,
  reconstructEventLifeState,
  verifyEventLifeReplay,
  verifyEventLifeState
} from "./life/annual";
export type {
  AnnualEventStage,
  AnnualEventTransactionResult,
  EffectApplication,
  EffectFacts,
  EventLifeCommandResult,
  P3CEventReplayInput,
  P3CEventReplayTrace,
  P3CEventVerifyInput,
  P3CEventYearDeltaPayload,
  P3CEventYearEntryPayload,
  P3CEventYearSnapshotPayload,
  P3CSelectionHashInput
} from "./life/annual";
export * from "./rng/seed";
export * from "./rng/sha256";
export * from "./rng/xoshiro128";
