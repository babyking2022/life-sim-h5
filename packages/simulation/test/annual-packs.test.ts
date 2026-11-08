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
  bindEventPack,
  computeEventsChecksum,
  computePackChecksum,
  deriveEventRngState,
  MoneyError,
  RngError,
  validateEventPack,
  Xoshiro128StarStar,
  type ValidatedEventPack
} from "@life-sim/engine";
import * as contracts from "@life-sim/contracts";
import * as simulation from "../src/index";
import { P3EError, isP3EError } from "../src/errors";
import { createP3EGenesis } from "../src/genesis";
import { assertP3EAnnualDeathBinding, assertP3EEventBinding, validateP3EAnnualPacks } from "../src/annual-packs";
import { encodeP3EState } from "../src/codec";
import { computeP3EStateHash } from "../src/state-hash";

/**
 * P3-E.1b-1a：年度資料包信任邊界與 life eligibility。
 *
 * - fixture 用真實的 P2-A／P2-B／P3-B／P3-D 驗證器產生；
 * - 「巢狀 openDecision」的 pack 由 p3b fixture 注入後**重算全部 checksum**再驗證，
 *   因此是真正的品牌物件（擋下來的原因只會是 eligibility）；
 * - 額外建一個 **age=30** 的合法 state：age=0 的 genesis integrity 會把 packs 釘死，
 *   只有 age>0 才可能出現 binding 不一致（年度交易的真實情境）。
 */

const SEED = "p3e-1b-1a-annual-packs";
const HEX = (char: string) => char.repeat(64);
const ROOT = process.cwd();
const AGED = 30;

type Dict = Record<string, unknown>;

const readJson = (relativePath: string): unknown => JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));

/* ------------------------------------------------------------------ */
/* 真實 fixtures                                                       */
/* ------------------------------------------------------------------ */

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

const eventPack: ValidatedEventPack = validateEventPack({ manifest: rawEventManifest, events: rawEvents } as never);

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

const certificate = createBirthCertificate(
  base,
  identityPack,
  buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never),
  SEED
);

const genesisState = createP3EGenesis({
  masterSeed: SEED,
  basePack: base,
  identityPack,
  certificate,
  eventPack,
  deathPack
});

/* ------------------------------------------------------------------ */
/* age=30 的合法 state（年度交易的真實情境）                           */
/* ------------------------------------------------------------------ */

const LIFE_INITIAL: readonly [number, number, number, number] = [11, 12, 13, 14];
const DEATH_INITIAL: readonly [number, number, number, number] = [41, 42, 43, 44];

function toWords(words: readonly number[]): [number, number, number, number] {
  return [words[0] as number, words[1] as number, words[2] as number, words[3] as number];
}

function lifeCursorAt(age: number): [number, number, number, number] {
  const rng = new Xoshiro128StarStar([...LIFE_INITIAL]);
  rng.uniformBigInt(41n);
  let words = toWords(rng.state);
  for (let year = 0; year < age; year += 1) {
    const yearRng = new Xoshiro128StarStar([...words]);
    yearRng.uniformInt(-3, 3);
    yearRng.uniformInt(-3, 3);
    yearRng.uniformInt(0, 3);
    yearRng.uniformInt(-2, 2);
    words = toWords(yearRng.state);
  }
  return words;
}

function advance(initial: readonly [number, number, number, number], draws: number): [number, number, number, number] {
  const rng = new Xoshiro128StarStar([...initial]);
  for (let index = 0; index < draws; index += 1) rng.nextU32();
  return toWords(rng.state);
}

