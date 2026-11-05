import { describe, expect, it } from "vitest";
import type { P3BEventPackManifest, P3BEventRecord } from "@life-sim/contracts";
import { clone, codeOf, datasetOf, licenseOf, lineageOf, loadRawPack, makePack, pathOf, validate } from "./p3b-helpers";
import { computeEventsChecksum, computePackChecksum, isValidatedEventPack, validateEventPack } from "../src/life/events";

/**
 * P3-B schema／validator 反例。
 * 所有失敗都必須是固定 `E_P3B_*` 錯誤碼（不得出現 native TypeError 或原型鏈問題）。
 */

const raw = loadRawPack();

/** 以字串鍵寫入（避免 TS 把 `constructor` 當成 Function 成員）。 */
function setKey(target: unknown, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

describe("P3-B validator：合法 pack", () => {
  it("accepts the generated pack and brands it", () => {
    const pack = validate(raw);
    expect(isValidatedEventPack(pack)).toBe(true);
    expect(pack.events).toHaveLength(raw.events.length);
    expect(pack.manifest.packChecksum).toBe(raw.manifest.packChecksum);
    const first = pack.events[0] as P3BEventRecord;
    const last = pack.events[pack.events.length - 1] as P3BEventRecord;
    expect(first.eventId <= last.eventId).toBe(true);
  });

  it("does not treat an unvalidated object as a validated pack", () => {
    expect(isValidatedEventPack({ manifest: raw.manifest, events: raw.events })).toBe(false);
    expect(isValidatedEventPack(null)).toBe(false);
  });
});

describe("P3-B validator：形狀與欄位", () => {
  it("rejects unknown top-level keys", () => {
    const pack = clone({ manifest: raw.manifest, events: raw.events }) as Record<string, unknown>;
    pack.extra = 1;
    expect(codeOf(() => validateEventPack(pack))).toBe("E_P3B_UNKNOWN_KEY");
    expect(pathOf(() => validateEventPack(pack))).toBe("pack.extra");
  });

  it("rejects a missing manifest key", () => {
    const pack = clone({ manifest: raw.manifest, events: raw.events });
    delete (pack.manifest as unknown as Record<string, unknown>).contentPackVersion;
    expect(codeOf(() => validateEventPack(pack))).toBe("E_P3B_MISSING_KEY");
  });

  it("rejects unknown event keys and missing event keys", () => {
    const events = clone(raw.events);
    (events[0] as unknown as Record<string, unknown>).somethingNew = true;
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_UNKNOWN_KEY");

    const events2 = clone(raw.events);
    delete (events2[0] as unknown as Record<string, unknown>).weight;
    expect(codeOf(() => validate(makePack(events2)))).toBe("E_P3B_MISSING_KEY");
  });

  it("rejects wrong primitive types without native errors", () => {
    const events = clone(raw.events);
    (events[0] as unknown as Record<string, unknown>).weight = "30";
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_TYPE");

    const events2 = clone(raw.events);
    (events2[0] as unknown as Record<string, unknown>).ageMin = 1.5;
    expect(codeOf(() => validate(makePack(events2)))).toBe("E_P3B_TYPE");

    const events3 = clone(raw.events);
    (events3[0] as unknown as Record<string, unknown>).lifeStages = "childhood";
    expect(codeOf(() => validate(makePack(events3)))).toBe("E_P3B_TYPE");
  });

  it("rejects enums, patterns and ranges", () => {
    const badKind = clone(raw.events);
    (badKind[0] as unknown as Record<string, unknown>).kind = "special";
    expect(codeOf(() => validate(makePack(badKind)))).toBe("E_P3B_ENUM");

    const badMode = clone(raw.events);
    (badMode[0] as unknown as Record<string, unknown>).contentMode = "teen";
    expect(codeOf(() => validate(makePack(badMode)))).toBe("E_P3B_ENUM");

    const badId = clone(raw.events);
    (badId[0] as unknown as Record<string, unknown>).eventId = "EV.BAD";
    expect(codeOf(() => validate(makePack(badId)))).toBe("E_P3B_PATTERN");

    const badRange = clone(raw.events);
    (badRange[0] as unknown as Record<string, unknown>).ageMin = 30;
    (badRange[0] as unknown as Record<string, unknown>).ageMax = 10;
    expect(codeOf(() => validate(makePack(badRange)))).toBe("E_P3B_RANGE");

    const badWeight = clone(raw.events);
    (badWeight[0] as unknown as Record<string, unknown>).weight = 0;
    expect(codeOf(() => validate(makePack(badWeight)))).toBe("E_P3B_RANGE");

    const hugeWeight = clone(raw.events);
    (hugeWeight[0] as unknown as Record<string, unknown>).weight = Number.MAX_SAFE_INTEGER + 1;
    expect(codeOf(() => validate(makePack(hugeWeight)))).toBe("E_P3B_RANGE");

    const badStage = clone(raw.events);
    (badStage[0] as unknown as Record<string, unknown>).lifeStages = ["childhood", "childhood"];
    expect(codeOf(() => validate(makePack(badStage)))).toBe("E_P3B_DUPLICATE_ID");
  });

  it("rejects localization copy instead of a key", () => {
    const events = clone(raw.events);
    (events[0] as unknown as Record<string, unknown>).localizationKey = "你在遊樂場交到了新朋友";
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_PATTERN");
  });
});

describe("P3-B validator：版本", () => {
  it("rejects unknown schema / spec / engine / rng versions", () => {
    const bad = (patch: (manifest: P3BEventPackManifest) => void) => {
      const pack = clone({ manifest: raw.manifest, events: raw.events });
      patch(pack.manifest as unknown as P3BEventPackManifest);
      return codeOf(() => validateEventPack(pack));
    };
    expect(bad((manifest) => ((manifest as unknown as Record<string, unknown>).schemaVersion = "p3b-9"))).toBe("E_P3B_VERSIONS");
    expect(bad((manifest) => ((manifest as unknown as Record<string, unknown>).eventSpecVersion = "9.9.9"))).toBe("E_P3B_VERSIONS");
    expect(bad((manifest) => ((manifest as unknown as Record<string, unknown>).engineVersion = "9.9.9"))).toBe("E_P3B_VERSIONS");
    expect(bad((manifest) => ((manifest as unknown as Record<string, unknown>).rngSpecVersion = "2.0.0"))).toBe("E_P3B_VERSIONS");
  });

  it("rejects an event carrying a different contentPackVersion", () => {
    const events = clone(raw.events);
    (events[0] as unknown as Record<string, unknown>).contentPackVersion = "2.0.0";
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_VERSIONS");
  });
});

describe("P3-B validator：重複與 checksum", () => {
  it("rejects duplicate eventId and decisionId", () => {
    const events = clone(raw.events);
    (events[1] as unknown as Record<string, unknown>).eventId = (events[0] as P3BEventRecord).eventId;
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_DUPLICATE_ID");

    const dupDecision = clone(raw.events) as P3BEventRecord[];
    const decisionEvents = dupDecision.filter((event) => event.decision !== null);
    const source = decisionEvents[0] as P3BEventRecord;
    dupDecision.push({ ...clone(source), eventId: "ev.dup.decision" });
    expect(codeOf(() => validate(makePack(dupDecision)))).toBe("E_P3B_DUPLICATE_ID");
  });

  it("rejects dataset / license / lineage / pack checksum mismatches", () => {
    const datasetMismatch = makePack(raw.events, (manifest) => ({
      ...manifest,
      datasets: [{ ...datasetOf(manifest), checksum: "a".repeat(64) }]
    }));
    expect(codeOf(() => validate(datasetMismatch))).toBe("E_P3B_CHECKSUM");

    const licenseMismatch = makePack(raw.events, (manifest) => ({
      ...manifest,
      licenses: [{ ...licenseOf(manifest), checksum: "b".repeat(64) }]
    }));
    expect(codeOf(() => validate(licenseMismatch))).toBe("E_P3B_CHECKSUM");

    const lineageMismatch = makePack(raw.events, (manifest) => ({
      ...manifest,
      lineage: [{ ...lineageOf(manifest), outputChecksum: "c".repeat(64) }]
    }));
    expect(codeOf(() => validate(lineageMismatch))).toBe("E_P3B_LINEAGE");

    const recordCountMismatch = makePack(raw.events, (manifest) => ({
      ...manifest,
      datasets: [{ ...datasetOf(manifest), recordCount: datasetOf(manifest).recordCount + 1 }]
    }));
    expect(codeOf(() => validate(recordCountMismatch))).toBe("E_P3B_CHECKSUM");

    const packMismatch = makePack(raw.events);
    const tampered = clone(packMismatch) as unknown as Record<string, unknown>;
    (tampered.manifest as Record<string, unknown>).packChecksum = "d".repeat(64);
    expect(codeOf(() => validateEventPack(tampered))).toBe("E_P3B_CHECKSUM");
  });

  it("recomputes the same checksums as the generator", () => {
    const sorted = [...raw.events].sort((left, right) => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0));
    expect(computeEventsChecksum(sorted)).toBe(datasetOf(raw.manifest).checksum);
    expect(computePackChecksum(raw.manifest)).toBe(raw.manifest.packChecksum);
  });
});

