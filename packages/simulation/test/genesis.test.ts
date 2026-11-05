import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPeerGroup,
  computePackChecksum,
  createBirthCertificate,
  validateDataPack,
  validateDeathPack,
  validateIdentityPack,
  type ValidatedDataPack,
  type ValidatedDeathPack
} from "@life-sim/birth";
import { bindEventPack, MoneyError, RngError, validateEventPack, type ValidatedEventPack } from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { assertP3EDeathBinding, createP3EGenesis, sealP3EState } from "../src/genesis";
import { createP3EGenesisRng } from "../src/rng";
import { readP3EState } from "../src/state-invariants";
import { computeP3EStateHash, createP3EGenesisIntegrity } from "../src/state-hash";
// 測試專用：只有測試需要用「權威 checksum 重算」造出「合法但綁錯 base」的死亡包。
// production 程式碼不會碰任何套件內部路徑（P3-E 架構隔離只掃 packages/*/src）。
import { computeDeathPackChecksum } from "../../birth/src/death/pack";

/**
 * P3-E.1a-2c-3a：Genesis 建立器與內部 seal。
 *
 * fixture 全部用**真實的** P2-A／P2-B／P3-B／P3-D 驗證器產生（品牌物件），
 * 期待值用 engine／contracts 的公開原語獨立重算。
 */

const HEX = (char: string) => char.repeat(64);
const SEED = "p3e-2c-3a-genesis";
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

const readJson = (relativePath: string): unknown => JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));

/* ------------------------------------------------------------------ */
/* 真實 fixtures                                                       */
/* ------------------------------------------------------------------ */

const baseManifest = readJson("fixtures/p2a/manifest.v1.json") as Dict;
const baseDatasets = {
  "country-registry": readJson("fixtures/p2a/country-registry.v1.json"),
  indicators: readJson("fixtures/p2a/indicators.v1.json"),
  "birth-weights": readJson("fixtures/p2a/birth-weights.v1.json"),
  "sensitive-names": readJson("fixtures/p2a/sensitive-names.v1.json"),
  licenses: readJson("fixtures/p2a/licenses.v1.json"),
  lineage: readJson("fixtures/p2a/lineage.v1.json")
};

const buildBase = (manifest: Dict): ValidatedDataPack =>
  validateDataPack({ manifest, datasets: baseDatasets } as never);

const base = buildBase(baseManifest);

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

const eventPack: ValidatedEventPack = validateEventPack({
  manifest: readJson("fixtures/p3b/manifest.v1.json"),
  events: (readJson("fixtures/p3b/events.v1.json") as { records: unknown[] }).records
} as never);

const deathManifest = readJson("fixtures/p3d/manifest.v1.json") as Dict;
const deathDatasets = {
  "cause-registry": readJson("fixtures/p3d/cause-registry.v1.json"),
  "cause-weights": readJson("fixtures/p3d/cause-weights.v1.json"),
  mortality: readJson("fixtures/p3d/mortality.v1.json"),
  licenses: readJson("fixtures/p3d/licenses.v1.json"),
  lineage: readJson("fixtures/p3d/lineage.v1.json")
};

const buildDeathPack = (manifest: Dict, target: ValidatedDataPack): ValidatedDeathPack =>
  validateDeathPack({ manifest, datasets: deathDatasets } as never, target);

const deathPack = buildDeathPack(deathManifest, base);

const certificateOf = (seed: string) => {
  const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
  return createBirthCertificate(base, identityPack, group, seed);
};

const certificate = certificateOf(SEED);

/** 合法（但 base 綁定不同）的死亡包；只給跨綁定負控用。 */
const altBase = (patch: (manifest: Dict) => void): ValidatedDataPack => {
  const manifest = structuredClone(baseManifest);
  patch(manifest);
  manifest.packChecksum = computePackChecksum(manifest as never);
  return buildBase(manifest);
};

const baseOtherId = altBase((manifest) => {
  manifest.packId = "p2a-synthetic-alt";
});
const baseOtherChecksum = altBase((manifest) => {
  manifest.createdAt = "2026-10-29";
});

