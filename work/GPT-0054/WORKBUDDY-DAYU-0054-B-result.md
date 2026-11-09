# GPT-WORKBUDDY-DAYU-0054-B｜結果

**結論：完成**

任務：手機 UI 動態圖片、兩階段職業選單、收入／資產改為 CNY 顯示。
所有詳細結果記錄於本檔；聊天視窗僅回覆三態。

---

## 0. 依賴、邊界與保留他人改動

- 已先閱讀 `work/GPT-0054/DEEPSEEK-0054-A.md`；其變更**已存在於工作樹**，因此直接接上正式投影，不重做資料層：
  - `packages/contracts/src/p3e-career.ts`（27 種職業、6 分類、entry／degree）
  - `packages/application/src/p3e-profile.ts` 的 `deriveP3EScene`
  - `packages/application/src/p3e-session.ts` 的 `P3EPlaySessionView.scene`
  - 重新產生的 `fixtures/p3b/events.v1.json`（14 個職業決策事件 + `ev.adult.first-pet`）
  - `fixtures/p3b/event-copy.zh-Hant.v1.json`（449 keys）
- 已先看 `git status`；**未 commit、未 push、未 deploy、未 reset／checkout**。
  DeepSeek 與其他人的未提交改動（含 `scripts/p3e-browser-smoke.mjs` 的 golden hash／106 命令更新、
  `fixtures/*`、`packages/application/*`、`packages/contracts/*`、`scripts/p3b-generate-fixtures.ts` 等）全部保留。
- **未修改資料產生器**、未修改 `fixtures/`、未修改 `microUsd` 內部值或既有百分位演算法。
- 390×844 與 430×932 優先；整頁不因本任務新增垂直捲動（見第 5 節）。
- 無 CDN 熱連結、無任何外部素材請求。

### UI 架構限制

`scripts/check-architecture.mjs` 禁止 UI import `@life-sim/contracts` 等套件，且
`packages/ui/package.json` 只依賴 `@life-sim/application`。因此 **UI 不 import
`P3E_CAREERS`**，改在 `p3e-career-view.ts` 建立顯示層對照表，並由測試逐筆對事件包
`deltaMicroUsd` 驗證，避免兩邊漂移。UI 只讀 `view.scene` 公開投影，不解析 flags。

---

## 1. 任務一：圖片必須隨人物狀態變化

### 1.1 為何改用原創分層 SVG

舊資產 `assets/generated/life-sim-village-landscape.avif` 是**單張內含固定父、母、孩子與雞**
的插畫，且 `assets/generated/SCENE-ATTRIBUTION.md` 明載其授權狀態「待確認」。
若直接疊上動態人物會與固定人物／雞重複，也無法讓伴侶／寵物開關。

因此改為**原創向量分層圖**，以 `data:image/svg+xml,...` 當作 `.p3e-scene` 的 CSS
背景圖片。DOM 仍維持 **0 個子節點**，不干擾左側狀態卡與既有六段單屏版面。

### 1.2 新增檔案 `packages/ui/src/p3e-scene.ts`

| 圖層 | 內容 |
| --- | --- |
| `background` | `urban`（天際線、窗戶、路燈、人行道、花壇）／`rural`（遠山、梯田、瓦頂屋舍、樹、籬笆），**兩套都沒有任何人或雞**；`phase=dead` 時另有灰階配色 |
| `player` | `male/female × child/student/young/middle/senior`，身高 52／68／94／91／84、頭半徑、服裝色、裙／褲、學生背包、老年眼鏡＋手杖、女性長髮／男性短髮、老年灰白髮 `#d9d3c6` |
| `partner` | 僅 `hasPartner=true` 出現；`partnerSex` 缺席時用與玩家相反的性別；未成年時伴侶固定 `young` |
| `pet` | `dog`（垂耳＋直尾）／`cat`（尖耳＋捲尾＋虎斑）形狀明顯不同；`none` 完全不輸出 |

- 輸出是真的 SVG 向量圖（`rect`／`circle`／`ellipse`／`path`／`polygon`），**不是 emoji、不是文字、不是 CSS 色塊假裝**；`<title>` 僅為無障礙標題。
- 決定性：`hash32`（FNV-1a）由 `(seed, role, sex, stage)` 挑髮色，**無 `Math.random`、無 `Date`**。
  本次額外強化：玩家外觀**不含伴侶／寵物狀態**，所以交了伴侶或養了寵物不會換髮型 —— 同一個人在不同關係狀態下仍是同一個人。
