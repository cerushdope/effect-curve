# Effect Curve — API Contract (FROZEN at Phase 0)

> Changing anything here is a contract change: bump a version note and update
> both `backend/app/models.py` and `frontend/src/api/contract.js` in lockstep.

**Conventions**
- All JSON.
- **Time is integer minutes from the window start** (not ISO timestamps). The
  chart works in minutes; the UI maps minutes ↔ wall-clock for display only.
- Colors are assigned **client-side** from a palette, never by the backend.
- Base URL in dev: `http://localhost:8000`.

---

## `GET /api/substances?q={query}`
Search / autocomplete over name + aliases. Empty `q` returns all archetypes.

**200 →**
```json
[
  { "id": "simple_direct", "name": "Stimulant (IR)", "category": "stimulant", "aliases": ["stim"] }
]
```

## `GET /api/substances/{id}`
Full `Substance` record (routes, pk_components, pd_model, landmarks, provenance).

**200 →** a `Substance` object (see `models.py`). **404 →** `{ "detail": "not found" }`.

## `POST /api/compute`
The draw call. Same-substance doses are summed server-side; different substances
are kept separate.

**Request**
```jsonc
{
  "window": { "start": 0, "end_min": 1440, "step_min": 5 },
  "now_min": 215,                       // optional, for the "now" readout/line
  "events": [
    { "substance_id": "oros_biphasic", "route_id": "oral_XR", "dose_mg": 36, "time_min": 0 },
    { "substance_id": "analgesic_ir",  "route_id": "oral_IR", "dose_mg": 400, "time_min": 30 },
    { "substance_id": "analgesic_ir",  "route_id": "oral_IR", "dose_mg": 400, "time_min": 240 }
  ]
}
```

**Response** — keyed by substance; one series per distinct `substance_id`.
```jsonc
{
  "grid_min": [0, 5, 10, "..."],
  "series": [
    {
      "substance_id": "analgesic_ir",
      "name": "Analgesic (IR)",
      "felt_effect": [0, 2, 7, "..."],     // 0..100, aligned to grid_min
      "concentration": [0, 0.03, "..."],    // normalized (ref peak = 1.0), optional toggle
      "landmarks": {
        "onset_min": 22, "peak_min": 60, "peak_value": 78,
        "offset_min": 360, "current_value": 41
      },
      "breaks_superposition": false,
      "confidence": "low"
    }
  ]
}
```

### Notes for implementers
- `felt_effect[i]` and `concentration[i]` align to `grid_min[i]`.
- `landmarks` describe the **felt** curve (not plasma). Any field may be `null`
  (e.g. a curve that never crosses threshold → `onset_min: null`).
- `current_value` is the felt level at `now_min` (null if `now_min` omitted).
- The frontend assigns each `substance_id` a stable color from the palette.
