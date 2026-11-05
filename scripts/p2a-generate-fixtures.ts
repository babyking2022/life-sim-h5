/**
 * P2-A fixture 產生器（確定性）。
 *
 * 只產生「合成測試資料」，不是官方統計。所有數值由 entityId 的 SHA-256 推導，
 * 因此同一份程式碼在任何機器、任何時間跑都會得到相同 bytes。
 *
 * 用法：pnpm p2a:fixtures
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BirthWeightBand,
  BirthWeightRecord,
  CountryRegionRecord,
  DataPackManifest,
  DatasetDescriptor,
  DatasetEnvelope,
  DatasetId,
  IndicatorRecord,
  LicenseRecord,
  LineageRecord,
  RegionClass,
  SensitiveNameRecord
} from "@life-sim/contracts";
import { P2A_DATASET_IDS, P2A_ENTITY_COUNT, P2A_SCHEMA_VERSION, P2A_WEIGHT_PPM_TOTAL } from "@life-sim/contracts";
import { computeDatasetChecksum, computePackChecksum, validateDataPack } from "../packages/birth/src/validate";

const ROOT = process.cwd();
const OUT = join(ROOT, "fixtures", "p2a");
const SCHEMA = P2A_SCHEMA_VERSION;
const DATA_VERSION = "1.0.0";
const INDICATOR_YEAR = 2024;
const CREATED_AT = "2026-10-27";
const PACK_ID = "p2a-synthetic-20261027";
const ENGINE_VERSION = "0.1.0";
const RNG_SPEC_VERSION = "1.0.0";

type Row = readonly [code: string, name: string | null, region: RegionClass];

/* 198 個國家與地區的授權來源表；DROP 之後剛好 172。 */
const ROWS: readonly Row[] = [
  /* africa */
  ["DZA", "阿尔及利亚", "africa"],
  ["AGO", "安哥拉", "africa"],
  ["BEN", "贝宁", "africa"],
  ["BWA", "博茨瓦纳", "africa"],
  ["BFA", "布基纳法索", "africa"],
  ["BDI", "布隆迪", "africa"],
  ["CPV", "佛得角", "africa"],
  ["CMR", "喀麦隆", "africa"],
  ["CAF", "中非", "africa"],
  ["TCD", "乍得", "africa"],
  ["COM", "科摩罗", "africa"],
  ["COG", "刚果（布）", "africa"],
  ["COD", "刚果（金）", "africa"],
  ["CIV", "科特迪瓦", "africa"],
  ["DJI", "吉布提", "africa"],
  ["EGY", "埃及", "africa"],
  ["GNQ", "赤道几内亚", "africa"],
  ["ERI", "厄立特里亚", "africa"],
  ["SWZ", "斯威士兰", "africa"],
  ["ETH", "埃塞俄比亚", "africa"],
  ["GAB", "加蓬", "africa"],
  ["GMB", "冈比亚", "africa"],
  ["GHA", "加纳", "africa"],
  ["GIN", "几内亚", "africa"],
  ["GNB", "几内亚比绍", "africa"],
  ["KEN", "肯尼亚", "africa"],
  ["LSO", "莱索托", "africa"],
  ["LBR", "利比里亚", "africa"],
  ["LBY", "利比亚", "africa"],
  ["MDG", "马达加斯加", "africa"],
  ["MWI", "马拉维", "africa"],
  ["MLI", "马里", "africa"],
  ["MRT", "毛里塔尼亚", "africa"],
  ["MUS", "毛里求斯", "africa"],
  ["MAR", "摩洛哥", "africa"],
  ["MOZ", "莫桑比克", "africa"],
  ["NAM", "纳米比亚", "africa"],
  ["NER", "尼日尔", "africa"],
  ["NGA", "尼日利亚", "africa"],
  ["RWA", "卢旺达", "africa"],
  ["STP", "圣多美和普林西比", "africa"],
  ["SEN", "塞内加尔", "africa"],
  ["SYC", "塞舌尔", "africa"],
  ["SLE", "塞拉利昂", "africa"],
  ["SOM", "索马里", "africa"],
  ["ZAF", "南非", "africa"],
  ["SSD", "南苏丹", "africa"],
  ["SDN", "苏丹", "africa"],
  ["TZA", "坦桑尼亚", "africa"],
  ["TGO", "多哥", "africa"],
  ["TUN", "突尼斯", "africa"],
  ["UGA", "乌干达", "africa"],
  ["ZMB", "赞比亚", "africa"],
  ["ZWE", "津巴布韦", "africa"],
  /* asia */
  ["AFG", "阿富汗", "asia"],
  ["ARM", "亚美尼亚", "asia"],
  ["AZE", "阿塞拜疆", "asia"],
  ["BHR", "巴林", "asia"],
  ["BGD", "孟加拉国", "asia"],
  ["BTN", "不丹", "asia"],
  ["BRN", "文莱", "asia"],
  ["KHM", "柬埔寨", "asia"],
  ["CHN", "中国", "asia"],
  ["CYP", "塞浦路斯", "asia"],
  ["GEO", "格鲁吉亚", "asia"],
  ["HKG", null, "asia"],
  ["IND", "印度", "asia"],
  ["IDN", "印度尼西亚", "asia"],
  ["IRN", "伊朗", "asia"],
  ["IRQ", "伊拉克", "asia"],
  ["ISR", "以色列", "asia"],
  ["JPN", "日本", "asia"],
  ["JOR", "约旦", "asia"],
  ["KAZ", "哈萨克斯坦", "asia"],
  ["KWT", "科威特", "asia"],
  ["KGZ", "吉尔吉斯斯坦", "asia"],
  ["LAO", "老挝", "asia"],
  ["LBN", "黎巴嫩", "asia"],
  ["MAC", null, "asia"],
  ["MYS", "马来西亚", "asia"],
  ["MDV", "马尔代夫", "asia"],
  ["MNG", "蒙古", "asia"],
  ["MMR", "缅甸", "asia"],
  ["NPL", "尼泊尔", "asia"],
  ["PRK", "朝鲜", "asia"],
  ["OMN", "阿曼", "asia"],
  ["PAK", "巴基斯坦", "asia"],
  ["PSE", "巴勒斯坦", "asia"],
  ["PHL", "菲律宾", "asia"],
  ["QAT", "卡塔尔", "asia"],
  ["SAU", "沙特阿拉伯", "asia"],
  ["SGP", "新加坡", "asia"],
  ["KOR", "韩国", "asia"],
  ["LKA", "斯里兰卡", "asia"],
  ["SYR", "叙利亚", "asia"],
  ["TWN", null, "asia"],
  ["TJK", "塔吉克斯坦", "asia"],
  ["THA", "泰国", "asia"],
  ["TLS", "东帝汶", "asia"],
  ["TUR", "土耳其", "asia"],
  ["TKM", "土库曼斯坦", "asia"],
  ["ARE", "阿联酋", "asia"],
  ["UZB", "乌兹别克斯坦", "asia"],
  ["VNM", "越南", "asia"],
  ["YEM", "也门", "asia"],
  /* europe */
  ["ALB", "阿尔巴尼亚", "europe"],
  ["AND", "安道尔", "europe"],
  ["AUT", "奥地利", "europe"],
  ["BLR", "白俄罗斯", "europe"],
  ["BEL", "比利时", "europe"],
  ["BIH", "波黑", "europe"],
  ["BGR", "保加利亚", "europe"],
  ["HRV", "克罗地亚", "europe"],
  ["CZE", "捷克", "europe"],
  ["DNK", "丹麦", "europe"],
  ["EST", "爱沙尼亚", "europe"],
  ["FIN", "芬兰", "europe"],
  ["FRA", "法国", "europe"],
  ["DEU", "德国", "europe"],
  ["GRC", "希腊", "europe"],
  ["HUN", "匈牙利", "europe"],
  ["ISL", "冰岛", "europe"],
  ["IRL", "爱尔兰", "europe"],
  ["ITA", "意大利", "europe"],
  ["LVA", "拉脱维亚", "europe"],
  ["LIE", "列支敦士登", "europe"],
  ["LTU", "立陶宛", "europe"],
  ["LUX", "卢森堡", "europe"],
  ["MLT", "马耳他", "europe"],
  ["MDA", "摩尔多瓦", "europe"],
  ["MCO", "摩纳哥", "europe"],
  ["MNE", "黑山", "europe"],
  ["NLD", "荷兰", "europe"],
  ["MKD", "北马其顿", "europe"],
  ["NOR", "挪威", "europe"],
  ["POL", "波兰", "europe"],
  ["PRT", "葡萄牙", "europe"],
  ["ROU", "罗马尼亚", "europe"],
  ["RUS", "俄罗斯", "europe"],
  ["SMR", "圣马力诺", "europe"],
  ["SRB", "塞尔维亚", "europe"],
  ["SVK", "斯洛伐克", "europe"],
  ["SVN", "斯洛文尼亚", "europe"],
  ["ESP", "西班牙", "europe"],
  ["SWE", "瑞典", "europe"],
  ["CHE", "瑞士", "europe"],
  ["UKR", "乌克兰", "europe"],
  ["GBR", "英国", "europe"],
  ["VAT", "梵蒂冈", "europe"],
  /* americas */
  ["ATG", "安提瓜和巴布达", "americas"],
  ["ARG", "阿根廷", "americas"],
  ["BHS", "巴哈马", "americas"],
  ["BRB", "巴巴多斯", "americas"],
  ["BLZ", "伯利兹", "americas"],
  ["BOL", "玻利维亚", "americas"],
  ["BRA", "巴西", "americas"],
  ["CAN", "加拿大", "americas"],
  ["CHL", "智利", "americas"],
  ["COL", "哥伦比亚", "americas"],
  ["CRI", "哥斯达黎加", "americas"],
  ["CUB", "古巴", "americas"],
  ["DMA", "多米尼克", "americas"],
  ["DOM", "多米尼加", "americas"],
  ["ECU", "厄瓜多尔", "americas"],
  ["SLV", "萨尔瓦多", "americas"],
  ["GRD", "格林纳达", "americas"],
  ["GTM", "危地马拉", "americas"],
  ["GUY", "圭亚那", "americas"],
  ["HTI", "海地", "americas"],
  ["HND", "洪都拉斯", "americas"],
  ["JAM", "牙买加", "americas"],
  ["MEX", "墨西哥", "americas"],
  ["NIC", "尼加拉瓜", "americas"],
  ["PAN", "巴拿马", "americas"],
  ["PRY", "巴拉圭", "americas"],
  ["PER", "秘鲁", "americas"],
  ["KNA", "圣基茨和尼维斯", "americas"],
  ["LCA", "圣卢西亚", "americas"],
  ["VCT", "圣文森特和格林纳丁斯", "americas"],
  ["SUR", "苏里南", "americas"],
  ["TTO", "特立尼达和多巴哥", "americas"],
  ["USA", "美国", "americas"],
  ["URY", "乌拉圭", "americas"],
  ["VEN", "委内瑞拉", "americas"],
  /* oceania */
  ["AUS", "澳大利亚", "oceania"],
  ["FJI", "斐济", "oceania"],
  ["KIR", "基里巴斯", "oceania"],
  ["MHL", "马绍尔群岛", "oceania"],
  ["FSM", "密克罗尼西亚", "oceania"],
  ["NRU", "瑙鲁", "oceania"],
  ["NZL", "新西兰", "oceania"],
  ["PLW", "帕劳", "oceania"],
  ["PNG", "巴布亚新几内亚", "oceania"],
  ["WSM", "萨摩亚", "oceania"],
  ["SLB", "所罗门群岛", "oceania"],
  ["TON", "汤加", "oceania"],
  ["TUV", "图瓦卢", "oceania"],
  ["VUT", "瓦努阿图", "oceania"]
];

