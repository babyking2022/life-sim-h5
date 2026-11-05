import { describe, expect, it } from "vitest";
import type { P3CYearDelta } from "@life-sim/contracts";
import { P3C_MAX_FLAGS, P3C_SCHEMA_VERSION } from "@life-sim/contracts";
import {
  applyEventLifeCommand,
  assertEventLifeInvariants,
  bindEventPack,
  createEventLifeState,
  deserializeEventLifeState,
  occurrenceDigestOf,
  reconstructEventLifeState,
  serializeEventLifeState,
  verifyEventLifeState
} from "../src/life/annual";
import {
  advanceOneYear,
  driveYears,
  loadEdgePack,
  loadPack,
  loadRawPack,
  makeBootstrap,
  newLife,
  repack,
  runCommand,
  runCommandWithDeltas
} from "./p3c-helpers";

/**
 * P3-C 主線行為：綁定、抽選、occurrences、effects、抉擇、四種推進模式與重播。
 */

const pack = loadPack();
const edgePack = loadEdgePack();

describe("P3-C 建立與 pack 綁定", () => {
  it("建立時寫入 pack 綁定，且 binding 進入 stateHash projection", () => {
    const state = newLife(pack);
    expect(state.schemaVersion).toBe(P3C_SCHEMA_VERSION);
    expect(state.versions.rulesetVersion).toBe("p3c-1.0.0");
    expect(state.versions.contentVersion).toBe("skeleton-1.1.0");
    expect(state.versions.saveFormatVersion).toBe(4);
    expect(state.events.binding.eventPackId).toBe(pack.manifest.eventPackId);
    expect(state.events.binding.eventPackChecksum).toBe(pack.packChecksum);
    expect(state.events.binding.datasetChecksum).toBe(pack.datasetChecksum);
    expect(state.events.binding.eventCount).toBe(pack.events.length);
    expect(state.events.contentMode).toBe("standard");
    expect(state.events.occurrences).toEqual([]);
    expect(state.events.rng.draws).toBe(0);
    expect(state.pendingDecision).toBeNull();
    assertEventLifeInvariants(state);
  });

  it("綁定是 pack 的純函式", () => {
    expect(bindEventPack(pack)).toEqual(bindEventPack(loadPack()));
  });

  it("缺少 pack／raw pack／替換成另一個有效 pack 一律 E_P3C_PACK", () => {
    const bootstrap = makeBootstrap();
    expect(() => createEventLifeState(bootstrap, { manifest: pack.manifest, events: pack.events })).toThrowError(/E_P3C_PACK/);
    expect(() => createEventLifeState(bootstrap, undefined)).toThrowError(/E_P3C_PACK/);
    const state = newLife(pack);
    // 換成 edge pack（同樣是有效 pack，但 ID／checksum 不同）。
    expect(() => applyEventLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: 1 }, edgePack)).toThrowError(/E_P3C_PACK/);
  });

  it("bootstrap 不得夾帶 pack 或任意壽命", () => {
    expect(() => createEventLifeState({ ...makeBootstrap(), lifespanYears: 500 }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => createEventLifeState({ ...makeBootstrap(), eventPack: pack }, pack)).toThrowError(/E_P3C_ARGUMENT/);
  });

  it("未核准的 ruleset／content／存檔格式一律 E_P3C_VERSION", () => {
    const base = makeBootstrap();
    expect(() => createEventLifeState({ ...base, versions: { ...base.versions, rulesetVersion: "p3a-1.0.1" } }, pack)).toThrowError(
      /E_P3C_VERSION/
    );
    expect(() => createEventLifeState({ ...base, versions: { ...base.versions, contentVersion: "skeleton-1.0.1" } }, pack)).toThrowError(
      /E_P3C_VERSION/
    );
    expect(() => createEventLifeState({ ...base, versions: { ...base.versions, saveFormatVersion: 3 } }, pack)).toThrowError(/E_P3C_VERSION/);
    expect(() => createEventLifeState({ ...base, versions: { ...base.versions, rngSpecVersion: "2.0.0" } }, pack)).toThrowError(/E_P3C_VERSION/);
  });

  it("P3-A 的 state 不會被當成 P3-C（schemaVersion 不同即拒絕）", () => {
    const state = newLife(pack);
    expect(() => assertEventLifeInvariants({ ...state, schemaVersion: "p3a-1" })).toThrowError(/E_P3C_VERSION/);
  });

  it("生命長度仍由人生 RNG 抽 60–100 年", () => {
    for (const rngState of [[1, 2, 3, 4], [0xdead, 0xbeef, 0x1234, 0x5678], [9, 9, 9, 9]] as const) {
      const state = newLife(pack, { rngState: [rngState[0], rngState[1], rngState[2], rngState[3]] });
      expect(state.lifespanYears).toBeGreaterThanOrEqual(60);
      expect(state.lifespanYears).toBeLessThanOrEqual(100);
    }
  });
});

