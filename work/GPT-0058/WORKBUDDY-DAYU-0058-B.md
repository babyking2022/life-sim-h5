# GPT-WORKBUDDY-DAYU-0058-B｜可愛人物圖升級＋手機載入加速

## 專案

- 路徑：`C:\Users\dogfl\Documents\Codex\2026-10-26\referenced-chatgpt-conversation-this-is-an\life-sim`
- 基準提交：`4e130f1`
- 先等待／讀取 DeepSeek 對 public application API 的修改；不得繞過 application 私有層。
- 不得 push、不得部署、不得刪除使用者既有未追蹤檔案。

## 已選 GitHub 參考

首選：`https://github.com/humation-labs/humation`

- 手繪 kawaii 風格。
- 程式與素材均為 MIT。
- deterministic，同 seed 固定同一角色。
- SVG 本機渲染，不需要 CDN、API 或外部熱連結。

備選：`https://github.com/Hantuhan/peepstudio`（Open Peeps，CC0）。只有 Humation 無法合理整合時才使用。

不得使用授權不清楚的 GitHub 圖片。若採用 Humation 的程式或素材，必須保留 MIT notice，更新 `assets/generated/SCENE-ATTRIBUTION.md`。不要把整個示範網站或 React 套件搬進本專案。

## 任務一：人物畫面改成可愛、完整且穩定

1. 以 Humation 的可愛手繪語言取代目前僵硬的幾何人物。優先採用「少量必要 SVG 部件／最小核心」；不要把 86 個部件與編輯器全部打包。
2. 保留目前城市／農村背景與手機直立單屏版面；人物區不可遮住左側狀態卡。
3. 玩家與伴侶都必須清楚區分 male／female，並在 child、student、young、middle、senior 五階段維持原本性別：
   - 老化只能改髮色、皺紋、身高比例、衣服等年齡特徵。
   - 絕不能因進入 senior 而切換到另一性別的髮型／身形集合。
   - 伴侶直接使用 `scene.partnerSex`，不得自行用姓名或玩家性別重新推測。
4. 伴侶、狗、貓依狀態顯示；同 seed＋同狀態重整後外觀相同。
5. 加入至少一組真正檢查 SVG 部件 key 的矩陣測試，覆蓋兩種性別×五種年齡×玩家／伴侶，避免只測 DOM 有圖卻沒測性別。

## 任務二：讓出生卡先出現，重資料不要阻塞首頁

CTO 實測目前公開站：

- HTML 首包 TTFB 約 1.81 秒（平台／地區因素）。
- 主遊戲 JS：373,988 bytes，下載約 0.73 秒。
- `mortality.v1.json`：2,614,367 bytes，下載約 1.19 秒。
- `birds.mp3`：1,441,167 bytes；目前已 `preload="none"`，必須維持首屏不下載。
- 現況 `loadWorld()` 用 `Promise.all()`，出生卡也等 events＋death 全部完成，這是主要程式瓶頸。

請完成：

1. 頁面載入立即顯示輕量啟動畫面／骨架，不得空白等待。
2. 第一階段只抓出生預覽需要的 base＋identity 資料，完成後立刻顯示出生卡。
3. events＋death 在出生卡顯示後背景載入；玩家按「開始人生」時：
   - 已完成就立刻開始。
   - 尚未完成則按鈕顯示「準備人生…」，完成後自動開始一次，不可重複建立 session。
   - 失敗要顯示人類可理解的重試按鈕。
4. 所有請求 promise 必須快取／去重，重繪或連點不能重複下載 2.61 MB mortality。
5. `birds.mp3` 在使用者按「開始人生」或開啟聲音以前不得出現在網路請求；維持 `preload="none"`。
6. 將出生卡用不到的遊戲 UI／場景／職業程式拆為延遲 chunk（合理 code split）；禁止為追求數字複製大量代碼。
7. Vite build 後新增檢查：出生卡關鍵路徑不得引用 mortality 或 mp3；進入遊戲後這些資源能正常取得。

效能驗收目標：

- 出生卡不等待 `mortality.v1.json`。
- 首次出生卡前不請求 mp3。
- 慢速網路模擬下，出生卡要比完整世界載入至少早 1 秒可見。
- 手機 390×844 不需要整頁下滑；既有控制、決策與存檔流程不回歸。

## 驗證

- typecheck、lint、全測試。
- Playwright/browser smoke。
- mobile layout 390×844。
- 新增網路攔截測試，證明死亡資料與音檔沒有阻塞出生卡。

## 交付

- 實際修改專案檔案與測試。
- 結果寫入 `work/GPT-0058/WORKBUDDY-DAYU-0058-B-result.md`，列出授權來源、打包大小前後、首屏資源清單與測試結果。
- 完成後對 GPT 只回一行：`GPT-WORKBUDDY-DAYU-0058-B｜完成`；若未全完成只能回 `部分完成` 或 `未完成`。
