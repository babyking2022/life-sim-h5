import type { P3ELifeState } from "@life-sim/contracts";
import { P3EError } from "./errors";
import { createP3EGenesis } from "./genesis";
import {
  readP3ELedgerHistory,
  type P3ELedgerHistory,
  type P3ELedgerHistoryRecordPair
} from "./ledger-history";
import {
  executeP3ECommand,
  type P3ECommandExecutionResult,
  type P3ECommandOutcome
} from "./command-executor";

/**
 * H5-CTO-180-A：P3-E Ledger Replay V1（正式主線整合）。
 *
 * H5-CTO-183-A（2t）：結果追加 `lastOutcome`（最後一筆重執行命令的權威 outcome），
 * 並改由模擬公開 façade 匯出（`replayP3ELedgerHistory`／`P3EReplayDivergenceError`／
 * 兩個型別）；`readP3ELedgerHistory` 仍保持私有。
 *
 * 來源：WorkBuddy 候選 `p3e-replay-v1-candidate.ts`（H5-CTO-175-B／-R1）
 * （SHA-256 `c3eae718d142761cc9f3fe109b0d5c5e120297cff2ea7b7131ac6636bfea98fb`，
 * 經 H5-CTO-180-A 正式整合；來源語意與測試全部保留）。
 *
 * ```ts
 * replayP3ELedgerHistory(input: unknown): P3EReplayResult
 * ```
 *
 * input 是 **exact-object 兩欄** descriptor：`{genesisInput, history}`。
 * 輸出 deep frozen `{state, history, commandsConsumed}`。
 *
 * ## 固定演算法順序
 *
 * 1. input 層：exact-object 兩欄，只接受 **own enumerable data descriptor**
 *    （getter **不會**被執行；不可列舉的必要／額外欄位、accessor、symbol →
 *    `E_P3E_REPLAY at p3eReplay.input`）；
 * 2. 讀取 genesisInput 的六欄 descriptor（`masterSeed`／`basePack`／
 *    `identityPack`／`certificate`／`eventPack`／`deathPack`；同樣只接受
 *    own enumerable data descriptor；違反 →
 *    `E_P3E_REPLAY at p3eReplay.input.genesisInput`）；
 * 3. `createP3EGenesis(genesisInput)` **恰好一次**（驗證錯誤原樣外拋；
 *    不信任任何外部宣稱的初始 State）；
 * 4. `readP3ELedgerHistory(history)` **恰好一次**（驗證錯誤原樣外拋）；
 * 5. 比較 Genesis anchor 三欄（`stateHash`／`commandHeadHash`／`chainHash`）：
 *    divergence → `P3EReplayDivergenceError`，path 為
 *    `p3eReplay.initial.<field>`，`index = 0`、`year = genesis.currentYear`；
 * 6. 逐 Pair：用**紀錄中的 command** 呼叫 `executeP3ECommand` **恰好一次**，
 *    eventPack／deathPack 取自**同一個** validated genesisInput；
 * 7. 逐一比較實際 `commandRecord` 與 `yearRecord` 的**每一個欄位**
 *    （固定 `Object.keys` 順序；第一個不同的欄位 → divergence，path 為
 *    `p3eReplay.records[<index>].<field>`）；
 * 8. **停在第一個 divergence**（不繼續執行、不回傳部分結果）；
 * 9. 全部一致 → 回傳 `{state, history, commandsConsumed}`。
 *
 * ## 信任邊界
 *
 * - **不信任任何 saved final state**：最終 State 只能來自逐步重執行；
 * - **不重複業務邏輯**：轉移／事件／mortality／Core Draft／hash 全部由
 *   `executeP3ECommand`（正式）與 `createP3EGenesis` 原語承擔；
 * - **不重複 hash 重算**：本模組只做欄位相等比較，不自行實作任何 hash；
 * - `genesisInput`／`history`／所有中間資料**零修改**；無時間、隨機、
 *   網路或儲存；完全決定論。
 *
 * ## Divergence index／year 約定
 *
 * - anchor slot：`index = 0`、`year = genesis.currentYear`
 *   （Record 的 `index` 從 1 開始，0 不會與任何 Record 衝突）；
 * - Pair slot：`index = commandRecord.index`、`year = commandRecord.year`。
 *
 * ## 錯誤
 *
 * - input 邊界：`E_P3E_REPLAY`（本模組唯一自行拋出的錯誤碼）；
 * - `createP3EGenesis`／`readP3ELedgerHistory`／`executeP3ECommand` 的
 *   驗證錯誤**原樣**外拋（本模組不包裝、不折疊）；
 * - divergence：`P3EReplayDivergenceError`（`E_P3E_REPLAY`）。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** `replayP3ELedgerHistory` 的成功輸出（四項全部 deep frozen）。 */