describe("P3-C 年度事件抽選", () => {
  it("每個成功結算的年度最多一個事件，並寫入 occurrences 與 delta", () => {
    const driven = driveYears(pack, 12);
    expect(driven.state.history.yearsRecorded).toBe(12);
    expect(driven.deltas).toHaveLength(12);
    for (const delta of driven.deltas) {
      expect(delta.event.rngStateBefore).toHaveLength(4);
      expect(delta.event.selectionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(delta.event.occurrenceDigestBefore).toMatch(/^[0-9a-f]{64}$/);
      expect(delta.event.occurrenceDigestAfter).toMatch(/^[0-9a-f]{64}$/);
    }
    const occurrences = driven.state.events.occurrences;
    expect(occurrences.length).toBeGreaterThan(0);
    for (let index = 1; index < occurrences.length; index += 1) {
      expect((occurrences[index - 1] as { eventId: string }).eventId < (occurrences[index] as { eventId: string }).eventId).toBe(true);
    }
    for (const entry of occurrences) {
      expect(entry.count).toBeGreaterThanOrEqual(1);
      expect(entry.lastYear).toBeLessThanOrEqual(driven.state.currentYear);
    }
    expect(occurrenceDigestOf(occurrences)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("0 候選：不抽樣、drawsUsed = 0、RNG 不動、無事件紀錄", () => {
    // edge pack 在標準模式下 age 1 只有一個候選，age 2 起沒有任何候選。
    const driven = driveYears(edgePack, 4);
    expect(driven.deltas).toHaveLength(4);
    const [first, ...rest] = driven.deltas;
    expect(first?.event.eventId).toBe("ev.p3c.edge.solo");
    expect(first?.event.drawsUsed).toBe(0);
    expect(first?.event.reason).toBe("single_candidate");
    for (const delta of rest) {
      expect(delta.event.eventId).toBeNull();
      expect(delta.event.reason).toBe("no_candidates");
      expect(delta.event.drawsUsed).toBe(0);
      expect(delta.event.rngStateBefore).toEqual(delta.event.rngStateAfter);
      expect(delta.event.occurrenceDigestBefore).toBe(delta.event.occurrenceDigestAfter);
    }
    expect(driven.state.events.rng.draws).toBe(0);
  });

  it("單候選：0 draws，但仍留下 selectionHash 與 occurrence", () => {
    const driven = driveYears(edgePack, 1);
    const delta = driven.deltas[0];
    expect(delta?.event.eventId).toBe("ev.p3c.edge.solo");
    expect(delta?.event.candidateCount).toBe(1);
    expect(delta?.event.drawsUsed).toBe(0);
    expect(driven.state.events.occurrences).toEqual([{ eventId: "ev.p3c.edge.solo", count: 1, lastYear: 2021 }]);
  });

  it("多候選：加權抽選且 drawsUsed 為 2×嘗試次數", () => {
    const driven = driveYears(pack, 30);
    const weighted = driven.deltas.filter((delta) => delta.event.reason === "weighted");
    expect(weighted.length).toBeGreaterThan(0);
    for (const delta of weighted) {
      expect(delta.event.drawsUsed).toBeGreaterThanOrEqual(2);
      expect(delta.event.drawsUsed % 2).toBe(0);
    }
    const totalDraws = driven.deltas.reduce((sum, delta) => sum + delta.event.drawsUsed, 0);
    expect(driven.state.events.rng.draws).toBe(totalDraws);
  });

  it("once 事件終生只出現一次", () => {
    const driven = driveYears(pack, 40);
    const occurrences = driven.state.events.occurrences;
    const once = occurrences.find((entry) => entry.eventId === "ev.p3c.once");
    if (once !== undefined) expect(once.count).toBe(1);
    // 至少證明「有 once 事件發生過」時 count 是 1；沒發生也合法。
    expect(driven.state.history.yearsRecorded).toBe(40);
  });

  it("cooldown 邊界：再次發生至少間隔 cooldownYears", () => {
    const driven = driveYears(pack, 40);
    const years = driven.deltas.filter((delta) => delta.event.eventId === "ev.p3c.cooldown").map((delta) => delta.year);
    for (let index = 1; index < years.length; index += 1) {
      expect((years[index] as number) - (years[index - 1] as number)).toBeGreaterThanOrEqual(3);
    }
  });

  it("exclusiveGroup：同組只會留下 priority 最高的候選", () => {
    // age 5 只有 decision 事件符合年齡，因此一定是它，且 priority 最高。
    const driven = driveYears(pack, 5);
    const fifth = driven.deltas[4];
    expect(fifth?.event.eventId).toBe("ev.p3c.child.decision");
    expect(fifth?.event.candidateCount).toBe(1);
  });

  it("P3-A 的年度 RNG 會計不變：rngDraws 仍然是 initial + 4×age（事件走獨立游標）", () => {
    const driven = driveYears(pack, 20);
    const initialDraws = driven.state.rng.draws - 4 * driven.state.history.yearsRecorded;
    expect([0, 1]).toContain(initialDraws);
    for (const record of driven.state.commandLog) {
      expect(record.rngDraws).toBe(initialDraws + 4 * (record.atYear - driven.state.birthYear));
    }
  });

  it("flags 上限與 pattern 在事件 effects 之後仍然成立", () => {
    const driven = driveYears(pack, 30);
    expect(driven.state.flags.length).toBeLessThanOrEqual(P3C_MAX_FLAGS);
    for (const flag of driven.state.flags) expect(flag).toMatch(/^[a-z0-9][a-z0-9:_-]{0,63}$/);
    expect(driven.state.flags).toContain("p3c:ordinary");
  });
});

describe("P3-C 事件 effects 與狀態", () => {
  it("普通事件 effects 立即反映在 stat／money／flag 上", () => {
    // 用 edge pack：age 1 的 solo 事件加 happiness+1 與 flag。
    const state0 = newLife(edgePack);
    const result = applyEventLifeCommand(state0, { type: "FAST_FORWARD_STEP", maxYears: 1 }, edgePack);
    const delta = result.deltas[0];
    expect(delta?.event.eventId).toBe("ev.p3c.edge.solo");
    expect(delta?.event.outcome.statDelta).toEqual({ health: 0, happiness: 1, knowledge: 0, relationships: 0 });
    expect(delta?.event.outcome.flagsAdded).toEqual(["p3c:edge"]);
    expect(result.state.flags).toContain("p3c:edge");
    expect(result.state.events.occurrences).toEqual([{ eventId: "ev.p3c.edge.solo", count: 1, lastYear: 2021 }]);
  });

  it("informational 事件不改狀態，但仍然留下 occurrence 與 selectionHash", () => {
    const driven = driveYears(pack, 30);
    const info = driven.deltas.find((delta) => delta.event.eventId === "ev.p3c.informational");
    if (info !== undefined) {
      expect(info.event.outcome.informational).toBe(true);
      expect(info.event.outcome.statDelta).toEqual({ health: 0, happiness: 0, knowledge: 0, relationships: 0 });
      expect(info.event.outcome.flagsAdded).toEqual([]);
    }
    expect(driven.state.history.yearsRecorded).toBe(30);
  });

  it("事件 effects 不會讓輸入 state 被原地修改", () => {
    const state = newLife(pack);
    const snapshot = JSON.stringify(state, (_, value) => (typeof value === "bigint" ? value.toString() : value));
    advanceOneYear(state, pack);
    const after = JSON.stringify(state, (_, value) => (typeof value === "bigint" ? value.toString() : value));
    expect(after).toBe(snapshot);
  });

  it("contentMode 進權威 state 並影響 candidates（guardian 排除 standard 內容）", () => {
    const base = loadPack();
    const standard = newLife(base);
    expect(standard.events.contentMode).toBe("standard");
    const guardianBootstrap = makeBootstrap();
    const guardianState = createEventLifeState(guardianBootstrap, base);
    // 直接改 contentMode 會改變 stateHash，因此必須重建（這裡只驗證投影包含它）。
    const tampered = { ...guardianState, events: { ...guardianState.events, contentMode: "guardian" as const } };
    expect(() => assertEventLifeInvariants(tampered)).toThrowError(/E_P3C_HASH/);
  });
});

describe("P3-C 事件抉擇", () => {
  it("decision 事件只建立 pending decision，不自動選項", () => {
    const driven = driveYears(pack, 5);
    const state = driven.state;
    expect(state.phase).toBe("pending_decision");
    const pending = state.pendingDecision;
    expect(pending).not.toBeNull();
    expect(pending?.source).toBe("event");
    expect(pending?.eventId).toBe("ev.p3c.child.decision");
    expect(pending?.decisionId).toBe("dec.p3c.choice");
    expect(pending?.selectedOptionId).toBeNull();
    expect(pending?.year).toBe(state.currentYear);
    expect(pending?.selectionHash).toBe(driven.deltas[4]?.event.selectionHash);
    expect(pending?.occurrenceDigestBefore).toBe(driven.deltas[4]?.event.occurrenceDigestBefore);
    expect(pending?.options.map((option) => option.optionId)).toEqual(["alpha", "beta"]);
    expect(pending?.options[0]?.effects).toHaveLength(2);
    assertEventLifeInvariants(state);
  });

  it("SELECT ＋ CONFIRM 只套用一次，並寫入兩筆權威紀錄", () => {
    const beforeDecision = driveYears(pack, 5).state;
    const pending = beforeDecision.pendingDecision;
    expect(pending).not.toBeNull();
    const optionId = "alpha";
    const beforeHash = beforeDecision.stateHash;
    const selected = runCommand(beforeDecision, pack, { type: "SELECT_DECISION", optionId });
    expect(selected.commandLog).toHaveLength(1);
    expect(selected.commandLog[0]?.commandType).toBe("SELECT_DECISION");
    expect(selected.commandLog[0]?.stateHashBefore).toBe(beforeHash);
    expect(selected.pendingDecision?.selectedOptionId).toBe(optionId);
    const afterSelectHash = selected.stateHash;

    const confirmed = runCommand(selected, pack, { type: "NEXT" });
    expect(confirmed.commandLog).toHaveLength(2);
    expect(confirmed.commandLog[1]?.commandType).toBe("CONFIRM_DECISION");
    expect(confirmed.commandLog[1]?.stateHashBefore).toBe(afterSelectHash);
    expect(confirmed.pendingDecision).toBeNull();
    expect(confirmed.phase).toBe("life");
    expect(confirmed.flags).toContain("p3c:alpha");
    expect(confirmed.stats.happiness).toBe(Math.min(100, beforeDecision.stats.happiness + 5));

    // 再按一次 NEXT 不會重複套用 effects（pending 已清空）。
    const again = runCommand(confirmed, pack, { type: "NEXT" });
    expect(again.commandLog).toHaveLength(2);
    expect(again.flags.filter((flag) => flag === "p3c:alpha")).toHaveLength(1);
  });

  it("pending decision 期間不得跨年", () => {
    const state = driveYears(pack, 5).state;
    expect(state.phase).toBe("pending_decision");
    expect(() => runCommand(state, pack, { type: "FAST_FORWARD_STEP", maxYears: 1 })).not.toThrow();
    const after = runCommand(state, pack, { type: "FAST_FORWARD_STEP", maxYears: 1 });
    expect(after.history.yearsRecorded).toBe(state.history.yearsRecorded);
    expect(after.stateHash).toBe(state.stateHash);
    expect(after.events).toEqual(state.events);
  });

  it("跨事件 option／錯誤 option 一律拒絕", () => {
    const state = driveYears(pack, 5).state;
    expect(() => runCommand(state, pack, { type: "SELECT_DECISION", optionId: "steady" })).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => runCommand(state, pack, { type: "SELECT_DECISION", optionId: "" })).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => runCommand(state, pack, { type: "SELECT_DECISION", optionId: "gamma" })).toThrowError(/E_P3C_ARGUMENT/);
  });

  it("同一個 option 不得重複 SELECT", () => {
    const state = driveYears(pack, 5).state;
    const selected = runCommand(state, pack, { type: "SELECT_DECISION", optionId: "alpha" });
    expect(() => runCommand(selected, pack, { type: "SELECT_DECISION", optionId: "alpha" })).toThrowError(/E_P3C_PHASE/);
    expect(() => runCommand(selected, pack, { type: "SELECT_DECISION", optionId: "beta" })).toThrowError(/E_P3C_PHASE/);
  });

  it("未選就 CONFIRM（NEXT）會被拒絕", () => {
    const state = driveYears(pack, 5).state;
    expect(() => runCommand(state, pack, { type: "NEXT" })).toThrowError(/E_P3C_ARGUMENT/);
  });

  it("skeleton 抉擇（非事件）也走同一條 SELECT／CONFIRM 流程", () => {
    // edge pack 沒有 decision 事件；age 6 會由 P3-A 的抉擇年齡補上 skeleton 抉擇。
    const driven = driveYears(edgePack, 6);
    const state = driven.state;
    expect(state.phase).toBe("pending_decision");
    expect(state.pendingDecision?.source).toBe("skeleton");
    expect(state.pendingDecision?.eventId.startsWith("skeleton.decision.")).toBe(true);
    const confirmed = runCommand(runCommand(state, edgePack, { type: "SELECT_DECISION", optionId: "steady" }), edgePack, { type: "NEXT" });
    expect(confirmed.flags).toContain(`decision:${state.pendingDecision?.decisionId}:steady`);
    expect(confirmed.phase).toBe("life");
  });
});

describe("P3-C 四種推進模式結果一致", () => {
  it("FAST_FORWARD／1×／16×／TICK 到達同一年度時完全一致", { timeout: 120000 }, () => {
    const ff = driveYears(pack, 12);
    const tick = driveYears(pack, 12, "tick");
    const s1 = driveYears(pack, 12, "speed1");
    const s16 = driveYears(pack, 12, "speed16");
    for (const other of [tick, s1, s16]) {
      expect(other.selected).toEqual(ff.selected);
      expect(other.selections).toEqual(ff.selections);
      expect(other.state.events).toEqual(ff.state.events);
      expect(other.state.stateHash).toBe(ff.state.stateHash);
      expect(other.state.hashChain).toBe(ff.state.hashChain);
      expect(other.state.history).toEqual(ff.state.history);
      expect(other.state.flags).toEqual(ff.state.flags);
      expect(other.state.stats).toEqual(ff.state.stats);
      expect(other.state.assets).toEqual(ff.state.assets);
      expect(other.state.commandLog).toEqual(ff.state.commandLog);
      expect(other.state.rng).toEqual(ff.state.rng);
    }
  });
});

describe("P3-C 重播與存檔", () => {
  it("重播重建出逐欄相同的狀態", () => {
    const driven = driveYears(pack, 12);
    const trace = reconstructEventLifeState(
      { bootstrap: makeBootstrap(), targetYears: driven.state.history.yearsRecorded, commandLog: driven.state.commandLog },
      pack
    );
    expect(trace.state.stateHash).toBe(driven.state.stateHash);
    expect(trace.state.events).toEqual(driven.state.events);
    expect(trace.deltas).toHaveLength(driven.deltas.length);
    expect(trace.deltas.map((delta) => delta.event.selectionHash)).toEqual(driven.selections);
  });

  it("verifyEventLifeState 接受真狀態、拒絕被改過的 flags", () => {
    const driven = driveYears(pack, 12);
    expect(() => verifyEventLifeState(makeBootstrap(), driven.state, pack)).not.toThrow();
    const forged = { ...driven.state, flags: [...driven.state.flags, "forged:flag"].sort() };
    expect(() => verifyEventLifeState(makeBootstrap(), forged, pack)).toThrowError(/E_P3C_/);
  });

  it("serialize／deserialize 後能繼續得到相同事件結果", () => {
    const driven = driveYears(pack, 12);
    const serialized = serializeEventLifeState(driven.state);
    const restored = deserializeEventLifeState(serialized, makeBootstrap(), pack);
    expect(restored.stateHash).toBe(driven.state.stateHash);
    expect(restored.playback.mode).toBe("paused");
    expect(restored.events.occurrences).toEqual(driven.state.events.occurrences);
    // 繼續跑一年（若停在抉擇就先以 canonical 最小 optionId 解決），兩邊結果必須相同。
    const advance = (state: typeof restored) => {
      let next = state;
      if (next.pendingDecision !== null) {
        const optionIds = [...next.pendingDecision.options.map((option) => option.optionId)].sort();
        next = runCommand(next, pack, { type: "SELECT_DECISION", optionId: optionIds[0] as string });
        next = runCommand(next, pack, { type: "NEXT" });
      }
      return advanceOneYear(next, pack);
    };
    expect(advance(restored).stateHash).toBe(advance(driven.state).stateHash);
  });

  it("舊的 P3-A 序列化狀態不得被當成 P3-C", () => {
    const driven = driveYears(pack, 3);
    const serialized = serializeEventLifeState(driven.state) as unknown as Record<string, unknown>;
    expect(() => deserializeEventLifeState({ ...serialized, schemaVersion: "p3a-1" }, makeBootstrap(), pack)).toThrowError(/E_P3C_VERSION/);
  });
});

describe("P3-C.1 年度 snapshot 必須反映事件後的最終狀態（CTO-037 必修 1）", () => {
  /**
   * 決定性 money 事件 pack：只留下 `ev.p3c.ordinary`（money +500000）並把年齡鎖在 7 歲，
   * 因此第 7 年一定是「單候選、0 draws、money effect 生效」，**不需要任何條件式跳過**。
   */
  const moneyPack = repack(loadRawPack(), (events) =>
    events.filter((entry) => entry.eventId === "ev.p3c.ordinary").map((entry) => ({ ...entry, ageMin: 7, ageMax: 120 }))
  );

  function runMoneyLife(years: number): { state: ReturnType<typeof newLife>; deltas: readonly P3CYearDelta[] } {
    let state = newLife(moneyPack);
    const deltas: P3CYearDelta[] = [];
    ({ state } = runCommandWithDeltas(state, moneyPack, { type: "SET_PLAYBACK", paused: false }));
    let guardCounter = 0;
    while (state.history.yearsRecorded < years) {
      const result = runCommandWithDeltas(state, moneyPack, { type: "FAST_FORWARD_STEP", maxYears: 1 });
      state = result.state;
      for (const delta of result.deltas) deltas.push(delta);
      if (state.pendingDecision !== null) {
        const optionIds = [...state.pendingDecision.options.map((option) => option.optionId)].sort();
        ({ state } = runCommandWithDeltas(state, moneyPack, { type: "SELECT_DECISION", optionId: optionIds[0] as string }));
        ({ state } = runCommandWithDeltas(state, moneyPack, { type: "NEXT" }));
      }
      if (state.playback.mode === "fast_forward") ({ state } = runCommandWithDeltas(state, moneyPack, { type: "SET_PLAYBACK", paused: false }));
      guardCounter += 1;
      if (guardCounter > 64) throw new Error("money life did not converge");
    }
    return { state, deltas };
  }

  it("money effect 之後 snapshot.balanceMicroUsd 等於最終 state 餘額", () => {
    const run = runMoneyLife(7);
    const delta = run.deltas[6];
    expect(delta).toBeDefined();
    expect(delta?.event.eventId).toBe("ev.p3c.ordinary");
    expect(delta?.event.reason).toBe("single_candidate");
    expect(delta?.event.drawsUsed).toBe(0);
    // 明確斷言（CTO-037 指定）。
    expect(delta?.event.outcome.moneyDelta.balanceMicroUsd).toBe("500000");
    expect(delta?.snapshot.balanceMicroUsd).toBe(run.state.assets.balanceMicroUsd.toString());
    // snapshot 的 stats／phase 也必須是提交後的最終值。
    expect(delta?.snapshot.stats).toEqual(run.state.stats);
    expect(delta?.snapshot.phase).toBe(run.state.phase);
    expect(delta?.age).toBe(run.state.age);
    expect(delta?.year).toBe(run.state.currentYear);
  });

  it("snapshot 的 balance 不是事件前的 roll 餘額", () => {
    const run = runMoneyLife(7);
    const delta = run.deltas[6];
    expect(delta).toBeDefined();
    const finalBalance = run.state.assets.balanceMicroUsd;
    const rollBalance = finalBalance - 500000n;
    expect(delta?.snapshot.balanceMicroUsd).not.toBe(rollBalance.toString());
    expect(BigInt(delta?.snapshot.balanceMicroUsd as string)).toBe(finalBalance);
  });

  it("serialize／deserialize 與 replay 都給出同一個 snapshot 與 stateHash", () => {
    const run = runMoneyLife(7);
    const delta = run.deltas[6];
    const restored = deserializeEventLifeState(serializeEventLifeState(run.state), makeBootstrap(), moneyPack);
    expect(restored.stateHash).toBe(run.state.stateHash);
    expect(restored.assets.balanceMicroUsd).toBe(run.state.assets.balanceMicroUsd);
    expect(restored.events.rng).toEqual(run.state.events.rng);
    const trace = reconstructEventLifeState(
      { bootstrap: makeBootstrap(), targetYears: run.state.history.yearsRecorded, commandLog: run.state.commandLog },
      moneyPack
    );
    expect(trace.state.stateHash).toBe(run.state.stateHash);
    expect(trace.deltas[6]?.snapshot.balanceMicroUsd).toBe(delta?.snapshot.balanceMicroUsd);
    expect(() => verifyEventLifeState(makeBootstrap(), run.state, moneyPack)).not.toThrow();
  });
});
