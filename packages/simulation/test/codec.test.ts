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
import { deriveEventRngState, MoneyError, RngError, validateEventPack, Xoshiro128StarStar } from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { createP3EGenesis } from "../src/genesis";
import { decodeP3EState, encodeP3EState } from "../src/codec";
import { computeP3EStateHash } from "../src/state-hash";

/**
 * P3-E.1a-2c-3b：決定性 state codec。
 *
 * fixture 用真實的 P2-A／P2-B／P3-B／P3-D 驗證器產生；`encode` 需要合法 state，
 * 因此先用 `createP3EGenesis` 造一個（age=0，assets 不在 invariants 內，方便測金額字串）。
 */

const SEED = "p3e-2c-3b-codec";
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

const readJson = (relativePath: string): unknown => JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));

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

const eventPack = validateEventPack({
  manifest: readJson("fixtures/p3b/manifest.v1.json"),
  events: (readJson("fixtures/p3b/events.v1.json") as { records: unknown[] }).records
} as never);

const deathPack = validateDeathPack(
  {
    manifest: readJson("fixtures/p3d/manifest.v1.json"),
    datasets: {
      "cause-registry": readJson("fixtures/p3d/cause-registry.v1.json"),
      "cause-weights": readJson("fixtures/p3d/cause-weights.v1.json"),
      mortality: readJson("fixtures/p3d/mortality.v1.json"),
      licenses: readJson("fixtures/p3d/licenses.v1.json"),
      lineage: readJson("fixtures/p3d/lineage.v1.json")
    }
  } as never,
  base
);

const certificate = createBirthCertificate(
  base,
  identityPack,
  buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never),
  SEED
);

const genesisState = createP3EGenesis({ masterSeed: SEED, basePack: base, identityPack, certificate, eventPack, deathPack });
const genesisJson = encodeP3EState(genesisState);

/* ------------------------------------------------------------------ */
/* 合法 age>0 fixture（flags／occurrences／非零金額）                  */
/* ------------------------------------------------------------------ */

const LIFE_INITIAL: readonly [number, number, number, number] = [11, 12, 13, 14];
const DEATH_INITIAL: readonly [number, number, number, number] = [41, 42, 43, 44];
const AGED = 30;

function toWords(words: readonly number[]): [number, number, number, number] {
  return [words[0] as number, words[1] as number, words[2] as number, words[3] as number];
}

/** 一次 burn ＋ 每年四次語意抽樣（用 engine 原語獨立算）。 */
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

const agedState: contracts.P3ELifeState = (() => {
  const birthYear = certificate.player.birth.birthYear;
  const years = BigInt(AGED);
  const eventInitial = toWords(deriveEventRngState(LIFE_INITIAL, birthYear));
  const draft = {
    ...genesisState,
    currentYear: birthYear + AGED,
    age: AGED,
    phase: "life" as const,
    assets: {
      balanceMicroUsd: 1_900_000n,
      annualIncomeMicroUsd: contracts.P3E_INCOME_BASE_MICRO_USD + years * contracts.P3E_INCOME_PER_YEAR_MICRO_USD,
      annualExpenseMicroUsd: contracts.P3E_EXPENSE_BASE_MICRO_USD + years * contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD
    },
    flags: ["p3e:flag-a", "p3e:flag-b"],
    occurrences: [
      { eventId: "ev-a", count: 1, lastYear: birthYear + 1 },
      { eventId: "ev-b", count: 2, lastYear: birthYear + 20 }
    ],
    rng: {
      life: {
        domain: "life" as const,
        initialState: LIFE_INITIAL,
        state: lifeCursorAt(AGED),
        semanticDraws: contracts.P3E_GENESIS_SEMANTIC_DRAWS + contracts.P3E_ROLL_SEMANTIC_DRAWS * AGED
      },
      events: {
        domain: "events" as const,
        initialState: eventInitial,
        state: advance(eventInitial, 2 * AGED),
        u32Draws: 2 * AGED
      },
      death: {
        domain: "p3e/death" as const,
        initialState: DEATH_INITIAL,
        state: advance(DEATH_INITIAL, 2 * AGED),
        u32Draws: 2 * AGED
      }
    },
    heads: {
      lastEntryHash: "a".repeat(64),
      lastSnapshotHash: "b".repeat(64),
      lastDeltaHash: "c".repeat(64),
      hashChain: "d".repeat(64)
    },
    commandLog: { count: 3, headHash: "e".repeat(64) }
  };
  return { ...draft, stateHash: computeP3EStateHash(draft as never) } as contracts.P3ELifeState;
})();

