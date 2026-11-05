import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { computeP3ECommandArgsHash } from "../src/command-envelope";
import { computeP3ECommandHash } from "../src/year-ledger-hash";
import { createP3ECommandRecord, readP3ECommandRecord, type P3ECommandRecord } from "../src/command-record";

/**
 * P3-E.1b-2c：Command Record 建立與驗證。
 *
 * 所有期望值都獨立重算（`computeP3ECommandArgsHash`／`computeP3ECommandHash`），
 * 不用被測函式的輸出當答案。
 */

const ROOT = process.cwd();
const HEX64 = /^[0-9a-f]{64}$/;

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);
const HEX_E = "e".repeat(64);

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;
const CHOOSE = { type: "CHOOSE_DECISION", optionId: "dec.opt.alpha" } as const;

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 1,
    year: 2030,
    command: { ...ADVANCE },
    prevCommandHash: HEX_A,
    stateHashBefore: HEX_B,
    stateHashAfter: HEX_C,
    entryHash: HEX_D,
    ...overrides
  };
}

/** 獨立重算某個 record 的 argsHash。 */
function argsHashOf(command: unknown): string {
  return computeP3ECommandArgsHash(command);
}

/** 獨立重算某個 record 的 commandHash。 */
function commandHashOf(parts: {
  prevCommandHash: string;
  index: number;
  year: number;
  command: { type: string };
  argsHash: string;
  stateHashBefore: string;
  stateHashAfter: string;
  entryHash: string;
}): string {
  return computeP3ECommandHash({
    prevCommandHash: parts.prevCommandHash,
    index: parts.index,
    year: parts.year,
    command: parts.command.type,
    argsHash: parts.argsHash,
    stateHashBefore: parts.stateHashBefore,
    stateHashAfter: parts.stateHashAfter,
    entryHash: parts.entryHash
  });
}

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function expectRecordError(run: () => unknown, path: string): void {
  const caught = caughtFrom(run);
  expect(isP3EError(caught), `E_P3E_COMMAND at ${path}`).toBe(true);
  const error = caught as P3EError;
  expect(error.code).toBe("E_P3E_COMMAND");
  expect(error.path).toBe(path);
  expect(error.message).toBe(`E_P3E_COMMAND at ${path}`);
  expect(error.name).toBe("P3EError");
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => isDeepFrozen(record[key]));
}

