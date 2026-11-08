# GPT-DEEPSEEK-0046-A｜從遊戲資料完全移除 TWN／HKG／MAC

你是 DeepSeek 工程師。直接在本機專案實作，不只回建議；不 commit、push、deploy，不 reset/checkout。完成後只回覆：

- `GPT-DEEPSEEK-0046-A｜完成`
- `GPT-DEEPSEEK-0046-A｜部分完成`
- `GPT-DEEPSEEK-0046-A｜未完成`

專案：`C:\Users\dogfl\Documents\Codex\2026-10-26\referenced-chatgpt-conversation-this-is-an\life-sim`

先讀 git status；保留其他人的未提交內容。本任務依使用者明確要求，讓遊戲內不再存在或抽到臺灣／香港／澳門三個地區。禁止只在 UI 隱藏。

## 要求

1. 從 P2A 產生器的權威來源移除 `TWN`、`HKG`、`MAC`，並把正式 entity count 172→169。
2. 重新產生正式 runtime 資料，使下列三個 entity 不再存在於可部署資料：
   - country registry
   - indicators／birth weights／sensitive names
   - P2B identity/household 等依國家衍生資料
   - P3D mortality/entity binding 等依國家衍生資料
   - 所有受影響 manifest、checksum、golden、distribution／coverage 報告
3. 不可只改 status=disabled；使用者要求刪除。部署所載入的 fixtures 中不得再有 `cr:TWN`、`cr:HKG`、`cr:MAC`。文件或測試可提到它們作「禁止清單」，但不能作正式資料記錄。
4. UI 國名表、ISO 映射若仍包含這三個代碼，交給 WorkBuddy 刪除；你負責資料與 simulation，不要重做 UI。
5. 加回歸測試：
   - registry 正好 169 筆且不含三碼；
   - 所有 enabled entity、birth weight、identity、mortality binding 都不含三碼；
   - 至少大量固定 seeds 的出生結果從不出現三碼；
   - save/load/replay 與死亡流程仍一致。
6. 用既有 generators 更新資料，不可手改 checksum 假通過。先找最小必要的下游產生鏈，不要重寫架構。

至少執行 typecheck、P2A/P2B/P3D 相關驗證與 golden、application/replay、全量單 worker測試。把報告寫到 `work/GPT-0046/DEEPSEEK-0046-A-result.md`，列出實際刪除檔案、169 筆證據、seed 測試與所有更新 checksum。對使用者只回三態。
