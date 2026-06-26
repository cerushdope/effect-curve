// mock.js — a tiny standalone backend mock implementing the same
// search / getSubstance / compute shapes so the UI is demoable with no server.
// Enabled when client.js fails to reach the real API AND window.EFFECT_CURVE_MOCK.
//
// Curves here are fabricated but contract-valid (Bateman rise + Hill PD).

/** @typedef {import("./contract.js").Substance} Substance */
/** @typedef {import("./contract.js").SubstanceSummary} SubstanceSummary */
/** @typedef {import("./contract.js").ComputeRequest} ComputeRequest */
/** @typedef {import("./contract.js").ComputeResponse} ComputeResponse */

// A small subset of the 12 archetypes, enough to demo distinct shapes.
const SUBSTANCES = {
  simple_direct: {
    id: "simple_direct", name: "Stimulant (IR)", category: "stimulant",
    aliases: ["simple", "stim", "stimulant"], unit: "mg",
    confidence: "low",
    landmarks: {
      tmax_min: { value: 45, unit: "min", confidence: "low" },
      half_life_min: { value: 300, unit: "min", confidence: "low" },
    },
    routes: [{
      id: "oral_IR", route_type: "oral_IR", formulation: "immediate-release tablet",
      bioavailability_F: 0.9, dose_ref: 10,
      dose_range: { min: 5, typical: 10, max: 30 },
      pk_components: [], breaks_superposition: false,
      pd_model: { threshold: 0.08, emax: 100, ec50: 0.4, hill_n: 1.5, mechanism: "direct", extras: {} },
    }],
  },
  analgesic_ir: {
    id: "analgesic_ir", name: "Analgesic (IR)", category: "analgesic",
    aliases: ["pain", "analgesic", "nsaid"], unit: "mg",
    confidence: "low",
    landmarks: {
      tmax_min: { value: 60, unit: "min", confidence: "low" },
      half_life_min: { value: 120, unit: "min", confidence: "low" },
    },
    routes: [{
      id: "oral_IR", route_type: "oral_IR", formulation: "immediate-release tablet",
      bioavailability_F: 0.9, dose_ref: 400,
      dose_range: { min: 200, typical: 400, max: 800 },
      pk_components: [], breaks_superposition: false,
      pd_model: { threshold: 0.12, emax: 100, ec50: 0.45, hill_n: 1.2, mechanism: "direct", extras: {} },
    }],
  },
  sublingual_fast: {
    id: "sublingual_fast", name: "Sublingual (rescue)", category: "cardiovascular",
    aliases: ["sublingual", "rescue", "sl", "spray"], unit: "mg",
    confidence: "low",
    landmarks: {
      tmax_min: { value: 5, unit: "min", confidence: "low" },
      half_life_min: { value: 20, unit: "min", confidence: "low" },
    },
    routes: [{
      id: "sublingual", route_type: "sublingual", formulation: "sublingual tablet / spray",
      bioavailability_F: 0.4, dose_ref: 0.4,
      dose_range: { min: 0.3, typical: 0.4, max: 1.2 },
      pk_components: [], breaks_superposition: false,
      pd_model: { threshold: 0.05, emax: 100, ec50: 0.35, hill_n: 1.4, mechanism: "direct", extras: {} },
    }],
  },
  oros_biphasic: {
    id: "oros_biphasic", name: "Focus (OROS)", category: "stimulant",
    aliases: ["focus", "oros", "osmotic", "xr-focus"], unit: "mg",
    confidence: "low",
    landmarks: {
      tmax_min: { value: 60, unit: "min", confidence: "low" },
      half_life_min: { value: 180, unit: "min", confidence: "low" },
    },
    routes: [{
      id: "oral_XR", route_type: "oral_XR", formulation: "osmotic-release (OROS)",
      bioavailability_F: 0.9, dose_ref: 36,
      dose_range: { min: 18, typical: 36, max: 72 },
      pk_components: [], breaks_superposition: false,
      pd_model: { threshold: 0.10, emax: 100, ec50: 0.45, hill_n: 1.4, mechanism: "direct", extras: {} },
    }],
  },
};

const SUMMARIES = Object.values(SUBSTANCES).map((s) => ({
  id: s.id, name: s.name, category: s.category, aliases: s.aliases,
}));

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

