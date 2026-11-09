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

> **0062-B 狀態更新：本節為歷史紀錄，Humation 已不在 runtime 使用。**
> `p3e-scene.ts` 自 0062-B 起改用完整 Open Peeps 全身人物；
> `p3e-kawaii-parts.ts` 沒有任何 import，不會進入出生卡關鍵路徑或任何
> build chunk。下列 MIT LICENSE／4 個原始 SVG 僅保留作授權追溯，
> 詳見下一節。

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

## GPT-WORKBUDDY-0062-B：改用完整 Open Peeps 全身人物（CC0 1.0）

### 來源與授權

| 項目 | 值 |
| --- | --- |
| 原始美術 | **Open Peeps by Pablo Stanley** |
| 官方站 | <https://www.openpeeps.com/> |
| 授權 | **CC0 1.0 Universal**（public domain dedication） |
| 官方站授權原文 | 「Free for commercial and personal use under CC0 License.」／「The library is in the public domain under the CC0 License. This means you can copy, modify, distribute, remix, burn, and use the work, even for commercial purposes, without asking permission.」 |
| CC0 法律全文 | `assets/generated/open-peeps/CC0-1.0-legalcode.txt`（取自 <https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt>） |
| 取得日期 | **2026-11-09**（UTC+8） |
| 取得方式 | 官方站「Grab and go! / Standing」的 ready-to-download 全身 SVG，由其官方 Webflow CDN 下載後原樣保存在本機 |
| 官網 HTML 快照 SHA-256 | `35043e7dc1460850db46ae0d0fd36937846a3bd289ddedbb9ec047597f3de2b7`（83,921 bytes） |
| 詳細清單 | `assets/generated/open-peeps/SOURCE.md`（8 個檔案各自的來源 URL、bytes、SHA-256、部件 id） |
| 組合器參考 | <https://github.com/Hantuhan/peepstudio>（commit `3bad422845c470ae11531b765fe88451cdb2b66f`） |

**沒有**從 PeepStudio repo 搬任何 SVG、153 模板、516 atoms、Next.js、Supabase、
Konva 或帳號功能；也**沒有**抓取任何授權不明的第三方重包。只參考其
「Open Peeps 全身角色」概念，實際素材全部來自創作者官方站。
CC0 不要求署名，此處仍完整記錄來源與證據。

### 實際 vendor 的 8 個官方全身 SVG（curated 最小集合）

| key | 性別分組 | 上游部件 | 官方來源 URL | bytes |
| --- | --- | --- | --- | --- |
| `male-a` | male | `pose/standing/crossed_arms-2` / `head/hat-beanie` | <https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5361909b55b0502657e357_peep-standing-11.svg> | 35,861 |
| `male-b` | male | `pose/standing/shirt-4` / `head/Flat-Top-Long` | <https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5362a27488c217864c784d_peep-standing-20.svg> | 33,028 |
| `male-c` | male | `pose/standing/polka_dots` / `head/Short-5` | <https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5362c164109d10570651c3_peep-standing-21.svg> | 38,011 |
| `male-d` | male | `pose/standing/easing-1` / `head/No-Hair-1` | <https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5361ccd3992383f7595afc_peep-standing-13.svg> | 46,063 |
| `female-a` | female | `pose/standing/resting-1` / `head/Hijab` | <https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5360d39b55b049be5795a1_peep-standing-5.svg> | 34,651 |
| `female-b` | female | `pose/standing/blazer-3` / `head/Long` | <https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5361568e2493c0fa0ae191_peep-standing-9.svg> | 36,626 |
| `female-c` | female | `pose/standing/resting-2` / `head/Long` | <https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5360ba550b761a0bfabd32_peep-standing-4.svg> | 38,893 |
| `female-d` | female | `pose/standing/walking-2` / `head/Long-Afro` | <https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e53633a7371bbe22da4c986_peep-standing-25.svg> | 42,154 |

合計原始 `305,287 bytes`（gzip `145,749`）→ 精簡後 `181,839 bytes`
（gzip `79,348`）；產生的 TS 常數模組 `packages/ui/src/p3e-open-peeps.ts`
為 `188,502 bytes`。重製腳本 `node scripts/p3e-0062b-vendor-peeps.mjs`
只讀本機 SVG，不在執行期連網；壓縮只做去註解／去 Sketch 中繼 id（含
emoji 圖層名）／降數字精度至 2 位／把黑白填色換成色彩佔位符，
**不改繪圖筆觸**。真實官方群組已轉成 `data-part="openpeeps/..."`，
供矩陣測試直接檢查資產／部件 key。runtime metadata 只保留穩定的
`sourceId`（例如 `official/peep-standing-11`）、SHA-256 與 bytes；
**完整官方來源 URL 只存在本文件與 `SOURCE.md`**，因此打包後的 JS
完全不含任何外部網域字串，也不可能被執行期誤當成熱連結。

### 與場景的關係

- 玩家與伴侶**都**使用同一套完整官方全身 SVG；不再有「Humation 頭部 +
  自畫身體」或「女性固定裙子、男性固定褲子」的混搭。
- 性別角色池各 4 個不同衣著／姿勢；資產由 `(seed, role, sex)` 決定，
  **不含年齡／伴侶／寵物狀態**，五階段共用同一角色。老化只改縮放、髮色、
  衣著色與眼鏡／手杖／背包／圍巾等原創增量配件；伴侶直接用
  `scene.partnerSex`，新伴侶可由 seed 的 partner-identity 後綴換外觀。
  > **0063-B 狀態更新：本句為 0062-B 的歷史描述。** CTO 判定「把成人
  > Open Peeps 縮小給 0 歲嬰兒／學生」不合格；0063-B 起 0–22 歲改用
  > 下方「本專案衍生」的年齡專用全身人物，官方 8 個成人成品只用於
  > 23 歲以上。identity（seed／膚色／髮型 series／性別）仍跨年齡不變。
