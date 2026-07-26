# Substance ingestion

Fills the Supabase `substances` table with real drugs so searching **any** name —
brand, generic, or international — resolves to a curve. Fully automated, no hand
curation, everything stamped `confidence: "low"`.

Runs on **GitHub Actions**, not your laptop. Re-runnable: every row is an upsert
keyed on `id`.

## Sources

| Source | Gives us | License |
|---|---|---|
| **RxNorm** via RxNav | canonical ingredient spine (14.6k concepts) + RxCUI join key | Normalized names/RXCUIs are US-government **public domain** |
| **Wikidata** SPARQL | **international brand names**, ATC drug class, UNII | **CC0** |
| **openFDA NDC** (bulk) | US brands, dosage forms, routes, strengths | Public domain |
| **openFDA labels** (bulk) | Tmax + half-life prose, prodrug relationships | Public domain |

DrugBank is deliberately **not** used — it is licensed.

### Why Wikidata is what makes "Elvanse" work

RxNorm is a US vocabulary. `rxcui.json?name=Elvanse` returns nothing — the EU
brand simply isn't in it.

Wikidata has it, but **not as an alias on the ingredient**. A spot-check of
lisdexamfetamine's `skos:altLabel` finds only `LDX`, `NRP104`, and translations.
The brands are *separate medicinal-product items*, reached through property
**P3780 "active ingredient in"**:

```
lisdexamfetamine (Q6558704) --P3780--> Elvanse  (Q115629826)
                            --P3780--> Vyvanse
                            --P3780--> Venvanse
                            --P3780--> Aduvanz
```

One SPARQL query over that edge returns ~4,200 brand names in about a second.

British/INN spelling variants (`lisdexamfetamine` ↔ `lisdexam**ph**etamine`) are
generated mechanically in `lib/aliases.js`.

## How Tmax and half-life are found

FDA labels have no structured PK fields — the numbers live in prose. A corpus
analysis over a 350-label sample produced this split:

| | share | handling |
|---|---:|---|
| Both values read by regex | 54.6% | `lib/pk.js` |
| Label states **no number** | 41.5% | class defaults — **never** an LLM |
| Numbers present but unparseable | **3.8%** | batched Claude call |

Regex recall is **98.7% on Tmax** and **92.2% on half-life** of labels that state
them, in ~20 lines of pattern. The residual is almost entirely tables flattened
into prose with the unit stranded in a header (`Time to Peak (hours) 1.`).

The three-way split matters: a label that says *"the half-life did not change"*
holds no value to find, so asking a model would only invite invention. Only the
"demonstrably present but unreadable" bucket escalates — batched ~15 substances
per call, so the whole residual is single-digit model calls per run.

## Running it

See the repo README for the click-by-click. In short: **Actions → Ingest
substances → Run workflow**.

Locally (needs the service-role key exported for one command):

```bash
cd ingest && npm install
node run.js --dry-run --max-partitions 0     # fast, no large downloads, no writes
node run.js --dry-run                        # full build, still no writes
node run.js                                  # build + upsert
```

| Flag | Effect |
|---|---|
| `--dry-run` | build + validate, write `build/substances.json`, no Supabase writes |
| `--limit N` | cap ingredients processed |
| `--only a,b` | restrict to named ingredients |
| `--max-partitions N` | read only the first N label partitions (`0` = skip labels) |
| `--no-llm` | skip the residual model pass |
| `--llm-max-calls N` | cap model calls (default 20) |
| `--prune` | delete rows this run didn't produce — **this is what removes the 12 dummy archetypes** |

Env: `SUPABASE_SERVICE_ROLE_KEY` (required unless `--dry-run`), `SUPABASE_URL`,
`ANTHROPIC_API_KEY` (optional — without it the 3.8% residual falls back to
class defaults rather than failing).

## Self-check

Every run asserts the names this project requires actually resolve, and prints
the result:

```
self-check — required names:
  OK   Vyvanse                lisdexamfetamine
  OK   Elvanse                lisdexamfetamine
  OK   Mydayis                amphetamine_aspartate
  OK   lisdexamfetamine       lisdexamfetamine
  OK   lisdexamphetamine      lisdexamfetamine
```

## Rate limits and compliance

Nothing here evades a limit.

- **openFDA bulk downloads** (`download.open.fda.gov`) are the route openFDA
  publishes *for* bulk consumers; the API's 1,000/day anonymous cap does not
  apply to them. Partitions are streamed and deleted one at a time, so peak disk
  is ~130 MB, not 1.76 GB.
- **RxNav** allows 20 req/s. We make **one** request per run and cache it.
- **Wikidata WDQS** requires a descriptive User-Agent; we send one and issue
  three queries.

NLM's terms of service **require** this attribution wherever the data is used —
it is emitted into every record's provenance and shown in the app footer:

> This product uses publicly available data from the U.S. National Library of
> Medicine (NLM), National Institutes of Health, Department of Health and Human
> Services; NLM is not responsible for the product and does not endorse or
> recommend this or any other product.

RxNorm's *full* release bundles proprietary source vocabularies (Micromedex,
Medi-Span, First Databank, Gold Standard) which are **not** freely
redistributable. This job touches only RxNorm-normalized ingredient concepts,
which are public domain.

## Layout

```
run.js              orchestrator + CLI + self-check
lib/rxnorm.js       ingredient spine (1 request)
lib/wikidata.js     P3780 brand join, ATC — the Elvanse fix
lib/openfda.js      NDC + label bulk, streamed and discarded
lib/pk.js           Tmax/half-life regex + the escalate/default triage
lib/llm.js          batched residual extraction (Claude, structured output)
lib/taxonomy.js     ATC -> category, dose form -> route, all PK/PD defaults
lib/aliases.js      normalisation, salt stripping, spelling variants
lib/record.js       assembles the engine-shaped record
lib/supabase.js     PostgREST upsert
lib/{http,unzip,jsonstream}.js   streaming plumbing, no deps
sql/schema.sql      run ONCE before the first ingest
```

All the numbers this produces are population-typical placeholders. Nothing here
is a dosing or clinical tool.
