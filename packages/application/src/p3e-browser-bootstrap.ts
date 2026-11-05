import {
  buildPeerGroup,
  createBirthCertificate,
  validateDataPack,
  validateDeathPack,
  validateIdentityPack
} from "@life-sim/birth";
import { validateEventPack } from "@life-sim/engine";
import { P3EError } from "@life-sim/simulation";
import { buildP3EBirthPreview, type P3EBrowserBirthPreview } from "./p3e-birth-preview";
import {
  createP3EPlaySession,
  restoreP3EPlaySessionPayload,
  type P3EPlaySession
} from "./p3e-session";

/**
 * P3-E.1b-2p／2w：瀏覽器用的 world bootstrap（H5-CTO-176-A／H5-CTO-186-A）。
 * GPT-DEEPSEEK-0017：新增正式出生預覽入口 `previewP3EBrowserBirth`（唯讀）。
 *
 * 瀏覽器不能直接把「原始 pack JSON」交給 session；本模組提供四個入口：
 *
 * ```ts
 * prepareP3EBrowserWorld(rawPacks: unknown): P3EBrowserWorld
 * previewP3EBrowserBirth({ world, masterSeed }: unknown): P3EBrowserBirthPreview
 * createP3EBrowserSession({ world, masterSeed }: unknown): P3EPlaySession
 * restoreP3EBrowserSession({ world, masterSeed, payload }: unknown): P3EPlaySession
 * ```
 *
 * ## 一次驗證、多次開局
 *
 * - `prepareP3EBrowserWorld` 用**公開 barrel**（birth／engine）驗證四個 pack：
 *   base／identity（資料包）與 events／death（內容包），只驗一次；
 * - 驗證後的 pack 參照存在模組私有 `WeakMap<world, packs>`，回傳的 handle
 *   **沒有任何 pack 欄位**、不可序列化、深層凍結；
 * - `createP3EBrowserSession` 每條命只做 `buildPeerGroup` → `createBirthCertificate`
 *   → `createP3EPlaySession`，**重用**已驗證的 pack，不重新驗證大型資料；
 * - `previewP3EBrowserBirth` 走**完全相同**的 `buildPeerGroup` →
 *   `createBirthCertificate`（同 seed／同 `playerSexPolicy: "random"`），再把證書
 *   彙整成可安全顯示的出生卡；它**不建立 session**、不改任何狀態，
 *   因此同 seed 的 preview 與正式 session 的 identity 逐位元一致；
 * - `restoreP3EBrowserSession` 用同一個 world 重建 peer group／certificate，
 *   再呼叫正式 `restoreP3EPlaySessionPayload`（decode → seed 比對 → replay →
 *   canonical 逐位元比對 → seal）；payload 宣稱的 final state 不被信任。
 *
 * ## 信任邊界
 *
 * - 四個入口（prepare／preview／create／restore）都只讀 descriptor：getter 永不執行；
 *   非 exact-object／陣列／symbol／額外欄位一律 `E_P3E_ARGUMENT`；
 * - 偽造或 `structuredClone` 的 world 不在私有 `WeakMap` 內，一律拒絕
 *   （`E_P3E_ARGUMENT at p3eBrowser.world`）。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

const WORLD_BRAND: unique symbol = Symbol("p3e.browser.world");

/** 已驗證 world 的不可偽造 handle（沒有任何 pack 欄位）。 */
export interface P3EBrowserWorld {
  readonly [WORLD_BRAND]: "P3EBrowserWorld";
}

interface PreparedBrowserPacks {
  readonly base: ReturnType<typeof validateDataPack>;
  readonly identity: ReturnType<typeof validateIdentityPack>;
  readonly event: ReturnType<typeof validateEventPack>;
  readonly death: ReturnType<typeof validateDeathPack>;
}

/** world handle → 已驗證 pack 參照（私有；不列舉、不序列化）。 */
const PACKS_BY_WORLD = new WeakMap<object, PreparedBrowserPacks>();

/* ------------------------------------------------------------------ */
/* 固定錯誤路徑                                                         */
/* ------------------------------------------------------------------ */

const RAW_WORLD_KEYS = ["base", "identity", "events", "death"] as const;
const CREATE_KEYS = ["world", "masterSeed"] as const;
const PREVIEW_KEYS = ["world", "masterSeed"] as const;
const RESTORE_KEYS = ["world", "masterSeed", "payload"] as const;

const PATH_WORLD_INPUT = "p3eBrowser.world";
const PATH_CREATE_INPUT = "p3eBrowser.create.input";
const PATH_PREVIEW_INPUT = "p3eBrowser.preview.input";
const PATH_RESTORE_INPUT = "p3eBrowser.restore.input";
const PATH_CREATE_WORLD = "p3eBrowser.world";
const PATH_SEED = "p3eBrowser.masterSeed";

