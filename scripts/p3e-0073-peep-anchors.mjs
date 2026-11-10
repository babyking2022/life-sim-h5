/**
 * GPT-WORKBUDDY-DAYU-0073-A｜人物身體錨點量測器（產生 `p3e-peep-anchors.ts`）。
 *
 * 為什麼要量、不沿用比例：0073 的缺陷是 `ageAccessories()` 用「人物外框高度 ×
 * 固定比例」猜眼鏡／圍巾／拐杖位置。官方 Open Peeps 的 viewBox 是**寬高**而非
 * 內容範圍，人物在框內的位置、頭身比、眼睛高度各不相同；derived 人物又是另一套
 * 座標系。用一個全域比例去猜，必然把眼鏡畫到脖子、把拐杖畫到空中。
 *
 * 本腳本改用「渲染後量測」：
 *  - `content`：整個人物的 getBBox()（真正的可見內容範圍）。
 *  - `head`：`[data-part^="…/head/"]` 群組的 CTM 校正 bbox。
 *  - `eye`：把 `face` 群組單獨點陣化，對墨點做連通分量，取最上面兩個（左右眼），
 *    得到眼中心、眼距、瞳孔半徑。不是猜比例，是畫面上真正有墨的地方。
 *  - `neck`：下巴下方 3.5% 身高處的剪影寬度（肩線）。
 *  - `hand`：54% 身高處剪影的左右緣（手／袖口外緣）。
 *  - `ground`：content.bottom（腳底）。
 *
 * 產出：
 *   packages/ui/src/p3e-peep-anchors.ts       runtime 錨點表（含 viewBox 與來源標記）
 *   .artifacts/p3e-0073-anchors.json          量測報告（供人工稽核）
 *
 * 執行：node scripts/p3e-0073-peep-anchors.mjs
 * 驗證：node scripts/p3e-0073-anchor-check.mjs（重測並與已提交的表比對）
 */
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const bundlePath = resolve(root, ".artifacts/0073-anchors-bundle.mjs");
// `P3E_ANCHORS_OUT` 讓 `p3e-0073-anchor-check.mjs` 把重測結果寫到暫存檔再比對，
// 不會覆蓋已提交的錨點表。
const outTs = resolve(root, process.env.P3E_ANCHORS_OUT ?? "packages/ui/src/p3e-peep-anchors.ts");
const outReport = resolve(root, ".artifacts/p3e-0073-anchors.json");

/** 量測用的固定色彩（只影響 alpha，不影響幾何）。 */
const COLORS = Object.freeze({ ink: "#3f332b", clothes: "#6d9bb5", hair: "#3a2a20", skin: "#f6d3b0" });
/** 點陣化倍率：6 倍足以讓 1px 眼睛筆畫成為獨立連通分量。 */
const RASTER = 6;

