# 第三方來源與授權（GPT-0025-A 現實人生抉擇包）

本任務在不使用後端、LLM 或付費服務的前提下，把 MVP 的事件包從「22 個事件、3 個決策事件、
7 個選項」擴充成「77 個事件、58 個決策事件、172 個選項」。以下記錄研究期間實際參考的上游
專案、授權狀態，以及**沒有**被複製的內容。

## 一、研究的開源專案

| 專案 | 授權 | 固定版本 | 參考了什麼 | 是否複製程式或文案 |
| --- | --- | --- | --- | --- |
| [`thaihuynhatquang/life-sim`](https://github.com/thaihuynhatquang/life-sim)（本地 `github-event-research/life-sim-world`） | MIT（程式與文件） | `1a16bdec6c0b8ba2120bf5a88125e2fe1e15a956` | 只讀 `game/src/sim/decisions.ts` 的**抽象做法**：升學／工作／移民／婚姻／生育／投資／創業／健康／退休等現實抉擇，以及「預設選項＝模型原本的計畫」這個概念 | **否**。沒有複製任何程式、文案或 `data/out/**`（該目錄是 CC BY-SA 4.0 且有第三方限制） |
| [`rockbenben/thousand-lives`](https://github.com/rockbenben/thousand-lives)（本地 `github-event-research/thousand-lives`） | MIT | `3906d13c59d793bf4f78267611cfb9691f9544bd` | 只讀 `src/scenarios/schema.ts` 的**結構概念**：權重、條件、一次性、分支結果、每回合衰減 | **否**。沒有搬入任何修仙／末世／諜戰劇情文字或程式 |
| `College-Life-Simulator`、`132143/lifesimulator` | 授權不明 | — | 只把「人生階段有大量選擇」當成抽象玩法參考 | **否**（授權不明，完全沒有讀取內容進專案） |

## 二、本專案新增內容的來源

- `fixtures/p3b/events.v1.json` 的 77 個事件（含本任務新增的 55 個抉擇事件、165 個選項）
  全部由 `scripts/p3b-generate-fixtures.ts` **自行撰寫並產生**；事件只存
  `localizationKey`，不存任何文案，符合 P3-B 契約（`文字一律只存 localizationKey`）。
- `fixtures/p3b/event-copy.zh-Hant.v1.json` 的繁中標題／問題／按鈕文字由本任務**自行撰寫**，
  不是從上游抄錄；它是顯示層對照檔，不是事件包資料，也不進事件的 canonical checksum。
- 事件包 manifest 的授權紀錄仍是 `sourceKind: synthetic`、`licenseId: synthetic-generated`
  ＋`commercialUse: allowed`＋`legalStatus: cleared`，與「自行撰寫、無上游資料」一致。

## 三、授權全文

- [`life-sim-world-MIT.md`](./life-sim-world-MIT.md)
- [`thousand-lives-MIT.md`](./thousand-lives-MIT.md)

## 四、保留聲明

若未來要把上游的**資料檔**（例如 `life-sim/data/out/**`）引入本專案，必須另外處理
CC BY-SA 4.0 的授權與第三方限制，不能只靠本文件；本任務刻意沒有這樣做。
