import { describe, expect, it } from "vitest";
import * as contracts from "@life-sim/contracts";
import { deriveEventRngState, MAX_MONEY_PPP_MICRO, MoneyError, RngError, Xoshiro128StarStar } from "@life-sim/engine";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { readP3EState } from "../src/state-invariants";
import { computeP3EStateHash, createP3EGenesisIntegrity } from "../src/state-hash";

/**
 * P3-E.1a-2c-2b：state 跨欄位語意不變量 ＋ stateHash。
 *
 * fixture 由本檔的 builder 自己用 engine 公開原語算出（burn ＋ 逐年四次抽樣、
 * `deriveEventRngState`、`nextU32()` 轉移），**不呼叫** 被測模組的 roll／invariants，
 * 因此期待值是獨立的。
 */

const HEX = (char: string) => char.repeat(64);
const BIRTH_YEAR = 2000;
const LIFE_INITIAL: contracts.P3EWordTuple = [11, 12, 13, 14];
const DEATH_INITIAL: contracts.P3EWordTuple = [41, 42, 43, 44];
const BASE_PACK_ID = "p2a-synthetic-20261027";
const BASE_PACK_CHECKSUM = HEX("4");

type Dict = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* Fixture builder                                                     */
/* ------------------------------------------------------------------ */

function toWords(words: readonly number[]): contracts.P3EWordTuple {
  return [words[0] as number, words[1] as number, words[2] as number, words[3] as number];
}

/** 從 life initialState 推到 age 歲的游標：一次 burn ＋ 每年四次語意抽樣。 */
function lifeCursorAt(age: number): contracts.P3EWordTuple {
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

/** 從 initial 精確呼叫 `nextU32()` 共 draws 次。 */
function advance(initial: contracts.P3EWordTuple, draws: number): contracts.P3EWordTuple {
  const rng = new Xoshiro128StarStar([...initial]);
  for (let index = 0; index < draws; index += 1) rng.nextU32();
  return toWords(rng.state);
}

interface Options {
  readonly phase?: contracts.P3EPhase;
  readonly flags?: readonly string[];
  readonly occurrences?: readonly contracts.P3EEventOccurrence[];
  readonly eventDraws?: number;
  readonly deathDraws?: number;
  readonly income?: bigint;
  readonly expense?: bigint;
  readonly eventCount?: number;
  readonly pendingDecision?: contracts.P3EPendingDecisionSummary | null;
}

/** 建一個「所有不變量都成立」的 state（age=0 時含 Genesis integrity）。 */
function buildState(age: number, options: Options = {}): contracts.P3ELifeState {
  const phase = options.phase ?? (age >= contracts.P3E_MAX_AGE ? "death" : "life");
  const years = BigInt(age);
  const eventDraws = options.eventDraws ?? (age === 0 ? 0 : 2 * age);
  const deathDraws = options.deathDraws ?? (age === 0 ? 0 : 2 * age);
  const eventInitial = toWords(deriveEventRngState(LIFE_INITIAL, BIRTH_YEAR));

  const base: Dict = {
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
      birthYear: BIRTH_YEAR,
      certificateId: "cert:0",
      certificateHash: HEX("1"),
      playerIdentityHash: HEX("2"),
      masterSeedHash: HEX("3"),
      basePackId: BASE_PACK_ID,
      basePackChecksum: BASE_PACK_CHECKSUM,
      identityPackId: "p2b-synthetic",
      identityPackChecksum: HEX("5")
    },
    packs: {
      events: {
        eventSchemaVersion: contracts.P3B_SCHEMA_VERSION,
        eventSpecVersion: contracts.P3B_EVENT_SPEC_VERSION,
        contentPackVersion: "1.0.0",
        eventPackId: "p3b-synthetic-events-v1",
        eventPackChecksum: HEX("6"),
        datasetChecksum: HEX("7"),
        eventCount: options.eventCount ?? 22
      },
      death: {
        schemaVersion: contracts.P3D_SCHEMA_VERSION,
        deathDataVersion: "1.0.0",
        deathSpecVersion: contracts.P3D_DEATH_SPEC_VERSION,
        healthRuleVersion: contracts.P3D_HEALTH_RULE_VERSION,
        engineVersion: contracts.P3D_ENGINE_VERSION,
        rngSpecVersion: contracts.P3D_RNG_SPEC_VERSION,
        deathPackId: "p3d-synthetic-mortality-v1",
        deathPackChecksum: HEX("8"),
        basePackId: BASE_PACK_ID,
        basePackChecksum: BASE_PACK_CHECKSUM,
        entityCount: 169
      }
    },
    currentYear: BIRTH_YEAR + age,
    age,
    phase,
    pendingDecision: options.pendingDecision ?? null,
    stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
    assets: {
      balanceMicroUsd: 1_900_000n,
      annualIncomeMicroUsd: options.income ?? (age === 0 ? 0n : contracts.P3E_INCOME_BASE_MICRO_USD + years * contracts.P3E_INCOME_PER_YEAR_MICRO_USD),
      annualExpenseMicroUsd:
        options.expense ?? (age === 0 ? 0n : contracts.P3E_EXPENSE_BASE_MICRO_USD + years * contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD)
    },
    flags: options.flags ?? [],
    occurrences: options.occurrences ?? [],
    rng: {
      life: {
        domain: "life",
        initialState: LIFE_INITIAL,
        state: lifeCursorAt(age),
        semanticDraws: contracts.P3E_GENESIS_SEMANTIC_DRAWS + contracts.P3E_ROLL_SEMANTIC_DRAWS * age
      },
      events: {
        domain: "events",
        initialState: eventInitial,
        state: advance(eventInitial, eventDraws),
        u32Draws: eventDraws
      },
      death: {
        domain: "p3e/death",
        initialState: DEATH_INITIAL,
        state: advance(DEATH_INITIAL, deathDraws),
        u32Draws: deathDraws
      }
    },
    heads: {
      lastEntryHash: HEX("a"),
      lastSnapshotHash: HEX("b"),
      lastDeltaHash: HEX("c"),
      hashChain: HEX("d")
    },
    commandLog: { count: age === 0 ? 0 : 3, headHash: HEX("e") },
    stateHash: HEX("0")
  };

  const draft =
    age === 0
      ? (() => {
          const integrity = createP3EGenesisIntegrity(base as unknown as contracts.P3ELifeState);
          return { ...base, heads: integrity.heads, commandLog: integrity.commandLog };
        })()
      : base;

  return { ...draft, stateHash: computeP3EStateHash(draft as unknown as contracts.P3ELifeState) } as unknown as contracts.P3ELifeState;
}

