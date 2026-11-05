import { describe, expect, it } from "vitest";
import * as contracts from "@life-sim/contracts";
import { ascii, canonicalBytes, concatBytes, sha256Hex } from "@life-sim/engine";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import {
  computeP3EStateHash,
  createP3EGenesisIntegrity,
  p3eGenesisProjection,
  p3eStateProjection,
  type P3EStateHashInput
} from "../src/state-hash";

/**
 * P3-E.1a-2c-1.1：狀態雜湊（H5-CTO-063-A-R1 循環依賴修正）。
 *
 * 期待值一律**獨立重算**：測試自己用 engine 公開原語
 * （`ascii`／`concatBytes`／`canonicalBytes`／`sha256Hex`）與字面值 domain 重算一次，
 * 不接受「用被測函式算被測函式」。
 */

const HEX = (char: string) => char.repeat(64);

function sampleState(): contracts.P3ELifeState {
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
      certificateHash: HEX("1"),
      playerIdentityHash: HEX("2"),
      masterSeedHash: HEX("3"),
      basePackId: "p2a-synthetic-20261027",
      basePackChecksum: HEX("4"),
      identityPackId: "p2b-synthetic",
      identityPackChecksum: HEX("5")
    },
    packs: {
      events: {
        eventSchemaVersion: "p3b-1",
        eventSpecVersion: "1.0.0",
        contentPackVersion: "1.0.0",
        eventPackId: "p3b-synthetic-events-v1",
        eventPackChecksum: HEX("6"),
        datasetChecksum: HEX("7"),
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
        deathPackChecksum: HEX("8"),
        basePackId: "p2a-synthetic-20261027",
        basePackChecksum: HEX("4"),
        entityCount: 172
      }
    },
    currentYear: 2030,
    age: 30,
    phase: "life",
    pendingDecision: null,
    stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
    assets: { balanceMicroUsd: 1_900_000n, annualIncomeMicroUsd: 4_000_000n, annualExpenseMicroUsd: 2_100_000n },
    flags: ["p3e:flag-a", "p3e:flag-b"],
    occurrences: [
      { eventId: "ev-a", count: 1, lastYear: 2001 },
      { eventId: "ev-b", count: 2, lastYear: 2003 }
    ],
    rng: {
      life: { domain: "life", initialState: [11, 12, 13, 14], state: [21, 22, 23, 24], semanticDraws: 9 },
      events: { domain: "events", initialState: [31, 32, 33, 34], state: [31, 32, 33, 34], u32Draws: 0 },
      death: { domain: "p3e/death", initialState: [41, 42, 43, 44], state: [41, 42, 43, 44], u32Draws: 0 }
    },
    heads: {
      lastEntryHash: HEX("a"),
      lastSnapshotHash: HEX("b"),
      lastDeltaHash: HEX("c"),
      hashChain: HEX("d")
    },
    commandLog: { count: 7, headHash: HEX("e") },
    stateHash: HEX("f")
  };
}

/** 只有 stateHash 輸入允許的最小欄位（不含 stateHash／commandLog／hashChain）。 */
function minimalInput(): P3EStateHashInput {
  const state = sampleState();
  return {
    schemaVersion: state.schemaVersion,
    rulesetVersion: state.rulesetVersion,
    rollSpecVersion: state.rollSpecVersion,
    lifeSpecVersion: state.lifeSpecVersion,
    contentVersion: state.contentVersion,
    saveFormatVersion: state.saveFormatVersion,
    engineVersion: state.engineVersion,
    rngSpecVersion: state.rngSpecVersion,
    identity: state.identity,
    packs: state.packs,
    currentYear: state.currentYear,
    age: state.age,
    phase: state.phase,
    pendingDecision: state.pendingDecision,
    stats: state.stats,
    assets: state.assets,
    flags: state.flags,
    occurrences: state.occurrences,
    rng: state.rng,
    heads: {
      lastEntryHash: state.heads.lastEntryHash,
      lastSnapshotHash: state.heads.lastSnapshotHash,
      lastDeltaHash: state.heads.lastDeltaHash
    }
  };
}

const sampleBinding = (): Record<string, unknown> => sampleState() as unknown as Record<string, unknown>;

/** 深度可變副本（structuredClone 支援 bigint）；型別上放寬成 record 以便逐欄位改。 */
function mutableState(): Record<string, unknown> {
  return structuredClone(sampleState()) as unknown as Record<string, unknown>;
}

/** 測試自己的獨立重算：字面值 domain ＋ canonicalBytes ＋ sha256Hex。 */
function manualHash(domain: string, projection: unknown): string {
  return sha256Hex(concatBytes(ascii(domain), Uint8Array.of(0), canonicalBytes(projection as never)));
}

const HEX64 = /^[0-9a-f]{64}$/;

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function expectFixedP3EError(run: () => unknown, code: string, path: string): void {
  const caught = catchError(run);
  expect(isP3EError(caught), `${code} at ${path}`).toBe(true);
  const error = caught as P3EError;
  expect(error.code).toBe(code);
  expect(error.path).toBe(path);
  expect(error.message).toBe(`${code} at ${path}`);
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
  expect((caught as { name?: string }).name).toBe("P3EError");
}

