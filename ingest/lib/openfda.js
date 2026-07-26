// openfda.js — US brands / dose forms / strengths (NDC) and PK prose (labels).
//
// We use openFDA's BULK DOWNLOAD host, not the query API. openFDA publishes
// these partitions at download.open.fda.gov and indexes them at
// api.fda.gov/download.json specifically so bulk consumers don't hammer the API;
// the API's 1,000/day anonymous rate limit does not apply to them. This is the
// route they recommend for exactly this use case — no key, no limit, no evasion.
//
// openFDA data is US federal government work and therefore public domain.
//
// Disk discipline: label partitions are ~130 MB zipped each. We download one,
// stream it, extract the few fields we need, then DELETE it before fetching the
// next. Peak disk stays around one partition rather than the full 1.76 GB.

import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { download, getJSON } from "./http.js";
import { openZipEntry } from "./unzip.js";
import { streamResults } from "./jsonstream.js";
import { stripSalt, normalise } from "./aliases.js";
import { extractPk, labelScore } from "./pk.js";

const DOWNLOAD_INDEX = "https://api.fda.gov/download.json";

export const OPENFDA_ATTRIBUTION =
  "Includes data from openFDA (U.S. Food and Drug Administration), a public-domain " +
  "US government work. Not reviewed or endorsed by the FDA.";

async function partitions(dataset) {
  const idx = await getJSON(DOWNLOAD_INDEX);
  const node = idx?.results?.drug?.[dataset];
  if (!node?.partitions?.length) throw new Error(`no partitions for drug/${dataset}`);
  return { files: node.partitions.map((p) => p.file), exportDate: node.export_date };
}

/**
 * NDC directory -> per-ingredient US brands, dosage forms, routes and strengths.
 * One 27 MB file covering ~137k marketed products.
 *
 * @returns {Promise<Map<string, {brands:Set<string>, forms:Map<string,number>,
 *   strengthsMg:number[], unii:Set<string>, schedules:Set<string>, products:number}>>}
 */
export async function loadNdc(cacheDir, log = () => {}) {
  const { files, exportDate } = await partitions("ndc");
  log(`  openFDA NDC export ${exportDate} (${files.length} file)`);

  const byIngredient = new Map();
  const ensure = (key) => {
    let e = byIngredient.get(key);
    if (!e) {
      e = {
        brands: new Set(),
        comboBrands: new Set(),
        forms: new Map(),
        strengthsMg: [],
        unii: new Set(),
        schedules: new Set(),
        products: 0,
      };
      byIngredient.set(key, e);
    }
    return e;
  };

  for (const url of files) {
    const dest = path.join(cacheDir, path.basename(url));
    const { bytes, cached } = await download(url, dest);
    log(`  ndc ${path.basename(url)} ${(bytes / 1e6).toFixed(1)} MB${cached ? " (cached)" : ""}`);

    const stream = await openZipEntry(dest);
    for await (const p of streamResults(stream)) {
      const ingredients = p.active_ingredients || [];
      if (!ingredients.length) continue;
      const single = ingredients.length === 1;

      for (const ai of ingredients) {
        const key = stripSalt(ai.name);
        if (!key || key.length < 3) continue;
        const e = ensure(key);
        e.products++;

        // Brand attribution: single-ingredient products are authoritative.
        // Combination products (Mydayis, Adderall) still matter for search, so
        // we keep them in a lower-priority bucket rather than dropping them.
        if (p.brand_name) {
          const brand = String(p.brand_name).trim();
          if (normalise(brand) !== key) {
            if (single) e.brands.add(brand);
            else if (ingredients.length <= 4) e.comboBrands.add(brand);
          }
        }

        const family = `${(p.route || []).join("|")}::${p.dosage_form || ""}`;
        e.forms.set(family, (e.forms.get(family) || 0) + 1);

        if (single) {
          const mg = strengthToMg(ai.strength);
          if (mg != null) e.strengthsMg.push(mg);
        }
        for (const u of p.openfda?.unii || []) e.unii.add(u);
        if (p.dea_schedule) e.schedules.add(p.dea_schedule);
      }
    }
    await rm(dest, { force: true });
  }

  log(`  ndc: ${byIngredient.size} distinct ingredients across marketed products`);
  return byIngredient;
}