// Bateman-style normalized concentration for a first-order in / first-order out,
// scaled so the reference dose peaks near c=1.0.
function batemanCurve(tGrid, tmaxMin, halfLifeMin, doseScale, lagMin) {
  const ke = Math.LN2 / halfLifeMin;
  // ka chosen so tmax matches: tmax = ln(ka/ke)/(ka-ke). Solve roughly by making
  // ka a few-fold faster than ke, then nudging. Simple stable approximation:
  let ka = ke * 4;
  // Iterate ka so the analytic tmax lands near the requested tmax.
  for (let i = 0; i < 40; i++) {
    if (Math.abs(ka - ke) < 1e-9) { ka = ke * 1.0001; }
    const tm = Math.log(ka / ke) / (ka - ke);
    if (!isFinite(tm) || tm <= 0) { ka *= 1.5; continue; }
    ka *= tm / tmaxMin;
    if (ka <= ke) ka = ke * 1.0001;
  }
  const tmAnalytic = Math.log(ka / ke) / (ka - ke);
  const peakShape = Math.exp(-ke * tmAnalytic) - Math.exp(-ka * tmAnalytic);
  const norm = peakShape > 1e-9 ? 1 / peakShape : 1;
  return tGrid.map((t) => {
    const tt = t - lagMin;
    if (tt <= 0) return 0;
    const c = (Math.exp(-ke * tt) - Math.exp(-ka * tt)) * norm * doseScale;
    return c > 0 ? c : 0;
  });
}

function hillPD(conc, pd) {
  const { threshold, emax, ec50, hill_n } = pd;
  return conc.map((c) => {
    if (c <= threshold) return 0;
    const num = Math.pow(c, hill_n);
    const den = Math.pow(ec50, hill_n) + num;
    return clamp((emax * num) / den, 0, 100);
  });
}

function landmarksFor(grid, felt, threshold, nowMin) {
  let onset = null, offset = null, peakMin = null, peakValue = null, current = null;
  let maxV = -1;
  for (let i = 0; i < grid.length; i++) {
    const v = felt[i];
    if (v > maxV) { maxV = v; peakMin = grid[i]; peakValue = v; }
    if (onset == null && v > 0.5) onset = grid[i];
  }
  for (let i = grid.length - 1; i >= 0; i--) {
    if (felt[i] > 0.5) { offset = grid[i]; break; }
  }
  if (nowMin != null) {
    // nearest grid point
    let best = 0, bd = Infinity;
    for (let i = 0; i < grid.length; i++) {
      const d = Math.abs(grid[i] - nowMin);
      if (d < bd) { bd = d; best = i; }
    }
    current = felt[best];
  }
  if (peakValue != null && peakValue < 0.5) { onset = null; offset = null; }
  return {
    onset_min: onset, peak_min: peakMin, peak_value: peakValue,
    offset_min: offset, current_value: current,
  };
}

/** @param {string} q @returns {Promise<SubstanceSummary[]>} */
export async function search(q) {
  const qq = (q || "").trim().toLowerCase();
  if (!qq) return SUMMARIES.slice();
  return SUMMARIES.filter((s) =>
    [s.id, s.name, s.category, ...(s.aliases || [])].join(" ").toLowerCase().includes(qq)
  );
}

/** @param {string} id @returns {Promise<Substance>} */
export async function getSubstance(id) {
  const s = SUBSTANCES[id];
  if (!s) throw new Error("not found");
  return JSON.parse(JSON.stringify(s));
}

/** @param {ComputeRequest} payload @returns {Promise<ComputeResponse>} */
export async function compute(payload) {
  const w = payload.window || { start: 0, end_min: 1440, step_min: 5 };
  const grid = [];
  for (let t = w.start; t <= w.end_min; t += w.step_min) grid.push(t);

  // Group events by substance (server sums same-substance doses).
  const bySub = new Map();
  for (const ev of payload.events || []) {
    if (!bySub.has(ev.substance_id)) bySub.set(ev.substance_id, []);
    bySub.get(ev.substance_id).push(ev);
  }

  const series = [];
  for (const [sid, events] of bySub) {
    const sub = SUBSTANCES[sid];
    if (!sub) continue;
    const route = sub.routes[0];
    const pd = route.pd_model;
    const tmax = sub.landmarks?.tmax_min?.value ?? 45;
    const hl = sub.landmarks?.half_life_min?.value ?? 180;

    // Superpose per-dose Bateman curves scaled by dose/dose_ref.
    const conc = new Array(grid.length).fill(0);
    for (const ev of events) {
      const scale = ev.dose_mg / route.dose_ref;
      const shifted = grid.map((t) => t - ev.time_min);
      const c = batemanCurve(shifted, tmax, hl, scale, 0);
      for (let i = 0; i < conc.length; i++) conc[i] += c[i];
    }
    const felt = hillPD(conc, pd);
    series.push({
      substance_id: sid,
      name: sub.name,
      felt_effect: felt,
      concentration: conc,
      landmarks: landmarksFor(grid, felt, pd.threshold, payload.now_min),
      breaks_superposition: !!route.breaks_superposition,
      confidence: sub.confidence || "low",
    });
  }
  return { grid_min: grid, series };
}
