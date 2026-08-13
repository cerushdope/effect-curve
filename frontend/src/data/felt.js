// felt.js — the observables the PD model is fitted to, plus the class-level
// shape constants it can't get from data.
//
// WHY THIS FILE EXISTS
// The reframe's top item is "fit EC50 per drug from published duration of
// action", blocked on there being no structured source for duration of action.
// There isn't one — not in RxNorm, not in openFDA labels, not in Wikidata. So
// it is hand-entered here for the drugs people actually ask about, and the
// engine solves the PD parameters from it (see fitPD in engine.js).
//
// Two numbers per drug+route, both at a TYPICAL dose, FASTED, in someone who is
// not tolerant:
//   onset_min     — dose to "I can tell it's working"
//   duration_min  — how long it stays noticeable after that
// These are consensus clinical figures (label "duration of effect" statements,
// standard pharmacology references), not measurements. Confidence stays "low".
//
// Everything not listed here keeps the record's own class-assigned PD, i.e.
// exactly today's behaviour. This file only ever makes drugs better, never worse.

// ---------------------------------------------------------------------------- //
// Per-class PD shape + adaptation.                                             //
// ---------------------------------------------------------------------------- //
//
// hill_n      perceptual steepness. Not a receptor property — it is receptor
//             occupancy composed with power-law perceptual scaling, so it is a
//             shape constant, not a lookup.
// gamma       how much of the felt signal is CHANGE rather than LEVEL (0..1).
//             0 = pure level (today's model). Drives three things at once:
//             rate-dependence, acute tolerance, and the rebound dip.
// adapt_half  how fast the adaptive baseline chases the drug level.
// rebound_max ceiling on the below-baseline dip, as a fraction of Emax.
// tol_daily   EC50 multiplier for a daily user. Benzos and opioids move far
//             more than stimulants do.
export const PD_CLASS = {
  stimulant:   { hill_n: 1.6, gamma: 0.45, adapt_half_min: 150, rebound_max: 38, tol_daily: 1.8, channel: "focus & drive" },
  anxiolytic:  { hill_n: 1.3, gamma: 0.30, adapt_half_min: 240, rebound_max: 30, tol_daily: 3.0, channel: "anxiety relief" },
  sedative:    { hill_n: 1.4, gamma: 0.25, adapt_half_min: 210, rebound_max: 22, tol_daily: 2.5, channel: "sedation" },
  analgesic:   { hill_n: 1.2, gamma: 0.20, adapt_half_min: 300, rebound_max: 15, tol_daily: 3.5, channel: "pain relief" },
  opioid:      { hill_n: 1.2, gamma: 0.28, adapt_half_min: 240, rebound_max: 30, tol_daily: 4.0, channel: "pain relief" },
  depressant:  { hill_n: 1.4, gamma: 0.40, adapt_half_min: 120, rebound_max: 35, tol_daily: 2.0, channel: "intoxication" },

  // Supplements. Low gamma across the board: these mostly don't produce the
  // sharp adaptation debt that makes a stimulant crash, and inventing one would
  // be the "sophistication reads as credibility" trap. Low tol_daily for the
  // same reason — tolerance to l-theanine is not a documented thing.
  nootropic:   { hill_n: 1.3, gamma: 0.18, adapt_half_min: 240, rebound_max: 10, tol_daily: 1.2, channel: "calm focus" },
  adaptogen:   { hill_n: 1.2, gamma: 0.15, adapt_half_min: 360, rebound_max: 8,  tol_daily: 1.2, channel: "drive & resilience" },
  other_felt:  { hill_n: 1.4, gamma: 0.20, adapt_half_min: 180, rebound_max: 8,  tol_daily: 1.1, channel: "noticeable effect" },

  _default:    { hill_n: 1.3, gamma: 0.15, adapt_half_min: 300, rebound_max: 12, tol_daily: 1.5, channel: "effect" },
};

export function pdClassFor(category) {
  return PD_CLASS[String(category || "").toLowerCase()] || PD_CLASS._default;
}

// ---------------------------------------------------------------------------- //
// Tolerance — a user input, not stored state.                                  //
// ---------------------------------------------------------------------------- //
// `ec50_mult` is relative to the fitted reference ("occasional"), and `a0` seeds
// the adaptive baseline above zero: a daily user starts the day already below
// their own baseline, which is why the first dose restores normal rather than
// lifting above it.
export const TOLERANCE_LEVELS = {
  first_time:  { label: "first time",  ec50_mult: 0.75, a0: 0 },
  occasional:  { label: "occasional",  ec50_mult: 1.0,  a0: 0 },
  daily:       { label: "daily",       ec50_mult: null, a0: 0.30 }, // null -> class tol_daily
};

