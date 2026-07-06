# maps2 world format (`pixel-maps2/world@1`)

Every world under `maps2/worlds/<name>/` ships a **`world.json`** — the loadable,
engine-neutral description a client needs to render and walk the map without
re-running the generator. Written by `maps2/pipeline/worldio.py`
(`save_world` / `load_world`).

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
- `emissive[i]` — parallel to `paths`: `1` if that tile is **self-emissive**
  (tiles2 `features.shiny`), else `0`. A cell glows when
  `emissive[ top[y][x] ] == 1`. Convenience mirror of tiles2 metadata so the
  night-lighting shader can find emissive cells without re-reading it; the
  `worlds/glow_test` map exists to exercise exactly these.
- `collision[y][x]` — **non-authoritative** convenience hint (1 = water / void /
  a prop stands there). Provided for quick viewers/tools only. **The game engine
  owns walkability** and should derive it from `level` (elevation) + `mat`
  (surfaces), NOT from this grid — see *Ownership boundary* below. A game engine
  may ignore this field entirely.
- `props[]` — `{x, y, tile}` where `tile` indexes `paths`; a 64×128 landmark
  tile anchored content-bottom on that cell.
- `meta` — optional generator metadata (not needed to render).

## Notes for consumers

- The map is authoritative: `top`/`mirror` are the exact seamless tiles the
  generator chose; don't re-derive transitions.
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
(which used `matids` + everything under `meta`). New info will be added only as
**optional** fields under a bumped schema (`world@2`), never by changing or
removing an existing `world@1` field, so a parser written against this doc keeps
working. `worldio.load_world()` in `maps2/pipeline/worldio.py` is the reference
decoder if you want to diff behaviour.
