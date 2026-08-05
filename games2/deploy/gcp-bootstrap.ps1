# One-time GCP bootstrap for deploying Nangijala to Cloud Run via GitHub Actions.
# PowerShell twin of gcp-bootstrap.sh (run whichever matches your shell).
#
# Usage (PowerShell, from games/nangijala):
#   .\deploy\gcp-bootstrap.ps1 -ProjectId your-gcp-project
#
# Idempotent-ish: re-running mostly no-ops; "already exists" errors are fine.
# When it finishes, set the printed values as GitHub repo *Variables*
# (Settings -> Secrets and variables -> Actions -> Variables) and push to main —
# .github/workflows/nangijala-deploy.yml does the rest.

param(
  [Parameter(Mandatory = $true)] [string]$ProjectId,
  [string]$Region = "europe-north1",          # Finland — closest to Sweden
  [string]$ArRepo = "nangijala",              # Artifact Registry docker repo
  [string]$ServiceName = "nangijala",         # Cloud Run service name
  [string]$DeploySa = "nangijala-deployer",   # service account for CI deploys
  [string]$Pool = "github-pool",              # Workload Identity pool
  [string]$Provider = "github-provider",      # Workload Identity provider
  [string]$GithubRepo = "mikael-floden/pixel" # owner/repo allowed to deploy
)

$ErrorActionPreference = "Continue"  # "already exists" is expected on re-runs

Write-Host "> project=$ProjectId region=$Region repo=$GithubRepo"
gcloud config set project $ProjectId
$ProjectNumber = gcloud projects describe $ProjectId --format='value(projectNumber)'
if (-not $ProjectNumber) { Write-Error "Could not read project '$ProjectId' — check the ID (gcloud projects list)"; exit 1 }

Write-Host "> enabling APIs"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

Write-Host "> Artifact Registry repo"
gcloud artifacts repositories create $ArRepo --repository-format=docker --location=$Region --description="Nangijala container images"

Write-Host "> deploy service account"
gcloud iam service-accounts create $DeploySa --display-name="Nangijala CI deployer"
$SaEmail = "$DeploySa@$ProjectId.iam.gserviceaccount.com"

Write-Host "> granting the deployer the roles it needs"
foreach ($role in @("roles/run.admin", "roles/artifactregistry.writer", "roles/iam.serviceAccountUser")) {
  gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$SaEmail" --role=$role --condition=None | Out-Null
}

Write-Host "> Workload Identity Federation (keyless GitHub -> GCP auth)"
gcloud iam workload-identity-pools create $Pool --location=global --display-name="GitHub pool"
gcloud iam workload-identity-pools providers create-oidc $Provider `
  --location=global --workload-identity-pool=$Pool `
  --display-name="GitHub provider" `
  --issuer-uri="https://token.actions.githubusercontent.com" `
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" `
  --attribute-condition="assertion.repository=='$GithubRepo'"

# Let the GitHub repo impersonate the deploy SA through the pool.
$PoolId = "projects/$ProjectNumber/locations/global/workloadIdentityPools/$Pool"
gcloud iam service-accounts add-iam-policy-binding $SaEmail `
  --role=roles/iam.workloadIdentityUser `
  --member="principalSet://iam.googleapis.com/$PoolId/attribute.repository/$GithubRepo"

$ProviderResource = "$PoolId/providers/$Provider"

Write-Host ""
Write-Host "=================================================================="
Write-Host "Bootstrap complete. Set these as GitHub repo VARIABLES"
Write-Host "(Settings -> Secrets and variables -> Actions -> Variables):"
Write-Host ""
Write-Host "  GCP_PROJECT_ID   = $ProjectId"
Write-Host "  GCP_REGION       = $Region"
Write-Host "  GCP_AR_REPO      = $ArRepo"
Write-Host "  GCP_SERVICE      = $ServiceName"
Write-Host "  GCP_WIF_PROVIDER = $ProviderResource"
Write-Host "  GCP_DEPLOY_SA    = $SaEmail"
Write-Host ""
Write-Host "Then run the 'nangijala deploy' workflow (GitHub -> Actions) or push"
Write-Host "to main. Map the domain once the first deploy is live:"
Write-Host ""
Write-Host "  gcloud beta run domain-mappings create --service=$ServiceName --domain=nangijala.online --region=$Region"
Write-Host ""
Write-Host "and add the DNS records it prints to Namecheap."
Write-Host "=================================================================="
