import { describe, expect, it } from "vitest";
import {
  ascii,
  concatBytes,
  deriveDomainState,
  deriveEventRngState,
  FALLBACK_RNG_STATE,
  readU32be,
  RngError,
  SeedError,
  seedDigest,
  sha256,
  u32be,
  Xoshiro128StarStar
} from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { applyZeroStateFallback, createP3EGenesisRng, deriveP3EDomainState } from "../src/rng";

/**
 * P3-E.1a-2a：三條 genesis RNG 游標。
 *
 * 這個檔案刻意**不**呼叫 `src/rng.ts` 內部的推導邏輯來當期待值：
 * 期待值一律由 engine 的**公開**入口（`deriveDomainState`／`deriveEventRngState`／
 * `Xoshiro128StarStar`）或本檔的獨立參考實作算出，否則「實作對實作」的測試
 * 無法抓到 KDF 佈局寫錯。
 */

const SEED = "p3e-1a-2a-seed";
const OTHER_SEED = "p3e-1a-2a-seed-2";
const BIRTH_YEAR = 2000;

/** engine 的 life domain state（burn 前）。 */
const lifePre = (seed: string = SEED) => deriveDomainState(seed, "life", "1.0.0");

/** 手動跑一次 `uniformBigInt(41n)`，回傳抽到的值與 burn 後的 state。 */
function manualBurn(seed: string = SEED): { drawn: bigint; state: contracts.P3EWordTuple } {
  const rng = new Xoshiro128StarStar(lifePre(seed));
  const drawn = rng.uniformBigInt(41n);
  return { drawn, state: rng.state };
}

/**
 * 獨立參考實作：engine `deriveDomainState` 的位元組佈局，但**不套用**
 * `^[a-z0-9_]{1,32}$` 的 domain 字元集限制（P3-E 的 death domain 含 `/`）。
 */
function referenceDomainState(seedText: string, domain: string, spec = "1.0.0"): readonly number[] {
  const domainBytes = ascii(domain);
  const specBytes = ascii(spec);
  const material = concatBytes(
    ascii("LIFE1/RNG/v1"),
    Uint8Array.of(0),
    seedDigest(seedText),
    u32be(domainBytes.length),
    domainBytes,
    u32be(specBytes.length),
    specBytes
  );
  const digest = sha256(material);
  return [readU32be(digest, 0), readU32be(digest, 4), readU32be(digest, 8), readU32be(digest, 12)];
}

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

const asObject = (value: unknown) => value as Record<string, unknown>;
const asMutableWords = (tuple: readonly number[]) => tuple as unknown as number[];

function expectFrozenTuple(tuple: readonly number[]): void {
  expect(tuple.length).toBe(4);
  expect(Object.isFrozen(tuple)).toBe(true);
  for (const word of tuple) {
    expect(Number.isInteger(word)).toBe(true);
    expect(word).toBeGreaterThanOrEqual(0);
    expect(word).toBeLessThanOrEqual(0xffffffff);
  }
  expect(() => {
    asMutableWords(tuple)[0] = 1;
  }).toThrow(TypeError);
}

/* ------------------------------------------------------------------ */
/* 一、本批的 contracts 增補與公開表面                                  */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2a stat 常數與公開表面", () => {
  it("contracts 加回 P3E_STAT_MIN／P3E_STAT_MAX，並由 simulation barrel 公開", () => {
    expect(contracts.P3E_STAT_MIN).toBe(0);
    expect(contracts.P3E_STAT_MAX).toBe(100);
    expect(simulation.P3E_STAT_MIN).toBe(0);
    expect(simulation.P3E_STAT_MAX).toBe(100);
    // 與 P3-A 的既有上限一致（P3-A 只有 MAX）。
    expect(contracts.P3E_STAT_MAX).toBe(100);
    expect(contracts.P3A_STAT_MAX).toBe(100);
  });

  it("stat 邊界是 0..100 且 min < max", () => {
    expect(contracts.P3E_STAT_MIN).toBeLessThan(contracts.P3E_STAT_MAX);
    expect(contracts.P3E_STAT_MIN).toBe(contracts.P3E_MIN_AGE);
    expect(contracts.P3E_STAT_MAX).toBe(contracts.P3A_STAT_MAX);
  });

  it("genesis 建立器與其內部輔助都不在公開 barrel", () => {
    const surface = asObject(simulation);
    expect(surface.createP3EGenesisRng).toBeUndefined();
    expect(surface.deriveP3EDomainState).toBeUndefined();
    expect(surface.applyZeroStateFallback).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });
});

