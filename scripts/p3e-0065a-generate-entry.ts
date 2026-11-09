/**
 * GPT-WORKBUDDY-0065-A｜production birth bundle 產生器（build 期執行）。
 *
 * CTO 授權的 MVP 架構：把「靜態出生資料的完整驗證」從瀏覽器執行期移到建置期。
 * 這裡做三件事，且**不改任何演算法或資料**：
 *
 * 1. 讀取既有 14 個 P2-A／P2-B 出生 pack 檔（其中 7 個大型 dataset 就是
 *    0064 報告裡的 7 個 JSON 請求），用**現有正式 validators**
 *    `validateDataPack`／`validateIdentityPack` 完整驗證；
 * 2. 把已驗證、已正規化的 pack 投影成出生核心實際讀取的欄位，附上資料版本、
 *    bundle schema 版本、來源雜湊與可重現內容雜湊；
 * 3. 輸出單一 JSON：`fixtures/p3e/birth-bundle.v1.json`。
 *
 * 原始 fixtures 完全保留：正式世界（開始人生以前）仍走原路徑重新驗證；
 * 本 bundle 只供出生頁的 birth-lite production path 讀取。
 *
 * 用法（由 `scripts/p3e-0065a-birth-bundle.mjs` 以 esbuild 打包後呼叫）：
 *   run(["--auto"])   來源變更就自動重建，否則不動檔（避免無謂 mtime 變動）
 *   run(["--check"])  來源變更但 bundle 未更新 → 失敗（build gate）
 *   run(["--force"])  無條件重建
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { validateDataPack, validateIdentityPack } from "../packages/birth/src/index";
import {
  birthBundleContentHash,
  P3E_BIRTH_BUNDLE_SCHEMA_VERSION
} from "../packages/application/src/p3e-birth-core";

/** 投影邏輯改變時必須 bump，讓舊 bundle 無法靜默沿用。 */
export const BIRTH_BUNDLE_GENERATOR_VERSION = "0065a-projection-1";

const ROOT = resolve(process.cwd());
const OUT_PATH = join(ROOT, "fixtures", "p3e", "birth-bundle.v1.json");
const META_PATH = join(ROOT, ".artifacts", "p3e-0065a-bundle-meta.json");

/** 與 `packages/ui/src/p3e-birth-packs.ts` 的 14 個來源一一對應。 */
const SOURCES: readonly (readonly [string, string])[] = [
  ["p2aManifest", "fixtures/p2a/manifest.v1.json"],
  ["p2aCountryRegistry", "fixtures/p2a/country-registry.v1.json"],
  ["p2aIndicators", "fixtures/p2a/indicators.v1.json"],
  ["p2aBirthWeights", "fixtures/p2a/birth-weights.v1.json"],
  ["p2aSensitiveNames", "fixtures/p2a/sensitive-names.v1.json"],
  ["p2aLicenses", "fixtures/p2a/licenses.v1.json"],
  ["p2aLineage", "fixtures/p2a/lineage.v1.json"],
  ["p2bManifest", "fixtures/p2b/manifest.v1.json"],
  ["p2bCountryVitals", "fixtures/p2b/country-vitals.v1.json"],
  ["p2bHouseholdProfiles", "fixtures/p2b/household-profiles.v1.json"],
  ["p2bNameCorpus", "fixtures/p2b/name-corpus.v1.json"],
  ["p2bStoryTemplates", "fixtures/p2b/story-templates.v1.json"],
  ["p2bLicenses", "fixtures/p2b/licenses.v1.json"],
  ["p2bLineage", "fixtures/p2b/lineage.v1.json"]
] as const;

interface SourceSnapshot {
  readonly values: Readonly<Record<string, unknown>>;
  readonly hash: string;
  readonly bytes: number;
  readonly paths: readonly string[];
}

function readSources(): SourceSnapshot {
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const hash = createHash("sha256");
  let bytes = 0;
  const paths: string[] = [];
  for (const [, file] of [...SOURCES].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))) {
    const absolute = join(ROOT, file);
    const text = readFileSync(absolute, "utf8");
    hash.update(file);
    hash.update("\0");
    hash.update(text);
    hash.update("\0");
    bytes += Buffer.byteLength(text);
    paths.push(file);
  }
  for (const [key, file] of SOURCES) {
    values[key] = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as unknown;
  }
  return { values, hash: hash.digest("hex"), bytes, paths };
}

