import { deriveDomainState, Xoshiro128StarStar } from "@life-sim/engine";
import type { ValidatedIdentityPack } from "@life-sim/birth";
import type { P3ELifeState } from "@life-sim/contracts";
import { buildP3ELifePartner, type P3ELifePartner } from "./p3e-partner";

/**
 * GPT-DEEPSEEK-0040-A｜角色即時狀態 `view.profile`。
 *
 * ```ts
 * view.profile = {
 *   currentRole: { id, kind, sinceYear },
 *   residence:   { entityId, regionCode },
 *   relationship:{ status, personName, sinceYear }
 * }
 * ```
 *
 * 全部是**呈現投影**：可從 command log（`view.lifeLog` 的 facts）＋ `state` ＋ seed
 * 決定性重建，不寫進 canonical state、不改存檔 wire format、不消耗正式年度 RNG。
 *
 * ## currentRole
 *
 * | 年齡 | id | kind |
 * | --- | --- | --- |
 * | 0–2 | `infant` | `life_stage` |
 * | 3–5 | `preschool_child` | `life_stage` |
 * | 6–11 | `primary_student` | `student` |
 * | 12–14 | `junior_high_student` | `student` |
 * | 15–17 | `senior_high_student` | `student` |
 * | 18–22 | `university_student`／具體職業／`gap_year` | `student`／`employed`／`life_stage` |
 * | 23–64 | 具体職業／`general_worker`／進修中的學生 | `employed`／`self_employed`／`student` |
 * | 65+（沒有繼續工作） | `retired` | `retired` |
 *
 * - 大學（`ev.adult.after-school:university`）→ `university_student` 4 年；
 * - 碩士（`dec.adult.further-study:master`）→ `master_student` 2 年；
 * - 博士（`dec.adult.further-study:doctorate`）→ `doctoral_student` 4 年；
 * - 期限結束後回到職業（不是一輩子研究生）。
 *
 * 職業由 `dec.adult.first-job` 的真實選項決定池（corp／startup／family），
 * `ev.adult.career-pivot`、`dec.late.career-change:change` 會換職業（`stay` 不變）；
 * 教育／知識不足時**不會**變成 teacher／engineer 等專業職，而是穩定的
 * `general_worker`。抽取用獨立 domain `profile`，同 seed／save／load／replay 相同。
 *
 * ## relationship
 *
 * `single`／`dating`／`married`／`divorced`／`widowed`，由 facts 依時間順序套用：
 * `date`→dating、`cohabit`→dating、`marry`→married、`single`→（marry 過 ? divorced : single）、
 * `ev.adult.partner-loss`→widowed。離異／喪偶不是 active partner，但保留 `personName`。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

export type P3ERoleKind = "life_stage" | "student" | "employed" | "self_employed" | "unemployed" | "retired";

export interface P3ERoleSnapshot {
  readonly id: string;
  readonly kind: P3ERoleKind;
  readonly sinceYear: number;
}

export interface P3EResidenceSnapshot {
  readonly entityId: string;
  readonly regionCode: string;
}

export type P3ERelationshipStatus = "single" | "dating" | "married" | "divorced" | "widowed";

export const P3E_RELATIONSHIP_STATUSES: readonly P3ERelationshipStatus[] = Object.freeze([
  "single",
  "dating",
  "married",
  "divorced",
  "widowed"
]);

export interface P3ERelationshipSnapshot {
  readonly status: P3ERelationshipStatus;
  /** 現任或前任伴侶的顯示名稱（single 時為 null）。 */
  readonly personName: string | null;
  /** 這段狀態開始的年份（single 且從未有關係時為 null）。 */
  readonly sinceYear: number | null;
}

export interface P3EProfile {
  readonly currentRole: P3ERoleSnapshot;
  readonly residence: P3EResidenceSnapshot;
  readonly relationship: P3ERelationshipSnapshot;
}

/** 一個「已發生的選擇／事件」事實（由 `view.lifeLog` 轉來，oldest → newest）。 */
export interface P3EProfileFact {
  readonly kind: "event" | "decision" | "focus" | "year" | "birth" | "death";
  readonly eventId: string | null;
  readonly decisionId: string | null;
  readonly optionId: string | null;
  readonly year: number;
  readonly age: number;
}

/* ------------------------------------------------------------------ */
/* 職業池（14 種可見職業）                                             */
/* ------------------------------------------------------------------ */

