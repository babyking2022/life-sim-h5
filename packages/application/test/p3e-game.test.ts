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
import * as simulationBarrel from "@life-sim/simulation";
import * as applicationBarrel from "../src/index";
import { createP3EGame, runP3EGameCommand } from "../src/p3e-game";
import { isP3EError, type P3EError } from "../../simulation/src/errors";
import { computeP3EStateHash } from "../../simulation/src/state-hash";
import {
  resolveP3EAnnualPendingDecision,
  type P3EAnnualPendingDecisionStage
} from "../../simulation/src/pending-decision-persistence";
import { PLAYABLE_SMOKE_SEED, runPlayableSmoke } from "../../../scripts/p3e-playable-smoke";

/**
 * H5-CTO-166-A：P3-E.1b-2l 可玩 runtime bridge（application façade）測試。
 *
 * 全部命令都經由 application 公開 façade（`createP3EGame`／`runP3EGameCommand`）；
 * 期望值一律用 simulation 的正式原語獨立重算（如 `computeP3EStateHash`），
 * 不用被測函式自己的輸出當答案，也不以 mock 取代 Roll／事件／死亡／decision。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

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

const genesisDecision = createP3EGame({
  masterSeed: SEED,
  basePack: base,
  identityPack,
  certificate,
  eventPack: packDecision,
  deathPack
});

const BIRTH_YEAR = genesisDecision.identity.birthYear;

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
  readonly phase?: contracts.P3EPhase;
}

/** 任意 age 的合法 state（RNG 游標、pack binding 全部自洽；2g 基線收支自由）。 */
function stateAt(age: number, options: StateOptions = {}): contracts.P3ELifeState {
  const pack = options.pack ?? packPlain;
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
        schemaVersion: deathPack.manifest.schemaVersion, deathDataVersion: deathPack.manifest.deathDataVersion,
        deathSpecVersion: deathPack.manifest.deathSpecVersion, healthRuleVersion: contracts.P3D_HEALTH_RULE_VERSION,
        engineVersion: deathPack.manifest.engineVersion, rngSpecVersion: deathPack.manifest.rngSpecVersion,
        deathPackId: deathPack.manifest.deathPackId, deathPackChecksum: deathPack.packChecksum,
        basePackId: deathPack.manifest.basePackId, basePackChecksum: deathPack.manifest.basePackChecksum,
        entityCount: deathPack.manifest.entityCount
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

/** 走正式年度流程取得 pending state（編排與被測 façade 相同，但由測試獨立呼叫）。 */
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

function run(
  state: contracts.P3ELifeState,
  command: Dict,
  pack: ValidatedEventPack = packPlain
): ReturnType<typeof runP3EGameCommand> {
  return runP3EGameCommand({ state, eventPack: pack, deathPack, command });
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

function expectP3ECode(runFn: () => unknown, code: string): void {
  let caught: unknown = null;
  try {
    runFn();
  } catch (error) {
    caught = error;
  }
  expect(isP3EError(caught), code).toBe(true);
  expect((caught as P3EError).code).toBe(code);
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
}

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;
const ADVANCE_GUARDIAN = { type: "ADVANCE_YEAR", contentMode: "guardian" } as const;

/* ================================================================== */
/* 一、façade 基本行為                                                  */
/* ================================================================== */

describe("H5-CTO-166-A 可玩 façade：基本行為", () => {
  it("createP3EGame 建立合法 age 0 State", () => {
    const state = createP3EGame({
      masterSeed: PLAYABLE_SMOKE_SEED,
      basePack: base,
      identityPack,
      certificate: createBirthCertificate(
        base,
        identityPack,
        buildPeerGroup(base, identityPack, { seed: PLAYABLE_SMOKE_SEED, playerSexPolicy: "random" } as never),
        PLAYABLE_SMOKE_SEED
      ),
      eventPack: packDecision,
      deathPack
    });
    expect(state.age).toBe(0);
    expect(state.phase).toBe("life");
    expect(state.commandLog.count).toBe(0);
    expect(state.commandLog.headHash).toHaveLength(64);
    expect(state.stateHash).toHaveLength(64);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("ADVANCE_YEAR → life：四項輸出全部建立", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const result = run(previous, { ...ADVANCE }, packNoCandidates);
    expect(result.state.phase).toBe("life");
    expect(result.state.age).toBe(previous.age + 1);
    expect(result.commandRecord.index).toBe(1);
    expect(result.state.commandLog.count).toBe(1);
    expect(Object.keys(result).sort()).toEqual(["commandRecord", "outcome", "state", "yearRecord"]);
  });

  it("ADVANCE_YEAR → pending_decision：pendingDecision 摘要隨之封存", () => {
    const result = run(genesisDecision, { ...ADVANCE }, packDecision);
    expect(result.state.phase).toBe("pending_decision");
    expect(result.state.pendingDecision?.eventId).toBe("ev.adult.housing-choice");
    expect(result.yearRecord.phase).toBe("pending_decision");
  });

  it("CHOOSE_DECISION → life：pending 摘要清除、year／age 不變", () => {
    const pending = pendingState(stateAt(5, { pack: packDecision }), packDecision);
    const result = run(pending, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    expect(result.state.phase).toBe("life");
    expect(result.state.pendingDecision).toBeNull();
    expect(result.state.age).toBe(pending.age);
    expect(result.state.currentYear).toBe(pending.currentYear);
    expect(result.commandRecord.command).toEqual({ type: "CHOOSE_DECISION", optionId: "save" });
  });

  it("自然死亡：死亡年度封存 death 且 pendingDecision 為 null", () => {
    const previous = stateAt(76, { pack: packPlain });
    const result = run(previous, { ...ADVANCE }, packPlain);
    expect(result.state.phase).toBe("death");
    expect(result.state.age).toBe(77);
    expect(result.state.pendingDecision).toBeNull();
    expect(result.yearRecord.phase).toBe("death");
  });

  it("120 歲 age ceiling：119 → 120 必為 death", () => {
    const previous = stateAt(contracts.P3E_MAX_AGE - 1);
    const result = run(previous, { ...ADVANCE }, packPlain);
    expect(result.state.age).toBe(contracts.P3E_MAX_AGE);
    expect(result.state.phase).toBe("death");
  });

  it("rent money effect 保留：annualExpenseMicroUsd +9,000,000n", () => {
    const pending = pendingState(stateAt(5, { pack: packDecision }), packDecision);
    const result = run(pending, { type: "CHOOSE_DECISION", optionId: "rent" }, packDecision);
    expect(result.state.assets.annualExpenseMicroUsd).toBe(
      pending.assets.annualExpenseMicroUsd + 9_000_000n
    );
  });

  it("年度事件 money effect 保留：annualIncomeMicroUsd +500,000n 且不等於基準公式", () => {
    const withoutMoney = run(stateAt(5, { pack: packPlain }), { ...ADVANCE }, packPlain);
    const withMoney = run(stateAt(5, { pack: packMoneyIncome }), { ...ADVANCE }, packMoneyIncome);
    expect(
      withMoney.state.assets.annualIncomeMicroUsd - withoutMoney.state.assets.annualIncomeMicroUsd
    ).toBe(500_000n);
    const formula =
      contracts.P3E_INCOME_BASE_MICRO_USD + 6n * contracts.P3E_INCOME_PER_YEAR_MICRO_USD;
    expect(withMoney.state.assets.annualIncomeMicroUsd).not.toBe(formula);
  });

  it("guardian contentMode：命令完整執行並記錄在 Command Record", () => {
    const previous = stateAt(5, { pack: packPlain });
    const result = run(previous, { ...ADVANCE_GUARDIAN }, packPlain);
    expect(result.commandRecord.command).toEqual({ type: "ADVANCE_YEAR", contentMode: "guardian" });
    expect(result.state.phase).toBe("life");
    expect(result.state.age).toBe(previous.age + 1);
  });

  it("連續 ADVANCE → CHOOSE → ADVANCE：index 1／2／3 與 chain 接續", () => {
    const first = run(genesisDecision, { ...ADVANCE }, packDecision);
    const second = run(first.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    const third = run(second.state, { ...ADVANCE }, packDecision);
    expect([first, second, third].map((r) => r.commandRecord.index)).toEqual([1, 2, 3]);
    expect(second.commandRecord.prevCommandHash).toBe(first.commandRecord.commandHash);
    expect(third.commandRecord.prevCommandHash).toBe(second.commandRecord.commandHash);
    expect(second.yearRecord.prevChainHash).toBe(first.yearRecord.chainHash);
    expect(third.state.heads.hashChain).toBe(third.yearRecord.chainHash);
    expect(third.state.commandLog.count).toBe(3);
  });

  it("相同輸入完全決定論：輸出逐字一致", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const first = run(previous, { ...ADVANCE }, packNoCandidates);
    const second = run(
      structuredClone(previous) as contracts.P3ELifeState,
      { ...ADVANCE },
      packNoCandidates
    );
    expect(stable(second)).toBe(stable(first));
  });

  it("非法 state／command／event pack／death pack／binding：P3EError 原樣外傳", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    expectP3ECode(
      () => run({ ...previous, stateHash: "0".repeat(64) }, { ...ADVANCE }, packNoCandidates),
      "E_P3E_HASH"
    );
    expectP3ECode(() => run(previous, { type: "ADVANCE_YEAR" }, packNoCandidates), "E_P3E_COMMAND");
    expectP3ECode(
      () =>
        runP3EGameCommand({
          state: previous,
          eventPack: { manifest: "not-a-pack" },
          deathPack,
          command: { ...ADVANCE }
        }),
      "E_P3E_EVENT_PACK"
    );
    expectP3ECode(
      () =>
        runP3EGameCommand({
          state: previous,
          eventPack: packNoCandidates,
          deathPack: { manifest: "not-a-pack" },
          command: { ...ADVANCE }
        }),
      "E_P3E_DEATH_PACK"
    );
    expectP3ECode(() => run(previous, { ...ADVANCE }, packDecision), "E_P3E_BINDING");
  });

  it("輸入不被修改（state／command／packs 執行後保持原樣）", () => {
    const previous = stateAt(5, { pack: packNoCandidates });
    const command = { ...ADVANCE };
    const snapshotState = stable(previous);
    const snapshotCommand = stable(command);
    run(previous, command, packNoCandidates);
    expect(stable(previous)).toBe(snapshotState);
    expect(stable(command)).toBe(snapshotCommand);
  });
});

/* ================================================================== */
/* 二、公開 barrel                                                      */
/* ================================================================== */

describe("H5-CTO-166-A 公開 barrel", () => {
  it("simulation barrel 只新增核准 façade，不外洩 Ledger／Hash／Record 內部原語", () => {
    expect(typeof simulationBarrel.createP3EGenesis).toBe("function");
    expect(typeof simulationBarrel.executeP3ECommand).toBe("function");

    const forbidden = [
      "appendP3ELedgerTransition",
      "validateP3ELedgerContinuity",
      "readP3EState",
      "readP3ECommand",
      "computeP3EStateHash",
      "createP3ECommandRecord",
      "createP3EYearLedgerRecord",
      "materializeP3ETransition",
      "sealP3EState",
      "resolveP3EAnnualPendingDecision",
      "assembleP3EAnnualStateCoreDraft",
      "assembleP3EDecisionStateCoreDraft",
      "encodeP3ELedgerRecordPair",
      "decodeP3ELedgerRecordPair"
    ];
    for (const name of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(simulationBarrel, name), name).toBe(false);
    }

    // 原始碼層級：barrel 只允許這七個模組規格（2t 追加 replay／payload codec）。
    const source = readFileSync(join(ROOT, "packages/simulation/src/index.ts"), "utf8");
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, " ");
    const specifiers = new Set([...stripped.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]));
    expect([...specifiers].sort()).toEqual([
      "./command-executor",
      "./errors",
      "./genesis",
      "./ledger-history",
      "./p3e-replay",
      "./p3e-session-payload-codec",
      "@life-sim/contracts"
    ]);
  });

  it("application barrel 可正常呼叫兩個 façade", () => {
    expect(typeof applicationBarrel.createP3EGame).toBe("function");
    expect(typeof applicationBarrel.runP3EGameCommand).toBe("function");

    const state = applicationBarrel.createP3EGame({
      masterSeed: SEED,
      basePack: base,
      identityPack,
      certificate,
      eventPack: packNoCandidates,
      deathPack
    });
    expect(state.age).toBe(0);
    expect(state.phase).toBe("life");

    const result = applicationBarrel.runP3EGameCommand({
      state,
      eventPack: packNoCandidates,
      deathPack,
      command: { ...ADVANCE }
    });
    expect(result.commandRecord.index).toBe(1);
    expect(result.state.age).toBe(1);
  });
});

