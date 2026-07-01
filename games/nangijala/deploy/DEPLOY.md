# Deploying Nangijala (GCP)

Single-origin: **one container** serves the built client, the art assets, and the
Colyseus WebSocket world on one port. Domain: **nangijala.online**.

## Recommended for now: Cloud Run + push-to-deploy

Cheapest way to run in the real prod env during development:

- **Scales to zero** — you pay ~nothing while nobody is connected (fits in the
  free tier). An instance only exists while someone is playing.
- **Managed HTTPS + domain mapping** — no VM, no Caddy to run.
- **`--max-instances 1`** — one instance *is* our single shared world, so the
  "instances don't share state" caveat doesn't apply until we deliberately scale
  out (which needs Redis anyway — see *Scaling later*).

Trade-offs to know: ~1-2s cold start for the first visitor after idle, and Cloud
Run caps a request (the WebSocket) at 60 min — the client just reconnects.

### 1. One-time bootstrap (run once, needs `gcloud` + project Owner)
```bash
cd games/nangijala
PROJECT_ID=your-gcp-project ./deploy/gcp-bootstrap.sh
```
This enables the APIs (Run, Artifact Registry, STS, IAM Credentials), creates the
Artifact Registry repo, a deploy service account, and **Workload Identity
Federation** so GitHub Actions deploys **without any stored secret**. It prints
values to set as GitHub repo **Variables** (Settings → Secrets and variables →
Actions → Variables):

```
GCP_PROJECT_ID  GCP_REGION  GCP_AR_REPO  GCP_SERVICE  GCP_WIF_PROVIDER  GCP_DEPLOY_SA
```

### 2. Deploy = push to main
`.github/workflows/nangijala-deploy.yml` builds the image (from the repo root, so
sibling art is baked in), pushes it to Artifact Registry, and `gcloud run deploy`s
it to `europe-north1` (Finland, ~10-20 ms from Sweden). It runs on:
- **push to `main`** touching `games/nangijala/**` (game-code changes),
- a **daily schedule** and **manual dispatch** to roll in the latest baked-in art
  (the art loops push too often to redeploy on every art commit).

You can also deploy by hand:
```bash
IMAGE=europe-north1-docker.pkg.dev/$PROJECT_ID/nangijala/nangijala
docker build -f games/nangijala/Dockerfile -t $IMAGE:manual .   # from repo root
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
`www` → CNAME `ghs.googlehosted.com`). The client connects `wss://` same-origin
automatically (see `client/src/net.ts`), so no client config changes.

### State (later, still cheap)
Cloud Run's disk is ephemeral, so today's file-based `server/src/store.ts` resets
on each redeploy — fine for dev. When we want durable player state, the
scale-to-zero-cheap options are **Firestore** or a **GCS bucket** backing the
store (both ~$0 at our volume), not an always-on Cloud SQL instance.

## Scaling later (still GCP, no migration)
1. Raise `--max-instances` **only** after adding **Memorystore (Redis)** for
   Colyseus presence/matchmaking — otherwise each instance is a separate world.
2. Split the static client + assets to a bucket + Cloud CDN; Cloud Run handles WS.
3. GKE if you want orchestration / multi-region.

## Alternative: always-warm VM (no cold starts)
If cold starts ever annoy, a small Compute Engine VM is a drop-in swap (~$13/mo
even idle):
```bash
gcloud compute instances create nangijala \
  --zone=europe-north1-a --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --tags=http-server,https-server
gcloud compute addresses create nangijala-ip --region=europe-north1   # static IP
gcloud compute firewall-rules create allow-web \
  --allow=tcp:80,tcp:443 --target-tags=http-server,https-server
```
Then on the VM: install Docker, build the image from the repo root, run it on
`8080`, and put **Caddy** (`deploy/Caddyfile`, auto-Let's-Encrypt) in front. Point
`nangijala.online`'s A record at the static IP. This is the older path; Cloud Run
above is preferred while we're small.
