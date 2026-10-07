const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

// Read previously downloaded pages only; never contact the source during QA.
const fixtures = process.argv[2];
if (!fixtures) throw new Error("Pass the directory of previously downloaded source HTML pages.");
const offers = [
  ["JuMU40TtrqX", 279000, 82, 7], ["Ju4Oh8rQb5U", 199990, 77, 9],
  ["Ju_QG6nD8-l", 199990, 77, 9], ["JuVh27TJtQ0", 219000, 34, 16]
];

async function run() {
  const { parseDetail, PORTAL_ORIGIN } = await import("../api/source.mjs");
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    for (const [id, price, area, photos] of offers) {
      await page.setContent(fs.readFileSync(path.join(fixtures, id + ".html"), "utf8"), { waitUntil: "domcontentloaded" });
      const document = await page.evaluate(() => ({
        scripts: [...document.querySelectorAll("script")].map((node) => node.textContent),
        headings: [...document.querySelectorAll("h1")].map((node) => node.textContent),
        buttons: [...document.querySelectorAll("button")].map((node) => node.textContent),
        links: [...document.querySelectorAll("a[href]")].map((node) => node.getAttribute("href"))
      }));
      const { state, listing } = parseDetail(document, PORTAL_ORIGIN + "/detail/" + id + "/fixture", "2026-10-07T12:00:00Z");
      assert.equal(state, "active");
      assert.equal(listing.priceValue, price);
      assert.equal(listing.area, area);
      assert.equal(listing.photos.length, photos);
      assert(listing.description.sk.length > 500);
      assert(listing.sourceUpdatedAt);
      console.log("PASS offline source: " + id + ", " + photos + " photos, " + listing.description.sk.length + " description characters");
    }
  } finally { await browser.close(); }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
