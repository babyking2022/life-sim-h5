import {
  P3A_FAST_FORWARD_MAX_YEARS,
  P3A_MAX_DELTA_MS,
  P3A_PACE_MINUTES,
  P3A_SPEEDS,
  P3C_MAX_FLAGS,
  type P3ACommand,
  type P3ACommandRecord,
  type P3CErrorCode,
  type P3CYearDelta,
  type P3CLifeState
} from "@life-sim/contracts";
import { canonicalBytes } from "../../canonical/canonical";
import { sha256Hex } from "../../rng/sha256";
import { applyEventEffects } from "../events/effects";
import type { ValidatedEventPack } from "../events/validate";
import { computeYearDurationMs } from "../index";
import { applyEffectOutcome, type EffectFacts } from "./effects-adapter";
import { EventLifeError, guard } from "./errors";
import { assertEventLifeInvariants, assertPackBinding, eventLifeChainFor, sealEventLifeState } from "./state";
import { resolveEventYearCore } from "./transaction";

/**
 * 事件版指令層：TICK／NEXT／SELECT_DECISION／FAST_FORWARD_STEP／SET_PLAYBACK。
 *
 * 與 P3-A 的差異只有兩點，其餘語義刻意保持一致：
 * 1. 年度交易會抽選事件（`resolveEventYearCore`）；
 * 2. CONFIRM 會套用事件選項的 effects（且只套用一次）。
 *
 * 所有推進模式（TICK／1×／16×／FAST_FORWARD_STEP）都走同一個年度交易，
 * 因此到達同一年度時 selected event／occurrences／RNG／selectionHash／delta／stateHash 完全一致。
 */

function fail(code: P3CErrorCode, path?: string): never {
  throw new EventLifeError(code, path);
}

function canPlay(state: P3CLifeState): boolean {
  return state.phase === "life" && state.pendingDecision === null;
}

function markError(state: P3CLifeState, error: unknown): P3CLifeState {
  const code =
    error instanceof EventLifeError ? error.code : "E_P3C_STATE";
  return sealEventLifeState({
    ...state,
    phase: "error",
    errorCode: code,
    pendingDecision: null,
    playback: { ...state.playback, mode: "paused" }
  });
}

function effectFacts(state: P3CLifeState): EffectFacts {
  return {
    stats: state.stats,
    assets: state.assets,
    flags: [...state.flags]
  };
}

function selectionStateOf(state: P3CLifeState) {
  return {
    currentYear: state.currentYear,
    age: state.age,
    phase: state.phase,
    stats: state.stats,
    assets: state.assets,
    flags: [...state.flags]
  };
}

function argsHashOf(record: { type: string; eventId?: string; decisionId?: string; optionId?: string }): string {
  return sha256Hex(canonicalBytes(record as never));
}

/** SELECT_DECISION：只記錄選擇，不套用效果。 */
function commitSelection(state: P3CLifeState, optionId: string): P3CLifeState {
  const decision = state.pendingDecision;
  if (decision === null) fail("E_P3C_PHASE");
  const before = state.stateHash;
  const selected = sealEventLifeState({ ...state, pendingDecision: { ...decision, selectedOptionId: optionId } });
  return appendWithRecord(selected, {
    seq: state.commandLog.length + 1,
    commandType: "SELECT_DECISION",
    payload: optionId,
    argsHash: argsHashOf({ type: "SELECT_DECISION", eventId: decision.eventId, decisionId: decision.decisionId, optionId }),
    atYear: state.currentYear,
    effectiveYear: state.currentYear,
    auto: false,
    policyId: null,
    rngState: state.rng.state,
    rngDraws: state.rng.draws,
    stateHashBefore: before,
    stateHashAfter: selected.stateHash
  });
}

/**
 * CONFIRM_DECISION（由 `NEXT` 觸發）：套用選項 effects **一次**，清掉 pendingDecision。
 * - 事件抉擇：套用 option 的 typed effects（走 `applyEventEffects` ＋整合轉接層）。
 * - skeleton 抉擇：沿用 P3-A 的 `decision:<decisionId>:<optionId>` 標記 flag。
 */
