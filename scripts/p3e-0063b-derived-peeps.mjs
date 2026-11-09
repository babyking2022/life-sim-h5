/**
 * GPT-WORKBUDDY-0063-B｜年齡專用衍生全身人物資產產生器。
 *
 * 官方 Open Peeps（CC0 1.0）集合只有成人 Standing 成品，沒有嬰兒／幼童／
 * 學生。0062-B 把成人縮小給 0 歲用，CTO 判定不合格。本腳本依 CC0 允許的
 * 「modify / remix / derivative」建立**本專案原創衍生**的輕量全身 SVG，
 * 沿用 Open Peeps 的手繪黑白線描筆觸（圓頭黑線、白／色塊填充、圓潤關節），
 * 但**明確標示為衍生，不假稱官方原件**。
 *
 * 產出：
 *   assets/generated/open-peeps/derived/<stage>-<series>.svg   20 個可預覽 SVG
 *   assets/generated/open-peeps/derived/DERIVED-SOURCE.md      來源／衍生清單
 *   packages/ui/src/p3e-open-peeps-derived.ts                  runtime 常數模組
 *   .artifacts/p3e-0063b-derived-assets.json                  大小報告
 *   assets/generated/open-peeps/SOURCE.md                     幂等附加衍生段落
 *
 * 執行：node scripts/p3e-0063b-derived-peeps.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const assetDir = join(root, "assets/generated/open-peeps");
const derivedDir = join(assetDir, "derived");
const outTs = join(root, "packages/ui/src/p3e-open-peeps-derived.ts");
const sourcePath = join(assetDir, "SOURCE.md");
const reportPath = join(root, ".artifacts/p3e-0063b-derived-assets.json");
const RETRIEVED = "2026-11-09";

mkdirSync(derivedDir, { recursive: true });

/** 固定調色盤：寫入 .svg 時用真實色，產生 TS 時換成 {{slot}} 由 identity 注入。 */
const C = Object.freeze({
  ink: "#3f332b",
  skin: "#f6d3b0",
  clothes: "#6d9bb5",
  hair: "#3a2a20",
  blush: "#e98f9b",
  light: "#fffdf0",
  sole: "#8a6a44"
});

/**
 * 五個年齡專用階段。viewBox 緊貼人物，讓 personLayer 的 height 就是真實
 * 人物高度；嬰兒 viewBox 寬高比最大 → 頭身比一眼就是嬰幼兒。
 */
const STAGES = Object.freeze([
  { id: "baby", w: 150, h: 170, ground: 160, headR: 44, headCy: 52, garment: "onesie", pose: "sitting", body: "onesie", label: "嬰兒 0–2｜坐姿連身衣" },
  { id: "child", w: 150, h: 210, ground: 204, headR: 36, headCy: 44, garment: "toddler", pose: "toddler-stand", body: "toddler", label: "幼童 3–5｜短上衣童裝" },
  { id: "primary", w: 130, h: 240, ground: 234, headR: 29, headCy: 36, garment: "school", pose: "school-stand", body: "school", label: "小學生 6–11｜校服＋書包" },
  { id: "teen", w: 120, h: 260, ground: 254, headR: 25, headCy: 31, garment: "teen", pose: "teen-stand", body: "teen", label: "青少年 12–17｜連帽衫＋斜挎包" },
  { id: "university", w: 118, h: 270, ground: 264, headR: 23, headCy: 29, garment: "campus", pose: "campus-stand", body: "campus", label: "大學生 18–22｜開襟外套＋背包" }
]);

/** 4 個 identity series：跨年齡維持同一髮型，男女都不綁死單一服裝。 */
const SERIES = Object.freeze([
  { id: "a", hair: "short", hairLabel: "短髮", garmentLabel: "圓領＋胸前口袋" },
  { id: "b", hair: "bunches", hairLabel: "雙髮髻", garmentLabel: "背帶／吊帶＋扣子" },
  { id: "c", hair: "curly", hairLabel: "捲髮", garmentLabel: "橫條紋上衣" },
  { id: "d", hair: "side-part", hairLabel: "斜劉海", garmentLabel: "襯衫領＋門襟" }
]);

const n = (value) => Number(value.toFixed(1));

