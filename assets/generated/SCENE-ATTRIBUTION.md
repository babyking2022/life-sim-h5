# 場景資產說明｜life-sim-village-landscape.avif

本文件記錄 GPT-0032-B 新增的橫向場景資產来源與製作方式。**不宣稱任何未經證實的第三方授權。**

## 資產

| 項目 | 值 |
| --- | --- |
| 檔案 | `assets/generated/life-sim-village-landscape.avif` |
| 像素尺寸 | 1280 × 720（16:9） |
| 格式／參數 | AVIF，quality 45、speed 6（Pillow/libavif） |
| 檔案大小 | 85,499 bytes（gzip 85,519 bytes） |
| SHA-256 | `460339092a586104f791c7a0d510327200351043c13f49ba5a6f45542958b96a` |
| 無損母圖 | `.artifacts/0032b/landscape-master-1280x720.png`（僅供重製，不隨網站發布） |

## 來源與製作方式

1. **來源**：專案既有的 `assets/generated/life-sim-village-mvp.png`
   （941 × 1672，直立像素風鄉村插畫）。這是專案內既有資產，
   **本輪沒有從任何外部網站下載、沒有使用生成式圖像模型、沒有引入第三方素材**。
2. **重新構圖**：自原 PNG 裁出主體橫帶 `x=0..941, y=545..1265`（941 × 720）。
   此帶保留父、母、孩子三人全身、瓦頂屋舍、門窗、晾衣繩、菜園、籬笆、
   庭院石板路與雞；被裁去的是上方大片天空與下方溪流，主體沒有被縮放變形。
3. **左右自然延展**：為達 16:9，左右各補 169／170 px。左側取主體帶
   `x=0..130` 水平鏡像、右側取 `x=811..941` 水平鏡像，兩側接縫處像素連續；
   鏡像區刻意排除人物所在範圍，因此不會複製出第二組人物。
   屋舍、燈籠、花盆與雞在右側形成自然延續，遠山、樹林與菜園在左側延續。
   **這不是把直立圖拉伸**，也不是用兩側空白假裝完整顯示。
4. **編碼**：以 Pillow 存為 AVIF（quality 45）。WebP 同尺寸 q70 需 162,876 bytes，
   AVIF 僅 85,499 bytes，可同時降低首屏體積。

重製腳本（含上述裁切／鏡像／編碼參數）存於
`.artifacts/0032b/make-scene.py`。

## 授權狀態（如實記載）

- 專案內**沒有找到** `life-sim-village-mvp.png` 的原始授權、作者或來源紀錄；
  既有結果文件亦未記載。此處**不杜撰** CC0、CC-BY、作者姓名或來源網址。
- 新資產是該既有資產的**衍生重構圖**，權利狀態沿用原圖，仍屬**待確認**；
  公開測試 MVP 可沿用既有資產的使用範圍，正式上線前應由編排者／法務補齊來源與授權證據。
- 相較之下，`assets/audio/ATTRIBUTION.md` 的鳥鳴音檔有明確 CC0 來源與 commit，
  與本場景資產的授權狀態不同，請勿混為一談。

## 執行期行為

- 只由 `packages/ui/src/style.css` 以相對路徑引用，經 Vite 打包為本機 hashed asset；
  執行期不請求任何外部網域。
- 舊直立圖 `life-sim-village-mvp.webp` 保留在磁碟作為來源追溯，
  但已不再被任何 CSS 規則引用，因此不會進入首屏打包／請求。
- AVIF 需支援 `image/avif` 的瀏覽器（Chrome 85+、Edge 85+、Firefox 93+、
  Safari 16+）；兩個瀏覽器驗收腳本的靜態伺服器已加上對應 MIME。

## GPT-WORKBUDDY-0054-B：改用原創分層 SVG（取代上述 AVIF）

- 本輪**沒有 vendor 任何第三方素材**，因此沒有需要附上的 MIT LICENSE、
  來源 URL 或 commit SHA。具體而言：
  - 沒有引入 `juanpe500/2d_chars`（僅參考其「分層精靈」概念，自行實作 SVG 圖層）；
  - 沒有複製 `hbarokha/lifeline` 的程式碼（僅參考年齡映射／資料結構概念）；
  - 沒有使用任何授權不明的像素圖，也沒有 CDN 熱連結。
- 遊戲場景與出生卡已**不再引用** `life-sim-village-landscape.avif` 與
  `life-sim-village-mvp.png`：前者內含固定一家人與雞，且授權狀態為「待確認」。
  兩張圖仍保留在磁碟供來源追溯，但不會進入打包結果與首屏請求。
- 新場景由 `packages/ui/src/p3e-scene.ts` 以 `rect`／`circle`／`ellipse`／
  `path`／`polygon` 即時產生，是**本專案原創向量圖**，以
  `data:image/svg+xml,...` 作為 `.p3e-scene` 的 CSS 背景圖片；沒有外部網域請求，
  也沒有用 emoji 或文字代替人物／寵物。
