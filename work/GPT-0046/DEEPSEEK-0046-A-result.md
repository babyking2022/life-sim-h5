# GPT-DEEPSEEK-0046-A｜結果：從遊戲資料完全移除 TWN／HKG／MAC

## 一、結果

**完成。**（三態：`GPT-DEEPSEEK-0046-A｜完成`）

- 三個地區（`TWN`／`HKG`／`MAC`）已從 **P2-A 權威來源**刪除，正式 entity count **172 → 169**；
- 所有下游資料全部用既有產生器重建：P2-A registry／indicators／birth weights／sensitive names、
  P2-B vitals／household／name corpus／story templates、P3-D mortality（**169×2×121 = 40,898 筆**）、
  P3-A／P2-C／P2-D／P3-B／P3-C／P3-D golden、distribution／coverage／simulate 報告；
- 部署所載入的 `fixtures/**` 38 個 JSON **完全沒有** `cr:TWN`／`cr:HKG`／`cr:MAC`（也沒有這三個裸代碼）；
- 新增回歸測試：169 筆、所有 enabled entity／birth weight／identity／mortality 綁定都不含三碼、
  300 個固定 seed 的出生結果從不出現三碼、存檔／復原／重播與死亡流程一致。

驗證：`typecheck` **0**、`lint` **0**、全量單 worker **113 檔 / 2277 項全數通過、exit 0**。
沒有 commit／push／deploy、沒有 reset／checkout；UI 國名表與 ISO 映射留給 WorkBuddy（見第五節）。

## 二、實際刪除的資料

| 位置 | 修改 |
| --- | --- |
| `scripts/p2a-generate-fixtures.ts` | 從 `ROWS` 刪掉 `["HKG", null, "asia"]`、`["MAC", null, "asia"]`、`["TWN", null, "asia"]` 三列；`SENSITIVE` 改成**空集合**；`sensitive-names.v1.json` 改由產生器寫出且強制 0 筆 |
| `packages/contracts/src/p2a.ts` | `P2A_ENTITY_COUNT` 172 → **169** |
| `packages/contracts/src/p2b.ts` | `P2B_ENTITY_COUNT` 172 → **169**；`P2B_MAX_VITAL_RECORDS` 172 → 169 |
| `packages/contracts/src/p3d.ts` | `P3D_BASE_ENTITY_COUNT` 172 → **169**（`P3D_REQUIRED_MORTALITY_RECORDS` = 40,898） |
| `packages/simulation/src/state.ts` | `REQUIRED_DEATH_ENTITY_COUNT` 172 → **169** |
| `scripts/p2b-generate-fixtures.ts` | 文化指定 `entities: ["CHN","HKG","MAC","TWN"]` → `["CHN"]`；硬編碼 172 改成 `P2A_ENTITY_COUNT` |
| `packages/application/src/p3e-birth-preview.ts` | 繁中名稱表移除 `HKG`／`MAC`／`TWN` 三個條目與相關註解 |

> 敏感名稱機制本身沒有拆掉：`sensitive-names` 資料集仍然存在（0 筆），
> 驗證器仍會拒絕「標成敏感但沒有合法映射」的資料（測試保留）。

## 三、169 筆證據

| 檢查 | 結果 |
| --- | --- |
| `fixtures/p2a/manifest.v1.json` → `entityCount` | **169** |
| `country-registry.v1.json` records | **169**（`entityIds`／`enabledEntityIds` 都是 169） |
| `indicators.v1.json` records | **338**（169 × 2） |
| `birth-weights.v1.json` records | **338**（169 × 2 sex） |
| `sensitive-names.v1.json` records | **0** |
| `fixtures/p2b/country-vitals.v1.json` records | **169** |
| `fixtures/p3d/mortality.v1.json` records | **40,898**（169 × 2 × 121） |
| `fixtures/**/*.json` 掃描 `cr:TWN`／`cr:HKG`／`cr:MAC`／`"TWN"`… | **0 命中**（38 個檔案） |
| `assets/` 掃描 | 0 命中 |

## 四、重新產生與 checksum

全部用既有產生器（`pnpm <script>`），沒有手改任何 checksum／hash：

| 產生器 | 輸出 |
| --- | --- |
| `p2a:fixtures` | `entities=169 indicators=338 birthWeights=338 licenses=4 lineage=4 packChecksum=d849b5d440fd29f3…` |
| `p2b:fixtures` | `vitals=169 profiles=13 names=234 stories=26 baseChecksum=d849b5d440fd… packChecksum=2b474e1a73c7…` |
| `p3d:fixtures` | `entities=169 mortality=40898 causeWeights=108 causes=8 packChecksum=e9df7de24474…` |
| `p3c:fixtures` | `P3C-FIXTURES-OK` |
| `p3b:fixtures` | `main=79 decisions=59 options=176 copyKeys=346 mainChecksum=403cdb110b40…`（未變，事件包不含國家資料） |
| `p2a:golden` | `cases=48 packChecksum=d849b5d440fd29f3…` |
| `p2b:golden` | `cases=108 packChecksum=2b474e1a73c7…` |
| `p2c:golden` | `cases=108 groupHash=cdf543e816b3…` |
| `p2d:golden` | `cases=108 certificateHash=29f62b294830…` |
| `p3a:golden` | `cases=108 stateHash=cee42392288a…` |
| `p3b:golden` | `packs=2 cases=28` |
| `p3c:golden` | `sections=2 cases=126` |
| `p3d:golden` | `cases=108 died=15 alive=93 causes=5` |
| `p2c:simulate` | `players=10000 peers=40000 checks=587 failures=0 verdict=PASS simulationHash=b71944243282…` |
| `p3b:distribution` | `draws=10000 digest=d68655fdc6575c31…` |
| `p3b:coverage` | `lives=100 decisions=4088 events=57/59 options=170/176 unreachable=0 problems=0` |
| `p3d:distribution` | `groups=9 samples=20000 failures=0 simulationHash=00a6ed2228be…` |
| `p3d:mortality-distribution` | `lives=500 median=79 p10=57 p90=106 reach60=0.884 reach80=0.482 replay=true` |
| 官方路徑 | 107 命令／40 決策／67 歲死亡（2091）；`stateHash=c9d58970a061880c…`、`head=5117aed149a2cfc0…`、`chain=a248f7e714b6887e…`、`lastEntry=2ea5b7e47bbcc964…`；payload 254,044 bytes |

