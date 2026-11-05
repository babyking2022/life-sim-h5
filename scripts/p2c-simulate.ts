/**
 * P2-C 出生分布模擬：10,000 名玩家 + 40,000 名 peers（合計 50,000）。
 *
 * 用法：pnpm p2c:simulate
 *
 * 驗收容差在執行前就固定在本檔（見 TOLERANCE），不得看到結果後調整。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BirthIdentity, DatasetEnvelope } from "@life-sim/contracts";
import { validateIdentityPack } from "../packages/birth/src/identity/validate";
import { buildPeerGroup } from "../packages/birth/src/peer/group";
import { birthWeightKey, validateDataPack } from "../packages/birth/src/validate";

const ROOT = process.cwd();
const PLAYER_COUNT = 10_000;
const PEER_COUNT_PER_PLAYER = 4;
const TOTAL_COUNT = PLAYER_COUNT * (1 + PEER_COUNT_PER_PLAYER);

/**
 * 預先註冊的容差（執行前固定）：
 * - sigma = 4：以二項分布的 4 個標準差為上限。
 * - metricFloor = 0.004：性別／體重帶／城鄉／收入／住宅／宗教／區域等彙總指標的絕對誤差下限。
 * - countryFloor = 0.0015：172 個國家與地區逐項檢查的絕對誤差下限（小樣本）。
 * - minExpectedCountForCountry = 5：期望次數 < 5 的國家只記錄、不做比例判定（避免不適用的卡方結論）。
 */
const TOLERANCE = {
  sigma: 4,
  metricFloor: 0.004,
  countryFloor: 0.0015,
  regionFloor: 0.004,
  minExpectedCountForCountry: 5
} as const;

type GroupName = "player" | "peers" | "total";

interface Counter {
  readonly map: Map<string, number>;
}

const createCounter = (): Counter => ({ map: new Map() });
const bump = (counter: Counter, key: string): void => {
  counter.map.set(key, (counter.map.get(key) ?? 0) + 1);
};

function sortedEntries(counter: Counter): Array<{ key: string; count: number }> {
  return [...counter.map.entries()].map(([key, count]) => ({ key, count })).sort((left, right) => (left.key < right.key ? -1 : 1));
}

const counters: Record<GroupName, Record<string, Counter>> = {
  player: {},
  peers: {},
  total: {}
};

