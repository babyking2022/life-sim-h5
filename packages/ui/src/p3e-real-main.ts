import {
  clearP3EBrowserAutosaveSession,
  createP3EBrowserSession,
  exportP3EBrowserPortableSave,
  prepareP3EBrowserWorld,
  restoreP3EBrowserAutosaveSession,
  restoreP3EBrowserPortableSave,
  runP3EPlaySessionCommand,
  saveP3EBrowserAutosaveSession,
  type P3EBrowserWorld,
  type P3EPlaySession
} from "@life-sim/application";
import { createLifeClock, type Speed } from "./p3e-time-controller.js";

/**
 * H5-CTO-176-A／H5-CTO-188-A：真實 P3-E runtime 的瀏覽器垂直切片＋autosave。
 *
 * 預設路徑（沒有 `?preview=fixture`）就是這支程式：用**正式的 application
 * session／view** 玩一條命，從出生、逐年推進、待決策選擇，到死亡與重生；
 * 每一次成功命令之後都會把正式 raw V6 envelope 寫進 `window.localStorage`，
 * 重新整理後由正式 orchestrator restore（decode → replay → canonical 比對）。
 *
 * - 所有 pack 只驗證一次（`prepareP3EBrowserWorld`），每條命重用已驗證 pack；
 * - 遊戲狀態只存在本模組的 `session` 變數（沒有全域 current state、沒有假造事件）；
 * - 畫面只從 `session.view` 渲染；金錢維持 base10 字串，不轉 number；
 * - seed 固定常數或 `?seed=` 驗證後的值，不使用 Date／Math.random／crypto；
 * - localStorage 只在 UI 取得且包在 try/catch；存取失敗一律降級為
 *   ephemeral（可玩、不中斷）並顯示非阻塞警告；
 * - 壞存檔／錯 seed 不靜默刪除，一律顯示恢復動作（由使用者明確清除）。
 */

/* ------------------------------------------------------------------ */
/* fixtures（以 URL 形式載入，避免把 3MB pack 打進初始 JS）                 */
/* ------------------------------------------------------------------ */

const PACK_URLS = {
  p2aManifest: new URL("../../../fixtures/p2a/manifest.v1.json", import.meta.url).href,
  p2aCountryRegistry: new URL("../../../fixtures/p2a/country-registry.v1.json", import.meta.url).href,
  p2aIndicators: new URL("../../../fixtures/p2a/indicators.v1.json", import.meta.url).href,
  p2aBirthWeights: new URL("../../../fixtures/p2a/birth-weights.v1.json", import.meta.url).href,
  p2aSensitiveNames: new URL("../../../fixtures/p2a/sensitive-names.v1.json", import.meta.url).href,
  p2aLicenses: new URL("../../../fixtures/p2a/licenses.v1.json", import.meta.url).href,
  p2aLineage: new URL("../../../fixtures/p2a/lineage.v1.json", import.meta.url).href,
  p2bManifest: new URL("../../../fixtures/p2b/manifest.v1.json", import.meta.url).href,
  p2bCountryVitals: new URL("../../../fixtures/p2b/country-vitals.v1.json", import.meta.url).href,
  p2bHouseholdProfiles: new URL("../../../fixtures/p2b/household-profiles.v1.json", import.meta.url).href,
  p2bNameCorpus: new URL("../../../fixtures/p2b/name-corpus.v1.json", import.meta.url).href,
  p2bStoryTemplates: new URL("../../../fixtures/p2b/story-templates.v1.json", import.meta.url).href,
  p2bLicenses: new URL("../../../fixtures/p2b/licenses.v1.json", import.meta.url).href,
  p2bLineage: new URL("../../../fixtures/p2b/lineage.v1.json", import.meta.url).href,
  p3bManifest: new URL("../../../fixtures/p3b/manifest.v1.json", import.meta.url).href,
  p3bEvents: new URL("../../../fixtures/p3b/events.v1.json", import.meta.url).href,
  p3dManifest: new URL("../../../fixtures/p3d/manifest.v1.json", import.meta.url).href,
  p3dCauseRegistry: new URL("../../../fixtures/p3d/cause-registry.v1.json", import.meta.url).href,
  p3dCauseWeights: new URL("../../../fixtures/p3d/cause-weights.v1.json", import.meta.url).href,
  p3dMortality: new URL("../../../fixtures/p3d/mortality.v1.json", import.meta.url).href,
  p3dLicenses: new URL("../../../fixtures/p3d/licenses.v1.json", import.meta.url).href,
  p3dLineage: new URL("../../../fixtures/p3d/lineage.v1.json", import.meta.url).href
} as const;

const DEFAULT_SEED = "p3e-166-playable-runtime-v4";
const SEED_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

type TabKey = "life" | "family" | "work" | "map";

