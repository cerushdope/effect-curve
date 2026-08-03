#!/usr/bin/env node
// run.js — the ingestion job.
//
//   RxNorm  ->  canonical ingredient spine (one request, 14.6k ingredients)
//   Wikidata->  international brand names + ATC class   (CC0, ~3 SPARQL queries)
//   openFDA ->  US brands, dose forms, strengths, and PK prose (bulk downloads)
//   regex   ->  Tmax + half-life for ~96% of substances that state them
//   Claude  ->  the ~4% residual where the numbers are in a flattened table
//
// Re-runnable and idempotent: every row is an upsert keyed on `id`.
//
//   node run.js --dry-run --limit 400     # no writes, writes build/substances.json
//   node run.js                           # full run + upsert
//   node run.js --only lisdexamfetamine,ibuprofen
//
// Attribution required by NLM's terms of service is emitted into every record's
// provenance and surfaced in the app UI.

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { loadIngredients, NLM_ATTRIBUTION } from "./lib/rxnorm.js";
import { loadWikidata } from "./lib/wikidata.js";
import { loadNdc, loadLabelPk, ensureCacheDir, OPENFDA_ATTRIBUTION } from "./lib/openfda.js";
import { resolveWithLlm } from "./lib/llm.js";
import { buildRecord, pkRepairs } from "./lib/record.js";
import { preflight, upsertSubstances, listExistingIds, deleteSubstances } from "./lib/supabase.js";
import { stripSalt, normalise, titleCase } from "./lib/aliases.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- CLI ------------------------------------------------------------------ //
function parseArgs(argv) {
  const opts = {
    dryRun: false, limit: 0, only: null, prune: false,
    llmMaxCalls: 20, noLlm: false, maxPartitions: Infinity,
    out: path.join(HERE, "build", "substances.json"),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--prune") opts.prune = true;
    else if (a === "--no-llm") opts.noLlm = true;
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--only") opts.only = argv[++i].split(",").map((s) => stripSalt(s.trim()));
    else if (a === "--llm-max-calls") opts.llmMaxCalls = Number(argv[++i]);
    else if (a === "--max-partitions") opts.maxPartitions = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else { console.error(`unknown flag: ${a}`); usage(); process.exit(1); }
  }
  return opts;
}

function usage() {
  console.log(`
effect-curve ingest

  --dry-run              build records, write JSON, do not touch Supabase
  --limit N              cap ingredients processed (smoke tests)
  --only a,b,c           restrict to named ingredients
  --prune                delete rows this run did not produce (default: keep)
  --no-llm               skip the LLM residual pass entirely
  --llm-max-calls N      cap model calls (default 20)
  --max-partitions N     only read the first N openFDA label partitions
  --out PATH             where to write the JSON artifact

env: SUPABASE_SERVICE_ROLE_KEY (required unless --dry-run)
     SUPABASE_URL, ANTHROPIC_API_KEY (optional)
`);
}

const t0 = Date.now();
const log = (msg) => {
  const s = ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
  console.log(`[${s}s] ${msg}`);
};

