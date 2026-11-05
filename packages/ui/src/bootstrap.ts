import "./style.css";

/**
 * H5-CTO-176-A：UI 入口分流。
 *
 * - 預設（沒有任何 `preview` 參數）→ 載入真實 P3-E runtime（`./p3e-real-main`）；
 * - 只有 `?preview=fixture` → 載入既有的靜態 fixture 預覽（`./main`），
 *   保留原本 P1-C 行為與視覺回歸。
 *
 * 兩個模組都用 dynamic import，讓預設路徑**不會**包含 fixture 的程式與文案。
 */
const params = new URLSearchParams(window.location.search);
if (params.get("preview") === "fixture") {
  void import("./main");
} else {
  void import("./p3e-real-main");
}
