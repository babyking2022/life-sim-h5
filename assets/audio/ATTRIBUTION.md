# 音效素材來源與授權（Audio attribution）

本資料夾只放一個音效檔，專案打包後由本機提供，遊戲執行時**不會**向
GitHub、Freesound 或任何外部服務發出請求。

## birds.mp3 — 鳥鳴／晨間合唱

| 項目 | 內容 |
| --- | --- |
| 專案內路徑 | `assets/audio/birds.mp3` |
| 上游專案 | [twtrubiks/moonseal](https://github.com/twtrubiks/moonseal)（白噪音／助眠 PWA） |
| 鎖定 commit | `4b3b31119785fa931d1548f1f36fb6bfa8249e99` |
| 固定下載網址 | `https://raw.githubusercontent.com/twtrubiks/moonseal/4b3b31119785fa931d1548f1f36fb6bfa8249e99/public/audio/birds.mp3` |
| 原始來源 | [Freesound 578523](https://freesound.org/s/578523/) |
| 原作者／上傳者 | SamsterBirdies |
| 原始標題 | Birds singing, Dawn chorus |
| 授權 | **CC0 1.0 / Public Domain**（[CC0 1.0 全文](https://creativecommons.org/publicdomain/zero/1.0/)） |
| 上游處理 | 從 30 秒處取 92 秒視窗，以 2 秒 qsin constant-power crossfade 做無縫 self-loop，輸出 90 秒；mp3、128 kbps CBR、stereo、44.1 kHz。詳見上游 [`public/audio/README.md`](https://github.com/twtrubiks/moonseal/blob/4b3b31119785fa931d1548f1f36fb6bfa8249e99/public/audio/README.md) |
| 本專案處理 | 原檔逐位元複製，未重新編碼、未剪輯、未混音 |
| 下載日期 | 2026-11-06（GMT+8） |
| 檔案大小 | 1,441,167 bytes |
| SHA-256 | `467fb10f5fc05071a8818ca73c55a97edc388ca9e4747d3a90373a724011ec9c` |

## 授權說明

CC0 1.0 允許自由複製、修改、再散佈與商業使用，且不要求署名；本專案仍保留
完整來源、commit、原作者、來源編號、授權與下載日期，方便日後追溯與替換。
上游 README 明確記載 `public/audio/` 內七個循環音效皆為 CC0 / Public Domain，
並逐檔列出來源；本專案只取其中 `birds.mp3`，沒有複製上游程式碼、文字介面或
其他音效。

## 執行期行為

- 由 Vite 以 `new URL("../../../assets/audio/birds.mp3", import.meta.url)` 打包成
  本機靜態資產（`dist/assets/birds-<hash>.mp3`），不寫死外部網址。
- `preload="none"`，且在玩家按下「開始人生」或第一次有效操作（或直接按自然音
  開關）之前**不建立 Audio 元素、不設定 `src`**，因此首頁／出生卡不會下載音檔。
- 偏好以版本化 localStorage key `life-sim:p3e:v1:nature-sound` 保存，預設開啟、
  音量 0.15、`loop` 播放，關閉時立即 `pause()`。