- 圖層：背景（urban／rural 兩套，皆無任何人或雞）＋玩家（2 性別 × 5 年齡階段，
  身高／髮型／髮色／服裝各異）＋伴侶（`hasPartner`）＋寵物（dog／cat／none）。
  外觀是 `(view.scene, seed)` 的純函式（FNV-1a 雜湊挑髮色），
  **無 `Math.random`、無 `Date`**，同 seed／同狀態永遠得到同一張 SVG。
- 授權：本輪新增的向量圖形為原創，無第三方權利負擔；上述 AVIF 的
  「待確認」狀態不適用於新場景，但仍適用於保留在磁碟的舊圖，
  舊圖若將來重新啟用仍須先補齊授權證據。

## GPT-WORKBUDDY-0058-B：vendor 少量 Humation 手繪 SVG 部件（MIT）

上一節「沒有 vendor 任何第三方素材」是 **0054-B 當時**的事實紀錄；
0058-B 起改為另行 vendor 下列第三方素材，並在此如實記載授權。

### 來源與授權

| 項目 | 值 |
| --- | --- |
| 專案 | [humation-labs/humation](https://github.com/humation-labs/humation)（Humation 1，手繪 kawaii avatar engine） |
| 固定 commit | `85613cfac2d600c05847f403fc275336ab1fa240` |
| 素材包 | `packages/assets-humation-1`（上游共 86 個部件，slots：head／body／bottom／item／glasses） |
| 授權 | **MIT License**，程式與素材皆為 MIT；`Copyright (c) 2026 Humation contributors` |
| 完整授權文字 | `assets/generated/humation/LICENSE.md`（1080 bytes，SHA-256 `53c4b2ca2f1eb373e91020ad6ff50b53ef7ee685937385ded1c3f67495b23c88`） |
| 取得方式 | 由該 commit 的 raw 檔案下載後原樣保存在本機，**沒有** CDN、API 或執行期熱連結 |

MIT notice 原文（與 `LICENSE.md` 一致）：

```text
# MIT License

Copyright (c) 2026 Humation contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 實際 vendor 的 4 個部件（最小核心，非整套）

只取 4 個必要部件；**沒有**搬入 86 個部件、React 套件、avatar builder、editor 或示範網站。
原始未修改 SVG 保存在 `assets/generated/humation/`，SHA-256 如下：

| 專案 key | 上游路徑 | 本機檔名 | 原始 bytes | 壓縮後 bytes | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `head/short` | `head/003.svg` | `head_003.svg` | 8,703 | 6,598 | `a3562f2bd861ca763d2f0beabb50c62b6e39627b3d91eba761d1e29c6a8f4fcf` |
| `head/fluffy-bob` | `head/001.svg` | `head_001.svg` | 11,679 | 8,876 | `6563bca96b0522ed27bbac5c927ac241fcde4f590edb71bd4a8c9403cd0c8f95` |
| `glasses/round` | `glasses/001.svg` | `glasses_001.svg` | 627 | 467 | `cafcd188ab90288a8072ccda20d6f94c38b56dd69ab7f2a27948f3077bb4b8d7` |
| `cat/tabby` | `cat/001.svg` | `cat_001.svg` | 6,706 | 6,429 | `a56fa8dbafd57b25e560d4c4a945ecefd06aa1e95d1c090a0115aee43ea04e39` |

合計原始 `27,715 bytes` → 精簡 `22,370 bytes`；產生的 TS 常數模組
`packages/ui/src/p3e-kawaii-parts.ts` 為 `25,031 bytes`。
重製腳本：`node scripts/p3e-0058b-vendor-parts.mjs`（只讀本機 vendor SVG，
不在執行期連網）。壓縮只做「去 `<svg>` 外殼、降數字精度至 2 位、去多餘空白、
把 `var(--hm-*)` 色彩變數換成 `{{slot}}` 佔位符」，沒有改繪圖筆觸本身。

### 與場景的關係

- `packages/ui/src/p3e-scene.ts` 以 `humationPart(key, colors)` 注入確定性色彩，
  與 0054-B 既有的原創城市／農村背景、原創身體／服裝／狗／老化特徵組合成單張
  `data:image/svg+xml,...` 背景圖；仍無外部網域請求、無 emoji 代替人物。
- `male` 固定 `head/short`＋`original/body/trousers`，`female` 固定
  `head/fluffy-bob`＋`original/body/dress`；五個年齡階段共用同一性別部件集合，
  `senior` 只追加 `glasses/round`、皺紋、手杖與灰白髮色。伴侶直接使用
  `scene.partnerSex`；貓用 `cat/tabby`，狗為本專案原創手繪（上游沒有狗部件）。
- 上游 AVIF／舊 PNG 的「授權待確認」狀態**不因本節改變**：那些檔案仍只留在磁碟
  供追溯，不被打包、不被請求；若要重新啟用仍須先補齊授權證據。
- 未使用備選 `Hantuhan/peepstudio`（Open Peeps, CC0）；也沒有使用任何授權不明的圖片。
