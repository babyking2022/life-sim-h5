import {
  P3D_HEALTH_RULE_VERSION,
  P3D_MAX_AGE,
  P3D_MAX_HAZARD_PPM,
  P3D_MIN_AGE,
  P3D_DEATH_SPEC_VERSION,
  P3D_SEXES,
  type P3DAnnualDeathInput,
  type P3DAnnualDeathResult,
  type P3DSex
} from "@life-sim/contracts";
import { canonicalBytes, sha256Hex, Xoshiro128StarStar } from "@life-sim/engine";
import { guardDeath, fail } from "./errors";
import { assertEntityRegionBinding, causeSelectionOf, hazardPpmOf, isValidatedDeathPack, type ValidatedDeathPack } from "./pack";
import { deepFreeze, readEnum, readExactObject, readInt, readString } from "./schema";

/**
 * 決定性的年度死亡判定（P3-D 唯一公開判定入口）。
 *
 * 純函式：只用既有 Xoshiro／BigInt／canonical／SHA-256。
 * 沒有 `Math.random`、`Date.now`、浮點概率、DOM、React、storage、network、timer。
 *
 * 流程（固定順序）：
 * 1. 驗證 pack 品牌與 input（exact-object、0..120 歲、0..100 health、合法 rngState）；
 * 2. 查死亡率 `baseHazardPpm`；
 * 3. 套用**版本化**的健康修正（整數運算）→ `adjustedHazardPpm`（clamp 0..1,000,000）；
 * 4. 一次無偏差 u64 → `mortalityDraw ∈ [0, 1,000,000)`；
 * 5. `died = mortalityDraw < adjustedHazardPpm`；
 * 6. **只有死亡才**依該 regionClass×sex×age 的權重抽死因；
 * 7. 回傳 digest（綁 pack checksum、全部權威輸入、抽樣結果、RNG before／after、drawsUsed）。
 */

/** 健康修正公式（版本化）。health 0–100；50 為中性。 */
const HEALTH_NEUTRAL = 50;
const HEALTH_FACTOR_PER_POINT_PPM = 20_000;
const HEALTH_FACTOR_MIN_PPM = 100_000;
const HEALTH_FACTOR_MAX_PPM = 2_000_000;
const PPM = 1_000_000;
export const P3D_DIGEST_DOMAIN = "LIFE1/P3D/DEATH/v1";

const isWord = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;

/**
 * 健康修正（整數運算，回傳 ppm 係數）。
 * `factor = 1,000,000 + (50 − health) × 20,000`，clamp 到 100,000..2,000,000。
 * 最大值 2,000,000、base 最大 1,000,000 → 乘積最大 2×10^12 < 2^53，整數運算精確。
 */
export function healthFactorPpm(health: number): number {
  if (!Number.isSafeInteger(health) || health < 0 || health > 100) fail("E_P3D_STATE", "input.health");
  const raw = PPM + (HEALTH_NEUTRAL - health) * HEALTH_FACTOR_PER_POINT_PPM;
  if (raw < HEALTH_FACTOR_MIN_PPM) return HEALTH_FACTOR_MIN_PPM;
  if (raw > HEALTH_FACTOR_MAX_PPM) return HEALTH_FACTOR_MAX_PPM;
  return raw;
}

/** `base × factor / 1,000,000`（四捨五入、整數運算），再 clamp 到 0..1,000,000。 */
export function adjustHazardPpm(baseHazardPpm: number, health: number): { adjustedHazardPpm: number; healthFactorPpm: number } {
  const factor = healthFactorPpm(health);
  const numerator = baseHazardPpm * factor;
  // 四捨五入（分母固定 1,000,000）。
  const rounded = Math.floor((numerator + PPM / 2) / PPM);
  const clamped = rounded < 0 ? 0 : rounded > P3D_MAX_HAZARD_PPM ? P3D_MAX_HAZARD_PPM : rounded;
  return { adjustedHazardPpm: clamped, healthFactorPpm: factor };
}

/** 可計數的 Xoshiro 包裝：只為了精確回報 `drawsUsed`（每次 u64 = 2 次 u32）。 */
class CountingRng {
  private readonly rng: Xoshiro128StarStar;
  private draws = 0;

  constructor(state: unknown) {
    this.rng = new Xoshiro128StarStar(state);
  }

  get state(): readonly [number, number, number, number] {
    return this.rng.state;
  }

  get drawsUsed(): number {
    return this.draws;
  }

  /** 與 `Xoshiro128StarStar.nextU64` 完全相同，只是計數。 */
  nextU64(): bigint {
    const high = BigInt(this.rng.nextU32());
    this.draws += 1;
    const low = BigInt(this.rng.nextU32());
    this.draws += 1;
    return (high << 32n) | low;
  }
}

/**
 * 無偏差整數抽樣（與 engine 的 `uniformBigIntFrom` 同一個演算法，
 * 但用可計數的 u64 來源，因此 `drawsUsed` 精確等於實際推進次數）。
 */
function uniformBigIntCounted(rng: CountingRng, n: bigint): bigint {
  if (typeof n !== "bigint" || n < 1n || n > (1n << 64n) - 1n) fail("E_P3D_WEIGHT", "bound");
  if (n === 1n) return 0n;
  const limit = ((1n << 64n) / n) * n;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const value = rng.nextU64();
    if (value < limit) return value % n;
  }
  return fail("E_P3D_RNG", "rejection");
}

