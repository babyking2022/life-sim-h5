# GPT-WORKBUDDY-DAYU-0046-B 執行結果報告

**結論：`GPT-WORKBUDDY-DAYU-0046-B｜完成`**

本機專案：`C:\Users\dogfl\Documents\Codex\2026-10-26\referenced-chatgpt-conversation-this-is-an\life-sim`
未執行 commit / push / deploy / reset / checkout；未修改任何資料產生器（name corpus、fixture generators 均原封不動）。

---

## 一、問題本質

P3E 伴侶姓名原本是「確定性視圖投影」，但建立新關係時只用「第一段關係」的座標推導姓名，
且語料每個文化僅 6 姓氏 × 6 異性 given（36 組合）。這導致：

1. **不同關係極易抽到同名**（語料碰撞）；
2. 原 `applyChoices`/`advanceP3ELifePartner` 在升級（dating→cohabit→married）時若重抽會換人；
3. 關係結束後新關係沒有「避開歷史伴侶姓名」的機制，前任姓名可能被覆寫或與現任重複。

## 二、修法（符合成熟 life-sim 設計：每位伴侶＝獨立身分，前任留歷史、新關係＝新 NPC；同居／結婚只是同一 NPC 的狀態升級）

**核心模組：`packages/application/src/p3e-partner.ts`、`packages/application/src/p3e-profile.ts`**

- 伴侶姓名由**獨立 `partner` domain KDF**（Xoshiro128\*\*，seedText =
  `${masterSeed}|partner|${eventId}|${decisionId}|${optionId}|${sinceYear}|${attempt}`）推導，
  **與正式年度 RNG（`life`／`events`／`p3e/death`）完全隔離**，不消耗也不改變正式 RNG。
- `P3E_PARTNER_SPEC_VERSION` 升級為 `p3e-partner-1.2.0`；新增 `P3E_PARTNER_NAME_MAX_ATTEMPTS = 64`。
- 新增 `derivePartnerName`：先抽 `attempt=0`；若名字落在 `forbiddenNames` 內，則 `attempt=1..63`
  **依序嘗試獨立 deterministic domain** 的其他姓名（優先避免同一人生重複姓名）；
  **語料耗盡（64 次皆碰撞）時回退 `attempt=0` 的姓名**——穩定、確定性、**不洩漏任何 internal key**（不會出現「伴侶2」之類）。
- `buildP3ELifePartner` 接受選用 `forbiddenNames`；`resolveP3ELifePartner` 與 `resolveP3ERelationship`
  各自維護跨整段關係歷史累積的 `usedNames`：建立新伴侶傳入 `forbiddenNames`，清除關係時**保留**其姓名於集合中。
- 升級（cohabit／marry）只改 `status`（`Object.freeze({ ...partner, status })`），**絕不重抽、絕不改寫前任姓名**。
- 因 session 每次從完整 `lifeLog` 呼叫 `resolveP3ERelationship` 重建伴侶（live / save / load / replay 同一路徑），
  只需修正此一函數即同時覆蓋所有路徑，保證 **save/load/replay bit-exact**。

**Part B（與 DeepSeek 平行）：`packages/ui/src/p3e-country-hant.ts` 與 `.artifacts/gen-country-hant.mjs`**

- DeepSeek 已從資料面（registry 169 筆、name corpus 等）刪除 TWN／HKG／MAC。本任務同步：
  - 重新產生靜態繁中表 `p3e-country-hant.ts` → **169 筆**，已確認無 `TWN`／`HKG`／`MAC` 作為 key、無 `臺灣`／`香港`／`澳門`、無 `SENSITIVE_ISO3`。
  - `gen-country-hant.mjs` 移除 `SENSITIVE_OVERRIDE`／`SENSITIVE_ISO3` 與 `ISO2_BY_ISO3` 的 `HKG`/`MAC` 對映。
- UI 測試 `packages/ui/test/p3e-view-readers.test.ts`：
  - 移除「`zhHantCountryName("TWN")` 應為 臺灣」斷言；
  - 刪除「敏感地區補名：香港／澳門」測試，改為「查無或空 region code（**含已移除的 TWN/HKG/MAC**）回空字串」測試（斷言三者皆回 `""`）；
  - completeness 斷言更新為 `expect(entries.length).toBe(169)`。

## 三、需求對照

