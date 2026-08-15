# Nangijala — single-image deploy. Serves the built client + art assets + the
# Colyseus WebSocket world on ONE port.
#
# BUILD FROM THE REPO ROOT (needs the sibling art domains):
#   docker build -f games2/Dockerfile -t nangijala .
#   docker run -p 8080:8080 nangijala        # → http://localhost:8080
# ---------------------------------------------------------------- curate ----
# THE CONTAINER SPLIT (maintainer 2026-08-14: "the content that is not in the
# game doesn't have to be part of the built container"). The art domains are
# autonomous factories that generate far more than the game uses — scenery
# ships 2,644 files of which the game reads THREE. This stage computes the
# reachable set from games2/config/publish.json and materialises ONLY that.
#
# Measured: 212.7 MB of art on disk → 57.4 MB in the image.
#
# It also filters everything downstream for free, which is the real reason it
# is a stage and not a .dockerignore edit: the final image rebuilds every
# manifest from ASSETS_ROOT (`npm run build:client` → `npm run manifest`) and
# rebuilds the wiki registry from the same root, so worlds.json lists only
# published worlds, monsters.json only reachable monsters, and the wiki's
# public data.json only in-game entities. The client is never TOLD staging
# content exists, so a normal player cannot list or request it.
#
# CACHING: this stage's inputs are the art domains + the policy + the script.
# An art-only push re-runs it (a few seconds of hard-links), but the per-domain
# `COPY --from=curate` lines below are content-addressed, so a domain whose
# curated output is byte-identical contributes an identical layer and uploads
# nothing.
FROM node:22-slim AS curate
WORKDIR /src
# Policy + script first: they change far less often than the art, and putting
# them above the art COPYs keeps this layer cached across art pushes.
COPY games2/config/publish.json games2/config/publish.json
COPY games2/scripts/shipset.mjs games2/scripts/shipset.mjs
COPY scenery/ scenery/
COPY characters2/ characters2/
COPY tiles2/ tiles2/
COPY maps2/ maps2/
COPY sounds/ sounds/
COPY music/ music/
COPY monsters/ monsters/
COPY items/ items/
COPY lore/ lore/
COPY wiki/ wiki/
COPY live/ live/
# --check fails the BUILD on a reachable-but-missing file, which is the one
# error that would otherwise become a silent 404 in production.
# --write also emits the COMPACT shipset.json (digest + per-domain stats, ~2 KB)
# computed from the FULL tree — the authoritative digest, which the copy in the
# final image below serves. Computing it here rather than in the final image
# matters: by then ASSETS_ROOT is already the curated root, so a digest derived
# there would describe the output rather than the decision that produced it.
RUN ASSETS_ROOT=/src node games2/scripts/shipset.mjs --emit /shipped --check --report --write

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

# Art assets, CURATED — only what the published worlds can actually reach.
# Still one layer per domain (not a single COPY of /shipped) so an active
# domain re-uploads tens of MB rather than all art, exactly as before the split.
COPY --from=curate /shipped/scenery/ /assets/scenery/
COPY --from=curate /shipped/characters2/ /assets/characters2/
COPY --from=curate /shipped/tiles2/ /assets/tiles2/
COPY --from=curate /shipped/maps2/ /assets/maps2/
COPY --from=curate /shipped/sounds/ /assets/sounds/
COPY --from=curate /shipped/music/ /assets/music/
COPY --from=curate /shipped/monsters/ /assets/monsters/
COPY --from=curate /shipped/items/ /assets/items/
COPY --from=curate /shipped/lore/ /assets/lore/
COPY --from=curate /shipped/wiki/ /assets/wiki/
# The composer's foley takes and music beds — the wiki's sound-effect and
# music pages play them. Only these two folders; the engine sources are not
# assets. The beds are ~18 MB and the client bundles its own copies for the
# in-world score, so this is a deliberate second copy: without it the wiki
# lists five generated tracks it cannot play (maintainer 2026-08-06).
# foley/ is copied WHOLE, `<set>/pool/` included (~8 MB of the ~21). Those are
# the 91 generated recordings the composer scored but did not pick, and the
# wiki now lets the Game Master audition and cast them — excluding them here
# (or in .dockerignore) 404s every one in the deployed wiki.
COPY games2/composer/foley/ /assets/composer/foley/
COPY games2/composer/music/ /assets/composer/music/
# live/ = runtime tuning/feedback state. The baked copy is only the BOOT
# FALLBACK — the server fetches the current live/** from GitHub main at boot
# and on every live-notify ping (pushes to live/** do NOT redeploy).
COPY live/ /assets/live/
ENV ASSETS_ROOT=/assets

# Game source (changes every deploy — keep below the art layers).
COPY games2/ ./

# The ship-set summary, from the curate stage's FULL-tree computation. It is
# gitignored (generated) so the COPY above cannot carry it, and `npm run
# manifest` does not build it — without this line /shipset.json falls through
# to the SPA's index.html and parses as HTML, which is exactly what production
# served on the first curated deploy. Must land BEFORE build:client, since vite
# copies client/public into the bundle.
COPY --from=curate /src/games2/client/public/shipset.json client/public/shipset.json

# THE ATLAS PRUNE GUARD. The committed tile atlases (client/public/atlases,
# built by scripts/build-atlas.py, content-addressed by a digest over the tile
# list AND every tile's bytes) are only ever VERIFIED at deploy — never built,
# which is what keeps the packing work from being redone on every push. A
# stale atlas (tiles2 regenerated a tile in place, or a world's set changed)
# is DELETED here, so the client's index fetch 404s and it falls back to
# individual tiles: slower, never wrong pixels, never a red pipeline. --strict
# because in THIS context /assets is the curated full set, so an absent tile
# really is absent.
RUN ASSETS_ROOT=/assets node scripts/check-atlas.mjs --prune --strict

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