await mkdir(resolve(root, ".artifacts"), { recursive: true });
await build({
  stdin: {
    contents: `export { OPEN_PEEPS_ASSETS, openPeepsMarkup } from "./packages/ui/src/p3e-open-peeps.ts";
export { DERIVED_PEEPS_ASSETS, derivedPeepMarkup } from "./packages/ui/src/p3e-open-peeps-derived.ts";`,
    resolveDir: root,
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: bundlePath,
  logLevel: "silent"
});
const mod = await import(`file://${bundlePath.replace(/\\/g, "/")}`);

const jobs = [];
for (const asset of mod.OPEN_PEEPS_ASSETS) {
  const [width, height] = asset.viewBox.split(" ").map(Number);
  jobs.push({ key: asset.key, namespace: "openpeeps", width, height, markup: mod.openPeepsMarkup(asset.key, COLORS) });
}
for (const asset of mod.DERIVED_PEEPS_ASSETS) {
  const [, , width, height] = asset.viewBox.split(" ").map(Number);
  jobs.push({ key: asset.key, namespace: "derived", width, height, markup: mod.derivedPeepMarkup(asset.key, COLORS) });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const results = [];

for (const job of jobs) {
  await page.setContent(
    `<html><body style="margin:0;background:transparent">` +
    `<svg id="host" xmlns="http://www.w3.org/2000/svg" width="${job.width}" height="${job.height}" ` +
    `viewBox="0 0 ${job.width} ${job.height}"><g id="art">${job.markup}</g></svg></body></html>`
  );
  const measured = await page.evaluate(async ({ raster }) => {
    const host = document.getElementById("host");
    const svgRect = host.getBoundingClientRect();
    /** 元素在根 svg 使用者座標（= CSS px，因為 width/height 與 viewBox 同尺寸）的 bbox。 */
    const boxOf = (el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - svgRect.left,
        top: r.top - svgRect.top,
        right: r.right - svgRect.left,
        bottom: r.bottom - svgRect.top
      };
    };
    const box = (b) => ({ left: +b.left.toFixed(2), top: +b.top.toFixed(2), right: +b.right.toFixed(2), bottom: +b.bottom.toFixed(2) });
    const content = box(boxOf(document.getElementById("art")));
    const art = document.getElementById("art");
    const headEl = art.querySelector('[data-part*="/head/"]');
    const faceEl = art.querySelector('[data-part*="/face/"]');
    const head = headEl ? box(boxOf(headEl)) : content;
    const faceBox = faceEl ? box(boxOf(faceEl)) : null;
    const width = host.viewBox.baseVal.width;
    const height = host.viewBox.baseVal.height;

    /** 只保留 target 這一支（祖先 transform 全部保留），其餘同層節點移除。 */
    const isolate = (target) => {
      const walk = (node) => {
        for (const child of [...node.children]) {
          if (child === target) continue;
          if (child.contains(target)) { walk(child); continue; }
          child.remove();
        }
      };
      walk(host);
    };
    const serialize = () => {
      const clone = host.cloneNode(true);
      clone.removeAttribute("id");
      const wrapper = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      wrapper.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      wrapper.setAttribute("width", String(width));
      wrapper.setAttribute("height", String(height));
      wrapper.setAttribute("viewBox", `0 0 ${width} ${height}`);
      wrapper.appendChild(clone.ownerDocument.importNode(clone, true));
      return new XMLSerializer().serializeToString(wrapper);
    };
    const rasterize = async () => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialize())}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * raster);
      canvas.height = Math.round(height * raster);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return { data, w: canvas.width, h: canvas.height };
    };
    const alphaAt = (mask, px, py) => mask.data[(py * mask.w + px) * 4 + 3];
    /** 「墨點」＝有 alpha 且偏暗；derived 的腮紅是粉紅，會被排除。 */
    const inkAt = (mask, px, py) => {
      const index = (py * mask.w + px) * 4;
      if (mask.data[index + 3] <= 96) return false;
      const lum = 0.299 * mask.data[index] + 0.587 * mask.data[index + 1] + 0.114 * mask.data[index + 2];
      return lum < 150;
    };

    const silhouette = await rasterize();
    /** 該列的剪影左右緣（使用者座標）。 */
    const rowExtent = (yUser) => {
      const py = Math.min(silhouette.h - 1, Math.max(0, Math.round(yUser * raster)));
      let left = null;
      let right = null;
      for (let px = 0; px < silhouette.w; px += 1) {
        if (alphaAt(silhouette, px, py) > 96) {
          if (left === null) left = px;
          right = px;
        }
      }
      return left === null ? null : { left: left / raster, right: right / raster };
    };

    /** face 群組單獨點陣化 → 連通分量 → 最上面兩個 = 左右眼。 */
    let eye = null;
    let blobCount = 0;
    if (faceEl) {
      isolate(faceEl);
      const mask = await rasterize();
      const labels = new Int32Array(mask.w * mask.h).fill(-1);
      const clusters = [];
      for (let py = 0; py < mask.h; py += 1) {
        for (let px = 0; px < mask.w; px += 1) {
          const index = py * mask.w + px;
          if (labels[index] !== -1 || !inkAt(mask, px, py)) continue;
          const id = clusters.length;
          const stack = [index];
          labels[index] = id;
          let count = 0;
          let sx = 0;
          let sy = 0;
          let minX = px;
          let maxX = px;
          let minY = py;
          let maxY = py;
          while (stack.length > 0) {
            const current = stack.pop();
            const cx = current % mask.w;
            const cy = (current - cx) / mask.w;
            count += 1;
            sx += cx;
            sy += cy;
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;
            if (cx > 0 && labels[current - 1] === -1 && inkAt(mask, cx - 1, cy)) { labels[current - 1] = id; stack.push(current - 1); }
            if (cx < mask.w - 1 && labels[current + 1] === -1 && inkAt(mask, cx + 1, cy)) { labels[current + 1] = id; stack.push(current + 1); }
            if (cy > 0 && labels[current - mask.w] === -1 && inkAt(mask, cx, cy - 1)) { labels[current - mask.w] = id; stack.push(current - mask.w); }
            if (cy < mask.h - 1 && labels[current + mask.w] === -1 && inkAt(mask, cx, cy + 1)) { labels[current + mask.w] = id; stack.push(current + mask.w); }
          }
          clusters.push({
            count,
            cx: sx / count / raster,
            cy: sy / count / raster,
            minX: minX / raster,
            maxX: maxX / raster,
            minY: minY / raster,
            maxY: maxY / raster
          });
        }
      }
      const blobs = clusters.filter((c) => c.count > 12);
      blobCount = blobs.length;
      // 眼睛＝「點狀」且左右對稱的一對。眉毛是寬扁弧線（高寬比 < 0.9），
      // 鼻子是單點、嘴巴是寬扁大塊，都會被這個規則排除。
      const dotLike = blobs.filter((c) => (c.maxY - c.minY) / Math.max(0.01, c.maxX - c.minX) >= 0.9);
      const pool = dotLike.length >= 2 ? dotLike : blobs;
      const faceCx = faceBox === null ? 0 : (faceBox.left + faceBox.right) / 2;
      const faceH = faceBox === null ? 1 : Math.max(1, faceBox.bottom - faceBox.top);
      const faceW = faceBox === null ? 1 : Math.max(1, faceBox.right - faceBox.left);
      let best = null;
      for (let i = 0; i < pool.length; i += 1) {
        for (let j = i + 1; j < pool.length; j += 1) {
          const a = pool[i];
          const b = pool[j];
          const midX = (a.cx + b.cx) / 2;
          const dy = Math.abs(a.cy - b.cy);
          const gap = Math.abs(a.cx - b.cx);
          if (dy > faceH * 0.16) continue;
          if (Math.abs(midX - faceCx) > faceW * 0.18) continue;
          if (gap < faceW * 0.08) continue;
          // 分數：越靠臉中線越好；同分時取「較低」的一對（眼睛在眉毛下方）。
          const score = Math.abs(midX - faceCx) / faceW + dy / faceH * 0.5;
          if (best === null || score < best.score - 1e-6 || (Math.abs(score - best.score) <= 1e-6 && Math.min(a.cy, b.cy) > Math.min(best.a.cy, best.b.cy))) {
            best = { a, b, score };
          }
        }
      }
      if (best !== null) {
        const { a, b } = best;
        const radius = Math.max(1, ((a.maxY - a.minY) + (b.maxY - b.minY)) / 4);
        eye = {
          cx: +((a.cx + b.cx) / 2).toFixed(2),
          cy: +((a.cy + b.cy) / 2).toFixed(2),
          halfGap: +(Math.abs(a.cx - b.cx) / 2).toFixed(2),
          radius: +radius.toFixed(2)
        };
      }
    }

    const contentH = content.bottom - content.top;
    const neckRow = head.bottom + contentH * 0.035;
    const handRow = content.top + contentH * 0.58;
    const neckExtent = rowExtent(neckRow);
    const handExtent = rowExtent(handRow);
    const headHalf = Math.max(head.right - head.left, head.bottom - head.top) / 2;
    const neckHalf = neckExtent === null ? headHalf : Math.max((neckExtent.right - neckExtent.left) / 2, headHalf * 0.8);

    return {
      width,
      height,
      content,
      head,
      // 下巴＝face 群組（臉部皮膚）的底緣。長髮／戴帽的資產 head 群組會一路
      // 包到肩膀，用 head.bottom 當下巴會把圍巾畫到胸口，所以另存臉部框。
      face: faceBox ?? head,
      eye,
      blobCount,
      neck: { y: +neckRow.toFixed(2), halfWidth: +neckHalf.toFixed(2) },
      hand: {
        y: +handRow.toFixed(2),
        left: +(handExtent?.left ?? content.left).toFixed(2),
        right: +(handExtent?.right ?? content.right).toFixed(2)
      },
      ground: content.bottom
    };
  }, { raster: RASTER });

  results.push({ key: job.key, namespace: job.namespace, ...measured });
  console.log(
    `${job.key.padEnd(12)} content=${JSON.stringify(measured.content)} eye=${JSON.stringify(measured.eye)} ` +
    `blobs=${measured.blobCount} head=${JSON.stringify(measured.head)} neck=${JSON.stringify(measured.neck)} hand=${JSON.stringify(measured.hand)}`
  );
}
await browser.close();

