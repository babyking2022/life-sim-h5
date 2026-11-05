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
import { applyP3EDeathDraws, evaluateP3EAnnualDeath, resolveP3EAnnualDeath } from "../src/annual-death";
import { encodeP3EState } from "../src/codec";
import { computeP3EStateHash } from "../src/state-hash";
// 測試專用：需要「權威 checksum 重算」才能造出「某個年齡 risk = 0」的合法死亡包。
// production 程式碼不會碰任何套件內部路徑（P3-E 架構隔離只掃 packages/*/src）。
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * P3-E.1b-1e：年度死亡判定轉接層。
 *
 * - fixture 全由真實驗證器產生；
 * - 「必死」「最低風險」的年齡在**測試執行時**從已凍結的 mortality fixture 掃出來，
 *   不硬編碼，因此 fixture 換了也會直接紅燈而不是默默改變語意。
 */

const SEED = "p3e-1b-1e-annual-death";
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

/** 在**任何年齡**都會開啟 decision 的事件（housing-choice 放寬年齡與人生階段）。 */
const packDeathDecision = repairedEventPack([
  {
    ...cloneEvent("ev.adult.housing-choice"),
    ageMin: 0,
    ageMax: 120,
    lifeStages: ["childhood", "adolescence", "adulthood", "later_life"]
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
/* 從已凍結的 mortality fixture 掃出關鍵年齡                            */
/* ------------------------------------------------------------------ */

interface MortalityRow {
  readonly entityId: string;
  readonly sex: string;
  readonly age: number;
  readonly hazardPpm: number;
}

const mortalityRows = (rawDeathDatasets.mortality as { records: MortalityRow[] }).records;
// 只挑 age >= 2 的年齡：state 會建在 age-1，避免落到 age 0 的 genesis 規則。
const entityRows = mortalityRows.filter((row) => row.entityId === ENTITY_ID && row.sex === SEX && row.age >= 2);

/** 保證死亡的年齡（hazardPpm = 1,000,000 ⇒ 任何 draw 都 < hazard）。 */
const alwaysDieAge = entityRows.find((row) => row.hazardPpm === 1_000_000)?.age;
/** 風險最低的年齡（存活測試用）。 */
const safestAge = entityRows.reduce((best, row) => (row.hazardPpm < best.hazardPpm ? row : best), entityRows[0] as MortalityRow)
  .age;

if (alwaysDieAge === undefined) throw new Error("test fixture: entity has no 100% hazard age");
if (alwaysDieAge > contracts.P3E_MAX_AGE) throw new Error("test fixture: unusable death age");
if (safestAge < 2) throw new Error("test fixture: safest age unusable");

/**
 * 「age 120 的 hazard = 0」的合法死亡包：讓 P3-D 在 120 歲**一定**活著，
 * 這樣才能穩定測 `age_ceiling`（真實 fixture 在 120 歲的 hazard 都 ≥ 960,000）。
 */
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
  readonly phase?: contracts.P3EPhase;
  readonly pendingDecision?: contracts.P3EPendingDecisionSummary | null;
  readonly stats?: contracts.P3EStats;
  readonly pack?: ValidatedEventPack;
  readonly occurrences?: readonly contracts.P3EEventOccurrence[];
  readonly deathDraws?: number;
  readonly eventDraws?: number;
  readonly deathPackOverride?: typeof deathPack;
}

function stateAt(age: number, options: StateOptions = {}): contracts.P3ELifeState {
  const phase = options.phase ?? (age >= contracts.P3E_MAX_AGE ? "death" : "life");
  const pack = options.pack ?? eventPack;
  const deathPackUsed = options.deathPackOverride ?? deathPack;
  const eventDraws = options.eventDraws ?? 2 * age;
  const deathDraws = options.deathDraws ?? 2 * age;
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
    occurrences: options.occurrences ?? (age === 0 ? [] : []),
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
  throw new Error("expected the call to throw");
}

function expectDeathError(run: () => unknown, code: string, path: string): void {
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

function deathInput(state: contracts.P3ELifeState, overrides: Dict = {}): Dict {
  return { state, eventPack, deathPack, contentMode: "guardian", ...overrides };
}

/** 存活用的 stats：最高健康（hazard 係數被壓到 0.1，幾乎不可能死）。 */
const SAFE_STATS: contracts.P3EStats = { health: 100, happiness: 55, knowledge: 40, relationships: 35 };
/** 必死用的 stats：健康 ≤ 50（hazard 係數 ≥ 1.0，base 1,000,000 一定死）。 */
const FRAIL_STATS: contracts.P3EStats = { health: 40, happiness: 55, knowledge: 40, relationships: 35 };

/* ------------------------------------------------------------------ */
/* 一、自然存活／自然死亡／age ceiling                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1e 死亡判定", () => {
  it("自然存活：diedThisYear=false、deathReason=null", () => {
    const state = stateAt(safestAge - 1, { pack: packNoCandidates, stats: SAFE_STATS });
    const result = resolveP3EAnnualDeath(deathInput(state, { eventPack: packNoCandidates }));

    expect(result.effects.selection.roll.ageAfter).toBe(safestAge);
    expect(result.mortality.age).toBe(safestAge);
    expect(result.mortality.died).toBe(false);
    expect(result.diedThisYear).toBe(false);
    expect(result.deathReason).toBeNull();
    expect(result.pendingDecisionAfterDeath).toBeNull();
    // 沒有死是因為 draw 沒有落在 hazard 內
    expect(BigInt(result.mortality.mortalityDraw) >= BigInt(result.mortality.adjustedHazardPpm)).toBe(true);
  });

  it("自然死亡：deathReason=mortality", () => {
    const state = stateAt((alwaysDieAge as number) - 1, { pack: packNoCandidates, stats: FRAIL_STATS });
    const result = resolveP3EAnnualDeath(deathInput(state, { eventPack: packNoCandidates }));

    expect(result.mortality.age).toBe(alwaysDieAge);
    expect(result.mortality.adjustedHazardPpm).toBe(1_000_000);
    expect(result.mortality.died).toBe(true);
    expect(result.diedThisYear).toBe(true);
    expect(result.deathReason).toBe("mortality");
    expect(result.mortality.causeId).not.toBeNull();
  });

  it("119 → 120 且 P3-D 未死亡：deathReason=age_ceiling", () => {
    const state = stateAt(contracts.P3E_MAX_AGE - 1, {
      pack: packNoCandidates,
      stats: SAFE_STATS,
      deathPackOverride: deathPackNoHazardAt120
    });
    const result = resolveP3EAnnualDeath(
      deathInput(state, { eventPack: packNoCandidates, deathPack: deathPackNoHazardAt120 })
    );

    expect(result.effects.selection.roll.ageAfter).toBe(120);
    expect(result.mortality.age).toBe(120);
    expect(result.mortality.adjustedHazardPpm).toBe(0);
    expect(result.mortality.died).toBe(false);
    expect(result.diedThisYear).toBe(true);
    expect(result.deathReason).toBe("age_ceiling");
  });

  it("120 歲仍實際執行 P3-D 並消耗死亡 RNG", () => {
    const state = stateAt(contracts.P3E_MAX_AGE - 1, {
      pack: packNoCandidates,
      stats: SAFE_STATS,
      deathPackOverride: deathPackNoHazardAt120
    });
    const result = resolveP3EAnnualDeath(
      deathInput(state, { eventPack: packNoCandidates, deathPack: deathPackNoHazardAt120 })
    );

    expect(result.u32DrawsUsed).toBeGreaterThanOrEqual(contracts.P3E_DEATH_DRAWS_ALIVE);
    expect(result.mortality.drawsUsed).toBe(result.u32DrawsUsed);
    expect(result.mortality.rngStateBefore).toEqual(state.rng.death.state);
    expect(result.deathRngAfter.state).toEqual(result.mortality.rngStateAfter);
    expect(result.deathRngAfter.state).not.toEqual(state.rng.death.state);
    expect(result.deathRngAfter.u32Draws).toBe(state.rng.death.u32Draws + result.u32DrawsUsed);
    // 死亡優先：即使高齡死亡，也不會有 pending decision
    expect(result.pendingDecisionAfterDeath).toBeNull();
  });

  it("死亡優先於 pending decision（死亡年度即使開決策也為 null）", () => {
    const state = stateAt((alwaysDieAge as number) - 1, { pack: packDeathDecision, stats: FRAIL_STATS });
    const result = resolveP3EAnnualDeath(deathInput(state, { eventPack: packDeathDecision }));

    expect(result.effects.selectedEventId).toBe("ev.adult.housing-choice");
    expect(result.effects.openedDecision).not.toBeNull();
    expect(result.diedThisYear).toBe(true);
    expect(result.pendingDecisionAfterDeath).toBeNull();
    // effects／occurrences 仍然保留
    expect(result.effects.occurrences.length).toBe(1);
  });

  it("未死亡的 decision 被保留為獨立凍結副本", () => {
    const state = stateAt(safestAge - 1, { pack: packDeathDecision, stats: SAFE_STATS });
    const result = resolveP3EAnnualDeath(deathInput(state, { eventPack: packDeathDecision }));

    expect(result.diedThisYear).toBe(false);
    expect(result.deathReason).toBeNull();
    expect(result.pendingDecisionAfterDeath).not.toBeNull();
    expect(result.pendingDecisionAfterDeath?.decisionId).toBe("dec.adult.housing");
    expect(result.pendingDecisionAfterDeath).not.toBe(result.effects.openedDecision);
    expect(result.pendingDecisionAfterDeath?.options).not.toBe(result.effects.openedDecision?.options);
    expect(isDeepFrozen(result.pendingDecisionAfterDeath)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 二、P3-D 的權威輸入                                                 */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1e P3-D 輸入", () => {
  it("entity／region／sex／age／year 全部來自 state 與 Roll 後值", () => {
    const state = stateAt(safestAge - 1, { pack: packNoCandidates, stats: SAFE_STATS });
    const result = resolveP3EAnnualDeath(deathInput(state, { eventPack: packNoCandidates }));
    const roll = result.effects.selection.roll;

    expect(result.mortality.entityId).toBe(state.identity.entityId);
    expect(result.mortality.regionCode).toBe(state.identity.regionCode);
    expect(result.mortality.sex).toBe(state.identity.sex);
    expect(result.mortality.age).toBe(roll.ageAfter);
    expect(result.mortality.calendarYear).toBe(roll.yearAfter);
    expect(result.mortality.deathPackId).toBe(deathPack.manifest.deathPackId);
    expect(result.mortality.deathPackChecksum).toBe(deathPack.packChecksum);
  });

  it("health 是 Effects 套用後的值（不是 Roll 後、Effects 前）", () => {
    const packHealth = repairedEventPack([
      {
        ...cloneEvent("ev.any.setback"),
        eventId: "ev.health-up",
        effects: [{ type: "stat", stat: "health", delta: 3 }]
      }
    ]);
    const state = stateAt(safestAge - 1, { pack: packHealth, stats: { ...SAFE_STATS, health: 90 } });
    const result = resolveP3EAnnualDeath(deathInput(state, { eventPack: packHealth }));

    const rollHealth = result.effects.selection.roll.statsAfter.health;
    expect(result.effects.stats.health).toBe(Math.min(100, rollHealth + 3));
    expect(result.mortality.health).toBe(result.effects.stats.health);
    expect(result.mortality.health).not.toBe(rollHealth);
  });
});

/* ------------------------------------------------------------------ */
/* 三、死亡 RNG 會計                                                   */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1e 死亡 RNG", () => {
  it("存活與死亡的真實 draws 與前後 tuple 都正確", () => {
    const aliveState = stateAt(safestAge - 1, { pack: packNoCandidates, stats: SAFE_STATS });
    const alive = resolveP3EAnnualDeath(deathInput(aliveState, { eventPack: packNoCandidates }));
    expect(alive.mortality.died).toBe(false);
    expect(alive.deathRngBefore).toEqual(aliveState.rng.death);
    expect(alive.deathRngBefore).not.toBe(aliveState.rng.death);
    expect(alive.deathRngBefore.initialState).toEqual(aliveState.rng.death.initialState);
    expect(alive.deathRngAfter.state).toEqual(advance(aliveState.rng.death.state, alive.u32DrawsUsed));
    expect(alive.u32DrawsUsed % 2).toBe(0);

    const deadState = stateAt((alwaysDieAge as number) - 1, { pack: packNoCandidates, stats: FRAIL_STATS });
    const dead = resolveP3EAnnualDeath(deathInput(deadState, { eventPack: packNoCandidates }));
    expect(dead.mortality.died).toBe(true);
    expect(dead.deathRngAfter.state).toEqual(advance(deadState.rng.death.state, dead.u32DrawsUsed));
    // 死亡比存活多一段 cause selection
    expect(dead.u32DrawsUsed).toBeGreaterThan(alive.u32DrawsUsed);
    expect(dead.deathRngAfter.u32Draws).toBe(deadState.rng.death.u32Draws + dead.u32DrawsUsed);
  });

  it("applyP3EDeathDraws 接受 2／4／6／512", () => {
    expect(applyP3EDeathDraws(0, 2, 1)).toBe(2);
    expect(applyP3EDeathDraws(2, 4, 1)).toBe(6);
    expect(applyP3EDeathDraws(4, 6, 2)).toBe(10);
    expect(applyP3EDeathDraws(0, 512, 1)).toBe(512);
    // 最大合法邊界
    expect(applyP3EDeathDraws(512 * 120 - 4, 4, 120)).toBe(512 * 120);
    expect(applyP3EDeathDraws(0, 512, 120)).toBe(512);
  });

  it("applyP3EDeathDraws 拒絕 0／奇數／負數／小數／NaN／Infinity／514／非法 age／總和超限", () => {
    const cases: readonly (readonly [string, number, number, number])[] = [
      ["drawsUsed 0", 0, 0, 30],
      ["drawsUsed 奇數", 0, 3, 30],
      ["drawsUsed 負數", 0, -2, 30],
      ["drawsUsed 小數", 0, 1.5, 30],
      ["drawsUsed NaN", 0, Number.NaN, 30],
      ["drawsUsed Infinity", 0, Number.POSITIVE_INFINITY, 30],
      ["drawsUsed 514", 0, 514, 30],
      ["before 負數", -2, 2, 30],
      ["before 奇數", 3, 2, 30],
      ["before 小數", 2.5, 2, 30],
      ["before NaN", Number.NaN, 2, 30],
      ["before 超過安全整數", Number.MAX_SAFE_INTEGER, 2, 120],
      ["ageAfter 0", 0, 2, 0],
      ["ageAfter 121", 0, 2, 121],
      ["ageAfter 小數", 0, 2, 1.5],
      ["ageAfter NaN", 0, 2, Number.NaN],
      ["總和超限", 512 * 120 - 2, 4, 120],
      ["總和非安全整數", Number.MAX_SAFE_INTEGER - 1, 4, 120]
    ];
    for (const [label, before, used, ageAfter] of cases) {
      const caught = caughtFrom(() => applyP3EDeathDraws(before, used, ageAfter));
      expect(isP3EError(caught), label).toBe(true);
      expect((caught as P3EError).code, label).toBe("E_P3E_RNG");
      expect((caught as P3EError).path, label).toBe("rng.death.u32Draws");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 四、錯誤折疊                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1e 錯誤", () => {
  it("P3-D 例外折成 E_P3E_DEATH at deathEvaluation", () => {
    const validInput = {
      entityId: ENTITY_ID,
      regionCode: genesisState.identity.regionCode,
      sex: SEX,
      age: 30,
      calendarYear: BIRTH_YEAR + 30,
      health: 60,
      rngState: DEATH_INITIAL
    };
    expect(evaluateP3EAnnualDeath(validInput, deathPack).age).toBe(30);
    // 非品牌 pack → P3-D 的 E_P3D_PACK 被折成固定 P3EError
    expectDeathError(
      () => evaluateP3EAnnualDeath(validInput, structuredClone(deathPack) as unknown as typeof deathPack),
      "E_P3E_DEATH",
      "deathEvaluation"
    );
    for (const value of [null, undefined, 42, {}, { ...validInput, age: 999 }]) {
      expectDeathError(() => evaluateP3EAnnualDeath(value, deathPack), "E_P3E_DEATH", "deathEvaluation");
    }
  });

  it("State／pack／event／effect 的既有錯誤原樣保留", () => {
    const broken = structuredClone(stateAt(30)) as unknown as Dict;
    broken.stateHash = HEX("0");
    expectDeathError(() => resolveP3EAnnualDeath(deathInput(broken as unknown as contracts.P3ELifeState)), "E_P3E_HASH", "stateHash");
    expectDeathError(
      () => resolveP3EAnnualDeath({ ...deathInput(stateAt(30)), eventPack: structuredClone(eventPack) }),
      "E_P3E_EVENT_PACK",
      "eventPack"
    );
    expectDeathError(
      () => resolveP3EAnnualDeath({ ...deathInput(stateAt(30)), contentMode: "hard" }),
      "E_P3E_EVENT",
      "contentMode"
    );
    const pending = stateAt(30, { phase: "pending_decision", pendingDecision: { year: BIRTH_YEAR + 30, age: 30, eventId: "ev.adult.housing-choice", decisionId: "dec.adult.housing", selectionHash: HEX("f"), optionIds: ["rent", "save"] } });
    expectDeathError(() => resolveP3EAnnualDeath(deathInput(pending)), "E_P3E_PHASE", "phase");
  });

  it("不接受呼叫端傳入的中間結果", () => {
    const withExtras = { ...deathInput(stateAt(30)), mortality: {}, effects: {} };
    expectDeathError(() => resolveP3EAnnualDeath(withExtras), "E_P3E_ARGUMENT", "input");
  });

  it("input shape：多／缺／改名／hidden／symbol／accessor／Proxy", () => {
    for (const key of ["state", "eventPack", "deathPack", "contentMode"]) {
      const missing = deathInput(stateAt(30));
      delete missing[key];
      expectDeathError(() => resolveP3EAnnualDeath(missing), "E_P3E_ARGUMENT", "input");
    }
    const renamed = deathInput(stateAt(30));
    delete renamed.contentMode;
    renamed.mode = "guardian";
    expectDeathError(() => resolveP3EAnnualDeath(renamed), "E_P3E_ARGUMENT", "input");

    const hidden = deathInput(stateAt(30));
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false, configurable: true });
    expectDeathError(() => resolveP3EAnnualDeath(hidden), "E_P3E_ARGUMENT", "input");

    const accessor: Dict = {};
    let invoked = false;
    for (const key of ["state", "eventPack", "deathPack"] as const) accessor[key] = deathInput(stateAt(30))[key];
    Object.defineProperty(accessor, "contentMode", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return "guardian";
      }
    });
    expectDeathError(() => resolveP3EAnnualDeath(accessor), "E_P3E_ARGUMENT", "input");
    expect(invoked).toBe(false);

    for (const value of [null, undefined, 42, [], [deathInput(stateAt(30))], Object.create({})]) {
      expectDeathError(() => resolveP3EAnnualDeath(value), "E_P3E_ARGUMENT", "input");
    }
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectDeathError(() => resolveP3EAnnualDeath(revoked.proxy), "E_P3E_ARGUMENT", "input");
  });
});

