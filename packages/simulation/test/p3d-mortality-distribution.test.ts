import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAnnualDeath, validateDataPack, validateDeathPack } from "@life-sim/birth";
import { deriveP3EDomainState } from "../src/rng";
import { P3E_MAX_AGE } from "@life-sim/contracts";

/**
 * GPT-0029-A：死亡分布驗收（不靠 UI、不看文案，只跑權威 P3-D 判定）。
 *
 * 用正式的 mortality fixture 與正式 `evaluateAnnualDeath`，以 500 個不同 seed
 * （`p3d-mort-000`…`499`）逐年推進到死亡或 120 歲上限，檢查產品驗收門檻：
 *
 * - 不能集中在單一年齡（任何年齡 <= 10% 的死亡）；
 * - 至少 25 個不同死亡年齡；
 * - 中位死亡年齡 68–88；
 * - >= 60% 活到 60 歲、>= 15% 活到 80 歲；
 * - 同一個 seed 重跑：死亡年齡、死因、RNG／death digest 完全相同；
 * - 兩個不同國家／性別族群不是逐項相同；
 * - 健康越高，adjusted hazard 不得越高（單調不增）。
 *
 * 這裡刻意**不**跑完整 session（那條路徑由 `p3e-*` 測試與 `scripts/p3d-mortality-distribution.ts`
 * 的 500 條完整人生報告覆蓋），所以這個檔案可以在 CI 裡保持 < 5 秒。
 */

type Dict = Record<string, unknown>;

const ROOT = process.cwd();
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

interface EntityRef {
  readonly entityId: string;
  readonly regionCode: string;
  readonly region: string;
}

const entities: readonly EntityRef[] = (
  readJson("fixtures/p2a/country-registry.v1.json") as { records: { entityId: string; regionCode: string; region: string }[] }
).records.map((record) => ({ entityId: record.entityId, regionCode: record.regionCode, region: record.region }));

interface LifeResult {
  readonly seed: string;
  readonly entityId: string;
  readonly region: string;
  readonly sex: "female" | "male";
  readonly deathAge: number;
  readonly causeId: string | null;
  readonly deathDigest: string;
  readonly rngState: readonly [number, number, number, number];
}

/** 一年一年推進到死亡；`age` 只受 P3D_MAX_AGE 限制，與 P3E 的 120 歲上限一致。 */
function simulateLife(seed: string, entity: EntityRef, sex: "female" | "male", health: number): LifeResult {
  let rngState = deriveP3EDomainState(seed, "p3e/death");
  const birthYear = 2024;
  for (let age = 1; age <= P3E_MAX_AGE; age += 1) {
    const result = evaluateAnnualDeath(
      {
        entityId: entity.entityId,
        regionCode: entity.regionCode,
        sex,
        age,
        calendarYear: birthYear + age,
        health,
        rngState
      },
      deathPack
    );
    if (result.died) {
      return {
        seed,
        entityId: entity.entityId,
        region: entity.region,
        sex,
        deathAge: age,
        causeId: result.causeId,
        deathDigest: result.digest,
        rngState: result.rngStateAfter
      };
    }
    rngState = result.rngStateAfter;
  }
  return {
    seed,
    entityId: entity.entityId,
    region: entity.region,
    sex,
    deathAge: P3E_MAX_AGE,
    causeId: null,
    deathDigest: "age_ceiling",
    rngState
  };
}

const LIVES = 500;
const lives: readonly LifeResult[] = Array.from({ length: LIVES }, (_, index) => {
  const entity = entities[index % entities.length] as EntityRef;
  const sex: "female" | "male" = index % 2 === 0 ? "female" : "male";
  const health = 40 + ((index * 7) % 41); // 40..80，決定性分佈
  return simulateLife(`p3d-mort-${String(index).padStart(3, "0")}`, entity, sex, health);
});

function statsOf(sample: readonly LifeResult[]): {
  readonly count: number;
  readonly median: number;
  readonly distinctAges: number;
  readonly maxAgeShare: number;
  readonly maxAge: number;
  readonly reach60: number;
  readonly reach80: number;
  readonly causes: Record<string, number>;
} {
  const byAge = new Map<number, number>();
  const causes: Record<string, number> = {};
  for (const life of sample) {
    byAge.set(life.deathAge, (byAge.get(life.deathAge) ?? 0) + 1);
    const key = life.causeId ?? "age_ceiling";
    causes[key] = (causes[key] ?? 0) + 1;
  }
  const sorted = [...sample].map((life) => life.deathAge).sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  const maxCount = Math.max(...byAge.values());
  return {
    count: sample.length,
    median,
    distinctAges: byAge.size,
    maxAgeShare: maxCount / sample.length,
    maxAge: [...byAge.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] as number,
    reach60: sample.filter((life) => life.deathAge >= 60).length / sample.length,
    reach80: sample.filter((life) => life.deathAge >= 80).length / sample.length,
    causes
  };
}

