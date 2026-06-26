"""Track A — validation tests for the pure compute engine.

Run:
  cd backend && ./.venv/Scripts/python.exe -m pytest -q

These exercise the §3 behaviors against the 12 dummy archetypes:
  - simple_direct  -> clean Bateman: rise, single interior peak, decay
  - long_half_short_felt (redistribution) -> short felt despite long half-life
  - patch_zero_order -> long flat plateau then decay
  - prodrug_metabolite -> later + lower peak than simple_direct per unit
  - superposition -> two doses add (exact additivity on concentration)
  - sanity -> felt within [0,100]; below-threshold concentration => felt 0
  - primitives -> ka derivation round-trips; lag shifts the clock
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from app.data.dummy import DummyRepository
from app.engine.compute import compute_series
from app.engine.primitives import derive_ka, ke_from_half_life
from app.models import ComputeRequest, DoseEvent, Window


@pytest.fixture
def repo() -> DummyRepository:
    return DummyRepository()


def _run(repo, sid, route_id, dose, time_min=0, *, start=0, end=1440, step=5,
         now_min=None, extra_events=None):
    events = [DoseEvent(substance_id=sid, route_id=route_id, dose_mg=dose, time_min=time_min)]
    if extra_events:
        events.extend(extra_events)
    req = ComputeRequest(
        window=Window(start=start, end_min=end, step_min=step),
        now_min=now_min,
        events=events,
    )
    resp = compute_series(req, repo)
    return resp


def _series(resp, sid):
    for s in resp.series:
        if s.substance_id == sid:
            return s
    raise AssertionError(f"no series for {sid}")


# --------------------------------------------------------------------------- #
# Primitives: ka derivation + lag.                                            #
# --------------------------------------------------------------------------- #

def test_derive_ka_roundtrips_fast_branch():
    """ka derived from a Tmax below 1/ke reproduces that Tmax (ka > ke)."""
    ke = ke_from_half_life(5 * 60)  # 5 h half-life
    tmax = 45.0
    ka = derive_ka(tmax, ke)
    assert ka > ke
    # Tmax = ln(ka/ke)/(ka-ke)
    got = math.log(ka / ke) / (ka - ke)
    assert got == pytest.approx(tmax, rel=1e-4)


def test_derive_ka_flipflop_branch():
    """A Tmax exceeding 1/ke uses the flip-flop branch (ka < ke)."""
    ke = ke_from_half_life(45.0)  # short half-life => 1/ke is small
    tmax_limit = 1.0 / ke
    tmax = tmax_limit * 2.0
    ka = derive_ka(tmax, ke)
    assert ka < ke
    got = math.log(ka / ke) / (ka - ke)
    assert got == pytest.approx(tmax, rel=1e-3)


def test_lag_shifts_clock(repo):
    """delayed_enteric (lag 45 min) is flat at 0 until the lag elapses."""
    resp = _run(repo, "delayed_enteric", "oral_DR", 50)
    s = _series(resp, "delayed_enteric")
    grid = resp.grid_min
    c = s.concentration
    # Before the lag, concentration is exactly zero.
    i40 = grid.index(40.0)
    assert c[i40] == 0.0
    # Shortly after the lag it has risen above zero.
    i60 = grid.index(60.0)
    assert c[i60] > 0.0


# --------------------------------------------------------------------------- #
# simple_direct: clean Bateman.                                               #
# --------------------------------------------------------------------------- #

def test_simple_direct_clean_bateman(repo):
    resp = _run(repo, "simple_direct", "oral_IR", 10, now_min=215)
    s = _series(resp, "simple_direct")
    grid = np.array(resp.grid_min)
    c = np.array(s.concentration)
    felt = np.array(s.felt_effect)

    # starts at zero
    assert c[0] == 0.0
    # a single interior peak (not at the boundaries)
    peak_idx = int(np.argmax(c))
    assert 0 < peak_idx < len(c) - 1
    # rises monotonically up to the peak, decays after it
    assert np.all(np.diff(c[: peak_idx + 1]) >= -1e-9)
    assert np.all(np.diff(c[peak_idx:]) <= 1e-9)
    # reference dose peaks at normalized concentration 1.0
    assert c.max() == pytest.approx(1.0, abs=1e-3)
    # felt peak coincides with concentration peak (direct mechanism, near Tmax=45)
    felt_peak_idx = int(np.argmax(felt))
    assert grid[felt_peak_idx] == pytest.approx(45.0, abs=10.0)
    assert s.landmarks.peak_min == pytest.approx(45.0, abs=10.0)


# --------------------------------------------------------------------------- #
# Redistribution: short felt despite long terminal half-life.                 #
# --------------------------------------------------------------------------- #

def test_redistribution_short_felt_despite_long_half_life(repo):
    resp = _run(repo, "long_half_short_felt", "oral_IR", 10)
    s = _series(resp, "long_half_short_felt")
    grid = resp.grid_min
    felt = np.array(s.felt_effect)

    terminal_hl_min = 40 * 60  # 2400 min
    # The felt curve returns toward baseline FAR sooner than the 40 h half-life.
    assert s.landmarks.offset_min is not None
    assert s.landmarks.offset_min < terminal_hl_min  # far smaller than 40 h
    # By 6 hours, felt is already a small fraction of the peak (fast phase gone).
    peak = s.landmarks.peak_value
    i6h = grid.index(360.0)
    assert felt[i6h] < 0.15 * peak


# --------------------------------------------------------------------------- #
# Patch: long flat plateau then decay.                                        #
# --------------------------------------------------------------------------- #

def test_patch_zero_order_plateau_then_decay(repo):
    # Look out far enough to see the 72 h window then the decay.
    resp = _run(repo, "patch_zero_order", "patch", 25, end=6000, step=30)
    s = _series(resp, "patch_zero_order")
    grid = resp.grid_min
    c = np.array(s.concentration)

    # Mid-window plateau: concentration is roughly constant across the middle.
    i30h = grid.index(1800.0)
    i50h = grid.index(3000.0)
    plateau = c[i30h:i50h + 1]
    assert plateau.min() > 0.6  # still high across the plateau
    # nearly flat: spread small relative to level
    assert (plateau.max() - plateau.min()) < 0.25 * plateau.mean()

    # After the 72 h window (4320 min), concentration falls.
    window_end_idx = grid.index(4320.0)
    later_idx = grid.index(5400.0)  # ~90 h
    assert c[later_idx] < c[window_end_idx]


# --------------------------------------------------------------------------- #
# Prodrug: later and lower peak (per unit) than simple_direct.                 #
# --------------------------------------------------------------------------- #

def test_prodrug_later_and_lower_peak(repo):
    # Equivalent dosing = each at its own reference dose (per-unit comparison).
    pro = _series(_run(repo, "prodrug_metabolite", "oral_IR", 50), "prodrug_metabolite")
    sd = _series(_run(repo, "simple_direct", "oral_IR", 10), "simple_direct")

    # Both are dosed at one reference dose, so plasma peaks at 1.0 each; the
    # FELT peak differs because of timing/shape -> compare landmark times + felt.
    assert pro.landmarks.peak_min > sd.landmarks.peak_min  # delayed
    # Smooth: concentration rises to a single interior peak (no early spike).
    pc = np.array(pro.concentration)
    peak_idx = int(np.argmax(pc))
    assert 0 < peak_idx < len(pc) - 1
    assert pc[0] == 0.0
    # Lower felt peak per unit than the brisk IR stimulant.
    assert pro.landmarks.peak_value < sd.landmarks.peak_value


# --------------------------------------------------------------------------- #
# Superposition: two doses add (exact additivity on concentration).           #
# --------------------------------------------------------------------------- #

def test_superposition_two_doses_add(repo):
    # Two doses of analgesic_ir at t=0 and t=240.
    two = _run(
        repo, "analgesic_ir", "oral_IR", 400, time_min=0,
        extra_events=[DoseEvent(substance_id="analgesic_ir", route_id="oral_IR",
                                dose_mg=400, time_min=240)],
    )
    one_early = _run(repo, "analgesic_ir", "oral_IR", 400, time_min=0)
    one_late = _run(repo, "analgesic_ir", "oral_IR", 400, time_min=240)

    s2 = _series(two, "analgesic_ir")
    se = _series(one_early, "analgesic_ir")
    sl = _series(one_late, "analgesic_ir")
    grid = two.grid_min

    # Exact additivity of CONCENTRATION at an overlap point (e.g. t=300).
    i = grid.index(300.0)
    assert s2.concentration[i] == pytest.approx(
        se.concentration[i] + sl.concentration[i], abs=1e-3
    )
    # At the overlap, the combined felt/conc is >= a single dose's contribution.
    assert s2.concentration[i] >= sl.concentration[i] - 1e-9
    assert s2.felt_effect[i] >= sl.felt_effect[i] - 1e-9


# --------------------------------------------------------------------------- #
# Sanity: felt in [0,100]; below-threshold concentration => felt 0.           #
# --------------------------------------------------------------------------- #

def test_felt_bounds_all_archetypes(repo):
    cases = [
        ("simple_direct", "oral_IR", 10),
        ("analgesic_ir", "oral_IR", 400),
        ("long_half_short_felt", "oral_IR", 10),
        ("oros_biphasic", "oral_XR", 36),
        ("delayed_enteric", "oral_DR", 50),
        ("extended_simple", "oral_XR", 50),
        ("prodrug_metabolite", "oral_IR", 50),
        ("patch_zero_order", "patch", 25),
        ("sublingual_fast", "sublingual", 0.4),
        ("hysteresis_delay", "oral_IR", 250),
        ("short_supplement", "oral_IR", 3),
        ("saturable_zero", "oral_IR", 14000),
    ]
    for sid, route_id, dose in cases:
        resp = _run(repo, sid, route_id, dose)
        s = _series(resp, sid)
        felt = np.array(s.felt_effect)
        assert felt.min() >= 0.0, sid
        assert felt.max() <= 100.0, sid
        assert np.all(np.isfinite(felt)), sid
        assert np.all(np.isfinite(np.array(s.concentration))), sid


def test_below_threshold_yields_zero_felt(repo):
    """A tiny dose keeps concentration below the PD threshold => felt 0."""
    # threshold 0.08; dose 0.1 mg vs ref 10 mg => peak c ~= 0.01, well below.
    resp = _run(repo, "simple_direct", "oral_IR", 0.1)
    s = _series(resp, "simple_direct")
    c = np.array(s.concentration)
    felt = np.array(s.felt_effect)
    assert c.max() < 0.08  # entirely below threshold
    assert felt.max() == pytest.approx(0.0, abs=1e-9)
    assert s.landmarks.onset_min is None  # never crosses felt threshold


def test_saturable_flags_breaks_superposition(repo):
    resp = _run(repo, "saturable_zero", "oral_IR", 14000)
    s = _series(resp, "saturable_zero")
    assert s.breaks_superposition is True


def test_now_min_current_value(repo):
    resp = _run(repo, "simple_direct", "oral_IR", 10, now_min=215)
    s = _series(resp, "simple_direct")
    grid = resp.grid_min
    i = grid.index(215.0)
    assert s.landmarks.current_value == pytest.approx(s.felt_effect[i], abs=1e-6)


def test_different_substances_kept_separate(repo):
    """Two distinct substances yield two series in first-appearance order."""
    req = ComputeRequest(
        window=Window(start=0, end_min=1440, step_min=5),
        events=[
            DoseEvent(substance_id="analgesic_ir", route_id="oral_IR", dose_mg=400, time_min=30),
            DoseEvent(substance_id="simple_direct", route_id="oral_IR", dose_mg=10, time_min=0),
        ],
    )
    resp = compute_series(req, repo)
    assert [s.substance_id for s in resp.series] == ["analgesic_ir", "simple_direct"]
