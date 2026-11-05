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
  selectEvent,
  validateEventPack,
  Xoshiro128StarStar,
  type ValidatedEventPack
} from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { createP3EGenesis } from "../src/genesis";
import { applyP3EEventDraws, resolveP3EAnnualEventSelection, selectP3EEvent } from "../src/annual-event-selection";
import { encodeP3EState } from "../src/codec";
import { resolveP3EAnnualRoll } from "../src/annual-roll";
import { computeP3EStateHash } from "../src/state-hash";

/**
 * P3-E.1b-1c：年度 roll ＋ 事件抽選轉接層。
 *
 * fixture 全部由真實驗證器產生；「只有一個事件」的 pack 由 p3b fixture 過濾後**重算所有 checksum**
 * 再驗證，因此是真正的品牌物件。期待值另外直接呼叫 P3-B 的 `selectEvent` 與
 * `resolveP3EAnnualRoll` 獨立算出來。
 */

const SEED = "p3e-1b-1c-event-selection";
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

/** 用一組事件重建 pack：重算全部 checksum 後重新驗證（真正的品牌物件）。 */
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

/** 只有 `ev.child.first-word`（age 1–3）：在 age 30 一定沒有候選。 */
const packOnlyFirstWord = filteredPack((record) => record.eventId === "ev.child.first-word");
/** 只有 `ev.any.setback`（age 0–120、無條件）：任何 age 都只有一個候選。 */
const packOnlySetback = filteredPack((record) => record.eventId === "ev.any.setback");

/**
 * 兩個高權重事件，總權重刻意選成 `floor(2^64 / 1025) + 1`：
 * 這樣 `2^64 mod total ≈ total`，rejection sampling 的拒絕率約 1/1025，
 * 因此「一次抽選用掉 4 或 6 個 u32」在合法的品牌 pack 上真的會發生。
 */
const REJECT_TOTAL = (1n << 64n) / 1025n + 1n;
const REJECT_W1 = (1n << 53n) - 1n;
const REJECT_W2 = REJECT_TOTAL - REJECT_W1;

const packRejection: ValidatedEventPack = (() => {
  const template = rawEvents.find((record) => record.eventId === "ev.any.setback");
  if (template === undefined) throw new Error("test fixture: ev.any.setback missing");
  return repairedPack([
    { ...structuredClone(template), eventId: "ev.aa", weight: Number(REJECT_W1) },
    { ...structuredClone(template), eventId: "ev.ab", weight: Number(REJECT_W2) }
  ]);
})();

/** 開發期離線搜尋得到、測試中硬編碼：age 30 的第 364 個 u32 位置會先被拒絕一次（4 draws）。 */
const REJECT_DRAWS_AFTER_364 = 364;
/** 開發期離線搜尋得到、測試中硬編碼：這個 tuple 連兩次被拒絕（6 draws）。 */
const SIX_DRAW_RNG = [501110, 47721622, 2654002383, 3841204595] as const;

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
  readonly flags?: readonly string[];
  readonly occurrences?: readonly contracts.P3EEventOccurrence[];
  readonly pack?: ValidatedEventPack;
  readonly eventDraws?: number;
}

const BIRTH_YEAR = genesisState.identity.birthYear;

/** 建一個 age 歲、指定 phase／pack／occurrences 的合法 state。 */
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

