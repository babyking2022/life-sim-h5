/**
 * GPT-WORKBUDDY-DAYU-0073-A｜真實 UI 截圖矩陣（不看圖片檔、只看真的頁面）。
 *
 * 目的：0073 的缺陷只在「真的畫在手機上」時才看得出來（人物被裁掉、眼鏡掉到
 * 脖子、拐杖浮空）。所以這裡用 `vite build --config vite.p1c.config.ts` 的產物，
 * 在真實瀏覽器裡跑一條完整人生，並在五個代表性年齡段截 `.p3e-scene`：
 *
 *   幼童 4／學生 8／青年 30／中年 48／老年 62
 *
 * 每個年齡段都跑 320×568、390×844、430×932 三種 viewport（同一頁只改視窗尺寸，
 * 不動遊戲狀態），確保 `contain` 在三個尺寸都不裁切人物。
 *
 * 產出：`.artifacts/0073-shots/<viewport>/<stage>-<age>.png` 與 `summary.json`
 *
 * 執行：`node scripts/p3e-0073-screenshots.mjs`
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, ".artifacts/p1c-dist");
const outDir = resolve(root, ".artifacts/0073-shots");
const SEED = "p3e-166-playable-runtime-v4";

const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
  ".png": "image/png"
});

/** 五個代表年齡；`stage` 只用來命名與報告。 */
const STAGES = Object.freeze([
  { stage: "child", age: 4 },
  { stage: "primary", age: 8 },
  { stage: "young", age: 30 },
  { stage: "middle", age: 48 },
  { stage: "senior", age: 62 }
]);
const VIEWPORTS = Object.freeze([
  { label: "320x568", width: 320, height: 568 },
  { label: "390x844", width: 390, height: 844 },
  { label: "430x932", width: 430, height: 932 }
]);

function staticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const target = resolve(dist, `.${requested}`);
      if (!target.startsWith(dist + sep)) throw new Error("outside dist");
      const body = await readFile(target);
      response.writeHead(200, {
        "content-type": MIME[extname(target)] ?? "application/octet-stream",
        "cache-control": "no-store"
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });
}

const server = staticServer();
const baseUrl = await new Promise((resolvePromise, rejectPromise) => {
  server.on("error", rejectPromise);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") rejectPromise(new Error("no port"));
    else resolvePromise(`http://127.0.0.1:${address.port}`);
  });
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();
await page.goto(`${baseUrl}/?seed=${encodeURIComponent(SEED)}&p3eReplay=official-golden`, { waitUntil: "networkidle" });

// 出生卡 → 開始人生。
const start = page.locator('[data-action="start-life"], [data-action="begin-life"]');
if ((await start.count()) === 0) throw new Error("birth card not found");
await start.first().click();
await page.waitForFunction(
  () => document.querySelector("[data-p3e-live='true']") !== null &&
    document.querySelector(".p3e-scene") !== null,
  undefined,
  { timeout: 30000 }
);

const results = [];
const readAge = () => page.evaluate(() => Number(
  document.querySelector(".p3e-scene")?.getAttribute("data-p3e-scene-age") ?? "-1"
));

/** 推進一步：待決策時選第一個選項，否則按「下一年」。 */
async function stepOnce() {
  const choose = page.locator('[data-action="choose"]');
  if ((await choose.count()) > 0) {
    await choose.first().click();
    return true;
  }
  const advance = page.locator('[data-action="advance"]');
  if ((await advance.count()) === 0) {
    // 死亡：沒有推進按鈕，也沒有決策可按 —— 這一條命結束了。
    await page.waitForTimeout(120);
    return false;
  }
  await advance.first().click();
  return true;
}

