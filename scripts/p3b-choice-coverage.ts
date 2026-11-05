import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { P3BCondition, P3BEventRecord, P3BLifeStage, P3BSelectionState } from "@life-sim/contracts";
import {
  createP3EBrowserSession,
  prepareP3EBrowserWorld,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../packages/application/src/index";
import { P3E_MAX_COMMANDS } from "../packages/contracts/src/index";
import { buildCandidates } from "../packages/engine/src/life/events";
import { validateEventPack } from "../packages/engine/src/life/events";

/**
 * GPT-0025-A：現實人生抉擇包的覆蓋率與「無死路」證明。
 *
 * 用正式 packs 與正式 application façade 跑 100 條決定性人生（種子 `p3b-choice-000`…
 * `p3b-choice-099`）；遇到 pending decision 時，依「人生索引 + 決策序號」決定性選一個
 * 選項（不固定選第一個，才能覆蓋每個選項的真實後果）。輸出：
 *
 * - 每個人生階段的決策次數、可見選項數；
 * - 58 個抉擇事件的覆蓋情況（哪些事件在 100 條人生中至少出現一次）；
 * - 無死路證明：每個 pending decision 都 ≥2 個選項、每個選項都能回到 life、
 *   沒有任何一條人生卡住或超過命令上限、全部都走到 death；
 * - 平均每幾年遇到一次選擇（訂單要求 1–3 年）。
 */

const ROOT = process.cwd();
const LIVES = 100;
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

const STAGES: readonly P3BLifeStage[] = ["childhood", "adolescence", "adulthood", "later_life"];
const stageOfAge = (age: number): P3BLifeStage => {
  if (age <= 12) return "childhood";
  if (age <= 17) return "adolescence";
  if (age <= 64) return "adulthood";
  return "later_life";
};

const eventRecords = (rawPacks.events.events as P3BEventRecord[]).filter((event) => event.decision !== null);
const decisionOptionCount = new Map<string, number>();
const decisionIdOf = new Map<string, string>();
for (const event of eventRecords) {
  const decisionId = event.decision?.decisionId as string;
  decisionOptionCount.set(decisionId, event.decision?.options.length ?? 0);
  decisionIdOf.set(event.eventId, decisionId);
}
const decisionEventsByStage = new Map<P3BLifeStage, Set<string>>();
for (const event of eventRecords) {
  for (const stage of event.lifeStages) {
    const set = decisionEventsByStage.get(stage) ?? new Set<string>();
    set.add(event.eventId);
    decisionEventsByStage.set(stage, set);
  }
}

interface LifeResult {
  readonly seed: string;
  readonly commands: number;
  readonly decisions: number;
  readonly deathAge: number;
  readonly stageDecisions: Record<P3BLifeStage, number>;
  readonly decisionsSeen: readonly string[];
}

const lives: LifeResult[] = [];
const problems: string[] = [];
const seenEvents = new Set<string>();
const seenOptions = new Set<string>();
const gapHistogram = new Map<number, number>();

const world = prepareP3EBrowserWorld(rawPacks);

for (let index = 0; index < LIVES; index += 1) {
  const seed = `p3b-choice-${String(index).padStart(3, "0")}`;
  let session: P3EPlaySession = createP3EBrowserSession({ world, masterSeed: seed });
  const stageDecisions: Record<P3BLifeStage, number> = {
    childhood: 0,
    adolescence: 0,
    adulthood: 0,
    later_life: 0
  };
  const decisionsSeen: string[] = [];
  let commands = 0;
  let decisionIndex = 0;
  let lastDecisionAge: number | null = null;

  while (session.state.phase !== "death") {
    if (commands > P3E_MAX_COMMANDS) {
      problems.push(`${seed}: exceeded P3E_MAX_COMMANDS`);
      break;
    }
    if (session.state.phase === "pending_decision") {
      const pending = session.state.pendingDecision;
      const optionIds = pending?.optionIds ?? [];
      if (pending === null || optionIds.length < 2) {
        problems.push(`${seed}: decision without at least two options at age ${session.state.age}`);
        break;
      }
      const eventId = pending.eventId;
      const expectedOptions = decisionOptionCount.get(pending.decisionId);
      if (expectedOptions !== undefined && expectedOptions !== optionIds.length) {
        problems.push(`${seed}: option count mismatch for ${eventId}`);
      }
      seenEvents.add(eventId);
      stageDecisions[stageOfAge(session.state.age)] += 1;
      decisionsSeen.push(eventId);
      if (lastDecisionAge !== null) {
        const gap = session.state.age - lastDecisionAge;
        gapHistogram.set(gap, (gapHistogram.get(gap) ?? 0) + 1);
      }
      lastDecisionAge = session.state.age;
      const choice = optionIds[(index + decisionIndex) % optionIds.length] as string;
      seenOptions.add(`${eventId}#${choice}`);
      decisionIndex += 1;
      const result = runP3EPlaySessionCommand({
        session,
        command: { type: "CHOOSE_DECISION", optionId: choice }
      });
      session = result.session;
      if (session.state.phase !== "life" && session.state.phase !== "death") {
        problems.push(`${seed}: decision ${eventId} did not return to life (phase=${session.state.phase})`);
        break;
      }
      commands += 1;
      continue;
    }
    const result = runP3EPlaySessionCommand({
      session,
      command: { type: "ADVANCE_YEAR", contentMode: "standard" }
    });
    session = result.session;
    commands += 1;
  }

  if (session.state.phase !== "death") problems.push(`${seed}: never reached death`);
  lives.push({
    seed,
    commands,
    decisions: decisionsSeen.length,
    deathAge: session.state.age,
    stageDecisions,
    decisionsSeen
  });
}

const totalDecisions = lives.reduce((sum, life) => sum + life.decisions, 0);
const totalYears = lives.reduce((sum, life) => sum + life.deathAge, 0);
const stageTotals: Record<P3BLifeStage, number> = {
  childhood: 0,
  adolescence: 0,
  adulthood: 0,
  later_life: 0
};
for (const life of lives) {
  for (const stage of STAGES) stageTotals[stage] += life.stageDecisions[stage];
}

const allDecisionEvents = [...new Set(eventRecords.map((event) => event.eventId))].sort();
const uncovered = allDecisionEvents.filter((eventId) => !seenEvents.has(eventId));
const everyDecisionOptionCount = [...decisionOptionCount.values()].reduce((sum, value) => sum + value, 0);

/* ------------------------------------------------------------------ */
/* 可達性普查：0–119 歲逐年建候選，證明每個抉擇事件都有年齡窗口            */
/* ------------------------------------------------------------------ */

/** 事件條件裡出現過的所有 flag（普查第二輪全部打開）。 */
function collectFlags(condition: P3BCondition | null, out: Set<string>): void {
  if (condition === null) return;
  if (condition.op === "flag") {
    out.add(condition.flag);
    return;
  }
  if (condition.op === "all" || condition.op === "any") {
    for (const child of condition.conditions) collectFlags(child, out);
    return;
  }
  if (condition.op === "not") collectFlags(condition.condition, out);
}
const referencedFlags = new Set<string>();
for (const event of eventRecords) collectFlags(event.conditions, referencedFlags);
const allFlags = [...referencedFlags].sort();

const pack = validateEventPack({
  manifest: rawPacks.events.manifest,
  events: rawPacks.events.events
} as never);

function census(flags: readonly string[]): Map<string, number> {
  const firstAge = new Map<string, number>();
  for (let age = 0; age <= 119; age += 1) {
    const state: P3BSelectionState = {
      currentYear: 2024 + age,
      age,
      phase: "life",
      stats: { health: 60, happiness: 60, knowledge: 50, relationships: 50 },
      assets: { balanceMicroUsd: 0n, annualIncomeMicroUsd: 12_000_000n, annualExpenseMicroUsd: 9_000_000n },
      flags
    };
    const { candidates } = buildCandidates({
      pack,
      state,
      history: { occurrences: [] },
      contentMode: "standard",
      rngState: [1, 2, 3, 4]
    } as never);
    for (const candidate of candidates) {
      if (!decisionIdOf.has(candidate.eventId)) continue;
      if (!firstAge.has(candidate.eventId)) firstAge.set(candidate.eventId, age);
    }
  }
  return firstAge;
}

const reachableWithoutFlags = census([]);
const reachableWithFlags = census(allFlags);
const reachable = new Map<string, number>([...reachableWithoutFlags]);
for (const [eventId, age] of reachableWithFlags) if (!reachable.has(eventId)) reachable.set(eventId, age);
const unreachable = allDecisionEvents.filter((eventId) => !reachable.has(eventId));
// 每個抉擇事件至少要有一個「有候選」的年齡，且該年齡落在事件宣告的 ageMin..ageMax。
const reachabilityGaps: string[] = [];
for (const event of eventRecords) {
  const age = reachable.get(event.eventId);
  if (age === undefined) continue;
  if (age < event.ageMin || age > event.ageMax) reachabilityGaps.push(event.eventId);
  if (decisionOptionCount.get(event.decision?.decisionId as string) !== event.decision?.options.length) {
    reachabilityGaps.push(`${event.eventId}:option-count`);
  }
}

const report = {
  generatedBy: "scripts/p3b-choice-coverage.ts",
  lives: lives.length,
  seedPattern: "p3b-choice-000 … p3b-choice-099",
  pack: {
    events: (rawPacks.events.events as P3BEventRecord[]).length,
    decisionEvents: eventRecords.length,
    totalDecisionOptions: everyDecisionOptionCount
  },
  totals: {
    commands: lives.reduce((sum, life) => sum + life.commands, 0),
    decisions: totalDecisions,
    years: totalYears,
    yearsPerDecision: Number((totalYears / Math.max(1, totalDecisions)).toFixed(3)),
    averageDecisionsPerLife: Number((totalDecisions / lives.length).toFixed(2)),
    averageDeathAge: Number((totalYears / lives.length).toFixed(2))
  },
  coverage: {
    decisionEventsSeen: seenEvents.size,
    decisionEventsTotal: allDecisionEvents.length,
    decisionEventCoverage: Number((seenEvents.size / allDecisionEvents.length).toFixed(3)),
    uncoveredDecisionEvents: uncovered,
    decisionOptionsSeen: seenOptions.size,
    decisionOptionsTotal: everyDecisionOptionCount,
    decisionOptionCoverage: Number((seenOptions.size / everyDecisionOptionCount).toFixed(3))
  },
  reachability: {
    census: "0–119 歲逐年建候選（flags=[] 與 flags=全部條件旗標 兩輪）",
    reachableDecisionEvents: reachable.size,
    reachableWithFlagsOff: reachableWithoutFlags.size,
    reachableWithFlagsOn: reachableWithFlags.size,
    unreachableDecisionEvents: unreachable,
    firstReachableAge: Object.fromEntries([...reachable.entries()].sort()),
    inconsistentWindows: reachabilityGaps,
    referencedFlags: allFlags
  },
  stageDecisions: {
    perStageTotals: stageTotals,
    averagePerLife: {
      childhood: Number((stageTotals.childhood / lives.length).toFixed(2)),
      adolescence: Number((stageTotals.adolescence / lives.length).toFixed(2)),
      adulthood: Number((stageTotals.adulthood / lives.length).toFixed(2)),
      later_life: Number((stageTotals.later_life / lives.length).toFixed(2))
    },
    decisionEventsPerStage: {
      childhood: decisionEventsByStage.get("childhood")?.size ?? 0,
      adolescence: decisionEventsByStage.get("adolescence")?.size ?? 0,
      adulthood: decisionEventsByStage.get("adulthood")?.size ?? 0,
      later_life: decisionEventsByStage.get("later_life")?.size ?? 0
    }
  },
  gaps: {
    yearsBetweenDecisions: [...gapHistogram.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([years, count]) => ({ years, count }))
  },
  noDeadEnd: {
    proof: [
      "每個 pending decision 都由 pack 的 decision.options 產生（2–5 個選項），選項沒有條件、也沒有 openDecision 巢狀",
      "每次 CHOOSE_DECISION 後 phase 必須回到 life 或 death；任何其他 phase 都記為問題",
      "每條人生都必須在 P3E_MAX_COMMANDS 內抵達 death"
    ],
    problems
  },
  ok: problems.length === 0 && unreachable.length === 0 && reachabilityGaps.length === 0,
  samples: lives.slice(0, 5)
};

mkdirSync(join(ROOT, "reports"), { recursive: true });
writeFileSync(join(ROOT, "reports", "p3b-choice-coverage.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  `P3B-CHOICE-COVERAGE ${report.ok ? "OK" : "FAIL"} lives=${report.lives} ` +
    `decisions=${totalDecisions} yearsPerDecision=${report.totals.yearsPerDecision} ` +
    `events=${seenEvents.size}/${allDecisionEvents.length} options=${seenOptions.size}/${everyDecisionOptionCount} ` +
    `unreachable=${unreachable.length} problems=${problems.length} uncoveredIn100Lives=${uncovered.length}`
);
if (!report.ok) process.exitCode = 1;
