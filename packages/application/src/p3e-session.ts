import type { P3ELifeState } from "@life-sim/contracts";
import {
  deriveP3EEmploymentStatus,
  estimateIncomePercentileMicroUsd,
  estimateWealthPercentileMicroUsd,
  formatPercentileSummary,
  type P3EPercentileMeta,
  type P3EPercentileResult
} from "@life-sim/contracts";
import {
  P3EError,
  appendP3ELedgerHistory,
  createP3ELedgerHistory,
  decodeP3ESessionPayload,
  encodeP3ESessionPayload,
  replayP3ELedgerHistory,
  type P3EAdvanceYearOutcome,
  type P3ECommandOutcome,
  type P3ELedgerHistory
} from "@life-sim/simulation";
import { createP3EGame, runP3EGameCommand } from "./p3e-game";
import {
  appendP3ELifeLogEntry,
  birthLifeLogEntry,
  buildP3ELifeLog,
  type P3ELifeLogEntry
} from "./p3e-life-log";
import type { P3ELifePartner } from "./p3e-partner";
import {
  deriveP3EProfile,
  resolveP3ERelationship,
  type P3EProfile,
  type P3EProfileFact
} from "./p3e-profile";

/**
 * P3-E.1b-2n／2r／2t：Application Play Session ＋ ViewModel ＋ Raw Session Persistence
 * （H5-CTO-174-A／H5-CTO-181-A／H5-CTO-183-A）。
 *
 * 把「一場遊戲」包成不可變 session：`{ state, ledgerHistory, lastOutcome, view }`。
 *
 * ## 責任邊界
 *
 * - `createP3EPlaySession` 只編排 `createP3EGame` 與 `createP3ELedgerHistory`
 *   （各自恰好一次）；history 的 anchor 就是這條命的 Genesis State；
 * - `runP3EPlaySessionCommand` 只編排 `runP3EGameCommand`（恰好一次）與
 *   `appendP3ELedgerHistory`（恰好一次，帶入 previousState 與本次兩個 Record）；
 * - `exportP3EPlaySessionPayload` 只編排正式 `encodeP3ESessionPayload`
 *   （masterSeed＋state＋history），輸出 canonical payload 字串；
 * - `restoreP3EPlaySessionPayload` 只編排 `decodeP3ESessionPayload`（恰好一次）→
 *   `replayP3ELedgerHistory`（恰好一次）→ canonical 逐位元比對 → seal；
 *   **只接受 replay 結果**，payload 宣稱的 final state 不被信任；
 * - 不重寫任何模擬、不查 pack、不重跑事件、不重複 Record／hash 驗證
 *   （append 走 ledger-history 的可信快速路徑）、不接觸 UI DOM。
 *
 * ## 私有 pack 綁定（brand）
 *
 * event／death pack 只存在模組內的 `WeakMap<session, {eventPack, deathPack}>`，
 * **不**是 session 的可列舉欄位、也不會被序列化。任何不是由本模組建立的 session
 * （手工偽造、`structuredClone` 複本、解凍重建）都會因為查不到私有綁定而被拒絕。
 *
 * ## ViewModel
 *
 * `view` 是純呈現資料：phase／year／age／identity／stats／assets／controls／
 * pendingDecision／lastOutcome。金錢一律是 base10 字串（不得出現 bigint），
 * 且 view 可安全 JSON 序列化。`ledgerHistory` **只**在 session 上，不在 view、
 * 也不進 DOM。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

type SimulationCommandResult = ReturnType<typeof runP3EGameCommand>;

/** 呈現用金錢（base10 字串，禁止 bigint）。 */
export interface P3EPlaySessionAssets {
  readonly balanceMicroUsd: string;
  readonly annualIncomeMicroUsd: string;
  readonly annualExpenseMicroUsd: string;
}

/** 依 phase 決定的可操作控制項。 */
export interface P3EPlaySessionControls {
  readonly canAdvanceYear: boolean;
  readonly canChooseDecision: boolean;
  readonly isDead: boolean;
}

