import type { P3EAssets } from "./p3e";

/**
 * GPT-0031-A／GPT-0032-A｜個人經濟生命週期契約（game-tuned、可單測的階段／就業判斷）。
 *
 * ## 為什麼需要這一層
 *
 * 舊版 `p3e-roll-1.0.0` 的收支是無條件線性公式
 * （`income = 1_000_000 + age × 100_000`），因此 3～5 歲兒童就有年收入與個人資產，
 * 而且所有人都被同一條曲線套住。
 *
 * 本模組把「個人經濟」拆成純函式：
 *
 * 1. `deriveP3EEmploymentStatus`：年齡階段 ＋ 教育／工作／退休旗標 → 就業狀態；
 * 2. `computeP3EBaseEconomy`：就業狀態 ＋ 知識 ＋ 人生重心 → 當年基準收入／支出；
 * 3. `computeP3EAnnualEconomy`：基準值 ＋ **明確來源的金錢 modifier** → 最終 `P3EAssets`；
 * 4. `normalizeP3EAssetsForAge`：0–15 歲的權威歸零（任何 money effects 之後都要過這一關）。
 *
 * ## 金額尺度（GPT-0032-A 修正）
 *
 * 全專案的金錢單位是 **micro-USD**（1 USD = 1,000,000 micro-USD）。舊版本模組把
 * 「2,000,000 micro-USD」當成年收入，等於**每年 2 美元**，與事件包的
 * `3,000,000,000`（= 3,000 美元）差了 1,000 倍以上；這裡全部改用
 * 「美元概念值 × 1,000,000」表示，並在每個常數註解同時寫出兩種值。
 *
 * 量級（PPP-normalized game economy，不是真實國別統計）：
 *
 * - 16–17 歲兼職：2,400 美元／年；
 * - 18–22 歲就業起薪：14,000 美元／年（知識與學歷再加）；
 * - 23–64 歲全職：18,000 美元／年起，乘職涯階段（0.85／1.15／1.05）與知識／學歷／重心；
 * - 65 歲以上退休金：9,000 美元／年（知識加成封頂 2,000 美元）；
 * - 生活支出：在學 7,000、成年 12,000＋知識 ×40、退休 9,500 美元／年。
 *
 * 事件包的年度收入／支出效果最大約 24,000／20,000 美元、單次餘額效果最大約
 * 150,000 美元（買房），與上面的量級一致。
 *
 * ## 產品假設
 *
 * - 畫面上的資產／年收入／年支出是**角色個人**財務，不是家庭財富；
 * - 0–15 歲：個人收入／支出／資產一律 0（兒童事件的金錢視為家庭負擔／家庭給予，
 *   只套用 stats／flags／文案，不進個人帳本）；
 * - 16–17 歲：基礎收入 0，只有明確的兼職旗標（`teen:earned`）或事件效果才有錢；
 * - 18–22 歲：在學（`edu:*`）或未就業時為 0；有工作旗標才就業；
 * - 23–64 歲：預設就業（模型假設），薪資由教育等級、知識、人生重心、年齡段決定；
 * - 65 歲以上：預設退休，退休金較低且**不成長**；`working:senior` 且未滿 72 歲可繼續就業。
 *
 * ## 持續性收入效果（GPT-0032-A 修正）
 *
 * 舊版用「實際值 − 用今年 flags 重算的基準」猜 premium，因此切換重心或轉職時，
 * 基準差會被誤認成永久事件加成。新版改成**明確來源**：
 *
 * - 事件／決策的 `annualIncomeMicroUsd`／`annualExpenseMicroUsd` 效果，會由
 *   simulation 層寫成 `income:mod:<累計 micro-USD>`／`expense:mod:<累計 micro-USD>` 旗標
 *   （沿用既有 `flags`，不新增 State 欄位、不改存檔 wire format）；
 * - 年度結算只讀這兩個旗標，**不再猜測**；切換重心或失業／退休時，
 *   基準值照新狀態算，只有真正的旗標加成會延續。
 */

/* ------------------------------------------------------------------ */
/* 版本與年齡界線                                                      */
/* ------------------------------------------------------------------ */

