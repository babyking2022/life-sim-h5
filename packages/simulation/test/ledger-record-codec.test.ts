import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { P3EHex64, P3EPhase, P3ERngState, P3EWordTuple } from "@life-sim/contracts";
import * as barrel from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { createP3ECommandRecord, readP3ECommandRecord, type P3ECommandRecord } from "../src/command-record";
import { computeP3EYearChainHash, computeP3EYearEntryHash } from "../src/year-ledger-hash";
import { createP3EYearLedgerRecord, type P3EYearLedgerRecord } from "../src/year-ledger-record";
import {
  decodeP3ELedgerRecordPair,
  encodeP3ELedgerRecordPair,
  P3E_LEDGER_PAIR_FORMAT_VERSION,
  P3E_LEDGER_PAIR_MAX_LENGTH,
  type P3ELedgerRecordPair
} from "../src/ledger-record-codec";

/**
 * P3-E.1b-2i：Ledger Record Pair 決定性 Codec。
 *
 * 期待值一律用**正式原語**獨立重算（`createP3ECommandRecord`／`createP3EYearLedgerRecord`／
 * `computeP3E*Hash`）；測試不重建任何 shape／hash 演算法。
 */

const ROOT = process.cwd();
const HEX = (char: string) => char.repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;

type Dict = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const words = (base: number): P3EWordTuple => [base, base + 1, base + 2, base + 3] as const;

function rngState(lifeDraws = 4, eventDraws = 8, deathDraws = 8): P3ERngState {
  return {
    life: { domain: "life", initialState: words(11), state: words(21), semanticDraws: lifeDraws },
    events: { domain: "events", initialState: words(31), state: words(41), u32Draws: eventDraws },
    death: { domain: "p3e/death", initialState: words(51), state: words(61), u32Draws: deathDraws }
  };
}

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;
const GUARDIAN = { type: "ADVANCE_YEAR", contentMode: "guardian" } as const;
const CHOOSE = { type: "CHOOSE_DECISION", optionId: "dec.opt.alpha" } as const;

interface Fixture {
  readonly pair: P3ELedgerRecordPair;
  readonly commandRecord: P3ECommandRecord;
  readonly yearRecord: P3EYearLedgerRecord;
}

interface FixtureOptions {
  readonly command?: unknown;
  readonly phase?: P3EPhase;
  readonly index?: number;
  readonly year?: number;
  readonly age?: number;
  readonly stateHashBefore?: string;
  readonly stateHashAfter?: string;
  readonly rngBefore?: P3ERngState;
  readonly rngAfter?: P3ERngState;
  readonly snapshotHash?: string;
  readonly deltaHash?: string;
  readonly prevChainHash?: string;
  readonly overrideEntryHash?: string;
}

/** 用正式原語組出一筆合法 Pair。 */
function fixture(options: FixtureOptions = {}): Fixture {
  const index = options.index ?? 1;
  const year = options.year ?? 2030;
  const age = options.age ?? 30;
  const phase: P3EPhase = options.phase ?? "life";
  const stateHashBefore = options.stateHashBefore ?? HEX("b");
  const stateHashAfter = options.stateHashAfter ?? HEX("c");
  const rngBefore = options.rngBefore ?? rngState();
  const rngAfter = options.rngAfter ?? rngState(5, 10, 10);
  const snapshotHash = options.snapshotHash ?? HEX("d");
  const deltaHash = options.deltaHash ?? HEX("e");
  const prevChainHash = options.prevChainHash ?? HEX("f");

  const entryHash = computeP3EYearEntryHash({
    index,
    year,
    age,
    phase,
    stateHashBefore,
    rngBefore,
    rngAfter,
    snapshotHash,
    deltaHash
  }) as P3EHex64;

  const commandRecord = createP3ECommandRecord({
    index,
    year,
    command: options.command ?? ADVANCE,
    prevCommandHash: HEX("a"),
    stateHashBefore,
    stateHashAfter,
    entryHash: options.overrideEntryHash ?? entryHash
  });

  const yearRecord = createP3EYearLedgerRecord({
    index,
    year,
    age,
    phase,
    stateHashBefore,
    stateHashAfter,
    rngBefore,
    rngAfter,
    snapshotHash,
    deltaHash,
    prevChainHash,
    commandRecord
  });

  return { pair: { commandRecord, yearRecord }, commandRecord, yearRecord };
}

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function expectCodecError(run: () => unknown, path: string): void {
  const caught = caughtFrom(run);
  expect(isP3EError(caught), `E_P3E_CODEC at ${path}`).toBe(true);
  const error = caught as P3EError;
  expect(error.code).toBe("E_P3E_CODEC");
  expect(error.path).toBe(path);
  expect(error.message).toBe(`E_P3E_CODEC at ${path}`);
  expect(caught instanceof SyntaxError).toBe(false);
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
}

