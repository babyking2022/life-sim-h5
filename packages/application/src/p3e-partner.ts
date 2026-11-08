import { deriveDomainState, Xoshiro128StarStar } from "@life-sim/engine";
import type { ValidatedIdentityPack } from "@life-sim/birth";

/**
 * GPT-DEEPSEEK-0036-A／0037-A｜具名伴侶（partner identity）presentation projection。
 *
 * ## 為什麼放在 application 而不是 canonical state
 *
 * 伴侶是「可從 command log 重建的呈現事實」，不是模擬規則：把它塞進
 * `P3ELifeState` 會同時改動 state shape、codec wire、save format 與所有 golden hash。
 * 因此這裡跟 `lifeLog` 一樣，只提供 application 的 view 投影：
 *
 * - 由 `masterSeed` ＋「關係事件的 eventId／decision／option」＋ 年份做**獨立 domain**
 *   推導，不消耗、也不改變正式年度 RNG（`life`／`events`／`p3e/death` 完全不動）；
 * - 同 seed、同 command log → 同一個姓名；save／load／replay 後由 `outcomes` 重建，
 *   逐位元相同；
 * - 姓名取自既有 `fixtures/p2b/name-corpus.v1.json`（`identityPack.namePoolsByCulture`），
 *   依玩家出生文化的姓名池抽樣；找不到文化池時用穩定的 `han` 池 fallback；
 * - 舊存檔沒有 partner 欄位也能載入（沒有關係事件 → `null`；有 → 由 command log 重建）。
 *
 * ## 關係轉移表（GPT-DEEPSEEK-0037-A：event＋decision＋option 三重驗證）
 *
 * | eventId | decisionId | optionId | 轉移 |
 * | --- | --- | --- | --- |
 * | `ev.teen.first-love` | `dec.teen.first-love` | `date` | 建立伴侶（`dating`） |
 * | `ev.adult.relationship` | `dec.adult.relationship` | `cohabit` | 升級為 `partner`（同一人，姓名不變） |
 * | `ev.adult.relationship` | `dec.adult.relationship` | `marry` | 升級為 `spouse`（同一人，姓名不變） |
 * | `ev.adult.relationship` | `dec.adult.relationship` | `single` | **清除伴侶（`null`）** |
 *
 * - 只有**完全符合** `eventId ＋ decisionId ＋ optionId` 才會轉移；decision／option 相同
 *   但 eventId 不符（自訂 pack、重用 id）一律視為無關事件，不建立、不升級、也不清除。
 * - 其他事件／選項（`focus`／`secret`／拒絕類）不影響既有伴侶。
 * - 轉移依 command log 的**時間順序**套用：建立 → 升級 → 清除；清除後再建立就是新對象
 *   （姓名由新的關係重新推導）。
 */

/** 伴侶姓名推導用的獨立 RNG 版本。 */
export const P3E_PARTNER_SPEC_VERSION = "p3e-partner-1.2.0";

/**
 * 同名避免的最大嘗試次數（GPT-0046-B）。
 *
 * 姓名語料每個文化只有 6 姓氏 × 6 異性 given（36 種組合）。當一位玩家經歷多次關係，
 * 新伴侶可能抽到與先前伴侶相同的名字。為避免「不同關係同名」，我們在**獨立 domain**
 * 的 KDF 輸入後附加 `attempt` 序數，依序嘗試其他姓名（不消耗、也不改變正式年度 RNG）。
 *
 * 上限取 64，遠大於任何單一文化的組合數；正常情況下遠早於上限就會找到不重複的名字。
 * 若語料真的耗盡（極端多段關係），回退到 `attempt=0` 的姓名（穩定、確定性、不洩漏 internal key）。
 */
export const P3E_PARTNER_NAME_MAX_ATTEMPTS = 64;

/** 伴侶姓名推導的 engine domain（與 `life`／`events`／`p3e/death` 分離）。 */
export const P3E_PARTNER_DOMAIN = "partner";

/** 關係狀態（可擴充）。 */
export type P3ELifePartnerStatus = "dating" | "partner" | "spouse";

