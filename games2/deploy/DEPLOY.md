# Deploying Nangijala (GCP)

Single-origin: **one container** serves the built client, the art assets, and
the Colyseus WebSocket world on one port. Domain: **nangijala.online**.

## Current setup: Cloud Run + push-to-deploy

- **Scales to zero** — an instance only exists while someone is playing.
- **Managed HTTPS + domain mapping** — no VM, no Caddy to run.
- **`--max-instances 1`** — one instance *is* the single shared world, so the
  "instances don't share state" caveat doesn't apply until we deliberately
  scale out (which needs Redis anyway — see *Scaling later*).

Trade-offs: ~1-2s cold start for the first visitor after idle; Cloud Run caps
a request (the WebSocket) at 60 min — the client just reconnects.

### 1. One-time bootstrap (run once, needs project Owner; use Cloud Shell —
the maintainer has no laptop)
```bash
cd games2
PROJECT_ID=your-gcp-project ./deploy/gcp-bootstrap.sh
```
Enables the APIs (Run, Artifact Registry, STS, IAM Credentials), creates the
AR repo, a deploy service account, and **Workload Identity Federation** so
GitHub Actions deploys **without any stored secret**. It prints values to set
as GitHub repo **Variables** (Settings → Secrets and variables → Actions →
Variables):

```
GCP_PROJECT_ID  GCP_REGION  GCP_AR_REPO  GCP_SERVICE  GCP_WIF_PROVIDER  GCP_DEPLOY_SA
```

Artifact Registry retention is a server-side cleanup policy
(`deploy/ar-cleanup.sh`, pasted once into Cloud Shell): keep newest 15
versions, delete >14 days. No CI job, no credentials.

### 2. Deploy = push to main
`.github/workflows/nangijala-deploy.yml` builds the image (from the repo
root, so sibling art is baked in), pushes to Artifact Registry, and
`gcloud run deploy`s to `europe-north1` (Finland, ~10-20 ms from Sweden). It
runs on **push to `main`** touching `games2/**` OR any art domain the image
bakes (art pushes auto-deploy — maintainer decision 2026-07-17; the
concurrency group collapses rapid pushes into the newest run), plus
**manual dispatch**. A parallel `test` job (typecheck + `npm test`) gates the
deploy — see `games2/CLAUDE.md` (Deploy) and `games2/SURFACES.md` for the
one gate an art push can trip.

Deploy by hand:
```bash
IMAGE=europe-north1-docker.pkg.dev/$PROJECT_ID/nangijala/nangijala
docker build -f games2/Dockerfile -t $IMAGE:manual .   # from repo root
docker push $IMAGE:manual
gcloud run deploy nangijala --image $IMAGE:manual --region europe-north1 \
  --allow-unauthenticated --port 8080 --min-instances 0 --max-instances 1 \
  --no-cpu-throttling --session-affinity --timeout 3600
```

### 3. Point the domain (once the first deploy is live)
```bash
gcloud beta run domain-mappings create --service=nangijala \
  --domain=nangijala.online --region=europe-north1
```
Add the records it prints to **Namecheap** DNS (apex → the mapping's A/AAAA;
`www` → CNAME `ghs.googlehosted.com`). The client connects `wss://`
same-origin automatically (`client/src/net.ts`) — no client config.

### State (later, still cheap)
Cloud Run's disk is ephemeral: the file-based `server/src/store.ts` resets on
each redeploy. When durable player state is wanted, the scale-to-zero-cheap
options are **Firestore** or a **GCS bucket** backing the store (~$0 at our
volume) — not an always-on Cloud SQL instance.

## Scaling later (still GCP, no migration)
1. Raise `--max-instances` **only** after adding **Memorystore (Redis)** for
   Colyseus presence/matchmaking — otherwise each instance is a separate
   world.
2. Split static client + assets to a bucket + Cloud CDN; Cloud Run handles
   WS.
3. GKE if orchestration / multi-region is ever wanted.

## Alternative: always-warm VM (no cold starts)
A small Compute Engine VM is a drop-in swap (~$13/mo even idle):
```bash
gcloud compute instances create nangijala \
  --zone=europe-north1-a --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --tags=http-server,https-server
gcloud compute addresses create nangijala-ip --region=europe-north1   # static IP
gcloud compute firewall-rules create allow-web \
  --allow=tcp:80,tcp:443 --target-tags=http-server,https-server
```
On the VM: Docker, build the image from the repo root, run on `8080`, put
**Caddy** (`deploy/Caddyfile`, auto-Let's-Encrypt) in front, point the A
record at the static IP. Older path; Cloud Run is preferred while small.