function expectP3EError(run: () => unknown, code: string, path: string): void {
  const caught = caughtFrom(run);
  expect(isP3EError(caught), `${code} at ${path}`).toBe(true);
  const error = caught as P3EError;
  expect(error.code).toBe(code);
  expect(error.path).toBe(path);
  expect(caught instanceof SyntaxError).toBe(false);
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
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

const COMMAND_KEYS = [
  "index",
  "year",
  "command",
  "argsHash",
  "prevCommandHash",
  "stateHashBefore",
  "stateHashAfter",
  "entryHash",
  "commandHash"
] as const;
const YEAR_KEYS = [
  "index",
  "year",
  "age",
  "phase",
  "stateHashBefore",
  "stateHashAfter",
  "rngBefore",
  "rngAfter",
  "snapshotHash",
  "deltaHash",
  "entryHash",
  "commandHash",
  "prevChainHash",
  "chainHash"
] as const;

function parse(text: string): Dict {
  return JSON.parse(text) as Dict;
}

/* ------------------------------------------------------------------ */
/* 一、格式與 canonical 順序                                           */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2i 格式與 canonical 順序", () => {
  it("頂層 canonical 三欄、固定順序，formatVersion 固定", () => {
    const text = encodeP3ELedgerRecordPair(fixture().pair);
    expect(P3E_LEDGER_PAIR_FORMAT_VERSION).toBe("p3e-ledger-pair-1");
    const parsed = parse(text);
    expect(Object.keys(parsed)).toEqual(["formatVersion", "commandRecord", "yearRecord"]);
    expect(parsed.formatVersion).toBe("p3e-ledger-pair-1");
    expect(Object.keys(parsed.commandRecord as Dict)).toEqual([...COMMAND_KEYS]);
    expect(Object.keys(parsed.yearRecord as Dict)).toEqual([...YEAR_KEYS]);
  });

  it("Command 九欄的值與正式 Record 一致（ADVANCE_YEAR）", () => {
    const { pair, commandRecord } = fixture();
    const parsed = parse(encodeP3ELedgerRecordPair(pair));
    const command = parsed.commandRecord as Dict;
    expect(command.index).toBe(commandRecord.index);
    expect(command.year).toBe(commandRecord.year);
    expect(command.command).toEqual({ type: "ADVANCE_YEAR", contentMode: "standard" });
    for (const key of ["argsHash", "prevCommandHash", "stateHashBefore", "stateHashAfter", "entryHash", "commandHash"]) {
      expect(command[key]).toBe(commandRecord[key as keyof P3ECommandRecord]);
      expect(command[key] as string).toMatch(HEX64);
    }
  });

  it("Year 十四欄的值與正式 Record 一致，六個 RNG tuple 完整", () => {
    const { pair, yearRecord } = fixture();
    const parsed = parse(encodeP3ELedgerRecordPair(pair));
    const year = parsed.yearRecord as Dict;
    expect(year.index).toBe(yearRecord.index);
    expect(year.year).toBe(yearRecord.year);
    expect(year.age).toBe(yearRecord.age);
    expect(year.phase).toBe(yearRecord.phase);
    for (const key of ["stateHashBefore", "stateHashAfter", "snapshotHash", "deltaHash", "entryHash", "commandHash", "prevChainHash", "chainHash"]) {
      expect(year[key]).toBe(yearRecord[key as keyof P3EYearLedgerRecord]);
      expect(year[key] as string).toMatch(HEX64);
    }
    for (const side of ["rngBefore", "rngAfter"] as const) {
      const rng = year[side] as Dict;
      expect(Object.keys(rng)).toEqual(["life", "events", "death"]);
      for (const cursor of ["life", "events", "death"] as const) {
        const channel = rng[cursor] as Dict;
        expect(channel.initialState).toEqual([...yearRecord[side][cursor].initialState]);
        expect(channel.state).toEqual([...yearRecord[side][cursor].state]);
      }
      expect((rng.life as Dict).semanticDraws).toBe(yearRecord[side].life.semanticDraws);
      expect((rng.events as Dict).u32Draws).toBe(yearRecord[side].events.u32Draws);
      expect((rng.death as Dict).u32Draws).toBe(yearRecord[side].death.u32Draws);
      expect((rng.life as Dict).domain).toBe("life");
      expect((rng.events as Dict).domain).toBe("events");
      expect((rng.death as Dict).domain).toBe("p3e/death");
    }
  });

  it("三種命令與三種 phase 都能編碼", () => {
    for (const command of [ADVANCE, GUARDIAN, CHOOSE]) {
      const text = encodeP3ELedgerRecordPair(fixture({ command }).pair);
      const commandProj = parse(text).commandRecord as Dict;
      if (command === ADVANCE) expect(commandProj.command).toEqual({ type: "ADVANCE_YEAR", contentMode: "standard" });
      if (command === GUARDIAN) expect(commandProj.command).toEqual({ type: "ADVANCE_YEAR", contentMode: "guardian" });
      if (command === CHOOSE) expect(commandProj.command).toEqual({ type: "CHOOSE_DECISION", optionId: "dec.opt.alpha" });
    }
    for (const phase of ["life", "pending_decision", "death"] as const) {
      const parsed = parse(encodeP3ELedgerRecordPair(fixture({ phase }).pair));
      expect((parsed.yearRecord as Dict).phase).toBe(phase);
    }
  });

  it("同一 Pair 重複 encode 100 次 byte-identical", () => {
    const { pair } = fixture();
    const first = encodeP3ELedgerRecordPair(pair);
    for (let round = 0; round < 100; round += 1) {
      expect(encodeP3ELedgerRecordPair(pair)).toBe(first);
      expect(encodeP3ELedgerRecordPair({ commandRecord: pair.commandRecord, yearRecord: pair.yearRecord })).toBe(first);
    }
  });

  it("encode → decode → encode byte-identical，且 decode 深層凍結、零共享", () => {
    for (const command of [ADVANCE, GUARDIAN, CHOOSE]) {
      const { pair } = fixture({ command });
      const first = encodeP3ELedgerRecordPair(pair);
      const decoded = decodeP3ELedgerRecordPair(first);
      expect(encodeP3ELedgerRecordPair(decoded)).toBe(first);
      expect(decoded.commandRecord).toEqual(pair.commandRecord);
      expect(decoded.yearRecord).toEqual(pair.yearRecord);
      expect(isDeepFrozen(decoded)).toBe(true);
      expect(sharesReference(decoded, pair)).toBe(false);
      expect(decoded.commandRecord).not.toBe(pair.commandRecord);
      expect(decoded.yearRecord.rngBefore).not.toBe(pair.yearRecord.rngBefore);
      expect(() => {
        (decoded as { commandRecord: unknown }).commandRecord = null;
      }).toThrow(TypeError);
      expect(() => {
        (decoded.yearRecord as { chainHash: string }).chainHash = HEX("0");
      }).toThrow(TypeError);
    }
  });

  it("JSON 鍵序被打亂後 decode，再 encode 回 canonical 順序", () => {
    const { pair } = fixture();
    const canonical = encodeP3ELedgerRecordPair(pair);
    const parsed = parse(canonical);

    const shuffledYear: Dict = {};
    for (const key of [...YEAR_KEYS].reverse()) shuffledYear[key] = (parsed.yearRecord as Dict)[key];
    const shuffledCommand: Dict = {};
    for (const key of [...COMMAND_KEYS].reverse()) shuffledCommand[key] = (parsed.commandRecord as Dict)[key];
    const shuffled = JSON.stringify({
      yearRecord: shuffledYear,
      formatVersion: P3E_LEDGER_PAIR_FORMAT_VERSION,
      commandRecord: shuffledCommand
    });

    const decoded = decodeP3ELedgerRecordPair(shuffled);
    expect(encodeP3ELedgerRecordPair(decoded)).toBe(canonical);
  });
});

