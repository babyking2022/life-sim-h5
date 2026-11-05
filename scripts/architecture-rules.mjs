import ts from "typescript";

const FORBIDDEN_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "navigator",
  "fetch",
  "crypto"
]);

const FORBIDDEN_PROPERTIES = new Map([
  ["Math.random", "Math.random"],
  ["Date.now", "Date.now"],
  ["performance.now", "performance.now"],
  ["crypto.getRandomValues", "crypto.getRandomValues"],
  ["crypto.randomUUID", "crypto.randomUUID"],
  ["crypto.randomBytes", "crypto.randomBytes"]
]);

const FORBIDDEN_PROPERTY_NAMES = new Set(["getRandomValues", "randomUUID", "randomBytes"]);

const GLOBAL_THIS = "globalThis";

function isForbiddenModule(specifier) {
  if (specifier === "crypto" || specifier.startsWith("crypto/")) return true;
  if (specifier === "node:crypto" || specifier.startsWith("node:crypto/")) return true;
  if (specifier === "react" || specifier.startsWith("react/")) return true;
  if (specifier === "react-dom" || specifier.startsWith("react-dom/")) return true;
  if (specifier === "@life-sim/save") return true;
  if (specifier.startsWith("@life-sim/save/")) return true;
  return /(^|\/)save(\/|$)/.test(specifier);
}

function stringValue(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Reads a statically determinable property key: string/template/numeric literal,
 * a `const` text alias, or a parenthesized form of any of those.
 */
function staticKeyOf(node, constStrings) {
  const value = unwrap(node);
  if (!value) return undefined;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return value.text;
  if (ts.isIdentifier(value)) return constStrings.get(value.text);
  return undefined;
}

/**
 * Resolves a member path through dot access, statically-keyed element access and
 * `globalThis` prefixes. `computed` records whether any element access was used.
 */
function pathOf(node, constStrings) {
  const value = unwrap(node);
  if (!value) return undefined;
  if (ts.isIdentifier(value)) return { path: value.text, computed: false };
  if (ts.isPropertyAccessExpression(value)) {
    const base = pathOf(value.expression, constStrings);
    if (!base) return undefined;
    return { path: `${base.path}.${value.name.text}`, computed: base.computed };
  }
  if (ts.isElementAccessExpression(value)) {
    const base = pathOf(value.expression, constStrings);
    if (!base) return undefined;
    const key = staticKeyOf(value.argumentExpression, constStrings);
    if (key === undefined) return undefined;
    return { path: `${base.path}.${key}`, computed: true };
  }
  return undefined;
}

function canonicalPath(path) {
  let value = path;
  while (value.startsWith(`${GLOBAL_THIS}.`)) value = value.slice(GLOBAL_THIS.length + 1);
  return value;
}

/** Collects `const NAME = "text"` bindings so `Math[key]` stays statically decidable. */
function collectConstStrings(sourceFile) {
  const constStrings = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const text = stringValue(unwrap(node.initializer));
      if (text !== undefined && !constStrings.has(node.name.text)) constStrings.set(node.name.text, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return constStrings;
}

export function scanSource(source, fileName = "fixture.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const violations = [];
  const seen = new Set();
  const constStrings = collectConstStrings(sourceFile);

  const report = (node, rule) => {
    const key = `${rule}:${node.getStart(sourceFile)}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ rule, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
  };

  const reportAccess = (node, resolved) => {
    const canonical = canonicalPath(resolved.path);
    const segments = canonical.split(".");
    if (segments.length === 1) {
      if (!FORBIDDEN_GLOBALS.has(canonical)) return;
      return report(node, resolved.computed ? `computed(global:${canonical})` : `global:${canonical}`);
    }
    if (FORBIDDEN_PROPERTIES.has(canonical)) {
      return report(node, resolved.computed ? `computed(${canonical})` : FORBIDDEN_PROPERTIES.get(canonical));
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier ? stringValue(node.moduleSpecifier) : undefined;
      if (specifier && isForbiddenModule(specifier)) report(node, `module:${specifier}`);
    }

    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) {
        const specifier = reference.expression ? stringValue(reference.expression) : undefined;
        if (specifier && isForbiddenModule(specifier)) report(node, `module:${specifier}`);
      }
    }

    if (ts.isImportTypeNode(node)) {
      const literal = unwrap(node.argument);
      if (ts.isLiteralTypeNode(literal)) {
        const specifier = stringValue(literal.literal);
        if (specifier && isForbiddenModule(specifier)) report(node, `module:${specifier}`);
      }
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = stringValue(node.arguments[0]);
        if (specifier && isForbiddenModule(specifier)) report(node, `dynamic-module:${specifier}`);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const specifier = stringValue(node.arguments[0]);
        if (specifier && isForbiddenModule(specifier)) report(node, `require:${specifier}`);
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const resolved = pathOf(node, constStrings);
      if (resolved) reportAccess(node, resolved);
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      FORBIDDEN_PROPERTY_NAMES.has(node.name.text)
    ) {
      report(node, `crypto.${node.name.text}`);
    }

    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const resolved = pathOf(node.initializer, constStrings);
      if (resolved) {
        const target = canonicalPath(resolved.path);
        for (const element of node.name.elements) {
          if (ts.isOmittedExpression(element)) continue;
          const propertyNode = element.propertyName ?? element.name;
          if (!ts.isIdentifier(propertyNode)) continue;
          const candidate = `${target}.${propertyNode.text}`;
          if (FORBIDDEN_PROPERTIES.has(candidate)) {
            report(node, `destructured(${candidate})`);
          } else if (target === GLOBAL_THIS && FORBIDDEN_GLOBALS.has(propertyNode.text)) {
            report(node, `destructured(global:${propertyNode.text})`);
          }
        }
      }
    }

    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      report(node, `global:${node.text}`);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}
