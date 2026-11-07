# 收入／資產百分位：資料口徑與方法（GPT-DEEPSEEK-0036-A）

本文件說明 `packages/contracts/src/p3e-percentile.ts` 使用的**MVP 估算**門檻表：
資料來源、下載／產生日期、基準年、PPP／名目幣別選擇、轉換方法與授權注意事項。

> **一句話**：這是**離線、版本化、可重播的 MVP 估算**，不是官方即時排名。
> UI 顯示時必須標示「估算」，且不得宣稱精確或即時。

## 1. 語意

欄位語意固定為「**高於多少比例的人**」：

- `chinaPercent = 82.4` → 「高於中國 82.4% 的人（估算）」；
- **不是**「第 82 名」、**不是**「前 18%」；
- 值域 `0–99.9`（一位小數），UI 可自行四捨五入成整數。

## 2. 量測對象

| 指標 | 量測 | 來源欄位 | 可用條件 |
| --- | --- | --- | --- |
| 收入 | 個人**年所得**（PPP 國際美元） | `P3ELifeState.assets.annualIncomeMicroUsd` | 年齡 ≥ 16、收入 > 0、就業狀態不是 `none`／`student` |
| 資產 | 個人**淨金融資產**近似值（PPP 國際美元） | `P3ELifeState.assets.balanceMicroUsd` | 年齡 ≥ 18（負值落在最低區間 0%） |

- 資產只用 `balanceMicroUsd` 當近似值：房子、退休金、負債等不在 MVP 範圍內。
- 負資產 → 0%（最低區間），不拋錯、不出現 `NaN`。

## 3. 單位與幣別

- 專案內部金錢單位是 **micro-USD**（1 USD = 1,000,000 micro-USD）；
- 門檻表在程式裡用 `usd(dollars)` 產生，註解同時寫美元概念值，避免 10^6 尺度誤讀；
- **價格基準：PPP 2017 國際美元**（`priceBasis: "ppp-2017"`），不是名目匯率；
- 未做各國物價調整（MVP 只提供「中國」與「全球」兩個比較基準）。

## 4. 來源與方法（MVP）

| 指標 | 方法參考 | 來源 | 取得方式 |
| --- | --- | --- | --- |
| 收入 | World Bank **PIP**（Poverty and Inequality Platform）的分位所得形狀；參考 `jefferyleo/HowRichAmI`、`jassuwu/incomerank` 的「用分位門檻換算百分位」做法 | <https://pip.worldbank.org/>、<https://github.com/jefferyleo/HowRichAmI>、<https://github.com/jassuwu/incomerank> | **未下載原始資料**；本輪以公開報告的中位數／分位形狀人工建立小型門檻表 |
| 資產 | World Inequality Database **Income and Wealth Comparator** 的「個人淨財富分位」做法 | <https://wid.world/>、<https://github.com/world-inequality-database/wid-income-wealth-comparator> | 同上（未下載原始資料） |

- **下載／產生日期**：2026-11-07（本輪建立門檻表；沒有實際下載 PIP／WID 的原始資料集）。
- **基準年**：`P3E_PERCENTILE_BASIS_YEAR = 2021`（收入與資產共用同一年，避免混用）。
- **演算法**：`static-threshold-monotone-interpolation` —— 在
  `(thresholdMicroUsd, percentile)` 兩點之間做線性內插；低於第一個門檻時在
  `0 → 第一個百分位` 之間線性縮放；高於最後一個門檻固定 `99.9`；資產表的第一個門檻是
  `0 美元`，因此「0 或負值」= `0%`。
- **可重播**：門檻表是常數、版本號固定，同一輸入永遠得到同一輸出，不呼叫任何外部 API、
  不讀取系統時間。

## 5. 為什麼不是「官方即時數據」

這一輪**沒有**取得 PIP／WID 的可授權完整資料集（授權與下載流程需要另外確認），
因此：

- 表格是**人工依公開統計的中位數與分位形狀**建立的 `MVP 估算`；
- 程式與 view 都標示 `estimate: true`、`tableVersion`、`basisYear`、`method`；
- **不得**在 UI 或文案宣稱「官方數據」「即時排名」。

## 6. 授權注意事項

- 本專案**沒有**重製 PIP／WID 的原始資料檔、也沒有把大型資料集放進 bundle；
- 只用公開統計的**形狀**（中位數與分位比例）建立小型門檻表，並在此註明出處；
- 若之後要改用真實資料：
  1. 先確認 PIP／WID 的授權與引用要求（PIP：CC BY 4.0；WID：依 WID 使用條款）；
  2. 保留 `sourceUrl`、`retrievedAt`、`licenseId`，並在 `docs/third-party/` 加上授權全文；
  3. 表格仍應維持「小型、版本化」，不要把原始資料集塞進主 bundle。

## 7. 待替換事項（TODO）

1. 以 PIP 的實際分位資料（PPP 2017、年所得、中國與全球）替換收入門檻表；
2. 以 WID Wealth Comparator 的實際分位資料替換資產門檻表；
3. 若要做國別比較（不只中國／全球），把 `cultureId`／`entityId` 對應到國別門檻表；
4. 需要時加入「名目 vs PPP」切換與匯率基準年（目前固定 PPP 2017）；
5. 若 UI 需要趨勢，另建時間序列表（目前單一基準年）。

## 8. 測試

- `packages/simulation/test/p3e-percentile.test.ts`：門檻單調、插值單調、邊界
  （0／負值／極大值／剛好等於門檻）、兒童 unavailable、同輸入同輸出、字串格式。
- `packages/application/test/p3e-view-percentiles.test.ts`：`view.percentiles`
  真的公開 income／wealth、兒童 unavailable、成年可用、metadata 與 JSON 可序列化。
