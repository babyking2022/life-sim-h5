import {
  assertBirthCertificateMatches,
  isValidatedDeathPack,
  type ValidatedDataPack,
  type ValidatedDeathPack,
  type ValidatedIdentityPack
} from "@life-sim/birth";
import { bindEventPack, isValidatedEventPack, type ValidatedEventPack } from "@life-sim/engine";
import {
  P3D_HEALTH_RULE_VERSION,
  P3E_CONTENT_VERSION,
  P3E_ENGINE_VERSION,
  P3E_LIFE_SPEC_VERSION,
  P3E_RNG_SPEC_VERSION,
  P3E_ROLL_SPEC_VERSION,
  P3E_RULESET_VERSION,
  P3E_SAVE_FORMAT_VERSION,
  P3E_SCHEMA_VERSION,
  type BirthCertificateSnapshot,
  type P3EDeathPackBinding,
  type P3EErrorCode,
  type P3EEventPackBinding,
  type P3EIdentityBinding,
  type P3ELifeState,
  type P3EPackBindings
} from "@life-sim/contracts";
import { P3EError } from "./errors";
import { createP3EGenesisRng } from "./rng";
import { readP3EState } from "./state-invariants";
import { computeP3EStateHash, createP3EGenesisIntegrity } from "./state-hash";

/**
 * P3-E Genesis 建立器與內部 seal（H5-CTO-073-A，套件內部，**不進公開 barrel**）。
 *
 * ```ts
 * createP3EGenesis(input: unknown): P3ELifeState   // 本批的信任邊界
 * sealP3EState(draft: Omit<P3ELifeState, "stateHash">): P3ELifeState  // 只給套件內已組好的 draft
 * ```
 *
 * ## 固定處理順序（錯誤順序由測試鎖定）
 *
 * 1. input shape（exact-object 六欄）
 * 2. 出生證書重播（`assertBirthCertificateMatches`，不自己重寫 P2-D 驗證）
 * 3. validated event pack 品牌 ＋ `bindEventPack`
 * 4. validated death pack 品牌
 * 5. 所有跨包綁定（death pack ↔ certificate、entity ↔ region）
 * 6. identity／pack bindings
 * 7. 三條 Genesis RNG（`createP3EGenesisRng`）
 * 8. Genesis heads／command summary（`createP3EGenesisIntegrity`）
 * 9. age=0 draft
 * 10–11. seal（內部會呼叫 `readP3EState` 做最終完整驗證）
 *
 * **所有 pack／certificate 驗證完成前不會建立 RNG**。
 *
 * ## 為什麼 `sealP3EState` 不是外部反序列化入口
 *
 * 它會**重算** `stateHash`（不信任 draft 內既有的 stateHash），所以只能用在
 * 「本套件自己剛組好的 draft」。codec／replay 必須先驗證既有 hash，不得用 seal 重新簽名。
 */

/* ------------------------------------------------------------------ */
/* 型別                                                                */
/* ------------------------------------------------------------------ */

/**
 * Genesis input：exact-object 六欄，全部由呼叫端以**已驗證**的形式提供。
 *
 * 五個 pack／certificate 都必須是各自驗證器的品牌物件（不是 raw JSON、不是 clone）。
 */
export interface P3EGenesisInput {
  readonly masterSeed: string;
  readonly basePack: ValidatedDataPack;
  readonly identityPack: ValidatedIdentityPack;
  readonly certificate: BirthCertificateSnapshot;
  readonly eventPack: ValidatedEventPack;
  readonly deathPack: ValidatedDeathPack;
}

const INPUT_KEYS = ["masterSeed", "basePack", "identityPack", "certificate", "eventPack", "deathPack"] as const;

/* ------------------------------------------------------------------ */
/* 錯誤                                                                */
/* ------------------------------------------------------------------ */

function fail(code: P3EErrorCode, path: string): never {
  throw new P3EError(code, path);
}

/* ------------------------------------------------------------------ */
/* 1. input shape                                                      */
/* ------------------------------------------------------------------ */

/**
 * 讀取 exact-object 六欄；任何反射失敗（已撤銷 Proxy、trap 拋錯、accessor、
 * hidden／symbol／多餘／缺少欄位、陣列、class instance、非 plain prototype）
 * 一律折成 `E_P3E_ARGUMENT at input`。
 *
 * 只讀 descriptor：getter 不會被執行。
 */
