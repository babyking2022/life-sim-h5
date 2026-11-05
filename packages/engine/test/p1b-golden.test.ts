import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGoldenCase, type GoldenCase } from "../src";

interface GoldenFixtureCase extends GoldenCase {
  expectedHash: string;
  expectedCommandHashes: string[];
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "packages", "engine", "test", "fixtures", "p1b-golden.json"), "utf8")
) as { generator: string; count: number; cases: GoldenFixtureCase[] };

describe("P1-B golden fixtures", () => {
  it("contains exactly 100 frozen cases with unique ids", () => {
    expect(fixture.generator).toBe("p1b-golden-v3");
    expect(fixture.count).toBe(100);
    expect(fixture.cases).toHaveLength(100);
    expect(new Set(fixture.cases.map((item) => item.id)).size).toBe(100);
  });

  it("recomputes all 100 hashes and command hashes", () => {
    for (const item of fixture.cases) {
      const result = runGoldenCase(item);
      expect(result.stateHash, item.id).toBe(item.expectedHash);
      expect(result.commandHashes, item.id).toEqual(item.expectedCommandHashes);
    }
  });
});
