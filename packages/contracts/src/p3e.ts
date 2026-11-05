import type { P3CEventPackBinding } from "./p3c";

/**
 * P3-E 契約（schema `p3e-2`）—— P3-E.1b-1f-0 起：`pendingDecision` 摘要 ＋ save format 6。
 *
 * 本檔仍然**沒有任何函式**（只有常數與型別）；genesis／roll／stateHash／年度交易
 * 屬 P3-E.1a-2 之後。
 *
 * 1.1 的六項修正（H5-CTO-044）：
 * 1. `P3EIdentityBinding.playerIdentityHash`（對應 `certificate.player.identityHash`）；
 * 2. 事件包綁定改成 **P3-C 權威形狀**（直接重用 `P3CEventPackBinding`）；
 * 3. 死亡包綁定補齊 P3-D manifest 的 11 個欄位；
 * 4. 版本欄位全部改成 literal type，並新增 engine／rngSpec 版本；
 * 5. 三條 RNG 的 domain 全部 literal（event 固定 `"events"`）；
 * 6. `P3EError` 改用 WeakSet 私有品牌（見 `packages/simulation/src/errors.ts`）。
 */

/* ------------------------------------------------------------------ */
/* 一、固定版本（literal types）                                       */
/* ------------------------------------------------------------------ */

export const P3E_SCHEMA_VERSION = "p3e-2" as const;
export const P3E_RULESET_VERSION = "p3e-1.0.0" as const;
export const P3E_ROLL_SPEC_VERSION = "p3e-roll-1.0.0" as const;
export const P3E_LIFE_SPEC_VERSION = "1.0.0" as const;
/**
 * P3-E 的**整合內容版本**，不是事件包的 `contentPackVersion`。
 * 現有 P3-C fixture 的 `contentPackVersion` 是 `1.0.0`，兩者不得互相比對
 * （事件包的版本資訊一律走 `P3EEventPackBinding`）。
 */
export const P3E_CONTENT_VERSION = "skeleton-1.2.0" as const;
/** P3-E 的存檔格式；**不得**與 `p3c-1` 的 4 混用。 */
export const P3E_SAVE_FORMAT_VERSION = 6 as const;
export const P3E_ENGINE_VERSION = "0.1.0" as const;
export const P3E_RNG_SPEC_VERSION = "1.0.0" as const;

export type P3ESchemaVersion = typeof P3E_SCHEMA_VERSION;
export type P3ERulesetVersion = typeof P3E_RULESET_VERSION;
export type P3ERollSpecVersion = typeof P3E_ROLL_SPEC_VERSION;
export type P3ELifeSpecVersion = typeof P3E_LIFE_SPEC_VERSION;
export type P3EContentVersion = typeof P3E_CONTENT_VERSION;
export type P3ESaveFormatVersion = typeof P3E_SAVE_FORMAT_VERSION;
export type P3EEngineVersion = typeof P3E_ENGINE_VERSION;
export type P3ERngSpecVersion = typeof P3E_RNG_SPEC_VERSION;

export const P3E_MAX_AGE = 120;
export const P3E_MIN_AGE = 0;

/**
 * 四狀態（health／happiness／knowledge／relationships）的合法範圍。
 *
 * `p3e-roll-1.0.0` 每年抽樣後一律 clamp 到 `P3E_STAT_MIN..P3E_STAT_MAX`；
 * 這兩個常數是 roll／state 不變量共用的唯一邊界（不得另外寫 `0`／`100` 字面值）。
 */
export const P3E_STAT_MIN = 0;
export const P3E_STAT_MAX = 100;

/** 64 位小寫十六進位（stateHash 與所有 head 的型別語意）。 */
export type P3EHex64 = string;

export type P3ESex = "female" | "male";
export const P3E_SEXES: readonly P3ESex[] = ["female", "male"];

export type P3EPhase = "life" | "pending_decision" | "death";
export const P3E_PHASES: readonly P3EPhase[] = ["life", "pending_decision", "death"];

/* ------------------------------------------------------------------ */
/* 二、22 個固定錯誤碼（順序固定，不得重排）                            */
/* ------------------------------------------------------------------ */

export type P3EErrorCode =
  | "E_P3E_TYPE"
  | "E_P3E_ARGUMENT"
  | "E_P3E_VERSION"
  | "E_P3E_CERTIFICATE"
  | "E_P3E_IDENTITY"
  | "E_P3E_EVENT_PACK"
  | "E_P3E_DEATH_PACK"
  | "E_P3E_BINDING"
  | "E_P3E_RNG"
  | "E_P3E_ROLL"
  | "E_P3E_STATE"
  | "E_P3E_HASH"
  | "E_P3E_PHASE"
  | "E_P3E_MONEY"
  | "E_P3E_EVENT"
  | "E_P3E_EFFECT"
  | "E_P3E_DECISION"
  | "E_P3E_DEATH"
  | "E_P3E_HISTORY"
  | "E_P3E_COMMAND"
  | "E_P3E_CODEC"
  | "E_P3E_REPLAY";

