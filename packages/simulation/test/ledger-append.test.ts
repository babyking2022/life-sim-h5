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
import { createP3EGenesis } from "../src/genesis";
import { computeP3EStateHash } from "../src/state-hash";
import { isP3EError, type P3EError } from "../src/errors";
import {
  resolveP3EAnnualPendingDecision,
  type P3EAnnualPendingDecisionStage
} from "../src/pending-decision-persistence";
import { resolveP3EDecisionChoice } from "../src/decision-choice-effects";
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
import { appendP3ELedgerTransition } from "../src/ledger-append";
import * as barrel from "../src/index";
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * P3-E Ledger Append 正式測試（H5-CTO-155-A 整合）。
 *
 * 來源：WorkBuddy 候選 `ledger-append-v1-candidate.test.ts`
 * （SHA-256 `8095042b020c5873981aa96e359fa1addd6c6421b8ff1974329da49363279866`，
 * 經 H5-CTO-147-B／H5-CTO-155-A 核准）。正式化只改 import／原始碼掃描路徑、`candidate`
 * 字樣、兩處只針對候選檔名／候選狀態的斷言，並新增兩條 money-effects 真實管線回歸；
 * **候選既有 39 項測試語意全部保留**。
 *
 * 期望值一律用**正式原語**獨立重算（`computeP3EStateHash`／`computeP3ESnapshotHash`／
 * `computeP3EDeltaHash`／`computeP3EYearEntryHash`），不用被測函式自己的輸出當答案。
 *
 * 本檔**不**重建任何 shape／hash 演算法：所有 command／year record／final state 的
 * 合法性都交給正式的 `readP3EState`／`readP3ECommand`／`materializeP3ETransition`／
 * `createP3ECommandRecord`／`createP3EYearLedgerRecord`／Ledger Continuity。
 *
 * ## 年度收支 effects（H5-CTO-146-A 之後）
 *
 * 正式 `state-invariants.ts` 已移除「年度收支欄位必須等於基準公式」的不變量，
 * 事件與決策 effects 可以合法改寫 `annualIncomeMicroUsd`／`annualExpenseMicroUsd`。
 * 因此本檔除了候選原有的 39 項之外，另加兩條**真實管線**回歸：
 * housing `rent`（`annualExpenseMicroUsd +9,000,000`）與年度事件
 * （`annualIncomeMicroUsd +5,000,000`）——全程走正式原語，不手動改回基準值。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const APPEND_SRC = readFileSync(
  join(ROOT, "packages/simulation/src/ledger-append.ts"),
  "utf8"
);
const APPEND_CODE = APPEND_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
const BARREL_SRC = readFileSync(join(ROOT, "packages/simulation/src/index.ts"), "utf8");

type Dict = Record<string, unknown>;

/* ------------------------------ fixtures ------------------------------ */

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
const deathPack = validateDeathPack(
  { manifest: rawDeathManifest, datasets: rawDeathDatasets } as never,
  base
);

/** 重算 checksum／license／lineage 後重新驗證的 event pack。 */
function repairedEventPack(records: readonly Dict[]): ValidatedEventPack {
  const events = structuredClone(records as Dict[]);
  const manifest = structuredClone(rawEventManifest);
  const datasetChecksum = computeEventsChecksum(events as never);
  const descriptor = (manifest.datasets as Dict[])[0] as Dict;
  descriptor.recordCount = events.length;
  descriptor.checksum = datasetChecksum;
  for (const license of manifest.licenses as Dict[]) license.checksum = datasetChecksum;
  for (const record of manifest.lineage as Dict[]) record.outputChecksum = datasetChecksum;
  manifest.packChecksum = computePackChecksum(manifest as never);
  return validateEventPack({ manifest, events } as never);
}

function cloneEvent(eventId: string): Dict {
  const source = rawEvents.find((record) => record.eventId === eventId);
  if (source === undefined) throw new Error(`missing fixture event ${eventId}`);
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
/** 一般事件包（無 decision；只動 happiness 與 balance）。 */
const packPlain = repairedEventPack([cloneEvent("ev.any.setback")]);
/** 沒有任何候選事件的事件包。 */
const packNoCandidates = repairedEventPack([cloneEvent("ev.child.first-word")]);

const SEED = "p3e-147-ledger-append-v1";
const peerGroup = buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never);
const certificate = createBirthCertificate(base, identityPack, peerGroup, SEED);

/** 綁定 `packDecision` 的 genesis（決策路徑需要 pack 綁定一致）。 */
const genesisDecision = createP3EGenesis({
  masterSeed: SEED,
  basePack: base,
  identityPack,
  certificate,
  eventPack: packDecision,
  deathPack
});

const BIRTH_YEAR = genesisDecision.identity.birthYear;
const ENTITY_ID = genesisDecision.identity.entityId;
const SEX = genesisDecision.identity.sex;

