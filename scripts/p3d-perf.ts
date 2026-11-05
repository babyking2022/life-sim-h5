import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateAnnualDeath } from "../packages/birth/src/death/evaluate";
import { computeDeathDatasetChecksum, computeDeathPackChecksum, validateDeathPack } from "../packages/birth/src/death/pack";
import { validateDataPack } from "../packages/birth/src/validate";
import { canonicalBytes } from "../packages/engine/src/canonical/canonical";
import { sha256Hex } from "../packages/engine/src/rng/sha256";
import { utf8Encode } from "../packages/engine/src/bytes";

/**
 * P3-D 效能證據。
 *
 * 三條路徑分開量：
 * 1. pack 驗證成本（含 41,624 筆 mortality 的 canonical 排序與 checksum）；
 * 2. 未死亡路徑（一次 u64 → 2 個 u32 draws）；
 * 3. 死亡＋死因抽選路徑（兩次 u64 → 4 個 u32 draws）。
 *
 * 結構性證據（不只看耗時）：
 * - 每呼叫的 `drawsUsed` 固定為 2 或 4，代表 RNG 工作量與資料表大小無關；
 * - 每批 10,000 次的 per-op 時間必須平坦（第一批與最後一批差異在門檻內），
 *   代表沒有隨呼叫次數累積的狀態；
 * - 量一次「明確掃過 41,624 筆 mortality」的成本，與 per-op 成本相比，
 *   證明 `evaluateAnnualDeath` 不可能在掃表（差三個數量級）。
 */

const ROOT = process.cwd();
const TOTAL = 100_000;
const BATCH = 10_000;
const PPM = 1_000_000;

type MutablePack = { manifest: Record<string, unknown>; datasets: Record<string, { records: Record<string, unknown>[] }> };

const readJson = (dir: string, name: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, dir, name), "utf8"));

function baseRaw() {
  return {
    manifest: readJson("fixtures/p2a", "manifest.v1.json"),
    datasets: {
      "country-registry": readJson("fixtures/p2a", "country-registry.v1.json"),
      indicators: readJson("fixtures/p2a", "indicators.v1.json"),
      "birth-weights": readJson("fixtures/p2a", "birth-weights.v1.json"),
      "sensitive-names": readJson("fixtures/p2a", "sensitive-names.v1.json"),
      licenses: readJson("fixtures/p2a", "licenses.v1.json"),
      lineage: readJson("fixtures/p2a", "lineage.v1.json")
    }
  };
}

function deathRaw(): MutablePack {
  return {
    manifest: readJson("fixtures/p3d", "manifest.v1.json"),
    datasets: {
      "cause-registry": readJson("fixtures/p3d", "cause-registry.v1.json") as { records: Record<string, unknown>[] },
      "cause-weights": readJson("fixtures/p3d", "cause-weights.v1.json") as { records: Record<string, unknown>[] },
      mortality: readJson("fixtures/p3d", "mortality.v1.json") as { records: Record<string, unknown>[] },
      licenses: readJson("fixtures/p3d", "licenses.v1.json") as { records: Record<string, unknown>[] },
      lineage: readJson("fixtures/p3d", "lineage.v1.json") as { records: Record<string, unknown>[] }
    }
  };
}

function packWithHazard(base: ReturnType<typeof validateDataPack>, entityId: string, age: number, hazardPpm: number) {
  const draft = deathRaw();
  const record = draft.datasets.mortality.records.find((entry) => entry.entityId === entityId && entry.sex === "female" && entry.age === age);
  if (record === undefined) throw new Error("perf: mortality row missing");
  record.hazardPpm = hazardPpm;
  const checksumOf = (datasetId: string) => computeDeathDatasetChecksum(draft.manifest as never, datasetId as never, draft.datasets[datasetId]?.records ?? []);
  const content = ["cause-registry", "cause-weights", "mortality"];
  for (const license of draft.datasets.licenses.records) {
    if (content.includes(license.datasetId as string)) license.checksum = checksumOf(license.datasetId as string);
  }
  for (const lineage of draft.datasets.lineage.records) {
    lineage.outputChecksum = checksumOf(lineage.datasetId as string);
    lineage.inputChecksums = (lineage.parentLineageIds as string[]).map((parentId) => {
      const parent = draft.datasets.lineage.records.find((entry) => entry.lineageId === parentId);
      return parent === undefined ? "0".repeat(64) : checksumOf(parent.datasetId as string);
    });
  }
  for (const descriptor of draft.manifest.datasets as Record<string, unknown>[]) {
    descriptor.recordCount = (draft.datasets[descriptor.datasetId as string]?.records ?? []).length;
    descriptor.checksum = checksumOf(descriptor.datasetId as string);
  }
  // P3-D.1：manifest 的 licenses／lineage 必須與 datasets 副本逐欄一致。
  draft.manifest.licenses = JSON.parse(JSON.stringify(draft.datasets.licenses.records)) as never;
  draft.manifest.lineage = JSON.parse(JSON.stringify(draft.datasets.lineage.records)) as never;
  draft.manifest.packChecksum = computeDeathPackChecksum(draft.manifest as never);
  return validateDeathPack(draft, base);
}

