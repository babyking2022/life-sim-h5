import type { P3EStats } from "./p3e";

/**
 * GPT-0029-B｜人生重心（Life Focus）契約。
 *
 * ## 為什麼 focus 不是新的 State 欄位
 *
 * `P3ELifeState` 是 exact-object：新增欄位會同時改動 `readP3EStateShape`、
 * 手寫 `p3eStateProjection`、canonical state wire、save format version 與所有
 * golden hash，並讓既有 v6 存檔全部失效。本版刻意把重心編碼成**既有的
 * `flags` 字串**（`focus:<id>:<changedYear>`）：
 *
 * - `flags` 本來就收錄在 `stateHash` projection、codec wire 與 replay 比對中，
 *   因此重心自動進入正式存檔、重播與 state hash，不需要任何格式升級；
 * - 沒有 focus flag 的舊存檔仍是合法 v6 state，讀入後由 UI 在符合年齡時
 *   要求選擇，不會毀檔；
 * - 沒有重心指令的既有決定性路徑（官方 golden）連一個位元都不會改變。
 *
 * flag 值符合既有 `FLAG_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/`，
 * 且 `replaceP3ELifeFocusFlag` 一律回傳嚴格升冪（滿足 `assertFlags`）。
 *
 * ## 玩法概念來源
 *
 * 只採用「單一主重心、時間投入造成取捨、影響相符事件」的抽象玩法概念，
 * 沒有複製任何授權不明倉庫的程式或文案；所有顯示文字皆為本專案自行撰寫。
 */

/** 五種重心；`study` 在學生期顯示「學業」、成年後顯示「工作」，底層同一 id。 */
export const P3E_LIFE_FOCUS_IDS = ["study", "growth", "family", "hobby", "health"] as const;

export type P3ELifeFocusId = (typeof P3E_LIFE_FOCUS_IDS)[number];

/** 7 歲入學才開始有重心；成年（18 歲）後「學業」改顯示為「工作」。 */
export const P3E_LIFE_FOCUS_FIRST_AGE = 7;
export const P3E_LIFE_FOCUS_ADULT_AGE = 18;

/** 相符事件權重倍率（不相符事件維持原權重）。 */
export const P3E_LIFE_FOCUS_WEIGHT_MULTIPLIER = 2;

/** focus flag 的固定前綴；`focus:` 開頭的旗標專供本功能使用。 */
export const P3E_LIFE_FOCUS_FLAG_PREFIX = "focus:";

export interface P3ELifeFocusOption {
  readonly focusId: P3ELifeFocusId;
  /** 學生期標籤。 */
  readonly studentLabel: string;
  /** 成年後標籤。 */
  readonly adultLabel: string;
  /** 選單上的一句繁中說明。 */
  readonly summary: string;
  /** 每年對四項核心屬性的小幅效果；每種都同時有加分與代價。 */
  readonly annualStatDelta: P3EStats;
  /** 用 eventId 的子字串辨識「相符事件」。 */
  readonly eventKeywords: readonly string[];
}

/**
 * 五種重心的年度效果刻意都有取捨，避免「五種都只是全面加分」：
 * 主要屬性 +2（或兩個 +1），另一項 -1。數值很小，不會破壞 MVP 平衡。
 */
export const P3E_LIFE_FOCUS_OPTIONS: readonly P3ELifeFocusOption[] = Object.freeze([
  Object.freeze({
    focusId: "study",
    studentLabel: "學業",
    adultLabel: "工作",
    summary: "專注課業與職涯，知識與收入穩步累積，但少了些悠閒。",
    annualStatDelta: Object.freeze({ health: 0, happiness: -1, knowledge: 2, relationships: 0 }),
    eventKeywords: Object.freeze([
      "school", "study", "exam", "major", "career", "job", "salary", "promotion",
      "further-study", "finance", "investment", "housing", "startup", "side-project",
      "network", "part-time", "pension", "retirement", "move-city", "pocket-money"
    ])
  }),
  Object.freeze({
    focusId: "growth",
    studentLabel: "自我實現",
    adultLabel: "自我實現",
    summary: "追尋自己的方向，幸福與見識一起成長，但需要獨處的時間。",
    annualStatDelta: Object.freeze({ health: 0, happiness: 1, knowledge: 1, relationships: -1 }),
    eventKeywords: Object.freeze([
      "startup", "side-project", "career-pivot", "career-change", "new-hobby",
      "legacy", "reflection", "midlife-review", "volunteer", "talent",
      "interest-seed", "club", "competition", "quiet-year", "small-win"
    ])
  }),
  Object.freeze({
    focusId: "family",
    studentLabel: "家庭",
    adultLabel: "家庭",
    summary: "把心力留給家人與伴侶，人際更緊密，代價是少了進修的餘裕。",
    annualStatDelta: Object.freeze({ health: 0, happiness: 0, knowledge: -1, relationships: 2 }),
    eventKeywords: Object.freeze([
      "family", "children", "kids", "sibling", "elder-care", "relationship",
      "first-love", "friend", "grandchildren", "social", "care-arrangement",
      "chores", "friend-circle", "first-friend", "first-word"
    ])
  }),
  Object.freeze({
    focusId: "hobby",
    studentLabel: "興趣",
    adultLabel: "興趣",
    summary: "投入喜歡的事，日子更快樂，但作息偶爾會被擠壓。",
    annualStatDelta: Object.freeze({ health: -1, happiness: 2, knowledge: 0, relationships: 0 }),
    eventKeywords: Object.freeze([
      "club", "interest", "talent", "new-hobby", "playground", "screen-time",
      "online-life", "sport-team", "small-win", "quiet-year", "volunteer", "bullying"
    ])
  }),
  Object.freeze({
    focusId: "health",
    studentLabel: "健康",
    adultLabel: "健康",
    summary: "規律運動與照顧身體，健康明顯改善，但社交場合要有所取捨。",
    annualStatDelta: Object.freeze({ health: 2, happiness: -1, knowledge: 0, relationships: 0 }),
    eventKeywords: Object.freeze([
      "health", "medical", "chronic", "daily-health", "sleep", "picky-eating",
      "sport-team", "burnout", "risk", "tantrum", "setback", "kindergarten"
    ])
  })
]);

