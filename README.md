# Properly Static Website Prototype

Static, self-contained website prototype for `properly.sk`.

## Design System

- Danube Slate `#18313A`: primary brand text and navigation.
- Registry Blue `#2F6F83`: trusted actions, process states, and links.
- Limestone `#F3F5F2`: cool neutral section bands.
- Copper Roof `#B85F3E`: restrained accent inspired by Bratislava rooflines.
- Paper White `#FFFFFF`, Mist Border `#D7DED8`, Charcoal Ink `#202624`.

The signature visual element is the verified ribbon rail: a process line for ownership check, factual presentation, and legal close.

## Pages

- `index.html`: homepage with search, verification rail, featured sample listings, process, broker teaser, and contact CTA.
- `listings.html`: listing grid with client-side filters.
- `listing-detail.html?id=stare-mesto-apartment`: detail template with specs, map area, and inquiry form.
- `about.html`: broker/process story.
- `contact.html`: contact form.

All listing records in this prototype are sample records and are marked visually. The embedded sample catalogue contains 22 records so the grid can be tested at the intended launch scale.

## Listing Data

The default sample data lives in `assets/site.js`. To replace it with a simple backend, add this meta tag before `assets/site.js` on any page:

```html
<meta name="properly-listings-source" content="https://example.com/listings.json">
```

The endpoint should return either an array or `{ "listings": [...] }`. Each listing should use this shape:

```json
{
  "id": "unique-listing-id",
  "mode": "buy",
  "type": "apartment",
  "location": "Bratislava - Staré Mesto",
  "image": "assets/images/listing-apartment-stare-mesto.png",
  "priceText": "Cena na vyžiadanie",
  "priceValue": 385000,
  "area": 58,
  "rooms": "2",
  "title": {
    "sk": "2-izbový byt",
    "en": "2-room apartment",
    "tr": "2 odalı daire",
    "ru": "2-комнатная квартира"
  }
}
```

Descriptions can be supplied per language with the same `sk/en/tr/ru` object shape. If a backend record omits `description`, the prototype uses a generic sample description by property type.
