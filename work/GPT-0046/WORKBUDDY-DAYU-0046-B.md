# GPT-WORKBUDDY-DAYU-0046-B｜不同伴侶必須顯示不同姓名

你是帳號「大魚」的 WorkBuddy 工程師。直接在本機專案實作，不只回建議；不 commit、push、deploy，不 reset/checkout。完成後只回覆：

- `GPT-WORKBUDDY-DAYU-0046-B｜完成`
- `GPT-WORKBUDDY-DAYU-0046-B｜部分完成`
- `GPT-WORKBUDDY-DAYU-0046-B｜未完成`

專案：`C:\Users\dogfl\Documents\Codex\2026-10-26\referenced-chatgpt-conversation-this-is-an\life-sim`

先讀 git status。GitHub 參考結論：成熟 life-sim 把每位 NPC 當獨立身分，前任留在歷史、新關係建立新 NPC；同居／結婚只是同一 NPC 的狀態升級。

## 要求

1. 先寫失敗測試證明目前不同關係可能抽到同名，然後修正。
2. 同一段關係：dating→cohabit→married 必須保留同一個姓名，不能每次選項都換人。
3. 關係真正結束後（分手／離異／喪偶），之後建立的新關係必須產生新的 partner identity，顯示姓名不得與任何先前伴侶相同。
4. 新姓名仍要符合出生 culture/name corpus、seed deterministic；不可使用 `伴侶2`、隨機時間或 Math.random。不得額外消耗正式年度 RNG。
5. 若名字 corpus 很小或候選碰撞，以獨立 deterministic domain 依序嘗試其他姓名；測試 corpus 耗盡時要有自然、穩定且不洩漏 internal key 的 fallback。優先避免為同一人生重複姓名。
6. `view.partner`、`view.profile.relationship.personName`、人生紀錄、save/load/replay 都必須顯示同一個新姓名；前任姓名不可被覆寫成現任。
7. DeepSeek 平行刪除 TWN/HKG/MAC。你同步移除 `p3e-country-hant.ts` 與 UI 測試中這三個正式國名映射，最後依新版 169 registry 更新 completeness；不要修改資料產生器。

至少測試：

- 第一位伴侶→結婚姓名不變；
- 離異→第二位姓名不同；
- 喪偶→第二位姓名不同；
- 第二位再結婚姓名不變；
- 三段關係姓名皆不同；
- save/load/replay bit-exact；
- UI 狀態卡顯示最新姓名；
- UI/registry 不再顯示 TWN/HKG/MAC。

執行 typecheck、相關 partner/profile/session/UI tests、build、mobile layout、browser smoke。報告寫到 `work/GPT-0046/WORKBUDDY-DAYU-0046-B-result.md`。對使用者只回三態。