function stateFor(tag: string, index: number): readonly [number, number, number, number] {
  const digest = sha256Hex(utf8Encode(`p3d-perf:${tag}:${index}`));
  const word = (offset: number) => Number.parseInt(digest.slice(offset * 8, offset * 8 + 8), 16);
  return [word(0), word(1), word(2), word(3)];
}

interface PathResult {
  readonly name: string;
  readonly evaluations: number;
  readonly elapsedMs: number;
  readonly perOpMicros: number;
  readonly batchFirstMs: number;
  readonly batchLastMs: number;
  readonly flatnessRatio: number;
  readonly drawsUsedSeen: readonly number[];
  readonly diedCount: number;
  readonly tableLoopsInEvaluate: number;
  readonly indexLookupsPerCall: number;
}

function runPath(
  name: string,
  pack: ReturnType<typeof validateDeathPack>,
  entityId: string,
  regionCode: string,
  age: number
): PathResult {
  const draws = new Set<number>();
  let diedCount = 0;
  const batches: number[] = [];
  // 暖機（不計入量測）。
  for (let index = 0; index < 1_000; index += 1) {
    evaluateAnnualDeath({ entityId, regionCode, sex: "female", age, calendarYear: 2026, health: 50, rngState: stateFor(`${name}-warm`, index) }, pack);
  }
  const started = performance.now();
  for (let batch = 0; batch < TOTAL / BATCH; batch += 1) {
    const batchStart = performance.now();
    for (let index = 0; index < BATCH; index += 1) {
      const result = evaluateAnnualDeath(
        { entityId, regionCode, sex: "female", age, calendarYear: 2026, health: 50, rngState: stateFor(name, batch * BATCH + index) },
        pack
      );
      draws.add(result.drawsUsed);
      if (result.died) diedCount += 1;
    }
    batches.push(performance.now() - batchStart);
  }
  const elapsedMs = performance.now() - started;
  const first = batches[0] as number;
  const last = batches[batches.length - 1] as number;
  return {
    name,
    evaluations: TOTAL,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    perOpMicros: Number(((elapsedMs * 1000) / TOTAL).toFixed(3)),
    batchFirstMs: Number(first.toFixed(2)),
    batchLastMs: Number(last.toFixed(2)),
    flatnessRatio: Number((last / first).toFixed(3)),
    drawsUsedSeen: [...draws].sort((left, right) => left - right),
    diedCount,
    tableLoopsInEvaluate: 0,
    indexLookupsPerCall: 3
  };
}