/** autosave 狀態（對應 `data-p3e-persistence-status`）。 */
type PersistenceStatus =
  | "restored"
  | "saved"
  | "saving"
  | "missing"
  | "unavailable"
  | "save-error"
  | "restore-error"
  | "cleared"
  | "ephemeral";

/* ------------------------------------------------------------------ */
/* 模組狀態（只有 session；沒有全域遊戲狀態）                              */
/* ------------------------------------------------------------------ */

let world: P3EBrowserWorld | null = null;
let session: P3EPlaySession | null = null;
let activeTab: TabKey = "life";
let busy = false;
let focusAdvanceAfterRender = false;
let fastForwarding = false;

/** UI 取得的最小儲存能力；null 代表不可用（ephemeral 模式）。 */
let storage: Storage | null = null;
let persistenceStatus: PersistenceStatus = "missing";
let persistenceError: string | null = null;
/** true 表示存檔損壞／seed 不符；使用者必須明確按「清除並重新開始」。 */
let recoveryNeeded = false;
/** false 表示目前的命不寫入 autosave（restore 失敗的保護狀態）。 */
let persistenceEnabled = true;
/** 每次成功提交 session 就 +1；dataset 只暴露這個單調序號。 */
let persistenceGeneration = 0;
/** 已排程的 idle flush handle（同時只能有一個；coalescing 靠這個）。 */
let saveHandle: number | null = null;
/** 最近一次成功寫入的 generation；較舊的 flush 不得覆寫。 */
let savedGeneration = -1;
/** 最近一次 portable 匯出的「檔名|MIME」字串（只作 UI 狀態，供 E2E 觀察）。 */
let lastExport: string | null = null;
/** 最近一次 portable 匯入結果（ok／error／null；只作 UI 狀態）。 */
let lastImport: "ok" | "error" | null = null;

const PORTABLE_FILENAME = "life-sim-p3e-v6.json";
const PORTABLE_MIME = "application/json";

const app: HTMLDivElement = (() => {
  const found = document.querySelector<HTMLDivElement>("#app");
  if (found === null) throw new Error("missing #app");
  return found;
})();

const lifeClock = createLifeClock({
  baseIntervalMs: 6000,
  initialSpeed: 1,
  onTick: async () => {
    if (session?.view.controls.canAdvanceYear === true) advanceYear();
    else lifeClock.pause();
  },
  onStateChange: () => {
    if (session !== null && !busy) render();
  }
});
// 世界資料載入前先停住；boot 完成後才開始推進正式 session。
lifeClock.pause();

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readSeed(): string {
  const raw = new URLSearchParams(window.location.search).get("seed");
  return raw !== null && SEED_PATTERN.test(raw) ? raw : DEFAULT_SEED;
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; path?: unknown; message?: unknown };
    if (typeof record.code === "string") {
      return typeof record.path === "string" ? `${record.code} at ${record.path}` : record.code;
    }
    if (typeof record.message === "string") return record.message;
  }
  return "E_UNKNOWN";
}

function formatMicroUsd(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  if (!/^\d+$/.test(digits)) return value;
  const padded = digits.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = padded.slice(-6, -4);
  return `${negative ? "-" : ""}$${whole}.${cents}`;
}

function ageStage(age: number): { label: string; icon: string } {
  if (age <= 2) return { label: "嬰兒", icon: "👶" };
  if (age <= 12) return { label: "童年", icon: "🧒" };
  if (age <= 17) return { label: "少年", icon: "🧑" };
  if (age <= 39) return { label: "青年", icon: "🧑" };
  if (age <= 64) return { label: "中年", icon: "🧔" };
  return { label: "晚年", icon: "🧓" };
}