const agedState: contracts.P3ELifeState = (() => {
  const birthYear = certificate.player.birth.birthYear;
  const years = BigInt(AGED);
  const eventInitial = toWords(deriveEventRngState(LIFE_INITIAL, birthYear));
  const draft = {
    ...genesisState,
    currentYear: birthYear + AGED,
    age: AGED,
    phase: "life" as const,
    assets: {
      balanceMicroUsd: 1_900_000n,
      annualIncomeMicroUsd: contracts.P3E_INCOME_BASE_MICRO_USD + years * contracts.P3E_INCOME_PER_YEAR_MICRO_USD,
      annualExpenseMicroUsd: contracts.P3E_EXPENSE_BASE_MICRO_USD + years * contracts.P3E_EXPENSE_PER_YEAR_MICRO_USD
    },
    flags: ["p3e:flag-a", "p3e:flag-b"],
    occurrences: [
      { eventId: "ev-a", count: 1, lastYear: birthYear + 1 },
      { eventId: "ev-b", count: 2, lastYear: birthYear + 20 }
    ],
    rng: {
      life: {
        domain: "life" as const,
        initialState: LIFE_INITIAL,
        state: lifeCursorAt(AGED),
        semanticDraws: contracts.P3E_GENESIS_SEMANTIC_DRAWS + contracts.P3E_ROLL_SEMANTIC_DRAWS * AGED
      },
      events: {
        domain: "events" as const,
        initialState: eventInitial,
        state: advance(eventInitial, 2 * AGED),
        u32Draws: 2 * AGED
      },
      death: {
        domain: "p3e/death" as const,
        initialState: DEATH_INITIAL,
        state: advance(DEATH_INITIAL, 2 * AGED),
        u32Draws: 2 * AGED
      }
    },
    heads: {
      lastEntryHash: HEX("a"),
      lastSnapshotHash: HEX("b"),
      lastDeltaHash: HEX("c"),
      hashChain: HEX("d")
    },
    commandLog: { count: 3, headHash: HEX("e") }
  };
  return { ...draft, stateHash: computeP3EStateHash(draft as never) } as contracts.P3ELifeState;
})();

/* ------------------------------------------------------------------ */
/* 巢狀 openDecision 的 pack（重算 checksum 後仍是品牌物件）           */
/* ------------------------------------------------------------------ */

const NESTED_EVENT_ID = "ev.adult.housing-choice";
const NESTED_OPTION_ID = "rent";

function repairedEventPackWithNestedDecision(): ValidatedEventPack {
  const events = structuredClone(rawEvents);
  const event = events.find((entry) => entry.eventId === NESTED_EVENT_ID);
  if (event === undefined) throw new Error("test fixture: event missing");
  const options = (event.decision as Dict).options as Dict[];
  const option = options.find((entry) => entry.optionId === NESTED_OPTION_ID);
  if (option === undefined) throw new Error("test fixture: option missing");
  (option.effects as Dict[]).push({ type: "openDecision", decisionId: "dec.nested" });

  const manifest = structuredClone(rawEventManifest);
  const datasetChecksum = computeEventsChecksum(events as never);
  const descriptor = (manifest.datasets as Dict[])[0] as Dict;
  descriptor.recordCount = events.length;
  descriptor.checksum = datasetChecksum;
  for (const license of manifest.licenses as Dict[]) license.checksum = datasetChecksum;
  for (const record of manifest.lineage as Dict[]) {
    record.outputChecksum = datasetChecksum;
    record.inputChecksums = (record.parentLineageIds as string[]).map(() => datasetChecksum);
  }
  manifest.packChecksum = computePackChecksum(manifest as never);
  return validateEventPack({ manifest, events } as never);
}

const nestedPack = repairedEventPackWithNestedDecision();

/* ------------------------------------------------------------------ */
/* 輔助                                                                */
/* ------------------------------------------------------------------ */

function nodeAt(root: Dict, path: readonly string[]): Dict {
  let node: unknown = root;
  for (const step of path) node = (node as Dict)[step];
  return node as Dict;
}

/** 複製一個合法 state、改欄位、重算 hash（用來造「語意仍然合法但 binding 不一致」）。 */
function patchedState(source: contracts.P3ELifeState, change: (draft: Dict) => void): contracts.P3ELifeState {
  const draft = structuredClone(source) as unknown as Dict;
  change(draft);
  draft.stateHash = computeP3EStateHash(draft as never);
  return draft as unknown as contracts.P3ELifeState;
}

/** 不改 hash 的偽造 state（只給 seam 用，不會經過 readP3EState）。 */
function forgedState(source: contracts.P3ELifeState, change: (draft: Dict) => void): contracts.P3ELifeState {
  const draft = structuredClone(source) as unknown as Dict;
  change(draft);
  return draft as unknown as contracts.P3ELifeState;
}

