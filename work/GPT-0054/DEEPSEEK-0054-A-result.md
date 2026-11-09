# GPT-DEEPSEEK-0054-A｜結果：職業選擇、寵物狀態、動態場景投影

## 一、結果

**完成。**（三態：`GPT-DEEPSEEK-0054-A｜完成`）

| 任務 | 狀態 | 摘要 |
| --- | --- | --- |
| 一、玩家能明確選擇職業 | ✅ | 27 個職業／6 分類的資料化目錄；`ev.career-field`（選分類）→ `ev.career-<分類>-<tier>`（選職業）兩階段決策，只放符合學歷 tier 的選項；選完寫 `job:<id>`，`currentRole` 與年收入都改變 |
| 二、最小寵物玩法 | ✅ | `ev.adult.first-pet`：領養狗／貓／暫時不養；旗標進 canonical state，`view.scene.petKind` 讀它；save/load/replay 一致 |
| 三、UI 場景投影 | ✅ | `view.scene`：`playerSex`／`ageStage`／`residenceKind`／`hasPartner`／`partnerSex`／`petKind`／`phase`，深層凍結、可 JSON 序列化、死亡後穩定 |

驗證：`typecheck` 0、`lint` 0、`pnpm build` 0、全量單 worker **114 檔 / 2290 項全數通過**。
沒有 commit／push／deploy；沒有 reset／checkout；沒有動 UI 樣式（`p3e-real-main.ts`／`style.css`）。

## 二、任務一：職業目錄（`packages/contracts/src/p3e-career.ts`）

6 個分類 × 每個分類 entry（不需大學）／degree（需大學以上）各 2–3 個，共 **27 個職業**：

| 分類 | entry（不需大學） | degree（需大學以上） |
| --- | --- | --- |
| 一般服務 `service` | `waiter` 服務生（6k）、`cook` 廚師（9k） | `hotel_manager` 旅宿主管（22k）、`chef` 主廚（28k） |
| 技術工種 `trade` | `factory_worker` 工廠作業員（8k）、`driver` 職業駕駛（9k）、`construction_worker` 建築工（11k） | `electrician` 水電技師（20k）、`site_supervisor` 工地主任（24k） |
| 行政商務 `office` | `clerk` 行政人員（10k）、`salesperson` 業務銷售（12k） | `accountant` 會計（24k）、`hr_specialist` 人力資源專員（22k） |
| 教育醫療 `care` | `care_worker` 照顧服務員（11k）、`care_assistant` 照護助理（9k） | `teacher` 教師（22k）、`nurse` 護理師（26k）、`physician` 醫師（42k，需研究所） |
| 科技工程 `tech` | `lab_technician` 實驗技術員（14k）、`designer` 設計師（16k） | `engineer` 工程師（30k）、`software_engineer` 軟體工程師（34k） |
| 創業自由業 `independent` | `farmer` 農夫（7k）、`shopkeeper` 自營店主（10k）、`freelancer` 自由工作者（13k） | `entrepreneur` 創業者（30k）、`consultant` 顧問（26k） |

每個職業都有：穩定 `id`、繁中名稱 key（`p3b.career.<id>`）、`minEducation`（0／1／2）、
`minKnowledge`、`baseAnnualIncomeMicroUsd`、`category`、`tier`、`employmentKind`。

### 兩階段決策（正式 pending decision，不是背景抽取）

1. **`ev.career-field`**（22–40 歲，`once`、優先度高）：六個分類選項
   （`field-service`／`field-trade`／`field-office`／`field-care`／`field-tech`／`field-independent`），
   選完寫 `career:field:<category>`。
2. **`ev.career-<category>-<entry|degree>`**（22–55 歲，`once`、優先度更高）：
   條件是「有該分類旗標 ＋ 尚未 `career:chosen` ＋ 符合學歷 tier」，
   選項就是該分類該 tier 的職業（2–3 個），選完寫 `job:<id>` ＋ `career:chosen`
   ＋ 對應的 `money("annualIncomeMicroUsd", …)`（→ 既有的 `income:mod:` 旗標）。