export const P3E_ERROR_CODES: readonly P3EErrorCode[] = [
  "E_P3E_TYPE",
  "E_P3E_ARGUMENT",
  "E_P3E_VERSION",
  "E_P3E_CERTIFICATE",
  "E_P3E_IDENTITY",
  "E_P3E_EVENT_PACK",
  "E_P3E_DEATH_PACK",
  "E_P3E_BINDING",
  "E_P3E_RNG",
  "E_P3E_ROLL",
  "E_P3E_STATE",
  "E_P3E_HASH",
  "E_P3E_PHASE",
  "E_P3E_MONEY",
  "E_P3E_EVENT",
  "E_P3E_EFFECT",
  "E_P3E_DECISION",
  "E_P3E_DEATH",
  "E_P3E_HISTORY",
  "E_P3E_COMMAND",
  "E_P3E_CODEC",
  "E_P3E_REPLAY"
];

/* ------------------------------------------------------------------ */
/* 三、RNG（domain 全部 literal，event/death 不可互換）                 */
/* ------------------------------------------------------------------ */

export type P3EWordTuple = readonly [number, number, number, number];

/** 與 P3-A／P3-C 相同的 life domain（compatibility burn 只為了對齊游標）。 */
export const P3E_LIFE_DOMAIN = "life" as const;
/** 與 P3-C 相同的事件 domain。 */
export const P3E_EVENT_DOMAIN = "events" as const;
/** death RNG 的 P3-E 專屬 domain。 */
export const P3E_DEATH_DOMAIN = "p3e/death" as const;

export type P3ELifeDomain = typeof P3E_LIFE_DOMAIN;
export type P3EEventDomain = typeof P3E_EVENT_DOMAIN;
export type P3EDeathDomain = typeof P3E_DEATH_DOMAIN;

/** Life RNG 游標：`semanticDraws` 是語意抽樣數（burn 記 1、之後每年 +4）。 */
export interface P3ELifeRngState {
  readonly domain: P3ELifeDomain;
  /** compatibility burn **前**的 state（`deriveDomainState(masterSeed, "life", "1.0.0")`）。 */
  readonly initialState: P3EWordTuple;
  /** burn 後的 current state（燃燒一次 `uniformBigInt(41n)`，結果丟棄）。 */
  readonly state: P3EWordTuple;
  readonly semanticDraws: number;
}

/**
 * Event／Death 共用的 u32 游標骨架。
 * `Domain` 是 literal，因此 event 與 death 的游標在型別層**不能互換**。
 */
export interface P3EU32RngState<Domain extends string = string> {
  readonly domain: Domain;
  readonly initialState: P3EWordTuple;
  readonly state: P3EWordTuple;
  /** 實際推進的 u32 次數（不是語意抽樣數）。 */
  readonly u32Draws: number;
}

export type P3EEventRngState = P3EU32RngState<P3EEventDomain>;
export type P3EDeathRngState = P3EU32RngState<P3EDeathDomain>;

export interface P3ERngState {
  readonly life: P3ELifeRngState;
  readonly events: P3EEventRngState;
  readonly death: P3EDeathRngState;
}

/* ------------------------------------------------------------------ */
/* 四、身分與 pack 綁定                                                */
/* ------------------------------------------------------------------ */

export interface P3EIdentityBinding {
  readonly entityId: string;
  readonly regionCode: string;
  readonly sex: P3ESex;
  readonly birthYear: number;
  readonly certificateId: string;
  readonly certificateHash: P3EHex64;
  /** 對應 `certificate.player.identityHash`（P2-D）。 */
  readonly playerIdentityHash: string;
  readonly masterSeedHash: P3EHex64;
  readonly basePackId: string;
  readonly basePackChecksum: P3EHex64;
  readonly identityPackId: string;
  readonly identityPackChecksum: P3EHex64;
}

/**
 * 事件包綁定：直接重用 P3-C 的權威形狀，不另外發明欄位。
 *
 * `eventSchemaVersion`／`eventSpecVersion`／`contentPackVersion`／`eventPackId`／
 * `eventPackChecksum`／`datasetChecksum`／`eventCount` 七個欄位與 `p3c-1` 完全相同。
 */
export type P3EEventPackBinding = P3CEventPackBinding;

