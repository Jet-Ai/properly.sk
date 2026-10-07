import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENCY_ID, BROKER_ID, CATALOGUE_URL, CATALOGUE_PATH, PORTAL_ORIGIN,
  collectListings, decodeFlight, parseDetail, portalUrl } from "./source.mjs";
import worker, { makeFetchPage, refresh, RefreshCoordinator } from "./worker.mjs";

// Synthetic data is confined to tests. All source network requests are mocked.
const detailUrl = (id) => PORTAL_ORIGIN + "/detail/" + id + "/qa-only";
function advert(id, overrides = {}) {
  return { id, title: "QA only", description: "Original description", isActive: true,
    advertiser: { id: BROKER_ID, agency: { id: AGENCY_ID } },
    location: { city: "Bratislava-Devín", street: "QA" }, media: { photos: [] },
    parameters: { transaction: "Predaj", category: { mainValue: "APARTMENTS" }, price: { priceNum: 199990 }, area: 77 },
    ...overrides };
}
function documentFor(ad) {
  return { scripts: ["self.__next_f.push(" + JSON.stringify([1, "1:" + JSON.stringify({ advertisement: ad }) + "\n"]) + ")"], links: [], headings: [], buttons: [] };
}
function catalogue(ids, count = ids.length, pages = []) {
  return { headings: ["properly."], buttons: ["Aktívne ponuky (" + count + ")"], scripts: [], links: [...ids.map(detailUrl), ...pages] };
}
function fixtureSource(ids, overrides = {}) {
  return new Map([[CATALOGUE_URL, catalogue(ids)], ...ids.map((id) => [detailUrl(id), documentFor(advert(id, overrides[id]))])]);
}
async function collect(source, options = {}) {
  return collectListings({ fetchPage: async (url) => {
    assert(source.has(url), "Unexpected network target " + url);
    return source.get(url);
  }, parseDocument: async (document) => document, ...options });
}
function kv(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return { data, writes: [], async get(key, type) { const value = data.get(key); return type === "json" ? value ? JSON.parse(value) : null : value; },
    async put(key, value) { this.writes.push(key); data.set(key, value); } };
}
function environment(cache = kv()) {
  return { COLLECTION_ENABLED: "true", WRITTEN_PERMISSION_CONFIRMED: "true", LISTING_CACHE: cache,
    ALLOWED_ORIGINS: "https://properly.sk", REFRESH_TOKEN: "qa-secret-token-not-for-production-123456" };
}
function refreshOptions(source, now) {
  return { now: new Date(now), requestIntervalMs: 0,
    fetchImpl: async (url) => {
      assert(source.has(url));
      return new Response(JSON.stringify(source.get(url)), { headers: { "Content-Type": "text/html" } });
    }, parseDocument: async (html) => JSON.parse(html) };
}

test("permission gates run before any network request or storage write", async () => {
  const env = environment();
  env.WRITTEN_PERMISSION_CONFIRMED = "false";
  await assert.rejects(refresh(env, { fetchImpl: () => assert.fail("Network called") }), /permission_required/);
  assert.deepEqual(env.LISTING_CACHE.writes, []);
  const result = await worker.fetch(new Request("https://api.test/api/listings"), env);
  assert.equal(result.status, 503);
  await worker.scheduled({}, env, { waitUntil: () => assert.fail("Scheduling while disabled") });
});

test("URLs reject other hosts, private APIs, redirects and invalid pagination", async () => {
  for (const url of ["https://evil.test/detail/a/x", PORTAL_ORIGIN + "/api/data", CATALOGUE_URL + "?page=0", CATALOGUE_URL + "?token=secret"]) {
    assert.throws(() => portalUrl(url));
  }
  const fetchPage = makeFetchPage(async (_url, options) => {
    assert.equal(options.redirect, "manual");
    assert(options.signal instanceof AbortSignal);
    return new Response(null, { status: 302, headers: { Location: "https://evil.test" } });
  }, 0);
  await assert.rejects(fetchPage(CATALOGUE_URL), /source_http_302/);
  await assert.rejects(makeFetchPage(async () => new Response("{}", { headers: { "Content-Type": "application/json" } }), 0)(CATALOGUE_URL), /unexpected_content_type/);
  await assert.rejects(makeFetchPage(async () => new Response("x".repeat(8_000_001), { headers: { "Content-Type": "text/html" } }), 0)(CATALOGUE_URL), /source_document_too_large/);
});

