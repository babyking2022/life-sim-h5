/**
 * P3-A.4 benchmark 隔離驗證（architecture 檢查的一部分）。
 *
 * 1. **實際 bundle 公開 engine barrel**，證明：
 *    - `p3a-bench-*` ruleset 被拒（E_P3A_VERSION）；
 *    - 未知 ruleset／content 被拒（E_P3A_VERSION）；
 *    - 正式 ruleset 正常建立；
 *    - barrel 沒有匯出任何 benchmark／注入／重簽入口。
 * 2. 用**內部**入口跑 2,000／5,000／10,000 年真 ledger，證明 benchmark 仍可用。
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, ".artifacts", "p3a-isolation");
mkdirSync(outDir, { recursive: true });

const engineBundle = join(outDir, "public-engine.mjs");
const probeBundle = join(outDir, "benchmark-probe.mjs");

await build({
  entryPoints: [join(root, "packages", "engine", "src", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: engineBundle,
  logLevel: "silent"
});
await build({
  entryPoints: [join(root, "scripts", "p3a-benchmark-probe.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: probeBundle,
  logLevel: "silent"
});

const engine = await import(pathToFileURL(engineBundle).href);
const probe = await import(pathToFileURL(probeBundle).href);

let failures = 0;
let checks = 0;
function check(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`P3A-ISOLATION-OK ${label}`);
    return;
  }
  failures += 1;
  console.error(`P3A-ISOLATION-FAIL ${label} ${detail}`);
}

function codeOf(action) {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error && typeof error.code === "string" ? error.code : `OTHER:${error && error.name}`;
  }
}

const base = probe.baseBootstrap("p3a4-isolation-public");
const withRuleset = (rulesetVersion) => ({ ...base, versions: { ...base.versions, rulesetVersion } });
const withContent = (contentVersion) => ({ ...base, versions: { ...base.versions, contentVersion } });

check("public create rejects p3a-bench-999", codeOf(() => engine.createLifeState(withRuleset("p3a-bench-999"))) === "E_P3A_VERSION");
check("public create rejects unknown ruleset", codeOf(() => engine.createLifeState(withRuleset("p3a-9.9.9"))) === "E_P3A_VERSION");
check("public create rejects unknown content", codeOf(() => engine.createLifeState(withContent("skeleton-9.9.9"))) === "E_P3A_VERSION");
// 正式 bootstrap 不得接受任意壽命；bench ruleset 的畸形數字也必須被拒。
check(
  "public create rejects a bootstrap carrying lifespanYears",
  codeOf(() => engine.createLifeState({ ...base, lifespanYears: 100 })) === "E_P3A_ARGUMENT"
);
check(
  "public create rejects a malformed benchmark suffix",
  codeOf(() => engine.createLifeState(withRuleset("p3a-bench-abc"))) === "E_P3A_VERSION" &&
    codeOf(() => engine.createLifeState(withRuleset("p3a-bench-0"))) === "E_P3A_VERSION" &&
    codeOf(() => engine.createLifeState(withRuleset("p3a-bench-100001"))) === "E_P3A_VERSION"
);

const formal = engine.createLifeState(base);
check(
  "public create accepts the approved ruleset",
  formal.versions.rulesetVersion === "p3a-1.0.1" && formal.lifespanYears >= 60 && formal.lifespanYears <= 100,
  `lifespan=${formal.lifespanYears}`
);

// benchmark state 由內部入口建立，公開入口必須全部拒絕。
const benchState = probe.makeBenchState(2000);
check("public verify rejects benchmark state", codeOf(() => engine.verifyLifeState(probe.benchBootstrap(2000), benchState)) === "E_P3A_VERSION");
check("public serialize rejects benchmark state", codeOf(() => engine.serializeLifeState(benchState)) === "E_P3A_VERSION");
check(
  "public reconstruct rejects benchmark bootstrap",
  codeOf(() => engine.reconstructLifeState({ bootstrap: probe.benchBootstrap(2000), targetYears: 0, commandLog: [] })) === "E_P3A_VERSION"
);
check(
  "internal verify accepts benchmark state",
  probe.verifyBench(2000, benchState) === true,
  "internal verify failed"
);

const forbidden = [
  "createBenchmarkLifeState",
  "createLifeStateForBenchmark",
  "serializeLifeStateForBenchmark",
  "verifyLifeReplayForBenchmark",
  "BENCHMARK_RULESET_PREFIX",
  "setYearFailureInjectionForTests",
  "resignLifeStateForTests"
];
for (const name of forbidden) {
  check(`public barrel does not export ${name}`, engine[name] === undefined);
}

for (const years of [2000, 5000, 10000]) {
  const result = probe.runBenchmark(years);
  check(
    `benchmark ${years} years through the internal entry`,
    result.yearsRecorded === years &&
      result.ledgerEntries === years &&
      result.ledgerTailDeltaHash === result.stateDeltaHash &&
      result.stateHashValid === true,
    JSON.stringify(result)
  );
}

if (failures > 0) process.exitCode = 1;
else console.log(`P3A-ISOLATION-OK all ${checks} checks passed`);
