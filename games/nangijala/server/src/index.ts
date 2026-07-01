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
// server/src/index.ts → GAME_ROOT is pixel/games/nangijala; the art domains are
// two more levels up at the repo root. ASSETS_ROOT can be overridden (Docker).
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SRC_DIR, "..", "..");
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(GAME_ROOT, "..", "..");
const ASSET_DOMAINS = ["characters", "tiles", "maps", "objects"];

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));

// Production single-origin serving: built client + art assets on one host/port
// as the WebSocket world server (see client/src/net.ts).
const clientDist = join(GAME_ROOT, "client", "dist");
const serveClient = process.env.SERVE_CLIENT === "1" || existsSync(clientDist);

if (serveClient) {
  for (const domain of ASSET_DOMAINS) {
    app.use(`/assets/${domain}`, express.static(join(ASSETS_ROOT, domain), { maxAge: "1h" }));
  }
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback for any non-API, non-asset route.
    app.get(/^(?!\/(assets|health|matchmake)).*/, (_req, res) =>
      res.sendFile(join(clientDist, "index.html")),
    );
    console.log(`[nangijala] serving built client from ${clientDist}, assets from ${ASSETS_ROOT}`);
  }
}

const gameServer = new Server({
  greet: false, // suppress the big Colyseus ASCII banner on start
  transport: new WebSocketTransport({ server: createServer(app) }),
});

gameServer.define(ROOM_NAME, WorldRoom);

gameServer
  .listen(PORT)
  .then(() => console.log(`[nangijala] world server listening on ws://localhost:${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