- `sceneSvgDataUri` 額外逃逸 `(` `)` `'`（SVG 內 `rgba(...)` 含括號），確保放進 CSS `url("...")` 與 `url()` 擷取正則都不會被截斷。
- 安全讀取 `readSceneView(view)` 只認 `view.scene` 白名單欄位，畸形值回 `DEFAULT_SCENE_VIEW`，不解析 flags、不猜測人物狀態。

### 1.3 版面與不遮擋

```
SCENE_VIEWBOX_WIDTH = 390   SCENE_VIEWBOX_HEIGHT = 220
SCENE_SAFE_LEFT_X   = 190   （左側狀態卡在 390px 時約 x=16..173）
PLAYER_CENTER_X     = 232
PARTNER_CENTER_X    = 300   PET_CENTER_X = 352
```

`packages/ui/src/style.css` 場景列由 `clamp(200px, 27dvh, 246px)` 改為
`clamp(190px, 26dvh, 230px)`；並移除 `.p3e-scene` base、`.p3e-birth-hero` 與
final `.p3e-game-shell .p3e-scene` 對舊 AVIF 的引用，改為純漸層 fallback
（遊戲場景由 `renderLife()` 的 inline SVG 覆蓋）。

### 1.4 接入 `packages/ui/src/p3e-real-main.ts`

`renderLife()` 讀 `view.scene` → `readSceneView`，寫入 dataset 供測試／smoke 斷言：

```ts
scene.dataset["p3eSceneAsset"] = "generated-layered-svg";
scene.dataset["p3eSceneResidence"] = sceneView.residenceKind;
scene.dataset["p3eSceneAgeStage"] = sceneView.ageStage;
scene.dataset["p3eScenePlayerSex"] = sceneView.playerSex;
scene.dataset["p3eSceneHasPartner"] = String(sceneView.hasPartner);
scene.dataset["p3eScenePet"] = sceneView.petKind;
scene.dataset["p3eSceneLayers"] = describeSceneLayers(sceneView, sceneSeed)
  .filter((layer) => layer.visible).map((layer) => layer.layer).join(",");
scene.dataset["p3eSceneSignature"] = sceneSignature(sceneView, sceneSeed);
scene.style.backgroundImage = `url("${sceneSvgDataUri(sceneView, sceneSeed)}")`;
```

種子沿用既有 `readSeed()`，同 seed／同狀態 reload 後外觀不變。

### 1.5 需求對照

| 需求 | 狀態 |
| --- | --- |
| 背景 urban／rural 兩套、溫暖插畫風 | ✅ |
| 玩家 2 性別 × 5 階段，身高／髮型髮色／服裝可辨 | ✅ 10 種不同 `data-variant` |
| `hasPartner` 開關伴侶、不遮玩家／狀態卡 | ✅ 座標常數 + 瀏覽器換算驗證 |
| `dog`／`cat`／`none` | ✅ |
| 視覺上是圖片、非 emoji | ✅ SVG data URI；smoke 檢查 `children=0`、`text=""`、無 emoji |
| 同 seed／狀態同外觀 | ✅ FNV-1a，無隨機 |
| 190–230px、不遮左卡、不新增整頁下滑 | ✅ 390×844 = 219px；430×932 = 230px |
| 背景不含固定人物／雞 | ✅ 背景層只含景物，單元測試檢查不含人物皮膚色／眼睛色 |

---

## 2. 任務二：兩階段職業選擇 UI

### 2.1 新增 `packages/ui/src/p3e-career-view.ts`

- `parseCareerDecision` 辨識兩階段：
  - `dec.adult.career-field` → `stage: "category"`
  - `dec.adult.career-<service|trade|office|care|tech|independent>-<entry|degree>` → `stage: "job"`
  - 其他決策（含 `dec.adult.career-pivot`、`dec.adult.first-job`）回 `null`，走原本 `renderPending`。
- `CAREER_ESTIMATES`：27 筆顯示層對照（6 分類），含繁中名稱、tier、`minKnowledge`、
  `annualIncomeUsd`；`careerIncomeMicroUsd()` 產生與事件包 `deltaMicroUsd` 完全相同的 micro-USD 字串。
