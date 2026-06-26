"""PD transforms (concentration -> felt effect, 0..100). Pure, numpy-only.

Track A implementation:
  - direct: c' = max(0, c - threshold); felt = emax * c'^n / (ec50^n + c'^n)
            clamped to [0, 100].
  - effect_delay: first-order ke0 effect-site filter on c(t) before the Emax
                  step, so the felt peak lags the plasma peak.
  - irreversible / turnover: not in Phase 1 — fall back to `direct`, keep field.
"""
from __future__ import annotations

import math

import numpy as np

from app.models import PDModel

LN2 = math.log(2.0)


def _emax(c: np.ndarray, pd: PDModel) -> np.ndarray:
    """Apply the threshold + Hill/Emax saturation, clamped to [0, 100]."""
    c2 = np.maximum(0.0, c - pd.threshold)
    n = pd.hill_n
    ec50n = pd.ec50 ** n
    num = c2 ** n
    felt = pd.emax * num / (ec50n + num)
    # Where c2 == 0 the formula already gives 0; guard against any nan.
    felt = np.nan_to_num(felt, nan=0.0)
    return np.clip(felt, 0.0, 100.0)


def _effect_site(c: np.ndarray, step_min: float, ke0: float) -> np.ndarray:
    """First-order effect-site filter (hysteresis).

    ce[i] = ce[i-1] + ke0*step*(c[i-1] - ce[i-1]); ce[0] = 0.
    """
    ce = np.zeros_like(c, dtype=float)
    a = ke0 * step_min
    # Guard: if the step is too large for a stable explicit Euler step, sub-step.
    sub = max(1, int(math.ceil(a)))  # ensure ke0*step/sub <= ~1
    a_sub = a / sub
    for i in range(1, len(c)):
        prev_ce = ce[i - 1]
        # Linearly interpolate the driving concentration across sub-steps.
        c_prev = c[i - 1]
        c_cur = c[i]
        val = prev_ce
        for s in range(sub):
            c_drive = c_prev + (c_cur - c_prev) * (s / sub)
            val = val + a_sub * (c_drive - val)
        ce[i] = val
    return ce


def felt_from_concentration(
    c: np.ndarray, pd: PDModel, step_min: float
) -> np.ndarray:
    """Map a normalized concentration series to felt effect (0..100).

    `step_min` is the grid spacing (minutes), needed for the effect_delay filter.
    """
    c = np.asarray(c, dtype=float)

    if pd.mechanism == "effect_delay":
        ke0_min = pd.extras.get("ke0_min")
        if ke0_min and ke0_min > 0:
            ke0 = LN2 / ke0_min
            ce = _effect_site(c, step_min, ke0)
            return _emax(ce, pd)
        # No usable ke0 -> fall back to direct.
        return _emax(c, pd)

    # direct, irreversible, turnover (Phase 1 fallback): direct Emax on c(t).
    return _emax(c, pd)