function readRawInput(input: unknown): Record<string, unknown> {
  let record: Record<string, unknown> | null = null;
  try {
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const proto = Object.getPrototypeOf(input) as object | null;
      if (proto === Object.prototype || proto === null) {
        if (Object.getOwnPropertySymbols(input).length === 0) {
          const names = Object.getOwnPropertyNames(input);
          if (names.length === INPUT_KEYS.length && Object.keys(input).length === INPUT_KEYS.length) {
            const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            let complete = true;
            for (const key of INPUT_KEYS) {
              if (!names.includes(key)) {
                complete = false;
                break;
              }
              const descriptor = Object.getOwnPropertyDescriptor(input, key);
              if (descriptor === undefined || !("value" in descriptor)) {
                complete = false;
                break;
              }
              values[key] = descriptor.value;
            }
            if (complete) record = values;
          }
        }
      }
    }
  } catch {
    record = null;
  }
  if (record === null) fail("E_P3E_ARGUMENT", "input");
  return record;
}

/* ------------------------------------------------------------------ */
/* 2. 出生證書重播                                                     */
/* ------------------------------------------------------------------ */

/**
 * 用 P2-D 的權威驗證器重播一次出生結果。
 *
 * 它同時證明：base／identity pack 是原本驗證器品牌化的物件、certificate 未被修改、
 * masterSeed 可重建同一份出生結果、certificate 與兩個出生資料包一致。
 * 任何失敗（含 raw／clone／換錯 pack／改過的 certificate／錯的 seed）都折成
 * `E_P3E_CERTIFICATE at certificate`。
 */
function verifyCertificate(raw: Record<string, unknown>): BirthCertificateSnapshot {
  try {
    assertBirthCertificateMatches(
      raw.basePack as ValidatedDataPack,
      raw.identityPack as ValidatedIdentityPack,
      raw.certificate as BirthCertificateSnapshot,
      raw.masterSeed as string
    );
  } catch {
    fail("E_P3E_CERTIFICATE", "certificate");
  }
  return raw.certificate as BirthCertificateSnapshot;
}

/* ------------------------------------------------------------------ */
/* 3–4. validated packs                                                */
/* ------------------------------------------------------------------ */

/** 事件包必須是 `validateEventPack` 的品牌物件；binding 逐欄取自 `bindEventPack`。 */
function readEventBinding(raw: Record<string, unknown>): P3EEventPackBinding {
  const pack = raw.eventPack;
  if (!isValidatedEventPack(pack)) fail("E_P3E_EVENT_PACK", "eventPack");
  // 品牌物件由 `validateEventPack` 產生並深層凍結；`bindEventPack` 只會再確認品牌後讀欄位，
  // 對已驗證的 pack 不會拋，因此不需要再包一層永遠不會執行的 try/catch。
  const bound = bindEventPack(pack);
  // 逐欄重建，確保不與 engine 回傳的物件共享參考。
  return {
    eventSchemaVersion: bound.eventSchemaVersion,
    eventSpecVersion: bound.eventSpecVersion,
    contentPackVersion: bound.contentPackVersion,
    eventPackId: bound.eventPackId,
    eventPackChecksum: bound.eventPackChecksum,
    datasetChecksum: bound.datasetChecksum,
    eventCount: bound.eventCount
  };
}

/** 死亡包必須是 `validateDeathPack` 的品牌物件。 */
function readDeathPack(raw: Record<string, unknown>): ValidatedDeathPack {
  const pack = raw.deathPack;
  if (!isValidatedDeathPack(pack)) fail("E_P3E_DEATH_PACK", "deathPack");
  return pack;
}

/* ------------------------------------------------------------------ */
/* 5. 跨包綁定                                                         */
/* ------------------------------------------------------------------ */

/**
 * 死亡包必須綁在同一個 base pack 上，而且證書的 entity 必須存在於它的
 * entityIndex、regionCode 也必須一致。
 *
 * **內部 seam（不進 barrel）**：`createP3EGenesis` 走的就是這支函式；另外匯出是為了讓
 * 「已驗證 pack 幾乎不可能出現」的 entityIndex 反例可以被直接測試（正式流程仍需先通過
 * 品牌檢查，因此這些反例只能靠型別轉型構造）。
 */
export function assertP3EDeathBinding(pack: ValidatedDeathPack, certificate: BirthCertificateSnapshot): void {
  const manifest = pack.manifest;
  if (manifest.basePackId !== certificate.packs.basePackId) {
    fail("E_P3E_BINDING", "deathPack.manifest.basePackId");
  }
  if (manifest.basePackChecksum !== certificate.packs.basePackChecksum) {
    fail("E_P3E_BINDING", "deathPack.manifest.basePackChecksum");
  }
  const birth = certificate.player.birth;
  const binding = pack.entityIndex[birth.entityId];
  if (binding === undefined) fail("E_P3E_BINDING", "deathPack.entityIndex");
  if (binding.regionCode !== birth.regionCode) fail("E_P3E_BINDING", "deathPack.entityIndex");
}

/* ------------------------------------------------------------------ */
/* 6. identity／pack bindings                                          */
/* ------------------------------------------------------------------ */