/**
 * 172 = 169 個主權／觀察員 + 3 個敏感地區（HKG、MAC、TWN）。
 * 這 26 個小型國家與地區先不進 P2-A 合成包；正式 172 名單待產品確認。
 */
const DROPPED = new Set([
  "VAT",
  "SMR",
  "MCO",
  "LIE",
  "AND",
  "NRU",
  "TUV",
  "PLW",
  "MHL",
  "KIR",
  "FSM",
  "STP",
  "SYC",
  "COM",
  "DMA",
  "KNA",
  "LCA",
  "VCT",
  "GRD",
  "ATG",
  "BRB",
  "BHS",
  "BLZ",
  "TTO",
  "MDV",
  "BTN"
]);

const SENSITIVE = new Set(["HKG", "MAC", "TWN"]);

function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function u32(text: string): number {
  return digest(text).readUInt32BE(0);
}

function writeDataset(file: string, dataset: DatasetId, records: readonly object[]): void {
  const head = `{\n  "schemaVersion": ${JSON.stringify(SCHEMA)},\n  "dataVersion": ${JSON.stringify(DATA_VERSION)},\n  "dataset": ${JSON.stringify(dataset)},\n  "records": [\n`;
  const body = records.map((record) => `    ${JSON.stringify(record)}`).join(",\n");
  writeFileSync(join(OUT, file), `${head}${body}\n  ]\n}\n`, "utf8");
}

