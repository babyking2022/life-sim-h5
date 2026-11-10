import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  P3BCondition,
  P3BEffect,
  P3BEventPackManifest,
  P3BEventRecord,
  P3BLicenseRecord,
  P3BLineageRecord,
  P3BLifeStage
} from "@life-sim/contracts";
import {
  P3B_ENGINE_VERSION,
  P3B_EVENT_SPEC_VERSION,
  P3B_RNG_SPEC_VERSION,
  P3B_SCHEMA_VERSION
} from "../packages/contracts/src/p3b";
import { computeEventsChecksum, computePackChecksum, validateEventPack } from "../packages/engine/src/life/events";
import {
  P3E_CAREERS,
  P3E_CAREER_CATEGORIES,
  P3E_CAREER_CHOSEN_FLAG,
  careerFlag,
  careersOfTier
} from "../packages/contracts/src/p3e-career";

/**
 * P3-B 合成事件 fixture 產生器（deterministic）。
 *
 * 產出兩份 pack：
 * - `events.v1.json`：22 筆的主 pack（多候選加權抽選、條件、效果、抉擇）。
 * - `edge-events.v1.json`：2 筆的邊界 pack（只為覆蓋 0／1 候選與 guardian 過濾）。
 *
 * 文案全部是 `localizationKey`；授權與 lineage 由 canonical 函式算出，
 * 產生器與驗證器不可能各自維護一套規則。
 */

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "fixtures", "p3b");
const CREATED_AT = "2026-10-27T00:00:00.000Z";
const GENERATED_AT = "2026-10-27T00:00:00.000Z";
const CONTENT_PACK_VERSION = "1.0.0";
/** 主 pack 在 GPT-0025-A 加入 56 個抉擇事件，內容版本升到 1.1.0（edge pack 不變）。 */
const MAIN_CONTENT_PACK_VERSION = "1.1.0";

const sourceIdOf = (packId: string) => `${packId}-source`;

const stat = (key: "health" | "happiness" | "knowledge" | "relationships", delta: number) => ({ type: "stat" as const, stat: key, delta });
const money = (field: "balanceMicroUsd" | "annualIncomeMicroUsd" | "annualExpenseMicroUsd", deltaMicroUsd: string) => ({
  type: "money" as const,
  field,
  deltaMicroUsd
});
const flag = (name: string, action: "add" | "remove") => ({ type: "flag" as const, flag: name, action });
const info = () => ({ type: "informational" as const });

function makeEventFactory(sourceId: string) {
  return (
    record: Partial<P3BEventRecord> &
      Pick<P3BEventRecord, "eventId" | "kind" | "localizationKey" | "ageMin" | "ageMax" | "lifeStages" | "weight">
  ): P3BEventRecord =>
    ({
      eventSpecVersion: P3B_EVENT_SPEC_VERSION,
      contentPackVersion: CONTENT_PACK_VERSION,
      conditions: null,
      priority: 0,
      once: false,
      cooldownYears: 0,
      exclusiveGroup: null,
      contentMode: "guardian",
      effects: [info()],
      decision: null,
      sourceId,
      ...record
    }) as P3BEventRecord;
}

function buildEdgeEvents(): P3BEventRecord[] {
  const event = makeEventFactory(sourceIdOf("p3b-synthetic-edges-v1"));
  return [
    event({
      eventId: "edge.only-one",
      kind: "ordinary",
      localizationKey: "p3b.edge.only_one",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 7,
      once: true,
      effects: [stat("happiness", 1)]
    }),
    event({
      eventId: "edge.guardian-only",
      kind: "ordinary",
      localizationKey: "p3b.edge.guardian_only",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 11,
      contentMode: "guardian",
      conditions: { op: "contentMode", mode: "guardian" },
      effects: [stat("happiness", 2)]
    })
  ];
}

function buildMainEvents(): P3BEventRecord[] {
  const sourceId = sourceIdOf("p3b-synthetic-events-v1");
  const event = makeEventFactory(sourceId);
  const decisionOption = (optionId: string, labelKey: string, effects: P3BEventRecord["effects"]) => ({ optionId, labelKey, effects });
  return [
    event({
      eventId: "ev.child.first-word",
      kind: "milestone",
      localizationKey: "p3b.event.child.first_word",
      ageMin: 1,
      ageMax: 3,
      lifeStages: ["childhood"],
      weight: 30,
      priority: 10,
      once: true,
      effects: [stat("knowledge", 2), stat("happiness", 3)]
    }),
    event({
      eventId: "ev.child.playground",
      kind: "ordinary",
      localizationKey: "p3b.event.child.playground",
      ageMin: 4,
      ageMax: 11,
      lifeStages: ["childhood"],
      weight: 120,
      cooldownYears: 2,
      conditions: { op: "stat", stat: "health", min: 30, max: 100 },
      effects: [stat("relationships", 2), stat("happiness", 1)]
    }),
    event({
      eventId: "ev.child.school-choice",
      kind: "decision",
      localizationKey: "p3b.event.child.school_choice",
      ageMin: 6,
      ageMax: 6,
      lifeStages: ["childhood"],
      weight: 1,
      priority: 100,
      once: true,
      exclusiveGroup: "child.major",
      effects: [{ type: "openDecision", decisionId: "dec.child.school" }],
      decision: {
        decisionId: "dec.child.school",
        promptKey: "p3b.decision.child.school",
        options: [
          decisionOption("steady", "p3b.option.child.school.steady", [stat("knowledge", 3), flag("school:steady", "add")]),
          decisionOption("bold", "p3b.option.child.school.bold", [stat("knowledge", 1), stat("happiness", 2), flag("school:bold", "add")])
        ]
      }
    }),
    event({
      eventId: "ev.child.sibling-arrives",
      kind: "milestone",
      localizationKey: "p3b.event.child.sibling",
      ageMin: 2,
      ageMax: 8,
      lifeStages: ["childhood"],
      weight: 20,
      once: true,
      conditions: { op: "not", condition: { op: "flag", flag: "family:sibling", present: true } },
      effects: [flag("family:sibling", "add"), stat("relationships", 3)]
    }),
    event({
      eventId: "ev.child.tantrum",
      kind: "ordinary",
      localizationKey: "p3b.event.child.tantrum",
      ageMin: 2,
      ageMax: 6,
      lifeStages: ["childhood"],
      weight: 60,
      cooldownYears: 1,
      contentMode: "standard",
      effects: [stat("happiness", -2), stat("relationships", -1)]
    }),
    event({
      eventId: "ev.teen.exams",
      kind: "milestone",
      localizationKey: "p3b.event.teen.exams",
      ageMin: 12,
      ageMax: 12,
      lifeStages: ["adolescence"],
      weight: 1,
      priority: 100,
      once: true,
      effects: [stat("knowledge", 4)]
    }),
    event({
      eventId: "ev.teen.friendship",
      kind: "ordinary",
      localizationKey: "p3b.event.teen.friendship",
      ageMin: 13,
      ageMax: 17,
      lifeStages: ["adolescence"],
      weight: 90,
      cooldownYears: 2,
      effects: [stat("relationships", 2)]
    }),
    event({
      eventId: "ev.teen.part-time-job",
      kind: "ordinary",
      localizationKey: "p3b.event.teen.part_time_job",
      ageMin: 15,
      ageMax: 17,
      lifeStages: ["adolescence"],
      weight: 40,
      conditions: { op: "money", field: "balanceMicroUsd", min: "-1000000000", max: "500000000" },
      effects: [money("balanceMicroUsd", "1500000"), stat("knowledge", 1), stat("health", -1)]
    }),
    event({
      eventId: "ev.teen.risk-experiment",
      kind: "ordinary",
      localizationKey: "p3b.event.teen.risk_experiment",
      ageMin: 14,
      ageMax: 17,
      lifeStages: ["adolescence"],
      weight: 25,
      contentMode: "standard",
      effects: [stat("health", -4), stat("happiness", 2)]
    }),
    event({
      eventId: "ev.teen.major-choice",
      kind: "decision",
      localizationKey: "p3b.event.teen.major_choice",
      ageMin: 18,
      ageMax: 18,
      lifeStages: ["adulthood", "adolescence"],
      weight: 1,
      priority: 100,
      once: true,
      exclusiveGroup: "adult.major",
      effects: [{ type: "openDecision", decisionId: "dec.teen.path" }],
      decision: {
        decisionId: "dec.teen.path",
        promptKey: "p3b.decision.teen.path",
        options: [
          decisionOption("study", "p3b.option.teen.path.study", [stat("knowledge", 5), money("annualExpenseMicroUsd", "2000000")]),
          decisionOption("work", "p3b.option.teen.path.work", [money("annualIncomeMicroUsd", "3000000"), stat("knowledge", 1)]),
          decisionOption("rest", "p3b.option.teen.path.rest", [stat("health", 3), stat("happiness", 2)])
        ]
      }
    }),
    event({
      eventId: "ev.adult.first-salary",
      kind: "milestone",
      localizationKey: "p3b.event.adult.first_salary",
      ageMin: 19,
      ageMax: 24,
      lifeStages: ["adulthood"],
      weight: 50,
      once: true,
      conditions: { op: "flag", flag: "employed", present: true },
      effects: [money("balanceMicroUsd", "5000000"), stat("happiness", 3)]
    }),
    event({
      eventId: "ev.adult.promotion",
      kind: "ordinary",
      localizationKey: "p3b.event.adult.promotion",
      ageMin: 22,
      ageMax: 60,
      lifeStages: ["adulthood"],
      weight: 45,
      cooldownYears: 3,
      conditions: {
        op: "all",
        conditions: [
          { op: "flag", flag: "employed", present: true },
          { op: "stat", stat: "knowledge", min: 40, max: 100 }
        ]
      },
      effects: [money("annualIncomeMicroUsd", "4000000"), stat("happiness", 2)]
    }),
    event({
      eventId: "ev.adult.burnout",
      kind: "ordinary",
      localizationKey: "p3b.event.adult.burnout",
      ageMin: 25,
      ageMax: 60,
      lifeStages: ["adulthood"],
      weight: 30,
      cooldownYears: 4,
      conditions: { op: "stat", stat: "happiness", min: 0, max: 35 },
      effects: [stat("health", -5), stat("happiness", -3)]
    }),
    event({
      eventId: "ev.adult.housing-choice",
      kind: "decision",
      localizationKey: "p3b.event.adult.housing_choice",
      ageMin: 25,
      ageMax: 40,
      lifeStages: ["adulthood"],
      weight: 1,
      priority: 90,
      once: true,
      exclusiveGroup: "adult.major",
      effects: [{ type: "openDecision", decisionId: "dec.adult.housing" }],
      decision: {
        decisionId: "dec.adult.housing",
        promptKey: "p3b.decision.adult.housing",
        options: [
          decisionOption("rent", "p3b.option.adult.housing.rent", [money("annualExpenseMicroUsd", "9000000")]),
          decisionOption("save", "p3b.option.adult.housing.save", [money("balanceMicroUsd", "2000000")])
        ]
      }
    }),
    event({
      eventId: "ev.adult.volunteer",
      kind: "ordinary",
      localizationKey: "p3b.event.adult.volunteer",
      ageMin: 20,
      ageMax: 70,
      lifeStages: ["adulthood", "later_life"],
      weight: 25,
      conditions: { op: "flag", flag: "community:member", present: true },
      effects: [stat("relationships", 3), stat("happiness", 1)]
    }),
    event({
      eventId: "ev.adult.debt-scare",
      kind: "ordinary",
      localizationKey: "p3b.event.adult.debt_scare",
      ageMin: 20,
      ageMax: 65,
      lifeStages: ["adulthood"],
      weight: 20,
      cooldownYears: 5,
      conditions: { op: "money", field: "balanceMicroUsd", min: "-100000000000", max: "-1" },
      effects: [stat("happiness", -4), money("annualExpenseMicroUsd", "1000000")]
    }),
    event({
      eventId: "ev.any.small-win",
      kind: "ordinary",
      localizationKey: "p3b.event.any.small_win",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 70,
      conditions: { op: "cooldown", eventId: "ev.any.setback", years: 2 },
      effects: [stat("happiness", 2), money("balanceMicroUsd", "300000")]
    }),
    event({
      eventId: "ev.any.setback",
      kind: "ordinary",
      localizationKey: "p3b.event.any.setback",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 35,
      cooldownYears: 2,
      effects: [stat("happiness", -2), money("balanceMicroUsd", "-400000")]
    }),
    event({
      eventId: "ev.adult.partner-loss",
      kind: "ordinary",
      localizationKey: "p3b.event.adult.partner_loss",
      ageMin: 30,
      ageMax: 110,
      lifeStages: ["adulthood", "later_life"],
      weight: 8,
      cooldownYears: 20,
      conditions: { op: "flag", flag: "partner:married", present: true },
      effects: [
        stat("happiness", -6),
        stat("health", -2),
        flag("partner:married", "remove"),
        flag("relationship:widowed", "add")
      ]
    }),
    event({
      eventId: "ev.any.quiet-year",
      kind: "ordinary",
      localizationKey: "p3b.event.any.quiet_year",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 10,
      conditions: { op: "happened", eventId: "ev.any.setback" },
      effects: [info()]
    }),
    event({
      eventId: "ev.senior.health-check",
      kind: "ordinary",
      localizationKey: "p3b.event.senior.health_check",
      ageMin: 65,
      ageMax: 120,
      lifeStages: ["later_life"],
      weight: 80,
      cooldownYears: 2,
      effects: [stat("health", 2), money("annualExpenseMicroUsd", "800000")]
    }),
    event({
      eventId: "ev.senior.reflection",
      kind: "milestone",
      localizationKey: "p3b.event.senior.reflection",
      ageMin: 70,
      ageMax: 120,
      lifeStages: ["later_life"],
      weight: 40,
      once: true,
      effects: [stat("happiness", 4)]
    }),
    event({
      eventId: "ev.guardian.calm",
      kind: "ordinary",
      localizationKey: "p3b.event.guardian.calm",
      ageMin: 0,
      ageMax: 120,
      lifeStages: ["childhood", "adolescence", "adulthood", "later_life"],
      weight: 55,
      contentMode: "guardian",
      conditions: { op: "contentMode", mode: "guardian" },
      effects: [stat("happiness", 1)]
    }),
    /* GPT-0025-A：56 個現實人生抉擇事件（168 個選項）。 */
    ...buildChoiceEvents()
  ];
}