/* ------------------------------------------------------------------ */
/* 二、life 游標                                                       */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2a life RNG（compatibility burn）", () => {
  it("initialState 等於 deriveDomainState(seed, \"life\", \"1.0.0\")", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(state.life.domain).toBe("life");
    expect(state.life.initialState).toEqual(lifePre());
    expect(state.life.initialState).toEqual(deriveDomainState(SEED, "life", "1.0.0"));
  });

  it("state 等於手動執行一次 uniformBigInt(41n) 之後的 state", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    const manual = manualBurn();
    expect(state.life.state).toEqual(manual.state);
  });

  it("burn 只推進 state，initialState 保持 burn 前", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(state.life.state).not.toEqual(state.life.initialState);
    expect(Object.isFrozen(state.life.initialState)).toBe(true);
    expect(Object.isFrozen(state.life.state)).toBe(true);
    expect(state.life.initialState).not.toBe(state.life.state);
  });

  it("semanticDraws === 1（burn 記 1 次語意抽樣）", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(state.life.semanticDraws).toBe(1);
    expect(state.life.semanticDraws).toBe(contracts.P3E_GENESIS_SEMANTIC_DRAWS);
  });

  it("burn 恰好一次：burn 兩次的 state 不得等於實作結果", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    const twice = new Xoshiro128StarStar(lifePre());
    twice.uniformBigInt(41n);
    twice.uniformBigInt(41n);
    expect(state.life.state).not.toEqual(twice.state);
  });

  it("burn 是 uniformBigInt(41n)，不是燒 1 個 u32", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    const oneU32 = new Xoshiro128StarStar(lifePre());
    oneU32.nextU32();
    expect(state.life.state).not.toEqual(oneU32.state);

    // uniformBigInt(41n) 一次 u64 ＝ 2 個 u32（41 不是 2 的次方，但 0..2^64-1 的
    // rejection 邊界在此輸入下不會觸發額外抽取，這一條只固定「不是 1 個 u32」）。
    const twoU32 = new Xoshiro128StarStar(lifePre());
    twoU32.nextU32();
    twoU32.nextU32();
    expect(state.life.state).toEqual(twoU32.state);
  });

  it("抽到的 0–40 不被保存、也不產生 lifespanYears", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    const { drawn } = manualBurn();
    expect(drawn).toBeGreaterThanOrEqual(0n);
    expect(drawn).toBeLessThan(contracts.P3E_LIFESPAN_BURN_BOUND);
    expect(Object.keys(state.life).sort()).toEqual(["domain", "initialState", "semanticDraws", "state"]);
    expect(asObject(state.life)).not.toHaveProperty("lifespanYears");
    expect(asObject(state.life)).not.toHaveProperty("burnedValue");
    expect(asObject(state.life)).not.toHaveProperty("drawn");
    expect(Object.keys(state).sort()).toEqual(["death", "events", "life"]);
  });
});

