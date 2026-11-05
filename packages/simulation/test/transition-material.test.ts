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
  validateEventPack,
  Xoshiro128StarStar,
  type ValidatedEventPack
} from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import { createP3EGenesis, sealP3EState } from "../src/genesis";
import { computeP3EStateHash } from "../src/state-hash";
import { P3EError, isP3EError } from "../src/errors";
import {
  resolveP3EAnnualPendingDecision,
  type P3EAnnualPendingDecisionStage
} from "../src/pending-decision-persistence";
import { resolveP3EDecisionChoice, type P3EDecisionChoiceStage } from "../src/decision-choice-effects";
import {
  assembleP3EAnnualStateCoreDraft,
  assembleP3EDecisionStateCoreDraft,
  type P3EStateCoreDraft
} from "../src/state-core-draft";
import {
  computeP3EDeltaHash,
  computeP3ESnapshotHash,
  computeP3EYearEntryHash
} from "../src/year-ledger-hash";
import { materializeP3ETransition, type P3ETransitionMaterial } from "../src/transition-material";
import * as barrel from "../src/index";
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * P3-E.1b-2f：Transition Hash Materialization。
 *
 * 所有期望值都用**正式原語獨立重算**（`computeP3ESnapshotHash`／`computeP3EDeltaHash`／
 * `computeP3EYearEntryHash`／`computeP3EStateHash`），不用被測函式自己的輸出當答案。
 * 四條正式流程都走真正的上游模組（pending-decision-persistence → state-core-draft）。
 */

const SEED = "p3e-1b-2f-transition-material";
const ROOT = process.cwd();
type Dict = Record<string, unknown>;
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const HEX = (char: string) => char.repeat(64);

/* -------------------------------- fixtures ------------------------- */

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

/** 任何年齡都會開啟 decision（housing-choice 放寬年齡與人生階段）。 */
const packDecision = repairedEventPack([
  {
    ...cloneEvent("ev.adult.housing-choice"),
    ageMin: 0,
    ageMax: 120,
    lifeStages: ["childhood", "adolescence", "adulthood", "later_life"]
  }
]);
/** 一般（非 decision）事件。 */
const packPlain = repairedEventPack([cloneEvent("ev.any.setback")]);
/** 沒有候選事件（`ev.child.first-word` 只適用 age 1–3）。 */
const packNoCandidates = repairedEventPack([cloneEvent("ev.child.first-word")]);

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
  eventPack: packDecision,
  deathPack
});
const BIRTH_YEAR = genesisState.identity.birthYear;
const ENTITY_ID = genesisState.identity.entityId;
const SEX = genesisState.identity.sex;

/** age 120 hazard = 0 的合法死亡包（讓 P3-D 在 120 歲一定活著 → age_ceiling）。 */
function deathPackWithZeroHazardAt(age: number): typeof deathPack {
  const manifest = structuredClone(rawDeathManifest);
  const datasets = structuredClone(rawDeathDatasets);
  const row = (datasets.mortality as { records: Dict[] }).records.find(
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
  manifest.licenses = structuredClone((datasets.licenses as { records: Dict[] }).records);
  manifest.lineage = structuredClone((datasets.lineage as { records: Dict[] }).records);
  manifest.packChecksum = computeDeathPackChecksum(manifest as never);
  return validateDeathPack({ manifest, datasets } as never, base);
}
const deathPackNoHazardAt120 = deathPackWithZeroHazardAt(contracts.P3E_MAX_AGE);

/* --------------------------- state builders ------------------------ */

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
  readonly pack?: ValidatedEventPack;
  readonly health?: number;
  readonly deathPackOverride?: typeof deathPack;
}

