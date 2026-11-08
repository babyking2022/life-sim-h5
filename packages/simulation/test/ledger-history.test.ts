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
import { createP3ECommandRecord, type P3ECommandRecord } from "../src/command-record";
import { computeP3EYearChainHash, computeP3EYearEntryHash } from "../src/year-ledger-hash";
import { executeP3ECommand } from "../src/command-executor";
import {
  appendP3ELedgerHistory,
  createP3ELedgerHistory,
  readP3ELedgerHistory,
  type P3ELedgerHistory,
  type P3ELedgerHistoryRecordPair
} from "../src/ledger-history";
import * as barrel from "../src/index";

/**
 * H5-CTO-175-A：P3-E Ledger History V1 正式測試。
 *
 * 來源：WorkBuddy 候選 `ledger-history-v1-candidate.test.ts`
 * （SHA-256 `03c60aa1d01b5374ad6a092a3aec25f9dfd0bd7ab72fc449c23eee853c5b67ad`，
 * 經 H5-CTO-175-A 核准、H5-CTO-175-A 正式整合）。
 *
 * 期望值一律用**正式原語**獨立重算（`computeP3EStateHash`／`createP3ECommandRecord`／
 * `computeP3EYearEntryHash`／`computeP3EYearChainHash`），不用被測函式自己的輸出當答案。
 *
 * 合法 Record 的來源有兩種：
 *
 * 1. **正式 Command Executor V1**（`executeP3ECommand`）——只用在測試裡
 *    產生真實交易 Record；本模組實作本身不依賴 Command Executor；
 * 2. **合成 Pair**——用正式 hash 原語自行組出「內部自洽」的 Pair，專門用來
 *    觸發 History 層（cross-link／tail-match）的錯誤路徑。
 *
 * 本檔**不**重建任何 shape／hash／continuity 驗證演算法：Pair 內部合法性
 * 全部交給正式的 `readP3ECommandRecord`／`verifyP3EYearLedgerRecord`／
 * `validateP3ELedgerContinuity`。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const HISTORY_SRC = readFileSync(
  join(ROOT, "packages/simulation/src/ledger-history.ts"),
  "utf8"
);
const HISTORY_CODE = HISTORY_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
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

const SEED = "p3e-164-ledger-history-v1";
const peerGroup = buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never);
const certificate = createBirthCertificate(base, identityPack, peerGroup, SEED);

/** 綁定 `packDecision` 的 genesis（ADVANCE→CHOOSE→ADVANCE 完整流程用）。 */
const genesisDecision = createP3EGenesis({
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

/** 任意 `commandLog.count` 的合法 state（stateHash 不含 commandLog，重算後自洽）。 */
function stateWithCount(source: contracts.P3ELifeState, count: number): contracts.P3ELifeState {
  const draft = { ...source, commandLog: { ...source.commandLog, count } };
  return { ...draft, stateHash: computeP3EStateHash(draft as never) } as contracts.P3ELifeState;
}

/**
 * 「外部 history anchor」：直接組出 `{ initial, records: [] }` 的**未凍結**容器形狀。
 *
 * R1 之後 `createP3ELedgerHistory` 只接受真正的 Genesis（age === 0 且 count === 0），
 * 因此「以 age > 0／count = 0 的 State 當起點」的舊 fixture 一律改用這個外部形狀：
 * 它**不是**模組產生的物件，沒有可信品牌，append 必須走完整 O(n) 驗證路徑。
 *
 * anchor 三欄刻意取自同一個 State 的 `stateHash`／`commandLog.headHash`／`heads.hashChain`，
 * 因此空 History 的尾端比對（count／stateHash／commandHead／chainHead）全部對得上。
 */
function externalAnchorHistory(state: contracts.P3ELifeState): Dict {
  return {
    initial: {
      stateHash: state.stateHash,
      commandHeadHash: state.commandLog.headHash,
      chainHash: state.heads.hashChain
    },
    records: []
  };
}

/* --------------------- 合成 Pair（正式 hash 原語） --------------------- */

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);
const HEX_E = "e".repeat(64);
const HEX_F = "f".repeat(64);
const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

interface PairOptions {
  readonly index: number;
  readonly year?: number;
  readonly age?: number;
  readonly phase?: contracts.P3EPhase;
  readonly stateHashBefore: string;
  readonly stateHashAfter?: string;
  readonly prevCommandHash: string;
  readonly prevChainHash: string;
  readonly rngBefore?: contracts.P3ERngState;
  readonly rngAfter?: contracts.P3ERngState;
  readonly snapshotHash?: string;
  readonly deltaHash?: string;
  readonly command?: unknown;
}

/**
 * 用正式原語獨立算出 entry／chain hash，組出「內部完全自洽」的一對 Record。
 *
 * 兩份 Record 的交叉連結（index／year／前後 stateHash／commandHash／entryHash）
 * 由正式原語保證一致，因此任何失敗必定來自 History 層的 cross-link 檢查。
 */
function syntheticPair(options: PairOptions): { commandRecord: P3ECommandRecord; yearRecord: Dict } {
  const index = options.index;
  const year = options.year ?? index;
  const age = options.age ?? 5;
  const phase: contracts.P3EPhase = options.phase ?? "life";
  const stateHashBefore = options.stateHashBefore;
  const stateHashAfter = options.stateHashAfter ?? HEX_C;
  const prevCommandHash = options.prevCommandHash;
  const prevChainHash = options.prevChainHash;
  const rngBefore = options.rngBefore ?? genesisDecision.rng;
  const rngAfter = options.rngAfter ?? genesisDecision.rng;
  const snapshotHash = options.snapshotHash ?? HEX_D;
  const deltaHash = options.deltaHash ?? HEX_E;
  const command = options.command ?? { ...ADVANCE };

  const entryHash = computeP3EYearEntryHash({
    index, year, age, phase, stateHashBefore, rngBefore, rngAfter, snapshotHash, deltaHash
  }) as string;

  const commandRecord = createP3ECommandRecord({
    index,
    year,
    command,
    prevCommandHash,
    stateHashBefore,
    stateHashAfter,
    entryHash: entryHash as contracts.P3EHex64
  });

  const chainHash = computeP3EYearChainHash({
    prevChainHash, index, year, entryHash, stateHashAfter, commandHash: commandRecord.commandHash
  }) as string;

  const yearRecord: Dict = {
    index, year, age, phase, stateHashBefore, stateHashAfter,
    rngBefore, rngAfter, snapshotHash, deltaHash,
    entryHash, commandHash: commandRecord.commandHash, prevChainHash, chainHash
  };
  return { commandRecord, yearRecord };
}

/** 依序鏈結的合成 Pair 陣列（第 1 筆接 anchor，之後逐一接前一筆）。 */
function syntheticPairs(
  count: number,
  anchor: { stateHash: string; commandHeadHash: string; chainHash: string },
  lastStateHashAfter?: string
): Dict[] {
  const pairs: Dict[] = [];
  let stateHashBefore = anchor.stateHash;
  let prevCommandHash = anchor.commandHeadHash;
  let prevChainHash = anchor.chainHash;
  for (let position = 1; position <= count; position += 1) {
    const isLast = position === count;
    const stateHashAfter = isLast && lastStateHashAfter !== undefined ? lastStateHashAfter : HEX_C;
    const pair = syntheticPair({
      index: position,
      stateHashBefore,
      stateHashAfter,
      prevCommandHash,
      prevChainHash
    });
    pairs.push({ commandRecord: pair.commandRecord, yearRecord: pair.yearRecord });
    stateHashBefore = stateHashAfter;
    prevCommandHash = pair.commandRecord.commandHash;
    prevChainHash = pair.yearRecord.chainHash as string;
  }
  return pairs;
}

/** genesis anchor（由 genesis 欄位獨立組出，與 create 的輸出對照用）。 */
const GENESIS_ANCHOR = {
  stateHash: genesisDecision.stateHash,
  commandHeadHash: genesisDecision.commandLog.headHash,
  chainHash: genesisDecision.heads.hashChain
};

/* ------------------------------ 輔助 ------------------------------- */

/** 執行一次命令交易（正式 Command Executor V1；僅測試使用）。 */
function execute(
  state: contracts.P3ELifeState,
  command: Dict,
  pack: ValidatedEventPack
): ReturnType<typeof executeP3ECommand> {
  return executeP3ECommand({ state, eventPack: pack, deathPack, command });
}

/** 把 executor 輸出組成 append 的四欄 input。 */
function appendInput(
  history: unknown,
  previousState: contracts.P3ELifeState,
  records: { commandRecord: unknown; yearRecord: unknown }
): Dict {
  return {
    history,
    previousState,
    commandRecord: records.commandRecord,
    yearRecord: records.yearRecord
  };
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

/** 精確斷言：code＋path＋訊息格式，且不是 TypeError／RangeError／SyntaxError。 */
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

/**
 * 「尾端為準」的 Q-state 技巧：組出一個 previousState Q 與一筆合成尾端 Pair，
 * 讓 append 的前四項 tail 檢查（count／stateHash／commandHead／chainHead）全部
 * 通過、唯有指定的 ledger head（snapshot 或 delta）與尾端不一致。
 *
 * 關鍵：stateHash projection 包含三個 ledger heads、但**不包含** `heads.hashChain`
 * 與整個 `commandLog`，因此可以先用（換過的）heads 算出 Q 的 stateHash，再把尾端
 * Pair 的 `stateHashAfter` 對齊它，最後回填 `hashChain`／`headHash`（不影響 stateHash）。
 */
function mismatchedLedgerHeadFixture(mismatch: "snapshot" | "delta"): {
  history: Dict;
  previousState: contracts.P3ELifeState;
} {
  const source = stateAt(5, { pack: packDecision });
  const snapshotQ = source.heads.lastSnapshotHash;
  const deltaQ = source.heads.lastDeltaHash;
  // 尾端 Pair 的 snapshot／delta：被測的那一項換掉，另一項對齊 Q。
  const pairSnapshot = mismatch === "snapshot" ? HEX_D : snapshotQ;
  const pairDelta = mismatch === "delta" ? HEX_E : deltaQ;

  const entryHash = computeP3EYearEntryHash({
    index: 1,
    year: source.currentYear + 1,
    age: source.age + 1,
    phase: "life",
    stateHashBefore: GENESIS_ANCHOR.stateHash,
    rngBefore: source.rng,
    rngAfter: source.rng,
    snapshotHash: pairSnapshot,
    deltaHash: pairDelta
  }) as string;

  // Q 的 stateHash 由（換過一項的）heads 決定；hashChain／commandLog 先用 placeholder。
  const qDraft = {
    ...source,
    commandLog: { count: 1, headHash: HEX_B },
    heads: { lastSnapshotHash: snapshotQ, lastDeltaHash: deltaQ, lastEntryHash: entryHash, hashChain: HEX_B }
  };
  const qStateHash = computeP3EStateHash(qDraft as never);

  const pair = syntheticPair({
    index: 1,
    year: source.currentYear + 1,
    age: source.age + 1,
    phase: "life",
    stateHashBefore: GENESIS_ANCHOR.stateHash,
    stateHashAfter: qStateHash,
    prevCommandHash: GENESIS_ANCHOR.commandHeadHash,
    prevChainHash: GENESIS_ANCHOR.chainHash,
    rngBefore: source.rng,
    rngAfter: source.rng,
    snapshotHash: pairSnapshot,
    deltaHash: pairDelta
  });

  const previousState = {
    ...qDraft,
    commandLog: { count: 1, headHash: pair.commandRecord.commandHash },
    heads: {
      lastSnapshotHash: snapshotQ,
      lastDeltaHash: deltaQ,
      lastEntryHash: entryHash,
      hashChain: pair.yearRecord.chainHash
    },
    stateHash: qStateHash
  } as contracts.P3ELifeState;

  const history: Dict = {
    initial: { ...GENESIS_ANCHOR },
    records: [{ commandRecord: pair.commandRecord, yearRecord: pair.yearRecord }]
  };
  return { history, previousState };
}

/* ================================================================== */
/* 一、createP3ELedgerHistory：正向                                     */
/* ================================================================== */

describe("H5-CTO-175-A Ledger History V1：create（正向）", () => {
  it("從 Genesis 建立空 History：anchor 三欄正確、records=[]", () => {
    const history = createP3ELedgerHistory(genesisDecision);

    expect(history.records).toEqual([]);
    expect(history.initial.stateHash).toBe(genesisDecision.stateHash);
    expect(history.initial.commandHeadHash).toBe(genesisDecision.commandLog.headHash);
    expect(history.initial.chainHash).toBe(genesisDecision.heads.hashChain);
    expect(Object.keys(history).sort()).toEqual(["initial", "records"]);
    expect(Object.keys(history.initial).sort()).toEqual(["chainHash", "commandHeadHash", "stateHash"]);
  });

  it("輸出深層凍結、與輸入零共享", () => {
    const history = createP3ELedgerHistory(genesisDecision);

    expect(isDeepFrozen(history)).toBe(true);
    expect(sharesReference(history, genesisDecision)).toBe(false);
  });

  it("決定性：相同輸入產生完全一致輸出", () => {
    const first = createP3ELedgerHistory(genesisDecision);
    const second = createP3ELedgerHistory(genesisDecision);

    expect(stable(first)).toBe(stable(second));
    expect(first).not.toBe(second);
  });

  it("read 可以完整讀回 create 的輸出（獨立等價快照）", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const read = readP3ELedgerHistory(history);

    expect(stable(read)).toBe(stable(history));
    expect(sharesReference(read, history)).toBe(false);
  });
});

/* ================================================================== */
/* 二、append：正向流程（真實 Executor Record）                          */
/* ================================================================== */

describe("H5-CTO-175-A Ledger History V1：append（正向）", () => {
  it("append 第一筆：index=1、鏈結 anchor、輸入不被修改", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const input = appendInput(history, genesisDecision, result);
    const before = stable(input);

    const appended = appendP3ELedgerHistory(input);

    expect(appended.records.length).toBe(1);
    const pair = appended.records[0] as P3ELedgerHistoryRecordPair;
    expect(pair.commandRecord.index).toBe(1);
    expect(pair.commandRecord.stateHashBefore).toBe(history.initial.stateHash);
    expect(pair.commandRecord.prevCommandHash).toBe(history.initial.commandHeadHash);
    expect(pair.yearRecord.prevChainHash).toBe(history.initial.chainHash);
    // 輸入不變（含傳入 History 與 Record）。
    expect(stable(input)).toBe(before);
  });

  it("連續 append 2 筆與 3 筆：index 逐筆 +1、跨紀錄鏈結連續", () => {
    let state: contracts.P3ELifeState = stateAt(5, { pack: packNoCandidates });
    // R1：create 只接受 Genesis，這裡改用「外部 anchor」（未凍結、無可信品牌）。
    let history: P3ELedgerHistory = externalAnchorHistory(state) as unknown as P3ELedgerHistory;

    for (let step = 1; step <= 3; step += 1) {
      const result = execute(state, { ...ADVANCE }, packNoCandidates);
      history = appendP3ELedgerHistory(appendInput(history, state, result));
      state = result.state;
    }

    expect(history.records.length).toBe(3);
    // 用 read 完整重驗（cross-link 由 read 把關）。
    const read = readP3ELedgerHistory(history);
    expect(read.records.length).toBe(3);
    for (let position = 0; position < 3; position += 1) {
      const pair = read.records[position] as P3ELedgerHistoryRecordPair;
      expect(pair.commandRecord.index).toBe(position + 1);
      expect(pair.yearRecord.index).toBe(position + 1);
      if (position === 0) {
        expect(pair.commandRecord.stateHashBefore).toBe(read.initial.stateHash);
        expect(pair.commandRecord.prevCommandHash).toBe(read.initial.commandHeadHash);
        expect(pair.yearRecord.prevChainHash).toBe(read.initial.chainHash);
      } else {
        const prev = read.records[position - 1] as P3ELedgerHistoryRecordPair;
        expect(pair.commandRecord.stateHashBefore).toBe(prev.yearRecord.stateHashAfter);
        expect(pair.commandRecord.prevCommandHash).toBe(prev.commandRecord.commandHash);
        expect(pair.yearRecord.prevChainHash).toBe(prev.yearRecord.chainHash);
      }
    }
  });

  it("ADVANCE→CHOOSE→ADVANCE 的完整 records（pending_decision 與 life 混合）", () => {
    let history = createP3ELedgerHistory(genesisDecision);

    const advance1 = execute(genesisDecision, { ...ADVANCE }, packDecision);
    history = appendP3ELedgerHistory(appendInput(history, genesisDecision, advance1));
    expect((history.records[0] as P3ELedgerHistoryRecordPair).yearRecord.phase).toBe("pending_decision");

    const choose = execute(advance1.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    history = appendP3ELedgerHistory(appendInput(history, advance1.state, choose));
    expect((history.records[1] as P3ELedgerHistoryRecordPair).yearRecord.phase).toBe("life");

    const advance2 = execute(choose.state, { ...ADVANCE }, packDecision);
    history = appendP3ELedgerHistory(appendInput(history, choose.state, advance2));

    expect(history.records.length).toBe(3);
    const types = history.records.map(
      (pair) => (pair as P3ELedgerHistoryRecordPair).commandRecord.command.type
    );
    expect(types).toEqual(["ADVANCE_YEAR", "CHOOSE_DECISION", "ADVANCE_YEAR"]);
    readP3ELedgerHistory(history);
  });

  it("life、pending_decision、death Pair 均可保存", () => {
    // life（age > 0 的起點：改用外部 anchor，create 只接受 Genesis）
    const lifeState = stateAt(5, { pack: packNoCandidates });
    const lifeHistory = appendP3ELedgerHistory(
      appendInput(
        externalAnchorHistory(lifeState),
        lifeState,
        execute(lifeState, { ...ADVANCE }, packNoCandidates)
      )
    );
    expect((lifeHistory.records[0] as P3ELedgerHistoryRecordPair).yearRecord.phase).toBe("life");

    // pending_decision（Genesis 起點：create 合法）
    const pendingHistory = appendP3ELedgerHistory(
      appendInput(
        createP3ELedgerHistory(genesisDecision),
        genesisDecision,
        execute(genesisDecision, { ...ADVANCE }, packDecision)
      )
    );
    expect((pendingHistory.records[0] as P3ELedgerHistoryRecordPair).yearRecord.phase).toBe("pending_decision");

    // death（age 119 → 120 歲硬上限，必定死亡；age > 0 的起點：改用外部 anchor）
    // GPT-0029-A：新的 game-tuned 死亡曲線下，76 歲不再保證自然死亡，改用年齡上限。
    const deathState = stateAt(119, { pack: packPlain });
    const deathHistory = appendP3ELedgerHistory(
      appendInput(
        externalAnchorHistory(deathState),
        deathState,
        execute(deathState, { ...ADVANCE }, packPlain)
      )
    );
    expect((deathHistory.records[0] as P3ELedgerHistoryRecordPair).yearRecord.phase).toBe("death");
  });

  it("決定性：相同輸入 append 兩次輸出完全一致", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);

    const first = appendP3ELedgerHistory(appendInput(history, genesisDecision, result));
    const second = appendP3ELedgerHistory(appendInput(history, genesisDecision, result));

    expect(stable(first)).toBe(stable(second));
    expect(first).not.toBe(second);
  });

  it("輸出深層凍結；append 建立新外層與新 records 陣列（可信路徑只共享已凍結的 initial）", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const input = appendInput(history, genesisDecision, result);

    const appended = appendP3ELedgerHistory(input);

    expect(isDeepFrozen(appended)).toBe(true);
    expect(appended).not.toBe(history);
    expect(appended.records).not.toBe(history.records);
    // R1 授權的「安全結構共享」：已驗證、已深層凍結的 anchor 允許 identity 相同。
    expect(appended.initial).toBe(history.initial);
    expect(Object.isFrozen(appended.initial)).toBe(true);
    // 新 Pair 必須是獨立物件（不得與輸入的 Record 共用 identity）。
    const pair = appended.records[0] as P3ELedgerHistoryRecordPair;
    expect(pair).not.toBe(history.records[0]);
    expect(sharesReference(pair.commandRecord, result.commandRecord)).toBe(false);
    expect(sharesReference(pair.yearRecord, result.yearRecord)).toBe(false);
    expect(sharesReference(pair.commandRecord, result.commandRecord)).toBe(false);
  });

  it("append 的輸出可直接再 append（鏈可以一直接）且 read 等價", () => {
    const start = stateAt(5, { pack: packNoCandidates });
    const advance1 = execute(start, { ...ADVANCE }, packNoCandidates);
    const advance2 = execute(advance1.state, { ...ADVANCE }, packNoCandidates);
    let history: unknown = externalAnchorHistory(start);
    history = appendP3ELedgerHistory(appendInput(history, start, advance1));
    history = appendP3ELedgerHistory(appendInput(history, advance1.state, advance2));

    expect((history as P3ELedgerHistory).records.length).toBe(2);
    expect(stable(readP3ELedgerHistory(history))).toBe(stable(history));
  });
});