/* ------------------------------------------------------------------ */
/* 二、傳輸層與 top-level shape                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2i 傳輸層與 shape", () => {
  const canonical = (): string => encodeP3ELedgerRecordPair(fixture().pair);

  it("非字串／空字串／壞 JSON／超長 → E_P3E_CODEC at input", () => {
    for (const value of [42, null, undefined, {}, [], true, new String(canonical())]) {
      expectCodecError(() => decodeP3ELedgerRecordPair(value), "input");
    }
    expectCodecError(() => decodeP3ELedgerRecordPair(""), "input");
    expectCodecError(() => decodeP3ELedgerRecordPair("{"), "input");
    expectCodecError(() => decodeP3ELedgerRecordPair("not json"), "input");
    expect(P3E_LEDGER_PAIR_MAX_LENGTH).toBe(1_048_576);
    expectCodecError(() => decodeP3ELedgerRecordPair("x".repeat(P3E_LEDGER_PAIR_MAX_LENGTH + 1)), "input");
  });

  it("頂層缺欄／多欄／不是物件 → E_P3E_CODEC at ledgerPair", () => {
    const parsed = parse(canonical());
    for (const key of ["formatVersion", "commandRecord", "yearRecord"]) {
      const missing = { ...parsed };
      delete missing[key];
      expectCodecError(() => decodeP3ELedgerRecordPair(JSON.stringify(missing)), "ledgerPair");
    }
    expectCodecError(() => decodeP3ELedgerRecordPair(JSON.stringify({ ...parsed, extra: 1 })), "ledgerPair");
    expectCodecError(() => decodeP3ELedgerRecordPair("42"), "ledgerPair");
    expectCodecError(() => decodeP3ELedgerRecordPair("[]"), "ledgerPair");
    expectCodecError(() => decodeP3ELedgerRecordPair("null"), "ledgerPair");
  });

  it("未知／舊／大小寫錯誤 formatVersion → E_P3E_CODEC at formatVersion", () => {
    const parsed = parse(canonical());
    for (const formatVersion of [
      "p3e-ledger-pair-2",
      "p3e-ledger-pair-0",
      "p3e-ledger-pair",
      "P3E-LEDGER-PAIR-1",
      "p3e-state-1",
      "",
      42,
      null
    ]) {
      expectCodecError(() => decodeP3ELedgerRecordPair(JSON.stringify({ ...parsed, formatVersion })), "formatVersion");
    }
  });

  it("任意深度的 pollution keys → E_P3E_CODEC at input", () => {
    /** 用 defineProperty 建出「自有、可列舉」的 __proto__／constructor／prototype 鍵。 */
    const withPollutionKey = (target: Dict, key: string): Dict => {
      Object.defineProperty(target, key, { value: { x: 1 }, enumerable: true, configurable: true });
      return target;
    };

    // 第一層（頂層）
    const topLevel = withPollutionKey(parse(canonical()), "__proto__");
    expectCodecError(() => decodeP3ELedgerRecordPair(JSON.stringify(topLevel)), "input");

    // 第二層（commandRecord 內）
    const commandPolluted = parse(canonical());
    withPollutionKey(commandPolluted.commandRecord as Dict, "constructor");
    expectCodecError(() => decodeP3ELedgerRecordPair(JSON.stringify(commandPolluted)), "input");

    // 第三層（yearRecord.rngBefore 內）
    const deepPolluted = parse(canonical());
    withPollutionKey((deepPolluted.yearRecord as Dict).rngBefore as Dict, "prototype");
    expectCodecError(() => decodeP3ELedgerRecordPair(JSON.stringify(deepPolluted)), "input");

    // 第四層（RNG tuple 陣列的元素內）
    const arrayPolluted = parse(canonical());
    const tuple = (((arrayPolluted.yearRecord as Dict).rngAfter as Dict).life as Dict).state as unknown[];
    tuple.push(withPollutionKey({}, "__proto__"));
    expectCodecError(() => decodeP3ELedgerRecordPair(JSON.stringify(arrayPolluted)), "input");
  });

  it("encode 輸入的反射邊界：class 實例／symbol 鍵／不可列舉鍵", () => {
    const { pair } = fixture();

    class PairClass {
      readonly commandRecord = pair.commandRecord;
      readonly yearRecord = pair.yearRecord;
    }
    expectCodecError(() => encodeP3ELedgerRecordPair(new PairClass()), "ledgerPair");

    const withSymbol: Record<string | symbol, unknown> = { commandRecord: pair.commandRecord, yearRecord: pair.yearRecord };
    Object.defineProperty(withSymbol, Symbol("extra"), { value: 1, enumerable: false, configurable: true });
    expectCodecError(() => encodeP3ELedgerRecordPair(withSymbol), "ledgerPair");

    const withHidden: Dict = { commandRecord: pair.commandRecord, yearRecord: pair.yearRecord };
    Object.defineProperty(withHidden, "hiddenExtra", { value: 1, enumerable: false, configurable: true });
    expectCodecError(() => encodeP3ELedgerRecordPair(withHidden), "ledgerPair");
  });

  it("頂層鍵數相同但改名 → E_P3E_CODEC at ledgerPair", () => {
    const parsed = parse(encodeP3ELedgerRecordPair(fixture().pair));
    const renamed: Dict = {
      formatVersion: parsed.formatVersion,
      commandRecord: parsed.commandRecord,
      year: parsed.yearRecord
    };
    expect(Object.keys(renamed).length).toBe(3);
    expectCodecError(() => decodeP3ELedgerRecordPair(JSON.stringify(renamed)), "ledgerPair");
  });

  it("encode 的輸入必須是 exact-object 兩欄", () => {
    const { pair } = fixture();
    expectCodecError(() => encodeP3ELedgerRecordPair(null), "ledgerPair");
    expectCodecError(() => encodeP3ELedgerRecordPair([]), "ledgerPair");
    expectCodecError(() => encodeP3ELedgerRecordPair({ commandRecord: pair.commandRecord }), "ledgerPair");
    expectCodecError(() => encodeP3ELedgerRecordPair({ yearRecord: pair.yearRecord }), "ledgerPair");
    expectCodecError(() => encodeP3ELedgerRecordPair({ ...pair, formatVersion: P3E_LEDGER_PAIR_FORMAT_VERSION }), "ledgerPair");
    expectCodecError(
      () => encodeP3ELedgerRecordPair({ commandRecord: pair.commandRecord, yearRecord: pair.yearRecord, extra: 1 }),
      "ledgerPair"
    );
  });
});

