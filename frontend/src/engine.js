// engine.js — the curve math, IN THE BROWSER.
//
// The backend only hands over the substance parameters (Tmax, half-life,
// thresholds, components…). This module turns those numbers into curves:
//   concentration = sum of simple component shapes (superposition)
//   felt effect   = PD transform of normalized concentration
//
// Pure functions over the params object returned by the data layer.
// No network, no DOM.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED IN THE PD REWRITE (see docs/reframe.md)
//
// The PD half used to carry class-assigned constants that were never fitted to
// anything: every stimulant got ec50 0.4 / hill 2 / threshold 0.2, every
// benzodiazepine 0.45 / 1.9 / 0.2. Timing came from real label PK; how it FEELS
// came from a guess. Two consequences:
//
//   1. Felt duration tracked elimination half-life. Diazepam (t½ 51 h) drew a
//      two-day curve; the felt effect of a 5 mg tablet is 4–6 h, because what
//      you feel tracks the distribution phase, not the terminal one.
//   2. Peak height carried no information — every drug landed ~70-80 at its own
//      typical dose, because the same sigmoid was applied to the same
//      normalized concentration.
//
// Now: PD is FITTED per drug to two published observables — time to noticeable
// onset, and duration of noticeable effect (frontend/src/data/felt.js). The fit
// solves for the effect-site rate from onset and the threshold from duration.
// This absorbs upstream PK error rather than compounding it: if the half-life
// we were handed is too long, the fitted threshold rises to compensate and the
// felt curve still ends when it really ends.
//
// And felt intensity is no longer a pure function of LEVEL. An adaptive
// baseline chases the drug (dA/dt = kA·(Ce − A)) and the response is driven by
// Ce − γ·A. One mechanism, three behaviours the old model could not produce:
// rate-dependence (a fast rise outruns A), acute tolerance (the descending limb
// feels weaker at matched level), and the crash (A outlasts Ce, so the drive
// goes negative and the curve dips below baseline).
// ---------------------------------------------------------------------------

import {
  pdClassFor, classNameFor, feltFor, applyPkFix,
  TOLERANCE_LEVELS, FOOD_LEVELS, foodAffects,
} from "./data/felt.js";

const LN2 = Math.log(2);
const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const keFromHalfLife = (hl) => LN2 / hl;

// The felt-effect value at which something goes from "technically present" to
// "you'd notice". Absolute, on the 0..100 axis — NOT a fraction of the peak.
//
// It used to be 10% of each substance's own peak, which made the landmark
// definition circular: a bigger dose pushed its own onset later and its own
// offset earlier. An absolute floor is also what "duration of action" means in
// the literature we fit against, so the fit and the landmark now agree by
// construction.
export const FELT_FLOOR = 5;

// A typical dose peaks HERE by convention. This is the y-axis decision the
// reframe asked for, resolved as "per-drug relative": 100 is not a shared
// cross-drug scale, it is this drug's ceiling, and a typical dose lands at 70
// with headroom above it so a double dose visibly reads as more.
const REF_PEAK_EFFECT = 70;

// Fraction of peak below which a BLOOD-LEVEL curve is treated as done. Only
// used to size the time window in plasma mode, where there is no perceptual
// floor to appeal to.
export const PLASMA_FLOOR_FRAC = 0.05;

export const DEFAULT_CONDITIONS = { food: "empty", tolerance: "occasional" };

