import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildPeerGroup,
  createBirthCertificate,
  validateDataPack,
  validateIdentityPack
} from "@life-sim/birth";
import { P2B_SETTLEMENT_LABELS } from "@life-sim/contracts";
import * as barrel from "../src/index";
import {
  createP3EBrowserSession,
  prepareP3EBrowserWorld,
  previewP3EBrowserBirth
} from "../src/p3e-browser-bootstrap";
import { P3E_ZH_HANT_COUNTRY_NAMES } from "../src/p3e-birth-preview";
import { isP3EError, type P3EError } from "../../simulation/src/errors";

/**
 * GPT-DEEPSEEK-0017：正式出生預覽接口（`previewP3EBrowserBirth`）專項測試。
 *
 * 三條原則：
 * 1. **不用 preview 自己的輸出當答案**——每一欄都拿正式原語
 *    （`buildPeerGroup` → `createBirthCertificate`）或正式 session
 *    （`createP3EBrowserSession` 的 `state.identity`）獨立驗證；
 * 2. preview 是唯讀的：同 seed 重跑逐位元相同，且不影響正規開局；
 * 3. 只驗公開面：沒有任何 pack／dataset／manifest 洩漏到回傳值。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

type Dict = Record<string, unknown>;

/* ------------------------------ 計數 mock ------------------------------ */

const counters = vi.hoisted(() => ({ peerGroup: 0, certificate: 0 }));

vi.mock("@life-sim/birth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@life-sim/birth")>();
  return {
    ...actual,
    buildPeerGroup: (...args: unknown[]) => {
      counters.peerGroup += 1;
      return (actual.buildPeerGroup as unknown as (...inner: unknown[]) => unknown)(...args);
    },
    createBirthCertificate: (...args: unknown[]) => {
      counters.certificate += 1;
      return (actual.createBirthCertificate as unknown as (...inner: unknown[]) => unknown)(...args);
    }
  };
});

/* ------------------------------ fixtures ------------------------------ */

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
    manifest: readJson("fixtures/p2b/manifest.v1.json"),
    datasets: {
      "country-vitals": readJson("fixtures/p2b/country-vitals.v1.json"),
      "household-profiles": readJson("fixtures/p2b/household-profiles.v1.json"),
      "name-corpus": readJson("fixtures/p2b/name-corpus.v1.json"),
      "story-templates": readJson("fixtures/p2b/story-templates.v1.json"),
      licenses: readJson("fixtures/p2b/licenses.v1.json"),
      lineage: readJson("fixtures/p2b/lineage.v1.json")
    }
  },
  events: {
    manifest: readJson("fixtures/p3b/manifest.v1.json"),
    events: (readJson("fixtures/p3b/events.v1.json") as { records: unknown[] }).records
  },
  death: {
    manifest: readJson("fixtures/p3d/manifest.v1.json"),
    datasets: {
      "cause-registry": readJson("fixtures/p3d/cause-registry.v1.json"),
      "cause-weights": readJson("fixtures/p3d/cause-weights.v1.json"),
      mortality: readJson("fixtures/p3d/mortality.v1.json"),
      licenses: readJson("fixtures/p3d/licenses.v1.json"),
      lineage: readJson("fixtures/p3d/lineage.v1.json")
    }
  }
} as const;

const SEEDS = ["p3e-166-playable-runtime-v4", "gpt-deepseek-0017-a", "gpt-deepseek-0017-b"] as const;

/** 已驗證 pack（每檔只驗一次；preview 只讀 world，不需要 pack 參照）。 */
let cachedPacks: { base: ReturnType<typeof validateDataPack>; identity: ReturnType<typeof validateIdentityPack> } | null =
  null;
function packs(): NonNullable<typeof cachedPacks> {
  if (cachedPacks === null) {
    const base = validateDataPack(rawPacks.base as never);
    cachedPacks = { base, identity: validateIdentityPack(base, rawPacks.identity as never) };
  }
  return cachedPacks;
}

/** 已驗證 world（每檔只驗一次）。 */
let cachedWorld: ReturnType<typeof prepareP3EBrowserWorld> | null = null;
function world(): ReturnType<typeof prepareP3EBrowserWorld> {
  if (cachedWorld === null) cachedWorld = prepareP3EBrowserWorld(rawPacks);
  return cachedWorld;
}

