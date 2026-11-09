/**
 * GPT-0063-B｜瀏覽器／版面驗收腳本的「顯示語系相容比較」。
 *
 * ## 為什麼需要這一層
 *
 * 0062-A 起預設顯示語系是 zh-CN，0063-A 又補齊單字表；顯示層是
 * 「zh-Hant canonical 字串 → PHRASES → CHAR_PAIRS」即時轉換，部分字串會是
 * 簡繁混合。舊的 browser smoke / mobile layout 斷言寫於純繁中時期，直接比對
 * 繁體字面值會誤判為功能故障。
 *
 * ## 做法（不是放寬、也不是強制切語系）
 *
 * 直接讀 `packages/ui/src/p3e-locale.ts` 的 PHRASES 與 CHAR_PAIRS，
 * 用**與 runtime 完全相同的正向轉換**把「實際文字」與「期待的繁體字面值」
 * 都正規化成同一個 canonical 簡體字串再比較。
 *
 * - 不修改遊戲、不切換 locale、不改 localStorage；
 * - 不反向轉簡→繁，避開「里/裡、后/後、发/發/髮」等多對一歧義；
 * - 幾何、尺寸、44px、overflow、internal-key、command hash 等非文字條件完全不變；
 * - 語系表日後增修，本模組自動跟著更新，不需要維護第二份手寫對照表。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localeSource = readFileSync(
  resolve(here, "../packages/ui/src/p3e-locale.ts"),
  "utf8"
);

function sliceBlock(startMarker, endMarker, label) {
  const start = localeSource.indexOf(startMarker);
  if (start < 0) throw new Error(`E_P3E_LOCALE_COMPAT：找不到 ${label} 起始`);
  const end = localeSource.indexOf(endMarker, start);
  if (end < 0) throw new Error(`E_P3E_LOCALE_COMPAT：找不到 ${label} 結尾`);
  return localeSource.slice(start, end);
}

const phraseBlock = sliceBlock("const PHRASES", "});", "PHRASES");
const charBlock = sliceBlock("const CHAR_PAIRS", "]);", "CHAR_PAIRS");

const PHRASES = [...phraseBlock.matchAll(/"([^"]+)":\s*"([^"]+)"/g)]
  .map((match) => /** @type {[string, string]} */ ([match[1], match[2]]));

const CHAR_PAIRS = [...charBlock.matchAll(/\[\s*"([^"]+)",\s*"([^"]+)"\s*\]/g)]
  .map((match) => /** @type {[string, string]} */ ([match[1], match[2]]));

if (PHRASES.length < 20 || CHAR_PAIRS.length < 100) {
  throw new Error(
    `E_P3E_LOCALE_COMPAT：語系表解析異常 phrases=${PHRASES.length} chars=${CHAR_PAIRS.length}`
  );
}

// runtime 是「長詞組優先」，這裡必須一致，否則正規化結果會不同。
const PHRASE_KEYS = PHRASES
  .filter(([from, to]) => from !== to)
  .sort((left, right) => right[0].length - left[0].length);

const CHAR_MAP = new Map(
  CHAR_PAIRS.filter(([from, to]) => from !== to && [...from].length === 1)
);

/**
 * 繁→簡正規化（與 runtime `toSimplified` 同語意）。已是簡體的字原樣保留，
 * 因此對「實際文字」與「繁體期待值」都能得到同一個 canonical 形式。
 */
export function canonDisplay(text) {
  let output = String(text ?? "");
  for (const [from, to] of PHRASE_KEYS) {
    if (output.includes(from)) output = output.split(from).join(to);
  }
  let result = "";
  for (const char of output) result += CHAR_MAP.get(char) ?? char;
  return result;
}

/** 把繁體 RegExp 轉成 canonical 簡體 RegExp；\d、+、| 等符號不受影響。 */
export function canonPattern(pattern) {
  if (pattern instanceof RegExp) {
    return new RegExp(canonDisplay(pattern.source), pattern.flags);
  }
  return new RegExp(canonDisplay(String(pattern)));
}

/** 實際顯示文字 → 可比對物件；期待值一律寫原本的繁體字面值即可。 */
export function display(actual) {
  const value = canonDisplay(actual);
  return Object.freeze({
    value,
    /** 包含某個繁體詞（實際文字簡體／繁體／混合都可）。 */
    includes(needle) {
      return value.includes(canonDisplay(needle));
    },
    /** 與某個繁體字面值相等。 */
    equals(expected) {
      return value === canonDisplay(expected);
    },
    /** 用繁體 RegExp 測試。 */
    test(pattern) {
      return canonPattern(pattern).test(value);
    }
  });
}

/** 給需要整組陣列比較的舊斷言使用。 */
export function canonList(values) {
  return [...values].map((value) => canonDisplay(value));
}
