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
import { isP3EError } from "../src/errors";
import { createP3ECommandRecord, type P3ECommandRecord } from "../src/command-record";
import { computeP3EYearChainHash, computeP3EYearEntryHash } from "../src/year-ledger-hash";
import {
  resolveP3EAnnualPendingDecision,
  type P3EAnnualPendingDecisionStage
} from "../src/pending-decision-persistence";
import { validateP3ELedgerContinuity } from "../src/ledger-continuity";
import * as barrel from "../src/index";
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * P3-E Ledger Continuity Preconditions 正式測試（H5-CTO-149-A 整合）。
 *
 * 來源：WorkBuddy 候選 `ledger-continuity-v11-candidate.test.ts`
 * （SHA-256 `a74eb6db7c2a198dc13d50ba8113a23757f0b588a4d659b1c8f8e0241cada512`，
 * 經 H5-CTO-143-B-R1／H5-CTO-149-A 核准）。正式化只改 import／原始碼掃描路徑、
 * `candidate` 字樣與註解排版；**62 項語意全部保留**。
 *
 * 期望值一律用**正式原語**獨立重算（`computeP3EStateHash`／`createP3ECommandRecord`／
 * `computeP3EYearEntryHash`／`computeP3EYearChainHash`），不用被測函式自己的輸出當答案。
 *
 * 本檔**不**重建任何 shape／hash 驗證演算法：所有 command／year record 的合法性
 * 都交給正式的 `readP3ECommandRecord`／`verifyP3EYearLedgerRecord`。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const CONTINUITY_SRC = readFileSync(
  join(ROOT, "packages/simulation/src/ledger-continuity.ts"),
  "utf8"
);
const CONTINUITY_CODE = CONTINUITY_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

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
const eventPack: ValidatedEventPack = validateEventPack({
  manifest: rawEventManifest,
  events: rawEvents
} as never);
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
/** 一般事件包（無 decision）。 */
const packPlain = repairedEventPack([cloneEvent("ev.any.setback")]);
/** 含 flag 效果的事件包。 */
const packFlag = repairedEventPack([cloneEvent("ev.child.sibling-arrives")]);
/** 沒有任何候選事件的事件包。 */
const packNoCandidates = repairedEventPack([cloneEvent("ev.child.first-word")]);

const SEED = "p3e-136-ledger-continuity-v1";
const peerGroup = buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never);
const certificate = createBirthCertificate(base, identityPack, peerGroup, SEED);

const genesisState = createP3EGenesis({
  masterSeed: SEED,
  basePack: base,
  identityPack,
  certificate,
  eventPack,
  deathPack
});

/**
 * 綁定 `packDecision` 的 genesis。
 *
 * 正式 `assertP3EEventBinding` 會檢查 state 的 pack 綁定與傳入的 pack 一致，
 * 因此要跑 decision 事件的年度管線，就必須有一個綁定同一個 pack 的 state。
 */
