import {
  isP3ELifeFocusId,
  P3B_CONTENT_MODES,
  type P3BContentMode,
  type P3EHex64,
  type P3ELifeFocusId
} from "@life-sim/contracts";
import { ascii, canonicalBytes, concatBytes, sha256Hex } from "@life-sim/engine";
import { P3EError } from "./errors";

/**
 * P3-E Command Envelope 與 Args Hash 基礎層（H5-CTO-121-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * readP3ECommand(input: unknown): P3ECommand
 * computeP3ECommandArgsHash(input: unknown): P3EHex64
 * ```
 *
 * ## 本批只定義兩種命令
 *
 * - `ADVANCE_YEAR`：必須記錄 `contentMode`，否則 Replay 無法重現事件候選過濾。
 * - `CHOOSE_DECISION`：只記錄 `optionId`；`eventId`／`decisionId`／`selectionHash`
 *   已由 `stateHashBefore` 內的 `pendingDecision` 綁定。
 *
 * 沒有第三種命令、沒有 `selectedOptionId`、沒有 confirm 步驟、沒有任意 metadata。
 *
 * ## 刻意不做
 *
 * - 不建立 State、不產生 Command Record、不 append Ledger、不做 verify／codec／replay。
 * - 不呼叫 `computeP3ECommandHash`（那只屬於 `year-ledger-hash.ts`，本批不碰）。
 * - 不自行實作 canonicalizer：一律用 engine 的 `canonicalBytes`，也不用 `JSON.stringify`。
 * - 不使用時間、隨機或平台預設字元編碼。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/** 主線三種命令：年度推進、決策選擇、人生重心設定／更改（GPT-0029-B）。 */
export type P3ECommand =
  | {
      readonly type: "ADVANCE_YEAR";
      readonly contentMode: P3BContentMode;
    }
  | {
      readonly type: "CHOOSE_DECISION";
      readonly optionId: string;
    }
  | {
      readonly type: "SET_LIFE_FOCUS";
      readonly focusId: P3ELifeFocusId;
    };

/* ------------------------------------------------------------------ */
/* 常數                                                                */
/* ------------------------------------------------------------------ */

/** Args Hash 的固定 domain（與 STATE／LOG／SNAPSHOT／DELTA／CHAIN／COMMAND 六個都不同）。 */
const ARGS_DOMAIN = "LIFE1/P3E/COMMAND/ARGS/v1";

/**
 * 與 P3-B decision option **完全相同**的 ID 規則：
 * `^[a-z0-9][a-z0-9._-]{2,63}$`。
 *
 * 這個 pattern 同時就是長度規則（1 ＋ 2..63 ＝ 3..64 字元），
 * 與 P3-B 的 `min: 3`／`max: P3B_MAX_ID_LENGTH(64)` 一致。
 */
const OPTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

const ADVANCE_YEAR_KEYS = ["type", "contentMode"] as const;
const CHOOSE_DECISION_KEYS = ["type", "optionId"] as const;
const SET_LIFE_FOCUS_KEYS = ["type", "focusId"] as const;

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function fail(path: string): never {
  throw new P3EError("E_P3E_COMMAND", path);
}

/* ------------------------------------------------------------------ */
/* 信任邊界：exact-object 且只讀 descriptor                            */
/* ------------------------------------------------------------------ */

interface OwnDataRecord {
  readonly keys: readonly string[];
  readonly values: ReadonlyMap<string, unknown>;
}

/**
 * 把輸入讀成「自有、可列舉、全部是 data property」的鍵值集合。
 *
 * 任何反射失敗（已撤銷 Proxy、trap 拋錯、`getPrototypeOf` 例外、symbol 鍵、
 * 不可列舉鍵、accessor／getter、陣列）都回 `null`，呼叫端再折成固定 `P3EError`；
 * 因為只用 `getOwnPropertyDescriptor` 取值，**呼叫端的 getter 永遠不會被執行**。
 */
function readOwnDataRecord(input: unknown): OwnDataRecord | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input) as object | null;
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(input).length !== 0) return null;
    const keys = Object.getOwnPropertyNames(input);
    // 所有自有鍵都必須可列舉（否則序列化或列舉時會無聲消失）。
    if (Object.keys(input).length !== keys.length) return null;
    const values = new Map<string, unknown>();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      values.set(key, descriptor.value);
    }
    return { keys, values };
  } catch {
    return null;
  }
}

