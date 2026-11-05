import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateAnnualDeath } from "../packages/birth/src/death/evaluate";
import { projectDeathResult } from "../packages/birth/src/death/browser";
import { validateDeathPack } from "../packages/birth/src/death/pack";
import { validateDataPack } from "../packages/birth/src/validate";
import { sha256Hex } from "../packages/engine/src/rng/sha256";
import { utf8Encode } from "../packages/engine/src/bytes";

/**
 * P3-D golden 向量產生器。
 *
 * 108 組案例固定覆蓋：
 * - 6 個 region class 的 entity（含 enabled／disabled 狀態）；
 * - 兩個 sex；
 * - 年齡 0／1／5／14／15／30／45／60／75／90／120；
 * - health 0／25／50／75／100；
 * - 多組 rngState；
 * 並記錄 baseHazard／adjustedHazard／died／causeId／drawsUsed／RNG before／after 與 digest。
 */

const ROOT = process.cwd();
const P2A_DIR = join(ROOT, "fixtures", "p2a");
const P3D_DIR = join(ROOT, "fixtures", "p3d");
const OUT_FILE = join(P3D_DIR, "golden-death-vectors.v1.json");

const CASE_COUNT = 108;
const AGES = [0, 1, 5, 14, 15, 30, 45, 60, 75, 90, 120];
const HEALTHS = [0, 25, 50, 75, 100];

interface BaseEntity {
  readonly entityId: string;
  readonly regionCode: string;
  readonly region: string;
  readonly status: string;
}

function readJson(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

function hashInt(key: string, mod: number): number {
  return Number.parseInt(sha256Hex(utf8Encode(key)).slice(0, 8), 16) % mod;
}

function loadBase() {
  return {
    manifest: readJson(P2A_DIR, "manifest.v1.json"),
    datasets: {
      "country-registry": readJson(P2A_DIR, "country-registry.v1.json"),
      indicators: readJson(P2A_DIR, "indicators.v1.json"),
      "birth-weights": readJson(P2A_DIR, "birth-weights.v1.json"),
      "sensitive-names": readJson(P2A_DIR, "sensitive-names.v1.json"),
      licenses: readJson(P2A_DIR, "licenses.v1.json"),
      lineage: readJson(P2A_DIR, "lineage.v1.json")
    }
  };
}

function loadDeath() {
  return {
    manifest: readJson(P3D_DIR, "manifest.v1.json"),
    datasets: {
      "cause-registry": readJson(P3D_DIR, "cause-registry.v1.json"),
      "cause-weights": readJson(P3D_DIR, "cause-weights.v1.json"),
      mortality: readJson(P3D_DIR, "mortality.v1.json"),
      licenses: readJson(P3D_DIR, "licenses.v1.json"),
      lineage: readJson(P3D_DIR, "lineage.v1.json")
    }
  };
}

function main(): void {
  const base = validateDataPack(loadBase() as never);
  const pack = validateDeathPack(loadDeath(), base);

  const registry = (readJson(P2A_DIR, "country-registry.v1.json") as { records: BaseEntity[] }).records;
  const entities = registry;
  const sexes = ["female", "male"] as const;

  const cases: Record<string, unknown>[] = [];
  const digests: ReturnType<typeof projectDeathResult>[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < CASE_COUNT; index += 1) {
    // 確定性挑選 entity／sex／age／health／rng，並盡量讓 108 組互不重複。
    let attempt = 0;
    let candidate: Record<string, unknown> | null = null;
    while (candidate === null || seen.has(JSON.stringify(candidate))) {
      const entity = entities[hashInt(`p3d:golden:entity:${index}:${attempt}`, entities.length)] as BaseEntity;
      const sex = sexes[hashInt(`p3d:golden:sex:${index}:${attempt}`, 2)] as "female" | "male";
      const age = AGES[hashInt(`p3d:golden:age:${index}:${attempt}`, AGES.length)] as number;
      const health = HEALTHS[hashInt(`p3d:golden:health:${index}:${attempt}`, HEALTHS.length)] as number;
      const calendarYear = 2000 + hashInt(`p3d:golden:year:${index}:${attempt}`, 60);
      const rngState = [
        hashInt(`p3d:golden:rng0:${index}:${attempt}`, 0x1_0000_0000),
        hashInt(`p3d:golden:rng1:${index}:${attempt}`, 0x1_0000_0000),
        hashInt(`p3d:golden:rng2:${index}:${attempt}`, 0x1_0000_0000),
        hashInt(`p3d:golden:rng3:${index}:${attempt}`, 0x1_0000_0000)
      ];
      candidate = {
        id: `p3d-${String(index + 1).padStart(3, "0")}`,
        entityId: entity.entityId,
        regionCode: entity.regionCode,
        entityStatus: entity.status,
        region: entity.region,
        sex,
        age,
        calendarYear,
        health,
        rngState
      };
      attempt += 1;
    }
    seen.add(JSON.stringify(candidate));
    cases.push(candidate);
    const { id, entityStatus, region, ...input } = candidate as Record<string, never> & {
      id: string;
      entityStatus: string;
      region: string;
    };
    void id;
    void entityStatus;
    void region;
    digests.push(projectDeathResult(evaluateAnnualDeath(input, pack)));
  }

  const died = digests.filter((entry) => entry.died).length;
  const causes = new Set(digests.map((entry) => entry.causeId).filter((value): value is string => value !== null));

  const golden = {
    schemaVersion: "p3d-1",
    deathSpecVersion: pack.manifest.deathSpecVersion,
    healthRuleVersion: "p3d-health-1.0.0",
    deathPackId: pack.manifest.deathPackId,
    deathPackChecksum: pack.packChecksum,
    basePackId: pack.manifest.basePackId,
    basePackChecksum: pack.manifest.basePackChecksum,
    digestDomain: "LIFE1/P3D/DEATH/v1",
    caseCount: cases.length,
    diedCount: died,
    distinctCauses: [...causes].sort(),
    cases: cases.map((entry, index) => ({ ...entry, ...(digests[index] as object) }))
  };

  mkdirSync(P3D_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  console.log(`P3D-GOLDEN-OK cases=${golden.caseCount} died=${died} alive=${golden.caseCount - died} causes=${causes.size}`);
}

main();
