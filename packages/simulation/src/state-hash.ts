import { ascii, canonicalBytes, concatBytes, sha256Hex } from "@life-sim/engine";
import {
  P3E_COMMAND_INIT_DOMAIN,
  type P3ECommandSummary,
  type P3EHex64,
  type P3EHistoryHeads,
  type P3ELifeState
} from "@life-sim/contracts";
import { P3EError } from "./errors";

/**
 * P3-E.1a-2c-1：狀態雜湊原語（套件內部，**不進公開 barrel**）。
 *
 * 本批只交付兩個原語：
 * - `computeP3EStateHash(state)`：`LIFE1/P3E/STATE/v1` 的權威 state hash；
 * - `createP3EGenesisIntegrity(binding)`：genesis 的四個 hash-chain head ＋ command 摘要。
 *
 * ## 雜湊方案（全模組統一，沒有例外）
 *
 * ```text
 * hash = sha256Hex( ascii(domain) ‖ 0x00 ‖ canonicalBytes(<明確 projection>) )
 * ```
 *
 * - domain 一律 ASCII、固定字串；
 * - 一個 `0x00` 分隔位元組；
 * - projection 是**手寫的明確物件**：每個欄位逐一列出，**不使用** `{ ...state }` 或
 *   `{ ...binding }` 之類的自動收欄位，避免未來契約新增欄位時無聲改變既有 hash；
 * - 不使用 `JSON.stringify`、不自製 canonicalizer、不讀時間／隨機數／平台編碼。
 *
 * ## 固定 domain（P3-E 專屬，不得與 P3-A／P3-C 混用）
 *
 * | domain | 用途 |
 * |---|---|
 * | `LIFE1/P3E/STATE/v1` | `stateHash` |
 * | `LIFE1/P3E/LOG/v1` | `heads.lastEntryHash` |
 * | `LIFE1/P3E/SNAPSHOT/v1` | `heads.lastSnapshotHash` |
 * | `LIFE1/P3E/DELTA/v1` | `heads.lastDeltaHash` |
 * | `LIFE1/P3E/CHAIN/INIT/v1` | `heads.hashChain`（genesis 鏈根） |
 * | `LIFE1/P3E/CHAIN/v1` | **保留**：後續年度鏈更新（本批不使用） |
 * | `LIFE1/P3E/COMMAND/INIT/v1` | `commandLog.headHash`（用 contracts 既有常數） |
 *
 * ## 本批刻意不做
 *
 * 沒有 certificate 驗證、沒有完整 state 信任邊界（逐欄位範圍／型別／不變量）、
 * 沒有 codec／ledger／replay／年度事件或死亡交易。因此本模組只做**最小**輸入防護
 * （不是物件、缺欄位、canonical 編碼失敗 → 固定 `P3EError`），不做語意驗證。
 *
 * ## 為什麼 state hash **不包含** `heads.hashChain` 與 `commandLog`（H5-CTO-063-A-R1）
 *
 * `hashChain` 與 `commandLog` 是 **replay integrity metadata**：它們由獨立的鏈驗證
 * （command record 會帶 `stateHashBefore`／`stateHashAfter`，鏈本身再被逐筆重算）。
 * 若把它們放進 state projection，就會形成**循環依賴**：
 *
 * ```text
 * stateHash  ←  hashChain        （鏈頭是 command record 的產物）
 * hashChain  ←  command record  （每筆記錄都含 stateHashBefore／After）
 * command record  ←  stateHash
 * ```
 *
 * 因此 state hash 的輸入只納入「人生本身」的權威欄位，加上三條歷史鏈的**尾端 head**
 * （`lastEntryHash`／`lastSnapshotHash`／`lastDeltaHash`：它們是已發生的年度紀錄摘要，
 * 不回頭依賴 stateHash）。`hashChain` 與 `commandLog` 不入 projection，
 * 由鏈批次用自己的 domain 驗證。
 *
 * 對應的輸入型別是 `P3EStateHashInput`：它讓 genesis 不必先塞假的 `stateHash`、
 * 假的 `hashChain` 或假的 `commandLog` 就能算 hash；完整的 `P3ELifeState` 仍可直接傳入
 * （多出來的 `stateHash`／`commandLog`／`heads.hashChain` 會被明確忽略）。
 */

/* ------------------------------------------------------------------ */
/* 固定 domain                                                         */
/* ------------------------------------------------------------------ */

const STATE_DOMAIN = "LIFE1/P3E/STATE/v1";
const LOG_DOMAIN = "LIFE1/P3E/LOG/v1";
const SNAPSHOT_DOMAIN = "LIFE1/P3E/SNAPSHOT/v1";
const DELTA_DOMAIN = "LIFE1/P3E/DELTA/v1";
/** genesis 的鏈根；後續年度用 `LIFE1/P3E/CHAIN/v1`（本批保留、未使用）。 */
const CHAIN_INIT_DOMAIN = "LIFE1/P3E/CHAIN/INIT/v1";

