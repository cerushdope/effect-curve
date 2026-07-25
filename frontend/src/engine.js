// engine.js — the curve math, IN THE BROWSER.
//
// The backend only hands over the substance parameters (Tmax, half-life,
// thresholds, components…). This module turns those numbers into curves:
//   concentration = sum of simple component shapes (superposition)
//   felt effect   = PD transform of normalized concentration
//
// Pure functions over the params object returned by GET /api/substances/{id}.
// No network, no DOM.

const LN2 = Math.log(2);
const round3 = (v) => Math.round(v * 1000) / 1000;

const keFromHalfLife = (hl) => LN2 / hl;

// Fraction of a substance's OWN peak below which the felt effect is treated as
// "faded to noise". This one number is the shared source of truth for BOTH the
// offset landmark (below, in engine) AND the window auto-fit (in app.js). They
// used to hardcode different values (0.5 absolute vs 0.03 of peak); when a peak
// exceeded ~17 the window ended before the felt curve ever dropped to 0.5, so
// the offset crossing fell off the end of the grid and rendered as "—".
// Keeping them tied to one constant makes that class of bug impossible. The
// value is higher than the old 0.03 on purpose: for a "felt effect" view, the
// long sub-perceptual tail below ~10% of peak isn't really felt, so trimming it
// keeps the axis tight — which gives the onset horizontal room instead of a
// vertical wall, and keeps a typical morning dose's offset on the same day
// rather than spilling past midnight into an ambiguous "00:10".
export const NOISE_FLOOR_FRAC = 0.1;

// ---- ka from Tmax: solve Tmax = ln(ka/ke)/(ka-ke) (bisection) -------------- //
function tmaxOfKa(ka, ke) {
  if (Math.abs(ka - ke) < 1e-12) return 1 / ke; // ka -> ke limit
  return Math.log(ka / ke) / (ka - ke);
}
function deriveKa(tmax, ke) {
  if (!(tmax > 0)) return ke * 1e4;
  const limit = 1 / ke;
  if (Math.abs(tmax - limit) < 1e-9) return ke;
  let lo, hi, decreasing;
  if (tmax < limit) { lo = ke; hi = ke * 1e4; decreasing = true; }
  else { lo = ke * 1e-4; hi = ke; decreasing = false; }
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const t = tmaxOfKa(mid, ke);
    if (decreasing) { if (t > tmax) lo = mid; else hi = mid; }
    else { if (t > tmax) hi = mid; else lo = mid; }
    if (Math.abs(hi - lo) < 1e-12) break;
  }
  return 0.5 * (lo + hi);
}

// ---- single-tau primitive shapes ------------------------------------------ //
function bateman1(t, ka, ke) {
  if (t < 0) return 0;
  if (Math.abs(ka - ke) < 1e-9) return ke * t * Math.exp(-ke * t);
  return (ka / (ka - ke)) * (Math.exp(-ke * t) - Math.exp(-ka * t));
}
function batemanBi(t, ka, k1, w1, k2, w2) {
  if (t < 0) return 0;
  const phase = (k, w) =>
    Math.abs(ka - k) < 1e-9
      ? w * t * Math.exp(-k * t)
      : (w / (ka - k)) * (Math.exp(-k * t) - Math.exp(-ka * t));
  return ka * (phase(k1, w1) + phase(k2, w2));
}
function zeroOrder(t, ke, W) {
  if (t < 0) return 0;
  if (t <= W) return (1 / ke) * (1 - Math.exp(-ke * t));
  const plateauEnd = (1 / ke) * (1 - Math.exp(-ke * W));
  return plateauEnd * Math.exp(-ke * (t - W));
}

// ---- decline rates --------------------------------------------------------- //
function declineRates(decline) {
  const p = decline.params || {};
  if (decline.type === "saturable") {
    return { rates: [keFromHalfLife(p.fallback_half_life_min)], weights: [1] };
  }
  if (p.half_life_min != null && p.half_life1_min == null) {
    return { rates: [keFromHalfLife(p.half_life_min)], weights: [1] };
  }
  return {
    rates: [keFromHalfLife(p.half_life1_min), keFromHalfLife(p.half_life2_min)],
    weights: [p.w1, p.w2],
  };
}

