import { describe, expect, it } from "vitest";
import { validateIdentityPack } from "../src/identity/validate";
import { validateDataPack } from "../src/validate";
import { asRaw, loadPack } from "./helpers";
import { identityRaw, loadIdentityPack } from "./p2b-helpers";

const base = validateDataPack(asRaw(loadPack()));
const pack = validateIdentityPack(base, identityRaw(loadIdentityPack()) as never);

function mutationOutcome(action: () => void): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof TypeError ? "TypeError" : "OTHER_ERROR";
  }
}

describe("P2-B validated identity pack is a deep, immutable snapshot", () => {
  it("freezes every dataset, record, nested array and derived map", () => {
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.manifest)).toBe(true);
    expect(Object.isFrozen(pack.manifest.datasets)).toBe(true);
    expect(Object.isFrozen(pack.manifest.datasets[0])).toBe(true);
    expect(Object.isFrozen(pack.vitals)).toBe(true);
    expect(Object.isFrozen(pack.vitals[0])).toBe(true);
    expect(Object.isFrozen(pack.profiles[0])).toBe(true);
    expect(Object.isFrozen(pack.profiles[0]?.occupations)).toBe(true);
    expect(Object.isFrozen(pack.profiles[0]?.occupations[0])).toBe(true);
    expect(Object.isFrozen(pack.names[0])).toBe(true);
    expect(Object.isFrozen(pack.stories[0]?.paragraphs)).toBe(true);
    expect(Object.isFrozen(pack.vitalsByEntity)).toBe(true);
    expect(Object.isFrozen(pack.profileByCulture)).toBe(true);
    expect(Object.isFrozen(pack.namePoolsByCulture)).toBe(true);
    expect(Object.isFrozen(pack.namePoolsByCulture["han"]?.surname)).toBe(true);
    expect(Object.isFrozen(pack.storiesByCulture)).toBe(true);
    expect(Object.isFrozen(pack.datasetChecksums)).toBe(true);
  });

  it("throws on every attempted mutation of the validated pack", () => {
    expect(mutationOutcome(() => { (pack.vitals[0] as unknown as { lifeExpectancyYearsX10: number }).lifeExpectancyYearsX10 = 1; })).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.names[0] as unknown as { value: string }).value = "HACK"; })).toBe("TypeError");
    expect(
      mutationOutcome(() => {
        const occupation = pack.profiles[0]?.occupations[0] as unknown as { weightPpm: number };
        occupation.weightPpm = 1;
      })
    ).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.manifest as unknown as { packId: string }).packId = "HACK"; })).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.namePoolsByCulture["han"]?.surname as unknown as string[]).push("HACK"); })).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.datasetChecksums as unknown as Record<string, string>)["name-corpus"] = "0"; })).toBe("TypeError");
    expect(mutationOutcome(() => { (pack.vitals as unknown as unknown[]).pop(); })).toBe("TypeError");
  });

  it("keeps the validated pack independent of the raw input", () => {
    expect(pack.vitals[0]).not.toBe(loadIdentityPack().datasets["country-vitals"]?.records[0]);
    expect(pack.manifest).not.toBe(loadIdentityPack().manifest);
  });
});
