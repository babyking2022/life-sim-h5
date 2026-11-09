import {
  buildPeerGroup,
  createBirthCertificate,
  type ValidatedDataPack,
  type ValidatedIdentityPack
} from "@life-sim/birth";
import { sha256Hex, utf8Encode } from "@life-sim/engine";
import { buildP3EBirthPreview, type P3EBrowserBirthPreview } from "./p3e-birth-preview";

/**
 * GPT-WORKBUDDY-0065-A｜canonical 與 birth-lite **唯一共用**的出生核心。
 *
 * CTO 授權的 MVP 架構只移動「靜態資料驗證的時間點」，不改出生演算法與資料：
 *
 * - full-world path（`p3e-browser-bootstrap.ts`）用正式 validators 產生
 *   `ValidatedDataPack`／`ValidatedIdentityPack` 後，呼叫這裡的
 *   `previewBirthFromValidatedPacks`；
 * - birth-lite path（`p3e-birth-lite.ts`）從 build 期已驗證 bundle 重建
 *   **相同形狀**的 pack 後，也呼叫同一個函式；
 *
 * 兩條路徑因此逐位元共用 `buildPeerGroup` → `createBirthCertificate` →
 * `buildP3EBirthPreview`，不可能各自漂移。validators 只存在 full/build path，
 * 本模組不含任何 schema validator。
 */

/** birth bundle 的公開 schema 版本（build 期與執行期都讀這一個常數）。 */
export const P3E_BIRTH_BUNDLE_SCHEMA_VERSION = "p3e-birth-bundle-1";

/**
 * 由**已驗證**的 base／identity pack 產生出生預覽。
 *
 * 與 0058-A 的 `previewFromPacks` 完全相同、同一順序；不建立 session、
 * 不改 pack、不抽額外隨機值。`playerSexPolicy: "random"` 與正式開局一致。
 */
export function previewBirthFromValidatedPacks(
  base: ValidatedDataPack,
  identity: ValidatedIdentityPack,
  masterSeed: string
): P3EBrowserBirthPreview {
  const peerGroup = buildPeerGroup(base, identity, {
    seed: masterSeed,
    playerSexPolicy: "random"
  } as never);
  const certificate = createBirthCertificate(base, identity, peerGroup, masterSeed);
  return buildP3EBirthPreview(certificate);
}

/**
 * bundle 內容雜湊用的**可重現**正規化文字。
 *
 * 物件 key 排序、陣列順序保留、只接受 JSON 安全值（bundle 由 build 期產生，
 * 不含 bigint／函式／undefined）。build 期與執行期共用同一份實作，避免
 * 「產生端算 A、驗證端算 B」的假陽性。
 */
export function canonicalBirthBundleText(value: unknown): string {
  const walk = (node: unknown): string => {
    if (node === null) return "null";
    if (Array.isArray(node)) return `[${node.map(walk).join(",")}]`;
    if (typeof node === "object") {
      const record = node as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${walk(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(node);
  };
  return walk(value);
}

/** 由正規化文字算出可重現的 sha256 內容雜湊。 */
export function birthBundleContentHash(value: unknown): string {
  return sha256Hex(utf8Encode(canonicalBirthBundleText(value)));
}
