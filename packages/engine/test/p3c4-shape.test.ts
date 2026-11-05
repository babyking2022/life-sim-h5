import { describe, expect, it } from "vitest";
import type { P3CLifeState } from "@life-sim/contracts";
import {
  applyEventLifeCommand,
  assertEventLifeApprovedVersions,
  assertEventLifeInvariants,
  assertEventLifeShape,
  assertOccurrences,
  bindEventPack,
  createEventLifeState,
  deserializeEventLifeState,
  reconstructEventLifeState,
  serializeEventLifeState,
  verifyEventLifeReplay
} from "../src/life/annual";
import { applyEffectOutcome, noEventOutcome } from "../src/life/annual/effects-adapter";
import { sealEventLifeState } from "../src/life/annual/state";
import { driveYears, loadEdgePack, loadPack, makeBootstrap, newLife, runCommand } from "./p3c-helpers";

/**
 * P3-C 信任邊界：形狀驗證器的每一條拒絕路徑都要有反例。
 * 這裡用「一份合法 state ＋ 逐欄破壞」的表格驅動，確保錯誤碼是固定的 `E_P3C_*`。
 */

const pack = loadPack();
const edgePack = loadEdgePack();
const drivenState = driveYears(pack, 14).state;
const atDecision = driveYears(pack, 5).state;