// ---- one component's per-unit-dose shape over an elapsed-tau array --------- //
function componentUnit(comp, tau, allComps) {
  const out = new Array(tau.length).fill(0);
  const inp = comp.input;
  const dec = comp.decline;

  if (inp.type === "from_parent") {
    const parent = allComps.find((c) => c.id === comp.feeds_id);
    const kaEff = keFromHalfLife(parent.decline.params.half_life_min); // parent elimination
    const keEff = declineRates(dec).rates[0];
    for (let i = 0; i < tau.length; i++) out[i] = bateman1(tau[i], kaEff, keEff);
    return out;
  }
  if (inp.type === "zero_order") {
    const ke = declineRates(dec).rates[0];
    const W = (inp.params || {}).window_min;
    for (let i = 0; i < tau.length; i++) out[i] = zeroOrder(tau[i], ke, W);
    return out;
  }
  if (inp.type === "instant") {
    const { rates, weights } = declineRates(dec);
    for (let i = 0; i < tau.length; i++) {
      const t = tau[i];
      if (t < 0) continue;
      let v = 0;
      for (let j = 0; j < rates.length; j++) v += weights[j] * Math.exp(-rates[j] * t);
      out[i] = v;
    }
    return out;
  }
  // first_order absorption (Bateman, single or bi-exponential decline)
  const { rates, weights } = declineRates(dec);
  const keForKa = rates[0];
  const ka = inp.params && inp.params.ka != null ? inp.params.ka : deriveKa(inp.tmax_min, keForKa);
  if (rates.length === 1) {
    for (let i = 0; i < tau.length; i++) out[i] = bateman1(tau[i], ka, rates[0]);
  } else {
    for (let i = 0; i < tau.length; i++)
      out[i] = batemanBi(tau[i], ka, rates[0], weights[0], rates[1], weights[1]);
  }
  return out;
}

// ---- sum the active-moiety components into one per-unit-dose shape --------- //
function substanceUnitShape(route, tau) {
  const comps = route.pk_components || [];
  const out = new Array(tau.length).fill(0);
  for (const comp of comps) {
    if (comp.is_active_moiety === false) continue;
    const lag = (comp.input && comp.input.lag_min) || 0;
    const shifted = lag ? tau.map((t) => t - lag) : tau;
    const u = componentUnit(comp, shifted, comps);
    const f = comp.fraction != null ? comp.fraction : 1;
    for (let i = 0; i < out.length; i++) out[i] += f * u[i];
  }
  return out;
}

// reference peak of one ref dose, on a fine grid, so g() peaks at 1.0
function referencePeak(route, span) {
  const fineStep = Math.max(0.5, span / 6000); // keep the array bounded on long spans
  const fine = [];
  for (let t = 0; t <= span; t += fineStep) fine.push(t);
  const shape = substanceUnitShape(route, fine);
  let m = 0;
  for (const v of shape) if (v > m) m = v;
  return m || 1;
}

