import { describe, expect, it } from "vitest";
import { P3D_DEATH_SPEC_VERSION, P3D_HEALTH_RULE_VERSION } from "@life-sim/contracts";
import { adjustHazardPpm, evaluateAnnualDeath, healthFactorPpm } from "../src/death/evaluate";
import { DeathDataError } from "../src/death/errors";
import { validateDeathPack } from "../src/death/pack";
import { Xoshiro128StarStar } from "@life-sim/engine";
import { BASE, codeOf, deathRaw, deathRecords, entityIds, loadDeathPack, regionCodeOf, repairDeath, validated } from "./p3d-helpers";

const pack = validated();
const ENTITY = entityIds()[0] as string;
const REGION = regionCodeOf(ENTITY);

const rng = (seed: number): readonly [number, number, number, number] =>
  [seed >>> 0, (seed * 2654435761) >>> 0, (seed + 0x9e3779b9) >>> 0, (seed ^ 0x5bf03635) >>> 0] as const;

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entityId: ENTITY,
    regionCode: REGION,
    sex: "female",
    age: 30,
    calendarYear: 2026,
    health: 50,
    rngState: rng(1),
    ...overrides
  };
}

/** 用指定 hazard 覆寫幾個 (entity, sex, age) 後重新驗證，用來做邊界測試。 */
function packWithHazards(overrides: readonly { sex: "female" | "male"; age: number; hazardPpm: number }[]) {
  const draft = loadDeathPack();
  const records = deathRecords(draft, "mortality");
  for (const override of overrides) {
    const record = records.find((entry) => entry.entityId === ENTITY && entry.sex === override.sex && entry.age === override.age);
    if (record === undefined) throw new Error("test fixture: mortality row missing");
    record.hazardPpm = override.hazardPpm;
  }
  repairDeath(draft);
  return validateDeathPack(deathRaw(draft), BASE);
}

describe("P3-D 年度死亡判定：決定性與基本契約", () => {
  it("同 seed／同輸入重跑 100 次完全一致", () => {
    const first = evaluateAnnualDeath(input(), pack);
    for (let index = 0; index < 100; index += 1) {
      expect(evaluateAnnualDeath(input(), pack)).toEqual(first);
    }
    expect(first.deathSpecVersion).toBe(P3D_DEATH_SPEC_VERSION);
    expect(first.healthRuleVersion).toBe(P3D_HEALTH_RULE_VERSION);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.deathPackChecksum).toBe(pack.packChecksum);
    expect(first.deathPackId).toBe(pack.manifest.deathPackId);
    expect(first.basePackChecksum).toBe(pack.manifest.basePackChecksum);
    expect(first.basePackId).toBe(pack.manifest.basePackId);
  });

  it("結果是 deep-frozen，RNG before／after 是獨立凍結副本", () => {
    const liveState = [...rng(7)];
    const result = evaluateAnnualDeath(input({ rngState: liveState }), pack);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rngStateBefore)).toBe(true);
    expect(Object.isFrozen(result.rngStateAfter)).toBe(true);
    // 呼叫端事後改輸入陣列，不得改變已回傳結果。
    liveState[0] = 0xdeadbeef;
    expect(result.rngStateBefore[0]).toBe(rng(7)[0]);
    expect(evaluateAnnualDeath(input({ rngState: liveState }), pack).rngStateBefore[0]).toBe(0xdeadbeef);
  });

  it("不修改 input 或 pack", () => {
    const draft = input();
    const snapshot = JSON.stringify(draft);
    const packChecksum = pack.packChecksum;
    evaluateAnnualDeath(draft, pack);
    expect(JSON.stringify(draft)).toBe(snapshot);
    expect(pack.packChecksum).toBe(packChecksum);
  });

  it("drawsUsed 精確等於實際 Xoshiro 推進次數", () => {
    for (const seed of [1, 2, 3, 11, 42, 777]) {
      const result = evaluateAnnualDeath(input({ rngState: rng(seed) }), pack);
      const replay = new Xoshiro128StarStar(result.rngStateBefore);
      for (let draw = 0; draw < result.drawsUsed; draw += 1) replay.nextU32();
      expect([...replay.state]).toEqual([...result.rngStateAfter]);
      expect(result.drawsUsed % 2).toBe(0);
      expect(result.drawsUsed).toBeGreaterThanOrEqual(2);
      expect(result.drawsUsed).toBeLessThanOrEqual(6);
    }
  });

  it("mortalityDraw 落在 [0, 1,000,000) 且與 died 一致", () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      const result = evaluateAnnualDeath(input({ rngState: rng(seed), age: 90 }), pack);
      const draw = BigInt(result.mortalityDraw);
      expect(draw >= 0n).toBe(true);
      expect(draw < 1_000_000n).toBe(true);
      expect(result.died).toBe(draw < BigInt(result.adjustedHazardPpm));
    }
  });
});