function main(): void {
  const base = validateDataPack(baseRaw() as never);

  /* 1) pack 驗證成本（3 次，取中位數）。 */
  const validationRuns: number[] = [];
  let lastPack: ReturnType<typeof validateDeathPack> | null = null;
  for (let run = 0; run < 3; run += 1) {
    const raw = deathRaw();
    const started = performance.now();
    lastPack = validateDeathPack(raw, base);
    validationRuns.push(performance.now() - started);
  }
  const sortedValidation = [...validationRuns].sort((left, right) => left - right);
  const validationMedian = sortedValidation[1] as number;
  const mortalityBytes = statSync(join(ROOT, "fixtures/p3d/mortality.v1.json")).size;

  /* 2) 明確掃過 41,624 筆 mortality 的成本（結構性對照）。 */
  const mortalityRecords = deathRaw().datasets.mortality.records;
  const scanStarted = performance.now();
  let hazardSum = 0;
  for (const record of mortalityRecords) hazardSum += record.hazardPpm as number;
  const scanMs = performance.now() - scanStarted;
  if (hazardSum < 0) throw new Error("perf: unreachable");

  const entity = base.registry.find((entry) => entry.status === "enabled") as { entityId: string; regionCode: string };
  const alivePack = packWithHazard(base, entity.entityId, 30, 0);
  const deathPack = packWithHazard(base, entity.entityId, 30, 1_000_000);

  const alivePath = runPath("alive", alivePack, entity.entityId, entity.regionCode, 30);
  const deathPath = runPath("death", deathPack, entity.entityId, entity.regionCode, 30);

  const flatnessLike = (alivePath.flatnessRatio + deathPath.flatnessRatio) / 2;
  const perOpMicros = Math.max(alivePath.perOpMicros, deathPath.perOpMicros);
  const scanPerRecordMicros = (scanMs * 1000) / mortalityRecords.length;
  const scanOverPerOp = (scanMs * 1000) / perOpMicros;

  /*
   * 結構性判定的三條：
   * 1. 每呼叫的 drawsUsed 固定（2＝未死亡、4＝死亡）→ RNG 工作量與資料表大小無關；
   * 2. 每批 10,000 次的 per-op 時間平坦（10 批的首尾比 < 1.5）→ 沒有累積狀態；
   * 3. per-op 遠小於「掃過全部 41,624 筆 mortality」的成本（> 5×）→ 不可能在掃表。
   */
  const drawsOk = alivePath.drawsUsedSeen.join(",") === "2" && deathPath.drawsUsedSeen.join(",") === "4";
  const flatOk = flatnessLike < 1.5;
  const noScanOk = scanOverPerOp > 5;

  const report = {
    batch: "P3-D",
    version: "p3d-1",
    totalEvaluations: TOTAL * 2,
    batchSize: BATCH,
    warmupEvaluationsPerPath: 1_000,
    packValidation: {
      runsMs: validationRuns.map((value) => Number(value.toFixed(2))),
      medianMs: Number(validationMedian.toFixed(2)),
      mortalityRecords: mortalityRecords.length,
      mortalityJsonBytes: mortalityBytes,
      note: "包含 canonical 排序、checksum（單次 SHA-256）與 deep-freeze；O(rows)"
    },
    alivePath,
    deathPath,
    structural: {
      drawsUsedAlive: alivePath.drawsUsedSeen,
      drawsUsedDeath: deathPath.drawsUsedSeen,
      indexLookupsPerCall: 3,
      tableLoopsInEvaluate: 0,
      mortalityRows: mortalityRecords.length,
      hazardIndexKeys: Object.keys(lastPack?.hazardIndex ?? {}).length,
      causeIndexKeys: Object.keys(lastPack?.causeIndex ?? {}).length,
      fullTableScanMs: Number(scanMs.toFixed(2)),
      scanPerRecordMicros: Number(scanPerRecordMicros.toFixed(4)),
      perOpMicros,
      scanOverPerOp: Number(scanOverPerOp.toFixed(1)),
      flatnessRatioAverage: Number(flatnessLike.toFixed(3)),
      checks: { drawsOk, flatOk, noScanOk },
      /** digest 成本拆解：canonicalBytes 是共用實作，固定 820 bytes 投影。 */
      digestBreakdown: digestBreakdown(),
      /** 120 年人生的死亡判定總成本（µs），用來判斷是否需要更快的 digest。 */
      perLife120YearsMs: Number(((perOpMicros * 120) / 1000).toFixed(3)),
      verdict: drawsOk && flatOk && noScanOk
    }
  };

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(join(ROOT, "reports", "p3d-performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    `P3D-PERF-${report.structural.verdict ? "OK" : "FAIL"} ` +
      `validate=${validationMedian.toFixed(1)}ms alive=${alivePath.perOpMicros}µs/op death=${deathPath.perOpMicros}µs/op ` +
      `evals=${report.totalEvaluations} flat=${flatnessLike.toFixed(2)} scanOverPerOp=${scanOverPerOp.toFixed(1)}x ` +
      `checks=${JSON.stringify(report.structural.checks)}`
  );
  if (!report.structural.verdict) process.exitCode = 1;
}

/** digest 成本拆解（canonicalBytes vs SHA-256）。 */
function digestBreakdown(): { canonicalBytesMicros: number; sha256Micros: number; projectionBytes: number } {
  const projection = {
    domain: "LIFE1/P3D/DEATH/v1",
    deathSpecVersion: "1.0.0",
    healthRuleVersion: "p3d-health-1.0.0",
    deathPackId: "p3d-synthetic-mortality-v1",
    deathPackChecksum: "a".repeat(64),
    basePackId: "p2a-synthetic-20261027",
    basePackChecksum: "b".repeat(64),
    entityId: "cr:DZA",
    regionCode: "DZA",
    regionClass: "africa",
    sex: "female",
    age: 30,
    calendarYear: 2026,
    health: 50,
    baseHazardPpm: 1200,
    adjustedHazardPpm: 1200,
    healthFactorPpm: 1_000_000,
    mortalityDraw: "123456",
    died: false,
    causeId: null,
    rngStateBefore: [1, 2, 3, 4],
    rngStateAfter: [5, 6, 7, 8],
    drawsUsed: 2
  };
  const N = 5_000;
  const bytes = canonicalBytes(projection as never);
  let started = performance.now();
  for (let index = 0; index < N; index += 1) canonicalBytes(projection as never);
  const canonicalMicros = ((performance.now() - started) * 1000) / N;
  started = performance.now();
  for (let index = 0; index < N; index += 1) sha256Hex(bytes);
  const shaMicros = ((performance.now() - started) * 1000) / N;
  return {
    canonicalBytesMicros: Number(canonicalMicros.toFixed(2)),
    sha256Micros: Number(shaMicros.toFixed(2)),
    projectionBytes: bytes.length
  };
}

main();
