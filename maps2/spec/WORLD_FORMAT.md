# maps2 world format (`pixel-maps2/world@1`, superset `world@2`)

Every world under `maps2/worlds/<name>/` ships a **`world.json`** — the loadable,
engine-neutral description a client needs to render and walk the map without
re-running the generator. Written by `maps2/pipeline/worldio.py`
(`save_world` / `load_world`).

Most worlds are **`world@1`**. A world that carries **decks** (elevated walkable
slabs — roofs, bridge spans) declares **`world@2`**, which is a strict *superset*:
every `world@1` field is present and unchanged, plus one optional `decks` array.
A consumer that ignores unknown fields renders a `world@2` map exactly as a
`world@1` one (just without the overpasses). Only `occlusion_test` uses `world@2`
today. See *Decks* below.

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
| `tile_px` | 64 | tile PNG is 64 wide |
| `diamond_h` | 30 | top diamond height |
| `dx`, `dy` | 32, 15 | iso step per cell |
| `level_px` | 16 | vertical pixels per elevation level |

Tiles are drawn back-to-front by `(x + y)`. A cell of elevation `L` stacks a
**base surface tile** `L` times (each 16px up) and then draws its `top` tile on
the surface; props draw last, anchored by content-bottom. For the cliff FACES,
stack the cell's own `top` tile when it is a plain ground tile (for a transition
`top`, use any solid base tile of the cell's `mat`). The generator varies which
solid base tile a region uses — so cliff walls differ across the map but stay
coherent within an area — and, because a plain cell's `top` IS that region tile,
stacking `top` reproduces the coherent wall for free.

## Fields

- `name`, `schema`, `geometry`, `size` `{w,h}`.
- `spawn` `[x,y]` — a guaranteed **walkable** start cell (snapped off water/void).
- `water` — material ids treated as water (default `["clear_water"]`).
- `materials` — id→name legend; index 0 is `""` (void).
- `paths` — de-duplicated list of tile PNG paths, relative to the **pixel repo
  root** (the submodule root in moonlight — the existing `client/public/pixel`
  symlink already serves them, so a path `tiles2/…/tile_00.png` loads from
  `/pixel/tiles2/…/tile_00.png`). Both ground tiles and prop tiles live here.
  **Dimensions are fixed by kind, so you don't need to probe them:** every `top`
  tile is **64×64**; every `props` tile is **64×128**.
- `mat[y][x]` — index into `materials` (0 = void).
- `level[y][x]` — elevation in levels (water is 0).
- `top[y][x]` — index into `paths` for the surface tile (−1 = void).
- `mirror[y][x]` — 1 if that tile is drawn **flipped horizontally** (the
  auto-tiler uses mirrors to complete transition sets — honour this flag).
- ~~`emissive[i]`~~ — **REMOVED 2026-08-06.** It mirrored tiles2's emission data
  into every world as a "convenience", and the convenience was for nobody: the
  game reads `tiles2/emission.json` itself (`WorldScene.tiles2Src`, keyed by
  tile path), and nothing in the repo ever read this field. All it did was cost
  9.2 KB across the worlds and go stale every time tiles2 re-extracted glow —
  twice, silently, because a duplicated fact has no missing-file symptom to give
  it away. **For glow, read `tiles2/emission.json`, keyed by the tile path from
  `paths`.** `worlds/glow_test` still exists to exercise emissive tiles; its
  builder picks them from emission.json directly.
- `collision[y][x]` — **non-authoritative** convenience hint (1 = water / void /
  a prop stands there). Provided for quick viewers/tools only. **The game engine
  owns walkability** and should derive it from `level` (elevation) + `mat`
  (surfaces), NOT from this grid — see *Ownership boundary* below. A game engine
  may ignore this field entirely.
- `props[]` — `{x, y, tile, levels}` where `tile` indexes `paths`; a 64×128
  landmark tile anchored content-bottom on that cell. `levels` is its height in
  elevation levels (`base_x_N` → N; 1 otherwise) — a hint for occlusion/fade
  logic (how tall the occluder stands). Terrain occluder height is `level`.
- `decks[]` — **`world@2` only** (optional). Elevated walkable slabs; see *Decks*.
- `meta` — optional generator metadata (not needed to render).

## Decks (`world@2`)

The base grid is a **heightfield**: one elevation and one surface per `(x, y)`.
That can't express a **roof you walk under *and* on top of**, or a **bridge you
walk under, swim under, and walk over** — those need a *second* walkable surface
floating over the same cell. `decks` adds exactly that, and nothing more.

