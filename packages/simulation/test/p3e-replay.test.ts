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
  computeEventsChecksum,
  computePackChecksum,
  validateEventPack,
  type ValidatedEventPack
} from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import { createP3EGenesis } from "../src/genesis";
import { isP3EError, type P3EError } from "../src/errors";
import { createP3ECommandRecord, type P3ECommandRecord } from "../src/command-record";
import { computeP3EYearChainHash, computeP3EYearEntryHash } from "../src/year-ledger-hash";
import { executeP3ECommand } from "../src/command-executor";
import {
  appendP3ELedgerHistory,
  createP3ELedgerHistory
} from "../src/ledger-history";
import {
  P3EReplayDivergenceError,
  replayP3ELedgerHistory,
  type P3EReplayResult
} from "../src/p3e-replay";
import * as barrel from "../src/index";
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * H5-CTO-180-A：P3-E Ledger Replay V1 正式測試。
 *
 * 來源：WorkBuddy 候選 `p3e-replay-v1-candidate.test.ts`（H5-CTO-180-A／-R1）
 * （SHA-256 `bdd12fb75b2276d1bebd163a0f5aefdd3a5756f4a895499c05b7b238215cc997`，
 * 經 H5-CTO-180-A 正式整合；23 項來源測試依原順序保留）。
 *
 * 期望值一律用**正式原語**獨立重算（live 執行＝正式 Command Executor V1），
 * 不用被測函式自己的輸出當答案。本檔**不**重建任何業務／hash／record 演算法。
 *
 * 合法 History 的來源：
 *
 * 1. **真實交易鏈**：`createP3ELedgerHistory` + 逐命令 `executeP3ECommand` +
 *    `appendP3ELedgerHistory`（與 live 完全同一路徑）；
 * 2. **合成 Pair**：用正式 hash 原語（`createP3ECommandRecord`／
 *    `computeP3EYearEntryHash`／`computeP3EYearChainHash`）組出「內部自洽」
 *    但**非真實交易**的 Pair——因為 `verifyP3EYearLedgerRecord` 把
 *    `yearRecord.entryHash` 鎖在 `commandRecord.entryHash` 上，任何要觸發
 *    replay 比較層（而非 History 驗證層）的 divergence 都必須用這種
 *    「hash 自洽的偽造 Pair」達成。
 *
 * ## 「custom age 51／無決策路徑」fixture 工程（合成反例與邊界測試用；
 *    **不是**正式 product path）
 *
 * - mortality 全歸零、僅 `DEATH_AGE(51)` = 1,000,000 ppm 的死亡包
 *   （checksum／license／lineage 全部重算後重新驗證）；
 * - `packNoCandidates`（`ev.child.first-word` 是 guardian contentMode，
 *   standard contentMode 下沒有任何候選事件 → stats 恆為基線）；
 * - hazard 1,000,000 ppm × health factor → 每年必死 → 恰好在 age 51 死亡，
 *   即恰好 51 個 `ADVANCE_YEAR` 命令。
 *
 * ## 「正式 product path」（H5-CTO-180-A-R1）
 *
 * - seed `p3e-166-playable-runtime-v4`；
 * - **untouched** 官方 packs：p2a+p2b+p3b+p3d raw fixture 直接以公開原語
 *   驗證（`validateEventPack`／`validateDeathPack`），不做任何 repair 或
 *   checksum 重算；
 * - 決策政策：pending 時 `CHOOSE_DECISION` 取第一個 `optionId`，否則
 *   `ADVANCE_YEAR contentMode=standard`；
 * - 期望：106 命令、39 個 pending choice、age 67 死亡（year 2091），
 *   最終 state／command head／chain／尾端 entry hash 為工作單固定值。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const REPLAY_SRC = readFileSync(
  join(ROOT, "packages/simulation/src/p3e-replay.ts"),
  "utf8"
);
const REPLAY_CODE = REPLAY_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
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
/** 沒有任何候選事件的事件包（standard contentMode 下）。 */
const packNoCandidates = repairedEventPack([cloneEvent("ev.child.first-word")]);
/** 只動 happiness／balance 的一般事件包（pack binding 反例用）。 */
const packPlain = repairedEventPack([cloneEvent("ev.any.setback")]);

/** untouched p3b event pack：raw fixture 直接以公開原語驗證（不重算 checksum）。 */
const eventPackOfficial = validateEventPack({ manifest: rawEventManifest, events: rawEvents } as never);

const SEED = "p3e-175-replay-v1";
/** 正式 product path 的 seed（H5-CTO-180-A-R1 固定）。 */
const SEED_OFFICIAL = "p3e-166-playable-runtime-v4";
const SEED_A = `${SEED}-a`;
const SEED_B = `${SEED}-b`;
const peerGroup = buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never);
const certificate = createBirthCertificate(base, identityPack, peerGroup, SEED);

/**
 * certificate 與 masterSeed 綁定（verifyCertificate 會用 seed 重播出生結果），
 * 所以每個 seed 都要各自重播 peerGroup 與 certificate。
 */
function certificateFor(seed: string): typeof certificate {
  if (seed === SEED) return certificate;
  const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
  return createBirthCertificate(base, identityPack, group, seed);
}

/** 六欄 exact descriptor（masterSeed／basePack／identityPack／certificate／eventPack／deathPack）。 */
function genesisInputOf(
  eventPack: ValidatedEventPack,
  death: typeof deathPack,
  seed: string = SEED
): Dict {
  return {
    masterSeed: seed,
    basePack: base,
    identityPack,
    certificate: certificateFor(seed),
    eventPack,
    deathPack: death
  };
}

/** identity 探測 genesis（entityId／sex 只由 certificate 決定；與死亡包內容無關）。 */
const probe = createP3EGenesis(genesisInputOf(packNoCandidates, deathPack));