同步更新的測試常數：`p2a/p2b/p3d` 產生器與驗證器註解、`state-invariants`／`state.test`
的 `entityCount`、`registry`／`validate`／`draw`／`p2b-validate`／`p3d-pack` 的 169、
以及官方路徑四個 hash（session／bootstrap／save-envelope／replay／codec／ledger-history）。
`scripts/p3e-browser-smoke.mjs` 只同步兩個 golden 常數值（無邏輯變更，依訂單不重做 UI）。

## 五、新增回歸測試

`packages/application/test/p3e-region-exclusion.test.ts`（9 項）：

1. 契約常數／manifest／registry 都是 169，`entityIds`、`enabledEntityIds` 長度 169；
2. registry／indicators／birth weights／sensitive names 的每筆 `entityId` 都不含三碼，
   連原始 JSON 文字也沒有 `cr:TWN` 等字串；sensitive 為 0 筆；
3. 每個 enabled entity 都有出生權重、顯示名稱、兩種性別的體重分布；
4. P2-B：`P2B_ENTITY_COUNT = 169`、vitals 169 筆、每個 base entity 都有對應 vitals；
   name corpus／story templates／household profiles 不含三碼；
5. P3-D：`P3D_BASE_ENTITY_COUNT = 169`、mortality 40,898 筆、entity 集合 169 且不含三碼、
   每筆 mortality 的 entity 都在 base pack 內、`deathPack.manifest.entityCount = 169`；
6. 300 個固定 seed 的 `drawBirth` 全部落在 169 個合法 entity（且分佈 > 10 國）；
7. 40 個固定 seed 的 peer group／birth certificate 也不含三碼；
8. 一條完整命的出生與死亡 entity 都合法、`view.profile.residence` 等於出生國；
   save→load 後 `stateHash`／`lifeLog` 逐位元相同、phase 仍是 `death`。

另外更新既有測試以符合新資料：
- `packages/birth/test/registry.test.ts`：169、敏感映射 0 筆、名稱表 169 且不含三碼；
- `packages/birth/test/sensitive.test.ts`：改寫成「映射表 0 筆，但機制仍拒絕缺漏／未審核／重複／未知」；
- `packages/birth/test/edges.test.ts`／`validate.test.ts`：敏感 ref 驗證改用 `cr:JPN`；
- `packages/application/test/p3e-birth-preview.test.ts`：名稱表不再有這三碼；
- `packages/application/test/p3e-profile.test.ts`：stub 從 `cr:TWN` 改成 `cr:JPN`。

## 六、測試結果

| 指令 | 結果 |
| --- | --- |
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **exit 0** |
| `pnpm exec vitest run --maxWorkers=1`（全量） | **113 檔 / 2277 項全數通過、exit 0** |
| `pnpm exec vitest run packages/{application,birth,simulation,engine,save}/test --maxWorkers=1` | **110 檔 / 2204 項全數通過** |

## 七、已知限制與交接

1. **UI 國名表與 ISO 映射仍有三碼**（`packages/ui/src/p3e-country-hant.ts`、`p3e-real-main.ts`、
   `packages/ui/test/p3e-view-readers.test.ts`）：依訂單第 4 點交給 WorkBuddy 刪除；
   由於遊戲資料已不會產生這三個 entity，UI 上的條目只是死資料，不會被抽到或顯示。
2. **`sensitive-names` 資料集保留但為 0 筆**：這是刻意的——保留機制與驗證器行為，
   避免為了刪三個地區而動到 P2-A 資料集結構；若產品要整併檔案可另行處理。
3. **文件仍可能提到這三個代碼**：`docs/`、`work/` 與測試中的「禁止清單」是說明與防護，
   不是正式資料記錄（訂單允許）。
4. **舊存檔**：外部 payload 若來自舊版（含 `cr:TWN` 等）會在 replay 時因 entity 不存在而
   被正式驗證器拒絕（`E_P3E_*`／P2-A 驗證錯誤），這是刪除資料的預期結果；
   目前沒有做舊存檔遷移（產品要求「遊戲內不存在」）。
5. **其他工程師的檔案**：`packages/application/test/p3e-partner-0046.test.ts`（GPT-0046-B）
   在過程中間曾因型別註解與功能未完成而失敗；我只補了該檔 `fact()` 的型別註解
   （`decisionId`／`optionId` 可為空），沒有改任何行為，最終全量測試已全數通過。