function hairMarkup(series, S, cx) {
  const { headR: r, headCy: cy } = S;
  const top = cy - r;
  const fill = `fill="${C.hair}" stroke="${C.ink}" stroke-width="2.6" stroke-linejoin="round"`;
  const path = (d) => `<path d="${d}" ${fill}/>`;
  if (series.id === "a") {
    return path(`M${n(cx - r)} ${n(cy - 6)} q-${n(r * 0.1)} -${n(r * 1.15)} ${n(r)} -${n(r * 1.18)} q${n(r * 1.05)} 0 ${n(r * 1.02)} ${n(r * 1.18)} l-${n(r * 0.12)} ${n(r * 0.18)} q-${n(r * 0.9)} -${n(r * 0.42)} -${n(r * 1.8)} ${n(r * 0.02)} Z`) +
      `<ellipse cx="${n(cx - r * 0.9)}" cy="${n(cy - r * 0.16)}" rx="5" ry="9" ${fill}/>` +
      `<ellipse cx="${n(cx + r * 0.9)}" cy="${n(cy - r * 0.16)}" rx="5" ry="9" ${fill}/>`;
  }
  if (series.id === "b") {
    return `<circle cx="${n(cx - r * 0.88)}" cy="${n(top + r * 0.12)}" r="${n(r * 0.3)}" ${fill}/>` +
      `<circle cx="${n(cx + r * 0.88)}" cy="${n(top + r * 0.12)}" r="${n(r * 0.3)}" ${fill}/>` +
      path(`M${n(cx - r * 0.94)} ${n(cy - r * 0.12)} q-${n(r * 0.06)} -${n(r * 1.08)} ${n(r * 0.94)} -${n(r * 1.06)} q${n(r * 1)} -0.02 ${n(r * 0.94)} ${n(r * 1.06)} q-${n(r * 0.48)} -${n(r * 0.52)} -${n(r * 0.94)} -${n(r * 0.42)} q-${n(r * 0.46)} -0.1 -${n(r * 0.94)} ${n(r * 0.42)} Z`);
  }
  if (series.id === "c") {
    let curls = "";
    for (let i = 0; i < 7; i += 1) {
      const angle = Math.PI + (Math.PI * i) / 6;
      curls += `<circle cx="${n(cx + Math.cos(angle) * r * 0.82)}" cy="${n(cy + Math.sin(angle) * r * 0.82)}" r="${n(r * 0.3)}" ${fill}/>`;
    }
    return curls + path(`M${n(cx - r * 0.8)} ${n(cy - r * 0.55)} q${n(r * 0.8)} -${n(r * 0.75)} ${n(r * 1.6)} 0 Z`);
  }
  return path(`M${n(cx - r)} ${n(cy + 2)} q-${n(r * 0.12)} -${n(r * 1.2)} ${n(r * 1.1)} -${n(r * 1.22)} q${n(r * 0.95)} 0 ${n(r * 0.9)} ${n(r * 0.72)} q-${n(r * 0.75)} -${n(r * 0.2)} -${n(r * 1.15)} ${n(r * 0.34)} q-${n(r * 0.32)} ${n(r * 0.28)} -${n(r * 0.85)} ${n(r * 0.16)} Z`) +
    `<path d="M${n(cx + r * 0.82)} ${n(cy - r * 0.62)} q${n(r * 0.26)} ${n(r * 0.5)} -${n(r * 0.08)} ${n(r * 0.95)}" fill="none" stroke="${C.ink}" stroke-width="2.6" stroke-linecap="round"/>`;
}

function faceMarkup(S, cx) {
  const { headR: r, headCy: cy } = S;
  const eye = Math.max(2, r * 0.075);
  const dx = r * 0.34;
  return `<g data-part="openpeeps-derived/face/${S.id}">` +
    `<circle cx="${n(cx - dx)}" cy="${n(cy + r * 0.02)}" r="${n(eye)}" fill="${C.ink}"/>` +
    `<circle cx="${n(cx + dx)}" cy="${n(cy + r * 0.02)}" r="${n(eye)}" fill="${C.ink}"/>` +
    `<ellipse cx="${n(cx - r * 0.62)}" cy="${n(cy + r * 0.32)}" rx="${n(r * 0.17)}" ry="${n(r * 0.1)}" fill="${C.blush}" opacity="0.62"/>` +
    `<ellipse cx="${n(cx + r * 0.62)}" cy="${n(cy + r * 0.32)}" rx="${n(r * 0.17)}" ry="${n(r * 0.1)}" fill="${C.blush}" opacity="0.62"/>` +
    `<path d="M${n(cx - r * 0.16)} ${n(cy + r * 0.36)} q${n(r * 0.16)} ${n(r * 0.18)} ${n(r * 0.32)} 0" fill="none" stroke="${C.ink}" stroke-width="2.2" stroke-linecap="round"/>` +
    `</g>`;
}

function headMarkup(S, series, cx) {
  const { headR: r, headCy: cy } = S;
  return `<g data-part="openpeeps-derived/head/${S.id}-${series.id}">` +
    `<circle cx="${n(cx - r * 0.96)}" cy="${n(cy + r * 0.12)}" r="${n(r * 0.2)}" fill="${C.skin}" stroke="${C.ink}" stroke-width="2.6"/>` +
    `<circle cx="${n(cx + r * 0.96)}" cy="${n(cy + r * 0.12)}" r="${n(r * 0.2)}" fill="${C.skin}" stroke="${C.ink}" stroke-width="2.6"/>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${C.skin}" stroke="${C.ink}" stroke-width="3.1"/>` +
    `<g data-part="openpeeps-derived/hair/${series.hair}">${hairMarkup(series, S, cx)}</g>` +
    faceMarkup(S, cx) +
    `</g>`;
}

