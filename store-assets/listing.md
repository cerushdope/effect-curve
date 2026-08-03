# Effect Curve — Chrome Web Store Listing Copy

## Name (from manifest)
Effect Curve - How Long It Actually Lasts

Plain hyphen, not an em dash, to match the other listings (Archetype, Deja Vu,
Pixel Shelf). 41 characters -- the store truncates around 45 in some surfaces,
so the brand word survives everywhere even where the tagline doesn't.

## Summary (from manifest, max 132 chars)
See how long a dose actually lasts — a felt-effect curve over time, fitted to published onset and duration.

(107 characters, under the 132 limit.)

## Category
Well-being

Chrome's category list was renamed; "Productivity" no longer exists. Well-being
is the health/medical bucket. If a subcategory is offered, pick the health or
medical one. Second choice would be Tools, but that undersells what it is.

## Language
English (United States)

## Description
See description.txt (pasted verbatim into the dashboard).

## Single purpose statement
Effect Curve draws a graph of a substance's estimated felt effect over time, calculated in the browser from a dose and a time the user enters and from published pharmacokinetic parameters looked up from a public database.

## Permission justifications

sidePanel: The extension's entire interface is the side panel. This permission lets the toolbar icon open it. No other permission is requested.

host permissions: None are requested. The extension reads substance parameters from a public read-only Supabase database over ordinary CORS-permitted fetch. `optional_host_permissions` is declared but never requested at runtime; it exists only so the extension could ask for access later without shipping a new required permission, if that database's CORS policy ever changed.

## Remote code
No remote code is used. All JavaScript is packaged inside the extension. The web version of this app loads the Supabase client library from a CDN; the extension deliberately does not, and uses a built-in fetch path instead, because Manifest V3 forbids remotely-hosted code. This is enforced at build time — tools/build-extension.mjs fails if any packaged file statically imports a remote URL.

## Data usage
No user data is collected, transmitted, or stored.

- The substances, doses and times a user enters stay in the page's memory and are never sent anywhere. The extension uses no storage APIs at all — no chrome.storage, no localStorage, no cookies.
- The only network request is a read-only lookup of a substance's published parameters (peak time, half-life, and so on). It carries the substance name being searched. It does not carry the dose, the time, or anything else the user typed.
- No analytics, no telemetry, no advertising, no accounts, no third-party SDKs.

Nothing is sold, shared, or used for any purpose unrelated to the single purpose.

Dashboard checkboxes: tick "I do not collect or use user data" and leave every data-type box empty.

## Privacy policy URL
https://cerushdope.github.io/effect-curve/privacy.html

## Assets in out/
| File | Slot | Size |
|---|---|---|
| icon128.png | Store icon | 128×128 |
| screenshot1–5.png | Screenshots | 1280×800 |
| tile-small.png | Small promo tile | 440×280 |
| marquee.png | Marquee promo tile | 1400×560 |

Every file is written alpha-free, so they upload to any slot as-is.

The curves in every image are computed by the shipping engine from the live
database — `render.mjs` runs the real `computeSeries` and injects the result as
SVG paths. A listing image cannot show a shape the product doesn't produce, and
re-running the renderer after a model change updates the screenshots with it.

## Screenshot captions (if the dashboard asks)
1. Diazepam's half-life is 51 hours; its effect lasts about five.
2. Every curve is solved from published onset and duration.
3. The dip after the peak is part of the curve.
4. Sensible defaults you can correct in one click.
5. It refuses to draw what it doesn't know.
