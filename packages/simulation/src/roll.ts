import {
  P3E_EXPENSE_BASE_MICRO_USD,
  P3E_EXPENSE_PER_YEAR_MICRO_USD,
  P3E_INCOME_BASE_MICRO_USD,
  P3E_INCOME_PER_YEAR_MICRO_USD,
  P3E_LIFE_DOMAIN,
  P3E_MAX_AGE,
  P3E_MIN_AGE,
  P3E_ROLL_SEMANTIC_DRAWS,
  P3E_ROLL_SPEC_VERSION,
  P3E_ROLL_STEPS,
  P3E_STAT_MAX,
  P3E_STAT_MIN,
  type P3EAssets,
  type P3ELifeRngState,
  type P3ERollInput,
  type P3ERollResult,
  type P3EStats,
  type P3EWordTuple
} from "@life-sim/contracts";
import { MAX_MONEY_PPP_MICRO, MIN_MONEY_PPP_MICRO, Xoshiro128StarStar } from "@life-sim/engine";
import { P3EError } from "./errors";

/**
 * P3-E.1a-2b.1：`p3e-roll-1.0.0` 的決定性年度 roll（套件內部，**不進公開 barrel**）。
 *
 * 本模組只做「一年」的四狀態抽樣與收支結算：
 *
 * 1. 從 `input.lifeRng.state` 建立 `Xoshiro128StarStar`；
 * 2. 依序抽 health(−3..3)、happiness(−3..3)、knowledge(0..3)、relationships(−2..2)
 *    —— 恰好四次語意抽樣，順序與範圍來自 contracts 的 `P3E_ROLL_STEPS`；
 * 3. 四狀態 clamp 到 `P3E_STAT_MIN..P3E_STAT_MAX`；
 * 4. 收支用 contracts 的常數計算（不消耗 RNG）；
 * 5. life 游標：`state` 換成四次抽樣後的實際 state、`semanticDraws + 4`，
 *    `initialState` 原樣保留（不重推、不再次 burn）。
 *
 * ## 刻意不做
 *
 * 沒有 state／genesis／hash／ledger／codec／replay／command／年度事件交易；
 * 沒有逐年歷史、沒有把四次抽到的原始值寫進輸出。
 *
 * ## 邊界（P3-E.1a-2b.1 收緊）
 *
 * 輸入、輸出都是信任邊界：輸入走嚴格形狀驗證（不接受多餘／缺失欄位、陣列、
 * 非 plain prototype、accessor、已撤銷的 Proxy）。**所有反射動作（`Array.isArray`、
 * `Object.getPrototypeOf`、`Object.keys`、`getOwnPropertyNames`／`Symbols`、
 * `getOwnPropertyDescriptor`、索引與 `length` 讀取）都在例外邊界內**，
 * 任何原生例外都折成固定 `P3EError`。
 *
 * 對外只拋 `P3EError`（`E_P3E_VERSION`／`E_P3E_ROLL`／`E_P3E_RNG`／`E_P3E_MONEY`）；
 * engine 的 `RngError`／`MoneyError` 與任何原生例外都不會外流。
 */

/* ------------------------------------------------------------------ */
/* 固定錯誤 path（測試會鎖定）                                         */
/* ------------------------------------------------------------------ */

const PATH_INPUT = "input";
const PATH_ROLL_SPEC_VERSION = "rollSpecVersion";
const PATH_AGE = "age";
const PATH_STATS = "stats";
const PATH_BALANCE = "balanceMicroUsd";
const PATH_LIFE_RNG = "lifeRng";
const PATH_LIFE_RNG_DOMAIN = "lifeRng.domain";
const PATH_LIFE_RNG_INITIAL_STATE = "lifeRng.initialState";
const PATH_LIFE_RNG_STATE = "lifeRng.state";
const PATH_LIFE_RNG_SEMANTIC_DRAWS = "lifeRng.semanticDraws";
/** 年度結算後的餘額超出 Money 上界。 */
const PATH_ASSETS_BALANCE = "assets.balanceMicroUsd";
/** RNG 建立／推進失敗（engine 例外一律折到這裡）。 */
const PATH_RNG = "rng";

