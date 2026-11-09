/**
 * GPT-DEEPSEEK-0065-B｜獨立的 1,000-seed 等價檢查（不依賴 WorkBuddy 的測試）。
 *
 * 用兩個 public API 對同一個 seed 產生出生預覽，逐欄位比較：
 * - canonical：`prepareP3EBrowserBirthStage` ＋ `previewP3EBrowserBirthStage`
 *   （完整 P2-A／P2-B canonical validators 之後的路徑）；
 * - lite：`prepareP3EBirthLiteBundle`（讀 production bundle，只做輕量檢查）＋
 *   `previewP3EBirthLite`。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareP3EBrowserBirthStage, previewP3EBrowserBirthStage } from "../packages/application/src/p3e-browser-bootstrap.ts";
import { prepareP3EBirthLiteBundle, previewP3EBirthLite } from "../packages/application/src/p3e-birth-lite.ts";

const ROOT = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const base = {
  manifest: readJson("fixtures/p2a/manifest.v1.json"),
  datasets: {
    "country-registry": readJson("fixtures/p2a/country-registry.v1.json"),
    indicators: readJson("fixtures/p2a/indicators.v1.json"),
    "birth-weights": readJson("fixtures/p2a/birth-weights.v1.json"),
    "sensitive-names": readJson("fixtures/p2a/sensitive-names.v1.json"),
    licenses: readJson("fixtures/p2a/licenses.v1.json"),
    lineage: readJson("fixtures/p2a/lineage.v1.json")
  }
};
const identity = {
  manifest: readJson("fixtures/p2b/manifest.v1.json"),
  datasets: {
    "country-vitals": readJson("fixtures/p2b/country-vitals.v1.json"),
    "household-profiles": readJson("fixtures/p2b/household-profiles.v1.json"),
    "name-corpus": readJson("fixtures/p2b/name-corpus.v1.json"),
    "story-templates": readJson("fixtures/p2b/story-templates.v1.json"),
    licenses: readJson("fixtures/p2b/licenses.v1.json"),
    lineage: readJson("fixtures/p2b/lineage.v1.json")
  }
};

const stage = prepareP3EBrowserBirthStage({ base, identity });
const bundleText = readFileSync(join(ROOT, "fixtures/p3e/birth-bundle.v1.json"), "utf8");
const lite = prepareP3EBirthLiteBundle(bundleText);

const TOTAL = 1000;
let mismatches = 0;
const firstMismatches = [];

for (let index = 0; index < TOTAL; index += 1) {
  const seed = `p3e-0065b-${index}`;
  const canonical = JSON.stringify(previewP3EBrowserBirthStage({ stage, masterSeed: seed }));
  const fromBundle = JSON.stringify(previewP3EBirthLite({ stage: lite, masterSeed: seed }));
  if (canonical !== fromBundle) {
    mismatches += 1;
    if (firstMismatches.length < 3) firstMismatches.push({ seed, canonical: canonical.slice(0, 240), lite: fromBundle.slice(0, 240) });
  }
}

console.log(`DEEPSEEK-0065B-SEEDS total=${TOTAL} mismatches=${mismatches}`);
if (mismatches > 0) {
  console.error(JSON.stringify(firstMismatches, null, 2));
  process.exitCode = 1;
} else {
  console.log("DEEPSEEK-0065B-SEEDS-OK");
}