async function shoot(stage, age, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForTimeout(220);
  await mkdir(join(outDir, viewport.label), { recursive: true });
  const scene = page.locator(".p3e-scene").first();
  const file = join(outDir, viewport.label, `${stage}-${age}.png`);
  await scene.screenshot({ path: file });
  const metrics = await page.evaluate(() => {
    const node = document.querySelector(".p3e-scene");
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const found = /url\((?:"|')?([^"')]+)(?:"|')?\)/.exec(style.backgroundImage);
    const url = found?.[1] ?? "";
    let svg = "";
    if (url.startsWith("data:image/svg+xml,")) svg = decodeURIComponent(url.slice("data:image/svg+xml,".length));
    const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    const vbW = box === null ? 0 : Number(box[1]);
    const vbH = box === null ? 0 : Number(box[2]);
    const size = (style.backgroundSize.split(",")[0] ?? "").trim();
    const scale = size === "contain" ? Math.min(rect.width / vbW, rect.height / vbH)
      : (size === "cover" ? Math.max(rect.width / vbW, rect.height / vbH) : rect.width / vbW);
    // 從 SVG 直接讀每個角色圖層宣告的 bounds，換算成容器內的實際像素範圍。
    const actors = [...svg.matchAll(/<g data-layer="(player|partner)"[^>]*data-bounds="([^"]+)"/g)]
      .map((match) => {
        const [left, top, right, bottom] = match[2].split(",").map(Number);
        const offsetX = (rect.width - vbW * scale) / 2;
        const offsetY = rect.height - vbH * scale;
        return {
          role: match[1],
          left: offsetX + left * scale,
          top: offsetY + top * scale,
          right: offsetX + right * scale,
          bottom: offsetY + bottom * scale
        };
      });
    return {
      containerWidth: Math.round(rect.width),
      containerHeight: Math.round(rect.height),
      backgroundSize: size,
      scale: Number(scale.toFixed(4)),
      actorBoxes: actors.map((actor) => ({
        role: actor.role,
        left: Number(actor.left.toFixed(1)),
        top: Number(actor.top.toFixed(1)),
        right: Number(actor.right.toFixed(1)),
        bottom: Number(actor.bottom.toFixed(1)),
        // 是否被容器的左右／上下邊界裁掉（容差 1px）。
        clipped: actor.left < -1 || actor.right > rect.width + 1 ||
          actor.top < -1 || actor.bottom > rect.height + 1
      })),
      age: node.dataset.p3eSceneAge ?? null,
      lifeStage: node.dataset.p3eSceneLifeStage ?? null,
      partner: node.dataset.p3eSceneHasPartner ?? null,
      pet: node.dataset.p3eScenePet ?? null,
      asset: node.dataset.p3eScenePeeps ?? null,
      signature: node.dataset.p3eSceneSignature ?? null
    };
  });
  results.push({ stage, age, viewport: viewport.label, file: file.slice(root.length + 1), ...metrics });
  return metrics;
}

let guard = 0;
for (const { stage, age: target } of STAGES) {
  let age = await readAge();
  while (age < target && guard < 400) {
    const stepped = await stepOnce();
    if (stepped === false) {
      // 這條命在目標年齡前結束：記錄當下狀態，不再空轉。
      break;
    }
    await page.waitForTimeout(60);
    age = await readAge();
    guard += 1;
  }
  for (const viewport of VIEWPORTS) await shoot(stage, age, viewport);
  console.log(`${stage} age=${age} captured`);
}

await writeFile(
  join(outDir, "summary.json"),
  `${JSON.stringify({
    generatedBy: "scripts/p3e-0073-screenshots.mjs",
    seed: SEED,
    stages: STAGES,
    viewports: VIEWPORTS,
    shots: results.filter((entry) => entry.viewport !== undefined)
  }, null, 2)}\n`,
  "utf8"
);

const clipped = results.filter((entry) => (entry.actorBoxes ?? []).some((actor) => actor.clipped));
console.log(`P3E-0073-SHOTS shots=${results.length} clipped=${clipped.length}`);

await context.close();
await browser.close();
await new Promise((resolvePromise) => server.close(resolvePromise));
process.exit(clipped.length === 0 ? 0 : 1);
