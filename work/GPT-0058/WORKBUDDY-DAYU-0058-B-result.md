# GPT-WORKBUDDY-DAYU-0058-B｜結果報告

- 基準提交：`4e130f1`
- 結論：**完成**（任務一、任務二與全部驗證鏈皆通過）
- 未 commit、未 push、未部署、未 reset／checkout；未刪除任何使用者既有未追蹤檔案。
- DeepSeek 0058-A 的 application 變更（`p3e-browser-bootstrap.ts`、`p3e-partner.ts`、
  `p3e-profile.ts`、`p3e-session.ts`）保留原樣，UI 只呼叫 public staged API：
  `prepareP3EBrowserBirthStage` / `previewP3EBrowserBirthStage` /
  `completeP3EBrowserWorld`，沒有繞過 application 私有層。

---

## 一、授權來源（任務一）

| 項目 | 值 |
| --- | --- |
| 專案 | `https://github.com/humation-labs/humation`（Humation 1，手繪 kawaii avatar engine） |
| 固定 commit | `85613cfac2d600c05847f403fc275336ab1fa240` |
| 素材包 | `packages/assets-humation-1`（上游 86 個部件） |
| 授權 | **MIT**，`Copyright (c) 2026 Humation contributors`（程式與素材皆 MIT） |
| MIT notice | 完整條款保留於 `assets/generated/humation/LICENSE.md`，並全文抄錄於 `assets/generated/SCENE-ATTRIBUTION.md` 的 0058-B 段落 |
| 取得方式 | 由該 commit 的 raw 檔案下載後原樣保存在本機；無 CDN、無 API、無執行期熱連結 |

**只 vendor 4 個必要部件（最小核心）**，沒有搬入 86 個部件、React 套件、avatar builder、
editor 或示範網站；也沒有使用備選 `Hantuhan/peepstudio` 或任何授權不明的圖片。

| 專案 key | 上游 | 本機檔名 | 原始 bytes | 精簡 bytes | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `head/short` | `head/003.svg` | `head_003.svg` | 8,703 | 6,598 | `a3562f2bd861ca763d2f0beabb50c62b6e39627b3d91eba761d1e29c6a8f4fcf` |
| `head/fluffy-bob` | `head/001.svg` | `head_001.svg` | 11,679 | 8,876 | `6563bca96b0522ed27bbac5c927ac241fcde4f590edb71bd4a8c9403cd0c8f95` |
| `glasses/round` | `glasses/001.svg` | `glasses_001.svg` | 627 | 467 | `cafcd188ab90288a8072ccda20d6f94c38b56dd69ab7f2a27948f3077bb4b8d7` |
| `cat/tabby` | `cat/001.svg` | `cat_001.svg` | 6,706 | 6,429 | `a56fa8dbafd57b25e560d4c4a945ecefd06aa1e95d1c090a0115aee43ea04e39` |

原始合計 `27,715 B` → 精簡 `22,370 B`；產生的 TS 常數模組
`packages/ui/src/p3e-kawaii-parts.ts` 為 `25,031 B`。
重製腳本 `scripts/p3e-0058b-vendor-parts.mjs` 只讀本機 vendor SVG，執行期不連網。
Humation 沒有狗部件，狗為本專案原創圓潤手繪曲線；貓用 `cat/tabby`。

### 人物規格落實

- `male` 固定 `head/short`＋`original/body/trousers`；`female` 固定
  `head/fluffy-bob`＋`original/body/dress`。`headPartOf(sex)` 是**唯一**決定頭型的地方，
  五個年齡階段共用同一性別部件集合；`senior` 只疊 `glasses/round`、皺紋、手杖、
  灰白髮色與身高比例，**不切換性別部件**。
- 伴侶正常路徑直接讀 `scene.partnerSex`（DeepSeek 0058-A 的 `P3ELifePartner.sex`），
  只有 `partnerSex === null` 才用 `oppositeSex(playerSex)` 安全回退；不查姓名池推測。
- 伴侶／狗／貓依 `hasPartner`、`petKind` 顯示；`(view.scene, seed)` 為純函式，
  無 `Math.random`、無 `Date`，同 seed＋同狀態重整後外觀相同。
- 保留 urban／rural 兩套背景與 `190–230px` 場景高度；`.p3e-scene` 仍是零子節點的
  `data:image/svg+xml` 背景，人物全部排在 `SCENE_SAFE_LEFT_X = 190` 右側，
  不遮左側狀態卡。放大目視檢查（`.artifacts/0058b-scene-preview.png`）確認手繪頭髮、
  五官、腮紅、老花眼鏡、裙／褲差異與貓狗皆實際繪出，沒有缺頭或空白臉。
