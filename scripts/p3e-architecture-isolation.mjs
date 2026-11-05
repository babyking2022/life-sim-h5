/**
 * P3-E 架構隔離檢查（WorkBuddy Agent B 獨立候選，H5-CTO-053-B）。
 *
 * 這是**候選**程式：不進 `package.json`、不進 `pnpm lint`，需手動執行：
 * ```bash
 * node scripts/p3e-architecture-isolation.mjs
 * node scripts/p3e-architecture-isolation-self-test.mjs
 * ```
 *
 * ## 檢查範圍
 * 只掃正式生產程式（`packages/<pkg>/src/**`），**不掃測試檔案**
 * （`test/`、`__tests__/`、`*.test.ts`、`*.spec.ts`、`*.d.ts`）。
 *
 * ## 兩大規則家族
 * 1. **依賴方向**（`dep:*`）：engine 不得依賴 birth／simulation；birth 不得依賴
 *    simulation；不得有跨套件循環；simulation 只能用 contracts／engine／birth 的
 *    公開 barrel 與自身相對路徑，不得碰其他套件的私人路徑或跨套件相對路徑。
 *    另外 `dep:unresolved-dynamic-module`（H5-CTO-055-B-R1）：所有生產套件中，
 *    `import()`／`require()`／`require.resolve()` 的模組規格只要不是「直接字串
 *    字面值／no-substitution template／純字面值 `+` 串接」，一律硬失敗——不依賴
 *    非 scope-aware 的 alias 表（會被 `let` 重新賦值、同名遮蔽、參數傳入欺騙）。
 * 2. **simulation 純函式邊界**（`purity:*`）：`packages/simulation/src/**` 禁止
 *    React、DOM、storage、IndexedDB、網路、Node 檔案系統、`Math.random`、
 *    `Date.now`、`performance.now`、隨機 crypto、`eval`、`new Function`、
 *    dynamic import、`require`、計時器等會讓決定性或瀏覽器／Node 分歧的入口。
 *
 * ## 方法
 * 全程使用 TypeScript AST（`typescript` 編譯器 API），不做單純文字搜尋；
 * 並**重用**專案既有的 `scripts/architecture-rules.mjs#scanSource` 作為既有純度規則。
 * 另外自行解析 `const` 別名、解構別名、computed element access 與字串常數別名，
 * 以攔截常見繞過方式；註解不在 AST 內、字串字面值不是運算式，因此不會誤判。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { scanSource } from "./architecture-rules.mjs";

/* ------------------------------------------------------------------ */
/* 常數                                                                */
/* ------------------------------------------------------------------ */

/** simulation 唯一允許的跨套件來源：三個公開 barrel。 */
export const SIMULATION_ALLOWED_BARRELS = new Set(["@life-sim/contracts", "@life-sim/engine", "@life-sim/birth"]);

/** 明確禁止的單向依賴：`from -> [to, ...]`。 */
const FORBIDDEN_DEPENDENCIES = new Map([
  ["engine", ["birth", "simulation"]],
  ["birth", ["simulation"]]
]);

const TEST_DIR_PATTERN = /(^|\/)(tests?|__tests__|__mocks__|__fixtures__)(\/|$)/;
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?tsx?$/;
const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/;
const SOURCE_FILE_PATTERN = /\.[cm]?tsx?$/;

/** 瀏覽器專屬全域（模擬層不得碰，會讓 Node 端無法執行）。 */
const BROWSER_GLOBALS = new Set([
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
  "ServiceWorker",
  "caches",
  "Notification"
]);

/** Node 專屬全域。 */
const NODE_GLOBALS = new Set(["process", "Buffer"]);

/** 計時器／微任務：時間或排程來源，會破壞決定性。 */
const TIMER_GLOBALS = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "requestAnimationFrame",
  "requestIdleCallback"
]);

/** 程式碼生成與 CommonJS 載入入口。 */
const CODEGEN_GLOBALS = new Set(["eval", "require"]);

/** DOM／BOM 全域：既有的 `scanSource` 已涵蓋，此處再列一次是為了補上別名解析。 */
const DOM_GLOBALS = new Set([
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch",
  "location",
  "history",
  "screen"
]);