/** 複製一份可變 draft（不影響原 fixture）。 */
function draftOf(base: contracts.P3ELifeState): Dict {
  return structuredClone(base) as unknown as Dict;
}

function nodeAt(root: Dict, path: readonly (string | number)[]): Dict {
  let node: unknown = root;
  for (const step of path) node = (node as Dict)[step as string];
  return node as Dict;
}

/** 改完之後若動到 projection 欄位，stateHash 會過期——這正是要驗「語意錯誤先於 hash」。 */
function mutate(base: contracts.P3ELifeState, change: (draft: Dict) => void): Dict {
  const draft = draftOf(base);
  change(draft);
  return draft;
}

/** 給「改完仍然合法」的案例用：重算 stateHash。 */
function withFreshHash(draft: Dict): Dict {
  return { ...draft, stateHash: computeP3EStateHash(draft as unknown as contracts.P3ELifeState) };
}

/* ------------------------------------------------------------------ */
/* 斷言輔助                                                            */
/* ------------------------------------------------------------------ */

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function expectInvariantError(input: unknown, code: string, path: string): void {
  const caught = caughtFrom(() => readP3EState(input));
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

/* ------------------------------------------------------------------ */
/* 一、合法 state                                                      */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2b 合法 state", () => {
  const fixtures: readonly [string, number][] = [
    ["age 0（genesis）", 0],
    ["age 1", 1],
    ["age 30（life）", 30],
    ["age 17（早逝 death）", 17],
    ["age 119（death）", 119],
    ["age 120（death）", 120]
  ];

  for (const [label, age] of fixtures) {
    it(`${label} 通過`, () => {
      const state = buildState(age, age === 17 ? { phase: "death" } : {});
      expect(() => readP3EState(state)).not.toThrow();
      expect(readP3EState(state)).toEqual(state);
    });
  }

  it("1–119 歲允許 pending_decision（需合法摘要）與 death（自然死亡合法）", () => {
    for (const [age, phase] of [
      [1, "pending_decision"],
      [59, "pending_decision"],
      [119, "death"]
    ] as const) {
      const pendingDecision =
        phase === "pending_decision"
          ? {
              year: BIRTH_YEAR + age,
              age,
              eventId: "ev.adult.housing-choice",
              decisionId: "dec.adult.housing",
              selectionHash: HEX("f"),
              optionIds: ["rent", "save"]
            }
          : null;
      expect(() => readP3EState(buildState(age, { phase, pendingDecision }))).not.toThrow();
    }
  });

  it("age=0 的初始收支值不在本批凍結（任意合法範圍都可）", () => {
    for (const [income, expense] of [
      [0n, 0n],
      [1n, 1n],
      [contracts.P3E_INCOME_BASE_MICRO_USD, contracts.P3E_EXPENSE_BASE_MICRO_USD]
    ] as const) {
      expect(() => readP3EState(buildState(0, { income, expense }))).not.toThrow();
    }
  });

  it("輸入不被修改；輸出深層凍結且與輸入斷開", () => {
    const input = draftOf(buildState(30));
    const before = structuredClone(input);
    const output = readP3EState(input);
    expect(input).toEqual(before);
    expect(isDeepFrozen(output)).toBe(true);
    expect(sharesReference(output, input)).toBe(false);
    expect(() => {
      (output as unknown as Dict).age = 1;
    }).toThrow(TypeError);
  });

  it("錯誤一定是 P3EError（合法 fixture 的突變也只會回固定碼）", () => {
    const draft = mutate(buildState(30), (state) => {
      state.currentYear = BIRTH_YEAR + 30 + 1;
    });
    expectInvariantError(draft, "E_P3E_STATE", "currentYear");
  });
});

