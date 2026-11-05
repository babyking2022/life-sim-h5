import {
  P2B_HOUSING_LABELS,
  P2B_INCOME_LABELS,
  P2B_SCHEMA_VERSION,
  P2B_SETTLEMENT_LABELS,
  P2B_WEIGHT_PPM_TOTAL,
  type BirthCertificate,
  type BirthHousehold,
  type BirthIdentity,
  type BirthName,
  type BirthParents,
  type BirthPlace,
  type BirthReligion,
  type BirthStory,
  type BirthVitals,
  type HousingShare,
  type IncomeQuintile,
  type OccupationShare,
  type ReligionShare,
  type SexPolicy
} from "@life-sim/contracts";
import { ascii, canonicalBytes, concatBytes, createDomainRng, normalizeSeed, seedDigest, seedHash, sha256Hex, utf8Encode } from "@life-sim/engine";
import { drawBirth } from "../draw";
import { fail } from "../errors";
import { isValidatedDataPack, type ValidatedDataPack } from "../validate";
import { pickWeightedIndex } from "../weights";
import { isValidatedIdentityPack, type ValidatedIdentityPack } from "./validate";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SEX_POLICIES: readonly SexPolicy[] = ["random", "female", "male"];

export interface BirthIdentityInput {
  readonly seed: string;
  readonly sexPolicy?: SexPolicy;
}

function normalizeSeedOrFail(seed: string): string {
  try {
    return normalizeSeed(seed);
  } catch {
    return fail("E_P2A_SEED", "input.seed");
  }
}

function base32Crockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 31] as string;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31] as string;
  return out;
}

function u32Of(...parts: readonly Uint8Array[]): number {
  const digest = sha256Hex(concatBytes(...parts));
  return parseInt(digest.slice(0, 8), 16) >>> 0;
}

/**
 * 出生證書編號：只由 seed、entityId、P2-A draft hash 與姓名推導，
 * 不消耗 RNG、不含時間、裝置或真實個資。
 */
function deriveCertificate(seed: string, entityId: string, drawHash: string, surname: string, givenName: string): BirthCertificate {
  const digest = sha256Hex(
    concatBytes(
      ascii("LIFE1/BIRTHCERT/v1"),
      Uint8Array.of(0),
      seedDigest(seed),
      Uint8Array.of(0),
      utf8Encode(entityId),
      Uint8Array.of(0),
      utf8Encode(drawHash),
      Uint8Array.of(0),
      utf8Encode(surname),
      Uint8Array.of(0),
      utf8Encode(givenName)
    )
  );
  const bytes = new Uint8Array(11);
  for (let index = 0; index < 11; index += 1) bytes[index] = parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  const serial = base32Crockford(bytes.subarray(0, 10));
  const checkChar = CROCKFORD[(bytes[10] as number) & 31] as string;
  return { prefix: "LS", serial, checkChar, fullNumber: `LS-${serial}-${checkChar}` };
}

function substitute(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (match, key: string) => values[key] ?? match);
}