/** 死亡包綁定：P3-D manifest 的權威欄位（少掉與 P3-E 無關的 licenses／lineage／datasets）。 */
export interface P3EDeathPackBinding {
  readonly schemaVersion: string;
  readonly deathDataVersion: string;
  readonly deathSpecVersion: string;
  readonly healthRuleVersion: string;
  readonly engineVersion: string;
  readonly rngSpecVersion: string;
  readonly deathPackId: string;
  readonly deathPackChecksum: P3EHex64;
  readonly basePackId: string;
  readonly basePackChecksum: P3EHex64;
  readonly entityCount: number;
}

export interface P3EPackBindings {
  readonly events: P3EEventPackBinding;
  readonly death: P3EDeathPackBinding;
}

/* ------------------------------------------------------------------ */
/* 五、state 與 roll                                                   */
/* ------------------------------------------------------------------ */

/** genesis 的 hash-chain head（還沒有任何年度 delta）。 */
export interface P3EHistoryHeads {
  readonly lastEntryHash: P3EHex64;
  readonly lastSnapshotHash: P3EHex64;
  readonly lastDeltaHash: P3EHex64;
  readonly hashChain: P3EHex64;
}

/**
 * command log 的**摘要**（不得保存可成長的 commands 陣列）。
 * `headHash` 的初值使用獨立的 `LIFE1/P3E/COMMAND/INIT/v1` domain，
 * **不得**重用一般 state chain 的初值。
 */
export interface P3ECommandSummary {
  readonly count: number;
  readonly headHash: P3EHex64;
}

/** command head 的獨立初值 domain（P3-E.1a-2 使用）。 */
export const P3E_COMMAND_INIT_DOMAIN = "LIFE1/P3E/COMMAND/INIT/v1" as const;

export interface P3EStats {
  readonly health: number;
  readonly happiness: number;
  readonly knowledge: number;
  readonly relationships: number;
}

/** runtime money 沿用既有 bigint（microUSD），不得改成 number。 */
export interface P3EAssets {
  readonly balanceMicroUsd: bigint;
  readonly annualIncomeMicroUsd: bigint;
  readonly annualExpenseMicroUsd: bigint;
}

/** 事件摘要（有硬上限；不得保存逐年事件歷史）。 */
export interface P3EEventOccurrence {
  readonly eventId: string;
  readonly count: number;
  readonly lastYear: number;
}

export interface P3ERollInput {
  readonly rollSpecVersion: P3ERollSpecVersion;
  readonly age: number;
  readonly stats: P3EStats;
  readonly balanceMicroUsd: bigint;
  readonly lifeRng: P3ELifeRngState;
}

export interface P3ERollResult {
  readonly rollSpecVersion: P3ERollSpecVersion;
  readonly stats: P3EStats;
  readonly assets: P3EAssets;
  readonly lifeRng: P3ELifeRngState;
  readonly semanticDrawsUsed: number;
}

/** P3-E 的權威 state（固定大小；沒有任何年度陣列）。 */
/**
 * 待決策摘要（`p3e-2` 起）：固定大小、受 pack checksum 保護的識別資訊。
 *
 * - `optionIds` 必須非空、唯一、保持 pack 順序（1..`P3B_MAX_DECISION_OPTIONS`）；
 * - `selectionHash` 是 64 位小寫 hex（把「這一年這次抽選」綁進 pending decision）；
 * - `year`／`age` 必須等於 State 的 `currentYear`／`age`。
 */
export interface P3EPendingDecisionSummary {
  readonly year: number;
  readonly age: number;
  readonly eventId: string;
  readonly decisionId: string;
  readonly selectionHash: P3EHex64;
  readonly optionIds: readonly string[];
}

export interface P3ELifeState {
  readonly schemaVersion: P3ESchemaVersion;
  readonly rulesetVersion: P3ERulesetVersion;
  readonly rollSpecVersion: P3ERollSpecVersion;
  readonly lifeSpecVersion: P3ELifeSpecVersion;
  readonly contentVersion: P3EContentVersion;
  readonly saveFormatVersion: P3ESaveFormatVersion;
  readonly engineVersion: P3EEngineVersion;
  readonly rngSpecVersion: P3ERngSpecVersion;
  readonly identity: P3EIdentityBinding;
  readonly packs: P3EPackBindings;
  readonly currentYear: number;
  readonly age: number;
  readonly phase: P3EPhase;
  /**
   * 待決策的**固定大小摘要**（`p3e-2` 起）。
   *
   * `phase === "pending_decision"` 時必須非 `null`，其餘 phase 必須是 `null`；
   * 只放識別摘要（`year`／`age`／`eventId`／`decisionId`／`selectionHash`／`optionIds`），
   * 文案、effects、完整 event 或年度交易一律不進來（UI／決策命令要從
   * state 已綁定 checksum 的 event pack 重新查找）。
   */
  readonly pendingDecision: P3EPendingDecisionSummary | null;
  readonly stats: P3EStats;
  readonly assets: P3EAssets;
  readonly flags: readonly string[];
  readonly occurrences: readonly P3EEventOccurrence[];
  readonly rng: P3ERngState;
  readonly heads: P3EHistoryHeads;
  readonly commandLog: P3ECommandSummary;
  readonly stateHash: P3EHex64;
}

