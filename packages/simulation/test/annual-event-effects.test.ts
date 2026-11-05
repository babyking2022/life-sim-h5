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
import {
  applyP3EEventEffectsAndOutcome,
  assertP3EAnnualOccurrences,
  findP3EEvent,
  resolveP3EAnnualEventEffects,
  resolveP3EPendingDecision
} from "../src/annual-event-effects";
import { encodeP3EState } from "../src/codec";
import { computeP3EStateHash } from "../src/state-hash";

/**
 * P3-E.1b-1d：年度事件 effects 與 occurrences 轉接層。
 *
 * fixture 全由真實驗證器產生；需要「特定事件被抽中」時，直接把 p3b fixture 過濾成單一事件
 * （重算全部 checksum 後重新驗證），因此 selection 是決定性的單一候選。
 */

const SEED = "p3e-1b-1d-event-effects";
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

const rawEventManifest = readJson("fixtures/p3b/manifest.v1.json") as Dict;
const rawEvents = (readJson("fixtures/p3b/events.v1.json") as { records: Dict[] }).records;

const eventPack: ValidatedEventPack = validateEventPack({ manifest: rawEventManifest, events: rawEvents } as never);

/** 用一組事件重建 pack：重算全部 checksum 後重新驗證。 */
function repairedPack(records: readonly Dict[]): ValidatedEventPack {
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

function filteredPack(keep: (record: Dict) => boolean): ValidatedEventPack {
  return repairedPack(rawEvents.filter(keep));
}

function cloneEvent(eventId: string): Dict {
  const source = rawEvents.find((record) => record.eventId === eventId);
  if (source === undefined) throw new Error(`test fixture: ${eventId} missing`);
  return structuredClone(source);
}

/** 只有 `ev.child.first-word`（age 1–3）：age 30 沒有候選。 */
const packNoCandidates = filteredPack((record) => record.eventId === "ev.child.first-word");
/** 只有 `ev.any.setback`（stat ＋ money effects）。 */
const packSetback = filteredPack((record) => record.eventId === "ev.any.setback");
/**
 * `ev.any.quiet-year`（informational，條件：`ev.any.setback` 已發生）＋ 一個 age 1–2 的填充事件。
 * 填充事件讓 eventCount = 2（下一個 State 的 occurrence 長度上限），但它在 age 31 不合格，
 * 所以候選仍然只有 quiet-year。
 */
const packQuietYear = repairedPack([
  cloneEvent("ev.any.quiet-year"),
  { ...cloneEvent("ev.any.setback"), eventId: "ev.child.filler", ageMin: 1, ageMax: 2 }
]);
/** 只有 `ev.adult.housing-choice`（openDecision ＋ decision）。 */
const packHousing = filteredPack((record) => record.eventId === "ev.adult.housing-choice");
/** 排序測試：`ev.aaa` 永遠合格，`ev.bbb` 只在 age 1–2 合格（所以 age 31 只有一個候選、長度上限是 2）。 */
const packSort = repairedPack([
  { ...cloneEvent("ev.any.setback"), eventId: "ev.aaa" },
  { ...cloneEvent("ev.any.setback"), eventId: "ev.bbb", ageMin: 1, ageMax: 2 }
]);
/** 四個 stat 各變一次。 */
const packFourStats = repairedPack([
  {
    ...cloneEvent("ev.any.setback"),
    eventId: "ev.stats4",
    effects: [
      { type: "stat", stat: "health", delta: 3 },
      { type: "stat", stat: "happiness", delta: -2 },
      { type: "stat", stat: "knowledge", delta: 4 },
      { type: "stat", stat: "relationships", delta: -1 }
    ]
  }
]);
/** 三個金額欄位各變一次。 */
const packMoney = repairedPack([
  {
    ...cloneEvent("ev.any.setback"),
    eventId: "ev.money3",
    effects: [
      { type: "money", field: "balanceMicroUsd", deltaMicroUsd: "1000000" },
      { type: "money", field: "annualIncomeMicroUsd", deltaMicroUsd: "2000000" },
      { type: "money", field: "annualExpenseMicroUsd", deltaMicroUsd: "3000000" }
    ]
  }
]);
/** flag 新增＋移除。 */
const packFlags = repairedPack([
  {
    ...cloneEvent("ev.any.setback"),
    eventId: "ev.flags",
    effects: [
      { type: "flag", flag: "zzz:new", action: "add" },
      { type: "flag", flag: "aaa:old", action: "remove" }
    ]
  }
]);


/** rejection sampling：總權重 floor(2^64/1025)+1，第 364 個游標位置會先被拒絕一次（4 draws）。 */
const REJECT_TOTAL = (1n << 64n) / 1025n + 1n;
const REJECT_W1 = (1n << 53n) - 1n;
const REJECT_W2 = REJECT_TOTAL - REJECT_W1;
const FOUR_DRAW_POSITION = 364;
const packRejection = repairedPack([
  { ...cloneEvent("ev.any.setback"), eventId: "ev.aa", weight: Number(REJECT_W1) },
  { ...cloneEvent("ev.any.setback"), eventId: "ev.ab", weight: Number(REJECT_W2) }
]);

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
const BIRTH_YEAR = genesisState.identity.birthYear;

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
  readonly flags?: readonly string[];
  readonly occurrences?: readonly contracts.P3EEventOccurrence[];
  readonly pack?: ValidatedEventPack;
  readonly eventDraws?: number;
}

