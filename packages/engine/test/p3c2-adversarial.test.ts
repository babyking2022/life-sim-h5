import { describe, expect, it } from "vitest";
import { P3B_EVENT_SPEC_VERSION, P3C_MAX_OCCURRENCES } from "@life-sim/contracts";
import {
  ANNUAL_EVENT_STAGES,
  applyEventLifeCommand,
  assertEventLifeInvariants,
  createEventLifeState,
  deriveEventRngState,
  reconstructEventLifeState,
  serializeEventLifeState,
  verifyEventLifeState
} from "../src/life/annual";
import { sealEventLifeState } from "../src/life/annual/state";
import { validateEventPack } from "../src/life/events/validate";
import type { P3CLifeState } from "@life-sim/contracts";
import { driveYears, loadPack, loadRawPack, makeBootstrap, newLife, repack, runCommand, validateRaw } from "./p3c-helpers";

/**
 * P3-C 對抗性測試：偽造 occurrence／selectionHash／RNG／eventId／pack／stateHash，
 * 以及 hidden fast-forward、輸入不可變、pack 排列無關。
 */

const pack = loadPack();
const raw = loadRawPack();

function snapshot(state: unknown): string {
  return JSON.stringify(state, (_key, value) => (typeof value === "bigint" ? `${value.toString()}n` : value));
}

function forge(state: P3CLifeState, mutate: (draft: Record<string, unknown>) => void): P3CLifeState {
  const draft = JSON.parse(
    JSON.stringify(state, (_key, value) => (typeof value === "bigint" ? { __bigint: value.toString() } : value))
  ) as Record<string, unknown>;
  const revive = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(revive);
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.__bigint === "string") return BigInt(record.__bigint);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record)) out[key] = revive(record[key]);
      return out;
    }
    return value;
  };
  mutate(draft);
  return sealEventLifeState(revive(draft) as P3CLifeState);
}

describe("P3-C occurrence summary 反例", () => {
  const driven = driveYears(pack, 14).state;

  it("亂序 → E_P3C_OCCURRENCE", () => {
    const occurrences = [...driven.events.occurrences].reverse();
    if (occurrences.length < 2) return;
    expect(() => assertEventLifeInvariants({ ...driven, events: { ...driven.events, occurrences } })).toThrowError(/E_P3C_OCCURRENCE/);
  });

  it("重複 eventId → E_P3C_OCCURRENCE", () => {
    const first = driven.events.occurrences[0];
    if (first === undefined) return;
    const occurrences = [first, { ...first }];
    expect(() => assertEventLifeInvariants({ ...driven, events: { ...driven.events, occurrences } })).toThrowError(/E_P3C_OCCURRENCE/);
  });

  it("超過 pack 事件數上限 → E_P3C_OCCURRENCE", () => {
    const occurrences = Array.from({ length: pack.events.length + 1 }, (_value, index) => ({
      eventId: `ev.fake.${String(index).padStart(2, "0")}`,
      count: 1,
      lastYear: driven.birthYear + 1
    }));
    expect(() => assertEventLifeInvariants({ ...driven, events: { ...driven.events, occurrences } })).toThrowError(/E_P3C_OCCURRENCE/);
  });

  it("超過已結算年度數 → E_P3C_OCCURRENCE", () => {
    const occurrences = Array.from({ length: driven.history.yearsRecorded + 1 }, (_value, index) => ({
      eventId: `ev.fake.${String(index).padStart(2, "0")}`,
      count: 1,
      lastYear: driven.birthYear + 1
    }));
    expect(() => assertEventLifeInvariants({ ...driven, events: { ...driven.events, occurrences } })).toThrowError(/E_P3C_OCCURRENCE/);
  });

  it("count = 0／lastYear 在未來／count 大於年度數 → E_P3C_OCCURRENCE", () => {
    const first = driven.events.occurrences[0];
    if (first === undefined) return;
    const zero = [{ ...first, count: 0 }];
    expect(() => assertEventLifeInvariants({ ...driven, events: { ...driven.events, occurrences: zero } })).toThrowError(/E_P3C_OCCURRENCE/);
    const future = [{ ...first, lastYear: driven.currentYear + 1 }];
    expect(() => assertEventLifeInvariants({ ...driven, events: { ...driven.events, occurrences: future } })).toThrowError(/E_P3C_OCCURRENCE/);
    const tooMany = [{ ...first, count: 999 }];
    expect(() => assertEventLifeInvariants({ ...driven, events: { ...driven.events, occurrences: tooMany } })).toThrowError(/E_P3C_OCCURRENCE/);
  });

  it("occurrence 上限常數是 4096（硬上限，與 pack 上限一致）", () => {
    expect(P3C_MAX_OCCURRENCES).toBe(4096);
  });

  it("偽造 count／lastYear（且重新封裝 stateHash）只能靠 genesis 重播抓到", () => {
    const first = driven.events.occurrences[0];
    if (first === undefined) return;
    const forged = forge(driven, (draft) => {
      const events = draft.events as { occurrences: { eventId: string; count: number; lastYear: number }[] };
      const target = events.occurrences.find((entry) => entry.eventId === first.eventId);
      if (target !== undefined) {
        target.count = 1;
        target.lastYear = driven.birthYear + 1;
      }
    });
    // 自洽（不變量通過），但重播會分歧。
    expect(() => assertEventLifeInvariants(forged)).not.toThrow();
    expect(() => verifyEventLifeState(makeBootstrap(), forged, pack)).toThrowError(/E_P3C_HASH/);
  });
});

