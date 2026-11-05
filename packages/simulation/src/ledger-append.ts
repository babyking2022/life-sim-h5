import type { P3ELifeState } from "@life-sim/contracts";
import { P3EError } from "./errors";
import { readP3EState } from "./state-invariants";
import { readP3ECommand } from "./command-envelope";
import { createP3ECommandRecord, type P3ECommandRecord } from "./command-record";
import { createP3EYearLedgerRecord, type P3EYearLedgerRecord } from "./year-ledger-record";
import { materializeP3ETransition } from "./transition-material";
import { validateP3ELedgerContinuity } from "./ledger-continuity";
import type { P3EStateCoreDraft } from "./state-core-draft";

/**
 * P3-E Ledger Append（正式主線，H5-CTO-155-A 整合；套件內部，**不進公開 barrel**）。
 *
 * 來源：WorkBuddy 候選 `ledger-append-v1-candidate.ts`
 * （SHA-256 `da9b60b8421ca8dc6f2ebda64b8d0f193aa1ee22e87918560b61c551b73c8575`，
 * 經 H5-CTO-147-B／H5-CTO-155-A 核准）。正式化只改檔名與字樣、把候選的 continuity
 * import 指向正式 `./ledger-continuity`、並更新一段已過時的整合前提註解；
 * **業務流程逐字保留**。
 *
 * ```ts
 * appendP3ELedgerTransition(previousState, command, nextCoreDraft): P3ELedgerAppendResult
 * ```
 *
 * 一次完整的年度轉移：**驗證 → 物化 hash 材料 → 建兩份 Ledger 紀錄 → 驗連續性 →
 * 建立並封存下一個 State**。輸出固定三項：`state`／`commandRecord`／`yearRecord`，
 * 全部遞迴凍結、與輸入零共享。
 *
 * ## 這個模組證明什麼
 *
 * 給定「已驗證的 previous State」、「一筆已驗證的 Command」與「套件內正式產生的
 * next State Core Draft」，本模組證明**三份 Ledger 紀錄與下一個 State 彼此自洽**：
 *
 * 1. Command Record 的 index 連續、`prevCommandHash` 接續上一個 command head；
 * 2. Year Ledger Record 的 `prevChainHash` 接續上一個 chain head；
 * 3. 兩份紀錄的 `stateHashBefore`／`stateHashAfter` 都與物化材料一致；
 * 4. 三份輸出（final State／Command Record／Year Record）互相交叉連結一致；
 * 5. 下一個 State 的三個 ledger heads 正確更新，`heads.hashChain` 與 `commandLog`
 *    正確接續。
 *
 * ## 這個模組**不**證明什麼（固定責任邊界）
 *
 * - **不執行** `ADVANCE_YEAR`／`CHOOSE_DECISION` 業務流程；
 * - **不自行產生** Core Draft（draft 必須由套件內的
 *   `assembleP3EAnnualStateCoreDraft`／`assembleP3EDecisionStateCoreDraft` 產生）；
 * - **不重跑** Roll、事件抽取、事件 effects、死亡判定或決策 effects；
 * - **不建立** Codec／Replay；
 * - **不修改**公開 barrel（`packages/simulation/src/index.ts`）；
 * - **不接受**外部預先計算的 hash 或 Record（所有 hash 都由正式原語重算）。
 *
 * ## 必須重用的正式原語（不重寫其 shape／hash／continuity 演算法）
 *
 * - `readP3EState`（`./state-invariants`）
 * - `readP3ECommand`（`./command-envelope`）
 * - `materializeP3ETransition`（`./transition-material`）
 * - `createP3ECommandRecord`（`./command-record`）
 * - `createP3EYearLedgerRecord`（`./year-ledger-record`）
 * - `validateP3ELedgerContinuity`（Ledger Continuity，`./ledger-continuity`）
 * - `readP3EState`（最終 State 驗證）
 *
 * 這些原語自己發出的 `P3EError` **原樣往外拋**，不吞掉、不重包；只有本模組自己的
 * 讀取邊界（draft 的 descriptor 讀取）才使用本模組的固定路徑。
 *
 * ## 信任邊界
 *
 * - `previousState` 與 `command` 交給正式原語驗證（兩者都是 descriptor-only 讀取）；
 * - `nextCoreDraft` 以 **descriptor** 讀取：accessor（getter）**永遠不會被執行**，
 *   非 data property 一律略過；反射失敗（revoked Proxy 等）折成固定
 *   `E_P3E_STATE at ledgerAppend.draft`；
 * - 最終 State 交給 `readP3EState` 做完整驗證（shape ＋ 不變量 ＋ stateHash）。
 *
 * ## 已知整合前提（不變更）
 *
 * 年度收支 effects 的真實回歸由 H5-CTO-146-A 修正（正式 `state-invariants.ts` 已把
 * 「年度收支欄位必須等於基準公式」從 State 不變量移除）。本模組**不修改**任何 State
 * invariant；正式測試另外包含兩條 money-effects 真實管線回歸（housing `rent` 的
 * `annualExpenseMicroUsd +9,000,000`，以及年度事件的 `annualIncomeMicroUsd +5,000,000`）。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 一次 Ledger Append 的完整結果（三項全部深層凍結、與輸入零共享）。 */
export interface P3ELedgerAppendResult {
  /** 已驗證並封存的下一個 State。 */
  readonly state: P3ELifeState;
  /** 本次建立的 Command Record。 */
  readonly commandRecord: P3ECommandRecord;
  /** 本次建立的 Year Ledger Record。 */
  readonly yearRecord: P3EYearLedgerRecord;
}