/* ================================================================== */
/* 三、read：跨紀錄鏈結反例（合成 Pair，內部自洽）                        */
/* ================================================================== */

describe("H5-CTO-175-A Ledger History V1：read（cross-link 反例）", () => {
  function historyOf(records: unknown[]): Dict {
    return { initial: { ...GENESIS_ANCHOR }, records };
  }

  it("index 從 2 開始", () => {
    const pair = syntheticPair({
      index: 2,
      stateHashBefore: GENESIS_ANCHOR.stateHash,
      prevCommandHash: GENESIS_ANCHOR.commandHeadHash,
      prevChainHash: GENESIS_ANCHOR.chainHash
    });
    expectP3EError(
      () => readP3ELedgerHistory(historyOf([{ commandRecord: pair.commandRecord, yearRecord: pair.yearRecord }])),
      "E_P3E_HISTORY",
      "ledgerHistory.records.index"
    );
  });

  it("index 跳號（1 → 3）", () => {
    const pairs = syntheticPairs(2, GENESIS_ANCHOR);
    const rebuilt = syntheticPair({
      index: 3,
      stateHashBefore: (pairs[0]?.yearRecord as Dict).stateHashAfter as string,
      prevCommandHash: (pairs[0]?.commandRecord as P3ECommandRecord).commandHash,
      prevChainHash: (pairs[0]?.yearRecord as Dict).chainHash as string
    });
    const records = [pairs[0], { commandRecord: rebuilt.commandRecord, yearRecord: rebuilt.yearRecord }];
    expectP3EError(() => readP3ELedgerHistory(historyOf(records)), "E_P3E_HISTORY", "ledgerHistory.records.index");
  });

  it("index 重複（1 → 1）", () => {
    const first = syntheticPair({
      index: 1,
      stateHashBefore: GENESIS_ANCHOR.stateHash,
      prevCommandHash: GENESIS_ANCHOR.commandHeadHash,
      prevChainHash: GENESIS_ANCHOR.chainHash
    });
    const second = syntheticPair({
      index: 1,
      stateHashBefore: first.commandRecord.stateHashAfter,
      prevCommandHash: first.commandRecord.commandHash,
      prevChainHash: first.yearRecord.chainHash as string
    });
    const records = [
      { commandRecord: first.commandRecord, yearRecord: first.yearRecord },
      { commandRecord: second.commandRecord, yearRecord: second.yearRecord }
    ];
    expectP3EError(() => readP3ELedgerHistory(historyOf(records)), "E_P3E_HISTORY", "ledgerHistory.records.index");
  });

  it("stateHashBefore 斷鏈（第二筆不等於前一筆 stateHashAfter）", () => {
    const pairs = syntheticPairs(2, GENESIS_ANCHOR);
    const broken = syntheticPair({
      index: 2,
      stateHashBefore: HEX_A,
      prevCommandHash: (pairs[0]?.commandRecord as P3ECommandRecord).commandHash,
      prevChainHash: (pairs[0]?.yearRecord as Dict).chainHash as string
    });
    const records = [pairs[0], { commandRecord: broken.commandRecord, yearRecord: broken.yearRecord }];
    expectP3EError(
      () => readP3ELedgerHistory(historyOf(records)),
      "E_P3E_HISTORY",
      "ledgerHistory.records.stateHashBefore"
    );
  });

  it("prevCommandHash 斷鏈（第二筆不等於前一筆 commandHash）", () => {
    const pairs = syntheticPairs(2, GENESIS_ANCHOR);
    const broken = syntheticPair({
      index: 2,
      stateHashBefore: (pairs[0]?.yearRecord as Dict).stateHashAfter as string,
      prevCommandHash: HEX_B,
      prevChainHash: (pairs[0]?.yearRecord as Dict).chainHash as string
    });
    const records = [pairs[0], { commandRecord: broken.commandRecord, yearRecord: broken.yearRecord }];
    expectP3EError(
      () => readP3ELedgerHistory(historyOf(records)),
      "E_P3E_HISTORY",
      "ledgerHistory.records.prevCommandHash"
    );
  });

  it("prevChainHash 斷鏈（第二筆不等於前一筆 chainHash）", () => {
    const pairs = syntheticPairs(2, GENESIS_ANCHOR);
    const broken = syntheticPair({
      index: 2,
      stateHashBefore: (pairs[0]?.yearRecord as Dict).stateHashAfter as string,
      prevCommandHash: (pairs[0]?.commandRecord as P3ECommandRecord).commandHash,
      prevChainHash: HEX_B
    });
    const records = [pairs[0], { commandRecord: broken.commandRecord, yearRecord: broken.yearRecord }];
    expectP3EError(
      () => readP3ELedgerHistory(historyOf(records)),
      "E_P3E_HISTORY",
      "ledgerHistory.records.prevChainHash"
    );
  });

  it("第一筆 stateHashBefore 不等於 initial.stateHash", () => {
    const broken = syntheticPair({
      index: 1,
      stateHashBefore: HEX_A,
      prevCommandHash: GENESIS_ANCHOR.commandHeadHash,
      prevChainHash: GENESIS_ANCHOR.chainHash
    });
    expectP3EError(
      () => readP3ELedgerHistory(historyOf([{ commandRecord: broken.commandRecord, yearRecord: broken.yearRecord }])),
      "E_P3E_HISTORY",
      "ledgerHistory.records.stateHashBefore"
    );
  });

  it("第一筆 prevCommandHash 不等於 initial.commandHeadHash", () => {
    const broken = syntheticPair({
      index: 1,
      stateHashBefore: GENESIS_ANCHOR.stateHash,
      prevCommandHash: HEX_B,
      prevChainHash: GENESIS_ANCHOR.chainHash
    });
    expectP3EError(
      () => readP3ELedgerHistory(historyOf([{ commandRecord: broken.commandRecord, yearRecord: broken.yearRecord }])),
      "E_P3E_HISTORY",
      "ledgerHistory.records.prevCommandHash"
    );
  });

  it("第一筆 prevChainHash 不等於 initial.chainHash", () => {
    const broken = syntheticPair({
      index: 1,
      stateHashBefore: GENESIS_ANCHOR.stateHash,
      prevCommandHash: GENESIS_ANCHOR.commandHeadHash,
      prevChainHash: HEX_B
    });
    expectP3EError(
      () => readP3ELedgerHistory(historyOf([{ commandRecord: broken.commandRecord, yearRecord: broken.yearRecord }])),
      "E_P3E_HISTORY",
      "ledgerHistory.records.prevChainHash"
    );
  });

  it("合成鏈正例：4095 筆可完整讀取（4096 為上限內）", () => {
    const pairs = syntheticPairs(contracts.P3E_MAX_COMMANDS - 1, GENESIS_ANCHOR);
    const read = readP3ELedgerHistory(historyOf(pairs));
    expect(read.records.length).toBe(contracts.P3E_MAX_COMMANDS - 1);
  });
});