export function buildBirthIdentity(base: ValidatedDataPack, pack: ValidatedIdentityPack, input: BirthIdentityInput): BirthIdentity {
  if (!isValidatedDataPack(base)) fail("E_P2A_PACK_NOT_VALIDATED", "basePack");
  if (!isValidatedIdentityPack(pack)) fail("E_P2B_PACK_NOT_VALIDATED", "identityPack");
  if (
    pack.manifest.basePackId !== base.manifest.packId ||
    pack.manifest.basePackChecksum !== base.packChecksum ||
    pack.manifest.baseDataVersion !== base.manifest.dataVersion
  ) {
    fail("E_P2B_BASE_PACK_MISMATCH", "basePack");
  }
  if (pack.manifest.packKind === "official" && base.manifest.packKind !== "official") fail("E_P2B_PACK_KIND", "basePack");
  if (typeof input !== "object" || input === null) fail("E_P2A_TYPE", "input");
  if (typeof input.seed !== "string") fail("E_P2A_SEED", "input.seed");
  const seed = normalizeSeedOrFail(input.seed);
  const sexPolicy: SexPolicy = input.sexPolicy ?? "random";
  if (!SEX_POLICIES.includes(sexPolicy)) fail("E_P2A_SEX_POLICY", "input.sexPolicy");

  /* P2-A 的出生抽選完全不變：同 seed 的國家與地區、性別、體重結果必須與 P2-A 一致。 */
  const birth = drawBirth(base, { seed, settings: { birthYear: base.manifest.indicatorYear, sexPolicy } });

  const vital = pack.vitalsByEntity[birth.entityId];
  if (!vital) fail("E_P2A_UNKNOWN_ENTITY", `pack.vitals.${birth.entityId}`);
  const profile = pack.profileByCulture[vital.cultureId];
  if (!profile) fail("E_P2B_HOUSEHOLD_PROFILE_MISSING", `pack.profiles.${vital.cultureId}`);
  const pools = pack.namePoolsByCulture[vital.cultureId];
  if (!pools) fail("E_P2B_NAME_POOL_MISSING", `pack.names.${vital.cultureId}`);

  /* --- 姓名模組：domain "names"，只抽姓氏與名字兩次 ------------------- */
  const namesRng = createDomainRng(seed, "names");
  let nameDraws = 0;
  const drawNameIndex = (length: number): number => {
    nameDraws += 1;
    return Number(namesRng.uniformBigInt(BigInt(length)));
  };
  if (pools.surname.length === 0) fail("E_P2B_NAME_POOL_MISSING", `pack.names.${vital.cultureId}.surname`);
  const givenPool = birth.sex === "female" ? pools.female : pools.male;
  if (givenPool.length === 0) fail("E_P2B_NAME_POOL_MISSING", `pack.names.${vital.cultureId}.${birth.sex}`);
  const surname = pools.surname[drawNameIndex(pools.surname.length)] as string;
  const givenName = givenPool[drawNameIndex(givenPool.length)] as string;
  const name: BirthName = {
    cultureId: vital.cultureId,
    script: profile.script,
    surname,
    givenName,
    fullName: profile.surnameOrder === "family_first" ? `${surname}${givenName}` : `${givenName} ${surname}`
  };

  /* --- 家庭模組：domain "family"，抽樣順序固定 ----------------------- */
  const familyRng = createDomainRng(seed, "family");
  let familyDraws = 0;
  const drawWeighted = (weights: readonly number[]): number => {
    familyDraws += 1;
    return pickWeightedIndex(weights, (total) => familyRng.uniformBigInt(total));
  };
  const drawRange = (min: number, max: number): number => {
    familyDraws += 1;
    return min + Number(familyRng.uniformBigInt(BigInt(max - min + 1)));
  };
  const settlement = drawWeighted([profile.urbanSharePpm, P2B_WEIGHT_PPM_TOTAL - profile.urbanSharePpm]) === 0 ? "urban" : "rural";
  const incomeQuintile = (drawWeighted(profile.incomeQuintilePpm) + 1) as IncomeQuintile;
  const motherAge = drawRange(profile.motherAgeMin, profile.motherAgeMax);
  const fatherAge = drawRange(profile.fatherAgeMin, profile.fatherAgeMax);
  const motherOccupation = profile.occupations[drawWeighted(profile.occupations.map((entry) => entry.weightPpm))] as OccupationShare;
  const fatherOccupation = profile.occupations[drawWeighted(profile.occupations.map((entry) => entry.weightPpm))] as OccupationShare;
  const housing = profile.housing[drawWeighted(profile.housing.map((entry) => entry.weightPpm))] as HousingShare;
  const religion = profile.religions[drawWeighted(profile.religions.map((entry) => entry.weightPpm))] as ReligionShare;

  const place: BirthPlace = {
    settlement,
    urban: settlement === "urban",
    entityId: birth.entityId,
    regionCode: birth.regionCode,
    region: birth.region
  };
  const household: BirthHousehold = {
    incomeQuintile,
    incomeLabel: P2B_INCOME_LABELS[incomeQuintile],
    housing: housing.housingId,
    housingLabel: P2B_HOUSING_LABELS[housing.housingId]
  };
  const parents: BirthParents = {
    motherAge,
    fatherAge,
    motherOccupationId: motherOccupation.occupationId,
    motherOccupationLabel: motherOccupation.label,
    fatherOccupationId: fatherOccupation.occupationId,
    fatherOccupationLabel: fatherOccupation.label
  };
  const religionOut: BirthReligion = { religionId: religion.religionId, label: religion.label, none: religion.religionId === "none" };
  const vitals: BirthVitals = {
    lifeExpectancyYearsX10: vital.lifeExpectancyYearsX10,
    under5MortalityPer1000X10: vital.under5MortalityPer1000X10,
    gdpPerCapitaPppUsd: vital.gdpPerCapitaPppUsd
  };

  /* --- 證書與故事：hash 推導，不消耗 RNG ----------------------------- */
  const certificate = deriveCertificate(seed, birth.entityId, birth.drawHash, surname, givenName);
  const templates = pack.storiesByCulture[vital.cultureId];
  if (!templates || templates.length === 0) fail("E_P2B_STORY_TEMPLATE_MISSING", `pack.stories.${vital.cultureId}`);
  const storyIndex = u32Of(ascii("LIFE1/BIRTHSTORY/v1"), Uint8Array.of(0), seedDigest(seed), utf8Encode(birth.entityId), utf8Encode(birth.drawHash)) % templates.length;
  const template = templates[storyIndex] as (typeof templates)[number];
  const story: BirthStory = {
    templateId: template.templateId,
    paragraphs: template.paragraphs.map((paragraph) => {
      const filled = substitute(paragraph, {
        name: name.fullName,
        place: `${P2B_SETTLEMENT_LABELS[settlement]}（${birth.region}）`,
        income: household.incomeLabel,
        religion: religionOut.label,
        motherJob: motherOccupation.label,
        fatherJob: fatherOccupation.label,
        country: base.displayNames[birth.entityId] as string
      });
      if (filled.includes("{") || filled.includes("}")) fail("E_P2B_STORY_PLACEHOLDER", "story");
      return filled;
    })
  };

  const identityPayload = {
    schemaVersion: P2B_SCHEMA_VERSION,
    dataVersion: pack.manifest.dataVersion,
    basePackId: pack.manifest.basePackId,
    basePackChecksum: pack.manifest.basePackChecksum,
    baseDataVersion: pack.manifest.baseDataVersion,
    identityPackId: pack.manifest.packId,
    identityPackChecksum: pack.manifest.packChecksum,
    seedHash: seedHash(seed),
    birth,
    name,
    place,
    household,
    parents,
    religion: religionOut,
    vitals,
    certificate,
    story
  };
  const identityHash = sha256Hex(concatBytes(ascii("LIFE1/BIRTHID/v1"), Uint8Array.of(0), canonicalBytes(identityPayload as never)));

  return {
    ...identityPayload,
    rng: {
      names: { state: namesRng.state, draws: nameDraws },
      family: { state: familyRng.state, draws: familyDraws }
    },
    identityHash
  };
}