/** 經濟規則版本（寫進文件與測試；`rollSpecVersion` 仍由 roll 契約管理）。 */
export const P3E_ECONOMY_SPEC_VERSION = "p3e-economy-1.1.0";

/** 個人經濟開始有收入的年齡（16 歲以下一律 0）。 */
export const P3E_ECONOMY_MIN_EARNING_AGE = 16;

/** 成年（就業／在學／自營的分界）。 */
export const P3E_ECONOMY_ADULT_AGE = 18;

/** 完整就業年齡（23 歲起進入職涯階段）。 */
export const P3E_ECONOMY_CAREER_AGE = 23;

/** 預設退休年齡。 */
export const P3E_ECONOMY_RETIREMENT_AGE = 65;

/** `working:senior` 可以繼續工作的年齡上限（含）。 */
export const P3E_ECONOMY_SENIOR_WORK_UNTIL = 71;

/* ------------------------------------------------------------------ */
/* 旗標詞彙（沿用既有事件包的旗標，不新增 state 欄位）                   */
/* ------------------------------------------------------------------ */

/** 在學旗標（大學／碩士／自學）。 */
export const P3E_ECONOMY_STUDENT_FLAGS: readonly string[] = Object.freeze([
  "edu:university",
  "edu:master",
  "study:self"
]);

/** 受雇旗標。 */
export const P3E_ECONOMY_EMPLOYED_FLAGS: readonly string[] = Object.freeze([
  "job:corp",
  "job:early",
  "job:family",
  "career:pivot",
  "working:senior"
]);

/** 自營／創業旗標。 */
export const P3E_ECONOMY_SELF_EMPLOYED_FLAGS: readonly string[] = Object.freeze([
  "job:startup",
  "side:business",
  "business:owner",
  "business:partner"
]);

/** 退休旗標（可提前退休）。 */
export const P3E_ECONOMY_RETIRED_FLAGS: readonly string[] = Object.freeze(["retired", "pension:safe"]);

/** 明確兼職旗標（16 歲起才可能有錢）。 */
export const P3E_ECONOMY_PART_TIME_FLAGS: readonly string[] = Object.freeze(["teen:earned"]);

/**
 * 持續性收入加成的旗標前綴；值為**累計**的 micro-USD 整數（可為負）。
 *
 * 例：`income:mod:3000000000` = 事件累計讓年收入 +3,000 美元。
 * 由 simulation 的 effects 層在套用 money effect 時寫入，年度結算只讀不猜。
 */
export const P3E_INCOME_MODIFIER_FLAG_PREFIX = "income:mod:";

/** 持續性年度支出加成的旗標前綴（累計 micro-USD，可為負）。 */
export const P3E_EXPENSE_MODIFIER_FLAG_PREFIX = "expense:mod:";

/** 教育等級：0 = 無高等教育、1 = 大學、2 = 碩士以上。 */
export type P3EEducationLevel = 0 | 1 | 2;

/** 就業狀態。 */
export type P3EEmploymentStatus =
  | "none"
  | "student"
  | "part_time"
  | "employed"
  | "self_employed"
  | "retired";

export const P3E_EMPLOYMENT_STATUSES: readonly P3EEmploymentStatus[] = Object.freeze([
  "none",
  "student",
  "part_time",
  "employed",
  "self_employed",
  "retired"
]);

/* ------------------------------------------------------------------ */
/* 基準金額（美元 → micro-USD）                                        */
/* ------------------------------------------------------------------ */

/** 1 美元 = 1,000,000 micro-USD；`usd(18_000) = 18_000_000_000n`。 */
const MICRO_PER_USD = 1_000_000n;

/** 把「美元概念值」換成 micro-USD 整數（避免再次把 2,000,000 當成 2 美元）。 */
function usd(dollars: number): bigint {
  return BigInt(dollars) * MICRO_PER_USD;
}

