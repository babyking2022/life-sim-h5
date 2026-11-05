/**
 * P3-D production barrel 隔離驗證（`pnpm p3d:isolation`，也由 `pnpm lint` 執行）。
 *
 * 三層證據：
 * 1. **靜態**：`packages/birth/src/death/index.ts` 只能用具名 export，而且匯出的名字
 *    必須剛好等於白名單 → 證明 P3-D 沒有把任何內部符號（錯誤工具、schema readers、
 *    deepFreeze、查表函式、checksum 投影、browser harness、數值工具）接出去。
 * 2. **P3-D 專屬符號**：把真正的 `packages/birth/src/index.ts`（`@life-sim/birth` 的入口）
 *    bundle 成 ESM 後，這些名字必須全部是 `undefined`。
 * 3. **與 P2-A 同名的既有符號**：`readString`／`readObject`／`deepFreeze`／`fail` 等
 *    在 P3-D 之前就已經是 P2-A 的公開表面（`packages/birth/src/schema.ts`／`validate.ts`／
 *    `errors.ts`）。P2-A 已關閉，不能移除；因此改為證明**它們仍然是 P2-A 的實作**
 *    （錯誤碼 `E_P2A_*`、錯誤類別 `BirthDataError`、`isPlainObject(new Date())` 為 true），
 *    也就是 P3-D 沒有覆蓋或替換它們。
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, ".artifacts", "p3d-isolation");
mkdirSync(outDir, { recursive: true });
const bundlePath = join(outDir, "public-birth.mjs");

const deathBarrel = readFileSync(join(root, "packages", "birth", "src", "death", "index.ts"), "utf8");
const birthBarrel = readFileSync(join(root, "packages", "birth", "src", "index.ts"), "utf8");

/** 允許出現在 P3-D production barrel 的符號（值與型別）。 */
const ALLOWED = [
  "validateDeathPack",
  "isValidatedDeathPack",
  "evaluateAnnualDeath",
  "DeathDataError",
  "isDeathDataError",
  "P3DEntityBinding",
  "P3DCauseSelection",
  "RawDeathPack",
  "ValidatedDeathPack",
  "P3DAnnualDeathInput",
  "P3DAnnualDeathResult",
  "P3DErrorCode"
];

/** P3-D 專屬、絕對不可外洩的內部符號。 */
const P3D_ONLY_FORBIDDEN = [
  "failDeath",
  "guardDeath",
  "readDeathExactObject",
  "deepFreezeDeath",
  "isPlainDeathObject",
  "hazardPpmOf",
  "entityBindingOf",
  "assertEntityRegionBinding",
  "causeSelectionOf",
  "mortalityKey",
  "causeKey",
  "computeDeathDatasetChecksum",
  "computeDeathPackChecksum",
  "deathPackChecksumProjection",
  "canonicalRowText",
  "DATASET_DIGEST_DOMAIN",
  "runDeathCases",
  "projectDeathResult",
  "adjustHazardPpm",
  "healthFactorPpm",
  "P3D_DIGEST_DOMAIN"
];

/** 與 P2-A 同名的既有公開符號：不得被 P3-D 覆蓋（用行為證明仍是 P2-A 實作）。 */
const SHARED_NAMES = [
  "isPlainObject",
  "readObject",
  "readExactObject",
  "readString",
  "readNullableString",
  "readInt",
  "readBoolean",
  "readArray",
  "readEnum",
  "readLiteral",
  "readChecksum",
  "deepFreeze",
  "fail"
];

let failures = 0;
let checks = 0;
function check(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`P3D-ISO-OK ${label}`);
    return;
  }
  failures += 1;
  console.error(`P3D-ISO-FAIL ${label} ${detail}`);
}

function codeOf(action) {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error && typeof error.code === "string" ? error.code : `OTHER:${error && error.name}`;
  }
}

/* ------------------------------------------------------------------ */
/* 1. 靜態：death barrel 只能具名 export，而且剛好是白名單              */
/* ------------------------------------------------------------------ */

check("death barrel 沒有 `export *`", !/export\s+\*\s+from/.test(deathBarrel));
check("birth barrel 有把 ./death 接出去", /export\s+\*\s+from\s+"\.\/death"/.test(birthBarrel));