const DISPLAY_TEXT: Readonly<Record<string, string>> = {
  "ev.adult.burnout": "工作帶來了倦怠感",
  "ev.adult.debt-scare": "債務壓力突然逼近",
  "ev.adult.first-salary": "領到人生第一份薪水",
  "ev.adult.housing-choice": "面臨居住安排的重要選擇",
  "ev.adult.promotion": "在工作上獲得晉升",
  "ev.adult.volunteer": "參加了一次志工活動",
  "ev.any.quiet-year": "平靜地度過了一年",
  "ev.any.setback": "遇到了一次挫折",
  "ev.any.small-win": "收穫了一個小小的成功",
  "ev.child.first-word": "說出了人生第一句話",
  "ev.child.playground": "在遊樂場交到了新朋友",
  "ev.child.school-choice": "面臨入學方式的選擇",
  "ev.child.sibling-arrives": "家裡迎來了新的手足",
  "ev.child.tantrum": "因為不順心而大哭了一場",
  "ev.guardian.calm": "在家人的照顧下平靜成長",
  "ev.senior.health-check": "完成了一次健康檢查",
  "ev.senior.reflection": "回望自己走過的人生",
  "ev.teen.exams": "迎來了一場重要考試",
  "ev.teen.friendship": "交到了一位知心朋友",
  "ev.teen.major-choice": "面臨未來方向的重要選擇",
  "ev.teen.part-time-job": "開始了人生第一份打工",
  "ev.teen.risk-experiment": "嘗試了一次冒險",
  "p3b.decision.adult.housing": "你要怎麼安排接下來的住處？",
  "p3b.decision.child.school": "你希望選擇哪一種學習方式？",
  "p3b.decision.teen.path": "高中階段結束了，下一步要怎麼走？",
  "p3b.option.adult.housing.rent": "先租房，換取自己的生活空間",
  "p3b.option.adult.housing.save": "暫時不搬，把錢存下來",
  "p3b.option.child.school.bold": "選擇更多元、充滿挑戰的學習環境",
  "p3b.option.child.school.steady": "選擇穩定、按部就班的學習環境",
  "p3b.option.teen.path.rest": "先休息一年，重新思考方向",
  "p3b.option.teen.path.study": "繼續升學，累積知識",
  "p3b.option.teen.path.work": "開始工作，累積實務經驗"
};

function friendlyKey(value: string): string {
  const translated = DISPLAY_TEXT[value];
  if (translated !== undefined) return translated;
  return value.replace(/^event[._-]?/i, "").replace(/[._-]+/g, " ").trim() || "平凡的一年";
}

/* ------------------------------------------------------------------ */
/* 持久化（localStorage 只在 UI 取得、且全部包在 try/catch）               */
/* ------------------------------------------------------------------ */

function acquireStorage(): Storage | null {
  try {
    const candidate = window.localStorage;
    return typeof candidate === "object" && candidate !== null ? candidate : null;
  } catch {
    return null;
  }
}

/** 同步寫入目前 session（boot／flush／pagehide／恢復）；失敗只降級、不回滾命令。 */
function persistCurrentSession(): boolean {
  if (storage === null || session === null || !persistenceEnabled) return false;
  if (persistenceGeneration < savedGeneration) return false; // 舊 flush 不得覆寫較新的存檔
  const generation = persistenceGeneration;
  try {
    saveP3EBrowserAutosaveSession({ storage, session });
    persistenceStatus = "saved";
    persistenceError = null;
    savedGeneration = generation;
    return true;
  } catch (error) {
    persistenceStatus = "save-error";
    persistenceError = describeError(error);
    return false;
  }
}

/** 取消已排程的 idle flush（恢復／重生前呼叫，避免 stale write）。 */
function cancelScheduledSave(): void {
  if (saveHandle === null) return;
  if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(saveHandle);
  else window.clearTimeout(saveHandle);
  saveHandle = null;
}

/** 空閒時寫入「目前最新的 session」；較舊的 flush 一律丟棄。 */
function flushAutosave(): void {
  saveHandle = null;
  if (persistenceGeneration < savedGeneration) {
    return;
  }
  if (persistCurrentSession() || persistenceStatus === "save-error") updatePersistenceDom();
}

/**
 * 排程一次 idle autosave（單一 writer、coalescing）。
 *
 * 命令路徑只 commit＋render，然後呼叫這個函式；實際 encode＋localStorage
 * 寫入延後到 requestIdleCallback（fallback setTimeout 0）。連續命令只會保留
 * 最新 session，flush 時寫的永遠是目前最新狀態。
 */
function scheduleAutosave(): void {
  if (storage === null || session === null || !persistenceEnabled) return;
  persistenceStatus = "saving";
  if (saveHandle !== null) return;
  const run = (): void => flushAutosave();
  if (typeof window.requestIdleCallback === "function") {
    saveHandle = window.requestIdleCallback(run, { timeout: 200 });
  } else {
    saveHandle = window.setTimeout(run, 0);
  }
}

/** pagehide／visibilitychange 用的同步 flush（只寫最新 session）。 */
function flushAutosaveNow(): void {
  cancelScheduledSave();
  if (storage === null || session === null || !persistenceEnabled) return;
  persistCurrentSession();
  updatePersistenceDom();
}

/* ------------------------------------------------------------------ */
/* 可攜式存檔檔（下載／上傳；與 autosave 的 1 MiB 限制無關）              */
/* ------------------------------------------------------------------ */