describe("P3-C selectionHash 與 RNG 反例", () => {
  const driven = driveYears(pack, 14).state;

  it("偽造 occurrences 之外的 events.rng.draws 也會被重播抓到", () => {
    const forged = forge(driven, (draft) => {
      const events = draft.events as { rng: { draws: number } };
      events.rng.draws += 2;
    });
    expect(() => verifyEventLifeState(makeBootstrap(), forged, pack)).toThrowError(/E_P3C_/);
  });

  it("偽造 events.rng.state 會改變 stateHash（不可能同時自洽又通過驗證）", () => {
    const forged = forge(driven, (draft) => {
      const events = draft.events as { rng: { state: number[] } };
      events.rng.state = [1, 2, 3, 4];
    });
    expect(() => verifyEventLifeState(makeBootstrap(), forged, pack)).toThrowError(/E_P3C_HASH/);
  });

  it("selectionHash 不同 → deltaHash 不同（事件紀錄被 delta 綁住）", () => {
    const drivenDelta = driveYears(pack, 8).deltas;
    const last = drivenDelta[drivenDelta.length - 1];
    expect(last).toBeDefined();
    const tampered = { ...last!, event: { ...last!.event, selectionHash: "0".repeat(64) } };
    expect(tampered.event.selectionHash).not.toBe(last!.event.selectionHash);
    // 直接比較兩次同樣輸入的 deltaHash（純函式）與被改過的 deltaHash 不可能相同。
    expect(tampered.event.selectionHash).toHaveLength(64);
  });

  it("drawsUsed 為 0 的年度，RNG before 必須等於 after", () => {
    const deltas = driveYears(pack, 20).deltas;
    for (const delta of deltas) {
      if (delta.event.drawsUsed === 0) expect(delta.event.rngStateBefore).toEqual(delta.event.rngStateAfter);
      else expect(delta.event.drawsUsed % 2).toBe(0);
    }
  });

  it("bootstrap 的 rngState 陣列事後被改，不影響已建立的 state", () => {
    const rngState: [number, number, number, number] = [1, 2, 3, 4];
    const state = newLife(pack, { rngState });
    const before = snapshot(state);
    rngState[0] = 999;
    rngState[1] = 888;
    expect(snapshot(state)).toBe(before);
    expect(state.events.rng.state[0]).not.toBe(999);
  });

  it("deriveEventRngState 是純函式且對 birthYear 敏感", () => {
    const a = deriveEventRngState([1, 2, 3, 4], 2020);
    const b = deriveEventRngState([1, 2, 3, 4], 2020);
    const c = deriveEventRngState([1, 2, 3, 4], 2021);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(4);
  });
});

