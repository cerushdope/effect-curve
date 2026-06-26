"""API-layer tests (Track B).

These exercise routing, validation, and (de)serialization against the
DummyRepository. They do NOT assert engine math — the engine may be a stub
while these are written. `/api/compute` only checks the response is a valid
ComputeResponse aligned to the request grid.

Run (from backend/):
    ./.venv/Scripts/python.exe -m pytest tests/test_api.py
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_search_empty_returns_all() -> None:
    r = client.get("/api/substances")
    assert r.status_code == 200
    items = r.json()
    assert isinstance(items, list)
    assert len(items) == 12
    sample = items[0]
    assert set(sample.keys()) == {"id", "name", "category", "aliases"}


def test_search_filters_by_query() -> None:
    r = client.get("/api/substances", params={"q": "patch"})
    assert r.status_code == 200
    ids = {s["id"] for s in r.json()}
    assert "patch_zero_order" in ids


def test_search_no_match_is_empty() -> None:
    r = client.get("/api/substances", params={"q": "zzz-no-such-thing"})
    assert r.status_code == 200
    assert r.json() == []


def test_get_substance_ok() -> None:
    r = client.get("/api/substances/simple_direct")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "simple_direct"
    assert body["routes"][0]["pk_components"]


def test_get_substance_404() -> None:
    r = client.get("/api/substances/does_not_exist")
    assert r.status_code == 404
    assert r.json() == {"detail": "not found"}


def test_compute_shape() -> None:
    req = {
        "window": {"start": 0, "end_min": 60, "step_min": 5},
        "now_min": 30,
        "events": [
            {"substance_id": "simple_direct", "route_id": "oral_IR",
             "dose_mg": 10, "time_min": 0},
        ],
    }
    r = client.post("/api/compute", json=req)
    assert r.status_code == 200
    body = r.json()
    assert "grid_min" in body and "series" in body
    # Grid spans the requested window inclusively at the requested step.
    assert body["grid_min"][0] == 0
    assert body["grid_min"][-1] == 60
    # Every series (if any) aligns to the grid.
    for s in body["series"]:
        assert len(s["felt_effect"]) == len(body["grid_min"])
        assert len(s["concentration"]) == len(body["grid_min"])


def test_compute_validation_error() -> None:
    # Missing required event fields -> 422 from Pydantic.
    r = client.post("/api/compute", json={"events": [{"substance_id": "x"}]})
    assert r.status_code == 422
