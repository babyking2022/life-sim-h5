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
  buildP3ELifePartner,
  resolveP3ELifePartner,
  type P3EPartnerChoice
} from "../src/p3e-partner";
import { resolveP3ERelationship, type P3EProfileFact } from "../src/p3e-profile";
import {
  createP3EPlaySession,
  exportP3EPlaySessionPayload,
  restoreP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";

/**
 * GPT-0046-B｜不同伴侶必須顯示不同姓名。
 *
 * 核心修法：伴侶姓名由「獨立 domain」KDF 推導（與正式年度 RNG 隔離），並在建立**新**關係時，
 * 把這位玩家「歷史上所有伴侶」的顯示名當作 `forbiddenNames`，依序嘗試直到抽到不重複的名字
 * （不消耗正式年度 RNG、不用 Math.random、不出現「伴侶2」這類內部 key）。同一段關係
 * （dating→cohabit→married）只升級 status、姓名不變。
 *
 * 下方多數測試在「修法前會失敗」：舊邏輯對不同關係只用第一段關係座標推導，語料每文化僅
 * 6 姓氏 × 6 異性 given（36 組合），故不同關係極易抽到同名。
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

const rawEventManifest = readJson("fixtures/p3b/manifest.v1.json") as Record<string, unknown>;
const rawEvents = (readJson("fixtures/p3b/events.v1.json") as { records: Record<string, unknown>[] }).records;

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

function repairedEventPack(eventIds: readonly string[]): ValidatedEventPack {
  const events = eventIds.map((eventId) => {
    const source = rawEvents.find((record) => record.eventId === eventId);
    if (source === undefined) throw new Error(`missing fixture event ${eventId}`);
    return structuredClone(source);
  });
  events.sort((left, right) => (String(left.eventId) < String(right.eventId) ? -1 : 1));
  const manifest = structuredClone(rawEventManifest);
  const datasetChecksum = computeEventsChecksum(events as never);
  const descriptor = (manifest.datasets as Record<string, unknown>[])[0] as Record<string, unknown>;
  descriptor.recordCount = events.length;
  descriptor.checksum = datasetChecksum;
  for (const license of manifest.licenses as Record<string, unknown>[]) license.checksum = datasetChecksum;
  for (const record of manifest.lineage as Record<string, unknown>[]) record.outputChecksum = datasetChecksum;
  manifest.packChecksum = computePackChecksum(manifest as never);
  return validateEventPack({ manifest, events } as never);
}

const relationshipPack = repairedEventPack(["ev.teen.first-love", "ev.adult.relationship"]);
const divorceWidowPack = repairedEventPack(["ev.teen.first-love", "ev.adult.relationship", "ev.adult.marital-breakup", "ev.adult.partner-loss"]);

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

function fact(input: {
  kind: P3EProfileFact["kind"];
  eventId: string;
  decisionId?: string;
  optionId?: string;
  year: number;
  age: number;
}): P3EProfileFact {
  // 事件事實沒有 decision／option；這裡預設 null（只補型別，不改行為）。
  return {
    kind: input.kind,
    eventId: input.eventId,
    decisionId: input.decisionId ?? null,
    optionId: input.optionId ?? null,
    year: input.year,
    age: input.age
  };
}

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

function playUntilDecision(session: P3EPlaySession, decisionId: string, optionId?: string, limit = 120): P3EPlaySession {
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

describe("GPT-0046-B 核心：不同關係必須顯示不同姓名", () => {
  it("buildP3ELifePartner：forbiddenNames 讓新伴侶姓名避開歷史伴侶（直接單元，修法前會同名）", () => {
    const ctx = contextFor("gpt-0046-forbidden-unit");
    const first = buildP3ELifePartner({ ...ctx, first: { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2041 }, latestStatus: "dating" });
    expect(first.displayName.length).toBeGreaterThan(0);
    // 用「完全相同」的第一段關係座標再建一次，但禁止與第一位同名 → 必須換一個名字。
    const second = buildP3ELifePartner({ ...ctx, first: { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2041 }, latestStatus: "dating", forbiddenNames: [first.displayName] });
    expect(second.displayName).not.toBe(first.displayName);
    // 第三、第四次仍持續避開，且確定性（同輸入同輸出）。
    const third = buildP3ELifePartner({ ...ctx, first: { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2041 }, latestStatus: "dating", forbiddenNames: [first.displayName, second.displayName] });
    expect(third.displayName).not.toBe(first.displayName);
    expect(third.displayName).not.toBe(second.displayName);
    const thirdAgain = buildP3ELifePartner({ ...ctx, first: { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2041 }, latestStatus: "dating", forbiddenNames: [first.displayName, second.displayName] });
    expect(thirdAgain.displayName).toBe(third.displayName);
  });

  it("resolveP3ELifePartner：同一段關係 dating→cohabit→married 姓名不變", () => {
    const ctx = contextFor("gpt-0046-stable");
    const choices: P3EPartnerChoice[] = [
      { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2041 },
      { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "cohabit", year: 2050 },
      { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2052 }
    ];
    const dating = resolveP3ELifePartner({ ...ctx, choices: [choices[0] as P3EPartnerChoice] });
    const married = resolveP3ELifePartner({ ...ctx, choices });
    expect(dating?.status).toBe("dating");
    expect(married?.status).toBe("spouse");
    expect(married?.displayName).toBe(dating?.displayName);
  });

  it("resolveP3ELifePartner：三段關係（date→single→marry→single→marry）姓名皆不同", () => {
    const ctx = contextFor("gpt-0046-three");
    const date = { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2041 };
    const single = { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "single", year: 2050 };
    const marryA = { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2055 };
    const single2 = { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "single", year: 2060 };
    const marryB = { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2065 };
    const r1 = resolveP3ELifePartner({ ...ctx, choices: [date] as P3EPartnerChoice[] });
    const r2 = resolveP3ELifePartner({ ...ctx, choices: [date, single, marryA] as P3EPartnerChoice[] });
    const r3 = resolveP3ELifePartner({ ...ctx, choices: [date, single, marryA, single2, marryB] as P3EPartnerChoice[] });
    expect(r1?.displayName).toBeDefined();
    expect(r2?.displayName).toBeDefined();
    expect(r3?.displayName).toBeDefined();
    expect(r2?.displayName).not.toBe(r1?.displayName);
    expect(r3?.displayName).not.toBe(r1?.displayName);
    expect(r3?.displayName).not.toBe(r2?.displayName);
    // 第二段本身升級時姓名不變：同一段關係 cohabit → marry，姓名相同（滿足「第二位再結婚姓名不變」）。
    const r2base = resolveP3ELifePartner({ ...ctx, choices: [date, single, { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "cohabit", year: 2053 }] as P3EPartnerChoice[] });
    const r2upgraded = resolveP3ELifePartner({ ...ctx, choices: [date, single, { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "cohabit", year: 2053 }, marryA] as P3EPartnerChoice[] });
    expect(r2upgraded?.displayName).toBe(r2base?.displayName);
    expect(r2upgraded?.displayName).not.toBe(r1?.displayName);
  });

  it("多 seed 屬性：兩段關係（date→single→marry）姓名必不同（修法前會有 seed 同名）", () => {
    let collisions = 0;
    const total = 60;
    for (let i = 0; i < total; i += 1) {
      const seed = `gpt-0046-prop-${i}`;
      const ctx = contextFor(seed);
      const date = { eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2041 };
      const single = { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "single", year: 2050 };
      const marry = { eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2055 };
      const first = resolveP3ELifePartner({ ...ctx, choices: [date] as P3EPartnerChoice[] });
      const second = resolveP3ELifePartner({ ...ctx, choices: [date, single, marry] as P3EPartnerChoice[] });
      if (first?.displayName === second?.displayName) collisions += 1;
    }
    expect(collisions).toBe(0);
  });

  it("第一位伴侶→結婚姓名不變（resolveP3ERelationship 整合）", () => {
    const ctx = contextFor("gpt-0046-res-stable");
    const dateFact = fact({ kind: "decision", eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2040, age: 16 });
    const cohabitFact = fact({ kind: "decision", eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "cohabit", year: 2050, age: 26 });
    const marryFact = fact({ kind: "decision", eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2052, age: 28 });
    const dating = resolveP3ERelationship({ ...ctx, facts: [dateFact] });
    const married = resolveP3ERelationship({ ...ctx, facts: [dateFact, cohabitFact, marryFact] });
    expect(dating.partner?.displayName).toBeDefined();
    expect(married.partner?.displayName).toBe(dating.partner?.displayName);
    expect(married.status).toBe("married");
  });

  it("離異→第二位姓名不同（resolveP3ERelationship：formerName 保留、新伴侶不同名）", () => {
    const ctx = contextFor("gpt-0046-divorce");
    const dateFact = fact({ kind: "decision", eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2040, age: 16 });
    const cohabitFact = fact({ kind: "decision", eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "cohabit", year: 2050, age: 26 });
    const marryFact = fact({ kind: "decision", eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2052, age: 28 });
    const divorceFact = fact({ kind: "decision", eventId: "ev.adult.marital-breakup", decisionId: "dec.adult.marital-breakup", optionId: "divorce", year: 2058, age: 34 });
    const newDateFact = fact({ kind: "decision", eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2061, age: 37 });
    const divorced = resolveP3ERelationship({ ...ctx, facts: [dateFact, cohabitFact, marryFact, divorceFact] });
    expect(divorced.status).toBe("divorced");
    expect(divorced.partner).toBeNull();
    const formerName = divorced.formerName;
    expect(formerName).not.toBeNull();
    const newRel = resolveP3ERelationship({ ...ctx, facts: [dateFact, cohabitFact, marryFact, divorceFact, newDateFact] });
    expect(newRel.status).toBe("dating");
    expect(newRel.partner).not.toBeNull();
    expect(newRel.partner?.displayName).not.toBe(formerName);
  });

  it("喪偶→第二位姓名不同（resolveP3ERelationship：widowed 保留前任、新伴侶不同名）", () => {
    const ctx = contextFor("gpt-0046-widow");
    const dateFact = fact({ kind: "decision", eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2040, age: 16 });
    const cohabitFact = fact({ kind: "decision", eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "cohabit", year: 2050, age: 26 });
    const marryFact = fact({ kind: "decision", eventId: "ev.adult.relationship", decisionId: "dec.adult.relationship", optionId: "marry", year: 2052, age: 28 });
    const lossFact = fact({ kind: "event", eventId: "ev.adult.partner-loss", year: 2058, age: 34 });
    const newDateFact = fact({ kind: "decision", eventId: "ev.teen.first-love", decisionId: "dec.teen.first-love", optionId: "date", year: 2061, age: 37 });
    const widowed = resolveP3ERelationship({ ...ctx, facts: [dateFact, cohabitFact, marryFact, lossFact] });
    expect(widowed.status).toBe("widowed");
    expect(widowed.partner).toBeNull();
    const formerName = widowed.formerName;
    expect(formerName).not.toBeNull();
    const newRel = resolveP3ERelationship({ ...ctx, facts: [dateFact, cohabitFact, marryFact, lossFact, newDateFact] });
    expect(newRel.status).toBe("dating");
    expect(newRel.partner).not.toBeNull();
    expect(newRel.partner?.displayName).not.toBe(formerName);
  });
});

describe("GPT-0046-B 整合：save/load/replay 與 UI 狀態卡", () => {
  it("date→single→date：新伴侶姓名不同，且 save/load/replay 後完全一致（bit-exact）", () => {
    const seed = "gpt-0046-session";
    const first = chooseOption(playUntilDecision(sessionFor(seed), "dec.teen.first-love", "date"), "date");
    const firstName = first.view.partner?.displayName;
    expect(firstName).toBeDefined();

    const brokeUp = chooseOption(playUntilDecision(first, "dec.adult.relationship", "single"), "single");
    expect(brokeUp.view.partner).toBeNull();

    // 第二個關係：成年人後 `dec.teen.first-love`（僅青少年期）不再提供，
    // 必須經由 `dec.adult.relationship`（cohabit/marry）建立新伴侶，且姓名不同於前任。
    const second = chooseOption(playUntilDecision(brokeUp, "dec.adult.relationship", "cohabit"), "cohabit");
    const secondName = second.view.partner?.displayName;
    expect(secondName).toBeDefined();
    expect(secondName).not.toBe(firstName); // 不同關係必須不同姓名

    const restored = restore(second, seed, relationshipPack);
    expect(restored.view.partner?.displayName).toBe(secondName); // replay 後相同
    expect(JSON.stringify(restored.view.partner)).toBe(JSON.stringify(second.view.partner));
    expect(restored.state.stateHash).toBe(second.state.stateHash);
  });

  it("UI 狀態卡顯示最新姓名，且與 view.partner 一致（不顯示前任姓名）", () => {
    // 選用經掃描確認可活到成年並經歷多段關係的種子（原 gpt-0046-ui-card 在稀疏事件包下 18 歲早逝）。
    const seed = "gpt-0046-scan-2";
    const first = chooseOption(playUntilDecision(sessionFor(seed), "dec.teen.first-love", "date"), "date");
    const firstName = first.view.partner?.displayName as string;
    const brokeUp = chooseOption(playUntilDecision(first, "dec.adult.relationship", "single"), "single");
    const second = chooseOption(playUntilDecision(brokeUp, "dec.adult.relationship", "cohabit"), "cohabit");
    const secondName = second.view.partner?.displayName as string;

    expect(second.view.profile.relationship.personName).toBe(secondName);
    expect(second.view.profile.relationship.personName).not.toBe(firstName);
    expect(second.view.profile.relationship.personName).toBe(second.view.partner?.displayName);
    expect(second.view.profile.relationship.status).toBe("dating");
  });

  it("離異→再交往（正式事件包）：新伴侶姓名不同、save/load/replay 一致", () => {
    const seed = "gpt-0046-divorce-session";
    const dating1 = chooseOption(playUntilDecision(sessionFor(seed, divorceWidowPack), "dec.teen.first-love", "date"), "date");
    const name1 = dating1.view.partner?.displayName as string;
    // 推進到結婚
    let married = dating1;
    married = chooseOption(playUntilDecision(married, "dec.adult.relationship", "cohabit"), "cohabit");
    married = chooseOption(playUntilDecision(married, "dec.adult.relationship", "marry"), "marry");
    expect(married.view.partner?.displayName).toBe(name1);
    // 離異
    const afterDivorce = chooseOption(playUntilDecision(married, "dec.adult.marital-breakup", "divorce"), "divorce");
    expect(afterDivorce.view.partner).toBeNull();
    expect(afterDivorce.view.profile.relationship.status).toBe("divorced");
    // 再交往：成年人後經由 `dec.adult.relationship`（cohabit）建立新伴侶，姓名不同於前任。
    const again = chooseOption(playUntilDecision(afterDivorce, "dec.adult.relationship", "cohabit"), "cohabit");
    const name2 = again.view.partner?.displayName as string;
    expect(name2).not.toBe(name1);

    const restored = restore(again, seed, divorceWidowPack);
    expect(restored.view.partner?.displayName).toBe(name2);
    expect(restored.state.stateHash).toBe(again.state.stateHash);
  });
});
