import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPeerGroup, createBirthCertificate, validateDataPack, validateDeathPack, validateIdentityPack } from "@life-sim/birth";
import { bindEventPack, computeEventsChecksum, computePackChecksum, deriveEventRngState, validateEventPack, Xoshiro128StarStar, type ValidatedEventPack } from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import { createP3EGenesis } from "../src/genesis";
import { computeP3EStateHash } from "../src/state-hash";
import { isP3EError } from "../src/errors";
import { resolveP3EAnnualPendingDecision, type P3EAnnualPendingDecisionStage } from "../src/pending-decision-persistence";
import { resolveP3EDecisionChoice, type P3EDecisionChoiceStage } from "../src/decision-choice-effects";
import {
  assembleP3EAnnualStateCoreDraft,
  assembleP3EDecisionStateCoreDraft,
  type P3EStateCoreDraft
} from "../src/state-core-draft";
import * as barrel from "../src/index";
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * P3-E State Core Draft 正式測試（H5-CTO-135-A 整合）。
 *
 * 來源：WorkBuddy 候選 `state-core-draft-v11-candidate.test.ts`
 * （SHA-256 `ca16c7323a490d8bb43b90959d5b33f307fbf83c328beaec8004516236b3a30d`，
 * 經 H5-CTO-127-B／H5-CTO-135-A 核准）。正式化只改：import／讀取原始碼路徑、
 * `candidate` 字樣、barrel 的檔案名斷言；**56 項測試全部保留**。
 *
 * 涵蓋 V1（H5-CTO-118-B）的**全部行為測試**，以及三處信任邊界的反例：
 *
 * 1. RNG domain 完整性（previous／before／after 三段 × life／events／death）；
 * 2. Pending 摘要與完整事實（`pendingDecisionAfterDeath`）的交叉比對；
 * 3. Decision 的 `selectedOptionId` 必須屬於 previous 摘要的 `optionIds`。
 */

const SEED = "p3e-127-state-core-draft-v11";
const ROOT = process.cwd();
type Dict = Record<string, unknown>;
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const CORE_DRAFT_SRC = readFileSync(join(ROOT, "packages/simulation/src/state-core-draft.ts"), "utf8");
/** 去掉註解，只留下真正的程式碼（避免文件敘述被誤判成呼叫）。 */
const CORE_DRAFT_CODE = CORE_DRAFT_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

/* -------------------------------- fixtures ------------------------- */

const base = validateDataPack({
  manifest: readJson("fixtures/p2a/manifest.v1.json"),
  datasets: {
    "country-registry": readJson("fixtures/p2a/country-registry.v1.json"), indicators: readJson("fixtures/p2a/indicators.v1.json"),
    "birth-weights": readJson("fixtures/p2a/birth-weights.v1.json"), "sensitive-names": readJson("fixtures/p2a/sensitive-names.v1.json"),
    licenses: readJson("fixtures/p2a/licenses.v1.json"), lineage: readJson("fixtures/p2a/lineage.v1.json")
  }
} as never);

const identityPack = validateIdentityPack(base, {
  manifest: readJson("fixtures/p2b/manifest.v1.json"),
  datasets: {
    "country-vitals": readJson("fixtures/p2b/country-vitals.v1.json"), "household-profiles": readJson("fixtures/p2b/household-profiles.v1.json"),
    "name-corpus": readJson("fixtures/p2b/name-corpus.v1.json"), "story-templates": readJson("fixtures/p2b/story-templates.v1.json"),
    licenses: readJson("fixtures/p2b/licenses.v1.json"), lineage: readJson("fixtures/p2b/lineage.v1.json")
  }
} as never);

const rawEventManifest = readJson("fixtures/p3b/manifest.v1.json") as Dict;
const rawEvents = (readJson("fixtures/p3b/events.v1.json") as { records: Dict[] }).records;
const rawDeathManifest = readJson("fixtures/p3d/manifest.v1.json") as Dict;
const rawDeathDatasets: Dict = {
  "cause-registry": readJson("fixtures/p3d/cause-registry.v1.json"), "cause-weights": readJson("fixtures/p3d/cause-weights.v1.json"),
  mortality: readJson("fixtures/p3d/mortality.v1.json"),
  licenses: readJson("fixtures/p3d/licenses.v1.json"), lineage: readJson("fixtures/p3d/lineage.v1.json")
};
const eventPack: ValidatedEventPack = validateEventPack({ manifest: rawEventManifest, events: rawEvents } as never);
const deathPack = validateDeathPack({ manifest: rawDeathManifest, datasets: rawDeathDatasets } as never, base);