- 新增 `describeSceneParts(scene, seed)` 與 `packages/ui/test/p3e-scene-parts.test.ts`：
  **真正檢查 SVG 部件 key** 的矩陣測試，覆蓋 `2 性別 × 5 年齡 × 玩家／伴侶 = 20` 組，
  並斷言 `data-part` 出現在角色 `<g>` 內、伴侶不被重新推測、不同 seed 只改色不改 key。
  既有 `p3e-scene.test.ts` 的 120 組場景矩陣仍全過。

---

## 二、打包大小前後

CTO 實測基準（4e130f1）：主遊戲 JS `373,988 B`；`mortality.v1.json`
`2,614,367 B`；`birds.mp3` `1,441,167 B`；HTML TTFB 約 1.81s；
`loadWorld()` 用 `Promise.all()`，出生卡必須等 events＋death 全部完成。

| 項目 | 前 | 後 |
| --- | --- | --- |
| 出生卡關鍵路徑 JS | `373,988 B` | **`345,299 B`**（gzip `98,923 B`）＝ entry `2,149 B` + `p3e-real-main` `343,150 B`，減少 `28,689 B`（-7.7%） |
| 遊戲專用延遲 chunk | 無（全在主包） | `132,377 B`：`main` `69,989` + `p3e-game-layer` `51,899` + `p3e-heavy-packs` `10,489`（皆在出生卡之後／按需載入） |
| `mortality.v1.json` | 出生卡前必抓 | 只被 `p3e-heavy-packs` 延遲 chunk 引用，出生卡關鍵路徑無此 URL |
| `birds.mp3` | `preload="none"` | URL 移到 `p3e-game-layer` 延遲 chunk；只在「開始人生」／開音效的使用者手勢後建立 `Audio.src`，`preload="none"` 不變 |
| CSS | — | `index-B3G0uJZ-.css` `73,240 B`（未因本任務增大） |

誠實說明：所有 JS 合計比基準略大（Vite 為每個 chunk 加了邊界與共用 helper），
但**沒有為追求數字複製大量程式**，只是把原本就在主包的遊戲 UI／場景／職業／CNY／
國家名表搬到延遲 chunk；出生卡真正要下載的 JS 反而變小。

`scripts/p3e-0058b-critical-path.mjs` 在 build 後沿靜態 import 建立關鍵路徑閉包，
8/8 檢查通過：關鍵路徑無 mortality／mp3 資產 URL、重型 URL 只出現在延遲 chunk、
`p3e-game-layer-*` 與 `p3e-heavy-packs-*` 為獨立 chunk、HTML 含靜態骨架、
dist 內 mortality 與 mp3 存在且非空（進遊戲後可正常取得）、關鍵 JS 小於基準。

---

## 三、首屏資源清單

以 Playwright + `PerformanceResourceTiming` 實測（`390×844`，本機靜態伺服器，
刻意把 mortality 延遲 2,500ms 模擬慢網）：**出生卡 DOM 在 `276ms` 插入**。
在此之前共 `11` 個請求、`768,337 B`：

| 時間 | 大小 | 資源 |
| --- | --- | --- |
| — | — | `index.html`（內聯極小 skeleton CSS 與 `<main class="p3e-boot-skeleton">`，**不依賴任何 JS/fetch 就可見**） |
| 34ms | 73,240 B | `index-B3G0uJZ-.css` |
| 34ms | 2,149 B | `index-BUObfCUZ.js`（entry / bootstrap） |
| 47ms | 343,150 B | `p3e-real-main-BBByYulh.js`（兩階段載入＋出生卡） |
| 102–104ms | 339,309 B | 第一階段 7 個 hashed JSON：`country-registry` 29,604、`indicators` 61,080、`birth-weights` 174,768、`country-vitals` 27,282、`household-profiles` 13,752、`name-corpus` 23,564、`story-templates` 9,259 |
| 275ms | 10,489 B | `p3e-heavy-packs-Df2rzSUq.js`（延遲 chunk，背景階段起點） |

另外 7 個邏輯 pack（p2a/p2b 的 `manifest`、`sensitive-names`、`licenses`、`lineage`）
小於 Vite inline 門檻，被編成 `data:application/json;base64,...` 直接嵌在出生卡 chunk，
**不產生額外網路請求**；邏輯上仍是 14 個 base＋identity pack。

出生卡之後才出現：`p3e-game-layer` 51,899 B、`events.v1` 207,381 B、
`event-copy.zh-Hant` 30,981 B、`manifest` 5,645 B、`cause-weights` 51,879 B、
`mortality.v1` 2,614,367 B。**首屏沒有 mortality、沒有 mp3。**

請求去重：`packages/ui/src/p3e-fetch-cache.ts` 以 URL 為鍵快取 promise，
成功永久快取、失敗移除該 URL 以允許重試；連點／reroll／重繪不會重複下載
2.61MB mortality。回訪玩家用 `hasStoredAutosave()` 維持骨架到完整世界 ready，
避免 reload 閃出生卡（既有音效偏好與按鈕檢查不回歸）。

