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
# Tiles 3.0 review set — the 3rd-generation tile system, in development alongside
# tiles2 (which is unaffected and still what the game renders). Only the reviewable
# output is tracked (~200 KB of lossless WebP + manifest); tiles/matrix is
# gitignored so the raw candidate sheets never enter the build context. Added by
# the tiles agent 2026-08-17 with the maintainer's explicit go-ahead, so the wiki
# can show each candidate before and after postprocess. — see coordination/tiles.json
COPY tiles/ tiles/
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

# ----------------------------------------------------------------- build ----
# EVERYTHING that is only needed to PRODUCE the artefacts lives here and is
# thrown away: the full npm ci (phaser alone is 148 MB), typescript, vite,
# esbuild, playwright. Measured 2026-08-15: the old single-stage image kept all
# of it at runtime — 258 MB of node_modules of which 36 MB is actually used to
# serve the game, plus a ~200 MB base. The art split we did first was real but
# it was never where the weight was.
FROM node:22-slim AS build
WORKDIR /app

COPY games2/package.json games2/package-lock.json ./
COPY games2/shared/package.json shared/
COPY games2/server/package.json server/
COPY games2/client/package.json client/
RUN npm ci

# Curated art — the manifests and the wiki registry are rebuilt FROM this root,
# which is what keeps staging content out of every generated list.
COPY --from=curate /shipped/ /assets/
ENV ASSETS_ROOT=/assets

COPY games2/ ./
COPY --from=curate /src/games2/client/public/shipset.json client/public/shipset.json

# Committed tile atlases are only ever VERIFIED at deploy, never rebuilt (that
# is what stops the packing job repeating on every push). A stale one is
# pruned so the client falls back to per-file tiles; --ship also drops atlases
# for worlds this image does not publish.
RUN ASSETS_ROOT=/assets node scripts/check-atlas.mjs --prune --strict --ship

ARG GIT_SHA=dev
ENV VITE_GIT_SHA=$GIT_SHA

# Wiki registry from the art baked into THIS image, so it can never go stale
# against the deployed art. Never let a wiki hiccup brick the game deploy.
RUN node /assets/wiki/build.mjs --games2 /app || echo "[wiki] build failed; shipping committed data.json"
RUN npm run build:client

# --------------------------------------------------------------- runtime ----
# Alpine + PROD DEPS ONLY. What actually serves the game: @colyseus/*, express,
# compression and tsx (which runs the TypeScript server directly) — 36 MB,
# against 258 MB before. phaser and colyseus.js are vite-BUNDLED into the
# client JS, so they are devDependencies now and never reach this stage.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY games2/package.json games2/package-lock.json ./
COPY games2/shared/package.json shared/
COPY games2/server/package.json server/
COPY games2/client/package.json client/
RUN npm ci --omit=dev && npm cache clean --force

# The server runs TypeScript straight from source via tsx, so shared/ and
# server/ ship as SOURCE — no build output to copy.
COPY games2/shared/ shared/
COPY games2/server/ server/
# The built client bundle only — not client/src, not node_modules.
COPY --from=build /app/client/dist client/dist
# Curated art. composer/ is deliberately ABSENT: 94 MB that only the wiki's
# sound and music pages play, now fetched from the repo (wiki.js resolves
# composer/** against the CDN), so no player carries it.
COPY --from=curate /shipped/ /assets/
# …AND THE WIKI REGISTRY BUILT FROM THIS IMAGE'S OWN ART. The build stage runs
# wiki/build.mjs against its own /assets (see it above), but the runtime copies
# /assets from CURATE, so that output was discarded on every deploy and the
# deployed wiki served the data.json last COMMITTED — including its `git_sha`,
# which is the version stamp in the wiki's header. Measured 2026-08-17: the
# live stamp read a commit six pushes and three hours old, so the one thing
# telling the Game Master which build he is looking at named the wrong build.
COPY --from=build /assets/wiki/site/data.json /assets/wiki/site/data.json
ENV ASSETS_ROOT=/assets

ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
ENV SERVE_CLIENT=1
ENV PORT=8080
EXPOSE 8080

# tsx (a server dependency) runs the TypeScript server directly.
CMD ["npm", "run", "start", "-w", "server"]
