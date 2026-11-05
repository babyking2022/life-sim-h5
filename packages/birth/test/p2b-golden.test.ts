import { describe, expect, it } from "vitest";
import { buildBirthIdentity } from "../src/identity/draw";
import { validateIdentityPack } from "../src/identity/validate";
import { validateDataPack } from "../src/validate";
import { asRaw, loadPack } from "./helpers";
import { identityRaw, loadIdentityPack } from "./p2b-helpers";
import golden from "../../../fixtures/p2b/golden-identity-vectors.v1.json";

const base = validateDataPack(asRaw(loadPack()));
const pack = validateIdentityPack(base, identityRaw(loadIdentityPack()) as never);

describe("P2-B golden vectors", () => {
  it("has at least 100 committed cases bound to the current packs", () => {
    expect(golden.caseCount).toBe(golden.cases.length);
    expect(golden.cases.length).toBeGreaterThanOrEqual(100);
    expect(golden.packChecksum).toBe(pack.packChecksum);
    expect(golden.basePackChecksum).toBe(base.packChecksum);
  });

  it("reproduces every committed identity exactly", () => {
    for (const entry of golden.cases) {
      const identity = buildBirthIdentity(base, pack, { seed: entry.seed, sexPolicy: entry.sexPolicy as "random" | "female" | "male" });
      expect(identity).toEqual(entry.identity);
    }
  });
});
