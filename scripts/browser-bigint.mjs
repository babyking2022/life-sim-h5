import { chromium, webkit } from "playwright";

const html = `<!doctype html><meta charset="utf-8"><title>BigInt capability</title><script>
window.__bigint = {
  hasBigInt: typeof BigInt === "function",
  literalType: typeof 1n,
  sum: (1n + 1n).toString(),
  power: (2n ** 64n).toString()
};
</script>`;

const chromePath = process.env.CHROME_PATH;
const chromiumLaunch = chromePath ? { executablePath: chromePath } : {};
const chromiumName = chromePath ? "chromium (CHROME_PATH)" : "chromium (Playwright managed)";
const iosWeChat =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800323c) NetType/WIFI Language/zh_CN";
const androidWeChat =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.50.2701(0x2800323D) WeChat/arm64";

const targets = [
  { name: chromiumName, launcher: chromium, launch: chromiumLaunch, context: {} },
  { name: "webkit", launcher: webkit, launch: {}, context: {} },
  {
    name: "wechat-ios-ua-simulation (WebKit)",
    launcher: webkit,
    launch: {},
    context: { userAgent: iosWeChat, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
  },
  {
    name: "wechat-android-ua-simulation (Chromium)",
    launcher: chromium,
    launch: chromiumLaunch,
    context: { userAgent: androidWeChat, viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true }
  }
];

let failed = false;
for (const target of targets) {
  const browser = await target.launcher.launch(target.launch);
  try {
    const context = await browser.newContext(target.context);
    const page = await context.newPage();
    await page.setContent(html);
    const result = await page.evaluate(() => window.__bigint);
    const ok =
      result.hasBigInt === true &&
      result.literalType === "bigint" &&
      result.sum === "2" &&
      result.power === "18446744073709551616";
    console.log(`${ok ? "BROWSER-OK" : "BROWSER-FAIL"} ${target.name} ${JSON.stringify(result)}`);
    if (!ok) failed = true;
    await context.close();
  } finally {
    await browser.close();
  }
}

if (failed) process.exitCode = 1;
