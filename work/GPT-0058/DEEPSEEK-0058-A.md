# GPT-DEEPSEEK-0058-A｜伴侶性別資料修正＋分階段資料載入核心

## 專案

- 路徑：`C:\Users\dogfl\Documents\Codex\2026-10-26\referenced-chatgpt-conversation-this-is-an\life-sim`
- 基準提交：`4e130f1`
- 不得 push、不得部署、不得刪除使用者既有未追蹤檔案。
- 這是 MVP 優化，不進入額外安全化工作。

## 任務一：伴侶性別必須是角色身分的一部分

目前 `scene.partnerSex` 會從姓名池重新推測，這不是可靠的角色身分來源。使用者實際觀察到伴侶進入老年外觀後，性別看起來改變。

請完成：

1. 在 `P3ELifePartner` 增加明確且不可變的 `sex: "male" | "female"`。
2. 建立伴侶時一次決定性地產生性別；目前玩法仍可維持與玩家相反性別，但之後狀態升級、老化、存檔復原、重播時不得重新推測或改變。
3. `deriveP3EScene()` 直接讀取現任伴侶的 `sex`；刪除「用 givenName 查姓名池推測性別」這條脆弱路徑。
4. 同一段關係從 dating → partner/spouse，性別與姓名都要保持；結束關係後的新伴侶才是新身分。
5. 保存既有存檔／重播相容性。伴侶原本就是由 seed＋命令歷史重建，因此不要為了此欄位破壞 wire 格式或舊存檔。

必要測試：

- 同一伴侶跨過 young/middle/senior 年齡分界，`partner.sex` 與 `scene.partnerSex` 永遠相同。
- dating → spouse 不變。
- save → load → replay 不變。
- 新關係仍能取得新姓名，舊功能不回歸。

## 任務二：支援「出生先顯示、完整世界稍後載入」的核心 API

現在 UI 的 `loadWorld()` 首頁一次下載所有資料；`mortality.v1.json` 約 2.61 MB，導致出生卡也被死亡資料阻塞。

請在 application 層提供最小且向後相容的兩階段準備能力：

1. 第一階段只使用生成出生預覽真正需要的 base＋identity 資料，能產出與現有 `previewP3EBrowserBirth()` 完全一致的出生結果。
2. 第二階段才合併／驗證 events＋death，產生正式 `P3EBrowserWorld`，供建立 session、復原存檔與遊戲使用。
3. 現有一次性 `prepareP3EBrowserWorld()` API 保留，既有測試不改語義。
4. 同 seed 的出生證書、hash、人物、國家、家庭資料必須與現行一次載入逐位元一致。
5. 不得偷偷以假資料或簡化死亡率啟動正式遊戲；只有出生卡可在完整世界未完成前顯示。
6. 請讓 UI 工程師能用清楚的 public application API 完成延遲載入，不允許 UI import application 私有路徑。

必要測試：

- 分階段與一次性準備，同 seed 出生預覽逐欄位／hash 一致。
- 完整世界完成後 session、save/load/replay 與舊路徑一致。
- events/death 載入失敗時，出生卡可看，但開始人生會得到可理解錯誤且不建立半套 session。
- typecheck、lint、全測試通過。

## 交付

- 實際修改專案檔案並新增測試。
- 結果寫入 `work/GPT-0058/DEEPSEEK-0058-A-result.md`，列出修改檔案、測試數、限制。
- 完成後對 GPT 只回一行：`GPT-DEEPSEEK-0058-A｜完成`；若未全完成只能回 `部分完成` 或 `未完成`。