/* ------------------------------------------------------------------ */
/* GPT-0025-A：現實人生抉擇包（choice pack v1）                         */
/* ------------------------------------------------------------------ */

/**
 * 56 個現實人生抉擇事件（168 個選項），覆蓋 3–6 歲到 66 歲以上。
 *
 * 設計原則：
 * - 每個選項都必須有**不同的實際後果**（四項屬性、金錢、flags 至少一項不同）；
 * - 一律 `kind: "decision"`＋`openDecision`，選項效果在 CHOOSE_DECISION 套用；
 * - `cooldownYears >= 3`（同一事件不會連續刷出），少數人生節點用 `once`；
 * - `flags` 會影響後續事件是否出現（例如 `business:owner` 之後不再問創業）；
 * - 權重讓正常遊玩平均每 1–3 年遇到一次選擇（100 條人生實測見結果文件）。
 *
 * 文案全部走 `localizationKey`（P3-B 契約禁止把文字寫進事件）；繁中標題／問題／
 * 按鈕文字寫在獨立的內容映射檔 `fixtures/p3b/event-copy.zh-Hant.v1.json`。
 */

interface ChoiceOptionSpec {
  readonly id: string;
  readonly label: string;
  readonly effects: readonly P3BEffect[];
}

interface ChoiceSpec {
  readonly group: "child" | "teen" | "adult" | "late" | "senior";
  readonly slug: string;
  readonly title: string;
  readonly prompt: string;
  readonly ageMin: number;
  readonly ageMax: number;
  readonly stages: readonly P3BLifeStage[];
  readonly weight: number;
  readonly cooldownYears: number;
  readonly once?: boolean;
  readonly priority?: number;
  readonly exclusiveGroup?: string | null;
  readonly conditions?: P3BCondition | null;
  readonly options: readonly ChoiceOptionSpec[];
}

const opt = (id: string, label: string, effects: readonly P3BEffect[]): ChoiceOptionSpec => ({ id, label, effects });

