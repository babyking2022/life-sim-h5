import type { P3ECommandOutcome } from "@life-sim/simulation";

/**
 * GPT-0031-A｜可累積的人生紀錄（`lifeLog`）presentation projection。
 *
 * ## 為什麼放在 application 而不是 simulation canonical state
 *
 * `P3ELifeState` 是固定大小、沒有年度陣列的權威狀態；把逐年文案或無上限歷史塞進去
 * 會同時破壞 codec wire、state hash、存檔格式與「occurrences 不是逐年歷史」的契約。
 * 因此 `lifeLog` 只是**呈現投影**：
 *
 * - 不含任何繁中文字串，只放可由 UI 翻譯的公開 ID（`eventId`／`decisionId`／
 *   `optionId`／`focusId`／`causeId`）；
 * - 有明確上限 `P3E_LIFE_LOG_MAX_ENTRIES`（256），超過時保留最新者；
 * - 深層凍結、與輸入零共享；
 * - 完全由 ledger／commands 的權威結果推導，因此存檔復原後可以逐位元重建
 *   （見 `restoreP3EPlaySessionPayload`）。成功命令才會有紀錄，失敗命令不會。
 *
 * ## 排序
 *
 * `lifeLog` 依 `seq` **遞減**（最新在最前面），方便 UI 直接由上往下渲染
 * 「2025 年 · 6 歲｜…」。`seq` 從 1 開始、等於該筆在同一年度序列中的位置。
 */

/** `lifeLog` 最多保留幾筆（含 birth）。 */
export const P3E_LIFE_LOG_MAX_ENTRIES = 256;

/** 一筆人生紀錄的種類。 */
export type P3ELifeLogKind = "birth" | "year" | "event" | "decision" | "focus" | "death";

export const P3E_LIFE_LOG_KINDS: readonly P3ELifeLogKind[] = Object.freeze([
  "birth",
  "year",
  "event",
  "decision",
  "focus",
  "death"
]);

/**
 * 一筆人生紀錄（固定十欄、全部 primitive 或 `null`）。
 *
 * - `year`／`age`：事件發生的模擬年與年齡；
 * - `kind`：`birth`（出生）、`year`（平安的一年）、`event`（抽到事件但沒有決策）、
 *   `decision`（做了選擇）、`focus`（設定人生重心）、`death`（死亡）；
 * - `eventId`／`decisionId`／`optionId`／`focusId`：UI 用來查文案的公開 ID；
 * - `causeId`／`deathReason`：死亡紀錄才有值（`mortality`／`age_ceiling`）。
 */
export interface P3ELifeLogEntry {
  readonly seq: number;
  readonly year: number;
  readonly age: number;
  readonly kind: P3ELifeLogKind;
  readonly eventId: string | null;
  readonly decisionId: string | null;
  readonly optionId: string | null;
  readonly focusId: string | null;
  readonly causeId: string | null;
  readonly deathReason: "mortality" | "age_ceiling" | null;
}

/** 累積人生紀錄需要的最小權威事實（全部來自一次成功的命令結果）。 */
export interface P3ELifeLogSource {
  readonly year: number;
  readonly age: number;
  readonly outcome: P3ECommandOutcome;
}

const EMPTY_IDS = Object.freeze({
  eventId: null,
  decisionId: null,
  optionId: null,
  focusId: null,
  causeId: null,
  deathReason: null
});

function freezeEntry(entry: P3ELifeLogEntry): P3ELifeLogEntry {
  return Object.freeze({
    seq: entry.seq,
    year: entry.year,
    age: entry.age,
    kind: entry.kind,
    eventId: entry.eventId,
    decisionId: entry.decisionId,
    optionId: entry.optionId,
    focusId: entry.focusId,
    causeId: entry.causeId,
    deathReason: entry.deathReason
  });
}

/**
 * 出生紀錄（`seq = 1`、`age = 0`、`year = birthYear`）。
 */
export function birthLifeLogEntry(birthYear: number): P3ELifeLogEntry {
  return freezeEntry({ seq: 1, year: birthYear, age: 0, kind: "birth", ...EMPTY_IDS });
}

/**
 * 把一次成功的命令結果轉成紀錄（`seq` 由呼叫端給）。
 *
 * 只處理三種 outcome：
 * - `advance_year`：死亡 → `death`；有 pending decision 或抽到事件 → `event`；否則 `year`；
 * - `choose_decision`：`decision`（eventId／decisionId／optionId）；
 * - `set_life_focus`：`focus`（focusId）。
 */
