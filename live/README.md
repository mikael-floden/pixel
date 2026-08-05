# live/ — the game's LIVE-UPDATE channel

This folder is the repo's **runtime state**: files here are read by the game
server **directly from GitHub `main` while the game is running** — no
redeploy, no image rebuild. Pushing a change to `live/**` updates the running
game within seconds.

## How the update flows (push-based, no polling)

1. Something commits to `live/**` on `main` — the admin saving in the wiki
   (the game server itself makes that commit), or an agent's loop.
2. `.github/workflows/live-notify.yml` fires on the push and POSTs
   `https://nangijala.online/api/live/refresh`.
3. The game server re-fetches `live/**` from GitHub raw, diffs, and
   **broadcasts the new state over the existing Colyseus WebSocket** to every
   connected client (`"live:update"` message).
4. Clients apply the new tuning immediately. The wiki reads the same state
   via `GET /api/live/state`.

Admin saves via the wiki don't need that hop: the server merges the admin's
per-entry delta onto the file's **current committed content** (GitHub
contents API, conditional on the blob sha — a racing agent push re-merges,
never gets reverted), commits, then adopts the result and broadcasts
immediately. The server also loads `live/**` at boot (GitHub first, the copy
baked into the image as fallback, with retries until GitHub answers), and
holds saves/state queries (503) until the store is loaded.

`live/**` is deliberately **excluded from the deploy workflow's trigger
paths** — changing monster stats or rating a sound never restarts the game.

## Contents

- `live/tuning/monsters.json` — `pixel-wiki-tuning-monsters@1`. Per-monster
  stats (hp, damage, speed, aggro radius, attack cooldown, xp, scale) +
  loot tables. **Consumed by the game** (server + clients, via the live
  channel). Edited in the wiki's monster pages (admin only).
- `live/tuning/constants.json` — `pixel-wiki-tuning-constants@1`. Overrides
  for `games2/shared` gameplay constants, keyed by exported name.
  **Consumed by the game**. Edited in the wiki's Tuning page.
- `live/feedback/<domain>.json` — `pixel-wiki-feedback@1` for monsters,
  characters, tiles, objects, sounds, music, items. Star ratings (1-5),
  approve/reject verdicts and notes per asset id. **Consumed by the art
  agents, not the game**: each agent MUST read its domain file at the start
  of every run and act on it (rejected → remove/replace the asset and delete
  the feedback entry once handled; stars steer style). Written by the wiki
  (admin verdicts) and by agents (clearing handled entries).

## Rules

- Asset ids in feedback files: repo-relative file path without extension for
  individual files, entity directory path for whole entities
  (`monsters/mammoth`), `<entity>#<state>` for one animation state.
- Agents edit **their own domain's feedback file** only (read-modify-write,
  pull before push — the wiki server merges per-entry, so conflicts are rare
  and rebases are clean).
- Nothing in `live/` is generated at build time — it is durable state. Don't
  regenerate or bulk-rewrite these files.
- The game must always run fine with an empty/missing override — `live/`
  tunes defaults, it never becomes a hard dependency.