const CHOICE_EVENTS_BASE: readonly ChoiceSpec[] = [
  /* ---------------- 3–6 歲：家庭照顧、幼兒園、興趣啟蒙 ---------------- */
  {
    group: "child",
    slug: "care-arrangement",
    title: "白天由誰照顧",
    prompt: "孩子白天主要由誰照顧？",
    ageMin: 3,
    ageMax: 4,
    stages: ["childhood"],
    weight: 55,
    cooldownYears: 4,
    options: [
      opt("grandparent", "交給祖父母照顧", [stat("relationships", 4), stat("happiness", 1), flag("care:grandparent", "add")]),
      opt("daycare", "送去托嬰中心", [stat("knowledge", 3), stat("happiness", 1), money("annualExpenseMicroUsd", "6000000000")]),
      opt("nanny", "請保母到家裡", [stat("happiness", 2), stat("relationships", 1), money("balanceMicroUsd", "-8000000000")])
    ]
  },
  {
    group: "child",
    slug: "kindergarten",
    title: "幼兒園選擇",
    prompt: "要送孩子去哪一種幼兒園？",
    ageMin: 4,
    ageMax: 5,
    stages: ["childhood"],
    weight: 60,
    cooldownYears: 6,
    options: [
      opt("public", "離家最近的公立幼兒園", [stat("knowledge", 2), stat("relationships", 2), stat("happiness", 1)]),
      opt("private", "雙語私立幼兒園", [stat("knowledge", 5), stat("happiness", -1), money("balanceMicroUsd", "-12000000000")]),
      opt("home", "留在家裡自己帶", [stat("relationships", 3), stat("knowledge", 1), stat("happiness", 2)])
    ]
  },
  {
    group: "child",
    slug: "interest-seed",
    title: "興趣啟蒙",
    prompt: "想讓孩子先接觸哪一種興趣？",
    ageMin: 4,
    ageMax: 6,
    stages: ["childhood"],
    weight: 50,
    cooldownYears: 4,
    options: [
      opt("music", "學音樂", [stat("knowledge", 4), stat("happiness", 2), money("balanceMicroUsd", "-6000000000"), flag("hobby:music", "add")]),
      opt("sport", "學游泳", [stat("health", 5), stat("relationships", 1), flag("hobby:sport", "add")]),
      opt("free", "讓他自由玩耍", [stat("happiness", 4), stat("health", 1)])
    ]
  },
  {
    group: "child",
    slug: "sleep-routine",
    title: "作息安排",
    prompt: "孩子的睡覺時間怎麼安排？",
    ageMin: 3,
    ageMax: 6,
    stages: ["childhood"],
    weight: 45,
    cooldownYears: 4,
    options: [
      opt("early", "固定時間早睡", [stat("health", 5), stat("happiness", 1), flag("habit:sleep", "add")]),
      opt("play", "陪他玩到想睡", [stat("happiness", 3), stat("health", -3)]),
      opt("flexible", "看當天狀況調整", [stat("happiness", 1), stat("health", 1), stat("relationships", 1)])
    ]
  },
  {
    group: "child",
    slug: "picky-eating",
    title: "偏食問題",
    prompt: "孩子挑食的時候，你會怎麼做？",
    ageMin: 3,
    ageMax: 5,
    stages: ["childhood"],
    weight: 45,
    cooldownYears: 4,
    options: [
      opt("guide", "慢慢引導他嘗試", [stat("health", 3), stat("happiness", 1), stat("relationships", 1)]),
      opt("force", "規定一定要吃完", [stat("health", 2), stat("happiness", -3), stat("relationships", -1)]),
      opt("free", "想吃什麼就給他", [stat("happiness", 3), stat("health", -2)])
    ]
  },
  {
    group: "child",
    slug: "first-friend",
    title: "第一個朋友",
    prompt: "孩子交到第一個朋友，你會怎麼做？",
    ageMin: 4,
    ageMax: 6,
    stages: ["childhood"],
    weight: 45,
    cooldownYears: 3,
    options: [
      opt("invite", "邀請對方來家裡玩", [stat("relationships", 5), stat("happiness", 2)]),
      opt("observe", "讓他自己摸索", [stat("knowledge", 2), stat("happiness", -1)]),
      opt("join", "陪他們一起玩", [stat("relationships", 3), stat("health", 1), stat("happiness", 1)])
    ]
  },
  {
    group: "child",
    slug: "screen-time",
    title: "螢幕時間",
    prompt: "孩子想看螢幕時，你會怎麼處理？",
    ageMin: 3,
    ageMax: 6,
    stages: ["childhood"],
    weight: 45,
    cooldownYears: 3,
    options: [
      opt("limited", "訂好每天的時間上限", [stat("health", 3), stat("knowledge", 2), stat("happiness", -1)]),
      opt("free", "讓他自己看", [stat("happiness", 3), stat("health", -2), stat("knowledge", -1)]),
      opt("together", "陪他一起看", [stat("relationships", 3), stat("knowledge", 1), stat("happiness", 1)])
    ]
  },

  /* ---------------- 7–12 歲：學習、朋友、運動、家庭責任 ---------------- */
  {
    group: "child",
    slug: "study-habit",
    title: "讀書習慣",
    prompt: "孩子的讀書習慣要怎麼建立？",
    ageMin: 7,
    ageMax: 9,
    stages: ["childhood"],
    weight: 50,
    cooldownYears: 3,
    options: [
      opt("daily", "每天固定時間讀書", [stat("knowledge", 6), stat("happiness", -1), flag("habit:study", "add")]),
      opt("exam", "只在考試前衝刺", [stat("knowledge", 2), stat("happiness", 1)]),
      opt("play", "邊玩邊學", [stat("knowledge", 3), stat("happiness", 2)])
    ]
  },
  {
    group: "child",
    slug: "friend-conflict",
    title: "朋友吵架",
    prompt: "孩子跟好朋友吵架了，你會建議他怎麼做？",
    ageMin: 8,
    ageMax: 10,
    stages: ["childhood"],
    weight: 50,
    cooldownYears: 3,
    options: [
      opt("apologize", "主動道歉", [stat("relationships", 5), stat("happiness", 1)]),
      opt("ignore", "先冷靜一陣子", [stat("happiness", -2), stat("relationships", -2)]),
      opt("adult", "找老師和家長幫忙", [stat("relationships", 2), stat("knowledge", 1), stat("happiness", -1)])
    ]
  },
  {
    group: "child",
    slug: "sport-team",
    title: "運動隊",
    prompt: "要不要讓孩子加入學校的運動隊？",
    ageMin: 8,
    ageMax: 11,
    stages: ["childhood"],
    weight: 50,
    cooldownYears: 4,
    options: [
      opt("team", "加入球隊", [stat("health", 5), stat("relationships", 3), stat("happiness", 1), money("balanceMicroUsd", "-3000000000")]),
      opt("solo", "自己練跑就好", [stat("health", 4), stat("happiness", 1)]),
      opt("none", "不想運動", [stat("happiness", 2), stat("health", -3)])
    ]
  },
  {
    group: "child",
    slug: "chores",
    title: "家事分工",
    prompt: "家裡的家事要怎麼分配給孩子？",
    ageMin: 7,
    ageMax: 11,
    stages: ["childhood"],
    weight: 45,
    cooldownYears: 3,
    options: [
      opt("fixed", "固定分擔一部分家事", [stat("relationships", 3), stat("knowledge", 1), stat("happiness", 1)]),
      opt("paid", "用零用錢交換家事", [stat("relationships", 1), stat("happiness", 1), money("balanceMicroUsd", "1500000000")]),
      opt("refuse", "讓他專心念書", [stat("knowledge", 2), stat("relationships", -2), stat("happiness", 1)])
    ]
  },
  {
    group: "child",
    slug: "pocket-money",
    title: "零用錢",
    prompt: "拿到零用錢之後，孩子該怎麼用？",
    ageMin: 9,
    ageMax: 12,
    stages: ["childhood"],
    weight: 45,
    cooldownYears: 3,
    options: [
      opt("save", "全部存起來", [money("balanceMicroUsd", "4000000000"), stat("knowledge", 2), stat("happiness", -1)]),
      opt("spend", "買自己想要的東西", [stat("happiness", 4), money("balanceMicroUsd", "-2000000000")]),
      opt("treat", "請朋友吃東西", [stat("relationships", 4), stat("happiness", 1), money("balanceMicroUsd", "-3000000000")])
    ]
  },
  {
    group: "child",
    slug: "competition",
    title: "比賽機會",
    prompt: "學校有一個比賽，孩子要參加嗎？",
    ageMin: 10,
    ageMax: 12,
    stages: ["childhood"],
    weight: 45,
    cooldownYears: 3,
    options: [
      opt("enter", "報名挑戰看看", [stat("knowledge", 3), stat("happiness", 2), stat("health", -1)]),
      opt("skip", "這次先放棄", [stat("happiness", -3), stat("relationships", -1)]),
      opt("watch", "當觀眾觀摩", [stat("knowledge", 1), stat("relationships", 2)])
    ]
  },
  {
    group: "child",
    slug: "bullying",
    title: "被同學排擠",
    prompt: "孩子在學校被同學排擠，你會怎麼做？",
    ageMin: 10,
    ageMax: 12,
    stages: ["childhood"],
    weight: 40,
    cooldownYears: 4,
    options: [
      opt("tell", "陪他告訴老師和家長", [stat("relationships", 3), stat("happiness", 2), stat("knowledge", 1)]),
      opt("endure", "要他自己忍下來", [stat("happiness", -5), stat("health", -1)]),
      opt("fight", "教他直接反擊", [stat("happiness", 1), stat("relationships", -3), stat("health", -1)])
    ]
  },
  {
    group: "child",
    slug: "family-move",
    title: "搬家轉學",
    prompt: "家裡要搬到別的城市，孩子的學校怎麼安排？",
    ageMin: 7,
    ageMax: 12,
    stages: ["childhood"],
    weight: 30,
    cooldownYears: 6,
    options: [
      opt("transfer", "跟著一起轉學", [stat("relationships", -3), stat("knowledge", 1), stat("happiness", -1)]),
      opt("commute", "通勤留在原校", [stat("relationships", 3), stat("health", -2), money("annualExpenseMicroUsd", "4000000000")]),
      opt("relative", "留在親戚家住", [stat("relationships", -1), stat("happiness", -2), stat("knowledge", 1)])
    ]
  },

  /* ---------------- 13–18 歲：升學、社交、風險行為、專長 ---------------- */
  {
    group: "teen",
    slug: "study-plan",
    title: "讀書計畫",
    prompt: "國中之後的讀書方式，你想怎麼安排？",
    ageMin: 13,
    ageMax: 15,
    stages: ["adolescence"],
    weight: 60,
    cooldownYears: 3,
    options: [
      opt("cram", "去補習班跟著進度", [stat("knowledge", 6), stat("happiness", -2), money("annualExpenseMicroUsd", "12000000000")]),
      opt("self", "自己安排讀書進度", [stat("knowledge", 4), stat("happiness", 1), flag("study:self", "add")]),
      opt("coast", "先放鬆再說", [stat("knowledge", -2), stat("happiness", 4)])
    ]
  },
  {
    group: "teen",
    slug: "club",
    title: "社團選擇",
    prompt: "高中社團你想參加哪一個？",
    ageMin: 13,
    ageMax: 16,
    stages: ["adolescence"],
    weight: 55,
    cooldownYears: 4,
    options: [
      opt("music", "熱音社", [stat("happiness", 4), stat("relationships", 3), flag("club:music", "add")]),
      opt("code", "程式研究社", [stat("knowledge", 5), stat("happiness", 1), flag("club:code", "add")]),
      opt("none", "不參加社團", [stat("happiness", -1), stat("knowledge", 1)])
    ]
  },
  {
    group: "teen",
    slug: "first-love",
    title: "初戀",
    prompt: "你對同班同學心動了，要怎麼做？",
    ageMin: 15,
    ageMax: 17,
    stages: ["adolescence"],
    weight: 55,
    cooldownYears: 5,
    options: [
      opt("date", "告白，交往看看", [stat("happiness", 5), stat("relationships", 2), stat("knowledge", -1), flag("teen:partner", "add")]),
      opt("focus", "把心思放回課業", [stat("knowledge", 4), stat("happiness", -2)]),
      opt("secret", "放在心裡不說", [stat("happiness", 2), stat("knowledge", 1)])
    ]
  },
  {
    group: "teen",
    slug: "part-time",
    title: "打工",
    prompt: "課餘時間要不要去打工？",
    ageMin: 16,
    ageMax: 18,
    stages: ["adolescence"],
    weight: 50,
    cooldownYears: 3,
    options: [
      opt("store", "到便利商店打工", [money("balanceMicroUsd", "6000000000"), stat("knowledge", 1), stat("health", -1), flag("teen:earned", "add")]),
      opt("tutor", "接家教", [money("balanceMicroUsd", "9000000000"), stat("knowledge", 2), stat("happiness", -1)]),
      opt("none", "專心當學生", [stat("happiness", 2), stat("knowledge", 1)])
    ]
  },
  {
    group: "teen",
    slug: "risk-invite",
    title: "冒險邀約",
    prompt: "朋友找你去嘗試危險的挑戰，你會怎麼做？",
    ageMin: 15,
    ageMax: 18,
    stages: ["adolescence"],
    weight: 45,
    cooldownYears: 4,
    options: [
      opt("try", "跟著一起嘗試", [stat("happiness", 5), stat("health", -6), stat("relationships", 2), flag("teen:risky", "add")]),
      opt("refuse", "直接拒絕", [stat("relationships", -2), stat("health", 2), stat("happiness", -1)]),
      opt("stop", "勸朋友一起收手", [stat("relationships", 3), stat("happiness", 2), stat("knowledge", 1)])
    ]
  },
  {
    group: "teen",
    slug: "exam-strategy",
    title: "大考策略",
    prompt: "大考將近，你打算怎麼準備？",
    ageMin: 17,
    ageMax: 18,
    stages: ["adolescence"],
    weight: 60,
    cooldownYears: 6,
    options: [
      opt("sprint", "全力衝刺", [stat("knowledge", 7), stat("health", -4), stat("happiness", -1)]),
      opt("balance", "維持作息、穩定複習", [stat("knowledge", 4), stat("health", 1), stat("happiness", 2)]),
      opt("give-up", "放棄這次大考", [stat("happiness", 3), stat("knowledge", -4)])
    ]
  },
  {
    group: "teen",
    slug: "talent",
    title: "專長養成",
    prompt: "課外時間你想把力氣放在哪裡？",
    ageMin: 13,
    ageMax: 18,
    stages: ["adolescence"],
    weight: 50,
    cooldownYears: 4,
    options: [
      opt("instrument", "練樂器", [stat("knowledge", 3), stat("happiness", 3), flag("talent:music", "add")]),
      opt("sport", "練球", [stat("health", 5), stat("relationships", 2), flag("talent:sport", "add")]),
      opt("writing", "練寫作", [stat("knowledge", 5), stat("happiness", 1), flag("talent:writing", "add")])
    ]
  },
  {
    group: "teen",
    slug: "family-duty",
    title: "家庭責任",
    prompt: "家裡需要人手，你會怎麼做？",
    ageMin: 14,
    ageMax: 18,
    stages: ["adolescence"],
    weight: 45,
    cooldownYears: 3,
    options: [
      opt("siblings", "接下照顧弟妹的工作", [stat("relationships", 5), stat("happiness", -1), stat("health", -1)]),
      opt("chores", "分擔家事", [stat("relationships", 3), stat("health", -1), stat("happiness", 1)]),
      opt("self", "先專心自己的事", [stat("happiness", 2), stat("relationships", -3)])
    ]
  },
  {
    group: "teen",
    slug: "online-life",
    title: "網路世界",
    prompt: "網路上的時間你想怎麼用？",
    ageMin: 13,
    ageMax: 17,
    stages: ["adolescence"],
    weight: 45,
    cooldownYears: 3,
    options: [
      opt("create", "學剪片和寫作", [stat("knowledge", 5), stat("happiness", 2), flag("online:creator", "add")]),
      opt("game", "打遊戲放鬆", [stat("happiness", 4), stat("health", -2)]),
      opt("scroll", "只看別人分享", [stat("happiness", 1), stat("knowledge", 1), stat("health", -1)])
    ]
  },

  /* ---------------- 19–30 歲：大學／職訓、求職、搬遷、感情、理財 ---------------- */
  {
    group: "adult",
    slug: "after-school",
    title: "畢業之後",
    prompt: "高中畢業後，你想先做什麼？",
    ageMin: 19,
    ageMax: 20,
    stages: ["adulthood"],
    weight: 70,
    cooldownYears: 8,
    options: [
      opt("university", "繼續升學", [stat("knowledge", 6), money("annualExpenseMicroUsd", "20000000000"), flag("edu:university", "add")]),
      opt("work", "先出社會工作", [money("annualIncomeMicroUsd", "8000000000"), money("balanceMicroUsd", "4000000000"), stat("knowledge", 1), flag("job:early", "add")]),
      opt("gap", "給自己一年的空檔", [stat("happiness", 6), stat("knowledge", 2), money("balanceMicroUsd", "-20000000000")])
    ]
  },
  {
    group: "adult",
    slug: "first-job",
    title: "第一份工作",
    prompt: "第一份正職工作，你會選哪一種？",
    ageMin: 20,
    ageMax: 24,
    stages: ["adulthood"],
    weight: 65,
    cooldownYears: 6,
    options: [
      opt("corp", "進制度完整的大公司", [money("annualIncomeMicroUsd", "24000000000"), stat("health", -2), flag("job:corp", "add")]),
      opt("startup", "加入新創團隊", [stat("knowledge", 4), stat("happiness", 1), money("annualIncomeMicroUsd", "12000000000"), flag("job:startup", "add")]),
      opt("family", "回家裡幫忙", [stat("relationships", 3), stat("happiness", 2), money("annualIncomeMicroUsd", "6000000000"), flag("job:family", "add")])
    ]
  },
  {
    group: "adult",
    slug: "move-city",
    title: "搬到城市",
    prompt: "工作機會在大城市，你要搬嗎？",
    ageMin: 21,
    ageMax: 27,
    stages: ["adulthood"],
    weight: 55,
    cooldownYears: 6,
    options: [
      opt("move", "搬到大城市", [money("annualIncomeMicroUsd", "16000000000"), stat("health", -2), stat("happiness", 2), flag("city:moved", "add")]),
      opt("stay", "留在家鄉", [stat("relationships", 4), stat("health", 1), stat("happiness", 1)]),
      opt("commute", "通勤兩邊跑", [stat("health", -3), stat("happiness", -1), money("annualIncomeMicroUsd", "6000000000")])
    ]
  },
  {
    group: "adult",
    slug: "first-pet",
    title: "養寵物",
    prompt: "生活穩定下來了，要不要養一隻寵物？",
    ageMin: 16,
    ageMax: 70,
    stages: ["adulthood", "later_life"],
    weight: 60,
    cooldownYears: 0,
    once: true,
    options: [
      opt("dog", "領養一隻狗", [flag("pet:dog", "add"), stat("happiness", 4), money("annualExpenseMicroUsd", "6000000000")]),
      opt("cat", "領養一隻貓", [flag("pet:cat", "add"), stat("happiness", 3), money("annualExpenseMicroUsd", "3000000000")]),
      opt("none", "暫時不養", [stat("knowledge", 1)])
    ]
  },

  {
    group: "adult",
    slug: "marital-breakup",
    title: "婚姻的裂痕",
    prompt: "兩個人之間出現了不少摩擦，要怎麼走下去？",
    ageMin: 26,
    ageMax: 100,
    stages: ["adulthood", "later_life"],
    weight: 14,
    cooldownYears: 10,
    conditions: { op: "flag", flag: "partner:married", present: true },
    options: [
      opt("divorce", "決定離婚", [
        stat("happiness", -2),
        money("balanceMicroUsd", "-15000000000"),
        flag("partner:married", "remove"),
        flag("partner:cohabit", "remove"),
        flag("teen:partner", "remove"),
        flag("relationship:divorced", "add")
      ]),
      opt("repair", "一起把事情談開", [stat("relationships", 3), stat("happiness", 2), money("balanceMicroUsd", "-3000000000")]),
      opt("separate", "先分居一段時間", [stat("happiness", -1), money("balanceMicroUsd", "-6000000000")])
    ]
  },
  {
    group: "adult",
    slug: "relationship",
    title: "感情的下一步",
    prompt: "你遇到一位合適的人，想怎麼走下去？",
    ageMin: 22,
    ageMax: 100,
    stages: ["adulthood", "later_life"],
    weight: 55,
    cooldownYears: 6,
    // GPT-DEEPSEEK-0043-A：已婚者只走婚姻事件（marital-breakup）／喪偶事件，
    // 不得再抽到「感情的下一步」，避免 canonical flags 與 profile 說法不一致。
    conditions: { op: "not", condition: { op: "flag", flag: "partner:married", present: true } },
    options: [
      opt("cohabit", "先同居看看", [
        stat("happiness", 4),
        stat("relationships", 3),
        money("annualExpenseMicroUsd", "6000000000"),
        flag("partner:cohabit", "add"),
        flag("partner:married", "remove"),
        flag("teen:partner", "remove"),
        flag("relationship:divorced", "remove"),
        flag("relationship:widowed", "remove")
      ]),
      opt("marry", "結婚", [
        stat("relationships", 5),
        stat("happiness", 4),
        money("balanceMicroUsd", "-30000000000"),
        flag("partner:married", "add"),
        flag("partner:cohabit", "remove"),
        flag("teen:partner", "remove"),
        flag("relationship:divorced", "remove"),
        flag("relationship:widowed", "remove")
      ]),
      opt("single", "保持單身", [
        stat("happiness", 2),
        money("balanceMicroUsd", "10000000000"),
        flag("teen:partner", "remove"),
        flag("partner:cohabit", "remove"),
        flag("partner:married", "remove"),
        // GPT-DEEPSEEK-0044-A：divorced／widowed 的玩家回到單身時，
        // canonical flags 也必須清掉，避免「畫面 single、state 仍 widowed」。
        flag("relationship:divorced", "remove"),
        flag("relationship:widowed", "remove")
      ])
    ]
  },
  {
    group: "adult",
    slug: "finance-start",
    title: "開始理財",
    prompt: "有了穩定收入之後，錢要怎麼安排？",
    ageMin: 23,
    ageMax: 30,
    stages: ["adulthood"],
    weight: 55,
    cooldownYears: 4,
    options: [
      opt("save", "每月固定存錢", [money("balanceMicroUsd", "12000000000"), stat("knowledge", 3), stat("happiness", -1)]),
      opt("invest", "開始學習投資", [money("balanceMicroUsd", "6000000000"), stat("knowledge", 4), stat("happiness", 1), flag("finance:invest", "add")]),
      opt("spend", "先享受生活", [stat("happiness", 5), money("balanceMicroUsd", "-8000000000")])
    ]
  },
  {
    group: "adult",
    slug: "side-project",
    title: "副業",
    prompt: "下班後的時間要拿來做副業嗎？",
    ageMin: 24,
    ageMax: 30,
    stages: ["adulthood"],
    weight: 50,
    cooldownYears: 5,
    options: [
      opt("launch", "開始經營副業", [money("annualIncomeMicroUsd", "8000000000"), stat("health", -2), stat("happiness", 3), flag("side:business", "add")]),
      opt("focus", "專注本業", [money("annualIncomeMicroUsd", "6000000000"), stat("knowledge", 3)]),
      opt("rest", "好好休息", [stat("health", 4), stat("happiness", 3)])
    ]
  },
  {
    group: "adult",
    slug: "further-study",
    title: "進修",
    prompt: "工作幾年之後，要不要再進修？",
    ageMin: 25,
    ageMax: 30,
    stages: ["adulthood"],
    weight: 45,
    cooldownYears: 8,
    // GPT-DEEPSEEK-0041-A：碩士／博士都需要先完成大學（模擬層就擋，不靠 UI 隱藏）。
    conditions: { op: "flag", flag: "edu:university", present: true },
    options: [
      opt("master", "去讀研究所", [stat("knowledge", 7), money("balanceMicroUsd", "-25000000000"), flag("edu:master", "add")]),
      opt("doctorate", "攻讀博士", [
        stat("knowledge", 10),
        stat("happiness", -2),
        money("balanceMicroUsd", "-40000000000"),
        flag("edu:doctorate", "add")
      ]),
      opt("online", "上線上課程", [stat("knowledge", 4), money("balanceMicroUsd", "-3000000000")]),
      opt("none", "先不進修", [stat("happiness", 2), money("balanceMicroUsd", "2000000000")])
    ]
  },
  {
    group: "adult",
    slug: "friend-circle",
    title: "朋友圈",
    prompt: "出社會之後，朋友關係要怎麼維持？",
    ageMin: 23,
    ageMax: 30,
    stages: ["adulthood"],
    weight: 45,
    cooldownYears: 3,
    options: [
      opt("regular", "固定聚會", [stat("relationships", 5), stat("happiness", 2), money("balanceMicroUsd", "-2000000000")]),
      opt("busy", "各忙各的", [stat("happiness", -2), stat("relationships", -2), money("balanceMicroUsd", "1000000000")]),
      opt("club", "參加社團認識新朋友", [stat("relationships", 4), stat("knowledge", 1), stat("happiness", 1)])
    ]
  },

  /* ---------------- 31–50 歲：職涯、創業、家庭、住房、健康 ---------------- */
  {
    group: "adult",
    slug: "career-pivot",
    title: "轉職",
    prompt: "同一個領域做久了，要轉職嗎？",
    ageMin: 31,
    ageMax: 40,
    stages: ["adulthood"],
    weight: 60,
    cooldownYears: 6,
    options: [
      opt("pivot", "轉行重新開始", [stat("knowledge", 4), stat("happiness", 2), money("annualIncomeMicroUsd", "8000000000"), flag("career:pivot", "add")]),
      opt("stay", "留在原職", [money("annualIncomeMicroUsd", "10000000000"), stat("happiness", -2), stat("health", -1)]),
      opt("wait", "先觀察一年", [stat("knowledge", 2), stat("happiness", 1)])
    ]
  },
  {
    group: "adult",
    slug: "startup",
    title: "創業",
    prompt: "有人找你一起創業，你要加入嗎？",
    ageMin: 32,
    ageMax: 45,
    stages: ["adulthood"],
    weight: 55,
    cooldownYears: 8,
    conditions: { op: "not", condition: { op: "flag", flag: "business:owner", present: true } },
    options: [
      opt("start", "自己出來創業", [money("annualIncomeMicroUsd", "20000000000"), money("balanceMicroUsd", "-40000000000"), stat("health", -4), stat("happiness", 3), flag("business:owner", "add")]),
      opt("partner", "跟朋友合夥", [money("annualIncomeMicroUsd", "12000000000"), stat("relationships", -2), stat("happiness", 2), flag("business:partner", "add")]),
      opt("none", "留在原本的工作", [money("annualIncomeMicroUsd", "4000000000"), stat("happiness", 1)])
    ]
  },
  {
    group: "adult",
    slug: "children",
    title: "生養孩子",
    prompt: "要不要有孩子？",
    ageMin: 31,
    ageMax: 42,
    stages: ["adulthood"],
    weight: 55,
    cooldownYears: 10,
    conditions: {
      op: "not",
      condition: { op: "any", conditions: [{ op: "flag", flag: "parent:own", present: true }, { op: "flag", flag: "parent:adopt", present: true }] }
    },
    options: [
      opt("own", "生一個孩子", [stat("relationships", 6), stat("happiness", 4), money("annualExpenseMicroUsd", "15000000000"), flag("parent:own", "add")]),
      opt("adopt", "領養孩子", [stat("relationships", 5), stat("happiness", 4), money("annualExpenseMicroUsd", "10000000000"), flag("parent:adopt", "add")]),
      opt("none", "不生小孩", [stat("happiness", 2), money("balanceMicroUsd", "20000000000")])
    ]
  },
  {
    group: "adult",
    slug: "housing-buy",
    title: "買房",
    prompt: "存到一筆錢了，要買房嗎？",
    ageMin: 33,
    ageMax: 45,
    stages: ["adulthood"],
    weight: 55,
    cooldownYears: 10,
    conditions: { op: "not", condition: { op: "flag", flag: "house:owner", present: true } },
    options: [
      opt("buy", "貸款買房", [money("balanceMicroUsd", "-150000000000"), stat("happiness", 5), stat("health", -2), flag("house:owner", "add")]),
      opt("rent", "繼續租屋", [stat("happiness", -1), money("balanceMicroUsd", "30000000000")]),
      opt("suburb", "搬到郊區", [stat("health", 2), stat("happiness", 3), money("balanceMicroUsd", "-6000000000"), flag("house:suburb", "add")])
    ]
  },
  {
    group: "adult",
    slug: "health-checkup",
    title: "健康檢查",
    prompt: "身體開始出現小毛病，要怎麼處理？",
    ageMin: 35,
    ageMax: 50,
    stages: ["adulthood"],
    weight: 50,
    cooldownYears: 4,
    options: [
      opt("regular", "每年定期檢查", [stat("health", 6), money("balanceMicroUsd", "-5000000000"), flag("health:checked", "add")]),
      opt("symptom", "不舒服才去看醫生", [stat("health", -1), stat("happiness", 1), money("balanceMicroUsd", "1000000000")]),
      opt("never", "完全不做檢查", [stat("health", -4), stat("happiness", 2)])
    ]
  },
  {
    group: "adult",
    slug: "elder-care",
    title: "照顧長輩",
    prompt: "父母年紀大了，照顧方式怎麼安排？",
    ageMin: 40,
    ageMax: 50,
    stages: ["adulthood"],
    weight: 50,
    cooldownYears: 6,
    /*
     * GPT-DEEPSEEK-0073-B：長輩照顧是**一次性的持久事實**。
     * 只要做過安排（接來同住／請看護／手足輪流），這個決定就不再出現；
     * 不是靠 cooldown 讓同一件事被問第二次。
     */
    once: true,
    conditions: {
      op: "not",
      condition: {
        op: "any",
        conditions: [
          { op: "flag", flag: "care:parents-live", present: true },
          { op: "flag", flag: "care:parents-arranged", present: true }
        ]
      }
    },
    options: [
      opt("live", "接來一起住（之後由你照顧）", [
        stat("relationships", 5),
        stat("health", -3),
        stat("happiness", -1),
        money("annualExpenseMicroUsd", "6000000000"),
        flag("care:parents-live", "add"),
        flag("care:parents-arranged", "remove")
      ]),
      opt("nurse", "請看護到府協助", [
        money("balanceMicroUsd", "-15000000000"),
        stat("relationships", 2),
        stat("health", 1),
        flag("care:parents-arranged", "add"),
        flag("care:parents-live", "remove")
      ]),
      opt("share", "由兄弟姊妹輪流照顧", [
        stat("relationships", 3),
        money("balanceMicroUsd", "-4000000000"),
        stat("happiness", 1),
        flag("care:parents-arranged", "add"),
        flag("care:parents-live", "remove")
      ])
    ]
  },
  {
    group: "adult",
    slug: "kids-school",
    title: "孩子上學",
    prompt: "孩子上學之後，學習要怎麼安排？",
    ageMin: 36,
    ageMax: 48,
    stages: ["adulthood"],
    weight: 45,
    cooldownYears: 5,
    conditions: {
      op: "any",
      conditions: [{ op: "flag", flag: "parent:own", present: true }, { op: "flag", flag: "parent:adopt", present: true }]
    },
    options: [
      opt("tutor", "送去補習", [stat("knowledge", 2), money("balanceMicroUsd", "-8000000000"), stat("happiness", -1), stat("relationships", 1)]),
      opt("accompany", "陪著一起學習", [stat("relationships", 5), stat("happiness", 3), stat("knowledge", 2)]),
      opt("free", "讓他自己摸索", [stat("happiness", 1), stat("relationships", -2), stat("knowledge", 1)])
    ]
  },
  {
    group: "adult",
    slug: "midlife-review",
    title: "中年檢視",
    prompt: "工作與生活開始拉扯，你要怎麼調整？",
    ageMin: 41,
    ageMax: 50,
    stages: ["adulthood"],
    weight: 50,
    cooldownYears: 6,
    options: [
      opt("reduce", "減少工時", [stat("health", 4), stat("happiness", 4), money("balanceMicroUsd", "-12000000000")]),
      opt("push", "再拚一次升遷", [money("annualIncomeMicroUsd", "16000000000"), stat("health", -4), stat("happiness", -1)]),
      opt("keep", "維持現狀", [stat("happiness", 1), stat("health", -1)])
    ]
  },
  {
    group: "adult",
    slug: "investment",
    title: "投資方式",
    prompt: "手上有一筆閒錢，要怎麼投資？",
    ageMin: 31,
    ageMax: 50,
    stages: ["adulthood"],
    weight: 45,
    cooldownYears: 5,
    options: [
      opt("dollar", "定期定額", [money("balanceMicroUsd", "20000000000"), stat("knowledge", 4)]),
      opt("leverage", "槓桿操作", [money("balanceMicroUsd", "-30000000000"), stat("happiness", 3), stat("health", -2)]),
      opt("none", "只放定存", [money("balanceMicroUsd", "10000000000"), stat("happiness", -1)])
    ]
  },
  {
    group: "adult",
    slug: "network",
    title: "人脈經營",
    prompt: "同事邀你参加產業聚會，你要去嗎？",
    ageMin: 31,
    ageMax: 50,
    stages: ["adulthood"],
    weight: 45,
    cooldownYears: 4,
    options: [
      opt("invest", "花時間經營人脈", [stat("relationships", 5), stat("knowledge", 2), money("balanceMicroUsd", "-4000000000")]),
      opt("close", "只跟知己往來", [stat("relationships", 3), stat("happiness", 2)]),
      opt("alone", "不特別社交", [stat("relationships", -3), stat("happiness", -1), stat("knowledge", 1)])
    ]
  },

  /* ---------------- 51–64 歲：照顧家人、轉職、投資、健康 ---------------- */
  {
    group: "late",
    slug: "career-change",
    title: "轉換跑道",
    prompt: "接近退休，還想換一次跑道嗎？",
    ageMin: 51,
    ageMax: 64,
    stages: ["adulthood"],
    weight: 50,
    cooldownYears: 8,
    options: [
      opt("change", "換去做真正喜歡的事", [stat("knowledge", 3), stat("happiness", 4), money("balanceMicroUsd", "-9000000000")]),
      opt("stay", "撐到退休", [money("annualIncomeMicroUsd", "8000000000"), stat("health", -3), stat("happiness", -2)]),
      opt("semi", "轉成兼職", [stat("health", 3), stat("happiness", 3), money("balanceMicroUsd", "-12000000000")])
    ]
  },
  {
    group: "late",
    slug: "elder-care",
    title: "長輩照護",
    prompt: "長輩的狀況變差了，照護怎麼安排？",
    ageMin: 51,
    ageMax: 64,
    stages: ["adulthood"],
    weight: 50,
    cooldownYears: 6,
    // GPT-DEEPSEEK-0073-B：與 40–50 歲那一次共用同一組持久旗標，安排完成就不再問。
    once: true,
    conditions: {
      op: "not",
      condition: {
        op: "any",
        conditions: [
          { op: "flag", flag: "care:parents-live", present: true },
          { op: "flag", flag: "care:parents-arranged", present: true }
        ]
      }
    },
    options: [
      opt("self", "繼續由你親自照顧", [
        stat("relationships", 5),
        stat("health", -4),
        stat("happiness", -1),
        flag("care:parents-live", "add"),
        flag("care:parents-arranged", "remove")
      ]),
      opt("hire", "請外籍看護分擔", [
        money("balanceMicroUsd", "-20000000000"),
        stat("relationships", 3),
        stat("health", 1),
        flag("care:parents-arranged", "add"),
        flag("care:parents-live", "remove")
      ]),
      opt("facility", "安排住進安養機構", [
        money("balanceMicroUsd", "-15000000000"),
        stat("relationships", 1),
        stat("happiness", -2),
        flag("care:parents-arranged", "add"),
        flag("care:parents-live", "remove")
      ])
    ]
  },
  {
    group: "late",
    slug: "pension",
    title: "退休金準備",
    prompt: "退休金要怎麼準備？",
    ageMin: 51,
    ageMax: 64,
    stages: ["adulthood"],
    weight: 50,
    cooldownYears: 6,
    options: [
      opt("safe", "保守存退休金", [money("balanceMicroUsd", "30000000000"), stat("health", 1), flag("pension:safe", "add")]),
      opt("risky", "積極投資", [money("balanceMicroUsd", "15000000000"), stat("happiness", 2), stat("health", -3)]),
      opt("none", "走一步算一步", [stat("happiness", 3), money("balanceMicroUsd", "-20000000000")])
    ]
  },
  {
    group: "late",
    slug: "chronic-care",
    title: "慢性病",
    prompt: "檢查出慢性病，你會怎麼面對？",
    ageMin: 51,
    ageMax: 64,
    stages: ["adulthood"],
    weight: 50,
    cooldownYears: 5,
    options: [
      opt("treat", "規律回診治療", [stat("health", 5), money("balanceMicroUsd", "-8000000000")]),
      opt("folk", "試試親友介紹的偏方", [stat("health", -4), stat("happiness", 2), money("balanceMicroUsd", "-3000000000")]),
      opt("ignore", "當作沒事", [stat("health", -6), stat("happiness", -1)])
    ]
  },
  {
    group: "late",
    slug: "family-time",
    title: "家庭時間",
    prompt: "工作與家人時間衝突，你要怎麼選？",
    ageMin: 51,
    ageMax: 64,
    stages: ["adulthood"],
    weight: 45,
    cooldownYears: 4,
    options: [
      opt("more", "多陪家人", [stat("relationships", 6), stat("happiness", 4), money("balanceMicroUsd", "-7500000000")]),
      opt("overtime", "繼續加班", [money("annualIncomeMicroUsd", "10000000000"), stat("health", -3), stat("relationships", -2)]),
      opt("separate", "各過各的", [stat("happiness", -2), stat("relationships", -3)])
    ]
  },
  {
    group: "late",
    slug: "new-hobby",
    title: "新的興趣",
    prompt: "空出來的時間想做什麼？",
    ageMin: 55,
    ageMax: 64,
    stages: ["adulthood"],
    weight: 45,
    cooldownYears: 4,
    options: [
      opt("learn", "學一項新技能", [stat("knowledge", 5), stat("happiness", 3), money("balanceMicroUsd", "-4000000000")]),
      opt("travel", "到處旅行", [stat("happiness", 5), stat("health", 1), money("balanceMicroUsd", "-12000000000")]),
      opt("home", "待在家裡", [stat("health", 1), stat("happiness", -2)])
    ]
  },

  /* ---------------- 66 歲以上：退休、居住、醫療、傳承與社交 ---------------- */
  {
    group: "senior",
    slug: "retirement",
    title: "退休決定",
    prompt: "什麼時候要真正退休？",
    ageMin: 65,
    ageMax: 75,
    stages: ["later_life"],
    weight: 55,
    cooldownYears: 12,
    /*
     * GPT-DEEPSEEK-0073-B：退休只決定一次。三種結果都寫持久旗標，
     * 之後不會再被問第二次（不是 cooldown 到期就重問）。
     */
    once: true,
    conditions: {
      op: "not",
      condition: {
        op: "any",
        conditions: [
          { op: "flag", flag: "retired", present: true },
          { op: "flag", flag: "working:senior", present: true },
          { op: "flag", flag: "retire:part", present: true }
        ]
      }
    },
    options: [
      opt("full", "完全退休", [
        stat("health", 4),
        stat("happiness", 3),
        money("balanceMicroUsd", "-9000000000"),
        flag("retired", "add"),
        flag("working:senior", "remove"),
        flag("retire:part", "remove")
      ]),
      opt("keep", "繼續工作", [
        money("annualIncomeMicroUsd", "8000000000"),
        stat("health", -4),
        flag("working:senior", "add"),
        flag("retired", "remove"),
        flag("retire:part", "remove")
      ]),
      opt("part", "轉成兼職", [
        money("annualIncomeMicroUsd", "3000000000"),
        stat("happiness", 2),
        stat("health", 1),
        flag("retire:part", "add"),
        flag("retired", "remove"),
        flag("working:senior", "remove")
      ])
    ]
  },
  {
    group: "senior",
    slug: "housing",
    title: "老後居住",
    prompt: "年紀大了，居住安排怎麼選？",
    ageMin: 66,
    ageMax: 85,
    stages: ["later_life"],
    weight: 50,
    cooldownYears: 8,
    /*
     * GPT-DEEPSEEK-0073-B：老後住所是**互斥的持久狀態**。
     * - 三個狀態（機構／與子女同住／獨居）最多只會存在一個；
     * - 一旦選定（任何一個），這個決定永不再出現；
     * - 每個選項都先移除另外兩個狀態，再加入自己。
     */
    once: true,
    conditions: {
      op: "not",
      condition: {
        op: "any",
        conditions: [
          { op: "flag", flag: "senior:care", present: true },
          { op: "flag", flag: "senior:family", present: true },
          { op: "flag", flag: "senior:alone", present: true }
        ]
      }
    },
    options: [
      opt("care", "住進養護機構（已安排入住）", [
        stat("health", 3),
        stat("relationships", 2),
        money("balanceMicroUsd", "-20000000000"),
        flag("senior:care", "add"),
        flag("senior:family", "remove"),
        flag("senior:alone", "remove")
      ]),
      opt("family", "搬去與子女同住", [
        stat("relationships", 4),
        stat("happiness", 2),
        flag("senior:family", "add"),
        flag("senior:care", "remove"),
        flag("senior:alone", "remove")
      ]),
      opt("alone", "留在原本的住處獨居", [
        stat("happiness", -2),
        stat("health", -2),
        money("balanceMicroUsd", "5000000000"),
        flag("senior:alone", "add"),
        flag("senior:care", "remove"),
        flag("senior:family", "remove")
      ])
    ]
  },
  {
    group: "senior",
    slug: "medical",
    title: "醫療選擇",
    prompt: "醫生說需要長期治療，你要怎麼決定？",
    ageMin: 66,
    ageMax: 100,
    stages: ["later_life"],
    weight: 50,
    cooldownYears: 5,
    options: [
      opt("aggressive", "積極治療", [stat("health", 4), money("balanceMicroUsd", "-15000000000")]),
      opt("hospice", "選擇安寧照護", [stat("happiness", 3), stat("health", -2)]),
      opt("natural", "順其自然", [stat("happiness", 1), stat("health", -3)])
    ]
  },
  {
    group: "senior",
    slug: "legacy",
    title: "傳承安排",
    prompt: "身後的事，你想怎麼安排？",
    ageMin: 68,
    ageMax: 95,
    stages: ["later_life"],
    weight: 45,
    cooldownYears: 10,
    options: [
      opt("will", "立好遺囑", [stat("relationships", 4), stat("happiness", 3), stat("knowledge", 2)]),
      opt("talk", "跟家人交代後事", [stat("relationships", 3), stat("happiness", 2)]),
      opt("avoid", "避而不談", [stat("happiness", -2), stat("relationships", -1)])
    ]
  },
  {
    group: "senior",
    slug: "social",
    title: "社交生活",
    prompt: "退休後的社交生活要怎麼安排？",
    ageMin: 66,
    ageMax: 100,
    stages: ["later_life"],
    weight: 45,
    cooldownYears: 4,
    options: [
      opt("community", "參加社區活動", [stat("relationships", 5), stat("happiness", 3), stat("health", 1)]),
      opt("old-friends", "跟老朋友聚會", [stat("relationships", 4), stat("happiness", 2)]),
      opt("alone", "享受獨處", [stat("happiness", 2), stat("relationships", -3)])
    ]
  },
  {
    group: "senior",
    slug: "grandchildren",
    title: "孫輩陪伴",
    prompt: "子女希望你幫忙帶孫子，你的想法是？",
    ageMin: 66,
    ageMax: 90,
    stages: ["later_life"],
    weight: 45,
    cooldownYears: 5,
    conditions: {
      op: "any",
      conditions: [{ op: "flag", flag: "parent:own", present: true }, { op: "flag", flag: "parent:adopt", present: true }]
    },
    options: [
      opt("often", "常常幫忙帶", [stat("relationships", 5), stat("happiness", 2), stat("health", -3)]),
      opt("sometimes", "偶爾幫忙", [stat("relationships", 3), stat("happiness", 2)]),
      opt("decline", "不插手", [stat("happiness", 1), stat("relationships", -2)])
    ]
  },
  {
    group: "senior",
    slug: "daily-health",    title: "日常保健",
    prompt: "每天的體力要怎麼維持？",
    ageMin: 66,
    ageMax: 110,
    stages: ["later_life"],
    weight: 45,
    cooldownYears: 3,
    options: [
      opt("walk", "每天散步", [stat("health", 5), stat("happiness", 1)]),
      opt("gym", "上健身房", [stat("health", 4), money("balanceMicroUsd", "-6000000000")]),
      opt("still", "能不動就不動", [stat("health", -3), stat("happiness", 2)])
    ]
  }
];

