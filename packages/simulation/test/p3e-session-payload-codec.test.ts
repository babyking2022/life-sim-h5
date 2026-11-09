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
import { computeP3EStateHash } from "../src/state-hash";
import { executeP3ECommand } from "../src/command-executor";
import {
  appendP3ELedgerHistory,
  createP3ELedgerHistory
} from "../src/ledger-history";
import { encodeP3EState } from "../src/codec";
import { encodeP3ELedgerRecordPair } from "../src/ledger-record-codec";
import {
  P3E_SESSION_PAYLOAD_FORMAT_VERSION,
  P3E_SESSION_PAYLOAD_MAX_LENGTH,
  decodeP3ESessionPayload,
  encodeP3ESessionPayload
} from "../src/p3e-session-payload-codec";
import * as codecModule from "../src/p3e-session-payload-codec";
import * as barrel from "../src/index";
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * H5-CTO-182-A：P3-E Session Payload Codec V1 正式測試。
 *
 * 來源：WorkBuddy 候選 `p3e-session-payload-codec-v1-candidate.test.ts`（H5-CTO-182-A）
 * （SHA-256 `819459f7a347a9883376217ffcf3d1cb080dbc02a918ba599991cf04d4c1bc91`，
 * 經 H5-CTO-182-A 正式整合；16 項來源測試依原順序保留）。
 *
 * 期望值一律用**正式原語**獨立重算，不用被測函式自己的輸出當答案。
 * 本檔**不**重建任何業務／hash／record／codec 投影演算法——wire 的正確性
 * 由「decode 後 stable 相等 + re-encode byte-identical」與官方固定期望值把關。
 *
 * fixtures 參照正式 p3e-replay.test.ts 的同一組 fixtures（測試檔之間不可 import，
 * 否則 describe 會重複註冊）：
 *
 * - **真實交易鏈**：`createP3ELedgerHistory` + 逐命令 `executeP3ECommand` +
 *   `appendP3ELedgerHistory`（與 live 完全同一路徑）；
 * - **正式 product path**（H5-CTO-175-B-R1 固定）：seed `p3e-166-playable-runtime-v4`、
 *   untouched 官方 packs（p2a+p2b+p3b+p3d raw fixture 直接以公開原語驗證）、
 *   決策政策：pending 時 `CHOOSE_DECISION` 取第一個 `optionId`，否則
 *   `ADVANCE_YEAR contentMode=standard` → 106 命令、40 決策、age 67 死亡（2091）；
 * - **合成 Pair**：正式 hash 原語組出的「內部自洽」Pair——用於 tail binding
 *   的隔離歸因（六個尾端 head 欄位逐一只有一個比較失敗）與 scale 合成鏈。
 *
 * ## scale fixture（4096 筆）
 *
 * 51 筆真實 Pair（custom age-51 死亡路徑）＋ 52..4095 的合成 Pair（HEX_C 鏈）＋
 * index 4096 的合成尾端 Pair——尾端 state 用 `computeP3EStateHash` 的無循環
 * 回填順序組出：先設 `heads.last*` 三欄（在 projection 內）→ 重算 stateHash →
 * 回填 Pair 的 `stateHashAfter` → `createP3ECommandRecord` → chainHash →
 * 最後回填 `commandLog.headHash`／`heads.hashChain`（明確排除在 projection 外，
 * 不影響 stateHash）。斷言 wire < 16MiB、roundtrip byte-identical，並輸出
 * 效能報告 `{bytes, encode_ms, decode_ms, peak_heap_bytes, node_version}`。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const CODEC_SRC = readFileSync(
  join(ROOT, "packages/simulation/src/p3e-session-payload-codec.ts"),
  "utf8"
);
const CODEC_CODE = CODEC_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
const BARREL_SRC = readFileSync(join(ROOT, "packages/simulation/src/index.ts"), "utf8");

const CODE = "E_P3E_CODEC";
const PATH_INPUT = "p3eSessionPayload.input";
const PATH_FORMAT_VERSION = "p3eSessionPayload.formatVersion";
const PATH_MASTER_SEED = "p3eSessionPayload.masterSeed";
const PATH_BINDING_SEED_HASH = "p3eSessionPayload.binding.seedHash";
const PATH_BINDING_COUNT = "p3eSessionPayload.binding.count";
const PATH_BINDING_EMPTY_ANCHOR = "p3eSessionPayload.binding.emptyAnchor";
const PATH_BINDING_TAIL = "p3eSessionPayload.binding.tail";
const PATH_HISTORY = "p3eSessionPayload.history";

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
/** untouched p3d death pack（正式 product path 用）。 */
const deathPack = validateDeathPack(
  { manifest: rawDeathManifest, datasets: rawDeathDatasets } as never,
  base
);

/** untouched p3b event pack：raw fixture 直接以公開原語驗證（不重算 checksum）。 */
const eventPackOfficial = validateEventPack({ manifest: rawEventManifest, events: rawEvents } as never);

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

/** 沒有任何候選事件的事件包（standard contentMode 下）。 */
const packNoCandidates = repairedEventPack([cloneEvent("ev.child.first-word")]);

const SEED = "p3e-175-replay-v1";
/** 正式 product path 的 seed（H5-CTO-175-B-R1 固定）。 */
const SEED_OFFICIAL = "p3e-166-playable-runtime-v4";
const SEED_OTHER = `${SEED}-other`;
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

/* --------------------- genesis 與 genesisInput --------------------- */

const genesisZero = createP3EGenesis(genesisInputOf(packNoCandidates, deathPackZeroHazard));
const genesisOfficial = createP3EGenesis(genesisInputOf(packNoCandidates, deathPackOfficial51));

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

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
 * 用正式原語獨立算出 entry／command／chain hash，組出「內部完全自洽」的一對
 * Record（可通過 `readP3ELedgerHistory` 的完整驗證）。
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

/* ================================================================== */
/* 共用 fixture：一命令真實 History（tail binding 測試的基底）            */
/* ================================================================== */

