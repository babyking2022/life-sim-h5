import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as contracts from "@life-sim/contracts";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";

/** P3-E.1a-1.1：contracts、錯誤型別與套件骨架；沒有任何邏輯。 */

const ROOT = process.cwd();
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;

const EXPECTED_ERROR_CODES = [
  "E_P3E_TYPE",
  "E_P3E_ARGUMENT",
  "E_P3E_VERSION",
  "E_P3E_CERTIFICATE",
  "E_P3E_IDENTITY",
  "E_P3E_EVENT_PACK",
  "E_P3E_DEATH_PACK",
  "E_P3E_BINDING",
  "E_P3E_RNG",
  "E_P3E_ROLL",
  "E_P3E_STATE",
  "E_P3E_HASH",
  "E_P3E_PHASE",
  "E_P3E_MONEY",
  "E_P3E_EVENT",
  "E_P3E_EFFECT",
  "E_P3E_DECISION",
  "E_P3E_DEATH",
  "E_P3E_HISTORY",
  "E_P3E_COMMAND",
  "E_P3E_CODEC",
  "E_P3E_REPLAY"
];

const HEX = (char: string) => char.repeat(64);

function sampleState(overrides: Partial<contracts.P3ELifeState> = {}): contracts.P3ELifeState {
  return {
    schemaVersion: contracts.P3E_SCHEMA_VERSION,
    rulesetVersion: contracts.P3E_RULESET_VERSION,
    rollSpecVersion: contracts.P3E_ROLL_SPEC_VERSION,
    lifeSpecVersion: contracts.P3E_LIFE_SPEC_VERSION,
    contentVersion: contracts.P3E_CONTENT_VERSION,
    saveFormatVersion: contracts.P3E_SAVE_FORMAT_VERSION,
    engineVersion: contracts.P3E_ENGINE_VERSION,
    rngSpecVersion: contracts.P3E_RNG_SPEC_VERSION,
    identity: {
      entityId: "cr:DZA",
      regionCode: "DZA",
      sex: "female",
      birthYear: 2000,
      certificateId: "cert:0",
      certificateHash: HEX("0"),
      playerIdentityHash: HEX("1"),
      masterSeedHash: HEX("2"),
      basePackId: "p2a-synthetic-20261027",
      basePackChecksum: HEX("3"),
      identityPackId: "p2b-synthetic",
      identityPackChecksum: HEX("4")
    },
    packs: {
      events: {
        eventSchemaVersion: "p3b-1",
        eventSpecVersion: "1.0.0",
        contentPackVersion: "1.0.0",
        eventPackId: "p3b-synthetic-events-v1",
        eventPackChecksum: HEX("5"),
        datasetChecksum: HEX("6"),
        eventCount: 22
      },
      death: {
        schemaVersion: "p3d-1",
        deathDataVersion: "1.0.0",
        deathSpecVersion: "1.0.0",
        healthRuleVersion: "p3d-health-1.0.0",
        engineVersion: "0.1.0",
        rngSpecVersion: "1.0.0",
        deathPackId: "p3d-synthetic-mortality-v1",
        deathPackChecksum: HEX("7"),
        basePackId: "p2a-synthetic-20261027",
        basePackChecksum: HEX("3"),
        entityCount: 172
      }
    },
    currentYear: 2000,
    age: 0,
    phase: "life",
    pendingDecision: null,
    stats: { health: 50, happiness: 50, knowledge: 50, relationships: 50 },
    assets: { balanceMicroUsd: 0n, annualIncomeMicroUsd: 0n, annualExpenseMicroUsd: 0n },
    flags: [],
    occurrences: [],
    rng: {
      life: { domain: "life", initialState: [1, 2, 3, 4], state: [5, 6, 7, 8], semanticDraws: 1 },
      events: { domain: "events", initialState: [9, 10, 11, 12], state: [9, 10, 11, 12], u32Draws: 0 },
      death: { domain: "p3e/death", initialState: [13, 14, 15, 16], state: [13, 14, 15, 16], u32Draws: 0 }
    },
    heads: { lastEntryHash: HEX("8"), lastSnapshotHash: HEX("9"), lastDeltaHash: HEX("a"), hashChain: HEX("b") },
    commandLog: { count: 0, headHash: HEX("c") },
    stateHash: HEX("d"),
    ...overrides
  };
}

