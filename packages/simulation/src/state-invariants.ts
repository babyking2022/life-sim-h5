import { deriveEventRngState, Xoshiro128StarStar } from "@life-sim/engine";
import {
  P3B_CONTENT_VERSION_PATTERN,
  P3B_EVENT_SPEC_VERSION,
  P3B_SCHEMA_VERSION,
  P3D_DATA_VERSION_PATTERN,
  P3D_DEATH_SPEC_VERSION,
  P3D_ENGINE_VERSION,
  P3D_HEALTH_RULE_VERSION,
  P3D_RNG_SPEC_VERSION,
  P3D_SCHEMA_VERSION,
  P3E_GENESIS_SEMANTIC_DRAWS,
  P3E_LIFESPAN_BURN_BOUND,
  P3E_MAX_AGE,
  P3E_MAX_OCCURRENCES,
  P3E_MAX_U32_DRAWS_PER_DEATH_YEAR,
  P3E_MAX_U32_DRAWS_PER_EVENT,
  P3E_MIN_AGE,
  P3E_ROLL_SEMANTIC_DRAWS,
  type P3EErrorCode,
  type P3EEventOccurrence,
  type P3ELifeState,
  type P3EWordTuple
} from "@life-sim/contracts";
import { P3EError } from "./errors";
import { drawP3ERollDeltas } from "./roll";
import { readP3EStateShape } from "./state";
import { computeP3EStateHash, createP3EGenesisIntegrity } from "./state-hash";

/**
 * P3-E 完整 state 讀取入口（H5-CTO-070-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * readP3EState(input: unknown): P3ELifeState
 * ```
 *
 * 固定順序（語意錯誤一定在 hash mismatch 之前回報，不讓過期的 `stateHash` 掩蓋真正的欄位錯誤）：
 *
 * 1. **Shape**：`readP3EStateShape`（已凍結）產生獨立、深層凍結的安全快照；
 * 2. **Pack 版本與跨綁定**：事件／死亡包版本、identity ↔ death pack 的 basePack 綁定；
 * 3. **年份與 phase**：`currentYear === birthYear + age`、age 0／120 的 phase 規則；
 * 4. **flags／occurrences**：嚴格升冪（含唯一）與年度上限；
 * 5. **年度收支欄位**：**不驗**（H5-CTO-146-A）。Roll 層負責基準公式；事件／決策 effects
 *    可以合法改寫收入／支出，因此最終 State 只靠 shape 檢查「bigint、≥ 0、≤ Money 上限」；
 * 6. **RNG 會計與實際游標轉移**：life 的 burn ＋ 逐年 roll、event／death 的 u32 轉移；
 * 7. **age=0 Genesis integrity**：flags／occurrences 空、event／death 游標未動、
 *    四個 head 與 command 摘要等於 `createP3EGenesisIntegrity`；
 * 8. **`stateHash` 比對**：重算 `computeP3EStateHash(snapshot)`。
 *
 * 本批**不確定**的死因／死亡順序細節、decision payload、validated event pack 實體比對
 * 都留給 Genesis／年度交易批次。
 *
 * ## 迴圈上限
 *
 * 所有迴圈都有契約上限：`age <= P3E_MAX_AGE`；event `u32Draws <= P3E_MAX_U32_DRAWS_PER_EVENT × age`；
 * death `u32Draws <= P3E_MAX_U32_DRAWS_PER_DEATH_YEAR × age`。上限檢查都在迴圈之前，
 * 因此不存在未設上限的計數。
 */

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function fail(code: P3EErrorCode, path: string): never {
  throw new P3EError(code, path);
}

const EVENT_PACK_PATH = "packs.events";
const DEATH_PACK_PATH = "packs.death";

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function copyWords(words: P3EWordTuple): P3EWordTuple {
  return [words[0], words[1], words[2], words[3]];
}

/** 四個字逐一比對（不是參考相等，也不依賴陣列方法）。 */
function sameWords(left: readonly number[], right: readonly number[]): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2] && left[3] === right[3];
}

/** 從 `initial` 精確呼叫 `nextU32()` 共 `draws` 次之後的 state（draws 已由呼叫端設限）。 */
function advanceU32(initial: P3EWordTuple, draws: number): P3EWordTuple {
  const rng = new Xoshiro128StarStar([initial[0], initial[1], initial[2], initial[3]]);
  for (let index = 0; index < draws; index += 1) rng.nextU32();
  return rng.state;
}

