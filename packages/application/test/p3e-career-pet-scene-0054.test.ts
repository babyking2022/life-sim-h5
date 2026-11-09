import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPeerGroup,
  createBirthCertificate,
  validateDataPack,
  validateDeathPack,
  validateIdentityPack
} from "@life-sim/birth";
import { validateEventPack } from "@life-sim/engine";
import {
  P3E_CAREERS,
  P3E_CAREER_CATEGORIES,
  isP3ECareerEligible,
  readP3ECareerId
} from "@life-sim/contracts";
import {
  createP3EPlaySession,
  exportP3EPlaySessionPayload,
  restoreP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";
import { petKindOf, sceneAgeStageOf, sceneLifeStageOf } from "../src/p3e-profile";

/**
 * GPT-DEEPSEEK-0054-A｜核心玩法驗收：
 *
 * 1. 兩階段職業選擇（分類 → 職業）、資格限制、收入差異、轉職、舊存檔相容；
 * 2. 寵物（狗／貓／無）save/load/replay 一致；
 * 3. `view.scene` 投影矩陣（性別 × 5 年齡階段 × 城鄉 × 有無伴侶 × 寵物）。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const base = validateDataPack({
  manifest: readJson("fixtures/p2a/manifest.v1.json"),
  datasets: {
    "country-registry": readJson("fixtures/p2a/country-registry.v1.json"),
    indicators: readJson("fixtures/p2a/indicators.v1.json"),
    "birth-weights": readJson("fixtures/p2a/birth-weights.v1.json"),
    "sensitive-names": readJson("fixtures/p2a/sensitive-names.v1.json"),
    licenses: readJson("fixtures/p2a/licenses.v1.json"),
    lineage: readJson("fixtures/p2a/lineage.v1.json")
  }
} as never);

const identityPack = validateIdentityPack(base, {
  manifest: readJson("fixtures/p2b/manifest.v1.json"),
  datasets: {
    "country-vitals": readJson("fixtures/p2b/country-vitals.v1.json"),
    "household-profiles": readJson("fixtures/p2b/household-profiles.v1.json"),
    "name-corpus": readJson("fixtures/p2b/name-corpus.v1.json"),
    "story-templates": readJson("fixtures/p2b/story-templates.v1.json"),
    licenses: readJson("fixtures/p2b/licenses.v1.json"),
    lineage: readJson("fixtures/p2b/lineage.v1.json")
  }
} as never);

const eventPack = validateEventPack({
  manifest: readJson("fixtures/p3b/manifest.v1.json"),
  events: (readJson("fixtures/p3b/events.v1.json") as { records: unknown[] }).records
} as never);

const deathPack = validateDeathPack(
  {
    manifest: readJson("fixtures/p3d/manifest.v1.json"),
    datasets: {
      "cause-registry": readJson("fixtures/p3d/cause-registry.v1.json"),
      "cause-weights": readJson("fixtures/p3d/cause-weights.v1.json"),
      mortality: readJson("fixtures/p3d/mortality.v1.json"),
      licenses: readJson("fixtures/p3d/licenses.v1.json"),
      lineage: readJson("fixtures/p3d/lineage.v1.json")
    }
  } as never,
  base
);

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

function sessionFor(seed: string): P3EPlaySession {
  const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
  const certificate = createBirthCertificate(base, identityPack, group, seed);
  return createP3EPlaySession({ masterSeed: seed, basePack: base, identityPack, certificate, eventPack, deathPack });
}

function restore(session: P3EPlaySession, seed: string): P3EPlaySession {
  const payload = exportP3EPlaySessionPayload({ session });
  const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
  return restoreP3EPlaySessionPayload({
    payload,
    masterSeed: seed,
    basePack: base,
    identityPack,
    certificate: createBirthCertificate(base, identityPack, group, seed),
    eventPack,
    deathPack
  });
}

function decide(session: P3EPlaySession, optionId: string): P3EPlaySession {
  return runP3EPlaySessionCommand({ session, command: { type: "CHOOSE_DECISION", optionId } }).session;
}

/**
 * 等到某個職業分類的 tier 決策（entry 或 degree 哪個符合資格就哪個）。
 * 回傳 pending 的 session；呼叫端再從 decisionId 判斷 tier。
 */
function untilCareerTier(session: P3EPlaySession, category: string, maxAge = 55): P3EPlaySession {
  let current = session;
  for (let step = 0; step < 400; step += 1) {
    if (current.state.phase === "death") throw new Error(`died before career tier (age ${current.state.age})`);
    if (current.state.age > maxAge) throw new Error(`never reached career tier (age ${current.state.age})`);
    if (current.state.phase === "pending_decision") {
      const pending = current.state.pendingDecision;
      const decisionId = pending?.decisionId ?? "";
      if (decisionId === `dec.adult.career-${category}-entry` || decisionId === `dec.adult.career-${category}-degree`) {
        return current;
      }
      current = decide(current, pending?.optionIds[0] as string);
      continue;
    }
    current = runP3EPlaySessionCommand({ session: current, command: { ...ADVANCE } }).session;
  }
  throw new Error("never reached career tier");
}

/** 逐年推進到出現指定的決策（回傳該 pending 的 session）；超過 maxAge 就失敗。 */
function untilDecision(session: P3EPlaySession, decisionId: string, maxAge = 60, onOther?: string): P3EPlaySession {
  let current = session;
  for (let step = 0; step < 400; step += 1) {
    if (current.state.phase === "death") throw new Error(`died before ${decisionId} (age ${current.state.age})`);
    if (current.state.age > maxAge) throw new Error(`never reached ${decisionId} (age ${current.state.age})`);
    if (current.state.phase === "pending_decision") {
      const pending = current.state.pendingDecision;
      if (pending?.decisionId === decisionId) return current;
      const optionId = onOther ?? (pending?.optionIds[0] as string);
      current = decide(current, optionId);
      continue;
    }
    current = runP3EPlaySessionCommand({ session: current, command: { ...ADVANCE } }).session;
  }
  throw new Error(`never reached ${decisionId}`);
}

describe("GPT-0054-A 任務一：職業目錄", () => {
  it("至少 24 個職業、6 個分類、每個職業都有 id／labelKey／門檻／年收入", () => {
    expect(P3E_CAREERS.length).toBeGreaterThanOrEqual(24);
    expect(P3E_CAREER_CATEGORIES.map((entry) => entry.id).sort()).toEqual(
      ["care", "independent", "office", "service", "tech", "trade"].sort()
    );
    for (const entry of P3E_CAREERS) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.labelKey).toBe(`p3b.career.${entry.id}`);
      expect([0, 1, 2]).toContain(entry.minEducation);
      expect(entry.minKnowledge).toBeGreaterThanOrEqual(0);
      expect(entry.baseAnnualIncomeMicroUsd).toBeGreaterThan(0n);
      expect(["entry", "degree"]).toContain(entry.tier);
      expect(["employed", "self_employed"]).toContain(entry.employmentKind);
    }
    // 需求列出的可見職業都在目錄裡。
    for (const id of [
      "engineer",
      "software_engineer",
      "teacher",
      "nurse",
      "accountant",
      "clerk",
      "cook",
      "factory_worker",
      "construction_worker",
      "driver",
      "salesperson",
      "designer",
      "freelancer",
      "entrepreneur"
    ]) {
      expect(P3E_CAREERS.some((entry) => entry.id === id), id).toBe(true);
    }
  });

  it("每個分類的每個 tier 都有 2–8 個職業（決策選項數量合法）", () => {
    for (const category of P3E_CAREER_CATEGORIES) {
      for (const tier of ["entry", "degree"] as const) {
        const list = P3E_CAREERS.filter((entry) => entry.category === category.id && entry.tier === tier);
        expect(list.length, `${category.id}/${tier}`).toBeGreaterThanOrEqual(2);
        expect(list.length, `${category.id}/${tier}`).toBeLessThanOrEqual(8);
      }
    }
  });

  it("資格判斷：學歷與知識都要達標", () => {
    const physician = P3E_CAREERS.find((entry) => entry.id === "physician")!;
    expect(isP3ECareerEligible(physician, [], 99)).toBe(false);
    expect(isP3ECareerEligible(physician, ["edu:university"], 99)).toBe(false);
    expect(isP3ECareerEligible(physician, ["edu:master"], 60)).toBe(true);
    expect(isP3ECareerEligible(physician, ["edu:master"], 10)).toBe(false);

    const waiter = P3E_CAREERS.find((entry) => entry.id === "waiter")!;
    expect(isP3ECareerEligible(waiter, [], 0)).toBe(true);
  });
});

