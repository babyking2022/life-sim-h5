import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  P3E_MAX_AGE,
  P3E_MAX_COMMANDS,
  type P3ELifeState
} from "../packages/contracts/src/index";
import {
  buildPeerGroup,
  createBirthCertificate,
  validateDataPack,
  validateDeathPack,
  validateIdentityPack
} from "../packages/birth/src/index";
import { validateEventPack } from "../packages/engine/src/index";
import { createP3EGame, runP3EGameCommand } from "../packages/application/src/index";

/**
 * P3-E.1b-2l：可玩 runtime 的 headless smoke（H5-CTO-166-A）。
 *
 * 這是「可玩主線保護門檻」：用**正式 fixtures** 與 **application 公開 façade**
 * 從 age 0 一路執行到 `phase === "death"`，途中遇到 pending decision 時以
 * 固定規則選擇第一個合法 optionId，並逐筆核對 Command Record／Year Record／
 * State 的鏈結。
 *
 * ## 固定規則（不得引入時間、亂數或外部輸入）
 *
 * - seed 固定為 `PLAYABLE_SMOKE_SEED`；
 * - `ADVANCE_YEAR` 一律使用 `contentMode: "standard"`；
 * - pending decision 一律選 `pendingDecision.optionIds[0]`（pack 順序第一個）；
 * - 全部計算都由 simulation 的正式原語完成，本檔只做編排與斷言。
 *
 * ## 失敗即主線阻擋
 *
 * pending decision 未處理、超過 age 120、鏈結不一致、或未在 age <= 120 抵達 death，
 * 一律拋錯；CLI 以非零 exit code 結束。成功時輸出一筆固定摘要，第一行固定為
 * `P3E-PLAYABLE-SMOKE-OK`。
 */

/** smoke 固定 seed（改變它會改變整條時間線，必須與摘要一起凍結）。 */
export const PLAYABLE_SMOKE_SEED = "p3e-166-playable-runtime-v4";

const ROOT = process.cwd();
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

interface SmokeWorld {
  readonly base: ReturnType<typeof validateDataPack>;
  readonly identityPack: ReturnType<typeof validateIdentityPack>;
  readonly eventPack: ReturnType<typeof validateEventPack>;
  readonly deathPack: ReturnType<typeof validateDeathPack>;
  readonly certificate: ReturnType<typeof createBirthCertificate>;
}

function fail(message: string): never {
  throw new Error(`P3E-PLAYABLE-SMOKE-FAIL: ${message}`);
}

function buildWorld(): SmokeWorld {
  // 1-2. base pack／identity pack
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

  // 3. peer group
  const peerGroup = buildPeerGroup(base, identityPack, {
    seed: PLAYABLE_SMOKE_SEED,
    playerSexPolicy: "random"
  } as never);

  // 4. birth certificate
  const certificate = createBirthCertificate(base, identityPack, peerGroup, PLAYABLE_SMOKE_SEED);

  // 5. event pack
  const eventPack = validateEventPack({
    manifest: readJson("fixtures/p3b/manifest.v1.json"),
    events: (readJson("fixtures/p3b/events.v1.json") as { records: unknown[] }).records
  } as never);

  // 6. death pack
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

  return { base, identityPack, eventPack, deathPack, certificate };
}

