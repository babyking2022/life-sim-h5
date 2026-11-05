import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { P3ABootstrap, P3ACommand, P3BEventPackManifest, P3BEventRecord, P3CLifeState, P3CYearDelta, VersionTuple } from "@life-sim/contracts";
import { P3C_CONTENT_VERSION, P3C_RULESET_VERSION, P3C_SAVE_FORMAT_VERSION } from "@life-sim/contracts";
import {
  computeEventsChecksum,
  computePackChecksum,
  validateEventPack,
  type ValidatedEventPack
} from "../src/life/events/validate";
import { createEventLifeState } from "../src/life/annual/state";
import { applyEventLifeCommand } from "../src/life/annual/commands";

/** P3-C 測試共用工具（engine 層）：固定 pack、bootstrap、對抗性 pack 重建、四種推進模式。 */

const ROOT = process.cwd();

export interface RawPack {
  readonly manifest: P3BEventPackManifest;
  readonly events: readonly P3BEventRecord[];
}

function readJson<T>(dir: string, file: string): T {
  return JSON.parse(readFileSync(join(ROOT, dir, file), "utf8")) as T;
}

export function loadRawPack(manifestFile = "manifest.v1.json", eventsFile = "events.v1.json", dir = "fixtures/p3c"): RawPack {
  const manifest = readJson<P3BEventPackManifest>(dir, manifestFile);
  const dataset = readJson<{ records: P3BEventRecord[] }>(dir, eventsFile);
  return { manifest, events: dataset.records };
}

export function validateRaw(raw: RawPack): ValidatedEventPack {
  return validateEventPack({ manifest: raw.manifest, events: [...raw.events] });
}

/** P3-C 專用測試 pack（main）。 */
export function loadPack(): ValidatedEventPack {
  return validateRaw(loadRawPack());
}

/** edge pack：單候選／0 候選／guardian 過濾可精準控制。 */
export function loadEdgePack(): ValidatedEventPack {
  return validateRaw(loadRawPack("edge-manifest.v1.json", "edge-events.v1.json"));
}

/** P3-B 的真實 22 事件 pack（golden／回歸用）。 */
export function loadP3bPack(): ValidatedEventPack {
  return validateRaw(loadRawPack("manifest.v1.json", "events.v1.json", "fixtures/p3b"));
}

/**
 * 對抗性 pack 重建：改事件內容後**重算** dataset／license／lineage／pack checksum，
 * 這樣才能通過 `validateEventPack`，用來單獨測「語意層」的拒絕（而不是 checksum 層）。
 */
export function repack(base: RawPack, mutate: (events: P3BEventRecord[]) => P3BEventRecord[]): ValidatedEventPack {
  const events = mutate(base.events.map((entry) => ({ ...entry })));
  const sorted = [...events].sort((left, right) => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0));
  const datasetChecksum = computeEventsChecksum(sorted);
  const manifest: P3BEventPackManifest = {
    ...base.manifest,
    datasets: [{ ...(base.manifest.datasets[0] as P3BEventPackManifest["datasets"][number]), recordCount: sorted.length, checksum: datasetChecksum }],
    licenses: base.manifest.licenses.map((license) => ({ ...license, checksum: datasetChecksum })),
    lineage: base.manifest.lineage.map((record) => ({ ...record, outputChecksum: datasetChecksum }))
  };
  const packChecksum = computePackChecksum(manifest);
  return validateEventPack({ manifest: { ...manifest, packChecksum }, events: sorted });
}

export const P3C_VERSIONS: VersionTuple = {
  engineVersion: "0.1.0",
  rulesetVersion: P3C_RULESET_VERSION,
  rngSpecVersion: "1.0.0",
  dataVersion: "identity-1.0.0",
  contentVersion: P3C_CONTENT_VERSION,
  saveFormatVersion: P3C_SAVE_FORMAT_VERSION
};

export const P3C_ORIGIN = {
  certificateHash: "a".repeat(64),
  certificateId: `cert:${"b".repeat(24)}`,
  playerIdentityHash: "c".repeat(64),
  masterSeedHash: "d".repeat(64),
  basePackId: "p2a-synthetic-20261027",
  basePackChecksum: "e".repeat(64),
  identityPackId: "p2b-synthetic-20261027",
  identityPackChecksum: "f".repeat(64)
};