/** 收入／資產百分位（GPT-DEEPSEEK-0036-A；「高於中國 X%｜高於全球 Y%」）。 */
export interface P3EPlaySessionPercentileField {
  readonly available: boolean;
  /** 高於中國多少比例的人（0–99.9；不可用時為 null）。 */
  readonly chinaPercent: number | null;
  /** 高於全球多少比例的人（0–99.9；不可用時為 null）。 */
  readonly globalPercent: number | null;
  /** UI 可直接顯示的字串（含「估算」語意；不可用時是「估算不可用」）。 */
  readonly summary: string;
  /** 不可用原因。 */
  readonly reason: "age_below_minimum" | "no_income" | "not_employed" | null;
  /** 資料口徑（基準年／單位／方法／版本）；不可用時為 null。 */
  readonly meta: P3EPercentileMeta | null;
}

/** 收入與資產的百分位投影。 */
export interface P3EPlaySessionPercentiles {
  readonly income: P3EPlaySessionPercentileField;
  readonly wealth: P3EPlaySessionPercentileField;
}

/** 呈現用 ViewModel。 */
export interface P3EPlaySessionView {
  readonly phase: P3ELifeState["phase"];
  readonly currentYear: number;
  readonly age: number;
  readonly identity: P3ELifeState["identity"];
  readonly stats: P3ELifeState["stats"];
  readonly assets: P3EPlaySessionAssets;
  readonly controls: P3EPlaySessionControls;
  readonly pendingDecision: P3EAdvanceYearOutcome["pendingDecision"];
  readonly lastOutcome: P3ECommandOutcome | null;
  /**
   * 可累積的人生紀錄（GPT-0031-A；最新在最前面、最多 256 筆）。
   *
   * 只放可由 UI 翻譯的公開 ID（eventId／decisionId／optionId／focusId／causeId），
   * 不含任何繁中文字串；存檔復原後由 ledger／commands 決定性重建。
   */
  readonly lifeLog: readonly P3ELifeLogEntry[];
  /**
   * 收入／資產百分位（GPT-DEEPSEEK-0036-A）：語意是「高於多少比例的人」，
   * 全部標示估算，並附基準年／單位／來源／方法。
   */
  readonly percentiles: P3EPlaySessionPercentiles;
  /**
   * 角色即時狀態（GPT-DEEPSEEK-0040-A）：目前職業／居住地／感情狀態。
   * 全部是呈現投影，可由 command log 決定性重建。
   */
  readonly profile: P3EProfile;
  /**
   * 具名伴侶（GPT-DEEPSEEK-0036-A）：沒有關係事件時是 null；
   * 由 masterSeed ＋ command log 決定性重建（不消耗年度 RNG）。
   */
  readonly partner: P3ELifePartner | null;
}

/** 不可變的遊戲 session。 */
export interface P3EPlaySession {
  readonly state: P3ELifeState;
  /** 這條命從 Genesis 起、逐命令驗證 append 的完整 Ledger History（不在 view／DOM）。 */
  readonly ledgerHistory: P3ELedgerHistory;
  readonly lastOutcome: P3ECommandOutcome | null;
  readonly view: P3EPlaySessionView;
}

/** 一次 session 命令的結果（session 是新的凍結物件，舊的保持不變）。 */
export interface P3EPlaySessionCommandResult {
  readonly session: P3EPlaySession;
  readonly commandRecord: SimulationCommandResult["commandRecord"];
  readonly yearRecord: SimulationCommandResult["yearRecord"];
}

/* ------------------------------------------------------------------ */
/* 私有 genesis 綁定（packs 永不列舉／序列化）                           */
/* ------------------------------------------------------------------ */

interface P3EPlaySessionGenesis {
  readonly masterSeed: unknown;
  readonly basePack: unknown;
  readonly identityPack: unknown;
  readonly certificate: unknown;
  readonly eventPack: unknown;
  readonly deathPack: unknown;
}

/** session → 私有 genesis 參照（immutable；不是 session 欄位、不序列化）。 */
const GENESIS_BY_SESSION = new WeakMap<object, P3EPlaySessionGenesis>();

