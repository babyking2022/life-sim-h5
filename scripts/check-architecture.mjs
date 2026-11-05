import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { scanSource } from "./architecture-rules.mjs";

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** 收集 import / export / dynamic import 的模組字串。 */
function moduleSpecifiers(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const specifiers = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function checkNondeterminism(label, root) {
  let failed = false;
  for (const file of files(root)) {
    const source = readFileSync(file, "utf8");
    for (const violation of scanSource(source, file)) {
      failed = true;
      console.error(`ARCH-FAIL ${label} ${relative(root, file)}:${violation.line} ${violation.rule}`);
    }
  }
  return failed;
}

function checkModules(label, root, forbidden, description) {
  let failed = false;
  for (const file of files(root)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of moduleSpecifiers(source, file)) {
      for (const pattern of forbidden) {
        if (pattern.test(specifier)) {
          failed = true;
          console.error(`ARCH-FAIL ${label} ${relative(root, file)} module:${specifier}`);
        }
      }
    }
  }
  if (!failed) console.log(`ARCH-OK ${label} ${description}`);
  return failed;
}

/* engine：非決定性 API、DOM、storage、crypto、save、react 全部禁止（P1-B 既有規則）。 */
let failed = checkNondeterminism("engine", "packages/engine/src");
if (!failed) {
  console.log("ARCH-OK engine AST has no forbidden nondeterministic, DOM, React, storage, crypto/dynamic-import, or save access");
}

/* birth：出生資料契約與抽選層，不得碰非決定性 API、檔案、網路、存檔、UI 框架。 */
const birthForbidden = [
  /^@life-sim\/save$/,
  /^@life-sim\/save\//,
  /^@life-sim\/application$/,
  /^@life-sim\/application\//,
  /^react(\/|$)/,
  /^react-dom(\/|$)/,
  /^node:fs$/,
  /^fs$/,
  /^node:fs\/promises$/,
  /^node:http/,
  /^http$/,
  /^https$/,
  /^node:net$/,
  /^node:child_process$/,
  /^node:worker_threads$/
];
failed = checkNondeterminism("birth", "packages/birth/src") || failed;
failed =
  checkModules(
    "birth",
    "packages/birth/src",
    birthForbidden,
    "birth has no DOM, storage, network, file, save or React access; draws stay on engine RNG"
  ) || failed;

/* ui：不得直接讀取未驗證的 P2-A raw 資料，也不得把 engine／save／birth／simulation
 * 拉進 UI；更不能碰任何套件的 private src 路徑。
 * H5-CTO-176-A 起，UI 的正式 runtime 只能經由公開 facade `@life-sim/application`
 * 使用 P3-E（session／view）；pack JSON 由 UI 以資產形式取得後，**原樣**交給
 * application bootstrap 驗證（UI 不自行驗證、不拆解 pack）。 */
const uiForbidden = [
  /^@life-sim\/simulation/,
  /^@life-sim\/birth/,
  /^@life-sim\/engine/,
  /^@life-sim\/save/,
  /^@life-sim\/[a-z-]+\/src(\/|$)/,
  /^\.\.\/\.\.\/[a-z-]+\/src(\/|$)/,
  /fixtures\/p2a/,
  /data\/p2a/,
  /country-registry\.v1\.json/,
  /birth-weights\.v1\.json/,
  /manifest\.v1\.json/
];

/* 規則自我驗證：確保 forbidding 規則真的有在擋，且 application 公開 barrel 沒被誤擋。
 * （lint 每次都會跑這裡，等於每次 lint 都示範這道 gate 生效。） */
