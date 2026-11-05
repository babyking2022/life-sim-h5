import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanSource } from "./architecture-rules.mjs";

const dir = "scripts/architecture-fixtures";

/**
 * Every violation fixture and the exact rule it must produce.
 * Exact matching (not substring) so a fixture cannot pass by tripping an
 * unrelated rule.
 */
const cases = [
  // pre-existing rules
  ["math-random.txt", "Math.random"],
  ["date-now.txt", "Date.now"],
  ["dom-window.txt", "global:window"],
  ["storage.txt", "global:localStorage"],
  ["react-static.txt", "module:react"],
  ["react-dynamic.txt", "dynamic-module:react-dom"],
  ["save-import.txt", "module:@life-sim/save"],

  // E-05A: module-level ban on crypto / node:crypto across every mechanism
  ["crypto-static-import.txt", "module:crypto"],
  ["crypto-reexport.txt", "module:node:crypto"],
  ["crypto-import-type.txt", "module:crypto"],
  ["crypto-dynamic-import.txt", "dynamic-module:node:crypto"],
  ["crypto-require.txt", "require:crypto"],
  ["crypto-subpath.txt", "module:crypto/webcrypto"],
  ["node-crypto-subpath.txt", "module:node:crypto/webcrypto"],

  // E-05A: named aliases must not slip through
  ["node-crypto-named-alias.txt", "module:node:crypto"],
  ["crypto-module-alias.txt", "module:crypto"],

  // E-05A/B: nondeterministic crypto properties, split per rule
  ["crypto-get-random-values.txt", "crypto.getRandomValues"],
  ["crypto-random-uuid.txt", "crypto.randomUUID"],
  ["crypto-random-bytes.txt", "crypto.randomBytes"],

  // E-05B: statically determinable element access
  ["computed-math-random.txt", "computed(Math.random)"],
  ["computed-date-now.txt", "computed(Date.now)"],
  ["computed-performance-now.txt", "computed(performance.now)"],
  ["computed-crypto-get-random-values.txt", "computed(crypto.getRandomValues)"],
  ["computed-global-crypto-random-uuid.txt", "computed(crypto.randomUUID)"],
  ["computed-global-crypto-get-random-values.txt", "computed(crypto.getRandomValues)"],
  ["computed-global-window.txt", "computed(global:window)"],
  ["computed-global-localstorage.txt", "computed(global:localStorage)"],

  // E-05C: destructured aliases
  ["destructured-math-random.txt", "destructured(Math.random)"],
  ["destructured-date-now.txt", "destructured(Date.now)"],
  ["destructured-crypto-random.txt", "destructured(crypto.getRandomValues)"]
];

/** Negative control: ordinary pure functions must not be flagged. */
const cleanFixture = "clean-pure-functions.txt";

let failed = false;

for (const [file, rule] of cases) {
  const path = join(dir, file);
  if (!existsSync(path)) {
    console.log(`ARCH-SELFTEST-FAIL ${file} -> missing fixture (expected ${rule})`);
    failed = true;
    continue;
  }
  const violations = scanSource(readFileSync(path, "utf8"), file);
  const ok = violations.some((violation) => violation.rule === rule);
  const detail = ok ? "" : ` (got: ${violations.map((violation) => violation.rule).join(", ") || "no violation"})`;
  console.log(`${ok ? "ARCH-SELFTEST-OK" : "ARCH-SELFTEST-FAIL"} ${file} -> ${rule}${detail}`);
  if (!ok) failed = true;
}

const cleanPath = join(dir, cleanFixture);
if (!existsSync(cleanPath)) {
  console.log(`ARCH-SELFTEST-FAIL ${cleanFixture} -> missing fixture`);
  failed = true;
} else {
  const cleanViolations = scanSource(readFileSync(cleanPath, "utf8"), cleanFixture);
  const ok = cleanViolations.length === 0;
  const detail = ok ? "" : ` (got: ${cleanViolations.map((violation) => violation.rule).join(", ")})`;
  console.log(`${ok ? "ARCH-SELFTEST-OK" : "ARCH-SELFTEST-FAIL"} ${cleanFixture} -> no violations${detail}`);
  if (!ok) failed = true;
}

const present = readdirSync(dir)
  .filter((name) => name.endsWith(".txt"))
  .sort();
const expected = [...cases.map(([file]) => file), cleanFixture].sort();
const missing = expected.filter((name) => !present.includes(name));
const unexpected = present.filter((name) => !expected.includes(name));

if (missing.length > 0 || unexpected.length > 0) {
  failed = true;
  if (missing.length > 0) console.log(`ARCH-SELFTEST-FAIL missing fixtures: ${missing.join(", ")}`);
  if (unexpected.length > 0) console.log(`ARCH-SELFTEST-FAIL unlisted fixtures: ${unexpected.join(", ")}`);
}

console.log(
  `ARCH-SELFTEST ${cases.length} violation fixtures + 1 clean fixture (${present.length} files present)`
);
if (failed) process.exitCode = 1;
