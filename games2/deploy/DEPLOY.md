# Deploying Nangijala (GCP)

Single-origin: **one container** serves the built client, the art assets, and
the Colyseus WebSocket world on one port. Domain: **nangijala.online**.

## Current setup: Cloud Run + push-to-deploy

- **Scales to zero** — an instance only exists while someone is playing.
- **Managed HTTPS + domain mapping** — no VM, no Caddy to run.
- **`--cpu 2`** — Node is single-threaded, so the second core does not make the
  20 Hz world loop faster; it moves what contends with it off the loop's core
  (the GC, and libuv's threadpool, where brotli and the asset reads run). It
  buys headroom against the loopLag *max*, never the mean.
- **`--memory 2Gi`** — 16 warm zone rooms on one shared terrain grid are
  ~400 MB in dev; 512 MiB left no headroom (see `games2/docs/backend.md`), and
  1 GiB was the TIGHTER of the two resources: 643 MB of 1024 MB against 19.2%
  of one core, measured 2026-09-22 with zero players. An OOM kills the world
  where CPU saturation only slows it, and a GiB-second costs a ninth of a
  vCPU-second.
- **`NODE_OPTIONS=--max-old-space-size=1200`, and it must move whenever
  `--memory` moves.** V8 DOES NOT READ THE CONTAINER LIMIT. Measured
  2026-09-22, node 22.22.2 inside a cgroup capped at 900 MiB:
  `process.constrainedMemory()` answered 900 MiB and `v8.heap_size_limit`
  answered **8204 MiB** — Node sees the cap, V8 ignores it and sizes old space
  at ~half the *host's* RAM. A heap ceiling above the container is not a slow
  leak, it is an **OOM kill**: V8 never reaches the pressure that would make it
  collect hard, so the kernel arrives first and the world dies with nothing in
  the log about memory. 1200 of 2048 is under the usual 75% on purpose — the
  whole process was 643 MB of rss when this was set, so 848 MiB is left for
  what the ceiling does *not* govern (terrain grid, art buffers, brotli).
  `/api/stats` now carries the heap/native split (`perfStats`' `mem` block:
  `limitMb`, `nativeMb`, `constrainedMb`), so the next move on this number is a
  read of production rather than another guess. `limitMb > constrainedMb` on a
  live read is the dangerous state.
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

**Artifact Registry retention** is one rule in three places, all saying *keep
the newest 15 versions, delete anything over 2 days*.

**The window is the only lever on this bill.** The repo converges on
`retention x push rate x size per version`, and all three are measured
(2026-09-23): 14 days x ~88 image builds a day x 425 MB = **490 GB**, which is
exactly what sat there. It was never a leak and the policy was never broken —
a manual purge on top of it found *eight* versions to take, because the policy
had already swept the rest. Cross-check: 1229 commits in those 14 days touch a
path that builds an image, against 1154 versions in the registry. At 2 days
that is ~176 rollback points and ~70 GB (≈ kr 43/mo against kr 304); the image
rebuilds from any commit, and the backup is `backup-gcs.yml`, never this
registry.

- `deploy/ar-cleanup.sh` attaches it as a **server-side cleanup policy** — the
  permanent answer, no CI job and no credentials. It sweeps asynchronously, so
  it proves nothing on the day it is pasted.
- `deploy/ar-purge.sh` applies the same rule **by hand, now** (its `KEEP_DAYS`
  must stay in step with the policy's window — one rule, two hands), and prints the
  version count before and after. Use it when the space is wanted today.
  (`DRY_RUN=1` lists without deleting. The VERSION COUNT is the proof; the
  repository SIZE lags hours, because Artifact Registry frees a shared layer
  only once nothing references it.)
- `.github/workflows/ar-watch.yml` reads the repo every morning and fails if the
  policy is gone or the size is over 120 GB (~1.7x the derived steady state).

Both scripts are one Cloud-Shell paste with nothing to fill in, and both keep
the newest 15 **whatever their age**. That arm is load-bearing, not decoration:
the service runs `--min-instances 0`, so a cold start pulls the image from this
repository, and an age-only rule deletes the image the world boots from the
first fortnight the fleet goes quiet. `deploy/ar-purge.test.sh` (in `npm test`,
1.6 s, no gcloud needed) runs the replaced age-only rule against exactly that
fixture and shows it taking the serving digest.

(The policy was written 2026-08-15 and had never once run, because the
documented phone paste died on a Cloud Shell that opens as "(no project)" — and
a commit a month earlier had declared that fixed without anyone executing it. In
those 38 unwatched days the repo grew 285 GB → 488 GB, 5.3 GB/day, and was the
only line on the bill going up. An ops paste is not fixed until it has been
executed; a one-off fix with no watcher silently stops being true.)

### 2. Deploy = push to main
`.github/workflows/nangijala-deploy.yml` builds the image (from the repo
root, so sibling art is baked in), pushes to Artifact Registry, and
`gcloud run deploy`s to `europe-north1` (Finland, ~10-20 ms from Sweden). It
runs on **push to `main`** touching `games2/**` OR any art domain the image
bakes (art pushes auto-deploy — maintainer decision 2026-07-17; every push
is its own run, and the rollout guard asks PRODUCTION whether it is already
past the commit — `games2/docs/shipping.md`, Deploy), plus **manual
dispatch**, which always rolls out. A parallel `test` job (typecheck + `npm test`) gates the
deploy — see `games2/docs/shipping.md` (Deploy) and `games2/SURFACES.md` for the
one gate an art push can trip.

Deploy by hand:
```bash
IMAGE=europe-north1-docker.pkg.dev/$PROJECT_ID/nangijala/nangijala
docker build -f games2/Dockerfile -t $IMAGE:manual .   # from repo root
docker push $IMAGE:manual
gcloud run deploy nangijala --image $IMAGE:manual --region europe-north1 \
  --allow-unauthenticated --port 8080 --min-instances 0 --max-instances 1 \
  --cpu 2 --memory 2Gi \
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

## Scaling (still GCP, no migration) — `games2/spec/ZONES.md`
The world is cut into zone rooms that talk over `server/src/bus.ts`; today
every room runs in this one instance with the in-process bus. Raising
`--max-instances` needs, in this order: a Memorystore (Redis) instance and
`REDIS_URL` on the service (the bus switches backend by that variable alone);
one Cloud Run service per zone group; an HTTPS load balancer whose URL map
sends `/z/<n>` to the service owning zone n; the matching route lines in
`games2/config/zones.json`. No Kubernetes; each step is a Cloud Shell
one-liner. Static client + assets can move to a bucket + Cloud CDN at any
point; Cloud Run keeps the WebSockets.

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
