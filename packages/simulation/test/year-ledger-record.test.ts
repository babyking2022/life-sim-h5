import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { P3EHex64, P3EPhase, P3ERngState, P3EWordTuple } from "@life-sim/contracts";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import {
  computeP3ECommandHash,
  computeP3EYearChainHash,
  computeP3EYearEntryHash
} from "../src/year-ledger-hash";
import { createP3ECommandRecord, readP3ECommandRecord, type P3ECommandRecord } from "../src/command-record";
import {
  createP3EYearLedgerRecord,
  verifyP3EYearLedgerRecord,
  type P3EYearLedgerRecord
} from "../src/year-ledger-record";

/**
 * P3-E.1b-2d：Year Ledger Record 建立與 Command 連結驗證。
 *
 * 期望值一律用正式 `computeP3EYearEntryHash`／`computeP3EYearChainHash` 獨立重算，
 * 不用被測函式自己的輸出當答案。
 */

const ROOT = process.cwd();
const HEX64 = /^[0-9a-f]{64}$/;

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);
const HEX_E = "e".repeat(64);
const HEX_F = "f".repeat(64);
const HEX_9 = "9".repeat(64);

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
  readonly yearInput: Dict;
  readonly commandRecord: P3ECommandRecord;
  readonly entryHash: P3EHex64;
  readonly chainHash: P3EHex64;
}

interface FixtureOptions {
  readonly command?: unknown;
  readonly index?: number;
  readonly year?: number;
  readonly age?: number;
  readonly phase?: P3EPhase;
  readonly stateHashBefore?: string;
  readonly stateHashAfter?: string;
  readonly rngBefore?: P3ERngState;
  readonly rngAfter?: P3ERngState;
  readonly snapshotHash?: string;
  readonly deltaHash?: string;
  readonly prevChainHash?: string;
  readonly overrideEntryHash?: string;
  readonly overrideCommandHash?: string;
}

/** 用正式原語獨立算出 entry／chain hash，再組出合法的 Command Record 與 Year 輸入。 */
function fixture(options: FixtureOptions = {}): Fixture {
  const index = options.index ?? 1;
  const year = options.year ?? 2030;
  const age = options.age ?? 30;
  const phase: P3EPhase = options.phase ?? "life";
  const stateHashBefore = options.stateHashBefore ?? HEX_B;
  const stateHashAfter = options.stateHashAfter ?? HEX_C;
  const rngBefore = options.rngBefore ?? rngState();
  const rngAfter = options.rngAfter ?? rngState(5, 10, 10);
  const snapshotHash = options.snapshotHash ?? HEX_D;
  const deltaHash = options.deltaHash ?? HEX_E;
  const prevChainHash = options.prevChainHash ?? HEX_F;

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
    prevCommandHash: HEX_A,
    stateHashBefore,
    stateHashAfter,
    entryHash: options.overrideEntryHash ?? entryHash
  });

  const commandHash = options.overrideCommandHash ?? commandRecord.commandHash;
  const chainHash = computeP3EYearChainHash({
    prevChainHash,
    index,
    year,
    entryHash,
    stateHashAfter,
    commandHash
  }) as P3EHex64;

  return {
    yearInput: {
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
    },
    commandRecord,
    entryHash,
    chainHash
  };
}

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function expectHistoryError(run: () => unknown, path: string): void {
  const caught = caughtFrom(run);
  expect(isP3EError(caught), `E_P3E_HISTORY at ${path}`).toBe(true);
  const error = caught as P3EError;
  expect(error.code).toBe("E_P3E_HISTORY");
  expect(error.path).toBe(path);
  expect(error.message).toBe(`E_P3E_HISTORY at ${path}`);
  expect(error.name).toBe("P3EError");
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  const record = value as Dict;
  return Object.keys(record).every((key) => isDeepFrozen(record[key]));
}

/** 把已建立的 Record 複製成可竄改的普通物件。 */
function mutable(record: P3EYearLedgerRecord): Dict {
  return structuredClone(record) as unknown as Dict;
}

function verifyOf(record: unknown, commandRecord: unknown): unknown {
  return verifyP3EYearLedgerRecord({ record, commandRecord });
}