// ---------------------------------------------------------------------------- //
// Food — a Tmax multiplier, i.e. a SHAPE change, not a scalar on the peak.     //
// ---------------------------------------------------------------------------- //
export const FOOD_LEVELS = {
  empty: { label: "empty stomach", tmax_mult: 1.0, lag_add_min: 0 },
  food:  { label: "with food",     tmax_mult: 1.5, lag_add_min: 20 },
};

const ORAL_ROUTES = new Set(["oral_IR", "oral_XR", "oral_DR", "sublingual", "buccal"]);
export function foodAffects(routeId, routeType) {
  const k = routeId || routeType || "";
  return ORAL_ROUTES.has(k) && k !== "sublingual" && k !== "buccal";
}

// ---------------------------------------------------------------------------- //
// Felt observables. `null` felt = we refuse to draw a felt curve.              //
// ---------------------------------------------------------------------------- //
// Shape: id -> { class?, channel?, felt?, reason?, routes: { routeId: {onset_min, duration_min} } }
// `routes._` is the fallback for any route not named.
export const FELT = {
  // ---- stimulants --------------------------------------------------------- //
  methylphenidate: {
    routes: { oral_IR: { onset_min: 25, duration_min: 210 }, oral_XR: { onset_min: 45, duration_min: 720 },
              patch: { onset_min: 120, duration_min: 540 }, _: { onset_min: 25, duration_min: 210 } },
  },
  dexmethylphenidate: {
    routes: { oral_IR: { onset_min: 25, duration_min: 240 }, oral_XR: { onset_min: 45, duration_min: 720 },
              _: { onset_min: 25, duration_min: 240 } },
  },
  dextroamphetamine: {
    routes: { oral_IR: { onset_min: 40, duration_min: 300 }, oral_XR: { onset_min: 120, duration_min: 480 },
              patch: { onset_min: 150, duration_min: 540 }, _: { onset_min: 40, duration_min: 300 } },
  },
  amphetamine: {
    routes: { oral_IR: { onset_min: 30, duration_min: 300 }, oral_XR: { onset_min: 45, duration_min: 720 },
              _: { onset_min: 30, duration_min: 300 } },
  },
  lisdexamfetamine: {
    routes: { _: { onset_min: 75, duration_min: 810 } },
  },
  methamphetamine: { routes: { _: { onset_min: 30, duration_min: 480 } } },
  caffeine: {
    routes: { oral_IR: { onset_min: 20, duration_min: 240 }, iv: { onset_min: 3, duration_min: 240 },
              _: { onset_min: 20, duration_min: 240 } },
  },
  modafinil:   { routes: { _: { onset_min: 60, duration_min: 720 } } },
  armodafinil: { routes: { _: { onset_min: 60, duration_min: 840 } } },
  nicotine: {
    routes: { _: { onset_min: 5, duration_min: 60 }, patch: { onset_min: 120, duration_min: 900 } },
  },
  atomoxetine: {
    felt: "none",
    reason: "Atomoxetine builds up over 2–6 weeks. A single dose has no effect you'd notice on the day, so there's no honest same-day curve to draw.",
  },
  guanfacine: {
    felt: "none",
    reason: "Works over weeks at ADHD doses. The blood-level curve is real; a felt-effect curve for one dose is not.",
  },

  // ---- anxiolytics / benzodiazepines -------------------------------------- //
  alprazolam: {
    routes: { oral_IR: { onset_min: 25, duration_min: 300 }, oral_XR: { onset_min: 90, duration_min: 660 },
              _: { onset_min: 25, duration_min: 300 } },
  },
  diazepam: {
    routes: { oral_IR: { onset_min: 30, duration_min: 300 }, iv: { onset_min: 3, duration_min: 150 },
              injection: { onset_min: 30, duration_min: 240 }, rectal: { onset_min: 15, duration_min: 240 },
              _: { onset_min: 30, duration_min: 300 } },
  },
  lorazepam: {
    routes: { oral_IR: { onset_min: 30, duration_min: 480 }, iv: { onset_min: 5, duration_min: 360 },
              injection: { onset_min: 20, duration_min: 420 }, _: { onset_min: 30, duration_min: 480 } },
  },
  clonazepam: { class: "anxiolytic", routes: { _: { onset_min: 40, duration_min: 480 } } },
  oxazepam:   { routes: { _: { onset_min: 60, duration_min: 420 } } },
  temazepam:  { class: "sedative", routes: { _: { onset_min: 30, duration_min: 420 } } },
  midazolam:  { routes: { iv: { onset_min: 2, duration_min: 90 }, _: { onset_min: 15, duration_min: 120 } } },
  buspirone: {
    felt: "none",
    reason: "Buspirone needs 2–4 weeks of daily dosing to work. Nothing to feel from one dose.",
  },

  // ---- sedatives / hypnotics ---------------------------------------------- //
  zolpidem: {
    routes: { oral_IR: { onset_min: 20, duration_min: 300 }, oral_XR: { onset_min: 20, duration_min: 420 },
              sublingual: { onset_min: 12, duration_min: 240 }, _: { onset_min: 20, duration_min: 300 } },
  },
  zopiclone:   { routes: { _: { onset_min: 25, duration_min: 420 } } },
  eszopiclone: { routes: { _: { onset_min: 25, duration_min: 420 } } },
  melatonin:   { routes: { _: { onset_min: 30, duration_min: 180 } } },
  diphenhydramine: { class: "sedative", routes: { _: { onset_min: 30, duration_min: 300 } } },

  // ---- analgesics --------------------------------------------------------- //
  ibuprofen:     { class: "analgesic", routes: { _: { onset_min: 30, duration_min: 360 } } },
  acetaminophen: { class: "analgesic", routes: { _: { onset_min: 30, duration_min: 270 } } },
  paracetamol:   { class: "analgesic", routes: { _: { onset_min: 30, duration_min: 270 } } },
  naproxen:      { class: "analgesic", routes: { _: { onset_min: 45, duration_min: 660 } } },
  morphine:  { class: "opioid", routes: { oral_IR: { onset_min: 35, duration_min: 240 }, iv: { onset_min: 5, duration_min: 180 }, _: { onset_min: 35, duration_min: 240 } } },
  oxycodone: { class: "opioid", routes: { oral_IR: { onset_min: 25, duration_min: 270 }, oral_XR: { onset_min: 60, duration_min: 660 }, _: { onset_min: 25, duration_min: 270 } } },
  codeine:   { class: "opioid", routes: { _: { onset_min: 40, duration_min: 240 } } },
  tramadol:  { class: "opioid", routes: { _: { onset_min: 50, duration_min: 330 } } },

  // ---- supplements -------------------------------------------------------- //
  // Onset/duration for these are consensus from user-reported and trial
  // timings, which are softer sources than a drug label's duration of action.
  // The fit treats them identically; the confidence badge does not.
  l_theanine:     { routes: { _: { onset_min: 40, duration_min: 180 } } },
  l_tyrosine:     { routes: { _: { onset_min: 60, duration_min: 240 } } },
  rhodiola_rosea: { routes: { _: { onset_min: 45, duration_min: 300 } } },
  panax_ginseng:  { routes: { _: { onset_min: 60, duration_min: 300 } } },
  alpha_gpc:      { routes: { _: { onset_min: 45, duration_min: 240 } } },
  citicoline:     { routes: { _: { onset_min: 60, duration_min: 300 } } },
  taurine:        { routes: { _: { onset_min: 45, duration_min: 180 } } },
  glycine:        { class: "sedative", routes: { _: { onset_min: 30, duration_min: 180 } } },
  five_htp:       { class: "sedative", routes: { _: { onset_min: 60, duration_min: 300 } } },
  // The tingling is the acute effect and it tracks the blood level tightly.
  beta_alanine:   { routes: { _: { onset_min: 20, duration_min: 90 } } },
  l_citrulline:   { routes: { _: { onset_min: 45, duration_min: 180 } } },

  creatine:   { felt: "none", reason: "Creatine saturates muscle stores over 2–4 weeks. A single dose raises blood creatine and changes nothing you can feel that day." },
  magnesium:  { felt: "none", reason: "Magnesium works by correcting a deficit over days to weeks. Single-dose effects are widely reported but not established — drawing one would be inventing it. The blood-level curve is real." },
  ashwagandha:{ felt: "none", reason: "The cortisol and anxiety effects appear after 4–8 weeks of daily use." },
  bacopa_monnieri: { felt: "none", reason: "Bacopa's memory effect appears at 8–12 weeks. Nothing to feel from one dose." },
  vitamin_d3: { felt: "none", reason: "Vitamin D corrects a deficiency over weeks to months — its half-life is measured in weeks." },
  omega_3:    { felt: "none", reason: "Omega-3s incorporate into cell membranes over weeks." },
  zinc:       { felt: "none", reason: "Zinc matters through repletion over days to weeks. The one same-day effect people notice is nausea on an empty stomach." },
  gaba:       { felt: "none", reason: "Oral GABA barely crosses the blood-brain barrier. Reported effects are contested and probably peripheral." },

  // ---- refuse to draw ----------------------------------------------------- //
  levothyroxine: {
    felt: "none",
    reason: "Levothyroxine shifts thyroid hormone levels over weeks. The current model drew an eternal plateau, which was wrong in a way that also broke the time axis.",
  },
  atorvastatin: { felt: "none", reason: "Lowers cholesterol over weeks. A single dose has no felt effect." },
  simvastatin:  { felt: "none", reason: "Lowers cholesterol over weeks. A single dose has no felt effect." },
  rosuvastatin: { felt: "none", reason: "Lowers cholesterol over weeks. A single dose has no felt effect." },
  amoxicillin:  { felt: "none", reason: "Antibiotic. You feel better as the infection clears over days — not from the dose." },
  azithromycin: { felt: "none", reason: "Antibiotic. You feel better as the infection clears over days — not from the dose." },
  omeprazole: {
    felt: "none",
    reason: "Acid suppression builds over 1–4 days and long outlasts the drug in blood. Duration here is set by enzyme turnover, not by half-life.",
  },
  pantoprazole: { felt: "none", reason: "Acid suppression builds over days and outlasts the drug in blood." },
  metformin:    { felt: "none", reason: "Works on glucose handling over weeks. Nothing to feel from one dose." },
  lisinopril:   { felt: "none", reason: "Blood-pressure effect builds over weeks. Nothing to feel from one dose." },
  amlodipine:   { felt: "none", reason: "Blood-pressure effect builds over days to weeks. Nothing to feel from one dose." },
  sertraline:   { felt: "none", reason: "SSRIs take 2–6 weeks. A single dose does not produce the effect you're taking it for." },
  fluoxetine:   { felt: "none", reason: "SSRIs take 2–6 weeks. A single dose does not produce the effect you're taking it for." },
  escitalopram: { felt: "none", reason: "SSRIs take 2–6 weeks. A single dose does not produce the effect you're taking it for." },
};