/** 重算 checksum／license／lineage 的合法事件包。 */
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

/** 任何年齡都會開啟 decision 的事件（housing-choice 放寬年齡與人生階段）。 */
const packDecision = repairedEventPack([
  {
    ...cloneEvent("ev.adult.housing-choice"),
    ageMin: 0,
    ageMax: 120,
    lifeStages: ["childhood", "adolescence", "adulthood", "later_life"]
  }
]);
/** 一般（非 decision）事件：stat ＋ money effects。 */
const packPlain = repairedEventPack([cloneEvent("ev.any.setback")]);
/** 有 flag effect 的事件。 */
const packFlag = repairedEventPack([cloneEvent("ev.child.sibling-arrives")]);
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
}function advance(initial: readonly [number, number, number, number], draws: number): [number, number, number, number] {
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
    phase: age >= contracts.P3E_MAX_AGE ? "death" : "life",
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
        eventSchemaVersion: bound.eventSchemaVersion, eventSpecVersion: bound.eventSpecVersion,
        contentPackVersion: bound.contentPackVersion, eventPackId: bound.eventPackId,
        eventPackChecksum: bound.eventPackChecksum, datasetChecksum: bound.datasetChecksum,
        eventCount: bound.eventCount
      },
      death: {
        schemaVersion: death.manifest.schemaVersion, deathDataVersion: death.manifest.deathDataVersion,
        deathSpecVersion: death.manifest.deathSpecVersion, healthRuleVersion: contracts.P3D_HEALTH_RULE_VERSION,
        engineVersion: death.manifest.engineVersion, rngSpecVersion: death.manifest.rngSpecVersion,
        deathPackId: death.manifest.deathPackId, deathPackChecksum: death.packChecksum,
        basePackId: death.manifest.basePackId, basePackChecksum: death.manifest.basePackChecksum,
        entityCount: death.manifest.entityCount
      }
    },
    flags: age === 0 ? [] : ["p3e:flag-a"],
    occurrences: [],
    rng: {
      life: {
        domain: "life" as const, initialState: LIFE_INITIAL, state: lifeCursorAt(age),
        semanticDraws: contracts.P3E_GENESIS_SEMANTIC_DRAWS + contracts.P3E_ROLL_SEMANTIC_DRAWS * age
      },
      events: {
        domain: "events" as const, initialState: eventInitial,
        state: advance(eventInitial, 2 * age), u32Draws: 2 * age
      },
      death: {
        domain: "p3e/death" as const, initialState: DEATH_INITIAL,
        state: advance(DEATH_INITIAL, 2 * age), u32Draws: 2 * age
      }
    }
  };
  return { ...draft, stateHash: computeP3EStateHash(draft as never) } as contracts.P3ELifeState;
}

/** 由年度 stage 產生的「待決策」合法 state（重新封存 stateHash）。 */
function pendingStateFromAnnual(
  previous: contracts.P3ELifeState,
  stage: P3EAnnualPendingDecisionStage
): contracts.P3ELifeState {
  const roll = stage.annualDeath.effects.selection.roll;
  const draft = {
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
  };
  return { ...draft, stateHash: computeP3EStateHash(draft as never) } as contracts.P3ELifeState;
}

/* ------------------------------ 輔助 ------------------------------- */

function annualStage(
  state: contracts.P3ELifeState,
  pack: ValidatedEventPack,
  death: typeof deathPack = deathPack
): P3EAnnualPendingDecisionStage {
  return resolveP3EAnnualPendingDecision({ state, eventPack: pack, deathPack: death, contentMode: "standard" });
}

function expectCoreDraftError(run: () => unknown, code: string, path: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(isP3EError(caught), `${code} at ${path}`).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
  expect((caught as { path: string }).path).toBe(path);
  expect((caught as Error).message).toBe(`${code} at ${path}`);
}

/** 以路徑覆寫深層欄位（測試用；不修改原始 stage）。 */
function patch(source: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const record = { ...(source as Dict) };
  const head = path[0] as string;
  record[head] = patch(record[head], path.slice(1), value);
  return record;
}