/* ------------------------------------------------------------------ */
/* 2. Pack 版本與跨綁定                                                */
/* ------------------------------------------------------------------ */

function assertPackVersions(state: P3ELifeState): void {
  const events = state.packs.events;
  if (events.eventSchemaVersion !== P3B_SCHEMA_VERSION) fail("E_P3E_EVENT_PACK", `${EVENT_PACK_PATH}.eventSchemaVersion`);
  if (events.eventSpecVersion !== P3B_EVENT_SPEC_VERSION) fail("E_P3E_EVENT_PACK", `${EVENT_PACK_PATH}.eventSpecVersion`);
  if (!P3B_CONTENT_VERSION_PATTERN.test(events.contentPackVersion)) {
    fail("E_P3E_EVENT_PACK", `${EVENT_PACK_PATH}.contentPackVersion`);
  }

  const death = state.packs.death;
  if (death.schemaVersion !== P3D_SCHEMA_VERSION) fail("E_P3E_DEATH_PACK", `${DEATH_PACK_PATH}.schemaVersion`);
  if (death.deathSpecVersion !== P3D_DEATH_SPEC_VERSION) fail("E_P3E_DEATH_PACK", `${DEATH_PACK_PATH}.deathSpecVersion`);
  if (death.healthRuleVersion !== P3D_HEALTH_RULE_VERSION) {
    fail("E_P3E_DEATH_PACK", `${DEATH_PACK_PATH}.healthRuleVersion`);
  }
  if (death.engineVersion !== P3D_ENGINE_VERSION) fail("E_P3E_DEATH_PACK", `${DEATH_PACK_PATH}.engineVersion`);
  if (death.rngSpecVersion !== P3D_RNG_SPEC_VERSION) fail("E_P3E_DEATH_PACK", `${DEATH_PACK_PATH}.rngSpecVersion`);
  if (!P3D_DATA_VERSION_PATTERN.test(death.deathDataVersion)) {
    fail("E_P3E_DEATH_PACK", `${DEATH_PACK_PATH}.deathDataVersion`);
  }
}

/** identity 與死亡包共用同一個 base pack；矛盾時 path 指向 death pack 的欄位。 */
function assertIdentityBinding(state: P3ELifeState): void {
  if (state.identity.basePackId !== state.packs.death.basePackId) {
    fail("E_P3E_BINDING", `${DEATH_PACK_PATH}.basePackId`);
  }
  if (state.identity.basePackChecksum !== state.packs.death.basePackChecksum) {
    fail("E_P3E_BINDING", `${DEATH_PACK_PATH}.basePackChecksum`);
  }
}

/* ------------------------------------------------------------------ */
/* 3. 年份與 phase                                                     */
/* ------------------------------------------------------------------ */

function assertYearAndPhase(state: P3ELifeState): void {
  if (state.currentYear !== state.identity.birthYear + state.age) fail("E_P3E_STATE", "currentYear");
  if (state.age === P3E_MIN_AGE) {
    // 0 歲只可能是 life（因此也排除 age=0 的 death／pending_decision）
    if (state.phase !== "life") fail("E_P3E_PHASE", "phase");
    return;
  }
  // 1–119 歲允許自然死亡；120 歲一定是 death
  if (state.age === P3E_MAX_AGE && state.phase !== "death") fail("E_P3E_PHASE", "phase");
}

/* ------------------------------------------------------------------ */
/* 4. flags 與 occurrences                                              */
/* ------------------------------------------------------------------ */

/**
 * `phase` 與 `pendingDecision` 的關係（`p3e-2` 起）。
 *
 * - `phase === "pending_decision"` **若且唯若** `pendingDecision !== null`；
 * - `year`／`age` 必須等於 State 的 `currentYear`／`age`（避免摘要與狀態漂移）。
 *
 * age=0（只能是 life）與 age=120（必須是 death）因此都必然要求 `null`，不需要另外寫死。
 * 這裡只做 State 自洽驗證；與實際 event pack 的 eventId／decisionId／optionIds 交叉比對
 * 留給下一個 State 組裝／決策命令批次。
 */
function assertPendingDecision(state: P3ELifeState): void {
  const pending = state.pendingDecision;
  if (state.phase === "pending_decision") {
    if (pending === null) fail("E_P3E_DECISION", "pendingDecision");
  } else if (pending !== null) {
    fail("E_P3E_PHASE", "phase");
  }
  if (pending === null) return;
  if (pending.year !== state.currentYear) fail("E_P3E_DECISION", "pendingDecision.year");
  if (pending.age !== state.age) fail("E_P3E_DECISION", "pendingDecision.age");
}