const one = buildHistory(genesisZero, packNoCandidates, deathPackZeroHazard, [{ ...ADVANCE }]);
const state1 = one.finalState;
const oneLedger = one.ledger;
/** 尾端 Pair 的 entry hash（正式原語；snapshot=HEX_D、delta=HEX_E）。 */
const tailEntryHash = computeP3EYearEntryHash({
  index: 1,
  year: state1.currentYear,
  age: state1.age,
  phase: state1.phase,
  stateHashBefore: genesisZero.stateHash,
  rngBefore: genesisZero.rng,
  rngAfter: genesisZero.rng,
  snapshotHash: HEX_D,
  deltaHash: HEX_E
}) as string;

/** 深拷貝一個（可能深層凍結的）state 為可變 Dict。 */
function mutableClone(state: contracts.P3ELifeState): Dict {
  return structuredClone(state) as unknown as Dict;
}

interface TailCase {
  readonly state: contracts.P3ELifeState;
  readonly pair: { commandRecord: P3ECommandRecord; yearRecord: Dict };
}

interface TailCaseOptions {
  /** 寫入 `state.heads.lastSnapshotHash`（Pair 側固定 HEX_D）。 */
  readonly lastSnapshotHash: string;
  /** 寫入 `state.heads.lastDeltaHash`（Pair 側固定 HEX_E）。 */
  readonly lastDeltaHash: string;
  /** 寫入 `state.heads.lastEntryHash`（Pair 側固定 tailEntryHash）。 */
  readonly lastEntryHash: string;
  /** 覆寫 `state.commandLog.headHash`（Pair 側為 Pair 自算的 commandHash）。 */
  readonly headHashOverride?: string;
  /** 覆寫 `state.heads.hashChain`（Pair 側為 Pair 自算的 chainHash）。 */
  readonly chainHashOverride?: string;
  /** 覆寫 Pair 的 `stateHashAfter`（預設＝state 重算出的 stateHash）。 */
  readonly pairStateHashAfter?: string;
}

/**
 * 組出「自洽且通過全部驗證」的 state＋尾端 Pair，其中呼叫端指定的**一個**
 * 尾端 head 欄位被隔離地錯開（其餘五個比較全部相等）→ binding.tail。
 *
 * 無循環回填順序：`heads.last*` 三欄（在 projection 內）先設 → 重算
 * stateHash → Pair 以該 stateHash 組出（commandHash／chainHash 隨之重算）→
 * 最後回填 `commandLog.headHash`／`heads.hashChain`（明確排除在 projection
 * 外，不影響 stateHash 的正確性）。
 */
function buildTailCase(options: TailCaseOptions): TailCase {
  const s = mutableClone(state1);
  (s.heads as Dict).lastSnapshotHash = options.lastSnapshotHash;
  (s.heads as Dict).lastDeltaHash = options.lastDeltaHash;
  (s.heads as Dict).lastEntryHash = options.lastEntryHash;
  (s.commandLog as Dict).count = 1;
  const stateHash = computeP3EStateHash(s as unknown as contracts.P3ELifeState);
  s.stateHash = stateHash;
  const pair = syntheticPair({
    index: 1,
    year: state1.currentYear,
    age: state1.age,
    phase: state1.phase,
    stateHashBefore: genesisZero.stateHash,
    stateHashAfter: options.pairStateHashAfter ?? stateHash,
    prevCommandHash: genesisZero.commandLog.headHash,
    prevChainHash: genesisZero.heads.hashChain,
    rngBefore: genesisZero.rng,
    rngAfter: genesisZero.rng,
    snapshotHash: HEX_D,
    deltaHash: HEX_E,
    command: { ...ADVANCE }
  });
  (s.commandLog as Dict).headHash = options.headHashOverride ?? pair.commandRecord.commandHash;
  (s.heads as Dict).hashChain = options.chainHashOverride ?? (pair.yearRecord.chainHash as string);
  return { state: s as unknown as contracts.P3ELifeState, pair };
}

/** decode 側的 wire：與 encode 同樣由正式原語組出（state/pair 都是 canonical 投影）。 */
function decodeWireForTailCase(tailCase: TailCase): string {
  return JSON.stringify({
    formatVersion: P3E_SESSION_PAYLOAD_FORMAT_VERSION,
    masterSeed: SEED,
    state: JSON.parse(encodeP3EState(tailCase.state)),
    history: {
      initial: anchorOf(genesisZero),
      records: [JSON.parse(encodeP3ELedgerRecordPair(tailCase.pair))]
    }
  });
}

/** 空 History 的合法 encode 輸入。 */
function emptyPayloadInput(): Dict {
  return { masterSeed: SEED, state: genesisZero, history: createP3ELedgerHistory(genesisZero) };
}

/** 遞迴收集 JSON 物件的全部鍵名（canonical 禁鍵掃描用）。 */
function collectKeys(value: unknown, into: Set<string>): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  for (const [key, item] of Object.entries(value as Dict)) {
    into.add(key);
    collectKeys(item, into);
  }
}

/* ================================================================== */
/* 一、正向：empty／official 51 命令／canonical 重複性／凍結與零共享       */
/* ================================================================== */