/** `P3ELifePartnerStatus` 的完整清單（順序 = 關係推進順序）。 */
export const P3E_LIFE_PARTNER_STATUSES: readonly P3ELifePartnerStatus[] = Object.freeze([
  "dating",
  "partner",
  "spouse"
]);

/** 一個穩定、可重建的伴侶身分。 */
export interface P3ELifePartner {
  /** 顯示名稱（例：`陳怡君`／`Emma Wilson`），來自姓名語料。 */
  readonly displayName: string;
  readonly givenName: string;
  readonly surname: string;
  readonly cultureId: string;
  readonly status: P3ELifePartnerStatus;
  /** 關係建立的年份（`currentYear`）。 */
  readonly sinceYear: number;
  /** 建立關係的 event／decision／option（UI 可用來查文案）。 */
  readonly eventId: string;
  readonly decisionId: string;
  readonly optionId: string;
  readonly specVersion: string;
}

/** 一次關係轉移：建立（含狀態）或清除。 */
export type P3ELifePartnerTransition =
  | { readonly kind: "create"; readonly status: P3ELifePartnerStatus }
  | { readonly kind: "clear" };

/** 轉移表的 key：`eventId|decisionId|optionId`（三名一起比對）。 */
export function partnerTransitionKey(eventId: string, decisionId: string, optionId: string): string {
  return `${eventId}|${decisionId}|${optionId}`;
}

/** 權威轉移表（依 fixtures/p3b/events.v1.json 的真實 eventId／decisionId／optionId／flags）。 */
export const P3E_PARTNER_TRANSITIONS: Readonly<Record<string, P3ELifePartnerTransition>> = Object.freeze({
  [partnerTransitionKey("ev.teen.first-love", "dec.teen.first-love", "date")]: Object.freeze({
    kind: "create",
    status: "dating"
  }),
  [partnerTransitionKey("ev.adult.relationship", "dec.adult.relationship", "cohabit")]: Object.freeze({
    kind: "create",
    status: "partner"
  }),
  [partnerTransitionKey("ev.adult.relationship", "dec.adult.relationship", "marry")]: Object.freeze({
    kind: "create",
    status: "spouse"
  }),
  [partnerTransitionKey("ev.adult.relationship", "dec.adult.relationship", "single")]: Object.freeze({
    kind: "clear"
  })
});

/**
 * 依 `eventId ＋ decisionId ＋ optionId` 查轉移；不符合（含 eventId 不符）→ `null`。
 *
 * 這正是「不得只比 decisionId＋optionId」的關鍵：自訂 event pack 或未來重用
 * decision id 時，eventId 不同就不會被誤判成關係事件。
 */
export function partnerTransitionFromChoice(
  eventId: string,
  decisionId: string,
  optionId: string
): P3ELifePartnerTransition | null {
  const key = partnerTransitionKey(eventId, decisionId, optionId);
  const transition = P3E_PARTNER_TRANSITIONS[key];
  return transition === undefined ? null : transition;
}

/** `decisionId:optionId` → 狀態（給 UI／測試查「這個選項代表哪種關係」）。 */
export const P3E_PARTNER_OPTION_STATUS: Readonly<Record<string, P3ELifePartnerStatus>> = Object.freeze({
  "dec.teen.first-love:date": "dating",
  "dec.adult.relationship:cohabit": "partner",
  "dec.adult.relationship:marry": "spouse"
});

/** 一次「做了選擇」的權威事實（從 command log／outcome 來，不從 UI 來）。 */
export interface P3EPartnerChoice {
  readonly eventId: string;
  readonly decisionId: string;
  readonly optionId: string;
  readonly year: number;
}

/** 取樣時使用的性別（伴侶對玩家的相反性別）。 */
type PartnerSex = "female" | "male";

const PARTNER_SPEC = "1.0.0";

/** 文化池缺失時的穩定 fallback（語料一定有 `han`）。 */
const FALLBACK_CULTURE_ID = "han";

function oppositeSex(playerSex: string): PartnerSex {
  return playerSex === "female" ? "male" : "female";
}

