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
import {
  computeEventsChecksum,
  computePackChecksum,
  validateEventPack,
  type ValidatedEventPack
} from "@life-sim/engine";
import {
  advanceP3ELifePartner,
  isP3ELifePartner,
  P3E_PARTNER_OPTION_STATUS,
  P3E_PARTNER_TRANSITIONS,
  partnerTransitionFromChoice,
  resolveP3ELifePartner,
  type P3EPartnerChoice
} from "../src/p3e-partner";
import {
  createP3EPlaySession,
  exportP3EPlaySessionPayload,
  restoreP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";

/**
 * GPT-DEEPSEEK-0036-A／0037-A｜具名伴侶測試。
 *
 * 全部走正式 application 入口；關係事件用真實 fixture
 * （`ev.teen.first-love`／`ev.adult.relationship`）組成最小 pack。
 *
 * 0037-A 重點：
 * - `single` 必須清除既有伴侶（即時路徑與 replay 路徑都要）；
 * - 轉移必須同時比對 `eventId ＋ decisionId ＋ optionId`，eventId 不符不得
 *   建立／升級／清除伴侶。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

type Dict = Record<string, unknown>;

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

const rawEventManifest = readJson("fixtures/p3b/manifest.v1.json") as Dict;
const rawEvents = (readJson("fixtures/p3b/events.v1.json") as { records: Dict[] }).records;

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

interface PackOptions {
  readonly renameEventIds?: Readonly<Record<string, string>>;
}

function repairedEventPack(eventIds: readonly string[], options: PackOptions = {}): ValidatedEventPack {
  const events = eventIds.map((eventId) => {
    const source = rawEvents.find((record) => record.eventId === eventId);
    if (source === undefined) throw new Error(`missing fixture event ${eventId}`);
    const clone = structuredClone(source);
    const renamed = options.renameEventIds?.[eventId];
    if (renamed !== undefined) clone.eventId = renamed;
    return clone;
  });
  events.sort((left, right) => (String(left.eventId) < String(right.eventId) ? -1 : 1));
  const manifest = structuredClone(rawEventManifest);
  const datasetChecksum = computeEventsChecksum(events as never);
  const descriptor = (manifest.datasets as Dict[])[0] as Dict;
  descriptor.recordCount = events.length;
  descriptor.checksum = datasetChecksum;
  for (const license of manifest.licenses as Dict[]) license.checksum = datasetChecksum;
  for (const record of manifest.lineage as Dict[]) record.outputChecksum = datasetChecksum;
  manifest.packChecksum = computePackChecksum(manifest as never);
  return validateEventPack({ manifest, events } as never);
}

/** 兩個真實關係事件。 */
const relationshipPack = repairedEventPack(["ev.teen.first-love", "ev.adult.relationship"]);

/** 成年關係事件的 eventId 被改掉（decision／option id 完全相同）。 */
const renamedAdultPack = repairedEventPack(["ev.teen.first-love", "ev.adult.relationship"], {
  renameEventIds: { "ev.adult.relationship": "ev.custom.relationship" }
});

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

function sessionFor(seed: string, eventPack: ValidatedEventPack = relationshipPack): P3EPlaySession {
  const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
  const certificate = createBirthCertificate(base, identityPack, group, seed);
  return createP3EPlaySession({
    masterSeed: seed,
    basePack: base,
    identityPack,
    certificate,
    eventPack,
    deathPack
  });
}

function step(session: P3EPlaySession, command: unknown): P3EPlaySession {
  return runP3EPlaySessionCommand({ session, command }).session;
}

function playUntilDecision(session: P3EPlaySession, decisionId: string, optionId?: string, limit = 80): P3EPlaySession {
  let current = session;
  for (let index = 0; index < limit && current.state.phase !== "death"; index += 1) {
    if (current.state.phase === "pending_decision") {
      const pending = current.state.pendingDecision;
      if (pending?.decisionId === decisionId && (optionId === undefined || pending.optionIds.includes(optionId))) return current;
      current = step(current, { type: "CHOOSE_DECISION", optionId: pending?.optionIds[0] as string });
      continue;
    }
    current = step(current, ADVANCE);
  }
  throw new Error(`decision ${decisionId} not reached`);
}

function chooseOption(session: P3EPlaySession, optionId: string): P3EPlaySession {
  return step(session, { type: "CHOOSE_DECISION", optionId });
}

function restore(session: P3EPlaySession, seed: string, eventPack: ValidatedEventPack) {
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

describe("GPT-0037-A 關係轉移表（eventId ＋ decisionId ＋ optionId）", () => {
  it("四種正式轉移都存在，且 key 由 event／decision／option 三名組成", () => {
    expect(Object.keys(P3E_PARTNER_TRANSITIONS).sort()).toEqual(
      [
        "ev.adult.relationship|dec.adult.relationship|cohabit",
        "ev.adult.relationship|dec.adult.relationship|marry",
        "ev.adult.relationship|dec.adult.relationship|single",
        "ev.teen.first-love|dec.teen.first-love|date"
      ].sort()
    );
    expect(partnerTransitionFromChoice("ev.teen.first-love", "dec.teen.first-love", "date")).toEqual({
      kind: "create",
      status: "dating"
    });
    expect(partnerTransitionFromChoice("ev.adult.relationship", "dec.adult.relationship", "single")).toEqual({
      kind: "clear"
    });
  });

  it("eventId 不符時不得建立、升級或清除（decision／option 相同也一樣）", () => {
    expect(partnerTransitionFromChoice("ev.custom.relationship", "dec.adult.relationship", "marry")).toBeNull();
    expect(partnerTransitionFromChoice("ev.custom.relationship", "dec.adult.relationship", "cohabit")).toBeNull();
    expect(partnerTransitionFromChoice("ev.custom.relationship", "dec.adult.relationship", "single")).toBeNull();
    expect(partnerTransitionFromChoice("ev.custom.first-love", "dec.teen.first-love", "date")).toBeNull();
    expect(partnerTransitionFromChoice("ev.teen.first-love", "dec.teen.first-love", "focus")).toBeNull();
    expect(partnerTransitionFromChoice("ev.adult.relationship", "dec.adult.relationship", "single")).not.toBeNull();
  });

  it("P3E_PARTNER_OPTION_STATUS 只列出會建立關係的三個選項", () => {
    expect(P3E_PARTNER_OPTION_STATUS).toEqual({
      "dec.teen.first-love:date": "dating",
      "dec.adult.relationship:cohabit": "partner",
      "dec.adult.relationship:marry": "spouse"
    });
  });
});

describe("GPT-0037-A 保持單身必須清除伴侶", () => {
  it("teen date → adult single：即時路徑 partner 立刻變成 null", () => {
    const seed = "gpt-0037-single-clear";
    const dating = chooseOption(playUntilDecision(sessionFor(seed), "dec.teen.first-love", "date"), "date");
    expect(dating.view.partner?.status).toBe("dating");

    const adult = playUntilDecision(dating, "dec.adult.relationship", "single");
    expect(adult.view.partner).not.toBeNull();
    const cleared = chooseOption(adult, "single");
    expect(cleared.view.partner).toBeNull();
    const after = step(cleared, ADVANCE);
    expect(after.view.partner).toBeNull();
  });

  it("teen date → adult single → save/load/replay 後仍是 null", () => {
    const seed = "gpt-0037-single-restore";
    const dating = chooseOption(playUntilDecision(sessionFor(seed), "dec.teen.first-love", "date"), "date");
    const adult = playUntilDecision(dating, "dec.adult.relationship", "single");
    const cleared = chooseOption(adult, "single");
    expect(cleared.view.partner).toBeNull();

    const restored = restore(cleared, seed, relationshipPack);
    expect(restored.view.partner).toBeNull();
    expect(restored.state.stateHash).toBe(cleared.state.stateHash);
  });

  it("無關選擇（不建立關係的選項）不會清除既有伴侶", () => {
    const seed = "gpt-0037-unrelated-keeps";
    const dating = chooseOption(playUntilDecision(sessionFor(seed), "dec.teen.first-love", "date"), "date");
    const partnerBefore = JSON.stringify(dating.view.partner);
    expect(dating.view.partner).not.toBeNull();

    let current = dating;
    for (let index = 0; index < 6 && current.state.phase !== "death"; index += 1) {
      current = current.state.phase === "pending_decision"
        ? step(current, { type: "CHOOSE_DECISION", optionId: current.state.pendingDecision?.optionIds[0] as string })
        : step(current, ADVANCE);
      if (current.view.partner !== null) expect(JSON.stringify(current.view.partner)).toBe(partnerBefore);
    }
  });

  it("eventId 被改掉的自訂 pack：marry／single 都不會建立或清除伴侶", () => {
    const seed = "gpt-0037-renamed-event";
    const dating = chooseOption(playUntilDecision(sessionFor(seed, renamedAdultPack), "dec.teen.first-love", "date"), "date");
    const partnerBefore = JSON.stringify(dating.view.partner);
    expect(dating.view.partner).not.toBeNull();

    const adult = playUntilDecision(dating, "dec.adult.relationship", "marry");
    const upgraded = chooseOption(adult, "marry");
    expect(JSON.stringify(upgraded.view.partner)).toBe(partnerBefore);

    const adultSingle = playUntilDecision(upgraded, "dec.adult.relationship", "single");
    const afterSingle = chooseOption(adultSingle, "single");
    expect(JSON.stringify(afterSingle.view.partner)).toBe(partnerBefore);
  });

  it("重建函式：date → cohabit → marry 升級同一人；single 清成 null；清除後再建立是新的人", () => {
    const seed = "gpt-0037-resolve";
    const certificate = createBirthCertificate(
      base,
      identityPack,
      buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never),
      seed
    );
    const context = {
      masterSeed: seed,
      identityPack,
      cultureId: certificate.player.name.cultureId,
      playerSex: certificate.player.birth.sex
    };
    const choices: P3EPartnerChoice[] = [
      { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2041 },
      { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "cohabit", year: 2050 },
      { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2052 }
    ];
    const dating = resolveP3ELifePartner({ ...context, choices: [choices[0] as P3EPartnerChoice] });
    const married = resolveP3ELifePartner({ ...context, choices });
    expect(dating?.status).toBe("dating");
    expect(married?.status).toBe("spouse");
    expect(married?.displayName).toBe(dating?.displayName);
    expect(married?.sinceYear).toBe(2041);

    const cleared = resolveP3ELifePartner({
      ...context,
      choices: [...choices, { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "single", year: 2054 }]
    });
    expect(cleared).toBeNull();

    const next = resolveP3ELifePartner({
      ...context,
      choices: [
        ...choices,
        { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "single", year: 2054 },
        { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2060 }
      ]
    });
    expect(next?.status).toBe("spouse");
    expect(next?.sinceYear).toBe(2060);
  });

  it("advanceP3ELifePartner：clear 轉移直接回 null、無關選擇保留 previous", () => {
    const seed = "gpt-0037-advance";
    const certificate = createBirthCertificate(
      base,
      identityPack,
      buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never),
      seed
    );
    const context = {
      masterSeed: seed,
      identityPack,
      cultureId: certificate.player.name.cultureId,
      playerSex: certificate.player.birth.sex
    };
    const dating = advanceP3ELifePartner({
      ...context,
      previous: null,
      choice: { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2041 }
    });
    expect(dating?.status).toBe("dating");
    const kept = advanceP3ELifePartner({
      ...context,
      previous: dating,
      choice: { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "focus", year: 2042 }
    });
    expect(JSON.stringify(kept)).toBe(JSON.stringify(dating));
    const cleared = advanceP3ELifePartner({
      ...context,
      previous: dating,
      choice: { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "single", year: 2050 }
    });
    expect(cleared).toBeNull();
  });
});

