"""Engine entry point — events -> per-substance felt-effect series + landmarks.

THIS SIGNATURE IS FROZEN (Phase 0). Track A fills in the body; Track B calls it.

  compute_series(req, repo) -> ComputeResponse

Rules implemented here (see docs/EFFECT_CURVE_BRIEF.md §3):
  - Same-substance doses are SUMMED into one curve (superposition).
  - Different substances are kept SEPARATE (never added — different axes).
  - Felt effect is the PD transform of normalized concentration.

NORMALIZATION (the whole trick — everything is dimensionless):
  For a substance+route, the per-dose ACTIVE shape S(tau) is the sum of the
  active-moiety components' unit responses. Let g(tau) = S(tau)/max S(tau) over
  a fine internal grid, so a single reference dose peaks at 1.0. Each dose event
  contributes c_event(t) = (dose_mg / route.dose_ref) * g(t - time_min). F and
  the absolute scale cancel in the ratio, so we never multiply by F here.
"""
from __future__ import annotations

import numpy as np

from app.data.repository import Repository
from app.engine.pd import felt_from_concentration
from app.engine.primitives import substance_unit_shape
from app.models import (
    ComputeRequest,
    ComputeResponse,
    Landmarks,
    Route,
    SeriesOut,
)

# A fine internal grid (minutes) used only to find the reference peak of g(tau).
_PEAK_GRID_STEP = 0.5
_THRESH_FELT = 0.5  # onset/offset crossing of the FELT curve


def _reference_peak(route: Route, span_min: float, ka_cache: dict) -> float:
    """Max of the un-normalized per-dose active shape over a fine grid.

    We search from 0 out to `span_min` (covering the visible window), which is
    enough to capture the peak of any single dose placed at t=0.
    """
    # Resolve the largest lag so we start the search at/after any clock shift.
    fine = np.arange(0.0, span_min + _PEAK_GRID_STEP, _PEAK_GRID_STEP)
    shape = substance_unit_shape(route, fine, ka_cache=ka_cache)
    peak = float(np.max(shape)) if shape.size else 0.0
    return peak


def _landmarks(
    grid: np.ndarray, felt: np.ndarray, now_min
) -> Landmarks:
    """Landmarks of the FELT curve. Any field may be None."""
    lm = Landmarks()
    if felt.size == 0:
        return lm

    # onset: first grid t with felt > threshold
    above = np.where(felt > _THRESH_FELT)[0]
    if above.size:
        lm.onset_min = float(grid[above[0]])

    # peak
    peak_idx = int(np.argmax(felt))
    lm.peak_min = float(grid[peak_idx])
    lm.peak_value = round(float(felt[peak_idx]), 3)

    # offset: first grid t AFTER the peak with felt < threshold
    after_peak = felt[peak_idx:]
    below = np.where(after_peak < _THRESH_FELT)[0]
    if below.size:
        lm.offset_min = float(grid[peak_idx + below[0]])
    else:
        lm.offset_min = None

    # current value at now_min (nearest grid point)
    if now_min is not None:
        idx = int(np.argmin(np.abs(grid - float(now_min))))
        lm.current_value = round(float(felt[idx]), 3)

    return lm


def compute_series(req: ComputeRequest, repo: Repository) -> ComputeResponse:
    """Events -> per-substance felt-effect + concentration series + landmarks."""
    w = req.window
    grid = np.arange(w.start, w.end_min + 1, w.step_min, dtype=float)
    grid_list = [float(t) for t in grid]

    # Group events by substance_id, preserving first-appearance order.
    order: list[str] = []
    groups: dict[str, list] = {}
    for ev in req.events:
        if ev.substance_id not in groups:
            groups[ev.substance_id] = []
            order.append(ev.substance_id)
        groups[ev.substance_id].append(ev)

    series_out: list[SeriesOut] = []

    for sid in order:
        events = groups[sid]
        substance = repo.get_substance(sid)
        if substance is None:
            continue

        # Resolve the route from the FIRST event's route_id (same substance ->
        # same route in Phase 1).
        route = substance.get_route(events[0].route_id)
        if route is None:
            continue

        ka_cache: dict = {}

        # Reference peak of one ref dose, over the visible span (search a bit
        # past end_min to robustly capture late peaks like patches/XR).
        span = float(w.end_min - w.start)
        ref_peak = _reference_peak(route, span, ka_cache)
        if ref_peak <= 0:
            ref_peak = 1.0  # degenerate guard; avoids divide-by-zero

        # Build total normalized concentration c(t) = sum of dose events.
        c = np.zeros_like(grid, dtype=float)
        for ev in events:
            tau = grid - ev.time_min
            shape = substance_unit_shape(route, tau, ka_cache=ka_cache)
            g = shape / ref_peak
            c = c + (ev.dose_mg / route.dose_ref) * g

        felt = felt_from_concentration(c, route.pd_model, float(w.step_min))

        lm = _landmarks(grid, felt, req.now_min)

        series_out.append(
            SeriesOut(
                substance_id=sid,
                name=substance.name,
                felt_effect=[round(float(v), 3) for v in felt],
                concentration=[round(float(v), 3) for v in c],
                landmarks=lm,
                breaks_superposition=route.breaks_superposition,
                confidence=substance.confidence,
            )
        )

    return ComputeResponse(grid_min=grid_list, series=series_out)
