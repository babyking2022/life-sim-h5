import { describe, expect, it } from "vitest";
import { drawBirth } from "../src/draw";
import { validateDataPack } from "../src/validate";
import { asRaw, loadPack } from "./helpers";
import golden from "../../../fixtures/p2a/golden-birth-vectors.v1.json";

describe("P2-A golden vectors", () => {
  it("has at least 48 committed cases", () => {
    expect(golden.caseCount).toBe(golden.cases.length);
    expect(golden.cases.length).toBeGreaterThanOrEqual(48);
    expect(golden.packChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reproduces every committed draft exactly", () => {
    const pack = validateDataPack(asRaw(loadPack()));
    expect(pack.packChecksum).toBe(golden.packChecksum);
    for (const entry of golden.cases) {
      const draft = drawBirth(pack, {
        seed: entry.seed,
        settings: { birthYear: entry.birthYear, sexPolicy: entry.sexPolicy as "random" | "female" | "male" }
      });
      expect(draft).toEqual(entry.draft);
    }
  });
});
