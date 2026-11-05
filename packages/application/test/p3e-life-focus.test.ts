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
import {
  P3E_LIFE_FOCUS_FIRST_AGE,
  P3E_LIFE_FOCUS_IDS,
  P3E_LIFE_FOCUS_OPTIONS,
  applyP3ELifeFocusAnnualStats,
  p3eLifeFocusEventIds,
  p3eLifeFocusLabel,
  readP3ELifeFocus,
  replaceP3ELifeFocusFlag,
  type P3ELifeFocusId
} from "@life-sim/contracts";
import {
  createP3EPlaySession,
  exportP3EPlaySessionPayload,
  restoreP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";

/**
 * GPT-0029-B｜人生重心回歸測試。
 *
 * 全部走正式 application／simulation 入口，不碰 UI、不碰 localStorage。
 * 期望值一律由正式原語或另一條獨立路徑算出，不拿待測物自己當答案。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

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

function step(session: P3EPlaySession, command: unknown): P3EPlaySession {
  return runP3EPlaySessionCommand({ session, command }).session;
}

/** 推進到下一個可操作狀態（遇決策選第一個選項）。 */
function advanceOneYear(session: P3EPlaySession): P3EPlaySession {
  if (session.state.phase === "pending_decision") {
    const optionId = session.state.pendingDecision?.optionIds[0] as string;
    return step(session, { type: "CHOOSE_DECISION", optionId });
  }
  return step(session, ADVANCE);
}

function atAge(target: number): P3EPlaySession {
  let session = officialSession();
  while (session.state.age < target && session.state.phase !== "death") {
    session = advanceOneYear(session);
  }
  return session;
}

function restoreSession(session: P3EPlaySession): P3EPlaySession {
  return restoreP3EPlaySessionPayload({
    payload: exportP3EPlaySessionPayload({ session }),
    masterSeed: SEED,
    basePack: base,
    identityPack,
    certificate,
    eventPack: officialEventPack,
    deathPack
  });
}

function expectErrorCode(run: () => unknown, code: string, path: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { code?: string }).code).toBe(code);
  expect((caught as { path?: string }).path).toBe(path);
}

/* ================================================================== */
/* 一、契約純函式                                                       */
/* ================================================================== */

describe("GPT-0029-B 人生重心契約", () => {
  it("五種重心、標籤與取捨", () => {
    expect(P3E_LIFE_FOCUS_IDS).toEqual(["study", "growth", "family", "hobby", "health"]);
    expect(P3E_LIFE_FOCUS_OPTIONS).toHaveLength(5);
    expect(P3E_LIFE_FOCUS_FIRST_AGE).toBe(7);
    expect(p3eLifeFocusLabel("study", 7)).toBe("學業");
    expect(p3eLifeFocusLabel("study", 18)).toBe("工作");
    expect(p3eLifeFocusLabel("family", 18)).toBe("家庭");
    for (const option of P3E_LIFE_FOCUS_OPTIONS) {
      const values = Object.values(option.annualStatDelta);
      expect(values.some((delta) => delta > 0), `${option.focusId} 要有加分`).toBe(true);
      expect(values.some((delta) => delta < 0), `${option.focusId} 要有取捨`).toBe(true);
      expect(values.every((delta) => Math.abs(delta) <= 2)).toBe(true);
      expect(option.summary.length).toBeGreaterThan(6);
    }
  });

  it("focus flag 編解碼、嚴格升冪、舊存檔無 flag 視為未設定", () => {
    expect(readP3ELifeFocus([])).toBeNull();
    expect(readP3ELifeFocus(["edu:university", "hobby:painting"])).toBeNull();
    const flags = replaceP3ELifeFocusFlag(["edu:university", "hobby:painting"], "study", 2032);
    expect(flags).toEqual(["edu:university", "focus:study:2032", "hobby:painting"]);
    expect(flags.every((flag, index) => index === 0 || flags[index - 1]! < flag)).toBe(true);
    expect(readP3ELifeFocus(flags)).toEqual({ focusId: "study", changedYear: 2032 });
    const changed = replaceP3ELifeFocusFlag(flags, "health", 2033);
    expect(readP3ELifeFocus(changed)).toEqual({ focusId: "health", changedYear: 2033 });
    expect(changed.filter((flag) => flag.startsWith("focus:"))).toHaveLength(1);
    expect(readP3ELifeFocus(["focus:bad-id:2032"])).toBeNull();
  });

  it("年度效果套用後仍落在 0..100，且五種效果各不相同", () => {
    const baseStats = { health: 50, happiness: 50, knowledge: 50, relationships: 50 };
    const results = P3E_LIFE_FOCUS_IDS.map((id) => JSON.stringify(applyP3ELifeFocusAnnualStats(baseStats, id)));
    expect(new Set(results).size).toBe(5);
    expect(applyP3ELifeFocusAnnualStats({ health: 100, happiness: 0, knowledge: 0, relationships: 100 }, "health"))
      .toEqual({ health: 100, happiness: 0, knowledge: 0, relationships: 100 });
  });

  it("五種重心的相符事件集合各不相同，且都至少命中一個事件", () => {
    const allIds = (readJson("fixtures/p3b/events.v1.json") as { records: { eventId: string }[] })
      .records.map((record) => record.eventId);
    const sets = P3E_LIFE_FOCUS_IDS.map((id) => p3eLifeFocusEventIds(id, allIds));
    for (const set of sets) expect(set.length).toBeGreaterThan(0);
    expect(new Set(sets.map((set) => set.join(","))).size).toBe(5);
  });
});

