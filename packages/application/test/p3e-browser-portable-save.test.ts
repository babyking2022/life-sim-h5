import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as barrel from "../src/index";
import {
  exportP3EBrowserPortableSave,
  restoreP3EBrowserPortableSave
} from "../src/p3e-browser-portable-save";
import {
  createP3EBrowserSession,
  prepareP3EBrowserWorld
} from "../src/p3e-browser-bootstrap";
import {
  exportP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";
import { SaveError } from "@life-sim/save";
import { P3E_MAX_COMMANDS } from "@life-sim/contracts";
import { isP3EError, type P3EError } from "../../simulation/src/errors";
import { encodeP3ESaveEnvelopeV6Compressed } from "../../save/src/p3e-save-envelope-v6";
import { MAX_EXPANDED_BYTES } from "../../save/src/errors";

/**
 * H5-CTO-191-A：P3-E Portable Save File Orchestrator V1 正式測試。
 *
 * 正式模組只做編排：export（exportP3EPlaySessionPayload → createP3ESaveEnvelopeV6
 * → encodeP3ESaveEnvelopeV6，各恰好一次）與 restore（decodeP3ESaveEnvelopeV6
 * → restoreP3EBrowserSession，各恰好一次）。全部期望值用正式原語或既有正式
 * 入口獨立驗證，不用模組自己的輸出當答案；計數以 vi.mock 包 actual（不改變
 * 行為）量測呼叫順序與次數。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const PORTABLE_SRC = readFileSync(
  join(ROOT, "packages/application/src/p3e-browser-portable-save.ts"),
  "utf8"
);
const APPLICATION_INDEX_SRC = readFileSync(join(ROOT, "packages/application/src/index.ts"), "utf8");

type Dict = Record<string, unknown>;

/* ------------------------------ 計數 mock ------------------------------ */

const trace = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@life-sim/save", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@life-sim/save")>();
  return {
    ...actual,
    createP3ESaveEnvelopeV6: (input: unknown) => {
      trace.calls.push("createEnvelope");
      return actual.createP3ESaveEnvelopeV6(input);
    },
    encodeP3ESaveEnvelopeV6: (input: unknown) => {
      trace.calls.push("encodeEnvelope");
      return actual.encodeP3ESaveEnvelopeV6(input);
    },
    decodeP3ESaveEnvelopeV6: (input: unknown) => {
      trace.calls.push("decodeEnvelope");
      return actual.decodeP3ESaveEnvelopeV6(input);
    }
  };
});

vi.mock("../src/p3e-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/p3e-session")>();
  return {
    ...actual,
    exportP3EPlaySessionPayload: (input: unknown) => {
      trace.calls.push("exportPayload");
      return actual.exportP3EPlaySessionPayload(input);
    }
  };
});

vi.mock("../src/p3e-browser-bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/p3e-browser-bootstrap")>();
  return {
    ...actual,
    restoreP3EBrowserSession: (input: unknown) => {
      trace.calls.push("restoreBrowserSession");
      return actual.restoreP3EBrowserSession(input);
    }
  };
});

/* ------------------------------ fixtures ------------------------------ */

const rawPacks = {
  base: {
    manifest: readJson("fixtures/p2a/manifest.v1.json"),
    datasets: {
      "country-registry": readJson("fixtures/p2a/country-registry.v1.json"),
      indicators: readJson("fixtures/p2a/indicators.v1.json"),
      "birth-weights": readJson("fixtures/p2a/birth-weights.v1.json"),
      "sensitive-names": readJson("fixtures/p2a/sensitive-names.v1.json"),
      licenses: readJson("fixtures/p2a/licenses.v1.json"),
      lineage: readJson("fixtures/p2a/lineage.v1.json")
    }
  },
  identity: {
    manifest: readJson("fixtures/p2b/manifest.v1.json"),
    datasets: {
      "country-vitals": readJson("fixtures/p2b/country-vitals.v1.json"),
      "household-profiles": readJson("fixtures/p2b/household-profiles.v1.json"),
      "name-corpus": readJson("fixtures/p2b/name-corpus.v1.json"),
      "story-templates": readJson("fixtures/p2b/story-templates.v1.json"),
      licenses: readJson("fixtures/p2b/licenses.v1.json"),
      lineage: readJson("fixtures/p2b/lineage.v1.json")
    }
  },
  events: {
    manifest: readJson("fixtures/p3b/manifest.v1.json"),
    events: (readJson("fixtures/p3b/events.v1.json") as { records: unknown[] }).records
  },
  death: {
    manifest: readJson("fixtures/p3d/manifest.v1.json"),
    datasets: {
      "cause-registry": readJson("fixtures/p3d/cause-registry.v1.json"),
      "cause-weights": readJson("fixtures/p3d/cause-weights.v1.json"),
      mortality: readJson("fixtures/p3d/mortality.v1.json"),
      licenses: readJson("fixtures/p3d/licenses.v1.json"),
      lineage: readJson("fixtures/p3d/lineage.v1.json")
    }
  }
} as const;

