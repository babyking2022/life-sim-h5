/**
 * P3-E 架構隔離檢查的**候選**自我測試（WorkBuddy Agent B，H5-CTO-053-B）。
 *
 * ```bash
 * node scripts/p3e-architecture-isolation-self-test.mjs
 * ```
 *
 * 證明四件事：
 * 1. 每一類 `dep:*` 與 `purity:*` 違規都會被攔截（含別名／解構／computed 繞過，
 *    以及 static import／re-export／dynamic import／require／`import()` 型別四種機制）。
 * 1b. `dep:unresolved-dynamic-module`（H5-CTO-055-B-R1）：可變別名、同名區域遮蔽、
 *    參數規格、`require.resolve`、其他套件的動態規格、模板替換、非字面值串接、
 *    成員與條件運算式一律硬失敗；直接字面值與字面值串接仍能正確判定目標套件。
 * 2. 合法程式（三個公開 barrel、純函式 simulation、註解與字串中的關鍵字）不會誤判。
 * 3. 測試程式本身不污染受追蹤檔案：暫存專案只寫在
 *    `.artifacts/p3e-architecture-self-test/**`，結束前刪除。
 *
 * 任何一項失敗 → `process.exitCode = 1`。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeProject,
  analyzeSource,
  collectProductionFiles,
  detectCycles,
  RULE_IDS
} from "./p3e-architecture-isolation.mjs";

const SIM = "packages/simulation/src/probe.ts";
const ENGINE = "packages/engine/src/probe.ts";
const BIRTH = "packages/birth/src/probe.ts";
const APPLICATION = "packages/application/src/probe.ts";

let failures = 0;
let checks = 0;

function ok(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`P3E-SELFTEST-OK ${label}`);
    return;
  }
  failures += 1;
  console.error(`P3E-SELFTEST-FAIL ${label} ${detail}`);
}

/* ------------------------------------------------------------------ */
/* 1. 依賴方向：違規一定被攔截                                          */
/* ------------------------------------------------------------------ */

