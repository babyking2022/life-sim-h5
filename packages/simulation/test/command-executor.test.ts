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
import { executeP3ECommand } from "../src/command-executor";
import { assembleP3EAnnualStateCoreDraft } from "../src/state-core-draft";
import { appendP3ELedgerTransition } from "../src/ledger-append";
import * as barrel from "../src/index";
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * H5-CTO-163-A：P3-E Command Executor V1 正式測試。
 *
 * 來源：WorkBuddy 候選 `command-executor-v1-candidate.test.ts`
 * （SHA-256 `088f56a1c653078285e7bb75fcba3ed663af4d0a471c07413ceb0479409b39b2`，
 * 經 H5-CTO-153-B 核准、H5-CTO-163-A 正式整合）。
 *
 * 期望值一律用**正式原語**獨立重算（`computeP3EStateHash` 等），不用被測函式自己的
 * 輸出當答案。本檔**不**重建任何 Roll／RNG／事件抽選／effects／mortality／
 * Core Draft／hash／record／continuity 演算法——全部交給正式原語與被測模組的編排。
 *
 * ## 2g 收支語意
 *
 * 本批已同步 2g 核可的 `state-invariants.ts`（年度收支不再必須等於基準公式），
 * 因此含 money effects 的 fixture（決策 `rent`：`annualExpenseMicroUsd` +9,000,000；
 * 年度事件改 `annualIncomeMicroUsd`）都是合法 state，並在最終 State **原樣保留**。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const EXECUTOR_SRC = readFileSync(
  join(ROOT, "packages/simulation/src/command-executor.ts"),
  "utf8"
);
const EXECUTOR_CODE = EXECUTOR_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
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
/** 年度 money effect：唯一事件把 annualIncomeMicroUsd +500,000。 */
const packMoneyIncome = repairedEventPack([
  {
    ...cloneEvent("ev.any.setback"),
    effects: [{ type: "money", field: "annualIncomeMicroUsd", deltaMicroUsd: "500000" }]
  }
]);

const SEED = "p3e-153-command-executor-v1";
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

/** 任意 age 的合法 state（RNG 游標、pack binding 全部自洽；2g 基線收支自由）。 */
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

/** 走正式年度流程取得 pending state（編排與被測模組相同，但由測試檔獨立呼叫）。 */
function pendingState(
  previous: contracts.P3ELifeState,
  pack: ValidatedEventPack
): contracts.P3ELifeState {
  return pendingStateFromAnnual(
    previous,
    resolveP3EAnnualPendingDecision({
      state: previous,
      eventPack: pack,
      deathPack,
      contentMode: "standard"
    })
  );
}

/* ------------------------------ 輔助 ------------------------------- */

/** 執行一次命令交易（包裝成被測入口的四欄 input）。 */
function execute(
  state: contracts.P3ELifeState,
  command: Dict,
  pack: ValidatedEventPack,
  death: typeof deathPack = deathPack
): ReturnType<typeof executeP3ECommand> {
  return executeP3ECommand({ state, eventPack: pack, deathPack: death, command });
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

/** 精確斷言：code＋path＋訊息格式，且不是 TypeError／RangeError。 */
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
  expect(caught instanceof SyntaxError).toBe(false);
}

/** 僅斷言 code（底層原語的 path 由正式檔把關，不由本模組重複規格）。 */
function expectP3ECode(run: () => unknown, code: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(isP3EError(caught), `${code}`).toBe(true);
  expect((caught as P3EError).code).toBe(code);
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
  expect(caught instanceof SyntaxError).toBe(false);
}

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;
const ADVANCE_GUARDIAN = { type: "ADVANCE_YEAR", contentMode: "guardian" } as const;

/* ================================================================== */
/* 一、正向流程                                                        */
/* ================================================================== */

