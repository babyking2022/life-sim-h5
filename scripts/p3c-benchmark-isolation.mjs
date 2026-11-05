/**
 * P3-C benchmark 隔離驗證（`pnpm p3c:isolation`，也由 `pnpm lint` 執行）。
 *
 * 1. **實際 bundle 公開 engine barrel**，證明 P3-C 的公開入口：
 *    - 拒絕 `p3c-bench-*` ruleset 與未知版本（E_P3C_VERSION）；
 *    - 拒絕 bootstrap 夾帶 lifetime／pack；
 *    - 接受正式 ruleset；
 *    - 沒有匯出任何 benchmark／注入／偽造入口。
 * 2. 用**內部**入口跑 2,000／5,000／10,000 年，證明 benchmark 仍可用、stateHash 仍自洽。
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, ".artifacts", "p3c-isolation");
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
  entryPoints: [join(root, "scripts", "p3c-benchmark-probe.ts")],
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
    console.log(`P3C-ISOLATION-OK ${label}`);
    return;
  }
  failures += 1;
  console.error(`P3C-ISOLATION-FAIL ${label} ${detail}`);
}

function codeOf(action) {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error && typeof error.code === "string" ? error.code : `OTHER:${error && error.name}`;
  }
}

// pack 必須由**公開 bundle 自己的** validateEventPack 產生，否則品牌（WeakSet）不同。
const pack = engine.validateEventPack({
  manifest: JSON.parse(readFileSync(join(root, "fixtures", "p3c", "manifest.v1.json"), "utf8")),
  events: JSON.parse(readFileSync(join(root, "fixtures", "p3c", "events.v1.json"), "utf8")).records
});
const base = probe.benchBootstrap(2000);
const formalBootstrap = { ...base, versions: { ...base.versions, rulesetVersion: "p3c-1.0.0" } };
const withRuleset = (rulesetVersion) => ({ ...formalBootstrap, versions: { ...formalBootstrap.versions, rulesetVersion } });
const withContent = (contentVersion) => ({ ...formalBootstrap, versions: { ...formalBootstrap.versions, contentVersion } });

check("public create accepts the approved P3-C ruleset", engine.createEventLifeState(formalBootstrap, pack).versions.rulesetVersion === "p3c-1.0.0");
check("public create rejects p3c-bench-999", codeOf(() => engine.createEventLifeState(withRuleset("p3c-bench-999"), pack)) === "E_P3C_VERSION");
check("public create rejects unknown ruleset", codeOf(() => engine.createEventLifeState(withRuleset("p3c-9.9.9"), pack)) === "E_P3C_VERSION");
check("public create rejects unknown content", codeOf(() => engine.createEventLifeState(withContent("skeleton-9.9.9"), pack)) === "E_P3C_VERSION");
check(
  "public create rejects a bootstrap carrying lifespanYears",
  codeOf(() => engine.createEventLifeState({ ...formalBootstrap, lifespanYears: 100 }, pack)) === "E_P3C_ARGUMENT"
);
check(
  "public create rejects a bootstrap carrying a raw pack",
  codeOf(() => engine.createEventLifeState({ ...formalBootstrap, eventPack: pack }, pack)) === "E_P3C_ARGUMENT"
);
check("public create rejects a missing pack", codeOf(() => engine.createEventLifeState(formalBootstrap, undefined)) === "E_P3C_PACK");

const benchState = probe.makeBenchState(2000);
check("public verify rejects benchmark state", codeOf(() => engine.verifyEventLifeState(probe.benchBootstrap(2000), benchState, pack)) === "E_P3C_VERSION");
check("public serialize rejects benchmark state", codeOf(() => engine.serializeEventLifeState(benchState)) === "E_P3C_VERSION");
check(
  "public reconstruct rejects benchmark bootstrap",
  codeOf(() => engine.reconstructEventLifeState({ bootstrap: probe.benchBootstrap(2000), targetYears: 0, commandLog: [] }, pack)) ===
    "E_P3C_VERSION"
);
check("internal verify accepts benchmark state", probe.verifyBench(2000, benchState) === true);

const forbidden = [
  "createEventLifeStateForBenchmark",
  "serializeEventLifeStateForBenchmark",
  "reconstructEventLifeStateForBenchmark",
  "verifyEventLifeStateForBenchmark",
  "createEventBenchmarkLifeState",
  "serializeEventBenchmarkLifeState",
  "reconstructEventBenchmarkLifeState",
  "verifyEventBenchmarkLifeState",
  "EVENT_BENCHMARK_RULESET_PREFIX",
  "setAnnualEventFailureInjectionForTests",
  "enableAnnualEventFailureInjection",
  "disableAnnualEventFailureInjection",
  "forgeEventLifeState",
  "guardEventLife"
];
for (const name of forbidden) {
  check(`public barrel does not export ${name}`, engine[name] === undefined);
}

for (const years of [2000, 5000, 10000]) {
  const result = probe.runBenchmark(years);
  check(
    `benchmark ${years} years through the internal entry`,
    result.yearsRecorded === years && result.stateHashValid === true && result.eventsRngDraws >= 0,
    JSON.stringify(result)
  );
}

if (failures > 0) process.exitCode = 1;
else console.log(`P3C-ISOLATION-OK all ${checks} checks passed`);