| 要求 | 落點 | 狀態 |
| --- | --- | --- |
| 1 先寫失敗測試再修正 | `p3e-partner-0046.test.ts` 註明「修法前會同名」，修法後全綠 | ✅ |
| 2 同段關係升級姓名不變 | `resolveP3ELifePartner`/`resolveP3ERelationship` 升級只改 status | ✅ |
| 3 關係結束後新關係新身分、姓名不與任何前任重複 | `usedNames` 跨歷史累積 + `forbiddenNames` | ✅ |
| 4 符合 culture/corpus、seed deterministic、無「伴侶2」/隨機時間/Math.random、不耗正式 RNG | 獨立 `partner` domain KDF | ✅ |
| 5 corpus 小／碰撞依序嘗試；耗盡有穩定不洩漏 key 的 fallback | `derivePartnerName` attempt 迴圈 + 回退 attempt=0 | ✅ |
| 6 view.partner / profile.relationship.personName / 人生紀錄 / save-load-replay 同一新姓名；前任不被覆寫 | 單一路徑 `resolveP3ERelationship` 重建 | ✅ |
| 7 同步移除 TWN/HKG/MAC 於靜態表與 UI 測試，依 169 registry 更新 completeness，不動資料產生器 | `p3e-country-hant.ts`、`gen-country-hant.mjs`、`p3e-view-readers.test.ts` | ✅ |

## 四、測試覆蓋（至少項目全數通過）

新增 `packages/application/test/p3e-partner-0046.test.ts`（10 測試，全綠）：

- 第一位伴侶→結婚姓名不變（unit + `resolveP3ERelationship` 整合）✅
- 離異→第二位姓名不同 ✅ ／ 喪偶→第二位姓名不同 ✅
- 第二位再結婚（同段關係 cohabit→marry）姓名不變 ✅
- 三段關係（date→single→marry→single→marry）姓名皆不同 ✅
- 多 seed 屬性：60 個 seed 兩段關係（date→single→marry）姓名 0 碰撞 ✅
- save/load/replay **bit-exact**（`JSON.stringify` 與 `stateHash` 一致）✅
- UI 狀態卡顯示最新姓名，且與 `view.partner` 一致、不顯示前任 ✅
- 整合測試第二關係改以 `dec.adult.relationship:cohabit` 建立（青少年期專屬的 `dec.teen.first-love` 成年後不再提供）；原 `gpt-0046-ui-card` 種子在稀疏事件包下 18 歲早逝，已改用經掃描確認可活到成年並經歷多段關係的 `gpt-0046-scan-2` 種子，測試穩健。

## 五、驗證鏈結果

| 項目 | 指令 | 結果 |
| --- | --- | --- |
| Typecheck | `tsc --noEmit -p tsconfig.json` | ✅ 0 錯誤 |
| Application tests（partner/profile/session/UI） | `vitest run packages/application` | ✅ 23 files / 327 tests |
| UI tests（含 Part B TWN/HKG/MAC 移除） | `vitest run packages/ui` | ✅ 3 files / 73 tests（其中 `p3e-view-readers` 44） |
| Build + mobile layout | `vite build --config vite.p1c.config.ts` | ✅ 產出 `.artifacts/p1c-dist`（含 169 筆 registry） |
| Browser smoke | `node scripts/p3e-browser-smoke.mjs` | ✅ `P3E-BROWSER-SMOKE OK checks=207`；`boot_required_gzip=502566 < 512KB`；`axe_critical_serious_0`；`partner_name_persists_after_reload`、`partner_name_survives_to_death_without_fake_names`、`profile_card_country_full_hant_no_omit_at_death`（🇱🇺盧森堡，無 TWN/HKG/MAC）、`no_internal_key_*` 全綠 |

## 六、備註

- 未更動任何資料產生器與 name corpus；`p3e-country-hant.ts` 為 UI 靜態對應表（由 `.artifacts/gen-country-hant.mjs` 重新產生），符合 Part B 要求。
- 與本任務無關、但已在 working tree 呈 modified 的 fixtures／scripts（如 `fixtures/p2a/*`、`scripts/p2b-generate-fixtures.ts`、`packages/birth/*` 等）均為 DeepSeek 平行作業的 TWN/HKG/MAC 資料面清理，本任務未觸碰、也未提交。
- 瀏覽器 smoke 在本機需 Playwright chromium；本機已具備，順利執行完畢（207 項檢查全過）。
