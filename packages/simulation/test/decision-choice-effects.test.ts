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
  bindEventPack,
  computeEventsChecksum,
  computePackChecksum,
  deriveEventRngState,
  MoneyError,
  RngError,
  validateEventPack,
  Xoshiro128StarStar,
  type ValidatedEventPack
} from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { createP3EGenesis } from "../src/genesis";
import { applyP3EDecisionOption, resolveP3EDecisionChoice } from "../src/decision-choice-effects";
import { encodeP3EState } from "../src/codec";
import { computeP3EStateHash } from "../src/state-hash";

/**
 * P3-E.1b-1f-2：決策選擇的 effects 轉接層。
 *
 * 決策包由 p3b fixture 的 housing-choice 改寫而成（年齡／階段放寬、四個選項各含一種效果），
 * 重算全部 checksum 後重新驗證，因此是真正的品牌物件。
 */

const SEED = "p3e-1b-1f-2-choice";
const HEX = (char: string) => char.repeat(64);
const ROOT = process.cwd();
const AGE = 30;

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

const rawEventManifest = readJson("fixtures/p3b/manifest.v1.json") as Dict;
const rawEvents = (readJson("fixtures/p3b/events.v1.json") as { records: Dict[] }).records;

const eventPack: ValidatedEventPack = validateEventPack({ manifest: rawEventManifest, events: rawEvents } as never);

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

function repairedEventPack(records: readonly Dict[]): ValidatedEventPack {
  const events = structuredClone(records as Dict[]);
  const manifest = structuredClone(rawEventManifest);
  const datasetChecksum = computeEventsChecksum(events as never);
  const descriptor = (manifest.datasets as Dict[])[0] as Dict;
  descriptor.recordCount = events.length;
  descriptor.checksum = datasetChecksum;
  for (const license of manifest.licenses as Dict[]) license.checksum = datasetChecksum;
  for (const record of manifest.lineage as Dict[]) {
    record.outputChecksum = datasetChecksum;
    record.inputChecksums = (record.parentLineageIds as string[]).map(() => datasetChecksum);
  }
  manifest.packChecksum = computePackChecksum(manifest as never);
  return validateEventPack({ manifest, events } as never);
}

function cloneEvent(eventId: string): Dict {
  const source = rawEvents.find((record) => record.eventId === eventId);
  if (source === undefined) throw new Error(`test fixture: ${eventId} missing`);
  return structuredClone(source);
}

/** 四個選項各含一種效果的決策事件（年齡與人生階段放寬到任何年齡）。 */
const packDecision = repairedEventPack([
  {
    ...cloneEvent("ev.adult.housing-choice"),
    ageMin: 0,
    ageMax: 120,
    lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
    // P3-B 要求 decision 事件的頂層 effects 剛好開啟自己
    effects: [{ type: "openDecision", decisionId: "dec.p3e.choice" }],
    decision: {
      decisionId: "dec.p3e.choice",
      promptKey: "p3b.decision.p3e.choice",
      options: [
        {
          optionId: "opt-stat",
          labelKey: "p3b.option.p3e.stat",
          effects: [
            { type: "stat", stat: "health", delta: 3 },
            { type: "stat", stat: "happiness", delta: -2 },
            { type: "stat", stat: "knowledge", delta: 4 },
            { type: "stat", stat: "relationships", delta: -1 }
          ]
        },
        {
          optionId: "opt-money",
          labelKey: "p3b.option.p3e.money",
          effects: [
            { type: "money", field: "balanceMicroUsd", deltaMicroUsd: "1000000" },
            { type: "money", field: "annualIncomeMicroUsd", deltaMicroUsd: "2000000" },
            { type: "money", field: "annualExpenseMicroUsd", deltaMicroUsd: "3000000" }
          ]
        },
        {
          optionId: "opt-flag",
          labelKey: "p3b.option.p3e.flag",
          effects: [
            { type: "flag", flag: "zzz:new", action: "add" },
            { type: "flag", flag: "aaa:old", action: "remove" }
          ]
        },
        { optionId: "opt-info", labelKey: "p3b.option.p3e.info", effects: [{ type: "informational" }] }
      ]
    }
  },
  // 同一個 pack 裡的「沒有 decision」事件：pending summary 指向它時必須被拒
  { ...cloneEvent("ev.any.setback"), eventId: "ev.plain" }
]);

