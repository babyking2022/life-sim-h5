import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDataPack, validateIdentityPack } from "@life-sim/birth";
import {
  deriveP3ECurrentRole,
  deriveP3EProfile,
  P3E_RELATIONSHIP_STATUSES,
  resolveP3ERelationship,
  relationshipSnapshot,
  type P3EProfileFact
} from "../src/p3e-profile";
import { detailIdFor, isP3EDetailId, lifeStageOfAge, P3E_DETAIL_IDS, P3E_DETAIL_VARIANTS_PER_STAGE } from "../src/p3e-detail";

/**
 * GPT-DEEPSEEK-0040-A｜`view.profile`（角色／居住／感情）＋ 具體事件 detailId 測試。
 *
 * 角色與感情的推導是純函式：這裡用「最小的 state stub ＋ 真實 facts」測規則，
 * 再用正式 session 驗證整合（欄位公開、detailId 出現在 lifeLog、可重播）。
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

const copyDocument = readJson("fixtures/p3b/event-copy.zh-Hant.v1.json") as { copy: Record<string, string> };

/** 最小 state stub：角色推導只讀 age／currentYear／flags／stats.knowledge／identity。 */
function stateStub(age: number, options: { flags?: readonly string[]; knowledge?: number; year?: number } = {}) {
  return {
    age,
    currentYear: options.year ?? 2024 + age,
    flags: options.flags ?? [],
    stats: { health: 60, happiness: 55, knowledge: options.knowledge ?? 50, relationships: 40 },
    identity: { entityId: "cr:TWN", regionCode: "TWN", sex: "female" }
  } as never;
}

function fact(input: Partial<P3EProfileFact> & { kind: P3EProfileFact["kind"]; year: number; age: number }): P3EProfileFact {
  return {
    kind: input.kind,
    eventId: input.eventId ?? null,
    decisionId: input.decisionId ?? null,
    optionId: input.optionId ?? null,
    year: input.year,
    age: input.age
  };
}

const PROFESSIONAL = ["teacher", "engineer", "software_engineer", "accountant", "doctor", "researcher"];

describe("GPT-0040-A currentRole：年齡基線", () => {
  it("0–17 歲依年齡給出 infant／preschool／primary／junior／senior", () => {
    const cases: readonly [number, string, string][] = [
      [1, "infant", "life_stage"],
      [4, "preschool_child", "life_stage"],
      [8, "primary_student", "student"],
      [13, "junior_high_student", "student"],
      [16, "senior_high_student", "student"],
      [17, "senior_high_student", "student"]
    ];
    for (const [age, id, kind] of cases) {
      const role = deriveP3ECurrentRole({ state: stateStub(age), facts: [], masterSeed: "seed" });
      expect(role.id, `age ${age}`).toBe(id);
      expect(role.kind, `age ${age}`).toBe(kind);
      expect(Number.isSafeInteger(role.sinceYear)).toBe(true);
      expect(Object.isFrozen(role)).toBe(true);
    }
  });

  it("sinceYear 是這個階段開始的年份（8 歲 → 6 歲那年）", () => {
    const role = deriveP3ECurrentRole({ state: stateStub(8, { year: 2032 }), facts: [], masterSeed: "seed" });
    expect(role.sinceYear).toBe(2030);
  });

  it("65+ 沒有繼續工作 → retired；working:senior 且 <= 71 仍就業", () => {
    const retired = deriveP3ECurrentRole({ state: stateStub(66), facts: [], masterSeed: "seed" });
    expect(retired.id).toBe("retired");
    expect(retired.kind).toBe("retired");
    const working = deriveP3ECurrentRole({ state: stateStub(66, { flags: ["working:senior"] }), facts: [], masterSeed: "seed" });
    expect(working.id).not.toBe("retired");
    expect(["employed", "self_employed"]).toContain(working.kind);
  });
});

