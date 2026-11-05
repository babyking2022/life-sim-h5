import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createP3EBrowserSession,
  prepareP3EBrowserWorld,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../packages/application/src/index";
import { P3E_MAX_AGE, P3E_MAX_COMMANDS } from "../packages/contracts/src/index";

/**
 * GPT-0029-A：500 條完整人生的死亡分布報告（可重跑）。
 *
 * 走正式的 application façade（`prepareP3EBrowserWorld` → `createP3EBrowserSession` →
 * 逐年 ADVANCE_YEAR、遇到 pending 選第一個選項），因此分佈包含出生國、性別、
 * 事件 effects 與健康變化對死亡風險的影響；不是只看 mortality 表。
 *
 * 產出 `reports/p3d-mortality-distribution.json`，同時做：
 * - 同 seed 重播（死亡年齡／死因／最終 state hash 必須完全相同）；
 * - 性別與地區分組比較（不是逐項相同）；
 * - 驗收門檻（單一年齡 ≤ 10%、≥ 25 個不同年齡、中位 68–88、≥60% 活到 60、≥15% 活到 80）。
 */

const ROOT = process.cwd();
const LIVES = 500;
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const rawPacks = {
  base: {
    manifest: readJson("fixtures/p2a/manifest.v1.json"),
    datasets: {
      "country-registry": readJson("fixtures/p2a/country-registry.v1.json"),
      indicators: readJson("fixtures/p2a/indicators.v1.json"),
      "birth-weights": readJson("fixtures/p2a/birth-weights.v1.json"),
      "sensitive-names": readJson("fixtures/p2a/sensitive-names.v1.json"),
      licenses: readJson("fixtures/p2a/licenses.v1.json"),
      lineage: readJson("fixtures/p2a/lineage.v1.json")
    }
  },
  identity: {
    manifest: readJson("fixtures/p2b/manifest.v1.json"),
    datasets: {
      "country-vitals": readJson("fixtures/p2b/country-vitals.v1.json"),
      "household-profiles": readJson("fixtures/p2b/household-profiles.v1.json"),
      "name-corpus": readJson("fixtures/p2b/name-corpus.v1.json"),
      "story-templates": readJson("fixtures/p2b/story-templates.v1.json"),
      licenses: readJson("fixtures/p2b/licenses.v1.json"),
      lineage: readJson("fixtures/p2b/lineage.v1.json")
    }
  },
  events: {
    manifest: readJson("fixtures/p3b/manifest.v1.json"),
    events: (readJson("fixtures/p3b/events.v1.json") as { records: unknown[] }).records
  },
  death: {
    manifest: readJson("fixtures/p3d/manifest.v1.json"),
    datasets: {
      "cause-registry": readJson("fixtures/p3d/cause-registry.v1.json"),
      "cause-weights": readJson("fixtures/p3d/cause-weights.v1.json"),
      mortality: readJson("fixtures/p3d/mortality.v1.json"),
      licenses: readJson("fixtures/p3d/licenses.v1.json"),
      lineage: readJson("fixtures/p3d/lineage.v1.json")
    }
  }
} as const;

const world = prepareP3EBrowserWorld(rawPacks);

/** regionCode → 大洲（P2-A registry 的 `region`），只用來做分組比較。 */
const REGION_CLASS: ReadonlyMap<string, string> = new Map(
  (rawPacks.base.datasets["country-registry"] as { records: { regionCode: string; region: string }[] }).records.map(
    (record) => [record.regionCode, record.region]
  )
);

interface LifeResult {
  readonly seed: string;
  readonly entityId: string;
  readonly regionCode: string;
  readonly regionClass: string;
  readonly sex: "female" | "male";
  readonly commands: number;
  readonly decisions: number;
  readonly deathAge: number;
  readonly deathYear: number;
  readonly causeId: string | null;
  readonly deathReason: string | null;
  readonly stateHash: string;
  readonly commandHead: string;
}

