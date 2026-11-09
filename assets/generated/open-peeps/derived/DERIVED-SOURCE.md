# GPT-WORKBUDDY-0063-B｜本專案衍生年齡專用全身人物（**非官方原件**）

## 授權與衍生說明

- 取得／繪製日期：**2026-11-09**（UTC+8）。
- 基礎風格：Open Peeps by Pablo Stanley，官方站 https://www.openpeeps.com/ ，
  **CC0 1.0 Universal**（public domain dedication）。官方站原文：

  > "Free for commercial and personal use under CC0 License."
>
  > "The library is in the public domain under the CC0 License. This means you can copy, modify, distribute, remix, burn, and use the work, even for commercial purposes, without asking permission."

- CC0 法律全文：`../CC0-1.0-legalcode.txt`（取自
  https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt ）。
- **重要：本目錄 20 個 SVG 全部是「本專案衍生」自行繪製的作品，不是從
  Open Peeps 官方集合、PeepStudio repo 或任何第三方重包下載的原件。**
  官方 Standing 成品只有成人，沒有嬰兒／幼童／學生；0062-B 把成人縮小
  給 0 歲用，CTO 判定不合格。CC0 明確允許 modify / remix / derive，
  因此沿用其「圓頭黑線手繪、色塊填充、圓潤關節」視覺語言自行繪製，
  並在此清楚標示，不假稱官方原件。官方 8 個成人成品仍見 `../SOURCE.md`。
- 繪製方式：`scripts/p3e-0063b-derived-peeps.mjs` 以參數化 SVG 路徑
  產生，沒有執行期熱連結、沒有外部 API、沒有帳號、沒有 CDN。

## 五個階段 × 四個 identity series

| 階段 | 年齡 | 人物特徵 | body key | pose key |
| --- | --- | --- | --- | --- |
| `baby` | 0–2 | 嬰兒 0–2｜坐姿連身衣 | `openpeeps-derived/body/onesie-*` | `openpeeps-derived/pose/sitting` |
| `child` | 3–5 | 幼童 3–5｜短上衣童裝 | `openpeeps-derived/body/toddler-*` | `openpeeps-derived/pose/toddler-stand` |
| `primary` | 6–11 | 小學生 6–11｜校服＋書包 | `openpeeps-derived/body/school-*` | `openpeeps-derived/pose/school-stand` |
| `teen` | 12–17 | 青少年 12–17｜連帽衫＋斜挎包 | `openpeeps-derived/body/teen-*` | `openpeeps-derived/pose/teen-stand` |
| `university` | 18–22 | 大學生 18–22｜開襟外套＋背包 | `openpeeps-derived/body/campus-*` | `openpeeps-derived/pose/campus-stand` |

嬰兒為坐姿連身衣＋大頭身比（viewBox 150×170），**不含任何官方成人
`openpeeps/pose/standing/*` body key**；學生的 school／teen／campus
body key 也不含 blazer／suit／business-only 字樣。

### 非刻板衣著與 identity 連續

- 4 個 series（a 短髮／b 雙髮髻／c 捲髮／d 斜劉海）對**男女都開放**，
  服裝款式是圓領、背帶、條紋、襯衫領，沒有「女性固定裙子、男性固定褲子」。
- 同一人物跨年齡維持同一 series → 同一 `data-part="openpeeps-derived/hair/..."`；
  膚色／髮色／衣著色由 scene 層的穩定 seed 注入，跨年齡不變（老年白髮例外）。
- 成長只改頭身比、身高與合理服裝；變成 young 時才改用官方成人 Standing 成品。

## 實際檔案清單（20 個，全部隨本站自託管）

