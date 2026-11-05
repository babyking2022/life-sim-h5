import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { P3ABootstrap, P3CLifeState, VersionTuple } from "@life-sim/contracts";
import { validateEventPack, type ValidatedEventPack } from "../packages/engine/src/life/events/validate";
import { createEventLifeStateForBenchmark, eventLifeProjectionHash } from "../packages/engine/src/life/annual/state";
import { applyEventLifeCommand } from "../packages/engine/src/life/annual/commands";
import { resolveEventYearCore } from "../packages/engine/src/life/annual/transaction";
import { verifyEventLifeStateForBenchmark } from "../packages/engine/src/life/annual/replay";

/**
 * P3-C 內部入口探針（只給 `scripts/p3c-benchmark-isolation.mjs` 用）。
 *
 * 存在理由與 P3-A 的 `p3a-benchmark-probe.ts` 相同：公開 barrel 拿不到任意壽命，
 * 這支探針才能建立 2,000／5,000／10,000 年的 benchmark 狀態，證明內部入口仍可用。
 */

const ROOT = process.cwd();

export function loadPack(): ValidatedEventPack {
  const manifest = JSON.parse(readFileSync(join(ROOT, "fixtures", "p3c", "manifest.v1.json"), "utf8"));
  const dataset = JSON.parse(readFileSync(join(ROOT, "fixtures", "p3c", "events.v1.json"), "utf8"));
  return validateEventPack({ manifest, events: dataset.records });
}

export function benchVersions(lifespanYears: number): VersionTuple {
  return {
    engineVersion: "0.1.0",
    rulesetVersion: `p3c-bench-${lifespanYears}`,
    rngSpecVersion: "1.0.0",
    dataVersion: "identity-1.0.0",
    contentVersion: "skeleton-1.1.0",
    saveFormatVersion: 4
  };
}

export function benchBootstrap(lifespanYears: number, seed = "p3c-isolation"): P3ABootstrap {
  return {
    versions: benchVersions(lifespanYears),
    origin: {
      certificateHash: "a".repeat(64),
      certificateId: `cert:${"b".repeat(24)}`,
      playerIdentityHash: "c".repeat(64),
      masterSeedHash: "d".repeat(64),
      basePackId: "p2a-synthetic-20261027",
      basePackChecksum: "e".repeat(64),
      identityPackId: "p2b-synthetic-20261027",
      identityPackChecksum: "f".repeat(64)
    },
    birthYear: 2020,
    paceLifeYearsX10: 780,
    rngState: [0x1234, 0x5678, 0x9abc, seed.length]
  } as P3ABootstrap;
}

export function makeBenchState(lifespanYears: number): P3CLifeState {
  return createEventLifeStateForBenchmark(benchBootstrap(lifespanYears), loadPack(), lifespanYears);
}

export function verifyBench(lifespanYears: number, state: P3CLifeState): boolean {
  verifyEventLifeStateForBenchmark(benchBootstrap(lifespanYears), state, loadPack());
  return true;
}

export function runBenchmark(years: number): {
  yearsRecorded: number;
  stateHashValid: boolean;
  selectedEvents: number;
  eventsRngDraws: number;
  stateBytes: number;
} {
  const pack = loadPack();
  let state = makeBenchState(years + 10);
  for (let index = 0; index < years; index += 1) {
    if (state.pendingDecision !== null) {
      // benchmark 也必須走正式 SELECT ＋ CONFIRM（不自動套用 option effects）。
      const optionIds = [...state.pendingDecision.options.map((option) => option.optionId)].sort();
      state = applyEventLifeCommand(state, { type: "SELECT_DECISION", optionId: optionIds[0] as string }, pack).state;
      state = applyEventLifeCommand(state, { type: "NEXT" }, pack).state;
      index -= 1;
      continue;
    }
    if (state.phase !== "life") break;
    state = resolveEventYearCore(state, pack).state;
  }
  return {
    yearsRecorded: state.history.yearsRecorded,
    stateHashValid: eventLifeProjectionHash(state) === state.stateHash,
    selectedEvents: state.history.yearsRecorded,
    eventsRngDraws: state.events.rng.draws,
    stateBytes: JSON.stringify(state, (_key, value) => (typeof value === "bigint" ? value.toString() : value)).length
  };
}