const violationCases = [
  /* --- engine 不得依賴 birth / simulation（四種機制） --------------- */
  ["dep:engine-imports-birth", ENGINE, 'import { a } from "@life-sim/birth";\nexport const v = a;\n'],
  ["dep:engine-imports-birth", ENGINE, 'export { a } from "@life-sim/birth";\n'],
  // H5-CTO-055-B-R1：`import(CONST_ALIAS)` 一律視為無法可靠確定（不信任非 scope-aware 的 alias 表）。
  ["dep:unresolved-dynamic-module", ENGINE, 'const m = "@life-sim/birth";\nexport const v = await import(m);\n'],
  ["dep:engine-imports-birth", ENGINE, 'import b = require("@life-sim/birth");\nexport const v = b;\n'],
  ["dep:engine-imports-birth", ENGINE, 'export type X = typeof import("@life-sim/birth").A;\n'],
  ["dep:unresolved-dynamic-module", ENGINE, 'const m = "@life-sim/" + "birth";\nexport const v = await import(m);\n'],
  ["dep:engine-imports-simulation", ENGINE, 'import { a } from "@life-sim/simulation";\nexport const v = a;\n'],
  ["dep:engine-imports-simulation", ENGINE, 'const s = require("@life-sim/simulation");\nexport const v = s;\n'],
  ["dep:engine-imports-simulation", ENGINE, 'export * from "@life-sim/simulation";\n'],

  /* --- birth 不得依賴 simulation ----------------------------------- */
  ["dep:birth-imports-simulation", BIRTH, 'import { a } from "@life-sim/simulation";\nexport const v = a;\n'],
  ["dep:birth-imports-simulation", BIRTH, 'export { a } from "@life-sim/simulation";\n'],
  ["dep:birth-imports-simulation", BIRTH, 'export const v = await import("@life-sim/simulation");\n'],
  ["dep:birth-imports-simulation", BIRTH, 'const s = require("@life-sim/simulation");\nexport const v = s;\n'],

  /* --- 私人路徑（明確列出的三個套件 src） --------------------------- */
  ["dep:private-path:contracts-src", SIM, 'import { a } from "@life-sim/contracts/src/p3e";\nexport const v = a;\n'],
  ["dep:private-path:engine-src", SIM, 'import { a } from "@life-sim/engine/src/rng/xoshiro128";\nexport const v = a;\n'],
  ["dep:private-path:engine-src", SIM, 'export const v = await import("@life-sim/engine/src/index");\n'],
  ["dep:private-path:birth-src", SIM, 'export { a } from "@life-sim/birth/src/index";\n'],
  ["dep:private-path:simulation-src", BIRTH, 'import { a } from "@life-sim/simulation/src/rng";\nexport const v = a;\n'],
  ["dep:private-path", SIM, 'import { a } from "@life-sim/save/src/codec";\nexport const v = a;\n'],

  /* --- simulation 只能用三個公開 barrel ---------------------------- */
  ["dep:simulation-external-import", SIM, 'import { a } from "@life-sim/save";\nexport const v = a;\n'],
  ["dep:simulation-external-import", SIM, 'import { a } from "@life-sim/application";\nexport const v = a;\n'],
  ["dep:simulation-external-import", SIM, 'import { useState } from "react";\nexport const v = useState;\n'],
  ["dep:simulation-external-import", SIM, 'import { readFileSync } from "node:fs";\nexport const v = readFileSync;\n'],

  /* --- 跨套件相對路徑 / 逃出套件根 --------------------------------- */
  ["dep:cross-package-relative", SIM, 'import { a } from "../../engine/src/index";\nexport const v = a;\n'],
  ["dep:cross-package-relative", SIM, 'import { a } from "../../birth/src/draw";\nexport const v = a;\n'],
  ["dep:escapes-package-root", SIM, 'import frame from "../../../fixtures/ui-frame.json";\nexport const v = frame;\n'],

  /* --- simulation 純函式邊界：非決定性 ----------------------------- */
  ["purity:Math.random", SIM, "export const v = Math.random();\n"],
  ["purity:Date.now", SIM, "export const v = Date.now();\n"],
  ["purity:performance.now", SIM, "export const v = performance.now();\n"],
  ["purity:crypto.getRandomValues", SIM, "export const v = crypto.getRandomValues(new Uint8Array(1));\n"],
  ["purity:crypto.randomUUID", SIM, "export const v = crypto.randomUUID();\n"],
  ["purity:crypto.randomBytes", SIM, 'import { randomBytes } from "node:crypto";\nexport const v = randomBytes(4);\n'],
  ["purity:new-Date", SIM, "export const v = new Date();\n"],

  /* --- simulation 純函式邊界：環境 --------------------------------- */
  ["purity:global:window", SIM, "export const v = window.innerWidth;\n"],
  ["purity:global:document", SIM, "export const v = document.title;\n"],
  ["purity:global:navigator", SIM, "export const v = navigator.userAgent;\n"],
  ["purity:global:localStorage", SIM, 'export const v = localStorage.getItem("k");\n'],
  ["purity:global:sessionStorage", SIM, 'export const v = sessionStorage.getItem("k");\n'],
  ["purity:global:indexedDB", SIM, 'export const v = indexedDB.open("db");\n'],
  ["purity:global:fetch", SIM, 'export const v = fetch("/api");\n'],
  ["purity:global:XMLHttpRequest", SIM, "export const v = new XMLHttpRequest();\n"],
  ["purity:global:WebSocket", SIM, 'export const v = new WebSocket("ws://x");\n'],
  ["purity:global:process", SIM, "export const v = process.env.NODE_ENV;\n"],
  ["purity:global:Buffer", SIM, 'export const v = Buffer.from("a");\n'],
  ["purity:module:node:fs/promises", SIM, 'import { readFileSync } from "node:fs/promises";\nexport const v = readFileSync;\n'],
  ["purity:module:node:fs", SIM, "export const v = await import(\"node:fs\");\n"],
  ["purity:module:node:fs", SIM, 'const fs = require("node:fs");\nexport const v = fs;\n'],
  ["purity:module:fs", SIM, 'const fs = require("fs");\nexport const v = fs;\n'],
  ["purity:module:node:child_process", SIM, 'export const v = await import("node:child_process");\n'],
  ["purity:import-meta", SIM, "export const v = import.meta.url;\n"],

  /* --- simulation 純函式邊界：程式碼生成與排程 --------------------- */
  ["purity:eval", SIM, 'export const v = eval("1");\n'],
  ["purity:new-Function", SIM, 'export const v = new Function("return 1");\n'],
  ["purity:require", SIM, 'export const v = require("node:fs");\n'],
  ["purity:dynamic-import", SIM, 'export const v = await import("@life-sim/contracts");\n'],
  ["purity:timer:setTimeout", SIM, "export const v = setTimeout(() => {}, 1);\n"],
  ["purity:timer:setInterval", SIM, "export const v = setInterval(() => {}, 1);\n"],
  ["purity:timer:queueMicrotask", SIM, "export const v = queueMicrotask(() => {});\n"],

  /* --- 繞過手法：別名 / 解構 / computed --------------------------- */
  ["purity:Math.random", SIM, "const m = Math;\nexport const v = m.random();\n"],
  ["purity:computed(Math.random)", SIM, 'const k = "random";\nexport const v = Math[k]();\n'],
  ["purity:computed(Math.random)", SIM, "const { random } = Math;\nexport const v = random();\n"],
  ["purity:destructured(Math.random)", SIM, "const { random } = Math;\nexport const v = random();\n"],
  ["purity:destructured(Date.now)", SIM, "const { now } = Date;\nexport const v = now();\n"],
  ["purity:computed(Date.now)", SIM, "const { now } = Date;\nexport const v = now();\n"],
  ["purity:computed(crypto.getRandomValues)", SIM, "const { getRandomValues } = crypto;\nexport const v = getRandomValues(new Uint8Array(1));\n"],
  ["purity:global:window", SIM, "const g = globalThis;\nexport const v = g.window;\n"],
  ["purity:global:localStorage", SIM, 'export const v = globalThis["localStorage"];\n'],
  ["purity:eval", SIM, 'const e = eval;\nexport const v = e("1");\n'],
  ["purity:timer:setTimeout", SIM, "const t = setTimeout;\nexport const v = t(() => {}, 1);\n"],

  /* --- H5-CTO-055-B-R1：無法靜態確定的動態載入 --------------------- */
  // 1) engine：`let` 重新賦值後的可變別名
  [
    "dep:unresolved-dynamic-module",
    ENGINE,
    'let spec = "@life-sim/contracts";\nspec = "@life-sim/simulation";\nexport const value = import(spec);\n'
  ],
  // 2) engine：同名區域變數遮蔽（scope shadowing）
  [
    "dep:unresolved-dynamic-module",
    ENGINE,
    [
      'const spec = "@life-sim/contracts";',
      "function load() {",
      '  const spec = "@life-sim/simulation";',
      "  return import(spec);",
      "}",
      "export const value = load;",
      ""
    ].join("\n")
  ],
  // 3) engine：參數傳入的 import 規格
  ["dep:unresolved-dynamic-module", ENGINE, "export const load = (spec: string) => import(spec);\n"],
  // 3b) engine：參數傳入的 require 規格
  ["dep:unresolved-dynamic-module", ENGINE, "export const load = (spec: string) => require(spec);\n"],
  // 4) birth：參數傳入的 require 規格
  ["dep:unresolved-dynamic-module", BIRTH, "export const load = (spec: string) => require(spec);\n"],
  // 5) `require.resolve(spec)` 的動態規格
  ["dep:unresolved-dynamic-module", BIRTH, "export const load = (spec: string) => require.resolve(spec);\n"],
  ["dep:unresolved-dynamic-module", APPLICATION, "export const load = (spec: string) => require.resolve(spec);\n"],
  // 6) application／save 等其他套件：動態規格同樣讓循環圖不完整
  ["dep:unresolved-dynamic-module", APPLICATION, "export const load = (spec: string) => import(spec);\n"],
  ["dep:unresolved-dynamic-module", "packages/save/src/probe.ts", "export const load = (spec: string) => import(spec);\n"],
  ["dep:unresolved-dynamic-module", "packages/save/src/probe.ts", "export const load = (spec: string) => require(spec);\n"],
  ["dep:unresolved-dynamic-module", "packages/contracts/src/probe.ts", "export const load = (spec: string) => import(spec);\n"],
  // 6b) 其他形式的不可確定規格：模板替換、非字面值串接、成員運算式、條件運算式
  ["dep:unresolved-dynamic-module", ENGINE, "export const v = await import(`@life-sim/${name}`);\n"],
  ["dep:unresolved-dynamic-module", ENGINE, 'export const v = await import("@life-sim/" + name);\n'],
  ["dep:unresolved-dynamic-module", ENGINE, "export const v = await import(SPECS.birth);\n"],
  ["dep:unresolved-dynamic-module", ENGINE, 'export const v = await import(flag ? "@life-sim/birth" : "@life-sim/simulation");\n'],
  // 7) 直接字串 literal 仍能正確判斷目標套件
  ["dep:engine-imports-birth", ENGINE, 'export const v = await import("@life-sim/birth");\n'],
  ["dep:engine-imports-simulation", ENGINE, 'export const v = await import("@life-sim/simulation");\n'],
  ["dep:birth-imports-simulation", BIRTH, 'export const v = require("@life-sim/simulation");\n'],
  ["dep:private-path:birth-src", SIM, 'export const v = await import("@life-sim/birth/src/index");\n'],
  // 8) 直接 literal concat 仍能正確判斷目標套件
  ["dep:engine-imports-birth", ENGINE, 'export const v = await import("@life-sim/" + "birth");\n'],
  ["dep:engine-imports-simulation", ENGINE, 'export const v = await import("@life-sim/" + "sim" + "ulation");\n'],
  ["dep:birth-imports-simulation", BIRTH, 'export const v = await import("@life-sim/" + "simulation");\n'],
  ["dep:private-path:engine-src", SIM, 'export const v = await import("@life-sim/" + "engine/src/index");\n'],
  // 9) simulation 同時回報 dependency 與 purity（不可確定規格）
  ["dep:unresolved-dynamic-module", SIM, "export const load = (spec: string) => import(spec);\n"],
  ["purity:dynamic-import", SIM, "export const load = (spec: string) => import(spec);\n"],
  ["dep:unresolved-dynamic-module", SIM, "export const load = (spec: string) => require(spec);\n"],
  ["purity:require", SIM, "export const load = (spec: string) => require(spec);\n"],

  /* --- H5-CTO-055-B-R1：node: 前置一律禁止，含 node:path ----------- */
  ["purity:module:node:path", SIM, 'import { join } from "node:path";\nexport const v = join;\n'],
  ["purity:module:node:path", SIM, 'export const v = await import("node:path");\n'],
  ["purity:module:node:path", SIM, 'const p = require("node:path");\nexport const v = p;\n']
];

