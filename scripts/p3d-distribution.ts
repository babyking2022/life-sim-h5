import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateAnnualDeath } from "../packages/birth/src/death/evaluate";
import { computeDeathDatasetChecksum, computeDeathPackChecksum, validateDeathPack, type ValidatedDeathPack } from "../packages/birth/src/death/pack";
import { validateDataPack } from "../packages/birth/src/validate";
import { sha256Hex } from "../packages/engine/src/rng/sha256";
import { utf8Encode } from "../packages/engine/src/bytes";
import { P3D_CAUSE_IDS } from "../packages/contracts/src/p3d";

/**
 * P3-D 分布證據（決定性大量模擬）。
 *
 * 這不是統計檢定的替代品，而是**回歸證據**：
 * 固定 seed → 固定樣本 → 觀測值必須落在二項分布 5σ 的容許區間內。
 * 任何改動（抽樣演算法、health 公式、clamp、死因權重）都會讓 observed 偏離，
 * 因此可以當作「分布沒有被偷改」的守門證據。
 *
 * 產出：`reports/p3d-distribution-report.json`
 */

const ROOT = process.cwd();
const SEED = "p3d-distribution-20261028";
const SAMPLES = 20_000;
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

/** 由 seed＋索引導出獨立的 rngState（不與被測程式共用任何隨機來源）。 */
function stateAt(tag: string, index: number): readonly [number, number, number, number] {
  const digest = sha256Hex(utf8Encode(`${SEED}:${tag}:${index}`));
  const word = (offset: number) => Number.parseInt(digest.slice(offset * 8, offset * 8 + 8), 16);
  return [word(0), word(1), word(2), word(3)];
}

/** 二項分布 5σ 的死亡人數容許區間。 */
function deathTolerance(p: number, n: number): { low: number; high: number; sigma: number } {
  const sigma = Math.sqrt(n * p * (1 - p));
  return { low: Math.max(0, Math.floor(n * p - 5 * sigma)), high: Math.min(n, Math.ceil(n * p + 5 * sigma)), sigma };
}

