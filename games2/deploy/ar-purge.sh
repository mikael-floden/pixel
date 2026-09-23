#!/usr/bin/env bash
# PURGE OLD IMAGES NOW — the cleanup policy's rule, run by hand, so the space
# comes back today instead of whenever Artifact Registry gets around to it.
#
# WHY THIS EXISTS (maintainer 2026-09-22: "So we have 488GB stored today and
# that cost me a lot and I can't get a proven fix now?"). ar-cleanup.sh attaches
# a SERVER-SIDE policy, which is the right permanent answer — but Artifact
# Registry sweeps it asynchronously, so on the day you run it it proves nothing.
# This deletes the versions itself and prints the VERSION COUNT before and
# after, which is the number that moves immediately.
#
# HOW TO RUN — from a PHONE (he has no laptop):
#   1. https://shell.cloud.google.com
#   2. Paste ONE line:
#        curl -sS https://raw.githubusercontent.com/mikael-floden/pixel/main/games2/deploy/ar-purge.sh | bash
#      Nothing to fill in. Add `| DRY_RUN=1 bash` to see the list without
#      deleting anything.
#
# WHAT IT KEEPS, and all three arms are load-bearing:
#   1. THE NEWEST KEEP_NEWEST (15) VERSIONS, whatever their age. This is the arm
#      that makes the script safe in the case the age rule alone gets WRONG: the
#      service runs --min-instances 0, so a cold start PULLS THE IMAGE FROM THIS
#      REPOSITORY. If the fleet ever went quiet for longer than KEEP_DAYS, an
#      age-only rule would delete the very image Cloud Run needs to boot, and
#      the symptom is "Nangijala could not start" with nothing in the logs about
#      a registry. The newest 15 can never be that set.
#   2. ANYTHING NEWER THAN KEEP_DAYS (2). The same rule ar-cleanup.sh installs
#      server-side, so the manual purge and the policy settle on one steady
#      state rather than fighting.
#   3. THE DIGEST CLOUD RUN IS SERVING, and the one :latest points at, read
#      live and excluded by name. Belt over arm 1's braces; if either read
#      fails the script says so and arms 1+2 still hold.
#   Plus: it targets ONLY <service>. <service>-buildcache is a separate image in
#   the same repo (nangijala-deploy.yml:418); deleting it breaks nothing but
#   makes the next deploy rebuild every layer, so it is left alone deliberately.
#
# A NOTE ON THE SIZE NUMBER: layers are content-addressed and shared between
# versions, and Artifact Registry frees a layer only once nothing references it,
# on its own schedule. So the VERSION COUNT drops in this paste and the SIZE
# follows over the next hours. Both are printed; only the first is the proof.
#
# It is idempotent: interrupted, re-run it — already-deleted versions report
# "not found" and are skipped.
set -uo pipefail

SELF="https://raw.githubusercontent.com/mikael-floden/pixel/main/games2/deploy/ar-purge.sh"
# MUST MATCH ar-cleanup.sh's policy window, or the two fight: the manual
# purge and the server-side sweep are the same rule run by different hands.
KEEP_DAYS="${KEEP_DAYS:-2}"
# In step with ar-cleanup.sh's keep-newest-200. At ~88 image builds a day
# (measured) 15 was four hours of cover; 200 is ~2.3 days, which is what it
# takes to outlast a CI outage that keeps pushing images without rolling one
# out. Costs ~nothing in steady state: the 2-day rule already keeps ~176.
KEEP_NEWEST="${KEEP_NEWEST:-200}"
PARALLEL="${PARALLEL:-8}"   # gcloud calls in flight; 8 is polite and ~8x faster
DRY_RUN="${DRY_RUN:-}"

# Settings first: the project derivation below PROBES the registry with them.
REGION="${REGION:-europe-north1}"
AR_REPO="${AR_REPO:-nangijala}"
SERVICE="${SERVICE:-nangijala}"

# PROJECT: derived, never prompted — the same four sources as ar-cleanup.sh. A
# fresh Cloud Shell opens as "(no project)", so DEVSHELL_PROJECT_ID and
# `config get-value` are both empty, and a paste that needs editing is a paste
# that does not get run (root CLAUDE.md, "Derive, don't ask"). `|| true`
# throughout: a failing command substitution inside an assignment would
# otherwise kill the script with no diagnostic.
PROJECT_ID="${PROJECT_ID:-${DEVSHELL_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}}"
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
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

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE}"

