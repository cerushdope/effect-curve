# Reframe — model roadmap

Working notes after a PK/PD review of the curve model. Nothing here is
implemented. Ordered by ROI, not by elegance.

---

## The framing that matters most

The parameter budget is allocated backwards. We carry ~6 PK parameters and ~3
class-level PD parameters, for a tool whose entire output is *how it feels*.
PK is the well-measured, low-variance, easily-looked-up half. **PD is where all
the information about felt experience lives**, and it is currently carrying
class-assigned constants that were never fitted to anything.

A reasonable target is roughly **5 PK / 5 PD / 2 person-state**.

Two caveats to hold onto while reading the rest:

**1. Sophistication reads as credibility.** A model with adaptive baselines,
tolerance state, metabolite tuples and turnover constants *looks* authoritative.
If it is still unvalidated underneath, that is worse than the current crudeness,
not better — nobody currently mistakes this for a clinical tool, and that is
doing honest work. Don't lose it by accident.

**2. Nothing in this system has ever been checked against reality.** Not one
number. Every priority call below — including the ordering — is a guess about
where the error is. That is what Phase 0 is for.

---

## Phase 0 — measure before building

**Blocks everything else. Roughly an afternoon.**

Take 20 drugs we actually care about. Write down expected onset / peak /
duration from a reference. Diff against what the app draws today.

This converts a ranked list of opinions into a measured error budget, and it
will very likely show that two items below account for most of the damage and
the rest are rounding error. It also gives us a regression suite, which we do
not have — every fix so far has been verified against reasoning, which is not
the same as being right.

Do not start Phase 1 without it. Adding parameters to an unvalidated model
reduces accuracy *per parameter*.

---

## Evidence already gathered

Verified against the code and the live data, so it doesn't need re-deriving.

**Peak height currently carries no information.** Each drug at its own typical
dose:

```
stimulant   caffeine 79.0    methylphenidate 78.2   dextroamphetamine 79.6
analgesic   acetaminophen 72.9   morphine 73.2      oxycodone 68.3
sedative    melatonin 69.1   temazepam 69.5         midazolam 60.3
```

Paracetamol and morphine are the same height. Melatonin outranks midazolam.
Only *timing* varies between drugs.

Important nuance: for a **single** substance, "100% = a typical dose of this
drug at its peak" is a defensible per-drug scale, and identical peaks are then
correct by construction. It only becomes incoherent when two substances are
**overlaid on a shared axis** — which is the core feature. That is what makes
this a must-fix rather than a nitpick.

**Indirect-response drugs are wrong by orders of magnitude:**

| drug | our offset | reality |
|---|---|---|
| aspirin | 6.8 h | 7–10 days (antiplatelet) |
| omeprazole | 14.1 h | > 24 h |
| levothyroxine | **never** | n/a — also breaks the window auto-fit |

**`bioavailability_F` is never read.** Not "cancels in the ratio" — `engine.js`
does not reference it at all. It exists only in the JSDoc typedef and mock data.

**`saturable` decline is a stub.** `declineRates()` returns
`keFromHalfLife(fallback_half_life_min)`, i.e. plain first-order.

**The bi-exponential decline path is unreachable.** The engine implements it
properly (`w1/half_life1_min/w2/half_life2_min`), and the ingest emits it zero
times. Same for `saturable`.

**Route and formulation are not physical quantities.** They are lookup keys for
absorption shape and rate, and collapse into a single absorption model.

---

## Phase 1 — one curve per substance

Everything here preserves the single-scalar output. Ordered by impact ÷ cost.

### 1. A "not really felt" escape hatch

`felt: none | weak | strong` per class. Render a caveat instead of a curve.

Levothyroxine, statins, most antibiotics. We currently draw a confident curve
for amoxicillin and an eternal plateau for levothyroxine. **Refusing to draw is
more honest than drawing something wrong**, costs almost nothing, and needs no
new data source. Also kills the auto-fit bug that a never-offsetting curve causes.

### 2. Decide what the y-axis means

Free — it is a decision, not code. But it gates #3 and everything downstream.

Either (a) per-drug relative, and then stop overlaying substances on a shared
axis, or (b) cross-drug absolute, and then peak height has to become a fitted
quantity. The product currently claims (b) and implements (a).

### 3. Fit EC50 and Hill per drug from published duration of action

The highest-value change in the document, and the one with a real blocker:
**there is no structured data source for duration of action.** Not in RxNorm,
not in openFDA labels, not in Wikidata. Solve that before anything else here.

IR methylphenidate 3–4 h, Vyvanse 10–13 h, zolpidem 6–8 h. Same look-up-a-number
workflow the ingest already runs. Converts our weakest parameter into a
data-anchored one and absorbs upstream model error into the bargain.

Note this also kills the assumption that a typical dose lands at the same point
on the sigmoid for every drug in a class — see the evidence above.

The Hill coefficient is *not* a receptor property here. It is the composition of
hyperbolic occupancy with power-law perceptual scaling (Stevens), so it should
be fitted rather than looked up — an independent argument for this over class
assignment.

### 4. Indirect-response flag + turnover time constant

For drugs that modulate a rate rather than cause an effect, duration is governed
by biological turnover, not drug half-life. One flag plus a time constant.

Largest single *magnitude* error in the model (see evidence). Ranked below #3
only because it affects fewer of the drugs people are likely to ask about —
which is exactly the sort of assumption Phase 0 should settle rather than assume.

### 5. Adaptive baseline

Replace the static sigmoid with `E = σ(Ce − γ·A)` where `dA/dt = kA·(Ce − A)`.
Two new parameters per class.