// ---- ka from Tmax: solve Tmax = ln(ka/ke)/(ka-ke) (bisection) -------------- //
function tmaxOfKa(ka, ke) {
  if (Math.abs(ka - ke) < 1e-12) return 1 / ke; // ka -> ke limit
  return Math.log(ka / ke) / (ka - ke);
}
// tmaxOfKa DECREASES monotonically as ka rises — on both sides of ka == ke.
// ka > ke is the ordinary case. ka < ke is flip-flop kinetics: absorption is
// slower than elimination, so absorption rate-limits the tail. Real drugs do
// this, and Tmax > 1/ke is exactly how it shows up in the numbers.
function deriveKa(tmax, ke) {
  if (!(tmax > 0)) return ke * 1e4;
  const limit = 1 / ke;
  if (Math.abs(tmax - limit) < 1e-9) return ke;

  let lo, hi;
  if (tmax < limit) { lo = ke; hi = ke * 1e4; } // fast absorption
  else { lo = ke * 1e-4; hi = ke; }             // flip-flop
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (tmaxOfKa(mid, ke) > tmax) lo = mid;
    else hi = mid;
    if (Math.abs(hi - lo) < 1e-15) break;
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
    // Michaelis–Menten is handled by its own integrator (simulateSaturable).
    // This linear fallback is only used where a rate is needed structurally,
    // e.g. deriving ka from Tmax.
    return { rates: [keFromHalfLife(p.fallback_half_life_min || 90)], weights: [1] };
  }
  if (p.half_life_min != null && p.half_life1_min == null) {
    return { rates: [keFromHalfLife(p.half_life_min)], weights: [1] };
  }
  return {
    rates: [keFromHalfLife(p.half_life1_min), keFromHalfLife(p.half_life2_min)],
    weights: [p.w1, p.w2],
  };
}

// The rate at which a parent hands substance to its metabolite. For a
// bi-exponential parent there is no single `half_life_min`, and reading it blind
// produced NaN — take the terminal (slowest) phase, which is what actually
// rate-limits metabolite formation once distribution is over.
function parentTransferRate(parent) {
  const { rates } = declineRates(parent.decline);
  return Math.min(...rates.filter((r) => isFinite(r) && r > 0));
}