const deathPackForBase = (target: ValidatedDataPack): ValidatedDeathPack => {
  const manifest = structuredClone(deathManifest);
  manifest.basePackId = target.manifest.packId;
  manifest.basePackChecksum = target.packChecksum;
  manifest.packChecksum = computeDeathPackChecksum(manifest as never);
  return buildDeathPack(manifest, target);
};

/* ------------------------------------------------------------------ */
/* 輔助                                                                */
/* ------------------------------------------------------------------ */

function genesisInput(overrides: Dict = {}): Dict {
  return {
    masterSeed: SEED,
    basePack: base,
    identityPack,
    certificate,
    eventPack,
    deathPack,
    ...overrides
  };
}

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function expectGenesisError(input: unknown, code: string, path: string): void {
  const caught = caughtFrom(() => createP3EGenesis(input));
  expect(isP3EError(caught), `${code} at ${path}`).toBe(true);
  const error = caught as P3EError;
  expect(error.code, `path ${path}`).toBe(code);
  expect(error.path).toBe(path);
  expect(error.message).toBe(`${code} at ${path}`);
  expect(caught instanceof TypeError).toBe(false);
  expect(caught instanceof RangeError).toBe(false);
  expect(caught instanceof RngError).toBe(false);
  expect(caught instanceof MoneyError).toBe(false);
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  const record = value as Dict;
  return Object.keys(record).every((key) => isDeepFrozen(record[key]));
}

function sharesReference(output: unknown, input: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  if (output === input) return true;
  const outRecord = output as Dict;
  const inRecord = (typeof input === "object" && input !== null ? input : {}) as Dict;
  return Object.keys(outRecord).some((key) => sharesReference(outRecord[key], inRecord[key]));
}

const genesis = (): contracts.P3ELifeState => createP3EGenesis(genesisInput());

/** 取出去掉 stateHash 的可變 draft（seal 的輸入）。 */
function draftOf(state: contracts.P3ELifeState): Omit<contracts.P3ELifeState, "stateHash"> {
  const copy = structuredClone(state) as unknown as Dict;
  delete copy.stateHash;
  return copy as unknown as Omit<contracts.P3ELifeState, "stateHash">;
}