/* ------------------------------------------------------------------ */
/* 二、固定順序（語意錯誤先於 hash mismatch）                          */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2b 驗證順序", () => {
  it("shape 錯誤最先（即使其他欄位也錯）", () => {
    const draft = mutate(buildState(30), (state) => {
      delete state.age;
    });
    expectInvariantError(draft, "E_P3E_STATE", "state");
  });

  it("pack 版本先於年份", () => {
    const draft = mutate(buildState(30), (state) => {
      nodeAt(state, ["packs", "events"]).eventSchemaVersion = "p3b-9";
      state.currentYear = BIRTH_YEAR + 30 + 1;
    });
    expectInvariantError(draft, "E_P3E_EVENT_PACK", "packs.events.eventSchemaVersion");
  });

  it("綁定先於 flags", () => {
    const draft = mutate(buildState(30), (state) => {
      nodeAt(state, ["packs", "death"]).basePackId = "other";
      state.flags = ["p3e:b", "p3e:a"];
    });
    expectInvariantError(draft, "E_P3E_BINDING", "packs.death.basePackId");
  });

  it("年份／phase 先於 flags", () => {
    const draft = mutate(buildState(30), (state) => {
      state.currentYear = BIRTH_YEAR + 30 + 1;
      state.flags = ["p3e:b", "p3e:a"];
    });
    expectInvariantError(draft, "E_P3E_STATE", "currentYear");
  });

  it("flags 先於 occurrences", () => {
    const draft = mutate(buildState(30), (state) => {
      state.flags = ["p3e:b", "p3e:a"];
      state.occurrences = [{ eventId: "ev-b", count: 1, lastYear: 2001 }];
    });
    expectInvariantError(draft, "E_P3E_STATE", "flags[1]");
  });

  it("occurrences 先於 RNG", () => {
    const draft = mutate(buildState(30), (state) => {
      state.occurrences = [
        { eventId: "ev-b", count: 1, lastYear: 2001 },
        { eventId: "ev-a", count: 1, lastYear: 2002 }
      ];
      nodeAt(state, ["rng", "life"]).semanticDraws = 5;
    });
    expectInvariantError(draft, "E_P3E_EVENT", "occurrences[1].eventId");
  });

  it("年度收支不再是語意關卡（H5-CTO-146-A）：只有 RNG 會擋", () => {
    const draft = mutate(buildState(30), (state) => {
      nodeAt(state, ["assets"]).annualIncomeMicroUsd = 1n;
      nodeAt(state, ["rng", "life"]).semanticDraws = 5;
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.life.semanticDraws");
  });

  it("RNG 先於 Genesis integrity 與 stateHash", () => {
    const draft = mutate(buildState(0), (state) => {
      nodeAt(state, ["rng", "life"]).semanticDraws = 99;
      nodeAt(state, ["heads"]).hashChain = HEX("0");
      state.stateHash = HEX("0");
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.life.semanticDraws");
  });

  it("Genesis integrity 先於 stateHash", () => {
    const draft = mutate(buildState(0), (state) => {
      nodeAt(state, ["heads"]).lastEntryHash = HEX("0");
      state.stateHash = HEX("0");
    });
    expectInvariantError(draft, "E_P3E_HISTORY", "heads.lastEntryHash");
  });

  it("語意全部正確但 stateHash 過期 → E_P3E_HASH", () => {
    const draft = mutate(buildState(30), (state) => {
      state.stateHash = HEX("0");
    });
    expectInvariantError(draft, "E_P3E_HASH", "stateHash");
  });
});

/* ------------------------------------------------------------------ */
/* 三、Pack 版本與綁定                                                 */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2b pack 版本", () => {
  it("事件包三個版本欄位", () => {
    const cases: readonly [string, unknown][] = [
      ["eventSchemaVersion", "p3b-9"],
      ["eventSpecVersion", "2.0.0"],
      ["contentPackVersion", "1.0"]
    ];
    for (const [key, value] of cases) {
      const draft = mutate(buildState(30), (state) => {
        nodeAt(state, ["packs", "events"])[key] = value;
      });
      expectInvariantError(draft, "E_P3E_EVENT_PACK", `packs.events.${key}`);
    }
    // pattern 允許 x.y.z
    expect(() =>
      readP3EState(
        withFreshHash(
          mutate(buildState(30), (state) => {
            nodeAt(state, ["packs", "events"]).contentPackVersion = "12.34.56";
          })
        )
      )
    ).not.toThrow();
  });

  it("死亡包六個版本欄位", () => {
    const cases: readonly [string, unknown][] = [
      ["schemaVersion", "p3d-2"],
      ["deathSpecVersion", "2.0.0"],
      ["healthRuleVersion", "p3d-health-2.0.0"],
      ["engineVersion", "9.9.9"],
      ["rngSpecVersion", "9.9.9"],
      ["deathDataVersion", "1.0"]
    ];
    for (const [key, value] of cases) {
      const draft = mutate(buildState(30), (state) => {
        nodeAt(state, ["packs", "death"])[key] = value;
      });
      expectInvariantError(draft, "E_P3E_DEATH_PACK", `packs.death.${key}`);
    }
  });

  it("identity ↔ death pack 的 basePack 綁定", () => {
    const idMismatch = mutate(buildState(30), (state) => {
      nodeAt(state, ["packs", "death"]).basePackId = "p2a-other";
    });
    expectInvariantError(idMismatch, "E_P3E_BINDING", "packs.death.basePackId");

    const checksumMismatch = mutate(buildState(30), (state) => {
      nodeAt(state, ["packs", "death"]).basePackChecksum = HEX("9");
    });
    expectInvariantError(checksumMismatch, "E_P3E_BINDING", "packs.death.basePackChecksum");
  });
});