/** 既有 22 個事件的繁中文案（與 `packages/ui/src/p3e-real-main.ts` 目前的對照一致）。 */
/** 職業分類的繁中名稱（只用在選項文案；顯示層字典仍以 key 為準）。 */
const CAREER_CATEGORY_TEXT: Readonly<Record<string, { readonly label: string; readonly hint: string }>> = {
  service: { label: "一般服務（餐飲、旅宿、門市）", hint: "先累積現場經驗，之後再往管理走" },
  trade: { label: "技術工種（工廠、工地、運輸、水電）", hint: "靠技術與體力換取穩定收入" },
  office: { label: "行政商務（行政、業務、會計、人資）", hint: "辦公室工作，重視細心與溝通" },
  care: { label: "教育醫療（教師、護理、醫師、照護）", hint: "需要專業訓練，但工作穩定" },
  tech: { label: "科技工程（工程師、軟體、設計、實驗）", hint: "技術密集、成長空間大" },
  independent: { label: "創業自由業（創業、接案、自營、務農）", hint: "收入彈性大，風險也高" }
};

/** 職業的繁中名稱（`p3b.career.<id>` 的值）。 */
const CAREER_NAME_TEXT: Readonly<Record<string, string>> = {
  waiter: "服務生",
  cook: "廚師",
  hotel_manager: "旅宿主管",
  chef: "主廚",
  factory_worker: "工廠作業員",
  driver: "職業駕駛",
  construction_worker: "建築工",
  electrician: "水電技師",
  site_supervisor: "工地主任",
  clerk: "行政人員",
  salesperson: "業務銷售",
  accountant: "會計",
  hr_specialist: "人力資源專員",
  care_worker: "照顧服務員",
  care_assistant: "照護助理",
  teacher: "教師",
  nurse: "護理師",
  physician: "醫師",
  lab_technician: "實驗技術員",
  designer: "設計師",
  engineer: "工程師",
  software_engineer: "軟體工程師",
  farmer: "農夫",
  shopkeeper: "自營店主",
  freelancer: "自由工作者",
  entrepreneur: "創業者",
  consultant: "顧問"
};