test("Flight text frames handle UTF-8, newlines and script chunk boundaries without eval", () => {
  const description = "Popis: záhrada\nĎalší riadok";
  const stream = ':HL["font"]\n2e:T' + new TextEncoder().encode(description).length.toString(16) + "," + description + '\n1:{"ok":true}\n';
  const scripts = [stream.slice(0, 25), stream.slice(25)].map((chunk) => "self.__next_f.push(" + JSON.stringify([1, chunk]) + ")");
  assert.equal(decodeFlight(scripts).get("2e"), description);
  assert.deepEqual(decodeFlight(scripts).get("1"), { ok: true });
  assert.throws(() => decodeFlight(['self.__next_f.push([1, globalThis.hacked=true])']), /changed_flight_wrapper/);
});

test("strict broker ownership, availability, actual fields and no fabricated missing values", () => {
  assert.equal(parseDetail(documentFor(advert("one")), detailUrl("one")).listing.priceValue, 199990);
  assert.equal(parseDetail(documentFor(advert("one", { advertiser: { id: "different", agency: { id: AGENCY_ID } } })), detailUrl("one")).state, "different_broker");
  assert.equal(parseDetail(documentFor(advert("one", { isActive: false })), detailUrl("one")).state, "withdrawn");
  assert.throws(() => parseDetail(documentFor(advert("one", { isActive: null })), detailUrl("one")), /unknown_availability/);
  const ad = advert("land", { parameters: { transaction: "Prenájom", category: { mainValue: "LANDS" } } });
  const listing = parseDetail(documentFor(ad), detailUrl("land")).listing;
  assert.equal(listing.type, "land");
  assert.equal(listing.mode, "rent");
  assert.equal(listing.priceValue, null);
  assert.equal(listing.area, null);
  assert.deepEqual(listing.photos, []);
});

test("discovery includes future offers and pagination, but fails on incomplete results", async () => {
  const source = fixtureSource(["one", "two", "three", "four", "future-five"]);
  const second = CATALOGUE_URL + "?page=2";
  source.set(CATALOGUE_URL, catalogue(["one", "two"], 5, [second]));
  source.set(second, catalogue(["three", "four", "future-five"], 5, [CATALOGUE_PATH + "?page=2"]));
  assert.equal((await collect(source)).listings.length, 5);
  await assert.rejects(collect(source, { maxPages: 1 }), /page_limit_exceeded/);
  await assert.rejects(collect(source, { maxListings: 4 }), /listing_limit_exceeded/);
  source.set(second, catalogue(["three", "four"], 5));
  await assert.rejects(collect(source), /incomplete_catalogue/);
  source.set(second, catalogue(["three", "four"], 4));
  await assert.rejects(collect(source), /catalogue_changed_during_refresh/);
});

test("withdrawn and other brokers' offers are excluded; duplicate adverts remain identifiable", async () => {
  const source = fixtureSource(["one", "two", "withdrawn", "foreign"], {
    withdrawn: { isActive: false }, foreign: { advertiser: { id: "other", agency: { id: AGENCY_ID } } }
  });
  const result = await collect(source);
  assert.equal(result.listings.length, 2);
  assert.equal(result.listings[0].relatedListingId, "two");
  await assert.rejects(collect(fixtureSource(["foreign"], { foreign: { advertiser: { id: "other", agency: { id: AGENCY_ID } } } })), /broker_identity_mismatch/);
});

