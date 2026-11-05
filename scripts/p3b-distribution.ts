import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { P3BEventPackManifest, P3BEventRecord, P3BSelection, P3BSelectionState } from "@life-sim/contracts";
import { deriveDomainState } from "../packages/engine/src/rng/seed";
import { computeLifeStateHash } from "../packages/engine/src/life";
import { selectEvent, validateEventPack } from "../packages/engine/src/life/events";
import { canonicalBytes } from "../packages/engine/src/canonical/canonical";
import { sha256Hex } from "../packages/engine/src/rng/sha256";

/**
 * P3-B 分布報告：同一份 pack、同一個 state、10,000 個不同 RNG state。
 *
 * 檢查：
 * 1. 每個事件的觀測次數必須落在期望值的 ±4σ（σ = sqrt(n·p·(1-p))）。
 * 2. 整個 10,000 次重跑一次，tally 與 digest 必須完全相同（決定性）。
 * 3. 每次抽選的 rngStateBefore/After、drawsUsed 全部記錄在 digest 裡。
 */

const ROOT = process.cwd();
const DIR = join(ROOT, "fixtures", "p3b");
const REPORT_DIR = join(ROOT, "reports");
const DRAWS = 10_000;
const SEED_PREFIX = "p3b-dist-20261027";

const manifest = JSON.parse(readFileSync(join(DIR, "manifest.v1.json"), "utf8")) as P3BEventPackManifest;
const dataset = JSON.parse(readFileSync(join(DIR, "events.v1.json"), "utf8")) as { records: P3BEventRecord[] };
const pack = validateEventPack({ manifest, events: dataset.records });

const state: P3BSelectionState = {
  currentYear: 2050,
  age: 30,
  phase: "life",
  stats: { health: 60, happiness: 60, knowledge: 50, relationships: 50 },
  assets: { balanceMicroUsd: 0n, annualIncomeMicroUsd: 12_000_000n, annualExpenseMicroUsd: 9_000_000n },
  flags: []
};

function run(): { tally: Map<string, number>; draws: Map<number, number>; digest: string; candidates: readonly string[] } {
  const tally = new Map<string, number>();
  const draws = new Map<number, number>();
  const selections: P3BSelection[] = [];
  for (let index = 0; index < DRAWS; index += 1) {
    const selection = selectEvent({
      pack,
      state,
      contentMode: "standard",
      history: { occurrences: [] },
      rngState: deriveDomainState(`${SEED_PREFIX}-${index}`, "events")
    });
    if (selection.selectedEventId === null) throw new Error(`no selection at ${index}`);
    tally.set(selection.selectedEventId, (tally.get(selection.selectedEventId) ?? 0) + 1);
    draws.set(selection.drawsUsed, (draws.get(selection.drawsUsed) ?? 0) + 1);
    selections.push(selection);
  }
  const digest = sha256Hex(
    canonicalBytes(selections.map((selection) => ({ id: selection.selectedEventId, hash: selection.selectionHash })) as never)
  );
  const candidates = (selections[0] as P3BSelection).candidates.map((candidate) => candidate.eventId);
  return { tally, draws, digest, candidates };
}

const first = run();
const second = run();
const deterministic = first.digest === second.digest && JSON.stringify([...first.tally]) === JSON.stringify([...second.tally]);

const weights = new Map<string, number>();
for (const eventId of first.candidates) {
  const record = pack.events.find((event) => event.eventId === eventId);
  if (record === undefined) throw new Error(`missing record ${eventId}`);
  weights.set(eventId, record.weight);
}
const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);

const rows = first.candidates.map((eventId) => {
  const weight = weights.get(eventId) as number;
  const expectedP = weight / totalWeight;
  const expected = expectedP * DRAWS;
  const observed = first.tally.get(eventId) ?? 0;
  const sigma = Math.sqrt(DRAWS * expectedP * (1 - expectedP));
  const z = sigma === 0 ? 0 : (observed - expected) / sigma;
  return {
    eventId,
    weight,
    expectedShare: Number(expectedP.toFixed(6)),
    expectedCount: Number(expected.toFixed(2)),
    observedCount: observed,
    observedShare: Number((observed / DRAWS).toFixed(6)),
    sigma: Number(sigma.toFixed(3)),
    z: Number(z.toFixed(3)),
    within4Sigma: Math.abs(z) <= 4
  };
});

const allWithin = rows.every((row) => row.within4Sigma);
const coverCount = rows.reduce((sum, row) => sum + row.observedCount, 0);
const report = {
  version: "P3-B",
  generatedAt: "2026-10-27",
  packId: pack.manifest.eventPackId,
  packChecksum: pack.manifest.packChecksum,
  draws: DRAWS,
  seedPrefix: SEED_PREFIX,
  contentMode: "standard",
  state: {
    currentYear: state.currentYear,
    age: state.age,
    phase: state.phase,
    stats: state.stats,
    assets: {
      balanceMicroUsd: state.assets.balanceMicroUsd.toString(),
      annualIncomeMicroUsd: state.assets.annualIncomeMicroUsd.toString(),
      annualExpenseMicroUsd: state.assets.annualExpenseMicroUsd.toString()
    },
    flags: state.flags
  },
  candidates: first.candidates,
  totalWeight,
  rows,
  drawsHistogram: Object.fromEntries([...first.draws.entries()].map(([draws, count]) => [String(draws), count])),
  coverCount,
  deterministic,
  digest: first.digest,
  verdict: allWithin && deterministic && coverCount === DRAWS ? "PASS" : "FAIL"
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(join(REPORT_DIR, "p3b-distribution-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

const summary = [
  "# P3-B 抽選分布報告（10,000 次）",
  "",
  `| 項目 | 值 |`,
  `|---|---|`,
  `| pack | \`${report.packId}\` |`,
  `| packChecksum | \`${report.packChecksum.slice(0, 16)}…\` |`,
  `| 抽選次數 | ${DRAWS} |`,
  `| 候選 | ${report.candidates.join("、")} |`,
  `| 權重總和 | ${totalWeight} |`,
  `| 決定性（重跑兩次） | ${deterministic ? "相同" : "**不同**"} |`,
  `| 每次 draws | ${JSON.stringify(report.drawsHistogram)} |`,
  `| digest | \`${report.digest.slice(0, 16)}…\` |`,
  `| 判定 | **${report.verdict}** |`,
  "",
  "| eventId | weight | 期望占比 | 期望次數 | 觀測次數 | 觀測占比 | z | ±4σ |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map(
    (row) =>
      `| \`${row.eventId}\` | ${row.weight} | ${(row.expectedShare * 100).toFixed(2)}% | ${row.expectedCount} | ${row.observedCount} | ${(row.observedShare * 100).toFixed(2)}% | ${row.z} | ${row.within4Sigma ? "OK" : "**FAIL**"} |`
  ),
  "",
  "---",
  "",
  "由 `scripts/p3b-distribution.ts` 產生；判準是「觀測次數落在期望值 ±4σ」且重跑兩次結果完全相同。"
].join("\n");
writeFileSync(join(ROOT, "P3-B-distribution-report.md"), `${summary}\n`, "utf8");

console.log(
  `P3B-DISTRIBUTION-${report.verdict === "PASS" ? "OK" : "FAIL"} draws=${DRAWS} candidates=${first.candidates.length} ` +
    `digest=${report.digest.slice(0, 16)}… deterministic=${deterministic}`
);
if (report.verdict !== "PASS") process.exitCode = 1;