function commitConfirmation(state: P3CLifeState): P3CLifeState {
  const decision = state.pendingDecision;
  if (decision === null || decision.selectedOptionId === null) fail("E_P3C_PHASE");
  const optionId = decision.selectedOptionId;
  const option = decision.options.find((entry) => entry.optionId === optionId);
  if (option === undefined) fail("E_P3C_DECISION");

  const before = state.stateHash;
  let stats = state.stats;
  let assets: P3CLifeState["assets"] = state.assets;
  let flags: readonly string[] = [...state.flags];

  if (decision.source === "event") {
    const outcome = applyEventEffects(selectionStateOf(state), option.effects);
    const applied = applyEffectOutcome(effectFacts(state), outcome);
    // 選項不得再開新抉擇（綁定時已拒絕這種 pack；這裡是深度防禦）。
    if (applied.openedDecisionId !== null) fail("E_P3C_DECISION");
    stats = applied.stats;
    assets = applied.assets;
    flags = applied.flags;
  } else {
    flags = [...new Set([...state.flags, `decision:${decision.decisionId}:${optionId}`])].sort();
    if (flags.length > P3C_MAX_FLAGS) fail("E_P3C_EFFECT");
  }

  const confirmed = sealEventLifeState({
    ...state,
    pendingDecision: null,
    phase: "life",
    stats,
    assets,
    flags,
    playback: { ...state.playback, mode: "paused" }
  });
  return appendWithRecord(confirmed, {
    seq: state.commandLog.length + 1,
    commandType: "CONFIRM_DECISION",
    payload: optionId,
    argsHash: argsHashOf({ type: "CONFIRM_DECISION", eventId: decision.eventId, decisionId: decision.decisionId, optionId }),
    atYear: state.currentYear,
    effectiveYear: state.currentYear,
    auto: false,
    policyId: null,
    rngState: state.rng.state,
    rngDraws: state.rng.draws,
    stateHashBefore: before,
    stateHashAfter: confirmed.stateHash
  });
}

function appendWithRecord(state: P3CLifeState, record: Omit<P3ACommandRecord, "chainHash">): P3CLifeState {
  const chainHash = eventLifeChainFor(state.hashChain, record);
  return { ...state, commandLog: [...state.commandLog, { ...record, chainHash }], hashChain: chainHash };
}

export interface EventLifeCommandResult {
  readonly state: P3CLifeState;
  readonly deltas: readonly P3CYearDelta[];
}

/**
 * 唯一指令入口：先驗證 state 與 pack 綁定，再分派。
 * 任何未預期的例外都只會以 `E_P3C_*` 回報。
 */
export function applyEventLifeCommand(state: unknown, command: unknown, pack: unknown): EventLifeCommandResult {
  return guard(() => {
    assertEventLifeInvariants(state);
    assertPackBinding(state, pack);
    const boundPack = pack as ValidatedEventPack;
    if (typeof command !== "object" || command === null || Array.isArray(command)) fail("E_P3C_TYPE");
    const type = (command as Record<string, unknown>).type;
    if (typeof type !== "string") fail("E_P3C_TYPE");
    switch (type) {
      case "TICK":
        return applyTick(state, (command as Extract<P3ACommand, { type: "TICK" }>).deltaMs, boundPack);
      case "NEXT":
        return applyNext(state);
      case "SELECT_DECISION":
        return applySelect(state, (command as Extract<P3ACommand, { type: "SELECT_DECISION" }>).optionId);
      case "FAST_FORWARD_STEP":
        return applyFastForward(state, (command as Extract<P3ACommand, { type: "FAST_FORWARD_STEP" }>).maxYears, boundPack);
      case "SET_PLAYBACK":
        return applySetPlayback(state, command as Extract<P3ACommand, { type: "SET_PLAYBACK" }>);
      default:
        return fail("E_P3C_ARGUMENT", "command.type");
    }
  });
}

function applyTick(state: P3CLifeState, deltaMs: unknown, pack: ValidatedEventPack): EventLifeCommandResult {
  if (typeof deltaMs !== "number" || !Number.isSafeInteger(deltaMs) || deltaMs < 0 || deltaMs > P3A_MAX_DELTA_MS) fail("E_P3C_ARGUMENT", "deltaMs");
  if (state.playback.mode !== "playing") return { state, deltas: [] };

  let current = state;
  const deltas: P3CYearDelta[] = [];
  let elapsed = state.playback.elapsedInYearMs + deltaMs * state.playback.speed;
  while (elapsed >= current.playback.yearDurationMs && current.phase === "life" && current.pendingDecision === null) {
    elapsed -= current.playback.yearDurationMs;
    try {
      const result = resolveEventYearCore(current, pack);
      current = result.state;
      deltas.push(result.delta);
    } catch (error) {
      // 年度交易失敗：不追加任何 delta，狀態回到「失敗前的那一年」並記錄固定錯誤碼。
      current = markError(current, error);
      break;
    }
  }
  while (elapsed >= current.playback.yearDurationMs) elapsed -= current.playback.yearDurationMs;
  const mode = canPlay(current) ? "playing" : "paused";
  return { state: { ...current, playback: { ...current.playback, mode, elapsedInYearMs: elapsed } }, deltas };
}

function applyNext(state: P3CLifeState): EventLifeCommandResult {
  if (state.playback.mode === "fast_forward") fail("E_P3C_ARGUMENT", "mode");
  if (state.playback.visibility === "hidden") fail("E_P3C_PHASE", "visibility");

  if (state.pendingDecision !== null) {
    if (state.pendingDecision.selectedOptionId === null) fail("E_P3C_ARGUMENT", "pendingDecision");
    return { state: commitConfirmation(state), deltas: [] };
  }
  if (state.playback.cardsSeen < state.history.cardsTotal) {
    return { state: { ...state, playback: { ...state.playback, cardsSeen: state.playback.cardsSeen + 1 } }, deltas: [] };
  }
  if (!canPlay(state)) {
    return { state: { ...state, playback: { ...state.playback, mode: "paused" } }, deltas: [] };
  }
  const mode = state.playback.mode === "playing" ? "paused" : "playing";
  return {
    state: { ...state, playback: { ...state.playback, mode, previousMode: mode === "playing" ? "playing" : "paused" } },
    deltas: []
  };
}

