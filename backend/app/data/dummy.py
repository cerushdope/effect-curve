"""Phase 1 dummy data — 12 archetype substances.

Numbers are PLAUSIBLE PLACEHOLDERS, not clinical truth. The point is that each
record renders a VISIBLY DIFFERENT shape so the engine and UI are fully exercised.

The "Exercises" note on each says which engine path it hits. #1-9 and #11 are
fully analytic in Phase 1. #10 (effect_delay) and #12 (saturable) carry a safe
first-order fallback so they still render in Phase 1; their true paths land in
Phase 2 (see docs/EFFECT_CURVE_BRIEF.md §3).
"""
from __future__ import annotations

from typing import Optional

from app.data.repository import Repository
from app.models import (
    DoseRange,
    Landmark,
    PDModel,
    PKComponent,
    PKDecline,
    PKInput,
    Route,
    Substance,
    SubstanceSummary,
)

# --------------------------------------------------------------------------- #
# Tiny constructors to keep the records readable.                             #
# --------------------------------------------------------------------------- #

H = 60.0  # minutes per hour


def lm(value: float, unit: str = "min", conf: str = "low") -> Landmark:
    return Landmark(value=value, unit=unit, source="placeholder", source_type="dummy", confidence=conf)


def fo_input(tmax_min: float, lag_min: float = 0.0) -> PKInput:
    """First-order absorption; engine derives ka from Tmax."""
    return PKInput(type="first_order", tmax_min=tmax_min, lag_min=lag_min)


def zo_input(window_min: float, lag_min: float = 0.0) -> PKInput:
    """Zero-order delivery over a window (patch / OROS flat-top)."""
    return PKInput(type="zero_order", params={"window_min": window_min}, lag_min=lag_min)


def instant_input(lag_min: float = 0.0) -> PKInput:
    return PKInput(type="instant", lag_min=lag_min)


def decl(half_life_min: float) -> PKDecline:
    """Single-exponential decline."""
    return PKDecline(type="first_order", params={"half_life_min": half_life_min})


def decl_biexp(w1: float, hl1: float, w2: float, hl2: float) -> PKDecline:
    """Two-phase (redistribution) decline."""
    return PKDecline(
        type="first_order",
        params={"w1": w1, "half_life1_min": hl1, "w2": w2, "half_life2_min": hl2},
    )


def comp(
    input_: PKInput,
    decline: PKDecline,
    *,
    id: Optional[str] = None,
    fraction: float = 1.0,
    feeds_id: Optional[str] = None,
    is_active_moiety: bool = True,
) -> PKComponent:
    return PKComponent(
        id=id,
        fraction=fraction,
        input=input_,
        decline=decline,
        feeds_id=feeds_id,
        is_active_moiety=is_active_moiety,
    )


# --------------------------------------------------------------------------- #
# The 12 archetypes.                                                          #
# --------------------------------------------------------------------------- #