// Whole categories where a single-dose felt curve is never meaningful.
const NO_FELT_CATEGORIES = new Set([
  "anti-infective", "hormone", "vitamin",
  // Everything in this category is defined by acting over weeks. Listing the
  // category as well as each id means a supplement added later defaults to
  // refusing rather than to drawing a made-up curve.
  "supplement_chronic",
]);

/**
 * Felt observables for a substance+route, or a refusal.
 * @returns {{kind:"fit", onset_min:number, duration_min:number}
 *          |{kind:"none", reason:string}
 *          |{kind:"unfitted"}}
 */
export function feltFor(substanceId, routeId, category) {
  const entry = FELT[substanceId];
  if (entry) {
    if (entry.felt === "none") return { kind: "none", reason: entry.reason || "" };
    const r = (entry.routes && (entry.routes[routeId] || entry.routes._)) || null;
    if (r) return { kind: "fit", onset_min: r.onset_min, duration_min: r.duration_min };
  }
  if (NO_FELT_CATEGORIES.has(String(category || "").toLowerCase())) {
    return {
      kind: "none",
      reason: "Nothing here acts on how you feel within hours of a dose, so a felt-effect curve would be invented rather than modelled.",
    };
  }
  return { kind: "unfitted" };
}

/** The PD class to use — an explicit override, else the record's category. */
export function classNameFor(substanceId, category) {
  const entry = FELT[substanceId];
  if (entry && entry.class) return entry.class;
  return String(category || "").toLowerCase();
}