/**
 * 由 seed ＋ 第一段關係推導「獨立」RNG 游標：
 *
 * ```text
 * seedText = `${masterSeed}|partner|${eventId}|${decisionId}|${optionId}|${sinceYear}|${attempt}`
 * state    = deriveDomainState(seedText, "partner", "1.0.0")
 * ```
 *
 * 只用第一段關係當種子，因此「交往 → 同居 → 結婚」的姓名不會改變，只有 `status` 升級；
 * 清除後再建立的新關係會用新的 seedText，因此會是不同的人。
 * `attempt` 用於 GPT-0046-B 的同名避免：依序嘗試不同的獨立 domain 輸入，直到抽到不重複的名字。
 */
function partnerRng(masterSeed: string, eventId: string, decisionId: string, optionId: string, sinceYear: number, attempt: number): Xoshiro128StarStar {
  const seedText = `${masterSeed}|partner|${eventId}|${decisionId}|${optionId}|${sinceYear}|${attempt}`;
  const state = deriveDomainState(seedText, P3E_PARTNER_DOMAIN, PARTNER_SPEC);
  // 與年度 RNG 同一個演算法（Xoshiro128**），但游標完全獨立、不影響正式 RNG 序列。
  return new Xoshiro128StarStar([state[0], state[1], state[2], state[3]]);
}

interface NamePools {
  readonly surname: readonly string[];
  readonly female: readonly string[];
  readonly male: readonly string[];
}

interface CultureProfile {
  readonly script: string;
  readonly surnameOrder: "family_first" | "given_first";
}

function readPools(pack: ValidatedIdentityPack, cultureId: string): NamePools | null {
  const pools = (pack.namePoolsByCulture as Record<string, NamePools | undefined>)[cultureId];
  if (pools === undefined) return null;
  if (pools.surname.length === 0) return null;
  return pools;
}

function readProfile(pack: ValidatedIdentityPack, cultureId: string): CultureProfile | null {
  const profile = (pack.profileByCulture as unknown as Record<string, (CultureProfile & Record<string, unknown>) | undefined>)[cultureId];
  if (profile === undefined) return null;
  return { script: profile.script, surnameOrder: profile.surnameOrder };
}

/** 穩定 fallback：用 `han` 池（語料一定有），確保任何情況都能產生姓名。 */
function resolveCulture(pack: ValidatedIdentityPack, cultureId: string): { cultureId: string; pools: NamePools; profile: CultureProfile } {
  const requestedPools = readPools(pack, cultureId);
  const requestedProfile = readProfile(pack, cultureId);
  if (requestedPools !== null && requestedProfile !== null) {
    return { cultureId, pools: requestedPools, profile: requestedProfile };
  }
  const fallbackPools = readPools(pack, FALLBACK_CULTURE_ID);
  const fallbackProfile = readProfile(pack, FALLBACK_CULTURE_ID);
  if (fallbackPools === null || fallbackProfile === null) {
    throw new Error("E_P3E_PARTNER_NAME_POOL");
  }
  return { cultureId: FALLBACK_CULTURE_ID, pools: fallbackPools, profile: fallbackProfile };
}

/** 由獨立 RNG 抽姓氏與名字（兩次 draw，與出生姓名同一套語料）。`attempt` 用於同名避免。 */
function drawName(
  pack: ValidatedIdentityPack,
  playerCultureId: string,
  playerSex: string,
  masterSeed: string,
  eventId: string,
  decisionId: string,
  optionId: string,
  sinceYear: number,
  attempt: number
): { displayName: string; givenName: string; surname: string; cultureId: string } {
  const culture = resolveCulture(pack, playerCultureId);
  const rng = partnerRng(masterSeed, eventId, decisionId, optionId, sinceYear, attempt);
  const givenPool = oppositeSex(playerSex) === "female" ? culture.pools.female : culture.pools.male;
  const surname = culture.pools.surname[Number(rng.uniformBigInt(BigInt(culture.pools.surname.length)))] as string;
  const givenName = givenPool[Number(rng.uniformBigInt(BigInt(givenPool.length)))] as string;
  const displayName =
    culture.profile.surnameOrder === "family_first" ? `${surname}${givenName}` : `${givenName} ${surname}`;
  return { displayName, givenName, surname, cultureId: culture.cultureId };
}