/* ------------------------------------------------------------------ */
/* 一、建立與驗證                                                      */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2d 建立與驗證", () => {
  it("ADVANCE_YEAR／standard：十四欄與獨立重算一致", () => {
    const { yearInput, entryHash, chainHash, commandRecord } = fixture();
    const record = createP3EYearLedgerRecord(yearInput);

    expect(Object.keys(record).sort()).toEqual([
      "age",
      "chainHash",
      "commandHash",
      "deltaHash",
      "entryHash",
      "index",
      "phase",
      "prevChainHash",
      "rngAfter",
      "rngBefore",
      "snapshotHash",
      "stateHashAfter",
      "stateHashBefore",
      "year"
    ]);
    expect(record.index).toBe(1);
    expect(record.year).toBe(2030);
    expect(record.age).toBe(30);
    expect(record.phase).toBe("life");
    expect(record.entryHash).toBe(entryHash);
    expect(record.commandHash).toBe(commandRecord.commandHash);
    expect(record.chainHash).toBe(chainHash);

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
      expect(record[key as keyof P3EYearLedgerRecord] as string).toMatch(HEX64);
    }
  });

  it("ADVANCE_YEAR／guardian 與 CHOOSE_DECISION", () => {
    const guardian = createP3EYearLedgerRecord(fixture({ command: GUARDIAN }).yearInput);
    const standard = createP3EYearLedgerRecord(fixture().yearInput);
    expect(guardian.commandHash).not.toBe(standard.commandHash);
    expect(guardian.chainHash).not.toBe(standard.chainHash);

    const choose = fixture({ command: CHOOSE });
    const chooseRecord = createP3EYearLedgerRecord(choose.yearInput);
    expect(chooseRecord.commandHash).toBe(choose.commandRecord.commandHash);
    expect(chooseRecord.entryHash).toBe(choose.entryHash);
    expect(chooseRecord.chainHash).toBe(choose.chainHash);
  });

  it("phase life／pending_decision／death 都可用", () => {
    const hashes = new Set<string>();
    for (const phase of ["life", "pending_decision", "death"] as const) {
      const f = fixture({ phase });
      const record = createP3EYearLedgerRecord(f.yearInput);
      expect(record.phase).toBe(phase);
      expect(record.entryHash).toBe(f.entryHash);
      hashes.add(record.entryHash);
    }
    expect(hashes.size).toBe(3);
  });

  it("100 次建立結果一致", () => {
    const f = fixture();
    const first = createP3EYearLedgerRecord(f.yearInput);
    for (let round = 0; round < 100; round += 1) {
      expect(createP3EYearLedgerRecord(structuredClone(f.yearInput))).toEqual(first);
    }
  });

  it("create → verify round-trip 完全相等", () => {
    for (const command of [ADVANCE, GUARDIAN, CHOOSE]) {
      const f = fixture({ command });
      const created = createP3EYearLedgerRecord(f.yearInput);
      const verified = verifyP3EYearLedgerRecord({ record: created, commandRecord: f.commandRecord });
      expect(verified).toEqual(created);
      expect(verified.rngBefore).toEqual(created.rngBefore);
      expect(verified.rngAfter).toEqual(created.rngAfter);
      expect(isDeepFrozen(verified)).toBe(true);
    }
  });

  it("輸入不修改；輸出與六個 RNG tuple 深層凍結、零共享", () => {
    const f = fixture();
    const input = f.yearInput;
    const before = structuredClone(input);
    const record = createP3EYearLedgerRecord(input);

    expect(input).toEqual(before);
    expect(record).not.toBe(input);
    expect(record.rngBefore).not.toBe(input.rngBefore);
    expect(record.rngBefore.life).not.toBe((input.rngBefore as P3ERngState).life);
    expect(isDeepFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.rngBefore.life.initialState)).toBe(true);
    expect(Object.isFrozen(record.rngBefore.life.state)).toBe(true);
    expect(Object.isFrozen(record.rngBefore.events.state)).toBe(true);
    expect(Object.isFrozen(record.rngBefore.death.state)).toBe(true);
    expect(Object.isFrozen(record.rngAfter.life.state)).toBe(true);

    expect(() => {
      (record as { index: number }).index = 2;
    }).toThrow(TypeError);
    expect(() => {
      (record.rngBefore.life.state as unknown as number[])[0] = 0;
    }).toThrow(TypeError);
  });
});

