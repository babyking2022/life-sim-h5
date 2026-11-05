import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateDataPack } from "@life-sim/birth";
import { P3E_MAX_COMMANDS } from "@life-sim/contracts";
import * as barrel from "../src/index";
import {
  createP3EBrowserSession,
  prepareP3EBrowserWorld,
  restoreP3EBrowserSession
} from "../src/p3e-browser-bootstrap";
import {
  exportP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";
import { isP3EError, type P3EError } from "../../simulation/src/errors";

/**
 * H5-CTO-186-A：瀏覽器 Session Restore Bridge 正式測試。
 *
 * - 保留既有 bootstrap 前 7 個行為測試（對正式模組執行，證明行為不變）；
 *   第 8 個（barrel 匯出）改為「restore 與既有兩個入口都從公開 barrel 匯出」；
 * - 新增 restoreP3EBrowserSession 的正路／拒絕／計數矩陣；
 * - 全部期望值用正式原語或既有正式入口獨立驗證，不用模組自己的輸出當答案。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

type Dict = Record<string, unknown>;

/* ------------------------------ 計數 mock ------------------------------ */

const counters = vi.hoisted(() => ({
  peerGroup: 0,
  certificate: 0,
  restorePayload: 0
}));

vi.mock("@life-sim/birth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@life-sim/birth")>();
  return {
    ...actual,
    buildPeerGroup: (...args: unknown[]) => {
      counters.peerGroup += 1;
      return (actual.buildPeerGroup as unknown as (...inner: unknown[]) => unknown)(...args);
    },
    createBirthCertificate: (...args: unknown[]) => {
      counters.certificate += 1;
      return (actual.createBirthCertificate as unknown as (...inner: unknown[]) => unknown)(...args);
    }
  };
});