function stateAt(age: number, options: StateOptions = {}): contracts.P3ELifeState {
  const phase = options.phase ?? (age >= contracts.P3E_MAX_AGE ? "death" : "life");
  const pack = options.pack ?? eventPack;
  const eventDraws = options.eventDraws ?? 2 * age;
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
      balanceMicroUsd: options.balance ?? 1_900_000n,
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
    occurrences: options.occurrences ?? (age === 0 ? [] : [{ eventId: "ev.any.setback", count: 1, lastYear: BIRTH_YEAR + 1 }]),
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
        state: advance(DEATH_INITIAL, 2 * age),
        u32Draws: 2 * age
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

function expectEffectsError(run: () => unknown, code: string, path: string): void {
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

function effectsInput(state: contracts.P3ELifeState, overrides: Dict = {}): Dict {
  return { state, eventPack, deathPack, contentMode: "guardian", ...overrides };
}

const AGE_30 = stateAt(30);

/* ------------------------------------------------------------------ */
/* 一、無事件                                                          */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1d 無事件", () => {
  const state = stateAt(30, { pack: packNoCandidates });

  it("stats／assets 用 Roll 後值，flags／occurrences 維持原值", () => {
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packNoCandidates }));
    expect(result.selectedEventId).toBeNull();
    expect(result.selection.selectedEventId).toBeNull();
    expect(result.selection.reason).toBe("no_candidates");
    expect(result.selection.u32DrawsUsed).toBe(0);
    expect(result.stats).toEqual(result.selection.roll.statsAfter);
    expect(result.assets).toEqual(result.selection.roll.assetsAfter);
    expect(result.flags).toEqual(state.flags);
    expect(result.occurrences).toEqual(state.occurrences);
    expect(result.informational).toBe(false);
    expect(result.openedDecision).toBeNull();
    expect(result.changes).toEqual({
      statDelta: { health: 0, happiness: 0, knowledge: 0, relationships: 0 },
      moneyDelta: { balanceMicroUsd: "0", annualIncomeMicroUsd: "0", annualExpenseMicroUsd: "0" },
      flagsAdded: [],
      flagsRemoved: [],
      informational: false,
      openedDecisionId: null
    });
  });

  it("occurrences 是獨立凍結副本（內容相同但不是同一個物件）", () => {
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packNoCandidates }));
    expect(result.occurrences).not.toBe(state.occurrences);
    expect(result.occurrences[0]).not.toBe(state.occurrences[0]);
    expect(Object.isFrozen(result.occurrences)).toBe(true);
    expect(Object.isFrozen(result.occurrences[0])).toBe(true);
    expect(result.flags).not.toBe(state.flags);
  });
});