describe("GPT-0040-A currentRole：教育與職業", () => {
  const universityFact = fact({
    kind: "decision",
    eventId: "ev.adult.after-school",
    decisionId: "dec.adult.after-school",
    optionId: "university",
    year: 2044,
    age: 20
  });
  const corpFact = fact({
    kind: "decision",
    eventId: "ev.adult.first-job",
    decisionId: "dec.adult.first-job",
    optionId: "corp",
    year: 2048,
    age: 24
  });

  it("大學 4 年內是 university_student，之後回到職業", () => {
    const during = deriveP3ECurrentRole({
      state: stateStub(21, { year: 2045, flags: ["edu:university"] }),
      facts: [universityFact],
      masterSeed: "seed"
    });
    expect(during.id).toBe("university_student");
    expect(during.kind).toBe("student");
    expect(during.sinceYear).toBe(2044);

    const after = deriveP3ECurrentRole({
      state: stateStub(25, { year: 2049, flags: ["edu:university"] }),
      facts: [universityFact, corpFact],
      masterSeed: "seed"
    });
    expect(after.kind === "employed" || after.kind === "self_employed").toBe(true);
  });

  it("碩士 2 年、博士 4 年，期限結束後回到職業", () => {
    const master = fact({
      kind: "decision",
      eventId: "ev.adult.further-study",
      decisionId: "dec.adult.further-study",
      optionId: "master",
      year: 2052,
      age: 28
    });
    const doctorate = fact({
      kind: "decision",
      eventId: "ev.adult.further-study",
      decisionId: "dec.adult.further-study",
      optionId: "doctorate",
      year: 2052,
      age: 28
    });
    expect(deriveP3ECurrentRole({ state: stateStub(28, { year: 2052, flags: ["edu:master"] }), facts: [master], masterSeed: "s" }).id).toBe(
      "master_student"
    );
    expect(deriveP3ECurrentRole({ state: stateStub(31, { year: 2055, flags: ["edu:master"] }), facts: [master], masterSeed: "s" }).id).not.toBe(
      "master_student"
    );
    expect(
      deriveP3ECurrentRole({ state: stateStub(30, { year: 2054, flags: ["edu:doctorate"] }), facts: [doctorate], masterSeed: "s" }).id
    ).toBe("doctoral_student");
    expect(
      deriveP3ECurrentRole({ state: stateStub(34, { year: 2058, flags: ["edu:doctorate"] }), facts: [doctorate], masterSeed: "s" }).id
    ).not.toBe("doctoral_student");
  });

  it("first-job corp 從 corp 池挑；startup 標成 self_employed；family 從 family 池挑", () => {
    const corpPool = ["teacher", "engineer", "accountant", "office_worker", "salesperson", "marketer", "software_engineer", "designer"];
    const startupPool = ["entrepreneur", "software_engineer", "designer", "marketer"];
    const familyPool = ["shopkeeper", "cook", "farmer", "service_worker"];

    const corp = deriveP3ECurrentRole({
      state: stateStub(30, { year: 2054, flags: ["job:corp"] }),
      facts: [corpFact],
      masterSeed: "seed-a"
    });
    expect(corpPool).toContain(corp.id);
    expect(corp.kind).toBe("employed");

    const startup = deriveP3ECurrentRole({
      state: stateStub(30, { flags: ["job:startup"] }),
      facts: [fact({ kind: "decision", eventId: "ev.adult.first-job", decisionId: "dec.adult.first-job", optionId: "startup", year: 2050, age: 26 })],
      masterSeed: "seed-b"
    });
    expect(startupPool).toContain(startup.id);
    expect(startup.kind).toBe("self_employed");

    const family = deriveP3ECurrentRole({
      state: stateStub(30, { flags: ["job:family"] }),
      facts: [fact({ kind: "decision", eventId: "ev.adult.first-job", decisionId: "dec.adult.first-job", optionId: "family", year: 2050, age: 26 })],
      masterSeed: "seed-c"
    });
    expect(familyPool).toContain(family.id);
  });

  it("教育／知識不足時不會變成專業職業（teacher／engineer…）", () => {
    for (const seed of ["s1", "s2", "s3", "s4", "s5"]) {
      const role = deriveP3ECurrentRole({
        state: stateStub(24, { flags: ["job:corp"], knowledge: 10 }),
        facts: [corpFact],
        masterSeed: seed
      });
      expect(PROFESSIONAL, `${seed} → ${role.id}`).not.toContain(role.id);
      expect(role.id).not.toBe("general_worker"); // 有 job choice 時仍給具體職業（只是非專業）
    }
  });

  it("沒有任何 job choice 但推定就業 → general_worker（不假裝專業）", () => {
    const role = deriveP3ECurrentRole({ state: stateStub(40), facts: [], masterSeed: "seed" });
    expect(role.id).toBe("general_worker");
    expect(role.kind).toBe("employed");
  });

  it("18–22 沒有任何選擇 → gap_year；最後一次轉職會換職業", () => {
    expect(deriveP3ECurrentRole({ state: stateStub(20), facts: [], masterSeed: "s" }).id).toBe("gap_year");

    const before = deriveP3ECurrentRole({
      state: stateStub(55, { flags: ["job:corp"] }),
      facts: [corpFact],
      masterSeed: "seed"
    });
    const after = deriveP3ECurrentRole({
      state: stateStub(55, { flags: ["job:corp"] }),
      facts: [corpFact, fact({ kind: "decision", eventId: "ev.adult.career-pivot", decisionId: "dec.adult.career-pivot", optionId: "change", year: 2055, age: 55 })],
      masterSeed: "seed"
    });
    expect(after.sinceYear).toBe(2055);
    expect(["teacher", "engineer", "accountant", "office_worker", "salesperson", "marketer", "software_engineer", "designer"]).toContain(after.id);
    expect(before.sinceYear).toBe(2048);
  });

  it("同輸入同輸出（職業抽取是決定性的）", () => {
    const first = deriveP3ECurrentRole({ state: stateStub(30, { flags: ["job:corp"] }), facts: [corpFact], masterSeed: "same" });
    const second = deriveP3ECurrentRole({ state: stateStub(30, { flags: ["job:corp"] }), facts: [corpFact], masterSeed: "same" });
    expect(first).toEqual(second);
  });
});