describe("H5-CTO-182-A Session Payload Codec V1：正向", () => {
  it("empty_genesis_history_roundtrip：空 History 的 canonical wire 鍵序、money 型別轉換與 byte-identical roundtrip", () => {
    const wire = encodeP3ESessionPayload(emptyPayloadInput());

    // wire 鍵序固定：formatVersion → masterSeed → state → history。
    const parsedWire = JSON.parse(wire) as Dict;
    expect(Object.keys(parsedWire)).toEqual(["formatVersion", "masterSeed", "state", "history"]);
    expect(parsedWire.formatVersion).toBe(6);
    expect(parsedWire.masterSeed).toBe(SEED);
    // history 容器鍵序：initial（三欄固定順序）→ records。
    const wireHistory = parsedWire.history as Dict;
    expect(Object.keys(wireHistory)).toEqual(["initial", "records"]);
    expect(Object.keys(wireHistory.initial as Dict)).toEqual(["stateHash", "commandHeadHash", "chainHash"]);
    expect(wireHistory.records).toEqual([]);
    // wire 內金額是 canonical 十進位字串。
    const wireAssets = ((parsedWire.state as Dict).assets) as Dict;
    expect(typeof wireAssets.balanceMicroUsd).toBe("string");
    expect(wireAssets.balanceMicroUsd).toBe(genesisZero.assets.balanceMicroUsd.toString());

    const payload = decodeP3ESessionPayload(wire);
    expect(payload.formatVersion).toBe(6);
    expect(payload.masterSeed).toBe(SEED);
    // decoded 內金額是 bigint，且 state 與輸入 genesis 語意相等（新物件）。
    expect(typeof payload.state.assets.balanceMicroUsd).toBe("bigint");
    expect(payload.state).not.toBe(genesisZero);
    expect(stable(payload.state)).toBe(stable(genesisZero));
    expect(payload.history.records).toEqual([]);
    expect(payload.history.initial.stateHash).toBe(genesisZero.stateHash);
    expect(payload.history.initial.commandHeadHash).toBe(genesisZero.commandLog.headHash);
    expect(payload.history.initial.chainHash).toBe(genesisZero.heads.hashChain);
    // decode(encode(x)) 之後再 encode → byte-identical。
    expect(
      encodeP3ESessionPayload({ masterSeed: payload.masterSeed, state: payload.state, history: payload.history })
    ).toBe(wire);
  });

  it("official_51_command_history_roundtrip：正式 product path 的固定期望值與 roundtrip", () => {
    // 正式 product path（H5-CTO-175-B-R1）：seed 與 untouched 官方 packs，
    // 政策：pending 時 CHOOSE_DECISION 第一個 optionId，否則 ADVANCE_YEAR。
    const genesisInput = genesisInputOf(eventPackOfficial, deathPack, SEED_OFFICIAL);
    const genesisProduct = createP3EGenesis(genesisInput);
    const commands = productPathCommands(genesisProduct, eventPackOfficial, deathPack);
    expect(commands.length).toBe(106);
    expect(commands.filter((command) => command.type === "CHOOSE_DECISION").length).toBe(39);

    const built = buildHistory(genesisProduct, eventPackOfficial, deathPack, commands);

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
    const builtRecords = (built.ledger as { records: unknown[] }).records as Dict[];
    expect(builtRecords.length).toBe(106);
    expect(((builtRecords[builtRecords.length - 1] as Dict).commandRecord as P3ECommandRecord).entryHash).toBe(
      "901d0e35a49683014e6772eebe9e775964592560662ae92f92a7661f762e82ce"
    );
    expect(((builtRecords[builtRecords.length - 1] as Dict).yearRecord as Dict).entryHash).toBe(
      "901d0e35a49683014e6772eebe9e775964592560662ae92f92a7661f762e82ce"
    );

    const wire = encodeP3ESessionPayload({
      masterSeed: SEED_OFFICIAL,
      state: built.finalState,
      history: built.ledger
    });
    const payload = decodeP3ESessionPayload(wire);

    expect(payload.masterSeed).toBe(SEED_OFFICIAL);
    expect(stable(payload.state)).toBe(stable(built.finalState));
    expect(stable(payload.history)).toBe(stable(built.ledger));
    expect((payload.history.records as unknown[]).length).toBe(106);
    const decodedRecords = payload.history.records as unknown as Dict[];
    expect(((decodedRecords[decodedRecords.length - 1] as Dict).yearRecord as Dict).entryHash).toBe(
      "901d0e35a49683014e6772eebe9e775964592560662ae92f92a7661f762e82ce"
    );
    // byte-identical roundtrip（含 1 個 CHOOSE_DECISION 命令的 canonical 投影）。
    expect(
      encodeP3ESessionPayload({ masterSeed: payload.masterSeed, state: payload.state, history: payload.history })
    ).toBe(wire);
  });

  it("canonical_repeatability：相同輸入重複 encode byte-identical、無空白、無禁鍵", () => {
    const wire1 = encodeP3ESessionPayload(emptyPayloadInput());
    const wire2 = encodeP3ESessionPayload(emptyPayloadInput());
    expect(wire1).toBe(wire2);
    // 無空白：wire === 自己的重新序列化（JSON.stringify(JSON.parse(wire))）。
    expect(wire1).toBe(JSON.stringify(JSON.parse(wire1)));

    // 禁鍵掃描：wire 的任何層級都不得出現非決定性／儲存系統欄位。
    const keys = new Set<string>();
    collectKeys(JSON.parse(wire1), keys);
    for (const bad of ["timestamp", "nonce", "saveId", "revision", "metadata", "createdAt", "savedAt"]) {
      expect(keys.has(bad), `wire 不得出現 ${bad}`).toBe(false);
    }

    // 官方 51 命令路徑同樣具重複性（決策命令的 canonical 投影一致）。
    const genesisInput = genesisInputOf(eventPackOfficial, deathPack, SEED_OFFICIAL);
    const genesisProduct = createP3EGenesis(genesisInput);
    const commands = productPathCommands(genesisProduct, eventPackOfficial, deathPack);
    const built = buildHistory(genesisProduct, eventPackOfficial, deathPack, commands);
    const officialWire1 = encodeP3ESessionPayload({
      masterSeed: SEED_OFFICIAL,
      state: built.finalState,
      history: built.ledger
    });
    const officialWire2 = encodeP3ESessionPayload({
      masterSeed: SEED_OFFICIAL,
      state: built.finalState,
      history: built.ledger
    });
    expect(officialWire1).toBe(officialWire2);
  });

  it("deep_freeze_and_zero_share：輸出深層凍結、與輸入零共享、不修改輸入", () => {
    const input = { masterSeed: SEED, state: state1, history: oneLedger };
    const inputBefore = stable(input);

    const wire = encodeP3ESessionPayload(input);
    // encode 不修改輸入。
    expect(stable(input)).toBe(inputBefore);

    const payload = decodeP3ESessionPayload(wire);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(isDeepFrozen(payload)).toBe(true);
    expect(isDeepFrozen(payload.state)).toBe(true);
    expect(isDeepFrozen(payload.history)).toBe(true);
    // 輸出與輸入零共享。
    expect(payload.state).not.toBe(state1);
    expect(sharesReference(payload.state, state1)).toBe(false);
    expect(sharesReference(payload.history, oneLedger)).toBe(false);
    expect(stable(payload.state)).toBe(stable(state1));
    expect(stable(payload.history)).toBe(stable(oneLedger));
  });
});

