// record.js — assemble the engine-shaped Substance record.
//
// The shape here must match what frontend/src/engine.js reads. The engine takes
// PARAMETERS and computes the curve in the browser; nothing here computes a
// curve. See docs/API_CONTRACT.md and frontend/src/api/contract.js.

import { slug, titleCase, buildAliases } from "./aliases.js";
import { categoryFromAtc, routeFamily, FORMULATION, ROUTE_DEFAULTS, pdModel } from "./taxonomy.js";

const LOW = "low";

/** Every landmark carries its provenance so the UI can be honest about it. */
function landmark(value, unit, sourceType) {
  return { value, unit, source: sourceType, source_type: sourceType, confidence: LOW };
}

/** Median of a numeric array. */
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Dose statistics from observed single-ingredient product strengths (in mg).
 * Returns display unit + min/typical/max, switching to mcg for sub-milligram drugs.
 */
function doseStats(strengthsMg) {
  const vals = strengthsMg.filter((v) => v > 0).sort((a, b) => a - b);
  if (!vals.length) return { unit: "mg", min: 5, typical: 10, max: 20 };

  const typical = median(vals);
  const useMcg = typical < 1;
  const k = useMcg ? 1000 : 1;
  const round = (v) => {
    const x = v * k;
    return x >= 100 ? Math.round(x) : Math.round(x * 100) / 100;
  };
  return {
    unit: useMcg ? "mcg" : "mg",
    min: round(vals[0]),
    typical: round(typical),
    max: round(vals[vals.length - 1]),
  };
}

/** Counts how many records needed repairing, for the run summary. */
export const pkRepairs = { inconsistent: 0, absurdHalfLife: 0, implausibleTmax: 0 };

// Route-aware ceiling on an extracted Tmax.
//
// pk.js has to apply ONE bound to every drug, and it is set at 14 days so that
// biologics survive (denosumab genuinely peaks in ~10 days). Applied to a
// swallowed tablet that bound is meaningless: it let through haloperidol at
// 6 days, progesterone at 12, and clotrimazole at 36 hours. By the time we get
// here we know the dose form, so we can say what is actually possible.
const TMAX_CEILING = {
  oral_IR: 720,   // 12 h — generous; real IR orals peak inside 4
  oral_DR: 900,   // enteric coating buys a couple of hours
  oral_XR: 1440,
  rectal: 720,
  sublingual: 240,
  nasal: 240,
  inhaled: 120,
  injection: 720,
  iv: 60,
  patch: 20160,   // genuinely slow; keep the wide bound
};

/**
 * Reject an extracted (Tmax, half-life) pair that cannot describe a real oral
 * drug, before it reaches the curve.
 *
 * For one-compartment first-order kinetics the peak occurs at
 *   Tmax = ln(ka/ke)/(ka - ke),
 * which for ka > ke is bounded above by 1/ke = half_life / ln2. A pair that
 * violates that bound implies absorption slower than elimination (flip-flop) —
 * genuinely real for depot injections and some XR forms, but for a plain oral
 * drug it almost always means one of the two numbers was mis-read.
 *
 * Amphetamine came out of the labels at Tmax 225 min with a 120 min half-life:
 * 1/ke is 173 min, so the pair is impossible. Tmax was right (~3.8 h) and the
 * half-life was wrong (real is ~10-13 h). That is the usual direction — a Tmax
 * sentence is normally unambiguous, while a half-life sentence can easily pick
 * up a distribution or absorption phase instead of the terminal one. So keep
 * Tmax and drop the half-life back to the class default.
 */
function plausiblePk(pk, family) {
  const LN2 = Math.log(2);
  let tmax = pk?.tmax_min ?? null;
  let halfLife = pk?.half_life_min ?? null;

  // Nothing on Earth is felt on a 30-day curve in this app; treat it as a unit
  // mis-read (days parsed where hours were meant) rather than a real value.
  if (halfLife != null && halfLife > 20160) {
    halfLife = null;
    pkRepairs.absurdHalfLife++;
  }

  const ceiling = TMAX_CEILING[family] ?? 20160;
  if (tmax != null && tmax > ceiling) {
    tmax = null;
    pkRepairs.implausibleTmax++;
  }

  // Tmax cannot exceed 1/ke for first-order input into one compartment. This
  // used to resolve the contradiction by discarding the HALF-LIFE and keeping
  // the Tmax, which is backwards. The half-life anchors ("half-life", "t½") are
  // specific; the Tmax anchors also match prose like "peak plasma concentrations
  // were reduced by 30%" and "maximum concentration after 14 days of dosing", so
  // Tmax is by far the noisier of the two. Drop the noisier one.
  //
  // Lorazepam is the case in point: it kept a 14 h Tmax and threw away a good
  // 12 h half-life, so the app drew an 8am dose peaking at 10pm.
  //
  // XR and patch are exempt: flip-flop kinetics make Tmax > 1/ke genuinely
  // correct there, and the engine models it deliberately.
  if (tmax != null && halfLife != null && family !== "oral_XR" && !family.startsWith("patch")) {
    if (tmax > halfLife / LN2) {
      tmax = null;
      pkRepairs.inconsistent++;
    }
  }

  // Provenance is PER FIELD. Stamping one source onto both is how 15% of
  // "label-sourced" half-lives came to be exactly 300 minutes — the class
  // default, wearing a label's name because the Tmax beside it was real.
  const src = pk?.source || "openfda_label";
  return {
    tmax, halfLife,
    tmaxSource: tmax != null ? src : "class_default",
    halfLifeSource: halfLife != null ? src : "class_default",
  };
}