function assertFlags(state: P3ELifeState): void {
  let previous: string | null = null;
  for (let index = 0; index < state.flags.length; index += 1) {
    const current = state.flags[index] as string;
    // 嚴格升冪（同時代表不得重複）；pattern 與容量已由 shape reader 負責。
    if (previous !== null && !(previous < current)) fail("E_P3E_STATE", `flags[${index}]`);
    previous = current;
  }
}

function assertOccurrences(state: P3ELifeState): void {
  const occurrences = state.occurrences;
  const limit = Math.min(P3E_MAX_OCCURRENCES, state.packs.events.eventCount, state.age);
  if (occurrences.length > limit) fail("E_P3E_EVENT", "occurrences");

  const birthYear = state.identity.birthYear;
  let total = 0;
  let previousId: string | null = null;
  for (let index = 0; index < occurrences.length; index += 1) {
    const entry = occurrences[index] as P3EEventOccurrence;
    const path = `occurrences[${index}]`;
    if (previousId !== null && !(previousId < entry.eventId)) fail("E_P3E_EVENT", `${path}.eventId`);
    previousId = entry.eventId;
    if (entry.lastYear < birthYear + 1 || entry.lastYear > state.currentYear) {
      fail("E_P3E_EVENT", `${path}.lastYear`);
    }
    if (entry.count > entry.lastYear - birthYear) fail("E_P3E_EVENT", `${path}.count`);
    total += entry.count;
  }
  // 每年最多記錄一個事件
  if (total > state.age) fail("E_P3E_EVENT", "occurrences");
}

/* ------------------------------------------------------------------ */
/* 5. 年度收支欄位（H5-CTO-146-A：不再是不變量）                        */
/* ------------------------------------------------------------------ */

/**
 * **這一項已經移除**（H5-CTO-146-A）。
 *
 * - `roll.ts`／`annual-roll.ts` 仍是「Roll 基準值」的唯一權威：每年 Roll 產生的
 *   `income = BASE + age × PER_YEAR`、`expense = BASE + age × PER_YEAR` 由 Roll 層驗證；
 * - 事件與決策 effects **可以合法修改** `annualIncomeMicroUsd`／`annualExpenseMicroUsd`；
 * - 因此最終 State 只要求這兩個欄位「是合法 bigint、≥ 0、不超過正式 Money 上限」——
 *   這三件事**已由 `state.ts` 的 shape reader（`readMoney`）負責**，這裡不重複實作，
 *   否則就會出現第二套 Money reader。
 *
 * 單獨一條 State 無法只靠 age 推導 effects 套用後的收支；「effects 是否真實」由
 * Transition Material／Delta／Entry／Command Record／Replay 驗證，不是 State 自洽能回答的。
 */

/* ------------------------------------------------------------------ */
/* 6. RNG 會計與游標轉移                                               */
/* ------------------------------------------------------------------ */

function assertLifeRng(state: P3ELifeState): void {
  const life = state.rng.life;
  const expectedDraws = P3E_GENESIS_SEMANTIC_DRAWS + P3E_ROLL_SEMANTIC_DRAWS * state.age;
  if (life.semanticDraws !== expectedDraws) fail("E_P3E_RNG", "rng.life.semanticDraws");

  // 從 initialState 起算：恰好一次 compatibility burn，再跑 age 次已凍結的年度 roll。
  const rng = new Xoshiro128StarStar([life.initialState[0], life.initialState[1], life.initialState[2], life.initialState[3]]);
  rng.uniformBigInt(P3E_LIFESPAN_BURN_BOUND);
  let words = copyWords(rng.state);
  for (let year = 0; year < state.age; year += 1) {
    // 重用已凍結的 roll 原語，不複製第二套四步抽樣規則。
    words = drawP3ERollDeltas(words).state;
  }
  if (!sameWords(words, life.state)) fail("E_P3E_RNG", "rng.life.state");
}