/* ------------------------------------------------------------------ */
/* 固定錯誤路徑                                                         */
/* ------------------------------------------------------------------ */

const CREATE_KEYS = ["masterSeed", "basePack", "identityPack", "certificate", "eventPack", "deathPack"] as const;
const RUN_KEYS = ["session", "command"] as const;
const EXPORT_KEYS = ["session"] as const;
const RESTORE_KEYS = [
  "payload",
  "masterSeed",
  "basePack",
  "identityPack",
  "certificate",
  "eventPack",
  "deathPack"
] as const;

const PATH_INPUT = "p3eSession.input";
const PATH_SESSION = "p3eSession.session";
/** payload 宣稱值與 replay 不一致的固定 application 錯誤路徑（不是 codec 錯誤）。 */
const PATH_CLAIM = "p3eSession.payload";

/* ------------------------------------------------------------------ */
/* 深層凍結與副本                                                       */
/* ------------------------------------------------------------------ */

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** identity 的獨立副本（12 欄，全部 primitive）。 */
function copyIdentity(identity: P3ELifeState["identity"]): P3ELifeState["identity"] {
  return {
    entityId: identity.entityId,
    regionCode: identity.regionCode,
    sex: identity.sex,
    birthYear: identity.birthYear,
    certificateId: identity.certificateId,
    certificateHash: identity.certificateHash,
    playerIdentityHash: identity.playerIdentityHash,
    masterSeedHash: identity.masterSeedHash,
    basePackId: identity.basePackId,
    basePackChecksum: identity.basePackChecksum,
    identityPackId: identity.identityPackId,
    identityPackChecksum: identity.identityPackChecksum
  };
}

/** stats 的獨立副本。 */
function copyStats(stats: P3ELifeState["stats"]): P3ELifeState["stats"] {
  return {
    health: stats.health,
    happiness: stats.happiness,
    knowledge: stats.knowledge,
    relationships: stats.relationships
  };
}

/** 金錢一律轉 base10 字串（view 不得出現 bigint）。 */
function copyAssets(assets: P3ELifeState["assets"]): P3EPlaySessionAssets {
  return {
    balanceMicroUsd: assets.balanceMicroUsd.toString(),
    annualIncomeMicroUsd: assets.annualIncomeMicroUsd.toString(),
    annualExpenseMicroUsd: assets.annualExpenseMicroUsd.toString()
  };
}

/** phase → 控制項矩陣。 */
function controlsFor(phase: P3ELifeState["phase"]): P3EPlaySessionControls {
  if (phase === "life") return { canAdvanceYear: true, canChooseDecision: false, isDead: false };
  if (phase === "pending_decision") {
    return { canAdvanceYear: false, canChooseDecision: true, isDead: false };
  }
  return { canAdvanceYear: false, canChooseDecision: false, isDead: true };
}

/** 百分位欄位：把契約層結果轉成 UI 直接可用的形狀（不含 bigint）。 */
function percentileField(result: P3EPercentileResult): P3EPlaySessionPercentileField {
  if (!result.available) {
    return Object.freeze({
      available: false,
      chinaPercent: null,
      globalPercent: null,
      summary: formatPercentileSummary(result),
      reason: result.reason,
      meta: null
    });
  }
  return Object.freeze({
    available: true,
    chinaPercent: result.chinaPercent,
    globalPercent: result.globalPercent,
    summary: formatPercentileSummary(result),
    reason: null,
    meta: Object.freeze({ ...result.meta })
  });
}

/** 由 State 算百分位（純呈現；不消耗 RNG、不查 pack、不寫任何狀態）。 */
function buildPercentiles(state: P3ELifeState): P3EPlaySessionPercentiles {
  const employmentStatus = deriveP3EEmploymentStatus(state.age, state.flags);
  return Object.freeze({
    income: percentileField(
      estimateIncomePercentileMicroUsd({
        age: state.age,
        annualIncomeMicroUsd: state.assets.annualIncomeMicroUsd,
        employmentStatus
      })
    ),
    wealth: percentileField(
      estimateWealthPercentileMicroUsd({ age: state.age, balanceMicroUsd: state.assets.balanceMicroUsd })
    )
  });
}