const SEED = "p3e-166-playable-runtime-v4";
const WORLD = prepareP3EBrowserWorld(rawPacks);
const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

function emptySession(): P3EPlaySession {
  return createP3EBrowserSession({ world: WORLD, masterSeed: SEED });
}

function nextCommand(session: P3EPlaySession): Dict {
  if (session.state.phase === "pending_decision") {
    const optionId = session.state.pendingDecision?.optionIds[0] as string;
    return { type: "CHOOSE_DECISION", optionId };
  }
  return { ...ADVANCE };
}

/** 官方 51 命令路徑（與 playable smoke 相同規則）。 */
function playOfficialPath(): P3EPlaySession {
  let session = emptySession();
  let commands = 0;
  while (session.state.phase !== "death") {
    session = runP3EPlaySessionCommand({ session, command: nextCommand(session) }).session;
    commands += 1;
    if (commands > P3E_MAX_COMMANDS) throw new Error("did not reach death");
  }
  return session;
}

/** 推進到第一個 pending_decision（用於決策中斷點測試）。 */
function playUntilPendingDecision(): P3EPlaySession {
  let session = emptySession();
  let commands = 0;
  while (session.state.phase !== "pending_decision") {
    session = runP3EPlaySessionCommand({ session, command: nextCommand(session) }).session;
    commands += 1;
    if (commands > P3E_MAX_COMMANDS) throw new Error("no pending decision reached");
  }
  return session;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  return Object.keys(value as Dict).every((key) => isDeepFrozen((value as Dict)[key]));
}

function expectP3EError(runFn: () => unknown, code: string, path: string): void {
  let caught: unknown = null;
  try {
    runFn();
  } catch (error) {
    caught = error;
  }
  expect(isP3EError(caught), `${code} at ${path}`).toBe(true);
  expect((caught as P3EError).code).toBe(code);
  expect((caught as P3EError).path).toBe(path);
}

function expectSaveError(runFn: () => unknown, code: string): void {
  let caught: unknown = null;
  try {
    runFn();
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof SaveError, code).toBe(true);
  expect((caught as SaveError).code).toBe(code);
}

function restoreOf(data: unknown, masterSeed: string = SEED): P3EPlaySession {
  return restoreP3EBrowserPortableSave({ world: WORLD, masterSeed, data });
}

/* ------------------------------ 正路 ------------------------------ */

