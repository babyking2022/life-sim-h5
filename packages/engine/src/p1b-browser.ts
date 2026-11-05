import { runGoldenCase } from "./p1b/golden";
import type { GoldenCase, GoldenResult } from "./p1b/types";

export function runGolden(cases: readonly GoldenCase[]): GoldenResult[] {
  return cases.map(runGoldenCase);
}
