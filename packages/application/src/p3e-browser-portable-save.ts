import {
  createP3ESaveEnvelopeV6,
  decodeP3ESaveEnvelopeV6,
  encodeP3ESaveEnvelopeV6
} from "@life-sim/save";
import { P3EError } from "@life-sim/simulation";
import { restoreP3EBrowserSession } from "./p3e-browser-bootstrap";
import { exportP3EPlaySessionPayload, type P3EPlaySession } from "./p3e-session";

/**
 * H5-CTO-191-A：P3-E Portable Save File Orchestrator V1（正式主線整合）。
 *
 * 本模組把既有正式元件串成「可攜式存檔檔案」的匯出／還原編排，自己
 * **只做編排**，不重寫任何 codec／replay／envelope 邏輯，也不把 save
 * 邏輯複製進 application 套件（save 一律經核准的 `@life-sim/save`
 * 公開 façade）：
 *
 * ```ts
 * exportP3EBrowserPortableSave({ session }: unknown): string
 * restoreP3EBrowserPortableSave({ world, masterSeed, data }: unknown): P3EPlaySession
 * ```
 *
 * ## 編排（順序固定、每個元件恰好一次）
 *
 * - export：`exportP3EPlaySessionPayload`（session 的私有 brand 檢查在
 *   該正式入口完成）→ `createP3ESaveEnvelopeV6`（payload 裝進 canonical
 *   V6 信封）→ `encodeP3ESaveEnvelopeV6`（canonical raw JSON 字串）→
 *   **直接回傳該字串**——沒有 autosave 的 1 MiB 寫入上限（攜帶檔案走
 *   信封自己的 16 MiB payload／20 MiB raw／5 MiB compressed 上限）；
 * - restore：`decodeP3ESaveEnvelopeV6`（raw JSON 字串、UTF-8 bytes 或
 *   gzip bytes 皆可，恰好一次）→ 取深層凍結信封的不透明 `payload` →
 *   `restoreP3EBrowserSession`（用 envelope 的 payload＋input 的 world
 *   與 masterSeed，恰好一次）→ **只回傳 replay 後的 branded session**。
 *
 * ## 責任邊界
 *
 * - 輸入邊界是 descriptor-only exact-object（getter 永不執行、symbol／
 *   多餘欄位／accessor／奇異 prototype 一律 `E_P3E_ARGUMENT`）；之後用
 *   **取出的值**重建元件輸入，原始 input 物件不被轉傳、不被修改；
 * - 所有正式驗證（seed 比對、replay、canonical 逐位元比對、pack 驗證、
 *   envelope 形狀／版本／大小、UTF-8／gzip 完整性）都由既有正式元件
 *   完成，錯誤原樣外拋，不改寫、不吞掉、不摺疊；
 * - **不信任信封內 payload 宣稱的 final state**——還原一律走
 *   `restoreP3EBrowserSession` 的正式 replay 路徑；
 * - 純資料進出：不做任何瀏覽器檔案／剪貼／下載／上傳 API，不觸碰任何
 *   網頁儲存（可攜檔案的搬運責任在呼叫端），不碰全域、不記錄時間／
 *   亂數／crypto／網路；
 * - export 決定性：`encodeP3ESaveEnvelopeV6` 是固定欄序 canonical JSON，
 *   相同 session 重複匯出得到逐位元相同字串。
 */

/* ------------------------------------------------------------------ */
/* 固定錯誤路徑                                                         */
/* ------------------------------------------------------------------ */

const EXPORT_KEYS = ["session"] as const;
const RESTORE_KEYS = ["world", "masterSeed", "data"] as const;

const PATH_EXPORT_INPUT = "p3ePortableSave.export.input";
const PATH_RESTORE_INPUT = "p3ePortableSave.restore.input";

/* ------------------------------------------------------------------ */
/* descriptor-only exact object                                        */
/* ------------------------------------------------------------------ */

function readExactObject(
  input: unknown,
  keys: readonly string[],
  path: string
): Record<string, unknown> {
  let record: Record<string, unknown> | null = null;
  try {
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const proto = Object.getPrototypeOf(input) as object | null;
      if (proto === Object.prototype || proto === null) {
        if (Object.getOwnPropertySymbols(input).length === 0) {
          const names = Object.getOwnPropertyNames(input);
          if (names.length === keys.length && Object.keys(input).length === keys.length) {
            const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            let complete = true;
            for (const key of keys) {
              if (!names.includes(key)) {
                complete = false;
                break;
              }
              const descriptor = Object.getOwnPropertyDescriptor(input, key);
              if (descriptor === undefined || !("value" in descriptor)) {
                complete = false;
                break;
              }
              values[key] = descriptor.value;
            }
            if (complete) record = values;
          }
        }
      }
    }
  } catch {
    record = null;
  }
  if (record === null) throw new P3EError("E_P3E_ARGUMENT", path);
  return record;
}

/* ------------------------------------------------------------------ */
/* 入口一：exportP3EBrowserPortableSave                                 */
/* ------------------------------------------------------------------ */

/**
 * 把一條 branded session 匯出成可攜式存檔字串（opaque raw V6 envelope）。
 *
 * input 必須是 descriptor-only exact-object 單欄：`session`（正式
 * session；非本模組建立的偽造／複製 session 由正式入口的私有 brand
 * 檢查拒絕）。三個元件各呼叫恰好一次。
 */
export function exportP3EBrowserPortableSave(input: unknown): string {
  const fields = readExactObject(input, EXPORT_KEYS, PATH_EXPORT_INPUT);
  const session = fields.session;

  const payload = exportP3EPlaySessionPayload({ session });
  const envelope = createP3ESaveEnvelopeV6({ payload });
  return encodeP3ESaveEnvelopeV6(envelope);
}

/* ------------------------------------------------------------------ */
/* 入口二：restoreP3EBrowserPortableSave                                */
/* ------------------------------------------------------------------ */

/**
 * 從可攜式存檔字串／bytes 還原一條 branded session。
 *
 * input 必須是 descriptor-only exact-object 三欄：`world`（restore
 * bridge 認證的 handle）、`masterSeed`（字串）、`data`（raw JSON 字串
 * 或 UTF-8 bytes／gzip bytes；string 與 Uint8Array 由正式 decode
 * 支援）。
 *
 * 兩個元件各呼叫恰好一次：先 `decodeP3ESaveEnvelopeV6`（形狀／版本／
 * 大小／UTF-8／gzip 驗證全在那裡），再用 envelope 的不透明 payload＋
 * input 的 world／masterSeed 走 `restoreP3EBrowserSession`（seed 比對
 * → replay → canonical 逐位元比對 → seal＋brand）。信封宣稱的 final
 * state 不被信任；失敗時不留任何部分結果。
 */
export function restoreP3EBrowserPortableSave(input: unknown): P3EPlaySession {
  const fields = readExactObject(input, RESTORE_KEYS, PATH_RESTORE_INPUT);
  const world = fields.world;
  const masterSeed = fields.masterSeed;
  const data = fields.data;

  const envelope = decodeP3ESaveEnvelopeV6(data);
  return restoreP3EBrowserSession({
    world,
    masterSeed,
    payload: envelope.payload
  });
}