Subsumes three separate problems at once:

- **rate-dependence** — a fast rise outruns A and gives a big signal; a slow rise
  lets A track it and gives a small one
- **acute tolerance / Mellanby** — A accumulates during a plateau, so the
  descending limb feels weaker at matched Ce
- **rebound** — Ce falls faster than A, the term goes negative, you get the crash

`γ=0` recovers the current model exactly; `γ=1` is a pure change-detector.
Caffeine and nicotine sit high, antihistamines low.

This is the answer to the deepest question in the review: **is felt intensity a
function of level, or of change?** We assume level. The evidence says it is
substantially change. If that is right, it means the current model measures the
wrong quantity, and no amount of EC50 fitting rescues it — which is an argument
for settling this question early even though the fix is ranked fifth.

### 6. Tolerance as a user input

Naive / occasional / daily. An EC50 multiplier, and plausibly the largest single
error source for real users — 5–10× for opioids and benzodiazepines.

Shares machinery with #5: it is just the initial condition on `A`. A habitual
caffeine user starts with `A > 0`, which is why their first coffee restores
baseline rather than lifting above it.

Note this is an input, not stored state — it does not compromise the no-login,
no-saved-data stance.

### 7. Real saturable elimination

Michaelis–Menten, roughly linear %BAC decay. The stub already exists and the
dummy archetype's own note admits the approximation. Alcohol is a top-three
query and is currently structurally wrong. Same code path covers phenytoin and
high-dose salicylates.

### 8. Redistribution — second compartment for IV and inhaled

Thiopental's terminal half-life is ~11 h and its duration is ~10 minutes,
because the offset is redistribution rather than elimination. Propofol, IV
fentanyl, midazolam and inhaled cannabis share the shape.

**The engine already implements this correctly.** This is pure ingest plumbing —
emit a bi-exponential decline for these routes instead of a single first-order.

### 9. Flip-flop audit for extended-release orals

References report *terminal* half-life, which under flip-flop kinetics is the
**absorption** half-life. Feed that in as `ke` while also slowing absorption via
the XR Tmax default and slow absorption gets counted twice. Patches are safe
(zero-order); ER orals are not.

Magnitude unknown until Phase 0 measures it. Related to the `deriveKa` bug
already fixed — same territory.

### 10. Generalise the prodrug flag to a metabolite tuple

Fraction converted + child half-life + relative potency. Covers
active-parent-to-also-active-child, which is more common than the inactive-parent
case: diazepam→nordazepam, codeine→morphine, tramadol→ODT,
quetiapine→norquetiapine. The cascade machinery exists; only the classification
is too binary.

### 11. Fed / fasted as a Tmax multiplier

Food shifts Tmax by 1–2 h via gastric emptying. Because Tmax pins the entire
curve shape, this is a **shape** change, not the scalar-on-bioavailability the
current caveat list implies. Higher value per line than anything genotype-related.

### 12. Dual-ka for sublingual and intranasal

Mucosal fraction fast, swallowed fraction slow. Produces the shoulder in
buprenorphine and intranasal midazolam.

### Free hygiene

- **Delete or wire `bioavailability_F`.** Currently dead weight in every record.
  Only load-bearing if we ever want cross-route comparison at matched mg.

### Explicitly not doing

- **Enterohepatic recirculation.** Secondary bumps, a handful of drugs, cosmetic.

---

## Phase 2 — more than one feeling per substance

The other fundamental question: **is "how strong" one number?**

No, it isn't. A benzodiazepine at hour 1 vs hour 5 is not strong-then-weak, it
is anxiolytic → sedating → foggy. Alcohol is stimulant on the ascending limb and
sedative on the descending **at identical BAC**. A single scalar discards the
most salient dimension of the experience and forces genuinely biphasic drugs
into a shape they do not have.

**But a single scalar is still right for v1.** Three channels per drug means
nine lines when someone adds three substances, and glanceability is the whole
appeal. So Phase 2 is gated on the UI question, not the model question — the
model side is nearly free (it is the same sigmoid called two or three times with
different EC50, ke0 and adaptation rate).

### 2.1 Label the single channel per class

Cheapest honest step, and it belongs in Phase 1 if it survives Phase 0. Say
*what* the one number means: "sedation" for a benzodiazepine, "stimulation" for
caffeine, "pain relief" for an analgesic. Costs nothing and removes most of the
ambiguity without adding a line to the chart.

### 2.2 Refuse the drugs a single scalar cannot represent

Alcohol is the clean case: biphasic, so don't fake it with one curve. Pairs with
Phase 1 #1 — the same escape hatch, different reason.

### 2.3 Multiple effect channels

Two or three sigmoids with their own EC50, ke0 and adaptation rate.
Stimulant/sedative for alcohol, euphoria/focus/jitter for stimulants,
analgesia/sedation for opioids.

Model cost: trivial. **Product cost: real** — chart, readout, legend and state
all assume one series per substance. This is the difference between a magnitude
plot and something that shows the actual arc of an experience, and it is the
only way biphasic drugs come out right.

### 2.4 Per-channel adaptation

Falls out of 2.3 + Phase 1 #5. Alcohol's stimulant channel adapts fast, its
sedative channel slowly — which is the mechanism behind the biphasic profile
rather than a special case bolted on.

---

## Architectural verdict

**Keep PK mechanistic.** It is cheap and it buys dose-scaling, route
generalisation and multi-dose stacking for free.

**Make PD fitted to observables** — duration of action, published onset,
reported peak — rather than assigned by class.

Mechanism where it is well-measured, data where it isn't.