| key | 階段 | series | 髮型 key | 檔名 | bytes | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
| `baby-a` | baby | a | `openpeeps-derived/hair/short` | `derived/baby-a.svg` | 2749 | `8d153f5ea35f7fb62a3522a420e8a29ba64b38a46a3274a934c488a8e50ca694` |
| `baby-b` | baby | b | `openpeeps-derived/hair/bunches` | `derived/baby-b.svg` | 2848 | `43a8d74e6d3eef64bdadf0b438c7274631b9909822a4cc9f609da295c3a9d485` |
| `baby-c` | baby | c | `openpeeps-derived/hair/curly` | `derived/baby-c.svg` | 3161 | `4cc6b94dc5f3ae3cbf05647b2bfedd7793872d006ac68f3c0a42c15b7dd61d4d` |
| `baby-d` | baby | d | `openpeeps-derived/hair/side-part` | `derived/baby-d.svg` | 2647 | `828751457fad34e803ebed01daa961bc50cf48740e46a9ee8b3865290ae5e024` |
| `child-a` | child | a | `openpeeps-derived/hair/short` | `derived/child-a.svg` | 3201 | `109b7c3a40025f05fca026992e486966279a7af35656081bc25b64edf32a7b83` |
| `child-b` | child | b | `openpeeps-derived/hair/bunches` | `derived/child-b.svg` | 3302 | `13d015ff15ffd6b0532a57c1b52bb72968c107b4777a48bb41aeead72af83876` |
| `child-c` | child | c | `openpeeps-derived/hair/curly` | `derived/child-c.svg` | 3615 | `f5788d5475cc4588938e61e2e22c63483a3850f3dccd1f519c216748c8f1f521` |
| `child-d` | child | d | `openpeeps-derived/hair/side-part` | `derived/child-d.svg` | 3102 | `92ee146772b8a43e1a090aa1ce0d9ecb02fd761a6ab15c5d756ba50df5b991dc` |
| `primary-a` | primary | a | `openpeeps-derived/hair/short` | `derived/primary-a.svg` | 3323 | `f448837548b302250e3bae4fc8a52c8ddbe21acc14210aebf075613758dae962` |
| `primary-b` | primary | b | `openpeeps-derived/hair/bunches` | `derived/primary-b.svg` | 3418 | `423225a43f526b01ddb974e1afcc0641eb03b4b7d0c07123b2c48c0ceef30f6c` |
| `primary-c` | primary | c | `openpeeps-derived/hair/curly` | `derived/primary-c.svg` | 3734 | `05ba1cdd77312350567c5611b1021da35b8b3b1367cad0778b3daf46ddfcf7b1` |
| `primary-d` | primary | d | `openpeeps-derived/hair/side-part` | `derived/primary-d.svg` | 3229 | `cb48054522d07f41252cb5d5543b6f7f805b0a8ed308cb16e2f8bf4a71fa1a97` |
| `teen-a` | teen | a | `openpeeps-derived/hair/short` | `derived/teen-a.svg` | 3275 | `3d0d9276e7b6951fc502457717d73ca4dca652cb3b0cf93e4474e66c1da4236a` |
| `teen-b` | teen | b | `openpeeps-derived/hair/bunches` | `derived/teen-b.svg` | 3353 | `de9521bf50c2aee906dc8aed1208940e30e12b342d85aa25390e7f5d9d64c06e` |
| `teen-c` | teen | c | `openpeeps-derived/hair/curly` | `derived/teen-c.svg` | 3689 | `e20bc27ea287eb040ec253d483e61325ba8a3651f24d585dc6251895302637af` |
| `teen-d` | teen | d | `openpeeps-derived/hair/side-part` | `derived/teen-d.svg` | 3167 | `5472d9dcbd423f61d7e9634b004a1ba5879cf5ce13cfaa9c86d61200b8528526` |
| `university-a` | university | a | `openpeeps-derived/hair/short` | `derived/university-a.svg` | 3346 | `dfd145b6830519c2f622120420cba7e4205fdd50c317c1800d6ce8d47deacabb` |
| `university-b` | university | b | `openpeeps-derived/hair/bunches` | `derived/university-b.svg` | 3439 | `f133fd2c713dd203a6a27f23aca2deab5b6ffc4317220a73eee6ec43804d3add` |
| `university-c` | university | c | `openpeeps-derived/hair/curly` | `derived/university-c.svg` | 3753 | `1b669ee411882d74b076edc206db0b042beb8a6c5a4969a923f1ff82e83fafc5` |
| `university-d` | university | d | `openpeeps-derived/hair/side-part` | `derived/university-d.svg` | 3253 | `eaee1c9a4c5a0b02a5287b5f9c4b4d4c1a0606f3ef3125271c5e160d227de732` |

## 大小

- 20 個衍生 SVG 原始合計 **65,604 bytes**
  （gzip 16,128）；去外殼／換色彩佔位符後
  63,175 bytes（gzip 14,363）。
- 產生的 TS 常數模組 `packages/ui/src/p3e-open-peeps-derived.ts`
  82,377 bytes；只被 `p3e-scene.ts` 引用，
  並隨 `p3e-game-layer.ts` 延遲載入，不在出生卡關鍵路徑。
- `.svg` 檔使用固定調色盤方便直接預覽；runtime 由 
  `derivedPeepMarkup()` 把 `{{ink}}/{{clothes}}/{{hair}}/{{skin}}`
  換成該角色 identity 的穩定色彩。
