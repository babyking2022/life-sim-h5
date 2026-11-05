import { deriveDomainState, FALLBACK_RNG_STATE, type RngState } from "./seed";

const MASK = 0xffffffff;
const TWO64 = 1n << 64n;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const MAX_WEIGHTED_ITEMS = 4096;

export class RngError extends Error {
  constructor(
    public readonly code:
      | "BAD_STATE"
      | "BAD_RANGE"
      | "BAD_WEIGHT"
      | "REJECTION_EXHAUSTED"
  ) {
    super(code);
    this.name = "RngError";
  }
}

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function allZero(state: RngState): boolean {
  return state[0] === 0 && state[1] === 0 && state[2] === 0 && state[3] === 0;
}

function validateState(state: unknown): RngState {
  if (!Array.isArray(state) || state.length !== 4) throw new RngError("BAD_STATE");
  for (const word of state) {
    if (!Number.isInteger(word) || word < 0 || word > MASK) throw new RngError("BAD_STATE");
  }
  const tuple = state as unknown as RngState;
  return allZero(tuple)
    ? FALLBACK_RNG_STATE
    : [tuple[0], tuple[1], tuple[2], tuple[3]];
}

export class Xoshiro128StarStar {
  private s: [number, number, number, number];

  constructor(state: unknown) {
    const validated = validateState(state);
    this.s = [validated[0], validated[1], validated[2], validated[3]];
  }


  get state(): RngState {
    return [this.s[0], this.s[1], this.s[2], this.s[3]];
  }

  nextU32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7) >>> 0, 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] = (s[2] ^ s[0]) >>> 0;
    s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0;
    s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0;
    s[3] = rotl(s[3], 11);
    if (allZero(this.s)) {
      this.s = [FALLBACK_RNG_STATE[0], FALLBACK_RNG_STATE[1], FALLBACK_RNG_STATE[2], FALLBACK_RNG_STATE[3]];
    }
    return result;
  }

  nextU64(): bigint {
    const high = BigInt(this.nextU32());
    const low = BigInt(this.nextU32());
    return (high << 32n) | low;
  }

  uniformBigInt(n: bigint): bigint {
    return uniformBigIntFrom(() => this.nextU64(), n);
  }

  uniformInt(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) throw new RngError("BAD_RANGE");
    if (min < INT32_MIN || min > INT32_MAX || max < INT32_MIN || max > INT32_MAX) {
      throw new RngError("BAD_RANGE");
    }
    const range = max - min + 1;
    if (range < 1 || range > 0x100000000) throw new RngError("BAD_RANGE");
    return min + Number(this.uniformBigInt(BigInt(range)));
  }

  chancePpm(ppm: number): boolean {
    if (!Number.isInteger(ppm) || ppm < 0 || ppm > 1_000_000) throw new RngError("BAD_RANGE");
    return this.uniformInt(0, 999_999) < ppm;
  }
}

export function uniformBigIntFrom(nextU64: () => bigint, n: bigint): bigint {
  if (typeof n !== "bigint" || n < 1n || n > TWO64) throw new RngError("BAD_RANGE");
  if (n === 1n) return 0n;
  const limit = (TWO64 / n) * n;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const value = nextU64();
    if (typeof value !== "bigint" || value < 0n || value >= TWO64) throw new RngError("BAD_RANGE");
    if (value < limit) return value % n;
  }
  throw new RngError("REJECTION_EXHAUSTED");
}

export function weightedChoice<T>(items: readonly T[], weights: readonly number[], rng: Xoshiro128StarStar): T {
  if (items.length < 1 || items.length > MAX_WEIGHTED_ITEMS || items.length !== weights.length) {
    throw new RngError("BAD_WEIGHT");
  }
  let total = 0n;
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 0 || weight > MASK) throw new RngError("BAD_WEIGHT");
    total += BigInt(weight);
  }
  if (total === 0n || total > TWO64 - 1n) throw new RngError("BAD_WEIGHT");
  const draw = rng.uniformBigInt(total);
  let cumulative = 0n;
  for (let i = 0; i < items.length; i += 1) {
    cumulative += BigInt(weights[i] as number);
    if (draw < cumulative) return items[i] as T;
  }
  throw new RngError("BAD_WEIGHT");
}

export function createDomainRng(seedText: string, domain: string, spec = "1.0.0"): Xoshiro128StarStar {
  return new Xoshiro128StarStar(deriveDomainState(seedText, domain, spec));
}