export function lifeLogEntryFromOutcome(seq: number, year: number, age: number, outcome: P3ECommandOutcome): P3ELifeLogEntry {
  if (outcome.kind === "choose_decision") {
    return freezeEntry({
      seq,
      year,
      age,
      kind: "decision",
      ...EMPTY_IDS,
      eventId: outcome.eventId,
      decisionId: outcome.decisionId,
      optionId: outcome.selectedOptionId
    });
  }
  if (outcome.kind === "set_life_focus") {
    return freezeEntry({ seq, year, age, kind: "focus", ...EMPTY_IDS, focusId: outcome.focusId });
  }
  if (outcome.death !== null) {
    return freezeEntry({
      seq,
      year,
      age,
      kind: "death",
      ...EMPTY_IDS,
      eventId: outcome.selectedEventId,
      causeId: outcome.death.causeId,
      deathReason: outcome.death.reason
    });
  }
  if (outcome.pendingDecision !== null) {
    return freezeEntry({
      seq,
      year,
      age,
      kind: "event",
      ...EMPTY_IDS,
      eventId: outcome.pendingDecision.eventId,
      decisionId: outcome.pendingDecision.decisionId
    });
  }
  if (outcome.selectedEventId !== null) {
    return freezeEntry({ seq, year, age, kind: "event", ...EMPTY_IDS, eventId: outcome.selectedEventId });
  }
  return freezeEntry({ seq, year, age, kind: "year", ...EMPTY_IDS });
}

/** 依 `seq` 遞減排序並套用上限（回傳新的凍結陣列）。 */
function finalize(entries: readonly P3ELifeLogEntry[]): readonly P3ELifeLogEntry[] {
  // 先依 seq 升冪（呼叫端可能傳來「最新在前」的陣列），保留最新 256 筆，最後再反轉。
  const ascending = [...entries].sort((left, right) => left.seq - right.seq);
  const trimmed =
    ascending.length <= P3E_LIFE_LOG_MAX_ENTRIES ? ascending : ascending.slice(ascending.length - P3E_LIFE_LOG_MAX_ENTRIES);
  const newestFirst = trimmed.reverse();
  return Object.freeze(newestFirst.map(freezeEntry));
}

/**
 * 從「出生 ＋ 逐命令結果」建立完整紀錄（最新在前、上限 256）。
 *
 * 這是 restore 路徑與 live 路徑共用的唯一投影函式：輸入相同時輸出逐位元相同，
 * 因此存檔復原後的 `lifeLog` 與復原前完全一致。
 */
export function buildP3ELifeLog(
  birthYear: number,
  sources: readonly P3ELifeLogSource[]
): readonly P3ELifeLogEntry[] {
  const entries: P3ELifeLogEntry[] = [birthLifeLogEntry(birthYear)];
  let seq = 1;
  for (const source of sources) {
    seq += 1;
    entries.push(lifeLogEntryFromOutcome(seq, source.year, source.age, source.outcome));
  }
  return finalize(entries);
}

/** 在既有紀錄後面追加一筆（live 路徑用；不修改輸入）。 */
export function appendP3ELifeLogEntry(
  entries: readonly P3ELifeLogEntry[],
  year: number,
  age: number,
  outcome: P3ECommandOutcome
): readonly P3ELifeLogEntry[] {
  const nextSeq = entries.length === 0 ? 1 : Math.max(...entries.map((entry) => entry.seq)) + 1;
  return finalize([...entries, lifeLogEntryFromOutcome(nextSeq, year, age, outcome)]);
}

/** 兼容型 type guard：UI 可以用它安全地讀 `view.lifeLog`。 */
export function isP3ELifeLogEntry(value: unknown): value is P3ELifeLogEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq < 1) return false;
  if (typeof record.year !== "number" || !Number.isSafeInteger(record.year)) return false;
  if (typeof record.age !== "number" || !Number.isSafeInteger(record.age) || record.age < 0) return false;
  if (typeof record.kind !== "string" || !(P3E_LIFE_LOG_KINDS as readonly string[]).includes(record.kind)) return false;
  for (const key of ["eventId", "decisionId", "optionId", "focusId", "causeId", "deathReason"]) {
    const field = record[key];
    if (field !== null && typeof field !== "string") return false;
  }
  return true;
}

/** 兼容型 type guard：整個 `lifeLog` 陣列。 */
export function isP3ELifeLog(value: unknown): value is readonly P3ELifeLogEntry[] {
  return Array.isArray(value) && value.every((entry) => isP3ELifeLogEntry(entry));
}
