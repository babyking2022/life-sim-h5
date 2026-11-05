/**
 * P3-A.3 人生核心狀態契約（schema `p3a-1`，修正版）。
 *
 * - 時間：paceMinutes 30／60／90；yearDurationMs 由出生證書的 paceLifeYearsX10 以整數計算。
 * - 四狀態 0–100；金錢唯一權威單位 PPP_USD_MICRO（BigInt，只接受 bigint）。
 * - 歷史（log／snapshot／cards）不放進 state；engine 回傳 year delta，由 application 的 append-only ledger 保存。
 * - state 只保存固定大小的歷史摘要（筆數、三個 rolling head、卡片總數、初始 hash）。
 * - stateHash 是完整 authoritative gameplay projection hash（不含 playback／commandLog／hashChain／歷史陣列）。
 * - commandLog 是重播的唯一權威；每一個權威狀態都必須能由 bootstrap ＋ commandLog 精確重建。
 * - 正式的 `P3ABootstrap` 不接受任何「任意壽命」參數；benchmark 專用的建構入口不在公開 barrel 內。
 */

import type { MoneyString } from "./money";
import type { VersionTuple } from "./versions";

export const P3A_SCHEMA_VERSION = "p3a-1" as const;
export type P3ASchemaVersion = typeof P3A_SCHEMA_VERSION;
export const P3A_LIFE_SPEC_VERSION = "1.0.1" as const;
export const P3A_CONTENT_VERSION = "skeleton-1.0.1" as const;
/** 正式 ruleset 版本；公開入口只接受這一組（＋固定 rngSpec／saveFormat）。 */
export const P3A_RULESET_VERSION = "p3a-1.0.1" as const;

export const P3A_MAX_DELTA_MS = 1000;
export const P3A_STAT_MAX = 100;
export const P3A_FAST_FORWARD_MAX_YEARS = 20;
export const P3A_DECISION_AGES: readonly number[] = [6, 12, 18];
export const P3A_PACE_MINUTES = [30, 60, 90] as const;
export type P3APaceMinutes = (typeof P3A_PACE_MINUTES)[number];
export const P3A_YEAR_MS_MIN = 10_000;
export const P3A_YEAR_MS_MAX = 120_000;
/** 歷史摘要的零值 head：沒有任何年度紀錄時使用。 */
export const P3A_EMPTY_HISTORY_HASH = "0".repeat(64);

export const P3A_SPEEDS = [1, 2, 4, 8, 12, 16] as const;
export type P3ASpeed = (typeof P3A_SPEEDS)[number];

export type P3APhase = "life" | "pending_decision" | "death" | "error";
export type P3ACommandType = "TICK" | "NEXT" | "SELECT_DECISION" | "FAST_FORWARD_STEP" | "SET_PLAYBACK";
/**
 * 會被寫進權威 commandLog 的規則指令。
 * SELECT_DECISION 只記錄「選了哪一個」；CONFIRM_DECISION 才套用效果。
 * 兩者都是權威狀態轉移，因此「已選、未確認」也是一個可重建的合法狀態。
 */
export type P3ARuleCommandType = "SELECT_DECISION" | "CONFIRM_DECISION";

export interface P3AStats {
  readonly health: number;
  readonly happiness: number;
  readonly knowledge: number;
  readonly relationships: number;
}

/** 唯一權威貨幣：PPP 美元 micro 單位；runtime 只接受 bigint。 */
export interface P3AAssets {
  readonly balanceMicroUsd: bigint;
  readonly annualIncomeMicroUsd: bigint;
  readonly annualExpenseMicroUsd: bigint;
}

export interface P3ARngCursor {
  readonly domain: "life";
  readonly state: readonly [number, number, number, number];
  readonly draws: number;
}

export interface P3AOrigin {
  readonly certificateHash: string;
  readonly certificateId: string;
  readonly playerIdentityHash: string;
  readonly masterSeedHash: string;
  readonly basePackId: string;
  readonly basePackChecksum: string;
  readonly identityPackId: string;
  readonly identityPackChecksum: string;
}

/**
 * 正式 genesis 輸入。**不得**包含任意壽命欄位；壽命一律由 RNG 規則（60–100）決定。
 * 任何多帶的 `lifespanYears` 都會被 `E_P3A_ARGUMENT` 拒絕。
 */
