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
import * as contracts from "@life-sim/contracts";
import { createP3EGenesis } from "../src/genesis";
import { executeP3ECommand } from "../src/command-executor";

/**
 * GPT-0032-A｜兒童金錢漏洞（阻擋缺陷 1）真實整合測試。
 *
 * 全部走正式 `executeP3ECommand`（Roll → 事件抽選 → effects → Core Draft → seal）：
 *
 * 1. 0–15 歲能觸發的 balance／income／expense 事件，命令完成後三項仍為 0；
 * 2. 兒童決策 option 的 money effects 同樣不能漏出；
 * 3. 16／17 歲只有明確兼職／所得效果才可有收入（規則不誤殺青少年所得）；
 * 4. 兒童事件的其他 stats／flags 效果照常生效（不是整個事件被丟棄）。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const SEED = "p3e-166-playable-runtime-v4";
const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

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

const peerGroup = buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never);
const certificate = createBirthCertificate(base, identityPack, peerGroup, SEED);

/** 永遠成立的條件（避免模板事件本身的條件把測試事件濾掉）。 */
const ALWAYS: Dict = { op: "stat", stat: "health", min: 0, max: 100 };

function ordinaryTemplate(): Dict {
  const template = rawEvents.find((event) => event.kind === "ordinary");
  if (template === undefined) throw new Error("missing ordinary template");
  return structuredClone(template);
}

function decisionTemplate(): Dict {
  const template = rawEvents.find((event) => event.kind === "decision");
  if (template === undefined) throw new Error("missing decision template");
  return structuredClone(template);
}