function readDataset(file: string): DatasetEnvelope<unknown> {
  return JSON.parse(readFileSync(join(OUT, file), "utf8")) as DatasetEnvelope<unknown>;
}

function checksumOf(file: string): string {
  return computeDatasetChecksum(readDataset(file));
}

function bandWeights(code: string, sex: string): number[] {
  const base = [80, 260, 500, 140, 20];
  const jittered = base.map((value, index) => Math.max(1, value + ((u32(`band:${code}:${sex}:${index}`) % 41) - 20)));
  const total = jittered.reduce((sum, value) => sum + value, 0);
  const scaled = jittered.map((value) => Math.floor((value * P2A_WEIGHT_PPM_TOTAL) / total));
  let remainder = P2A_WEIGHT_PPM_TOTAL - scaled.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  while (remainder > 0) {
    const index = cursor % scaled.length;
    scaled[index] = (scaled[index] as number) + 1;
    remainder -= 1;
    cursor += 1;
  }
  return scaled;
}

function main(): void {
  mkdirSync(OUT, { recursive: true });

  const selected = ROWS.filter((row) => !DROPPED.has(row[0]));
  if (selected.length !== P2A_ENTITY_COUNT) {
    throw new Error(`expected ${P2A_ENTITY_COUNT} entities, got ${selected.length}`);
  }
  const codes = new Set(selected.map((row) => row[0]));
  if (codes.size !== selected.length) throw new Error("duplicate entity code in table");

  /* ---- country-registry ---------------------------------------- */
  const registry: CountryRegionRecord[] = selected.map(([code, name, region]) => ({
    entityId: `cr:${code}`,
    iso3: code,
    regionCode: code,
    displayNameZhHans: SENSITIVE.has(code) ? null : name,
    sensitiveNameRef: SENSITIVE.has(code) ? `sn:${code}` : null,
    region,
    status: "enabled",
    dataVersion: DATA_VERSION
  }));

  /* ---- indicators ---------------------------------------------- */
  const indicators: IndicatorRecord[] = [];
  for (const row of selected) {
    const code = row[0];
    indicators.push({
      indicatorId: "birth_share_weight",
      entityId: `cr:${code}`,
      year: INDICATOR_YEAR,
      sex: "total",
      unit: "relative_weight",
      value: 1 + (u32(`share:${code}`) % 65535),
      sourceId: "SYNTH-P2A-INDICATORS",
      dataVersion: DATA_VERSION
    });
    indicators.push({
      indicatorId: "underweight_rate_ppm",
      entityId: `cr:${code}`,
      year: INDICATOR_YEAR,
      sex: "total",
      unit: "rate_ppm",
      value: 5000 + (u32(`underweight:${code}`) % 75001),
      sourceId: "SYNTH-P2A-INDICATORS",
      dataVersion: DATA_VERSION
    });
  }

  /* ---- birth-weights ------------------------------------------- */
  const edges = [
    { bandId: "lt_2500", minGrams: 1200, maxGrams: 2499 },
    { bandId: "2500_2999", minGrams: 2500, maxGrams: 2999 },
    { bandId: "3000_3499", minGrams: 3000, maxGrams: 3499 },
    { bandId: "3500_3999", minGrams: 3500, maxGrams: 3999 },
    { bandId: "ge_4000", minGrams: 4000, maxGrams: 4499 }
  ] as const;
  const birthWeights: BirthWeightRecord[] = [];
  for (const row of selected) {
    const code = row[0];
    for (const sex of ["female", "male"] as const) {
      const ppm = bandWeights(code, sex);
      const bands: BirthWeightBand[] = edges.map((edge, index) => ({
        bandId: edge.bandId,
        minGrams: edge.minGrams,
        maxGrams: edge.maxGrams,
        weightPpm: ppm[index] as number
      }));
      birthWeights.push({
        entityId: `cr:${code}`,
        sex,
        year: INDICATOR_YEAR,
        meanGrams: 3000 + (u32(`mean:${code}:${sex}`) % 600),
        sdGrams: 300 + (u32(`sd:${code}:${sex}`) % 200),
        bands,
        sourceId: "SYNTH-P2A-BIRTH-WEIGHTS",
        dataVersion: DATA_VERSION
      });
    }
  }

  writeDataset("country-registry.v1.json", "country-registry", registry);
  writeDataset("indicators.v1.json", "indicators", indicators);
  writeDataset("birth-weights.v1.json", "birth-weights", birthWeights);
  /* sensitive-names.v1.json 由人工維護（可審核映射表），產生器不改寫。 */
  const sensitive = JSON.parse(readFileSync(join(OUT, "sensitive-names.v1.json"), "utf8")) as DatasetEnvelope<SensitiveNameRecord>;
  if (sensitive.records.length !== SENSITIVE.size) throw new Error("sensitive-names.v1.json must have exactly 3 records");

  const checksums = {
    "country-registry": checksumOf("country-registry.v1.json"),
    indicators: checksumOf("indicators.v1.json"),
    "birth-weights": checksumOf("birth-weights.v1.json"),
    "sensitive-names": checksumOf("sensitive-names.v1.json")
  } as Record<string, string>;

  /* ---- licenses ------------------------------------------------ */
  const licenseFor = (sourceId: string, datasetId: DatasetId, label: string): LicenseRecord => ({
    sourceId,
    datasetId,
    datasetLabel: label,
    sourceKind: "synthetic",
    sourceName: "P2-A 合成測試資料（非官方統計）",
    sourceUrl: null,
    version: "1.0.0",
    retrievedAt: CREATED_AT,
    license: "granted",
    licenseId: "SYNTHETIC-TEST-ONLY-1.0",
    commercialUse: "allowed",
    legalStatus: "cleared",
    evidence: ["docs/p2a/license-registry.md#synthetic-test-data"],
    grant: null,
    checksum: checksums[datasetId],
    lineageId: `lin:${datasetId}`,
    notes: "合成資料，不是 WHO、World Happiness Report 或任何官方統計；只用於契約與抽選測試。"
  });
  const licenses: LicenseRecord[] = [
    licenseFor("SYNTH-P2A-REGISTRY", "country-registry", "P2-A 國家與地區 registry（合成）"),
    licenseFor("SYNTH-P2A-INDICATORS", "indicators", "P2-A 指標（合成）"),
    licenseFor("SYNTH-P2A-BIRTH-WEIGHTS", "birth-weights", "P2-A 出生體重分布（合成）"),
    licenseFor("SYNTH-P2A-SENSITIVE-NAMES", "sensitive-names", "P2-A 敏感名稱映射（人工維護）")
  ];
  writeDataset("licenses.v1.json", "licenses", licenses);

  /* ---- lineage ------------------------------------------------- */
  const lineageFor = (datasetId: DatasetId, transform: string): LineageRecord => ({
    lineageId: `lin:${datasetId}`,
    datasetId,
    parentLineageIds: [],
    transform,
    generatedBy: datasetId === "sensitive-names" ? "docs/p2a/country-registry.md (manual mapping)" : "scripts/p2a-generate-fixtures.ts",
    generatedAt: CREATED_AT,
    inputChecksums: [],
    outputChecksum: checksums[datasetId],
    notes: "資料血緣：本批沒有任何上游統計檔案，全部由合成產生器或人工映射表產生。"
  });
  const lineage: LineageRecord[] = [
    lineageFor("country-registry", "synthetic-table-selection"),
    lineageFor("indicators", "synthetic-hash-derivation"),
    lineageFor("birth-weights", "synthetic-hash-derivation"),
    lineageFor("sensitive-names", "manual-reviewable-mapping")
  ];
  writeDataset("lineage.v1.json", "lineage", lineage);

  /* ---- manifest ------------------------------------------------ */
  const entries: Array<{ datasetId: DatasetId; fileName: string; records: readonly unknown[] }> = [
    { datasetId: "country-registry", fileName: "country-registry.v1.json", records: registry },
    { datasetId: "indicators", fileName: "indicators.v1.json", records: indicators },
    { datasetId: "birth-weights", fileName: "birth-weights.v1.json", records: birthWeights },
    { datasetId: "sensitive-names", fileName: "sensitive-names.v1.json", records: sensitive.records },
    { datasetId: "licenses", fileName: "licenses.v1.json", records: licenses },
    { datasetId: "lineage", fileName: "lineage.v1.json", records: lineage }
  ];
  const datasets: DatasetDescriptor[] = entries.map((entry) => ({
    datasetId: entry.datasetId,
    fileName: entry.fileName,
    recordCount: entry.records.length,
    checksum: checksumOf(entry.fileName)
  }));
  if (datasets.length !== P2A_DATASET_IDS.length) throw new Error("dataset descriptor count");

  const manifestBase: DataPackManifest = {
    schemaVersion: SCHEMA,
    dataVersion: DATA_VERSION,
    packId: PACK_ID,
    packKind: "synthetic",
    createdAt: CREATED_AT,
    engineVersion: ENGINE_VERSION,
    rngSpecVersion: RNG_SPEC_VERSION,
    entityCount: registry.length,
    indicatorYear: INDICATOR_YEAR,
    indicatorIds: ["birth_share_weight", "underweight_rate_ppm"],
    licenseSourceIds: licenses.map((license) => license.sourceId),
    datasets,
    packChecksum: "0".repeat(64)
  };
  const manifest: DataPackManifest = { ...manifestBase, packChecksum: computePackChecksum(manifestBase) };
  writeFileSync(join(OUT, "manifest.v1.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  /* ---- self-check：用正式驗證器驗一次自己產生的包 ---------------- */
  const raw = {
    manifest: JSON.parse(readFileSync(join(OUT, "manifest.v1.json"), "utf8")),
    datasets: {
      "country-registry": readDataset("country-registry.v1.json"),
      indicators: readDataset("indicators.v1.json"),
      "birth-weights": readDataset("birth-weights.v1.json"),
      "sensitive-names": readDataset("sensitive-names.v1.json"),
      licenses: readDataset("licenses.v1.json"),
      lineage: readDataset("lineage.v1.json")
    }
  };
  const validated = validateDataPack(raw);
  console.log(
    `P2A-FIXTURES-OK entities=${validated.registry.length} indicators=${validated.indicators.length} birthWeights=${validated.birthWeights.length} licenses=${validated.licenses.length} lineage=${validated.lineage.length} packChecksum=${validated.packChecksum.slice(0, 16)}…`
  );
}

main();
