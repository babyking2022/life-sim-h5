import {
  type P3EAssets,
  type P3EErrorCode,
  type P3ELifeRngState,
  type P3EStats,
  type P3EWordTuple
} from "@life-sim/contracts";
import { P3EError } from "./errors";
import { resolveP3ERoll } from "./roll";
import { readP3EState } from "./state-invariants";

/**
 * 年度 Roll 交易轉接層（H5-CTO-082-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * resolveP3EAnnualRoll(input: unknown): P3EAnnualRollResult
 * ```
 *
 * 這一層只做三件事：
 *
 * 1. 驗證 `{ state }` 這個 exact-object（反射失敗 → `E_P3E_ARGUMENT at input`）；
 * 2. 用 **已凍結的** `readP3EState` 驗證 state（錯誤原樣轉出）；
 * 3. 檢查 `phase === "life"`，算出 `targetAge`／`targetYear`，
 *    把 targetAge 交給 **已凍結的** `resolveP3ERoll`，最後把結果包成獨立、深層凍結的物件。
 *
 * ## 刻意不做
 *
 * - **不複製**四次抽樣、clamp 或收支公式（`resolveP3ERoll` 是唯一實作）；
 * - 不修改、不 seal、不重新簽署 `P3ELifeState`；不處理 event／death／ledger／command／replay；
 * - 不判定死亡（119 → 120 只是完成 roll，死亡由後續 Death 階段決定）；
 * - 消耗 RNG 之後才可能成功，被拒絕的呼叫完全不消耗。
 *
 * ## 為什麼 `age` 邊界不需要另一支檢查
 *
 * `readP3EState` 已凍結「`phase === "life"` ⇒ `age ∈ [0, 119]`」（age=120 必須是 death、
 * age=0 只能是 life）。因此 `phase === "life"` 通過時 `targetAge = age + 1 ∈ [1, 120]`，
 * 恰好落在 `resolveP3ERoll` 允許的 `[0, 120]` 內——再加一次 `age + 1 > 120` 的檢查只會是
 * 永遠不會執行的死碼。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一次合法年度 roll 的完整前後值。
 *
 * 全部是**新建立**的物件／tuple（與 state 及 roll 結果零共享可變參考），並且深層凍結。
 */
export interface P3EAnnualRollResult {
  /** `p3e-roll-1.0.0`（來自回傳的 roll 結果）。 */
  readonly rollSpecVersion: string;
  readonly yearBefore: number;
  readonly yearAfter: number;
  readonly ageBefore: number;
  readonly ageAfter: number;
  readonly statsBefore: P3EStats;
  readonly statsAfter: P3EStats;
  readonly assetsBefore: P3EAssets;
  readonly assetsAfter: P3EAssets;
  /** 交易前的 life 游標（`initialState` 保留原值，`state` 是本次抽樣前的位置）。 */
  readonly lifeRngBefore: P3ELifeRngState;
  /** 交易後的 life 游標（權威 tuple 來自 `resolveP3ERoll` 的實際 state）。 */
  readonly lifeRngAfter: P3ELifeRngState;
  /** 本次固定 4 次語意抽樣（`P3E_ROLL_SEMANTIC_DRAWS`）。 */
  readonly semanticDrawsUsed: number;
}

const INPUT_KEYS = ["state"] as const;

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function fail(code: P3EErrorCode, path: string): never {
  throw new P3EError(code, path);
}

/* ------------------------------------------------------------------ */
/* 1. input shape                                                      */
/* ------------------------------------------------------------------ */

/**
 * exact-object 一欄（`state`）；任何反射失敗（已撤銷 Proxy、trap 拋錯、accessor、
 * hidden／symbol／多餘／缺少欄位、陣列、class instance、非 plain prototype）
 * 一律 `E_P3E_ARGUMENT at input`。只讀 descriptor：getter 不會被執行。
 */