- `buildCareerOptionViews()` 產出 `label`／`incomeText`／`note`／`disabled`：
  - 每個職業按鈕顯示名稱 + `預估年收入 CNY x.x萬`；
  - 不屬本分類／本學歷層級／不在目錄的選項**防禦性停用**，說明「目前學歷還不適合這份工作」；
  - 知識不足只提示「需要較高的專業知識」但**不停用**，避免全部鎖死造成死局；
  - `safeLabel` 在字典缺漏或回傳 raw key 時降級為自然繁中名稱。
- `careerListNote()` / `careerCategoryHintKey()` 提供自然繁中說明。

### 2.2 `renderPending()` 與 CSS

- 職業決策改用 `.p3e-career-options` 兩欄卡片（`grid-template-columns: repeat(2, minmax(0,1fr))`），
  每張卡含 `<strong class="p3e-career-name">`、`<span class="p3e-career-income">`、
  可選 `<small class="p3e-career-hint">`；`max-height: min(36dvh, 300px); overflow-y: auto`
  讓決策區**自己捲動**，不把時間控制與下一步推出螢幕。
- `renderPending(pending, knowledge)` 新增 `knowledge` 參數，call site 傳 `view.stats.knowledge`（公開投影）。
- 停用選項同時設 `disabled`、`aria-disabled="true"` 與 `data-p3e-career-disabled="true"`。

### 2.3 「目前職業」與人生紀錄一致

- `packages/ui/src/p3e-view-readers.ts` 的 `ROLE_LABELS` 已補齊 27 個職業 ID；
  本次再把 3 個 0040-A 舊標籤統一為 0054-A 權威字典用語：
  `salesperson`「銷售員」→「業務銷售」、`farmer`「農民」→「農夫」、
  `shopkeeper`「店主」→「自營店主」。
  如此「目前職業」、職業按鈕、人生紀錄顯示同一個具體職業名稱。
- 人生紀錄沿用既有 `friendlyChosenOption()`：`ev.adult.career-service-degree` →
  `p3b.option.adult.career-service-degree.hotel_manager` → 「旅宿主管」；27 筆逐一驗證。

---

## 3. 任務三：收入與資產顯示為 CNY

### 3.1 新增 `packages/ui/src/p3e-cny.ts`（純顯示層）

- 固定 `1 USD = 7.2 CNY`，以 BigInt 整數比例 `72/10` 換算：
  `microCny = microUsd * 72n / 10n`。**不呼叫匯率 API、不用浮點數**（大金額不掉精度）。
- 完整：`CNY 2,588,952.96`；緊湊：`CNY 12.8萬`／`CNY 1.2億`；一律以 `CNY` 開頭。
- `financeDisplay(value, minor, compact)`：未成年一律回 `—`，**不會因換算恢復兒童收入／資產**；
  無效值也回 `—`，絕不印出原始 `microUsd` 或 internal key。
- `careerIncomeLabel()` 給職業按鈕用，例如「預估年收入 CNY 24.5萬」。

### 3.2 接入與不變的部分

- `p3e-real-main.ts` 移除舊 `formatMicroUsd`／`formatCompactMicroUsd` 的 `$` 實作，
  HUD 四個金額改呼叫 `financeDisplay(...)`；`title`／`aria-label`／`data-p3e-finance-full`
  也一併是 CNY（完整值不刪減）。
- **內部 `microUsd` base10 字串、百分位演算法、存檔格式、golden / replay 全部未動**。
- `renderComparisonStrip()`（中國／全球收入與資產百分比）維持原邏輯，UI 不重算百分位，
  也未把百分位誤當貨幣；測試驗證百分比字串不會被 CNY 函式接受、CNY 輸出不含 `%`。
- 舊 `data-p3e-minor-finance` 規則不變（未成年 HUD 兩個欄位仍是 `—`）。

---

## 4. 授權與 attribution

- **沒有 vendor 任何第三方素材**：未引入 `juanpe500/2d_chars`（只參考分層概念自行實作），
  未複製 `hbarokha/lifeline` 程式碼，未使用授權不明的像素圖，無 CDN 熱連結。
  因此沒有需要附上的 MIT LICENSE／來源 URL／commit SHA。