/* ------------------------------------------------------------------ */
/* 三、events 游標                                                     */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2a event RNG", () => {
  it("initialState 等於 deriveEventRngState(burn 前 life state, birthYear)", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(state.events.domain).toBe("events");
    expect(state.events.initialState).toEqual(deriveEventRngState(lifePre(), BIRTH_YEAR));
  });

  it("使用 burn 前的 state，不是 burn 後的 state", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    const burnedLife = manualBurn().state;
    expect(state.events.initialState).not.toEqual(deriveEventRngState(burnedLife, BIRTH_YEAR));
    expect(state.events.initialState).toEqual(deriveEventRngState(state.life.initialState, BIRTH_YEAR));
  });

  it("不 burn：initialState 等於 state 且 u32Draws === 0", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(state.events.initialState).toEqual(state.events.state);
    expect(state.events.u32Draws).toBe(0);
    expect(Object.isFrozen(state.events.initialState)).toBe(true);
    expect(Object.isFrozen(state.events.state)).toBe(true);
    // 兩個欄位不共用同一個實例（避免別名耦合）。
    expect(state.events.initialState).not.toBe(state.events.state);
  });

  it("birthYear 會改變 event 游標，且不同年份互不相同", () => {
    const seen = new Set<string>();
    for (const year of [1800, 1900, 2000, 2001, 2200]) {
      const state = createP3EGenesisRng(SEED, year);
      seen.add(state.events.initialState.join(","));
    }
    expect(seen.size).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/* 四、death 游標                                                      */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2a death RNG", () => {
  it("initialState 等於死亡 domain 的 deriveDomainState 佈局（`p3e/death`）", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(state.death.domain).toBe("p3e/death");
    expect(state.death.initialState).toEqual(referenceDomainState(SEED, "p3e/death"));
    expect(deriveP3EDomainState(SEED, "p3e/death")).toEqual(referenceDomainState(SEED, "p3e/death"));
  });

  it("engine 的 deriveDomainState 會拒絕 `p3e/death`（本模組放寬 domain 字元集的原因）", () => {
    const error = catchError(() => deriveDomainState(SEED, "p3e/death", "1.0.0"));
    expect(error).toBeInstanceOf(SeedError);
    expect((error as SeedError).code).toBe("BAD_DOMAIN");
  });

  it("對 engine 接受的任何 domain／spec，推導結果與 deriveDomainState 逐位元相同", () => {
    const domains = ["life", "events", "p3e_death", "a", "abcdefghij0123456789_"];
    const specs = ["1.0.0", "9.9.9", "x.y-z_1"];
    for (const domain of domains) {
      for (const spec of specs) {
        expect(deriveP3EDomainState(SEED, domain, spec), `${domain}/${spec}`).toEqual(
          deriveDomainState(SEED, domain, spec)
        );
      }
    }
  });

  it("不 burn：initialState 等於 state 且 u32Draws === 0", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(state.death.initialState).toEqual(state.death.state);
    expect(state.death.u32Draws).toBe(0);
    expect(Object.isFrozen(state.death.initialState)).toBe(true);
    expect(Object.isFrozen(state.death.state)).toBe(true);
    expect(state.death.initialState).not.toBe(state.death.state);
  });

  it("全零 state 走 engine 的 fallback", () => {
    const zero = Object.freeze([0, 0, 0, 0]) as contracts.P3EWordTuple;
    const fallback = applyZeroStateFallback(zero);
    expect(fallback).toEqual(FALLBACK_RNG_STATE);
    expect(fallback).not.toEqual(zero);
    expect(Object.isFrozen(fallback)).toBe(true);

    const nonZero = Object.freeze([1, 2, 3, 4]) as contracts.P3EWordTuple;
    expect(applyZeroStateFallback(nonZero)).toBe(nonZero);
  });

  it("非法 domain／spec 只拋固定 P3EError", () => {
    const badDomain = catchError(() => deriveP3EDomainState(SEED, ""));
    expect(isP3EError(badDomain)).toBe(true);
    expect((badDomain as P3EError).code).toBe("E_P3E_RNG");
    expect((badDomain as P3EError).path).toBe("domain");

    const notString = catchError(() => deriveP3EDomainState(SEED, 42 as unknown as string));
    expect((notString as P3EError).code).toBe("E_P3E_RNG");
    expect((notString as P3EError).path).toBe("domain");

    const badSpec = catchError(() => deriveP3EDomainState(SEED, "life", ""));
    expect((badSpec as P3EError).code).toBe("E_P3E_RNG");
    expect((badSpec as P3EError).path).toBe("spec");
  });
});

