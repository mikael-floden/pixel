#!/usr/bin/env bash
# One-time setup for the nightly repo backup bucket (.github/workflows/backup-gcs.yml).
#
# HOW TO RUN — from a PHONE, deliberately (the maintainer has no laptop, and
# this script's original "run it on your machine" instruction is exactly why it
# was never run: the nightly backup then failed silently from 2026-08-15 to
# 2026-08-17, three nights with no backup at all while the workflow existed and
# looked healthy).
#
#   1. Open https://shell.cloud.google.com in the phone browser (or the Google
#      Cloud app's Cloud Shell) — already authenticated, already knows the
#      project.
#   2. Paste ONE line:
#
#        curl -sS https://raw.githubusercontent.com/mikael-floden/pixel/main/.github/gcs-backup-bootstrap.sh | bash
#
#      Nothing to fill in. Override with PROJECT_ID=… / REGION=… / BUCKET=…
#      before `bash` only if the defaults below are wrong.
#
# There is NOTHING to do afterwards: the workflow derives the same bucket name
# this script creates, so no repo variable has to be set by hand.
#
# There are NO credentials to create or store: the deploy service account and
# the Workload Identity Federation trust that games2/deploy/gcp-bootstrap.sh
# already set up are reused as-is. This only creates a bucket and grants that
# existing identity the narrowest useful access to it.
#
# THE BACKUPS ARE APPEND-ONLY FROM CI, deliberately. The SA gets objectCreator
# + objectViewer on this bucket and NOT objectAdmin, so it can write a new
# snapshot and read one back to verify — but it cannot delete or overwrite any
# existing backup. A compromised deploy pipeline can therefore add junk, never
# destroy history. Deletion is left entirely to the bucket's own lifecycle
# rule, which nothing in CI can reach.
set -euo pipefail

# PROJECT: derived, never prompted — Cloud Shell exports DEVSHELL_PROJECT_ID,
# and `|| true` keeps `set -e` from killing the script on a failed lookup
# (the ar-cleanup.sh lesson).
PROJECT_ID="${PROJECT_ID:-${DEVSHELL_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}}"
if [ -z "$PROJECT_ID" ]; then
  echo "No project found. Re-run as:  PROJECT_ID=your-project bash gcs-backup-bootstrap.sh" >&2
  exit 1
fi
REGION="${REGION:-europe-north1}"                  # match the Cloud Run region
DEPLOY_SA="${DEPLOY_SA:-nangijala-deployer}"       # the EXISTING deploy SA
BUCKET="${BUCKET:-${PROJECT_ID}-nangijala-backups}" # bucket names are global
KEEP_DAYS="${KEEP_DAYS:-30}"

SA_EMAIL="${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
echo "▶ project=$PROJECT_ID region=$REGION bucket=$BUCKET keep=${KEEP_DAYS}d"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "▶ bucket"
# NEARLINE: ~half the price of Standard, and its 30-day minimum storage
# duration exactly matches the lifecycle below, so nothing is ever deleted
# early enough to incur an early-deletion charge. Backups are written once and
# read approximately never, which is the access pattern Nearline is priced for.
# public-access-prevention is non-negotiable on a bucket holding the whole repo.
gcloud storage buckets create "gs://${BUCKET}" \
  --location="$REGION" \
  --default-storage-class=NEARLINE \
  --uniform-bucket-level-access \
  --public-access-prevention \
  2>/dev/null || echo "  (already exists — continuing)"

echo "▶ lifecycle: delete objects older than ${KEEP_DAYS} days"
# Age-based, not keep-newest-N, because CI has no delete rights by design.
# Worth knowing the failure mode: if backups stopped uploading for ${KEEP_DAYS}
# days straight, the last one would age out and the bucket would empty. GitHub
# emails on workflow failure, and 30 days of ignored daily failures is the real
# precondition — accepted in exchange for backups CI cannot destroy.
LIFECYCLE="$(mktemp)"
cat > "$LIFECYCLE" <<JSON
{"rule":[{"action":{"type":"Delete"},"condition":{"age":${KEEP_DAYS}}}]}
JSON
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file="$LIFECYCLE"
rm -f "$LIFECYCLE"

echo "▶ granting the EXISTING deploy SA append-only access to this bucket"
# Bucket-scoped, not project-scoped: this grant says nothing about any other
# bucket. objectCreator = write new objects. objectViewer = read them back so
# the workflow can verify the upload really landed. No delete role, ever.
for role in roles/storage.objectCreator roles/storage.objectViewer; do
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${SA_EMAIL}" --role="$role" >/dev/null
  echo "  ${role}"
done

cat <<EOF

✅ done.

NOTHING ELSE TO SET. The workflow derives this exact bucket name
(\${PROJECT_ID}-nangijala-backups) on its own; the GCS_BACKUP_BUCKET repo
variable is now only an override for a bucket somewhere else.

No secrets. The workflow authenticates through the same keyless Workload
Identity Federation the deploy already uses.

Verify now: Actions → "backup to gcs" → Run workflow. It runs nightly anyway.

Restore later with:
   gcloud storage ls gs://${BUCKET}
   gcloud storage cp gs://${BUCKET}/<name>.zip .
EOF