/** mortality 全歸零、可選把 `deathAge` 設為 1,000,000 ppm 的死亡包（checksum 全重算）。 */
function deathPackRepaired(deathAge?: number): typeof deathPack {
  const manifest = structuredClone(rawDeathManifest);
  const datasets = structuredClone(rawDeathDatasets);
  for (const row of (datasets.mortality as { records: Dict[] }).records) {
    (row as { hazardPpm: number }).hazardPpm = 0;
  }
  if (deathAge !== undefined) {
    const target = (datasets.mortality as { records: Dict[] }).records.find(
      (entry) => entry.entityId === probe.identity.entityId && entry.sex === probe.identity.sex && entry.age === deathAge
    );
    if (target === undefined) throw new Error(`missing mortality row for age ${deathAge}`);
    (target as { hazardPpm: number }).hazardPpm = 1_000_000;
  }
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

const deathPackZeroHazard = deathPackRepaired();
const deathPackOfficial51 = deathPackRepaired(51);
const deathPackDeathAt2 = deathPackRepaired(2);

/* --------------------- genesis 與 genesisInput --------------------- */

const genesisZero = createP3EGenesis(genesisInputOf(packNoCandidates, deathPackZeroHazard));
const genesisDecision = createP3EGenesis(genesisInputOf(packDecision, deathPackZeroHazard));
const genesisOfficial = createP3EGenesis(genesisInputOf(packNoCandidates, deathPackOfficial51));
const genesisDeath2 = createP3EGenesis(genesisInputOf(packNoCandidates, deathPackDeathAt2));
const genesisA = createP3EGenesis(genesisInputOf(packNoCandidates, deathPackZeroHazard, SEED_A));
const genesisB = createP3EGenesis(genesisInputOf(packNoCandidates, deathPackZeroHazard, SEED_B));
/** packPlain 綁定的 genesis（pack binding 反例的 expected/actual 來源）。 */
const genesisPlain = createP3EGenesis(genesisInputOf(packPlain, deathPackZeroHazard));

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;
const CHOOSE_SAVE = { type: "CHOOSE_DECISION", optionId: "save" } as const;

/* ------------------------------ 輔助 ------------------------------- */

/** live 執行一個命令交易（正式 Command Executor V1）。 */
function execute(
  state: contracts.P3ELifeState,
  command: Dict,
  pack: ValidatedEventPack,
  death: typeof deathPack
): ReturnType<typeof executeP3ECommand> {
  return executeP3ECommand({ state, eventPack: pack, deathPack: death, command });
}

interface BuiltHistory {
  readonly ledger: unknown;
  readonly finalState: contracts.P3ELifeState;
  readonly live: readonly ReturnType<typeof executeP3ECommand>[];
}

/** 真實交易鏈：create + 逐命令 execute + append（與 live 完全同一路徑）。 */
function buildHistory(
  genesis: contracts.P3ELifeState,
  pack: ValidatedEventPack,
  death: typeof deathPack,
  commands: readonly Dict[]
): BuiltHistory {
  let ledger: unknown = createP3ELedgerHistory(genesis);
  let state: contracts.P3ELifeState = genesis;
  const live: ReturnType<typeof executeP3ECommand>[] = [];
  for (const command of commands) {
    const result = execute(state, command, pack, death);
    ledger = appendP3ELedgerHistory({
      history: ledger,
      previousState: state,
      commandRecord: result.commandRecord,
      yearRecord: result.yearRecord
    });
    live.push(result);
    state = result.state;
  }
  return { ledger, finalState: state, live };
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

/**
 * 正式 product path 的指令序列（決策政策：pending 時 `CHOOSE_DECISION` 取
 * 第一個 `optionId`，否則 `ADVANCE_YEAR contentMode=standard`），走到
 * `phase === "death"` 為止。
 */
function productPathCommands(
  genesis: contracts.P3ELifeState,
  pack: ValidatedEventPack,
  death: typeof deathPack
): Dict[] {
  const commands: Dict[] = [];
  let state: contracts.P3ELifeState = genesis;
  while (state.phase !== "death") {
    if (commands.length > 200) throw new Error("runaway product path");
    const pending = state.pendingDecision;
    const command: Dict =
      pending !== null
        ? { type: "CHOOSE_DECISION", optionId: pending.optionIds[0] as string }
        : { ...ADVANCE };
    commands.push(command);
    state = execute(state, command, pack, death).state;
  }
  return commands;
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

/** 僅斷言 code（passthrough 錯誤的 path 由正式原語的檔案把關）。 */
function expectP3ECode(run: () => unknown, code: string): P3EError {
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
  return caught as P3EError;
}

/** 斷言 divergence 詳情（五個 readonly 欄位 + 錯誤契約）。 */
function expectDivergence(
  run: () => unknown,
  detail: { index: number; year: number; field: string; expected: string; actual: string; path: string }
): P3EReplayDivergenceError {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof P3EReplayDivergenceError, "P3EReplayDivergenceError").toBe(true);
  const divergence = caught as P3EReplayDivergenceError;
  expect(isP3EError(divergence)).toBe(true);
  expect(divergence.code).toBe("E_P3E_REPLAY");
  expect(divergence.message).toBe(`E_P3E_REPLAY at ${detail.path}`);
  expect(divergence.index).toBe(detail.index);
  expect(divergence.year).toBe(detail.year);
  expect(divergence.field).toBe(detail.field);
  expect(divergence.expected).toBe(detail.expected);
  expect(divergence.actual).toBe(detail.actual);
  return divergence;
}

/** genesis anchor（由 genesis 欄位獨立組出）。 */
function anchorOf(genesis: contracts.P3ELifeState): Dict {
  return {
    stateHash: genesis.stateHash,
    commandHeadHash: genesis.commandLog.headHash,
    chainHash: genesis.heads.hashChain
  };
}

/* --------------------- 合成 Pair（正式 hash 原語） --------------------- */

const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);
const HEX_E = "e".repeat(64);

interface PairOptions {
  readonly index: number;
  readonly year: number;
  readonly age: number;
  readonly phase: contracts.P3EPhase;
  readonly stateHashBefore: string;
  readonly stateHashAfter: string;
  readonly prevCommandHash: string;
  readonly prevChainHash: string;
  readonly rngBefore: contracts.P3ERngState;
  readonly rngAfter: contracts.P3ERngState;
  readonly snapshotHash: string;
  readonly deltaHash: string;
  readonly command: unknown;
}

/**
 * 用正式原語獨立算出 entry／chain hash，組出「內部完全自洽」的一對 Record。
 *
 * 跨紀錄鏈結（index／stateHashBefore／prevCommandHash／prevChainHash）由呼叫端
 * 給定，Pair 內部一致性由正式原語保證——因此它可以通過 `readP3ELedgerHistory`
 * 的完整驗證，但在 replay 比較層與真實執行分歧（hash 自洽的偽造 Pair）。
 */
function syntheticPair(options: PairOptions): { commandRecord: P3ECommandRecord; yearRecord: Dict } {
  const entryHash = computeP3EYearEntryHash({
    index: options.index,
    year: options.year,
    age: options.age,
    phase: options.phase,
    stateHashBefore: options.stateHashBefore,
    rngBefore: options.rngBefore,
    rngAfter: options.rngAfter,
    snapshotHash: options.snapshotHash,
    deltaHash: options.deltaHash
  }) as string;

  const commandRecord = createP3ECommandRecord({
    index: options.index,
    year: options.year,
    command: options.command,
    prevCommandHash: options.prevCommandHash,
    stateHashBefore: options.stateHashBefore,
    stateHashAfter: options.stateHashAfter,
    entryHash: entryHash as contracts.P3EHex64
  });

  const chainHash = computeP3EYearChainHash({
    prevChainHash: options.prevChainHash,
    index: options.index,
    year: options.year,
    entryHash,
    stateHashAfter: options.stateHashAfter,
    commandHash: commandRecord.commandHash
  }) as string;

  const yearRecord: Dict = {
    index: options.index,
    year: options.year,
    age: options.age,
    phase: options.phase,
    stateHashBefore: options.stateHashBefore,
    stateHashAfter: options.stateHashAfter,
    rngBefore: options.rngBefore,
    rngAfter: options.rngAfter,
    snapshotHash: options.snapshotHash,
    deltaHash: options.deltaHash,
    entryHash,
    commandHash: commandRecord.commandHash,
    prevChainHash: options.prevChainHash,
    chainHash
  };
  return { commandRecord, yearRecord };
}

/** 依序鏈結的合成 Pair 陣列（第 1 筆接 anchor，之後逐一接前一筆）。 */
function syntheticPairs(
  genesis: contracts.P3ELifeState,
  count: number
): Dict[] {
  const pairs: Dict[] = [];
  let stateHashBefore = genesis.stateHash;
  let prevCommandHash = genesis.commandLog.headHash;
  let prevChainHash = genesis.heads.hashChain;
  for (let position = 1; position <= count; position += 1) {
    const pair = syntheticPair({
      index: position,
      year: genesis.currentYear + position,
      age: genesis.age + position,
      phase: "life",
      stateHashBefore,
      stateHashAfter: HEX_C,
      prevCommandHash,
      prevChainHash,
      rngBefore: genesis.rng,
      rngAfter: genesis.rng,
      snapshotHash: HEX_D,
      deltaHash: HEX_E,
      command: { ...ADVANCE }
    });
    pairs.push({ commandRecord: pair.commandRecord, yearRecord: pair.yearRecord });
    stateHashBefore = HEX_C;
    prevCommandHash = pair.commandRecord.commandHash;
    prevChainHash = pair.yearRecord.chainHash as string;
  }
  return pairs;
}

/* ================================================================== */
/* 一、正向：empty／one_advance_year／pending_decision／death／51 命令    */
/* ================================================================== */

describe("H5-CTO-180-A Ledger Replay V1：正向", () => {
  it("empty_genesis_history：空 History 重放回 Genesis、commandsConsumed=0", () => {
    const input = { genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard), history: createP3ELedgerHistory(genesisZero) };

    const result = replayP3ELedgerHistory(input);

    expect(result.commandsConsumed).toBe(0);
    expect(Object.keys(result).sort()).toEqual(["commandsConsumed", "history", "lastOutcome", "outcomes", "state"]);
    expect(stable(result.state)).toBe(stable(genesisZero));
    // 重建的 Genesis 是新物件（不信任任何輸入端的 State）。
    expect(result.state).not.toBe(genesisZero);
    expect(result.history.records).toEqual([]);
    expect(result.history.initial.stateHash).toBe(genesisZero.stateHash);
    expect(result.history.initial.commandHeadHash).toBe(genesisZero.commandLog.headHash);
    expect(result.history.initial.chainHash).toBe(genesisZero.heads.hashChain);
  });

  it("one_advance_year：單一 ADVANCE_YEAR 與 live 執行 bit-exact", () => {
    const built = buildHistory(genesisZero, packNoCandidates, deathPackZeroHazard, [{ ...ADVANCE }]);
    const input = { genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard), history: built.ledger };

    const result = replayP3ELedgerHistory(input);

    expect(result.commandsConsumed).toBe(1);
    expect(stable(result.state)).toBe(stable(built.finalState));
    const pair = result.history.records[0] as unknown as Dict;
    expect((pair.commandRecord as P3ECommandRecord).index).toBe(1);
    expect((pair.commandRecord as P3ECommandRecord).command).toEqual({ ...ADVANCE });
    expect((pair.yearRecord as Dict).phase).toBe("life");
  });

  it("pending_decision_then_choice：ADVANCE→CHOOSE→replay 與 live bit-exact", () => {
    const built = buildHistory(genesisDecision, packDecision, deathPackZeroHazard, [{ ...ADVANCE }, { ...CHOOSE_SAVE }]);
    const input = { genesisInput: genesisInputOf(packDecision, deathPackZeroHazard), history: built.ledger };

    const result = replayP3ELedgerHistory(input);

    expect(result.commandsConsumed).toBe(2);
    expect(stable(result.state)).toBe(stable(built.finalState));
    const records = result.history.records as unknown as readonly Dict[];
    expect((records[0] as Dict).commandRecord).toBeDefined();
    const types = records.map((pair) => (pair.commandRecord as P3ECommandRecord).command.type);
    expect(types).toEqual(["ADVANCE_YEAR", "CHOOSE_DECISION"]);
    expect(((records[0] as Dict).yearRecord as Dict).phase).toBe("pending_decision");
    expect(((records[1] as Dict).yearRecord as Dict).phase).toBe("life");
  });

  it("death_final_state：age 2 死亡的最終 State 與 live bit-exact", () => {
    const built = buildHistory(genesisDeath2, packNoCandidates, deathPackDeathAt2, [{ ...ADVANCE }, { ...ADVANCE }]);
    const input = { genesisInput: genesisInputOf(packNoCandidates, deathPackDeathAt2), history: built.ledger };

    const result = replayP3ELedgerHistory(input);

    expect(result.commandsConsumed).toBe(2);
    expect(result.state.phase).toBe("death");
    expect(result.state.age).toBe(2);
    expect(stable(result.state)).toBe(stable(built.finalState));
  });

  it("custom_age51_no_choice_birth_to_death_live_vs_replay_bit_exact", () => {
    // custom repaired 路徑（合成反例與邊界測試用；**不是**正式 product path）。
    const commands: Dict[] = [];
    for (let step = 0; step < 51; step += 1) commands.push({ ...ADVANCE });
    const built = buildHistory(genesisOfficial, packNoCandidates, deathPackOfficial51, commands);
    expect(built.finalState.phase).toBe("death");
    expect(built.finalState.age).toBe(51);
    const input = { genesisInput: genesisInputOf(packNoCandidates, deathPackOfficial51), history: built.ledger };

    const result = replayP3ELedgerHistory(input);

    expect(result.commandsConsumed).toBe(51);
    expect(result.state.phase).toBe("death");
    expect(result.state.age).toBe(51);
    // bit-exact：最終 State、全部 51 對 Record 都與 live 完全一致。
    expect(stable(result.state)).toBe(stable(built.finalState));
    const records = result.history.records as unknown as readonly Dict[];
    expect(records.length).toBe(51);
    for (let index = 0; index < 51; index += 1) {
      const pair = records[index] as Dict;
      expect(stable(pair.commandRecord)).toBe(stable((built.live[index] as unknown as Dict).commandRecord));
      expect(stable(pair.yearRecord)).toBe(stable((built.live[index] as unknown as Dict).yearRecord));
    }
    // 尾端鏈結：最終 State 的 stateHash 等於最後一筆 yearRecord.stateHashAfter。
    expect(result.state.stateHash).toBe(((records[records.length - 1] as Dict).yearRecord as Dict).stateHashAfter);
  });

  it("official_product_path_birth_to_death_live_vs_replay_bit_exact", () => {
    // 正式 product path（H5-CTO-180-A-R1）：seed 與 untouched 官方 packs
    // （p2a+p2b+p3b+p3d raw fixture 直接以公開原語驗證——本測試不含任何
    // repaired event／death pack），政策：pending 時 CHOOSE_DECISION 第一個
    // optionId，否則 ADVANCE_YEAR contentMode=standard。
    const genesisInput = genesisInputOf(eventPackOfficial, deathPack, SEED_OFFICIAL);
    const genesisProduct = createP3EGenesis(genesisInput);
    const commands = productPathCommands(genesisProduct, eventPackOfficial, deathPack);
    expect(commands.length).toBe(106);
    expect(commands.filter((command) => command.type === "CHOOSE_DECISION").length).toBe(39);

    // live history：formal executor + formal history 逐命令 append。
    const built = buildHistory(genesisProduct, eventPackOfficial, deathPack, commands);
    const input = { genesisInput, history: built.ledger };

    const result = replayP3ELedgerHistory(input);

    // 期望值（GPT-0043-A）：106 命令、39 個決策、age 67 死亡（year 2091）＋四個 hash。
    expect(built.finalState.phase).toBe("death");
    expect(built.finalState.age).toBe(67);
    expect(built.finalState.currentYear).toBe(2091);
    expect(built.finalState.stateHash).toBe(
      "606ecda92505fab5ea8bf771a20f8638a7702282b08dd3f1d16cbb021404b8ca"
    );
    expect(built.finalState.commandLog.headHash).toBe(
      "4307185bc61cc8144f8e3b31981318475032e6e7cd58e88b46233e21ae29a26a"
    );
    expect(built.finalState.heads.hashChain).toBe(
      "42c60438615287f8fffbea8585070d7ee07d33aedf9967773d9b26919046eb78"
    );
    const records = result.history.records as unknown as readonly Dict[];
    const lastPair = records[records.length - 1] as Dict;
    expect((lastPair.commandRecord as P3ECommandRecord).entryHash).toBe(
      "901d0e35a49683014e6772eebe9e775964592560662ae92f92a7661f762e82ce"
    );
    expect((lastPair.yearRecord as Dict).entryHash).toBe(
      "901d0e35a49683014e6772eebe9e775964592560662ae92f92a7661f762e82ce"
    );

    // replay bit-exact：最終 State、全部 78 對 Record 都與 live 完全一致。
    expect(result.commandsConsumed).toBe(106);
    expect(result.state.phase).toBe("death");
    expect(result.state.age).toBe(67);
    expect(stable(result.state)).toBe(stable(built.finalState));
    expect(records.length).toBe(106);
    for (let index = 0; index < 106; index += 1) {
      const pair = records[index] as Dict;
      expect(stable(pair.commandRecord)).toBe(stable((built.live[index] as unknown as Dict).commandRecord));
      expect(stable(pair.yearRecord)).toBe(stable((built.live[index] as unknown as Dict).yearRecord));
    }
    // 全路徑恰好一個 pending choice（其餘 50 個命令都是 ADVANCE_YEAR）。
    const types = records.map((pair) => (pair.commandRecord as P3ECommandRecord).command.type);
    expect(types.filter((type) => type === "CHOOSE_DECISION").length).toBe(39);
    expect(types.filter((type) => type === "ADVANCE_YEAR").length).toBe(67);
    expect(result.state.stateHash).toBe(((records[records.length - 1] as Dict).yearRecord as Dict).stateHashAfter);
  });

  it("決定性：相同輸入重放兩次輸出完全一致", () => {
    const built = buildHistory(genesisZero, packNoCandidates, deathPackZeroHazard, [{ ...ADVANCE }, { ...ADVANCE }]);
    const input = { genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard), history: built.ledger };

    const first = replayP3ELedgerHistory(input);
    const second = replayP3ELedgerHistory(input);

    expect(stable(first)).toBe(stable(second));
    expect(first).not.toBe(second);
  });

  it("null-prototype 的合法 input 也可重放（proto === null 分支）", () => {
    const built = buildHistory(genesisZero, packNoCandidates, deathPackZeroHazard, [{ ...ADVANCE }]);
    const genesisInput = genesisInputOf(packNoCandidates, deathPackZeroHazard);
    const nullProtoInput: Dict = Object.create(null);
    nullProtoInput.genesisInput = genesisInput;
    nullProtoInput.history = built.ledger;

    const result = replayP3ELedgerHistory(nullProtoInput);

    expect(result.commandsConsumed).toBe(1);
    expect(stable(result.state)).toBe(stable(built.finalState));
  });
});

