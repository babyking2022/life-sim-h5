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
import {
  deriveEventRngState,
  MAX_MONEY_PPP_MICRO,
  MoneyError,
  RngError,
  validateEventPack,
  Xoshiro128StarStar
} from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { createP3EGenesis } from "../src/genesis";
import { resolveP3EAnnualRoll } from "../src/annual-roll";
import { encodeP3EState } from "../src/codec";
import { resolveP3ERoll } from "../src/roll";
import { computeP3EStateHash } from "../src/state-hash";

/**
 * P3-E.1b-1b：年度 roll 交易轉接層。
 *
 * state fixture 由真實的 P2-A／P2-B／P3-B／P3-D 驗證器 ＋ `createP3EGenesis` 起頭，
 * 再用 engine 的公開原語把三條 RNG 游標推到指定 age（期待值不經過被測模組的 roll）。
 */

const SEED = "p3e-1b-1b-annual-roll";
const HEX = (char: string) => char.repeat(64);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

const readJson = (relativePath: string): unknown => JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));

/* ------------------------------------------------------------------ */
/* 真實 fixtures                                                       */
/* ------------------------------------------------------------------ */

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

const eventPack = validateEventPack({
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

const certificate = createBirthCertificate(
  base,
  identityPack,
  buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never),
  SEED
);

const genesisState = createP3EGenesis({
  masterSeed: SEED,
  basePack: base,
  identityPack,
  certificate,
  eventPack,
  deathPack
});

/* ------------------------------------------------------------------ */
/* 任意 age 的合法 state builder                                       */
/* ------------------------------------------------------------------ */

const LIFE_INITIAL: readonly [number, number, number, number] = [11, 12, 13, 14];
const DEATH_INITIAL: readonly [number, number, number, number] = [41, 42, 43, 44];

function toWords(words: readonly number[]): [number, number, number, number] {
  return [words[0] as number, words[1] as number, words[2] as number, words[3] as number];
}

function lifeCursorAt(age: number): [number, number, number, number] {
  const rng = new Xoshiro128StarStar([...LIFE_INITIAL]);
  rng.uniformBigInt(41n);
  let words = toWords(rng.state);
  for (let year = 0; year < age; year += 1) {
    const yearRng = new Xoshiro128StarStar([...words]);
    yearRng.uniformInt(-3, 3);
    yearRng.uniformInt(-3, 3);
    yearRng.uniformInt(0, 3);
    yearRng.uniformInt(-2, 2);
    words = toWords(yearRng.state);
  }
  return words;
}

function advance(initial: readonly [number, number, number, number], draws: number): [number, number, number, number] {
  const rng = new Xoshiro128StarStar([...initial]);
  for (let index = 0; index < draws; index += 1) rng.nextU32();
  return toWords(rng.state);
}

interface StateOptions {
  readonly phase?: contracts.P3EPhase;
  readonly pendingDecision?: contracts.P3EPendingDecisionSummary | null;
  readonly balance?: bigint;
  readonly stats?: contracts.P3EStats;
}

/** 建一個 age 歲、指定 phase 的合法 state（identity／packs 沿用 genesis）。 */
function stateAt(age: number, options: StateOptions = {}): contracts.P3ELifeState {
  const phase = options.phase ?? (age >= contracts.P3E_MAX_AGE ? "death" : "life");
  const birthYear = genesisState.identity.birthYear;
  const years = BigInt(age);
  const eventInitial = toWords(deriveEventRngState(LIFE_INITIAL, birthYear));
  const draft = {
    ...genesisState,
    currentYear: birthYear + age,
    age,
    phase,
    pendingDecision: options.pendingDecision ?? null,
    stats: options.stats ?? { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
    assets: {
      balanceMicroUsd: options.balance ?? 1_900_000n,
      annualIncomeMicroUsd:
        age === 0 ? 0n : contracts.P3E_INCOME_BASE_MICRO_USD + years * contracts.P3E_INCOME_PER_YEAR_MICRO_USD,
      annualExpenseMicroUsd:
        age === 0 ? 0n : contracts.P3E_EXPENSE_BASE_MICRO_USD + years * contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD
    },
    flags: age === 0 ? [] : ["p3e:flag-a"],
    occurrences: age === 0 ? [] : [{ eventId: "ev-a", count: 1, lastYear: birthYear + 1 }],
    rng: {
      life: {
        domain: "life" as const,
        initialState: LIFE_INITIAL,
        state: lifeCursorAt(age),
        semanticDraws: contracts.P3E_GENESIS_SEMANTIC_DRAWS + contracts.P3E_ROLL_SEMANTIC_DRAWS * age
      },
      events: {
        domain: "events" as const,
        initialState: eventInitial,
        state: advance(eventInitial, 2 * age),
        u32Draws: 2 * age
      },
      death: {
        domain: "p3e/death" as const,
        initialState: DEATH_INITIAL,
        state: advance(DEATH_INITIAL, 2 * age),
        u32Draws: 2 * age
      }
    },
    // age=0 的 heads／commandLog 必須等於 genesis integrity（不能自由挑選）
    heads:
      age === 0
        ? genesisState.heads
        : {
            lastEntryHash: HEX("a"),
            lastSnapshotHash: HEX("b"),
            lastDeltaHash: HEX("c"),
            hashChain: HEX("d")
          },
    commandLog: age === 0 ? genesisState.commandLog : { count: 3, headHash: HEX("e") }
  };
  return { ...draft, stateHash: computeP3EStateHash(draft as never) } as contracts.P3ELifeState;
}

const AGE_1_INPUT = stateAt(0); // age 0 → 1（genesis 狀態）
const AGE_30 = stateAt(30);
const AGE_119 = stateAt(119);
const AGE_120 = stateAt(120);
const PENDING = stateAt(30, { phase: "pending_decision", pendingDecision: { year: genesisState.identity.birthYear + 30, age: 30, eventId: "ev.adult.housing-choice", decisionId: "dec.adult.housing", selectionHash: HEX("f"), optionIds: ["rent", "save"] } });
const DEAD_30 = stateAt(30, { phase: "death" });

/* ------------------------------------------------------------------ */
/* 輔助                                                                */
/* ------------------------------------------------------------------ */

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function expectRollError(run: () => unknown, code: string, path: string): void {
  const caught = caughtFrom(run);
  expect(isP3EError(caught), `${code} at ${path}`).toBe(true);
  const error = caught as P3EError;
  expect(error.code, `path ${path}`).toBe(code);
  expect(error.path).toBe(path);
  expect(error.message).toBe(`${code} at ${path}`);
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

function sharesReference(output: unknown, input: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  if (output === input) return true;
  const outRecord = output as Dict;
  const inRecord = (typeof input === "object" && input !== null ? input : {}) as Dict;
  return Object.keys(outRecord).some((key) => sharesReference(outRecord[key], inRecord[key]));
}

/** 獨立期待值：直接呼叫公開的 `resolveP3ERoll`（targetAge）。 */
function expectedRoll(state: contracts.P3ELifeState) {
  return resolveP3ERoll({
    rollSpecVersion: state.rollSpecVersion,
    age: state.age + 1,
    stats: state.stats,
    balanceMicroUsd: state.assets.balanceMicroUsd,
    lifeRng: state.rng.life
  });
}

/* ------------------------------------------------------------------ */
/* 一、合法交易                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1b 合法年度 roll", () => {
  it("age 0 → 1：完整前後值", () => {
    const state = AGE_1_INPUT;
    const result = resolveP3EAnnualRoll({ state });
    const expected = expectedRoll(state);

    expect(result.rollSpecVersion).toBe(contracts.P3E_ROLL_SPEC_VERSION);
    expect(result.yearBefore).toBe(state.currentYear);
    expect(result.yearAfter).toBe(state.currentYear + 1);
    expect(result.ageBefore).toBe(0);
    expect(result.ageAfter).toBe(1);
    expect(result.statsBefore).toEqual(state.stats);
    expect(result.statsAfter).toEqual(expected.stats);
    expect(result.assetsBefore).toEqual(state.assets);
    expect(result.assetsAfter).toEqual(expected.assets);
    expect(result.lifeRngBefore).toEqual(state.rng.life);
    expect(result.lifeRngAfter).toEqual(expected.lifeRng);
    expect(result.semanticDrawsUsed).toBe(contracts.P3E_ROLL_SEMANTIC_DRAWS);
  });

  it("一般年度（age 30 → 31）", () => {
    const state = AGE_30;
    const result = resolveP3EAnnualRoll({ state });
    expect(result.ageAfter).toBe(31);
    expect(result.yearAfter).toBe(state.currentYear + 1);
    expect(result.statsAfter).toEqual(expectedRoll(state).stats);
    expect(result.assetsAfter).toEqual(expectedRoll(state).assets);
  });

  it("age 119 → 120 必須合法完成 roll（死亡由後續階段決定）", () => {
    const state = AGE_119;
    expect(state.phase).toBe("life");
    const result = resolveP3EAnnualRoll({ state });
    expect(result.ageBefore).toBe(119);
    expect(result.ageAfter).toBe(120);
    expect(result.yearAfter).toBe(state.currentYear + 1);
    expect(result.statsAfter).toEqual(expectedRoll(state).stats);
    // 收支用 targetAge=120 的公式
    expect(result.assetsAfter.annualIncomeMicroUsd).toBe(
      contracts.P3E_INCOME_BASE_MICRO_USD + 120n * contracts.P3E_INCOME_PER_YEAR_MICRO_USD
    );
    expect(result.assetsAfter.annualExpenseMicroUsd).toBe(
      contracts.P3E_EXPENSE_BASE_MICRO_USD + 120n * contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD
    );
  });

  it("收支公式用 targetAge（不是交易前的 age）", () => {
    for (const state of [AGE_1_INPUT, AGE_30, AGE_119]) {
      const targetAge = state.age + 1;
      const result = resolveP3EAnnualRoll({ state });
      expect(result.assetsAfter.annualIncomeMicroUsd).toBe(
        contracts.P3E_INCOME_BASE_MICRO_USD + BigInt(targetAge) * contracts.P3E_INCOME_PER_YEAR_MICRO_USD
      );
      expect(result.assetsAfter.annualExpenseMicroUsd).toBe(
        contracts.P3E_EXPENSE_BASE_MICRO_USD + BigInt(targetAge) * contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD
      );
      // 明確排除「用交易前 age」的算法
      const wrongIncome = contracts.P3E_INCOME_BASE_MICRO_USD + BigInt(state.age) * contracts.P3E_INCOME_PER_YEAR_MICRO_USD;
      expect(result.assetsAfter.annualIncomeMicroUsd).not.toBe(wrongIncome);
    }
  });

  it("RNG 精確轉移：4 次抽樣、semanticDraws +4、initialState 不變", () => {
    const state = AGE_30;
    const result = resolveP3EAnnualRoll({ state });
    expect(result.lifeRngAfter.semanticDraws).toBe(state.rng.life.semanticDraws + contracts.P3E_ROLL_SEMANTIC_DRAWS);
    expect(result.lifeRngAfter.initialState).toEqual(state.rng.life.initialState);
    expect(result.lifeRngAfter.domain).toBe("life");
    expect(result.lifeRngAfter.state).not.toEqual(state.rng.life.state);
    // 權威 tuple 就是 roll 回傳的實際 state
    expect(result.lifeRngAfter.state).toEqual(expectedRoll(state).lifeRng.state);
    expect(result.semanticDrawsUsed).toBe(4);
  });

  it("100 次重跑逐欄一致", () => {
    const first = resolveP3EAnnualRoll({ state: AGE_30 });
    for (let index = 0; index < 100; index += 1) {
      expect(resolveP3EAnnualRoll({ state: AGE_30 })).toEqual(first);
    }
  });

  it("結果獨立、深層凍結、與輸入零共享", () => {
    const state = AGE_30;
    const result = resolveP3EAnnualRoll({ state });
    expect(isDeepFrozen(result)).toBe(true);
    expect(sharesReference(result, state)).toBe(false);
    expect(result.statsAfter).not.toBe(state.stats);
    expect(result.lifeRngAfter.state).not.toBe(state.rng.life.state);
    expect(() => {
      (result as unknown as Dict).ageAfter = 99;
    }).toThrow(TypeError);
    expect(() => {
      (result.statsAfter as unknown as Dict).health = 99;
    }).toThrow(TypeError);
    expect(() => {
      (result.lifeRngAfter.state as unknown as number[])[0] = 1;
    }).toThrow(TypeError);
  });

  it("不修改輸入（含 hash 與 RNG）", () => {
    const state = AGE_30;
    const before = encodeP3EState(state);
    const rngBefore = structuredClone(state.rng);
    resolveP3EAnnualRoll({ state });
    expect(encodeP3EState(state)).toBe(before);
    expect(state.rng).toEqual(rngBefore);
    expect(state.stateHash).toBe(JSON.parse(before).stateHash);
  });
});

/* ------------------------------------------------------------------ */
/* 二、phase／age 邊界                                                 */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1b phase 邊界", () => {
  it("pending_decision 在消耗 RNG 前就被拒絕", () => {
    expectRollError(() => resolveP3EAnnualRoll({ state: PENDING }), "E_P3E_PHASE", "phase");
  });

  it("age 120 的 death state 被拒絕（不能 roll 到 121）", () => {
    expect(AGE_120.phase).toBe("death");
    expectRollError(() => resolveP3EAnnualRoll({ state: AGE_120 }), "E_P3E_PHASE", "phase");
  });

  it("早逝（age 30 death）也被拒絕", () => {
    expectRollError(() => resolveP3EAnnualRoll({ state: DEAD_30 }), "E_P3E_PHASE", "phase");
  });

  it("被拒絕的呼叫不會消耗 RNG（state 完全不變）", () => {
    for (const state of [PENDING, AGE_120, DEAD_30]) {
      const before = encodeP3EState(state);
      const caught = caughtFrom(() => resolveP3EAnnualRoll({ state }));
      expect((caught as P3EError).code).toBe("E_P3E_PHASE");
      expect(encodeP3EState(state)).toBe(before);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 三、錯誤優先順序                                                    */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1b 錯誤順序", () => {
  it("input shape 最先", () => {
    expectRollError(() => resolveP3EAnnualRoll({ state: PENDING, extra: 1 }), "E_P3E_ARGUMENT", "input");
    expectRollError(() => resolveP3EAnnualRoll(null), "E_P3E_ARGUMENT", "input");
    expectRollError(() => resolveP3EAnnualRoll({}), "E_P3E_ARGUMENT", "input");
  });

  it("state 錯誤早於 phase 錯誤", () => {
    const broken = structuredClone(PENDING) as unknown as Dict;
    broken.stateHash = HEX("0");
    expectRollError(() => resolveP3EAnnualRoll({ state: broken }), "E_P3E_HASH", "stateHash");
  });

  it("phase 錯誤早於 roll 內部的金額錯誤", () => {
    // 就算餘額會溢位，pending_decision 仍然先被 phase 擋下
    const rich = stateAt(30, { phase: "pending_decision", pendingDecision: { year: genesisState.identity.birthYear + 30, age: 30, eventId: "ev.adult.housing-choice", decisionId: "dec.adult.housing", selectionHash: HEX("f"), optionIds: ["rent", "save"] }, balance: MAX_MONEY_PPP_MICRO });
    expectRollError(() => resolveP3EAnnualRoll({ state: rich }), "E_P3E_PHASE", "phase");
  });

  it("roll 內部錯誤（金額溢位）以 P3EError 轉出", () => {
    const rich = stateAt(30, { balance: MAX_MONEY_PPP_MICRO });
    expectRollError(() => resolveP3EAnnualRoll({ state: rich }), "E_P3E_MONEY", "assets.balanceMicroUsd");
  });
});

/* ------------------------------------------------------------------ */
/* 四、input shape                                                     */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1b input shape", () => {
  it("hidden／symbol／accessor 一律拒絕（getter 不執行）", () => {
    const hidden = { state: AGE_30 };
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false, configurable: true });
    expectRollError(() => resolveP3EAnnualRoll(hidden), "E_P3E_ARGUMENT", "input");

    const symbol = { state: AGE_30 };
    Object.defineProperty(symbol, Symbol("extra"), { value: 1, enumerable: false, configurable: true });
    expectRollError(() => resolveP3EAnnualRoll(symbol), "E_P3E_ARGUMENT", "input");

    const accessor: Dict = {};
    let invoked = false;
    Object.defineProperty(accessor, "state", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return AGE_30;
      }
    });
    expectRollError(() => resolveP3EAnnualRoll(accessor), "E_P3E_ARGUMENT", "input");
    expect(invoked).toBe(false);

    const hiddenRequired: Dict = {};
    Object.defineProperty(hiddenRequired, "state", { value: AGE_30, enumerable: false, configurable: true });
    expectRollError(() => resolveP3EAnnualRoll(hiddenRequired), "E_P3E_ARGUMENT", "input");
  });

  it("不是 plain object 一律拒絕；null prototype 可以", () => {
    class Fake {
      public state = AGE_30;
    }
    for (const value of [null, undefined, 42, "input", [], [{ state: AGE_30 }], new Fake(), Object.create({})]) {
      expectRollError(() => resolveP3EAnnualRoll(value), "E_P3E_ARGUMENT", "input");
    }
    const bare = Object.assign(Object.create(null) as Dict, { state: AGE_30 });
    expect(() => resolveP3EAnnualRoll(bare)).not.toThrow();
  });

  it("已撤銷 Proxy 與反射 trap 只回固定錯誤", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectRollError(() => resolveP3EAnnualRoll(revoked.proxy), "E_P3E_ARGUMENT", "input");

    const trap = new Proxy({}, {
      getPrototypeOf() {
        throw new TypeError("proto");
      }
    });
    expectRollError(() => resolveP3EAnnualRoll(trap), "E_P3E_ARGUMENT", "input");

    const keysTrap = new Proxy({}, {
      ownKeys() {
        throw new TypeError("ownKeys");
      }
    });
    expectRollError(() => resolveP3EAnnualRoll(keysTrap), "E_P3E_ARGUMENT", "input");
  });

  it("鍵名被換掉（鍵數相同）→ E_P3E_ARGUMENT at input", () => {
    expectRollError(() => resolveP3EAnnualRoll({ st: AGE_30 }), "E_P3E_ARGUMENT", "input");
    expectRollError(() => resolveP3EAnnualRoll({ State: AGE_30 }), "E_P3E_ARGUMENT", "input");
  });


  it("state 本身不是合法 state 時，錯誤來自 readP3EState", () => {
    expectRollError(() => resolveP3EAnnualRoll({ state: null }), "E_P3E_STATE", "state");
    expectRollError(() => resolveP3EAnnualRoll({ state: { age: 0 } }), "E_P3E_STATE", "state");
  });
});

/* ------------------------------------------------------------------ */
/* 五、公開表面                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1b 公開表面", () => {
  it("入口不在公開 barrel", () => {
    expect(typeof resolveP3EAnnualRoll).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.resolveP3EAnnualRoll).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("不 seal、不改 state（回傳的不是 P3ELifeState）", () => {
    const result = resolveP3EAnnualRoll({ state: AGE_30 });
    expect(Object.keys(result)).not.toContain("identity");
    expect(Object.keys(result)).not.toContain("stateHash");
    expect(Object.keys(result).sort()).toEqual([
      "ageAfter",
      "ageBefore",
      "assetsAfter",
      "assetsBefore",
      "lifeRngAfter",
      "lifeRngBefore",
      "rollSpecVersion",
      "semanticDrawsUsed",
      "statsAfter",
      "statsBefore",
      "yearAfter",
      "yearBefore"
    ]);
  });
});