/* ------------------------------------------------------------------ */
/* descriptor-only exact object                                        */
/* ------------------------------------------------------------------ */

function readExactObject(
  input: unknown,
  keys: readonly string[],
  path: string
): Record<string, unknown> {
  let record: Record<string, unknown> | null = null;
  try {
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const proto = Object.getPrototypeOf(input) as object | null;
      if (proto === Object.prototype || proto === null) {
        if (Object.getOwnPropertySymbols(input).length === 0) {
          const names = Object.getOwnPropertyNames(input);
          if (names.length === keys.length && Object.keys(input).length === keys.length) {
            const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            let complete = true;
            for (const key of keys) {
              if (!names.includes(key)) {
                complete = false;
                break;
              }
              const descriptor = Object.getOwnPropertyDescriptor(input, key);
              if (descriptor === undefined || !("value" in descriptor)) {
                complete = false;
                break;
              }
              values[key] = descriptor.value;
            }
            if (complete) record = values;
          }
        }
      }
    }
  } catch {
    record = null;
  }
  if (record === null) throw new P3EError("E_P3E_ARGUMENT", path);
  return record;
}

/* ------------------------------------------------------------------ */
/* 入口一：prepareP3EBrowserWorld                                      */
/* ------------------------------------------------------------------ */

/**
 * 驗證四個 pack（base／identity／events／death）並回傳不可偽造的 world handle。
 *
 * 大型 pack（例如 mortality）只在這裡驗證一次；後續每一條命都重用同一組已驗證 pack。
 */
export function prepareP3EBrowserWorld(rawPacks: unknown): P3EBrowserWorld {
  const raw = readExactObject(rawPacks, RAW_WORLD_KEYS, PATH_WORLD_INPUT);

  const base = validateDataPack(raw.base as Parameters<typeof validateDataPack>[0]);
  const identity = validateIdentityPack(
    base,
    raw.identity as Parameters<typeof validateIdentityPack>[1]
  );
  const event = validateEventPack(raw.events as Parameters<typeof validateEventPack>[0]);
  const death = validateDeathPack(raw.death as Parameters<typeof validateDeathPack>[0], base);

  const handle = Object.freeze(
    Object.defineProperty({}, WORLD_BRAND, { value: "P3EBrowserWorld", enumerable: false })
  ) as P3EBrowserWorld;
  PACKS_BY_WORLD.set(handle, { base, identity, event, death });
  return handle;
}

/* ------------------------------------------------------------------ */
/* 入口二：previewP3EBrowserBirth（正式出生預覽）                        */
/* ------------------------------------------------------------------ */

/**
 * 用已驗證 world 預覽「這個 seed 會出生誰」，**不建立 session**。
 *
 * input 必須是 descriptor-only exact-object 兩欄：`world`（本模組準備並認證的
 * handle）、`masterSeed`（字串）；getter 永不執行。
 *
 * ## 與正式開局的一致性（本入口的核心保證）
 *
 * 這裡呼叫的 `buildPeerGroup`（`playerSexPolicy: "random"`）與
 * `createBirthCertificate` 與 `createP3EBrowserSession` **完全相同、同一個順序**，
 * 因此同一 world＋同一個 seed 得到的證書逐位元相同；preview 的
 * `certificateId`／`certificateHash`／`playerIdentityHash`／`country.regionCode`／
 * `sex`／`birthYear` 與正式 session 的 `state.identity` 一致。
 *
 * ## 回傳值
 *
 * 只有可安全顯示的出生卡資料（`P3EBrowserBirthPreview`）：證書 id／hash、
 * 繁中地區名稱＋regionCode、姓名、性別、城市／鄉村、收入五分之一、住房、
 * 父母年齡與職業、宗教、預期壽命與出生故事。**不含**任何 pack／dataset／
 * manifest／抽選表，也不含 session、payload 或 ledger；深層凍結、可 JSON 序列化。
 *
 * 本入口是唯讀的：不抽新的隨機值、不改 pack、不改任何模擬規則、不寫入儲存。
 * 錯誤與 `createP3EBrowserSession` 一致（偽造 world → `E_P3E_ARGUMENT at
 * p3eBrowser.world`；非字串 seed → `E_P3E_ARGUMENT at p3eBrowser.masterSeed`；
 * 其餘資料錯誤原樣外傳）。
 */
