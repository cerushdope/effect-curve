# Effect Curve — Chrome side panel

The same app as the web version, in Chrome's side panel. No separate codebase:
`tools/build-extension.mjs` copies `frontend/` into `extension/app/`.

## Build and load

```bash
node tools/build-extension.mjs
```

Then `chrome://extensions` → **Developer mode** on → **Load unpacked** →
select the `extension/` folder. Click the toolbar icon to open the panel.

`extension/app/` and `extension/icons/` are generated and git-ignored — build
them after a fresh clone.

## What Manifest V3 forced, and how it's handled

**No remotely-hosted code.** `client.js` loads the Supabase SDK from `esm.sh`,
which MV3 forbids and the extension CSP blocks. Rather than fork the client, it
tries the SDK and falls back to plain `fetch` against the same PostgREST
endpoints. In the extension the fallback is chosen up front, by detecting
`chrome.runtime.id` — no failed request, no console noise. The web build still
uses the SDK.

**No inline script.** The `?mock=1` bootstrap moved from an inline `<script>` in
`index.html` to `src/boot.js`.

**No root-absolute paths.** An extension page has no site root, so `/src/app.js`
404s. All paths are relative now.

The build script fails on all three rather than shipping a blank panel — they're
otherwise silent, since nobody opens devtools on a side panel.

## Permissions: why there are none worth speaking of

The manifest requests **`sidePanel`** and nothing else. In particular it does
**not** request `host_permissions` for Supabase, so Chrome shows no
"read and change your data on…" warning at install.

That works because Supabase reflects the caller's origin back:

```
$ curl -sD - -H 'Origin: chrome-extension://abcdefghijklmnop' \
    'https://…supabase.co/rest/v1/substances?id=eq.caffeine&select=id'
Access-Control-Allow-Origin: chrome-extension://abcdefghijklmnop
```

CORS alone permits the fetch. `optional_host_permissions` is declared as a
dormant fallback: if Supabase ever tightens CORS, request it at runtime with
`chrome.permissions.request()` rather than shipping an update that adds a
required permission (which suspends the extension for every existing user until
they re-accept).

## Testing

```bash
node tools/build-extension.mjs && node tools/probe-extension.mjs
```

Loads the built extension into a real Chrome, checks the REST transport is the
one selected, runs a search, and asserts no CSP violations and no horizontal
overflow at 400px. None of that reproduces on localhost.
