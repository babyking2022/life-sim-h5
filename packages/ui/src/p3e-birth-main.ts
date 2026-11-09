/**
 * GPT-WORKBUDDY-0065-A｜**birth entry**（出生頁唯一執行期進入點）。
 *
 * CTO 授權的 MVP 邊界：
 *
 * - 出生卡只抓**一個**同源 `birth-bundle.v1.json`（build 期已由正式
 *   validators 完整驗證、正規化、版本化並附內容雜湊）；
 * - 執行期只做 JSON 解析、版本／必要欄位／內容雜湊的輕量檢查，經由
 *   `@life-sim/application/birth-lite` 這個明確 public subpath，
 *   **不會**把完整 schema validators 打進出生 critical JS；
 * - 出生預覽與 canonical `previewP3EBrowserBirthStage()` 共用同一個
 *   `p3e-birth-core.ts` 核心（1000 seeds 逐欄位等價測試）；
 * - 完整遊戲 chunk 與「原始 fixtures + 正式 validators」的完整世界
 *   只在按「開始人生」後才載入；正式 session／save／load／replay
 *   完全不使用 birth-lite 的資料。
 *
 * 這裡刻意不 import `@life-sim/application`（完整 barrel）、
 * `p3e-birth-packs.ts`、`p3e-heavy-packs.ts`、`p3e-game-layer.ts`
 * 或 `p3e-scene.ts`：任何一個靜態 import 都會把重型資產拉回首屏。
 */
import {
  P3E_BIRTH_LITE_FAILURE_MESSAGE,
  prepareP3EBirthLiteBundle,
  previewP3EBirthLite,
  type P3EBirthLiteStage
} from "@life-sim/application/birth-lite";
import { loadTextCached } from "./p3e-fetch-cache.js";
import {
  acquireStorage,
  DEFAULT_SEED,
  hasStoredAutosave,
  randomSeed,
  readActiveSeed,
  readPinnedSeed,
  writeActiveSeed,
  WORLD_FAILURE_HEADING
} from "./p3e-common.js";
import { friendlyWorldError } from "./p3e-copy.js";
import {
  announceBirthRefresh,
  renderBirthCard,
  renderBirthLoadError,
  type BirthCardModel
} from "./p3e-birth-view.js";
import { setGameHandoff } from "./p3e-game-bridge.js";

type BirthPreview = ReturnType<typeof previewP3EBirthLite>;
type WorldStage = BirthCardModel["worldStage"];

/** Vite 會在 build 期把這個同源 JSON 轉成 hashed 資產（只有 1 個請求）。 */
const BIRTH_BUNDLE_URL = new URL(
  "../../../fixtures/p3e/birth-bundle.v1.json",
  import.meta.url
).href;

interface FullWorldReady {
  readonly world: unknown;
  readonly birthStage: unknown;
  readonly eventCopy: Readonly<Record<string, string>>;
  readonly eventCopyKeys: number;
  readonly countryRegistry: readonly Readonly<Record<string, unknown>>[];
}

const app = document.querySelector<HTMLElement>("#app");
const storage = acquireStorage();

let stage: P3EBirthLiteStage | null = null;
let seed = "";
let preview: BirthPreview | null = null;
let knownSeed: string | null = null;
let refreshCount = 0;
let refreshPending = false;
let startPending = false;
let started = false;
let worldStage: WorldStage = "loading";
let worldError: string | null = null;
let bundleRetry = 0;
let entryStarted = false;

/** 單一 promise：連點「開始人生」只 import 一次、只交付一次。 */
let fullWorldPromise: Promise<FullWorldReady> | null = null;
let gameChunkPromise: Promise<unknown> | null = null;

function loadBundle(): Promise<void> {
  const url = bundleRetry === 0 ? BIRTH_BUNDLE_URL : `${BIRTH_BUNDLE_URL}?retry=${bundleRetry}`;
  return loadTextCached(url).then((rawText) => {
    stage = prepareP3EBirthLiteBundle(rawText);
  });
}

/** 完整世界：動態 import 延遲 chunk，裡頭才用原始 fixtures + 正式 validators。 */
function prepareFullWorldOnce(): Promise<FullWorldReady> {
  if (fullWorldPromise === null) {
    fullWorldPromise = import("./p3e-world-runtime.js").then((runtime) =>
      runtime.prepareFullWorld() as Promise<FullWorldReady>
    );
  }
  return fullWorldPromise;
}

/** game chunk 只在按下「開始人生」後載入；連點共用同一個 promise。 */
function loadGameChunk(): Promise<unknown> {
  if (gameChunkPromise === null) gameChunkPromise = import("./p3e-game-main.js");
  return gameChunkPromise;
}

function render(): void {
  if (app === null || preview === null || seed === "") return;
  const model: BirthCardModel = {
    birth: preview,
    seed,
    refreshCount,
    worldStage,
    worldError,
    startPending,
    // 出生卡完全不需要事件文案字典；完整世界準備好後由 game chunk 帶入。
    eventCopyKeys: 0,
    persistenceStatus: "missing",
    persistenceError: null
  };
  renderBirthCard(app, model, {
    onRefresh: (button) => refreshBirth(button),
    onReroll: () => refreshBirth(null),
    onStart: () => void startLife(),
    onRetry: () => void startLife()
  });
}