/** 12 欄全部取自已重播驗證成功的 certificate；不接受呼叫端另外提供。 */
function identityFromCertificate(certificate: BirthCertificateSnapshot): P3EIdentityBinding {
  const birth = certificate.player.birth;
  return {
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
  };
}

/**
 * P3-E 的死亡包綁定（11 欄）。
 *
 * `healthRuleVersion` **不是** P3-D manifest 的欄位：權威值來自 contracts 的
 * `P3D_HEALTH_RULE_VERSION`（P3-D 的 evaluator 也用同一個常數）。
 */
function deathBindingOf(pack: ValidatedDeathPack): P3EDeathPackBinding {
  const manifest = pack.manifest;
  return {
    schemaVersion: manifest.schemaVersion,
    deathDataVersion: manifest.deathDataVersion,
    deathSpecVersion: manifest.deathSpecVersion,
    healthRuleVersion: P3D_HEALTH_RULE_VERSION,
    engineVersion: manifest.engineVersion,
    rngSpecVersion: manifest.rngSpecVersion,
    deathPackId: manifest.deathPackId,
    deathPackChecksum: pack.packChecksum,
    basePackId: manifest.basePackId,
    basePackChecksum: manifest.basePackChecksum,
    entityCount: manifest.entityCount
  };
}

/* ------------------------------------------------------------------ */
/* 9. 固定 Genesis 初值                                                */
/* ------------------------------------------------------------------ */

/** 八個版本欄位（全部是 contracts 常數；不是從 input 推導）。 */
function versionFields() {
  return {
    schemaVersion: P3E_SCHEMA_VERSION,
    rulesetVersion: P3E_RULESET_VERSION,
    rollSpecVersion: P3E_ROLL_SPEC_VERSION,
    lifeSpecVersion: P3E_LIFE_SPEC_VERSION,
    contentVersion: P3E_CONTENT_VERSION,
    saveFormatVersion: P3E_SAVE_FORMAT_VERSION,
    engineVersion: P3E_ENGINE_VERSION,
    rngSpecVersion: P3E_RNG_SPEC_VERSION
  } as const;
}

/* ------------------------------------------------------------------ */
/* Seal                                                                */
/* ------------------------------------------------------------------ */

/**
 * 為**套件內已組好的 draft** 蓋章：重算 `stateHash`、呼叫 `readP3EState` 完整驗證，
 * 回傳那份獨立、深層凍結的快照。
 *
 * - draft 內的舊 `stateHash`（若 JS 呼叫端硬塞）一律被覆蓋，不可能用來繞過。
 * - 語意錯誤的 draft 會得到 `readP3EState` 原本的精確錯誤（不會被包成別的碼）。
 */
export function sealP3EState(draft: Omit<P3ELifeState, "stateHash">): P3ELifeState {
  const stateHash = computeP3EStateHash(draft);
  return readP3EState({ ...draft, stateHash });
}

/* ------------------------------------------------------------------ */
/* Genesis                                                             */
/* ------------------------------------------------------------------ */

/**
 * 建立 P3-E 的 genesis state。
 *
 * 固定順序見檔頭；所有錯誤都是 `P3EError`，失敗不會回傳部分 state，也不修改 input。
 */
export function createP3EGenesis(input: unknown): P3ELifeState {
  const raw = readRawInput(input);

  // 2. 出生證書重播（必須先於 event／death／RNG）
  const certificate = verifyCertificate(raw);

  // 3–4. validated packs
  const eventBinding = readEventBinding(raw);
  const deathPack = readDeathPack(raw);

  // 5. 跨包綁定
  assertP3EDeathBinding(deathPack, certificate);

  // 6. bindings
  const identity = identityFromCertificate(certificate);
  const packs: P3EPackBindings = { events: eventBinding, death: deathBindingOf(deathPack) };

  // 7. Genesis 三條 RNG（這一步之前所有 pack／certificate 都已驗證）
  const rng = createP3EGenesisRng(raw.masterSeed as string, identity.birthYear);

  // 8. Genesis heads／command summary
  const integrity = createP3EGenesisIntegrity({ ...versionFields(), identity, packs });

  // 9. age=0 draft
  const draft: Omit<P3ELifeState, "stateHash"> = {
    ...versionFields(),
    identity,
    packs,
    currentYear: identity.birthYear,
    age: 0,
    phase: "life",
    pendingDecision: null,
    stats: { health: 50, happiness: 50, knowledge: 50, relationships: 50 },
    assets: { balanceMicroUsd: 0n, annualIncomeMicroUsd: 0n, annualExpenseMicroUsd: 0n },
    flags: [],
    occurrences: [],
    rng,
    heads: integrity.heads,
    commandLog: integrity.commandLog
  };

  // 10–11. seal（內部含 readP3EState 最終驗證）
  return sealP3EState(draft);
}