/** 任意 age 的合法 state（RNG 游標、收支公式、pack binding 全部自洽）。 */
function stateAt(age: number, options: StateOptions = {}): contracts.P3ELifeState {
  const pack = options.pack ?? eventPack;
  const death = options.deathPackOverride ?? deathPack;
  const bound = bindEventPack(pack);
  const years = BigInt(age);
  const eventInitial = toWords(deriveEventRngState(LIFE_INITIAL, BIRTH_YEAR));
  const draft = {
    ...genesisState,
    currentYear: BIRTH_YEAR + age,
    age,
    phase: age >= contracts.P3E_MAX_AGE ? ("death" as const) : ("life" as const),
    pendingDecision: null,
    stats: { health: options.health ?? 60, happiness: 55, knowledge: 40, relationships: 35 },
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
        schemaVersion: death.manifest.schemaVersion,
        deathDataVersion: death.manifest.deathDataVersion,
        deathSpecVersion: death.manifest.deathSpecVersion,
        healthRuleVersion: contracts.P3D_HEALTH_RULE_VERSION,
        engineVersion: death.manifest.engineVersion,
        rngSpecVersion: death.manifest.rngSpecVersion,
        deathPackId: death.manifest.deathPackId,
        deathPackChecksum: death.packChecksum,
        basePackId: death.manifest.basePackId,
        basePackChecksum: death.manifest.basePackChecksum,
        entityCount: death.manifest.entityCount
      }
    },
    flags: age === 0 ? [] : ["p3e:flag-a"],
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
  return sealP3EState(draft as never);
}

/** 由年度 stage 產生的「待決策」合法 state。 */
function pendingStateFromAnnual(
  previous: contracts.P3ELifeState,
  stage: P3EAnnualPendingDecisionStage
): contracts.P3ELifeState {
  const roll = stage.annualDeath.effects.selection.roll;
  return sealP3EState({
    ...previous,
    currentYear: roll.yearAfter,
    age: roll.ageAfter,
    phase: "pending_decision" as const,
    pendingDecision: stage.pendingDecisionSummary,
    stats: stage.annualDeath.effects.stats,
    assets: stage.annualDeath.effects.assets,
    flags: stage.annualDeath.effects.flags,
    occurrences: stage.annualDeath.effects.occurrences,
    rng: {
      life: roll.lifeRngAfter,
      events: stage.annualDeath.effects.selection.eventRngAfter,
      death: stage.annualDeath.deathRngAfter
    }
  } as never);
}

/* ------------------------------ 輔助 ------------------------------- */