/** 各階段的個人年收入基準（micro-USD）；註解同時寫美元概念值。 */
const INCOME = Object.freeze({
  /** 16–17 歲明確兼職：$2,400／年。 */
  teenPartTime: usd(2_400),
  /** 18–22 歲明確兼職：$4,800／年。 */
  youngPartTime: usd(4_800),
  /** 18–22 歲就業起薪：$14,000／年 ＋ 知識 × $120。 */
  youngEmployed: usd(14_000),
  youngEmployedPerKnowledge: usd(120),
  /** 18–22 歲自營：$12,000／年 ＋ 知識 × $150。 */
  youngSelfEmployed: usd(12_000),
  youngSelfEmployedPerKnowledge: usd(150),
  /** 23–64 歲就業起薪：$18,000／年 ＋ 知識 × $150。 */
  adultEmployed: usd(18_000),
  adultEmployedPerKnowledge: usd(150),
  /** 23–64 歲自營：$22,000／年 ＋ 知識 × $200。 */
  adultSelfEmployed: usd(22_000),
  adultSelfEmployedPerKnowledge: usd(200),
  /** 23–64 歲只有兼職：$7,200／年 ＋ 知識 × $60。 */
  adultPartTime: usd(7_200),
  adultPartTimePerKnowledge: usd(60),
  /** 教育加成（一次性、固定）：大學 +$3,000、碩士 +$6,000。 */
  educationUniversity: usd(3_000),
  educationMaster: usd(6_000),
  /** 65+ 繼續就業：$16,000／年 ＋ 知識 × $80。 */
  seniorEmployed: usd(16_000),
  seniorEmployedPerKnowledge: usd(80),
  /** 退休金：$9,000／年 ＋ min(知識 × $25, $2,000)。 */
  pension: usd(9_000),
  pensionPerKnowledge: usd(25),
  pensionKnowledgeCap: usd(2_000)
});

/** 各階段的個人年支出基準（micro-USD）。 */
const EXPENSE = Object.freeze({
  /** 在學生活支出：$7,000／年。 */
  student: usd(7_000),
  /** 成年生活支出：$12,000／年 ＋ 知識 × $40。 */
  adult: usd(12_000),
  adultPerKnowledge: usd(40),
  /** 自營的額外營運支出：+$3,000／年。 */
  selfEmployedExtra: usd(3_000),
  /** 退休生活支出：$9,500／年。 */
  retired: usd(9_500)
});

/** 23–64 歲的年齡段收入倍率（ppm）。 */
const CAREER_STAGE_PPM = Object.freeze({
  early: 850_000, // 23–29：起步
  peak: 1_150_000, // 30–49：職涯高峰
  late: 1_050_000 // 50–64：高原期
});

/** 人生重心對收入的倍率（ppm）；`null` = 尚未設定 → 1.0。 */
const FOCUS_INCOME_PPM: Readonly<Record<string, number>> = Object.freeze({
  study: 1_080_000,
  growth: 1_060_000,
  family: 1_000_000,
  hobby: 950_000,
  health: 980_000
});

const PPM = 1_000_000n;

/** 全 0 的資產（0–15 歲的權威值）。 */
export const P3E_ZERO_ASSETS: P3EAssets = Object.freeze({
  balanceMicroUsd: 0n,
  annualIncomeMicroUsd: 0n,
  annualExpenseMicroUsd: 0n
});

/* ------------------------------------------------------------------ */
/* 旗標讀取                                                            */
/* ------------------------------------------------------------------ */

function hasAny(flags: readonly string[], candidates: readonly string[]): boolean {
  for (const flag of flags) if (candidates.includes(flag)) return true;
  return false;
}

/** 教育等級：碩士以上 → 2、大學 → 1、其他 → 0。 */
export function readP3EEducationLevel(flags: readonly string[]): P3EEducationLevel {
  // GPT-DEEPSEEK-0040-A：博士與碩士同級（+$6,000），避免「博士收入必然最高」。
  if (flags.includes("edu:doctorate")) return 2;
  if (flags.includes("edu:master")) return 2;
  if (flags.includes("edu:university")) return 1;
  return 0;
}

/** 是否在學（大學／碩士／自學）。 */
export function isP3EStudent(flags: readonly string[]): boolean {
  return hasAny(flags, P3E_ECONOMY_STUDENT_FLAGS);
}