const uiRuleProbe = {
  simulation: uiForbidden.some((pattern) => pattern.test("@life-sim/simulation/src/index")),
  privateSrc: uiForbidden.some((pattern) => pattern.test("@life-sim/application/src/index")),
  relativeSrc: uiForbidden.some((pattern) => pattern.test("../../simulation/src/index")),
  application: uiForbidden.some((pattern) => pattern.test("@life-sim/application"))
};
if (
  !uiRuleProbe.simulation ||
  !uiRuleProbe.privateSrc ||
  !uiRuleProbe.relativeSrc ||
  uiRuleProbe.application
) {
  console.error(`ARCH-FAIL ui rule self-probe ${JSON.stringify(uiRuleProbe)}`);
  failed = true;
} else {
  console.log(
    "ARCH-OK ui rule self-probe simulation/private-src/relative-src forbidden, application facade allowed"
  );
}

failed =
  checkModules(
    "ui",
    "packages/ui/src",
    uiForbidden,
    "ui imports neither P2-A raw data nor simulation/engine/save/birth/private-src (application facade allowed since 176-A)"
  ) || failed;

/**
 * benchmark／測試注入隔離（P3-A.3／P3-C）：
 * `life/benchmark`（任意壽命、年度失敗注入、偽造輔助）與 `life/annual/benchmark`
 * （P3-C 的同類入口）只能被測試與 scripts 使用，正式套件與 engine 公開 barrel 不得 import 它。
 */
function checkBenchmarkIsolation() {
  let failedLocal = false;
  const roots = ["packages/engine/src", "packages/application/src", "packages/birth/src", "packages/save/src", "packages/ui/src"];
  for (const root of roots) {
    for (const file of files(root)) {
      const normalized = file.replaceAll("\\", "/");
      if (normalized.endsWith("life/benchmark.ts") || normalized.endsWith("life/annual/benchmark.ts")) continue;
      const source = readFileSync(file, "utf8");
      for (const specifier of moduleSpecifiers(source, file)) {
        if (/(^|\/)benchmark$/.test(specifier) || specifier.endsWith("/life/benchmark")) {
          failedLocal = true;
          console.error(`ARCH-FAIL benchmark-isolation ${file} module:${specifier}`);
        }
      }
    }
  }
  if (!failedLocal) console.log("ARCH-OK benchmark-isolation production packages never import life/benchmark or life/annual/benchmark");
  return failedLocal;
}

/**
 * events／annual 純度（P3-B／P3-C）：事件與年度整合只能宣告資料，不得執行任意程式。
 * 禁止 `eval`、`new Function`、動態 `import()`、`require`、計時器（時間來源）。
 * 先跑一個正控（probe）確認規則真的抓得到，再掃真檔。
 */
const EVENTS_PURITY_CALLS = new Set(["eval", "require", "setTimeout", "setInterval", "queueMicrotask", "setImmediate"]);

function purityViolations(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) found.push({ line: lineOf(node), rule: "dynamic-import" });
      else if (ts.isIdentifier(callee) && EVENTS_PURITY_CALLS.has(callee.text)) found.push({ line: lineOf(node), rule: callee.text });
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      found.push({ line: lineOf(node), rule: "new Function" });
    }
    ts.forEachChild(node, visit);
  };
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  visit(sourceFile);
  return found;
}

function checkEventsPurity() {
  const probe = 'const f = new Function("return 1");\neval("1");\nimport("node:fs");\n';
  if (purityViolations(probe, "probe.ts").length !== 3) {
    console.error("ARCH-FAIL events-purity self-test did not detect the probe");
    return true;
  }
  let failedLocal = false;
  for (const root of ["packages/engine/src/life/events", "packages/engine/src/life/annual"]) {
    for (const file of files(root)) {
      for (const violation of purityViolations(readFileSync(file, "utf8"), file)) {
        failedLocal = true;
        console.error(`ARCH-FAIL events-purity ${file}:${violation.line} ${violation.rule}`);
      }
    }
  }
  if (!failedLocal) {
    console.log("ARCH-OK events-purity event DSL and P3-C annual integration have no eval, Function constructor, dynamic import, require or timers");
  }
  return failedLocal;
}

failed = checkBenchmarkIsolation() || failed;
failed = checkEventsPurity() || failed;

if (failed) process.exitCode = 1;
