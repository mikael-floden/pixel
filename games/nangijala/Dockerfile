# Nangijala — single-image deploy. Serves the built client + art assets + the
# Colyseus WebSocket world on ONE port.
#
# BUILD FROM THE REPO ROOT (needs the sibling art domains):
#   docker build -f games/nangijala/Dockerfile -t nangijala .
#   docker run -p 8080:8080 nangijala        # → http://localhost:8080
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching (needs every workspace manifest).
COPY games/nangijala/package.json games/nangijala/package-lock.json ./
COPY games/nangijala/shared/package.json shared/
COPY games/nangijala/server/package.json server/
COPY games/nangijala/client/package.json client/
RUN npm ci

# Game source.
COPY games/nangijala/ ./

# Art assets (sibling domains) baked in under a fixed ASSETS_ROOT.
COPY characters/ /assets/characters/
COPY tiles/ /assets/tiles/
COPY maps/ /assets/maps/
ENV ASSETS_ROOT=/assets

# Generate the character manifest + build the client bundle.
RUN npm run build:client

ENV NODE_ENV=production
ENV SERVE_CLIENT=1
ENV PORT=8080
EXPOSE 8080

# tsx (a dependency) runs the TypeScript server directly.
CMD ["npm", "run", "start", "-w", "server"]