/** 重算 checksum／license／lineage 後重新驗證的 event pack（events 依 eventId 升冪）。 */
function repairedEventPack(records: readonly Dict[]): ValidatedEventPack {
  const events = structuredClone(records as Dict[]).sort((left, right) => (String(left.eventId) < String(right.eventId) ? -1 : 1));
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

/** 兒童期、帶三種 money effects ＋ stats／flag 的事件。 */
function childMoneyEvent(): Dict {
  return {
    ...ordinaryTemplate(),
    eventId: "ev.test.child-money",
    lifeStages: ["childhood"],
    ageMin: 0,
    ageMax: 15,
    weight: 1000,
    exclusiveGroup: null,
    once: false,
    cooldownYears: 0,
    conditions: ALWAYS,
    decision: null,
    effects: [
      { type: "money", field: "balanceMicroUsd", deltaMicroUsd: "5000000000" },
      { type: "money", field: "annualIncomeMicroUsd", deltaMicroUsd: "2000000000" },
      { type: "money", field: "annualExpenseMicroUsd", deltaMicroUsd: "1000000000" },
      { type: "stat", stat: "happiness", delta: 2 },
      { type: "flag", flag: "test:child-money", action: "add" }
    ]
  };
}

/** 兒童期、有 money effects 的決策事件。 */
function childDecisionEvent(): Dict {
  const clone = decisionTemplate();
  clone.eventId = "ev.test.child-decision-money";
  clone.lifeStages = ["childhood"];
  clone.ageMin = 0;
  clone.ageMax = 15;
  clone.weight = 1000;
  clone.exclusiveGroup = null;
  clone.once = false;
  clone.cooldownYears = 0;
  clone.conditions = ALWAYS;
  const decision = clone.decision as Dict;
  const list = decision.options as Dict[];
  const first = list[0] as Dict;
  first.effects = [
    { type: "money", field: "balanceMicroUsd", deltaMicroUsd: "7000000000" },
    { type: "money", field: "annualIncomeMicroUsd", deltaMicroUsd: "3000000000" },
    { type: "stat", stat: "knowledge", delta: 3 }
  ];
  for (const option of list.slice(1)) option.effects = [];
  clone.effects = [{ type: "openDecision", decisionId: decision.decisionId as string }];
  return clone;
}

/** 16／17 歲可觸發、帶 income 效果與兼職旗標的事件（合法青少年所得）。 */
function teenIncomeEvent(): Dict {
  return {
    ...ordinaryTemplate(),
    eventId: "ev.test.teen-income",
    lifeStages: ["adolescence"],
    ageMin: 16,
    ageMax: 17,
    weight: 1000,
    exclusiveGroup: null,
    once: false,
    cooldownYears: 0,
    conditions: ALWAYS,
    decision: null,
    effects: [
      { type: "money", field: "annualIncomeMicroUsd", deltaMicroUsd: "1800000000" },
      { type: "flag", flag: "teen:earned", action: "add" }
    ]
  };
}

function genesisFor(eventPack: ValidatedEventPack) {
  return createP3EGenesis({
    masterSeed: SEED,
    basePack: base,
    identityPack,
    certificate,
    eventPack,
    deathPack
  } as never);
}

function step(state: contracts.P3ELifeState, pack: ValidatedEventPack) {
  if (state.phase === "pending_decision") {
    const optionId = state.pendingDecision?.optionIds[0] as string;
    return executeP3ECommand({ state, eventPack: pack, deathPack, command: { type: "CHOOSE_DECISION", optionId } } as never);
  }
  return executeP3ECommand({ state, eventPack: pack, deathPack, command: { ...ADVANCE } } as never);
}

function zeroAssets(assets: contracts.P3EAssets): boolean {
  return assets.balanceMicroUsd === 0n && assets.annualIncomeMicroUsd === 0n && assets.annualExpenseMicroUsd === 0n;
}

describe("GPT-0032-A 兒童金錢：事件 effects 不得漏進個人帳本", () => {
  it("0–15 歲觸發帶 balance／income／expense 的事件後，三項仍為 0；stats／flags 照常生效", () => {
    const pack = repairedEventPack([childMoneyEvent()]);
    let state = genesisFor(pack);
    let sawEvent = 0;
    for (let age = 1; age <= 15; age += 1) {
      state = step(state, pack).state;
      expect(state.age).toBe(age);
      expect(zeroAssets(state.assets), `age ${age}`).toBe(true);
      if (state.flags.includes("test:child-money")) sawEvent += 1;
    }
    expect(sawEvent, "至少要有一次兒童事件被觸發").toBeGreaterThan(0);
    expect(state.flags).toContain("test:child-money");
    expect(state.occurrences.some((entry) => entry.eventId === "ev.test.child-money")).toBe(true);
  });

  it("兒童決策 option 的 money effects 同樣不會漏出（CHOOSE_DECISION 後仍為 0）", () => {
    const pack = repairedEventPack([childDecisionEvent(), childMoneyEvent()]);
    let state = genesisFor(pack);
    let decided = 0;
    for (let stepIndex = 0; stepIndex < 80 && state.age < 16 && state.phase !== "death"; stepIndex += 1) {
      const wasPending = state.phase === "pending_decision";
      state = step(state, pack).state;
      if (wasPending) {
        decided += 1;
        expect(state.phase).toBe("life");
      }
      if (state.age < 16) expect(zeroAssets(state.assets), `age ${state.age}`).toBe(true);
    }
    expect(decided, "至少要做一次兒童決策").toBeGreaterThan(0);
  });

  it("16 歲：明確所得效果可以留下收入（規則不誤殺青少年所得）", () => {
    const pack = repairedEventPack([teenIncomeEvent()]);
    let state = genesisFor(pack);
    while (state.age < 16 && state.phase !== "death") state = step(state, pack).state;
    expect(state.age).toBe(16);
    if (state.flags.includes("teen:earned")) {
      expect(state.assets.annualIncomeMicroUsd).toBeGreaterThan(0n);
      expect(state.assets.annualExpenseMicroUsd).toBe(0n);
    } else {
      expect(state.assets.annualIncomeMicroUsd).toBe(0n);
    }
    expect(state.assets.balanceMicroUsd).toBeGreaterThanOrEqual(0n);
  });

  it("15 歲以前，任何事件都不會讓 balance／income／expense 變成非 0", () => {
    const pack = repairedEventPack([childMoneyEvent(), childDecisionEvent()]);
    let state = genesisFor(pack);
    for (let stepIndex = 0; stepIndex < 100 && state.age < 16 && state.phase !== "death"; stepIndex += 1) {
      state = step(state, pack).state;
      if (state.age < 16) expect(zeroAssets(state.assets), `age ${state.age}`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* GPT-0033-A：兒童 modifier 不得跨到 16 歲                             */
/* ------------------------------------------------------------------ */

const INCOME_MOD = contracts.P3E_INCOME_MODIFIER_FLAG_PREFIX;
const EXPENSE_MOD = contracts.P3E_EXPENSE_MODIFIER_FLAG_PREFIX;

function modifierFlags(flags: readonly string[]): readonly string[] {
  return flags.filter((flag) => flag.startsWith(INCOME_MOD) || flag.startsWith(EXPENSE_MOD));
}

describe("GPT-0033-A 兒童 modifier 不得跨到 16 歲", () => {
  it("同一角色兒童期反覆觸發金錢事件，跨入 16 歲後沒有 modifier、也沒有個人金錢", () => {
    // 只放兒童事件（0–15），因此 16 歲不會有任何青少年所得事件。
    const pack = repairedEventPack([childMoneyEvent()]);
    let state = genesisFor(pack);
    for (let age = 1; age <= 15; age += 1) state = step(state, pack).state;
    expect(state.age).toBe(15);
    expect(zeroAssets(state.assets)).toBe(true);
    expect(modifierFlags(state.flags), "15 歲不得有個人 modifier").toEqual([]);
    // 事件確實反覆觸發（weight 1000、每年都可重複），stats／flags／occurrences 都在。
    expect(state.flags).toContain("test:child-money");
    expect(state.occurrences.some((entry) => entry.eventId === "ev.test.child-money")).toBe(true);

    // 跨入 16 歲：沒有 teen／job／part-time 所得事件。
    state = step(state, pack).state;
    expect(state.age).toBe(16);
    expect(modifierFlags(state.flags), "16 歲仍不得有兒童期 modifier").toEqual([]);
    expect(zeroAssets(state.assets), "16 歲沒有合法所得時仍為 0").toBe(true);
    // stats／普通 flags／occurrences 仍保留。
    expect(state.flags).toContain("test:child-money");
    expect(state.occurrences.some((entry) => entry.eventId === "ev.test.child-money")).toBe(true);
  });

  it("兒童期有金錢事件，16 歲當期觸發合法兼職效果：只保留 16 歲的效果", () => {
    const pack = repairedEventPack([childMoneyEvent(), teenIncomeEvent()]);
    let state = genesisFor(pack);
    for (let age = 1; age <= 15; age += 1) state = step(state, pack).state;
    expect(modifierFlags(state.flags)).toEqual([]);

    state = step(state, pack).state;
    expect(state.age).toBe(16);
    expect(state.flags).toContain("teen:earned");
    // 只有 16 歲當期的 1,800,000,000 micro-USD（= 1,800 美元），沒有兒童期的 2,000,000,000。
    expect(contracts.readP3EMoneyModifierMicroUsd(state.flags, "income")).toBe(1_800_000_000n);
    expect(contracts.readP3EMoneyModifierMicroUsd(state.flags, "expense")).toBe(0n);
    expect(state.assets.annualIncomeMicroUsd).toBe(1_800_000_000n);
    expect(state.assets.annualExpenseMicroUsd).toBe(0n);
    // 兒童期的事件效果（happiness／flag／occurrence）仍在。
    expect(state.flags).toContain("test:child-money");
  });

  it("兒童決策 option 的 income／expense effects 也不會跨到 16 歲", () => {
    const pack = repairedEventPack([childDecisionEvent(), childMoneyEvent()]);
    let state = genesisFor(pack);
    let decided = 0;
    for (let stepIndex = 0; stepIndex < 120 && state.age < 16 && state.phase !== "death"; stepIndex += 1) {
      const wasPending = state.phase === "pending_decision";
      state = step(state, pack).state;
      if (wasPending) decided += 1;
    }
    expect(decided, "至少要做一次兒童決策").toBeGreaterThan(0);
    expect(state.age).toBe(16);
    expect(modifierFlags(state.flags), "兒童決策不得留下 modifier").toEqual([]);
    expect(zeroAssets(state.assets), "16 歲沒有合法所得時仍為 0").toBe(true);
  });

  it("成年事件的 modifier 仍然持續（回歸：沒有把合法加成一起關掉）", () => {
    const pack = repairedEventPack([teenIncomeEvent()]);
    let state = genesisFor(pack);
    while (state.age < 16 && state.phase !== "death") state = step(state, pack).state;
    expect(state.flags).toContain("teen:earned");
    const incomeAt16 = contracts.readP3EMoneyModifierMicroUsd(state.flags, "income");
    expect(incomeAt16).toBeGreaterThan(0n);
    // 17 歲重新結算：既有 modifier 先保留，17 歲的兼職事件再加一筆（合法累積）。
    state = step(state, pack).state;
    expect(state.age).toBe(17);
    const incomeAt17 = contracts.readP3EMoneyModifierMicroUsd(state.flags, "income");
    expect(incomeAt17).toBe(incomeAt16 * 2n);
    const base = contracts.computeP3EBaseEconomy(17, state.stats.knowledge, state.flags, null);
    expect(base.status).toBe("part_time");
    expect(state.assets.annualIncomeMicroUsd).toBe(base.annualIncomeMicroUsd + incomeAt17);
  });
});