/** 直接具名匯入的隨機 crypto 函式（`import { randomBytes } from "node:crypto"`）。 */
const CRYPTO_FUNCTIONS = new Set(["getRandomValues", "randomUUID", "randomBytes", "randomInt"]);

/** 非決定性或環境分歧的靜態方法（含別名後仍可解析）。 */
const FORBIDDEN_METHODS = new Set([
  "Math.random",
  "Date.now",
  "performance.now",
  "crypto.getRandomValues",
  "crypto.randomUUID",
  "crypto.randomBytes",
  "crypto.randomInt"
]);

/** 會洩漏執行環境的模組（一律禁止，含 `node:` 前置）。 */
const FORBIDDEN_ENV_MODULES = new Set([
  "fs",
  "child_process",
  "worker_threads",
  "net",
  "http",
  "https",
  "os",
  "timers",
  "perf_hooks",
  "vm",
  "module",
  "inspector",
  "dns",
  "readline",
  "tty",
  "cluster"
]);

/** 規則 ID 清單（供自我測試與報告使用）。 */
export const RULE_IDS = [
  "dep:engine-imports-birth",
  "dep:engine-imports-simulation",
  "dep:birth-imports-simulation",
  "dep:private-path",
  "dep:private-path:contracts-src",
  "dep:private-path:engine-src",
  "dep:private-path:birth-src",
  "dep:private-path:simulation-src",
  "dep:simulation-external-import",
  "dep:cross-package-relative",
  "dep:escapes-package-root",
  "dep:unresolved-dynamic-module",
  "dep:cycle",
  "purity:Math.random",
  "purity:Date.now",
  "purity:performance.now",
  "purity:crypto.getRandomValues",
  "purity:crypto.randomUUID",
  "purity:crypto.randomBytes",
  "purity:global",
  "purity:timer",
  "purity:eval",
  "purity:new-Function",
  "purity:new-Date",
  "purity:require",
  "purity:dynamic-import",
  "purity:module",
  "purity:import-meta",
  "purity:computed",
  "purity:destructured"
];

/* ------------------------------------------------------------------ */
/* 路徑與檔案工具                                                      */
/* ------------------------------------------------------------------ */

function toPosix(value) {
  return value.split("\\").join("/");
}

/** 只接受 `packages/<pkg>/src/**` 且非測試、非宣告檔的正式生產程式。 */
export function isProductionSource(relPath) {
  const path = toPosix(relPath);
  if (!SOURCE_FILE_PATTERN.test(path)) return false;
  if (TEST_DIR_PATTERN.test(path) || TEST_FILE_PATTERN.test(path) || DECLARATION_FILE_PATTERN.test(path)) return false;
  return /^packages\/[^/]+\/src\//.test(path);
}

/** 由相對路徑取出套件名（`packages/<pkg>/...` → `<pkg>`）。 */
export function packageOf(relPath) {
  const match = /^packages\/([^/]+)\//.exec(toPosix(relPath));
  return match === null ? null : match[1];
}

/** 把相對 import 規格解析成專案根的 posix 路徑（不做 fs 判斷）。 */
function resolveRelative(fromRelPath, specifier) {
  const segments = toPosix(fromRelPath).split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) walk(absolute, onFile);
    else onFile(absolute);
  }
}

/** 收集專案內所有正式生產程式（回傳 `{ absolute, relative }`）。 */
export function collectProductionFiles(rootDir) {
  const packagesDir = join(rootDir, "packages");
  if (!existsSync(packagesDir)) return [];
  const found = [];
  for (const entry of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, entry, "src");
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;
    walk(srcDir, (absolute) => {
      const relPath = toPosix(relative(rootDir, absolute));
      if (isProductionSource(relPath)) found.push({ absolute, relative: relPath });
    });
  }
  return found.sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* AST 工具                                                            */
/* ------------------------------------------------------------------ */

function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function literalText(node) {
  const value = unwrap(node);
  if (!value) return undefined;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  return undefined;
}

