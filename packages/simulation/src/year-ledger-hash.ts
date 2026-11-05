import { ascii, canonicalBytes, concatBytes, sha256Hex } from "@life-sim/engine";
import type {
  P3EAssets,
  P3EEventOccurrence,
  P3EHex64,
  P3EPendingDecisionSummary,
  P3EPhase,
  P3ERngState,
  P3EStats
} from "@life-sim/contracts";

/**
 * P3-E Ledger 雜湊核心 V2.2（正式主線，H5-CTO-117-A 整合）。
 *
 * 來源：WorkBuddy 候選 `year-ledger-hash-kernel-v22-candidate.ts`
 * （SHA-256 `57b9c1852f25686108b2572f7327998a855502aa8985a719b1728ee388cb48fc`，
 * 經 H5-CTO-116 核准）；正式化只移除 candidate 命名、更新註解並改檔名，
 * 五個原語與 projection 邏輯逐字保留。
 *
 * ## 與 V2.1 的差異
 *
 * 正式主線升級為 `p3e-2`：`P3ELifeState` 在 `phase` 之後新增**必要**欄位
 * `pendingDecision: P3EPendingDecisionSummary | null`，且正式 `computeP3EStateHash`
 * 的 projection 已把該欄位納入（`optionIds` 順序有影響）。
 *
 * 因此 V2.2 讓 Snapshot 與 Delta **明確承諾** `pendingDecision`：
 *
 * - `P3EYearSnapshotHashInput` 增加 `pendingDecision`；
 * - `P3EYearDeltaHashInput` 增加 `pendingDecisionBefore`／`pendingDecisionAfter`。
 *
 * Entry **不**重複保存 `pendingDecision`（Snapshot／Delta 已承諾它）。
 *
 * ## 固定無循環方向（沿用 V2）
 *
 *   snapshotHash／deltaHash → entryHash → 三個 ledger heads → stateHashAfter
 *   → commandHash → chainHash
 *
 * 正式 `heads.hashChain` 與 `commandLog` 已排除在 stateHash projection 之外，
 * 故更新二者不會改變 `stateHashAfter`。
 *
 * ## 雜湊規則（沿用 V1／V2）
 *
 * 使用既有 `canonicalBytes` + `sha256Hex` + 明確 domain `0x00` 分隔；
 * projection 逐欄手寫，不對子物件使用 spread，不依賴隨機源／時間源／平台編碼差異；
 * `canonicalBytes` 原生支援 `null`（TAG 0x00），故 `null` 與非 `null` 必然異 hash。
 *
 * ## 型別來源
 *
 * `P3EPendingDecisionSummary` **直接取自正式 contracts**
 * （`@life-sim/contracts`，`p3e-2`），不是鏡像型別。來源 SHA：
 * `packages/contracts/src/p3e.ts` = `5c771b42830d2abbea9a473337af8f4af150893a06f76aee519d9ba61947a075`。
 *
 * 本模組只負責 projection 與 hash；不含 append／verify／replay／state seal／
 * 模擬器／RNG／occurrence 更新／resign／主線整合。
 *
 * ## Domain（H5-CTO-116 核准的固定值）
 *
 * `LIFE1/P3E/COMMAND/v1`、`LIFE1/P3E/LOG/v1`、`LIFE1/P3E/SNAPSHOT/v1`、
 * `LIFE1/P3E/DELTA/v1`、`LIFE1/P3E/CHAIN/v1`。
 */

/* ------------------------------------------------------------------ */
/* 官方分離 domain（H5-CTO-116 核准，固定值）                          */
/* ------------------------------------------------------------------ */

const KERNEL_COMMAND_DOMAIN = "LIFE1/P3E/COMMAND/v1";
const KERNEL_LOG_DOMAIN = "LIFE1/P3E/LOG/v1";
const KERNEL_SNAPSHOT_DOMAIN = "LIFE1/P3E/SNAPSHOT/v1";
const KERNEL_DELTA_DOMAIN = "LIFE1/P3E/DELTA/v1";
const KERNEL_CHAIN_DOMAIN = "LIFE1/P3E/CHAIN/v1";