/** 匯出目前 session 為 canonical raw V6 envelope，觸發瀏覽器下載。 */
function downloadPortableSave(): void {
  if (session === null) return;
  let url: string | null = null;
  try {
    const raw = exportP3EBrowserPortableSave({ session });
    const blob = new Blob([raw], { type: PORTABLE_MIME });
    url = URL.createObjectURL(blob);
    const anchor = element("a");
    anchor.href = url;
    anchor.download = PORTABLE_FILENAME;
    anchor.rel = "noopener";
    app.append(anchor);
    anchor.click();
    anchor.remove();
    lastExport = `${PORTABLE_FILENAME}|${PORTABLE_MIME}`;
    persistenceError = null;
  } catch (error) {
    showAlert(describeError(error));
  } finally {
    if (url !== null) URL.revokeObjectURL(url);
    render();
  }
}

/**
 * 從使用者選取的檔案還原 session。
 *
 * 只有正式 `restoreP3EBrowserPortableSave` 成功才替換 session；失敗時目前
 * session 逐位元不變，只顯示受控錯誤。成功後取消 stale autosave、替換
 * session、重新排程存檔並 render。
 */
function importPortableSaveFile(file: File): void {
  if (world === null || session === null) return;
  void file
    .arrayBuffer()
    .then((buffer) => {
      try {
        const restored = restoreP3EBrowserPortableSave({
          world,
          masterSeed: readSeed(),
          data: new Uint8Array(buffer)
        });
        cancelScheduledSave();
        session = restored;
        persistenceGeneration += 1;
        alertText = null;
        persistenceError = null;
        if (storage !== null && persistenceEnabled) persistenceStatus = "saving";
        lastImport = "ok";
        scheduleAutosave();
        render();
      } catch (error) {
        lastImport = "error";
        showAlert(describeError(error));
        render();
      }
    })
    .catch((error: unknown) => {
      lastImport = "error";
      showAlert(describeError(error));
      render();
    });
}
/** 明確清除 autosave（恢復動作／重生）；失敗原樣拋給呼叫端處理。 */
function clearAutosave(): void {
  if (storage === null) return;
  clearP3EBrowserAutosaveSession({ storage });
}

/**
 * 使用者明確觸發的恢復：先清除壞存檔，再開新的一命並存檔。
 * 只有這個動作會刪除既有 autosave（壞存檔／錯 seed 不靜默刪除）。
 */
function recoverAutosave(): void {
  if (busy || world === null || storage === null) return;
  busy = true;
  try {
    cancelScheduledSave();
    clearAutosave();
    persistenceEnabled = true;
    recoveryNeeded = false;
    persistenceError = null;
    session = startLife(readSeed());
    persistenceGeneration += 1;
    persistenceStatus = "cleared";
    persistCurrentSession();
    focusAdvanceAfterRender = true;
  } catch (error) {
    persistenceStatus = "save-error";
    persistenceError = describeError(error);
  } finally {
    busy = false;
    render();
  }
}

/* ------------------------------------------------------------------ */
/* 資料載入（pack 只驗證一次）                                           */
/* ------------------------------------------------------------------ */

async function loadJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
  return response.json();
}

async function loadWorld(): Promise<P3EBrowserWorld> {
  const keys = Object.keys(PACK_URLS) as (keyof typeof PACK_URLS)[];
  const loaded = await Promise.all(keys.map((key) => loadJson(PACK_URLS[key])));
  const data: Record<string, unknown> = {};
  keys.forEach((key, index) => {
    data[key] = loaded[index];
  });

  const events = data["p3bEvents"] as { records: unknown[] };
  return prepareP3EBrowserWorld({
    base: {
      manifest: data["p2aManifest"],
      datasets: {
        "country-registry": data["p2aCountryRegistry"],
        indicators: data["p2aIndicators"],
        "birth-weights": data["p2aBirthWeights"],
        "sensitive-names": data["p2aSensitiveNames"],
        licenses: data["p2aLicenses"],
        lineage: data["p2aLineage"]
      }
    },
    identity: {
      manifest: data["p2bManifest"],
      datasets: {
        "country-vitals": data["p2bCountryVitals"],
        "household-profiles": data["p2bHouseholdProfiles"],
        "name-corpus": data["p2bNameCorpus"],
        "story-templates": data["p2bStoryTemplates"],
        licenses: data["p2bLicenses"],
        lineage: data["p2bLineage"]
      }
    },
    events: { manifest: data["p3bManifest"], events: events.records },
    death: {
      manifest: data["p3dManifest"],
      datasets: {
        "cause-registry": data["p3dCauseRegistry"],
        "cause-weights": data["p3dCauseWeights"],
        mortality: data["p3dMortality"],
        licenses: data["p3dLicenses"],
        lineage: data["p3dLineage"]
      }
    }
  });
}