/** 正式原語獨立產生的出生證書（preview 的預期答案）。 */
const certificateCache = new Map<string, ReturnType<typeof createBirthCertificate>>();
function expectedCertificate(masterSeed: string): ReturnType<typeof createBirthCertificate> {
  const cached = certificateCache.get(masterSeed);
  if (cached !== undefined) return cached;
  const { base, identity } = packs();
  const peerGroup = buildPeerGroup(base, identity, {
    seed: masterSeed,
    playerSexPolicy: "random"
  } as never);
  const certificate = createBirthCertificate(base, identity, peerGroup, masterSeed);
  certificateCache.set(masterSeed, certificate);
  return certificate;
}

function expectP3EError(runFn: () => unknown, code: string, path: string): void {
  let caught: unknown = null;
  try {
    runFn();
  } catch (error) {
    caught = error;
  }
  expect(isP3EError(caught), `${code} at ${path}`).toBe(true);
  expect((caught as P3EError).code).toBe(code);
  expect((caught as P3EError).path).toBe(path);
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  return Object.keys(value as Dict).every((key) => isDeepFrozen((value as Dict)[key]));
}

function toPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const PREVIEW_KEYS = [
  "birthYear",
  "certificateHash",
  "certificateId",
  "country",
  "housing",
  "incomeLabel",
  "incomeQuintile",
  "lifeExpectancyYears",
  "lifeExpectancyYearsX10",
  "name",
  "parents",
  "playerIdentityHash",
  "religion",
  "settlement",
  "settlementLabel",
  "sex",
  "story"
];

/* ================================================================== */
/* 一、一致性：preview ≡ 正式證書 ≡ 正式 session identity                 */
/* ================================================================== */

describe("GPT-DEEPSEEK-0017 previewP3EBrowserBirth：身分一致性", () => {
  it("preview_matches_official_certificate_field_by_field", () => {
    const w = world();
    for (const seed of SEEDS) {
      const preview = previewP3EBrowserBirth({ world: w, masterSeed: seed });
      const certificate = expectedCertificate(seed);
      const player = certificate.player;
      const family = player.family;

      expect(preview.certificateId).toBe(certificate.certificateId);
      expect(preview.certificateHash).toBe(certificate.certificateHash);
      expect(preview.playerIdentityHash).toBe(player.identityHash);
      expect(preview.birthYear).toBe(player.birth.birthYear);

      expect(preview.country.regionCode).toBe(player.birth.regionCode);
      expect(preview.country.region).toBe(player.birth.region);
      expect(preview.country.nameZhHans).toBe(player.birth.displayNameZhHans);
      expect(preview.country.nameZhHant).toBe(
        P3E_ZH_HANT_COUNTRY_NAMES[player.birth.regionCode] ?? player.birth.displayNameZhHans
      );

      expect(preview.name).toEqual({
        fullName: player.name.fullName,
        surname: player.name.surname,
        givenName: player.name.givenName
      });
      expect(preview.sex).toBe(player.birth.sex);
      expect(preview.settlement).toBe(family.settlement);
      expect(preview.settlementLabel).toBe(P2B_SETTLEMENT_LABELS[family.settlement]);
      expect(preview.incomeQuintile).toBe(family.incomeQuintile);
      expect(preview.incomeLabel).toBe(family.incomeLabel);
      expect(preview.housing).toEqual({ id: family.housing, label: family.housingLabel });
      expect(preview.parents).toEqual({
        motherAge: family.motherAge,
        fatherAge: family.fatherAge,
        motherOccupationLabel: family.motherOccupationLabel,
        fatherOccupationLabel: family.fatherOccupationLabel
      });
      expect(preview.religion).toEqual({ id: family.religionId, label: family.religionLabel });
      expect(preview.lifeExpectancyYearsX10).toBe(player.vitals.lifeExpectancyYearsX10);
      expect(preview.lifeExpectancyYears).toBe(player.vitals.lifeExpectancyYearsX10 / 10);
      expect(preview.story).toEqual({
        templateId: player.story.templateId,
        paragraphs: [...player.story.paragraphs]
      });
    }
  });

  it("preview_identity_equals_createP3EBrowserSession_identity", () => {
    const w = world();
    for (const seed of SEEDS) {
      const preview = previewP3EBrowserBirth({ world: w, masterSeed: seed });
      const session = createP3EBrowserSession({ world: w, masterSeed: seed });
      const identity = session.state.identity;

      expect(preview.certificateId).toBe(identity.certificateId);
      expect(preview.certificateHash).toBe(identity.certificateHash);
      expect(preview.playerIdentityHash).toBe(identity.playerIdentityHash);
      expect(preview.country.regionCode).toBe(identity.regionCode);
      expect(preview.sex).toBe(identity.sex);
      expect(preview.birthYear).toBe(identity.birthYear);
      // session 是 age 0 出生狀態：出生年就是當前年。
      expect(session.state.age).toBe(0);
      expect(session.state.currentYear).toBe(preview.birthYear);
    }
  });

  it("preview_is_read_only_and_does_not_change_later_sessions", () => {
    const w = world();
    const before = createP3EBrowserSession({ world: w, masterSeed: SEEDS[0] });
    const first = previewP3EBrowserBirth({ world: w, masterSeed: SEEDS[0] });
    const second = previewP3EBrowserBirth({ world: w, masterSeed: SEEDS[0] });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).not.toBe(second);
    // preview 不建立 session、不帶 ledger／payload。
    expect((first as unknown as Dict)["state"]).toBeUndefined();
    expect((first as unknown as Dict)["view"]).toBeUndefined();
    expect((first as unknown as Dict)["ledgerHistory"]).toBeUndefined();
    expect((first as unknown as Dict)["payload"]).toBeUndefined();

    const after = createP3EBrowserSession({ world: w, masterSeed: SEEDS[0] });
    expect(after.state.stateHash).toBe(before.state.stateHash);
    expect(JSON.stringify(after.state.identity)).toBe(JSON.stringify(before.state.identity));
  });

  it("preview_uses_official_birth_primitives_exactly_once", () => {
    const w = world();
    counters.peerGroup = 0;
    counters.certificate = 0;
    previewP3EBrowserBirth({ world: w, masterSeed: SEEDS[1] });
    expect(counters.peerGroup).toBe(1);
    expect(counters.certificate).toBe(1);
  });
});

