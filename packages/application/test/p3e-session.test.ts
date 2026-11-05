import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPeerGroup,
  createBirthCertificate,
  validateDataPack,
  validateDeathPack,
  validateIdentityPack
} from "@life-sim/birth";
import { validateEventPack } from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import * as simulation from "@life-sim/simulation";
import * as applicationBarrel from "../src/index";
import {
  createP3EPlaySession,
  exportP3EPlaySessionPayload,
  restoreP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";
import { isP3EError, type P3EError } from "../../simulation/src/errors";
import { replayP3ELedgerHistory } from "../../simulation/src/p3e-replay";

/**
 * H5-CTO-174-A：P3-E.1b-2n Application Play Session ＋ ViewModel 測試。
 *
 * 全部命令都經由 session API；期望值一律用正式原語或正式 simulation 入口獨立驗證，
 * 不用 session 自己的輸出當答案。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

type Dict = Record<string, unknown>;

/* ------------------------------ fixtures ------------------------------ */

const base = validateDataPack({
  manifest: readJson("fixtures/p2a/manifest.v1.json"),
  datasets: {
    "country-registry": readJson("fixtures/p2a/country-registry.v1.json"),
    indicators: readJson("fixtures/p2a/indicators.v1.json"),
    "birth-weights": readJson("fixtures/p2a/birth-weights.v1.json"),
    "sensitive-names": readJson("fixtures/p2a/sensitive-names.v1.json"),
    licenses: readJson("fixtures/p2a/licenses.v1.json"),
    lineage: readJson("fixtures/p2a/lineage.v1.json")
  }
} as never);

const identityPack = validateIdentityPack(base, {
  manifest: readJson("fixtures/p2b/manifest.v1.json"),
  datasets: {
    "country-vitals": readJson("fixtures/p2b/country-vitals.v1.json"),
    "household-profiles": readJson("fixtures/p2b/household-profiles.v1.json"),
    "name-corpus": readJson("fixtures/p2b/name-corpus.v1.json"),
    "story-templates": readJson("fixtures/p2b/story-templates.v1.json"),
    licenses: readJson("fixtures/p2b/licenses.v1.json"),
    lineage: readJson("fixtures/p2b/lineage.v1.json")
  }
} as never);

const officialEventPack = validateEventPack({
  manifest: readJson("fixtures/p3b/manifest.v1.json"),
  events: (readJson("fixtures/p3b/events.v1.json") as { records: unknown[] }).records
} as never);

const deathPack = validateDeathPack(
  {
    manifest: readJson("fixtures/p3d/manifest.v1.json"),
    datasets: {
      "cause-registry": readJson("fixtures/p3d/cause-registry.v1.json"),
      "cause-weights": readJson("fixtures/p3d/cause-weights.v1.json"),
      mortality: readJson("fixtures/p3d/mortality.v1.json"),
      licenses: readJson("fixtures/p3d/licenses.v1.json"),
      lineage: readJson("fixtures/p3d/lineage.v1.json")
    }
  } as never,
  base
);

const SEED = "p3e-166-playable-runtime-v4";
const peerGroup = buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never);
const certificate = createBirthCertificate(base, identityPack, peerGroup, SEED);

/** 建立官方 seed 的 session（正式 fixtures ＋ 正式 pack）。 */
function officialSession(): P3EPlaySession {
  return createP3EPlaySession({
    masterSeed: SEED,
    basePack: base,
    identityPack,
    certificate,
    eventPack: officialEventPack,
    deathPack
  });
}

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

/** 官方 51 命令路徑（與 playable smoke 相同規則）。 */
function playOfficialPath(): PlayedGame {
  const sessions: P3EPlaySession[] = [];
  let session = officialSession();
  let commands = 0;
  while (session.state.phase !== "death") {
    const command = nextCommand(session);
    const result = runP3EPlaySessionCommand({ session, command });
    session = result.session;
    sessions.push(session);
    commands += 1;
    if (commands > contracts.P3E_MAX_COMMANDS) throw new Error("did not reach death");
  }
  return { sessions, commands, finalSession: session };
}

let cachedGame: PlayedGame | null = null;
function game(): PlayedGame {
  if (cachedGame === null) cachedGame = playOfficialPath();
  return cachedGame;
}

/* ================================================================== */
/* 一、建立與基本推進                                                   */
/* ================================================================== */