function startLife(seed: string): P3EPlaySession {
  if (world === null) throw new Error("world not ready");
  return createP3EBrowserSession({ world, masterSeed: seed });
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

function runCommand(command: unknown): void {
  if (session === null || busy) return;
  busy = true;
  setControlsDisabled(true);
  try {
    const result = runP3EPlaySessionCommand({ session, command });
    session = result.session;
    if (!session.view.controls.canAdvanceYear) lifeClock.pause();
    persistenceGeneration += 1;
    if (storage !== null && persistenceEnabled) persistenceStatus = "saving";
    focusAdvanceAfterRender = true;
  } catch (error) {
    showAlert(describeError(error));
  } finally {
    busy = false;
    render();
  }
  // 先讓畫面更新（命令已提交），再把最新 session 排進 idle autosave。
  scheduleAutosave();
}

function advanceYear(): void {
  runCommand({ type: "ADVANCE_YEAR", contentMode: "standard" });
}

async function jumpToNextDecision(): Promise<void> {
  if (session === null || busy || fastForwarding || !session.view.controls.canAdvanceYear) return;
  lifeClock.pause();
  fastForwarding = true;
  try {
    for (let index = 0; index < 120; index += 1) {
      if (session === null || !session.view.controls.canAdvanceYear || session.view.phase === "death") break;
      advanceYear();
      if ((index + 1) % 8 === 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
  } finally {
    fastForwarding = false;
    render();
  }
}

function chooseOption(optionId: string): void {
  runCommand({ type: "CHOOSE_DECISION", optionId });
  if (session?.view.controls.canAdvanceYear === true) lifeClock.resume();
}

function rebirth(): void {
  if (busy) return;
  busy = true;
  try {
    cancelScheduledSave();
    if (storage !== null && persistenceEnabled) {
      // 重生順序：先清掉上一條命的 autosave，再開新命、再存檔。
      try {
        clearAutosave();
      } catch (error) {
        persistenceStatus = "save-error";
        persistenceError = describeError(error);
        return; // 清除失敗：留在目前死亡畫面，不動 session
      }
    }
    persistenceEnabled = true;
    session = startLife(readSeed());
    lifeClock.resume();
    persistenceGeneration += 1;
    persistenceStatus = "cleared";
    persistCurrentSession();
  } catch (error) {
    showAlert(describeError(error));
  } finally {
    busy = false;
    if (session !== null && !session.view.controls.canAdvanceYear) lifeClock.pause();
    render();
  }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

let alertText: string | null = null;

function showAlert(message: string): void {
  alertText = message;
}

function setControlsDisabled(disabled: boolean): void {
  app.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = disabled || button.dataset["p3eLocked"] === "true";
  });
}

function render(): void {
  if (session === null) return;
  const view = session.view;

  const shell = element("main", "p3e-shell p3e-game-shell");
  shell.id = "p3e-main";
  shell.setAttribute("aria-labelledby", "p3e-title");
  shell.dataset["p3eLive"] = "true";
  shell.dataset["p3ePhase"] = view.phase;
  shell.dataset["p3eStateHash"] = session.state.stateHash;
  shell.dataset["p3eCommandCount"] = String(session.state.commandLog.count);
  shell.dataset["p3eCommandHead"] = session.state.commandLog.headHash;
  shell.dataset["p3ePersistenceStatus"] = persistenceStatus;
  shell.dataset["p3ePersistenceError"] = persistenceError ?? "";
  shell.dataset["p3ePersistenceGeneration"] = String(persistenceGeneration);
  shell.dataset["p3eLastExport"] = lastExport ?? "";
  shell.dataset["p3eLastImport"] = lastImport ?? "";

  const header = element("header", "p3e-hud");
  const title = element("h1", "p3e-game-title", "人生模擬");
  title.id = "p3e-title";
  const year = element("div", "p3e-hud-item p3e-hud-year");
  year.append(element("span", undefined, "年份"), element("strong", undefined, String(view.currentYear)));
  const age = element("div", "p3e-hud-item p3e-hud-age");
  age.append(element("span", undefined, "年齡"), element("strong", undefined, `${view.age} 歲`));
  const balance = element("div", "p3e-hud-item p3e-hud-assets");
  balance.append(element("span", undefined, "資產"), element("strong", undefined, formatMicroUsd(view.assets.balanceMicroUsd)));
  const income = element("div", "p3e-hud-item p3e-hud-income");
  income.append(element("span", undefined, "年收入"), element("strong", undefined, formatMicroUsd(view.assets.annualIncomeMicroUsd)));
  const menu = element("details", "p3e-hud-menu");
  const menuSummary = element("summary", undefined, "☰");
  menuSummary.setAttribute("aria-label", "開啟選單");
  menu.append(menuSummary, element("p", undefined, "公開測試版 · 進度自動儲存在本機"));
  const status = element("p", "p3e-status", `${view.currentYear} 年，${view.age} 歲`);
  status.id = "p3e-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  header.append(title, year, age, balance, income, menu, status);

  const alert = element("p", "p3e-alert");
  alert.id = "p3e-alert";
  alert.setAttribute("role", "alert");
  alert.setAttribute("aria-live", "assertive");
  alert.hidden = alertText === null;
  alert.textContent = alertText ?? "";
  if (alertText !== null) {
    status.textContent = `${status.textContent ?? ""} · 錯誤：${alertText}`;
  }

  const tabs = renderTabs();

  const content = element("section", "p3e-content");
  content.setAttribute("aria-label", "目前分頁內容");
  if (activeTab === "life") {
    content.append(renderLife(view, session));
  } else {
    content.append(renderPlaceholder(activeTab));
  }

  const tools = element("details", "p3e-tools");
  const toolsSummary = element("summary", undefined, "存檔與測試資訊");
  const notice = element(
    "p",
    "p3e-mvp-notice",
    "MVP 公開測試版 · 遊戲內容使用虛構／合成資料，不代表真實人口統計。"
  );
  const technical = element(
    "p",
    "p3e-meta",
    `seed=${readSeed()} · commands=${session.state.commandLog.count} · stateHash=${session.state.stateHash}`
  );
  tools.append(toolsSummary, notice, renderPersistence(), technical);

  shell.append(header, alert, content, tools, tabs);
  app.replaceChildren(shell);

  const advance = shell.querySelector<HTMLButtonElement>('[data-action="advance"]');
  if (focusAdvanceAfterRender && advance !== null) {
    advance.focus();
    focusAdvanceAfterRender = false;
  }
}

/** 存檔狀態訊息（error 決定 role=alert 或 status）。 */
function persistenceMessage(): { text: string; error: boolean } {
  switch (persistenceStatus) {
    case "restored":
      return { text: "已載入上次的自動存檔。", error: false };
    case "saved":
      return { text: "已自動存檔。", error: false };
    case "saving":
      return { text: "存檔中…（畫面已更新）", error: false };
    case "missing":
      return { text: "找不到存檔，已開始新的一命。", error: false };
    case "unavailable":
      return { text: "瀏覽器儲存不可用；這一命只在記憶體中，重新整理後會消失。", error: false };
    case "ephemeral":
      return { text: "目前是暫時性命（未存檔），重新整理後會消失。", error: false };
    case "save-error":
      return { text: `存檔失敗，遊戲仍可繼續：${persistenceError ?? "E_UNKNOWN"}`, error: true };
    case "restore-error":
      return { text: `存檔無法載入（未刪除）：${persistenceError ?? "E_UNKNOWN"}`, error: true };
    case "cleared":
      return { text: "已清除舊存檔並開始新的一命。", error: false };
  }
}

/** 自動存檔狀態區；壞存檔時提供明確恢復按鈕（鍵盤可達）＋可攜式存檔下載／上傳。 */
function renderPersistence(): HTMLElement {
  const section = element("section", "p3e-persistence");
  section.setAttribute("aria-label", "自動存檔與可攜式存檔");
  const info = persistenceMessage();
  const line = element("p", "p3e-persistence-line", info.text);
  line.setAttribute("role", info.error ? "alert" : "status");
  line.setAttribute("aria-live", info.error ? "assertive" : "polite");
  section.append(line);

  const exportButton = element("button", "p3e-primary", "匯出存檔");
  exportButton.type = "button";
  exportButton.dataset["action"] = "export";
  exportButton.addEventListener("click", downloadPortableSave);

  const fileInput = element("input", "p3e-file-input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json,application/gzip,.gz";
  fileInput.hidden = true;
  fileInput.dataset["role"] = "import-input";
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file !== undefined) importPortableSaveFile(file);
  });

  const importButton = element("button", "p3e-primary", "匯入存檔");
  importButton.type = "button";
  importButton.dataset["action"] = "import";
  importButton.addEventListener("click", () => fileInput.click());

  section.append(exportButton, importButton, fileInput);

  if (recoveryNeeded) {
    const button = element("button", "p3e-primary", "清除存檔並重新開始");
    button.type = "button";
    button.dataset["action"] = "recover";
    button.addEventListener("click", recoverAutosave);
    section.append(button);
  }
  return section;
}

