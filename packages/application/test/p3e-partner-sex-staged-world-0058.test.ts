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
  completeP3EBrowserWorld,
  createP3EBrowserSession,
  prepareP3EBrowserBirthStage,
  prepareP3EBrowserWorld,
  previewP3EBrowserBirth,
  previewP3EBrowserBirthStage,
  restoreP3EBrowserSession
} from "../src/p3e-browser-bootstrap";
import {
  createP3EPlaySession,
  exportP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";
import { advanceP3ELifePartner, buildP3ELifePartner, resolveP3ELifePartner, type P3EPartnerChoice } from "../src/p3e-partner";
import { deriveP3EScene, resolveP3ERelationship, relationshipSnapshot, sceneAgeStageOf } from "../src/p3e-profile";

/**
 * GPT-DEEPSEEK-0058-A：
 *
 * 1. 伴侶性別是角色身分（`P3ELifePartner.sex`），不再從姓名池推測；
 * 2. application 層的兩階段世界準備（出生卡先用 base＋identity，之後才補 events＋death）。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const rawBase = readJson("fixtures/p2a/manifest.v1.json") as Record<string, unknown>;
const rawIdentity = readJson("fixtures/p2b/manifest.v1.json");
const rawEvents = readJson("fixtures/p3b/manifest.v1.json");
const rawDeath = readJson("fixtures/p3d/manifest.v1.json");

const rawPacks = {
  base: {
    manifest: readJson("fixtures/p2a/manifest.v1.json"),
    datasets: {
      "country-registry": readJson("fixtures/p2a/country-registry.v1.json"),
      indicators: readJson("fixtures/p2a/indicators.v1.json"),
      "birth-weights": readJson("fixtures/p2a/birth-weights.v1.json"),
      "sensitive-names": readJson("fixtures/p2a/sensitive-names.v1.json"),
      licenses: readJson("fixtures/p2a/licenses.v1.json"),
      lineage: readJson("fixtures/p2a/lineage.v1.json")
    }
  },
  identity: {
    manifest: rawIdentity,
    datasets: {
      "country-vitals": readJson("fixtures/p2b/country-vitals.v1.json"),
      "household-profiles": readJson("fixtures/p2b/household-profiles.v1.json"),
      "name-corpus": readJson("fixtures/p2b/name-corpus.v1.json"),
      "story-templates": readJson("fixtures/p2b/story-templates.v1.json"),
      licenses: readJson("fixtures/p2b/licenses.v1.json"),
      lineage: readJson("fixtures/p2b/lineage.v1.json")
    }
  },
  events: { manifest: rawEvents, events: (readJson("fixtures/p3b/events.v1.json") as { records: unknown[] }).records },
  death: {
    manifest: rawDeath,
    datasets: {
      "cause-registry": readJson("fixtures/p3d/cause-registry.v1.json"),
      "cause-weights": readJson("fixtures/p3d/cause-weights.v1.json"),
      mortality: readJson("fixtures/p3d/mortality.v1.json"),
      licenses: readJson("fixtures/p3d/licenses.v1.json"),
      lineage: readJson("fixtures/p3d/lineage.v1.json")
    }
  }
};

const base = validateDataPack(rawPacks.base as never);
const identityPack = validateIdentityPack(base, rawPacks.identity as never);
const deathPack = validateDeathPack(rawPacks.death as never, base);

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

function contextFor(seed: string) {
  const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
  const certificate = createBirthCertificate(base, identityPack, group, seed);
  return {
    masterSeed: seed,
    identityPack,
    cultureId: certificate.player.name.cultureId,
    playerSex: certificate.player.birth.sex
  };
}

describe("GPT-0058-A 任務一：伴侶性別是角色身分", () => {
  it("建立伴侶時就有 sex（與玩家相反），且 frozen", () => {
    const context = contextFor("gpt-0058-partner-sex");
    const partner = buildP3ELifePartner({
      ...context,
      first: { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2040 },
      latestStatus: "dating"
    });
    expect(["male", "female"]).toContain(partner.sex);
    expect(partner.sex).toBe(context.playerSex === "female" ? "male" : "female");
    expect(Object.isFrozen(partner)).toBe(true);
  });

  it("同一伴侶跨 young/middle/senior：partner.sex 與 scene.partnerSex 永遠相同", () => {
    const context = contextFor("gpt-0058-partner-aging");
    const choices: P3EPartnerChoice[] = [
      { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2040 },
      { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2048 }
    ];
    const partner = resolveP3ELifePartner({ ...context, choices });
    expect(partner).not.toBeNull();
    const partnerSex = partner?.sex as "male" | "female";

    // young(18-34) / middle(35-59) / senior(60+) 三個年齡，性別都必須一樣。
    for (const [age, stage] of [
      [25, "young"],
      [45, "middle"],
      [70, "senior"]
    ] as const) {
      const state = {
        age,
        currentYear: 2024 + age,
        phase: "life",
        flags: ["partner:married"],
        stats: { health: 60, happiness: 60, knowledge: 50, relationships: 50 },
        identity: { entityId: "cr:JPN", regionCode: "JPN", sex: context.playerSex, birthYear: 2024 }
      } as never;
      const facts = [
        { kind: "decision", eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2040, age: 16 },
        { kind: "decision", eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2048, age: 24 }
      ] as never;
      const relationship = resolveP3ERelationship({ ...context, facts });
      const scene = deriveP3EScene({
        state,
        relationship: relationshipSnapshot(relationship),
        partnerSex: relationship.partner?.sex ?? null,
        settlement: "urban"
      });
      expect(sceneAgeStageOf(age)).toBe(stage);
      expect(scene.hasPartner).toBe(true);
      expect(scene.partnerSex).toBe(partnerSex);
      expect(relationship.partner?.sex).toBe(partnerSex);
    }
  });

  it("dating → spouse 性別與姓名都不變", () => {
    const context = contextFor("gpt-0058-partner-upgrade");
    const dating = advanceP3ELifePartner({
      ...context,
      previous: null,
      choice: { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2040 }
    });
    const spouse = advanceP3ELifePartner({
      ...context,
      previous: dating,
      choice: { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2048 }
    });
    expect(spouse?.sex).toBe(dating?.sex);
    expect(spouse?.displayName).toBe(dating?.displayName);
    expect(spouse?.status).toBe("spouse");
  });

  it("結束關係後的新伴侶才是新身分（新姓名；性別仍是身分的一部分）", () => {
    const context = contextFor("gpt-0058-partner-new");
    const first = resolveP3ELifePartner({
      ...context,
      choices: [
        { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2040 },
        { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "single", year: 2050 }
      ]
    });
    expect(first).toBeNull();
    const second = resolveP3ELifePartner({
      ...context,
      choices: [
        { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2040 },
        { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "single", year: 2050 },
        { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2058 }
      ]
    });
    expect(second).not.toBeNull();
    expect(["male", "female"]).toContain(second?.sex);
  });
});

describe("GPT-0058-A 任務二：分階段資料載入", () => {
  it("分階段與一次性準備：同 seed 出生預覽逐欄位／hash 一致", () => {
    const stage = prepareP3EBrowserBirthStage({ base: rawPacks.base, identity: rawPacks.identity });
    const world = prepareP3EBrowserWorld(rawPacks);
    for (const seed of ["gpt-0058-stage-a", "gpt-0058-stage-b", "p3e-166-playable-runtime-v4"]) {
      const staged = previewP3EBrowserBirthStage({ stage, masterSeed: seed });
      const oneShot = previewP3EBrowserBirth({ world, masterSeed: seed });
      expect(JSON.stringify(staged)).toBe(JSON.stringify(oneShot));
      expect(staged.certificateHash).toBe(oneShot.certificateHash);
      expect(staged.country.regionCode).toBe(oneShot.country.regionCode);
      expect(staged.name).toEqual(oneShot.name);
    }
  });

  it("完整世界完成後：session／save／load 與舊的一次性路徑一致", () => {
    const stage = prepareP3EBrowserBirthStage({ base: rawPacks.base, identity: rawPacks.identity });
    const completed = completeP3EBrowserWorld({ stage, events: rawPacks.events, death: rawPacks.death });
    const oneShotWorld = prepareP3EBrowserWorld(rawPacks);
    const seed = "gpt-0058-stage-session";

    const viaStage = createP3EBrowserSession({ world: completed, masterSeed: seed });
    const viaOneShot = createP3EBrowserSession({ world: oneShotWorld, masterSeed: seed });
    expect(viaStage.state.stateHash).toBe(viaOneShot.state.stateHash);
    expect(viaStage.view.scene).toEqual(viaOneShot.view.scene);

    // 推進幾年後存檔 → 用另一條路徑的 world 復原，結果必須相同。
    const play = (session: P3EPlaySession): P3EPlaySession => {
      let current = session;
      for (let step = 0; step < 12; step += 1) {
        current = runP3EPlaySessionCommand({
          session: current,
          command:
            current.state.phase === "pending_decision"
              ? { type: "CHOOSE_DECISION", optionId: current.state.pendingDecision?.optionIds[0] as string }
              : { ...ADVANCE }
        }).session;
      }
      return current;
    };
    const played = play(viaStage);
    const payload = exportP3EPlaySessionPayload({ session: played });
    const restored = restoreP3EBrowserSession({ world: oneShotWorld, masterSeed: seed, payload });
    expect(restored.state.stateHash).toBe(played.state.stateHash);
    expect(JSON.stringify(restored.view.scene)).toBe(JSON.stringify(played.view.scene));
    expect(JSON.stringify(restored.view.profile)).toBe(JSON.stringify(played.view.profile));
  });

  it("events／death 載入失敗：出生卡可看，但不會產生半套 world", () => {
    const stage = prepareP3EBrowserBirthStage({ base: rawPacks.base, identity: rawPacks.identity });
    // 出生卡仍然可用。
    const preview = previewP3EBrowserBirthStage({ stage, masterSeed: "gpt-0058-stage-error" });
    expect(preview.certificateId.length).toBeGreaterThan(0);

    // 壞掉的 events（缺必要欄位）→ 明確錯誤。
    const brokenEvents = { manifest: rawEvents, events: [] };
    expect(() => completeP3EBrowserWorld({ stage, events: brokenEvents, death: rawPacks.death })).toThrow();

    // 壞掉的 death → 明確錯誤。
    expect(() =>
      completeP3EBrowserWorld({ stage, events: rawPacks.events, death: { manifest: rawDeath, datasets: {} } })
    ).toThrow();

    // 失敗後 stage 仍然有效（可以再試一次，成功後才會有 world）。
    const completed = completeP3EBrowserWorld({ stage, events: rawPacks.events, death: rawPacks.death });
    expect(() => createP3EBrowserSession({ world: completed, masterSeed: "gpt-0058-stage-error" })).not.toThrow();

    // 偽造 stage／world 一律拒絕（不建立半套 session）。
    expect(() => completeP3EBrowserWorld({ stage: { fake: true }, events: rawPacks.events, death: rawPacks.death })).toThrow();
    expect(() => createP3EBrowserSession({ world: { fake: true }, masterSeed: "x" })).toThrow();
  });

  it("stage／world 都不可偽造、不可序列化（沒有 pack 欄位）", () => {
    const stage = prepareP3EBrowserBirthStage({ base: rawPacks.base, identity: rawPacks.identity });
    const world = completeP3EBrowserWorld({ stage, events: rawPacks.events, death: rawPacks.death });
    expect(Object.keys(stage)).toHaveLength(0);
    expect(Object.keys(world)).toHaveLength(0);
    expect(JSON.stringify(stage)).toBe("{}");
    expect(JSON.stringify(world)).toBe("{}");
    expect(Object.isFrozen(stage)).toBe(true);
    expect(Object.isFrozen(world)).toBe(true);
  });

  it("一次性 prepareP3EBrowserWorld 的既有語義不變（舊路徑仍可直接開局）", () => {
    const world = prepareP3EBrowserWorld(rawPacks);
    const session = createP3EBrowserSession({ world, masterSeed: "gpt-0058-legacy" });
    const deathPackEntityCount = deathPack.manifest.entityCount;
    expect(deathPackEntityCount).toBeGreaterThan(0);
    const direct = createP3EPlaySession({
      masterSeed: "gpt-0058-legacy",
      basePack: base,
      identityPack,
      certificate: createBirthCertificate(
        base,
        identityPack,
        buildPeerGroup(base, identityPack, { seed: "gpt-0058-legacy", playerSexPolicy: "random" } as never),
        "gpt-0058-legacy"
      ),
      eventPack: validateEventPack(rawPacks.events as never),
      deathPack
    });
    expect(session.state.stateHash).toBe(direct.state.stateHash);
    expect(session.view.scene).toEqual(direct.view.scene);
    void rawBase;
  });
});