/**
 * GPT-DEEPSEEK-0054-A：兩階段職業選擇。
 *
 * 階段一 `ev.career-field`：六個分類，選完寫 `career:field:<id>`。
 * 階段二 `ev.career-<category>-<tier>`：只放該分類、該學歷 tier 的職業，
 * 因此「不符合學歷條件的職業」根本不會出現在選項裡（模擬層就擋掉）。
 */
const CAREER_CHOICE_EVENTS: readonly ChoiceSpec[] = [
  {
    group: "adult",
    slug: "career-field",
    title: "職涯方向",
    prompt: "要進入社會了，你想先往哪個方向找工作？",
    // GPT-DEEPSEEK-0054-A：22 歲之後才問，讓 19–20 歲的升學／工作選擇先發生。
    ageMin: 22,
    ageMax: 40,
    stages: ["adulthood"],
    weight: 950,
    cooldownYears: 0,
    once: true,
    priority: 20,
    conditions: { op: "not", condition: { op: "flag", flag: P3E_CAREER_CHOSEN_FLAG, present: true } },
    options: P3E_CAREER_CATEGORIES.map((category) =>
      opt(category.id === "service" ? "field-service" : `field-${category.id}`, CAREER_CATEGORY_TEXT[category.id]
        ?.label as string, [flag(`career:field:${category.id}`, "add")])
    )
  },
  ...P3E_CAREER_CATEGORIES.flatMap((category) =>
    (["entry", "degree"] as const).map(
      (tier): ChoiceSpec => ({
        group: "adult",
        slug: `career-${category.id}-${tier}`,
        title: tier === "entry" ? "第一份工作" : "專業工作",
        prompt:
          tier === "entry"
            ? "依你目前的學歷，這些工作現在就能開始，你想做哪一個？"
            : "依你的學歷，這些工作需要專業訓練，你想做哪一個？",
        ageMin: 18,
        ageMax: 55,
        stages: ["adulthood"],
        weight: 990,
        cooldownYears: 0,
        once: true,
        priority: 30,
        conditions: {
          op: "all",
          conditions: [
            { op: "flag", flag: `career:field:${category.id}`, present: true },
            { op: "not", condition: { op: "flag", flag: P3E_CAREER_CHOSEN_FLAG, present: true } },
            tier === "entry"
              ? {
                  op: "all",
                  conditions: [
                    { op: "not", condition: { op: "flag", flag: "edu:university", present: true } },
                    { op: "not", condition: { op: "flag", flag: "edu:master", present: true } },
                    { op: "not", condition: { op: "flag", flag: "edu:doctorate", present: true } }
                  ]
                }
              : {
                  op: "any",
                  conditions: [
                    { op: "flag", flag: "edu:university", present: true },
                    { op: "flag", flag: "edu:master", present: true },
                    { op: "flag", flag: "edu:doctorate", present: true }
                  ]
                }
          ]
        },
        options: careersOfTier(category.id, tier).map((entry) =>
          opt(entry.id, CAREER_NAME_TEXT[entry.id] as string, [
            flag(careerFlag(entry.id), "add"),
            flag(P3E_CAREER_CHOSEN_FLAG, "add"),
            money("annualIncomeMicroUsd", entry.baseAnnualIncomeMicroUsd.toString())
          ])
        )
      })
    )
  )
];


