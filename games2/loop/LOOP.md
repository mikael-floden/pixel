# Nangijala self-iterating development loop

Executed by an agent (Claude Code) on a schedule. **One run = one iteration.**
Each iteration keeps a healthy backlog of ideas and makes the game a little
better, then pushes to `main`. The next run resumes from the repo state.

The game lives at **`games/nangijala`** inside the **`mikael-floden/pixel`**
monorepo (Node/TS + Colyseus server, Phaser + Vite client). Art comes from the
sibling agent domains at the repo root (`characters/`, `tiles/`, `maps/`,
`objects/`) — no submodule. See `CLAUDE.md` and `coordination/PROTOCOL.md`.
**Run everything from `games/nangijala/`.**

## Guardrails

- **You have authority to commit and push to `main`.** Keep every push green:
  `npm test` and `npm run typecheck` must pass first. On push rejection,
  `git fetch && git rebase origin/main` and retry (disjoint paths merge cleanly).
- **Stay inside `games/`.** Never create/edit/delete files under another agent's
  domain (`characters/`, `tiles/`, `maps/`, `objects/`, other `coordination/*`).
  The only file you write outside `games/` is your own `coordination/games.json`.
- **MAP/WORLD ART is the maps/tiles agents' domain** — never redesign or
  hand-author it. You MAY improve the tile **renderer** (occlusion, collision,
  input feel — #28). Everything else (gameplay, netcode, UI) is fair game.
- Never commit secrets. The server is authoritative — never trust client positions.
- One issue per iteration. Small, working increments beat big broken ones.

## Scheduling
- **Recommended — a scheduled Routine** firing every ~2h with *"Run one iteration
  of games/nangijala/loop/LOOP.md"*. Each firing does one iteration and exits.
- An in-session cron can also drive it while a session is alive.

## Iteration procedure (run from `games/nangijala/`)

### 1. Sync latest art
```bash
git pull --ff-only origin main     # newest art from the character/tile/map agents
cd games/nangijala && npm install
node scripts/loop-prep.mjs         # regenerate client/public/characters.json + report new art
```
New characters/tiles/maps are a common reason to file an issue (e.g. "use the new
`attack` animation for combat", "map added a harbor — spawn players there").

### 2. Tend the backlog (must hold ≥ 15 open issues)
Issues live on **`mikael-floden/pixel`**, labeled **`game`** (to separate them
from the art agents' issues).
- **Prune stale issues.** Close (short reason) anything done/duplicated/off-track.
- **Count open `game` issues.** If fewer than 15, file concrete, ~one-iteration
  issues (title + "why it improves the game" + acceptance criteria + labels
  `game`,`netcode`/`ui`/`system`/`feature`/`polish`/`bug`/`deploy`).

### 3. Pick and implement the best issue
Implement across `shared/`/`server/`/`client/` with tests where practical. Run
`npm test` + `npm run typecheck` until green; for rendering, sanity-check with a
`scripts/verify-*.mjs` (Playwright) when feasible. Commit referencing the issue
(`Fixes #NN`), then `git push origin main` (rebase on reject).

### 4. Advance the graphics snapshot
If new art was consumed, `node scripts/loop-prep.mjs --write-manifest` and commit
`loop/graphics_manifest.json`.

### 5. Wrap up
Leave the tree clean and pushed; confirm the `nangijala game CI` run is green.

## Backlog themes
- **Netcode:** interest management/culling, interpolation buffers, reconnection,
  lag handling, anti-cheat.
- **Iso world (#28):** player occlusion behind tall tiles, terrain walkability/
  collision, elevation traversal (stairs), input feel.
- **World/social:** emotes, player collision, chat channels, portals/areas.
- **RPG core:** stats/leveling, inventory, equippable outfits (dresses), combat
  using kick/punch/attack, enemies/mobs, quests & dialogue.
- **Server:** DB persistence, rooms/shards, admin/metrics.
- **Client/feel:** camera polish, day/night, footsteps, audio, minimap.
- **Ops:** GCP deploy (`deploy/DEPLOY.md`), CI.

Keep the loop honest: if the game moved on from an idea, close its issue.
