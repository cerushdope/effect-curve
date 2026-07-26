// llm.js — the ~4% the regex can't read.
//
// A corpus analysis over a 350-label sample (see README) put the split at:
//   54.6%  both Tmax and half-life read by regex
//   41.5%  label states no number at all      -> class defaults, NEVER an LLM
//    3.8%  numbers are demonstrably present but unparseable -> here
//
// That last bucket is almost entirely tables flattened into prose, with the
// unit stranded in a header ("Time to Peak (hours) 1."). Those are worth a
// model call. The 41.5% are not: asking a model to read a value out of a
// sentence that says "the half-life did not change" invites invention.
//
// Batched ~15 substances per call, so the whole residual costs single-digit
// calls per run.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";
const BATCH_SIZE = 15;
const MAX_EXCERPT_CHARS = 1400;

/** Forces well-formed output — no JSON repair, no parse guards downstream. */
const PK_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          substance: { type: "string" },
          tmax_min: { anyOf: [{ type: "number" }, { type: "null" }] },
          half_life_min: { anyOf: [{ type: "number" }, { type: "null" }] },
          found: { type: "boolean" },
        },
        required: ["substance", "tmax_min", "half_life_min", "found"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const SYSTEM = `You read pharmacokinetic values out of US FDA drug label text.

For each substance you are given an excerpt. Report two numbers, BOTH IN MINUTES:
  tmax_min       time to peak plasma concentration
  half_life_min  elimination / terminal half-life

Rules:
- Convert units yourself: hours x60, days x1440.
- A range collapses to its midpoint. "4 (1, 8) hours" means 4 hours - the
  parenthetical is a range or CV, not the value.
- These excerpts are mostly TABLES flattened into prose, where the unit sits in
  a column header far from the number ("Time to Peak (hours) ... 1.5"). Match
  the number to its header.
- For a prodrug, report the ACTIVE METABOLITE's values, not the parent's.
- If a value genuinely is not stated, return null for it. Do not estimate, do
  not infer from drug class, do not use outside knowledge. A null is a correct
  and useful answer; a plausible guess is not.
- Set found=false if neither value is stated.

These figures drive an illustrative wellness graph, not clinical dosing.`;

function excerpt(text) {
  if (!text) return "";
  // Keep only the neighbourhoods that mention the concepts, so a 100 KB label
  // doesn't spend the budget on sections about pregnancy or storage.
  const anchors = /half[-\s]?li(?:fe|ves)|t\s*(?:1\s*[/⁄]\s*2|½)|T\s*max|time\s+to\s+peak|peak\s+plasma/gi;
  const windows = [];
  let m;
  anchors.lastIndex = 0;
  while ((m = anchors.exec(text)) !== null && windows.length < 12) {
    windows.push(text.slice(Math.max(0, m.index - 160), m.index + 260));
  }
  const joined = (windows.length ? windows.join(" … ") : text).replace(/\s+/g, " ");
  return joined.slice(0, MAX_EXCERPT_CHARS);
}

/**
 * @param {Array<{substance:string, text:string}>} pending substances the regex couldn't read
 * @param {{maxCalls?:number, log?:Function}} [opts]
 * @returns {Promise<Map<string,{tmax_min:number|null, half_life_min:number|null}>>}
 */
export async function resolveWithLlm(pending, opts = {}) {
  const { maxCalls = 20, log = () => {} } = opts;
  const out = new Map();
  if (!pending.length) return out;

  if (!process.env.ANTHROPIC_API_KEY) {
    log(`  llm: ANTHROPIC_API_KEY not set — ${pending.length} substances fall back to defaults`);
    return out;
  }

  const client = new Anthropic();
  const batches = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    batches.push(pending.slice(i, i + BATCH_SIZE));
  }

  if (batches.length > maxCalls) {
    log(`  llm: capping at ${maxCalls} calls; ${(batches.length - maxCalls) * BATCH_SIZE} substances will use defaults`);
    batches.length = maxCalls;
  }
  log(`  llm: ${pending.length} substances -> ${batches.length} call(s)`);

  for (const [i, batch] of batches.entries()) {
    const prompt = batch
      .map((p, n) => `### ${n + 1}. ${p.substance}\n${excerpt(p.text)}`)
      .join("\n\n");

    try {
      const res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        // Mechanical extraction — low effort keeps this cheap. Thinking stays
        // ON: disabling it on this model can leak <thinking> tags into output.
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: PK_SCHEMA },
        },
        // Reading pharmacology out of drug labels sits close enough to the
        // life-sciences safety classifiers to trip them occasionally. Without
        // a fallback a declined request just stops.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: prompt }],
      });

      if (res.stop_reason === "refusal") {
        log(`  llm: batch ${i + 1}/${batches.length} declined (${res.stop_details?.category ?? "unspecified"}) — using defaults`);
        continue;
      }

      const text = res.content.find((b) => b.type === "text")?.text;
      if (!text) continue;
      const parsed = JSON.parse(text);

      for (const r of parsed.results || []) {
        if (!r.found) continue;
        if (r.tmax_min == null && r.half_life_min == null) continue;
        out.set(r.substance, {
          tmax_min: sane(r.tmax_min, 2, 20160),
          half_life_min: sane(r.half_life_min, 1, 43200),
        });
      }
      log(`  llm: batch ${i + 1}/${batches.length} resolved ${parsed.results?.filter((r) => r.found).length || 0}/${batch.length}`);
    } catch (err) {
      log(`  llm: batch ${i + 1}/${batches.length} failed (${err.message}) — using defaults`);
    }
  }

  return out;
}

/** Same plausibility gate the regex path uses — a model can misread a table too. */
function sane(v, lo, hi) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return v >= lo && v <= hi ? Math.round(v * 10) / 10 : null;
}