/* ================================================================== */
/* 二、divergence：anchor／全欄位比較／第一個分歧                         */
/* ================================================================== */

describe("H5-CTO-180-A Ledger Replay V1：divergence", () => {
  it("anchor_state_command_chain_mismatch：三欄逐一 divergence（index=0、year=genesis.currentYear）", () => {
    const cases: { anchor: Dict; field: string; expected: string; actual: string }[] = [
      {
        anchor: { ...anchorOf(genesisB), stateHash: genesisA.stateHash },
        field: "stateHash",
        expected: genesisA.stateHash,
        actual: genesisB.stateHash
      },
      {
        anchor: { ...anchorOf(genesisB), commandHeadHash: HEX_B },
        field: "commandHeadHash",
        expected: HEX_B,
        actual: genesisB.commandLog.headHash
      },
      {
        anchor: { ...anchorOf(genesisB), chainHash: HEX_C },
        field: "chainHash",
        expected: HEX_C,
        actual: genesisB.heads.hashChain
      }
    ];
    for (const item of cases) {
      const pair = syntheticPair({
        index: 1,
        year: genesisB.currentYear + 1,
        age: genesisB.age + 1,
        phase: "life",
        stateHashBefore: item.anchor.stateHash as string,
        stateHashAfter: HEX_C,
        prevCommandHash: item.anchor.commandHeadHash as string,
        prevChainHash: item.anchor.chainHash as string,
        rngBefore: genesisB.rng,
        rngAfter: genesisB.rng,
        snapshotHash: HEX_D,
        deltaHash: HEX_E,
        command: { ...ADVANCE }
      });
      const input = {
        genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard, SEED_B),
        history: { initial: item.anchor, records: [{ commandRecord: pair.commandRecord, yearRecord: pair.yearRecord }] }
      };
      expectDivergence(() => replayP3ELedgerHistory(input), {
        index: 0,
        year: genesisB.currentYear,
        field: item.field,
        expected: JSON.stringify(item.expected),
        actual: JSON.stringify(item.actual),
        path: `p3eReplay.initial.${item.field}`
      });
    }
  });

  it("wrong_seed_or_pack_binding_rejected：不同 seed／不同 eventPack 綁定在 anchor 被拒", () => {
    // 不同 masterSeed：真實 History（seed A）配 seed B 的 genesisInput。
    const builtA = buildHistory(genesisA, packNoCandidates, deathPackZeroHazard, [{ ...ADVANCE }]);
    const inputSeed = {
      genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard, SEED_B),
      history: builtA.ledger
    };
    expectDivergence(() => replayP3ELedgerHistory(inputSeed), {
      index: 0,
      year: genesisB.currentYear,
      field: "stateHash",
      expected: JSON.stringify(genesisA.stateHash),
      actual: JSON.stringify(genesisB.stateHash),
      path: "p3eReplay.initial.stateHash"
    });

    // 不同 eventPack 綁定：History 由 packNoCandidates 的 genesis 建立，
    // genesisInput 卻綁 packPlain → anchor stateHash 必然不同。
    const builtPack = buildHistory(genesisZero, packNoCandidates, deathPackZeroHazard, [{ ...ADVANCE }]);
    const inputPack = {
      genesisInput: genesisInputOf(packPlain, deathPackZeroHazard),
      history: builtPack.ledger
    };
    const divergence = expectDivergence(() => replayP3ELedgerHistory(inputPack), {
      index: 0,
      year: genesisPlain.currentYear,
      field: "stateHash",
      expected: JSON.stringify(genesisZero.stateHash),
      actual: JSON.stringify(genesisPlain.stateHash),
      path: "p3eReplay.initial.stateHash"
    });
    expect(divergence.index).toBe(0);
  });

  it("first_divergence_index_year_field_expected_actual：第一個分歧欄位與實際值", () => {
    // 偽造 Pair：鏈結對齊 genesis、command 相同、stateHashAfter 換成 HEX_C。
    // replay 必定先重算出真實的 stateHashAfter → 第一個分歧欄位就是它。
    const pair = syntheticPair({
      index: 1,
      year: genesisZero.currentYear + 1,
      age: genesisZero.age + 1,
      phase: "life",
      stateHashBefore: genesisZero.stateHash,
      stateHashAfter: HEX_C,
      prevCommandHash: genesisZero.commandLog.headHash,
      prevChainHash: genesisZero.heads.hashChain,
      rngBefore: genesisZero.rng,
      rngAfter: genesisZero.rng,
      snapshotHash: HEX_D,
      deltaHash: HEX_E,
      command: { ...ADVANCE }
    });
    const live = execute(genesisZero, { ...ADVANCE }, packNoCandidates, deathPackZeroHazard);
    const input = {
      genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard),
      history: { initial: anchorOf(genesisZero), records: [{ commandRecord: pair.commandRecord, yearRecord: pair.yearRecord }] }
    };

    const divergence = expectDivergence(() => replayP3ELedgerHistory(input), {
      index: 1,
      year: genesisZero.currentYear + 1,
      field: "stateHashAfter",
      expected: JSON.stringify(HEX_C),
      actual: JSON.stringify(live.commandRecord.stateHashAfter),
      path: "p3eReplay.records[1].stateHashAfter"
    });
    expect(divergence.index).toBe(1);
  });

  it("停在第一個分歧：兩筆偽造 Pair 只回報 index 1", () => {
    const pairs = syntheticPairs(genesisZero, 2);
    const input = {
      genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard),
      history: { initial: anchorOf(genesisZero), records: pairs }
    };
    // live 實際值：replay 必定重算出真實的 stateHashAfter（不是 "unused"）。
    const live = execute(genesisZero, { ...ADVANCE }, packNoCandidates, deathPackZeroHazard);

    const divergence = expectDivergence(() => replayP3ELedgerHistory(input), {
      index: 1,
      year: genesisZero.currentYear + 1,
      field: "stateHashAfter",
      expected: JSON.stringify(HEX_C),
      actual: JSON.stringify(live.commandRecord.stateHashAfter),
      path: "p3eReplay.records[1].stateHashAfter"
    });
    expect(divergence.index).toBe(1);
  });

  it("all_record_fields_compared：正向全欄位相等 + 偽造 commandRecord／yearRecord 均被逐欄位逮到", () => {
    // (a) 正向：三命令鏈（ADVANCE→CHOOSE→ADVANCE）的每一對 Record 逐欄位相等。
    const commands: Dict[] = [{ ...ADVANCE }, { ...CHOOSE_SAVE }, { ...ADVANCE }];
    const built = buildHistory(genesisDecision, packDecision, deathPackZeroHazard, commands);
    const input = { genesisInput: genesisInputOf(packDecision, deathPackZeroHazard), history: built.ledger };
    const result = replayP3ELedgerHistory(input);
    const records = result.history.records as unknown as readonly Dict[];
    for (let index = 0; index < commands.length; index += 1) {
      const pair = records[index] as Dict;
      const live = built.live[index] as unknown as Dict;
      for (const field of Object.keys(pair.commandRecord as Dict)) {
        expect((pair.commandRecord as Dict)[field]).toEqual((live.commandRecord as Dict)[field]);
      }
      for (const field of Object.keys(pair.yearRecord as Dict)) {
        expect((pair.yearRecord as Dict)[field]).toEqual((live.yearRecord as Dict)[field]);
      }
    }

    // (b) 偽造 commandRecord（stateHashAfter 換掉）→ divergence 在 commandRecord.stateHashAfter。
    const forgedCommand = syntheticPair({
      index: 1,
      year: genesisZero.currentYear + 1,
      age: genesisZero.age + 1,
      phase: "life",
      stateHashBefore: genesisZero.stateHash,
      stateHashAfter: HEX_C,
      prevCommandHash: genesisZero.commandLog.headHash,
      prevChainHash: genesisZero.heads.hashChain,
      rngBefore: genesisZero.rng,
      rngAfter: genesisZero.rng,
      snapshotHash: HEX_D,
      deltaHash: HEX_E,
      command: { ...ADVANCE }
    });
    const inputForgedCommand = {
      genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard),
      history: {
        initial: anchorOf(genesisZero),
        records: [{ commandRecord: forgedCommand.commandRecord, yearRecord: forgedCommand.yearRecord }]
      }
    };
    expectDivergence(() => replayP3ELedgerHistory(inputForgedCommand), {
      index: 1,
      year: genesisZero.currentYear + 1,
      field: "stateHashAfter",
      expected: JSON.stringify(HEX_C),
      actual: JSON.stringify(
        execute(genesisZero, { ...ADVANCE }, packNoCandidates, deathPackZeroHazard).commandRecord.stateHashAfter
      ),
      path: "p3eReplay.records[1].stateHashAfter"
    });

    // (c) 偽造 yearRecord 語意欄位：snapshotHash 換成 HEX_D、其餘語意欄位全部取
    //     live 實際值，並用正式原語重算 entryHash／commandHash／chainHash
    //     （Pair 內部完全自洽 → 通過 read 的完整驗證）。
    //     commandRecord 的語意欄位與 live 逐欄相同，因此第一個分歧精確落在
    //     yearRecord.snapshotHash——證明 yearRecord 語意欄位是獨立的第二道防線：
    //     即使 commandRecord 語意欄位全對，yearRecord 被換掉仍會被逐欄位比較逮到。
    const liveReal = execute(genesisZero, { ...ADVANCE }, packNoCandidates, deathPackZeroHazard);
    const forgedYear = syntheticPair({
      index: 1,
      year: genesisZero.currentYear + 1,
      age: liveReal.yearRecord.age,
      phase: liveReal.yearRecord.phase,
      stateHashBefore: liveReal.yearRecord.stateHashBefore,
      stateHashAfter: liveReal.commandRecord.stateHashAfter,
      prevCommandHash: liveReal.commandRecord.prevCommandHash,
      prevChainHash: liveReal.yearRecord.prevChainHash,
      rngBefore: liveReal.yearRecord.rngBefore,
      rngAfter: liveReal.yearRecord.rngAfter,
      snapshotHash: HEX_D,
      deltaHash: liveReal.yearRecord.deltaHash,
      command: { ...ADVANCE }
    });
    const inputForgedYear = {
      genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard),
      history: {
        initial: anchorOf(genesisZero),
        records: [{ commandRecord: forgedYear.commandRecord, yearRecord: forgedYear.yearRecord }]
      }
    };
    expectDivergence(() => replayP3ELedgerHistory(inputForgedYear), {
      index: 1,
      year: genesisZero.currentYear + 1,
      field: "snapshotHash",
      expected: JSON.stringify(HEX_D),
      actual: JSON.stringify(liveReal.yearRecord.snapshotHash),
      path: "p3eReplay.records[1].snapshotHash"
    });
  });
});

