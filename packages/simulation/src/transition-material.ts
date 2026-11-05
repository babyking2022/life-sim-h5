import { P3E_MAX_COMMANDS, type P3EHex64, type P3ERngState, type P3EWordTuple } from "@life-sim/contracts";
import { P3EError } from "./errors";
import { readP3EState } from "./state-invariants";
import { sealP3EState } from "./genesis";
import { computeP3EDeltaHash, computeP3ESnapshotHash, computeP3EYearEntryHash } from "./year-ledger-hash";
import type { P3EStateCoreDraft } from "./state-core-draft";

/**
 * P3-E Transition Materialization（H5-CTO-140-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * materializeP3ETransition(previousState, nextCoreDraft): P3ETransitionMaterial
 * ```
 *
 * 把「上一個已驗證 State」與「下一個 State Core Draft」之間的三個 ledger hash
 * （snapshot／delta／entry）算出來，並用正式 `sealP3EState` 得到 `stateHashAfter`。
 *
 * ## 只產生這九樣
 *
 * `index`、`stateHashBefore`、`stateHashAfter`、`snapshotHash`、`deltaHash`、`entryHash`、
 * `rngBefore`、`rngAfter`、`headsForStateHash`（三個鏈尾）。
 *
 * ## 刻意不做
 *
 * - 不執行 `ADVANCE_YEAR`／`CHOOSE_DECISION`、不自行產生 Core Draft；
 * - 不建立 Command Record 或 Year Ledger Record（沒有 `commandHash`／`chainHash`）；
 * - 不更新 `commandLog`／`hashChain`、不 append Ledger、不做 codec／replay；
 * - **不複製或重寫**任何演算法：Snapshot／Delta／Entry 全部走 `year-ledger-hash.ts`，
 *   State hash 全部走 `sealP3EState`，State 驗證全部走 `readP3EState`。
 *
 * ## 循環依賴防線
 *
 * `stateHashAfter` 只透過 `sealP3EState` 內的正式 `p3eStateProjection` 產生，該 projection
 * 收錄三個鏈尾、排除 `heads.hashChain` 與整個 `commandLog`。provisional State 只在驗證時
 * 短暫存在（`hashChain` 沿用 previous、`commandLog` 沿用 previous），**不會回傳**。
 *
 * 沒有假的 `commandHash`／`chainHash`，也沒有任何 64 位零值 placeholder。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 供 `stateHashAfter` 使用的新三個鏈尾。 */
export interface P3ETransitionHeads {
  readonly lastSnapshotHash: P3EHex64;
  readonly lastDeltaHash: P3EHex64;
  readonly lastEntryHash: P3EHex64;
}

/** 一筆年度轉移的 hash 材料（固定九欄，全部深層凍結）。 */
export interface P3ETransitionMaterial {
  readonly index: number;
  readonly stateHashBefore: P3EHex64;
  readonly stateHashAfter: P3EHex64;
  readonly snapshotHash: P3EHex64;
  readonly deltaHash: P3EHex64;
  readonly entryHash: P3EHex64;
  readonly rngBefore: P3ERngState;
  readonly rngAfter: P3ERngState;
  readonly headsForStateHash: P3ETransitionHeads;
}

const INDEX_PATH = "transitionMaterial.index";
const DRAFT_PATH = "transitionMaterial.draft";

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function failIndex(): never {
  throw new P3EError("E_P3E_HISTORY", INDEX_PATH);
}

/* ------------------------------------------------------------------ */
/* 深的獨立副本（純結構拷貝，不是演算法）                              */
/* ------------------------------------------------------------------ */

function copyWords(words: P3EWordTuple): P3EWordTuple {
  return Object.freeze([words[0], words[1], words[2], words[3]]);
}