/** 逐筆核對 Command Record／Year Record／State 的交叉鏈結。 */
function assertLinks(
  previous: P3ELifeState,
  result: ReturnType<typeof runP3EGameCommand>,
  expectedIndex: number
): void {
  const { commandRecord, yearRecord, state } = result;
  const label = `command #${expectedIndex}`;

  if (commandRecord.index !== expectedIndex) {
    fail(`${label}: commandRecord.index = ${commandRecord.index}`);
  }
  if (yearRecord.index !== expectedIndex) {
    fail(`${label}: yearRecord.index = ${yearRecord.index}`);
  }
  if (commandRecord.prevCommandHash !== previous.commandLog.headHash) {
    fail(`${label}: prevCommandHash 未接續上一筆 command head`);
  }
  if (commandRecord.stateHashBefore !== previous.stateHash) {
    fail(`${label}: stateHashBefore 不等於前一筆 State`);
  }
  if (yearRecord.prevChainHash !== previous.heads.hashChain) {
    fail(`${label}: prevChainHash 未接續上一筆 chain head`);
  }
  if (yearRecord.stateHashBefore !== previous.stateHash) {
    fail(`${label}: yearRecord.stateHashBefore 不等於前一筆 State`);
  }
  if (yearRecord.commandHash !== commandRecord.commandHash) {
    fail(`${label}: yearRecord.commandHash 與 Command Record 不一致`);
  }
  if (yearRecord.entryHash !== commandRecord.entryHash) {
    fail(`${label}: yearRecord.entryHash 與 Command Record 不一致`);
  }
  if (commandRecord.stateHashAfter !== state.stateHash) {
    fail(`${label}: stateHashAfter 與最終 State 不一致`);
  }
  if (yearRecord.stateHashAfter !== state.stateHash) {
    fail(`${label}: yearRecord.stateHashAfter 與最終 State 不一致`);
  }
  if (state.commandLog.count !== expectedIndex) {
    fail(`${label}: state.commandLog.count = ${state.commandLog.count}`);
  }
  if (state.commandLog.headHash !== commandRecord.commandHash) {
    fail(`${label}: state.commandLog.headHash 未指向本筆 Command Record`);
  }
  if (state.heads.hashChain !== yearRecord.chainHash) {
    fail(`${label}: state.heads.hashChain 未指向本筆 Year Record`);
  }
  if (state.heads.lastEntryHash !== yearRecord.entryHash) {
    fail(`${label}: state.heads.lastEntryHash 與 Year Record 不一致`);
  }
  if (state.heads.lastSnapshotHash !== yearRecord.snapshotHash) {
    fail(`${label}: state.heads.lastSnapshotHash 與 Year Record 不一致`);
  }
  if (state.heads.lastDeltaHash !== yearRecord.deltaHash) {
    fail(`${label}: state.heads.lastDeltaHash 與 Year Record 不一致`);
  }
}

/** 命令類型與 outcome.kind 必須一致；pending 顯示摘要必須與最終 State 一致。 */
function assertAdvanceOutcome(result: ReturnType<typeof runP3EGameCommand>): void {
  const outcome = result.outcome;
  if (outcome.kind !== "advance_year") fail(`outcome.kind = ${outcome.kind}`);
  const statePending = result.state.pendingDecision;
  const outcomePending = outcome.pendingDecision;
  if ((statePending === null) !== (outcomePending === null)) {
    fail("outcome.pendingDecision 與 State 的 pendingDecision 不一致");
  }
  if (statePending !== null && outcomePending !== null) {
    if (
      outcomePending.eventId !== statePending.eventId ||
      outcomePending.decisionId !== statePending.decisionId ||
      outcomePending.selectionHash !== statePending.selectionHash
    ) {
      fail("outcome.pendingDecision 摘要與 State 不一致");
    }
    if (outcomePending.options.length !== statePending.optionIds.length) {
      fail("outcome.pendingDecision.options 數量與 State 不一致");
    }
    for (let index = 0; index < outcomePending.options.length; index += 1) {
      if (outcomePending.options[index]?.optionId !== statePending.optionIds[index]) {
        fail("outcome.pendingDecision.options 順序與 State 不一致");
      }
    }
  }
  for (const key of ["candidates", "rng", "selection", "annualDeath", "effects", "openedDecision", "occurrences"]) {
    if (Object.prototype.hasOwnProperty.call(outcome, key)) fail(`outcome 洩漏內部欄位 ${key}`);
  }
}

/** 決策 outcome 必須對應前一筆 pending 與本次命令的 optionId。 */
function assertChooseOutcome(
  previous: P3ELifeState,
  result: ReturnType<typeof runP3EGameCommand>,
  optionId: string
): void {
  const outcome = result.outcome;
  if (outcome.kind !== "choose_decision") fail(`outcome.kind = ${outcome.kind}`);
  const pending = previous.pendingDecision;
  if (pending === null) fail("CHOOSE_DECISION 之前沒有 pendingDecision");
  if (outcome.eventId !== pending.eventId || outcome.decisionId !== pending.decisionId) {
    fail("choose outcome 的 event／decision 與前一筆 pending 不一致");
  }
  if (outcome.selectedOptionId !== optionId) fail("choose outcome 的 selectedOptionId 與命令不一致");
}

