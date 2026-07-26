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
  const measured = {
    tmax: pk?.tmax_min ?? null,
    halfLife: pk?.half_life_min ?? null,
  };

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
  const sourceType = pk?.source || (measured.tmax || measured.halfLife ? "openfda_label" : "class_default");

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
        tmax_min: landmark(primaryTmax, "min", sourceType),
        half_life_min: landmark(primaryHalfLife, "min", sourceType),
      },
      confidence: LOW,
      notes: buildNotes({ ndc, wd, pk, sourceType, families }),
      provenance: {
        rxcui: rxcui || null,
        atc,
        unii: wd?.unii || [],
        wikidata: wd?.item || null,
        us_products: ndc?.products || 0,
        pk_source: sourceType,
        prodrug_of: pk?.prodrug_of || null,
      },
    },
  };
}

function buildNotes({ ndc, wd, pk, sourceType, families }) {
  const bits = [];
  if (pk?.prodrug_of) {
    bits.push(`Prodrug of ${pk.prodrug_of}; the felt curve follows the active metabolite, so it peaks later and fades slower than the parent.`);
  }
  bits.push(
    sourceType === "openfda_label"
      ? "Tmax and half-life auto-extracted from an FDA label; not hand-checked."
      : sourceType === "llm_label"
        ? "Tmax and half-life read from a tabular FDA label section; not hand-checked."
        : "No PK figures stated on the label — this curve uses class-typical placeholder values."
  );
  if (families.length > 1) bits.push(`Routes available: ${families.join(", ")}.`);
  if (!ndc && wd) bits.push("No US product found; identified from Wikidata only.");
  bits.push("Illustrative estimate, not a dosing or clinical tool.");
  return bits.join(" ");
}