const STATE_KEYS = [
  "schemaVersion",
  "rulesetVersion",
  "rollSpecVersion",
  "lifeSpecVersion",
  "contentVersion",
  "saveFormatVersion",
  "engineVersion",
  "rngSpecVersion",
  "identity",
  "packs",
  "currentYear",
  "age",
  "phase",
  "pendingDecision",
  "stats",
  "assets",
  "flags",
  "occurrences",
  "rng",
  "heads",
  "commandLog",
  "stateHash"
] as const;

/* ------------------------------------------------------------------ */
/* 輔助                                                                */
/* ------------------------------------------------------------------ */

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function expectCodecError(run: () => unknown, code: string, path: string): void {
  const caught = caughtFrom(run);
  expect(isP3EError(caught), `${code} at ${path}`).toBe(true);
  const error = caught as P3EError;
  expect(error.code, `path ${path}`).toBe(code);
  expect(error.path).toBe(path);
  expect(error.message).toBe(`${code} at ${path}`);
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
  expect(caught instanceof RngError).toBe(false);
  expect(caught instanceof MoneyError).toBe(false);
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  const record = value as Dict;
  return Object.keys(record).every((key) => isDeepFrozen(record[key]));
}

/** canonical JSON → 可變物件（再轉回 bigint 金額，方便重算 hash）。 */
function parsedJson(text: string = genesisJson): Dict {
  return JSON.parse(text) as Dict;
}

function stateFromJson(json: Dict): Dict {
  const assets = json.assets as Dict;
  return {
    ...json,
    assets: {
      balanceMicroUsd: BigInt(assets.balanceMicroUsd as string),
      annualIncomeMicroUsd: BigInt(assets.annualIncomeMicroUsd as string),
      annualExpenseMicroUsd: BigInt(assets.annualExpenseMicroUsd as string)
    }
  };
}

/** 改一個欄位並把 stateHash 重算寫回 JSON（金額維持字串，避免 JSON.stringify bigint）。 */
function encodedWith(change: (json: Dict) => void): string {
  const json = parsedJson();
  change(json);
  const hash = computeP3EStateHash(stateFromJson(json) as never);
  return JSON.stringify({ ...json, stateHash: hash });
}

