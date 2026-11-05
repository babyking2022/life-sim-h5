/**
 * P2-B identity fixture 產生器（確定性、合成資料）。
 *
 * 用法：pnpm p2b:fixtures
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CountryVitalRecord,
  DatasetEnvelope,
  HouseholdProfileRecord,
  IdentityPackManifest,
  LicenseRecord,
  LineageRecord,
  NameRecord,
  StoryTemplateRecord
} from "@life-sim/contracts";
import { P2B_ALL_DATASET_IDS, P2B_SCHEMA_VERSION, P2B_WEIGHT_PPM_TOTAL } from "@life-sim/contracts";
import {
  computeIdentityDatasetChecksum,
  computeIdentityPackChecksum,
  validateIdentityPack
} from "../packages/birth/src/identity/validate";
import { validateDataPack } from "../packages/birth/src/validate";

const ROOT = process.cwd();
const BASE_DIR = join(ROOT, "fixtures", "p2a");
const OUT = join(ROOT, "fixtures", "p2b");
const DATA_VERSION = "1.0.0";
const CREATED_AT = "2026-10-27";
const PACK_ID = "p2b-synthetic-20261027";
const ENGINE_VERSION = "0.1.0";
const RNG_SPEC_VERSION = "1.0.0";

type ReligionRow = readonly [id: string, label: string, weightPpm: number];

interface CultureRow {
  readonly id: string;
  readonly script: "han" | "latin" | "cyrillic" | "arabic" | "devanagari" | "kana" | "hangul";
  readonly order: "family_first" | "given_first";
  readonly entities: readonly string[];
  readonly urban: number;
  readonly life: number;
  readonly u5: number;
  readonly gdp: number;
  readonly income: readonly number[];
  readonly ages: readonly [number, number, number, number];
  readonly religions: readonly ReligionRow[];
}

const RELIGION_NONE: ReligionRow = ["none", "无宗教", 520000];
const RELIGION_BUDDHISM: ReligionRow = ["buddhism", "佛教", 180000];
const RELIGION_CHRISTIAN: ReligionRow = ["christianity", "基督教", 60000];
const RELIGION_FOLK: ReligionRow = ["folk", "民间信仰", 240000];
const RELIGION_HINDU: ReligionRow = ["hinduism", "印度教", 620000];
const RELIGION_ISLAM: ReligionRow = ["islam", "伊斯兰教", 300000];

const CULTURES: readonly CultureRow[] = [
  {
    id: "han",
    script: "han",
    order: "family_first",
    entities: ["CHN", "HKG", "MAC", "TWN"],
    urban: 620000,
    life: 780,
    u5: 60,
    gdp: 22000,
    income: [80000, 140000, 220000, 260000, 300000],
    ages: [24, 38, 26, 42],
    religions: [RELIGION_NONE, RELIGION_BUDDHISM, RELIGION_CHRISTIAN, RELIGION_FOLK]
  },
  {
    id: "ja",
    script: "kana",
    order: "family_first",
    entities: ["JPN"],
    urban: 920000,
    life: 845,
    u5: 25,
    gdp: 42000,
    income: [60000, 120000, 200000, 280000, 340000],
    ages: [27, 40, 29, 44],
    religions: [RELIGION_NONE, RELIGION_BUDDHISM, RELIGION_FOLK, RELIGION_CHRISTIAN]
  },
  {
    id: "ko",
    script: "hangul",
    order: "family_first",
    entities: ["PRK", "KOR"],
    urban: 810000,
    life: 835,
    u5: 30,
    gdp: 44000,
    income: [70000, 130000, 210000, 270000, 320000],
    ages: [27, 40, 29, 44],
    religions: [RELIGION_NONE, RELIGION_CHRISTIAN, RELIGION_BUDDHISM, RELIGION_FOLK]
  },
  {
    id: "south_asia",
    script: "devanagari",
    order: "given_first",
    entities: ["IND", "PAK", "BGD", "LKA", "NPL"],
    urban: 350000,
    life: 700,
    u5: 320,
    gdp: 8000,
    income: [140000, 200000, 240000, 220000, 200000],
    ages: [21, 34, 24, 39],
    religions: [RELIGION_HINDU, RELIGION_ISLAM, RELIGION_NONE, RELIGION_CHRISTIAN]
  },
  {
    id: "southeast_asia",
    script: "latin",
    order: "given_first",
    entities: ["IDN", "MYS", "PHL", "THA", "VNM", "KHM", "LAO", "MMR", "BRN", "TLS", "SGP"],
    urban: 480000,
    life: 730,
    u5: 200,
    gdp: 13000,
    income: [120000, 190000, 250000, 230000, 210000],
    ages: [22, 35, 25, 40],
    religions: [RELIGION_ISLAM, RELIGION_BUDDHISM, RELIGION_CHRISTIAN, RELIGION_NONE]
  },
  {
    id: "central_asia",
    script: "cyrillic",
    order: "given_first",
    entities: ["KAZ", "KGZ", "TJK", "TKM", "UZB", "AZE", "ARM", "GEO", "MNG", "AFG"],
    urban: 570000,
    life: 730,
    u5: 180,
    gdp: 15000,
    income: [130000, 200000, 250000, 220000, 200000],
    ages: [22, 36, 25, 41],
    religions: [RELIGION_ISLAM, RELIGION_CHRISTIAN, RELIGION_NONE, RELIGION_BUDDHISM]
  },
  {
    id: "middle_east",
    script: "arabic",
    order: "given_first",
    entities: ["IRN", "IRQ", "ISR", "JOR", "KWT", "LBN", "OMN", "QAT", "SAU", "SYR", "ARE", "YEM", "TUR", "PSE", "BHR", "CYP"],
    urban: 730000,
    life: 760,
    u5: 140,
    gdp: 25000,
    income: [110000, 180000, 240000, 250000, 220000],
    ages: [22, 36, 25, 42],
    religions: [RELIGION_ISLAM, RELIGION_CHRISTIAN, RELIGION_NONE, RELIGION_FOLK]
  },
  {
    id: "africa",
    script: "latin",
    order: "given_first",
    entities: [
      "DZA", "AGO", "BEN", "BWA", "BFA", "BDI", "CPV", "CMR", "CAF", "TCD", "COG", "COD", "CIV", "DJI", "EGY", "GNQ",
      "ERI", "SWZ", "ETH", "GAB", "GMB", "GHA", "GIN", "GNB", "KEN", "LSO", "LBR", "LBY", "MDG", "MWI", "MLI", "MRT",
      "MUS", "MAR", "MOZ", "NAM", "NER", "NGA", "RWA", "SEN", "SLE", "SOM", "ZAF", "SSD", "SDN", "TZA", "TGO", "TUN",
      "UGA", "ZMB", "ZWE"
    ],
    urban: 420000,
    life: 640,
    u5: 520,
    gdp: 5000,
    income: [200000, 240000, 240000, 190000, 130000],
    ages: [20, 34, 23, 40],
    religions: [RELIGION_CHRISTIAN, RELIGION_ISLAM, RELIGION_NONE, RELIGION_FOLK]
  },
  {
    id: "europe_west",
    script: "latin",
    order: "given_first",
    entities: ["AUT", "BEL", "CHE", "DEU", "DNK", "ESP", "FIN", "FRA", "GBR", "GRC", "IRL", "ISL", "ITA", "LUX", "MLT", "NLD", "NOR", "PRT", "SWE"],
    urban: 800000,
    life: 820,
    u5: 40,
    gdp: 48000,
    income: [60000, 120000, 200000, 280000, 340000],
    ages: [27, 41, 29, 45],
    religions: [RELIGION_NONE, RELIGION_CHRISTIAN, RELIGION_ISLAM, RELIGION_BUDDHISM]
  },
  {
    id: "europe_east",
    script: "cyrillic",
    order: "given_first",
    entities: ["ALB", "BIH", "BGR", "BLR", "CZE", "EST", "HRV", "HUN", "LTU", "LVA", "MDA", "MKD", "MNE", "POL", "ROU", "RUS", "SRB", "SVK", "SVN", "UKR"],
    urban: 680000,
    life: 750,
    u5: 70,
    gdp: 24000,
    income: [90000, 150000, 230000, 270000, 260000],
    ages: [25, 39, 27, 43],
    religions: [RELIGION_NONE, RELIGION_CHRISTIAN, RELIGION_ISLAM, RELIGION_FOLK]
  },
  {
    id: "latin_america",
    script: "latin",
    order: "given_first",
    entities: ["ARG", "BOL", "BRA", "CHL", "COL", "CRI", "CUB", "DOM", "ECU", "SLV", "GTM", "GUY", "HTI", "HND", "MEX", "NIC", "PAN", "PRY", "PER", "SUR", "URY", "VEN"],
    urban: 780000,
    life: 760,
    u5: 120,
    gdp: 16000,
    income: [100000, 170000, 250000, 260000, 220000],
    ages: [22, 36, 24, 41],
    religions: [RELIGION_CHRISTIAN, RELIGION_NONE, RELIGION_FOLK, RELIGION_BUDDHISM]
  },
  {
    id: "anglo",
    script: "latin",
    order: "given_first",
    entities: ["USA", "CAN", "AUS", "NZL", "JAM"],
    urban: 830000,
    life: 790,
    u5: 60,
    gdp: 52000,
    income: [60000, 120000, 200000, 280000, 340000],
    ages: [26, 40, 28, 44],
    religions: [RELIGION_CHRISTIAN, RELIGION_NONE, RELIGION_ISLAM, RELIGION_BUDDHISM]
  },
  {
    id: "pacific",
    script: "latin",
    order: "given_first",
    entities: ["FJI", "PNG", "WSM", "SLB", "TON", "VUT"],
    urban: 550000,
    life: 720,
    u5: 200,
    gdp: 9000,
    income: [150000, 220000, 260000, 210000, 160000],
    ages: [21, 35, 24, 41],
    religions: [RELIGION_CHRISTIAN, RELIGION_NONE, RELIGION_FOLK, RELIGION_ISLAM]
  }
];

const JOBS = [
  { id: "farmer", label: "农民", weightPpm: 250000 },
  { id: "factory", label: "工厂工人", weightPpm: 200000 },
  { id: "service", label: "服务业员工", weightPpm: 250000 },
  { id: "teacher", label: "教师", weightPpm: 150000 },
  { id: "shopkeeper", label: "店主", weightPpm: 150000 }
] as const;

const HOUSING = [
  { housingId: "owned" as const, weightPpm: 400000 },
  { housingId: "rented" as const, weightPpm: 350000 },
  { housingId: "shared" as const, weightPpm: 200000 },
  { housingId: "informal" as const, weightPpm: 50000 }
] as const;

const NAMES: Readonly<Record<string, { surname: string[]; female: string[]; male: string[] }>> = {
  han: {
    surname: ["林", "陈", "周", "吴", "沈", "许"],
    female: ["安宁", "嘉岚", "清雨", "若溪", "思彤", "婉宁"],
    male: ["知远", "舟和", "晨川", "子墨", "承宇", "亦辰"]
  },
  ja: {
    surname: ["佐藤", "铃木", "高桥", "田中", "渡边", "伊藤"],
    female: ["美咲", "结衣", "阳菜", "葵", "凛", "千夏"],
    male: ["翔太", "大和", "悠真", "莲", "凑", "阳斗"]
  },
  ko: {
    surname: ["金", "李", "朴", "崔", "郑", "姜"],
    female: ["智秀", "敏书", "允儿", "秀雅", "河英", "彩元"],
    male: ["民俊", "志勋", "成民", "东贤", "准浩", "泰阳"]
  },
  south_asia: {
    surname: ["夏尔马", "帕特尔", "辛格", "拉奥", "古普塔", "奈尔"],
    female: ["阿莎", "普里亚", "米拉", "卡薇", "妮莎", "拉迪"],
    male: ["阿尔琼", "拉维", "维克拉姆", "桑杰", "尼基尔", "阿米尔"]
  },
  southeast_asia: {
    surname: ["阮", "陈", "桑托斯", "苏里亚", "占", "披耶"],
    female: ["兰", "美玲", "阿雅", "素帕", "玛雅", "丽娜"],
    male: ["明", "阿迪", "苏帕", "拉曼", "提姆", "万"]
  },
  central_asia: {
    surname: ["卡里莫夫", "阿利耶夫", "努尔兰", "托卡耶夫", "阿卜杜拉", "伊斯拉莫夫"],
    female: ["阿依古丽", "古丽娜", "迪娜", "扎丽娜", "阿米娜", "萨比娜"],
    male: ["阿尔曼", "达尼亚尔", "铁木尔", "伊斯拉姆", "鲁斯兰", "阿扎特"]
  },
  middle_east: {
    surname: ["哈桑", "阿卜杜拉", "卡里姆", "纳赛尔", "萨利姆", "法尔西"],
    female: ["莱拉", "阿米拉", "萨拉", "努尔", "哈娜", "玛丽亚姆"],
    male: ["奥马尔", "阿里", "哈立德", "优素福", "赛义德", "拉希德"]
  },
  africa: {
    surname: ["奥卡福", "门萨", "阿德巴约", "恩达耶", "卡马拉", "莫约"],
    female: ["阿玛拉", "齐娜", "法蒂玛", "娜拉", "伊丽莎", "阿依莎"],
    male: ["科菲", "埃梅卡", "图雷", "贾马尔", "奥比", "塞库"]
  },
  europe_west: {
    surname: ["穆勒", "施密特", "杜邦", "罗西", "加西亚", "约翰逊"],
    female: ["安娜", "艾玛", "索菲亚", "克拉拉", "朱莉娅", "艾琳娜"],
    male: ["卢卡斯", "马可", "托马斯", "保罗", "丹尼尔", "雨果"]
  },
  europe_east: {
    surname: ["伊万诺夫", "彼得罗夫", "科瓦尔", "诺瓦克", "扬科维奇", "迪米特洛夫"],
    female: ["安娜", "卡佳", "娜塔莎", "奥尔加", "伊琳娜", "玛尔塔"],
    male: ["伊万", "彼得", "米哈伊", "谢尔盖", "安德烈", "卢卡"]
  },
  latin_america: {
    surname: ["席尔瓦", "罗德里格斯", "费尔南德斯", "卡斯特罗", "莫拉莱斯", "佩雷拉"],
    female: ["索菲亚", "瓦伦蒂娜", "卡米拉", "露西亚", "伊莎贝拉", "玛蒂娜"],
    male: ["马特奥", "圣地亚哥", "迭戈", "安德烈斯", "华金", "托马斯"]
  },
  anglo: {
    surname: ["史密斯", "约翰逊", "威廉姆斯", "布朗", "泰勒", "威尔逊"],
    female: ["艾米丽", "奥利维亚", "夏洛特", "格蕾丝", "汉娜", "艾娃"],
    male: ["詹姆斯", "奥利弗", "威廉", "亨利", "杰克", "诺亚"]
  },
  pacific: {
    surname: ["陶法", "劳卡", "马塔", "卡瓦", "图伊", "纳伊"],
    female: ["莉娅", "玛丽", "塞拉", "阿娜", "洛塔", "菲娅"],
    male: ["特奥", "卡莱", "马努", "塔诺", "维拉", "洛亚"]
  }
};

const STORY_TEMPLATES = [
  {
    suffix: "a",
    paragraphs: [
      "{name}在{place}出生。家里属于{income}，父亲是{fatherJob}，母亲是{motherJob}。",
      "家人按{religion}的习惯迎接这个孩子，也记住了这一天的天气。",
      "没有人知道以后会发生什么，但{country}的这一年，从这里开始。"
    ]
  },
  {
    suffix: "b",
    paragraphs: [
      "这一年，{country}的一个{place}家庭多了一个孩子：{name}。",
      "母亲{motherJob}、父亲{fatherJob}，一家人在{income}的日子里慢慢安顿下来。",
      "家里保留着{religion}的传统，也保留着对未来的小心愿。"
    ]
  }
] as const;

function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function u32(text: string): number {
  return digest(text).readUInt32BE(0);
}

function readBase() {
  const read = (file: string) => JSON.parse(readFileSync(join(BASE_DIR, file), "utf8")) as DatasetEnvelope<unknown>;
  return {
    manifest: JSON.parse(readFileSync(join(BASE_DIR, "manifest.v1.json"), "utf8")),
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

function writeDataset(file: string, dataset: string, records: readonly object[]): void {
  const head = `{\n  "schemaVersion": ${JSON.stringify(P2B_SCHEMA_VERSION)},\n  "dataVersion": ${JSON.stringify(DATA_VERSION)},\n  "dataset": ${JSON.stringify(dataset)},\n  "records": [\n`;
  const body = records.map((record) => `    ${JSON.stringify(record)}`).join(",\n");
  writeFileSync(join(OUT, file), `${head}${body}\n  ]\n}\n`, "utf8");
}

function readDataset(file: string) {
  return JSON.parse(readFileSync(join(OUT, file), "utf8"));
}

function checksumOf(file: string): string {
  return computeIdentityDatasetChecksum(readDataset(file));
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const base = validateDataPack(readBase());

  const entityToCulture = new Map<string, string>();
  for (const culture of CULTURES) {
    for (const code of culture.entities) {
      if (entityToCulture.has(code)) throw new Error(`duplicate culture assignment ${code}`);
      entityToCulture.set(code, culture.id);
    }
  }
  if (entityToCulture.size !== 172) throw new Error(`expected 172 culture assignments, got ${entityToCulture.size}`);
  for (const entityId of base.entityIds) {
    const code = entityId.slice(3);
    if (!entityToCulture.has(code)) throw new Error(`entity without culture: ${code}`);
  }

  const cultureById = new Map(CULTURES.map((culture) => [culture.id, culture]));

  /* --- country-vitals -------------------------------------------------- */
  const vitals: CountryVitalRecord[] = base.registry.map((entity) => {
    const code = entity.entityId.slice(3);
    const culture = cultureById.get(entityToCulture.get(code) as string) as CultureRow;
    const life = culture.life + (u32(`life:${code}`) % 21) - 10;
    const u5 = Math.max(5, culture.u5 + (u32(`u5:${code}`) % 41) - 20);
    const gdp = Math.round((culture.gdp * (90 + (u32(`gdp:${code}`) % 21))) / 100);
    return {
      entityId: entity.entityId,
      cultureId: culture.id,
      lifeExpectancyYearsX10: life,
      under5MortalityPer1000X10: u5,
      gdpPerCapitaPppUsd: gdp,
      dataVersion: DATA_VERSION
    };
  });

  /* --- household-profiles ---------------------------------------------- */
  const normalizePpm = (values: readonly number[]): number[] => {
    const total = values.reduce((sum, value) => sum + value, 0);
    const scaled = values.map((value) => Math.floor((value * P2B_WEIGHT_PPM_TOTAL) / total));
    let remainder = P2B_WEIGHT_PPM_TOTAL - scaled.reduce((sum, value) => sum + value, 0);
    let cursor = 0;
    while (remainder > 0) {
      const index = cursor % scaled.length;
      scaled[index] = (scaled[index] as number) + 1;
      remainder -= 1;
      cursor += 1;
    }
    return scaled;
  };
  const jobWeights = normalizePpm(JOBS.map((job) => job.weightPpm));
  const housingWeights = normalizePpm(HOUSING.map((house) => house.weightPpm));
  const profiles: HouseholdProfileRecord[] = CULTURES.map((culture) => {
    const religionWeights = normalizePpm(culture.religions.map((row) => row[2]));
    return {
      cultureId: culture.id,
      script: culture.script,
      surnameOrder: culture.order,
      urbanSharePpm: culture.urban,
      incomeQuintilePpm: culture.income,
      motherAgeMin: culture.ages[0],
      motherAgeMax: culture.ages[1],
      fatherAgeMin: culture.ages[2],
      fatherAgeMax: culture.ages[3],
      occupations: JOBS.map((job, index) => ({ occupationId: job.id, label: job.label, weightPpm: jobWeights[index] as number })),
      housing: HOUSING.map((house, index) => ({ housingId: house.housingId, weightPpm: housingWeights[index] as number })),
      religions: culture.religions.map(([religionId, label], index) => ({ religionId, label, weightPpm: religionWeights[index] as number })),
      dataVersion: DATA_VERSION
    };
  });

  /* --- name-corpus ------------------------------------------------------ */
  const names: NameRecord[] = [];
  for (const culture of CULTURES) {
    const pool = NAMES[culture.id];
    if (!pool) throw new Error(`missing names for ${culture.id}`);
    for (const value of pool.surname) names.push({ cultureId: culture.id, kind: "surname", sex: "total", value, dataVersion: DATA_VERSION });
    for (const value of pool.female) names.push({ cultureId: culture.id, kind: "given", sex: "female", value, dataVersion: DATA_VERSION });
    for (const value of pool.male) names.push({ cultureId: culture.id, kind: "given", sex: "male", value, dataVersion: DATA_VERSION });
  }

  /* --- story-templates -------------------------------------------------- */
  const stories: StoryTemplateRecord[] = [];
  for (const culture of CULTURES) {
    for (const template of STORY_TEMPLATES) {
      stories.push({
        templateId: `${culture.id}_${template.suffix}`,
        cultureId: culture.id,
        paragraphs: [...template.paragraphs],
        dataVersion: DATA_VERSION
      });
    }
  }

  writeDataset("country-vitals.v1.json", "country-vitals", vitals);
  writeDataset("household-profiles.v1.json", "household-profiles", profiles);
  writeDataset("name-corpus.v1.json", "name-corpus", names);
  writeDataset("story-templates.v1.json", "story-templates", stories);

  const checksums = {
    "country-vitals": checksumOf("country-vitals.v1.json"),
    "household-profiles": checksumOf("household-profiles.v1.json"),
    "name-corpus": checksumOf("name-corpus.v1.json"),
    "story-templates": checksumOf("story-templates.v1.json")
  } as Record<string, string>;

  /* --- licenses --------------------------------------------------------- */
  const licenseFor = (sourceId: string, datasetId: string, label: string): LicenseRecord => ({
    sourceId,
    datasetId,
    datasetLabel: label,
    sourceKind: "synthetic",
    sourceName: "P2-B 合成出生身分資料（非官方統計）",
    sourceUrl: null,
    version: "1.0.0",
    retrievedAt: CREATED_AT,
    license: "granted",
    licenseId: "SYNTHETIC-TEST-ONLY-2.0",
    commercialUse: "allowed",
    legalStatus: "cleared",
    evidence: ["docs/p2b/data-contract.md#synthetic-test-data"],
    grant: null,
    checksum: checksums[datasetId] as string,
    lineageId: `lin:${datasetId}`,
    notes: "合成資料，不是官方人口統計、姓名庫或宗教資料；只用於 P2-B 契約與抽選測試。"
  });
  const licenses: LicenseRecord[] = [
    licenseFor("SYNTH-P2B-VITALS", "country-vitals", "P2-B 國家生命表徵（合成）"),
    licenseFor("SYNTH-P2B-HOUSEHOLDS", "household-profiles", "P2-B 家庭分布（合成）"),
    licenseFor("SYNTH-P2B-NAMES", "name-corpus", "P2-B 姓名語料（合成）"),
    licenseFor("SYNTH-P2B-STORIES", "story-templates", "P2-B 出生故事模板（合成）")
  ];
  writeDataset("licenses.v1.json", "licenses", licenses);

  /* --- lineage ---------------------------------------------------------- */
  const lineageFor = (datasetId: string, transform: string): LineageRecord => ({
    lineageId: `lin:${datasetId}`,
    datasetId,
    parentLineageIds: [],
    transform,
    generatedBy: "scripts/p2b-generate-fixtures.ts",
    generatedAt: CREATED_AT,
    inputChecksums: [],
    outputChecksum: checksums[datasetId] as string,
    notes: "P2-B 資料血緣：全部由合成產生器推導，沒有上游統計檔案。"
  });
  const lineage: LineageRecord[] = [
    lineageFor("country-vitals", "synthetic-culture-baseline"),
    lineageFor("household-profiles", "synthetic-culture-baseline"),
    lineageFor("name-corpus", "synthetic-name-table"),
    lineageFor("story-templates", "synthetic-template-table")
  ];
  writeDataset("lineage.v1.json", "lineage", lineage);

  /* --- manifest --------------------------------------------------------- */
  const entries = [
    { datasetId: "country-vitals" as const, fileName: "country-vitals.v1.json", records: vitals },
    { datasetId: "household-profiles" as const, fileName: "household-profiles.v1.json", records: profiles },
    { datasetId: "name-corpus" as const, fileName: "name-corpus.v1.json", records: names },
    { datasetId: "story-templates" as const, fileName: "story-templates.v1.json", records: stories },
    { datasetId: "licenses" as const, fileName: "licenses.v1.json", records: licenses },
    { datasetId: "lineage" as const, fileName: "lineage.v1.json", records: lineage }
  ];
  const datasets = entries.map((entry) => ({
    datasetId: entry.datasetId,
    fileName: entry.fileName,
    recordCount: entry.records.length,
    checksum: checksumOf(entry.fileName)
  }));
  if (datasets.length !== P2B_ALL_DATASET_IDS.length) throw new Error("descriptor count");

  const manifestBase: IdentityPackManifest = {
    schemaVersion: P2B_SCHEMA_VERSION,
    dataVersion: DATA_VERSION,
    packId: PACK_ID,
    packKind: "synthetic",
    createdAt: CREATED_AT,
    engineVersion: ENGINE_VERSION,
    rngSpecVersion: RNG_SPEC_VERSION,
    basePackId: base.manifest.packId,
    basePackChecksum: base.packChecksum,
    baseDataVersion: base.manifest.dataVersion,
    entityCount: vitals.length,
    licenseSourceIds: licenses.map((license) => license.sourceId),
    datasets,
    packChecksum: "0".repeat(64)
  };
  const manifest: IdentityPackManifest = { ...manifestBase, packChecksum: computeIdentityPackChecksum(manifestBase) };
  writeFileSync(join(OUT, "manifest.v1.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  /* --- self check -------------------------------------------------------- */
  const raw = {
    manifest: JSON.parse(readFileSync(join(OUT, "manifest.v1.json"), "utf8")),
    datasets: {
      "country-vitals": readDataset("country-vitals.v1.json"),
      "household-profiles": readDataset("household-profiles.v1.json"),
      "name-corpus": readDataset("name-corpus.v1.json"),
      "story-templates": readDataset("story-templates.v1.json"),
      licenses: readDataset("licenses.v1.json"),
      lineage: readDataset("lineage.v1.json")
    }
  };
  const identity = validateIdentityPack(base, raw as never);
  console.log(
    `P2B-FIXTURES-OK vitals=${identity.vitals.length} profiles=${identity.profiles.length} names=${identity.names.length} stories=${identity.stories.length} licenses=${identity.licenses.length} lineage=${identity.lineage.length} baseChecksum=${base.packChecksum.slice(0, 12)}… packChecksum=${identity.packChecksum.slice(0, 12)}…`
  );
}

main();
