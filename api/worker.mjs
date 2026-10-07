import { collectListings, portalUrl, SourceError } from "./source.mjs";

const SNAPSHOT_KEY = "catalogue:v1";
const STATUS_KEY = "refresh-status:v1";
const MAX_AGE_MS = 3 * 60 * 60 * 1000;

function hasPermission(env) {
  return env.COLLECTION_ENABLED === "true" && env.WRITTEN_PERMISSION_CONFIRMED === "true";
}

function requireStorage(env) {
  if (!env.LISTING_CACHE) throw new SourceError("storage_not_configured");
}

function corsHeaders(request, env) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Vary": "Origin", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim());
  if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }
  return headers;
}

function json(request, env, value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: corsHeaders(request, env) });
}

async function authorized(request, env) {
  if (!env.REFRESH_TOKEN || env.REFRESH_TOKEN.length < 32) return false;
  const actual = request.headers.get("Authorization") || "";
  const expected = "Bearer " + env.REFRESH_TOKEN;
  const digest = async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const a = await digest(actual), b = await digest(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function readLimited(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new SourceError("source_document_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function makeFetchPage(fetchImpl, intervalMs = 750) {
  let requests = 0;
  return async function fetchPage(value) {
    const url = portalUrl(value);
    if (requests++) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const response = await fetchImpl(url, {
      redirect: "manual", signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "Properly-Listing-Sync/1.0 (+https://properly.sk)", "Accept": "text/html", "Accept-Language": "sk" }
    });
    if (!response.ok) throw new SourceError("source_http_" + response.status);
    if (!response.headers.get("Content-Type")?.includes("text/html")) throw new SourceError("unexpected_content_type");
    if (!response.body) throw new SourceError("empty_source_response");
    return readLimited(response, 8_000_000);
  };
}

export async function refresh(env, { fetchImpl = fetch, parseDocument, now = new Date(), requestIntervalMs = 750 } = {}) {
  if (!hasPermission(env)) throw new SourceError("permission_required");
  requireStorage(env);
  const priorStatus = await env.LISTING_CACHE.get(STATUS_KEY, "json");
  if (priorStatus?.attemptedAt && now.getTime() - Date.parse(priorStatus.attemptedAt) < 10 * 60 * 1000) {
    throw new SourceError("refresh_cooldown");
  }
  const attemptedAt = now.toISOString();
  // Public reads never trigger collection. A failed or incomplete run cannot replace the last good catalogue.
  await env.LISTING_CACHE.put(STATUS_KEY, JSON.stringify({ attemptedAt, state: "running" }));
  try {
    const snapshot = await collectListings({ fetchPage: makeFetchPage(fetchImpl, requestIntervalMs), parseDocument, checkedAt: attemptedAt });
    const previous = await env.LISTING_CACHE.get(SNAPSHOT_KEY, "json");
    if (snapshot.listings.length === 0 && previous?.listings.length && priorStatus?.state !== "empty_pending") {
      const status = { attemptedAt, state: "empty_pending", error: "empty_catalogue_needs_second_confirmation" };
      await env.LISTING_CACHE.put(STATUS_KEY, JSON.stringify(status));
      return status;
    }
    await env.LISTING_CACHE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
    const status = { attemptedAt, state: "ok", count: snapshot.listings.length };
    await env.LISTING_CACHE.put(STATUS_KEY, JSON.stringify(status));
    return status;
  } catch (error) {
    const status = { attemptedAt, state: "failed", error: error instanceof SourceError ? error.code : "refresh_failed" };
    await env.LISTING_CACHE.put(STATUS_KEY, JSON.stringify(status));
    throw error;
  }
}

export class RefreshCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.running = false;
  }

  async fetch() {
    if (!hasPermission(this.env)) return Response.json({ error: "permission_required" }, { status: 403 });
    // The named Durable Object serializes refreshes across regions and Worker instances.
    const permitted = await this.state.blockConcurrencyWhile(async () => {
      const last = await this.state.storage.get("lastAttempt");
      if (this.running || (last && Date.now() - last < 10 * 60 * 1000)) return false;
      this.running = true;
      await this.state.storage.put("lastAttempt", Date.now());
      return true;
    });
    if (!permitted) return Response.json({ error: "refresh_cooldown" }, { status: 429 });
    try {
      const result = await refresh(this.env);
      return Response.json(result, { status: result.state === "empty_pending" ? 202 : 200 });
    } catch (error) {
      return Response.json({ error: error instanceof SourceError ? error.code : "refresh_failed" }, { status: 503 });
    } finally {
      this.running = false;
    }
  }
}

function coordinator(env) {
  if (!env.REFRESH_COORDINATOR) throw new SourceError("coordinator_not_configured");
  return env.REFRESH_COORDINATOR.get(env.REFRESH_COORDINATOR.idFromName("properly-catalogue"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim());
    if (origin && !allowed.includes(origin)) return json(request, env, { error: "origin_not_allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      if (url.pathname === "/api/status" && request.method === "GET") {
        const snapshot = env.LISTING_CACHE ? await env.LISTING_CACHE.get(SNAPSHOT_KEY, "json") : null;
        return json(request, env, { collectionEnabled: hasPermission(env), configured: Boolean(env.LISTING_CACHE), refreshedAt: snapshot?.refreshedAt || null, count: snapshot?.listings.length ?? null });
      }
      if (url.pathname === "/api/refresh" && request.method === "POST") {
        if (!await authorized(request, env)) return json(request, env, { error: "unauthorized" }, 401);
        if (!hasPermission(env)) return json(request, env, { error: "permission_required" }, 403);
        const result = await coordinator(env).fetch("https://internal/refresh", { method: "POST" });
        return json(request, env, await result.json(), result.status);
      }
      if (url.pathname === "/api/listings" && request.method === "GET") {
        if (!hasPermission(env)) return json(request, env, { error: "permission_required" }, 503);
        requireStorage(env);
        const snapshot = await env.LISTING_CACHE.get(SNAPSHOT_KEY, "json");
        if (!snapshot) return json(request, env, { error: "awaiting_first_sync" }, 503);
        const status = await env.LISTING_CACHE.get(STATUS_KEY, "json");
        const stale = !Number.isFinite(Date.parse(snapshot.refreshedAt)) || Date.now() - Date.parse(snapshot.refreshedAt) > MAX_AGE_MS || status?.state !== "ok";
        return json(request, env, { ...snapshot, stale });
      }
      return json(request, env, { error: "not_found" }, 404);
    } catch (error) {
      const code = error instanceof SourceError ? error.code : "service_unavailable";
      return json(request, env, { error: code }, code === "refresh_cooldown" ? 429 : code === "permission_required" ? 403 : 503);
    }
  },
  async scheduled(_controller, env, ctx) {
    if (!hasPermission(env)) return;
    ctx.waitUntil(coordinator(env).fetch("https://internal/refresh", { method: "POST" }).then(async (response) => {
      if (!response.ok) throw new SourceError((await response.json()).error);
    }));
  }
};
