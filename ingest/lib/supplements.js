// supplements.js — curated supplement records.
//
// WHY THIS IS CURATED AND NOT SCRAPED
//
// The drug ingest works because FDA labels contain a Clinical Pharmacology
// section with Tmax and half-life in prose. Supplements have no equivalent.
// NIH's Dietary Supplement Label Database (DSLD) is the obvious source and it
// is genuinely useful for DISCOVERY — it would tell us l-theanine exists, what
// it's called, and what doses are sold. It contains no pharmacokinetics at all,
// because supplement labels aren't required to carry any.
//
// So pointing a scraper at DSLD would add a few thousand rows whose every PK
// number is a class default. That is precisely the failure we just spent a
// commit making visible rather than hiding. Twenty supplements with real
// published human PK beat two thousand with none.
//
// Numbers below come from published single-dose human PK studies. Everything is
// still stamped confidence "low" — these are population figures being used to
// draw one person's day.
//
// Adding one is two lines. If you want DSLD-driven discovery later, it slots in
// as a source for `aliases` and `dose`, and these values stay the PK layer.

const LOW = "low";

/**
 * @typedef {object} Supp
 * @property {string} name          display name
 * @property {string} category      drives the PD class and the felt channel
 * @property {string[]} aliases
 * @property {number} tmax_min
 * @property {number} half_life_min
 * @property {number} F             bioavailability
 * @property {[number,number,number]} dose  [min, typical, max] in `unit`
 * @property {string} [unit]        default "mg"
 * @property {string} [note]
 */

/** @type {Record<string, Supp>} */
export const SUPPLEMENTS = {
  // ---- acutely felt -------------------------------------------------------- //
  l_theanine: {
    name: "L-Theanine",
    category: "nootropic",
    aliases: ["theanine", "l theanine", "suntheanine", "n-ethyl-l-glutamine"],
    tmax_min: 50, half_life_min: 65, F: 0.95,
    dose: [100, 200, 400],
    note: "Crosses the blood-brain barrier within the hour; the felt window is short because the half-life is about an hour.",
  },
  l_tyrosine: {
    name: "L-Tyrosine",
    category: "nootropic",
    aliases: ["tyrosine", "n-acetyl-l-tyrosine", "nalt"],
    tmax_min: 120, half_life_min: 150, F: 0.9,
    dose: [500, 2000, 4000],
    note: "Acute effects are reported mainly under stress or sleep loss, where catecholamine demand is high — not as a general lift.",
  },
  rhodiola_rosea: {
    name: "Rhodiola Rosea",
    category: "adaptogen",
    aliases: ["rhodiola", "golden root", "arctic root", "salidroside", "rosavin"],
    tmax_min: 60, half_life_min: 300, F: 0.4,
    dose: [100, 300, 600],
  },
  panax_ginseng: {
    name: "Panax Ginseng",
    category: "adaptogen",
    aliases: ["ginseng", "korean ginseng", "red ginseng", "ginsenoside"],
    tmax_min: 90, half_life_min: 300, F: 0.3,
    dose: [100, 400, 1000],
  },
  alpha_gpc: {
    name: "Alpha-GPC",
    category: "nootropic",
    aliases: ["alpha gpc", "l-alpha-glycerylphosphorylcholine", "choline alfoscerate"],
    tmax_min: 75, half_life_min: 250, F: 0.88,
    dose: [150, 400, 600],
  },
  citicoline: {
    name: "Citicoline",
    category: "nootropic",
    aliases: ["cdp-choline", "cdp choline", "cognizin"],
    tmax_min: 60, half_life_min: 330, F: 0.9,
    dose: [250, 500, 1000],
  },
  taurine: {
    name: "Taurine",
    category: "nootropic",
    aliases: ["l-taurine", "2-aminoethanesulfonic acid"],
    tmax_min: 90, half_life_min: 60, F: 0.85,
    dose: [500, 1500, 3000],
  },
  glycine: {
    name: "Glycine",
    category: "sedative",
    aliases: ["l-glycine", "aminoacetic acid"],
    tmax_min: 45, half_life_min: 60, F: 0.9,
    dose: [1000, 3000, 5000],
    note: "Taken before bed it lowers core temperature, which is the mechanism behind the reported effect on sleep onset.",
  },
  five_htp: {
    name: "5-HTP",
    category: "sedative",
    aliases: ["5 htp", "5-hydroxytryptophan", "oxitriptan", "griffonia"],
    tmax_min: 120, half_life_min: 270, F: 0.7,
    dose: [50, 100, 300],
  },
  beta_alanine: {
    name: "Beta-Alanine",
    category: "other_felt",
    aliases: ["beta alanine", "carnosyn", "3-aminopropanoic acid"],
    tmax_min: 40, half_life_min: 55, F: 0.9,
    dose: [1600, 3200, 6400],
    note: "The tingling (paresthesia) is the acute felt effect and tracks the blood level closely. The performance effect is a separate, weeks-long thing this curve does not show.",
  },
  l_citrulline: {
    name: "L-Citrulline",
    category: "other_felt",
    aliases: ["citrulline", "citrulline malate"],
    tmax_min: 60, half_life_min: 60, F: 0.8,
    dose: [3000, 6000, 10000],
  },

  // ---- real, but not on a single-dose timeline ----------------------------- //
  // These get a blood-level curve and an explicit refusal to draw a felt one.
  creatine: {
    name: "Creatine",
    category: "supplement_chronic",
    aliases: ["creatine monohydrate", "creapure"],
    tmax_min: 90, half_life_min: 180, F: 0.95,
    dose: [3000, 5000, 10000],
    felt_none: "Creatine works by saturating muscle stores over 2–4 weeks. A single dose raises blood creatine and changes nothing you can feel that day.",
  },
  magnesium: {
    name: "Magnesium",
    category: "supplement_chronic",
    aliases: ["magnesium glycinate", "magnesium citrate", "magnesium oxide", "magnesium threonate", "mag"],
    tmax_min: 150, half_life_min: 1200, F: 0.3,
    dose: [100, 300, 500],
    felt_none: "Magnesium's effects come from correcting a deficit over days to weeks. Single-dose felt effects are widely reported but not established, so drawing one would be inventing it. The blood-level curve is real.",
  },
  ashwagandha: {
    name: "Ashwagandha",
    category: "supplement_chronic",
    aliases: ["withania somnifera", "ksm-66", "sensoril", "withanolide"],
    tmax_min: 120, half_life_min: 450, F: 0.3,
    dose: [300, 600, 1200],
    felt_none: "The cortisol and anxiety effects show up after 4–8 weeks of daily use. One dose has no same-day curve.",
  },
  bacopa_monnieri: {
    name: "Bacopa Monnieri",
    category: "supplement_chronic",
    aliases: ["bacopa", "brahmi", "bacoside"],
    tmax_min: 120, half_life_min: 400, F: 0.3,
    dose: [300, 300, 600],
    felt_none: "Bacopa's memory effect appears at 8–12 weeks. Nothing to feel from one dose.",
  },
  vitamin_d3: {
    name: "Vitamin D3",
    category: "supplement_chronic",
    aliases: ["vitamin d", "cholecalciferol", "d3"],
    tmax_min: 720, half_life_min: 21600, F: 0.6,
    dose: [1000, 2000, 5000], unit: "IU",
    felt_none: "Vitamin D corrects a deficiency over weeks to months. Its half-life is measured in weeks; a same-day felt curve would be fiction.",
  },
  omega_3: {
    name: "Omega-3 (EPA/DHA)",
    category: "supplement_chronic",
    aliases: ["fish oil", "epa", "dha", "omega 3", "krill oil"],
    tmax_min: 300, half_life_min: 2880, F: 0.7,
    dose: [500, 1000, 3000],
    felt_none: "Omega-3s incorporate into cell membranes over weeks. No same-day effect to draw.",
  },
  zinc: {
    name: "Zinc",
    category: "supplement_chronic",
    aliases: ["zinc picolinate", "zinc gluconate", "zinc citrate"],
    tmax_min: 150, half_life_min: 1440, F: 0.3,
    dose: [10, 25, 50],
    felt_none: "Zinc matters through repletion over days to weeks, not from a dose. Taken on an empty stomach the one same-day effect most people notice is nausea.",
  },
  gaba: {
    name: "GABA",
    category: "supplement_chronic",
    aliases: ["gamma-aminobutyric acid", "pharmagaba"],
    tmax_min: 60, half_life_min: 60, F: 0.9,
    felt_none: "Oral GABA barely crosses the blood-brain barrier. Reported effects are contested and probably peripheral, so there is no felt curve worth drawing.",
    dose: [100, 500, 750],
  },
};