describe("P3-E.1a-1.1 固定版本（literal type）", () => {
  it("八個版本常數與 120 歲上限", () => {
    expect(contracts.P3E_SCHEMA_VERSION).toBe("p3e-2");
    expect(contracts.P3E_RULESET_VERSION).toBe("p3e-1.0.0");
    expect(contracts.P3E_ROLL_SPEC_VERSION).toBe("p3e-roll-1.0.0");
    expect(contracts.P3E_LIFE_SPEC_VERSION).toBe("1.0.0");
    expect(contracts.P3E_CONTENT_VERSION).toBe("skeleton-1.2.0");
    expect(contracts.P3E_SAVE_FORMAT_VERSION).toBe(6);
    expect(contracts.P3E_ENGINE_VERSION).toBe("0.1.0");
    expect(contracts.P3E_RNG_SPEC_VERSION).toBe("1.0.0");
    expect(contracts.P3E_MAX_AGE).toBe(120);
    expect(contracts.P3E_MIN_AGE).toBe(0);
  });

  it("存檔格式與 schema 不得與已凍結批次相同", () => {
    expect(contracts.P3E_SAVE_FORMAT_VERSION).not.toBe(contracts.P3C_SAVE_FORMAT_VERSION);
    expect(contracts.P3E_SCHEMA_VERSION).not.toBe(contracts.P3C_SCHEMA_VERSION);
    expect(contracts.P3E_SCHEMA_VERSION).not.toBe(contracts.P3D_SCHEMA_VERSION);
  });

  it("state 的版本欄位是 literal type（錯誤值必須編譯失敗）", () => {
    const state = sampleState();
    // @ts-expect-error lifeSpecVersion 只能是 "1.0.0"
    const badLifeSpec: contracts.P3ELifeState = { ...state, lifeSpecVersion: "2.0.0" };
    // @ts-expect-error saveFormatVersion 只能是 6
    const badSaveFormat: contracts.P3ELifeState = { ...state, saveFormatVersion: 5 };
    // @ts-expect-error rulesetVersion 只能是 "p3e-1.0.0"
    const badRuleset: contracts.P3ELifeState = { ...state, rulesetVersion: "p3e-9.9.9" };
    // @ts-expect-error engineVersion 只能是 "0.1.0"
    const badEngine: contracts.P3ELifeState = { ...state, engineVersion: "0.2.0" };
    // @ts-expect-error contentVersion 只能是 "skeleton-1.2.0"
    const badContent: contracts.P3ELifeState = { ...state, contentVersion: "skeleton-1.1.0" };
    // @ts-expect-error rollSpecVersion 只能是 "p3e-roll-1.0.0"
    const badRoll: contracts.P3ERollInput = { rollSpecVersion: "p3e-roll-2.0.0", age: 1, stats: state.stats, balanceMicroUsd: 0n, lifeRng: state.rng.life };
    expect([badLifeSpec, badSaveFormat, badRuleset, badEngine, badContent, badRoll].length).toBe(6);
  });
});