describe("GPT-0040-A relationship：完整情感狀態", () => {
  const context = {
    masterSeed: "gpt-0040-relationship",
    identityPack,
    cultureId: "han",
    playerSex: "female"
  };
  const dateFact = fact({
    kind: "decision",
    eventId: "ev.teen.first-love",
    decisionId: "dec.teen.first-love",
    optionId: "date",
    year: 2040,
    age: 16
  });
  const cohabitFact = fact({
    kind: "decision",
    eventId: "ev.adult.relationship",
    decisionId: "dec.adult.relationship",
    optionId: "cohabit",
    year: 2048,
    age: 24
  });
  const marryFact = fact({
    kind: "decision",
    eventId: "ev.adult.relationship",
    decisionId: "dec.adult.relationship",
    optionId: "marry",
    year: 2050,
    age: 26
  });
  const singleFact = fact({
    kind: "decision",
    eventId: "ev.adult.relationship",
    decisionId: "dec.adult.relationship",
    optionId: "single",
    year: 2052,
    age: 28
  });

  it("沒有關係 → single；date → dating（有姓名）", () => {
    expect(relationshipSnapshot(resolveP3ERelationship({ ...context, facts: [] })).status).toBe("single");
    const dating = relationshipSnapshot(resolveP3ERelationship({ ...context, facts: [dateFact] }));
    expect(dating.status).toBe("dating");
    expect(typeof dating.personName).toBe("string");
    expect((dating.personName as string).length).toBeGreaterThan(0);
    expect(dating.sinceYear).toBe(2040);
  });

  it("cohabit 仍是 dating；marry → married 且保留姓名", () => {
    const cohabit = relationshipSnapshot(resolveP3ERelationship({ ...context, facts: [dateFact, cohabitFact] }));
    expect(cohabit.status).toBe("dating");
    const married = relationshipSnapshot(resolveP3ERelationship({ ...context, facts: [dateFact, cohabitFact, marryFact] }));
    expect(married.status).toBe("married");
    expect(married.personName).toBe(cohabit.personName);
  });

  it("single 一律是回到單身（GPT-0043-A：已婚者不會抽到一般關係事件，離婚只走 marital-breakup）", () => {
    // 一般關係事件在 fixture 有 `not married` 條件，因此「已婚後選 single」在正式流程不會發生；
    // 若 facts 真的出現，也只代表回到單身（不會產生 divorced）。
    const afterSingle = relationshipSnapshot(resolveP3ERelationship({ ...context, facts: [dateFact, singleFact] }));
    expect(afterSingle.status).toBe("single");
    expect(afterSingle.personName).toBeNull();

    const fromMarried = relationshipSnapshot(resolveP3ERelationship({ ...context, facts: [dateFact, cohabitFact, marryFact, singleFact] }));
    expect(fromMarried.status).toBe("single");
    expect(fromMarried.personName).toBeNull();
  });

  it("配偶離世（已婚才可能）→ widowed 並保留姓名", () => {
    const lossFact = fact({ kind: "event", eventId: "ev.adult.partner-loss", year: 2054, age: 30 });
    const widowed = relationshipSnapshot(resolveP3ERelationship({ ...context, facts: [dateFact, cohabitFact, marryFact, lossFact] }));
    expect(widowed.status).toBe("widowed");
    expect(typeof widowed.personName).toBe("string");
    expect(widowed.sinceYear).toBe(2054);
    // 沒有結婚就不會被標成 widowed。
    const noMarriage = relationshipSnapshot(resolveP3ERelationship({ ...context, facts: [dateFact, lossFact] }));
    expect(noMarriage.status).toBe("dating");
  });

  it("所有狀態都在契約清單裡，且輸出是凍結物件", () => {
    const snapshot = relationshipSnapshot(resolveP3ERelationship({ ...context, facts: [dateFact] }));
    expect(P3E_RELATIONSHIP_STATUSES).toContain(snapshot.status);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe("GPT-0040-A profile：整合與 residence", () => {
  it("residence 等於出生國家（目前沒有跨國移居事件）", () => {
    const profile = deriveP3EProfile({
      state: stateStub(30, { flags: ["job:corp"] }),
      facts: [],
      masterSeed: "seed",
      identityPack,
      cultureId: "han",
      playerSex: "female"
    });
    expect(profile.residence).toEqual({ entityId: "cr:TWN", regionCode: "TWN" });
    expect(Object.isFrozen(profile.residence)).toBe(true);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(() => JSON.parse(JSON.stringify(profile))).not.toThrow();
  });
});

describe("GPT-0040-A detailId：具體事件變體", () => {
  it("32 個 detailId 都存在於顯示層字典、且文字不重複", () => {
    expect(P3E_DETAIL_IDS).toHaveLength(32);
    expect(new Set(P3E_DETAIL_IDS).size).toBe(32);
    const texts = new Set<string>();
    for (const detailId of P3E_DETAIL_IDS) {
      const text = copyDocument.copy[detailId];
      expect(typeof text, detailId).toBe("string");
      expect((text as string).length).toBeGreaterThan(8);
      texts.add(text as string);
    }
    expect(texts.size).toBe(32);
    for (const detailId of P3E_DETAIL_IDS) expect(isP3EDetailId(detailId)).toBe(true);
  });

  it("每個 life stage 各 4 個 setback／4 個 small-win，且不跨 stage", () => {
    for (const kind of ["setback", "small-win"]) {
      for (const stage of ["childhood", "adolescence", "adulthood", "later_life"] as const) {
        const ids = P3E_DETAIL_IDS.filter((detailId) => detailId.startsWith(`p3b.detail.${kind}.${stage}.`));
        expect(ids, `${kind}/${stage}`).toHaveLength(P3E_DETAIL_VARIANTS_PER_STAGE);
      }
    }
    expect(lifeStageOfAge(8)).toBe("childhood");
    expect(lifeStageOfAge(16)).toBe("adolescence");
    expect(lifeStageOfAge(30)).toBe("adulthood");
    expect(lifeStageOfAge(70)).toBe("later_life");
  });

  it("detailIdFor：同 seed 同年齡決定性、不同 seed 有多樣性、非泛稱事件回 null", () => {
    const input = { masterSeed: "seed", eventId: "ev.any.setback", year: 2030, age: 10 };
    expect(detailIdFor(input)).toBe(detailIdFor(input));
    expect(detailIdFor(input)).toContain("p3b.detail.setback.childhood.");

    const variants = new Set<string>();
    for (let index = 0; index < 24; index += 1) {
      variants.add(detailIdFor({ ...input, masterSeed: `seed-${index}` }) as string);
    }
    expect(variants.size).toBeGreaterThanOrEqual(2);
    expect(detailIdFor({ ...input, eventId: "ev.adult.burnout" })).toBeNull();
  });

  it("detailId 的 stage 一定對應年齡（不會跨 stage）", () => {
    for (const [age, stage] of [
      [5, "childhood"],
      [17, "adolescence"],
      [45, "adulthood"],
      [80, "later_life"]
    ] as const) {
      const detailId = detailIdFor({ masterSeed: "s", eventId: "ev.any.small-win", year: 2050, age }) as string;
      expect(detailId).toContain(`.${stage}.`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 整合：正式 session 的 view.profile 與 detailId                       */
/* ------------------------------------------------------------------ */

describe("GPT-0040-A 整合：session 的 view.profile 與 detailId", () => {
  it("view.profile 公開 role／residence／relationship，且與 view.partner 一致", async () => {
    const { createP3EPlaySession, runP3EPlaySessionCommand } = await import("../src/p3e-session");
    const { buildPeerGroup, createBirthCertificate, validateDeathPack } = await import("@life-sim/birth");
    const { validateEventPack } = await import("@life-sim/engine");

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
    const seed = "p3e-166-playable-runtime-v4";
    const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
    const certificate = createBirthCertificate(base, identityPack, group, seed);
    let session = createP3EPlaySession({ masterSeed: seed, basePack: base, identityPack, certificate, eventPack, deathPack });

    // 出生即有 profile（0 歲 infant）。
    expect(session.view.profile.currentRole.id).toBe("infant");
    expect(session.view.profile.residence).toEqual({
      entityId: session.state.identity.entityId,
      regionCode: session.state.identity.regionCode
    });
    expect(P3E_RELATIONSHIP_STATUSES).toContain(session.view.profile.relationship.status);

    // 逐年推進到成年（遇到決策選第一個選項）。
    for (let step = 0; step < 60 && session.state.age < 30 && session.state.phase !== "death"; step += 1) {
      const command =
        session.state.phase === "pending_decision"
          ? { type: "CHOOSE_DECISION", optionId: session.state.pendingDecision?.optionIds[0] as string }
          : { type: "ADVANCE_YEAR", contentMode: "standard" };
      session = runP3EPlaySessionCommand({ session, command }).session;
      expect(["life_stage", "student", "employed", "self_employed", "unemployed", "retired"]).toContain(
        session.view.profile.currentRole.kind
      );
      // 有伴侶時，profile 的 personName 必須等於 view.partner 的姓名。
      if (session.view.partner !== null) {
        expect(session.view.profile.relationship.personName).toBe(session.view.partner.displayName);
      }
      // 15 歲以前不可能有關係事件；16–17 歲的 first-love 可以建立 dating。
      if (session.state.age < 15) expect(session.view.profile.relationship.status).toBe("single");
    }
    expect(session.state.age).toBeGreaterThanOrEqual(18);
  });

  it("lifeLog 的泛稱事件帶 detailId，且存檔復原後 detailId 完全相同", async () => {
    const { createP3EPlaySession, exportP3EPlaySessionPayload, restoreP3EPlaySessionPayload, runP3EPlaySessionCommand } =
      await import("../src/p3e-session");
    const { buildPeerGroup, createBirthCertificate, validateDeathPack } = await import("@life-sim/birth");
    const { validateEventPack } = await import("@life-sim/engine");
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
    const seed = "gpt-0040-detail-session";
    const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
    const certificate = createBirthCertificate(base, identityPack, group, seed);
    let session = createP3EPlaySession({ masterSeed: seed, basePack: base, identityPack, certificate, eventPack, deathPack });
    for (let step = 0; step < 40 && session.state.phase !== "death"; step += 1) {
      const command =
        session.state.phase === "pending_decision"
          ? { type: "CHOOSE_DECISION", optionId: session.state.pendingDecision?.optionIds[0] as string }
          : { type: "ADVANCE_YEAR", contentMode: "standard" };
      session = runP3EPlaySessionCommand({ session, command }).session;
    }

    const detailed = session.view.lifeLog.filter((entry) => entry.detailId !== null);
    expect(detailed.length).toBeGreaterThan(0);
    for (const entry of detailed) {
      expect(isP3EDetailId(entry.detailId)).toBe(true);
      expect(typeof copyDocument.copy[entry.detailId as string]).toBe("string");
      // stage 必須對應年齡。
      expect(entry.detailId as string).toContain(`.${lifeStageOfAge(entry.age)}.`);
    }

    const payload = exportP3EPlaySessionPayload({ session });
    const restored = restoreP3EPlaySessionPayload({
      payload,
      masterSeed: seed,
      basePack: base,
      identityPack,
      certificate,
      eventPack,
      deathPack
    });
    expect(JSON.stringify(restored.view.lifeLog)).toBe(JSON.stringify(session.view.lifeLog));
    expect(JSON.stringify(restored.view.profile)).toBe(JSON.stringify(session.view.profile));
  });
});
/* ------------------------------------------------------------------ */
/* GPT-DEEPSEEK-0041-A：關係狀態只有一個真相                             */
/* ------------------------------------------------------------------ */

describe("GPT-0041-A 關係轉移：只看當前這段關係", () => {
  const context = {
    masterSeed: "gpt-0041-relationship",
    identityPack,
    cultureId: "han",
    playerSex: "female"
  };
  const date = fact({ kind: "decision", eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2040, age: 16 });
  const marry = fact({ kind: "decision", eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2050, age: 26 });
  const cohabit = fact({ kind: "decision", eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "cohabit", year: 2048, age: 24 });
  const single = (year: number) =>
    fact({ kind: "decision", eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "single", year, age: year - 2024 });
  const divorce = (year: number) =>
    fact({ kind: "decision", eventId: "ev.adult.marital-breakup", decisionId: "dec.adult.marital-breakup", optionId: "divorce", year, age: year - 2024 });
  const widow = (year: number) => fact({ kind: "event", eventId: "ev.adult.partner-loss", year, age: year - 2024 });

  const run = (facts: readonly P3EProfileFact[]) => resolveP3ERelationship({ ...context, facts });

  it("交往 → 分手：single，且 partner 為 null（不是活躍伴侶）", () => {
    const resolution = run([date, single(2042)]);
    expect(resolution.status).toBe("single");
    expect(resolution.partner).toBeNull();
    expect(relationshipSnapshot(resolution).personName).toBeNull();
  });

  it("已婚 → 選 single：回到 single（fixture 已用條件讓已婚者抽不到一般關係事件）", () => {
    const resolution = run([date, cohabit, marry, single(2052)]);
    expect(resolution.status).toBe("single");
    expect(resolution.partner).toBeNull();
    expect(relationshipSnapshot(resolution).personName).toBeNull();
  });

  it("已婚 → 離婚事件：relationship:divorced 對應的 divorced 狀態", () => {
    const resolution = run([date, marry, divorce(2055)]);
    expect(resolution.status).toBe("divorced");
    expect(resolution.partner).toBeNull();
  });

  it("已婚 → 喪偶：widowed、partner 必須變 null、保留配偶姓名", () => {
    const resolution = run([date, marry, widow(2056)]);
    expect(resolution.status).toBe("widowed");
    expect(resolution.partner).toBeNull();
    const snapshot = relationshipSnapshot(resolution);
    expect(typeof snapshot.personName).toBe("string");
    expect(snapshot.sinceYear).toBe(2056);
  });

  it("離異 → 新交往 → 分手：最後必須是 single（不得因曾結婚又變 divorced）", () => {
    const resolution = run([date, marry, single(2052), date, single(2060)]);
    expect(resolution.status).toBe("single");
    expect(resolution.partner).toBeNull();
  });

  it("喪偶 → 新交往 → 再婚：married、且新對象姓名", () => {
    const widowedFirst = run([date, marry, widow(2056), date, marry]);
    expect(widowedFirst.status).toBe("married");
    expect(widowedFirst.partner).not.toBeNull();

    const remarried = run([date, marry, widow(2056), date, marry]);
    expect(remarried.partner?.displayName).toBe(widowedFirst.partner?.displayName);
    expect(relationshipSnapshot(remarried).personName).toBe(remarried.partner?.displayName as string);
  });

  it("同居（未婚）後分手：single（不是 divorced）", () => {
    const resolution = run([date, cohabit, single(2051)]);
    expect(resolution.status).toBe("single");
  });
});

/* ------------------------------------------------------------------ */
/* GPT-DEEPSEEK-0041-A：detail 文案不得捏造未建模的人設                   */
/* ------------------------------------------------------------------ */

describe("GPT-0041-A detail 文案不得假設未建模的人物／財產／職業", () => {
  /** 這些名詞需要 state 證明（家庭成員、私人運具、職場角色、公司），32 條文案都不該出現。 */
  const FORBIDDEN = [
    "弟弟",
    "妹妹",
    "哥哥",
    "姊姊",
    "兄弟",
    "孫子",
    "孫女",
    "孩子",
    "機車",
    "汽車",
    "開車",
    "主管",
    "老闆",
    "客戶",
    "同事",
    "團隊",
    "下屬",
    "員工",
    "廠商",
    "公司",
    "提案",
    "專案"
  ];

  it("32 條文案都不含未建模的人物／財產／職業名詞", () => {
    const offenders: string[] = [];
    for (const detailId of P3E_DETAIL_IDS) {
      const text = copyDocument.copy[detailId] as string;
      for (const word of FORBIDDEN) {
        if (text.includes(word)) offenders.push(`${detailId}: ${word} → ${text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("每個 stage 各 4 個 setback／4 個 small-win，且都至少 12 個字", () => {
    for (const kind of ["setback", "small-win"]) {
      for (const stage of ["childhood", "adolescence", "adulthood", "later_life"] as const) {
        const texts = P3E_DETAIL_IDS.filter((detailId) => detailId.startsWith(`p3b.detail.${kind}.${stage}.`)).map(
          (detailId) => copyDocument.copy[detailId] as string
        );
        expect(texts, `${kind}/${stage}`).toHaveLength(4);
        for (const text of texts) expect(text.length).toBeGreaterThanOrEqual(12);
      }
    }
  });
});
/* ------------------------------------------------------------------ */
/* GPT-DEEPSEEK-0041-A：博士的模擬層 eligibility                         */
/* ------------------------------------------------------------------ */

describe("GPT-0041-A 博士需要先完成大學（模擬層也要擋）", () => {
  it("沒有大學學歷時 further-study 不會被抽到；有大學學歷時可以選 doctorate", async () => {
    const { createP3EPlaySession, runP3EPlaySessionCommand } = await import("../src/p3e-session");
    const { computeEventsChecksum, computePackChecksum, validateEventPack, validateDeathPack } = {
      ...(await import("@life-sim/engine")),
      validateDeathPack: (await import("@life-sim/birth")).validateDeathPack
    };
    const { buildPeerGroup, createBirthCertificate } = await import("@life-sim/birth");

    /** 只放 after-school ＋ further-study 的最小 pack（further-study 有 edu:university 條件）。 */
    const rawManifest = readJson("fixtures/p3b/manifest.v1.json") as Record<string, unknown>;
    const rawEvents = (readJson("fixtures/p3b/events.v1.json") as { records: Record<string, unknown>[] }).records;
    const events = ["ev.adult.after-school", "ev.adult.further-study"].map((eventId) => {
      const source = rawEvents.find((record) => record.eventId === eventId);
      if (source === undefined) throw new Error(`missing ${eventId}`);
      return structuredClone(source);
    });
    const manifest = structuredClone(rawManifest);
    const checksum = computeEventsChecksum(events as never);
    const descriptor = (manifest.datasets as Record<string, unknown>[])[0] as Record<string, unknown>;
    descriptor.recordCount = events.length;
    descriptor.checksum = checksum;
    for (const license of manifest.licenses as Record<string, unknown>[]) license.checksum = checksum;
    for (const record of manifest.lineage as Record<string, unknown>[]) record.outputChecksum = checksum;
    manifest.packChecksum = computePackChecksum(manifest as never);
    const eventPack = validateEventPack({ manifest, events } as never);
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

    const play = (seed: string, choose: (decisionId: string, optionIds: readonly string[]) => string) => {
      const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
      const certificate = createBirthCertificate(base, identityPack, group, seed);
      let session = createP3EPlaySession({ masterSeed: seed, basePack: base, identityPack, certificate, eventPack, deathPack });
      const seen: { decisionId: string; optionIds: readonly string[] }[] = [];
      for (let step = 0; step < 60 && session.state.age <= 32 && session.state.phase !== "death"; step += 1) {
        if (session.state.phase === "pending_decision") {
          const decisionId = session.state.pendingDecision?.decisionId as string;
          const optionIds = session.state.pendingDecision?.optionIds ?? [];
          seen.push({ decisionId, optionIds });
          session = runP3EPlaySessionCommand({ session, command: { type: "CHOOSE_DECISION", optionId: choose(decisionId, optionIds) } }).session;
          continue;
        }
        session = runP3EPlaySessionCommand({ session, command: { type: "ADVANCE_YEAR", contentMode: "standard" } }).session;
      }
      return seen;
    };

    // A. 選工作（沒有 edu:university）→ further-study 永遠不會出現。
    const withoutUniversity = play("gpt-0041-doctorate-a", (decisionId) =>
      decisionId === "dec.adult.after-school" ? "work" : (undefined as never)
    );
    expect(withoutUniversity.some((entry) => entry.decisionId === "dec.adult.further-study")).toBe(false);

    // B. 選大學 → further-study 會出現，且可以選 doctorate。
    const withUniversity = play("gpt-0041-doctorate-b", (decisionId, optionIds) => {
      if (decisionId === "dec.adult.after-school") return "university";
      if (decisionId === "dec.adult.further-study") return optionIds.includes("doctorate") ? "doctorate" : (optionIds[0] as string);
      return optionIds[0] as string;
    });
    const furtherStudy = withUniversity.find((entry) => entry.decisionId === "dec.adult.further-study");
    expect(furtherStudy).toBeDefined();
    expect(furtherStudy?.optionIds).toContain("doctorate");
  });
});
describe("GPT-0043-A fixture 條件：一般關係事件排除已婚、離婚／喪偶需要已婚", () => {
  const events = (readJson("fixtures/p3b/events.v1.json") as { records: Record<string, unknown>[] }).records;
  const byId = (eventId: string) => events.find((event) => event.eventId === eventId) as Record<string, unknown>;

  it("ev.adult.relationship 有 not(partner:married) 條件，且年齡開放到晚年", () => {
    const event = byId("ev.adult.relationship");
    expect(event.conditions).toEqual({
      op: "not",
      condition: { op: "flag", flag: "partner:married", present: true }
    });
    expect(event.ageMax).toBeGreaterThanOrEqual(65);
    expect(event.lifeStages).toContain("later_life");
  });

  it("ev.adult.marital-breakup 只在 partner:married 時 eligible", () => {
    const event = byId("ev.adult.marital-breakup");
    expect(event.conditions).toEqual({ op: "flag", flag: "partner:married", present: true });
  });

  it("ev.adult.partner-loss 只在 partner:married 時 eligible", () => {
    const event = byId("ev.adult.partner-loss");
    expect(event.conditions).toEqual({ op: "flag", flag: "partner:married", present: true });
  });

  it("single 選項只清 active partner 旗標、不寫 relationship:divorced；divorce 選項才寫", () => {
    const relationship = byId("ev.adult.relationship") as { decision: { options: { optionId: string; effects: { type: string; flag?: string; action?: string }[] }[] } };
    const single = relationship.decision.options.find((option) => option.optionId === "single")!;
    const singleFlags = single.effects.filter((effect) => effect.type === "flag");
    expect(singleFlags.every((effect) => effect.action === "remove")).toBe(true);
    // GPT-0044-A：single 也要清掉 divorced／widowed，讓 canonical 與 profile 一致。
    expect(singleFlags.map((effect) => effect.flag)).toEqual(
      expect.arrayContaining(["relationship:divorced", "relationship:widowed"])
    );
    expect(single.effects.some((effect) => effect.type === "flag" && effect.action === "add")).toBe(false);

    const breakup = byId("ev.adult.marital-breakup") as { decision: { options: { optionId: string; effects: { type: string; flag?: string; action?: string }[] }[] } };
    const divorce = breakup.decision.options.find((option) => option.optionId === "divorce")!;
    expect(divorce.effects.some((effect) => effect.type === "flag" && effect.flag === "relationship:divorced" && effect.action === "add")).toBe(true);
  });
});