function rawBirthInput(values: Readonly<Record<string, unknown>>): { base: unknown; identity: unknown } {
  return {
    base: {
      manifest: values["p2aManifest"],
      datasets: {
        "country-registry": values["p2aCountryRegistry"],
        indicators: values["p2aIndicators"],
        "birth-weights": values["p2aBirthWeights"],
        "sensitive-names": values["p2aSensitiveNames"],
        licenses: values["p2aLicenses"],
        lineage: values["p2aLineage"]
      }
    },
    identity: {
      manifest: values["p2bManifest"],
      datasets: {
        "country-vitals": values["p2bCountryVitals"],
        "household-profiles": values["p2bHouseholdProfiles"],
        "name-corpus": values["p2bNameCorpus"],
        "story-templates": values["p2bStoryTemplates"],
        licenses: values["p2bLicenses"],
        lineage: values["p2bLineage"]
      }
    }
  };
}

/**
 * 只投影出生核心（`drawBirth`／`buildBirthIdentity`／`buildPeerGroup`／
 * `createBirthCertificate`）實際讀取的欄位。所有值都是 `validateDataPack`／
 * `validateIdentityPack` 的輸出，沒有重算、沒有簡化、沒有預先算好任何 seed。
 */
function projectValidated(base: ReturnType<typeof validateDataPack>, identity: ReturnType<typeof validateIdentityPack>) {
  const bm = base.manifest;
  const im = identity.manifest;
  return {
    base: {
      manifest: {
        packId: bm.packId,
        dataVersion: bm.dataVersion,
        packKind: bm.packKind,
        indicatorYear: bm.indicatorYear
      },
      packChecksum: base.packChecksum,
      enabledEntityIds: base.enabledEntityIds,
      birthShare: base.birthShare,
      birthWeightIndex: base.birthWeightIndex,
      registry: base.registry.map((record) => ({
        entityId: record.entityId,
        regionCode: record.regionCode,
        region: record.region
      })),
      displayNames: base.displayNames
    },
    identity: {
      manifest: {
        packId: im.packId,
        dataVersion: im.dataVersion,
        packKind: im.packKind,
        basePackId: im.basePackId,
        basePackChecksum: im.basePackChecksum,
        baseDataVersion: im.baseDataVersion,
        packChecksum: im.packChecksum
      },
      packChecksum: identity.packChecksum,
      vitalsByEntity: identity.vitalsByEntity,
      profileByCulture: identity.profileByCulture,
      namePoolsByCulture: identity.namePoolsByCulture,
      storiesByCulture: identity.storiesByCulture
    }
  };
}

type Bundle = {
  readonly schemaVersion: string;
  readonly generatorVersion: string;
  readonly dataVersion: { readonly base: string; readonly identity: string };
  readonly sourceHash: string;
  readonly contentHash: string;
  readonly payload: ReturnType<typeof projectValidated>;
};

function hashInputOf(snapshot: SourceSnapshot, payload: ReturnType<typeof projectValidated>, baseVersion: string, identityVersion: string) {
  return {
    schemaVersion: P3E_BIRTH_BUNDLE_SCHEMA_VERSION,
    generatorVersion: BIRTH_BUNDLE_GENERATOR_VERSION,
    dataVersion: { base: baseVersion, identity: identityVersion },
    sourceHash: snapshot.hash,
    payload
  };
}