describe("GPT-0054-A 任務一：兩階段選擇、資格與收入", () => {
  it("第一次進入社會會出現『選分類 → 選職業』兩階段，且選完寫入 job 旗標", () => {
    const seed = "gpt-0054-career-two-stage";
    let session = sessionFor(seed);
    session = untilDecision(session, "dec.adult.career-field");
    expect(session.state.pendingDecision?.optionIds).toEqual([
      "field-service",
      "field-trade",
      "field-office",
      "field-care",
      "field-tech",
      "field-independent"
    ]);
    session = decide(session, "field-tech");
    expect(session.state.flags).toContain("career:field:tech");

    session = untilCareerTier(session, "tech");
    const tierDecisionId = session.state.pendingDecision?.decisionId as string;
    const isEntryTier = tierDecisionId.endsWith("-entry");
    const options = session.state.pendingDecision?.optionIds ?? [];
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(8);
    // 選項必須全部符合該 tier 的學歷門檻（entry＝不需要大學；degree＝需要大學以上）
    for (const optionId of options) {
      const entry = P3E_CAREERS.find((career) => career.id === optionId)!;
      if (isEntryTier) expect(entry.minEducation, optionId).toBe(0);
      else expect(entry.minEducation, optionId).toBeGreaterThanOrEqual(1);
    }
    session = decide(session, options[0] as string);

    expect(session.state.flags).toContain("career:chosen");
    expect(readP3ECareerId(session.state.flags)).toBe(options[0]);
    expect(session.view.profile.currentRole.id).toBe(options[0]);
    expect(session.view.profile.currentRole.kind).toBe("employed");
  });

  it("不符合學歷的職業不會出現在選項裡（模擬層擋掉，不是 UI 隱藏）", () => {
    const seed = "gpt-0054-career-eligibility";
    let session = sessionFor(seed);
    session = untilDecision(session, "dec.adult.career-field");
    session = decide(session, "field-care");
    session = untilCareerTier(session, "care");
    const tierDecisionId = session.state.pendingDecision?.decisionId as string;
    const entryOptions = session.state.pendingDecision?.optionIds ?? [];
    if (tierDecisionId.endsWith("-entry")) {
      // 沒有大學學歷時，醫師／護理／教師（degree tier）不可選
      for (const forbidden of ["physician", "nurse", "teacher"]) {
        expect(entryOptions).not.toContain(forbidden);
      }
    } else {
      // 有大學學歷時，entry tier 的照護職業不會出現在 degree 決策裡
      for (const forbidden of ["care_worker", "care_assistant"]) {
        expect(entryOptions).not.toContain(forbidden);
      }
      for (const optionId of entryOptions) {
        const entry = P3E_CAREERS.find((career) => career.id === optionId)!;
        expect(entry.minEducation).toBeGreaterThanOrEqual(1);
      }
    }
    expect(entryOptions.length).toBeGreaterThanOrEqual(2);
  });

  it("不同職業的年收入效果不同（income modifier 進 canonical state）", () => {
    const play = (optionId: string): P3EPlaySession => {
      const seed = `gpt-0054-income-${optionId}`;
      let session = sessionFor(seed);
      session = untilDecision(session, "dec.adult.career-field");
      session = decide(session, "field-service");
      session = untilCareerTier(session, "service");
      const options = session.state.pendingDecision?.optionIds ?? [];
      // 這個 seed 的學歷 tier 可能沒有指定職業：那就用同 tier 的第一個職業，
      // 仍然能驗證「選了職業 → income modifier 進 state」。
      const target = options.includes(optionId) ? optionId : (options[0] as string);
      return decide(session, target);
    };
    const incomeOf = (session: P3EPlaySession): bigint => {
      const flag = session.state.flags.find((entry) => entry.startsWith("income:mod:"));
      return BigInt((flag as string).split(":").slice(-1)[0] as string);
    };
    const first = play("waiter");
    const second = play("cook");
    expect(readP3ECareerId(first.state.flags)).not.toBeNull();
    expect(readP3ECareerId(second.state.flags)).not.toBeNull();
    expect(incomeOf(first)).toBeGreaterThan(0n);
    expect(incomeOf(second)).toBeGreaterThan(0n);
    // 兩個職業的基礎年收入不同 → income modifier 不同（waiter 6,000 vs cook 9,000 USD）。
    expect(incomeOf(first) === incomeOf(second)).toBe(false);
  });

  it("之後的轉職／退休仍可運作（currentRole 會跟著變）", () => {
    const seed = "gpt-0054-career-later";
    let session = sessionFor(seed);
    session = untilDecision(session, "dec.adult.career-field");
    session = decide(session, "field-office");
    session = untilCareerTier(session, "office");
    const firstJob = session.state.pendingDecision?.optionIds[0] as string;
    session = decide(session, firstJob);
    expect(session.view.profile.currentRole.id).toBe(firstJob);

    // 一路推進到退休年齡：role 最終必須是 retired 或仍是合法職業。
    for (let step = 0; step < 400 && session.state.age < 70 && session.state.phase !== "death"; step += 1) {
      if (session.state.phase === "pending_decision") {
        session = decide(session, session.state.pendingDecision?.optionIds[0] as string);
        continue;
      }
      session = runP3EPlaySessionCommand({ session, command: { ...ADVANCE } }).session;
    }
    if (session.state.phase !== "death") {
      expect(["retired", firstJob]).toContain(session.view.profile.currentRole.id);
    }
  });

  it("舊存檔（沒有職業旗標）仍可載入，role 用既有規則恢復", () => {
    const seed = "gpt-0054-old-save";
    const session = sessionFor(seed);
    expect(session.view.profile.currentRole.id).toBe("infant");
    const restored = restore(session, seed);
    expect(restored.view.profile.currentRole.id).toBe("infant");
    expect(restored.view.scene).toEqual(session.view.scene);
  });
});

