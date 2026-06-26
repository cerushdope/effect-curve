"""Component unit-response functions (PK layer). Pure, numpy-only.

Track A implementation of the closed-form PK primitives (see brief §3):
  - first_order input + single-exp decline (Bateman); derive ka from Tmax
  - first_order input + bi-exponential decline (redistribution)
  - zero_order input over a window + decline (patch / OROS flat-top)
  - instant input + decline (sublingual / IV)
  - lag (shift tau)
  - from_parent (prodrug -> metabolite cascade; Bateman with parent/metab rates)
  - saturable decline (Phase 1: approximated as single-exp via fallback half-life)

All functions take elapsed-time arrays (minutes) and return the per-unit-dose
concentration contribution, with 0 for tau < 0. Everything is dimensionless: the
absolute scale and any rate prefactor cancel later in normalization.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from app.models import PKComponent, Route

LN2 = math.log(2.0)


def ke_from_half_life(half_life_min: float) -> float:
    """Elimination rate constant from a half-life in minutes."""
    return LN2 / half_life_min


# --------------------------------------------------------------------------- #
# ka derivation: solve Tmax = ln(ka/ke) / (ka - ke) for ka, given ke + Tmax.  #
# --------------------------------------------------------------------------- #

def _tmax_of_ka(ka: float, ke: float) -> float:
    """Tmax produced by a Bateman curve with the given ka, ke.

    Tmax = ln(ka/ke) / (ka - ke); the ka->ke limit gives Tmax = 1/ke.
    """
    if abs(ka - ke) < 1e-12:
        return 1.0 / ke
    return math.log(ka / ke) / (ka - ke)


def derive_ka(tmax_min: float, ke: float) -> float:
    """Solve for ka given a target Tmax and elimination rate ke (bisection).

    The maximum Tmax achievable with ka > ke is 1/ke (the ka->ke limit). If the
    requested Tmax is below that, ka lives in (ke, ke*1e4) and Tmax is a strictly
    decreasing function of ka. If the requested Tmax exceeds 1/ke, we take the
    flip-flop branch with ka in (ke*1e-4, ke) (absorption rate-limited).
    """
    if tmax_min <= 0:
        # Degenerate: behaves like an instant input — very fast absorption.
        return ke * 1e4

    tmax_limit = 1.0 / ke  # the ka == ke limit

    if abs(tmax_min - tmax_limit) < 1e-9:
        return ke  # caller should use the limit form

    if tmax_min < tmax_limit:
        lo, hi = ke, ke * 1e4  # absorption-limited branch (ka > ke)
    else:
        lo, hi = ke * 1e-4, ke  # flip-flop branch (ka < ke)

    # Across the whole domain Tmax = ln(ka/ke)/(ka-ke) is STRICTLY DECREASING in
    # ka, so a single bisection orientation works on both branches: if the
    # current Tmax is larger than the target, ka is too small -> raise lo.
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        t = _tmax_of_ka(mid, ke)
        if t > tmax_min:
            lo = mid
        else:
            hi = mid
        if abs(hi - lo) < 1e-12:
            break
    return 0.5 * (lo + hi)


# --------------------------------------------------------------------------- #
# Unit shapes (per unit dose; rate prefactors that cancel are kept for shape). #
# --------------------------------------------------------------------------- #

def _bateman(tau: np.ndarray, ka: float, ke: float) -> np.ndarray:
    """First-order absorption + single-exp decline.

    unit(tau) = ka/(ka-ke) * (exp(-ke*tau) - exp(-ka*tau)), 0 for tau < 0.
    Handles ka ~= ke with the limiting form ke*tau*exp(-ke*tau).
    """
    out = np.zeros_like(tau, dtype=float)
    pos = tau >= 0
    tp = tau[pos]
    if abs(ka - ke) < 1e-9:
        out[pos] = ke * tp * np.exp(-ke * tp)
    else:
        out[pos] = ka / (ka - ke) * (np.exp(-ke * tp) - np.exp(-ka * tp))
    return out


def _bateman_biexp(
    tau: np.ndarray, ka: float, k1: float, w1: float, k2: float, w2: float
) -> np.ndarray:
    """First-order absorption + bi-exponential decline (redistribution).

    unit(tau) = ka*[ w1/(ka-k1)*(exp(-k1 tau)-exp(-ka tau))
                   + w2/(ka-k2)*(exp(-k2 tau)-exp(-ka tau)) ].
    """
    out = np.zeros_like(tau, dtype=float)
    pos = tau >= 0
    tp = tau[pos]

    def phase(k: float, w: float) -> np.ndarray:
        if abs(ka - k) < 1e-9:
            # limit of w/(ka-k)*(exp(-k tau)-exp(-ka tau)) -> w*tau*exp(-k tau)
            return w * tp * np.exp(-k * tp)
        return w / (ka - k) * (np.exp(-k * tp) - np.exp(-ka * tp))

    out[pos] = ka * (phase(k1, w1) + phase(k2, w2))
    return out


def _zero_order(tau: np.ndarray, ke: float, window: float) -> np.ndarray:
    """Zero-order input over window W then single-exp decline (rate R = 1).

    0 <= tau <= W:  C = (1/ke)*(1 - exp(-ke*tau))
    tau > W:        C = (1/ke)*(1 - exp(-ke*W)) * exp(-ke*(tau-W))
    """
    out = np.zeros_like(tau, dtype=float)
    inwin = (tau >= 0) & (tau <= window)
    after = tau > window
    out[inwin] = (1.0 / ke) * (1.0 - np.exp(-ke * tau[inwin]))
    plateau_end = (1.0 / ke) * (1.0 - math.exp(-ke * window))
    out[after] = plateau_end * np.exp(-ke * (tau[after] - window))
    return out


def _instant_single(tau: np.ndarray, ke: float) -> np.ndarray:
    """Instant input + single-exp decline: exp(-ke*tau), tau >= 0."""
    out = np.zeros_like(tau, dtype=float)
    pos = tau >= 0
    out[pos] = np.exp(-ke * tau[pos])
    return out


def _instant_biexp(
    tau: np.ndarray, k1: float, w1: float, k2: float, w2: float
) -> np.ndarray:
    """Instant input + bi-exp decline: w1*exp(-k1 tau) + w2*exp(-k2 tau)."""
    out = np.zeros_like(tau, dtype=float)
    pos = tau >= 0
    tp = tau[pos]
    out[pos] = w1 * np.exp(-k1 * tp) + w2 * np.exp(-k2 * tp)
    return out


# --------------------------------------------------------------------------- #
# Decline-rate helpers.                                                       #
# --------------------------------------------------------------------------- #

def _decline_rates(decline) -> tuple[list[float], list[float]]:
    """Return (rates, weights) for a first_order decline (single or bi-exp).

    Single phase -> ([ke], [1.0]); bi-exp -> ([k1, k2], [w1, w2]).
    Saturable -> uses fallback_half_life_min as a single-exp approximation.
    """
    p = decline.params
    if decline.type == "saturable":
        hl = p.get("fallback_half_life_min")
        return [ke_from_half_life(hl)], [1.0]
    if "half_life_min" in p and "half_life1_min" not in p:
        return [ke_from_half_life(p["half_life_min"])], [1.0]
    # bi-exponential
    k1 = ke_from_half_life(p["half_life1_min"])
    k2 = ke_from_half_life(p["half_life2_min"])
    w1 = p["w1"]
    w2 = p["w2"]
    return [k1, k2], [w1, w2]


# --------------------------------------------------------------------------- #
# Public: per-component unit response on an elapsed-tau grid.                  #
# --------------------------------------------------------------------------- #

def component_unit(
    comp: PKComponent,
    tau: np.ndarray,
    *,
    parent_comp: Optional[PKComponent] = None,
    ka_cache: Optional[dict] = None,
) -> np.ndarray:
    """Per-unit-dose normalized-shape contribution of a single PK component.

    `tau` is elapsed time = (t - time_min - lag_min); negative entries yield 0.
    Returns a numpy array the same shape as `tau`.
    """
    inp = comp.input
    decl = comp.decline
    rates, weights = _decline_rates(decl)

    if inp.type == "instant":
        if len(rates) == 1:
            return _instant_single(tau, rates[0])
        return _instant_biexp(tau, rates[0], weights[0], rates[1], weights[1])

    if inp.type == "zero_order":
        window = inp.params.get("window_min")
        # zero-order assumes single-exp decline in Phase 1
        return _zero_order(tau, rates[0], window)

    if inp.type == "from_parent":
        # Bateman form with ka_eff = parent elimination rate, ke_eff = this rate.
        if parent_comp is None:
            raise ValueError("from_parent component requires a parent_comp")
        parent_rates, _ = _decline_rates(parent_comp.decline)
        ka_eff = parent_rates[0]
        ke_eff = rates[0]
        return _bateman(tau, ka_eff, ke_eff)

    if inp.type == "first_order":
        # Derive (and cache) ka from Tmax using the FAST phase as ke.
        ke_fast = rates[0]
        if "ka" in inp.params:
            ka = inp.params["ka"]
        else:
            key = id(comp)
            if ka_cache is not None and key in ka_cache:
                ka = ka_cache[key]
            else:
                ka = derive_ka(inp.tmax_min, ke_fast)
                if ka_cache is not None:
                    ka_cache[key] = ka
        if len(rates) == 1:
            return _bateman(tau, ka, rates[0])
        return _bateman_biexp(tau, ka, rates[0], weights[0], rates[1], weights[1])

    raise ValueError(f"unknown input type: {inp.type}")


def substance_unit_shape(
    route: Route, t: np.ndarray, *, ka_cache: Optional[dict] = None
) -> np.ndarray:
    """The per-dose ACTIVE concentration shape S(tau), evaluated on grid `t`.

    Sum over components with is_active_moiety==True of fraction * unit(tau),
    where tau accounts for each component's own lag. `t` here is already
    elapsed time relative to a dose at tau-origin 0 (the caller shifts per event).
    NOT yet normalized — callers normalize by the global peak.
    """
    # Map component id -> component, to resolve `feeds_id` parents.
    by_id = {c.id: c for c in route.pk_components if c.id is not None}

    total = np.zeros_like(t, dtype=float)
    for comp in route.pk_components:
        if not comp.is_active_moiety:
            continue
        parent = by_id.get(comp.feeds_id) if comp.feeds_id else None
        tau = t - comp.input.lag_min
        contrib = component_unit(comp, tau, parent_comp=parent, ka_cache=ka_cache)
        total = total + comp.fraction * contrib
    return total
