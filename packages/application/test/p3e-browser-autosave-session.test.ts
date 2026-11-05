import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { P3E_MAX_COMMANDS } from "@life-sim/contracts";
import { SaveError } from "@life-sim/save";
import {
  P3E_BROWSER_AUTOSAVE_KEY,
  type P3EBrowserStorageLike
} from "../src/p3e-browser-autosave-store";
import * as barrel from "../src/index";
import * as saveBarrel from "@life-sim/save";
import {
  createP3EBrowserSession,
  prepareP3EBrowserWorld
} from "../src/p3e-browser-bootstrap";
import {
  clearP3EBrowserAutosaveSession,
  restoreP3EBrowserAutosaveSession,
  saveP3EBrowserAutosaveSession
} from "../src/p3e-browser-autosave-session";
import {
  exportP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";
import { isP3EError, type P3EError } from "../../simulation/src/errors";

/**
 * H5-CTO-187-A：瀏覽器 Autosave Session Orchestrator V1 正式測試。
 *
 * - 正路：空 history／官方 51 命令／pending_decision 三種 session 的
 *   save→restore 逐位元一致，restore 後可繼續遊玩；
 * - 缺失 autosave：直接 null，decode／restore 元件零呼叫；
 * - 拒絕矩陣：壞 envelope、錯 seed、篡改 payload、quota／unavailable／
 *   corrupt／too-large、exact-input 矩陣（symbol／extra／accessor／
 *   exotic proto／不一致 proxy）——全部 typed 錯誤，原生錯誤零外洩；
 * - 元件計數：每個被編排的正式元件在每次入口呼叫中恰好一次、順序固定；
 * - 儲存格式：固定鍵、內容是可 decode 的 raw V6 envelope。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

type Dict = Record<string, unknown>;

const ORCH_SRC = readFileSync(
  join(ROOT, "packages/application/src/p3e-browser-autosave-session.ts"),
  "utf8"
);

/* ------------------------------ 元件計數 mock ------------------------------ */

const spies = vi.hoisted(() => ({
  calls: [] as string[],
  counts: {
    export: 0,
    create: 0,
    encode: 0,
    write: 0,
    read: 0,
    decode: 0,
    restore: 0,
    clear: 0
  },
  exportOverride: null as null | (() => string)
}));

function resetSpies(): void {
  spies.calls.length = 0;
  spies.exportOverride = null;
  for (const key of Object.keys(spies.counts) as Array<keyof typeof spies.counts>) {
    spies.counts[key] = 0;
  }
}

vi.mock("../src/p3e-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/p3e-session")>();
  return {
    ...actual,
    exportP3EPlaySessionPayload: (input: unknown) => {
      spies.calls.push("export");
      spies.counts.export += 1;
      if (spies.exportOverride !== null) return spies.exportOverride();
      return (actual.exportP3EPlaySessionPayload as unknown as (...inner: unknown[]) => string)(
        input
      );
    }
  };
});

vi.mock("../../save/src/p3e-save-envelope-v6", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../save/src/p3e-save-envelope-v6")
  >();
  return {
    ...actual,
    createP3ESaveEnvelopeV6: (input: unknown) => {
      spies.calls.push("create");
      spies.counts.create += 1;
      return actual.createP3ESaveEnvelopeV6(input);
    },
    encodeP3ESaveEnvelopeV6: (input: unknown) => {
      spies.calls.push("encode");
      spies.counts.encode += 1;
      return actual.encodeP3ESaveEnvelopeV6(input);
    },
    decodeP3ESaveEnvelopeV6: (input: unknown) => {
      spies.calls.push("decode");
      spies.counts.decode += 1;
      return actual.decodeP3ESaveEnvelopeV6(input);
    }
  };
});

vi.mock("../src/p3e-browser-autosave-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/p3e-browser-autosave-store")>();
  return {
    ...actual,
    writeP3EBrowserAutosave: (input: unknown) => {
      spies.calls.push("write");
      spies.counts.write += 1;
      return actual.writeP3EBrowserAutosave(input);
    },
    readP3EBrowserAutosave: (input: unknown) => {
      spies.calls.push("read");
      spies.counts.read += 1;
      return actual.readP3EBrowserAutosave(input);
    },
    clearP3EBrowserAutosave: (input: unknown) => {
      spies.calls.push("clear");
      spies.counts.clear += 1;
      return actual.clearP3EBrowserAutosave(input);
    }
  };
});