describe("H5-CTO-174-A Play Session：建立與推進", () => {
  it("genesis_session：age 0、life、lastOutcome null、controls 正確", () => {
    const session = officialSession();
    expect(session.state.age).toBe(0);
    expect(session.state.phase).toBe("life");
    expect(session.lastOutcome).toBeNull();
    expect(session.view.phase).toBe("life");
    expect(session.view.currentYear).toBe(session.state.currentYear);
    expect(session.view.controls).toEqual({
      canAdvanceYear: true,
      canChooseDecision: false,
      isDead: false
    });
    expect(session.view.pendingDecision).toBeNull();
    expect(Object.keys(session).sort()).toEqual(["lastOutcome", "ledgerHistory", "state", "view"]);
  });

  it("advance_life：ADVANCE_YEAR 後 lastOutcome 是 advance_year、view 同步", () => {
    const session = officialSession();
    const result = runP3EPlaySessionCommand({ session, command: { ...ADVANCE } });
    expect(result.session).not.toBe(session);
    expect(result.session.state.age).toBe(session.state.age + 1);
    expect(result.session.lastOutcome?.kind).toBe("advance_year");
    expect(result.session.view.lastOutcome).toBe(result.session.lastOutcome);
    expect(result.session.view.phase).toBe(result.session.state.phase);
    expect(result.commandRecord.index).toBe(1);
    expect(result.yearRecord.index).toBe(1);
  });

  it("advance_pending：事件開啟決策時 view.pendingDecision 與 State 一致", () => {
    const session = officialSession();
    let current = session;
    let guard = 0;
    while (current.state.phase !== "pending_decision" && current.state.phase !== "death" && guard < 120) {
      current = runP3EPlaySessionCommand({ session: current, command: nextCommand(current) }).session;
      guard += 1;
    }
    if (current.state.phase !== "pending_decision") {
      throw new Error("official seed did not reach pending_decision");
    }
    const pending = current.view.pendingDecision;
    expect(pending).not.toBeNull();
    expect(pending?.eventId).toBe(current.state.pendingDecision?.eventId);
    expect(pending?.decisionId).toBe(current.state.pendingDecision?.decisionId);
    expect(pending?.selectionHash).toBe(current.state.pendingDecision?.selectionHash);
    expect(pending?.options.map((option) => option.optionId)).toEqual(
      [...(current.state.pendingDecision?.optionIds ?? [])]
    );
    expect(current.view.controls).toEqual({
      canAdvanceYear: false,
      canChooseDecision: true,
      isDead: false
    });
  });

  it("choose_decision：CHOOSE_DECISION 後回到 life、lastOutcome 是 choose_decision", () => {
    const pending = game().sessions.find((session) => session.state.phase === "pending_decision");
    if (pending === undefined) throw new Error("no pending session");
    const optionId = pending.state.pendingDecision?.optionIds[0] as string;
    const result = runP3EPlaySessionCommand({
      session: pending,
      command: { type: "CHOOSE_DECISION", optionId }
    });
    expect(result.session.state.phase).toBe("life");
    expect(result.session.state.pendingDecision).toBeNull();
    expect(result.session.lastOutcome?.kind).toBe("choose_decision");
    expect(result.session.view.pendingDecision).toBeNull();
    expect(result.session.view.controls.canChooseDecision).toBe(false);
  });

  it("death：最終 session 的 isDead 與 lastOutcome.death 一致", () => {
    const finalSession = game().finalSession;
    expect(finalSession.state.phase).toBe("death");
    expect(finalSession.view.controls).toEqual({
      canAdvanceYear: false,
      canChooseDecision: false,
      isDead: true
    });
    if (finalSession.lastOutcome?.kind !== "advance_year") throw new Error("outcome kind");
    expect(finalSession.lastOutcome.death).not.toBeNull();
    expect(finalSession.lastOutcome.pendingDecision).toBeNull();
  });
});

/* ================================================================== */
/* 二、View 規則                                                        */
/* ================================================================== */

describe("H5-CTO-174-A Play Session：View 規則", () => {
  it("controls_matrix：每個 session 的 controls 都符合 phase 矩陣", () => {
    const expected: Dict = {
      life: { canAdvanceYear: true, canChooseDecision: false, isDead: false },
      pending_decision: { canAdvanceYear: false, canChooseDecision: true, isDead: false },
      death: { canAdvanceYear: false, canChooseDecision: false, isDead: true }
    };
    for (const session of game().sessions) {
      expect(session.view.controls).toEqual(expected[session.view.phase]);
      expect(session.view.phase).toBe(session.state.phase);
    }
  });

  it("money_decimal_strings：view 金錢是 base10 字串且 view 可安全 JSON 序列化", () => {
    const session = game().sessions[10] as P3EPlaySession;
    expect(session.view.assets.balanceMicroUsd).toBe(session.state.assets.balanceMicroUsd.toString());
    expect(session.view.assets.annualIncomeMicroUsd).toBe(
      session.state.assets.annualIncomeMicroUsd.toString()
    );
    expect(session.view.assets.annualExpenseMicroUsd).toBe(
      session.state.assets.annualExpenseMicroUsd.toString()
    );
    for (const value of Object.values(session.view.assets)) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^-?[0-9]+$/);
    }
    expect(() => JSON.stringify(session.view)).not.toThrow();
    expect(JSON.stringify(session.view)).not.toContain("BigInt");
  });

  it("outcome_passthrough：view.lastOutcome 就是 simulation 的同一個 outcome", () => {
    const session = game().sessions[3] as P3EPlaySession;
    expect(session.view.lastOutcome).toBe(session.lastOutcome);
    const previous = game().sessions[2] as P3EPlaySession;
    const command = previous.state.phase === "pending_decision"
      ? { type: "CHOOSE_DECISION", optionId: previous.state.pendingDecision?.optionIds[0] as string }
      : { ...ADVANCE };
    const direct = simulation.executeP3ECommand({
      state: previous.state,
      eventPack: officialEventPack,
      deathPack,
      command
    });
    expect(stable(session.lastOutcome)).toBe(stable(direct.outcome));
  });
});

/* ================================================================== */
/* 三、不可變性與錯誤                                                  */
/* ================================================================== */