/** 穩定序列化（bigint → 字串），用來比對輸入是否被修改。 */
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

function collectKeys(value: unknown, into: string[] = []): string[] {
  if (typeof value !== "object" || value === null) return into;
  for (const key of Object.keys(value as Dict)) {
    into.push(key);
    collectKeys((value as Dict)[key], into);
  }
  return into;
}

const DRAFT_KEYS = [
  "schemaVersion", "rulesetVersion", "rollSpecVersion", "lifeSpecVersion", "contentVersion",
  "saveFormatVersion", "engineVersion", "rngSpecVersion", "identity", "packs", "currentYear",
  "age", "phase", "pendingDecision", "stats", "assets", "flags", "occurrences", "rng"
];
const FORBIDDEN_METADATA = [
  "heads", "commandLog", "stateHash", "snapshotHash", "deltaHash", "entryHash", "commandHash", "chainHash"
];

/* ---------------------------- 一、年度路徑 --------------------------- */

describe("H5-CTO-127-B 年度路徑（V1 行為保留）", () => {
  it("life：無事件時 phase=life、pending 為 null", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const stage = annualStage(previous, packNoCandidates);
    expect(stage.annualDeath.effects.selectedEventId).toBeNull();
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    expect(draft.phase).toBe("life");
    expect(draft.pendingDecision).toBeNull();
    expect(draft.currentYear).toBe(BIRTH_YEAR + 6);
    expect(draft.age).toBe(6);
  });

  it("pending_decision：事件開啟 decision 時 phase=pending_decision、摘要六欄保持", () => {
    const previous = genesisState;
    const stage = annualStage(previous, packDecision);
    expect(stage.pendingDecisionSummary).not.toBeNull();
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    expect(draft.phase).toBe("pending_decision");
    expect(Object.keys(draft.pendingDecision ?? {})).toEqual([
      "year", "age", "eventId", "decisionId", "selectionHash", "optionIds"
    ]);
    expect(draft.pendingDecision?.eventId).toBe("ev.adult.housing-choice");
    expect(draft.pendingDecision?.decisionId).toBe("dec.adult.housing");
    expect(draft.pendingDecision?.optionIds).toEqual(["rent", "save"]);
    expect(draft.pendingDecision?.year).toBe(stage.pendingDecisionSummary?.year);
    expect(draft.pendingDecision?.age).toBe(stage.pendingDecisionSummary?.age);
    expect(draft.pendingDecision?.selectionHash).toBe(stage.pendingDecisionSummary?.selectionHash);
  });

  it("mortality 死亡：phase=death、pending 被壓制為 null", () => {
    const previous = stateAt(118, { pack: packPlain, health: 50 });
    const stage = annualStage(previous, packPlain);
    expect(stage.annualDeath.diedThisYear).toBe(true);
    expect(stage.annualDeath.deathReason).toBe("mortality");
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    expect(draft.phase).toBe("death");
    expect(draft.pendingDecision).toBeNull();
  });

  it("age_ceiling 死亡：120 歲且 P3-D 未死亡時 phase=death", () => {
    const previous = stateAt(contracts.P3E_MAX_AGE - 1, {
      pack: packPlain,
      deathPackOverride: deathPackNoHazardAt120
    });
    const stage = annualStage(previous, packPlain, deathPackNoHazardAt120);
    expect(stage.annualDeath.diedThisYear).toBe(true);
    expect(stage.annualDeath.deathReason).toBe("age_ceiling");
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    expect(draft.phase).toBe("death");
    expect(draft.age).toBe(contracts.P3E_MAX_AGE);
    expect(draft.pendingDecision).toBeNull();
  });

  it("事件 effects 後的 stats／assets／flags／occurrences 一律取自 stage", () => {
    const previous = stateAt(5, { pack: packFlag });
    const stage = annualStage(previous, packFlag);
    const effects = stage.annualDeath.effects;
    expect(effects.selectedEventId).toBe("ev.child.sibling-arrives");
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    expect(draft.stats).toEqual(effects.stats);
    expect(draft.assets).toEqual(effects.assets);
    expect(draft.flags).toEqual(effects.flags);
    expect(draft.occurrences).toEqual(effects.occurrences);
    expect(draft.flags).toContain("family:sibling");
    expect(draft.occurrences).toHaveLength(1);
    expect(draft.occurrences[0]?.eventId).toBe("ev.child.sibling-arrives");
    expect(draft.stats.relationships).not.toBe(effects.selection.roll.statsAfter.relationships);
  });

  it("三條 RNG 精確映射到 stage 的 after 游標", () => {
    const previous = stateAt(5, { pack: packPlain });
    const stage = annualStage(previous, packPlain);
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    expect(draft.rng.life).toEqual(stage.annualDeath.effects.selection.roll.lifeRngAfter);
    expect(draft.rng.events).toEqual(stage.annualDeath.effects.selection.eventRngAfter);
    expect(draft.rng.death).toEqual(stage.annualDeath.deathRngAfter);
    expect(draft.rng.life.semanticDraws).toBe(previous.rng.life.semanticDraws + 4);
    expect(draft.rng.events.u32Draws).toBe(
      previous.rng.events.u32Draws + stage.annualDeath.effects.selection.u32DrawsUsed
    );
    expect(draft.rng.death.u32Draws).toBe(previous.rng.death.u32Draws + stage.annualDeath.u32DrawsUsed);
  });

  it("反例：Roll 後 year／age 與 stage 不一致", () => {
    const previous = stateAt(5, { pack: packPlain });
    const stage = annualStage(previous, packPlain);
    const broken = patch(stage, ["annualDeath", "effects", "selection", "roll", "ageAfter"], 7) as never;
    expectCoreDraftError(() => assembleP3EAnnualStateCoreDraft(previous, broken), "E_P3E_STATE", "stateCoreDraft.annual.roll");
  });

  const V1_ANNUAL_BREAK_CASES: readonly (readonly [string, readonly string[], unknown, string, string])[] = [
    ["life RNG 的 before 游標與 previous 不一致", ["annualDeath", "effects", "selection", "roll", "lifeRngBefore", "state"], [99, 98, 97, 96], "E_P3E_RNG", "stateCoreDraft.annual.rng.life"],
    ["life RNG 的 after 抽樣數不銜接", ["annualDeath", "effects", "selection", "roll", "lifeRngAfter", "semanticDraws"], 999, "E_P3E_RNG", "stateCoreDraft.annual.rng.life"],
    ["event RNG 鏈不銜接", ["annualDeath", "effects", "selection", "eventRngAfter", "u32Draws"], 4242, "E_P3E_RNG", "stateCoreDraft.annual.rng.events"],
    ["death RNG 鏈不銜接", ["annualDeath", "deathRngAfter", "u32Draws"], 777, "E_P3E_RNG", "stateCoreDraft.annual.rng.death"]
  ];

  it.each(V1_ANNUAL_BREAK_CASES)("反例：%s", (_name, path, value, code, expected) => {
    const previous = stateAt(5, { pack: packPlain });
    const stage = annualStage(previous, packPlain);
    const broken = patch(stage, path, value) as never;
    expectCoreDraftError(() => assembleP3EAnnualStateCoreDraft(previous, broken), code, expected);
  });

  it("反例：死亡年度卻帶著 pending 摘要", () => {
    const previous = stateAt(118, { pack: packPlain, health: 50 });
    const stage = annualStage(previous, packPlain);
    expect(stage.pendingDecisionSummary).toBeNull();
    const broken = patch(stage, ["pendingDecisionSummary"], {
      year: 2101,
      age: 119,
      eventId: "ev.adult.housing-choice",
      decisionId: "dec.adult.housing",
      selectionHash: "b".repeat(64),
      optionIds: ["rent", "save"]
    }) as never;
    expectCoreDraftError(() => assembleP3EAnnualStateCoreDraft(previous, broken), "E_P3E_STATE", "stateCoreDraft.annual.pendingDecision");
  });

  const V1_PENDING_BREAK_CASES: readonly (readonly [string, readonly string[], unknown])[] = [
    ["未死亡但摘要的 year 不等於 Roll 後值", ["pendingDecisionSummary", "year"], 1999],
    ["未死亡但摘要的 age 不等於 Roll 後值", ["pendingDecisionSummary", "age"], 9]
  ];

  it.each(V1_PENDING_BREAK_CASES)("反例：%s", (_name, path, value) => {
    const previous = genesisState;
    const stage = annualStage(previous, packDecision);
    const broken = patch(stage, path, value) as never;
    expectCoreDraftError(() => assembleP3EAnnualStateCoreDraft(previous, broken), "E_P3E_STATE", "stateCoreDraft.annual.pendingDecision");
  });
});

