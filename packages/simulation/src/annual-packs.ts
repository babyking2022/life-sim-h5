import {
  isValidatedDeathPack,
  type ValidatedDeathPack
} from "@life-sim/birth";
import { bindEventPack, isValidatedEventPack, type ValidatedEventPack } from "@life-sim/engine";
import {
  P3D_HEALTH_RULE_VERSION,
  type P3EDeathPackBinding,
  type P3EErrorCode,
  type P3EEventPackBinding,
  type P3ELifeState
} from "@life-sim/contracts";
import { P3EError } from "./errors";
import { readP3EState } from "./state-invariants";

/**
 * 年度交易使用的資料包信任邊界（H5-CTO-080-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * validateP3EAnnualPacks(input: unknown): P3EAnnualPacks
 * ```
 *
 * ## 固定處理順序（錯誤順序由測試鎖定）
 *
 * 1. input shape（exact-object 三欄：`state`／`eventPack`／`deathPack`）
 * 2. `readP3EState(state)`（shape ＋ 不變量 ＋ `stateHash`，錯誤原樣轉出）
 * 3. event pack 品牌（`isValidatedEventPack`）
 * 4. event binding（`bindEventPack` 的七欄 vs `state.packs.events`）
 * 5. life eligibility（決策選項的 effects 不得再含 `openDecision`）
 * 6. death pack 品牌（`isValidatedDeathPack`）
 * 7. death binding（11 欄 vs `state.packs.death`）
 * 8. entity／region binding（death pack 的 `entityIndex` vs `state.identity`）
 *
 * **不做任何事**：不消耗 RNG、不抽事件、不判定死亡、不寫入 state 或 pack。
 * 品牌物件本來就深層凍結，因此回傳的是**同一批** pack 物件（不建立假品牌、不重新驗證替換）。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 年度交易所需的、已驗證的資料包組。 */
export interface P3EAnnualPacks {
  /** `readP3EState` 產生的獨立、深層凍結快照（不是呼叫端的物件）。 */
  readonly state: P3ELifeState;
  /** 呼叫端傳入的同一個品牌物件（不複製、不重新驗證替換）。 */
  readonly eventPack: ValidatedEventPack;
  /** 呼叫端傳入的同一個品牌物件（不複製、不重新驗證替換）。 */
  readonly deathPack: ValidatedDeathPack;
}

const INPUT_KEYS = ["state", "eventPack", "deathPack"] as const;

const EVENT_BINDING_FIELDS: readonly (keyof P3EEventPackBinding)[] = [
  "eventSchemaVersion",
  "eventSpecVersion",
  "contentPackVersion",
  "eventPackId",
  "eventPackChecksum",
  "datasetChecksum",
  "eventCount"
];

const DEATH_BINDING_FIELDS: readonly (keyof P3EDeathPackBinding)[] = [
  "schemaVersion",
  "deathDataVersion",
  "deathSpecVersion",
  "healthRuleVersion",
  "engineVersion",
  "rngSpecVersion",
  "deathPackId",
  "deathPackChecksum",
  "basePackId",
  "basePackChecksum",
  "entityCount"
];

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
 * exact-object 三欄；任何反射失敗（已撤銷 Proxy、trap 拋錯、accessor、hidden／symbol／
 * 多餘／缺少欄位、陣列、class instance、非 plain prototype）一律 `E_P3E_ARGUMENT at input`。
 * 只讀 descriptor：getter 不會被執行。
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
/* 4／7. binding                                                       */
/* ------------------------------------------------------------------ */

/**
 * event pack 的七個 binding 欄位必須逐欄等於 `state.packs.events`。
 *
 * **內部 seam（不進 barrel）**：`validateP3EAnnualPacks` 走的就是這支函式；另外匯出是為了
 * 讓「合法 state 不可能出現」的欄位反例（shape 已釘死的版本欄位）也能被逐欄測試。
 */
