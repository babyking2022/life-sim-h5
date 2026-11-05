import {
  ascii,
  concatBytes,
  deriveDomainState,
  deriveEventRngState,
  FALLBACK_RNG_STATE,
  normalizeSeed,
  readU32be,
  seedDigest,
  sha256,
  u32be,
  Xoshiro128StarStar
} from "@life-sim/engine";
import {
  P3E_DEATH_DOMAIN,
  P3E_EVENT_DOMAIN,
  P3E_GENESIS_SEMANTIC_DRAWS,
  P3E_LIFESPAN_BURN_BOUND,
  P3E_LIFE_DOMAIN,
  P3E_RNG_SPEC_VERSION,
  type P3EDeathRngState,
  type P3EEventRngState,
  type P3ELifeRngState,
  type P3ERngState,
  type P3EWordTuple
} from "@life-sim/contracts";
import { P3EError } from "./errors";

/**
 * P3-E.1a-2a：三條 genesis RNG 游標。
 *
 * 本模組**只**建立 `P3ERngState`（life／events／death 的初始游標），沒有 roll、
 * 沒有 annual transaction、沒有 stateHash、沒有游標推進 API。
 *
 * ## 三條游標的規格（固定）
 *
 * | 游標 | 來源 | initialState | state | 計數 |
 * |---|---|---|---|---|
 * | life | `deriveDomainState(seed, "life", "1.0.0")` | burn **前** | burn **後** | `semanticDraws = 1` |
 * | events | `deriveEventRngState(life.initialState, birthYear)` | = state | 不 burn | `u32Draws = 0` |
 * | death | `deriveDomainState(seed, "p3e/death", "1.0.0")` | = state | 不 burn | `u32Draws = 0` |
 *
 * ## compatibility burn
 *
 * life 游標在 genesis 時**恰好**呼叫一次 `uniformBigInt(41n)` 並丟棄結果：
 * 不是燒一個 u32、不保存抽到的 0–40、不產生 `lifespanYears`。
 * 被丟棄的是「值」，`state` 仍然是實際推進後的 RNG state。
 *
 * ## 錯誤邊界
 *
 * 對外只拋 `P3EError`：非法 seed 一律 `E_P3E_ARGUMENT at seed`，
 * 非法 birthYear 一律 `E_P3E_ARGUMENT at birthYear`，
 * `deriveP3EDomainState` 的非法 domain／spec 一律 `E_P3E_RNG`。
 * engine 的 `SeedError`／`RngError` 與原生例外都不會外流（見下方「為什麼沒有 try/catch」）。
 */

/* ------------------------------------------------------------------ */
/* 固定常數（本模組專用，不進 contracts）                              */
/* ------------------------------------------------------------------ */

/** 與 P3-A／P3-C 相同的 birthYear 範圍（`assertBootstrap` 的 1800..2200）。 */
const MIN_BIRTH_YEAR = 1800;
const MAX_BIRTH_YEAR = 2200;
/** engine `deriveDomainState` 的 KDF 材料前綴（逐位元相同）。 */
const RNG_MATERIAL_DOMAIN = "LIFE1/RNG/v1";
/** Xoshiro128\*\* 的 stream seed 長度（16 bytes ＝ 4 個 u32）。 */
const STREAM_SEED_BYTES = 16;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把四個 u32 組成**凍結**的 tuple。
 *
 * 每個游標都拿到自己的 tuple 實例：`initialState` 與 `state` 不共用參考，
 * 因此不可能因為「共用同一個凍結陣列」而在未來改動時產生別名耦合。
 */
function freezeWords(first: number, second: number, third: number, fourth: number): P3EWordTuple {
  const words: [number, number, number, number] = [first, second, third, fourth];
  return Object.freeze(words);
}

/** seed 走 engine 的 `normalizeSeed`（NFC ＋ trim ＋ 128 bytes ＋ 控制字元），錯誤碼固定。 */
function readSeed(input: unknown): string {
  try {
    return normalizeSeed(input as string);
  } catch {
    throw new P3EError("E_P3E_ARGUMENT", "seed");
  }
}

/**
 * birthYear 必須是 `1800..2200` 的安全整數。
 *
 * 範圍與 P3-A 的 `assertBootstrap` 相同：P3-E 是獨立的權威狀態，但**不重新定義**
 * 「合法出生年」，否則同一張出生證書會得到兩套可行年份。
 */
function readBirthYear(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input)) {
    throw new P3EError("E_P3E_ARGUMENT", "birthYear");
  }
  if (input < MIN_BIRTH_YEAR || input > MAX_BIRTH_YEAR) {
    throw new P3EError("E_P3E_ARGUMENT", "birthYear");
  }
  return input;
}

/* ------------------------------------------------------------------ */
/* domain state 推導                                                   */
/* ------------------------------------------------------------------ */

/**
 * 把全零 state 換成 engine 的 fallback（與 `deriveDomainState` 的政策一致）。
 *
 * 抽成獨立函式是為了讓這個「幾乎不可能發生」的分支可以被直接測試，
 * 而不是留下無法覆蓋的死路徑。
 */
export function applyZeroStateFallback(words: P3EWordTuple): P3EWordTuple {
  if (words[0] !== 0 || words[1] !== 0 || words[2] !== 0 || words[3] !== 0) return words;
  const fallback = FALLBACK_RNG_STATE;
  return freezeWords(fallback[0], fallback[1], fallback[2], fallback[3]);
}