function bumpMetric(group: GroupName, metric: string, key: string): void {
  const metrics = counters[group];
  const counter = (metrics[metric] ??= createCounter());
  bump(counter, key);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadBase() {
  const dir = join(ROOT, "fixtures", "p2a");
  const read = (file: string) => readJson(join(dir, file)) as DatasetEnvelope<unknown>;
  return {
    manifest: readJson(join(dir, "manifest.v1.json")),
    datasets: {
      "country-registry": read("country-registry.v1.json"),
      indicators: read("indicators.v1.json"),
      "birth-weights": read("birth-weights.v1.json"),
      "sensitive-names": read("sensitive-names.v1.json"),
      licenses: read("licenses.v1.json"),
      lineage: read("lineage.v1.json")
    }
  };
}

function loadIdentity() {
  const dir = join(ROOT, "fixtures", "p2b");
  const read = (file: string) => readJson(join(dir, file)) as DatasetEnvelope<unknown>;
  return {
    manifest: readJson(join(dir, "manifest.v1.json")),
    datasets: {
      "country-vitals": read("country-vitals.v1.json"),
      "household-profiles": read("household-profiles.v1.json"),
      "name-corpus": read("name-corpus.v1.json"),
      "story-templates": read("story-templates.v1.json"),
      licenses: read("licenses.v1.json"),
      lineage: read("lineage.v1.json")
    }
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 固定 key 排序的 JSON（模擬報告含比例浮點，不能用 canonicalBytes）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function main(): void {
  const base = validateDataPack(loadBase() as never);
  const pack = validateIdentityPack(base, loadIdentity() as never);

  /* --- 期望分布（由資料包解析，不看模擬結果） ------------------------- */
  const entityIds = [...base.entityIds].sort();
  const shareTotal = entityIds.reduce((sum, entityId) => sum + (base.birthShare[entityId] ?? 0), 0);
  const expected: Record<string, Map<string, number>> = {
    country: new Map(),
    region: new Map(),
    sex: new Map([["female", 0.5], ["male", 0.5]]),
    band: new Map(),
    urban: new Map(),
    income: new Map(),
    housing: new Map(),
    religion: new Map()
  };
  const cultureOf = new Map<string, string>();
  const regionOf = new Map<string, string>();
  for (const record of base.registry) {
    regionOf.set(record.entityId, record.region);
    cultureOf.set(record.entityId, pack.vitalsByEntity[record.entityId]?.cultureId ?? "unknown");
  }
  const bandIds = new Set<string>();
  for (const entityId of entityIds) {
    const weight = (base.birthShare[entityId] ?? 0) / shareTotal;
    expected.country?.set(entityId, weight);
    const region = regionOf.get(entityId) as string;
    expected.region?.set(region, (expected.region.get(region) ?? 0) + weight);
    const cultureId = cultureOf.get(entityId) as string;
    const profile = pack.profileByCulture[cultureId];
    if (!profile) throw new Error(`missing profile ${cultureId}`);
    expected.urban?.set("urban", (expected.urban.get("urban") ?? 0) + weight * (profile.urbanSharePpm / 1_000_000));
    expected.urban?.set("rural", (expected.urban.get("rural") ?? 0) + weight * (1 - profile.urbanSharePpm / 1_000_000));
    profile.incomeQuintilePpm.forEach((ppm, index) => {
      expected.income?.set(String(index + 1), (expected.income.get(String(index + 1)) ?? 0) + weight * (ppm / 1_000_000));
    });
    for (const share of profile.housing) {
      expected.housing?.set(share.housingId, (expected.housing.get(share.housingId) ?? 0) + weight * (share.weightPpm / 1_000_000));
    }
    for (const share of profile.religions) {
      expected.religion?.set(share.religionId, (expected.religion.get(share.religionId) ?? 0) + weight * (share.weightPpm / 1_000_000));
    }
    const female = base.birthWeightIndex[birthWeightKey(entityId, "female")];
    const male = base.birthWeightIndex[birthWeightKey(entityId, "male")];
    for (const band of female?.bands ?? []) {
      bandIds.add(band.bandId);
      const maleBand = male?.bands.find((entry) => entry.bandId === band.bandId);
      const ppm = (band.weightPpm + (maleBand?.weightPpm ?? band.weightPpm)) / 2;
      expected.band?.set(band.bandId, (expected.band.get(band.bandId) ?? 0) + weight * (ppm / 1_000_000));
    }
  }

  /* --- 模擬 ------------------------------------------------------------ */
  const errors: Record<string, number> = {};
  let duplicatePeerIds = 0;
  let outOfRange = 0;
  let missingData = 0;
  const seenPeerIds = new Set<string>();

  const recordIdentity = (group: GroupName, identity: BirthIdentity): void => {
    bumpMetric(group, "country", identity.birth.entityId);
    bumpMetric(group, "region", regionOf.get(identity.birth.entityId) ?? "unknown");
    bumpMetric(group, "sex", identity.birth.sex);
    bumpMetric(group, "band", identity.birth.weightBandId);
    bumpMetric(group, "urban", identity.place.settlement);
    bumpMetric(group, "income", String(identity.household.incomeQuintile));
    bumpMetric(group, "housing", identity.household.housing);
    bumpMetric(group, "religion", identity.religion.religionId);
    if (
      identity.vitals.lifeExpectancyYearsX10 < 300 ||
      identity.vitals.lifeExpectancyYearsX10 > 1000 ||
      identity.vitals.under5MortalityPer1000X10 < 0 ||
      identity.vitals.under5MortalityPer1000X10 > 2000 ||
      identity.vitals.gdpPerCapitaPppUsd < 100 ||
      identity.vitals.gdpPerCapitaPppUsd > 200000 ||
      identity.household.incomeQuintile < 1 ||
      identity.household.incomeQuintile > 5
    ) {
      outOfRange += 1;
    }
    if (!identity.name.fullName || !identity.certificate.fullNumber || !identity.story.templateId) missingData += 1;
  };

  for (let index = 0; index < PLAYER_COUNT; index += 1) {
    const seed = `p2c-sim-${String(index).padStart(5, "0")}`;
    try {
      const group = buildPeerGroup(base, pack, { seed, playerSexPolicy: "random" });
      recordIdentity("player", group.player);
      recordIdentity("total", group.player);
      for (const peer of group.peers) {
        if (seenPeerIds.has(peer.peerId)) duplicatePeerIds += 1;
        seenPeerIds.add(peer.peerId);
        recordIdentity("peers", peer.identity);
        recordIdentity("total", peer.identity);
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? "OTHER";
      errors[code] = (errors[code] ?? 0) + 1;
    }
  }

  /* --- 統計與檢查 ------------------------------------------------------ */
  const groupSizes: Record<GroupName, number> = { player: PLAYER_COUNT, peers: PLAYER_COUNT * PEER_COUNT_PER_PLAYER, total: TOTAL_COUNT };
  const stats: Record<GroupName, Record<string, Array<{ key: string; count: number }>>> = { player: {}, peers: {}, total: {} };
  for (const group of ["player", "peers", "total"] as const) {
    for (const metric of Object.keys(counters[group])) {
      stats[group][metric] = sortedEntries(counters[group][metric] as Counter);
    }
  }

  interface Check {
    readonly metric: string;
    readonly scope: GroupName;
    readonly category: string;
    readonly expected: number;
    readonly observed: number;
    readonly difference: number;
    readonly tolerance: number;
    readonly pass: boolean;
    readonly note?: string;
  }

  const metricFloor: Record<string, number> = {
    country: TOLERANCE.countryFloor,
    region: TOLERANCE.regionFloor
  };
  const checks: Check[] = [];
  let skippedSmallExpected = 0;
  for (const metric of ["country", "region", "sex", "band", "urban", "income", "housing", "religion"]) {
    const expectedMap = expected[metric] as Map<string, number>;
    const categories = new Set<string>([...expectedMap.keys()]);
    for (const group of ["player", "peers", "total"] as const) {
      for (const entry of stats[group][metric] ?? []) categories.add(entry.key);
    }
    for (const category of [...categories].sort()) {
      const p = expectedMap.get(category) ?? 0;
      for (const group of ["player", "peers", "total"] as const) {
        const n = groupSizes[group];
        const count = stats[group][metric]?.find((entry) => entry.key === category)?.count ?? 0;
        const observed = count / n;
        if (metric === "country" && p * n < TOLERANCE.minExpectedCountForCountry) {
          skippedSmallExpected += 1;
          continue;
        }
        const sigma = Math.sqrt(Math.max(p * (1 - p), 1e-12) / n);
        const floor = metricFloor[metric] ?? TOLERANCE.metricFloor;
        const tolerance = Math.max(floor, TOLERANCE.sigma * sigma);
        const difference = observed - p;
        checks.push({ metric, scope: group, category, expected: p, observed, difference, tolerance, pass: Math.abs(difference) <= tolerance });
      }
    }
  }

  const failures = checks.filter((check) => !check.pass);
  const countsOk = stats.player.country?.reduce((sum, entry) => sum + entry.count, 0) === PLAYER_COUNT &&
    stats.peers.country?.reduce((sum, entry) => sum + entry.count, 0) === groupSizes.peers &&
    stats.total.country?.reduce((sum, entry) => sum + entry.count, 0) === TOTAL_COUNT;
  const totals = {
    players: stats.player.country?.reduce((sum, entry) => sum + entry.count, 0) ?? 0,
    peers: stats.peers.country?.reduce((sum, entry) => sum + entry.count, 0) ?? 0,
    total: stats.total.country?.reduce((sum, entry) => sum + entry.count, 0) ?? 0
  };
  const verdict = failures.length === 0 && countsOk && duplicatePeerIds === 0 && outOfRange === 0 && missingData === 0
    && Object.values(errors).every((value) => value === 0)
    ? "PASS"
    : "FAIL";

  const report = {
    schemaVersion: "p2c-1",
    generatedAt: "2026-10-27",
    scope: "synthetic fixture; 只驗證抽樣器，不代表真實人口分布",
    config: { players: PLAYER_COUNT, peersPerPlayer: PEER_COUNT_PER_PLAYER, total: TOTAL_COUNT, seedPattern: "p2c-sim-#####", sexPolicy: "random" },
    packs: { basePackId: base.manifest.packId, basePackChecksum: base.packChecksum, identityPackId: pack.manifest.packId, identityPackChecksum: pack.packChecksum },
    tolerance: { ...TOLERANCE },
    totals,
    errors: { ...errors, duplicatePeerIds, outOfRange, missingData },
    skippedSmallExpected,
    checks: { total: checks.length, failures: failures.length, failed: failures.slice(0, 50) },
    stats,
    simulationHash: ""
  };
  const simulationHash = sha256(stableStringify(report));
  report.simulationHash = simulationHash;

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(join(ROOT, "reports", "p2c-distribution-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  /* --- Markdown 報告 --------------------------------------------------- */
  const pct = (value: number): string => `${(value * 100).toFixed(3)}%`;
  const table = (rows: string[][]): string => {
    const [head, ...body] = rows as [string[], ...string[][]];
    return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...body.map((row) => `| ${row.join(" | ")} |`)].join("\n");
  };
  const metricTable = (metric: string, title: string): string => {
    const expectedMap = expected[metric] as Map<string, number>;
    const categories = [...new Set([...expectedMap.keys(), ...(stats.total[metric] ?? []).map((entry) => entry.key)])].sort();
    const rows: string[][] = [["分類", "期望比例", "玩家觀察", "peers 觀察", "合計觀察", "合計差異", "容差", "結果"]];
    for (const category of categories) {
      const p = expectedMap.get(category) ?? 0;
      const observed = (group: GroupName) => (stats[group][metric]?.find((entry) => entry.key === category)?.count ?? 0) / groupSizes[group];
      const check = checks.find((entry) => entry.metric === metric && entry.scope === "total" && entry.category === category);
      rows.push([
        category,
        pct(p),
        pct(observed("player")),
        pct(observed("peers")),
        pct(observed("total")),
        `${((observed("total") - p) * 100).toFixed(3)}pp`,
        check ? `${(check.tolerance * 100).toFixed(3)}pp` : "—",
        check ? (check.pass ? "PASS" : "FAIL") : "sample<5"
      ]);
    }
    return `### ${title}\n\n${table(rows)}`;
  };

  const lines = [
    "# P2-C 出生分布模擬報告（10,000 玩家／40,000 peers／50,000 合計）",
    "",
    `- 產生日期：2026-10-27`,
    `- 範圍：**synthetic fixture；只驗證抽樣器，不代表真實人口分布。**`,
    `- 設定：players=${PLAYER_COUNT}、peers/player=${PEER_COUNT_PER_PLAYER}、total=${TOTAL_COUNT}、seedPattern=\`p2c-sim-#####\`、sexPolicy=random`,
    `- packs：base \`${base.packChecksum.slice(0, 12)}…\`／identity \`${pack.packChecksum.slice(0, 12)}…\``,
    `- simulationHash：\`${simulationHash}\``,
    "",
    "## 預先註冊的容差（執行前固定）",
    "",
    "| 參數 | 值 | 說明 |",
    "|---|---|---|",
    `| sigma | ${TOLERANCE.sigma} | 二項分布標準差的倍數 |`,
    `| metricFloor | ${TOLERANCE.metricFloor} | 性別／體重帶／城鄉／收入／住宅／宗教／區域的絕對誤差下限 |`,
    `| countryFloor | ${TOLERANCE.countryFloor} | 172 國逐項檢查的絕對誤差下限 |`,
    `| regionFloor | ${TOLERANCE.regionFloor} | 區域彙總的絕對誤差下限 |`,
    `| minExpectedCountForCountry | ${TOLERANCE.minExpectedCountForCountry} | 期望次數低於此值的國家不做比例判定（避免不適用的卡方結論） |`,
    "",
    "## 樣本數與錯誤",
    "",
    table([
      ["項目", "數值"],
      ["players", String(totals.players)],
      ["peers", String(totals.peers)],
      ["total", String(totals.total)],
      ["擲出錯誤", String(Object.values(errors).reduce((sum, value) => sum + value, 0))],
      ["重複 peerId", String(duplicatePeerIds)],
      ["越界值", String(outOfRange)],
      ["缺資料", String(missingData)],
      ["小期望次數（僅記錄）", String(skippedSmallExpected)],
      ["檢查項", `${checks.length}（失敗 ${failures.length}）`],
      ["判定", verdict]
    ]),
    "",
    metricTable("region", "區域分布"),
    metricTable("sex", "性別分布"),
    metricTable("band", "出生體重帶"),
    metricTable("urban", "城鄉"),
    metricTable("income", "家庭收入五分位"),
    metricTable("housing", "住宅"),
    metricTable("religion", "宗教"),
    "",
    "## 國家與地區（172 項）",
    "",
    `172 個分類多數期望次數很小，因此**不使用卡方結論**；逐項以「期望次數 ≥ ${TOLERANCE.minExpectedCountForCountry}」與預先註冊的絕對誤差下限檢查。完整 172 項在 \`reports/p2c-distribution-report.json\`。`,
    "",
    "前 10 名（合計）：",
    "",
    table([
      ["國家與地區", "期望", "合計觀察", "差異"],
      ...(stats.total.country ?? [])
        .slice()
        .sort((left, right) => right.count - left.count)
        .slice(0, 10)
        .map((entry) => [
          entry.key,
          pct(expected.country?.get(entry.key) ?? 0),
          pct(entry.count / TOTAL_COUNT),
          `${(((entry.count / TOTAL_COUNT) - (expected.country?.get(entry.key) ?? 0)) * 100).toFixed(3)}pp`
        ])
    ]),
    "",
    `- simulationHash 重跑必須一致（見 JSON）。`,
    `- 本報告只驗證抽樣器；資料仍是 synthetic，不可描述為真實人口統計。`
  ];
  writeFileSync(join(ROOT, "P2-C-distribution-report.md"), `${lines.join("\n")}\n`, "utf8");

  console.log(`P2C-SIM-OK players=${totals.players} peers=${totals.peers} total=${totals.total} checks=${checks.length} failures=${failures.length} errors=${Object.values(errors).reduce((sum, value) => sum + value, 0)} verdict=${verdict} simulationHash=${simulationHash.slice(0, 12)}…`);
  if (verdict !== "PASS") process.exitCode = 1;
}

main();