/** 全部決策事件＝既有事件 ＋ 職業兩階段事件（GPT-DEEPSEEK-0054-A）。 */
const CHOICE_EVENTS: readonly ChoiceSpec[] = [...CHOICE_EVENTS_BASE, ...CAREER_CHOICE_EVENTS];


const LEGACY_COPY: Readonly<Record<string, string>> = {
  "ev.adult.burnout": "工作帶來了倦怠感",
  "ev.adult.debt-scare": "債務壓力突然逼近",
  "ev.adult.first-salary": "領到人生第一份薪水",
  "ev.adult.housing-choice": "面臨居住安排的重要選擇",
  "ev.adult.promotion": "在工作上獲得晉升",
  "ev.adult.volunteer": "參加了一次志工活動",
  "ev.any.quiet-year": "平靜地度過了一年",
  "ev.adult.partner-loss": "配偶離世了",
  "ev.any.setback": "遇到了一次挫折",
  "ev.any.small-win": "收穫了一個小小的成功",
  "ev.child.first-word": "說出了人生第一句話",
  "ev.child.playground": "在遊樂場交到了新朋友",
  "ev.child.school-choice": "面臨入學方式的選擇",
  "ev.child.sibling-arrives": "家裡迎來了新的手足",
  "ev.child.tantrum": "因為不順心而大哭了一場",
  "ev.guardian.calm": "在家人的照顧下平靜成長",
  "ev.senior.health-check": "完成了一次健康檢查",
  "ev.senior.reflection": "回望自己走過的人生",
  "ev.teen.exams": "迎來了一場重要考試",
  "ev.teen.friendship": "交到了一位知心朋友",
  "ev.teen.major-choice": "面臨未來方向的重要選擇",
  "ev.teen.part-time-job": "開始了人生第一份打工",
  "ev.teen.risk-experiment": "嘗試了一次冒險",
  "p3b.decision.adult.housing": "你要怎麼安排接下來的住處？",
  "p3b.decision.child.school": "你希望選擇哪一種學習方式？",
  "p3b.decision.teen.path": "高中階段結束了，下一步要怎麼走？",
  "p3b.option.adult.housing.rent": "先租房，換取自己的生活空間",
  "p3b.option.adult.housing.save": "暫時不搬，把錢存下來",
  "p3b.option.child.school.bold": "選擇更多元、充滿挑戰的學習環境",
  "p3b.option.child.school.steady": "選擇穩定、按部就班的學習環境",
  "p3b.option.teen.path.rest": "先休息一年，重新思考方向",
  "p3b.option.teen.path.study": "繼續升學，累積知識",
  "p3b.option.teen.path.work": "開始工作，累積實務經驗"
};