/* ------------------------------------------------------------------ */
/* 一、建立                                                            */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2c 建立 Command Record", () => {
  it("ADVANCE_YEAR／standard：九欄與獨立重算結果一致", () => {
    const record = createP3ECommandRecord(createInput());

    expect(Object.keys(record).sort()).toEqual([
      "argsHash",
      "command",
      "commandHash",
      "entryHash",
      "index",
      "prevCommandHash",
      "stateHashAfter",
      "stateHashBefore",
      "year"
    ]);
    expect(record.index).toBe(1);
    expect(record.year).toBe(2030);
    expect(record.command).toEqual({ type: "ADVANCE_YEAR", contentMode: "standard" });
    expect(record.argsHash).toBe(argsHashOf(ADVANCE));
    expect(record.argsHash).toMatch(HEX64);
    expect(record.prevCommandHash).toBe(HEX_A);
    expect(record.stateHashBefore).toBe(HEX_B);
    expect(record.stateHashAfter).toBe(HEX_C);
    expect(record.entryHash).toBe(HEX_D);
    expect(record.commandHash).toBe(
      commandHashOf({
        prevCommandHash: HEX_A,
        index: 1,
        year: 2030,
        command: ADVANCE,
        argsHash: argsHashOf(ADVANCE),
        stateHashBefore: HEX_B,
        stateHashAfter: HEX_C,
        entryHash: HEX_D
      })
    );
    expect(record.commandHash).toMatch(HEX64);
  });

  it("ADVANCE_YEAR／guardian：contentMode 進入 argsHash 與 commandHash", () => {
    const standard = createP3ECommandRecord(createInput());
    const guardian = createP3ECommandRecord(createInput({ command: { type: "ADVANCE_YEAR", contentMode: "guardian" } }));
    expect(guardian.argsHash).toBe(argsHashOf({ type: "ADVANCE_YEAR", contentMode: "guardian" }));
    expect(guardian.argsHash).not.toBe(standard.argsHash);
    expect(guardian.commandHash).not.toBe(standard.commandHash);
  });

  it("CHOOSE_DECISION／合法 optionId", () => {
    const record = createP3ECommandRecord(createInput({ command: { ...CHOOSE } }));
    expect(record.command).toEqual({ type: "CHOOSE_DECISION", optionId: "dec.opt.alpha" });
    expect(record.argsHash).toBe(argsHashOf(CHOOSE));
    expect(record.commandHash).toBe(
      commandHashOf({
        prevCommandHash: HEX_A,
        index: 1,
        year: 2030,
        command: CHOOSE,
        argsHash: argsHashOf(CHOOSE),
        stateHashBefore: HEX_B,
        stateHashAfter: HEX_C,
        entryHash: HEX_D
      })
    );
  });

  it("index 1 與安全整數邊界", () => {
    const first = createP3ECommandRecord(createInput({ index: 1 }));
    expect(first.index).toBe(1);

    const last = createP3ECommandRecord(createInput({ index: Number.MAX_SAFE_INTEGER }));
    expect(last.index).toBe(Number.MAX_SAFE_INTEGER);
    expect(last.commandHash).not.toBe(first.commandHash);

    for (const index of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      expectRecordError(() => createP3ECommandRecord(createInput({ index })), "commandRecord.index");
    }
  });

  it("year 必須是安全整數", () => {
    for (const year of [2030.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "2030", null]) {
      expectRecordError(() => createP3ECommandRecord(createInput({ year })), "commandRecord.year");
    }
    // 負數年份不在本層阻擋（year 只要求安全整數；年度語意屬 Ledger／Replay）
    expect(createP3ECommandRecord(createInput({ year: 0 })).year).toBe(0);
  });

  it("100 次建立 byte-identical", () => {
    const first = createP3ECommandRecord(createInput());
    for (let round = 0; round < 100; round += 1) {
      expect(createP3ECommandRecord(createInput())).toEqual(first);
      expect(createP3ECommandRecord(structuredClone(createInput()))).toEqual(first);
    }
  });

  it("輸入不修改；輸出與巢狀 command 深層凍結、零共享", () => {
    const input = createInput();
    const before = structuredClone(input);
    const record = createP3ECommandRecord(input);

    expect(input).toEqual(before);
    expect(record).not.toBe(input);
    expect(record.command).not.toBe(input.command);
    expect(isDeepFrozen(record)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.command)).toBe(true);
    expect(() => {
      (record as { index: number }).index = 2;
    }).toThrow(TypeError);
    expect(() => {
      ((record.command as unknown) as Record<string, unknown>).contentMode = "guardian";
    }).toThrow(TypeError);
  });

  it("建立後立即 read round-trip 欄位完全相等", () => {
    for (const command of [{ ...ADVANCE }, { type: "ADVANCE_YEAR", contentMode: "guardian" }, { ...CHOOSE }]) {
      const created = createP3ECommandRecord(createInput({ command }));
      const reread = readP3ECommandRecord(created);
      expect(reread).toEqual(created);
      expect(reread.command).toEqual(created.command);
      expect(reread.argsHash).toBe(created.argsHash);
      expect(reread.commandHash).toBe(created.commandHash);
      expect(isDeepFrozen(reread)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 二、竄改反例（每欄單獨修改）                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2c 竄改反例", () => {
  const base = (): P3ECommandRecord => createP3ECommandRecord(createInput());
  const tamper = (change: (draft: Record<string, unknown>) => void): Record<string, unknown> => {
    const draft = structuredClone(base()) as unknown as Record<string, unknown>;
    change(draft);
    return draft;
  };

  it("index／year 被改 → commandHash 不一致", () => {
    expectRecordError(() => readP3ECommandRecord(tamper((d) => { d.index = 2; })), "commandRecord.commandHash");
    expectRecordError(() => readP3ECommandRecord(tamper((d) => { d.year = 2031; })), "commandRecord.commandHash");
  });

  it("command.type 被改 → command 形狀錯誤", () => {
    expectRecordError(
      () => readP3ECommandRecord(tamper((d) => { (d.command as Record<string, unknown>).type = "CHOOSE_DECISION"; })),
      "commandRecord.command"
    );
    expectRecordError(
      () => readP3ECommandRecord(tamper((d) => { (d.command as Record<string, unknown>).type = "advance_year"; })),
      "commandRecord.command"
    );
  });

  it("contentMode／optionId 被改 → argsHash 不一致", () => {
    expectRecordError(
      () => readP3ECommandRecord(tamper((d) => { (d.command as Record<string, unknown>).contentMode = "guardian"; })),
      "commandRecord.argsHash"
    );

    const choose = createP3ECommandRecord(createInput({ command: { ...CHOOSE } })) as unknown as Record<string, unknown>;
    const chooseDraft = structuredClone(choose);
    (chooseDraft.command as Record<string, unknown>).optionId = "dec.opt.beta";
    expectRecordError(() => readP3ECommandRecord(chooseDraft), "commandRecord.argsHash");
  });

  it("argsHash 被改 → argsHash 不一致；其餘五個 hash 被改 → commandHash 不一致", () => {
    expectRecordError(() => readP3ECommandRecord(tamper((d) => { d.argsHash = HEX_E; })), "commandRecord.argsHash");

    for (const key of ["prevCommandHash", "stateHashBefore", "stateHashAfter", "entryHash"]) {
      expectRecordError(
        () => readP3ECommandRecord(tamper((d) => { d[key] = HEX_E; })),
        "commandRecord.commandHash"
      );
    }

    expectRecordError(() => readP3ECommandRecord(tamper((d) => { d.commandHash = HEX_E; })), "commandRecord.commandHash");
  });

  it("command、argsHash、commandHash 三者一起重算 → 本層無法攔截（已知邊界）", () => {
    const command = { type: "CHOOSE_DECISION", optionId: "dec.opt.beta" } as const;
    const argsHash = argsHashOf(command);
    const forged = {
      index: 1,
      year: 2030,
      command,
      argsHash,
      prevCommandHash: HEX_A,
      stateHashBefore: HEX_B,
      stateHashAfter: HEX_C,
      entryHash: HEX_D,
      commandHash: commandHashOf({
        prevCommandHash: HEX_A,
        index: 1,
        year: 2030,
        command,
        argsHash,
        stateHashBefore: HEX_B,
        stateHashAfter: HEX_C,
        entryHash: HEX_D
      })
    };
    // 本模組只保證「形狀＋argsHash＋commandHash 三者自洽」，因此這裡會通過。
    const accepted = readP3ECommandRecord(forged);
    expect(accepted.command).toEqual(command);

    // 真正能攔截它的是下一層：stateHashBefore 必須是目前 State 的 hash、
    // stateHashAfter 必須是合法轉移、entryHash 必須屬於目前年度、index 必須連續、
    // prevCommandHash 必須等於 commandLog.headHash（皆不在本批範圍）。
    expect(accepted.stateHashBefore).toBe(HEX_B);
  });
});

/* ------------------------------------------------------------------ */
/* 三、形狀與信任邊界                                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2c 形狀與信任邊界", () => {
  it("建立器：缺欄／多欄／改名／提供 commandHash 全部拒絕", () => {
    for (const key of ["index", "year", "command", "prevCommandHash", "stateHashBefore", "stateHashAfter", "entryHash"]) {
      const missing = createInput();
      delete missing[key];
      expectRecordError(() => createP3ECommandRecord(missing), "commandRecord");
    }

    expectRecordError(() => createP3ECommandRecord(createInput({ extra: 1 })), "commandRecord");
    expectRecordError(() => createP3ECommandRecord(createInput({ commandHash: HEX_E })), "commandRecord");
    expectRecordError(() => createP3ECommandRecord(createInput({ argsHash: HEX_E })), "commandRecord");

    const renamed = createInput();
    delete renamed.entryHash;
    renamed.entry = HEX_D;
    expectRecordError(() => createP3ECommandRecord(renamed), "commandRecord");
  });

  it("驗證器：缺欄／多欄／改名全部拒絕", () => {
    const record = createP3ECommandRecord(createInput()) as unknown as Record<string, unknown>;
    for (const key of [
      "index",
      "year",
      "command",
      "argsHash",
      "prevCommandHash",
      "stateHashBefore",
      "stateHashAfter",
      "entryHash",
      "commandHash"
    ]) {
      const missing = structuredClone(record);
      delete missing[key];
      expectRecordError(() => readP3ECommandRecord(missing), "commandRecord");
    }

    const extra = { ...structuredClone(record), extra: 1 };
    expectRecordError(() => readP3ECommandRecord(extra), "commandRecord");
  });

  it("六個 hash 欄位：大寫／短 hex／非 hex／非字串全部拒絕", () => {
    const record = createP3ECommandRecord(createInput()) as unknown as Record<string, unknown>;
    const cases: readonly (readonly [unknown, string])[] = [
      ["A".repeat(64), "大寫"],
      ["a".repeat(63), "短"],
      ["a".repeat(65), "長"],
      ["g".repeat(64), "非 hex"],
      ["", "空字串"],
      [42, "數字"],
      [null, "null"],
      [{}, "物件"]
    ];
    for (const [key, label] of [
      ["argsHash", "argsHash"],
      ["prevCommandHash", "prevCommandHash"],
      ["stateHashBefore", "stateHashBefore"],
      ["stateHashAfter", "stateHashAfter"],
      ["entryHash", "entryHash"],
      ["commandHash", "commandHash"]
    ] as const) {
      for (const [value, description] of cases) {
        const draft = structuredClone(record);
        draft[key] = value;
        expectRecordError(() => readP3ECommandRecord(draft), `commandRecord.${label}`);
        expect(description).toBe(description);
      }
    }
  });

  it("command 不合法 → commandRecord.command（不洩漏內層 path）", () => {
    for (const command of [
      { type: "ADVANCE_YEAR", contentMode: "hard" },
      { type: "ADVANCE_YEAR" },
      { type: "CHOOSE_DECISION", optionId: "AB" },
      { type: "UNKNOWN" },
      "ADVANCE_YEAR",
      null,
      []
    ]) {
      expectRecordError(() => createP3ECommandRecord(createInput({ command })), "commandRecord.command");
    }
  });

  it("容器：hidden／symbol／accessor（getter 不執行）／class／陣列／Proxy", () => {
    const hidden = createInput();
    Object.defineProperty(hidden, "hiddenExtra", { value: 1, enumerable: false, configurable: true });
    expectRecordError(() => createP3ECommandRecord(hidden), "commandRecord");

    const symbol: Record<string | symbol, unknown> = createInput();
    symbol[Symbol("extra")] = 1;
    expectRecordError(() => createP3ECommandRecord(symbol), "commandRecord");

    let invoked = false;
    const accessor: Record<string, unknown> = {};
    for (const key of ["index", "year", "command", "prevCommandHash", "stateHashBefore", "stateHashAfter"]) {
      accessor[key] = createInput()[key];
    }
    Object.defineProperty(accessor, "entryHash", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return HEX_D;
      }
    });
    expectRecordError(() => createP3ECommandRecord(accessor), "commandRecord");
    expect(invoked).toBe(false);

    class RecordClass {
      readonly index = 1;
      readonly year = 2030;
      readonly command = { ...ADVANCE };
      readonly prevCommandHash = HEX_A;
      readonly stateHashBefore = HEX_B;
      readonly stateHashAfter = HEX_C;
      readonly entryHash = HEX_D;
    }
    expectRecordError(() => createP3ECommandRecord(new RecordClass()), "commandRecord");

    expectRecordError(() => createP3ECommandRecord([createInput()]), "commandRecord");
    for (const value of [null, undefined, 42, "record", true]) {
      expectRecordError(() => createP3ECommandRecord(value), "commandRecord");
      expectRecordError(() => readP3ECommandRecord(value), "commandRecord");
    }

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectRecordError(() => createP3ECommandRecord(revoked.proxy), "commandRecord");
    expectRecordError(() => readP3ECommandRecord(revoked.proxy), "commandRecord");

    const protoTrap = new Proxy({}, {
      getPrototypeOf() {
        throw new RangeError("trap");
      }
    });
    expectRecordError(() => createP3ECommandRecord(protoTrap), "commandRecord");
  });

  it("不進公開 barrel", () => {
    expect(typeof createP3ECommandRecord).toBe("function");
    expect(typeof readP3ECommandRecord).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.createP3ECommandRecord).toBeUndefined();
    expect(surface.readP3ECommandRecord).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("無時間／隨機／JSON stringify／Ledger append／State seal／replay", () => {
    const source = readFileSync(join(ROOT, "packages/simulation/src/command-record.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const token of ["Math.random", "Date.now", "performance.now", "JSON.stringify", "JSON.parse", "new Date"]) {
      expect(code, token).not.toContain(token);
    }
    for (const forbidden of [
      "append",
      "sealP3EState",
      "readP3EState",
      "computeP3EStateHash",
      "readP3EStateShape",
      "replay",
      "verify",
      "chainHash",
      "snapshotHash",
      "deltaHash"
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // 只透過既有正式原語組合
    expect(code).toContain("readP3ECommand");
    expect(code).toContain("computeP3ECommandArgsHash");
    expect(code).toContain("computeP3ECommandHash");
  });

  it("只匯出兩個函式與一個型別", () => {
    const source = readFileSync(join(ROOT, "packages/simulation/src/command-record.ts"), "utf8");
    const exported = [...source.matchAll(/^export (?:function|type|interface|const) (\w+)/gm)].map((match) => match[1]);
    expect(exported.sort()).toEqual(["P3ECommandRecord", "createP3ECommandRecord", "readP3ECommandRecord"]);
  });
});