/** 重算 mortality hazard 為 0 的死亡包（讓 age 走 age_ceiling 而非自然死亡）。 */
function deathPackWithZeroHazardAt(age: number): typeof deathPack {
  const manifest = structuredClone(rawDeathManifest);
  const datasets = structuredClone(rawDeathDatasets);
  const row = (datasets.mortality as { records: Dict[] }).records.find(
    (entry) => entry.entityId === ENTITY_ID && entry.sex === SEX && entry.age === age
  );
  if (row === undefined) throw new Error(`missing mortality row for age ${age}`);
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
    descriptor.recordCount = (datasets[datasetId] as { records: Dict[] }).records.length;
    descriptor.checksum = checksumOf(datasetId);
  }
  manifest.licenses = structuredClone((datasets.licenses as { records: Dict[] }).records);
  manifest.lineage = structuredClone((datasets.lineage as { records: Dict[] }).records);
  manifest.packChecksum = computeDeathPackChecksum(manifest as never);
  return validateDeathPack({ manifest, datasets } as never, base);
}
const deathPackNoHazardAt120 = deathPackWithZeroHazardAt(contracts.P3E_MAX_AGE);

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
  readonly deathPackOverride?: typeof deathPack;
  readonly phase?: contracts.P3EPhase;
}

/** 任意 age 的合法 state（RNG 游標、收支公式、pack binding 全部自洽）。 */
function stateAt(age: number, options: StateOptions = {}): contracts.P3ELifeState {
  const pack = options.pack ?? packPlain;
  const death = options.deathPackOverride ?? deathPack;
  const bound = bindEventPack(pack);
  const years = BigInt(age);
  const eventInitial = toWords(deriveEventRngState(LIFE_INITIAL, BIRTH_YEAR));
  const draft = {
    ...genesisDecision,
    currentYear: BIRTH_YEAR + age,
    age,
    phase: options.phase ?? (age >= contracts.P3E_MAX_AGE ? ("death" as const) : ("life" as const)),
    pendingDecision: null,
    stats: { health: 60, happiness: 55, knowledge: 40, relationships: 35 },
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

/** 任意 `commandLog.count` 的合法 state（重算 stateHash 保持自洽）。 */
function stateWithCommandCount(
  age: number,
  count: number,
  options: StateOptions = {}
): contracts.P3ELifeState {
  const source = stateAt(age, options);
  const draft = { ...source, commandLog: { ...source.commandLog, count } };
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

/* ------------------------------ 流程輔助 ------------------------------ */

/** 走正式年度流程取得「下一個 Core Draft」（不重跑任何業務演算法）。 */
function annualDraft(
  previous: contracts.P3ELifeState,
  pack: ValidatedEventPack,
  death: typeof deathPack = deathPack
): P3EStateCoreDraft {
  const stage = resolveP3EAnnualPendingDecision({
    state: previous,
    eventPack: pack,
    deathPack: death,
    contentMode: "standard"
  });
  return assembleP3EAnnualStateCoreDraft(previous, stage);
}

/** 走正式決策流程取得「下一個 Core Draft」。 */
function decisionDraft(
  previous: contracts.P3ELifeState,
  pack: ValidatedEventPack,
  optionId: string
): P3EStateCoreDraft {
  const stage = resolveP3EDecisionChoice({
    state: previous,
    eventPack: pack,
    deathPack,
    optionId
  });
  return assembleP3EDecisionStateCoreDraft(previous, stage);
}

/* ------------------------------ 輔助 ------------------------------- */

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

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

/* ================================================================== */
/* 一、正向案例                                                        */
/* ================================================================== */

describe("H5-CTO-147-B Ledger Append V1：正向案例", () => {
  it("ADVANCE_YEAR → life：state／commandRecord／yearRecord 三項皆建立", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    expect(draft.phase).toBe("life");

    const result = appendP3ELedgerTransition(previous, ADVANCE, draft);

    expect(result.state.phase).toBe("life");
    expect(result.state.age).toBe(previous.age + 1);
    expect(result.state.currentYear).toBe(previous.currentYear + 1);
    expect(result.commandRecord.command.type).toBe("ADVANCE_YEAR");
    expect(result.yearRecord.phase).toBe("life");
    expect(Object.keys(result).sort()).toEqual(["commandRecord", "state", "yearRecord"]);
  });

  it("ADVANCE_YEAR → pending_decision：pendingDecision 摘要隨之封存", () => {
    const previous = genesisDecision;
    const draft = annualDraft(previous, packDecision);
    expect(draft.phase).toBe("pending_decision");

    const result = appendP3ELedgerTransition(previous, ADVANCE, draft);

    expect(result.state.phase).toBe("pending_decision");
    expect(result.state.pendingDecision).not.toBeNull();
    expect(result.state.pendingDecision?.eventId).toBe("ev.adult.housing-choice");
    expect(result.yearRecord.phase).toBe("pending_decision");
  });

  it("ADVANCE_YEAR → death（自然死亡）：phase 與 age 一致封存", () => {
    const previous = stateAt(76, { pack: packPlain });
    const stage = resolveP3EAnnualPendingDecision({
      state: previous,
      eventPack: packPlain,
      deathPack,
      contentMode: "standard"
    });
    expect(stage.annualDeath.diedThisYear).toBe(true);
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    expect(draft.phase).toBe("death");

    const result = appendP3ELedgerTransition(previous, ADVANCE, draft);

    expect(result.state.phase).toBe("death");
    expect(result.state.age).toBe(77);
    expect(result.yearRecord.phase).toBe("death");
    expect(result.state.pendingDecision).toBeNull();
  });

  it("ADVANCE_YEAR → death（age_ceiling）：120 歲必定 death", () => {
    const previous = stateAt(contracts.P3E_MAX_AGE - 1, {
      pack: packPlain,
      deathPackOverride: deathPackNoHazardAt120
    });
    const stage = resolveP3EAnnualPendingDecision({
      state: previous,
      eventPack: packPlain,
      deathPack: deathPackNoHazardAt120,
      contentMode: "standard"
    });
    expect(stage.annualDeath.deathReason).toBe("age_ceiling");
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);

    const result = appendP3ELedgerTransition(previous, ADVANCE, draft);

    expect(result.state.phase).toBe("death");
    expect(result.state.age).toBe(contracts.P3E_MAX_AGE);
  });

  it("CHOOSE_DECISION → life：year／age／RNG 全部不變", () => {
    const choicePrevious = stateAt(5, { pack: packDecision });
    const pendingState = pendingStateFromAnnual(
      choicePrevious,
      resolveP3EAnnualPendingDecision({
        state: choicePrevious,
        eventPack: packDecision,
        deathPack,
        contentMode: "standard"
      })
    );
    const draft = decisionDraft(pendingState, packDecision, "save");
    expect(draft.phase).toBe("life");

    const result = appendP3ELedgerTransition(
      pendingState,
      { type: "CHOOSE_DECISION", optionId: "save" },
      draft
    );

    expect(result.state.phase).toBe("life");
    expect(result.state.pendingDecision).toBeNull();
    expect(result.state.currentYear).toBe(pendingState.currentYear);
    expect(result.state.age).toBe(pendingState.age);
    expect(result.state.rng).toEqual(pendingState.rng);
    expect(result.commandRecord.command).toEqual({ type: "CHOOSE_DECISION", optionId: "save" });
    expect(result.yearRecord.phase).toBe("life");
  });
});

/* ================================================================== */
/* 二、連續 append 與鏈接續                                            */
/* ================================================================== */

describe("H5-CTO-147-B Ledger Append V1：連續 append 與鏈接續", () => {
  it("index 從 1、2 連續 append：第二筆的 index 正好是前一笔 count + 1", () => {
    const first = appendP3ELedgerTransition(
      genesisDecision,
      ADVANCE,
      annualDraft(genesisDecision, packDecision)
    );
    expect(first.commandRecord.index).toBe(1);
    expect(first.yearRecord.index).toBe(1);
    expect(first.state.commandLog.count).toBe(1);

    const second = appendP3ELedgerTransition(
      first.state,
      { type: "CHOOSE_DECISION", optionId: "save" },
      decisionDraft(first.state, packDecision, "save")
    );
    expect(second.commandRecord.index).toBe(2);
    expect(second.yearRecord.index).toBe(2);
    expect(second.state.commandLog.count).toBe(2);
  });

  it("Command head 正確接續：第二筆的 prevCommandHash 是前一笔 commandHash", () => {
    const first = appendP3ELedgerTransition(
      genesisDecision,
      ADVANCE,
      annualDraft(genesisDecision, packDecision)
    );
    const second = appendP3ELedgerTransition(
      first.state,
      { type: "CHOOSE_DECISION", optionId: "save" },
      decisionDraft(first.state, packDecision, "save")
    );

    expect(second.commandRecord.prevCommandHash).toBe(first.commandRecord.commandHash);
    expect(first.state.commandLog.headHash).toBe(first.commandRecord.commandHash);
    expect(second.state.commandLog.headHash).toBe(second.commandRecord.commandHash);
  });

  it("Chain head 正確接續：第二筆的 prevChainHash 是前一笔 chainHash", () => {
    const first = appendP3ELedgerTransition(
      genesisDecision,
      ADVANCE,
      annualDraft(genesisDecision, packDecision)
    );
    const second = appendP3ELedgerTransition(
      first.state,
      { type: "CHOOSE_DECISION", optionId: "save" },
      decisionDraft(first.state, packDecision, "save")
    );

    expect(second.yearRecord.prevChainHash).toBe(first.yearRecord.chainHash);
    expect(first.state.heads.hashChain).toBe(first.yearRecord.chainHash);
    expect(second.state.heads.hashChain).toBe(second.yearRecord.chainHash);
  });

  it("三個 ledger heads 正確更新：snapshot／delta／entry 對應本次 material", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const result = appendP3ELedgerTransition(previous, ADVANCE, draft);

    const snapshotHash = computeP3ESnapshotHash({
      index: result.commandRecord.index,
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
    const deltaHash = computeP3EDeltaHash({
      index: result.commandRecord.index,
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
    const entryHash = computeP3EYearEntryHash({
      index: result.commandRecord.index,
      year: draft.currentYear,
      age: draft.age,
      phase: draft.phase,
      stateHashBefore: previous.stateHash,
      rngBefore: previous.rng,
      rngAfter: draft.rng,
      snapshotHash,
      deltaHash
    });

    expect(result.state.heads.lastSnapshotHash).toBe(snapshotHash);
    expect(result.state.heads.lastDeltaHash).toBe(deltaHash);
    expect(result.state.heads.lastEntryHash).toBe(entryHash);
    expect(result.yearRecord.snapshotHash).toBe(snapshotHash);
    expect(result.yearRecord.deltaHash).toBe(deltaHash);
    expect(result.yearRecord.entryHash).toBe(entryHash);
    expect(result.commandRecord.entryHash).toBe(entryHash);
  });

  it("stateHashAfter 在更新 hashChain／commandLog 後保持不變（projection 不含兩者）", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const result = appendP3ELedgerTransition(previous, ADVANCE, draft);

    const heads = {
      lastSnapshotHash: result.state.heads.lastSnapshotHash,
      lastDeltaHash: result.state.heads.lastDeltaHash,
      lastEntryHash: result.state.heads.lastEntryHash
    };
    // 同一個 draft，chain head 與 command 摘要各自取「舊值」與「新值」，stateHash 必須相同。
    const withOldChain = computeP3EStateHash({
      ...draft,
      heads: { ...heads, hashChain: previous.heads.hashChain },
      commandLog: previous.commandLog
    } as never);
    const withNewChain = computeP3EStateHash({
      ...draft,
      heads: { ...heads, hashChain: result.yearRecord.chainHash },
      commandLog: result.state.commandLog
    } as never);

    expect(withOldChain).toBe(withNewChain);
    expect(result.state.stateHash).toBe(withNewChain);
    expect(result.state.stateHash).toBe(result.yearRecord.stateHashAfter);
    expect(result.state.stateHash).toBe(result.commandRecord.stateHashAfter);
  });

  it("三份輸出交叉連結一致：index／year／前後 stateHash／commandHash／entryHash", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const result = appendP3ELedgerTransition(previous, ADVANCE, draft);

    expect(result.commandRecord.index).toBe(result.yearRecord.index);
    expect(result.commandRecord.index).toBe(result.state.commandLog.count);
    expect(result.yearRecord.year).toBe(result.state.currentYear);
    expect(result.yearRecord.age).toBe(result.state.age);
    expect(result.yearRecord.phase).toBe(result.state.phase);
    expect(result.commandRecord.stateHashBefore).toBe(previous.stateHash);
    expect(result.yearRecord.stateHashBefore).toBe(previous.stateHash);
    expect(result.commandRecord.stateHashAfter).toBe(result.state.stateHash);
    expect(result.yearRecord.stateHashAfter).toBe(result.state.stateHash);
    expect(result.yearRecord.commandHash).toBe(result.commandRecord.commandHash);
    expect(result.state.heads.lastEntryHash).toBe(result.yearRecord.entryHash);
  });
});

/* ================================================================== */
/* 三、錯誤路徑                                                        */
/* ================================================================== */

describe("H5-CTO-147-B Ledger Append V1：錯誤路徑", () => {
  it("previous State 非法（stateHash 被竄改）→ 正式 readP3EState 擋下", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const broken = { ...previous, stateHash: "f".repeat(64) } as contracts.P3ELifeState;

    expectP3EError(() => appendP3ELedgerTransition(broken, ADVANCE, draft), "E_P3E_HASH", "stateHash");
  });

  it("previous State 不是物件 → 正式 readP3EState 擋下", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);

    expectP3EError(() => appendP3ELedgerTransition(null, ADVANCE, draft), "E_P3E_STATE", "state");
  });

  it("command 缺欄位 → 正式 readP3ECommand 擋下", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);

    expectP3EError(
      () => appendP3ELedgerTransition(previous, { type: "ADVANCE_YEAR" }, draft),
      "E_P3E_COMMAND",
      "command"
    );
  });

  it("command 類型未知 → 正式 readP3ECommand 擋下", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);

    expectP3EError(
      () => appendP3ELedgerTransition(previous, { type: "REBOOT" }, draft),
      "E_P3E_COMMAND",
      "command"
    );
  });

  it("command 的 optionId 格式非法 → 正式 readP3ECommand 擋下", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);

    expectP3EError(
      () => appendP3ELedgerTransition(previous, { type: "CHOOSE_DECISION", optionId: "A" }, draft),
      "E_P3E_COMMAND",
      "command.optionId"
    );
  });

  it("Core Draft 的 phase 非法 → 正式 seal／readP3EState 擋下", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const broken = { ...draft, phase: "zombie" } as unknown as P3EStateCoreDraft;

    expectP3EError(
      () => appendP3ELedgerTransition(previous, ADVANCE, broken),
      "E_P3E_PHASE",
      "phase"
    );
  });

  it("Core Draft 缺 currentYear → 正式 materializeP3ETransition 擋下", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const broken: Dict = { ...draft };
    delete broken.currentYear;

    // 固定順序下 `materializeP3ETransition` 早於最終 `readP3EState`，
    // 因此 draft 的形狀缺陷由 transitionMaterial 這個正式原語擋下。
    expectP3EError(
      () => appendP3ELedgerTransition(previous, ADVANCE, broken as unknown as P3EStateCoreDraft),
      "E_P3E_STATE",
      "transitionMaterial.draft"
    );
  });

  it("command 與 phase 不合法（previous 是 pending_decision 卻發 ADVANCE_YEAR）→ Continuity 擋下", () => {
    const choicePrevious = stateAt(5, { pack: packDecision });
    const pendingState = pendingStateFromAnnual(
      choicePrevious,
      resolveP3EAnnualPendingDecision({
        state: choicePrevious,
        eventPack: packDecision,
        deathPack,
        contentMode: "standard"
      })
    );
    const draft = decisionDraft(pendingState, packDecision, "save");

    expectP3EError(
      () => appendP3ELedgerTransition(pendingState, ADVANCE, draft),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("command 與 phase 不合法（previous 是 life 卻發 CHOOSE_DECISION）→ Continuity 擋下", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);

    expectP3EError(
      () => appendP3ELedgerTransition(previous, { type: "CHOOSE_DECISION", optionId: "save" }, draft),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("optionId 不在 pending 清單 → Continuity 擋下", () => {
    const choicePrevious = stateAt(5, { pack: packDecision });
    const pendingState = pendingStateFromAnnual(
      choicePrevious,
      resolveP3EAnnualPendingDecision({
        state: choicePrevious,
        eventPack: packDecision,
        deathPack,
        contentMode: "standard"
      })
    );
    const draft = decisionDraft(pendingState, packDecision, "save");

    expectP3EError(
      () =>
        appendP3ELedgerTransition(
          pendingState,
          { type: "CHOOSE_DECISION", optionId: "rent-2" },
          draft
        ),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("command count 4095 → 可產生第 4096 筆", () => {
    const previous = stateWithCommandCount(5, 4095, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);

    const result = appendP3ELedgerTransition(previous, ADVANCE, draft);

    expect(result.commandRecord.index).toBe(4096);
    expect(result.yearRecord.index).toBe(4096);
    expect(result.state.commandLog.count).toBe(4096);
  });

  it("command count 4096 → 拒絕（不得建立第 4097 筆）", () => {
    const previous = stateWithCommandCount(5, 4096, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);

    expectP3EError(
      () => appendP3ELedgerTransition(previous, ADVANCE, draft),
      "E_P3E_HISTORY",
      "transitionMaterial.index"
    );
  });
});

/* ================================================================== */
/* 四、信任邊界                                                        */
/* ================================================================== */

describe("H5-CTO-147-B Ledger Append V1：信任邊界", () => {
  it("previous State 是 revoked Proxy → 不外洩原生例外", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const revocable = Proxy.revocable(previous as unknown as Dict, {});
    revocable.revoke();

    let caught: unknown = null;
    try {
      appendP3ELedgerTransition(revocable.proxy, ADVANCE, draft);
    } catch (error) {
      caught = error;
    }
    expect(isP3EError(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as P3EError).code).toBe("E_P3E_STATE");
  });

  it("Core Draft 是 revoked Proxy → 固定 P3EError，不外洩原生例外", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const revocable = Proxy.revocable(draft as unknown as Dict, {});
    revocable.revoke();

    let caught: unknown = null;
    try {
      appendP3ELedgerTransition(previous, ADVANCE, revocable.proxy as unknown as P3EStateCoreDraft);
    } catch (error) {
      caught = error;
    }
    expect(isP3EError(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as P3EError).code).toBe("E_P3E_STATE");
    expect((caught as P3EError).path).toBe("ledgerAppend.draft");
  });

  it("Core Draft 帶 accessor（getter）→ getter 呼叫次數 0，只回固定 P3EError", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    let getterCalls = 0;
    const withGetter: Dict = {};
    for (const key of Object.keys(draft)) {
      Object.defineProperty(withGetter, key, {
        enumerable: true,
        configurable: true,
        get() {
          getterCalls += 1;
          return (draft as Dict)[key];
        }
      });
    }

    let caught: unknown = null;
    try {
      appendP3ELedgerTransition(previous, ADVANCE, withGetter as unknown as P3EStateCoreDraft);
    } catch (error) {
      caught = error;
    }
    expect(getterCalls).toBe(0);
    expect(isP3EError(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as P3EError).code).toBe("E_P3E_STATE");
  });

  it("Core Draft 的 descriptor 回傳 undefined → 該欄位被略過，後續由正式原語擋下", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const plain: Dict = { ...draft };
    const proxy = new Proxy(plain, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "currentYear") return undefined;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });

    let caught: unknown = null;
    try {
      appendP3ELedgerTransition(previous, ADVANCE, proxy as unknown as P3EStateCoreDraft);
    } catch (error) {
      caught = error;
    }
    expect(isP3EError(caught)).toBe(true);
    expect((caught as P3EError).code).toBe("E_P3E_STATE");
  });

  it("外部預先計算的 stateHash／heads／commandLog 注入 Core Draft → 被正式原語輸出覆蓋", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const clean = appendP3ELedgerTransition(previous, ADVANCE, draft);

    // Core Draft 的正式形狀是 Omit<P3ELifeState, "heads" | "commandLog" | "stateHash">，
    // 也就是說它本來就不帶這三個欄位；就算外部硬塞，本模組也必須用自己的
    // 正式原語輸出覆蓋它們，完全不受影響。
    const tampered: Dict = {
      ...draft,
      stateHash: "0".repeat(64),
      heads: {
        lastSnapshotHash: "1".repeat(64),
        lastDeltaHash: "2".repeat(64),
        lastEntryHash: "3".repeat(64),
        hashChain: "4".repeat(64)
      },
      commandLog: { count: 999, headHash: "5".repeat(64) }
    };

    const dirty = appendP3ELedgerTransition(
      previous,
      ADVANCE,
      tampered as unknown as P3EStateCoreDraft
    );

    expect(dirty.state.stateHash).toBe(clean.state.stateHash);
    expect(dirty.state.heads).toEqual(clean.state.heads);
    expect(dirty.state.commandLog).toEqual(clean.state.commandLog);
    expect(dirty.commandRecord).toEqual(clean.commandRecord);
    expect(dirty.yearRecord).toEqual(clean.yearRecord);
  });

  it("Core Draft 注入形狀外欄位（entryHash／chainHash）→ 正式 readP3EState 的 exact-object 擋下", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const tampered: Dict = {
      ...draft,
      entryHash: "6".repeat(64),
      chainHash: "7".repeat(64)
    };

    expectP3EError(
      () =>
        appendP3ELedgerTransition(previous, ADVANCE, tampered as unknown as P3EStateCoreDraft),
      "E_P3E_STATE",
      "state"
    );
  });

  it("輸入不修改：previous／command／draft 全部保持原樣", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);
    const command: Dict = { type: "ADVANCE_YEAR", contentMode: "standard" };
    const previousBefore = stable(previous);
    const draftBefore = stable(draft);
    const commandBefore = stable(command);

    appendP3ELedgerTransition(previous, command, draft);

    expect(stable(previous)).toBe(previousBefore);
    expect(stable(draft)).toBe(draftBefore);
    expect(stable(command)).toBe(commandBefore);
  });

  it("輸出深層凍結、零共享", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const draft = annualDraft(previous, packNoCandidates);

    const result = appendP3ELedgerTransition(previous, ADVANCE, draft);

    expect(isDeepFrozen(result)).toBe(true);
    expect(isDeepFrozen(result.state)).toBe(true);
    expect(isDeepFrozen(result.commandRecord)).toBe(true);
    expect(isDeepFrozen(result.yearRecord)).toBe(true);
    expect(sharesReference(result.state, previous)).toBe(false);
    expect(sharesReference(result.state, draft)).toBe(false);
    expect(sharesReference(result.commandRecord, previous)).toBe(false);
    expect(sharesReference(result.yearRecord, draft)).toBe(false);
  });
});