/* ------------------------------------------------------------------ */
/* 輸入型別（純 projection 來源；不含任何 hash 輸出欄位）               */
/* ------------------------------------------------------------------ */

/**
 * snapshot 雜湊輸入（不含 `snapshotHash`）。
 *
 * V2.2：新增 `pendingDecision`（`p3e-2` 必要欄位；`null` 或六欄摘要）。
 * 仍**不含** `stateHash`、任一 history head、command hash、或 `commandLog`。
 */
export interface P3EYearSnapshotHashInput {
  readonly index: number;
  readonly year: number;
  readonly age: number;
  readonly phase: P3EPhase;
  readonly stats: P3EStats;
  readonly assets: P3EAssets;
  readonly rng: P3ERngState;
  readonly flags: readonly string[];
  readonly occurrences: readonly P3EEventOccurrence[];
  readonly pendingDecision: P3EPendingDecisionSummary | null;
}

/**
 * delta 雜湊輸入（不含 `deltaHash`）。
 *
 * V2.2：新增 `pendingDecisionBefore`／`pendingDecisionAfter`（兩邊都完整投影
 * `null` 或六欄摘要）。其餘沿用 V2.1 的完整 before／after 權威欄位；
 * 不含 `stateHashAfter` 或任何 history head，不對子物件使用 spread。
 */
export interface P3EYearDeltaHashInput {
  readonly index: number;
  readonly yearBefore: number;
  readonly yearAfter: number;
  readonly ageBefore: number;
  readonly ageAfter: number;
  readonly phaseBefore: P3EPhase;
  readonly phaseAfter: P3EPhase;
  readonly statsBefore: P3EStats;
  readonly statsAfter: P3EStats;
  readonly assetsBefore: P3EAssets;
  readonly assetsAfter: P3EAssets;
  readonly rngBefore: P3ERngState;
  readonly rngAfter: P3ERngState;
  readonly flagsBefore: readonly string[];
  readonly flagsAfter: readonly string[];
  readonly occurrencesBefore: readonly P3EEventOccurrence[];
  readonly occurrencesAfter: readonly P3EEventOccurrence[];
  readonly pendingDecisionBefore: P3EPendingDecisionSummary | null;
  readonly pendingDecisionAfter: P3EPendingDecisionSummary | null;
}

/**
 * command 雜湊輸入（不含 `commandHash`）。
 *
 * `entryHash` 是 **必要** 權威欄位，且必須在 `stateHashAfter` 完成後才傳入。
 * projection 含 `prevCommandHash`、`stateHashBefore`、`stateHashAfter`、`entryHash`。
 */
export interface P3ECommandHashInput {
  readonly prevCommandHash: P3EHex64;
  readonly index: number;
  readonly year: number;
  readonly command: string;
  readonly argsHash: P3EHex64;
  readonly stateHashBefore: P3EHex64;
  readonly stateHashAfter: P3EHex64;
  readonly entryHash: P3EHex64;
}

/**
 * entry 雜湊輸入（不含 `entryHash`／`chainHash`）。
 *
 * 依賴**已知**的 `stateHashBefore`，**不含** `stateHashAfter`、`commandHash`
 * 或 `chainHash`；這是破除 `entry ⇄ stateHash` 循環的關鍵。
 */
export interface P3EYearEntryHashInput {
  readonly index: number;
  readonly year: number;
  readonly age: number;
  readonly phase: P3EPhase;
  readonly stateHashBefore: P3EHex64;
  readonly rngBefore: P3ERngState;
  readonly rngAfter: P3ERngState;
  readonly snapshotHash: P3EHex64;
  readonly deltaHash: P3EHex64;
}

/** chain 雜湊輸入。必須包含 `prevChainHash`、本筆 `entryHash`、`stateHashAfter`、`commandHash`。 */
export interface P3EYearChainHashInput {
  readonly prevChainHash: P3EHex64;
  readonly index: number;
  readonly year: number;
  readonly entryHash: P3EHex64;
  readonly stateHashAfter: P3EHex64;
  readonly commandHash: P3EHex64;
}

/* ------------------------------------------------------------------ */
/* 雜湊原語                                                            */
/* ------------------------------------------------------------------ */