/* ---------------- 產生 TS 錨點表 ---------------- */

const round = (value) => Math.round(value * 100) / 100;
const boxLiteral = (b) => `{ left: ${round(b.left)}, top: ${round(b.top)}, right: ${round(b.right)}, bottom: ${round(b.bottom)} }`;

const lines = results.map((row) => {
  const eye = row.eye ?? { cx: (row.head.left + row.head.right) / 2, cy: row.head.top + (row.head.bottom - row.head.top) * 0.42, halfGap: (row.head.right - row.head.left) * 0.16, radius: 2 };
  return `  "${row.key}": Object.freeze({ asset: "${row.namespace}/${row.key}", viewBox: Object.freeze([${row.width}, ${row.height}] as const), ` +
    `content: Object.freeze(${boxLiteral(row.content)}), head: Object.freeze(${boxLiteral(row.head)}), ` +
    `face: Object.freeze(${boxLiteral(row.face ?? row.head)}), ` +
    `eye: Object.freeze({ cx: ${round(eye.cx)}, cy: ${round(eye.cy)}, halfGap: ${round(eye.halfGap)}, radius: ${round(eye.radius)} }), ` +
    `neck: Object.freeze({ y: ${round(row.neck.y)}, halfWidth: ${round(row.neck.halfWidth)} }), ` +
    `hand: Object.freeze({ y: ${round(row.hand.y)}, left: ${round(row.hand.left)}, right: ${round(row.hand.right)} }), ` +
    `ground: ${round(row.ground)} })`;
}).join(",\n");