describe("P3-E.1a-1.1 固定錯誤碼", () => {
  it("22 個錯誤碼完整、唯一、順序固定", () => {
    expect(contracts.P3E_ERROR_CODES.length).toBe(22);
    expect([...contracts.P3E_ERROR_CODES]).toEqual(EXPECTED_ERROR_CODES);
    expect(new Set(contracts.P3E_ERROR_CODES).size).toBe(22);
    for (const code of contracts.P3E_ERROR_CODES) expect(code.startsWith("E_P3E_")).toBe(true);
  });

  it("每個錯誤碼都可建構，message 固定", () => {
    for (const code of EXPECTED_ERROR_CODES) {
      const error = new P3EError(code as contracts.P3EErrorCode, "some.path");
      expect(error.code).toBe(code);
      expect(error.path).toBe("some.path");
      expect(error.name).toBe("P3EError");
      expect(error.message).toBe(`${code} at some.path`);
      expect(error).toBeInstanceOf(Error);
      expect(isP3EError(error)).toBe(true);
    }
  });

  it("P3EError 只接受合法錯誤碼", () => {
    for (const bogus of ["E_BOGUS", "", "E_P3C_STATE", "e_p3e_type", 42 as unknown as string]) {
      const error = new P3EError(bogus as contracts.P3EErrorCode, "x");
      expect(error.code).toBe("E_P3E_TYPE");
      expect(error.path).toBe("code");
      expect(error.message).toBe("E_P3E_TYPE at code");
    }
  });
});

describe("P3-E.1a-1.1 P3EError 私有品牌（防原型偽造）", () => {
  it("原生 Error 一律不算", () => {
    expect(isP3EError(new Error("boom"))).toBe(false);
    expect(isP3EError(new TypeError("boom"))).toBe(false);
    expect(isP3EError(new RangeError("boom"))).toBe(false);
  });

  it("Object.create(P3EError.prototype) 不算（沒有跑過建構子）", () => {
    const forged = Object.create(P3EError.prototype) as Record<string, unknown>;
    forged.code = "E_P3E_STATE";
    forged.path = "x";
    forged.name = "P3EError";
    expect(forged).toBeInstanceOf(P3EError);
    expect(isP3EError(forged)).toBe(false);
  });

  it("改 prototype 後不算", () => {
    const real = new P3EError("E_P3E_STATE", "x");
    expect(isP3EError(real)).toBe(true);
    const moved = new P3EError("E_P3E_STATE", "x");
    Object.setPrototypeOf(moved, Object.prototype);
    expect(isP3EError(moved)).toBe(false);
  });

  it("只偽造欄位的 plain object 不算", () => {
    expect(isP3EError({ name: "P3EError", code: "E_P3E_STATE", path: "x" })).toBe(false);
    expect(isP3EError({ code: "E_P3E_STATE" })).toBe(false);
    expect(isP3EError(Object.create(null))).toBe(false);
    expect(isP3EError(null)).toBe(false);
    expect(isP3EError(undefined)).toBe(false);
    expect(isP3EError("E_P3E_STATE")).toBe(false);
  });

  it("品牌是每個實例獨立加入，不會被 prototype 汙染放大", () => {
    const real = new P3EError("E_P3E_TYPE", "x");
    const clone = Object.assign(Object.create(Object.getPrototypeOf(real)), real);
    expect(isP3EError(clone)).toBe(false);
    expect(isP3EError(real)).toBe(true);
  });
});

describe("P3-E.1a-1.1 公開表面", () => {
  it("barrel 公開 P3EError／isP3EError 與版本常數", () => {
    expect(typeof simulation.P3EError).toBe("function");
    expect(typeof simulation.isP3EError).toBe("function");
    expect(simulation.P3E_SCHEMA_VERSION).toBe("p3e-2");
    expect(simulation.P3E_ROLL_SPEC_VERSION).toBe("p3e-roll-1.0.0");
    expect(simulation.P3E_MAX_AGE).toBe(120);
    expect(simulation.P3E_EVENT_DOMAIN).toBe("events");
    expect(simulation.P3E_DEATH_DOMAIN).toBe("p3e/death");
    expect([...simulation.P3E_ERROR_CODES]).toEqual(EXPECTED_ERROR_CODES);
  });

  it("barrel 沒有任何 genesis／roll／stateHash／codec／replay 假入口", () => {
    const forbidden = [
      "createSimulationLife",
      "createGenesis",
      "createSimulationGenesis",
      "rollYear",
      "rollP3EYear",
      "computeStateHash",
      "sealState",
      "assertSimulationState",
      "genesisHeads",
      "createGenesisRng",
      "serializeSimulationState",
      "deserializeSimulationState",
      "reconstructSimulationState",
      "verifySimulationReplay",
      "applySimulationCommand",
      "resolveSimulationYear",
      "assertSimulationStateHash"
    ];
    const surface = simulation as unknown as Record<string, unknown>;
    for (const name of forbidden) expect(surface[name], name).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });
});