/** 是否已退休（`retired`／`pension:safe`）。 */
export function isP3ERetired(flags: readonly string[]): boolean {
  return hasAny(flags, P3E_ECONOMY_RETIRED_FLAGS);
}

/**
 * 就業狀態（純函式；只看年齡與旗標，不看隨機、不看國家）。
 *
 * | 年齡 | 狀態 |
 * | --- | --- |
 * | 0–15 | `none`（個人經濟全 0） |
 * | 16–17 | 兼職旗標 → `part_time`；在學（含 `edu:*`）→ `student`；否則 `none` |
 * | 18–22 | 退休旗標 → `retired`；自營 → `self_employed`；就業 → `employed`；兼職 → `part_time`；在學 → `student`；否則 `none` |
 * | 23–64 | 退休旗標 → `retired`；`study:self` → `student`；自營 → `self_employed`；就業 → `employed`；只有兼職 → `part_time`；否則 `employed`（模型假設） |
 * | 65+ | `working:senior` 且 ≤ 71 → `employed`；否則 `retired` |
 */
export function deriveP3EEmploymentStatus(age: number, flags: readonly string[]): P3EEmploymentStatus {
  const partTime = hasAny(flags, P3E_ECONOMY_PART_TIME_FLAGS);
  // `edu:university`／`edu:master` 在 18–22 歲代表「正在就學」，
  // 23 歲以後代表「已完成學歷」（只加薪、不再算在學）；`study:self` 才是終身自學。
  const student = age < P3E_ECONOMY_CAREER_AGE ? isP3EStudent(flags) : flags.includes("study:self");
  const retired = isP3ERetired(flags);
  const selfEmployed = hasAny(flags, P3E_ECONOMY_SELF_EMPLOYED_FLAGS);
  const employed = hasAny(flags, P3E_ECONOMY_EMPLOYED_FLAGS);

  if (age < P3E_ECONOMY_MIN_EARNING_AGE) return "none";

  if (age < P3E_ECONOMY_ADULT_AGE) {
    if (partTime) return "part_time";
    if (student) return "student";
    return "none";
  }

  if (age < P3E_ECONOMY_CAREER_AGE) {
    if (retired) return "retired";
    if (selfEmployed) return "self_employed";
    if (employed) return "employed";
    if (partTime) return "part_time";
    if (student) return "student";
    return "none";
  }

  if (age < P3E_ECONOMY_RETIREMENT_AGE) {
    if (retired) return "retired";
    if (student) return "student";
    if (selfEmployed) return "self_employed";
    if (employed) return "employed";
    if (partTime) return "part_time";
    // 模型假設：23 歲以後沒有其他狀態時視為就業（薪資仍由教育／知識／重心決定）。
    return "employed";
  }

  if (!retired && employed && age <= P3E_ECONOMY_SENIOR_WORK_UNTIL) return "employed";
  return "retired";
}

/* ------------------------------------------------------------------ */
/* 基準經濟值                                                          */
/* ------------------------------------------------------------------ */

/** 一個年齡的基準經濟（不含任何 modifier）。 */
export interface P3EBaseEconomy {
  readonly status: P3EEmploymentStatus;
  readonly educationLevel: P3EEducationLevel;
  readonly annualIncomeMicroUsd: bigint;
  readonly annualExpenseMicroUsd: bigint;
}

function careerStagePpm(age: number): number {
  if (age < 30) return CAREER_STAGE_PPM.early;
  if (age < 50) return CAREER_STAGE_PPM.peak;
  return CAREER_STAGE_PPM.late;
}

function scaleByPpm(value: bigint, ppm: number): bigint {
  return (value * BigInt(ppm)) / PPM;
}

function educationPremium(level: P3EEducationLevel): bigint {
  if (level === 2) return INCOME.educationMaster;
  if (level === 1) return INCOME.educationUniversity;
  return 0n;
}

/**
 * 基準收入／支出（micro-USD 整數，完全決定性；不含事件 modifier）。
 *
 * @param age        這一年結算後的年齡（0–120）
 * @param knowledge  知識（0–100）
 * @param flags      state.flags（只看教育／工作／退休／兼職旗標）
 * @param lifeFocusId 人生重心 id（未設定傳 `null`）
 */
