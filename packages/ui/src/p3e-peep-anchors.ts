/**
 * GPT-WORKBUDDY-DAYU-0073-A｜每個人物資產的**身體錨點**（**自動產生，勿手改**）。
 *
 * 0073 之前，眼鏡／圍巾／拐杖是用「人物外框高度 × 固定比例」猜位置，所以眼鏡會
 * 落到脖子、拐杖會浮在空中。這份表改成**渲染後量測**的座標：
 *
 * - `content`：整個人物 getBBox()，也就是真正看得見的內容範圍（官方 viewBox 是
 *   寬高，不等於內容範圍，所以不能直接拿來縮放）。
 * - `head`：head 群組的 CTM 校正 bbox。
 * - `eye`：把 face 群組單獨點陣化 → 墨點連通分量 → 取最上面兩個（左右眼），
 *   得到眼中心 (`cx`,`cy`)、半眼距 `halfGap`、瞳孔半徑 `radius`。
 * - `face`：face 群組（臉部皮膚）的 bbox；`face.bottom` 就是下巴。長髮資產的
 *   head 群組會包到肩膀，所以圍巾不能用 head.bottom。
 * - `neck`：下巴下方 3.5% 身高處的剪影寬度＝肩線（備用）。
 * - `hand`：54% 身高處剪影左右緣（手／袖口外緣，拐杖上端用）。
 * - `ground`：腳底＝content.bottom。
 *
 * 座標系是**該資產自己的 viewBox 單位**；由 `p3e-scene.ts` 套用 scale/translate
 * 換到場景座標，配件也在同一座標系裡畫，所以永遠黏在真正的身體部位上。
 *
 * 重新量測：`node scripts/p3e-0073-peep-anchors.mjs`
 * 一致性檢查：`node scripts/p3e-0073-anchor-check.mjs`（重測並比對容差）
 */

/** 矩形（資產 viewBox 單位）。 */
export interface PeepBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 眼睛量測結果；`halfGap` 是眼中心到臉中線的距離。 */
export interface PeepEyeAnchor {
  readonly cx: number;
  readonly cy: number;
  readonly halfGap: number;
  /** 瞳孔半徑（量測值，不是比例）。 */
  readonly radius: number;
}

