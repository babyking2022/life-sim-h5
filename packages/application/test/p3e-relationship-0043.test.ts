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
import { replayP3ELedgerHistory } from "@life-sim/simulation";
import {
  createP3EPlaySession,
  exportP3EPlaySessionPayload,
  restoreP3EPlaySessionPayload,
  runP3EPlaySessionCommand,
  type P3EPlaySession
} from "../src/p3e-session";

/**
 * GPT-DEEPSEEK-0043-A｜關係狀態的正式時間序列回歸測試。
 *
 * 全部走正式 application session（逐年遞增、真實 event eligibility）：
 *
 * 1. 35+ 喪偶後可以再次交往／結婚；
 * 2. 35+ 離異後可以再次交往／結婚；
 * 3. 已婚者不會抽到一般 `ev.adult.relationship`；
 * 4. `dating → single` 之後 canonical flags 與 profile 都是 single；
 * 5. divorce／widow／new relationship 的 save → load → replay 結果一致。
 *
 * 為了讓機率事件在測試中穩定出現，測試 pack 會**提高**喪偶／離婚事件的權重
 * （只改測試用 pack，不動正式 fixture）。
 */

const ROOT = process.cwd();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

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

/** 建立測試 pack：可指定要納入的事件與權重覆寫。 */
function packOf(eventIds: readonly string[], weightOverrides: Readonly<Record<string, number>> = {}): ValidatedEventPack {
  const events = eventIds.map((eventId) => {
    const source = rawEvents.find((record) => record.eventId === eventId);
    if (source === undefined) throw new Error(`missing fixture event ${eventId}`);
    const clone = structuredClone(source);
    const weight = weightOverrides[eventId];
    if (weight !== undefined) clone.weight = weight;
    return clone;
  });
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

const RELATIONSHIP_PACK = packOf(["ev.teen.first-love", "ev.adult.relationship"]);
const WIDOW_PACK = packOf(["ev.teen.first-love", "ev.adult.relationship", "ev.adult.partner-loss"], {
  "ev.adult.partner-loss": 5000
});
const DIVORCE_PACK = packOf(["ev.teen.first-love", "ev.adult.relationship", "ev.adult.marital-breakup"], {
  "ev.adult.marital-breakup": 5000
});

const ADVANCE = { type: "ADVANCE_YEAR", contentMode: "standard" } as const;

function sessionFor(seed: string, eventPack: ValidatedEventPack): P3EPlaySession {
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

interface PlayTrace {
  readonly session: P3EPlaySession;
  readonly decisions: readonly { readonly year: number; readonly age: number; readonly decisionId: string; readonly optionIds: readonly string[] }[];
  /** 逐年狀態歷史（age, year, status）：用來斷言「先 widowed、之後再建立關係」這種時序。 */
  readonly history: readonly { readonly age: number; readonly year: number; readonly status: string }[];
}

/**
 * 逐年推進到指定年齡，遇到決策就依 `choose(decisionId, optionIds, age)` 選一個選項。
 * 回傳最後 session 與所有決策記錄（用來檢查 eligibility）。
 */
function playToAge(
  start: P3EPlaySession,
  targetAge: number,
  choose: (decisionId: string, optionIds: readonly string[], age: number) => string | null,
  maxSteps = 200
): PlayTrace {
  let session = start;
  const decisions: { year: number; age: number; decisionId: string; optionIds: readonly string[] }[] = [];
  const history: { age: number; year: number; status: string }[] = [
    { age: session.state.age, year: session.state.currentYear, status: session.view.profile.relationship.status }
  ];
  for (let step = 0; step < maxSteps && session.state.age < targetAge && session.state.phase !== "death"; step += 1) {
    if (session.state.phase === "pending_decision") {
      const decisionId = session.state.pendingDecision?.decisionId as string;
      const optionIds = session.state.pendingDecision?.optionIds ?? [];
      decisions.push({ year: session.state.currentYear, age: session.state.age, decisionId, optionIds });
      const optionId = choose(decisionId, optionIds, session.state.age) ?? (optionIds[0] as string);
      session = runP3EPlaySessionCommand({ session, command: { type: "CHOOSE_DECISION", optionId } }).session;
      history.push({ age: session.state.age, year: session.state.currentYear, status: session.view.profile.relationship.status });
      continue;
    }
    session = runP3EPlaySessionCommand({ session, command: { ...ADVANCE } }).session;
    history.push({ age: session.state.age, year: session.state.currentYear, status: session.view.profile.relationship.status });
  }
  return { session, decisions, history };
}

/** 偏好：first-love 交往、一般關係結婚、離婚／喪偶照事件走。 */
const preferMarry = (decisionId: string, optionIds: readonly string[]): string => {
  if (decisionId === "dec.teen.first-love") return optionIds.includes("date") ? "date" : (optionIds[0] as string);
  if (decisionId === "dec.adult.relationship") return optionIds.includes("marry") ? "marry" : (optionIds[0] as string);
  if (decisionId === "dec.adult.marital-breakup") return optionIds.includes("divorce") ? "divorce" : (optionIds[0] as string);
  return optionIds[0] as string;
};

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

function relationshipOf(session: P3EPlaySession) {
  return session.view.profile.relationship;
}

describe("GPT-0043-A 正式時間序列：喪偶與離異後能再建立關係", () => {
  it("35+ 喪偶 → 再次交往／結婚（canonical flags、view.partner、profile 一致）", () => {
    // 掃描固定 seed 清單：找一條「先 widowed、之後又 dating/married」的時間序列，
    // 並要求它在 35 歲之後仍有一般關係決策（證明 35+ 的 widowed 玩家仍能建立關係）。
    let found: PlayTrace | null = null;
    let widowedIndex = -1;
    let repartnerIndex = -1;
    for (let index = 0; index < 20; index += 1) {
      const candidate = playToAge(sessionFor(`gpt-0043-widow-${index}`, WIDOW_PACK), 55, preferMarry);
      const widowed = candidate.history.findIndex((entry) => entry.status === "widowed" && entry.age >= 30);
      const repartner = candidate.history.findIndex(
        (entry, position) => position > widowed && (entry.status === "dating" || entry.status === "married")
      );
      const lateRelationship = candidate.decisions.some(
        (entry) => entry.decisionId === "dec.adult.relationship" && entry.age >= 35
      );
      if (widowed >= 0 && repartner > widowed && lateRelationship) {
        found = candidate;
        widowedIndex = widowed;
        repartnerIndex = repartner;
        break;
      }
    }
    expect(found, "至少要有一條 seed 出現「widowed → 再交往／再婚」，且 35+ 仍有關係決策").not.toBeNull();
    const played = found as PlayTrace;
    const session = played.session;
    expect(repartnerIndex).toBeGreaterThan(widowedIndex);

    // 最終狀態與 canonical flags 一致。
    const flags = session.state.flags;
    const status = relationshipOf(session).status;
    if (status === "married") {
      expect(flags.includes("partner:married")).toBe(true);
      expect(session.view.partner).not.toBeNull();
      expect(relationshipOf(session).personName).toBe(session.view.partner?.displayName);
    } else if (status === "widowed") {
      expect(flags.includes("partner:married")).toBe(false);
      expect(flags.includes("relationship:widowed")).toBe(true);
      expect(session.view.partner).toBeNull();
      expect(typeof relationshipOf(session).personName).toBe("string");
    } else if (status === "dating") {
      expect(flags.includes("partner:married")).toBe(false);
      expect(session.view.partner).not.toBeNull();
    }
  });

  it("35+ 離異 → 再次交往／結婚（single 不是離婚的唯一出口）", () => {
    let found: PlayTrace | null = null;
    let divorcedIndex = -1;
    let repartnerIndex = -1;
    for (let index = 0; index < 20; index += 1) {
      const candidate = playToAge(sessionFor(`gpt-0043-divorce-${index}`, DIVORCE_PACK), 55, preferMarry);
      const divorced = candidate.history.findIndex((entry) => entry.status === "divorced" && entry.age >= 30);
      const repartner = candidate.history.findIndex(
        (entry, position) => position > divorced && (entry.status === "dating" || entry.status === "married")
      );
      const lateRelationship = candidate.decisions.some(
        (entry) => entry.decisionId === "dec.adult.relationship" && entry.age >= 35
      );
      if (divorced >= 0 && repartner > divorced && lateRelationship) {
        found = candidate;
        divorcedIndex = divorced;
        repartnerIndex = repartner;
        break;
      }
    }
    expect(found, "至少要有一條 seed 出現「divorced → 再交往／再婚」，且 35+ 仍有關係決策").not.toBeNull();
    const played = found as PlayTrace;
    const session = played.session;
    expect(repartnerIndex).toBeGreaterThan(divorcedIndex);

    const flags = session.state.flags;
    const status = relationshipOf(session).status;
    if (status === "married") {
      expect(flags.includes("partner:married")).toBe(true);
      expect(session.view.partner).not.toBeNull();
    }
    if (status === "divorced") {
      expect(flags.includes("partner:married")).toBe(false);
      expect(session.view.partner).toBeNull();
    }
  });

  it("已婚者不會抽到一般 relationship：結婚後的關係事件數必須為 0", () => {
    const seed = "gpt-0043-married-no-relationship";
    // 這個 pack 只有 first-love ＋ relationship：結婚後若還能抽到 relationship 就會再出現決策。
    const played = playToAge(sessionFor(seed, RELATIONSHIP_PACK), 60, preferMarry);
    const marriageIndex = played.decisions.findIndex(
      (entry) => entry.decisionId === "dec.adult.relationship" && entry.age >= 22
    );
    expect(marriageIndex).toBeGreaterThanOrEqual(0);
    const session = played.session;
    // 這條 seed 必須真的結婚，才能驗證「已婚後不再出現」。
    expect(session.state.flags.includes("partner:married")).toBe(true);

    // 結婚之後的所有 dec.adult.relationship 決策數量必須剛好是 0（不是「年份剛好符合」）。
    const afterMarriage = played.decisions.slice(marriageIndex + 1);
    const relationshipAfterMarriage = afterMarriage.filter((entry) => entry.decisionId === "dec.adult.relationship");
    expect(relationshipAfterMarriage).toHaveLength(0);
    // 而且時間確實往前推進了（證明不是「根本沒跑」而是事件真的被過濾掉）。
    const marriageAge = played.decisions[marriageIndex]?.age as number;
    expect(session.state.age).toBeGreaterThan(marriageAge + 5);
    void afterMarriage;
    expect(session.view.partner).not.toBeNull();
    expect(session.view.profile.relationship.status).toBe("married");
  });

  it("dating → single：canonical flags 與 profile 都是 single", () => {
    const seed = "gpt-0043-dating-single";
    const played = playToAge(sessionFor(seed, RELATIONSHIP_PACK), 40, (decisionId, optionIds) => {
      if (decisionId === "dec.teen.first-love") return optionIds.includes("date") ? "date" : (optionIds[0] as string);
      if (decisionId === "dec.adult.relationship") return optionIds.includes("single") ? "single" : (optionIds[0] as string);
      return optionIds[0] as string;
    });
    const session = played.session;
    expect(session.view.profile.relationship.status).toBe("single");
    expect(session.view.partner).toBeNull();
    expect(session.state.flags.includes("teen:partner")).toBe(false);
    expect(session.state.flags.includes("partner:cohabit")).toBe(false);
    expect(session.state.flags.includes("partner:married")).toBe(false);
  });
});

describe("GPT-0044-A save → load → replay 一致性（真的呼叫正式 replay）", () => {
  const cases: readonly [string, ValidatedEventPack, string][] = [
    ["widow", WIDOW_PACK, "gpt-0043-save-widow"],
    ["divorce", DIVORCE_PACK, "gpt-0043-save-divorce"],
    ["married", RELATIONSHIP_PACK, "gpt-0043-save-married"]
  ];

  for (const [label, pack, seed] of cases) {
    it(`${label}：restore 與正式的 replayP3ELedgerHistory 都得到同一個 state`, () => {
      const played = playToAge(sessionFor(seed, pack), 45, preferMarry).session;

      // (a) 正式 replay：Genesis + 既有 ledgerHistory 逐命令重執行。
      const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
      const certificate = createBirthCertificate(base, identityPack, group, seed);
      const replayed = replayP3ELedgerHistory({
        genesisInput: { masterSeed: seed, basePack: base, identityPack, certificate, eventPack: pack, deathPack },
        history: played.ledgerHistory
      });
      expect(replayed.state.stateHash).toBe(played.state.stateHash);
      expect([...replayed.state.flags]).toEqual([...played.state.flags]);
      expect(replayed.commandsConsumed).toBe(played.ledgerHistory.records.length);

      // (b) export → restore（payload 內含 codec + replay 驗證）。
      const restored = restore(played, seed, pack);
      expect(JSON.stringify(restored.view.profile)).toBe(JSON.stringify(played.view.profile));
      expect(JSON.stringify(restored.view.partner)).toBe(JSON.stringify(played.view.partner));
      expect([...restored.state.flags]).toEqual([...played.state.flags]);
      expect(restored.state.stateHash).toBe(replayed.state.stateHash);
      expect(restored.view.profile.relationship.status).toBe(played.view.profile.relationship.status);
    });
  }
});

describe("GPT-0044-A divorced／widowed 走 relationship:single：canonical 與 profile 一致", () => {

  /**
   * 先玩到 divorced／widowed（用提高權重的測試 pack），
   * 之後遇到一般關係事件就選 single，回傳選完之後的 session。
   */
  function playUntilSingleAfter(
    pack: ValidatedEventPack,
    seedPrefix: string,
    expected: "divorced" | "widowed"
  ): { readonly session: P3EPlaySession; readonly seed: string; readonly endAge: number } | null {
    for (let index = 0; index < 24; index += 1) {
      const seed = `${seedPrefix}-${index}`;
      let session = sessionFor(seed, pack);
      let reachedExpected = false;
      let chosenSingle = false;
      for (let step = 0; step < 160 && session.state.age <= 90 && session.state.phase !== "death"; step += 1) {
        if (session.state.phase === "pending_decision") {
          const decisionId = session.state.pendingDecision?.decisionId as string;
          const optionIds = session.state.pendingDecision?.optionIds ?? [];
          if (decisionId === "dec.teen.first-love") {
            session = runP3EPlaySessionCommand({
              session,
              command: { type: "CHOOSE_DECISION", optionId: optionIds.includes("date") ? "date" : (optionIds[0] as string) }
            }).session;
            continue;
          }
          if (decisionId === "dec.adult.relationship") {
            if (reachedExpected && optionIds.includes("single")) {
              session = runP3EPlaySessionCommand({ session, command: { type: "CHOOSE_DECISION", optionId: "single" } }).session;
              chosenSingle = true;
              break;
            }
            session = runP3EPlaySessionCommand({
              session,
              command: { type: "CHOOSE_DECISION", optionId: optionIds.includes("marry") ? "marry" : (optionIds[0] as string) }
            }).session;
            continue;
          }
          if (decisionId === "dec.adult.marital-breakup") {
            session = runP3EPlaySessionCommand({
              session,
              command: { type: "CHOOSE_DECISION", optionId: optionIds.includes("divorce") ? "divorce" : (optionIds[0] as string) }
            }).session;
            continue;
          }
          session = runP3EPlaySessionCommand({ session, command: { type: "CHOOSE_DECISION", optionId: optionIds[0] as string } }).session;
          continue;
        }
        session = runP3EPlaySessionCommand({ session, command: { ...ADVANCE } }).session;
        const status = session.view.profile.relationship.status;
        if (status === expected) reachedExpected = true;
      }
      if (chosenSingle) return { session, seed, endAge: session.state.age };
    }
    return null;
  }

  it("divorced → relationship:single：flags 清除、profile=single、partner=null（含 restore + 正式 replay）", () => {
    const found = playUntilSingleAfter(DIVORCE_PACK, "gpt-0044-divorced-single", "divorced");
    expect(found, "至少要有一條 seed 走到 divorced 之後再選 single").not.toBeNull();
    const { session, seed } = found as { session: P3EPlaySession; seed: string };

    expect(session.view.profile.relationship.status).toBe("single");
    expect(session.view.partner).toBeNull();
    const flags = session.state.flags;
    expect(flags.includes("relationship:divorced")).toBe(false);
    expect(flags.includes("relationship:widowed")).toBe(false);
    expect(flags.includes("partner:married")).toBe(false);
    expect(flags.includes("partner:cohabit")).toBe(false);
    expect(flags.includes("teen:partner")).toBe(false);

    const restored = restore(session, seed, DIVORCE_PACK);
    expect(JSON.stringify(restored.view.profile)).toBe(JSON.stringify(session.view.profile));
    expect([...restored.state.flags]).toEqual([...flags]);

    const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
    const certificate = createBirthCertificate(base, identityPack, group, seed);
    const replayed = replayP3ELedgerHistory({
      genesisInput: { masterSeed: seed, basePack: base, identityPack, certificate, eventPack: DIVORCE_PACK, deathPack },
      history: session.ledgerHistory
    });
    expect(replayed.state.stateHash).toBe(session.state.stateHash);
    expect([...replayed.state.flags]).toEqual([...flags]);
  });

  it("widowed → relationship:single：flags 清除、profile=single、partner=null（含 restore + 正式 replay）", () => {
    const found = playUntilSingleAfter(WIDOW_PACK, "gpt-0044-widowed-single", "widowed");
    expect(found, "至少要有一條 seed 走到 widowed 之後再選 single").not.toBeNull();
    const { session, seed } = found as { session: P3EPlaySession; seed: string };

    expect(session.view.profile.relationship.status).toBe("single");
    expect(session.view.partner).toBeNull();
    const flags = session.state.flags;
    expect(flags.includes("relationship:widowed")).toBe(false);
    expect(flags.includes("relationship:divorced")).toBe(false);
    expect(flags.includes("partner:married")).toBe(false);

    const restored = restore(session, seed, WIDOW_PACK);
    expect(JSON.stringify(restored.view.profile)).toBe(JSON.stringify(session.view.profile));
    expect([...restored.state.flags]).toEqual([...flags]);

    const group = buildPeerGroup(base, identityPack, { seed, playerSexPolicy: "random" } as never);
    const certificate = createBirthCertificate(base, identityPack, group, seed);
    const replayed = replayP3ELedgerHistory({
      genesisInput: { masterSeed: seed, basePack: base, identityPack, certificate, eventPack: WIDOW_PACK, deathPack },
      history: session.ledgerHistory
    });
    expect(replayed.state.stateHash).toBe(session.state.stateHash);
    expect([...replayed.state.flags]).toEqual([...flags]);
  });
});