/* ================================================================== */
/* 二、正式 command / state hash / replay                               */
/* ================================================================== */

describe("GPT-0029-B SET_LIFE_FOCUS 正式命令鏈", () => {
  it("0–6 歲拒絕設定；7 歲可設定且不推進年度／不消耗 RNG", () => {
    expectErrorCode(
      () => step(atAge(6), { type: "SET_LIFE_FOCUS", focusId: "study" }),
      "E_P3E_COMMAND",
      "commandExecution.lifeFocus.age"
    );
    const seven = atAge(7);
    const before = {
      age: seven.state.age,
      year: seven.state.currentYear,
      phase: seven.state.phase,
      rng: JSON.stringify(seven.state.rng),
      stats: JSON.stringify(seven.state.stats),
      count: seven.state.commandLog.count
    };
    const after = step(seven, { type: "SET_LIFE_FOCUS", focusId: "study" });
    expect(after.state.age).toBe(before.age);
    expect(after.state.currentYear).toBe(before.year);
    expect(after.state.phase).toBe(before.phase);
    expect(JSON.stringify(after.state.rng)).toBe(before.rng);
    expect(JSON.stringify(after.state.stats)).toBe(before.stats);
    expect(after.state.commandLog.count).toBe(before.count + 1);
    expect(readP3ELifeFocus(after.state.flags)).toEqual({
      focusId: "study",
      changedYear: before.year
    });
    expect(after.state.stateHash).not.toBe(seven.state.stateHash);
    expect(after.lastOutcome?.kind).toBe("set_life_focus");
  });

  it("同年至多更改一次，跨年可再更改", () => {
    const seven = atAge(7);
    const first = step(seven, { type: "SET_LIFE_FOCUS", focusId: "study" });
    expectErrorCode(
      () => step(first, { type: "SET_LIFE_FOCUS", focusId: "health" }),
      "E_P3E_COMMAND",
      "commandExecution.lifeFocus.yearLimit"
    );
    const nextYear = advanceOneYear(first);
    const changed = step(nextYear, { type: "SET_LIFE_FOCUS", focusId: "health" });
    expect(readP3ELifeFocus(changed.state.flags)?.focusId).toBe("health");
    expect(readP3ELifeFocus(changed.state.flags)?.changedYear).toBe(nextYear.state.currentYear);
  });

  it("非法 focusId、死亡後設定、待決策時設定都被拒絕", () => {
    expectErrorCode(
      () => step(atAge(7), { type: "SET_LIFE_FOCUS", focusId: "nope" }),
      "E_P3E_COMMAND",
      "command.focusId"
    );
    let session = atAge(7);
    for (let index = 0; index < 8 && session.state.phase !== "pending_decision"; index += 1) {
      session = advanceOneYear(session);
    }
    if (session.state.phase === "pending_decision") {
      expectErrorCode(
        () => step(session, { type: "SET_LIFE_FOCUS", focusId: "family" }),
        "E_P3E_PHASE",
        "commandExecution.lifeFocus.phase"
      );
    }
  });

  it("存檔／還原後重心仍在，且 replay 逐位元一致", () => {
    const seven = step(atAge(7), { type: "SET_LIFE_FOCUS", focusId: "family" });
    const restored = restoreSession(seven);
    expect(restored.state.stateHash).toBe(seven.state.stateHash);
    expect(readP3ELifeFocus(restored.state.flags)).toEqual(readP3ELifeFocus(seven.state.flags));
    expect(restored.state.commandLog.count).toBe(seven.state.commandLog.count);
    expect(restored.ledgerHistory.records.length).toBe(seven.ledgerHistory.records.length);
  });

  it("無 focus 的舊存檔仍是合法 state（舊存檔遷移不毀檔）", () => {
    const legacy = atAge(9);
    expect(readP3ELifeFocus(legacy.state.flags)).toBeNull();
    const restored = restoreSession(legacy);
    expect(restored.state.stateHash).toBe(legacy.state.stateHash);
    // 舊存檔在下一次符合年齡時仍可設定重心
    const upgraded = step(restored, { type: "SET_LIFE_FOCUS", focusId: "hobby" });
    expect(readP3ELifeFocus(upgraded.state.flags)?.focusId).toBe("hobby");
  });

  it("既有黃金路徑（完全沒有重心指令）不受影響", () => {
    let session = officialSession();
    while (session.state.phase !== "death") session = advanceOneYear(session);
    expect(readP3ELifeFocus(session.state.flags)).toBeNull();
    expect(session.state.commandLog.count).toBeGreaterThan(50);
    expect(session.state.phase).toBe("death");
  });
});

