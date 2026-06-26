// client.js — async API client for the FastAPI backend.
// Same-origin base URL ("" => relative). On network failure, if
// window.EFFECT_CURVE_MOCK is true, transparently fall back to ./mock.js so the
// UI is demoable standalone.

/** @typedef {import("./contract.js").SubstanceSummary} SubstanceSummary */
/** @typedef {import("./contract.js").Substance} Substance */
/** @typedef {import("./contract.js").ComputeRequest} ComputeRequest */
/** @typedef {import("./contract.js").ComputeResponse} ComputeResponse */

const BASE = ""; // same origin

let _mockModule = null;
async function mock() {
  if (!_mockModule) _mockModule = await import("./mock.js");
  return _mockModule;
}

function mockEnabled() {
  return typeof window !== "undefined" && window.EFFECT_CURVE_MOCK === true;
}

/** A network/server error the UI can surface with a "what to do" message. */
export class ApiError extends Error {
  constructor(message, { status = 0, cause = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.cause = cause;
  }
}

async function getJSON(path) {
  let res;
  try {
    res = await fetch(BASE + path, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new ApiError("network", { cause: e });
  }
  if (!res.ok) {
    throw new ApiError(`HTTP ${res.status}`, { status: res.status });
  }
  return res.json();
}

async function postJSON(path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError("network", { cause: e });
  }
  if (!res.ok) {
    throw new ApiError(`HTTP ${res.status}`, { status: res.status });
  }
  return res.json();
}

/**
 * Search / autocomplete over name + aliases.
 * @param {string} q
 * @returns {Promise<SubstanceSummary[]>}
 */
export async function search(q) {
  const path = `/api/substances?q=${encodeURIComponent(q || "")}`;
  try {
    return await getJSON(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 0 && mockEnabled()) {
      return (await mock()).search(q);
    }
    throw e;
  }
}

/**
 * Full Substance record.
 * @param {string} id
 * @returns {Promise<Substance>}
 */
export async function getSubstance(id) {
  const path = `/api/substances/${encodeURIComponent(id)}`;
  try {
    return await getJSON(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 0 && mockEnabled()) {
      return (await mock()).getSubstance(id);
    }
    throw e;
  }
}

/**
 * The draw call.
 * @param {ComputeRequest} payload
 * @returns {Promise<ComputeResponse>}
 */
export async function compute(payload) {
  try {
    return await postJSON("/api/compute", payload);
  } catch (e) {
    if (e instanceof ApiError && e.status === 0 && mockEnabled()) {
      return (await mock()).compute(payload);
    }
    throw e;
  }
}
