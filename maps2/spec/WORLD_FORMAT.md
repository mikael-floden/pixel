# maps2 world format (`pixel-maps2/world@1`, superset `world@2`)

Every world under `maps2/worlds/<name>/` ships **`world.json`** — the loadable,
engine-neutral description a client needs to render and walk the map without
re-running the generator. Written by `maps2/pipeline/worldio.py`
(`save_world` / `load_world`); `worldio.load_world()` is the reference decoder
for both schemas.

A world that carries **decks** (elevated walkable slabs — roofs, bridge spans,
cave roofs) declares **`world@2`**, a strict *superset*: every `world@1` field
is present and unchanged, plus one optional `decks` array. A consumer that
ignores unknown fields renders a `world@2` map exactly as a `world@1` one (just
without the overpasses). `world@2` today: `house_demo`, `occlusion_test`,
`the_island`, `the_island2`; every other world is `world@1`.

## Coordinate + tile model

Staggered isometric diamond grid. A cell `(x, y)` (x = column, y = row) has its
top-diamond centre at screen:

```
screen_x = origin_x + (x - y) * dx
screen_y = origin_y + (x + y) * dy - level[y][x] * level_px
```

`geometry` carries the constants (all pixels):

| key | value | meaning |
|---|---|---|
| `tile_px` | 64 | tile image is 64 wide |
| `diamond_h` | 30 | top diamond height |
| `dx`, `dy` | 32, 15 | iso step per cell |
| `level_px` | 16 | vertical pixels per elevation level |

Tiles draw back-to-front by `(x + y)`. A cell of elevation `L` stacks a **base
surface tile** `L` times (each 16px up), then draws its `top` tile on the
surface; props draw last, anchored by content-bottom. Cliff FACES: stack the
cell's own `top` tile when it is a plain ground tile; for a transition `top`,
use any solid base tile of the cell's `mat`. (The generator varies which solid
base tile a region uses and a plain cell's `top` IS that region tile, so
stacking `top` reproduces a coherent-per-area wall for free.)

## Fields

- `name`, `schema`, `geometry`, `size` `{w,h}`.
- `spawn` `[x,y]` — a guaranteed **walkable** start cell (snapped off water/void).
- `water` — material ids treated as water (default `["clear_water"]`).
- `materials` — id→name legend; index 0 is `""` (void).
- `paths` — de-duplicated list of tile image paths relative to the **repo
  root** (the game serves them at `/assets/<path>`). Ground tiles and prop
  tiles both live here. **Dimensions are fixed by kind — never probe:** every
  `top` tile is **64×64**; every `props` tile is **64×128**.
- `mat[y][x]` — index into `materials` (0 = void).
- `level[y][x]` — elevation in levels (water is 0).
- `top[y][x]` — index into `paths` for the surface tile (−1 = void).
- `mirror[y][x]` — 1 = draw that tile **flipped horizontally** (the auto-tiler
  completes transition sets with mirrors — honour this flag).
- `collision[y][x]` — **non-authoritative** hint (1 = water / void / a prop
  stands there), for quick viewers/tools only. The game engine owns walkability
  and derives it from `level` + `mat` — see *Ownership boundary*. An engine may
  ignore this field entirely.
- `props[]` — `{x, y, tile, levels}` where `tile` indexes `paths`; a 64×128
  landmark tile anchored content-bottom on that cell. `levels` = its height in
  elevation levels (`base_x_N` → N; 1 otherwise) — a hint for occlusion/fade
  logic. Terrain occluder height is `level`.
- `decks[]` — **`world@2` only** (optional). See *Decks*.
- `meta` — optional generator metadata (not needed to render).

There is **no `emissive` field** (removed 2026-08-06). Glow is read from
`tiles2/emission.json`, keyed by the tile path from `paths`
(`WorldScene.tiles2Src`) — never mirrored into worlds. (The mirror went stale twice, silently — a duplicated fact has no
missing-file symptom — and nothing ever read it.) `worlds/glow_test` exercises
emissive tiles; its builder picks them from emission.json directly.

## Decks (`world@2`)

The base grid is a **heightfield**: one elevation and one surface per `(x, y)`.
That can't express a roof you walk under *and* on top of, or a bridge you walk
under, swim under, and walk over — those need a *second* walkable surface over
the same cell. `decks` adds exactly that, and nothing more.

A deck is a thin horizontal slab at its own elevation **above** the base
terrain, which stays whatever it was (walkable ground, or water you swim in)
underneath. Fields:

```jsonc
"decks": [
  {
    "kind": "roof",          // or "bridge" or "cave" — a label; not load-bearing
    "mat": 5,                 // index into `materials` (the slab's surface material)
    "level": 4,               // elevation of the slab's WALKABLE TOP, in levels
    "thickness": 1,           // face tiles below the top; the slab occupies
                              // [level - thickness, level] and that span is SOLID:
                              // the base beneath is enterable only from strictly
                              // BELOW `level - thickness` (see Caves). 0 is legal:
                              // the top tile alone — its baked face makes a 1-LEVEL
                              // slab. BRIDGES ship 0 (maintainer decision)
    "cells": [
      {"x": 58, "y": 105, "top": 12, "mirror": 0}   // top indexes `paths`
    ]
  }
]
```

