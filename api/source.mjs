export const PORTAL_ORIGIN = "https://www.nehnutelnosti.sk";
export const AGENCY_ID = "87a68970-314e-4ce5-9d02-da4cf5e9673f";
export const BROKER_ID = "df8bc812-ac9c-4a0b-b612-a36589e0a3ad";
export const CATALOGUE_PATH = "/realitna-kancelaria/properly/centrala/inzeraty/" + AGENCY_ID;
export const CATALOGUE_URL = PORTAL_ORIGIN + CATALOGUE_PATH;

export class SourceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function portalUrl(value, base = CATALOGUE_URL) {
  const url = new URL(value, base);
  if (url.origin !== PORTAL_ORIGIN || url.username || url.password) throw new SourceError("untrusted_source_url");
  if (!/^\/detail\/[\w-]+(?:\/[^/?#]+)?\/?$/.test(url.pathname) && url.pathname !== CATALOGUE_PATH) {
    throw new SourceError("unsupported_source_path");
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "page") throw new SourceError("unsupported_source_query");
  }
  if (url.searchParams.has("page") && !/^[1-9]\d*$/.test(url.searchParams.get("page"))) {
    throw new SourceError("invalid_page");
  }
  url.hash = "";
  return url.href;
}

// Use Cloudflare's HTML parser; never execute scripts received from the portal.
export async function extractDocument(html) {
  if (typeof HTMLRewriter === "undefined") throw new SourceError("html_parser_unavailable");
  const document = { scripts: [], links: [], buttons: [], headings: [] };
  function textCollector(output) {
    let text = "";
    return {
      element(element) {
        text = "";
        element.onEndTag(() => output.push(text));
      },
      text(chunk) { text += chunk.text; }
    };
  }
  const parser = new HTMLRewriter()
    .on("script", textCollector(document.scripts))
    .on("button", textCollector(document.buttons))
    .on("h1", textCollector(document.headings))
    .on("a[href]", { element(element) { document.links.push(element.getAttribute("href")); } });
  await parser.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).arrayBuffer();
  return document;
}