/* ------------------------------------------------------------------ */
/* 一、roundtrip 與決定性                                              */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3b roundtrip", () => {
  it("decode(encode(state)) 逐欄等於原 state，且輸出深層凍結", () => {
    const decoded = decodeP3EState(genesisJson);
    expect(decoded).toEqual(genesisState);
    expect(decoded).not.toBe(genesisState);
    expect(isDeepFrozen(decoded)).toBe(true);
    expect(decoded.stateHash).toBe(genesisState.stateHash);
  });

  it("age>0 的 state（flags／occurrences／非零金額）也能 roundtrip", () => {
    const text = encodeP3EState(agedState);
    const decoded = decodeP3EState(text);
    expect(decoded).toEqual(agedState);
    expect(encodeP3EState(decoded)).toBe(text);
    expect(decoded.flags.length).toBe(2);
    expect(decoded.occurrences.length).toBe(2);
    expect(decoded.assets.annualIncomeMicroUsd).toBe(
      contracts.P3E_INCOME_BASE_MICRO_USD + BigInt(AGED) * contracts.P3E_INCOME_PER_YEAR_MICRO_USD
    );
    const parsed = JSON.parse(text) as Dict;
    expect((parsed.occurrences as Dict[])[0]).toEqual({ eventId: "ev-a", count: 1, lastYear: certificate.player.birth.birthYear + 1 });
    expect((parsed.flags as string[])).toEqual(["p3e:flag-a", "p3e:flag-b"]);
  });

  it("重複 encode 是 byte-identical", () => {
    expect(encodeP3EState(genesisState)).toBe(genesisJson);
    expect(encodeP3EState(decodeP3EState(genesisJson))).toBe(genesisJson);
    for (let index = 0; index < 5; index += 1) {
      expect(encodeP3EState(genesisState)).toBe(genesisJson);
    }
  });

  it("canonical 鍵序固定、沒有空白", () => {
    const parsed = parsedJson();
    expect(Object.keys(parsed)).toEqual([...STATE_KEYS]);
    expect(Object.keys(parsed.identity as Dict)).toEqual([
      "entityId",
      "regionCode",
      "sex",
      "birthYear",
      "certificateId",
      "certificateHash",
      "playerIdentityHash",
      "masterSeedHash",
      "basePackId",
      "basePackChecksum",
      "identityPackId",
      "identityPackChecksum"
    ]);
    expect(Object.keys((parsed.packs as Dict).events as Dict)).toEqual([
      "eventSchemaVersion",
      "eventSpecVersion",
      "contentPackVersion",
      "eventPackId",
      "eventPackChecksum",
      "datasetChecksum",
      "eventCount"
    ]);
    expect(Object.keys((parsed.packs as Dict).death as Dict)).toEqual([
      "schemaVersion",
      "deathDataVersion",
      "deathSpecVersion",
      "healthRuleVersion",
      "engineVersion",
      "rngSpecVersion",
      "deathPackId",
      "deathPackChecksum",
      "basePackId",
      "basePackChecksum",
      "entityCount"
    ]);
    expect(Object.keys(parsed.rng as Dict)).toEqual(["life", "events", "death"]);
    expect(Object.keys((parsed.rng as Dict).life as Dict)).toEqual(["domain", "initialState", "state", "semanticDraws"]);
    expect(Object.keys(parsed.heads as Dict)).toEqual([
      "lastEntryHash",
      "lastSnapshotHash",
      "lastDeltaHash",
      "hashChain"
    ]);
    expect(Object.keys(parsed.commandLog as Dict)).toEqual(["count", "headHash"]);
    expect(Object.keys(parsed.assets as Dict)).toEqual([
      "balanceMicroUsd",
      "annualIncomeMicroUsd",
      "annualExpenseMicroUsd"
    ]);
    expect(genesisJson.startsWith('{"schemaVersion"')).toBe(true);
    expect(genesisJson).not.toContain("\n");
    expect(genesisJson).not.toContain(" ");
  });

  it("金額是 canonical 十進位字串（不是 number，也沒有前導零）", () => {
    const assets = parsedJson().assets as Dict;
    for (const key of ["balanceMicroUsd", "annualIncomeMicroUsd", "annualExpenseMicroUsd"]) {
      expect(typeof assets[key]).toBe("string");
      expect(assets[key]).toMatch(/^-?(?:0|[1-9][0-9]*)$/);
    }
    expect(assets.balanceMicroUsd).toBe("0");
    expect(genesisJson).toContain('"balanceMicroUsd":"0"');
  });

  it("非零與負餘額可以 roundtrip（age=0 時 assets 不在 invariants 內）", () => {
    for (const [balance, income, expense] of [
      ["-1", "400000", "2100000"],
      ["1900000", "0", "0"],
      ["-1000000000000000000", "1", "1"]
    ] as const) {
      const text = encodedWith((json) => {
        const assets = json.assets as Dict;
        assets.balanceMicroUsd = balance;
        assets.annualIncomeMicroUsd = income;
        assets.annualExpenseMicroUsd = expense;
      });
      const decoded = decodeP3EState(text);
      expect(decoded.assets).toEqual({
        balanceMicroUsd: BigInt(balance),
        annualIncomeMicroUsd: BigInt(income),
        annualExpenseMicroUsd: BigInt(expense)
      });
      expect(encodeP3EState(decoded)).toBe(text);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 二、encode 的信任邊界                                               */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3b encode", () => {
  it("未驗證的物件一律拒絕（保留 readP3EState 的精確錯誤）", () => {
    expectCodecError(() => encodeP3EState(null), "E_P3E_STATE", "state");
    expectCodecError(() => encodeP3EState(42), "E_P3E_STATE", "state");
    expectCodecError(() => encodeP3EState({}), "E_P3E_STATE", "state");
  });

  it("stateHash 不符 → E_P3E_HASH at stateHash", () => {
    const broken = structuredClone(genesisState) as unknown as Dict;
    broken.stateHash = "0".repeat(64);
    expectCodecError(() => encodeP3EState(broken), "E_P3E_HASH", "stateHash");
  });

  it("語意不合法的 state 也拒絕（例：currentYear 與 hash 一起被改）", () => {
    const broken = parsedJson();
    broken.currentYear = (broken.currentYear as number) + 1;
    const rebuilt = stateFromJson(broken);
    rebuilt.stateHash = computeP3EStateHash(rebuilt as never);
    expectCodecError(() => encodeP3EState(rebuilt), "E_P3E_STATE", "currentYear");
  });

  it("不修改輸入", () => {
    const before = encodeP3EState(genesisState);
    encodeP3EState(genesisState);
    expect(encodeP3EState(genesisState)).toBe(before);
    expect(genesisState.stateHash).toBe(JSON.parse(before).stateHash);
  });
});

/* ------------------------------------------------------------------ */
/* 三、decode 的傳輸層錯誤                                             */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3b decode 傳輸層", () => {
  it("非字串／過長／非法 JSON → E_P3E_CODEC at input", () => {
    for (const value of [null, undefined, 42, {}, [], genesisState]) {
      expectCodecError(() => decodeP3EState(value), "E_P3E_CODEC", "input");
    }
    expectCodecError(() => decodeP3EState("{"), "E_P3E_CODEC", "input");
    expectCodecError(() => decodeP3EState("not json"), "E_P3E_CODEC", "input");
    expectCodecError(() => decodeP3EState("x".repeat(1_048_577)), "E_P3E_CODEC", "input");
    // 剛好在上限內但不是合法 JSON，仍走 parse 錯誤
    expectCodecError(() => decodeP3EState("x".repeat(1_048_576)), "E_P3E_CODEC", "input");
  });

  it("JSON 不是物件 → E_P3E_CODEC at state", () => {
    for (const text of ["null", "[]", "42", '"x"', "true"]) {
      expectCodecError(() => decodeP3EState(text), "E_P3E_CODEC", "state");
    }
  });

  it("頂層欄位多／少 → E_P3E_CODEC at state", () => {
    const missing = parsedJson();
    delete missing.age;
    expectCodecError(() => decodeP3EState(JSON.stringify(missing)), "E_P3E_CODEC", "state");

    const extra = parsedJson();
    extra.extraField = 1;
    expectCodecError(() => decodeP3EState(JSON.stringify(extra)), "E_P3E_CODEC", "state");

    // 鍵數相同但鍵名被換掉
    const renamed = parsedJson();
    delete renamed.age;
    renamed.years = 0;
    expectCodecError(() => decodeP3EState(JSON.stringify(renamed)), "E_P3E_CODEC", "state");
  });

  it("污染鍵 → E_P3E_CODEC at state", () => {
    // 用字串替換讓 "__proto__" 成為**自有鍵**（直接賦值會改 prototype）
    const polluted = genesisJson.replace('"age":0', '"__proto__":0');
    expect(polluted).toContain('"__proto__"');
    expectCodecError(() => decodeP3EState(polluted), "E_P3E_CODEC", "state");
  });

  it("assets 形狀／鍵名錯誤 → E_P3E_CODEC at assets", () => {
    const notObject = parsedJson();
    notObject.assets = "x";
    expectCodecError(() => decodeP3EState(JSON.stringify(notObject)), "E_P3E_CODEC", "assets");

    const missingKey = parsedJson();
    delete (missingKey.assets as Dict).annualExpenseMicroUsd;
    expectCodecError(() => decodeP3EState(JSON.stringify(missingKey)), "E_P3E_CODEC", "assets");

    const renamedKey = parsedJson();
    const assets = renamedKey.assets as Dict;
    delete assets.balanceMicroUsd;
    assets.balance = "0";
    expectCodecError(() => decodeP3EState(JSON.stringify(renamedKey)), "E_P3E_CODEC", "assets");
  });

  it("非 canonical 金額字串 → E_P3E_CODEC at 對應欄位", () => {
    const cases: readonly [unknown, string][] = [
      ["00", "assets.balanceMicroUsd"],
      ["01", "assets.balanceMicroUsd"],
      ["-0", "assets.balanceMicroUsd"],
      ["+1", "assets.balanceMicroUsd"],
      ["1e3", "assets.balanceMicroUsd"],
      [" 1", "assets.balanceMicroUsd"],
      ["1.0", "assets.balanceMicroUsd"],
      ["", "assets.balanceMicroUsd"],
      [0, "assets.balanceMicroUsd"],
      [null, "assets.balanceMicroUsd"],
      ["0x10", "assets.annualIncomeMicroUsd"],
      ["1 ", "assets.annualExpenseMicroUsd"]
    ];
    for (const [value, path] of cases) {
      const json = parsedJson();
      if (path === "assets.balanceMicroUsd") (json.assets as Dict).balanceMicroUsd = value as never;
      if (path === "assets.annualIncomeMicroUsd") (json.assets as Dict).annualIncomeMicroUsd = value as never;
      if (path === "assets.annualExpenseMicroUsd") (json.assets as Dict).annualExpenseMicroUsd = value as never;
      expectCodecError(() => decodeP3EState(JSON.stringify(json)), "E_P3E_CODEC", path);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 四、decode 把 state 層錯誤原樣轉出                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3b decode 委派 readP3EState", () => {
  it("stateHash 被改 → E_P3E_HASH at stateHash（不重算、不重簽）", () => {
    const json = parsedJson();
    json.stateHash = "0".repeat(64);
    expectCodecError(() => decodeP3EState(JSON.stringify(json)), "E_P3E_HASH", "stateHash");
  });

  it("權威欄位被改但 hash 沒更新 → E_P3E_HASH（證明沒有用 seal 重簽）", () => {
    // age=0 的 assets 不受 invariants 約束，因此唯一會被發現的方法就是 hash 不符。
    const json = parsedJson();
    (json.assets as Dict).balanceMicroUsd = "1";
    expectCodecError(() => decodeP3EState(JSON.stringify(json)), "E_P3E_HASH", "stateHash");

    // 改 identity 會先被 genesis integrity 抓到（語意錯誤先於 hash，符合 2c-2b 的順序）
    const changedIdentity = parsedJson();
    (changedIdentity.identity as Dict).entityId = "cr:ALB";
    expectCodecError(() => decodeP3EState(JSON.stringify(changedIdentity)), "E_P3E_HISTORY", "heads.lastEntryHash");
  });

  it("hash 同步更新後，語意錯誤仍以精確 path 回報", () => {
    const changedYear = encodedWith((json) => {
      json.currentYear = (json.currentYear as number) + 1;
    });
    expectCodecError(() => decodeP3EState(changedYear), "E_P3E_STATE", "currentYear");

    const badStat = encodedWith((json) => {
      (json.stats as Dict).health = 200;
    });
    expectCodecError(() => decodeP3EState(badStat), "E_P3E_STATE", "stats.health");

    // 缺欄位時無法重算 hash（projection 需要完整欄位），因此保留舊 hash：
    // shape 會先於 hash 檢查擋下，path 仍是精確的 identity。
    const missingIdentityField = parsedJson();
    delete (missingIdentityField.identity as Dict).entityId;
    expectCodecError(() => decodeP3EState(JSON.stringify(missingIdentityField)), "E_P3E_IDENTITY", "identity");

    const badHash = encodedWith((json) => {
      (json.heads as Dict).hashChain = "not-hex";
    });
    expectCodecError(() => decodeP3EState(badHash), "E_P3E_HISTORY", "heads.hashChain");
  });

  it("Infinity／unsafe integer 由 readP3EState 以精確 path 拒絕", () => {
    // 1e999 是合法 JSON，但會 parse 成 Infinity；shape 會先於 hash 檢查擋下
    const infinity = genesisJson.replace(`"currentYear":${genesisState.currentYear}`, '"currentYear":1e999');
    expect(infinity).toContain("1e999");
    expectCodecError(() => decodeP3EState(infinity), "E_P3E_STATE", "currentYear");

    const fractional = parsedJson();
    fractional.age = 0.5;
    expectCodecError(() => decodeP3EState(JSON.stringify(fractional)), "E_P3E_STATE", "age");
  });
});

/* ------------------------------------------------------------------ */
/* 五、公開表面                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3b 公開表面", () => {
  it("encode/decode 不在公開 barrel", () => {
    expect(typeof encodeP3EState).toBe("function");
    expect(typeof decodeP3EState).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.encodeP3EState).toBeUndefined();
    expect(surface.decodeP3EState).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });
});

/* ------------------------------------------------------------------ */
/* P3-E.1b-1f-0：pendingDecision 的存檔（p3e-2）                        */
/* ------------------------------------------------------------------ */

const PENDING_SUMMARY: contracts.P3EPendingDecisionSummary = {
  year: certificate.player.birth.birthYear + AGED,
  age: AGED,
  eventId: "ev.adult.housing-choice",
  decisionId: "dec.adult.housing",
  selectionHash: "f".repeat(64),
  optionIds: ["rent", "save"]
};

const pendingState: contracts.P3ELifeState = (() => {
  const draft = { ...agedState, phase: "pending_decision" as const, pendingDecision: PENDING_SUMMARY };
  return { ...draft, stateHash: computeP3EStateHash(draft as never) } as contracts.P3ELifeState;
})();

function pendingJson(): Dict {
  return JSON.parse(encodeP3EState(pendingState)) as Dict;
}

/** 改 JSON 並重算 hash（金額字串保持原樣）。 */
function pendingWith(change: (json: Dict) => void): string {
  const json = pendingJson();
  change(json);
  const hash = computeP3EStateHash(stateFromJson(json) as never);
  return JSON.stringify({ ...json, stateHash: hash });
}

describe("P3-E.1b-1f-0 pendingDecision codec", () => {
  it("null 的 round-trip（既有 fixture）", () => {
    const decoded = decodeP3EState(genesisJson);
    expect(decoded.pendingDecision).toBeNull();
    expect(encodeP3EState(decoded)).toBe(genesisJson);
  });

  it("非 null 的 round-trip：六欄與 optionIds 完全保留", () => {
    const text = encodeP3EState(pendingState);
    const decoded = decodeP3EState(text);

    expect(decoded).toEqual(pendingState);
    expect(decoded.pendingDecision).toEqual(PENDING_SUMMARY);
    expect(decoded.pendingDecision?.optionIds).toEqual(["rent", "save"]);
    expect(isDeepFrozen(decoded)).toBe(true);
    expect(isDeepFrozen(decoded.pendingDecision)).toBe(true);

    // 決定性：重複編碼 byte-identical
    expect(encodeP3EState(pendingState)).toBe(text);
    expect(encodeP3EState(decoded)).toBe(text);

    // canonical 鍵序：pendingDecision 在 phase 之後
    const parsed = pendingJson();
    expect(Object.keys(parsed)).toEqual([...STATE_KEYS]);
    expect(Object.keys(parsed.pendingDecision as Dict)).toEqual([
      "year",
      "age",
      "eventId",
      "decisionId",
      "selectionHash",
      "optionIds"
    ]);
  });

  it("舊格式（p3e-1／saveFormatVersion 5）被明確拒絕", () => {
    for (const [key, oldValue] of [
      ["schemaVersion", "p3e-1"],
      ["saveFormatVersion", 5]
    ] as const) {
      const text = pendingWith((json) => {
        json[key] = oldValue;
      });
      expectCodecError(() => decodeP3EState(text), "E_P3E_VERSION", key);
    }
  });

  it("缺少 pendingDecision 的舊 payload 不被自動補值", () => {
    const json = pendingJson();
    delete json.pendingDecision;
    expectCodecError(() => decodeP3EState(JSON.stringify(json)), "E_P3E_CODEC", "state");

    // 就算把它補成 null 也不行：phase 仍是 pending_decision，語意不變量直接拒絕
    const nulled = pendingJson();
    nulled.pendingDecision = null;
    expectCodecError(() => decodeP3EState(JSON.stringify(nulled)), "E_P3E_DECISION", "pendingDecision");
  });

  it("非法 pending payload 不會被 re-seal 或修復", () => {
    // 空 optionIds：shape 直接拒絕（即使 hash 自洽）
    const emptyOptions = pendingWith((json) => {
      (json.pendingDecision as Dict).optionIds = [];
    });
    expectCodecError(() => decodeP3EState(emptyOptions), "E_P3E_DECISION", "pendingDecision.optionIds");

    // year 與 State 不一致：語意不變量拒絕
    const wrongYear = pendingWith((json) => {
      (json.pendingDecision as Dict).year = (json.currentYear as number) + 1;
    });
    expectCodecError(() => decodeP3EState(wrongYear), "E_P3E_DECISION", "pendingDecision.year");

    // 直接改摘要但沒有更新 hash → E_P3E_HASH（不會重算後放行）
    const tampered = pendingJson();
    (tampered.pendingDecision as Dict).eventId = "ev.other";
    expectCodecError(() => decodeP3EState(JSON.stringify(tampered)), "E_P3E_HASH", "stateHash");
  });
});