/* ================================================================== */
/* 二、負向：format/seed binding／count／empty anchor／tail 六欄隔離／     */
/*     損壞內容／malformed／信任邊界矩陣                                  */
/* ================================================================== */

describe("H5-CTO-182-A Session Payload Codec V1：負向", () => {
  it("wrong_format_or_seed_binding：formatVersion／masterSeed 形式與 seedHash binding（encode＋decode）", () => {
    const wire = encodeP3ESessionPayload(emptyPayloadInput());
    const parsed = JSON.parse(wire) as Dict;

    // formatVersion：不是數字 6（decode 側專責）。
    expectP3EError(
      () => decodeP3ESessionPayload(JSON.stringify({ ...parsed, formatVersion: 5 })),
      CODE,
      PATH_FORMAT_VERSION
    );
    expectP3EError(
      () => decodeP3ESessionPayload(JSON.stringify({ ...parsed, formatVersion: "6" })),
      CODE,
      PATH_FORMAT_VERSION
    );

    // masterSeed：未正規化／空／控制字元／非 NFC／非字串（encode＋decode 兩側）。
    const badSeeds: unknown[] = [" x", "x ", "", "\nx", "\u0001x", "e\u0301", 42, null];
    for (const seed of badSeeds) {
      expectP3EError(
        () => decodeP3ESessionPayload(JSON.stringify({ ...parsed, masterSeed: seed })),
        CODE,
        PATH_MASTER_SEED
      );
      expectP3EError(
        () => encodeP3ESessionPayload({ masterSeed: seed, state: genesisZero, history: createP3ELedgerHistory(genesisZero) }),
        CODE,
        PATH_MASTER_SEED
      );
    }

    // 跨 seed binding：state/history 是 seed SEED 的，masterSeed 卻換成別的 seed。
    expectP3EError(
      () => encodeP3ESessionPayload({ masterSeed: SEED_OTHER, state: state1, history: oneLedger }),
      CODE,
      PATH_BINDING_SEED_HASH
    );
    expectP3EError(
      () => decodeP3ESessionPayload(JSON.stringify({ ...parsed, masterSeed: SEED_OTHER })),
      CODE,
      PATH_BINDING_SEED_HASH
    );
  });

  it("state_history_count_mismatch：state.commandLog.count 與 records.length 兩方向", () => {
    const two = buildHistory(genesisZero, packNoCandidates, deathPackZeroHazard, [{ ...ADVANCE }, { ...ADVANCE }]);

    // encode：state 落後 history 一個命令（count 0 vs 1）。
    expectP3EError(
      () => encodeP3ESessionPayload({ masterSeed: SEED, state: genesisZero, history: oneLedger }),
      CODE,
      PATH_BINDING_COUNT
    );
    // encode：state 超前 history 一個命令（count 1 vs 2）。
    expectP3EError(
      () => encodeP3ESessionPayload({ masterSeed: SEED, state: state1, history: two.ledger }),
      CODE,
      PATH_BINDING_COUNT
    );

    // decode：竄改 wire state 的 commandLog.count（commandLog 不在 stateHash
    // projection 內，state 驗證仍通過 → 精確落在 binding.count）。
    const oneWire = encodeP3ESessionPayload({ masterSeed: SEED, state: state1, history: oneLedger });
    const ahead = JSON.parse(oneWire) as Dict;
    ((ahead.state as Dict).commandLog as Dict).count = 2;
    expectP3EError(() => decodeP3ESessionPayload(JSON.stringify(ahead)), CODE, PATH_BINDING_COUNT);

    const twoWire = encodeP3ESessionPayload({
      masterSeed: SEED,
      state: two.finalState,
      history: two.ledger
    });
    const behind = JSON.parse(twoWire) as Dict;
    ((behind.state as Dict).commandLog as Dict).count = 1;
    expectP3EError(() => decodeP3ESessionPayload(JSON.stringify(behind)), CODE, PATH_BINDING_COUNT);
  });

  it("empty_anchor_mismatch：空 History 的三個 anchor 欄位逐一失敗（encode＋decode）", () => {
    for (const field of ["stateHash", "commandHeadHash", "chainHash"]) {
      const initial = { ...anchorOf(genesisZero), [field]: "f".repeat(64) };
      // encode：history.initial 的單一 anchor 欄位與 state 不一致。
      expectP3EError(
        () => encodeP3ESessionPayload({ masterSeed: SEED, state: genesisZero, history: { initial, records: [] } }),
        CODE,
        PATH_BINDING_EMPTY_ANCHOR
      );
      // decode：竄改 wire history.initial 的同一欄位。
      const wire = encodeP3ESessionPayload(emptyPayloadInput());
      const parsed = JSON.parse(wire) as Dict;
      ((parsed.history as Dict).initial as Dict)[field] = "f".repeat(64);
      expectP3EError(() => decodeP3ESessionPayload(JSON.stringify(parsed)), CODE, PATH_BINDING_EMPTY_ANCHOR);
    }
  });

  it("each_nonempty_tail_head_mismatch：六個尾端 head 逐一隔離歸因（encode＋decode）＋正向對照", () => {
    // 正向對照：全部六個比較相等 → encode/decode 成功。
    const control = buildTailCase({
      lastSnapshotHash: HEX_D,
      lastDeltaHash: HEX_E,
      lastEntryHash: tailEntryHash
    });
    const controlWire = encodeP3ESessionPayload({
      masterSeed: SEED,
      state: control.state,
      history: { initial: anchorOf(genesisZero), records: [control.pair] }
    });
    const controlPayload = decodeP3ESessionPayload(controlWire);
    expect(stable(controlPayload.state)).toBe(stable(control.state));
    expect(stable(controlPayload.history)).toBe(
      stable({ initial: anchorOf(genesisZero), records: [control.pair] })
    );

    // 六個場景：每個場景恰好只有一個尾端比較失敗。
    const cases: { name: string; options: TailCaseOptions }[] = [
      {
        name: "state.stateHash ≠ tail.yearRecord.stateHashAfter",
        options: { lastSnapshotHash: HEX_D, lastDeltaHash: HEX_E, lastEntryHash: tailEntryHash, pairStateHashAfter: HEX_C }
      },
      {
        name: "state.commandLog.headHash ≠ tail.commandRecord.commandHash",
        options: { lastSnapshotHash: HEX_D, lastDeltaHash: HEX_E, lastEntryHash: tailEntryHash, headHashOverride: HEX_B }
      },
      {
        name: "state.heads.hashChain ≠ tail.yearRecord.chainHash",
        options: { lastSnapshotHash: HEX_D, lastDeltaHash: HEX_E, lastEntryHash: tailEntryHash, chainHashOverride: HEX_B }
      },
      {
        name: "state.heads.lastSnapshotHash ≠ tail.yearRecord.snapshotHash",
        options: { lastSnapshotHash: HEX_B, lastDeltaHash: HEX_E, lastEntryHash: tailEntryHash }
      },
      {
        name: "state.heads.lastDeltaHash ≠ tail.yearRecord.deltaHash",
        options: { lastSnapshotHash: HEX_D, lastDeltaHash: HEX_B, lastEntryHash: tailEntryHash }
      },
      {
        name: "state.heads.lastEntryHash ≠ tail.yearRecord.entryHash",
        options: { lastSnapshotHash: HEX_D, lastDeltaHash: HEX_E, lastEntryHash: HEX_B }
      }
    ];
    for (const item of cases) {
      const tailCase = buildTailCase(item.options);
      const history = { initial: anchorOf(genesisZero), records: [tailCase.pair] };
      // encode 側。
      expectP3EError(
        () => encodeP3ESessionPayload({ masterSeed: SEED, state: tailCase.state, history }),
        CODE,
        PATH_BINDING_TAIL
      );
      // decode 側：由正式原語組出的 wire（state/pair 各自完全合法）。
      expectP3EError(() => decodeP3ESessionPayload(decodeWireForTailCase(tailCase)), CODE, PATH_BINDING_TAIL);
    }
  });

  it("corrupted_state_pair_or_history_link：state 內容／Pair 自洽／History 鏈結的損壞偵測", () => {
    const three = buildHistory(genesisZero, packNoCandidates, deathPackZeroHazard, [
      { ...ADVANCE },
      { ...ADVANCE },
      { ...ADVANCE }
    ]);
    const threeWire = encodeP3ESessionPayload({
      masterSeed: SEED,
      state: three.finalState,
      history: three.ledger
    });

    // (a) state 內容損壞：wire state 的金額字串改動 → stateHash 重算不符。
    const moneyTampered = JSON.parse(threeWire) as Dict;
    ((moneyTampered.state as Dict).assets as Dict).balanceMicroUsd = "999999";
    expectP3ECode(() => decodeP3ESessionPayload(JSON.stringify(moneyTampered)), "E_P3E_HASH");

    // (b) Pair 自洽性損壞：yearRecord.chainHash 改動 → Pair 內部重算不符。
    const pairTampered = JSON.parse(threeWire) as Dict;
    const firstEnvelope = ((pairTampered.history as Dict).records as unknown[])[0] as Dict;
    ((firstEnvelope.yearRecord as Dict).chainHash) = "f".repeat(64);
    expectP3ECode(() => decodeP3ESessionPayload(JSON.stringify(pairTampered)), "E_P3E_HISTORY");

    // (c) History 鏈結損壞：刪除 records[1] → 後續 Pair 的 index 不連續。
    const indexBroken = JSON.parse(threeWire) as Dict;
    ((indexBroken.history as Dict).records as unknown[]).splice(1, 1);
    expectP3EError(
      () => decodeP3ESessionPayload(JSON.stringify(indexBroken)),
      "E_P3E_HISTORY",
      "ledgerHistory.records.index"
    );

    // (d) History 錨點損壞：initial.chainHash 改動 → 第一個 Pair 的 prevChainHash 不符。
    const anchorBroken = JSON.parse(threeWire) as Dict;
    ((anchorBroken.history as Dict).initial as Dict).chainHash = "f".repeat(64);
    expectP3EError(
      () => decodeP3ESessionPayload(JSON.stringify(anchorBroken)),
      "E_P3E_HISTORY",
      "ledgerHistory.records.prevChainHash"
    );
  });

  it("malformed_JSON_over_limit_pollution：非字串／壞 JSON／超長（parse 前）／污染鍵／exact 四欄", () => {
    // 只接受字串。
    expectP3EError(() => decodeP3ESessionPayload(null), CODE, PATH_INPUT);
    expectP3EError(() => decodeP3ESessionPayload(undefined), CODE, PATH_INPUT);
    expectP3EError(() => decodeP3ESessionPayload(42), CODE, PATH_INPUT);
    expectP3EError(() => decodeP3ESessionPayload(["{}"]), CODE, PATH_INPUT);

    // 壞 JSON。
    expectP3EError(() => decodeP3ESessionPayload(""), CODE, PATH_INPUT);
    expectP3EError(() => decodeP3ESessionPayload("{"), CODE, PATH_INPUT);

    // 長度上限在 JSON.parse 之前檢查（超長字串直接拒絕）。
    expectP3EError(() => decodeP3ESessionPayload(" ".repeat(P3E_SESSION_PAYLOAD_MAX_LENGTH + 1)), CODE, PATH_INPUT);
    expectP3EError(() => decodeP3ESessionPayload(" ".repeat(P3E_SESSION_PAYLOAD_MAX_LENGTH)), CODE, PATH_INPUT);

    const wire = encodeP3ESessionPayload(emptyPayloadInput());
    const parsed = JSON.parse(wire) as Dict;

    // 缺鍵／多鍵／改鍵。
    const missing = { ...parsed };
    delete missing.state;
    expectP3EError(() => decodeP3ESessionPayload(JSON.stringify(missing)), CODE, PATH_INPUT);
    expectP3EError(() => decodeP3ESessionPayload(JSON.stringify({ ...parsed, extra: 1 })), CODE, PATH_INPUT);
    expectP3EError(
      () => decodeP3ESessionPayload(
        JSON.stringify({ formatVersion: parsed.formatVersion, masterSeed: parsed.masterSeed, stat: parsed.state, history: parsed.history })
      ),
      CODE,
      PATH_INPUT
    );

    // 頂層陣列不是 object。
    expectP3EError(() => decodeP3ESessionPayload(JSON.stringify([parsed])), CODE, PATH_INPUT);

    // history 容器 exact 兩欄（缺鍵／多鍵）與 initial 型別（非物件／null／陣列）。
    const historyOnly = { ...parsed, history: { initial: (parsed.history as Dict).initial } };
    expectP3EError(() => decodeP3ESessionPayload(JSON.stringify(historyOnly)), CODE, PATH_HISTORY);
    const historyExtra = { ...parsed, history: { ...(parsed.history as Dict), extra: 1 } };
    expectP3EError(() => decodeP3ESessionPayload(JSON.stringify(historyExtra)), CODE, PATH_HISTORY);
    for (const badInitial of [42, null, []]) {
      const badHistory = { ...parsed, history: { initial: badInitial, records: (parsed.history as Dict).records } };
      expectP3EError(() => decodeP3ESessionPayload(JSON.stringify(badHistory)), CODE, PATH_HISTORY);
    }

    // history 容器本身不是 plain object（asPlainRecord → null）、records 非陣列。
    for (const badContainer of [42, null, []]) {
      const badHistory = { ...parsed, history: badContainer };
      expectP3EError(() => decodeP3ESessionPayload(JSON.stringify(badHistory)), CODE, PATH_HISTORY);
    }
    const badRecords = { ...parsed, history: { initial: (parsed.history as Dict).initial, records: 42 } };
    expectP3EError(() => decodeP3ESessionPayload(JSON.stringify(badRecords)), CODE, PATH_HISTORY);

    // 污染鍵以文字插入（JSON.parse 之後掃描）。
    expectP3EError(
      () => decodeP3ESessionPayload(`${wire.slice(0, -1)},"__proto__":{"polluted":true}}`),
      CODE,
      PATH_INPUT
    );
    expectP3EError(
      () => decodeP3ESessionPayload(`${wire.slice(0, -1)},"constructor":{"prototype":{}}}`),
      CODE,
      PATH_INPUT
    );
    expectP3EError(
      () => decodeP3ESessionPayload(wire.replace('"state":{', '"state":{"__proto__":null,')),
      CODE,
      PATH_INPUT
    );
  });

  it("exact_object_and_array_trust_boundary_matrix：encode descriptor 矩陣（getter 永不執行）與 passthrough", () => {
    // 非 object 輸入。
    expectP3EError(() => encodeP3ESessionPayload(null), CODE, PATH_INPUT);
    expectP3EError(() => encodeP3ESessionPayload(undefined), CODE, PATH_INPUT);
    expectP3EError(() => encodeP3ESessionPayload(42), CODE, PATH_INPUT);
    expectP3EError(() => encodeP3ESessionPayload([]), CODE, PATH_INPUT);

    // 缺鍵／多鍵／改鍵。
    expectP3EError(() => encodeP3ESessionPayload({ masterSeed: SEED, state: genesisZero }), CODE, PATH_INPUT);
    expectP3EError(() => encodeP3ESessionPayload({ ...emptyPayloadInput(), extra: 1 }), CODE, PATH_INPUT);
    const renamed: Dict = {};
    for (const key of Object.keys(emptyPayloadInput())) renamed[`x-${key}`] = (emptyPayloadInput() as Dict)[key];
    expectP3EError(() => encodeP3ESessionPayload(renamed), CODE, PATH_INPUT);

    // 隱藏（不可列舉）額外欄位／隱藏必要欄位。
    const hiddenExtra = { ...emptyPayloadInput() };
    Object.defineProperty(hiddenExtra, "extra", { value: 1, enumerable: false, writable: true, configurable: true });
    expectP3EError(() => encodeP3ESessionPayload(hiddenExtra), CODE, PATH_INPUT);
    const hiddenRequired = { ...emptyPayloadInput() };
    Object.defineProperty(hiddenRequired, "masterSeed", {
      value: SEED,
      enumerable: false,
      writable: true,
      configurable: true
    });
    expectP3EError(() => encodeP3ESessionPayload(hiddenRequired), CODE, PATH_INPUT);

    // symbol 鍵。
    const withSymbol = { ...emptyPayloadInput() };
    Object.defineProperty(withSymbol, Symbol("x"), { value: 1, enumerable: true, writable: true, configurable: true });
    expectP3EError(() => encodeP3ESessionPayload(withSymbol), CODE, PATH_INPUT);

    // accessor：getter **不會**被執行。
    let getterCalls = 0;
    const withAccessor = { ...emptyPayloadInput() };
    Object.defineProperty(withAccessor, "state", {
      get() {
        getterCalls += 1;
        return genesisZero;
      },
      enumerable: true,
      configurable: true
    });
    expectP3EError(() => encodeP3ESessionPayload(withAccessor), CODE, PATH_INPUT);
    expect(getterCalls).toBe(0);

    // class instance（exotic prototype）。
    class Payload {
      masterSeed = SEED;
      state = genesisZero;
      history = createP3ELedgerHistory(genesisZero);
    }
    expectP3EError(() => encodeP3ESessionPayload(new Payload()), CODE, PATH_INPUT);

    // revoked Proxy：反射失敗折成 E_P3E_CODEC。
    const revoked = Proxy.revocable(emptyPayloadInput(), {});
    revoked.revoke();
    expectP3EError(() => encodeP3ESessionPayload(revoked.proxy), CODE, PATH_INPUT);

    // null-prototype 的合法輸入可 encode（proto === null 分支）。
    const nullProto: Dict = Object.create(null);
    nullProto.masterSeed = SEED;
    nullProto.state = genesisZero;
    nullProto.history = createP3ELedgerHistory(genesisZero);
    const nullWire = encodeP3ESessionPayload(nullProto);
    expect(decodeP3ESessionPayload(nullWire).masterSeed).toBe(SEED);

    // passthrough：state = 42 → 正式 State Codec 的錯誤原樣外拋。
    expectP3ECode(
      () => encodeP3ESessionPayload({ masterSeed: SEED, state: 42, history: createP3ELedgerHistory(genesisZero) }),
      "E_P3E_STATE"
    );

    // passthrough：history = {} → readP3ELedgerHistory 的 input 錯誤原樣外拋。
    expectP3EError(
      () => encodeP3ESessionPayload({ masterSeed: SEED, state: genesisZero, history: {} }),
      "E_P3E_HISTORY",
      "ledgerHistory.input"
    );

    // 稀疏 records 陣列 → readP3ELedgerHistory 的 records 錯誤。
    const sparseError = expectP3ECode(
      () => encodeP3ESessionPayload({
        masterSeed: SEED,
        state: genesisZero,
        history: { initial: anchorOf(genesisZero), records: new Array(1) }
      }),
      "E_P3E_HISTORY"
    );
    expect(sparseError.path.startsWith("ledgerHistory.records")).toBe(true);
  });
});