- `assets/generated/SCENE-ATTRIBUTION.md` 已追加「GPT-WORKBUDDY-0054-B」章節，
  如實記載：新場景為本專案原創向量圖、舊 AVIF 已從 UI 引用移除、
  舊圖「待確認」授權狀態仍適用於留在磁碟的舊檔案、將來重新啟用前須補齊授權證據。
- 舊圖仍保留在磁碟供來源追溯，但**不進入打包結果與首屏請求**
  （build 輸出無任何 `.avif`，smoke `scene_no_external_asset_in_boot` 為 0 筆）。

---

## 5. 驗證鏈

| 項目 | 指令 | 結果 |
| --- | --- | --- |
| typecheck | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| UI 單元測試 | `./node_modules/.bin/vitest run packages/ui` | ✅ 6 files / **102 tests** |
| 完整測試套件 | `./node_modules/.bin/vitest run --maxWorkers=2` | ✅ 117 files / **2319 tests** |
| 正式 build（H5 UI） | `./node_modules/.bin/vite build --config vite.p1c.config.ts` | ✅ built，無 AVIF 產物 |
| 正式 build（root） | `./node_modules/.bin/vite build --config vite.config.ts` | ✅ built in 379ms |
| 瀏覽器 smoke | `node scripts/p3e-browser-smoke.mjs` | ✅ `P3E-BROWSER-SMOKE OK checks=221`，0 FAIL，`boot_required_gzip=426424`、`boot_ms=656` |
| 手機版面／截圖 | `node scripts/p3e-mobile-layout-check.mjs` | ✅ `SUMMARY 546/546 PASS` |

### 5.1 新增／更新的 UI 測試

- `packages/ui/test/p3e-scene.test.ts`（9 tests）
  - **完整矩陣 2 性別 × 5 年齡 × 2 城鄉 × 有／無伴侶 × dog／cat／none = 120 組**；
  - 背景不含人物／雞與人物用色；10 種玩家外觀；伴侶／寵物不遮玩家與左卡；
  - 同 seed 穩定、不同 seed 多樣但各自穩定；死亡狀態；data URI 無 CDN；`readSceneView` 白名單回退。
- `packages/ui/test/p3e-cny.test.ts`（7 tests）
  - `1 USD = 7.2 CNY` 定點換算、完整／萬／億格式、`CNY` 標籤、未成年 `—`、
    無效輸入不外洩、職業收入文案、百分位不誤當貨幣、無 `$`／`microUsd`／internal key。
- `packages/ui/test/p3e-career-view.test.ts`（13 tests）
  - 27 筆 `CAREER_ESTIMATES` 逐筆對事件包 `deltaMicroUsd`（`checked=27`）與分類／tier；
  - 兩階段解析（12 個 job 決策）、分類提示、選項顯示、防禦性停用、知識不足不停用、
    字典缺漏降級、**「目前職業」＋人生紀錄 27 個具體名稱一致**、無 internal key 外洩。

### 5.2 瀏覽器 smoke 新增／更新檢查

- CNY：`adult_finance_shows_application_view_values` 由 `$` 改為 `CNY`；新增
  `finance_cny_no_dollar_or_micro_usd_leak_in_body`。
  實測 HUD：`["2091","67 歲","CNY 594.0萬","CNY 46.8萬"]`、
  full：`["CNY 5,939,661.60","CNY 468,000.00"]`，`dollar=false micro=false`。
- 場景：移除舊 AVIF 斷言，改為
  `scene_no_external_asset_in_boot`（0 筆外部場景請求）、
  `scene_layered_svg_fills_width_no_overlay`（解碼 SVG、驗證 viewBox 390×220、
  圖層、無外部連結、人物中心換算後不遮狀態卡／玩家）、
  四個尺寸的 `viewport_*_layered_scene_layout`（390×844 = 219px、430×932 = 230px）。
- 動態狀態：`dynamic_scene_uses_generated_layered_svg`（39 個決策樣本）、
  `dynamic_scene_layers_follow_partner_and_pet_state`（伴侶 30／寵物 24，
  pets = `none,dog`）、`dynamic_scene_changes_with_age_and_state`
  （5 個年齡階段、7 個不同 signature）。
