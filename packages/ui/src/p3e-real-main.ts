/**
 * GPT-WORKBUDDY-0065-A：完整遊戲 runtime 已**搬移**到 `p3e-game-main.ts`。
 *
 * 這個檔案只保留相容 re-export，讓既有 source-level 回歸測試與文件引用的
 * 路徑仍然有效；production birth path 不再 import 它，因此完整 runtime、
 * 全套 CSS、Open Peeps 場景與音訊都不會進出生卡關鍵路徑。
 *
 * 刻意不複製整份 runtime：`p3e-game-main.ts` 是唯一一份實作。
 */
export { startP3EGame } from "./p3e-game-main.js";