function generate(): { bundle: Bundle; rawBytes: number; gzipBytes: number } {
  const snapshot = readSources();
  const raw = rawBirthInput(snapshot.values);
  const base = validateDataPack(raw.base as Parameters<typeof validateDataPack>[0]);
  const identity = validateIdentityPack(base, raw.identity as Parameters<typeof validateIdentityPack>[1]);
  const payload = projectValidated(base, identity);

  const dataVersion = { base: base.manifest.dataVersion, identity: identity.manifest.dataVersion };
  const contentHash = birthBundleContentHash(
    hashInputOf(snapshot, payload, dataVersion.base, dataVersion.identity)
  );
  const bundle: Bundle = {
    schemaVersion: P3E_BIRTH_BUNDLE_SCHEMA_VERSION,
    generatorVersion: BIRTH_BUNDLE_GENERATOR_VERSION,
    dataVersion,
    sourceHash: snapshot.hash,
    contentHash,
    payload
  };
  const text = JSON.stringify(bundle);
  mkdirSync(join(ROOT, "fixtures", "p3e"), { recursive: true });
  mkdirSync(join(ROOT, ".artifacts"), { recursive: true });
  writeFileSync(OUT_PATH, text, "utf8");
  const gzipBytes = gzipSync(Buffer.from(text)).length;
  writeFileSync(
    META_PATH,
    JSON.stringify(
      {
        output: relative(ROOT, OUT_PATH).replaceAll("\\", "/"),
        sources: snapshot.paths,
        sourceBytes: snapshot.bytes,
        sourceHash: snapshot.hash,
        generatorVersion: BIRTH_BUNDLE_GENERATOR_VERSION,
        contentHash,
        rawBytes: Buffer.byteLength(text),
        gzipBytes,
        basePackChecksum: base.packChecksum,
        identityPackChecksum: identity.packChecksum,
        dataVersion
      },
      null,
      2
    ),
    "utf8"
  );
  return { bundle, rawBytes: Buffer.byteLength(text), gzipBytes };
}

function currentBundle(): Bundle | null {
  if (!existsSync(OUT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(OUT_PATH, "utf8")) as Bundle;
  } catch {
    return null;
  }
}

function isCurrent(bundle: Bundle | null, snapshot: SourceSnapshot): boolean {
  if (bundle === null) return false;
  if (bundle.schemaVersion !== P3E_BIRTH_BUNDLE_SCHEMA_VERSION) return false;
  if (bundle.generatorVersion !== BIRTH_BUNDLE_GENERATOR_VERSION) return false;
  if (bundle.sourceHash !== snapshot.hash) return false;
  if (typeof bundle.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(bundle.contentHash)) return false;
  // 內容本身也要能重現（不只 metadata）：擋掉人手改過 payload 的 bundle。
  const rebuilt = generateInMemory(snapshot);
  return rebuilt.contentHash === bundle.contentHash;
}

function generateInMemory(snapshot: SourceSnapshot): Bundle {
  const raw = rawBirthInput(snapshot.values);
  const base = validateDataPack(raw.base as Parameters<typeof validateDataPack>[0]);
  const identity = validateIdentityPack(base, raw.identity as Parameters<typeof validateIdentityPack>[1]);
  const payload = projectValidated(base, identity);
  const dv = { base: base.manifest.dataVersion, identity: identity.manifest.dataVersion };
  return {
    schemaVersion: P3E_BIRTH_BUNDLE_SCHEMA_VERSION,
    generatorVersion: BIRTH_BUNDLE_GENERATOR_VERSION,
    dataVersion: dv,
    sourceHash: snapshot.hash,
    contentHash: birthBundleContentHash(hashInputOf(snapshot, payload, dv.base, dv.identity)),
    payload
  };
}

export function run(argv: readonly string[]): void {
  const check = argv.includes("--check");
  const force = argv.includes("--force");
  const auto = argv.includes("--auto");
  const snapshot = readSources();
  const existing = currentBundle();
  if (!force && isCurrent(existing, snapshot)) {
    console.log(
      `P3E-0065A-BUNDLE OK unchanged output=${relative(ROOT, OUT_PATH).replaceAll("\\", "/")} ` +
        `bytes=${statSync(OUT_PATH).size} sourceHash=${snapshot.hash.slice(0, 12)}`
    );
    return;
  }
  if (check) {
    console.error(
      `P3E-0065A-BUNDLE STALE 來源資料或產生器已變更，但 bundle 未更新；` +
        `請執行 node scripts/p3e-0065a-birth-bundle.mjs --force`
    );
    process.exitCode = 1;
    return;
  }
  if (!auto && !force) {
    console.error("P3E-0065A-BUNDLE 需要 --auto／--check／--force 之一");
    process.exitCode = 1;
    return;
  }
  const result = generate();
  console.log(
    `P3E-0065A-BUNDLE GENERATED output=${relative(ROOT, OUT_PATH).replaceAll("\\", "/")} ` +
      `raw=${result.rawBytes}B gzip=${result.gzipBytes}B sources=${snapshot.paths.length} ` +
      `contentHash=${result.bundle.contentHash.slice(0, 12)} sourceHash=${snapshot.hash.slice(0, 12)}`
  );
}