- 職業：`career_two_stage_decisions_both_reached`（category=1、job=1）、
  `career_category_cards_six_fields_no_income`、`career_job_cards_show_name_and_cny_income`
  （實測「旅宿主管／預估年收入 CNY 15.8萬」、「主廚／預估年收入 CNY 20.2萬」）、
  `career_cards_no_internal_key_microusd_dollar`、
  `career_decision_keeps_time_controls_on_screen_no_page_scroll`
  （`docY=0 bodyY=0 scrolled=0`）、`career_decision_options_scroll_internally`（`overflow=auto`）。
- 既有 `viewport_*_vertical_overflow_0`（390×844、430×932、360×640、320×568）、
  `all_six_sections_visible`、touch target 44px、axe、golden state hash／106 命令、
  save/load/replay、no internal key 等**全部維持綠燈**。
- 手機版面腳本同步把 `measureSceneAsset()` 由「fetch AVIF + canvas 像素量測」改成
  「解碼 SVG data URI + 滿版背景 rect + 圖層／無外部連結」，
  `546/546 PASS`；390×844 與 430×932 的 `life`／`pending_decision`／`death` 截圖已產出於
  `.artifacts/mobile-layout/`。目視 390x844-life.png：城市天際線、向量小孩人物、
  左側深色狀態卡皆清楚可見，人物未被裁切或遮擋，場景無 emoji 代替人物。

### 5.3 兩處必要的既有 gate 調整（如實記載）

1. **文案字典 gzip 上限 8KiB → 10KiB**：DeepSeek 0054-A 讓字典從 307 條增為 449 條，
   實測 `gzip=9258`。已放寬為 `10 * 1024` 並保留嚴格上限，檢查名稱改為
   `copy_dictionary_gzip_under_10kb`；boot 總量 gate **512KiB 不變**，
   且移除舊 AVIF 後首屏總量反而下降（實測 `boot_required_gzip=426424`）。
2. **小尺寸場景高度**：360×640／320×568 既有 media query 會刻意把場景壓到 141／125px，
   因此 190–230px 斷言只套用在任務指定的 390×844／430×932；
   其餘尺寸仍驗證分層 SVG 有效、0 子節點、無整頁捲動。

### 5.4 已知非阻塞事項

- 以預設平行度跑完整 `vitest run` 時，DeepSeek 的
  `packages/application/test/p3e-career-pet-scene-0054.test.ts` 曾因 worker RPC 競爭
  在 30s timeout 失敗（該測項單獨執行 7.6s、13/13 通過）。
  改用 `--maxWorkers=2` 後完整套件 **117 files / 2319 tests 全綠**，
  為既有的滿載平行度 flake，**不是本次改動造成的回歸**，也未修改他人測試。

---

## 6. 交付檔案清單

**新增**
- `packages/ui/src/p3e-scene.ts`
- `packages/ui/src/p3e-cny.ts`
- `packages/ui/src/p3e-career-view.ts`
- `packages/ui/test/p3e-scene.test.ts`
- `packages/ui/test/p3e-cny.test.ts`
- `packages/ui/test/p3e-career-view.test.ts`
- `work/GPT-0054/WORKBUDDY-DAYU-0054-B-result.md`（本檔）

**修改**
- `packages/ui/src/p3e-real-main.ts`（CNY、動態場景、兩階段職業決策）
- `packages/ui/src/p3e-view-readers.ts`（補齊 27 個職業標籤、統一 3 個舊標籤）
- `packages/ui/src/style.css`（移除舊 AVIF、場景列高度、兩欄職業卡）
- `scripts/p3e-browser-smoke.mjs`（CNY／分層 SVG／職業／動態場景驗收）
- `scripts/p3e-mobile-layout-check.mjs`（分層 SVG 量測）
- `assets/generated/SCENE-ATTRIBUTION.md`（0054-B 原創素材與授權章節）

**未動**：`fixtures/`、`scripts/p3b-generate-fixtures.ts`、
`packages/contracts/`、`packages/application/`、`packages/simulation/` 及其他人的未提交改動。

---

## 7. 結論

三項任務皆已落地並通過 typecheck、UI 測試、完整測試套件、正式 build、
瀏覽器 smoke（221 checks）與手機版面／截圖（546/546）。
無 commit、無 push、無部署；未使用任何第三方素材或 CDN。