const U32_MAX = 0xffffffff;

const ROLL_INPUT_KEYS = ["rollSpecVersion", "age", "stats", "balanceMicroUsd", "lifeRng"] as const;
const STAT_KEYS = ["health", "happiness", "knowledge", "relationships"] as const;
const LIFE_RNG_KEYS = ["domain", "initialState", "state", "semanticDraws"] as const;

const STAT_PATHS = {
  health: "stats.health",
  happiness: "stats.happiness",
  knowledge: "stats.knowledge",
  relationships: "stats.relationships"
} as const;

/* ------------------------------------------------------------------ */
/* 嚴格形狀讀取                                                        */
/* ------------------------------------------------------------------ */

/**
 * 一次讀完「原型、自有可列舉鍵、各鍵值、自有鍵總數」。
 *
 * - 只讀**一次**：之後全部用快照驗證，因此 getter 不會被呼叫兩次（沒有 TOCTOU）。
 * - **整個探測過程都在例外邊界內**：`typeof`、`Array.isArray`、`Object.getPrototypeOf`、
 *   `Object.keys`、`Object.getOwnPropertyNames`／`getOwnPropertySymbols`、欄位讀取
 *   任何一步拋出的原生例外（含**已撤銷的 Proxy**）都只會得到 `null`，
 *   呼叫端再折成固定 `P3EError`。
 * - 只接受 `Object.prototype` 或 `null` 作為原型；class 實例、`Object.create({})`
 *   一律拒絕（避免繼承來的欄位冒充權威輸入）。
 * - `ownCount` 連**不可列舉**與 **symbol** 的自有鍵一起算，補上
 *   「`Object.keys` 看不到的額外欄位」這個縫。
 */
interface Snapshot {
  readonly proto: object | null;
  readonly keys: readonly string[];
  readonly values: readonly unknown[];
  readonly ownCount: number;
}

function snapshot(value: unknown, path: string): Snapshot {
  let snap: Snapshot | null = null;
  try {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const target = value as Record<string, unknown>;
      const proto = Object.getPrototypeOf(target) as object | null;
      const keys = Object.keys(target);
      const ownCount = Object.getOwnPropertyNames(target).length + Object.getOwnPropertySymbols(target).length;
      const values: unknown[] = [];
      for (const key of keys) values.push(target[key]);
      snap = { proto, keys, values, ownCount };
    }
  } catch {
    snap = null;
  }
  if (snap === null) throw new P3EError("E_P3E_ROLL", path);
  return snap;
}

function assertPlainPrototype(snap: Snapshot, path: string): void {
  if (snap.proto !== null && snap.proto !== Object.prototype) throw new P3EError("E_P3E_ROLL", path);
}

/**
 * 鍵集合必須與契約完全一致：多一個（含不可列舉／symbol 鍵）、少一個都不接受。
 */
function assertExactKeys(snap: Snapshot, path: string, expected: readonly string[]): void {
  if (snap.ownCount !== expected.length) throw new P3EError("E_P3E_ROLL", path);
  if (snap.keys.length !== expected.length) throw new P3EError("E_P3E_ROLL", path);
  for (const key of expected) {
    if (!snap.keys.includes(key)) throw new P3EError("E_P3E_ROLL", path);
  }
}

function toRecord(snap: Snapshot): Record<string, unknown> {
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < snap.keys.length; index += 1) {
    record[snap.keys[index] as string] = snap.values[index];
  }
  return record;
}

/* ------------------------------------------------------------------ */
/* 欄位驗證                                                            */
/* ------------------------------------------------------------------ */

function readRollSpecVersion(value: unknown): typeof P3E_ROLL_SPEC_VERSION {
  if (value !== P3E_ROLL_SPEC_VERSION) throw new P3EError("E_P3E_VERSION", PATH_ROLL_SPEC_VERSION);
  return P3E_ROLL_SPEC_VERSION;
}

function readAge(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new P3EError("E_P3E_ROLL", PATH_AGE);
  if (value < P3E_MIN_AGE || value > P3E_MAX_AGE) throw new P3EError("E_P3E_ROLL", PATH_AGE);
  return value;
}

function readStatValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new P3EError("E_P3E_ROLL", path);
  if (value < P3E_STAT_MIN || value > P3E_STAT_MAX) throw new P3EError("E_P3E_ROLL", path);
  return value;
}

function readStats(value: unknown): P3EStats {
  const snap = snapshot(value, PATH_STATS);
  assertPlainPrototype(snap, PATH_STATS);
  assertExactKeys(snap, PATH_STATS, STAT_KEYS);
  const record = toRecord(snap);
  return {
    health: readStatValue(record.health, STAT_PATHS.health),
    happiness: readStatValue(record.happiness, STAT_PATHS.happiness),
    knowledge: readStatValue(record.knowledge, STAT_PATHS.knowledge),
    relationships: readStatValue(record.relationships, STAT_PATHS.relationships)
  };
}

/**
 * `balanceMicroUsd` 的信任邊界（H5-CTO-054-A-R1 裁決）：
 *
 * - 必須是 `bigint`（number 一律拒絕）；
 * - **允許負值**（P3-B 的事件效果可以造成淨負債），但必須落在既有 Money 契約的
 *   `MIN_MONEY_PPP_MICRO..MAX_MONEY_PPP_MICRO` 之內；
 * - 不是 bigint → `E_P3E_ROLL`；超出 Money 上下界 → `E_P3E_MONEY`。
 */
function readBalance(value: unknown): bigint {
  if (typeof value !== "bigint") throw new P3EError("E_P3E_ROLL", PATH_BALANCE);
  if (value < MIN_MONEY_PPP_MICRO || value > MAX_MONEY_PPP_MICRO) {
    throw new P3EError("E_P3E_MONEY", PATH_BALANCE);
  }
  return value;
}

function readWord(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new P3EError("E_P3E_ROLL", path);
  if (value < 0 || value > U32_MAX) throw new P3EError("E_P3E_ROLL", path);
  return value;
}

/** 合法四元素 tuple 的自有字串鍵：密集索引 `0..3` ＋ 陣列自己的 `length`。 */
const WORD_TUPLE_KEYS = ["0", "1", "2", "3", "length"] as const;
const WORD_INDEX_KEYS = ["0", "1", "2", "3"] as const;

/**
 * 把 tuple 讀成「四個原始值」，任何反射失敗都回 `null`。
 *
 * - `Array.isArray`、`length` 讀取、`getOwnPropertySymbols`、`getOwnPropertyNames`、
 *   `getOwnPropertyDescriptor` 全部在例外邊界內：已撤銷的 Proxy、會拋錯的
 *   `length`／索引 getter、會拋錯的 `ownKeys` trap 都只會得到 `null`。
 * - 必須是**密集**四元素陣列：自有字串鍵恰為 `0..3` ＋ `length`；
 *   額外字串鍵、不可列舉的隱藏鍵、symbol 鍵一律拒絕。
 * - 四個元素必須是 **data property**：accessor（throwing getter）一律拒絕，
 *   而且**連呼叫都不會發生**（不會執行呼叫端的程式碼）。
 */
function snapshotWords(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (value.length !== 4) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== WORD_TUPLE_KEYS.length) return null;
    for (const key of WORD_TUPLE_KEYS) {
      if (!names.includes(key)) return null;
    }
    const words: unknown[] = [];
    for (const key of WORD_INDEX_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      words.push(descriptor.value);
    }
    return words;
  } catch {
    return null;
  }
}

/** 四個合法 u32，且**不得全零**（全零不是合法的 Xoshiro 游標）。 */
function readWords(value: unknown, path: string): P3EWordTuple {
  const raw = snapshotWords(value);
  if (raw === null) throw new P3EError("E_P3E_ROLL", path);
  const first = readWord(raw[0], path);
  const second = readWord(raw[1], path);
  const third = readWord(raw[2], path);
  const fourth = readWord(raw[3], path);
  if (first === 0 && second === 0 && third === 0 && fourth === 0) throw new P3EError("E_P3E_ROLL", path);
  const words: [number, number, number, number] = [first, second, third, fourth];
  return Object.freeze(words);
}

