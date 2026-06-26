#!/usr/bin/env bash
# Effect Curve — dev runner (bash). Serves API + static frontend on :8000.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend="$here/backend"
py="$backend/.venv/Scripts/python.exe"   # Windows venv layout
[ -x "$py" ] || py="$backend/.venv/bin/python"

if [ ! -x "$py" ]; then
  echo "Creating venv + installing deps..."
  python -m venv "$backend/.venv"
  [ -x "$backend/.venv/Scripts/python.exe" ] && py="$backend/.venv/Scripts/python.exe" || py="$backend/.venv/bin/python"
  "$py" -m pip install --upgrade pip
  "$py" -m pip install -r "$backend/requirements.txt"
fi

cd "$backend"
echo "Serving on http://localhost:8000  (Ctrl+C to stop)"
exec "$py" -m uvicorn app.main:app --reload --port 8000
