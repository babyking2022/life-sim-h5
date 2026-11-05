import {
  type P3EErrorCode,
  type P3ELifeState
} from "@life-sim/contracts";
import { P3EError } from "./errors";
import { readP3EState } from "./state-invariants";

/**
 * P3-E 的決定性 state codec（H5-CTO-076-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * encodeP3EState(input: unknown): string     // 驗證 → 固定欄位投影 → 固定鍵序 JSON
 * decodeP3EState(input: unknown): P3ELifeState
 * ```
 *
 * ## 決定性
 *
 * - 編碼結果是**單一 canonical JSON 字串**：固定 21 個欄位、固定鍵序、無空白、
 *   三個 bigint 金額轉成**無前導零的 canonical 十進位字串**（`"0"`／`"-1"`／`"1900000"`）。
 * - 相同 state 重複 `encode` 必須 byte-identical；`decode(encode(state))` 逐欄等於原 state。
 * - 沒有 `JSON.stringify(state)`：欄位投影是**手寫**的，不用 spread 自動收錄權威欄位。
 *
 * ## 信任邊界
 *
 * - `encode` **先呼叫 `readP3EState`**：不接受未驗證的物件、也不接受 `stateHash` 不符的 state。
 * - `decode` **只驗證輸入既有的 `stateHash`**（透過 `readP3EState`），
 *   **不會**呼叫 `sealP3EState`、也不重算覆蓋——被篡改的存檔一律 `E_P3E_HASH`。
 * - JSON／傳輸／金額字串格式錯誤 → `E_P3E_CODEC`；state 語意與 hash 錯誤則保留
 *   `readP3EState` 原本的精確錯誤碼與 path。
 */

/* ------------------------------------------------------------------ */
/* 常數                                                                */
/* ------------------------------------------------------------------ */

/** 編碼字串長度上限（DoS 防護；合法 state 遠小於此值）。 */
const MAX_ENCODED_LENGTH = 1_048_576;

/** canonical 金額：可選負號 ＋ 無前導零的十進位（"0" 允許，"-0" 由另外的檢查拒絕）。 */
const MONEY_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 頂層 21 欄（順序即 canonical 鍵序）。 */
const STATE_KEYS = [
  "schemaVersion",
  "rulesetVersion",
  "rollSpecVersion",
  "lifeSpecVersion",
  "contentVersion",
  "saveFormatVersion",
  "engineVersion",
  "rngSpecVersion",
  "identity",
  "packs",
  "currentYear",
  "age",
  "phase",
  "pendingDecision",
  "stats",
  "assets",
  "flags",
  "occurrences",
  "rng",
  "heads",
  "commandLog",
  "stateHash"
] as const;

const ASSET_KEYS = ["balanceMicroUsd", "annualIncomeMicroUsd", "annualExpenseMicroUsd"] as const;

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function fail(code: P3EErrorCode, path: string): never {
  throw new P3EError(code, path);
}

/* ------------------------------------------------------------------ */
/* Encode                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把一個**已驗證**的 state 編成 canonical JSON 字串。
 *
 * 先 `readP3EState`（shape ＋ 跨欄位不變量 ＋ `stateHash`）；未通過就直接拋該函式的精確錯誤。
 * 之後的欄位投影逐欄手寫，鍵序固定，因此輸出可以逐位元比較。
 */
export function encodeP3EState(input: unknown): string {
  const state = readP3EState(input);
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    rulesetVersion: state.rulesetVersion,
    rollSpecVersion: state.rollSpecVersion,
    lifeSpecVersion: state.lifeSpecVersion,
    contentVersion: state.contentVersion,
    saveFormatVersion: state.saveFormatVersion,
    engineVersion: state.engineVersion,
    rngSpecVersion: state.rngSpecVersion,
    identity: {
      entityId: state.identity.entityId,
      regionCode: state.identity.regionCode,
      sex: state.identity.sex,
      birthYear: state.identity.birthYear,
      certificateId: state.identity.certificateId,
      certificateHash: state.identity.certificateHash,
      playerIdentityHash: state.identity.playerIdentityHash,
      masterSeedHash: state.identity.masterSeedHash,
      basePackId: state.identity.basePackId,
      basePackChecksum: state.identity.basePackChecksum,
      identityPackId: state.identity.identityPackId,
      identityPackChecksum: state.identity.identityPackChecksum
    },
    packs: {
      events: {
        eventSchemaVersion: state.packs.events.eventSchemaVersion,
        eventSpecVersion: state.packs.events.eventSpecVersion,
        contentPackVersion: state.packs.events.contentPackVersion,
        eventPackId: state.packs.events.eventPackId,
        eventPackChecksum: state.packs.events.eventPackChecksum,
        datasetChecksum: state.packs.events.datasetChecksum,
        eventCount: state.packs.events.eventCount
      },
      death: {
        schemaVersion: state.packs.death.schemaVersion,
        deathDataVersion: state.packs.death.deathDataVersion,
        deathSpecVersion: state.packs.death.deathSpecVersion,
        healthRuleVersion: state.packs.death.healthRuleVersion,
        engineVersion: state.packs.death.engineVersion,
        rngSpecVersion: state.packs.death.rngSpecVersion,
        deathPackId: state.packs.death.deathPackId,
        deathPackChecksum: state.packs.death.deathPackChecksum,
        basePackId: state.packs.death.basePackId,
        basePackChecksum: state.packs.death.basePackChecksum,
        entityCount: state.packs.death.entityCount
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
      balanceMicroUsd: state.assets.balanceMicroUsd.toString(),
      annualIncomeMicroUsd: state.assets.annualIncomeMicroUsd.toString(),
      annualExpenseMicroUsd: state.assets.annualExpenseMicroUsd.toString()
    },
    flags: state.flags,
    occurrences: state.occurrences.map((entry) => ({
      eventId: entry.eventId,
      count: entry.count,
      lastYear: entry.lastYear
    })),
    rng: {
      life: {
        domain: state.rng.life.domain,
        initialState: state.rng.life.initialState,
        state: state.rng.life.state,
        semanticDraws: state.rng.life.semanticDraws
      },
      events: {
        domain: state.rng.events.domain,
        initialState: state.rng.events.initialState,
        state: state.rng.events.state,
        u32Draws: state.rng.events.u32Draws
      },
      death: {
        domain: state.rng.death.domain,
        initialState: state.rng.death.initialState,
        state: state.rng.death.state,
        u32Draws: state.rng.death.u32Draws
      }
    },
    heads: {
      lastEntryHash: state.heads.lastEntryHash,
      lastSnapshotHash: state.heads.lastSnapshotHash,
      lastDeltaHash: state.heads.lastDeltaHash,
      hashChain: state.heads.hashChain
    },
    commandLog: {
      count: state.commandLog.count,
      headHash: state.commandLog.headHash
    },
    stateHash: state.stateHash
  });
}