/**
 * Build one route's PK components from the measured/def­aulted Tmax + half-life.
 * Prodrugs get a two-component cascade: an inactive parent feeding a long-lived
 * active metabolite. That's what makes lisdexamfetamine's curve look right —
 * a smooth, delayed, lower, longer peak instead of an IR spike.
 */
function pkComponents(family, tmaxMin, halfLifeMin, prodrugOf) {
  const d = ROUTE_DEFAULTS[family];

  if (prodrugOf && family.startsWith("oral")) {
    const parentHalfLife = Math.max(15, Math.min(60, tmaxMin * 0.5));
    return [
      {
        id: "parent",
        fraction: 1.0,
        input: { type: "first_order", params: {}, tmax_min: Math.max(15, tmaxMin * 0.3), lag_min: d.lag },
        decline: { type: "first_order", params: { half_life_min: parentHalfLife } },
        feeds_id: null,
        is_active_moiety: false,
      },
      {
        id: "metab",
        fraction: 1.0,
        input: { type: "from_parent", params: {}, tmax_min: null, lag_min: 0 },
        decline: { type: "first_order", params: { half_life_min: halfLifeMin } },
        feeds_id: "parent",
        is_active_moiety: true,
      },
    ];
  }

  if (d.input === "zero_order") {
    return [{
      id: null,
      fraction: 1.0,
      input: { type: "zero_order", params: { window_min: d.window }, tmax_min: null, lag_min: d.lag },
      decline: { type: "first_order", params: { half_life_min: halfLifeMin } },
      feeds_id: null,
      is_active_moiety: true,
    }];
  }

  if (d.input === "instant") {
    return [{
      id: null,
      fraction: 1.0,
      input: { type: "instant", params: {}, tmax_min: null, lag_min: d.lag },
      decline: { type: "first_order", params: { half_life_min: halfLifeMin } },
      feeds_id: null,
      is_active_moiety: true,
    }];
  }

  return [{
    id: null,
    fraction: 1.0,
    input: { type: "first_order", params: {}, tmax_min: tmaxMin, lag_min: d.lag },
    decline: { type: "first_order", params: { half_life_min: halfLifeMin } },
    feeds_id: null,
    is_active_moiety: true,
  }];
}

/**
 * Rank NDC dose-form families so the most-marketed real formulations win.
 * @returns {string[]} route families, most common first, capped
 */
function chooseRoutes(forms, maxRoutes = 4) {
  const tally = new Map();
  for (const [key, count] of forms) {
    const [routes, dosageForm] = key.split("::");
    for (const r of routes.split("|")) {
      const family = routeFamily(r, dosageForm);
      if (!family) continue;
      tally.set(family, (tally.get(family) || 0) + count);
    }
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxRoutes)
    .map(([family]) => family);
}

/**
 * @param {object} input
 * @param {string} input.ingredient   normalised ingredient key
 * @param {string} input.displayName
 * @param {object|null} input.ndc     aggregated NDC record for this ingredient
 * @param {object|null} input.wd      Wikidata entry (brands, ATC, unii)
 * @param {object|null} input.pk      extracted PK ({tmax_min, half_life_min, prodrug_of})
 * @param {string|null} input.rxcui
 * @returns {object|null} a row ready to upsert, or null if unusable
 */
