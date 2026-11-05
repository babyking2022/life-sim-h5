import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ascii, canonicalBytes, concatBytes, sha256Hex } from "@life-sim/engine";
import { P3B_MAX_ID_LENGTH, type P3EHex64 } from "@life-sim/contracts";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { computeP3ECommandArgsHash, readP3ECommand, type P3ECommand } from "../src/command-envelope";

/**
 * P3-E.1b-2b：Command Envelope 與 Args Hash 基礎層。
 *
 * 期望值一律**獨立重算**：用 engine 公開的 `ascii`／`concatBytes`／`canonicalBytes`／
 * `sha256Hex` 與字面值 domain 再算一次，不接受「用被測函式算出來的答案」。
 */

const ROOT = process.cwd();
const HEX64 = /^[0-9a-f]{64}$/;
const ARGS_DOMAIN = "LIFE1/P3E/COMMAND/ARGS/v1";

/** 其他六個既有 domain（用來證明 Args domain 與它們全部不同）。 */
const OTHER_DOMAINS = [
  "LIFE1/P3E/STATE/v1",
  "LIFE1/P3E/LOG/v1",
  "LIFE1/P3E/SNAPSHOT/v1",
  "LIFE1/P3E/DELTA/v1",
  "LIFE1/P3E/CHAIN/v1",
  "LIFE1/P3E/COMMAND/v1"
] as const;

/** 獨立重算：`sha256Hex(ascii(domain) ‖ 0x00 ‖ canonicalBytes(projection))`。 */
function expectedArgsHash(domain: string, projection: unknown): P3EHex64 {
  return sha256Hex(concatBytes(ascii(domain), Uint8Array.of(0), canonicalBytes(projection as never)));
}

