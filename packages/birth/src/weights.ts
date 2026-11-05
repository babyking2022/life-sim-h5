import { P2A_MAX_RECORD_WEIGHT, P2A_MAX_TOTAL_WEIGHT } from "@life-sim/contracts";
import { fail } from "./errors";

/**
 * 單筆權重：整數、>= 1、<= 2^53-1。負數、零、超過安全整數各自固定錯誤碼，
 * 不允許先四捨五入或 clamp 後繼續。
 */
export function assertRecordWeight(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail("E_P2A_TYPE", path);
  if (!Number.isSafeInteger(value)) fail("E_P2A_WEIGHT_OVERFLOW", path);
  if (value < 0) fail("E_P2A_WEIGHT_NEGATIVE", path);
  if (value === 0) fail("E_P2A_WEIGHT_ZERO", path);
  if (value > P2A_MAX_RECORD_WEIGHT) fail("E_P2A_WEIGHT_OVERFLOW", path);
  return value;
}

/** 226 筆之後仍用 BigInt 累加，總和不得超過 2^64-1。 */
export function sumWeights(weights: readonly number[]): bigint {
  let total = 0n;
  for (let index = 0; index < weights.length; index += 1) {
    total += BigInt(assertRecordWeight(weights[index], `weights[${index}]`));
  }
  if (total > P2A_MAX_TOTAL_WEIGHT) fail("E_P2A_WEIGHT_TOTAL_OVERFLOW", "weights");
  return total;
}

/**
 * 依輸入順序累加的整數加權抽樣。呼叫端必須先做穩定排序，
 * 這個函式本身不排序，也不碰浮點。
 */
export function pickWeightedIndex(weights: readonly number[], draw: (total: bigint) => bigint): number {
  const total = sumWeights(weights);
  if (total === 0n) fail("E_P2A_NO_CANDIDATES", "weights");
  const ticket = draw(total);
  let cumulative = 0n;
  for (let index = 0; index < weights.length; index += 1) {
    cumulative += BigInt(weights[index] as number);
    if (ticket < cumulative) return index;
  }
  /* 只有權重或抽樣被外力改壞才會到這裡。 */
  return fail("E_P2A_WEIGHT_OVERFLOW", "weights");
}