function nextCommand(session: P3EPlaySession): Record<string, unknown> {
  if (session.state.phase === "pending_decision") {
    const optionId = session.state.pendingDecision?.optionIds[0] as string;
    return { type: "CHOOSE_DECISION", optionId };
  }
  return { type: "ADVANCE_YEAR", contentMode: "standard" };
}

function playLife(seed: string): LifeResult {
  let session = createP3EBrowserSession({ world, masterSeed: seed });
  let commands = 0;
  let decisions = 0;
  while (session.state.phase !== "death") {
    if (session.state.phase === "pending_decision") decisions += 1;
    const result = runP3EPlaySessionCommand({ session, command: nextCommand(session) });
    session = result.session;
    commands += 1;
    if (commands > P3E_MAX_COMMANDS) throw new Error(`${seed}: did not reach death within ${P3E_MAX_COMMANDS} commands`);
    if (session.state.age > P3E_MAX_AGE) throw new Error(`${seed}: age exceeded ${P3E_MAX_AGE}`);
  }
  const outcome = session.lastOutcome;
  const death = outcome?.kind === "advance_year" ? outcome.death : null;
  return {
    seed,
    entityId: session.state.identity.entityId,
    regionCode: session.state.identity.regionCode,
    regionClass: REGION_CLASS.get(session.state.identity.regionCode) ?? "other",
    sex: session.state.identity.sex,
    commands,
    decisions,
    deathAge: session.state.age,
    deathYear: session.state.currentYear,
    causeId: death?.causeId ?? null,
    deathReason: death?.reason ?? null,
    stateHash: session.state.stateHash,
    commandHead: session.state.commandLog.headHash
  };
}

const seeds = Array.from({ length: LIVES }, (_, index) => `p3d-mort-${String(index).padStart(3, "0")}`);
const lives: LifeResult[] = [];
for (const seed of seeds) lives.push(playLife(seed));

