import {
  P3E_DEATH_DRAWS_ALIVE,
  P3E_MAX_AGE,
  P3E_MAX_U32_DRAWS_PER_DEATH_YEAR,
  type P3BEffect,
  type P3DAnnualDeathResult,
  type P3EDeathRngState,
  type P3EErrorCode,
  type P3EWordTuple
} from "@life-sim/contracts";
import { evaluateAnnualDeath, type ValidatedDeathPack } from "@life-sim/birth";
import { P3EError } from "./errors";
import { validateP3EAnnualPacks } from "./annual-packs";
import {
  resolveP3EAnnualEventEffects,
  type P3EAnnualEventEffects,
  type P3EPendingDecision
} from "./annual-event-effects";

/**
 * 年度死亡判定轉接層（H5-CTO-099-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * resolveP3EAnnualDeath(input: unknown): P3EAnnualDeathStage
 * ```
 *
 * 串接既有的四段：年度 Roll → 事件抽選 → effects／occurrences → P3-D `evaluateAnnualDeath`。
 *
 * ## 刻意不做
 *
 * - **不建立、不修改、不 seal `P3ELifeState`**；不產生 command／ledger／chain／codec／replay 欄位。
 * - 不接受呼叫端傳入的 roll／selection／effects／死亡中間結果：一律重新執行
 *   `resolveP3EAnnualEventEffects`，並用同一組原始輸入重新取得已驗證死亡包。
 * - 不複製 P3-D 的死亡抽樣演算法；`drawsUsed` 一律用 P3-D 回傳的**真實偶數值**。
 * - 死亡優先於 pending decision：死亡年度 `pendingDecisionAfterDeath` 必為 `null`。
 *
 * ## 死亡與 age ceiling
 *
 * 即使 `ageAfter === 120`，也**先**跑一次正式 P3-D 判定（消耗真實 RNG），再套用 P3-E 的
 * 120 歲硬上限：
 *
 * 1. `mortality.died` → `deathReason = "mortality"`；
 * 2. 未死亡但 `ageAfter === 120` → `deathReason = "age_ceiling"`；
 * 3. 其他 → `null`。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

export type P3EDeathReason = "mortality" | "age_ceiling";

/** 一年死亡階段的事實（全部深層凍結、與輸入零共享）。 */
export interface P3EAnnualDeathStage {
  /** 完整的年度事件 effects 結果（含 roll／selection／effects／occurrences）。 */
  readonly effects: P3EAnnualEventEffects;
  /** P3-D 的判定結果（獨立凍結副本）。 */
  readonly mortality: P3DAnnualDeathResult;
  readonly deathRngBefore: P3EDeathRngState;
  readonly deathRngAfter: P3EDeathRngState;
  /** P3-D 回傳的實際 u32 消耗（偶數，2..512）。 */
  readonly u32DrawsUsed: number;
  readonly diedThisYear: boolean;
  readonly deathReason: P3EDeathReason | null;
  /** 死亡年度必為 `null`；未死亡時是事件 openedDecision 的獨立凍結副本。 */
  readonly pendingDecisionAfterDeath: P3EPendingDecision | null;
}

const INPUT_KEYS = ["state", "eventPack", "deathPack", "contentMode"] as const;

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
 * exact-object 四欄；任何反射失敗（已撤銷 Proxy、trap 拋錯、accessor、hidden／symbol／
 * 多餘／缺少／改名欄位、陣列、class instance、非 plain prototype）一律
 * `E_P3E_ARGUMENT at input`。只讀 descriptor：getter 不會被執行。
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
/* P3-D 判定（seam）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 呼叫 P3-D 的 `evaluateAnnualDeath`，並把任何例外折成固定的
 * `E_P3E_DEATH at deathEvaluation`（不外洩 `DeathDataError`／`TypeError`／`RangeError`）。
 *
 * **內部 seam（不進 barrel）**：入口傳入的都是已驗證的權威值，合法流程不會讓 P3-D 失敗，
 * 匯出是為了讓錯誤折疊可以被直接測試。
 */