/* ------------------------- 二、RNG domain 反例 ------------------------ */

type DomainCase = readonly [name: string, on: "previous" | "stage", path: readonly string[], expected: string];

const RNG_DOMAIN_CASES: readonly DomainCase[] = [
  ["life：previous 的 domain 不等於 P3E_LIFE_DOMAIN", "previous", ["rng", "life", "domain"], "stateCoreDraft.annual.rng.life"],
  ["life：before 的 domain 與 previous 不一致", "stage", ["annualDeath", "effects", "selection", "roll", "lifeRngBefore", "domain"], "stateCoreDraft.annual.rng.life"],
  ["life：after 的 domain 與 before 不一致", "stage", ["annualDeath", "effects", "selection", "roll", "lifeRngAfter", "domain"], "stateCoreDraft.annual.rng.life"],
  ["events：previous 的 domain 不等於 P3E_EVENT_DOMAIN", "previous", ["rng", "events", "domain"], "stateCoreDraft.annual.rng.events"],
  ["events：before 的 domain 與 previous 不一致", "stage", ["annualDeath", "effects", "selection", "eventRngBefore", "domain"], "stateCoreDraft.annual.rng.events"],
  ["events：after 的 domain 與 before 不一致", "stage", ["annualDeath", "effects", "selection", "eventRngAfter", "domain"], "stateCoreDraft.annual.rng.events"],
  ["death：previous 的 domain 不等於 P3E_DEATH_DOMAIN", "previous", ["rng", "death", "domain"], "stateCoreDraft.annual.rng.death"],
  ["death：before 的 domain 與 previous 不一致", "stage", ["annualDeath", "deathRngBefore", "domain"], "stateCoreDraft.annual.rng.death"],
  ["death：after 的 domain 與 before 不一致", "stage", ["annualDeath", "deathRngAfter", "domain"], "stateCoreDraft.annual.rng.death"]
];