describe("P3-D 年度死亡判定：health 修正與 hazard 邊界", () => {
  it("health 0／50／100 的係數與 clamp", () => {
    expect(healthFactorPpm(50)).toBe(1_000_000);
    expect(healthFactorPpm(0)).toBe(2_000_000);
    // 100 → 1,000,000 − 1,000,000 = 0 → clamp 到 100,000
    expect(healthFactorPpm(100)).toBe(100_000);
    expect(healthFactorPpm(25)).toBe(1_500_000);
    expect(healthFactorPpm(75)).toBe(500_000);
    expect(codeOf(() => healthFactorPpm(-1))).toBe("E_P3D_STATE");
    expect(codeOf(() => healthFactorPpm(101))).toBe("E_P3D_STATE");
    expect(codeOf(() => healthFactorPpm(1.5))).toBe("E_P3D_STATE");
  });

  it("adjustHazardPpm 是整數運算並 clamp 在 0..1,000,000", () => {
    expect(adjustHazardPpm(1000, 50)).toEqual({ adjustedHazardPpm: 1000, healthFactorPpm: 1_000_000 });
    expect(adjustHazardPpm(1000, 0)).toEqual({ adjustedHazardPpm: 2000, healthFactorPpm: 2_000_000 });
    expect(adjustHazardPpm(1000, 100)).toEqual({ adjustedHazardPpm: 100, healthFactorPpm: 100_000 });
    expect(adjustHazardPpm(1_000_000, 0)).toEqual({ adjustedHazardPpm: 1_000_000, healthFactorPpm: 2_000_000 });
    expect(adjustHazardPpm(0, 0)).toEqual({ adjustedHazardPpm: 0, healthFactorPpm: 2_000_000 });
    // 四捨五入：999 × 1.5 = 1498.5 → 1499
    expect(adjustHazardPpm(999, 25).adjustedHazardPpm).toBe(1499);
  });

  it("hazard 0 → 永遠不死亡、不抽死因、只花 2 draws", () => {
    const zeroPack = packWithHazards([{ sex: "female", age: 30, hazardPpm: 0 }]);
    for (let seed = 1; seed <= 32; seed += 1) {
      const result = evaluateAnnualDeath(input({ rngState: rng(seed) }), zeroPack);
      expect(result.baseHazardPpm).toBe(0);
      expect(result.adjustedHazardPpm).toBe(0);
      expect(result.died).toBe(false);
      expect(result.causeId).toBeNull();
      expect(result.drawsUsed).toBe(2);
    }
  });

  it("hazard 1,000,000 → 永遠死亡、一定抽死因", () => {
    const maxPack = packWithHazards([{ sex: "female", age: 30, hazardPpm: 1_000_000 }]);
    for (let seed = 1; seed <= 32; seed += 1) {
      const result = evaluateAnnualDeath(input({ rngState: rng(seed) }), maxPack);
      expect(result.baseHazardPpm).toBe(1_000_000);
      expect(result.adjustedHazardPpm).toBe(1_000_000);
      expect(result.died).toBe(true);
      expect(result.causeId).not.toBeNull();
      expect(result.drawsUsed).toBe(4);
    }
  });

  it("health 100 讓 adjusted 變成 base 的 10%（整數捨入）", () => {
    const result = evaluateAnnualDeath(input({ health: 100 }), pack);
    expect(result.healthFactorPpm).toBe(100_000);
    const expected = Math.max(0, Math.min(1_000_000, Math.floor((result.baseHazardPpm * 100_000 + 500_000) / 1_000_000)));
    expect(result.adjustedHazardPpm).toBe(expected);
  });
});

