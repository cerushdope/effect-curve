// state.js — a tiny observable store.
//
// Holds the active substances, their dose rows, the compute window, now_min and
// the felt/plasma mode. Subscribers are notified on any mutation; the app uses
// that to re-render (immediately) and to recompute (debounced ~250ms).

import { DEFAULT_CONDITIONS } from "./engine.js";

/**
 * @typedef {Object} ActiveSubstance
 * @property {string} id            substance_id
 * @property {string} name
 * @property {string} category
 * @property {string} color         assigned CSS color
 * @property {boolean} muted
 * @property {Object|null} facts     full Substance record (lazy-loaded)
 * @property {string} routeId        chosen route id
 * @property {string} unit           display unit ("mg" | "mcg" | "IU")
 * @property {DoseRow[]} doses
 */

/**
 * @typedef {Object} DoseRow
 * @property {string} id            local row id
 * @property {number} dose_mg
 * @property {number} time_min      integer minutes from window start
 */

let _rowSeq = 0;
export function nextRowId() {
  _rowSeq += 1;
  return `r${_rowSeq}`;
}

export function createStore() {
  /** @type {ActiveSubstance[]} */
  let substances = [];
  let win = { start: 0, end_min: 1440, step_min: 5 };
  /** @type {number|null} */
  let now_min = null;
  /** @type {"felt"|"plasma"} */
  let mode = "felt";

  const subscribers = new Set();

  function notify() {
    for (const fn of subscribers) {
      try { fn(snapshot()); } catch (e) { /* keep other subscribers alive */ console.error(e); }
    }
  }

  function snapshot() {
    return {
      substances: substances.map((s) => ({
        ...s,
        conditions: { ...s.conditions },
        doses: s.doses.map((d) => ({ ...d })),
      })),
      window: { ...win },
      now_min,
      mode,
    };
  }

  return {
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    getState: snapshot,

    // ---- substances ---------------------------------------------------- //
    hasSubstance(id) {
      return substances.some((s) => s.id === id);
    },
    addSubstance(sub) {
      if (this.hasSubstance(sub.id)) return false;
      substances.push({
        id: sub.id,
        name: sub.name,
        category: sub.category || "",
        color: sub.color,
        muted: false,
        facts: sub.facts || null,
        routeId: sub.routeId || "",
        unit: sub.unit || "mg",
        // Applied automatically on the first paint, then editable on the card.
        // The alternative — asking ten questions before drawing anything — is a
        // worse trade for a tool whose whole appeal is "type a name, see a curve".
        conditions: { ...DEFAULT_CONDITIONS, ...(sub.conditions || {}) },
        doses: sub.doses && sub.doses.length
          ? sub.doses
          : [{ id: nextRowId(), dose_mg: sub.defaultDose ?? 0, time_min: 480 }], // default 08:00
      });
      notify();
      return true;
    },
    removeSubstance(id) {
      const n = substances.length;
      substances = substances.filter((s) => s.id !== id);
      if (substances.length !== n) notify();
    },
    setSubstanceFacts(id, facts, { routeId, unit } = {}) {
      const s = substances.find((x) => x.id === id);
      if (!s) return;
      s.facts = facts;
      if (routeId) s.routeId = routeId;
      if (unit) s.unit = unit;
      notify();
    },
    setCondition(id, patch) {
      const s = substances.find((x) => x.id === id);
      if (!s) return;
      s.conditions = { ...s.conditions, ...patch };
      notify();
    },
    setRoute(id, routeId) {
      const s = substances.find((x) => x.id === id);
      if (!s || !routeId) return;
      s.routeId = routeId;
      notify();
    },
    toggleMute(id) {
      const s = substances.find((x) => x.id === id);
      if (!s) return;
      s.muted = !s.muted;
      notify();
    },

    // ---- dose rows ----------------------------------------------------- //
    addDose(substanceId, dose) {
      const s = substances.find((x) => x.id === substanceId);
      if (!s) return;
      s.doses.push({
        id: nextRowId(),
        dose_mg: dose?.dose_mg ?? 0,
        time_min: dose?.time_min ?? 0,
      });
      notify();
    },
    updateDose(substanceId, rowId, patch) {
      const s = substances.find((x) => x.id === substanceId);
      if (!s) return;
      const row = s.doses.find((d) => d.id === rowId);
      if (!row) return;
      if (patch.dose_mg != null) row.dose_mg = patch.dose_mg;
      if (patch.time_min != null) row.time_min = patch.time_min;
      notify();
    },
    removeDose(substanceId, rowId) {
      const s = substances.find((x) => x.id === substanceId);
      if (!s) return;
      s.doses = s.doses.filter((d) => d.id !== rowId);
      notify();
    },

    // ---- window / now / mode ------------------------------------------- //
    setWindow(w) {
      win = { ...win, ...w };
      notify();
    },
    setNow(min) {
      now_min = min;
      notify();
    },
    setMode(m) {
      if (m !== "felt" && m !== "plasma") return;
      mode = m;
      notify();
    },
    getMode() { return mode; },
  };
}