describe("H5-CTO-127-B RNG domain 完整性（新增反例）", () => {
  it.each(RNG_DOMAIN_CASES)("反例：%s", (_name, on, path, expected) => {
    const previous = stateAt(5, { pack: packPlain });
    const stage = annualStage(previous, packPlain);
    if (on === "previous") {
      const brokenPrevious = patch(previous, path, "p3e/tampered") as never;
      expectCoreDraftError(() => assembleP3EAnnualStateCoreDraft(brokenPrevious, stage), "E_P3E_RNG", expected);
    } else {
      const brokenStage = patch(stage, path, "p3e/tampered") as never;
      expectCoreDraftError(() => assembleP3EAnnualStateCoreDraft(previous, brokenStage), "E_P3E_RNG", expected);
    }
  });

  it("domain 比對是 runtime 比對（型別斷言不可取代它）", () => {
    expect(CORE_DRAFT_CODE).toContain("P3E_LIFE_DOMAIN");
    expect(CORE_DRAFT_CODE).toContain("P3E_EVENT_DOMAIN");
    expect(CORE_DRAFT_CODE).toContain("P3E_DEATH_DOMAIN");
    // 比對函式的參數必須是 `string`（放寬），否則 literal 型別會讓比對恆真
    expect(CORE_DRAFT_CODE).toMatch(/function sameDomain\(left: string, right: string\): boolean/);
    expect(CORE_DRAFT_CODE).not.toMatch(/as\s+P3E(Life|Event|Death)Domain/);
  });
});

/* ------------------- 三、Pending 完整交叉比對反例 -------------------- */

