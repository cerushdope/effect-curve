// validate.mjs — the regression suite the reframe's Phase 0 asked for.
//
// Pulls the REAL records from Supabase, runs them through the same engine the
// browser runs, and diffs the computed onset / peak / duration against the
// published figures in frontend/src/data/felt.js.
//
//   node tools/validate.mjs              # the meds this project was built for
//   node tools/validate.mjs --all        # every drug with published observables
//   node tools/validate.mjs alprazolam diazepam
//
// Every fix before this one was verified against reasoning, which is not the
// same as being right.

import { computeSeries, applyPkFix, DEFAULT_CONDITIONS } from "../frontend/src/engine.js";
import { FELT, feltFor } from "../frontend/src/data/felt.js";

const SUPABASE_URL = "https://qzjvwxuwghegkfxmmseh.supabase.co";
const SUPABASE_KEY = "sb_publishable_SVnNGLJnxTy2-nz0nOYDMw_9sgAg6UH";

// The four the user actually has, plus the two that exercise the paths those
// four don't: a prodrug cascade and a saturable eliminator.
const DEFAULT_SET = [
  "methylphenidate", "lisdexamfetamine", "dextroamphetamine",
  "alprazolam", "diazepam", "clonazepam", "lorazepam",
];

const args = process.argv.slice(2);
const all = args.includes("--all");
const explicit = args.filter((a) => !a.startsWith("--"));
const ids = explicit.length ? explicit
  : all ? Object.keys(FELT).filter((k) => FELT[k].routes)
  : DEFAULT_SET;

async function fetchRecords(list) {
  const url = `${SUPABASE_URL}/rest/v1/substances?id=in.(${list.join(",")})&select=id,record`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return new Map(rows.map((r) => [r.id, applyPkFix(r.record)]));
}

const DOSE_AT = 480; // 08:00
const fmt = (m) => (m == null ? "  —  " : m < 90 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`);
const pad = (s, n) => String(s).padEnd(n);

function measure(facts, route) {
  const sub = {
    id: facts.id, name: facts.id, facts, routeId: route.id,
    color: "#000", muted: false, conditions: { ...DEFAULT_CONDITIONS },
    doses: [{ id: "d1", dose_mg: route.dose_ref, time_min: DOSE_AT }],
  };
  // Wide enough for anything, fine enough that landmarks aren't grid-quantised.
  const { grid_min, series } = computeSeries([sub], { start: DOSE_AT - 60, end_min: DOSE_AT + 3600, step_min: 2 });
  const s = series[0];
  if (!s) return null;
  const lm = s.landmarks;
  return {
    onset: lm.onset_min == null ? null : lm.onset_min - DOSE_AT,
    peak: lm.peak_min == null ? null : lm.peak_min - DOSE_AT,
    peakVal: lm.peak_value,
    duration: lm.onset_min != null && lm.offset_min != null ? lm.offset_min - lm.onset_min : null,
    rebound: lm.rebound_value,
    fitted: s.pd_fitted,
    pkShort: s.pk_short,
    plasmaTail: (() => {
      // where the blood level falls under 5% of its own peak
      const c = s.concentration;
      let pk = 0;
      for (const v of c) if (v > pk) pk = v;
      for (let i = c.length - 1; i >= 0; i--) if (c[i] > 0.05 * pk) return grid_min[i] - DOSE_AT;
      return null;
    })(),
  };
}

const TOL = 0.2; // 20% — anything inside this is as good as the source numbers
let pass = 0, fail = 0, skipped = 0;

const records = await fetchRecords(ids);
console.log("");
console.log(pad("drug / route", 34) + pad("onset", 16) + pad("duration", 18) + pad("peak", 9) + pad("crash", 8) + "blood");
console.log("-".repeat(100));

for (const id of ids) {
  const facts = records.get(id);
  if (!facts) { console.log(pad(id, 34) + "not in the database"); skipped++; continue; }

  for (const route of facts.routes || []) {
    const obs = feltFor(id, route.id, facts.category);
    if (obs.kind !== "fit") continue;
    const got = measure(facts, route);
    if (!got) continue;

    const onsetSlack = Math.max(10, TOL * obs.onset_min); // ±10 min floor: the published figures are not sharper than that
    const dOn = got.onset == null ? Infinity : Math.abs(got.onset - obs.onset_min) <= onsetSlack ? 0 : 1;
    const dDur = got.duration == null ? Infinity : Math.abs(got.duration - obs.duration_min) / obs.duration_min;
    const ok = dOn <= TOL && dDur <= TOL;
    ok ? pass++ : fail++;

    console.log(
      pad(`${ok ? "ok " : "FAIL"} ${id}/${route.id}`, 34) +
      pad(`${fmt(got.onset)} vs ${fmt(obs.onset_min)}`, 16) +
      pad(`${fmt(got.duration)} vs ${fmt(obs.duration_min)}`, 18) +
      pad(`${got.peakVal == null ? "—" : Math.round(got.peakVal)}`, 9) +
      pad(got.rebound == null ? "—" : Math.round(got.rebound), 8) +
      fmt(got.plasmaTail) + (got.pkShort ? "  [PK shorter than reported duration]" : ""),
    );
  }
}

console.log("-".repeat(100));
console.log(`${pass} within ${TOL * 100}%, ${fail} outside, ${skipped} missing.`);
console.log("");
console.log("Reading this table: 'onset' and 'duration' are what the model now produces");
console.log("vs the published figure it was fitted to — they should agree, and a FAIL means");
console.log("the fit could not reach the target (usually the PK can't support it). 'blood' is");
console.log("how long the drug stays measurable, which is a DIFFERENT number and is supposed");
console.log("to be much longer for something like diazepam.");
process.exit(fail > 0 ? 1 : 0);