vi.mock("../src/p3e-browser-bootstrap", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/p3e-browser-bootstrap")
  >();
  return {
    ...actual,
    restoreP3EBrowserSession: (input: unknown) => {
      spies.calls.push("restore");
      spies.counts.restore += 1;
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
const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

/* ------------------------------ 工具 ------------------------------ */

interface MemoryStorage {
  storage: P3EBrowserStorageLike;
  map: Map<string, string>;
}

function memoryStorage(): MemoryStorage {
  const map = new Map<string, string>();
  const storage: P3EBrowserStorageLike = {
    getItem(name: string): string | null {
      return map.has(name) ? (map.get(name) as string) : null;
    },
    setItem(name: string, value: string): void {
      map.set(name, value);
    },
    removeItem(name: string): void {
      map.delete(name);
    }
  };
  return { storage, map };
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item
  );
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  return Object.keys(value as Dict).every((key) => isDeepFrozen((value as Dict)[key]));
}

/** 斷言拋出的是 typed 錯誤且不是任何原生錯誤型別。 */
function expectNotNative(run: () => unknown): unknown {
  let caught: unknown;
  let thrown = false;
  try {
    run();
  } catch (error) {
    thrown = true;
    caught = error;
  }
  expect(thrown).toBe(true);
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(TypeError);
  expect(caught).not.toBeInstanceOf(RangeError);
  expect(caught).not.toBeInstanceOf(SyntaxError);
  expect(caught).not.toBeInstanceOf(URIError);
  expect(caught).not.toBeInstanceOf(EvalError);
  return caught;
}

function expectP3EArgument(run: () => unknown, path?: string): void {
  const caught = expectNotNative(run);
  expect(isP3EError(caught), `E_P3E_ARGUMENT${path === undefined ? "" : ` at ${path}`}`).toBe(
    true
  );
  expect((caught as P3EError).code).toBe("E_P3E_ARGUMENT");
  if (path !== undefined) expect((caught as P3EError).path).toBe(path);
}

function nextCommand(session: P3EPlaySession): Dict {
  if (session.state.phase === "pending_decision") {
    const optionId = session.state.pendingDecision?.optionIds[0] as string;
    return { type: "CHOOSE_DECISION", optionId };
  }
  return { ...ADVANCE };
}

interface PlayedGame {
  readonly sessions: readonly P3EPlaySession[];
  readonly finalSession: P3EPlaySession;
}

/** 官方 51 命令路徑（與 playable smoke／p3e-session 測試相同規則），用 bridge 正式開局。 */
function playOfficialPath(): PlayedGame {
  const world = prepareP3EBrowserWorld(rawPacks);
  let session = createP3EBrowserSession({ world, masterSeed: SEED });
  const sessions: P3EPlaySession[] = [];
  let commands = 0;
  while (session.state.phase !== "death") {
    const result = runP3EPlaySessionCommand({ session, command: nextCommand(session) });
    session = result.session;
    sessions.push(session);
    commands += 1;
    if (commands > P3E_MAX_COMMANDS) throw new Error("did not reach death");
  }
  return { sessions, finalSession: session };
}

let cachedGame: PlayedGame | null = null;
function game(): PlayedGame {
  if (cachedGame === null) cachedGame = playOfficialPath();
  return cachedGame;
}

/* ================================================================== */
/* 一、正路：save→restore 逐位元一致                                      */
/* ================================================================== */

describe("H5-CTO-187-A 正路 save→restore", () => {
  it("empty_history：create→save→restore 逐位元一致、session 凍結", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const { storage } = memoryStorage();

    saveP3EBrowserAutosaveSession({ storage, session });

    const restored = restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: SEED });
    expect(restored).not.toBeNull();
    expect(exportP3EPlaySessionPayload({ session: restored as P3EPlaySession })).toBe(
      exportP3EPlaySessionPayload({ session })
    );
    expect(stable((restored as P3EPlaySession).state)).toBe(stable(session.state));
    expect(stable((restored as P3EPlaySession).ledgerHistory)).toBe(
      stable(session.ledgerHistory)
    );
    expect(isDeepFrozen(restored)).toBe(true);

    // restore 之後可繼續執行（brand 有效）
    const result = runP3EPlaySessionCommand({
      session: restored as P3EPlaySession,
      command: { ...ADVANCE }
    });
    expect(result.session.state.phase).not.toBe("death");
  });

  it("official_51：整條命的 save→restore 逐位元一致，raw envelope < 1 MiB", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const finalSession = game().finalSession;
    const { storage, map } = memoryStorage();

    saveP3EBrowserAutosaveSession({ storage, session: finalSession });
    const raw = map.get(P3E_BROWSER_AUTOSAVE_KEY) as string;
    const rawBytes = new TextEncoder().encode(raw).length;
    expect(rawBytes).toBeLessThan(1_048_576);

    const restored = restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: SEED });
    expect(restored).not.toBeNull();
    expect(exportP3EPlaySessionPayload({ session: restored as P3EPlaySession })).toBe(
      exportP3EPlaySessionPayload({ session: finalSession })
    );
    expect(stable((restored as P3EPlaySession).state)).toBe(stable(finalSession.state));
    expect(stable((restored as P3EPlaySession).ledgerHistory)).toBe(
      stable(finalSession.ledgerHistory)
    );
  });

  it("pending_decision：save→restore 相位一致，restore 後可選擇並繼續", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const pending = game().sessions.find(
      (session) => session.state.phase === "pending_decision"
    ) as P3EPlaySession;
    expect(pending.state.phase).toBe("pending_decision");

    const { storage, map } = memoryStorage();
    saveP3EBrowserAutosaveSession({ storage, session: pending });

    const command = nextCommand(pending);
    const fromOriginal = runP3EPlaySessionCommand({ session: pending, command });

    const restored = restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: SEED });
    expect(restored).not.toBeNull();
    expect((restored as P3EPlaySession).state.phase).toBe("pending_decision");
    expect(stable((restored as P3EPlaySession).state)).toBe(stable(pending.state));

    const fromRestored = runP3EPlaySessionCommand({
      session: restored as P3EPlaySession,
      command
    });
    expect(stable(fromRestored.session.state)).toBe(stable(fromOriginal.session.state));
    expect(map.get(P3E_BROWSER_AUTOSAVE_KEY)).not.toBeNull();
  });
});