const OCCUPATION_POOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  corp: Object.freeze(["teacher", "engineer", "accountant", "office_worker", "salesperson", "marketer", "software_engineer", "designer"]),
  startup: Object.freeze(["entrepreneur", "software_engineer", "designer", "marketer"]),
  family: Object.freeze(["shopkeeper", "cook", "farmer", "service_worker"]),
  early: Object.freeze(["service_worker", "shopkeeper", "cook", "salesperson"])
});

/** 需要高等教育或足夠知識才合理的職業。 */
const PROFESSIONAL_OCCUPATIONS: readonly string[] = Object.freeze([
  "teacher",
  "engineer",
  "software_engineer",
  "accountant",
  "doctor",
  "researcher"
]);

/** 教育不足時的穩定替代（不會偽裝成專業職）。 */
const GENERAL_WORKER = "general_worker";

const GENERAL_FALLBACKS: readonly string[] = Object.freeze(["office_worker", "salesperson", "service_worker"]);

/** `dec.adult.first-job` 的真實選項 → 職業池（沒有 job choice 時用 general_worker）。 */
const FIRST_JOB_POOL: Readonly<Record<string, string>> = Object.freeze({
  corp: "corp",
  startup: "startup",
  family: "family"
});

/** 進修期限（年）。 */
export const P3E_UNIVERSITY_YEARS = 4;
export const P3E_MASTER_YEARS = 2;
export const P3E_DOCTORAL_YEARS = 4;

/** 退休年齡（與經濟模型的預設退休一致）。 */
export const P3E_PROFILE_RETIREMENT_AGE = 65;

/* ------------------------------------------------------------------ */
/* 決定性抽取                                                          */
/* ------------------------------------------------------------------ */

function drawIndex(parts: readonly (string | number)[], length: number, salt = ""): number {
  const seedText = `profile|${salt}|${parts.join("|")}`;
  const state = deriveDomainState(seedText, "profile", "1.0.0");
  const rng = new Xoshiro128StarStar([state[0], state[1], state[2], state[3]]);
  return Number(rng.uniformBigInt(BigInt(length)));
}

function pickOccupation(
  masterSeed: string,
  poolName: string,
  year: number,
  canProfessional: boolean,
  salt: string
): string {
  const pool = OCCUPATION_POOLS[poolName] ?? OCCUPATION_POOLS.corp!;
  const index = drawIndex([masterSeed, poolName, year], pool.length, `occupation:${salt}`);
  const candidate = pool[index] as string;
  if (PROFESSIONAL_OCCUPATIONS.includes(candidate) && !canProfessional) {
    const fallbackIndex = drawIndex([masterSeed, poolName, year], GENERAL_FALLBACKS.length, `fallback:${salt}`);
    return GENERAL_FALLBACKS[fallbackIndex] as string;
  }
  return candidate;
}

/* ------------------------------------------------------------------ */
/* 事實掃描                                                            */
/* ------------------------------------------------------------------ */

interface RoleFacts {
  universityYear: number | null;
  masterYear: number | null;
  doctorateYear: number | null;
  firstJob: { pool: string; year: number } | null;
  earlyJob: { year: number } | null;
  pivotYear: number | null;
  lateChangeYear: number | null;
}