_SUBSTANCES: list[Substance] = [
    # 1 — Bateman + Emax. The canonical clean rise/peak/decline.
    Substance(
        id="simple_direct",
        name="Stimulant (IR)",
        category="stimulant",
        aliases=["simple", "stim", "stimulant"],
        unit="mg",
        confidence="low",
        notes="Canonical immediate-release: clean onset, single peak, gentle offset.",
        landmarks={"tmax_min": lm(45), "half_life_min": lm(5 * H), "onset_min": lm(20), "duration_min": lm(360)},
        routes=[
            Route(
                id="oral_IR",
                route_type="oral_IR",
                formulation="immediate-release tablet",
                bioavailability_F=0.9,
                dose_ref=10,
                dose_range=DoseRange(min=5, typical=10, max=30),
                pk_components=[comp(fo_input(45), decl(5 * H))],
                pd_model=PDModel(threshold=0.08, ec50=0.4, hill_n=1.5, mechanism="direct"),
            )
        ],
    ),
    # 2 — Fast on/off. Short half-life, brisk rise and fall.
    Substance(
        id="analgesic_ir",
        name="Analgesic (IR)",
        category="analgesic",
        aliases=["pain", "analgesic", "nsaid"],
        unit="mg",
        confidence="low",
        notes="Fast onset, ~2 h half-life: noticeable peak, then steady fade.",
        landmarks={"tmax_min": lm(60), "half_life_min": lm(2 * H), "onset_min": lm(25), "duration_min": lm(300)},
        routes=[
            Route(
                id="oral_IR",
                route_type="oral_IR",
                formulation="immediate-release tablet",
                bioavailability_F=0.9,
                dose_ref=400,
                dose_range=DoseRange(min=200, typical=400, max=800),
                pk_components=[comp(fo_input(60), decl(2 * H))],
                pd_model=PDModel(threshold=0.12, ec50=0.45, hill_n=1.2, mechanism="direct"),
            )
        ],
    ),
    # 3 — Bi-exponential redistribution: SHORT felt duration despite LONG half-life.
    Substance(
        id="long_half_short_felt",
        name="Sedative (redistribution)",
        category="sedative",
        aliases=["sedative", "redistribution", "benzo-like"],
        unit="mg",
        confidence="low",
        notes="Long terminal half-life, but felt effect ends when the fast phase drops "
        "below threshold — the long tail stays sub-threshold.",
        landmarks={"tmax_min": lm(40), "half_life_min": lm(40 * H, conf="med"), "onset_min": lm(20), "duration_min": lm(240)},
        routes=[
            Route(
                id="oral_IR",
                route_type="oral_IR",
                formulation="immediate-release tablet",
                bioavailability_F=0.95,
                dose_ref=10,
                dose_range=DoseRange(min=2, typical=5, max=10),
                pk_components=[comp(fo_input(40), decl_biexp(0.8, 40, 0.2, 40 * H))],
                pd_model=PDModel(threshold=0.25, ec50=0.5, hill_n=1.5, mechanism="direct"),
            )
        ],
    ),
    # 4 — Multi-component: 25% IR burst + 75% zero-order over 8 h → flat working day.
    Substance(
        id="oros_biphasic",
        name="Focus (OROS)",
        category="stimulant",
        aliases=["focus", "oros", "osmotic", "xr-focus"],
        unit="mg",
        confidence="low",
        notes="An initial bead releases immediately; the rest is pumped out at a steady "
        "rate over ~8 h, giving a long plateau.",
        landmarks={"tmax_min": lm(60), "half_life_min": lm(3 * H), "onset_min": lm(30), "duration_min": lm(600)},
        routes=[
            Route(
                id="oral_XR",
                route_type="oral_XR",
                formulation="osmotic-release (OROS)",
                bioavailability_F=0.9,
                dose_ref=36,
                dose_range=DoseRange(min=18, typical=36, max=72),
                pk_components=[
                    comp(fo_input(60), decl(3 * H), id="ir_bead", fraction=0.25),
                    comp(zo_input(window_min=8 * H), decl(3 * H), id="oros_pump", fraction=0.75),
                ],
                pd_model=PDModel(threshold=0.10, ec50=0.45, hill_n=1.4, mechanism="direct"),
            )
        ],
    ),
    # 5 — Lag: nothing for 45 min (enteric coat), then a normal IR curve.
    Substance(
        id="delayed_enteric",
        name="Enteric (delayed)",
        category="analgesic",
        aliases=["enteric", "delayed", "dr"],
        unit="mg",
        confidence="low",
        notes="Enteric coating delays absorption ~45 min; then behaves like a standard IR.",
        landmarks={"tmax_min": lm(60), "half_life_min": lm(3 * H), "onset_min": lm(70), "duration_min": lm(360), "lag_min": lm(45)},
        routes=[
            Route(
                id="oral_DR",
                route_type="oral_DR",
                formulation="enteric-coated tablet",
                bioavailability_F=0.9,
                dose_ref=50,
                dose_range=DoseRange(min=25, typical=50, max=100),
                pk_components=[comp(fo_input(60, lag_min=45), decl(3 * H))],
                pd_model=PDModel(threshold=0.10, ec50=0.45, hill_n=1.3, mechanism="direct"),
            )
        ],
    ),
    # 6 — Slow ka, flatter rounded peak (extended-release antihypertensive).
    Substance(
        id="extended_simple",
        name="BP (XR)",
        category="cardiovascular",
        aliases=["bp", "antihypertensive", "xr"],
        unit="mg",
        confidence="low",
        notes="Slow absorption and slow elimination → a broad, rounded, all-day curve.",
        landmarks={"tmax_min": lm(4 * H), "half_life_min": lm(7 * H), "onset_min": lm(90), "duration_min": lm(900)},
        routes=[
            Route(
                id="oral_XR",
                route_type="oral_XR",
                formulation="extended-release tablet",
                bioavailability_F=0.85,
                dose_ref=50,
                dose_range=DoseRange(min=25, typical=50, max=100),
                pk_components=[comp(fo_input(4 * H), decl(7 * H))],
                pd_model=PDModel(threshold=0.12, ec50=0.5, hill_n=1.2, mechanism="direct"),
            )
        ],
    ),
    # 7 — Prodrug cascade: parent absorbs fast then converts; metabolite is the active moiety.
    Substance(
        id="prodrug_metabolite",
        name="Pro-stim (prodrug)",
        category="stimulant",
        aliases=["prodrug", "pro-stim", "cascade"],
        unit="mg",
        confidence="low",
        notes="Inactive parent is absorbed quickly, then steadily converted to a long-lived "
        "active metabolite → a smooth, delayed, lower, longer peak vs an IR equivalent.",
        landmarks={"tmax_min": lm(3 * H), "half_life_min": lm(10 * H), "onset_min": lm(60), "duration_min": lm(720)},
        routes=[
            Route(
                id="oral_IR",
                route_type="oral_IR",
                formulation="prodrug capsule",
                bioavailability_F=0.95,
                dose_ref=50,
                dose_range=DoseRange(min=30, typical=50, max=70),
                pk_components=[
                    # Parent: fast absorption, fast conversion (its elimination feeds the metabolite).
                    comp(fo_input(20), decl(30), id="parent", is_active_moiety=False),
                    # Metabolite: appears at the parent's elimination rate, then decays slowly.
                    comp(
                        PKInput(type="from_parent"),
                        decl(10 * H),
                        id="metab",
                        feeds_id="parent",
                        is_active_moiety=True,
                    ),
                ],
                pd_model=PDModel(threshold=0.10, ec50=0.45, hill_n=1.4, mechanism="direct"),
            )
        ],
    ),
    # 8 — Zero-order over a very long window (transdermal patch) + depot tail.
    Substance(
        id="patch_zero_order",
        name="Patch (transdermal)",
        category="analgesic",
        aliases=["patch", "transdermal", "td"],
        unit="mcg",
        confidence="low",
        notes="Steady delivery for ~72 h gives a long flat plateau; on removal a skin depot "
        "produces a slow tail.",
        landmarks={"half_life_min": lm(10 * H), "onset_min": lm(8 * H), "duration_min": lm(80 * H), "window_min": lm(72 * H)},
        routes=[
            Route(
                id="patch",
                route_type="patch",
                formulation="transdermal patch (72 h)",
                bioavailability_F=0.5,
                dose_ref=25,
                dose_range=DoseRange(min=12, typical=25, max=100),
                pk_components=[comp(zo_input(window_min=72 * H), decl(10 * H))],
                pd_model=PDModel(threshold=0.10, ec50=0.5, hill_n=1.3, mechanism="direct"),
            )
        ],
    ),
    # 9 — Instant input, very short felt window (sublingual rescue).
    Substance(
        id="sublingual_fast",
        name="Sublingual (rescue)",
        category="cardiovascular",
        aliases=["sublingual", "rescue", "sl", "spray"],
        unit="mg",
        confidence="low",
        notes="Near-instant onset and a very short window — peaks fast, gone within the hour.",
        landmarks={"tmax_min": lm(5), "half_life_min": lm(20), "onset_min": lm(3), "duration_min": lm(45)},
        routes=[
            Route(
                id="sublingual",
                route_type="sublingual",
                formulation="sublingual tablet / spray",
                bioavailability_F=0.4,
                dose_ref=0.4,
                dose_range=DoseRange(min=0.3, typical=0.4, max=1.2),
                pk_components=[comp(instant_input(), decl(20))],
                pd_model=PDModel(threshold=0.05, ec50=0.35, hill_n=1.4, mechanism="direct"),
            )
        ],
    ),
    # 10 — Effect delay (hysteresis): peak EFFECT lags peak plasma. Phase 1 stretch.
    Substance(
        id="hysteresis_delay",
        name="Cardiac (delayed effect)",
        category="cardiovascular",
        aliases=["cardiac", "hysteresis", "digoxin-like", "delayed-effect"],
        unit="mcg",
        confidence="low",
        notes="Effect builds in a slow effect-site compartment, so the felt peak lags the "
        "plasma peak by hours. (Phase 1: approximated; true ke0 path in Phase 2.)",
        landmarks={"tmax_min": lm(90), "half_life_min": lm(36 * H), "onset_min": lm(120), "duration_min": lm(1200), "ke0_min": lm(300)},
        routes=[
            Route(
                id="oral_IR",
                route_type="oral_IR",
                formulation="immediate-release tablet",
                bioavailability_F=0.7,
                dose_ref=250,
                dose_range=DoseRange(min=125, typical=250, max=500),
                pk_components=[comp(fo_input(90), decl(36 * H))],
                pd_model=PDModel(
                    threshold=0.10,
                    ec50=0.45,
                    hill_n=1.3,
                    mechanism="effect_delay",
                    extras={"ke0_min": 300.0},
                ),
            )
        ],
    ),
    # 11 — Very short felt window supplement.
    Substance(
        id="short_supplement",
        name="Sleep aid (short)",
        category="supplement",
        aliases=["sleep", "melatonin-like", "supplement"],
        unit="mg",
        confidence="low",
        notes="Quick rise, short half-life — a brief window then a clean return to baseline.",
        landmarks={"tmax_min": lm(50), "half_life_min": lm(45), "onset_min": lm(25), "duration_min": lm(150)},
        routes=[
            Route(
                id="oral_IR",
                route_type="oral_IR",
                formulation="immediate-release tablet",
                bioavailability_F=0.6,
                dose_ref=3,
                dose_range=DoseRange(min=1, typical=3, max=10),
                pk_components=[comp(fo_input(50), decl(45))],
                pd_model=PDModel(threshold=0.15, ec50=0.45, hill_n=1.3, mechanism="direct"),
            )
        ],
    ),
    # 12 — Saturable elimination (zero-order-ish at high dose). BREAKS superposition.
    #      Phase 1 carries a first-order fallback (fallback_half_life_min) so it renders.
    Substance(
        id="saturable_zero",
        name="Spirit (saturable)",
        category="recreational",
        aliases=["spirit", "alcohol-like", "saturable", "zero-order-elim"],
        unit="mg",
        confidence="low",
        notes="Elimination saturates (Michaelis-Menten): higher doses decline almost "
        "linearly, not exponentially. Doses cannot be summed independently — flagged. "
        "(Phase 1: first-order approximation; true saturable ODE in Phase 2.)",
        landmarks={"tmax_min": lm(45), "half_life_min": lm(90, conf="low"), "onset_min": lm(20), "duration_min": lm(240)},
        routes=[
            Route(
                id="oral_IR",
                route_type="oral_IR",
                formulation="ingested liquid",
                bioavailability_F=0.9,
                dose_ref=14000,  # ~ one standard unit, in mg of active
                dose_range=DoseRange(min=7000, typical=14000, max=42000),
                breaks_superposition=True,
                pk_components=[
                    comp(
                        fo_input(45),
                        PKDecline(
                            type="saturable",
                            params={"vmax": 100.0, "km": 0.2, "fallback_half_life_min": 90.0},
                        ),
                    )
                ],
                pd_model=PDModel(threshold=0.10, ec50=0.4, hill_n=1.4, mechanism="direct"),
            )
        ],
    ),
]

