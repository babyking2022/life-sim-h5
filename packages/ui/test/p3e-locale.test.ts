import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  P3E_DEFAULT_LOCALE,
  P3E_LOCALES,
  currentP3ELocale,
  readStoredLocale,
  setP3ELocale,
  toSimplified
} from "../src/p3e-locale";

/**
 * GPT-DEEPSEEK-0062-A：顯示層簡繁轉換與語系選擇的單元測試。
 *
 * 這裡只測「顯示層」：轉換不得影響任何 canonical 值（那個由 application 測試保證），
 * 也不引入外部字典套件。
 */

/** 驗收清單指定的常見繁體 UI 詞，轉完之後不得再出現。 */
const ACCEPTANCE_TRADITIONAL = ["開始人生", "當年訊息", "選擇重心", "資產", "關係"];

describe("GPT-0062-A 簡繁顯示轉換", () => {
  it("驗收清單的繁體 UI 詞都會被轉成簡體", () => {
    expect(toSimplified("開始人生")).toBe("开始人生");
    expect(toSimplified("當年訊息")).toBe("当年讯息");
    expect(toSimplified("選擇重心")).toBe("选择重心");
    expect(toSimplified("資產")).toBe("资产");
    expect(toSimplified("關係")).toBe("关系");
    // 「重新抽取」本身就是簡體寫法，不需要轉。
    expect(toSimplified("重新抽取")).toBe("重新抽取");
    for (const word of ACCEPTANCE_TRADITIONAL) {
      const converted = toSimplified(word);
      expect(converted).not.toBe(word === "重新抽取" ? "" : word);
      if (word !== "重新抽取") expect(converted).not.toBe(word);
    }
  });

  it("常見遊戲 UI 句子轉完後不再含這些繁體字", () => {
    const traditionalChars = ["開", "當", "選", "資", "關", "職", "學", "歷", "醫", "護", "錢", "儲", "債", "險", "齡", "髮", "戲", "網", "續", "變", "讓", "說", "讀", "聽", "覺", "願", "夢", "樂", "鄉", "農", "樹", "鳥", "貓", "雞", "龍", "鳳", "島", "灣", "語", "體", "現", "貨", "價", "購", "買", "賣", "貴", "費", "帳", "單", "稅", "獎", "補", "撫", "養", "顧", "園", "習", "試", "績", "畢", "證", "書", "碩", "論", "驗", "發", "創", "術", "攝", "繪", "畫", "譯", "編", "記", "廣", "視", "聞", "報", "紙", "雜", "誌", "銷", "務", "總", "計", "機", "漁", "廚", "潔", "築", "運", "輸", "倉", "貿", "製", "質", "檢", "裝", "採", "庫", "財", "審", "風", "問", "詢", "電", "腦", "軟", "硬", "設", "統", "維", "雲", "應", "螢", "鍵", "盤", "線", "藍", "無", "區", "媽", "爺", "孫", "兒", "親", "鄰", "婚", "離", "喪", "寵", "預", "準", "備", "載", "敗", "錯", "誤", "確"];
    const sentence = "開始人生之後，當年訊息會顯示你的職業、學歷、資產與關係，也可以選擇重心。";
    const converted = toSimplified(sentence);
    expect(converted).not.toBe(sentence);
    // 逐字檢查：句子裡實際出現的繁體字都要被轉掉。
    const stillTraditional = [...sentence].filter((char) => traditionalChars.includes(char) && converted.includes(char));
    expect(stillTraditional).toEqual([]);
  });

  it("已經沒有對應的字維持原樣（不會亂改英文、數字、標點）", () => {
    for (const input of ["P3-E 2026", "income=12,000 USD", "（ABC）", "ABC-123"]) {
      expect(toSimplified(input)).toBe(input);
    }
  });

  it("轉換是幂等的（簡體再轉一次不會變）", () => {
    const once = toSimplified("開始人生的當年訊息與資產關係");
    expect(toSimplified(once)).toBe(once);
  });
});

describe("GPT-0062-A 語系選擇", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
        setItem: (key: string, value: string) => {
          store.set(key, value);
        }
      },
      dispatchEvent: () => true,
      location: { reload: () => undefined }
    });
    vi.stubGlobal("document", {
      documentElement: { lang: "", dataset: {} as Record<string, string> },
      body: { nodeType: 1, querySelectorAll: () => [], append: () => undefined },
      createTreeWalker: () => ({ nextNode: () => null }),
      getElementById: () => null,
      createElement: () => ({
        style: {} as Record<string, string>,
        setAttribute: () => undefined,
        addEventListener: () => undefined,
        textContent: ""
      }),
      querySelector: () => null
    });
    vi.stubGlobal("Node", { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_FRAGMENT_NODE: 11 });
    vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4, SHOW_ELEMENT: 1 });
    vi.stubGlobal("CustomEvent", class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("沒有紀錄時預設 zh-CN（舊訪客一律回簡體）", () => {
    expect(P3E_DEFAULT_LOCALE).toBe("zh-CN");
    expect(readStoredLocale()).toBe("zh-CN");
    expect(P3E_LOCALES).toEqual(["zh-CN", "zh-TW"]);
  });

  it("使用者選過 zh-TW 之後會記住（重整仍是 zh-TW）", () => {
    setP3ELocale("zh-TW");
    expect(store.get("p3e.locale.v1")).toBe("zh-TW");
    expect(readStoredLocale()).toBe("zh-TW");
    expect(currentP3ELocale()).toBe("zh-TW");
  });

  it("切回 zh-CN 之後也會記住", () => {
    setP3ELocale("zh-TW");
    setP3ELocale("zh-CN");
    expect(store.get("p3e.locale.v1")).toBe("zh-CN");
    expect(readStoredLocale()).toBe("zh-CN");
  });

  it("壞值（不是合法 locale）回預設 zh-CN", () => {
    store.set("p3e.locale.v1", "fr-FR");
    expect(readStoredLocale()).toBe("zh-CN");
  });
});