/* ------------------------------------------------------------------ */
/* Decode                                                              */
/* ------------------------------------------------------------------ */

/** canonical 金額字串 → bigint（格式錯誤一律 `E_P3E_CODEC`）。 */
function decodeMoney(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !MONEY_PATTERN.test(value) || value === "-0") {
    fail("E_P3E_CODEC", path);
  }
  return BigInt(value);
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("E_P3E_CODEC", path);
  return value as Record<string, unknown>;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.keys(record).length !== keys.length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return false;
  }
  return true;
}

/**
 * 把 canonical JSON 字串解回 `P3ELifeState`。
 *
 * - 只做 **JSON／傳輸層＋金額字串** 的檢查（`E_P3E_CODEC`）；
 * - 其餘的一切（shape、單欄範圍、跨欄位不變量、`stateHash`）都交給 `readP3EState`，
 *   因此錯誤碼與 path 與直接驗證一模一樣；
 * - **不重算、不覆蓋** `stateHash`：被篡改的輸入一定 `E_P3E_HASH at stateHash`。
 */
export function decodeP3EState(input: unknown): P3ELifeState {
  if (typeof input !== "string") fail("E_P3E_CODEC", "input");
  if (input.length > MAX_ENCODED_LENGTH) fail("E_P3E_CODEC", "input");

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail("E_P3E_CODEC", "input");
  }

  const record = readRecord(parsed, "state");
  for (const key of Object.keys(record)) {
    if (POLLUTION_KEYS.has(key)) fail("E_P3E_CODEC", "state");
  }
  if (!hasExactKeys(record, STATE_KEYS)) fail("E_P3E_CODEC", "state");

  const assets = readRecord(record.assets, "assets");
  if (!hasExactKeys(assets, ASSET_KEYS)) fail("E_P3E_CODEC", "assets");

  // 逐欄手寫（不用 spread）：只有 assets 需要把金額字串轉回 bigint，其餘原樣交給
  // `readP3EState` 做完整驗證，因此少／多欄、型別、範圍、不變量與 hash 都由它回報。
  const candidate = {
    schemaVersion: record.schemaVersion,
    rulesetVersion: record.rulesetVersion,
    rollSpecVersion: record.rollSpecVersion,
    lifeSpecVersion: record.lifeSpecVersion,
    contentVersion: record.contentVersion,
    saveFormatVersion: record.saveFormatVersion,
    engineVersion: record.engineVersion,
    rngSpecVersion: record.rngSpecVersion,
    identity: record.identity,
    packs: record.packs,
    currentYear: record.currentYear,
    age: record.age,
    phase: record.phase,
    pendingDecision: record.pendingDecision,
    stats: record.stats,
    assets: {
      balanceMicroUsd: decodeMoney(assets.balanceMicroUsd, "assets.balanceMicroUsd"),
      annualIncomeMicroUsd: decodeMoney(assets.annualIncomeMicroUsd, "assets.annualIncomeMicroUsd"),
      annualExpenseMicroUsd: decodeMoney(assets.annualExpenseMicroUsd, "assets.annualExpenseMicroUsd")
    },
    flags: record.flags,
    occurrences: record.occurrences,
    rng: record.rng,
    heads: record.heads,
    commandLog: record.commandLog,
    stateHash: record.stateHash
  };

  return readP3EState(candidate);
}
