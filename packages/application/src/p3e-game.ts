import type { P3ELifeState } from "@life-sim/contracts";
import {
  createP3EGenesis,
  executeP3ECommand,
  type P3ECommandExecutionResult
} from "@life-sim/simulation";

/**
 * P3-E.1b-2l：最小可玩公開 façade（H5-CTO-166-A）。
 *
 * application 是唯一被允許「用」P3-E 的上層套件；本模組只做**編排**，
 * 不重寫任何模擬邏輯。
 *
 * ## 兩個入口
 *
 * ```ts
 * createP3EGame(input: unknown): P3ELifeState
 * runP3EGameCommand(input: P3EGameCommandInput): P3ECommandExecutionResult
 * ```
 *
 * - `createP3EGame` 只轉呼叫 `createP3EGenesis`（出生流程、pack 驗證、RNG、
 *   stateHash 全部在 simulation 內完成）；
 * - `runP3EGameCommand` 只轉呼叫 `executeP3ECommand`（年度 Roll、事件抽選、
 *   effects、死亡、pending decision、Record 建立、Ledger Append 全部在
 *   simulation 內完成），輸出 `{ state, commandRecord, yearRecord }` **原樣轉出**。
 *
 * ## 責任邊界
 *
 * - **不**建立第二套 State／Record／Hash／RNG／Roll／事件／死亡／decision 演算法；
 * - **不**吞掉、改寫或重新包裝 `P3EError`（含 input shape 錯誤）——錯誤原樣外傳；
 * - **不**修改輸入（兩個入口都只讀 input，輸出是深層凍結的新物件）；
 * - **不**保存任何全域 mutable state：相同 seed／packs／commands 必得完全一致輸出；
 * - **不**建立 Ledger History：每次命令只回傳本次 Command Record／Year Record，
 *   完整歷史屬獨立的 Ledger History 批次，本 façade 不依賴它。
 *
 * 本模組不進 `@life-sim/simulation` 的公開 barrel；它只是 simulation 公開
 * façade 的使用端。
 */

/** `runP3EGameCommand` 的輸入（四欄，交由 command executor 做信任邊界檢查）。 */
export interface P3EGameCommandInput {
  readonly state: unknown;
  readonly eventPack: unknown;
  readonly deathPack: unknown;
  readonly command: unknown;
}

/**
 * 建立一場 P3-E 遊戲的 age 0 出生 State。
 *
 * 只編排 `createP3EGenesis`：input 必須是 exact-object 六欄
 * （`masterSeed`／`basePack`／`identityPack`／`certificate`／`eventPack`／`deathPack`），
 * 任何不合法輸入都由 simulation 以 `P3EError` 拒絕，本層不加也不改錯誤。
 */
export function createP3EGame(input: unknown): P3ELifeState {
  return createP3EGenesis(input);
}

/**
 * 執行一筆 P3-E 命令（`ADVANCE_YEAR` 或 `CHOOSE_DECISION`）。
 *
 * 只編排 `executeP3ECommand`：命令合法性、phase 檢查、pack binding、金錢 effect、
 * Record 與 chain 全部由 simulation 決定；本層原樣轉出四項輸出
 * （`state`／`commandRecord`／`yearRecord`／`outcome`）。
 *
 * 本層**不**重建、不改寫、也不選擇性丟棄 outcome 的任何欄位（含 `death.causeId`）；
 * `outcome` 就是 simulation 回傳的同一個凍結物件。失敗時不回傳任何部分結果。
 */
export function runP3EGameCommand(input: P3EGameCommandInput): P3ECommandExecutionResult {
  return executeP3ECommand(input);
}