/* ------------------------------------------------------------------ */
/* GPT-DEEPSEEK-0036-A：伴侶投影 helper                                  */
/* ------------------------------------------------------------------ */

interface PartnerIdentityPackView {
  readonly vitalsByEntity: Record<string, { readonly cultureId: string }>;
}

/** 由 state.identity.entityId 找出玩家出生文化（給姓名語料用）。 */
function cultureIdOf(identityPack: PartnerIdentityPackView, state: P3ELifeState): string {
  const vital = identityPack.vitalsByEntity[state.identity.entityId];
  return vital === undefined ? "han" : vital.cultureId;
}

/**
 * 關係的**唯一真相**（GPT-DEEPSEEK-0041-A）：`view.partner` 與
 * `view.profile.relationship` 都來自同一次解析，不可能互相矛盾。
 *
 * facts 來自 `view.lifeLog`（選擇＋事件，oldest → newest），因此即時、存檔、
 * 重播三條路徑都套用同一組轉移（包含配偶離世 → widowed 時 partner 必須變 null）。
 */
function resolveSessionRelationship(input: {
  readonly masterSeed: string;
  readonly identityPack: unknown;
  readonly state: P3ELifeState;
  readonly lifeLog: readonly P3ELifeLogEntry[];
}): { readonly partner: P3ELifePartner | null; readonly profile: P3EProfile } {
  const profile = deriveP3EProfile({
    state: input.state,
    facts: profileFactsFromLifeLog(input.lifeLog),
    masterSeed: input.masterSeed,
    identityPack: input.identityPack as never,
    cultureId: cultureIdOf(input.identityPack as never, input.state),
    playerSex: input.state.identity.sex
  });
  const relationship = resolveP3ERelationship({
    masterSeed: input.masterSeed,
    identityPack: input.identityPack as never,
    cultureId: cultureIdOf(input.identityPack as never, input.state),
    playerSex: input.state.identity.sex,
    facts: profileFactsFromLifeLog(input.lifeLog)
  });
  return { partner: relationship.partner, profile };
}


/** 把 lifeLog（最新在前）轉成 profile 需要的 facts（oldest → newest）。 */
function profileFactsFromLifeLog(lifeLog: readonly P3ELifeLogEntry[]): readonly P3EProfileFact[] {
  return [...lifeLog]
    .sort((left, right) => left.seq - right.seq)
    .map((entry) => ({
      kind: entry.kind,
      eventId: entry.eventId,
      decisionId: entry.decisionId,
      optionId: entry.optionId,
      year: entry.year,
      age: entry.age
    }));
}

/** 建立 view：只讀 State 與 lastOutcome，不查 pack、不重跑任何模擬。 */
function buildView(
  state: P3ELifeState,
  lastOutcome: P3ECommandOutcome | null,
  lifeLog: readonly P3ELifeLogEntry[],
  relationship: { readonly partner: P3ELifePartner | null; readonly profile: P3EProfile }
): P3EPlaySessionView {
  const pendingDecision =
    state.phase === "pending_decision" && lastOutcome !== null && lastOutcome.kind === "advance_year"
      ? lastOutcome.pendingDecision
      : null;
  return deepFreeze({
    phase: state.phase,
    currentYear: state.currentYear,
    age: state.age,
    identity: copyIdentity(state.identity),
    stats: copyStats(state.stats),
    assets: copyAssets(state.assets),
    controls: controlsFor(state.phase),
    pendingDecision,
    lastOutcome,
    lifeLog,
    percentiles: buildPercentiles(state),
    partner: relationship.partner,
    profile: relationship.profile
  });
}

/* ------------------------------------------------------------------ */
/* 輸入邊界（descriptor-only exact object）                             */
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
/* Session 封裝                                                        */
/* ------------------------------------------------------------------ */

