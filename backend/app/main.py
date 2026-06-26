"""FastAPI application — serves BOTH the JSON API and the static frontend.

Run (from backend/):
    ./.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000

Then http://localhost:8000 serves the UI and http://localhost:8000/api/* the API.

Wiring order matters:
  1. include the /api router FIRST,
  2. mount the static frontend at "/" LAST, so StaticFiles does not shadow /api.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import router as api_router

app = FastAPI(title="Effect Curve", version="1.0.0")

# CORS: allow localhost / 127.0.0.1 on any port so a standalone static server
# (or the bundled mount) can talk to the API during dev.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes first.
app.include_router(api_router)

# Static frontend last, mounted at "/". Path is resolved relative to THIS file
# (backend/app/main.py -> ../../frontend) so it works regardless of CWD.
_FRONTEND_DIR = (Path(__file__).resolve().parent.parent.parent / "frontend").resolve()
if _FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIR), html=True), name="frontend")
