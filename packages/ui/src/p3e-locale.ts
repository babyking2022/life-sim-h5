/**
 * GPT-DEEPSEEK-0062-A｜顯示層語系（預設 zh-CN，可切回 zh-TW）。
 *
 * ## 為什麼是「顯示層轉換」而不是雙份字典
 *
 * 遊戲的事件文案、國家名稱、職業名稱本來就有一份 zh-Hant 資產
 * （`event-copy.zh-Hant.v1.json`、`p3e-country-hant.ts`），UI chrome 也全部是
 * 繁體字串。硬要維護兩份完整字典，等於把 128 KB 的 UI 文案抄一次，維護成本高、
 * 也容易漏字。
 *
 * 這一層的做法是：
 *
 * 1. **原始字串不動**（zh-Hant 仍是 canonical 顯示來源，seed／存檔／hash 完全不變）；
 * 2. 當 locale 是 `zh-CN` 時，在**寫進 DOM 之後**把可見文字轉成簡體：
 *    - 先套「詞組表」（`重新抽取` 這種同字詞不需要，但 `當年訊息`、`選擇重心` 這種要），
 *    - 再套「單字表」（高信心的一對一簡繁對應）；
 * 3. 每個被轉換的文字節點都記住原文，切回 `zh-TW` 時可以**就地還原**，不必重載頁面、
 *    也不會重抽 seed；
 * 4. 用 `MutationObserver` 掛在 `#app` 上，任何一次 re-render 產生的新文字都會被轉換，
 *    UI 不需要為了語系改動 render 流程。
 *
 * ## 邊界
 *
 * - 只轉「文字節點」與 input 的 placeholder／button 的 textContent，不碰屬性裡的 key、
 *   不碰 `data-*`、不碰任何送進引擎或存檔的值；
 * - 詞組表／單字表都是純資料、沒有外部依賴，gzip 後不到 3 KB；
 * - 沒有明確選擇紀錄的訪客一律 `zh-CN`（舊版沒有語言設定，因此回預設值）。
 */

export type P3ELocale = "zh-CN" | "zh-TW";

export const P3E_LOCALES: readonly P3ELocale[] = Object.freeze(["zh-CN", "zh-TW"]);

/** 預設語系：使用者要求首次打開就是簡體中文。 */
export const P3E_DEFAULT_LOCALE: P3ELocale = "zh-CN";

/** 只有「使用者明確選過」才會寫入；沒有紀錄 = 預設值。 */
const STORAGE_KEY = "p3e.locale.v1";

/**
 * 詞組表：優先於單字表，處理「字對字轉換會錯」或「整詞更自然」的情況。
 * key 是繁體寫法（原始字串），value 是簡體寫法。
 */
const PHRASES: Readonly<Record<string, string>> = Object.freeze({
  "當年訊息": "当年讯息",
  "選擇重心": "选择重心",
  "重新抽取": "重新抽取",
  "開始人生": "开始人生",
  "準備人生": "准备人生",
  "繼續人生": "继续人生",
  "重新開始": "重新开始",
  "收入與資產比較估算": "收入与资产比较估算",
  "資產": "资产",
  "年收入": "年收入",
  "關係": "关系",
  "伴侶": "伴侣",
  "配偶": "配偶",
  "職業": "职业",
  "學歷": "学历",
  "決策": "决策",
  "選項": "选项",
  "死亡": "死亡",
  "重生": "重生",
  "存檔": "存档",
  "讀檔": "读档",
  "設定": "设定",
  "音效": "音效",
  "語言": "语言",
  "繁體中文": "繁体中文",
  "簡體中文": "简体中文",
  "出生": "出生",
  "家庭": "家庭",
  "工作": "工作",
  "地圖": "地图",
  "人生": "人生",
  "焦點": "焦点",
  "知識": "知识",
  "健康": "健康",
  "幸福": "幸福",
  "心情": "心情",
  "事件": "事件",
  "訊息": "讯息",
  "紀錄": "纪录",
  "統計": "统计",
  "設定焦點": "设定焦点",
  "更改": "更改",
  "取消": "取消",
  "確定": "确定",
  "載入中": "载入中",
  "載入": "载入",
  "失敗": "失败",
  "錯誤": "错误",
  "重試": "重试",
  "關閉": "关闭",
  "開啟": "开启",
  "返回": "返回",
  "上一頁": "上一页",
  "下一頁": "下一页"
});

