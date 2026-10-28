#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Setting up Python venv"
python3 -m venv venv
venv/bin/pip install --upgrade pip
venv/bin/pip install -r backend/requirements.txt

echo "==> Installing frontend dependencies"
cd frontend
npm install
cd "$REPO_ROOT"

if [ ! -f backend/.env ]; then
  echo ""
  echo "WARNING: backend/.env not found. Copy backend/.env.example and fill in at least:"
  echo "  NETWORK_TEST_API_KEY=some-random-value   # required; every /api route fails closed without it"
  echo "  SPACE_NAME, PROJECT_ID, AUTH_TOKEN, NETWORK_TEST_ECHO_RESOURCE_ID   # or NETWORK_TEST_REGIONS"
  echo "  NETWORK_TEST_ALLOW_NO_CAPTCHA=true       # local development only"
  echo ""
fi
