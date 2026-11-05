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
import { resolveP3EAnnualDeath } from "../src/annual-death";
import type { P3EPendingDecision } from "../src/annual-event-effects";
import {
  buildP3EPendingDecisionSummary,
  resolveP3EAnnualPendingDecision
} from "../src/pending-decision-persistence";
import { encodeP3EState } from "../src/codec";
import { computeP3EStateHash } from "../src/state-hash";
// 測試專用：造出「age 120 hazard = 0」的合法死亡包（重算全部 checksum）。
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * P3-E.1b-1f-1：pending decision → `p3e-2` State 摘要的轉接層。
 *
 * fixture 與 annual-death 一致：關鍵年齡在執行時從已凍結的 mortality fixture 掃出，
 * 另外造一個「age 120 hazard = 0」的合法死亡包來測 age ceiling。
 */

const SEED = "p3e-1b-1f-1-pending";
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
const rawDeathManifest = readJson("fixtures/p3d/manifest.v1.json") as Dict;
const rawDeathDatasets: Dict = {
  "cause-registry": readJson("fixtures/p3d/cause-registry.v1.json"),
  "cause-weights": readJson("fixtures/p3d/cause-weights.v1.json"),
  mortality: readJson("fixtures/p3d/mortality.v1.json"),
  licenses: readJson("fixtures/p3d/licenses.v1.json"),
  lineage: readJson("fixtures/p3d/lineage.v1.json")
};

const eventPack: ValidatedEventPack = validateEventPack({ manifest: rawEventManifest, events: rawEvents } as never);
const deathPack = validateDeathPack({ manifest: rawDeathManifest, datasets: rawDeathDatasets } as never, base);

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

/** 沒有候選事件（`ev.child.first-word` 只適用 age 1–3）。 */
const packNoCandidates = repairedEventPack([cloneEvent("ev.child.first-word")]);

/** 一般（非 decision）事件。 */
const packPlainEvent = repairedEventPack([{ ...cloneEvent("ev.any.setback"), eventId: "ev.plain" }]);

/** 在任何年齡都會開啟 decision 的事件（housing-choice 放寬年齡與人生階段）。 */
const packDecision = repairedEventPack([
  {
    ...cloneEvent("ev.adult.housing-choice"),
    ageMin: 0,
    ageMax: 120,
    lifeStages: ["childhood", "adolescence", "adulthood", "later_life"]
  }
]);

