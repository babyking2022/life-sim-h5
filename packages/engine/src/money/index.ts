import { isMoneyString, type MoneyString } from "@life-sim/contracts";

export type PppMicro = bigint & { readonly __brand: "PppMicro" };

export const PPP_USD_MICRO_PER_USD = 1_000_000n;
export const MAX_MONEY_PPP_MICRO = 1_000_000_000_000_000_000n;
export const MIN_MONEY_PPP_MICRO = -1_000_000_000_000_000_000n;

export class MoneyError extends Error {
  constructor(
    public readonly code: "TYPE" | "RANGE" | "CODEC" | "DIVISION_BY_ZERO",
    message: string = code
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

function assertBigInt(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint") throw new MoneyError("TYPE", "money must be bigint, not number");
}

function assertRange(value: bigint): PppMicro {
  if (value < MIN_MONEY_PPP_MICRO || value > MAX_MONEY_PPP_MICRO) {
    throw new MoneyError("RANGE", "money out of PPP_USD_MICRO range");
  }
  return value as PppMicro;
}

export function asPppMicro(value: bigint): PppMicro {
  assertBigInt(value);
  return assertRange(value);
}

export function moneyAdd(a: PppMicro, b: PppMicro): PppMicro {
  assertBigInt(a);
  assertBigInt(b);
  return assertRange(a + b);
}

export function moneySub(a: PppMicro, b: PppMicro): PppMicro {
  assertBigInt(a);
  assertBigInt(b);
  return assertRange(a - b);
}

export function moneyNeg(a: PppMicro): PppMicro {
  assertBigInt(a);
  return assertRange(-a);
}

export function moneyAbs(a: PppMicro): PppMicro {
  assertBigInt(a);
  return assertRange(a < 0n ? -a : a);
}

export function moneyCompare(a: PppMicro, b: PppMicro): -1 | 0 | 1 {
  assertBigInt(a);
  assertBigInt(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function moneyIsZero(a: PppMicro): boolean {
  assertBigInt(a);
  return a === 0n;
}

export function moneyDivFloor(a: PppMicro, divisor: bigint): PppMicro {
  assertBigInt(a);
  assertBigInt(divisor);
  if (divisor === 0n) throw new MoneyError("DIVISION_BY_ZERO");
  const quotient = a / divisor;
  const remainder = a % divisor;
  if (remainder !== 0n && (a < 0n) !== (divisor < 0n)) {
    return assertRange(quotient - 1n);
  }
  return assertRange(quotient);
}

export function moneyDivRoundHalfEven(a: PppMicro, divisor: bigint): PppMicro {
  assertBigInt(a);
  assertBigInt(divisor);
  if (divisor === 0n) throw new MoneyError("DIVISION_BY_ZERO");
  const negative = (a < 0n) !== (divisor < 0n);
  const numerator = a < 0n ? -a : a;
  const denominator = divisor < 0n ? -divisor : divisor;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  let rounded = quotient;
  if (twice > denominator || (twice === denominator && quotient % 2n !== 0n)) {
    rounded += 1n;
  }
  return assertRange(negative ? -rounded : rounded);
}

export function encodeMoney(value: PppMicro): MoneyString {
  assertBigInt(value);
  assertRange(value);
  const text = value.toString();
  if (!isMoneyString(text)) throw new MoneyError("CODEC");
  return text;
}

export function decodeMoney(value: unknown): PppMicro {
  if (!isMoneyString(value)) throw new MoneyError("CODEC");
  let amount: bigint;
  try {
    amount = BigInt(value);
  } catch {
    throw new MoneyError("CODEC");
  }
  return assertRange(amount);
}

export function moneyToJson(value: PppMicro): { $money: MoneyString } {
  return { $money: encodeMoney(value) };
}

export function moneyFromJson(value: unknown): PppMicro {
  if (typeof value !== "object" || value === null || !("$money" in value)) {
    throw new MoneyError("CODEC");
  }
  return decodeMoney((value as { $money: unknown }).$money);
}