/* ------------------------------------------------------------------ */
/* 六、P3-E.1a-2 才實作的規格（本批只記錄常數，沒有對應函式）           */
/* ------------------------------------------------------------------ */

/** `p3e-roll-1.0.0`：每年四次語意抽取，順序與範圍固定。 */
export const P3E_ROLL_STEPS = [
  { stat: "health", min: -3, max: 3 },
  { stat: "happiness", min: -3, max: 3 },
  { stat: "knowledge", min: 0, max: 3 },
  { stat: "relationships", min: -2, max: 2 }
] as const;
export const P3E_ROLL_SEMANTIC_DRAWS = P3E_ROLL_STEPS.length;

/**
 * `p3e-roll-1.0.0` 的收支公式（age 的整數函式，不消耗 RNG）：
 *
 * ```
 * income  = 1_000_000n + BigInt(age) * 100_000n
 * expense =   600_000n + BigInt(age) *  50_000n
 * balance = max(0n, previousBalance + income - expense)
 * ```
 *
 * `annualExpenseMicroUsd` **保留完整公式值**；不得因為餘額不足而改成「實際扣款」。
 */
export const P3E_INCOME_BASE_MICRO_USD = 1_000_000n;
export const P3E_INCOME_PER_YEAR_MICRO_USD = 100_000n;
export const P3E_EXPENSE_BASE_MICRO_USD = 600_000n;
export const P3E_EXPENSE_PER_YEAR_MICRO_USD = 50_000n;

/** compatibility burn：一次 `uniformBigInt(41n)`，結果丟棄。 */
export const P3E_LIFESPAN_BURN_BOUND = 41n;
export const P3E_GENESIS_SEMANTIC_DRAWS = 1;

/** 硬上限（state 大小固定）。 */
export const P3E_MAX_FLAGS = 256;
export const P3E_MAX_OCCURRENCES = 4096;
export const P3E_MAX_COMMANDS = 4096;
export const P3E_MAX_U32_DRAWS_PER_EVENT = 256;

/**
 * 死亡階段「已執行存活年度」的**最小消耗**及**常見單次成功值**（存活時 2 個 u32）。
 *
 * - 存活年度至少要完成一次 mortality 抽樣，而每次抽樣嘗試消耗 2 個 u32，
 *   所以 2 是「已執行存活年度」的下界與最常見的單次成功值。
 * - **不是固定值**：P3-D 的 `evaluateAnnualDeath` 使用 rejection sampling，
 *   被拒絕就會再試一次，因此實際消耗可能是 2／4／6……
 * - **不是上限**：正式的 State 驗證（`assertDeathRng`）不得引用它作為上限，
 *   上限只有 `P3E_MAX_U32_DRAWS_PER_DEATH_YEAR × age`。
 */
export const P3E_DEATH_DRAWS_ALIVE = 2;

/**
 * **常見的「兩次 sampling 均首次成功」案例值**（死亡時 4 個 u32 ＝ mortality 抽樣 ＋ cause selection）。
 *
 * - 死亡年度要跑兩段 sampling（mortality ＋ cause selection），兩段都第一次就成功時是 4。
 * - **不是固定值**：任一段被 rejection sampling 拒絕就會更多（6／8……）。
 * - **不是上限**，也不得作為 State invariant 的上限；
 *   上限只有 `P3E_MAX_U32_DRAWS_PER_DEATH_YEAR × age`。
 */
export const P3E_DEATH_DRAWS_DIED = 4;

/**
 * 單一年度死亡階段合法的最大 u32 消耗：
 *
 * ```text
 * 2 個 sampling × 128 attempts × 2 u32 = 512
 * ```
 *
 * - mortality 抽樣最多 128 次嘗試，每次 2 個 u32；
 * - 死亡時的 cause selection 再最多 128 次嘗試，每次 2 個 u32；
 * - 因此 `512 × age` 才是 State 驗證該用的上限，而不是固定 2／4。
 *
 * 合法的 `drawsUsed` 一律保存 P3-D 回傳的實際偶數值，不得截斷、正規化或硬編碼。
 */
export const P3E_MAX_U32_DRAWS_PER_DEATH_YEAR = 512;