/* ------------------------------------------------------------------ */
/* 一、完整合法 Genesis                                                */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3a 合法 genesis", () => {
  it("完整合法 input 建立 state，並通過 readP3EState", () => {
    const state = genesis();
    expect(() => readP3EState(state)).not.toThrow();
    expect(readP3EState(state)).toEqual(state);
    expect(state.schemaVersion).toBe(contracts.P3E_SCHEMA_VERSION);
    expect(state.stateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("相同輸入重跑 20 次逐欄一致", () => {
    const first = genesis();
    for (let index = 0; index < 20; index += 1) {
      expect(genesis()).toEqual(first);
    }
  });

  it("輸出深層凍結、與 input 零共享、input 未被修改", () => {
    const input = genesisInput();
    const before = { keys: Object.keys(input).sort() };
    const state = createP3EGenesis(input);
    expect(isDeepFrozen(state)).toBe(true);
    expect(sharesReference(state, input)).toBe(false);
    expect(sharesReference(state, certificate)).toBe(false);
    expect(sharesReference(state, deathPack)).toBe(false);
    expect(sharesReference(state, eventPack)).toBe(false);
    expect(Object.keys(input).sort()).toEqual(before.keys);
    expect(input.certificate).toBe(certificate);
    expect(() => {
      (state as unknown as Dict).age = 1;
    }).toThrow(TypeError);
  });

  it("固定 Genesis 初值", () => {
    const state = genesis();
    expect(state.currentYear).toBe(certificate.player.birth.birthYear);
    expect(state.age).toBe(0);
    expect(state.phase).toBe("life");
    expect(state.stats).toEqual({ health: 50, happiness: 50, knowledge: 50, relationships: 50 });
    expect(state.assets).toEqual({ balanceMicroUsd: 0n, annualIncomeMicroUsd: 0n, annualExpenseMicroUsd: 0n });
    expect(state.flags).toEqual([]);
    expect(state.occurrences).toEqual([]);
    expect(state.pendingDecision).toBeNull();
    expect(state.phase).toBe("life");
    expect(Object.keys(state)).not.toContain("lifespanYears");
    expect(Object.keys(state)).not.toContain("burnedValue");
  });

  it("八個版本欄位全部是 contracts 常數", () => {
    const state = genesis();
    expect(state.schemaVersion).toBe(contracts.P3E_SCHEMA_VERSION);
    expect(state.rulesetVersion).toBe(contracts.P3E_RULESET_VERSION);
    expect(state.rollSpecVersion).toBe(contracts.P3E_ROLL_SPEC_VERSION);
    expect(state.lifeSpecVersion).toBe(contracts.P3E_LIFE_SPEC_VERSION);
    expect(state.contentVersion).toBe(contracts.P3E_CONTENT_VERSION);
    expect(state.saveFormatVersion).toBe(contracts.P3E_SAVE_FORMAT_VERSION);
    expect(state.engineVersion).toBe(contracts.P3E_ENGINE_VERSION);
    expect(state.rngSpecVersion).toBe(contracts.P3E_RNG_SPEC_VERSION);
  });
});

/* ------------------------------------------------------------------ */
/* 二、binding 逐欄比對                                                */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3a binding", () => {
  it("identity 12 欄逐欄等於 certificate 的權威來源", () => {
    const state = genesis();
    const birth = certificate.player.birth;
    expect(state.identity).toEqual({
      entityId: birth.entityId,
      regionCode: birth.regionCode,
      sex: birth.sex,
      birthYear: birth.birthYear,
      certificateId: certificate.certificateId,
      certificateHash: certificate.certificateHash,
      playerIdentityHash: certificate.player.identityHash,
      masterSeedHash: certificate.masterSeedHash,
      basePackId: certificate.packs.basePackId,
      basePackChecksum: certificate.packs.basePackChecksum,
      identityPackId: certificate.packs.identityPackId,
      identityPackChecksum: certificate.packs.identityPackChecksum
    });
    expect(Object.keys(state.identity).length).toBe(12);
  });

  it("event binding 七欄逐欄等於 bindEventPack", () => {
    const bound = bindEventPack(eventPack);
    const state = genesis();
    expect(state.packs.events).toEqual({
      eventSchemaVersion: bound.eventSchemaVersion,
      eventSpecVersion: bound.eventSpecVersion,
      contentPackVersion: bound.contentPackVersion,
      eventPackId: bound.eventPackId,
      eventPackChecksum: bound.eventPackChecksum,
      datasetChecksum: bound.datasetChecksum,
      eventCount: bound.eventCount
    });
    expect(Object.keys(state.packs.events).length).toBe(7);
    expect(Object.isFrozen(state.packs.events)).toBe(true);
  });

  it("death binding 11 欄逐欄等於 validated death pack", () => {
    const manifest = deathPack.manifest;
    const state = genesis();
    expect(state.packs.death).toEqual({
      schemaVersion: manifest.schemaVersion,
      deathDataVersion: manifest.deathDataVersion,
      deathSpecVersion: manifest.deathSpecVersion,
      healthRuleVersion: contracts.P3D_HEALTH_RULE_VERSION,
      engineVersion: manifest.engineVersion,
      rngSpecVersion: manifest.rngSpecVersion,
      deathPackId: manifest.deathPackId,
      deathPackChecksum: deathPack.packChecksum,
      basePackId: manifest.basePackId,
      basePackChecksum: manifest.basePackChecksum,
      entityCount: manifest.entityCount
    });
    expect(Object.keys(state.packs.death).length).toBe(11);
  });

  it("三條 RNG 與 createP3EGenesisRng 完全一致", () => {
    const state = genesis();
    expect(state.rng).toEqual(createP3EGenesisRng(SEED, certificate.player.birth.birthYear));
    expect(state.rng.life.semanticDraws).toBe(contracts.P3E_GENESIS_SEMANTIC_DRAWS);
    expect(state.rng.events.u32Draws).toBe(0);
    expect(state.rng.death.u32Draws).toBe(0);
    // death initial 綁 master seed ＋ p3e/death domain（F-01 關閉）
    expect(state.rng.death.domain).toBe("p3e/death");
    expect(state.rng.death.state).toEqual(state.rng.death.initialState);
  });

  it("四個 heads 與 command summary 等於 createP3EGenesisIntegrity", () => {
    const state = genesis();
    const integrity = createP3EGenesisIntegrity(state);
    expect(state.heads).toEqual(integrity.heads);
    expect(state.commandLog).toEqual({ count: 0, headHash: integrity.commandLog.headHash });
  });

  it("stateHash 等於 computeP3EStateHash", () => {
    const state = genesis();
    expect(state.stateHash).toBe(computeP3EStateHash(state));
  });

  it("不同 seed 產生不同 state（含 RNG 與 identity）", () => {
    const otherSeed = "p3e-2c-3a-genesis-alt";
    const other = createP3EGenesis(genesisInput({ masterSeed: otherSeed, certificate: certificateOf(otherSeed) }));
    const state = genesis();
    expect(other.rng.life).not.toEqual(state.rng.life);
    expect(other.stateHash).not.toBe(state.stateHash);
  });
});