/* ------------------------------------------------------------------ */
/* 四、年份與 phase                                                    */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2b 年份與 phase", () => {
  it("currentYear ±1", () => {
    for (const delta of [1, -1]) {
      const draft = mutate(buildState(30), (state) => {
        state.currentYear = BIRTH_YEAR + 30 + delta;
      });
      expectInvariantError(draft, "E_P3E_STATE", "currentYear");
    }
  });

  it("age=0 只能是 life", () => {
    for (const phase of ["pending_decision", "death"]) {
      const draft = mutate(buildState(0), (state) => {
        state.phase = phase;
      });
      expectInvariantError(draft, "E_P3E_PHASE", "phase");
    }
  });

  it("age=0 的 pendingDecision 必須是 null（phase 只能是 life）", () => {
    const draft = withFreshHash(
      mutate(buildState(0), (state) => {
        state.pendingDecision = {
          year: BIRTH_YEAR,
          age: 0,
          eventId: "ev.adult.housing-choice",
          decisionId: "dec.adult.housing",
          selectionHash: HEX("f"),
          optionIds: ["rent", "save"]
        };
      })
    );
    expectInvariantError(draft, "E_P3E_PHASE", "phase");
  });

  it("age=120 必須是 death", () => {
    for (const phase of ["life", "pending_decision"]) {
      const draft = mutate(buildState(120), (state) => {
        state.phase = phase;
      });
      expectInvariantError(draft, "E_P3E_PHASE", "phase");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 五、flags                                                           */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2b flags", () => {
  it("必須嚴格升冪（重複、逆序都拒絕）", () => {
    const duplicate = mutate(buildState(30), (state) => {
      state.flags = ["p3e:a", "p3e:a"];
    });
    expectInvariantError(duplicate, "E_P3E_STATE", "flags[1]");

    const reversed = mutate(buildState(30), (state) => {
      state.flags = ["p3e:b", "p3e:a"];
    });
    expectInvariantError(reversed, "E_P3E_STATE", "flags[1]");

    const unsorted = mutate(buildState(30), (state) => {
      state.flags = ["p3e:a", "p3e:c", "p3e:b"];
    });
    expectInvariantError(unsorted, "E_P3E_STATE", "flags[2]");
  });

  it("已排序的 flags 通過", () => {
    expect(() => readP3EState(buildState(30, { flags: ["p3e:a", "p3e:b", "p3e:z"] }))).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 六、occurrences                                                     */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2b occurrences", () => {
  it("eventId 必須嚴格升冪且唯一", () => {
    const duplicate = mutate(buildState(30), (state) => {
      state.occurrences = [
        { eventId: "ev-a", count: 1, lastYear: 2001 },
        { eventId: "ev-a", count: 1, lastYear: 2002 }
      ];
    });
    expectInvariantError(duplicate, "E_P3E_EVENT", "occurrences[1].eventId");

    const reversed = mutate(buildState(30), (state) => {
      state.occurrences = [
        { eventId: "ev-b", count: 1, lastYear: 2001 },
        { eventId: "ev-a", count: 1, lastYear: 2002 }
      ];
    });
    expectInvariantError(reversed, "E_P3E_EVENT", "occurrences[1].eventId");
  });

  it("長度上限 = min(4096, eventCount, age)", () => {
    // eventCount 比 age 小：以 eventCount 為上限
    const tooManyForPack = mutate(buildState(30, { eventCount: 1 }), (state) => {
      state.occurrences = [
        { eventId: "ev-a", count: 1, lastYear: 2001 },
        { eventId: "ev-b", count: 1, lastYear: 2002 }
      ];
    });
    expectInvariantError(tooManyForPack, "E_P3E_EVENT", "occurrences");

    // age 比 eventCount 小：以 age 為上限
    const tooManyForAge = mutate(buildState(2), (state) => {
      state.occurrences = [
        { eventId: "ev-a", count: 1, lastYear: 2001 },
        { eventId: "ev-b", count: 1, lastYear: 2002 },
        { eventId: "ev-c", count: 1, lastYear: 2002 }
      ];
    });
    expectInvariantError(tooManyForAge, "E_P3E_EVENT", "occurrences");

    // age=0 時上限是 0（genesis 必須空）
    const genesisOccurrence = mutate(buildState(0), (state) => {
      state.occurrences = [{ eventId: "ev-a", count: 1, lastYear: 2001 }];
    });
    expectInvariantError(genesisOccurrence, "E_P3E_EVENT", "occurrences");
  });

  it("lastYear 必須介於 birthYear+1 與 currentYear", () => {
    const tooEarly = mutate(buildState(30), (state) => {
      state.occurrences = [{ eventId: "ev-a", count: 1, lastYear: BIRTH_YEAR }];
    });
    expectInvariantError(tooEarly, "E_P3E_EVENT", "occurrences[0].lastYear");

    const tooLate = mutate(buildState(30), (state) => {
      state.occurrences = [{ eventId: "ev-a", count: 1, lastYear: BIRTH_YEAR + 31 }];
    });
    expectInvariantError(tooLate, "E_P3E_EVENT", "occurrences[0].lastYear");
  });

  it("count 不得超過 lastYear − birthYear", () => {
    const draft = mutate(buildState(30), (state) => {
      state.occurrences = [{ eventId: "ev-a", count: 6, lastYear: BIRTH_YEAR + 5 }];
    });
    expectInvariantError(draft, "E_P3E_EVENT", "occurrences[0].count");

    // 剛好等於上限就合法
    expect(() =>
      readP3EState(buildState(30, { occurrences: [{ eventId: "ev-a", count: 5, lastYear: BIRTH_YEAR + 5 }] }))
    ).not.toThrow();
  });

  it("count 總和不得超過 age", () => {
    const draft = mutate(buildState(3), (state) => {
      state.occurrences = [
        { eventId: "ev-a", count: 2, lastYear: BIRTH_YEAR + 3 },
        { eventId: "ev-b", count: 2, lastYear: BIRTH_YEAR + 3 }
      ];
    });
    expectInvariantError(draft, "E_P3E_EVENT", "occurrences");

    // 總和剛好等於 age 合法
    expect(() =>
      readP3EState(
        buildState(3, {
          occurrences: [
            { eventId: "ev-a", count: 2, lastYear: BIRTH_YEAR + 3 },
            { eventId: "ev-b", count: 1, lastYear: BIRTH_YEAR + 3 }
          ]
        })
      )
    ).not.toThrow();
  });

  it("已排序且合法的 occurrences 通過", () => {
    expect(() =>
      readP3EState(
        buildState(30, {
          occurrences: [
            { eventId: "ev-a", count: 1, lastYear: 2001 },
            { eventId: "ev-b", count: 2, lastYear: 2003 }
          ]
        })
      )
    ).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 七、年度收支                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2g 年度收支（Roll 基準 vs effects 後結果）", () => {
  const MAX_MONEY = MAX_MONEY_PPP_MICRO;

  it("精確基準公式值仍被接受（age 1／30／59／60／100／120）", () => {
    for (const age of [1, 30, 59, 60, 100, 120]) {
      expect(() => readP3EState(buildState(age))).not.toThrow();
    }
  });

  it("基準 income 加上合法事件 delta → 接受（不再要求精確等於公式）", () => {
    const base = buildState(30);
    const draft = withFreshHash(
      mutate(base, (state) => {
        nodeAt(state, ["assets"]).annualIncomeMicroUsd = base.assets.annualIncomeMicroUsd + 9_000_000n;
      })
    );
    const state = readP3EState(draft);
    expect(state.assets.annualIncomeMicroUsd).toBe(base.assets.annualIncomeMicroUsd + 9_000_000n);
  });

  it("基準 expense 加上合法事件 delta → 接受（決策選項的 rent 就是這種）", () => {
    const base = buildState(30);
    const draft = withFreshHash(
      mutate(base, (state) => {
        nodeAt(state, ["assets"]).annualExpenseMicroUsd = base.assets.annualExpenseMicroUsd + 9_000_000n;
      })
    );
    const state = readP3EState(draft);
    expect(state.assets.annualExpenseMicroUsd).toBe(base.assets.annualExpenseMicroUsd + 9_000_000n);
  });

  it("income／expense 同時被合法 effects 修改 → 接受", () => {
    const base = buildState(30);
    const draft = withFreshHash(
      mutate(base, (state) => {
        nodeAt(state, ["assets"]).annualIncomeMicroUsd = base.assets.annualIncomeMicroUsd + 3_000_000n;
        nodeAt(state, ["assets"]).annualExpenseMicroUsd = base.assets.annualExpenseMicroUsd + 2_000_000n;
      })
    );
    const state = readP3EState(draft);
    expect(state.assets.annualIncomeMicroUsd).toBe(base.assets.annualIncomeMicroUsd + 3_000_000n);
    expect(state.assets.annualExpenseMicroUsd).toBe(base.assets.annualExpenseMicroUsd + 2_000_000n);
  });

  it("合法的 0 值 → 接受", () => {
    const draft = withFreshHash(
      mutate(buildState(30), (state) => {
        nodeAt(state, ["assets"]).annualIncomeMicroUsd = 0n;
        nodeAt(state, ["assets"]).annualExpenseMicroUsd = 0n;
      })
    );
    const state = readP3EState(draft);
    expect(state.assets.annualIncomeMicroUsd).toBe(0n);
    expect(state.assets.annualExpenseMicroUsd).toBe(0n);
  });

  it("合法 Money 上界 → 接受", () => {
    const draft = withFreshHash(
      mutate(buildState(30), (state) => {
        nodeAt(state, ["assets"]).annualIncomeMicroUsd = MAX_MONEY;
        nodeAt(state, ["assets"]).annualExpenseMicroUsd = MAX_MONEY;
      })
    );
    const state = readP3EState(draft);
    expect(state.assets.annualIncomeMicroUsd).toBe(MAX_MONEY);
    expect(state.assets.annualExpenseMicroUsd).toBe(MAX_MONEY);
  });

  it("負 income／expense → 由 shape 拒絕（既有精確 path）", () => {
    for (const key of ["annualIncomeMicroUsd", "annualExpenseMicroUsd"] as const) {
      const draft = mutate(buildState(30), (state) => {
        nodeAt(state, ["assets"])[key] = -1n;
      });
      expectInvariantError(draft, "E_P3E_MONEY", `assets.${key}`);
    }
  });

  it("超過 Money 上限 → 由 shape 拒絕", () => {
    for (const key of ["annualIncomeMicroUsd", "annualExpenseMicroUsd"] as const) {
      const draft = mutate(buildState(30), (state) => {
        nodeAt(state, ["assets"])[key] = MAX_MONEY + 1n;
      });
      expectInvariantError(draft, "E_P3E_MONEY", `assets.${key}`);
    }
  });

  it("非 bigint（number／string／null）→ 由 shape 拒絕", () => {
    for (const key of ["annualIncomeMicroUsd", "annualExpenseMicroUsd"] as const) {
      for (const value of [1, "1000000", null, undefined, {}, []] as const) {
        const draft = mutate(buildState(30), (state) => {
          nodeAt(state, ["assets"])[key] = value;
        });
        expectInvariantError(draft, "E_P3E_MONEY", `assets.${key}`);
      }
    }
  });

  it("缺欄／多欄／accessor → 由 shape 拒絕", () => {
    const missing = mutate(buildState(30), (state) => {
      delete nodeAt(state, ["assets"]).annualIncomeMicroUsd;
    });
    expectInvariantError(missing, "E_P3E_MONEY", "assets");

    const extra = mutate(buildState(30), (state) => {
      nodeAt(state, ["assets"]).extraField = 1n;
    });
    expectInvariantError(extra, "E_P3E_MONEY", "assets");

    const accessor = mutate(buildState(30), (state) => {
      const assets = nodeAt(state, ["assets"]);
      const value = assets.annualExpenseMicroUsd;
      Object.defineProperty(assets, "annualExpenseMicroUsd", {
        enumerable: true,
        configurable: true,
        get() {
          return value;
        }
      });
    });
    expectInvariantError(accessor, "E_P3E_MONEY", "assets");
  });

  it("公式在 age 1／59／60／100／120 都成立（buildState 的基準值）", () => {
    for (const age of [1, 59, 60, 100, 120]) {
      const state = buildState(age);
      expect(state.assets.annualIncomeMicroUsd).toBe(1_000_000n + BigInt(age) * 100_000n);
      expect(state.assets.annualExpenseMicroUsd).toBe(600_000n + BigInt(age) * 50_000n);
      expect(() => readP3EState(state)).not.toThrow();
    }
  });

  it("不從目前餘額反推上一年（balance 任意合法值都不影響）", () => {
    for (const balance of [-1n, 0n, 123n, 999_999_999n]) {
      const draft = withFreshHash(
        mutate(buildState(30), (state) => {
          nodeAt(state, ["assets"]).balanceMicroUsd = balance;
        })
      );
      expect(() => readP3EState(draft)).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 八、RNG 會計與轉移                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2b life RNG", () => {
  it("semanticDraws 必須是 1 + 4×age", () => {
    for (const delta of [1, -1]) {
      const draft = mutate(buildState(30), (state) => {
        nodeAt(state, ["rng", "life"]).semanticDraws = 1 + 4 * 30 + delta;
      });
      expectInvariantError(draft, "E_P3E_RNG", "rng.life.semanticDraws");
    }
  });

  it("current state 任一個字被改都拒絕（四個字）", () => {
    for (let index = 0; index < 4; index += 1) {
      const draft = mutate(buildState(30), (state) => {
        const words = nodeAt(state, ["rng", "life"]).state as number[];
        words[index] = (words[index] as number) + 1;
      });
      expectInvariantError(draft, "E_P3E_RNG", "rng.life.state");
    }
  });

  it("initialState 被改（推導結果對不上）也拒絕", () => {
    const draft = mutate(buildState(30), (state) => {
      const words = nodeAt(state, ["rng", "life"]).initialState as number[];
      words[0] = (words[0] as number) + 1;
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.life.state");
  });

  it("age=0 時 life 游標恰好是一次 burn（多 burn 一次就拒絕）", () => {
    const draft = mutate(buildState(0), (state) => {
      const rng = new Xoshiro128StarStar([...LIFE_INITIAL]);
      rng.uniformBigInt(41n);
      rng.uniformBigInt(41n);
      nodeAt(state, ["rng", "life"]).state = [rng.state[0], rng.state[1], rng.state[2], rng.state[3]];
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.life.state");
  });
});

describe("P3-E.1a-2c-2b event RNG", () => {
  it("initialState 必須等於 deriveEventRngState(lifeInitial, birthYear)", () => {
    const draft = mutate(buildState(30), (state) => {
      const words = nodeAt(state, ["rng", "events"]).initialState as number[];
      words[1] = (words[1] as number) + 1;
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.events.initialState");
  });

  it("u32Draws 必須是偶數", () => {
    const draft = mutate(buildState(30), (state) => {
      nodeAt(state, ["rng", "events"]).u32Draws = 3;
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.events.u32Draws");
  });

  it("u32Draws 不得超過 256 × age", () => {
    const age = 30;
    const over = contracts.P3E_MAX_U32_DRAWS_PER_EVENT * age + 2;
    const draft = mutate(buildState(age), (state) => {
      nodeAt(state, ["rng", "events"]).u32Draws = over;
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.events.u32Draws");

    // 剛好等於上限（偶數）是合法的
    const atLimit = withFreshHash(
      mutate(buildState(age), (state) => {
        const words = nodeAt(state, ["rng", "events"]).initialState as number[];
        const initial: contracts.P3EWordTuple = [words[0] as number, words[1] as number, words[2] as number, words[3] as number];
        nodeAt(state, ["rng", "events"]).u32Draws = contracts.P3E_MAX_U32_DRAWS_PER_EVENT * age;
        nodeAt(state, ["rng", "events"]).state = advance(initial, contracts.P3E_MAX_U32_DRAWS_PER_EVENT * age);
      })
    );
    expect(() => readP3EState(atLimit)).not.toThrow();
  });

  it("current state 必須是 initialState 精確推進 u32Draws 次的結果", () => {
    const draft = mutate(buildState(30), (state) => {
      const words = nodeAt(state, ["rng", "events"]).state as number[];
      words[3] = (words[3] as number) + 1;
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.events.state");
  });
});

describe("P3-E.1a-2c-2b death RNG", () => {
  it("u32Draws 必須是偶數", () => {
    const draft = mutate(buildState(30), (state) => {
      nodeAt(state, ["rng", "death"]).u32Draws = 1;
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.death.u32Draws");
  });

  it("u32Draws 不得超過 512 × age", () => {
    const age = 30;
    const draft = mutate(buildState(age), (state) => {
      nodeAt(state, ["rng", "death"]).u32Draws = contracts.P3E_MAX_U32_DRAWS_PER_DEATH_YEAR * age + 2;
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.death.u32Draws");

    const atLimit = withFreshHash(
      mutate(buildState(age), (state) => {
        nodeAt(state, ["rng", "death"]).u32Draws = contracts.P3E_MAX_U32_DRAWS_PER_DEATH_YEAR * age;
        nodeAt(state, ["rng", "death"]).state = advance(DEATH_INITIAL, contracts.P3E_MAX_U32_DRAWS_PER_DEATH_YEAR * age);
      })
    );
    expect(() => readP3EState(atLimit)).not.toThrow();
  });

  it("current state 必須是 initialState 精確推進 u32Draws 次的結果", () => {
    const draft = mutate(buildState(30), (state) => {
      const words = nodeAt(state, ["rng", "death"]).state as number[];
      words[0] = (words[0] as number) + 1;
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.death.state");
  });

  it("本批不設定 death draws 的最低值（0 也合法，age>0）", () => {
    expect(() => readP3EState(buildState(30, { deathDraws: 0 }))).not.toThrow();
    expect(() => readP3EState(buildState(30, { eventDraws: 0 }))).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 九、age=0 Genesis integrity                                         */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2b genesis integrity", () => {
  it("age=0 的 flags 必須為空", () => {
    const draft = mutate(buildState(0), (state) => {
      state.flags = ["p3e:a"];
    });
    expectInvariantError(draft, "E_P3E_STATE", "flags");
  });

  it("age=0 的 event／death draws 必須是 0（由上限擋下）", () => {
    const eventDraft = mutate(buildState(0), (state) => {
      nodeAt(state, ["rng", "events"]).u32Draws = 2;
    });
    expectInvariantError(eventDraft, "E_P3E_RNG", "rng.events.u32Draws");

    const deathDraft = mutate(buildState(0), (state) => {
      nodeAt(state, ["rng", "death"]).u32Draws = 2;
    });
    expectInvariantError(deathDraft, "E_P3E_RNG", "rng.death.u32Draws");
  });

  it("age=0 的 event／death current state 必須等於 initialState", () => {
    const eventDraft = mutate(buildState(0), (state) => {
      const words = nodeAt(state, ["rng", "events"]).state as number[];
      words[0] = (words[0] as number) + 1;
    });
    expectInvariantError(eventDraft, "E_P3E_RNG", "rng.events.state");

    const deathDraft = mutate(buildState(0), (state) => {
      const words = nodeAt(state, ["rng", "death"]).state as number[];
      words[0] = (words[0] as number) + 1;
    });
    expectInvariantError(deathDraft, "E_P3E_RNG", "rng.death.state");
  });

  it("四個 genesis head 各自錯誤", () => {
    for (const key of ["lastEntryHash", "lastSnapshotHash", "lastDeltaHash", "hashChain"] as const) {
      const draft = mutate(buildState(0), (state) => {
        nodeAt(state, ["heads"])[key] = HEX("9");
      });
      expectInvariantError(draft, "E_P3E_HISTORY", `heads.${key}`);
    }
  });

  it("commandLog 的 count 與 headHash 各自錯誤", () => {
    const countDraft = mutate(buildState(0), (state) => {
      nodeAt(state, ["commandLog"]).count = 1;
    });
    expectInvariantError(countDraft, "E_P3E_COMMAND", "commandLog.count");

    const headDraft = mutate(buildState(0), (state) => {
      nodeAt(state, ["commandLog"]).headHash = HEX("9");
    });
    expectInvariantError(headDraft, "E_P3E_COMMAND", "commandLog.headHash");
  });

  it("age>0 不套用 genesis 規則（heads／commandLog 可自由）", () => {
    const draft = mutate(buildState(30), (state) => {
      nodeAt(state, ["heads"]).lastEntryHash = HEX("9");
      nodeAt(state, ["heads"]).hashChain = HEX("9");
      nodeAt(state, ["commandLog"]).count = 4096;
      nodeAt(state, ["commandLog"]).headHash = HEX("9");
      state.stateHash = HEX("0");
      // 重算 stateHash（heads 三個在 projection 內、hashChain／commandLog 不在）
    });
    // 先補回正確的 stateHash：只有 projection 內的三個 head 被改，hashChain／commandLog 不影響
    const recalculated = mutate(draft as unknown as contracts.P3ELifeState, (state) => {
      state.stateHash = computeP3EStateHash(state as unknown as contracts.P3ELifeState);
    });
    expect(() => readP3EState(recalculated)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 十、stateHash 與負控                                                */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2b stateHash", () => {
  it("stateHash 錯誤 → E_P3E_HASH at stateHash", () => {
    const draft = mutate(buildState(30), (state) => {
      const current = state.stateHash as string;
      state.stateHash = current === HEX("0") ? HEX("1") : HEX("0");
    });
    expectInvariantError(draft, "E_P3E_HASH", "stateHash");
  });

  it("負控：age>0 時改 heads.hashChain 不影響 stateHash 驗證", () => {
    const draft = mutate(buildState(30), (state) => {
      nodeAt(state, ["heads"]).hashChain = HEX("9");
    });
    // hashChain 不在 projection，所以 stateHash 仍然正確
    expect(() => readP3EState(draft)).not.toThrow();
    expect(computeP3EStateHash(draft as unknown as contracts.P3ELifeState)).toBe(
      (buildState(30) as unknown as Dict).stateHash as string
    );
  });

  it("負控：age>0 時改 commandLog（合法範圍）不影響 stateHash 驗證", () => {
    for (const [count, headHash] of [
      [0, HEX("0")],
      [4096, HEX("9")]
    ] as const) {
      const draft = mutate(buildState(30), (state) => {
        nodeAt(state, ["commandLog"]).count = count;
        nodeAt(state, ["commandLog"]).headHash = headHash;
      });
      expect(() => readP3EState(draft)).not.toThrow();
    }
  });

  it("沒有 verifyHash=false 之類的繞過參數", () => {
    // 型別上只有一個參數；這裡刻意用 cast 多傳一個「繞過旗標」，結果必須完全一樣。
    const callWithExtra = readP3EState as unknown as (
      input: unknown,
      options: unknown
    ) => contracts.P3ELifeState;
    const state = buildState(30);
    expect(callWithExtra(state, { verifyHash: false })).toEqual(readP3EState(state));

    // 就算多傳旗標，壞掉的 stateHash 仍然會被擋
    const broken = mutate(state, (draft) => {
      draft.stateHash = HEX("0");
    });
    expectInvariantError(broken, "E_P3E_HASH", "stateHash");
    expect(() => callWithExtra(broken, { verifyHash: false })).toThrow(P3EError);
  });
});

/* ------------------------------------------------------------------ */
/* 十一、公開表面                                                      */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-2b 公開表面", () => {
  it("readP3EState 只在套件內部，不在公開 barrel", () => {
    expect(typeof readP3EState).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.readP3EState).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });
});

/* ------------------------------------------------------------------ */
/* P3-E.1b-1e-0 死亡 RNG 拒絕取樣會計                                   */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1e-0 死亡 RNG 拒絕取樣會計", () => {
  it("age=1、draws=6 且游標正確 → 接受（大於 4 的合法偶數不再被拒）", () => {
    const state = buildState(1, { deathDraws: 6 });
    expect(state.rng.death.u32Draws).toBe(6);
    expect(6).toBeGreaterThan(4 * state.age);
    expect(() => readP3EState(state)).not.toThrow();
  });

  it("512 × age → 接受（合法最大邊界）", () => {
    for (const age of [1, 2, 30]) {
      const draws = contracts.P3E_MAX_U32_DRAWS_PER_DEATH_YEAR * age;
      const state = buildState(age, { deathDraws: draws });
      expect(state.rng.death.u32Draws).toBe(draws);
      expect(() => readP3EState(state)).not.toThrow();
    }
  });

  it("512 × age + 2 → E_P3E_RNG at rng.death.u32Draws", () => {
    for (const age of [1, 30]) {
      const over = contracts.P3E_MAX_U32_DRAWS_PER_DEATH_YEAR * age + 2;
      const draft = mutate(buildState(age), (state) => {
        nodeAt(state, ["rng", "death"]).u32Draws = over;
        nodeAt(state, ["rng", "death"]).state = advance(DEATH_INITIAL, over);
      });
      expectInvariantError(draft, "E_P3E_RNG", "rng.death.u32Draws");
    }
  });

  it("奇數（含大於 4 的奇數）→ 拒絕", () => {
    for (const age of [1, 30]) {
      const odd = contracts.P3E_MAX_U32_DRAWS_PER_DEATH_YEAR * age - 1;
      const draft = mutate(buildState(age), (state) => {
        nodeAt(state, ["rng", "death"]).u32Draws = odd;
        nodeAt(state, ["rng", "death"]).state = advance(DEATH_INITIAL, odd);
      });
      expectInvariantError(draft, "E_P3E_RNG", "rng.death.u32Draws");
    }
  });

  it("age=0、draws>0 → 拒絕（上限 512 × 0 = 0）", () => {
    const draft = mutate(buildState(0), (state) => {
      nodeAt(state, ["rng", "death"]).u32Draws = 2;
      nodeAt(state, ["rng", "death"]).state = advance(DEATH_INITIAL, 2);
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.death.u32Draws");
  });

  it("draws 正確但游標不符 → 拒絕", () => {
    const draft = mutate(buildState(30, { deathDraws: 6 }), (state) => {
      const words = nodeAt(state, ["rng", "death"]).state as number[];
      words[1] = (words[1] as number) + 1;
    });
    expectInvariantError(draft, "E_P3E_RNG", "rng.death.state");
  });

  it("新常數在 contracts 與 simulation 公開表面相同，且推導為 512", () => {
    expect(contracts.P3E_MAX_U32_DRAWS_PER_DEATH_YEAR).toBe(512);
    expect(simulation.P3E_MAX_U32_DRAWS_PER_DEATH_YEAR).toBe(512);
    expect(simulation.P3E_MAX_U32_DRAWS_PER_DEATH_YEAR).toBe(contracts.P3E_MAX_U32_DRAWS_PER_DEATH_YEAR);
    // 2 個 sampling × 128 attempts × 2 u32 = 512
    expect(2 * 128 * 2).toBe(512);
  });

  it("既有 2／4 常數仍存在，但 invariant 不再用它們當上限", () => {
    expect(contracts.P3E_DEATH_DRAWS_ALIVE).toBe(2);
    expect(contracts.P3E_DEATH_DRAWS_DIED).toBe(4);
    expect(simulation.P3E_DEATH_DRAWS_ALIVE).toBe(2);
    expect(simulation.P3E_DEATH_DRAWS_DIED).toBe(4);
    // 6 與 8 都 > 4 × 1；若舊上限還在就會被拒，現在必須接受
    expect(() => readP3EState(buildState(1, { deathDraws: 6 }))).not.toThrow();
    expect(() => readP3EState(buildState(1, { deathDraws: 8 }))).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* P3-E.1b-1f-0：pendingDecision 不變量（p3e-2）                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1f-0 pendingDecision 不變量", () => {
  const summaryFor = (age: number): contracts.P3EPendingDecisionSummary => ({
    year: BIRTH_YEAR + age,
    age,
    eventId: "ev.adult.housing-choice",
    decisionId: "dec.adult.housing",
    selectionHash: HEX("f"),
    optionIds: ["rent", "save"]
  });

  it("phase 與 pendingDecision 必須同步（若且唯若）", () => {
    // pending_decision 但沒有內容
    const missingContent = mutate(buildState(30, { phase: "pending_decision" }), (state) => {
      state.pendingDecision = null;
    });
    expectInvariantError(missingContent, "E_P3E_DECISION", "pendingDecision");

    // life 卻有待決策
    const lifeWithPending = mutate(buildState(30), (state) => {
      state.pendingDecision = summaryFor(30);
    });
    expectInvariantError(lifeWithPending, "E_P3E_PHASE", "phase");

    // death 卻有待決策（早逝）
    const deathWithPending = mutate(buildState(30, { phase: "death" }), (state) => {
      state.pendingDecision = summaryFor(30);
    });
    expectInvariantError(deathWithPending, "E_P3E_PHASE", "phase");
  });

  it("pendingDecision.year／age 必須等於 State", () => {
    const wrongYear = mutate(buildState(30, { phase: "pending_decision", pendingDecision: summaryFor(30) }), (state) => {
      nodeAt(state, ["pendingDecision"]).year = BIRTH_YEAR + 31;
    });
    expectInvariantError(wrongYear, "E_P3E_DECISION", "pendingDecision.year");

    const wrongAge = mutate(buildState(30, { phase: "pending_decision", pendingDecision: summaryFor(30) }), (state) => {
      nodeAt(state, ["pendingDecision"]).age = 31;
    });
    expectInvariantError(wrongAge, "E_P3E_DECISION", "pendingDecision.age");
  });

  it("age=120 必須是 death，因此不可能有待決策", () => {
    const draft = mutate(buildState(120), (state) => {
      state.phase = "pending_decision";
      state.pendingDecision = summaryFor(120);
    });
    expectInvariantError(draft, "E_P3E_PHASE", "phase");
  });

  it("合法摘要通過，且 stateHash 把 pendingDecision 算進去", () => {
    const withPending = buildState(30, { phase: "pending_decision", pendingDecision: summaryFor(30) });
    expect(() => readP3EState(withPending)).not.toThrow();
    const withoutPending = buildState(30);
    expect(withPending.stateHash).not.toBe(withoutPending.stateHash);

    // 更新 hash 後仍然通過（證明 hash 真的包含它）
    const refreshed = withFreshHash(
      mutate(withPending, (state) => {
        nodeAt(state, ["pendingDecision"]).optionIds = ["save", "rent"];
      })
    );
    expect(() => readP3EState(refreshed)).not.toThrow();
    expect(refreshed.stateHash).not.toBe(withPending.stateHash);
  });
});