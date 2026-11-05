import {
  P3E_LIFE_FOCUS_WEIGHT_MULTIPLIER,
  p3eLifeFocusEventIds,
  readP3ELifeFocus,
  P3E_MAX_AGE,
  P3E_MAX_U32_DRAWS_PER_EVENT,
  type P3BContentMode,
  type P3BCandidate,
  type P3BEventHistory,
  type P3BSelection,
  type P3BSelectionReason,
  type P3BSelectionState,
  type P3EErrorCode,
  type P3EEventRngState,
  type P3EWordTuple
} from "@life-sim/contracts";
import { selectEvent } from "@life-sim/engine";
import { P3EError } from "./errors";
import { validateP3EAnnualPacks } from "./annual-packs";
import { resolveP3EAnnualRoll, type P3EAnnualRollResult } from "./annual-roll";

/**
 * 年度 Roll＋事件抽選轉接層（H5-CTO-084-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * resolveP3EAnnualEventSelection(input: unknown): P3EAnnualEventSelection
 * ```
 *
 * 這一層只組合三件已凍結的東西：
 *
 * 1. `validateP3EAnnualPacks`（state ＋ event pack ＋ death pack 的信任邊界）
 * 2. `resolveP3EAnnualRoll`（今年的 roll 與收支）
 * 3. P3-B 的 `selectEvent`（候選與決定性抽選）
 *
 * ## 刻意不做
 *
 * - 不套用 effects、不更新 occurrences、不判定死亡、不建立 State、不 seal、
 *   不碰 ledger／command／codec／replay（Ledger 由另一個 Agent 並行開發）。
 * - 不修改 P3-E 的 State 契約：`contentMode` 只是**年度命令的權威輸入**，本批保留在結果裡，
 *   未來 command／ledger／replay 必須自己驗證它。
 * - 不改 `state.rng.events`：結果只報告「前後游標」，游標的落地屬於下一個 State。
 *
 * ## 固定順序
 *
 * 1. 頂層 exact-object／descriptor 信任邊界
 * 2. `validateP3EAnnualPacks({state, eventPack, deathPack})`
 * 3. `contentMode`（只接受 `standard`／`guardian`，**沒有預設值**）
 * 4. `resolveP3EAnnualRoll({state})`
 * 5. 用 **Roll 之後**的 year／age／stats／assets ＋ 原 state 的 flags 建立 P3-B selection state
 * 6. 用原 state 的 occurrences 與 event RNG 游標呼叫 `selectEvent`
 * 7. 建立獨立、深層凍結的結果
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 一次年度事件抽選的完整結果（全部深層凍結）。 */
export interface P3EAnnualEventSelection {
  /** 年度命令的權威輸入，原樣保留（未來 command／ledger／replay 必須驗證它）。 */
  readonly contentMode: P3BContentMode;
  /** 完整的年度 roll 結果（`resolveP3EAnnualRoll` 的回傳值）。 */
  readonly roll: P3EAnnualRollResult;
  /** 候選清單（canonical：eventId 升冪；獨立副本）。 */
  readonly candidates: readonly P3BCandidate[];
  readonly selectedEventId: string | null;
  readonly reason: P3BSelectionReason;
  readonly selectionHash: string;
  /** 抽選前的 event 游標（`initialState`／`state`／`u32Draws`）。 */
  readonly eventRngBefore: P3EEventRngState;
  /** 抽選後的 event 游標：`state` 取自 P3-B 的實際回傳，`u32Draws` 已累加。 */
  readonly eventRngAfter: P3EEventRngState;
  /**
   * 本次實際消耗的 u32 抽樣數：**非負偶數**（0／2／4／6…）。
   *
   * P3-B 用 rejection sampling，每次嘗試消耗 2 個 u32，被拒絕就再試一次；
   * 因此只保證「偶數」，不保證「最多 2」。這裡一律採用 P3-B 回傳的實際值。
   */
  readonly u32DrawsUsed: number;
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
/* 3. contentMode                                                      */
/* ------------------------------------------------------------------ */

/** 只接受兩個既有值；**沒有預設值**（缺欄位在步驟 1 就被擋下）。 */
function readContentMode(value: unknown): P3BContentMode {
  if (value !== "standard" && value !== "guardian") fail("E_P3E_EVENT", "contentMode");
  return value;
}

/* ------------------------------------------------------------------ */
/* 6. P3-B 抽選（錯誤折疊 seam）                                       */
/* ------------------------------------------------------------------ */

/**
 * 呼叫 P3-B 的 `selectEvent`，並把所有例外折成固定的 `E_P3E_EVENT at eventSelection`。
 *
 * **內部 seam（不進 barrel）**：`resolveP3EAnnualEventSelection` 走的就是這支函式；
 * 另外匯出是為了讓「P3-B 錯誤被折疊」這件事可以被直接測試——合法 pack ＋ 合法 state
 * 之下 P3-B 不會失敗，因此折疊分支無法從公開入口觸發。
 */
export function selectP3EEvent(input: unknown): P3BSelection {
  try {
    return selectEvent(input);
  } catch {
    fail("E_P3E_EVENT", "eventSelection");
  }
}

/* ------------------------------------------------------------------ */
/* RNG 會計（seam）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把本次抽樣的 u32 消耗累加到 event 游標的 `u32Draws`，並確認結果落在
 * **下一個 State** 的既有上限內（`P3E_MAX_U32_DRAWS_PER_EVENT × ageAfter`）。
 *
 * 加總**之前**逐項驗證（任何一項不合格都回 `E_P3E_RNG at rng.events.u32Draws`）：
 *
 * - `u32DrawsBefore`：安全整數、`>= 0`、**偶數**；
 * - `drawsUsed`：安全整數、`>= 0`、**偶數**（P3-B rejection sampling：0／2／4／6…）；
 * - `ageAfter`：安全整數且 `1..P3E_MAX_AGE`；
 * - `total`：安全整數且 `<= P3E_MAX_U32_DRAWS_PER_EVENT × ageAfter`。
 *
 * 逐項檢查（而不是只看總和）才能擋下「兩個小數互相抵銷後剛好變成整數」、
 * 負數、奇數、`NaN`／`Infinity`、超過安全整數與非法 `ageAfter`。
 *
 * **內部 seam（不進 barrel）**：合法 state 的 `u32Draws <= 256 × age` 與「下一歲上限多 256」
 * 之間的餘裕，讓公開入口幾乎不會撞到上限；這支函式讓邊界契約可以被獨立測試。
 */
export function applyP3EEventDraws(u32DrawsBefore: number, drawsUsed: number, ageAfter: number): number {
  if (!Number.isSafeInteger(u32DrawsBefore) || u32DrawsBefore < 0 || u32DrawsBefore % 2 !== 0) {
    fail("E_P3E_RNG", "rng.events.u32Draws");
  }
  if (!Number.isSafeInteger(drawsUsed) || drawsUsed < 0 || drawsUsed % 2 !== 0) {
    fail("E_P3E_RNG", "rng.events.u32Draws");
  }
  if (!Number.isSafeInteger(ageAfter) || ageAfter < 1 || ageAfter > P3E_MAX_AGE) {
    fail("E_P3E_RNG", "rng.events.u32Draws");
  }
  const total = u32DrawsBefore + drawsUsed;
  if (!Number.isSafeInteger(total) || total > P3E_MAX_U32_DRAWS_PER_EVENT * ageAfter) {
    fail("E_P3E_RNG", "rng.events.u32Draws");
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

function copyEventRng(rng: P3EEventRngState): P3EEventRngState {
  return Object.freeze({
    domain: rng.domain,
    initialState: copyWords(rng.initialState),
    state: copyWords(rng.state),
    u32Draws: rng.u32Draws
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 對一個合法 state 做「今年 roll → 事件候選 → 決定性抽選」。
 *
 * 失敗一律是 `P3EError`：反射／形狀 → `E_P3E_ARGUMENT at input`；
 * state／pack／roll 的既有錯誤原樣轉出；非法 `contentMode` → `E_P3E_EVENT at contentMode`；
 * P3-B 抽選失敗 → `E_P3E_EVENT at eventSelection`；RNG 累計超限 → `E_P3E_RNG at rng.events.u32Draws`。
 * 任何失敗都不會產生部分結果，也不會修改輸入。
 */
export function resolveP3EAnnualEventSelection(input: unknown): P3EAnnualEventSelection {
  // 1–2. 形狀 ＋ state／pack／death 的信任邊界
  const raw = readRawInput(input);
  const packs = validateP3EAnnualPacks({
    state: raw.state,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack
  });

  // 3. contentMode（沒有預設值）
  const contentMode = readContentMode(raw.contentMode);

  // 4. Roll
  const roll = resolveP3EAnnualRoll({ state: packs.state });
  const state = packs.state;

  // 5. 用 Roll 之後的 year／age／stats／assets ＋ 原 state 的 flags
  const selectionState: P3BSelectionState = {
    currentYear: roll.yearAfter,
    age: roll.ageAfter,
    phase: "life",
    stats: {
      health: roll.statsAfter.health,
      happiness: roll.statsAfter.happiness,
      knowledge: roll.statsAfter.knowledge,
      relationships: roll.statsAfter.relationships
    },
    assets: {
      balanceMicroUsd: roll.assetsAfter.balanceMicroUsd,
      annualIncomeMicroUsd: roll.assetsAfter.annualIncomeMicroUsd,
      annualExpenseMicroUsd: roll.assetsAfter.annualExpenseMicroUsd
    },
    flags: [...state.flags]
  };

  // 6. 用原 state 的 occurrences 與 event RNG 游標抽選
  const history: P3BEventHistory = {
    occurrences: state.occurrences.map((entry) => ({
      eventId: entry.eventId,
      lastYear: entry.lastYear,
      count: entry.count
    }))
  };
  const selectionInput: Record<string, unknown> = {
    pack: packs.eventPack,
    state: selectionState,
    history,
    contentMode,
    rngState: state.rng.events.state
  };
  // GPT-0029-B：有重心時，把相符事件權重加倍；沒有重心時**完全不帶第六欄**，
  // 讓 selectEvent 的既有五欄呼叫路徑逐位元不變（P3B／P3C golden 不受影響）。
  const focus = readP3ELifeFocus(state.flags);
  if (focus !== null) {
    selectionInput.weightBias = {
      eventIds: p3eLifeFocusEventIds(
        focus.focusId,
        packs.eventPack.events.map((event) => event.eventId)
      ),
      multiplier: P3E_LIFE_FOCUS_WEIGHT_MULTIPLIER
    };
  }
  const selection = selectP3EEvent(selectionInput);

  const u32DrawsAfter = applyP3EEventDraws(state.rng.events.u32Draws, selection.drawsUsed, roll.ageAfter);

  // 7. 獨立、深層凍結的結果
  return Object.freeze({
    contentMode,
    roll,
    candidates: Object.freeze(
      selection.candidates.map((candidate) =>
        Object.freeze({ eventId: candidate.eventId, weight: candidate.weight, priority: candidate.priority })
      )
    ),
    selectedEventId: selection.selectedEventId,
    reason: selection.reason,
    selectionHash: selection.selectionHash,
    eventRngBefore: copyEventRng(state.rng.events),
    eventRngAfter: Object.freeze({
      domain: state.rng.events.domain,
      initialState: copyWords(state.rng.events.initialState),
      state: copyWords(selection.rngStateAfter),
      u32Draws: u32DrawsAfter
    }),
    u32DrawsUsed: selection.drawsUsed
  });
}
