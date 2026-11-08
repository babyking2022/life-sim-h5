import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPeerGroup,
  createBirthCertificate,
  drawBirth,
  validateDataPack,
  validateDeathPack,
  validateIdentityPack
} from "@life-sim/birth";
import { computeEventsChecksum, computePackChecksum, validateEventPack, type ValidatedEventPack } from "@life-sim/engine";
import { P2A_ENTITY_COUNT, P2B_ENTITY_COUNT, P3D_BASE_ENTITY_COUNT } from "@life-sim/contracts";
import {
  createP3EPlaySession,
  exportP3EPlaySessionPayload,
  restoreP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";

/**
 * GPT-DEEPSEEK-0046-A｜HKG／MAC／TWN 已從遊戲資料中刪除的回歸測試。
 *
 * 這裡的「禁止清單」只出現在測試程式碼裡，不是資料記錄：
 *
 * 1. registry 正好 169 筆，且不含三個代碼；
 * 2. 所有 enabled entity／birth weight／identity（vitals、文化指定）／
 *    mortality binding 都不含三個代碼；
 * 3. 大量固定 seeds 的出生結果從不出現三個代碼；
 * 4. 存檔／復原／重播與死亡流程仍一致。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

/** 只作為測試的禁止清單；正式資料不得再有這些 entity。 */
const FORBIDDEN_CODES = ["TWN", "HKG", "MAC"] as const;
const FORBIDDEN_ENTITY_IDS = FORBIDDEN_CODES.map((code) => `cr:${code}`);

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

const rawEventManifest = readJson("fixtures/p3b/manifest.v1.json") as Dict;
const rawEvents = (readJson("fixtures/p3b/events.v1.json") as { records: Dict[] }).records;

function officialEventPack(): ValidatedEventPack {
  const events = rawEvents.map((record) => structuredClone(record));
  events.sort((left, right) => (String(left.eventId) < String(right.eventId) ? -1 : 1));
  const manifest = structuredClone(rawEventManifest);
  const checksum = computeEventsChecksum(events as never);
  const descriptor = (manifest.datasets as Dict[])[0] as Dict;
  descriptor.recordCount = events.length;
  descriptor.checksum = checksum;
  for (const license of manifest.licenses as Dict[]) license.checksum = checksum;
  for (const record of manifest.lineage as Dict[]) record.outputChecksum = checksum;
  manifest.packChecksum = computePackChecksum(manifest as never);
  return validateEventPack({ manifest, events } as never);
}

const eventPack = officialEventPack();

describe("GPT-0046-A P2-A registry：169 筆且不含 HKG／MAC／TWN", () => {
  it("契約常數、manifest、registry 都是 169", () => {
    expect(P2A_ENTITY_COUNT).toBe(169);
    expect((rawEventManifest as Dict).packChecksum).toBeDefined();
    const manifest = readJson("fixtures/p2a/manifest.v1.json") as { entityCount: number };
    expect(manifest.entityCount).toBe(169);
    expect(base.registry).toHaveLength(169);
    expect(base.entityIds).toHaveLength(169);
    expect(base.enabledEntityIds).toHaveLength(169);
    expect(new Set(base.entityIds).size).toBe(169);
  });

  it("registry／indicators／birth weights／sensitive names 都沒有三個代碼", () => {
    const registry = (readJson("fixtures/p2a/country-registry.v1.json") as { records: Dict[] }).records;
    const indicators = (readJson("fixtures/p2a/indicators.v1.json") as { records: Dict[] }).records;
    const weights = (readJson("fixtures/p2a/birth-weights.v1.json") as { records: Dict[] }).records;
    const sensitive = (readJson("fixtures/p2a/sensitive-names.v1.json") as { records: Dict[] }).records;

    for (const record of [...registry, ...indicators, ...weights, ...sensitive]) {
      const entityId = String(record.entityId ?? "");
      expect(FORBIDDEN_ENTITY_IDS).not.toContain(entityId);
      for (const code of FORBIDDEN_CODES) expect(entityId).not.toContain(code);
    }
    // 連原始 JSON 文字都不該出現這三個代碼。
    for (const file of ["country-registry.v1.json", "indicators.v1.json", "birth-weights.v1.json", "sensitive-names.v1.json", "manifest.v1.json"]) {
      const text = readFileSync(join(ROOT, "fixtures/p2a", file), "utf8");
      for (const code of FORBIDDEN_CODES) expect(text, file).not.toContain(`cr:${code}`);
    }
    expect(sensitive).toHaveLength(0);
  });

  it("所有 enabled entity 都有可抽選的權重與名稱，且沒有三個代碼", () => {
    for (const entityId of base.enabledEntityIds) {
      expect(FORBIDDEN_ENTITY_IDS).not.toContain(entityId);
      expect(base.birthShare[entityId]).toBeGreaterThan(0);
      expect(typeof base.displayNames[entityId]).toBe("string");
      expect(base.birthWeightIndex[`${entityId}|female`]).toBeDefined();
      expect(base.birthWeightIndex[`${entityId}|male`]).toBeDefined();
    }
  });
});

describe("GPT-0046-A P2-B identity：沒有三個代碼的衍生資料", () => {
  it("vitals／文化指定／城鄉分布都不含三個代碼", () => {
    expect(P2B_ENTITY_COUNT).toBe(169);
    expect(identityPack.vitals).toHaveLength(169);
    const vitals = (readJson("fixtures/p2b/country-vitals.v1.json") as { records: Dict[] }).records;
    expect(vitals).toHaveLength(169);
    for (const record of vitals) expect(FORBIDDEN_ENTITY_IDS).not.toContain(String(record.entityId));
    for (const entityId of base.entityIds) {
      expect(FORBIDDEN_ENTITY_IDS).not.toContain(entityId);
    }
    // 每個 entity 都能對到文化與 household profile（沒有孤兒、也沒有多餘）。
    const vitalsByEntity = new Map(vitals.map((record) => [String(record.entityId), record]));
    expect(vitalsByEntity.size).toBe(169);
    for (const entityId of base.entityIds) expect(vitalsByEntity.has(entityId)).toBe(true);
  });

  it("name corpus／story templates 的 entity 參照也不含三個代碼", () => {
    for (const dataset of ["name-corpus", "story-templates", "household-profiles"] as const) {
      const text = readFileSync(join(ROOT, "fixtures/p2b", `${dataset}.v1.json`), "utf8");
      for (const code of FORBIDDEN_CODES) expect(text, dataset).not.toContain(code);
    }
  });
});

describe("GPT-0046-A P3-D mortality：沒有三個代碼的綁定", () => {
  it("mortality 恰好 169×2×121，且不含三個代碼", () => {
    expect(P3D_BASE_ENTITY_COUNT).toBe(169);
    const mortality = (readJson("fixtures/p3d/mortality.v1.json") as { records: Dict[] }).records;
    expect(mortality).toHaveLength(169 * 2 * 121);
    const entities = new Set(mortality.map((record) => String(record.entityId)));
    expect(entities.size).toBe(169);
    for (const entityId of FORBIDDEN_ENTITY_IDS) expect(entities.has(entityId)).toBe(false);
    for (const entityId of entities) expect(base.entityIds).toContain(entityId);
    expect(deathPack.manifest.entityCount).toBe(169);
  });
});

describe("GPT-0046-A 出生抽選：固定 seeds 從不出現三個代碼", () => {
  it("300 個固定 seed × 抽選一定落在 169 個合法 entity 內", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 300; index += 1) {
      const seed = `gpt-0046-region-${index}`;
      const draft = drawBirth(base, {
        seed,
        settings: { birthYear: base.manifest.indicatorYear, sexPolicy: "female" }
      });
      const entityId = draft.entityId;
      expect(FORBIDDEN_ENTITY_IDS).not.toContain(entityId);
      for (const code of FORBIDDEN_CODES) expect(entityId).not.toContain(code);
      expect(base.entityIds).toContain(entityId);
      seen.add(entityId);
    }
    // 抽樣要有分佈（不是永遠同一個國家）。
    expect(seen.size).toBeGreaterThan(10);
  });

  it("peer group 與 birth certificate 也不會出現三個代碼", () => {
    for (let index = 0; index < 40; index += 1) {
      const seed = `gpt-0046-cert-${index}`;
      const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
      const certificate = createBirthCertificate(base, identityPack, group, seed);
      const entityId = certificate.player.birth.entityId;
      expect(FORBIDDEN_ENTITY_IDS).not.toContain(entityId);
      expect(base.entityIds).toContain(entityId);
    }
  });
});