Render like a base cell raised to `level`: stack `thickness` face tiles just
under the top (leaving **open air** below, so you see under a bridge) and draw
the `top` diamond at `level`, in the normal back-to-front `(x+y)` order right
after the base cell. With `thickness: 0` only the top tile draws — every tile's
art is a full cube (diamond + one face), so the slab still shows exactly one
level of side face and the walkable top stays flush with the banks. (The game's
`parseWorld` accepts thickness 0 since 2026-07-22 — it used to clamp to ≥1.)

**Two surfaces, one cell.** For a covered cell the player can be on the
**base** surface (`level[y][x]`) *or* the **deck** surface (`deck.level`); the
game decides which from the player's height/state — the map just states both
exist. Where the base terrain is already at `deck.level` (the roof over its own
walls, a bridge lapping onto a hilltop), the two coincide — one surface, no
overpass.

**Occlusion.** A deck is a tall occluder (standing under it puts the slab
between camera and player — prime case for the fade-the-occluder system).
`level` (+ `thickness`) is how tall it stands.

**Clearance.** A deck you pass *under* must out-top the player: headroom
beneath it is `(level - thickness) * level_px`. The player sprite is ~5 levels
(~80px) tall, so a low deck traps or clips them — the reference map's house
roof gives **96px** (level 7, thickness 1); its bridge sits at level 10,
thickness 0 (160px). Size walk-under decks (and full-height door gaps) to the
sprite.

`occlusion_test` is the reference: a flat-roof **house** (roof deck over a
walled room with a tall door; a rock stair climbs onto the roof; west/north
roof edges are open drops) and a **bridge** deck spanning two hills over a
channel half water (swim under) / half grass (walk under).

## Caves (`kind: "cave"` — the carve-out protocol)

A cave/dungeon lives in the SAME seamless world with **no transition**: the
deck idea inverted. The generator *carves* a finished mountain — the cave
**floor becomes the base terrain** (level 0, dark tops; the cell's `mat` is
kept so surface speed/sound on the roof stay what the mountain was), and the
mountain above becomes `kind:"cave"` roof decks carrying the pre-carve surface
**verbatim**: per-cell `top`/`mirror`, deck `level` = the old surface level,
deck `mat` = the old cell mat (one deck per (level, mat) group). From outside,
byte-for-byte nothing changes except the doorway.

Two contracts make this safe:

- **The slab is SOLID.** A deck occupies `[level - thickness, level]`. Movers
  at or above the slab's underside can only interact with the deck top (a
  too-high step is a WALL, exactly as the uncarved mountain was); the base
  beneath is enterable only from strictly *below* `level - thickness`. Without
  this a walker stepping into a tall roof ledge would fall through the rock
  onto the cave floor. (`games2/shared` implements this as `deckBot`;
  thickness is therefore NOT render-only.)
- **The doorway is the thickness gap.** Cave decks ship
  `thickness = level - ceiling` (the_island2: ceiling 8), so the wall faces
  `[0, ceiling)` are missing. Inside the massif those pixels are overdrawn by
  nearer terrain — invisible; at the pinned rim cells they ARE the visible dark
  door, and the same gap is the walk-in headroom.

the_island2's `build()` enforces the whole protocol: the legacy surface laws
run on the pre-carve surface view, a full-render byte-diff must be empty
outside the doorway window, and a CONTAINMENT battery (every cave cell deep
inside the independently-recomputed massif, single mouth, headroom, floor
reach) fails the build if the mountain ever changes shape under the cave — the
"redraw the cave" reminder.

## Notes for consumers

- The map is authoritative: `top`/`mirror` are the exact seamless tiles the
  generator chose; don't re-derive transitions.
- `decks` (world@2) is the *only* place two walkable surfaces share a cell; a
  world@1 renderer that ignores it still draws a correct (deck-less) ground map.
- `collision` is the minimal walk mask. Elevation cliffs (large `level` jumps)
  are for the client to gate if it wants step limits.
- Every world under `maps2/worlds/` validates against this doc.

## Ownership boundary (maps data vs. game physics)

Deliberate, durable separation of concerns, agreed with the game agent:

- **maps2 owns the world DATA** — terrain, elevation, surfaces/materials, the
  chosen tiles + mirror, props, and a sensible spawn.
- **the game engine owns PHYSICS/walkability** — what that terrain *means* for
  movement (walkable surfaces, step-up limits, water rules), derived itself
  from `level` + `mat`.

So `collision` (and `water`) are terrain-derived *hints*, not authority: maps
must not encode movement rules, and the engine must not depend on `collision`
as ground truth. (`spawn` is snapped off water/void as basic world-data
hygiene — a valid start cell, not a physics statement.)

## Stability

`world@1` is **stable** (it replaced the old ring-only `ringworld@1` —
`matids` + everything under `meta` — which the game's parser still reads). New info is added only as **optional** fields
under a bumped schema — never by changing or removing an existing field — so a
parser written against this doc keeps working.

`world@2` is the first such bump: `world@1` **plus** the optional `decks`
array. A world declares `world@2` only when it actually ships decks; every
other field is identical. Consumers can treat the schema family uniformly
(parse both the same, read `decks` if present); a strict `world@1`-only
renderer still gets a valid ground map by ignoring `decks`.
