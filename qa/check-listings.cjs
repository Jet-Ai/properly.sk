const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const offers = [
  { id: "JuMU40TtrqX", price: "279 000 €", area: 82, count: 7, location: "Bratislava-Ružinov" },
  { id: "Ju4Oh8rQb5U", price: "199 990 €", area: 77, count: 9, location: "Bratislava-Ružinov" },
  { id: "Ju_QG6nD8-l", price: "199 990 €", area: 77, count: 9, location: "Bratislava-Ružinov" },
  { id: "JuVh27TJtQ0", price: "219 000 €", area: 34, count: 16, location: "Bratislava-Devín" }
];
const languages = ["sk", "en", "tr", "ru"];
const screenshots = path.join(os.tmpdir(), "properly-real-listings-qa");

function serve(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = path.resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404).end();
      return;
    }
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png" };
    res.writeHead(200, { "Content-Type": (types[path.extname(file)] || "application/octet-stream") + (/[.](html|js|css)$/.test(file) ? "; charset=utf-8" : "") }).end(data);
  });
}

async function noOverflow(page) {
  const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  const language = await page.locator("html").getAttribute("lang");
  assert(size.content <= size.viewport + 1, "Horizontal overflow: " + JSON.stringify(size) + " (" + language + ") on " + page.url());
}

async function checkImages(page, selector) {
  const images = page.locator(selector);
  for (let i = 0; i < await images.count(); i++) {
    const image = images.nth(i);
    await image.scrollIntoViewIfNeeded();
    await image.evaluate((element) => element.decode());
    assert(await image.evaluate((element) => element.naturalWidth > 0));
  }
}