/* ------------------------------------------------------------------ */
/* 二、十四欄逐欄竄改                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2d 十四欄逐欄竄改", () => {
  const base = fixture({});
  const record = createP3EYearLedgerRecord(base.yearInput);

  it("index／year／stateHashBefore／stateHashAfter／commandHash → 連結不一致", () => {
    const cases: readonly [string, (draft: Dict) => void][] = [
      ["index", (draft) => { draft.index = 2; }],
      ["year", (draft) => { draft.year = 2031; }],
      ["stateHashBefore", (draft) => { draft.stateHashBefore = HEX_9; }],
      ["stateHashAfter", (draft) => { draft.stateHashAfter = HEX_9; }],
      ["commandHash", (draft) => { draft.commandHash = HEX_9; }]
    ];
    for (const [label, change] of cases) {
      const draft = mutable(record);
      change(draft);
      expectHistoryError(() => verifyOf(draft, base.commandRecord), "yearLedgerRecord.commandRecord");
      expect(label).toBe(label);
    }
  });

  it("age／phase／snapshotHash／deltaHash／entryHash → entryHash 不一致", () => {
    const cases: readonly [string, (draft: Dict) => void][] = [
      ["age", (draft) => { draft.age = 31; }],
      ["phase", (draft) => { draft.phase = "death"; }],
      ["snapshotHash", (draft) => { draft.snapshotHash = HEX_9; }],
      ["deltaHash", (draft) => { draft.deltaHash = HEX_9; }],
      ["entryHash", (draft) => { draft.entryHash = HEX_9; }]
    ];
    for (const [label, change] of cases) {
      const draft = mutable(record);
      change(draft);
      expectHistoryError(() => verifyOf(draft, base.commandRecord), "yearLedgerRecord.entryHash");
      expect(label).toBe(label);
    }
  });

  it("prevChainHash／chainHash → chainHash 不一致", () => {
    const prev = mutable(record);
    prev.prevChainHash = HEX_9;
    expectHistoryError(() => verifyOf(prev, base.commandRecord), "yearLedgerRecord.chainHash");

    const chain = mutable(record);
    chain.chainHash = HEX_9;
    expectHistoryError(() => verifyOf(chain, base.commandRecord), "yearLedgerRecord.chainHash");
  });

  it("rngBefore／rngAfter：每條游標、每個 tuple 字位、draws", () => {
    for (const side of ["rngBefore", "rngAfter"] as const) {
      for (const cursor of ["life", "events", "death"] as const) {
        for (const tuple of ["initialState", "state"] as const) {
          for (let position = 0; position < 4; position += 1) {
            const draft = mutable(record);
            const channel = (draft[side] as Dict)[cursor] as Dict;
            const current = (channel[tuple] as number[])[position] as number;
            (channel[tuple] as number[])[position] = current + 1;
            expectHistoryError(() => verifyOf(draft, base.commandRecord), "yearLedgerRecord.entryHash");
          }
        }
      }
      const drawsKey = side === "rngBefore" ? "life" : "events";
      const draft = mutable(record);
      const channel = (draft[side] as Dict)[drawsKey] as Dict;
      const key = drawsKey === "life" ? "semanticDraws" : "u32Draws";
      const current = channel[key] as number;
      channel[key] = current + 1;
      expectHistoryError(() => verifyOf(draft, base.commandRecord), "yearLedgerRecord.entryHash");
    }
  });

  it("rng 本身不合法 → rngBefore／rngAfter 的固定 path", () => {
    const bad = mutable(record);
    (bad.rngBefore as Dict).life = { domain: "life", initialState: words(11), state: [0, 0, 0, 0], semanticDraws: 4 };
    expectHistoryError(() => verifyOf(bad, base.commandRecord), "yearLedgerRecord.rngBefore");

    const bad2 = mutable(record);
    (bad2.rngAfter as Dict).events = { domain: "events", initialState: words(31), state: words(41), u32Draws: -1 };
    expectHistoryError(() => verifyOf(bad2, base.commandRecord), "yearLedgerRecord.rngAfter");
  });
});

/* ------------------------------------------------------------------ */
/* 三、Command 連結反例                                                */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2d Command 連結", () => {
  it("index／year／stateHashBefore／stateHashAfter／entryHash／commandHash 任一不同 → 拒絕", () => {
    const base = fixture();
    const record = createP3EYearLedgerRecord(base.yearInput);

    const otherIndex = fixture({ index: 2 });
    expectHistoryError(
      () => verifyOf(record, otherIndex.commandRecord),
      "yearLedgerRecord.commandRecord"
    );

    const otherYear = fixture({ year: 2031 });
    expectHistoryError(() => verifyOf(record, otherYear.commandRecord), "yearLedgerRecord.commandRecord");

    const otherBefore = fixture({ stateHashBefore: HEX_9 });
    expectHistoryError(() => verifyOf(record, otherBefore.commandRecord), "yearLedgerRecord.commandRecord");

    const otherAfter = fixture({ stateHashAfter: HEX_9 });
    expectHistoryError(() => verifyOf(record, otherAfter.commandRecord), "yearLedgerRecord.commandRecord");

    // Command Record 的 entryHash 與 Year Record 算出來的不同 → yearLedgerRecord.entryHash
    const otherEntry = fixture({ command: CHOOSE });
    expectHistoryError(() => verifyOf(record, otherEntry.commandRecord), "yearLedgerRecord.commandRecord");

    // 同一個 entryHash 但 commandHash 不同
    const mismatched = mutable(record);
    mismatched.commandHash = otherEntry.commandRecord.commandHash;
    expectHistoryError(() => verifyOf(mismatched, base.commandRecord), "yearLedgerRecord.commandRecord");
  });

  it("Command Record 自身不合法（argsHash／commandHash／形狀）→ 連結錯誤", () => {
    const base = fixture();
    const record = createP3EYearLedgerRecord(base.yearInput);

    const badArgs = structuredClone(base.commandRecord) as unknown as Dict;
    badArgs.argsHash = HEX_9;
    expectHistoryError(() => verifyOf(record, badArgs), "yearLedgerRecord.commandRecord");

    const badCommandHash = structuredClone(base.commandRecord) as unknown as Dict;
    badCommandHash.commandHash = HEX_9;
    expectHistoryError(() => verifyOf(record, badCommandHash), "yearLedgerRecord.commandRecord");

    expectHistoryError(() => verifyOf(record, { index: 1 }), "yearLedgerRecord.commandRecord");
    expectHistoryError(() => verifyOf(record, null), "yearLedgerRecord.commandRecord");

    // 建立器同樣折成連結錯誤
    const badInput = structuredClone(base.yearInput);
    badInput.commandRecord = { index: 1 };
    expectHistoryError(() => createP3EYearLedgerRecord(badInput), "yearLedgerRecord.commandRecord");
  });

  it("自洽偽造：兩份 Record 各自完全合法，只有 entryHash 交叉連結不同 → 仍拒絕", () => {
    const base = fixture();
    const yearRecord = createP3EYearLedgerRecord(base.yearInput);

    // 1. 另一份「完全合法、可通過 readP3ECommandRecord」的 Command Record：
    //    index／year／stateHashBefore／stateHashAfter 完全相同，
    //    但 entryHash 指向另一個合法的 64 位小寫 hex。
    const forgedCommandRecord = createP3ECommandRecord({
      index: base.yearInput.index,
      year: base.yearInput.year,
      command: ADVANCE,
      prevCommandHash: HEX_A,
      stateHashBefore: base.yearInput.stateHashBefore,
      stateHashAfter: base.yearInput.stateHashAfter,
      entryHash: HEX_9
    });

    // 2. 它本身是合法的（readP3ECommandRecord 會通過）
    expect(() => readP3ECommandRecord(forgedCommandRecord)).not.toThrow();
    expect(forgedCommandRecord.entryHash).toBe(HEX_9);
    expect(forgedCommandRecord.entryHash).not.toBe(yearRecord.entryHash);

    // 3. Year Record 只把 commandHash 同步成新值，entryHash 仍是原本正確的那個
    const forgedYearRecord = mutable(yearRecord);
    forgedYearRecord.commandHash = forgedCommandRecord.commandHash;

    // 4. 用「原本正確的 entryHash ＋ 新 commandHash」正式重算 chainHash
    forgedYearRecord.chainHash = computeP3EYearChainHash({
      prevChainHash: yearRecord.prevChainHash,
      index: yearRecord.index,
      year: yearRecord.year,
      entryHash: yearRecord.entryHash,
      stateHashAfter: yearRecord.stateHashAfter,
      commandHash: forgedCommandRecord.commandHash
    });

    // 5. 先確認「兩份 Record 各自的 hash 都完全自洽」：
    //    Year Record 的 entryHash 仍等於用自己欄位重算的結果、
    //    chainHash 也等於用自己欄位＋新 commandHash 重算的結果。
    expect(
      computeP3EYearEntryHash({
        index: forgedYearRecord.index as number,
        year: forgedYearRecord.year as number,
        age: forgedYearRecord.age as number,
        phase: forgedYearRecord.phase as P3EPhase,
        stateHashBefore: forgedYearRecord.stateHashBefore as P3EHex64,
        rngBefore: forgedYearRecord.rngBefore as P3ERngState,
        rngAfter: forgedYearRecord.rngAfter as P3ERngState,
        snapshotHash: forgedYearRecord.snapshotHash as P3EHex64,
        deltaHash: forgedYearRecord.deltaHash as P3EHex64
      })
    ).toBe(forgedYearRecord.entryHash);
    expect(
      computeP3EYearChainHash({
        prevChainHash: forgedYearRecord.prevChainHash as P3EHex64,
        index: forgedYearRecord.index as number,
        year: forgedYearRecord.year as number,
        entryHash: forgedYearRecord.entryHash as P3EHex64,
        stateHashAfter: forgedYearRecord.stateHashAfter as P3EHex64,
        commandHash: forgedYearRecord.commandHash as P3EHex64
      })
    ).toBe(forgedYearRecord.chainHash);
    expect(forgedCommandRecord.commandHash).toBe(
      computeP3ECommandHash({
        prevCommandHash: forgedCommandRecord.prevCommandHash,
        index: forgedCommandRecord.index,
        year: forgedCommandRecord.year,
        command: forgedCommandRecord.command.type,
        argsHash: forgedCommandRecord.argsHash,
        stateHashBefore: forgedCommandRecord.stateHashBefore,
        stateHashAfter: forgedCommandRecord.stateHashAfter,
        entryHash: forgedCommandRecord.entryHash
      })
    );

    // 6. 但交叉連結不一致：Command Record 的 entryHash ≠ Year Record 重算的 entryHash。
    //    驗證器必須直接攔截（不能只靠 commandHash 間接判斷）。
    expectHistoryError(
      () => verifyOf(forgedYearRecord, forgedCommandRecord),
      "yearLedgerRecord.commandRecord"
    );

    // 7. 對照：只要把 Command Record 的 entryHash 改回真正的那個，同一組輸入就通過，
    //    證明拒絕的原因就是「entryHash 交叉連結」。
    const honestCommandRecord = createP3ECommandRecord({
      index: base.yearInput.index,
      year: base.yearInput.year,
      command: ADVANCE,
      prevCommandHash: HEX_A,
      stateHashBefore: base.yearInput.stateHashBefore,
      stateHashAfter: base.yearInput.stateHashAfter,
      entryHash: yearRecord.entryHash
    });
    const honestYearRecord = mutable(yearRecord);
    honestYearRecord.commandHash = honestCommandRecord.commandHash;
    honestYearRecord.chainHash = computeP3EYearChainHash({
      prevChainHash: yearRecord.prevChainHash,
      index: yearRecord.index,
      year: yearRecord.year,
      entryHash: yearRecord.entryHash,
      stateHashAfter: yearRecord.stateHashAfter,
      commandHash: honestCommandRecord.commandHash
    });
    expect(() => verifyOf(honestYearRecord, honestCommandRecord)).not.toThrow();
  });

  it("建立器：Command Record 的 entryHash 與算出來的不同 → yearLedgerRecord.entryHash", () => {
    const f = fixture({ overrideEntryHash: HEX_9 });
    expectHistoryError(() => createP3EYearLedgerRecord(f.yearInput), "yearLedgerRecord.entryHash");
  });
});