export interface P3ABootstrap {
  readonly versions: VersionTuple;
  readonly origin: P3AOrigin;
  readonly birthYear: number;
  readonly paceLifeYearsX10: number;
  readonly rngState: readonly [number, number, number, number];
}

export interface P3ADecisionOption {
  readonly optionId: string;
  readonly label: string;
}
export interface P3APendingDecision {
  readonly decisionId: string;
  readonly year: number;
  readonly prompt: string;
  readonly options: readonly P3ADecisionOption[];
  readonly selectedOptionId: string | null;
}

/**
 * 固定大小的歷史摘要：不得保存逐年陣列。
 * - `yearsRecorded`：已完成的年度交易筆數（= age）。
 * - `cardsTotal`：已產生的卡片總數（含出生卡），由 engine 依實際 delta 累計，不由年份猜測。
 * - `lastEntryHash`／`lastSnapshotHash`／`lastDeltaHash`：ledger 的 rolling head；
 *   `lastDeltaHash` 覆蓋整筆 year delta（entry ＋ snapshot ＋ card），是卡片防篡改的依據。
 * - `initialStateHash`：建立時的 stateHash；由 bootstrap 重播時必須重新推導驗證。
 */
export interface P3AHistoryMeta {
  readonly yearsRecorded: number;
  readonly cardsTotal: number;
  readonly lastEntryHash: string;
  readonly lastSnapshotHash: string;
  readonly lastDeltaHash: string;
  readonly initialStateHash: string;
}

export interface P3AYearCard {
  readonly cardId: string;
  readonly year: number;
  readonly kind: "summary" | "decision" | "milestone";
  readonly title: string;
}
export interface P3ALifeLogEntry {
  readonly seq: number;
  readonly year: number;
  readonly age: number;
  readonly entryId: string;
  readonly summary: string;
  readonly entryHash: string;
}
export interface P3AYearSnapshot {
  readonly year: number;
  readonly age: number;
  readonly stats: P3AStats;
  readonly balanceMicroUsd: string;
  readonly phase: P3APhase;
  readonly snapshotHash: string;
}
/** resolveYear 回傳的年度增量；由 application ledger 保存，不進 state。 */
export interface P3AYearDelta {
  readonly year: number;
  readonly age: number;
  readonly card: P3AYearCard;
  readonly logEntry: P3ALifeLogEntry;
  readonly snapshot: P3AYearSnapshot;
  /** 覆蓋 entry＋snapshot＋card 的 rolling hash；與 `history.lastDeltaHash` 綁定。 */
  readonly deltaHash: string;
}

/**
 * 規則指令紀錄。`stateHashBefore` 是指令前的 stateHash，`stateHashAfter` 是指令生效後的 stateHash；
 * 狀態確實改變時兩者必須不同，且下一筆的 `stateHashBefore` 必須等於上一筆的 `stateHashAfter`。
 * `chainHash` 逐筆串接上一個 head。
 */
export interface P3ACommandRecord {
  readonly seq: number;
  readonly commandType: P3ARuleCommandType;
  readonly payload: string;
  readonly argsHash: string;
  readonly atYear: number;
  readonly effectiveYear: number;
  readonly auto: boolean;
  readonly policyId: string | null;
  readonly rngState: readonly [number, number, number, number];
  readonly rngDraws: number;
  readonly stateHashBefore: string;
  readonly stateHashAfter: string;
  readonly chainHash: string;
}

/** ADR-001：主要播放模式只有三種；背景隱藏由獨立的 visibility 表示。 */
export type P3APlaybackMode = "playing" | "paused" | "fast_forward";
export type P3AVisibility = "visible" | "hidden";
export interface P3APlaybackState {
  readonly mode: P3APlaybackMode;
  readonly visibility: P3AVisibility;
  /** 由 hidden 恢復時要回到的模式（playing／paused）。 */
  readonly previousMode: "playing" | "paused";
  readonly speed: P3ASpeed;
  readonly paceMinutes: P3APaceMinutes;
  readonly yearDurationMs: number;
  readonly elapsedInYearMs: number;
  readonly cardsSeen: number;
}