export function evaluateP3EAnnualDeath(input: unknown, pack: ValidatedDeathPack): P3DAnnualDeathResult {
  try {
    return evaluateAnnualDeath(input, pack);
  } catch {
    fail("E_P3E_DEATH", "deathEvaluation");
  }
}

/* ------------------------------------------------------------------ */
/* 死亡 RNG 會計（seam）                                               */
/* ------------------------------------------------------------------ */

/**
 * 把 P3-D 回傳的實際 u32 消耗累加到 death 游標，並確認落在**下一個 State** 的既有上限內。
 *
 * 加總之前逐項驗證（任何一項不合格 → `E_P3E_RNG at rng.death.u32Draws`）：
 *
 * - `u32DrawsBefore`：安全整數、`>= 0`、**偶數**；
 * - `drawsUsed`：安全整數、**偶數**、`2..512`（單一年度至少一次抽樣，最多
 *   `P3E_MAX_U32_DRAWS_PER_DEATH_YEAR`）；
 * - `ageAfter`：安全整數且 `1..P3E_MAX_AGE`；
 * - `total`：安全整數且 `<= P3E_MAX_U32_DRAWS_PER_DEATH_YEAR × ageAfter`。
 *
 * `drawsUsed` 一律用 P3-D 的真實值：不截斷、不取模、不正規化成 2／4、不重算。
 *
 * **內部 seam（不進 barrel）**：合法 state 的餘裕讓公開入口幾乎不會撞到上限，
 * 匯出讓邊界契約與拒絕清單可以被獨立測試。
 */