// ---------------------------------------------------------------------------- //
// Record assembly — must match what frontend/src/engine.js reads.              //
// ---------------------------------------------------------------------------- //
function landmark(value, unit) {
  return { value, unit, source: "curated", source_type: "curated", confidence: LOW };
}

function buildSupplementRecord(id, s) {
  const unit = s.unit || "mg";
  const [min, typical, max] = s.dose;

  const route = {
    id: "oral_IR",
    route_type: "oral_IR",
    formulation: "oral capsule or powder",
    bioavailability_F: s.F,
    dose_ref: typical,
    dose_range: { min, typical, max },
    pk_components: [{
      id: null,
      fraction: 1.0,
      input: { type: "first_order", params: {}, tmax_min: s.tmax_min, lag_min: 0 },
      decline: { type: "first_order", params: { half_life_min: s.half_life_min } },
      feeds_id: null,
      is_active_moiety: true,
    }],
    // The frontend fits the PD from published onset/duration (see
    // frontend/src/data/felt.js). This is the fallback for anything it can't fit.
    pd_model: { threshold: 0.15, ec50: 0.45, hill_n: 1.4, emax: 100, mechanism: "direct", extras: {} },
    breaks_superposition: false,
  };

  const notes = [];
  if (s.note) notes.push(s.note);
  notes.push("PK from published single-dose human studies; hand-entered, not scraped from a label.");
  if (s.felt_none) notes.push(s.felt_none);
  notes.push("Illustrative estimate, not a dosing or clinical tool.");

  const aliases = [...new Set([s.name.toLowerCase(), id.replace(/_/g, " "), ...s.aliases])];

  return {
    id, name: s.name, category: s.category, aliases, unit, confidence: LOW,
    record: {
      id, name: s.name, category: s.category, aliases, unit,
      routes: [route],
      landmarks: {
        tmax_min: landmark(s.tmax_min, "min"),
        half_life_min: landmark(s.half_life_min, "min"),
      },
      confidence: LOW,
      notes: notes.join(" "),
      provenance: {
        source: "curated_supplement",
        pk_source: "curated",
        pk_source_tmax: "curated",
        pk_source_half_life: "curated",
      },
    },
  };
}

/** All supplement rows, ready to upsert. */
export function buildSupplementRows() {
  return Object.entries(SUPPLEMENTS).map(([id, s]) => buildSupplementRecord(id, s));
}