for (const [rule, path, source] of violationCases) {
  const violations = analyzeSource(source, path).violations;
  const hit = violations.some((violation) => violation.rule === rule);
  ok(
    `violation ${rule} @ ${path}`,
    hit,
    hit ? "" : `(got: ${violations.map((violation) => violation.rule).join(", ") || "no violation"})`
  );
}

/* ------------------------------------------------------------------ */
/* 2. 循環依賴                                                        */
/* ------------------------------------------------------------------ */

const twoCycle = detectCycles(new Map([["alpha", new Set(["beta"])], ["beta", new Set(["alpha"])]]));
ok("dep:cycle alpha <-> beta", twoCycle.length === 1 && twoCycle[0].includes("alpha") && twoCycle[0].includes("beta"), JSON.stringify(twoCycle));

const threeCycle = detectCycles(
  new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["c"])],
    ["c", new Set(["a"])]
  ])
);
ok("dep:cycle a -> b -> c -> a", threeCycle.length === 1, JSON.stringify(threeCycle));

const acyclic = detectCycles(
  new Map([
    ["simulation", new Set(["contracts", "engine", "birth"])],
    ["birth", new Set(["engine", "contracts"])],
    ["engine", new Set(["contracts"])],
    ["contracts", new Set()]
  ])
);
ok("dep:cycle legal DAG has none", acyclic.length === 0, JSON.stringify(acyclic));