/* ------------------------------------------------------------------ */
/* 四、形狀與信任邊界                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2d 形狀與信任邊界", () => {
  const base = fixture();
  const record = createP3EYearLedgerRecord(base.yearInput);

  it("建立器：缺欄／多欄／改名", () => {
    for (const key of [
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
      "prevChainHash",
      "commandRecord"
    ]) {
      const missing = structuredClone(base.yearInput);
      delete missing[key];
      expectHistoryError(() => createP3EYearLedgerRecord(missing), "yearLedgerRecord");
    }

    const extra = structuredClone(base.yearInput);
    extra.entryHash = HEX_9;
    expectHistoryError(() => createP3EYearLedgerRecord(extra), "yearLedgerRecord");

    const renamed = structuredClone(base.yearInput);
    delete renamed.deltaHash;
    renamed.delta = HEX_E;
    expectHistoryError(() => createP3EYearLedgerRecord(renamed), "yearLedgerRecord");
  });

  it("驗證器：wrapper 與十四欄的缺欄／多欄", () => {
    expectHistoryError(() => verifyP3EYearLedgerRecord({ record }), "yearLedgerRecord");
    expectHistoryError(() => verifyP3EYearLedgerRecord({ commandRecord: base.commandRecord }), "yearLedgerRecord");
    expectHistoryError(() => verifyP3EYearLedgerRecord({ record, commandRecord: base.commandRecord, extra: 1 }), "yearLedgerRecord");

    for (const key of [
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
    ]) {
      const missing = mutable(record);
      delete missing[key];
      expectHistoryError(() => verifyOf(missing, base.commandRecord), "yearLedgerRecord");
    }

    const extra = mutable(record);
    extra.extra = 1;
    expectHistoryError(() => verifyOf(extra, base.commandRecord), "yearLedgerRecord");
  });

  it("primitive／phase／八個 hash 格式反例", () => {
    const primitives: readonly [string, unknown][] = [
      ["index", 0],
      ["index", -1],
      ["index", 1.5],
      ["index", Number.MAX_SAFE_INTEGER + 1],
      ["year", 2030.5],
      ["year", Number.NaN],
      ["age", -1],
      ["age", 121],
      ["age", 30.5],
      ["phase", "pending"],
      ["phase", "LIFE"],
      ["phase", 42],
      ["stateHashBefore", "A".repeat(64)],
      ["stateHashAfter", "a".repeat(63)],
      ["snapshotHash", "g".repeat(64)],
      ["deltaHash", 42],
      ["entryHash", null],
      ["commandHash", ""],
      ["prevChainHash", "f".repeat(65)],
      ["chainHash", {}]
    ];
    for (const [key, value] of primitives) {
      const draft = mutable(record);
      draft[key] = value;
      const expectedPath =
        key === "index" || key === "year" || key === "age" || key === "phase"
          ? `yearLedgerRecord.${key}`
          : `yearLedgerRecord.${key}`;
      expectHistoryError(() => verifyOf(draft, base.commandRecord), expectedPath);
    }
  });

  it("RNG 反例：三游標缺／多、游標缺欄、稀疏、額外鍵、非法 domain、全零、負 draws、非陣列", () => {
    const cases: readonly [string, (rng: Dict) => void][] = [
      ["缺 cursor", (rng) => { delete rng.life; }],
      ["多 cursor", (rng) => { rng.extra = {}; }],
      ["游標缺欄", (rng) => { delete (rng.events as Dict).u32Draws; }],
      ["游標多欄", (rng) => { (rng.death as Dict).extra = 1; }],
      ["tuple 太短", (rng) => { (rng.life as Dict).state = [1, 2, 3]; }],
      ["tuple 太長", (rng) => { (rng.life as Dict).state = [1, 2, 3, 4, 5]; }],
      ["tuple 稀疏", (rng) => {
        const sparse = [1, 2, 3, 4];
        delete (sparse as unknown as Dict)[3];
        (rng.life as Dict).state = sparse;
      }],
      ["tuple 額外鍵", (rng) => {
        const extra = [1, 2, 3, 4] as unknown as Dict;
        extra.extraKey = 1;
        (rng.life as Dict).state = extra;
      }],
      ["tuple accessor", (rng) => {
        const accessor = [1, 2, 3, 4];
        Object.defineProperty(accessor, "0", { enumerable: true, configurable: true, get: () => 1 });
        (rng.life as Dict).state = accessor;
      }],
      ["tuple 非陣列", (rng) => { (rng.life as Dict).state = "1234"; }],
      ["tuple 全零", (rng) => { (rng.life as Dict).state = [0, 0, 0, 0]; }],
      ["非法 life domain", (rng) => { (rng.life as Dict).domain = "events"; }],
      ["非法 events domain", (rng) => { (rng.events as Dict).domain = "p3e/death"; }],
      ["非法 death domain", (rng) => { (rng.death as Dict).domain = "life"; }],
      ["負 draws", (rng) => { (rng.life as Dict).semanticDraws = -1; }],
      ["非安全整數 draws", (rng) => { (rng.events as Dict).u32Draws = 1.5; }],
      ["draws 是字串", (rng) => { (rng.death as Dict).u32Draws = "8"; }]
    ];
    for (const [, change] of cases) {
      const draft = mutable(record);
      change(draft.rngBefore as Dict);
      expectHistoryError(() => verifyOf(draft, base.commandRecord), "yearLedgerRecord.rngBefore");
    }

    // rng 整個不是物件
    for (const value of [42, "rng", null, [], true]) {
      const draft = mutable(record);
      draft.rngBefore = value;
      expectHistoryError(() => verifyOf(draft, base.commandRecord), "yearLedgerRecord.rngBefore");
    }

    // 游標本身不是物件（鍵數對得上，但值是純量）
    const notObject = mutable(record);
    (notObject.rngBefore as Dict).life = 42;
    expectHistoryError(() => verifyOf(notObject, base.commandRecord), "yearLedgerRecord.rngBefore");

    // initialState 與 state 兩條都要能各自被拒絕
    const badInitial = mutable(record);
    ((badInitial.rngBefore as Dict).life as Dict).initialState = [0, 0, 0, 0];
    expectHistoryError(() => verifyOf(badInitial, base.commandRecord), "yearLedgerRecord.rngBefore");

    const badEventsInitial = mutable(record);
    ((badEventsInitial.rngAfter as Dict).events as Dict).initialState = [1, 2, 3];
    expectHistoryError(() => verifyOf(badEventsInitial, base.commandRecord), "yearLedgerRecord.rngAfter");

    const badDeathState = mutable(record);
    ((badDeathState.rngAfter as Dict).death as Dict).state = [1, 2, 3, 4, 5];
    expectHistoryError(() => verifyOf(badDeathState, base.commandRecord), "yearLedgerRecord.rngAfter");

    // tuple 帶 symbol 鍵
    const symbolTuple = mutable(record);
    const withSymbol = [1, 2, 3, 4] as unknown as Record<string | symbol, unknown>;
    withSymbol[Symbol("extra")] = 1;
    ((symbolTuple.rngBefore as Dict).life as Dict).state = withSymbol;
    expectHistoryError(() => verifyOf(symbolTuple, base.commandRecord), "yearLedgerRecord.rngBefore");

    // tuple 的某個索引被改成不可列舉（自有鍵數不變、可列舉數少一）
    const hiddenIndex = mutable(record);
    const hiddenTuple = [1, 2, 3, 4];
    Object.defineProperty(hiddenTuple, "0", { value: 1, enumerable: false, configurable: true });
    ((hiddenIndex.rngBefore as Dict).life as Dict).state = hiddenTuple;
    expectHistoryError(() => verifyOf(hiddenIndex, base.commandRecord), "yearLedgerRecord.rngBefore");

    // tuple 是 Proxy（revoked 與會拋錯的 trap）：反射例外不外洩
    const revokedTuple = Proxy.revocable([1, 2, 3, 4], {});
    revokedTuple.revoke();
    const revokedDraft = mutable(record);
    ((revokedDraft.rngBefore as Dict).life as Dict).state = revokedTuple.proxy;
    expectHistoryError(() => verifyOf(revokedDraft, base.commandRecord), "yearLedgerRecord.rngBefore");

    const trappingTuple = new Proxy([1, 2, 3, 4], {
      getOwnPropertyDescriptor() {
        throw new TypeError("tuple trap");
      }
    });
    const trappingDraft = mutable(record);
    ((trappingDraft.rngBefore as Dict).life as Dict).state = trappingTuple;
    expectHistoryError(() => verifyOf(trappingDraft, base.commandRecord), "yearLedgerRecord.rngBefore");

    // u32 超界與非數字
    for (const value of [0x1_0000_0000, -1, 1.5, Number.NaN, "4", null]) {
      const draft = mutable(record);
      ((draft.rngBefore as Dict).life as Dict).state = [value, 2, 3, 4];
      expectHistoryError(() => verifyOf(draft, base.commandRecord), "yearLedgerRecord.rngBefore");
    }
  });

  it("容器：hidden／symbol／accessor（getter 不執行）／class／陣列／Proxy", () => {
    const hidden = mutable(record);
    Object.defineProperty(hidden, "hiddenExtra", { value: 1, enumerable: false, configurable: true });
    expectHistoryError(() => verifyOf(hidden, base.commandRecord), "yearLedgerRecord");

    // 必要欄位被改成不可列舉（自有鍵數不變，可列舉數少一）
    const hiddenField = mutable(record);
    Object.defineProperty(hiddenField, "chainHash", { value: record.chainHash, enumerable: false, configurable: true });
    expectHistoryError(() => verifyOf(hiddenField, base.commandRecord), "yearLedgerRecord");

    const symbol: Record<string | symbol, unknown> = mutable(record);
    symbol[Symbol("extra")] = 1;
    expectHistoryError(() => verifyOf(symbol, base.commandRecord), "yearLedgerRecord");

    let invoked = false;
    const accessor: Dict = {};
    for (const key of [
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
      "prevChainHash"
    ]) {
      accessor[key] = mutable(record)[key];
    }
    Object.defineProperty(accessor, "chainHash", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return HEX_9;
      }
    });
    expectHistoryError(() => verifyOf(accessor, base.commandRecord), "yearLedgerRecord");
    expect(invoked).toBe(false);

    class RecordClass {
      readonly index = 1;
    }
    expectHistoryError(() => verifyOf(new RecordClass(), base.commandRecord), "yearLedgerRecord");
    expectHistoryError(() => verifyOf([record], base.commandRecord), "yearLedgerRecord");

    for (const value of [null, undefined, 42, "record", true]) {
      expectHistoryError(() => verifyP3EYearLedgerRecord(value), "yearLedgerRecord");
      expectHistoryError(() => createP3EYearLedgerRecord(value), "yearLedgerRecord");
    }

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectHistoryError(() => verifyP3EYearLedgerRecord(revoked.proxy), "yearLedgerRecord");
    expectHistoryError(() => createP3EYearLedgerRecord(revoked.proxy), "yearLedgerRecord");

    const trap = new Proxy({}, {
      getPrototypeOf() {
        throw new RangeError("trap");
      }
    });
    expectHistoryError(() => createP3EYearLedgerRecord(trap), "yearLedgerRecord");
  });

  it("不進公開 barrel", () => {
    expect(typeof createP3EYearLedgerRecord).toBe("function");
    expect(typeof verifyP3EYearLedgerRecord).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.createP3EYearLedgerRecord).toBeUndefined();
    expect(surface.verifyP3EYearLedgerRecord).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("無時間／隨機／JSON stringify／State／append／execute", () => {
    const source = readFileSync(join(ROOT, "packages/simulation/src/year-ledger-record.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const token of ["Math.random", "Date.now", "performance.now", "JSON.stringify", "JSON.parse", "new Date"]) {
      expect(code, token).not.toContain(token);
    }
    for (const forbidden of [
      "append",
      "sealP3EState",
      "readP3EState",
      "computeP3EStateHash",
      "execute",
      "replay",
      "codec"
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain("computeP3EYearEntryHash");
    expect(code).toContain("computeP3EYearChainHash");
    expect(code).toContain("readP3ECommandRecord");
  });

  it("只匯出兩個函式與一個型別", () => {
    const source = readFileSync(join(ROOT, "packages/simulation/src/year-ledger-record.ts"), "utf8");
    const exported = [...source.matchAll(/^export (?:function|type|interface|const) (\w+)/gm)].map((match) => match[1]);
    expect(exported.sort()).toEqual([
      "P3EYearLedgerRecord",
      "createP3EYearLedgerRecord",
      "verifyP3EYearLedgerRecord"
    ]);
  });
});
