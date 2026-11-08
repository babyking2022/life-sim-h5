import { describe, expect, it } from "vitest";
import * as contracts from "@life-sim/contracts";
import { MAX_MONEY_PPP_MICRO, MIN_MONEY_PPP_MICRO, MoneyError, RngError } from "@life-sim/engine";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { computeP3EStateHash } from "../src/state-hash";
import { readP3EStateShape } from "../src/state";

/**
 * P3-E.1a-2c-2a：state shape 驗證與深層快照。
 *
 * 每個反例都必須得到**固定錯誤碼 ＋ 欄位級 path**，且不外洩任何原生例外；
 * 合法案例則必須得到「逐欄相同、參考完全斷開、遞迴凍結」的快照。
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
        entityCount: 169
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

type Dict = Record<string, unknown>;

const mutable = (): Dict => structuredClone(sampleState()) as unknown as Dict;

function nodeAt(root: Dict, path: readonly (string | number)[]): Dict {
  let node: unknown = root;
  for (const step of path) node = (node as Dict)[step as string];
  return node as Dict;
}

/** 取得指定位置的容器（用於反例）；空 path 代表頂層。 */
const containerAt = (root: Dict, path: readonly (string | number)[]) => (path.length === 0 ? root : nodeAt(root, path));

/* ------------------------------------------------------------------ */
/* 共用斷言                                                            */
/* ------------------------------------------------------------------ */

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function expectShapeError(input: unknown, code: string, path: string): void {
  const caught = caughtFrom(() => readP3EStateShape(input));
  expect(isP3EError(caught), `${code} at ${path}`).toBe(true);
  const error = caught as P3EError;
  expect(error.code, `path ${path}`).toBe(code);
  expect(error.path).toBe(path);
  expect(error.message).toBe(`${code} at ${path}`);
  expect(error.name).toBe("P3EError");
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
  expect(caught instanceof RngError).toBe(false);
  expect(caught instanceof MoneyError).toBe(false);
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  const record = value as Dict;
  return Object.keys(record).every((key) => isDeepFrozen(record[key]));
}

/** 回傳 true 代表 output 有任何節點與 input 的對應節點是同一個物件。 */
function sharesReference(output: unknown, input: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  if (output === input) return true;
  const outRecord = output as Dict;
  const inRecord = (typeof input === "object" && input !== null ? input : {}) as Dict;
  return Object.keys(outRecord).some((key) => sharesReference(outRecord[key], inRecord[key]));
}

/* ------------------------------------------------------------------ */
/* 一、合法 state 與深層快照                                            */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2a 合法 state", () => {
  it("合法 state 成功，輸出逐欄相同", () => {
    const input = sampleState();
    const output = readP3EStateShape(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(Object.keys(output).sort()).toEqual(Object.keys(input).sort());
  });

  it("輸出遞迴凍結、且與輸入完全斷開參考", () => {
    const input = sampleState();
    const output = readP3EStateShape(input);
    expect(isDeepFrozen(output)).toBe(true);
    expect(sharesReference(output, input)).toBe(false);
    expect(output.identity).not.toBe(input.identity);
    expect(output.packs).not.toBe(input.packs);
    expect(output.packs.events).not.toBe(input.packs.events);
    expect(output.packs.death).not.toBe(input.packs.death);
    expect(output.stats).not.toBe(input.stats);
    expect(output.assets).not.toBe(input.assets);
    expect(output.flags).not.toBe(input.flags);
    expect(output.occurrences).not.toBe(input.occurrences);
    expect(output.rng.life.initialState).not.toBe(input.rng.life.initialState);
    expect(output.heads).not.toBe(input.heads);
    expect(output.commandLog).not.toBe(input.commandLog);
    expect(() => {
      (output as unknown as Dict).age = 1;
    }).toThrow(TypeError);
    expect(() => {
      (output.stats as unknown as Dict).health = 1;
    }).toThrow(TypeError);
    expect(() => {
      (output.flags as unknown as string[])[0] = "x";
    }).toThrow(TypeError);
  });

  it("validator 不修改輸入；驗證後改輸入不影響輸出", () => {
    const input = mutable();
    const before = structuredClone(input);
    const output = readP3EStateShape(input);
    expect(input).toEqual(before);

    // 驗證後把輸入全部改爛，輸出必須完全不受影響
    nodeAt(input, ["identity"]).entityId = "changed";
    nodeAt(input, ["stats"]).health = 0;
    (input.flags as string[])[0] = "changed";
    (input.rng as Dict & { life: Dict & { state: number[] } }).life.state[0] = 0;
    input.stateHash = HEX("0");
    expect(output.identity.entityId).toBe("cr:DZA");
    expect(output.stats.health).toBe(60);
    expect(output.flags[0]).toBe("p3e:flag-a");
    expect(output.rng.life.state[0]).toBe(21);
    expect(output.stateHash).toBe(HEX("f"));
  });

  it("邊界值全部合法", () => {
    const boundary = mutable();
    const identity = nodeAt(boundary, ["identity"]);
    identity.birthYear = 1800;
    const death = nodeAt(boundary, ["packs", "death"]);
    const events = nodeAt(boundary, ["packs", "events"]);
    events.eventCount = 1;
    boundary.currentYear = 1800;
    boundary.age = 0;
    (boundary.stats as Dict).health = 0;
    (boundary.stats as Dict).happiness = 100;
    (boundary.assets as Dict).balanceMicroUsd = MIN_MONEY_PPP_MICRO;
    (boundary.assets as Dict).annualIncomeMicroUsd = 0n;
    (boundary.assets as Dict).annualExpenseMicroUsd = MAX_MONEY_PPP_MICRO;
    boundary.flags = [];
    boundary.occurrences = [];
    ((boundary.rng as Dict).life as Dict).semanticDraws = 1;
    (boundary.commandLog as Dict).count = 0;
    expect(() => readP3EStateShape(boundary)).not.toThrow();
    // death.entityCount 仍是固定值
    expect(death.entityCount).toBe(169);

    const upper = mutable();
    nodeAt(upper, ["identity"]).birthYear = 2200;
    upper.currentYear = 2320;
    upper.age = 120;
    (upper.stats as Dict).health = 100;
    (upper.packs as Dict & { events: Dict }).events.eventCount = 4096;
    (upper.commandLog as Dict).count = 4096;
    upper.occurrences = [{ eventId: "ev-a", count: 120, lastYear: 1800 }];
    ((upper.rng as Dict).events as Dict).u32Draws = Number.MAX_SAFE_INTEGER;
    ((upper.rng as Dict).death as Dict).u32Draws = 0;
    ((upper.rng as Dict).life as Dict & { semanticDraws: number }).semanticDraws = Number.MAX_SAFE_INTEGER;
    upper.flags = Array.from({ length: 256 }, (_item, index) => `flag-${index}`);
    expect(() => readP3EStateShape(upper)).not.toThrow();
  });

  it("flags 與 occurrences 的長度上限（256／4096）", () => {
    const tooManyFlags = mutable();
    tooManyFlags.flags = Array.from({ length: 257 }, (_item, index) => `flag-${index}`);
    expectShapeError(tooManyFlags, "E_P3E_STATE", "flags");

    const manyOccurrences = mutable();
    manyOccurrences.occurrences = Array.from({ length: 4096 }, (_item, index) => ({
      eventId: `ev-${index}`,
      count: 1,
      lastYear: 2001
    }));
    expect(() => readP3EStateShape(manyOccurrences)).not.toThrow();

    const tooManyOccurrences = mutable();
    tooManyOccurrences.occurrences = Array.from({ length: 4097 }, (_item, index) => ({
      eventId: `ev-${index}`,
      count: 1,
      lastYear: 2001
    }));
    expectShapeError(tooManyOccurrences, "E_P3E_EVENT", "occurrences");
  });
});

