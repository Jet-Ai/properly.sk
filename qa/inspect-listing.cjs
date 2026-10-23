const fs = require("node:fs");
const { chromium } = require("playwright");

// Inspect one saved, owner-supplied advert without executing its scripts or contacting the portal.
async function run() {
  const [file, url] = process.argv.slice(2);
  if (!file || !url) throw new Error("Usage: node qa/inspect-listing.cjs saved.html source-url");
  const { parseDetail, decodeFlight } = await import("../api/source.mjs");
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(fs.readFileSync(file, "utf8"), { waitUntil: "domcontentloaded" });
    const document = await page.evaluate(() => ({ scripts: [...document.querySelectorAll("script")].map((node) => node.textContent) }));
    const result = parseDetail(document, url);
    const id = new URL(url).pathname.split("/")[2];
    function find(value) {
      if (!value || typeof value !== "object") return null;
      if (value.advertisement?.id === id) return value.advertisement;
      for (const child of Object.values(value)) { const found = find(child); if (found) return found; }
      return null;
    }
    let advertisement;
    for (const record of decodeFlight(document.scripts).values()) { advertisement = find(record); if (advertisement) break; }
    console.log(JSON.stringify({ ...result, parameters: advertisement?.parameters }, null, 2));
  } finally { await browser.close(); }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
