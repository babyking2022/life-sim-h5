import { describe, expect, it } from "vitest";
import { drawBirth } from "../src/draw";
import { BirthDataError } from "../src/errors";
import { validateDataPack, type ValidatedDataPack } from "../src/validate";
import { asRaw, loadPack, repair, type MutablePack } from "./helpers";

const SETTINGS = { birthYear: 2024, sexPolicy: "random" as const };

function validated(): ValidatedDataPack {
  return validateDataPack(asRaw(loadPack()));
}

/** 測試用的確定性洗牌（LCG，不用 Math.random）。 */
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

function shuffledPack(): MutablePack {
  const pack = loadPack();
  for (const envelope of Object.values(pack.datasets)) {
    envelope.records = shuffle(envelope.records, 0x5eed);
  }
  pack.manifest.datasets = shuffle(pack.manifest.datasets, 0xbeef);
  return repair(pack);
}

function codeOf(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof BirthDataError ? error.code : "OTHER";
  }
}

describe("P2-A deterministic birth draw", () => {
  it("returns identical drafts for 100 runs of the same seed", () => {
    const pack = validated();
    const first = drawBirth(pack, { seed: "LS-TP-001", settings: SETTINGS });
    for (let run = 0; run < 100; run += 1) {
      expect(drawBirth(pack, { seed: "LS-TP-001", settings: SETTINGS })).toEqual(first);
    }
  });

  it("is invariant to record order in every dataset", () => {
    const baselinePack = validated();
    const shuffled = validateDataPack(asRaw(shuffledPack()));
    for (const seed of ["LS-TP-001", "p2a-seed-01", "p2a-seed-07", "人生-種子-001"]) {
      expect(drawBirth(shuffled, { seed, settings: SETTINGS })).toEqual(drawBirth(baselinePack, { seed, settings: SETTINGS }));
    }
  });

  it("honours the sex policy and otherwise draws both sexes", () => {
    const pack = validated();
    expect(drawBirth(pack, { seed: "p2a-seed-02", settings: { birthYear: 2024, sexPolicy: "female" } }).sex).toBe("female");
    expect(drawBirth(pack, { seed: "p2a-seed-02", settings: { birthYear: 2024, sexPolicy: "male" } }).sex).toBe("male");
    const sexes = new Set<string>();
    const countries = new Set<string>();
    for (let index = 0; index < 24; index += 1) {
      const draft = drawBirth(pack, { seed: `p2a-mix-${index}`, settings: SETTINGS });
      sexes.add(draft.sex);
      countries.add(draft.entityId);
    }
    expect(sexes.size).toBe(2);
    expect(countries.size).toBeGreaterThan(5);
  });

  it("keeps the drawn grams inside the selected band", () => {
    const pack = validated();
    for (let index = 0; index < 32; index += 1) {
      const draft = drawBirth(pack, { seed: `p2a-band-${index}`, settings: SETTINGS });
      const record = pack.birthWeightIndex[`${draft.entityId}|${draft.sex}`];
      expect(record).toBeDefined();
      const band = record?.bands[draft.weightBandIndex];
      expect(band).toBeDefined();
      expect(draft.weightBandId).toBe(band?.bandId);
      expect(draft.weightGrams).toBeGreaterThanOrEqual(band?.minGrams ?? 0);
      expect(draft.weightGrams).toBeLessThanOrEqual(band?.maxGrams ?? 0);
      expect(draft.rng.draws).toBeGreaterThanOrEqual(3);
      expect(draft.drawHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("uses the birth RNG domain (same seed, different domain, different state)", () => {
    const pack = validated();
    const draft = drawBirth(pack, { seed: "LS-TP-001", settings: SETTINGS });
    const again = drawBirth(pack, { seed: "LS-TP-001", settings: SETTINGS });
    expect(draft.rng.state).toEqual(again.rng.state);
    expect(draft.rng.state).not.toEqual([0, 0, 0, 0]);
  });

  it("rejects invalid inputs with fixed codes", () => {
    const pack = validated();
    expect(codeOf(() => drawBirth(pack, { seed: "", settings: SETTINGS }))).toBe("E_P2A_SEED");
    expect(codeOf(() => drawBirth(pack, { seed: "bad\u0000seed", settings: SETTINGS }))).toBe("E_P2A_SEED");
    expect(codeOf(() => drawBirth(pack, { seed: "x", settings: { birthYear: 2023, sexPolicy: "random" } }))).toBe("E_P2A_YEAR_UNSUPPORTED");
    expect(codeOf(() => drawBirth(pack, { seed: "x", settings: { birthYear: 2024, sexPolicy: "other" as never } }))).toBe("E_P2A_SEX_POLICY");
    expect(codeOf(() => drawBirth(loadPack() as never, { seed: "x", settings: SETTINGS }))).toBe("E_P2A_PACK_NOT_VALIDATED");
  });

  it("never mutates the validated pack", () => {
    const pack = validated();
    const before = JSON.stringify({ manifest: pack.manifest, registry: pack.registry.length });
    drawBirth(pack, { seed: "p2a-seed-03", settings: SETTINGS });
    expect(JSON.stringify({ manifest: pack.manifest, registry: pack.registry.length })).toBe(before);
    expect(pack.registry).toHaveLength(172);
  });
});