/**
 * GPT-0046-B：依序嘗試，直到抽到一個不在 `forbiddenNames` 的姓名。
 *
 * - 每次 `attempt` 改變 KDF 輸入（`seedText` 尾端的 `attempt` 序數），因此每個 attempt 都是
 *   **獨立 deterministic domain** 的另一次抽樣；不消耗、也不改變正式年度 RNG
 *   （`life`／`events`／`p3e/death` 完全不動）。
 * - 同一組輸入（masterSeed＋第一段關係座標＋forbiddenNames）永遠得到同一個姓名，
 *   因此 save／load／replay 後逐位元一致。
 * - `forbiddenNames` = 這位玩家「歷史上所有伴侶」的顯示名（含已結束的），新伴侶不得與之重複。
 * - 語料耗盡（`attempt` 用盡仍未找到不重複的名字）時，回退到 `attempt=0` 的姓名：
 *   穩定、確定性、不洩漏任何 internal key（例如不會顯示 `伴侶2`）。
 */
function derivePartnerName(
  pack: ValidatedIdentityPack,
  playerCultureId: string,
  playerSex: string,
  masterSeed: string,
  eventId: string,
  decisionId: string,
  optionId: string,
  sinceYear: number,
  forbiddenNames: readonly string[]
): { displayName: string; givenName: string; surname: string; cultureId: string } {
  const chosen = drawName(pack, playerCultureId, playerSex, masterSeed, eventId, decisionId, optionId, sinceYear, 0);
  if (!forbiddenNames.includes(chosen.displayName)) return chosen;
  for (let attempt = 1; attempt < P3E_PARTNER_NAME_MAX_ATTEMPTS; attempt += 1) {
    const candidate = drawName(pack, playerCultureId, playerSex, masterSeed, eventId, decisionId, optionId, sinceYear, attempt);
    if (!forbiddenNames.includes(candidate.displayName)) return candidate;
  }
  // 穩定 fallback：極端情況下語料耗盡，回傳 attempt=0 的姓名（與任何輸入確定性對應）。
  return chosen;
}

/**
 * 建立伴侶身分（純函式、深層凍結）。
 *
 * @param input.first 第一段關係（決定姓名與 `sinceYear`）
 * @param input.latestStatus 最新狀態（同居／結婚會升級）
 * @param input.forbiddenNames 這位玩家歷史上所有伴侶的顯示名（含已結束），新伴侶不得與之重複
 *   （GPT-0046-B 同名避免）。省略時視為空集合（即第一段關係不受限）。
 */
export function buildP3ELifePartner(input: {
  readonly masterSeed: string;
  readonly identityPack: ValidatedIdentityPack;
  readonly cultureId: string;
  readonly playerSex: string;
  readonly first: P3EPartnerChoice;
  readonly latestStatus: P3ELifePartnerStatus;
  readonly forbiddenNames?: readonly string[];
}): P3ELifePartner {
  const name = derivePartnerName(
    input.identityPack,
    input.cultureId,
    input.playerSex,
    input.masterSeed,
    input.first.eventId,
    input.first.decisionId,
    input.first.optionId,
    input.first.year,
    input.forbiddenNames ?? []
  );
  return Object.freeze({
    displayName: name.displayName,
    givenName: name.givenName,
    surname: name.surname,
    cultureId: name.cultureId,
    status: input.latestStatus,
    sinceYear: input.first.year,
    eventId: input.first.eventId,
    decisionId: input.first.decisionId,
    optionId: input.first.optionId,
    specVersion: P3E_PARTNER_SPEC_VERSION
  });
}

interface PartnerResolveContext {
  readonly masterSeed: string;
  readonly identityPack: ValidatedIdentityPack;
  readonly cultureId: string;
  readonly playerSex: string;
}

