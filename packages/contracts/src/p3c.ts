/**
 * P3-C 年度事件權威整合契約（schema `p3c-1`）。
 *
 * 目的：把 P3-B 的「事件資料＋決定性抽選＋typed effects」真正接進**年度原子交易**，
 * 讓事件改變權威人生狀態，同時保住 P3-A 已驗收的所有性質（可重播、可驗證、O(1) 年度成本）。
 *
 * 版本策略（CTO 裁決：權威格式改變必須做正式版本升級）：
 * - `p3a-1` 是**已驗收的既有格式**，本批完全不改：沒有 `events` 欄位、hash domain 仍是 `v3`／`v1`。
 *   既有 P3-A golden（108 組）逐位元保留，不得重算。
 * - `p3c-1` 是**綁定事件 pack 的新格式**：多了權威 `events`（binding／contentMode／occurrences／rng），
 *   state／chain／log／snapshot／delta 全部換成新的 domain 字串。
 *   因此兩種 state 不可能被互相誤讀：`schemaVersion` 不符即 `E_P3C_VERSION`。
 *
 * 本檔只定義形狀、列舉、上限與固定錯誤碼；不讀檔、不驗證、不抽選。
 * 執行期規則在 `packages/engine/src/life/annual/**`。
 */

import type { MoneyString } from "./money";
import type {
  P3ACommandRecord,
  P3AHistoryMeta,
  P3AOrigin,
  P3APlaybackState,
  P3ARngCursor,
  P3AStats,
  P3AYearCard,
  P3AYearSnapshot
} from "./p3a";
import type { P3BEffect, P3BEventOccurrence } from "./p3b";
import type { VersionTuple } from "./versions";

/** 綁定事件 pack 的權威人生 schema。 */
export const P3C_SCHEMA_VERSION = "p3c-1" as const;
export type P3CSchemaVersion = typeof P3C_SCHEMA_VERSION;

/** 人生語意版本：P3-A 是 `1.0.1`；P3-C 多了一年一次的事件抽選與事件抉擇。 */
export const P3C_LIFE_SPEC_VERSION = "1.1.0" as const;
/** 內容版本：與 P3-A 的 `skeleton-1.0.1` 明確區隔（事件整合改變了年度語意）。 */
export const P3C_CONTENT_VERSION = "skeleton-1.1.0" as const;
/** 正式 ruleset 版本；公開入口只接受這一組。 */
export const P3C_RULESET_VERSION = "p3c-1.0.0" as const;
/** 存檔格式版本（`p3a-1` 是 3）。 */
export const P3C_SAVE_FORMAT_VERSION = 4 as const;

/** `selectionHash` canonical projection 的版本（獨立版號，方便日後升級）。 */
export const P3C_SELECTION_HASH_VERSION = "1.0.0" as const;

/** occurrence summary 的硬上限：與事件 pack 的事件數上限一致（CTO 裁決 4）。 */
export const P3C_MAX_OCCURRENCES = 4096;
/** 本階段 flags 上限維持 256（CTO 裁決 6）。 */
export const P3C_MAX_FLAGS = 256;
/** 單一 `count` 的合理上限（不得超過已結算年度數，另有語意檢查）。 */
export const P3C_MAX_OCCURRENCE_COUNT = 1_000_000;

export const P3C_EVENT_SCHEMA_VERSION = "p3b-1" as const;
export const P3C_EVENT_SPEC_VERSION = "1.0.0" as const;

/**
 * 年度事件抽選的內容模式預設值。
 * `contentMode` 進權威 state（`events.contentMode`），因此重播不需要額外參數。
 */
export const P3C_DEFAULT_CONTENT_MODE = "standard" as const;

/**
 * 事件 pack 的權威綁定（建立人生時寫入，進 `stateHash` projection）。
 * 任何一欄與實際 pack 不符 → `E_P3C_PACK`（重播時也會被抓到）。
 */
export interface P3CEventPackBinding {
  readonly eventSchemaVersion: string;
  readonly eventSpecVersion: string;
  readonly contentPackVersion: string;
  readonly eventPackId: string;
  /** `validateEventPack` 算出的 `packChecksum`，覆蓋 manifest 全部欄位。 */
  readonly eventPackChecksum: string;
  /** `sha256(canonicalBytes(events))`，覆蓋事件的每一個欄位。 */
  readonly datasetChecksum: string;
  /** pack 內事件數；occurrence 數量上限的來源之一。 */
  readonly eventCount: number;
}