/* ------------------------------------------------------------------ */
/* 3. 負控：合法程式不得誤判                                            */
/* ------------------------------------------------------------------ */

const cleanCases = [
  [
    "legal barrels + internal relative",
    SIM,
    [
      'import { P3E_SCHEMA_VERSION, type P3EStats } from "@life-sim/contracts";',
      'import { sha256 } from "@life-sim/engine";',
      'import { drawBirth } from "@life-sim/birth";',
      'import { P3EError } from "./errors";',
      "export function step(stats: P3EStats): P3EStats {",
      "  if (stats === undefined) throw new P3EError('E_P3E_ARGUMENT', 'stats');",
      "  return Object.freeze({ ...stats, version: P3E_SCHEMA_VERSION });",
      "}",
      "export const digest = (input: string): string => sha256(input) as unknown as string;",
      "export const draw = drawBirth;",
      ""
    ].join("\n")
  ],
  [
    "pure deterministic simulation sample",
    SIM,
    [
      "const TABLE = Object.freeze([1, 2, 3, 5, 8]);",
      "export function pick(index: number): number {",
      "  const safe = ((index % TABLE.length) + TABLE.length) % TABLE.length;",
      "  return TABLE[safe] ?? 0;",
      "}",
      "export function mix(a: number, b: number): number {",
      "  return Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b);",
      "}",
      ""
    ].join("\n")
  ],
  [
    "comment + string keywords are not references",
    SIM,
    [
      "// Math.random(); Date.now(); eval(\"x\"); window.localStorage.setItem(\"a\", \"b\")",
      "/* setTimeout(() => {}, 1) and fetch(\"/api\") and new Function(\"return 1\") */",
      'const note = "we never call Math.random or Date.now or eval here";',
      'const doc = "window.localStorage.setItem(\'a\', \'b\') and require(\'node:fs\')";',
      "export const description = `${note} / ${doc}`;",
      ""
    ].join("\n")
  ],
  ["legal engine -> contracts", ENGINE, 'import { a } from "@life-sim/contracts";\nexport const v = a;\n'],
  ["legal birth -> engine + contracts", BIRTH, 'import { a } from "@life-sim/engine";\nimport { b } from "@life-sim/contracts";\nexport const v = [a, b];\n'],
  ["legal intra-simulation relative", "packages/simulation/src/sub/probe.ts", 'import { a } from "../src/errors";\nexport const v = a;\n'],
  ["legal simulation barrel re-export", SIM, 'export { P3E_SCHEMA_VERSION } from "@life-sim/contracts";\n'],
  // H5-CTO-055-B-R1：直接字串 literal 的動態載入不應被新規則誤判
  ["legal engine dynamic import of contracts (literal)", ENGINE, 'export const v = await import("@life-sim/contracts");\n'],
  ["legal engine literal concat dynamic import", ENGINE, 'export const v = await import("@life-sim/" + "contracts");\n'],
  [
    "comment + string mentioning dynamic specifiers is clean",
    ENGINE,
    [
      "// export const load = (spec: string) => import(spec);",
      "/* require(spec) and require.resolve(spec) are only mentioned here */",
      'const doc = "import(spec); require(spec); require.resolve(spec)";',
      "export const note = `${doc}`;",
      ""
    ].join("\n")
  ]
];