/** 另一個決策（用來測「跨 decision 的 option」）。 */
const packOtherDecision = repairedEventPack([
  {
    ...cloneEvent("ev.adult.housing-choice"),
    eventId: "ev.other-choice",
    ageMin: 0,
    ageMax: 120,
    lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
    effects: [{ type: "openDecision", decisionId: "dec.p3e.other" }],
    decision: {
      decisionId: "dec.p3e.other",
      promptKey: "p3b.decision.p3e.other",
      options: [
        { optionId: "other-a", labelKey: "p3b.option.p3e.other.a", effects: [{ type: "informational" }] },
        { optionId: "other-b", labelKey: "p3b.option.p3e.other.b", effects: [{ type: "informational" }] }
      ]
    }
  }
]);

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

const BIRTH_YEAR = genesisState.identity.birthYear;
const DECISION_OPTION_IDS = ["opt-stat", "opt-money", "opt-flag", "opt-info"] as const;

/* ------------------------------------------------------------------ */
/* state builder                                                       */
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
  readonly stats?: contracts.P3EStats;
  readonly flags?: readonly string[];
  readonly pack?: ValidatedEventPack;
}

function stateAt(age: number, options: StateOptions = {}): contracts.P3ELifeState {
  const phase = options.phase ?? (age >= contracts.P3E_MAX_AGE ? "death" : "life");
  const pack = options.pack ?? eventPack;
  const eventDraws = 2 * age;
  const deathDraws = 2 * age;
  const years = BigInt(age);
  const eventInitial = toWords(deriveEventRngState(LIFE_INITIAL, BIRTH_YEAR));
  const bound = bindEventPack(pack);
  const draft = {
    ...genesisState,
    currentYear: BIRTH_YEAR + age,
    age,
    phase,
    pendingDecision: options.pendingDecision ?? null,
    stats: options.stats ?? { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
    assets: {
      balanceMicroUsd: 1_900_000n,
      annualIncomeMicroUsd:
        age === 0 ? 0n : contracts.P3E_INCOME_BASE_MICRO_USD + years * contracts.P3E_INCOME_PER_YEAR_MICRO_USD,
      annualExpenseMicroUsd:
        age === 0 ? 0n : contracts.P3E_EXPENSE_BASE_MICRO_USD + years * contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD
    },
    packs: {
      events: {
        eventSchemaVersion: bound.eventSchemaVersion,
        eventSpecVersion: bound.eventSpecVersion,
        contentPackVersion: bound.contentPackVersion,
        eventPackId: bound.eventPackId,
        eventPackChecksum: bound.eventPackChecksum,
        datasetChecksum: bound.datasetChecksum,
        eventCount: bound.eventCount
      },
      death: genesisState.packs.death
    },
    flags: options.flags ?? (age === 0 ? [] : ["p3e:flag-a"]),
    occurrences: [],
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
        state: advance(eventInitial, eventDraws),
        u32Draws: eventDraws
      },
      death: {
        domain: "p3e/death" as const,
        initialState: DEATH_INITIAL,
        state: advance(DEATH_INITIAL, deathDraws),
        u32Draws: deathDraws
      }
    },
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

const PENDING_SUMMARY: contracts.P3EPendingDecisionSummary = {
  year: BIRTH_YEAR + AGE,
  age: AGE,
  eventId: "ev.adult.housing-choice",
  decisionId: "dec.p3e.choice",
  selectionHash: HEX("f"),
  optionIds: [...DECISION_OPTION_IDS]
};

/** 合法的 pending_decision State（flags 便於測 flag add／remove）。 */
function pendingState(overrides: Partial<StateOptions> = {}): contracts.P3ELifeState {
  return stateAt(AGE, {
    phase: "pending_decision",
    pendingDecision: PENDING_SUMMARY,
    flags: ["aaa:old", "mmm:keep"],
    pack: packDecision,
    ...overrides
  });
}

/* ------------------------------------------------------------------ */
/* 輔助                                                                */
/* ------------------------------------------------------------------ */

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function expectChoiceError(run: () => unknown, code: string, path: string): void {
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

function choiceInput(state: contracts.P3ELifeState, optionId: unknown, overrides: Dict = {}): Dict {
  return { state, eventPack: packDecision, deathPack, optionId, ...overrides };
}

/** 重新 seal 一個被竄改的 pending State（正確 hash ＋ 合法 invariants）。 */
function resealed(state: contracts.P3ELifeState, change: (draft: Dict) => void): contracts.P3ELifeState {
  const draft = structuredClone(state) as unknown as Dict;
  change(draft);
  draft.stateHash = computeP3EStateHash(draft as never);
  return draft as unknown as contracts.P3ELifeState;
}

/* ------------------------------------------------------------------ */
/* 一、合法選擇                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1f-2 合法選擇", () => {
  it("四個選項都能取得正確 effects（stat／money／flag／informational）", () => {
    const state = pendingState();

    const stat = resolveP3EDecisionChoice(choiceInput(state, "opt-stat"));
    expect(stat.selectedOptionId).toBe("opt-stat");
    expect(stat.stats).toEqual({ health: 63, happiness: 53, knowledge: 44, relationships: 34 });
    expect(stat.changes.statDelta).toEqual({ health: 3, happiness: -2, knowledge: 4, relationships: -1 });
    expect(stat.flags).toEqual(["aaa:old", "mmm:keep"]);
    expect(stat.informational).toBe(false);

    const money = resolveP3EDecisionChoice(choiceInput(state, "opt-money"));
    expect(money.assets).toEqual({
      balanceMicroUsd: state.assets.balanceMicroUsd + 1_000_000n,
      annualIncomeMicroUsd: state.assets.annualIncomeMicroUsd + 2_000_000n,
      annualExpenseMicroUsd: state.assets.annualExpenseMicroUsd + 3_000_000n
    });
    expect(money.changes.moneyDelta).toEqual({
      balanceMicroUsd: "1000000",
      annualIncomeMicroUsd: "2000000",
      annualExpenseMicroUsd: "3000000"
    });

    const flag = resolveP3EDecisionChoice(choiceInput(state, "opt-flag"));
    expect(flag.flags).toEqual(["mmm:keep", "zzz:new"]);
    expect(flag.changes.flagsAdded).toEqual(["zzz:new"]);
    expect(flag.changes.flagsRemoved).toEqual(["aaa:old"]);

    const info = resolveP3EDecisionChoice(choiceInput(state, "opt-info"));
    expect(info.informational).toBe(true);
    expect(info.changes.informational).toBe(true);
    expect(info.stats).toEqual(state.stats);
    expect(info.assets).toEqual(state.assets);
    expect(info.flags).toEqual(state.flags);
  });

  it("effects 基底是 pending State 的當前值（不是 Roll 後值）", () => {
    const stats = { health: 10, happiness: 20, knowledge: 30, relationships: 40 };
    const state = pendingState({ stats });
    const result = resolveP3EDecisionChoice(choiceInput(state, "opt-stat"));
    expect(result.stats).toEqual({ health: 13, happiness: 18, knowledge: 34, relationships: 39 });
    expect(result.changes.statDelta).toEqual({ health: 3, happiness: -2, knowledge: 4, relationships: -1 });
  });

  it("結果其餘欄位：eventId／decisionId／pendingDecisionAfter／phaseAfter／year／age", () => {
    const state = pendingState();
    const result = resolveP3EDecisionChoice(choiceInput(state, "opt-info"));
    expect(result.eventId).toBe(PENDING_SUMMARY.eventId);
    expect(result.decisionId).toBe(PENDING_SUMMARY.decisionId);
    expect(result.pendingDecisionAfter).toBeNull();
    expect(result.phaseAfter).toBe("life");
    expect(result.currentYearAfter).toBe(state.currentYear);
    expect(result.ageAfter).toBe(state.age);
  });

  it("currentYear／age／occurrences／三條 RNG 完全不變", () => {
    const state = pendingState();
    const before = encodeP3EState(state);
    const rngBefore = structuredClone(state.rng);

    resolveP3EDecisionChoice(choiceInput(state, "opt-stat"));

    expect(encodeP3EState(state)).toBe(before);
    expect(state.rng).toEqual(rngBefore);
    expect(state.currentYear).toBe(BIRTH_YEAR + AGE);
    expect(state.age).toBe(AGE);
    expect(state.occurrences).toEqual([]);
    // 結果裡也沒有任何「新年度」的欄位
    const result = resolveP3EDecisionChoice(choiceInput(state, "opt-stat"));
    for (const forbidden of ["rng", "occurrences", "stateHash", "identity", "heads", "commandLog", "packs"]) {
      expect(Object.keys(result)).not.toContain(forbidden);
    }
  });

  it("輸出深層凍結、與輸入零共享", () => {
    const state = pendingState();
    const result = resolveP3EDecisionChoice(choiceInput(state, "opt-money"));
    expect(isDeepFrozen(result)).toBe(true);
    expect(sharesReference(result, state)).toBe(false);
    expect(result.assets).not.toBe(state.assets);
    expect(result.stats).not.toBe(state.stats);
    expect(() => {
      (result as unknown as Dict).selectedOptionId = "x";
    }).toThrow(TypeError);
    expect(() => {
      (result.assets as unknown as Dict).balanceMicroUsd = 0n;
    }).toThrow(TypeError);
    expect(() => {
      (result.flags as unknown as string[])[0] = "x";
    }).toThrow(TypeError);
  });
});

/* ------------------------------------------------------------------ */
/* 二、optionId 與 pack 交叉比對                                       */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1f-2 optionId 與 pack 比對", () => {
  it("optionId 不存在／跨 decision／跨 event → E_P3E_DECISION at optionId", () => {
    const state = pendingState();
    for (const optionId of ["nope", "other-a", "", "opt-stat ", 42, null, undefined, {}]) {
      expectChoiceError(() => resolveP3EDecisionChoice(choiceInput(state, optionId)), "E_P3E_DECISION", "optionId");
    }
    // 跨 decision：把另一份 pack 的選項拿來用
    const otherState = stateAt(AGE, {
      phase: "pending_decision",
      pendingDecision: { ...PENDING_SUMMARY, eventId: "ev.other-choice", decisionId: "dec.p3e.other", optionIds: ["other-a", "other-b"] },
      pack: packOtherDecision
    });
    expectChoiceError(
      () => resolveP3EDecisionChoice(choiceInput(otherState, "opt-stat", { eventPack: packOtherDecision })),
      "E_P3E_DECISION",
      "optionId"
    );
  });

  it("pending summary 被竄改（未重新 seal）→ State hash 先拒絕", () => {
    const state = pendingState();
    for (const change of [
      (draft: Dict) => {
        (draft.pendingDecision as Dict).eventId = "ev.other-choice";
      },
      (draft: Dict) => {
        (draft.pendingDecision as Dict).decisionId = "dec.p3e.other";
      },
      (draft: Dict) => {
        (draft.pendingDecision as Dict).selectionHash = HEX("9");
      },
      (draft: Dict) => {
        (draft.pendingDecision as Dict).optionIds = ["opt-info", "opt-stat", "opt-money", "opt-flag"];
      }
    ]) {
      const tampered = structuredClone(state) as unknown as Dict;
      change(tampered);
      expectChoiceError(
        () => resolveP3EDecisionChoice(choiceInput(tampered as unknown as contracts.P3ELifeState, "opt-stat")),
        "E_P3E_HASH",
        "stateHash"
      );
    }
  });

  it("重新 seal 的偽造 State：pack 交叉比對仍拒絕", () => {
    const state = pendingState();

    const wrongEvent = resealed(state, (draft) => {
      (draft.pendingDecision as Dict).eventId = "ev.other-choice";
    });
    expectChoiceError(
      () => resolveP3EDecisionChoice(choiceInput(wrongEvent, "opt-stat")),
      "E_P3E_DECISION",
      "pendingDecision"
    );

    const wrongDecision = resealed(state, (draft) => {
      (draft.pendingDecision as Dict).decisionId = "dec.p3e.other";
    });
    expectChoiceError(
      () => resolveP3EDecisionChoice(choiceInput(wrongDecision, "opt-stat")),
      "E_P3E_DECISION",
      "pendingDecision"
    );

    const noDecisionEvent = resealed(state, (draft) => {
      (draft.pendingDecision as Dict).eventId = "ev.plain";
    });
    expectChoiceError(
      () => resolveP3EDecisionChoice(choiceInput(noDecisionEvent, "opt-stat")),
      "E_P3E_DECISION",
      "pendingDecision"
    );

    const reordered = resealed(state, (draft) => {
      (draft.pendingDecision as Dict).optionIds = ["opt-info", "opt-stat", "opt-money", "opt-flag"];
    });
    expectChoiceError(
      () => resolveP3EDecisionChoice(choiceInput(reordered, "opt-stat")),
      "E_P3E_DECISION",
      "pendingDecision"
    );

    const missingOption = resealed(state, (draft) => {
      (draft.pendingDecision as Dict).optionIds = ["opt-stat", "opt-money", "opt-flag"];
    });
    expectChoiceError(
      () => resolveP3EDecisionChoice(choiceInput(missingOption, "opt-stat")),
      "E_P3E_DECISION",
      "pendingDecision"
    );

    const extraOption = resealed(state, (draft) => {
      (draft.pendingDecision as Dict).optionIds = ["opt-stat", "opt-money", "opt-flag", "opt-info", "opt-extra"];
    });
    expectChoiceError(
      () => resolveP3EDecisionChoice(choiceInput(extraOption, "opt-stat")),
      "E_P3E_DECISION",
      "pendingDecision"
    );
  });

  it("life／death phase → E_P3E_PHASE at phase", () => {
    const life = stateAt(AGE, { pack: packDecision });
    expectChoiceError(() => resolveP3EDecisionChoice(choiceInput(life, "opt-stat", { eventPack: packDecision })), "E_P3E_PHASE", "phase");

    const death = stateAt(AGE, { phase: "death", pack: packDecision });
    expectChoiceError(() => resolveP3EDecisionChoice(choiceInput(death, "opt-stat", { eventPack: packDecision })), "E_P3E_PHASE", "phase");
  });
});