export interface P3ALifeState {
  readonly schemaVersion: P3ASchemaVersion;
  readonly lifeSpecVersion: string;
  readonly versions: VersionTuple;
  readonly origin: P3AOrigin;
  readonly birthYear: number;
  readonly currentYear: number;
  readonly age: number;
  readonly phase: P3APhase;
  readonly errorCode: string | null;
  readonly lifespanYears: number;
  readonly paceLifeYearsX10: number;
  readonly stats: P3AStats;
  readonly assets: P3AAssets;
  readonly flags: readonly string[];
  readonly rng: P3ARngCursor;
  readonly pendingDecision: P3APendingDecision | null;
  readonly history: P3AHistoryMeta;
  readonly commandLog: readonly P3ACommandRecord[];
  readonly stateHash: string;
  readonly hashChain: string;
  readonly playback: P3APlaybackState;
}

export type P3ACommand =
  | { readonly type: "TICK"; readonly deltaMs: number }
  | { readonly type: "NEXT" }
  | { readonly type: "SELECT_DECISION"; readonly optionId: string }
  | { readonly type: "FAST_FORWARD_STEP"; readonly maxYears?: number }
  | { readonly type: "SET_PLAYBACK"; readonly speed?: number; readonly paused?: boolean; readonly hidden?: boolean; readonly paceMinutes?: number };

export interface SerializedP3ALifeState {
  readonly schemaVersion: string;
  readonly lifeSpecVersion: string;
  readonly versions: VersionTuple;
  readonly origin: P3AOrigin;
  readonly birthYear: number;
  readonly currentYear: number;
  readonly age: number;
  readonly phase: P3APhase;
  readonly errorCode: string | null;
  readonly lifespanYears: number;
  readonly paceLifeYearsX10: number;
  readonly stats: P3AStats;
  readonly assets: { balanceMicroUsd: MoneyString; annualIncomeMicroUsd: MoneyString; annualExpenseMicroUsd: MoneyString };
  readonly flags: readonly string[];
  readonly rng: P3ARngCursor;
  readonly pendingDecision: P3APendingDecision | null;
  readonly history: P3AHistoryMeta;
  readonly commandLog: readonly P3ACommandRecord[];
  readonly stateHash: string;
  readonly hashChain: string;
  readonly playback: P3APlaybackState;
}

/**
 * 重建輸入：bootstrap ＋ 目標年份 ＋ commandLog（唯一權威）。
 * 重建只負責「產生狀態」；要證明狀態沒被偽造，必須用 `verifyLifeReplay`／`verifyLifeState`（從 genesis 實際重播比對）。
 */
export interface P3AReconstructInput {
  readonly bootstrap: P3ABootstrap;
  readonly targetYears: number;
  readonly commandLog: readonly P3ACommandRecord[];
}

/**
 * 驗證輸入：targetState 必填。
 * engine 會先完整驗證 targetState，再從 genesis 重播並逐欄比對所有權威欄位（playback 除外，見契約）。
 */
export interface P3AVerifyInput {
  readonly bootstrap: P3ABootstrap;
  readonly targetState: P3ALifeState;
  /** 選填；若提供必須等於 `targetState.commandLog`。 */
  readonly commandLog?: readonly P3ACommandRecord[];
}

export type P3AErrorCode =
  | "E_P3A_TYPE"
  | "E_P3A_VERSION"
  | "E_P3A_ARGUMENT"
  | "E_P3A_PHASE"
  | "E_P3A_STATE"
  | "E_P3A_DELTA"
  | "E_P3A_SPEED"
  | "E_P3A_PACE"
  | "E_P3A_YEAR"
  | "E_P3A_RNG"
  | "E_P3A_CERTIFICATE"
  | "E_P3A_MAX_YEARS"
  | "E_P3A_MONEY"
  | "E_P3A_HASH"
  | "E_P3A_HISTORY";

export const P3A_ERROR_CODES: readonly P3AErrorCode[] = [
  "E_P3A_TYPE", "E_P3A_VERSION", "E_P3A_ARGUMENT", "E_P3A_PHASE", "E_P3A_STATE", "E_P3A_DELTA",
  "E_P3A_SPEED", "E_P3A_PACE", "E_P3A_YEAR", "E_P3A_RNG", "E_P3A_CERTIFICATE", "E_P3A_MAX_YEARS",
  "E_P3A_MONEY", "E_P3A_HASH", "E_P3A_HISTORY"
];
