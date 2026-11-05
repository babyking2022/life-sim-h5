import {
  P2A_SCHEMA_VERSION,
  type BirthDraft,
  type BirthDrawInput,
  type CountryRegionRecord,
  type Sex,
  type SexPolicy
} from "@life-sim/contracts";
import { ascii, canonicalBytes, concatBytes, createDomainRng, normalizeSeed, sha256Hex } from "@life-sim/engine";
import { fail } from "./errors";
import { birthWeightKey, isValidatedDataPack, type ValidatedDataPack } from "./validate";
import { pickWeightedIndex } from "./weights";

const SEX_POLICIES: readonly SexPolicy[] = ["random", "female", "male"];

/**
 * 決定性出生抽選骨架。
 *
 * 1. 只接受 `validateDataPack` 產生的資料包（WeakSet 品牌），原始 JSON 進不來。
 * 2. 只使用 engine 的 xoshiro128**（domain = "birth"），不碰 Math.random、
 *    Date.now、浮點或網路。
 * 3. 候選國家依 entityId 的 UTF-8 bytes 穩定排序；權重是整數，總和用 BigInt。
 * 4. 抽選順序固定：國家 → 性別 → 出生體重帶 → 帶內克數。
 */
export function drawBirth(pack: ValidatedDataPack, input: BirthDrawInput): BirthDraft {
  if (!isValidatedDataPack(pack)) fail("E_P2A_PACK_NOT_VALIDATED", "pack");
  if (typeof input !== "object" || input === null) fail("E_P2A_TYPE", "input");
  if (typeof input.seed !== "string") fail("E_P2A_SEED", "input.seed");

  const settings = input.settings;
  if (typeof settings !== "object" || settings === null) fail("E_P2A_TYPE", "input.settings");
  if (settings.birthYear !== pack.manifest.indicatorYear) fail("E_P2A_YEAR_UNSUPPORTED", "input.settings.birthYear");
  if (!SEX_POLICIES.includes(settings.sexPolicy)) fail("E_P2A_SEX_POLICY", "input.settings.sexPolicy");

  const seed = normalizeSeedOrFail(input.seed);
  const rng = createDomainRng(seed, "birth");
  let draws = 0;
  const drawBig = (range: bigint): bigint => {
    draws += 1;
    return rng.uniformBigInt(range);
  };

  const candidates = pack.enabledEntityIds;
  const weights = candidates.map((entityId) => pack.birthShare[entityId] as number);
  const countryIndex = pickWeightedIndex(weights, drawBig);
  /* pickWeightedIndex 保證 index 在 [0, length)，因此這裡一定有值。 */
  const entityId = candidates[countryIndex] as string;

  const entity = pack.registry.find((record) => record.entityId === entityId) as CountryRegionRecord;
  const sex: Sex = settings.sexPolicy === "random" ? (drawBig(2n) === 0n ? "female" : "male") : settings.sexPolicy;

  const birthWeight = pack.birthWeightIndex[birthWeightKey(entityId, sex)];
  if (!birthWeight) fail("E_P2A_INDICATOR_MISSING", `pack.datasets.birth-weights.${entityId}.${sex}`);

  const bandWeights = birthWeight.bands.map((band) => band.weightPpm);
  const bandIndex = pickWeightedIndex(bandWeights, drawBig);
  const band = birthWeight.bands[bandIndex];
  if (!band) fail("E_P2A_BAND_RANGE", `pack.datasets.birth-weights.${entityId}.${sex}.bands`);
  const weightGrams = band.minGrams + Number(drawBig(BigInt(band.maxGrams - band.minGrams + 1)));

  const payload = {
    schemaVersion: P2A_SCHEMA_VERSION,
    dataVersion: pack.manifest.dataVersion,
    entityId,
    regionCode: entity.regionCode,
    region: entity.region,
    displayNameZhHans: pack.displayNames[entityId] as string,
    sex,
    birthYear: settings.birthYear,
    weightBandId: band.bandId,
    weightGrams,
    weightBandIndex: bandIndex
  };
  const drawHash = sha256Hex(concatBytes(ascii("LIFE1/BIRTH/v1"), Uint8Array.of(0), canonicalBytes(payload as never)));

  return {
    schemaVersion: P2A_SCHEMA_VERSION,
    dataVersion: pack.manifest.dataVersion,
    entityId,
    regionCode: entity.regionCode,
    region: entity.region,
    displayNameZhHans: payload.displayNameZhHans,
    sex,
    birthYear: settings.birthYear,
    weightBandId: band.bandId,
    weightGrams,
    weightBandIndex: bandIndex,
    rng: { state: rng.state, draws },
    drawHash
  };
}

function normalizeSeedOrFail(seed: string): string {
  try {
    return normalizeSeed(seed);
  } catch {
    return fail("E_P2A_SEED", "input.seed");
  }
}
