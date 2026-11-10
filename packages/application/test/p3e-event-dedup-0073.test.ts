import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPeerGroup,
  createBirthCertificate,
  validateDataPack,
  validateDeathPack,
  validateIdentityPack
} from "@life-sim/birth";
import { validateEventPack } from "@life-sim/engine";
import {
  createP3EPlaySession,
  exportP3EPlaySessionPayload,
  restoreP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";

/**
 * GPT-DEEPSEEK-0073-B｜持久狀態事件不可重複、不可自相矛盾。
 *
 * 使用者回報的兩個缺陷：
 * 1. 已住進養護機構，之後又被問一次是否入住（`ev.senior.housing`）。
 * 2. 已接父母同住，之後又被問一次是否同住（`ev.adult.elder-care` / `ev.late.elder-care`）。
 *
 * 這裡用**正式 session**（固定 seed、逐年推進）驗證：
 * - 接受後寫入 durable flag，該決定永不再出現；
 * - 互斥狀態最多一個（機構／與子女同住／獨居）；
 * - save → load → replay 後仍然不重複。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

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

const identityPack = validateIdentityPack(base, {
  manifest: readJson("fixtures/p2b/manifest.v1.json"),
  datasets: {
    "country-vitals": readJson("fixtures/p2b/country-vitals.v1.json"),
    "household-profiles": readJson("fixtures/p2b/household-profiles.v1.json"),
    "name-corpus": readJson("fixtures/p2b/name-corpus.v1.json"),
    "story-templates": readJson("fixtures/p2b/story-templates.v1.json"),
    licenses: readJson("fixtures/p2b/licenses.v1.json"),
    lineage: readJson("fixtures/p2b/lineage.v1.json")
  }
} as never);

const eventPack = validateEventPack({
  manifest: readJson("fixtures/p3b/manifest.v1.json"),
  events: (readJson("fixtures/p3b/events.v1.json") as { records: unknown[] }).records
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

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

function sessionFor(seed: string): P3EPlaySession {
  const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
  const certificate = createBirthCertificate(base, identityPack, group, seed);
  return createP3EPlaySession({ masterSeed: seed, basePack: base, identityPack, certificate, eventPack, deathPack });
}

interface PlayedLife {
  readonly session: P3EPlaySession;
  /** 每次遇到的抉擇：`decisionId@age`。 */
  readonly decisions: readonly { readonly decisionId: string; readonly age: number; readonly optionIds: readonly string[] }[];
  readonly flags: readonly string[];
}

/**
 * 跑一條命：遇到 `targets` 裡的決策就選 `optionId`，其餘選第一個選項；
 * 一路推進到死亡（或用完 `maxSteps`）。
 */
function playLife(
  seed: string,
  choices: Readonly<Record<string, string>>,
  maxSteps = 400
): PlayedLife {
  let session = sessionFor(seed);
  const decisions: { decisionId: string; age: number; optionIds: readonly string[] }[] = [];
  for (let step = 0; step < maxSteps && session.state.phase !== "death"; step += 1) {
    if (session.state.phase === "pending_decision") {
      const pending = session.state.pendingDecision;
      const decisionId = pending?.decisionId as string;
      const optionIds = pending?.optionIds ?? [];
      decisions.push({ decisionId, age: session.state.age, optionIds });
      const wanted = choices[decisionId];
      const optionId = wanted !== undefined && optionIds.includes(wanted) ? wanted : (optionIds[0] as string);
      session = runP3EPlaySessionCommand({ session, command: { type: "CHOOSE_DECISION", optionId } }).session;
      continue;
    }
    session = runP3EPlaySessionCommand({ session, command: { ...ADVANCE } }).session;
  }
  return { session, decisions, flags: [...session.state.flags] };
}

function countOf(life: PlayedLife, decisionId: string): number {
  return life.decisions.filter((entry) => entry.decisionId === decisionId).length;
}