/** 事件 RNG 的獨立游標（domain 固定 `events`）。 */
export interface P3CEventRngCursor {
  readonly domain: "events";
  /**
   * **權威**的 genesis 事件 RNG（P3-C.1）。
   * 建立人生時等於 `deriveEventRngState(bootstrap.rngState, birthYear)`，
   * 之後**永遠不變**；年度交易只能更新 `state` 與 `draws`。
   * 進 projection／stateHash／序列化／replay，並讓 ledger 的第一筆 `rngStateBefore` 可以被驗證。
   */
  readonly initialState: readonly [number, number, number, number];
  /** 目前的事件 RNG 游標。 */
  readonly state: readonly [number, number, number, number];
  /** 累計消耗的 u32 抽樣數（0／2×嘗試次數）。純稽核用，由重播重新推導。 */
  readonly draws: number;
}

/**
 * 權威事件摘要（放進 P3-A 風格的權威 state）。
 * - `occurrences` 依 `eventId` 升冪、不得重複，長度 ≤ min(4096, pack 事件數, 已結算年度數)。
 * - `rng` 是事件專用游標：**不與人生 RNG 共用**，因此 P3-A 的 `rngDraws = initial + 4×age`
 *   會計完全不變（年度指令紀錄仍然可被同一條公式驗證）。
 * - `rng.initialState` 是 genesis 事件 RNG（P3-C.1），讓 ledger 的第一筆 `rngStateBefore`
 *   可以綁回權威 state，而不是只靠「相鄰兩筆串得上」。
 */
export interface P3CEventsState {
  readonly binding: P3CEventPackBinding;
  readonly contentMode: "standard" | "guardian";
  readonly occurrences: readonly P3BEventOccurrence[];
  readonly rng: P3CEventRngCursor;
}

/** 事件抉擇的選項：`effects` 已由 validated pack 深凍結複製進來，因此 CONFIRM 不需要再讀 pack。 */
export interface P3CEventDecisionOption {
  readonly optionId: string;
  readonly label: string;
  readonly effects: readonly P3BEffect[];
}

/**
 * 權威 pending decision（事件版）。
 * 必要欄位（CTO 裁決）：`eventId`、`decisionId`、合法 `options`、`selectionHash`、`year`。
 */
export interface P3CEventPendingDecision {
  readonly decisionId: string;
  readonly year: number;
  readonly prompt: string;
  readonly options: readonly P3CEventDecisionOption[];
  readonly selectedOptionId: string | null;
  /**
   * 產生這個抉擇的來源：
   * - `event` 是事件 pack 的 decision 事件（`eventId` 為真實 eventId、`selectionHash` 綁那一年抽選）。
   * - `skeleton` 是 P3-A 的抉擇年齡（6／12／18）補位，`eventId` 是 `skeleton.decision.<age>` sentinel，
   *   `selectionHash`／`occurrenceDigestBefore` 是 64 個 0。
   */
  readonly source: "event" | "skeleton";
  readonly eventId: string;
  /** 產生這個抉擇的年度 selectionHash（把抉擇綁回那一年的事件抽選）。 */
  readonly selectionHash: string;
  /** 該年度抽選前的 occurrence digest。 */
  readonly occurrenceDigestBefore: string;
}

/**
 * 一年的事件稽核紀錄：寫進年度 delta、進 `deltaHash`、由 application ledger 保存。
 * `outcome` 是「事件本身 effects」的增量；抉擇 option 的 effects 只在 CONFIRM 套用一次，
 * 由 commandLog 的 `stateHashBefore/After` 與 genesis 重播共同約束。
 */
export interface P3CYearEventOutcome {
  readonly statDelta: P3AStats;
  readonly moneyDelta: {
    readonly balanceMicroUsd: MoneyString;
    readonly annualIncomeMicroUsd: MoneyString;
    readonly annualExpenseMicroUsd: MoneyString;
  };
  readonly flagsAdded: readonly string[];
  readonly flagsRemoved: readonly string[];
  readonly informational: boolean;
  readonly openedDecisionId: string | null;
}

export interface P3CYearEventRecord {
  readonly eventId: string | null;
  /**
   * - `no_candidates`：有候選機制但當年度 0 候選（0 draws）。
   * - `single_candidate`：恰好 1 個候選（0 draws）。
   * - `weighted`：≥2 候選，加權抽選（drawsUsed = 2×嘗試次數）。
   * - `age_out_of_range`：年齡超過事件契約上限 `P3B_MAX_AGE`（120），事件資料不涵蓋，
   *   因此固定無候選、0 draws、RNG 不動（只可能出現在 benchmark／超長壽命）。
   */
  readonly reason: "no_candidates" | "single_candidate" | "weighted" | "age_out_of_range";
  readonly drawsUsed: number;
  readonly rngStateBefore: readonly [number, number, number, number];
  readonly rngStateAfter: readonly [number, number, number, number];
  readonly selectionHash: string;
  readonly occurrenceDigestBefore: string;
  readonly occurrenceDigestAfter: string;
  readonly candidateCount: number;
  /** 候選權重總和（十進位字串，BigInt）。 */
  readonly totalWeight: string;
  readonly outcome: P3CYearEventOutcome;
}