const PATH_STATE = "state";
const PATH_BINDING = "binding";

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/**
 * genesis 綁定：`P3ELifeState` 的「八個版本欄位 ＋ identity ＋ packs」子集。
 *
 * 用 `Pick` 而不是重新宣告欄位，讓 contracts 是唯一真相；
 * 傳入完整的 `P3ELifeState` 也結構相容（多出來的欄位一律不進 projection）。
 */
export type P3EGenesisBinding = Pick<
  P3ELifeState,
  | "schemaVersion"
  | "rulesetVersion"
  | "rollSpecVersion"
  | "lifeSpecVersion"
  | "contentVersion"
  | "saveFormatVersion"
  | "engineVersion"
  | "rngSpecVersion"
  | "identity"
  | "packs"
>;

export interface P3EGenesisIntegrity {
  readonly heads: P3EHistoryHeads;
  readonly commandLog: P3ECommandSummary;
}

/**
 * `computeP3EStateHash` 的最小輸入（H5-CTO-063-A-R1）。
 *
 * 語意 = `P3ELifeState`：
 * - 排除 `stateHash`；
 * - 排除**整個** `commandLog`；
 * - `heads` 只要求 `lastEntryHash`／`lastSnapshotHash`／`lastDeltaHash`，
 *   **不要求** `heads.hashChain`。
 *
 * 完整的 `P3ELifeState` 結構上直接相容（多出來的 `stateHash`、`commandLog`、
 * `heads.hashChain` 會被 projection 明確忽略），所以呼叫端不需要先造出假值。
 */
export type P3EStateHashInput = Omit<P3ELifeState, "stateHash" | "commandLog" | "heads"> & {
  readonly heads: Pick<P3EHistoryHeads, "lastEntryHash" | "lastSnapshotHash" | "lastDeltaHash">;
};

/* ------------------------------------------------------------------ */
/* hash 核心                                                           */
/* ------------------------------------------------------------------ */

/**
 * 唯一的雜湊入口：`domain ‖ 0x00 ‖ canonicalBytes(projection)`。
 *
 * `projection` 由呼叫端以**明確欄位**建立；此處只負責編碼與 SHA-256，
 * 不做任何欄位挑選（挑欄位的地方只有下面兩個 projection 函式）。
 */
function hashProjection(domain: string, projection: unknown): P3EHex64 {
  return sha256Hex(concatBytes(ascii(domain), Uint8Array.of(0), canonicalBytes(projection as never)));
}

/* ------------------------------------------------------------------ */
/* Projection：genesis 綁定                                            */
/* ------------------------------------------------------------------ */

/**
 * genesis 綁定的 canonical projection。
 *
 * **逐欄位手寫**：八個版本欄位、`identity` 全 12 欄、`packs.events` 全 7 欄、
 * `packs.death` 全 11 欄。刻意不使用 spread —— 契約未來新增欄位時，
 * 這裡必須由人明確加進來（並同步測試與 golden），不會無聲改變。
 *
 * 不含 `currentYear`／`age`／`stats`／`stateHash` 等「還沒有 genesis 值」的欄位。
 */