/**
 * GPT-DEEPSEEK-0040-A：泛稱挫折／成功的「具體變體」文案。
 *
 * 每筆是 `detailId → 繁中句子`，detailId 格式固定為
 * `p3b.detail.<setback|small-win>.<lifeStage>.<1..4>`；application 只用 ID，
 * 這段文字只存在顯示層字典，不進 events checksum、也不進 canonical state。
 */
const DETAIL_COPY: Readonly<Record<"setback" | "small-win", Readonly<Record<string, readonly string[]>>>> = {
  setback: {
    childhood: [
      "你花了一整個下午做的紙黏土作品，一個不小心掉在地上摔裂了",
      "在公園練習騎腳踏車時摔了一跤，膝蓋擦破了一塊皮",
      "畫到一半的美術作業被水杯打翻，整張紙都糊掉了",
      "你最喜歡的布偶洗過之後整個變形，只能捨不得地收進櫃子"
    ],
    adolescence: [
      "段考成績比預期低了十幾分，回家路上一直不敢打開成績單",
      "準備很久的報告上台前，電腦突然更新到一半卡住",
      "報名校際比賽時填錯組別，最後只拿到參加獎",
      "和要好的同學為了一件小事冷戰了兩個星期"
    ],
    adulthood: [
      "熬夜準備的資料在簡報前一刻發現版本放錯，只能臨時重講",
      "出門時公車剛好開走，等下一班讓你遲到了半小時",
      "排了很久的隊，輪到你的時候名額剛好用完",
      "連續忙了兩週之後，身體第一次發出明顯的抗議"
    ],
    later_life: [
      "期待很久的聚會因為颱風取消，你只能把準備好的東西收回冰箱",
      "膝蓋的舊傷在天氣轉涼時隱隱作痛，散步的時間縮短了一半",
      "原本報名的書法班因為人數不足沒開成",
      "整理舊照片時發現一疊底片已經發霉，沒辦法再沖洗"
    ]
  },
  "small-win": {
    childhood: [
      "你第一次自己把鞋帶綁好，開心地跑去給每個人看",
      "老師把你畫的圖貼在教室後面，同學都跑過來看",
      "你終於敢從游泳池的深水區游到對岸",
      "你學會了用注音拼出自己的名字，還教會了隔壁的同學"
    ],
    adolescence: [
      "成果發表上，你負責的那一段拿到全場最熱烈的掌聲",
      "你熬夜整理的筆記被同學借去印了一整班",
      "園遊會時你們攤位的東西不到中午就賣光",
      "你投的校刊稿子被登出來，還被老師在課堂上唸了一段"
    ],
    adulthood: [
      "你花了幾個月調整的做法終於推行成功，出錯率明顯下降",
      "第一次自己完成一份完整的規劃書，被對方稱讚做得很仔細",
      "你把困擾很久的漏水問題自己修好了",
      "卡了兩個月的問題被你找到原因，終於順利解決"
    ],
    later_life: [
      "你寫的春聯被鄰居要了好幾張，還有人預約明年再寫",
      "社區的書法班請你去當小老師，第一次上課就來了十幾個人",
      "你把陽台整理成一個小花園，路過的人都停下來看",
      "你示範了一次騎腳踏車，旁邊的小朋友看得目不轉睛"
    ]
  }
};

/** detail 文案的顯示層 key（application 端用的是同一個格式）。 */
function detailCopyId(kind: "setback" | "small-win", stage: string, index: number): string {
  return `p3b.detail.${kind}.${stage}.${index + 1}`;
}

