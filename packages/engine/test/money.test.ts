import { describe, expect, it } from "vitest";
import type { MoneyString } from "@life-sim/contracts";
import { isMoneyString } from "@life-sim/contracts";
import {
  MAX_MONEY_PPP_MICRO,
  MIN_MONEY_PPP_MICRO,
  MoneyError,
  asPppMicro,
  decodeMoney,
  encodeMoney,
  moneyAbs,
  moneyAdd,
  moneyCompare,
  moneyDivFloor,
  moneyDivRoundHalfEven,
  moneyFromJson,
  moneyIsZero,
  moneyNeg,
  moneySub,
  moneyToJson,
  type PppMicro
} from "../src";

describe("PPP_USD_MICRO money", () => {
  it("accepts range boundaries and arithmetic", () => {
    const zero = asPppMicro(0n);
    const one = asPppMicro(1_000_000n);
    expect(moneyAdd(zero, one)).toBe(1_000_000n);
    expect(moneySub(one, zero)).toBe(1_000_000n);
    expect(moneyNeg(one)).toBe(-1_000_000n);
    expect(moneyAbs(asPppMicro(-5n))).toBe(5n);
    expect(moneyCompare(one, zero)).toBe(1);
    expect(moneyIsZero(zero)).toBe(true);
    expect(asPppMicro(MAX_MONEY_PPP_MICRO)).toBe(MAX_MONEY_PPP_MICRO);
    expect(asPppMicro(MIN_MONEY_PPP_MICRO)).toBe(MIN_MONEY_PPP_MICRO);
  });

  it("rejects range overflow and underflow", () => {
    expect(() => asPppMicro(MAX_MONEY_PPP_MICRO + 1n)).toThrow(MoneyError);
    expect(() => asPppMicro(MIN_MONEY_PPP_MICRO - 1n)).toThrow(MoneyError);
    expect(() => moneyAdd(asPppMicro(MAX_MONEY_PPP_MICRO), asPppMicro(1n))).toThrow(MoneyError);
  });

  it("rejects Number and BigInt mixing", () => {
    expect(() => asPppMicro(1 as unknown as bigint)).toThrow(MoneyError);
    expect(() => moneyAdd(1 as unknown as PppMicro, asPppMicro(1n))).toThrow(MoneyError);
    expect(() => moneyAdd(asPppMicro(1n), 2 as unknown as PppMicro)).toThrow(MoneyError);
  });

  it("floors toward negative infinity with either divisor sign", () => {
    expect(moneyDivFloor(asPppMicro(5n), 2n)).toBe(2n);
    expect(moneyDivFloor(asPppMicro(-5n), 2n)).toBe(-3n);
    expect(moneyDivFloor(asPppMicro(5n), -2n)).toBe(-3n);
    expect(moneyDivFloor(asPppMicro(-5n), -2n)).toBe(2n);
    expect(moneyDivFloor(asPppMicro(6n), 3n)).toBe(2n);
    expect(moneyDivFloor(asPppMicro(-6n), 3n)).toBe(-2n);
  });

  it("rounds half to even with either divisor sign", () => {
    expect(moneyDivRoundHalfEven(asPppMicro(3n), 2n)).toBe(2n);
    expect(moneyDivRoundHalfEven(asPppMicro(5n), 2n)).toBe(2n);
    expect(moneyDivRoundHalfEven(asPppMicro(-3n), 2n)).toBe(-2n);
    expect(moneyDivRoundHalfEven(asPppMicro(-5n), 2n)).toBe(-2n);
    expect(moneyDivRoundHalfEven(asPppMicro(1n), 2n)).toBe(0n);
    expect(moneyDivRoundHalfEven(asPppMicro(7n), 2n)).toBe(4n);
    expect(moneyDivRoundHalfEven(asPppMicro(9n), 2n)).toBe(4n);
    expect(moneyDivRoundHalfEven(asPppMicro(8n), 5n)).toBe(2n);
    expect(moneyDivRoundHalfEven(asPppMicro(7n), 5n)).toBe(1n);
    expect(moneyDivRoundHalfEven(asPppMicro(12n), 5n)).toBe(2n);
    expect(moneyDivRoundHalfEven(asPppMicro(13n), 5n)).toBe(3n);
    expect(moneyDivRoundHalfEven(asPppMicro(3n), -2n)).toBe(-2n);
    expect(moneyDivRoundHalfEven(asPppMicro(-3n), -2n)).toBe(2n);
    expect(moneyDivRoundHalfEven(asPppMicro(6n), 3n)).toBe(2n);
  });

  it("rejects zero, non-BigInt divisors, and out-of-range division", () => {
    expect(() => moneyDivFloor(asPppMicro(10n), 0n)).toThrow(MoneyError);
    expect(() => moneyDivRoundHalfEven(asPppMicro(10n), 0n)).toThrow(MoneyError);
    expect(() => moneyDivFloor(asPppMicro(10n), 3 as unknown as bigint)).toThrow(MoneyError);
    expect(() => moneyDivRoundHalfEven(asPppMicro(10n), 3 as unknown as bigint)).toThrow(MoneyError);
    expect(() => moneyDivFloor((MAX_MONEY_PPP_MICRO + 1n) as unknown as PppMicro, 1n)).toThrow(MoneyError);
    expect(() => moneyDivRoundHalfEven((MIN_MONEY_PPP_MICRO - 1n) as unknown as PppMicro, 1n)).toThrow(MoneyError);
  });
});

describe("MoneyString codec", () => {
  it("roundtrips 0, positive, negative, and large values", () => {
    for (const value of [0n, 1n, -1n, 1_000_000n, MAX_MONEY_PPP_MICRO, MIN_MONEY_PPP_MICRO]) {
      const money = asPppMicro(value);
      expect(decodeMoney(encodeMoney(money))).toBe(money);
    }
  });

  it("accepts only canonical decimal formats", () => {
    for (const text of ["0", "1", "-1", "9007199254740993"]) {
      expect(isMoneyString(text)).toBe(true);
    }
    for (const text of ["", "+1", "01", "-0", "1.0", "1e3", " 1", "1 ", "-01", "a", "9".repeat(41)]) {
      expect(isMoneyString(text)).toBe(false);
    }
    expect(isMoneyString("9".repeat(40))).toBe(true);
    expect(() => decodeMoney("9".repeat(40))).toThrow(MoneyError);
  });

  it("rejects invalid values and out-of-range strings", () => {
    for (const value of [null, 1, {}, [], true]) {
      expect(() => decodeMoney(value)).toThrow(MoneyError);
    }
    expect(() => decodeMoney("-0")).toThrow(MoneyError);
    expect(() => decodeMoney((MAX_MONEY_PPP_MICRO + 1n).toString())).toThrow(MoneyError);
  });

  it("supports the $money JSON envelope", () => {
    const money = asPppMicro(123n);
    const json = moneyToJson(money);
    expect(json).toEqual({ $money: "123" });
    expect(moneyFromJson(json)).toBe(money);
    expect(() => moneyFromJson({ $money: "1.0" })).toThrow(MoneyError);
  });

  it("returns branded MoneyString values", () => {
    const text: MoneyString = encodeMoney(asPppMicro(0n));
    expect(text).toBe("0");
  });
});