/** 把 state 的 event binding 換成另一個 pack（age>0 才可能）。 */
function stateWithEventBinding(pack: ValidatedEventPack): contracts.P3ELifeState {
  return patchedState(agedState, (draft) => {
    const bound = bindEventPack(pack);
    nodeAt(draft, ["packs"]).events = {
      eventSchemaVersion: bound.eventSchemaVersion,
      eventSpecVersion: bound.eventSpecVersion,
      contentPackVersion: bound.contentPackVersion,
      eventPackId: bound.eventPackId,
      eventPackChecksum: bound.eventPackChecksum,
      datasetChecksum: bound.datasetChecksum,
      eventCount: bound.eventCount
    };
  });
}

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function expectThrows(run: () => unknown, code: string, path: string): void {
  const caught = caughtFrom(run);
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

function expectAnnualError(input: unknown, code: string, path: string): void {
  expectThrows(() => validateP3EAnnualPacks(input), code, path);
}

function annualInput(overrides: Dict = {}): Dict {
  return { state: agedState, eventPack, deathPack, ...overrides };
}

/* ------------------------------------------------------------------ */
/* 一、合法組合                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1a 合法組合", () => {
  it("age>0：回傳 state 快照與同一批品牌 pack", () => {
    const result = validateP3EAnnualPacks(annualInput());
    expect(result.state).toEqual(agedState);
    expect(result.state).not.toBe(agedState);
    expect(result.eventPack).toBe(eventPack);
    expect(result.deathPack).toBe(deathPack);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.eventPack)).toBe(true);
    expect(Object.isFrozen(result.deathPack)).toBe(true);
  });

  it("age=0（genesis）也可以通過", () => {
    const result = validateP3EAnnualPacks(annualInput({ state: genesisState }));
    expect(result.state).toEqual(genesisState);
    expect(result.state.age).toBe(0);
  });

  it("不修改輸入、不消耗 RNG、不執行任何交易", () => {
    const before = encodeP3EState(agedState);
    const rngBefore = structuredClone(agedState.rng);
    const result = validateP3EAnnualPacks(annualInput());
    expect(encodeP3EState(agedState)).toBe(before);
    expect(agedState.rng).toEqual(rngBefore);
    expect(result.state.rng).toEqual(rngBefore);
    expect(result.state.age).toBe(AGED);
    expect(result.state.stateHash).toBe(agedState.stateHash);
    expect(result.state.flags).toEqual(agedState.flags);
  });

  it("重複呼叫結果一致", () => {
    const first = validateP3EAnnualPacks(annualInput());
    for (let index = 0; index < 5; index += 1) {
      const next = validateP3EAnnualPacks(annualInput());
      expect(next.state).toEqual(first.state);
      expect(next.eventPack).toBe(first.eventPack);
      expect(next.deathPack).toBe(first.deathPack);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 二、固定順序                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1a 驗證順序", () => {
  it("input shape 最先", () => {
    expectAnnualError({ ...annualInput(), extra: 1 }, "E_P3E_ARGUMENT", "input");
    expectAnnualError(null, "E_P3E_ARGUMENT", "input");
  });

  it("state 錯誤早於 event pack 錯誤", () => {
    const broken = patchedState(agedState, () => undefined);
    (broken as unknown as Dict).stateHash = HEX("0");
    expectAnnualError(
      { state: broken, eventPack: structuredClone(eventPack), deathPack: structuredClone(deathPack) },
      "E_P3E_HASH",
      "stateHash"
    );
  });

  it("event pack 品牌早於 event binding", () => {
    const mismatched = patchedState(agedState, (draft) => {
      nodeAt(draft, ["packs", "events"]).contentPackVersion = "9.9.9";
    });
    expectAnnualError(
      { state: mismatched, eventPack: structuredClone(eventPack), deathPack },
      "E_P3E_EVENT_PACK",
      "eventPack"
    );
  });

  it("event binding 早於 life eligibility", () => {
    // 巢狀 pack 會違反 eligibility，但狀態的 binding 仍指向原本的 pack → 先撞 binding
    expectAnnualError(annualInput({ eventPack: nestedPack }), "E_P3E_BINDING", "packs.events.eventPackChecksum");
  });

  it("life eligibility 早於 death pack 品牌", () => {
    expectAnnualError(
      { state: stateWithEventBinding(nestedPack), eventPack: nestedPack, deathPack: structuredClone(deathPack) },
      "E_P3E_EVENT_PACK",
      `pack.events.${NESTED_EVENT_ID}.${NESTED_OPTION_ID}`
    );
  });

  it("death pack 品牌早於 death binding", () => {
    const mismatched = patchedState(agedState, (draft) => {
      nodeAt(draft, ["packs", "death"]).deathPackId = "p3d-other";
    });
    expectAnnualError(
      { state: mismatched, eventPack, deathPack: structuredClone(deathPack) },
      "E_P3E_DEATH_PACK",
      "deathPack"
    );
  });
});

/* ------------------------------------------------------------------ */
/* 三、event pack 品牌與 binding                                       */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1a event pack", () => {
  it("raw／clone／手工仿造一律拒絕", () => {
    const forged = { manifest: eventPack.manifest, events: eventPack.events };
    for (const pack of [readJson("fixtures/p3b/manifest.v1.json"), structuredClone(eventPack), forged, null, undefined]) {
      expectAnnualError(annualInput({ eventPack: pack }), "E_P3E_EVENT_PACK", "eventPack");
    }
  });

  it("七個 binding 欄位逐欄比對（seam）", () => {
    const cases: readonly [keyof contracts.P3EEventPackBinding, unknown][] = [
      ["eventSchemaVersion", "p3b-9"],
      ["eventSpecVersion", "9.9.9"],
      ["contentPackVersion", "9.9.9"],
      ["eventPackId", "p3b-other"],
      ["eventPackChecksum", HEX("9")],
      ["datasetChecksum", HEX("9")],
      ["eventCount", 5]
    ];
    expect(cases.length).toBe(7);
    for (const [field, value] of cases) {
      const state = forgedState(agedState, (draft) => {
        nodeAt(draft, ["packs", "events"])[field] = value;
      });
      expectThrows(() => assertP3EEventBinding(state, eventPack), "E_P3E_BINDING", `packs.events.${field}`);
    }
    expect(() => assertP3EEventBinding(agedState, eventPack)).not.toThrow();
  });

  it("公開入口也能擋下 shape 允許的欄位（版本欄位已被 shape 釘死）", () => {
    const cases: readonly [string, unknown][] = [
      ["contentPackVersion", "9.9.9"],
      ["eventPackId", "p3b-other"],
      ["eventPackChecksum", HEX("9")],
      ["datasetChecksum", HEX("9")],
      ["eventCount", 5]
    ];
    for (const [field, value] of cases) {
      const state = patchedState(agedState, (draft) => {
        nodeAt(draft, ["packs", "events"])[field] = value;
      });
      expectAnnualError({ state, eventPack, deathPack }, "E_P3E_BINDING", `packs.events.${field}`);
    }
    // 版本欄位被 shape 釘死：改它會先得到 shape 的固定錯誤，而不是 binding
    const pinned = patchedState(agedState, (draft) => {
      nodeAt(draft, ["packs", "events"]).eventSchemaVersion = "p3b-9";
    });
    expectAnnualError({ state: pinned, eventPack, deathPack }, "E_P3E_EVENT_PACK", "packs.events.eventSchemaVersion");
  });
});