describe("P3-B validator：授權與 lineage", () => {
  it("rejects every license gate failure", () => {
    const withLicense = (patch: (license: Record<string, unknown>) => void) =>
      makePack(raw.events, (manifest) => {
        const license = clone(manifest.licenses[0]) as unknown as Record<string, unknown>;
        patch(license);
        return { ...manifest, licenses: [license as unknown as P3BEventPackManifest["licenses"][number]] };
      });

    expect(codeOf(() => validate(withLicense((license) => (license.license = "unknown"))))).toBe("E_P3B_LICENSE");
    expect(codeOf(() => validate(withLicense((license) => (license.license = "not_allowed"))))).toBe("E_P3B_LICENSE");
    expect(codeOf(() => validate(withLicense((license) => (license.legalStatus = "pending"))))).toBe("E_P3B_LICENSE");
    expect(codeOf(() => validate(withLicense((license) => (license.commercialUse = "unknown"))))).toBe("E_P3B_LICENSE");
    expect(codeOf(() => validate(withLicense((license) => (license.evidence = []))))).toBe("E_P3B_LICENSE");
    expect(codeOf(() => validate(withLicense((license) => (license.licenseId = null))))).toBe("E_P3B_LICENSE");
    expect(codeOf(() => validate(withLicense((license) => (license.sourceKind = "official"))))).toBe("E_P3B_SOURCE");
    expect(codeOf(() => validate(withLicense((license) => (license.license = "permission_required"))))).toBe("E_P3B_LICENSE");
  });

  it("accepts permission_required with a granted grant", () => {
    const pack = makePack(raw.events, (manifest) => {
      const license = clone(licenseOf(manifest));
      const next: P3BEventPackManifest["licenses"][number] = {
        ...license,
        license: "permission_required",
        grant: { granted: true, evidence: "written permission on file", grantedAt: "2026-10-27" }
      };
      return { ...manifest, licenses: [next] };
    });
    expect(validate(pack).events.length).toBeGreaterThan(0);
  });

  it("rejects an event whose sourceId has no license", () => {
    const events = clone(raw.events);
    (events[0] as unknown as Record<string, unknown>).sourceId = "unknown-source";
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_SOURCE");
  });

  it("rejects missing lineage parents and duplicate lineage ids", () => {
    const missingParent = makePack(raw.events, (manifest) => ({
      ...manifest,
      lineage: [{ ...lineageOf(manifest), parentLineageIds: ["lin.nope"], inputChecksums: ["e".repeat(64)] }]
    }));
    expect(codeOf(() => validate(missingParent))).toBe("E_P3B_LINEAGE");

    const dupLineage = makePack(raw.events, (manifest) => ({
      ...manifest,
      lineage: [lineageOf(manifest), clone(lineageOf(manifest))]
    }));
    expect(codeOf(() => validate(dupLineage))).toBe("E_P3B_DUPLICATE_ID");
  });
});