export function applyP3EDeathDraws(u32DrawsBefore: number, drawsUsed: number, ageAfter: number): number {
  if (!Number.isSafeInteger(u32DrawsBefore) || u32DrawsBefore < 0 || u32DrawsBefore % 2 !== 0) {
    fail("E_P3E_RNG", "rng.death.u32Draws");
  }
  if (
    !Number.isSafeInteger(drawsUsed) ||
    drawsUsed % 2 !== 0 ||
    drawsUsed < P3E_DEATH_DRAWS_ALIVE ||
    drawsUsed > P3E_MAX_U32_DRAWS_PER_DEATH_YEAR
  ) {
    fail("E_P3E_RNG", "rng.death.u32Draws");
  }
  if (!Number.isSafeInteger(ageAfter) || ageAfter < 1 || ageAfter > P3E_MAX_AGE) {
    fail("E_P3E_RNG", "rng.death.u32Draws");
  }
  const total = u32DrawsBefore + drawsUsed;
  if (!Number.isSafeInteger(total) || total > P3E_MAX_U32_DRAWS_PER_DEATH_YEAR * ageAfter) {
    fail("E_P3E_RNG", "rng.death.u32Draws");
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* 深層凍結的獨立副本                                                  */
/* ------------------------------------------------------------------ */

function copyWords(words: P3EWordTuple): P3EWordTuple {
  const copy: [number, number, number, number] = [words[0], words[1], words[2], words[3]];
  return Object.freeze(copy);
}

function copyDeathRng(rng: P3EDeathRngState): P3EDeathRngState {
  return Object.freeze({
    domain: rng.domain,
    initialState: copyWords(rng.initialState),
    state: copyWords(rng.state),
    u32Draws: rng.u32Draws
  });
}

/**
 * `P3DAnnualDeathResult` 的獨立深層凍結副本。
 *
 * 用 `satisfies` 而**不是**型別斷言：漏掉或多出任何一個欄位都會直接編譯失敗，
 * 因此 runtime 的 `mortality` 一定符合正式契約（含 `basePackId`／`basePackChecksum`）。
 */
function copyMortality(result: P3DAnnualDeathResult): P3DAnnualDeathResult {
  const copy = {
    entityId: result.entityId,
    regionCode: result.regionCode,
    regionClass: result.regionClass,
    sex: result.sex,
    age: result.age,
    calendarYear: result.calendarYear,
    health: result.health,
    baseHazardPpm: result.baseHazardPpm,
    adjustedHazardPpm: result.adjustedHazardPpm,
    healthFactorPpm: result.healthFactorPpm,
    died: result.died,
    causeId: result.causeId,
    mortalityDraw: result.mortalityDraw,
    rngStateBefore: copyWords(result.rngStateBefore),
    rngStateAfter: copyWords(result.rngStateAfter),
    drawsUsed: result.drawsUsed,
    digest: result.digest,
    deathSpecVersion: result.deathSpecVersion,
    healthRuleVersion: result.healthRuleVersion,
    deathPackId: result.deathPackId,
    deathPackChecksum: result.deathPackChecksum,
    basePackId: result.basePackId,
    basePackChecksum: result.basePackChecksum
  } satisfies P3DAnnualDeathResult;
  return Object.freeze(copy);
}

function copyPendingDecision(decision: P3EPendingDecision): P3EPendingDecision {
  return Object.freeze({
    eventId: decision.eventId,
    decisionId: decision.decisionId,
    promptKey: decision.promptKey,
    options: Object.freeze(
      decision.options.map((option) =>
        Object.freeze({
          optionId: option.optionId,
          labelKey: option.labelKey,
          effects: Object.freeze(option.effects.map((effect) => Object.freeze({ ...effect }) as P3BEffect))
        })
      )
    ),
    selectionHash: decision.selectionHash
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 對一個合法 state 做「年度 effects → P3-D 死亡判定 → 死亡事實」。
 *
 * 順序：input shape → `validateP3EAnnualPacks` → `resolveP3EAnnualEventEffects`
 * → `evaluateAnnualDeath`（用 **effects 套用後** 的 health）→ 死亡 RNG 會計
 * → age ceiling → 死亡優先的 pending decision → 深層凍結結果。
 *
 * 失敗一律是 `P3EError`，不會回傳部分結果，也不會修改輸入。
 */
export function resolveP3EAnnualDeath(input: unknown): P3EAnnualDeathStage {
  const raw = readRawInput(input);

  // 已驗證的死亡包（同一組原始輸入；不信任未品牌化的 pack）
  const packs = validateP3EAnnualPacks({
    state: raw.state,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack
  });
  const state = packs.state;

  // 一律重跑 effects（含 roll／selection），不接受呼叫端傳入的中間結果
  const effects = resolveP3EAnnualEventEffects({
    state: raw.state,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack,
    contentMode: raw.contentMode
  });
  const roll = effects.selection.roll;

  // P3-D：age／year 用 Roll 後、health 用 **effects 套用後** 的值
  const mortality = copyMortality(
    evaluateP3EAnnualDeath(
      {
        entityId: state.identity.entityId,
        regionCode: state.identity.regionCode,
        sex: state.identity.sex,
        age: roll.ageAfter,
        calendarYear: roll.yearAfter,
        health: effects.stats.health,
        rngState: state.rng.death.state
      },
      packs.deathPack
    )
  );

  // 死亡 RNG 會計（真實 drawsUsed）
  const u32DrawsUsed = mortality.drawsUsed;
  const u32DrawsAfter = applyP3EDeathDraws(state.rng.death.u32Draws, u32DrawsUsed, roll.ageAfter);

  // 死亡優先：先看 P3-D，再套 age ceiling
  const reachedCeiling = roll.ageAfter === P3E_MAX_AGE;
  const diedThisYear = mortality.died || reachedCeiling;
  const deathReason: P3EDeathReason | null = mortality.died ? "mortality" : reachedCeiling ? "age_ceiling" : null;

  return Object.freeze({
    effects,
    mortality,
    deathRngBefore: copyDeathRng(state.rng.death),
    deathRngAfter: Object.freeze({
      domain: state.rng.death.domain,
      initialState: copyWords(state.rng.death.initialState),
      state: copyWords(mortality.rngStateAfter),
      u32Draws: u32DrawsAfter
    }),
    u32DrawsUsed,
    diedThisYear,
    deathReason,
    pendingDecisionAfterDeath:
      diedThisYear || effects.openedDecision === null ? null : copyPendingDecision(effects.openedDecision)
  });
}