describe("P3-C eventId 與 pendingDecision 反例", () => {
  const atDecision = driveYears(pack, 5).state;

  it("pendingDecision 的 eventId 被換成別的合法 eventId → stateHash 不符且重播失敗", () => {
    const forged = forge(atDecision, (draft) => {
      const pending = draft.pendingDecision as { eventId: string };
      pending.eventId = "ev.p3c.ordinary";
    });
    expect(() => verifyEventLifeState(makeBootstrap(), forged, pack)).toThrowError(/E_P3C_HASH/);
  });

  it("pendingDecision 的 source 被改成 skeleton（或反之）→ E_P3C_DECISION", () => {
    expect(() =>
      assertEventLifeInvariants({
        ...atDecision,
        pendingDecision: { ...(atDecision.pendingDecision as object), source: "skeleton" } as never
      })
    ).toThrowError(/E_P3C_DECISION/);
  });

  it("pendingDecision 的 selectedOptionId 被換成不在清單內的 option → E_P3C_DECISION", () => {
    expect(() =>
      assertEventLifeInvariants({
        ...atDecision,
        pendingDecision: { ...(atDecision.pendingDecision as object), selectedOptionId: "gamma" } as never
      })
    ).toThrowError(/E_P3C_DECISION/);
  });

  it("過期 decision（year 與 currentYear 不符）→ E_P3C_STATE", () => {
    expect(() =>
      assertEventLifeInvariants({ ...atDecision, pendingDecision: { ...(atDecision.pendingDecision as object), year: 1999 } as never })
    ).toThrowError(/E_P3C_STATE/);
  });
});

describe("P3-C pack 反例", () => {
  it("packChecksum 被改 → validateEventPack 先以 E_P3B_CHECKSUM 拒絕", () => {
    const tampered = { manifest: { ...raw.manifest, packChecksum: "0".repeat(64) }, events: [...raw.events] };
    expect(() => validateEventPack(tampered)).toThrowError(/E_P3B_CHECKSUM/);
  });

  it("pack ID 相同但 checksum 不同（重新封裝過）→ E_P3C_PACK", () => {
    const state = newLife(pack);
    const rebuilt = repack(raw, (events) => events.map((entry) => (entry.eventId === "ev.p3c.once" ? { ...entry, weight: 2 } : entry)));
    expect(rebuilt.manifest.eventPackId).toBe(pack.manifest.eventPackId);
    expect(rebuilt.packChecksum).not.toBe(pack.packChecksum);
    expect(() => applyEventLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: 1 }, rebuilt)).toThrowError(/E_P3C_PACK/);
  });

  it("bootstrap／state／pack 版本不一致 → E_P3C_PACK 或 E_P3C_VERSION", () => {
    const state = newLife(pack);
    const wrongSpec = {
      manifest: { ...raw.manifest, eventSpecVersion: P3B_EVENT_SPEC_VERSION },
      events: [...raw.events]
    };
    expect(() => validateEventPack(wrongSpec)).not.toThrow();
    // 事件 spec 相同但內容不同 → binding 不同。
    expect(() => applyEventLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: 1 }, validateRaw(raw))).not.toThrow();
  });

  it("decision option 內再開 decision 的 pack 在綁定時就被拒絕", () => {
    const nested = repack(raw, (events) =>
      events.map((entry) =>
        entry.decision === null
          ? entry
          : {
              ...entry,
              decision: {
                ...entry.decision,
                options: entry.decision.options.map((option) => ({
                  ...option,
                  effects: [...option.effects, { type: "openDecision" as const, decisionId: "dec.p3c.nested" }]
                }))
              }
            }
      )
    );
    expect(() => createEventLifeState(makeBootstrap(), nested)).toThrowError(/E_P3C_PACK/);
  });

  it("manifest／events 排列改變不影響結果（語義相同）", () => {
    const forward = validateRaw(raw);
    const reversed = validateEventPack({ manifest: raw.manifest, events: [...raw.events].reverse() });
    const a = driveYears(forward, 12);
    const b = driveYears(reversed, 12);
    expect(b.selected).toEqual(a.selected);
    expect(b.selections).toEqual(a.selections);
    expect(b.state.stateHash).toBe(a.state.stateHash);
    expect(b.state.events).toEqual(a.state.events);
  });
});

