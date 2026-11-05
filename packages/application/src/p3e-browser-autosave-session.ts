import {
  createP3ESaveEnvelopeV6,
  decodeP3ESaveEnvelopeV6,
  encodeP3ESaveEnvelopeV6
} from "@life-sim/save";
import {
  clearP3EBrowserAutosave,
  readP3EBrowserAutosave,
  writeP3EBrowserAutosave
} from "./p3e-browser-autosave-store";
import { restoreP3EBrowserSession } from "./p3e-browser-bootstrap";
import {
  exportP3EPlaySessionPayload,
  type P3EPlaySession
} from "./p3e-session";
import { P3EError } from "@life-sim/simulation";

/**
 * H5-CTO-187-A：瀏覽器 Autosave Session Orchestrator V1（正式主線整合）。
 *
 * 本模組把四個既有正式元件串成瀏覽器 autosave 的完整生命週期，自己
 * **只做編排**，不重寫任何 codec／replay／envelope／store 邏輯，也不把
 * save 邏輯複製進 application 套件：
 *
 * ```ts
 * saveP3EBrowserAutosaveSession({ storage, session }: unknown): void
 * restoreP3EBrowserAutosaveSession({ storage, world, masterSeed }: unknown): P3EPlaySession | null
 * clearP3EBrowserAutosaveSession({ storage }: unknown): void
 * ```
 *
 * ## 編排（順序固定、每個元件恰好一次）
 *
 * - save：`exportP3EPlaySessionPayload` → `createP3ESaveEnvelopeV6` →
 *   `encodeP3ESaveEnvelopeV6`（raw 字串）→ `writeP3EBrowserAutosave`；
 * - restore：`readP3EBrowserAutosave` → 缺失（null）時**直接回 null**
 *   （不 decode、不 replay）→ `decodeP3ESaveEnvelopeV6` →
 *   `restoreP3EBrowserSession`（用 envelope 的 payload＋input 的 world
 *   與 masterSeed）；
 * - clear：`clearP3EBrowserAutosave`。
 *
 * ## 責任邊界
 *
 * - 輸入邊界是 descriptor-only exact-object（getter 永不執行、symbol／
 *   多餘欄位／accessor 一律拒絕）；之後用**取出的值**重建元件輸入，
 *   原始 input 物件不被轉傳、不被修改；
 * - 所有正式驗證（seed 比對、replay、canonical 逐位元、pack 驗證、
 *   envelope 形狀與版本、儲存能力與配額）都由既有正式元件完成，
 *   錯誤原樣外拋，不改寫、不吞掉；
 * - opaque raw V6 envelope 是唯一儲存格式：不壓縮、不 base64、
 *   不 indexedDB、不碰全域、不記錄時間／亂數／crypto／網路；
 * - envelope 內的 payload 宣稱的 final state 不被信任（restore 走
 *   `restoreP3EBrowserSession` 的正式 replay 路徑）。
 */

/* ------------------------------------------------------------------ */
/* 固定錯誤路徑                                                         */
/* ------------------------------------------------------------------ */

const SAVE_KEYS = ["storage", "session"] as const;
const RESTORE_KEYS = ["storage", "world", "masterSeed"] as const;
const CLEAR_KEYS = ["storage"] as const;

const PATH_SAVE_INPUT = "p3eAutosaveSession.save.input";
const PATH_RESTORE_INPUT = "p3eAutosaveSession.restore.input";
const PATH_CLEAR_INPUT = "p3eAutosaveSession.clear.input";

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
/* 入口一：save                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把一條 branded session 存成瀏覽器 autosave（opaque raw V6 envelope）。
 *
 * input 必須是 descriptor-only exact-object 兩欄：`storage`（最小儲存
 * 能力）與 `session`（正式 session）。四個元件各呼叫恰好一次。
 */
export function saveP3EBrowserAutosaveSession(input: unknown): void {
  const fields = readExactObject(input, SAVE_KEYS, PATH_SAVE_INPUT);
  const storage = fields.storage;
  const session = fields.session;

  const payload = exportP3EPlaySessionPayload({ session });
  const envelope = createP3ESaveEnvelopeV6({ payload });
  const raw = encodeP3ESaveEnvelopeV6(envelope);
  writeP3EBrowserAutosave({ storage, value: raw });
}

/* ------------------------------------------------------------------ */
/* 入口二：restore                                                     */
/* ------------------------------------------------------------------ */

/**
 * 從瀏覽器 autosave 還原一條 branded session。
 *
 * input 必須是 descriptor-only exact-object 三欄：`storage`、`world`
 * （restore bridge 認證的 handle）、`masterSeed`（字串）。
 *
 * autosave 缺失（null）時回 `null`——不 decode、不 replay、不觸碰
 * 任何模擬元件。存在時：decode envelope 恰好一次，然後用 envelope
 * 的 payload＋input 的 world／masterSeed 走 `restoreP3EBrowserSession`
 * 恰好一次（所有正式驗證在那裡完成）。
 */
export function restoreP3EBrowserAutosaveSession(input: unknown): P3EPlaySession | null {
  const fields = readExactObject(input, RESTORE_KEYS, PATH_RESTORE_INPUT);
  const storage = fields.storage;
  const world = fields.world;
  const masterSeed = fields.masterSeed;

  const raw = readP3EBrowserAutosave({ storage });
  if (raw === null) return null;

  const envelope = decodeP3ESaveEnvelopeV6(raw);
  return restoreP3EBrowserSession({
    world,
    masterSeed,
    payload: envelope.payload
  });
}

/* ------------------------------------------------------------------ */
/* 入口三：clear                                                       */
/* ------------------------------------------------------------------ */

/**
 * 清除瀏覽器 autosave（冪等：鍵不存在同樣成功）。
 *
 * input 必須是 descriptor-only exact-object 單欄：`storage`。
 */
export function clearP3EBrowserAutosaveSession(input: unknown): void {
  const fields = readExactObject(input, CLEAR_KEYS, PATH_CLEAR_INPUT);
  const storage = fields.storage;

  clearP3EBrowserAutosave({ storage });
}