test("refresh updates prices, adds new offers, removes withdrawals and retains cache on failure", async () => {
  const env = environment();
  await refresh(env, refreshOptions(fixtureSource(["one", "two"]), "2026-10-07T10:00:00Z"));
  const source = fixtureSource(["one", "future"], { one: { parameters: { ...advert("one").parameters, price: { priceNum: 180000 } } } });
  await refresh(env, refreshOptions(source, "2026-10-07T11:00:00Z"));
  const saved = await env.LISTING_CACHE.get("catalogue:v1", "json");
  assert.deepEqual(saved.listings.map((listing) => listing.id), ["future", "one"]);
  assert.equal(saved.listings[1].priceValue, 180000);
  const broken = fixtureSource(["one"]);
  broken.set(CATALOGUE_URL, catalogue(["one"], 2));
  await assert.rejects(refresh(env, refreshOptions(broken, "2026-10-07T12:00:00Z")), /incomplete_catalogue/);
  assert.deepEqual(await env.LISTING_CACHE.get("catalogue:v1", "json"), saved);
  const response = await worker.fetch(new Request("https://api.test/api/listings"), env);
  assert.equal((await response.json()).stale, true);
});

test("a complete empty catalogue needs two confirmations before removing all offers", async () => {
  const env = environment();
  await refresh(env, refreshOptions(fixtureSource(["one"]), "2026-10-07T10:00:00Z"));
  const empty = fixtureSource([]);
  assert.equal((await refresh(env, refreshOptions(empty, "2026-10-07T11:00:00Z"))).state, "empty_pending");
  assert.equal((await env.LISTING_CACHE.get("catalogue:v1", "json")).listings.length, 1);
  assert.equal((await refresh(env, refreshOptions(empty, "2026-10-07T12:00:00Z"))).state, "ok");
  assert.equal((await env.LISTING_CACHE.get("catalogue:v1", "json")).listings.length, 0);
  await assert.rejects(refresh(env, refreshOptions(empty, "2026-10-07T12:01:00Z")), /refresh_cooldown/);
});

test("API serves cache only, checks CORS, protects refresh and reports first-sync status", async () => {
  const env = environment();
  assert.equal((await worker.fetch(new Request("https://api.test/api/listings"), env)).status, 503);
  const request = (path, options) => new Request("https://api.test" + path, options);
  assert.equal((await worker.fetch(request("/api/refresh", { method: "POST" }), env)).status, 401);
  assert.equal((await worker.fetch(request("/api/status", { headers: { Origin: "https://evil.test" } }), env)).status, 403);
  const status = await worker.fetch(request("/api/status", { headers: { Origin: "https://properly.sk" } }), env);
  assert.equal(status.headers.get("Access-Control-Allow-Origin"), "https://properly.sk");
  assert.equal((await status.json()).count, null);
  env.REFRESH_COORDINATOR = { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json({ state: "ok" }) }) };
  const refreshed = await worker.fetch(request("/api/refresh", { method: "POST", headers: { Authorization: "Bearer " + env.REFRESH_TOKEN } }), env);
  assert.equal(refreshed.status, 200);
  env.COLLECTION_ENABLED = "false";
  assert.equal((await worker.fetch(request("/api/refresh", { method: "POST", headers: { Authorization: "Bearer " + env.REFRESH_TOKEN } }), env)).status, 403);
});

test("coordinator persists cooldown and never starts concurrent refreshes", async () => {
  const data = new Map();
  let queue = Promise.resolve();
  const state = { storage: { get: async (key) => data.get(key), put: async (key, value) => data.set(key, value) },
    blockConcurrencyWhile(callback) { const result = queue.then(callback); queue = result.catch(() => {}); return result; } };
  const env = environment();
  delete env.LISTING_CACHE; // Causes an immediate failure without accessing the network.
  const coordinator = new RefreshCoordinator(state, env);
  const results = await Promise.all([coordinator.fetch(), coordinator.fetch()]);
  assert.deepEqual(results.map((result) => result.status), [503, 429]);
  const restarted = new RefreshCoordinator(state, env);
  assert.equal((await restarted.fetch()).status, 429);
});