export function buildRecord({ ingredient, displayName, ndc, wd, pk, rxcui }) {
  const atc = wd?.atc || [];
  const category = categoryFromAtc(atc);

  const families = ndc ? chooseRoutes(ndc.forms) : ["oral_IR"];
  if (!families.length) return null; // topical/ophthalmic only — no felt curve

  const dose = doseStats(ndc ? ndc.strengthsMg : []);
  const measured = plausiblePk(pk, families[0]);

  const routes = families.map((family) => {
    const d = ROUTE_DEFAULTS[family];
    let tmax = measured.tmax ?? d.tmax ?? 60;
    const halfLife = measured.halfLife ?? d.halfLife;

    // An extended-release form of a drug whose measured Tmax came from an IR
    // label would otherwise peak far too early. Floor it at the XR default.
    if (family === "oral_XR") tmax = Math.max(tmax, d.tmax);

    return {
      id: family,
      route_type: family,
      formulation: FORMULATION[family],
      bioavailability_F: d.F,
      dose_ref: dose.typical,
      dose_range: { min: dose.min, typical: dose.typical, max: dose.max },
      pk_components: pkComponents(family, tmax, halfLife, pk?.prodrug_of),
      pd_model: pdModel(category),
      breaks_superposition: false,
    };
  });

  const primary = routes[0];
  const primaryTmax = primary.pk_components.find((c) => c.is_active_moiety)?.input?.tmax_min
    ?? measured.tmax
    ?? ROUTE_DEFAULTS[families[0]].tmax;
  const primaryHalfLife = measured.halfLife ?? ROUTE_DEFAULTS[families[0]].halfLife;
  const tmaxSource = measured.tmaxSource;
  const halfLifeSource = measured.halfLifeSource;
  // Summary provenance for the record as a whole: label-sourced only if BOTH
  // numbers came off a label. Anything less and the honest answer is "partly".
  const sourceType =
    tmaxSource === halfLifeSource ? tmaxSource
      : tmaxSource === "class_default" || halfLifeSource === "class_default" ? "partial_label"
        : tmaxSource;

  const aliases = buildAliases(displayName, [
    ndc ? [...ndc.brands] : [],
    wd?.brands || [], // <- Elvanse, Aduvanz, Venvanse land here
    wd?.aliases || [],
    ndc ? [...ndc.comboBrands] : [], // Mydayis, Adderall — combination products
    [ingredient],
    atc,
    rxcui ? [rxcui] : [],
  ]);

  return {
    id: slug(ingredient),
    name: displayName,
    category,
    aliases,
    unit: dose.unit,
    confidence: LOW,
    record: {
      id: slug(ingredient),
      name: displayName,
      category,
      aliases,
      unit: dose.unit,
      routes,
      landmarks: {
        tmax_min: landmark(primaryTmax, "min", tmaxSource),
        half_life_min: landmark(primaryHalfLife, "min", halfLifeSource),
      },
      confidence: LOW,
      notes: buildNotes({ ndc, wd, pk, tmaxSource, halfLifeSource, families }),
      provenance: {
        rxcui: rxcui || null,
        atc,
        unii: wd?.unii || [],
        wikidata: wd?.item || null,
        us_products: ndc?.products || 0,
        pk_source: sourceType,
        pk_source_tmax: tmaxSource,
        pk_source_half_life: halfLifeSource,
        prodrug_of: pk?.prodrug_of || null,
      },
    },
  };
}

function buildNotes({ ndc, wd, pk, tmaxSource, halfLifeSource, families }) {
  const bits = [];
  if (pk?.prodrug_of) {
    bits.push(`Prodrug of ${pk.prodrug_of}; the felt curve follows the active metabolite, so it peaks later and fades slower than the parent.`);
  }
  // Say which of the two numbers is real. "Auto-extracted from an FDA label"
  // covering a value that was actually a class default is the kind of note that
  // makes a reader trust a curve more than they should.
  const where = (s) =>
    s === "llm_label" ? "read from a tabular FDA label section"
      : s === "openfda_label" ? "auto-extracted from an FDA label"
        : null;
  const t = where(tmaxSource), h = where(halfLifeSource);
  if (t && h) bits.push(`Tmax and half-life ${t === h ? t : `${t} and ${h} respectively`}; not hand-checked.`);
  else if (t) bits.push(`Tmax ${t}; half-life is a class-typical placeholder. Not hand-checked.`);
  else if (h) bits.push(`Half-life ${h}; Tmax is a class-typical placeholder. Not hand-checked.`);
  else bits.push("No PK figures stated on the label — this curve uses class-typical placeholder values.");
  if (families.length > 1) bits.push(`Routes available: ${families.join(", ")}.`);
  if (!ndc && wd) bits.push("No US product found; identified from Wikidata only.");
  bits.push("Illustrative estimate, not a dosing or clinical tool.");
  return bits.join(" ");
}