describe("GPT-0054-A 任務二：寵物", () => {
  // 正式 session 長時整合測試，沿用 p3e-life-focus.test.ts 的 timeout 慣例。
  it("狗／貓／不養三個選項都存在，且旗標與場景一致", { timeout: 120_000 }, () => {
    for (const [optionId, expected] of [
      ["dog", "dog"],
      ["cat", "cat"],
      ["none", "none"]
    ] as const) {
      const seed = `gpt-0054-pet-${optionId}`;
      let session = sessionFor(seed);
      session = untilDecision(session, "dec.adult.first-pet", 60);
      expect(session.state.pendingDecision?.optionIds).toEqual(["dog", "cat", "none"]);
      session = decide(session, optionId as string);
      expect(session.view.scene.petKind).toBe(expected);
      if (expected !== "none") expect(session.state.flags).toContain(`pet:${expected}`);
      expect(petKindOf(session.state.flags)).toBe(expected);

      // save → load → replay 一致
      const restored = restore(session, seed);
      expect(restored.view.scene).toEqual(session.view.scene);
      expect(restored.state.stateHash).toBe(session.state.stateHash);
      expect([...restored.state.flags]).toEqual([...session.state.flags]);
    }
  });

  it("同 seed 同選擇 -> 完全相同的寵物狀態（決定性）", () => {
    const play = (): P3EPlaySession => {
      let session = sessionFor("gpt-0054-pet-deterministic");
      session = untilDecision(session, "dec.adult.first-pet", 60);
      return decide(session, "cat");
    };
    const first = play();
    const second = play();
    expect(second.state.stateHash).toBe(first.state.stateHash);
    expect(second.view.scene.petKind).toBe("cat");
  });
});