describe("H5-CTO-163-A Command Executor V1：正向流程", () => {
  it("ADVANCE_YEAR → life：三項輸出全部建立", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const result = execute(previous, { ...ADVANCE }, packNoCandidates);

    expect(result.state.phase).toBe("life");
    expect(result.state.age).toBe(previous.age + 1);
    expect(result.state.currentYear).toBe(previous.currentYear + 1);
    expect(result.commandRecord.command).toEqual({ type: "ADVANCE_YEAR", contentMode: "standard" });
    expect(result.commandRecord.index).toBe(1);
    expect(result.yearRecord.phase).toBe("life");
    expect(Object.keys(result).sort()).toEqual(["commandRecord", "outcome", "state", "yearRecord"]);
  });

  it("ADVANCE_YEAR → pending_decision：pendingDecision 摘要隨之封存", () => {
    const previous = genesisDecision;
    const result = execute(previous, { ...ADVANCE }, packDecision);

    expect(result.state.phase).toBe("pending_decision");
    expect(result.state.pendingDecision).not.toBeNull();
    expect(result.state.pendingDecision?.eventId).toBe("ev.adult.housing-choice");
    expect(result.yearRecord.phase).toBe("pending_decision");
  });

  it("ADVANCE_YEAR → mortality death（自然死亡）：phase 與 age 一致封存", () => {
    const previous = stateAt(76, { pack: packPlain });
    const result = execute(previous, { ...ADVANCE }, packPlain);

    expect(result.state.phase).toBe("death");
    expect(result.state.age).toBe(77);
    expect(result.yearRecord.phase).toBe("death");
    expect(result.state.pendingDecision).toBeNull();
  });

  it("ADVANCE_YEAR → age_ceiling death：120 歲必定 death", () => {
    const previous = stateAt(contracts.P3E_MAX_AGE - 1, {
      pack: packPlain,
      deathPackOverride: deathPackNoHazardAt120
    });
    const result = execute(previous, { ...ADVANCE }, packPlain, deathPackNoHazardAt120);

    expect(result.state.phase).toBe("death");
    expect(result.state.age).toBe(contracts.P3E_MAX_AGE);
  });

  it("CHOOSE_DECISION → life：year／age／RNG 全部不變", () => {
    const pending = pendingState(stateAt(5, { pack: packDecision }), packDecision);
    const result = execute(pending, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);

    expect(result.state.phase).toBe("life");
    expect(result.state.pendingDecision).toBeNull();
    expect(result.state.currentYear).toBe(pending.currentYear);
    expect(result.state.age).toBe(pending.age);
    expect(result.state.rng).toEqual(pending.rng);
    expect(result.commandRecord.command).toEqual({ type: "CHOOSE_DECISION", optionId: "save" });
    expect(result.yearRecord.phase).toBe("life");
  });

  it("CHOOSE_DECISION rent：annualExpenseMicroUsd +9,000,000 且三項輸出建立（2g 收支語意）", () => {
    const pending = pendingState(stateAt(5, { pack: packDecision }), packDecision);
    const result = execute(pending, { type: "CHOOSE_DECISION", optionId: "rent" }, packDecision);

    expect(result.state.phase).toBe("life");
    expect(result.state.assets.annualExpenseMicroUsd).toBe(
      pending.assets.annualExpenseMicroUsd + 9_000_000n
    );
    expect(result.commandRecord.command).toEqual({ type: "CHOOSE_DECISION", optionId: "rent" });
    expect(result.yearRecord.commandHash).toBe(result.commandRecord.commandHash);
  });

  it("年度 money effect：事件改 annualIncomeMicroUsd，final State 保留 effect 後值", () => {
    const withoutMoney = execute(stateAt(5, { pack: packPlain }), { ...ADVANCE }, packPlain);
    const withMoney = execute(stateAt(5, { pack: packMoneyIncome }), { ...ADVANCE }, packMoneyIncome);

    // 差分斷言：同一 state／RNG，唯一差別是事件的 money effect 欄位。
    expect(withMoney.state.phase).toBe(withoutMoney.state.phase);
    expect(
      withMoney.state.assets.annualIncomeMicroUsd - withoutMoney.state.assets.annualIncomeMicroUsd
    ).toBe(500_000n);
    expect(withMoney.state.assets.annualExpenseMicroUsd).toBe(
      withoutMoney.state.assets.annualExpenseMicroUsd
    );
    // 保留 effect 後值：不等於基準公式在新 age 的值。
    const formula =
      contracts.P3E_INCOME_BASE_MICRO_USD +
      6n * contracts.P3E_INCOME_PER_YEAR_MICRO_USD;
    expect(withMoney.state.assets.annualIncomeMicroUsd).not.toBe(formula);
  });

  it("guardian contentMode：命令完整執行並記錄在 Command Record", () => {
    const previous = stateAt(5, { pack: packPlain });
    const result = execute(previous, { ...ADVANCE_GUARDIAN }, packPlain);

    expect(result.commandRecord.command).toEqual({ type: "ADVANCE_YEAR", contentMode: "guardian" });
    expect(result.state.phase).toBe("life");
    expect(result.state.age).toBe(previous.age + 1);
  });

  it("連續執行兩個命令：index、command head、chain head 正確接續", () => {
    const first = execute(genesisDecision, { ...ADVANCE }, packDecision);
    expect(first.commandRecord.index).toBe(1);
    expect(first.state.commandLog.count).toBe(1);

    const second = execute(first.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    expect(second.commandRecord.index).toBe(2);
    expect(second.yearRecord.index).toBe(2);
    expect(second.state.commandLog.count).toBe(2);
    expect(second.commandRecord.prevCommandHash).toBe(first.commandRecord.commandHash);
    expect(second.yearRecord.prevChainHash).toBe(first.yearRecord.chainHash);
    expect(second.state.commandLog.headHash).toBe(second.commandRecord.commandHash);
    expect(second.state.heads.hashChain).toBe(second.yearRecord.chainHash);
  });

  it("連續執行三個命令（ADVANCE→CHOOSE→ADVANCE）：index 1／2／3 接續", () => {
    const first = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const second = execute(first.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    const third = execute(second.state, { ...ADVANCE }, packDecision);

    expect([first, second, third].map((r) => r.commandRecord.index)).toEqual([1, 2, 3]);
    expect(third.commandRecord.prevCommandHash).toBe(second.commandRecord.commandHash);
    expect(third.yearRecord.prevChainHash).toBe(second.yearRecord.chainHash);
    expect(third.state.commandLog.count).toBe(3);
  });
});

/* ================================================================== */
/* 二、反例                                                            */
/* ================================================================== */

describe("H5-CTO-163-A Command Executor V1：反例", () => {
  it("state 不合法（stateHash 竄改）→ E_P3E_HASH（readP3EState 原樣外傳）", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const broken = { ...previous, stateHash: "0".repeat(64) };
    expectP3ECode(() => execute(broken, { ...ADVANCE }, packNoCandidates), "E_P3E_HASH");
  });

  it("command 缺 contentMode → E_P3E_COMMAND", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    expectP3ECode(
      () => execute(previous, { type: "ADVANCE_YEAR" }, packNoCandidates),
      "E_P3E_COMMAND"
    );
  });

  it("command type 未知 → E_P3E_COMMAND", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    expectP3ECode(
      () => execute(previous, { type: "HIBERNATE", contentMode: "standard" }, packNoCandidates),
      "E_P3E_COMMAND"
    );
  });

  it("command contentMode 非法 → E_P3E_COMMAND at command.contentMode", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    expectP3EError(
      () => execute(previous, { type: "ADVANCE_YEAR", contentMode: "cheat" }, packNoCandidates),
      "E_P3E_COMMAND",
      "command.contentMode"
    );
  });

  it("command optionId 格式非法 → E_P3E_COMMAND at command.optionId", () => {
    const pending = pendingState(stateAt(5, { pack: packDecision }), packDecision);
    expectP3EError(
      () => execute(pending, { type: "CHOOSE_DECISION", optionId: "BAD ID!" }, packDecision),
      "E_P3E_COMMAND",
      "command.optionId"
    );
  });

  it("eventPack 不合法（非品牌物件）→ E_P3E_EVENT_PACK", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    expectP3ECode(
      () => executeP3ECommand({
        state: previous,
        eventPack: { manifest: "not-a-pack" },
        deathPack,
        command: { ...ADVANCE }
      }),
      "E_P3E_EVENT_PACK"
    );
  });

  it("deathPack 不合法（非品牌物件）→ E_P3E_DEATH_PACK", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    expectP3ECode(
      () => executeP3ECommand({
        state: previous,
        eventPack: packNoCandidates,
        deathPack: { manifest: "not-a-pack" },
        command: { ...ADVANCE }
      }),
      "E_P3E_DEATH_PACK"
    );
  });

  it("pack binding 不一致（state 綁 A、input 給 B）→ E_P3E_BINDING", () => {
    const previous = stateAt(5, { pack: packPlain });
    expectP3ECode(() => execute(previous, { ...ADVANCE }, packNoCandidates), "E_P3E_BINDING");
  });

  it("life phase 執行 CHOOSE_DECISION → E_P3E_PHASE at phase", () => {
    const previous = stateAt(5, { pack: packDecision });
    expectP3EError(
      () => execute(previous, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision),
      "E_P3E_PHASE",
      "phase"
    );
  });

  it("pending phase 執行 ADVANCE_YEAR → E_P3E_PHASE at phase", () => {
    const pending = pendingState(stateAt(5, { pack: packDecision }), packDecision);
    expectP3EError(
      () => execute(pending, { ...ADVANCE }, packDecision),
      "E_P3E_PHASE",
      "phase"
    );
  });

  it("death phase 執行 ADVANCE_YEAR → E_P3E_PHASE at phase", () => {
    const dead = stateAt(contracts.P3E_MAX_AGE, {
      pack: packPlain,
      deathPackOverride: deathPackNoHazardAt120
    });
    expect(dead.phase).toBe("death");
    expectP3EError(
      () => execute(dead, { ...ADVANCE }, packPlain, deathPackNoHazardAt120),
      "E_P3E_PHASE",
      "phase"
    );
  });

  it("death phase 執行 CHOOSE_DECISION → E_P3E_PHASE at phase", () => {
    const dead = stateAt(contracts.P3E_MAX_AGE, {
      pack: packPlain,
      deathPackOverride: deathPackNoHazardAt120
    });
    expectP3EError(
      () => execute(dead, { type: "CHOOSE_DECISION", optionId: "save" }, packPlain, deathPackNoHazardAt120),
      "E_P3E_PHASE",
      "phase"
    );
  });

  it("optionId 不屬於 pending decision → E_P3E_DECISION at optionId", () => {
    const pending = pendingState(stateAt(5, { pack: packDecision }), packDecision);
    expectP3EError(
      () => execute(pending, { type: "CHOOSE_DECISION", optionId: "buy-mansion" }, packDecision),
      "E_P3E_DECISION",
      "optionId"
    );
  });

  it("command count 4096 → 第 4097 筆拒絕（E_P3E_HISTORY at transitionMaterial.index）", () => {
    const previous = stateWithCommandCount(5, 4096, { pack: packNoCandidates });
    expectP3EError(
      () => execute(previous, { ...ADVANCE }, packNoCandidates),
      "E_P3E_HISTORY",
      "transitionMaterial.index"
    );
  });

  it("失敗不得回傳部分 State 或部分 Record（拋錯時無任何回傳值）", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    let returned: unknown = "sentinel";
    try {
      returned = executeP3ECommand({
        state: previous,
        eventPack: { manifest: "not-a-pack" },
        deathPack,
        command: { ...ADVANCE }
      });
    } catch {
      // 預期路徑
    }
    expect(returned).toBe("sentinel");
  });
});