const advance = (contentMode: string): unknown => ({ type: "ADVANCE_YEAR", contentMode });
const choose = (optionId: string): unknown => ({ type: "CHOOSE_DECISION", optionId });

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function expectCommandError(run: () => unknown, path: string): void {
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

/* ------------------------------------------------------------------ */
/* 一、有效命令                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2b 有效命令", () => {
  it("ADVANCE_YEAR ＋ standard／guardian：快照與 hash", () => {
    const standard = readP3ECommand(advance("standard"));
    expect(standard).toEqual({ type: "ADVANCE_YEAR", contentMode: "standard" });
    expect(Object.keys(standard).sort()).toEqual(["contentMode", "type"]);

    const guardian = readP3ECommand(advance("guardian"));
    expect(guardian).toEqual({ type: "ADVANCE_YEAR", contentMode: "guardian" });

    expect(computeP3ECommandArgsHash(advance("standard"))).toBe(
      expectedArgsHash(ARGS_DOMAIN, { type: "ADVANCE_YEAR", contentMode: "standard" })
    );
    expect(computeP3ECommandArgsHash(advance("guardian"))).toBe(
      expectedArgsHash(ARGS_DOMAIN, { type: "ADVANCE_YEAR", contentMode: "guardian" })
    );
  });

  it("CHOOSE_DECISION ＋ 合法 optionId 邊界（最短 3、最長 64、字元集）", () => {
    const valid = [
      "abc",
      "a1b",
      "dec.opt.alpha",
      "opt-stat",
      "opt_stat",
      "a".repeat(P3B_MAX_ID_LENGTH),
      "0".repeat(64),
      "a" + "b".repeat(63)
    ];
    for (const optionId of valid) {
      const command = readP3ECommand(choose(optionId));
      expect(command).toEqual({ type: "CHOOSE_DECISION", optionId });
      expect(computeP3ECommandArgsHash(choose(optionId))).toBe(
        expectedArgsHash(ARGS_DOMAIN, { type: "CHOOSE_DECISION", optionId })
      );
    }
  });

  it("重跑 100 次 byte-identical", () => {
    const commands: readonly unknown[] = [advance("standard"), advance("guardian"), choose("dec.opt.alpha")];
    for (const command of commands) {
      const first = computeP3ECommandArgsHash(command);
      for (let round = 0; round < 100; round += 1) {
        expect(computeP3ECommandArgsHash(command)).toBe(first);
        expect(computeP3ECommandArgsHash(structuredClone(command))).toBe(first);
      }
      expect(first).toMatch(HEX64);
    }
  });

  it("兩種 command type／contentMode／optionId 改變都會改 hash", () => {
    const advanceHash = computeP3ECommandArgsHash(advance("standard"));
    const chooseHash = computeP3ECommandArgsHash(choose("dec.opt.alpha"));
    expect(advanceHash).not.toBe(chooseHash);

    expect(computeP3ECommandArgsHash(advance("guardian"))).not.toBe(advanceHash);
    expect(computeP3ECommandArgsHash(choose("dec.opt.beta"))).not.toBe(chooseHash);
  });

  it("鍵插入順序不影響 hash", () => {
    const a = { type: "ADVANCE_YEAR", contentMode: "standard" };
    const b = { contentMode: "standard", type: "ADVANCE_YEAR" };
    expect(computeP3ECommandArgsHash(a)).toBe(computeP3ECommandArgsHash(b));

    const c = { type: "CHOOSE_DECISION", optionId: "dec.opt.alpha" };
    const d = { optionId: "dec.opt.alpha", type: "CHOOSE_DECISION" };
    expect(computeP3ECommandArgsHash(c)).toBe(computeP3ECommandArgsHash(d));
  });

  it("輸入不被修改；輸出凍結且零共享", () => {
    const input = advance("standard");
    const before = structuredClone(input);
    const command = readP3ECommand(input);
    computeP3ECommandArgsHash(input);

    expect(input).toEqual(before);
    expect(Object.isFrozen(command)).toBe(true);
    expect(command).not.toBe(input);
    expect(() => {
      (command as { type: string }).type = "CHOOSE_DECISION";
    }).toThrow(TypeError);

    const chooseInput = choose("dec.opt.alpha");
    const chooseCommand = readP3ECommand(chooseInput);
    expect(chooseCommand).not.toBe(chooseInput);
    expect((chooseCommand as { optionId: string }).optionId).toBe("dec.opt.alpha");
  });
});

/* ------------------------------------------------------------------ */
/* 二、反例                                                            */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2b 反例", () => {
  it("未知 type／大小寫錯誤 → E_P3E_COMMAND at command", () => {
    for (const type of [
      "advance_year",
      "Advance_Year",
      "ADVANCE_YEAR ",
      "ADVANCEYEAR",
      "CHOOSE_DECISION ",
      "",
      "END_LIFE",
      42,
      null,
      undefined,
      {}
    ]) {
      expectCommandError(() => readP3ECommand({ type, contentMode: "standard" }), "command");
    }
  });

  it("ADVANCE_YEAR 帶 optionId／CHOOSE_DECISION 帶 contentMode → 拒絕", () => {
    expectCommandError(
      () => readP3ECommand({ type: "ADVANCE_YEAR", contentMode: "standard", optionId: "dec.opt.alpha" }),
      "command"
    );
    expectCommandError(
      () => readP3ECommand({ type: "CHOOSE_DECISION", optionId: "dec.opt.alpha", contentMode: "standard" }),
      "command"
    );
  });

  it("缺欄／多欄／改名 → 拒絕", () => {
    expectCommandError(() => readP3ECommand({ type: "ADVANCE_YEAR" }), "command");
    expectCommandError(() => readP3ECommand({ type: "CHOOSE_DECISION" }), "command");
    expectCommandError(() => readP3ECommand({ type: "ADVANCE_YEAR", contentMode: "standard", extra: 1 }), "command");
    expectCommandError(() => readP3ECommand({ type: "CHOOSE_DECISION", optionId: "dec.opt.alpha", extra: 1 }), "command");
    expectCommandError(() => readP3ECommand({ type: "ADVANCE_YEAR", mode: "standard" }), "command");
    expectCommandError(() => readP3ECommand({ type: "CHOOSE_DECISION", option: "dec.opt.alpha" }), "command");
    expectCommandError(() => readP3ECommand({ kind: "ADVANCE_YEAR", contentMode: "standard" }), "command");
  });

  it("非法 contentMode → E_P3E_COMMAND at command.contentMode", () => {
    for (const contentMode of ["Standard", "GUARDIAN", "hard", "", " standard", 1, null, undefined, {}, []]) {
      expectCommandError(() => readP3ECommand({ type: "ADVANCE_YEAR", contentMode }), "command.contentMode");
    }
  });

  it("空白／過長／pattern 錯誤 optionId → E_P3E_COMMAND at command.optionId", () => {
    const tooLong = "a".repeat(P3B_MAX_ID_LENGTH + 1);
    for (const optionId of [
      "",
      " ",
      "ab",
      "a b",
      "-abc",
      ".abc",
      "_abc",
      "ABC",
      "dec opt",
      "dec/opt",
      "dec:opt",
      tooLong,
      "a".repeat(65),
      42,
      null,
      undefined,
      {}
    ]) {
      expectCommandError(() => readP3ECommand({ type: "CHOOSE_DECISION", optionId }), "command.optionId");
    }
  });

  it("容器：hidden／symbol／accessor（getter 不執行）／怪 prototype／陣列／class instance", () => {
    const hidden = { type: "ADVANCE_YEAR", contentMode: "standard" } as Record<string, unknown>;
    Object.defineProperty(hidden, "hiddenExtra", { value: 1, enumerable: false, configurable: true });
    expectCommandError(() => readP3ECommand(hidden), "command");

    const symbol = { type: "ADVANCE_YEAR", contentMode: "standard" } as Record<string | symbol, unknown>;
    (symbol as Record<symbol, unknown>)[Symbol("extra")] = 1;
    expectCommandError(() => readP3ECommand(symbol), "command");

    let invoked = false;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return "ADVANCE_YEAR";
      }
    });
    Object.defineProperty(accessor, "contentMode", { value: "standard", enumerable: true, configurable: true });
    expectCommandError(() => readP3ECommand(accessor), "command");
    expect(invoked).toBe(false);

    class CommandClass {
      readonly type = "ADVANCE_YEAR";
      readonly contentMode = "standard";
    }
    expectCommandError(() => readP3ECommand(new CommandClass()), "command");

    expectCommandError(() => readP3ECommand(["ADVANCE_YEAR", "standard"]), "command");
    for (const value of [null, undefined, 42, "ADVANCE_YEAR", true]) {
      expectCommandError(() => readP3ECommand(value), "command");
    }
  });

  it("Proxy 與反射 trap：例外不外洩、getter 不執行", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectCommandError(() => readP3ECommand(revoked.proxy), "command");
    expectCommandError(() => computeP3ECommandArgsHash(revoked.proxy), "command");

    let trapped = 0;
    const throwingTrap = new Proxy(
      { type: "ADVANCE_YEAR", contentMode: "standard" },
      {
        getOwnPropertyDescriptor() {
          trapped += 1;
          throw new TypeError("trap");
        }
      }
    );
    expectCommandError(() => readP3ECommand(throwingTrap), "command");
    expect(trapped).toBe(1);

    const protoTrap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new RangeError("proto");
        }
      }
    );
    expectCommandError(() => readP3ECommand(protoTrap), "command");

    const ownKeysTrap = new Proxy(
      {},
      {
        ownKeys() {
          throw new TypeError("ownKeys");
        }
      }
    );
    expectCommandError(() => readP3ECommand(ownKeysTrap), "command");
  });

  it("hash 入口同樣先驗證（不接受預先計算的 argsHash／額外欄位）", () => {
    const precomputed = { type: "ADVANCE_YEAR", contentMode: "standard", argsHash: "0".repeat(64) };
    expectCommandError(() => computeP3ECommandArgsHash(precomputed), "command");
    expectCommandError(() => computeP3ECommandArgsHash({ type: "ADVANCE_YEAR", contentMode: "hard" }), "command.contentMode");
    expectCommandError(() => computeP3ECommandArgsHash({ type: "CHOOSE_DECISION", optionId: "AB" }), "command.optionId");
  });
});