function annualStage(
  state: contracts.P3ELifeState,
  pack: ValidatedEventPack,
  death: typeof deathPack = deathPack
): P3EAnnualPendingDecisionStage {
  return resolveP3EAnnualPendingDecision({ state, eventPack: pack, deathPack: death, contentMode: "standard" });
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
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

function expectP3EError(run: () => unknown, code: string, path: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(isP3EError(caught), `${code} at ${path}`).toBe(true);
  expect((caught as P3EError).code).toBe(code);
  expect((caught as P3EError).path).toBe(path);
  expect((caught as Error).message).toBe(`${code} at ${path}`);
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
}

/** 用正式原語獨立重算 snapshot／delta／entry，並與 material 比對。 */
function expectMaterialMatchesPrimitives(
  material: P3ETransitionMaterial,
  previous: contracts.P3ELifeState,
  draft: P3EStateCoreDraft
): void {
  const snapshotHash = computeP3ESnapshotHash({
    index: material.index,
    year: draft.currentYear,
    age: draft.age,
    phase: draft.phase,
    stats: draft.stats,
    assets: draft.assets,
    rng: draft.rng,
    flags: draft.flags,
    occurrences: draft.occurrences,
    pendingDecision: draft.pendingDecision
  });
  expect(material.snapshotHash).toBe(snapshotHash);

  const deltaHash = computeP3EDeltaHash({
    index: material.index,
    yearBefore: previous.currentYear,
    yearAfter: draft.currentYear,
    ageBefore: previous.age,
    ageAfter: draft.age,
    phaseBefore: previous.phase,
    phaseAfter: draft.phase,
    statsBefore: previous.stats,
    statsAfter: draft.stats,
    assetsBefore: previous.assets,
    assetsAfter: draft.assets,
    rngBefore: previous.rng,
    rngAfter: draft.rng,
    flagsBefore: previous.flags,
    flagsAfter: draft.flags,
    occurrencesBefore: previous.occurrences,
    occurrencesAfter: draft.occurrences,
    pendingDecisionBefore: previous.pendingDecision,
    pendingDecisionAfter: draft.pendingDecision
  });
  expect(material.deltaHash).toBe(deltaHash);

  const entryHash = computeP3EYearEntryHash({
    index: material.index,
    year: draft.currentYear,
    age: draft.age,
    phase: draft.phase,
    stateHashBefore: previous.stateHash,
    rngBefore: previous.rng,
    rngAfter: draft.rng,
    snapshotHash,
    deltaHash
  });
  expect(material.entryHash).toBe(entryHash);

  expect(material.headsForStateHash).toEqual({
    lastSnapshotHash: snapshotHash,
    lastDeltaHash: deltaHash,
    lastEntryHash: entryHash
  });
  expect(material.stateHashBefore).toBe(previous.stateHash);
  expect(material.index).toBe(previous.commandLog.count + 1);

  // stateHashAfter 必須使用新的三個鏈尾（且 hashChain／commandLog 皆不影響）
  const expectedAfter: Omit<contracts.P3ELifeState, "stateHash"> = {
    ...draft,
    heads: {
      lastSnapshotHash: snapshotHash,
      lastDeltaHash: deltaHash,
      lastEntryHash: entryHash,
      hashChain: previous.heads.hashChain
    },
    commandLog: previous.commandLog
  };
  expect(material.stateHashAfter).toBe(computeP3EStateHash(expectedAfter));
}

/* ------------------------- 一、四條正式流程 ------------------------ */

describe("P3-E.1b-2f 正式流程", () => {
  it("ADVANCE_YEAR → life", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const stage = annualStage(previous, packNoCandidates);
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    expect(draft.phase).toBe("life");

    const material = materializeP3ETransition(previous, draft);
    expectMaterialMatchesPrimitives(material, previous, draft);
    expect(material.index).toBe(previous.commandLog.count + 1);
    expect(Object.keys(material).sort()).toEqual([
      "deltaHash",
      "entryHash",
      "headsForStateHash",
      "index",
      "rngAfter",
      "rngBefore",
      "snapshotHash",
      "stateHashAfter",
      "stateHashBefore"
    ]);
  });

  it("ADVANCE_YEAR → pending_decision", () => {
    const previous = genesisState;
    const stage = annualStage(previous, packDecision);
    expect(stage.pendingDecisionSummary).not.toBeNull();
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    expect(draft.phase).toBe("pending_decision");

    const material = materializeP3ETransition(previous, draft);
    expectMaterialMatchesPrimitives(material, previous, draft);
    expect(material.index).toBe(previous.commandLog.count + 1);
  });

  it("ADVANCE_YEAR → death（mortality）", () => {
    const previous = stateAt(118, { pack: packPlain, health: 50 });
    const stage = annualStage(previous, packPlain);
    expect(stage.annualDeath.diedThisYear).toBe(true);
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    expect(draft.phase).toBe("death");

    const material = materializeP3ETransition(previous, draft);
    expectMaterialMatchesPrimitives(material, previous, draft);
  });

  it("ADVANCE_YEAR → death（age_ceiling）", () => {
    const previous = stateAt(contracts.P3E_MAX_AGE - 1, {
      pack: packPlain,
      deathPackOverride: deathPackNoHazardAt120
    });
    const stage = annualStage(previous, packPlain, deathPackNoHazardAt120);
    expect(stage.annualDeath.deathReason).toBe("age_ceiling");
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    const material = materializeP3ETransition(previous, draft);
    expectMaterialMatchesPrimitives(material, previous, draft);
  });

  it("CHOOSE_DECISION → life", () => {
    // age 0 受 genesis integrity 約束，所以用 age 5 建立起點；年度路徑推進到 age 6。
    const choicePrevious = stateAt(5, { pack: packDecision });
    const annual = annualStage(choicePrevious, packDecision);
    const pendingState = pendingStateFromAnnual(choicePrevious, annual);
    for (const optionId of ["rent", "save"]) {
      const stage: P3EDecisionChoiceStage = resolveP3EDecisionChoice({
        state: pendingState,
        eventPack: packDecision,
        deathPack,
        optionId
      });
      const draft = assembleP3EDecisionStateCoreDraft(pendingState, stage);
      expect(draft.phase).toBe("life");

      const material = materializeP3ETransition(pendingState, draft);
      expectMaterialMatchesPrimitives(material, pendingState, draft);
      expect(material.index).toBe(pendingState.commandLog.count + 1);
      // 決策不改變年度與年齡
      expect(draft.currentYear).toBe(pendingState.currentYear);
      expect(draft.age).toBe(pendingState.age);
    }
  });

  it("決策選項（rent）合法改動 annualExpenseMicroUsd → 成功 seal 且保留完整 delta", () => {
    const choicePrevious = stateAt(5, { pack: packDecision });
    const annual = annualStage(choicePrevious, packDecision);
    const pendingState = pendingStateFromAnnual(choicePrevious, annual);
    const stage = resolveP3EDecisionChoice({
      state: pendingState,
      eventPack: packDecision,
      deathPack,
      optionId: "rent"
    });
    const draft = assembleP3EDecisionStateCoreDraft(pendingState, stage);

    // rent 的效果是 annualExpenseMicroUsd +9,000,000（不是基準公式值）
    const baseExpense =
      contracts.P3E_EXPENSE_BASE_MICRO_USD + BigInt(pendingState.age) * contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD;
    expect(pendingState.assets.annualExpenseMicroUsd).toBe(baseExpense);
    expect(draft.assets.annualExpenseMicroUsd).toBe(baseExpense + 9_000_000n);
    expect(draft.assets.annualExpenseMicroUsd).not.toBe(baseExpense);

    const material = materializeP3ETransition(pendingState, draft);
    expectMaterialMatchesPrimitives(material, pendingState, draft);

    // material 的 snapshot／delta 確實吸收了 effect 後的數值（不是被改回基準）
    expect(
      material.snapshotHash ===
        computeP3ESnapshotHash({
          index: material.index,
          year: draft.currentYear,
          age: draft.age,
          phase: draft.phase,
          stats: draft.stats,
          assets: { ...draft.assets, annualExpenseMicroUsd: baseExpense },
          rng: draft.rng,
          flags: draft.flags,
          occurrences: draft.occurrences,
          pendingDecision: draft.pendingDecision
        })
    ).toBe(false);

    // 而且 draft 本身可以再被正式 Seal 一次（語意自洽）
    expect(() => sealP3EState({ ...draft, heads: { ...material.headsForStateHash, hashChain: pendingState.heads.hashChain }, commandLog: pendingState.commandLog } as never)).not.toThrow();
  });

  it("年度事件改動 annualIncomeMicroUsd → 成功 seal 且 draft／material 保留 effect 後數值", () => {
    const packIncomeEffect = repairedEventPack([
      {
        ...cloneEvent("ev.any.setback"),
        eventId: "ev.money.income-boost",
        effects: [{ type: "money", field: "annualIncomeMicroUsd", deltaMicroUsd: "5000000" }]
      }
    ]);
    const previous = stateAt(5, { pack: packIncomeEffect });
    const stage = annualStage(previous, packIncomeEffect);
    expect(stage.annualDeath.effects.selectedEventId).toBe("ev.money.income-boost");
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);

    const baseIncome =
      contracts.P3E_INCOME_BASE_MICRO_USD + BigInt(draft.age) * contracts.P3E_INCOME_PER_YEAR_MICRO_USD;
    expect(draft.assets.annualIncomeMicroUsd).toBe(baseIncome + 5_000_000n);

    const material = materializeP3ETransition(previous, draft);
    expectMaterialMatchesPrimitives(material, previous, draft);

    // effect 後的 income 確實進入 snapshot／delta（與基準值不同）
    const withBaseline = computeP3ESnapshotHash({
      index: material.index,
      year: draft.currentYear,
      age: draft.age,
      phase: draft.phase,
      stats: draft.stats,
      assets: { ...draft.assets, annualIncomeMicroUsd: baseIncome },
      rng: draft.rng,
      flags: draft.flags,
      occurrences: draft.occurrences,
      pendingDecision: draft.pendingDecision
    });
    expect(material.snapshotHash).not.toBe(withBaseline);
  });

  it("四條流程的 index 都遞增 1、stateHashBefore 都是 previous.stateHash", () => {
    const cases: [contracts.P3ELifeState, P3EStateCoreDraft][] = [];
    const lifePrevious = stateAt(5, { pack: packNoCandidates });
    cases.push([lifePrevious, assembleP3EAnnualStateCoreDraft(lifePrevious, annualStage(lifePrevious, packNoCandidates))]);
    cases.push([genesisState, assembleP3EAnnualStateCoreDraft(genesisState, annualStage(genesisState, packDecision))]);
    const deathPrevious = stateAt(118, { pack: packPlain, health: 50 });
    cases.push([deathPrevious, assembleP3EAnnualStateCoreDraft(deathPrevious, annualStage(deathPrevious, packPlain))]);

    for (const [previous, draft] of cases) {
      const material = materializeP3ETransition(previous, draft);
      expect(material.index).toBe(previous.commandLog.count + 1);
      expect(material.stateHashBefore).toBe(previous.stateHash);
      expect(material.stateHashAfter).not.toBe(previous.stateHash);
    }
  });

  it("輸入不修改；輸出遞迴凍結、零共享", () => {
    const previous = genesisState;
    const stage = annualStage(previous, packDecision);
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);

    const previousBefore = stable(previous);
    const draftBefore = stable(draft);
    const material = materializeP3ETransition(previous, draft);

    expect(stable(previous)).toBe(previousBefore);
    expect(stable(draft)).toBe(draftBefore);
    expect(isDeepFrozen(material)).toBe(true);
    expect(sharesReference(material, previous)).toBe(false);
    expect(sharesReference(material, draft)).toBe(false);
    expect(material.rngBefore).not.toBe(previous.rng);
    expect(material.rngAfter).not.toBe(draft.rng);
    expect(Object.isFrozen(material.headsForStateHash)).toBe(true);
    expect(() => {
      (material as { index: number }).index = 99;
    }).toThrow(TypeError);
    expect(() => {
      (material.headsForStateHash as { lastEntryHash: string }).lastEntryHash = HEX("0");
    }).toThrow(TypeError);
    expect(() => {
      (material.rngBefore.life.state as unknown as number[])[0] = 0;
    }).toThrow(TypeError);
  });

  it("重複執行結果完全一致", () => {
    const previous = genesisState;
    const draft = assembleP3EAnnualStateCoreDraft(previous, annualStage(previous, packDecision));
    const first = materializeP3ETransition(previous, draft);
    for (let round = 0; round < 20; round += 1) {
      expect(materializeP3ETransition(previous, draft)).toEqual(first);
    }
  });
});