/* ================================================================== */
/* 四、read：shape／Record 反例                                         */
/* ================================================================== */

describe("H5-CTO-175-A Ledger History V1：read（shape／Record 反例）", () => {
  const legalPair = syntheticPair({
    index: 1,
    stateHashBefore: GENESIS_ANCHOR.stateHash,
    prevCommandHash: GENESIS_ANCHOR.commandHeadHash,
    prevChainHash: GENESIS_ANCHOR.chainHash
  });
  const legalRecord = { commandRecord: legalPair.commandRecord, yearRecord: legalPair.yearRecord };
  const legalHistory: Dict = { initial: { ...GENESIS_ANCHOR }, records: [legalRecord] };

  it("頂層：null／陣列／class instance／多欄／少欄", () => {
    expectP3EError(() => readP3ELedgerHistory(null), "E_P3E_HISTORY", "ledgerHistory.input");
    expectP3EError(() => readP3ELedgerHistory([]), "E_P3E_HISTORY", "ledgerHistory.input");
    expectP3EError(
      () => readP3ELedgerHistory(new (class { public initial = 1; })()),
      "E_P3E_HISTORY",
      "ledgerHistory.input"
    );
    expectP3EError(() => readP3ELedgerHistory({ ...legalHistory, extra: 1 }), "E_P3E_HISTORY", "ledgerHistory.input");
    expectP3EError(
      () => readP3ELedgerHistory({ initial: legalHistory.initial }),
      "E_P3E_HISTORY",
      "ledgerHistory.input"
    );
    expectP3EError(() => readP3ELedgerHistory({ records: [] }), "E_P3E_HISTORY", "ledgerHistory.input");
    // 同數量但鍵名不符（size 相等、expected 鍵缺席 → hasExactKeys 第二道防線）。
    expectP3EError(() => readP3ELedgerHistory({ foo: 1, bar: 2 }), "E_P3E_HISTORY", "ledgerHistory.input");
  });

  it("頂層：hidden（不可列舉）額外欄位／symbol 鍵／accessor／revoked Proxy", () => {
    const hidden: Dict = { ...legalHistory };
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false, writable: true, configurable: true });
    expectP3EError(() => readP3ELedgerHistory(hidden), "E_P3E_HISTORY", "ledgerHistory.input");

    const withSymbol: Dict = { ...legalHistory };
    Object.defineProperty(withSymbol, Symbol("x"), { value: 1, enumerable: true, writable: true, configurable: true });
    expectP3EError(() => readP3ELedgerHistory(withSymbol), "E_P3E_HISTORY", "ledgerHistory.input");

    let getterCalls = 0;
    const withAccessor: Dict = { ...legalHistory };
    Object.defineProperty(withAccessor, "initial", {
      get() { getterCalls += 1; return legalHistory.initial; },
      enumerable: true,
      configurable: true
    });
    expectP3EError(() => readP3ELedgerHistory(withAccessor), "E_P3E_HISTORY", "ledgerHistory.input");
    expect(getterCalls).toBe(0);

    const revoked = Proxy.revocable(legalHistory, {});
    revoked.revoke();
    expectP3EError(() => readP3ELedgerHistory(revoked.proxy), "E_P3E_HISTORY", "ledgerHistory.input");
  });

  it("anchor：多欄／少欄／null／非 hex", () => {
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR, extra: 1 }, records: [] }),
      "E_P3E_HISTORY",
      "ledgerHistory.initial"
    );
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { stateHash: GENESIS_ANCHOR.stateHash }, records: [] }),
      "E_P3E_HISTORY",
      "ledgerHistory.initial"
    );
    expectP3EError(
      () => readP3ELedgerHistory({ initial: null, records: [] }),
      "E_P3E_HISTORY",
      "ledgerHistory.initial"
    );
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR, stateHash: "not-hex" }, records: [] }),
      "E_P3E_HISTORY",
      "ledgerHistory.initial.stateHash"
    );
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR, commandHeadHash: 42 }, records: [] }),
      "E_P3E_HISTORY",
      "ledgerHistory.initial.commandHeadHash"
    );
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR, chainHash: "XYZ" }, records: [] }),
      "E_P3E_HISTORY",
      "ledgerHistory.initial.chainHash"
    );
  });

  it("records：非陣列／稀疏／額外鍵／symbol", () => {
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: {} }),
      "E_P3E_HISTORY",
      "ledgerHistory.records"
    );
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: "x" }),
      "E_P3E_HISTORY",
      "ledgerHistory.records"
    );

    const sparse = new Array(2);
    sparse[0] = legalRecord;
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: sparse }),
      "E_P3E_HISTORY",
      "ledgerHistory.records"
    );

    const withExtra = [legalRecord] as unknown as Dict;
    withExtra.extra = 1;
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: withExtra }),
      "E_P3E_HISTORY",
      "ledgerHistory.records"
    );

    const withSymbol = [legalRecord] as unknown as Dict;
    Object.defineProperty(withSymbol, Symbol("x"), { value: 1, enumerable: true, writable: true, configurable: true });
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: withSymbol }),
      "E_P3E_HISTORY",
      "ledgerHistory.records"
    );

    // 不可列舉的索引元素（names 含索引、Object.keys 不含 → 密度第二道防線）。
    const nonEnumerable = [legalRecord];
    Object.defineProperty(nonEnumerable, 0, {
      value: legalRecord,
      enumerable: false,
      writable: true,
      configurable: true
    });
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: nonEnumerable }),
      "E_P3E_HISTORY",
      "ledgerHistory.records"
    );
  });

  it("records：accessor 元素（getter 呼叫 0 次）", () => {
    let getterCalls = 0;
    const withAccessorElement = [legalRecord];
    Object.defineProperty(withAccessorElement, 0, {
      get() { getterCalls += 1; return legalRecord; },
      enumerable: true,
      configurable: true
    });
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: withAccessorElement }),
      "E_P3E_HISTORY",
      "ledgerHistory.records"
    );
    expect(getterCalls).toBe(0);
  });

  it("records：revoked Proxy 陣列不外洩原生例外", () => {
    const revoked = Proxy.revocable([legalRecord], {});
    revoked.revoke();
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: revoked.proxy }),
      "E_P3E_HISTORY",
      "ledgerHistory.records"
    );
  });

  it("records：超過 4096 筆（4097）", () => {
    const tooMany = new Array(contracts.P3E_MAX_COMMANDS + 1).fill(legalRecord);
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: tooMany }),
      "E_P3E_HISTORY",
      "ledgerHistory.records.length"
    );
  });

  it("Pair：多欄／少欄／陣列／class instance／accessor", () => {
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: [{ ...legalRecord, extra: 1 }] }),
      "E_P3E_HISTORY",
      "ledgerHistory.records.pair"
    );
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: [{ commandRecord: legalPair.commandRecord }] }),
      "E_P3E_HISTORY",
      "ledgerHistory.records.pair"
    );
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: [[legalRecord]] }),
      "E_P3E_HISTORY",
      "ledgerHistory.records.pair"
    );
    expectP3EError(
      () => readP3ELedgerHistory({
        initial: { ...GENESIS_ANCHOR },
        records: [new (class { public commandRecord = legalPair.commandRecord; })()]
      }),
      "E_P3E_HISTORY",
      "ledgerHistory.records.pair"
    );

    let getterCalls = 0;
    const withAccessor: Dict = { ...legalRecord };
    Object.defineProperty(withAccessor, "yearRecord", {
      get() { getterCalls += 1; return legalPair.yearRecord; },
      enumerable: true,
      configurable: true
    });
    expectP3EError(
      () => readP3ELedgerHistory({ initial: { ...GENESIS_ANCHOR }, records: [withAccessor] }),
      "E_P3E_HISTORY",
      "ledgerHistory.records.pair"
    );
    expect(getterCalls).toBe(0);
  });

  it("Pair：malformed Command Record（原樣外拋正式錯誤）", () => {
    const tampered = { ...(legalPair.commandRecord as unknown as Dict) };
    delete tampered.entryHash;
    expectP3EError(
      () => readP3ELedgerHistory({
        initial: { ...GENESIS_ANCHOR },
        records: [{ commandRecord: tampered, yearRecord: legalPair.yearRecord }]
      }),
      "E_P3E_COMMAND",
      "commandRecord"
    );
  });

  it("Pair：commandHash 與欄位不一致（原樣外拋）", () => {
    const tampered = { ...(legalPair.commandRecord as unknown as Dict), stateHashAfter: HEX_F };
    expectP3EError(
      () => readP3ELedgerHistory({
        initial: { ...GENESIS_ANCHOR },
        records: [{ commandRecord: tampered, yearRecord: legalPair.yearRecord }]
      }),
      "E_P3E_COMMAND",
      "commandRecord.commandHash"
    );
  });

  it("Pair：malformed Year Record（原樣外拋）", () => {
    const tampered = { ...(legalPair.yearRecord as Dict) };
    delete tampered.chainHash;
    expectP3EError(
      () => readP3ELedgerHistory({
        initial: { ...GENESIS_ANCHOR },
        records: [{ commandRecord: legalPair.commandRecord, yearRecord: tampered }]
      }),
      "E_P3E_HISTORY",
      "yearLedgerRecord"
    );
  });

  it("Pair：year 與 command 的 index 不一致（原樣外拋）", () => {
    const tampered = { ...(legalPair.yearRecord as Dict), index: 2 };
    expectP3EError(
      () => readP3ELedgerHistory({
        initial: { ...GENESIS_ANCHOR },
        records: [{ commandRecord: legalPair.commandRecord, yearRecord: tampered }]
      }),
      "E_P3E_HISTORY",
      "yearLedgerRecord.commandRecord"
    );
  });

  it("Pair：entryHash 與欄位不一致（原樣外拋）", () => {
    const tampered = { ...(legalPair.yearRecord as Dict), entryHash: HEX_F };
    expectP3EError(
      () => readP3ELedgerHistory({
        initial: { ...GENESIS_ANCHOR },
        records: [{ commandRecord: legalPair.commandRecord, yearRecord: tampered }]
      }),
      "E_P3E_HISTORY",
      "yearLedgerRecord.entryHash"
    );
  });

  it("Pair：year 與 command 的 commandHash 不一致（原樣外拋）", () => {
    const tampered = { ...(legalPair.yearRecord as Dict), commandHash: HEX_F };
    expectP3EError(
      () => readP3ELedgerHistory({
        initial: { ...GENESIS_ANCHOR },
        records: [{ commandRecord: legalPair.commandRecord, yearRecord: tampered }]
      }),
      "E_P3E_HISTORY",
      "yearLedgerRecord.commandRecord"
    );
  });
});