describe("H5-CTO-174-A Play Session：不可變性與錯誤", () => {
  it("deterministic_sequence：同輸入序列得到逐位元相同的 session", () => {
    function firstSix(): string[] {
      let session = officialSession();
      const digests: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        session = runP3EPlaySessionCommand({ session, command: nextCommand(session) }).session;
        digests.push(stable({ view: session.view, stateHash: session.state.stateHash }));
      }
      return digests;
    }
    expect(firstSix()).toEqual(firstSix());
  });

  it("old_session_unchanged：舊 session 完全不被修改", () => {
    const session = officialSession();
    const before = stable({ view: session.view, state: session.state, lastOutcome: session.lastOutcome });
    const result = runP3EPlaySessionCommand({ session, command: { ...ADVANCE } });
    expect(result.session).not.toBe(session);
    expect(stable({ view: session.view, state: session.state, lastOutcome: session.lastOutcome })).toBe(before);
    expect(session.lastOutcome).toBeNull();
    expect(session.state.commandLog.count).toBe(0);
  });

  it("failed_command_atomicity：失敗命令不產生新 session、不修改舊 session", () => {
    const session = officialSession();
    const before = stable(session.view);
    expectP3EError(
      () => runP3EPlaySessionCommand({ session, command: { type: "CHOOSE_DECISION", optionId: "save" } }),
      "E_P3E_PHASE",
      "phase"
    );
    expect(stable(session.view)).toBe(before);
    expect(session.state.phase).toBe("life");
  });

  it("fake_and_cloned_session_rejected：偽造或複製的 session 一律拒絕", () => {
    const session = officialSession();
    const fake = { state: session.state, lastOutcome: null, view: session.view };
    expectP3EError(
      () => runP3EPlaySessionCommand({ session: fake, command: { ...ADVANCE } }),
      "E_P3E_ARGUMENT",
      "p3eSession.session"
    );
    const cloned = structuredClone(session);
    expectP3EError(
      () => runP3EPlaySessionCommand({ session: cloned, command: { ...ADVANCE } }),
      "E_P3E_ARGUMENT",
      "p3eSession.session"
    );
  });

  it("getters_never_execute：create／run 的 getter 都不會被執行", () => {
    let createGetterCalls = 0;
    const createInput = {
      get masterSeed(): string {
        createGetterCalls += 1;
        return SEED;
      },
      basePack: base,
      identityPack,
      certificate,
      eventPack: officialEventPack,
      deathPack
    };
    expectP3EError(() => createP3EPlaySession(createInput), "E_P3E_ARGUMENT", "p3eSession.input");
    expect(createGetterCalls).toBe(0);

    const session = officialSession();
    let runGetterCalls = 0;
    const runInput = {
      session,
      get command(): Dict {
        runGetterCalls += 1;
        return { ...ADVANCE };
      }
    };
    expectP3EError(() => runP3EPlaySessionCommand(runInput), "E_P3E_ARGUMENT", "p3eSession.input");
    expect(runGetterCalls).toBe(0);
  });

  it("input_boundary_matrix：改名／多欄／symbol／Proxy／非物件一律拒絕", () => {
    const valid = {
      masterSeed: SEED,
      basePack: base,
      identityPack,
      certificate,
      eventPack: officialEventPack,
      deathPack
    };
    const renamed: Dict = { ...valid, seed: SEED };
    delete renamed.masterSeed;
    expectP3EError(() => createP3EPlaySession(renamed), "E_P3E_ARGUMENT", "p3eSession.input");
    expectP3EError(() => createP3EPlaySession({ ...valid, extra: 1 }), "E_P3E_ARGUMENT", "p3eSession.input");
    const withSymbol: Dict = { ...valid };
    (withSymbol as Record<symbol, unknown>)[Symbol("evil")] = 1;
    expectP3EError(() => createP3EPlaySession(withSymbol), "E_P3E_ARGUMENT", "p3eSession.input");
    const hidden: Dict = { ...valid };
    Object.defineProperty(hidden, "masterSeed", { value: SEED, enumerable: false, writable: true });
    expectP3EError(() => createP3EPlaySession(hidden), "E_P3E_ARGUMENT", "p3eSession.input");
    const revocable = Proxy.revocable(valid, {});
    revocable.revoke();
    expectP3EError(() => createP3EPlaySession(revocable.proxy), "E_P3E_ARGUMENT", "p3eSession.input");
    expectP3EError(() => createP3EPlaySession([valid]), "E_P3E_ARGUMENT", "p3eSession.input");
    expectP3EError(() => createP3EPlaySession(null), "E_P3E_ARGUMENT", "p3eSession.input");

    // null-prototype 的 exact object 是合法的（proto === null 分支）
    const nullProto = Object.assign(Object.create(null) as Dict, valid);
    expect(createP3EPlaySession(nullProto).state.age).toBe(0);

    const session = officialSession();
    expectP3EError(
      () => runP3EPlaySessionCommand({ session: 42, command: { ...ADVANCE } }),
      "E_P3E_ARGUMENT",
      "p3eSession.session"
    );
    expectP3EError(
      () => runP3EPlaySessionCommand({ session, command: { ...ADVANCE }, extra: 1 }),
      "E_P3E_ARGUMENT",
      "p3eSession.input"
    );
  });

  it("packs_not_enumerable_or_serialized：packs 不在 session 欄位也不被序列化", () => {
    const session = officialSession();
    expect(Object.keys(session).sort()).toEqual(["lastOutcome", "ledgerHistory", "state", "view"]);
    for (const key of Object.keys(session)) {
      expect(key).not.toContain("eventPack");
      expect(key).not.toContain("deathPack");
      expect((session as unknown as Dict)[key]).not.toBe(officialEventPack);
      expect((session as unknown as Dict)[key]).not.toBe(deathPack);
    }
    expect(Object.keys(session.view).sort()).toEqual([
      "age",
      "assets",
      "controls",
      "currentYear",
      "identity",
      "lastOutcome",
      "pendingDecision",
      "phase",
      "stats"
    ]);
  });

  it("deep_freeze：session／view／outcome／records 全部深層凍結", () => {
    const result = runP3EPlaySessionCommand({ session: officialSession(), command: { ...ADVANCE } });
    expect(isDeepFrozen(result)).toBe(true);
    expect(isDeepFrozen(result.session)).toBe(true);
    expect(isDeepFrozen(result.session.view)).toBe(true);
    expect(isDeepFrozen(result.session.view.controls)).toBe(true);
    expect(isDeepFrozen(result.session.view.assets)).toBe(true);
    expect(isDeepFrozen(result.session.view.identity)).toBe(true);
    expect(isDeepFrozen(result.session.view.stats)).toBe(true);
  });

  it("no_history_growth：session 不保存命令歷史（只有 commandLog 摘要）", () => {
    const finalSession = game().finalSession;
    expect(Object.keys(finalSession).sort()).toEqual(["lastOutcome", "ledgerHistory", "state", "view"]);
    expect(Object.keys(finalSession.state.commandLog).sort()).toEqual(["count", "headHash"]);
    expect(Array.isArray((finalSession as unknown as Dict).commands)).toBe(false);
    expect(Array.isArray((finalSession.state as unknown as Dict).commands)).toBe(false);
  });
});