describe("P3-E.1a-1.1 套件依賴方向", () => {
  it("simulation 只依賴 contracts、engine、birth", () => {
    const manifest = readJson("packages/simulation/package.json") as { name: string; dependencies: Record<string, string> };
    expect(manifest.name).toBe("@life-sim/simulation");
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@life-sim/birth", "@life-sim/contracts", "@life-sim/engine"]);
    for (const version of Object.values(manifest.dependencies)) expect(version).toBe("workspace:*");
  });

  it("engine 與 birth 沒有新增 simulation 依賴，engine 也沒有依賴 birth", () => {
    for (const path of ["packages/engine/package.json", "packages/birth/package.json"]) {
      const manifest = readJson(path) as { dependencies?: Record<string, string> };
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@life-sim/simulation");
    }
    const engine = readJson("packages/engine/package.json") as { dependencies?: Record<string, string> };
    expect(Object.keys(engine.dependencies ?? {})).not.toContain("@life-sim/birth");
  });
});

describe("P3-E.1a-1.1 契約形狀（必修一～五）", () => {
  it("必修一：identity 綁定包含 playerIdentityHash", () => {
    const state = sampleState();
    expect(Object.keys(state.identity).sort()).toEqual([
      "basePackChecksum",
      "basePackId",
      "birthYear",
      "certificateHash",
      "certificateId",
      "entityId",
      "identityPackChecksum",
      "identityPackId",
      "masterSeedHash",
      "playerIdentityHash",
      "regionCode",
      "sex"
    ]);
    expect(state.identity.playerIdentityHash).toBe(HEX("1"));
  });

  it("必修二：事件包綁定使用 P3-C 權威形狀，且與 P3CEventPackBinding 完全相同", () => {
    const binding: contracts.P3EEventPackBinding = sampleState().packs.events;
    const p3c: contracts.P3CEventPackBinding = binding; // 型別別名：可直接互換
    expect(Object.keys(binding).sort()).toEqual([
      "contentPackVersion",
      "datasetChecksum",
      "eventCount",
      "eventPackChecksum",
      "eventPackId",
      "eventSchemaVersion",
      "eventSpecVersion"
    ]);
    expect(p3c.eventPackId).toBe(binding.eventPackId);
    // 舊形狀的欄位不得存在。
    for (const legacy of ["packId", "packChecksum", "contentVersion", "rulesetVersion"]) {
      expect(Object.keys(binding)).not.toContain(legacy);
    }
  });

  it("必修二裁決：P3E_CONTENT_VERSION 不是事件包的 contentPackVersion", () => {
    const binding = sampleState().packs.events;
    expect(contracts.P3E_CONTENT_VERSION).toBe("skeleton-1.2.0");
    expect(binding.contentPackVersion).toBe("1.0.0");
    expect(binding.contentPackVersion).not.toBe(contracts.P3E_CONTENT_VERSION);
  });

  it("必修三：死亡包綁定補齊 P3-D manifest 的權威欄位", () => {
    const binding: contracts.P3EDeathPackBinding = sampleState().packs.death;
    expect(Object.keys(binding).sort()).toEqual([
      "basePackChecksum",
      "basePackId",
      "deathDataVersion",
      "deathPackChecksum",
      "deathPackId",
      "deathSpecVersion",
      "engineVersion",
      "entityCount",
      "healthRuleVersion",
      "rngSpecVersion",
      "schemaVersion"
    ]);
    expect(typeof binding.entityCount).toBe("number");
  });

  it("必修四：state 包含 engineVersion／rngSpecVersion 且全部版本欄位都在", () => {
    const keys = Object.keys(sampleState());
    for (const key of [
      "schemaVersion",
      "rulesetVersion",
      "rollSpecVersion",
      "lifeSpecVersion",
      "contentVersion",
      "saveFormatVersion",
      "engineVersion",
      "rngSpecVersion"
    ]) {
      expect(keys, key).toContain(key);
    }
  });

  it("必修五：三條 RNG 的 domain 都是 literal，event／death 不可互換", () => {
    const state = sampleState();
    expect(state.rng.life.domain).toBe("life");
    expect(state.rng.events.domain).toBe("events");
    expect(state.rng.death.domain).toBe("p3e/death");
    const events: contracts.P3EEventRngState = state.rng.events;
    const death: contracts.P3EDeathRngState = state.rng.death;
    // @ts-expect-error event 游標不能當 death 游標用
    const crossDeath: contracts.P3EDeathRngState = events;
    // @ts-expect-error life 游標不能當 event 游標用
    const crossEvent: contracts.P3EEventRngState = state.rng.life;
    expect([death.u32Draws, crossDeath, crossEvent].length).toBe(3);
  });

  it("state 形狀不得有 lifespanYears、burn 抽取值或年度陣列", () => {
    const keys = Object.keys(sampleState());
    for (const banned of ["lifespanYears", "burnedValue", "entries", "deltas", "mortality", "cards", "snapshots"]) {
      expect(keys, banned).not.toContain(banned);
    }
    expect(Object.keys(sampleState().commandLog).sort()).toEqual(["count", "headHash"]);
    expect(Object.keys(sampleState().rng.life).sort()).toEqual(["domain", "initialState", "semanticDraws", "state"]);
    expect(Object.keys(sampleState().rng.events).sort()).toEqual(["domain", "initialState", "state", "u32Draws"]);
    expect(typeof sampleState().assets.balanceMicroUsd).toBe("bigint");
  });

  it("command head 使用獨立的 COMMAND/INIT domain", () => {
    expect(contracts.P3E_COMMAND_INIT_DOMAIN).toBe("LIFE1/P3E/COMMAND/INIT/v1");
    expect(contracts.P3E_COMMAND_INIT_DOMAIN).not.toContain("CHAIN");
  });
});