const genesisDecision = createP3EGenesis({
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

/** 重算 mortality hazard 為 0 的死亡包（讓 age 120 走 age_ceiling 而非自然死亡）。 */
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
    descriptor.recordCount = (datasets[datasetId] as { records: unknown[] }).records.length;
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
  const pack = options.pack ?? eventPack;
  const death = options.deathPackOverride ?? deathPack;
  const bound = bindEventPack(pack);
  const years = BigInt(age);
  const eventInitial = toWords(deriveEventRngState(LIFE_INITIAL, BIRTH_YEAR));
  const draft = {
    ...genesisState,
    currentYear: BIRTH_YEAR + age,
    age,
    phase: options.phase ?? (age >= contracts.P3E_MAX_AGE ? "death" : "life"),
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

/**
 * 任意 `commandLog.count` 的合法 state（重算 stateHash 保持自洽）。
 *
 * 正式契約 `P3E_MAX_COMMANDS = 4096`；`readP3EState` 允許 count 等於 4096。
 */
function stateWithCommandCount(
  age: number,
  count: number,
  options: StateOptions = {}
): contracts.P3ELifeState {
  const source = stateAt(age, options);
  const draft = {
    ...source,
    commandLog: { ...source.commandLog, count }
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

function annualStage(
  state: contracts.P3ELifeState,
  pack: ValidatedEventPack,
  death: typeof deathPack = deathPack
): P3EAnnualPendingDecisionStage {
  return resolveP3EAnnualPendingDecision({ state, eventPack: pack, deathPack: death, contentMode: "standard" });
}

/* --------------------- Command／Year Record 建構 --------------------- */

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);
const HEX_E = "e".repeat(64);
const HEX_F = "f".repeat(64);

interface ContinuityFixtureOptions {
  readonly previous?: contracts.P3ELifeState;
  readonly command?: unknown;
  readonly index?: number;
  readonly year?: number;
  readonly age?: number;
  readonly phase?: contracts.P3EPhase;
  readonly stateHashBefore?: string;
  readonly stateHashAfter?: string;
  readonly prevCommandHash?: string;
  readonly prevChainHash?: string;
  readonly rngBefore?: contracts.P3ERngState;
  readonly rngAfter?: contracts.P3ERngState;
  readonly snapshotHash?: string;
  readonly deltaHash?: string;
}

/**
 * 用正式原語獨立算出 entry／chain hash，組出合法的 Command Record 與 Year wrapper。
 *
 * 預設值全部**對齊 previous state**，因此預設就是一份合法的 continuity 輸入。
 */
function continuityFixture(
  options: ContinuityFixtureOptions = {}
): {
  previous: contracts.P3ELifeState;
  commandRecord: P3ECommandRecord;
  yearRecord: Dict;
  input: Dict;
} {
  const previous = options.previous ?? stateAt(5, { pack: packPlain });
  const index = options.index ?? previous.commandLog.count + 1;
  const year = options.year ?? previous.currentYear + 1;
  const age = options.age ?? previous.age + 1;
  const phase: contracts.P3EPhase = options.phase ?? "life";
  const stateHashBefore = options.stateHashBefore ?? previous.stateHash;
  const stateHashAfter = options.stateHashAfter ?? HEX_C;
  const prevCommandHash = options.prevCommandHash ?? previous.commandLog.headHash;
  const prevChainHash = options.prevChainHash ?? previous.heads.hashChain;
  const rngBefore = options.rngBefore ?? previous.rng;
  const rngAfter = options.rngAfter ?? previous.rng;
  const snapshotHash = options.snapshotHash ?? HEX_D;
  const deltaHash = options.deltaHash ?? HEX_E;
  const command = options.command ?? { type: "ADVANCE_YEAR", contentMode: "standard" };

  const entryHash = computeP3EYearEntryHash({
    index, year, age, phase, stateHashBefore, rngBefore, rngAfter, snapshotHash, deltaHash
  }) as contracts.P3EHex64;

  const commandRecord = createP3ECommandRecord({
    index,
    year,
    command,
    prevCommandHash,
    stateHashBefore,
    stateHashAfter,
    entryHash
  });

  const chainHash = computeP3EYearChainHash({
    prevChainHash, index, year, entryHash, stateHashAfter, commandHash: commandRecord.commandHash
  }) as contracts.P3EHex64;

  const record: Dict = {
    index, year, age, phase, stateHashBefore, stateHashAfter,
    rngBefore, rngAfter, snapshotHash, deltaHash,
    entryHash, commandHash: commandRecord.commandHash, prevChainHash, chainHash
  };
  const yearRecord: Dict = record;
  return { previous, commandRecord, yearRecord, input: { previousState: previous, commandRecord, yearRecord } };
}

/* ------------------------------ 輔助 ------------------------------- */

/** 基準 RNG（與 `stateAt(5)` 的 previous state 相同）。 */
function fixtureRng(): contracts.P3ERngState {
  return stateAt(5, { pack: packPlain }).rng;
}

/** 只改 life 游標的 state tuple。 */
function tamperLifeState(rng: contracts.P3ERngState): contracts.P3ERngState {
  return { ...rng, life: { ...rng.life, state: [99, 98, 97, 96] } };
}

/** 只改 events 游標的 state tuple。 */
function tamperEventsState(rng: contracts.P3ERngState): contracts.P3ERngState {
  return { ...rng, events: { ...rng.events, state: [1, 2, 3, 4] } };
}

/** 只改 death 游標的 state tuple。 */
function tamperDeathState(rng: contracts.P3ERngState): contracts.P3ERngState {
  return { ...rng, death: { ...rng.death, state: [5, 6, 7, 8] } };
}

/** 只改 life 游標的 initialState tuple。 */
function tamperLifeInitial(rng: contracts.P3ERngState): contracts.P3ERngState {
  return { ...rng, life: { ...rng.life, initialState: [71, 72, 73, 74] } };
}

/** 只改 events 游標的 initialState tuple。 */
function tamperEventsInitial(rng: contracts.P3ERngState): contracts.P3ERngState {
  return { ...rng, events: { ...rng.events, initialState: [81, 82, 83, 84] } };
}

/** 只改 death 游標的 initialState tuple。 */
function tamperDeathInitial(rng: contracts.P3ERngState): contracts.P3ERngState {
  return { ...rng, death: { ...rng.death, initialState: [91, 92, 93, 94] } };
}

/** 只改 life 游標的 semanticDraws。 */
function tamperLifeDraws(rng: contracts.P3ERngState): contracts.P3ERngState {
  return { ...rng, life: { ...rng.life, semanticDraws: rng.life.semanticDraws + 1 } };
}

/** 只改 events 游標的 u32Draws。 */
function tamperEventsDraws(rng: contracts.P3ERngState): contracts.P3ERngState {
  return { ...rng, events: { ...rng.events, u32Draws: rng.events.u32Draws + 2 } };
}

/** 只改 death 游標的 u32Draws。 */
function tamperDeathDraws(rng: contracts.P3ERngState): contracts.P3ERngState {
  return { ...rng, death: { ...rng.death, u32Draws: rng.death.u32Draws + 2 } };
}

/** 只改 life 游標的 domain（正式原語會擋下）。 */
function tamperLifeDomain(rng: contracts.P3ERngState): contracts.P3ERngState {
  return { ...rng, life: { ...rng.life, domain: "p3e/tampered" as never } };
}

/**
 * 只改 year record 側的 `stateHashBefore`，並重算 entry／chain hash，
 * 讓 year record 與 command record **各自自洽**——這樣正式原語會放行，
 * 錯誤一定來自 Continuity 層的 `stateHashBefore` 檢查。
 */
function continuityFixtureWithYearStateHashBefore(
  fixture: { previous: contracts.P3ELifeState; commandRecord: P3ECommandRecord; yearRecord: Dict },
  stateHashBefore: string
): Dict {
  const record = fixture.yearRecord as Dict;
  const nextRecord: Dict = { ...record, stateHashBefore };
  const entryHash = computeP3EYearEntryHash({
    index: record.index as number,
    year: record.year as number,
    age: record.age as number,
    phase: record.phase as contracts.P3EPhase,
    stateHashBefore,
    rngBefore: record.rngBefore as contracts.P3ERngState,
    rngAfter: record.rngAfter as contracts.P3ERngState,
    snapshotHash: record.snapshotHash as string,
    deltaHash: record.deltaHash as string
  }) as contracts.P3EHex64;
  const chainHash = computeP3EYearChainHash({
    prevChainHash: record.prevChainHash as string,
    index: record.index as number,
    year: record.year as number,
    entryHash,
    stateHashAfter: record.stateHashAfter as string,
    commandHash: record.commandHash as string
  }) as contracts.P3EHex64;
  // entryHash 也必須跟著更新，否則正式原語會先報 entryHash 不符。
  const withEntry: Dict = { ...nextRecord, entryHash, chainHash };
  return {
    previousState: fixture.previous,
    commandRecord: fixture.commandRecord,
    yearRecord: withEntry
  };
}

function expectContinuityError(run: () => unknown, code: string, path: string): void {
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

/** 以路徑覆寫深層欄位（測試用；不修改原始 fixture）。 */
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

/** 輸出是否與輸入共享同一個物件／陣列參考。 */
function sharesReference(output: unknown, input: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  if (typeof input !== "object" || input === null) return false;
  if (output === input) return true;
  if (Array.isArray(output) && Array.isArray(input)) {
    return output.some((item, index) => sharesReference(item, input[index]));
  }
  const outRecord = output as Dict;
  const inRecord = input as Dict;
  return Object.keys(outRecord).some((key) => sharesReference(outRecord[key], inRecord[key]));
}

/* ================================================================== */
/* 一、正向案例                                                        */
/* ================================================================== */

describe("H5-CTO-143-B-R1 Continuity 正向案例", () => {
  it("ADVANCE_YEAR → life", () => {
    const fixture = continuityFixture();
    const facts = validateP3ELedgerContinuity(fixture.input);
    // previous 的 commandLog.count 是 0（genesis 初始），所以 index = 1。
    expect(facts.index).toBe(1);
    expect(facts.commandType).toBe("ADVANCE_YEAR");
    expect(facts.resultingPhase).toBe("life");
    expect(facts.previousState.stateHash).toBe(fixture.previous.stateHash);
    expect(facts.commandRecord.commandHash).toBe(fixture.commandRecord.commandHash);
    expect(facts.yearRecord.entryHash).toBe(fixture.commandRecord.entryHash);
  });

  it("ADVANCE_YEAR → pending_decision", () => {
    const fixture = continuityFixture({ phase: "pending_decision" });
    const facts = validateP3ELedgerContinuity(fixture.input);
    expect(facts.commandType).toBe("ADVANCE_YEAR");
    expect(facts.resultingPhase).toBe("pending_decision");
  });

  it("ADVANCE_YEAR → death", () => {
    const fixture = continuityFixture({ phase: "death" });
    const facts = validateP3ELedgerContinuity(fixture.input);
    expect(facts.commandType).toBe("ADVANCE_YEAR");
    expect(facts.resultingPhase).toBe("death");
  });

  it("CHOOSE_DECISION → life", () => {
    const stage = annualStage(genesisDecision, packDecision);
    const pendingState = pendingStateFromAnnual(genesisDecision, stage);
    const optionId = pendingState.pendingDecision?.optionIds[0] as string;
    const fixture = continuityFixture({
      previous: pendingState,
      command: { type: "CHOOSE_DECISION", optionId },
      year: pendingState.currentYear,
      age: pendingState.age,
      phase: "life",
      rngAfter: pendingState.rng
    });
    const facts = validateP3ELedgerContinuity(fixture.input);
    expect(facts.commandType).toBe("CHOOSE_DECISION");
    expect(facts.resultingPhase).toBe("life");
    expect(facts.index).toBe(1);
  });
});

/* ================================================================== */
/* 二、連續性反例                                                      */
/* ================================================================== */

describe("H5-CTO-143-B-R1 Continuity 連續性反例", () => {
  // 這些反例都**自洽**：entry／command／chain hash 都用正式原語重算過，
  // 因此能通過正式 `verifyP3EYearLedgerRecord`，錯誤一定來自 Continuity 層。
  it("index 不連續", () => {
    const fixture = continuityFixture({ index: 99 });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_HISTORY", "ledgerContinuity.index");
  });

  it("prevCommandHash 不一致", () => {
    const fixture = continuityFixture({ prevCommandHash: HEX_A });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_HISTORY",
      "ledgerContinuity.prevCommandHash"
    );
  });

  it("command record 的 stateHashBefore 不一致", () => {
    const fixture = continuityFixture({ stateHashBefore: HEX_B });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_HISTORY",
      "ledgerContinuity.stateHashBefore"
    );
  });

  it("year record 單側 stateHashBefore 不一致 → 正式交叉連結原樣外露", () => {
    const fixture = continuityFixture();
    // 只改 year record 的 stateHashBefore，並重算 entry／chain hash 讓它自洽；
    // 但 command↔year 的交叉連結屬於正式 verify 的職責，因此由它先擋下。
    const broken = continuityFixtureWithYearStateHashBefore(fixture, HEX_B);
    expectContinuityError(
      () => validateP3ELedgerContinuity(broken),
      "E_P3E_HISTORY",
      "yearLedgerRecord.commandRecord"
    );
  });

  it("prevChainHash 不一致", () => {
    const fixture = continuityFixture({ prevChainHash: HEX_F });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_HISTORY",
      "ledgerContinuity.prevChainHash"
    );
  });

  it("rngBefore 的 life tuple 不一致", () => {
    const fixture = continuityFixture({ rngBefore: tamperLifeState(fixtureRng()) });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_RNG", "ledgerContinuity.rngBefore");
  });

  it("rngBefore 的 events tuple 不一致", () => {
    const fixture = continuityFixture({ rngBefore: tamperEventsState(fixtureRng()) });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_RNG", "ledgerContinuity.rngBefore");
  });

  it("rngBefore 的 death tuple 不一致", () => {
    const fixture = continuityFixture({ rngBefore: tamperDeathState(fixtureRng()) });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_RNG", "ledgerContinuity.rngBefore");
  });

  it("rngBefore 的 life initialState 不一致", () => {
    const fixture = continuityFixture({ rngBefore: tamperLifeInitial(fixtureRng()) });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_RNG", "ledgerContinuity.rngBefore");
  });

  it("rngBefore 的 events initialState 不一致", () => {
    const fixture = continuityFixture({ rngBefore: tamperEventsInitial(fixtureRng()) });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_RNG", "ledgerContinuity.rngBefore");
  });

  it("rngBefore 的 death initialState 不一致", () => {
    const fixture = continuityFixture({ rngBefore: tamperDeathInitial(fixtureRng()) });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_RNG", "ledgerContinuity.rngBefore");
  });

  it("rngBefore 的 semanticDraws 不一致", () => {
    const fixture = continuityFixture({ rngBefore: tamperLifeDraws(fixtureRng()) });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_RNG", "ledgerContinuity.rngBefore");
  });

  it("rngBefore 的 events u32Draws 不一致", () => {
    const fixture = continuityFixture({ rngBefore: tamperEventsDraws(fixtureRng()) });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_RNG", "ledgerContinuity.rngBefore");
  });

  it("rngBefore 的 death u32Draws 不一致", () => {
    const fixture = continuityFixture({ rngBefore: tamperDeathDraws(fixtureRng()) });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_RNG", "ledgerContinuity.rngBefore");
  });

  it("rngBefore 的 domain 被篡改 → 正式原語先擋下（錯誤原樣外露）", () => {
    const fixture = continuityFixture({ rngBefore: tamperLifeDomain(fixtureRng()) });
    let caught: unknown = null;
    try {
      validateP3ELedgerContinuity(fixture.input);
    } catch (error) {
      caught = error;
    }
    expect(isP3EError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("E_P3E_HISTORY");
  });
});

/* ================================================================== */
/* 三、命令合法性矩陣                                                  */
/* ================================================================== */

describe("H5-CTO-143-B-R1 命令合法性矩陣", () => {
  const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" };

  function pendingPrevious(): contracts.P3ELifeState {
    const stage = annualStage(genesisDecision, packDecision);
    expect(stage.pendingDecisionSummary).not.toBeNull();
    return pendingStateFromAnnual(genesisDecision, stage);
  }

  it("ADVANCE_YEAR：previous 是 pending_decision → 拒絕", () => {
    const pending = pendingPrevious();
    const fixture = continuityFixture({
      previous: pending,
      command: ADVANCE,
      year: pending.currentYear + 1,
      age: pending.age + 1,
      phase: "life",
      rngAfter: pending.rng
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("ADVANCE_YEAR：previous 綁定無候選事件的事件包 → 連續性仍成立（本模組不涉事件選取）", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const fixture = continuityFixture({ previous });
    const facts = validateP3ELedgerContinuity(fixture.input);
    expect(facts.commandType).toBe("ADVANCE_YEAR");
    expect(facts.previousState.packs.events.eventPackId).toBe(packNoCandidates.manifest.eventPackId);
    expect(facts.previousState.packs.events.eventCount).toBe(packNoCandidates.events.length);
  });

  it("ADVANCE_YEAR：previous 綁定含 flag 事件的事件包 → 連續性成立且 flags 原樣保留", () => {
    const previous = stateAt(5, { pack: packFlag });
    const fixture = continuityFixture({ previous });
    const facts = validateP3ELedgerContinuity(fixture.input);
    expect(facts.commandType).toBe("ADVANCE_YEAR");
    expect(facts.previousState.packs.events.eventPackId).toBe(packFlag.manifest.eventPackId);
    expect(facts.previousState.flags).toEqual(["p3e:flag-a"]);
  });

  it("ADVANCE_YEAR：previous 是 death → 拒絕", () => {
    // age 50 的 death phase（正式規則只要求 age 0 是 life、age 120 是 death）。
    const dead = stateAt(50, { pack: packPlain, phase: "death" });
    const fixture = continuityFixture({
      previous: dead,
      command: ADVANCE,
      year: dead.currentYear + 1,
      age: dead.age + 1,
      phase: "death",
      rngAfter: dead.rng
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("ADVANCE_YEAR：previous.age = 120 → 拒絕", () => {
    const dead = stateAt(contracts.P3E_MAX_AGE, {
      pack: packPlain,
      deathPackOverride: deathPackNoHazardAt120
    });
    // year record 的 age 必須 ≤ 120，所以這裡給 120（不是 121）。
    const fixture = continuityFixture({
      previous: dead,
      command: ADVANCE,
      year: dead.currentYear + 1,
      age: contracts.P3E_MAX_AGE,
      phase: "death",
      rngAfter: dead.rng
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("ADVANCE_YEAR：year 不對 → 拒絕", () => {
    const fixture = continuityFixture({ year: 1999 });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_HISTORY",
      "ledgerContinuity.yearAge"
    );
  });

  it("ADVANCE_YEAR：age 不對 → 拒絕", () => {
    const fixture = continuityFixture({ age: 99 });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_HISTORY",
      "ledgerContinuity.yearAge"
    );
  });

  it("CHOOSE_DECISION：previous 是 life → 拒絕", () => {
    const previous = stateAt(5, { pack: packPlain });
    const fixture = continuityFixture({
      previous,
      command: { type: "CHOOSE_DECISION", optionId: "rent" },
      year: previous.currentYear,
      age: previous.age,
      phase: "life",
      rngAfter: previous.rng
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("CHOOSE_DECISION：previous 是 death → 拒絕", () => {
    const dead = stateAt(50, { pack: packPlain, phase: "death" });
    const fixture = continuityFixture({
      previous: dead,
      command: { type: "CHOOSE_DECISION", optionId: "rent" },
      year: dead.currentYear,
      age: dead.age,
      phase: "life",
      rngAfter: dead.rng
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("CHOOSE_DECISION：optionId 不存在 → 拒絕", () => {
    const pending = pendingPrevious();
    const fixture = continuityFixture({
      previous: pending,
      command: { type: "CHOOSE_DECISION", optionId: "buy-house" },
      year: pending.currentYear,
      age: pending.age,
      phase: "life",
      rngAfter: pending.rng
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("CHOOSE_DECISION：另一個 decision 的 optionId → 拒絕", () => {
    const pending = pendingPrevious();
    const fixture = continuityFixture({
      previous: pending,
      command: { type: "CHOOSE_DECISION", optionId: "study" },
      year: pending.currentYear,
      age: pending.age,
      phase: "life",
      rngAfter: pending.rng
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("CHOOSE_DECISION：大小寫不同的 optionId → 拒絕（由正式原語更早攔截）", () => {
    const pending = pendingPrevious();
    const optionId = (pending.pendingDecision?.optionIds[0] as string).toUpperCase();
    // 正式 `readP3ECommand` 的 `OPTION_ID_PATTERN` 只允許小寫，因此大寫 optionId
    // 在**更早的層級**就被擋下；底層錯誤原樣外露，不被本模組重包。
    expectContinuityError(
      () =>
        createP3ECommandRecord({
          index: pending.commandLog.count + 1,
          year: pending.currentYear,
          command: { type: "CHOOSE_DECISION", optionId },
          prevCommandHash: pending.commandLog.headHash,
          stateHashBefore: pending.stateHash,
          stateHashAfter: HEX_C,
          entryHash: HEX_D
        }),
      "E_P3E_COMMAND",
      "commandRecord.command"
    );
  });

  it("CHOOSE_DECISION：格式合法但不是清單內的 optionId → 本模組擋下", () => {
    // `Rent` 這種大寫形式會被正式原語擋下；但 `rent-2`、`rent2` 這類**格式合法**
    // 卻不在 optionIds 內的形式，必須由本模組的 `optionIds.includes` 擋下。
    const pending = pendingPrevious();
    for (const optionId of ["rent-2", "rent2", "rent_x"]) {
      const fixture = continuityFixture({
        previous: pending,
        command: { type: "CHOOSE_DECISION", optionId },
        year: pending.currentYear,
        age: pending.age,
        phase: "life",
        rngAfter: pending.rng
      });
      expectContinuityError(
        () => validateP3ELedgerContinuity(fixture.input),
        "E_P3E_COMMAND",
        "ledgerContinuity.command"
      );
    }
  });

  it("CHOOSE_DECISION：year 不對 → 拒絕", () => {
    const pending = pendingPrevious();
    const fixture = continuityFixture({
      previous: pending,
      command: { type: "CHOOSE_DECISION", optionId: pending.pendingDecision?.optionIds[0] as string },
      year: pending.currentYear + 1,
      age: pending.age,
      phase: "life",
      rngAfter: pending.rng
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_HISTORY",
      "ledgerContinuity.yearAge"
    );
  });

  it("CHOOSE_DECISION：age 不對 → 拒絕", () => {
    const pending = pendingPrevious();
    const fixture = continuityFixture({
      previous: pending,
      command: { type: "CHOOSE_DECISION", optionId: pending.pendingDecision?.optionIds[0] as string },
      year: pending.currentYear,
      age: pending.age + 1,
      phase: "life",
      rngAfter: pending.rng
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_HISTORY",
      "ledgerContinuity.yearAge"
    );
  });

  it("CHOOSE_DECISION：phase 不是 life → 拒絕", () => {
    const pending = pendingPrevious();
    const fixture = continuityFixture({
      previous: pending,
      command: { type: "CHOOSE_DECISION", optionId: pending.pendingDecision?.optionIds[0] as string },
      year: pending.currentYear,
      age: pending.age,
      phase: "pending_decision",
      rngAfter: pending.rng
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_HISTORY",
      "ledgerContinuity.yearAge"
    );
  });

  it("CHOOSE_DECISION：rngAfter 有任何變動 → 拒絕", () => {
    const pending = pendingPrevious();
    const fixture = continuityFixture({
      previous: pending,
      command: { type: "CHOOSE_DECISION", optionId: pending.pendingDecision?.optionIds[0] as string },
      year: pending.currentYear,
      age: pending.age,
      phase: "life",
      rngAfter: tamperLifeDraws(pending.rng)
    });
    expectContinuityError(() => validateP3ELedgerContinuity(fixture.input), "E_P3E_RNG", "ledgerContinuity.rngAfter");
  });
});

/* ================================================================== */
/* 四、輸入信任邊界                                                    */
/* ================================================================== */

describe("H5-CTO-143-B-R1 輸入信任邊界", () => {
  it("輸入不是 exact-object → 拒絕", () => {
    expectContinuityError(() => validateP3ELedgerContinuity(null), "E_P3E_HISTORY", "ledgerContinuity.input");
    expectContinuityError(() => validateP3ELedgerContinuity([]), "E_P3E_HISTORY", "ledgerContinuity.input");
    expectContinuityError(() => validateP3ELedgerContinuity("x"), "E_P3E_HISTORY", "ledgerContinuity.input");
  });

  it("多一個欄位 → 拒絕", () => {
    const fixture = continuityFixture();
    const broken = { ...fixture.input, extra: 1 };
    expectContinuityError(() => validateP3ELedgerContinuity(broken), "E_P3E_HISTORY", "ledgerContinuity.input");
  });

  it("少一個欄位 → 拒絕", () => {
    const fixture = continuityFixture();
    const rest = { ...fixture.input };
    delete rest.previousState;
    expectContinuityError(() => validateP3ELedgerContinuity(rest), "E_P3E_HISTORY", "ledgerContinuity.input");
  });

  it("原型不是 Object.prototype（class 實例）→ 拒絕", () => {
    const fixture = continuityFixture();
    const broken = Object.assign(new (class ContinuityInput {})(), fixture.input);
    expectContinuityError(() => validateP3ELedgerContinuity(broken), "E_P3E_HISTORY", "ledgerContinuity.input");
  });

  it("原型是 null（Object.create(null)）→ 依正式慣例允許", () => {
    // 正式 `readOwnDataRecord` 只擋「既不是 Object.prototype 也不是 null」的原型；
    // null 原型是合法輸入，因此本模組也必須放行。
    const fixture = continuityFixture();
    const accepted = Object.assign(Object.create(null) as Dict, fixture.input);
    const facts = validateP3ELedgerContinuity(accepted);
    expect(facts.commandType).toBe("ADVANCE_YEAR");
  });

  it("hidden（非列舉）欄位 → 拒絕", () => {
    const fixture = continuityFixture();
    const broken = { ...fixture.input };
    Object.defineProperty(broken, "hidden", { value: 1, enumerable: false });
    expectContinuityError(() => validateP3ELedgerContinuity(broken), "E_P3E_HISTORY", "ledgerContinuity.input");
  });

  it("symbol 鍵 → 拒絕", () => {
    const fixture = continuityFixture();
    const broken = { ...fixture.input, [Symbol("s")]: 1 };
    expectContinuityError(() => validateP3ELedgerContinuity(broken), "E_P3E_HISTORY", "ledgerContinuity.input");
  });

  it("accessor（getter）→ 拒絕，且 getter 不被執行", () => {
    const fixture = continuityFixture();
    let executed = false;
    const broken = { ...fixture.input };
    Object.defineProperty(broken, "previousState", {
      get: () => {
        executed = true;
        return fixture.previous;
      },
      enumerable: true,
      configurable: true
    });
    expectContinuityError(() => validateP3ELedgerContinuity(broken), "E_P3E_HISTORY", "ledgerContinuity.input");
    expect(executed).toBe(false);
  });

  it("revoked Proxy → 拒絕", () => {
    const fixture = continuityFixture();
    const { proxy, revoke } = Proxy.revocable(fixture.input, {});
    revoke();
    expectContinuityError(() => validateP3ELedgerContinuity(proxy), "E_P3E_HISTORY", "ledgerContinuity.input");
  });

  it("底層原語的錯誤保持原樣（不被重包）", () => {
    const fixture = continuityFixture();
    const broken = patch(fixture.input, ["commandRecord", "commandHash"], HEX_A) as never;
    let caught: unknown = null;
    try {
      validateP3ELedgerContinuity(broken);
    } catch (error) {
      caught = error;
    }
    expect(isP3EError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("E_P3E_COMMAND");
    expect((caught as { path: string }).path).toBe("commandRecord.commandHash");
  });
});

/* ================================================================== */
/* 五、yearRecord 介面契約（輸入契約）                                  */
/* ================================================================== */

describe("H5-CTO-143-B-R1 yearRecord 介面契約", () => {
  const YEAR_RECORD_KEYS = [
    "index", "year", "age", "phase",
    "stateHashBefore", "stateHashAfter",
    "rngBefore", "rngAfter",
    "snapshotHash", "deltaHash",
    "entryHash", "commandHash", "prevChainHash", "chainHash"
  ];

  it("正向案例：input.yearRecord 直接是正式 14 欄，沒有 record 外層欄位", () => {
    const fixture = continuityFixture();
    const record = fixture.input.yearRecord as Dict;
    const keys = Object.keys(record);
    expect(keys).toHaveLength(14);
    expect([...keys].sort()).toEqual([...YEAR_RECORD_KEYS].sort());
    expect(keys).not.toContain("record");
    expect(Object.prototype.hasOwnProperty.call(record, "record")).toBe(false);
  });

  it("yearRecord 帶 accessor（getter）→ getter 呼叫次數 0，只回固定 P3EError", () => {
    const fixture = continuityFixture();
    const source = fixture.input.yearRecord as Dict;
    let getterCalls = 0;
    const withGetter: Dict = {};
    for (const key of Object.keys(source)) {
      Object.defineProperty(withGetter, key, {
        enumerable: true,
        configurable: true,
        get() {
          getterCalls += 1;
          return source[key];
        }
      });
    }
    expectContinuityError(
      () => validateP3ELedgerContinuity({ ...fixture.input, yearRecord: withGetter }),
      "E_P3E_HISTORY",
      "yearLedgerRecord"
    );
    expect(getterCalls).toBe(0);
  });

  it("yearRecord 是 revoked Proxy → 不外洩原生例外，只回固定 P3EError", () => {
    const fixture = continuityFixture();
    const revocable = Proxy.revocable(fixture.input.yearRecord as Dict, {});
    revocable.revoke();
    let caught: unknown = null;
    try {
      validateP3ELedgerContinuity({ ...fixture.input, yearRecord: revocable.proxy });
    } catch (error) {
      caught = error;
    }
    expect(isP3EError(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as { code: string }).code).toBe("E_P3E_HISTORY");
    expect((caught as { path: string }).path).toBe("yearLedgerRecord");
  });

  it("yearRecord 是舊的 { record: 合法Record } wrapper → 被正式 Year Record reader 拒絕", () => {
    const fixture = continuityFixture();
    const legacyWrapper = { record: fixture.input.yearRecord };
    expectContinuityError(
      () => validateP3ELedgerContinuity({ ...fixture.input, yearRecord: legacyWrapper }),
      "E_P3E_HISTORY",
      "yearLedgerRecord"
    );
  });

  it("入口不再讀 wrapper?.record（source 不得出現巢狀 wrapper 取用）", () => {
    expect(CONTINUITY_SRC).not.toContain("wrapper?.record");
    expect(CONTINUITY_SRC).not.toContain("wrapper.record");
    expect(CONTINUITY_SRC).toContain("record: raw.yearRecord");
  });
});

/* ================================================================== */
/* 六、Command 數量上限                                                  */
/* ================================================================== */

describe("H5-CTO-143-B-R1 Command 數量上限", () => {
  it("commandLog.count = 4095 → 下一筆 index 4096 可通過", () => {
    const previous = stateWithCommandCount(5, 4095);
    const fixture = continuityFixture({ previous });
    expect(fixture.commandRecord.index).toBe(4096);
    const facts = validateP3ELedgerContinuity(fixture.input);
    expect(facts.index).toBe(4096);
    expect(facts.commandType).toBe("ADVANCE_YEAR");
  });

  it("commandLog.count = 4096 → 拒絕，不得建立 index 4097", () => {
    const previous = stateWithCommandCount(5, 4096);
    const fixture = continuityFixture({ previous });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_HISTORY",
      "ledgerContinuity.index"
    );
  });

  it("拒絕發生在任何後續 continuity 比對之前（其他條件全錯時仍先報 index）", () => {
    const previous = stateWithCommandCount(5, 4096);
    const fixture = continuityFixture({
      previous,
      prevCommandHash: HEX_A,
      prevChainHash: HEX_B,
      stateHashBefore: HEX_C
    });
    expectContinuityError(
      () => validateP3ELedgerContinuity(fixture.input),
      "E_P3E_HISTORY",
      "ledgerContinuity.index"
    );
  });

  it("commandLog.count 上限取自正式契約 P3E_MAX_COMMANDS", () => {
    expect(contracts.P3E_MAX_COMMANDS).toBe(4096);
    expect(CONTINUITY_SRC).toContain("P3E_MAX_COMMANDS");
  });
});

/* ================================================================== */
/* 五、共同契約                                                        */
/* ================================================================== */

describe("H5-CTO-143-B-R1 共同契約", () => {
  it("輸入不被修改", () => {
    const fixture = continuityFixture();
    const before = stable(fixture.input);
    validateP3ELedgerContinuity(fixture.input);
    expect(stable(fixture.input)).toBe(before);
  });

  it("輸出深層凍結", () => {
    const facts = validateP3ELedgerContinuity(continuityFixture().input);
    expect(isDeepFrozen(facts)).toBe(true);
    expect(isDeepFrozen(facts.previousState)).toBe(true);
    expect(isDeepFrozen(facts.commandRecord)).toBe(true);
    expect(isDeepFrozen(facts.yearRecord)).toBe(true);
  });

  it("輸出與輸入零共享", () => {
    const fixture = continuityFixture();
    const facts = validateP3ELedgerContinuity(fixture.input);
    expect(sharesReference(facts.previousState, fixture.previous)).toBe(false);
    expect(sharesReference(facts.commandRecord, fixture.commandRecord)).toBe(false);
    expect(sharesReference(facts.yearRecord, fixture.yearRecord)).toBe(false);
  });

  it("不進公開 barrel", () => {
    const exported = barrel as unknown as Record<string, unknown>;
    expect(exported.validateP3ELedgerContinuity).toBeUndefined();
    expect(exported.P3ELedgerContinuityFacts).toBeUndefined();
  });

  it("不得出現 seal／append／codec／replay 或重算業務演算法", () => {
    const forbidden = [
      "sealP3EState",
      "createP3EGenesisIntegrity",
      "append",
      "encodeP3EState",
      "decodeP3EState",
      "replay",
      "resolveP3ERoll",
      "drawP3ERollDeltas",
      "selectEvent",
      "applyEventEffects",
      "evaluateAnnualDeath",
      "resolveP3EAnnualPendingDecision",
      "resolveP3EDecisionChoice",
      "computeP3EStateHash",
      "computeP3ECommandHash",
      "computeP3EYearEntryHash",
      "computeP3EYearChainHash"
    ];
    for (const identifier of forbidden) {
      expect(CONTINUITY_CODE).not.toContain(identifier);
    }
  });

  it("必須重用三個正式原語", () => {
    expect(CONTINUITY_SRC).toContain('from "./state-invariants"');
    expect(CONTINUITY_SRC).toContain('from "./command-record"');
    expect(CONTINUITY_SRC).toContain('from "./year-ledger-record"');
    expect(CONTINUITY_SRC).toContain("readP3EState");
    expect(CONTINUITY_SRC).toContain("readP3ECommandRecord");
    expect(CONTINUITY_SRC).toContain("verifyP3EYearLedgerRecord");
  });

  it("不使用 as unknown as P3ELifeState", () => {
    expect(CONTINUITY_SRC).not.toContain("as unknown as");
  });
});