/* ------------------------------------------------------------------ */
/* 三、input shape 與反射邊界                                          */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3a input shape", () => {
  it("多欄／缺欄／改名一律 E_P3E_ARGUMENT at input", () => {
    expectGenesisError({ ...genesisInput(), extra: 1 }, "E_P3E_ARGUMENT", "input");
    for (const key of ["masterSeed", "basePack", "identityPack", "certificate", "eventPack", "deathPack"]) {
      const missing = genesisInput();
      delete missing[key];
      expectGenesisError(missing, "E_P3E_ARGUMENT", "input");
    }
    const renamed = genesisInput();
    delete renamed.deathPack;
    renamed.deathPacks = deathPack;
    expectGenesisError(renamed, "E_P3E_ARGUMENT", "input");
  });

  it("hidden／symbol／accessor 一律拒絕（getter 不執行）", () => {
    const hidden = genesisInput();
    Object.defineProperty(hidden, "hiddenExtra", { value: 1, enumerable: false, configurable: true });
    expectGenesisError(hidden, "E_P3E_ARGUMENT", "input");

    const symbol = genesisInput();
    Object.defineProperty(symbol, Symbol("extra"), { value: 1, enumerable: false, configurable: true });
    expectGenesisError(symbol, "E_P3E_ARGUMENT", "input");

    const accessor = genesisInput();
    const value = accessor.masterSeed;
    let invoked = false;
    Object.defineProperty(accessor, "masterSeed", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return value;
      }
    });
    expectGenesisError(accessor, "E_P3E_ARGUMENT", "input");
    expect(invoked).toBe(false);

    const hiddenRequired = genesisInput();
    Object.defineProperty(hiddenRequired, "masterSeed", { value: SEED, enumerable: false, configurable: true });
    expectGenesisError(hiddenRequired, "E_P3E_ARGUMENT", "input");
  });

  it("不是 plain object 一律拒絕（陣列／class instance／其他 prototype）", () => {
    class FakeInput {
      public masterSeed = SEED;
    }
    for (const value of [null, undefined, 42, "input", true, [], [genesisInput()], new FakeInput(), Object.create({})]) {
      expectGenesisError(value, "E_P3E_ARGUMENT", "input");
    }
  });

  it("null prototype 的 input 可以接受", () => {
    const bare = Object.assign(Object.create(null) as Dict, genesisInput());
    expect(() => createP3EGenesis(bare)).not.toThrow();
  });

  it("已撤銷 Proxy 與反射 trap 只回固定錯誤", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectGenesisError(revoked.proxy, "E_P3E_ARGUMENT", "input");

    const protoThrows = new Proxy({}, {
      getPrototypeOf() {
        throw new TypeError("proto");
      }
    });
    expectGenesisError(protoThrows, "E_P3E_ARGUMENT", "input");

    const keysThrows = new Proxy({}, {
      ownKeys() {
        throw new TypeError("ownKeys");
      }
    });
    expectGenesisError(keysThrows, "E_P3E_ARGUMENT", "input");
  });
});

