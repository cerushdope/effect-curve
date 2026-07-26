// taxonomy.js — ATC code -> app category, dosage form -> route family, and the
// fallback PK/PD numbers used when a label yields nothing.
//
// EVERYTHING here is a population-typical placeholder, not a clinical value.
// Every record this produces is stamped confidence "low" regardless of source.

/** ATC prefix -> category, longest prefix wins. */
const ATC_CATEGORY = [
  ["N06B", "stimulant"],
  ["N06A", "antidepressant"],
  ["N06D", "cognitive"],
  ["N05A", "antipsychotic"],
  ["N05B", "anxiolytic"],
  ["N05C", "sedative"],
  ["N04", "antiparkinson"],
  ["N03", "anticonvulsant"],
  ["N02A", "analgesic"],
  ["N02B", "analgesic"],
  ["N02C", "antimigraine"],
  ["N01", "anesthetic"],
  ["N07B", "dependence"],
  ["N", "neurological"],
  ["M01A", "analgesic"],
  ["M03", "muscle-relaxant"],
  ["M", "musculoskeletal"],
  ["C", "cardiovascular"],
  ["A10", "antidiabetic"],
  ["A02", "gastrointestinal"],
  ["A11", "supplement"],
  ["A12", "supplement"],
  ["A", "gastrointestinal"],
  ["B", "blood"],
  ["D", "dermatological"],
  ["G", "genitourinary"],
  ["H", "hormone"],
  ["J", "anti-infective"],
  ["L", "antineoplastic"],
  ["P", "antiparasitic"],
  ["R03", "bronchodilator"],
  ["R06", "antihistamine"],
  ["R", "respiratory"],
  ["S", "sensory"],
  ["V", "other"],
];

export function categoryFromAtc(atcCodes) {
  for (const atc of atcCodes || []) {
    const code = String(atc).toUpperCase();
    for (const [prefix, cat] of ATC_CATEGORY) {
      if (code.startsWith(prefix)) return cat;
    }
  }
  return "other";
}

/**
 * Map an openFDA (route, dosage_form) pair onto one of the engine's route
 * families. Returns null for forms with no meaningful felt-effect curve.
 */
export function routeFamily(route, dosageForm) {
  const r = String(route || "").toUpperCase();
  const f = String(dosageForm || "").toUpperCase();

  if (r.includes("TRANSDERMAL") || f.includes("PATCH")) return "patch";
  if (r.includes("SUBLINGUAL") || r.includes("BUCCAL")) return "sublingual";
  if (r.includes("INTRAVENOUS")) return "iv";
  if (r.includes("INTRAMUSCULAR") || r.includes("SUBCUTANEOUS")) return "injection";
  if (r.includes("NASAL")) return "nasal";
  if (r.includes("RESPIRATORY") || r.includes("INHALATION")) return "inhaled";
  if (r.includes("RECTAL") || r.includes("VAGINAL")) return "rectal";

  if (r.includes("ORAL") || f.includes("TABLET") || f.includes("CAPSULE")) {
    if (f.includes("EXTENDED RELEASE") || f.includes("SUSTAINED") || f.includes("CONTROLLED")) {
      return "oral_XR";
    }
    if (f.includes("DELAYED RELEASE") || f.includes("ENTERIC")) return "oral_DR";
    if (f.includes("ORALLY DISINTEGRATING")) return "oral_IR";
    return "oral_IR";
  }

  // Topical / ophthalmic / otic / irrigant etc. — no systemic curve worth drawing.
  return null;
}

/** Human-readable formulation label per family. */
export const FORMULATION = {
  oral_IR: "immediate-release oral",
  oral_XR: "extended-release oral",
  oral_DR: "delayed-release (enteric) oral",
  sublingual: "sublingual / buccal",
  iv: "intravenous",
  injection: "intramuscular / subcutaneous injection",
  nasal: "nasal spray",
  inhaled: "inhaled",
  patch: "transdermal patch",
  rectal: "rectal",
};