/**
 * 單字表：高信心的一對一簡繁對應（只收 UI 會出現的字）。
 *
 * 寫成「一對一」陣列而不是兩條長字串，避免字串長度對不齊造成**整段錯位**
 * （那會把中文換成別的字，比不換更糟）。載入時檢查每個 key 都是一個字。
 */
const CHAR_PAIRS: readonly (readonly [string, string])[] = Object.freeze([
  // GPT-WORKBUDDY-0064-B 最小修復：獨立驗收在 zh-CN 國名實測到簡繁混合
  // （「波士尼亞與赫塞哥維納」→「…尼亞與…維納」）。補齊這幾個高信心
  // 一對一字；只影響顯示層，不碰 seed／certificate／identity hash／事件資料。
  ["亞", "亚"],
  ["與", "与"],
  ["納", "纳"],
  ["臺", "台"],
  ["嬰", "婴"],
  ["暫", "暂"],
  ["擁", "拥"],
  ["際", "际"],
  ["韓", "韩"],
  ["國", "国"],
  ["傳", "传"],
  ["統", "统"],
  ["裡", "里"],
  ["壽", "寿"],
  ["張", "张"],
  ["紙", "纸"],
  ["糊", "糊"],
  ["歲", "岁"],
  ["齡", "龄"],
  ["產", "产"],
  ["業", "业"],
  ["關", "关"],
  ["係", "系"],
  ["職", "职"],
  ["學", "学"],
  ["選", "选"],
  ["擇", "择"],
  ["訊", "讯"],
  ["續", "续"],
  ["開", "开"],
  ["當", "当"],
  ["資", "资"],
  ["紀", "纪"],
  ["錄", "录"],
  ["價", "价"],
  ["錢", "钱"],
  ["賺", "赚"],
  ["虧", "亏"],
  ["債", "债"],
  ["貸", "贷"],
  ["儲", "储"],
  ["險", "险"],
  ["稅", "税"],
  ["獎", "奖"],
  ["補", "补"],
  ["貼", "贴"],
  ["費", "费"],
  ["帳", "账"],
  ["單", "单"],
  ["發", "发"],
  ["票", "票"],
  ["購", "购"],
  ["買", "买"],
  ["賣", "卖"],
  ["貴", "贵"],
  ["價", "价"],
  ["總", "总"],
  ["額", "额"],
  ["淨", "净"],
  ["負", "负"],
  ["債", "债"],
  ["損", "损"],
  ["益", "益"],
  ["報", "报"],
  ["酬", "酬"],
  ["薪", "薪"],
  ["俸", "俸"],
  ["獎", "奖"],
  ["金", "金"],
  ["撫", "抚"],
  ["養", "养"],
  ["顧", "顾"],
  ["嬰", "婴"],
  ["兒", "儿"],
  ["幼", "幼"],
  ["園", "园"],
  ["學", "学"],
  ["齡", "龄"],
  ["畢", "毕"],
  ["業", "业"],
  ["證", "证"],
  ["書", "书"],
  ["碩", "硕"],
  ["博", "博"],
  ["論", "论"],
  ["實", "实"],
  ["驗", "验"],
  ["研", "研"],
  ["究", "究"],
  ["發", "发"],
  ["專", "专"],
  ["利", "利"],
  ["創", "创"],
  ["藝", "艺"],
  ["術", "术"],
  ["攝", "摄"],
  ["影", "影"],
  ["繪", "绘"],
  ["畫", "画"],
  ["書", "书"],
  ["法", "法"],
  ["寫", "写"],
  ["作", "作"],
  ["翻", "翻"],
  ["譯", "译"],
  ["編", "编"],
  ["輯", "辑"],
  ["記", "记"],
  ["者", "者"],
  ["廣", "广"],
  ["播", "播"],
  ["電", "电"],
  ["視", "视"],
  ["新", "新"],
  ["聞", "闻"],
  ["報", "报"],
  ["紙", "纸"],
  ["雜", "杂"],
  ["誌", "志"],
  ["廣", "广"],
  ["告", "告"],
  ["行", "行"],
  ["銷", "销"],
  ["業", "业"],
  ["務", "务"],
  ["經", "经"],
  ["理", "理"],
  ["董", "董"],
  ["事", "事"],
  ["總", "总"],
  ["裁", "裁"],
  ["秘", "秘"],
  ["書", "书"],
  ["助", "助"],
  ["理", "理"],
  ["會", "会"],
  ["計", "计"],
  ["師", "师"],
  ["律", "律"],
  ["師", "师"],
  ["法", "法"],
  ["官", "官"],
  ["警", "警"],
  ["察", "察"],
  ["消", "消"],
  ["防", "防"],
  ["軍", "军"],
  ["人", "人"],
  ["公", "公"],
  ["務", "务"],
  ["員", "员"],
  ["工", "工"],
  ["程", "程"],
  ["師", "师"],
  ["技", "技"],
  ["術", "术"],
  ["員", "员"],
  ["操", "操"],
  ["作", "作"],
  ["員", "员"],
  ["司", "司"],
  ["機", "机"],
  ["農", "农"],
  ["夫", "夫"],
  ["漁", "渔"],
  ["夫", "夫"],
  ["廚", "厨"],
  ["師", "师"],
  ["服", "服"],
  ["務", "务"],
  ["員", "员"],
  ["店", "店"],
  ["員", "员"],
  ["保", "保"],
  ["全", "全"],
  ["清", "清"],
  ["潔", "洁"],
  ["工", "工"],
  ["建", "建"],
  ["築", "筑"],
  ["工", "工"],
  ["地", "地"],
  ["運", "运"],
  ["輸", "输"],
  ["倉", "仓"],
  ["儲", "储"],
  ["批", "批"],
  ["發", "发"],
  ["零", "零"],
  ["售", "售"],
  ["進", "进"],
  ["出", "出"],
  ["口", "口"],
  ["貿", "贸"],
  ["易", "易"],
  ["製", "制"],
  ["造", "造"],
  ["加", "加"],
  ["工", "工"],
  ["生", "生"],
  ["產", "产"],
  ["品", "品"],
  ["質", "质"],
  ["檢", "检"],
  ["驗", "验"],
  ["包", "包"],
  ["裝", "装"],
  ["物", "物"],
  ["流", "流"],
  ["採", "采"],
  ["購", "购"],
  ["庫", "库"],
  ["存", "存"],
  ["財", "财"],
  ["務", "务"],
  ["審", "审"],
  ["計", "计"],
  ["風", "风"],
  ["險", "险"],
  ["管", "管"],
  ["理", "理"],
  ["顧", "顾"],
  ["問", "问"],
  ["諮", "咨"],
  ["詢", "询"],
  ["訊", "讯"],
  ["科", "科"],
  ["技", "技"],
  ["電", "电"],
  ["腦", "脑"],
  ["軟", "软"],
  ["體", "体"],
  ["硬", "硬"],
  ["網", "网"],
  ["路", "路"],
  ["資", "资"],
  ["料", "料"],
  ["庫", "库"],
  ["程", "程"],
  ["式", "式"],
  ["設", "设"],
  ["計", "计"],
  ["演", "演"],
  ["算", "算"],
  ["法", "法"],
  ["系", "系"],
  ["統", "统"],
  ["維", "维"],
  ["護", "护"],
  ["安", "安"],
  ["全", "全"],
  ["加", "加"],
  ["密", "密"],
  ["伺", "伺"],
  ["服", "服"],
  ["器", "器"],
  ["雲", "云"],
  ["端", "端"],
  ["平", "平"],
  ["台", "台"],
  ["應", "应"],
  ["用", "用"],
  ["程", "程"],
  ["式", "式"],
  ["手", "手"],
  ["機", "机"],
  ["平", "平"],
  ["板", "板"],
  ["螢", "荧"],
  ["幕", "幕"],
  ["鍵", "键"],
  ["盤", "盘"],
  ["滑", "滑"],
  ["鼠", "鼠"],
  ["電", "电"],
  ["池", "池"],
  ["充", "充"],
  ["電", "电"],
  ["訊", "讯"],
  ["號", "号"],
  ["連", "连"],
  ["線", "线"],
  ["藍", "蓝"],
  ["牙", "牙"],
  ["無", "无"],
  ["線", "线"],
  ["區", "区"],
  ["域", "域"],
  ["網", "网"],
  ["路", "路"],
  ["暫", "暂"],
  ["停", "停"],
  ["繼", "继"],
  ["續", "续"],
  ["暫", "暂"],
  ["無", "无"],
  ["法", "法"],
  ["擁", "拥"],
  ["有", "有"],
  ["個", "个"],
  ["人", "人"],
  ["資", "资"],
  ["產", "产"],
  ["收", "收"],
  ["入", "入"],
  ["未", "未"],
  ["成", "成"],
  ["年", "年"],
  ["估", "估"],
  ["算", "算"],
  ["南", "南"],
  ["韓", "韩"],
  ["情", "情"],
  ["感", "感"],
  ["狀", "状"],
  ["態", "态"],
  ["單", "单"],
  ["身", "身"],
  ["紀", "纪"],
  ["錄", "录"],
  ["健", "健"],
  ["康", "康"],
  ["幸", "幸"],
  ["福", "福"],
  ["知", "知"],
  ["識", "识"],
  ["人", "人"],
  ["際", "际"],
  ["暫", "暂"],
  ["停", "停"],
  ["下", "下"],
  ["一", "一"],
  ["個", "个"],
  ["決", "决"],
  ["定", "定"],
  ["下", "下"],
  ["一", "一"],
  ["步", "步"],
  ["傳", "传"],
  ["統", "统"],
  ["裡", "里"],
  ["對", "对"],
  ["壽", "寿"],
  ["國", "国"],
  ["際", "际"],
  ["間", "间"],
  ["個", "个"],
  ["們", "们"],
  ["來", "来"],
  ["後", "后"],
  ["這", "这"],
  ["會", "会"],
  ["時", "时"],
  ["說", "说"],
  ["對", "对"],
  ["開", "开"],
  ["關", "关"],
  ["點", "点"],
  ["麼", "么"],
  ["樣", "样"],
  ["實", "实"],
  ["學", "学"],
  ["經", "经"],
  ["歷", "历"],
  ["產", "产"],
  ["資", "资"],
  ["係", "系"],
  ["選", "选"],
  ["擇", "择"],
  ["當", "当"],
  ["訊", "讯"],
  ["戲", "戏"],
  ["職", "职"],
  ["業", "业"],
  ["醫", "医"],
  ["護", "护"],
  ["師", "师"],
  ["頭", "头"],
  ["髮", "发"],
  ["齡", "龄"],
  ["歲", "岁"],
  ["錢", "钱"],
  ["銀", "银"],
  ["額", "额"],
  ["賺", "赚"],
  ["虧", "亏"],
  ["損", "损"],
  ["營", "营"],
  ["銷", "销"],
  ["網", "网"],
  ["絡", "络"],
  ["連", "连"],
  ["續", "续"],
  ["斷", "断"],
  ["變", "变"],
  ["讓", "让"],
  ["話", "话"],
  ["語", "语"],
  ["讀", "读"],
  ["寫", "写"],
  ["聽", "听"],
  ["覺", "觉"],
  ["觀", "观"],
  ["願", "愿"],
  ["夢", "梦"],
  ["樂", "乐"],
  ["興", "兴"],
  ["鄉", "乡"],
  ["鎮", "镇"],
  ["縣", "县"],
  ["農", "农"],
  ["樹", "树"],
  ["葉", "叶"],
  ["鳥", "鸟"],
  ["貓", "猫"],
  ["雞", "鸡"],
  ["龍", "龙"],
  ["鳳", "凤"],
  ["島", "岛"],
  ["灣", "湾"],
  ["體", "体"],
  ["現", "现"],
  ["貨", "货"],
  ["價", "价"],
  ["購", "购"],
  ["買", "买"],
  ["賣", "卖"],
  ["貴", "贵"],
  ["費", "费"],
  ["帳", "账"],
  ["單", "单"],
  ["稅", "税"],
  ["薪", "薪"],
  ["獎", "奖"],
  ["補", "补"],
  ["退", "退"],
  ["撫", "抚"],
  ["養", "养"],
  ["顧", "顾"],
  ["幼", "幼"],
  ["園", "园"],
  ["習", "习"],
  ["試", "试"],
  ["績", "绩"],
  ["畢", "毕"],
  ["證", "证"],
  ["書", "书"],
  ["碩", "硕"],
  ["博", "博"],
  ["論", "论"],
  ["驗", "验"],
  ["發", "发"],
  ["創", "创"],
  ["術", "术"],
  ["攝", "摄"],
  ["繪", "绘"],
  ["畫", "画"],
  ["譯", "译"],
  ["編", "编"],
  ["記", "记"],
  ["廣", "广"],
  ["播", "播"],
  ["視", "视"],
  ["聞", "闻"],
  ["報", "报"],
  ["紙", "纸"],
  ["雜", "杂"],
  ["誌", "志"],
  ["告", "告"],
  ["務", "务"],
  ["理", "理"],
  ["董", "董"],
  ["總", "总"],
  ["裁", "裁"],
  ["秘", "秘"],
  ["助", "助"],
  ["計", "计"],
  ["律", "律"],
  ["法", "法"],
  ["警", "警"],
  ["察", "察"],
  ["消", "消"],
  ["防", "防"],
  ["軍", "军"],
  ["公", "公"],
  ["員", "员"],
  ["程", "程"],
  ["技", "技"],
  ["操", "操"],
  ["司", "司"],
  ["機", "机"],
  ["漁", "渔"],
  ["廚", "厨"],
  ["服", "服"],
  ["店", "店"],
  ["保", "保"],
  ["全", "全"],
  ["潔", "洁"],
  ["工", "工"],
  ["築", "筑"],
  ["運", "运"],
  ["輸", "输"],
  ["倉", "仓"],
  ["儲", "储"],
  ["批", "批"],
  ["零", "零"],
  ["售", "售"],
  ["進", "进"],
  ["出", "出"],
  ["口", "口"],
  ["貿", "贸"],
  ["易", "易"],
  ["製", "制"],
  ["造", "造"],
  ["加", "加"],
  ["生", "生"],
  ["品", "品"],
  ["質", "质"],
  ["檢", "检"],
  ["包", "包"],
  ["裝", "装"],
  ["物", "物"],
  ["流", "流"],
  ["採", "采"],
  ["庫", "库"],
  ["存", "存"],
  ["財", "财"],
  ["審", "审"],
  ["風", "风"],
  ["險", "险"],
  ["管", "管"],
  ["問", "问"],
  ["諮", "咨"],
  ["詢", "询"],
  ["科", "科"],
  ["電", "电"],
  ["腦", "脑"],
  ["軟", "软"],
  ["硬", "硬"],
  ["路", "路"],
  ["料", "料"],
  ["式", "式"],
  ["設", "设"],
  ["演", "演"],
  ["算", "算"],
  ["系", "系"],
  ["統", "统"],
  ["維", "维"],
  ["安", "安"],
  ["密", "密"],
  ["伺", "伺"],
  ["器", "器"],
  ["雲", "云"],
  ["端", "端"],
  ["平", "平"],
  ["台", "台"],
  ["應", "应"],
  ["用", "用"],
  ["手", "手"],
  ["板", "板"],
  ["螢", "荧"],
  ["幕", "幕"],
  ["鍵", "键"],
  ["盤", "盘"],
  ["滑", "滑"],
  ["鼠", "鼠"],
  ["池", "池"],
  ["充", "充"],
  ["號", "号"],
  ["線", "线"],
  ["藍", "蓝"],
  ["牙", "牙"],
  ["無", "无"],
  ["區", "区"],
  ["域", "域"],
  ["爸", "爸"],
  ["媽", "妈"],
  ["媽", "妈"],
  ["爺", "爷"],
  ["奶", "奶"],
  ["孫", "孙"],
  ["兒", "儿"],
  ["親", "亲"],
  ["戚", "戚"],
  ["鄰", "邻"],
  ["居", "居"],
  ["婚", "婚"],
  ["姻", "姻"],
  ["離", "离"],
  ["喪", "丧"],
  ["偶", "偶"],
  ["單", "单"],
  ["身", "身"],
  ["同", "同"],
  ["居", "居"],
  ["貓", "猫"],
  ["狗", "狗"],
  ["寵", "宠"],
  ["物", "物"],
  ["養", "养"],
  ["預", "预"],
  ["約", "约"],
  ["準", "准"],
  ["備", "备"],
  ["載", "载"],
  ["入", "入"],
  ["失", "失"],
  ["敗", "败"],
  ["錯", "错"],
  ["誤", "误"],
  ["重", "重"],
  ["試", "试"],
  ["確", "确"],
  ["定", "定"],
  ["取", "取"],
  ["消", "消"],
]);