describe("H5-CTO-127-B Pending 摘要與完整事實交叉比對（新增反例）", () => {
  const decisionAnnual = annualStage(genesisState, packDecision);
  const pendingFacts = decisionAnnual.annualDeath.pendingDecisionAfterDeath;
  expect(pendingFacts).not.toBeNull();

  it("摘要與完整事實在真實管線中本來就一致（正向對照）", () => {
    const summary = decisionAnnual.pendingDecisionSummary;
    expect(summary).not.toBeNull();
    expect(summary?.eventId).toBe(pendingFacts?.eventId);
    expect(summary?.decisionId).toBe(pendingFacts?.decisionId);
    expect(summary?.selectionHash).toBe(pendingFacts?.selectionHash);
    expect(summary?.optionIds).toEqual(pendingFacts?.options.map((option) => option.optionId));
    expect(assembleP3EAnnualStateCoreDraft(genesisState, decisionAnnual).phase).toBe("pending_decision");
  });

  const PENDING_BREAK_CASES: readonly (readonly [string, readonly string[], unknown])[] = [
    ["摘要為 null 但完整待決策事實非 null", ["pendingDecisionSummary"], null],
    ["摘要非 null 但完整待決策事實為 null", ["annualDeath", "pendingDecisionAfterDeath"], null],
    ["摘要的 eventId 與完整事實不一致", ["pendingDecisionSummary", "eventId"], "ev.other.event"],
    ["摘要的 decisionId 與完整事實不一致", ["pendingDecisionSummary", "decisionId"], "dec.other.decision"],
    ["摘要的 selectionHash 與完整事實不一致", ["pendingDecisionSummary", "selectionHash"], "f".repeat(64)],
    ["摘要的 optionIds 缺少一個", ["pendingDecisionSummary", "optionIds"], ["rent"]],
    ["摘要的 optionIds 多出一個", ["pendingDecisionSummary", "optionIds"], ["rent", "save", "extra"]],
    ["摘要的 optionIds 順序被換掉", ["pendingDecisionSummary", "optionIds"], ["save", "rent"]],
    ["摘要的 year 與 Roll 後值不一致", ["pendingDecisionSummary", "year"], 1999],
    ["摘要的 age 與 Roll 後值不一致", ["pendingDecisionSummary", "age"], 9]
  ];

  it.each(PENDING_BREAK_CASES)("反例：%s", (_name, path, value) => {
    const broken = patch(decisionAnnual, path, value) as never;
    expectCoreDraftError(
      () => assembleP3EAnnualStateCoreDraft(genesisState, broken),
      "E_P3E_STATE",
      "stateCoreDraft.annual.pendingDecision"
    );
  });

  it("反例：死亡年度殘留完整待決策事實", () => {
    const previous = stateAt(118, { pack: packPlain, health: 50 });
    const stage = annualStage(previous, packPlain);
    expect(stage.annualDeath.diedThisYear).toBe(true);
    const broken = patch(stage, ["annualDeath", "pendingDecisionAfterDeath"], pendingFacts) as never;
    expectCoreDraftError(
      () => assembleP3EAnnualStateCoreDraft(previous, broken),
      "E_P3E_STATE",
      "stateCoreDraft.annual.pendingDecision"
    );
  });
});

/* ---------------------------- 四、決策路徑 --------------------------- */