/* ================================================================== */
/* 四、完整生命週期與效能                                              */
/* ================================================================== */

describe("H5-CTO-174-A Play Session：完整生命週期與效能", () => {
  it("birth_to_death_session_loop：官方 51 命令路徑與 smoke 完全一致", () => {
    const played = game();
    expect(played.commands).toBe(51);
    expect(played.finalSession.state.age).toBe(50);
    expect(played.finalSession.state.phase).toBe("death");
    expect(played.finalSession.state.stateHash).toBe(
      "9418bd66908eed8abaae458ccf914af43cbca730eb0b9fb73937f9232480eb48"
    );
    expect(played.finalSession.state.commandLog.headHash).toBe(
      "cf0cc74720628ad5aa5fd367241b8b43b530802187ad2f5ff12a57a00b28b60f"
    );
    expect(played.finalSession.state.heads.hashChain).toBe(
      "75e557e08b2e27de0f78a533b1e30cd1ac5a4a57d0de0ee0494df4b2232bfc80"
    );
    expect(played.finalSession.state.heads.lastEntryHash).toBe(
      "18c5efcae5d83d6fc05302ea122a69d5032a6beccd75ca83f926ab8231369bb4"
    );
  });

  it("perf：官方 51 命令路徑的 session 開銷（回報 avg；反回歸門檻 200ms）", () => {
    const beforeHeap = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    const played = playOfficialPath();
    const totalMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const heapDelta = process.memoryUsage().heapUsed - beforeHeap;
    const avgMs = totalMs / played.commands;
    const cpuAvgMs = cpuMs / played.commands;
    expect(played.commands).toBe(51);
    // 平行全套執行時 wall／CPU 都會被同一個 worker 的其他重型測試污染，
    // 因此這裡只守反回歸（200ms）；<50ms 的目標以單檔隔離量測回報。
    expect(cpuAvgMs).toBeLessThan(200);
    console.log(
      `P3E-SESSION-PERF total_ms=${totalMs.toFixed(1)} avg_ms_per_command=${avgMs.toFixed(3)} ` +
        `cpu_avg_ms_per_command=${cpuAvgMs.toFixed(3)} heap_delta_bytes=${heapDelta} node=${process.version}`
    );
  });
});

/* ================================================================== */
/* 五、公開 barrel                                                      */
/* ================================================================== */

describe("H5-CTO-174-A Play Session：公開 barrel", () => {
  it("session API 可從 application barrel 呼叫", () => {
    expect(typeof applicationBarrel.createP3EPlaySession).toBe("function");
    expect(typeof applicationBarrel.runP3EPlaySessionCommand).toBe("function");
    const session = applicationBarrel.createP3EPlaySession({
      masterSeed: SEED,
      basePack: base,
      identityPack,
      certificate,
      eventPack: officialEventPack,
      deathPack
    });
    const result = applicationBarrel.runP3EPlaySessionCommand({ session, command: { ...ADVANCE } });
    expect(result.session.state.age).toBe(1);
  });
});

/* ================================================================== */
/* 六、H5-CTO-181-A：session 擁有 Ledger History                        */
/* ================================================================== */

function officialGenesisInput(): Dict {
  return {
    masterSeed: SEED,
    basePack: base,
    identityPack,
    certificate,
    eventPack: officialEventPack,
    deathPack
  };
}