/* ------------------------------------------------------------------ */
/* 二、exact-object 反例（13 個容器 × 7 種操作）                       */
/* ------------------------------------------------------------------ */

interface ContainerCase {
  readonly label: string;
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly errorPath: string;
  readonly key: string;
}

const CONTAINERS: readonly ContainerCase[] = [
  { label: "state", path: [], code: "E_P3E_STATE", errorPath: "state", key: "age" },
  { label: "identity", path: ["identity"], code: "E_P3E_IDENTITY", errorPath: "identity", key: "entityId" },
  { label: "packs", path: ["packs"], code: "E_P3E_STATE", errorPath: "packs", key: "events" },
  {
    label: "packs.events",
    path: ["packs", "events"],
    code: "E_P3E_EVENT_PACK",
    errorPath: "packs.events",
    key: "eventCount"
  },
  {
    label: "packs.death",
    path: ["packs", "death"],
    code: "E_P3E_DEATH_PACK",
    errorPath: "packs.death",
    key: "entityCount"
  },
  { label: "stats", path: ["stats"], code: "E_P3E_STATE", errorPath: "stats", key: "health" },
  { label: "assets", path: ["assets"], code: "E_P3E_MONEY", errorPath: "assets", key: "balanceMicroUsd" },
  { label: "rng", path: ["rng"], code: "E_P3E_RNG", errorPath: "rng", key: "life" },
  { label: "rng.life", path: ["rng", "life"], code: "E_P3E_RNG", errorPath: "rng.life", key: "domain" },
  { label: "rng.events", path: ["rng", "events"], code: "E_P3E_RNG", errorPath: "rng.events", key: "u32Draws" },
  { label: "rng.death", path: ["rng", "death"], code: "E_P3E_RNG", errorPath: "rng.death", key: "u32Draws" },
  { label: "heads", path: ["heads"], code: "E_P3E_HISTORY", errorPath: "heads", key: "hashChain" },
  { label: "commandLog", path: ["commandLog"], code: "E_P3E_COMMAND", errorPath: "commandLog", key: "count" },
  {
    label: "occurrences[0]",
    path: ["occurrences", 0],
    code: "E_P3E_EVENT",
    errorPath: "occurrences[0]",
    key: "eventId"
  }
];

