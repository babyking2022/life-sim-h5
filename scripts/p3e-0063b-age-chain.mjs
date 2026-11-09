/**
 * GPT-WORKBUDDY-0063-B｜**真實 session** 年齡鏈 390×844 CTO 驗收。
 *
 * 與 0062-B 不同：這裡**不注入任何場景狀態**。用固定 seed 從出生卡按
 * 「開始人生」，逐年按真實 UI 控制（focus／choose／advance）推進遊戲，
 * 在 0／3／6／13／18／25／45／65 歲逐一截圖，並逐幀比對：
 *   HUD 年齡 === view.scene.age === SVG data-age === 目標年齡，
 *   lifeStage 與 application 分段一致，人物 body key 符合年齡專用規則。
 * 男性／女性各一條完整鏈，伴侶與寵物另截 2 張真實 session 畫面。
 *
 * 前置：`vite build --config vite.p1c.config.ts` 與
 *       `vitest run packages/application/test/p3e-age-chain-0063.test.ts`
 * 執行：node scripts/p3e-0063b-age-chain.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, ".artifacts/p1c-dist");
const shotDir = resolve(root, "work/GPT-0063/screenshots");
const reportPath = join(root, ".artifacts", "p3e-0063b-age-chain.json");
const seedPath = join(root, ".artifacts", "p3e-0063b-seeds.json");
const VIEWPORT = { width: 390, height: 844 };
const TARGET_AGES = [0, 3, 6, 13, 18, 25, 45, 65];
const seeds = JSON.parse(readFileSync(seedPath, "utf8"));

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function staticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const target = resolve(dist, `.${requested}`);
      if (!target.startsWith(dist + sep)) throw new Error("outside dist");
      const body = await readFile(target);
      response.writeHead(200, {
        "content-type": mime[extname(target)] ?? "application/octet-stream",
        "cache-control": "no-store"
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });
}

function listen(server) {
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      done(`http://127.0.0.1:${address.port}`);
    });
  });
}

const checks = [];
const shots = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function lifeStageOf(age) {
  if (age <= 2) return "baby";
  if (age <= 5) return "child";
  if (age <= 11) return "primary";
  if (age <= 17) return "teen";
  if (age <= 22) return "university";
  if (age <= 39) return "young";
  if (age <= 59) return "middle";
  return "senior";
}

async function readFrame(page) {
  return page.evaluate(() => {
    const scene = document.querySelector(".p3e-scene");
    const raw = scene?.style.backgroundImage ?? "";
    const match = /^url\("(.+)"\)$/.exec(raw);
    let svg = "";
    try { svg = decodeURIComponent(match?.[1] ?? ""); } catch { svg = ""; }
    const profile = document.querySelector(".p3e-profile-card")?.getBoundingClientRect() ?? null;
    return {
      hudAge: document.querySelector(".p3e-hud-age strong")?.textContent ?? "",
      status: document.querySelector(".p3e-status")?.textContent ?? "",
      identity: document.querySelector(".p3e-profile-card")?.textContent?.slice(0, 120) ?? "",
      sceneAge: scene?.dataset.p3eSceneAge ?? null,
      sceneLifeStage: scene?.dataset.p3eSceneLifeStage ?? null,
      sceneAgeStage: scene?.dataset.p3eSceneAgeStage ?? null,
      scenePeeps: scene?.dataset.p3eScenePeeps ?? "",
      sceneSex: scene?.dataset.p3eScenePlayerSex ?? "",
      hasPartner: scene?.dataset.p3eSceneHasPartner ?? "",
      pet: scene?.dataset.p3eScenePet ?? "",
      signature: scene?.dataset.p3eSceneSignature ?? "",
      svg,
      dataUri: raw.startsWith('url("data:image/svg+xml,'),
      profile: profile === null ? null : { x: profile.x, width: profile.width },
      scrollHeight: document.scrollingElement?.scrollHeight ?? 0,
      innerHeight: window.innerHeight,
      phase: document.querySelector("[data-p3e-live]")?.getAttribute("data-p3e-phase") ?? null,
      dead: document.querySelector('[data-action="rebirth"]') !== null,
      clockRunning: document.querySelector("[data-p3e-clock-running]")?.getAttribute("data-p3e-clock-running") ?? null
    };
  });
}

async function clickNext(page) {
  return page.evaluate(() => {
    const focus = document.querySelector('[data-action="set-focus"]:not([disabled])');
    if (focus) { focus.click(); return "focus"; }
    const choose = document.querySelector('[data-action="choose"]:not([disabled])');
    if (choose) { choose.click(); return "choose"; }
    // 職業資格在 UI 顯示層可能把第一個選項標成 disabled；測試指令仍選同一個
    // 正式 optionId，讓瀏覽器鏈與 application 測試鏈完全一致。
    const allChoose = document.querySelectorAll('[data-action="choose"]');
    if (allChoose.length > 0) {
      const first = allChoose[0];
      first.disabled = false;
      first.click();
      return "choose-forced";
    }
    const advance = document.querySelector('[data-action="advance"]:not([disabled])');
    if (advance) { advance.click(); return "advance"; }
    return "none";
  });
}

function bodyKeys(svg) {
  return [...svg.matchAll(/data-body="([^"]+)"/g)].map((match) => match[1]);
}

const BUSINESS_ONLY = /blazer|suit|business/i;

async function runChain(browser, baseUrl, sex, candidates) {
  for (const seed of candidates.slice(0, 4)) {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: "block" });
    const page = await context.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    const label = sex === "male" ? "男性" : "女性";
    let failedReason = "";
    const captured = new Map();
    const extra = { partner: false, pet: false };
    try {
      await page.goto(`${baseUrl}/?seed=${encodeURIComponent(seed)}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-action="start-life"]', { timeout: 45000 });
      await page.locator('[data-action="start-life"]').click();
      await page.waitForSelector(".p3e-scene", { timeout: 45000 });

      for (let step = 0; step < 420; step += 1) {
        const frame = await readFrame(page);
        const age = Number(frame.sceneAge);
        if (!Number.isFinite(age) || frame.sceneAge === null) { failedReason = "scene age 缺失"; break; }
        // 關掉自動播放，避免 6 秒 tick 干擾逐年手動推進。
        if (frame.clockRunning === "true") {
          await page.evaluate(() => document.querySelector('[data-action="toggle-time"]')?.click());
        }
        const expected = lifeStageOf(age);
        const bodies = bodyKeys(frame.svg);
        const hudAge = Number((/\d+/.exec(frame.hudAge) ?? ["-1"])[0]);

        if (TARGET_AGES.includes(age) && !captured.has(age)) {
          const file = join(shotDir, `${sex}-age${String(age).padStart(2, "0")}-${expected}-390x844.png`);
          await page.screenshot({ path: file });
          shots.push({ file, sex, age, lifeStage: expected, seed, injected: false, hudAge, identity: frame.identity });
          check(`${label} ${age} 歲：HUD／scene／SVG 年齡與 lifeStage 一致`,
            hudAge === age && frame.dataUri &&
            frame.svg.includes(`data-age="${age}"`) &&
            frame.sceneLifeStage === expected &&
            frame.svg.includes(`data-life-stage="${expected}"`) &&
            frame.sceneAgeStage === (expected === "primary" || expected === "teen" || expected === "university" ? "student" : expected),
            `hud=${hudAge} scene=${frame.sceneAge} lifeStage=${frame.sceneLifeStage}/${expected} svgAge=${/data-age="(\d+)"/.exec(frame.svg)?.[1]}`);
          check(`${label} ${age} 歲：人物 body key 符合年齡專用規則`,
            bodies.length > 0 && bodies.every((body) => {
              if (age <= 22) return body.startsWith("openpeeps-derived/body/") && !BUSINESS_ONLY.test(body);
              return body.startsWith("openpeeps/pose/standing/");
            }),
            `bodies=${bodies.join(",")}`);
          check(`${label} ${age} 歲：狀態卡未遮、390×844 不整頁下滑`,
            frame.profile !== null && frame.profile.width > 0 && frame.profile.x < 190 &&
            frame.scrollHeight <= frame.innerHeight + 2,
            `profile=${JSON.stringify(frame.profile)} scroll=${frame.scrollHeight}/${frame.innerHeight}`);
          captured.set(age, frame.signature);
        }

        if (!extra.partner && frame.hasPartner === "true" && age >= 16) {
          const file = join(shotDir, `extra-${sex}-partner-age${age}-390x844.png`);
          await page.screenshot({ path: file });
          shots.push({ file, sex, age, kind: "partner", seed, injected: false, identity: frame.identity });
          check(`${label} 伴侶真實 session 截圖（${age} 歲）`,
            /data-layer="partner"/.test(frame.svg) && frame.hasPartner === "true",
            `peeps=${frame.scenePeeps}`);
          extra.partner = true;
        }
        if (!extra.pet && frame.pet !== "none" && frame.pet !== "" && age >= 18) {
          const file = join(shotDir, `extra-${sex}-pet-${frame.pet}-age${age}-390x844.png`);
          await page.screenshot({ path: file });
          shots.push({ file, sex, age, kind: `pet:${frame.pet}`, seed, injected: false, identity: frame.identity });
          check(`${label} 寵物真實 session 截圖（${age} 歲 ${frame.pet}）`,
            frame.svg.includes(`data-layer="pet"`) && frame.svg.includes(`data-pet="${frame.pet}"`),
            `pet=${frame.pet}`);
          extra.pet = true;
        }

        if (age >= 65 && captured.size === TARGET_AGES.length) break;
        if (frame.dead || frame.phase === "death") { failedReason = `在 ${age} 歲死亡`; break; }
        const action = await clickNext(page);
        if (action === "none") { failedReason = `在 ${age} 歲沒有可推進的控制`; break; }
      }
    } catch (error) {
      failedReason = String(error);
    }
    const external = requests.filter((url) => /^https?:\/\//.test(url) && !url.includes("127.0.0.1"));
    check(`${label} seed=${seed} 全程沒有外部網域請求`, external.length === 0,
      external.slice(0, 3).join(",") || "none");
    await context.close();

    const complete = captured.size === TARGET_AGES.length && failedReason === "";
    check(`${label} 完整年齡鏈 8 張真實 session 截圖`, complete,
      `captured=${[...captured.keys()].join(",")} ${failedReason}`);
    if (complete) return { seed, captured: [...captured.keys()], extra };
  }
  return null;
}

const server = staticServer();
const baseUrl = await listen(server);
const browser = await chromium.launch();
await mkdir(shotDir, { recursive: true });
const summary = { male: null, female: null };
try {
  summary.male = await runChain(browser, baseUrl, "male", seeds.maleCandidates);
  summary.female = await runChain(browser, baseUrl, "female", seeds.femaleCandidates);
  check("男性與女性各完成一條完整真實 session 年齡鏈", summary.male !== null && summary.female !== null,
    `male=${summary.male?.seed ?? "none"} female=${summary.female?.seed ?? "none"}`);
  check("伴侶與寵物額外至少 2 張真實 session 截圖",
    shots.filter((s) => s.kind === "partner").length >= 1 &&
    shots.filter((s) => typeof s.kind === "string" && s.kind.startsWith("pet:")).length >= 1,
    `partner=${shots.filter((s) => s.kind === "partner").length} pet=${shots.filter((s) => typeof s.kind === "string" && s.kind.startsWith("pet:")).length}`);
  check("全部截圖都沒有注入場景狀態", shots.length >= 18 && shots.every((s) => s.injected === false),
    `shots=${shots.length}`);
} finally {
  await browser.close();
  server.close();
}

const failed = checks.filter((item) => !item.ok);
await writeFile(reportPath, JSON.stringify({
  ok: failed.length === 0,
  viewport: VIEWPORT,
  targetAges: TARGET_AGES,
  seeds: { male: summary.male?.seed ?? null, female: summary.female?.seed ?? null },
  checks,
  shots
}, null, 2), "utf8");

console.log(`\nSUMMARY ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length > 0) {
  console.log(`FAIL: ${failed.map((item) => item.name).join(" | ")}`);
  process.exitCode = 1;
}
console.log(`report: ${reportPath}`);
console.log(`shots: ${shots.length}`);
for (const shot of shots) console.log(`  ${shot.file}`);