describe("H5-CTO-181-A Session Ledger History", () => {
  it("genesis_history_empty_and_anchor_matches_state", () => {
    const session = officialSession();
    expect(session.ledgerHistory.records.length).toBe(0);
    expect(session.ledgerHistory.initial.stateHash).toBe(session.state.stateHash);
    expect(session.ledgerHistory.initial.commandHeadHash).toBe(session.state.commandLog.headHash);
    expect(session.ledgerHistory.initial.chainHash).toBe(session.state.heads.hashChain);
  });

  it("advance_appends_exactly_one_pair", () => {
    const before = officialSession();
    const result = runP3EPlaySessionCommand({ session: before, command: { ...ADVANCE } });
    expect(before.ledgerHistory.records.length).toBe(0);
    expect(result.session.ledgerHistory.records.length).toBe(1);
    const tail = result.session.ledgerHistory.records[0] as NonNullable<
      (typeof result.session.ledgerHistory.records)[number]
    >;
    expect(stable(tail.commandRecord)).toBe(stable(result.commandRecord));
    expect(stable(tail.yearRecord)).toBe(stable(result.yearRecord));
  });

  it("decision_choice_appends_exactly_one_pair", () => {
    const pending = game().sessions.find((session) => session.state.phase === "pending_decision");
    if (pending === undefined) throw new Error("no pending session");
    const optionId = pending.state.pendingDecision?.optionIds[0] as string;
    const beforeLength = pending.ledgerHistory.records.length;
    const result = runP3EPlaySessionCommand({
      session: pending,
      command: { type: "CHOOSE_DECISION", optionId }
    });
    expect(result.session.ledgerHistory.records.length).toBe(beforeLength + 1);
    const tail = result.session.ledgerHistory.records[result.session.ledgerHistory.records.length - 1] as NonNullable<
      (typeof result.session.ledgerHistory.records)[number]
    >;
    expect(tail.commandRecord.command).toEqual({ type: "CHOOSE_DECISION", optionId });
  });

  it("old_session_and_old_history_immutable", () => {
    const session = officialSession();
    const before = stable({ state: session.state, ledger: session.ledgerHistory });
    const result = runP3EPlaySessionCommand({ session, command: { ...ADVANCE } });
    expect(stable({ state: session.state, ledger: session.ledgerHistory })).toBe(before);
    expect(session.ledgerHistory.records.length).toBe(0);
    expect(result.session.ledgerHistory).not.toBe(session.ledgerHistory);
  });

  it("failure_has_no_partial_append", () => {
    const session = officialSession();
    const before = stable(session.ledgerHistory);
    expectP3EError(
      () =>
        runP3EPlaySessionCommand({
          session,
          command: { type: "CHOOSE_DECISION", optionId: "save" }
        }),
      "E_P3E_PHASE",
      "phase"
    );
    expect(stable(session.ledgerHistory)).toBe(before);
    expect(session.ledgerHistory.records.length).toBe(0);
    expect(session.state.commandLog.count).toBe(0);
  });

  it("every_step_count_equals_state_commandLog_count", () => {
    const sessions = game().sessions;
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.ledgerHistory.records.length).toBe(session.state.commandLog.count);
    }
  });

  it("every_step_tail_matches_state_hash_and_all_heads", () => {
    for (const session of game().sessions) {
      const records = session.ledgerHistory.records;
      if (records.length === 0) continue;
      const tail = records[records.length - 1] as NonNullable<(typeof records)[number]>;
      expect(tail.yearRecord.stateHashAfter).toBe(session.state.stateHash);
      expect(tail.commandRecord.commandHash).toBe(session.state.commandLog.headHash);
      expect(tail.yearRecord.chainHash).toBe(session.state.heads.hashChain);
      expect(tail.yearRecord.entryHash).toBe(session.state.heads.lastEntryHash);
      expect(tail.yearRecord.snapshotHash).toBe(session.state.heads.lastSnapshotHash);
      expect(tail.yearRecord.deltaHash).toBe(session.state.heads.lastDeltaHash);
    }
  });

  it("official_51_path_history_length_51_and_fixed_hashes", () => {
    const played = game();
    expect(played.commands).toBe(51);
    expect(played.finalSession.ledgerHistory.records.length).toBe(51);
    expect(played.finalSession.state.stateHash).toBe(
      "9418bd66908eed8abaae458ccf914af43cbca730eb0b9fb73937f9232480eb48"
    );
    expect(played.finalSession.state.commandLog.headHash).toBe(
      "cf0cc74720628ad5aa5fd367241b8b43b530802187ad2f5ff12a57a00b28b60f"
    );
    expect(played.finalSession.state.heads.hashChain).toBe(
      "75e557e08b2e27de0f78a533b1e30cd1ac5a4a57d0de0ee0494df4b2232bfc80"
    );
    expect(played.finalSession.state.heads.lastEntryHash).toBe(
      "18c5efcae5d83d6fc05302ea122a69d5032a6beccd75ca83f926ab8231369bb4"
    );
  });

  it("formal_replay_of_session_history_bit_exact_final_state", () => {
    const played = game();
    const replayed = replayP3ELedgerHistory({
      genesisInput: officialGenesisInput(),
      history: played.finalSession.ledgerHistory
    });
    expect(replayed.commandsConsumed).toBe(51);
    expect(stable(replayed.state)).toBe(stable(played.finalSession.state));
  });

  it("deep_frozen_and_no_mutable_sharing", () => {
    const result = runP3EPlaySessionCommand({ session: officialSession(), command: { ...ADVANCE } });
    expect(isDeepFrozen(result.session)).toBe(true);
    expect(isDeepFrozen(result.session.ledgerHistory)).toBe(true);
    const tail = result.session.ledgerHistory.records[0] as NonNullable<
      (typeof result.session.ledgerHistory.records)[number]
    >;
    expect(Object.isFrozen(tail)).toBe(true);
    expect(Object.isFrozen(tail.commandRecord)).toBe(true);
    expect(Object.isFrozen(tail.yearRecord)).toBe(true);
  });

  it("ledgerHistory_absent_from_view_and_UI_projection", () => {
    const session = game().finalSession;
    expect(Object.keys(session.view).sort()).toEqual([
      "age",
      "assets",
      "controls",
      "currentYear",
      "identity",
      "lastOutcome",
      "pendingDecision",
      "phase",
      "stats"
    ]);
    expect(Object.keys(session.view)).not.toContain("ledgerHistory");
    expect(JSON.stringify(session.view)).not.toContain("ledgerHistory");
    const uiSource = readFileSync(join(ROOT, "packages/ui/src/p3e-real-main.ts"), "utf8");
    expect(uiSource).not.toContain("ledgerHistory");
  });

  it("forged_or_cloned_session_still_rejected", () => {
    const session = officialSession();
    const fake = {
      state: session.state,
      ledgerHistory: session.ledgerHistory,
      lastOutcome: null,
      view: session.view
    };
    expectP3EError(
      () => runP3EPlaySessionCommand({ session: fake, command: { ...ADVANCE } }),
      "E_P3E_ARGUMENT",
      "p3eSession.session"
    );
    const cloned = structuredClone(session);
    expectP3EError(
      () => runP3EPlaySessionCommand({ session: cloned, command: { ...ADVANCE } }),
      "E_P3E_ARGUMENT",
      "p3eSession.session"
    );
  });

  it("minimal_simulation_barrel_surface_exact", () => {
    const functions = Object.entries(simulation)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual([
      "P3EError",
      "P3EReplayDivergenceError",
      "appendP3ELedgerHistory",
      "createP3EGenesis",
      "createP3ELedgerHistory",
      "decodeP3ESessionPayload",
      "encodeP3ESessionPayload",
      "executeP3ECommand",
      "isP3EError",
      "replayP3ELedgerHistory"
    ]);
  });

  it("read_remains_private_while_replay_is_public_since_2t", () => {
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface["readP3ELedgerHistory"]).toBeUndefined();
    expect(typeof surface["replayP3ELedgerHistory"]).toBe("function");
    expect(typeof surface["P3EReplayDivergenceError"]).toBe("function");
    const source = readFileSync(join(ROOT, "packages/simulation/src/index.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      " "
    );
    expect(source).toContain("./p3e-replay");
    expect(source).not.toContain("readP3ELedgerHistory");
  });

  it("browser_smoke_19_of_19_unchanged", () => {
    const smoke = readFileSync(join(ROOT, "scripts/p3e-browser-smoke.mjs"), "utf8");
    // check( 呼叫點 17 個；其中 viewport 那一項跑 3 個尺寸，執行期合計 19 項。
    const callSites = (smoke.match(/\bcheck\(/g) ?? []).length - 1;
    const viewportBlock = smoke.match(/for \(const viewport of \[([\s\S]*?)\]\)/);
    const viewports = viewportBlock === null ? 0 : ((viewportBlock[1] ?? "").match(/\{ width:/g) ?? []).length;
    expect(callSites).toBe(17);
    expect(viewports).toBe(3);
    expect(callSites - 1 + viewports).toBe(19);
    expect(smoke).toContain("9418bd66908eed8abaae458ccf914af43cbca730eb0b9fb73937f9232480eb48");
    expect(smoke).toContain("cf0cc74720628ad5aa5fd367241b8b43b530802187ad2f5ff12a57a00b28b60f");
    expect(smoke).toContain("run_to_death_with_51_commands");
  });

  it("mobile_history_size_and_command_perf_reported", () => {
    const played = game();
    const historyJson = JSON.stringify(played.finalSession.ledgerHistory);
    expect(historyJson.length).toBeLessThan(512 * 1024);
    const started = performance.now();
    let session = officialSession();
    for (let index = 0; index < 10; index += 1) {
      session = runP3EPlaySessionCommand({ session, command: nextCommand(session) }).session;
    }
    const elapsed = performance.now() - started;
    const perCommand = elapsed / 10;
    console.log(
      `P3E-HISTORY-PERF history_json_raw=${historyJson.length} commands=51 per_command_ms=${perCommand.toFixed(2)}`
    );
    expect(perCommand).toBeLessThan(200);
  });
});