/* ================================================================== */
/* 五、共同契約                                                        */
/* ================================================================== */

describe("H5-CTO-147-B Ledger Append V1：共同契約", () => {
  it("不進公開 barrel", () => {
    expect(Object.keys(barrel)).not.toContain("appendP3ELedgerTransition");
  });

  it("本模組不得自行實作業務演算法（Roll／事件／effects／死亡／決策）", () => {
    const forbidden = [
      "drawP3ERollDeltas",
      "resolveP3EAnnualPendingDecision",
      "resolveP3EDecisionChoice",
      "assembleP3EAnnualStateCoreDraft",
      "assembleP3EDecisionStateCoreDraft",
      "applyEventEffects",
      "applyEffectOutcome",
      "Xoshiro",
      "nextU32",
      "uniformInt",
      "uniformBigInt",
      "createP3EGenesis",
      "sealP3EState",
      "computeP3EStateHash",
      "computeP3ESnapshotHash",
      "computeP3EDeltaHash",
      "computeP3EYearEntryHash",
      "computeP3EYearChainHash"
    ];
    for (const token of forbidden) {
      expect(APPEND_CODE, `本模組不得出現 ${token}`).not.toContain(token);
    }
  });

  it("本模組不得建立 Codec／Replay／Ledger append 基礎設施", () => {
    for (const token of ["codec", "replay", "Codec", "Replay", "encodeP3E", "decodeP3E"]) {
      expect(APPEND_CODE, `本模組不得出現 ${token}`).not.toContain(token);
    }
  });

  it("本模組必須重用七個正式原語", () => {
    for (const token of [
      "readP3EState",
      "readP3ECommand",
      "materializeP3ETransition",
      "createP3ECommandRecord",
      "createP3EYearLedgerRecord",
      "validateP3ELedgerContinuity"
    ]) {
      expect(APPEND_SRC, `本模組必須重用 ${token}`).toContain(token);
    }
  });

  it("本模組不得接受外部預先計算的 hash 或 Record（hash 一律由正式原語重算）", () => {
    // 本模組不得自行 import 任何 hash 計算原語（不得複製／重寫 hash 演算法）。
    for (const token of [
      "computeP3EStateHash",
      "computeP3ESnapshotHash",
      "computeP3EDeltaHash",
      "computeP3EYearEntryHash",
      "computeP3EYearChainHash",
      "computeP3ECommandHash"
    ]) {
      expect(APPEND_SRC, `本模組不得自行重寫 hash 演算法：${token}`).not.toContain(token);
    }

    // 本模組不得自行計算 argsHash（argsHash 由 createP3ECommandRecord 內部重算）。
    expect(APPEND_CODE).not.toContain("argsHash");

    // 本模組必須從「正式原語的輸出」讀取 hash，而不是從 nextCoreDraft 讀取。
    // nextCoreDraft 的形狀是 Omit<P3ELifeState, "heads" | "commandLog" | "stateHash">，
    // 也就是說它本來就不帶任何 hash；若本模組去讀 draft 的 hash 欄位，
    // 既是形狀外存取，也代表接受外部預先計算值。
    expect(APPEND_CODE).not.toContain("draft.stateHash");
    expect(APPEND_CODE).not.toContain("draft.heads");
    expect(APPEND_CODE).not.toContain("draft.commandLog");
    expect(APPEND_CODE).not.toContain("draft.entryHash");
    expect(APPEND_CODE).not.toContain("draft.chainHash");
    expect(APPEND_CODE).not.toContain("draft.snapshotHash");
    expect(APPEND_CODE).not.toContain("draft.deltaHash");

    // 本模組只能從正式原語的輸出物件讀取 hash。
    expect(APPEND_CODE).toContain("material.stateHashAfter");
    expect(APPEND_CODE).toContain("yearRecord.chainHash");
    expect(APPEND_CODE).toContain("commandRecord.commandHash");
  });

  it("本模組入口簽章固定為三個參數", () => {
    expect(APPEND_SRC).toContain("export function appendP3ELedgerTransition(");
    const signature = APPEND_CODE.slice(
      APPEND_CODE.indexOf("export function appendP3ELedgerTransition(")
    );
    expect(signature.slice(0, signature.indexOf(")"))).toContain("previousState");
    expect(signature.slice(0, signature.indexOf(")"))).toContain("command");
    expect(signature.slice(0, signature.indexOf(")"))).toContain("nextCoreDraft");
  });

  it("本模組輸出固定三項：state／commandRecord／yearRecord", () => {
    expect(APPEND_SRC).toContain("state: P3ELifeState");
    expect(APPEND_SRC).toContain("commandRecord: P3ECommandRecord");
    expect(APPEND_SRC).toContain("yearRecord: P3EYearLedgerRecord");
  });

  it("正式模組保留來源紀錄，且只依賴既有正式原語", () => {
    // 來源紀錄（候選檔名＋SHA）保留在檔頭，但可執行程式碼不得再引用任何 candidate 模組。
    expect(APPEND_SRC).toContain("H5-CTO-147-B");
    expect(APPEND_SRC).toContain("ledger-append-v1-candidate");
    expect(APPEND_CODE).not.toContain("candidate");
    expect(APPEND_CODE).not.toContain("v11");
    // 正式檔名等價斷言：barrel 不得出現本模組。
    expect(BARREL_SRC).not.toContain("ledger-append");
  });

  it("模組的 continuity import 指向正式 ./ledger-continuity", () => {
    expect(APPEND_SRC).toContain('from "./ledger-continuity"');
    expect(APPEND_SRC).not.toContain('from "./ledger-continuity-v11-candidate"');
  });
});

