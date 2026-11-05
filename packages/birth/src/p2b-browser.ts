import type { SexPolicy } from "@life-sim/contracts";
import { buildBirthIdentity } from "./identity/draw";
import { validateIdentityPack } from "./identity/validate";
import { validateDataPack } from "./validate";

export interface IdentityBrowserCase {
  readonly seed: string;
  readonly sexPolicy: string;
}

/**
 * P2-B 跨瀏覽器 golden 入口：兩個資料包都由呼叫端傳入（不把 raw JSON 打包進 bundle）。
 */
export function runIdentityCases(baseRaw: unknown, identityRaw: unknown, cases: readonly IdentityBrowserCase[]) {
  const base = validateDataPack(baseRaw as never);
  const pack = validateIdentityPack(base, identityRaw as never);
  return cases.map((item) => buildBirthIdentity(base, pack, { seed: item.seed, sexPolicy: item.sexPolicy as SexPolicy }));
}