/* ------------------------- 二、循環依賴防線 ------------------------ */

describe("P3-E.1b-2f 循環依賴防線", () => {
  const previous = genesisState;
  const draft = assembleP3EAnnualStateCoreDraft(previous, annualStage(previous, packDecision));
  const material = materializeP3ETransition(previous, draft);

  it("stateHashAfter 納入新的三個鏈尾（用舊 heads 算不出來）", () => {
    const oldHeadsState: Omit<contracts.P3ELifeState, "stateHash"> = {
      ...draft,
      heads: previous.heads,
      commandLog: previous.commandLog
    };
    const withOldHeads = computeP3EStateHash(oldHeadsState);
    expect(withOldHeads).not.toBe(material.stateHashAfter);

    const newHeadsState: Omit<contracts.P3ELifeState, "stateHash"> = {
      ...draft,
      heads: { ...material.headsForStateHash, hashChain: previous.heads.hashChain },
      commandLog: previous.commandLog
    };
    const withNewHeads = computeP3EStateHash(newHeadsState);
    expect(withNewHeads).toBe(material.stateHashAfter);
  });

  it("改變 hashChain／commandLog 都不改變 stateHashAfter", () => {
    const variants = [
      { hashChain: HEX("0"), commandLog: previous.commandLog },
      { hashChain: previous.heads.hashChain, commandLog: { count: 1, headHash: HEX("1") } },
      { hashChain: HEX("f"), commandLog: { count: 4096, headHash: HEX("f") } }
    ];
    for (const variant of variants) {
      const variantState: Omit<contracts.P3ELifeState, "stateHash"> = {
        ...draft,
        heads: { ...material.headsForStateHash, hashChain: variant.hashChain },
        commandLog: variant.commandLog
      };
      const hash = computeP3EStateHash(variantState);
      expect(hash).toBe(material.stateHashAfter);
    }
  });

  it("stateHashAfter 排除 commandLog（有 commandLog 與沒有 commandLog 的最小輸入同值）", () => {
    const minimal = {
      ...draft,
      heads: material.headsForStateHash
    };
    expect(computeP3EStateHash(minimal as never)).toBe(material.stateHashAfter);
  });

  it("沒有假的 commandHash／chainHash／零值 placeholder", () => {
    const keys: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      for (const key of Object.keys(value as Dict)) {
        keys.push(key);
        collect((value as Dict)[key]);
      }
    };
    collect(material);
    for (const forbidden of ["commandHash", "chainHash", "commandRecord", "chainRecord", "append"]) {
      expect(keys).not.toContain(forbidden);
    }
    const zeros = "0".repeat(64);
    for (const hash of [
      material.stateHashBefore,
      material.stateHashAfter,
      material.snapshotHash,
      material.deltaHash,
      material.entryHash
    ]) {
      expect(hash).not.toBe(zeros);
    }
  });
});

