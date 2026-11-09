# GPT-DEEPSEEK-0058-A｜結果：伴侶性別資料修正 ＋ 分階段資料載入核心

## 一、結果

**完成。**（`GPT-DEEPSEEK-0058-A｜完成`）

| 任務 | 狀態 | 摘要 |
| --- | --- | --- |
| 一、伴侶性別是角色身分 | ✅ | `P3ELifePartner.sex: "male" \| "female"`，建立時一次抽定；`deriveP3EScene()` 直接讀它，姓名池推測的路徑已刪除 |
| 二、分階段資料載入 | ✅ | 新增 `prepareP3EBrowserBirthStage`／`previewP3EBrowserBirthStage`／`completeP3EBrowserWorld`；一次性 `prepareP3EBrowserWorld` 保留且語義不變 |

驗證：`typecheck` 0、`lint` 0、`pnpm build` 0、全量單 worker **118 檔 / 2328 項全數通過**。
沒有 push／deploy；沒有刪除任何未追蹤檔案；沒有改動 UI 樣式。

## 二、任務一：伴侶性別（修改檔案）

| 檔案 | 修改 |
| --- | --- |
| `packages/application/src/p3e-partner.ts` | 新增 `export type P3EPartnerSex = "female" \| "male"`；`P3ELifePartner` 新增 `readonly sex`；`drawName()`／`derivePartnerName()` 回傳抽樣時實際使用的性別；`buildP3ELifePartner()` 把 `sex` 寫進凍結的伴侶物件；`P3E_PARTNER_SPEC` 1.0.0 → **1.1.0**（投影契約多了性別欄位） |
| `packages/application/src/p3e-profile.ts` | `deriveP3EScene()` 改成讀 `partnerSex`（由呼叫端傳入 `P3ELifePartner.sex`），**刪除** `partnerSexOf()`（用 `givenName` 查姓名池推測的那條路徑）與相關的 `identityPack`／`cultureId` 參數 |
| `packages/application/src/p3e-session.ts` | `resolveSessionRelationship()` 把 `relationship.partner?.sex ?? null` 傳給 scene |

### 行為保證

- **一次性決定**：性別在 `drawName()` 裡由同一個 partner domain（`seedText = masterSeed|partner|eventId|decisionId|optionId|sinceYear|attempt`）
  決定，與姓名同時抽定；目前玩法仍是「與玩家相反性別」。
- **升級不變**：`advanceP3ELifePartner()`／`resolveP3ELifePartner()` 升級（cohabit／marry）時重建的是同一個
  `first` 關係座標，因此 `sex`、`displayName`、`sinceYear` 都不變。
- **老化不變**：scene 只讀 `P3ELifePartner.sex`，與年齡階段（young／middle／senior）完全無關，
  因此不可能「進入老年外觀後性別看起來改變」。
- **結束關係後的新伴侶**：`single`／divorce／widow 清空 partner，下一次建立關係是一個新的
  `first` 座標 → 新姓名＋新 `sex`（仍是獨立 domain 的決定性抽樣）。
- **存檔相容**：`sex` 只存在「由 command log 重建」的 `view.partner` 投影裡，**沒有**進 state、
  也沒有改 payload wire format；舊 payload／舊存檔照舊 decode → replay → 重建伴侶（含 `sex`）。

## 三、任務二：分階段資料載入（修改檔案）

`packages/application/src/p3e-browser-bootstrap.ts` 新增三個公開入口（`index.ts` 既有
`export * from "./p3e-browser-bootstrap"` 已經把它們變成 public API，UI 不需要 import 私有路徑）：

```ts
prepareP3EBrowserBirthStage({ base, identity }): P3EBrowserBirthStage
previewP3EBrowserBirthStage({ stage, masterSeed }): P3EBrowserBirthPreview
completeP3EBrowserWorld({ stage, events, death }): P3EBrowserWorld
```

| 階段 | 驗證什麼 | 產出 |
| --- | --- | --- |
| `prepareP3EBrowserBirthStage` | 只驗 `base` ＋ `identity`（不含 2.61 MB 的 mortality） | 不可偽造、不可序列化、深層凍結的 stage handle（模組私有 `WeakMap`） |
| `previewP3EBrowserBirthStage` | 只讀 stage ＋ seed | 出生卡（與一次性路徑**同一條** `buildPeerGroup → createBirthCertificate → buildP3EBirthPreview`） |
| `completeP3EBrowserWorld` | 補驗 `events` ＋ `death`（`validateEventPack`／`validateDeathPack(base, …)`） | 與 `prepareP3EBrowserWorld` 等價的 world handle |

