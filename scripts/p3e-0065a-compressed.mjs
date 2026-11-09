/**
 * GPT-WORKBUDDY-0065-A｜production-like **壓縮** server 對照量測。
 *
 * 訂單要求：「另補一組啟用 gzip/brotli 的 production-like server 測量，
 * 記錄更接近公開站的實際傳輸量，但不可用它取代無壓縮同口徑門檻。」
 *
 * 這裡用自己的 node:http server，依 Accept-Encoding 真的做 gzip / brotli
 * 壓縮並回 Content-Encoding；傳輸量由 server 端逐回應累加（壓縮後 body +
 * 實際 header bytes）。仍用與 0064 相同的 CDP Fast-3G / 關快取 / 390×844。
 */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { chromium } from "playwright";

const ROOT = process.cwd();
const DIST = resolve(ROOT, ".artifacts/p1c-dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error("缺少 production build");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml"
};
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg"]);

const browser = await chromium.launch();

async function measure(mode) {
  const responses = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = normalize(join(DIST, decodeURIComponent(pathname)));
    if (!filePath.startsWith(DIST)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const raw = await readFile(filePath);
      const ext = extname(filePath);
      const accepted = String(request.headers["accept-encoding"] ?? "");
      const canUse = mode === "gzip" ? accepted.includes("gzip")
        : mode === "br" ? accepted.includes("br") : false;
      const compress = canUse && COMPRESSIBLE.has(ext);
      const body = compress
        ? mode === "gzip"
          ? gzipSync(raw, { level: 9 })
          : brotliCompressSync(raw, {
              params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 }
            })
        : raw;
      const headers = {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
        "content-length": String(body.byteLength)
      };
      if (compress) headers["content-encoding"] = mode;
      const statusLine = "HTTP/1.1 200 OK\r\n";
      const headerText = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join("") + "\r\n";
      responses.push({
        url: request.url,
        raw: raw.byteLength,
        transferred: body.byteLength + Buffer.byteLength(statusLine + headerText),
        encoding: compress ? mode : "identity"
      });
      response.writeHead(200, headers);
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: Math.round((1600 * 1024) / 8),
    uploadThroughput: Math.round((1600 * 1024) / 8) / 2
  });
  const started = Date.now();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const interactiveMs = await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((button) =>
      /开始人生|開始人生|重試並開始人生|重试并开始人生/.test(button.textContent ?? "")),
    { timeout: 60000 }
  ).then(() => Date.now() - started).catch(() => -1);
  await context.close();
  await new Promise((done) => server.close(done));

  const totalTransferred = responses.reduce((sum, item) => sum + item.transferred, 0);
  const totalRaw = responses.reduce((sum, item) => sum + item.raw, 0);
  return {
    mode,
    interactiveMs,
    requestCount: responses.length,
    totalRawBytes: totalRaw,
    totalTransferredBytes: totalTransferred,
    responses: responses.map((item) => ({
      path: item.url.replace(baseUrl, ""),
      raw: item.raw,
      transferred: item.transferred,
      encoding: item.encoding
    }))
  };
}

const report = {
  uncompressedReference: { interactiveMs: 2552, totalTransferredBytes: 405979 },
  runs: [await measure("gzip"), await measure("br")]
};
await browser.close();
await writeFile(
  resolve(ROOT, ".artifacts/0065a-compressed.json"),
  JSON.stringify(report, null, 2),
  "utf8"
);
for (const run of report.runs) {
  console.log(
    `P3E-0065A-COMPRESSED ${run.mode} interactive=${run.interactiveMs}ms ` +
    `raw=${run.totalRawBytes}B transferred=${run.totalTransferredBytes}B requests=${run.requestCount}`
  );
}
console.log("P3E-0065A-COMPRESSED-OK");
