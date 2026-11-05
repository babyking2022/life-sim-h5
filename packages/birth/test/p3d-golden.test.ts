import { describe, expect, it } from "vitest";
import { Xoshiro128StarStar } from "@life-sim/engine";
import { evaluateAnnualDeath } from "../src/death/evaluate";
import { projectDeathResult } from "../src/death/browser";
import { validated } from "./p3d-helpers";
import goldenJson from "../../../fixtures/p3d/golden-death-vectors.v1.json";

interface GoldenCase {
  readonly id: string;
  readonly entityId: string;
  readonly regionCode: string;
  readonly sex: "female" | "male";
  readonly age: number;
  readonly calendarYear: number;
  readonly health: number;
  readonly rngState: readonly number[];
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

const golden = goldenJson as unknown as {
  schemaVersion: string;
  deathPackChecksum: string;
  basePackChecksum: string;
  digestDomain: string;
  caseCount: number;
  diedCount: number;
  distinctCauses: readonly string[];
  cases: readonly GoldenCase[];
};

describe("P3-D golden 向量（Node）", () => {
  const pack = validated();

  it("golden 綁定的 pack 與目前 fixture 完全一致", () => {
    expect(golden.schemaVersion).toBe("p3d-1");
    expect(golden.digestDomain).toBe("LIFE1/P3D/DEATH/v1");
    expect(golden.deathPackChecksum).toBe(pack.packChecksum);
    expect(golden.basePackChecksum).toBe(pack.manifest.basePackChecksum);
    expect(golden.caseCount).toBe(golden.cases.length);
    expect(golden.cases.length).toBe(108);
    expect(golden.diedCount).toBe(golden.cases.filter((entry) => entry.died).length);
  });

  it("108 組逐位元重現（digest 與每個欄位）", () => {
    for (const item of golden.cases) {
      const result = evaluateAnnualDeath(
        {
          entityId: item.entityId,
          regionCode: item.regionCode,
          sex: item.sex,
          age: item.age,
          calendarYear: item.calendarYear,
          health: item.health,
          rngState: item.rngState
        },
        pack
      );
      expect(projectDeathResult(result), item.id).toEqual({
        digest: item.digest,
        baseHazardPpm: item.baseHazardPpm,
        adjustedHazardPpm: item.adjustedHazardPpm,
        healthFactorPpm: item.healthFactorPpm,
        died: item.died,
        causeId: item.causeId,
        mortalityDraw: item.mortalityDraw,
        drawsUsed: item.drawsUsed,
        rngStateBefore: item.rngStateBefore,
        rngStateAfter: item.rngStateAfter,
        regionClass: item.regionClass
      });
    }
  });

  it("golden 覆蓋死亡與未死亡兩條路徑，且包含多個死因", () => {
    const died = golden.cases.filter((entry) => entry.died);
    const alive = golden.cases.filter((entry) => !entry.died);
    expect(died.length).toBeGreaterThan(0);
    expect(alive.length).toBeGreaterThan(0);
    // 未死亡：不抽死因、只有一次 u64（2 draws）。
    for (const entry of alive) {
      expect(entry.causeId).toBeNull();
      expect(entry.drawsUsed).toBe(2);
    }
    // 死亡：一定有死因，且 draws > 2。
    for (const entry of died) {
      expect(entry.causeId).not.toBeNull();
      expect(entry.drawsUsed).toBeGreaterThan(2);
    }
    expect(new Set(died.map((entry) => entry.causeId)).size).toBeGreaterThan(1);
  });

  it("golden 的 rngStateAfter 都真的等於 before 推進 drawsUsed 次的結果", () => {
    for (const item of golden.cases) {
      const replay = new Xoshiro128StarStar(item.rngStateBefore as unknown as number[]);
      for (let draw = 0; draw < item.drawsUsed; draw += 1) replay.nextU32();
      expect([...replay.state], item.id).toEqual([...item.rngStateAfter]);
    }
  });
});