export interface P3EReplayResult {
  readonly state: P3ELifeState;
  /** 屬性名以字串節點書寫（`history` 是 DOM/BOM 全域名，不得以裸識別子出現）。 */
  readonly "history": P3ELedgerHistory;
  readonly commandsConsumed: number;
  /**
   * 最後一筆重執行命令的 outcome（空 History 為 null）。
   *
   * 這是「重執行」產生的權威 outcome（含 pendingDecision 的可呈現選項／死亡 outcome），
   * 不是 payload 宣稱值；application 只用它在 restore 後還原 `lastOutcome`。
   */
  readonly lastOutcome: P3ECommandOutcome | null;
  /**
   * 逐命令的權威 outcome（順序與 History 相同；GPT-0031-A）。
   *
   * 只用於 application 的 presentation projection（`lifeLog`）：重播時每一年的
   * 事件 id／決策／重心／死因都必須與即時遊玩完全相同，因此由同一條重執行路徑
   * 產生，而不是另外再跑一次。
   */
  readonly outcomes: readonly P3ECommandOutcome[];
}

/** divergence 詳情（`expected`／`actual` 為欄位值的 JSON digest 字串）。 */
export interface P3EReplayDivergenceDetail {
  readonly index: number;
  readonly year: number;
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
  readonly path: string;
}

/**
 * Replay divergence 錯誤：`E_P3E_REPLAY`。
 *
 * 五個 readonly 診斷欄位（`index`／`year`／`field`／`expected`／`actual`）；
 * `path` 依 slot 為 `p3eReplay.initial.<field>` 或
 * `p3eReplay.records[<index>].<field>`。
 */
export class P3EReplayDivergenceError extends P3EError {
  public readonly index: number;
  public readonly year: number;
  public readonly field: string;
  public readonly expected: string;
  public readonly actual: string;

  constructor(detail: P3EReplayDivergenceDetail) {
    super("E_P3E_REPLAY", detail.path);
    this.index = detail.index;
    this.year = detail.year;
    this.field = detail.field;
    this.expected = detail.expected;
    this.actual = detail.actual;
  }
}

/* ------------------------------------------------------------------ */
/* 常數                                                                */
/* ------------------------------------------------------------------ */

/** input 兩欄。 */
const INPUT_KEYS = ["genesisInput", "history"] as const;
/** genesisInput 六欄 descriptor。 */
const GENESIS_INPUT_KEYS = [
  "masterSeed",
  "basePack",
  "identityPack",
  "certificate",
  "eventPack",
  "deathPack"
] as const;
/** anchor 三欄。 */
const ANCHOR_KEYS = ["stateHash", "commandHeadHash", "chainHash"] as const;

const PATH_INPUT = "p3eReplay.input";
const PATH_GENESIS_INPUT = "p3eReplay.input.genesisInput";

/** 錨定 slot：anchor 的 index（Record index 從 1 開始）。 */
const ANCHOR_INDEX = 0;

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function failInput(): never {
  throw new P3EError("E_P3E_REPLAY", PATH_INPUT);
}

function failGenesisInput(): never {
  throw new P3EError("E_P3E_REPLAY", PATH_GENESIS_INPUT);
}

/* ------------------------------------------------------------------ */
/* 信任邊界：descriptor-only exact-object 讀取                          */
/* ------------------------------------------------------------------ */