/** 供測試檢查每個 key 都是單一漢字（不會整段錯位）。 */
export const P3E_LOCALE_CHAR_PAIRS: readonly (readonly [string, string])[] = CHAR_PAIRS;

const CHAR_MAP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [from, to] of CHAR_PAIRS) {
    if ([...from].length !== 1) throw new Error("E_P3E_LOCALE_MAP：CHAR_PAIRS 的 key 必須是單一漢字");
    if (from !== to) map.set(from, to);
  }
  return map;
})();

const PHRASE_KEYS = Object.keys(PHRASES).sort((left, right) => right.length - left.length);

/** 繁體 → 簡體（顯示層）。已是簡體或沒有對應時原樣回傳。 */
export function toSimplified(text: string): string {
  if (text.length === 0) return text;
  let output = text;
  for (const key of PHRASE_KEYS) {
    if (output.includes(key)) output = output.split(key).join(PHRASES[key] as string);
  }
  let result = "";
  for (const char of output) result += CHAR_MAP.get(char) ?? char;
  return result;
}

/* ------------------------------------------------------------------ */
/* 語系狀態                                                            */
/* ------------------------------------------------------------------ */

let currentLocale: P3ELocale = P3E_DEFAULT_LOCALE;

function isLocale(value: unknown): value is P3ELocale {
  return value === "zh-CN" || value === "zh-TW";
}