export function computeP3EBaseEconomy(
  age: number,
  knowledge: number,
  flags: readonly string[],
  lifeFocusId: string | null
): P3EBaseEconomy {
  const status = deriveP3EEmploymentStatus(age, flags);
  const educationLevel = readP3EEducationLevel(flags);
  const focusPpm = (lifeFocusId !== null ? FOCUS_INCOME_PPM[lifeFocusId] : undefined) ?? 1_000_000;
  const knowledgeBig = BigInt(Math.max(0, Math.min(100, Math.trunc(knowledge))));

  // 0–15 歲：個人經濟全部為 0（就算舊存檔／事件給了錢也一樣）。
  if (age < P3E_ECONOMY_MIN_EARNING_AGE) {
    return Object.freeze({ status: "none" as const, educationLevel, annualIncomeMicroUsd: 0n, annualExpenseMicroUsd: 0n });
  }

  let income = 0n;
  let expense = 0n;

  if (age < P3E_ECONOMY_ADULT_AGE) {
    // 16–17 歲：只有明確兼職才有收入，且沒有個人生活支出（家庭負擔）。
    if (status === "part_time") income = INCOME.teenPartTime;
    expense = 0n;
  } else if (age < P3E_ECONOMY_CAREER_AGE) {
    // 18–22 歲：在學 0 收入；兼職／就業／自營才有錢；生活支出固定。
    if (status === "part_time") income = INCOME.youngPartTime;
    else if (status === "employed") income = INCOME.youngEmployed + knowledgeBig * INCOME.youngEmployedPerKnowledge;
    else if (status === "self_employed") {
      income = INCOME.youngSelfEmployed + knowledgeBig * INCOME.youngSelfEmployedPerKnowledge;
    }
    expense = EXPENSE.student;
  } else if (age < P3E_ECONOMY_RETIREMENT_AGE) {
    // 23–64 歲：職涯階段 × 教育 × 知識 × 重心。
    if (status === "retired") {
      income = pensionIncome(knowledgeBig);
      expense = EXPENSE.retired;
    } else if (status === "self_employed") {
      income = INCOME.adultSelfEmployed + knowledgeBig * INCOME.adultSelfEmployedPerKnowledge;
      expense = EXPENSE.adult + knowledgeBig * EXPENSE.adultPerKnowledge + EXPENSE.selfEmployedExtra;
    } else if (status === "employed") {
      const base = INCOME.adultEmployed + knowledgeBig * INCOME.adultEmployedPerKnowledge + educationPremium(educationLevel);
      income = scaleByPpm(base, careerStagePpm(age));
      expense = EXPENSE.adult + knowledgeBig * EXPENSE.adultPerKnowledge;
    } else if (status === "part_time") {
      income = INCOME.adultPartTime + knowledgeBig * INCOME.adultPartTimePerKnowledge;
      expense = EXPENSE.adult;
    } else {
      // 在學（23–64 的進修）或完全沒有工作：沒有個人收入，只有生活支出。
      income = 0n;
      expense = EXPENSE.student;
    }
  } else {
    // 65 歲以上：退休金較低、知識加成封頂；`working:senior` 可繼續就業到 71 歲。
    if (status === "employed") {
      income = INCOME.seniorEmployed + knowledgeBig * INCOME.seniorEmployedPerKnowledge;
      expense = EXPENSE.adult;
    } else {
      income = pensionIncome(knowledgeBig);
      expense = EXPENSE.retired;
    }
  }

  const focusedIncome = income === 0n ? 0n : scaleByPpm(income, focusPpm);
  return Object.freeze({
    status,
    educationLevel,
    annualIncomeMicroUsd: focusedIncome,
    annualExpenseMicroUsd: expense
  });
}

function pensionIncome(knowledge: bigint): bigint {
  const bonus = knowledge * INCOME.pensionPerKnowledge;
  return INCOME.pension + (bonus > INCOME.pensionKnowledgeCap ? INCOME.pensionKnowledgeCap : bonus);
}