/** 只更新自動存檔相關 DOM（idle flush 完成後用，不重建整個畫面）。 */
function updatePersistenceDom(): void {
  const shell = app.querySelector<HTMLElement>("[data-p3e-live]");
  if (shell === null) return;
  shell.dataset["p3ePersistenceStatus"] = persistenceStatus;
  shell.dataset["p3ePersistenceError"] = persistenceError ?? "";
  shell.dataset["p3ePersistenceGeneration"] = String(persistenceGeneration);
  const old = shell.querySelector("section.p3e-persistence");
  if (old !== null) old.replaceWith(renderPersistence());
}

function renderTabs(): HTMLElement {  const nav = element("nav", "p3e-tabs");
  nav.setAttribute("aria-label", "分頁");
  const tabs: { key: TabKey; label: string }[] = [
    { key: "life", label: "人生" },
    { key: "family", label: "家族" },
    { key: "work", label: "工作" },
    { key: "map", label: "地圖" }
  ];
  for (const tab of tabs) {
    const button = element("button", "p3e-tab", tab.label);
    button.type = "button";
    button.dataset["tab"] = tab.key;
    button.setAttribute("aria-current", tab.key === activeTab ? "page" : "false");
    button.addEventListener("click", () => {
      activeTab = tab.key;
      render();
    });
    nav.append(button);
  }
  return nav;
}