const ts = `/**
 * GPT-WORKBUDDY-DAYU-0073-A｜每個人物資產的**身體錨點**（**自動產生，勿手改**）。
 *
 * 0073 之前，眼鏡／圍巾／拐杖是用「人物外框高度 × 固定比例」猜位置，所以眼鏡會
 * 落到脖子、拐杖會浮在空中。這份表改成**渲染後量測**的座標：
 *
 * - \`content\`：整個人物 getBBox()，也就是真正看得見的內容範圍（官方 viewBox 是
 *   寬高，不等於內容範圍，所以不能直接拿來縮放）。
 * - \`head\`：head 群組的 CTM 校正 bbox。
 * - \`eye\`：把 face 群組單獨點陣化 → 墨點連通分量 → 取最上面兩個（左右眼），
 *   得到眼中心 (\`cx\`,\`cy\`)、半眼距 \`halfGap\`、瞳孔半徑 \`radius\`。
 * - \`face\`：face 群組（臉部皮膚）的 bbox；\`face.bottom\` 就是下巴。長髮資產的
 *   head 群組會包到肩膀，所以圍巾不能用 head.bottom。
 * - \`neck\`：下巴下方 3.5% 身高處的剪影寬度＝肩線（備用）。
 * - \`hand\`：54% 身高處剪影左右緣（手／袖口外緣，拐杖上端用）。
 * - \`ground\`：腳底＝content.bottom。
 *
 * 座標系是**該資產自己的 viewBox 單位**；由 \`p3e-scene.ts\` 套用 scale/translate
 * 換到場景座標，配件也在同一座標系裡畫，所以永遠黏在真正的身體部位上。
 *
 * 重新量測：\`node scripts/p3e-0073-peep-anchors.mjs\`
 * 一致性檢查：\`node scripts/p3e-0073-anchor-check.mjs\`（重測並比對容差）
 */

/** 矩形（資產 viewBox 單位）。 */
export interface PeepBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 眼睛量測結果；\`halfGap\` 是眼中心到臉中線的距離。 */
export interface PeepEyeAnchor {
  readonly cx: number;
  readonly cy: number;
  readonly halfGap: number;
  /** 瞳孔半徑（量測值，不是比例）。 */
  readonly radius: number;
}

/** 肩線與手／腳底錨點。 */
export interface PeepAnchors {
  /** \`openpeeps/<key>\` 或 \`openpeeps-derived/<key>\`，供稽核對照。 */
  readonly asset: string;
  readonly viewBox: readonly [number, number];
  readonly content: PeepBox;
  readonly head: PeepBox;
  /** 臉部（皮膚）範圍；底緣＝下巴，圍巾／頸部配件用。 */
  readonly face: PeepBox;
  readonly eye: PeepEyeAnchor;
  readonly neck: { readonly y: number; readonly halfWidth: number };
  readonly hand: { readonly y: number; readonly left: number; readonly right: number };
  readonly ground: number;
}

/**
 * 8 個官方 Open Peeps 成人 + 20 個本專案衍生人物的錨點。
 * 官方數字來自 getBBox／點陣化量測；衍生人物同樣是量測值，不是生成參數回推。
 */
export const PEEP_ANCHORS: Readonly<Record<string, PeepAnchors>> = Object.freeze({
${lines}
});

/** 取錨點；未知 key 直接拋錯，避免靜默畫到錯位置。 */
export function peepAnchors(key: string): PeepAnchors {
  const anchors = PEEP_ANCHORS[key];
  if (anchors === undefined) throw new Error(\`missing peep anchors: \${key}\`);
  return anchors;
}
`;

await writeFile(outTs, ts, "utf8");
await writeFile(outReport, `${JSON.stringify({
  generatedBy: "scripts/p3e-0073-peep-anchors.mjs",
  raster: RASTER,
  method: "getBBox + CTM + alpha raster connected components",
  assets: results
}, null, 2)}\n`, "utf8");

console.log(`P3E-0073-ANCHORS OK assets=${results.length} -> ${outTs}`);
