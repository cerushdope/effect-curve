# Effect Curve

Log what you took, how much, and when — see a clean graph of **felt effect over
time** (onset → rise → peak/plateau → offset → baseline) for each substance on a
shared timeline.

A small generic engine drives everything: each substance is described by a few
stored parameters; one rendering engine turns them into a curve. Adding a
substance = adding **data**, never new code.

> Not a medical or dosing tool. Curves are population-typical estimates shown
> with explicit uncertainty — not predictions for an individual.

## Stack
- **Backend:** Python 3.11+, FastAPI, Pydantic v2, numpy. Tests in pytest.
- **Frontend:** plain **HTML / CSS / vanilla JS** (no framework). The chart is a
  custom `<canvas>` component — the signature look is ours.
- **DB:** in-code dummy data in Phase 1; MySQL in Phase 2 (same `Repository` interface).

## Layout
```
backend/   FastAPI app + pure compute engine + dummy data
frontend/  static HTML/CSS/JS (served by the backend in dev)
library/   Workstream L — the substance data pipeline (Phase 2+)
docs/      EFFECT_CURVE_BRIEF.md (the plan) + API_CONTRACT.md (frozen)
```

## Run it (dev)
From `backend/`:
```bash
# Windows (PowerShell)
./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000
```
Then open **http://localhost:8000** — the backend serves both the API and the
static frontend, so there are no CORS hops to worry about.

Convenience scripts (from the repo root):
- `./run.ps1`  — set up venv (if missing) and start the dev server (Windows)
- `./run.sh`   — same for bash

## Test the engine
From `backend/`:
```bash
./.venv/Scripts/python.exe -m pytest
```

## Phases
See `docs/EFFECT_CURVE_BRIEF.md`. Each phase ends at an approval gate. We are at:
**Phase 1 — end-to-end MVP on dummy data.**