/* ------------------------------------------------------------------ */
/* 四、life eligibility                                                */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1a life eligibility", () => {
  it("巢狀 openDecision 一律拒絕（path 指向 event／option）", () => {
    expectAnnualError(
      { state: stateWithEventBinding(nestedPack), eventPack: nestedPack, deathPack },
      "E_P3E_EVENT_PACK",
      `pack.events.${NESTED_EVENT_ID}.${NESTED_OPTION_ID}`
    );
  });

  it("原始 pack（59 個決策事件，都沒有巢狀）可以通過", () => {
    expect(() => validateP3EAnnualPacks(annualInput())).not.toThrow();
    const withDecision = eventPack.events.filter((event) => event.decision !== null);
    // GPT-0025-A／GPT-0041-A：主 pack 的決策事件增加到 59 個（每個都有 2–5 個選項）。
    expect(withDecision.length).toBe(59);
    for (const event of withDecision) {
      for (const option of event.decision?.options ?? []) {
        expect(option.effects.every((effect) => effect.type !== "openDecision")).toBe(true);
      }
    }
  });

  it("巢狀 pack 本身是合法品牌物件（證明擋下來的是 eligibility，不是 P3-B）", () => {
    expect(nestedPack.events.length).toBe(eventPack.events.length);
    expect(nestedPack.packChecksum).not.toBe(eventPack.packChecksum);
    // 同樣的 state 若改用原始 pack 就完全合法
    expect(() => validateP3EAnnualPacks(annualInput())).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 五、death pack 品牌、binding 與 entity／region                      */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1a death pack", () => {
  it("raw／clone／手工仿造一律拒絕", () => {
    const forged = { manifest: deathPack.manifest, entityIndex: deathPack.entityIndex };
    for (const pack of [readJson("fixtures/p3d/manifest.v1.json"), structuredClone(deathPack), forged, null]) {
      expectAnnualError(annualInput({ deathPack: pack }), "E_P3E_DEATH_PACK", "deathPack");
    }
  });

  it("十一個 binding 欄位逐欄比對（seam）", () => {
    const cases: readonly [keyof contracts.P3EDeathPackBinding, unknown][] = [
      ["schemaVersion", "p3d-9"],
      ["deathDataVersion", "9.9.9"],
      ["deathSpecVersion", "9.9.9"],
      ["healthRuleVersion", "p3d-health-9.9.9"],
      ["engineVersion", "9.9.9"],
      ["rngSpecVersion", "9.9.9"],
      ["deathPackId", "p3d-other"],
      ["deathPackChecksum", HEX("9")],
      ["basePackId", "p2a-other"],
      ["basePackChecksum", HEX("9")],
      ["entityCount", 173]
    ];
    expect(cases.length).toBe(11);
    for (const [field, value] of cases) {
      const state = forgedState(agedState, (draft) => {
        nodeAt(draft, ["packs", "death"])[field] = value;
      });
      expectThrows(() => assertP3EAnnualDeathBinding(state, deathPack), "E_P3E_BINDING", `packs.death.${field}`);
    }
    expect(() => assertP3EAnnualDeathBinding(agedState, deathPack)).not.toThrow();
  });

  it("公開入口也能逐欄擋下", () => {
    for (const [field, value] of [
      ["deathPackId", "p3d-other"],
      ["deathPackChecksum", HEX("9")],
      ["deathDataVersion", "9.9.9"]
    ] as const) {
      const state = patchedState(agedState, (draft) => {
        nodeAt(draft, ["packs", "death"])[field] = value;
      });
      expectAnnualError({ state, eventPack, deathPack }, "E_P3E_BINDING", `packs.death.${field}`);
    }
  });

  it("entity 不在 entityIndex／regionCode 不符 → E_P3E_BINDING at deathPack.entityIndex", () => {
    const missing = forgedState(agedState, (draft) => {
      nodeAt(draft, ["identity"]).entityId = "cr:NOT-IN-PACK";
    });
    expectThrows(() => assertP3EAnnualDeathBinding(missing, deathPack), "E_P3E_BINDING", "deathPack.entityIndex");

    const wrongRegion = forgedState(agedState, (draft) => {
      nodeAt(draft, ["identity"]).regionCode = "ZZZ";
    });
    expectThrows(() => assertP3EAnnualDeathBinding(wrongRegion, deathPack), "E_P3E_BINDING", "deathPack.entityIndex");

    const binding = deathPack.entityIndex[agedState.identity.entityId];
    expect(binding?.regionCode).toBe(agedState.identity.regionCode);
  });

  it("公開入口也能擋下 entity／region（age>0）", () => {
    const missing = patchedState(agedState, (draft) => {
      nodeAt(draft, ["identity"]).entityId = "cr:NOT-IN-PACK";
    });
    expectAnnualError({ state: missing, eventPack, deathPack }, "E_P3E_BINDING", "deathPack.entityIndex");

    const wrongRegion = patchedState(agedState, (draft) => {
      nodeAt(draft, ["identity"]).regionCode = "ZZZ";
    });
    expectAnnualError({ state: wrongRegion, eventPack, deathPack }, "E_P3E_BINDING", "deathPack.entityIndex");
  });

  it("death binding 早於 entity binding", () => {
    const state = forgedState(agedState, (draft) => {
      nodeAt(draft, ["packs", "death"]).entityCount = 173;
      nodeAt(draft, ["identity"]).entityId = "cr:NOT-IN-PACK";
    });
    expectThrows(() => assertP3EAnnualDeathBinding(state, deathPack), "E_P3E_BINDING", "packs.death.entityCount");
  });
});