/* ------------------------------------------------------------------ */
/* 四、出生證書重播                                                    */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3a 出生證書", () => {
  it("錯的 masterSeed → E_P3E_CERTIFICATE at certificate", () => {
    expectGenesisError(genesisInput({ masterSeed: "wrong-seed" }), "E_P3E_CERTIFICATE", "certificate");
  });

  it("非字串 masterSeed 也折成 certificate 錯誤", () => {
    for (const masterSeed of [42, null, undefined, {}]) {
      expectGenesisError(genesisInput({ masterSeed }), "E_P3E_CERTIFICATE", "certificate");
    }
  });

  it("certificate 任一權威欄位被改 → E_P3E_CERTIFICATE", () => {
    const patches: readonly ((draft: Dict) => void)[] = [
      (draft) => {
        nodeAt(draft, ["player", "birth"]).entityId = "cr:ALB";
      },
      (draft) => {
        nodeAt(draft, ["player", "birth"]).birthYear = 2001;
      },
      (draft) => {
        nodeAt(draft, ["player"]).identityHash = HEX("9");
      },
      (draft) => {
        draft.certificateHash = HEX("9");
      },
      (draft) => {
        nodeAt(draft, ["packs"]).basePackChecksum = HEX("9");
      }
    ];
    for (const patch of patches) {
      const tampered = structuredClone(certificate) as unknown as Dict;
      patch(tampered);
      expectGenesisError(genesisInput({ certificate: tampered }), "E_P3E_CERTIFICATE", "certificate");
    }
  });

  it("raw／clone／換錯的五個 pack 都拒絕", () => {
    // base／identity 的 raw 與 clone 由 P2-D 驗證器擋下（certificate 錯誤）
    expectGenesisError(genesisInput({ basePack: structuredClone(baseManifest) }), "E_P3E_CERTIFICATE", "certificate");
    expectGenesisError(genesisInput({ basePack: structuredClone(base) }), "E_P3E_CERTIFICATE", "certificate");
    expectGenesisError(genesisInput({ identityPack: structuredClone(identityPack) }), "E_P3E_CERTIFICATE", "certificate");

    // 換成另一個 base：base／identity 綁定不一致
    expectGenesisError(genesisInput({ basePack: baseOtherId }), "E_P3E_CERTIFICATE", "certificate");
  });

  it("certificate 錯誤優先於 event／death 錯誤", () => {
    expectGenesisError(
      genesisInput({
        masterSeed: "wrong-seed",
        eventPack: structuredClone(eventPack),
        deathPack: structuredClone(deathPack)
      }),
      "E_P3E_CERTIFICATE",
      "certificate"
    );
  });
});

/* ------------------------------------------------------------------ */
/* 五、validated packs                                                 */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3a validated packs", () => {
  it("event pack：raw／clone／手工仿造都拒絕", () => {
    const forged = {
      manifest: (eventPack as unknown as Dict).manifest,
      events: (eventPack as unknown as { events: unknown[] }).events
    };
    for (const eventPackValue of [
      readJson("fixtures/p3b/manifest.v1.json"),
      structuredClone(eventPack),
      forged,
      null
    ]) {
      expectGenesisError(genesisInput({ eventPack: eventPackValue }), "E_P3E_EVENT_PACK", "eventPack");
    }
  });

  it("death pack：raw／clone／手工仿造都拒絕", () => {
    const forged = { manifest: deathPack.manifest, entityIndex: deathPack.entityIndex };
    for (const deathPackValue of [
      readJson("fixtures/p3d/manifest.v1.json"),
      structuredClone(deathPack),
      forged,
      undefined
    ]) {
      expectGenesisError(genesisInput({ deathPack: deathPackValue }), "E_P3E_DEATH_PACK", "deathPack");
    }
  });

  it("event 錯誤優先於 death 錯誤", () => {
    expectGenesisError(
      genesisInput({ eventPack: structuredClone(eventPack), deathPack: structuredClone(deathPack) }),
      "E_P3E_EVENT_PACK",
      "eventPack"
    );
  });
});