- `previewP3EBrowserBirth()` 與 `previewP3EBrowserBirthStage()` 共用新的私有
  `previewFromPacks()`，因此同 seed 的出生卡**逐欄位／逐 hash 相同**（測試以三個 seed 比對
  整份 JSON＋`certificateHash`＋`country.regionCode`＋`name`）。
- **失敗不會產生半套世界**：`events`／`death` 驗證失敗時原樣拋出內容包錯誤，
  stage 仍然有效（出生卡可以繼續顯示），也不會建立 world 或 session；
  只有 `completeP3EBrowserWorld` 成功後，`createP3EBrowserSession`／`restoreP3EBrowserSession`
  才能用那個 world 開局。
- **不偷資料**：正式開局仍然用完整的 events＋death 驗證後的 pack；出生卡是唯一允許在
  完整世界尚未就緒時顯示的東西（`previewP3EBrowserBirthStage` 不建 session、不抽年度 RNG）。
- 一次性 `prepareP3EBrowserWorld` 保留（內部仍是四包全驗），既有測試與語義不變。

## 四、新增測試

`packages/application/test/p3e-partner-sex-staged-world-0058.test.ts`（9 項）：

| 類別 | 測試 |
| --- | --- |
| 伴侶性別 | 建立時就有 `sex`（與玩家相反）且物件凍結 |
| 老化 | 同一伴侶在 young(25)／middle(45)／senior(70) 三個年齡，`partner.sex` 與 `scene.partnerSex` 永遠相同、`hasPartner` 一致 |
| 升級 | dating → spouse：`sex` 與 `displayName` 都不變、狀態變 `spouse` |
| 新關係 | 結束關係後 `resolveP3ELifePartner` 回 `null`；再建立關係得到新身分（仍有合法 `sex`） |
| 分階段預覽 | 三個固定 seed：`previewP3EBrowserBirthStage` 與 `previewP3EBrowserBirth` 的 JSON／`certificateHash`／國家／姓名完全相同 |
| 分階段開局 | `completeP3EBrowserWorld` 後的 session `stateHash`／`scene` 與一次性路徑相同；推進 12 步後存檔，用另一條路徑的 world 復原，`stateHash`／`scene`／`profile` 逐位元相同 |
| 失敗路徑 | 壞 `events`／壞 `death` → 拋錯但出生卡仍可用；失敗後 stage 仍可重試；偽造 stage／world 一律拒絕 |
| 不可偽造 | stage／world 的 `Object.keys` 為空、`JSON.stringify` 為 `{}`、`Object.isFrozen === true` |
| 舊路徑 | 一次性 `prepareP3EBrowserWorld` ＋ `createP3EBrowserSession` 與直接用已驗證 pack 建立的 session `stateHash`／`scene` 相同 |

## 五、測試結果

| 指令 | 結果 |
| --- | --- |
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **exit 0** |
| `pnpm build`（`tsc --noEmit` ＋ vite build） | **exit 0** |
| `pnpm exec vitest run --maxWorkers=1` | **118 檔 / 2328 項全數通過、exit 0** |

## 六、已知限制

1. **伴侶性別仍是「與玩家相反」**：這是本輪保留的 MVP 規則；`sex` 已經是資料的一部分，
   未來若要支援其他性別（例如同性伴侶）只要改 `oppositeSex()` 的抽樣決策，不必動投影。
2. **新伴侶的 `sex` 與姓名共用同一個 partner domain**：換性別規則時，同 seed 的姓名也會跟著變
   （兩者本來就是同一支抽樣）；若產品要求「姓名不變、只換性別」，需要拆成兩個 domain。
3. **分階段載入只做到 application API**：UI 端要不要真的先載出生卡、背景再抓 mortality
   由 WorkBuddy 決定；本輪沒有改 UI 的 `loadWorld()`，也沒有做快取／預載策略。
4. **`completeP3EBrowserWorld` 會重驗 `base`／`identity` 嗎**：不會——它重用 stage 已驗證的
   base／identity（同一個 `WeakMap` 參照），只驗 events／death；stage 失效（偽造）會被拒絕。
5. **沒有效能數字**：本輪沒有量測「先顯示出生卡」節省的時間，只保證 API 與等價性；
   `mortality.v1.json` 約 2.61 MB 仍是由 UI 決定何時下載。
