# CLAUDE.md — Nangijala working notes

## What this is

**Nangijala** is a browser-based **multiplayer** (MMO-style) pixel-art RPG.
Everyone who connects joins the **same shared isometric world**. It lives inside
the **`pixel` monorepo** at `games/nangijala` and renders the art produced by the
sibling agent domains (`characters/`, `tiles/`, `maps/`, `objects/`). **Read-only
toward the art** — never edit those directories (see `coordination/PROTOCOL.md`;
this game owns the `games/` domain + `coordination/games.json`). No submodule.
The game is developed by a self-iterating loop — see `loop/LOOP.md`.

## Tech stack

- **TypeScript npm-workspaces**: `shared/`, `server/`, `client/`.
- **Server** (`server/`): Node + **Colyseus** authoritative `WorldRoom` holding
  the single shared `WorldState` (map of `Player`s). Clients send `input`; the
  server integrates on a 20 Hz tick (`shared/stepMovement`) and syncs state.
  Persistence in `store.ts` (returning players keep their spot by token). Runs
  with plain `tsx` — the schema is decorator-free (`defineTypes`, not `@type`),
  so no `experimentalDecorators`/Node-version fragility.
- **Client** (`client/`): **Phaser 3** + `colyseus.js` (Vite). Client-side
  prediction + reconciliation; chat + roster; renders the **isometric world**.

## Assets (served at /assets)

- Art is read from the repo-root sibling domains — NOT copied in. The dev server
  (Vite middleware in `client/vite.config.ts`) and prod server (`server/index.ts`)
  both serve `/assets/<domain>/…` from `characters/ tiles/ maps/ objects/`
  (override the location with `ASSETS_ROOT`, e.g. in Docker).
- `scripts/build-manifest.mjs` scans `characters/skeletons/` →
  `client/public/characters.json` (uid, name, frame size, per-anim/dir counts,
  `/assets/...` urls). Regenerate after graphics change (`npm run manifest`).

## Isometric world

- `client/src/maps.ts` loads `maps/world/world.json` (a `w×h` grid of cells
  `{t: tile category, v: variant, l: elevation, r: region}`) and the geometry
  from `maps/pipeline` (`x=(col-row)*32`, `y=(col+row)*dy − level*lh`; draw
  back-to-front by `(col+row,row)`, stack level 0..l). `MapPreviewScene` (`/#map`)
  composites the whole world; the live `WorldScene` uses it as the ground and
  `project()`s each player's flat `(x,y)` onto the grid (feet lifted by elevation).
- Movement system (#17) is server-authoritative and governed by **elevation**,
  not tile category (`shared/`): `buildTerrainGrid` reads each cell's `l` +
  category; `canEnter` allows a move only if the destination is enterable and the
  UPWARD elevation step is within the climb allowance — dropping down any
  height is always allowed (gravity is free). Design **"Option 2B"**:
  `WALK_CLIMB = 0.5` (you can't walk up a full 1-level ledge), but a **timed
  jump** (`JUMP_CLIMB = 1`, Space) climbs it. `stepMovement` resolves axis-
  separated (wall-slide) and scales by the current **surface** speed.
- **Surfaces** (`SURFACES` in `shared/`) are the *other* axis: per-category
  `{ standable, swimmable, speed, sound }` — roads faster, sand/snow slower,
  water swimmable. Unknown categories default to plain walkable ground.
- **Swimming/stamina** (`stepStamina`): entering water drains stamina (~20/s),
  land regenerates it; at 0 you **drown** → respawn on nearest land (`findSpawn`),
  server broadcasts `drown`. Client shows a swim tint, sink, and a stamina HUD.
- Client rebuilds the SAME grid and predicts jump/swim/speed so nothing rubber-
  bands. Press **C** to visualize water cells. Tune feel via the `*_CLIMB`,
  `*_STAMINA`/`SWIM_*` constants and the `SURFACES` table.
- **Controls are screen-relative** on the iso world: `stepMovement(..., screenInput)`
  rotates the input by the projection ratio (`ISO_DX`/`ISO_DY` in `shared/` — the
  client's `MAP_GEOMETRY` imports them so they can't drift) so pressing Up walks
  straight up on screen; facing uses the raw screen vector.
- Open follow-ups (#28): occlusion behind tall tiles; half-level (0.5) stair/ramp
  tiles from the maps agent so players can ascend without jumping. If the tile
  "house format" changes, re-measure `MAP_GEOMETRY` and update `ISO_DX/ISO_DY`.

## Conventions

- `npm run dev` runs server + client. `npm test` = headless two-client sync test.
  `npm run typecheck` per package. Work from `games/nangijala/`.
- Keep shared movement/direction math in `shared/` — never duplicate it.
- Server is authoritative; never trust client positions.
- Tests stay headless (node + Colyseus, no browser); browser checks go through
  `scripts/verify-*.mjs` (Playwright).

## The loop (loop/)

`loop/LOOP.md` is the runbook run on a schedule. Each iteration: `git pull`
(latest art from all agents) + regenerate the manifest, keep ≥15 open GitHub
issues on `mikael-floden/pixel` (label `game`), implement the best one, keep
`npm test` + typecheck green, commit + push to `main` (rebase on reject).

## Don't

- Don't touch the map/background/environment/tileset/world art (that's the maps
  and tiles agents' domains). You may improve the tile **renderer** (occlusion,
  collision, input feel — #28) but do not redesign or hand-author world art.
- Don't edit anything outside `games/` except your own `coordination/games.json`.
- Don't push red — `npm test` and `npm run typecheck` must pass first.