/**
 * Fallback PK per route family, in MINUTES. Used when the openFDA label yields
 * no usable number, and to shape the absorption model for every family.
 *  input:  how drug gets in    decline: how it leaves    F: bioavailability
 */
export const ROUTE_DEFAULTS = {
  oral_IR: { input: "first_order", tmax: 60, lag: 0, halfLife: 300, F: 0.7 },
  oral_XR: { input: "first_order", tmax: 240, lag: 0, halfLife: 360, F: 0.7 },
  oral_DR: { input: "first_order", tmax: 60, lag: 45, halfLife: 300, F: 0.7 },
  sublingual: { input: "instant", tmax: null, lag: 0, halfLife: 120, F: 0.4 },
  iv: { input: "instant", tmax: null, lag: 0, halfLife: 300, F: 1.0 },
  injection: { input: "first_order", tmax: 30, lag: 0, halfLife: 300, F: 0.9 },
  nasal: { input: "first_order", tmax: 15, lag: 0, halfLife: 120, F: 0.4 },
  inhaled: { input: "first_order", tmax: 10, lag: 0, halfLife: 180, F: 0.2 },
  patch: { input: "zero_order", window: 4320, lag: 0, halfLife: 600, F: 0.5 },
  rectal: { input: "first_order", tmax: 60, lag: 0, halfLife: 300, F: 0.6 },
};

/**
 * PD shape per category. `threshold` is the fraction of the reference peak
 * below which the effect reads as "not felt"; ec50/hill_n set the steepness.
 *
 * CALIBRATION NOTE. These were originally set around 0.08-0.12, which is about
 * right for a PLASMA curve and much too low for a FELT one. At threshold 0.08,
 * lisdexamfetamine still read as ~26% felt a full 24 h after the dose, because
 * a quarter of peak plasma is a quarter of peak plasma — but nobody reports
 * feeling a quarter of their Vyvanse the next morning. Real felt duration is
 * ~13 h.
 *
 * Raising the threshold to ~0.2 and steepening hill_n pulls the tail in without
 * touching the peak: same shape while the drug is working, then it lets go.
 * Cross-checked against lisdexamfetamine (~14 h felt) and amphetamine IR.
 *
 * These are judgement calls about a subjective quantity, not measurements —
 * which is exactly why every record ships confidence "low".
 */
const PD_BY_CATEGORY = {
  stimulant: { threshold: 0.2, ec50: 0.4, hill_n: 2.0 },
  analgesic: { threshold: 0.18, ec50: 0.45, hill_n: 1.8 },
  sedative: { threshold: 0.2, ec50: 0.45, hill_n: 1.9 },
  anxiolytic: { threshold: 0.2, ec50: 0.45, hill_n: 1.9 },
  anesthetic: { threshold: 0.15, ec50: 0.35, hill_n: 2.1 },
  antipsychotic: { threshold: 0.22, ec50: 0.5, hill_n: 1.6 },
  // Chronic-onset classes: little is felt from a single acute dose, so the
  // threshold sits higher still on purpose.
  antidepressant: { threshold: 0.28, ec50: 0.55, hill_n: 1.3 },
  anticonvulsant: { threshold: 0.25, ec50: 0.5, hill_n: 1.4 },
  cardiovascular: { threshold: 0.2, ec50: 0.5, hill_n: 1.5 },
  bronchodilator: { threshold: 0.15, ec50: 0.4, hill_n: 2.0 },
  antihistamine: { threshold: 0.2, ec50: 0.45, hill_n: 1.8 },
  supplement: { threshold: 0.22, ec50: 0.45, hill_n: 1.7 },
  dependence: { threshold: 0.18, ec50: 0.45, hill_n: 1.8 },
};

export function pdModel(category) {
  const base = PD_BY_CATEGORY[category] || { threshold: 0.18, ec50: 0.45, hill_n: 1.7 };
  return { ...base, emax: 100.0, mechanism: "direct", extras: {} };
}