function isExactKeys(keys: readonly string[], expected: readonly string[]): boolean {
  if (keys.length !== expected.length) return false;
  return expected.every((key) => keys.includes(key));
}

/* ------------------------------------------------------------------ */
/* 入口 1：Command Envelope                                            */
/* ------------------------------------------------------------------ */

/**
 * 驗證並回傳**獨立、凍結**的 Command Envelope 快照。
 *
 * - `ADVANCE_YEAR`：精確兩欄 `type`／`contentMode`；
 * - `CHOOSE_DECISION`：精確兩欄 `type`／`optionId`；
 * - 其他 `type`、缺欄、多欄、改名、hidden、symbol、accessor、怪 prototype、
 *   陣列、class instance、revoked Proxy 一律 `E_P3E_COMMAND at command`；
 * - `contentMode` 不在 `standard`／`guardian` → `E_P3E_COMMAND at command.contentMode`；
 * - `optionId` 不符 P3-B option ID 規則 → `E_P3E_COMMAND at command.optionId`。
 *
 * 回傳值與輸入零共享；失敗一律是固定 `P3EError`，不外洩原生例外。
 */
export function readP3ECommand(input: unknown): P3ECommand {
  const record = readOwnDataRecord(input);
  if (record === null) fail("command");
  const { keys, values } = record;

  const type = values.get("type");
  if (type === "ADVANCE_YEAR") {
    if (!isExactKeys(keys, ADVANCE_YEAR_KEYS)) fail("command");
    const contentMode = values.get("contentMode");
    if (typeof contentMode !== "string") fail("command.contentMode");
    if (!(P3B_CONTENT_MODES as readonly string[]).includes(contentMode)) fail("command.contentMode");
    return Object.freeze({ type: "ADVANCE_YEAR" as const, contentMode: contentMode as P3BContentMode });
  }
  if (type === "CHOOSE_DECISION") {
    if (!isExactKeys(keys, CHOOSE_DECISION_KEYS)) fail("command");
    const optionId = values.get("optionId");
    if (typeof optionId !== "string" || !OPTION_ID_PATTERN.test(optionId)) fail("command.optionId");
    return Object.freeze({ type: "CHOOSE_DECISION" as const, optionId });
  }
  if (type === "SET_LIFE_FOCUS") {
    if (!isExactKeys(keys, SET_LIFE_FOCUS_KEYS)) fail("command");
    const focusId = values.get("focusId");
    if (typeof focusId !== "string" || !isP3ELifeFocusId(focusId)) fail("command.focusId");
    return Object.freeze({ type: "SET_LIFE_FOCUS" as const, focusId });
  }
  fail("command");
}

/* ------------------------------------------------------------------ */
/* 入口 2：Args Hash                                                   */
/* ------------------------------------------------------------------ */

/**
 * Command Args Hash：`sha256Hex(ascii(domain) ‖ 0x00 ‖ canonicalBytes(projection))`。
 *
 * Projection 逐欄手寫（**不是**把整個 command 丟進去，也不是 `JSON.stringify`）：
 *
 * ```ts
 * { type: "ADVANCE_YEAR", contentMode }
 * { type: "CHOOSE_DECISION", optionId }
 * ```
 *
 * 一定先經過 `readP3ECommand`（不接受預先計算的 argsHash，也不接受額外欄位）。
 */
export function computeP3ECommandArgsHash(input: unknown): P3EHex64 {
  const command = readP3ECommand(input);
  let projection: Record<string, string>;
  if (command.type === "ADVANCE_YEAR") {
    projection = { type: command.type, contentMode: command.contentMode };
  } else if (command.type === "CHOOSE_DECISION") {
    projection = { type: command.type, optionId: command.optionId };
  } else {
    projection = { type: command.type, focusId: command.focusId };
  }
  return sha256Hex(concatBytes(ascii(ARGS_DOMAIN), Uint8Array.of(0), canonicalBytes(projection as never)));
}