/* ================================================================== */
/* 三、input 層信任邊界                                                 */
/* ================================================================== */

describe("H5-CTO-163-A Command Executor V1：input 層信任邊界", () => {
  it("多欄 → E_P3E_ARGUMENT at commandExecution.input", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    expectP3EError(
      () =>
        executeP3ECommand({
          state: previous,
          eventPack: packNoCandidates,
          deathPack,
          command: { ...ADVANCE },
          extra: 1
        }),
      "E_P3E_ARGUMENT",
      "commandExecution.input"
    );
  });

  it("少欄 → E_P3E_ARGUMENT at commandExecution.input", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    expectP3EError(
      () => executeP3ECommand({ state: previous, eventPack: packNoCandidates, deathPack }),
      "E_P3E_ARGUMENT",
      "commandExecution.input"
    );
  });

  it("改名欄位（四欄齊但鍵名不符）→ 拒絕", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    expectP3EError(
      () =>
        executeP3ECommand({
          state: previous,
          eventPack: packNoCandidates,
          deathPack,
          kommand: { ...ADVANCE }
        }),
      "E_P3E_ARGUMENT",
      "commandExecution.input"
    );
  });

  it("隱藏（不可列舉）額外欄位 → 拒絕", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const input: Dict = {
      state: previous,
      eventPack: packNoCandidates,
      deathPack,
      command: { ...ADVANCE }
    };
    Object.defineProperty(input, "hidden", { value: 1, enumerable: false, writable: true });
    expectP3EError(() => executeP3ECommand(input), "E_P3E_ARGUMENT", "commandExecution.input");
  });

  it("symbol 鍵 → 拒絕", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const input: Dict = {
      state: previous,
      eventPack: packNoCandidates,
      deathPack,
      command: { ...ADVANCE }
    };
    (input as Record<symbol, unknown>)[Symbol("evil")] = 1;
    expectP3EError(() => executeP3ECommand(input), "E_P3E_ARGUMENT", "commandExecution.input");
  });

  it("accessor（getter）永不執行且被拒絕", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    let getterCalls = 0;
    const input = {
      get state(): contracts.P3ELifeState {
        getterCalls += 1;
        return previous;
      },
      eventPack: packNoCandidates,
      deathPack,
      command: { ...ADVANCE }
    };
    expectP3EError(() => executeP3ECommand(input), "E_P3E_ARGUMENT", "commandExecution.input");
    expect(getterCalls).toBe(0);
  });

  it("revoked Proxy → E_P3E_ARGUMENT at commandExecution.input", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const revocable = Proxy.revocable<Dict>({
      state: previous,
      eventPack: packNoCandidates,
      deathPack,
      command: { ...ADVANCE }
    }, {});
    revocable.revoke();
    expectP3EError(() => executeP3ECommand(revocable.proxy), "E_P3E_ARGUMENT", "commandExecution.input");
  });

  it("陣列／null／class instance → 一律拒絕", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    expectP3EError(() => executeP3ECommand(null), "E_P3E_ARGUMENT", "commandExecution.input");
    expectP3EError(() => executeP3ECommand([previous, packNoCandidates, deathPack, ADVANCE]), "E_P3E_ARGUMENT", "commandExecution.input");
    class Wrapped {
      public readonly state: contracts.P3ELifeState = previous;
      public readonly eventPack: ValidatedEventPack = packNoCandidates;
      public readonly deathPack: typeof deathPack = deathPack;
      public readonly command = ADVANCE;
    }
    expectP3EError(() => executeP3ECommand(new Wrapped()), "E_P3E_ARGUMENT", "commandExecution.input");
  });

  it("輸入不被修改：state／eventPack／deathPack／command 執行後保持原樣", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const command = { ...ADVANCE };
    const snapshotState = stable(previous);
    const snapshotCommand = stable(command);
    const before = Object.getOwnPropertyNames(packNoCandidates.manifest).length;

    execute(previous, command, packNoCandidates);

    expect(stable(previous)).toBe(snapshotState);
    expect(stable(command)).toBe(snapshotCommand);
    expect(Object.getOwnPropertyNames(packNoCandidates.manifest).length).toBe(before);
  });
});