/** 字面值或字面值串接（`"@life-sim/" + "birth"` 這類別名也要能被靜態解析）。 */
function literalOrConcat(node) {
  const value = unwrap(node);
  if (!value) return undefined;
  const direct = literalText(value);
  if (direct !== undefined) return direct;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalOrConcat(value.left);
    const right = literalOrConcat(value.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

/** 收集 `const NAME = "字面值"` 讓 `import(NAME)` 仍可被靜態判定。 */
function collectConstStrings(sourceFile) {
  const map = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !map.has(node.name.text)) {
      const text = literalOrConcat(node.initializer);
      if (text !== undefined) map.set(node.name.text, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return map;
}

/**
 * 收集別名：`const A = B.c`、`const { c } = B`、`const { c: D } = B`。
 * 值存成 `{ node, property }`，解析時才展開，避免前向參考問題。
 */
function collectAliases(sourceFile) {
  const aliases = new Map();
  const register = (name, entry) => {
    if (!aliases.has(name)) aliases.set(name, entry);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isIdentifier(node.name)) {
        if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) {
          register(node.name.text, { node: init, property: undefined });
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isOmittedExpression(element)) continue;
          if (!ts.isIdentifier(element.name)) continue;
          const propertyNode = element.propertyName ?? element.name;
          if (!ts.isIdentifier(propertyNode)) continue;
          register(element.name.text, { node: init, property: propertyNode.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

/** 靜態字串：字面值、`const` 字串別名、字串串接、括號。 */
function staticStringOf(node, context, seen = new Set()) {
  const value = unwrap(node);
  if (!value) return undefined;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return value.text;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringOf(value.left, context, seen);
    const right = staticStringOf(value.right, context, seen);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isIdentifier(value)) {
    if (seen.has(value.text)) return undefined;
    const text = context.constStrings.get(value.text);
    return text === undefined ? undefined : text;
  }
  return undefined;
}

/**
 * **模組規格專用**的靜態解析（H5-CTO-055-B-R1）。
 *
 * 只接受可「可靠靜態確定」的形式：
 * - 直接字串字面值
 * - no-substitution template literal
 * - 完全由上述形式組成的 `+` 串接（含括號）
 *
 * **刻意不接受**識別字／別名／常數參考：模組目標不得依賴非 scope-aware 的全檔
 * alias 表判斷（`let` 重新賦值、同名區域變數遮蔽、參數傳入都會讓它失真），
 * 一律交由 `dep:unresolved-dynamic-module` 保守硬失敗。
 */
function moduleSpecifierText(node) {
  const value = unwrap(node);
  if (!value) return undefined;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = moduleSpecifierText(value.left);
    const right = moduleSpecifierText(value.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

/** 描述一個無法靜態確定的模組規格，供違規訊息使用。 */
function describeSpecifierArgument(node) {
  const value = unwrap(node);
  if (!value) return "<missing-specifier>";
  if (ts.isIdentifier(value)) return `identifier ${value.text}`;
  if (ts.isPrivateIdentifier(value)) return `identifier #${value.text}`;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return "concatenation with non-literal operand";
  }
  if (ts.isTemplateExpression(value)) return "template literal with substitution";
  if (ts.isConditionalExpression(value)) return "conditional expression";
  if (ts.isCallExpression(value)) return "call expression";
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) return "member expression";
  return `<${ts.SyntaxKind[value.kind] ?? "dynamic"}>`;
}

function canonicalPath(path) {
  let value = path;
  while (value.startsWith("globalThis.")) value = value.slice("globalThis.".length);
  return value;
}

/**
 * 把運算式解析成成員路徑：支援 `.`、`["key"]`、`const` 別名、解構別名、
 * `globalThis` 前綴。`computed` 代表過程中使用過 element access。
 */
function resolvePathOf(node, context, seen = new Set()) {
  const value = unwrap(node);
  if (!value) return undefined;
  if (ts.isIdentifier(value)) {
    const alias = context.aliases.get(value.text);
    if (alias && !seen.has(value.text)) {
      const next = new Set(seen);
      next.add(value.text);
      const resolved = resolvePathOf(alias.node, context, next);
      if (!resolved) return undefined;
      const path = alias.property === undefined ? resolved.path : `${resolved.path}.${alias.property}`;
      return { path, computed: alias.property === undefined ? resolved.computed : true };
    }
    return { path: value.text, computed: false };
  }
  if (ts.isPropertyAccessExpression(value)) {
    const base = resolvePathOf(value.expression, context, seen);
    if (!base) return undefined;
    return { path: `${base.path}.${value.name.text}`, computed: base.computed };
  }
  if (ts.isElementAccessExpression(value)) {
    const base = resolvePathOf(value.expression, context, seen);
    if (!base) return undefined;
    const key = staticStringOf(value.argumentExpression, context);
    if (key === undefined) return undefined;
    return { path: `${base.path}.${key}`, computed: true };
  }
  return undefined;
}

/** 跳過宣告名與屬性名，只對真正的「參考位置」求值。 */
function isReferencePosition(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isEnumMember(parent) && parent.name === node) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 模組規格收集                                                        */
/* ------------------------------------------------------------------ */

/**
 * 收集檔案內所有模組規格字串與其語法機制：
 * `static-import`／`re-export`／`import-equals`／`import-type`／
 * `dynamic-import`／`require`。
 *
 * 對於 `import()`／`require()`／`require.resolve()`，若規格無法被可靠靜態確定，
 * 回傳 `unresolved: true` 的條目，交由 `dep:unresolved-dynamic-module` 硬失敗
 * （H5-CTO-055-B-R1：不得因 alias 表找到某個初始值就放行）。
 */
function collectModuleSpecifiers(sourceFile, context) {
  const found = [];
  const push = (node, specifier, mechanism, argumentNode) => {
    if (specifier === undefined || specifier === "") {
      if (argumentNode === undefined) return;
      found.push({ node, specifier: undefined, mechanism, unresolved: true, argument: describeSpecifierArgument(argumentNode) });
      return;
    }
    found.push({ node, specifier, mechanism, unresolved: false, argument: undefined });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      push(node, moduleSpecifierText(node.moduleSpecifier), ts.isExportDeclaration(node) ? "re-export" : "static-import");
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      push(node, moduleSpecifierText(node.moduleReference.expression), "import-equals", node.moduleReference.expression);
    }
    if (ts.isImportTypeNode(node)) {
      const literal = unwrap(node.argument);
      if (ts.isLiteralTypeNode(literal)) {
        push(node, moduleSpecifierText(literal.literal), "import-type", literal.literal);
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      if (expression && expression.kind === ts.SyntaxKind.ImportKeyword) {
        push(node, moduleSpecifierText(node.arguments[0]), "dynamic-import", node.arguments[0]);
      }
      const callee = resolvePathOf(expression, context);
      if (callee && (callee.path === "require" || callee.path === "require.resolve")) {
        push(node, moduleSpecifierText(node.arguments[0]), "require", node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/* ------------------------------------------------------------------ */
/* 依賴方向規則                                                        */
/* ------------------------------------------------------------------ */

function privatePathRule(specifier) {
  if (specifier.startsWith("@life-sim/contracts/src")) return "dep:private-path:contracts-src";
  if (specifier.startsWith("@life-sim/engine/src")) return "dep:private-path:engine-src";
  if (specifier.startsWith("@life-sim/birth/src")) return "dep:private-path:birth-src";
  if (specifier.startsWith("@life-sim/simulation/src")) return "dep:private-path:simulation-src";
  return "dep:private-path";
}

function targetPackageOf(specifier) {
  const match = /^@life-sim\/([^/]+)(\/|$)/.exec(specifier);
  return match === null ? null : match[1];
}

/**
 * 單檔分析：`source` 為程式碼，`relPath` 為專案根起的 posix 相對路徑。
 * 回傳 `{ violations, deps }`，`deps` 為此檔指向的其他套件名集合。
 */
export function analyzeSource(source, relPath) {
  const path = toPosix(relPath);
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const context = { constStrings: collectConstStrings(sourceFile), aliases: collectAliases(sourceFile) };
  const violations = [];
  const notes = [];
  const deps = new Set();
  const seen = new Set();
  const ownPackage = packageOf(path);
  const isSimulationSource = /^packages\/simulation\/src\//.test(path);
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const report = (node, rule, detail) => {
    const key = `${rule}|${detail ?? ""}|${node.getStart(sourceFile)}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ rule, line: lineOf(node), detail: detail ?? "" });
  };

  /* ---- 1. 依賴方向 ------------------------------------------------ */
  for (const entry of collectModuleSpecifiers(sourceFile, context)) {
    const { node, specifier, mechanism } = entry;

    // 動態載入的模組規格無法可靠靜態確定 → 依賴圖可能不完整，一律硬失敗。
    // simulation 會同時被後面的 purity:dynamic-import／purity:require 再報一次。
    if (entry.unresolved) {
      report(node, "dep:unresolved-dynamic-module", `${mechanism} ${entry.argument ?? "<dynamic>"}`);
      continue;
    }

    const target = targetPackageOf(specifier);

    if (target !== null && specifier !== `@life-sim/${target}`) {
      // 任何 `@life-sim/<pkg>/<sub>` 都是私人路徑。
      report(node, privatePathRule(specifier), `${mechanism} ${specifier}`);
      if (target !== ownPackage) deps.add(target);
      continue;
    }

    if (target !== null) {
      if (target !== ownPackage) deps.add(target);
      const forbidden = FORBIDDEN_DEPENDENCIES.get(ownPackage);
      if (forbidden && forbidden.includes(target)) {
        report(node, `dep:${ownPackage}-imports-${target}`, `${mechanism} ${specifier}`);
      }
      if (isSimulationSource && !SIMULATION_ALLOWED_BARRELS.has(specifier)) {
        report(node, "dep:simulation-external-import", `${mechanism} ${specifier}`);
      }
      continue;
    }

    if (specifier.startsWith(".")) {
      const resolved = resolveRelative(path, specifier);
      const resolvedPackage = packageOf(resolved);
      if (resolvedPackage !== null && resolvedPackage !== ownPackage) {
        // 逃進另一個 package：明確的跨套件相對路徑違規。
        report(node, "dep:cross-package-relative", `${mechanism} ${specifier} -> ${resolved}`);
      } else if (resolvedPackage === null) {
        // 逃出 `packages/` 之外（例如 `fixtures/`）：simulation 必須完全封閉，
        // 因此對 simulation 是違規；其他既有套件（如 ui 讀取 UI frame fixture）
        // 只列為提示，不判失敗。
        const detail = `${mechanism} ${specifier} -> ${resolved}`;
        if (isSimulationSource) report(node, "dep:escapes-package-root", detail);
        else notes.push({ rule: "dep:escapes-package-root", line: lineOf(node), detail });
      }
      continue;
    }

    // 裸模組（第三方或 Node 內建）。
    if (isSimulationSource) {
      report(node, "dep:simulation-external-import", `${mechanism} ${specifier}`);
    }
  }

  /* ---- 2. simulation 純函式邊界 ----------------------------------- */
  if (isSimulationSource) {
    // 2a. 重用專案既有的 AST 純度規則（Math.random／Date.now／DOM／storage／crypto／react／save…）。
    for (const violation of scanSource(source, path)) {
      const rule = `purity:${violation.rule}`;
      const key = `${rule}|${violation.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ rule, line: violation.line, detail: "shared scanner" });
    }

    // 2b. 本檢查新增的規則：eval／Function／Date 建構／require／dynamic import／計時器／Node 與瀏覽器專屬全域。
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const expression = unwrap(node.expression);
        if (expression && expression.kind === ts.SyntaxKind.ImportKeyword) {
          report(node, "purity:dynamic-import", moduleSpecifierText(node.arguments[0]) ?? "<non-literal>");
        }
        const callee = resolvePathOf(expression, context);
        if (callee) {
          const canonical = canonicalPath(callee.path);
          if (canonical === "eval" || canonical === "globalThis.eval") report(node, "purity:eval", canonical);
          else if (canonical === "require" || canonical === "require.resolve") report(node, "purity:require", canonical);
          else if (TIMER_GLOBALS.has(canonical)) report(node, `purity:timer:${canonical}`, "call");
        }
      }

      if (ts.isNewExpression(node)) {
        const expression = unwrap(node.expression);
        const resolved = resolvePathOf(expression, context);
        const name = resolved ? canonicalPath(resolved.path) : undefined;
        if (name === "Function") report(node, "purity:new-Function", "new Function");
        if (name === "Date") report(node, "purity:new-Date", "new Date");
      }

      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        report(node, "purity:import-meta", "import.meta");
      }

      const isReferenceNode =
        (ts.isIdentifier(node) ||
          ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        isReferencePosition(node);

      if (isReferenceNode) {
        const resolved = resolvePathOf(node, context);
        if (resolved) {
          const canonical = canonicalPath(resolved.path);
          const base = canonical.split(".")[0];
          const suffix = resolved.computed ? `computed(${canonical})` : canonical;
          if (canonical === "eval" || canonical === "globalThis.eval") {
            report(node, "purity:eval", canonical);
          } else if (canonical === "require" || canonical.startsWith("require.")) {
            report(node, "purity:require", canonical);
          } else if (FORBIDDEN_METHODS.has(canonical)) {
            report(node, `purity:${suffix}`, "nondeterministic method");
          } else if (CRYPTO_FUNCTIONS.has(canonical)) {
            report(node, `purity:crypto.${canonical}`, "random crypto entry");
          } else if (TIMER_GLOBALS.has(base)) {
            report(node, `purity:timer:${base}`, "timer entry");
          } else if (DOM_GLOBALS.has(canonical)) {
            report(node, `purity:global:${canonical}`, "dom/bom global");
          } else if (BROWSER_GLOBALS.has(canonical) || NODE_GLOBALS.has(canonical)) {
            report(node, `purity:global:${canonical}`, "env global");
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    // 2c. 會洩漏執行環境的模組規格（靜態／re-export／dynamic／require 皆攔）。
    for (const entry of collectModuleSpecifiers(sourceFile, context)) {
      if (entry.unresolved || entry.specifier === undefined) continue;
      const bare = entry.specifier.startsWith("node:") ? entry.specifier.slice("node:".length) : entry.specifier;
      if (entry.specifier.startsWith("node:") || FORBIDDEN_ENV_MODULES.has(bare)) {
        report(entry.node, `purity:module:${entry.specifier}`, entry.mechanism);
      }
    }
  }

  return { violations, notes, deps };
}

/* ------------------------------------------------------------------ */
/* 循環依賴                                                            */
/* ------------------------------------------------------------------ */

function canonicalCycle(sequence) {
  let start = 0;
  for (let index = 1; index < sequence.length; index += 1) {
    if (sequence[index] < sequence[start]) start = index;
  }
  return sequence.slice(start).concat(sequence.slice(0, start)).join(" -> ");
}

/** `adjacency: Map<package, Set<package>>` → 正規化後的循環路徑字串陣列。 */
export function detectCycles(adjacency) {
  const cycles = new Set();
  const state = new Map();
  const stack = [];

  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of [...(adjacency.get(node) ?? [])].sort()) {
      if (next === node) continue;
      const status = state.get(next) ?? 0;
      if (status === 1) {
        cycles.add(canonicalCycle(stack.slice(stack.indexOf(next))));
      } else if (status === 0) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of [...adjacency.keys()].sort()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }
  return [...cycles].sort();
}

/* ------------------------------------------------------------------ */
/* 專案掃描                                                            */
/* ------------------------------------------------------------------ */

/** 掃描整個專案的正式生產程式。 */
export function analyzeProject(rootDir) {
  const files = collectProductionFiles(rootDir);
  const violations = [];
  const notes = [];
  const adjacency = new Map();

  for (const file of files) {
    const source = readFileSync(file.absolute, "utf8");
    const result = analyzeSource(source, file.relative);
    for (const violation of result.violations) {
      violations.push({ file: file.relative, ...violation });
    }
    for (const note of result.notes) {
      notes.push({ file: file.relative, ...note });
    }
    const from = packageOf(file.relative);
    if (from === null) continue;
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    for (const to of result.deps) adjacency.get(from).add(to);
  }

  const cycles = detectCycles(adjacency);
  for (const cycle of cycles) {
    violations.push({ file: "<package-graph>", rule: "dep:cycle", line: 0, detail: cycle });
  }

  return { files, violations, notes, adjacency, cycles };
}

/* ------------------------------------------------------------------ */
/* 正控：先證明分析器抓得到，再掃真檔                                   */
/* ------------------------------------------------------------------ */

function selfProbe() {
  const probes = [
    ["packages/engine/src/probe.ts", 'import { a } from "@life-sim/birth";\n', "dep:engine-imports-birth"],
    ["packages/engine/src/probe.ts", 'import { a } from "@life-sim/simulation";\n', "dep:engine-imports-simulation"],
    ["packages/birth/src/probe.ts", 'export { a } from "@life-sim/simulation";\n', "dep:birth-imports-simulation"],
    ["packages/simulation/src/probe.ts", 'import { a } from "@life-sim/engine/src/rng/xoshiro128";\n', "dep:private-path:engine-src"],
    ["packages/simulation/src/probe.ts", 'import { a } from "../../engine/src/index";\n', "dep:cross-package-relative"],
    ["packages/simulation/src/probe.ts", 'import frame from "../../../fixtures/ui-frame.json";\n', "dep:escapes-package-root"],
    ["packages/simulation/src/probe.ts", 'const v = Math.random();\n', "purity:Math.random"],
    ["packages/simulation/src/probe.ts", 'const v = Date.now();\n', "purity:Date.now"],
    ["packages/simulation/src/probe.ts", 'eval("1");\n', "purity:eval"],
    ["packages/simulation/src/probe.ts", 'const f = new Function("return 1");\n', "purity:new-Function"],
    ["packages/simulation/src/probe.ts", 'await import("@life-sim/contracts");\n', "purity:dynamic-import"],
    ["packages/simulation/src/probe.ts", 'const fs = require("node:fs");\n', "purity:require"],
    ["packages/simulation/src/probe.ts", 'setTimeout(() => {}, 1);\n', "purity:timer:setTimeout"],
    ["packages/engine/src/probe.ts", 'export const load = (spec: string) => import(spec);\n', "dep:unresolved-dynamic-module"],
    ["packages/birth/src/probe.ts", 'export const load = (spec: string) => require(spec);\n', "dep:unresolved-dynamic-module"],
    ["packages/birth/src/probe.ts", 'export const load = (spec: string) => require.resolve(spec);\n', "dep:unresolved-dynamic-module"],
    ["packages/engine/src/probe.ts", 'export const v = await import("@life-sim/" + "birth");\n', "dep:engine-imports-birth"]
  ];
  const missed = [];
  for (const [path, source, rule] of probes) {
    const result = analyzeSource(source, path);
    if (!result.violations.some((violation) => violation.rule === rule)) missed.push(rule);
  }
  const cycleCase = detectCycles(new Map([["alpha", new Set(["beta"])], ["beta", new Set(["alpha"])]]));
  if (cycleCase.length === 0) missed.push("dep:cycle");
  return { missed, count: probes.length + 1 };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function main() {
  const rootDir = process.cwd();
  const probe = selfProbe();
  const probesCount = probe.count;
  if (probe.missed.length > 0) {
    for (const rule of probe.missed) console.error(`P3E-ARCH-FAIL self-probe rule ${rule} did not fire`);
    process.exitCode = 1;
    return;
  }
  console.log(`P3E-ARCH-OK self-probe all ${probesCount} positive controls detected`);

  const { files, violations, notes, cycles } = analyzeProject(rootDir);
  const packages = [...new Set(files.map((file) => packageOf(file.relative)))].sort();

  console.log(`P3E-ARCH-SCAN ${files.length} production files across ${packages.length} packages: ${packages.join(", ")}`);
  if (cycles.length === 0) {
    console.log("P3E-ARCH-OK dep:cycle no package-level dependency cycle");
  }
  for (const note of notes) {
    console.log(`P3E-ARCH-NOTE ${note.rule} ${note.file}:${note.line} ${note.detail}`);
  }

  for (const violation of violations) {
    console.error(`P3E-ARCH-FAIL ${violation.rule} ${violation.file}:${violation.line} ${violation.detail}`);
  }

  if (violations.length > 0) {
    console.error(`P3E-ARCH-FAIL ${violations.length} violation(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("P3E-ARCHITECTURE-ISOLATION-OK dependency direction and simulation purity clean");
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