function copyRng(rng: P3ERngState): P3ERngState {
  return Object.freeze({
    life: Object.freeze({
      domain: rng.life.domain,
      initialState: copyWords(rng.life.initialState),
      state: copyWords(rng.life.state),
      semanticDraws: rng.life.semanticDraws
    }),
    events: Object.freeze({
      domain: rng.events.domain,
      initialState: copyWords(rng.events.initialState),
      state: copyWords(rng.events.state),
      u32Draws: rng.events.u32Draws
    }),
    death: Object.freeze({
      domain: rng.death.domain,
      initialState: copyWords(rng.death.initialState),
      state: copyWords(rng.death.state),
      u32Draws: rng.death.u32Draws
    })
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 計算一筆年度轉移的 hash 材料。
 *
 * 固定順序：
 *
 * 1. `readP3EState(previousState)`（shape ＋ invariants ＋ stateHash）；
 * 2. `index = previousState.commandLog.count + 1`；
 * 3. index 必須是安全整數且不超過 `P3E_MAX_COMMANDS`；
 * 4. `computeP3ESnapshotHash`（輸入取 `nextCoreDraft` 的下一狀態欄位）；
 * 5. `computeP3EDeltaHash`（previous 與 draft 的完整 before／after）；
 * 6. `computeP3EYearEntryHash`（index／draft 的年齡階段／previous 的 stateHash 與 RNG／
 *    draft 的 RNG／snapshotHash／deltaHash）；
 * 7. 新三個鏈尾；
 * 8. provisional draft（`hashChain` 與 `commandLog` **沿用 previous**）；
 * 9. `sealP3EState` 取得 `stateHashAfter`（provisional 不回傳）。
 *
 * `readP3EState`／`sealP3EState` 的既有 `P3EError` 原樣往外傳；只有「draft 根本無法
 * canonical 編碼」這種非 `P3EError` 的失敗會折成 `E_P3E_STATE at transitionMaterial.draft`。
 */
export function materializeP3ETransition(
  previousState: unknown,
  nextCoreDraft: P3EStateCoreDraft
): P3ETransitionMaterial {
  // 1. previousState 一律走正式驗證器（shape ＋ invariants ＋ stateHash）
  const previous = readP3EState(previousState);

  // 2-3. index 的下一個值，且不得超過正式命令數上限
  const index = previous.commandLog.count + 1;
  if (!Number.isSafeInteger(index) || index > P3E_MAX_COMMANDS) failIndex();

  // 4-6. 三個 hash：全部走正式原語
  let snapshotHash: P3EHex64;
  let deltaHash: P3EHex64;
  let entryHash: P3EHex64;
  try {
    snapshotHash = computeP3ESnapshotHash({
      index,
      year: nextCoreDraft.currentYear,
      age: nextCoreDraft.age,
      phase: nextCoreDraft.phase,
      stats: nextCoreDraft.stats,
      assets: nextCoreDraft.assets,
      rng: nextCoreDraft.rng,
      flags: nextCoreDraft.flags,
      occurrences: nextCoreDraft.occurrences,
      pendingDecision: nextCoreDraft.pendingDecision
    });
    deltaHash = computeP3EDeltaHash({
      index,
      yearBefore: previous.currentYear,
      yearAfter: nextCoreDraft.currentYear,
      ageBefore: previous.age,
      ageAfter: nextCoreDraft.age,
      phaseBefore: previous.phase,
      phaseAfter: nextCoreDraft.phase,
      statsBefore: previous.stats,
      statsAfter: nextCoreDraft.stats,
      assetsBefore: previous.assets,
      assetsAfter: nextCoreDraft.assets,
      rngBefore: previous.rng,
      rngAfter: nextCoreDraft.rng,
      flagsBefore: previous.flags,
      flagsAfter: nextCoreDraft.flags,
      occurrencesBefore: previous.occurrences,
      occurrencesAfter: nextCoreDraft.occurrences,
      pendingDecisionBefore: previous.pendingDecision,
      pendingDecisionAfter: nextCoreDraft.pendingDecision
    });
    entryHash = computeP3EYearEntryHash({
      index,
      year: nextCoreDraft.currentYear,
      age: nextCoreDraft.age,
      phase: nextCoreDraft.phase,
      stateHashBefore: previous.stateHash,
      rngBefore: previous.rng,
      rngAfter: nextCoreDraft.rng,
      snapshotHash,
      deltaHash
    });
  } catch (error) {
    // 既有 P3EError 原樣往外傳（不統一吞掉重包）；只有編碼類的原始例外才折疊。
    if (error instanceof P3EError) throw error;
    throw new P3EError("E_P3E_STATE", DRAFT_PATH);
  }

  // 7. 新的三個鏈尾
  const headsForStateHash: P3ETransitionHeads = Object.freeze({
    lastSnapshotHash: snapshotHash,
    lastDeltaHash: deltaHash,
    lastEntryHash: entryHash
  });

  // 8. provisional draft：hashChain 與 commandLog 沿用 previous（只用於 seal）
  const provisional = {
    ...nextCoreDraft,
    heads: {
      lastSnapshotHash: headsForStateHash.lastSnapshotHash,
      lastDeltaHash: headsForStateHash.lastDeltaHash,
      lastEntryHash: headsForStateHash.lastEntryHash,
      hashChain: previous.heads.hashChain
    },
    commandLog: previous.commandLog
  };

  // 9. 正式 seal（內部會再跑一次 readP3EState）
  const sealed = sealP3EState(provisional);

  // 11. 深層凍結、與輸入零共享（provisional／sealed 都不回傳）
  return Object.freeze({
    index,
    stateHashBefore: previous.stateHash,
    stateHashAfter: sealed.stateHash,
    snapshotHash,
    deltaHash,
    entryHash,
    rngBefore: copyRng(previous.rng),
    rngAfter: copyRng(sealed.rng),
    headsForStateHash
  });
}