echo "▶ project=$PROJECT_ID region=$REGION repo=$AR_REPO"
echo "▶ image   $IMAGE"
echo "▶ keeping the newest $KEEP_NEWEST versions AND anything under $KEEP_DAYS days old"
echo "▶ NOT touching ${SERVICE}-buildcache"
[ -n "$DRY_RUN" ] && echo "▶ DRY RUN — nothing will be deleted"
gcloud config set project "$PROJECT_ID" >/dev/null 2>&1 || true

size_now() {
  # NOT --format='value(sizeBytes)': that field comes back EMPTY from this API
  # and once printed "0.00 GB" over a 285 GB repository (2026-08-15, d54928100b).
  # The real number is only in the human-readable output.
  gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" 2>&1 \
    | grep -iE "repository size" || echo "  (size not reported by this API version)"
}

# The digest of a tag, or empty. `version` on these rows can come back as a bare
# sha256:... or as a full projects/.../versions/sha256:... path depending on the
# SDK build, so take the basename of whatever arrives — a no-op on the bare form.
digest_of() {
  gcloud artifacts docker images describe "$1" --format='value(version)' 2>/dev/null \
    | sed 's#.*/##' | grep '^sha256:' | head -1
}

echo
echo "▶ size BEFORE (lags — see the note at the top of this script)"
size_now

ALL="$(mktemp)"; KEEP="$(mktemp)"; LIST="$(mktemp)"; RES="$(mktemp)"
trap 'rm -f "$ALL" "$KEEP" "$LIST" "$RES"' EXIT

# One listing, sorted newest-first IN SHELL rather than trusting --sort-by:
# createTime is RFC3339 UTC and fixed-width through the seconds, so a plain
# lexicographic reverse sort is the chronological one.
gcloud artifacts docker images list "$IMAGE" \
  --format='csv[no-heading](version,createTime)' \
  --limit=100000 2>/dev/null \
  | grep . | sed 's#^[^,]*/##' | sort -t, -k2,2r > "$ALL" || true

TOTAL="$(grep -c . "$ALL" || true)"
echo "▶ versions BEFORE: ${TOTAL:-0}"
if [ "${TOTAL:-0}" -eq 0 ]; then
  echo "  nothing listed. Either the repo is already empty of this image, or the"
  echo "  account cannot read it — check the project above."
  exit 0
fi

# KEEP arm 1: the newest N, whatever their age.
head -n "$KEEP_NEWEST" "$ALL" | cut -d, -f1 > "$KEEP"

# KEEP arm 3: what is actually serving, and whatever :latest points at.
SERVING="$(gcloud run services describe "$SERVICE" --region="$REGION" \
  --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
REV="$(gcloud run services describe "$SERVICE" --region="$REGION" \
  --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)"
SERVING_DIGEST=""
case "$SERVING" in
  *@sha256:*) SERVING_DIGEST="sha256:${SERVING##*@sha256:}" ;;
  *) [ -n "$SERVING" ] && SERVING_DIGEST="$(digest_of "$SERVING")" ;;
esac
if [ -z "$SERVING_DIGEST" ] && [ -n "$REV" ]; then
  SERVING_DIGEST="$(gcloud run revisions describe "$REV" --region="$REGION" \
    --format='value(status.imageDigest)' 2>/dev/null | sed 's#.*@##' || true)"
fi
LATEST_DIGEST="$(digest_of "${IMAGE}:latest")"
# `:live` FOLLOWS THE ROLLOUT, `:latest` follows the BUILD. The deploy moves
# :live onto the image it actually rolled out (nangijala-deploy.yml), so this
# is the one tag that names what the service boots from — and the server-side
# policy keeps it by the same name.
LIVE_DIGEST="$(digest_of "${IMAGE}:live")"
echo "▶ Cloud Run serves: ${SERVING:-<unreadable>} -> ${SERVING_DIGEST:-<digest unreadable>}"
echo "▶ :latest is:       ${LATEST_DIGEST:-<none>}   (follows the BUILD)"
echo "▶ :live is:         ${LIVE_DIGEST:-<none>}   (follows the ROLLOUT — the boot image)"
if [ -z "$SERVING_DIGEST" ]; then
  echo "▶ could not read the serving digest — the newest-$KEEP_NEWEST rule alone"
  echo "  protects the boot image, which is the arm designed for exactly this."