/* ------------------------------------------------------------------ */
/* 五、跨游標性質                                                      */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2a 三條游標的交互性質", () => {
  it("三個 domain 各自正確", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect([state.life.domain, state.events.domain, state.death.domain]).toEqual([
      contracts.P3E_LIFE_DOMAIN,
      contracts.P3E_EVENT_DOMAIN,
      contracts.P3E_DEATH_DOMAIN
    ]);
    expect(state.death.domain).toBe("p3e/death");
  });

  it("event／death 的 u32Draws 都是 0", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(state.events.u32Draws).toBe(0);
    expect(state.death.u32Draws).toBe(0);
    expect(state.life.semanticDraws).toBe(1);
  });

  it("改 seed 會改變三條 state", () => {
    const first = createP3EGenesisRng(SEED, BIRTH_YEAR);
    const second = createP3EGenesisRng(OTHER_SEED, BIRTH_YEAR);
    expect(second.life.state).not.toEqual(first.life.state);
    expect(second.life.initialState).not.toEqual(first.life.initialState);
    expect(second.events.initialState).not.toEqual(first.events.initialState);
    expect(second.death.initialState).not.toEqual(first.death.initialState);
  });

  it("改 birthYear 只影響 event 游標，不影響 life／death", () => {
    const first = createP3EGenesisRng(SEED, 2000);
    const second = createP3EGenesisRng(SEED, 2001);
    expect(second.life).toEqual(first.life);
    expect(second.death).toEqual(first.death);
    expect(second.events.initialState).not.toEqual(first.events.initialState);
  });

  it("birthYear 邊界 1800／2200 合法，1799／2201 拒絕", () => {
    expect(createP3EGenesisRng(SEED, 1800).events.initialState).toHaveLength(4);
    expect(createP3EGenesisRng(SEED, 2200).events.initialState).toHaveLength(4);
    for (const year of [1799, 2201]) {
      const error = catchError(() => createP3EGenesisRng(SEED, year));
      expect(isP3EError(error)).toBe(true);
      expect((error as P3EError).code).toBe("E_P3E_ARGUMENT");
    }
  });

  it("沒有任何游標是全零", () => {
    for (const seed of ["a", "b", "c", SEED, OTHER_SEED, "種子", "seed with spaces"]) {
      const state = createP3EGenesisRng(seed, BIRTH_YEAR);
      for (const tuple of [
        state.life.initialState,
        state.life.state,
        state.events.initialState,
        state.events.state,
        state.death.initialState,
        state.death.state
      ]) {
        expect(tuple.some((word) => word !== 0), seed).toBe(true);
      }
    }
  });

  it("同樣輸入完全決定性（含物件內容與 tuple 值）", () => {
    const first = createP3EGenesisRng(SEED, BIRTH_YEAR);
    const second = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(second).toEqual(first);
    expect(second.life).not.toBe(first.life);
    expect(second.events).not.toBe(first.events);
    expect(second.death).not.toBe(first.death);
  });

  it("seed 走 engine 的 normalizeSeed（trim／NFC），與 P3-A／P3-C 一致", () => {
    const trimmed = createP3EGenesisRng(`  ${SEED}  `, BIRTH_YEAR);
    expect(trimmed).toEqual(createP3EGenesisRng(SEED, BIRTH_YEAR));

    const composed = createP3EGenesisRng("caf\u00e9", BIRTH_YEAR);
    const decomposed = createP3EGenesisRng("cafe\u0301", BIRTH_YEAR);
    expect(decomposed).toEqual(composed);
  });
});