/* ================================================================== */
/* 三、信任邊界：malformed／passthrough／不可變／凍結／不信任 final state  */
/* ================================================================== */

describe("H5-CTO-180-A Ledger Replay V1：信任邊界", () => {
  const validInput = (): Dict => ({
    genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard),
    history: createP3ELedgerHistory(genesisZero)
  });

  it("malformed_top_level_and_getters_never_execute：頂層 shape 反例（getter 呼叫 0 次）", () => {
    expectP3EError(() => replayP3ELedgerHistory(null), "E_P3E_REPLAY", "p3eReplay.input");
    expectP3EError(() => replayP3ELedgerHistory(undefined), "E_P3E_REPLAY", "p3eReplay.input");
    expectP3EError(() => replayP3ELedgerHistory(42), "E_P3E_REPLAY", "p3eReplay.input");
    expectP3EError(() => replayP3ELedgerHistory([]), "E_P3E_REPLAY", "p3eReplay.input");
    expectP3EError(() => replayP3ELedgerHistory(new (class { public genesisInput = 1; })()), "E_P3E_REPLAY", "p3eReplay.input");
    expectP3EError(() => replayP3ELedgerHistory({ ...validInput(), extra: 1 }), "E_P3E_REPLAY", "p3eReplay.input");
    expectP3EError(() => replayP3ELedgerHistory({ genesisInput: 1 }), "E_P3E_REPLAY", "p3eReplay.input");
    expectP3EError(() => replayP3ELedgerHistory({ history: 1 }), "E_P3E_REPLAY", "p3eReplay.input");
    // 同數量但鍵名不符。
    expectP3EError(() => replayP3ELedgerHistory({ foo: 1, bar: 2 }), "E_P3E_REPLAY", "p3eReplay.input");

    // 隱藏（不可列舉）額外欄位。
    const hidden = { ...validInput() };
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false, writable: true, configurable: true });
    expectP3EError(() => replayP3ELedgerHistory(hidden), "E_P3E_REPLAY", "p3eReplay.input");

    // 不可列舉的必要欄位（top-level）→ 拒絕。
    const hiddenRequired = { ...validInput() };
    Object.defineProperty(hiddenRequired, "history", {
      value: createP3ELedgerHistory(genesisZero),
      enumerable: false,
      writable: true,
      configurable: true
    });
    expectP3EError(() => replayP3ELedgerHistory(hiddenRequired), "E_P3E_REPLAY", "p3eReplay.input");
    const hiddenRequiredAll = { ...validInput() };
    Object.defineProperty(hiddenRequiredAll, "genesisInput", {
      value: hiddenRequiredAll.genesisInput,
      enumerable: false,
      writable: true,
      configurable: true
    });
    expectP3EError(() => replayP3ELedgerHistory(hiddenRequiredAll), "E_P3E_REPLAY", "p3eReplay.input");

    // symbol 鍵。
    const withSymbol = { ...validInput() };
    Object.defineProperty(withSymbol, Symbol("x"), { value: 1, enumerable: true, writable: true, configurable: true });
    expectP3EError(() => replayP3ELedgerHistory(withSymbol), "E_P3E_REPLAY", "p3eReplay.input");

    // accessor：getter **不會**被執行。
    let getterCalls = 0;
    const withAccessor = { ...validInput() };
    Object.defineProperty(withAccessor, "genesisInput", {
      get() { getterCalls += 1; return genesisInputOf(packNoCandidates, deathPackZeroHazard); },
      enumerable: true,
      configurable: true
    });
    expectP3EError(() => replayP3ELedgerHistory(withAccessor), "E_P3E_REPLAY", "p3eReplay.input");
    expect(getterCalls).toBe(0);

    // revoked Proxy：反射失敗折成 E_P3E_REPLAY。
    const revoked = Proxy.revocable(validInput(), {});
    revoked.revoke();
    expectP3EError(() => replayP3ELedgerHistory(revoked.proxy), "E_P3E_REPLAY", "p3eReplay.input");
  });

  it("malformed genesisInput：六欄 descriptor 反例（getter 呼叫 0 次、revoked Proxy）", () => {
    expectP3EError(
      () => replayP3ELedgerHistory({ genesisInput: null, history: createP3ELedgerHistory(genesisZero) }),
      "E_P3E_REPLAY",
      "p3eReplay.input.genesisInput"
    );
    expectP3EError(
      () => replayP3ELedgerHistory({ genesisInput: [], history: createP3ELedgerHistory(genesisZero) }),
      "E_P3E_REPLAY",
      "p3eReplay.input.genesisInput"
    );
    const full = genesisInputOf(packNoCandidates, deathPackZeroHazard);
    expectP3EError(
      () => replayP3ELedgerHistory({ genesisInput: { ...full, extra: 1 }, history: createP3ELedgerHistory(genesisZero) }),
      "E_P3E_REPLAY",
      "p3eReplay.input.genesisInput"
    );
    expectP3EError(
      () => replayP3ELedgerHistory({ genesisInput: { masterSeed: SEED }, history: createP3ELedgerHistory(genesisZero) }),
      "E_P3E_REPLAY",
      "p3eReplay.input.genesisInput"
    );
    // 同數量但鍵名不符（六個錯誤鍵）。
    const renamed: Dict = {};
    for (const key of Object.keys(full)) renamed[`x-${key}`] = (full as Dict)[key];
    expectP3EError(
      () => replayP3ELedgerHistory({ genesisInput: renamed, history: createP3ELedgerHistory(genesisZero) }),
      "E_P3E_REPLAY",
      "p3eReplay.input.genesisInput"
    );

    // 不可列舉的必要欄位（genesisInput）→ 拒絕。
    const hiddenGenesisRequired = { ...full };
    Object.defineProperty(hiddenGenesisRequired, "eventPack", {
      value: packNoCandidates,
      enumerable: false,
      writable: true,
      configurable: true
    });
    expectP3EError(
      () => replayP3ELedgerHistory({ genesisInput: hiddenGenesisRequired, history: createP3ELedgerHistory(genesisZero) }),
      "E_P3E_REPLAY",
      "p3eReplay.input.genesisInput"
    );
    // 不可列舉的額外欄位（genesisInput）→ 拒絕。
    const hiddenGenesisExtra = { ...full };
    Object.defineProperty(hiddenGenesisExtra, "extra", {
      value: 1,
      enumerable: false,
      writable: true,
      configurable: true
    });
    expectP3EError(
      () => replayP3ELedgerHistory({ genesisInput: hiddenGenesisExtra, history: createP3ELedgerHistory(genesisZero) }),
      "E_P3E_REPLAY",
      "p3eReplay.input.genesisInput"
    );

    let getterCalls = 0;
    const withAccessor = { ...full };
    Object.defineProperty(withAccessor, "eventPack", {
      get() { getterCalls += 1; return packNoCandidates; },
      enumerable: true,
      configurable: true
    });
    expectP3EError(
      () => replayP3ELedgerHistory({ genesisInput: withAccessor, history: createP3ELedgerHistory(genesisZero) }),
      "E_P3E_REPLAY",
      "p3eReplay.input.genesisInput"
    );
    expect(getterCalls).toBe(0);

    const revoked = Proxy.revocable(full, {});
    revoked.revoke();
    expectP3EError(
      () => replayP3ELedgerHistory({ genesisInput: revoked.proxy, history: createP3ELedgerHistory(genesisZero) }),
      "E_P3E_REPLAY",
      "p3eReplay.input.genesisInput"
    );
  });

  it("malformed_history_error_passthrough：history／genesis 驗證錯誤原樣外拋", () => {
    // history：shape 反例（read 的錯誤原樣 passthrough）。
    expectP3EError(
      () => replayP3ELedgerHistory({ genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard), history: { broken: 1 } }),
      "E_P3E_HISTORY",
      "ledgerHistory.input"
    );
    expectP3EError(
      () => replayP3ELedgerHistory({
        genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard),
        history: { initial: { ...anchorOf(genesisZero), stateHash: "not-hex" }, records: [] }
      }),
      "E_P3E_HISTORY",
      "ledgerHistory.initial.stateHash"
    );
    // executor passthrough： genesis（無 pending decision）上執行 CHOOSE_DECISION
    // → executor 的驗證錯誤原樣外拋（本模組不包裝）。
    const choosePair = syntheticPair({
      index: 1,
      year: genesisZero.currentYear + 1,
      age: genesisZero.age + 1,
      phase: "life",
      stateHashBefore: genesisZero.stateHash,
      stateHashAfter: HEX_C,
      prevCommandHash: genesisZero.commandLog.headHash,
      prevChainHash: genesisZero.heads.hashChain,
      rngBefore: genesisZero.rng,
      rngAfter: genesisZero.rng,
      snapshotHash: HEX_D,
      deltaHash: HEX_E,
      command: { ...CHOOSE_SAVE }
    });
    const inputChoose = {
      genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard),
      history: {
        initial: anchorOf(genesisZero),
        records: [{ commandRecord: choosePair.commandRecord, yearRecord: choosePair.yearRecord }]
      }
    };
    const passthrough = expectP3ECode(() => replayP3ELedgerHistory(inputChoose), "E_P3E_PHASE");
    expect(passthrough.path).toContain("phase");

    // genesisInput：業務驗證錯誤原樣 passthrough。masterSeed 非字串會在
    // createP3EGenesis 的證書重播層被攔（E_P3E_CERTIFICATE at certificate）；
    // 本模組對 genesis／history／executor 的錯誤不做任何包裝。
    expectP3ECode(
      () => replayP3ELedgerHistory({
        genesisInput: { ...genesisInputOf(packNoCandidates, deathPackZeroHazard), masterSeed: 42 },
        history: createP3ELedgerHistory(genesisZero)
      }),
      "E_P3E_CERTIFICATE"
    );
    expectP3ECode(
      () => replayP3ELedgerHistory({
        genesisInput: { ...genesisInputOf({ manifest: "not-a-pack" } as unknown as ValidatedEventPack, deathPackZeroHazard) },
        history: createP3ELedgerHistory(genesisZero)
      }),
      "E_P3E_EVENT_PACK"
    );
  });

  it("input_and_history_unmodified：成功與失敗的重放都不修改輸入", () => {
    const genesisInput = genesisInputOf(packNoCandidates, deathPackZeroHazard);
    const built = buildHistory(genesisZero, packNoCandidates, deathPackZeroHazard, [{ ...ADVANCE }]);
    const rawHistory = built.ledger;
    const input = { genesisInput, history: rawHistory };
    const inputBefore = stable(input);

    replayP3ELedgerHistory(input);

    expect(stable(input)).toBe(inputBefore);

    // 失敗的重放（anchor divergence）同樣不修改輸入。
    const badInput = {
      genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard, SEED_B),
      history: built.ledger
    };
    const badBefore = stable(badInput);
    expect(() => replayP3ELedgerHistory(badInput)).toThrow();
    expect(stable(badInput)).toBe(badBefore);
  });

  it("result_deep_frozen：輸出三項全部深層凍結、history 與輸入零共享", () => {
    const commands: Dict[] = [];
    for (let step = 0; step < 51; step += 1) commands.push({ ...ADVANCE });
    const built = buildHistory(genesisOfficial, packNoCandidates, deathPackOfficial51, commands);
    const rawHistory = built.ledger;
    const input = { genesisInput: genesisInputOf(packNoCandidates, deathPackOfficial51), history: rawHistory };

    const result: P3EReplayResult = replayP3ELedgerHistory(input);

    expect(isDeepFrozen(result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    // read 的快照與輸入零共享。
    expect(sharesReference(result.history, rawHistory)).toBe(false);
    expect(stable(result.history)).toBe(stable(rawHistory));
  });

  it("no_final_state_trust：最終 State 只能來自重執行", () => {
    // (a) 空 History：最終 State 是重建的 Genesis（不是輸入的任何物件）。
    const emptyInput = { genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard), history: createP3ELedgerHistory(genesisZero) };
    const emptyResult = replayP3ELedgerHistory(emptyInput);
    expect(emptyResult.state).not.toBe(genesisZero);
    expect(stable(emptyResult.state)).toBe(stable(genesisZero));

    // (b) 偽造尾端 stateHashAfter 的自洽 Pair：replay 不信任 Record 宣稱的
    //     final state，重算出真實的 stateHashAfter 並回報 divergence。
    const forged = syntheticPair({
      index: 1,
      year: genesisZero.currentYear + 1,
      age: genesisZero.age + 1,
      phase: "life",
      stateHashBefore: genesisZero.stateHash,
      stateHashAfter: HEX_C,
      prevCommandHash: genesisZero.commandLog.headHash,
      prevChainHash: genesisZero.heads.hashChain,
      rngBefore: genesisZero.rng,
      rngAfter: genesisZero.rng,
      snapshotHash: HEX_D,
      deltaHash: HEX_E,
      command: { ...ADVANCE }
    });
    const forgedInput = {
      genesisInput: genesisInputOf(packNoCandidates, deathPackZeroHazard),
      history: { initial: anchorOf(genesisZero), records: [{ commandRecord: forged.commandRecord, yearRecord: forged.yearRecord }] }
    };
    expect(() => replayP3ELedgerHistory(forgedInput)).toThrow(P3EReplayDivergenceError);
  });
});

