import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const fixture = JSON.parse(
  readFileSync(join(root, "packages", "engine", "test", "fixtures", "p1b-golden.json"), "utf8")
);
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><meta charset=\"utf-8\"><body></body>");
  await page.addScriptTag({ path: join(root, ".artifacts", "p1b-dist", "p1b-golden.js") });
  const actual = await page.evaluate((cases) => window.P1B.runGolden(cases), fixture.cases);
  let mismatches = 0;
  for (let i = 0; i < fixture.cases.length; i += 1) {
    const expected = fixture.cases[i];
    const got = actual[i];
    if (got.stateHash !== expected.expectedHash || JSON.stringify(got.commandHashes) !== JSON.stringify(expected.expectedCommandHashes)) {
      mismatches += 1;
      console.error(`GOLDEN-BROWSER-FAIL ${expected.id}`);
    }
  }
  console.log(`GOLDEN-BROWSER-${mismatches === 0 ? "OK" : "FAIL"} ${actual.length - mismatches}/${fixture.cases.length}`);
  if (mismatches !== 0) process.exitCode = 1;
} finally {
  await browser.close();
}