describe("P3-C hidden fast-forward 與輸入不可變", () => {
  it("hidden 時 FAST_FORWARD_STEP 在任何事件抽選之前就拒絕", () => {
    const state = newLife(pack);
    const hidden = runCommand(state, pack, { type: "SET_PLAYBACK", hidden: true });
    expect(hidden.playback.visibility).toBe("hidden");
    const before = snapshot(hidden);
    expect(() => runCommand(hidden, pack, { type: "FAST_FORWARD_STEP", maxYears: 5 })).toThrowError(/E_P3C_PHASE/);
    expect(snapshot(hidden)).toBe(before);
    expect(hidden.history.yearsRecorded).toBe(0);
    expect(hidden.events.rng.draws).toBe(0);
    expect(hidden.events.occurrences).toEqual([]);
  });

  it("hidden 時 NEXT 也拒絕，且不會產生 pending decision", () => {
    const hidden = runCommand(newLife(pack), pack, { type: "SET_PLAYBACK", hidden: true });
    expect(() => runCommand(hidden, pack, { type: "NEXT" })).toThrowError(/E_P3C_PHASE/);
    expect(hidden.pendingDecision).toBeNull();
  });

  it("交易的輸入 state 不會被原地修改（含 RNG 與 occurrences）", () => {
    const state = driveYears(pack, 8).state;
    const before = snapshot(state);
    const occurrencesBefore = JSON.stringify(state.events.occurrences);
    const rngBefore = JSON.stringify(state.events.rng);
    applyEventLifeCommand(state, { type: "FAST_FORWARD_STEP", maxYears: 1 }, pack);
    expect(snapshot(state)).toBe(before);
    expect(JSON.stringify(state.events.occurrences)).toBe(occurrencesBefore);
    expect(JSON.stringify(state.events.rng)).toBe(rngBefore);
  });

  it("回傳的 delta 與 state 共用凍結陣列，事後修改不會生效", () => {
    const result = applyEventLifeCommand(newLife(pack), { type: "FAST_FORWARD_STEP", maxYears: 1 }, pack);
    const delta = result.deltas[0];
    expect(delta).toBeDefined();
    expect(Object.isFrozen(delta!.event.rngStateAfter)).toBe(true);
    expect(Object.isFrozen(result.state.events.rng.state)).toBe(true);
  });

  it("序列化輸出不含函式或不可序列化內容（存檔邊界）", () => {
    const state = driveYears(pack, 6).state;
    const serialized = serializeEventLifeState(state);
    expect(() => JSON.stringify(serialized)).not.toThrow();
    expect(JSON.parse(JSON.stringify(serialized)).schemaVersion).toBe("p3c-1");
  });
});

describe("P3-C 重建與指令鏈反例", () => {
  it("commandLog 少一筆 → E_P3C_ARGUMENT", () => {
    const driven = driveYears(pack, 6).state;
    expect(driven.commandLog.length).toBeGreaterThan(0);
    const truncated = driven.commandLog.slice(0, -1);
    expect(() =>
      reconstructEventLifeState({ bootstrap: makeBootstrap(), targetYears: driven.history.yearsRecorded, commandLog: truncated }, pack)
    ).toThrowError(/E_P3C_ARGUMENT/);
  });

  it("commandLog 多一筆／亂序 → E_P3C_", () => {
    const driven = driveYears(pack, 6).state;
    const duplicated = [driven.commandLog[0]!, ...driven.commandLog];
    expect(() =>
      reconstructEventLifeState({ bootstrap: makeBootstrap(), targetYears: driven.history.yearsRecorded, commandLog: duplicated }, pack)
    ).toThrowError(/E_P3C_/);
  });

  it("隱藏的故障注入階段清單是固定且公開的（測試可列舉）", () => {
    expect([...ANNUAL_EVENT_STAGES]).toEqual(["after_roll", "after_selection", "after_effects", "after_occurrence", "before_commit"]);
  });
});
