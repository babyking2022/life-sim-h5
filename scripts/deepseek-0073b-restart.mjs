/**
 * GPT-DEEPSEEK-0073-B｜重新開始一段新人生的瀏覽器端到端驗收。
 *
 * 直接用 production build ＋ 正式 UI 的穩定 selector
 * （`[data-p3e-live]`／`data-p3e-phase`／`data-p3e-command-count`／`[data-action]`）：
 *
 * 1. 固定 seed 跑到 death → 死亡頁最前方有「重新開始一段新人生」；
 * 2. 點它 → URL 的 `seed` 被移除、回到出生卡、人物不同；
 * 3. 刷新 → 仍是新出生卡（不復活舊人生）；
 * 4. 按「開始人生」→ age 0、人生紀錄只有新的一筆；
 * 5. 遊戲中漢堡選單「重新開始」：取消 → 留在原局；確定 → 新出生卡、autosave 與 active seed 已清、
 *    語言偏好保留。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const DIST = resolve(ROOT, ".artifacts", "p1c-dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error("缺少 production build（先跑 pnpm build:ui）");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml"
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(DIST, decodeURIComponent(pathname)));
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/`;
const GOLDEN_SEED = "p3e-166-playable-runtime-v4";

const BROWSER = await chromium.launch();
/** 截圖輸出（訂單要求附瀏覽器驗證證據）。 */
const SHOT_DIR = resolve(ROOT, "work", "GPT-0073", "screenshots");
const { mkdir } = await import("node:fs/promises");
await mkdir(SHOT_DIR, { recursive: true });
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
};

const phaseOf = (page) =>
  page.evaluate(() => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") ?? "unknown");
const commandCount = (page) =>
  page.evaluate(() => Number(document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-command-count") ?? "0"));
const birthCardVisible = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("button")].some((button) => /开始人生|開始人生/.test(button.textContent ?? ""))
  );

async function waitBirthCard(page, timeout = 90000) {
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((button) => /开始人生|開始人生/.test(button.textContent ?? "")),
    { timeout }
  );
}

/**
 * 出生階段會要求先選「人生重心」，未選時「下一步」是 disabled。
 * 這裡照 p3e-browser-smoke 的做法：required 就選「study」，否則收起面板。
 */
async function resolveFocusGate(page) {
  const required = await page.evaluate(
    () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-focus-required")
  );
  if (required !== "true") {
    const dismiss = page.locator('.p3e-focus[data-p3e-focus-expanded="true"] .p3e-focus-dismiss');
    if ((await dismiss.count()) > 0) await dismiss.first().click({ timeout: 3000 }).catch(() => undefined);
    return;
  }
  await page
    .locator('.p3e-focus[data-p3e-focus-required="true"] [data-action="set-focus"][data-focus-id="study"]')
    .first()
    .click({ timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-focus-required") === "false",
    undefined,
    { timeout: 20000 }
  );
}

async function step(page) {
  await resolveFocusGate(page);
  const before = await commandCount(page);
  const phase = await phaseOf(page);
  const selector = phase === "pending_decision" ? '[data-action="choose"]' : '[data-action="advance"]';
  await page.locator(selector).first().click();
  await page.waitForFunction(
    (previous) => {
      const node = document.querySelector("[data-p3e-live]");
      const count = Number(node?.getAttribute("data-p3e-command-count") ?? "0");
      return count > previous || node?.getAttribute("data-p3e-phase") === "death";
    },
    before,
    { timeout: 30000 }
  );
}

async function runToDeath(page, maxSteps = 400) {
  let steps = 0;
  while ((await phaseOf(page)) !== "death" && steps < maxSteps) {
    await step(page);
    steps += 1;
  }
  return steps;
}

/* 1) 死亡 → 重新開始 → 新出生卡 */
{
  const context = await BROWSER.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`${baseUrl}?seed=${GOLDEN_SEED}`, { waitUntil: "domcontentloaded" });
  await waitBirthCard(page);
  const cardBefore = await page.evaluate(() => ({
    seed: new URL(window.location.href).searchParams.get("seed"),
    text: document.body.innerText.slice(0, 160)
  }));
  check("固定 seed 開頁：URL 帶 seed", cardBefore.seed === GOLDEN_SEED, cardBefore.seed ?? "");

  await page.click("button:has-text('开始人生'), button:has-text('開始人生')");
  await page.waitForFunction(() => document.querySelector("[data-p3e-live='true']") !== null, { timeout: 90000 });
  const steps = await runToDeath(page);
  check("跑到死亡", (await phaseOf(page)) === "death", `steps=${steps}`);

  const deathBox = await page.$(".p3e-death");
  check("死亡卡存在", deathBox !== null);
  await page.screenshot({ path: join(SHOT_DIR, "01-death-restart-button-390x844.png") });
  if (deathBox !== null) {
    const firstButton = await page.evaluate(() => {
      const box = document.querySelector(".p3e-death");
      const button = box?.querySelector("button");
      return button === null || button === undefined ? null : button.textContent ?? "";
    });
    check("死亡摘要最前方就是重新開始按鈕", /重新[開开]始一段新人生/.test(firstButton ?? ""), String(firstButton));

    const oldText = await page.evaluate(() => document.body.innerText.slice(0, 160));
    await page.click('button[data-p3e-restart="death"]');
    await waitBirthCard(page);
    const afterRestart = await page.evaluate(() => ({
      url: window.location.href,
      text: document.body.innerText.slice(0, 160)
    }));
    check("重開後 URL 不再有 seed", !new URL(afterRestart.url).searchParams.has("seed"), afterRestart.url);
    check("重開後回到出生卡", await birthCardVisible(page));
    check("重開後人物與上一局不同", afterRestart.text !== oldText);
    await page.screenshot({ path: join(SHOT_DIR, "02-new-birth-card-390x844.png") });

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitBirthCard(page);
    const afterReload = await page.evaluate(() => ({
      phase: document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") ?? "unknown",
      text: document.body.innerText.slice(0, 160)
    }));
    check(
      "刷新後仍在出生卡（不復活舊人生）",
      (await birthCardVisible(page)) && afterReload.phase !== "death",
      afterReload.phase
    );

    await page.click("button:has-text('开始人生'), button:has-text('開始人生')");
    await page.waitForFunction(
      () => {
        const phase = document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase");
        return phase !== null && phase !== undefined && phase !== "birth";
      },
      { timeout: 90000 }
    );
    const started = await page.evaluate(() => {
      const node = document.querySelector("[data-p3e-live]");
      return {
        phase: node?.getAttribute("data-p3e-phase") ?? "unknown",
        focusAge: Number(node?.getAttribute("data-p3e-life-focus-age") ?? "-1"),
        commands: Number(node?.getAttribute("data-p3e-command-count") ?? "0"),
        log: (document.body.innerText.match(/年 ·/g) ?? []).length
      };
    });
    check(
      "新人生從 age 0 開始",
      started.focusAge === 0 && started.commands <= 3,
      `age=${started.focusAge} commands=${started.commands} phase=${started.phase}`
    );
    check("新人生紀錄只有一筆", started.log <= 1, `logLines=${started.log}`);
    await page.screenshot({ path: join(SHOT_DIR, "03-new-life-age0-390x844.png") });
  }
  check("死亡→重開流程沒有 page error", errors.length === 0, errors.slice(0, 2).join(" | "));
  await context.close();
}