describe("H5-CTO-127-B 決策路徑（V1 行為保留）", () => {
  const annual = annualStage(genesisState, packDecision);
  const pendingState = pendingStateFromAnnual(genesisState, annual);
  const buildStage = (optionId: string): P3EDecisionChoiceStage =>
    resolveP3EDecisionChoice({ state: pendingState, eventPack: packDecision, deathPack, optionId });

  it("每個合法 option 都能組成 life draft", () => {
    for (const optionId of ["rent", "save"]) {
      const stage = buildStage(optionId);
      const draft = assembleP3EDecisionStateCoreDraft(pendingState, stage);
      expect(draft.phase).toBe("life");
      expect(draft.pendingDecision).toBeNull();
      expect(draft.stats).toEqual(stage.stats);
      expect(draft.assets).toEqual(stage.assets);
      expect(draft.flags).toEqual(stage.flags);
    }
  });

  it("year／age 不變、occurrences 不變、三條 RNG 不變", () => {
    const stage = buildStage("rent");
    const draft = assembleP3EDecisionStateCoreDraft(pendingState, stage);
    expect(draft.currentYear).toBe(pendingState.currentYear);
    expect(draft.age).toBe(pendingState.age);
    expect(draft.occurrences).toEqual(pendingState.occurrences);
    expect(draft.rng).toEqual(pendingState.rng);
    expect(draft.rng.life.semanticDraws).toBe(pendingState.rng.life.semanticDraws);
    expect(draft.rng.events.u32Draws).toBe(pendingState.rng.events.u32Draws);
    expect(draft.rng.death.u32Draws).toBe(pendingState.rng.death.u32Draws);
  });

  it("stats／assets／flags 採 stage 值（選擇 rent 時 expense 增加）", () => {
    const stage = buildStage("rent");
    const draft = assembleP3EDecisionStateCoreDraft(pendingState, stage);
    expect(draft.stats).toEqual(stage.stats);
    expect(draft.assets).toEqual(stage.assets);
    expect(draft.flags).toEqual(stage.flags);
    // GPT-0032-A：這是兒童（age 1）的決策，個人財務一律 0，rent 的 +9,000,000 不會進帳。
    expect(pendingState.age).toBeLessThan(16);
    expect(draft.assets).toEqual({ balanceMicroUsd: 0n, annualIncomeMicroUsd: 0n, annualExpenseMicroUsd: 0n });
  });

  it("反例：previous 不是 pending_decision phase", () => {
    const broken = { ...genesisState, phase: "life" as const };
    expectCoreDraftError(
      () => assembleP3EDecisionStateCoreDraft(broken, buildStage("rent")),
      "E_P3E_PHASE",
      "stateCoreDraft.decision.phase"
    );
  });

  it("反例：previous 沒有 pending 摘要", () => {
    const broken = { ...pendingState, pendingDecision: null };
    expectCoreDraftError(
      () => assembleP3EDecisionStateCoreDraft(broken, buildStage("rent")),
      "E_P3E_STATE",
      "stateCoreDraft.decision.pendingDecision"
    );
  });

  const V1_DECISION_BREAK_CASES: readonly (readonly [string, readonly string[], unknown, string, string])[] = [
    ["stage 的 eventId／decisionId 與摘要不符", ["eventId"], "ev.other.event", "E_P3E_DECISION", "stateCoreDraft.decision.identity"],
    ["stage 的 year／age 與 previous 不符", ["ageAfter"], 9, "E_P3E_STATE", "stateCoreDraft.decision.yearAge"],
    ["stage 的 pendingDecisionAfter 不是 null", ["pendingDecisionAfter"], { year: 2025 }, "E_P3E_STATE", "stateCoreDraft.decision.after"],
    ["stage 的 phaseAfter 不是 life", ["phaseAfter"], "pending_decision", "E_P3E_STATE", "stateCoreDraft.decision.after"]
  ];

  it.each(V1_DECISION_BREAK_CASES)("反例：%s", (_name, path, value, code, expected) => {
    const broken = patch(buildStage("rent"), path, value) as never;
    expectCoreDraftError(() => assembleP3EDecisionStateCoreDraft(pendingState, broken), code, expected);
  });
});

/* ------------------- 五、selectedOptionId 新增反例 -------------------- */

describe("H5-CTO-127-B selectedOptionId 驗證（新增反例）", () => {
  const annual = annualStage(genesisState, packDecision);
  const pendingState = pendingStateFromAnnual(genesisState, annual);
  const buildStage = (optionId: string): P3EDecisionChoiceStage =>
    resolveP3EDecisionChoice({ state: pendingState, eventPack: packDecision, deathPack, optionId });

  it("合法 optionId 通過（正向對照）", () => {
    for (const optionId of ["rent", "save"]) {
      const stage = buildStage(optionId);
      expect(stage.selectedOptionId).toBe(optionId);
      expect(pendingState.pendingDecision?.optionIds).toContain(stage.selectedOptionId);
      expect(assembleP3EDecisionStateCoreDraft(pendingState, stage).phase).toBe("life");
    }
  });

  const BAD_OPTION_IDS: readonly (readonly [string, string])[] = [
    ["同一個 decision 但不存在的 optionId", "buy-house"],
    ["另一個 decision 的 optionId", "study"],
    ["大小寫不同的 optionId", "Rent"]
  ];

  it.each(BAD_OPTION_IDS)("反例：%s", (_name, optionId) => {
    const broken = patch(buildStage("rent"), ["selectedOptionId"], optionId) as never;
    expectCoreDraftError(
      () => assembleP3EDecisionStateCoreDraft(pendingState, broken),
      "E_P3E_DECISION",
      "stateCoreDraft.decision.identity"
    );
  });
});

/* ---------------------------- 六、共同契約 --------------------------- */

