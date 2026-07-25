// client.js — data client backed by Supabase (hosted Postgres + auto REST API).
//
// The frontend talks DIRECTLY to Supabase; there is no app server to run. The
// publishable key below is safe to ship in client code: a row-level-security
// policy makes the data read-only (see the SQL in the project README/setup).
// All curve math still runs in the browser (engine.js); Supabase only stores
// and searches the substance PARAMETERS.
//
// If window.EFFECT_CURVE_MOCK is true (?mock=1), we transparently use ./mock.js
// so the UI is demoable with no network at all.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/** @typedef {import("./contract.js").SubstanceSummary} SubstanceSummary */
/** @typedef {import("./contract.js").Substance} Substance */

const SUPABASE_URL = "https://qzjvwxuwghegkfxmmseh.supabase.co";
const SUPABASE_KEY = "sb_publishable_SVnNGLJnxTy2-nz0nOYDMw_9sgAg6UH";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
 * @returns {Promise<SubstanceSummary[]>}
 */
export async function search(q) {
  if (mockEnabled()) return (await mock()).search(q);
  const { data, error } = await supabase.rpc("search_substances", { q: q || "" });
  if (error) throw new ApiError(error.message, { cause: error });
  return data || [];
}

/**
 * Full Substance record (the nested params the engine reads), stored as JSONB.
 * @param {string} id
 * @returns {Promise<Substance>}
 */
export async function getSubstance(id) {
  if (mockEnabled()) return (await mock()).getSubstance(id);
  const { data, error } = await supabase
    .from("substances")
    .select("record")
    .eq("id", id)
    .single();
  if (error) throw new ApiError(error.message, { cause: error });
  return data.record;
}