/* ================================================================== */
/* 三、scale：4096 筆（51 真實 Pair＋合成鏈＋合成尾端）＜ 16MiB            */
/* ================================================================== */

describe("H5-CTO-182-A Session Payload Codec V1：scale", () => {
  it("scale_4096_under_16MiB：51 真實 Pair＋合成 Pair 至 4096、wire < 16MiB、roundtrip byte-identical、效能報告", () => {
    const commands: Dict[] = [];
    for (let step = 0; step < 51; step += 1) commands.push({ ...ADVANCE });
    const built = buildHistory(genesisOfficial, packNoCandidates, deathPackOfficial51, commands);
    const s51 = built.finalState;
    const realTailPair = ((built.ledger as { records: unknown[] }).records[(built.ledger as { records: unknown[] }).records.length - 1] as unknown as Dict);
    const realTailCommand = realTailPair.commandRecord as P3ECommandRecord;
    const realTailYear = realTailPair.yearRecord as Dict;

    const records: Dict[] = [...((built.ledger as { records: unknown[] }).records) as Dict[]];

    // 合成 Pair 52..4095：HEX_C 鏈（內部自洽、非真實交易）。
    let stateHashBefore = realTailYear.stateHashAfter as string;
    let prevCommandHash = realTailCommand.commandHash;
    let prevChainHash = realTailYear.chainHash as string;
    for (let position = 52; position <= 4095; position += 1) {
      const pair = syntheticPair({
        index: position,
        year: genesisOfficial.currentYear + position,
        age: 50,
        phase: "life",
        stateHashBefore,
        stateHashAfter: HEX_C,
        prevCommandHash,
        prevChainHash,
        rngBefore: s51.rng,
        rngAfter: s51.rng,
        snapshotHash: HEX_D,
        deltaHash: HEX_E,
        command: { ...ADVANCE }
      });
      records.push({ commandRecord: pair.commandRecord, yearRecord: pair.yearRecord });
      stateHashBefore = HEX_C;
      prevCommandHash = pair.commandRecord.commandHash;
      prevChainHash = pair.yearRecord.chainHash as string;
    }

    // 合成尾端 Pair（index 4096）：state 以無循環順序回填——
    // 先設 heads.last* 三欄（在 projection 內）→ 重算 stateHash →
    // 回填 Pair.stateHashAfter → commandRecord/chainHash →
    // 最後回填 commandLog.headHash／heads.hashChain（排除在 projection 外）。
    const tailYear = genesisOfficial.currentYear + 4096;
    const tailEntryHash = computeP3EYearEntryHash({
      index: 4096,
      year: tailYear,
      age: 50,
      phase: "life",
      stateHashBefore: HEX_C,
      rngBefore: s51.rng,
      rngAfter: s51.rng,
      snapshotHash: HEX_D,
      deltaHash: HEX_E
    }) as string;
    const stateS = mutableClone(s51);
    (stateS.heads as Dict).lastSnapshotHash = HEX_D;
    (stateS.heads as Dict).lastDeltaHash = HEX_E;
    (stateS.heads as Dict).lastEntryHash = tailEntryHash;
    (stateS.commandLog as Dict).count = 4096;
    const finalHash = computeP3EStateHash(stateS as unknown as contracts.P3ELifeState);
    stateS.stateHash = finalHash;
    const tail = syntheticPair({
      index: 4096,
      year: tailYear,
      age: 50,
      phase: "life",
      stateHashBefore: HEX_C,
      stateHashAfter: finalHash,
      prevCommandHash,
      prevChainHash,
      rngBefore: s51.rng,
      rngAfter: s51.rng,
      snapshotHash: HEX_D,
      deltaHash: HEX_E,
      command: { ...ADVANCE }
    });
    records.push({ commandRecord: tail.commandRecord, yearRecord: tail.yearRecord });
    (stateS.commandLog as Dict).headHash = tail.commandRecord.commandHash;
    (stateS.heads as Dict).hashChain = tail.yearRecord.chainHash as string;
    expect(records.length).toBe(4096);

    const payloadInput = {
      masterSeed: SEED,
      state: stateS as unknown as contracts.P3ELifeState,
      history: { initial: anchorOf(genesisOfficial), records }
    };

    const encodeStart = performance.now();
    const wire = encodeP3ESessionPayload(payloadInput);
    const encodeMs = performance.now() - encodeStart;

    expect(wire.length).toBeLessThan(P3E_SESSION_PAYLOAD_MAX_LENGTH);
    expect(wire.length).toBeGreaterThan(1_000_000);

    const heapBefore = process.memoryUsage().heapUsed;
    const decodeStart = performance.now();
    const payload = decodeP3ESessionPayload(wire);
    const decodeMs = performance.now() - decodeStart;

    expect((payload.history.records as unknown[]).length).toBe(4096);
    expect(stable(payload.state)).toBe(stable(stateS as unknown as contracts.P3ELifeState));
    expect(stable(payload.history)).toBe(stable({ initial: anchorOf(genesisOfficial), records }));
    // re-encode byte-identical。
    expect(
      encodeP3ESessionPayload({ masterSeed: payload.masterSeed, state: payload.state, history: payload.history })
    ).toBe(wire);

    // 效能報告（work order 指定欄位）。
    const report = {
      bytes: wire.length,
      encode_ms: Number(encodeMs.toFixed(2)),
      decode_ms: Number(decodeMs.toFixed(2)),
      peak_heap_bytes: Math.max(process.memoryUsage().heapUsed, heapBefore),
      node_version: process.version
    };
    console.log("H5-CTO-182-A scale_4096 performance:", JSON.stringify(report));
  }, 300_000);
});

