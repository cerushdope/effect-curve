// client.js — data client backed by Supabase (hosted Postgres + auto REST API).
//
// The frontend talks DIRECTLY to Supabase; there is no app server to run. The
// publishable key below is safe to ship in client code: a row-level-security
// policy makes the data read-only (see the SQL in the project README/setup).
// All curve math still runs in the browser (engine.js); Supabase only stores
// and searches the substance PARAMETERS.
//
// TWO TRANSPORTS
//
// The SDK is loaded from esm.sh at runtime, which is fine on the web and
// impossible in a Chrome extension: Manifest V3 forbids remotely-hosted code,
// and the extension page's CSP blocks the import outright. Rather than fork the
// client, we try the SDK and fall back to plain fetch against the same
// PostgREST endpoints. The REST path has no dependencies and works everywhere —
// including from Node, which is how tools/validate.mjs talks to the same data.
//
// Supabase reflects the caller's Origin in Access-Control-Allow-Origin,
// including `chrome-extension://…`, so the fallback needs NO host permission in
// the extension manifest. That is why the extension installs without a
// "read your data on…" warning.
//
// If window.EFFECT_CURVE_MOCK is true (?mock=1), we transparently use ./mock.js
// so the UI is demoable with no network at all.

import { applyPkFix } from "../data/felt.js";

const SUPABASE_URL = "https://qzjvwxuwghegkfxmmseh.supabase.co";
const SUPABASE_KEY = "sb_publishable_SVnNGLJnxTy2-nz0nOYDMw_9sgAg6UH";

// ---- transport selection --------------------------------------------------- //
// `null` = not yet decided, `false` = SDK unavailable, use REST.
let _sdk;

/** Extensions and any other CSP-restricted host must not even attempt the import. */
function remoteImportBlocked() {
  return (
    typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id)
  ) || (typeof location !== "undefined" && location.protocol === "chrome-extension:");
}

async function sdk() {
  if (_sdk !== undefined) return _sdk;
  if (remoteImportBlocked()) {
    _sdk = false;
    return _sdk;
  }
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    _sdk = createClient(SUPABASE_URL, SUPABASE_KEY);
  } catch (e) {
    // Offline, blocked by CSP, or esm.sh is down. REST covers all three.
    console.warn("Supabase SDK unavailable, using REST transport.", e && e.message);
    _sdk = false;
  }
  return _sdk;
}

// ---- REST transport -------------------------------------------------------- //
async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) {
    throw new ApiError(`Supabase returned ${res.status}`, { status: res.status, cause: await res.text() });
  }
  return res.json();
}

// ---- optional standalone mock (?mock=1) ----------------------------------- //
let _mockModule = null;
async function mock() {
  if (!_mockModule) _mockModule = await import("./mock.js");
  return _mockModule;
}
function mockEnabled() {
  return typeof window !== "undefined" && window.EFFECT_CURVE_MOCK === true;
}

/** A data-layer error the UI can surface with a "what to do" message. */
export class ApiError extends Error {
  constructor(message, { status = 0, cause = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.cause = cause;
  }
}

/**
 * Search / autocomplete over name + aliases (fuzzy, via the search_substances
 * SQL function). An empty query returns a default list of suggestions.
 * @param {string} q
 * @returns {Promise<import("./contract.js").SubstanceSummary[]>}
 */
export async function search(q) {
  if (mockEnabled()) return (await mock()).search(q);
  const client = await sdk();
  if (client) {
    const { data, error } = await client.rpc("search_substances", { q: q || "" });
    if (error) throw new ApiError(error.message, { cause: error });
    return data || [];
  }
  return (await rest("rpc/search_substances", {
    method: "POST",
    body: JSON.stringify({ q: q || "" }),
  })) || [];
}

/**
 * Full Substance record (the nested params the engine reads), stored as JSONB.
 * @param {string} id
 * @returns {Promise<import("./contract.js").Substance>}
 */
export async function getSubstance(id) {
  if (mockEnabled()) return applyPkFix((await mock()).getSubstance(id));

  let record;
  const client = await sdk();
  if (client) {
    const { data, error } = await client.from("substances").select("record").eq("id", id).single();
    if (error) throw new ApiError(error.message, { cause: error });
    record = data.record;
  } else {
    const rows = await rest(`substances?id=eq.${encodeURIComponent(id)}&select=record&limit=1`);
    if (!rows.length) throw new ApiError(`No substance with id ${id}`, { status: 404 });
    record = rows[0].record;
  }

  // A handful of records have PK that is demonstrably wrong or structurally
  // incomplete (an XR Tmax applied to the IR route, a single-exponential
  // decline where the felt effect tracks the distribution phase). Patched here,
  // at the data layer, so the engine still only ever sees plain parameters.
  return applyPkFix(record);
}

/** Which transport ended up in use — for diagnostics, not for control flow. */
export async function transport() {
  return (await sdk()) ? "sdk" : "rest";
}
