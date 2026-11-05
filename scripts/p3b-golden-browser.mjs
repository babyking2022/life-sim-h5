import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright";

/**
 * P3-B 跨引擎 golden：把 `events/browser.ts` bundle 成 IIFE，
 * 在 Chromium 與 WebKit 重跑同一批案例，逐位元比對 Node 產生的 golden。
 */

const root = process.cwd();
const dir = join(root, "fixtures", "p3b");
const bundlePath = join(root, ".artifacts", "p3b-browser", "events-browser.js");
const golden = JSON.parse(readFileSync(join(dir, "golden-event-vectors.v1.json"), "utf8"));

await build({
  entryPoints: [join(root, "packages", "engine", "src", "life", "events", "browser.ts")],
  bundle: true,
  format: "iife",
  globalName: "P3B",
  platform: "browser",
  target: "es2020",
  outfile: bundlePath,
  logLevel: "silent"
});

const packs = golden.packs.map((section) => {
  const manifest = JSON.parse(readFileSync(join(dir, section.manifestFile), "utf8"));
  const dataset = JSON.parse(readFileSync(join(dir, section.eventsFile), "utf8"));
  return {
    section,
    payload: { manifest, events: dataset.records },
    cases: section.cases.map((entry) => ({
      id: entry.id,
      contentMode: entry.contentMode,
      state: entry.state,
      history: entry.history,
      rngState: entry.rngState
    }))
  };
});

function project(entry) {
  return {
    id: entry.id,
    candidateIds: entry.candidateIds,
    selectedEventId: entry.selectedEventId,
    reason: entry.reason,
    drawsUsed: entry.drawsUsed,
    rngStateAfter: entry.rngStateAfter,
    selectionHash: entry.selectionHash
  };
}

async function runOn(browserType, name) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    await page.addScriptTag({ path: bundlePath });
    let total = 0;
    let mismatches = 0;
    for (const pack of packs) {
      const digests = await page.evaluate(
        (payload) => window.P3B.runEventCases(payload.pack, payload.cases),
        { pack: pack.payload, cases: pack.cases }
      );
      for (let index = 0; index < pack.section.cases.length; index += 1) {
        total += 1;
        const expected = pack.section.cases[index];
        const actual = digests[index];
        if (JSON.stringify(actual) !== JSON.stringify(project(expected))) {
          mismatches += 1;
          console.error(`P3B-BROWSER-FAIL ${name} ${expected.id}`);
        }
      }
    }
    const ok = mismatches === 0;
    console.log(`P3B-BROWSER-${ok ? "OK" : "FAIL"} ${name} ${total - mismatches}/${total}`);
    return ok;
  } finally {
    await browser.close();
  }
}

const chromiumOk = await runOn(chromium, "chromium");
const webkitOk = await runOn(webkit, "webkit");
if (!chromiumOk || !webkitOk) process.exitCode = 1;