/* ------------------------------------------------------------------ */
/* 六、input shape                                                     */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1a input shape", () => {
  it("多欄／缺欄／改名一律拒絕", () => {
    for (const key of ["state", "eventPack", "deathPack"]) {
      const missing = annualInput();
      delete missing[key];
      expectAnnualError(missing, "E_P3E_ARGUMENT", "input");
    }
    const renamed = annualInput();
    delete renamed.deathPack;
    renamed.packs = deathPack;
    expectAnnualError(renamed, "E_P3E_ARGUMENT", "input");
  });

  it("hidden／symbol／accessor 一律拒絕（getter 不執行）", () => {
    const hidden = annualInput();
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false, configurable: true });
    expectAnnualError(hidden, "E_P3E_ARGUMENT", "input");

    const symbol = annualInput();
    Object.defineProperty(symbol, Symbol("extra"), { value: 1, enumerable: false, configurable: true });
    expectAnnualError(symbol, "E_P3E_ARGUMENT", "input");

    const accessor = annualInput();
    const original = accessor.state;
    let invoked = false;
    Object.defineProperty(accessor, "state", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return original;
      }
    });
    expectAnnualError(accessor, "E_P3E_ARGUMENT", "input");
    expect(invoked).toBe(false);

    const hiddenRequired = annualInput();
    Object.defineProperty(hiddenRequired, "deathPack", { value: deathPack, enumerable: false, configurable: true });
    expectAnnualError(hiddenRequired, "E_P3E_ARGUMENT", "input");
  });

  it("不是 plain object 一律拒絕；null prototype 可以", () => {
    class Fake {
      public state = agedState;
    }
    for (const value of [null, undefined, 42, "input", [], [annualInput()], new Fake(), Object.create({})]) {
      expectAnnualError(value, "E_P3E_ARGUMENT", "input");
    }
    const bare = Object.assign(Object.create(null) as Dict, annualInput());
    expect(() => validateP3EAnnualPacks(bare)).not.toThrow();
  });

  it("已撤銷 Proxy 與反射 trap 只回固定錯誤", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectAnnualError(revoked.proxy, "E_P3E_ARGUMENT", "input");

    const trap = new Proxy({}, {
      getPrototypeOf() {
        throw new TypeError("proto");
      }
    });
    expectAnnualError(trap, "E_P3E_ARGUMENT", "input");

    const keysTrap = new Proxy({}, {
      ownKeys() {
        throw new TypeError("ownKeys");
      }
    });
    expectAnnualError(keysTrap, "E_P3E_ARGUMENT", "input");
  });
});

/* ------------------------------------------------------------------ */
/* 七、公開表面                                                        */
/* ------------------------------------------------------------------ */

describe("P3-E.1b-1a 公開表面", () => {
  it("入口與 seam 都不在公開 barrel", () => {
    expect(typeof validateP3EAnnualPacks).toBe("function");
    expect(typeof assertP3EEventBinding).toBe("function");
    expect(typeof assertP3EAnnualDeathBinding).toBe("function");
    const surface = simulation as unknown as Record<string, unknown>;
    expect(surface.validateP3EAnnualPacks).toBeUndefined();
    expect(surface.assertP3EEventBinding).toBeUndefined();
    expect(surface.assertP3EAnnualDeathBinding).toBeUndefined();
    const functions = Object.entries(surface)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["P3EError", "P3EReplayDivergenceError", "appendP3ELedgerHistory", "createP3EGenesis", "createP3ELedgerHistory", "decodeP3ESessionPayload", "encodeP3ESessionPayload", "executeP3ECommand", "isP3EError", "replayP3ELedgerHistory"]);
  });
});