export function makeBootstrap(overrides: Partial<P3ABootstrap> = {}): P3ABootstrap {
  return {
    versions: P3C_VERSIONS,
    origin: P3C_ORIGIN,
    birthYear: 2020,
    paceLifeYearsX10: 780,
    rngState: [0x1234, 0x5678, 0x9abc, 0xdef0],
    ...overrides
  } as P3ABootstrap;
}

export function newLife(pack: ValidatedEventPack, overrides: Partial<P3ABootstrap> = {}): P3CLifeState {
  return createEventLifeState(makeBootstrap(overrides), pack);
}

export function runCommand(state: P3CLifeState, pack: ValidatedEventPack, command: P3ACommand): P3CLifeState {
  return applyEventLifeCommand(state, command, pack).state;
}

export function runCommandWithDeltas(
  state: P3CLifeState,
  pack: ValidatedEventPack,
  command: P3ACommand
): { state: P3CLifeState; deltas: readonly P3CYearDelta[] } {
  return applyEventLifeCommand(state, command, pack);
}

/** 前進一年（若停在抉擇則 no-op）；回傳新狀態。 */
export function advanceOneYear(state: P3CLifeState, pack: ValidatedEventPack): P3CLifeState {
  return runCommand(state, pack, { type: "FAST_FORWARD_STEP", maxYears: 1 });
}

export type AdvanceMode = "fast_forward" | "tick" | "speed1" | "speed16";

export interface DrivenEngineLife {
  readonly state: P3CLifeState;
  readonly deltas: readonly P3CYearDelta[];
  readonly selected: readonly (string | null)[];
  readonly selections: readonly string[];
  readonly ticks: number;
}

/** 以指定模式推進到 `years` 年；抉擇用 canonical 最小 optionId（測試策略，不是引擎行為）。 */
export function driveYears(pack: ValidatedEventPack, years: number, mode: AdvanceMode = "fast_forward", overrides: Partial<P3ABootstrap> = {}): DrivenEngineLife {
  let state = newLife(pack, overrides);
  const deltas: P3CYearDelta[] = [];
  let ticks = 0;

  const push = (result: { state: P3CLifeState; deltas: readonly P3CYearDelta[] }): void => {
    state = result.state;
    for (const delta of result.deltas) deltas.push(delta);
  };

  if (mode === "fast_forward") push(runCommandWithDeltas(state, pack, { type: "SET_PLAYBACK", paused: false }));

  while (state.history.yearsRecorded < years && state.phase !== "death" && state.phase !== "error") {
    if (state.pendingDecision !== null) {
      const optionIds = [...state.pendingDecision.options.map((option) => option.optionId)].sort();
      push(runCommandWithDeltas(state, pack, { type: "SELECT_DECISION", optionId: optionIds[0] as string }));
      push(runCommandWithDeltas(state, pack, { type: "NEXT" }));
      continue;
    }
    if (mode === "fast_forward") {
      push(runCommandWithDeltas(state, pack, { type: "FAST_FORWARD_STEP", maxYears: 1 }));
      if (state.playback.mode === "fast_forward") push(runCommandWithDeltas(state, pack, { type: "SET_PLAYBACK", paused: false }));
      continue;
    }
    const speed = mode === "speed16" ? 16 : 1;
    push(runCommandWithDeltas(state, pack, { type: "SET_PLAYBACK", paused: false, speed: speed as 1 | 16 }));
    const target = state.history.yearsRecorded + 1;
    while (state.history.yearsRecorded < target && state.pendingDecision === null && state.phase === "life") {
      push(runCommandWithDeltas(state, pack, { type: "TICK", deltaMs: 1000 }));
      ticks += 1;
      if (ticks > 5_000_000) throw new Error("tick mode did not advance a year");
    }
  }

  return {
    state,
    deltas,
    selected: deltas.map((delta) => delta.event.eventId),
    selections: deltas.map((delta) => delta.event.selectionHash),
    ticks
  };
}
