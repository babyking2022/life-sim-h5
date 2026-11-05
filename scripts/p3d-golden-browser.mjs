/**
 * P3-D 跨瀏覽器 golden：Chromium 與 WebKit 逐位元比對 108 組死亡判定 digest。
 *
 * 瀏覽器端會**自己重跑** `validateDataPack` ＋ `validateDeathPack`，因此除了
 * 每個死亡 digest，連 dataset checksum 與 manifest packChecksum 都必須與 Node 相同。
 *
 * 用法：pnpm test:p3d-browser
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright";

const root = process.cwd();
const p2aDir = join(root, "fixtures", "p2a");
const p3dDir = join(root, "fixtures", "p3d");
const bundlePath = join(root, ".artifacts", "p3d-browser", "death-browser.js");
const golden = JSON.parse(readFileSync(join(p3dDir, "golden-death-vectors.v1.json"), "utf8"));

const readJson = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

const base = {
  manifest: readJson(p2aDir, "manifest.v1.json"),
  datasets: {
    "country-registry": readJson(p2aDir, "country-registry.v1.json"),
    indicators: readJson(p2aDir, "indicators.v1.json"),
    "birth-weights": readJson(p2aDir, "birth-weights.v1.json"),
    "sensitive-names": readJson(p2aDir, "sensitive-names.v1.json"),
    licenses: readJson(p2aDir, "licenses.v1.json"),
    lineage: readJson(p2aDir, "lineage.v1.json")
  }
};

const death = {
  manifest: readJson(p3dDir, "manifest.v1.json"),
  datasets: {
    "cause-registry": readJson(p3dDir, "cause-registry.v1.json"),
    "cause-weights": readJson(p3dDir, "cause-weights.v1.json"),
    mortality: readJson(p3dDir, "mortality.v1.json"),
    licenses: readJson(p3dDir, "licenses.v1.json"),
    lineage: readJson(p3dDir, "lineage.v1.json")
  }
};

await build({
  entryPoints: [join(root, "packages", "birth", "src", "death", "browser.ts")],
  bundle: true,
  format: "iife",
  globalName: "P3D",
  platform: "browser",
  target: "es2020",
  outfile: bundlePath,
  logLevel: "silent"
});

const cases = golden.cases.map((item) => ({
  entityId: item.entityId,
  regionCode: item.regionCode,
  sex: item.sex,
  age: item.age,
  calendarYear: item.calendarYear,
  health: item.health,
  rngState: item.rngState
}));

const KEYS = [
  "digest",
  "baseHazardPpm",
  "adjustedHazardPpm",
  "healthFactorPpm",
  "died",
  "causeId",
  "mortalityDraw",
  "drawsUsed",
  "rngStateBefore",
  "rngStateAfter",
  "regionClass"
];

async function runOn(browserType, name) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    await page.addScriptTag({ path: bundlePath });
    const digests = await page.evaluate(
      (payload) => window.P3D.runDeathCases(payload.base, payload.death, payload.cases),
      { base, death, cases }
    );
    let mismatches = 0;
    for (let index = 0; index < golden.cases.length; index += 1) {
      const expected = golden.cases[index];
      const actual = digests[index];
      if (actual === undefined) {
        mismatches += 1;
        console.error(`P3D-BROWSER-FAIL ${name} ${expected.id} (missing)`);
        continue;
      }
      for (const key of KEYS) {
        const left = JSON.stringify(expected[key]);
        const right = JSON.stringify(actual[key]);
        if (left !== right) {
          mismatches += 1;
          console.error(`P3D-BROWSER-FAIL ${name} ${expected.id} ${key} expected=${left} got=${right}`);
          break;
        }
      }
    }
    const ok = mismatches === 0;
    console.log(`P3D-BROWSER-${ok ? "OK" : "FAIL"} ${name} ${digests.length - mismatches}/${golden.cases.length}`);
    return ok;
  } finally {
    await browser.close();
  }
}

const chromiumOk = await runOn(chromium, "chromium");
const webkitOk = await runOn(webkit, "webkit");
if (!chromiumOk || !webkitOk) process.exitCode = 1;