因此「不符合學歷的職業」在**模擬層**就不會出現在 `pendingDecision.optionIds` 裡
（測試：沒有大學學歷時 care 分類的 `physician`／`nurse`／`teacher` 不會出現）。
年齡放在 22 歲之後，讓 19–20 歲的升學／就業選擇先發生；大學生在學期間 `currentRole`
仍然是 `university_student`，畢業後才顯示已選職業。

### 契約調整

`P3B_MAX_DECISION_OPTIONS` **5 → 8**（分類選擇需要 6 個選項），
並修掉 `packages/engine/src/life/events/validate.ts` 裡寫死的 `5`。這是固定上限，
`state` 摘要、validator、測試都跟著更新（`state.test.ts` 的「超過」案例改成 9 個選項）。

## 三、任務二：寵物（最小可用）

- 新事件 `ev.adult.first-pet`（16–70 歲、`once`）：`dog` 領養狗／`cat` 領養貓／`none` 暫時不養；
- 效果：`pet:dog`／`pet:cat` 旗標（canonical state）＋ 幸福度 ＋ 年度支出
  （狗 +$6,000、貓 +$3,000 micro-USD 對應值），不擴張成大型寵物系統；
- `view.scene.petKind ∈ none | dog | cat`（`petKindOf(flags)`）；
- 測試：三種選項各自 save→load→replay 後 `stateHash`／flags／scene 完全相同，
  同 seed 同選擇決定性一致。

## 四、任務三：`view.scene`

```ts
view.scene = {
  playerSex: "male" | "female",
  ageStage: "child" | "student" | "young" | "middle" | "senior",  // 0–5 / 6–17 / 18–34 / 35–59 / 60+
  residenceKind: "urban" | "rural",       // 來自 P2-D 出生證書的 family.settlement（權威欄位）
  hasPartner: boolean,                     // profile.relationship.status ∈ dating | married
  partnerSex: "male" | "female" | null,    // 由伴侶 givenName 在語料 female／male 池判定，不消耗 RNG
  petKind: "none" | "dog" | "cat",
  phase: "alive" | "dead"                  // 死亡後 age 凍結，投影仍穩定
}
```

- 深層凍結、可 JSON 序列化；`view` 鍵集合新增 `scene`（測試同步）；
- UI 不需要解析 flags 或猜測狀態；`packages/ui/src/p3e-scene.ts`（WorkBuddy 新檔）
  已直接消費這個欄位；
- 死亡後 `phase: "dead"`，`ageStage` 仍是死亡年齡對應的階段，save→load 後逐位元相同。

## 五、fixture／golden 變更

| 項目 | 舊 | 新 |
| --- | --- | --- |
| 事件數 | 79 | **93**（＋14：分類 1 ＋ 12 個 tier 決策 ＋ 寵物 1） |
| 決策數 | 59 | **73** |
| 選項數 | 176 | **212** |
| 文案 key | 346 | **449**（＋分類/職業名稱/新事件/新選項） |
| events `mainChecksum` | `403cdb11…` | `f4b0eb579bde…` |
| 官方命令／決策 | 106／39 | 106／39（不變） |
| 官方 stateHash | `c9d58970…` | `606ecda9…` |
| headHash | `5117aed1…` | `4307185b…` |
| hashChain | `a248f7e7…` | `42c60438…` |
| lastEntryHash | `2ea5b7e4…` | `901d0e35…` |
| payload | 254,044 bytes | 251,836 bytes |
| `p3b-distribution-report` | `d68655fd…` | `767d4f427b124fc6…` |
| `p3b-choice-coverage` | 57/59 事件 | **71/73 事件、200/212 選項、unreachable 0** |

- 全部用既有產生器重建（`p3b:fixtures`／`p3b:golden`／`p3c:golden`／`p3b:distribution`／`p3b:coverage`），
  沒有手改 hash；
- `p3b-choice-coverage` 的可達性普查新增兩種情境（只開 `career:field:*`、
  以及再加大學學歷），否則兩階段職業事件的「entry 沒有大學／degree 有大學」無法被證明可達；