/* ------------------------------------------------------------------ */
/* 三、seam：巢狀決策與 engine 錯誤折疊                                */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1f-2 seam", () => {
  const baseFacts = () => ({
    currentYear: BIRTH_YEAR + AGE,
    age: AGE,
    phase: "pending_decision" as const,
    stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
    assets: { balanceMicroUsd: 1_900_000n, annualIncomeMicroUsd: 4_100_000n, annualExpenseMicroUsd: 2_100_000n },
    flags: ["p3e:flag-a"]
  });

  it("巢狀 openDecision → E_P3E_DECISION at optionId", () => {
    expectChoiceError(
      () => applyP3EDecisionOption(baseFacts(), [{ type: "openDecision", decisionId: "dec.nested" }]),
      "E_P3E_DECISION",
      "optionId"
    );
    // 合法選項不會拋
    expect(applyP3EDecisionOption(baseFacts(), [{ type: "informational" }]).informational).toBe(true);
  });

  it("engine 例外折成固定 P3EError", () => {
    for (const effects of [null, 42, [{ type: "stat", stat: "nope", delta: 1 }], [{ type: "unknown" }]]) {
      expectChoiceError(() => applyP3EDecisionOption(baseFacts(), effects), "E_P3E_EFFECT", "eventEffects");
    }
    // flags 沒有嚴格遞增：P3-B 接受、P3-C 的 base 驗證拒絕
    const unsorted = { ...baseFacts(), flags: ["p3e:zzz", "p3e:aaa"] };
    expectChoiceError(() => applyP3EDecisionOption(unsorted, [{ type: "informational" }]), "E_P3E_EFFECT", "eventOutcome");
    // base 不是物件
    expectChoiceError(() => applyP3EDecisionOption(null, []), "E_P3E_EFFECT", "eventEffects");
  });
});

