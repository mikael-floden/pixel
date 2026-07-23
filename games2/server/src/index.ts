import { createServer } from "http";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ROOM_NAME } from "@nangijala/shared";
import { WorldRoom } from "./rooms/WorldRoom.js";

const PORT = Number(process.env.PORT || 2567);
// server/src/index.ts → GAME_ROOT is pixel/games2; the art domains are
// one more level up at the repo root. ASSETS_ROOT can be overridden (Docker).
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SRC_DIR, "..", "..");
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(GAME_ROOT, "..");
const ASSET_DOMAINS = [
  "characters", "tiles", "maps", "objects", "characters2", "tiles2", "maps2",
  "sounds", "music", "monsters",
];

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));
// Deployed build id — clients poll this to detect a newer deploy and prompt a
// refresh (see client/src/main.ts).
app.get("/version", (_req, res) =>
  res.setHeader("Cache-Control", "no-store").json({ sha: process.env.GIT_SHA || "dev" }),
);

// Production single-origin serving: built client + art assets on one host/port
// as the WebSocket world server (see client/src/net.ts).
const clientDist = join(GAME_ROOT, "client", "dist");
const serveClient = process.env.SERVE_CLIENT === "1" || existsSync(clientDist);

// Cache policy so a PLAIN refresh (F5) always picks up a new deploy:
// - anything unhashed that changes across deploys (html, json manifests like
//   characters.json / world.json) → no-cache: the browser revalidates on every
//   load and gets fresh content the moment a deploy changes it (cheap 304s
//   otherwise);
// - Vite's content-hashed bundles → immutable, cache for a year;
// - art (tiles/characters PNGs) → no-cache too. The path LOOKS content-hashed
//   (…/base_x_2_161302781/…), but the art agents routinely edit a tile
//   IN-PLACE (same path, new pixels — e.g. tiles2 softening edges), so a long
//   cache served the OLD art for up to an hour after a deploy. Revalidate
//   instead: a plain refresh always shows the latest art (unchanged tiles are
//   cheap 304s via ETag/Last-Modified).
function setCacheHeaders(res: express.Response, path: string) {
  if (/-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(path)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
}

if (serveClient) {
  for (const domain of ASSET_DOMAINS) {
    app.use(
      `/assets/${domain}`,
      express.static(join(ASSETS_ROOT, domain), { maxAge: "1h", setHeaders: setCacheHeaders }),
    );
  }
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist, { setHeaders: setCacheHeaders }));
    // SPA fallback for any non-API, non-asset route.
    app.get(/^(?!\/(assets|health|matchmake)).*/, (_req, res) =>
      res.sendFile(join(clientDist, "index.html"), { headers: { "Cache-Control": "no-cache" } }),
    );
    console.log(`[nangijala] serving built client from ${clientDist}, assets from ${ASSETS_ROOT}`);
  }
}

const gameServer = new Server({
  greet: false, // suppress the big Colyseus ASCII banner on start
  transport: new WebSocketTransport({ server: createServer(app) }),
});

// One WorldRoom per maps2 world: filterBy 'world' so joinOrCreate matches
// players who picked the SAME world into one shared room, and spins up a
// separate room (with that world's own grid) for each different selection.
gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world"]);

gameServer
  .listen(PORT)
  .then(() => console.log(`[nangijala] world server listening on ws://localhost:${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