function assertEventRng(state: P3ELifeState): void {
  const events = state.rng.events;
  if (events.u32Draws % 2 !== 0) fail("E_P3E_RNG", "rng.events.u32Draws");
  // 上限必須在迴圈之前擋下。
  if (events.u32Draws > P3E_MAX_U32_DRAWS_PER_EVENT * state.age) fail("E_P3E_RNG", "rng.events.u32Draws");

  const expectedInitial = deriveEventRngState(copyWords(state.rng.life.initialState), state.identity.birthYear);
  if (!sameWords(expectedInitial, events.initialState)) fail("E_P3E_RNG", "rng.events.initialState");

  if (!sameWords(advanceU32(events.initialState, events.u32Draws), events.state)) {
    fail("E_P3E_RNG", "rng.events.state");
  }
}

function assertDeathRng(state: P3ELifeState): void {
  const death = state.rng.death;
  if (death.u32Draws % 2 !== 0) fail("E_P3E_RNG", "rng.death.u32Draws");
  // 上限必須在推進迴圈之前擋下：單一年度死亡階段最多 512 個 u32（2 sampling × 128 attempts × 2 u32），
  // 因此上限是 `512 × age`，而不是固定的 2／4（見 contracts 的 P3E_MAX_U32_DRAWS_PER_DEATH_YEAR）。
  if (death.u32Draws > P3E_MAX_U32_DRAWS_PER_DEATH_YEAR * state.age) fail("E_P3E_RNG", "rng.death.u32Draws");
  if (!sameWords(advanceU32(death.initialState, death.u32Draws), death.state)) fail("E_P3E_RNG", "rng.death.state");
}

function assertRng(state: P3ELifeState): void {
  assertLifeRng(state);
  assertEventRng(state);
  assertDeathRng(state);
}

/* ------------------------------------------------------------------ */
/* 7. age=0 的 Genesis integrity                                       */
/* ------------------------------------------------------------------ */

function assertGenesisIntegrity(state: P3ELifeState): void {
  // flags：genesis 沒有任何旗標（shape reader 只驗 pattern／容量，不管空不空）。
  if (state.flags.length !== 0) fail("E_P3E_STATE", "flags");

  // 「event／death 的 u32Draws === 0」與「current state === initialState」不需要在這裡重寫：
  // age=0 時 §七 的上限是 `P3E_MAX_U32_DRAWS_PER_EVENT × 0 = 0`（event）與
  // `P3E_MAX_U32_DRAWS_PER_DEATH_YEAR × 0 = 0`（death），任何非零 draws 都由上限先擋下；
  // 而 0 次 `nextU32()` 的轉移檢查本身就要求 `state === initialState`。
  // life 游標的「恰好一次 compatibility burn」則由 `assertLifeRng` 在 age=0 時驗證。
  const integrity = createP3EGenesisIntegrity(state);
  if (state.heads.lastEntryHash !== integrity.heads.lastEntryHash) fail("E_P3E_HISTORY", "heads.lastEntryHash");
  if (state.heads.lastSnapshotHash !== integrity.heads.lastSnapshotHash) fail("E_P3E_HISTORY", "heads.lastSnapshotHash");
  if (state.heads.lastDeltaHash !== integrity.heads.lastDeltaHash) fail("E_P3E_HISTORY", "heads.lastDeltaHash");
  if (state.heads.hashChain !== integrity.heads.hashChain) fail("E_P3E_HISTORY", "heads.hashChain");
  if (state.commandLog.count !== 0) fail("E_P3E_COMMAND", "commandLog.count");
  if (state.commandLog.headHash !== integrity.commandLog.headHash) fail("E_P3E_COMMAND", "commandLog.headHash");
}

/* ------------------------------------------------------------------ */
/* 8. stateHash                                                        */
/* ------------------------------------------------------------------ */

function assertStateHash(state: P3ELifeState): void {
  // 只有相符／不符兩種結果；沒有 verifyHash=false 之類的繞過參數。
  if (computeP3EStateHash(state) !== state.stateHash) fail("E_P3E_HASH", "stateHash");
}

/* ------------------------------------------------------------------ */
/* 唯一入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 驗證並回傳 `P3ELifeState` 的安全快照（shape ＋ 跨欄位語意 ＋ stateHash）。
 *
 * 成功時回傳的就是 `readP3EStateShape` 產生的那一份快照（已深層凍結、與輸入斷開）。
 */
export function readP3EState(input: unknown): P3ELifeState {
  const state = readP3EStateShape(input);
  assertPackVersions(state);
  assertIdentityBinding(state);
  assertYearAndPhase(state);
  assertPendingDecision(state);
  assertFlags(state);
  assertOccurrences(state);
  assertRng(state);
  if (state.age === P3E_MIN_AGE) assertGenesisIntegrity(state);
  assertStateHash(state);
  return state;
}