/** 唯一雜湊入口：`domain ‖ 0x00 ‖ canonicalBytes(projection)`。 */
function hashKernel(domain: string, projection: unknown): P3EHex64 {
  return sha256Hex(concatBytes(ascii(domain), Uint8Array.of(0), canonicalBytes(projection as never)));
}

/** 三條 RNG 游標 projection。逐欄手寫：tuple 以顯式索引陣列 literal 建立，不依賴 spread。 */
function rngProjection(rng: P3ERngState): unknown {
  const life = rng.life;
  const events = rng.events;
  const death = rng.death;
  return {
    life: {
      domain: life.domain,
      initialState: [life.initialState[0], life.initialState[1], life.initialState[2], life.initialState[3]],
      state: [life.state[0], life.state[1], life.state[2], life.state[3]],
      semanticDraws: life.semanticDraws
    },
    events: {
      domain: events.domain,
      initialState: [events.initialState[0], events.initialState[1], events.initialState[2], events.initialState[3]],
      state: [events.state[0], events.state[1], events.state[2], events.state[3]],
      u32Draws: events.u32Draws
    },
    death: {
      domain: death.domain,
      initialState: [death.initialState[0], death.initialState[1], death.initialState[2], death.initialState[3]],
      state: [death.state[0], death.state[1], death.state[2], death.state[3]],
      u32Draws: death.u32Draws
    }
  };
}

/**
 * pending decision 摘要 projection（V2.2 新增）。
 *
 * - `null` 原樣投影為 `null`（`canonicalBytes` 以 TAG 0x00 編碼，與非 null 必然不同）。
 * - 非 `null` 逐欄手寫六欄：`year`／`age`／`eventId`／`decisionId`／`selectionHash`／
 *   `optionIds`；`optionIds` 保持順序並建立**獨立**陣列（不只雜湊物件引用）。
 *
 * 欄位集合與順序對齊正式 `p3eStateProjection` 的 `pendingDecision` 投影，
 * 使 Snapshot／Delta 與正式 stateHash 的 pendingDecision 語意一致。
 */
function pendingDecisionProjection(pending: P3EPendingDecisionSummary | null): unknown {
  if (pending === null) return null;
  return {
    year: pending.year,
    age: pending.age,
    eventId: pending.eventId,
    decisionId: pending.decisionId,
    selectionHash: pending.selectionHash,
    optionIds: [...pending.optionIds]
  };
}

/* ------------------------------------------------------------------ */
/* 五個純雜湊函式（皆為純函式，不修改輸入）                            */
/* ------------------------------------------------------------------ */

/**
 * SNAPSHOT domain 雜湊（V2.2）。逐欄手寫 stats／assets／rng／occurrences／pendingDecision。
 * 不含 `stateHash`、history head、command hash、commandLog。
 */
export function computeP3ESnapshotHash(input: P3EYearSnapshotHashInput): P3EHex64 {
  const s = input.stats;
  const a = input.assets;
  return hashKernel(KERNEL_SNAPSHOT_DOMAIN, {
    index: input.index,
    year: input.year,
    age: input.age,
    phase: input.phase,
    stats: {
      health: s.health,
      happiness: s.happiness,
      knowledge: s.knowledge,
      relationships: s.relationships
    },
    assets: {
      balanceMicroUsd: a.balanceMicroUsd,
      annualIncomeMicroUsd: a.annualIncomeMicroUsd,
      annualExpenseMicroUsd: a.annualExpenseMicroUsd
    },
    rng: rngProjection(input.rng),
    flags: [...input.flags],
    occurrences: input.occurrences.map((o) => ({
      eventId: o.eventId,
      count: o.count,
      lastYear: o.lastYear
    })),
    pendingDecision: pendingDecisionProjection(input.pendingDecision)
  });
}

/**
 * DELTA domain 雜湊（V2.2）。完整 before／after 權威欄位，逐欄手寫；
 * `flagsBefore/flagsAfter/occurrencesBefore/occurrencesAfter` 各自建立獨立陣列 projection，
 * `pendingDecisionBefore/After` 各自完整投影 `null` 或六欄摘要；
 * 不對子物件使用 spread，不含 `stateHashAfter` 或任何 history head。
 */
