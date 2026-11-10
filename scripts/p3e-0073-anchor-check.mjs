/**
 * GPT-WORKBUDDY-DAYU-0073-A｜錨點一致性檢查。
 *
 * 重新渲染全部 28 個人物資產、重新量測錨點，再跟已提交的
 * `packages/ui/src/p3e-peep-anchors.ts` 逐欄位比對。用途：
 *
 *  - 換瀏覽器／換 Playwright 版本後，確認量測結果沒有漂移。
 *  - 有人手改錨點表時，立刻發現「表和真實圖對不上」。
 *  - 新增人物資產後，確認新資產真的有被量到（數量對得上）。
 *
 * 執行：`node scripts/p3e-0073-anchor-check.mjs`
 * 退出碼：0＝一致；1＝有漂移或資產數量不符。
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const committed = resolve(root, "packages/ui/src/p3e-peep-anchors.ts");
const fresh = resolve(root, ".artifacts/0073-anchors-check/p3e-peep-anchors.ts");
/** 允許誤差：同一份圖在不同瀏覽器版本上，getBBox 會有極小差異。 */
const TOLERANCE = 0.75;

await mkdir(resolve(root, ".artifacts/0073-anchors-check"), { recursive: true });

execFileSync(process.execPath, [resolve(root, "scripts/p3e-0073-peep-anchors.mjs")], {
  cwd: root,
  env: { ...process.env, P3E_ANCHORS_OUT: fresh },
  stdio: ["ignore", "ignore", "inherit"]
});

/** 把錨點表解析成 key → 欄位表（同名欄位用出現順序編號，例如 left[1]）。 */
function parseAnchors(source) {
  const table = new Map();
  for (const line of source.split("\n")) {
    // 錨點表一個資產一行：`  "male-a": Object.freeze({ ... }),`
    const head = /^ {2}"([^"]+)": Object\.freeze\(\{/.exec(line);
    if (head === null) continue;
    const seen = new Map();
    const fields = new Map();
    for (const field of line.matchAll(/([a-zA-Z]+): (-?\d+(?:\.\d+)?)/g)) {
      const name = field[1];
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      fields.set(`${name}[${count}]`, Number(field[2]));
    }
    table.set(head[1], fields);
  }
  return table;
}

const before = parseAnchors(await readFile(committed, "utf8"));
const after = parseAnchors(await readFile(fresh, "utf8"));

const problems = [];
if (before.size !== after.size) {
  problems.push(`asset count ${before.size} (committed) != ${after.size} (measured)`);
}
for (const [key, values] of before) {
  const measured = after.get(key);
  if (measured === undefined) {
    problems.push(`${key}: missing from fresh measurement`);
    continue;
  }
  for (const [field, value] of values) {
    const other = measured.get(field);
    if (other === undefined) {
      problems.push(`${key}.${field}: missing in fresh measurement`);
      continue;
    }
    if (Math.abs(other - value) > TOLERANCE) {
      problems.push(`${key}.${field}: committed=${value} measured=${other}`);
    }
  }
}

await rm(resolve(root, ".artifacts/0073-anchors-check"), { recursive: true, force: true });

if (problems.length > 0) {
  console.error(`P3E-0073-ANCHOR-CHECK FAIL assets=${before.size} problems=${problems.length}`);
  for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`P3E-0073-ANCHOR-CHECK OK assets=${before.size} tolerance=${TOLERANCE}`);
