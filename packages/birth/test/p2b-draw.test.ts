import { describe, expect, it } from "vitest";
import type { BirthDraft, BirthIdentity, DatasetEnvelope } from "@life-sim/contracts";
import { drawBirth } from "../src/draw";
import { buildBirthIdentity } from "../src/identity/draw";
import { validateIdentityPack } from "../src/identity/validate";
import { validateDataPack } from "../src/validate";
import { runIdentityCases } from "../src/p2b-browser";
import { asRaw, loadPack } from "./helpers";
import { codeOfIdentity, identityRaw, loadIdentityPack, repairIdentity, type MutableIdentityPack } from "./p2b-helpers";
import p2aGolden from "../../../fixtures/p2a/golden-birth-vectors.v1.json";

const base = validateDataPack(asRaw(loadPack()));
const pack = validateIdentityPack(base, identityRaw(loadIdentityPack()) as never);
const identity = (seed: string, sexPolicy: "random" | "female" | "male" = "random") => buildBirthIdentity(base, pack, { seed, sexPolicy });

function shuffle<T>(input: readonly T[], seed: number): T[] {
  const copy = [...input];
  let state = seed >>> 0;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swap = state % (index + 1);
    const left = copy[index] as T;
    copy[index] = copy[swap] as T;
    copy[swap] = left;
  }
  return copy;
}

function shuffledIdentityPack(): MutableIdentityPack {
  const mutable = loadIdentityPack();
  for (const envelope of Object.values(mutable.datasets) as DatasetEnvelope<unknown>[]) {
    (envelope as unknown as { records: unknown[] }).records = shuffle(envelope.records, 0x2b2b);
  }
  mutable.manifest.datasets = shuffle(mutable.manifest.datasets, 0x4b4b);
  return repairIdentity(mutable);
}

function identityContent(value: BirthIdentity): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete copy.identityPackChecksum;
  delete copy.identityHash;
  return copy;
}