export function computeP3EDeltaHash(input: P3EYearDeltaHashInput): P3EHex64 {
  const sb = input.statsBefore;
  const sa = input.statsAfter;
  const ab = input.assetsBefore;
  const aa = input.assetsAfter;
  return hashKernel(KERNEL_DELTA_DOMAIN, {
    index: input.index,
    yearBefore: input.yearBefore,
    yearAfter: input.yearAfter,
    ageBefore: input.ageBefore,
    ageAfter: input.ageAfter,
    phaseBefore: input.phaseBefore,
    phaseAfter: input.phaseAfter,
    statsBefore: {
      health: sb.health,
      happiness: sb.happiness,
      knowledge: sb.knowledge,
      relationships: sb.relationships
    },
    statsAfter: {
      health: sa.health,
      happiness: sa.happiness,
      knowledge: sa.knowledge,
      relationships: sa.relationships
    },
    assetsBefore: {
      balanceMicroUsd: ab.balanceMicroUsd,
      annualIncomeMicroUsd: ab.annualIncomeMicroUsd,
      annualExpenseMicroUsd: ab.annualExpenseMicroUsd
    },
    assetsAfter: {
      balanceMicroUsd: aa.balanceMicroUsd,
      annualIncomeMicroUsd: aa.annualIncomeMicroUsd,
      annualExpenseMicroUsd: aa.annualExpenseMicroUsd
    },
    rngBefore: rngProjection(input.rngBefore),
    rngAfter: rngProjection(input.rngAfter),
    flagsBefore: [...input.flagsBefore],
    flagsAfter: [...input.flagsAfter],
    occurrencesBefore: input.occurrencesBefore.map((o) => ({
      eventId: o.eventId,
      count: o.count,
      lastYear: o.lastYear
    })),
    occurrencesAfter: input.occurrencesAfter.map((o) => ({
      eventId: o.eventId,
      count: o.count,
      lastYear: o.lastYear
    })),
    pendingDecisionBefore: pendingDecisionProjection(input.pendingDecisionBefore),
    pendingDecisionAfter: pendingDecisionProjection(input.pendingDecisionAfter)
  });
}

/**
 * COMMAND domain 雜湊（V2）。
 *
 * `entryHash` 為投影 **必要** 欄位；`commandHash` 在 `stateHashAfter` 完成後計算，
 * 因此依賴已完成的值而不反向影響它們（無循環）。
 */
export function computeP3ECommandHash(input: P3ECommandHashInput): P3EHex64 {
  return hashKernel(KERNEL_COMMAND_DOMAIN, {
    prevCommandHash: input.prevCommandHash,
    index: input.index,
    year: input.year,
    command: input.command,
    argsHash: input.argsHash,
    stateHashBefore: input.stateHashBefore,
    stateHashAfter: input.stateHashAfter,
    entryHash: input.entryHash
  });
}

/**
 * LOG domain 雜湊（entryHash，V2）。
 *
 * 依賴**已知**的 `stateHashBefore`；**不含** `stateHashAfter`／`commandHash`／`chainHash`。
 */
export function computeP3EYearEntryHash(input: P3EYearEntryHashInput): P3EHex64 {
  return hashKernel(KERNEL_LOG_DOMAIN, {
    index: input.index,
    year: input.year,
    age: input.age,
    phase: input.phase,
    stateHashBefore: input.stateHashBefore,
    rngBefore: rngProjection(input.rngBefore),
    rngAfter: rngProjection(input.rngAfter),
    snapshotHash: input.snapshotHash,
    deltaHash: input.deltaHash
  });
}

/**
 * CHAIN domain 雜湊（chainHash，V2）。
 *
 * 必須包含 `prevChainHash`、本筆 `entryHash`、`stateHashAfter`、`commandHash`；
 * `stateHashAfter` 僅作鏈上記錄，**不**反向回流同一筆 `stateHash`。
 */
export function computeP3EYearChainHash(input: P3EYearChainHashInput): P3EHex64 {
  return hashKernel(KERNEL_CHAIN_DOMAIN, {
    prevChainHash: input.prevChainHash,
    index: input.index,
    year: input.year,
    entryHash: input.entryHash,
    stateHashAfter: input.stateHashAfter,
    commandHash: input.commandHash
  });
}
