/**
 * H5-CTO-185-A／P3-E Browser Autosave Store V1 正式測試。
 *
 * 來源：WorkBuddy 候選 `p3e-browser-autosave-store-v1-candidate.test.ts`
 * （H5-CTO-185-A；SHA-256 `f7afe05d9f5f775c609b3cf298642f7b15fe85e59fb074680bd4dd763bf6449a`，
 * 經 H5-CTO-185-A 正式整合；15 項來源測試依原順序保留）。
 *
 * 整合規則解讀（與 179-B／182-B 先例一致）：正式 src 本體零 import、
 * 零全域存取（不碰 window／localStorage）；本測試檔僅以 handoff 目的
 * import 已 ACCEPTED/FROZEN 的正式 save V6 封裝（test_handoff_only），用
 * createP3ESaveEnvelopeV6／encodeP3ESaveEnvelopeV6 產生真實 raw envelope
 * 字串、並以 decodeP3ESaveEnvelopeV6／validateP3ESaveEnvelopeV6 驗證
 * store 逐位元組搬運。fixtures（in-memory storage fake）是測試基建，
 * 複製 live 路徑的注入模式（UI 之後注入 window.localStorage）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  P3E_BROWSER_AUTOSAVE_KEY,
  P3E_BROWSER_AUTOSAVE_MAX_BYTES,
  P3EBrowserAutosaveStoreError,
  clearP3EBrowserAutosave,
  readP3EBrowserAutosave,
  writeP3EBrowserAutosave,
  type P3EBrowserStorageLike
} from "../src/p3e-browser-autosave-store";
import * as storeModule from "../src/p3e-browser-autosave-store";
import {
  createP3ESaveEnvelopeV6,
  decodeP3ESaveEnvelopeV6,
  encodeP3ESaveEnvelopeV6,
  validateP3ESaveEnvelopeV6
} from "../../save/src/p3e-save-envelope-v6";

const ROOT = process.cwd();
const STORE_SRC = readFileSync(
  join(ROOT, "packages/application/src/p3e-browser-autosave-store.ts"),
  "utf8"
);
const TEST_SRC = readFileSync(
  join(ROOT, "packages/application/test/p3e-browser-autosave-store.test.ts"),
  "utf8"
);
const APPLICATION_INDEX_SRC = readFileSync(join(ROOT, "packages/application/src/index.ts"), "utf8");

const CODE_ARGUMENT = "E_P3E_STORE_ARGUMENT";
const CODE_UNAVAILABLE = "E_P3E_STORE_UNAVAILABLE";
const CODE_QUOTA = "E_P3E_STORE_QUOTA";
const CODE_TOO_LARGE = "E_P3E_STORE_TOO_LARGE";
const CODE_CORRUPT = "E_P3E_STORE_CORRUPT";

type Dict = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* 測試基建：in-memory storage fake（記錄每次方法呼叫）                  */
/* ------------------------------------------------------------------ */

interface MemoryStorage {
  storage: P3EBrowserStorageLike;
  calls: string[];
  map: Map<string, string>;
}

function memoryStorage(): MemoryStorage {
  const map = new Map<string, string>();
  const calls: string[] = [];
  const storage: P3EBrowserStorageLike = {
    getItem(name: string): string | null {
      calls.push(`getItem:${name}`);
      return map.has(name) ? (map.get(name) as string) : null;
    },
    setItem(name: string, value: string): void {
      calls.push(`setItem:${name}`);
      map.set(name, value);
    },
    removeItem(name: string): void {
      calls.push(`removeItem:${name}`);
      map.delete(name);
    }
  };
  return { storage, calls, map };
}

function expectStoreError(run: () => unknown, code: string): P3EBrowserAutosaveStoreError {
  let caught: unknown;
  let thrown = false;
  try {
    run();
  } catch (error) {
    thrown = true;
    caught = error;
  }
  expect(thrown).toBe(true);
  expect(caught).toBeInstanceOf(P3EBrowserAutosaveStoreError);
  const storeError = caught as P3EBrowserAutosaveStoreError;
  expect(storeError.code).toBe(code);
  expect(storeError).not.toBeInstanceOf(TypeError);
  expect(storeError).not.toBeInstanceOf(RangeError);
  expect(storeError).not.toBeInstanceOf(SyntaxError);
  return storeError;
}