describe("P3-D 年度死亡判定：死因抽選", () => {
  it("未死亡時不抽死因、不額外消耗 RNG", () => {
    const zeroPack = packWithHazards([{ sex: "female", age: 30, hazardPpm: 0 }]);
    const result = evaluateAnnualDeath(input(), zeroPack);
    expect(result.died).toBe(false);
    expect(result.causeId).toBeNull();
    const replay = new Xoshiro128StarStar(result.rngStateBefore);
    replay.nextU32();
    replay.nextU32();
    expect([...replay.state]).toEqual([...result.rngStateAfter]);
  });

  it("死亡時死因一定在 registry 內，且 RNG 推進 4 次", () => {
    const maxPack = packWithHazards([{ sex: "female", age: 30, hazardPpm: 1_000_000 }]);
    const causeIds = new Set(maxPack.causeRegistry.map((record) => record.causeId));
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const result = evaluateAnnualDeath(input({ rngState: rng(seed) }), maxPack);
      expect(result.causeId).not.toBeNull();
      expect(causeIds.has(result.causeId as string)).toBe(true);
      seen.add(result.causeId as string);
      expect(result.drawsUsed).toBe(4);
    }
    // 40 個樣本應該覆蓋到多個死因（加權抽選不是固定值）。
    expect(seen.size).toBeGreaterThan(3);
  });

  it("同一份輸入的死因抽選可重現", () => {
    const maxPack = packWithHazards([{ sex: "female", age: 30, hazardPpm: 1_000_000 }]);
    const first = evaluateAnnualDeath(input({ rngState: rng(9) }), maxPack);
    for (let index = 0; index < 25; index += 1) {
      expect(evaluateAnnualDeath(input({ rngState: rng(9) }), maxPack).causeId).toBe(first.causeId);
    }
  });
});

describe("P3-D 年度死亡判定：digest 綁定", () => {
  const base = evaluateAnnualDeath(input(), pack);
  const digestOf = (overrides: Record<string, unknown>) => evaluateAnnualDeath(input(overrides), pack).digest;

  it("改任一個權威輸入都會改變 digest", () => {
    const other = entityIds()[1] as string;
    const variants: Record<string, unknown>[] = [
      // entityId 與 regionCode 是綁在一组的（P3-D.1），所以換 entity 時必須一起換。
      { entityId: other, regionCode: regionCodeOf(other) },
      { sex: "male" },
      { age: 31 },
      { calendarYear: 2027 },
      { health: 51 },
      { rngState: rng(2) }
    ];
    const seen = new Set<string>([base.digest]);
    for (const variant of variants) {
      const digest = digestOf(variant);
      expect(digest).not.toBe(base.digest);
      expect(seen.has(digest)).toBe(false);
      seen.add(digest);
    }
  });

  it("regionCode 不是獨立輸入：它被綁在 entityId 上（P3-D.1）", () => {
    // 換成別的 entity 的 regionCode 一律拒絕，因此不可能出現「同 entity、不同 regionCode」的 digest。
    expect(codeOf(() => evaluateAnnualDeath(input({ regionCode: regionCodeOf(entityIds()[1] as string) }), pack))).toBe("E_P3D_ENTITY");
  });

  it("換 pack（不同 hazard／checksum）會改變 digest", () => {
    const other = packWithHazards([{ sex: "female", age: 30, hazardPpm: 123_456 }]);
    const changed = evaluateAnnualDeath(input(), other);
    expect(changed.deathPackChecksum).not.toBe(base.deathPackChecksum);
    expect(changed.digest).not.toBe(base.digest);
  });

  it("digest 對 rngStateAfter 與 drawsUsed 敏感（不可能只改結果不改 digest）", () => {
    const zeroPack = packWithHazards([{ sex: "female", age: 30, hazardPpm: 0 }]);
    const maxPack = packWithHazards([{ sex: "female", age: 30, hazardPpm: 1_000_000 }]);
    const alive = evaluateAnnualDeath(input(), zeroPack);
    const dead = evaluateAnnualDeath(input(), maxPack);
    expect(alive.drawsUsed).toBe(2);
    expect(dead.drawsUsed).toBe(4);
    expect(alive.digest).not.toBe(dead.digest);
  });
});