// ---------------------------------------------------------------------------- //
// PK corrections.                                                              //
// ---------------------------------------------------------------------------- //
// Deliberately short. The label-derived PK in the database is mostly good; this
// only patches cases where it is demonstrably wrong or structurally incomplete.
// Each entry replaces `pk_components` (and optionally decline type) for one route.
export const PK_FIX = {
  // The label's 8 h Tmax is the Spansule (XR) figure; IR dextroamphetamine peaks
  // at ~2–3 h. Applying the XR number to IR made every IR curve 5 h late.
  dextroamphetamine: {
    oral_IR: { tmax_min: 180 },
    patch: { zero_order_window_min: 540 },
  },

  // The ingest filed Vyvanse's only route as "immediate-release oral" — the
  // capsule does release immediately, but what makes it slow is the prodrug
  // conversion, and "immediate-release" on the card reads as a claim about the
  // experience. The PK cascade itself is right; only the label is wrong.
  lisdexamfetamine: {
    oral_IR: { formulation: "oral prodrug" },
  },

  // Single-exponential decline at t½ 51 h describes diazepam's TERMINAL phase.
  // What you feel tracks the distribution phase (~1 h), which is why acute
  // anxiolysis is 4–6 h despite the drug being measurable for days. This is the
  // first record in the system to reach the engine's bi-exponential path.
  diazepam: {
    _: { biexp: { w1: 0.62, half_life1_min: 60, w2: 0.38, half_life2_min: 3060 } },
    // Rectal diazepam is given precisely because it works fast; the oral Tmax
    // was copied across every route.
    rectal: { tmax_min: 30, biexp: { w1: 0.62, half_life1_min: 60, w2: 0.38, half_life2_min: 3060 } },
  },

  // Concerta-style OROS is bimodal: an immediate-release overcoat plus an
  // ascending-release core. One first-order component with Tmax 4 h can't
  // produce the early rise people actually feel.
  // A 72 h release window on a patch that is worn for 9 hours produces a flat
  // plateau no threshold can carve a 9 h band out of.
  _patch_wear: null,

  methylphenidate: {
    patch: { zero_order_window_min: 540 },
    oral_XR: {
      components: [
        { fraction: 0.22, tmax_min: 90,  lag_min: 0,  half_life_min: 174 },
        { fraction: 0.78, tmax_min: 420, lag_min: 60, half_life_min: 174 },
      ],
    },
  },

  // Adderall XR is two bead populations ~4 h apart, not one slow release.
  amphetamine: {
    oral_XR: {
      components: [
        { fraction: 0.5, tmax_min: 180, lag_min: 0,   half_life_min: 600 },
        { fraction: 0.5, tmax_min: 180, lag_min: 240, half_life_min: 600 },
      ],
    },
  },

  // Alcohol is eliminated by a saturated enzyme: roughly linear %BAC decay, not
  // exponential. Vmax/Km are in units of the reference-dose peak. This is the
  // first record to reach the engine's Michaelis–Menten path.
  // The label scrape inverted these: it stored Tmax 840 min (14 h) and t½ 300 min
  // (5 h), which are each other's rough values swapped. Drawn faithfully, an 8am
  // dose peaked at 10pm. Caught by the onset residual in tools/validate.mjs —
  // duration still fitted, onset could not, which is the signature of bad PK.
  lorazepam: {
    oral_IR:   { tmax_min: 120, half_life_min: 720 },
    oral_XR:   { tmax_min: 120, half_life_min: 720 },
    injection: { tmax_min: 60,  half_life_min: 720 },
    iv:        { half_life_min: 720 },
  },

  alcohol: {
    _: {
      tmax_min: 45,
      saturable: { vmax_per_min: 0.0125, km: 0.05, fallback_half_life_min: 90 },
      breaks_superposition: true,
    },
  },
};

