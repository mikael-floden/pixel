# Deploying Nangijala (GCP)

Single-origin: one container serves the built client, the art assets, and the
Colyseus WebSocket world on one port. Domain: **nangijala.online**.

## Recommended: a small Compute Engine VM in `europe-north1` (Finland)

Closest GCP region to Sweden (~10–20 ms). A stateful WebSocket game wants a
long-lived process, so a VM fits better than Cloud Run.

### 1. Create the VM (once)
```bash
gcloud compute instances create nangijala \
  --zone=europe-north1-a \
  --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --tags=http-server,https-server
gcloud compute addresses create nangijala-ip --region=europe-north1   # static IP
# Attach the static IP, then point nangijala.online's A record at it (Namecheap).
gcloud compute firewall-rules create allow-web \
  --allow=tcp:80,tcp:443 --target-tags=http-server,https-server
```

### 2. On the VM: build + run
```bash
sudo apt-get update && sudo apt-get install -y docker.io git
git clone https://github.com/mikael-floden/pixel.git && cd pixel
# Build the game image FROM THE REPO ROOT (needs the sibling art domains):
sudo docker build -f games/nangijala/Dockerfile -t nangijala .
sudo docker run -d --restart unless-stopped -p 8080:8080 --name nangijala nangijala
```

### 3. TLS + domain (Caddy auto-HTTPS, in front of the container)
`deploy/Caddyfile` reverse-proxies `nangijala.online` → the container and gets a
Let's Encrypt cert automatically (WebSockets pass through unchanged):
```bash
sudo docker run -d --restart unless-stopped --network host \
  -v $PWD/games/nangijala/deploy/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data caddy:2
```
Now `https://nangijala.online` serves the game; the client connects `wss://`
same-origin automatically (see `client/src/net.ts`).

## Updating
```bash
cd pixel && git pull
sudo docker build -f games/nangijala/Dockerfile -t nangijala . \
  && sudo docker rm -f nangijala \
  && sudo docker run -d --restart unless-stopped -p 8080:8080 --name nangijala nangijala
```

## Scaling later (still GCP, no migration)
1. Resize the VM (bigger `machine-type`).
2. Split the static client to a bucket + Cloud CDN; VM handles only WS.
3. Multiple instances behind a GCP HTTPS Load Balancer (it proxies WebSockets) +
   **Memorystore (Redis)** for Colyseus presence/matchmaking across instances.
4. GKE if you want orchestration / multi-region.

## Alternative: Cloud Run
Works with `min-instances=1`, session affinity on, WS timeout raised — but for an
always-warm stateful WS server it isn't cheaper than a small VM and adds a
single-instance/affinity caveat. Prefer the VM to start.