/* ------------------------------------------------------------------ */
/* 六、深層凍結                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2a 深層凍結", () => {
  it("回傳物件、三個游標與六個 tuple 全部凍結", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.life)).toBe(true);
    expect(Object.isFrozen(state.events)).toBe(true);
    expect(Object.isFrozen(state.death)).toBe(true);
    expectFrozenTuple(state.life.initialState);
    expectFrozenTuple(state.life.state);
    expectFrozenTuple(state.events.initialState);
    expectFrozenTuple(state.events.state);
    expectFrozenTuple(state.death.initialState);
    expectFrozenTuple(state.death.state);
  });

  it("改不動回傳值（嚴格模式下寫入即拋 TypeError）", () => {
    const state = createP3EGenesisRng(SEED, BIRTH_YEAR);
    expect(() => {
      asObject(state).life = null;
    }).toThrow(TypeError);
    expect(() => {
      asObject(state.life).semanticDraws = 99;
    }).toThrow(TypeError);
    expect(() => {
      asObject(state.events).u32Draws = 8;
    }).toThrow(TypeError);
    expect(() => {
      asObject(state.death).domain = "events";
    }).toThrow(TypeError);
    expect(state.life.semanticDraws).toBe(1);
    expect(state.events.u32Draws).toBe(0);
    expect(state.death.domain).toBe("p3e/death");
  });
});

/* ------------------------------------------------------------------ */
/* 七、錯誤邊界                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2a 非法輸入只拋固定 P3EError", () => {
  const BAD_SEEDS: readonly unknown[] = [
    undefined,
    null,
    42,
    true,
    "",
    "   ",
    "\u0001seed",
    "x".repeat(129),
    {},
    []
  ];

  it("非法 seed 一律 E_P3E_ARGUMENT at seed，且不外洩 engine 例外", () => {
    for (const seed of BAD_SEEDS) {
      const error = catchError(() => createP3EGenesisRng(seed as never, BIRTH_YEAR));
      expect(isP3EError(error), String(seed)).toBe(true);
      const p3e = error as P3EError;
      expect(p3e.code).toBe("E_P3E_ARGUMENT");
      expect(p3e.path).toBe("seed");
      expect(p3e.message).toBe("E_P3E_ARGUMENT at seed");
      expect(p3e.name).toBe("P3EError");
      expect(error instanceof SeedError).toBe(false);
      expect(error instanceof RngError).toBe(false);
      expect(error instanceof TypeError).toBe(false);
    }
  });

  const BAD_YEARS: readonly unknown[] = [
    1799,
    2201,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "2000",
    null,
    undefined,
    2000n
  ];

  it("非法 birthYear 一律 E_P3E_ARGUMENT at birthYear，且不外洩原生例外", () => {
    for (const year of BAD_YEARS) {
      const error = catchError(() => createP3EGenesisRng(SEED, year as never));
      expect(isP3EError(error), String(year)).toBe(true);
      const p3e = error as P3EError;
      expect(p3e.code).toBe("E_P3E_ARGUMENT");
      expect(p3e.path).toBe("birthYear");
      expect(p3e.message).toBe("E_P3E_ARGUMENT at birthYear");
      expect(error instanceof SeedError).toBe(false);
      expect(error instanceof RngError).toBe(false);
      expect(error instanceof TypeError).toBe(false);
    }
  });

  it("seed 先於 birthYear 驗證（兩個都非法時回 seed）", () => {
    const error = catchError(() => createP3EGenesisRng("" as never, 1799 as never));
    expect((error as P3EError).path).toBe("seed");
  });

  it("合法輸入不會拋任何例外", () => {
    expect(() => createP3EGenesisRng(SEED, 1800)).not.toThrow();
    expect(() => createP3EGenesisRng("種子", 2200)).not.toThrow();
    expect(() => createP3EGenesisRng("a".repeat(128), 2000)).not.toThrow();
  });
});