function expectSelectionError(run: () => unknown, code: string, path: string): void {
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

function selectionInput(state: contracts.P3ELifeState, overrides: Dict = {}): Dict {
  return { state, eventPack, deathPack, contentMode: "guardian", ...overrides };
}

/** 獨立期待值：直接用 P3-B 的 `selectEvent` ＋ roll 後的數值算一次。 */
function expectedSelection(
  state: contracts.P3ELifeState,
  pack: ValidatedEventPack,
  contentMode: contracts.P3BContentMode
) {
  const roll = resolveP3EAnnualRoll({ state });
  return selectEvent({
    pack,
    state: {
      currentYear: roll.yearAfter,
      age: roll.ageAfter,
      phase: "life",
      stats: {
        health: roll.statsAfter.health,
        happiness: roll.statsAfter.happiness,
        knowledge: roll.statsAfter.knowledge,
        relationships: roll.statsAfter.relationships
      },
      assets: {
        balanceMicroUsd: roll.assetsAfter.balanceMicroUsd,
        annualIncomeMicroUsd: roll.assetsAfter.annualIncomeMicroUsd,
        annualExpenseMicroUsd: roll.assetsAfter.annualExpenseMicroUsd
      },
      flags: [state.flags[0] as string]
    },
    history: { occurrences: state.occurrences.map((entry) => ({ ...entry })) },
    contentMode,
    rngState: state.rng.events.state
  });
}

const AGE_30 = stateAt(30);
const AGE_15 = stateAt(15);
const AGE_17 = stateAt(17);

/* ------------------------------------------------------------------ */
/* 一、多候選與決定性                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1c 多候選", () => {
  it("age 30 → 31：候選、抽選、draws 與獨立期待值一致", () => {
    const state = AGE_30;
    const result = resolveP3EAnnualEventSelection(selectionInput(state));
    const expected = expectedSelection(state, eventPack, "guardian");

    expect(result.contentMode).toBe("guardian");
    expect(result.roll.ageAfter).toBe(31);
    expect(result.roll.yearAfter).toBe(state.currentYear + 1);
    expect(result.candidates).toEqual(expected.candidates);
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.selectedEventId).toBe(expected.selectedEventId);
    expect(result.selectedEventId).not.toBeNull();
    expect(result.reason).toBe("weighted");
    expect(result.selectionHash).toBe(expected.selectionHash);
    expect(result.u32DrawsUsed).toBe(expected.drawsUsed);
    expect(result.u32DrawsUsed).toBe(2);
  });

  it("event RNG：initialState 不變、state 取自 P3-B、u32Draws 累加", () => {
    const state = AGE_30;
    const expected = expectedSelection(state, eventPack, "guardian");
    const result = resolveP3EAnnualEventSelection(selectionInput(state));

    expect(result.eventRngBefore).toEqual(state.rng.events);
    expect(result.eventRngBefore).not.toBe(state.rng.events);
    expect(result.eventRngAfter.initialState).toEqual(state.rng.events.initialState);
    expect(result.eventRngAfter.state).toEqual(expected.rngStateAfter);
    expect(result.eventRngAfter.u32Draws).toBe(state.rng.events.u32Draws + expected.drawsUsed);
    expect(result.eventRngAfter.state).not.toEqual(state.rng.events.state);
    expect(result.eventRngAfter.domain).toBe(state.rng.events.domain);
  });

  it("100 次重跑逐欄一致", () => {
    const first = resolveP3EAnnualEventSelection(selectionInput(AGE_30));
    for (let index = 0; index < 100; index += 1) {
      expect(resolveP3EAnnualEventSelection(selectionInput(AGE_30))).toEqual(first);
    }
  });

  it("結果深層凍結、與輸入零共享", () => {
    const state = AGE_30;
    const result = resolveP3EAnnualEventSelection(selectionInput(state));
    expect(isDeepFrozen(result)).toBe(true);
    expect(sharesReference(result, state)).toBe(false);
    expect(result.candidates).not.toBe(state.occurrences);
    expect(() => {
      (result as unknown as Dict).contentMode = "standard";
    }).toThrow(TypeError);
    expect(() => {
      (result.candidates as unknown as Dict[])[0]!.eventId = "x";
    }).toThrow(TypeError);
    expect(() => {
      (result.eventRngAfter.state as unknown as number[])[0] = 1;
    }).toThrow(TypeError);
  });

  it("不修改輸入", () => {
    const state = AGE_30;
    const before = encodeP3EState(state);
    resolveP3EAnnualEventSelection(selectionInput(state));
    expect(encodeP3EState(state)).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* 二、standard／guardian                                              */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1c contentMode", () => {
  it("standard 與 guardian 的候選集合不同", () => {
    const state = AGE_15;
    const guardian = resolveP3EAnnualEventSelection(selectionInput(state, { contentMode: "guardian" }));
    const standard = resolveP3EAnnualEventSelection(selectionInput(state, { contentMode: "standard" }));

    const guardianIds = guardian.candidates.map((candidate) => candidate.eventId);
    const standardIds = standard.candidates.map((candidate) => candidate.eventId);

    expect(guardian.contentMode).toBe("guardian");
    expect(standard.contentMode).toBe("standard");
    expect(guardianIds).toContain("ev.guardian.calm");
    expect(guardianIds).not.toContain("ev.teen.risk-experiment");
    expect(standardIds).toContain("ev.teen.risk-experiment");
    expect(standardIds).not.toContain("ev.guardian.calm");
    expect(guardianIds).not.toEqual(standardIds);
    // 對稱差：guardian 專屬（contentMode 條件）與 standard 專屬各一
    expect(guardianIds.filter((id) => !standardIds.includes(id))).toEqual(["ev.guardian.calm"]);
    expect(standardIds.filter((id) => !guardianIds.includes(id))).toEqual(["ev.teen.risk-experiment"]);
    expect(guardian.selectionHash).not.toBe(standard.selectionHash);
  });

  it("結果保留 contentMode（不是硬編碼）", () => {
    for (const contentMode of ["standard", "guardian"] as const) {
      const result = resolveP3EAnnualEventSelection(selectionInput(AGE_30, { contentMode }));
      expect(result.contentMode).toBe(contentMode);
    }
  });

  it("非法 contentMode → E_P3E_EVENT at contentMode（沒有預設值）", () => {
    for (const contentMode of ["hard", "", 42, null, undefined, {}, ["standard"]]) {
      expectSelectionError(
        () => resolveP3EAnnualEventSelection(selectionInput(AGE_30, { contentMode })),
        "E_P3E_EVENT",
        "contentMode"
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* 三、無候選／單一候選                                                */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1c 候選數量", () => {
  it("無候選：0 draws、游標不動、selectedEventId 為 null", () => {
    const state = stateAt(30, { pack: packOnlyFirstWord });
    const result = resolveP3EAnnualEventSelection(selectionInput(state, { eventPack: packOnlyFirstWord }));

    expect(result.candidates).toEqual([]);
    expect(result.selectedEventId).toBeNull();
    expect(result.reason).toBe("no_candidates");
    expect(result.u32DrawsUsed).toBe(0);
    expect(result.eventRngAfter.state).toEqual(result.eventRngBefore.state);
    expect(result.eventRngAfter.u32Draws).toBe(result.eventRngBefore.u32Draws);
    expect(result.eventRngAfter.initialState).toEqual(result.eventRngBefore.initialState);
    expect(result.selectionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("單一候選：0 draws、游標不動", () => {
    const state = stateAt(30, { pack: packOnlySetback });
    const result = resolveP3EAnnualEventSelection(selectionInput(state, { eventPack: packOnlySetback }));

    expect(result.candidates.map((candidate) => candidate.eventId)).toEqual(["ev.any.setback"]);
    expect(result.selectedEventId).toBe("ev.any.setback");
    expect(result.reason).toBe("single_candidate");
    expect(result.u32DrawsUsed).toBe(0);
    expect(result.eventRngAfter.state).toEqual(result.eventRngBefore.state);
    expect(result.eventRngAfter.u32Draws).toBe(result.eventRngBefore.u32Draws);
  });
});

/* ------------------------------------------------------------------ */
/* 四、Roll 之後的數值用於條件判斷                                      */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1c Roll 後數值", () => {
  it("age 邊界用 Roll 後（17 → 18 才出現 ev.teen.major-choice）", () => {
    const state = AGE_17;
    const result = resolveP3EAnnualEventSelection(selectionInput(state));
    expect(result.roll.ageAfter).toBe(18);
    expect(result.candidates.map((candidate) => candidate.eventId)).toContain("ev.teen.major-choice");

    // 用交易前的 age 去算就不會有這個候選（證明不是用舊值）
    const preRoll = selectEvent({
      pack: eventPack,
      state: {
        currentYear: state.currentYear,
        age: state.age,
        phase: "life",
        stats: { ...state.stats },
        assets: {
          balanceMicroUsd: state.assets.balanceMicroUsd,
          annualIncomeMicroUsd: state.assets.annualIncomeMicroUsd,
          annualExpenseMicroUsd: state.assets.annualExpenseMicroUsd
        },
        flags: [state.flags[0] as string]
      },
      history: { occurrences: state.occurrences.map((entry) => ({ ...entry })) },
      contentMode: "guardian",
      rngState: state.rng.events.state
    });
    expect(preRoll.candidates.map((candidate) => candidate.eventId)).not.toContain("ev.teen.major-choice");
  });

  it("cooldown 用 Roll 後的 currentYear（差 2 年就解除）", () => {
    // age 30 → 31；state.currentYear = birthYear+30，Roll 後 = birthYear+31
    const fresh: contracts.P3EEventOccurrence = { eventId: "ev.any.setback", count: 1, lastYear: BIRTH_YEAR + 29 };
    const cooling: contracts.P3EEventOccurrence = { eventId: "ev.any.setback", count: 1, lastYear: BIRTH_YEAR + 30 };

    const freshState = stateAt(30, { occurrences: [fresh] });
    const freshResult = resolveP3EAnnualEventSelection(selectionInput(freshState));
    expect(freshResult.candidates.map((candidate) => candidate.eventId)).toContain("ev.any.setback");

    const coolingState = stateAt(30, { occurrences: [cooling] });
    const coolingResult = resolveP3EAnnualEventSelection(selectionInput(coolingState));
    expect(coolingResult.candidates.map((candidate) => candidate.eventId)).not.toContain("ev.any.setback");
  });

  it("once：已發生過就不再是候選", () => {
    const onceEventId = "ev.child.first-word";
    const withoutOccurrence = stateAt(2, { occurrences: [] });
    const withOccurrence = stateAt(2, {
      occurrences: [{ eventId: onceEventId, count: 1, lastYear: BIRTH_YEAR + 1 }]
    });

    const first = resolveP3EAnnualEventSelection(selectionInput(withoutOccurrence));
    expect(first.roll.ageAfter).toBe(3);
    expect(first.candidates.map((candidate) => candidate.eventId)).toContain(onceEventId);

    const second = resolveP3EAnnualEventSelection(selectionInput(withOccurrence));
    expect(second.candidates.map((candidate) => candidate.eventId)).not.toContain(onceEventId);
  });

  it("occurrences 原封不動傳給 P3-B（不改、不排序、不新增）", () => {
    const state = stateAt(5, {
      occurrences: [
        { eventId: "ev.any.setback", count: 1, lastYear: BIRTH_YEAR + 2 },
        { eventId: "ev.child.playground", count: 1, lastYear: BIRTH_YEAR + 4 }
      ]
    });
    const before = encodeP3EState(state);
    const result = resolveP3EAnnualEventSelection(selectionInput(state));
    expect(encodeP3EState(state)).toBe(before);
    expect(state.occurrences.length).toBe(2);
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 五、錯誤邊界與順序                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1c 錯誤", () => {
  it("shape 最先", () => {
    expectSelectionError(() => resolveP3EAnnualEventSelection(null), "E_P3E_ARGUMENT", "input");
    expectSelectionError(() => resolveP3EAnnualEventSelection({}), "E_P3E_ARGUMENT", "input");
    const extra = { ...selectionInput(AGE_30), extra: 1 };
    expectSelectionError(() => resolveP3EAnnualEventSelection(extra), "E_P3E_ARGUMENT", "input");
    for (const key of ["state", "eventPack", "deathPack", "contentMode"]) {
      const missing = selectionInput(AGE_30);
      delete missing[key];
      expectSelectionError(() => resolveP3EAnnualEventSelection(missing), "E_P3E_ARGUMENT", "input");
    }
    // 鍵數相同但鍵名被換掉
    const renamed = selectionInput(AGE_30);
    delete renamed.contentMode;
    renamed.mode = "guardian";
    expectSelectionError(() => resolveP3EAnnualEventSelection(renamed), "E_P3E_ARGUMENT", "input");
  });

  it("hidden／symbol／accessor（getter 不執行）／陣列／class／Proxy", () => {
    const hidden = selectionInput(AGE_30);
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false, configurable: true });
    expectSelectionError(() => resolveP3EAnnualEventSelection(hidden), "E_P3E_ARGUMENT", "input");

    const symbol = selectionInput(AGE_30);
    Object.defineProperty(symbol, Symbol("extra"), { value: 1, enumerable: false, configurable: true });
    expectSelectionError(() => resolveP3EAnnualEventSelection(symbol), "E_P3E_ARGUMENT", "input");

    const accessor: Dict = {};
    let invoked = false;
    for (const key of ["state", "eventPack", "deathPack"] as const) accessor[key] = selectionInput(AGE_30)[key];
    Object.defineProperty(accessor, "contentMode", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return "guardian";
      }
    });
    expectSelectionError(() => resolveP3EAnnualEventSelection(accessor), "E_P3E_ARGUMENT", "input");
    expect(invoked).toBe(false);

    class Fake {
      public state = AGE_30;
    }
    for (const value of [undefined, 42, "input", [], [selectionInput(AGE_30)], new Fake(), Object.create({})]) {
      expectSelectionError(() => resolveP3EAnnualEventSelection(value), "E_P3E_ARGUMENT", "input");
    }

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectSelectionError(() => resolveP3EAnnualEventSelection(revoked.proxy), "E_P3E_ARGUMENT", "input");

    const trap = new Proxy({}, {
      getPrototypeOf() {
        throw new TypeError("proto");
      }
    });
    expectSelectionError(() => resolveP3EAnnualEventSelection(trap), "E_P3E_ARGUMENT", "input");
  });

  it("state 錯誤早於 contentMode 錯誤", () => {
    const broken = structuredClone(AGE_30) as unknown as Dict;
    broken.stateHash = HEX("0");
    expectSelectionError(
      () => resolveP3EAnnualEventSelection({ state: broken, eventPack, deathPack, contentMode: "hard" }),
      "E_P3E_HASH",
      "stateHash"
    );
  });

  it("pack 錯誤早於 contentMode 錯誤", () => {
    expectSelectionError(
      () => resolveP3EAnnualEventSelection({ state: AGE_30, eventPack: structuredClone(eventPack), deathPack, contentMode: "hard" }),
      "E_P3E_EVENT_PACK",
      "eventPack"
    );
  });

  it("contentMode 錯誤早於 phase 錯誤（順序固定在 Roll 之前）", () => {
    const pending = stateAt(30, { phase: "pending_decision", pendingDecision: { year: BIRTH_YEAR + 30, age: 30, eventId: "ev.adult.housing-choice", decisionId: "dec.adult.housing", selectionHash: HEX("f"), optionIds: ["rent", "save"] } });
    expectSelectionError(
      () => resolveP3EAnnualEventSelection({ state: pending, eventPack, deathPack, contentMode: "hard" }),
      "E_P3E_EVENT",
      "contentMode"
    );
    // contentMode 合法時，才輪到 Roll 的 phase 檢查
    expectSelectionError(
      () => resolveP3EAnnualEventSelection({ state: pending, eventPack, deathPack, contentMode: "guardian" }),
      "E_P3E_PHASE",
      "phase"
    );
  });

  it("P3-B 抽選錯誤折成 E_P3E_EVENT at eventSelection", () => {
    const state = AGE_30;
    const goodInput = {
      pack: eventPack,
      state: {
        currentYear: 2031,
        age: 31,
        phase: "life",
        stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
        assets: { balanceMicroUsd: 1_900_000n, annualIncomeMicroUsd: 4_100_000n, annualExpenseMicroUsd: 2_100_000n },
        flags: ["p3e:flag-a"]
      },
      history: { occurrences: state.occurrences.map((entry) => ({ ...entry })) },
      contentMode: "guardian",
      rngState: state.rng.events.state
    };
    // 合法輸入時 seam 直接回傳 P3-B 的結果
    expect(selectP3EEvent(goodInput).selectedEventId).toBe(
      selectEvent(goodInput).selectedEventId
    );
    // 非品牌 pack → P3-B 的 E_P3B_TYPE 被折成固定 P3EError
    expectSelectionError(
      () => selectP3EEvent({ ...goodInput, pack: structuredClone(eventPack) }),
      "E_P3E_EVENT",
      "eventSelection"
    );
    // 亂傳 → 一樣折成固定 P3EError（不外洩 TypeError／P3BError）
    for (const value of [null, undefined, 42, {}, { pack: eventPack }]) {
      expectSelectionError(() => selectP3EEvent(value), "E_P3E_EVENT", "eventSelection");
    }
  });

  it("RNG 會計：合法 0／2／4／6 與最大邊界", () => {
    const LIMIT_PATH = "rng.events.u32Draws";
    expect(LIMIT_PATH).toBe("rng.events.u32Draws");
    // 0 draws（無候選／單一候選）
    expect(applyP3EEventDraws(0, 0, 1)).toBe(0);
    expect(applyP3EEventDraws(364, 0, 31)).toBe(364);
    // 2 draws（一般加權抽選）
    expect(applyP3EEventDraws(60, 2, 30)).toBe(62);
    // 4／6 draws（rejection sampling 之後才接受）
    expect(applyP3EEventDraws(364, 4, 31)).toBe(368);
    expect(applyP3EEventDraws(364, 6, 31)).toBe(370);
    // 最大合法邊界：剛好等於 256 × ageAfter
    const maxAge = 31;
    expect(applyP3EEventDraws(256 * maxAge - 4, 4, maxAge)).toBe(256 * maxAge);
    expect(applyP3EEventDraws(256 * 120 - 2, 2, 120)).toBe(256 * 120);
  });

  it("RNG 會計：負數／奇數／小數／NaN／Infinity／非法 ageAfter／超限一律拒絕", () => {
    const cases: readonly (readonly [string, number, number, number])[] = [
      ["u32DrawsBefore 負數", -2, 2, 30],
      ["u32DrawsBefore 奇數", 3, 2, 30],
      ["u32DrawsBefore 小數", 2.5, 2, 30],
      ["u32DrawsBefore NaN", Number.NaN, 2, 30],
      ["u32DrawsBefore Infinity", Number.POSITIVE_INFINITY, 2, 30],
      ["u32DrawsBefore 超過安全整數", Number.MAX_SAFE_INTEGER + 1, 2, 30],
      ["drawsUsed 負數", 0, -2, 30],
      ["drawsUsed 奇數", 0, 3, 30],
      ["drawsUsed 小數", 0, 1.5, 30],
      ["drawsUsed NaN", 0, Number.NaN, 30],
      ["drawsUsed Infinity", 0, Number.POSITIVE_INFINITY, 30],
      ["drawsUsed 超過安全整數", 0, Number.MAX_SAFE_INTEGER + 1, 30],
      // 兩個小數抵銷後總和是整數：逐項檢查必須先擋下
      ["小數互相抵銷", 2.5, 1.5, 30],
      ["ageAfter 0", 0, 2, 0],
      ["ageAfter 121", 0, 2, 121],
      ["ageAfter 小數", 0, 2, 1.5],
      ["ageAfter NaN", 0, 2, Number.NaN],
      ["ageAfter Infinity", 0, 2, Number.POSITIVE_INFINITY],
      // 總和超過 256 × ageAfter
      ["總和超限", 256 * 31, 2, 31],
      // 總和超過安全整數
      ["總和非安全整數", Number.MAX_SAFE_INTEGER - 1, 2, 120]
    ];
    for (const [label, before, used, ageAfter] of cases) {
      const caught = caughtFrom(() => applyP3EEventDraws(before, used, ageAfter));
      expect(isP3EError(caught), label).toBe(true);
      expect((caught as P3EError).code, label).toBe("E_P3E_RNG");
      expect((caught as P3EError).path, label).toBe("rng.events.u32Draws");
    }
  });

  it("失敗不產生部分結果、不修改輸入", () => {
    const pending = stateAt(30, { phase: "pending_decision", pendingDecision: { year: BIRTH_YEAR + 30, age: 30, eventId: "ev.adult.housing-choice", decisionId: "dec.adult.housing", selectionHash: HEX("f"), optionIds: ["rent", "save"] } });
    const before = encodeP3EState(pending);
    const caught = caughtFrom(() =>
      resolveP3EAnnualEventSelection({ state: pending, eventPack, deathPack, contentMode: "guardian" })
    );
    expect(isP3EError(caught)).toBe(true);
    expect(encodeP3EState(pending)).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* 五之二、rejection sampling（4／6 draws）                            */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1c rejection sampling", () => {
  it("4 draws：第 364 個游標位置先被拒絕一次，累計精確 +4", () => {
    const state = stateAt(30, { pack: packRejection, eventDraws: REJECT_DRAWS_AFTER_364 });
    expect(state.rng.events.u32Draws).toBe(REJECT_DRAWS_AFTER_364);

    const result = resolveP3EAnnualEventSelection({
      state,
      eventPack: packRejection,
      deathPack,
      contentMode: "guardian"
    });
    const expected = expectedSelection(state, packRejection, "guardian");

    expect(expected.drawsUsed).toBe(4);
    expect(result.u32DrawsUsed).toBe(4);
    expect(result.u32DrawsUsed).not.toBe(2);
    expect(result.u32DrawsUsed % 2).toBe(0);

    // 累計值精確增加實際 draws（不是 2、也不是被截斷的值）
    expect(result.eventRngAfter.u32Draws).toBe(REJECT_DRAWS_AFTER_364 + 4);
    expect(result.eventRngAfter.u32Draws - result.eventRngBefore.u32Draws).toBe(4);

    // 游標正好前進 4 個 u32
    expect(result.eventRngAfter.state).toEqual(advance(state.rng.events.state, 4));
    // 與直接呼叫 P3-B 完全一致
    expect(result.reason).toBe("weighted");
    expect(result.candidates).toEqual(expected.candidates);
    expect(result.selectedEventId).toBe(expected.selectedEventId);
    expect(result.selectionHash).toBe(expected.selectionHash);
    expect(result.eventRngAfter.state).toEqual(expected.rngStateAfter);
    expect(result.eventRngAfter.initialState).toEqual(state.rng.events.initialState);
  });

  it("6 draws：硬編碼 tuple 連兩次被拒絕，累計精確 +6", () => {
    const state = stateAt(30, { pack: packRejection, eventDraws: REJECT_DRAWS_AFTER_364 });
    const roll = resolveP3EAnnualRoll({ state });
    const input = {
      pack: packRejection,
      state: {
        currentYear: roll.yearAfter,
        age: roll.ageAfter,
        phase: "life",
        stats: {
          health: roll.statsAfter.health,
          happiness: roll.statsAfter.happiness,
          knowledge: roll.statsAfter.knowledge,
          relationships: roll.statsAfter.relationships
        },
        assets: {
          balanceMicroUsd: roll.assetsAfter.balanceMicroUsd,
          annualIncomeMicroUsd: roll.assetsAfter.annualIncomeMicroUsd,
          annualExpenseMicroUsd: roll.assetsAfter.annualExpenseMicroUsd
        },
        flags: [...state.flags]
      },
      history: { occurrences: state.occurrences.map((entry) => ({ ...entry })) },
      contentMode: "guardian" as const,
      rngState: SIX_DRAW_RNG
    };

    const direct = selectEvent(input);
    const viaSeam = selectP3EEvent(input);

    expect(direct.drawsUsed).toBe(6);
    expect(viaSeam.drawsUsed).toBe(6);
    expect(viaSeam.rngStateAfter).toEqual(direct.rngStateAfter);
    expect(viaSeam.selectedEventId).toBe(direct.selectedEventId);
    expect(viaSeam.selectionHash).toBe(direct.selectionHash);

    // 累計：364 + 6
    expect(applyP3EEventDraws(REJECT_DRAWS_AFTER_364, viaSeam.drawsUsed, roll.ageAfter)).toBe(370);
    expect(applyP3EEventDraws(REJECT_DRAWS_AFTER_364, viaSeam.drawsUsed, roll.ageAfter)).toBe(
      REJECT_DRAWS_AFTER_364 + viaSeam.drawsUsed
    );
    // 邊界仍成立（370 <= 256 × 31）
    expect(370).toBeLessThanOrEqual(256 * roll.ageAfter);
  });

  it("高權重 pack 的候選就是那兩個事件（總權重刻意接近 2^64/1025）", () => {
    const state = stateAt(30, { pack: packRejection, eventDraws: REJECT_DRAWS_AFTER_364 });
    const result = resolveP3EAnnualEventSelection({
      state,
      eventPack: packRejection,
      deathPack,
      contentMode: "guardian"
    });
    expect(result.candidates.map((candidate) => candidate.eventId)).toEqual(["ev.aa", "ev.ab"]);
    expect(BigInt(result.candidates[0]?.weight ?? 0) + BigInt(result.candidates[1]?.weight ?? 0)).toBe(REJECT_TOTAL);
    expect(REJECT_W2).toBe(REJECT_TOTAL - REJECT_W1);
    expect(REJECT_W1).toBe((1n << 53n) - 1n);
  });
});

/* ------------------------------------------------------------------ */
/* 六、公開表面                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1c 公開表面", () => {
  it("入口與兩個 seam 都不在公開 barrel", () => {
    expect(typeof resolveP3EAnnualEventSelection).toBe("function");
    expect(typeof selectP3EEvent).toBe("function");
    expect(typeof applyP3EEventDraws).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.resolveP3EAnnualEventSelection).toBeUndefined();
    expect(surface.selectP3EEvent).toBeUndefined();
    expect(surface.applyP3EEventDraws).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("不建立 State、不 seal（結果沒有 stateHash／identity）", () => {
    const result = resolveP3EAnnualEventSelection(selectionInput(AGE_30));
    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      "candidates",
      "contentMode",
      "eventRngAfter",
      "eventRngBefore",
      "reason",
      "roll",
      "selectedEventId",
      "selectionHash",
      "u32DrawsUsed"
    ]);
    expect(keys).not.toContain("stateHash");
    expect(keys).not.toContain("identity");
    expect(keys).not.toContain("heads");
  });
});
