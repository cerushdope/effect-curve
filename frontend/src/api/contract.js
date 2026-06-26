// contract.js — JSDoc typedefs mirroring backend/app/models.py and docs/API_CONTRACT.md.
// Also: the substance color palette and a stable substance_id -> color assignment.
//
// TIME IS INTEGER MINUTES from window start. Colors are assigned CLIENT-SIDE.

// --------------------------------------------------------------------------- //
// Domain typedefs (subset the UI consumes).                                   //
// --------------------------------------------------------------------------- //

/**
 * @typedef {Object} SubstanceSummary
 * @property {string} id
 * @property {string} name
 * @property {string} category
 * @property {string[]} [aliases]
 */

/**
 * @typedef {Object} DoseRange
 * @property {number} min
 * @property {number} typical
 * @property {number} max
 */

/**
 * @typedef {Object} PDModel
 * @property {number} threshold  fraction of ref-peak; felt onset/offset boundary
 * @property {number} emax
 * @property {number} ec50
 * @property {number} hill_n
 * @property {string} mechanism
 * @property {Object.<string, number>} [extras]
 */

/**
 * @typedef {Object} Route
 * @property {string} id
 * @property {string} route_type
 * @property {string} formulation
 * @property {number} bioavailability_F
 * @property {number} dose_ref
 * @property {DoseRange} dose_range
 * @property {Array<Object>} pk_components
 * @property {PDModel} pd_model
 * @property {boolean} [breaks_superposition]
 */

/**
 * @typedef {Object} Landmark
 * @property {number} value
 * @property {string} [unit]
 * @property {string} [source]
 * @property {string} [source_type]
 * @property {string} [confidence]   "high" | "med" | "low"
 */

/**
 * @typedef {Object} Substance
 * @property {string} id
 * @property {string} name
 * @property {string} category
 * @property {string[]} [aliases]
 * @property {string} [unit]   "mg" | "mcg" | "IU"
 * @property {Route[]} routes
 * @property {Object.<string, Landmark>} [landmarks]
 * @property {string} [confidence]
 * @property {string} [notes]
 */

// --------------------------------------------------------------------------- //
// API request / response typedefs (POST /api/compute).                        //
// --------------------------------------------------------------------------- //

/**
 * @typedef {Object} DoseEvent
 * @property {string} substance_id
 * @property {string} route_id
 * @property {number} dose_mg
 * @property {number} time_min   integer minutes from window start
 */

/**
 * @typedef {Object} Window
 * @property {number} start
 * @property {number} end_min
 * @property {number} step_min
 */

/**
 * @typedef {Object} ComputeRequest
 * @property {Window} window
 * @property {number|null} [now_min]
 * @property {DoseEvent[]} events
 */

/**
 * @typedef {Object} Landmarks
 * @property {number|null} [onset_min]
 * @property {number|null} [peak_min]
 * @property {number|null} [peak_value]
 * @property {number|null} [offset_min]
 * @property {number|null} [current_value]
 */

/**
 * @typedef {Object} SeriesOut
 * @property {string} substance_id
 * @property {string} name
 * @property {number[]} felt_effect    0..100, aligned to grid_min
 * @property {number[]} concentration  normalized (ref peak = 1.0)
 * @property {Landmarks} landmarks
 * @property {boolean} [breaks_superposition]
 * @property {string} [confidence]
 */

/**
 * @typedef {Object} ComputeResponse
 * @property {number[]} grid_min
 * @property {SeriesOut[]} series
 */

// --------------------------------------------------------------------------- //
// Color palette (8 matched-saturation hues) + stable assignment.             //
// The chart never chooses colors; the app passes them in.                     //
// --------------------------------------------------------------------------- //

/** @type {string[]} ordered palette — assigned in order to active substances. */
export const SUBSTANCE_PALETTE = [
  "#2E8B8B", // teal
  "#C98A2B", // amber
  "#C2557A", // rose
  "#6E5AA6", // violet
  "#5C8A3A", // leaf
  "#D2603A", // coral
  "#3A6EA5", // blue
  "#9A7B2E", // ochre
];

// Stable map of substance_id -> assigned color, so renders are consistent.
const _assigned = new Map();
// Track which palette slots are in use so removed substances free their hue.
const _usedColors = new Set();

/**
 * Assign (or fetch) a stable color for a substance id.
 * Picks the next free palette slot; falls back to deterministic hashing if the
 * palette is exhausted so a 9th+ substance still gets a usable, stable color.
 * @param {string} substanceId
 * @returns {string} CSS color string
 */
export function colorForSubstance(substanceId) {
  if (_assigned.has(substanceId)) return _assigned.get(substanceId);

  // Find first unused palette slot.
  let chosen = null;
  for (const c of SUBSTANCE_PALETTE) {
    if (!_usedColors.has(c)) {
      chosen = c;
      break;
    }
  }
  if (chosen == null) {
    // Palette exhausted: deterministic fallback hue from the id.
    let h = 0;
    for (let i = 0; i < substanceId.length; i++) {
      h = (h * 31 + substanceId.charCodeAt(i)) >>> 0;
    }
    chosen = `hsl(${h % 360} 42% 45%)`;
  }
  _assigned.set(substanceId, chosen);
  _usedColors.add(chosen);
  return chosen;
}

/**
 * Release a substance's color slot back to the palette (call on remove).
 * @param {string} substanceId
 */
export function releaseColor(substanceId) {
  const c = _assigned.get(substanceId);
  if (c != null) {
    _assigned.delete(substanceId);
    _usedColors.delete(c);
  }
}