for (const [label, path, source] of cleanCases) {
  const violations = analyzeSource(source, path).violations;
  ok(
    `clean ${label}`,
    violations.length === 0,
    `(got: ${violations.map((violation) => `${violation.rule}@${violation.line}`).join(", ")})`
  );
}

/* ------------------------------------------------------------------ */
/* 4. 端對端：暫存專案（只寫在 .artifacts 底下）                        */
/* ------------------------------------------------------------------ */

const tempRoot = join(process.cwd(), ".artifacts", "p3e-architecture-self-test", "project");
rmSync(join(process.cwd(), ".artifacts", "p3e-architecture-self-test"), { recursive: true, force: true });

const tempFiles = {
  "packages/contracts/src/index.ts": "export const A = 1;\n",
  "packages/engine/src/index.ts": 'import { B } from "@life-sim/birth";\nexport const E = B;\n',
  "packages/birth/src/index.ts": 'export { S } from "@life-sim/simulation";\n',
  "packages/simulation/src/index.ts": 'import { A } from "@life-sim/contracts";\nexport const S = A;\n',
  "packages/simulation/src/bad.ts": "export const t = Date.now();\n",
  "packages/simulation/src/leak.ts": 'import { x } from "../../engine/src/index";\nexport const L = x;\n',
  "packages/alpha/src/index.ts": 'import { z } from "@life-sim/beta";\nexport const a = z;\n',
  "packages/beta/src/index.ts": 'import { y } from "@life-sim/alpha";\nexport const b = y;\n',
  "packages/alpha/src/dynamic.ts": "export const load = (spec: string) => import(spec);\n",
  "packages/simulation/test/not-scanned.ts": "export const evil = Math.random();\n"
};

