import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright";

/**
 * P3-C 跨引擎 golden：把 `packages/application/src/p3c-browser.ts` bundle 成 IIFE，
 * 在 Chromium 與 WebKit 重跑同一批案例（兩個 pack section），逐位元比對 Node 產生的 golden。
 *
 * 這同時證明：事件抽選、effects 套用、occurrence 更新、selectionHash 與 stateHash
 * 在三個引擎（Node／Chromium／WebKit）完全一致。
 */

const root = process.cwd();
const bundlePath = join(root, ".artifacts", "p3c-browser", "event-life-browser.js");
const golden = JSON.parse(readFileSync(join(root, "fixtures", "p3c", "golden-event-life-vectors.v1.json"), "utf8"));

function readDir(dir, files) {
  const out = {};
  for (const [key, file] of files) out[key] = JSON.parse(readFileSync(join(dir, file), "utf8"));
  return out;
}

const baseDir = join(root, "fixtures", "p2a");
const identityDir = join(root, "fixtures", "p2b");
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

/** section id → pack 檔案位置。 */
const SECTION_FILES = {
  "p3b-main": join(root, "fixtures", "p3b"),
  "p3c-fixture": join(root, "fixtures", "p3c")
};

await build({
  entryPoints: [join(root, "packages", "application", "src", "p3c-browser.ts")],
  bundle: true,
  format: "iife",
  globalName: "P3C",
  platform: "browser",
  target: "es2020",
  outfile: bundlePath,
  logLevel: "silent"
});

const sections = golden.sections.map((section) => {
  const dir = SECTION_FILES[section.id];
  const manifest = JSON.parse(readFileSync(join(dir, section.manifestFile), "utf8"));
  const dataset = JSON.parse(readFileSync(join(dir, section.eventsFile), "utf8"));
  return {
    section,
    payload: { manifest, events: dataset.records },
    cases: section.cases.map((entry) => ({
      seed: entry.seed,
      playerSexPolicy: entry.playerSexPolicy,
      years: entry.years,
      optionPolicy: entry.optionPolicy
    }))
  };
});

const DIGEST_KEYS = [
  "certificateHash",
  "masterSeedHash",
  "birthYear",
  "age",
  "phase",
  "stateHash",
  "hashChain",
  "commandCount",
  "entries",
  "snapshots",
  "cards",
  "eventRecords",
  "selectedEvents",
  "eventsRngDraws",
  "eventsRngInitialState",
  "eventsRngState",
  "occurrenceDigest",
  "occurrences",
  "lastEntryHash",
  "lastSnapshotHash",
  "lastDeltaHash",
  "cardsTotal",
  "cardsSeen",
  "playbackMode",
  "eventTrail",
  "selectionTrailDigest"
];

function project(entry) {
  const out = {};
  for (const key of DIGEST_KEYS) out[key] = entry[key];
  return out;
}

async function runOn(browserType, name) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    await page.addScriptTag({ path: bundlePath });
    let total = 0;
    let mismatches = 0;
    for (const section of sections) {
      const digests = await page.evaluate(
        (payload) => window.P3C.runEventLifeCases(payload.base, payload.identity, payload.pack, payload.cases),
        { base, identity, pack: section.payload, cases: section.cases }
      );
      for (let index = 0; index < section.section.cases.length; index += 1) {
        total += 1;
        const expected = section.section.cases[index];
        const actual = digests[index];
        if (JSON.stringify(actual) !== JSON.stringify(project(expected))) {
          mismatches += 1;
          console.error(`P3C-BROWSER-FAIL ${name} ${expected.id}`);
          console.error(`  actual  : ${JSON.stringify(actual).slice(0, 300)}`);
          console.error(`  expected: ${JSON.stringify(project(expected)).slice(0, 300)}`);
        }
      }
    }
    const ok = mismatches === 0;
    console.log(`P3C-BROWSER-${ok ? "OK" : "FAIL"} ${name} ${total - mismatches}/${total}`);
    return ok;
  } finally {
    await browser.close();
  }
}

const chromiumOk = await runOn(chromium, "chromium");
const webkitOk = await runOn(webkit, "webkit");
if (!chromiumOk || !webkitOk) process.exitCode = 1;
