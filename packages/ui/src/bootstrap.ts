/**
 * GPT-WORKBUDDY-0065-A｜UI 入口：出生頁 critical path。
 *
 * `birth.css` 與 `p3e-birth-main.ts` 是**靜態** import，因此出生卡的
 * HTML → 單一 entry JS → 單一 birth CSS → 單一 birth bundle JSON
 * 就是完整的首屏關鍵路徑，沒有第二個 JS／CSS chunk 往返。
 *
 * 完整遊戲（`p3e-game-main.ts` + `style.css`）只由 birth entry 在按下
 * 「開始人生」後動態 import；`?preview=fixture` 的舊 P1-C 靜態預覽保留，
 * 走另一個動態 chunk，不進出生關鍵路徑。
 *
 * GPT-DEEPSEEK-0062-A：在載入任何 UI 之前先套用語系（預設 zh-CN），
 * 之後所有 render 產生的文字都由 `p3e-locale` 的 MutationObserver 轉成簡體。
 */
import "./birth.css";
import { startP3ELocale } from "./p3e-locale.js";
import { startP3EBirth } from "./p3e-birth-main.js";

const locale = startP3ELocale();
// 供瀏覽器 smoke 與除錯讀取（不影響任何遊戲狀態）。
(window as unknown as { __p3eLocale?: string }).__p3eLocale = locale;

const params = new URLSearchParams(window.location.search);
if (params.get("preview") === "fixture") {
  void import("./main");
} else {
  startP3EBirth();
}