export function previewP3EBrowserBirth(input: unknown): P3EBrowserBirthPreview {
  const raw = readExactObject(input, PREVIEW_KEYS, PATH_PREVIEW_INPUT);

  const world = raw.world;
  const packs =
    typeof world === "object" && world !== null
      ? PACKS_BY_WORLD.get(world as object)
      : undefined;
  if (packs === undefined) throw new P3EError("E_P3E_ARGUMENT", PATH_CREATE_WORLD);

  const masterSeed = raw.masterSeed;
  if (typeof masterSeed !== "string") throw new P3EError("E_P3E_ARGUMENT", PATH_SEED);

  const peerGroup = buildPeerGroup(packs.base, packs.identity, {
    seed: masterSeed,
    playerSexPolicy: "random"
  } as never);
  const certificate = createBirthCertificate(packs.base, packs.identity, peerGroup, masterSeed);

  return buildP3EBirthPreview(certificate);
}

/* ------------------------------------------------------------------ */
/* 入口三：createP3EBrowserSession                                     */
/* ------------------------------------------------------------------ */

/**
 * 用已驗證 world 開一條新命（age 0 session）。
 *
 * `masterSeed` 必須是字串；peer group 與 birth certificate 都在這裡建立，
 * 其餘（genesis／session 封裝）交給 application 的 `createP3EPlaySession`。
 */
export function createP3EBrowserSession(input: unknown): P3EPlaySession {
  const raw = readExactObject(input, CREATE_KEYS, PATH_CREATE_INPUT);

  const world = raw.world;
  const packs =
    typeof world === "object" && world !== null
      ? PACKS_BY_WORLD.get(world as object)
      : undefined;
  if (packs === undefined) throw new P3EError("E_P3E_ARGUMENT", PATH_CREATE_WORLD);

  const masterSeed = raw.masterSeed;
  if (typeof masterSeed !== "string") throw new P3EError("E_P3E_ARGUMENT", PATH_SEED);

  const peerGroup = buildPeerGroup(packs.base, packs.identity, {
    seed: masterSeed,
    playerSexPolicy: "random"
  } as never);
  const certificate = createBirthCertificate(packs.base, packs.identity, peerGroup, masterSeed);

  return createP3EPlaySession({
    masterSeed,
    basePack: packs.base,
    identityPack: packs.identity,
    certificate,
    eventPack: packs.event,
    deathPack: packs.death
  });
}

/* ------------------------------------------------------------------ */
/* 入口四：restoreP3EBrowserSession（2w 新增）                          */
/* ------------------------------------------------------------------ */

/**
 * 從 canonical raw session payload 還原一條命（帶 brand 的凍結 session）。
 *
 * input 必須是 descriptor-only exact-object 三欄：`world`（本模組準備並認證的
 * handle）、`masterSeed`（字串）、`payload`（`exportP3EPlaySessionPayload` 的
 * canonical 輸出）。
 *
 * ## 流程（順序固定、全部恰好一次）
 *
 * 1. 輸入邊界（getter 永不執行）；
 * 2. world 認證（模組私有 WeakMap）；
 * 3. `masterSeed` 必須是字串；
 * 4. `buildPeerGroup` → `createBirthCertificate`；
 * 5. `restoreP3EPlaySessionPayload` 做所有正式驗證（decode → seed 比對 →
 *    replay → canonical 逐位元比對 → seal＋brand）；
 * 6. 回傳還原後的 branded session；失敗時不留任何部分結果。
 *
 * payload 宣稱的 final state **不被信任**；錯 seed／壞 payload／宣稱值篡改
 * 全部由既有正式路徑拒絕（本模組不重寫任何驗證）。
 */
export function restoreP3EBrowserSession(input: unknown): P3EPlaySession {
  const raw = readExactObject(input, RESTORE_KEYS, PATH_RESTORE_INPUT);

  const world = raw.world;
  const packs =
    typeof world === "object" && world !== null
      ? PACKS_BY_WORLD.get(world as object)
      : undefined;
  if (packs === undefined) throw new P3EError("E_P3E_ARGUMENT", PATH_CREATE_WORLD);

  const masterSeed = raw.masterSeed;
  if (typeof masterSeed !== "string") throw new P3EError("E_P3E_ARGUMENT", PATH_SEED);

  const peerGroup = buildPeerGroup(packs.base, packs.identity, {
    seed: masterSeed,
    playerSexPolicy: "random"
  } as never);
  const certificate = createBirthCertificate(packs.base, packs.identity, peerGroup, masterSeed);

  return restoreP3EPlaySessionPayload({
    payload: raw.payload,
    masterSeed,
    basePack: packs.base,
    identityPack: packs.identity,
    certificate,
    eventPack: packs.event,
    deathPack: packs.death
  });
}