/**
 * exact-object 讀取器（兩處呼叫站共用）。
 *
 * - **own enumerable data descriptor** 才是合法欄位：`Object.keys(input).length`
 *   必須恰好等於 `keys.length`（不可列舉的**必要欄位** → 拒絕），
 *   且 `Object.getOwnPropertyNames(input).length` 也必須恰好等於
 *   `keys.length`（不可列舉或可列舉的**額外欄位** → 拒絕）；
 * - accessor（getter／setter）**不會被執行**（只取 data property 的 `value`；
 *   accessor descriptor → 拒絕）；
 * - symbol 鍵、多欄、少欄、改名 → 拒絕；
 * - 陣列、非 plain prototype → 拒絕；
 * - 任何反射失敗（revoked Proxy、trap 拋錯）→ 一律折成對應 path 的
 *   `E_P3E_REPLAY`。
 */
function readExactObject(
  input: unknown,
  keys: readonly string[],
  path: "input" | "genesisInput"
): ReadonlyMap<string, unknown> {
  const result = new Map<string, unknown>();
  let complete = false;
  try {
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const proto = Object.getPrototypeOf(input) as object | null;
      if (proto === Object.prototype || proto === null) {
        if (Object.getOwnPropertySymbols(input).length === 0) {
          const names = Object.getOwnPropertyNames(input);
          if (names.length === keys.length && Object.keys(input).length === keys.length) {
            complete = true;
            for (const key of keys) {
              if (!names.includes(key)) {
                complete = false;
                break;
              }
              const descriptor = Object.getOwnPropertyDescriptor(input, key);
              if (
                descriptor === undefined ||
                descriptor.enumerable !== true ||
                !("value" in descriptor)
              ) {
                complete = false;
                break;
              }
              result.set(key, descriptor.value);
            }
          }
        }
      }
    }
  } catch {
    complete = false;
  }
  if (!complete) {
    if (path === "input") failInput();
    failGenesisInput();
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 欄位比較                                                            */
/* ------------------------------------------------------------------ */

/** 欄位值 digest：`JSON.stringify`（Record 欄位沒有 bigint；字串最穩定）。 */
function digest(value: unknown): string {
  return String(JSON.stringify(value));
}

/** Genesis State 對 anchor 三欄的實際值（唯一映射；不自行重算任何 hash）。 */
function actualAnchorField(field: string, genesis: P3ELifeState): string {
  if (field === "stateHash") return genesis.stateHash;
  if (field === "commandHeadHash") return genesis.commandLog.headHash;
  return genesis.heads.hashChain;
}

/** 比較一組 Record 的指定欄位（第一個不同即拋出）。 */
function compareRecordFields<R>(
  index: number,
  year: number,
  expected: R,
  actual: R,
  fields: readonly (keyof R)[]
): void {
  for (const field of fields) {
    const expectedDigest = digest(expected[field]);
    const actualDigest = digest(actual[field]);
    if (expectedDigest !== actualDigest) {
      throw new P3EReplayDivergenceError({
        index,
        year,
        field: String(field),
        expected: expectedDigest,
        actual: actualDigest,
        path: `p3eReplay.records[${index}].${String(field)}`
      });
    }
  }
}

/**
 * Pair 欄位比較採**兩階段、語意優先**：
 *
 * 1. **語意欄位**（由執行結果決定；read 的 hash 驗證管不到的偽造面）——
 *    先 commandRecord 的 index..stateHashAfter，再 yearRecord 的 index..deltaHash；
 * 2. **hash 連結欄位**（read 已逐欄重算驗證過；縱深防禦仍全比）——
 *    commandRecord 的 entryHash/commandHash，再 yearRecord 的 entryHash/commandHash/
 *    prevChainHash/chainHash。
 *
 * 這個順序是必要的：read 的 `verifyP3EYearLedgerRecord` 把
 * `commandRecord.entryHash` 鎖在 yearRecord 欄位的重算結果上，因此任何能通過
 * read 的 yearRecord 偽造都必然改動 entryHash——若整份 commandRecord 先比，
 * 分歧永遠先落在 `commandRecord.entryHash`，yearRecord 欄位比較不可能成為
 * 第一個分歧。語意欄位先比讓兩種偽造（yearRecord 語意欄位／執行結果
 * stateHashAfter）都能被精確定位。
 */
const COMMAND_SEMANTIC_FIELDS = [
  "index",
  "year",
  "command",
  "argsHash",
  "prevCommandHash",
  "stateHashBefore",
  "stateHashAfter"
] as const;
const COMMAND_HASH_FIELDS = ["entryHash", "commandHash"] as const;
const YEAR_SEMANTIC_FIELDS = [
  "index",
  "year",
  "age",
  "phase",
  "stateHashBefore",
  "stateHashAfter",
  "rngBefore",
  "rngAfter",
  "snapshotHash",
  "deltaHash"
] as const;
const YEAR_HASH_FIELDS = ["entryHash", "commandHash", "prevChainHash", "chainHash"] as const;

/** 比較一對已驗證 Pair（兩階段：語意欄位、hash 連結欄位）。 */
function comparePair(
  expected: P3ELedgerHistoryRecordPair,
  actual: P3ECommandExecutionResult
): void {
  const index = expected.commandRecord.index;
  const year = expected.commandRecord.year;
  compareRecordFields(index, year, expected.commandRecord, actual.commandRecord, COMMAND_SEMANTIC_FIELDS);
  compareRecordFields(index, year, expected.yearRecord, actual.yearRecord, YEAR_SEMANTIC_FIELDS);
  compareRecordFields(index, year, expected.commandRecord, actual.commandRecord, COMMAND_HASH_FIELDS);
  compareRecordFields(index, year, expected.yearRecord, actual.yearRecord, YEAR_HASH_FIELDS);
}

/** 比較 Genesis anchor 三欄（slot：`p3eReplay.initial.<field>`）。 */
function compareAnchor(genesis: P3ELifeState, anchor: P3ELedgerHistory["initial"]): void {
  for (const field of ANCHOR_KEYS) {
    const expectedDigest = digest(anchor[field]);
    const actualDigest = digest(actualAnchorField(field, genesis));
    if (expectedDigest !== actualDigest) {
      throw new P3EReplayDivergenceError({
        index: ANCHOR_INDEX,
        year: genesis.currentYear,
        field,
        expected: expectedDigest,
        actual: actualDigest,
        path: `p3eReplay.initial.${field}`
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 重放一個 Ledger History：從 genesisInput 重建 Genesis，逐一用紀錄中的
 * command 重執行，比較每一對 Record 的每一個欄位；全部一致才回傳最終
 * State 與已驗證 History。
 */
export function replayP3ELedgerHistory(input: unknown): P3EReplayResult {
  // 1. input 層：exact-object 兩欄（own enumerable data descriptors）
  const values = readExactObject(input, INPUT_KEYS, "input");

  // 2. genesisInput 六欄 descriptor（own enumerable data descriptors）
  const genesisValues = readExactObject(
    values.get("genesisInput"),
    GENESIS_INPUT_KEYS,
    "genesisInput"
  );

  // 3. Genesis 恰好一次（錯誤原樣外拋；pack descriptors 與 4. 同源）
  const genesis = createP3EGenesis(values.get("genesisInput"));
  const eventPack = genesisValues.get("eventPack");
  const deathPack = genesisValues.get("deathPack");

  // 4. History 恰好一次（完整驗證；錯誤原樣外拋）
  const ledger = readP3ELedgerHistory(values.get("history"));

  // 5. Genesis anchor 三欄
  compareAnchor(genesis, ledger.initial);

  // 6–8. 逐 Pair 重執行 + 全欄位比較（停在第一個 divergence）
  let state: P3ELifeState = genesis;
  let lastOutcome: P3ECommandOutcome | null = null;
  const outcomes: P3ECommandOutcome[] = [];
  for (const pair of ledger.records) {
    const actual = executeP3ECommand({
      state,
      eventPack,
      deathPack,
      command: pair.commandRecord.command
    });
    comparePair(pair, actual);
    state = actual.state;
    lastOutcome = actual.outcome;
    outcomes.push(actual.outcome);
  }

  // 9. deep frozen 結果（state／history 已由原語深層凍結；補凍結容器）
  return deepFreeze({
    state,
    history: ledger,
    commandsConsumed: ledger.records.length,
    lastOutcome,
    outcomes: Object.freeze(outcomes)
  });
}

/** 遞迴凍結（Record／RNG words／bigint／number 走 false 分支）。 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
