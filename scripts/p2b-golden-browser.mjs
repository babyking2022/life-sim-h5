/**
 * P2-B 跨瀏覽器 golden：Chromium 與 WebKit 逐位元比對 108 組出生身分。
 *
 * 用法：pnpm test:p2b-browser
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright";

const root = process.cwd();
const baseDir = join(root, "fixtures", "p2a");
const identityDir = join(root, "fixtures", "p2b");
const bundlePath = join(root, ".artifacts", "p2b-browser", "identity-browser.js");

const golden = JSON.parse(readFileSync(join(identityDir, "golden-identity-vectors.v1.json"), "utf8"));

function readDir(dir, files) {
  const out = {};
  for (const file of files) out[file[0]] = JSON.parse(readFileSync(join(dir, file[1]), "utf8"));
  return out;
}

const base = {
  manifest: JSON.parse(readFileSync(join(baseDir, "manifest.v1.json"), "utf8")),
  datasets: readDir(baseDir, [
    ["country-registry", "country-registry.v1.json"],
    ["indicators", "indicators.v1.json"],
    ["birth-weights", "birth-weights.v1.json"],
    ["sensitive-names", "sensitive-names.v1.json"],
    ["licenses", "licenses.v1.json"],
    ["lineage", "lineage.v1.json"]
  ])
};
const identity = {
  manifest: JSON.parse(readFileSync(join(identityDir, "manifest.v1.json"), "utf8")),
  datasets: readDir(identityDir, [
    ["country-vitals", "country-vitals.v1.json"],
    ["household-profiles", "household-profiles.v1.json"],
    ["name-corpus", "name-corpus.v1.json"],
    ["story-templates", "story-templates.v1.json"],
    ["licenses", "licenses.v1.json"],
    ["lineage", "lineage.v1.json"]
  ])
};

await build({
  entryPoints: [join(root, "packages", "birth", "src", "p2b-browser.ts")],
  bundle: true,
  format: "iife",
  globalName: "P2B",
  platform: "browser",
  target: "es2020",
  outfile: bundlePath,
  logLevel: "silent"
});

const cases = golden.cases.map((item) => ({ seed: item.seed, sexPolicy: item.sexPolicy }));

async function runOn(browserType, name) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    await page.addScriptTag({ path: bundlePath });
    const identities = await page.evaluate(
      (payload) => window.P2B.runIdentityCases(payload.base, payload.identity, payload.cases),
      { base, identity, cases }
    );
    let mismatches = 0;
    for (let index = 0; index < golden.cases.length; index += 1) {
      const expected = golden.cases[index];
      const actual = identities[index];
      if (JSON.stringify(actual) !== JSON.stringify(expected.identity)) {
        mismatches += 1;
        console.error(`P2B-BROWSER-FAIL ${name} ${expected.id}`);
      }
    }
    const ok = mismatches === 0;
    console.log(`P2B-BROWSER-${ok ? "OK" : "FAIL"} ${name} ${identities.length - mismatches}/${golden.cases.length}`);
    return ok;
  } finally {
    await browser.close();
  }
}

const chromiumOk = await runOn(chromium, "chromium");
const webkitOk = await runOn(webkit, "webkit");
if (!chromiumOk || !webkitOk) process.exitCode = 1;