/* ================================================================== */
/* 二、缺失與清除                                                        */
/* ================================================================== */

describe("H5-CTO-187-A 缺失 autosave 與 clear", () => {
  it("missing：空儲存回 null，不 decode、不 restore", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const { storage } = memoryStorage();

    const restored = restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: SEED });
    expect(restored).toBeNull();
    expect(spies.counts.read).toBe(1);
    expect(spies.counts.decode).toBe(0);
    expect(spies.counts.restore).toBe(0);
  });

  it("clear：清除後 restore 回 null，clear 冪等", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const { storage } = memoryStorage();

    saveP3EBrowserAutosaveSession({ storage, session });
    clearP3EBrowserAutosaveSession({ storage });
    expect(restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: SEED })).toBeNull();
    clearP3EBrowserAutosaveSession({ storage });
    expect(restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: SEED })).toBeNull();
    expect(spies.counts.clear).toBe(2);
  });
});

/* ================================================================== */
/* 三、壞 envelope／錯 seed／篡改 payload                                 */
/* ================================================================== */

describe("H5-CTO-187-A 拒絕路徑", () => {
  it("corrupt envelope：typed SaveError，無原生錯誤外洩", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const { storage, map } = memoryStorage();
    saveP3EBrowserAutosaveSession({ storage, session });
    map.set(P3E_BROWSER_AUTOSAVE_KEY, "LIFE1-this-is-not-an-envelope");

    const caught = expectNotNative(() =>
      restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: SEED })
    );
    expect(caught).toBeInstanceOf(SaveError);
  });

  it("wrong seed：typed E_P3E_ARGUMENT", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const { storage } = memoryStorage();
    saveP3EBrowserAutosaveSession({ storage, session });

    expectP3EArgument(
      () => restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: "p3e-wrong-seed" }),
      "p3eSession.payload"
    );
  });

  it("tampered payload：改動 payload 後被正式路徑拒絕（typed）", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const { storage, map } = memoryStorage();
    saveP3EBrowserAutosaveSession({ storage, session });

    // 直接從儲存值取出 raw JSON envelope、篡改 payload、重打包回固定鍵
    const raw = map.get(P3E_BROWSER_AUTOSAVE_KEY) as string;
    const envelope = JSON.parse(raw) as {
      magic: string;
      saveFormatVersion: number;
      payloadFormat: string;
      payload: string;
    };
    const tamperedPayload = envelope.payload.replace(
      /(\d)/,
      (digit) => String((Number(digit) + 1) % 10)
    );
    map.set(
      P3E_BROWSER_AUTOSAVE_KEY,
      JSON.stringify({
        magic: envelope.magic,
        saveFormatVersion: envelope.saveFormatVersion,
        payloadFormat: envelope.payloadFormat,
        payload: tamperedPayload
      })
    );

    expectNotNative(() =>
      restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: SEED })
    );
  });
});