/** 服裝細節：4 個 series 共用同一批款式，不分性別強制裙裝或褲裝。 */
function garmentDetail(S, series, cx, bodyTop, bodyBottom, bodyHalf) {
  const sw = 2.4;
  const stroke = `fill="none" stroke="${C.ink}" stroke-width="${sw}" stroke-linecap="round"`;
  if (series.id === "a") {
    return `<path d="M${n(cx - bodyHalf * 0.5)} ${n(bodyTop)} q${n(bodyHalf * 0.5)} 11 ${n(bodyHalf)} 0" ${stroke}/>` +
      `<rect x="${n(cx + bodyHalf * 0.16)}" y="${n(bodyTop + (bodyBottom - bodyTop) * 0.38)}" width="${n(bodyHalf * 0.42)}" height="${n(bodyHalf * 0.34)}" rx="3" fill="${C.light}" stroke="${C.ink}" stroke-width="1.8"/>`;
  }
  if (series.id === "b") {
    const by = bodyTop + 6;
    return `<path d="M${n(cx - bodyHalf * 0.55)} ${by} l6 ${n((bodyBottom - bodyTop) * 0.55)} M${n(cx + bodyHalf * 0.55)} ${by} l-6 ${n((bodyBottom - bodyTop) * 0.55)}" ${stroke}/>` +
      `<circle cx="${n(cx - bodyHalf * 0.48)}" cy="${n(bodyTop + (bodyBottom - bodyTop) * 0.58)}" r="3.2" fill="${C.light}" stroke="${C.ink}" stroke-width="1.6"/>` +
      `<circle cx="${n(cx + bodyHalf * 0.48)}" cy="${n(bodyTop + (bodyBottom - bodyTop) * 0.58)}" r="3.2" fill="${C.light}" stroke="${C.ink}" stroke-width="1.6"/>`;
  }
  if (series.id === "c") {
    const y1 = bodyTop + (bodyBottom - bodyTop) * 0.42;
    const y2 = bodyTop + (bodyBottom - bodyTop) * 0.62;
    return `<path d="M${n(cx - bodyHalf * 0.82)} ${n(y1)} q${n(bodyHalf * 0.82)} 6 ${n(bodyHalf * 1.64)} 0 M${n(cx - bodyHalf * 0.82)} ${n(y2)} q${n(bodyHalf * 0.82)} 6 ${n(bodyHalf * 1.64)} 0" ${stroke}/>`;
  }
  return `<path d="M${n(cx - bodyHalf * 0.36)} ${n(bodyTop)} l${n(bodyHalf * 0.36)} 12 l${n(bodyHalf * 0.36)} -12 M${n(cx)} ${n(bodyTop + 12)} L${n(cx)} ${n(bodyBottom)}" ${stroke}/>` +
    `<circle cx="${n(cx)}" cy="${n(bodyTop + (bodyBottom - bodyTop) * 0.5)}" r="2.2" fill="${C.ink}"/>` +
    `<circle cx="${n(cx)}" cy="${n(bodyTop + (bodyBottom - bodyTop) * 0.72)}" r="2.2" fill="${C.ink}"/>`;
}

/** 嬰兒：坐姿、大頭、連身衣／尿布褲、圍兜，完全沒有成人站立身體。 */
function babyBody(S, series, cx) {
  const { ground } = S;
  const top = 92;
  const bottom = ground - 6;
  const half = 40;
  const outline = `fill="${C.clothes}" stroke="${C.ink}" stroke-width="3" stroke-linejoin="round"`;
  return `<g data-part="openpeeps-derived/pose/sitting">` +
    `<g data-part="openpeeps-derived/body/${S.body}-${series.id}">` +
    /* 向前伸的兩條短腿與腳 */
    `<ellipse cx="${n(cx - 34)}" cy="${n(ground - 12)}" rx="23" ry="14" ${outline}/>` +
    `<ellipse cx="${n(cx + 34)}" cy="${n(ground - 12)}" rx="23" ry="14" ${outline}/>` +
    `<ellipse cx="${n(cx - 52)}" cy="${n(ground - 11)}" rx="11" ry="9" fill="${C.skin}" stroke="${C.ink}" stroke-width="2.4"/>` +
    `<ellipse cx="${n(cx + 52)}" cy="${n(ground - 11)}" rx="11" ry="9" fill="${C.skin}" stroke="${C.ink}" stroke-width="2.4"/>` +
    /* 圓潤連身衣軀幹 */
    `<path d="M${n(cx - half)} ${n(top)} q${n(half)} -12 ${n(half * 2)} 0 l8 ${n(bottom - top - 18)} q-${n(half + 8)} 14 -${n(half * 2 + 16)} 0 Z" ${outline}/>` +
    /* 尿布褲輪廓（不裸露） */
    `<path d="M${n(cx - half * 0.72)} ${n(bottom - 30)} q${n(half * 0.72)} 10 ${n(half * 1.44)} 0" fill="none" stroke="${C.ink}" stroke-width="2.1" stroke-linecap="round" opacity="0.7"/>` +
    /* 兩隻短手 */
    `<ellipse cx="${n(cx - half - 7)}" cy="${n(top + 26)}" rx="10" ry="13" ${outline}/>` +
    `<ellipse cx="${n(cx + half + 7)}" cy="${n(top + 26)}" rx="10" ry="13" ${outline}/>` +
    /* 圍兜 */
    `<path d="M${n(cx - 17)} ${n(top - 2)} q17 14 34 0 l0 15 q-17 9 -34 0 Z" fill="${C.light}" stroke="${C.ink}" stroke-width="2.2" stroke-linejoin="round"/>` +
    `<circle cx="${n(cx)}" cy="${n(top + 12)}" r="2.6" fill="${C.ink}"/>` +
    garmentDetail(S, series, cx, top + 18, bottom - 34, half * 0.9) +
    `</g></g>`;
}

