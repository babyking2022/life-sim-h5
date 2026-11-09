/**
 * GPT-WORKBUDDY-0065-A｜**延遲**的完整世界準備 chunk。
 *
 * 出生頁 production path 只抓一個 birth bundle；開始人生以前，這裡才用
 * **原始 fixtures + 原本正式 validators** 準備完整世界：
 *
 *   loadBirthPacks → prepareP3EBrowserBirthStage → loadHeavyPacks
 *   → completeP3EBrowserWorld
 *
 * 因此正式 session、save/load/replay 完全不使用 birth-lite 的未完整驗證資料。
 * 這個 chunk 只會在出生卡出現後由 `p3e-real-main.ts` 動態 import，
 * 不下載任何 Open Peeps／場景／音訊程式（那些在 game chunk）。
 */
import {
  completeP3EBrowserWorld,
  prepareP3EBrowserBirthStage
} from "@life-sim/application";
import { birthCountryRecords, buildBirthStageInput, loadBirthPacks } from "./p3e-birth-packs.js";
import {
  friendlyWorldError,
  isCopyBootError,
  markCopyBootError,
  validateEventCopy
} from "./p3e-copy.js";
import { isPlainRecord } from "./p3e-common.js";
import { buildCompleteWorldPacks, loadHeavyPacks } from "./p3e-heavy-packs.js";

export interface FullWorldReady {
  readonly world: unknown;
  readonly birthStage: unknown;
  readonly eventCopy: Readonly<Record<string, string>>;
  readonly eventCopyKeys: number;
  readonly countryRegistry: readonly Readonly<Record<string, unknown>>[];
}

/** 錯誤由 `friendlyWorldError` 轉成人話；CopyBootError 另外標記給錯誤頁。 */
export class P3EWorldPrepError extends Error {
  readonly copyError: boolean;
  constructor(error: unknown) {
    super(friendlyWorldError(error));
    this.name = "P3EWorldPrepError";
    this.copyError = isCopyBootError(error);
  }
}

let inFlight: Promise<FullWorldReady> | null = null;

async function prepare(): Promise<FullWorldReady> {
  // 第一階段：原始 14 個出生 fixtures，交給正式 validators 完整驗證。
  const birthData = await loadBirthPacks();
  const birthStage = prepareP3EBrowserBirthStage(buildBirthStageInput(birthData));
  const countryRegistry = birthCountryRecords(birthData).filter((record): record is Record<string, unknown> =>
    isPlainRecord(record)
  );

  // 第二階段：events＋death（含 2.61 MB mortality）與文案字典。
  const heavy = await loadHeavyPacks();
  const events = heavy.p3bEvents as { records: unknown[]; contentPackVersion?: unknown } | null;
  const manifest = heavy.p3bManifest as { contentPackVersion?: unknown } | null;
  const packVersion = manifest?.contentPackVersion;
  if (
    typeof packVersion !== "string" ||
    packVersion.length === 0 ||
    events?.contentPackVersion !== packVersion
  ) {
    throw markCopyBootError();
  }
  let eventCopy: Readonly<Record<string, string>>;
  try {
    eventCopy = validateEventCopy(heavy.p3bEventCopy, packVersion);
  } catch (error) {
    if (isCopyBootError(error)) throw error;
    throw markCopyBootError();
  }

  const packs = buildCompleteWorldPacks(heavy);
  const world = completeP3EBrowserWorld({
    stage: birthStage,
    events: packs.events,
    death: packs.death
  });
  // GPT-0065-A 觀測點：只有走完「原始 14 個 fixtures →
  // prepareP3EBrowserBirthStage（正式 validators）→ events/death →
  // completeP3EBrowserWorld」才會寫入；birth-lite path 永遠不會寫。
  // 讓 browser smoke／獨立驗收能證明正式 session 不是用未完整驗證資料。
  document.documentElement.dataset["p3eFullWorldValidation"] = "canonical-full-validators";
  return {
    world,
    birthStage,
    eventCopy,
    eventCopyKeys: Object.keys(eventCopy).length,
    countryRegistry
  };
}

/**
 * 單一 promise：連點／重繪共用；失敗時清空以便明確重試，但
 * `loadJsonCached` 仍保留已成功的 JSON，2.61 MB mortality 不會重複下載。
 */
export function prepareFullWorld(): Promise<FullWorldReady> {
  if (inFlight === null) {
    inFlight = prepare()
      .then((ready) => {
        inFlight = Promise.resolve(ready);
        return ready;
      })
      .catch((error: unknown) => {
        inFlight = null;
        throw new P3EWorldPrepError(error);
      });
  }
  return inFlight;
}

/** 明確重試：失敗後才需要；成功的 promise 仍保留。 */
export function resetFullWorld(): void {
  inFlight = null;
}