/* ------------------------------------------------------------------ */
/* 一、公開表面與格式                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-1.1 公開表面", () => {
  it("兩個原語都在套件內部，不在公開 barrel", () => {
    expect(typeof computeP3EStateHash).toBe("function");
    expect(typeof createP3EGenesisIntegrity).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.computeP3EStateHash).toBeUndefined();
    expect(surface.createP3EGenesisIntegrity).toBeUndefined();
    expect(surface.p3eStateProjection).toBeUndefined();
    expect(surface.p3eGenesisProjection).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("所有輸出都是 64 位小寫十六進位", () => {
    const stateHash = computeP3EStateHash(sampleState());
    expect(stateHash).toMatch(HEX64);
    expect(stateHash.length).toBe(64);
    const integrity = createP3EGenesisIntegrity(sampleBinding() as unknown as contracts.P3ELifeState);
    for (const value of [
      integrity.heads.lastEntryHash,
      integrity.heads.lastSnapshotHash,
      integrity.heads.lastDeltaHash,
      integrity.heads.hashChain,
      integrity.commandLog.headHash
    ]) {
      expect(value).toMatch(HEX64);
      expect(value.length).toBe(64);
      expect(value).toBe(value.toLowerCase());
    }
    expect(integrity.commandLog.count).toBe(0);
  });

  it("回傳物件與 heads／commandLog 都是凍結的", () => {
    const integrity = createP3EGenesisIntegrity(sampleBinding() as unknown as contracts.P3ELifeState);
    expect(Object.isFrozen(integrity)).toBe(true);
    expect(Object.isFrozen(integrity.heads)).toBe(true);
    expect(Object.isFrozen(integrity.commandLog)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 二、決定性                                                          */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-1.1 決定性", () => {
  it("相同輸入重跑 100 次完全一致", () => {
    const state = sampleState();
    const binding = sampleBinding() as unknown as contracts.P3ELifeState;
    const firstStateHash = computeP3EStateHash(state);
    const firstIntegrity = createP3EGenesisIntegrity(binding);
    for (let index = 0; index < 100; index += 1) {
      expect(computeP3EStateHash(sampleState())).toBe(firstStateHash);
      expect(createP3EGenesisIntegrity(binding)).toEqual(firstIntegrity);
    }
  });

  it("不同物件實例、相同內容 → 相同 hash", () => {
    expect(computeP3EStateHash(structuredClone(sampleState()))).toBe(computeP3EStateHash(sampleState()));
    expect(
      createP3EGenesisIntegrity(structuredClone(sampleState()) as unknown as contracts.P3ELifeState)
    ).toEqual(createP3EGenesisIntegrity(sampleBinding() as unknown as contracts.P3ELifeState));
  });

  it("不修改輸入（含深凍結的輸入）", () => {
    const state = sampleState();
    const before = structuredClone(state);
    computeP3EStateHash(state);
    createP3EGenesisIntegrity(state);
    expect(state).toEqual(before);

    const frozen = Object.freeze(structuredClone(state)) as contracts.P3ELifeState;
    expect(() => computeP3EStateHash(frozen)).not.toThrow();
    expect(computeP3EStateHash(frozen)).toBe(computeP3EStateHash(sampleState()));
  });
});

/* ------------------------------------------------------------------ */
/* 三、獨立重算（domain ＋ 方案）                                      */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-1.1 雜湊方案", () => {
  it("stateHash 等於 sha256Hex(STATE domain ‖ 0x00 ‖ canonicalBytes(projection))", () => {
    expect(manualHash("LIFE1/P3E/STATE/v1", p3eStateProjection(sampleState()))).toBe(
      computeP3EStateHash(sampleState())
    );
    expect(manualHash("LIFE1/P3E/STATE/v1", p3eStateProjection(minimalInput()))).toBe(
      computeP3EStateHash(minimalInput())
    );
  });

  it("四個 head 與 command head 各自使用固定 domain", () => {
    const binding = sampleBinding() as unknown as contracts.P3ELifeState;
    const projection = p3eGenesisProjection(binding);
    const integrity = createP3EGenesisIntegrity(binding);

    expect(contracts.P3E_COMMAND_INIT_DOMAIN).toBe("LIFE1/P3E/COMMAND/INIT/v1");
    expect(manualHash("LIFE1/P3E/LOG/v1", projection)).toBe(integrity.heads.lastEntryHash);
    expect(manualHash("LIFE1/P3E/SNAPSHOT/v1", projection)).toBe(integrity.heads.lastSnapshotHash);
    expect(manualHash("LIFE1/P3E/DELTA/v1", projection)).toBe(integrity.heads.lastDeltaHash);
    expect(manualHash("LIFE1/P3E/CHAIN/INIT/v1", projection)).toBe(integrity.heads.hashChain);
    expect(manualHash(contracts.P3E_COMMAND_INIT_DOMAIN, projection)).toBe(integrity.commandLog.headHash);
  });

  it("不同 domain 的同一份 projection 不會碰撞", () => {
    const projection = p3eGenesisProjection(sampleBinding() as unknown as contracts.P3ELifeState);
    const digests = new Set([
      manualHash("LIFE1/P3E/STATE/v1", projection),
      manualHash("LIFE1/P3E/LOG/v1", projection),
      manualHash("LIFE1/P3E/SNAPSHOT/v1", projection),
      manualHash("LIFE1/P3E/DELTA/v1", projection),
      manualHash("LIFE1/P3E/CHAIN/INIT/v1", projection),
      manualHash(contracts.P3E_COMMAND_INIT_DOMAIN, projection)
    ]);
    expect(digests.size).toBe(6);
  });
});