// ---- one component's per-unit-dose shape over an elapsed-tau array --------- //
function componentUnit(comp, tau, allComps) {
  const out = new Array(tau.length).fill(0);
  const inp = comp.input;
  const dec = comp.decline;

  if (inp.type === "from_parent") {
    const parent = allComps.find((c) => c.id === comp.feeds_id) || allComps[0];
    const kaEff = parentTransferRate(parent);
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

function linGrid(from, to, step) {
  const g = [];
  for (let t = from; t <= to; t += step) g.push(t);
  return g;
}

// reference peak of one ref dose, on a fine grid, so g() peaks at 1.0
function referencePeak(route, span) {
  const fineStep = Math.max(0.5, span / 6000); // keep the array bounded on long spans
  const shape = substanceUnitShape(route, linGrid(0, span, fineStep));
  let m = 0;
  for (const v of shape) if (v > m) m = v;
  return m || 1;
}

// ---------------------------------------------------------------------------- //
// Bioavailability.                                                             //
// ---------------------------------------------------------------------------- //
// `bioavailability_F` was populated in every record and read in none of them.
// It is only load-bearing if the normalization is anchored to ONE route: then
// swapping oral for IV at matched mg shows the first-pass difference instead of
// silently cancelling. So the whole substance is normalized to its reference
// route (routes[0] — the ingest's primary), and other routes scale by F.
function fOf(route) {
  const f = route.bioavailability_F;
  return typeof f === "number" && f > 0 ? f : 1;
}
function referenceRoute(facts) {
  const routes = (facts && facts.routes) || [];
  return routes.find((r) => r.id === facts.reference_route_id) || routes[0] || null;
}

// ---------------------------------------------------------------------------- //
// Food — a Tmax multiplier, i.e. a shape change.                               //
// ---------------------------------------------------------------------------- //
// Food shifts Tmax by 1–2 h through gastric emptying. Because Tmax pins the
// entire absorption shape, this changes when the curve rises and how sharply,
// not just how high it gets.
function withFood(route, conditions) {
  const level = FOOD_LEVELS[(conditions && conditions.food) || "empty"] || FOOD_LEVELS.empty;
  if (level.tmax_mult === 1 && !level.lag_add_min) return route;
  if (!foodAffects(route.id, route.route_type)) return route;
  const mult = route.food_tmax_mult != null ? route.food_tmax_mult : level.tmax_mult;
  return {
    ...route,
    pk_components: (route.pk_components || []).map((c) => {
      if (!c.input || c.input.type !== "first_order") return c;
      return {
        ...c,
        input: {
          ...c.input,
          tmax_min: c.input.tmax_min != null ? c.input.tmax_min * mult : c.input.tmax_min,
          lag_min: (c.input.lag_min || 0) + level.lag_add_min,
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------- //
// Saturable elimination (Michaelis–Menten).                                    //
// ---------------------------------------------------------------------------- //
// `declineRates` used to return a plain first-order rate for `saturable`, i.e.
// the flag existed and did nothing. Real MM elimination is roughly linear decay
// at concentrations well above Km — which is why blood alcohol falls in a
// straight line and why doses are not additive.
//
// Integrated in normalized units (1.0 = the reference-dose peak), so vmax is
// "reference peaks cleared per minute" and km is a fraction of that peak.
function isSaturable(route) {
  return (route.pk_components || []).some((c) => c.decline && c.decline.type === "saturable");
}
function simulateSaturable(route, doses, grid, amountScale) {
  const comp = (route.pk_components || []).find((c) => c.decline.type === "saturable");
  const p = comp.decline.params || {};
  const vmax = p.vmax_per_min > 0 ? p.vmax_per_min : 0.0125;
  const km = p.km > 0 ? p.km : 0.05;
  const ke = keFromHalfLife(p.fallback_half_life_min || 90);
  const ka = comp.input && comp.input.tmax_min ? deriveKa(comp.input.tmax_min, ke) : 0.05;

  const step = grid.length > 1 ? grid[1] - grid[0] : 5;
  const sub = Math.max(1, Math.ceil(step / 2)); // ≤2 min integration steps
  const h = step / sub;

  const out = new Array(grid.length).fill(0);
  let gut = 0, c = 0;
  // doses that land before the window still count — pre-load by integrating
  // from the earliest dose rather than from the window start.
  const sorted = [...doses].sort((a, b) => a.time_min - b.time_min);
  let di = 0;
  const t0 = Math.min(grid[0], sorted.length ? sorted[0].time_min : grid[0]);

  let t = t0;
  let gi = 0;
  const tEnd = grid[grid.length - 1];
  while (t <= tEnd + 1e-9) {
    while (di < sorted.length && sorted[di].time_min <= t + 1e-9) {
      gut += sorted[di].amount * amountScale;
      di++;
    }
    while (gi < grid.length && grid[gi] <= t + 1e-9) {
      out[gi] = c;
      gi++;
    }
    for (let s = 0; s < sub; s++) {
      const absorbed = ka * gut;
      const eliminated = (vmax * c) / (km + c);
      gut += -absorbed * h;
      c += (absorbed - eliminated) * h;
      if (c < 0) c = 0;
      if (gut < 0) gut = 0;
    }
    t += step;
  }
  while (gi < grid.length) { out[gi] = c; gi++; }
  return out;
}

// ---------------------------------------------------------------------------- //
// Effect-site and adaptive baseline.                                           //
// ---------------------------------------------------------------------------- //
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

// The adaptive baseline. A chases Ce with its own time constant; the felt drive
// is Ce − γ·A. γ=0 recovers the old pure-level model exactly.
function adaptation(ce, step, kA, a0) {
  const A = new Array(ce.length).fill(0);
  let val = a0 || 0;
  A[0] = val;
  const a = kA * step;
  const sub = Math.max(1, Math.ceil(a));
  const aSub = a / sub;
  for (let i = 1; i < ce.length; i++) {
    const cp = ce[i - 1], cc = ce[i];
    for (let s = 0; s < sub; s++) val += aSub * (cp + (cc - cp) * (s / sub) - val);
    A[i] = val;
  }
  return A;
}

/** Ce − γ·A, plus the adaptation debt A − Ce that drives the rebound dip. */
function driveOf(ce, A, gamma) {
  const drive = new Array(ce.length);
  const deficit = new Array(ce.length);
  for (let i = 0; i < ce.length; i++) {
    drive[i] = ce[i] - gamma * A[i];
    // The debt is A − Ce, NOT γ·A − Ce. A is a lagged copy of Ce, so it can
    // never exceed Ce's own peak; requiring γ·A > Ce with γ < 1 means asking the
    // lagged copy to more than double the original, which essentially never
    // happens and made every crash render as −2. A − Ce, on the other hand, is
    // positive throughout the descending limb by construction — which is exactly
    // when the crash is felt. γ then sets how much of that debt you feel.
    deficit[i] = gamma * Math.max(0, A[i] - ce[i]);
  }
  return { drive, deficit };
}

// ---------------------------------------------------------------------------- //
// The response curve.                                                          //
// ---------------------------------------------------------------------------- //
// Above threshold: the familiar Emax/Hill sigmoid.
// Below: a rebound branch driven by the ADAPTATION DEFICIT (how far the baseline
// has drifted past the drug), not by how far the drive sits under the threshold
// — otherwise every drug would end in a dip just from having a threshold.
function respond(drive, deficit, pd) {
  const n = pd.hill_n;
  const ecn = Math.pow(pd.ec50, n);

  // The rebound needs its own scale. Measuring the deficit against EC50 — the
  // sensitivity that governs the PEAK — makes the crash invisible: by the time
  // the adaptive baseline has outlasted the drug, both are small numbers far
  // down the sigmoid, and a real amphetamine crash rendered as −1.
  //
  // Depth comes from how much adaptation debt ever accumulated (measured against
  // EC50, so a drug that barely adapts barely crashes); shape comes from the
  // deficit relative to its own maximum. The dip therefore peaks where the gap
  // between baseline and drug is widest, which is when it is actually felt.
  //
  // The half-point for the DEPTH is ec50/2, not ec50. Unlike onset and duration
  // there is no published number to fit crash depth against, so this is a
  // presentation constant chosen to make a real rebound legible rather than a
  // measured one — the honest reading of the dip is "there is one, roughly here",
  // not "it is 15 units deep".
  let dPeak = 0;
  for (const d of deficit) if (d > dPeak) dPeak = d;
  const dpn = Math.pow(dPeak, n);
  const refn = Math.pow(pd.ec50 / 2, n);
  const depth = dPeak > 0 ? (pd.rebound_max * dpn) / (refn + dpn) : 0;
  const halfN = Math.pow(0.5, n);

  const out = new Array(drive.length);
  for (let i = 0; i < drive.length; i++) {
    const u = drive[i] - pd.threshold;
    if (u >= 0) {
      const un = Math.pow(u, n);
      const v = (pd.emax * un) / (ecn + un);
      out[i] = isFinite(v) ? clamp(v, 0, 100) : 0;
    } else if (deficit[i] > 0 && depth > 0) {
      const x = Math.pow(deficit[i] / dPeak, n);
      const v = (depth * x) / (halfN + x);
      out[i] = isFinite(v) ? -clamp(v, 0, pd.rebound_max) : 0;
    } else {
      out[i] = 0;
    }
  }
  return out;
}

// Fallback effect-site equilibration for drugs with no published onset: scales
// with how fast the drug peaks (something peaking in 45 min ramps gentler than
// something peaking in 5).
function equilFor(route) {
  let tmax = null;
  for (const comp of route.pk_components || []) {
    if (comp.is_active_moiety === false) continue;
    if (comp.input && comp.input.tmax_min) { tmax = comp.input.tmax_min; break; }
  }
  if (tmax == null) tmax = 60;
  return clamp(0.5 * tmax, 8, 45);
}

// ---------------------------------------------------------------------------- //
// The fit.                                                                     //
// ---------------------------------------------------------------------------- //
// Given the reference-dose concentration curve and two published observables,
// solve for the PD parameters:
//
//   equilibration half-time   from ONSET      (how long until you notice)
//   threshold                 from DURATION   (how long it stays noticeable)
//   ec50                      from the convention that a typical dose peaks at
//                             REF_PEAK_EFFECT
//
// The algebra for the last two: with E = Emax·uⁿ/(EC50ⁿ+uⁿ) and u = drive − θ,
// asking for E(peak)=70 gives EC50 = u_peak·(30/70)^(1/n); asking for the floor
// crossing E=5 to sit at drive level L gives L − θ = (u_peak)·k where
// k = ((5/95)/(70/30))^(1/n). Solve for θ directly — no search needed:
//
//   θ = (L − k·drivePeak) / (1 − k)
const K_SHAPE = (n) => Math.pow((FELT_FLOOR / (100 - FELT_FLOOR)) / (REF_PEAK_EFFECT / (100 - REF_PEAK_EFFECT)), 1 / n);

/** First index where v >= L, and the last — i.e. the width of the band. */
function bandOf(arr, grid, L) {
  let first = -1, last = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] >= L) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return null;
  return { start: grid[first], end: grid[last], width: grid[last] - grid[first] };
}

/** The drive level whose band width matches the published duration. */
function levelForDuration(drive, grid, durationMin) {
  let peak = 0;
  for (const v of drive) if (v > peak) peak = v;
  if (peak <= 0) return null;
  let lo = 1e-6, hi = peak * 0.999;
  // width(L) decreases as L rises.
  const widthAt = (L) => { const b = bandOf(drive, grid, L); return b ? b.width : 0; };
  if (widthAt(lo) < durationMin) return { level: lo, short: true, peak };
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (widthAt(mid) > durationMin) lo = mid; else hi = mid;
  }
  return { level: 0.5 * (lo + hi), short: false, peak };
}

function fitPD(route, cls, obs, amountScale) {
  const span = clamp((obs.onset_min + obs.duration_min) * 3, 360, 20160);
  const step = clamp(span / 1200, 0.5, 10);
  const grid = linGrid(0, span, step);
  const kA = LN2 / cls.adapt_half_min;

  // `amountScale` must be EXACTLY the scale the renderer uses, including the
  // reference-route normalization and bioavailability. Normalizing again by this
  // route's own peak here would fit the sigmoid to a curve peaking at 1.0 and
  // then apply it to one peaking at 2.5 — which is what made every non-primary
  // route (IR when the record lists XR first, IV, patches) come out saturated.
  const unit = substanceUnitShape(route, grid);
  const c = unit.map((v) => v * amountScale);
  let cPeak = 0;
  for (const v of c) if (v > cPeak) cPeak = v;
  if (!(cPeak > 0)) return null;

  // For a candidate equilibration half-time, where does the felt effect start?
  const probe = (equilHalf) => {
    const ce = effectSite(c, step, LN2 / equilHalf);
    const A = adaptation(ce, step, kA, 0);
    const { drive } = driveOf(ce, A, cls.gamma);
    const lvl = levelForDuration(drive, grid, obs.duration_min);
    if (!lvl) return null;
    const band = bandOf(drive, grid, lvl.level);
    return { equilHalf, ce, drive, level: lvl.level, drivePeak: lvl.peak, onset: band ? band.start : 0, short: lvl.short };
  };

  // Scan, don't bisect. Onset looked like it should increase monotonically with
  // the equilibration half-time — slower equilibration, later crossing — but it
  // doesn't: past a point, heavy smoothing flattens the effect-site curve, which
  // DROPS the level a fixed-duration band sits at, which pulls the crossing
  // earlier again. Onset rises then falls, so bisection happily converged on the
  // far side and gave lorazepam a 7.7 h onset against a published 30 min.
  // A log-spaced scan over the whole plausible range can't be fooled by that.
  let best = null, bestErr = Infinity;
  for (let i = 0; i <= 32; i++) {
    const equilHalf = 1 * Math.pow(600, i / 32); // 1 → 600 min, log-spaced
    const p = probe(equilHalf);
    if (!p) continue;
    const err = Math.abs(p.onset - obs.onset_min);
    if (err < bestErr) { bestErr = err; best = p; }
  }
  if (!best) return null;
  // How far off we ended up. If the PK simply cannot rise fast enough to be felt
  // when people report feeling it, that is a fact about the data we were given,
  // and the readout says so rather than the curve hiding it.
  const onsetErr = best.onset - obs.onset_min;

  const n = cls.hill_n;
  const k = K_SHAPE(n);
  let threshold = (best.level - k * best.drivePeak) / (1 - k);
  let ec50;
  if (threshold <= 0) {
    // The drug's own kinetics give a wider felt window than published duration
    // needs, so no threshold is required — anchor EC50 on the floor crossing
    // instead and let a typical dose land higher than the 70 convention.
    threshold = 0;
    ec50 = best.level * Math.pow((100 - FELT_FLOOR) / FELT_FLOOR, 1 / n);
  } else {
    threshold = Math.min(threshold, 0.98 * best.drivePeak);
    ec50 = (best.drivePeak - threshold) * Math.pow((100 - REF_PEAK_EFFECT) / REF_PEAK_EFFECT, 1 / n);
  }
  if (!(ec50 > 0) || !isFinite(ec50)) return null;

  return {
    threshold, ec50, hill_n: n, emax: 100,
    equil_half_min: best.equilHalf,
    gamma: cls.gamma, kA, rebound_max: cls.rebound_max,
    fitted: true,
    pk_short: best.short,        // published duration exceeds what the PK can support
    onset_err_min: onsetErr,     // + = we're slower to onset than reported
  };
}

// Memoize the fit: it costs a few hundred thousand float ops and depends only
// on the route shape, not on dose or on the display window.
const fitCache = new Map();
function pdFor(sub, route, amountScale) {
  const facts = sub.facts || {};
  const clsName = classNameFor(facts.id, facts.category);
  const cls = pdClassFor(clsName);
  const obs = feltFor(facts.id, route.id, facts.category);
  const conditions = { ...DEFAULT_CONDITIONS, ...(sub.conditions || {}) };

  let pd;
  if (obs.kind === "fit") {
    const key = `${facts.id}|${route.id}|${conditions.food}|${round3(amountScale)}`;
    if (!fitCache.has(key)) fitCache.set(key, fitPD(route, cls, obs, amountScale));
    pd = fitCache.get(key);
  }
  if (!pd) {
    // Unfitted drug: keep the record's class PD, exactly as before, but let it
    // share the adaptation machinery so the model is one model.
    const base = route.pd_model || {};
    pd = {
      threshold: base.threshold != null ? base.threshold : 0.15,
      ec50: base.ec50 != null ? base.ec50 : 0.45,
      hill_n: base.hill_n != null ? base.hill_n : cls.hill_n,
      emax: base.emax != null ? base.emax : 100,
      equil_half_min:
        base.mechanism === "effect_delay" && base.extras && base.extras.ke0_min > 0
          ? base.extras.ke0_min
          : equilFor(route),
      gamma: cls.gamma, kA: LN2 / cls.adapt_half_min, rebound_max: cls.rebound_max,
      fitted: false, pk_short: false, onset_err_min: 0,
    };
  }

  // User conditions perturb the fitted reference; they are not part of the fit.
  const tol = TOLERANCE_LEVELS[conditions.tolerance] || TOLERANCE_LEVELS.occasional;
  const mult = tol.ec50_mult != null ? tol.ec50_mult : cls.tol_daily;
  return {
    ...pd,
    ec50: pd.ec50 * mult,
    a0: tol.a0 || 0,
    channel: cls.channel,
    tolerance_mult: mult,
  };
}

// ---------------------------------------------------------------------------- //
// Landmarks.                                                                   //
// ---------------------------------------------------------------------------- //
function landmarksOf(grid, felt) {
  const lm = {
    onset_min: null, peak_min: null, peak_value: null, offset_min: null,
    rebound_min: null, rebound_value: null, current_value: null,
  };
  if (!felt.length) return lm;
  let pk = 0;
  for (let i = 1; i < felt.length; i++) if (felt[i] > felt[pk]) pk = i;
  lm.peak_min = grid[pk];
  lm.peak_value = round3(felt[pk]);

  // A dose too small to be felt has no onset or offset — say so rather than
  // inventing one from a fraction of a sub-perceptual peak.
  const cut = FELT_FLOOR;
  if (felt[pk] >= cut) {
    for (let i = 0; i <= pk; i++) if (felt[i] >= cut) { lm.onset_min = grid[i]; break; }
    for (let i = pk; i < felt.length; i++) if (felt[i] < cut) { lm.offset_min = grid[i]; break; }
  }

  // The crash / rebound: the deepest point below baseline after the peak.
  let rb = -1;
  for (let i = pk; i < felt.length; i++) if (felt[i] < -1 && (rb < 0 || felt[i] < felt[rb])) rb = i;
  if (rb >= 0) { lm.rebound_min = grid[rb]; lm.rebound_value = round3(felt[rb]); }
  return lm;
}

function routeOf(sub) {
  const routes = sub.facts && sub.facts.routes;
  if (!routes || !routes.length) return null;
  return routes.find((r) => r.id === sub.routeId) || routes[0];
}

/**
 * Build per-substance felt/concentration series from the cached params.
 * @param {Array} substances  active substances (each with .facts, .doses, .color, .muted, .conditions)
 * @param {{start:number,end_min:number,step_min:number}} window
 * @returns {{grid_min:number[], series:object[]}}
 */
export function computeSeries(substances, window) {
  const { start, end_min, step_min } = window;
  const grid = linGrid(start, end_min, step_min);
  const span = end_min - start;

  const series = [];
  for (const sub of substances) {
    const rawRoute = routeOf(sub);
    if (!rawRoute) continue;
    const facts = sub.facts || {};
    const conditions = { ...DEFAULT_CONDITIONS, ...(sub.conditions || {}) };
    const route = withFood(rawRoute, conditions);

    // Normalize the whole substance to its REFERENCE route, so bioavailability
    // stops cancelling and a route swap at matched mg means something.
    const refRoute = withFood(referenceRoute(facts) || rawRoute, { food: "empty" });
    const refPeak = referencePeak(refRoute, Math.max(span, 1440)) * fOf(refRoute);
    const amountScale = fOf(route) / (refPeak || 1);

    // ---- concentration ---------------------------------------------------- //
    let c;
    if (isSaturable(route)) {
      // Michaelis–Menten: doses are NOT additive, so integrate them together.
      c = simulateSaturable(
        route,
        sub.doses.map((d) => ({ time_min: d.time_min, amount: d.dose_mg / route.dose_ref })),
        grid,
        amountScale,
      );
    } else {
      c = new Array(grid.length).fill(0);
      for (const d of sub.doses) {
        const tau = grid.map((t) => t - d.time_min);
        const shape = substanceUnitShape(route, tau);
        const scale = (d.dose_mg / route.dose_ref) * amountScale;
        for (let i = 0; i < c.length; i++) c[i] += scale * shape[i];
      }
    }

    // ---- felt effect ------------------------------------------------------- //
    const feltInfo = feltFor(facts.id, route.id, facts.category);
    const pd = pdFor(sub, route, amountScale);
    let felt, landmarks;
    if (feltInfo.kind === "none") {
      // Refusing to draw is more honest than drawing something wrong. It also
      // kills the never-offsetting curve that broke the window auto-fit.
      felt = new Array(grid.length).fill(0);
      landmarks = landmarksOf(grid, felt);
    } else {
      const ce = effectSite(c, step_min, LN2 / pd.equil_half_min);
      const A = adaptation(ce, step_min, pd.kA, pd.a0);
      const { drive, deficit } = driveOf(ce, A, pd.gamma);
      felt = respond(drive, deficit, pd);
      landmarks = landmarksOf(grid, felt);
    }

    series.push({
      substance_id: sub.id,
      name: sub.name,
      color: sub.color,
      felt_effect: felt.map(round3),
      concentration: c.map(round3),
      landmarks,
      threshold: pd.threshold,
      channel: pd.channel,
      felt_kind: feltInfo.kind,          // "fit" | "unfitted" | "none"
      felt_reason: feltInfo.reason || "",
      pd_fitted: !!pd.fitted,
      pk_short: !!pd.pk_short,
      onset_err_min: pd.onset_err_min || 0,
      tolerance_mult: pd.tolerance_mult,
      muted: !!sub.muted,
      breaks_superposition: !!route.breaks_superposition,
      confidence: facts.confidence || "low",
    });
  }
  return { grid_min: grid, series };
}

/** Re-export so the data layer's patcher is reachable from one place. */
export { applyPkFix };
