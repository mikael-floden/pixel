# Nangijala

A browser-based **multiplayer** pixel-art RPG — everyone who connects joins the
**same shared isometric world** and sees each other move in real time. Named for
the afterworld in Astrid Lindgren's *The Brothers Lionheart*.

Lives inside the [`pixel`](https://github.com/mikael-floden/pixel) monorepo at
`games/nangijala` and renders the art produced by the sibling agent domains
(`characters/`, `tiles/`, `maps/`, `objects/`) — **no submodule, no cross-repo
dependency**. It is read-only toward the art: it never edits those directories.

## Tech stack

| Layer    | Choice                                                             |
|----------|-------------------------------------------------------------------|
| Server   | Node + TypeScript + **Colyseus** (authoritative shared-world room) |
| Client   | **Phaser 3** + `colyseus.js`, bundled with **Vite**               |
| World    | isometric tiles from `maps/world/world.json` + `tiles/<cat>/`      |
| Assets   | served at `/assets/<domain>/…` from the repo-root art domains      |

The server is authoritative (20 Hz tick). The client predicts locally and
reconciles; players' flat `(x,y)` is projected onto the iso grid with elevation.

## Quick start (from the repo root)

```bash
cd games/nangijala
npm install
npm run dev          # server :2567 + client :5173
```
Open `http://localhost:5173` in two tabs → pick a character → walk the island.
WASD/arrows move, Shift runs, **Space jumps** (time it to hop a 1-level ledge),
Enter chats, C shows the water/terrain debug overlay, **L cycles time-of-day**
(day/dusk/night/dawn lighting), **G toggles fog**. You can swim across water but
your stamina drains — get out before you drown. Map preview at `/#map`.

## Layout

```
shared/    constants + pure helpers shared by server & client (incl. stepMovement)
server/    Colyseus WorldRoom + authoritative movement + persistence (store.ts)
client/    Phaser game: iso world render (maps.ts), players, chat, roster
scripts/   build-manifest.mjs (characters/ → client manifest), verify-*.mjs
loop/      the self-iterating development loop runbook
deploy/    GCP deploy guide + Caddyfile
```
Art is read from the sibling domains at the repo root; `scripts/build-manifest.mjs`
turns `characters/skeletons/` into `client/public/characters.json`, and the dev
server (Vite middleware) + prod server (Colyseus/express) serve every domain at
`/assets/<domain>/…`.

## Verify / deploy

```bash
npm test               # headless two-client authoritative-sync test
npm run typecheck      # per-package tsc --noEmit
```
Production is a single container (client + assets + WS on one port) — see
[`deploy/DEPLOY.md`](deploy/DEPLOY.md) (GCP `europe-north1`, Caddy auto-TLS,
`nangijala.online`).