for (const [relativePath, content] of Object.entries(tempFiles)) {
  const absolute = join(tempRoot, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

const project = analyzeProject(tempRoot);
const rules = new Set(project.violations.map((violation) => violation.rule));
const filesScanned = project.files.map((file) => file.relative);

ok("e2e scans 9 production files", project.files.length === 9, `${project.files.length}`);
ok("e2e never scans test files", !filesScanned.some((file) => file.includes("/test/")), filesScanned.join(", "));
ok("e2e dep:engine-imports-birth", rules.has("dep:engine-imports-birth"));
ok("e2e dep:birth-imports-simulation", rules.has("dep:birth-imports-simulation"));
ok("e2e dep:unresolved-dynamic-module", rules.has("dep:unresolved-dynamic-module"), [...rules].join(", "));
ok(
  "e2e unresolved dynamic module attributed to alpha/src/dynamic.ts",
  project.violations.some(
    (violation) => violation.rule === "dep:unresolved-dynamic-module" && violation.file.endsWith("packages/alpha/src/dynamic.ts")
  )
);
ok("e2e purity:Date.now", rules.has("purity:Date.now"));
ok("e2e dep:cross-package-relative", rules.has("dep:cross-package-relative"));
ok("e2e dep:cycle detected", project.cycles.length === 1, JSON.stringify(project.cycles));
ok("e2e legal simulation barrel passes", !project.violations.some((violation) => violation.file.endsWith("simulation/src/index.ts")));

/* ------------------------------------------------------------------ */
/* 5. 規則清單完整性                                                   */
/* ------------------------------------------------------------------ */

const exercised = new Set([
  ...violationCases.map(([rule]) => rule),
  "dep:cycle",
  "purity:computed(Math.random)",
  "purity:computed(Date.now)",
  "purity:computed(crypto.getRandomValues)"
]);
const untouched = RULE_IDS.filter(
  (rule) => !exercised.has(rule) && ![...exercised].some((used) => used.startsWith(`${rule}:`) || used.startsWith(`${rule}(`))
);
ok(
  "rule catalogue fully exercised",
  untouched.length === 0,
  `untouched: ${untouched.join(", ")}`
);

/* ------------------------------------------------------------------ */
/* 6. 清除暫存                                                        */
/* ------------------------------------------------------------------ */

rmSync(join(process.cwd(), ".artifacts", "p3e-architecture-self-test"), { recursive: true, force: true });
ok("temp project removed", collectProductionFiles(process.cwd()).every((file) => !file.relative.includes(".artifacts")));

console.log(
  `P3E-SELFTEST ${checks} checks (${violationCases.length} violation cases, ${cleanCases.length} clean cases, 3 cycle cases, 10 e2e cases, 2 integrity cases)`
);

if (failures > 0) {
  console.error(`P3E-SELFTEST-FAIL ${failures}/${checks} checks failed`);
  process.exitCode = 1;
} else {
  console.log("P3E-SELFTEST-OK all checks passed");
}