/* ------------------------------------------------------------------ */
/* 二、effects 套用                                                    */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1d effects", () => {
  it("informational 事件：flags 不變、informational 為 true", () => {
    const state = stateAt(30, { pack: packQuietYear });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packQuietYear }));
    expect(result.selectedEventId).toBe("ev.any.quiet-year");
    expect(result.informational).toBe(true);
    expect(result.changes.informational).toBe(true);
    expect(result.stats).toEqual(result.selection.roll.statsAfter);
    expect(result.flags).toEqual(state.flags);
  });

  it("四狀態變更（以 Roll 後值為基底）", () => {
    const state = stateAt(30, { pack: packFourStats, occurrences: [] });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packFourStats }));
    const before = result.selection.roll.statsAfter;
    expect(result.selectedEventId).toBe("ev.stats4");
    expect(result.stats).toEqual({
      health: Math.min(100, Math.max(0, before.health + 3)),
      happiness: Math.min(100, Math.max(0, before.happiness - 2)),
      knowledge: Math.min(100, Math.max(0, before.knowledge + 4)),
      relationships: Math.min(100, Math.max(0, before.relationships - 1))
    });
    expect(result.changes.statDelta).toEqual({
      health: result.stats.health - before.health,
      happiness: result.stats.happiness - before.happiness,
      knowledge: result.stats.knowledge - before.knowledge,
      relationships: result.stats.relationships - before.relationships
    });
    // 明確不是用交易前的 stats
    expect(result.stats).not.toEqual({
      health: state.stats.health + 3,
      happiness: state.stats.happiness - 2,
      knowledge: state.stats.knowledge + 4,
      relationships: state.stats.relationships - 1
    });
  });

  it("金額變更（三個欄位）", () => {
    const state = stateAt(30, { pack: packMoney, occurrences: [] });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packMoney }));
    const before = result.selection.roll.assetsAfter;
    expect(result.assets).toEqual({
      balanceMicroUsd: before.balanceMicroUsd + 1_000_000n,
      annualIncomeMicroUsd: before.annualIncomeMicroUsd + 2_000_000n,
      annualExpenseMicroUsd: before.annualExpenseMicroUsd + 3_000_000n
    });
    expect(result.changes.moneyDelta).toEqual({
      balanceMicroUsd: "1000000",
      annualIncomeMicroUsd: "2000000",
      annualExpenseMicroUsd: "3000000"
    });
  });

  it("flags 新增／移除並保持升冪", () => {
    const state = stateAt(30, { pack: packFlags, flags: ["aaa:old", "mmm:keep"], occurrences: [] });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packFlags }));
    expect(result.flags).toEqual(["mmm:keep", "zzz:new"]);
    expect(result.changes.flagsAdded).toEqual(["zzz:new"]);
    expect(result.changes.flagsRemoved).toEqual(["aaa:old"]);
    expect(state.flags).toEqual(["aaa:old", "mmm:keep"]);
  });
});

/* ------------------------------------------------------------------ */
/* 三、occurrences                                                     */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1d occurrences", () => {
  it("新建：count 1、lastYear = Roll 後年份", () => {
    const state = stateAt(30, { pack: packSetback, occurrences: [] });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packSetback }));
    expect(result.occurrences).toEqual([
      { eventId: "ev.any.setback", count: 1, lastYear: result.selection.roll.yearAfter }
    ]);
    expect(result.selection.roll.yearAfter).toBe(BIRTH_YEAR + 31);
  });

  it("累加：count + 1、lastYear 更新", () => {
    const state = stateAt(30, {
      pack: packSetback,
      occurrences: [{ eventId: "ev.any.setback", count: 2, lastYear: BIRTH_YEAR + 5 }]
    });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packSetback }));
    expect(result.occurrences).toEqual([
      { eventId: "ev.any.setback", count: 3, lastYear: BIRTH_YEAR + 31 }
    ]);
    expect(state.occurrences[0]?.count).toBe(2);
    expect(state.occurrences[0]?.lastYear).toBe(BIRTH_YEAR + 5);
  });

  it("排序：新事件插到既有 occurrence 之前", () => {
    const state = stateAt(30, {
      pack: packSort,
      occurrences: [{ eventId: "ev.zzz", count: 1, lastYear: BIRTH_YEAR + 1 }]
    });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packSort }));
    expect(result.selectedEventId).toBe("ev.aaa");
    expect(result.occurrences.map((entry) => entry.eventId)).toEqual(["ev.aaa", "ev.zzz"]);
    expect(result.occurrences[0]).toEqual({ eventId: "ev.aaa", count: 1, lastYear: BIRTH_YEAR + 31 });
    expect(result.occurrences[1]).toEqual({ eventId: "ev.zzz", count: 1, lastYear: BIRTH_YEAR + 1 });
  });

  it("排序：新事件排在最後（append）", () => {
    const state = stateAt(30, {
      pack: packSort,
      occurrences: [{ eventId: "ev.aaa0", count: 1, lastYear: BIRTH_YEAR + 1 }]
    });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packSort }));
    expect(result.selectedEventId).toBe("ev.aaa");
    expect(result.occurrences.map((entry) => entry.eventId)).toEqual(["ev.aaa", "ev.aaa0"]);
    expect(result.occurrences[1]).toEqual({ eventId: "ev.aaa0", count: 1, lastYear: BIRTH_YEAR + 1 });
  });

  it("原陣列與原項目不會被修改", () => {
    const occurrences: contracts.P3EEventOccurrence[] = [
      { eventId: "ev.any.setback", count: 1, lastYear: BIRTH_YEAR + 3 }
    ];
    const snapshot = structuredClone(occurrences);
    const state = stateAt(30, { pack: packSetback, occurrences });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packSetback }));
    expect(occurrences).toEqual(snapshot);
    expect(result.occurrences[0]).not.toBe(occurrences[0]);
  });
});

