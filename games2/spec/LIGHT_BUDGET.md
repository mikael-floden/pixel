# The light budget — how Nangijala's real lights are shared

*(games2, 2026-08-12. The maintainer's ruling; every placement agent designs
against this. Enforced by `games2/scripts/check-light-budget.mjs`, which runs
in `npm test` and should be run before shipping any world.)*

## Two lighting systems, one budget

The night shader renders at most **12 real point lights** — the ones with
distance attenuation, line-of-sight shadows, wall-face Lambert and elevation
awareness. The campfire at spawn has always been one; since 2026-08-12
**emissive tiles/props are real lights too** (that is what made the tile
bonfire finally match the campfire — same place, same night, measured parity
0.95).

Everything that does not fit is not dropped: it falls back to the **additive
glow-stamp field** (the old emission system), which is unlimited but is
ambience, not illumination. Overflow = yesterday's look, never a hole.

## The ledger (12 slots)

| slots | owner |
|------:|-------|
| 1 | the LOCAL player's own torch — remote players' torches are **never** lights ("a player can only ever see its own torch") |
| 1 | the **ambient agent** (`games2/client/src/lightslots.ts` → `setAmbientLight`) |
| 1 | the local player's own **spells** (future, reserved — `setSelfFxLight`) |
| 1 | **monster battle effects** against the local player (future, reserved — `setMonsterFxLight`) |
| **8** | **the world**: campfire scenery + emissive tiles/props + future scenery objects |

Reservations are **strict**: an empty slot is never lent out, because a loan
means a world light pops off the moment its owner shows up. The world budget
is 8, always. (The QA `probeLight` consumes a world slot while set.)

## The rule for placement agents (maps2, and the coming scenery agent)

> **No camera position may be reachable by more than 8 world light pools at
> once.** A light affects the scene before its source is on screen, so the
> audit window is the viewport **grown by each light's radius**.

Concretely (worst-case viewport ≈ 640×540 world px × 1.18 speed zoom-out; a
radius-R pool reaches ≤46·R px horizontally, ≤22·R px vertically):

- **No radius cap** (maintainer 2026-09-07: the campfire's 7 is one ordinary
  light, "not even near what will be the max in the game"; the art tables
  decide). A big radius costs SLOTS, not pixels: the pool holds one of the 8
  from further away, so the spacing rule below is what keeps a beacon from
  starving the lamps around it.
- Derived defaults for un-curated emissive tiles are ≤ 5 cells and quiet.
- Prefer radius ≤ 4 for repeated street furniture (lamps, rune stones);
  spacing rule of thumb: **≤ 8 sources per ~1500×1100 world-px window**, which
  at radius-4 lights is roughly "keep 5+ cells between lamps and don't cluster
  more than a handful per screen".
- A decorative glow that should never spend a slot can opt out:
  `tiles2/emission.json` → `lights` → `null` for its path/material (it keeps
  its stamp).
- `node games2/scripts/check-light-budget.mjs` tells you your world's worst
  window and where it is — run it before shipping. Worlds that exceeded the
  budget before this rule existed are pinned in
  `games2/spec/light-budget-baseline.json` (ratchet: they may not get worse;
  burn the pins down when touched).

## Tuning a tile's light (tiles2)

`tiles2/emission.json` gains an optional **`lights`** table (owned by tiles2,
curated in `tiles2/pipeline/emission.py` `LIGHTS`, emitted on regeneration).
Key = tile-path **stem** (no extension; wins) or material name. Value `null` =
stamp-only. Fields (all optional):

| field | meaning |
|-------|---------|
| `radius` | cells, as published (no cap) |
| `color` | `[r,g,b]`, values >1 are OVERBRIGHT — the shader clamps the multiply at 1.25, so excess widens the hot plateau (the campfire trick) |
| `flicker` | 0..1 (campfire = 1) |
| `shadows` | `false` = the shader's shadow-free glow pool (soft ambience, no LOS geometry) |
| `z` | levels above the cell surface (default 0.5, the campfire's flame height) |

Absent an entry, games2 derives a **campfire-anchored** default (2026-08-13 —
"a tile light source should aim to look as bright and lit up as the good old
campfire"): hue = the tile's extracted glow colour normalized to peak 1,
intensity = 1.9 · clamp(avgS·1.15, 0.45, 1), radius = clamp(4 + avgS·4, 4, 7)
(the derived default's own range, not a cap on a published entry) — a strong
source IS a campfire, a faint one is still ~45% of one, scaled by
the art's own cluster strengths. Curate entries to make a tile LEAD a scene
**or to dim one down** — with defaults this bright, quieting a decorative
glow (`radius`/`color` down, or `null` for stamp-only) is now the more common
edit. **The tile art itself doesn't have to change**; this is purely the
light it casts.

## What the game does with it (games2 internals)

- `WorldScene.buildEmissiveSources()` resolves every emissive prop in the
  world once per world; `pickWorldLights()` fills the 8 world slots per frame,
  closest-to-camera first, with hysteresis (`LIGHT_HYST_PX`) so boundaries
  don't strobe.
- A slotted source's ground-pool STAMP is filtered out per frame (the real
  light replaces it — both feed the character tints, so keeping both would
  double-brighten); its high per-cluster halos stay (the art's own bloom).
  Lose the slot → the pool stamp returns. The glow RT repaints from the stamp
  array every frame, so this costs a filter, not a rebuild.
- Indoors the existing room filter applies to emissive lights exactly as to
  the torch: a fire in YOUR room lights it (the maintainer's screenshot of a
  pitch-black room around a burning bonfire is fixed by this); one outside
  your room fades out with `indoorMix`.
- Probes: `__ml.lightSlots()` (the live ledger: slotted ids, overflow count,
  reserved-in-use), `__ml.lightAt(col,row[,z])` (the CPU light twin),
  `__ml.torch(on?)`. Gate: `scripts/verify-lightparity.mjs` (dev stack).
