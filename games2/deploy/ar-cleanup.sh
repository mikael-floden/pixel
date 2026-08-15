#!/usr/bin/env bash
# Artifact Registry retention — stop the docker repo growing without bound.
#
# WHY: every deploy pushes an image tagged :<sha> and moves :latest. Nothing
# ever deleted anything, so the repo grows with every art push (measured
# 2026-08-14: 21 kr/week and +18%/period — the Aug 13 art-loop burst alone
# pushed ~1,000 images). This sets a SERVER-SIDE cleanup policy: it runs
# inside Artifact Registry forever, needs no CI job, no credentials and no
# maintenance, and cannot be broken by a red pipeline.
#
# HOW TO RUN — from a PHONE, deliberately (the maintainer has no laptop):
#   1. Open https://shell.cloud.google.com in the phone browser (or the
#      Google Cloud app's Cloud Shell) — it is already authenticated as you.
#   2. Paste:
#        curl -sS https://raw.githubusercontent.com/mikael-floden/pixel/main/games2/deploy/ar-cleanup.sh | PROJECT_ID=<your-project> bash
#      (or run it with no PROJECT_ID to be prompted.)
#
# WHAT IT KEEPS, and why it can never break a rollback or the live service:
#   • the newest 15 versions are ALWAYS kept (KEEP overrides every delete
#     rule in AR's policy engine) — that is ~2 weeks of meaningful rollback
#     targets at the current real deploy rate;
#   • anything older than 14 days beyond those is deleted, tagged or not.
#   • :latest and the currently-serving image are by definition among the
#     newest, so they are structurally inside the keep set.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
if [ -z "$PROJECT_ID" ]; then
  read -r -p "GCP project id: " PROJECT_ID
fi
REGION="${REGION:-europe-north1}"
AR_REPO="${AR_REPO:-nangijala}"

echo "▶ project=$PROJECT_ID region=$REGION repo=$AR_REPO"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "▶ current size (before)"
gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" \
  --format="value(sizeBytes)" | awk '{printf "  %.2f GB\n", $1/1073741824}'

POLICY="$(mktemp)"
cat > "$POLICY" <<'JSON'
[
  {
    "name": "keep-newest-15",
    "action": { "type": "Keep" },
    "mostRecentVersions": { "keepCount": 15 }
  },
  {
    "name": "delete-older-than-14d",
    "action": { "type": "Delete" },
    "condition": { "tagState": "any", "olderThan": "1209600s" }
  }
]
JSON

echo "▶ applying cleanup policy (keep newest 15, delete >14 days)"
gcloud artifacts repositories set-cleanup-policies "$AR_REPO" \
  --location="$REGION" \
  --policy="$POLICY" \
  --no-dry-run
rm -f "$POLICY"

echo
echo "✅ done — Artifact Registry now prunes itself continuously."
echo "   First sweep runs within a day; size drops over the following days"
echo "   (deleted layers leave billing at the next storage sample)."
echo "   Verify anytime with:"
echo "     gcloud artifacts repositories describe $AR_REPO --location=$REGION --format='value(sizeBytes)'"