function applySelect(state: P3CLifeState, optionId: unknown): EventLifeCommandResult {
  if (typeof optionId !== "string" || optionId.length === 0) fail("E_P3C_ARGUMENT", "optionId");
  if (state.phase !== "pending_decision" || state.pendingDecision === null) fail("E_P3C_PHASE", "phase");
  const decision = state.pendingDecision;
  if (decision.selectedOptionId !== null) fail("E_P3C_PHASE", "selectedOptionId");
  // 跨事件 option：選項必須是「這個抉擇」的合法 optionId，否則拒絕。
  if (!decision.options.some((option) => option.optionId === optionId)) fail("E_P3C_ARGUMENT", "optionId");
  return { state: commitSelection(state, optionId), deltas: [] };
}

function applyFastForward(state: P3CLifeState, maxYears: unknown, pack: ValidatedEventPack): EventLifeCommandResult {
  // hidden 必須在「任何事件抽選之前」拒絕：不消耗 RNG、不產生 ledger 紀錄、不改任何欄位。
  if (state.playback.visibility === "hidden") fail("E_P3C_PHASE", "visibility");

  const years = maxYears === undefined ? 1 : maxYears;
  if (typeof years !== "number" || !Number.isSafeInteger(years) || years < 1 || years > P3A_FAST_FORWARD_MAX_YEARS) {
    fail("E_P3C_ARGUMENT", "maxYears");
  }

  let current = state;
  const deltas: P3CYearDelta[] = [];
  for (let index = 0; index < years; index += 1) {
    if (!canPlay(current)) break;
    try {
      const result = resolveEventYearCore(current, pack);
      current = result.state;
      deltas.push(result.delta);
    } catch (error) {
      current = markError(current, error);
      break;
    }
  }
  const mode = canPlay(current) ? "fast_forward" : "paused";
  return { state: { ...current, playback: { ...current.playback, mode, previousMode: "paused" } }, deltas };
}

function applySetPlayback(state: P3CLifeState, command: Extract<P3ACommand, { type: "SET_PLAYBACK" }>): EventLifeCommandResult {
  let speed = state.playback.speed;
  if (command.speed !== undefined) {
    if (typeof command.speed !== "number" || !(P3A_SPEEDS as readonly number[]).includes(command.speed)) fail("E_P3C_SPEED", "speed");
    speed = command.speed as (typeof P3A_SPEEDS)[number];
  }
  let paceMinutes = state.playback.paceMinutes;
  if (command.paceMinutes !== undefined) {
    if (typeof command.paceMinutes !== "number" || !(P3A_PACE_MINUTES as readonly number[]).includes(command.paceMinutes)) {
      fail("E_P3C_PACE", "paceMinutes");
    }
    paceMinutes = command.paceMinutes as (typeof P3A_PACE_MINUTES)[number];
  }
  if (command.paused !== undefined && typeof command.paused !== "boolean") fail("E_P3C_ARGUMENT", "paused");
  if (command.hidden !== undefined && typeof command.hidden !== "boolean") fail("E_P3C_ARGUMENT", "hidden");
  if (command.hidden !== undefined && command.paused !== undefined) fail("E_P3C_ARGUMENT", "hidden");

  let mode = state.playback.mode;
  let visibility = state.playback.visibility;
  let previousMode = state.playback.previousMode;

  if (command.hidden === true) {
    visibility = "hidden";
    previousMode = mode === "playing" ? "playing" : "paused";
    mode = "paused";
  } else if (command.hidden === false) {
    visibility = "visible";
    mode = canPlay(state) && previousMode === "playing" ? "playing" : "paused";
  } else if (command.paused === true) {
    mode = "paused";
    previousMode = "paused";
  } else if (command.paused === false) {
    if (!canPlay(state)) fail("E_P3C_PHASE", "phase");
    if (state.playback.visibility === "hidden") fail("E_P3C_PHASE", "visibility");
    mode = "playing";
    previousMode = "playing";
  }

  const oldDuration = state.playback.yearDurationMs;
  const newDuration = computeYearDurationMs(paceMinutes, state.paceLifeYearsX10);
  const elapsedInYearMs =
    paceMinutes === state.playback.paceMinutes ? state.playback.elapsedInYearMs : Math.floor((state.playback.elapsedInYearMs * newDuration) / oldDuration);

  return {
    state: {
      ...state,
      playback: { ...state.playback, mode, visibility, previousMode, speed, paceMinutes, yearDurationMs: newDuration, elapsedInYearMs }
    },
    deltas: []
  };
}