/* ------------------------------------------------------------------ */
/* 持續性 modifier（明確來源：旗標）                                    */
/* ------------------------------------------------------------------ */

/** 持續性 modifier 的種類。 */
export type P3EMoneyModifierKind = "income" | "expense";

function modifierPrefix(kind: P3EMoneyModifierKind): string {
  return kind === "income" ? P3E_INCOME_MODIFIER_FLAG_PREFIX : P3E_EXPENSE_MODIFIER_FLAG_PREFIX;
}

/**
 * 讀出累計的持續性收入／支出加成（micro-USD，可為負）。
 *
 * 只讀 `<prefix><整數>` 形式的旗標；格式錯誤的旗標忽略（不讓壞資料進入遊戲邏輯）。
 */
export function readP3EMoneyModifierMicroUsd(flags: readonly string[], kind: P3EMoneyModifierKind): bigint {
  const prefix = modifierPrefix(kind);
  let total = 0n;
  for (const flag of flags) {
    if (!flag.startsWith(prefix)) continue;
    const value = flag.slice(prefix.length);
    if (!/^-?[0-9]{1,18}$/.test(value)) continue;
    total += BigInt(value);
  }
  return total;
}

/**
 * 把累計 modifier 寫回旗標（移除同前綴舊值、加入新值，維持嚴格升冪）。
 *
 * 總額為 0 時直接移除該旗標（避免留下 `income:mod:0` 這種噪音）。
 */
export function replaceP3EMoneyModifierFlag(
  flags: readonly string[],
  kind: P3EMoneyModifierKind,
  totalMicroUsd: bigint
): readonly string[] {
  const prefix = modifierPrefix(kind);
  const kept = flags.filter((flag) => !flag.startsWith(prefix));
  if (totalMicroUsd !== 0n) kept.push(`${prefix}${totalMicroUsd.toString()}`);
  return Object.freeze(kept.sort());
}

/**
 * 依 money delta 更新旗標（effects 層用）：把 income／expense delta 累加到對應旗標。
 *
 * `balanceMicroUsd` 是單次金額，不需要持續性旗標。
 */
export function applyP3EMoneyModifierDelta(
  flags: readonly string[],
  moneyDelta: {
    /** 可能是 bigint，也可能是 P3-C outcome 的十進位字串（MoneyString）。 */
    readonly annualIncomeMicroUsd: bigint | string;
    readonly annualExpenseMicroUsd: bigint | string;
  }
): readonly string[] {
  const incomeDelta = typeof moneyDelta.annualIncomeMicroUsd === "bigint" ? moneyDelta.annualIncomeMicroUsd : BigInt(moneyDelta.annualIncomeMicroUsd);
  const expenseDelta =
    typeof moneyDelta.annualExpenseMicroUsd === "bigint" ? moneyDelta.annualExpenseMicroUsd : BigInt(moneyDelta.annualExpenseMicroUsd);
  let next = flags;
  if (incomeDelta !== 0n) {
    next = replaceP3EMoneyModifierFlag(next, "income", readP3EMoneyModifierMicroUsd(next, "income") + incomeDelta);
  }
  if (expenseDelta !== 0n) {
    next = replaceP3EMoneyModifierFlag(next, "expense", readP3EMoneyModifierMicroUsd(next, "expense") + expenseDelta);
  }
  return next;
}

/**
 * **age-aware** 的 modifier 寫入（GPT-0033-A）：0–15 歲一律不寫個人持續 modifier。
 *
 * 兒童事件的 money effects 代表家庭層影響，MVP 不進角色個人帳本；若把 delta 寫成
 * `income:mod:`／`expense:mod:`，角色 16 歲以後就會突然帶著兒童期累積的收入／支出
 * （即使沒有 `teen:earned` 或任何工作狀態）。因此在**套 effects 的當下**就依年齡阻止
 * 寫入，而不是 16 歲時再去清旗標（那樣會誤刪 16 歲當期剛產生的合法所得）。
 *
 * @param age        這次 effects 結算後的角色年齡
 * @param flags      套 effects 前的 flags
 * @param moneyDelta 這次 effects 的 money delta（bigint 或 MoneyString）
 */
