# Effect Curve — dev runner (Windows / PowerShell)
# Sets up the venv if needed, then serves API + static frontend on :8000.
$ErrorActionPreference = "Stop"
$backend = Join-Path $PSScriptRoot "backend"
$py = Join-Path $backend ".venv/Scripts/python.exe"

if (-not (Test-Path $py)) {
    Write-Host "Creating venv + installing deps..."
    python -m venv (Join-Path $backend ".venv")
    & $py -m pip install --upgrade pip
    & $py -m pip install -r (Join-Path $backend "requirements.txt")
}

Push-Location $backend
try {
    Write-Host "Serving on http://localhost:8000  (Ctrl+C to stop)"
    & $py -m uvicorn app.main:app --reload --port 8000
} finally {
    Pop-Location
}