/* ================================================================== */
/* 五、create 反例                                                     */
/* ================================================================== */

describe("H5-CTO-175-A Ledger History V1：create（反例）", () => {
  it("非初始 State（count !== 0）不得建立空 History", () => {
    const nonInitial = stateAt(5);
    expect(nonInitial.commandLog.count).toBe(0);
    // stateAt 保留 genesis 的 count=0；把 count 改成 1（stateHash 不含 commandLog）。
    const withCount = stateWithCount(nonInitial, 1);
    expect(withCount.commandLog.count).toBe(1);
    expectP3EError(() => createP3ELedgerHistory(withCount), "E_P3E_HISTORY", "ledgerHistory.initial");
  });

  it("malformed State 原樣外拋正式錯誤", () => {
    expectP3ECode(() => createP3ELedgerHistory(null), "E_P3E_STATE");
    expectP3ECode(() => createP3ELedgerHistory({ broken: true }), "E_P3E_STATE");
  });
});

/* ================================================================== */
/* 六、append 反例：input／tail match／continuity                        */
/* ================================================================== */

describe("H5-CTO-175-A Ledger History V1：append（input／tail／continuity 反例）", () => {
  it("input：null／陣列／多欄／少欄／accessor／revoked Proxy", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const input = appendInput(history, genesisDecision, result);

    expectP3EError(() => appendP3ELedgerHistory(null), "E_P3E_HISTORY", "ledgerHistory.append.input");
    expectP3EError(() => appendP3ELedgerHistory([]), "E_P3E_HISTORY", "ledgerHistory.append.input");
    expectP3EError(
      () => appendP3ELedgerHistory({ ...input, extra: 1 }),
      "E_P3E_HISTORY",
      "ledgerHistory.append.input"
    );
    expectP3EError(
      () => appendP3ELedgerHistory({ history, previousState: genesisDecision }),
      "E_P3E_HISTORY",
      "ledgerHistory.append.input"
    );

    let getterCalls = 0;
    const withAccessor: Dict = { ...input };
    Object.defineProperty(withAccessor, "history", {
      get() { getterCalls += 1; return history; },
      enumerable: true,
      configurable: true
    });
    expectP3EError(() => appendP3ELedgerHistory(withAccessor), "E_P3E_HISTORY", "ledgerHistory.append.input");
    expect(getterCalls).toBe(0);

    const revoked = Proxy.revocable(input, {});
    revoked.revoke();
    expectP3EError(() => appendP3ELedgerHistory(revoked.proxy), "E_P3E_HISTORY", "ledgerHistory.append.input");
  });

  it("append 內含非法 history／previousState 原樣外拋", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);

    expectP3EError(
      () => appendP3ELedgerHistory(appendInput({ broken: 1 }, genesisDecision, result)),
      "E_P3E_HISTORY",
      "ledgerHistory.input"
    );
    expectP3ECode(
      () => appendP3ELedgerHistory(appendInput(history, { broken: 1 } as unknown as contracts.P3ELifeState, result)),
      "E_P3E_STATE"
    );
  });

  it("空 History：previousState.commandLog.count !== 0", () => {
    // age > 0 的初始 State（readP3EState 不做 genesis integrity 檢查，
    // commandLog 不在 stateHash projection 內，改 count 後仍然自洽）。
    // R1：create 只接受 Genesis，這裡改用外部 anchor。
    const base = stateAt(5);
    const history = externalAnchorHistory(base);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const nonInitial = stateWithCount(base, 3);
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(history, nonInitial, result)),
      "E_P3E_HISTORY",
      "ledgerHistory.append.count"
    );
  });

  it("空 History：previousState.stateHash 不等於 initial.stateHash", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    // stateAt(5) 的 count 仍是 0，但 stateHash 不同。
    const otherState = stateAt(5);
    expect(otherState.commandLog.count).toBe(0);
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(history, otherState, result)),
      "E_P3E_HISTORY",
      "ledgerHistory.append.stateHash"
    );
  });

  it("空 History：command head 不等於 initial.commandHeadHash", () => {
    // age > 0 的初始 State：commandLog 不在 stateHash projection 內，
    // 改 headHash 後 stateHash 仍然自洽（genesis age=0 會被 readP3EState 的
    // genesis integrity 擋下，故用 age=5 的 base）。R1：改用外部 anchor。
    const base = stateAt(5);
    const history = externalAnchorHistory(base);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const tampered = {
      ...base,
      commandLog: { ...base.commandLog, headHash: HEX_B }
    } as contracts.P3ELifeState;
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(history, tampered, result)),
      "E_P3E_HISTORY",
      "ledgerHistory.append.commandHead"
    );
  });

  it("空 History：chain head 不等於 initial.chainHash", () => {
    // age > 0 的初始 State：heads.hashChain 不在 stateHash projection 內。
    // R1：改用外部 anchor。
    const base = stateAt(5);
    const history = externalAnchorHistory(base);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const tampered = {
      ...base,
      heads: { ...base.heads, hashChain: HEX_B }
    } as contracts.P3ELifeState;
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(history, tampered, result)),
      "E_P3E_HISTORY",
      "ledgerHistory.append.chainHead"
    );
  });

  it("非空 History：count 與 records.length 不一致（1 vs 2）", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const first = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const onePair = appendP3ELedgerHistory(appendInput(history, genesisDecision, first));
    const second = execute(first.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);

    // stateHash projection 不含 commandLog，改 count 後 stateHash 仍然自洽。
    const tampered = {
      ...first.state,
      commandLog: { ...first.state.commandLog, count: 2 }
    } as contracts.P3ELifeState;
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(onePair, tampered, second)),
      "E_P3E_HISTORY",
      "ledgerHistory.append.count"
    );
  });

  it("非空 History：stateHash 不等於尾端 stateHashAfter", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const first = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const onePair = appendP3ELedgerHistory(appendInput(history, genesisDecision, first));
    const second = execute(first.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);

    // count 相同（1）但 stateHash 不同的合法 state。
    const other = stateWithCount(stateAt(6, { pack: packDecision }), 1);
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(onePair, other, second)),
      "E_P3E_HISTORY",
      "ledgerHistory.append.stateHash"
    );
  });

  it("非空 History：command head 不等於尾端 commandHash", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const first = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const onePair = appendP3ELedgerHistory(appendInput(history, genesisDecision, first));
    const second = execute(first.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);

    const tampered = {
      ...first.state,
      commandLog: { ...first.state.commandLog, headHash: HEX_F }
    } as contracts.P3ELifeState;
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(onePair, tampered, second)),
      "E_P3E_HISTORY",
      "ledgerHistory.append.commandHead"
    );
  });

  it("非空 History：chain head 不等於尾端 chainHash", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const first = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const onePair = appendP3ELedgerHistory(appendInput(history, genesisDecision, first));
    const second = execute(first.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);

    const tampered = {
      ...first.state,
      heads: { ...first.state.heads, hashChain: HEX_F }
    } as contracts.P3ELifeState;
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(onePair, tampered, second)),
      "E_P3E_HISTORY",
      "ledgerHistory.append.chainHead"
    );
  });

  it("非空 History：ledger head（snapshotHash）與尾端不一致", () => {
    const { history, previousState } = mismatchedLedgerHeadFixture("snapshot");
    // 讀回必須先通過（尾端 Pair 內部與跨紀錄鏈結全部自洽）。
    readP3ELedgerHistory(history);
    const dummy = syntheticPair({
      index: 2,
      stateHashBefore: HEX_A,
      prevCommandHash: HEX_B,
      prevChainHash: HEX_C
    });
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(history, previousState, dummy)),
      "E_P3E_HISTORY",
      "ledgerHistory.append.ledgerHeads"
    );
  });

  it("非空 History：ledger head（deltaHash）與尾端不一致", () => {
    const { history, previousState } = mismatchedLedgerHeadFixture("delta");
    readP3ELedgerHistory(history);
    const dummy = syntheticPair({
      index: 2,
      stateHashBefore: HEX_A,
      prevCommandHash: HEX_B,
      prevChainHash: HEX_C
    });
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(history, previousState, dummy)),
      "E_P3E_HISTORY",
      "ledgerHistory.append.ledgerHeads"
    );
  });

  it("Continuity 錯誤原樣外拋（index 不連續）", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const first = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const onePair = appendP3ELedgerHistory(appendInput(history, genesisDecision, first));
    const second = execute(first.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);

    // Tail match 通過（previousState = 尾端 state），但新 commandRecord 的 index 錯。
    const wrongIndex = syntheticPair({
      index: 5,
      stateHashBefore: first.state.stateHash,
      prevCommandHash: first.state.commandLog.headHash,
      prevChainHash: first.state.heads.hashChain,
      rngBefore: first.state.rng,
      rngAfter: first.state.rng
    });
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(onePair, first.state, wrongIndex)),
      "E_P3E_HISTORY",
      "ledgerContinuity.index"
    );
    // 對照：同一份 history 用真正連續的第二筆可以通過。
    readP3ELedgerHistory(appendP3ELedgerHistory(appendInput(onePair, first.state, second)));
  });

  it("Continuity 錯誤原樣外拋（phase 不合法的命令）", () => {
    // life phase 不能執行 CHOOSE_DECISION → E_P3E_COMMAND at ledgerContinuity.command。
    const lifeState = stateAt(5, { pack: packDecision });
    const illegal = syntheticPair({
      index: 1,
      stateHashBefore: lifeState.stateHash,
      prevCommandHash: lifeState.commandLog.headHash,
      prevChainHash: lifeState.heads.hashChain,
      rngBefore: lifeState.rng,
      rngAfter: lifeState.rng,
      command: { type: "CHOOSE_DECISION", optionId: "save" }
    });
    expectP3EError(
      () => appendP3ELedgerHistory(
        appendInput(externalAnchorHistory(lifeState), lifeState, illegal)
      ),
      "E_P3E_COMMAND",
      "ledgerContinuity.command"
    );
  });

  it("4096 滿載後 append 第 4097 筆：Continuity 數量上限擋下", () => {
    // 依「尾端為準」的 Q-state 技巧組出 4096 筆、尾端與 previousState 完全對齊。
    const state4096 = stateWithCount(stateAt(5, { pack: packDecision }), contracts.P3E_MAX_COMMANDS);
    const snapshotQ = state4096.heads.lastSnapshotHash;
    const deltaQ = state4096.heads.lastDeltaHash;
    const entryHash = computeP3EYearEntryHash({
      index: contracts.P3E_MAX_COMMANDS,
      year: state4096.currentYear + 1,
      age: state4096.age + 1,
      phase: "life",
      stateHashBefore: HEX_C,
      rngBefore: state4096.rng,
      rngAfter: state4096.rng,
      snapshotHash: snapshotQ,
      deltaHash: deltaQ
    }) as string;

    const qDraft = {
      ...state4096,
      commandLog: { count: contracts.P3E_MAX_COMMANDS, headHash: HEX_B },
      heads: { lastSnapshotHash: snapshotQ, lastDeltaHash: deltaQ, lastEntryHash: entryHash, hashChain: HEX_B }
    };
    const qStateHash = computeP3EStateHash(qDraft as never);

    // 前 4095 筆以 HEX_C 鏈結；第 4096 筆改以「Q 對齊」的欄位重建。
    const pairs = syntheticPairs(contracts.P3E_MAX_COMMANDS, GENESIS_ANCHOR, qStateHash);
    const prevPair = pairs[contracts.P3E_MAX_COMMANDS - 2] as Dict;
    const last = syntheticPair({
      index: contracts.P3E_MAX_COMMANDS,
      year: state4096.currentYear + 1,
      age: state4096.age + 1,
      phase: "life",
      stateHashBefore: HEX_C,
      stateHashAfter: qStateHash,
      prevCommandHash: (prevPair.commandRecord as P3ECommandRecord).commandHash,
      prevChainHash: (prevPair.yearRecord as Dict).chainHash as string,
      rngBefore: state4096.rng,
      rngAfter: state4096.rng,
      snapshotHash: snapshotQ,
      deltaHash: deltaQ
    });
    pairs[contracts.P3E_MAX_COMMANDS - 1] = { commandRecord: last.commandRecord, yearRecord: last.yearRecord };

    const qState = {
      ...qDraft,
      commandLog: { count: contracts.P3E_MAX_COMMANDS, headHash: last.commandRecord.commandHash },
      heads: {
        lastSnapshotHash: snapshotQ,
        lastDeltaHash: deltaQ,
        lastEntryHash: entryHash,
        hashChain: last.yearRecord.chainHash
      },
      stateHash: qStateHash
    } as contracts.P3ELifeState;

    const history = { initial: { ...GENESIS_ANCHOR }, records: pairs };
    // 4096 筆在上限內，read 必須通過。
    expect(readP3ELedgerHistory(history).records.length).toBe(contracts.P3E_MAX_COMMANDS);

    // 尾端完全一致 → tail match 過 → Continuity 的數量上限擋下第 4097 筆。
    const dummy = syntheticPair({
      index: contracts.P3E_MAX_COMMANDS + 1,
      stateHashBefore: HEX_A,
      prevCommandHash: HEX_B,
      prevChainHash: HEX_C
    });
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(history, qState, dummy)),
      "E_P3E_HISTORY",
      "ledgerContinuity.index"
    );
  });
});

