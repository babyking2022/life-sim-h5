import { deriveDomainState, Xoshiro128StarStar } from "@life-sim/engine";

/**
 * GPT-DEEPSEEK-0040-A｜泛稱事件（挫折／小確幸）的「具體變體」投影。
 *
 * ## 為什麼要有 detailId
 *
 * `ev.any.setback`／`ev.any.small-win` 的文案原本是「遇到了一次挫折」這種泛稱，
 * 玩家看不出到底發生了什麼事。這一層把「同一件事」依**人生階段**與 seed 決定性
 * 選成 32 條具體描述之一，但：
 *
 * - 只放**公開 ID**（`p3b.detail.<kind>.<stage>.<1..4>`），繁中文字只存在
 *   `fixtures/p3b/event-copy.zh-Hant.v1.json`（顯示層字典），不進 canonical state；
 * - 用**獨立 domain**（`detail`）從 `masterSeed + eventId + year + age` 推導，
 *   不消耗、也不改變正式年度 RNG；
 * - 同 seed／同 command log／save／load／replay 的 detailId 完全相同；
 * - 依年齡對應 lifeStage，**不會跨 stage**（兒童不會拿到「提案被退」）。
 *
 * ## 穩定性
 *
 * 推導種子字串固定為 `${masterSeed}|detail|${eventId}|${year}|${age}`，因此同一條命的
 * 同一個事件、同一年永遠得到同一個變體；不同 seed 會分佈到不同變體。
 */

/** detail 推導的 engine domain（與 life／events／p3e/death／partner 分離）。 */
export const P3E_DETAIL_DOMAIN = "detail";

/** detail 推導規格版本。 */
export const P3E_DETAIL_SPEC_VERSION = "p3e-detail-1.0.0";

/** 每個階段的具體變體數量。 */
export const P3E_DETAIL_VARIANTS_PER_STAGE = 4;

/** 只有這兩種泛稱事件有具體變體。 */
export const P3E_DETAIL_EVENT_KINDS: Readonly<Record<string, "setback" | "small-win">> = Object.freeze({
  "ev.any.setback": "setback",
  "ev.any.small-win": "small-win"
});

const DETAIL_KINDS = ["setback", "small-win"] as const;
const DETAIL_STAGES = ["childhood", "adolescence", "adulthood", "later_life"] as const;

type P3EDetailStage = (typeof DETAIL_STAGES)[number];

/** 所有 detailId（32 條；測試用來檢查字典完整性）。 */
export const P3E_DETAIL_IDS: readonly string[] = Object.freeze(
  DETAIL_KINDS.flatMap((kind) =>
    DETAIL_STAGES.flatMap((stage) =>
      Array.from({ length: P3E_DETAIL_VARIANTS_PER_STAGE }, (_, index) => `p3b.detail.${kind}.${stage}.${index + 1}`)
    )
  )
);

/** 依年齡取人生階段（與事件包的 lifeStages 邊界一致）。 */
export function lifeStageOfAge(age: number): P3EDetailStage {
  if (age <= 12) return "childhood";
  if (age <= 17) return "adolescence";
  if (age <= 64) return "adulthood";
  return "later_life";
}

export interface P3EDetailInput {
  readonly masterSeed: string;
  readonly eventId: string;
  readonly year: number;
  readonly age: number;
}

/**
 * 決定性選出 detailId；不是泛稱事件時回 `null`。
 *
 * @returns `p3b.detail.<kind>.<stage>.<1..4>` 或 `null`
 */
export function detailIdFor(input: P3EDetailInput): string | null {
  const kind = P3E_DETAIL_EVENT_KINDS[input.eventId];
  if (kind === undefined) return null;
  const stage = lifeStageOfAge(input.age);
  const seedText = `${input.masterSeed}|detail|${input.eventId}|${input.year}|${input.age}`;
  const state = deriveDomainState(seedText, P3E_DETAIL_DOMAIN, "1.0.0");
  const rng = new Xoshiro128StarStar([state[0], state[1], state[2], state[3]]);
  const variant = Number(rng.uniformBigInt(BigInt(P3E_DETAIL_VARIANTS_PER_STAGE))) + 1;
  return `p3b.detail.${kind}.${stage}.${variant}`;
}

/** 兼容型 type guard：detailId 的格式與變體都存在。 */
export function isP3EDetailId(value: unknown): value is string {
  return typeof value === "string" && (P3E_DETAIL_IDS as readonly string[]).includes(value);
}

/** detailId → 顯示層字典的 key（就是 detailId 本身；保留函式讓 UI 不需要知道細節）。 */
export function detailCopyKey(detailId: string): string {
  return detailId;
}