/* ------------------------------------------------------------------ */
/* 三、錯誤邊界（正式錯誤原樣外露）                                    */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2i 錯誤邊界", () => {
  it("Command Record 自身錯誤保留 E_P3E_COMMAND", () => {
    const { pair } = fixture();
    const broken = structuredClone(pair.commandRecord) as unknown as Dict;
    broken.argsHash = HEX("9");
    expectP3EError(() => encodeP3ELedgerRecordPair({ commandRecord: broken, yearRecord: pair.yearRecord }), "E_P3E_COMMAND", "commandRecord.argsHash");
    expectP3EError(
      () => decodeP3ELedgerRecordPair(JSON.stringify({ formatVersion: P3E_LEDGER_PAIR_FORMAT_VERSION, commandRecord: broken, yearRecord: pair.yearRecord, })),
      "E_P3E_COMMAND",
      "commandRecord.argsHash"
    );
  });

  it("Year Record 或連結錯誤保留 E_P3E_HISTORY", () => {
    const { pair } = fixture();
    const brokenYear = structuredClone(pair.yearRecord) as unknown as Dict;
    brokenYear.chainHash = HEX("9");
    expectP3EError(
      () => encodeP3ELedgerRecordPair({ commandRecord: pair.commandRecord, yearRecord: brokenYear }),
      "E_P3E_HISTORY",
      "yearLedgerRecord.chainHash"
    );

    const otherYear = fixture({ year: 2031 }).yearRecord;
    expectP3EError(
      () => encodeP3ELedgerRecordPair({ commandRecord: pair.commandRecord, yearRecord: otherYear }),
      "E_P3E_HISTORY",
      "yearLedgerRecord.commandRecord"
    );
  });

  it("Command Record 每個 hash 被竄改都被正式驗證器拒絕", () => {
    const { pair } = fixture();
    for (const key of ["argsHash", "prevCommandHash", "stateHashBefore", "stateHashAfter", "entryHash", "commandHash"]) {
      const broken = structuredClone(pair.commandRecord) as unknown as Dict;
      broken[key] = HEX("9");
      const caught = caughtFrom(() =>
        encodeP3ELedgerRecordPair({ commandRecord: broken, yearRecord: pair.yearRecord })
      );
      expect(isP3EError(caught), key).toBe(true);
      expect((caught as P3EError).code).toBe("E_P3E_COMMAND");
    }
  });

  it("Year Record 每個 hash 被竄改都被正式驗證器拒絕", () => {
    const { pair } = fixture();
    for (const key of [
      "stateHashBefore",
      "stateHashAfter",
      "snapshotHash",
      "deltaHash",
      "entryHash",
      "commandHash",
      "prevChainHash",
      "chainHash"
    ]) {
      const broken = structuredClone(pair.yearRecord) as unknown as Dict;
      broken[key] = HEX("9");
      const caught = caughtFrom(() =>
        encodeP3ELedgerRecordPair({ commandRecord: pair.commandRecord, yearRecord: broken })
      );
      expect(isP3EError(caught), key).toBe(true);
      expect((caught as P3EError).code).toBe("E_P3E_HISTORY");
    }
  });

  it("index／year／前後 stateHash／entryHash／commandHash 交叉連結不一致 → 拒絕", () => {
    const base = fixture();
    const others = [
      fixture({ index: 2 }),
      fixture({ year: 2031 }),
      fixture({ stateHashBefore: HEX("9") }),
      fixture({ stateHashAfter: HEX("9") }),
      fixture({ command: CHOOSE })
    ];
    for (const other of others) {
      const caught = caughtFrom(() =>
        encodeP3ELedgerRecordPair({ commandRecord: other.commandRecord, yearRecord: base.yearRecord })
      );
      expect(isP3EError(caught)).toBe(true);
      expect((caught as P3EError).code).toBe("E_P3E_HISTORY");
    }
  });

  it("各自自洽但 entryHash 交叉連結不同的偽造 Pair → 正式 verifier 仍拒絕", () => {
    const base = fixture();
    // 另一份「完全合法、可通過 readP3ECommandRecord」的 Command Record：
    // index／year／前後 stateHash 完全相同，但 entryHash 指向另一個合法 hex。
    const forgedCommand = createP3ECommandRecord({
      index: base.commandRecord.index,
      year: base.commandRecord.year,
      command: ADVANCE,
      prevCommandHash: HEX("a"),
      stateHashBefore: base.commandRecord.stateHashBefore,
      stateHashAfter: base.commandRecord.stateHashAfter,
      entryHash: HEX("9")
    });
    expect(() => readP3ECommandRecord(forgedCommand)).not.toThrow();
    expect(forgedCommand.entryHash).not.toBe(base.commandRecord.entryHash);

    // Year Record 只把 commandHash 同步成偽造值，entryHash 仍是自己算出來的正確值，
    // 再用新的 commandHash 重算 chainHash → 兩份紀錄各自完全自洽。
    const forgedYear: Dict = {
      ...structuredClone(base.yearRecord),
      commandHash: forgedCommand.commandHash
    };
    forgedYear.chainHash = computeP3EYearChainHash({
      prevChainHash: base.yearRecord.prevChainHash,
      index: base.yearRecord.index,
      year: base.yearRecord.year,
      entryHash: base.yearRecord.entryHash,
      stateHashAfter: base.yearRecord.stateHashAfter,
      commandHash: forgedCommand.commandHash
    });

    // 唯一的不一致就是「Command Record 的 entryHash ≠ Year Record 重算的 entryHash」
    expectP3EError(
      () => encodeP3ELedgerRecordPair({ commandRecord: forgedCommand, yearRecord: forgedYear }),
      "E_P3E_HISTORY",
      "yearLedgerRecord.commandRecord"
    );
  });

  it("encode 輸入中的 getter 永不執行", () => {
    const { pair } = fixture();
    let invoked = 0;
    const withGetter: Dict = { commandRecord: pair.commandRecord };
    Object.defineProperty(withGetter, "yearRecord", {
      enumerable: true,
      configurable: true,
      get() {
        invoked += 1;
        return pair.yearRecord;
      }
    });
    expectCodecError(() => encodeP3ELedgerRecordPair(withGetter), "ledgerPair");
    expect(invoked).toBe(0);
  });

  it("revoked Proxy 不外洩原生例外", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectCodecError(() => encodeP3ELedgerRecordPair(revoked.proxy), "ledgerPair");
    const { pair } = fixture();
    expectP3EError(
      () => encodeP3ELedgerRecordPair({ commandRecord: pair.commandRecord, yearRecord: revoked.proxy }),
      "E_P3E_HISTORY",
      "yearLedgerRecord"
    );
  });
});