describe("P3-E.1a-1.1 roll 常數", () => {
  it("四步的 stat 與範圍固定，並公開語意抽樣數", () => {
    expect(contracts.P3E_ROLL_STEPS.length).toBe(4);
    expect(contracts.P3E_ROLL_SEMANTIC_DRAWS).toBe(4);
    expect(contracts.P3E_ROLL_STEPS.map((step) => step.stat)).toEqual(["health", "happiness", "knowledge", "relationships"]);
    expect(contracts.P3E_ROLL_STEPS.map((step) => [step.min, step.max])).toEqual([
      [-3, 3],
      [-3, 3],
      [0, 3],
      [-2, 2]
    ]);
  });

  it("收支公式常數在 age 1／59／60／100／120 的 bigint 值正確", () => {
    for (const age of [1, 59, 60, 100, 120]) {
      const income = contracts.P3E_INCOME_BASE_MICRO_USD + BigInt(age) * contracts.P3E_INCOME_PER_YEAR_MICRO_USD;
      const expense = contracts.P3E_EXPENSE_BASE_MICRO_USD + BigInt(age) * contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD;
      expect(income).toBe(BigInt(1_000_000 + age * 100_000));
      expect(expense).toBe(BigInt(600_000 + age * 50_000));
      expect(typeof income).toBe("bigint");
    }
  });
});
