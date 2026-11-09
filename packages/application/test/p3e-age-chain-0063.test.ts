import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";
import { sceneAgeStageOf, sceneLifeStageOf } from "../src/p3e-profile";

/**
 * GPT-WORKBUDDY-0063-B｜**真實 session** 年齡鏈驗收。
 *
 * 用正式 `runP3EPlaySessionCommand({ ADVANCE_YEAR / CHOOSE_DECISION })` 逐年
 * 推進，不是注入場景。逐歲斷言正式 `view.scene.age` 與 `state.age`、
 * 六段 ageStage、八段 lifeStage 完全一致，並把可活到 66 歲以上的固定 seed
 * 輸出給 `scripts/p3e-0063b-age-chain.mjs` 產生 390×844 CTO 截圖。
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
const TARGET_AGES: readonly number[] = [0, 3, 6, 13, 18, 25, 45, 65];

function sessionFor(seed: string): P3EPlaySession {
  const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
  const certificate = createBirthCertificate(base, identityPack, group, seed);
  return createP3EPlaySession({ masterSeed: seed, basePack: base, identityPack, certificate, eventPack, deathPack });
}

interface Sample {
  readonly age: number;
  readonly ageStage: string;
  readonly lifeStage: string;
  readonly sex: string;
  readonly hasPartner: boolean;
  readonly partnerAge: number | null;
  readonly partnerSex: string | null;
  readonly petKind: string;
  readonly phase: string;
}

interface Chain {
  readonly reached: boolean;
  readonly maxAge: number;
  readonly sex: "male" | "female";
  readonly samples: readonly Sample[];
  readonly partnerAges: readonly number[];
  readonly petAges: readonly number[];
}

/** 真正逐年推进；遇决策选第一个 option，与浏览器 smoke 的策略一致。 */
function playChain(start: P3EPlaySession, untilAge: number): Chain {
  let session = start;
  const samples: Sample[] = [];
  const partnerAges: number[] = [];
  const petAges: number[] = [];
  const sex = session.view.scene.playerSex;
  for (let step = 0; step < 600; step += 1) {
    const scene = session.view.scene;
    const sample: Sample = {
      age: scene.age,
      ageStage: scene.ageStage,
      lifeStage: scene.lifeStage,
      sex: scene.playerSex,
      hasPartner: scene.hasPartner,
      partnerAge: scene.partnerAge,
      partnerSex: scene.partnerSex,
      petKind: scene.petKind,
      phase: scene.phase
    };
    samples.push(sample);
    if (scene.hasPartner) partnerAges.push(scene.age);
    if (scene.petKind !== "none") petAges.push(scene.age);
    if (session.state.age >= untilAge) break;
    if (session.state.phase === "death") break;
    if (session.state.phase === "pending_decision") {
      const optionId = session.state.pendingDecision?.optionIds[0] as string;
      session = runP3EPlaySessionCommand({ session, command: { type: "CHOOSE_DECISION", optionId } }).session;
      continue;
    }
    session = runP3EPlaySessionCommand({ session, command: { ...ADVANCE } }).session;
  }
  return {
    reached: session.state.age >= untilAge && session.state.phase !== "death",
    maxAge: session.state.age,
    sex,
    samples,
    partnerAges,
    petAges
  };
}

function assertChain(chain: Chain, seed: string): void {
  expect(chain.samples.length).toBeGreaterThan(60);
  expect(chain.samples[0]?.age).toBe(0);
  expect(chain.samples[0]?.lifeStage).toBe("baby");
  const seen = new Set<number>();
  for (const sample of chain.samples) {
    // 每一歲的投影都必須與正式 state 逐年一致（不做任何畫面注入）。
    expect(sample.ageStage).toBe(sceneAgeStageOf(sample.age));
    expect(sample.lifeStage).toBe(sceneLifeStageOf(sample.age));
    expect(sample.sex).toBe(chain.sex);
    if (sample.hasPartner && sample.age < 18) {
      expect(sample.partnerAge as number).toBeLessThan(18);
    }
    seen.add(sample.age);
  }
  for (const age of TARGET_AGES) expect(seen.has(age)).toBe(true);
  expect(chain.reached, `${seed} 必須真的活到 66 歲`).toBe(true);
}

describe("GPT-0063-B 真實 session 年齡鏈（0／3／6／13／18／25／45／65 歲）", () => {
  // 這是用正式 session 掃到 66 歲的長時整合測試；沿用 p3e-life-focus.test.ts
  // 的既有慣例給予較長 timeout，斷言與覆蓋範圍完全不變。
  it("固定 seed 逐年推進：scene.age／ageStage／lifeStage 與 state 一致，並輸出候選 seed", { timeout: 120_000 }, () => {
    const found: Record<"male" | "female", Array<{
      readonly seed: string;
      readonly maxAge: number;
      readonly partnerAges: readonly number[];
      readonly petAges: readonly number[];
      readonly samples: readonly Sample[];
    }>> = { male: [], female: [] };

    for (let index = 0; index < 90; index += 1) {
      if (found.male.length >= 5 && found.female.length >= 5) break;
      const seed = `gpt-0063-age-chain-${index}`;
      const start = sessionFor(seed);
      const sex = start.view.scene.playerSex;
      if (found[sex].length >= 5) continue;
      const chain = playChain(start, 66);
      if (!chain.reached) continue;
      assertChain(chain, seed);
      found[sex].push({
        seed,
        maxAge: chain.maxAge,
        partnerAges: chain.partnerAges,
        petAges: chain.petAges,
        samples: chain.samples
      });
    }

    expect(found.male.length, "至少要有一個能活到 66 歲的男性 seed").toBeGreaterThan(0);
    expect(found.female.length, "至少要有一個能活到 66 歲的女性 seed").toBeGreaterThan(0);

    const pick = (rows: typeof found.male) =>
      [...rows].sort((a, b) =>
        (b.partnerAges.length + b.petAges.length) - (a.partnerAges.length + a.petAges.length)
      );
    const male = pick(found.male);
    const female = pick(found.female);
    mkdirSync(join(ROOT, ".artifacts"), { recursive: true });
    writeFileSync(join(ROOT, ".artifacts/p3e-0063b-seeds.json"), JSON.stringify({
      targetAges: TARGET_AGES,
      maleSeed: male[0]?.seed,
      femaleSeed: female[0]?.seed,
      maleCandidates: male.map((row) => row.seed),
      femaleCandidates: female.map((row) => row.seed),
      chains: {
        male: male[0]?.samples ?? [],
        female: female[0]?.samples ?? []
      },
      partnerAges: { male: male[0]?.partnerAges ?? [], female: female[0]?.partnerAges ?? [] },
      petAges: { male: male[0]?.petAges ?? [], female: female[0]?.petAges ?? [] }
    }, null, 2) + "\n", "utf8");
  });
});
