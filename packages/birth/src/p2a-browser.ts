import type { SexPolicy } from "@life-sim/contracts";
import { drawBirth } from "./draw";
import { validateDataPack } from "./validate";

export interface BirthBrowserCase {
  readonly seed: string;
  readonly birthYear: number;
  readonly sexPolicy: string;
}

/**
 * 跨瀏覽器 golden 的入口：資料包由呼叫端傳入（不把 raw JSON 打包進 bundle），
 * 先驗證、再抽選，回傳完整 draft（含 rng 狀態與 drawHash）。
 */
export function runBirthCases(rawPack: unknown, cases: readonly BirthBrowserCase[]) {
  const pack = validateDataPack(rawPack as never);
  return cases.map((item) =>
    drawBirth(pack, {
      seed: item.seed,
      settings: { birthYear: item.birthYear, sexPolicy: item.sexPolicy as SexPolicy }
    })
  );
}