/** 年度增量（事件版）：entry／snapshot／card／event 全部被 `deltaHash` 覆蓋。 */
export interface P3CYearDelta {
  readonly year: number;
  readonly age: number;
  readonly card: P3AYearCard;
  readonly logEntry: {
    readonly seq: number;
    readonly year: number;
    readonly age: number;
    readonly entryId: string;
    readonly summary: string;
    readonly entryHash: string;
  };
  readonly snapshot: P3AYearSnapshot;
  readonly event: P3CYearEventRecord;
  readonly deltaHash: string;
}

/** 權威人生狀態（事件版）。 */
export interface P3CLifeState {
  readonly schemaVersion: P3CSchemaVersion;
  readonly lifeSpecVersion: string;
  readonly versions: VersionTuple;
  readonly origin: P3AOrigin;
  readonly birthYear: number;
  readonly currentYear: number;
  readonly age: number;
  readonly phase: "life" | "pending_decision" | "death" | "error";
  readonly errorCode: string | null;
  readonly lifespanYears: number;
  readonly paceLifeYearsX10: number;
  readonly stats: P3AStats;
  readonly assets: {
    readonly balanceMicroUsd: bigint;
    readonly annualIncomeMicroUsd: bigint;
    readonly annualExpenseMicroUsd: bigint;
  };
  readonly flags: readonly string[];
  readonly rng: P3ARngCursor;
  readonly events: P3CEventsState;
  readonly pendingDecision: P3CEventPendingDecision | null;
  readonly history: P3AHistoryMeta;
  readonly commandLog: readonly P3ACommandRecord[];
  readonly stateHash: string;
  readonly hashChain: string;
  readonly playback: P3APlaybackState;
}

/** 存檔邊界：金錢以十進位字串表示。 */
export interface SerializedP3CLifeState {
  readonly schemaVersion: string;
  readonly lifeSpecVersion: string;
  readonly versions: VersionTuple;
  readonly origin: P3AOrigin;
  readonly birthYear: number;
  readonly currentYear: number;
  readonly age: number;
  readonly phase: "life" | "pending_decision" | "death" | "error";
  readonly errorCode: string | null;
  readonly lifespanYears: number;
  readonly paceLifeYearsX10: number;
  readonly stats: P3AStats;
  readonly assets: {
    readonly balanceMicroUsd: MoneyString;
    readonly annualIncomeMicroUsd: MoneyString;
    readonly annualExpenseMicroUsd: MoneyString;
  };
  readonly flags: readonly string[];
  readonly rng: P3ARngCursor;
  readonly events: {
    readonly binding: P3CEventPackBinding;
    readonly contentMode: "standard" | "guardian";
    readonly occurrences: readonly P3BEventOccurrence[];
    readonly rng: P3CEventRngCursor;
  };
  readonly pendingDecision: P3CEventPendingDecision | null;
  readonly history: P3AHistoryMeta;
  readonly commandLog: readonly P3ACommandRecord[];
  readonly stateHash: string;
  readonly hashChain: string;
  readonly playback: P3APlaybackState;
}

/** 固定錯誤碼（17 個）；不得再從公開入口外洩原生例外。 */
export type P3CErrorCode =
  | "E_P3C_TYPE"
  | "E_P3C_VERSION"
  | "E_P3C_ARGUMENT"
  | "E_P3C_PHASE"
  | "E_P3C_STATE"
  | "E_P3C_HASH"
  | "E_P3C_HISTORY"
  | "E_P3C_RNG"
  | "E_P3C_EFFECT"
  | "E_P3C_DECISION"
  | "E_P3C_PACK"
  | "E_P3C_SELECTION"
  | "E_P3C_OCCURRENCE"
  | "E_P3C_MONEY"
  | "E_P3C_PACE"
  | "E_P3C_SPEED"
  | "E_P3C_CERTIFICATE";

export const P3C_ERROR_CODES: readonly P3CErrorCode[] = [
  "E_P3C_TYPE",
  "E_P3C_VERSION",
  "E_P3C_ARGUMENT",
  "E_P3C_PHASE",
  "E_P3C_STATE",
  "E_P3C_HASH",
  "E_P3C_HISTORY",
  "E_P3C_RNG",
  "E_P3C_EFFECT",
  "E_P3C_DECISION",
  "E_P3C_PACK",
  "E_P3C_SELECTION",
  "E_P3C_OCCURRENCE",
  "E_P3C_MONEY",
  "E_P3C_PACE",
  "E_P3C_SPEED",
  "E_P3C_CERTIFICATE"
];