/**
 * GPT-DEEPSEEK-0074-A：長跑結果只算一次。
 *
 * 這支測試要在「跑到死亡」之後才能斷言，每條命約 100+ 個命令；原本每個 test
 * 各跑一次，在滿載的平行測試下會逼近 30 秒。改成：
 *
 * 1. 用 module 層的 memo 快取（同 seed ＋ 同選擇只跑一次）；
 * 2. restore／互斥測試**重用**前面已經跑過的命，不再重跑；
 * 3. 只在 describe 上加 60 秒局部 timeout（不動全域、不 skip、不刪覆蓋）。
 */
const LIFE_CACHE = new Map<string, PlayedLife>();

function lifeFor(seed: string, choices: Readonly<Record<string, string>> = {}, maxSteps = 400): PlayedLife {
  const key = `${seed}|${JSON.stringify(choices)}|${maxSteps}`;
  const cached = LIFE_CACHE.get(key);
  if (cached !== undefined) return cached;
  const life = playLife(seed, choices, maxSteps);
  LIFE_CACHE.set(key, life);
  return life;
}

const PARENTS_LIVE_SEED = "gpt-0073-parents-live";
const PARENTS_ARRANGED_SEED = "gpt-0073-parents-arranged";
const HOUSING_CARE_SEED = "gpt-0073-housing-care";
const RETIREMENT_SEED = "gpt-0073-retirement";
const MULTI_SEEDS = ["gpt-0073-multi-0", "gpt-0073-multi-1"] as const;

