// pk.js — pull Tmax and half-life out of free-text openFDA label prose.
//
// FDA labels have no structured PK fields; the numbers live in sentences like
// "T max of lisdexamfetamine and dextroamphetamine was reached at approximately
// 1 hour and 3.5 hours post dose". So we regex for every plausible statement,
// convert to minutes, discard implausible values, and take the MEDIAN of what
// survives — one bad match can't then drag the answer far.
//
// This is deliberately approximate. Everything it produces is confidence "low".

// A time quantity: "3.5 hours", "20 to 30 min", "1-2 h".
//
// The optional (…) groups matter more than they look. Labels routinely wedge a
// CV%, an n, or a range between the number and its unit — "half-life was 18 (7)
// hours", "t max is 4 (1, 8) hours". Without them these silently score as misses,
// and they were ~20% of all extraction failures in the corpus sample.
const VALUE_RE =
  /(\d+(?:\.\d+)?)\s*(?:\([^)]{0,24}\)\s*)?(?:to|through|[-‐-―])?\s*(\d+(?:\.\d+)?)?\s*(?:\([^)]{0,24}\)\s*)?(hours?|hrs?|h|minutes?|mins?|days?)\b/gi;

const TO_MINUTES = {
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
  min: 1, mins: 1, minute: 1, minutes: 1,
  day: 1440, days: 1440,
};

// Plausibility gates. Anything outside these is a mis-parse (a dose, a study
// duration, a percentage) rather than a real PK value.
const BOUNDS = {
  // Upper bound is 14 days, not 24 h: monoclonal antibodies genuinely peak in
  // days (denosumab ~10 d, burosumab 8–11 d). A 24 h ceiling silently discarded
  // every biologic in the corpus sample.
  tmax: [2, 20160],
  halfLife: [1, 43200], // 1 min .. 30 days
};

// We anchor on a KEYWORD, then read every time quantity in the rest of that
// sentence — not just the first. That matters: "T max of lisdexamfetamine and
// dextroamphetamine was reached at approximately 1 hour and 3.5 hours post dose,
// respectively" carries the parent's Tmax first and the active moiety's second.
// A lazy first-match regex silently returns the wrong one.
// U+2044 FRACTION SLASH appears alongside "/" in real labels ("t1⁄2").
const HALF_LIFE_ANCHORS = [
  /half[-\s]?li(?:fe|ves)/gi,
  /t\s*(?:1\s*[/⁄]\s*2|½)/gi,
];

const TMAX_ANCHORS = [
  /\bT\s*(?:max|_?max)\b/gi,
  /(?:peak|maximum)\s+(?:plasma\s+|serum\s+|blood\s+)?(?:concentrations?|levels?)/gi,
  /time\s+to\s+(?:reach\s+)?(?:peak|maximum)/gi,
];

const PRODRUG_RE = /\bis\s+a\s+prodrug\s+of\s+([a-z][a-z\s-]{2,40}?)(?:[.,;]|\s+and\b|\s+which\b)/i;

