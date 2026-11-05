import { describe, expect, it } from "vitest";
import type { SexPolicy } from "@life-sim/contracts";
import { buildBirthIdentity } from "../src/identity/draw";
import { validateIdentityPack } from "../src/identity/validate";
import { validateDataPack } from "../src/validate";
import { asRaw, loadPack } from "./helpers";
import {
  codeOfIdentity,
  identityDataset,
  identityRaw,
  identityRecord,
  loadAlternateBase,
  loadIdentityPack,
  repairIdentity,
  repairIdentityChecksums,
  type MutableIdentityPack
} from "./p2b-helpers";

const base = validateDataPack(asRaw(loadPack()));
const pack = validateIdentityPack(base, identityRaw(loadIdentityPack()) as never);
const identity = (seed: string, sexPolicy: SexPolicy = "random") => buildBirthIdentity(base, pack, { seed, sexPolicy });
function identityContent(value: unknown): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete copy.identityPackChecksum;
  delete copy.identityHash;
  return copy;
}
const validateRaw = (mutable: MutableIdentityPack) => validateIdentityPack(base, identityRaw(mutable) as never);
const codeOfRaw = (mutable: MutableIdentityPack) => codeOfIdentity(() => validateRaw(mutable));

function shuffleInPlace<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  for (let index = items.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swap = state % (index + 1);
    const left = items[index] as T;
    items[index] = items[swap] as T;
    items[swap] = left;
  }
  return items;
}