// ---- main ----------------------------------------------------------------- //
async function main() {
  const opts = parseArgs(process.argv);

  // Fail before the downloads, not after. Presence of the key is not enough —
  // a key can be set and correct and still lack the GRANTs needed to write, so
  // actually round-trip a write here rather than just checking the env var.
  if (!opts.dryRun) {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        "SUPABASE_SERVICE_ROLE_KEY is not set, and this is not a --dry-run.\n" +
          "  In CI: add it as a REPOSITORY secret (Settings > Secrets and variables >\n" +
          "  Actions > Secrets tab). An *environment* secret will not reach this job,\n" +
          "  because the workflow does not declare an `environment:`."
      );
    }
    log("preflight: checking write access…");
    await preflight(log);
  }
  // Deliberately outside the repo: the project lives in a OneDrive folder, and
  // a multi-hundred-MB cache inside it would be sync'd to the cloud.
  const cacheDir = await ensureCacheDir(
    process.env.INGEST_CACHE_DIR || path.join(os.tmpdir(), "effect-curve-ingest")
  );
  log(`cache: ${cacheDir}`);

  // 1 ---------------------------------------------------------------- RxNorm
  log("RxNorm: ingredient spine…");
  const ingredients = await loadIngredients();
  log(`  ${ingredients.length} ingredient concepts`);

  const byKey = new Map(); // normalised ingredient -> {displayName, rxcui}
  for (const c of ingredients) {
    const key = stripSalt(c.name);
    if (!key || key.length < 3) continue;
    if (!byKey.has(key)) byKey.set(key, { displayName: c.name, rxcui: c.rxcui });
  }

  // 2 -------------------------------------------------------------- Wikidata
  log("Wikidata: international brands + ATC…");
  const wikidata = await loadWikidata(log);
  const wdByRxcui = wikidata;
  // Index by every name Wikidata knows for the ingredient, not just its English
  // label — RxNorm and Wikidata disagree on preferred spelling often enough
  // (INN vs USAN, salt vs base) that a label-only join loses roughly a third of
  // the ATC classifications.
  const wdByKey = new Map();
  for (const entry of wikidata.values()) {
    for (const name of [entry.label, ...entry.aliases]) {
      if (!name) continue;
      const key = stripSalt(name);
      if (key && key.length > 2 && !wdByKey.has(key)) wdByKey.set(key, entry);
    }
  }
  log(`  wikidata: ${wdByKey.size} name keys indexed`);

  // 3 ------------------------------------------------------------ openFDA NDC
  log("openFDA: NDC directory (US brands, forms, strengths)…");
  const ndc = await loadNdc(cacheDir, log);

  // ---- decide the working set -------------------------------------------- //
  // Keep an ingredient if it has a real marketed US product OR a drug class.
  // That filter drops RxNorm's long tail of excipients and raw polymers.
  const keys = new Set([...byKey.keys(), ...ndc.keys()]);
  let working = [...keys].filter((key) => {
    if (opts.only) return opts.only.includes(key);
    const hasProducts = ndc.has(key);
    const wd = wdByKey.get(key);
    return hasProducts || (wd && wd.atc.length);
  });
  working.sort((a, b) => (ndc.get(b)?.products || 0) - (ndc.get(a)?.products || 0));
  if (opts.limit > 0) working = working.slice(0, opts.limit);
  log(`working set: ${working.length} ingredients`);

  // 4 --------------------------------------------------- openFDA label PK text
  log("openFDA: drug labels (PK extraction)…");
  const labelPk = await loadLabelPk(cacheDir, log, { maxPartitions: opts.maxPartitions });

  // 5 ----------------------------------------------------------- LLM residual
  const pending = [];
  if (!opts.noLlm) {
    for (const key of working) {
      const pk = labelPk.get(key);
      if (pk?.needsLlm && pk.tmax_min == null && pk.half_life_min == null && pk.text) {
        pending.push({ substance: key, text: pk.text });
      }
    }
  }
  const llmResolved = await resolveWithLlm(pending, { maxCalls: opts.llmMaxCalls, log });

  // 6 ------------------------------------------------------------- assemble
  log("building records…");
  const rows = [];
  const stats = { regex: 0, llm: 0, defaults: 0, skipped: 0 };

  for (const key of working) {
    const spine = byKey.get(key);
    // RxCUI is an exact identifier; prefer it over a name match, which can
    // collide across similarly-named moieties.
    const wd = (spine && wdByRxcui.get(spine.rxcui)) || wdByKey.get(key) || null;
    let pk = labelPk.get(key) || null;

    const fromLlm = llmResolved.get(key);
    if (fromLlm) {
      pk = { ...(pk || {}), ...fromLlm, source: "llm_label" };
      stats.llm++;
    } else if (pk && (pk.tmax_min != null || pk.half_life_min != null)) {
      pk = { ...pk, source: "openfda_label" };
      stats.regex++;
    } else {
      stats.defaults++;
    }

    const displayName = spine?.displayName || wd?.label || titleCase(key);
    const row = buildRecord({
      ingredient: key,
      displayName: cleanName(displayName),
      ndc: ndc.get(key) || null,
      wd,
      pk,
      rxcui: spine?.rxcui || wd?.rxcui || null,
    });
    if (!row) { stats.skipped++; continue; }
    rows.push(row);
  }

  // Two RxNorm ingredients can slug to the same id; keep the better-evidenced one.
  const deduped = new Map();
  for (const row of rows) {
    const prior = deduped.get(row.id);
    if (!prior || (row.aliases.length > prior.aliases.length)) deduped.set(row.id, row);
  }
  const final = [...deduped.values()];

  log(`built ${final.length} rows  (PK: ${stats.regex} regex, ${stats.llm} llm, ${stats.defaults} class-default; ${stats.skipped} skipped)`);

  await mkdir(path.dirname(opts.out), { recursive: true });
  await writeFile(opts.out, JSON.stringify(final, null, 1));
  log(`wrote ${opts.out}`);

  await selfCheck(final, log);

  // 7 ---------------------------------------------------------------- upsert
  if (opts.dryRun) {
    log("--dry-run: no writes to Supabase");
    summary(final, stats);
    return;
  }

  log(`upserting ${final.length} rows…`);
  await upsertSubstances(final, log);

  if (opts.prune) {
    const existing = await listExistingIds();
    const produced = new Set(final.map((r) => r.id));
    const stale = existing.filter((id) => !produced.has(id));
    log(`pruning ${stale.length} rows not produced by this run…`);
    await deleteSubstances(stale, log);
  }

  summary(final, stats);
  log("done");
}