/* ------------------------------------------------------------------ */
/* 四、Decision                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1d decision", () => {
  it("decision 事件：openedDecision 帶完整 options 快照與 selectionHash", () => {
    const state = stateAt(30, { pack: packHousing, occurrences: [] });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packHousing }));
    const pending = result.openedDecision;
    expect(pending).not.toBeNull();
    expect(pending?.eventId).toBe("ev.adult.housing-choice");
    expect(pending?.decisionId).toBe("dec.adult.housing");
    expect(pending?.promptKey).toBe("p3b.decision.adult.housing");
    expect(pending?.options.map((option) => option.optionId)).toEqual(["rent", "save"]);
    expect(pending?.options[0]?.effects).toEqual([
      { type: "money", field: "annualExpenseMicroUsd", deltaMicroUsd: "9000000" }
    ]);
    expect(pending?.selectionHash).toBe(result.selection.selectionHash);
    expect(result.changes.openedDecisionId).toBe("dec.adult.housing");
    // pending decision 不會被塞進 state 形狀的欄位
    expect(Object.keys(result)).not.toContain("pendingDecision");
  });

  it("options 快照是獨立凍結副本", () => {
    const state = stateAt(30, { pack: packHousing, occurrences: [] });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packHousing }));
    const event = packHousing.events[0];
    expect(result.openedDecision?.options).not.toBe(event?.decision?.options);
    expect(result.openedDecision?.options[0]).not.toBe(event?.decision?.options[0]);
    expect(isDeepFrozen(result.openedDecision)).toBe(true);
  });

  it("decision id 不一致 → E_P3E_DECISION at eventDecision（seam）", () => {
    // P3-B 的 pack 驗證已保證一致，因此反例只能用「偽造 event」直接打 seam。
    const housing = packHousing.events[0];
    if (housing?.decision == null) throw new Error("test fixture: housing decision missing");
    const state = stateAt(30, { pack: packHousing, occurrences: [] });
    const application = applyP3EEventEffectsAndOutcome(
      {
        currentYear: 2055,
        age: 31,
        phase: "life",
        stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
        assets: { balanceMicroUsd: 1_900_000n, annualIncomeMicroUsd: 4_100_000n, annualExpenseMicroUsd: 2_100_000n },
        flags: [...state.flags]
      },
      housing.effects
    );

    // 一致的 event：正常產生 pending decision
    expect(resolveP3EPendingDecision(housing, application, "ab".repeat(32))?.decisionId).toBe("dec.adult.housing");

    // decision id 被換掉 → 不一致
    const mismatched = { ...housing, decision: { ...housing.decision, decisionId: "dec.other" } } as unknown as
      typeof housing;
    expectEffectsError(
      () => resolveP3EPendingDecision(mismatched, application, "ab".repeat(32)),
      "E_P3E_DECISION",
      "eventDecision"
    );
  });

  it("有 decision 但沒有開啟 → E_P3E_DECISION（seam）", () => {
    const housing = packHousing.events[0];
    if (housing?.decision == null) throw new Error("test fixture: housing decision missing");
    const state = stateAt(30, { pack: packHousing, occurrences: [] });
    const application = applyP3EEventEffectsAndOutcome(
      {
        currentYear: 2055,
        age: 31,
        phase: "life",
        stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
        assets: { balanceMicroUsd: 1_900_000n, annualIncomeMicroUsd: 4_100_000n, annualExpenseMicroUsd: 2_100_000n },
        flags: [...state.flags]
      },
      [{ type: "informational" }]
    );
    expectEffectsError(
      () => resolveP3EPendingDecision(housing, application, "ab".repeat(32)),
      "E_P3E_DECISION",
      "eventDecision"
    );
  });

  it("沒有 decision 卻開啟決策 → E_P3E_DECISION（seam）", () => {
    const setback = packSetback.events[0];
    if (setback === undefined) throw new Error("test fixture: setback missing");
    const state = stateAt(30, { pack: packSetback });
    const application = applyP3EEventEffectsAndOutcome(
      {
        currentYear: 2055,
        age: 31,
        phase: "life",
        stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
        assets: { balanceMicroUsd: 1_900_000n, annualIncomeMicroUsd: 4_100_000n, annualExpenseMicroUsd: 2_100_000n },
        flags: [...state.flags]
      },
      [{ type: "openDecision", decisionId: "dec.other" }]
    );
    const noDecision = { ...setback, decision: null } as unknown as typeof setback;
    expectEffectsError(
      () => resolveP3EPendingDecision(noDecision, application, "ab".repeat(32)),
      "E_P3E_DECISION",
      "eventDecision"
    );
    // 沒有 decision 也沒有開啟 → null
    expect(
      resolveP3EPendingDecision(
        noDecision,
        applyP3EEventEffectsAndOutcome(
          {
            currentYear: 2055,
            age: 31,
            phase: "life",
            stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
            assets: {
              balanceMicroUsd: 1_900_000n,
              annualIncomeMicroUsd: 4_100_000n,
              annualExpenseMicroUsd: 2_100_000n
            },
            flags: [...state.flags]
          },
          [{ type: "informational" }]
        ),
        "ab".repeat(32)
      )
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 五、RNG 完整保留                                                    */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1d RNG", () => {
  it("4 draws 案例完整保留（不截斷成 2）", () => {
    const state = stateAt(30, { pack: packRejection, eventDraws: FOUR_DRAW_POSITION });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packRejection }));
    expect(result.selection.u32DrawsUsed).toBe(4);
    expect(result.selection.eventRngAfter.u32Draws).toBe(FOUR_DRAW_POSITION + 4);
    expect(result.selection.eventRngAfter.u32Draws).toBe(368);
    expect(result.selection.eventRngAfter.initialState).toEqual(state.rng.events.initialState);
    expect(result.selection.eventRngAfter.state).toEqual(advance(state.rng.events.state, 4));
    // effects 仍然以 Roll 後值為基底
    expect(result.selectedEventId).not.toBeNull();
  });

  it("無候選時 0 draws、游標不動", () => {
    const state = stateAt(30, { pack: packNoCandidates });
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packNoCandidates }));
    expect(result.selection.u32DrawsUsed).toBe(0);
    expect(result.selection.eventRngAfter.state).toEqual(result.selection.eventRngBefore.state);
  });
});