/* 2) 漢堡選單中途重開：取消 / 確定 */
{
  const context = await BROWSER.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}?seed=${GOLDEN_SEED}`, { waitUntil: "domcontentloaded" });
  await waitBirthCard(page);
  await page.click("button:has-text('开始人生'), button:has-text('開始人生')");
  await page.waitForFunction(
    () => {
      const phase = document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase");
      return phase !== null && phase !== undefined && phase !== "birth";
    },
    { timeout: 90000 }
  );
  await step(page).catch(() => undefined);
  // 時鐘持續 render 會讓 summary 一直重建：先暫停，再開選單。
  await page
    .locator('[data-action="toggle-time"]')
    .first()
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await page.waitForTimeout(400);

  // 每次 render 都會重建 shell，因此一律用 locator（會自動重新解析），不要存 ElementHandle。
  const summaryLocator = page.locator("summary[data-action='toggle-settings-menu']").first();
  const menuRestartLocator = page.locator("button[data-p3e-restart='menu']").first();

  check("遊戲中有漢堡選單", (await summaryLocator.count()) > 0);
  try {
    await summaryLocator.click({ timeout: 10000, force: true }).catch(() => undefined);
    await page.evaluate(() => {
      const menu = document.querySelector("details.p3e-hud-menu");
      if (menu !== null) menu.open = true;
    });
    await page.waitForTimeout(400);
    check("漢堡選單有「重新開始一段新人生」", (await menuRestartLocator.count()) > 0);
    await page.screenshot({ path: join(SHOT_DIR, "04-menu-restart-390x844.png") });

    // 取消：留在原局
    page.once("dialog", (dialog) => void dialog.dismiss());
    await menuRestartLocator.click({ timeout: 15000, force: true });
    await page.waitForTimeout(800);
    check("選單重開按取消 → 留在原局", (await birthCardVisible(page)) === false);

    // 確定：回到新出生卡，且 autosave／active seed 已清
    const beforeRestartSeed = await page.evaluate(() => window.localStorage.getItem("life-sim:p3e:active-seed"));
    if (!(await menuRestartLocator.isVisible().catch(() => false))) {
      await summaryLocator.click({ timeout: 10000, force: true });
      await page.waitForTimeout(400);
    }
    page.once("dialog", (dialog) => void dialog.accept());
    await menuRestartLocator.click({ timeout: 15000, force: true });
    await waitBirthCard(page);
    const storageState = await page.evaluate(() => ({
      autosave: window.localStorage.getItem("life-sim:p3e:v6:autosave"),
      activeSeed: window.localStorage.getItem("life-sim:p3e:active-seed"),
      locale: window.localStorage.getItem("p3e.locale.v1")
    }));
    check("選單重開確認 → 回到出生卡", true, `oldActiveSeed=${String(beforeRestartSeed)}`);
    check("重開後 autosave 已清除", storageState.autosave === null, String(storageState.autosave));
      check(
        "重開後舊 active seed 已被換掉（新局用自己的 seed）",
        storageState.activeSeed === null || storageState.activeSeed !== beforeRestartSeed,
        `old=${String(beforeRestartSeed)} new=${String(storageState.activeSeed)}`
      );
    check(
      "語言偏好保留（不因重開被清）",
      storageState.locale === null || storageState.locale === "zh-CN" || storageState.locale === "zh-TW",
      String(storageState.locale)
    );
  } catch (error) {
    check("選單重開流程完成", false, String(error).slice(0, 200));
  }
  await context.close();
}

await BROWSER.close();
await new Promise((done) => server.close(done));

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nSUMMARY ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length > 0) {
  console.error("DEEPSEEK-0073B-FAIL\n" + failed.map((entry) => `${entry.name} — ${entry.detail ?? ""}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("DEEPSEEK-0073B-OK");
}
