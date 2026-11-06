import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gzip } from "pako";
import {
  buildPeerGroup,
  createBirthCertificate,
  validateDataPack,
  validateDeathPack,
  validateIdentityPack
} from "../../birth/src";
import {
  computeEventsChecksum,
  computePackChecksum,
  validateEventPack,
  type ValidatedEventPack
} from "../../engine/src";
import type { MoneyString, P3EHex64, P3ELifeState, P3EPhase, P3ERngState, SaveEnvelope } from "@life-sim/contracts";
import { MAX_COMPRESSED_BYTES, MAX_EXPANDED_BYTES, SaveError, decodeSave, encodeSave } from "../src";
import {
  P3E_SAVE_V6_FORMAT_VERSION,
  P3E_SAVE_V6_MAGIC,
  P3E_SAVE_V6_PAYLOAD_FORMAT,
  P3E_SAVE_V6_PAYLOAD_MAX_BYTES,
  createP3ESaveEnvelopeV6,
  decodeP3ESaveEnvelopeV6,
  encodeP3ESaveEnvelopeV6,
  encodeP3ESaveEnvelopeV6Compressed,
  validateP3ESaveEnvelopeV6
} from "../src/p3e-save-envelope-v6";
import * as envelopeModule from "../src/p3e-save-envelope-v6";
import { encodeP3ESessionPayload, decodeP3ESessionPayload } from "../../simulation/src/p3e-session-payload-codec";
import { createP3EGenesis } from "../../simulation/src/genesis";
import { createP3ECommandRecord, type P3ECommandRecord } from "../../simulation/src/command-record";
import { computeP3EYearChainHash, computeP3EYearEntryHash } from "../../simulation/src/year-ledger-hash";
import { computeP3EStateHash } from "../../simulation/src/state-hash";
import { executeP3ECommand } from "../../simulation/src/command-executor";
import { appendP3ELedgerHistory, createP3ELedgerHistory } from "../../simulation/src/ledger-history";
import { computeDeathDatasetChecksum, computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * H5-CTO-184-A：P3-E Save Envelope V6 正式測試。
 *
 * 來源：WorkBuddy 候選 `p3e-save-envelope-v6-candidate.test.ts`
 * （H5-CTO-184-A／-R1；SHA-256 `8abee5fd440fe32e79a8d598aa54dcc7026de133178d2b4aea612032aeee520f`，
 * 經 H5-CTO-184-A 正式整合；20 項來源測試依原順序保留）。
 *
 * 儲存層只搬運**不透明** payload：本檔的 payload 一律來自 session payload
 * 正式 codec（integration rule 允許測試用它做 handoff），儲存層自身
 * **不**解析／不驗證 payload 內容——roundtrip 的正確性由
 * 「decoded.payload === 原 wire（exact）」與 handoff 測試中
 * `decodeP3ESessionPayload` 的成功把關。
 *
 * fixtures 參照正式 p3e-session-payload-codec.test.ts（測試檔
 * 之間不可 import，否則 describe 會重複註冊）。birth／engine 以相對路徑
 * import（save 套件 production 依賴只有 contracts＋pako，不得改動；
 * birth／engine 原語僅作為測試基建，與 179-B 先例一致）：
 *
 * - **empty**：`genesisZero`（packNoCandidates＋zero-hazard 死亡包）＋空 History；
 * - **official 51**：正式 product path（seed `p3e-166-playable-runtime-v4`、
 *   untouched 官方 packs、106 命令、39 決策、age 67 死亡 2091）；
 * - **scale 4096**：51 真實 Pair＋合成 Pair 至 4096（HEX_C 鏈＋無循環回填
 *   的合成尾端）——canonical wire 約 9.5 MiB，作為 raw＋gzip 的 transport
 *   scale（壓縮後約 0.4 倍，低於 5 MiB 上限）。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const ENVELOPE_SRC = readFileSync(
  join(ROOT, "packages/save/src/p3e-save-envelope-v6.ts"),
  "utf8"
);
const ENVELOPE_CODE = ENVELOPE_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
const TEST_SRC = readFileSync(join(ROOT, "packages/save/test/p3e-save-envelope-v6.test.ts"), "utf8");

const CODE_INVALID = "E_SAVE_INVALID";
const CODE_UNSUPPORTED = "E_SAVE_UNSUPPORTED_VERSION";
const CODE_TOO_LARGE = "E_SAVE_TOO_LARGE";

type Dict = Record<string, unknown>;

/** 由 payload 快速建立合法 v6 信封（encode 系列收完整信封）。 */
const envOf = (payload: string) => createP3ESaveEnvelopeV6({ payload });

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

/** untouched p3b event pack：raw fixture 直接以公開原語驗證。 */
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
const peerGroup = buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never);
const certificate = createBirthCertificate(base, identityPack, peerGroup, SEED);

function certificateFor(seed: string): typeof certificate {
  if (seed === SEED) return certificate;
  const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
  return createBirthCertificate(base, identityPack, group, seed);
}

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

/** identity 探測 genesis（deathPackRepaired 要用 identity 找 mortality row）。 */
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

const genesisZero = createP3EGenesis(genesisInputOf(packNoCandidates, deathPackZeroHazard));
const genesisOfficial = createP3EGenesis(genesisInputOf(packNoCandidates, deathPackOfficial51));

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

/* ------------------------------ 輔助 ------------------------------- */

function execute(
  state: P3ELifeState,
  command: Dict,
  pack: ValidatedEventPack,
  death: typeof deathPack
): ReturnType<typeof executeP3ECommand> {
  return executeP3ECommand({ state, eventPack: pack, deathPack: death, command });
}

interface BuiltHistory {
  readonly ledger: unknown;
  readonly finalState: P3ELifeState;
}