/* ================================================================== */
/* 七、H5-CTO-183-A：Raw Session Persistence                            */
/* ================================================================== */


function restoreInput(payload: string, overrides: Dict = {}): Dict {
  const input: Dict = {
    payload,
    masterSeed: SEED,
    basePack: base,
    identityPack,
    certificate,
    eventPack: officialEventPack,
    deathPack
  };
  for (const key of Object.keys(overrides)) input[key] = overrides[key];
  return input;
}

function alternateCertificate(): unknown {
  const candidates = ["male", "female"].map((playerSexPolicy) =>
    createBirthCertificate(
      base,
      identityPack,
      buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy } as never),
      SEED
    )
  );
  const alternate = candidates.find(
    (candidate) => JSON.stringify(candidate) !== JSON.stringify(certificate)
  );
  if (alternate === undefined) throw new Error("no alternate certificate");
  return alternate;
}

describe("H5-CTO-183-A Raw Session Persistence", () => {
  it("empty_genesis_export_restore", () => {
    const session = officialSession();
    const payload = exportP3EPlaySessionPayload({ session });
    expect(typeof payload).toBe("string");
    const wire = JSON.parse(payload) as Dict;
    expect(Object.keys(wire).sort()).toEqual(["formatVersion", "history", "masterSeed", "state"]);
    expect(wire.formatVersion).toBe(6);

    const restored = restoreP3EPlaySessionPayload(restoreInput(payload));
    expect(restored.ledgerHistory.records.length).toBe(0);
    expect(stable(restored.state)).toBe(stable(session.state));
    expect(restored.lastOutcome).toBeNull();
    expect(exportP3EPlaySessionPayload({ session: restored })).toBe(payload);
  });

  it("life_phase_export_restore_continue", () => {
    const advanced = runP3EPlaySessionCommand({ session: officialSession(), command: { ...ADVANCE } }).session;
    const payload = exportP3EPlaySessionPayload({ session: advanced });
    const restored = restoreP3EPlaySessionPayload(restoreInput(payload));
    expect(stable(restored.state)).toBe(stable(advanced.state));
    expect(restored.state.commandLog.count).toBe(1);

    const continued = runP3EPlaySessionCommand({ session: restored, command: { ...ADVANCE } }).session;
    expect(continued.state.commandLog.count).toBe(2);
    expect(continued.ledgerHistory.records.length).toBe(2);
  });

  it("pending_decision_restore_has_same_option_labels_and_can_choose", () => {
    const pending = game().sessions.find((session) => session.state.phase === "pending_decision");
    if (pending === undefined) throw new Error("no pending session");
    const payload = exportP3EPlaySessionPayload({ session: pending });
    const restored = restoreP3EPlaySessionPayload(restoreInput(payload));

    expect(restored.state.phase).toBe("pending_decision");
    expect(stable(restored.view.pendingDecision)).toBe(stable(pending.view.pendingDecision));
    expect(stable(restored.lastOutcome)).toBe(stable(pending.lastOutcome));

    const optionId = restored.state.pendingDecision?.optionIds[0] as string;
    const chosen = runP3EPlaySessionCommand({
      session: restored,
      command: { type: "CHOOSE_DECISION", optionId }
    }).session;
    expect(chosen.state.phase).toBe("life");
  });

  it("death_phase_export_restore", () => {
    const final = game().finalSession;
    expect(final.state.phase).toBe("death");
    const payload = exportP3EPlaySessionPayload({ session: final });
    const restored = restoreP3EPlaySessionPayload(restoreInput(payload));
    expect(restored.state.phase).toBe("death");
    expect(stable(restored.state)).toBe(stable(final.state));
    expect(stable(restored.lastOutcome)).toBe(stable(final.lastOutcome));
  });

  it("official_51_export_restore_fixed_hashes", () => {
    const final = game().finalSession;
    const payload = exportP3EPlaySessionPayload({ session: final });
    const restored = restoreP3EPlaySessionPayload(restoreInput(payload));
    expect(restored.ledgerHistory.records.length).toBe(51);
    expect(restored.state.stateHash).toBe(
      "9418bd66908eed8abaae458ccf914af43cbca730eb0b9fb73937f9232480eb48"
    );
    expect(restored.state.commandLog.headHash).toBe(
      "cf0cc74720628ad5aa5fd367241b8b43b530802187ad2f5ff12a57a00b28b60f"
    );
    expect(restored.state.heads.hashChain).toBe(
      "75e557e08b2e27de0f78a533b1e30cd1ac5a4a57d0de0ee0494df4b2232bfc80"
    );
    expect(restored.state.heads.lastEntryHash).toBe(
      "18c5efcae5d83d6fc05302ea122a69d5032a6beccd75ca83f926ab8231369bb4"
    );
  });

  it("restored_session_is_branded_deep_frozen_and_reexport_byte_identical", () => {
    const final = game().finalSession;
    const payload = exportP3EPlaySessionPayload({ session: final });
    const restored = restoreP3EPlaySessionPayload(restoreInput(payload));
    expect(isDeepFrozen(restored)).toBe(true);
    expect(Object.keys(restored).sort()).toEqual(["lastOutcome", "ledgerHistory", "state", "view"]);
    expect(exportP3EPlaySessionPayload({ session: restored })).toBe(payload);

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
    expectP3EError(
      () => exportP3EPlaySessionPayload({ session: null }),
      "E_P3E_ARGUMENT",
      "p3eSession.session"
    );
  });

  it("wrong_seed_certificate_pack_and_tampered_payload_rejected", () => {
    const payload = exportP3EPlaySessionPayload({ session: game().finalSession });

    // 1. 錯 seed：payload 內 seed 與輸入不符 → 固定 application 錯誤路徑。
    expectP3EError(
      () => restoreP3EPlaySessionPayload(restoreInput(payload, { masterSeed: "p3e-other-seed" })),
      "E_P3E_ARGUMENT",
      "p3eSession.payload"
    );

    // 2. 錯 certificate：decode 成功，但 replay anchor 不一致 → replay 錯誤原樣外拋。
    let certificateError: unknown;
    try {
      restoreP3EPlaySessionPayload(restoreInput(payload, { certificate: alternateCertificate() }));
    } catch (error) {
      certificateError = error;
    }
    expect(isP3EError(certificateError)).toBe(true);
    expect((certificateError as P3EError).code).toBe("E_P3E_REPLAY");

    // 3. 錯 pack：genesis 驗證錯誤原樣外拋。
    let packError: unknown;
    try {
      restoreP3EPlaySessionPayload(restoreInput(payload, { basePack: identityPack }));
    } catch (error) {
      packError = error;
    }
    expect(isP3EError(packError)).toBe(true);

    // 4. 篡改 payload：codec 綁定失敗。
    const tampered = payload.replace("9418bd66", "9418bd67");
    expect(tampered).not.toBe(payload);
    let tamperedError: unknown;
    try {
      restoreP3EPlaySessionPayload(restoreInput(tampered));
    } catch (error) {
      tamperedError = error;
    }
    expect(isP3EError(tamperedError)).toBe(true);
    expect(["E_P3E_CODEC", "E_P3E_HASH"]).toContain((tamperedError as P3EError).code);

    // 5. 仍可 decode、但非 canonical 的 payload → 宣稱值與重編碼不一致（固定 application 路徑）。
    const nonCanonical = payload.replace('"state":', '"state": ');
    expect(nonCanonical).not.toBe(payload);
    expectP3EError(
      () => restoreP3EPlaySessionPayload(restoreInput(nonCanonical)),
      "E_P3E_ARGUMENT",
      "p3eSession.payload"
    );
  });

  it("decoded_self_consistent_but_non_authoritative_claim_rejected_by_replay", () => {
    const payload = exportP3EPlaySessionPayload({ session: game().finalSession });
    // codec 層面完全自洽：不需要 replay 就能 decode 成功。
    const decoded = simulation.decodeP3ESessionPayload(payload);
    expect(decoded.history.records.length).toBe(51);
    expect(typeof decoded.masterSeed).toBe("string");

    // 但換一個 certificate（genesis 不同）後，權威路徑拒絕這個宣稱。
    let failure: unknown;
    try {
      restoreP3EPlaySessionPayload(restoreInput(payload, { certificate: alternateCertificate() }));
    } catch (error) {
      failure = error;
    }
    expect(isP3EError(failure)).toBe(true);
    expect((failure as P3EError).code).toBe("E_P3E_REPLAY");
    expect((failure as P3EError).path).toContain("p3eReplay.initial");
  });

  it("lastOutcome_null_empty_and_exact_for_nonempty", () => {
    const genesisReplay = replayP3ELedgerHistory({
      genesisInput: officialGenesisInput(),
      history: officialSession().ledgerHistory
    });
    expect(genesisReplay.lastOutcome).toBeNull();
    expect(genesisReplay.commandsConsumed).toBe(0);

    const finalReplay = replayP3ELedgerHistory({
      genesisInput: officialGenesisInput(),
      history: game().finalSession.ledgerHistory
    });
    expect(finalReplay.lastOutcome).not.toBeNull();
    expect(stable(finalReplay.lastOutcome)).toBe(stable(game().finalSession.lastOutcome));
    expect(isDeepFrozen(finalReplay.lastOutcome)).toBe(true);
  });

  it("input_getters_and_proxy_traps_never_execute_or_leak_native_errors", () => {
    let executed = 0;
    const trapInput = {
      get payload() {
        executed += 1;
        return "x";
      },
      get masterSeed() {
        executed += 1;
        return SEED;
      },
      basePack: base,
      identityPack,
      certificate,
      eventPack: officialEventPack,
      deathPack
    };
    expectP3EError(
      () => restoreP3EPlaySessionPayload(trapInput),
      "E_P3E_ARGUMENT",
      "p3eSession.input"
    );
    expect(executed).toBe(0);

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
      () => restoreP3EPlaySessionPayload(evil),
      "E_P3E_ARGUMENT",
      "p3eSession.input"
    );
    expectP3EError(
      () => exportP3EPlaySessionPayload(evil),
      "E_P3E_ARGUMENT",
      "p3eSession.input"
    );
  });

  it("payload_and_packs_absent_from_view_and_DOM", () => {
    const session = game().finalSession;
    for (const key of Object.keys(session)) {
      expect(["state", "ledgerHistory", "lastOutcome", "view"]).toContain(key);
    }
    expect(Object.keys(session.view)).not.toContain("ledgerHistory");
    expect(JSON.stringify(session.view)).not.toContain("payload");
    for (const packKey of ["basePack", "identityPack", "eventPack", "deathPack"]) {
      expect(Object.prototype.hasOwnProperty.call(session, packKey)).toBe(false);
    }

    const uiSource = readFileSync(join(ROOT, "packages/ui/src/p3e-real-main.ts"), "utf8");
    expect(uiSource).not.toContain("exportP3EPlaySessionPayload");
    expect(uiSource).not.toContain("restoreP3EPlaySessionPayload");
    expect(uiSource).not.toContain("ledgerHistory");
  });

  it("browser_smoke_19_of_19_unchanged", () => {
    const smoke = readFileSync(join(ROOT, "scripts/p3e-browser-smoke.mjs"), "utf8");
    const callSites = (smoke.match(/\bcheck\(/g) ?? []).length - 1;
    const viewportBlock = smoke.match(/for \(const viewport of \[([\s\S]*?)\]\)/);
    const viewports = viewportBlock === null ? 0 : ((viewportBlock[1] ?? "").match(/\{ width:/g) ?? []).length;
    expect(callSites).toBe(17);
    expect(viewports).toBe(3);
    expect(callSites - 1 + viewports).toBe(19);
    expect(smoke).toContain("9418bd66908eed8abaae458ccf914af43cbca730eb0b9fb73937f9232480eb48");
    expect(smoke).toContain("cf0cc74720628ad5aa5fd367241b8b43b530802187ad2f5ff12a57a00b28b60f");
  });
});