function readInput(value: unknown): {
  entityId: string;
  regionCode: string;
  sex: P3DSex;
  age: number;
  calendarYear: number;
  health: number;
  rngState: readonly [number, number, number, number];
} {
  const node = readExactObject(value, "input", ["entityId", "regionCode", "sex", "age", "calendarYear", "health", "rngState"]);
  const rngArray = node.rngState;
  if (!Array.isArray(rngArray) || rngArray.length !== 4) fail("E_P3D_RNG", "input.rngState");
  const words: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const word = rngArray[index];
    if (!isWord(word)) fail("E_P3D_RNG", `input.rngState[${index}]`);
    words.push(word);
  }
  return {
    entityId: readString(node.entityId, "input.entityId", { min: 1, max: 64 }),
    regionCode: readString(node.regionCode, "input.regionCode", { min: 1, max: 64 }),
    sex: readEnum(node.sex, "input.sex", P3D_SEXES),
    age: readInt(node.age, "input.age", P3D_MIN_AGE, P3D_MAX_AGE),
    calendarYear: readInt(node.calendarYear, "input.calendarYear", 1800, 2200),
    health: readInt(node.health, "input.health", 0, 100),
    rngState: [words[0] as number, words[1] as number, words[2] as number, words[3] as number]
  };
}

function computeDigest(result: Omit<P3DAnnualDeathResult, "digest">): string {
  const projection = {
    domain: P3D_DIGEST_DOMAIN,
    deathSpecVersion: P3D_DEATH_SPEC_VERSION,
    healthRuleVersion: P3D_HEALTH_RULE_VERSION,
    deathPackId: result.deathPackId,
    deathPackChecksum: result.deathPackChecksum,
    basePackId: result.basePackId,
    basePackChecksum: result.basePackChecksum,
    entityId: result.entityId,
    regionCode: result.regionCode,
    regionClass: result.regionClass,
    sex: result.sex,
    age: result.age,
    calendarYear: result.calendarYear,
    health: result.health,
    baseHazardPpm: result.baseHazardPpm,
    adjustedHazardPpm: result.adjustedHazardPpm,
    healthFactorPpm: result.healthFactorPpm,
    mortalityDraw: result.mortalityDraw,
    died: result.died,
    causeId: result.causeId,
    rngStateBefore: [...result.rngStateBefore],
    rngStateAfter: [...result.rngStateAfter],
    drawsUsed: result.drawsUsed
  };
  return sha256Hex(canonicalBytes(projection as never));
}

export function evaluateAnnualDeath(rawInput: unknown, rawPack: unknown): P3DAnnualDeathResult {
  return guardDeath(() => {
    if (!isValidatedDeathPack(rawPack)) fail("E_P3D_PACK", "pack");
    const pack: ValidatedDeathPack = rawPack;
    const input: P3DAnnualDeathInput = readInput(rawInput);

    /*
     * P3-D.1：`regionCode` 不是獨立的權威輸入。
     * 1. entityId 必須存在於 validated base pack 的綁定索引；
     * 2. 輸入的 regionCode 必須是**該 entity** 的 regionCode（跨 region 或同 region
     *    不同 entity 一律拒絕）；
     * 3. regionClass 只能來自綁定，不能只相信呼叫端。
     * 以上都在建立 RNG 與任何抽樣**之前**完成，因此錯配不會消耗 RNG。
     */
    const binding = assertEntityRegionBinding(pack, input.entityId, input.regionCode);
    const regionClass = binding.regionClass;
    const baseHazardPpm = hazardPpmOf(pack, input.entityId, input.sex, input.age);
    const { adjustedHazardPpm, healthFactorPpm: factor } = adjustHazardPpm(baseHazardPpm, input.health);

    // 輸入的 rngState 先複製成獨立 tuple：呼叫端事後改陣列不影響結果。
    const rngStateBefore = Object.freeze([...input.rngState]) as readonly [number, number, number, number];
    const rng = new CountingRng(rngStateBefore);

    // 4) 一次無偏差 u64 → mortalityDraw ∈ [0, 1,000,000)
    const draw = uniformBigIntCounted(rng, BigInt(PPM));
    const mortalityDraw = draw.toString();
    // 5) died
    const died = draw < BigInt(adjustedHazardPpm);

    // 6) 只有死亡才抽死因
    let causeId: string | null = null;
    if (died) {
      const selection = causeSelectionOf(pack, regionClass, input.sex, input.age);
      if (selection.causes.length === 0) fail("E_P3D_CAUSE", "cause-weights");
      const pick = uniformBigIntCounted(rng, selection.totalWeight);
      let cumulative = 0n;
      let chosen: string | null = null;
      for (const entry of selection.causes) {
        cumulative += BigInt(entry.weight);
        if (pick < cumulative) {
          chosen = entry.causeId;
          break;
        }
      }
      if (chosen === null) fail("E_P3D_CAUSE", "cause-weights");
      causeId = chosen;
    }

    const rngStateAfter = Object.freeze([...rng.state]) as readonly [number, number, number, number];
    const partial = {
      entityId: input.entityId,
      regionCode: input.regionCode,
      regionClass,
      sex: input.sex,
      age: input.age,
      calendarYear: input.calendarYear,
      health: input.health,
      baseHazardPpm,
      adjustedHazardPpm,
      healthFactorPpm: factor,
      died,
      causeId,
      mortalityDraw,
      rngStateBefore,
      rngStateAfter,
      drawsUsed: rng.drawsUsed,
      deathSpecVersion: P3D_DEATH_SPEC_VERSION,
      healthRuleVersion: P3D_HEALTH_RULE_VERSION,
      deathPackId: pack.manifest.deathPackId,
      deathPackChecksum: pack.packChecksum,
      basePackId: pack.manifest.basePackId,
      basePackChecksum: pack.manifest.basePackChecksum
    } satisfies Omit<P3DAnnualDeathResult, "digest">;

    return deepFreeze({ ...partial, digest: computeDigest(partial) });
  });
}