/** 讀取使用者明確選過的語系；沒有紀錄（或壞值）一律回預設 zh-CN。 */
export function readStoredLocale(): P3ELocale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : P3E_DEFAULT_LOCALE;
  } catch {
    return P3E_DEFAULT_LOCALE;
  }
}

export function currentP3ELocale(): P3ELocale {
  return currentLocale;
}

/** 目前的顯示轉換函式（zh-TW 時是 identity）。 */
function transform(text: string): string {
  return currentLocale === "zh-CN" ? toSimplified(text) : text;
}

/* ------------------------------------------------------------------ */
/* DOM 轉換（記住原文，可即時切回）                                      */
/* ------------------------------------------------------------------ */

/** 被轉換過的節點 → 原文（切回 zh-TW 時用來還原）。 */
const ORIGINALS = new WeakMap<Node, string>();

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE"]);

function shouldSkip(node: Node): boolean {
  const parent = node.parentElement;
  if (parent === null) return true;
  if (SKIP_TAGS.has(parent.tagName)) return true;
  return parent.closest("[data-p3e-locale-skip]") !== null;
}

/** 轉換單一文字節點（保留原文）。 */
function localizeTextNode(node: Text): void {
  if (shouldSkip(node)) return;
  const original = ORIGINALS.get(node) ?? node.data;
  if (original.trim().length === 0) return;
  ORIGINALS.set(node, original);
  const next = transform(original);
  if (node.data !== next) node.data = next;
}