- 城市／農村背景、狗／貓與年齡配件為本專案原創輕量向量；
  0062-B 起狗與貓都**不再**使用 Humation 部件。
- 人物場景相關程式（`p3e-open-peeps.ts`／`p3e-scene.ts`）由
  `p3e-game-layer.ts` 延遲載入，不在出生卡關鍵路徑；執行期輸出為單張
  本機 `data:image/svg+xml`，**不請求** openpeeps.com、PeepStudio、
  GitHub raw 或任何圖床。
- 上方的 0058-B Humation MIT 段落與 `assets/generated/humation/` 檔案
  僅為歷史授權追溯，`p3e-kawaii-parts.ts` 已無任何 import。
- 0032-B 的 AVIF／舊 PNG「授權待確認」狀態不因本節改變：那些檔案仍只留在
  磁碟供追溯，不被打包、不被請求。

---

## GPT-WORKBUDDY-0063-B｜年齡專用衍生人物（**本專案衍生，非官方原件**）

CTO 判定 `work/GPT-0062/screenshots/00-真实开局-390x844.png` 的 0 歲嬰兒
其實是「縮小的成年女性」、`01-男性-学生-390x844.png` 是「縮小的成年男性」，
因此 0062-B 的美術不能視為產品完成。官方 Open Peeps 的 Standing 成品集合
**只有成人**，沒有嬰幼兒或學生；0063-B 依 CC0 1.0 明確允許的
`copy, modify, distribute, remix` 權利，以 Open Peeps 的手繪筆觸
（圓頭黑線、色塊填充、圓潤關節）**自行繪製 20 個本專案衍生 SVG**。

> **這 20 個檔案全部是「本專案衍生」作品，不是從官方站、PeepStudio repo
> 或任何第三方重包下載的原件，也不假稱官方原件。** 官方 8 個成人成品
> 仍列於上一節，兩者不混為一談。

| 項目 | 內容 |
| --- | --- |
| 基礎風格 | Open Peeps by Pablo Stanley（<https://www.openpeeps.com/>） |
| 授權 | **CC0 1.0 Universal**；法律全文 `assets/generated/open-peeps/CC0-1.0-legalcode.txt` |
| 官方授權原文 | 「Free for commercial and personal use under CC0 License.」／「...copy, modify, distribute, remix...without asking permission.」 |
| 繪製日期 | **2026-11-09**（UTC+8） |
| 產生器 | `scripts/p3e-0063b-derived-peeps.mjs`（參數化 SVG 路徑，不連網、不呼叫 API） |
| 實際檔案 | `assets/generated/open-peeps/derived/<stage>-<series>.svg`，20 個，全部隨本站自託管 |
| 完整清單 | `assets/generated/open-peeps/derived/DERIVED-SOURCE.md`（逐檔 SHA-256、bytes、body/hair key） |
| SOURCE.md | `assets/generated/open-peeps/SOURCE.md` 末尾另有幂等附加的衍生段落 |

### 五個年齡階段 × 四個 identity series

| 階段 | 年齡 | 人物 | body key |
| --- | --- | --- | --- |
| `baby` | 0–2 | 坐姿大頭嬰幼兒、連身衣／尿布褲、圍兜 | `openpeeps-derived/body/onesie-*` |
| `child` | 3–5 | 幼童比例、短上衣＋短褲、圍兜 | `openpeeps-derived/body/toddler-*` |
| `primary` | 6–11 | 小學生校服、書包帶、領巾、長褲 | `openpeeps-derived/body/school-*` |
| `teen` | 12–17 | 青少年連帽衫、斜挎包、長褲 | `openpeeps-derived/body/teen-*` |
| `university` | 18–22 | 大學生開襟外套、背包、長褲 | `openpeeps-derived/body/campus-*` |
| `young/middle/senior` | 23+ | 沿用 0062-B 的 8 個**官方**成人 Standing 成品 | `openpeeps/pose/standing/*` |

- 嬰兒／幼童的 body key **不可能**等於官方成人 `openpeeps/pose/standing/*`；
  學生的 body key 不含 `blazer`／`suit`／`business-only` 字樣，矩陣測試直接斷言。
- 同一人物跨年齡維持同一 series → 同一 `data-part="openpeeps-derived/hair/..."`
  髮型 key；膚色／髮色／衣著色由穩定 seed 注入，跨年齡不變（老年白髮例外）。
  變成 `young` 時才切到官方成人成品，且性別與 identity 都不變。
- 4 種服裝款式（圓領／背帶／條紋／襯衫領）對**男女都開放**；長褲、短褲、
  連身衣按年齡而非性別決定，沒有「女性固定粉紅裙、男性固定藍褲」。
- 城市／農村背景、狗／貓、老年眼鏡／皺紋／手杖／圍巾仍是本專案原創輕量向量。
- 20 個衍生 SVG 原始合計 **65,564 bytes**（gzip `16,143`）→ 去外殼／色彩
  佔位符後 `63,135 bytes`（gzip `14,382`）；產生的
  `packages/ui/src/p3e-open-peeps-derived.ts` 為 `82,297 bytes`
  （gzip `7,748`）。只被 `p3e-scene.ts` 引用，隨 `p3e-game-layer.ts`
  延遲載入，**不在出生卡關鍵路徑**；執行期仍是單張本機
  `data:image/svg+xml`，不請求任何外部網域。
- 上方的 0062-B 官方 8 個成人成品、0058-B Humation MIT 歷史段落、
  0032-B 授權待確認的 AVIF／PNG 狀態都不因本節改變。
