"""API routes for Effect Curve — the 3 contract endpoints + a health check.

All request/response types are the Pydantic models from `app.models`, so
FastAPI handles validation and OpenAPI docs for free.

See docs/API_CONTRACT.md. Time is integer minutes from window start.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.data.dummy import DummyRepository
from app.data.repository import Repository
from app.engine.compute import compute_series
from app.models import (
    ComputeRequest,
    ComputeResponse,
    Substance,
    SubstanceSummary,
)

router = APIRouter(prefix="/api")

# Single shared repository instance. DummyRepository is stateless/in-code, so a
# module-level singleton is fine and keeps the swap point (Repository) explicit.
_repo: Repository = DummyRepository()


@router.get("/health")
def health() -> dict[str, str]:
    """Liveness probe for smoke tests."""
    return {"status": "ok"}


@router.get("/substances", response_model=list[SubstanceSummary])
def search_substances(q: str = Query(default="")) -> list[SubstanceSummary]:
    """Search / autocomplete over name + aliases. Empty `q` returns all."""
    return _repo.search(q)


@router.get("/substances/{substance_id}", response_model=Substance)
def get_substance(substance_id: str) -> Substance:
    """Full Substance record, or 404 if unknown."""
    substance = _repo.get_substance(substance_id)
    if substance is None:
        raise HTTPException(status_code=404, detail="not found")
    return substance


@router.post("/compute", response_model=ComputeResponse)
def compute(req: ComputeRequest) -> ComputeResponse:
    """The draw call: events -> per-substance felt-effect series + landmarks."""
    return compute_series(req, _repo)