/** 真實交易鏈：create + 逐命令 execute + append（與 live 完全同一路徑）。 */
function buildHistory(
  genesis: P3ELifeState,
  pack: ValidatedEventPack,
  death: typeof deathPack,
  commands: readonly Dict[]
): BuiltHistory {
  let ledger: unknown = createP3ELedgerHistory(genesis);
  let state: P3ELifeState = genesis;
  for (const command of commands) {
    const result = execute(state, command, pack, death);
    ledger = appendP3ELedgerHistory({
      history: ledger,
      previousState: state,
      commandRecord: result.commandRecord,
      yearRecord: result.yearRecord
    });
    state = result.state;
  }
  return { ledger, finalState: state };
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

function productPathCommands(
  genesis: P3ELifeState,
  pack: ValidatedEventPack,
  death: typeof deathPack
): Dict[] {
  const commands: Dict[] = [];
  let state: P3ELifeState = genesis;
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

/** 精確斷言：SaveError＋code，且不是 TypeError／RangeError／SyntaxError。 */
function expectSaveError(run: () => unknown, code: string): SaveError {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected SaveError ${code}`).toBeInstanceOf(SaveError);
  expect((caught as SaveError).code).toBe(code);
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
  expect(caught instanceof SyntaxError).toBe(false);
  return caught as SaveError;
}

/** genesis anchor（由 genesis 欄位獨立組出）。 */
function anchorOf(genesis: P3ELifeState): Dict {
  return {
    stateHash: genesis.stateHash,
    commandHeadHash: genesis.commandLog.headHash,
    chainHash: genesis.heads.hashChain
  };
}

/** 深拷貝一個（可能深層凍結的）state 為可變 Dict。 */
function mutableClone(state: P3ELifeState): Dict {
  return structuredClone(state) as unknown as Dict;
}

/* --------------------- 合成 Pair（正式 hash 原語） --------------------- */

const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);
const HEX_E = "e".repeat(64);

interface PairOptions {
  readonly index: number;
  readonly year: number;
  readonly age: number;
  readonly phase: P3EPhase;
  readonly stateHashBefore: string;
  readonly stateHashAfter: string;
  readonly prevCommandHash: string;
  readonly prevChainHash: string;
  readonly rngBefore: P3ERngState;
  readonly rngAfter: P3ERngState;
  readonly snapshotHash: string;
  readonly deltaHash: string;
  readonly command: unknown;
}

/** 用正式原語獨立算出 entry／command／chain hash，組出內部自洽的一對 Record。 */
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
  }) as P3EHex64;

  const commandRecord = createP3ECommandRecord({
    index: options.index,
    year: options.year,
    command: options.command,
    prevCommandHash: options.prevCommandHash,
    stateHashBefore: options.stateHashBefore,
    stateHashAfter: options.stateHashAfter,
    entryHash
  });

  const chainHash = computeP3EYearChainHash({
    prevChainHash: options.prevChainHash,
    index: options.index,
    year: options.year,
    entryHash,
    stateHashAfter: options.stateHashAfter,
    commandHash: commandRecord.commandHash
  }) as P3EHex64;

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

/* -------------------- session payload（handoff 來源） -------------------- */

/** 空 History 的合法 session payload wire（canonical）。 */
function emptyPayloadWire(): string {
  return encodeP3ESessionPayload({
    masterSeed: SEED,
    state: genesisZero,
    history: createP3ELedgerHistory(genesisZero)
  });
}

/** 正式 product path 的 51 命令 session payload wire（lazy、只建一次）。 */
let officialCache: { wire: string; finalState: P3ELifeState; ledger: unknown } | null = null;
function officialPayload(): { wire: string; finalState: P3ELifeState; ledger: unknown } {
  if (officialCache === null) {
    const genesisProduct = createP3EGenesis(genesisInputOf(eventPackOfficial, deathPack, SEED_OFFICIAL));
    const commands = productPathCommands(genesisProduct, eventPackOfficial, deathPack);
    const built = buildHistory(genesisProduct, eventPackOfficial, deathPack, commands);
    officialCache = {
      wire: encodeP3ESessionPayload({ masterSeed: SEED_OFFICIAL, state: built.finalState, history: built.ledger }),
      finalState: built.finalState,
      ledger: built.ledger
    };
  }
  return officialCache;
}

/** legacy format 3 信封（複製自 codec.test.ts）。 */
const legacyEnvelope: SaveEnvelope = {
  magic: "LIFE1",
  saveFormatVersion: 3,
  saveId: "save-1",
  revision: 1,
  writerSessionId: "writer-1",
  engineVersion: "0.1.0",
  rulesetVersion: "p1b-1",
  rngSpecVersion: "1.0.0",
  dataVersion: "2026.10",
  contentVersion: "p1b-content-0",
  helpPackVersion: "help-1",
  seed: "P1B-SAVE",
  seedHash: "a".repeat(64),
  rulesetSettings: { contentMode: "standard", autoChoicePolicy: "stop" },
  playback: { paused: false, speed: 4, progress: 0, openCardIds: [] },
  state: {
    schemaVersion: 1,
    year: 0,
    stats: { health: 500, happiness: 500, knowledge: 500, relationships: 500 },
    resource: "0" as MoneyString,
    flags: {},
    rngDraws: 0
  },
  rng: [1, 2, 3, 4],
  commandLog: [],
  stateHash: "0".repeat(64),
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  stats: { playSeconds: 0, years: 0, decisions: 0, autos: 0 }
};

/* ================================================================== */
/* 一、正向                                                            */
/* ================================================================== */

describe("H5-CTO-184-A Save Envelope V6：正向", () => {
  it("create_validate_encode_decode_raw：create → validate → encode → decode 全鏈", () => {
    const envelope = createP3ESaveEnvelopeV6({ payload: "opaque-payload" });
    expect(envelope.magic).toBe("LIFE1");
    expect(envelope.saveFormatVersion).toBe(6);
    expect(envelope.payloadFormat).toBe("p3e-session-payload-1");
    expect(envelope.payload).toBe("opaque-payload");

    // validate(create(...)) 恆等成立。
    const revalidated = validateP3ESaveEnvelopeV6(envelope);
    expect(stable(revalidated)).toBe(stable(envelope));

    // decode(encode(x)) 語意相等（新物件）。
    const raw = encodeP3ESaveEnvelopeV6(envOf("opaque-payload"));
    const decoded = decodeP3ESaveEnvelopeV6(raw);
    expect(stable(decoded)).toBe(stable(envelope));
    expect(decoded).not.toBe(envelope);

    // decode 也吃 gzip bytes。
    const compressed = encodeP3ESaveEnvelopeV6Compressed(envOf("opaque-payload"));
    const decodedCompressed = decodeP3ESaveEnvelopeV6(compressed);
    expect(stable(decodedCompressed)).toBe(stable(envelope));
  });

  it("compressed_roundtrip_and_deterministic_bytes：相同輸入 gzip byte-identical", () => {
    const input = envOf("determinism-check-payload");
    const a = encodeP3ESaveEnvelopeV6Compressed(input);
    const b = encodeP3ESaveEnvelopeV6Compressed(input);
    expect(a.length).toBe(b.length);
    expect(Array.from(a).every((byte, index) => byte === b[index])).toBe(true);
    // gzip header mtime 欄位為 0（byte 4–7）。
    expect(Array.from(a.slice(4, 8)).every((byte) => byte === 0)).toBe(true);
    const decoded = decodeP3ESaveEnvelopeV6(a);
    expect(decoded.payload).toBe("determinism-check-payload");
  });

  it("actual_empty_and_official_51_session_payload_handoff：真實 session payload 經信封 raw＋gzip 後可被 session codec 完整解回", () => {
    // (1) 空 History 的真實 payload。
    const emptyWire = emptyPayloadWire();
    for (const transport of [
      encodeP3ESaveEnvelopeV6(envOf(emptyWire)),
      encodeP3ESaveEnvelopeV6Compressed(envOf(emptyWire))
    ]) {
      const decoded = decodeP3ESaveEnvelopeV6(transport);
      expect(decoded.payload).toBe(emptyWire);
      const payload = decodeP3ESessionPayload(decoded.payload);
      expect(payload.formatVersion).toBe(6);
      expect(payload.masterSeed).toBe(SEED);
      expect((payload.history.records as unknown[]).length).toBe(0);
      expect(stable(payload.state)).toBe(stable(genesisZero));
    }

    // (2) 正式 product path 的 51 命令真實 payload（固定期望值把關）。
    const official = officialPayload();
    expect(official.finalState.phase).toBe("death");
    expect(official.finalState.age).toBe(67);
    expect(official.finalState.currentYear).toBe(2091);
    expect(official.finalState.stateHash).toBe(
      "14d594f9c31ad9b3eb7fee86015aec983511ea3bb93361427f6bb0cadb8531d8"
    );
    expect(((official.ledger as { records: unknown[] }).records).length).toBe(106);

    for (const transport of [
      encodeP3ESaveEnvelopeV6(envOf(official.wire)),
      encodeP3ESaveEnvelopeV6Compressed(envOf(official.wire))
    ]) {
      const decoded = decodeP3ESaveEnvelopeV6(transport);
      expect(decoded.payload).toBe(official.wire);
      const payload = decodeP3ESessionPayload(decoded.payload);
      expect(payload.masterSeed).toBe(SEED_OFFICIAL);
      expect(stable(payload.state)).toBe(stable(official.finalState));
      expect(stable(payload.history)).toBe(stable(official.ledger));
      expect((payload.history.records as unknown[]).length).toBe(106);
    }
  });

  it("canonical_envelope_key_order：固定欄位順序、無空白、無禁鍵", () => {
    const raw = encodeP3ESaveEnvelopeV6(envOf("abc"));
    const parsed = JSON.parse(raw) as Dict;
    expect(Object.keys(parsed)).toEqual(["magic", "saveFormatVersion", "payloadFormat", "payload"]);
    // 無空白：raw === 自己的重新序列化。
    expect(raw).toBe(JSON.stringify(parsed));
    // 禁鍵掃描。
    for (const bad of ["timestamp", "createdAt", "updatedAt", "saveId", "revision", "writerSessionId", "nonce", "metadata"]) {
      expect(Object.keys(parsed), bad).not.toContain(bad);
    }
    // decode 接受鍵序被重排的 JSON（exact 鍵集、順序不拘）。
    const reordered = JSON.stringify({
      payload: parsed.payload,
      payloadFormat: parsed.payloadFormat,
      saveFormatVersion: parsed.saveFormatVersion,
      magic: parsed.magic
    });
    expect(decodeP3ESaveEnvelopeV6(reordered).payload).toBe("abc");
  });

  it("deep_freeze_zero_share_no_input_mutation：輸出深層凍結、與輸入零共享、不修改輸入", () => {
    const input = { payload: "freeze-check" };
    const before = stable(input);

    const envelope = createP3ESaveEnvelopeV6(input);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(isDeepFrozen(envelope)).toBe(true);
    expect(stable(input)).toBe(before);

    const decoded = decodeP3ESaveEnvelopeV6(encodeP3ESaveEnvelopeV6(envelope));
    expect(isDeepFrozen(decoded)).toBe(true);
    expect(decoded).not.toBe(input);
    expect(sharesReference(decoded, input)).toBe(false);
    expect(stable(input)).toBe(before);
  });
});

/* ================================================================== */
/* 二、security                                                        */
/* ================================================================== */

describe("H5-CTO-184-A Save Envelope V6：security", () => {
  it("missing_extra_renamed_hidden_symbol_accessor_exotic_proto_revoked_proxy：物件輸入信任邊界矩陣", () => {
    const createInput = { payload: "abc" };
    const envelopeInput = {
      magic: P3E_SAVE_V6_MAGIC,
      saveFormatVersion: P3E_SAVE_V6_FORMAT_VERSION,
      payloadFormat: P3E_SAVE_V6_PAYLOAD_FORMAT,
      payload: "abc"
    };

    // 非 object 輸入。
    for (const bad of [null, undefined, 42, "abc", [], true]) {
      expectSaveError(() => createP3ESaveEnvelopeV6(bad), CODE_INVALID);
      expectSaveError(() => validateP3ESaveEnvelopeV6(bad), CODE_INVALID);
    }

    // 缺鍵。
    const missingCreate: Dict = {};
    expectSaveError(() => createP3ESaveEnvelopeV6(missingCreate), CODE_INVALID);
    const missingValidate: Dict = {
      magic: P3E_SAVE_V6_MAGIC,
      saveFormatVersion: P3E_SAVE_V6_FORMAT_VERSION,
      payloadFormat: P3E_SAVE_V6_PAYLOAD_FORMAT
    };
    expectSaveError(() => validateP3ESaveEnvelopeV6(missingValidate), CODE_INVALID);

    // 多鍵。
    expectSaveError(() => createP3ESaveEnvelopeV6({ ...createInput, extra: 1 }), CODE_INVALID);
    expectSaveError(() => validateP3ESaveEnvelopeV6({ ...envelopeInput, extra: 1 }), CODE_INVALID);

    // 改鍵（rename）。
    const renamedCreate: Dict = { payLoad: "abc" };
    expectSaveError(() => createP3ESaveEnvelopeV6(renamedCreate), CODE_INVALID);
    const renamedValidate: Dict = {};
    for (const key of Object.keys(envelopeInput)) {
      renamedValidate[`x-${key}`] = (envelopeInput as Dict)[key];
    }
    expectSaveError(() => validateP3ESaveEnvelopeV6(renamedValidate), CODE_INVALID);

    // 隱藏（不可列舉）額外欄位／隱藏必要欄位。
    const hiddenExtra = { ...createInput };
    Object.defineProperty(hiddenExtra, "extra", { value: 1, enumerable: false, writable: true, configurable: true });
    expectSaveError(() => createP3ESaveEnvelopeV6(hiddenExtra), CODE_INVALID);
    const hiddenRequired = { ...createInput };
    Object.defineProperty(hiddenRequired, "payload", { value: "abc", enumerable: false, writable: true, configurable: true });
    expectSaveError(() => createP3ESaveEnvelopeV6(hiddenRequired), CODE_INVALID);

    // symbol 鍵。
    const withSymbol = { ...createInput };
    Object.defineProperty(withSymbol, Symbol("x"), { value: 1, enumerable: true, writable: true, configurable: true });
    expectSaveError(() => createP3ESaveEnvelopeV6(withSymbol), CODE_INVALID);
    const validateWithSymbol = { ...envelopeInput };
    Object.defineProperty(validateWithSymbol, Symbol("y"), { value: 1, enumerable: true, writable: true, configurable: true });
    expectSaveError(() => validateP3ESaveEnvelopeV6(validateWithSymbol), CODE_INVALID);

    // exotic prototype（class instance）。
    class Payload {
      payload = "abc";
    }
    expectSaveError(() => createP3ESaveEnvelopeV6(new Payload()), CODE_INVALID);
    class Envelope {
      magic = P3E_SAVE_V6_MAGIC;
      saveFormatVersion = 6;
      payloadFormat = P3E_SAVE_V6_PAYLOAD_FORMAT;
      payload = "abc";
    }
    expectSaveError(() => validateP3ESaveEnvelopeV6(new Envelope()), CODE_INVALID);

    // revoked Proxy：反射失敗折成 E_SAVE_INVALID，決不外洩 TypeError。
    const revokedCreate = Proxy.revocable(createInput, {});
    revokedCreate.revoke();
    expectSaveError(() => createP3ESaveEnvelopeV6(revokedCreate.proxy), CODE_INVALID);
    const revokedValidate = Proxy.revocable(envelopeInput, {});
    revokedValidate.revoke();
    expectSaveError(() => validateP3ESaveEnvelopeV6(revokedValidate.proxy), CODE_INVALID);

    // 不一致 Proxy：ownKeys 回報鍵但 descriptor trap 回 undefined →
    // 鍵存在而 descriptor 缺失分支（E_SAVE_INVALID）。
    const inconsistentProxy = new Proxy({}, {
      ownKeys: () => ["payload"],
      getOwnPropertyDescriptor: () => undefined
    });
    expectSaveError(() => createP3ESaveEnvelopeV6(inconsistentProxy), CODE_INVALID);
    const inconsistentProxy4 = new Proxy({}, {
      ownKeys: () => ["magic", "saveFormatVersion", "payloadFormat", "payload"],
      getOwnPropertyDescriptor: () => undefined
    });
    expectSaveError(() => validateP3ESaveEnvelopeV6(inconsistentProxy4), CODE_INVALID);

    // null-prototype 的合法輸入可通過（proto === null 分支）。
    const nullProtoCreate: Dict = Object.create(null);
    nullProtoCreate.payload = "abc";
    expect(createP3ESaveEnvelopeV6(nullProtoCreate).payload).toBe("abc");
    const nullProtoValidate: Dict = Object.create(null);
    for (const key of Object.keys(envelopeInput)) {
      nullProtoValidate[key] = (envelopeInput as Dict)[key];
    }
    expect(validateP3ESaveEnvelopeV6(nullProtoValidate).payload).toBe("abc");
  });

  it("getter_execution_zero：accessor 直接拒絕、getter 永不執行", () => {
    let createCalls = 0;
    const withCreateGetter: Dict = {};
    Object.defineProperty(withCreateGetter, "payload", {
      get() {
        createCalls += 1;
        return "abc";
      },
      enumerable: true,
      configurable: true
    });
    expectSaveError(() => createP3ESaveEnvelopeV6(withCreateGetter), CODE_INVALID);
    expect(createCalls).toBe(0);

    let validateCalls = 0;
    const withValidateGetter: Dict = {};
    for (const key of ["magic", "saveFormatVersion", "payloadFormat", "payload"]) {
      Object.defineProperty(withValidateGetter, key, {
        get() {
          validateCalls += 1;
          return key === "magic" ? P3E_SAVE_V6_MAGIC : key === "saveFormatVersion" ? P3E_SAVE_V6_FORMAT_VERSION : key === "payloadFormat" ? P3E_SAVE_V6_PAYLOAD_FORMAT : "abc";
        },
        enumerable: true,
        configurable: true
      });
    }
    expectSaveError(() => validateP3ESaveEnvelopeV6(withValidateGetter), CODE_INVALID);
    expect(validateCalls).toBe(0);
  });

  // H5-CTO-184-A-R1 迴歸：值只取自 descriptor.value——get trap 永不執行；
  // 所有反射 trap 拋錯都折成 E_SAVE_INVALID，原生錯誤決不外洩。
  it("proxy_boundary_r1：get trap 永不執行；ownKeys／getPrototypeOf／getOwnPropertyDescriptor trap 拋錯折成 E_SAVE_INVALID 且無原生錯誤外洩", () => {
    // (1) 合法 descriptor＋拋錯的 get trap：成功且 getCalls === 0（create＋validate 兩路）。
    let getCalls = 0;
    const throwingGetHandler: ProxyHandler<Dict> = {
      get() {
        getCalls += 1;
        throw new Error("native-leak");
      }
    };
    const createProxy = new Proxy<Dict>({ payload: "abc" }, throwingGetHandler);
    expect(createP3ESaveEnvelopeV6(createProxy).payload).toBe("abc");
    const validateProxy = new Proxy<Dict>(
      {
        magic: P3E_SAVE_V6_MAGIC,
        saveFormatVersion: P3E_SAVE_V6_FORMAT_VERSION,
        payloadFormat: P3E_SAVE_V6_PAYLOAD_FORMAT,
        payload: "abc"
      },
      throwingGetHandler
    );
    expect(validateP3ESaveEnvelopeV6(validateProxy).payload).toBe("abc");
    expect(getCalls).toBe(0);

    // (2) 反射 trap 拋錯：全部摺成 E_SAVE_INVALID、無 TypeError／RangeError 等原生錯誤
    //     外洩（expectSaveError 同時斷言 SaveError 型別與精確錯誤碼）。
    const throwingTraps: ProxyHandler<Dict>[] = [
      { ownKeys() { throw new Error("native-leak"); } },
      { getPrototypeOf() { throw new Error("native-leak"); } },
      { getOwnPropertyDescriptor() { throw new Error("native-leak"); } }
    ];
    const envelopeShape = (): Dict => ({
      magic: P3E_SAVE_V6_MAGIC,
      saveFormatVersion: P3E_SAVE_V6_FORMAT_VERSION,
      payloadFormat: P3E_SAVE_V6_PAYLOAD_FORMAT,
      payload: "abc"
    });
    for (const handler of throwingTraps) {
      expectSaveError(() => createP3ESaveEnvelopeV6(new Proxy<Dict>({ payload: "abc" }, handler)), CODE_INVALID);
      expectSaveError(() => validateP3ESaveEnvelopeV6(new Proxy<Dict>(envelopeShape(), handler)), CODE_INVALID);
    }

    // (3) proxy 轉發的 accessor descriptor：拒絕且 getter 永不執行（create＋validate 兩路）。
    let accessorCalls = 0;
    const accessorTarget: Dict = {};
    Object.defineProperty(accessorTarget, "payload", {
      get() {
        accessorCalls += 1;
        return "abc";
      },
      enumerable: true,
      configurable: true
    });
    const accessorCreateProxy = new Proxy<Dict>(accessorTarget, {});
    expectSaveError(() => createP3ESaveEnvelopeV6(accessorCreateProxy), CODE_INVALID);
    expect(accessorCalls).toBe(0);

    let accessorValidateCalls = 0;
    const accessorValidateTarget: Dict = {};
    for (const key of ["magic", "saveFormatVersion", "payloadFormat", "payload"]) {
      Object.defineProperty(accessorValidateTarget, key, {
        get() {
          accessorValidateCalls += 1;
          return key === "magic" ? P3E_SAVE_V6_MAGIC : key === "saveFormatVersion" ? P3E_SAVE_V6_FORMAT_VERSION : key === "payloadFormat" ? P3E_SAVE_V6_PAYLOAD_FORMAT : "abc";
        },
        enumerable: true,
        configurable: true
      });
    }
    const accessorValidateProxy = new Proxy<Dict>(accessorValidateTarget, {});
    expectSaveError(() => validateP3ESaveEnvelopeV6(accessorValidateProxy), CODE_INVALID);
    expect(accessorValidateCalls).toBe(0);
  });

  it("malformed_JSON_and_malformed_UTF8：壞 JSON、不合法 UTF-8（raw 與 gzip 內）、截斷 gzip、非字串輸入", () => {
    // 非 string／Uint8Array。
    for (const bad of [null, undefined, 42, {}, [0x7b, 0x7d], true]) {
      expectSaveError(() => decodeP3ESaveEnvelopeV6(bad), CODE_INVALID);
    }

    // 壞 JSON。
    expectSaveError(() => decodeP3ESaveEnvelopeV6(""), CODE_INVALID);
    expectSaveError(() => decodeP3ESaveEnvelopeV6("{"), CODE_INVALID);
    expectSaveError(() => decodeP3ESaveEnvelopeV6("{\"magic\":\"LIFE1\""), CODE_INVALID);

    // 不合法 UTF-8（raw bytes）：0xff 不是任何合法 UTF-8 序列的起點。
    expectSaveError(() => decodeP3ESaveEnvelopeV6(new Uint8Array([0x7b, 0xff, 0x7d])), CODE_INVALID);

    // 不合法 UTF-8 藏在合法 gzip 內：inflate 成功、strict fatal decode 失敗。
    const gzippedBadUtf8 = gzip(new Uint8Array([0xff, 0xfe]));
    expectSaveError(() => decodeP3ESaveEnvelopeV6(gzippedBadUtf8), CODE_INVALID);

    // 截斷 gzip（有 magic 但不足 4 bytes 讀 ISIZE）。
    expectSaveError(() => decodeP3ESaveEnvelopeV6(new Uint8Array([0x1f, 0x8b, 0x08])), CODE_INVALID);

    // JSON 純量／陣列頂層（parse 成功但不是 exact 物件）。
    expectSaveError(() => decodeP3ESaveEnvelopeV6("42"), CODE_INVALID);
    expectSaveError(() => decodeP3ESaveEnvelopeV6("[]"), CODE_INVALID);
    expectSaveError(() => decodeP3ESaveEnvelopeV6("null"), CODE_INVALID);
  });

  it("wrong_magic_version_payloadFormat_and_payload_type：四欄逐一錯誤的精確歸因", () => {
    const base4 = {
      magic: P3E_SAVE_V6_MAGIC,
      saveFormatVersion: P3E_SAVE_V6_FORMAT_VERSION,
      payloadFormat: P3E_SAVE_V6_PAYLOAD_FORMAT,
      payload: "ok"
    };

    // magic 錯 → E_SAVE_INVALID。
    expectSaveError(() => validateP3ESaveEnvelopeV6({ ...base4, magic: "LIFE2" }), CODE_INVALID);
    expectSaveError(() => validateP3ESaveEnvelopeV6({ ...base4, magic: 42 }), CODE_INVALID);
    expectSaveError(
      () => decodeP3ESaveEnvelopeV6(JSON.stringify({ ...base4, magic: "LIFE2" })),
      CODE_INVALID
    );

    // saveFormatVersion 不是 6 → E_SAVE_UNSUPPORTED_VERSION（含非數字型別）。
    for (const bad of [5, 7, 3, "6", true, null]) {
      expectSaveError(() => validateP3ESaveEnvelopeV6({ ...base4, saveFormatVersion: bad }), CODE_UNSUPPORTED);
    }
    expectSaveError(
      () => decodeP3ESaveEnvelopeV6(JSON.stringify({ ...base4, saveFormatVersion: 3 })),
      CODE_UNSUPPORTED
    );

    // payloadFormat 錯 → E_SAVE_INVALID。
    expectSaveError(
      () => validateP3ESaveEnvelopeV6({ ...base4, payloadFormat: "p3e-session-payload-2" }),
      CODE_INVALID
    );
    expectSaveError(() => validateP3ESaveEnvelopeV6({ ...base4, payloadFormat: 42 }), CODE_INVALID);

    // payload 型別錯 → E_SAVE_INVALID（不解析、只查字串）。
    for (const bad of [42, null, {}, [], true]) {
      expectSaveError(() => validateP3ESaveEnvelopeV6({ ...base4, payload: bad }), CODE_INVALID);
      expectSaveError(() => createP3ESaveEnvelopeV6({ payload: bad }), CODE_INVALID);
    }

    // 污染鍵以文字插入（JSON.parse 之後 exact 鍵集檢查攔截）。
    const raw = encodeP3ESaveEnvelopeV6(envOf("ok"));
    expectSaveError(
      () => decodeP3ESaveEnvelopeV6(`${raw.slice(0, -1)},"__proto__":{"polluted":true}}`),
      CODE_INVALID
    );
  });

  it("raw_expanded_compressed_and_inner_payload_limits：20MiB raw／5MiB compressed／16MiB payload（含恰好 16MiB 邊界）", () => {
    // raw 輸入超過 20 MiB（非 gzip、parse 前拒絕）。
    expectSaveError(
      () => decodeP3ESaveEnvelopeV6(new Uint8Array(MAX_EXPANDED_BYTES + 1)),
      CODE_TOO_LARGE
    );
    expectSaveError(
      () => decodeP3ESaveEnvelopeV6(" ".repeat(MAX_EXPANDED_BYTES + 1)),
      CODE_TOO_LARGE
    );

    // gzip 輸入超過 5 MiB（inflate 前拒絕）。
    const gzipOverLimit = new Uint8Array(MAX_COMPRESSED_BYTES + 1);
    gzipOverLimit[0] = 0x1f;
    gzipOverLimit[1] = 0x8b;
    expectSaveError(() => decodeP3ESaveEnvelopeV6(gzipOverLimit), CODE_TOO_LARGE);

    // 內層 payload 超過 16 MiB（create／validate 兩側）。
    expectSaveError(() => createP3ESaveEnvelopeV6({ payload: "a".repeat(P3E_SAVE_V6_PAYLOAD_MAX_BYTES + 1) }), CODE_TOO_LARGE);
    const base4 = {
      magic: P3E_SAVE_V6_MAGIC,
      saveFormatVersion: P3E_SAVE_V6_FORMAT_VERSION,
      payloadFormat: P3E_SAVE_V6_PAYLOAD_FORMAT,
      payload: "a".repeat(P3E_SAVE_V6_PAYLOAD_MAX_BYTES + 1)
    };
    expectSaveError(() => validateP3ESaveEnvelopeV6(base4), CODE_TOO_LARGE);

    // encode raw 上限：payload ≤ 16 MiB，但 JSON 跳義（"→\"）使 raw 超過 20 MiB。
    const quoteEnvelope = createP3ESaveEnvelopeV6({ payload: '"'.repeat(P3E_SAVE_V6_PAYLOAD_MAX_BYTES) });
    expectSaveError(() => encodeP3ESaveEnvelopeV6(quoteEnvelope), CODE_TOO_LARGE);

    // encode compressed 上限：高熵（不可壓縮）payload → gzip 後超過 5 MiB。
    const entropy = randomBytes(8 * 1024 * 1024);
    const chars = new Array<string>(entropy.length);
    for (let i = 0; i < entropy.length; i++) chars[i] = String.fromCharCode(48 + ((entropy[i] ?? 0) % 64));
    const randomEnvelope = createP3ESaveEnvelopeV6({ payload: chars.join("") });
    expect(encodeP3ESaveEnvelopeV6(randomEnvelope).length).toBeLessThan(MAX_EXPANDED_BYTES);
    expectSaveError(() => encodeP3ESaveEnvelopeV6Compressed(randomEnvelope), CODE_TOO_LARGE);

    // decode 側：raw JSON 總長 < 20 MiB、payload > 16 MiB → TOO_LARGE。
    const crafted =
      '{"magic":"LIFE1","saveFormatVersion":6,"payloadFormat":"p3e-session-payload-1","payload":"' +
      "a".repeat(17 * 1024 * 1024) +
      '"}';
    expectSaveError(() => decodeP3ESaveEnvelopeV6(crafted), CODE_TOO_LARGE);

    // 恰好 16 MiB 的 payload 是合法邊界（raw＋gzip 全鏈 roundtrip）。
    const boundaryPayload = "a".repeat(P3E_SAVE_V6_PAYLOAD_MAX_BYTES);
    const boundaryRaw = encodeP3ESaveEnvelopeV6(envOf(boundaryPayload));
    expect(decodeP3ESaveEnvelopeV6(boundaryRaw).payload).toBe(boundaryPayload);
    const boundaryCompressed = encodeP3ESaveEnvelopeV6Compressed(envOf(boundaryPayload));
    expect(boundaryCompressed.length).toBeLessThan(MAX_COMPRESSED_BYTES);
    expect(decodeP3ESaveEnvelopeV6(boundaryCompressed).payload).toBe(boundaryPayload);
  });

  it("forged_ISIZE_and_actual_output_cap：偽造 ISIZE（過大／不實）與實際展開上限", () => {
    const compressed = encodeP3ESaveEnvelopeV6Compressed(envOf("x".repeat(1000)));

    // (a) 偽造 ISIZE > 20 MiB → inflate 前拒絕。
    const forgedLarge = new Uint8Array(compressed);
    new DataView(forgedLarge.buffer).setUint32(forgedLarge.length - 4, MAX_EXPANDED_BYTES + 1, true);
    expectSaveError(() => decodeP3ESaveEnvelopeV6(forgedLarge), CODE_TOO_LARGE);

    // (b) 偽造 ISIZE 為合法但不實的值 → inflate 成功但與實際長度不符 → E_SAVE_INVALID。
    const forgedWrong = new Uint8Array(compressed);
    new DataView(forgedWrong.buffer).setUint32(forgedWrong.length - 4, 999_999, true);
    expectSaveError(() => decodeP3ESaveEnvelopeV6(forgedWrong), CODE_INVALID);

    // (c) 實際展開上限：21 MiB 可壓縮內容、ISIZE 偽造成合法的 20 MiB →
    //     inflate 途中超過實際上限 → E_SAVE_TOO_LARGE（真正的 zip bomb 防護）。
    const bigRaw =
      '{"magic":"LIFE1","saveFormatVersion":6,"payloadFormat":"p3e-session-payload-1","payload":"' +
      "0".repeat(21 * 1024 * 1024) +
      '"}';
    const bigGzip = gzip(new TextEncoder().encode(bigRaw));
    expect(bigGzip.length).toBeLessThan(MAX_COMPRESSED_BYTES);
    const capped = new Uint8Array(bigGzip);
    new DataView(capped.buffer).setUint32(capped.length - 4, MAX_EXPANDED_BYTES, true);
    expectSaveError(() => decodeP3ESaveEnvelopeV6(capped), CODE_TOO_LARGE);
  });

  it("corrupt_concatenated_trailing_gzip：損壞／串接／尾端垃圾的 gzip 全部拒絕", () => {
    const compressed = encodeP3ESaveEnvelopeV6Compressed(envOf("y".repeat(2000)));

    // 損壞：翻轉 deflate 資料中段一個 byte（避開 10-byte header 與尾端 8 bytes）。
    const corrupt = new Uint8Array(compressed);
    const mid = Math.floor(corrupt.length / 2);
    const midValue = corrupt[mid];
    if (typeof midValue !== "number") throw new Error("corrupt buffer empty");
    corrupt[mid] = midValue ^ 0xff;
    expectSaveError(() => decodeP3ESaveEnvelopeV6(corrupt), CODE_INVALID);

    // 串接：兩個 gzip 成員接在一起 → inflateBounded 偵測殘餘輸入。
    const second = encodeP3ESaveEnvelopeV6Compressed(envOf("z".repeat(500)));
    const concatenated = new Uint8Array(compressed.length + second.length);
    concatenated.set(compressed, 0);
    concatenated.set(second, compressed.length);
    expectSaveError(() => decodeP3ESaveEnvelopeV6(concatenated), CODE_INVALID);

    // 尾端垃圾：合法成員後面接多餘 bytes。
    const trailing = new Uint8Array(compressed.length + 2);
    trailing.set(compressed, 0);
    trailing[compressed.length] = 0x00;
    trailing[compressed.length + 1] = 0x01;
    expectSaveError(() => decodeP3ESaveEnvelopeV6(trailing), CODE_INVALID);
  });

  it("legacy_format_3_not_accepted_by_v6_decoder：legacy 信封（22 欄、版本 3）被 v6 decoder 拒絕", () => {
    // 形狀檢查先於版本檢查 → exact 四欄不符 → E_SAVE_INVALID。
    expectSaveError(() => decodeP3ESaveEnvelopeV6(encodeSave(legacyEnvelope)), CODE_INVALID);
    expectSaveError(
      () => decodeP3ESaveEnvelopeV6(encodeSaveCompressedLegacy()),
      CODE_INVALID
    );
  });

  it("v6_not_accepted_by_legacy_decoder：v6 信封（4 欄）被 legacy decoder 拒絕", () => {
    const v6Input = envOf("opaque");
    expect(() => decodeSave(encodeP3ESaveEnvelopeV6(v6Input))).toThrow(SaveError);
    expect(() => decodeSave(encodeP3ESaveEnvelopeV6Compressed(v6Input))).toThrow(SaveError);
    expectSaveError(() => decodeSave(encodeP3ESaveEnvelopeV6(v6Input)), CODE_INVALID);
  });

  /** legacy 壓縮信封（用 pako 直接壓 legacy raw，避免動用 legacy 的 verify 路徑）。 */
  function encodeSaveCompressedLegacy(): Uint8Array {
    return gzip(new TextEncoder().encode(encodeSave(legacyEnvelope)));
  }
});

/* ================================================================== */
/* 三、scale：9.5MB canonical payload raw＋gzip roundtrip              */
/* ================================================================== */

describe("H5-CTO-184-A Save Envelope V6：scale", () => {
  it("scale_transport_9_52MB：4096 筆 canonical payload raw＋gzip exact roundtrip under limits、效能報告", () => {
    const commands: Dict[] = [];
    for (let step = 0; step < 51; step += 1) commands.push({ ...ADVANCE });
    const built = buildHistory(genesisOfficial, packNoCandidates, deathPackOfficial51, commands);
    const s51 = built.finalState;
    const realTailPair = ((built.ledger as { records: unknown[] }).records[50] as unknown as Dict);
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

    // 合成尾端 Pair（index 4096）：無循環回填順序組出 state。
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
    }) as P3EHex64;
    const stateS = mutableClone(s51);
    (stateS.heads as Dict).lastSnapshotHash = HEX_D;
    (stateS.heads as Dict).lastDeltaHash = HEX_E;
    (stateS.heads as Dict).lastEntryHash = tailEntryHash;
    (stateS.commandLog as Dict).count = 4096;
    const finalHash = computeP3EStateHash(stateS as unknown as P3ELifeState);
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

    // canonical session payload（約 9.5 MB）。
    const payloadWire = encodeP3ESessionPayload({
      masterSeed: SEED,
      state: stateS as unknown as P3ELifeState,
      history: { initial: anchorOf(genesisOfficial), records }
    });
    expect(payloadWire.length).toBeGreaterThan(1_000_000);
    expect(payloadWire.length).toBeLessThan(P3E_SAVE_V6_PAYLOAD_MAX_BYTES);

    // raw transport：encode／decode exact roundtrip。
    const rawStart = performance.now();
    const raw = encodeP3ESaveEnvelopeV6(envOf(payloadWire));
    const rawMs = performance.now() - rawStart;
    expect(new TextEncoder().encode(raw).length).toBeLessThan(MAX_EXPANDED_BYTES);
    const decodeStart = performance.now();
    const decodedRaw = decodeP3ESaveEnvelopeV6(raw);
    const decodeMs = performance.now() - decodeStart;
    expect(decodedRaw.payload).toBe(payloadWire);

    // gzip transport：encode／decode exact roundtrip under 5 MiB。
    const gzipStart = performance.now();
    const compressed = encodeP3ESaveEnvelopeV6Compressed(envOf(payloadWire));
    const gzipMs = performance.now() - gzipStart;
    expect(compressed.length).toBeLessThan(MAX_COMPRESSED_BYTES);
    const gunzipStart = performance.now();
    const decodedCompressed = decodeP3ESaveEnvelopeV6(compressed);
    const gunzipMs = performance.now() - gunzipStart;
    expect(decodedCompressed.payload).toBe(payloadWire);

    // 效能報告（work order 指定欄位）。
    const report = {
      raw_bytes: new TextEncoder().encode(raw).length,
      compressed_bytes: compressed.length,
      ratio: Number((compressed.length / new TextEncoder().encode(raw).length).toFixed(4)),
      encode_ms: Number((rawMs + gzipMs).toFixed(2)),
      decode_ms: Number((decodeMs + gunzipMs).toFixed(2)),
      peak_heap_bytes: process.memoryUsage().heapUsed,
      node_version: process.version
    };
    console.log("H5-CTO-184-A scale_transport performance:", JSON.stringify(report));
  }, 300_000);
});

/* ================================================================== */
/* 四、integration rule 與共同契約                                       */
/* ================================================================== */

describe("H5-CTO-184-A Save Envelope V6：integration rule 與共同契約", () => {
  it("production_src_has_zero_simulation_imports：正式 src 不 import 任何 simulation 路徑", () => {
    // 以去註解後的程式碼檢查（註解文字不受限）。
    expect(ENVELOPE_CODE.toLowerCase()).not.toContain("simulation");
    // 只 reuse save 套件內部與 pako。
    expect(ENVELOPE_CODE).toContain('from "pako"');
    expect(ENVELOPE_CODE).toContain('from "./errors"');
    expect(ENVELOPE_CODE).toContain('from "./envelope"');
    expect(ENVELOPE_CODE).toContain("inflateBounded");
    expect(ENVELOPE_CODE).toContain("MAX_EXPANDED_BYTES");
    expect(ENVELOPE_CODE).toContain("MAX_COMPRESSED_BYTES");
    expect(ENVELOPE_CODE).toContain("failSave");
  });

  it("test_may_use_session_payload_candidate_for_handoff_only：session payload codec 只以 encode/decode 兩個函式做 handoff", () => {
    // fixture 機制（genesis／executor／hash 原語）是測試基建，複製 live 路徑
    // （與 179-B 先例一致）；session payload codec 本體只准出現在
    // handoff——即只 import encodeP3ESessionPayload／decodeP3ESessionPayload。
    const match = TEST_SRC.match(
      /import\s+\{([^}]+)\}\s+from\s+"\.\.\/\.\.\/simulation\/src\/p3e-session-payload-codec";/
    );
    expect(match, "必須 import session payload codec").not.toBeNull();
    const rawNames = (match as RegExpMatchArray)[1] ?? "";
    const names = rawNames.split(",").map((name) => name.trim()).sort();
    expect(names).toEqual(["decodeP3ESessionPayload", "encodeP3ESessionPayload"]);
  });

  it("forbidden_fields：正式 src 不得出現任何被禁止的欄位名", () => {
    for (const bad of ["timestamp", "createdAt", "updatedAt", "saveId", "revision", "writerSessionId", "nonce", "metadata"]) {
      expect(ENVELOPE_CODE, `模組不得出現 ${bad}`).not.toContain(bad);
    }
  });

  it("九個 runtime exports 固定（interface 是 type-only）；簽章與常數值", () => {
    expect(Object.keys(envelopeModule).sort()).toEqual(
      [
        "P3E_SAVE_V6_FORMAT_VERSION",
        "P3E_SAVE_V6_MAGIC",
        "P3E_SAVE_V6_PAYLOAD_FORMAT",
        "P3E_SAVE_V6_PAYLOAD_MAX_BYTES",
        "createP3ESaveEnvelopeV6",
        "decodeP3ESaveEnvelopeV6",
        "encodeP3ESaveEnvelopeV6",
        "encodeP3ESaveEnvelopeV6Compressed",
        "validateP3ESaveEnvelopeV6"
      ].sort()
    );
    expect(ENVELOPE_SRC).toContain("export interface P3ESaveEnvelopeV6");
    expect(ENVELOPE_SRC).toContain('export const P3E_SAVE_V6_MAGIC = "LIFE1"');
    expect(ENVELOPE_SRC).toContain("export const P3E_SAVE_V6_FORMAT_VERSION = 6 as const");
    expect(ENVELOPE_SRC).toContain('export const P3E_SAVE_V6_PAYLOAD_FORMAT = "p3e-session-payload-1"');
    expect(ENVELOPE_SRC).toContain("export const P3E_SAVE_V6_PAYLOAD_MAX_BYTES = 16_777_216");
    expect(ENVELOPE_SRC).toContain("export function createP3ESaveEnvelopeV6(input: unknown): P3ESaveEnvelopeV6");
    expect(ENVELOPE_SRC).toContain("export function validateP3ESaveEnvelopeV6(input: unknown): P3ESaveEnvelopeV6");
    expect(ENVELOPE_SRC).toContain("export function encodeP3ESaveEnvelopeV6(input: unknown): string");
    expect(ENVELOPE_SRC).toContain("export function encodeP3ESaveEnvelopeV6Compressed(input: unknown): Uint8Array");
    expect(ENVELOPE_SRC).toContain("export function decodeP3ESaveEnvelopeV6(input: unknown): P3ESaveEnvelopeV6");
    expect(envelopeModule.P3E_SAVE_V6_MAGIC).toBe("LIFE1");
    expect(envelopeModule.P3E_SAVE_V6_FORMAT_VERSION).toBe(6);
    expect(envelopeModule.P3E_SAVE_V6_PAYLOAD_FORMAT).toBe("p3e-session-payload-1");
    expect(envelopeModule.P3E_SAVE_V6_PAYLOAD_MAX_BYTES).toBe(16_777_216);
  });
});

/* ================================================================== */
/* 五、H5-CTO-184-A：正式整合專屬測試                                   */
/* ================================================================== */

describe("H5-CTO-184-A 正式整合", () => {
  it("formal_module_path_only：正式模組與測試都指向正式路徑", () => {
    expect(TEST_SRC).toContain('from "../src/p3e-save-envelope-v6"');
    expect(TEST_SRC).toContain('join(ROOT, "packages/save/src/p3e-save-envelope-v6.ts")');
    expect(TEST_SRC).toContain('join(ROOT, "packages/save/test/p3e-save-envelope-v6.test.ts")');
  });

  it("candidate_path_absent：正式檔案不再以 import 或讀檔引用來源候選路徑", () => {
    for (const source of [ENVELOPE_SRC, TEST_SRC]) {
      expect(source).not.toMatch(/from\s+"[^"]*-candidate"/);
      expect(source).not.toMatch(/join\(ROOT, "[^"]*-candidate"/);
    }
  });
});