describe("P3-D 年度死亡判定：輸入驗證（只外洩固定錯誤碼）", () => {
  const code = (overrides: Record<string, unknown> | null) =>
    codeOf(() => evaluateAnnualDeath(overrides === null ? null : input(overrides), pack));

  it("缺欄位、多欄位、型別錯誤", () => {
    expect(codeOf(() => evaluateAnnualDeath(input({ extra: 1 }), pack))).toBe("E_P3D_UNKNOWN_KEY");
    expect(
      codeOf(() => {
        const draft = input();
        delete draft.health;
        return evaluateAnnualDeath(draft, pack);
      })
    ).toBe("E_P3D_MISSING_KEY");
    expect(code(null)).toBe("E_P3D_TYPE");
    expect(codeOf(() => evaluateAnnualDeath([], pack))).toBe("E_P3D_TYPE");
    expect(code({ entityId: 1 })).toBe("E_P3D_TYPE");
    expect(code({ entityId: "" })).toBe("E_P3D_RANGE");
  });

  it("age／health／calendarYear 边界", () => {
    expect(code({ age: -1 })).toBe("E_P3D_RANGE");
    expect(code({ age: 121 })).toBe("E_P3D_RANGE");
    expect(code({ age: 1.5 })).toBe("E_P3D_RANGE");
    expect(code({ health: -1 })).toBe("E_P3D_RANGE");
    expect(code({ health: 101 })).toBe("E_P3D_RANGE");
    expect(code({ health: Number.NaN })).toBe("E_P3D_RANGE");
    expect(code({ calendarYear: 1799 })).toBe("E_P3D_RANGE");
    expect(code({ calendarYear: 2201 })).toBe("E_P3D_RANGE");
    expect(code({ sex: "other" })).toBe("E_P3D_ENUM");
  });

  it("rngState 形狀錯誤", () => {
    for (const bad of [[1, 2, 3], [1, 2, 3, 4, 5], "abcdefg", null, { 0: 1, 1: 2, 2: 3, 3: 4 }]) {
      expect(code({ rngState: bad }), JSON.stringify(bad)).toBe("E_P3D_RNG");
    }
    for (const word of [-1, 0x100000000, 1.5, Number.NaN, "1"]) {
      expect(code({ rngState: [word, 1, 2, 3] }), String(word)).toBe("E_P3D_RNG");
    }
  });

  it("未知 entity／region 與未驗證的 pack", () => {
    expect(code({ entityId: "cr:ZZZ" })).toBe("E_P3D_ENTITY");
    expect(code({ regionCode: "ZZZ" })).toBe("E_P3D_ENTITY");
    expect(codeOf(() => evaluateAnnualDeath(input(), {}) )).toBe("E_P3D_PACK");
    expect(codeOf(() => evaluateAnnualDeath(input(), null))).toBe("E_P3D_PACK");
    expect(codeOf(() => evaluateAnnualDeath(input(), structuredClone(pack)))).toBe("E_P3D_PACK");
  });

  it("所有失敗都是 DeathDataError（沒有原生 TypeError）", () => {
    const cases: unknown[] = [null, [], "x", 42, input({ age: -1 }), input({ rngState: [1, 2, 3] })];
    for (const value of cases) {
      let caught: unknown = null;
      try {
        evaluateAnnualDeath(value, pack);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DeathDataError);
      expect((caught as DeathDataError).name).toBe("DeathDataError");
      expect((caught as DeathDataError).code).toMatch(/^E_P3D_/);
    }
  });
});
