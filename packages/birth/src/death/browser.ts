import { evaluateAnnualDeath } from "./evaluate";
import { validateDeathPack } from "./pack";
import { validateDataPack } from "../validate";

/** golden 用的 digest 投影（必須與 `scripts/p3d-generate-golden.ts` 完全一致）。 */
export interface DeathGoldenDigest {
  readonly digest: string;
  readonly baseHazardPpm: number;
  readonly adjustedHazardPpm: number;
  readonly healthFactorPpm: number;
  readonly died: boolean;
  readonly causeId: string | null;
  readonly mortalityDraw: string;
  readonly drawsUsed: number;
  readonly rngStateBefore: readonly number[];
  readonly rngStateAfter: readonly number[];
  readonly regionClass: string;
}

export function projectDeathResult(result: ReturnType<typeof evaluateAnnualDeath>): DeathGoldenDigest {
  return {
    digest: result.digest,
    baseHazardPpm: result.baseHazardPpm,
    adjustedHazardPpm: result.adjustedHazardPpm,
    healthFactorPpm: result.healthFactorPpm,
    died: result.died,
    causeId: result.causeId,
    mortalityDraw: result.mortalityDraw,
    drawsUsed: result.drawsUsed,
    rngStateBefore: [...result.rngStateBefore],
    rngStateAfter: [...result.rngStateAfter],
    regionClass: result.regionClass
  };
}

/**
 * P3-D 跨瀏覽器 golden 入口。
 *
 * 兩個資料包由呼叫端傳入；瀏覽器端必須自己重跑 `validateDataPack` ＋ `validateDeathPack`
 * （因此 dataset checksum、manifest packChecksum 與每個死亡 digest 都要逐位元一致）。
 */
export function runDeathCases(baseRaw: unknown, deathRaw: unknown, cases: readonly unknown[]): DeathGoldenDigest[] {
  const base = validateDataPack(baseRaw as never);
  const pack = validateDeathPack(deathRaw, base);
  return cases.map((item) => projectDeathResult(evaluateAnnualDeath(item, pack)));
}