function readRawInput(input: unknown): Record<string, unknown> {
  let record: Record<string, unknown> | null = null;
  try {
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const proto = Object.getPrototypeOf(input) as object | null;
      if (proto === Object.prototype || proto === null) {
        if (Object.getOwnPropertySymbols(input).length === 0) {
          const names = Object.getOwnPropertyNames(input);
          if (names.length === INPUT_KEYS.length && Object.keys(input).length === INPUT_KEYS.length) {
            const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            let complete = true;
            for (const key of INPUT_KEYS) {
              if (!names.includes(key)) {
                complete = false;
                break;
              }
              const descriptor = Object.getOwnPropertyDescriptor(input, key);
              if (descriptor === undefined || !("value" in descriptor)) {
                complete = false;
                break;
              }
              values[key] = descriptor.value;
            }
            if (complete) record = values;
          }
        }
      }
    }
  } catch {
    record = null;
  }
  if (record === null) fail("E_P3E_ARGUMENT", "input");
  return record;
}

/* ------------------------------------------------------------------ */
/* 深層凍結的獨立副本                                                  */
/* ------------------------------------------------------------------ */

function copyWords(words: P3EWordTuple): P3EWordTuple {
  const copy: [number, number, number, number] = [words[0], words[1], words[2], words[3]];
  return Object.freeze(copy);
}

function copyStats(stats: P3EStats): P3EStats {
  return Object.freeze({
    health: stats.health,
    happiness: stats.happiness,
    knowledge: stats.knowledge,
    relationships: stats.relationships
  });
}

function copyAssets(assets: P3EAssets): P3EAssets {
  return Object.freeze({
    balanceMicroUsd: assets.balanceMicroUsd,
    annualIncomeMicroUsd: assets.annualIncomeMicroUsd,
    annualExpenseMicroUsd: assets.annualExpenseMicroUsd
  });
}

function copyLifeRng(rng: P3ELifeRngState): P3ELifeRngState {
  return Object.freeze({
    domain: rng.domain,
    initialState: copyWords(rng.initialState),
    state: copyWords(rng.state),
    semanticDraws: rng.semanticDraws
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 對一個**合法** state 做一年的 roll（不落地、不改 state）。
 *
 * 固定順序：input shape → `readP3EState` → `phase` 檢查 → `targetAge`／`targetYear`
 * → `resolveP3ERoll`（用 `targetAge` 算收支）→ 深層凍結結果。
 *
 * 失敗一律是 `P3EError`：反射 → `E_P3E_ARGUMENT at input`；state → `readP3EState` 的原錯誤；
 * 非 life → `E_P3E_PHASE at phase`；roll 內部（`E_P3E_RNG`／`E_P3E_MONEY`）原樣轉出。
 */
export function resolveP3EAnnualRoll(input: unknown): P3EAnnualRollResult {
  const raw = readRawInput(input);

  // 2. state（錯誤原樣轉出；`phase`／`age` 的邊界由它保證）
  const state = readP3EState(raw.state);

  // 3. 只接受 life：pending_decision／death 必須在消耗 RNG 之前被拒絕
  if (state.phase !== "life") fail("E_P3E_PHASE", "phase");

  // 4. 目標年度／年齡（收支公式要用 targetAge，不能用交易前的 age）
  const targetAge = state.age + 1;
  const targetYear = state.currentYear + 1;

  // 5. 重用既有的 roll 實作（四次抽樣、clamp、收支公式都只有這一份）
  const roll = resolveP3ERoll({
    rollSpecVersion: state.rollSpecVersion,
    age: targetAge,
    stats: state.stats,
    balanceMicroUsd: state.assets.balanceMicroUsd,
    lifeRng: state.rng.life
  });

  // 6. 獨立、深層凍結的結果
  return Object.freeze({
    rollSpecVersion: roll.rollSpecVersion,
    yearBefore: state.currentYear,
    yearAfter: targetYear,
    ageBefore: state.age,
    ageAfter: targetAge,
    statsBefore: copyStats(state.stats),
    statsAfter: copyStats(roll.stats),
    assetsBefore: copyAssets(state.assets),
    assetsAfter: copyAssets(roll.assets),
    lifeRngBefore: copyLifeRng(state.rng.life),
    lifeRngAfter: copyLifeRng(roll.lifeRng),
    semanticDrawsUsed: roll.semanticDrawsUsed
  });
}