export function decodeFlight(scripts) {
  const chunks = [];
  const prefix = "self.__next_f.push(";
  for (const script of scripts) {
    const text = script.trim().replace(/;$/, "");
    if (!text.startsWith(prefix) || !text.endsWith(")")) continue;
    let args;
    try { args = JSON.parse(text.slice(prefix.length, -1)); }
    catch (_) { throw new SourceError("changed_flight_wrapper"); }
    if (args[0] === 1 && typeof args[1] === "string") chunks.push(args[1]);
  }
  if (!chunks.length) throw new SourceError("missing_structured_data");

  // Flight text records are UTF-8 byte-length framed and may span script tags.
  const bytes = new TextEncoder().encode(chunks.join(""));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records = new Map();
  let position = 0;
  while (position < bytes.length) {
    if (bytes[position] === 10) { position++; continue; }
    const colon = bytes.indexOf(58, position);
    if (colon < position || colon - position > 16) throw new SourceError("changed_flight_framing");
    const id = decoder.decode(bytes.subarray(position, colon));
    if (!/^[a-f\d]*$/i.test(id)) throw new SourceError("changed_flight_record_id");
    position = colon + 1;
    if (bytes[position] === 84) {
      const comma = bytes.indexOf(44, position);
      const sizeText = decoder.decode(bytes.subarray(position + 1, comma));
      if (comma < position || !/^[a-f\d]+$/i.test(sizeText)) throw new SourceError("invalid_text_frame");
      const size = Number.parseInt(sizeText, 16);
      position = comma + 1;
      if (size > 4_000_000 || position + size > bytes.length) throw new SourceError("incomplete_text_frame");
      records.set(id, decoder.decode(bytes.subarray(position, position + size)));
      position += size;
    } else {
      let end = bytes.indexOf(10, position);
      if (end === -1) end = bytes.length;
      const value = decoder.decode(bytes.subarray(position, end));
      if (/^[\[{"]/.test(value)) {
        try { records.set(id, JSON.parse(value)); }
        catch (_) { throw new SourceError("invalid_structured_record"); }
      }
      position = end + 1;
    }
  }
  return records;
}

function findAdvertisement(value, id) {
  if (!value || typeof value !== "object") return null;
  if (value.advertisement?.id === id && value.advertisement.parameters && value.advertisement.advertiser) {
    return value.advertisement;
  }
  for (const child of Object.values(value)) {
    const match = findAdvertisement(child, id);
    if (match) return match;
  }
  return null;
}

export function parseDetail(document, url, checkedAt = new Date().toISOString()) {
  const sourceUrl = portalUrl(url);
  const id = new URL(sourceUrl).pathname.split("/")[2];
  const records = decodeFlight(document.scripts);
  let advert;
  for (const record of records.values()) {
    advert = findAdvertisement(record, id);
    if (advert) break;
  }
  if (!advert) throw new SourceError("missing_advertisement");
  if (advert.advertiser.id !== BROKER_ID || advert.advertiser.agency?.id !== AGENCY_ID) {
    return { state: "different_broker", listing: null };
  }
  if (advert.isActive === false) return { state: "withdrawn", listing: null };
  if (advert.isActive !== true) throw new SourceError("unknown_availability");
  let description = advert.description;
  if (typeof description === "string" && /^\$[a-f\d]+$/i.test(description)) description = records.get(description.slice(1));
  if (typeof description !== "string") throw new SourceError("missing_description");
  const parameters = advert.parameters;
  const transaction = parameters.transaction;
  const mode = transaction === "Predaj" ? "buy" : transaction === "Prenájom" ? "rent" : null;
  if (!mode) throw new SourceError("unknown_transaction");
  const category = parameters.category?.mainValue;
  const types = { APARTMENTS: "apartment", HOUSES: "house", COTTAGES_AND_CABINS: "cottage", LAND: "land", LANDS: "land", OBJECTS: "commercial" };
  let type = types[category] || "other";
  if (parameters.category?.subValue?.includes("GARAGE")) type = "garage";
  const photoUrls = advert.media?.photos?.map((photo) => {
    const value = photo.largeUrl || photo.origUrl;
    const photoUrl = new URL(value);
    if (photoUrl.protocol !== "https:" || photoUrl.hostname !== "img.unitedclassifieds.sk") throw new SourceError("untrusted_photo_url");
    return photoUrl.href;
  }) || [];
  const positive = (value) => value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const priceValue = positive(parameters.price?.priceNum ?? parameters.price?.priceValue);
  const area = positive(parameters.area);
  const rooms = parameters.attributes?.find((attribute) => attribute.label.trim() === "Počet izieb / miestností")?.value || "";
  const location = advert.location?.city || advert.location?.name;
  if (!advert.title || !location) throw new SourceError("incomplete_listing");
  const date = new Date(checkedAt);
  const specs = [];
  if (Number.isInteger(parameters.floor) && Number.isInteger(parameters.numberOfFloors)) {
    specs.push({ label: "floor", value: parameters.floor + " / " + parameters.numberOfFloors });
  }
  const condition = { "Pôvodný stav": "originalCondition", "Čiastočná rekonštrukcia": "partlyRenovated" }[parameters.realEstateState];
  if (condition) specs.push({ label: "condition", valueKey: condition });
  const labels = { "Plocha lodžie": "loggia", "Plocha pivnice": "cellar", "Plocha terasy": "terrace", "Názov budovy": "building" };
  for (const attribute of parameters.attributes || []) {
    const label = labels[attribute.label.trim()];
    if (label && attribute.value) specs.push({ label, value: attribute.value });
  }
  return {
    state: "active",
    listing: {
      id, mode, type, location,
      address: [advert.location.street, advert.location.streetNumber].filter(Boolean).join(" "),
      title: { sk: advert.title }, description: { sk: description },
      descriptionLanguage: "sk", priceValue, area, rooms, photos: photoUrls,
      priceText: priceValue === null ? "" : priceValue.toLocaleString("sk-SK").replace(/\u00a0/g, " ") + (mode === "rent" ? " €/mes." : " €"),
      categoryKey: parameters.category?.subValue === "LOFT" ? "typeLoft" : undefined,
      sourceUrl, sourceUpdatedAt: advert.updatedAt,
      checkedAt: date.getUTCDate().toString().padStart(2, "0") + "." + (date.getUTCMonth() + 1).toString().padStart(2, "0") + "." + date.getUTCFullYear(),
      specs, isSample: false
    }
  };
}

export function parseCatalogue(document, url) {
  const current = new URL(portalUrl(url));
  if (current.pathname !== CATALOGUE_PATH) throw new SourceError("wrong_catalogue");
  if (!document.headings.some((title) => /^properly[.]?$/i.test(title.trim()))) throw new SourceError("unrecognized_catalogue");
  const counts = document.buttons.map((text) => text.match(/Aktívne ponuky\s*\((\d+)\)/i)).filter(Boolean).map((match) => Number(match[1]));
  if (!counts.length || new Set(counts).size !== 1) throw new SourceError("missing_catalogue_count");
  const offers = new Map();
  const pages = new Set();
  for (const href of document.links) {
    let link;
    try { link = new URL(href, current); } catch (_) { continue; }
    if (link.origin !== PORTAL_ORIGIN) continue;
    if (/^\/detail\/[\w-]+\//.test(link.pathname)) {
      link.search = "";
      const safe = portalUrl(link.href);
      offers.set(link.pathname.split("/")[2], safe);
    } else if (link.pathname === CATALOGUE_PATH && link.searchParams.has("page")) {
      pages.add(portalUrl(link.href));
    }
  }
  return { count: counts[0], offers, pages };
}

function markRelated(listings) {
  for (const listing of listings) {
    const related = listings.find((candidate) => candidate.id !== listing.id && listing.address &&
      candidate.address === listing.address && candidate.location === listing.location &&
      candidate.area === listing.area && candidate.priceValue === listing.priceValue &&
      candidate.title.sk === listing.title.sk && candidate.description.sk === listing.description.sk);
    if (related) listing.relatedListingId = related.id;
  }
}

export async function collectListings({ fetchPage, parseDocument = extractDocument, checkedAt = new Date().toISOString(), maxPages = 25, maxListings = 200 }) {
  const queue = [CATALOGUE_URL];
  const visited = new Set();
  const offers = new Map();
  let count;
  while (queue.length) {
    const pageUrl = queue.shift();
    if (visited.has(pageUrl)) continue;
    if (visited.size >= maxPages) throw new SourceError("page_limit_exceeded");
    visited.add(pageUrl);
    const page = parseCatalogue(await parseDocument(await fetchPage(pageUrl)), pageUrl);
    if (count === undefined) count = page.count;
    if (page.count !== count) throw new SourceError("catalogue_changed_during_refresh");
    for (const [id, url] of page.offers) offers.set(id, url);
    for (const url of page.pages) if (!visited.has(url)) queue.push(url);
  }
  if (offers.size !== count) throw new SourceError("incomplete_catalogue");
  if (offers.size > maxListings) throw new SourceError("listing_limit_exceeded");
  const listings = [];
  let foreignCount = 0;
  for (const url of offers.values()) {
    const detail = parseDetail(await parseDocument(await fetchPage(url)), url, checkedAt);
    if (detail.state === "different_broker") foreignCount++;
    if (detail.listing) listings.push(detail.listing);
  }
  if (offers.size && foreignCount === offers.size) throw new SourceError("broker_identity_mismatch");
  listings.sort((a, b) => a.id.localeCompare(b.id));
  markRelated(listings);
  return { version: 1, source: CATALOGUE_URL, refreshedAt: checkedAt, catalogueCount: count, listings };
}