/* ================================================================== */
/* 三、五種重心各跑 30 年：結果有差異、相同 seed 可重播                */
/* ================================================================== */

function playFocusForYears(focusId: P3ELifeFocusId, years: number): P3EPlaySession {
  let session = officialSession();
  while (session.state.age < P3E_LIFE_FOCUS_FIRST_AGE) session = advanceOneYear(session);
  session = step(session, { type: "SET_LIFE_FOCUS", focusId });
  const startAge = session.state.age;
  while (session.state.age < startAge + years && session.state.phase !== "death") {
    session = advanceOneYear(session);
  }
  return session;
}

describe("GPT-0029-B 重心真實效果與決定性", () => {
  // GPT-0029-A：死亡曲線變長後，同樣 30 年會累積更多 pending decision／command
  // （單檔實測約 12 秒）；平行跑滿 101 個測試檔時會超過預設 30 秒，因此只放寬這一項的逾時。
  it("五種重心各跑 30 年：stats／state hash 各異，且都可重播", { timeout: 120_000 }, () => {
    const runs = P3E_LIFE_FOCUS_IDS.map((id) => {
      const first = playFocusForYears(id, 30);
      const replay = playFocusForYears(id, 30);
      expect(replay.state.stateHash, `${id} 同 seed 重播`).toBe(first.state.stateHash);
      expect(replay.state.commandLog.headHash, `${id} command head 重播`).toBe(first.state.commandLog.headHash);
      const restored = restoreSession(first);
      expect(restored.state.stateHash, `${id} 存檔還原`).toBe(first.state.stateHash);
      return {
        id,
        hash: first.state.stateHash,
        stats: JSON.stringify(first.state.stats),
        flags: first.state.flags.join(","),
        commands: first.state.commandLog.count,
        age: first.state.age
      };
    });
    expect(new Set(runs.map((run) => run.hash)).size).toBe(5);
    expect(new Set(runs.map((run) => run.stats)).size).toBeGreaterThanOrEqual(4);
    for (const run of runs) {
      expect(run.flags).toContain(`focus:${run.id}:`);
      expect(readP3ELifeFocus(run.flags.split(","))?.focusId).toBe(run.id);
    }
    // 五種都真的跑到 30 年（沒有中途死亡或被卡住）
    for (const run of runs) expect(run.age).toBeGreaterThanOrEqual(P3E_LIFE_FOCUS_FIRST_AGE + 30);
  });

  it("重心影響事件抽選：與無重心的同年路徑選到不同事件", () => {
    const plain = officialSession();
    let plainSession = plain;
    while (plainSession.state.age < P3E_LIFE_FOCUS_FIRST_AGE) plainSession = advanceOneYear(plainSession);
    const focused = step(plainSession, { type: "SET_LIFE_FOCUS", focusId: "study" });
    let plainNext = plainSession;
    let focusNext = focused;
    const plainEvents: string[] = [];
    const focusEvents: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      plainNext = advanceOneYear(plainNext);
      focusNext = advanceOneYear(focusNext);
      const p = plainNext.lastOutcome;
      const f = focusNext.lastOutcome;
      if (p?.kind === "advance_year" && p.selectedEventId !== null) plainEvents.push(p.selectedEventId);
      if (f?.kind === "advance_year" && f.selectedEventId !== null) focusEvents.push(f.selectedEventId);
    }
    expect(plainEvents.length).toBeGreaterThan(0);
    expect(focusEvents.length).toBeGreaterThan(0);
    expect(plainEvents.join("|")).not.toBe(focusEvents.join("|"));
  });
});
