// wikidata.js — international names + ATC classification, joined on RxCUI.
//
// THIS IS THE MODULE THAT FIXES "Elvanse". RxNorm is a US vocabulary and simply
// does not contain EU brand names — `rxcui.json?name=Elvanse` returns nothing.
//
// The trick is that Wikidata does NOT keep foreign brands as aliases on the
// ingredient item (a spot-check of lisdexamfetamine's altLabels finds only LDX,
// NRP104 and some translations). They are separate MEDICINAL PRODUCT items,
// reached from the ingredient through P3780 "active ingredient in":
//
//   lisdexamfetamine (Q6558704) --P3780--> Elvanse   (Q115629826)
//                               --P3780--> Vyvanse
//                               --P3780--> Venvanse
//                               --P3780--> Aduvanz
//
// Wikidata is CC0, so there are no licensing strings attached.

import { USER_AGENT } from "./http.js";
import { isLatin } from "./aliases.js";

const ENDPOINT = "https://query.wikidata.org/sparql";

const Q_CORE = `
SELECT ?rxcui ?ing ?ingLabel ?atc ?unii WHERE {
  ?ing wdt:P3345 ?rxcui .
  OPTIONAL { ?ing wdt:P267 ?atc }
  OPTIONAL { ?ing wdt:P652 ?unii }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

// Brand names: labels AND aliases of every medicinal product the ingredient is
// an active ingredient in. All languages; non-Latin scripts are dropped later.
const Q_BRANDS = `
SELECT ?rxcui ?brand WHERE {
  ?ing wdt:P3345 ?rxcui ; wdt:P3780 ?prod .
  { ?prod rdfs:label ?brand } UNION { ?prod skos:altLabel ?brand }
}`;

// Aliases on the ingredient itself (INN variants, research codes like NRP104).
const Q_ALIASES = `
SELECT ?rxcui ?alias WHERE {
  ?ing wdt:P3345 ?rxcui ; skos:altLabel ?alias .
}`;

async function sparql(query, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/sparql-query",
          Accept: "application/sparql-results+json",
          // WDQS policy requires a descriptive User-Agent identifying the client.
          "User-Agent": USER_AGENT,
        },
        body: query,
      });
      if (!res.ok) throw new Error(`WDQS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      return json.results.bindings;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * @returns {Promise<Map<string, {rxcui:string, item:string, label:string|null,
 *   atc:string[], unii:string[], brands:string[], aliases:string[]}>>} keyed by RxCUI
 */
export async function loadWikidata(log = () => {}) {
  const byRxcui = new Map();
  const ensure = (rxcui) => {
    let e = byRxcui.get(rxcui);
    if (!e) {
      e = { rxcui, item: null, label: null, atc: [], unii: [], brands: [], aliases: [] };
      byRxcui.set(rxcui, e);
    }
    return e;
  };

  log("  wikidata: core (rxcui + ATC + UNII)…");
  for (const b of await sparql(Q_CORE)) {
    const e = ensure(b.rxcui.value);
    e.item = b.ing.value.split("/").pop();
    if (b.ingLabel && !e.label) e.label = b.ingLabel.value;
    if (b.atc && !e.atc.includes(b.atc.value)) e.atc.push(b.atc.value);
    if (b.unii && !e.unii.includes(b.unii.value)) e.unii.push(b.unii.value);
  }
  log(`  wikidata: ${byRxcui.size} ingredients carry an RxCUI`);

  log("  wikidata: brands via P3780 'active ingredient in'…");
  let brandRows = 0;
  for (const b of await sparql(Q_BRANDS)) {
    const name = b.brand.value;
    if (!isLatin(name)) continue;
    const e = ensure(b.rxcui.value);
    if (!e.brands.includes(name)) e.brands.push(name);
    brandRows++;
  }
  log(`  wikidata: ${brandRows} brand names`);

  log("  wikidata: ingredient aliases…");
  for (const b of await sparql(Q_ALIASES)) {
    const name = b.alias.value;
    if (!isLatin(name)) continue;
    const e = ensure(b.rxcui.value);
    if (!e.aliases.includes(name)) e.aliases.push(name);
  }

  return byRxcui;
}