async function run() {
  const server = http.createServer(serve);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port + "/";
  let browser;
  try {
    fs.mkdirSync(screenshots, { recursive: true });
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => { if (response.status() >= 400) errors.push(response.status() + " " + response.url()); });

    await page.goto(base + "listings.html");
    await page.waitForSelector(".listing-card");
    assert.equal(await page.locator(".listing-card").count(), 4);
    assert.equal(await page.locator(".sample-badge").count(), 0);
    assert.equal(await page.locator(".related-offer").count(), 2);
    const initialLocations = await page.locator(".listing-card .location-line").allTextContents();
    for (const language of languages) {
      await page.locator('[data-lang="' + language + '"]').click();
      assert.equal(await page.locator("html").getAttribute("lang"), language);
      assert.deepEqual(await page.locator(".listing-card .location-line").allTextContents(), initialLocations);
      assert.deepEqual(await page.locator(".price").allTextContents(), offers.map((offer) => offer.price));
      await noOverflow(page);
    }
    await page.locator('[data-lang="sk"]').click();
    await checkImages(page, ".listing-card img");
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: path.join(screenshots, "listings-desktop.png"), fullPage: true });

    for (const [field, value, count] of [
      ["mode", "rent", 0], ["mode", "buy", 4],
      ["type", "apartment", 2], ["type", "commercial", 1], ["type", "cottage", 1],
      ["location", "Bratislava-Ružinov", 3], ["location", "Bratislava-Devín", 1], ["price", "250000", 3]
    ]) {
      await page.goto(base + "listings.html");
      await page.locator('[name="' + field + '"]').selectOption(value);
      assert.equal(await page.locator(".listing-card").count(), count, field + "=" + value);
      if (!count) assert.equal(await page.locator(".empty-results").count(), 1);
    }
    await page.goto(base + "index.html");
    assert.equal(await page.locator("#featuredListings .listing-card").count(), 4);
    await page.locator('[data-feature-filter="rent"]').click();
    assert.equal(await page.locator("#featuredListings .listing-card").count(), 0);
    await page.locator('[data-feature-filter="buy"]').click();
    assert.equal(await page.locator("#featuredListings .listing-card").count(), 4);
    await page.locator('#homeSearch [name="location"]').selectOption("Bratislava-Devín");
    await page.locator('#homeSearch [type="submit"]').click();
    await page.waitForURL("**/listings.html?**");
    assert.equal(await page.locator(".listing-card").count(), 1);

    for (const offer of offers) {
      await page.goto(base + "listing-detail.html?id=" + offer.id);
      assert.equal(await page.locator(".detail-price").textContent(), offer.price);
      assert.equal(await page.locator("[data-photo-index]").count(), offer.count);
      assert.equal(await page.locator(".source-link").getAttribute("href").then((url) => new URL(url).pathname.split("/")[2]), offer.id);
      assert.equal(await page.locator(".inquiry-panel .button").getAttribute("href"), await page.locator(".source-link").getAttribute("href"));
      assert.match(await page.locator(".spec-panel").textContent(), new RegExp(offer.area + " m²"));
      for (const language of languages) {
        await page.locator('[data-lang="' + language + '"]').click();
        assert.equal(await page.locator(".detail-price").textContent(), offer.price);
        assert((await page.locator(".detail-summary .location-line").textContent()).includes(offer.location));
        await noOverflow(page);
      }
      await page.locator('[data-photo-index="0"]').click();
      await page.locator('[data-gallery-step="1"]').focus();
      assert.equal(await page.locator('[data-gallery-step="1"]').evaluate((element) => getComputedStyle(element).outlineColor), "rgb(184, 255, 18)");
      await page.locator('[data-gallery-step="1"]').click();
      assert.match(await page.locator(".gallery-main").getAttribute("src"), /-02[.]webp$/);
      assert.equal(await page.locator('[data-photo-index="1"]').getAttribute("aria-pressed"), "true");
      await page.locator('[data-gallery-step="-1"]').click();
      await page.locator('[data-gallery-step="-1"]').click();
      assert.equal(await page.locator('[data-photo-index="' + (offer.count - 1) + '"]').getAttribute("aria-pressed"), "true");
      await checkImages(page, ".detail-gallery img");
      await page.locator('[data-photo-index="0"]').click();
      await checkImages(page, ".gallery-main");
      await page.locator('[data-lang="sk"]').click();
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({ path: path.join(screenshots, offer.id + "-desktop.png"), fullPage: true });
    }

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const route of ["index.html", "listings.html", ...offers.map((offer) => "listing-detail.html?id=" + offer.id)]) {
        await page.goto(base + route);
        for (const language of languages) {
          await page.locator('[data-lang="' + language + '"]').click();
          await noOverflow(page);
        }
        await page.locator('[data-lang="sk"]').click();
        if (width === 390 && (route === "listings.html" || route.endsWith(offers[3].id))) {
          await checkImages(page, route.startsWith("listings") ? ".listing-card img" : ".gallery-main");
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await page.screenshot({ path: path.join(screenshots, route.startsWith("listings") ? "listings-mobile.png" : "devin-mobile.png"), fullPage: true });
        }
      }
    }
    await page.goto(base + "listing-detail.html?id=stare-mesto-apartment");
    assert.equal(await page.locator(".detail-price").count(), 0);
    assert.equal(await page.locator(".gallery-main").count(), 0);
    assert.equal(await page.locator("#detailRoot h1").count(), 1);

    // Invalid feed data must never replace the real snapshot or hide its warning.
    await page.route("**/qa-feed.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "broken" }]) }));
    await page.route("**/listings.html", async (route) => {
      const html = fs.readFileSync(path.join(root, "listings.html"), "utf8").replace("</head>", '<meta name="properly-listings-source" content="qa-feed.json"></head>');
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    });
    await page.goto(base + "listings.html");
    await page.waitForSelector(".listing-card");
    assert.equal(await page.locator(".listing-card").count(), 4);
    assert.equal(await page.locator("[data-source-status]").isVisible(), true);
    await page.unroute("**/listings.html");
    await page.unroute("**/qa-feed.json");

    // A fifth QA-only offer exercises future catalogue changes without publishing fictional records.
    const saved = await page.evaluate(() => listings);
    const future = { ...saved[0], id: "qa-future", mode: "rent", type: "land", location: "Pezinok",
      title: { sk: "QA-only future offer" }, description: { sk: "QA-only original Slovak description" },
      sourceUpdatedAt: "2026-10-08T12:00:00Z", priceValue: null, priceText: "", area: null, rooms: "", photos: [], image: "", specs: [] };
    await page.route("**/qa-feed.json", (route) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ listings: [...saved, future], refreshedAt: "2026-10-08T12:00:00Z", stale: true }) }));
    const feedRoutes = ["**/listings.html*", "**/listing-detail.html*"];
    for (const pattern of feedRoutes) {
      await page.route(pattern, async (route) => {
        const name = new URL(route.request().url()).pathname.split("/").pop();
        const html = fs.readFileSync(path.join(root, name), "utf8").replace("</head>", '<meta name="properly-listings-source" content="qa-feed.json"></head>');
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      });
    }
    await page.goto(base + "listings.html");
    await page.waitForFunction(() => document.querySelectorAll(".listing-card").length === 5);
    assert.equal(await page.locator("[data-source-status]").isVisible(), true);
    assert.match(await page.locator('[data-i18n="recordsNote"]').textContent(), /08[.]10[.]2026/);
    await page.locator('[name="location"]').selectOption("Pezinok");
    assert.equal(await page.locator(".listing-card").count(), 1);
    await page.locator('[data-lang="en"]').click();
    assert.equal(await page.locator('[name="location"]').inputValue(), "Pezinok");
    assert.equal(await page.locator(".price").textContent(), "Price on request");
    assert.equal(await page.locator(".no-photo").count(), 1);
    await page.locator('[name="type"]').selectOption("land");
    await page.locator('[name="price"]').selectOption("250000");
    assert.equal(await page.locator(".listing-card").count(), 0);
    await page.goto(base + "listing-detail.html?id=qa-future");
    await page.waitForSelector(".detail-no-photo");
    assert.equal(await page.locator(".gallery-main").count(), 0);
    assert.equal(await page.locator(".detail-price").textContent(), "Price on request");
    assert.match(await page.locator(".detail-description").textContent(), /original Slovak version/);
    assert(!(await page.locator(".spec-panel").textContent()).includes("null"));
    await noOverflow(page);
    await page.screenshot({ path: path.join(screenshots, "feed-missing-photos-mobile.png"), fullPage: true });
    for (const pattern of feedRoutes) await page.unroute(pattern);
    await page.unroute("**/qa-feed.json");

    await page.goto(base + "contact.html");
    await page.evaluate(() => {
      window.open = (url) => { window.qaWhatsAppUrl = url; return null; };
    });
    await page.locator('[data-lang="en"]').click();
    await page.locator('[name="name"]').fill("QA Test");
    await page.locator('[name="email"]').fill("test@example.com");
    await page.locator('[name="interest"]').selectOption("buy");
    await page.locator('[name="message"]').fill("Test inquiry");
    await page.locator('[type="submit"]').click();
    assert.match(await page.locator(".form-status").textContent(), /WhatsApp/);
    const whatsApp = new URL(await page.evaluate(() => window.qaWhatsAppUrl));
    assert.equal(whatsApp.hostname, "api.whatsapp.com");
    assert.equal(whatsApp.searchParams.get("phone"), "421917962233");
    assert.match(whatsApp.searchParams.get("text"), /Name: QA Test\nEmail: test@example[.]com/);
    assert.match(whatsApp.searchParams.get("text"), /Test inquiry/);
    assert.equal(await page.locator('[name="message"]').inputValue(), "Test inquiry");
    await page.goto(base + "about.html");
    assert.equal(await page.locator(".certificate-preview img").count(), 1);
    assert.deepEqual(errors, []);
    console.log("PASS: four real adverts, 41 photos, filters/search, four languages, galleries, 320/390px layouts, unknown IDs, feed fallback, future offer/missing data/stale feed, and preserved WhatsApp enquiries.");
    console.log("Screenshots: " + screenshots);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