/* ================================================================== */
/* 四、儲存層錯誤傳播                                                    */
/* ================================================================== */

describe("H5-CTO-187-A 儲存層錯誤傳播", () => {
  it("quota：原生 quota 例外被 store 折類、經 orchestrator 傳播", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const quotaStorage: P3EBrowserStorageLike = {
      getItem: () => null,
      setItem: () => {
        const native = new Error("quota exceeded");
        native.name = "QuotaExceededError";
        throw native;
      },
      removeItem: () => undefined
    };
    const caught = expectNotNative(() =>
      saveP3EBrowserAutosaveSession({ storage: quotaStorage, session })
    );
    expect((caught as { code?: string }).code).toBe("E_P3E_STORE_QUOTA");
  });

  it("unavailable：缺方法的 storage 得 E_P3E_STORE_UNAVAILABLE", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const caught = expectNotNative(() =>
      saveP3EBrowserAutosaveSession({
        storage: { getItem: () => null } as unknown as P3EBrowserStorageLike,
        session
      })
    );
    expect((caught as { code?: string }).code).toBe("E_P3E_STORE_UNAVAILABLE");
  });

  it("corrupt stored value：空字串得 E_P3E_STORE_CORRUPT", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const { storage, map } = memoryStorage();
    map.set(P3E_BROWSER_AUTOSAVE_KEY, "");
    const caught = expectNotNative(() =>
      restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: SEED })
    );
    expect((caught as { code?: string }).code).toBe("E_P3E_STORE_CORRUPT");
  });

  it("too large：超過 1 MiB 的 envelope 得 E_P3E_STORE_TOO_LARGE", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const { storage } = memoryStorage();
    // 用 export override 產生 > 1 MiB 的 payload（envelope raw 必然 > 1 MiB）
    spies.exportOverride = () => "x".repeat(1_100_000);
    const caught = expectNotNative(() =>
      saveP3EBrowserAutosaveSession({ storage, session })
    );
    expect((caught as { code?: string }).code).toBe("E_P3E_STORE_TOO_LARGE");
  });
});

/* ================================================================== */
/* 五、exact-input 矩陣                                                  */
/* ================================================================== */