/* ================================================================== */
/* 四、共同契約                                                        */
/* ================================================================== */

describe("H5-CTO-182-A Session Payload Codec V1：共同契約", () => {
  it("public_barrel：codec 自 2t 起公開、read 保持私有", () => {
    for (const name of [
      "P3E_SESSION_PAYLOAD_FORMAT_VERSION",
      "P3E_SESSION_PAYLOAD_MAX_LENGTH",
      "encodeP3ESessionPayload",
      "decodeP3ESessionPayload"
    ]) {
      expect(Object.keys(barrel), name).toContain(name);
    }
    expect(BARREL_SRC).toContain("./p3e-session-payload-codec");
    expect(Object.keys(barrel)).not.toContain("readP3ELedgerHistory");
  });

  it("architecture_required_tokens：必須重用五組正式原語", () => {
    for (const token of [
      "encodeP3EState",
      "decodeP3EState",
      "encodeP3ELedgerRecordPair",
      "decodeP3ELedgerRecordPair",
      "readP3ELedgerHistory",
      "normalizeSeed",
      "seedHash"
    ]) {
      expect(CODEC_CODE, `模組必須重用 ${token}`).toContain(token);
    }
  });

  it("architecture_forbidden_tokens：不得自建業務／hash／RNG／record 驗證／儲存／環境", () => {
    const forbidden = [
      // 業務邏輯（不得重複）。
      "resolveP3EAnnualPendingDecision",
      "resolveP3EDecisionChoice",
      "assembleP3EAnnualStateCoreDraft",
      "assembleP3EDecisionStateCoreDraft",
      "appendP3ELedgerTransition",
      "appendP3ELedgerHistory",
      "createP3ELedgerHistory",
      "drawP3ERollDeltas",
      "applyEventEffects",
      "executeP3ECommand",
      "createP3EGenesis",
      "createP3ECommandRecord",
      "createP3EYearLedgerRecord",
      "readP3ECommandRecord",
      "verifyP3EYearLedgerRecord",
      "verifyP3ECommandRecord",
      "validateP3ELedgerContinuity",
      "replayP3ELedgerHistory",
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
      // 資料模型污染物。
      "timestamp",
      "nonce",
      "saveId",
      "revision",
      "metadata",
      // 儲存／壓縮。
      "localStorage",
      "sessionStorage",
      "compress",
      "gzip",
      "base64",
      // 執行環境。
      "Date.now",
      "performance.now",
      "Math.random",
      "setTimeout",
      "setInterval",
      "XMLHttpRequest",
      "structuredClone",
      "eval"
    ];
    for (const token of forbidden) {
      expect(CODEC_CODE, `模組不得出現 ${token}`).not.toContain(token);
    }
  });

  it("五個 exports 固定；簽章與常數值；E_P3E_CODEC 是合法錯誤碼", () => {
    expect(Object.keys(codecModule).sort()).toEqual(
      [
        "P3E_SESSION_PAYLOAD_FORMAT_VERSION",
        "P3E_SESSION_PAYLOAD_MAX_LENGTH",
        "decodeP3ESessionPayload",
        "encodeP3ESessionPayload"
      ].sort()
    );
    expect(CODEC_SRC).toContain("export interface P3ESessionPayloadV1");
    expect(CODEC_SRC).toContain("export function encodeP3ESessionPayload(input: unknown): string");
    expect(CODEC_SRC).toContain("export function decodeP3ESessionPayload(input: unknown): P3ESessionPayloadV1");
    expect(CODEC_SRC).toContain("export const P3E_SESSION_PAYLOAD_FORMAT_VERSION = 6 as const");
    expect(CODEC_SRC).toContain("export const P3E_SESSION_PAYLOAD_MAX_LENGTH = 16_777_216");
    expect(codecModule.P3E_SESSION_PAYLOAD_FORMAT_VERSION).toBe(6);
    expect(codecModule.P3E_SESSION_PAYLOAD_MAX_LENGTH).toBe(16_777_216);
    expect(String(contracts.P3E_ERROR_CODES)).toContain("E_P3E_CODEC");
  });
});

/* ================================================================== */
/* 五、H5-CTO-182-A：正式整合專屬測試                                   */
/* ================================================================== */

describe("H5-CTO-182-A 正式整合", () => {
  it("formal_history_import_only：正式模組只 import 正式 ledger-history", () => {
    expect(CODEC_SRC).toContain('from "./ledger-history"');
    expect(CODEC_SRC).not.toMatch(/from\s+"[^"]*v1-candidate"/);
  });

  it("candidate_import_absent：正式檔案不再以 import 引用來源候選模組", () => {
    const testSource = readFileSync(
      join(ROOT, "packages/simulation/test/p3e-session-payload-codec.test.ts"),
      "utf8"
    );
    for (const source of [CODEC_SRC, testSource]) {
      expect(source).not.toMatch(/from\s+"[^"]*v1-candidate"/);
    }
  });
});