/** 幼童／學生共用的站姿骨架；比例與服裝由 STAGES 參數決定。 */
function standingBody(S, series, cx) {
  const { ground, headR: r, headCy: cy } = S;
  const top = cy + r * 0.92;
  // 上衣只佔 ~45%，腿佔 ~55%：明確是「上衣＋長褲」，不會看成縮小成人長袍／裙裝。
  const hip = ground - Math.round((ground - top) * 0.55);
  const half = Math.round(S.w * 0.24);
  const legW = Math.max(10, Math.round(S.w * 0.13));
  const legGap = Math.max(4, Math.round(S.w * 0.05));
  const sw = 3;
  const outline = `fill="${C.clothes}" stroke="${C.ink}" stroke-width="${sw}" stroke-linejoin="round"`;
  // 幼童穿短褲露出小腿；學生一律長褲（不按性別分配裙裝／褲裝）。
  const legFill = S.id === "child" ? C.skin : C.clothes;
  const legLine = `fill="${legFill}" stroke="${C.ink}" stroke-width="${sw}" stroke-linejoin="round"`;
  let legs = "";
  for (const side of [-1, 1]) {
    const lx = cx + side * (legGap + legW / 2);
    legs += `<path d="M${n(lx - legW / 2)} ${n(hip - 4)} l${n(legW)} 0 l-1 ${n(ground - hip - 16)} q-${n(legW / 2)} 5 -${n(legW)} 0 Z" ${legLine}/>`;
    legs += `<ellipse cx="${n(lx)}" cy="${n(ground - 7)}" rx="${n(legW * 0.72)}" ry="8" fill="${C.sole}" stroke="${C.ink}" stroke-width="2.2"/>`;
  }
  /* 袖子用「黑描邊 + 衣服色」兩層粗線，和 Open Peeps 的色塊＋黑線筆觸一致。 */
  const armTop = top + 8;
  const armLen = hip - armTop + 6;
  const armW = Math.max(7, S.w * 0.075);
  let arms = "";
  for (const side of [-1, 1]) {
    const ax = cx + side * (half + 2);
    const d = `M${n(ax)} ${n(armTop)} q${n(side * 9)} ${n(armLen * 0.4)} ${n(side * 4)} ${n(armLen)}`;
    arms += `<path d="${d}" fill="none" stroke="${C.ink}" stroke-width="${n(armW + 2.6)}" stroke-linecap="round"/>`;
    arms += `<path d="${d}" fill="none" stroke="${C.clothes}" stroke-width="${n(armW)}" stroke-linecap="round"/>`;
    arms += `<circle cx="${n(ax + side * 4)}" cy="${n(armTop + armLen)}" r="${n(Math.max(4.5, S.w * 0.042))}" fill="${C.skin}" stroke="${C.ink}" stroke-width="${sw}"/>`;
  }
  const torso = `<path d="M${n(cx - half)} ${n(top)} q${n(half)} -8 ${n(half * 2)} 0 l${n(half * 0.16)} ${n(hip - top)} q-${n(half + half * 0.16)} 10 -${n(half * 2 + half * 0.32)} 0 Z" ${outline}/>`;
  /* 褲腰／下擺線，讓「上衣 + 褲子」的層次一眼可辨。 */
  const waist = `<path d="M${n(cx - half * 0.92)} ${n(hip - 3)} q${n(half * 0.92)} 9 ${n(half * 1.84)} 0" fill="none" stroke="${C.ink}" stroke-width="2.3" stroke-linecap="round"/>`;

  /* 階段專屬配件：學生的書包／連帽／背包都在 SVG 內，不再靠成人前景配件疊加。 */
  let stageExtra = "";
  if (S.id === "child") {
    /* 幼童：短褲輪廓 + 圓滾滾的褲腳 */
    stageExtra += `<path d="M${n(cx - half * 0.9)} ${n(hip - 10)} q${n(half * 0.9)} 12 ${n(half * 1.8)} 0" fill="none" stroke="${C.ink}" stroke-width="2.2"/>`;
    stageExtra += `<g data-part="openpeeps-derived/item/toddler-bib"><path d="M${n(cx - 13)} ${n(top + 2)} q13 11 26 0 l0 12 q-13 7 -26 0 Z" fill="${C.light}" stroke="${C.ink}" stroke-width="1.9"/></g>`;
  } else if (S.id === "primary") {
    /* 小學生：肩背書包兩條帶 + 小領巾 */
    stageExtra += `<g data-part="openpeeps-derived/item/school-bag-straps">` +
      `<path d="M${n(cx - half * 0.56)} ${n(top + 2)} q-9 ${n((hip - top) * 0.52)} -5 ${n((hip - top) * 0.9)} M${n(cx + half * 0.56)} ${n(top + 2)} q9 ${n((hip - top) * 0.52)} 5 ${n((hip - top) * 0.9)}" fill="none" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/></g>` +
      `<g data-part="openpeeps-derived/item/neckerchief"><path d="M${n(cx - 11)} ${n(top + 1)} l11 13 l11 -13 Z" fill="${C.light}" stroke="${C.ink}" stroke-width="1.9" stroke-linejoin="round"/></g>`;
  } else if (S.id === "teen") {
    /* 青少年：連帽衫帽子 + 斜挎包帶 */
    stageExtra += `<g data-part="openpeeps-derived/item/hood"><path d="M${n(cx - 15)} ${n(top + 1)} q15 22 30 0 q-15 -9 -30 0 Z" fill="${C.light}" stroke="${C.ink}" stroke-width="2.2"/></g>` +
      `<g data-part="openpeeps-derived/item/crossbody-bag"><path d="M${n(cx - half * 0.8)} ${n(top + 6)} q${n(half * 1.2)} ${n((hip - top) * 0.7)} ${n(half * 1.5)} ${n((hip - top) * 0.95)}" fill="none" stroke="${C.ink}" stroke-width="2.6"/>` +
      `<rect x="${n(cx + half * 0.5)}" y="${n(hip - 18)}" width="19" height="16" rx="4" fill="${C.light}" stroke="${C.ink}" stroke-width="2"/></g>`;
  } else if (S.id === "university") {
    /* 大學生：背後背包 + 開襟外套門襟 */
    stageExtra += `<g data-part="openpeeps-derived/item/backpack"><rect x="${n(cx - half - 15)}" y="${n(top + 12)}" width="19" height="${n((hip - top) * 0.66)}" rx="7" fill="${C.light}" stroke="${C.ink}" stroke-width="2.4"/>` +
      `<path d="M${n(cx - half * 0.62)} ${n(top + 4)} q-11 ${n((hip - top) * 0.5)} -8 ${n((hip - top) * 0.8)}" fill="none" stroke="${C.ink}" stroke-width="2.6"/></g>` +
      `<g data-part="openpeeps-derived/item/cardigan"><path d="M${n(cx)} ${n(top + 4)} L${n(cx)} ${n(hip - 4)}" fill="none" stroke="${C.ink}" stroke-width="2.1"/></g>`;
  }

  return `<g data-part="openpeeps-derived/pose/${S.pose}">` +
    `<g data-part="openpeeps-derived/body/${S.body}-${series.id}">` +
    legs + arms + torso + waist + garmentDetail(S, series, cx, top, hip, half) + stageExtra +
    `</g></g>`;
}