describe("H5-CTO-187-A exact-input 矩陣", () => {
  let world: unknown;
  let session: P3EPlaySession;
  let storage: P3EBrowserStorageLike;

  function prepareFixtures(): void {
    resetSpies();
    world = prepareP3EBrowserWorld(rawPacks);
    session = createP3EBrowserSession({ world, masterSeed: SEED });
    storage = memoryStorage().storage;
  }

  it("save：symbol／extra／missing／accessor／exotic proto／Proxy 全拒絕，getter 零執行", () => {
    prepareFixtures();

    // getter 永不執行的哨兵
    let getterRuns = 0;
    const withGetter: Dict = {};
    Object.defineProperty(withGetter, "storage", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return storage;
      }
    });
    withGetter.session = session;

    // symbol
    const withSymbol: Dict = { storage, session };
    Object.defineProperty(withSymbol, Symbol("extra"), {
      enumerable: true,
      value: 1
    });
    // extra enumerable 欄位
    const withExtra: Dict = { storage, session, extra: 1 };
    // 缺欄
    const withMissing: Dict = { storage };
    // 數量相同但鍵名不同（命中 names.includes 的缺失分支）
    const withWrongKey: Dict = { storage, sessions: session };
    // 非可列舉的額外欄位（names 數量不符）
    const withHidden: Dict = { storage, session };
    Object.defineProperty(withHidden, "hidden", { enumerable: false, value: 1 });
    // exotic proto
    const exotic: Dict = Object.create({ inherited: true }) as Dict;
    exotic.storage = storage;
    exotic.session = session;
    // ownKeys 拋錯的 Proxy
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys(): ArrayLike<string | symbol> {
          throw new RangeError("boom");
        },
        getOwnPropertyDescriptor() {
          return { enumerable: true, configurable: true, value: 1 };
        }
      }
    );
    // descriptor 缺失的不一致 Proxy
    const inconsistentProxy = new Proxy(
      {},
      {
        ownKeys(): ArrayLike<string | symbol> {
          return ["storage", "session"];
        },
        getOwnPropertyDescriptor(): undefined {
          return undefined;
        }
      }
    );

    const inputs: Array<[string, unknown]> = [
      ["symbol", withSymbol],
      ["extra", withExtra],
      ["missing", withMissing],
      ["wrongKey", withWrongKey],
      ["accessor", withGetter],
      ["hidden", withHidden],
      ["exotic", exotic],
      ["throwingProxy", throwingProxy],
      ["inconsistentProxy", inconsistentProxy],
      ["null", null],
      ["array", [storage, session]],
      ["primitive", 42]
    ];
    for (const [label, input] of inputs) {
      expectP3EArgument(() => saveP3EBrowserAutosaveSession(input));
      void label;
    }
    expect(getterRuns).toBe(0);
  });

  it("restore／clear：同樣的 exact-input 矩陣全拒絕", () => {
    prepareFixtures();

    const restoreInput: Dict = { storage, world, masterSeed: SEED };
    const withSymbol: Dict = { ...restoreInput };
    Object.defineProperty(withSymbol, Symbol("extra"), { enumerable: true, value: 1 });
    const withExtra: Dict = { ...restoreInput, extra: 1 };
    const withMissing: Dict = { storage, world };
    const withAccessor: Dict = {};
    Object.defineProperty(withAccessor, "storage", {
      enumerable: true,
      get: () => storage
    });
    withAccessor.world = world;
    withAccessor.masterSeed = SEED;

    expectP3EArgument(() =>
      restoreP3EBrowserAutosaveSession(withSymbol)
    );
    expectP3EArgument(() => restoreP3EBrowserAutosaveSession(withExtra));
    expectP3EArgument(() => restoreP3EBrowserAutosaveSession(withMissing));
    expectP3EArgument(() => restoreP3EBrowserAutosaveSession(withAccessor));
    expectP3EArgument(() => restoreP3EBrowserAutosaveSession(null));
    expectP3EArgument(() => restoreP3EBrowserAutosaveSession(undefined));
    expectP3EArgument(() => restoreP3EBrowserAutosaveSession(3.14));

    expectP3EArgument(() => clearP3EBrowserAutosaveSession({ storage, extra: 1 }));
    expectP3EArgument(() => clearP3EBrowserAutosaveSession({}));
    expectP3EArgument(() => clearP3EBrowserAutosaveSession(null));
    expectP3EArgument(() =>
      clearP3EBrowserAutosaveSession(new Proxy({}, { ownKeys() { throw new TypeError("no"); } }))
    );
  });

  it("inputs_unmodified：成功 save 前後輸入物件逐位元不變", () => {
    prepareFixtures();
    const { storage: storage2, map } = memoryStorage();
    const input: Dict = { storage: storage2, session };
    const snapshot = stable(input);
    saveP3EBrowserAutosaveSession(input);
    expect(stable(input)).toBe(snapshot);
    expect(map.size).toBe(1);
  });
});

/* ================================================================== */
/* 六、元件呼叫順序與恰好一次                                             */
/* ================================================================== */

describe("H5-CTO-187-A 元件呼叫順序與恰好一次", () => {
  it("save：export→create→encode→write 各恰好一次、順序固定", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    saveP3EBrowserAutosaveSession({ storage: memoryStorage().storage, session });
    expect(spies.calls).toEqual(["export", "create", "encode", "write"]);
    expect(spies.counts.export).toBe(1);
    expect(spies.counts.create).toBe(1);
    expect(spies.counts.encode).toBe(1);
    expect(spies.counts.write).toBe(1);
    expect(spies.counts.read).toBe(0);
  });

  it("restore：read→decode→restore 各恰好一次、順序固定", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const { storage } = memoryStorage();
    saveP3EBrowserAutosaveSession({ storage, session });
    resetSpies();
    restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: SEED });
    expect(spies.calls).toEqual(["read", "decode", "restore"]);
    expect(spies.counts.read).toBe(1);
    expect(spies.counts.decode).toBe(1);
    expect(spies.counts.restore).toBe(1);
    expect(spies.counts.export).toBe(0);
  });

  it("clear：clear 恰好一次", () => {
    resetSpies();
    clearP3EBrowserAutosaveSession({ storage: memoryStorage().storage });
    expect(spies.calls).toEqual(["clear"]);
    expect(spies.counts.clear).toBe(1);
  });
});

