# Nangijala — single-image deploy. Serves the built client + art assets + the
# Colyseus WebSocket world on ONE port.
#
# BUILD FROM THE REPO ROOT (needs the sibling art domains):
#   docker build -f games2/Dockerfile -t nangijala .
#   docker run -p 8080:8080 nangijala        # → http://localhost:8080
FROM node:22-slim

WORKDIR /app

# Layer order = change frequency (cheapest cache invalidation): deps almost
# never change; art domains change per-domain between deploys (each gets its
# OWN layer so one active domain re-uploads ~tens of MB, not all art); game
# SOURCE changes every deploy so it comes LAST — with BuildKit+registry-side
# layer dedup a code-only deploy uploads only the small source/build layers.
COPY games2/package.json games2/package-lock.json ./
COPY games2/shared/package.json shared/
COPY games2/server/package.json server/
COPY games2/client/package.json client/
RUN npm ci

# Art assets (sibling domains) baked in under a fixed ASSETS_ROOT.
COPY objects/ /assets/objects/
COPY characters2/ /assets/characters2/
COPY tiles2/ /assets/tiles2/
COPY maps2/ /assets/maps2/
COPY sounds/ /assets/sounds/
COPY music/ /assets/music/
COPY monsters/ /assets/monsters/
COPY items/ /assets/items/
COPY lore/ /assets/lore/
COPY wiki/ /assets/wiki/
# The composer's foley takes and music beds — the wiki's sound-effect and
# music pages play them. Only these two folders; the engine sources are not
# assets. The beds are ~18 MB and the client bundles its own copies for the
# in-world score, so this is a deliberate second copy: without it the wiki
# lists five generated tracks it cannot play (maintainer 2026-08-06).
COPY games2/composer/foley/ /assets/composer/foley/
COPY games2/composer/music/ /assets/composer/music/
# live/ = runtime tuning/feedback state. The baked copy is only the BOOT
# FALLBACK — the server fetches the current live/** from GitHub main at boot
# and on every live-notify ping (pushes to live/** do NOT redeploy).
COPY live/ /assets/live/
ENV ASSETS_ROOT=/assets

# Game source (changes every deploy — keep below the art layers).
COPY games2/ ./

# The deployed commit, baked into the bundle so testers can see which version
# they're running (bottom-left in-game + console) and into the wiki's build
# stamp (topbar, under the build date). Also exposed at runtime via GIT_SHA so
# /version lets clients detect a newer deploy and prompt a refresh. Declared
# BEFORE the wiki rebuild on purpose — the wiki build layer re-runs per deploy
# (a few seconds) so its stamp always matches the image.
ARG GIT_SHA=dev
ENV VITE_GIT_SHA=$GIT_SHA
ENV GIT_SHA=$GIT_SHA

# Rebuild the wiki's registry from the art baked into THIS image, so the
# in-game wiki (/assets/wiki/site/) can never go stale vs the deployed art.
# Never let a wiki build hiccup brick the game deploy — on failure the image
# ships the committed data.json instead.
RUN node /assets/wiki/build.mjs --games2 /app || echo "[wiki] build failed; shipping committed data.json"

# Build the client bundle.
RUN npm run build:client

ENV NODE_ENV=production
ENV SERVE_CLIENT=1
ENV PORT=8080
EXPOSE 8080

# tsx (a dependency) runs the TypeScript server directly.
CMD ["npm", "run", "start", "-w", "server"]
