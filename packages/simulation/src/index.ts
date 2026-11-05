/**
 * `@life-sim/simulation` 公開 barrel（P3-E.1a-1.1 ＋ P3-E.1a-2a ＋ P3-E.1b-2l）。
 *
 * 本批公開：
 * - `P3EError`／`isP3EError`；
 * - P3-E 的版本常數、錯誤碼與核心型別（全部來自 contracts）；
 * - `P3E_STAT_MIN`／`P3E_STAT_MAX`（P3-E.1a-2a：roll 與 state 不變量的 stat 邊界）；
 * - `createP3EGenesis`／`executeP3ECommand` 與其輸入／輸出型別（P3-E.1b-2l：
 *   最小可玩公開 façade，供 application 使用）。
 *
 * **沒有** roll／stateHash／codec／replay 入口，也**沒有** Record 建立器、
 * Transition Material、Ledger Continuity／Append／Codec 等內部原語；
 * 內部模組（如 `src/rng.ts` 的 `createP3EGenesisRng`）刻意**不**從這裡匯出。
 */
export { P3EError, isP3EError } from "./errors";

export {
  P3E_COMMAND_INIT_DOMAIN,
  P3E_CONTENT_VERSION,
  P3E_DEATH_DOMAIN,
  P3E_DEATH_DRAWS_ALIVE,
  P3E_DEATH_DRAWS_DIED,
  P3E_ENGINE_VERSION,
  P3E_ERROR_CODES,
  P3E_EVENT_DOMAIN,
  P3E_EXPENSE_BASE_MICRO_USD,
  P3E_EXPENSE_PER_YEAR_MICRO_USD,
  P3E_GENESIS_SEMANTIC_DRAWS,
  P3E_INCOME_BASE_MICRO_USD,
  P3E_INCOME_PER_YEAR_MICRO_USD,
  P3E_LIFESPAN_BURN_BOUND,
  P3E_LIFE_DOMAIN,
  P3E_LIFE_SPEC_VERSION,
  P3E_MAX_AGE,
  P3E_MAX_COMMANDS,
  P3E_MAX_FLAGS,
  P3E_MAX_OCCURRENCES,
  P3E_MAX_U32_DRAWS_PER_DEATH_YEAR,
  P3E_MAX_U32_DRAWS_PER_EVENT,
  P3E_MIN_AGE,
  P3E_PHASES,
  P3E_RNG_SPEC_VERSION,
  P3E_ROLL_SEMANTIC_DRAWS,
  P3E_ROLL_SPEC_VERSION,
  P3E_ROLL_STEPS,
  P3E_RULESET_VERSION,
  P3E_SAVE_FORMAT_VERSION,
  P3E_SCHEMA_VERSION,
  P3E_SEXES,
  P3E_STAT_MAX,
  P3E_STAT_MIN
} from "@life-sim/contracts";

export type {
  P3EAssets,
  P3ECommandSummary,
  P3EContentVersion,
  P3EDeathDomain,
  P3EDeathPackBinding,
  P3EDeathRngState,
  P3EEngineVersion,
  P3EErrorCode,
  P3EEventDomain,
  P3EEventOccurrence,
  P3EEventPackBinding,
  P3EEventRngState,
  P3EHex64,
  P3EHistoryHeads,
  P3EIdentityBinding,
  P3ELifeDomain,
  P3ELifeRngState,
  P3ELifeSpecVersion,
  P3ELifeState,
  P3EPackBindings,
  P3EPendingDecisionSummary,
  P3EPhase,
  P3ERngSpecVersion,
  P3ERngState,
  P3ERollInput,
  P3ERollResult,
  P3ERollSpecVersion,
  P3ERulesetVersion,
  P3ESaveFormatVersion,
  P3ESchemaVersion,
  P3ESex,
  P3EStats,
  P3EU32RngState,
  P3EWordTuple
} from "@life-sim/contracts";

/**
 * P3-E.1b-2l／2m／2r／2t：最小可玩公開 façade
 * （H5-CTO-166-A；173-A outcome 型別；181-A history 建立／append；183-A
 * Session Payload Codec 與 Ledger Replay）。
 *
 * 公開入口：`createP3EGenesis`／`executeP3ECommand`／`createP3ELedgerHistory`／
 * `appendP3ELedgerHistory`／`encodeP3ESessionPayload`／`decodeP3ESessionPayload`／
 * `replayP3ELedgerHistory`，兩個 payload 常數，以及 9 個型別。
 *
 * State Hash 原語、Record 建立器、Transition Material、Ledger Continuity、
 * Ledger Append、State／Pair Codec、`readP3ELedgerHistory` 與任何測試／候選入口
 * **不**從這裡公開。
 */
export { createP3EGenesis, type P3EGenesisInput } from "./genesis";
export {
  executeP3ECommand,
  type P3ECommandExecutionResult,
  type P3ECommandOutcome,
  type P3EAdvanceYearOutcome,
  type P3EChooseDecisionOutcome
} from "./command-executor";
export {
  appendP3ELedgerHistory,
  createP3ELedgerHistory,
  type P3ELedgerHistory
} from "./ledger-history";
export {
  P3E_SESSION_PAYLOAD_FORMAT_VERSION,
  P3E_SESSION_PAYLOAD_MAX_LENGTH,
  decodeP3ESessionPayload,
  encodeP3ESessionPayload,
  type P3ESessionPayloadV1
} from "./p3e-session-payload-codec";
export {
  P3EReplayDivergenceError,
  replayP3ELedgerHistory,
  type P3EReplayDivergenceDetail,
  type P3EReplayResult
} from "./p3e-replay";