/* ================================================================== */
/* 七、共同契約                                                        */
/* ================================================================== */

describe("H5-CTO-175-A Ledger History V1：共同契約", () => {
  it("公開表面：create／append 已公開，read 保持私有", () => {
    expect(Object.keys(barrel)).toContain("createP3ELedgerHistory");
    expect(Object.keys(barrel)).toContain("appendP3ELedgerHistory");
    expect(Object.keys(barrel)).not.toContain("readP3ELedgerHistory");
    expect(BARREL_SRC).toContain("./ledger-history");
  });

  it("模組必須重用五個正式原語／常數", () => {
    for (const token of [
      "readP3EState",
      "readP3ECommandRecord",
      "verifyP3EYearLedgerRecord",
      "validateP3ELedgerContinuity",
      "P3E_MAX_COMMANDS"
    ]) {
      expect(HISTORY_CODE, `模組必須重用 ${token}`).toContain(token);
    }
    expect(HISTORY_SRC).toContain('from "./ledger-continuity"');
  });

  it("模組不得依賴 Command Executor／業務原語／hash 計算", () => {
    const forbidden = [
      "executeP3ECommand",
      "appendP3ELedgerTransition",
      "materializeP3ETransition",
      "resolveP3EAnnualPendingDecision",
      "resolveP3EDecisionChoice",
      "assembleP3EAnnualStateCoreDraft",
      "assembleP3EDecisionStateCoreDraft",
      "drawP3ERollDeltas",
      "applyEventEffects",
      "createP3ECommandRecord",
      "createP3EYearLedgerRecord",
      "createP3EGenesis",
      "sealP3EState",
      "computeP3EStateHash",
      "computeP3ESnapshotHash",
      "computeP3EDeltaHash",
      "computeP3EYearEntryHash",
      "computeP3EYearChainHash",
      "computeP3ECommandHash",
      "computeP3ECommandArgsHash",
      "Xoshiro",
      "nextU32",
      "uniformInt",
      "uniformBigInt"
    ];
    for (const token of forbidden) {
      expect(HISTORY_CODE, `模組不得出現 ${token}`).not.toContain(token);
    }
    expect(HISTORY_CODE).not.toContain("command-executor");
  });

  it("模組不得建立 Codec／Replay／Save 基礎設施", () => {
    for (const token of ["codec", "Codec", "replay", "Replay", "encodeP3E", "decodeP3E", "saveFormat", "SaveFormat"]) {
      expect(HISTORY_CODE, `模組不得出現 ${token}`).not.toContain(token);
    }
  });

  it("三個入口簽章固定", () => {
    expect(HISTORY_SRC).toContain("export function createP3ELedgerHistory(initialState: unknown): P3ELedgerHistory");
    expect(HISTORY_SRC).toContain("export function readP3ELedgerHistory(input: unknown): P3ELedgerHistory");
    expect(HISTORY_SRC).toContain("export function appendP3ELedgerHistory(input: unknown): P3ELedgerHistory");
  });

  it("固定資料模型：anchor 三欄、pair 兩欄、history 兩欄（無 timestamp／nonce／metadata）", () => {
    expect(HISTORY_SRC).toContain("readonly stateHash: string;");
    expect(HISTORY_SRC).toContain("readonly commandHeadHash: string;");
    expect(HISTORY_SRC).toContain("readonly chainHash: string;");
    expect(HISTORY_SRC).toContain("readonly commandRecord: P3ECommandRecord;");
    expect(HISTORY_SRC).toContain("readonly yearRecord: P3EYearLedgerRecord;");
    expect(HISTORY_SRC).toContain("readonly initial: P3ELedgerHistoryAnchor;");
    for (const token of ["timestamp", "nonce", "metadata"]) {
      expect(HISTORY_CODE, `模組不得出現 ${token}`).not.toContain(token);
    }
  });

  it("輸入執行後保持不變（create／read／append）", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);

    const stateBefore = stable(genesisDecision);
    createP3ELedgerHistory(genesisDecision);
    expect(stable(genesisDecision)).toBe(stateBefore);

    const rawHistory: Dict = {
      initial: { ...GENESIS_ANCHOR },
      records: [{ commandRecord: result.commandRecord, yearRecord: result.yearRecord }]
    };
    const historyBefore = stable(rawHistory);
    readP3ELedgerHistory(rawHistory);
    expect(stable(rawHistory)).toBe(historyBefore);

    const input = appendInput(history, genesisDecision, result);
    const inputBefore = stable(input);
    appendP3ELedgerHistory(input);
    expect(stable(input)).toBe(inputBefore);
  });

  it("read 輸出深層凍結、零共享、讀兩次等價（合成歷史）", () => {
    const pairs = syntheticPairs(3, GENESIS_ANCHOR);
    const rawHistory: Dict = { initial: { ...GENESIS_ANCHOR }, records: pairs };

    const read = readP3ELedgerHistory(rawHistory);
    expect(isDeepFrozen(read)).toBe(true);
    expect(sharesReference(read, rawHistory)).toBe(false);

    const again = readP3ELedgerHistory(read);
    expect(stable(again)).toBe(stable(read));
    expect(sharesReference(again, read)).toBe(false);
  });
});