/** 轉換 placeholder／title／aria-label 等可見屬性。 */
const LOCALIZED_ATTRIBUTES = ["placeholder", "title", "aria-label"] as const;

function localizeAttributes(element: Element): void {
  if (typeof (element as Element).getAttribute !== "function") return;
  if (SKIP_TAGS.has(element.tagName)) return;
  for (const name of LOCALIZED_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value === null || value.trim().length === 0) continue;
    const key = `i18n:${name}`;
    const original = element.getAttribute(key) ?? value;
    if (element.getAttribute(key) === null) element.setAttribute(key, original);
    const next = transform(original);
    if (value !== next) element.setAttribute(name, next);
  }
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    localizeTextNode(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  const element = root as Element;
  if (element.nodeType === Node.ELEMENT_NODE && typeof element.getAttribute === "function") localizeAttributes(element);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.nextNode();
  while (node !== null) {
    if (node.nodeType === Node.TEXT_NODE) localizeTextNode(node as Text);
    else localizeAttributes(node as Element);
    node = walker.nextNode();
  }
}

/** 還原所有已轉換節點（切回 zh-TW 用）。 */
function restoreAll(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.nextNode();
  while (node !== null) {
    if (node.nodeType === Node.TEXT_NODE) {
      const original = ORIGINALS.get(node);
      if (original !== undefined && (node as Text).data !== original) (node as Text).data = original;
    } else {
      const element = node as Element;
      for (const name of LOCALIZED_ATTRIBUTES) {
        const original = element.getAttribute(`i18n:${name}`);
        if (original !== null && element.getAttribute(name) !== original) element.setAttribute(name, original);
      }
    }
    node = walker.nextNode();
  }
}

