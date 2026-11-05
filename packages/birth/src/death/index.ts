/**
 * P3-D production barrel（`@life-sim/birth` 的公開表面）。
 *
 * **只**公開這些符號（P3-D.1 收斂）：
 * - `validateDeathPack`／`isValidatedDeathPack`：唯一的 pack 信任邊界；
 * - `evaluateAnnualDeath`：唯一的判定入口；
 * - `DeathDataError`／`isDeathDataError`：唯一允許外洩的錯誤型別；
 * - 必要公開型別。
 *
 * 刻意**不**公開（由 `scripts/p3d-barrel-isolation.mjs` 驗證）：
 * - `failDeath`／`guardDeath`（內部錯誤工具）；
 * - schema readers（`readExactObject`／`readInt`／…）與 `deepFreeze`；
 * - 未經 `validateDeathPack` 的查表函式（`hazardPpmOf`／`entityBindingOf`／
 *   `assertEntityRegionBinding`／`causeSelectionOf`／`mortalityKey`／`causeKey`）；
 * - checksum 投影（`computeDeathDatasetChecksum`／`computeDeathPackChecksum`／
 *   `deathPackChecksumProjection`／`canonicalRowText`）；
 * - 瀏覽器 golden harness（`runDeathCases`／`projectDeathResult`）；
 * - 內部數值工具（`adjustHazardPpm`／`healthFactorPpm`）。
 *
 * 測試與產生腳本請直接 import 內部檔案（`../src/death/pack` 等），不要繞過這個表面。
 */
export { validateDeathPack, isValidatedDeathPack } from "./pack";
export type { P3DEntityBinding, P3DCauseSelection, RawDeathPack, ValidatedDeathPack } from "./pack";
export { evaluateAnnualDeath } from "./evaluate";
export { DeathDataError, isDeathDataError } from "./errors";
export type { P3DAnnualDeathInput, P3DAnnualDeathResult, P3DErrorCode } from "@life-sim/contracts";
