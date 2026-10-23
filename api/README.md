# Properly Listing Connector

## Current Status

The connector and website integration are built locally. Collection is **disabled**, no cron is enabled, and no Cloudflare deployment or live catalogue refresh has been performed. The website uses five real, manually imported adverts until a working endpoint is configured.

Offline checks cover all four previously downloaded detail pages, discovery/pagination with mocked catalogues, updates, withdrawals, failure recovery, ownership checks, authorization and browser rendering. The native Cloudflare HTMLRewriter, Durable Object binding and current live agency catalogue must be verified in the deployed runtime before activation is considered complete.

This is a custom connector, **not an official Nehnutelnosti.sk API**. The portal's [terms, section XVIII.6](https://s.aimg.sk/unitedclassifieds/css/data/nehnutelnosti.pdf?v=20250227) require prior written consent for systematic extraction. Owning the adverts does not establish that portal permission. Obtain consent covering catalogue discovery, detail text, photographs, refresh frequency and reuse on properly.sk before enabling collection. An approved export from Miriam's real-estate software is preferable if available.

## How It Works

```text
Authorized scheduled refresh
  -> Properly agency catalogue, including pagination
  -> Each discovered advert, verified against Miriam + agency IDs
  -> Complete validated snapshot in Cloudflare KV
  -> Public read-only /api/listings
  -> Static Properly website on GitHub Pages
```

The catalogue URL is configured in `source.mjs`; the four initial advert URLs are not hardcoded in the collector. New offers are discovered automatically, changed prices and descriptions are replaced, and removed/inactive adverts disappear after a successful complete refresh. Other brokers' offers are excluded. Separate adverts for the same property remain separate source records with a related-offer notice when their facts and descriptions match exactly.

Public website visits read the cache and never trigger portal requests. Requests are sequential, spaced by 750 ms, timeout after 20 seconds and do not follow redirects. There is no login, private-API access, challenge bypass or hidden contact extraction. Parsed source scripts are JSON data only and are never executed.

Missing prices/areas are null, not zero; missing photos produce an honest empty state. New or changed descriptions are shown in their original Slovak until reviewed translations exist. Existing reviewed translations are reused only when the source `updatedAt` matches their imported version. Location names and numeric prices are not translated.

Incomplete pagination, count changes, challenges, identity mismatches, changed page structure and HTTP failures never replace the last successful snapshot. A complete empty result must be confirmed by a second successful refresh before a previously nonempty catalogue is cleared. Refreshes are serialized by a named Durable Object with a persistent ten-minute cooldown. Stale data is flagged after three hours or an unsuccessful refresh. KV propagation is not instantaneous.

Safety caps are 25 catalogue pages and 200 adverts per run. Exceeding a cap fails the run rather than publishing a partial catalogue. These caps are not a promise that every Cloudflare plan supports that many requests; verify the hosting plan's execution/subrequest limits before increasing the catalogue size or frequency.

## Deployment After Approval

GitHub Pages hosts the static website, not server-side APIs. Deploy this folder separately to a Cloudflare Workers account. Node/npm and Wrangler are prerequisites for the commands below; they have not been installed or run for this project.

1. Save the portal's written approval and confirm the allowed refresh frequency. Keep permission and collection flags false while provisioning.
2. From this `api` directory, authenticate with `npx wrangler login`.
3. Run `npx wrangler kv namespace create LISTING_CACHE`. Add the returned namespace ID to `wrangler.jsonc` as `kv_namespaces: [{ "binding": "LISTING_CACHE", "id": "ACTUAL_ID" }]` (replace the value, do not keep the placeholder).
4. Generate a long random secret (at least 32 characters) and store it with `npx wrangler secret put REFRESH_TOKEN`. Never put it in `assets/config.js`, GitHub Pages, committed files or browser requests.
5. Confirm `ALLOWED_ORIGINS` contains the actual website origins. GitHub Pages uses `https://jet-ai.github.io`, not a repository-path origin. Deploy with `npx wrangler deploy`; the included SQLite Durable Object migration creates the coordinator.
6. Check the actual Worker URL's `/api/status`: it should report collection disabled. Only after approval, set both `COLLECTION_ENABLED` and `WRITTEN_PERMISSION_CONFIRMED` to `"true"` and redeploy.
7. Make an authenticated POST to the actual `/api/refresh` endpoint from an administrator tool with `Authorization: Bearer <your-secret>`. Verify that the full agency catalogue, ownership checks and all real details parse successfully. Inspect Worker logs for failures. Do not connect the website if the first refresh fails.
8. Check `/api/listings` contains all current Miriam adverts, accurate prices and photographs, and `stale: false`. Set `listingsApiUrl` in `assets/config.js` to that actual HTTPS URL and upload the updated HTML/assets to GitHub. Verify the deployed website, including filters and details.
9. If the approval permits hourly refreshes, set `triggers.crons` to `["17 * * * *"]` and redeploy. It is currently empty. Configure Cloudflare error alerts and periodically compare the catalogue against the source. Changing the flags back to false stops collection and makes the public feed unavailable.

Keep the endpoint unconfigured until setup is complete. No sample Worker hostname or credentials are included. A source-page parser can break after portal changes; this integration needs monitoring and maintenance, not a guarantee of permanent compatibility.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/status` | Collection/configuration status, cached count and refresh date; no collection. |
| GET | `/api/listings` | Cached `{ version, source, refreshedAt, catalogueCount, listings, stale }`; 503 when disabled/uninitialized. |
| POST | `/api/refresh` | Requires the secret bearer token, permission and storage; complete refresh only. |

Public listing data is public, not authenticated. CORS restricts browser origins; it is not access control for public records. Refresh secrets remain server-side. Error responses expose codes, not source HTML or credential-bearing traces.

## Tests

```sh
node --test api/connector.test.mjs
node qa/check-listings.cjs
node qa/check-api-fixtures.cjs /path/to/previously-downloaded-html
```

Run from the repository root. Browser checks require Playwright and Chromium (or `CHROME_PATH` pointing to Chrome). The fixture runner blocks all browser networking and disables source JavaScript; it never downloads source pages. Test fixtures and QA-only fictional records are not part of the published catalogue.

Runtime references: [HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/), [Workers KV](https://developers.cloudflare.com/kv/api/), [Durable Objects](https://developers.cloudflare.com/durable-objects/get-started/), [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