interface SmokeResult {
  readonly summary: string;
  readonly state: P3ELifeState;
  readonly commands: number;
}

/** 執行完整 headless life（age 0 → death），回傳固定摘要與最終 State。 */
export function runPlayableSmoke(): SmokeResult {
  const world = buildWorld();

  // 7. createP3EGame：age 0 出生 State
  let state = createP3EGame({
    masterSeed: PLAYABLE_SMOKE_SEED,
    basePack: world.base,
    identityPack: world.identityPack,
    certificate: world.certificate,
    eventPack: world.eventPack,
    deathPack: world.deathPack
  });

  if (state.age !== 0) fail(`出生 State age = ${state.age}`);
  if (state.phase !== "life") fail(`出生 State phase = ${state.phase}`);
  if (state.commandLog.count !== 0) fail(`出生 State commandLog.count = ${state.commandLog.count}`);

  let commands = 0;
  let decisions = 0;
  let lastResult: ReturnType<typeof runP3EGameCommand> | null = null;

  // 8-10. 逐年推進，遇到 pending decision 就選第一個合法 option
  while (state.phase !== "death") {
    if (commands >= P3E_MAX_COMMANDS) {
      fail(`命令數達上限 ${P3E_MAX_COMMANDS} 仍未死亡`);
    }
    if (state.age > P3E_MAX_AGE) {
      fail(`age 超過上限 ${P3E_MAX_AGE} 仍未死亡（age = ${state.age}）`);
    }

    const previous = state;
    let result: ReturnType<typeof runP3EGameCommand>;
    if (state.phase === "pending_decision") {
      const pending = state.pendingDecision;
      if (pending === null) fail("phase = pending_decision 但 pendingDecision 為 null");
      const optionId = pending.optionIds[0];
      if (optionId === undefined) fail("pendingDecision.optionIds 為空");
      result = runP3EGameCommand({
        state,
        eventPack: world.eventPack,
        deathPack: world.deathPack,
        command: { type: "CHOOSE_DECISION", optionId }
      });
      assertChooseOutcome(previous, result, optionId);
      decisions += 1;
    } else {
      if (state.phase !== "life") fail(`未知 phase：${state.phase}`);
      result = runP3EGameCommand({
        state,
        eventPack: world.eventPack,
        deathPack: world.deathPack,
        command: { type: "ADVANCE_YEAR", contentMode: "standard" }
      });
      assertAdvanceOutcome(result);
    }

    // 11. 逐筆核對鏈結
    commands += 1;
    assertLinks(previous, result, commands);
    lastResult = result;
    state = result.state;
  }

  // 10. 必須在 age <= 120 死亡
  if (state.age > P3E_MAX_AGE) fail(`最終 age = ${state.age} 超過 ${P3E_MAX_AGE}`);
  if (state.phase !== "death") fail(`最終 phase = ${state.phase}`);
  if (lastResult === null) fail("沒有任何命令");
  if (lastResult.outcome.kind !== "advance_year") fail("死亡年度必須是 ADVANCE_YEAR");
  if (lastResult.outcome.death === null) fail("最終 State 是 death 但 outcome.death 為 null");

  const summary = [
    "P3E-PLAYABLE-SMOKE-OK",
    `seed=${PLAYABLE_SMOKE_SEED}`,
    `commands=${commands}`,
    `decisions=${decisions}`,
    `finalAge=${state.age}`,
    `finalYear=${state.currentYear}`,
    `finalPhase=${state.phase}`,
    `stateHash=${state.stateHash}`,
    `commandHeadHash=${state.commandLog.headHash}`,
    `chainHash=${state.heads.hashChain}`,
    `lastEntryHash=${state.heads.lastEntryHash}`
  ].join("\n");

  return { summary, state, commands };
}

function main(): void {
  const result = runPlayableSmoke();
  process.stdout.write(`${result.summary}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