/** 決定性 opaque payload（無時間／隨機；同一引擎逐位元組相同）。 */
function deterministicPayload(targetBytes: number): string {
  let out = "";
  let i = 0;
  while (out.length < targetBytes) {
    out += `entry-${i}:snapshot-${(i * 37) % 9973}:delta-${(i * 91) % 65537};\n`;
    i += 1;
  }
  return out.slice(0, targetBytes);
}

/* ------------------------------------------------------------------ */
/* 1. roundtrip                                                        */
/* ------------------------------------------------------------------ */

describe("H5-CTO-185-A P3-E browser autosave store V1", () => {
  it("in_memory_storage_write_read_clear_roundtrip", () => {
    expect(P3E_BROWSER_AUTOSAVE_KEY).toBe("life-sim:p3e:v6:autosave");
    expect(P3E_BROWSER_AUTOSAVE_MAX_BYTES).toBe(1_048_576);
    expect(Object.keys(storeModule).sort()).toEqual(
      [
        "P3E_BROWSER_AUTOSAVE_KEY",
        "P3E_BROWSER_AUTOSAVE_MAX_BYTES",
        "P3EBrowserAutosaveStoreError",
        "clearP3EBrowserAutosave",
        "readP3EBrowserAutosave",
        "writeP3EBrowserAutosave"
      ].sort()
    );
    expect(P3EBrowserAutosaveStoreError.name).toBe("P3EBrowserAutosaveStoreError");

    const mem = memoryStorage();
    const value = "opaque-v6-raw-envelope-string";
    writeP3EBrowserAutosave({ storage: mem.storage, value });
    expect(readP3EBrowserAutosave({ storage: mem.storage })).toBe(value);
    clearP3EBrowserAutosave({ storage: mem.storage });
    expect(readP3EBrowserAutosave({ storage: mem.storage })).toBeNull();
  });

  it("exact_fixed_key_and_exact_value", () => {
    const mem = memoryStorage();
    const value = "exact-value-check";
    writeP3EBrowserAutosave({ storage: mem.storage, value });
    expect(mem.calls).toEqual([`setItem:${P3E_BROWSER_AUTOSAVE_KEY}`]);
    expect(mem.map.get(P3E_BROWSER_AUTOSAVE_KEY)).toBe(value);
    expect(mem.map.size).toBe(1);
    expect(readP3EBrowserAutosave({ storage: mem.storage })).toBe(value);
    expect(mem.calls[1]).toBe(`getItem:${P3E_BROWSER_AUTOSAVE_KEY}`);
    clearP3EBrowserAutosave({ storage: mem.storage });
    expect(mem.calls[2]).toBe(`removeItem:${P3E_BROWSER_AUTOSAVE_KEY}`);
  });

  it("missing_returns_null_and_clear_is_idempotent", () => {
    const mem = memoryStorage();
    expect(readP3EBrowserAutosave({ storage: mem.storage })).toBeNull();
    expect(() => clearP3EBrowserAutosave({ storage: mem.storage })).not.toThrow();
    writeP3EBrowserAutosave({ storage: mem.storage, value: "to-be-cleared" });
    clearP3EBrowserAutosave({ storage: mem.storage });
    expect(readP3EBrowserAutosave({ storage: mem.storage })).toBeNull();
    expect(() => clearP3EBrowserAutosave({ storage: mem.storage })).not.toThrow();
  });

  it("1MiB_UTF8_boundary_and_oversize_rejection_before_setItem", () => {
    const mem = memoryStorage();

    // 恰好 1 MiB（1,048,576 ASCII bytes）→ 合法，全鏈 roundtrip。
    const boundary = "a".repeat(1_048_576);
    writeP3EBrowserAutosave({ storage: mem.storage, value: boundary });
    expect(readP3EBrowserAutosave({ storage: mem.storage })).toBe(boundary);
    expect(new TextEncoder().encode(boundary).length).toBe(1_048_576);
    clearP3EBrowserAutosave({ storage: mem.storage });

    // 1 MiB + 1 byte → TOO_LARGE，且 setItem 從未被呼叫。
    expectStoreError(
      () => writeP3EBrowserAutosave({ storage: mem.storage, value: "a".repeat(1_048_577) }),
      CODE_TOO_LARGE
    );
    expect(mem.calls.filter((call) => call.startsWith("setItem:")).length).toBe(1);

    // 多位元組字元：字元數遠小於上限但 UTF-8 位元組超限 → TOO_LARGE。
    // "€" 是 3 bytes；349,526 × 3 = 1,048,578 > 1 MiB。
    expect("\u20ac".repeat(349_526).length).toBe(349_526);
    expectStoreError(
      () => writeP3EBrowserAutosave({ storage: mem.storage, value: "\u20ac".repeat(349_526) }),
      CODE_TOO_LARGE
    );
    // 349,525 × 3 = 1,048,575 ≤ 1 MiB → 合法。
    const multibyteBoundary = "\u20ac".repeat(349_525);
    writeP3EBrowserAutosave({ storage: mem.storage, value: multibyteBoundary });
    expect(readP3EBrowserAutosave({ storage: mem.storage })).toBe(multibyteBoundary);
    clearP3EBrowserAutosave({ storage: mem.storage });

    // value 形狀錯誤 → ARGUMENT。
    for (const bad of [42, null, true, {}, [], undefined]) {
      expectStoreError(() => writeP3EBrowserAutosave({ storage: mem.storage, value: bad }), CODE_ARGUMENT);
    }
    expectStoreError(() => writeP3EBrowserAutosave({ storage: mem.storage, value: "" }), CODE_ARGUMENT);
  });

  it("storage_unavailable_and_methods_missing_or_noncallable", () => {
    const mem = memoryStorage();

    // storage 不是能力物件。
    for (const badStorage of [null, undefined, 42, "storage", [], {}, true]) {
      expectStoreError(() => writeP3EBrowserAutosave({ storage: badStorage, value: "x" }), CODE_UNAVAILABLE);
      expectStoreError(() => readP3EBrowserAutosave({ storage: badStorage }), CODE_UNAVAILABLE);
      expectStoreError(() => clearP3EBrowserAutosave({ storage: badStorage }), CODE_UNAVAILABLE);
    }

    // 缺方法。
    const missingMethods = { getItem: () => null } as unknown as P3EBrowserStorageLike;
    expectStoreError(() => readP3EBrowserAutosave({ storage: missingMethods }), CODE_UNAVAILABLE);

    // 方法非 callable。
    const nonCallable = {
      getItem: 42,
      setItem: "nope",
      removeItem: () => {}
    } as unknown as P3EBrowserStorageLike;
    expectStoreError(() => writeP3EBrowserAutosave({ storage: nonCallable, value: "x" }), CODE_UNAVAILABLE);

    // 函式但無方法。
    const bareFunction = (() => 1) as unknown;
    expectStoreError(() => readP3EBrowserAutosave({ storage: bareFunction }), CODE_UNAVAILABLE);

    // get trap 拋錯的惡意 proxy → 摺疊，無原生錯誤外洩。
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("native-leak");
        }
      }
    );
    const hostileError = expectStoreError(() => readP3EBrowserAutosave({ storage: hostile }), CODE_UNAVAILABLE);
    expect(hostileError.message).not.toContain("native-leak");
    void mem;
  });

  it("quota_exception_classified_without_native_leak", () => {
    const quotaLike = Object.assign(new Error("quota-native-detail"), { name: "QuotaExceededError" });

    const quotaSetStorage: P3EBrowserStorageLike = {
      getItem: () => null,
      setItem: () => {
        throw quotaLike;
      },
      removeItem: () => {}
    };
    const writeError = expectStoreError(
      () => writeP3EBrowserAutosave({ storage: quotaSetStorage, value: "x" }),
      CODE_QUOTA
    );
    expect(writeError.message).not.toContain("quota-native-detail");
    expect(writeError).not.toBe(quotaLike);

    // Firefox legacy quota name 也判別為 quota。
    const legacyQuota = Object.assign(new Error(), { name: "NS_ERROR_DOM_QUOTA_REACHED" });
    const legacyStorage: P3EBrowserStorageLike = {
      getItem: () => null,
      setItem: () => {
        throw legacyQuota;
      },
      removeItem: () => {}
    };
    expectStoreError(() => writeP3EBrowserAutosave({ storage: legacyStorage, value: "x" }), CODE_QUOTA);

    // read／clear 路徑同樣分類。
    const quotaGetStorage: P3EBrowserStorageLike = {
      getItem: () => {
        throw quotaLike;
      },
      setItem: () => {},
      removeItem: () => {}
    };
    expectStoreError(() => readP3EBrowserAutosave({ storage: quotaGetStorage }), CODE_QUOTA);
    const quotaRemoveStorage: P3EBrowserStorageLike = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw quotaLike;
      }
    };
    expectStoreError(() => clearP3EBrowserAutosave({ storage: quotaRemoveStorage }), CODE_QUOTA);

    // Node 內建 DOMException（真實瀏覽器形狀）。
    if (typeof DOMException === "function") {
      const domQuota = new DOMException("The quota has been exceeded.", "QuotaExceededError");
      const domStorage: P3EBrowserStorageLike = {
        getItem: () => null,
        setItem: () => {
          throw domQuota;
        },
        removeItem: () => {}
      };
      const domError = expectStoreError(
        () => writeP3EBrowserAutosave({ storage: domStorage, value: "x" }),
        CODE_QUOTA
      );
      expect(domError.message).not.toContain("The quota has been exceeded");
    }
  });

  it("security_and_unknown_storage_exceptions_wrapped", () => {
    const securityLike = Object.assign(new Error("denied-native-detail"), { name: "SecurityError" });
    const securityStorage: P3EBrowserStorageLike = {
      getItem: () => {
        throw securityLike;
      },
      setItem: () => {
        throw securityLike;
      },
      removeItem: () => {
        throw securityLike;
      }
    };
    const readError = expectStoreError(() => readP3EBrowserAutosave({ storage: securityStorage }), CODE_UNAVAILABLE);
    expect(readError.message).not.toContain("denied-native-detail");
    expectStoreError(() => writeP3EBrowserAutosave({ storage: securityStorage, value: "x" }), CODE_UNAVAILABLE);
    expectStoreError(() => clearP3EBrowserAutosave({ storage: securityStorage }), CODE_UNAVAILABLE);

    // 未知例外種類：Error、原始字串、不合作物件、undefined。
    const unknownStorage: P3EBrowserStorageLike = {
      getItem: () => {
        throw new Error("unknown-native-detail");
      },
      setItem: () => {
        throw "primitive-throw";
      },
      removeItem: () => {
        // 讀 .name 本身就拋錯的不合作例外物件 → 摺疊分類的內層 catch。
        throw {
          get name(): string {
            throw new Error("uncooperative");
          }
        };
      }
    };
    const unknownError = expectStoreError(() => readP3EBrowserAutosave({ storage: unknownStorage }), CODE_UNAVAILABLE);
    expect(unknownError.message).not.toContain("unknown-native-detail");
    expectStoreError(() => writeP3EBrowserAutosave({ storage: unknownStorage, value: "x" }), CODE_UNAVAILABLE);
    expectStoreError(() => clearP3EBrowserAutosave({ storage: unknownStorage }), CODE_UNAVAILABLE);
  });

  it("corrupt_empty_nonstring_or_oversize_read_rejected", () => {
    const mem = memoryStorage();

    // 空字串 → CORRUPT（寫入路徑永不產生；出現即儲存層被外部改動）。
    mem.map.set(P3E_BROWSER_AUTOSAVE_KEY, "");
    expectStoreError(() => readP3EBrowserAutosave({ storage: mem.storage }), CODE_CORRUPT);
    mem.map.clear();

    // 非字串（fake 回傳 number／undefined）→ CORRUPT。
    const numericStorage = {
      getItem: () => 42,
      setItem: () => {},
      removeItem: () => {}
    } as unknown as P3EBrowserStorageLike;
    expectStoreError(() => readP3EBrowserAutosave({ storage: numericStorage }), CODE_CORRUPT);
    const undefinedStorage = {
      getItem: () => undefined,
      setItem: () => {},
      removeItem: () => {}
    } as unknown as P3EBrowserStorageLike;
    expectStoreError(() => readP3EBrowserAutosave({ storage: undefinedStorage }), CODE_CORRUPT);

    // 超過 1 MiB 的存量字串 → CORRUPT。
    mem.map.set(P3E_BROWSER_AUTOSAVE_KEY, "a".repeat(1_048_577));
    expectStoreError(() => readP3EBrowserAutosave({ storage: mem.storage }), CODE_CORRUPT);
    mem.map.clear();

    // 缺失仍回 null。
    expect(readP3EBrowserAutosave({ storage: mem.storage })).toBeNull();
  });

  it("exact_input_hidden_symbol_accessor_exotic_proxy_matrix", () => {
    const mem = memoryStorage();

    // 頂層輸入不是普通物件。
    for (const badInput of [42, "x", null, undefined, [], true]) {
      expectStoreError(() => writeP3EBrowserAutosave(badInput), CODE_ARGUMENT);
      expectStoreError(() => readP3EBrowserAutosave(badInput), CODE_ARGUMENT);
      expectStoreError(() => clearP3EBrowserAutosave(badInput), CODE_ARGUMENT);
    }

    // 缺欄位／多欄位／改名。
    expectStoreError(() => writeP3EBrowserAutosave({ storage: mem.storage }), CODE_ARGUMENT);
    expectStoreError(() => readP3EBrowserAutosave({ storage: mem.storage, extra: 1 }), CODE_ARGUMENT);
    expectStoreError(() => readP3EBrowserAutosave({ storag: mem.storage }), CODE_ARGUMENT);
    expectStoreError(() => writeP3EBrowserAutosave({ storage: mem.storage, payload: "x" }), CODE_ARGUMENT);

    // 隱藏 non-enumerable extra → own names 不精確 → ARGUMENT。
    const hidden: Dict = { storage: mem.storage };
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false });
    expectStoreError(() => readP3EBrowserAutosave(hidden), CODE_ARGUMENT);

    // symbol key → ARGUMENT。
    const withSymbol: Dict = { storage: mem.storage };
    Object.defineProperty(withSymbol, Symbol("hidden"), { value: 1, enumerable: true });
    expectStoreError(() => readP3EBrowserAutosave(withSymbol), CODE_ARGUMENT);

    // accessor（getter）→ ARGUMENT；getter 永不執行。
    let getterCalls = 0;
    const accessor: Dict = {};
    Object.defineProperty(accessor, "storage", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return mem.storage;
      }
    });
    expectStoreError(() => readP3EBrowserAutosave(accessor), CODE_ARGUMENT);
    expect(getterCalls).toBe(0);

    // class instance（exotic prototype）→ ARGUMENT。
    class StoreInput {
      storage: P3EBrowserStorageLike;
      value: string;
      constructor() {
        this.storage = mem.storage;
        this.value = "x";
      }
    }
    expectStoreError(() => writeP3EBrowserAutosave(new StoreInput()), CODE_ARGUMENT);

    // 間接 exotic prototype → ARGUMENT。
    const exotic = Object.assign(Object.create({ inherited: true }), { storage: mem.storage });
    expectStoreError(() => readP3EBrowserAutosave(exotic), CODE_ARGUMENT);

    // null-prototype 普通形狀 → 合法。
    const nullProto = Object.assign(Object.create(null), { storage: mem.storage, value: "null-proto-ok" });
    writeP3EBrowserAutosave(nullProto);
    expect(readP3EBrowserAutosave({ storage: mem.storage })).toBe("null-proto-ok");

    // revoked Proxy → 反射失敗摺疊成 ARGUMENT。
    const revokedWrite = Proxy.revocable({ storage: mem.storage, value: "x" }, {});
    revokedWrite.revoke();
    expectStoreError(() => writeP3EBrowserAutosave(revokedWrite.proxy), CODE_ARGUMENT);
    const revokedRead = Proxy.revocable({ storage: mem.storage }, {});
    revokedRead.revoke();
    expectStoreError(() => readP3EBrowserAutosave(revokedRead.proxy), CODE_ARGUMENT);
    expectStoreError(() => clearP3EBrowserAutosave(revokedRead.proxy), CODE_ARGUMENT);

    // `__proto__` 文字鍵污染（JSON 載入形狀）→ 鍵集不精確 → ARGUMENT。
    const polluted = JSON.parse('{"storage":{},"value":"x","__proto__":{}}') as Dict;
    expectStoreError(() => writeP3EBrowserAutosave(polluted), CODE_ARGUMENT);

    // 不一致 descriptor 的 proxy（ownKeys 回報鍵但 descriptor 缺失）→ ARGUMENT。
    const inconsistentTarget: Dict = { storage: mem.storage, value: "abc" };
    const inconsistent = new Proxy(inconsistentTarget, {
      getOwnPropertyDescriptor(target: object, property: string | symbol): PropertyDescriptor | undefined {
        if (property === "value") return undefined;
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
    });
    expectStoreError(() => writeP3EBrowserAutosave(inconsistent), CODE_ARGUMENT);

    // storage 欄位為 accessor → ARGUMENT，getter 永不執行（見下一測試）。
    void mem;
  });

  it("no_unhandled_getters_or_proxy_traps", () => {
    const mem = memoryStorage();

    // 輸入欄位全是 getter：拒絕且 getter 執行 0 次（write／read／clear）。
    let writeGetterCalls = 0;
    const writeAccessor: Dict = {};
    Object.defineProperty(writeAccessor, "storage", {
      enumerable: true,
      get() {
        writeGetterCalls += 1;
        return mem.storage;
      }
    });
    Object.defineProperty(writeAccessor, "value", {
      enumerable: true,
      get() {
        writeGetterCalls += 1;
        return "x";
      }
    });
    expectStoreError(() => writeP3EBrowserAutosave(writeAccessor), CODE_ARGUMENT);
    let readGetterCalls = 0;
    const readAccessor: Dict = {};
    Object.defineProperty(readAccessor, "storage", {
      enumerable: true,
      get() {
        readGetterCalls += 1;
        return mem.storage;
      }
    });
    expectStoreError(() => readP3EBrowserAutosave(readAccessor), CODE_ARGUMENT);
    expectStoreError(() => clearP3EBrowserAutosave(readAccessor), CODE_ARGUMENT);
    expect(writeGetterCalls).toBe(0);
    expect(readGetterCalls).toBe(0);

    // 惡意 proxy 輸入的反射 trap 拋錯：全部摺疊成 ARGUMENT，無原生外洩。
    const throwingTraps: Array<[string, ProxyHandler<Dict>]> = [
      ["ownKeys", { ownKeys() { throw new Error("native-leak"); } }],
      ["getOwnPropertyDescriptor", { getOwnPropertyDescriptor() { throw new Error("native-leak"); } }],
      ["getPrototypeOf", { getPrototypeOf() { throw new Error("native-leak"); } }]
    ];
    for (const [, handler] of throwingTraps) {
      const proxyError = expectStoreError(
        () => writeP3EBrowserAutosave(new Proxy<Dict>({ storage: mem.storage, value: "x" }, handler)),
        CODE_ARGUMENT
      );
      expect(proxyError.message).not.toContain("native-leak");
      expectStoreError(() => readP3EBrowserAutosave(new Proxy<Dict>({ storage: mem.storage }, handler)), CODE_ARGUMENT);
    }
  });

  it("actual_v6_raw_envelope_handoff_and_normal_116KB_fixture", () => {
    const mem = memoryStorage();

    // 正常 116KB fixture：決定性 opaque payload → 真實 V6 raw envelope 字串。
    const payload = deterministicPayload(116_000);
    expect(payload.length).toBe(116_000);
    const envelope = createP3ESaveEnvelopeV6({ payload });
    const raw = encodeP3ESaveEnvelopeV6(envelope);
    const rawBytes = new TextEncoder().encode(raw).length;
    expect(rawBytes).toBeGreaterThan(116_000);
    expect(rawBytes).toBeLessThanOrEqual(P3E_BROWSER_AUTOSAVE_MAX_BYTES);

    // store 逐位元組搬運：write → read 原樣 → V6 decoder 解回 → payload 相符。
    writeP3EBrowserAutosave({ storage: mem.storage, value: raw });
    expect(readP3EBrowserAutosave({ storage: mem.storage })).toBe(raw);
    const decoded = decodeP3ESaveEnvelopeV6(raw);
    expect(decoded.payload).toBe(payload);
    expect(validateP3ESaveEnvelopeV6(decoded)).toEqual(decoded);
    expect([...mem.map.keys()]).toEqual([P3E_BROWSER_AUTOSAVE_KEY]);
  });

  it("store_module_not_public_barrel", () => {
    // application 公共 barrel 不導出 store 模組；package.json exports 不含它。
    expect(APPLICATION_INDEX_SRC).not.toContain("p3e-browser-autosave-store");
    const packageJson = readFileSync(join(ROOT, "packages/application/package.json"), "utf8");
    expect(packageJson).not.toContain("browser-autosave");
    // 正式檔存在且是獨立檔案（add-only，未改既有檔案）。
    expect(STORE_SRC.length).toBeGreaterThan(0);
  });

  it("production_has_no_global_localStorage_or_save_simulation_import", () => {
    // 檢查對象是**去註解後的程式碼**（表頭文件可提及禁詞以說明設計）。
    const codeOnly = STORE_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const lowered = codeOnly.toLowerCase();
    for (const forbidden of [
      "localstorage",
      "sessionstorage",
      "indexeddb",
      "window",
      "document",
      "globalthis",
      "navigator",
      "simulation",
      "@life-sim",
      "import "
    ]) {
      expect(lowered).not.toContain(forbidden);
    }
    // 匯出面完整。
    expect(STORE_SRC).toContain('export const P3E_BROWSER_AUTOSAVE_KEY = "life-sim:p3e:v6:autosave"');
    expect(STORE_SRC).toContain("export const P3E_BROWSER_AUTOSAVE_MAX_BYTES = 1_048_576");
    expect(STORE_SRC).toContain("export type P3EBrowserStorageLike");
    expect(STORE_SRC).toContain("export type P3EBrowserAutosaveStoreErrorCode");
    expect(STORE_SRC).toContain("export class P3EBrowserAutosaveStoreError");
    expect(STORE_SRC).toContain("export function writeP3EBrowserAutosave(input: unknown): void");
    expect(STORE_SRC).toContain("export function readP3EBrowserAutosave(input: unknown): string | null");
    expect(STORE_SRC).toContain("export function clearP3EBrowserAutosave(input: unknown): void");
    void TEST_SRC;
  });

  it("output_and_inputs_unmodified", () => {
    const mem = memoryStorage();
    const writeInput: Dict = { storage: mem.storage, value: "frozen-check" };
    const readInput: Dict = { storage: mem.storage };
    const writeSnapshot = JSON.stringify(writeInput);
    const readSnapshot = JSON.stringify(readInput);

    writeP3EBrowserAutosave(writeInput);
    expect(readP3EBrowserAutosave(readInput)).toBe("frozen-check");
    clearP3EBrowserAutosave(readInput);

    expect(JSON.stringify(writeInput)).toBe(writeSnapshot);
    expect(JSON.stringify(readInput)).toBe(readSnapshot);
    // 儲存層只動過固定鍵，clear 後乾淨。
    expect(mem.map.size).toBe(0);
  });

  it("performance_report_116KB_and_600KB", () => {
    for (const targetBytes of [116_000, 600_000]) {
      const mem = memoryStorage();
      const payload = deterministicPayload(targetBytes);
      const raw = encodeP3ESaveEnvelopeV6(createP3ESaveEnvelopeV6({ payload }));
      const rawBytes = new TextEncoder().encode(raw).length;
      expect(rawBytes).toBeLessThanOrEqual(P3E_BROWSER_AUTOSAVE_MAX_BYTES);

      const writeStart = performance.now();
      writeP3EBrowserAutosave({ storage: mem.storage, value: raw });
      const writeMs = performance.now() - writeStart;

      const readStart = performance.now();
      const readBack = readP3EBrowserAutosave({ storage: mem.storage });
      const readMs = performance.now() - readStart;

      expect(readBack).toBe(raw);

      const clearStart = performance.now();
      clearP3EBrowserAutosave({ storage: mem.storage });
      const clearMs = performance.now() - clearStart;

      console.log(
        `[P3E-BROWSER-AUTOSAVE-PERF] ${JSON.stringify({
          value_utf8_bytes: rawBytes,
          write_ms: Math.round(writeMs * 1000) / 1000,
          read_ms: Math.round(readMs * 1000) / 1000,
          clear_ms: Math.round(clearMs * 1000) / 1000,
          node_version: process.version
        })}`
      );
    }
  });
});

/* ================================================================== */
/* 六、H5-CTO-185-A：正式整合專屬測試                                   */
/* ================================================================== */

describe("H5-CTO-185-A 正式整合", () => {
  it("formal_module_path_only：正式模組與測試都指向正式路徑", () => {
    expect(TEST_SRC).toContain('from "../src/p3e-browser-autosave-store"');
    expect(STORE_SRC.length).toBeGreaterThan(0);
  });

  it("candidate_path_absent：正式檔案不再以 import 或讀檔引用來源候選路徑", () => {
    for (const source of [STORE_SRC, TEST_SRC]) {
      expect(source).not.toMatch(/from\s+"[^"]*-candidate"/);
      expect(source).not.toMatch(/join\(ROOT, "[^"]*-candidate"/);
    }
  });
});