/* ================================================================== */
/* 三、完整可玩流程                                                     */
/* ================================================================== */

describe("H5-CTO-166-A 完整可玩流程", () => {
  it("headless game loop：age 0 一路執行到 death", () => {
    const officialEventPack = validateEventPack({
      manifest: rawEventManifest,
      events: rawEvents
    } as never);
    let state = createP3EGame({
      masterSeed: PLAYABLE_SMOKE_SEED,
      basePack: base,
      identityPack,
      certificate: createBirthCertificate(
        base,
        identityPack,
        buildPeerGroup(base, identityPack, { seed: PLAYABLE_SMOKE_SEED, playerSexPolicy: "random" } as never),
        PLAYABLE_SMOKE_SEED
      ),
      eventPack: officialEventPack,
      deathPack
    });

    let commands = 0;
    let decisions = 0;
    while (state.phase !== "death") {
      const previous = state;
      let result: ReturnType<typeof runP3EGameCommand>;
      if (state.phase === "pending_decision") {
        const pending = state.pendingDecision;
        expect(pending).not.toBeNull();
        const optionId = pending?.optionIds[0] as string;
        result = runP3EGameCommand({
          state,
          eventPack: officialEventPack,
          deathPack,
          command: { type: "CHOOSE_DECISION", optionId }
        });
        decisions += 1;
      } else {
        result = runP3EGameCommand({
          state,
          eventPack: officialEventPack,
          deathPack,
          command: { ...ADVANCE }
        });
      }
      commands += 1;
      expect(result.commandRecord.index).toBe(commands);
      expect(result.commandRecord.prevCommandHash).toBe(previous.commandLog.headHash);
      expect(result.yearRecord.prevChainHash).toBe(previous.heads.hashChain);
      expect(result.state.commandLog.headHash).toBe(result.commandRecord.commandHash);
      expect(result.state.heads.hashChain).toBe(result.yearRecord.chainHash);
      state = result.state;
      expect(commands).toBeLessThanOrEqual(contracts.P3E_MAX_COMMANDS);
    }

    expect(state.phase).toBe("death");
    expect(state.age).toBeLessThanOrEqual(contracts.P3E_MAX_AGE);
    expect(commands).toBeGreaterThan(0);
    expect(state.commandLog.count).toBe(commands);
    expect(decisions).toBeGreaterThanOrEqual(1);
  });

  it("application_passthrough：outcome 原樣轉出（含 death.causeId），不重建也不丟欄位", () => {
    const previous = stateAt(5, { pack: packPlain });
    const command = { ...ADVANCE };
    const viaApp = runP3EGameCommand({ state: previous, eventPack: packPlain, deathPack, command });
    const viaSimulation = simulationBarrel.executeP3ECommand({
      state: previous,
      eventPack: packPlain,
      deathPack,
      command
    });
    expect(Object.keys(viaApp).sort()).toEqual(["commandRecord", "outcome", "state", "yearRecord"]);
    expect(stable(viaApp)).toBe(stable(viaSimulation));
    expect(viaApp.outcome.kind).toBe("advance_year");

    const deadState = stateAt(76, { pack: packPlain });
    const deadViaApp = runP3EGameCommand({
      state: deadState,
      eventPack: packPlain,
      deathPack,
      command: { ...ADVANCE }
    });
    const deadViaSimulation = simulationBarrel.executeP3ECommand({
      state: deadState,
      eventPack: packPlain,
      deathPack,
      command: { ...ADVANCE }
    });
    if (deadViaApp.outcome.kind !== "advance_year" || deadViaSimulation.outcome.kind !== "advance_year") {
      throw new Error("outcome kind");
    }
    expect(deadViaApp.outcome.death?.reason).toBe("mortality");
    expect(deadViaApp.outcome.death?.causeId).toBe(deadViaSimulation.outcome.death?.causeId);
    expect(typeof deadViaApp.outcome.death?.causeId).toBe("string");
  });
});

/* ================================================================== */
/* 四、可玩 smoke                                                       */
/* ================================================================== */

describe("H5-CTO-166-A 可玩 smoke", () => {
  it("smoke runner 成功輸出固定摘要", () => {
    const result = runPlayableSmoke();
    expect(result.summary.startsWith("P3E-PLAYABLE-SMOKE-OK\n")).toBe(true);
    expect(result.summary).toContain(`seed=${PLAYABLE_SMOKE_SEED}`);
    expect(result.summary).toContain("finalPhase=death");
    expect(result.summary).toContain("stateHash=");
    expect(result.summary).toContain("commandHeadHash=");
    expect(result.summary).toContain("chainHash=");
    expect(result.state.phase).toBe("death");
  });

  it("smoke 摘要連續兩次完全一致", () => {
    expect(runPlayableSmoke().summary).toBe(runPlayableSmoke().summary);
  });
});
