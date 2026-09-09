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
#      Google Cloud app's Cloud Shell) — it is already authenticated as you
#      and already knows the project.
#   2. Paste ONE line:
#
#        curl -sS https://raw.githubusercontent.com/mikael-floden/pixel/main/games2/deploy/ar-cleanup.sh | bash
#
#      Nothing to fill in. Override with PROJECT_ID=… / REGION=… / AR_REPO=…
#      before `bash` only if the defaults below are wrong.
#
# WHAT IT KEEPS, and why it can never break a rollback or the live service:
#   • the newest 15 versions are ALWAYS kept (KEEP overrides every delete
#     rule in AR's policy engine) — that is ~2 weeks of meaningful rollback
#     targets at the current real deploy rate;
#   • anything older than 14 days beyond those is deleted, tagged or not.
#   • :latest and the currently-serving image are by definition among the
#     newest, so they are structurally inside the keep set.
set -euo pipefail

# PROJECT: derived, never prompted. Cloud Shell exports DEVSHELL_PROJECT_ID for
# the active project, and gcloud knows it too — so the paste needs no editing
# and no lookup. Deliberately NOT `read`: the documented invocation pipes this
# script into bash, which means stdin is the SCRIPT, and an interactive read
# there either hangs or swallows the next line of the program.
# `|| true` matters: under `set -e` a failing command substitution inside an
# assignment kills the script THERE, so without it a missing/erroring gcloud
# exits silently with no diagnostic — verified by piping this script into bash
# with gcloud off PATH.
PROJECT_ID="${PROJECT_ID:-${DEVSHELL_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}}"
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo "No project found. Re-run as:  PROJECT_ID=your-project bash ar-cleanup.sh" >&2
  exit 1
fi
REGION="${REGION:-europe-north1}"
AR_REPO="${AR_REPO:-nangijala}"

echo "▶ project=$PROJECT_ID region=$REGION repo=$AR_REPO"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "▶ current size (before)"
# NOT --format='value(sizeBytes)': that field comes back EMPTY from this API,
# so the awk divided nothing and cheerfully printed "0.00 GB" over a 285 GB
# repository (observed 2026-08-15). The real number is in gcloud's own
# human-readable output, so read that and let it speak for itself.
gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" 2>&1 \
  | grep -iE "repository size" || echo "  (size not reported by this API version)"

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
    "condition": { "tagState": "any", "olderThan": "14d" }
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
echo "     gcloud artifacts repositories describe $AR_REPO --location=$REGION | grep -i 'repository size'"