/* ------------------------------------------------------------------ */
/* 四、輸入邊界與公開表面                                              */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1f-2 輸入與公開表面", () => {
  it("不接受呼叫端傳入的中間結果", () => {
    const state = pendingState();
    for (const extra of ["decision", "option", "effects", "outcome", "stage"]) {
      expectChoiceError(
        () => resolveP3EDecisionChoice({ ...choiceInput(state, "opt-stat"), [extra]: {} }),
        "E_P3E_ARGUMENT",
        "input"
      );
    }
  });

  it("shape：多／缺／改名／hidden／symbol／accessor／Proxy", () => {
    const state = pendingState();
    for (const key of ["state", "eventPack", "deathPack", "optionId"]) {
      const missing = choiceInput(state, "opt-stat");
      delete missing[key];
      expectChoiceError(() => resolveP3EDecisionChoice(missing), "E_P3E_ARGUMENT", "input");
    }
    const renamed = choiceInput(state, "opt-stat");
    delete renamed.optionId;
    renamed.option = "opt-stat";
    expectChoiceError(() => resolveP3EDecisionChoice(renamed), "E_P3E_ARGUMENT", "input");

    const hidden = choiceInput(state, "opt-stat");
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false, configurable: true });
    expectChoiceError(() => resolveP3EDecisionChoice(hidden), "E_P3E_ARGUMENT", "input");

    const accessor: Dict = {};
    let invoked = false;
    for (const key of ["state", "eventPack", "deathPack"] as const) accessor[key] = choiceInput(state, "opt-stat")[key];
    Object.defineProperty(accessor, "optionId", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return "opt-stat";
      }
    });
    expectChoiceError(() => resolveP3EDecisionChoice(accessor), "E_P3E_ARGUMENT", "input");
    expect(invoked).toBe(false);

    for (const value of [null, undefined, 42, [], [choiceInput(state, "opt-stat")], Object.create({})]) {
      expectChoiceError(() => resolveP3EDecisionChoice(value), "E_P3E_ARGUMENT", "input");
    }
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectChoiceError(() => resolveP3EDecisionChoice(revoked.proxy), "E_P3E_ARGUMENT", "input");
  });

  it("既有錯誤原樣保留（State／pack）", () => {
    const state = pendingState();
    const broken = structuredClone(state) as unknown as Dict;
    broken.stateHash = HEX("0");
    expectChoiceError(
      () => resolveP3EDecisionChoice(choiceInput(broken as unknown as contracts.P3ELifeState, "opt-stat")),
      "E_P3E_HASH",
      "stateHash"
    );
    expectChoiceError(
      () => resolveP3EDecisionChoice({ ...choiceInput(state, "opt-stat"), eventPack: structuredClone(packDecision) }),
      "E_P3E_EVENT_PACK",
      "eventPack"
    );
  });

  it("入口與 seam 都不在公開 barrel", () => {
    expect(typeof resolveP3EDecisionChoice).toBe("function");
    expect(typeof applyP3EDecisionOption).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.resolveP3EDecisionChoice).toBeUndefined();
    expect(surface.applyP3EDecisionOption).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("不建立 State、不決定 phase、不碰 RNG／抽選／死亡（靜態檢查）", () => {
    const source = readFileSync(join(ROOT, "packages/simulation/src/decision-choice-effects.ts"), "utf8");
    for (const forbidden of [
      "resolveP3EAnnualDeath",
      "evaluateAnnualDeath",
      "resolveP3EAnnualRoll",
      "resolveP3ERoll",
      "selectEvent",
      "resolveP3EAnnualEventEffects",
      "uniformInt",
      "uniformBigInt",
      "Xoshiro128StarStar",
      "Math.min(",
      "Math.max(",
      "computeP3EStateHash",
      "sealP3EState",
      "state.occurrences",
      "state.rng"
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(source).toContain("applyEventEffects");
    expect(source).toContain("applyEffectOutcome");
  });
});
