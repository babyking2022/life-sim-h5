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
import * as contracts from "@life-sim/contracts";
import {
  createP3EPlaySession,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";

/**
 * GPT-DEEPSEEK-0036-A｜百分位的 view projection 測試。
 *
 * 走正式 application session（不是只單測契約函式），確認：
 * - `view.percentiles` 真的公開 income／wealth 兩個欄位；
 * - 兒童（age < 16／18）是 unavailable，不會顯示名次；
 * - 成年就業者 income 可用、wealth 可用，且字串格式與 metadata 正確；
 * - view 可 JSON 序列化（沒有 bigint）、深層凍結。
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

const SEED = "p3e-166-playable-runtime-v4";
const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

function session(): P3EPlaySession {
  const group = buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never);
  const certificate = createBirthCertificate(base, identityPack, group, SEED);
  return createP3EPlaySession({
    masterSeed: SEED,
    basePack: base,
    identityPack,
    certificate,
    eventPack,
    deathPack
  });
}

function step(current: P3EPlaySession): P3EPlaySession {
  if (current.state.phase === "pending_decision") {
    return runP3EPlaySessionCommand({
      session: current,
      command: { type: "CHOOSE_DECISION", optionId: current.state.pendingDecision?.optionIds[0] as string }
    }).session;
  }
  return runP3EPlaySessionCommand({ session: current, command: { ...ADVANCE } }).session;
}

function atAge(target: number): P3EPlaySession {
  let current = session();
  while (current.state.age < target && current.state.phase !== "death") current = step(current);
  return current;
}

describe("GPT-0036-A view.percentiles", () => {
  it("出生時公開兩個欄位，且都是 unavailable（不把兒童顯示成收入／資產名次）", () => {
    const view = session().view;
    expect(Object.keys(view.percentiles).sort()).toEqual(["income", "wealth"]);
    expect(view.percentiles.income.available).toBe(false);
    expect(view.percentiles.income.reason).toBe("age_below_minimum");
    expect(view.percentiles.income.chinaPercent).toBeNull();
    expect(view.percentiles.income.meta).toBeNull();
    expect(view.percentiles.income.summary).toBe("估算不可用");
    expect(view.percentiles.wealth.available).toBe(false);
    expect(view.percentiles.wealth.reason).toBe("age_below_minimum");
  });

  it("成年就業者：income／wealth 都可用，數字在 0–99.9，字串格式正確", () => {
    const view = atAge(30).view;
    expect(view.percentiles.income.available).toBe(true);
    expect(view.percentiles.income.chinaPercent).toBeGreaterThanOrEqual(0);
    expect(view.percentiles.income.chinaPercent).toBeLessThanOrEqual(99.9);
    expect(view.percentiles.income.globalPercent).toBeGreaterThanOrEqual(0);
    expect(view.percentiles.income.summary).toMatch(/^高於中國 \d+%｜高於全球 \d+%$/);
    expect(view.percentiles.income.meta?.estimate).toBe(true);
    expect(view.percentiles.income.meta?.basisYear).toBe(contracts.P3E_PERCENTILE_BASIS_YEAR);
    expect(view.percentiles.income.meta?.unit).toBe("micro-USD");
    expect(view.percentiles.wealth.available).toBe(true);
    expect(view.percentiles.wealth.meta?.metric).toBe("net-financial-wealth");
    // GPT-DEEPSEEK-0037-A：view 的 metadata 要自帶來源與 MVP 估算標記。
    expect(view.percentiles.income.meta?.dataStatus).toBe("mvp_estimate");
    expect(view.percentiles.income.meta?.sourceLabel).toContain("World Bank PIP");
    expect(view.percentiles.income.meta?.sourceUrl).toBe("https://pip.worldbank.org/");
    expect(view.percentiles.wealth.meta?.dataStatus).toBe("mvp_estimate");
    expect(view.percentiles.wealth.meta?.sourceLabel).toContain("World Inequality Database");
    expect(view.percentiles.wealth.meta?.sourceUrl).toBe("https://wid.world/");
    expect(view.percentiles.income.meta?.sourceUrl).not.toBe(view.percentiles.wealth.meta?.sourceUrl);
  });

  it("16／17 歲：income 可用性跟著實際收入走（沒有收入就是 unavailable）", () => {
    const view = atAge(16).view;
    // 青少年期沒有兼職收入時，income 必須 unavailable（no_income），而不是顯示名次。
    if (view.assets.annualIncomeMicroUsd === "0") {
      expect(view.percentiles.income.available).toBe(false);
      expect(["no_income", "not_employed"]).toContain(view.percentiles.income.reason);
    } else {
      expect(view.percentiles.income.available).toBe(true);
    }
    // 資產 18 歲才可用。
    expect(view.percentiles.wealth.available).toBe(false);
  });

  it("view 深層凍結、可 JSON 序列化（沒有 bigint）", () => {
    const view = atAge(30).view;
    expect(Object.isFrozen(view.percentiles)).toBe(true);
    expect(Object.isFrozen(view.percentiles.income)).toBe(true);
    expect(() => JSON.parse(JSON.stringify(view))).not.toThrow();
    const serialized = JSON.stringify(view.percentiles);
    expect(serialized).not.toContain("bigint");
    expect(serialized).toContain("estimate\":true");
  });
});