describe("P3-B validator：kind 與 decision 一致性", () => {
  it("rejects a decision kind without a decision spec and vice versa", () => {
    const events = clone(raw.events);
    const decisionEvent = events.find((event) => event.kind === "decision") as P3BEventRecord;
    (decisionEvent as unknown as Record<string, unknown>).decision = null;
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_DECISION");

    const spec = clone(raw.events.find((event) => event.kind === "decision")?.decision);
    const events2 = clone(raw.events);
    const ordinary = events2.find((event) => event.kind === "ordinary") as P3BEventRecord;
    (ordinary as unknown as Record<string, unknown>).decision = spec;
    (ordinary as unknown as Record<string, unknown>).effects = [{ type: "openDecision", decisionId: (spec as { decisionId: string }).decisionId }];
    expect(codeOf(() => validate(makePack(events2)))).toBe("E_P3B_DECISION");
  });

  it("rejects a decision whose openDecision id differs", () => {
    const events = clone(raw.events);
    const decisionEvent = events.find((event) => event.kind === "decision") as P3BEventRecord;
    (decisionEvent.effects[0] as unknown as Record<string, unknown>).decisionId = "dec.other";
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_DECISION");
  });

  it("rejects duplicate option ids", () => {
    const events = clone(raw.events);
    const decisionEvent = events.find((event) => event.kind === "decision") as P3BEventRecord;
    const options = decisionEvent.decision?.options as unknown as { optionId: string }[];
    (options[1] as { optionId: string }).optionId = (options[0] as { optionId: string }).optionId;
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_DUPLICATE_ID");
  });
});