/** 肩線與手／腳底錨點。 */
export interface PeepAnchors {
  /** `openpeeps/<key>` 或 `openpeeps-derived/<key>`，供稽核對照。 */
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
  "male-a": Object.freeze({ asset: "openpeeps/male-a", viewBox: Object.freeze([260, 674] as const), content: Object.freeze({ left: 0.25, top: 0.75, right: 259.16, bottom: 673.29 }), head: Object.freeze({ left: 97.39, top: 0.75, right: 202.16, bottom: 111.21 }), face: Object.freeze({ left: 152.49, top: 43.09, right: 200.91, bottom: 94.99 }), eye: Object.freeze({ cx: 177.31, cy: 61.53, halfGap: 14.45, radius: 8.33 }), neck: Object.freeze({ y: 134.75, halfWidth: 77.83 }), hand: Object.freeze({ y: 390.82, left: 71.5, right: 219 }), ground: 673.29 }),
  "male-b": Object.freeze({ asset: "openpeeps/male-b", viewBox: Object.freeze([213, 706] as const), content: Object.freeze({ left: 0.26, top: 0.95, right: 212.69, bottom: 705.92 }), head: Object.freeze({ left: 62.01, top: 0.95, right: 148.32, bottom: 121.61 }), face: Object.freeze({ left: 99.3, top: 58.07, right: 143.02, bottom: 103.53 }), eye: Object.freeze({ cx: 122.36, cy: 71.83, halfGap: 14.01, radius: 4.04 }), neck: Object.freeze({ y: 146.28, halfWidth: 74.25 }), hand: Object.freeze({ y: 409.83, left: 44.83, right: 181.33 }), ground: 705.92 }),
  "male-c": Object.freeze({ asset: "openpeeps/male-c", viewBox: Object.freeze([198, 669] as const), content: Object.freeze({ left: 0.36, top: 0.69, right: 197.39, bottom: 668.86 }), head: Object.freeze({ left: 62.83, top: 0.69, right: 151.4, bottom: 109.95 }), face: Object.freeze({ left: 101.3, top: 44.07, right: 145.02, bottom: 89.53 }), eye: Object.freeze({ cx: 124.36, cy: 57.83, halfGap: 14.01, radius: 4.04 }), neck: Object.freeze({ y: 133.34, halfWidth: 69.92 }), hand: Object.freeze({ y: 388.23, left: 60.83, right: 166.5 }), ground: 668.86 }),
  "male-d": Object.freeze({ asset: "openpeeps/male-d", viewBox: Object.freeze([256, 679] as const), content: Object.freeze({ left: 0.68, top: 0.07, right: 255.88, bottom: 678.29 }), head: Object.freeze({ left: 115.64, top: 0.07, right: 206.57, bottom: 103.91 }), face: Object.freeze({ left: 155.3, top: 41.07, right: 199.02, bottom: 86.53 }), eye: Object.freeze({ cx: 178.36, cy: 54.83, halfGap: 14.01, radius: 4.04 }), neck: Object.freeze({ y: 127.65, halfWidth: 77.5 }), hand: Object.freeze({ y: 393.44, left: 88.67, right: 235.83 }), ground: 678.29 }),
  "female-a": Object.freeze({ asset: "openpeeps/female-a", viewBox: Object.freeze([304, 680] as const), content: Object.freeze({ left: 0.84, top: 0.43, right: 303.39, bottom: 679.81 }), head: Object.freeze({ left: 56.66, top: 0.43, right: 161.55, bottom: 148.94 }), face: Object.freeze({ left: 106.3, top: 48.07, right: 150.02, bottom: 93.53 }), eye: Object.freeze({ cx: 129.36, cy: 61.83, halfGap: 14.01, radius: 4.04 }), neck: Object.freeze({ y: 172.72, halfWidth: 87 }), hand: Object.freeze({ y: 394.47, left: 37, right: 192.83 }), ground: 679.81 }),
  "female-b": Object.freeze({ asset: "openpeeps/female-b", viewBox: Object.freeze([249, 672] as const), content: Object.freeze({ left: -0.01, top: 0.21, right: 248.5, bottom: 671.31 }), head: Object.freeze({ left: 56.76, top: 0.21, right: 198.95, bottom: 158.83 }), face: Object.freeze({ left: 127.3, top: 49.07, right: 171.02, bottom: 94.53 }), eye: Object.freeze({ cx: 150.36, cy: 62.83, halfGap: 14.01, radius: 4.04 }), neck: Object.freeze({ y: 182.32, halfWidth: 98.25 }), hand: Object.freeze({ y: 389.45, left: 75, right: 203.17 }), ground: 671.31 }),
  "female-c": Object.freeze({ asset: "openpeeps/female-c", viewBox: Object.freeze([304, 681] as const), content: Object.freeze({ left: 0.84, top: 0.21, right: 303.39, bottom: 680.99 }), head: Object.freeze({ left: 35.76, top: 0.21, right: 177.95, bottom: 158.83 }), face: Object.freeze({ left: 108.43, top: 50.48, right: 151.52, bottom: 103.3 }), eye: Object.freeze({ cx: 130.47, cy: 65.41, halfGap: 13.26, radius: 4.75 }), neck: Object.freeze({ y: 182.66, halfWidth: 87.92 }), hand: Object.freeze({ y: 395.06, left: 37, right: 193.33 }), ground: 680.99 }),
  "female-d": Object.freeze({ asset: "openpeeps/female-d", viewBox: Object.freeze([246, 713] as const), content: Object.freeze({ left: 0.1, top: 0.22, right: 245.79, bottom: 712.5 }), head: Object.freeze({ left: 43.33, top: 0.22, right: 217.46, bottom: 153.8 }), face: Object.freeze({ left: 129.3, top: 85.07, right: 173.02, bottom: 130.53 }), eye: Object.freeze({ cx: 152.36, cy: 98.83, halfGap: 14.01, radius: 4.04 }), neck: Object.freeze({ y: 178.73, halfWidth: 73.75 }), hand: Object.freeze({ y: 413.34, left: 53.67, right: 207.67 }), ground: 712.5 }),
  "baby-a": Object.freeze({ asset: "derived/baby-a", viewBox: Object.freeze([150, 170] as const), content: Object.freeze({ left: 12, top: -5.9, right: 138, bottom: 162 }), head: Object.freeze({ left: 24, top: -5.9, right: 126, bottom: 96 }), face: Object.freeze({ left: 40.2, top: 49.6, right: 109.8, bottom: 71.75 }), eye: Object.freeze({ cx: 74.92, cy: 52.82, halfGap: 15, radius: 3.25 }), neck: Object.freeze({ y: 101.88, halfWidth: 43.25 }), hand: Object.freeze({ y: 91.48, left: 33.5, right: 116.33 }), ground: 162 }),
  "baby-b": Object.freeze({ asset: "derived/baby-b", viewBox: Object.freeze([150, 170] as const), content: Object.freeze({ left: 12, top: 0.08, right: 138, bottom: 162 }), head: Object.freeze({ left: 23.1, top: 0.08, right: 126.9, bottom: 96 }), face: Object.freeze({ left: 40.2, top: 49.6, right: 109.8, bottom: 71.75 }), eye: Object.freeze({ cx: 74.92, cy: 52.82, halfGap: 15, radius: 3.25 }), neck: Object.freeze({ y: 101.67, halfWidth: 43.25 }), hand: Object.freeze({ y: 93.99, left: 33, right: 116.83 }), ground: 162 }),
  "baby-c": Object.freeze({ asset: "derived/baby-c", viewBox: Object.freeze([150, 170] as const), content: Object.freeze({ left: 12, top: 2.7, right: 138, bottom: 162 }), head: Object.freeze({ left: 24, top: 2.7, right: 126, bottom: 96 }), face: Object.freeze({ left: 40.2, top: 49.6, right: 109.8, bottom: 71.75 }), eye: Object.freeze({ cx: 74.92, cy: 52.82, halfGap: 15, radius: 3.25 }), neck: Object.freeze({ y: 101.58, halfWidth: 43.25 }), hand: Object.freeze({ y: 95.09, left: 32.83, right: 117 }), ground: 162 }),
  "baby-d": Object.freeze({ asset: "derived/baby-d", viewBox: Object.freeze([150, 170] as const), content: Object.freeze({ left: 12, top: 0.3, right: 138, bottom: 162 }), head: Object.freeze({ left: 24, top: 0.3, right: 126, bottom: 96 }), face: Object.freeze({ left: 40.2, top: 49.6, right: 109.8, bottom: 71.75 }), eye: Object.freeze({ cx: 74.92, cy: 52.82, halfGap: 15, radius: 3.25 }), neck: Object.freeze({ y: 101.66, halfWidth: 43.25 }), hand: Object.freeze({ y: 94.09, left: 33, right: 116.83 }), ground: 162 }),
  "child-a": Object.freeze({ asset: "derived/child-a", viewBox: Object.freeze([150, 210] as const), content: Object.freeze({ left: 26.7, top: -4.5, right: 123.3, bottom: 205 }), head: Object.freeze({ left: 33.2, top: -4.5, right: 116.8, bottom: 80 }), face: Object.freeze({ left: 46.6, top: 42, right: 103.4, bottom: 60.25 }), eye: Object.freeze({ cx: 74.91, cy: 44.62, halfGap: 12.2, radius: 2.67 }), neck: Object.freeze({ y: 87.33, halfWidth: 46.08 }), hand: Object.freeze({ y: 117.01, left: 24.33, right: 125.5 }), ground: 205 }),
  "child-b": Object.freeze({ asset: "derived/child-b", viewBox: Object.freeze([150, 210] as const), content: Object.freeze({ left: 26.7, top: 1.49, right: 123.3, bottom: 205 }), head: Object.freeze({ left: 32.5, top: 1.49, right: 117.5, bottom: 80 }), face: Object.freeze({ left: 46.6, top: 42, right: 103.4, bottom: 60.25 }), eye: Object.freeze({ cx: 74.91, cy: 44.62, halfGap: 12.2, radius: 2.67 }), neck: Object.freeze({ y: 87.12, halfWidth: 46.08 }), hand: Object.freeze({ y: 119.53, left: 24.33, right: 125.5 }), ground: 205 }),
  "child-c": Object.freeze({ asset: "derived/child-c", viewBox: Object.freeze([150, 210] as const), content: Object.freeze({ left: 26.7, top: 3.7, right: 123.3, bottom: 205 }), head: Object.freeze({ left: 33.2, top: 3.7, right: 116.8, bottom: 80 }), face: Object.freeze({ left: 46.6, top: 42, right: 103.4, bottom: 60.25 }), eye: Object.freeze({ cx: 74.91, cy: 44.62, halfGap: 12.2, radius: 2.67 }), neck: Object.freeze({ y: 87.05, halfWidth: 46.08 }), hand: Object.freeze({ y: 120.45, left: 24.33, right: 125.5 }), ground: 205 }),
  "child-d": Object.freeze({ asset: "derived/child-d", viewBox: Object.freeze([150, 210] as const), content: Object.freeze({ left: 26.7, top: 2.1, right: 123.3, bottom: 205 }), head: Object.freeze({ left: 33.2, top: 2.1, right: 116.8, bottom: 80 }), face: Object.freeze({ left: 46.6, top: 42, right: 103.4, bottom: 60.25 }), eye: Object.freeze({ cx: 74.91, cy: 44.62, halfGap: 12.2, radius: 2.67 }), neck: Object.freeze({ y: 87.1, halfWidth: 46.08 }), hand: Object.freeze({ y: 119.78, left: 24.33, right: 125.5 }), ground: 205 }),
  "primary-a": Object.freeze({ asset: "derived/primary-a", viewBox: Object.freeze([130, 240] as const), content: Object.freeze({ left: 22.5, top: -4.2, right: 107.5, bottom: 235 }), head: Object.freeze({ left: 31.4, top: -4.2, right: 98.6, bottom: 65 }), face: Object.freeze({ left: 42.1, top: 34.4, right: 87.9, bottom: 49 }), eye: Object.freeze({ cx: 64.92, cy: 36.53, halfGap: 9.9, radius: 2.17 }), neck: Object.freeze({ y: 73.37, halfWidth: 40.08 }), hand: Object.freeze({ y: 134.54, left: 20.83, right: 109 }), ground: 235 }),
  "primary-b": Object.freeze({ asset: "derived/primary-b", viewBox: Object.freeze([130, 240] as const), content: Object.freeze({ left: 22.5, top: 1.79, right: 107.5, bottom: 235 }), head: Object.freeze({ left: 30.8, top: 1.79, right: 99.2, bottom: 65 }), face: Object.freeze({ left: 42.1, top: 34.4, right: 87.9, bottom: 49 }), eye: Object.freeze({ cx: 64.92, cy: 36.53, halfGap: 9.9, radius: 2.17 }), neck: Object.freeze({ y: 73.16, halfWidth: 40.08 }), hand: Object.freeze({ y: 137.05, left: 21, right: 108.83 }), ground: 235 }),
  "primary-c": Object.freeze({ asset: "derived/primary-c", viewBox: Object.freeze([130, 240] as const), content: Object.freeze({ left: 22.5, top: 3.5, right: 107.5, bottom: 235 }), head: Object.freeze({ left: 31.4, top: 3.5, right: 98.6, bottom: 65 }), face: Object.freeze({ left: 42.1, top: 34.4, right: 87.9, bottom: 49 }), eye: Object.freeze({ cx: 64.92, cy: 36.53, halfGap: 9.9, radius: 2.17 }), neck: Object.freeze({ y: 73.1, halfWidth: 40.08 }), hand: Object.freeze({ y: 137.77, left: 21, right: 108.83 }), ground: 235 }),
  "primary-d": Object.freeze({ asset: "derived/primary-d", viewBox: Object.freeze([130, 240] as const), content: Object.freeze({ left: 22.5, top: 2.6, right: 107.5, bottom: 235 }), head: Object.freeze({ left: 31.4, top: 2.6, right: 98.6, bottom: 65 }), face: Object.freeze({ left: 42.1, top: 34.4, right: 87.9, bottom: 49 }), eye: Object.freeze({ cx: 64.92, cy: 36.53, halfGap: 9.9, radius: 2.17 }), neck: Object.freeze({ y: 73.13, halfWidth: 40.08 }), hand: Object.freeze({ y: 137.39, left: 21, right: 108.83 }), ground: 235 }),
  "teen-a": Object.freeze({ asset: "derived/teen-a", viewBox: Object.freeze([120, 260] as const), content: Object.freeze({ left: 20, top: -4.5, right: 100, bottom: 255 }), head: Object.freeze({ left: 31, top: -4.5, right: 89, bottom: 56 }), face: Object.freeze({ left: 40.2, top: 29.5, right: 79.8, bottom: 42.25 }), eye: Object.freeze({ cx: 59.92, cy: 31.43, halfGap: 8.5, radius: 1.92 }), neck: Object.freeze({ y: 65.08, halfWidth: 37.58 }), hand: Object.freeze({ y: 146.01, left: 18.83, right: 101 }), ground: 255 }),
  "teen-b": Object.freeze({ asset: "derived/teen-b", viewBox: Object.freeze([120, 260] as const), content: Object.freeze({ left: 20, top: 1.49, right: 100, bottom: 255 }), head: Object.freeze({ left: 30.5, top: 1.49, right: 89.5, bottom: 56 }), face: Object.freeze({ left: 40.2, top: 29.5, right: 79.8, bottom: 42.25 }), eye: Object.freeze({ cx: 59.92, cy: 31.43, halfGap: 8.5, radius: 1.92 }), neck: Object.freeze({ y: 64.87, halfWidth: 37.58 }), hand: Object.freeze({ y: 148.53, left: 18.67, right: 101.17 }), ground: 255 }),
  "teen-c": Object.freeze({ asset: "derived/teen-c", viewBox: Object.freeze([120, 260] as const), content: Object.freeze({ left: 20, top: 3, right: 100, bottom: 255 }), head: Object.freeze({ left: 31, top: 3, right: 89, bottom: 56 }), face: Object.freeze({ left: 40.2, top: 29.5, right: 79.8, bottom: 42.25 }), eye: Object.freeze({ cx: 59.92, cy: 31.43, halfGap: 8.5, radius: 1.92 }), neck: Object.freeze({ y: 64.82, halfWidth: 37.58 }), hand: Object.freeze({ y: 149.16, left: 18.5, right: 101.33 }), ground: 255 }),
  "teen-d": Object.freeze({ asset: "derived/teen-d", viewBox: Object.freeze([120, 260] as const), content: Object.freeze({ left: 20, top: 2.5, right: 100, bottom: 255 }), head: Object.freeze({ left: 31, top: 2.5, right: 89, bottom: 56 }), face: Object.freeze({ left: 40.2, top: 29.5, right: 79.8, bottom: 42.25 }), eye: Object.freeze({ cx: 59.92, cy: 31.43, halfGap: 8.5, radius: 1.92 }), neck: Object.freeze({ y: 64.84, halfWidth: 37.58 }), hand: Object.freeze({ y: 148.95, left: 18.5, right: 101.33 }), ground: 255 }),
  "university-a": Object.freeze({ asset: "derived/university-a", viewBox: Object.freeze([118, 270] as const), content: Object.freeze({ left: 16, top: -4.1, right: 98, bottom: 265 }), head: Object.freeze({ left: 32.3, top: -4.1, right: 85.7, bottom: 52 }), face: Object.freeze({ left: 40.8, top: 27.5, right: 77.2, bottom: 39.35 }), eye: Object.freeze({ cx: 58.92, cy: 29.42, halfGap: 7.8, radius: 1.92 }), neck: Object.freeze({ y: 61.42, halfWidth: 37.83 }), hand: Object.freeze({ y: 151.98, left: 18.5, right: 99.33 }), ground: 265 }),
  "university-b": Object.freeze({ asset: "derived/university-b", viewBox: Object.freeze([118, 270] as const), content: Object.freeze({ left: 16, top: 1.79, right: 98, bottom: 265 }), head: Object.freeze({ left: 31.9, top: 1.79, right: 86.1, bottom: 52 }), face: Object.freeze({ left: 40.8, top: 27.5, right: 77.2, bottom: 39.35 }), eye: Object.freeze({ cx: 58.92, cy: 29.42, halfGap: 7.8, radius: 1.92 }), neck: Object.freeze({ y: 61.21, halfWidth: 37.25 }), hand: Object.freeze({ y: 154.45, left: 19, right: 98.83 }), ground: 265 }),
  "university-c": Object.freeze({ asset: "derived/university-c", viewBox: Object.freeze([118, 270] as const), content: Object.freeze({ left: 16, top: 3.2, right: 98, bottom: 265 }), head: Object.freeze({ left: 32.3, top: 3.2, right: 85.7, bottom: 52 }), face: Object.freeze({ left: 40.8, top: 27.5, right: 77.2, bottom: 39.35 }), eye: Object.freeze({ cx: 58.92, cy: 29.42, halfGap: 7.8, radius: 1.92 }), neck: Object.freeze({ y: 61.16, halfWidth: 37.25 }), hand: Object.freeze({ y: 155.04, left: 19.33, right: 98.5 }), ground: 265 }),
  "university-d": Object.freeze({ asset: "derived/university-d", viewBox: Object.freeze([118, 270] as const), content: Object.freeze({ left: 16, top: 2.9, right: 98, bottom: 265 }), head: Object.freeze({ left: 32.3, top: 2.9, right: 85.7, bottom: 52 }), face: Object.freeze({ left: 40.8, top: 27.5, right: 77.2, bottom: 39.35 }), eye: Object.freeze({ cx: 58.92, cy: 29.42, halfGap: 7.8, radius: 1.92 }), neck: Object.freeze({ y: 61.17, halfWidth: 37.25 }), hand: Object.freeze({ y: 154.92, left: 19.33, right: 98.5 }), ground: 265 })
});

/** 取錨點；未知 key 直接拋錯，避免靜默畫到錯位置。 */
export function peepAnchors(key: string): PeepAnchors {
  const anchors = PEEP_ANCHORS[key];
  if (anchors === undefined) throw new Error(`missing peep anchors: ${key}`);
  return anchors;
}