A deck is a thin horizontal slab sitting at its own elevation **above** the base
terrain, which stays whatever it was (walkable ground, or water you swim in)
*underneath*. Fields:

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
                              // slab. BRIDGES ship 0 (maintainer 2026-07-22)
    "cells": [
      {"x": 58, "y": 105, "top": 12, "mirror": 0}   // top indexes `paths`
    ]
  }
]
```

Render it like a base cell raised to `level`: stack `thickness` face tiles just
under the top (leaving **open air** below, so you see under a bridge) and draw the
`top` diamond at `level`. Draw a deck cell in the normal back-to-front `(x+y)`
order, right after its base cell. With `thickness: 0` only the top tile draws —
since every tile's art is a full cube (diamond + one face), the slab still shows
exactly one level of side face, and the walkable top stays flush with the banks.

**Two surfaces, one cell.** For a cell a deck covers, the player can be on the
**base** surface (`level[y][x]` — the room floor, the ground/water in the channel)
*or* on the **deck** surface (`deck.level`). The game decides which from the
player's height/state; the map just states both exist. Where a deck cell's base
terrain is already at `deck.level` (e.g. the roof over its own walls, or the
bridge lapping onto a hilltop), the two coincide — a single surface, no overpass.

**Occlusion.** A deck is a tall occluder: standing under the roof or under the
bridge deck puts the slab between the camera and the player, so it's a prime case
for the fade-the-occluder system. `level` (+ `thickness`) is how tall it stands.

**Clearance.** A deck you pass *under* (bridge, doorway, roofed room) must out-top
the player: the headroom beneath it is `(level - thickness) * level_px`. The
player sprite is ~5 levels (~80px) tall, so a low deck traps or clips them — the
reference map sits its house and bridge at **level 7** (96px of clearance) for
that reason. Size walk-under decks (and full-height door gaps) to the sprite.

`occlusion_test` is the reference: a flat-roof **house** (roof deck over a walled
room with a tall door; a rock stair on the east climbs onto the roof; west/north
roof edges are open drops) and a **bridge** deck spanning two hills over a channel
that is half water (swim under) and half grass (walk under).

## Caves (`kind: "cave"` — the carve-out protocol, maintainer 2026-07-29)

A cave/dungeon lives in the SAME seamless world with **no transition**: the deck
idea inverted. The generator *carves* a finished mountain — the cave **floor
becomes the base terrain** (level 0, dark tops; the cell's `mat` is kept so
surface speed/sound on the roof stay what the mountain was), and the mountain
above it becomes `kind:"cave"` roof decks that carry the pre-carve surface
**verbatim**: per-cell `top`/`mirror`, deck `level` = the old surface level,
deck `mat` = the old cell mat (one deck per (level, mat) group). From outside,
byte-for-byte nothing changes except the doorway.

Two contracts make this safe:

- **The slab is SOLID.** A deck occupies `[level - thickness, level]`. Movers at
  or above the slab's underside can only interact with the deck top (a too-high
  step is a WALL, exactly as the uncarved mountain was); the base beneath is
  enterable only from strictly *below* `level - thickness`. Without this, a
  walker stepping into a tall roof ledge would "fall through" the rock onto the
  cave floor. (`games2/shared` implements this as `deckBot`; thickness is
  therefore no longer render-only.)
- **The doorway is the thickness gap.** Cave decks ship
  `thickness = level - ceiling` (the_island2: ceiling 8), so the wall faces
  `[0, ceiling)` are missing. Everywhere inside the massif those pixels are
  overdrawn by nearer terrain — invisible; at the pinned rim cells they ARE the
  visible dark door, and the same gap is the walk-in headroom.

the_island2's build() enforces the whole protocol: the legacy surface laws run
on the pre-carve surface view, a full-render byte-diff must be empty outside the
doorway window, and a CONTAINMENT battery (every cave cell deep inside the
independently-recomputed massif, single mouth, headroom, floor reach) fails the
build if the mountain ever changes shape under the cave — the "redraw the cave"
reminder.

## Notes for consumers

- The map is authoritative: `top`/`mirror` are the exact seamless tiles the
  generator chose; don't re-derive transitions.
- `decks` (world@2) is the *only* place two walkable surfaces share a cell; a
  world@1 renderer that ignores it still draws a correct (deck-less) ground map.
- `collision` is the minimal walk mask. Elevation cliffs (large `level` jumps
  between neighbours) are for the client to gate if it wants step limits.
- All four current worlds validate: `ring_test`, `trans_demo`, `prop_demo`,
  `demo_isle`.

## Ownership boundary (maps data vs. game physics)

Deliberate separation of concerns, agreed with the game engine (moonlight):

- **maps2 owns the world DATA** — terrain, elevation, surfaces/materials, the
  chosen tiles + mirror, props, and a sensible spawn.
- **the game engine owns PHYSICS/walkability** — what that terrain *means* for
  movement (walkable surfaces, step-up limits at elevation cliffs, water rules).
  It derives this itself from `level` + `mat`.

So `collision` (and `water`) are terrain-derived *hints*, not authority. This
boundary is intentional and durable: maps must not encode movement rules, and the
engine must not depend on `collision` as ground truth. (`spawn` is snapped off
water/void as basic world-data hygiene — a valid start cell — not as a physics
statement.)

## Stability

`world@1` is **stable** — this replaced the old ring-only `ringworld@1`
(which used `matids` + everything under `meta`). New info is added only as
**optional** fields under a bumped schema, never by changing or removing an
existing field, so a parser written against this doc keeps working.

`world@2` is the first such bump: it is `world@1` **plus** the optional `decks`
array — a strict superset. A world only declares `world@2` when it actually ships
decks; every other field is identical. So a consumer can treat the schema family
uniformly (parse `world@1` and `world@2` the same, read `decks` if present) and a
strict `world@1`-only renderer still gets a valid ground map by ignoring `decks`.
`worldio.load_world()` in `maps2/pipeline/worldio.py` is the reference decoder
(it reads both) if you want to diff behaviour.
