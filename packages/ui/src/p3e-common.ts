/**
 * GPT-WORKBUDDY-0065-A｜出生頁與遊戲頁共用的**極小**工具模組。
 *
 * 這裡只放無狀態（或只吃明確參數）的 DOM／seed／storage helper；
 * 不含 validators、不含場景／職業／存檔／session，因此可以同時進
 * birth critical chunk 與 game chunk 而不會互相拉入彼此的依賴。
 */

export const DEFAULT_SEED = "p3e-166-playable-runtime-v4";
export const SEED_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** application 的 autosave key（只用來判斷是否為回訪玩家）。 */
export const AUTOSAVE_PRESENCE_KEY = "life-sim:p3e:v6:autosave";
/** UI 自有的 active seed key（與 application autosave 分開）。 */
export const ACTIVE_SEED_KEY = "life-sim:p3e:active-seed";
export const NATURE_SOUND_PREF_KEY = "life-sim:p3e:v1:nature-sound";
export const NATURE_SOUND_VOLUME = 0.15;
export const WORLD_FAILURE_HEADING =
  "遊戲啟動失敗：完整人生資料還沒準備好。請重新整理頁面，或按下方按鈕重試一次。";

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; path?: unknown; message?: unknown };
    if (typeof record.code === "string") {
      return typeof record.path === "string" ? `${record.code} at ${record.path}` : record.code;
    }
    if (typeof record.message === "string") return record.message;
  }
  return "E_UNKNOWN";
}

/** `?seed=` 的固定測試能力：合法才採用，其餘一律忽略。 */
export function readPinnedSeed(): string | null {
  const raw = new URLSearchParams(window.location.search).get("seed");
  return raw !== null && SEED_PATTERN.test(raw) ? raw : null;
}

/** 真正隨機的 birth seed：`crypto.getRandomValues` 取 10 bytes → 20 hex。 */
export function randomSeed(): string {
  const bytes = new Uint8Array(10);
  const source = window.crypto;
  if (typeof source === "object" && source !== null && typeof source.getRandomValues === "function") {
    source.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `life-${hex}`;
}

export function readActiveSeed(storage: Storage | null): string | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(ACTIVE_SEED_KEY);
    return raw !== null && SEED_PATTERN.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeActiveSeed(storage: Storage | null, seed: string): void {
  if (storage === null) return;
  try {
    storage.setItem(ACTIVE_SEED_KEY, seed);
  } catch {
    // 配額／權限問題：不中斷遊戲，下次開頁就退回舊常數或出生卡。
  }
}

export function readSeed(activeSeed: string | null): string {
  return readPinnedSeed() ?? activeSeed ?? DEFAULT_SEED;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function acquireStorage(): Storage | null {
  try {
    const candidate = window.localStorage;
    return typeof candidate === "object" && candidate !== null ? candidate : null;
  } catch {
    return null;
  }
}

/** 回訪玩家（已有 autosave）：只檢查 key 是否存在，不讀取／不解析內容。 */
export function hasStoredAutosave(storage: Storage | null): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(AUTOSAVE_PRESENCE_KEY) !== null;
  } catch {
    return false;
  }
}

/** 第一次使用預設 true；localStorage 不可用也不影響遊戲。 */
export function readNatureSoundPreference(): boolean {
  try {
    const raw = window.localStorage.getItem(NATURE_SOUND_PREF_KEY);
    if (raw === "off") return false;
    if (raw === "on") return true;
  } catch {
    // 隱私模式／配額限制：偏好只降級成「每次預設開啟」，不報錯。
  }
  return true;
}

/**
 * 出生卡階段的音訊 dataset：完全不建立 Audio、不下載音檔，但仍讓
 * 既有 smoke 能觀察到「偏好預設 true、尚未 arm／請求、preload=none」。
 */
export function writeBirthAudioDataset(shell: HTMLElement | null): void {
  if (shell === null) return;
  shell.dataset["p3eAudioEnabled"] = String(readNatureSoundPreference());
  shell.dataset["p3eAudioBlocked"] = "false";
  shell.dataset["p3eAudioArmed"] = "false";
  shell.dataset["p3eAudioRequested"] = "false";
  shell.dataset["p3eAudioPlaying"] = "false";
  shell.dataset["p3eAudioVolume"] = String(NATURE_SOUND_VOLUME);
  shell.dataset["p3eAudioPreload"] = "none";
  shell.dataset["p3eAudioLoop"] = "true";
  shell.dataset["p3eAudioTime"] = "0";
  shell.dataset["p3eAudioSrc"] = "none";
}