/** Apply PK_FIX to a fetched record, in place on a clone. Returns the record. */
export function applyPkFix(record) {
  const fix = PK_FIX[record && record.id];
  if (!fix || !record.routes) return record;
  for (const route of record.routes) {
    const f = fix[route.id] || fix._;
    if (!f) continue;
    if (f.formulation) route.formulation = f.formulation;
    const comps = route.pk_components || [];
    const base = comps.find((c) => c.is_active_moiety !== false) || comps[0];
    if (!base) continue;

    if (f.components) {
      route.pk_components = f.components.map((c, i) => ({
        id: `c${i}`,
        fraction: c.fraction,
        input: { type: "first_order", params: {}, tmax_min: c.tmax_min, lag_min: c.lag_min || 0 },
        decline: { type: "first_order", params: { half_life_min: c.half_life_min } },
        feeds_id: null,
        is_active_moiety: true,
      }));
    } else {
      if (f.tmax_min != null && base.input) base.input.tmax_min = f.tmax_min;
      if (f.half_life_min != null) base.decline = { type: "first_order", params: { half_life_min: f.half_life_min } };
      if (f.zero_order_window_min != null && base.input && base.input.params) {
        base.input.params.window_min = f.zero_order_window_min;
      }
      if (f.biexp) base.decline = { type: "first_order", params: { ...f.biexp } };
      if (f.saturable) base.decline = { type: "saturable", params: { ...f.saturable } };
    }
    if (f.breaks_superposition != null) route.breaks_superposition = f.breaks_superposition;
    route.pk_source = "curated";
  }
  return record;
}
