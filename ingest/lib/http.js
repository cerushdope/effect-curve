// http.js — polite HTTP with retry, throttling and an on-disk cache.
//
// Rate limits we deliberately stay under:
//   RxNav          20 req/s per IP (NLM ToS). We use 5/s and cache, since NLM
//                  also asks callers to cache results for 12–24 h.
//   Wikidata WDQS  no hard number published; policy requires a descriptive
//                  User-Agent. We send one and issue only a handful of queries.
//   openFDA        we use the bulk download host, which is the route openFDA
//                  publishes for bulk consumers — the API rate limit does not
//                  apply to it.

import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";

export const USER_AGENT =
  "EffectCurve-Ingest/1.0 (https://github.com/cerushdope/effect-curve; personal wellness project)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Simple minimum-interval throttle, one per host. */
const lastCall = new Map();
async function throttle(key, minIntervalMs) {
  const prev = lastCall.get(key) || 0;
  const wait = prev + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(key, Date.now());
}

/**
 * GET a URL and parse it as JSON, with retry/backoff and optional throttling.
 * @param {string} url
 * @param {{throttleKey?:string, minIntervalMs?:number, retries?:number, headers?:object}} [opts]
 */
export async function getJSON(url, opts = {}) {
  const { throttleKey = new URL(url).host, minIntervalMs = 200, retries = 4, headers = {} } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(throttleKey, minIntervalMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * Download a URL to disk, resuming/skipping when the file is already complete.
 * Streams straight to the filesystem — never buffers the body in memory.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<{path:string, bytes:number, cached:boolean}>}
 */
export async function download(url, destPath) {
  await mkdir(path.dirname(destPath), { recursive: true });

  // Ask for the size first so we can skip an already-complete download.
  let expected = 0;
  try {
    const head = await fetch(url, { method: "HEAD", headers: { "User-Agent": USER_AGENT } });
    expected = Number(head.headers.get("content-length") || 0);
  } catch { /* HEAD is best-effort */ }

  try {
    const st = await stat(destPath);
    if (expected > 0 && st.size === expected) {
      return { path: destPath, bytes: st.size, cached: true };
    }
    await rm(destPath, { force: true }); // partial or stale — start clean
  } catch { /* not present yet */ }

  let lastErr;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
      const st = await stat(destPath);
      if (expected > 0 && st.size !== expected) {
        throw new Error(`short read: got ${st.size} of ${expected} bytes`);
      }
      return { path: destPath, bytes: st.size, cached: false };
    } catch (err) {
      lastErr = err;
      await rm(destPath, { force: true });
      if (attempt < 3) await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Stable cache filename for a URL. */
export function cacheKey(url, ext = ".json") {
  return createHash("sha1").update(url).digest("hex").slice(0, 16) + ext;
}