function renderPlaceholder(tab: TabKey): HTMLElement {
  const labels: Record<Exclude<TabKey, "life">, string> = {
    family: "家族",
    work: "工作",
    map: "地圖"
  };
  const section = element("section", "p3e-placeholder");
  section.append(
    element("h2", undefined, labels[tab as Exclude<TabKey, "life">] ?? tab),
    element("p", undefined, "尚未接入正式資料")
  );
  return section;
}

function renderLife(view: P3EPlaySession["view"], current: P3EPlaySession): HTMLElement {
  const root = element("div", "p3e-life");
  const stage = ageStage(view.age);
  const scene = element("section", `p3e-scene p3e-scene-${view.phase}`);
  scene.setAttribute("aria-label", `${view.currentYear} 年的生活場景`);
  const sceneCopy = element("div", "p3e-scene-copy");
  sceneCopy.append(
    element("span", undefined, `${view.identity.regionCode} · ${stage.label}`),
    element("strong", undefined, `${view.age} 歲的你`)
  );
  const character = element("div", "p3e-character-stage");
  character.dataset["ageStage"] = stage.label;
  character.setAttribute("aria-label", `${stage.label}人物`);
  character.append(element("span", undefined, stage.icon));
  scene.append(sceneCopy, character);

  const story = element("section", "p3e-story-card");
  story.append(element("h2", undefined, view.phase === "pending_decision" ? "重要抉擇" : "當年訊息"));
  const last = current.lastOutcome;
  if (last === null) {
    story.append(element("p", undefined, `${view.currentYear} 年，你的人生故事正要開始。`));
  } else if (last.kind === "advance_year") {
    const eventName = last.selectedEventId === null ? "平凡的一年" : friendlyKey(last.selectedEventId);
    story.append(element("p", undefined, `${view.currentYear} 年，你 ${view.age} 歲。`));
    story.append(element("strong", "p3e-event-name", eventName));
  } else {
    story.append(element("p", undefined, "你已經做出了選擇。"));
    story.append(element("strong", "p3e-event-name", friendlyKey(last.selectedOptionId)));
  }

  if (view.phase === "pending_decision" && view.pendingDecision !== null) {
    story.append(renderPending(view.pendingDecision));
  }

  if (view.phase === "death") {
    const death = element("div", "p3e-death");
    death.append(element("h3", undefined, "這段人生走到了終點"));
    const deathOutcome = last !== null && last.kind === "advance_year" ? last.death : null;
    death.append(element("p", undefined, `你活了 ${view.age} 年。${deathOutcome?.causeId === null || deathOutcome?.causeId === undefined ? "" : ` 原因：${friendlyKey(deathOutcome.causeId)}`}`));
    const again = element("button", "p3e-primary", "重新開始");
    again.type = "button";
    again.dataset["action"] = "rebirth";
    again.addEventListener("click", rebirth);
    death.append(again);
    story.append(death);
  }

  const statDock = element("section", "p3e-stat-dock");
  statDock.setAttribute("aria-label", "人物狀態");
  const statRows: [string, string, number][] = [
    ["❤️", "健康", view.stats.health],
    ["🙂", "幸福", view.stats.happiness],
    ["📘", "知識", view.stats.knowledge],
    ["👥", "人際", view.stats.relationships]
  ];
  for (const [icon, label, value] of statRows) {
    const item = element("div", "p3e-stat-item");
    item.append(element("span", "p3e-stat-label", `${icon} ${label}`), element("strong", undefined, String(value)));
    const meter = element("span", "p3e-stat-meter");
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", `${label}狀態`);
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    meter.setAttribute("aria-valuenow", String(value));
    const fill = element("i");
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    meter.append(fill);
    item.append(meter);
    statDock.append(item);
  }

  const timeControls = renderTimeControls(view);
  const controls = element("section", "p3e-controls");
  controls.setAttribute("aria-label", "操作");
  if (view.controls.canAdvanceYear) {
    const advance = element("button", "p3e-primary p3e-next-button", "下一步");
    advance.type = "button";
    advance.dataset["action"] = "advance";
    advance.addEventListener("click", advanceYear);
    controls.append(advance);
  } else if (view.phase === "pending_decision") {
    controls.append(element("p", "p3e-hint", "請先做出選擇"));
  } else if (view.phase === "death") {
    controls.append(element("p", "p3e-hint", "這條命已結束"));
  }

  root.append(scene, story, statDock, timeControls, controls);
  return root;
}