describe("H5-CTO-127-B 共同契約（V1 行為保留）", () => {
  const annual = annualStage(genesisState, packDecision);
  const pendingState = pendingStateFromAnnual(genesisState, annual);
  const decisionStage = resolveP3EDecisionChoice({
    state: pendingState,
    eventPack: packDecision,
    deathPack,
    optionId: "rent"
  });

  it("輸入不被修改（年度與決策兩條路徑）", () => {
    const previous = genesisState;
    const before = stable(previous);
    const stageBefore = stable(annual);
    assembleP3EAnnualStateCoreDraft(previous, annual);
    expect(stable(previous)).toBe(before);
    expect(stable(annual)).toBe(stageBefore);

    const pendingBefore = stable(pendingState);
    const decisionBefore = stable(decisionStage);
    assembleP3EDecisionStateCoreDraft(pendingState, decisionStage);
    expect(stable(pendingState)).toBe(pendingBefore);
    expect(stable(decisionStage)).toBe(decisionBefore);
  });

  it("輸出遞迴凍結", () => {
    expect(isDeepFrozen(assembleP3EAnnualStateCoreDraft(genesisState, annual))).toBe(true);
    expect(isDeepFrozen(assembleP3EDecisionStateCoreDraft(pendingState, decisionStage))).toBe(true);
  });

  it("輸出與輸入零共享物件／陣列", () => {
    const draft = assembleP3EAnnualStateCoreDraft(genesisState, annual);
    expect(sharesReference(draft, genesisState)).toBe(false);
    expect(sharesReference(draft, annual)).toBe(false);
    const decisionDraft = assembleP3EDecisionStateCoreDraft(pendingState, decisionStage);
    expect(sharesReference(decisionDraft, pendingState)).toBe(false);
    expect(sharesReference(decisionDraft, decisionStage)).toBe(false);
  });

  it("Object.keys 精確且不含任何 integrity metadata", () => {
    const drafts: P3EStateCoreDraft[] = [
      assembleP3EAnnualStateCoreDraft(genesisState, annual),
      assembleP3EDecisionStateCoreDraft(pendingState, decisionStage)
    ];
    for (const draft of drafts) {
      expect(Object.keys(draft).sort()).toEqual([...DRAFT_KEYS].sort());
      const allKeys = collectKeys(draft);
      for (const forbidden of FORBIDDEN_METADATA) {
        expect(allKeys).not.toContain(forbidden);
      }
    }
  });

  it("不進公開 barrel", () => {
    const barrelSource = readFileSync(join(ROOT, "packages/simulation/src/index.ts"), "utf8");
    expect(barrelSource).not.toContain("state-core-draft");
    const exported = Object.keys(barrel);
    expect(exported).not.toContain("assembleP3EAnnualStateCoreDraft");
    expect(exported).not.toContain("assembleP3EDecisionStateCoreDraft");
  });

  it("不使用 `as unknown as P3ELifeState`", () => {
    expect(CORE_DRAFT_CODE).not.toContain("as unknown as");
    expect(CORE_DRAFT_CODE).not.toContain("as P3ELifeState");
  });

  it("不呼叫 stateHash／Ledger／Command／Chain／Roll／事件抽選／死亡演算法", () => {
    const forbiddenIdentifiers = [
      "computeP3EStateHash",
      "createP3EGenesisIntegrity",
      "computeP3ECommandHash",
      "computeP3EDeltaHash",
      "computeP3EYearChainHash",
      "computeP3EYearEntryHash",
      "computeP3ESnapshotHash",
      "resolveP3ERoll",
      "drawP3ERollDeltas",
      "selectEvent",
      "applyEventEffects",
      "applyEffectOutcome",
      "evaluateAnnualDeath",
      "readP3EState"
    ];
    for (const identifier of forbiddenIdentifiers) {
      expect(CORE_DRAFT_CODE).not.toContain(identifier);
    }
    const imported = [...CORE_DRAFT_CODE.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] as string);
    expect(imported.sort()).toEqual([
      "./decision-choice-effects",
      "./errors",
      "./pending-decision-persistence",
      "@life-sim/contracts"
    ]);
    expect(CORE_DRAFT_CODE).toContain('import type { P3EAnnualPendingDecisionStage } from "./pending-decision-persistence"');
    expect(CORE_DRAFT_CODE).toContain('import type { P3EDecisionChoiceStage } from "./decision-choice-effects"');
  });
});