/**
 * 刷新出生：只重抽 seed 與出生預覽。
 * 不重載頁面、不下載任何資料、不建立 session；120ms 可見「刷新中…」，
 * 完成後 aria-live 宣告並把焦點放回新的刷新鈕（0062-B 契約）。
 */
function refreshBirth(source: HTMLButtonElement | null): void {
  if (refreshPending || stage === null) return;
  refreshPending = true;
  if (source !== null) {
    source.disabled = true;
    source.dataset["p3eRefreshState"] = "loading";
    const label = source.querySelector<HTMLElement>(".p3e-birth-refresh-label");
    if (label !== null) label.textContent = "刷新中…";
  }
  window.setTimeout(() => {
    try {
      if (stage === null) return;
      refreshCount += 1;
      seed = randomSeed();
      writeActiveSeed(storage, seed);
      preview = previewP3EBirthLite({ stage, masterSeed: seed });
      render();
      announceBirthRefresh(refreshCount);
      document
        .querySelector<HTMLButtonElement>('[data-action="refresh-birth"]')
        ?.focus({ preventScroll: true });
    } finally {
      refreshPending = false;
    }
  }, 120);
}

function handoff(ready: FullWorldReady, startNewLife: boolean, handoffSeed: string): void {
  setGameHandoff({
    seed: handoffSeed,
    knownSeed: knownSeed !== null,
    startNewLife,
    world: ready.world,
    birthStage: ready.birthStage,
    eventCopy: ready.eventCopy,
    eventCopyKeys: ready.eventCopyKeys,
    countryRegistry: ready.countryRegistry,
    storage
  });
}

/**
 * 事件文案字典（CopyBootError）是**致命**啟動錯誤：沿用 0025-D 以來的
 * 完整啟動錯誤頁契約（`data-p3e-phase="error"`、`#p3e-boot-error`、
 * 「啟動失敗…重新整理…」），不顯示 internal key、不建立 session。
 * 其他下載／驗證失敗則留在出生卡並給明確重試（0058-B 狀態機）。
 */
function isCopyBootFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { copyError?: unknown }).copyError === true;
}

function renderWorldBootFailure(onRetry: () => void): void {
  renderBirthLoadError(
    app ?? document.body,
    WORLD_FAILURE_HEADING,
    () => {
      fullWorldPromise = null;
      started = false;
      startPending = false;
      worldStage = "loading";
      worldError = null;
      onRetry();
    },
    "retry-world"
  );
}

/**
 * 「開始人生」：完整世界（正式 validators）→ 單次交付 → game chunk。
 * 失敗顯示「人生資料還沒準備好」與重試，不建立 session。
 */
async function startLife(): Promise<void> {
  if (started || startPending || stage === null || preview === null) return;
  started = true;
  startPending = true;
  worldStage = "preparing";
  worldError = null;
  render();
  try {
    const ready = await prepareFullWorldOnce();
    handoff(ready, true, seed);
    await loadGameChunk();
  } catch (error) {
    fullWorldPromise = null;
    started = false;
    startPending = false;
    if (isCopyBootFailure(error)) {
      renderWorldBootFailure(() => void startLife());
      return;
    }
    worldStage = "error";
    worldError = friendlyWorldError(error);
    render();
  }
}

/** 回訪玩家（已有 autosave）：維持骨架，等完整世界 ready 才交給 game chunk restore。 */
async function startReturningUser(): Promise<void> {
  try {
    const ready = await prepareFullWorldOnce();
    handoff(ready, false, knownSeed ?? DEFAULT_SEED);
    await loadGameChunk();
  } catch (error) {
    fullWorldPromise = null;
    if (isCopyBootFailure(error)) {
      renderWorldBootFailure(() => void startReturningUser());
      return;
    }
    renderBirthLoadError(app ?? document.body, friendlyWorldError(error), () => {
      void startReturningUser();
    });
  }
}

/**
 * 出生頁啟動：
 * 1. HTML 靜態骨架在 TTFB 後立即可見（不需任何 fetch）；
 * 2. 只抓一個 birth bundle，輕量檢查失敗顯示可理解錯誤與重試，不建立 session；
 * 3. 新玩家立刻顯示出生卡；回訪玩家等完整世界 ready 才 restore。
 */
async function bootBirth(): Promise<void> {
  try {
    await loadBundle();
  } catch {
    bundleRetry += 1;
    renderBirthLoadError(app ?? document.body, P3E_BIRTH_LITE_FAILURE_MESSAGE, () => {
      void bootBirth();
    });
    return;
  }
  if (stage === null) return;
  const activeStage: P3EBirthLiteStage = stage;
  knownSeed = readPinnedSeed() ?? readActiveSeed(storage);
  seed = knownSeed ?? randomSeed();
  writeActiveSeed(storage, seed);
  preview = previewP3EBirthLite({ stage: activeStage, masterSeed: seed });

  if (hasStoredAutosave(storage)) {
    await startReturningUser();
    return;
  }
  render();
}

/** bootstrap 在 `startP3ELocale()` 之後呼叫，確保 DOM 文字先轉成簡體。 */
export function startP3EBirth(): void {
  if (entryStarted) return;
  entryStarted = true;
  void bootBirth();
}