/* ----------------------------- 三、反例 ---------------------------- */

describe("P3-E.1b-2f 反例", () => {
  const previous = genesisState;
  const draft = assembleP3EAnnualStateCoreDraft(previous, annualStage(previous, packDecision));

  it("previousState.stateHash 被竄改 → E_P3E_HASH at stateHash", () => {
    const broken = { ...previous, stateHash: HEX("0") };
    expectP3EError(() => materializeP3ETransition(broken as never, draft), "E_P3E_HASH", "stateHash");
  });

  it("previousState shape 不合法 → E_P3E_STATE at state", () => {
    const broken = structuredClone(previous) as unknown as Dict;
    delete broken.flags;
    expectP3EError(() => materializeP3ETransition(broken as never, draft), "E_P3E_STATE", "state");
  });

  it("previousState invariant 不合法（phase=pending_decision 但沒有摘要）→ E_P3E_DECISION at pendingDecision", () => {
    // seal 會先驗證，所以用正式 hash 函式「手工封存」一個語意不合法的 state
    // （age 0 只能是 life，因此用 age 5 才測得到 pendingDecision 的不一致）
    const older = stateAt(5, { pack: packNoCandidates });
    const shapeOnly = { ...older, phase: "pending_decision" as const, pendingDecision: null };
    const tampered = { ...shapeOnly, stateHash: computeP3EStateHash(shapeOnly as never) };
    expectP3EError(() => materializeP3ETransition(tampered as never, draft), "E_P3E_DECISION", "pendingDecision");
  });

  it("commandLog.count 已達正式上限 → E_P3E_HISTORY at transitionMaterial.index", () => {
    const older = stateAt(5, { pack: packNoCandidates });
    const atLimit = sealP3EState({
      ...older,
      commandLog: { count: contracts.P3E_MAX_COMMANDS, headHash: HEX("e") }
    } as never);
    expect(atLimit.commandLog.count).toBe(contracts.P3E_MAX_COMMANDS);
    const olderDraft = assembleP3EAnnualStateCoreDraft(older, annualStage(older, packNoCandidates));
    expectP3EError(
      () => materializeP3ETransition(atLimit, olderDraft),
      "E_P3E_HISTORY",
      "transitionMaterial.index"
    );
    // 對照：少 1 就可以正常產出材料
    const belowLimit = sealP3EState({
      ...older,
      commandLog: { count: contracts.P3E_MAX_COMMANDS - 1, headHash: HEX("e") }
    } as never);
    const material = materializeP3ETransition(belowLimit, olderDraft);
    expect(material.index).toBe(contracts.P3E_MAX_COMMANDS);
  });

  it("draft 的 phase 與 pendingDecision 不一致 → E_P3E_PHASE at phase", () => {
    const broken = { ...draft, phase: "life" as const };
    expectP3EError(() => materializeP3ETransition(previous, broken as never), "E_P3E_PHASE", "phase");
  });

  it("draft 的年齡超出範圍 → E_P3E_STATE at age", () => {
    const broken = { ...draft, age: contracts.P3E_MAX_AGE + 1 };
    expectP3EError(() => materializeP3ETransition(previous, broken as never), "E_P3E_STATE", "age");
  });

  it("draft 的 stats 超出範圍 → E_P3E_STATE at stats.health", () => {
    const broken = { ...draft, stats: { ...draft.stats, health: contracts.P3E_STAT_MIN - 1 } };
    expectP3EError(() => materializeP3ETransition(previous, broken as never), "E_P3E_STATE", "stats.health");
  });

  it("draft 內部拋出的 P3EError 原樣往外傳（不被重包）", () => {
    const withThrowingGetter = { ...draft } as Dict;
    Object.defineProperty(withThrowingGetter, "stats", {
      enumerable: true,
      configurable: true,
      get() {
        throw new P3EError("E_P3E_STATE", "draft.probe");
      }
    });
    expectP3EError(
      () => materializeP3ETransition(previous, withThrowingGetter as never),
      "E_P3E_STATE",
      "draft.probe"
    );
  });

  it("draft 根本無法 canonical 編碼 → 折成 E_P3E_STATE at transitionMaterial.draft", () => {
    const broken = { ...draft, rng: undefined };
    expectP3EError(() => materializeP3ETransition(previous, broken as never), "E_P3E_STATE", "transitionMaterial.draft");
  });

  it("Snapshot／Delta／Entry 的權威欄位一變，對應 hash 就變", () => {
    const base = materializeP3ETransition(previous, draft);
    const mutations: readonly [string, P3EStateCoreDraft][] = [
      ["stats", { ...draft, stats: { ...draft.stats, happiness: draft.stats.happiness - 1 } }],
      ["assets", { ...draft, assets: { ...draft.assets, balanceMicroUsd: draft.assets.balanceMicroUsd + 1n } }],
      ["flags", { ...draft, flags: [...draft.flags, "p3e:flag-z"] }],
      ["occurrences", { ...draft, occurrences: [{ eventId: "ev.test.custom", count: 1, lastYear: draft.currentYear }] }],
      ["pendingDecision-alternative", { ...draft, pendingDecision: { ...draft.pendingDecision!, selectionHash: HEX("1") } }]
    ];
    for (const [label, mutated] of mutations) {
      const material = materializeP3ETransition(previous, mutated as never);
      expect(material.snapshotHash, label).not.toBe(base.snapshotHash);
      expect(material.deltaHash, label).not.toBe(base.deltaHash);
      expect(material.entryHash, label).not.toBe(base.entryHash);
      expect(material.stateHashAfter, label).not.toBe(base.stateHashAfter);
    }
  });
});

