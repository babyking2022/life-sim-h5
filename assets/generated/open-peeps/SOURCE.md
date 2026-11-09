# Open Peeps CC0 素材來源與證據｜GPT-WORKBUDDY-0062-B

- 取得日期：**2026-11-09**（UTC+8）。
- 官方站：https://www.openpeeps.com/；作者：Pablo Stanley。
- 素材取自官方站「Grab and go! / Standing」的 ready-to-download 全身 SVG，
  由官方 Webflow CDN 下載後**原樣保存**；本站執行期只用 build 後的本機向量，不熱連結外部網域。
- 授權：**CC0 1.0 Universal（public domain dedication）**。官方站原文：

  > "Free for commercial and personal use under CC0 License."
>
  > "The library is in the public domain under the CC0 License. This means you can copy, modify, distribute, remix, burn, and use the work, even for commercial purposes, without asking permission."

- 法律全文：`CC0-1.0-legalcode.txt`（取自 https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt）。
- 取得當時官網 HTML 快照 SHA-256：`35043e7dc1460850db46ae0d0fd36937846a3bd289ddedbb9ec047597f3de2b7`（83,921 bytes，存於本機建置快取，不隨網站發布）。
- 組合器參考：https://github.com/Hantuhan/peepstudio（commit `3bad422845c470ae11531b765fe88451cdb2b66f`）。
  **本輪沒有從該 repo 搬任何 SVG、模板、Next.js、Supabase、Konva 或帳號功能**，
  只參考其「Open Peeps 全身角色」概念；其 153 模板／516 atoms 亦未隨本站打包。

## 實際使用的 8 個官方全身 SVG（curated 最小集合）

| 本機 key | 性別分組 | 上游部件 id | 本機檔名 | 官方來源 URL | bytes | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
| `male-a` | male | `pose/standing/crossed_arms-2` / `head/hat-beanie` | `male-a.svg` | https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5361909b55b0502657e357_peep-standing-11.svg | 35,861 | `ae98aefaf10d95878bfeed159173064b276aa3746e40f3cae62125cd305ddfff` |
| `male-b` | male | `pose/standing/shirt-4` / `head/Flat-Top-Long` | `male-b.svg` | https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5362a27488c217864c784d_peep-standing-20.svg | 33,028 | `ba347f6a55ae2a4bf3e9e0b61d6e1aadfa250037396d1b6f844dc0d92dc75c19` |
| `male-c` | male | `pose/standing/polka_dots` / `head/Short-5` | `male-c.svg` | https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5362c164109d10570651c3_peep-standing-21.svg | 38,011 | `5f3b379be2cf13fbcb7d0be93c86c7e6b69e7618c29dc5f4f2d3b4fe754e4b53` |
| `male-d` | male | `pose/standing/easing-1` / `head/No-Hair-1` | `male-d.svg` | https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5361ccd3992383f7595afc_peep-standing-13.svg | 46,063 | `a8a87c1247b6b54d7319cba4f95c83a46385d1b0f9250054960719941989146b` |
| `female-a` | female | `pose/standing/resting-1` / `head/Hijab` | `female-a.svg` | https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5360d39b55b049be5795a1_peep-standing-5.svg | 34,651 | `48ee978f47511ff66a373dd527072f02da57232edffceb37d0d108bbdc007c8a` |
| `female-b` | female | `pose/standing/blazer-3` / `head/Long` | `female-b.svg` | https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5361568e2493c0fa0ae191_peep-standing-9.svg | 36,626 | `604e17c6380d4b2de328ff1d325ae9ae588f59ea8a62fcce567bc195e793a973` |
| `female-c` | female | `pose/standing/resting-2` / `head/Long` | `female-c.svg` | https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e5360ba550b761a0bfabd32_peep-standing-4.svg | 38,893 | `43be974ee3561925b6e7f669bc29fb2744edb605db797b476e6b3ff9173f730f` |
| `female-d` | female | `pose/standing/walking-2` / `head/Long-Afro` | `female-d.svg` | https://cdn.prod.website-files.com/5e51c674258ffe10d286d30a/5e53633a7371bbe22da4c986_peep-standing-25.svg | 42,154 | `0c33051d7b39f72328403bd39159a82e44aaef45520f28178914caf0fd3d176d` |

## 使用範圍與大小

- 玩家與伴侶**都**使用這 8 個完整全身 Open Peeps 成品；不再混用 Humation 頭部或自畫身體。
- 城市／農村背景、狗／貓、眼鏡／手杖／背包等年齡配件為本專案原創輕量向量，沿用同一描邊配色。
- 建置腳本 `scripts/p3e-0062b-vendor-peeps.mjs` 只讀本機這 8 個 SVG，產出 `packages/ui/src/p3e-open-peeps.ts`。
  壓縮只做去註解／去中繼標籤／降數字精度／把黑白填色換成色彩佔位符，**不改繪圖筆觸**。
- 原始合計 305,287 bytes（gzip 145,749）；
  精簡後 181,839 bytes（gzip 79,348）；
  產生的 TS 模組 188,502 bytes。
- 產出的常數只在 `p3e-scene.ts` 使用，並由 `p3e-game-layer.ts` 延遲載入，不在出生卡關鍵路徑。

## GPT-WORKBUDDY-0063-B｜本專案衍生年齡專用人物（**非官方原件**）

官方 Open Peeps 集合沒有嬰兒／幼童／學生全身角色；0063-B 另以 CC0 允許的
modify / remix 方式建立 **20 個本專案衍生** SVG，供 0–22 歲使用。
完整清單、逐檔 SHA-256、授權依據與「非刻板衣著」說明見
`derived/DERIVED-SOURCE.md`；官方 8 個成人成品仍是上表，不混為一談。