function distributionOf(sample: readonly LifeResult[]): {
  count: number;
  meanAge: number;
  median: number;
  p10: number;
  p90: number;
  minAge: number;
  maxAge: number;
  distinctAges: number;
  maxAgeShare: number;
  maxAgeAt: number;
  reach60: number;
  reach80: number;
  reach90: number;
  histogram: Record<string, number>;
  causes: Record<string, number>;
  reasons: Record<string, number>;
} {
  const ages = sample.map((life) => life.deathAge).sort((left, right) => left - right);
  const percentile = (p: number): number => ages[Math.min(ages.length - 1, Math.floor((ages.length - 1) * p))] as number;
  const histogram = new Map<number, number>();
  const causes: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  for (const life of sample) {
    histogram.set(life.deathAge, (histogram.get(life.deathAge) ?? 0) + 1);
    const cause = life.causeId ?? "age_ceiling";
    causes[cause] = (causes[cause] ?? 0) + 1;
    const reason = life.deathReason ?? "unknown";
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const top = [...histogram.entries()].sort((left, right) => right[1] - left[1])[0] as [number, number];
  const ageKeys = [...histogram.keys()].sort((left, right) => left - right);
  return {
    count: sample.length,
    meanAge: Number((ages.reduce((sum, age) => sum + age, 0) / ages.length).toFixed(2)),
    median: percentile(0.5),
    p10: percentile(0.1),
    p90: percentile(0.9),
    minAge: ages[0] as number,
    maxAge: ages[ages.length - 1] as number,
    distinctAges: histogram.size,
    maxAgeShare: Number((top[1] / sample.length).toFixed(4)),
    maxAgeAt: top[0],
    reach60: Number((sample.filter((life) => life.deathAge >= 60).length / sample.length).toFixed(4)),
    reach80: Number((sample.filter((life) => life.deathAge >= 80).length / sample.length).toFixed(4)),
    reach90: Number((sample.filter((life) => life.deathAge >= 90).length / sample.length).toFixed(4)),
    histogram: Object.fromEntries(ageKeys.map((age) => [String(age), histogram.get(age) as number])),
    causes,
    reasons
  };
}

const overall = distributionOf(lives);
const bySex = {
  female: distributionOf(lives.filter((life) => life.sex === "female")),
  male: distributionOf(lives.filter((life) => life.sex === "male"))
};
const regions = [...new Set(lives.map((life) => life.regionClass))].sort();
const byContinent: Record<string, ReturnType<typeof distributionOf>> = {};
for (const region of regions) byContinent[region] = distributionOf(lives.filter((life) => life.regionClass === region));

// 只列樣本數 >= 8 的國家，避免 n=1 的中位數造成誤導。
const byCountry: Record<string, { count: number; median: number }> = {};
for (const country of [...new Set(lives.map((life) => life.regionCode))]) {
  const sample = lives.filter((life) => life.regionCode === country);
  if (sample.length < 8) continue;
  byCountry[country] = { count: sample.length, median: distributionOf(sample).median };
}

/** 同 seed 重播：死亡年齡、死因、最終 state hash、commandHead 必須完全相同。 */
const replaySeeds = [seeds[0] as string, seeds[123] as string, seeds[499] as string];
const replay = replaySeeds.map((seed) => {
  const first = lives.find((life) => life.seed === seed) as LifeResult;
  const again = playLife(seed);
  return {
    seed,
    identical:
      again.deathAge === first.deathAge &&
      again.causeId === first.causeId &&
      again.stateHash === first.stateHash &&
      again.commandHead === first.commandHead &&
      again.commands === first.commands,
    first: { deathAge: first.deathAge, causeId: first.causeId, stateHash: first.stateHash },
    again: { deathAge: again.deathAge, causeId: again.causeId, stateHash: again.stateHash }
  };
});

const criteria = {
  maxAgeShareUnder10Pct: overall.maxAgeShare <= 0.1,
  atLeast25DistinctAges: overall.distinctAges >= 25,
  medianBetween68And88: overall.median >= 68 && overall.median <= 88,
  atLeast60PctReach60: overall.reach60 >= 0.6,
  atLeast15PctReach80: overall.reach80 >= 0.15,
  sameSeedReplayIdentical: replay.every((entry) => entry.identical),
  countryOrSexDistributionDiffers:
    bySex.female.median !== bySex.male.median ||
    JSON.stringify(bySex.female.histogram) !== JSON.stringify(bySex.male.histogram) ||
    (Object.keys(byContinent).length > 1 &&
      new Set(Object.values(byContinent).map((entry) => entry.median)).size > 1) ||
    (Object.keys(byCountry).length > 1 && new Set(Object.values(byCountry).map((entry) => entry.median)).size > 1),
  ageCeilingStillTerminates: overall.maxAge <= P3E_MAX_AGE
};

const report = {
  generatedBy: "scripts/p3d-mortality-distribution.ts",
  model: "game-tuned synthetic mortality (NOT a life table)",
  seedPattern: "p3d-mort-000 … p3d-mort-499",
  lives: lives.length,
  overall,
  bySex,
  byContinent,
  byCountry,
  replay,
  criteria,
  ok: Object.values(criteria).every(Boolean),
  samples: lives.slice(0, 5)
};

mkdirSync(join(ROOT, "reports"), { recursive: true });
writeFileSync(join(ROOT, "reports", "p3d-mortality-distribution.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  `P3D-MORTALITY-DISTRIBUTION ${report.ok ? "OK" : "FAIL"} lives=${report.lives} ` +
    `median=${overall.median} p10=${overall.p10} p90=${overall.p90} ` +
    `ages=${overall.distinctAges}maxAgeShare=${overall.maxAgeShare}@${overall.maxAgeAt} ` +
    `reach60=${overall.reach60} reach80=${overall.reach80} replay=${criteria.sameSeedReplayIdentical}`
);
if (!report.ok) process.exitCode = 1;