- 受影響的測試常數同步（session／bootstrap／save-envelope／replay／codec／ledger-history／
  `p3c-life` 年數／`annual-packs` 決策數 73／smoke 的 `EXPECTED_COMMANDS`）；
  **`scripts/p3e-browser-smoke.mjs`** 只同步 golden 常數值（無邏輯變更）。

## 六、測試（`packages/application/test/p3e-career-pet-scene-0054.test.ts`，13 項）

| 類別 | 測試 |
| --- | --- |
| 目錄 | ≥24 個職業、6 分類、每個職業都有 id／labelKey／門檻／年收入；每個分類每個 tier 都有 2–8 個；需求列出的 14 個可見職業都在 |
| 資格 | `isP3ECareerEligible`：學歷不足／知識不足都 false，達標才 true |
| 兩階段 | 真的出現 `dec.adult.career-field`（六個分類選項）→ 選 `field-tech` → 出現 tier 決策，選項全部符合 tier 學歷門檻 → 選完 `job:<id>`／`career:chosen`／`currentRole.id` 都正確 |
| 資格限制 | 沒有大學時 care 分類不會出現 `physician`／`nurse`／`teacher`；有大學時 entry 職業不會出現在 degree 決策 |
| 收入 | 不同職業 → 不同 `income:mod:` 值（進 canonical state） |
| 轉職／退休 | 選完職業後一路推到 70 歲，role 仍是該職業或 `retired` |
| 舊存檔 | 沒有職業旗標的 session 可載入，`currentRole` 用既有規則（`infant`）恢復，`scene` 一致 |
| 寵物 | 狗／貓／不養三選項、旗標與 `scene.petKind` 一致、save/load/replay 一致、同 seed 決定性 |
| scene | 年齡階段邊界（0/5/6/17/18/34/35/59/60/99）、6 條命的投影矩陣（性別×階段×城鄉×伴侶×寵物，>8 種組合）、與 `profile.relationship` 一致、死亡後 `phase=dead` 且復原逐位元相同 |

## 七、驗證結果

| 指令 | 結果 |
| --- | --- |
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **exit 0** |
| `pnpm build`（`tsc --noEmit` ＋ vite build） | **exit 0** |
| `pnpm exec vitest run --maxWorkers=1` | **114 檔 / 2290 項全數通過、exit 0** |
| `pnpm p3b:fixtures` | `main=93 decisions=73 options=212 copyKeys=449 mainChecksum=f4b0eb579bde…` |
| `pnpm p3b:golden` / `p3c:golden` | `packs=2 cases=28` / `sections=2 cases=126` |
| `pnpm p3b:distribution` | `digest=767d4f427b124fc6…` |
| `pnpm p3b:coverage` | `events=71/73 options=200/212 unreachable=0 problems=0` |

## 八、已知限制

1. **`minKnowledge` 只做記錄與資格函式判斷**：決策 tier 由學歷決定，知識門檻（例如醫師 55）
   目前不會再過濾同 tier 內的職業；若要做「知識不足不能選醫師」，需要 engine 支援
   選項級條件（目前沒有）。
2. **六個分類一次顯示**：`P3B_MAX_DECISION_OPTIONS` 由 5 放寬到 8，分類頁有 6 個按鈕；
   手機若嫌多，UI 可用 `P3E_CAREER_CATEGORIES` 做兩欄呈現，資料層不用改。
3. **舊的 `dec.adult.first-job`（corp／startup／family）仍存在**：它是 0040 的通用路徑，
   現在與新的職業選擇並存；`currentRole` 以 `job:<id>`（職業目錄）優先。
   若產品要移除舊路徑，需要一個獨立的事件包版本。
4. **寵物只有一隻、不能更換或離世**：`once` 事件 ＋ 旗標，沒有寵物年齡／死亡模擬。
5. **`partnerSex` 依名字語料推導**：名字不在 female／male 池時回 `null`（UI 顯示「伴侶」），
   不會額外抽 RNG，也不寫進 canonical state。
6. **`p3e-browser-smoke`／`p3e-mobile-layout-check`** 依訂單不重跑、不修改邏輯；
   smoke 只有 golden 常數同步（106 命令）。UI 畫面元件由 WorkBuddy 負責。
