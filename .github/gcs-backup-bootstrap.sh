#!/usr/bin/env bash
# One-time setup for the nightly repo backup bucket (.github/workflows/backup-gcs.yml).
#
# Run ONCE on your machine (needs `gcloud` + Owner on the project):
#
#   PROJECT_ID=your-gcp-project ./.github/gcs-backup-bootstrap.sh
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

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID=your-gcp-project}"
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

Set ONE repo variable (Settings → Secrets and variables → Actions → Variables):

   GCS_BACKUP_BUCKET = ${BUCKET}

No secrets. The workflow authenticates through the same keyless Workload
Identity Federation the deploy already uses.

Then: Actions → "backup to gcs" → Run workflow.

Restore later with:
   gcloud storage ls gs://${BUCKET}
   gcloud storage cp gs://${BUCKET}/<name>.zip .
EOF