/* ------------------------------------------------------------------ */
/* 六、跨包綁定                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3a 跨包綁定", () => {
  it("death pack 綁在不同 basePackId → E_P3E_BINDING", () => {
    expectGenesisError(
      genesisInput({ deathPack: deathPackForBase(baseOtherId) }),
      "E_P3E_BINDING",
      "deathPack.manifest.basePackId"
    );
  });

  it("death pack 綁在不同 basePackChecksum → E_P3E_BINDING", () => {
    expectGenesisError(
      genesisInput({ deathPack: deathPackForBase(baseOtherChecksum) }),
      "E_P3E_BINDING",
      "deathPack.manifest.basePackChecksum"
    );
  });

  it("death pack 的 entityIndex 覆蓋證書的 entity 與 regionCode", () => {
    const state = genesis();
    const entity = certificate.player.birth.entityId;
    const binding = deathPack.entityIndex[entity];
    expect(binding).toBeDefined();
    expect(binding?.regionCode).toBe(certificate.player.birth.regionCode);
    expect(state.identity.regionCode).toBe(binding?.regionCode);
  });

  it("entityIndex 缺 entity／regionCode 不符 → E_P3E_BINDING at deathPack.entityIndex", () => {
    // 已驗證的 death pack 幾乎不可能出現這兩種狀態（entityIndex 由 base 建立），
    // 因此用型別轉型構造反例，直接打內部 seam（正式流程必經同一支函式）。
    const entity = certificate.player.birth.entityId;
    const missingEntity = { manifest: deathPack.manifest, entityIndex: {} } as unknown as ValidatedDeathPack;
    const caughtMissing = caughtFrom(() => assertP3EDeathBinding(missingEntity, certificate));
    expect(isP3EError(caughtMissing)).toBe(true);
    expect((caughtMissing as P3EError).code).toBe("E_P3E_BINDING");
    expect((caughtMissing as P3EError).path).toBe("deathPack.entityIndex");

    const wrongRegion = {
      manifest: deathPack.manifest,
      entityIndex: { [entity]: { entityId: entity, regionCode: "ZZZ", regionClass: "other" } }
    } as unknown as ValidatedDeathPack;
    const caughtRegion = caughtFrom(() => assertP3EDeathBinding(wrongRegion, certificate));
    expect((caughtRegion as P3EError).code).toBe("E_P3E_BINDING");
    expect((caughtRegion as P3EError).path).toBe("deathPack.entityIndex");

    // 正確的 pack 不會拋
    expect(() => assertP3EDeathBinding(deathPack, certificate)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 七、seal                                                            */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3a seal", () => {
  it("合法 draft 可以 seal，回傳獨立深層凍結快照", () => {
    const state = genesis();
    const sealed = sealP3EState(draftOf(state));
    expect(sealed).toEqual(state);
    expect(sealed).not.toBe(state);
    expect(isDeepFrozen(sealed)).toBe(true);
    expect(sharesReference(sealed, state)).toBe(false);
    expect(sealed.stateHash).toBe(state.stateHash);
  });

  it("語意錯誤的 draft 會回原本的精確錯誤", () => {
    const draft = draftOf(genesis());
    const broken = { ...draft, age: 1 } as typeof draft;
    const caught = caughtFrom(() => sealP3EState(broken));
    expect(isP3EError(caught)).toBe(true);
    expect((caught as P3EError).code).toBe("E_P3E_STATE");
    expect((caught as P3EError).path).toBe("currentYear");
  });

  it("舊的 stateHash 不能用來繞過（一律重算）", () => {
    const state = genesis();
    const draft = draftOf(state);
    const withStale = { ...draft, stateHash: HEX("0") } as unknown as typeof draft;
    const sealed = sealP3EState(withStale);
    expect(sealed.stateHash).toBe(computeP3EStateHash(state));
    expect(sealed.stateHash).not.toBe(HEX("0"));
  });

  it("seal 產生的 state 一定通過 readP3EState", () => {
    const draft = draftOf(genesis());
    expect(() => readP3EState(sealP3EState(draft))).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 八、公開表面                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1a-2c-3a 公開表面", () => {
  it("createP3EGenesis 依 2l 進入 barrel；sealP3EState 仍不外洩", () => {
    expect(typeof createP3EGenesis).toBe("function");
    expect(typeof sealP3EState).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.createP3EGenesis).toBe(createP3EGenesis);
    expect(surface.sealP3EState).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });
});

/* ------------------------------------------------------------------ */
/* 輔助                                                                */
/* ------------------------------------------------------------------ */

function nodeAt(root: Dict, path: readonly string[]): Dict {
  let node: unknown = root;
  for (const step of path) node = (node as Dict)[step];
  return node as Dict;
}