/* ------------------------------------------------------------------ */
/* 四、Genesis integrity（定義未改）                                   */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-1.1 genesis integrity", () => {
  it("五個 genesis 初始 head 全部不同", () => {
    const integrity = createP3EGenesisIntegrity(sampleBinding() as unknown as contracts.P3ELifeState);
    const heads = new Set([
      integrity.heads.lastEntryHash,
      integrity.heads.lastSnapshotHash,
      integrity.heads.lastDeltaHash,
      integrity.heads.hashChain,
      integrity.commandLog.headHash
    ]);
    expect(heads.size).toBe(5);
  });

  it("command head 不得等於一般 chain head（也不得等於其他 head）", () => {
    const integrity = createP3EGenesisIntegrity(sampleBinding() as unknown as contracts.P3ELifeState);
    expect(integrity.commandLog.headHash).not.toBe(integrity.heads.hashChain);
    expect(integrity.commandLog.headHash).not.toBe(integrity.heads.lastEntryHash);
    expect(integrity.commandLog.headHash).not.toBe(integrity.heads.lastSnapshotHash);
    expect(integrity.commandLog.headHash).not.toBe(integrity.heads.lastDeltaHash);
    expect(integrity.heads.hashChain).not.toBe(integrity.heads.lastEntryHash);
  });

  it("genesis projection 只含八個版本、identity 與 packs，且逐欄位明確", () => {
    const projection = p3eGenesisProjection(sampleBinding() as unknown as contracts.P3ELifeState);
    expect(Object.keys(projection).sort()).toEqual([
      "contentVersion",
      "engineVersion",
      "identity",
      "lifeSpecVersion",
      "packs",
      "rngSpecVersion",
      "rollSpecVersion",
      "rulesetVersion",
      "saveFormatVersion",
      "schemaVersion"
    ]);
    expect(Object.keys(projection.identity).sort()).toEqual([
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
    expect(Object.keys(projection.packs.events).sort()).toEqual([
      "contentPackVersion",
      "datasetChecksum",
      "eventCount",
      "eventPackChecksum",
      "eventPackId",
      "eventSchemaVersion",
      "eventSpecVersion"
    ]);
    expect(Object.keys(projection.packs.death).sort()).toEqual([
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
    for (const banned of ["currentYear", "age", "phase", "stats", "assets", "flags", "occurrences", "rng", "heads", "commandLog", "stateHash"]) {
      expect(Object.keys(projection), banned).not.toContain(banned);
    }
  });

  it("改任一版本／identity／pack 綁定欄位，五個 head 都必須改變", () => {
    const base = createP3EGenesisIntegrity(sampleBinding() as unknown as contracts.P3ELifeState);
    const mutations: readonly [string, (binding: Record<string, unknown>) => void][] = [
      ["schemaVersion", (b) => { b.schemaVersion = "p3e-1"; }],
      ["rulesetVersion", (b) => { b.rulesetVersion = "p3e-9.9.9"; }],
      ["rollSpecVersion", (b) => { b.rollSpecVersion = "p3e-roll-9.9.9"; }],
      ["lifeSpecVersion", (b) => { b.lifeSpecVersion = "9.9.9"; }],
      ["contentVersion", (b) => { b.contentVersion = "skeleton-9.9.9"; }],
      ["saveFormatVersion", (b) => { b.saveFormatVersion = 5; }],
      ["engineVersion", (b) => { b.engineVersion = "9.9.9"; }],
      ["rngSpecVersion", (b) => { b.rngSpecVersion = "9.9.9"; }],
      ["identity.entityId", (b) => { identityOf(b).entityId = "cr:ALB"; }],
      ["identity.regionCode", (b) => { identityOf(b).regionCode = "ALB"; }],
      ["identity.sex", (b) => { identityOf(b).sex = "male"; }],
      ["identity.birthYear", (b) => { identityOf(b).birthYear = 2001; }],
      ["identity.certificateId", (b) => { identityOf(b).certificateId = "cert:1"; }],
      ["identity.certificateHash", (b) => { identityOf(b).certificateHash = HEX("9"); }],
      ["identity.playerIdentityHash", (b) => { identityOf(b).playerIdentityHash = HEX("9"); }],
      ["identity.masterSeedHash", (b) => { identityOf(b).masterSeedHash = HEX("9"); }],
      ["identity.basePackId", (b) => { identityOf(b).basePackId = "p2a-other"; }],
      ["identity.basePackChecksum", (b) => { identityOf(b).basePackChecksum = HEX("9"); }],
      ["identity.identityPackId", (b) => { identityOf(b).identityPackId = "p2b-other"; }],
      ["identity.identityPackChecksum", (b) => { identityOf(b).identityPackChecksum = HEX("9"); }],
      ["packs.events.eventSchemaVersion", (b) => { eventsOf(b).eventSchemaVersion = "p3b-2"; }],
      ["packs.events.eventSpecVersion", (b) => { eventsOf(b).eventSpecVersion = "2.0.0"; }],
      ["packs.events.contentPackVersion", (b) => { eventsOf(b).contentPackVersion = "2.0.0"; }],
      ["packs.events.eventPackId", (b) => { eventsOf(b).eventPackId = "p3b-other"; }],
      ["packs.events.eventPackChecksum", (b) => { eventsOf(b).eventPackChecksum = HEX("9"); }],
      ["packs.events.datasetChecksum", (b) => { eventsOf(b).datasetChecksum = HEX("9"); }],
      ["packs.events.eventCount", (b) => { eventsOf(b).eventCount = 23; }],
      ["packs.death.schemaVersion", (b) => { deathOf(b).schemaVersion = "p3d-2"; }],
      ["packs.death.deathDataVersion", (b) => { deathOf(b).deathDataVersion = "2.0.0"; }],
      ["packs.death.deathSpecVersion", (b) => { deathOf(b).deathSpecVersion = "2.0.0"; }],
      ["packs.death.healthRuleVersion", (b) => { deathOf(b).healthRuleVersion = "p3d-health-2.0.0"; }],
      ["packs.death.engineVersion", (b) => { deathOf(b).engineVersion = "9.9.9"; }],
      ["packs.death.rngSpecVersion", (b) => { deathOf(b).rngSpecVersion = "9.9.9"; }],
      ["packs.death.deathPackId", (b) => { deathOf(b).deathPackId = "p3d-other"; }],
      ["packs.death.deathPackChecksum", (b) => { deathOf(b).deathPackChecksum = HEX("9"); }],
      ["packs.death.basePackId", (b) => { deathOf(b).basePackId = "p2a-other"; }],
      ["packs.death.basePackChecksum", (b) => { deathOf(b).basePackChecksum = HEX("9"); }],
      ["packs.death.entityCount", (b) => { deathOf(b).entityCount = 173; }]
    ];
    expect(mutations.length).toBe(38);

    for (const [label, mutate] of mutations) {
      const copy = structuredClone(sampleBinding());
      mutate(copy);
      const changed = createP3EGenesisIntegrity(copy as unknown as contracts.P3ELifeState);
      expect(changed.heads.lastEntryHash, label).not.toBe(base.heads.lastEntryHash);
      expect(changed.heads.lastSnapshotHash, label).not.toBe(base.heads.lastSnapshotHash);
      expect(changed.heads.lastDeltaHash, label).not.toBe(base.heads.lastDeltaHash);
      expect(changed.heads.hashChain, label).not.toBe(base.heads.hashChain);
      expect(changed.commandLog.headHash, label).not.toBe(base.commandLog.headHash);
    }
  });

  it("傳入完整 P3ELifeState 與只傳 binding 的結果相同（結構相容）", () => {
    const state = sampleState();
    expect(createP3EGenesisIntegrity(state)).toEqual(
      createP3EGenesisIntegrity({
        schemaVersion: state.schemaVersion,
        rulesetVersion: state.rulesetVersion,
        rollSpecVersion: state.rollSpecVersion,
        lifeSpecVersion: state.lifeSpecVersion,
        contentVersion: state.contentVersion,
        saveFormatVersion: state.saveFormatVersion,
        engineVersion: state.engineVersion,
        rngSpecVersion: state.rngSpecVersion,
        identity: state.identity,
        packs: state.packs
      })
    );
  });
});

/* ------------------------------------------------------------------ */
/* 五、State projection：納入哪些欄位、排除哪些欄位                    */
/* ------------------------------------------------------------------ */

/** 計算 projection 的「可被單一欄位變更命中的 slot」數（tuple 的 4 個字各自算一格）。 */
function countHashSlots(value: unknown): number {
  if (Array.isArray(value)) {
    const allNumbers = value.every((item) => typeof item === "number");
    return allNumbers && value.length === 4 ? 4 : 1;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.keys(record).reduce<number>((sum, key) => sum + countHashSlots(record[key]), 0);
  }
  return 1;
}

describe("P3-E.1a-2c-1.1 state projection", () => {
  it("projection 恰好是「除 stateHash／commandLog／heads.hashChain 以外的權威欄位」", () => {
    const projection = p3eStateProjection(sampleState());
    expect(Object.keys(projection).sort()).toEqual([
      "age",
      "assets",
      "contentVersion",
      "currentYear",
      "engineVersion",
      "flags",
      "heads",
      "identity",
      "lifeSpecVersion",
      "occurrences",
      "packs",
      "pendingDecision",
      "phase",
      "rng",
      "rngSpecVersion",
      "rollSpecVersion",
      "rulesetVersion",
      "saveFormatVersion",
      "schemaVersion",
      "stats"
    ]);
    for (const banned of ["stateHash", "commandLog", "lifespanYears", "burnedValue", "years", "entries", "deltas", "snapshots", "draws"]) {
      expect(Object.keys(projection), banned).not.toContain(banned);
    }
    // heads 只留三個鏈尾，hashChain 必須被排除
    expect(Object.keys(projection.heads).sort()).toEqual(["lastDeltaHash", "lastEntryHash", "lastSnapshotHash"]);
    expect(Object.keys(projection.heads)).not.toContain("hashChain");
    expect(Object.keys(projection.rng).sort()).toEqual(["death", "events", "life"]);
    expect(Object.keys(projection.rng.life).sort()).toEqual(["domain", "initialState", "semanticDraws", "state"]);
    expect(Object.keys(projection.rng.events).sort()).toEqual(["domain", "initialState", "state", "u32Draws"]);
    expect(Object.keys(projection.rng.death).sort()).toEqual(["domain", "initialState", "state", "u32Draws"]);
    expect(Object.keys(projection.assets).sort()).toEqual([
      "annualExpenseMicroUsd",
      "annualIncomeMicroUsd",
      "balanceMicroUsd"
    ]);
    // 與 genesis projection 的關係：state 一定包含 genesis 的全部欄位
    const genesis = p3eGenesisProjection(sampleState());
    for (const key of Object.keys(genesis)) expect(Object.keys(projection)).toContain(key);
  });

  it("實際納入欄位 = 84 個 slot（可被單一欄位變更命中）", () => {
    expect(countHashSlots(p3eStateProjection(sampleState()))).toBe(84);
    expect(countHashSlots(p3eStateProjection(minimalInput()))).toBe(84);
  });

  it("84/84 全覆蓋：每一格都有一個變更使它改變 stateHash", () => {
    const baseHash = computeP3EStateHash(sampleState());

    const scalarMutations: readonly [string, (state: Record<string, unknown>) => void][] = [
      /* 八個版本 */
      ["schemaVersion", (s) => { s.schemaVersion = "p3e-1"; }],
      ["rulesetVersion", (s) => { s.rulesetVersion = "p3e-9.9.9"; }],
      ["rollSpecVersion", (s) => { s.rollSpecVersion = "p3e-roll-9.9.9"; }],
      ["lifeSpecVersion", (s) => { s.lifeSpecVersion = "9.9.9"; }],
      ["contentVersion", (s) => { s.contentVersion = "skeleton-9.9.9"; }],
      ["saveFormatVersion", (s) => { s.saveFormatVersion = 5; }],
      ["engineVersion", (s) => { s.engineVersion = "9.9.9"; }],
      ["rngSpecVersion", (s) => { s.rngSpecVersion = "9.9.9"; }],
      /* identity 12 欄 */
      ["identity.entityId", (s) => { identityOf(s).entityId = "cr:ALB"; }],
      ["identity.regionCode", (s) => { identityOf(s).regionCode = "ALB"; }],
      ["identity.sex", (s) => { identityOf(s).sex = "male"; }],
      ["identity.birthYear", (s) => { identityOf(s).birthYear = 2001; }],
      ["identity.certificateId", (s) => { identityOf(s).certificateId = "cert:1"; }],
      ["identity.certificateHash", (s) => { identityOf(s).certificateHash = HEX("9"); }],
      ["identity.playerIdentityHash", (s) => { identityOf(s).playerIdentityHash = HEX("9"); }],
      ["identity.masterSeedHash", (s) => { identityOf(s).masterSeedHash = HEX("9"); }],
      ["identity.basePackId", (s) => { identityOf(s).basePackId = "p2a-other"; }],
      ["identity.basePackChecksum", (s) => { identityOf(s).basePackChecksum = HEX("9"); }],
      ["identity.identityPackId", (s) => { identityOf(s).identityPackId = "p2b-other"; }],
      ["identity.identityPackChecksum", (s) => { identityOf(s).identityPackChecksum = HEX("9"); }],
      /* packs.events 7 欄 */
      ["packs.events.eventSchemaVersion", (s) => { eventsOf(s).eventSchemaVersion = "p3b-2"; }],
      ["packs.events.eventSpecVersion", (s) => { eventsOf(s).eventSpecVersion = "2.0.0"; }],
      ["packs.events.contentPackVersion", (s) => { eventsOf(s).contentPackVersion = "2.0.0"; }],
      ["packs.events.eventPackId", (s) => { eventsOf(s).eventPackId = "p3b-other"; }],
      ["packs.events.eventPackChecksum", (s) => { eventsOf(s).eventPackChecksum = HEX("9"); }],
      ["packs.events.datasetChecksum", (s) => { eventsOf(s).datasetChecksum = HEX("9"); }],
      ["packs.events.eventCount", (s) => { eventsOf(s).eventCount = 23; }],
      /* packs.death 11 欄 */
      ["packs.death.schemaVersion", (s) => { deathOf(s).schemaVersion = "p3d-2"; }],
      ["packs.death.deathDataVersion", (s) => { deathOf(s).deathDataVersion = "2.0.0"; }],
      ["packs.death.deathSpecVersion", (s) => { deathOf(s).deathSpecVersion = "2.0.0"; }],
      ["packs.death.healthRuleVersion", (s) => { deathOf(s).healthRuleVersion = "p3d-health-2.0.0"; }],
      ["packs.death.engineVersion", (s) => { deathOf(s).engineVersion = "9.9.9"; }],
      ["packs.death.rngSpecVersion", (s) => { deathOf(s).rngSpecVersion = "9.9.9"; }],
      ["packs.death.deathPackId", (s) => { deathOf(s).deathPackId = "p3d-other"; }],
      ["packs.death.deathPackChecksum", (s) => { deathOf(s).deathPackChecksum = HEX("9"); }],
      ["packs.death.basePackId", (s) => { deathOf(s).basePackId = "p2a-other"; }],
      ["packs.death.basePackChecksum", (s) => { deathOf(s).basePackChecksum = HEX("9"); }],
      ["packs.death.entityCount", (s) => { deathOf(s).entityCount = 173; }],
      /* 年度與階段 */
      ["currentYear", (s) => { s.currentYear = 2031; }],
      ["age", (s) => { s.age = 31; }],
      ["phase", (s) => { s.phase = "pending_decision"; }],
      /* pendingDecision（null → 摘要）：整格算一個 slot */
      ["pendingDecision", (s) => { s.pendingDecision = { year: 2030, age: 30, eventId: "ev-a", decisionId: "dec-a", selectionHash: HEX("f"), optionIds: ["rent", "save"] }; }],
      /* stats 4 欄 */
      ["stats.health", (s) => { statsOf(s).health = 61; }],
      ["stats.happiness", (s) => { statsOf(s).happiness = 56; }],
      ["stats.knowledge", (s) => { statsOf(s).knowledge = 41; }],
      ["stats.relationships", (s) => { statsOf(s).relationships = 36; }],
      /* assets 3 欄 */
      ["assets.balanceMicroUsd", (s) => { assetsOf(s).balanceMicroUsd = 1_900_001n; }],
      ["assets.annualIncomeMicroUsd", (s) => { assetsOf(s).annualIncomeMicroUsd = 4_000_001n; }],
      ["assets.annualExpenseMicroUsd", (s) => { assetsOf(s).annualExpenseMicroUsd = 2_100_001n; }],
      /* flags 與 occurrences（各自算一格：順序敏感另外測） */
      ["flags", (s) => { (s.flags as string[])[0] = "p3e:flag-z"; }],
      ["occurrences", (s) => { occurrencesOf(s)[0] = { eventId: "ev-a", count: 9, lastYear: 2001 }; }],
      /* RNG domain 與計數 */
      ["rng.life.domain", (s) => { lifeOf(s).domain = "life "; }],
      ["rng.life.semanticDraws", (s) => { lifeOf(s).semanticDraws = 10; }],
      ["rng.events.domain", (s) => { eventsRngOf(s).domain = "events "; }],
      ["rng.events.u32Draws", (s) => { eventsRngOf(s).u32Draws = 4; }],
      ["rng.death.domain", (s) => { deathRngOf(s).domain = "p3e/death "; }],
      ["rng.death.u32Draws", (s) => { deathRngOf(s).u32Draws = 4; }],
      /* heads 三個鏈尾 */
      ["heads.lastEntryHash", (s) => { headsOf(s).lastEntryHash = HEX("9"); }],
      ["heads.lastSnapshotHash", (s) => { headsOf(s).lastSnapshotHash = HEX("9"); }],
      ["heads.lastDeltaHash", (s) => { headsOf(s).lastDeltaHash = HEX("9"); }]
    ];
    expect(scalarMutations.length).toBe(60);

    /* RNG 六個 tuple 的每一個字（0..3）：共 24 格，其中 18 格是本批新增的反例 */
    const cursors: readonly [string, (state: Record<string, unknown>) => Record<string, unknown>][] = [
      ["rng.life", lifeOf],
      ["rng.events", eventsRngOf],
      ["rng.death", deathRngOf]
    ];
    const wordMutations: [string, (state: Record<string, unknown>) => void][] = [];
    for (const [label, cursorOf] of cursors) {
      for (const tuple of ["initialState", "state"] as const) {
        for (let index = 0; index < 4; index += 1) {
          wordMutations.push(buildWordMutation(`${label}.${tuple}[${index}]`, cursorOf, tuple, index));
        }
      }
    }
    expect(wordMutations.length).toBe(24);

    const mutations = [...scalarMutations, ...wordMutations];
    expect(mutations.length).toBe(84);

    const hashes = new Set<string>();
    for (const [label, mutate] of mutations) {
      const copy = mutableState();
      mutate(copy);
      const hash = computeP3EStateHash(copy as unknown as P3EStateHashInput);
      expect(hash, label).not.toBe(baseHash);
      hashes.add(hash);
    }
    // 84 個變更互不重複，且都不同於基準
    expect(hashes.size).toBe(84);
    expect(hashes.has(baseHash)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 六、負控：被排除的欄位不得影響 stateHash                            */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-1.1 排除欄位的負控", () => {
  it("改 stateHash／heads.hashChain／commandLog 都不影響計算結果", () => {
    const baseHash = computeP3EStateHash(sampleState());

    const stateHashChanged = mutableState();
    stateHashChanged.stateHash = HEX("0");
    expect(computeP3EStateHash(stateHashChanged as unknown as P3EStateHashInput)).toBe(baseHash);

    const chainChanged = mutableState();
    headsOf(chainChanged).hashChain = HEX("0");
    expect(computeP3EStateHash(chainChanged as unknown as P3EStateHashInput)).toBe(baseHash);

    const countChanged = mutableState();
    commandLogOf(countChanged).count = 9_999;
    expect(computeP3EStateHash(countChanged as unknown as P3EStateHashInput)).toBe(baseHash);

    const headChanged = mutableState();
    commandLogOf(headChanged).headHash = HEX("0");
    expect(computeP3EStateHash(headChanged as unknown as P3EStateHashInput)).toBe(baseHash);

    // 四項一起改也一樣
    const allChanged = mutableState();
    allChanged.stateHash = HEX("0");
    headsOf(allChanged).hashChain = HEX("0");
    commandLogOf(allChanged).count = 0;
    commandLogOf(allChanged).headHash = HEX("0");
    expect(computeP3EStateHash(allChanged as unknown as P3EStateHashInput)).toBe(baseHash);
  });

  it("完全不提供那四項的最小輸入，也能算出與完整 state 相同的 hash", () => {
    const minimal = minimalInput();
    expect(Object.keys(minimal)).not.toContain("stateHash");
    expect(Object.keys(minimal)).not.toContain("commandLog");
    expect(Object.keys(minimal.heads)).not.toContain("hashChain");
    expect(computeP3EStateHash(minimal)).toBe(computeP3EStateHash(sampleState()));
  });

  it("完整 state 多出來的欄位不會改變 projection 的鍵集合", () => {
    expect(Object.keys(p3eStateProjection(minimalInput())).sort()).toEqual(
      Object.keys(p3eStateProjection(sampleState())).sort()
    );
    expect(p3eStateProjection(minimalInput())).toEqual(p3eStateProjection(sampleState()));
  });
});

/* ------------------------------------------------------------------ */
/* 七、順序與型別語意                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-1.1 順序與型別", () => {
  it("只改屬性排列順序，hash 不變", () => {
    const baseHash = computeP3EStateHash(sampleState());
    const reordered = reverseKeys(sampleState()) as contracts.P3ELifeState;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(sampleState()));
    expect(computeP3EStateHash(reordered)).toBe(baseHash);

    const shuffledBinding = reverseKeys(sampleBinding());
    expect(createP3EGenesisIntegrity(shuffledBinding as unknown as contracts.P3ELifeState)).toEqual(
      createP3EGenesisIntegrity(sampleBinding() as unknown as contracts.P3ELifeState)
    );
  });

  it("flags 與 occurrences 的順序屬權威語意：交換後 hash 必須改變", () => {
    const swappedFlags = mutableState();
    const flags = swappedFlags.flags as string[];
    const firstFlag = flags[0] as string;
    flags[0] = flags[1] as string;
    flags[1] = firstFlag;
    expect(computeP3EStateHash(swappedFlags as unknown as P3EStateHashInput)).not.toBe(
      computeP3EStateHash(sampleState())
    );

    const swappedOccurrences = mutableState();
    const occurrences = swappedOccurrences.occurrences as unknown[];
    const firstOccurrence = occurrences[0];
    occurrences[0] = occurrences[1];
    occurrences[1] = firstOccurrence;
    expect(computeP3EStateHash(swappedOccurrences as unknown as P3EStateHashInput)).not.toBe(
      computeP3EStateHash(sampleState())
    );
  });

  it("flags／occurrences 的長度也是權威語意", () => {
    const longerFlags = mutableState();
    (longerFlags.flags as string[]).push("p3e:flag-c");
    expect(computeP3EStateHash(longerFlags as unknown as P3EStateHashInput)).not.toBe(
      computeP3EStateHash(sampleState())
    );

    const longerOccurrences = mutableState();
    (longerOccurrences.occurrences as unknown[]).push({ eventId: "ev-c", count: 1, lastYear: 2004 });
    expect(computeP3EStateHash(longerOccurrences as unknown as P3EStateHashInput)).not.toBe(
      computeP3EStateHash(sampleState())
    );
  });

  it("bigint 與 number 不會得到相同 canonical hash", () => {
    const bigintState = mutableState();
    assetsOf(bigintState).balanceMicroUsd = 5n;
    const numberState = mutableState();
    assetsOf(numberState).balanceMicroUsd = 5;
    const bigintHash = computeP3EStateHash(bigintState as unknown as P3EStateHashInput);
    const numberHash = computeP3EStateHash(numberState as unknown as P3EStateHashInput);
    expect(bigintHash).not.toBe(numberHash);
    expect(numberHash).not.toBe(computeP3EStateHash(sampleState()));
  });
});

/* ------------------------------------------------------------------ */
/* 八、錯誤邊界                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-1.1 錯誤邊界", () => {
  it("state 不是物件 → E_P3E_STATE at state", () => {
    for (const value of [null, undefined, 42, "state", true, []]) {
      expectFixedP3EError(() => computeP3EStateHash(value as unknown as P3EStateHashInput), "E_P3E_STATE", "state");
    }
  });

  it("binding 不是物件 → E_P3E_BINDING at binding", () => {
    for (const value of [null, undefined, 42, "binding", true, []]) {
      expectFixedP3EError(
        () => createP3EGenesisIntegrity(value as unknown as contracts.P3ELifeState),
        "E_P3E_BINDING",
        "binding"
      );
    }
  });

  it("缺欄位或無法 canonical 編碼 → 固定 P3EError（不外洩 CanonicalError／TypeError）", () => {
    expectFixedP3EError(() => computeP3EStateHash({} as P3EStateHashInput), "E_P3E_STATE", "state");
    const noPacks = mutableState();
    delete noPacks.packs;
    expectFixedP3EError(() => computeP3EStateHash(noPacks as unknown as P3EStateHashInput), "E_P3E_STATE", "state");
    const badNumber = mutableState();
    badNumber.age = 1.5;
    expectFixedP3EError(() => computeP3EStateHash(badNumber as unknown as P3EStateHashInput), "E_P3E_STATE", "state");
    const undefinedField = mutableState();
    delete undefinedField.phase;
    expectFixedP3EError(
      () => computeP3EStateHash(undefinedField as unknown as P3EStateHashInput),
      "E_P3E_STATE",
      "state"
    );
    expectFixedP3EError(() => createP3EGenesisIntegrity({} as contracts.P3ELifeState), "E_P3E_BINDING", "binding");
  });
});

/* ------------------------------------------------------------------ */
/* 九、測試輔助                                                        */
/* ------------------------------------------------------------------ */

type Record_ = Record<string, unknown>;

const identityOf = (value: Record_): Record_ => value.identity as Record_;
const packsOf = (value: Record_): Record_ => value.packs as Record_;
const eventsOf = (value: Record_): Record_ => packsOf(value).events as Record_;
const deathOf = (value: Record_): Record_ => packsOf(value).death as Record_;
const statsOf = (value: Record_): Record_ => value.stats as Record_;
const assetsOf = (value: Record_): Record_ => value.assets as Record_;
const rngOf = (value: Record_): Record_ => value.rng as Record_;
const lifeOf = (value: Record_): Record_ => rngOf(value).life as Record_;
const eventsRngOf = (value: Record_): Record_ => rngOf(value).events as Record_;
const deathRngOf = (value: Record_): Record_ => rngOf(value).death as Record_;
const headsOf = (value: Record_): Record_ => value.heads as Record_;
const commandLogOf = (value: Record_): Record_ => value.commandLog as Record_;
const occurrencesOf = (value: Record_): Record_[] => value.occurrences as Record_[];

/** 建立「把某個 RNG tuple 的第 index 個字改掉」的變更案例。 */
function buildWordMutation(
  label: string,
  cursorOf: (state: Record_) => Record_,
  tuple: "initialState" | "state",
  index: number
): [string, (state: Record_) => void] {
  return [
    label,
    (state) => {
      const words = cursorOf(state)[tuple] as number[];
      const current = words[index] as number;
      words[index] = current + 50_000;
    }
  ];
}

/** 遞迴把物件的鍵順序反轉（陣列順序保持不變）。 */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => reverseKeys(item)) as unknown as T;
  if (typeof value === "object" && value !== null) {
    const source = value as Record_;
    const out: Record_ = {};
    for (const key of Object.keys(source).reverse()) out[key] = reverseKeys(source[key]);
    return out as unknown as T;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* P3-E.1b-1f-0：pendingDecision 進入權威 projection                    */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1f-0 pendingDecision 與 stateHash", () => {
  const SUMMARY: contracts.P3EPendingDecisionSummary = {
    year: 2030,
    age: 30,
    eventId: "ev.adult.housing-choice",
    decisionId: "dec.adult.housing",
    selectionHash: HEX("f"),
    optionIds: ["rent", "save"]
  };

  function withPending(): Record<string, unknown> {
    const state = mutableState();
    state.pendingDecision = structuredClone(SUMMARY) as unknown as Record<string, unknown>;
    return state;
  }

  const hashOf = (state: Record<string, unknown>): string =>
    computeP3EStateHash(state as unknown as P3EStateHashInput);

  it("null 與非 null 產生不同 hash", () => {
    const without = hashOf(mutableState());
    const withSummary = hashOf(withPending());
    expect(withSummary).not.toBe(without);
    // pendingDecision 本身確實在 projection 內
    expect(Object.keys(p3eStateProjection(withPending() as unknown as P3EStateHashInput))).toContain("pendingDecision");
    expect(p3eStateProjection(withPending() as unknown as P3EStateHashInput).pendingDecision).not.toBeNull();
  });

  it("六個欄位任一變更都改變 hash", () => {
    const base = hashOf(withPending());
    const mutations: readonly [string, (pending: Record<string, unknown>) => void][] = [
      ["year", (p) => { p.year = 2031; }],
      ["age", (p) => { p.age = 31; }],
      ["eventId", (p) => { p.eventId = "ev.other"; }],
      ["decisionId", (p) => { p.decisionId = "dec.other"; }],
      ["selectionHash", (p) => { p.selectionHash = HEX("9"); }],
      ["optionIds", (p) => { p.optionIds = ["rent", "save", "wait"]; }],
      ["optionIds[0]", (p) => { (p.optionIds as string[])[0] = "buy"; }]
    ];
    const seen = new Set<string>([base]);
    for (const [label, change] of mutations) {
      const state = withPending();
      change(state.pendingDecision as Record<string, unknown>);
      const hash = hashOf(state);
      expect(hash, label).not.toBe(base);
      seen.add(hash);
    }
    // 每個變更都互不相同
    expect(seen.size).toBe(mutations.length + 1);
  });

  it("optionIds 順序影響 hash（換序 → 不同 hash）", () => {
    const forward = withPending();
    const backward = withPending();
    (backward.pendingDecision as Record<string, unknown>).optionIds = ["save", "rent"];
    expect(hashOf(forward)).not.toBe(hashOf(backward));
  });

  it("pendingDecision 不影響 null 以外的排除欄位規則", () => {
    const base = hashOf(withPending());
    const changed = withPending();
    changed.stateHash = HEX("0");
    (changed.heads as Record<string, unknown>).hashChain = HEX("0");
    (changed.commandLog as Record<string, unknown>).count = 9_999;
    (changed.commandLog as Record<string, unknown>).headHash = HEX("0");
    expect(hashOf(changed)).toBe(base);
  });
});