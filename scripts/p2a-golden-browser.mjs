/**
 * 跨瀏覽器 golden：把 birth 模組打成 IIFE，分別在 Chromium 與 WebKit 執行同一組
 * seed，逐項比對 fixtures/p2a/golden-birth-vectors.v1.json。
 *
 * 用法：pnpm test:p2a-browser
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright";

const root = process.cwd();
const dir = join(root, "fixtures", "p2a");
const bundlePath = join(root, ".artifacts", "p2a-browser", "birth-browser.js");

const golden = JSON.parse(readFileSync(join(dir, "golden-birth-vectors.v1.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(dir, "manifest.v1.json"), "utf8"));
const datasets = {
  "country-registry": JSON.parse(readFileSync(join(dir, "country-registry.v1.json"), "utf8")),
  indicators: JSON.parse(readFileSync(join(dir, "indicators.v1.json"), "utf8")),
  "birth-weights": JSON.parse(readFileSync(join(dir, "birth-weights.v1.json"), "utf8")),
  "sensitive-names": JSON.parse(readFileSync(join(dir, "sensitive-names.v1.json"), "utf8")),
  licenses: JSON.parse(readFileSync(join(dir, "licenses.v1.json"), "utf8")),
  lineage: JSON.parse(readFileSync(join(dir, "lineage.v1.json"), "utf8"))
};

await build({
  entryPoints: [join(root, "packages", "birth", "src", "p2a-browser.ts")],
  bundle: true,
  format: "iife",
  globalName: "P2A",
  platform: "browser",
  target: "es2020",
  outfile: bundlePath,
  logLevel: "silent"
});

const cases = golden.cases.map((item) => ({ seed: item.seed, birthYear: item.birthYear, sexPolicy: item.sexPolicy }));

async function runOn(browserType, name) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    await page.addScriptTag({ path: bundlePath });
    const drafts = await page.evaluate(
      (payload) => window.P2A.runBirthCases({ manifest: payload.manifest, datasets: payload.datasets }, payload.cases),
      { manifest, datasets, cases }
    );
    let mismatches = 0;
    for (let index = 0; index < golden.cases.length; index += 1) {
      const expected = golden.cases[index];
      const actual = drafts[index];
      if (JSON.stringify(actual) !== JSON.stringify(expected.draft)) {
        mismatches += 1;
        console.error(`P2A-BROWSER-FAIL ${name} ${expected.id}`);
      }
    }
    const ok = mismatches === 0;
    console.log(`P2A-BROWSER-${ok ? "OK" : "FAIL"} ${name} ${drafts.length - mismatches}/${golden.cases.length}`);
    return ok;
  } finally {
    await browser.close();
  }
}

const chromiumOk = await runOn(chromium, "chromium");
const webkitOk = await runOn(webkit, "webkit");
if (!chromiumOk || !webkitOk) process.exitCode = 1;
