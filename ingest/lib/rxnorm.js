// rxnorm.js — the canonical ingredient spine.
//
// One request. `/allconcepts?tty=IN` returns every RxNorm ingredient concept
// (~14.6k) with its RXCUI, which is the key we join Wikidata on.
//
// LICENSING NOTE: RxNorm's own normalised names and RXCUIs are US government
// work and public domain. The *full* RxNorm release also bundles proprietary
// source vocabularies (Micromedex, Medi-Span, First Databank, Gold Standard)
// which are NOT freely redistributable — so we deliberately touch only the
// RxNorm-normalised TTYs here (IN = ingredient), never source-vocabulary content.
//
// NLM's RxNav terms: "With one exception, no license is needed to use these
// APIs", capped at 20 requests/second. We make one request and cache it.

import { getJSON } from "./http.js";

const BASE = "https://rxnav.nlm.nih.gov/REST";

/** Mandatory attribution, per NLM terms of service. Surfaced in the app UI. */
export const NLM_ATTRIBUTION =
  "This product uses publicly available data from the U.S. National Library of " +
  "Medicine (NLM), National Institutes of Health, Department of Health and Human " +
  "Services; NLM is not responsible for the product and does not endorse or " +
  "recommend this or any other product.";

/**
 * Every RxNorm ingredient concept.
 * @returns {Promise<Array<{rxcui:string, name:string}>>}
 */
export async function loadIngredients() {
  const data = await getJSON(`${BASE}/allconcepts.json?tty=IN`, {
    throttleKey: "rxnav",
    minIntervalMs: 200, // 5 req/s — a quarter of NLM's 20/s ceiling
  });
  const concepts = data?.minConceptGroup?.minConcept || [];
  return concepts.map((c) => ({ rxcui: String(c.rxcui), name: c.name }));
}