function readSemanticDraws(value: unknown): number {
  const path = PATH_LIFE_RNG_SEMANTIC_DRAWS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new P3EError("E_P3E_ROLL", path);
  // +4 之後仍必須是安全整數，否則游標會計會靜默失真。
  if (!Number.isSafeInteger(value + P3E_ROLL_SEMANTIC_DRAWS)) throw new P3EError("E_P3E_ROLL", path);
  return value;
}

function readLifeRng(value: unknown): P3ELifeRngState {
  const snap = snapshot(value, PATH_LIFE_RNG);
  assertPlainPrototype(snap, PATH_LIFE_RNG);
  assertExactKeys(snap, PATH_LIFE_RNG, LIFE_RNG_KEYS);
  const record = toRecord(snap);
  if (record.domain !== P3E_LIFE_DOMAIN) throw new P3EError("E_P3E_ROLL", PATH_LIFE_RNG_DOMAIN);
  return {
    domain: P3E_LIFE_DOMAIN,
    initialState: readWords(record.initialState, PATH_LIFE_RNG_INITIAL_STATE),
    state: readWords(record.state, PATH_LIFE_RNG_STATE),
    semanticDraws: readSemanticDraws(record.semanticDraws)
  };
}

/* ------------------------------------------------------------------ */
/* RNG：四次語意抽樣                                                   */
/* ------------------------------------------------------------------ */

/** 四次抽樣的原始增量與抽樣後的權威 state（只在記憶體中流動，不進輸出）。 */
export interface P3ERollDraws {
  readonly health: number;
  readonly happiness: number;
  readonly knowledge: number;
  readonly relationships: number;
  readonly state: P3EWordTuple;
}

/**
 * 從 `state` 起算，嚴格依 `P3E_ROLL_STEPS` 的順序與範圍做**四次**語意抽樣。
 *
 * - 順序／範圍直接取自 contracts，沒有重新寫 `-3／3／0／2` 之類的字面值；
 * - 不自行取模、不硬編碼 u32 消耗量（實際次數由 `uniformInt`／`uniformBigInt` 決定）；
 * - engine 的任何例外（`RngError` 等）都折成 `E_P3E_RNG`。
 *
 * 這是套件內部函式（不進 barrel）；公開入口 `resolveP3ERoll` 已經先驗證過 state，
 * 這裡再做一次轉譯只是為了讓「RNG 邊界」可以獨立測試。
 */
export function drawP3ERollDeltas(state: P3EWordTuple): P3ERollDraws {
  try {
    const rng = new Xoshiro128StarStar([state[0], state[1], state[2], state[3]]);
    const health = rng.uniformInt(P3E_ROLL_STEPS[0].min, P3E_ROLL_STEPS[0].max);
    const happiness = rng.uniformInt(P3E_ROLL_STEPS[1].min, P3E_ROLL_STEPS[1].max);
    const knowledge = rng.uniformInt(P3E_ROLL_STEPS[2].min, P3E_ROLL_STEPS[2].max);
    const relationships = rng.uniformInt(P3E_ROLL_STEPS[3].min, P3E_ROLL_STEPS[3].max);
    const after = rng.state;
    const words: [number, number, number, number] = [after[0], after[1], after[2], after[3]];
    return { health, happiness, knowledge, relationships, state: Object.freeze(words) };
  } catch {
    throw new P3EError("E_P3E_RNG", PATH_RNG);
  }
}

/* ------------------------------------------------------------------ */
/* 收支（不消耗 RNG）                                                  */
/* ------------------------------------------------------------------ */

/**
 * `p3e-roll-1.0.0` 的收支（H5-CTO-054-A-R1 裁決版）：
 *
 * ```text
 * income  = P3E_INCOME_BASE_MICRO_USD  + BigInt(age) × P3E_INCOME_PER_YEAR_MICRO_USD
 * expense = P3E_EXPENSE_BASE_MICRO_USD + BigInt(age) × P3E_EXPENSE_PER_YEAR_MICRO_USD
 * net     = previousBalance + income − expense
 * balance = max(0n, net)
 * ```
 *
 * - `annualIncomeMicroUsd`／`annualExpenseMicroUsd` **永遠是完整公式值**；
 *   只有 `balanceMicroUsd` 會被截到 `0n`，支出不會被改寫成「實際可扣金額」。
 * - `previousBalance` **可以是負值**（淨負債）：`net < 0` 時輸出 `0n`。
 * - 結算結果不得超過 `MAX_MONEY_PPP_MICRO`，否則 `E_P3E_MONEY at assets.balanceMicroUsd`。
 *   （`balance` 恆為非負，因此不需要檢查下界。）
 *
 * 本函式只做公式與輸出上界，不驗證 `age`／`previousBalance` 的型別——
 * 那些由公開入口的 `readAge`／`readBalance` 負責。
 */