/* ------------------------------------------------------------------ */
/* 六、錯誤折疊                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1d 錯誤", () => {
  it("找不到抽中的事件 → E_P3E_EVENT at selectedEventId", () => {
    expectEffectsError(() => findP3EEvent(packSetback, "ev.not-in-pack"), "E_P3E_EVENT", "selectedEventId");
    expect(findP3EEvent(packSetback, "ev.any.setback").eventId).toBe("ev.any.setback");
  });

  it("P3-B effects 錯誤 → E_P3E_EFFECT at eventEffects", () => {
    const state = stateAt(30, { pack: packSetback });
    const baseFacts = {
      currentYear: 2055,
      age: 31,
      phase: "life" as const,
      stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
      assets: { balanceMicroUsd: 1_900_000n, annualIncomeMicroUsd: 4_100_000n, annualExpenseMicroUsd: 2_100_000n },
      flags: [...state.flags]
    };
    // 非法 effects → P3-B 失敗 → 折成 E_P3E_EFFECT at eventEffects
    for (const effects of [null, 42, [{ type: "stat", stat: "nope", delta: 1 }], [{ type: "unknown" }]]) {
      expectEffectsError(
        () => applyP3EEventEffectsAndOutcome(baseFacts, effects),
        "E_P3E_EFFECT",
        "eventEffects"
      );
    }
    // 非法 base → 也是 events 階段的錯誤
    expectEffectsError(() => applyP3EEventEffectsAndOutcome(null, []), "E_P3E_EFFECT", "eventEffects");
  });

  it("P3-C 轉接錯誤 → E_P3E_EFFECT at eventOutcome", () => {
    // flags 合法但沒有嚴格遞增：P3-B 接受，P3-C 的 base 驗證拒絕
    const unsorted = {
      currentYear: 2055,
      age: 31,
      phase: "life" as const,
      stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
      assets: { balanceMicroUsd: 1_900_000n, annualIncomeMicroUsd: 4_100_000n, annualExpenseMicroUsd: 2_100_000n },
      flags: ["p3e:zzz", "p3e:aaa"]
    };
    expectEffectsError(
      () => applyP3EEventEffectsAndOutcome(unsorted, [{ type: "informational" }]),
      "E_P3E_EFFECT",
      "eventOutcome"
    );
  });

  it("occurrence 不合規 → E_P3E_EVENT at occurrences", () => {
    const limits = { birthYear: BIRTH_YEAR, ageAfter: 31, currentYearAfter: BIRTH_YEAR + 31, eventCount: 22 };
    // 合法
    expect(() =>
      assertP3EAnnualOccurrences([{ eventId: "ev.a", count: 1, lastYear: BIRTH_YEAR + 5 }], limits)
    ).not.toThrow();
    const bad: readonly (readonly contracts.P3EEventOccurrence[])[] = [
      // 未排序
      [
        { eventId: "ev.b", count: 1, lastYear: BIRTH_YEAR + 5 },
        { eventId: "ev.a", count: 1, lastYear: BIRTH_YEAR + 5 }
      ],
      // 重複
      [
        { eventId: "ev.a", count: 1, lastYear: BIRTH_YEAR + 5 },
        { eventId: "ev.a", count: 1, lastYear: BIRTH_YEAR + 5 }
      ],
      // lastYear 太早
      [{ eventId: "ev.a", count: 1, lastYear: BIRTH_YEAR }],
      // lastYear 太晚
      [{ eventId: "ev.a", count: 1, lastYear: BIRTH_YEAR + 32 }],
      // count 0
      [{ eventId: "ev.a", count: 0, lastYear: BIRTH_YEAR + 5 }],
      // count 超過 lastYear − birthYear
      [{ eventId: "ev.a", count: 6, lastYear: BIRTH_YEAR + 5 }],
      // 總和超過 ageAfter
      [
        { eventId: "ev.a", count: 20, lastYear: BIRTH_YEAR + 30 },
        { eventId: "ev.b", count: 12, lastYear: BIRTH_YEAR + 30 }
      ],
      // 長度超過 min(4096, eventCount, ageAfter)
      Array.from({ length: 23 }, (_, index) => ({
        eventId: `ev.${String(index).padStart(3, "0")}`,
        count: 1,
        lastYear: BIRTH_YEAR + 5
      }))
    ];
    for (const occurrences of bad) {
      expectEffectsError(() => assertP3EAnnualOccurrences(occurrences, limits), "E_P3E_EVENT", "occurrences");
    }
  });

  it("State／pack／selection 的既有錯誤原樣保留", () => {
    const broken = structuredClone(AGE_30) as unknown as Dict;
    broken.stateHash = HEX("0");
    expectEffectsError(() => resolveP3EAnnualEventEffects(effectsInput(broken as unknown as contracts.P3ELifeState)), "E_P3E_HASH", "stateHash");
    expectEffectsError(
      () => resolveP3EAnnualEventEffects({ ...effectsInput(AGE_30), eventPack: structuredClone(eventPack) }),
      "E_P3E_EVENT_PACK",
      "eventPack"
    );
    expectEffectsError(
      () => resolveP3EAnnualEventEffects({ ...effectsInput(AGE_30), contentMode: "hard" }),
      "E_P3E_EVENT",
      "contentMode"
    );
  });

  it("不接受呼叫端傳入的中間結果", () => {
    const withExtras = { ...effectsInput(AGE_30), selection: {}, roll: {} };
    expectEffectsError(() => resolveP3EAnnualEventEffects(withExtras), "E_P3E_ARGUMENT", "input");
  });
});

/* ------------------------------------------------------------------ */
/* 七、input shape                                                     */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1d input shape", () => {
  it("多欄／缺欄／改名一律拒絕", () => {
    for (const key of ["state", "eventPack", "deathPack", "contentMode"]) {
      const missing = effectsInput(AGE_30);
      delete missing[key];
      expectEffectsError(() => resolveP3EAnnualEventEffects(missing), "E_P3E_ARGUMENT", "input");
    }
    const renamed = effectsInput(AGE_30);
    delete renamed.contentMode;
    renamed.mode = "guardian";
    expectEffectsError(() => resolveP3EAnnualEventEffects(renamed), "E_P3E_ARGUMENT", "input");
  });

  it("hidden／symbol／accessor（getter 不執行）", () => {
    const hidden = effectsInput(AGE_30);
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false, configurable: true });
    expectEffectsError(() => resolveP3EAnnualEventEffects(hidden), "E_P3E_ARGUMENT", "input");

    const symbol = effectsInput(AGE_30);
    Object.defineProperty(symbol, Symbol("extra"), { value: 1, enumerable: false, configurable: true });
    expectEffectsError(() => resolveP3EAnnualEventEffects(symbol), "E_P3E_ARGUMENT", "input");

    const accessor: Dict = {};
    let invoked = false;
    for (const key of ["state", "eventPack", "deathPack"] as const) accessor[key] = effectsInput(AGE_30)[key];
    Object.defineProperty(accessor, "contentMode", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return "guardian";
      }
    });
    expectEffectsError(() => resolveP3EAnnualEventEffects(accessor), "E_P3E_ARGUMENT", "input");
    expect(invoked).toBe(false);
  });

  it("非 plain object／已撤銷 Proxy／trap", () => {
    class Fake {
      public state = AGE_30;
    }
    for (const value of [null, undefined, 42, "input", [], [effectsInput(AGE_30)], new Fake(), Object.create({})]) {
      expectEffectsError(() => resolveP3EAnnualEventEffects(value), "E_P3E_ARGUMENT", "input");
    }
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectEffectsError(() => resolveP3EAnnualEventEffects(revoked.proxy), "E_P3E_ARGUMENT", "input");
    const trap = new Proxy({}, {
      getPrototypeOf() {
        throw new TypeError("proto");
      }
    });
    expectEffectsError(() => resolveP3EAnnualEventEffects(trap), "E_P3E_ARGUMENT", "input");
  });

  it("null prototype 可以接受", () => {
    const bare = Object.assign(Object.create(null) as Dict, effectsInput(AGE_30));
    expect(() => resolveP3EAnnualEventEffects(bare)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 八、不可變與公開表面                                                */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1d 不可變與公開表面", () => {
  it("輸入不修改、結果深層凍結且零共享", () => {
    const state = stateAt(30, { pack: packSetback });
    const before = encodeP3EState(state);
    const result = resolveP3EAnnualEventEffects(effectsInput(state, { eventPack: packSetback }));
    expect(encodeP3EState(state)).toBe(before);
    expect(isDeepFrozen(result)).toBe(true);
    expect(sharesReference(result, state)).toBe(false);
    expect(result.stats).not.toBe(state.stats);
    expect(() => {
      (result as unknown as Dict).informational = true;
    }).toThrow(TypeError);
    expect(() => {
      (result.occurrences as unknown as Dict[])[0]!.count = 99;
    }).toThrow(TypeError);
  });

  it("不建立 State、不 seal（結果沒有 state 身分欄位）", () => {
    const result = resolveP3EAnnualEventEffects(effectsInput(AGE_30));
    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      "assets",
      "changes",
      "flags",
      "informational",
      "occurrences",
      "openedDecision",
      "selectedEventId",
      "selection",
      "stats"
    ]);
    for (const forbidden of ["stateHash", "identity", "heads", "commandLog", "packs", "phase"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("入口與四個 seam 都不在公開 barrel", () => {
    expect(typeof resolveP3EAnnualEventEffects).toBe("function");
    expect(typeof findP3EEvent).toBe("function");
    expect(typeof applyP3EEventEffectsAndOutcome).toBe("function");
    expect(typeof assertP3EAnnualOccurrences).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.resolveP3EAnnualEventEffects).toBeUndefined();
    expect(surface.findP3EEvent).toBeUndefined();
    expect(surface.applyP3EEventEffectsAndOutcome).toBeUndefined();
    expect(surface.assertP3EAnnualOccurrences).toBeUndefined();
    expect(surface.resolveP3EPendingDecision).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });
});