/** 破壞用的寬鬆物件型別；測試只需要能自由改欄位。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = Record<string, any>;

type Mutation = { readonly name: string; readonly mutate: (draft: Draft) => void; readonly code?: RegExp };

function clone(state: P3CLifeState): Draft {
  return structuredClone(state) as unknown as Draft;
}

function expectRejected(base: P3CLifeState, mutations: readonly Mutation[]): void {
  for (const mutation of mutations) {
    const draft = clone(base);
    mutation.mutate(draft);
    expect(() => assertEventLifeInvariants(draft), mutation.name).toThrowError(mutation.code ?? /E_P3C_/);
  }
}

describe("P3-C shape：版本與 origin", () => {
  it("逐欄破壞版本／origin 都會被固定拒絕", () => {
    expectRejected(drivenState, [
      { name: "schemaVersion", mutate: (d) => void (d.schemaVersion = "p3a-1"), code: /E_P3C_VERSION/ },
      { name: "lifeSpecVersion", mutate: (d) => void (d.lifeSpecVersion = "1.0.1"), code: /E_P3C_VERSION/ },
      { name: "versions 非物件", mutate: (d) => void (d.versions = null), code: /E_P3C_VERSION/ },
      { name: "versions.engineVersion 空", mutate: (d) => void (d.versions.engineVersion = ""), code: /E_P3C_VERSION/ },
      { name: "versions.rulesetVersion 非字串", mutate: (d) => void (d.versions.rulesetVersion = 1), code: /E_P3C_VERSION/ },
      { name: "versions.rngSpecVersion", mutate: (d) => void (d.versions.rngSpecVersion = "2.0.0"), code: /E_P3C_VERSION/ },
      { name: "versions.saveFormatVersion", mutate: (d) => void (d.versions.saveFormatVersion = 3), code: /E_P3C_VERSION/ },
      { name: "origin 非物件", mutate: (d) => void (d.origin = []), code: /E_P3C_STATE/ },
      { name: "origin.certificateHash", mutate: (d) => void (d.origin.certificateHash = "zz"), code: /E_P3C_STATE/ },
      { name: "origin.certificateId", mutate: (d) => void (d.origin.certificateId = "cert:nope"), code: /E_P3C_STATE/ },
      { name: "origin.basePackId 空", mutate: (d) => void (d.origin.basePackId = ""), code: /E_P3C_STATE/ },
      { name: "origin.identityPackId 空", mutate: (d) => void (d.origin.identityPackId = ""), code: /E_P3C_STATE/ },
      { name: "birthYear 太早", mutate: (d) => void (d.birthYear = 1700), code: /E_P3C_STATE/ },
      { name: "currentYear 非整數", mutate: (d) => void (d.currentYear = 2020.5), code: /E_P3C_STATE/ },
      { name: "age 負值", mutate: (d) => void (d.age = -1), code: /E_P3C_STATE/ },
      { name: "phase", mutate: (d) => void (d.phase = "zombie"), code: /E_P3C_PHASE/ },
      { name: "lifespanYears 0", mutate: (d) => void (d.lifespanYears = 0), code: /E_P3C_STATE/ },
      { name: "paceLifeYearsX10 0", mutate: (d) => void (d.paceLifeYearsX10 = 0), code: /E_P3C_STATE/ }
    ]);
  });
});

describe("P3-C shape：stats／assets／flags／rng", () => {
  it("stats 逐鍵與型別破壞", () => {
    expectRejected(drivenState, [
      { name: "stats 非物件", mutate: (d) => void (d.stats = 1), code: /E_P3C_STATE/ },
      { name: "health > 100", mutate: (d) => void (d.stats.health = 101), code: /E_P3C_STATE/ },
      { name: "happiness NaN", mutate: (d) => void (d.stats.happiness = NaN), code: /E_P3C_STATE/ },
      { name: "knowledge 浮點", mutate: (d) => void (d.stats.knowledge = 50.5), code: /E_P3C_STATE/ },
      { name: "relationships 負值", mutate: (d) => void (d.stats.relationships = -1), code: /E_P3C_STATE/ }
    ]);
  });

  it("assets 只接受 bigint，且必須在 Money 範圍", () => {
    expectRejected(drivenState, [
      { name: "assets 非物件", mutate: (d) => void (d.assets = null), code: /E_P3C_MONEY/ },
      { name: "balance 字串", mutate: (d) => void (d.assets.balanceMicroUsd = "1"), code: /E_P3C_MONEY/ },
      { name: "income number", mutate: (d) => void (d.assets.annualIncomeMicroUsd = 1), code: /E_P3C_MONEY/ },
      { name: "expense NaN", mutate: (d) => void (d.assets.annualExpenseMicroUsd = Number.NaN), code: /E_P3C_MONEY/ }
    ]);
  });

  it("flags 必須符合 pattern、唯一、嚴格遞增、≤ 256", () => {
    expectRejected(drivenState, [
      { name: "flags 非陣列", mutate: (d) => void (d.flags = "x"), code: /E_P3C_STATE/ },
      { name: "flag 非字串", mutate: (d) => void (d.flags = [1]), code: /E_P3C_STATE/ },
      { name: "flag pattern", mutate: (d) => void (d.flags = ["UPPER"]), code: /E_P3C_STATE/ },
      { name: "flag 重複", mutate: (d) => void (d.flags = ["a:b", "a:b"]), code: /E_P3C_STATE/ },
      { name: "flag 未排序", mutate: (d) => void (d.flags = ["b:x", "a:x"]), code: /E_P3C_STATE/ },
      { name: "flags > 256", mutate: (d) => void (d.flags = Array.from({ length: 257 }, (_v, i) => `f:${String(i).padStart(3, "0")}`)), code: /E_P3C_STATE/ }
    ]);
  });

  it("人生 RNG 游標本體破壞", () => {
    expectRejected(drivenState, [
      { name: "rng 非物件", mutate: (d) => void (d.rng = null), code: /E_P3C_RNG/ },
      { name: "rng.domain", mutate: (d) => void (d.rng.domain = "events"), code: /E_P3C_RNG/ },
      { name: "rng.state 長度", mutate: (d) => void (d.rng.state = [1, 2, 3]), code: /E_P3C_RNG/ },
      { name: "rng.state 負值", mutate: (d) => void (d.rng.state = [-1, 0, 0, 0]), code: /E_P3C_RNG/ },
      { name: "rng.draws", mutate: (d) => void (d.rng.draws = -1), code: /E_P3C_RNG/ },
      { name: "rng.draws 會計不符", mutate: (d) => void (d.rng.draws += 1), code: /E_P3C_RNG/ }
    ]);
  });
});

describe("P3-C shape：events 綁定與 occurrence 摘要", () => {
  it("binding 逐欄破壞", () => {
    expectRejected(drivenState, [
      { name: "events 非物件", mutate: (d) => void (d.events = null), code: /E_P3C_OCCURRENCE/ },
      { name: "binding 非物件", mutate: (d) => void (d.events.binding = []), code: /E_P3C_PACK/ },
      { name: "eventSchemaVersion", mutate: (d) => void (d.events.binding.eventSchemaVersion = "p3b-2"), code: /E_P3C_PACK/ },
      { name: "eventSpecVersion", mutate: (d) => void (d.events.binding.eventSpecVersion = "2.0.0"), code: /E_P3C_PACK/ },
      { name: "contentPackVersion", mutate: (d) => void (d.events.binding.contentPackVersion = "1.0"), code: /E_P3C_PACK/ },
      { name: "eventPackId", mutate: (d) => void (d.events.binding.eventPackId = "BAD ID"), code: /E_P3C_PACK/ },
      { name: "eventPackChecksum", mutate: (d) => void (d.events.binding.eventPackChecksum = "0".repeat(10)), code: /E_P3C_PACK/ },
      { name: "datasetChecksum", mutate: (d) => void (d.events.binding.datasetChecksum = "0".repeat(10)), code: /E_P3C_PACK/ },
      { name: "eventCount 超上限", mutate: (d) => void (d.events.binding.eventCount = 5000), code: /E_P3C_PACK/ },
      { name: "contentMode", mutate: (d) => void (d.events.contentMode = "wild"), code: /E_P3C_STATE/ }
    ]);
  });

  it("events.rng 逐欄破壞", () => {
    expectRejected(drivenState, [
      { name: "events.rng 非物件", mutate: (d) => void (d.events.rng = null), code: /E_P3C_RNG/ },
      { name: "domain", mutate: (d) => void (d.events.rng.domain = "life"), code: /E_P3C_RNG/ },
      { name: "state 長度", mutate: (d) => void (d.events.rng.state = [1]), code: /E_P3C_RNG/ },
      { name: "draws 負值", mutate: (d) => void (d.events.rng.draws = -1), code: /E_P3C_RNG/ },
      { name: "draws 超過年度上限", mutate: (d) => void (d.events.rng.draws = 256 * d.history.yearsRecorded + 2), code: /E_P3C_RNG/ }
    ]);
  });

  it("occurrence 摘要逐欄破壞", () => {
    expectRejected(drivenState, [
      { name: "occurrences 非陣列", mutate: (d) => void (d.events.occurrences = {}), code: /E_P3C_OCCURRENCE/ },
      { name: "entry 非物件", mutate: (d) => void (d.events.occurrences = [1]), code: /E_P3C_OCCURRENCE/ },
      { name: "eventId pattern", mutate: (d) => void (d.events.occurrences = [{ eventId: "BAD", count: 1, lastYear: 2021 }]), code: /E_P3C_OCCURRENCE/ },
      { name: "count 0", mutate: (d) => void (d.events.occurrences = [{ eventId: "ev.p3c.once", count: 0, lastYear: 2021 }]), code: /E_P3C_OCCURRENCE/ },
      { name: "lastYear 未來", mutate: (d) => void (d.events.occurrences = [{ eventId: "ev.p3c.once", count: 1, lastYear: 9999 }]), code: /E_P3C_OCCURRENCE/ },
      { name: "lastYear 出生前", mutate: (d) => void (d.events.occurrences = [{ eventId: "ev.p3c.once", count: 1, lastYear: 2019 }]), code: /E_P3C_OCCURRENCE/ }
    ]);
  });

  it("assertOccurrences 的邊界（直接用 context 檢查）", () => {
    const context = { yearsRecorded: 3, currentYear: 2023, birthYear: 2020, eventCount: 2 };
    expect(() => assertOccurrences([], context)).not.toThrow();
    expect(() => assertOccurrences([{ eventId: "ev.a", count: 1, lastYear: 2021 }], context)).not.toThrow();
    // 上限 = min(4096, eventCount 2, yearsRecorded 3) = 2，因此 3 筆就必須被拒。
    expect(() =>
      assertOccurrences(
        [
          { eventId: "ev.a", count: 1, lastYear: 2021 },
          { eventId: "ev.b", count: 1, lastYear: 2022 },
          { eventId: "ev.c", count: 1, lastYear: 2023 }
        ],
        context
      )
    ).toThrowError(/E_P3C_OCCURRENCE/);
    expect(() => assertOccurrences([], { ...context, yearsRecorded: 0 })).not.toThrow();
    expect(() => assertOccurrences([{ eventId: "ev.a", count: 1, lastYear: 2021 }], { ...context, yearsRecorded: 0 })).toThrowError(/E_P3C_OCCURRENCE/);
    expect(() => assertOccurrences([{ eventId: "ev.a", count: 1, lastYear: 2021 }], { ...context, eventCount: 0 })).toThrowError(/E_P3C_OCCURRENCE/);
  });
});

describe("P3-C shape：history／pending decision／playback", () => {
  it("history 逐欄破壞", () => {
    expectRejected(drivenState, [
      { name: "history 非物件", mutate: (d) => void (d.history = null), code: /E_P3C_HISTORY/ },
      { name: "yearsRecorded 負值", mutate: (d) => void (d.history.yearsRecorded = -1), code: /E_P3C_HISTORY/ },
      { name: "cardsTotal 負值", mutate: (d) => void (d.history.cardsTotal = -1), code: /E_P3C_HISTORY/ },
      { name: "lastEntryHash", mutate: (d) => void (d.history.lastEntryHash = "x"), code: /E_P3C_HISTORY/ },
      { name: "lastSnapshotHash", mutate: (d) => void (d.history.lastSnapshotHash = "x"), code: /E_P3C_HISTORY/ },
      { name: "lastDeltaHash", mutate: (d) => void (d.history.lastDeltaHash = "x"), code: /E_P3C_HISTORY/ },
      { name: "initialStateHash", mutate: (d) => void (d.history.initialStateHash = "x"), code: /E_P3C_HISTORY/ },
      { name: "yearsRecorded 與 age 不符", mutate: (d) => void (d.history.yearsRecorded -= 1), code: /E_P3C_HISTORY/ },
      { name: "cardsTotal < yearsRecorded", mutate: (d) => void (d.history.cardsTotal = 0), code: /E_P3C_HISTORY/ },
      { name: "cardsSeen > cardsTotal", mutate: (d) => void (d.playback.cardsSeen = 999), code: /E_P3C_HISTORY/ },
      { name: "currentYear 與 age 不符", mutate: (d) => void (d.currentYear += 1), code: /E_P3C_STATE/ },
      { name: "phase 與 lifespan 不符", mutate: (d) => void (d.phase = "death"), code: /E_P3C_STATE/ },
      { name: "errorCode 非 null", mutate: (d) => void (d.errorCode = "E_P3C_STATE"), code: /E_P3C_STATE/ },
      { name: "commandLog 非陣列", mutate: (d) => void (d.commandLog = {}), code: /E_P3C_STATE/ },
      { name: "stateHash", mutate: (d) => void (d.stateHash = "not-a-hash"), code: /E_P3C_HASH/ },
      { name: "hashChain", mutate: (d) => void (d.hashChain = "not-a-hash"), code: /E_P3C_HASH/ }
    ]);
  });

  it("pendingDecision 逐欄破壞", () => {
    expectRejected(atDecision, [
      { name: "非物件", mutate: (d) => void (d.pendingDecision = 1), code: /E_P3C_STATE/ },
      { name: "decisionId 空", mutate: (d) => void (d.pendingDecision.decisionId = ""), code: /E_P3C_STATE/ },
      { name: "source", mutate: (d) => void (d.pendingDecision.source = "other"), code: /E_P3C_DECISION/ },
      { name: "skeleton 但 eventId 不是 sentinel", mutate: (d) => { d.pendingDecision.source = "skeleton"; }, code: /E_P3C_DECISION/ },
      { name: "eventId pattern", mutate: (d) => void (d.pendingDecision.eventId = "BAD"), code: /E_P3C_DECISION/ },
      { name: "selectionHash", mutate: (d) => void (d.pendingDecision.selectionHash = "x"), code: /E_P3C_DECISION/ },
      { name: "occurrenceDigestBefore", mutate: (d) => void (d.pendingDecision.occurrenceDigestBefore = "x"), code: /E_P3C_DECISION/ },
      { name: "prompt 非字串", mutate: (d) => void (d.pendingDecision.prompt = 1), code: /E_P3C_STATE/ },
      { name: "year 非整數", mutate: (d) => void (d.pendingDecision.year = 2020.5), code: /E_P3C_STATE/ },
      { name: "options 少於 2", mutate: (d) => void (d.pendingDecision.options = [d.pendingDecision.options[0]]), code: /E_P3C_STATE/ },
      { name: "option 非物件", mutate: (d) => void (d.pendingDecision.options = [1, 2]), code: /E_P3C_STATE/ },
      { name: "optionId 空", mutate: (d) => void (d.pendingDecision.options[0].optionId = ""), code: /E_P3C_STATE/ },
      { name: "label 非字串", mutate: (d) => void (d.pendingDecision.options[0].label = 1), code: /E_P3C_STATE/ },
      { name: "effects 非陣列", mutate: (d) => void (d.pendingDecision.options[0].effects = {}), code: /E_P3C_EFFECT/ },
      { name: "effect 非物件", mutate: (d) => void (d.pendingDecision.options[0].effects = [1]), code: /E_P3C_EFFECT/ },
      { name: "optionId 重複", mutate: (d) => void (d.pendingDecision.options[1].optionId = d.pendingDecision.options[0].optionId), code: /E_P3C_STATE/ },
      { name: "selectedOptionId 型別", mutate: (d) => void (d.pendingDecision.selectedOptionId = 1), code: /E_P3C_STATE/ },
      { name: "selectedOptionId 不在清單", mutate: (d) => void (d.pendingDecision.selectedOptionId = "zzz"), code: /E_P3C_DECISION/ },
      { name: "pending.year 與 currentYear 不符", mutate: (d) => void (d.pendingDecision.year -= 1), code: /E_P3C_STATE/ },
      { name: "pending 時 playback 不是 paused", mutate: (d) => void (d.playback.mode = "playing"), code: /E_P3C_STATE/ },
      { name: "pendingDecision 殘留在 phase = life", mutate: (d) => void (d.phase = "life"), code: /E_P3C_STATE/ }
    ]);
  });

  it("playback 逐欄破壞", () => {
    expectRejected(drivenState, [
      { name: "非物件", mutate: (d) => void (d.playback = 1), code: /E_P3C_TYPE/ },
      { name: "mode", mutate: (d) => void (d.playback.mode = "stopped"), code: /E_P3C_STATE/ },
      { name: "visibility", mutate: (d) => void (d.playback.visibility = "gone"), code: /E_P3C_STATE/ },
      { name: "previousMode", mutate: (d) => void (d.playback.previousMode = "fast_forward"), code: /E_P3C_STATE/ },
      { name: "speed", mutate: (d) => void (d.playback.speed = 3), code: /E_P3C_SPEED/ },
      { name: "paceMinutes", mutate: (d) => void (d.playback.paceMinutes = 45), code: /E_P3C_PACE/ },
      { name: "yearDurationMs 非整數", mutate: (d) => void (d.playback.yearDurationMs = 10000.5), code: /E_P3C_PACE/ },
      { name: "yearDurationMs 不符 pace", mutate: (d) => void (d.playback.yearDurationMs = 20000), code: /E_P3C_PACE/ },
      { name: "elapsed 負值", mutate: (d) => void (d.playback.elapsedInYearMs = -1), code: /E_P3C_STATE/ },
      { name: "elapsed ≥ duration", mutate: (d) => void (d.playback.elapsedInYearMs = d.playback.yearDurationMs), code: /E_P3C_STATE/ },
      { name: "cardsSeen 負值", mutate: (d) => void (d.playback.cardsSeen = -1), code: /E_P3C_STATE/ },
      { name: "hidden 但是 playing", mutate: (d) => { d.playback.visibility = "hidden"; d.playback.mode = "playing"; }, code: /E_P3C_STATE/ }
    ]);
  });
});

describe("P3-C 建立入口的反例", () => {
  it("bootstrap 形狀破壞", () => {
    const base = makeBootstrap();
    const withOrigin = (origin: unknown) => ({ ...base, origin });
    expect(() => createEventLifeState(null, pack)).toThrowError(/E_P3C_TYPE/);
    expect(() => createEventLifeState({ ...base, versions: null }, pack)).toThrowError(/E_P3C_VERSION/);
    expect(() => createEventLifeState({ ...base, origin: null }, pack)).toThrowError(/E_P3C_STATE/);
    expect(() => createEventLifeState(withOrigin({ ...base.origin, certificateHash: "x" }), pack)).toThrowError(/E_P3C_STATE/);
    expect(() => createEventLifeState({ ...base, birthYear: 1700 }, pack)).toThrowError(/E_P3C_STATE/);
    expect(() => createEventLifeState({ ...base, paceLifeYearsX10: 10 }, pack)).toThrowError(/E_P3C_STATE/);
    expect(() => createEventLifeState({ ...base, rngState: [1, 2, 3] }, pack)).toThrowError(/E_P3C_STATE/);
  });

  it("assertEventLifeApprovedVersions 只接受正式組合", () => {
    const versions = newLife(pack).versions;
    expect(() => assertEventLifeApprovedVersions(versions)).not.toThrow();
    expect(() => assertEventLifeApprovedVersions({ ...versions, rulesetVersion: "p3c-bench-10" })).toThrowError(/E_P3C_VERSION/);
    expect(() => assertEventLifeApprovedVersions({ ...versions, saveFormatVersion: 3 })).toThrowError(/E_P3C_VERSION/);
    expect(() => assertEventLifeApprovedVersions(null)).toThrowError(/E_P3C_VERSION/);
  });

  it("bindEventPack 只接受品牌化 pack", () => {
    expect(bindEventPack(pack).eventPackId).toBe(pack.manifest.eventPackId);
    expect(() => bindEventPack({ manifest: pack.manifest, events: pack.events })).toThrowError(/E_P3C_PACK/);
  });
});

describe("P3-C 指令層反例", () => {
  it("未知指令／畸形指令", () => {
    const state = newLife(pack);
    expect(() => applyEventLifeCommand(state, null, pack)).toThrowError(/E_P3C_TYPE/);
    expect(() => applyEventLifeCommand(state, [], pack)).toThrowError(/E_P3C_TYPE/);
    expect(() => applyEventLifeCommand(state, {}, pack)).toThrowError(/E_P3C_TYPE/);
    expect(() => applyEventLifeCommand(state, { type: "TELEPORT" }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => applyEventLifeCommand(state, { type: "TICK", deltaMs: -1 }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => applyEventLifeCommand(state, { type: "TICK", deltaMs: 1001 }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => applyEventLifeCommand(state, { type: "TICK", deltaMs: 1.5 }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => applyEventLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: 0 }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => applyEventLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: 21 }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => applyEventLifeCommand(state, { type: "SET_PLAYBACK", speed: 3 }, pack)).toThrowError(/E_P3C_SPEED/);
    expect(() => applyEventLifeCommand(state, { type: "SET_PLAYBACK", paceMinutes: 45 }, pack)).toThrowError(/E_P3C_PACE/);
    expect(() => applyEventLifeCommand(state, { type: "SET_PLAYBACK", paused: "yes" }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => applyEventLifeCommand(state, { type: "SET_PLAYBACK", hidden: true, paused: true }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => applyEventLifeCommand(state, { type: "SELECT_DECISION", optionId: "steady" }, pack)).toThrowError(/E_P3C_PHASE/);
  });

  it("NEXT／SET_PLAYBACK 的狀態機邊界", () => {
    const state = newLife(pack);
    // fast_forward 之後 NEXT 被拒。
    const ff = runCommand(state, pack, { type: "FAST_FORWARD_STEP", maxYears: 1 });
    const ffMode = { ...ff, playback: { ...ff.playback, mode: "fast_forward" as const } };
    expect(() => runCommand(ffMode, pack, { type: "NEXT" })).toThrowError(/E_P3C_ARGUMENT/);
    // hidden 不能強制 playing。
    const hidden = runCommand(state, pack, { type: "SET_PLAYBACK", hidden: true });
    expect(() => runCommand(hidden, pack, { type: "SET_PLAYBACK", paused: false })).toThrowError(/E_P3C_PHASE/);
    // 死亡後不能 playing。
    const dead = driveYears(edgePack, 120).state;
    expect(dead.phase).toBe("death");
    expect(() => runCommand(dead, edgePack, { type: "SET_PLAYBACK", paused: false })).toThrowError(/E_P3C_PHASE/);
    // pace 變更會按比例換算 elapsed。
    const paced = runCommand(state, pack, { type: "SET_PLAYBACK", paceMinutes: 30 });
    expect(paced.playback.paceMinutes).toBe(30);
    expect(paced.playback.elapsedInYearMs).toBe(0);
  });

  it("hidden 恢復時依 previousMode 決定模式", () => {
    const playing = runCommand(newLife(pack), pack, { type: "SET_PLAYBACK", paused: false });
    const hidden = runCommand(playing, pack, { type: "SET_PLAYBACK", hidden: true });
    expect(hidden.playback.mode).toBe("paused");
    const visible = runCommand(hidden, pack, { type: "SET_PLAYBACK", hidden: false });
    expect(visible.playback.visibility).toBe("visible");
    expect(visible.playback.mode).toBe("playing");
  });

  it("TICK 在非 playing 時是 no-op", () => {
    const state = newLife(pack);
    const result = applyEventLifeCommand(state, { type: "TICK", deltaMs: 500 }, pack);
    expect(result.state).toBe(state);
    expect(result.deltas).toHaveLength(0);
  });

  it("NEXT 在死亡狀態只維持 paused", () => {
    const dead = driveYears(edgePack, 120).state;
    expect(dead.phase).toBe("death");
    const after = runCommand(dead, edgePack, { type: "NEXT" });
    expect(after.playback.mode).toBe("paused");
  });
});

describe("P3-C 轉接層反例（偽造 outcome）", () => {
  const facts = {
    stats: drivenState.stats,
    assets: drivenState.assets,
    flags: [...drivenState.flags]
  };

  it("形狀錯誤的 outcome 一律拒絕", () => {
    expect(() => applyEffectOutcome(facts, null)).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome(facts, {})).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome(facts, { stats: null, assets: {}, flags: [], openedDecisionId: null, informational: false })).toThrowError(/E_P3C_EFFECT/);
    expect(() =>
      applyEffectOutcome(facts, {
        stats: { health: 101, happiness: 1, knowledge: 1, relationships: 1 },
        assets: facts.assets,
        flags: [],
        openedDecisionId: null,
        informational: false
      })
    ).toThrowError(/E_P3C_EFFECT/);
    expect(() =>
      applyEffectOutcome(facts, {
        stats: facts.stats,
        assets: { balanceMicroUsd: "1", annualIncomeMicroUsd: 0n, annualExpenseMicroUsd: 0n },
        flags: [],
        openedDecisionId: null,
        informational: false
      })
    ).toThrowError(/E_P3C_MONEY/);
    expect(() =>
      applyEffectOutcome(facts, { stats: facts.stats, assets: facts.assets, flags: ["BAD"], openedDecisionId: null, informational: false })
    ).toThrowError(/E_P3C_EFFECT/);
    expect(() =>
      applyEffectOutcome(facts, { stats: facts.stats, assets: facts.assets, flags: [], openedDecisionId: "BAD ID", informational: false })
    ).toThrowError(/E_P3C_DECISION/);
    expect(() =>
      applyEffectOutcome(facts, { stats: facts.stats, assets: facts.assets, flags: [], openedDecisionId: null, informational: "yes" })
    ).toThrowError(/E_P3C_EFFECT/);
  });

  it("合法的 outcome 會算出正確增量", () => {
    const applied = applyEffectOutcome(facts, {
      stats: { health: facts.stats.health, happiness: facts.stats.happiness, knowledge: facts.stats.knowledge, relationships: facts.stats.relationships },
      assets: facts.assets,
      flags: [...facts.flags, "p3c:new"],
      openedDecisionId: "dec.p3c.choice",
      informational: false
    });
    expect(applied.outcome.statDelta).toEqual({ health: 0, happiness: 0, knowledge: 0, relationships: 0 });
    expect(applied.outcome.flagsAdded).toEqual(["p3c:new"]);
    expect(applied.outcome.moneyDelta.balanceMicroUsd).toBe("0");
    expect(applied.openedDecisionId).toBe("dec.p3c.choice");
    expect(applied.outcome.informational).toBe(false);
  });

  it("noEventOutcome 是零增量", () => {
    expect(noEventOutcome().statDelta).toEqual({ health: 0, happiness: 0, knowledge: 0, relationships: 0 });
    expect(noEventOutcome().flagsAdded).toEqual([]);
  });
});

describe("P3-C.1 轉接層：重複 flags 與非法 base 一律拒絕（CTO-037 必修 2）", () => {
  const facts = {
    stats: drivenState.stats,
    assets: drivenState.assets,
    flags: [...drivenState.flags]
  };

  function outcomeWithFlags(flags: readonly unknown[]) {
    return {
      stats: facts.stats,
      assets: facts.assets,
      flags,
      openedDecisionId: null,
      informational: false
    };
  }

  it("outcome 的重複 flags 必須在 Set 去重前就被拒絕", () => {
    const duplicate = outcomeWithFlags(["p3c:a", "p3c:a"]);
    expect(() => applyEffectOutcome(facts, duplicate)).toThrowError(/E_P3C_EFFECT/);
    // 三個相同、或重複但未排序，都一樣。
    expect(() => applyEffectOutcome(facts, outcomeWithFlags(["p3c:a", "p3c:a", "p3c:a"]))).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome(facts, outcomeWithFlags(["p3c:b", "p3c:a", "p3c:b"]))).toThrowError(/E_P3C_EFFECT/);
    // 對照：唯一但未排序的 flags 是合法的（會 canonical 排序後回傳）。
    const sorted = applyEffectOutcome(facts, outcomeWithFlags(["p3c:b", "p3c:a"]));
    expect(sorted.flags).toEqual(["p3c:a", "p3c:b"]);
  });

  it("非法 base flags（重複／未排序／pattern／超限）一律拒絕", () => {
    const good = outcomeWithFlags([]);
    expect(() => applyEffectOutcome({ ...facts, flags: ["p3c:a", "p3c:a"] }, good)).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome({ ...facts, flags: ["p3c:b", "p3c:a"] }, good)).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome({ ...facts, flags: ["BAD"] }, good)).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome({ ...facts, flags: [1] }, good)).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome({ ...facts, flags: "p3c:a" }, good)).toThrowError(/E_P3C_EFFECT/);
    expect(() =>
      applyEffectOutcome({ ...facts, flags: Array.from({ length: 257 }, (_v, i) => `f:${String(i).padStart(3, "0")}`) }, good)
    ).toThrowError(/E_P3C_EFFECT/);
    // 合法：嚴格遞增。
    expect(() => applyEffectOutcome({ ...facts, flags: ["p3c:a", "p3c:b"] }, good)).not.toThrow();
  });

  it("非法 base money（字串／number／NaN／超範圍）一律 E_P3C_MONEY，不外洩原生錯誤", () => {
    const good = outcomeWithFlags([]);
    const cases: readonly unknown[] = [
      { ...facts.assets, balanceMicroUsd: "0" },
      { ...facts.assets, balanceMicroUsd: 0 },
      { ...facts.assets, balanceMicroUsd: Number.NaN },
      { ...facts.assets, annualIncomeMicroUsd: "1" },
      { ...facts.assets, annualExpenseMicroUsd: 1 },
      { ...facts.assets, balanceMicroUsd: 2n ** 300n }
    ];
    for (const assets of cases) {
      let caught: unknown;
      try {
        applyEffectOutcome({ ...facts, assets }, good);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect((caught as { code?: string }).code).toBe("E_P3C_MONEY");
      expect(caught instanceof TypeError).toBe(false);
      expect((caught as { name?: string }).name).toBe("EventLifeError");
    }
  });

  it("非法 base stats 與非物件 base 一律 E_P3C_EFFECT", () => {
    const good = outcomeWithFlags([]);
    expect(() => applyEffectOutcome(null, good)).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome([], good)).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome({ ...facts, stats: null }, good)).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome({ ...facts, stats: { ...facts.stats, health: 101 } }, good)).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome({ ...facts, stats: { ...facts.stats, happiness: Number.NaN } }, good)).toThrowError(/E_P3C_EFFECT/);
    expect(() => applyEffectOutcome({ ...facts, assets: null }, good)).toThrowError(/E_P3C_MONEY/);
  });
});

describe("P3-C 存檔與重播反例", () => {
  it("畸形序列化輸入被固定拒絕", () => {
    const serialized = serializeEventLifeState(drivenState);
    expect(() => deserializeEventLifeState(null, makeBootstrap(), pack)).toThrowError(/E_P3C_TYPE/);
    expect(() => deserializeEventLifeState({ ...serialized, schemaVersion: "p3a-1" }, makeBootstrap(), pack)).toThrowError(/E_P3C_VERSION/);
    expect(() => deserializeEventLifeState({ ...serialized, assets: null }, makeBootstrap(), pack)).toThrowError(/E_P3C_MONEY/);
    expect(() =>
      deserializeEventLifeState({ ...serialized, assets: { ...serialized.assets, balanceMicroUsd: "1.5" } }, makeBootstrap(), pack)
    ).toThrowError(/E_P3C_MONEY/);
    expect(() => deserializeEventLifeState({ ...serialized, playback: null }, makeBootstrap(), pack)).toThrowError(/E_P3C_TYPE/);
    expect(() =>
      deserializeEventLifeState({ ...serialized, playback: { ...serialized.playback, mode: "gone" } }, makeBootstrap(), pack)
    ).toThrowError(/E_P3C_STATE/);
    expect(() =>
      deserializeEventLifeState({ ...serialized, playback: { ...serialized.playback, speed: 3 } }, makeBootstrap(), pack)
    ).toThrowError(/E_P3C_SPEED/);
    expect(() =>
      deserializeEventLifeState({ ...serialized, playback: { ...serialized.playback, paceMinutes: 45 } }, makeBootstrap(), pack)
    ).toThrowError(/E_P3C_PACE/);
    expect(() =>
      deserializeEventLifeState({ ...serialized, playback: { ...serialized.playback, cardsSeen: -1 } }, makeBootstrap(), pack)
    ).toThrowError(/E_P3C_STATE/);
    expect(() =>
      deserializeEventLifeState({ ...serialized, playback: { ...serialized.playback, elapsedInYearMs: 10 ** 9 } }, makeBootstrap(), pack)
    ).toThrowError(/E_P3C_STATE/);
    expect(() => deserializeEventLifeState({ ...serialized, origin: { ...serialized.origin, certificateHash: "a".repeat(63) } }, makeBootstrap(), pack)).toThrowError(
      /E_P3C_/
    );
  });

  it("error 狀態不可序列化、也不可作為驗證目標", () => {
    const state = newLife(pack);
    const errored = sealEventLifeState({ ...state, phase: "error" as const, errorCode: "E_P3C_STATE" });
    expect(() => serializeEventLifeState(errored)).toThrowError(/E_P3C_PHASE/);
    expect(() => verifyEventLifeReplay({ bootstrap: makeBootstrap(), targetState: errored }, pack)).toThrowError(/E_P3C_PHASE/);
  });

  it("重建輸入的邊界", () => {
    const state = driveYears(pack, 6).state;
    const input = { bootstrap: makeBootstrap(), targetYears: state.history.yearsRecorded, commandLog: state.commandLog };
    expect(() => reconstructEventLifeState(null, pack)).toThrowError(/E_P3C_TYPE/);
    expect(() => reconstructEventLifeState({ ...input, targetYears: -1 }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => reconstructEventLifeState({ ...input, targetYears: 100_001 }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => reconstructEventLifeState({ ...input, commandLog: null }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => reconstructEventLifeState({ ...input, targetYears: state.history.yearsRecorded + 1 }, pack)).toThrowError(/E_P3C_ARGUMENT/);
    expect(() =>
      verifyEventLifeReplay({ bootstrap: makeBootstrap(), targetState: state, commandLog: state.commandLog.slice(0, 1) }, pack)
    ).toThrowError(/E_P3C_ARGUMENT/);
    expect(() => verifyEventLifeReplay({ bootstrap: null, targetState: state }, pack)).toThrowError(/E_P3C_TYPE/);
    expect(() => assertEventLifeShape({ schemaVersion: "p3c-1" })).toThrowError(/E_P3C_VERSION/);
  });

  it("換 pack 的重播驗證會失敗", () => {
    const state = driveYears(pack, 6).state;
    expect(() => verifyEventLifeReplay({ bootstrap: makeBootstrap(), targetState: state }, edgePack)).toThrowError(/E_P3C_PACK/);
  });
});