describe("P3-E.1a-2c-2a exact-object 反例", () => {
  it("容器清單覆蓋 14 個 exact-object", () => {
    expect(CONTAINERS.length).toBe(14);
  });

  for (const container of CONTAINERS) {
    it(`${container.label}：多餘欄位`, () => {
      const state = mutable();
      containerAt(state, container.path).extraField = 1;
      expectShapeError(state, container.code, container.errorPath);
    });

    it(`${container.label}：缺少欄位`, () => {
      const state = mutable();
      delete containerAt(state, container.path)[container.key];
      expectShapeError(state, container.code, container.errorPath);
    });

    it(`${container.label}：欄位改名（鍵數相同但集合不同）`, () => {
      const state = mutable();
      const node = containerAt(state, container.path);
      delete node[container.key];
      node.renamedKey = 1;
      expectShapeError(state, container.code, container.errorPath);
    });

    it(`${container.label}：不可列舉的額外欄位`, () => {
      const state = mutable();
      Object.defineProperty(containerAt(state, container.path), "hiddenExtra", {
        value: 1,
        enumerable: false,
        configurable: true
      });
      expectShapeError(state, container.code, container.errorPath);
    });

    it(`${container.label}：必要欄位被改成不可列舉`, () => {
      const state = mutable();
      const node = containerAt(state, container.path);
      const value = node[container.key];
      Object.defineProperty(node, container.key, { value, enumerable: false, configurable: true });
      expectShapeError(state, container.code, container.errorPath);
    });

    it(`${container.label}：symbol 欄位`, () => {
      const state = mutable();
      Object.defineProperty(containerAt(state, container.path), Symbol("extra"), {
        value: 1,
        enumerable: false,
        configurable: true
      });
      expectShapeError(state, container.code, container.errorPath);
    });

    it(`${container.label}：accessor 欄位（getter 不會被呼叫）`, () => {
      const state = mutable();
      const node = containerAt(state, container.path);
      const value = node[container.key];
      let invoked = false;
      Object.defineProperty(node, container.key, {
        enumerable: true,
        configurable: true,
        get() {
          invoked = true;
          return value;
        }
      });
      expectShapeError(state, container.code, container.errorPath);
      expect(invoked).toBe(false);
    });

    it(`${container.label}：不是物件`, () => {
      for (const replacement of [null, 42, "x", true, [], () => 1]) {
        const state = mutable();
        if (container.path.length === 0) {
          expectShapeError(replacement, "E_P3E_STATE", "state");
          continue;
        }
        nodeAt(state, container.path.slice(0, -1))[container.path[container.path.length - 1] as string] = replacement;
        expectShapeError(state, container.code, container.errorPath);
      }
    });
  }

  it("非 plain prototype（class 實例、Object.create({})）一律拒絕", () => {
    class FakeIdentity {
      public entityId = "x";
    }
    const state = mutable();
    state.identity = new FakeIdentity();
    expectShapeError(state, "E_P3E_IDENTITY", "identity");

    const withProto = mutable();
    withProto.stats = Object.create({ health: 1 });
    expectShapeError(withProto, "E_P3E_STATE", "stats");
  });

  it("null prototype 的物件可以接受", () => {
    const state = mutable();
    const bare = Object.assign(Object.create(null) as Dict, state.identity as Dict);
    state.identity = bare;
    expect(() => readP3EStateShape(state)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 三、密集陣列反例                                                    */
/* ------------------------------------------------------------------ */

interface ArrayCase {
  readonly label: string;
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly errorPath: string;
}

const ARRAYS: readonly ArrayCase[] = [
  { label: "flags", path: ["flags"], code: "E_P3E_STATE", errorPath: "flags" },
  { label: "occurrences", path: ["occurrences"], code: "E_P3E_EVENT", errorPath: "occurrences" },
  {
    label: "rng.life.initialState",
    path: ["rng", "life", "initialState"],
    code: "E_P3E_RNG",
    errorPath: "rng.life.initialState"
  },
  { label: "rng.life.state", path: ["rng", "life", "state"], code: "E_P3E_RNG", errorPath: "rng.life.state" },
  {
    label: "rng.events.initialState",
    path: ["rng", "events", "initialState"],
    code: "E_P3E_RNG",
    errorPath: "rng.events.initialState"
  },
  { label: "rng.events.state", path: ["rng", "events", "state"], code: "E_P3E_RNG", errorPath: "rng.events.state" },
  {
    label: "rng.death.initialState",
    path: ["rng", "death", "initialState"],
    code: "E_P3E_RNG",
    errorPath: "rng.death.initialState"
  },
  { label: "rng.death.state", path: ["rng", "death", "state"], code: "E_P3E_RNG", errorPath: "rng.death.state" }
];

function setArray(root: Dict, path: readonly (string | number)[], value: unknown): void {
  nodeAt(root, path.slice(0, -1))[path[path.length - 1] as string] = value;
}

function getArray(root: Dict, path: readonly (string | number)[]): unknown[] {
  return nodeAt(root, path) as unknown as unknown[];
}

/** 六個 RNG tuple（游標 × tuple 名稱）。 */
const RNG_SLOTS: readonly { readonly cursor: string; readonly tuple: "initialState" | "state" }[] = [
  { cursor: "life", tuple: "initialState" },
  { cursor: "life", tuple: "state" },
  { cursor: "events", tuple: "initialState" },
  { cursor: "events", tuple: "state" },
  { cursor: "death", tuple: "initialState" },
  { cursor: "death", tuple: "state" }
];

function setWord(
  root: Dict,
  cursor: string,
  tuple: "initialState" | "state",
  index: number,
  value: unknown
): void {
  const words = (nodeAt(root, ["rng", cursor]) as Dict)[tuple] as unknown[];
  words[index] = value;
}

describe("P3-E.1a-2c-2a 密集陣列反例", () => {
  it("陣列清單覆蓋 flags／occurrences／六個 RNG tuple", () => {
    expect(ARRAYS.length).toBe(8);
  });

  for (const arrayCase of ARRAYS) {
    it(`${arrayCase.label}：額外字串鍵`, () => {
      const state = mutable();
      Object.defineProperty(getArray(state, arrayCase.path), "extra", {
        value: 1,
        enumerable: true,
        configurable: true
      });
      expectShapeError(state, arrayCase.code, arrayCase.errorPath);
    });

    it(`${arrayCase.label}：symbol 鍵`, () => {
      const state = mutable();
      Object.defineProperty(getArray(state, arrayCase.path), Symbol("tag"), {
        value: 1,
        enumerable: false,
        configurable: true
      });
      expectShapeError(state, arrayCase.code, arrayCase.errorPath);
    });

    it(`${arrayCase.label}：稀疏（有洞）`, () => {
      const state = mutable();
      delete getArray(state, arrayCase.path)[0];
      expectShapeError(state, arrayCase.code, arrayCase.errorPath);
    });

    it(`${arrayCase.label}：索引 accessor`, () => {
      const state = mutable();
      let invoked = false;
      Object.defineProperty(getArray(state, arrayCase.path), "0", {
        enumerable: true,
        configurable: true,
        get() {
          invoked = true;
          return 1;
        }
      });
      expectShapeError(state, arrayCase.code, arrayCase.errorPath);
      expect(invoked).toBe(false);
    });

    it(`${arrayCase.label}：索引被改成不可列舉`, () => {
      const state = mutable();
      const array = getArray(state, arrayCase.path);
      const value = array[0];
      Object.defineProperty(array, "0", { value, enumerable: false, configurable: true });
      expectShapeError(state, arrayCase.code, arrayCase.errorPath);
    });

    it(`${arrayCase.label}：不是陣列`, () => {
      const state = mutable();
      setArray(state, arrayCase.path, { 0: 1, 1: 2, 2: 3, 3: 4 });
      expectShapeError(state, arrayCase.code, arrayCase.errorPath);
    });
  }

  it("RNG tuple：長度不是 4、全零、越界與非整數", () => {
    const cases: readonly [string, unknown, string][] = [
      ["長度 3", [1, 2, 3], "rng.life.state"],
      ["長度 5", [1, 2, 3, 4, 5], "rng.life.state"],
      ["空陣列", [], "rng.life.state"],
      ["全零", [0, 0, 0, 0], "rng.life.state"],
      ["負數", [1, 2, 3, -1], "rng.life.state[3]"],
      ["超過 u32", [1, 2, 3, 0x1_0000_0000], "rng.life.state[3]"],
      ["非整數", [1, 2, 3, 4.5], "rng.life.state[3]"],
      ["字串", [1, 2, 3, "4"], "rng.life.state[3]"],
      ["null", [1, null, 3, 4], "rng.life.state[1]"]
    ];
    for (const [label, words, path] of cases) {
      const state = mutable();
      setArray(state, ["rng", "life", "state"], words);
      expectShapeError(state, "E_P3E_RNG", path);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("六個 tuple × 四個索引：0xffffffff 可接受、0x1_0000_0000 精確拒絕（24 個邊界）", () => {
    expect(RNG_SLOTS.length).toBe(6);
    for (const { cursor, tuple } of RNG_SLOTS) {
      for (let index = 0; index < 4; index += 1) {
        const accepted = mutable();
        setWord(accepted, cursor, tuple, index, 0xffffffff);
        expect(
          () => readP3EStateShape(accepted),
          `rng.${cursor}.${tuple}[${index}] = 0xffffffff`
        ).not.toThrow();

        const rejected = mutable();
        setWord(rejected, cursor, tuple, index, 0x1_0000_0000);
        expectShapeError(rejected, "E_P3E_RNG", `rng.${cursor}.${tuple}[${index}]`);
      }
    }
  });

  it("六個 tuple × 四個索引：負數／非整數／非數字／null 都以精確 path 拒絕", () => {
    const badValues: readonly [unknown, string][] = [
      [-1, "負數"],
      [1.5, "非整數"],
      ["4", "字串"],
      [null, "null"]
    ];
    for (const { cursor, tuple } of RNG_SLOTS) {
      for (let index = 0; index < 4; index += 1) {
        for (const [value, label] of badValues) {
          const state = mutable();
          setWord(state, cursor, tuple, index, value);
          expectShapeError(state, "E_P3E_RNG", `rng.${cursor}.${tuple}[${index}]`);
          expect(label.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("六個 tuple 各自仍不得全零（路徑是 tuple 本身）", () => {
    for (const { cursor, tuple } of RNG_SLOTS) {
      const state = mutable();
      for (let index = 0; index < 4; index += 1) setWord(state, cursor, tuple, index, 0);
      expectShapeError(state, "E_P3E_RNG", `rng.${cursor}.${tuple}`);
    }
  });

  it("flags：項目型別與 pattern", () => {
    const cases: readonly [unknown, string][] = [
      [1, "flags[0]"],
      [null, "flags[0]"],
      ["", "flags[0]"],
      ["P3E:UPPER", "flags[0]"],
      ["-leading", "flags[0]"],
      ["a".repeat(65), "flags[0]"]
    ];
    for (const [item, path] of cases) {
      const state = mutable();
      state.flags = [item, "p3e:ok"];
      expectShapeError(state, "E_P3E_STATE", path);
    }
    // 64 字元以內、底線與冒號允許
    const ok = mutable();
    ok.flags = ["a", "a".repeat(64), "p3e:flag_ok-1"];
    expect(() => readP3EStateShape(ok)).not.toThrow();
  });

  it("occurrences：eventId／count／lastYear 規則", () => {
    const badEventIds = ["ab", "A-B", "-ab", "a".repeat(65), 42, null];
    for (const eventId of badEventIds) {
      const state = mutable();
      state.occurrences = [{ eventId, count: 1, lastYear: 2001 }];
      expectShapeError(state, "E_P3E_EVENT", "occurrences[0].eventId");
    }
    const badCounts = [0, 121, 1.5, "1"];
    for (const count of badCounts) {
      const state = mutable();
      state.occurrences = [{ eventId: "ev-a", count, lastYear: 2001 }];
      expectShapeError(state, "E_P3E_EVENT", "occurrences[0].count");
    }
    const badYears = [1799, 2321, 2001.5, "2001"];
    for (const lastYear of badYears) {
      const state = mutable();
      state.occurrences = [{ eventId: "ev-a", count: 1, lastYear }];
      expectShapeError(state, "E_P3E_EVENT", "occurrences[0].lastYear");
    }
    // 合法邊界
    const ok = mutable();
    ok.occurrences = [
      { eventId: "ev-a", count: 1, lastYear: 1800 },
      { eventId: "ab-c", count: 120, lastYear: 2320 }
    ];
    expect(() => readP3EStateShape(ok)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 四、Proxy 與反射陷阱                                                */
/* ------------------------------------------------------------------ */

function revokeObject(): unknown {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
}

function revokeArray(): unknown {
  const revocable = Proxy.revocable([1, 2, 3, 4], {});
  revocable.revoke();
  return revocable.proxy;
}

describe("P3-E.1a-2c-2a 反射例外不外洩", () => {
  it("已撤銷的 Proxy（頂層／identity／stats／flags／tuple）", () => {
    expectShapeError(revokeObject(), "E_P3E_STATE", "state");

    const identity = mutable();
    identity.identity = revokeObject();
    expectShapeError(identity, "E_P3E_IDENTITY", "identity");

    const stats = mutable();
    stats.stats = revokeObject();
    expectShapeError(stats, "E_P3E_STATE", "stats");

    const flags = mutable();
    flags.flags = revokeArray();
    expectShapeError(flags, "E_P3E_STATE", "flags");

    const tuple = mutable();
    setArray(tuple, ["rng", "life", "state"], revokeArray());
    expectShapeError(tuple, "E_P3E_RNG", "rng.life.state");
  });

  it("getPrototypeOf／ownKeys／getOwnPropertyDescriptor trap 拋錯", () => {
    const protoThrows = new Proxy({}, {
      getPrototypeOf() {
        throw new TypeError("proto");
      }
    });
    expectShapeError(protoThrows, "E_P3E_STATE", "state");

    const keysThrows = new Proxy({}, {
      ownKeys() {
        throw new TypeError("ownKeys");
      }
    });
    expectShapeError(keysThrows, "E_P3E_STATE", "state");

    const descriptorThrows = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new TypeError("gopd");
      }
    });
    expectShapeError(descriptorThrows, "E_P3E_STATE", "state");
  });

  it("descriptor 回 undefined 的物件與陣列都被拒絕", () => {
    const state = mutable();
    state.stats = new Proxy({ ...(state.stats as Dict) }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "health") return undefined;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    expectShapeError(state, "E_P3E_STATE", "stats");

    const flags = mutable();
    flags.flags = new Proxy(["p3e:a", "p3e:b"], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "0") return undefined;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    expectShapeError(flags, "E_P3E_STATE", "flags");
  });

  it("陣列 length getter／ownKeys trap 拋錯或回怪值", () => {
    const lengthThrows = new Proxy(["p3e:a"], {
      get(target, key, receiver) {
        if (key === "length") throw new TypeError("length");
        return Reflect.get(target, key, receiver);
      }
    });
    const flags = mutable();
    flags.flags = lengthThrows;
    expectShapeError(flags, "E_P3E_STATE", "flags");

    const weirdLength = new Proxy(["p3e:a"], {
      get(target, key, receiver) {
        if (key === "length") return 1.5;
        return Reflect.get(target, key, receiver);
      }
    });
    const flags2 = mutable();
    flags2.flags = weirdLength;
    expectShapeError(flags2, "E_P3E_STATE", "flags");

    const negativeLength = new Proxy(["p3e:a"], {
      get(target, key, receiver) {
        if (key === "length") return -1;
        return Reflect.get(target, key, receiver);
      }
    });
    const flags3 = mutable();
    flags3.flags = negativeLength;
    expectShapeError(flags3, "E_P3E_STATE", "flags");

    const renamedKeys = new Proxy(["p3e:a"], {
      ownKeys: () => ["a", "length"]
    });
    const flags4 = mutable();
    flags4.flags = renamedKeys;
    expectShapeError(flags4, "E_P3E_STATE", "flags");

    // 索引被「改名」但鍵數與列舉數都對得上：必須在逐索引檢查時被擋下
    const renamedIndex = new Proxy(["p3e:a"], {
      ownKeys: () => ["a", "length"],
      getOwnPropertyDescriptor(target, key) {
        if (key === "a") return { value: "p3e:a", writable: true, enumerable: true, configurable: true };
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    const flags5 = mutable();
    flags5.flags = renamedIndex;
    expectShapeError(flags5, "E_P3E_STATE", "flags");
  });

  it("物件 ownKeys 回報錯誤鍵名（鍵數相同）也被拒絕", () => {
    const state = mutable();
    const renamed = new Proxy({ ...(state.commandLog as Dict) }, {
      ownKeys: () => ["a", "b"]
    });
    state.commandLog = renamed;
    expectShapeError(state, "E_P3E_COMMAND", "commandLog");
  });
});

/* ------------------------------------------------------------------ */
/* 五、版本與 single-field 規則                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2a 版本欄位", () => {
  it("八個版本欄位各自被固定值驗證", () => {
    const cases: readonly [string, unknown][] = [
      ["schemaVersion", "p3e-1"],
      ["rulesetVersion", "p3e-9.9.9"],
      ["rollSpecVersion", "p3e-roll-9.9.9"],
      ["lifeSpecVersion", "9.9.9"],
      ["contentVersion", "skeleton-9.9.9"],
      ["saveFormatVersion", 5],
      ["engineVersion", "9.9.9"],
      ["rngSpecVersion", "9.9.9"]
    ];
    for (const [key, value] of cases) {
      const state = mutable();
      state[key] = value;
      expectShapeError(state, "E_P3E_VERSION", key);
    }
    // 型別錯也算版本錯
    const wrongType = mutable();
    wrongType.schemaVersion = 1;
    expectShapeError(wrongType, "E_P3E_VERSION", "schemaVersion");
  });
});

describe("P3-E.1a-2c-2a 單欄規則", () => {
  it("sex 只允許 female／male", () => {
    for (const sex of ["other", "", 1, null]) {
      const state = mutable();
      nodeAt(state, ["identity"]).sex = sex;
      expectShapeError(state, "E_P3E_IDENTITY", "identity.sex");
    }
  });

  it("phase 只允許三個值", () => {
    for (const phase of ["dead", "", 1, null]) {
      const state = mutable();
      state.phase = phase;
      expectShapeError(state, "E_P3E_PHASE", "phase");
    }
    for (const phase of ["life", "pending_decision", "death"]) {
      const state = mutable();
      state.phase = phase;
      expect(() => readP3EStateShape(state)).not.toThrow();
    }
  });

  it("birthYear／currentYear／age 的上下界", () => {
    const birthYears: readonly [unknown, boolean][] = [
      [1799, false],
      [2201, false],
      [1800, true],
      [2200, true],
      [2000.5, false],
      ["2000", false]
    ];
    for (const [birthYear, accepted] of birthYears) {
      const state = mutable();
      nodeAt(state, ["identity"]).birthYear = birthYear;
      if (accepted) expect(() => readP3EStateShape(state)).not.toThrow();
      else expectShapeError(state, "E_P3E_IDENTITY", "identity.birthYear");
    }

    const currentYears: readonly [unknown, boolean][] = [
      [1799, false],
      [2321, false],
      [1800, true],
      [2320, true],
      [2000.5, false],
      [null, false]
    ];
    for (const [currentYear, accepted] of currentYears) {
      const state = mutable();
      state.currentYear = currentYear;
      if (accepted) expect(() => readP3EStateShape(state)).not.toThrow();
      else expectShapeError(state, "E_P3E_STATE", "currentYear");
    }

    const ages: readonly [unknown, boolean][] = [
      [-1, false],
      [121, false],
      [0, true],
      [120, true],
      [30.5, false],
      [NaN, false]
    ];
    for (const [age, accepted] of ages) {
      const state = mutable();
      state.age = age;
      if (accepted) expect(() => readP3EStateShape(state)).not.toThrow();
      else expectShapeError(state, "E_P3E_STATE", "age");
    }
  });

  it("stats 四欄都是 0..100 安全整數", () => {
    for (const key of ["health", "happiness", "knowledge", "relationships"] as const) {
      for (const value of [-1, 101, 1.5, "50", null]) {
        const state = mutable();
        (state.stats as Dict)[key] = value;
        expectShapeError(state, "E_P3E_STATE", `stats.${key}`);
      }
      const ok = mutable();
      (ok.stats as Dict)[key] = 0;
      expect(() => readP3EStateShape(ok)).not.toThrow();
      const ok100 = mutable();
      (ok100.stats as Dict)[key] = 100;
      expect(() => readP3EStateShape(ok100)).not.toThrow();
    }
  });

  it("money 三個欄位：bigint 且在 Money 界內，收支不得為負", () => {
    const balanceCases: readonly [unknown, boolean][] = [
      [1, false],
      ["1", false],
      [MIN_MONEY_PPP_MICRO - 1n, false],
      [MAX_MONEY_PPP_MICRO + 1n, false],
      [MIN_MONEY_PPP_MICRO, true],
      [MAX_MONEY_PPP_MICRO, true],
      [-1n, true],
      [0n, true]
    ];
    for (const [value, accepted] of balanceCases) {
      const state = mutable();
      (state.assets as Dict).balanceMicroUsd = value;
      if (accepted) expect(() => readP3EStateShape(state)).not.toThrow();
      else expectShapeError(state, "E_P3E_MONEY", "assets.balanceMicroUsd");
    }

    for (const key of ["annualIncomeMicroUsd", "annualExpenseMicroUsd"] as const) {
      for (const value of [-1n, MAX_MONEY_PPP_MICRO + 1n, 1, "0"]) {
        const state = mutable();
        (state.assets as Dict)[key] = value;
        expectShapeError(state, "E_P3E_MONEY", `assets.${key}`);
      }
      for (const value of [0n, MAX_MONEY_PPP_MICRO]) {
        const state = mutable();
        (state.assets as Dict)[key] = value;
        expect(() => readP3EStateShape(state)).not.toThrow();
      }
    }
  });

  it("一般字串：非空、有限長度、不得含控制字元", () => {
    const cases: readonly [unknown, boolean][] = [
      ["", false],
      ["a".repeat(257), false],
      ["a".repeat(256), true],
      ["bad\u0001id", false],
      ["bad\u007fid", false],
      [42, false],
      [null, false]
    ];
    for (const [value, accepted] of cases) {
      const state = mutable();
      nodeAt(state, ["identity"]).entityId = value;
      if (accepted) expect(() => readP3EStateShape(state)).not.toThrow();
      else expectShapeError(state, "E_P3E_IDENTITY", "identity.entityId");
    }
    // 其他字串欄位（例：eventPackId）走同一套規則
    const badPackId = mutable();
    nodeAt(badPackId, ["packs", "events"]).eventPackId = "";
    expectShapeError(badPackId, "E_P3E_EVENT_PACK", "packs.events.eventPackId");
  });

  it("64 位小寫 hex：checksum／heads／stateHash", () => {

    const hexCases: readonly [unknown, boolean][] = [
      [HEX("A"), false],
      ["f".repeat(63), false],
      ["f".repeat(65), false],
      ["z".repeat(64), false],
      [42, false],
      [HEX("0"), true]
    ];
    for (const [value, accepted] of hexCases) {
      const identityState = mutable();
      nodeAt(identityState, ["identity"]).certificateHash = value;
      if (accepted) expect(() => readP3EStateShape(identityState)).not.toThrow();
      else expectShapeError(identityState, "E_P3E_IDENTITY", "identity.certificateHash");

      const headsState = mutable();
      (headsState.heads as Dict).hashChain = value;
      if (accepted) expect(() => readP3EStateShape(headsState)).not.toThrow();
      else expectShapeError(headsState, "E_P3E_HISTORY", "heads.hashChain");

      const hashState = mutable();
      hashState.stateHash = value;
      if (accepted) expect(() => readP3EStateShape(hashState)).not.toThrow();
      else expectShapeError(hashState, "E_P3E_STATE", "stateHash");
    }
    // heads 另外三欄
    for (const key of ["lastEntryHash", "lastSnapshotHash", "lastDeltaHash"] as const) {
      const state = mutable();
      (state.heads as Dict)[key] = "not-hex";
      expectShapeError(state, "E_P3E_HISTORY", `heads.${key}`);
    }
    // 其他 checksum
    const checksums: readonly [readonly (string | number)[], string, string][] = [
      [["identity"], "basePackChecksum", "identity.basePackChecksum"],
      [["identity"], "identityPackChecksum", "identity.identityPackChecksum"],
      [["packs", "events"], "eventPackChecksum", "packs.events.eventPackChecksum"],
      [["packs", "events"], "datasetChecksum", "packs.events.datasetChecksum"],
      [["packs", "death"], "deathPackChecksum", "packs.death.deathPackChecksum"],
      [["packs", "death"], "basePackChecksum", "packs.death.basePackChecksum"]
    ];
    for (const [path, key, errorPath] of checksums) {
      const state = mutable();
      nodeAt(state, path)[key] = "NOTHEX";
      expectShapeError(state, path[1] === "events" ? "E_P3E_EVENT_PACK" : path[1] === "death" ? "E_P3E_DEATH_PACK" : "E_P3E_IDENTITY", errorPath);
    }
  });

  it("playerIdentityHash 必須是 64 位小寫 hex（H5-CTO-067-A-R1）", () => {
    const badValues: readonly [unknown, string][] = [
      ["f".repeat(63), "63 字元"],
      ["f".repeat(65), "65 字元"],
      ["A".repeat(64), "大寫 A-F"],
      ["g".repeat(64), "非 hex 字元"],
      ["", "空字串"],
      [42, "非字串"],
      [null, "null"]
    ];
    for (const [value, label] of badValues) {
      const state = mutable();
      nodeAt(state, ["identity"]).playerIdentityHash = value;
      expectShapeError(state, "E_P3E_IDENTITY", "identity.playerIdentityHash");
      expect(label.length).toBeGreaterThan(0);
    }
    // 合法的 64 位小寫 hex 必須通過
    for (const value of [HEX("0"), HEX("f"), "0123456789abcdef".repeat(4)]) {
      const state = mutable();
      nodeAt(state, ["identity"]).playerIdentityHash = value;
      expect(() => readP3EStateShape(state)).not.toThrow();
    }
    // 與其他權威 hash 同一套 readHex64：certificateHash 合法不代表 playerIdentityHash 可以亂填
    const mixed = mutable();
    nodeAt(mixed, ["identity"]).certificateHash = HEX("1");
    nodeAt(mixed, ["identity"]).playerIdentityHash = "not-a-hash";
    expectShapeError(mixed, "E_P3E_IDENTITY", "identity.playerIdentityHash");
    // 只改一個字元也要被抓到
    const oneChar = mutable();
    nodeAt(oneChar, ["identity"]).playerIdentityHash = `${"f".repeat(63)}e`;
    expect(() => readP3EStateShape(oneChar)).not.toThrow();
    const upperOne = mutable();
    nodeAt(upperOne, ["identity"]).playerIdentityHash = `${"f".repeat(63)}E`;
    expectShapeError(upperOne, "E_P3E_IDENTITY", "identity.playerIdentityHash");
  });

  it("RNG domain／計數器規則", () => {
    const domains: readonly (readonly [readonly string[], string, string])[] = [
      [["life"], "events", "rng.life.domain"],
      [["events"], "life", "rng.events.domain"],
      [["death"], "events", "rng.death.domain"]
    ];
    for (const [cursorPath, domain, errorPath] of domains) {
      const state = mutable();
      (nodeAt(state, ["rng", ...cursorPath]) as Dict).domain = domain;
      expectShapeError(state, "E_P3E_RNG", errorPath);
    }

    const badDraws: readonly [readonly (string | number)[], string][] = [
      [["life", "semanticDraws"], "rng.life.semanticDraws"],
      [["events", "u32Draws"], "rng.events.u32Draws"],
      [["death", "u32Draws"], "rng.death.u32Draws"]
    ];
    for (const [path, errorPath] of badDraws) {
      const state = mutable();
      const cursor = nodeAt(state, ["rng", path[0] as string]);
      cursor[path[path.length - 1] as string] = -1;
      expectShapeError(state, "E_P3E_RNG", errorPath);
    }
    const zeroDraws = mutable();
    (nodeAt(zeroDraws, ["rng", "life"]) as Dict).semanticDraws = 0;
    expectShapeError(zeroDraws, "E_P3E_RNG", "rng.life.semanticDraws");

    const fractionalDraws = mutable();
    (nodeAt(fractionalDraws, ["rng", "events"]) as Dict).u32Draws = 1.5;
    expectShapeError(fractionalDraws, "E_P3E_RNG", "rng.events.u32Draws");
  });

  it("pack 邊界：eventCount 1..4096、death.entityCount 固定 172", () => {
    for (const eventCount of [0, 4097, 1.5, "22"]) {
      const state = mutable();
      nodeAt(state, ["packs", "events"]).eventCount = eventCount;
      expectShapeError(state, "E_P3E_EVENT_PACK", "packs.events.eventCount");
    }
    for (const entityCount of [171, 173, "172", null]) {
      const state = mutable();
      nodeAt(state, ["packs", "death"]).entityCount = entityCount;
      expectShapeError(state, "E_P3E_DEATH_PACK", "packs.death.entityCount");
    }
  });

  it("commandLog 範圍與 head", () => {
    for (const count of [-1, 4097, 1.5, "7"]) {
      const state = mutable();
      (state.commandLog as Dict).count = count;
      expectShapeError(state, "E_P3E_COMMAND", "commandLog.count");
    }
    const badHead = mutable();
    (badHead.commandLog as Dict).headHash = "nope";
    expectShapeError(badHead, "E_P3E_COMMAND", "commandLog.headHash");
  });
});

/* ------------------------------------------------------------------ */
/* 六、負控：本批不得越權驗證跨欄位規則                                */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2a 負控（尚未實作 invariants）", () => {
  it("currentYear ≠ birthYear + age 仍接受", () => {
    const state = mutable();
    state.currentYear = 2200;
    nodeAt(state, ["identity"]).birthYear = 1800;
    state.age = 0;
    expect(() => readP3EStateShape(state)).not.toThrow();
  });

  it("age 120 且 phase = life 仍接受", () => {
    const state = mutable();
    state.age = 120;
    state.phase = "life";
    expect(() => readP3EStateShape(state)).not.toThrow();
  });

  it("flags 未排序、重複仍接受", () => {
    const state = mutable();
    state.flags = ["p3e:b", "p3e:a", "p3e:a"];
    expect(() => readP3EStateShape(state)).not.toThrow();
  });

  it("occurrences 未排序、eventId 重複、年份不合理仍接受", () => {
    const state = mutable();
    state.occurrences = [
      { eventId: "ev-b", count: 1, lastYear: 2300 },
      { eventId: "ev-a", count: 1, lastYear: 1801 },
      { eventId: "ev-a", count: 2, lastYear: 1801 }
    ];
    expect(() => readP3EStateShape(state)).not.toThrow();
  });

  it("RNG draws 與 age 不一致仍接受", () => {
    const state = mutable();
    (nodeAt(state, ["rng", "life"]) as Dict).semanticDraws = 9999;
    (nodeAt(state, ["rng", "events"]) as Dict).u32Draws = 777;
    expect(() => readP3EStateShape(state)).not.toThrow();
  });

  it("identity 與 pack 的交叉綁定不一致仍接受", () => {
    const state = mutable();
    nodeAt(state, ["identity"]).basePackId = "another-base-pack";
    nodeAt(state, ["identity"]).basePackChecksum = HEX("9");
    nodeAt(state, ["packs", "death"]).basePackChecksum = HEX("8");
    expect(() => readP3EStateShape(state)).not.toThrow();
  });

  it("stateHash 與 computeP3EStateHash 不一致仍接受", () => {
    const state = mutable();
    const realHash = computeP3EStateHash(sampleState());
    state.stateHash = realHash === HEX("0") ? HEX("1") : HEX("0");
    expect(state.stateHash).not.toBe(realHash);
    expect(() => readP3EStateShape(state)).not.toThrow();
  });

  it("commandLog.count 與 headHash 任意組合仍接受（不驗 replay）", () => {
    const state = mutable();
    (state.commandLog as Dict).count = 4096;
    (state.commandLog as Dict).headHash = HEX("1");
    expect(() => readP3EStateShape(state)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 七、公開表面與 path 精確性                                          */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2a 公開表面與 path", () => {
  it("readP3EStateShape 只在套件內部，不在公開 barrel", () => {
    expect(typeof readP3EStateShape).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.readP3EStateShape).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("錯誤 path 一律是欄位級（不是整個 state）", () => {
    const samples: readonly [() => unknown, string][] = [
      [
        () => {
          const state = mutable();
          (state.stats as Dict).knowledge = 200;
          return state;
        },
        "stats.knowledge"
      ],
      [
        () => {
          const state = mutable();
          setArray(state, ["rng", "death", "state"], [1, 2, 3, 4.5]);
          return state;
        },
        "rng.death.state[3]"
      ],
      [
        () => {
          const state = mutable();
          state.occurrences = [{ eventId: "ev-a", count: 0, lastYear: 2001 }];
          return state;
        },
        "occurrences[0].count"
      ],
      [
        () => {
          const state = mutable();
          (state.heads as Dict).lastSnapshotHash = "bad";
          return state;
        },
        "heads.lastSnapshotHash"
      ],
      [
        () => {
          const state = mutable();
          (state.assets as Dict).annualIncomeMicroUsd = -1n;
          return state;
        },
        "assets.annualIncomeMicroUsd"
      ],
      [
        () => {
          const state = mutable();
          state.phase = "error";
          return state;
        },
        "phase"
      ],
      [
        () => {
          const state = mutable();
          (state.commandLog as Dict).count = 9999;
          return state;
        },
        "commandLog.count"
      ],
      [
        () => {
          const state = mutable();
          nodeAt(state, ["packs", "events"]).eventCount = 0;
          return state;
        },
        "packs.events.eventCount"
      ]
    ];
    for (const [build, path] of samples) {
      const caught = caughtFrom(() => readP3EStateShape(build()));
      expect((caught as P3EError).path).toBe(path);
      expect(path).not.toBe("state");
    }
  });

  it("頂層形狀錯誤只會是 E_P3E_STATE at state", () => {
    for (const input of [null, undefined, 42, "state", true, [], Object.create({})]) {
      expectShapeError(input, "E_P3E_STATE", "state");
    }
  });
});

/* ------------------------------------------------------------------ */
/* P3-E.1b-1f-0：pendingDecision 形狀（p3e-2）                          */
/* ------------------------------------------------------------------ */

const PENDING_SUMMARY = {
  year: 2030,
  age: 30,
  eventId: "ev.adult.housing-choice",
  decisionId: "dec.adult.housing",
  selectionHash: HEX("f"),
  optionIds: ["rent", "save"]
} as const;

/** 帶合法 pendingDecision 的可變 state（phase 也必須是 pending_decision 才語意一致，這裡只驗 shape）。 */
function pendingState(): Dict {
  const state = mutable();
  state.phase = "pending_decision";
  state.pendingDecision = structuredClone(PENDING_SUMMARY) as unknown as Dict;
  return state;
}

describe("P3-E.1b-1f-0 pendingDecision 形狀", () => {
  it("null 與合法摘要都被接受（shape 不驗 phase 關係）", () => {
    expect(() => readP3EStateShape(mutable())).not.toThrow();
    expect(readP3EStateShape(mutable()).pendingDecision).toBeNull();
    const state = pendingState();
    expect(() => readP3EStateShape(state)).not.toThrow();
    expect(readP3EStateShape(state).pendingDecision).toEqual(PENDING_SUMMARY);
  });

  it("回傳獨立深層凍結副本（含 optionIds）", () => {
    const state = pendingState();
    const output = readP3EStateShape(state);
    expect(isDeepFrozen(output)).toBe(true);
    expect(sharesReference(output, state)).toBe(false);
    expect(output.pendingDecision).not.toBe(state.pendingDecision);
    expect(output.pendingDecision?.optionIds).not.toBe(
      (state.pendingDecision as Dict).optionIds
    );
  });

  it("容器：多餘／缺少／改名／hidden／symbol／accessor／怪 prototype／revoked Proxy", () => {
    const extra = pendingState();
    nodeAt(extra, ["pendingDecision"]).extraField = 1;
    expectShapeError(extra, "E_P3E_DECISION", "pendingDecision");

    const missing = pendingState();
    delete nodeAt(missing, ["pendingDecision"]).year;
    expectShapeError(missing, "E_P3E_DECISION", "pendingDecision");

    const renamed = pendingState();
    delete nodeAt(renamed, ["pendingDecision"]).year;
    nodeAt(renamed, ["pendingDecision"]).years = 2030;
    expectShapeError(renamed, "E_P3E_DECISION", "pendingDecision");

    const hidden = pendingState();
    Object.defineProperty(nodeAt(hidden, ["pendingDecision"]), "hiddenExtra", {
      value: 1,
      enumerable: false,
      configurable: true
    });
    expectShapeError(hidden, "E_P3E_DECISION", "pendingDecision");

    const symbol = pendingState();
    Object.defineProperty(nodeAt(symbol, ["pendingDecision"]), Symbol("extra"), {
      value: 1,
      enumerable: false,
      configurable: true
    });
    expectShapeError(symbol, "E_P3E_DECISION", "pendingDecision");

    const accessor = pendingState();
    let invoked = false;
    const originalYear = nodeAt(accessor, ["pendingDecision"]).year;
    Object.defineProperty(nodeAt(accessor, ["pendingDecision"]), "year", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return originalYear;
      }
    });
    expectShapeError(accessor, "E_P3E_DECISION", "pendingDecision");
    expect(invoked).toBe(false);

    const badProto = pendingState();
    nodeAt(badProto, ["pendingDecision"]).__proto__ = { extra: 1 };
    expectShapeError(badProto, "E_P3E_DECISION", "pendingDecision");

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const revokedState = pendingState();
    revokedState.pendingDecision = revoked.proxy;
    expectShapeError(revokedState, "E_P3E_DECISION", "pendingDecision");

    // 不是物件（非 null）也不是合法摘要
    for (const value of [42, "x", [], true, undefined]) {
      const state = pendingState();
      state.pendingDecision = value;
      expectShapeError(state, "E_P3E_DECISION", "pendingDecision");
    }
  });

  it("year／age 範圍與型別", () => {
    const cases: readonly [string, unknown, string][] = [
      ["year", 1799, "pendingDecision.year"],
      ["year", 2321, "pendingDecision.year"],
      ["year", 2030.5, "pendingDecision.year"],
      ["year", "2030", "pendingDecision.year"],
      ["age", -1, "pendingDecision.age"],
      ["age", 121, "pendingDecision.age"],
      ["age", 30.5, "pendingDecision.age"],
      ["age", null, "pendingDecision.age"]
    ];
    for (const [key, value, path] of cases) {
      const state = pendingState();
      nodeAt(state, ["pendingDecision"])[key] = value;
      expectShapeError(state, "E_P3E_DECISION", path);
    }
  });

  it("eventId／decisionId 用既有 ID pattern", () => {
    for (const value of ["", "ab", "-x", "EV", "a".repeat(65), 42, null]) {
      const state = pendingState();
      nodeAt(state, ["pendingDecision"]).eventId = value;
      expectShapeError(state, "E_P3E_DECISION", "pendingDecision.eventId");

      const other = pendingState();
      nodeAt(other, ["pendingDecision"]).decisionId = value;
      expectShapeError(other, "E_P3E_DECISION", "pendingDecision.decisionId");
    }
  });

  it("selectionHash 必須是 64 位小寫 hex", () => {
    for (const value of ["", "f".repeat(63), "F".repeat(64), "g".repeat(64), 42, null]) {
      const state = pendingState();
      nodeAt(state, ["pendingDecision"]).selectionHash = value;
      expectShapeError(state, "E_P3E_DECISION", "pendingDecision.selectionHash");
    }
  });

  it("optionIds：空／超過 5／重複／非法 ID", () => {
    const cases: readonly [unknown, string][] = [
      [[], "pendingDecision.optionIds"],
      [[], "pendingDecision.optionIds"],
      [["a1", "b2", "c3", "d4", "e5", "f6"], "pendingDecision.optionIds"],
      [["rent", "rent"], "pendingDecision.optionIds[1]"],
      [["rent", "ab"], "pendingDecision.optionIds[1]"],
      [["rent", 42], "pendingDecision.optionIds[1]"],
      [["rent", "save", "x".repeat(65)], "pendingDecision.optionIds[2]"]
    ];
    for (const [value, path] of cases) {
      const state = pendingState();
      nodeAt(state, ["pendingDecision"]).optionIds = value;
      expectShapeError(state, "E_P3E_DECISION", path);
    }
  });

  it("optionIds 必須是密集陣列（稀疏／額外鍵／accessor／symbol 都拒絕）", () => {
    const sparse = pendingState();
    const sparseArray: unknown[] = ["rent", "save"];
    delete sparseArray[1];
    nodeAt(sparse, ["pendingDecision"]).optionIds = sparseArray;
    expectShapeError(sparse, "E_P3E_DECISION", "pendingDecision.optionIds");

    const extraKey = pendingState();
    const arrayWithExtra: unknown[] = ["rent", "save"];
    (arrayWithExtra as unknown as Dict).extraKey = 1;
    nodeAt(extraKey, ["pendingDecision"]).optionIds = arrayWithExtra;
    expectShapeError(extraKey, "E_P3E_DECISION", "pendingDecision.optionIds");

    const accessor = pendingState();
    const arrayWithAccessor: unknown[] = ["rent", "save"];
    Object.defineProperty(arrayWithAccessor, "0", {
      enumerable: true,
      configurable: true,
      get() {
        return "rent";
      }
    });
    nodeAt(accessor, ["pendingDecision"]).optionIds = arrayWithAccessor;
    expectShapeError(accessor, "E_P3E_DECISION", "pendingDecision.optionIds");

    const withSymbol = pendingState();
    const arrayWithSymbol: unknown[] = ["rent", "save"];
    Object.defineProperty(arrayWithSymbol, Symbol("extra"), { value: 1, enumerable: false, configurable: true });
    nodeAt(withSymbol, ["pendingDecision"]).optionIds = arrayWithSymbol;
    expectShapeError(withSymbol, "E_P3E_DECISION", "pendingDecision.optionIds");

    const notArray = pendingState();
    nodeAt(notArray, ["pendingDecision"]).optionIds = "rent,save";
    expectShapeError(notArray, "E_P3E_DECISION", "pendingDecision.optionIds");
  });
});