/* ================================================================== */
/* 四、共同契約                                                        */
/* ================================================================== */

describe("H5-CTO-180-A Ledger Replay V1：共同契約", () => {
  it("public_barrel：replay 自 2t 起公開、read 保持私有", () => {
    expect(Object.keys(barrel)).toContain("replayP3ELedgerHistory");
    expect(Object.keys(barrel)).toContain("P3EReplayDivergenceError");
    expect(Object.keys(barrel)).not.toContain("readP3ELedgerHistory");
    expect(BARREL_SRC).toContain("./p3e-replay");
  });

  it("architecture_forbidden_tokens：必須重用三個正式入口、不得自建業務／hash／codec／環境", () => {
    for (const token of ["createP3EGenesis", "readP3ELedgerHistory", "executeP3ECommand"]) {
      expect(REPLAY_CODE, `模組必須重用 ${token}`).toContain(token);
    }
    const forbidden = [
      // 業務邏輯（不得重複）。
      "resolveP3EAnnualPendingDecision",
      "resolveP3EDecisionChoice",
      "assembleP3EAnnualStateCoreDraft",
      "assembleP3EDecisionStateCoreDraft",
      "appendP3ELedgerTransition",
      "drawP3ERollDeltas",
      "applyEventEffects",
      "createP3ECommandRecord",
      "createP3EYearLedgerRecord",
      "readP3ECommandRecord",
      "verifyP3EYearLedgerRecord",
      "validateP3ELedgerContinuity",
      // hash 重算（不得重複）。
      "computeP3EStateHash",
      "computeP3ESnapshotHash",
      "computeP3EDeltaHash",
      "computeP3EYearEntryHash",
      "computeP3EYearChainHash",
      "computeP3ECommandHash",
      "computeP3ECommandArgsHash",
      "sha256Hex",
      "canonicalBytes",
      // RNG（不得重複）。
      "Xoshiro",
      "nextU32",
      "uniformInt",
      "uniformBigInt",
      // codec／save 基礎設施。
      "codec",
      "Codec",
      "encodeP3E",
      "decodeP3E",
      "saveFormat",
      "SaveFormat",
      // 資料模型污染物。
      "timestamp",
      "nonce",
      "metadata",
      // 執行環境。
      "Date.now",
      "performance.now",
      "Math.random",
      "setTimeout",
      "setInterval",
      "localStorage",
      "XMLHttpRequest",
      "structuredClone",
      "eval"
    ];
    for (const token of forbidden) {
      expect(REPLAY_CODE, `模組不得出現 ${token}`).not.toContain(token);
    }
  });

  it("入口簽章固定；唯一公開函式＋divergence 錯誤類別", () => {
    expect(REPLAY_SRC).toContain("export function replayP3ELedgerHistory(input: unknown): P3EReplayResult");
    expect(REPLAY_SRC).toContain("export class P3EReplayDivergenceError extends P3EError");
    const exported = [...REPLAY_SRC.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map(
      (match) => match[1]
    );
    expect(exported).toEqual(["replayP3ELedgerHistory"]);
    // E_P3E_REPLAY 是合法錯誤碼。
    expect(String(contracts.P3E_ERROR_CODES)).toContain("E_P3E_REPLAY");
  });

  it("輸出語意固定：deep frozen {state, history, commandsConsumed}；divergence 錯誤五欄 readonly", () => {
    expect(REPLAY_SRC).toContain('readonly "history": P3ELedgerHistory;');
    expect(REPLAY_SRC).toContain("readonly commandsConsumed: number;");
    for (const field of ["index", "year", "field", "expected", "actual"]) {
      expect(REPLAY_SRC).toContain(`readonly ${field}:`);
    }
  });
});

/* ================================================================== */
/* 五、H5-CTO-180-A：正式整合專屬測試                                   */
/* ================================================================== */

describe("H5-CTO-180-A 正式整合", () => {
  it("formal_imports_only：正式模組只 import 正式 ledger-history／command-executor", () => {
    expect(REPLAY_SRC).toContain('from "./ledger-history"');
    expect(REPLAY_SRC).toContain('from "./command-executor"');
    expect(REPLAY_SRC).not.toMatch(/from\s+"[^"]*v1-candidate"/);
  });

  it("candidate_imports_absent：正式檔案不再以 import 引用來源候選模組", () => {
    const testSource = readFileSync(
      join(ROOT, "packages/simulation/test/p3e-replay.test.ts"),
      "utf8"
    );
    for (const source of [REPLAY_SRC, testSource]) {
      expect(source).not.toMatch(/from\s+"[^"]*v1-candidate"/);
    }
  });
});
