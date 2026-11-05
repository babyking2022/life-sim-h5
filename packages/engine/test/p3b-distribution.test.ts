import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { P3BEventPackManifest, P3BEventRecord, P3BSelectionState } from "@life-sim/contracts";
import { deriveDomainState } from "../src/rng/seed";
import { sha256Hex } from "../src/rng/sha256";
import { canonicalBytes } from "../src/canonical/canonical";
import { selectEvent, validateEventPack } from "../src/life/events";

/**
 * P3-B 分布報告回歸：重跑 10,000 次抽選，必須與 `reports/p3b-distribution-report.json` 的
 * digest 完全一致，且每個事件都在期望值 ±4σ 內。
 */

const ROOT = process.cwd();
const DIR = join(ROOT, "fixtures", "p3b");
const DRAWS = 10_000;
const SEED_PREFIX = "p3b-dist-20261027";

const manifest = JSON.parse(readFileSync(join(DIR, "manifest.v1.json"), "utf8")) as P3BEventPackManifest;
const dataset = JSON.parse(readFileSync(join(DIR, "events.v1.json"), "utf8")) as { records: P3BEventRecord[] };
const pack = validateEventPack({ manifest, events: dataset.records });

const report = JSON.parse(readFileSync(join(ROOT, "reports", "p3b-distribution-report.json"), "utf8")) as {
  draws: number;
  digest: string;
  verdict: string;
  deterministic: boolean;
  totalWeight: number;
  rows: readonly { eventId: string; weight: number; observedCount: number; expectedCount: number; within4Sigma: boolean }[];
  drawsHistogram: Record<string, number>;
  candidates: readonly string[];
};

const state: P3BSelectionState = {
  currentYear: 2050,
  age: 30,
  phase: "life",
  stats: { health: 60, happiness: 60, knowledge: 50, relationships: 50 },
  assets: { balanceMicroUsd: 0n, annualIncomeMicroUsd: 12_000_000n, annualExpenseMicroUsd: 9_000_000n },
  flags: []
};

interface Tally {
  readonly counts: Map<string, number>;
  readonly draws: Map<number, number>;
  readonly digest: string;
  readonly candidates: readonly string[];
}

function run(): Tally {
  const counts = new Map<string, number>();
  const draws = new Map<number, number>();
  const hashes: { id: string | null; hash: string }[] = [];
  for (let index = 0; index < DRAWS; index += 1) {
    const selection = selectEvent({
      pack,
      state,
      contentMode: "standard",
      history: { occurrences: [] },
      rngState: deriveDomainState(`${SEED_PREFIX}-${index}`, "events")
    });
    if (selection.selectedEventId === null) throw new Error(`no selection at ${index}`);
    counts.set(selection.selectedEventId, (counts.get(selection.selectedEventId) ?? 0) + 1);
    draws.set(selection.drawsUsed, (draws.get(selection.drawsUsed) ?? 0) + 1);
    hashes.push({ id: selection.selectedEventId, hash: selection.selectionHash });
    if (index === 0) {
      expect(selection.candidates.map((candidate) => candidate.eventId)).toEqual([...report.candidates]);
    }
  }
  // digest 與產生器相同：sha256(canonicalBytes([{id, hash}...]))
  return {
    counts,
    draws,
    digest: sha256Hex(canonicalBytes(hashes as never)),
    candidates: report.candidates
  };
}

describe("P3-B 分布：10,000 次抽選", () => {
  it("reproduces the committed report digest and passes the ±4σ check", () => {
    const first = run();
    const second = run();
    expect(second.digest).toBe(first.digest);
    expect(first.digest).toBe(report.digest);
    expect(report.verdict).toBe("PASS");
    expect(report.deterministic).toBe(true);

    const total = [...first.counts.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBe(DRAWS);

    let weightSum = 0;
    for (const row of report.rows) {
      expect(first.counts.get(row.eventId)).toBe(row.observedCount);
      expect(row.within4Sigma).toBe(true);
      weightSum += row.weight;
    }
    expect(weightSum).toBe(report.totalWeight);

    // 每次多候選抽選都必須是 2 個 u32 draws。
    expect(report.drawsHistogram).toEqual({ "2": DRAWS });
    expect(first.draws.get(2)).toBe(DRAWS);
  }, 60_000);
});
