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
# WHY TWO DAYS, and it is the only lever there is (measured 2026-09-23).
# The window was 14 days and the registry sat at 490 GB. That was not a leak
# and not a broken policy — the policy WAS working, and 490 GB is simply what
# 14 days converges to:
#
#   retention x push rate x size per version = steady state
#   14 days   x  88/day   x     425 MB       = 490 GB
#   (measured: 1154 versions, 489,886 MB, 425 MB each)
#
# Cross-checked against git: 1229 commits in those 14 days touch a path that
# builds an image, against 1154 versions in the registry. Every push is a
# version, and the window alone decides how many are alive. Running the manual
# purge on top of it found EIGHT to delete, because the policy had taken the
# rest — which is why "run the purge again" was never the answer.
#
# At 88 deploys a day, 2 days is ~176 rollback points, far more than anyone
# reaches for, and the image rebuilds from any commit anyway (the backup is
# .github/workflows/backup-gcs.yml, never this registry). Maintainer chose 2
# days from a costed menu: ~70 GB, roughly kr 43/mo against kr 304.
#
# KEEP IT IN STEP WITH ar-purge.sh's KEEP_DAYS. They are one rule run by two
# hands; if they disagree, the manual purge deletes what the policy means to
# keep, or spares what it means to take.
set -euo pipefail

# Settings first: the project derivation below PROBES the registry with them.
REGION="${REGION:-europe-north1}"
AR_REPO="${AR_REPO:-nangijala}"

# PROJECT: derived, never prompted. Cloud Shell exports DEVSHELL_PROJECT_ID for
# the active project, and gcloud knows it too — so the paste needs no editing
# and no lookup. Deliberately NOT `read`: the documented invocation pipes this
# script into bash, which means stdin is the SCRIPT, and an interactive read
# there either hangs or swallows the next line of the program.
# `|| true` matters: under `set -e` a failing command substitution inside an
# assignment kills the script THERE, so without it a missing/erroring gcloud
# exits silently with no diagnostic — verified by piping this script into bash
# with gcloud off PATH.
SELF="https://raw.githubusercontent.com/mikael-floden/pixel/main/games2/deploy/ar-cleanup.sh"
PROJECT_ID="${PROJECT_ID:-${DEVSHELL_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}}"
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  # THE FALLBACK THAT ACTUALLY FIRES (measured 2026-09-22, on his phone): a
  # fresh Cloud Shell that has never been pointed at a project opens as
  # "(no project)", so DEVSHELL_PROJECT_ID is empty AND `config get-value`
  # answers "(unset)" — and the paste this whole script exists to be died on
  # its first line. Asking him to edit it is the thing the repo forbids
  # ("Derive, don't ask", root CLAUDE.md: a hand-set variable left the backup
  # silently backing up nothing for three nights). So derive it from the
  # ACCOUNT: exactly one project is unambiguous and needs no human; several
  # need his eye, and then he gets a line to PASTE rather than a lookup to go
  # and perform. `|| true` on both, because under `set -e` a failing command
  # substitution inside an assignment kills the script right there.
  PROJECTS="$(gcloud projects list --format='value(projectId)' 2>/dev/null || true)"
  COUNT="$(printf '%s\n' "$PROJECTS" | grep -c . || true)"
  if [ "$COUNT" = "1" ]; then
    PROJECT_ID="$PROJECTS"
    echo "▶ no active project set; using the only one on this account: $PROJECT_ID"
  else
    # SEVERAL PROJECTS — ASK THE REGISTRY, DO NOT ASK HIM (maintainer 2026-09-23,
    # on a phone: the paste ran, hit this branch, printed a line to edit, and
    # stopped. He replied "Done". It had deleted nothing). His account has two
    # projects and only ONE of them holds this repository, so the answer is a
    # lookup, not a decision — and the project is spelled `nagijala` against the
    # repo's `nangijala`, so it cannot be guessed either. Same law as the bucket
    # name in backup-gcs.yml: derive, don't ask. Only a genuinely ambiguous
    # answer (none, or more than one) still hands back a line.
    echo "▶ no active project set; $COUNT on this account — asking which holds ${AR_REPO}" >&2
    MATCHES=""
    for p in $PROJECTS; do
      if gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" \
           --project="$p" >/dev/null 2>&1; then
        MATCHES="$MATCHES $p"
      fi
    done
    set -- $MATCHES
    if [ "$#" = "1" ]; then
      PROJECT_ID="$1"
      echo "▶ using $PROJECT_ID — the only one with a ${AR_REPO} repository in ${REGION}" >&2
    else
      echo "Could not tell which project to use ($# hold a ${AR_REPO} repository in ${REGION}):" >&2
      printf '  %s\n' $PROJECTS >&2
      echo >&2
      echo "Paste this, with the one you want:" >&2
      echo "  gcloud config set project THE-ID && curl -sS $SELF | bash" >&2
      exit 1
    fi
  fi
fi

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
    "name": "delete-older-than-2d",
    "action": { "type": "Delete" },
    "condition": { "tagState": "any", "olderThan": "2d" }
  }
]
JSON

echo "▶ applying cleanup policy (keep newest 15, delete >2 days)"
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