export function isP3ELifeFocusId(value: string): value is P3ELifeFocusId {
  return (P3E_LIFE_FOCUS_IDS as readonly string[]).includes(value);
}

export function findP3ELifeFocusOption(focusId: P3ELifeFocusId): P3ELifeFocusOption {
  return P3E_LIFE_FOCUS_OPTIONS.find((option) => option.focusId === focusId) as P3ELifeFocusOption;
}

/** 依年齡顯示標籤：學生期「學業」，成年後「工作」（其他四種不變）。 */
export function p3eLifeFocusLabel(focusId: P3ELifeFocusId, age: number): string {
  const option = findP3ELifeFocusOption(focusId);
  return age >= P3E_LIFE_FOCUS_ADULT_AGE ? option.adultLabel : option.studentLabel;
}

export interface P3ELifeFocusSnapshot {
  readonly focusId: P3ELifeFocusId;
  /** 上一次設定／更改重心的模擬年（同年至多更改一次）。 */
  readonly changedYear: number;
}

/** `focus:study:2032`：第三欄是設定當年的 currentYear。 */
export function encodeP3ELifeFocusFlag(focusId: P3ELifeFocusId, changedYear: number): string {
  return `${P3E_LIFE_FOCUS_FLAG_PREFIX}${focusId}:${changedYear}`;
}

/**
 * 從 state.flags 讀出重心。舊存檔沒有 focus flag → `null`。
 * 格式錯誤或多個 focus flag 一律視為「尚未設定」，不讓壞資料進入遊戲邏輯。
 */
export function readP3ELifeFocus(flags: readonly string[]): P3ELifeFocusSnapshot | null {
  const matches = flags.filter((flag) => flag.startsWith(P3E_LIFE_FOCUS_FLAG_PREFIX));
  if (matches.length !== 1) return null;
  const parts = matches[0]!.split(":");
  if (parts.length !== 3) return null;
  const [, focusId, yearText] = parts;
  if (!isP3ELifeFocusId(focusId as string) || !/^[0-9]{1,6}$/.test(yearText as string)) return null;
  const changedYear = Number(yearText);
  if (!Number.isSafeInteger(changedYear) || changedYear < 0) return null;
  return Object.freeze({ focusId: focusId as P3ELifeFocusId, changedYear });
}

/** 移除所有舊 focus flag、写入新的，並維持既有 `assertFlags` 要求的嚴格升冪。 */
export function replaceP3ELifeFocusFlag(
  flags: readonly string[],
  focusId: P3ELifeFocusId,
  changedYear: number
): readonly string[] {
  const kept = flags.filter((flag) => !flag.startsWith(P3E_LIFE_FOCUS_FLAG_PREFIX));
  kept.push(encodeP3ELifeFocusFlag(focusId, changedYear));
  return Object.freeze(kept.sort());
}

/** 把 focus 的年度效果加到 roll 後的 stats，並沿用既有 0..100 clamp。 */
export function applyP3ELifeFocusAnnualStats(stats: P3EStats, focusId: P3ELifeFocusId): P3EStats {
  const delta = findP3ELifeFocusOption(focusId).annualStatDelta;
  const clamp = (value: number): number => Math.max(0, Math.min(100, value));
  return Object.freeze({
    health: clamp(stats.health + delta.health),
    happiness: clamp(stats.happiness + delta.happiness),
    knowledge: clamp(stats.knowledge + delta.knowledge),
    relationships: clamp(stats.relationships + delta.relationships)
  });
}

/** 找出與此重心相符的事件 id（回傳嚴格升冪，供 selectEvent 的選填加權輸入）。 */
export function p3eLifeFocusEventIds(
  focusId: P3ELifeFocusId,
  eventIds: readonly string[]
): readonly string[] {
  const keywords = findP3ELifeFocusOption(focusId).eventKeywords;
  const matched = eventIds.filter((eventId) => keywords.some((keyword) => eventId.includes(keyword)));
  return Object.freeze([...new Set(matched)].sort());
}