export function assertP3EEventBinding(state: P3ELifeState, pack: ValidatedEventPack): void {
  const bound = bindEventPack(pack);
  for (const field of EVENT_BINDING_FIELDS) {
    if (state.packs.events[field] !== bound[field]) fail("E_P3E_BINDING", `packs.events.${field}`);
  }
}

/** P3-E 的死亡包綁定（11 欄；`healthRuleVersion` 取 contracts 常數，P3-D manifest 沒有這一欄）。 */
function deathBindingOf(pack: ValidatedDeathPack): P3EDeathPackBinding {
  const manifest = pack.manifest;
  return {
    schemaVersion: manifest.schemaVersion,
    deathDataVersion: manifest.deathDataVersion,
    deathSpecVersion: manifest.deathSpecVersion,
    healthRuleVersion: P3D_HEALTH_RULE_VERSION,
    engineVersion: manifest.engineVersion,
    rngSpecVersion: manifest.rngSpecVersion,
    deathPackId: manifest.deathPackId,
    deathPackChecksum: pack.packChecksum,
    basePackId: manifest.basePackId,
    basePackChecksum: manifest.basePackChecksum,
    entityCount: manifest.entityCount
  };
}

/**
 * death pack 的 11 個 binding 欄位必須逐欄等於 `state.packs.death`，而且證書
 * entity 必須存在於 `entityIndex`、`regionCode` 必須一致。
 *
 * **內部 seam（不進 barrel）**，理由同 `assertP3EEventBinding`。
 */
export function assertP3EAnnualDeathBinding(state: P3ELifeState, pack: ValidatedDeathPack): void {
  const expected = deathBindingOf(pack);
  for (const field of DEATH_BINDING_FIELDS) {
    if (state.packs.death[field] !== expected[field]) fail("E_P3E_BINDING", `packs.death.${field}`);
  }
  const binding = pack.entityIndex[state.identity.entityId];
  if (binding === undefined) fail("E_P3E_BINDING", "deathPack.entityIndex");
  if (binding.regionCode !== state.identity.regionCode) fail("E_P3E_BINDING", "deathPack.entityIndex");
}

/* ------------------------------------------------------------------ */
/* 5. life eligibility                                                 */
/* ------------------------------------------------------------------ */

/**
 * 拒絕「決策選項的 effects 又開新決策」的 pack（避免巢狀決策）。
 *
 * 與 P3-C 的 `assertEventPackLifeEligible` 語意相同（該函式不在 engine 的公開 barrel，
 * 因此在此以同樣的規則與 path 實作）。
 */
function assertLifeEligible(pack: ValidatedEventPack): void {
  for (const event of pack.events) {
    if (event.decision === null) continue;
    for (const option of event.decision.options) {
      for (const effect of option.effects) {
        if (effect.type === "openDecision") fail("E_P3E_EVENT_PACK", `pack.events.${event.eventId}.${option.optionId}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 驗證年度交易要用的 state ＋ event pack ＋ death pack，並回傳它們的已驗證組合。
 *
 * 失敗一律是固定 `P3EError`（不外洩 `EventPackError`／`DeathDataError`／`TypeError`），
 * 且不會回傳部分結果。呼叫端的 state／pack 不會被修改，RNG 也不會被消耗。
 */
export function validateP3EAnnualPacks(input: unknown): P3EAnnualPacks {
  const raw = readRawInput(input);

  // 2. state（錯誤原樣轉出）
  const state = readP3EState(raw.state);

  // 3–4. event pack：品牌 → binding
  const eventPack = raw.eventPack;
  if (!isValidatedEventPack(eventPack)) fail("E_P3E_EVENT_PACK", "eventPack");
  assertP3EEventBinding(state, eventPack);

  // 5. life eligibility（必須早於 death pack 驗證）
  assertLifeEligible(eventPack);

  // 6–8. death pack：品牌 → binding → entity／region
  const deathPack = raw.deathPack;
  if (!isValidatedDeathPack(deathPack)) fail("E_P3E_DEATH_PACK", "deathPack");
  assertP3EAnnualDeathBinding(state, deathPack);

  return Object.freeze({ state, eventPack, deathPack });
}
