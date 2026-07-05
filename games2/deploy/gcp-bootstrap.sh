#!/usr/bin/env bash
# One-time GCP bootstrap for deploying Nangijala to Cloud Run via GitHub Actions.
#
# Run this ONCE on your machine (needs `gcloud` + Owner on the project). It is
# idempotent-ish: re-running mostly no-ops, but it will print "already exists"
# errors you can ignore. After it finishes, set the printed values as GitHub
# repo *Variables* (Settings → Secrets and variables → Actions → Variables) and
# push to main — `.github/workflows/nangijala-deploy.yml` does the rest.
#
#   PROJECT_ID=your-project ./deploy/gcp-bootstrap.sh
#
# Everything is cheap: Cloud Run scales to zero, Artifact Registry stores one
# small-ish image. No always-on cost during development.
set -euo pipefail

# --- knobs (override via env) ------------------------------------------------
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID=your-gcp-project}"
REGION="${REGION:-europe-north1}"           # Finland — closest to Sweden
AR_REPO="${AR_REPO:-nangijala}"             # Artifact Registry docker repo
SERVICE_NAME="${SERVICE_NAME:-nangijala}"   # Cloud Run service name
DEPLOY_SA="${DEPLOY_SA:-nangijala-deployer}" # service account for CI deploys
POOL="${POOL:-github-pool}"                 # Workload Identity pool
PROVIDER="${PROVIDER:-github-provider}"     # Workload Identity provider
GITHUB_REPO="${GITHUB_REPO:-mikael-floden/pixel}" # owner/repo allowed to deploy
# ----------------------------------------------------------------------------

echo "▶ project=$PROJECT_ID region=$REGION repo=$GITHUB_REPO"
gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

echo "▶ enabling APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com

echo "▶ Artifact Registry repo"
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker --location="$REGION" \
  --description="Nangijala container images" || true

echo "▶ deploy service account"
gcloud iam service-accounts create "$DEPLOY_SA" \
  --display-name="Nangijala CI deployer" || true
SA_EMAIL="${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "▶ granting the deployer the roles it needs"
for role in \
  roles/run.admin \
  roles/artifactregistry.writer \
  roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" --role="$role" --condition=None >/dev/null
done

echo "▶ Workload Identity Federation (keyless GitHub → GCP auth)"
gcloud iam workload-identity-pools create "$POOL" \
  --location=global --display-name="GitHub pool" || true
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --location=global --workload-identity-pool="$POOL" \
  --display-name="GitHub provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${GITHUB_REPO}'" || true

# Let the GitHub repo impersonate the deploy SA through the pool.
POOL_ID="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${GITHUB_REPO}"

PROVIDER_RESOURCE="${POOL_ID}/providers/${PROVIDER}"

cat <<EOF

✅ Bootstrap complete. Set these as GitHub repo **Variables**
   (Settings → Secrets and variables → Actions → Variables):

   GCP_PROJECT_ID   = ${PROJECT_ID}
   GCP_REGION       = ${REGION}
   GCP_AR_REPO      = ${AR_REPO}
   GCP_SERVICE      = ${SERVICE_NAME}
   GCP_WIF_PROVIDER = ${PROVIDER_RESOURCE}
   GCP_DEPLOY_SA    = ${SA_EMAIL}

Then push to main (or run the workflow manually) and the game deploys to
Cloud Run. Map the domain once the first deploy is live:

   gcloud beta run domain-mappings create --service=${SERVICE_NAME} \\
     --domain=nangijala.online --region=${REGION}

and add the CNAME/A records it prints to Namecheap DNS.
EOF
