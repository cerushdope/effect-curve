// test-pk-gates.mjs — the PK sanity gates, checked against the records that
// were actually wrong in production. Run: node ingest/test-pk-gates.mjs
//
// Each case is a real row from the live table, described by what the extractor
// handed buildRecord. The assertion is about which number survives, and what
// provenance it ends up carrying.

import { buildRecord } from "./lib/record.js";

const NDC = (forms) => ({ forms, brands: new Set(), comboBrands: new Set(), strengthsMg: [1, 2], products: 5 });
const ORAL = [["ORAL::TABLET", 10]];

function build(pk, forms = ORAL) {
  return buildRecord({
    ingredient: "testdrug", displayName: "Testdrug",
    ndc: NDC(forms), wd: { atc: ["N05BA"], brands: [], aliases: [] }, pk, rxcui: "1",
  }).record;
}

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}
const lm = (r) => ({
  tmax: r.landmarks.tmax_min.value,
  tmaxSrc: r.landmarks.tmax_min.source_type,
  hl: r.landmarks.half_life_min.value,
  hlSrc: r.landmarks.half_life_min.source_type,
});

// --- the bug that shipped -------------------------------------------------- //
// Lorazepam: a 14 h Tmax (mis-parsed) beside a real 12 h half-life. The old code
// kept the Tmax and discarded the half-life, then stamped BOTH "openfda_label".
check("lorazepam: bad Tmax dropped, real half-life kept",
  lm(build({ tmax_min: 840, half_life_min: 720, source: "openfda_label" })),
  { tmax: 60, tmaxSrc: "class_default", hl: 720, hlSrc: "openfda_label" });

// The false-provenance case in general: a defaulted value must never claim a label.
check("defaulted half-life is stamped class_default, not openfda_label",
  lm(build({ tmax_min: 90, half_life_min: null, source: "openfda_label" })),
  { tmax: 90, tmaxSrc: "openfda_label", hl: 300, hlSrc: "class_default" });

// --- route-aware Tmax ceiling ---------------------------------------------- //
check("haloperidol: 6-day Tmax on an oral tablet is rejected",
  lm(build({ tmax_min: 8640, half_life_min: 1200, source: "llm_label" })),
  { tmax: 60, tmaxSrc: "class_default", hl: 1200, hlSrc: "llm_label" });

check("progesterone: 12-day Tmax on an oral tablet is rejected",
  lm(build({ tmax_min: 17280, half_life_min: null, source: "openfda_label" })),
  { tmax: 60, tmaxSrc: "class_default", hl: 300, hlSrc: "class_default" });

// A patch legitimately peaks in days — the wide bound must survive there.
check("patch: a multi-day Tmax is allowed through",
  lm(build({ tmax_min: 2880, half_life_min: 600, source: "openfda_label" },
            [["TRANSDERMAL::PATCH", 10]])),
  { tmax: 2880, tmaxSrc: "openfda_label", hl: 600, hlSrc: "openfda_label" });

// --- things that must NOT regress ------------------------------------------ //
check("ordinary consistent pair passes through untouched",
  lm(build({ tmax_min: 90, half_life_min: 978, source: "openfda_label" })),
  { tmax: 90, tmaxSrc: "openfda_label", hl: 978, hlSrc: "openfda_label" });

check("no PK at all still falls back cleanly",
  lm(build(null)),
  { tmax: 60, tmaxSrc: "class_default", hl: 300, hlSrc: "class_default" });

// Flip-flop kinetics on an XR product are real, and the engine models them.
// Tmax > 1/ke must NOT be treated as a contradiction there.
check("XR flip-flop (Tmax > 1/ke) survives",
  lm(build({ tmax_min: 480, half_life_min: 300, source: "openfda_label" },
            [["ORAL::TABLET, EXTENDED RELEASE", 10]])),
  { tmax: 480, tmaxSrc: "openfda_label", hl: 300, hlSrc: "openfda_label" });

// --- the note must not overclaim ------------------------------------------- //
const partial = build({ tmax_min: 90, half_life_min: null, source: "openfda_label" });
const claims = /Tmax and half-life auto-extracted/.test(partial.notes);
console.log(`${claims ? "FAIL" : "ok  "} note doesn't claim both numbers came off the label`);
console.log(`       "${partial.notes.split(".")[0]}."`);
if (claims) failed++;

console.log(`\n${failed === 0 ? "all gates hold" : failed + " FAILING"}`);
process.exit(failed ? 1 : 0);