/* ================================================================== */
/* 四、共同契約                                                        */
/* ================================================================== */

describe("H5-CTO-163-A Command Executor V1：共同契約", () => {
  it("重複相同 seed／state／command：輸出完全一致（決定論）", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const first = execute(previous, { ...ADVANCE }, packNoCandidates);
    const second = execute(
      structuredClone(previous) as contracts.P3ELifeState,
      { ...ADVANCE },
      packNoCandidates
    );
    expect(stable(second)).toBe(stable(first));
  });

  it("輸出深層凍結、與輸入零共享", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const result = execute(previous, { ...ADVANCE }, packNoCandidates);
    expect(isDeepFrozen(result)).toBe(true);
    expect(sharesReference(result, previous)).toBe(false);
  });

  it("P3-E.1b-2l 後依 CTO 裁決以 façade 形式進入公開 barrel", () => {
    expect(BARREL_SRC).toContain('from "./command-executor"');
    expect(Object.keys(barrel)).toContain("executeP3ECommand");
    expect(Object.keys(barrel)).toContain("createP3EGenesis");
  });

  it("必須重用七個正式原語（static 檢查）", () => {
    expect(EXECUTOR_CODE).toContain("readP3EState");
    expect(EXECUTOR_CODE).toContain("readP3ECommand");
    expect(EXECUTOR_CODE).toContain("resolveP3EAnnualPendingDecision");
    expect(EXECUTOR_CODE).toContain("resolveP3EDecisionChoice");
    expect(EXECUTOR_CODE).toContain("assembleP3EAnnualStateCoreDraft");
    expect(EXECUTOR_CODE).toContain("assembleP3EDecisionStateCoreDraft");
    expect(EXECUTOR_CODE).toContain("appendP3ELedgerTransition");
  });

  it("不得 import／重寫業務與 hash 演算法（static 檢查）", () => {
    for (const forbidden of [
      "Xoshiro",
      "computeP3EStateHash",
      "computeP3ESnapshotHash",
      "computeP3EDeltaHash",
      "computeP3EYearEntryHash",
      "createP3ECommandRecord",
      "createP3EYearLedgerRecord",
      "materializeP3ETransition",
      "validateP3ELedgerContinuity",
      "sealP3EState",
      "selectP3EEvent",
      "resolveP3EAnnualRoll",
      "resolveP3EAnnualDeath"
    ]) {
      expect(EXECUTOR_CODE.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("入口單參數：不得接受外部 stage／coreDraft／material／Record", () => {
    expect(EXECUTOR_CODE).toContain("export function executeP3ECommand(input: unknown)");
    for (const token of ["externalStage", "coreDraft:", "material:", "precomputed"]) {
      expect(EXECUTOR_CODE).not.toContain(token);
    }
  });

  it("正式 import 斷言：測試指向 ../src/command-executor、實作指向 ./ledger-append", () => {
    const testSource = readFileSync(
      join(ROOT, "packages/simulation/test/command-executor.test.ts"),
      "utf8"
    );
    expect(testSource).toContain('from "../src/command-executor"');
    // 「已退役的候選模組名」以字串拼接比對，避免斷言文字自我命中。
    const retiredTestImport = ["../src/command-executor", "v1-candidate"].join("-");
    const retiredLedgerImport = ["./ledger-append", "v1-candidate"].join("-");
    expect(testSource.includes(retiredTestImport)).toBe(false);
    expect(EXECUTOR_CODE).toContain('from "./ledger-append"');
    expect(EXECUTOR_CODE.includes(retiredLedgerImport)).toBe(false);
  });
});

/* ================================================================== */
/* 五、P3-E.1b-2m Command Presentation Outcome                          */
/* ================================================================== */

describe("H5-CTO-173-A Command Outcome V1", () => {
  it("advance_no_event：無候選事件 → selectedEventId=null／reason=no_candidates", () => {
    const previous = stateAt(30, { pack: packNoCandidates });
    const result = execute(previous, { ...ADVANCE }, packNoCandidates);
    if (result.outcome.kind !== "advance_year") throw new Error("outcome kind");
    expect(result.outcome.kind).toBe("advance_year");
    expect(result.outcome.selectedEventId).toBeNull();
    expect(result.outcome.selectionReason).toBe("no_candidates");
    expect(result.outcome.pendingDecision).toBeNull();
  });

  it("advance_normal_event：正常事件 → selectedEventId 與 single_candidate", () => {
    const previous = stateAt(5, { pack: packPlain });
    const result = execute(previous, { ...ADVANCE }, packPlain);
    if (result.outcome.kind !== "advance_year") throw new Error("outcome kind");
    expect(result.outcome.selectedEventId).toBe("ev.any.setback");
    expect(result.outcome.selectionReason).toBe("single_candidate");
    expect(result.outcome.selectionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.outcome.pendingDecision).toBeNull();
  });

  it("advance_money_effect：outcome.changes 保留 money delta", () => {
    const result = execute(stateAt(5, { pack: packMoneyIncome }), { ...ADVANCE }, packMoneyIncome);
    if (result.outcome.kind !== "advance_year") throw new Error("outcome kind");
    expect(result.outcome.changes.moneyDelta.annualIncomeMicroUsd).toBe("500000");
    expect(result.outcome.changes.informational).toBe(false);
  });

  it("advance_pending_decision：outcome.pendingDecision 與 State 摘要一致且不含 effects", () => {
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    if (result.outcome.kind !== "advance_year") throw new Error("outcome kind");
    const pending = result.outcome.pendingDecision;
    if (pending === null) throw new Error("expected pending decision");
    expect(pending.eventId).toBe("ev.adult.housing-choice");
    expect(pending.selectionHash).toBe(result.state.pendingDecision?.selectionHash);
    expect(pending.options.map((option) => option.optionId)).toEqual(
      [...(result.state.pendingDecision?.optionIds ?? [])]
    );
    expect(Object.keys(pending).sort()).toEqual(["decisionId", "eventId", "options", "promptKey", "selectionHash"]);
    for (const option of pending.options) {
      expect(Object.keys(option).sort()).toEqual(["labelKey", "optionId"]);
    }
  });

  it("mortality_death_real_causeId：自然死亡帶真實 causeId", () => {
    const previous = stateAt(76, { pack: packPlain });
    const result = execute(previous, { ...ADVANCE }, packPlain);
    if (result.outcome.kind !== "advance_year") throw new Error("outcome kind");
    expect(result.outcome.death?.reason).toBe("mortality");
    expect(typeof result.outcome.death?.causeId).toBe("string");
    expect(result.outcome.death?.causeId).not.toBe("");
    expect(result.outcome.death?.causeId).not.toBeNull();
  });

  it("age_ceiling_causeId_null：120 歲 ceiling 的 causeId 必為 null", () => {
    const previous = stateAt(contracts.P3E_MAX_AGE - 1, {
      pack: packPlain,
      deathPackOverride: deathPackNoHazardAt120
    });
    const result = execute(previous, { ...ADVANCE }, packPlain, deathPackNoHazardAt120);
    if (result.outcome.kind !== "advance_year") throw new Error("outcome kind");
    expect(result.state.phase).toBe("death");
    expect(result.state.age).toBe(contracts.P3E_MAX_AGE);
    expect(result.outcome.death).toEqual({ reason: "age_ceiling", causeId: null });
  });

  it("death_clears_pending：死亡年度即使事件開啟決策，outcome 與 State 都不保留 pending", () => {
    const previous = stateAt(76, { pack: packDecision });
    const result = execute(previous, { ...ADVANCE }, packDecision);
    if (result.outcome.kind !== "advance_year") throw new Error("outcome kind");
    expect(result.state.phase).toBe("death");
    expect(result.state.pendingDecision).toBeNull();
    expect(result.outcome.pendingDecision).toBeNull();
    expect(result.outcome.death).not.toBeNull();
  });

  it("choose_rent：決策 outcome 帶 event／decision／option 與 changes", () => {
    const pending = pendingState(stateAt(5, { pack: packDecision }), packDecision);
    const result = execute(pending, { type: "CHOOSE_DECISION", optionId: "rent" }, packDecision);
    if (result.outcome.kind !== "choose_decision") throw new Error("outcome kind");
    expect(result.outcome.eventId).toBe(pending.pendingDecision?.eventId);
    expect(result.outcome.decisionId).toBe(pending.pendingDecision?.decisionId);
    expect(result.outcome.selectedOptionId).toBe("rent");
    expect(result.outcome.changes.moneyDelta.annualExpenseMicroUsd).toBe("9000000");
    expect(typeof result.outcome.informational).toBe("boolean");
  });

  it("choose_save：決策 outcome 與 Command Record 一致", () => {
    const pending = pendingState(stateAt(5, { pack: packDecision }), packDecision);
    const result = execute(pending, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    if (result.outcome.kind !== "choose_decision") throw new Error("outcome kind");
    expect(result.outcome.selectedOptionId).toBe("save");
    expect(result.commandRecord.command).toEqual({ type: "CHOOSE_DECISION", optionId: "save" });
    expect(Object.keys(result.outcome).sort()).toEqual([
      "changes",
      "decisionId",
      "eventId",
      "informational",
      "kind",
      "selectedOptionId"
    ]);
  });

  it("guardian：outcome.contentMode 保留 guardian", () => {
    const previous = stateAt(5, { pack: packPlain });
    const result = execute(previous, { ...ADVANCE_GUARDIAN }, packPlain);
    if (result.outcome.kind !== "advance_year") throw new Error("outcome kind");
    expect(result.outcome.contentMode).toBe("guardian");
  });

  it("deterministic_outcome：相同輸入的 outcome 逐位元一致", () => {
    const previous = stateAt(5, { pack: packPlain });
    const first = execute(previous, { ...ADVANCE }, packPlain);
    const second = execute(
      structuredClone(previous) as contracts.P3ELifeState,
      { ...ADVANCE },
      packPlain
    );
    expect(stable(second.outcome)).toBe(stable(first.outcome));
  });

  it("deep_frozen_outcome：outcome 遞迴凍結", () => {
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    expect(isDeepFrozen(result.outcome)).toBe(true);
  });

  it("no_mutable_sharing：outcome 不與 State／輸入共享可變參考", () => {
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    if (result.outcome.kind !== "advance_year") throw new Error("outcome kind");
    expect(result.outcome).not.toBe(result.state);
    expect(sharesReference(result.outcome, result.state)).toBe(false);
    expect(result.outcome.pendingDecision?.options).not.toBe(result.state.pendingDecision?.optionIds);
    expect(result.outcome.changes).not.toBe(result.state.assets);
  });

  it("first_3_outputs_unchanged：前三項與 Ledger Append V1 直接輸出逐位元相同", () => {
    const previous = stateAt(5, { pack: packPlain });
    const command = { ...ADVANCE };
    const stage = resolveP3EAnnualPendingDecision({
      state: previous,
      eventPack: packPlain,
      deathPack,
      contentMode: "standard"
    });
    const draft = assembleP3EAnnualStateCoreDraft(previous, stage);
    const expected = appendP3ELedgerTransition(previous, command, draft);
    const actual = execute(previous, command, packPlain);
    expect(
      stable({
        state: actual.state,
        commandRecord: actual.commandRecord,
        yearRecord: actual.yearRecord
      })
    ).toBe(
      stable({
        state: expected.state,
        commandRecord: expected.commandRecord,
        yearRecord: expected.yearRecord
      })
    );
  });

  it("no_new_runtime_barrel_export：barrel 執行期函式仍只有四項", () => {
    const functions = Object.entries(barrel)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("no_internal_field_leak：outcome 不含任何內部 stage／pack／rng 欄位", () => {
    const advance = execute(stateAt(5, { pack: packPlain }), { ...ADVANCE }, packPlain);
    if (advance.outcome.kind !== "advance_year") throw new Error("outcome kind");
    expect(Object.keys(advance.outcome).sort()).toEqual([
      "changes",
      "contentMode",
      "death",
      "kind",
      "pendingDecision",
      "selectedEventId",
      "selectionHash",
      "selectionReason"
    ]);
    expect(Object.keys(advance.outcome.changes).sort()).toEqual([
      "flagsAdded",
      "flagsRemoved",
      "informational",
      "moneyDelta",
      "openedDecisionId",
      "statDelta"
    ]);
    expect(advance.outcome.death).toBeNull();

    const pending = execute(genesisDecision, { ...ADVANCE }, packDecision);
    if (pending.outcome.kind !== "advance_year") throw new Error("outcome kind");
    for (const forbidden of ["candidates", "rng", "rngBefore", "rngAfter", "annualDeath", "openedDecision", "effects"]) {
      expect(Object.keys(pending.outcome)).not.toContain(forbidden);
    }

    const dead = execute(stateAt(76, { pack: packPlain }), { ...ADVANCE }, packPlain);
    if (dead.outcome.kind !== "advance_year") throw new Error("outcome kind");
    expect(Object.keys(dead.outcome.death ?? {}).sort()).toEqual(["causeId", "reason"]);
  });
});
