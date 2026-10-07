# Properly Static Website

Self-contained HTML/CSS/JavaScript site for `properly.sk`, deployable to GitHub Pages without a build step. Slovak, English, Turkish and Russian are supported. Place names, prices and measurements remain unchanged across languages.

## Brand

- Blueprint Deep `#020B14`: background.
- Properly Purple `#B45DFF`: brand and actions.
- Properly Lime `#B8FF12`: active states and accents.
- Surface Navy `#071824`, Mist Border `#244252`, Light Ink `#F4F8FF`.

The existing verification rail, broker biography and redacted certificate are preserved.

## Real Offers

The catalogue in `assets/site.js` contains only the four owner-supplied adverts, imported on **7 October 2026**:

| Advert | Property | Price | Area |
| --- | --- | --- | --- |
| [JuMU40TtrqX](https://www.nehnutelnosti.sk/detail/JuMU40TtrqX/pripravujeme-na-predaj-priestranny-3-izbovy-byt-v-ruzinove) | Hraničná 3, Bratislava-Ružinov | 279 000 € | 82 m² |
| [Ju4Oh8rQb5U](https://www.nehnutelnosti.sk/detail/Ju4Oh8rQb5U/komercny-priestor-s-loftovym-bytom-v-atraktivnej-lokalite-bratislavy) | Zelinárska loft + commercial premises | 199 990 € | 77 m² |
| [Ju_QG6nD8-l](https://www.nehnutelnosti.sk/detail/Ju_QG6nD8-l/komercny-priestor-s-loftovym-bytom-v-atraktivnej-lokalite-bratislavy) | Zelinárska commercial advert for the same property | 199 990 € | 77 m² |
| [JuVh27TJtQ0](https://www.nehnutelnosti.sk/detail/JuVh27TJtQ0/kusok-pokoja-v-devine-murovana-chata-vinohrad-ovocna-zahrada-a-nadherny-vyhlad) | Spätná cesta, Bratislava-Devín cottage | 219 000 € | 34 m² |

**Four adverts represent three distinct properties.** The Zelinárska adverts are cross-linked and labelled on cards and details; they are not presented as two unrelated properties.

All 41 source photographs are stored in `assets/images/listings/`, with their existing branding intact. No generated/sample property pictures or records are used. Summaries are short paraphrases of the original descriptions, not additional verified claims. Prices and availability require confirmation with Miriam.

By default this is a **manual snapshot**, not a live connection. The custom connector in `api/` can discover future adverts and synchronize changes and withdrawals after deployment and the portal's written permission. It is built but **disabled and not deployed**. See [connector setup and safeguards](api/README.md). Visitors' browsers never scrape the portal.

## Pages

- `index.html`: all four adverts, buy/rent search and type filters.
- `listings.html`: full catalogue with client-side location, type and price filters.
- `listing-detail.html?id=JuMU40TtrqX`: real photo gallery, factual specifications, source and broker contact links.
- `about.html`: agency information and redacted broker certificate.
- `contact.html`: contact form UI.

Unknown or withdrawn listing IDs show an unavailable state, never another property's details. Empty rental filters stay empty. Map links search the advertised street; they do not claim a verified parcel location.

Property-specific enquiries go to the original portal advert. General contact forms preserve the WhatsApp destination already configured in the GitHub repository: `421917962233`. Submission opens a prefilled WhatsApp message in the selected language; visitors must complete sending there. The site does not claim automatic delivery, and entered data is retained.

## Optional Listing Feed

The default catalogue requires no network request and works from a local HTML file. Set the actual approved API endpoint in `assets/config.js` to replace it. The empty default keeps integration disabled. Never put the API refresh secret in this public file. A head meta tag can also override the configuration:

```html
<meta name="properly-listings-source" content="https://your-approved-endpoint.example/listings.json">
```

It must return an array or `{ "listings": [...] }` and allow cross-origin access from the site's domain. Each record requires `id`, `mode` (`buy` or `rent`), `type`, `location`, `title`, and `sourceUrl`. Types support apartment, house, commercial, cottage, land, garage and other. Known `priceValue` and `area` must be factual positive numbers; unknown values should be null. Photos must be actual source photographs; an empty array shows a no-photo state. Optional fields include `address`, `rooms`, `description`, `specs`, `checkedAt`, `sourceUpdatedAt`, `coverIndex`, `relatedListingId` and `priceText`. Text fields can use `sk/en/tr/ru` objects. Filters include new locations/types automatically. No synthetic description or image is inserted when data is missing.

The feed is validated before replacing the stored catalogue. If loading fails, the real embedded offers stay visible with a warning. A `stale: true` response also shows the warning. `refreshedAt` updates the displayed import date. Approved translations are reused only for an unchanged source version; untranslated descriptions display an original-Slovak notice. Future demonstration records must explicitly set `isSample: true` to receive a sample badge; none are included now.

## Publishing

Upload the HTML files and the complete `assets` folder to the root of the `Jet-Ai/properly.sk` repository, replacing the old versions. Remove the three obsolete `listing-*.png` sample images if they remain on GitHub. GitHub Pages should publish `main` from `/(root)`.

Local changes are not automatically uploaded or deployed to GitHub.