describe("GPT-0073-B 持久狀態事件：同一個決定只會出現一次", { timeout: 60000 }, () => {
  it("fixture 層：四個事件都是 once:true + durable flag 條件", () => {
    const records = (readJson("fixtures/p3b/events.v1.json") as { records: Record<string, unknown>[] }).records;
    const byId = (eventId: string): Record<string, unknown> => {
      const record = records.find((entry) => entry.eventId === eventId);
      if (record === undefined) throw new Error(`missing ${eventId}`);
      return record;
    };

    for (const eventId of ["ev.adult.elder-care", "ev.late.elder-care", "ev.senior.housing", "ev.senior.retirement"]) {
      expect(byId(eventId).once, eventId).toBe(true);
      expect(byId(eventId).conditions, eventId).not.toBeNull();
    }

    // 老後居住：每個選項都先移除另外兩個狀態。
    const housing = byId("ev.senior.housing") as {
      decision: { options: { optionId: string; effects: { type: string; flag?: string; action?: string }[] }[] };
    };
    for (const option of housing.decision.options) {
      const flags = option.effects.filter((effect) => effect.type === "flag");
      expect(flags.some((effect) => effect.action === "add"), option.optionId).toBe(true);
      expect(flags.filter((effect) => effect.action === "remove").length, option.optionId).toBeGreaterThanOrEqual(2);
    }
  });

  it("接父母同住之後，同一個決定不會再出現（長跑到死亡）", () => {
    const life = lifeFor(PARENTS_LIVE_SEED, { "dec.adult.elder-care": "live" });
    expect(life.decisions.some((entry) => entry.decisionId === "dec.adult.elder-care")).toBe(true);
    expect(countOf(life, "dec.adult.elder-care")).toBe(1);
    expect(countOf(life, "dec.late.elder-care")).toBe(0);
    expect(life.flags).toContain("care:parents-live");
    expect(life.flags).not.toContain("care:parents-arranged");
  });

  it("請看護（另一種安排）之後，40–50 與 51–64 的長輩照護都不再問", () => {
    const life = lifeFor(PARENTS_ARRANGED_SEED, { "dec.adult.elder-care": "nurse" });
    expect(countOf(life, "dec.adult.elder-care")).toBe(1);
    expect(countOf(life, "dec.late.elder-care")).toBe(0);
    expect(life.flags).toContain("care:parents-arranged");
    expect(life.flags).not.toContain("care:parents-live");
  });

  it("入住養護機構之後，老後居住決定不會再出現，且不會同時是獨居", () => {
    const life = lifeFor(HOUSING_CARE_SEED, { "dec.senior.housing": "care" });
    expect(life.decisions.some((entry) => entry.decisionId === "dec.senior.housing")).toBe(true);
    expect(countOf(life, "dec.senior.housing")).toBe(1);
    const housingFlags = life.flags.filter((flag) => ["senior:care", "senior:family", "senior:alone"].includes(flag));
    expect(housingFlags).toEqual(["senior:care"]);
  });

  it("退休只決定一次（完全退休後不再被問）", () => {
    const life = lifeFor(RETIREMENT_SEED, { "dec.senior.retirement": "full" });
    expect(life.decisions.some((entry) => entry.decisionId === "dec.senior.retirement")).toBe(true);
    expect(countOf(life, "dec.senior.retirement")).toBe(1);
    expect(life.flags).toContain("retired");
  });

  it("多個 seed 都不會重複問同一件事（互斥狀態最多一個）", () => {
    // 直接重用上面已經跑過的兩條命（不重跑），加上兩個預設選擇的 seed。
    const lives: PlayedLife[] = [
      lifeFor(PARENTS_LIVE_SEED, { "dec.adult.elder-care": "live" }),
      lifeFor(HOUSING_CARE_SEED, { "dec.senior.housing": "care" }),
      ...MULTI_SEEDS.map((seed) => lifeFor(seed))
    ];
    for (const [index, life] of lives.entries()) {
      expect(countOf(life, "dec.adult.elder-care"), `life ${index}`).toBeLessThanOrEqual(1);
      expect(countOf(life, "dec.late.elder-care"), `life ${index}`).toBeLessThanOrEqual(1);
      expect(countOf(life, "dec.senior.housing"), `life ${index}`).toBeLessThanOrEqual(1);
      expect(countOf(life, "dec.senior.retirement"), `life ${index}`).toBeLessThanOrEqual(1);
      const housingFlags = life.flags.filter((flag) => ["senior:care", "senior:family", "senior:alone"].includes(flag));
      expect(housingFlags.length, `life ${index}`).toBeLessThanOrEqual(1);
      const careFlags = life.flags.filter((flag) => ["care:parents-live", "care:parents-arranged"].includes(flag));
      expect(careFlags.length, `life ${index}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("GPT-0073-B 存檔／復原／重播：持久旗標一致", { timeout: 60000 }, () => {
  function restore(session: P3EPlaySession, seed: string): P3EPlaySession {
    const payload = exportP3EPlaySessionPayload({ session });
    const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
    return restoreP3EPlaySessionPayload({
      payload,
      masterSeed: seed,
      basePack: base,
      identityPack,
      certificate: createBirthCertificate(base, identityPack, group, seed),
      eventPack,
      deathPack
    });
  }

  it("父母同住：save → load 後 flags 與 stateHash 完全相同", () => {
    // 重用第一組已跑過的命（同 seed ＋ 同選擇），不再重跑一次。
    const life = lifeFor(PARENTS_LIVE_SEED, { "dec.adult.elder-care": "live" });
    expect(life.flags).toContain("care:parents-live");
    const restored = restore(life.session, PARENTS_LIVE_SEED);
    expect(restored.state.stateHash).toBe(life.session.state.stateHash);
    expect([...restored.state.flags]).toEqual([...life.session.state.flags]);
  });

  it("機構入住：save → load 後互斥旗標仍只有一個", () => {
    const life = lifeFor(HOUSING_CARE_SEED, { "dec.senior.housing": "care" });
    expect(life.flags).toContain("senior:care");
    const restored = restore(life.session, HOUSING_CARE_SEED);
    const housingFlags = restored.state.flags.filter((flag) =>
      ["senior:care", "senior:family", "senior:alone"].includes(flag)
    );
    expect(housingFlags).toEqual(["senior:care"]);
    expect(restored.state.stateHash).toBe(life.session.state.stateHash);
  });
});
