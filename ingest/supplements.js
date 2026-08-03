// supplements.js — upsert the curated supplement rows.
//
//   node supplements.js --dry-run     build and print, write nothing
//   node supplements.js               upsert to Supabase
//
// Separate from run.js on purpose: run.js downloads ~1 GB of bulk openFDA data
// and takes over an hour, and none of that is involved here. This finishes in
// about a second and is safe to re-run — same upsert, keyed on `id`.

import { buildSupplementRows, SUPPLEMENTS } from "./lib/supplements.js";
import { preflight, upsertSubstances } from "./lib/supabase.js";

const dryRun = process.argv.includes("--dry-run");
const log = (s) => console.log(s);

const rows = buildSupplementRows();

const felt = rows.filter((r) => !/single dose|one dose|same-day|weeks|days to weeks/i.test(r.record.notes));
log(`built ${rows.length} supplement rows (${Object.keys(SUPPLEMENTS).length} defined)`);
for (const r of rows) {
  const c = r.record.routes[0].pk_components[0];
  log(`  ${r.id.padEnd(18)} ${r.category.padEnd(20)} tmax=${String(c.input.tmax_min).padEnd(5)} ` +
      `t½=${String(c.decline.params.half_life_min).padEnd(6)} ${r.record.routes[0].dose_range.typical}${r.unit}`);
}

// Cheap structural check — a malformed row upserts fine and breaks the browser.
let bad = 0;
for (const r of rows) {
  const route = r.record.routes?.[0];
  const comp = route?.pk_components?.[0];
  const problems = [];
  if (!r.id || !r.name) problems.push("missing id/name");
  if (!route?.dose_ref) problems.push("no dose_ref");
  if (!(comp?.input?.tmax_min > 0)) problems.push("no Tmax");
  if (!(comp?.decline?.params?.half_life_min > 0)) problems.push("no half-life");
  if (!(route?.bioavailability_F > 0 && route.bioavailability_F <= 1)) problems.push("F out of range");
  if (!route?.pd_model?.ec50) problems.push("no pd_model");
  if (problems.length) { bad++; log(`  INVALID ${r.id}: ${problems.join(", ")}`); }
}
if (bad) {
  console.error(`\n${bad} invalid row(s) — refusing to write.`);
  process.exit(1);
}

if (dryRun) {
  log("\n--dry-run: nothing written.");
  process.exit(0);
}

await preflight(log);
const written = await upsertSubstances(rows, log);
log(`\nwrote ${written} supplement rows.`);