/* ================================================================== */
/* 二、JSON 序列化                                                      */
/* ================================================================== */

describe("GPT-DEEPSEEK-0017 previewP3EBrowserBirth：JSON 序列化", () => {
  it("preview_json_round_trip_is_lossless_and_bigint_free", () => {
    const w = world();
    for (const seed of SEEDS) {
      const preview = previewP3EBrowserBirth({ world: w, masterSeed: seed });
      const text = JSON.stringify(preview);
      expect(typeof text).toBe("string");
      expect(text.includes("bigint")).toBe(false);
      expect(text.length).toBeGreaterThan(50);

      const parsed = JSON.parse(text) as Dict;
      expect(parsed).toEqual(toPlainJson(preview));
      expect(JSON.stringify(parsed)).toBe(text);

      // 每個值都是 JSON 原生型別（string／number／boolean／array／plain object）。
      const walk = (value: unknown, path: string): void => {
        if (value === null) return;
        const kind = typeof value;
        expect(["string", "number", "boolean", "object"], path).toContain(kind);
        if (kind === "number") expect(Number.isFinite(value as number), path).toBe(true);
        if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
        else if (kind === "object") {
          expect(Object.isFrozen(value), path).toBe(true);
          for (const key of Object.keys(value as Dict)) walk((value as Dict)[key], `${path}.${key}`);
        }
      };
      walk(preview, "preview");
    }
  });

  it("preview_is_structured_cloneable_and_deeply_frozen", () => {
    const preview = previewP3EBrowserBirth({ world: world(), masterSeed: SEEDS[0] });
    expect(isDeepFrozen(preview)).toBe(true);
    expect(structuredClone(preview)).toEqual(toPlainJson(preview));
    expect(() => {
      (preview as { sex: string }).sex = "male";
    }).toThrow(TypeError);
  });
});