/* ------------------------------------------------------------------ */
/* 四、公開表面與靜態檢查                                              */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2i 公開表面與靜態檢查", () => {
  const source = readFileSync(join(ROOT, "packages/simulation/src/ledger-record-codec.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

  it("不進公開 barrel", () => {
    expect(typeof encodeP3ELedgerRecordPair).toBe("function");
    expect(typeof decodeP3ELedgerRecordPair).toBe("function");
    const surface = barrel as unknown as Record<string, unknown>;
    expect(surface.encodeP3ELedgerRecordPair).toBeUndefined();
    expect(surface.decodeP3ELedgerRecordPair).toBeUndefined();
    expect(surface.P3E_LEDGER_PAIR_FORMAT_VERSION).toBeUndefined();
    expect(surface.P3E_LEDGER_PAIR_MAX_LENGTH).toBeUndefined();
    const barrelSource = readFileSync(join(ROOT, "packages/simulation/src/index.ts"), "utf8");
    expect(barrelSource).not.toContain("ledger-record-codec");
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("無時間／隨機／append／seal／execute／replay", () => {
    for (const token of [
      "Math.random",
      "Date.now",
      "performance.now",
      "new Date",
      "append",
      "sealP3EState",
      "readP3EState",
      "execute",
      "replay",
      "computeP3EStateHash",
      "computeP3ECommandHash",
      "computeP3EYearEntryHash",
      "computeP3EYearChainHash"
    ]) {
      expect(code, token).not.toContain(token);
    }
    // 只透過既有正式原語
    expect(code).toContain("readP3ECommandRecord");
    expect(code).toContain("verifyP3EYearLedgerRecord");
    // 不把原始輸入丟給 JSON.stringify（只有 projection 會被序列化）
    expect(code).toContain("JSON.stringify({");
    expect(code).not.toContain("JSON.stringify(input");
    expect(code).not.toContain("JSON.stringify(raw");
  });

  it("只匯出格式常數、型別與兩個入口", () => {
    const exported = [...source.matchAll(/^export (?:function|type|interface|const) (\w+)/gm)].map((match) => match[1]);
    expect(exported.sort()).toEqual(
      [
        "P3E_LEDGER_PAIR_FORMAT_VERSION",
        "P3E_LEDGER_PAIR_MAX_LENGTH",
        "P3ELedgerPairFormatVersion",
        "P3ELedgerRecordPair",
        "decodeP3ELedgerRecordPair",
        "encodeP3ELedgerRecordPair"
      ].sort()
    );
  });
});