const exportedNames = new Set();
for (const match of deathBarrel.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
  for (const raw of match[1].split(",")) {
    const name = raw.trim().split(/\s+as\s+/).pop().trim();
    if (name.length > 0) exportedNames.add(name);
  }
}

for (const name of ALLOWED) check(`death barrel 匯出 ${name}`, exportedNames.has(name));
for (const name of P3D_ONLY_FORBIDDEN) check(`death barrel 沒有匯出 ${name}`, !exportedNames.has(name));
for (const name of SHARED_NAMES) check(`death barrel 沒有轉出 P2-A 的 ${name}`, !exportedNames.has(name));
const unexpected = [...exportedNames].filter((name) => !ALLOWED.includes(name));
check("death barrel 沒有白名單以外的符號", unexpected.length === 0, JSON.stringify(unexpected));

/* ------------------------------------------------------------------ */
/* 2／3. 實際 bundle：`@life-sim/birth` 的完整公開表面                  */
/* ------------------------------------------------------------------ */

await build({
  entryPoints: [join(root, "packages", "birth", "src", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: bundlePath,
  logLevel: "silent"
});
const birth = await import(pathToFileURL(bundlePath).href);

check("bundle 可載入", typeof birth === "object" && birth !== null);
for (const name of ["validateDeathPack", "isValidatedDeathPack", "evaluateAnnualDeath", "DeathDataError", "isDeathDataError"]) {
  check(`bundle 公開 ${name}`, typeof birth[name] === "function", typeof birth[name]);
}
for (const name of P3D_ONLY_FORBIDDEN) {
  check(`bundle 未外洩 ${name}`, birth[name] === undefined, `typeof=${typeof birth[name]}`);
}

/* 同名符號必須仍是 P2-A 的實作（因此 P3-D 沒有覆蓋它們）。 */
for (const name of SHARED_NAMES) {
  check(`bundle 仍有 P2-A 的 ${name}`, typeof birth[name] === "function", typeof birth[name]);
}
check("readString 仍是 P2-A 實作（E_P2A_TYPE）", codeOf(() => birth.readString(1, "x")) === "E_P2A_TYPE");
check("readObject 仍是 P2-A 實作（E_P2A_TYPE）", codeOf(() => birth.readObject(1, "x")) === "E_P2A_TYPE");
check("readExactObject 仍是 P2-A 實作（E_P2A_TYPE）", codeOf(() => birth.readExactObject(1, "x", [])) === "E_P2A_TYPE");
check("readInt 仍是 P2-A 實作（E_P2A_TYPE）", codeOf(() => birth.readInt("x", "p", 0, 1)) === "E_P2A_TYPE");
check("readChecksum 仍是 P2-A 實作（E_P2A_TYPE）", codeOf(() => birth.readChecksum(1, "x")) === "E_P2A_TYPE");
check("isPlainObject 仍是 P2-A 語義（Date 視為物件）", birth.isPlainObject(new Date()) === true);
check(
  "fail 仍拋 P2-A 的 BirthDataError",
  (() => {
    try {
      birth.fail("E_P2A_TYPE", "x");
      return false;
    } catch (error) {
      return error.name === "BirthDataError";
    }
  })()
);
check("deepFreeze 仍是 P2-A 實作（會凍結深層物件）", (() => {
  const probe = { a: { b: 1 } };
  birth.deepFreeze(probe);
  return Object.isFrozen(probe) && Object.isFrozen(probe.a);
})());

/* 既有 P2 公開表面沒有被 P3-D 破壞。 */
for (const name of ["validateDataPack", "isValidatedDataPack", "drawBirth", "validateIdentityPack", "buildPeerGroup", "createBirthCertificate"]) {
  check(`bundle 仍公開 P2 ${name}`, typeof birth[name] === "function", typeof birth[name]);
}

if (failures > 0) {
  process.exitCode = 1;
  console.error(`P3D-ISO-FAIL ${failures}/${checks}`);
} else {
  console.log(`P3D-ISOLATION-OK all ${checks} checks passed`);
}
