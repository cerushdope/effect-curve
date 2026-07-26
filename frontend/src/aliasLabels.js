// aliasLabels.js — decide which alternative names are worth showing a human.
//
// The ingest job stores every string a user might plausibly type: brand names,
// INN/BAN spelling variants, salt forms, ATC codes, RxCUIs. That whole set is
// right for MATCHING and wrong for DISPLAY — nobody wants to see "N06BA12" or
// "pl080810060" under a search result.
//
// Searching "vyvanse" and getting a row that just says "Lisdexamfetamine" reads
// like the wrong drug, so the reason for the match has to be visible.

const norm = (s) =>
  String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Identifiers and machine codes — searchable, never shown. */
function isCode(alias) {
  const s = String(alias).trim();
  if (/^\d+$/.test(s)) return true; // RxCUI
  if (/^[A-Z]\d{2}[A-Z]{2}\d{2}$/.test(s)) return true; // ATC, e.g. N06BA12
  if (/\d{3,}/.test(s)) return true; // licence numbers, e.g. "PL 08081/0060"
  return false;
}

/**
 * A brand reads as a proper noun. Generic/INN variants arrive lowercase from
 * RxNorm, brands arrive Title Case or UPPERCASE from NDC and Wikidata — which
 * separates "Vyvanse" from "lisdexamphetamine" without needing a flag in the data.
 */
function looksLikeBrand(alias, canonicalName) {
  const s = String(alias).trim();
  if (s.length < 3 || isCode(s)) return false;
  if (s === s.toLowerCase()) return false; // spelling variant, not a brand
  const a = norm(s);
  const n = norm(canonicalName);
  if (!a || !n) return false;
  // "Lisdexamfetamine dimesylate" is just the generic plus a salt — not a brand.
  if (a === n || a.includes(n) || n.includes(a)) return false;
  return true;
}

/** "Lisdexamfetamine dimesylate" is the title plus a salt, not a separate name. */
function isNameVariant(alias, canonicalName) {
  const a = norm(alias);
  const n = norm(canonicalName);
  if (!a || !n) return false;
  return a === n || a.includes(n) || n.includes(a);
}

/**
 * Which alias did this query actually hit? Exact beats prefix beats substring,
 * so typing "vyv" surfaces "Vyvanse" rather than an incidental substring match.
 *
 * Returns null when the query already matches the displayed name — there is
 * nothing to explain then, and leading with "Lisdexamfetamine dimesylate"
 * because someone typed "lisdex" is just noise.
 */
export function matchedAlias(aliases, query, canonicalName = "") {
  const q = norm(query);
  if (!q) return null;
  if (norm(canonicalName).includes(q)) return null;

  const list = (aliases || []).filter(
    (a) => !isCode(a) && !isNameVariant(a, canonicalName)
  );
  return (
    list.find((a) => norm(a) === q) ||
    list.find((a) => norm(a).startsWith(q)) ||
    list.find((a) => norm(a).includes(q)) ||
    null
  );
}

/**
 * Brand names to show, most useful first: whatever the user typed leads, then
 * other brands. De-duplicated case-insensitively.
 * @returns {{matched: string|null, brands: string[]}}
 */
export function brandLabels(aliases, canonicalName, query, limit = 4) {
  const matched = matchedAlias(aliases, query, canonicalName);
  const seen = new Set([norm(canonicalName)]);
  const out = [];

  const push = (a) => {
    const k = norm(a);
    if (!k || seen.has(k) || out.length >= limit) return;
    seen.add(k);
    out.push(String(a).trim());
  };

  // The matched term leads even if it's a spelling variant rather than a brand —
  // it's the answer to "why is this row here?".
  if (matched) push(matched);
  for (const a of aliases || []) if (looksLikeBrand(a, canonicalName)) push(a);

  return { matched, brands: out };
}