/** 改幾個 hazard 後重算所有 checksum，再走正式 `validateDeathPack`。 */
function packWithHazard(base: ReturnType<typeof validateDataPack>, entityId: string, sex: string, age: number, hazardPpm: number): ValidatedDeathPack {
  const draft = deathRaw();
  const record = draft.datasets.mortality.records.find(
    (entry) => entry.entityId === entityId && entry.sex === sex && entry.age === age
  );
  if (record === undefined) throw new Error("distribution: mortality row missing");
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

interface MortalityGroup {
  readonly tag: string;
  readonly entityId: string;
  readonly regionCode: string;
  readonly sex: string;
  readonly age: number;
  readonly health: number;
  readonly baseHazardPpm: number;
  readonly adjustedHazardPpm: number;
  readonly samples: number;
  readonly expectedDeaths: number;
  readonly observedDeaths: number;
  readonly observedRatePpm: number;
  readonly toleranceLow: number;
  readonly toleranceHigh: number;
  readonly sigma: number;
  readonly failures: number;
  readonly causeCounts: Record<string, number>;
}

function main(): void {
  const base = validateDataPack(baseRaw() as never);
  const entity = base.registry.find((entry) => entry.status === "enabled") as { entityId: string; regionCode: string };
  const entityId = entity.entityId;
  const regionCode = entity.regionCode;
  const AGE = 30;

  const groups: MortalityGroup[] = [];
  for (const hazard of [0, 1_000, 10_000, 100_000, 500_000, 1_000_000]) {
    const tuned = packWithHazard(base, entityId, "female", AGE, hazard);
    const causeCounts: Record<string, number> = {};
    for (const causeId of P3D_CAUSE_IDS) causeCounts[causeId] = 0;
    let observedDeaths = 0;
    for (let index = 0; index < SAMPLES; index += 1) {
      const result = evaluateAnnualDeath(
        { entityId, regionCode, sex: "female", age: AGE, calendarYear: 2026, health: 50, rngState: stateAt(`h${hazard}`, index) },
        tuned
      );
      if (result.died) {
        observedDeaths += 1;
        const causeId = result.causeId as string;
        causeCounts[causeId] = (causeCounts[causeId] ?? 0) + 1;
      }
    }
    const p = hazard / PPM;
    const band = deathTolerance(p, SAMPLES);
    const failures = observedDeaths < band.low || observedDeaths > band.high ? 1 : 0;
    groups.push({
      tag: `mortality-hazard-${hazard}`,
      entityId,
      regionCode,
      sex: "female",
      age: AGE,
      health: 50,
      baseHazardPpm: hazard,
      adjustedHazardPpm: hazard,
      samples: SAMPLES,
      expectedDeaths: Number((SAMPLES * p).toFixed(2)),
      observedDeaths,
      observedRatePpm: Math.round((observedDeaths / SAMPLES) * PPM),
      toleranceLow: band.low,
      toleranceHigh: band.high,
      sigma: Number(band.sigma.toFixed(2)),
      failures,
      causeCounts
    });
    console.log(`  hazard=${String(hazard).padStart(7)}ppm observed=${String(observedDeaths).padStart(5)} band=[${band.low},${band.high}] failures=${failures}`);
  }

  /* 死因分布：三組 region×sex×age，hazard 1e6（必定死亡）。 */
  const causeGroups: MortalityGroup[] = [];
  const wanted = [
    { regionClass: "asia", sex: "female" as const, age: 0 },
    { regionClass: "europe", sex: "male" as const, age: 40 },
    { regionClass: "africa", sex: "female" as const, age: 95 }
  ];
  for (const want of wanted) {
    const target = base.registry.find((entry) => entry.region === want.regionClass && entry.status === "enabled") as
      | { entityId: string; regionCode: string }
      | undefined;
    if (target === undefined) throw new Error(`distribution: no entity in ${want.regionClass}`);
    const tuned = packWithHazard(base, target.entityId, want.sex, want.age, 1_000_000);
    const selection = tuned.causeIndex[`${want.regionClass}|${want.sex}|${want.age}`];
    if (selection === undefined) throw new Error("distribution: cause selection missing");
    const total = Number(selection.totalWeight);

    const causeCounts: Record<string, number> = {};
    for (const causeId of P3D_CAUSE_IDS) causeCounts[causeId] = 0;
    let observedDeaths = 0;
    for (let index = 0; index < SAMPLES; index += 1) {
      const result = evaluateAnnualDeath(
        {
          entityId: target.entityId,
          regionCode: target.regionCode,
          sex: want.sex,
          age: want.age,
          calendarYear: 2026,
          health: 50,
          rngState: stateAt(`cause-${want.regionClass}-${want.sex}-${want.age}`, index)
        },
        tuned
      );
      if (!result.died) throw new Error("distribution: hazard 1e6 must always die");
      observedDeaths += 1;
      const causeId = result.causeId as string;
      causeCounts[causeId] = (causeCounts[causeId] ?? 0) + 1;
    }

    let failures = 0;
    let worstSigma = 0;
    for (const entry of selection.causes) {
      const share = entry.weight / total;
      const band = deathTolerance(share, SAMPLES);
      const observed = causeCounts[entry.causeId] as number;
      const expected = SAMPLES * share;
      const deviation = band.sigma === 0 ? 0 : Math.abs(observed - expected) / band.sigma;
      if (deviation > worstSigma) worstSigma = deviation;
      if (observed < band.low || observed > band.high) failures += 1;
    }

    causeGroups.push({
      tag: `cause-distribution-${want.regionClass}-${want.sex}-${want.age}`,
      entityId: target.entityId,
      regionCode: target.regionCode,
      sex: want.sex,
      age: want.age,
      health: 50,
      baseHazardPpm: 1_000_000,
      adjustedHazardPpm: 1_000_000,
      samples: SAMPLES,
      expectedDeaths: SAMPLES,
      observedDeaths,
      observedRatePpm: PPM,
      toleranceLow: SAMPLES,
      toleranceHigh: SAMPLES,
      sigma: Number(worstSigma.toFixed(2)),
      failures,
      causeCounts
    });
    console.log(`  cause ${want.regionClass}/${want.sex}/${want.age} worst=${worstSigma.toFixed(2)}σ failures=${failures}`);
  }

  const allGroups = [...groups, ...causeGroups];
  const totalFailures = allGroups.reduce((sum, group) => sum + group.failures, 0);
  const simulationHash = sha256Hex(
    utf8Encode(
      JSON.stringify({
        seed: SEED,
        samples: SAMPLES,
        groups: allGroups.map((group) => ({ tag: group.tag, observedDeaths: group.observedDeaths, causeCounts: group.causeCounts }))
      })
    )
  );

  const report = {
    batch: "P3-D",
    version: "p3d-1",
    seed: SEED,
    samplesPerGroup: SAMPLES,
    toleranceRule: "binomial 5 sigma (two-sided) on integer death counts",
    basePackChecksum: base.packChecksum,
    deathPackChecksum: packWithHazard(base, entityId, "female", AGE, 50_000).packChecksum,
    mortalityGroups: groups,
    causeGroups,
    totalFailures,
    simulationHash
  };
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(join(ROOT, "reports", "p3d-distribution-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    `P3D-DISTRIBUTION-${totalFailures === 0 ? "OK" : "FAIL"} groups=${allGroups.length} samples=${SAMPLES} failures=${totalFailures} simulationHash=${simulationHash.slice(0, 12)}…`
  );
  if (totalFailures !== 0) process.exitCode = 1;
}

main();