/**
 * Drug labels -> best available PK extraction per substance.
 * 14 partitions, ~1.76 GB total, streamed and discarded one at a time.
 *
 * @returns {Promise<Map<string, object>>} normalised substance name -> pk result
 */
export async function loadLabelPk(cacheDir, log = () => {}, { maxPartitions = Infinity } = {}) {
  const { files, exportDate } = await partitions("label");
  const use = files.slice(0, maxPartitions);
  log(`  openFDA label export ${exportDate} (${use.length}/${files.length} partitions)`);

  const best = new Map(); // substance -> {pk, score}
  let labels = 0;

  for (const [i, url] of use.entries()) {
    const dest = path.join(cacheDir, path.basename(url));
    const { bytes, cached } = await download(url, dest);
    log(
      `  label ${i + 1}/${use.length} ${path.basename(url)} ` +
        `${(bytes / 1e6).toFixed(0)} MB${cached ? " (cached)" : ""}`
    );

    const stream = await openZipEntry(dest);
    for await (const label of streamResults(stream)) {
      labels++;
      const substances = label.openfda?.substance_name || [];
      if (!substances.length) continue;
      // A single-substance label unambiguously describes that drug's PK; a
      // combination label's prose mixes several, so we rank it lower.
      const single = substances.length === 1;
      if (!label.pharmacokinetics && !label.clinical_pharmacology) continue;

      const pk = extractPk(label);
      // Keep a label if the regex read something OR if it demonstrably holds
      // numbers we failed to parse — that second case is the LLM's queue, and
      // dropping it here would silently empty the residual pass.
      if (pk.tmax_min == null && pk.half_life_min == null && !pk.prodrug_of && !pk.needsLlm) {
        continue;
      }
      // Carry the prose forward only for the ones we'll escalate; holding raw
      // label text for every substance would balloon memory for no reason.
      if (pk.needsLlm && pk.tmax_min == null && pk.half_life_min == null) {
        pk.text = [label.pharmacokinetics, label.clinical_pharmacology]
          .flat()
          .filter((s) => typeof s === "string")
          .join("\n")
          .slice(0, 20000);
      }
      // A label we can actually read always beats one we'd have to escalate.
      const score = labelScore(pk) + (single ? 5 : 0) + (pk.needsLlm ? -3 : 0);

      for (const s of substances) {
        const key = stripSalt(s);
        if (!key || key.length < 3) continue;
        const prev = best.get(key);
        if (!prev || score > prev.score) best.set(key, { pk, score });
      }
    }

    // Free the disk before pulling the next partition.
    await rm(dest, { force: true });
  }

  log(`  labels: scanned ${labels}, PK recovered for ${best.size} substances`);
  const out = new Map();
  for (const [k, v] of best) out.set(k, v.pk);
  return out;
}

/** "40 mg/1" -> 40 ; "0.5 mg/mL" -> null (a concentration, not a unit dose). */
export function strengthToMg(strength) {
  if (!strength) return null;
  const m = String(strength).match(/^([\d.]+)\s*(mg|mcg|µg|ug|g)\s*\/\s*([\d.]*)\s*(\w*)/i);
  if (!m) return null;
  const denomQty = m[3] === "" ? 1 : parseFloat(m[3]);
  const denomUnit = (m[4] || "").toLowerCase();
  // Only per-unit strengths ("/1") describe one tablet/capsule.
  if (denomUnit && denomUnit !== "1") return null;
  if (denomQty !== 1) return null;

  const value = parseFloat(m[1]);
  if (!isFinite(value) || value <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit === "g") return value * 1000;
  if (unit === "mg") return value;
  return value / 1000; // mcg / µg / ug
}

export async function ensureCacheDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}