// ---- PD transform (concentration -> felt 0..100) -------------------------- //
function emax(c, pd) {
  const n = pd.hill_n;
  const ec = Math.pow(pd.ec50, n);
  return c.map((v) => {
    const c2 = Math.max(0, v - pd.threshold);
    const num = Math.pow(c2, n);
    let f = (pd.emax * num) / (ec + num);
    if (!isFinite(f)) f = 0;
    return Math.min(100, Math.max(0, f));
  });
}
function effectSite(c, step, ke0) {
  const ce = new Array(c.length).fill(0);
  const a = ke0 * step;
  const sub = Math.max(1, Math.ceil(a));
  const aSub = a / sub;
  for (let i = 1; i < c.length; i++) {
    let val = ce[i - 1];
    const cp = c[i - 1], cc = c[i];
    for (let s = 0; s < sub; s++) val += aSub * (cp + (cc - cp) * (s / sub) - val);
    ce[i] = val;
  }
  return ce;
}
// Felt effect lags blood concentration via an effect-site compartment, so the
// onset is a smooth S-curve, not a vertical wall. The equilibration time scales
// with how fast the drug peaks (a drug that peaks in 45 min ramps gentler than
// one that peaks in 5). `effect_delay` drugs carry their own (slow) ke0.
function equilFor(route) {
  let tmax = null;
  for (const comp of route.pk_components || []) {
    if (comp.is_active_moiety === false) continue;
    if (comp.input && comp.input.tmax_min) { tmax = comp.input.tmax_min; break; }
  }
  if (tmax == null) tmax = 60; // zero-order / instant / prodrug: ~1h characteristic
  return Math.min(45, Math.max(8, 0.5 * tmax));
}

function feltFrom(c, pd, step, equilMin) {
  const ke0Min =
    pd.mechanism === "effect_delay" && pd.extras && pd.extras.ke0_min > 0
      ? pd.extras.ke0_min
      : equilMin;
  const driver = effectSite(c, step, LN2 / ke0Min);
  return emax(driver, pd);
}

function landmarksOf(grid, felt) {
  const lm = { onset_min: null, peak_min: null, peak_value: null, offset_min: null, current_value: null };
  if (!felt.length) return lm;
  let pk = 0;
  for (let i = 1; i < felt.length; i++) if (felt[i] > felt[pk]) pk = i;
  // Onset/offset = the times the curve enters/leaves the "clearly felt" band,
  // set at NOISE_FLOOR_FRAC of this substance's own peak. Because the window is
  // sized with the same fraction, the offset crossing is always inside the grid.
  const cut = Math.max(1, NOISE_FLOOR_FRAC * felt[pk]);
  for (let i = 0; i <= pk; i++) if (felt[i] >= cut) { lm.onset_min = grid[i]; break; }
  lm.peak_min = grid[pk];
  lm.peak_value = round3(felt[pk]);
  for (let i = pk; i < felt.length; i++) if (felt[i] < cut) { lm.offset_min = grid[i]; break; }
  return lm;
}

function routeOf(sub) {
  const routes = sub.facts && sub.facts.routes;
  if (!routes || !routes.length) return null;
  return routes.find((r) => r.id === sub.routeId) || routes[0];
}

/**
 * Build per-substance felt/concentration series from the cached params.
 * @param {Array} substances  active substances (each with .facts, .doses, .color, .muted)
 * @param {{start:number,end_min:number,step_min:number}} window
 * @returns {{grid_min:number[], series:object[]}}
 */
export function computeSeries(substances, window) {
  const { start, end_min, step_min } = window;
  const grid = [];
  for (let t = start; t <= end_min; t += step_min) grid.push(t);
  const span = end_min - start;

  const series = [];
  for (const sub of substances) {
    const route = routeOf(sub);
    if (!route) continue;

    const refPeak = referencePeak(route, span);
    const c = new Array(grid.length).fill(0);
    for (const d of sub.doses) {
      const tau = grid.map((t) => t - d.time_min);
      const shape = substanceUnitShape(route, tau);
      const scale = (d.dose_mg / route.dose_ref) / refPeak;
      for (let i = 0; i < c.length; i++) c[i] += scale * shape[i];
    }

    const pd = route.pd_model;
    const felt = feltFrom(c, pd, step_min, equilFor(route));
    series.push({
      substance_id: sub.id,
      name: sub.name,
      color: sub.color,
      felt_effect: felt.map(round3),
      concentration: c.map(round3),
      landmarks: landmarksOf(grid, felt),
      threshold: pd.threshold,
      muted: !!sub.muted,
      breaks_superposition: !!route.breaks_superposition,
      confidence: (sub.facts && sub.facts.confidence) || "low",
    });
  }
  return { grid_min: grid, series };
}