/**
 * 與 engine `deriveDomainState` **位元組佈局完全相同**的 domain state 推導：
 *
 * ```text
 * material  = "LIFE1/RNG/v1" ‖ 0x00 ‖ seedDigest(seed)
 *             ‖ u32be(len(domain)) ‖ domain ‖ u32be(len(spec)) ‖ spec
 * streamSeed = SHA-256(material) 的前 16 bytes
 * state      = 4 個 big-endian u32（全零則用 engine 的 FALLBACK_RNG_STATE）
 * ```
 *
 * 為什麼不用 engine 的 `deriveDomainState`：它在推導**之前**先驗證 domain 必須符合
 * `^[a-z0-9_]{1,32}$`，而 P3-E 裁決的 death domain 是 `"p3e/death"`（含 `/`），
 * 會被判成 `SeedError("BAD_DOMAIN")`。本函式因此保留同一套 KDF、只放寬 domain 字元集；
 * 對任何 engine 接受的 domain／spec，輸出與 `deriveDomainState` **逐位元相同**
 * （`rng.test.ts` 用多組 domain／spec 交叉固定在案）。
 */
export function deriveP3EDomainState(
  masterSeed: string,
  domain: string,
  spec: string = P3E_RNG_SPEC_VERSION
): P3EWordTuple {
  if (typeof domain !== "string" || domain.length === 0) throw new P3EError("E_P3E_RNG", "domain");
  if (typeof spec !== "string" || spec.length === 0) throw new P3EError("E_P3E_RNG", "spec");

  const seed = readSeed(masterSeed);
  const domainBytes = ascii(domain);
  const specBytes = ascii(spec);
  const material = concatBytes(
    ascii(RNG_MATERIAL_DOMAIN),
    Uint8Array.of(0),
    seedDigest(seed),
    u32be(domainBytes.length),
    domainBytes,
    u32be(specBytes.length),
    specBytes
  );
  const streamSeed = sha256(material).slice(0, STREAM_SEED_BYTES);
  const words = freezeWords(
    readU32be(streamSeed, 0),
    readU32be(streamSeed, 4),
    readU32be(streamSeed, 8),
    readU32be(streamSeed, 12)
  );
  return applyZeroStateFallback(words);
}

/* ------------------------------------------------------------------ */
/* genesis RNG                                                         */
/* ------------------------------------------------------------------ */

/**
 * 建立 P3-E genesis 的**三條** RNG 游標（純函式、深層凍結）。
 *
 * 呼叫順序就是規格順序（life → burn → events → death），任何一步失敗都不會回傳
 * 部分結果。回傳物件與每個游標、每個 tuple 都 `Object.freeze`。
 *
 * 刻意**不**從 `src/index.ts` 匯出：P3-E.1a-2a 只交付內部建立器，
 * 公開的 genesis 入口屬於後續批次。
 */
export function createP3EGenesisRng(masterSeed: string, birthYear: number): P3ERngState {
  const seed = readSeed(masterSeed);
  const year = readBirthYear(birthYear);

  /* --- life：burn 前的 state 是權威 initialState ------------------- */
  const preBurn = deriveDomainState(seed, P3E_LIFE_DOMAIN, P3E_RNG_SPEC_VERSION);
  const lifeInitialState = freezeWords(preBurn[0], preBurn[1], preBurn[2], preBurn[3]);

  const lifeCursor = new Xoshiro128StarStar([preBurn[0], preBurn[1], preBurn[2], preBurn[3]]);
  // compatibility burn：恰好一次 uniformBigInt(41n)，結果立刻丟棄。
  // 不保存抽到的 0–40、不推導 lifespanYears、不是「燒一個 u32」。
  lifeCursor.uniformBigInt(P3E_LIFESPAN_BURN_BOUND);
  const burned = lifeCursor.state;

  const life: P3ELifeRngState = Object.freeze({
    domain: P3E_LIFE_DOMAIN,
    initialState: lifeInitialState,
    state: freezeWords(burned[0], burned[1], burned[2], burned[3]),
    semanticDraws: P3E_GENESIS_SEMANTIC_DRAWS
  });

  /* --- events：輸入是 burn 前的 life state，不 burn ----------------- */
  const eventGenesis = deriveEventRngState(
    [preBurn[0], preBurn[1], preBurn[2], preBurn[3]],
    year
  );
  const events: P3EEventRngState = Object.freeze({
    domain: P3E_EVENT_DOMAIN,
    initialState: freezeWords(eventGenesis[0], eventGenesis[1], eventGenesis[2], eventGenesis[3]),
    state: freezeWords(eventGenesis[0], eventGenesis[1], eventGenesis[2], eventGenesis[3]),
    u32Draws: 0
  });

  /* --- death：獨立 domain，不 burn --------------------------------- */
  const deathGenesis = deriveP3EDomainState(seed, P3E_DEATH_DOMAIN, P3E_RNG_SPEC_VERSION);
  const death: P3EDeathRngState = Object.freeze({
    domain: P3E_DEATH_DOMAIN,
    initialState: deathGenesis,
    state: freezeWords(deathGenesis[0], deathGenesis[1], deathGenesis[2], deathGenesis[3]),
    u32Draws: 0
  });

  return Object.freeze({ life, events, death });
}