export function p3eGenesisProjection(binding: P3EGenesisBinding) {
  const identity = binding.identity;
  const events = binding.packs.events;
  const death = binding.packs.death;
  return {
    schemaVersion: binding.schemaVersion,
    rulesetVersion: binding.rulesetVersion,
    rollSpecVersion: binding.rollSpecVersion,
    lifeSpecVersion: binding.lifeSpecVersion,
    contentVersion: binding.contentVersion,
    saveFormatVersion: binding.saveFormatVersion,
    engineVersion: binding.engineVersion,
    rngSpecVersion: binding.rngSpecVersion,
    identity: {
      entityId: identity.entityId,
      regionCode: identity.regionCode,
      sex: identity.sex,
      birthYear: identity.birthYear,
      certificateId: identity.certificateId,
      certificateHash: identity.certificateHash,
      playerIdentityHash: identity.playerIdentityHash,
      masterSeedHash: identity.masterSeedHash,
      basePackId: identity.basePackId,
      basePackChecksum: identity.basePackChecksum,
      identityPackId: identity.identityPackId,
      identityPackChecksum: identity.identityPackChecksum
    },
    packs: {
      events: {
        eventSchemaVersion: events.eventSchemaVersion,
        eventSpecVersion: events.eventSpecVersion,
        contentPackVersion: events.contentPackVersion,
        eventPackId: events.eventPackId,
        eventPackChecksum: events.eventPackChecksum,
        datasetChecksum: events.datasetChecksum,
        eventCount: events.eventCount
      },
      death: {
        schemaVersion: death.schemaVersion,
        deathDataVersion: death.deathDataVersion,
        deathSpecVersion: death.deathSpecVersion,
        healthRuleVersion: death.healthRuleVersion,
        engineVersion: death.engineVersion,
        rngSpecVersion: death.rngSpecVersion,
        deathPackId: death.deathPackId,
        deathPackChecksum: death.deathPackChecksum,
        basePackId: death.basePackId,
        basePackChecksum: death.basePackChecksum,
        entityCount: death.entityCount
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Projection：完整 state                                              */
/* ------------------------------------------------------------------ */

/**
 * state hash 的 canonical projection（H5-CTO-063-A-R1 修正版）。
 *
 * 收錄「人生本身」的全部權威欄位：八個版本、`identity`、`packs`、`currentYear`、
 * `age`、`phase`、`pendingDecision`（`p3e-2` 起：null 或六欄摘要，`optionIds` 順序有影響）、
 * `stats`、`assets`（bigint 原樣，交給 `canonicalBytes` 的 bigint tag）、
 * `flags`、`occurrences`、三條 `rng` 游標，以及三條歷史鏈的**尾端 head**
 * （`lastEntryHash`／`lastSnapshotHash`／`lastDeltaHash`）。
 *
 * 明確**排除**：
 * - `stateHash` 本身（自我參照）；
 * - `heads.hashChain`：它是 command record 的產物，而 command record 又帶
 *   `stateHashBefore`／`stateHashAfter`——放進來會與鏈記錄形成循環依賴
 *   （理由見檔頭說明）；
 * - 整個 `commandLog`：同上，屬 replay integrity metadata；
 * - `lifespanYears`、年度陣列、burn 抽出的值或任何衍生快取
 *   （`P3ELifeState` 本來就沒有這些欄位；這裡明確不把它們加進來）。
 *
 * 逐欄位手寫，沒有 spread；鍵與值都來自最小輸入 `P3EStateHashInput`
 * （完整 state 多出來的欄位一律被忽略）。
 */
export function p3eStateProjection(state: P3EStateHashInput) {
  const identity = state.identity;
  const events = state.packs.events;
  const death = state.packs.death;
  const life = state.rng.life;
  const eventRng = state.rng.events;
  const deathRng = state.rng.death;
  return {
    schemaVersion: state.schemaVersion,
    rulesetVersion: state.rulesetVersion,
    rollSpecVersion: state.rollSpecVersion,
    lifeSpecVersion: state.lifeSpecVersion,
    contentVersion: state.contentVersion,
    saveFormatVersion: state.saveFormatVersion,
    engineVersion: state.engineVersion,
    rngSpecVersion: state.rngSpecVersion,
    identity: {
      entityId: identity.entityId,
      regionCode: identity.regionCode,
      sex: identity.sex,
      birthYear: identity.birthYear,
      certificateId: identity.certificateId,
      certificateHash: identity.certificateHash,
      playerIdentityHash: identity.playerIdentityHash,
      masterSeedHash: identity.masterSeedHash,
      basePackId: identity.basePackId,
      basePackChecksum: identity.basePackChecksum,
      identityPackId: identity.identityPackId,
      identityPackChecksum: identity.identityPackChecksum
    },
    packs: {
      events: {
        eventSchemaVersion: events.eventSchemaVersion,
        eventSpecVersion: events.eventSpecVersion,
        contentPackVersion: events.contentPackVersion,
        eventPackId: events.eventPackId,
        eventPackChecksum: events.eventPackChecksum,
        datasetChecksum: events.datasetChecksum,
        eventCount: events.eventCount
      },
      death: {
        schemaVersion: death.schemaVersion,
        deathDataVersion: death.deathDataVersion,
        deathSpecVersion: death.deathSpecVersion,
        healthRuleVersion: death.healthRuleVersion,
        engineVersion: death.engineVersion,
        rngSpecVersion: death.rngSpecVersion,
        deathPackId: death.deathPackId,
        deathPackChecksum: death.deathPackChecksum,
        basePackId: death.basePackId,
        basePackChecksum: death.basePackChecksum,
        entityCount: death.entityCount
      }
    },
    currentYear: state.currentYear,
    age: state.age,
    phase: state.phase,
    pendingDecision:
      state.pendingDecision === null
        ? null
        : {
            year: state.pendingDecision.year,
            age: state.pendingDecision.age,
            eventId: state.pendingDecision.eventId,
            decisionId: state.pendingDecision.decisionId,
            selectionHash: state.pendingDecision.selectionHash,
            optionIds: [...state.pendingDecision.optionIds]
          },
    stats: {
      health: state.stats.health,
      happiness: state.stats.happiness,
      knowledge: state.stats.knowledge,
      relationships: state.stats.relationships
    },
    assets: {
      balanceMicroUsd: state.assets.balanceMicroUsd,
      annualIncomeMicroUsd: state.assets.annualIncomeMicroUsd,
      annualExpenseMicroUsd: state.assets.annualExpenseMicroUsd
    },
    flags: [...state.flags],
    occurrences: state.occurrences.map((entry) => ({
      eventId: entry.eventId,
      count: entry.count,
      lastYear: entry.lastYear
    })),
    rng: {
      life: {
        domain: life.domain,
        initialState: [...life.initialState],
        state: [...life.state],
        semanticDraws: life.semanticDraws
      },
      events: {
        domain: eventRng.domain,
        initialState: [...eventRng.initialState],
        state: [...eventRng.state],
        u32Draws: eventRng.u32Draws
      },
      death: {
        domain: deathRng.domain,
        initialState: [...deathRng.initialState],
        state: [...deathRng.state],
        u32Draws: deathRng.u32Draws
      }
    },
    heads: {
      lastEntryHash: state.heads.lastEntryHash,
      lastSnapshotHash: state.heads.lastSnapshotHash,
      lastDeltaHash: state.heads.lastDeltaHash
    }
  };
}

/* ------------------------------------------------------------------ */
/* 公開原語（套件內部）                                                */
/* ------------------------------------------------------------------ */

/**
 * `LIFE1/P3E/STATE/v1` 的權威 state hash（H5-CTO-063-A-R1 修正版）。
 *
 * 輸入是 `P3EStateHashInput`（= 完整 state 減去 `stateHash`、`commandLog`、
 * 以及 `heads.hashChain`）。完整 `P3ELifeState` 可直接傳入，額外欄位會被忽略，
 * 因此 genesis 不需要先造假的 `stateHash`／`hashChain`／`commandLog`。
 *
 * 只做最小防護：不是物件、缺欄位、canonical 編碼失敗（例如 non-safe integer、
 * 未定義欄位）一律折成 `E_P3E_STATE at state`，不外洩 `CanonicalError`／`TypeError`。
 * 完整語意驗證屬後續批次的 state 信任邊界。
 */
export function computeP3EStateHash(state: P3EStateHashInput): P3EHex64 {
  if (typeof state !== "object" || state === null) throw new P3EError("E_P3E_STATE", PATH_STATE);
  try {
    return hashProjection(STATE_DOMAIN, p3eStateProjection(state));
  } catch {
    throw new P3EError("E_P3E_STATE", PATH_STATE);
  }
}

/**
 * genesis 的四個 hash-chain head ＋ command 摘要（`count = 0`）。
 *
 * 五個 head 全部由同一份 genesis binding projection 導出，但**domain 不同**，
 * 因此彼此不相等，也與日後的 `LIFE1/P3E/CHAIN/v1` 鏈更新分離。
 *
 * `heads.hashChain` ＝ `H(LIFE1/P3E/CHAIN/INIT/v1, genesis binding projection)`。
 * **H5-CTO-063-A-R1 已裁決維持這個定義**（不改成 `chainRoot(stateHash)`）：
 * 鏈根綁的是 genesis 綁定，因此不會回頭依賴 stateHash，也就不會與 command record
 * 形成循環依賴。後續年度的鏈更新使用保留的 `LIFE1/P3E/CHAIN/v1`。
 *
 * 失敗一律 `E_P3E_BINDING at binding`，不外洩引擎或原生例外。
 */
export function createP3EGenesisIntegrity(binding: P3EGenesisBinding): P3EGenesisIntegrity {
  if (typeof binding !== "object" || binding === null) throw new P3EError("E_P3E_BINDING", PATH_BINDING);
  try {
    const projection = p3eGenesisProjection(binding);
    const heads: P3EHistoryHeads = Object.freeze({
      lastEntryHash: hashProjection(LOG_DOMAIN, projection),
      lastSnapshotHash: hashProjection(SNAPSHOT_DOMAIN, projection),
      lastDeltaHash: hashProjection(DELTA_DOMAIN, projection),
      hashChain: hashProjection(CHAIN_INIT_DOMAIN, projection)
    });
    const commandLog: P3ECommandSummary = Object.freeze({
      count: 0,
      headHash: hashProjection(P3E_COMMAND_INIT_DOMAIN, projection)
    });
    return Object.freeze({ heads, commandLog });
  } catch {
    throw new P3EError("E_P3E_BINDING", PATH_BINDING);
  }
}
