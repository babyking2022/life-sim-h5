import {
  attestBuildTimeBirthPacks,
  type ValidatedDataPack,
  type ValidatedIdentityPack
} from "@life-sim/birth";
import {
  birthBundleContentHash,
  P3E_BIRTH_BUNDLE_SCHEMA_VERSION,
  previewBirthFromValidatedPacks
} from "./p3e-birth-core";
import type { P3EBrowserBirthPreview } from "./p3e-birth-preview";

/**
 * GPT-WORKBUDDY-0065-A｜**birth-lite public entry**（出生頁唯一執行期入口）。
 *
 * CTO 授權的 MVP：靜態資料的完整 schema 驗證已在 build 期由正式 validators
 * 完成（見 `scripts/p3e-0065a-generate-entry.ts`）。這裡只做四件小事：
 *
 * 1. `JSON.parse`；
 * 2. 版本／必要欄位／跨 pack 綁定的輕量檢查；
 * 3. 用與 build 期**同一個** `birthBundleContentHash` 驗證可重現內容雜湊；
 * 4. 把已正規化的資料轉交給 `p3e-birth-core.ts` 的**唯一出生核心**。
 *
 * 本模組沒有 import 任何 `validateDataPack`／`validateIdentityPack`／
 * `validateEventPack`／`validateDeathPack`、沒有 `createP3EPlaySession`、
 * 沒有 `@life-sim/simulation`，也不經 `@life-sim/application` 完整 barrel，
 * 因此可以單獨打進出生 critical JS，不會把 validators 帶進首屏。
 *
 * 正式世界（開始人生以前）完全不讀這裡的資料：`prepareP3EBrowserBirthStage`／
 * `completeP3EBrowserWorld` 仍用原始 fixtures 與正式 validators，
 * session／save／load／replay 的信任邊界不變。
 */

const LITE_BRAND: unique symbol = Symbol("p3e.birth.liteStage");

/** 不可偽造、不可序列化的 lite stage handle（沒有任何 pack 欄位）。 */
export interface P3EBirthLiteStage {
  readonly [LITE_BRAND]: "P3EBirthLiteStage";
}

interface LitePacks {
  readonly base: ValidatedDataPack;
  readonly identity: ValidatedIdentityPack;
}

const PACKS_BY_LITE_STAGE = new WeakMap<object, LitePacks>();
const HASH = /^[0-9a-f]{64}$/;

/** 給 UI 顯示的人類可理解訊息（不含 internal key／HTTP 代碼／hash）。 */
export const P3E_BIRTH_LITE_FAILURE_MESSAGE = "出生資料載入失敗，請重試一次。";

/** 失敗時統一拋出這個型別，UI 只需顯示 `P3E_BIRTH_LITE_FAILURE_MESSAGE`。 */
export class P3EBirthLiteError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "P3EBirthLiteError";
  }
}