describe("exportP3EBrowserPortableSave / restoreP3EBrowserPortableSave 正路", () => {
  it("empty_session_raw_export_restore_bit_exact", () => {
    const original = emptySession();
    const raw = exportP3EBrowserPortableSave({ session: original });

    // raw 是 canonical V6 envelope JSON：固定四欄、欄序固定。
    const parsed = JSON.parse(raw) as Dict;
    expect(Object.keys(parsed)).toEqual(["magic", "saveFormatVersion", "payloadFormat", "payload"]);
    expect(parsed.magic).toBe("LIFE1");
    expect(parsed.saveFormatVersion).toBe(6);
    expect(parsed.payloadFormat).toBe("p3e-session-payload-1");
    // payload 就是正式 exportP3EPlaySessionPayload 的 canonical 輸出（mock 包 actual，
    // 值仍是正式結果，作為獨立 oracle）。
    expect(parsed.payload).toBe(exportP3EPlaySessionPayload({ session: original }));

    const restored = restoreOf(raw);
    expect(restored).not.toBe(original);
    expect(isDeepFrozen(restored)).toBe(true);
    expect(stable(restored.state)).toBe(stable(original.state));
    expect(stable(restored.view)).toBe(stable(original.view));
    expect(stable(restored.ledgerHistory)).toBe(stable(original.ledgerHistory));
    expect(stable(restored.lastOutcome)).toBe(stable(original.lastOutcome));

    // 還原的 session 帶 brand：可繼續執行正式命令，且與原路徑逐位元一致。
    const a = runP3EPlaySessionCommand({ session: original, command: { ...ADVANCE } }).session;
    const b = runP3EPlaySessionCommand({ session: restored, command: { ...ADVANCE } }).session;
    expect(stable(b.state)).toBe(stable(a.state));
    expect(stable(b.view)).toBe(stable(a.view));
  });

  it("official_51_raw_export_restore_bit_exact", () => {
    const original = playOfficialPath();
    expect(original.state.phase).toBe("death");
    const raw = exportP3EBrowserPortableSave({ session: original });
    const restored = restoreOf(raw);
    expect(restored.state.phase).toBe("death");
    expect(stable(restored.state)).toBe(stable(original.state));
    expect(stable(restored.view)).toBe(stable(original.view));
    expect(stable(restored.ledgerHistory)).toBe(stable(original.ledgerHistory));
    expect(stable(restored.lastOutcome)).toBe(stable(original.lastOutcome));
  });

  it("pending_decision_export_restore_choose_continue", () => {
    const original = playUntilPendingDecision();
    expect(original.state.phase).toBe("pending_decision");
    expect(original.view.controls.canChooseDecision).toBe(true);
    const raw = exportP3EBrowserPortableSave({ session: original });
    const restored = restoreOf(raw);
    expect(stable(restored.state)).toBe(stable(original.state));
    expect(restored.view.pendingDecision).not.toBeNull();

    // 還原後選 continue（第一個選項），與原路徑同指令逐位元一致。
    const a = runP3EPlaySessionCommand({ session: original, command: nextCommand(original) }).session;
    const b = runP3EPlaySessionCommand({ session: restored, command: nextCommand(restored) }).session;
    expect(stable(b.state)).toBe(stable(a.state));
    expect(stable(b.view)).toBe(stable(a.view));
  });

  it("deterministic_repeated_export", () => {
    const session = playOfficialPath();
    const raw1 = exportP3EBrowserPortableSave({ session });
    const raw2 = exportP3EBrowserPortableSave({ session });
    expect(raw1).toBe(raw2);
  });
});

/* ------------------------------ 匯入形態 ------------------------------ */

describe("匯入形態（raw string／UTF-8 bytes／gzip bytes）", () => {
  const original = playOfficialPath();
  const raw = exportP3EBrowserPortableSave({ session: original });
  const reference = stable(original);

  it("raw_string_and_UTF8_Uint8Array_import", () => {
    const fromString = restoreOf(raw);
    expect(stable(fromString)).toBe(reference);

    const bytes = new TextEncoder().encode(raw);
    expect(bytes instanceof Uint8Array).toBe(true);
    const fromBytes = restoreOf(bytes);
    expect(stable(fromBytes)).toBe(reference);
  });

  it("gzip_Uint8Array_import", () => {
    // gzip 由正式 save V6 壓縮路徑產生（test-only deep import；輸入是完整信封）。
    const envelope = JSON.parse(raw) as Dict;
    const gz = encodeP3ESaveEnvelopeV6Compressed(envelope);
    expect(gz instanceof Uint8Array).toBe(true);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    const restored = restoreOf(gz);
    expect(stable(restored)).toBe(reference);
  });
});

/* ------------------------------ 拒絕矩陣 ------------------------------ */

describe("拒絕矩陣（wrong seed／corrupt／version／tamper／oversize）", () => {
  const original = playOfficialPath();
  const raw = exportP3EBrowserPortableSave({ session: original });

  it("wrong_seed_rejected", () => {
    // seed 比對失敗來自正式 restore 路徑（宣稱值不被信任）。
    expectP3EError(
      () => restoreOf(raw, "p3e-wrong-seed"),
      "E_P3E_ARGUMENT",
      "p3eSession.payload"
    );
  });

  it("corrupt_json_rejected", () => {
    expectSaveError(() => restoreOf(raw.slice(0, -1)), "E_SAVE_INVALID");
    expectSaveError(() => restoreOf("not json at all"), "E_SAVE_INVALID");
  });

  it("unsupported_version_rejected", () => {
    const tampered = JSON.parse(raw) as Dict;
    (tampered as Dict).saveFormatVersion = 5;
    expectSaveError(() => restoreOf(JSON.stringify(tampered)), "E_SAVE_UNSUPPORTED_VERSION");
  });

  it("tampered_payload_rejected", () => {
    // 信封形狀合法、payload 內容被篡改 → 正式 replay／canonical 比對拒絕。
    const tampered = JSON.parse(raw) as { payload: string };
    const payload = tampered.payload;
    const cut = Math.floor(payload.length / 2);
    tampered.payload =
      payload.slice(0, cut) + (payload[cut] === "a" ? "b" : "a") + payload.slice(cut + 1);
    expect(tampered.payload).not.toBe(payload);
    let caught: unknown = null;
    try {
      restoreOf(JSON.stringify(tampered));
    } catch (error) {
      caught = error;
    }
    // 篡改一律被既有正式路徑拒絕；且決不外洩 TypeError／RangeError 等原生錯誤。
    expect(caught !== null).toBe(true);
    const rejectedAsDomainError = isP3EError(caught) || caught instanceof SaveError;
    expect(rejectedAsDomainError).toBe(true);
  });

  it("oversize_rejected", () => {
    // raw 輸入超過 20 MiB 上限（大小檢查在 parse 之前）。
    const big = "a".repeat(MAX_EXPANDED_BYTES + 1);
    expectSaveError(() => restoreOf(big), "E_SAVE_TOO_LARGE");
  });

  it("corrupt_gzip_rejected", () => {
    const gz = encodeP3ESaveEnvelopeV6Compressed(JSON.parse(raw) as Dict);
    const broken = Uint8Array.from(gz);
    broken[10] = (broken[10] as number) ^ 0xff;
    let caught: unknown = null;
    try {
      restoreOf(broken);
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof SaveError).toBe(true);
    expect((caught as SaveError).code).toBe("E_SAVE_INVALID");
  });
});