describe("P3-B validator：prototype pollution", () => {
  it("rejects __proto__ / constructor / prototype keys at every level", () => {
    // 真正的自有 __proto__ 屬性只能從 JSON 文字進來（`obj.__proto__ = x` 會改原型而不是加鍵）。
    const atPack = JSON.parse(`{"manifest":${JSON.stringify(raw.manifest)},"events":${JSON.stringify(raw.events)},"__proto__":{"polluted":true}}`) as Record<string, unknown>;
    expect(Object.getPrototypeOf(atPack)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(atPack, "__proto__")).toBe(true);
    expect(codeOf(() => validateEventPack(atPack))).toBe("E_P3B_PROTOTYPE_KEY");

    const atManifest = clone({ manifest: raw.manifest, events: raw.events });
    setKey(atManifest.manifest, "constructor", { polluted: true });
    expect(codeOf(() => validateEventPack(atManifest))).toBe("E_P3B_PROTOTYPE_KEY");

    const atEvent = clone(raw.events);
    setKey(atEvent[0], "prototype", { polluted: true });
    expect(codeOf(() => validate(makePack(atEvent)))).toBe("E_P3B_PROTOTYPE_KEY");

    const atCondition = clone(raw.events);
    const withCondition = atCondition.find((event) => event.conditions !== null) as P3BEventRecord;
    const conditionText = JSON.stringify(withCondition.conditions).replace(/^\{/, `{"__proto__":{"op":"age","min":0,"max":1},`);
    setKey(withCondition, "conditions", JSON.parse(conditionText));
    expect(codeOf(() => validate(makePack(atCondition)))).toBe("E_P3B_PROTOTYPE_KEY");

    const atEffect = clone(raw.events);
    setKey((atEffect[0] as P3BEventRecord).effects[0], "constructor", {});
    expect(codeOf(() => validate(makePack(atEffect)))).toBe("E_P3B_PROTOTYPE_KEY");

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects a record whose prototype is not Object.prototype", () => {
    const evil = Object.create({ inherited: true }) as Record<string, unknown>;
    evil.manifest = raw.manifest;
    evil.events = raw.events;
    expect(codeOf(() => validateEventPack(evil))).toBe("E_P3B_TYPE");
  });
});

describe("P3-B validator：深度與容量", () => {
  it("rejects conditions deeper than the limit", () => {
    const events = clone(raw.events);
    const target = events.find((event) => event.eventId === "ev.any.small-win") as P3BEventRecord;
    let node: Record<string, unknown> = { op: "age", min: 0, max: 120 };
    for (let depth = 0; depth < 9; depth += 1) node = { op: "not", condition: node };
    (target as unknown as Record<string, unknown>).conditions = node;
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_CONDITION_DEPTH");
  });

  it("rejects a condition node count above the limit", () => {
    const events = clone(raw.events);
    const target = events.find((event) => event.eventId === "ev.any.small-win") as P3BEventRecord;
    const leaves = Array.from({ length: 70 }, () => ({ op: "age", min: 0, max: 120 }));
    (target as unknown as Record<string, unknown>).conditions = { op: "all", conditions: leaves };
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_CONDITION_SIZE");
  });

  it("rejects unknown condition operators and unknown fields", () => {
    const events = clone(raw.events);
    const target = events.find((event) => event.eventId === "ev.any.small-win") as P3BEventRecord;
    (target as unknown as Record<string, unknown>).conditions = { op: "regex", pattern: ".*" };
    expect(codeOf(() => validate(makePack(events)))).toBe("E_P3B_CONDITION_OP");

    const events2 = clone(raw.events);
    const target2 = events2.find((event) => event.eventId === "ev.any.small-win") as P3BEventRecord;
    (target2 as unknown as Record<string, unknown>).conditions = { op: "age", min: 0, max: 120, script: "x" };
    expect(codeOf(() => validate(makePack(events2)))).toBe("E_P3B_UNKNOWN_KEY");
  });

  it("rejects too many events", () => {
    const many: P3BEventRecord[] = [];
    for (let index = 0; index < 4097; index += 1) {
      const copy = clone(raw.events[0] as P3BEventRecord);
      many.push({ ...copy, eventId: `ev.bulk.${index}` });
    }
    expect(codeOf(() => validate(makePack(many)))).toBe("E_P3B_RANGE");
  });
});

describe("P3-B validator：不可變性", () => {
  it("deep-freezes the validated snapshot", () => {
    const pack = validate(raw);
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.events)).toBe(true);
    expect(Object.isFrozen(pack.events[0])).toBe(true);
    expect(() => {
      (pack.events[0] as unknown as Record<string, unknown>).weight = 1;
    }).toThrow();
    expect(pack.events[0]?.weight).not.toBe(1);
  });

  it("ignores later mutation of the original input", () => {
    const source = clone({ manifest: raw.manifest, events: raw.events });
    const pack = validateEventPack(source);
    const before = JSON.stringify(pack.events);
    (source.events[0] as unknown as Record<string, unknown>).weight = 999;
    (source.manifest.licenses[0] as unknown as Record<string, unknown>).notes = "tampered";
    (source.events as unknown as unknown[]).push({ ...source.events[0] });
    expect(JSON.stringify(pack.events)).toBe(before);
    expect(licenseOf(pack.manifest).notes).not.toBe("tampered");
    expect(pack.events).toHaveLength(raw.events.length);
  });

  it("is independent of the input record order", () => {
    const reversed = clone({ manifest: raw.manifest, events: [...raw.events].reverse() });
    const a = validateEventPack(clone({ manifest: raw.manifest, events: raw.events }));
    const b = validateEventPack(reversed);
    expect(b.events.map((event) => event.eventId)).toEqual(a.events.map((event) => event.eventId));
    expect(b.datasetChecksum).toBe(a.datasetChecksum);
    expect(b.packChecksum).toBe(a.packChecksum);
  });
});