export function computeP3ERollAssets(age: number, previousBalanceMicroUsd: bigint): P3EAssets {
  const years = BigInt(age);
  const annualIncomeMicroUsd = P3E_INCOME_BASE_MICRO_USD + years * P3E_INCOME_PER_YEAR_MICRO_USD;
  const annualExpenseMicroUsd = P3E_EXPENSE_BASE_MICRO_USD + years * P3E_EXPENSE_PER_YEAR_MICRO_USD;
  const net = previousBalanceMicroUsd + annualIncomeMicroUsd - annualExpenseMicroUsd;
  const balanceMicroUsd = net < 0n ? 0n : net;
  if (balanceMicroUsd > MAX_MONEY_PPP_MICRO) throw new P3EError("E_P3E_MONEY", PATH_ASSETS_BALANCE);
  return { balanceMicroUsd, annualIncomeMicroUsd, annualExpenseMicroUsd };
}

/* ------------------------------------------------------------------ */
/* 公開入口（套件內部；不進 barrel）                                    */
/* ------------------------------------------------------------------ */

/**
 * 決定性年度 roll。純函式、不改輸入、輸出深層凍結。
 *
 * 驗證順序（path 由測試鎖定）：
 * `input` → `rollSpecVersion` → `age` → `stats` → `balanceMicroUsd` → `lifeRng`
 * → RNG（`E_P3E_RNG at rng`）→ 收支輸出上界（`E_P3E_MONEY at assets.balanceMicroUsd`）。
 */
export function resolveP3ERoll(input: P3ERollInput): P3ERollResult {
  const top = snapshot(input, PATH_INPUT);
  assertPlainPrototype(top, PATH_INPUT);
  assertExactKeys(top, PATH_INPUT, ROLL_INPUT_KEYS);
  const record = toRecord(top);

  const rollSpecVersion = readRollSpecVersion(record.rollSpecVersion);
  const age = readAge(record.age);
  const stats = readStats(record.stats);
  const balanceMicroUsd = readBalance(record.balanceMicroUsd);
  const lifeRng = readLifeRng(record.lifeRng);

  const draws = drawP3ERollDeltas(lifeRng.state);
  const nextStats: P3EStats = {
    health: clampStat(stats.health + draws.health),
    happiness: clampStat(stats.happiness + draws.happiness),
    knowledge: clampStat(stats.knowledge + draws.knowledge),
    relationships: clampStat(stats.relationships + draws.relationships)
  };
  const nextAssets = computeP3ERollAssets(age, balanceMicroUsd);
  const nextLifeRng: P3ELifeRngState = {
    domain: P3E_LIFE_DOMAIN,
    initialState: copyWords(lifeRng.initialState),
    state: copyWords(draws.state),
    semanticDraws: lifeRng.semanticDraws + P3E_ROLL_SEMANTIC_DRAWS
  };

  return Object.freeze({
    rollSpecVersion,
    stats: Object.freeze(nextStats),
    assets: Object.freeze(nextAssets),
    lifeRng: Object.freeze(nextLifeRng),
    semanticDrawsUsed: P3E_ROLL_SEMANTIC_DRAWS
  });
}

function clampStat(value: number): number {
  return Math.max(P3E_STAT_MIN, Math.min(P3E_STAT_MAX, value));
}

/** 輸出永遠持有自己的 tuple（不與輸入共用可觀察參考）。 */
function copyWords(words: P3EWordTuple): P3EWordTuple {
  const copy: [number, number, number, number] = [words[0], words[1], words[2], words[3]];
  return Object.freeze(copy);
}