/** 事件 id／localizationKey 的固定推導（generator 與內容映射檔共用）。 */
function choiceIds(spec: ChoiceSpec): {
  readonly eventId: string;
  readonly decisionId: string;
  readonly localizationKey: string;
  readonly promptKey: string;
  readonly optionKeys: readonly string[];
} {
  const base = `${spec.group}.${spec.slug}`;
  return {
    eventId: `ev.${base}`,
    decisionId: `dec.${base}`,
    localizationKey: `p3b.event.${spec.group}.${spec.slug.replaceAll("-", "_")}`,
    promptKey: `p3b.decision.${base}`,
    optionKeys: spec.options.map((option) => `p3b.option.${base}.${option.id}`)
  };
}

function buildChoiceEvents(): P3BEventRecord[] {
  const sourceId = sourceIdOf("p3b-synthetic-events-v1");
  const event = makeEventFactory(sourceId);
  return CHOICE_EVENTS.map((spec) => {
    const ids = choiceIds(spec);
    return event({
      eventId: ids.eventId,
      kind: "decision",
      localizationKey: ids.localizationKey,
      ageMin: spec.ageMin,
      ageMax: spec.ageMax,
      lifeStages: spec.stages,
      weight: spec.weight,
      priority: spec.priority ?? 0,
      once: spec.once ?? false,
      cooldownYears: spec.cooldownYears,
      exclusiveGroup: spec.exclusiveGroup ?? null,
      conditions: spec.conditions ?? null,
      contentMode: "guardian",
      effects: [{ type: "openDecision", decisionId: ids.decisionId }],
      decision: {
        decisionId: ids.decisionId,
        promptKey: ids.promptKey,
        options: spec.options.map((option, index) => ({
          optionId: option.id,
          labelKey: ids.optionKeys[index] as string,
          effects: [...option.effects]
        }))
      }
    });
  });
}

/** 內容映射檔：locale → { key → 可顯示文字 }；key 與 UI 既有的 DISPLAY_TEXT 完全同構。 */
function buildCopyDocument(): {
  readonly schemaVersion: string;
  readonly locale: string;
  readonly contentPackVersion: string;
  readonly note: string;
  readonly eventCount: number;
  readonly decisionCount: number;
  readonly optionCount: number;
  readonly copy: Readonly<Record<string, string>>;
} {
  const copy: Record<string, string> = { ...LEGACY_COPY };
  let optionCount = Object.keys(LEGACY_COPY).filter((key) => key.startsWith("p3b.option.")).length;
  for (const spec of CHOICE_EVENTS) {
    const ids = choiceIds(spec);
    copy[ids.eventId] = spec.title;
    copy[ids.promptKey] = spec.prompt;
    ids.optionKeys.forEach((key, index) => {
      copy[key] = spec.options[index]?.label as string;
      optionCount += 1;
    });
  }
  // GPT-DEEPSEEK-0040-A：泛稱挫折／成功的具體變體（32 條，只放顯示層字典）。
  for (const kind of ["setback", "small-win"] as const) {
    for (const stage of ["childhood", "adolescence", "adulthood", "later_life"] as const) {
      const lines = DETAIL_COPY[kind][stage] as readonly string[];
      lines.forEach((line, index) => {
        copy[detailCopyId(kind, stage, index)] = line;
      });
    }
  }
  // GPT-DEEPSEEK-0054-A：職業目錄的顯示層名稱（24 個）與分類說明。
  for (const entry of P3E_CAREERS) copy[entry.labelKey] = CAREER_NAME_TEXT[entry.id] as string;
  for (const category of P3E_CAREER_CATEGORIES) {
    copy[category.labelKey] = CAREER_CATEGORY_TEXT[category.id]?.label as string;
    copy[category.hintKey] = CAREER_CATEGORY_TEXT[category.id]?.hint as string;
  }
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(copy).sort()) sorted[key] = copy[key] as string;
  return {
    schemaVersion: "p3b-copy-1",
    locale: "zh-Hant",
    contentPackVersion: MAIN_CONTENT_PACK_VERSION,
    note:
      "顯示層文案對照（不是事件包資料、不進 events checksum）。UI 可把它當成 DISPLAY_TEXT 的完整替代：key 是 eventId／promptKey／labelKey。",
    eventCount: CHOICE_EVENTS.length,
    decisionCount: CHOICE_EVENTS.length,
    optionCount,
    copy: sorted
  };
}

interface BuiltPack {
  readonly packId: string;
  readonly manifestFileName: string;
  readonly eventsFileName: string;
  readonly manifest: P3BEventPackManifest;
  readonly events: readonly P3BEventRecord[];
}

function buildPack(
  packId: string,
  manifestFileName: string,
  eventsFileName: string,
  events: readonly P3BEventRecord[],
  contentVersion: string
): BuiltPack {
  const sorted = [...events]
    .sort((left, right) => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0))
    // 每筆事件的 contentPackVersion 必須等於 manifest 的；作者程式只寫 1.0.0，這裡統一蓋章。
    .map((event) => ({ ...event, contentPackVersion: contentVersion }));
  const eventsChecksum = computeEventsChecksum(sorted);
  const sourceId = sourceIdOf(packId);
  const license: P3BLicenseRecord = {
    sourceId,
    datasetId: "events",
    datasetLabel: `${packId} synthetic event pack`,
    sourceKind: "synthetic",
    sourceName: "life-sim synthetic generator",
    sourceUrl: null,
    version: contentVersion,
    retrievedAt: CREATED_AT,
    license: "granted",
    licenseId: "synthetic-generated",
    commercialUse: "allowed",
    legalStatus: "cleared",
    evidence: ["generated by scripts/p3b-generate-fixtures.ts for engineering tests only"],
    grant: null,
    checksum: eventsChecksum,
    lineageId: `lin.${packId}.events`,
    notes: "synthetic skeleton; not production content"
  };
  const lineage: P3BLineageRecord = {
    lineageId: `lin.${packId}.events`,
    datasetId: "events",
    parentLineageIds: [],
    transform: "deterministic synthetic event pack v1 (no external input)",
    generatedBy: "scripts/p3b-generate-fixtures.ts",
    generatedAt: GENERATED_AT,
    inputChecksums: [],
    outputChecksum: eventsChecksum,
    notes: "no upstream dataset; values are authored for engineering tests"
  };
  const manifestWithoutChecksum: P3BEventPackManifest = {
    schemaVersion: P3B_SCHEMA_VERSION,
    eventSpecVersion: P3B_EVENT_SPEC_VERSION,
    contentPackVersion: contentVersion,
    eventPackId: packId,
    packKind: "synthetic",
    createdAt: CREATED_AT,
    engineVersion: P3B_ENGINE_VERSION,
    rngSpecVersion: P3B_RNG_SPEC_VERSION,
    datasets: [{ datasetId: "events", fileName: eventsFileName, recordCount: sorted.length, checksum: eventsChecksum }],
    licenses: [license],
    lineage: [lineage],
    packChecksum: "0".repeat(64)
  };
  const manifest: P3BEventPackManifest = { ...manifestWithoutChecksum, packChecksum: computePackChecksum(manifestWithoutChecksum) };
  // 自我驗證：產生器產出的東西必須通過驗證器。
  validateEventPack({ manifest, events: sorted as P3BEventRecord[] });
  return { packId, manifestFileName, eventsFileName, manifest, events: sorted };
}

function writePack(pack: BuiltPack): void {
  writeFileSync(join(OUT_DIR, pack.manifestFileName), `${JSON.stringify(pack.manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    join(OUT_DIR, pack.eventsFileName),
    `${JSON.stringify(
      {
        schemaVersion: P3B_SCHEMA_VERSION,
        contentPackVersion: pack.manifest.contentPackVersion,
        dataset: "events",
        records: pack.events
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const main = buildPack(
    "p3b-synthetic-events-v1",
    "manifest.v1.json",
    "events.v1.json",
    buildMainEvents(),
    MAIN_CONTENT_PACK_VERSION
  );
  const edge = buildPack(
    "p3b-synthetic-edges-v1",
    "edge-manifest.v1.json",
    "edge-events.v1.json",
    buildEdgeEvents(),
    CONTENT_PACK_VERSION
  );
  writePack(main);
  writePack(edge);

  // 顯示層文案映射檔（不是事件包資料，不進 checksum；UI 整合介面見結果文件）。
  const copyDocument = buildCopyDocument();
  writeFileSync(join(OUT_DIR, "event-copy.zh-Hant.v1.json"), `${JSON.stringify(copyDocument, null, 2)}\n`, "utf8");

  const reloaded = JSON.parse(readFileSync(join(OUT_DIR, "manifest.v1.json"), "utf8")) as P3BEventPackManifest;
  if (reloaded.packChecksum !== main.manifest.packChecksum) throw new Error("manifest roundtrip mismatch");
  const eventsFile = JSON.parse(readFileSync(join(OUT_DIR, "events.v1.json"), "utf8")) as { records: unknown[] };
  if (eventsFile.records.length !== main.events.length) throw new Error("events file mismatch");
  const copyReloaded = JSON.parse(readFileSync(join(OUT_DIR, "event-copy.zh-Hant.v1.json"), "utf8")) as {
    copy: Record<string, string>;
  };
  const decisionCount = main.events.filter((event) => event.kind === "decision").length;
  const optionCount = main.events.reduce((sum, event) => sum + (event.decision?.options.length ?? 0), 0);
  const missingCopy: string[] = [];
  for (const event of main.events) {
    if (copyReloaded.copy[event.eventId] === undefined) missingCopy.push(event.eventId);
    if (event.decision === null) continue;
    if (copyReloaded.copy[event.decision.promptKey] === undefined) missingCopy.push(event.decision.promptKey);
    for (const option of event.decision.options) {
      if (copyReloaded.copy[option.labelKey] === undefined) missingCopy.push(option.labelKey);
    }
  }
  if (missingCopy.length > 0) throw new Error(`copy file missing ${missingCopy.length} keys: ${missingCopy.slice(0, 3).join(", ")}`);
  console.log(
    `P3B-FIXTURES-OK main=${main.events.length} decisions=${decisionCount} options=${optionCount} ` +
      `edge=${edge.events.length} copyKeys=${Object.keys(copyReloaded.copy).length} ` +
      `mainChecksum=${main.manifest.packChecksum.slice(0, 12)}… edgeChecksum=${edge.manifest.packChecksum.slice(0, 12)}…`
  );
}

main();