function fail(detail: string): never {
  throw new P3EBirthLiteError(detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = parent[key];
  if (!isRecord(value)) fail(`${path}.${key} 缺失或型別錯誤`);
  return value;
}

function requireText(parent: Record<string, unknown>, key: string, path: string): string {
  const value = parent[key];
  if (typeof value !== "string" || value.length === 0) fail(`${path}.${key} 缺失或型別錯誤`);
  return value;
}

function requireHash(parent: Record<string, unknown>, key: string, path: string): string {
  const value = requireText(parent, key, path);
  if (!HASH.test(value)) fail(`${path}.${key} 內容雜湊格式錯誤`);
  return value;
}

function requireArray(parent: Record<string, unknown>, key: string, path: string): readonly unknown[] {
  const value = parent[key];
  if (!Array.isArray(value)) fail(`${path}.${key} 缺失或型別錯誤`);
  return value as readonly unknown[];
}

/**
 * 解析並驗證 build 期 bundle，回傳不可偽造的 lite stage。
 *
 * `rawText` 是同源 JSON 檔的**原始文字**（不能先 `JSON.parse` 再重新序列化，
 * 否則內容雜湊會失去可重現性）。任何失敗都拋 `P3EBirthLiteError`，
 * 呼叫端必須顯示 `P3E_BIRTH_LITE_FAILURE_MESSAGE` 並提供重試，不得建立 session。
 */
export function prepareP3EBirthLiteBundle(rawText: string): P3EBirthLiteStage {
  if (typeof rawText !== "string" || rawText.length === 0) fail("bundle 內容為空");

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    fail("bundle JSON 解析失敗");
  }
  if (!isRecord(parsed)) fail("bundle 根節點不是物件");
  const root = parsed;

  const schemaVersion = requireText(root, "schemaVersion", "bundle");
  if (schemaVersion !== P3E_BIRTH_BUNDLE_SCHEMA_VERSION) fail("bundle schema 版本不符");
  const generatorVersion = requireText(root, "generatorVersion", "bundle");
  const sourceHash = requireHash(root, "sourceHash", "bundle");
  const contentHash = requireHash(root, "contentHash", "bundle");

  const dataVersion = requireRecord(root, "dataVersion", "bundle");
  const baseVersion = requireText(dataVersion, "base", "bundle.dataVersion");
  const identityVersion = requireText(dataVersion, "identity", "bundle.dataVersion");

  const payload = requireRecord(root, "payload", "bundle");
  const baseRaw = requireRecord(payload, "base", "bundle.payload");
  const identityRaw = requireRecord(payload, "identity", "bundle.payload");

  const baseManifest = requireRecord(baseRaw, "manifest", "bundle.payload.base");
  const basePackId = requireText(baseManifest, "packId", "bundle.payload.base.manifest");
  if (requireText(baseManifest, "dataVersion", "bundle.payload.base.manifest") !== baseVersion) {
    fail("base 資料版本不符");
  }
  requireText(baseManifest, "packKind", "bundle.payload.base.manifest");
  if (typeof baseManifest["indicatorYear"] !== "number" || !Number.isSafeInteger(baseManifest["indicatorYear"])) {
    fail("bundle.payload.base.manifest.indicatorYear 缺失");
  }
  const basePackChecksum = requireHash(baseRaw, "packChecksum", "bundle.payload.base");
  const enabledEntityIds = requireArray(baseRaw, "enabledEntityIds", "bundle.payload.base");
  if (enabledEntityIds.length === 0 || enabledEntityIds.some((id) => typeof id !== "string")) {
    fail("bundle.payload.base.enabledEntityIds 內容錯誤");
  }
  requireRecord(baseRaw, "birthShare", "bundle.payload.base");
  requireRecord(baseRaw, "birthWeightIndex", "bundle.payload.base");
  requireRecord(baseRaw, "displayNames", "bundle.payload.base");
  requireArray(baseRaw, "registry", "bundle.payload.base");

  const identityManifest = requireRecord(identityRaw, "manifest", "bundle.payload.identity");
  requireText(identityManifest, "packId", "bundle.payload.identity.manifest");
  if (requireText(identityManifest, "dataVersion", "bundle.payload.identity.manifest") !== identityVersion) {
    fail("identity 資料版本不符");
  }
  requireText(identityManifest, "packKind", "bundle.payload.identity.manifest");
  if (requireText(identityManifest, "basePackId", "bundle.payload.identity.manifest") !== basePackId) {
    fail("identity 綁定的 base packId 不符");
  }
  if (requireHash(identityManifest, "basePackChecksum", "bundle.payload.identity.manifest") !== basePackChecksum) {
    fail("identity 綁定的 base checksum 不符");
  }
  if (requireText(identityManifest, "baseDataVersion", "bundle.payload.identity.manifest") !== baseVersion) {
    fail("identity 綁定的 base 資料版本不符");
  }
  requireHash(identityManifest, "packChecksum", "bundle.payload.identity.manifest");
  requireHash(identityRaw, "packChecksum", "bundle.payload.identity");
  requireRecord(identityRaw, "vitalsByEntity", "bundle.payload.identity");
  requireRecord(identityRaw, "profileByCulture", "bundle.payload.identity");
  requireRecord(identityRaw, "namePoolsByCulture", "bundle.payload.identity");
  requireRecord(identityRaw, "storiesByCulture", "bundle.payload.identity");

  const hashInput = {
    schemaVersion,
    generatorVersion,
    dataVersion: { base: baseVersion, identity: identityVersion },
    sourceHash,
    payload
  };
  if (birthBundleContentHash(hashInput) !== contentHash) fail("bundle 內容雜湊不符");

  /*
   * bundle 是 build 期由正式 validators 產生的**已正規化投影**：只保留出生核心
   * 實際讀取的欄位（見產生器 `projectValidated`）。型別斷言不代表跳過驗證——
   * 上面的版本／欄位／內容雜湊檢查與 1000-seed 逐欄位等價測試共同保證它與
   * canonical `ValidatedDataPack`／`ValidatedIdentityPack` 行為完全相同。
   */
  const base = baseRaw as unknown as ValidatedDataPack;
  const identity = identityRaw as unknown as ValidatedIdentityPack;
  attestBuildTimeBirthPacks(base, identity);

  const handle = Object.freeze(
    Object.defineProperty({}, LITE_BRAND, { value: "P3EBirthLiteStage", enumerable: false })
  ) as P3EBirthLiteStage;
  PACKS_BY_LITE_STAGE.set(handle, Object.freeze({ base, identity }));
  return handle;
}

/**
 * 由 lite stage 產生出生卡。與 canonical `previewP3EBrowserBirthStage`
 * 呼叫同一個 `previewBirthFromValidatedPacks` 核心，同 seed 逐位元一致。
 * 不建立 session、不改 pack、不抽額外隨機值。
 */
export function previewP3EBirthLite(input: unknown): P3EBrowserBirthPreview {
  if (!isRecord(input) || Object.getOwnPropertySymbols(input).length !== 0) {
    fail("lite preview 輸入格式錯誤");
  }
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("stage") || !keys.includes("masterSeed")) {
    fail("lite preview 輸入欄位錯誤");
  }
  const stage: unknown = input["stage"];
  const packs =
    typeof stage === "object" && stage !== null ? PACKS_BY_LITE_STAGE.get(stage as object) : undefined;
  if (packs === undefined) fail("lite stage 未經 bundle 驗證");
  const masterSeed = input["masterSeed"];
  if (typeof masterSeed !== "string") fail("masterSeed 必須是字串");
  return previewBirthFromValidatedPacks(packs.base, packs.identity, masterSeed);
}