/* ================================================================== */
/* 七、儲存格式與公開面                                                  */
/* ================================================================== */

describe("H5-CTO-187-A 儲存格式與公開面", () => {
  it("actual_fixed_key：固定鍵內容是可 decode 的 raw V6 envelope", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const { storage, map } = memoryStorage();
    saveP3EBrowserAutosaveSession({ storage, session });

    expect(map.size).toBe(1);
    expect(map.has(P3E_BROWSER_AUTOSAVE_KEY)).toBe(true);
    const raw = map.get(P3E_BROWSER_AUTOSAVE_KEY) as string;
    const decoded = JSON.parse(raw) as Dict;
    expect(decoded.magic).toBe("LIFE1");
    expect(decoded.saveFormatVersion).toBe(6);
    expect(decoded.payloadFormat).toBe("p3e-session-payload-1");
    expect(decoded.payload).toBe(exportP3EPlaySessionPayload({ session }));
  });

  it("application_barrel_exports_only_high_level_orchestrator", () => {
    const names = Object.keys(barrel) as string[];
    for (const name of [
      "saveP3EBrowserAutosaveSession",
      "restoreP3EBrowserAutosaveSession",
      "clearP3EBrowserAutosaveSession"
    ]) {
      expect(names).toContain(name);
    }
    for (const lowLevel of [
      "writeP3EBrowserAutosave",
      "readP3EBrowserAutosave",
      "clearP3EBrowserAutosave",
      "P3E_BROWSER_AUTOSAVE_KEY",
      "P3EBrowserAutosaveStoreError"
    ]) {
      expect(names).not.toContain(lowLevel);
    }
    // save barrel：只暴露 V6 transport 的三個函式
    const saveNames = Object.keys(saveBarrel) as string[];
    for (const name of ["createP3ESaveEnvelopeV6", "encodeP3ESaveEnvelopeV6", "decodeP3ESaveEnvelopeV6"]) {
      expect(saveNames).toContain(name);
    }
    for (const internalName of ["validateP3ESaveEnvelopeV6", "encodeP3ESaveEnvelopeV6Compressed"]) {
      expect(saveNames).not.toContain(internalName);
    }
  });

  it("no_globals_and_formal_imports：去註解程式碼零禁詞、正式 import 路徑正確、零跨套件相對 import", () => {
    const codeOnly = ORCH_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const lowered = codeOnly.toLowerCase();
    for (const forbidden of [
      "localstorage",
      "sessionstorage",
      "indexeddb",
      "window",
      "document",
      "globalthis",
      "navigator",
      "gzip",
      "compress",
      "base64",
      "atob",
      "btoa",
      "crypto",
      "fetch",
      "xmlhttprequest",
      "websocket",
      "settimeout",
      "setinterval",
      "performance"
    ]) {
      expect(lowered, `forbidden word: ${forbidden}`).not.toContain(forbidden);
    }
    expect(codeOnly).not.toMatch(/\bDate\b/);
    expect(codeOnly).not.toMatch(/\bMath\b/);
    expect(codeOnly).not.toMatch(/\brandom\b/i);
    // 正式 import：只能經 @life-sim/save 公開 façade 與同套件相對模組
    expect(codeOnly).toContain('from "@life-sim/save"');
    expect(codeOnly).not.toContain("../../save/src");
    expect(codeOnly).not.toMatch(/from\s+"\.\.\/\.\.\//);
    expect(codeOnly).toContain('from "./p3e-browser-autosave-store"');
    expect(codeOnly).toContain('from "./p3e-browser-bootstrap"');
    expect(codeOnly).toContain('from "./p3e-session"');
  });

  it("no_native_error_leaks：非物件的 storage 也得 typed 錯誤", () => {
    resetSpies();
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const caught = expectNotNative(() =>
      saveP3EBrowserAutosaveSession({ storage: 42, session })
    );
    expect((caught as { code?: string }).code).toBe("E_P3E_STORE_UNAVAILABLE");
    expect(isP3EError(caught)).toBe(false);
    expect(caught).not.toBeInstanceOf(TypeError);
  });
});
