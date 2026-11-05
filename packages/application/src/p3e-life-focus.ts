/**
 * GPT-0029-B：把人生重心契約轉給 UI 使用。
 *
 * UI 只能 import `@life-sim/application` 的公開 barrel，不能直接依賴 contracts；
 * 這裡只做型別／常數／純函式的 re-export，不複製任何邏輯。
 */
export {
  P3E_LIFE_FOCUS_FIRST_AGE,
  P3E_LIFE_FOCUS_ADULT_AGE,
  P3E_LIFE_FOCUS_IDS,
  P3E_LIFE_FOCUS_OPTIONS,
  isP3ELifeFocusId,
  p3eLifeFocusLabel,
  readP3ELifeFocus,
  type P3ELifeFocusId,
  type P3ELifeFocusOption,
  type P3ELifeFocusSnapshot
} from "@life-sim/contracts";