/* ================================================================== */
/* 八、H5-CTO-175-A-R1：Genesis 限定、可信品牌與增量快速路徑              */
/* ================================================================== */

describe("H5-CTO-175-A-R1：Genesis 限定與可信快速路徑", () => {
  /** 深層凍結一個普通物件（外部偽造物用；與模組的可信品牌無關）。 */
  function deepFreezePlain<T>(value: T): T {
    if (typeof value !== "object" || value === null) return value;
    for (const item of Object.values(value as Dict)) deepFreezePlain(item);
    return Object.freeze(value);
  }

  it("R1-1 create 拒絕 age > 0／count = 0 的 State（E_P3E_HISTORY at ledgerHistory.initial）", () => {
    const nonGenesis = stateAt(5);
    expect(nonGenesis.commandLog.count).toBe(0);
    expect(nonGenesis.age).toBeGreaterThan(contracts.P3E_MIN_AGE);
    expectP3EError(() => createP3ELedgerHistory(nonGenesis), "E_P3E_HISTORY", "ledgerHistory.initial");
  });

  it("R1-2 create 的 Genesis 輸出可直接 append，且沿用已驗證凍結的 anchor", () => {
    const created = createP3ELedgerHistory(genesisDecision);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);

    const appended = appendP3ELedgerHistory(appendInput(created, genesisDecision, result));

    expect(appended.records.length).toBe(1);
    expect(appended.initial).toBe(created.initial);
    expect(isDeepFrozen(appended)).toBe(true);
  });

  it("R1-3 read 的輸出可直接 append（可信）：舊 Pair identity 保留，未做深複製", () => {
    const advance1 = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const choose = execute(advance1.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    const rawHistory: Dict = {
      initial: { ...GENESIS_ANCHOR },
      records: [{ commandRecord: advance1.commandRecord, yearRecord: advance1.yearRecord }]
    };

    const read = readP3ELedgerHistory(rawHistory);
    const appended = appendP3ELedgerHistory(appendInput(read, advance1.state, choose));

    expect(appended.records.length).toBe(2);
    // 可信快速路徑：不重建既有 Pair（identity 保留）。
    expect(appended.records[0]).toBe(read.records[0]);
    expect(appended.records[1]).not.toBe(read.records[1]);
  });

  it("R1-4 append 的輸出可繼續走可信 append：三段鏈的舊 Pair identity 全保留", () => {
    const advance1 = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const choose = execute(advance1.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    const advance2 = execute(choose.state, { ...ADVANCE }, packDecision);

    const first = appendP3ELedgerHistory(
      appendInput(createP3ELedgerHistory(genesisDecision), genesisDecision, advance1)
    );
    const second = appendP3ELedgerHistory(appendInput(first, advance1.state, choose));
    const third = appendP3ELedgerHistory(appendInput(second, choose.state, advance2));

    expect(third.records.length).toBe(3);
    expect(third.records[0]).toBe(first.records[0]);
    expect(third.records[1]).toBe(second.records[1]);
    expect(third.records[2]).not.toBe(second.records[2]);
    expect(isDeepFrozen(third)).toBe(true);
  });

  it("R1-5 快速 append 的不可變性契約：新外層／新陣列、舊 Pair identity 相同、新 Pair identity 不同、全深凍結", () => {
    const advance1 = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const choose = execute(advance1.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    const first = appendP3ELedgerHistory(
      appendInput(createP3ELedgerHistory(genesisDecision), genesisDecision, advance1)
    );

    const second = appendP3ELedgerHistory(appendInput(first, advance1.state, choose));

    // 新外層 History、新 records 陣列。
    expect(second).not.toBe(first);
    expect(second.records).not.toBe(first.records);
    // 已驗證凍結的 initial／舊 Pair 允許結構共享（identity 相同）。
    expect(second.initial).toBe(first.initial);
    expect(second.records[0]).toBe(first.records[0]);
    // 新 Pair 必須是不同 identity 的深層凍結資料。
    expect(second.records[1]).not.toBe(first.records[1]);
    expect(isDeepFrozen(second)).toBe(true);
    // 輸入未被修改。
    expect(first.records.length).toBe(1);
  });

  it("R1-6 外部 structuredClone 不得取得可信品牌：完整 read 會重建舊 Pair（identity 不同）", () => {
    const advance1 = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const choose = execute(advance1.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    const trusted = appendP3ELedgerHistory(
      appendInput(createP3ELedgerHistory(genesisDecision), genesisDecision, advance1)
    );

    const clone = structuredClone(trusted);
    const appended = appendP3ELedgerHistory(appendInput(clone, advance1.state, choose));

    expect(appended.records.length).toBe(2);
    // 內容相同，但走完整 read → 舊 Pair 被重建（identity 不同）。
    expect(appended.records[0]).not.toBe(clone.records[0]);
    expect(stable(appended.records[0])).toBe(stable(trusted.records[0]));
  });

  it("R1-7 不可信 history 中間任一 Pair 被竄改仍被完整驗證拒絕", () => {
    const advance1 = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const choose = execute(advance1.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    const advance2 = execute(choose.state, { ...ADVANCE }, packDecision);
    const first = appendP3ELedgerHistory(
      appendInput(createP3ELedgerHistory(genesisDecision), genesisDecision, advance1)
    );
    const second = appendP3ELedgerHistory(appendInput(first, advance1.state, choose));
    const third = appendP3ELedgerHistory(appendInput(second, choose.state, advance2));

    // 外部複製品：把「中間那一筆」的 yearRecord 竄改掉（改 snapshotHash
    // → 該筆自己的 entryHash 重算不再相符）。
    const tampered = structuredClone(third) as unknown as Dict;
    const middle = (tampered.records as Dict[])[1] as Dict;
    (middle.yearRecord as Dict).snapshotHash = HEX_A;

    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(tampered, advance2.state, choose)),
      "E_P3E_HISTORY",
      "yearLedgerRecord.entryHash"
    );
  });

  it("R1-8 外部 frozen 偽造物不得取得可信品牌：完整 read 會重建舊 Pair（identity 不同）", () => {
    const advance1 = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const choose = execute(advance1.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    const trusted = appendP3ELedgerHistory(
      appendInput(createP3ELedgerHistory(genesisDecision), genesisDecision, advance1)
    );

    // 深層凍結的外部偽造物：長得一模一樣，但不是模組產生的物件。
    const forgery = deepFreezePlain({
      initial: { ...trusted.initial },
      records: trusted.records.map((pair) => ({ ...pair }))
    });
    const appended = appendP3ELedgerHistory(appendInput(forgery, advance1.state, choose));

    expect(appended.records.length).toBe(2);
    expect(appended.records[0]).not.toBe(forgery.records[0]);
    expect(stable(appended.records[0])).toBe(stable(trusted.records[0]));
  });

  it("R1-9 私有 WeakSet 品牌不在任何 export 或 barrel", () => {
    // 集合確實存在於模組內部。
    expect(HISTORY_CODE).toContain("new WeakSet<object>()");
    // 但不得以任何形式匯出。
    expect(HISTORY_SRC).not.toMatch(/export\s+(const|let|var|function|class)\s+trustedHistories/);
    expect(HISTORY_SRC).not.toMatch(/export\s*\{[^}]*trustedHistories/);
    expect(HISTORY_SRC).not.toContain("export const trustedHistories");
    // 模組的公開匯出只有三個入口。
    const exported = [...HISTORY_SRC.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map(
      (match) => match[1]
    );
    expect(exported.sort()).toEqual([
      "appendP3ELedgerHistory",
      "createP3ELedgerHistory",
      "readP3ELedgerHistory"
    ]);
    expect(Object.keys(barrel)).toContain("createP3ELedgerHistory");
    expect(Object.keys(barrel)).toContain("appendP3ELedgerHistory");
    expect(Object.keys(barrel)).not.toContain("readP3ELedgerHistory");
    expect(BARREL_SRC).not.toContain("trustedHistories");
  });

  it("R1-10 既有信任邊界不因可信路徑而鬆動：非可信 history 的完整驗證錯誤路徑不變", () => {
    const advance1 = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const choose = execute(advance1.state, { type: "CHOOSE_DECISION", optionId: "save" }, packDecision);
    const trusted = appendP3ELedgerHistory(
      appendInput(createP3ELedgerHistory(genesisDecision), genesisDecision, advance1)
    );

    // 非可信（外部）history 中被竄改的舊 Pair → 完整 read 仍以原路徑拒絕。
    const tampered = structuredClone(trusted) as unknown as Dict;
    const first = (tampered.records as Dict[])[0] as Dict;
    (first.yearRecord as Dict).chainHash = HEX_A;
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(tampered, advance1.state, choose)),
      "E_P3E_HISTORY",
      "yearLedgerRecord.chainHash"
    );

    // 可信 history 的 append 仍要通過 Continuity（尾端與新 Pair 都要對）。
    const wrongIndex = syntheticPair({
      index: 9,
      stateHashBefore: advance1.state.stateHash,
      prevCommandHash: advance1.state.commandLog.headHash,
      prevChainHash: advance1.state.heads.hashChain,
      rngBefore: advance1.state.rng,
      rngAfter: advance1.state.rng
    });
    expectP3EError(
      () => appendP3ELedgerHistory(appendInput(trusted, advance1.state, wrongIndex)),
      "E_P3E_HISTORY",
      "ledgerContinuity.index"
    );
  });
});

/* ================================================================== */
/* 九、H5-CTO-175-A：正式整合專屬測試                                   */
/* ================================================================== */

describe("H5-CTO-175-A 正式整合", () => {
  it("formal_continuity_import_only：正式模組只 import 正式 ./ledger-continuity", () => {
    expect(HISTORY_SRC).toContain('from "./ledger-continuity"');
    expect(HISTORY_SRC).not.toContain("continuity-v11");
  });

  it("candidate_import_absent：正式檔案不再以 import 引用候選模組", () => {
    const testSource = readFileSync(
      join(ROOT, "packages/simulation/test/ledger-history.test.ts"),
      "utf8"
    );
    for (const source of [HISTORY_SRC, testSource]) {
      expect(source).not.toMatch(/from\s+"[^"]*v1-candidate"/);
    }
  });

  it("formal_executor_real_pipeline_history_append：正式 executor 產生的 Pair 可 append 並對齊 State", () => {
    const history = createP3ELedgerHistory(genesisDecision);
    const result = execute(genesisDecision, { ...ADVANCE }, packDecision);
    const appended = appendP3ELedgerHistory(appendInput(history, genesisDecision, result));
    expect(appended.records.length).toBe(1);
    const tail = appended.records[0] as P3ELedgerHistoryRecordPair;
    expect(stable(tail.commandRecord)).toBe(stable(result.commandRecord));
    expect(stable(tail.yearRecord)).toBe(stable(result.yearRecord));
    expect(tail.commandRecord.commandHash).toBe(result.state.commandLog.headHash);
    expect(tail.yearRecord.chainHash).toBe(result.state.heads.hashChain);
    expect(tail.yearRecord.stateHashAfter).toBe(result.state.stateHash);
  });

  it("official_birth_to_death_51_command_history_matches_final_state_heads", () => {
    const officialEventPack = validateEventPack({
      manifest: rawEventManifest,
      events: rawEvents
    } as never);
    const officialSeed = "p3e-166-playable-runtime-v4";
    const officialCertificate = createBirthCertificate(
      base,
      identityPack,
      buildPeerGroup(base, identityPack, { seed: officialSeed, playerSexPolicy: "random" } as never),
      officialSeed
    );
    const genesis = createP3EGenesis({
      masterSeed: officialSeed,
      basePack: base,
      identityPack,
      certificate: officialCertificate,
      eventPack: officialEventPack,
      deathPack
    });

    let state: contracts.P3ELifeState = genesis;
    let history: P3ELedgerHistory = createP3ELedgerHistory(genesis);
    let commands = 0;
    while (state.phase !== "death") {
      const command: Dict =
        state.phase === "pending_decision"
          ? { type: "CHOOSE_DECISION", optionId: state.pendingDecision?.optionIds[0] as string }
          : { ...ADVANCE };
      const result = execute(state, command, officialEventPack);
      history = appendP3ELedgerHistory(appendInput(history, state, result));
      state = result.state;
      commands += 1;
      expect(commands).toBeLessThanOrEqual(contracts.P3E_MAX_COMMANDS);
    }

    expect(commands).toBe(107);
    expect(history.records.length).toBe(107);
    const tail = history.records[history.records.length - 1] as P3ELedgerHistoryRecordPair;
    expect(tail.commandRecord.commandHash).toBe(state.commandLog.headHash);
    expect(tail.yearRecord.chainHash).toBe(state.heads.hashChain);
    expect(tail.yearRecord.stateHashAfter).toBe(state.stateHash);
    expect(tail.yearRecord.entryHash).toBe(state.heads.lastEntryHash);
    expect(tail.yearRecord.snapshotHash).toBe(state.heads.lastSnapshotHash);
    expect(tail.yearRecord.deltaHash).toBe(state.heads.lastDeltaHash);
    expect(state.stateHash).toBe(
      "d323c0e1a88301ef04576b4d2cf0579779c67b289e30d386f1b51d868134eb1f"
    );
  });

  it("candidate_70_tests_preserved：候選 70 項語意保留，正式另加 5 項", () => {
    const testSource = readFileSync(
      join(ROOT, "packages/simulation/test/ledger-history.test.ts"),
      "utf8"
    );
    const itCount = (testSource.match(/^\s+it\(/gm) ?? []).length;
    const describeCount = (testSource.match(/^\s*describe\(/gm) ?? []).length;
    expect(itCount).toBe(75);
    expect(describeCount).toBe(9);
    for (const title of [
      "formal_continuity_import_only",
      "candidate_import_absent",
      "formal_executor_real_pipeline_history_append",
      "official_birth_to_death_51_command_history_matches_final_state_heads",
      "candidate_70_tests_preserved"
    ]) {
      expect(testSource).toContain(title);
    }
    expect(itCount - 5).toBe(70);
  });
});