export function applyP3EMoneyModifierDeltaForAge(
  age: number,
  flags: readonly string[],
  moneyDelta: {
    readonly annualIncomeMicroUsd: bigint | string;
    readonly annualExpenseMicroUsd: bigint | string;
  }
): readonly string[] {
  if (age < P3E_ECONOMY_MIN_EARNING_AGE) return flags;
  return applyP3EMoneyModifierDelta(flags, moneyDelta);
}

/* ------------------------------------------------------------------ */
/* 年度結算（基準 ＋ 明確 modifier）                                    */
/* ------------------------------------------------------------------ */

/** 年度結算輸入（全部來自權威 state ＋ 目標年齡）。 */
export interface P3EAnnualEconomyInput {
  /** 結算後年齡（`state.age + 1`）。 */
  readonly age: number;
  /** 結算前知識（薪資依年初知識結算，roll 層才會得到相同基準值）。 */
  readonly knowledge: number;
  readonly flags: readonly string[];
  readonly lifeFocusId: string | null;
  /** 結算前餘額（可為負）。 */
  readonly previousBalanceMicroUsd: bigint;
}

/**
 * 年度個人經濟結算：
 *
 * ```text
 * income  = max(0, base(age, knowledge, flags, focus).income  + Σ income:mod:*)
 * expense = max(0, base(age, knowledge, flags, focus).expense + Σ expense:mod:*)
 * balance = max(0, previousBalance + income − expense)
 * ```
 *
 * - 0–15 歲：一律回傳全 0（舊存檔的錯值在下一次權威更新後歸零）。
 * - modifier 只來自**明確**寫入的旗標，不從「實際值 − 重算基準」猜測，
 *   因此切換重心／轉職／退休時不會把基準差誤當永久加成。
 */
export function computeP3EAnnualEconomy(input: P3EAnnualEconomyInput): P3EAssets {
  if (input.age < P3E_ECONOMY_MIN_EARNING_AGE) return P3E_ZERO_ASSETS;

  const base = computeP3EBaseEconomy(input.age, input.knowledge, input.flags, input.lifeFocusId);
  const incomeModifier = readP3EMoneyModifierMicroUsd(input.flags, "income");
  const expenseModifier = readP3EMoneyModifierMicroUsd(input.flags, "expense");
  const rawIncome = base.annualIncomeMicroUsd + incomeModifier;
  const rawExpense = base.annualExpenseMicroUsd + expenseModifier;
  const annualIncomeMicroUsd = rawIncome < 0n ? 0n : rawIncome;
  const annualExpenseMicroUsd = rawExpense < 0n ? 0n : rawExpense;
  const net = input.previousBalanceMicroUsd + annualIncomeMicroUsd - annualExpenseMicroUsd;
  return Object.freeze({
    balanceMicroUsd: net < 0n ? 0n : net,
    annualIncomeMicroUsd,
    annualExpenseMicroUsd
  });
}

/* ------------------------------------------------------------------ */
/* 兒童歸零（權威 transition 邊界）                                     */
/* ------------------------------------------------------------------ */

/**
 * 0–15 歲的個人財務歸零（**任何 money effects 之後**都要套用）。
 *
 * 由 simulation 的 effects 層與 Core Draft 組裝層呼叫，因此：
 * - 事件 effects（`ev.any.small-win`、daycare、零用錢…）不會漏出；
 * - 決策選項的 money effects 也不會漏出；
 * - 未來的 money effect 只要走同一條管線就自動被涵蓋，不需要列舉 event id。
 *
 * 16 歲以上原樣回傳（不誤殺合法的青少年所得）。
 */
export function normalizeP3EAssetsForAge(age: number, assets: P3EAssets): P3EAssets {
  if (age >= P3E_ECONOMY_MIN_EARNING_AGE) return assets;
  return P3E_ZERO_ASSETS;
}

/** 是否為合法就業狀態字串（給 UI／測試用的相容型別守衛）。 */
export function isP3EEmploymentStatus(value: string): value is P3EEmploymentStatus {
  return (P3E_EMPLOYMENT_STATUSES as readonly string[]).includes(value);
}