/* ------------------------------ exact input 矩陣 ------------------------------ */

describe("exact input descriptor 邊界", () => {
  it("export_rejects_non_exact_input", () => {
    const session = emptySession();
    const valid = { session };
    expect(exportP3EBrowserPortableSave(valid)).toBeTruthy();

    expectP3EError(() => exportP3EBrowserPortableSave(null), "E_P3E_ARGUMENT", "p3ePortableSave.export.input");
    expectP3EError(() => exportP3EBrowserPortableSave(undefined), "E_P3E_ARGUMENT", "p3ePortableSave.export.input");
    expectP3EError(() => exportP3EBrowserPortableSave(42), "E_P3E_ARGUMENT", "p3ePortableSave.export.input");
    expectP3EError(() => exportP3EBrowserPortableSave([session]), "E_P3E_ARGUMENT", "p3ePortableSave.export.input");
    expectP3EError(() => exportP3EBrowserPortableSave({}), "E_P3E_ARGUMENT", "p3ePortableSave.export.input");
    expectP3EError(
      () => exportP3EBrowserPortableSave({ session, extra: 1 }),
      "E_P3E_ARGUMENT",
      "p3ePortableSave.export.input"
    );
    const symbolKey = { session } as Dict;
    (symbolKey as unknown as Record<PropertyKey, unknown>)[Symbol("extra")] = 1;
    expectP3EError(() => exportP3EBrowserPortableSave(symbolKey), "E_P3E_ARGUMENT", "p3ePortableSave.export.input");
    const exotic = Object.create({ proto: true }) as Dict;
    exotic.session = session;
    expectP3EError(() => exportP3EBrowserPortableSave(exotic), "E_P3E_ARGUMENT", "p3ePortableSave.export.input");
    const missing = { wrong: session } as Dict;
    expectP3EError(() => exportP3EBrowserPortableSave(missing), "E_P3E_ARGUMENT", "p3ePortableSave.export.input");
  });

  it("restore_rejects_non_exact_input", () => {
    const raw = exportP3EBrowserPortableSave({ session: emptySession() });
    expectP3EError(() => restoreP3EBrowserPortableSave(null), "E_P3E_ARGUMENT", "p3ePortableSave.restore.input");
    expectP3EError(() => restoreP3EBrowserPortableSave(undefined), "E_P3E_ARGUMENT", "p3ePortableSave.restore.input");
    expectP3EError(() => restoreP3EBrowserPortableSave([raw]), "E_P3E_ARGUMENT", "p3ePortableSave.restore.input");
    expectP3EError(() => restoreP3EBrowserPortableSave({ world: WORLD }), "E_P3E_ARGUMENT", "p3ePortableSave.restore.input");
    expectP3EError(
      () => restoreP3EBrowserPortableSave({ world: WORLD, masterSeed: SEED, data: raw, extra: 1 }),
      "E_P3E_ARGUMENT",
      "p3ePortableSave.restore.input"
    );
    // 非法 data 型別由正式 decode 拒絕（E_SAVE_INVALID，非 P3EError）。
    expectSaveError(() => restoreOf(null), "E_SAVE_INVALID");
    expectSaveError(() => restoreOf(42), "E_SAVE_INVALID");
  });

  it("accessor_getter_never_executed", () => {
    const session = emptySession();
    let getterRuns = 0;
    const withGetter = {} as Dict;
    Object.defineProperty(withGetter, "session", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return session;
      }
    });
    expectP3EError(() => exportP3EBrowserPortableSave(withGetter), "E_P3E_ARGUMENT", "p3ePortableSave.export.input");
    expect(getterRuns).toBe(0);

    let restoreGetterRuns = 0;
    const restoreInput = {} as Dict;
    Object.defineProperty(restoreInput, "world", {
      enumerable: true,
      get() {
        restoreGetterRuns += 1;
        return WORLD;
      }
    });
    Object.defineProperty(restoreInput, "masterSeed", { value: SEED, enumerable: true });
    Object.defineProperty(restoreInput, "data", { value: "x", enumerable: true });
    expectP3EError(
      () => restoreP3EBrowserPortableSave(restoreInput),
      "E_P3E_ARGUMENT",
      "p3ePortableSave.restore.input"
    );
    expect(restoreGetterRuns).toBe(0);
  });

  it("hostile_proxy_rejected_without_native_error_leak", () => {
    const session = emptySession();
    const proxy = new Proxy({ session }, {
      ownKeys(): ArrayLike<string | symbol> {
        throw new Error("trap");
      },
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
      getPrototypeOf() {
        throw new Error("trap");
      }
    });
    // 反射操作失敗一律折成 E_P3E_ARGUMENT（trap 錯誤決不外洩）。
    expectP3EError(() => exportP3EBrowserPortableSave(proxy), "E_P3E_ARGUMENT", "p3ePortableSave.export.input");
  });
});