function toMinutes(value, unit) {
  const mult = TO_MINUTES[String(unit).toLowerCase().replace(/\.$/, "")];
  return mult ? value * mult : null;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * For each anchor hit, read every time quantity in the remainder of the
 * sentence. Returns all in-bounds values, in minutes.
 */
function collect(text, anchors, bounds) {
  const [lo, hi] = bounds;
  const out = [];
  // Tracks whether the label discussed the concept with digits present. If it
  // did and we still got nothing, that's a PARSE failure (usually a flattened
  // table) and worth escalating. If no digits were there at all, the label
  // genuinely states no value — escalating that would only invite invention.
  let windowsWithDigits = 0;
  for (const anchor of anchors) {
    anchor.lastIndex = 0;
    let m;
    while ((m = anchor.exec(text)) !== null) {
      // Window = rest of the sentence, capped. The sentence terminator must be
      // followed by whitespace so decimals ("3.5") don't split the window.
      let window = text.slice(m.index + m[0].length, m.index + m[0].length + 240);
      const stop = window.search(/[.;:](?:\s|$)/);
      if (stop > 0) window = window.slice(0, stop);
      if (/\d/.test(window)) windowsWithDigits++;

      VALUE_RE.lastIndex = 0;
      let v;
      while ((v = VALUE_RE.exec(window)) !== null) {
        const a = parseFloat(v[1]);
        const b = v[2] != null ? parseFloat(v[2]) : null;
        // A range ("3 to 5 hours") collapses to its midpoint.
        const value = b != null && b > a ? (a + b) / 2 : a;
        const mins = toMinutes(value, v[3]);
        if (mins != null && mins >= lo && mins <= hi) out.push(mins);
      }
      if (out.length > 60) break; // long labels repeat themselves; enough is enough
    }
  }
  out.windowsWithDigits = windowsWithDigits;
  return out;
}

/**
 * Extract PK landmarks from an openFDA label record.
 * @param {object} label an openFDA drug/label result
 * @returns {{tmax_min:number|null, half_life_min:number|null,
 *            prodrug_of:string|null, samples:{tmax:number,halfLife:number}}}
 */
export function extractPk(label) {
  const text = [
    label.pharmacokinetics,
    label.clinical_pharmacology,
    label.description,
  ]
    .flat()
    .filter((s) => typeof s === "string")
    .join("\n");

  if (!text) {
    return { tmax_min: null, half_life_min: null, prodrug_of: null, samples: { tmax: 0, halfLife: 0 } };
  }

  const tmaxValues = collect(text, TMAX_ANCHORS, BOUNDS.tmax);
  const halfLifeValues = collect(text, HALF_LIFE_ANCHORS, BOUNDS.halfLife);
  const prodrugMatch = text.match(PRODRUG_RE);

  // For a prodrug the FELT curve belongs to the active metabolite, which peaks
  // later than the parent. Taking the median would average the two and
  // understate onset, so lean to the upper half of the observed Tmax spread.
  const tmaxCentre = prodrugMatch
    ? median(tmaxValues.filter((v) => v >= (median(tmaxValues) ?? 0)))
    : median(tmaxValues);

  return {
    tmax_min: round(tmaxCentre),
    half_life_min: round(median(halfLifeValues)),
    // The spread matters for prodrugs: a parent peaking at 1 h feeding a
    // metabolite peaking at 3.5 h shows up as a wide min/max.
    tmax_range: tmaxValues.length ? [Math.min(...tmaxValues), Math.max(...tmaxValues)] : null,
    half_life_range: halfLifeValues.length
      ? [Math.min(...halfLifeValues), Math.max(...halfLifeValues)]
      : null,
    prodrug_of: prodrugMatch ? prodrugMatch[1].trim().toLowerCase() : null,
    samples: { tmax: tmaxValues.length, halfLife: halfLifeValues.length },
    // Escalate ONLY when we got NOTHING yet the numbers are demonstrably in the
    // text — in practice, tables flattened into prose with the unit stranded in
    // a header ("Time to Peak (hours) 1."). A missing Tmax alone is not worth a
    // call: the route default covers it. Everything else uses class defaults,
    // because a label that says "half-life did not change" holds no value to
    // find and asking a model would only invite invention.
    needsLlm:
      tmaxValues.length === 0 &&
      halfLifeValues.length === 0 &&
      tmaxValues.windowsWithDigits + halfLifeValues.windowsWithDigits > 0,
  };
}

function round(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

/** Score a label so we keep the most informative one per substance. */
export function labelScore(pk) {
  return (
    (pk.tmax_min != null ? 2 : 0) +
    (pk.half_life_min != null ? 2 : 0) +
    Math.min(pk.samples.tmax + pk.samples.halfLife, 6) +
    (pk.prodrug_of ? 1 : 0)
  );
}