_REGISTRY: dict[str, Substance] = {s.id: s for s in _SUBSTANCES}


# --------------------------------------------------------------------------- #
# Repository implementation + convenience accessor.                           #
# --------------------------------------------------------------------------- #

class DummyRepository(Repository):
    """In-code repository over the archetypes. Interchangeable with the future SQL one."""

    def search(self, q: str) -> list[SubstanceSummary]:
        q = (q or "").strip().lower()
        out: list[SubstanceSummary] = []
        for s in _SUBSTANCES:
            haystack = " ".join([s.id, s.name, s.category, *s.aliases]).lower()
            if not q or q in haystack:
                out.append(SubstanceSummary(id=s.id, name=s.name, category=s.category, aliases=s.aliases))
        return out

    def get_substance(self, substance_id: str) -> Optional[Substance]:
        return _REGISTRY.get(substance_id)


def get_med_data(name_or_id: str) -> Optional[Substance]:
    """Convenience: fetch by id, else first search hit."""
    if name_or_id in _REGISTRY:
        return _REGISTRY[name_or_id]
    repo = DummyRepository()
    hits = repo.search(name_or_id)
    return _REGISTRY.get(hits[0].id) if hits else None


def search(q: str = "") -> list[SubstanceSummary]:
    return DummyRepository().search(q)