/* ------------------------------------------------------------------ */
/* 三、domain 分離                                                     */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2b domain 分離", () => {
  it("Args domain 與六個既有 domain 全部不同（同一 projection 也不同 hash）", () => {
    const projections: readonly unknown[] = [
      { type: "ADVANCE_YEAR", contentMode: "standard" },
      { type: "CHOOSE_DECISION", optionId: "dec.opt.alpha" }
    ];
    // 字面值互異
    const all = [ARGS_DOMAIN, ...OTHER_DOMAINS];
    expect(new Set(all).size).toBe(all.length);

    for (const projection of projections) {
      const argsHash = expectedArgsHash(ARGS_DOMAIN, projection);
      for (const other of OTHER_DOMAINS) {
        expect(argsHash).not.toBe(expectedArgsHash(other, projection));
      }
      // 被測函式算出來的就是 Args domain 的結果
      expect(computeP3ECommandArgsHash(projection)).toBe(argsHash);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 四、靜態門檻與公開表面                                              */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2b 靜態門檻", () => {
  const source = readFileSync(join(ROOT, "packages/simulation/src/command-envelope.ts"), "utf8");
  const stripComments = (value: string): string =>
    value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const code = stripComments(source);

  it("不進公開 barrel", () => {
    expect(typeof readP3ECommand).toBe("function");
    expect(typeof computeP3ECommandArgsHash).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.readP3ECommand).toBeUndefined();
    expect(surface.computeP3ECommandArgsHash).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });

  it("沒有時間／隨機／JSON.stringify／自製 canonicalizer", () => {
    for (const token of ["Math.random", "Date.now", "performance.now", "JSON.stringify", "JSON.parse", "new Date"]) {
      expect(code, token).not.toContain(token);
    }
    expect(code).toContain("canonicalBytes");
    expect(code).toContain("sha256Hex");
    expect(code).toContain("concatBytes");
    expect(code).toContain("ascii");
  });

  it("沒有 Ledger append／State seal／Replay／CommandHash", () => {
    for (const forbidden of [
      "append",
      "sealP3EState",
      "readP3EState",
      "computeP3EStateHash",
      "computeP3ECommandHash",
      "computeP3EYearEntryHash",
      "computeP3EYearChainHash",
      "computeP3ESnapshotHash",
      "computeP3EDeltaHash",
      "replay",
      "verify"
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("argsHash 只出現在文件與型別說明，不是欄位", () => {
    // projection 只有 { type, contentMode } 或 { type, optionId } 兩種
    expect(code).toContain("contentMode: command.contentMode");
    expect(code).toContain("optionId: command.optionId");
    expect(code).toContain('"LIFE1/P3E/COMMAND/ARGS/v1"');
  });

  it("只匯出兩個函式與一個型別", () => {
    const exported = [...source.matchAll(/^export (?:function|type|interface|const) (\w+)/gm)].map((match) => match[1]);
    expect(exported.sort()).toEqual(["P3ECommand", "computeP3ECommandArgsHash", "readP3ECommand"]);
  });
});

/* ------------------------------------------------------------------ */
/* 五、型別面                                                          */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-2b 型別面", () => {
  it("回傳型別是兩種命令的聯集（沒有第三種）", () => {
    const command: P3ECommand = readP3ECommand(choose("dec.opt.alpha"));
    if (command.type === "CHOOSE_DECISION") {
      expect(command.optionId).toBe("dec.opt.alpha");
    } else {
      throw new Error("expected CHOOSE_DECISION");
    }
    const advanceCommand: P3ECommand = readP3ECommand(advance("guardian"));
    if (advanceCommand.type === "ADVANCE_YEAR") {
      expect(advanceCommand.contentMode).toBe("guardian");
    } else {
      throw new Error("expected ADVANCE_YEAR");
    }
  });
});