let observer: MutationObserver | null = null;

/** 開始監看 `#app`（或指定節點）並轉換現有內容。 */
export function startP3ELocalizer(root: HTMLElement = document.body): void {
  walk(root);
  if (observer !== null) return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") {
        localizeTextNode(record.target as Text);
        continue;
      }
      const added = record.addedNodes;
      for (let index = 0; index < added.length; index += 1) walk(added[index] as Node);
    }
  });
  observer.observe(root, { childList: true, characterData: true, subtree: true });
}

/** 套用語系（含 `<html lang>`、`document.documentElement.dataset.locale`）。 */
export function applyP3ELocale(locale: P3ELocale): void {
  currentLocale = locale;
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
  if (locale === "zh-CN") walk(document.body);
  else restoreAll(document.body);
  window.dispatchEvent(new CustomEvent("p3e:localechange", { detail: { locale } }));
}

/** 使用者明確切換語系（會記住）。 */
export function setP3ELocale(locale: P3ELocale): void {
  if (!isLocale(locale)) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* 私密模式等情況：仍套用，只是不記住。 */
  }
  applyP3ELocale(locale);
  updateToggleLabel();
}

/* ------------------------------------------------------------------ */
/* 右上角語系切換                                                       */
/* ------------------------------------------------------------------ */