describe("GPT-0029-A 死亡分布驗收（500 條不同 seed）", () => {
  const stats = statsOf(lives);

  it("500 條人生全部結束，且死因分佈合理", () => {
    expect(lives).toHaveLength(LIVES);
    for (const life of lives) {
      expect(life.deathAge).toBeGreaterThanOrEqual(1);
      expect(life.deathAge).toBeLessThanOrEqual(P3E_MAX_AGE);
    }
    expect(Object.keys(stats.causes).length).toBeGreaterThanOrEqual(3);
    // 不能全部都是同一種死因（自然死亡 vs 意外 vs 疾病要有差異）。
    const topCauseShare = Math.max(...Object.values(stats.causes)) / LIVES;
    expect(topCauseShare).toBeLessThan(0.9);
  });

  it("任何單一年齡不超過 10% 的死亡，且至少 25 個不同死亡年齡", () => {
    expect(stats.maxAgeShare).toBeLessThanOrEqual(0.1);
    expect(stats.distinctAges).toBeGreaterThanOrEqual(25);
  });

  it("中位死亡年齡介於 68–88 歲", () => {
    expect(stats.median).toBeGreaterThanOrEqual(68);
    expect(stats.median).toBeLessThanOrEqual(88);
  });

  it("至少 60% 活到 60 歲、至少 15% 活到 80 歲", () => {
    expect(stats.reach60).toBeGreaterThanOrEqual(0.6);
    expect(stats.reach80).toBeGreaterThanOrEqual(0.15);
  });

  it("51 歲不再是死亡高峰（GPT-0029-A 的直接回歸）", () => {
    const at51 = lives.filter((life) => life.deathAge === 51).length / LIVES;
    expect(at51).toBeLessThan(0.05);
  });

  it("同一個 seed 重跑：死亡年齡、死因、death digest、RNG 完全相同", () => {
    for (const index of [0, 17, 123, 499]) {
      const life = lives[index] as LifeResult;
      const entity = entities[index % entities.length] as EntityRef;
      const health = 40 + ((index * 7) % 41);
      const again = simulateLife(life.seed, entity, life.sex, health);
      expect(again.deathAge).toBe(life.deathAge);
      expect(again.causeId).toBe(life.causeId);
      expect(again.deathDigest).toBe(life.deathDigest);
      expect(again.rngState).toEqual(life.rngState);
    }
  });

  it("不同國家／性別的死亡分布不是逐項相同", () => {
    const female = statsOf(lives.filter((life) => life.sex === "female"));
    const male = statsOf(lives.filter((life) => life.sex === "male"));
    const femaleAges = new Map<number, number>();
    for (const life of lives.filter((entry) => entry.sex === "female")) femaleAges.set(life.deathAge, 0);
    const maleAges = new Map<number, number>();
    for (const life of lives.filter((entry) => entry.sex === "male")) maleAges.set(life.deathAge, 0);
    const identical = [...femaleAges.keys()].length === [...maleAges.keys()].length;
    // 至少 median 或死亡年齡集合要有差異（female 的 hazard 較低，通常活得比較久）。
    expect(identical && female.median === male.median).toBe(false);

    const africa = statsOf(lives.filter((life) => life.region === "africa"));
    const europe = statsOf(lives.filter((life) => life.region === "europe"));
    expect(africa.count).toBeGreaterThan(0);
    expect(europe.count).toBeGreaterThan(0);
    expect(africa.median).not.toBe(europe.median);
  });

  it("健康越高，adjusted hazard 不得越高", () => {
    const entity = entities[0] as EntityRef;
    for (let age = 1; age <= P3E_MAX_AGE; age += 7) {
      const lowHealth = evaluateAnnualDeath(
        { entityId: entity.entityId, regionCode: entity.regionCode, sex: "male", age, calendarYear: 2024 + age, health: 20, rngState: [1, 2, 3, 4] },
        deathPack
      );
      const highHealth = evaluateAnnualDeath(
        { entityId: entity.entityId, regionCode: entity.regionCode, sex: "male", age, calendarYear: 2024 + age, health: 90, rngState: [1, 2, 3, 4] },
        deathPack
      );
      expect(highHealth.adjustedHazardPpm).toBeLessThanOrEqual(lowHealth.adjustedHazardPpm);
    }
  });

  it("死亡年齡與死因在整個人口中有實際差異（不是同一個 80 歲）", () => {
    const ages = new Set(lives.map((life) => life.deathAge));
    expect(ages.size).toBeGreaterThanOrEqual(25);
    const causes = new Set(lives.map((life) => life.causeId));
    expect(causes.size).toBeGreaterThanOrEqual(3);
    // 不是所有人都超過 60，也不是所有人都不到 60。
    expect(stats.reach60).toBeGreaterThan(0.6);
    expect(stats.reach60).toBeLessThan(1);
  });
});

void ({} as Dict);