function buildSvg(S, series) {
  const cx = S.w / 2;
  const inner = `<g data-part="openpeeps-derived/${S.id}-${series.id}">` +
    standingOrBaby(S, series, cx) +
    headMarkup(S, series, cx) +
    `</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S.w} ${S.h}" width="${S.w}" height="${S.h}">` +
    `<title>Project-derived Open Peeps style ${S.id}-${series.id}</title>${inner}</svg>`;
}

function standingOrBaby(S, series, cx) {
  return S.id === "baby" ? babyBody(S, series, cx) : standingBody(S, series, cx);
}

/** 供 TS 使用的內層 markup：剝掉外層 svg／title，換成身份色彩佔位符。 */
function toRuntimeMarkup(raw) {
  return raw
    .replace(/^<svg[^>]*>/, "")
    .replace(/<title>[^<]*<\/title>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(new RegExp(C.ink, "gi"), "{{ink}}")
    .replace(new RegExp(C.skin, "gi"), "{{skin}}")
    .replace(new RegExp(C.clothes, "gi"), "{{clothes}}")
    .replace(new RegExp(C.hair, "gi"), "{{hair}}");
}

const records = [];
for (const S of STAGES) {
  for (const series of SERIES) {
    const key = `${S.id}-${series.id}`;
    const file = `${key}.svg`;
    const raw = buildSvg(S, series);
    writeFileSync(join(derivedDir, file), raw, "utf8");
    const markup = toRuntimeMarkup(raw);
    records.push({
      key,
      stage: S.id,
      series: series.id,
      hair: `openpeeps-derived/hair/${series.hair}`,
      head: `openpeeps-derived/head/${key}`,
      face: `openpeeps-derived/face/${S.id}`,
      body: `openpeeps-derived/body/${S.body}-${series.id}`,
      pose: `openpeeps-derived/pose/${S.pose}`,
      garment: `${S.garment}/${series.garmentLabel}`,
      label: S.label,
      hairLabel: series.hairLabel,
      viewBox: `0 0 ${S.w} ${S.h}`,
      source: `derived/${file}`,
      rawBytes: Buffer.byteLength(raw, "utf8"),
      compactBytes: Buffer.byteLength(markup, "utf8"),
      sha256: createHash("sha256").update(raw).digest("hex"),
      markup
    });
  }
}

const keyUnion = records.map((r) => `"${r.key}"`).join(" | ");
const stageUnion = STAGES.map((s) => `"${s.id}"`).join(" | ");
const assetLines = records.map((r) =>
  `  Object.freeze({ key: "${r.key}", stage: "${r.stage}", series: "${r.series}", ` +
  `viewBox: "${r.viewBox}", body: "${r.body}", head: "${r.head}", face: "${r.face}", ` +
  `hair: "${r.hair}", pose: "${r.pose}", garment: "${r.garment}", ` +
  `source: "${r.source}", derived: "project-original" as const, bytes: ${r.compactBytes} })`
).join(",\n");
const rawLines = records.map((r) => `  "${r.key}": ${JSON.stringify(r.markup)}`).join(",\n");
const byStage = STAGES.map((S) =>
  `  ${S.id}: Object.freeze([${SERIES.map((s) => `"${S.id}-${s.id}"`).join(", ")}] as const)`
).join(",\n");

const ts = `/**
 * GPT-WORKBUDDY-0063-B｜**本專案衍生**的年齡專用全身人物（非官方原件）。
 *
 * 官方 Open Peeps（Pablo Stanley，CC0 1.0）只有成人 Standing 成品；0 歲嬰兒
 * 與學生過去被畫成「縮小成人」，CTO 判定不合格。CC0 允許 modify / remix /
 * derive，因此這 20 個 SVG 是**本專案以 Open Peeps 手繪筆觸自行繪製的衍生
 * 作品**，不是從官方集合下載的原件，也不假裝是。來源、授權依據、逐檔 SHA-256
 * 與「非刻板衣著」說明見
 * \`assets/generated/open-peeps/derived/DERIVED-SOURCE.md\`。
 *
 * - 5 個階段（baby／child／primary／teen／university）× 4 個 identity series。
 * - 同一人物跨年齡維持同一 series（同一 \`data-part="openpeeps-derived/hair/..."\`
 *   髮型 key）；膚色／髮色／衣著色由 scene 層 seed 注入，跨年齡不變。
 * - 嬰兒是坐姿連身衣＋大頭身比，body key 明確是 \`openpeeps-derived/body/onesie-*\`，
 *   **不可能**等於官方成人 \`openpeeps/pose/standing/*\`。
 * - 學生 body key 是 school／teen／campus，沒有 blazer／suit／business-only key。
 * - 4 種服裝款式對男女都開放，沒有「女性固定裙子、男性固定褲子」。
 * - 重製：\`node scripts/p3e-0063b-derived-peeps.mjs\`（只讀本機衍生 SVG）。
 */

export type DerivedLifeStage = ${stageUnion};
export type DerivedSeries = "a" | "b" | "c" | "d";
export type DerivedPeepKey = ${keyUnion};

/** 衍生資產對照（矩陣測試直接斷言 body／hair key，不看 DOM 有沒有圖片）。 */
export const DERIVED_PEEPS_ASSETS = Object.freeze([
${assetLines}
] as const);

export type DerivedPeepAsset = (typeof DERIVED_PEEPS_ASSETS)[number];

/** 每個生活階段 4 個 identity series，男女共用，不綁死性別。 */
export const DERIVED_BY_STAGE: Readonly<Record<DerivedLifeStage, readonly DerivedPeepKey[]>> = Object.freeze({
${byStage}
});

export interface DerivedPeepColors {
  readonly ink: string;
  readonly clothes: string;
  readonly hair: string;
  readonly skin: string;
}

const RAW_DERIVED_PEEPS: Readonly<Record<DerivedPeepKey, string>> = Object.freeze({
${rawLines}
});

export function derivedPeepOf(stage: DerivedLifeStage, series: DerivedSeries): DerivedPeepKey {
  return \`\${stage}-\${series}\` as DerivedPeepKey;
}

export function derivedPeepAsset(key: DerivedPeepKey): DerivedPeepAsset {
  return DERIVED_PEEPS_ASSETS.find((entry) => entry.key === key) as DerivedPeepAsset;
}

/** 注入穩定色彩後回傳完整衍生全身 SVG 的內層。 */
export function derivedPeepMarkup(key: DerivedPeepKey, colors: DerivedPeepColors): string {
  return RAW_DERIVED_PEEPS[key].replace(/\\{\\{(ink|clothes|hair|skin)\\}\\}/g, (_match, slot: string) =>
    colors[slot as keyof DerivedPeepColors] ?? "#4a3b32"
  );
}

/** 非官方原件的明確標記，供 attribution 與測試稽核。 */
export const DERIVED_PEEPS_PROVENANCE = Object.freeze({
  origin: "project-original-derivative" as const,
  baseLicense: "CC0-1.0" as const,
  officialAssetCount: 0,
  derivedAssetCount: DERIVED_PEEPS_ASSETS.length,
  note: "以 Open Peeps CC0 手繪筆觸自行繪製；官方集合沒有嬰幼兒／學生全身角色。"
});
`;
writeFileSync(outTs, ts, "utf8");

const gzipOf = (text) => gzipSync(Buffer.from(text, "utf8"), { level: 9 }).length;
const totalRaw = records.reduce((sum, r) => sum + r.rawBytes, 0);
const totalCompact = records.reduce((sum, r) => sum + r.compactBytes, 0);
const totalRawGzip = records.reduce((sum, r) => sum + gzipOf(readFileSync(join(derivedDir, `${r.key}.svg`), "utf8")), 0);
const totalCompactGzip = records.reduce((sum, r) => sum + gzipOf(r.markup), 0);
const tsBytes = Buffer.byteLength(ts, "utf8");

let doc = `# GPT-WORKBUDDY-0063-B｜本專案衍生年齡專用全身人物（**非官方原件**）\n\n`;
doc += `## 授權與衍生說明\n\n`;
doc += `- 取得／繪製日期：**${RETRIEVED}**（UTC+8）。\n`;
doc += `- 基礎風格：Open Peeps by Pablo Stanley，官方站 https://www.openpeeps.com/ ，\n`;
doc += `  **CC0 1.0 Universal**（public domain dedication）。官方站原文：\n\n`;
doc += `  > "Free for commercial and personal use under CC0 License."\n>\n`;
doc += `  > "The library is in the public domain under the CC0 License. This means you can copy, modify, distribute, remix, burn, and use the work, even for commercial purposes, without asking permission."\n\n`;
doc += `- CC0 法律全文：\`../CC0-1.0-legalcode.txt\`（取自\n`;
doc += `  https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt ）。\n`;
doc += `- **重要：本目錄 20 個 SVG 全部是「本專案衍生」自行繪製的作品，不是從\n`;
doc += `  Open Peeps 官方集合、PeepStudio repo 或任何第三方重包下載的原件。**\n`;
doc += `  官方 Standing 成品只有成人，沒有嬰兒／幼童／學生；0062-B 把成人縮小\n`;
doc += `  給 0 歲用，CTO 判定不合格。CC0 明確允許 modify / remix / derive，\n`;
doc += `  因此沿用其「圓頭黑線手繪、色塊填充、圓潤關節」視覺語言自行繪製，\n`;
doc += `  並在此清楚標示，不假稱官方原件。官方 8 個成人成品仍見 \`../SOURCE.md\`。\n`;
doc += `- 繪製方式：\`scripts/p3e-0063b-derived-peeps.mjs\` 以參數化 SVG 路徑\n`;
doc += `  產生，沒有執行期熱連結、沒有外部 API、沒有帳號、沒有 CDN。\n\n`;
doc += `## 五個階段 × 四個 identity series\n\n`;
doc += `| 階段 | 年齡 | 人物特徵 | body key | pose key |\n`;
doc += `| --- | --- | --- | --- | --- |\n`;
for (const S of STAGES) {
  const ages = { baby: "0–2", child: "3–5", primary: "6–11", teen: "12–17", university: "18–22" }[S.id];
  doc += `| \`${S.id}\` | ${ages} | ${S.label} | \`openpeeps-derived/body/${S.body}-*\` | \`openpeeps-derived/pose/${S.pose}\` |\n`;
}
doc += `\n嬰兒為坐姿連身衣＋大頭身比（viewBox 150×170），**不含任何官方成人\n`;
doc += `\`openpeeps/pose/standing/*\` body key**；學生的 school／teen／campus\n`;
doc += `body key 也不含 blazer／suit／business-only 字樣。\n\n`;
doc += `### 非刻板衣著與 identity 連續\n\n`;
doc += `- 4 個 series（a 短髮／b 雙髮髻／c 捲髮／d 斜劉海）對**男女都開放**，\n`;
doc += `  服裝款式是圓領、背帶、條紋、襯衫領，沒有「女性固定裙子、男性固定褲子」。\n`;
doc += `- 同一人物跨年齡維持同一 series → 同一 \`data-part="openpeeps-derived/hair/..."\`；\n`;
doc += `  膚色／髮色／衣著色由 scene 層的穩定 seed 注入，跨年齡不變（老年白髮例外）。\n`;
doc += `- 成長只改頭身比、身高與合理服裝；變成 young 時才改用官方成人 Standing 成品。\n\n`;
doc += `## 實際檔案清單（20 個，全部隨本站自託管）\n\n`;
doc += `| key | 階段 | series | 髮型 key | 檔名 | bytes | SHA-256 |\n`;
doc += `| --- | --- | --- | --- | --- | --- | --- |\n`;
for (const r of records) {
  doc += `| \`${r.key}\` | ${r.stage} | ${r.series} | \`${r.hair}\` | \`${r.source}\` | ${r.rawBytes} | \`${r.sha256}\` |\n`;
}
doc += `\n## 大小\n\n`;
doc += `- 20 個衍生 SVG 原始合計 **${totalRaw.toLocaleString("en-US")} bytes**\n`;
doc += `  （gzip ${totalRawGzip.toLocaleString("en-US")}）；去外殼／換色彩佔位符後\n`;
doc += `  ${totalCompact.toLocaleString("en-US")} bytes（gzip ${totalCompactGzip.toLocaleString("en-US")}）。\n`;
doc += `- 產生的 TS 常數模組 \`packages/ui/src/p3e-open-peeps-derived.ts\`\n`;
doc += `  ${tsBytes.toLocaleString("en-US")} bytes；只被 \`p3e-scene.ts\` 引用，\n`;
doc += `  並隨 \`p3e-game-layer.ts\` 延遲載入，不在出生卡關鍵路徑。\n`;
doc += `- \`.svg\` 檔使用固定調色盤方便直接預覽；runtime 由 \n`;
doc += `  \`derivedPeepMarkup()\` 把 \`{{ink}}/{{clothes}}/{{hair}}/{{skin}}\`\n`;
doc += `  換成該角色 identity 的穩定色彩。\n`;
writeFileSync(join(derivedDir, "DERIVED-SOURCE.md"), doc, "utf8");

/* 0062 的 SOURCE.md 也要能找到衍生段落；幂等，重跑任一產生器都不重複。 */
const HEADING = "## GPT-WORKBUDDY-0063-B｜本專案衍生年齡專用人物";
if (existsSync(sourcePath)) {
  const existing = readFileSync(sourcePath, "utf8");
  if (!existing.includes(HEADING)) {
    const appendix = `\n${HEADING}（**非官方原件**）\n\n` +
      `官方 Open Peeps 集合沒有嬰兒／幼童／學生全身角色；0063-B 另以 CC0 允許的\n` +
      `modify / remix 方式建立 **20 個本專案衍生** SVG，供 0–22 歲使用。\n` +
      `完整清單、逐檔 SHA-256、授權依據與「非刻板衣著」說明見\n` +
      `\`derived/DERIVED-SOURCE.md\`；官方 8 個成人成品仍是上表，不混為一談。\n`;
    writeFileSync(sourcePath, `${existing.trimEnd()}\n${appendix}`, "utf8");
  }
}

writeFileSync(reportPath, JSON.stringify({
  retrieved: RETRIEVED,
  provenance: "project-original-derivative",
  baseLicense: "CC0-1.0",
  officialAssetCount: 0,
  assets: records.map(({ markup, ...r }) => ({ ...r, compactGzip: gzipOf(markup) })),
  totals: {
    files: records.length,
    rawBytes: totalRaw,
    rawGzip: totalRawGzip,
    compactBytes: totalCompact,
    compactGzip: totalCompactGzip,
    tsBytes,
    tsGzip: gzipOf(ts)
  }
}, null, 2) + "\n", "utf8");

console.log(`P3E-0063B-DERIVED OK assets=${records.length} raw=${totalRaw}B rawGzip=${totalRawGzip}B compact=${totalCompact}B compactGzip=${totalCompactGzip}B ts=${tsBytes}B tsGzip=${gzipOf(ts)}B`);
for (const r of records) console.log(`  ${r.key}: ${r.rawBytes}B -> ${r.compactBytes}B ${r.body}`);