fi
[ -n "$SERVING_DIGEST" ] && printf '%s\n' "$SERVING_DIGEST" >> "$KEEP"
[ -n "$LATEST_DIGEST" ]  && printf '%s\n' "$LATEST_DIGEST"  >> "$KEEP"
[ -n "$LIVE_DIGEST" ]    && printf '%s\n' "$LIVE_DIGEST"    >> "$KEEP"

CUTOFF="$(date -u -d "-${KEEP_DAYS} days" +%Y-%m-%dT%H:%M:%S 2>/dev/null \
  || date -u -v-"${KEEP_DAYS}"d +%Y-%m-%dT%H:%M:%S)"
echo "▶ age cutoff: ${CUTOFF}Z"

# THE ONE LINE WHERE A MISTAKE DELETES THE BOOT IMAGE. An empty keep file makes
# `grep -vxFf` protect NOTHING (no patterns match, so -v passes every line), and
# arm 1 can only be empty if the listing was — which the TOTAL check above
# already returned on. Assert it rather than reason about it.
if ! [ -s "$KEEP" ]; then
  echo "▶ refusing to delete: the keep set came out empty, which cannot happen" >&2
  echo "  with a non-empty listing. Nothing has been deleted." >&2
  exit 1
fi

# KEEP arm 2 is applied here: a row survives if its createTime sorts at or after
# the cutoff. Everything else, minus the KEEP set, is the delete list.
awk -F, -v cut="$CUTOFF" '$2 != "" && ($2 "") < (cut "") { print $1 }' "$ALL" \
  | grep -vxFf "$KEEP" > "$LIST" || true

N="$(grep -c . "$LIST" || true)"
echo "▶ $N versions are older than $KEEP_DAYS days and outside the keep set"
if [ "${N:-0}" -eq 0 ]; then
  echo "  nothing to do — already purged, or the policy's sweep beat us to it."
  echo
  echo "▶ size AFTER"; size_now
  exit 0
fi

if [ -n "$DRY_RUN" ]; then
  echo "▶ DRY RUN — these would go (first 20 shown):"
  head -20 "$LIST" | sed 's/^/    /'
  [ "$N" -gt 20 ] && echo "    ... and $((N - 20)) more"
  exit 0
fi

echo "▶ deleting, $PARALLEL in flight — one dot per 20 (errors on already-gone"
echo "  versions are normal and counted)"
# --delete-tags: a tagged version refuses to go without it. Every tag here is a
# build sha; :latest is excluded by name above, so nothing in this list wears it.
# The digest rides in as $1 rather than being pasted into the sh -c string, so a
# stray character in a version can never become shell syntax.
sed "s#^#${IMAGE}@#" "$LIST" \
  | xargs -r -P "$PARALLEL" -I{} \
      sh -c 'gcloud artifacts docker images delete "$1" --delete-tags --quiet >/dev/null 2>&1 && echo OK || echo FAIL' _ {} \
  | tee "$RES" \
  | awk '{ n++; if (n % 20 == 0) { printf "."; fflush() } } END { print "" }'

OK="$(grep -c '^OK$' "$RES" || true)"
BAD="$(grep -c '^FAIL$' "$RES" || true)"
echo "▶ deleted ${OK:-0}, failed ${BAD:-0}"

AFTER="$(gcloud artifacts docker images list "$IMAGE" --format='value(version)' \
  --limit=100000 2>/dev/null | grep -c . || true)"
echo
echo "▶ versions BEFORE: ${TOTAL:-0}"
echo "▶ versions AFTER:  ${AFTER:-0}      <- this is the proof; it moved now"
echo
echo "▶ size AFTER (expect this to still read high — Artifact Registry frees a"
echo "   shared layer only once nothing references it, over the next hours)"
size_now

echo
echo "✅ purge done. games2/deploy/ar-cleanup.sh's server-side policy keeps it"
echo "   this way; .github/workflows/ar-watch.yml checks both every morning."