/* ================================================================== */
/* 六、正式主線新增：money-effects 真實管線回歸（H5-CTO-155-A）        */
/* ================================================================== */

describe("P3-E.1b-2j money-effects 真實管線回歸", () => {
  it("A. 決策選項 rent 改動 annualExpenseMicroUsd → 完整 append 成功且保留 +9,000,000", () => {
    // 全程走正式原語：pending State → resolveP3EDecisionChoice(rent)
    // → assembleP3EDecisionStateCoreDraft → appendP3ELedgerTransition
    const choicePrevious = stateAt(5, { pack: packDecision });
    const pendingState = pendingStateFromAnnual(
      choicePrevious,
      resolveP3EAnnualPendingDecision({
        state: choicePrevious,
        eventPack: packDecision,
        deathPack,
        contentMode: "standard"
      })
    );
    const draft = decisionDraft(pendingState, packDecision, "rent");

    const baseExpense =
      contracts.P3E_EXPENSE_BASE_MICRO_USD + BigInt(pendingState.age) * contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD;
    expect(pendingState.assets.annualExpenseMicroUsd).toBe(baseExpense);
    expect(draft.assets.annualExpenseMicroUsd).toBe(baseExpense + 9_000_000n);

    const result = appendP3ELedgerTransition(pendingState, { type: "CHOOSE_DECISION", optionId: "rent" }, draft);

    // 最終 State 成功封存（append 內部已跑 readP3EState），且 effects 後金額完整保留
    expect(result.state.assets.annualExpenseMicroUsd).toBe(baseExpense + 9_000_000n);
    expect(result.state.phase).toBe("life");
    expect(result.state.pendingDecision).toBeNull();

    // 三份輸出交叉連結一致
    expect(result.commandRecord.command).toEqual({ type: "CHOOSE_DECISION", optionId: "rent" });
    expect(result.commandRecord.stateHashBefore).toBe(pendingState.stateHash);
    expect(result.commandRecord.stateHashAfter).toBe(result.state.stateHash);
    expect(result.yearRecord.commandHash).toBe(result.commandRecord.commandHash);
    expect(result.yearRecord.stateHashAfter).toBe(result.state.stateHash);
    expect(result.yearRecord.chainHash).toBe(result.state.heads.hashChain);
    expect(result.yearRecord.snapshotHash).toBe(result.state.heads.lastSnapshotHash);
    expect(result.yearRecord.deltaHash).toBe(result.state.heads.lastDeltaHash);
    expect(result.yearRecord.entryHash).toBe(result.state.heads.lastEntryHash);
    expect(result.state.commandLog.count).toBe(result.yearRecord.index);
    expect(result.state.commandLog.headHash).toBe(result.commandRecord.commandHash);

    // 輸出深層凍結
    expect(isDeepFrozen(result)).toBe(true);
  });

  it("B. 年度事件增加 annualIncomeMicroUsd 5,000,000 → 完整 append 成功且保留 effect", () => {
    const packIncomeEffect = repairedEventPack([
      {
        ...cloneEvent("ev.any.setback"),
        eventId: "ev.money.income-boost",
        effects: [{ type: "money", field: "annualIncomeMicroUsd", deltaMicroUsd: "5000000" }]
      }
    ]);
    const previous = stateAt(5, { pack: packIncomeEffect });
    // 走正式年度流程：annual stage → assembleP3EAnnualStateCoreDraft → append
    const draft = annualDraft(previous, packIncomeEffect);

    const baseIncome =
      contracts.P3E_INCOME_BASE_MICRO_USD + BigInt(draft.age) * contracts.P3E_INCOME_PER_YEAR_MICRO_USD;
    expect(draft.assets.annualIncomeMicroUsd).toBe(baseIncome + 5_000_000n);

    const result = appendP3ELedgerTransition(previous, ADVANCE, draft);

    expect(result.state.assets.annualIncomeMicroUsd).toBe(baseIncome + 5_000_000n);
    expect(result.commandRecord.prevCommandHash).toBe(previous.commandLog.headHash);
    expect(result.yearRecord.prevChainHash).toBe(previous.heads.hashChain);
    expect(result.commandRecord.stateHashAfter).toBe(result.state.stateHash);
    expect(result.yearRecord.entryHash).toBe(result.state.heads.lastEntryHash);
    expect(isDeepFrozen(result)).toBe(true);
  });
});