"""Effect Curve — domain model and API contract types.

This module is THE CONTRACT. It is shared by:
  - the compute engine (engine/*.py)        — reads these types, never imports web/db
  - the API layer (api/routes.py, main.py)  — (de)serializes these types
  - the data repositories (data/*.py)        — produce Substance records
  - the frontend (mirrored in frontend/src/api/contract.js)

Keep it small. Plain drugs use almost none of the optional fields.
Pydantic v2.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- #
# Primitive vocabularies (the ONLY allowed values).                           #
# --------------------------------------------------------------------------- #

Unit = Literal["mg", "mcg", "IU"]

RouteType = Literal[
    "oral_IR",       # immediate release tablet/capsule
    "oral_XR",       # extended release (OROS, beads)
    "oral_DR",       # delayed release (enteric)
    "patch",         # transdermal
    "sublingual",    # under-the-tongue / buccal
    "iv",            # intravenous bolus
    "intranasal",    # nasal spray
    "inhaled",       # pulmonary
]

# How dose enters the central compartment (the "absorption" side).
InputType = Literal[
    "first_order",   # params: {ka} (per min) OR derived from Tmax landmark
    "zero_order",    # params: {rate, window_min}  — patches / OROS flat-top
    "instant",       # IV / sublingual bolus — immediate presence
    "from_parent",   # metabolite, fed by another component (see feeds_id)
]

# How concentration declines (the "elimination" side).
DeclineType = Literal[
    "first_order",   # one OR more phases. params hold k1/w1, k2/w2, ...
    "saturable",     # params: {vmax, km}  — alcohol/phenytoin. BREAKS superposition.
    "turnover",      # params: {kin, kout} — warfarin-style indirect pool.
]

# How concentration maps to felt effect.
Mechanism = Literal[
    "direct",        # ~90% of substances: effect tracks concentration instantly
    "effect_delay",  # peak effect lags blood (ke0 effect-site compartment)
    "irreversible",  # effect outlasts drug (aspirin, PPIs)  — Phase 3
    "turnover",      # indirect, builds/fades on a biological pool — Phase 3
]

Confidence = Literal["high", "med", "low"]


# --------------------------------------------------------------------------- #
# PK layer (concentration shape).                                             #
# --------------------------------------------------------------------------- #

class PKInput(BaseModel):
    """The absorption / appearance side of one component."""
    type: InputType
    params: dict[str, float] = Field(default_factory=dict)
    # Tmax landmark (minutes) for this component; engine derives `ka` if params.ka absent.
    tmax_min: Optional[float] = None
    # Shift this component's clock forward (enteric / delayed release).
    lag_min: float = 0.0


class PKDecline(BaseModel):
    """The elimination side of one component.

    For `first_order` the engine reads either:
      - {half_life_min}                                  -> single exponential, or
      - {w1, half_life1_min, w2, half_life2_min, ...}    -> multi-phase (bi-exp etc.)
    """
    type: DeclineType
    params: dict[str, float] = Field(default_factory=dict)


class PKComponent(BaseModel):
    """One simple sub-curve. Concentration = sum of components (superposition)."""
    # Local id, unique within a Route. Needed as a `feeds_id` target.
    id: Optional[str] = None
    # Share of the dose carried by this component (e.g. OROS beads sum to 1.0).
    fraction: float = 1.0
    input: PKInput
    decline: PKDecline
    # If this is a metabolite fed by another component, the parent component's id.
    feeds_id: Optional[str] = None
    # The PD layer reads this component's concentration (prodrug -> read metabolite).
    is_active_moiety: bool = True


# --------------------------------------------------------------------------- #
# PD layer (concentration -> felt effect, 0..100).                            #
# --------------------------------------------------------------------------- #

class PDModel(BaseModel):
    """Transform from normalized concentration to felt effect.

    `threshold`, `ec50` are expressed as FRACTIONS OF THE REFERENCE PEAK
    (a single ref dose peaks at normalized concentration c = 1.0).
    """
    threshold: float = 0.1          # felt onset/offset boundary (fraction of ref-peak)
    emax: float = 100.0             # ceiling of the 0..100 scale
    ec50: float = 0.5               # half-max effect concentration (fraction of ref-peak)
    hill_n: float = 1.0             # Hill coefficient (steepness of the saturation)
    mechanism: Mechanism = "direct"
    # Only populated when the mechanism needs it:
    #   ke0_min (effect_delay), recovery_rate / kin / kout (turnover/irreversible),
    #   tol_rate / tol_max (tolerance), ...
    extras: dict[str, float] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Provenance (kept separate from derived params).                             #
# --------------------------------------------------------------------------- #

class Landmark(BaseModel):
    """A single scraped value with provenance. The SOURCE OF TRUTH.

    Rate constants are DERIVED from these at load time; never the other way.
    """
    value: float
    unit: str = ""
    source: str = "placeholder"
    source_type: str = "dummy"      # "label" | "literature" | "llm" | "dummy"
    confidence: Confidence = "low"


# --------------------------------------------------------------------------- #
# Route + Substance.                                                          #
# --------------------------------------------------------------------------- #

class DoseRange(BaseModel):
    min: float
    typical: float
    max: float


class Route(BaseModel):
    """Each formulation is its own record."""
    id: str
    route_type: RouteType
    formulation: str
    bioavailability_F: float = 1.0
    dose_ref: float                 # reference dose the curve normalizes to
    dose_range: DoseRange
    pk_components: list[PKComponent]
    pd_model: PDModel
    # True if any component uses a superposition-breaking decline (saturable).
    breaks_superposition: bool = False


class Substance(BaseModel):
    id: str
    name: str
    category: str
    aliases: list[str] = Field(default_factory=list)
    unit: Unit = "mg"
    routes: list[Route]
    # Scraped landmarks keyed by name (tmax_min, half_life_min, onset_min, ...).
    landmarks: dict[str, Landmark] = Field(default_factory=dict)
    # Lowest confidence across the record's soft fields, for UI honesty.
    confidence: Confidence = "low"
    notes: Optional[str] = None

    def get_route(self, route_id: str) -> Optional[Route]:
        for r in self.routes:
            if r.id == route_id:
                return r
        # Fall back to the first route if the id is unknown but routes exist.
        return self.routes[0] if self.routes else None


class SubstanceSummary(BaseModel):
    """Lightweight shape for search/autocomplete."""
    id: str
    name: str
    category: str
    aliases: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# API contract — request/response for the draw call (POST /api/compute).      #
# Times are INTEGER MINUTES from window start (documented choice).            #
# --------------------------------------------------------------------------- #

class DoseEvent(BaseModel):
    substance_id: str
    route_id: str
    dose_mg: float
    time_min: float


class Window(BaseModel):
    start: int = 0
    end_min: int = 1440
    step_min: int = 5


class ComputeRequest(BaseModel):
    window: Window = Field(default_factory=Window)
    now_min: Optional[int] = None
    events: list[DoseEvent] = Field(default_factory=list)


class Landmarks(BaseModel):
    """Per-substance landmarks of the FELT curve (not the plasma curve)."""
    onset_min: Optional[float] = None
    peak_min: Optional[float] = None
    peak_value: Optional[float] = None
    offset_min: Optional[float] = None
    current_value: Optional[float] = None


class SeriesOut(BaseModel):
    substance_id: str
    name: str
    felt_effect: list[float]            # 0..100, aligned to grid_min
    concentration: list[float]          # normalized (ref peak = 1.0), for "show plasma"
    landmarks: Landmarks
    breaks_superposition: bool = False
    confidence: Confidence = "low"


class ComputeResponse(BaseModel):
    grid_min: list[float]
    series: list[SeriesOut]
