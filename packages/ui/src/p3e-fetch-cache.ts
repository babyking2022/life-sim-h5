/**
 * GPT-WORKBUDDY-0058-B｜任務二第 4 項：所有 fixture 請求的 promise 快取／去重。
 *
 * 成功後永久快取同一個 Promise；失敗時移除快取，讓「重試」能真的重新請求，
 * 但連點／重繪／重新整理畫面都不會重複下載 2.61 MB 的 mortality。
 */
const INFLIGHT = new Map<string, Promise<unknown>>();

export function loadJsonCached(url: string): Promise<unknown> {
  const cached = INFLIGHT.get(url);
  if (cached !== undefined) return cached;
  const pending = fetch(url)
    .then(async (response): Promise<unknown> => {
      if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
      return (await response.json()) as unknown;
    })
    .catch((error: unknown) => {
      // 只清掉失敗的這一把；其他已成功的請求仍共用快取。
      INFLIGHT.delete(url);
      throw error;
    });
  INFLIGHT.set(url, pending);
  return pending;
}

/**
 * GPT-WORKBUDDY-0065-A：birth bundle 需要**原始文字**才能驗證可重現內容雜湊。
 * 與 JSON 快取分開但同樣去重：連點／重繪不會重複下載。
 */
const INFLIGHT_TEXT = new Map<string, Promise<string>>();

export function loadTextCached(url: string): Promise<string> {
  const cached = INFLIGHT_TEXT.get(url);
  if (cached !== undefined) return cached;
  const pending = fetch(url)
    .then(async (response): Promise<string> => {
      if (!response.ok) throw new Error(`bundle fetch failed: ${response.status}`);
      return await response.text();
    })
    .catch((error: unknown) => {
      INFLIGHT_TEXT.delete(url);
      throw error;
    });
  INFLIGHT_TEXT.set(url, pending);
  return pending;
}

/** 供測試／診斷觀察目前快取了幾個請求（不列舉 URL）。 */
export function jsonCacheSize(): number {
  return INFLIGHT.size;
}