function renderTimeControls(view: P3EPlaySession["view"]): HTMLElement {
  const section = element("section", "p3e-time-controls");
  section.setAttribute("aria-label", "時間控制");
  const state = lifeClock.getState();
  const pause = element("button", "p3e-time-toggle", state.running ? "❚❚ 暫停" : "▶ 繼續");
  pause.type = "button";
  pause.dataset["action"] = "toggle-time";
  pause.disabled = view.phase === "death";
  pause.addEventListener("click", () => lifeClock.togglePause());
  section.append(pause);
  const speeds: readonly Speed[] = [1, 2, 4, 8, 16];
  for (const speed of speeds) {
    const button = element("button", "p3e-speed-button", `${speed}×`);
    button.type = "button";
    button.dataset["speed"] = String(speed);
    button.setAttribute("aria-pressed", String(state.speed === speed));
    button.disabled = view.phase === "death";
    button.addEventListener("click", () => lifeClock.setSpeed(speed));
    section.append(button);
  }
  const jump = element("button", "p3e-jump-button", "下一個決定 »");
  jump.type = "button";
  jump.dataset["action"] = "jump-decision";
  jump.disabled = !view.controls.canAdvanceYear || fastForwarding;
  jump.addEventListener("click", () => void jumpToNextDecision());
  section.append(jump);
  return section;
}

function renderPending(
  pending: NonNullable<P3EPlaySession["view"]["pendingDecision"]>
): HTMLElement {
  const section = element("div", "p3e-pending");
  section.setAttribute("aria-labelledby", "p3e-pending-title");
  const heading = element("h2", undefined, friendlyKey(pending.promptKey !== "" ? pending.promptKey : pending.eventId));
  heading.id = "p3e-pending-title";
  section.append(heading);
  const options = element("div", "p3e-options p3e-choice-list");
  pending.options.forEach((option, index) => {
    const button = element("button", "p3e-option", friendlyKey(option.labelKey !== "" ? option.labelKey : option.optionId));
    button.type = "button";
    button.dataset["action"] = "choose";
    button.dataset["optionId"] = option.optionId;
    button.dataset["optionIndex"] = String(index);
    button.addEventListener("click", () => chooseOption(option.optionId));
    options.append(button);
  });
  section.append(options);
  return section;
}

/* ------------------------------------------------------------------ */
/* 啟動                                                                */
/* ------------------------------------------------------------------ */

function renderBootError(message: string): void {
  alertText = message;
  const shell = element("main", "p3e-shell");
  shell.dataset["p3eLive"] = "false";
  shell.dataset["p3ePhase"] = "error";
  const alert = element("p", "p3e-alert", message);
  alert.setAttribute("role", "alert");
  alert.setAttribute("aria-live", "assertive");
  shell.append(element("h1", undefined, "人生模擬"), alert);
  app.replaceChildren(shell);
}

async function boot(): Promise<void> {
  try {
    world = await loadWorld();
    const seed = readSeed();
    storage = acquireStorage();
    if (storage === null) {
      // 儲存不可用：可玩的暫時性命＋非阻塞警告。
      persistenceStatus = "unavailable";
      persistenceEnabled = false;
      session = startLife(seed);
      persistenceGeneration += 1;
      persistenceStatus = "ephemeral";
      lifeClock.resume();
      render();
      return;
    }
    try {
      const restored = restoreP3EBrowserAutosaveSession({ storage, world, masterSeed: seed });
      if (restored === null) {
        persistenceStatus = "missing";
        session = startLife(seed);
        persistenceGeneration += 1;
        persistCurrentSession();
      } else {
        session = restored;
        persistenceGeneration += 1;
        savedGeneration = persistenceGeneration;
        persistenceStatus = "restored";
      }
    } catch (error) {
      // 壞存檔／版本／seed／replay 不符：不刪除、不覆寫，要求明確恢復。
      persistenceStatus = "restore-error";
      persistenceError = describeError(error);
      recoveryNeeded = true;
      persistenceEnabled = false;
      session = startLife(seed);
      persistenceGeneration += 1;
    }
    if (session !== null && session.view.controls.canAdvanceYear) lifeClock.resume();
    else lifeClock.pause();
    render();
  } catch (error) {
    renderBootError(describeError(error));
  }
}

// 離開頁面／切到背景時盡力同步 flush 最新 session（不阻塞正常路徑）。
window.addEventListener("pagehide", () => flushAutosaveNow());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushAutosaveNow();
});

void boot();