/**
 * 由「逐命令選擇」重建伴侶（restore 路徑；也適用於任何持有完整 command log 的地方）。
 *
 * 依序套用 `P3E_PARTNER_TRANSITIONS`：
 * - `create` 且目前無伴侶 → 建立新對象，並把其姓名加入 `usedNames`，後續關係不得重複；
 * - `create` 且已有伴侶 → 只升級狀態（姓名不變，絕不重抽）；
 * - `clear`（`single`）→ 伴侶清成 `null`，但 `usedNames` 保留其姓名（新關係不得與之同名）。
 *
 * 因為 `buildP3ELifePartner` 是同 seed＋command log 的純函式，且 `usedNames` 完全由
 * 選擇序列決定，故存檔／重播後逐位元一致（GPT-0046-B：不同關係姓名必須不同）。
 */
export function resolveP3ELifePartner(input: PartnerResolveContext & { readonly choices: readonly P3EPartnerChoice[] }): P3ELifePartner | null {
  const usedNames: string[] = [];
  let current: P3ELifePartner | null = null;
  for (const choice of input.choices) {
    const transition = partnerTransitionFromChoice(choice.eventId, choice.decisionId, choice.optionId);
    if (transition === null) continue;
    if (transition.kind === "clear") {
      current = null;
      continue;
    }
    if (current === null) {
      current = buildP3ELifePartner({
        masterSeed: input.masterSeed,
        identityPack: input.identityPack,
        cultureId: input.cultureId,
        playerSex: input.playerSex,
        first: choice,
        latestStatus: transition.status,
        forbiddenNames: usedNames
      });
      usedNames.push(current.displayName);
      continue;
    }
    // 已有伴侶：只升級狀態，姓名保持不變（絕不重抽、絕不改寫前任姓名）。
    if (P3E_LIFE_PARTNER_STATUSES.indexOf(transition.status) > P3E_LIFE_PARTNER_STATUSES.indexOf(current.status)) {
      current = Object.freeze({ ...current, status: transition.status });
    }
  }
  return current;
}

/**
 * 即時路徑：上一個 view 的伴侶 ＋ 本次選擇。
 *
 * - 無關選擇 → 原樣回傳 `previous`（不清除、不改名）；
 * - `single` → `null`（立即清除，不保留舊伴侶）；
 * - `create` → 沒有伴侶時建立（依 `forbiddenNames` 避免與歷史伴侶同名）；
 *   已有伴侶時只升級同一人的 status（姓名不變，絕不重抽、絕不改寫前任姓名）。
 *
 * @param input.forbiddenNames 這位玩家歷史上所有伴侶的顯示名（含已結束），新伴侶不得與之重複。
 */
export function advanceP3ELifePartner(
  input: PartnerResolveContext & {
    readonly previous: P3ELifePartner | null;
    readonly choice: P3EPartnerChoice;
    readonly forbiddenNames?: readonly string[];
  }
): P3ELifePartner | null {
  const transition = partnerTransitionFromChoice(input.choice.eventId, input.choice.decisionId, input.choice.optionId);
  if (transition === null) return input.previous;
  if (transition.kind === "clear") return null;
  if (input.previous === null) {
    return buildP3ELifePartner({
      masterSeed: input.masterSeed,
      identityPack: input.identityPack,
      cultureId: input.cultureId,
      playerSex: input.playerSex,
      first: input.choice,
      latestStatus: transition.status,
      forbiddenNames: input.forbiddenNames ?? []
    });
  }
  const upgraded =
    P3E_LIFE_PARTNER_STATUSES.indexOf(transition.status) > P3E_LIFE_PARTNER_STATUSES.indexOf(input.previous.status)
      ? transition.status
      : input.previous.status;
  // 升級只改 status，姓名保持不變（不重抽、不改寫前任姓名）。
  return Object.freeze({ ...input.previous, status: upgraded });
}

/** 兼容型 type guard（UI 可漸進採用）。 */
export function isP3ELifePartner(value: unknown): value is P3ELifePartner {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.displayName !== "string" || record.displayName.length === 0) return false;
  if (typeof record.status !== "string" || !(P3E_LIFE_PARTNER_STATUSES as readonly string[]).includes(record.status)) return false;
  if (typeof record.sinceYear !== "number" || !Number.isSafeInteger(record.sinceYear)) return false;
  return true;
}