/** 同上，但 pack 內的 option 順序刻意相反：摘要必須跟著 pack 的順序。 */
const packDecisionSwapped = repairedEventPack([
  {
    ...cloneEvent("ev.adult.housing-choice"),
    ageMin: 0,
    ageMax: 120,
    lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
    decision: (() => {
      const source = cloneEvent("ev.adult.housing-choice");
      const decision = structuredClone(source.decision as Dict);
      decision.options = [...(decision.options as Dict[])].reverse();
      return decision;
    })()
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

const ENTITY_ID = genesisState.identity.entityId;
const SEX = genesisState.identity.sex;
const BIRTH_YEAR = genesisState.identity.birthYear;

/* ------------------------------------------------------------------ */
/* 關鍵年齡（執行時掃描）                                              */
/* ------------------------------------------------------------------ */

interface MortalityRow {
  readonly entityId: string;
  readonly sex: string;
  readonly age: number;
  readonly hazardPpm: number;
}

const mortalityRows = (rawDeathDatasets.mortality as { records: MortalityRow[] }).records;
const entityRows = mortalityRows.filter((row) => row.entityId === ENTITY_ID && row.sex === SEX && row.age >= 2);

const alwaysDieAge = entityRows.find((row) => row.hazardPpm === 1_000_000)?.age;
// 只挑 age >= 5：state 會建在 age-1，確保 `ev.child.first-word`（age 1–3）永遠不合格，
// 「無事件」情境才不會意外抽到事件。
const safeRows = entityRows.filter((row) => row.age >= 5);
const safestAge = safeRows.reduce((best, row) => (row.hazardPpm < best.hazardPpm ? row : best), safeRows[0] as MortalityRow)
  .age;

if (alwaysDieAge === undefined) throw new Error("test fixture: entity has no 100% hazard age");
if (safestAge < 2) throw new Error("test fixture: safest age unusable");

/** age 120 hazard = 0 的合法死亡包（讓 P3-D 在 120 歲一定活著）。 */
function deathPackWithZeroHazardAt(age: number): typeof deathPack {
  const manifest = structuredClone(rawDeathManifest);
  const datasets = structuredClone(rawDeathDatasets);
  const row = (datasets.mortality as { records: MortalityRow[] }).records.find(
    (entry) => entry.entityId === ENTITY_ID && entry.sex === SEX && entry.age === age
  );
  if (row === undefined) throw new Error("test fixture: mortality row missing");
  (row as { hazardPpm: number }).hazardPpm = 0;

  const content = ["cause-registry", "cause-weights", "mortality"];
  const cache = new Map<string, string>();
  const checksumOf = (datasetId: string): string => {
    const hit = cache.get(datasetId);
    if (hit !== undefined) return hit;
    const records = (datasets[datasetId] as { records: unknown[] }).records;
    const value = computeDeathDatasetChecksum(manifest as never, datasetId as never, records);
    cache.set(datasetId, value);
    return value;
  };
  for (const license of (datasets.licenses as { records: Dict[] }).records) {
    if (content.includes(license.datasetId as string)) license.checksum = checksumOf(license.datasetId as string);
  }
  for (const record of (datasets.lineage as { records: Dict[] }).records) {
    record.outputChecksum = checksumOf(record.datasetId as string);
    record.inputChecksums = (record.parentLineageIds as string[]).map((parentId) => {
      const parent = (datasets.lineage as { records: Dict[] }).records.find((entry) => entry.lineageId === parentId);
      return parent === undefined ? "0".repeat(64) : checksumOf(parent.datasetId as string);
    });
  }
  for (const descriptor of manifest.datasets as Dict[]) {
    const datasetId = descriptor.datasetId as string;
    descriptor.recordCount = (datasets[datasetId] as { records: unknown[] }).records.length;
    descriptor.checksum = checksumOf(datasetId);
  }
  manifest.licenses = structuredClone((datasets.licenses as { records: unknown[] }).records);
  manifest.lineage = structuredClone((datasets.lineage as { records: unknown[] }).records);
  manifest.packChecksum = computeDeathPackChecksum(manifest as never);
  return validateDeathPack({ manifest, datasets } as never, base);
}

const deathPackNoHazardAt120 = deathPackWithZeroHazardAt(contracts.P3E_MAX_AGE);

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
  readonly stats?: contracts.P3EStats;
  readonly pack?: ValidatedEventPack;
  readonly deathPackOverride?: typeof deathPack;
  readonly occurrences?: readonly contracts.P3EEventOccurrence[];
}

function stateAt(age: number, options: StateOptions = {}): contracts.P3ELifeState {
  const phase: contracts.P3EPhase = age >= contracts.P3E_MAX_AGE ? "death" : "life";
  const pack = options.pack ?? eventPack;
  const deathPackUsed = options.deathPackOverride ?? deathPack;
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
    pendingDecision: null,
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
      death: {
        schemaVersion: deathPackUsed.manifest.schemaVersion,
        deathDataVersion: deathPackUsed.manifest.deathDataVersion,
        deathSpecVersion: deathPackUsed.manifest.deathSpecVersion,
        healthRuleVersion: contracts.P3D_HEALTH_RULE_VERSION,
        engineVersion: deathPackUsed.manifest.engineVersion,
        rngSpecVersion: deathPackUsed.manifest.rngSpecVersion,
        deathPackId: deathPackUsed.manifest.deathPackId,
        deathPackChecksum: deathPackUsed.packChecksum,
        basePackId: deathPackUsed.manifest.basePackId,
        basePackChecksum: deathPackUsed.manifest.basePackChecksum,
        entityCount: deathPackUsed.manifest.entityCount
      }
    },
    flags: age === 0 ? [] : ["p3e:flag-a"],
    occurrences: options.occurrences ?? [],
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

function expectPendingError(run: () => unknown, code: string, path: string): void {
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

function pendingInput(state: contracts.P3ELifeState, overrides: Dict = {}): Dict {
  return { state, eventPack, deathPack, contentMode: "guardian", ...overrides };
}

const SAFE_STATS: contracts.P3EStats = { health: 100, happiness: 55, knowledge: 40, relationships: 35 };
const FRAIL_STATS: contracts.P3EStats = { health: 40, happiness: 55, knowledge: 40, relationships: 35 };

/* ------------------------------------------------------------------ */
/* 一、摘要規則                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1f-1 摘要規則", () => {
  it("無事件 → null", () => {
    const state = stateAt(safestAge - 1, { pack: packNoCandidates, stats: SAFE_STATS });
    const result = resolveP3EAnnualPendingDecision(pendingInput(state, { eventPack: packNoCandidates }));
    expect(result.annualDeath.effects.selectedEventId).toBeNull();
    expect(result.pendingDecisionSummary).toBeNull();
  });

  it("一般（非 decision）事件 → null", () => {
    const state = stateAt(safestAge - 1, { pack: packPlainEvent, stats: SAFE_STATS });
    const result = resolveP3EAnnualPendingDecision(pendingInput(state, { eventPack: packPlainEvent }));
    expect(result.annualDeath.effects.selectedEventId).toBe("ev.plain");
    expect(result.annualDeath.effects.openedDecision).toBeNull();
    expect(result.pendingDecisionSummary).toBeNull();
  });

  it("活著並開啟 decision → 精確六欄摘要", () => {
    const state = stateAt(safestAge - 1, { pack: packDecision, stats: SAFE_STATS });
    const result = resolveP3EAnnualPendingDecision(pendingInput(state, { eventPack: packDecision }));
    const roll = result.annualDeath.effects.selection.roll;

    expect(result.annualDeath.diedThisYear).toBe(false);
    expect(result.pendingDecisionSummary).not.toBeNull();
    expect(result.pendingDecisionSummary).toEqual({
      year: roll.yearAfter,
      age: roll.ageAfter,
      eventId: "ev.adult.housing-choice",
      decisionId: "dec.adult.housing",
      selectionHash: result.annualDeath.effects.selection.selectionHash,
      optionIds: ["rent", "save"]
    });
    // 只有六欄
    expect(Object.keys(result.pendingDecisionSummary as unknown as Dict).sort()).toEqual([
      "age",
      "decisionId",
      "eventId",
      "optionIds",
      "selectionHash",
      "year"
    ]);
  });

  it("optionIds 精確依 pack 順序（pack 換序摘要也跟著換）", () => {
    const forward = stateAt(safestAge - 1, { pack: packDecision, stats: SAFE_STATS });
    const forwardResult = resolveP3EAnnualPendingDecision(pendingInput(forward, { eventPack: packDecision }));
    expect(forwardResult.pendingDecisionSummary?.optionIds).toEqual(["rent", "save"]);

    const swapped = stateAt(safestAge - 1, { pack: packDecisionSwapped, stats: SAFE_STATS });
    const swappedResult = resolveP3EAnnualPendingDecision(pendingInput(swapped, { eventPack: packDecisionSwapped }));
    expect(swappedResult.pendingDecisionSummary?.optionIds).toEqual(["save", "rent"]);
  });

  it("自然死亡壓制 pending decision", () => {
    const state = stateAt((alwaysDieAge as number) - 1, { pack: packDecision, stats: FRAIL_STATS });
    const result = resolveP3EAnnualPendingDecision(pendingInput(state, { eventPack: packDecision }));
    expect(result.annualDeath.mortality.died).toBe(true);
    expect(result.annualDeath.deathReason).toBe("mortality");
    // 事件仍然開過 decision，但死亡年度不得持久化
    expect(result.annualDeath.effects.openedDecision).not.toBeNull();
    expect(result.pendingDecisionSummary).toBeNull();
  });

  it("age ceiling 壓制 pending decision", () => {
    const state = stateAt(contracts.P3E_MAX_AGE - 1, {
      pack: packDecision,
      stats: SAFE_STATS,
      deathPackOverride: deathPackNoHazardAt120
    });
    const result = resolveP3EAnnualPendingDecision(
      pendingInput(state, { eventPack: packDecision, deathPack: deathPackNoHazardAt120 })
    );
    expect(result.annualDeath.deathReason).toBe("age_ceiling");
    expect(result.annualDeath.effects.openedDecision).not.toBeNull();
    expect(result.pendingDecisionSummary).toBeNull();
  });

  it("摘要與來源零共享、深層凍結；輸入不被修改", () => {
    const state = stateAt(safestAge - 1, { pack: packDecision, stats: SAFE_STATS });
    const before = encodeP3EState(state);
    const result = resolveP3EAnnualPendingDecision(pendingInput(state, { eventPack: packDecision }));

    expect(encodeP3EState(state)).toBe(before);
    expect(isDeepFrozen(result)).toBe(true);
    expect(isDeepFrozen(result.pendingDecisionSummary)).toBe(true);
    expect(sharesReference(result, state)).toBe(false);
    expect(result.pendingDecisionSummary?.optionIds).not.toBe(
      (result.annualDeath.effects.openedDecision as P3EPendingDecision).options
    );
    expect(() => {
      (result as unknown as Dict).pendingDecisionSummary = null;
    }).toThrow(TypeError);
    expect(() => {
      ((result.pendingDecisionSummary as unknown as Dict).optionIds as string[])[0] = "x";
    }).toThrow(TypeError);
  });

  it("不得複製事件抽選／effects／死亡／RNG 演算法（靜態檢查）", () => {
    const source = readFileSync(join(ROOT, "packages/simulation/src/pending-decision-persistence.ts"), "utf8");
    for (const forbidden of [
      "evaluateAnnualDeath(",
      "applyEventEffects(",
      "applyEffectOutcome(",
      "selectEvent(",
      "resolveP3ERoll(",
      "uniformInt",
      "uniformBigInt",
      "Xoshiro128StarStar",
      "computeP3ERollAssets"
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // 只透過既有入口
    expect(source).toContain("resolveP3EAnnualDeath");
    expect(source).toContain("validateP3EAnnualPacks");
  });
});

/* ------------------------------------------------------------------ */
/* 二、seam：與同一份 pack 的不一致                                    */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1f-1 pack 一致性（seam）", () => {
  /** 真實跑出一次的 openedDecision（合法事實）。 */
  function realOpened(): { pack: ValidatedEventPack; opened: P3EPendingDecision; selectionHash: string } {
    const state = stateAt(safestAge - 1, { pack: packDecision, stats: SAFE_STATS });
    const stage = resolveP3EAnnualDeath(pendingInput(state, { eventPack: packDecision }));
    const opened = stage.effects.openedDecision;
    if (opened === null) throw new Error("test fixture: decision not opened");
    return { pack: packDecision, opened, selectionHash: stage.effects.selection.selectionHash };
  }

  it("合法事實 → 摘要（seam 與入口一致）", () => {
    const { pack, opened, selectionHash } = realOpened();
    const summary = buildP3EPendingDecisionSummary(pack, opened, selectionHash, 2030, 30);
    expect(summary).toEqual({
      year: 2030,
      age: 30,
      eventId: "ev.adult.housing-choice",
      decisionId: "dec.adult.housing",
      selectionHash,
      optionIds: ["rent", "save"]
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.optionIds)).toBe(true);
  });

  it("eventId／decisionId／selectionHash 不一致 → 拒絕", () => {
    const { pack, opened, selectionHash } = realOpened();
    const forge = (overrides: Partial<P3EPendingDecision>): void => {
      buildP3EPendingDecisionSummary(pack, { ...opened, ...overrides }, selectionHash, 2030, 30);
    };

    expectPendingError(() => forge({ eventId: "ev.not-in-pack" }), "E_P3E_DECISION", "pendingDecision");
    expectPendingError(() => forge({ decisionId: "dec.other" }), "E_P3E_DECISION", "pendingDecision");
    expectPendingError(() => forge({ selectionHash: HEX("9") }), "E_P3E_DECISION", "pendingDecision");
  });

  it("options 數量／順序／重複不一致 → 拒絕", () => {
    const { pack, opened, selectionHash } = realOpened();
    const withOptions = (options: P3EPendingDecision["options"]): void => {
      buildP3EPendingDecisionSummary(pack, { ...opened, options }, selectionHash, 2030, 30);
    };
    const [first, second] = opened.options;

    // 1 個 option（少了第二個）
    expectPendingError(() => withOptions([first as never]), "E_P3E_DECISION", "pendingDecision");
    // 額外 option
    expectPendingError(
      () => withOptions([first as never, second as never, second as never]),
      "E_P3E_DECISION",
      "pendingDecision"
    );
    // 換序
    expectPendingError(() => withOptions([second as never, first as never]), "E_P3E_DECISION", "pendingDecision");
    // 重複
    expectPendingError(() => withOptions([first as never, first as never]), "E_P3E_DECISION", "pendingDecision");
    // 空
    expectPendingError(() => withOptions([]), "E_P3E_DECISION", "pendingDecision");
  });

  it("偽造 pack（1 個 option／超過 5 個／重複／沒有 decision）→ 拒絕", () => {
    const { opened, selectionHash } = realOpened();
    const fakePack = (options: readonly Dict[], decision: Dict | null): ValidatedEventPack =>
      ({
        manifest: {},
        events: [
          {
            eventId: opened.eventId,
            decision: decision === null ? null : { decisionId: opened.decisionId, promptKey: "k", options }
          }
        ]
      }) as unknown as ValidatedEventPack;

    const oneOption = [{ optionId: "rent" }];
    expectPendingError(
      () => buildP3EPendingDecisionSummary(fakePack(oneOption, { decisionId: opened.decisionId }), opened, selectionHash, 2030, 30),
      "E_P3E_DECISION",
      "pendingDecision"
    );

    const sixOptions = ["a1", "b2", "c3", "d4", "e5", "f6"].map((optionId) => ({ optionId }));
    expectPendingError(
      () => buildP3EPendingDecisionSummary(fakePack(sixOptions, { decisionId: opened.decisionId }), opened, selectionHash, 2030, 30),
      "E_P3E_DECISION",
      "pendingDecision"
    );

    const duplicates = [{ optionId: "rent" }, { optionId: "rent" }];
    expectPendingError(
      () => buildP3EPendingDecisionSummary(fakePack(duplicates, { decisionId: opened.decisionId }), opened, selectionHash, 2030, 30),
      "E_P3E_DECISION",
      "pendingDecision"
    );

    // 事件沒有 decision
    expectPendingError(
      () => buildP3EPendingDecisionSummary(fakePack(oneOption, null), opened, selectionHash, 2030, 30),
      "E_P3E_DECISION",
      "pendingDecision"
    );
  });
});

/* ------------------------------------------------------------------ */
/* 三、公開表面與輸入邊界                                              */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1f-1 公開表面", () => {
  it("入口與 seam 都不在公開 barrel", () => {
    expect(typeof resolveP3EAnnualPendingDecision).toBe("function");
    expect(typeof buildP3EPendingDecisionSummary).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.resolveP3EAnnualPendingDecision).toBeUndefined();
    expect(surface.buildP3EPendingDecisionSummary).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("不接受呼叫端傳入的中間結果", () => {
    const state = stateAt(safestAge - 1, { pack: packDecision, stats: SAFE_STATS });
    expectPendingError(
      () => resolveP3EAnnualPendingDecision({ ...pendingInput(state, { eventPack: packDecision }), annualDeath: {} }),
      "E_P3E_ARGUMENT",
      "input"
    );
    expectPendingError(
      () => resolveP3EAnnualPendingDecision({ ...pendingInput(state, { eventPack: packDecision }), pendingDecisionSummary: {} }),
      "E_P3E_ARGUMENT",
      "input"
    );
  });

  it("input shape：多／缺／改名／hidden／symbol／accessor／Proxy", () => {
    const base = () => {
      const state = stateAt(safestAge - 1, { pack: packDecision, stats: SAFE_STATS });
      return pendingInput(state, { eventPack: packDecision });
    };

    for (const key of ["state", "eventPack", "deathPack", "contentMode"]) {
      const missing = base();
      delete missing[key];
      expectPendingError(() => resolveP3EAnnualPendingDecision(missing), "E_P3E_ARGUMENT", "input");
    }
    const renamed = base();
    delete renamed.contentMode;
    renamed.mode = "guardian";
    expectPendingError(() => resolveP3EAnnualPendingDecision(renamed), "E_P3E_ARGUMENT", "input");

    const hidden = base();
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false, configurable: true });
    expectPendingError(() => resolveP3EAnnualPendingDecision(hidden), "E_P3E_ARGUMENT", "input");

    const accessor: Dict = {};
    let invoked = false;
    for (const key of ["state", "eventPack", "deathPack"] as const) accessor[key] = base()[key];
    Object.defineProperty(accessor, "contentMode", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return "guardian";
      }
    });
    expectPendingError(() => resolveP3EAnnualPendingDecision(accessor), "E_P3E_ARGUMENT", "input");
    expect(invoked).toBe(false);

    for (const value of [null, undefined, 42, [], [base()], Object.create({})]) {
      expectPendingError(() => resolveP3EAnnualPendingDecision(value), "E_P3E_ARGUMENT", "input");
    }
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectPendingError(() => resolveP3EAnnualPendingDecision(revoked.proxy), "E_P3E_ARGUMENT", "input");
  });

  it("既有錯誤原樣保留（state／pack／contentMode）", () => {
    const state = stateAt(safestAge - 1, { pack: packDecision, stats: SAFE_STATS });
    const broken = structuredClone(state) as unknown as Dict;
    broken.stateHash = HEX("0");
    expectPendingError(
      () => resolveP3EAnnualPendingDecision(pendingInput(broken as unknown as contracts.P3ELifeState, { eventPack: packDecision })),
      "E_P3E_HASH",
      "stateHash"
    );
    expectPendingError(
      () => resolveP3EAnnualPendingDecision({ ...pendingInput(state), eventPack: structuredClone(packDecision) }),
      "E_P3E_EVENT_PACK",
      "eventPack"
    );
    expectPendingError(
      () => resolveP3EAnnualPendingDecision({ ...pendingInput(state, { eventPack: packDecision }), contentMode: "hard" }),
      "E_P3E_EVENT",
      "contentMode"
    );
  });

  it("不建立 State、不產生 ledger／command／chain 欄位", () => {
    const state = stateAt(safestAge - 1, { pack: packDecision, stats: SAFE_STATS });
    const result = resolveP3EAnnualPendingDecision(pendingInput(state, { eventPack: packDecision }));
    expect(Object.keys(result).sort()).toEqual(["annualDeath", "pendingDecisionSummary"]);
    for (const forbidden of ["stateHash", "identity", "heads", "commandLog", "packs", "chain", "ledger", "command"]) {
      expect(Object.keys(result)).not.toContain(forbidden);
    }
  });
});