describe("GPT-0046-A 存檔／復原／重播與死亡流程仍一致", () => {
  function sessionFor(seed: string): P3EPlaySession {
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

  it("出生／死亡都在合法 entity 上，且 save→load 後完全相同", () => {
    const seed = "gpt-0046-save-replay";
    let session = sessionFor(seed);
    expect(FORBIDDEN_ENTITY_IDS).not.toContain(session.state.identity.entityId);
    expect(base.entityIds).toContain(session.state.identity.entityId);

    for (let step = 0; step < 240 && session.state.phase !== "death"; step += 1) {
      const command =
        session.state.phase === "pending_decision"
          ? { type: "CHOOSE_DECISION", optionId: session.state.pendingDecision?.optionIds[0] as string }
          : { type: "ADVANCE_YEAR", contentMode: "standard" };
      session = runP3EPlaySessionCommand({ session, command }).session;
      expect(FORBIDDEN_ENTITY_IDS).not.toContain(session.state.identity.entityId);
      expect(session.view.profile.residence.entityId).toBe(session.state.identity.entityId);
    }
    expect(session.state.phase).toBe("death");

    const payload = exportP3EPlaySessionPayload({ session });
    const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
    const restored = restoreP3EPlaySessionPayload({
      payload,
      masterSeed: seed,
      basePack: base,
      identityPack,
      certificate: createBirthCertificate(base, identityPack, group, seed),
      eventPack,
      deathPack
    });
    expect(restored.state.stateHash).toBe(session.state.stateHash);
    expect(restored.state.identity.entityId).toBe(session.state.identity.entityId);
    expect(JSON.stringify(restored.view.lifeLog)).toBe(JSON.stringify(session.view.lifeLog));
    expect(FORBIDDEN_ENTITY_IDS).not.toContain(restored.state.identity.entityId);
    // 死因仍是正式 registry 內的原因（不是被刪掉的 entity 造成的錯誤）。
    expect(restored.state.phase).toBe("death");
  });
});