/* ================================================================== */
/* 三、型別檢查與欄位封閉性                                              */
/* ================================================================== */

describe("GPT-DEEPSEEK-0017 previewP3EBrowserBirth：型別與欄位", () => {
  it("preview_shape_types_and_value_domains", () => {
    const preview = previewP3EBrowserBirth({ world: world(), masterSeed: SEEDS[0] });

    expect(Object.keys(preview).sort()).toEqual(PREVIEW_KEYS);
    expect(Object.getOwnPropertySymbols(preview)).toEqual([]);

    expect(typeof preview.certificateId).toBe("string");
    expect(preview.certificateId).toMatch(/^cert:[0-9a-f]{24}$/);
    expect(typeof preview.certificateHash).toBe("string");
    expect(preview.certificateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof preview.playerIdentityHash).toBe("string");
    expect(preview.playerIdentityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof preview.birthYear).toBe("number");
    expect(Number.isSafeInteger(preview.birthYear)).toBe(true);

    expect(Object.keys(preview.country).sort()).toEqual(["nameZhHans", "nameZhHant", "region", "regionCode"]);
    expect(typeof preview.country.regionCode).toBe("string");
    expect(preview.country.regionCode).toMatch(/^[A-Z]{3}$/);
    expect(typeof preview.country.region).toBe("string");
    expect(typeof preview.country.nameZhHant).toBe("string");
    expect(preview.country.nameZhHant.length).toBeGreaterThan(0);
    expect(typeof preview.country.nameZhHans).toBe("string");
    expect(preview.country.nameZhHans.length).toBeGreaterThan(0);

    expect(Object.keys(preview.name).sort()).toEqual(["fullName", "givenName", "surname"]);
    for (const value of Object.values(preview.name)) expect(typeof value).toBe("string");
    expect(preview.name.fullName.length).toBeGreaterThan(0);

    expect(["female", "male"]).toContain(preview.sex);
    expect(["urban", "rural"]).toContain(preview.settlement);
    expect(typeof preview.settlementLabel).toBe("string");
    expect(Number.isSafeInteger(preview.incomeQuintile)).toBe(true);
    expect(preview.incomeQuintile).toBeGreaterThanOrEqual(1);
    expect(preview.incomeQuintile).toBeLessThanOrEqual(5);
    expect(typeof preview.incomeLabel).toBe("string");

    expect(Object.keys(preview.housing).sort()).toEqual(["id", "label"]);
    expect(typeof preview.housing.id).toBe("string");
    expect(typeof preview.housing.label).toBe("string");

    expect(Object.keys(preview.parents).sort()).toEqual([
      "fatherAge",
      "fatherOccupationLabel",
      "motherAge",
      "motherOccupationLabel"
    ]);
    expect(Number.isSafeInteger(preview.parents.motherAge)).toBe(true);
    expect(Number.isSafeInteger(preview.parents.fatherAge)).toBe(true);
    expect(typeof preview.parents.motherOccupationLabel).toBe("string");
    expect(typeof preview.parents.fatherOccupationLabel).toBe("string");

    expect(Object.keys(preview.religion).sort()).toEqual(["id", "label"]);
    expect(typeof preview.religion.id).toBe("string");
    expect(typeof preview.religion.label).toBe("string");

    expect(Number.isSafeInteger(preview.lifeExpectancyYearsX10)).toBe(true);
    expect(preview.lifeExpectancyYearsX10).toBeGreaterThan(0);
    expect(typeof preview.lifeExpectancyYears).toBe("number");
    expect(preview.lifeExpectancyYears).toBe(preview.lifeExpectancyYearsX10 / 10);

    expect(Object.keys(preview.story).sort()).toEqual(["paragraphs", "templateId"]);
    expect(typeof preview.story.templateId).toBe("string");
    expect(Array.isArray(preview.story.paragraphs)).toBe(true);
    expect(preview.story.paragraphs.length).toBeGreaterThan(0);
    for (const paragraph of preview.story.paragraphs) {
      expect(typeof paragraph).toBe("string");
      expect(paragraph.includes("{")).toBe(false);
      expect(paragraph.includes("}")).toBe(false);
    }
  });

  it("preview_never_exposes_internal_packs_or_pack_fields", () => {
    const preview = previewP3EBrowserBirth({ world: world(), masterSeed: SEEDS[0] });
    const text = JSON.stringify(preview);
    const forbidden = [
      "datasets",
      "manifest",
      "packChecksum",
      "basePackId",
      "identityPackId",
      "peerGroupHash",
      "peerSpecVersion",
      "mortality",
      "cause-weights",
      "cause-registry",
      "name-corpus",
      "household-profiles",
      "story-templates",
      "country-registry",
      "indicatorYear",
      "birthShare"
    ];
    for (const token of forbidden) expect(text.includes(token), token).toBe(false);
    // 只有證書層級的識別碼，沒有 pack 物件、沒有函式。
    const walk = (value: unknown): void => {
      expect(typeof value).not.toBe("function");
      expect(typeof value).not.toBe("bigint");
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) walk(item);
    };
    walk(preview);
  });

  it("hant_country_table_covers_every_registry_region_code", () => {
    const registry = readJson("fixtures/p2a/country-registry.v1.json") as { records: { regionCode: string }[] };
    const codes = registry.records.map((record) => record.regionCode);
    expect(Object.keys(P3E_ZH_HANT_COUNTRY_NAMES).sort()).toEqual([...codes].sort());
    expect(Object.isFrozen(P3E_ZH_HANT_COUNTRY_NAMES)).toBe(true);

    const simplifiedOnly = /[国亚农与亲属规兰贝莱岛萨汤乌兹内冈东业个么]/u;
    for (const code of codes) {
      const name = P3E_ZH_HANT_COUNTRY_NAMES[code] as string;
      expect(typeof name, code).toBe("string");
      expect(name.length, code).toBeGreaterThan(0);
      expect(simplifiedOnly.test(name), `${code}:${name}`).toBe(false);
    }
    // 敏感地區一律沿用資料包審核過的正式名稱（逐字轉繁）。
    // GPT-0046-A：這三個地區已從資料中刪除，名稱表也不再保留。
    expect(P3E_ZH_HANT_COUNTRY_NAMES["HKG"]).toBeUndefined();
    expect(P3E_ZH_HANT_COUNTRY_NAMES["MAC"]).toBeUndefined();
    expect(P3E_ZH_HANT_COUNTRY_NAMES["TWN"]).toBeUndefined();
  });
});