const TOGGLE_ID = "p3e-locale-toggle";

function updateToggleLabel(): void {
  const button = document.getElementById(TOGGLE_ID);
  if (button === null) return;
  const next: P3ELocale = currentLocale === "zh-CN" ? "zh-TW" : "zh-CN";
  // 按鈕文字固定用「目標語系」的寫法，讓使用者知道按下去會變什麼。
  button.textContent = next === "zh-CN" ? "简体" : "繁體";
  button.setAttribute("aria-label", next === "zh-CN" ? "切換為簡體中文" : "切換為繁體中文");
  button.setAttribute("data-p3e-locale-skip", "true");
}

/** 建立右上角語系切換鈕（只用內嵌樣式，不動 WorkBuddy 的 style.css）。 */
export function installP3ELocaleToggle(): void {
  if (document.getElementById(TOGGLE_ID) !== null) {
    updateToggleLabel();
    return;
  }
  const button = document.createElement("button");
  button.id = TOGGLE_ID;
  button.type = "button";
  button.className = "p3e-locale-toggle";
  button.style.cssText = [
    "position:fixed",
    "top:calc(8px + env(safe-area-inset-top,0px))",
    "right:calc(10px + env(safe-area-inset-right,0px))",
    "z-index:2147483000",
    "min-width:44px",
    "min-height:32px",
    "padding:4px 10px",
    "border-radius:999px",
    "border:1px solid rgba(80,60,40,.18)",
    "background:rgba(255,250,240,.92)",
    "color:#3f3428",
    "font:600 12px/1.2 system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif",
    "box-shadow:0 2px 8px rgba(80,60,40,.12)",
    "cursor:pointer"
  ].join(";");
  button.addEventListener("click", () => {
    setP3ELocale(currentLocale === "zh-CN" ? "zh-TW" : "zh-CN");
  });
  document.body.append(button);
  updateToggleLabel();
}

/** 啟動：讀取已存選擇 → 套用 → 建立切換鈕 → 開始監看。 */
export function startP3ELocale(): P3ELocale {
  const locale = readStoredLocale();
  applyP3ELocale(locale);
  installP3ELocaleToggle();
  startP3ELocalizer(document.body);
  return locale;
}