function scanRoleFacts(facts: readonly P3EProfileFact[]): RoleFacts {
  const result: RoleFacts = {
    universityYear: null,
    masterYear: null,
    doctorateYear: null,
    firstJob: null,
    earlyJob: null,
    pivotYear: null,
    lateChangeYear: null
  };
  for (const fact of facts) {
    if (fact.kind !== "decision") continue;
    const eventId = fact.eventId;
    const decisionId = fact.decisionId;
    const optionId = fact.optionId;
    if (eventId === "ev.adult.after-school" && decisionId === "dec.adult.after-school") {
      if (optionId === "university") result.universityYear = fact.year;
      if (optionId === "work") result.earlyJob = { year: fact.year };
      continue;
    }
    if (eventId === "ev.adult.further-study" && decisionId === "dec.adult.further-study") {
      if (optionId === "master") result.masterYear = fact.year;
      if (optionId === "doctorate") result.doctorateYear = fact.year;
      continue;
    }
    if (eventId === "ev.adult.first-job" && decisionId === "dec.adult.first-job") {
      const pool = optionId === null ? undefined : FIRST_JOB_POOL[optionId];
      if (pool !== undefined) result.firstJob = { pool, year: fact.year };
      continue;
    }
    if (eventId === "ev.adult.career-pivot" && decisionId === "dec.adult.career-pivot" && optionId === "change") {
      result.pivotYear = fact.year;
      continue;
    }
    if (eventId === "ev.late.career-change" && decisionId === "dec.late.career-change" && optionId === "change") {
      result.lateChangeYear = fact.year;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* currentRole                                                         */
/* ------------------------------------------------------------------ */

function bandStartAge(age: number): number {
  if (age <= 2) return 0;
  if (age <= 5) return 3;
  if (age <= 11) return 6;
  if (age <= 14) return 12;
  if (age <= 17) return 15;
  return 18;
}

function stageRole(age: number, currentYear: number): P3ERoleSnapshot {
  const sinceYear = currentYear - (age - bandStartAge(age));
  if (age <= 2) return { id: "infant", kind: "life_stage", sinceYear };
  if (age <= 5) return { id: "preschool_child", kind: "life_stage", sinceYear };
  if (age <= 11) return { id: "primary_student", kind: "student", sinceYear };
  if (age <= 14) return { id: "junior_high_student", kind: "student", sinceYear };
  return { id: "senior_high_student", kind: "student", sinceYear };
}

function educationRole(facts: RoleFacts, age: number, currentYear: number): P3ERoleSnapshot | null {
  if (facts.doctorateYear !== null && currentYear < facts.doctorateYear + P3E_DOCTORAL_YEARS) {
    return { id: "doctoral_student", kind: "student", sinceYear: facts.doctorateYear };
  }
  if (facts.masterYear !== null && currentYear < facts.masterYear + P3E_MASTER_YEARS) {
    return { id: "master_student", kind: "student", sinceYear: facts.masterYear };
  }
  if (facts.universityYear !== null && currentYear < facts.universityYear + P3E_UNIVERSITY_YEARS) {
    return { id: "university_student", kind: "student", sinceYear: facts.universityYear };
  }
  void age;
  return null;
}

/**
 * 目前職業／身分。
 *
 * @param state         權威 state（年齡、目前年份、flags）
 * @param facts         已發生的選擇／事件（oldest → newest）
 * @param masterSeed    用來做職業抽取（獨立 domain）
 */
export function deriveP3ECurrentRole(input: {
  readonly state: P3ELifeState;
  readonly facts: readonly P3EProfileFact[];
  readonly masterSeed: string;
}): P3ERoleSnapshot {
  // 一律回傳凍結物件（與 view 其他投影一致）。
  return Object.freeze(deriveRoleUnfrozen(input));
}

function deriveRoleUnfrozen(input: {
  readonly state: P3ELifeState;
  readonly facts: readonly P3EProfileFact[];
  readonly masterSeed: string;
}): P3ERoleSnapshot {
  const { state, masterSeed } = input;
  const age = state.age;
  const currentYear = state.currentYear;
  const flags = state.flags;
  const roleFacts = scanRoleFacts(input.facts);

  // 0–17 歲：固定學制角色（不論選擇）。
  if (age <= 17) return stageRole(age, currentYear);

  // 進修中（大學／碩士／博士的有限期間）。
  const education = educationRole(roleFacts, age, currentYear);
  if (education !== null) return education;

  // 退休：65 歲以上、沒有 working:senior 且沒有在進修。
  const stillWorking = flags.includes("working:senior") && age <= 71;
  if (age >= P3E_PROFILE_RETIREMENT_AGE && !stillWorking) {
    return { id: "retired", kind: "retired", sinceYear: currentYear - (age - P3E_PROFILE_RETIREMENT_AGE) };
  }

  // 18–22 歲且沒有任何工作選擇：gap_year（大學期間已在上面處理）。
  const hasJob = roleFacts.firstJob !== null || roleFacts.earlyJob !== null;
  if (age <= 22 && !hasJob) {
    return { id: "gap_year", kind: "life_stage", sinceYear: currentYear - (age - 18) };
  }

  const canProfessional = flags.includes("edu:university") || flags.includes("edu:master") || flags.includes("edu:doctorate") || state.stats.knowledge >= 40;

  // 轉職／中年轉業：用新的年份重新抽一個合理職業。
  const changedYear = roleFacts.lateChangeYear ?? roleFacts.pivotYear;
  if (changedYear !== null) {
    const pool = roleFacts.firstJob?.pool ?? "corp";
    const kind: P3ERoleKind = pool === "startup" ? "self_employed" : "employed";
    return { id: pickOccupation(masterSeed, pool, changedYear, canProfessional, "changed"), kind, sinceYear: changedYear };
  }

  if (roleFacts.earlyJob !== null && roleFacts.firstJob === null) {
    return {
      id: pickOccupation(masterSeed, "early", roleFacts.earlyJob.year, canProfessional, "early"),
      kind: "employed",
      sinceYear: roleFacts.earlyJob.year
    };
  }
  if (roleFacts.firstJob !== null) {
    const pool = roleFacts.firstJob.pool;
    return {
      id: pickOccupation(masterSeed, pool, roleFacts.firstJob.year, canProfessional, "first"),
      kind: pool === "startup" ? "self_employed" : "employed",
      sinceYear: roleFacts.firstJob.year
    };
  }

  // 沒有明確 job choice：經濟模型推定就業時，用穩定、不假裝專業的 general_worker。
  if (age >= 23) {
    const retiredFlag = flags.includes("retired") || flags.includes("pension:safe");
    if (retiredFlag) return { id: "retired", kind: "retired", sinceYear: currentYear - (age - 65) };
    return { id: GENERAL_WORKER, kind: "employed", sinceYear: currentYear - (age - 23) };
  }

  return { id: GENERAL_WORKER, kind: "employed", sinceYear: currentYear };
}

/* ------------------------------------------------------------------ */
/* relationship                                                        */
/* ------------------------------------------------------------------ */

interface RelationshipResolution {
  readonly status: P3ERelationshipStatus;
  readonly partner: P3ELifePartner | null;
  readonly formerName: string | null;
  readonly sinceYear: number | null;
}

/**
 * 關係事實 → 狀態機（GPT-DEEPSEEK-0041-A：只有一個真相）。
 *
 * 規則（依 command log 的時間順序套用）：
 *
 * | 事實 | status | 說明 |
 * | --- | --- | --- |
 * | （無） | `single` | 沒有關係 |
 * | `ev.teen.first-love/dec.teen.first-love/date` | `dating` | 建立伴侶 |
 * | `ev.adult.relationship/…/cohabit` | `dating` | 同一人（同居不是結婚） |
 * | `ev.adult.relationship/…/marry` | `married` | 同一人、變成已婚 |
 * | `ev.adult.relationship/…/single` | `single` | 一般關係事件已用條件排除已婚者，因此 single 一律代表「回到單身」 |
 * | `ev.adult.marital-breakup/…/divorce`（只有已婚時 eligible） | `divorced` | 離婚 |
 * | `ev.adult.partner-loss`（只有已婚時 eligible） | `widowed` | 配偶離世，active partner 清空 |
 *
 * - 「是否已婚」用的是**當前這段關係**的狀態（`currentMarried`），不是「這輩子是否曾結婚」，
 *   因此「已婚 → 離異 → 新交往 → 分手」最後是 `single`，不會再變成 `divorced`；
 * - 任何新關係（date／cohabit／marry）都會把 divorced／widowed 清掉（狀態直接被覆寫）；
 * - `partner` 只在 dating／married 時存在；widowed／divorced／single 一律 `null`，
 *   因此舊的 `view.partner` 不會再顯示已故或已離異的配偶。
 */
export function resolveP3ERelationship(input: {
  readonly masterSeed: string;
  readonly identityPack: ValidatedIdentityPack;
  readonly cultureId: string;
  readonly playerSex: string;
  readonly facts: readonly P3EProfileFact[];
}): RelationshipResolution {
  let status: P3ERelationshipStatus = "single";
  let partner: P3ELifePartner | null = null;
  let formerName: string | null = null;
  let sinceYear: number | null = null;
  /** 這「一段」關係是否已婚（不是一生是否曾結婚）。 */
  let currentMarried = false;
  /**
   * GPT-0046-B：這位玩家「歷史上所有伴侶」的顯示名（含已結束的）。
   * 每次建立新伴侶時傳入 `buildP3ELifePartner` 當 forbiddenNames，確保新姓名不與任何
   * 先前伴侶重複；清除關係時保留在集合中（新關係仍須避開前任姓名）。
   */
  const usedNames: string[] = [];

  const startPartner = (
    eventId: string,
    decisionId: string,
    optionId: string,
    year: number,
    partnerStatus: "dating" | "partner" | "spouse"
  ): P3ELifePartner => {
    const created = buildP3ELifePartner({
      masterSeed: input.masterSeed,
      identityPack: input.identityPack,
      cultureId: input.cultureId,
      playerSex: input.playerSex,
      first: { eventId, decisionId, optionId, year },
      latestStatus: partnerStatus,
      forbiddenNames: usedNames
    });
    usedNames.push(created.displayName);
    return created;
  };

  const upgradePartner = (year: number, partnerStatus: "partner" | "spouse"): P3ELifePartner => {
    if (partner === null) {
      // 沒有既有伴侶卻出現 cohabit／marry：視為新關係的建立（仍避開歷史姓名）。
      return startPartner("ev.adult.relationship", "dec.adult.relationship", partnerStatus === "spouse" ? "marry" : "cohabit", year, partnerStatus);
    }
    // 已有伴侶：只升級狀態，姓名保持不變（絕不重抽、絕不改寫前任姓名）。
    return Object.freeze({ ...partner, status: partnerStatus });
  };

  const endRelationship = (year: number, nextStatus: "single" | "divorced" | "widowed"): void => {
    // 只有離異／喪偶保留前任姓名；單純分手（single）不留下名字。
    formerName = partner !== null && nextStatus !== "single" ? partner.displayName : null;
    partner = null;
    currentMarried = false;
    status = nextStatus;
    sinceYear = year;
  };

  for (const fact of input.facts) {
    // 配偶離世：只有「目前這段關係已婚」時才有意義。
    if (fact.kind === "event" && fact.eventId === "ev.adult.partner-loss") {
      if (partner !== null && currentMarried) endRelationship(fact.year, "widowed");
      continue;
    }
    if (fact.kind !== "decision") continue;
    const eventId = fact.eventId;
    const decisionId = fact.decisionId;
    const optionId = fact.optionId;

    if (eventId === "ev.teen.first-love" && decisionId === "dec.teen.first-love" && optionId === "date") {
      if (partner === null) {
        partner = startPartner(eventId, decisionId, optionId, fact.year, "dating");
        sinceYear = fact.year;
      }
      status = "dating";
      currentMarried = false;
      continue;
    }

    if (eventId === "ev.adult.relationship" && decisionId === "dec.adult.relationship") {
      if (optionId === "cohabit") {
        if (partner === null) sinceYear = fact.year;
        partner = upgradePartner(fact.year, "partner");
        status = "dating";
        currentMarried = false;
        continue;
      }
      if (optionId === "marry") {
        if (partner === null) sinceYear = fact.year;
        partner = upgradePartner(fact.year, "spouse");
        status = "married";
        currentMarried = true;
        sinceYear = fact.year;
        continue;
      }
      if (optionId === "single") {
        // GPT-DEEPSEEK-0043-A：一般關係事件在已婚時不會 eligible（fixture 條件），
        // 因此 single 一律是「回到單身」；離婚只能走 marital-breakup:divorce。
        endRelationship(fact.year, "single");
      }
      continue;
    }

    // 離婚（只有已婚時 eligible；fixture 用條件擋住）。
    if (eventId === "ev.adult.marital-breakup" && decisionId === "dec.adult.marital-breakup" && optionId === "divorce") {
      endRelationship(fact.year, "divorced");
    }
  }

  return { status, partner, formerName, sinceYear };
}

/** `view.profile.relationship`：active partner 顯示現任名字，離異／喪偶保留前任名字。 */
export function relationshipSnapshot(resolution: RelationshipResolution): P3ERelationshipSnapshot {
  const personName = resolution.partner !== null ? resolution.partner.displayName : resolution.formerName;
  return Object.freeze({
    status: resolution.status,
    personName,
    sinceYear: resolution.sinceYear
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/** 建立完整 profile（role／residence／relationship；深層凍結、可 JSON 序列化）。 */
export function deriveP3EProfile(input: {
  readonly state: P3ELifeState;
  readonly facts: readonly P3EProfileFact[];
  readonly masterSeed: string;
  readonly identityPack: ValidatedIdentityPack;
  readonly cultureId: string;
  readonly playerSex: string;
}): P3EProfile {
  const relationship = resolveP3ERelationship({
    masterSeed: input.masterSeed,
    identityPack: input.identityPack,
    cultureId: input.cultureId,
    playerSex: input.playerSex,
    facts: input.facts
  });
  return Object.freeze({
    currentRole: Object.freeze(deriveP3ECurrentRole(input)),
    // 目前沒有跨國移居事件：residence 等於出生國家（未來 migration 再更新）。
    residence: Object.freeze({
      entityId: input.state.identity.entityId,
      regionCode: input.state.identity.regionCode
    }),
    relationship: relationshipSnapshot(relationship)
  });
}