---

## 四、測試結果

| 驗證 | 指令 | 結果 |
| --- | --- | --- |
| typecheck | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **0 error** |
| lint | `npm run lint`（含 architecture self-test 123 checks） | **0 problem** |
| 全測試 | `./node_modules/.bin/vitest run --maxWorkers=1` | **119 檔 / 2333 項全通過** |
| build | `vite build --config vite.config.ts` + `vite build --config vite.p1c.config.ts` | 兩者皆 **exit 0** |
| 關鍵路徑 | `node scripts/p3e-0058b-critical-path.mjs` | **8/8 PASS** |
| 網路攔截（新增） | `node scripts/p3e-0058b-network-check.mjs` | **25/25 PASS** |
| browser smoke | `node scripts/p3e-browser-smoke.mjs` | **221 checks OK**，retained=170、scenarios=51、無 page error |
| mobile layout | `node scripts/p3e-mobile-layout-check.mjs` | **546/546 PASS**（含 390×844 截圖） |

重點測試檔：`p3e-scene-parts.test.ts` 5/5（20 組性別×年齡×角色部件 key）、
`p3e-scene.test.ts` 9/9（120 組場景矩陣）、
`p3e-partner-sex-staged-world-0058.test.ts` 9/9（DeepSeek 0058-A）、
`p3e-career-view.test.ts` 13/13、`p3e-cny.test.ts` 7/7。

### 網路攔截測試的 25 項涵蓋

- 靜態骨架在主 JS 被延遲 350ms 時仍可見；出生卡出現時 mortality **0 個 response**，
  `data-p3e-world-stage="loading"`；出生卡前 mp3 請求 **0**。
- 慢速 mortality（延遲 2,500ms）：出生卡比完整世界早 **2,639ms**（≥ 1,000ms 目標）；
  「開始人生」顯示「準備人生…」且 disabled，完成後自動開局一次
  （`data-p3e-command-count="0"`），mortality 只請求 1 次、HTTP 200、
  `preload="none"`，進遊戲後 mp3 可正常取得。
- 連點／reroll：mortality 1 次、events 1 次、copy 1 次，只建立一個 session。
- 失敗情境：出生卡保持可見、`stage="error"`、顯示「人生資料下載失敗，請檢查網路後重試。」
  （無 internal key）、有「重試載入」按鈕，且**不會自動偷偷重抓或開局**；
  按重試後只重抓失敗的 mortality（mortality=2、events=1）並自動開局一次。
- `390×844` 出生卡與遊戲畫面整頁捲動量皆為 `0`。

### 本輪修掉的兩個問題

1. lint：`birthPacks` 只寫不讀 → 移除冗餘全域變數與型別 import。
2. 失敗競態：`fullWorldPromise` 在失敗後被清空，若玩家在錯誤狀態下按
   「開始人生」會暗中再起一份 world promise 並自動開局，讓錯誤頁消失。
   現在 `startLifeFromCard()` 在 `fullWorldError !== null` 時一律走 `retryWorld()`
   （明確重試、清除錯誤、保留原本開局意圖）；網路攔截測試也改為延遲 900ms 才回 503，
   讓「開始人生」確定落在同一份 pending promise 上，並新增
   `failure_does_not_auto_retry_or_start` 斷言。

另：browser smoke 第一次與全量 vitest 併跑時，CPU 4x 節流的
`cpu4x_interactive_command_p95_under_200ms` 量到 213.2ms（歷史值本來就在 86–261ms 間浮動）；
**單獨重跑後 221 checks 全 OK**（p95 回到門檻內），屬併行 CPU 爭用造成的效能抖動，非功能回歸。

---

## 五、修改檔案

**修改**：`packages/ui/src/p3e-scene.ts`、`packages/ui/src/p3e-real-main.ts`、
`packages/ui/index.html`、`packages/ui/src/style.css`、
`assets/generated/SCENE-ATTRIBUTION.md`。

**新增**：`packages/ui/src/p3e-kawaii-parts.ts`（自動產生）、
`packages/ui/src/p3e-fetch-cache.ts`、`packages/ui/src/p3e-birth-packs.ts`、
`packages/ui/src/p3e-heavy-packs.ts`、`packages/ui/src/p3e-game-layer.ts`、
`packages/ui/test/p3e-scene-parts.test.ts`、
`scripts/p3e-0058b-vendor-parts.mjs`、`scripts/p3e-0058b-critical-path.mjs`、
`scripts/p3e-0058b-network-check.mjs`、
`assets/generated/humation/{LICENSE.md,head_003.svg,head_001.svg,glasses_001.svg,cat_001.svg}`、
本報告。

診斷用的暫存腳本與 log 放在 `.artifacts/0058b-*`，不影響專案原始碼。