vi.mock("../src/p3e-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/p3e-session")>();
  return {
    ...actual,
    restoreP3EPlaySessionPayload: (input: unknown) => {
      counters.restorePayload += 1;
      return actual.restoreP3EPlaySessionPayload(input);
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

function nextCommand(session: P3EPlaySession): Dict {
  if (session.state.phase === "pending_decision") {
    const optionId = session.state.pendingDecision?.optionIds[0] as string;
    return { type: "CHOOSE_DECISION", optionId };
  }
  return { ...ADVANCE };
}

interface PlayedGame {
  readonly sessions: readonly P3EPlaySession[];
  readonly commands: number;
  readonly finalSession: P3EPlaySession;
}

/** 官方 51 命令路徑（與 playable smoke／p3e-session 測試相同規則），用正式模組開局。 */
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
  return { sessions, commands, finalSession: session };
}

let cachedGame: PlayedGame | null = null;
function game(): PlayedGame {
  if (cachedGame === null) cachedGame = playOfficialPath();
  return cachedGame;
}

function restoreInput(world: unknown, payload: string, overrides: Dict = {}): Dict {
  const input: Dict = { world, masterSeed: SEED, payload };
  for (const key of Object.keys(overrides)) input[key] = overrides[key];
  return input;
}

/* ================================================================== */
/* 一、既有 bootstrap 行為回歸（前 7 個，對正式模組執行）                 */
/* ================================================================== */

describe("H5-CTO-186-A 既有 bootstrap 行為回歸（正式模組）", () => {
  it("prepareP3EBrowserWorld：一次驗證、handle 深層凍結且不含 pack 欄位", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    expect(Object.isFrozen(world)).toBe(true);
    expect(Object.keys(world)).toEqual([]);
    expect(JSON.stringify(world)).toBe("{}");
    expect(Object.getOwnPropertySymbols(world).length).toBe(1);
  });

  it("createP3EBrowserSession：age 0、life、可繼續執行、同 seed 決定性", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    expect(session.state.age).toBe(0);
    expect(session.state.phase).toBe("life");
    expect(session.lastOutcome).toBeNull();

    const again = createP3EBrowserSession({ world, masterSeed: SEED });
    expect(again.state.stateHash).toBe(session.state.stateHash);
    expect(again).not.toBe(session);
  });

  it("每條命重用已驗證 pack：同一 world 可連續開兩條獨立命", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    const first = createP3EBrowserSession({ world, masterSeed: SEED });
    const second = createP3EBrowserSession({ world, masterSeed: `${SEED}-b` });
    expect(first.state.identity.entityId).not.toBe(second.state.identity.entityId);
    expect(first.state.stateHash).not.toBe(second.state.stateHash);
  });

  it("偽造或複製的 world 一律拒絕（create）", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    expectP3EError(
      () => createP3EBrowserSession({ world: {}, masterSeed: SEED }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
    const clone = structuredClone(world);
    expectP3EError(
      () => createP3EBrowserSession({ world: clone, masterSeed: SEED }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
    expectP3EError(
      () => createP3EBrowserSession({ world: 42, masterSeed: SEED }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
  });

  it("getters 永不執行（prepare、create 與 restore 都只讀 descriptor）", () => {
    let prepareGetterCalls = 0;
    const inputWithGetter = {
      get base(): unknown {
        prepareGetterCalls += 1;
        return rawPacks.base;
      },
      identity: rawPacks.identity,
      events: rawPacks.events,
      death: rawPacks.death
    };
    expectP3EError(
      () => prepareP3EBrowserWorld(inputWithGetter),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
    expect(prepareGetterCalls).toBe(0);

    const world = prepareP3EBrowserWorld(rawPacks);
    let createGetterCalls = 0;
    const createInput = {
      world,
      get masterSeed(): string {
        createGetterCalls += 1;
        return SEED;
      }
    };
    expectP3EError(
      () => createP3EBrowserSession(createInput),
      "E_P3E_ARGUMENT",
      "p3eBrowser.create.input"
    );
    expect(createGetterCalls).toBe(0);

    let restoreGetterCalls = 0;
    const restoreInputWithGetter = {
      world,
      masterSeed: SEED,
      get payload(): string {
        restoreGetterCalls += 1;
        return "x";
      }
    };
    expectP3EError(
      () => restoreP3EBrowserSession(restoreInputWithGetter),
      "E_P3E_ARGUMENT",
      "p3eBrowser.restore.input"
    );
    expect(restoreGetterCalls).toBe(0);
  });

  it("input 邊界：改名／多欄／少欄／陣列／null 一律拒絕", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    expectP3EError(
      () => prepareP3EBrowserWorld({ ...rawPacks, extra: 1 }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
    const renamed: Record<string, unknown> = { ...rawPacks };
    delete renamed["death"];
    renamed["mortality"] = rawPacks.death;
    expectP3EError(() => prepareP3EBrowserWorld(renamed), "E_P3E_ARGUMENT", "p3eBrowser.world");
    const hidden: Record<string, unknown> = { ...rawPacks };
    Object.defineProperty(hidden, "events", { value: rawPacks.events, enumerable: false });
    expectP3EError(() => prepareP3EBrowserWorld(hidden), "E_P3E_ARGUMENT", "p3eBrowser.world");
    const revocable = Proxy.revocable({ ...rawPacks }, {});
    revocable.revoke();
    expectP3EError(
      () => prepareP3EBrowserWorld(revocable.proxy),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
    expectP3EError(
      () => createP3EBrowserSession({ world, masterSeed: SEED, extra: 1 }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.create.input"
    );
    expectP3EError(
      () => createP3EBrowserSession({ world }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.create.input"
    );
    expectP3EError(
      () => createP3EBrowserSession([world]),
      "E_P3E_ARGUMENT",
      "p3eBrowser.create.input"
    );
    expectP3EError(
      () => createP3EBrowserSession(null),
      "E_P3E_ARGUMENT",
      "p3eBrowser.create.input"
    );
    expectP3EError(
      () => createP3EBrowserSession({ world, masterSeed: 7 }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.masterSeed"
    );
    // null-prototype exact object 合法
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, rawPacks);
    expect(prepareP3EBrowserWorld(nullProto)).toBeTruthy();
  });

  it("pack 不合法時原樣外傳驗證錯誤（不重包）", () => {
    let direct: unknown = null;
    try {
      validateDataPack({ manifest: "bad" } as never);
    } catch (error) {
      direct = error;
    }
    let caught: unknown = null;
    try {
      prepareP3EBrowserWorld({ ...rawPacks, base: { manifest: "bad" } });
    } catch (error) {
      caught = error;
    }
    expect(direct).not.toBeNull();
    expect(caught).not.toBeNull();
    expect((caught as Error).constructor).toBe((direct as Error).constructor);
    expect((caught as Error).message).toBe((direct as Error).message);
  });
});

/* ================================================================== */
/* 二、公開 barrel（取代既有 barrel 匯出斷言：正式不得公開）              */
/* ================================================================== */

describe("H5-CTO-186-A 正式模組與公開 barrel", () => {
  it("restore_is_public_barrel_entry：restore 與既有兩個入口都從公開 barrel 匯出", () => {
    expect(typeof barrel.restoreP3EBrowserSession).toBe("function");
    expect(typeof barrel.prepareP3EBrowserWorld).toBe("function");
    expect(typeof barrel.createP3EBrowserSession).toBe("function");
    const indexSource = readFileSync(join(ROOT, "packages/application/src/index.ts"), "utf8");
    expect(indexSource).toContain("./p3e-browser-bootstrap");
  });
});

/* ================================================================== */
/* 三、restoreP3EBrowserSession：正路                                    */
/* ================================================================== */

describe("H5-CTO-186-A restoreP3EBrowserSession：正路", () => {
  it("fresh_create_export_restore_bit_exact_empty_history", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const payload = exportP3EPlaySessionPayload({ session });
    const restored = restoreP3EBrowserSession(restoreInput(world, payload));

    expect(restored).not.toBe(session);
    expect(restored.ledgerHistory.records.length).toBe(0);
    expect(stable(restored.state)).toBe(stable(session.state));
    expect(restored.lastOutcome).toBeNull();
    expect(exportP3EPlaySessionPayload({ session: restored })).toBe(payload);
    // payload 不在輸出上、packs 不在欄位上
    expect(Object.keys(restored).sort()).toEqual(["lastOutcome", "ledgerHistory", "state", "view"]);
    expect(JSON.stringify(restored.view)).not.toContain("payload");
  });

  it("official_51_export_restore_bit_exact_and_can_continue_or_death_is_stable", () => {
    const played = game();
    expect(played.commands).toBe(51);

    // 1. 官方 51 命令終局：export → restore 逐位元一致＋固定雜湊；death 狀態穩定。
    const finalPayload = exportP3EPlaySessionPayload({ session: played.finalSession });
    const restoredFinal = restoreP3EBrowserSession(restoreInput(prepareP3EBrowserWorld(rawPacks), finalPayload));
    expect(restoredFinal.ledgerHistory.records.length).toBe(51);
    expect(stable(restoredFinal.state)).toBe(stable(played.finalSession.state));
    expect(stable(restoredFinal.lastOutcome)).toBe(stable(played.finalSession.lastOutcome));
    expect(restoredFinal.state.stateHash).toBe(
      "9418bd66908eed8abaae458ccf914af43cbca730eb0b9fb73937f9232480eb48"
    );
    expect(restoredFinal.state.commandLog.headHash).toBe(
      "cf0cc74720628ad5aa5fd367241b8b43b530802187ad2f5ff12a57a00b28b60f"
    );
    expect(restoredFinal.state.heads.hashChain).toBe(
      "75e557e08b2e27de0f78a533b1e30cd1ac5a4a57d0de0ee0494df4b2232bfc80"
    );
    expect(restoredFinal.state.heads.lastEntryHash).toBe(
      "18c5efcae5d83d6fc05302ea122a69d5032a6beccd75ca83f926ab8231369bb4"
    );
    expect(restoredFinal.view.controls).toEqual({
      canAdvanceYear: false,
      canChooseDecision: false,
      isDead: true
    });
    expect(exportP3EPlaySessionPayload({ session: restoredFinal })).toBe(finalPayload);

    // 2. 中途 life session：restore 後可繼續，且下一個 session 與原路逐位元一致。
    const world = prepareP3EBrowserWorld(rawPacks);
    const midIndex = 10;
    const mid = played.sessions[midIndex] as P3EPlaySession;
    const midPayload = exportP3EPlaySessionPayload({ session: mid });
    const restoredMid = restoreP3EBrowserSession(restoreInput(world, midPayload));
    expect(stable(restoredMid.state)).toBe(stable(mid.state));
    const continued = runP3EPlaySessionCommand({
      session: restoredMid,
      command: nextCommand(restoredMid)
    }).session;
    const originalNext = played.sessions[midIndex + 1] as P3EPlaySession;
    expect(stable(continued.state)).toBe(stable(originalNext.state));
    expect(stable(continued.ledgerHistory)).toBe(stable(originalNext.ledgerHistory));
  });

  it("pending_decision_restore_preserves_labels_and_choice_continuation", () => {
    const played = game();
    const pendingIndex = played.sessions.findIndex(
      (session) => session.state.phase === "pending_decision"
    );
    if (pendingIndex < 0) throw new Error("official seed did not reach pending_decision");
    const pending = played.sessions[pendingIndex] as P3EPlaySession;
    const world = prepareP3EBrowserWorld(rawPacks);

    const restored = restoreP3EBrowserSession(
      restoreInput(world, exportP3EPlaySessionPayload({ session: pending }))
    );
    expect(restored.state.phase).toBe("pending_decision");
    // labels／selection 全部保留
    expect(stable(restored.view.pendingDecision)).toBe(stable(pending.view.pendingDecision));
    expect(stable(restored.lastOutcome)).toBe(stable(pending.lastOutcome));
    expect(restored.view.controls).toEqual({
      canAdvanceYear: false,
      canChooseDecision: true,
      isDead: false
    });

    // 選擇第一個合法 optionId 後回到 life，且與原路下一個 session 逐位元一致
    const optionId = restored.state.pendingDecision?.optionIds[0] as string;
    const chosen = runP3EPlaySessionCommand({
      session: restored,
      command: { type: "CHOOSE_DECISION", optionId }
    }).session;
    expect(chosen.state.phase).toBe("life");
    const originalNext = played.sessions[pendingIndex + 1] as P3EPlaySession;
    expect(stable(chosen.state)).toBe(stable(originalNext.state));
  });

  it("restored_session_is_frozen_and_privately_branded", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    const played = game();
    const payload = exportP3EPlaySessionPayload({ session: played.finalSession });
    const restored = restoreP3EBrowserSession(restoreInput(world, payload));

    expect(isDeepFrozen(restored)).toBe(true);
    expect(isDeepFrozen(restored.view)).toBe(true);
    expect(isDeepFrozen(restored.ledgerHistory)).toBe(true);
    expect(Object.keys(restored).sort()).toEqual(["lastOutcome", "ledgerHistory", "state", "view"]);

    // 私有 brand：還原後的 session 可 run／export；structuredClone 複本一律拒絕
    const cloned = structuredClone(restored);
    expectP3EError(
      () => runP3EPlaySessionCommand({ session: cloned, command: { ...ADVANCE } }),
      "E_P3E_ARGUMENT",
      "p3eSession.session"
    );
    expectP3EError(
      () => exportP3EPlaySessionPayload({ session: cloned }),
      "E_P3E_ARGUMENT",
      "p3eSession.session"
    );
    // 再次還原得到新物件（不共享）
    const again = restoreP3EBrowserSession(restoreInput(world, payload));
    expect(again).not.toBe(restored);
    expect(stable(again)).toBe(stable(restored));
  });
});

/* ================================================================== */
/* 四、restoreP3EBrowserSession：拒絕矩陣                                */
/* ================================================================== */

describe("H5-CTO-186-A restoreP3EBrowserSession：拒絕", () => {
  it("wrong_seed_corrupt_payload_and_claim_tamper_rejected", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    const played = game();
    const payload = exportP3EPlaySessionPayload({ session: played.finalSession });

    // 1. 錯 seed：payload 內 seed 與輸入不符 → 正式 application 錯誤路徑。
    expectP3EError(
      () => restoreP3EBrowserSession(restoreInput(world, payload, { masterSeed: "p3e-other-seed" })),
      "E_P3E_ARGUMENT",
      "p3eSession.payload"
    );
    expectP3EError(
      () => restoreP3EBrowserSession(restoreInput(world, payload, { masterSeed: 7 })),
      "E_P3E_ARGUMENT",
      "p3eBrowser.masterSeed"
    );

    // 2. 壞 payload：codec 綁定失敗（錯誤原樣外拋）。
    const tampered = payload.replace("9418bd66", "9418bd67");
    expect(tampered).not.toBe(payload);
    let tamperedError: unknown = null;
    try {
      restoreP3EBrowserSession(restoreInput(world, tampered));
    } catch (error) {
      tamperedError = error;
    }
    expect(isP3EError(tamperedError)).toBe(true);
    expect(["E_P3E_CODEC", "E_P3E_HASH"]).toContain((tamperedError as P3EError).code);

    // 3. 可 decode 但非 canonical：宣稱值與正式重編碼不一致 → 固定 application 路徑。
    const nonCanonical = payload.replace('"state":', '"state": ');
    expect(nonCanonical).not.toBe(payload);
    expectP3EError(
      () => restoreP3EBrowserSession(restoreInput(world, nonCanonical)),
      "E_P3E_ARGUMENT",
      "p3eSession.payload"
    );
  });

  it("forged_cloned_world_rejected", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    const played = game();
    const payload = exportP3EPlaySessionPayload({ session: played.finalSession });

    // 偽造
    expectP3EError(
      () => restoreP3EBrowserSession(restoreInput({}, payload)),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
    // structuredClone 複本
    const clone = structuredClone(world);
    expectP3EError(
      () => restoreP3EBrowserSession(restoreInput(clone, payload)),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
    // 非物件
    expectP3EError(
      () => restoreP3EBrowserSession(restoreInput(42, payload)),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
    expectP3EError(
      () => restoreP3EBrowserSession(restoreInput(null, payload)),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
  });

  it("restore_exact_input_accessor_symbol_extra_exotic_proxy_matrix", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    const played = game();
    const payload = exportP3EPlaySessionPayload({ session: played.finalSession });
    const valid = restoreInput(world, payload);

    expectP3EError(
      () => restoreP3EBrowserSession({ ...valid, extra: 1 }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.restore.input"
    );
    const renamed: Dict = { ...valid };
    delete renamed["payload"];
    renamed["data"] = payload;
    expectP3EError(
      () => restoreP3EBrowserSession(renamed),
      "E_P3E_ARGUMENT",
      "p3eBrowser.restore.input"
    );
    const withSymbol: Dict = { ...valid };
    (withSymbol as unknown as Record<symbol, unknown>)[Symbol("evil")] = 1;
    expectP3EError(
      () => restoreP3EBrowserSession(withSymbol),
      "E_P3E_ARGUMENT",
      "p3eBrowser.restore.input"
    );
    const hidden: Dict = { ...valid };
    Object.defineProperty(hidden, "payload", { value: payload, enumerable: false, writable: true });
    expectP3EError(
      () => restoreP3EBrowserSession(hidden),
      "E_P3E_ARGUMENT",
      "p3eBrowser.restore.input"
    );
    expectP3EError(
      () => restoreP3EBrowserSession([valid]),
      "E_P3E_ARGUMENT",
      "p3eBrowser.restore.input"
    );
    expectP3EError(
      () => restoreP3EBrowserSession(null),
      "E_P3E_ARGUMENT",
      "p3eBrowser.restore.input"
    );
    expectP3EError(
      () => restoreP3EBrowserSession(undefined),
      "E_P3E_ARGUMENT",
      "p3eBrowser.restore.input"
    );
    const revocable = Proxy.revocable(valid, {});
    revocable.revoke();
    expectP3EError(
      () => restoreP3EBrowserSession(revocable.proxy),
      "E_P3E_ARGUMENT",
      "p3eBrowser.restore.input"
    );
    // trap 拋出的原生錯誤一律折進 E_P3E_ARGUMENT，不得外洩
    const evil = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        ownKeys() {
          throw new Error("boom");
        }
      }
    );
    expectP3EError(
      () => restoreP3EBrowserSession(evil),
      "E_P3E_ARGUMENT",
      "p3eBrowser.restore.input"
    );
    // null-prototype exact object 合法（恰好三欄）
    const nullProto = Object.assign(Object.create(null) as Dict, valid);
    expect(restoreP3EBrowserSession(nullProto).state.phase).toBe("death");
  });

  it("buildPeerGroup_certificate_restore_call_counts_exactly_once", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: SEED });
    const payload = exportP3EPlaySessionPayload({ session });

    counters.peerGroup = 0;
    counters.certificate = 0;
    counters.restorePayload = 0;
    restoreP3EBrowserSession(restoreInput(world, payload));
    expect(counters.peerGroup).toBe(1);
    expect(counters.certificate).toBe(1);
    expect(counters.restorePayload).toBe(1);
  });
});