describe("GPT-0054-A 任務三／GPT-0063-B：scene 投影", () => {
  it("年齡階段邊界：0–2 baby、3–5 child、6–22 student、23–39 young、40–59 middle、60+ senior", () => {
    for (const [age, stage] of [
      [0, "baby"],
      [2, "baby"],
      [3, "child"],
      [5, "child"],
      [6, "student"],
      [18, "student"],
      [22, "student"],
      [23, "young"],
      [39, "young"],
      [40, "middle"],
      [59, "middle"],
      [60, "senior"],
      [99, "senior"]
    ] as const) {
      expect(sceneAgeStageOf(age)).toBe(stage);
    }
  });

  it("0063-B lifeStage 精確分段：baby／child／primary／teen／university／young／middle／senior", () => {
    for (const [age, stage] of [
      [0, "baby"], [2, "baby"],
      [3, "child"], [5, "child"],
      [6, "primary"], [11, "primary"],
      [12, "teen"], [17, "teen"],
      [18, "university"], [22, "university"],
      [25, "young"], [39, "young"],
      [45, "middle"], [59, "middle"],
      [65, "senior"], [99, "senior"]
    ] as const) {
      expect(sceneLifeStageOf(age)).toBe(stage);
      expect(sceneAgeStageOf(age)).toBe(
        stage === "primary" || stage === "teen" || stage === "university" ? "student" : stage
      );
    }
  });

  it("完整投影：性別 × 年齡階段 × 城鄉 × 有無伴侶 × 寵物，且與 view 其他欄位一致", { timeout: 120_000 }, () => {
    const matrix = new Set<string>();
    for (let index = 0; index < 6; index += 1) {
      const seed = `gpt-0054-scene-${index}`;
      let session = sessionFor(seed);
      for (let step = 0; step < 400 && session.state.age < 70 && session.state.phase !== "death"; step += 1) {
        if (session.state.phase === "pending_decision") {
          session = decide(session, session.state.pendingDecision?.optionIds[0] as string);
          continue;
        }
        session = runP3EPlaySessionCommand({ session, command: { ...ADVANCE } }).session;
        const scene = session.view.scene;
        expect(["male", "female"]).toContain(scene.playerSex);
        expect(scene.playerSex).toBe(session.state.identity.sex);
        expect(scene.age).toBe(session.state.age);
        expect(["baby", "child", "student", "young", "middle", "senior"]).toContain(scene.ageStage);
        expect(scene.ageStage).toBe(sceneAgeStageOf(session.state.age));
        expect(scene.lifeStage).toBe(sceneLifeStageOf(session.state.age));
        expect(["urban", "rural"]).toContain(scene.residenceKind);
        expect(typeof scene.hasPartner).toBe("boolean");
        expect(["none", "dog", "cat"]).toContain(scene.petKind);
        expect(["alive", "dead"]).toContain(scene.phase);
        if (scene.hasPartner) {
          expect(["male", "female", null]).toContain(scene.partnerSex);
          expect(typeof scene.partnerAge).toBe("number");
          // 未成年玩家旁邊不能出現成年伴侶。
          if (session.state.age < 18) expect(scene.partnerAge as number).toBeLessThan(18);
          expect(["dating", "married"]).toContain(session.view.profile.relationship.status);
        } else {
          expect(scene.partnerSex).toBeNull();
          expect(scene.partnerAge).toBeNull();
        }
        matrix.add(`${scene.playerSex}|${scene.ageStage}|${scene.residenceKind}|${scene.hasPartner}|${scene.petKind}`);
      }
    }
    // 至少涵蓋多種性別 × 年齡階段組合（不是永遠同一格）。
    expect(matrix.size).toBeGreaterThan(8);
  });

  it("死亡後投影仍然穩定（phase=dead、age 不再變）", { timeout: 120_000 }, () => {
    const seed = "gpt-0054-scene-death";
    let session = sessionFor(seed);
    for (let step = 0; step < 500 && session.state.phase !== "death"; step += 1) {
      if (session.state.phase === "pending_decision") {
        session = decide(session, session.state.pendingDecision?.optionIds[0] as string);
        continue;
      }
      session = runP3EPlaySessionCommand({ session, command: { ...ADVANCE } }).session;
    }
    expect(session.state.phase).toBe("death");
    expect(session.view.scene.phase).toBe("dead");
    const frozen = JSON.stringify(session.view.scene);
    const restored = restore(session, seed);
    expect(restored.state.phase).toBe("death");
    expect(JSON.stringify(restored.view.scene)).toBe(frozen);
  });
});