/** RxNorm ingredient names are lowercase; brands are shouty. Normalise for display. */
function cleanName(name) {
  const s = String(name).trim();
  if (s === s.toUpperCase() && s.length > 3) return titleCase(s);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Fail loudly if the names the project explicitly requires don't resolve.
 * These are the acceptance criteria, not decoration.
 */
async function selfCheck(rows, log) {
  const index = new Map();
  for (const row of rows) {
    index.set(normalise(row.name), row.id);
    for (const a of row.aliases) index.set(normalise(a), row.id);
  }
  const required = ["Vyvanse", "Elvanse", "Mydayis", "lisdexamfetamine", "lisdexamphetamine"];
  const missing = [];
  log("self-check — required names:");
  for (const name of required) {
    const hit = index.get(normalise(name));
    log(`  ${hit ? "OK  " : "MISS"} ${name.padEnd(22)} ${hit || ""}`);
    if (!hit) missing.push(name);
  }
  if (missing.length) log(`  WARNING: ${missing.length} required name(s) unresolved: ${missing.join(", ")}`);
  return missing;
}

function summary(rows, stats) {
  const cats = new Map();
  for (const r of rows) cats.set(r.category, (cats.get(r.category) || 0) + 1);
  const top = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log("\n--- summary ---");
  console.log(`rows        ${rows.length}`);
  console.log(`aliases     ${rows.reduce((n, r) => n + r.aliases.length, 0)}`);
  console.log(`pk source   regex ${stats.regex} | llm ${stats.llm} | class-default ${stats.defaults}`);
  console.log(`pk repairs  ${pkRepairs.inconsistent} impossible Tmax/half-life pairs, ` +
    `${pkRepairs.implausibleTmax} Tmax over the route ceiling, ` +
    `${pkRepairs.identicalPair} identical Tmax/half-life pairs, ` +
    `${pkRepairs.uncorroborated} uncorroborated extreme half-lives, ` +
    `${pkRepairs.absurdHalfLife} absurd half-lives -> class default`);
  console.log(`categories  ${top.map(([c, n]) => `${c}:${n}`).join("  ")}`);
  console.log(`\n${NLM_ATTRIBUTION}\n${OPENFDA_ATTRIBUTION}\nSubstance names and classifications from Wikidata (CC0).`);
}

main().catch((err) => {
  console.error("\ningest failed:", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