/* ================================================================== */
/* 四、錯誤 world／seed                                                 */
/* ================================================================== */

describe("GPT-DEEPSEEK-0017 previewP3EBrowserBirth：錯誤 world／seed", () => {
  it("forged_or_cloned_world_rejected", () => {
    expectP3EError(
      () => previewP3EBrowserBirth({ world: {}, masterSeed: SEEDS[0] }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
    expectP3EError(
      () => previewP3EBrowserBirth({ world: structuredClone(world()), masterSeed: SEEDS[0] }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
    for (const bad of [42, null, undefined, [], "world", true]) {
      expectP3EError(
        () => previewP3EBrowserBirth({ world: bad, masterSeed: SEEDS[0] }),
        "E_P3E_ARGUMENT",
        "p3eBrowser.world"
      );
    }
    // 未經 prepareP3EBrowserWorld 的 raw packs 也不能當 world。
    expectP3EError(
      () => previewP3EBrowserBirth({ world: rawPacks, masterSeed: SEEDS[0] }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.world"
    );
  });

  it("invalid_seed_rejected_with_fixed_paths", () => {
    const w = world();
    for (const bad of [7, null, undefined, {}, [], true]) {
      expectP3EError(
        () => previewP3EBrowserBirth({ world: w, masterSeed: bad }),
        "E_P3E_ARGUMENT",
        "p3eBrowser.masterSeed"
      );
    }
    // 空字串／全空白：與正式 create 路徑完全相同（birth 的 E_P2A_SEED 原樣外傳）。
    for (const badSeed of ["", "   "]) {
      let direct: unknown = null;
      try {
        createP3EBrowserSession({ world: w, masterSeed: badSeed });
      } catch (error) {
        direct = error;
      }
      let previewError: unknown = null;
      try {
        previewP3EBrowserBirth({ world: w, masterSeed: badSeed });
      } catch (error) {
        previewError = error;
      }
      expect(direct).not.toBeNull();
      expect(previewError).not.toBeNull();
      expect((previewError as Error).constructor).toBe((direct as Error).constructor);
      expect((previewError as Error).message).toBe((direct as Error).message);
    }
  });

  it("input_boundary_is_descriptor_only_exact_object", () => {
    const w = world();
    // 多欄／少欄／改名／陣列／null／symbol／隱藏欄位／revoked proxy 一律拒絕。
    expectP3EError(
      () => previewP3EBrowserBirth({ world: w, masterSeed: SEEDS[0], extra: 1 }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.preview.input"
    );
    expectP3EError(
      () => previewP3EBrowserBirth({ world: w }),
      "E_P3E_ARGUMENT",
      "p3eBrowser.preview.input"
    );
    expectP3EError(() => previewP3EBrowserBirth([w]), "E_P3E_ARGUMENT", "p3eBrowser.preview.input");
    expectP3EError(() => previewP3EBrowserBirth(null), "E_P3E_ARGUMENT", "p3eBrowser.preview.input");
    expectP3EError(() => previewP3EBrowserBirth(undefined), "E_P3E_ARGUMENT", "p3eBrowser.preview.input");
    expectP3EError(() => previewP3EBrowserBirth("input"), "E_P3E_ARGUMENT", "p3eBrowser.preview.input");

    const renamed: Dict = { world: w };
    renamed["seed"] = SEEDS[0];
    expectP3EError(() => previewP3EBrowserBirth(renamed), "E_P3E_ARGUMENT", "p3eBrowser.preview.input");

    const withSymbol: Dict = { world: w, masterSeed: SEEDS[0] };
    (withSymbol as unknown as Record<symbol, unknown>)[Symbol("evil")] = 1;
    expectP3EError(() => previewP3EBrowserBirth(withSymbol), "E_P3E_ARGUMENT", "p3eBrowser.preview.input");

    const hidden: Dict = { world: w };
    Object.defineProperty(hidden, "masterSeed", { value: SEEDS[0], enumerable: false, writable: true });
    expectP3EError(() => previewP3EBrowserBirth(hidden), "E_P3E_ARGUMENT", "p3eBrowser.preview.input");

    const revocable = Proxy.revocable({ world: w, masterSeed: SEEDS[0] }, {});
    revocable.revoke();
    expectP3EError(() => previewP3EBrowserBirth(revocable.proxy), "E_P3E_ARGUMENT", "p3eBrowser.preview.input");

    // getters 永不執行（只讀 descriptor）。
    let getterCalls = 0;
    const withGetter = {
      world: w,
      get masterSeed(): string {
        getterCalls += 1;
        return SEEDS[0];
      }
    };
    expectP3EError(
      () => previewP3EBrowserBirth(withGetter),
      "E_P3E_ARGUMENT",
      "p3eBrowser.preview.input"
    );
    expect(getterCalls).toBe(0);
  });

  it("null_prototype_exact_object_is_accepted", () => {
    const input = Object.assign(Object.create(null) as Dict, {
      world: world(),
      masterSeed: SEEDS[0]
    });
    const preview = previewP3EBrowserBirth(input);
    expect(preview.certificateId).toMatch(/^cert:/);
  });
});

/* ================================================================== */
/* 五、公開 barrel                                                      */
/* ================================================================== */

describe("GPT-DEEPSEEK-0017 公開 barrel", () => {
  it("preview_entry_is_exported_from_public_barrel", () => {
    expect(typeof barrel.previewP3EBrowserBirth).toBe("function");
    expect(typeof barrel.buildP3EBirthPreview).toBe("function");
    expect(typeof barrel.prepareP3EBrowserWorld).toBe("function");
    expect(typeof barrel.createP3EBrowserSession).toBe("function");
    expect(barrel.P3E_ZH_HANT_COUNTRY_NAMES).toBe(P3E_ZH_HANT_COUNTRY_NAMES);
    const indexSource = readFileSync(join(ROOT, "packages/application/src/index.ts"), "utf8");
    expect(indexSource).toContain("./p3e-birth-preview");
    expect(indexSource).toContain("./p3e-browser-bootstrap");
  });
});