/* ------------------------------------------------------------------ */
/* 五、不可變與公開表面                                                */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1e 不可變與公開表面", () => {
  it("輸入不修改、結果深層凍結且零共享", () => {
    const state = stateAt((alwaysDieAge as number) - 1, { pack: packNoCandidates, stats: FRAIL_STATS });
    const before = encodeP3EState(state);
    const result = resolveP3EAnnualDeath(deathInput(state, { eventPack: packNoCandidates }));

    expect(encodeP3EState(state)).toBe(before);
    expect(isDeepFrozen(result)).toBe(true);
    expect(sharesReference(result, state)).toBe(false);
    expect(result.mortality.rngStateAfter).not.toBe(state.rng.death.state);
    expect(() => {
      (result as unknown as Dict).diedThisYear = false;
    }).toThrow(TypeError);
    expect(() => {
      (result.mortality as unknown as Dict).died = false;
    }).toThrow(TypeError);
    expect(() => {
      (result.deathRngAfter.state as unknown as number[])[0] = 1;
    }).toThrow(TypeError);
  });

  it("mortality 完整符合 P3DAnnualDeathResult（含 basePackId／basePackChecksum）", () => {
    const state = stateAt((alwaysDieAge as number) - 1, { pack: packNoCandidates, stats: FRAIL_STATS });
    const result = resolveP3EAnnualDeath(deathInput(state, { eventPack: packNoCandidates }));

    // 先前漏掉的兩個欄位
    expect(result.mortality.basePackId).toBe(deathPack.manifest.basePackId);
    expect(result.mortality.basePackChecksum).toBe(deathPack.manifest.basePackChecksum);
    expect(result.mortality.deathPackId).toBe(deathPack.manifest.deathPackId);
    expect(result.mortality.deathPackChecksum).toBe(deathPack.packChecksum);

    // runtime 欄位集合必須與正式契約完全一致（多一個少一個都算失敗）
    const CONTRACT_FIELDS = [
      "adjustedHazardPpm",
      "age",
      "baseHazardPpm",
      "basePackChecksum",
      "basePackId",
      "calendarYear",
      "causeId",
      "deathPackChecksum",
      "deathPackId",
      "deathSpecVersion",
      "died",
      "digest",
      "drawsUsed",
      "entityId",
      "health",
      "healthFactorPpm",
      "healthRuleVersion",
      "mortalityDraw",
      "regionClass",
      "regionCode",
      "rngStateAfter",
      "rngStateBefore",
      "sex"
    ];
    expect([...CONTRACT_FIELDS].sort()).toEqual(CONTRACT_FIELDS);
    expect(Object.keys(result.mortality).sort()).toEqual(CONTRACT_FIELDS);
    expect(Object.keys(result.mortality).length).toBe(23);
    // 深層凍結（含兩個 tuple）
    expect(isDeepFrozen(result.mortality)).toBe(true);
    expect(Object.isFrozen(result.mortality.rngStateBefore)).toBe(true);
    expect(Object.isFrozen(result.mortality.rngStateAfter)).toBe(true);
  });

  it("copyMortality 不得用型別斷言繞過完整性檢查（靜態檢查）", () => {
    const source = readFileSync(join(ROOT, "packages/simulation/src/annual-death.ts"), "utf8");
    expect(source).not.toContain("as P3DAnnualDeathResult");
    expect(source).toContain("satisfies P3DAnnualDeathResult");
    expect(source).toContain("basePackId: result.basePackId");
    expect(source).toContain("basePackChecksum: result.basePackChecksum");
    expect(source).toContain("return Object.freeze(copy);");
    // 也不得用雙重斷言繞過
    expect(source).not.toContain("as unknown as P3DAnnualDeathResult");
  });

  it("不建立 State、不 seal、不產生 ledger／command／chain 欄位", () => {
    const result = resolveP3EAnnualDeath(deathInput(stateAt(30)));
    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      "deathReason",
      "deathRngAfter",
      "deathRngBefore",
      "diedThisYear",
      "effects",
      "mortality",
      "pendingDecisionAfterDeath",
      "u32DrawsUsed"
    ]);
    for (const forbidden of ["stateHash", "identity", "heads", "commandLog", "packs", "phase", "chain", "ledger", "command"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("入口與兩個 seam 都不在公開 barrel", () => {
    expect(typeof resolveP3EAnnualDeath).toBe("function");
    expect(typeof evaluateP3EAnnualDeath).toBe("function");
    expect(typeof applyP3EDeathDraws).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.resolveP3EAnnualDeath).toBeUndefined();
    expect(surface.evaluateP3EAnnualDeath).toBeUndefined();
    expect(surface.applyP3EDeathDraws).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });
});