describe("P2-B birth identity", () => {
  it("builds a complete, serializable identity", () => {
    const result = identity("p2b-seed-01");
    expect(result.schemaVersion).toBe("p2b-1");
    expect(result.basePackChecksum).toBe(base.packChecksum);
    expect(result.name.fullName.length).toBeGreaterThan(1);
    expect(result.place.entityId).toBe(result.birth.entityId);
    expect(result.household.incomeQuintile).toBeGreaterThanOrEqual(1);
    expect(result.household.incomeQuintile).toBeLessThanOrEqual(5);
    expect(result.parents.motherAge).toBeGreaterThanOrEqual(14);
    expect(result.religion.religionId.length).toBeGreaterThan(0);
    expect(result.vitals.lifeExpectancyYearsX10).toBeGreaterThanOrEqual(300);
    expect(result.certificate.fullNumber).toMatch(/^LS-[0-9A-HJKMNP-TV-Z]{16}-[0-9A-HJKMNP-TV-Z]$/);
    expect(result.story.paragraphs.length).toBeGreaterThan(0);
    expect(result.identityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("is identical across 100 runs of the same seed", () => {
    const first = identity("LS-TP-001");
    for (let run = 0; run < 100; run += 1) expect(identity("LS-TP-001")).toEqual(first);
  });

  it("keeps the P2-A birth draft exactly as drawBirth produces it", () => {
    const result = identity("p2b-seed-02", "female");
    const draft = drawBirth(base, { seed: "p2b-seed-02", settings: { birthYear: base.manifest.indicatorYear, sexPolicy: "female" } });
    expect(result.birth).toEqual(draft);
  });

  it("does not change the P2-A golden draft", () => {
    const goldenCase = p2aGolden.cases.find((entry) => entry.seed === "LS-TP-001" && entry.sexPolicy === "random");
    expect(goldenCase).toBeDefined();
    const result = identity("LS-TP-001", "random");
    expect(result.birth).toEqual(goldenCase?.draft as unknown as BirthDraft);
  });

  it("uses exactly two names draws and eight family draws", () => {
    const result = identity("p2b-seed-03");
    expect(result.rng.names.draws).toBe(2);
    expect(result.rng.family.draws).toBe(8);
    expect(result.rng.names.state).not.toEqual([0, 0, 0, 0]);
    expect(result.rng.family.state).not.toEqual([0, 0, 0, 0]);
  });

  it("derives a deterministic certificate without real personal data", () => {
    const first = identity("p2b-seed-04");
    const second = identity("p2b-seed-04");
    expect(first.certificate.fullNumber).toBe(second.certificate.fullNumber);
    const serials = new Set<string>();
    for (let index = 0; index < 24; index += 1) serials.add(identity(`p2b-cert-${index}`).certificate.fullNumber);
    expect(serials.size).toBeGreaterThan(20);
  });

  it("fills the story template with the identity fields", () => {
    for (const seed of ["p2b-seed-05", "p2b-seed-06", "p2b-seed-07"]) {
      const result = identity(seed);
      for (const paragraph of result.story.paragraphs) {
        expect(paragraph).not.toContain("{");
        expect(paragraph).not.toContain("}");
        expect(paragraph.length).toBeGreaterThan(0);
      }
      expect(result.story.paragraphs.join("")).toContain(result.name.fullName);
    }
  });

  it("honours the sex policy with the matching name pool", () => {
    const female = identity("p2b-seed-08", "female");
    const male = identity("p2b-seed-08", "male");
    expect(female.birth.sex).toBe("female");
    expect(male.birth.sex).toBe("male");
    expect(pack.namePoolsByCulture[female.name.cultureId]?.female).toContain(female.name.givenName);
    expect(pack.namePoolsByCulture[male.name.cultureId]?.male).toContain(male.name.givenName);
  });

  it("is invariant to record order in every identity dataset", () => {
    const shuffled = validateIdentityPack(base, identityRaw(shuffledIdentityPack()) as never);
    expect(shuffled.packChecksum).not.toBe(pack.packChecksum);
    for (const seed of ["LS-TP-001", "p2b-seed-09", "p2b-seed-10"]) {
      expect(identityContent(buildBirthIdentity(base, shuffled, { seed }))).toEqual(identityContent(identity(seed)));
    }
  });

  it("is not affected by later mutation of the raw identity pack", () => {
    const mutable = loadIdentityPack();
    const validated = validateIdentityPack(base, identityRaw(mutable) as never);
    const before = buildBirthIdentity(base, validated, { seed: "p2b-seed-11" });
    (mutable.datasets["name-corpus"]?.records[0] as Record<string, unknown>).value = "被改掉的名字";
    (mutable.manifest as unknown as { entityCount: number }).entityCount = 172;
    expect(buildBirthIdentity(base, validated, { seed: "p2b-seed-11" })).toEqual(before);
    expect(validated.names[0]).not.toBe(mutable.datasets["name-corpus"]?.records[0]);
  });

  it("rejects invalid inputs and unvalidated packs", () => {
    expect(codeOfIdentity(() => buildBirthIdentity(base, pack, null as never))).toBe("E_P2A_TYPE");
    expect(codeOfIdentity(() => buildBirthIdentity(base, pack, { seed: 42 as never }))).toBe("E_P2A_SEED");
    expect(codeOfIdentity(() => buildBirthIdentity(base, pack, { seed: "" }))).toBe("E_P2A_SEED");
    expect(codeOfIdentity(() => buildBirthIdentity(base, pack, { seed: "x", sexPolicy: "other" as never }))).toBe("E_P2A_SEX_POLICY");
    expect(codeOfIdentity(() => buildBirthIdentity(base, loadIdentityPack() as never, { seed: "x" }))).toBe("E_P2B_PACK_NOT_VALIDATED");
    expect(codeOfIdentity(() => buildBirthIdentity(loadPack() as never, pack, { seed: "x" }))).toBe("E_P2A_PACK_NOT_VALIDATED");
  });

  it("exposes the browser entry", () => {
    const [draft] = runIdentityCases(asRaw(loadPack()), identityRaw(loadIdentityPack()), [{ seed: "p2b-seed-12", sexPolicy: "random" }]);
    expect(draft).toEqual(identity("p2b-seed-12", "random"));
  });
});
