// aliases.js — name normalisation and mechanical spelling-variant generation.
//
// This is what makes "search any name" work. Three jobs:
//   1. normalise()  — collapse a messy source name to a join key
//   2. stripSalt()  — "LISDEXAMFETAMINE DIMESYLATE" -> "lisdexamfetamine"
//   3. variants()   — generate INN/USAN/BAN spelling pairs, so the British
//                     "lisdexamphetamine" finds the US "lisdexamfetamine"

// Salt / hydrate / ester suffixes that RxNorm and openFDA append to the base
// moiety. Order matters: multi-word forms first.
const SALTS = [
  "hydrochloride", "hydrobromide", "hydroiodide", "dihydrochloride",
  "dimesylate", "mesylate", "besylate", "tosylate", "esylate",
  "sulfate", "sulphate", "bisulfate", "hemisulfate",
  "phosphate", "diphosphate", "hydrogen phosphate",
  "maleate", "fumarate", "hemifumarate", "tartrate", "bitartrate",
  "citrate", "dihydrogen citrate", "succinate", "malate", "oxalate",
  "acetate", "diacetate", "propionate", "dipropionate", "valerate",
  "furoate", "xinafoate", "pamoate", "embonate", "napsylate",
  "sodium", "potassium", "calcium", "magnesium", "lithium", "zinc",
  "chloride", "bromide", "iodide", "nitrate", "carbonate", "gluconate",
  "lactate", "stearate", "palmitate", "decanoate", "enanthate", "undecanoate",
  "monohydrate", "dihydrate", "trihydrate", "hemihydrate", "anhydrous",
  "as base", "base",
];

// INN vs USAN vs BAN spelling pairs, applied as substring swaps. These are the
// systematic ones — WHO's INN rules vs the older British/US forms.
//
// `false` in the third slot means one-way (a -> b only). The digraph rules must
// be one-way: "oe" -> "e" is right (oestradiol -> estradiol), but running it
// backwards would rewrite every "e" and yield nonsense like "lisdoexamfoetaminoe".
const SPELLING_PAIRS = [
  ["amfetamine", "amphetamine", true], // lisdexamfetamine <-> lisdexamphetamine
  ["sulfa", "sulpha", true],
  ["sulf", "sulph", true],
  ["cef", "ceph", true],
  ["oe", "e", false],
  ["ae", "e", false],
  ["indometacin", "indomethacin"],
  ["paracetamol", "acetaminophen"],
  ["adrenaline", "epinephrine"],
  ["noradrenaline", "norepinephrine"],
  ["salbutamol", "albuterol"],
  ["glibenclamide", "glyburide"],
  ["frusemide", "furosemide"],
  ["lignocaine", "lidocaine"],
  ["pethidine", "meperidine"],
  ["ciclosporin", "cyclosporine"],
  ["rifampicin", "rifampin"],
  ["colecalciferol", "cholecalciferol"],
  ["dexamfetamine", "dextroamphetamine"],
];

/** Lowercase, strip punctuation/diacritics, collapse whitespace. */
export function normalise(s) {
  if (!s) return "";
  return String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Remove trailing salt/hydrate words to get at the base moiety. */
export function stripSalt(name) {
  let out = normalise(name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const salt of SALTS) {
      if (out.endsWith(" " + salt)) {
        out = out.slice(0, -(salt.length + 1)).trim();
        changed = true;
      }
    }
  }
  return out || normalise(name);
}

/** Mechanical spelling variants of a name (does not include the input). */
export function variants(name) {
  const base = normalise(name);
  const out = new Set();
  for (const [a, b, bidirectional = true] of SPELLING_PAIRS) {
    if (base.includes(a)) out.add(base.split(a).join(b));
    if (bidirectional && base.includes(b)) out.add(base.split(b).join(a));
  }
  // Hyphen/space-insensitive form — only for short names. Collapsing the spaces
  // in a systematic chemical name produces unsearchable noise.
  if (base.includes(" ") && base.length < 24) out.add(base.replace(/ /g, ""));
  out.delete(base);
  return [...out].filter((v) => v.length > 2);
}

/**
 * Systematic chemical names (IUPAC/InChI-style) arrive via Wikidata aliases.
 * Nobody types "(2S)-2,6-diamino-N-[[(2S)-1-fenilpropan-2-il]heksanamid" into a
 * search box, and they crowd out the brand names that matter.
 */
export function isChemicalName(s) {
  const str = String(s);
  if (str.length > 60) return true;
  if (/[[\]{}]/.test(str)) return true; // bracketed locants
  if (/\d[,-]\d/.test(str)) return true; // "2,6-" / "1-2" locant runs
  if (/^\(\d*[RSEZ][,)]/i.test(str)) return true; // stereo-descriptor prefix
  // Long and digit-heavy: systematic, not a brand.
  if (str.length > 28 && (str.match(/\d/g) || []).length >= 3) return true;
  return false;
}

/** Only keep names a Latin-alphabet user could plausibly type. */
export function isLatin(s) {
  return typeof s === "string" && /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}+]+$/u.test(s) && /\p{L}/u.test(s);
}

/** Title-case a brand name for display ("VYVANSE" -> "Vyvanse"). */
export function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

/** URL/DB-safe stable id from an ingredient name. */
export function slug(name) {
  return normalise(name).replace(/ /g, "_").slice(0, 60) || "unknown";
}

/**
 * Build the final alias list for a substance: every string a user might type.
 * Deduplicated case-insensitively, canonical display name excluded.
 */
export function buildAliases(canonical, pools) {
  const seen = new Set([normalise(canonical)]);
  const out = [];
  const add = (raw) => {
    if (!raw) return;
    const s = String(raw).trim();
    if (s.length < 2 || s.length > 80) return;
    if (!isLatin(s)) return;
    if (isChemicalName(s)) return;
    const key = normalise(s);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  for (const pool of pools) for (const item of pool || []) add(item);

  // Spelling variants of everything collected so far, plus the canonical name.
  for (const src of [canonical, ...out.slice()]) {
    for (const v of variants(src)) add(v);
  }
  return out.slice(0, 120); // keep rows small; 120 is far past useful
}