/* ------------------------------------------------------------------ */
/* 固定錯誤路徑                                                         */
/* ------------------------------------------------------------------ */

const PATH_DRAFT = "ledgerAppend.draft";

function failDraft(): never {
  throw new P3EError("E_P3E_STATE", PATH_DRAFT);
}

/* ------------------------------------------------------------------ */
/* 信任邊界：next Core Draft 的 descriptor 讀取                          */
/* ------------------------------------------------------------------ */

/**
 * 以 **descriptor** 讀出 next Core Draft 的自有欄位。
 *
 * - accessor（getter／setter）**不會被執行**：只取 data property 的 `value`；
 * - 不可列舉／symbol 鍵不參與（Core Draft 是 19 欄的凍結 plain object）；
 * - 任何反射失敗（revoked Proxy、trap 拋錯）→ 固定 `E_P3E_STATE at ledgerAppend.draft`。
 *
 * 這一步**不是** shape 驗證：draft 的欄位集合與語意仍由
 * `materializeP3ETransition` → `sealP3EState` → `readP3EState` 這條正式路徑把關，
 * 本模組不重寫任何 shape／hash 演算法。
 */
function readDraftFields(draft: P3EStateCoreDraft): P3EStateCoreDraft {
  const fields: Record<string, unknown> = {};
  try {
    for (const key of Object.getOwnPropertyNames(draft)) {
      const descriptor = Object.getOwnPropertyDescriptor(draft, key);
      if (descriptor !== undefined && "value" in descriptor) fields[key] = descriptor.value;
    }
  } catch {
    failDraft();
  }
  return fields as unknown as P3EStateCoreDraft;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 執行一次 Ledger Append。
 *
 * 固定順序：
 *
 * 1. `readP3EState(previousState)`；
 * 2. `readP3ECommand(command)`；
 * 3. `materializeP3ETransition(previousState, nextCoreDraft)`；
 * 4. `createP3ECommandRecord`（index／year／command／prevCommandHash／前後 stateHash／entryHash）；
 * 5. `createP3EYearLedgerRecord`（index／year／age／phase／前後 stateHash／rng／snapshot／
 *    delta／prevChainHash／本批新建的 Command Record）；
 * 6. `validateP3ELedgerContinuity`（Ledger Continuity）驗三份資料；
 * 7. 建立最終 State（三個 ledger heads 取 material、`hashChain` 取 year record、
 *    `commandLog` 取本批 index／commandHash、`stateHash` 取 material）；
 * 8. `readP3EState` 驗證最終 State。
 *
 * **不會**修改任何輸入；輸出三項皆為獨立、深層凍結的快照。
 */
export function appendP3ELedgerTransition(
  previousState: unknown,
  command: unknown,
  nextCoreDraft: P3EStateCoreDraft
): P3ELedgerAppendResult {
  // 1. 驗證 previous State（正式原語；錯誤原樣外露）
  const previous = readP3EState(previousState);

  // 2. 驗證 Command（正式原語；錯誤原樣外露）
  const validatedCommand = readP3ECommand(command);

  // 3. 物化 hash 材料（正式原語；錯誤原樣外露）
  const draft = readDraftFields(nextCoreDraft);
  const material = materializeP3ETransition(previous, draft);

  // 4. 建立 Command Record（正式原語；錯誤原樣外露）
  const commandRecord = createP3ECommandRecord({
    index: material.index,
    year: draft.currentYear,
    command: validatedCommand,
    prevCommandHash: previous.commandLog.headHash,
    stateHashBefore: material.stateHashBefore,
    stateHashAfter: material.stateHashAfter,
    entryHash: material.entryHash
  });

  // 5. 建立 Year Ledger Record（正式原語；錯誤原樣外露）
  const yearRecord = createP3EYearLedgerRecord({
    index: material.index,
    year: draft.currentYear,
    age: draft.age,
    phase: draft.phase,
    stateHashBefore: material.stateHashBefore,
    stateHashAfter: material.stateHashAfter,
    rngBefore: material.rngBefore,
    rngAfter: material.rngAfter,
    snapshotHash: material.snapshotHash,
    deltaHash: material.deltaHash,
    prevChainHash: previous.heads.hashChain,
    commandRecord
  });

  // 6. Ledger Continuity：驗三份資料的連續性（正式原語；錯誤原樣外露）
  validateP3ELedgerContinuity({ previousState: previous, commandRecord, yearRecord });

  // 7-8. 建立最終 State 並交給正式驗證器封存。
  //
  //    stateHash 取 `material.stateHashAfter`：正式 `p3eStateProjection` **不收錄**
  //    `heads.hashChain` 與整個 `commandLog`，因此更新鏈尾與 command 摘要之後
  //    stateHash 仍等於物化時算出的值（由 `readP3EState` 的 `assertStateHash` 驗證）。
  const state = readP3EState({
    ...draft,
    heads: {
      lastSnapshotHash: material.headsForStateHash.lastSnapshotHash,
      lastDeltaHash: material.headsForStateHash.lastDeltaHash,
      lastEntryHash: material.headsForStateHash.lastEntryHash,
      hashChain: yearRecord.chainHash
    },
    commandLog: { count: material.index, headHash: commandRecord.commandHash },
    stateHash: material.stateHashAfter
  });

  return Object.freeze({ state, commandRecord, yearRecord });
}
