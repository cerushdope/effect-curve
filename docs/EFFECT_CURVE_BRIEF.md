# Effect Curve — Project Brief & Build Plan

> Phased build with **hard approval gates**. At the end of each phase: STOP, show
> what was built and how to verify it, wait for explicit approval before the next.

## 0. Objective
A web app where a user logs **what substance they took, how much, and when** (any
number of doses across multiple substances) and sees a clean graph of **felt
effect over time** — onset → rise → peak/plateau → offset → baseline — per
substance on a shared timeline.

A small generic engine drives everything. Each substance = a few stored
parameters; one engine turns them into a curve. New substance = new **data**.

### Core idea — two cleanly separated layers
1. **PK (concentration):** how much is "active" over time. Hard, citable numbers
   (Tmax, half-life).
2. **PD (felt effect):** what the user feels — a *transform* of concentration
   (threshold below which nothing is felt + saturation that flattens the peak
   into a plateau).

Two rules run the engine:
- **Concentration = sum of simple sub-curves (components)** — multiple doses,
  multi-bead pills, prodrug→metabolite cascades are all sums of shifted/shaped
  simple curves (**superposition**).
- **Felt effect = PD transform of that concentration.**

### UX rule
You **cannot sum felt effects across different substances** (different axes). So
multiple doses of **one** substance → summed into its single curve; **different**
substances → separate overlaid curves, each its own color, each on its own 0–100
scale. Never added together.

### Non-goals (v1)
Not medical/dosing advice. No absolute-concentration calibration — we work in
**relative effect normalized to a reference dose**.

## 1. Architecture
Frontend ⇄ FastAPI (+ Repository) ⇄ pure-Python compute engine. Data lives behind
a `Repository` interface: in-code dummy (Phase 1) → MySQL (Phase 2), swappable.

**Two seams built first (Phase 0):** the domain model (`models.py`) and the API
contract (`docs/API_CONTRACT.md`), frozen so tracks build independently.

## 2. Domain model
`Substance → Route[] → PKComponent[] (summed) + PDModel`, plus `RawLandmarks`
(scraped source of truth; rate constants derived at load; every field carries
`{value, unit, source, source_type, confidence}`). See `backend/app/models.py`.

Primitive vocabulary:
- `input.type`: `first_order` · `zero_order` · `instant` · `from_parent`
- `decline.type`: `first_order` (1+ phases) · `saturable` (breaks superposition) · `turnover`
- `pd_model.mechanism`: `direct` · `effect_delay` · `irreversible` · `turnover`

## 3. Compute engine (pure Python, `backend/app/engine/`)
No web, no DB. Input: dose events + a time grid. Output per substance: felt
effect (0–100), normalized concentration, landmarks.

**Normalization:** for the reference dose, `C_raw(t)` = Σ components; `c(t) =
C_raw / max(C_raw)` (ref dose peaks at 1.0). Real dose `D` scales by `D/dose_ref`
(linear substances). PD thresholds/EC50 are fractions of the ref-peak.

**Closed-form primitives (Phase 1):** Bateman (first-order in + single-exp out;
derive `ka` from Tmax via root-find), bi-exponential decline (redistribution),
zero-order over a window (flat-top), instant input, lag (shift τ), prodrug
cascade (`from_parent`: Bateman with parent-elim as `ka`, metabolite-elim as `ke`).

**PD transform:** `direct` → `felt = 100·c'^n/(ec50^n+c'^n)`, `c' = max(0, c−threshold)`;
`effect_delay` → first-order `ke0` filter before Emax (Phase 1 stretch);
`irreversible`/`turnover` → small ODE (Phase 3, keep the field now).

**Nonlinear path** (saturable/turnover) integrated numerically, all doses
together (no superposition), `breaks_superposition=true`. Stub in Phase 1.

**Validation tests:** clean Bateman + Tmax lands right; redistribution shows
short felt duration despite long half-life; zero-order shows a flat plateau then
decay; prodrug shows a smooth/delayed/lower peak; two doses superpose.

## 4. API contract
Frozen in `docs/API_CONTRACT.md`. `GET /api/substances?q=`, `GET /api/substances/{id}`,
`POST /api/compute`. Times in integer minutes from window start. Colors assigned
client-side.

## 5. Frontend — UX/UI
Plain HTML/CSS/vanilla JS (no React, per the owner). Search → colored substance
cards → arbitrary dose rows across substances → one timeline chart with one
overlaid curve per substance (own color, own 0–100 scale; same-substance doses
summed) → draggable scrub line with floating multi-substance readout → now-line →
felt↔plasma toggle → readout strip with confidence/uncertainty.

**Aesthetic:** "precise instrument meets lab notebook." Paper `#F7F7F4`, ink
`#1A1D21`, muted `#6A7078`, hairline `#E4E5E1`, accent slate-teal `#2E4D54`; ~8
distinct-but-harmonious substance hues. Grotesque UI font + **monospace for every
number/axis/readout**. Signature element: the layered effect chart (threshold
bands, dose-marker rail, scrub readout, draw-on animation).

**Quality floor:** responsive, visible focus, `prefers-reduced-motion`, no layout
shift, helpful empty/error states, debounced recompute.

## 6. Dummy data (Phase 1)
12 archetypes in `backend/app/data/dummy.py`, each rendering a visibly different
shape and exercising a different engine path. #1–9 & #11 fully analytic; #10
(effect_delay) and #12 (saturable) carry a first-order fallback in Phase 1.

## 7. Phases (gates)
- **Phase 0** — foundation (model + contract + scaffold). No gate.
- **Phase 1 ⛔** — end-to-end MVP on dummy data (engine + API + full UI).
- **Phase 2 ⛔** — MySQL behind the same Repository; finish nonlinear paths.
- **Phase 3 ⛔ (backlog)** — auth, saved graphs, per-user tweaks, feedback/requests,
  metadata panels, analytics.
- **Phase 4 ⛔** — mobile apps, Chrome extension.

## 8. Workstream L — data library (parallel, always)
Pipeline: fetch (openFDA/RxNorm/PubChem) → extract (rules + LLM w/ strict JSON
schema) → validate → human review → `records/*.json` (provenance + confidence) →
load to MySQL (Phase 2+). LLM extraction = draft generator, low/med confidence,
always human-reviewed.

## 9. Parallelization
After Phase 0: Track A (engine), Track B (API + dummy repo), Track C (frontend
against the contract/mock), Workstream L (independent). Sync at end of Phase 1.

## 10. Conventions
Engine stays pure; I/O at the edges. The `Repository` interface is sacred. Config
from env (`pydantic-settings`); MySQL creds from the human at Phase 2, never
committed. Type everything. Tests with each engine change. Honest UX — curves are
estimates with uncertainty.