describe("P2-B.1 base pack binding", () => {
  it("rejects an identity pack that was validated against a different base pack", () => {
    const alternate = loadAlternateBase();
    expect(alternate.packChecksum).not.toBe(base.packChecksum);
    expect(alternate.entityIds).toEqual(base.entityIds);
    let code = "NO_ERROR";
    try {
      buildBirthIdentity(alternate, pack, { seed: "p2b1-swap" });
    } catch (error) {
      expect((error as Error).name).toBe("BirthDataError");
      code = (error as { code: string }).code;
    }
    expect(code).toBe("E_P2B_BASE_PACK_MISMATCH");
  });

  it("records the identity pack id and checksum in the output and the hash payload", () => {
    const result = identity("p2b1-trace");
    expect(result.identityPackId).toBe(pack.manifest.packId);
    expect(result.identityPackChecksum).toBe(pack.packChecksum);
    expect(result.identityPackChecksum).not.toBe(result.basePackChecksum);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("refuses an official identity pack on a synthetic base pack", () => {
    const official = loadIdentityPack();
    official.manifest.packKind = "official";
    for (const license of identityDataset(official, "licenses").records) license.sourceKind = "official";
    repairIdentityChecksums(official);
    expect(codeOfRaw(official)).toBe("E_P2B_PACK_KIND");
  });
});

describe("P2-B.1 nested weight order independence", () => {
  const seeds = Array.from({ length: 100 }, (_, index) => `p2b1-order-${index}`);
  const policies: readonly SexPolicy[] = ["random", "female", "male"];
  const inputs = seeds.flatMap((seed) => policies.map((sexPolicy) => ({ seed, sexPolicy })));
  const baseline = inputs.map((item) => identity(item.seed, item.sexPolicy));

  it("keeps identical results after shuffling occupations, housing and religions in every profile", { timeout: 120000 }, () => {
    for (const round of [0x11, 0x22, 0x33]) {
      const mutable = loadIdentityPack();
      for (let index = 0; index < identityDataset(mutable, "household-profiles").records.length; index += 1) {
        const record = identityRecord(mutable, "household-profiles", index);
        shuffleInPlace(record.occupations as Array<Record<string, unknown>>, round + index);
        shuffleInPlace(record.housing as Array<Record<string, unknown>>, round * 3 + index);
        shuffleInPlace(record.religions as Array<Record<string, unknown>>, round * 7 + index);
      }
      const shuffled = validateIdentityPack(base, identityRaw(repairIdentity(mutable)) as never);
      expect(shuffled.packChecksum).not.toBe(pack.packChecksum);
      for (let index = 0; index < inputs.length; index += 1) {
        const item = inputs[index] as { seed: string; sexPolicy: SexPolicy };
        expect(identityContent(buildBirthIdentity(base, shuffled, item))).toEqual(identityContent(baseline[index] as ReturnType<typeof identity>));
      }
    }
  });

  it("normalises the three distribution lists by id while keeping income quintiles in place", () => {
    const profile = pack.profileByCulture["han_placeholder"];
    expect(profile).toBeUndefined();
    const japanese = pack.profileByCulture["ja"];
    expect(japanese).toBeDefined();
    const occupations = japanese?.occupations.map((entry) => entry.occupationId) ?? [];
    const housing = japanese?.housing.map((entry) => entry.housingId) ?? [];
    const religions = japanese?.religions.map((entry) => entry.religionId) ?? [];
    expect(occupations).toEqual([...occupations].sort());
    expect(housing).toEqual([...housing].sort());
    expect(religions).toEqual([...religions].sort());
    expect(japanese?.incomeQuintilePpm).toHaveLength(5);
  });
});

describe("P2-B.1 prototype-safe culture keys", () => {
  it("rejects cultureId = constructor without a native TypeError", () => {
    const mutable = loadIdentityPack();
    identityRecord(mutable, "country-vitals", 0).cultureId = "constructor";
    repairIdentity(mutable);
    let name = "";
    try {
      validateRaw(mutable);
    } catch (error) {
      name = (error as Error).name;
    }
    expect(name).toBe("BirthDataError");
    expect(codeOfRaw(mutable)).toBe("E_P2B_HOUSEHOLD_PROFILE_MISSING");
  });

  it("rejects cultureId = toString with a fixed pattern error", () => {
    const mutable = loadIdentityPack();
    identityRecord(mutable, "country-vitals", 0).cultureId = "toString";
    repairIdentity(mutable);
    expect(codeOfRaw(mutable)).toBe("E_P2A_PATTERN");
  });

  it("rejects an extra household profile for a culture the vitals never use", () => {
    const mutable = loadIdentityPack();
    const clone = structuredClone(identityRecord(mutable, "household-profiles", 0));
    clone.cultureId = "unused_culture";
    identityDataset(mutable, "household-profiles").records.push(clone);
    repairIdentity(mutable);
    expect(codeOfRaw(mutable)).toBe("E_P2B_UNKNOWN_CULTURE");
  });

  it("rejects name records that point at an unused culture", () => {
    const mutable = loadIdentityPack();
    identityDataset(mutable, "name-corpus").records.push({
      cultureId: "unused_culture",
      kind: "given",
      sex: "female",
      value: "测试",
      dataVersion: "1.0.0"
    });
    repairIdentity(mutable);
    expect(codeOfRaw(mutable)).toBe("E_P2B_UNKNOWN_CULTURE");
  });

  it("rejects story templates that point at an unused culture", () => {
    const mutable = loadIdentityPack();
    identityDataset(mutable, "story-templates").records.push({
      templateId: "unused_story",
      cultureId: "unused_culture",
      paragraphs: ["{name}在{place}出生。"],
      dataVersion: "1.0.0"
    });
    repairIdentity(mutable);
    expect(codeOfRaw(mutable)).toBe("E_P2B_UNKNOWN_CULTURE");
  });
});

describe("P2-B.1 story placeholder whitelist", () => {
  const setFirstParagraph = (text: string): MutableIdentityPack => {
    const mutable = loadIdentityPack();
    (identityRecord(mutable, "story-templates", 0).paragraphs as string[])[0] = text;
    repairIdentity(mutable);
    return mutable;
  };

  it("accepts every whitelisted placeholder", () => {
    const text = "{name}／{place}／{income}／{religion}／{motherJob}／{fatherJob}／{country}";
    expect(codeOfRaw(setFirstParagraph(text))).toBe("NO_ERROR");
    const result = identity("p2b1-placeholder");
    for (const paragraph of result.story.paragraphs) expect(paragraph).not.toContain("{");
  });

  it("rejects unknown and misspelled placeholders", () => {
    expect(codeOfRaw(setFirstParagraph("你好 {bogus}"))).toBe("E_P2B_STORY_PLACEHOLDER");
    expect(codeOfRaw(setFirstParagraph("你好 {nmae}"))).toBe("E_P2B_STORY_PLACEHOLDER");
    expect(codeOfRaw(setFirstParagraph("你好 {Name}"))).toBe("E_P2B_STORY_PLACEHOLDER");
    expect(codeOfRaw(setFirstParagraph("你好 {}"))).toBe("E_P2B_STORY_PLACEHOLDER");
  });

  it("rejects unclosed or malformed braces", () => {
    expect(codeOfRaw(setFirstParagraph("你好 {name"))).toBe("E_P2B_STORY_PLACEHOLDER");
    expect(codeOfRaw(setFirstParagraph("你好 name}"))).toBe("E_P2B_STORY_PLACEHOLDER");
    expect(codeOfRaw(setFirstParagraph("你好 {{name}}"))).toBe("E_P2B_STORY_PLACEHOLDER");
  });
});