/* ------------------------------ 編排契約 ------------------------------ */

describe("編排契約（順序固定、恰好一次）", () => {
  it("call_order_and_exactly_once", () => {
    const original = emptySession();
    const raw = exportP3EBrowserPortableSave({ session: original });

    trace.calls = [];
    const restored = restoreOf(raw);
    expect(stable(restored.state)).toBe(stable(original.state));
    expect(trace.calls).toEqual(["decodeEnvelope", "restoreBrowserSession"]);

    trace.calls = [];
    const again = exportP3EBrowserPortableSave({ session: original });
    expect(again).toBe(raw);
    expect(trace.calls).toEqual(["exportPayload", "createEnvelope", "encodeEnvelope"]);
  });
});

/* ------------------------------ 整合規則 ------------------------------ */

describe("整合規則", () => {
  it("portable_save_is_exact_public_barrel_entry", async () => {
    const moduleKeys = Object.keys(
      await import("../src/p3e-browser-portable-save")
    );
    expect(moduleKeys.sort()).toEqual([
      "exportP3EBrowserPortableSave",
      "restoreP3EBrowserPortableSave"
    ]);
    expect(typeof (barrel as Dict).exportP3EBrowserPortableSave).toBe("function");
    expect(typeof (barrel as Dict).restoreP3EBrowserPortableSave).toBe("function");
    // 壓縮 encoder 仍為內部，不得從 application barrel 外洩。
    expect((barrel as Dict).encodeP3ESaveEnvelopeV6Compressed).toBeUndefined();
    // application 公共 barrel 引用正式模組。
    expect(APPLICATION_INDEX_SRC.includes("./p3e-browser-portable-save")).toBe(true);
    // package.json exports 只能是完整 barrel "." 與 CTO 授權的 birth-lite
    // 公開 subpath（GPT-0065-A）；不得再冒出任何會拉進 validators 的入口。
    const packageJson = JSON.parse(
      readFileSync(join(ROOT, "packages/application/package.json"), "utf8")
    ) as { exports: Dict };
    expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./birth-lite"]);
  });

  it("no_DOM_or_storage_tokens", () => {
    // 去註解後檢查：正式 src 程式碼本體不得出現任何 DOM／檔案／儲存／
    // 網路／時間／亂數 token（註解中的中文敘述不影響）。
    const codeOnly = PORTABLE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const forbidden =
      /document\b|window\b|localStorage|sessionStorage|indexedDB|navigator\b|\bBlob\b|\bFileReader\b|createObjectURL|\bfetch\b|XMLHttpRequest|HTMLElement|DOMParser|crypto\b|Date\.now|Math\.random|performance\.now|require\(/;
    expect(forbidden.test(codeOnly)).toBe(false);
    // save 只經公開 barrel façade。
    expect(PORTABLE_SRC.includes('from "@life-sim/save"')).toBe(true);
    expect(/from "\.\.\/\.\.\/save\//.test(PORTABLE_SRC)).toBe(false);
  });
});