/* --------------------- 四、公開表面與靜態檢查 ---------------------- */

describe("P3-E.1b-2f 公開表面與靜態檢查", () => {
  const source = readFileSync(join(ROOT, "packages/simulation/src/transition-material.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

  it("不進公開 barrel", () => {
    expect(typeof materializeP3ETransition).toBe("function");
    const surface = barrel as unknown as Record<string, unknown>;
    expect(surface.materializeP3ETransition).toBeUndefined();
    const barrelSource = readFileSync(join(ROOT, "packages/simulation/src/index.ts"), "utf8");
    expect(barrelSource).not.toContain("transition-material");
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("重用正式原語，沒有重寫任何演算法", () => {
    for (const primitive of [
      "readP3EState",
      "sealP3EState",
      "computeP3ESnapshotHash",
      "computeP3EDeltaHash",
      "computeP3EYearEntryHash"
    ]) {
      expect(code, primitive).toContain(primitive);
    }
    for (const forbidden of [
      "computeP3EStateHash",
      "canonicalBytes",
      "sha256Hex",
      "clamp",
      "Math.min(",
      "Math.max(",
      "P3E_STAT_MIN",
      "P3E_STAT_MAX",
      "occurrencesBefore.map",
      "append",
      "replay",
      "codec",
      "commandHash",
      "chainHash",
      "JSON.stringify",
      "Math.random",
      "Date.now"
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("不建立 Command Record／Year Ledger Record／最終 State", () => {
    const previous = genesisState;
    const draft = assembleP3EAnnualStateCoreDraft(previous, annualStage(previous, packDecision));
    const material = materializeP3ETransition(previous, draft);
    // 回傳只有九欄，沒有 State 的必要欄位
    for (const forbidden of ["stateHash", "identity", "packs", "heads", "commandLog", "stats", "assets", "flags", "occurrences", "pendingDecision", "phase"]) {
      expect(Object.keys(material)).not.toContain(forbidden);
    }
  });
});
