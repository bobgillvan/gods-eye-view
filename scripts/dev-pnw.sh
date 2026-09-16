#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pacific Northwest CCTV preset: the hand-built Vancouver + Seattle packs from
# config/ instead of the built-in Austin/Caltrans/TfL packs. Setting
# CCTV_SOURCES_FILE suppresses those built-ins, so the built-in per-pack caps
# below are left alone; CCTV_MAX_SOURCES is raised to the compiled 1200 ceiling
# because the pnw pack is 1180 and the 900 default would silently truncate it.
# See config/README.pnw-cctv.md. Explicit environment overrides remain
# supported, so a single city pack is CCTV_SOURCES_FILE=... npm run dev:pnw.
export CCTV_SOURCES_FILE="${CCTV_SOURCES_FILE:-config/cctv_sources.pnw.json}"
export CCTV_MAX_SOURCES="${CCTV_MAX_SOURCES:-1200}"

exec bash "$ROOT_DIR/scripts/dev-fresh.sh"