describe("GPT-0036-A 伴侶：接受／拒絕、多樣性與存檔（回歸）", () => {
  it("選 date 會建立伴侶（status dating、姓名來自語料、sinceYear 正確）", () => {
    const seed = "gpt-0036-partner-date";
    const pending = playUntilDecision(sessionFor(seed), "dec.teen.first-love", "date");
    const after = chooseOption(pending, "date");
    const partner = after.view.partner;
    expect(partner).not.toBeNull();
    if (partner === null) return;
    expect(isP3ELifePartner(partner)).toBe(true);
    expect(partner.status).toBe("dating");
    expect(partner.sinceYear).toBe(after.state.currentYear);
    expect(partner.eventId).toBe("ev.teen.first-love");
    expect(partner.decisionId).toBe("dec.teen.first-love");
    expect(partner.optionId).toBe("date");
    const pools = identityPack.namePoolsByCulture[partner.cultureId] as {
      surname: readonly string[];
      female: readonly string[];
      male: readonly string[];
    };
    expect(pools.surname).toContain(partner.surname);
    expect([...pools.female, ...pools.male]).toContain(partner.givenName);
  });

  it("選 focus／secret 不會建立伴侶", () => {
    for (const optionId of ["focus", "secret"]) {
      const seed = `gpt-0036-partner-${optionId}`;
      const after = chooseOption(playUntilDecision(sessionFor(seed), "dec.teen.first-love", optionId), optionId);
      expect(after.view.partner, optionId).toBeNull();
    }
  });

  it("成年 relationship：cohabit 升級 partner、marry 升級 spouse（同一人、姓名不變）", () => {
    for (const [optionId, expected] of [
      ["cohabit", "partner"],
      ["marry", "spouse"]
    ] as const) {
      const seed = `gpt-0036-adult-${optionId}`;
      const pending = playUntilDecision(sessionFor(seed), "dec.adult.relationship", optionId);
      const previousPartner = pending.view.partner;
      const after = chooseOption(pending, optionId);
      expect(previousPartner, optionId).not.toBeNull();
      expect(after.view.partner?.status, optionId).toBe(expected);
      expect(after.view.partner?.displayName, optionId).toBe(previousPartner?.displayName);
      expect(after.view.partner?.sinceYear, optionId).toBe(previousPartner?.sinceYear);
    }
  });

  it("同 seed、同 commands → 同姓名與同 state hash；不同 seed 有多樣性", () => {
    const seed = "gpt-0036-partner-stable";
    const play = () => chooseOption(playUntilDecision(sessionFor(seed), "dec.teen.first-love", "date"), "date");
    const first = play();
    const second = play();
    expect(first.state.stateHash).toBe(second.state.stateHash);
    expect(JSON.stringify(first.view.partner)).toBe(JSON.stringify(second.view.partner));

    const names = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      const other = `gpt-0036-partner-diversity-${index}`;
      const partner = chooseOption(playUntilDecision(sessionFor(other), "dec.teen.first-love", "date"), "date").view.partner;
      names.add(partner?.displayName as string);
    }
    expect(names.size).toBeGreaterThanOrEqual(2);
  });

  it("存檔復原後伴侶完全相同（姓名、狀態、年份）", () => {
    const seed = "gpt-0036-partner-restore";
    const played = chooseOption(playUntilDecision(sessionFor(seed), "dec.teen.first-love", "date"), "date");
    const restored = restore(played, seed, relationshipPack);
    expect(JSON.stringify(restored.view.partner)).toBe(JSON.stringify(played.view.partner));
    expect(restored.state.stateHash).toBe(played.state.stateHash);
  });

  it("沒有關係事件 → partner 為 null，仍可正常載入", () => {
    const session = sessionFor("gpt-0036-partner-none");
    expect(session.view.partner).toBeNull();
    let current = session;
    for (let index = 0; index < 8 && current.state.phase !== "death"; index += 1) {
      current = current.state.phase === "pending_decision"
        ? step(current, { type: "CHOOSE_DECISION", optionId: current.state.pendingDecision?.optionIds[0] as string })
        : step(current, ADVANCE);
      expect(current.view.partner).toBeNull();
    }
  });
});
