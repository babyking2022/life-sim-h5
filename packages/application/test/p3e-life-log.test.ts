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
  P3E_LIFE_LOG_KINDS,
  P3E_LIFE_LOG_MAX_ENTRIES,
  appendP3ELifeLogEntry,
  birthLifeLogEntry,
  buildP3ELifeLog,
  isP3ELifeLog,
  isP3ELifeLogEntry,
  type P3ELifeLogEntry
} from "../src/p3e-life-log";
import {
  createP3EPlaySession,
  exportP3EPlaySessionPayload,
  restoreP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";

/**
 * GPT-0031-A｜可累積的人生紀錄（`lifeLog`）回歸測試。
 *
 * 全部走正式 application／simulation 入口；重點：
 *
 * - 逐年累加、最新在前、最多 `P3E_LIFE_LOG_MAX_ENTRIES` 筆；
 * - 事件／決策／重心／死亡都留下可翻譯的公開 ID，不含繁中文字；
 * - 失敗命令不產生紀錄；
 * - 存檔復原後由 ledger／commands 重建，與復原前逐位元相同；
 * - 同 seed 同 commands → 同 state hash 與同 lifeLog；
 * - 輸出 immutable、可 JSON 序列化（沒有 bigint）。
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
const peerGroup = buildPeerGroup(base, identityPack, { seed: SEED, playerSexPolicy: "random" } as never);
const certificate = createBirthCertificate(base, identityPack, peerGroup, SEED);

function officialSession(seed = SEED): P3EPlaySession {
  // certificate 綁定 seed，因此換 seed 要重新產生 peer group 與 certificate。
  const group = seed === SEED ? peerGroup : buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
  const bound = seed === SEED ? certificate : createBirthCertificate(base, identityPack, group, seed);
  return createP3EPlaySession({
    masterSeed: seed,
    basePack: base,
    identityPack,
    certificate: bound,
    eventPack,
    deathPack
  });
}

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

function step(session: P3EPlaySession, command: unknown): P3EPlaySession {
  return runP3EPlaySessionCommand({ session, command }).session;
}

function nextCommand(session: P3EPlaySession): Record<string, unknown> {
  if (session.state.phase === "pending_decision") {
    return { type: "CHOOSE_DECISION", optionId: session.state.pendingDecision?.optionIds[0] as string };
  }
  return ADVANCE;
}

function playToDeath(session: P3EPlaySession): P3EPlaySession {
  let current = session;
  while (current.state.phase !== "death") current = step(current, nextCommand(current));
  return current;
}

function json(entries: readonly P3ELifeLogEntry[]): string {
  return JSON.stringify(entries);
}

describe("GPT-0031-A lifeLog：累積與順序", () => {
  it("出生就有 1 筆 birth；每執行一個成功命令就多 1 筆，最新在最前面", () => {
    let session = officialSession();
    expect(session.view.lifeLog).toHaveLength(1);
    expect(session.view.lifeLog[0]?.kind).toBe("birth");
    expect(session.view.lifeLog[0]?.age).toBe(0);
    expect(session.view.lifeLog[0]?.year).toBe(session.state.identity.birthYear);

    for (let index = 1; index <= 5; index += 1) {
      session = step(session, nextCommand(session));
      expect(session.view.lifeLog, `step ${index}`).toHaveLength(index + 1);
      // 最新在前：seq 遞減。
      const log = session.view.lifeLog;
      for (let position = 1; position < log.length; position += 1) {
        expect((log[position - 1] as P3ELifeLogEntry).seq).toBeGreaterThan((log[position] as P3ELifeLogEntry).seq);
      }
      expect(log[0]?.seq).toBe(index + 1);
    }
  });

  it("每筆都是合法、深層凍結、可 JSON 序列化的紀錄（沒有 bigint／繁中文字串）", () => {
    const session = playToDeath(officialSession());
    const log = session.view.lifeLog;
    expect(log.length).toBeGreaterThan(20);
    expect(isP3ELifeLog(log)).toBe(true);
    for (const entry of log) {
      expect(isP3ELifeLogEntry(entry)).toBe(true);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.keys(entry).sort()).toEqual([
        "age",
        "causeId",
        "deathReason",
        "decisionId",
        "detailId",
        "eventId",
        "focusId",
        "kind",
        "optionId",
        "seq",
        "year"
      ]);
      for (const value of Object.values(entry)) {
        expect(typeof value === "string" || typeof value === "number" || value === null).toBe(true);
      }
    }
    expect(Object.isFrozen(log)).toBe(true);
    // 可 JSON 序列化（沒有 bigint、沒有循環）。
    expect(() => JSON.parse(json(log))).not.toThrow();
  });

  it("事件／決策／重心／死亡都會留下可翻譯的公開 ID", () => {
    let session = officialSession();
    // 7 歲設定重心。
    while (session.state.age < 7) session = step(session, nextCommand(session));
    session = step(session, { type: "SET_LIFE_FOCUS", focusId: "study" });
    const focusEntry = session.view.lifeLog[0] as P3ELifeLogEntry;
    expect(focusEntry.kind).toBe("focus");
    expect(focusEntry.focusId).toBe("study");

    const dead = playToDeath(session);
    const log = dead.view.lifeLog;
    const kinds = new Set(log.map((entry) => entry.kind));
    expect(kinds.has("focus")).toBe(true);
    expect(kinds.has("death")).toBe(true);
    // 死亡紀錄：age／year 與最終 state 一致，且有死因與原因分類。
    const death = log[0] as P3ELifeLogEntry;
    expect(death.kind).toBe("death");
    expect(death.age).toBe(dead.state.age);
    expect(death.year).toBe(dead.state.currentYear);
    expect(death.deathReason === "mortality" || death.deathReason === "age_ceiling").toBe(true);
    if (death.deathReason === "mortality") expect(typeof death.causeId).toBe("string");

    // 決策紀錄一定帶 optionId（UI 可以查文案）。
    const decision = log.find((entry) => entry.kind === "decision");
    expect(decision).toBeDefined();
    expect(typeof decision?.optionId).toBe("string");
    expect(typeof decision?.eventId).toBe("string");

    // 每一筆 kind 都在契約清單裡。
    for (const entry of log) expect(P3E_LIFE_LOG_KINDS).toContain(entry.kind);
  });

  it("失敗命令不會產生紀錄", () => {
    const session = officialSession();
    const before = json(session.view.lifeLog);
    // life phase 不能 CHOOSE_DECISION。
    expect(() => runP3EPlaySessionCommand({ session, command: { type: "CHOOSE_DECISION", optionId: "save" } })).toThrow();
    expect(json(session.view.lifeLog)).toBe(before);
    // 非法 focusId 也不能寫紀錄。
    expect(() => runP3EPlaySessionCommand({ session, command: { type: "SET_LIFE_FOCUS", focusId: "nope" } })).toThrow();
    expect(json(session.view.lifeLog)).toBe(before);
  });
});

describe("GPT-0031-A lifeLog：復原、決定性與上限", () => {
  it("存檔復原後 lifeLog 與復原前逐位元相同", () => {
    const played = playToDeath(officialSession());
    const payload = exportP3EPlaySessionPayload({ session: played });
    const restored = restoreP3EPlaySessionPayload({
      payload,
      masterSeed: SEED,
      basePack: base,
      identityPack,
      certificate,
      eventPack,
      deathPack
    });
    expect(json(restored.view.lifeLog)).toBe(json(played.view.lifeLog));
    expect(restored.view.lifeLog).toHaveLength(played.view.lifeLog.length);
    // 年份區間與死亡紀錄也要一致。
    const restoredDeath = restored.view.lifeLog[0] as P3ELifeLogEntry;
    const playedDeath = played.view.lifeLog[0] as P3ELifeLogEntry;
    expect(restoredDeath).toEqual(playedDeath);
  });

  it("同 seed、同 commands → 相同 state hash 與相同 lifeLog", () => {
    const first = playToDeath(officialSession());
    const second = playToDeath(officialSession());
    expect(second.state.stateHash).toBe(first.state.stateHash);
    expect(json(second.view.lifeLog)).toBe(json(first.view.lifeLog));
  });

  it("不同 seed 的 lifeLog 不會逐項相同（紀錄跟著這一條命走）", () => {
    const a = playToDeath(officialSession("p3e-166-playable-runtime-v4"));
    const b = playToDeath(officialSession("gpt-0031-life-log-other-seed"));
    expect(json(a.view.lifeLog)).not.toBe(json(b.view.lifeLog));
  });

  it("上限 256 筆：超過時保留最新者（舊的會被截掉）", () => {
    // 用純投影函式驗證上限（真實人生只有 ~100 個命令）。
    const entries: P3ELifeLogEntry[] = [birthLifeLogEntry(2020)];
    let current: readonly P3ELifeLogEntry[] = entries;
    for (let index = 0; index < P3E_LIFE_LOG_MAX_ENTRIES + 40; index += 1) {
      current = appendP3ELifeLogEntry(current, 2021 + index, 1 + (index % 100), {
        kind: "set_life_focus",
        focusId: "study",
        changedYear: 2021 + index
      } as never);
      expect(current.length).toBeLessThanOrEqual(P3E_LIFE_LOG_MAX_ENTRIES);
    }
    expect(current).toHaveLength(P3E_LIFE_LOG_MAX_ENTRIES);
    // 最新的 seq 一定在、最舊的被截掉。
    const maxSeq = Math.max(...current.map((entry) => entry.seq));
    expect(current[0]?.seq).toBe(maxSeq);
    expect(current.some((entry) => entry.seq === 1)).toBe(false);
    expect(Object.isFrozen(current)).toBe(true);
  });

  it("buildP3ELifeLog 與逐筆 append 的結果一致（同一組來源）", () => {
    let session = officialSession();
    const sources: { year: number; age: number; outcome: never }[] = [];
    while (session.state.phase !== "death") {
      const before = session;
      const commandResult = runP3EPlaySessionCommand({ session: before, command: nextCommand(before) });
      session = commandResult.session;
      sources.push({
        year: commandResult.yearRecord.year,
        age: commandResult.yearRecord.age,
        outcome: commandResult.session.lastOutcome as never
      });
    }
    const rebuilt = buildP3ELifeLog(session.state.identity.birthYear, sources as never, SEED);
    expect(json(rebuilt)).toBe(json(session.view.lifeLog));
  });
});