function sealSession(
  state: P3ELifeState,
  ledgerHistory: P3ELedgerHistory,
  lastOutcome: P3ECommandOutcome | null,
  lifeLog: readonly P3ELifeLogEntry[],
  relationship: { readonly partner: P3ELifePartner | null; readonly profile: P3EProfile }
): P3EPlaySession {
  return deepFreeze({
    state,
    ledgerHistory,
    lastOutcome,
    view: buildView(state, lastOutcome, lifeLog, relationship)
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 建立一場遊戲 session。
 *
 * input 必須是 descriptor-only exact-object 六欄（與 `createP3EGame` 相同）：
 * `masterSeed`／`basePack`／`identityPack`／`certificate`／`eventPack`／`deathPack`。
 * getter 永遠不會被執行；任何不合法輸入一律 `E_P3E_ARGUMENT at p3eSession.input`。
 */
export function createP3EPlaySession(input: unknown): P3EPlaySession {
  const raw = readExactObject(input, CREATE_KEYS, PATH_INPUT);
  const genesis: P3EPlaySessionGenesis = {
    masterSeed: raw.masterSeed,
    basePack: raw.basePack,
    identityPack: raw.identityPack,
    certificate: raw.certificate,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack
  };
  const state = createP3EGame(genesis);
  const lifeLog = [birthLifeLogEntry(state.identity.birthYear)];
  const relationship = resolveSessionRelationship({
    masterSeed: genesis.masterSeed as string,
    identityPack: genesis.identityPack,
    state,
    lifeLog
  });
  const session = sealSession(state, createP3ELedgerHistory(state), null, lifeLog, relationship);
  GENESIS_BY_SESSION.set(session, genesis);
  return session;
}

/**
 * 執行一筆 session 命令。
 *
 * input 必須是 exact-object 兩欄（`session`／`command`）。
 * `session` 必須是本模組建立的物件（私有 WeakMap brand）；偽造或複製的 session
 * 一律 `E_P3E_ARGUMENT at p3eSession.session`。
 * 成功時回傳新的凍結 session，舊 session 完全不變；失敗時不產生任何部分結果。
 */
export function runP3EPlaySessionCommand(input: unknown): P3EPlaySessionCommandResult {
  const raw = readExactObject(input, RUN_KEYS, PATH_INPUT);
  const session = raw.session;
  const genesis =
    typeof session === "object" && session !== null
      ? GENESIS_BY_SESSION.get(session as object)
      : undefined;
  if (genesis === undefined) throw new P3EError("E_P3E_ARGUMENT", PATH_SESSION);

  const current = session as P3EPlaySession;
  const result = runP3EGameCommand({
    state: current.state,
    eventPack: genesis.eventPack,
    deathPack: genesis.deathPack,
    command: raw.command
  });

  // 恰好一次 append：帶入 previousState 與本次兩個 Record；history 走可信快速路徑。
  const ledgerHistory = appendP3ELedgerHistory({
    history: current.ledgerHistory,
    previousState: current.state,
    commandRecord: result.commandRecord,
    yearRecord: result.yearRecord
  });

  // GPT-0031-A：只有成功的命令才會留下紀錄；年份／年齡取自這一年的 Year Record。
  const lifeLog = appendP3ELifeLogEntry(
    current.view.lifeLog,
    result.yearRecord.year,
    result.yearRecord.age,
    result.outcome,
    genesis.masterSeed as string
  );

  const relationship = resolveSessionRelationship({
    masterSeed: genesis.masterSeed as string,
    identityPack: genesis.identityPack,
    state: result.state,
    lifeLog
  });

  const next = sealSession(result.state, ledgerHistory, result.outcome, lifeLog, relationship);
  GENESIS_BY_SESSION.set(next, genesis);

  return deepFreeze({
    session: next,
    commandRecord: result.commandRecord,
    yearRecord: result.yearRecord
  });
}

/**
 * 匯出 canonical「raw session payload」字串。
 *
 * input 必須是 exact-object 單欄 `{session}`；`session` 必須帶私有 brand。
 * 輸出是正式 `encodeP3ESessionPayload` 的 canonical JSON（wire 固定四欄），
 * 內容只有 `masterSeed`／`state`／`ledgerHistory`——**不含**任何 pack、
 * 不含 timestamp／nonce／saveId／revision／metadata。
 */
export function exportP3EPlaySessionPayload(input: unknown): string {
  const raw = readExactObject(input, EXPORT_KEYS, PATH_INPUT);
  const session = raw.session;
  const genesis =
    typeof session === "object" && session !== null
      ? GENESIS_BY_SESSION.get(session as object)
      : undefined;
  if (genesis === undefined) throw new P3EError("E_P3E_ARGUMENT", PATH_SESSION);

  const current = session as P3EPlaySession;
  return encodeP3ESessionPayload({
    masterSeed: genesis.masterSeed,
    state: current.state,
    history: current.ledgerHistory
  });
}

/**
 * 從 raw session payload 還原一個**帶 brand 的凍結 session**。
 *
 * input 必須是 exact-object 七欄：`payload` 加上完整 genesis
 * （`masterSeed`／`basePack`／`identityPack`／`certificate`／`eventPack`／`deathPack`）。
 *
 * ## 流程（順序固定）
 *
 * 1. descriptor-only exact-object 邊界（getter 不執行）；
 * 2. `decodeP3ESessionPayload(payload)` **恰好一次**（codec 錯誤原樣外拋）；
 * 3. decoded `masterSeed` 必須等於 input `masterSeed`（否則
 *    `E_P3E_ARGUMENT at p3eSession.payload`）；
 * 4. `replayP3ELedgerHistory` **恰好一次**（genesis／history／replay 錯誤原樣外拋）；
 * 5. 以 replay 結果重新 encode，與 payload **逐位元**比對；不一致 →
 *    `E_P3E_ARGUMENT at p3eSession.payload`（宣稱快照與權威重執行不符）；
 * 6. 只接受 replayed `state`／`history`／`lastOutcome`；seal 並安裝 brand。
 *
 * 失敗時不產生任何 session（也不留下 brand）。
 */
export function restoreP3EPlaySessionPayload(input: unknown): P3EPlaySession {
  const raw = readExactObject(input, RESTORE_KEYS, PATH_INPUT);

  const decoded = decodeP3ESessionPayload(raw.payload);
  if (decoded.masterSeed !== raw.masterSeed) throw new P3EError("E_P3E_ARGUMENT", PATH_CLAIM);

  const genesis: P3EPlaySessionGenesis = {
    masterSeed: raw.masterSeed,
    basePack: raw.basePack,
    identityPack: raw.identityPack,
    certificate: raw.certificate,
    eventPack: raw.eventPack,
    deathPack: raw.deathPack
  };

  const replayed = replayP3ELedgerHistory({
    genesisInput: genesis,
    history: decoded.history
  });

  const canonical = encodeP3ESessionPayload({
    masterSeed: raw.masterSeed,
    state: replayed.state,
    history: replayed.history
  });
  if (canonical !== raw.payload) throw new P3EError("E_P3E_ARGUMENT", PATH_CLAIM);

  // GPT-0031-A：`lifeLog` 由重執行的權威 outcome 逐筆重建（與即時遊玩逐位元相同）。
  const sources = replayed.history.records.map((pair, index) => ({
    year: pair.yearRecord.year,
    age: pair.yearRecord.age,
    outcome: replayed.outcomes[index] as P3ECommandOutcome
  }));
  const lifeLog = buildP3ELifeLog(replayed.state.identity.birthYear, sources, raw.masterSeed as string);

  const relationship = resolveSessionRelationship({
    masterSeed: raw.masterSeed as string,
    identityPack: raw.identityPack,
    state: replayed.state,
    lifeLog
  });

  const session = sealSession(replayed.state, replayed.history, replayed.lastOutcome, lifeLog, relationship);
  GENESIS_BY_SESSION.set(session, genesis);
  return session;
}
