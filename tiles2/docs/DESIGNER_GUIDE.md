# tiles2 — designer's guide

For **map designers** and **game designers**: what the tile library gives you,
how the pieces fit together, and what data you can read *without opening a
single image*. (Engineers: `../README.md` for the pipeline, `ELEVATION.md` for
elevation, `METADATA.md` for the full per-tile metadata contract,
`WEBP.md` for the image format.)

---

## 1. The big picture

tiles2 is a library of **isometric terrain tiles** for a top-down RPG map,
organised around **specifically-named ground types** — `saturated_grass`,
`regular_snow`, `lightdark_dirt`, `stone_mountain`, `black_mountain`,
`clear_water`, `light_sand`, `crystal_ice` — rather than a generic "grass", so
new variants (`dry_grass`, `jungle_grass`, …) can be added later without
clashing.

Everything a designer needs comes in three flavours, per type:

| Flavour | Where | What it is |
|---|---|---|
| **Ground** (`base`, a.k.a. base_x_1) | `<type>/base/` | The flat, walkable surface tile. |
| **Elevation** (`base_x_2 … base_x_5`) | `<type>/base_x_N/` | Free-standing props/landmarks of that terrain, in four height tiers. |
| **Transitions** | `<type>/transitions/<other>/` | Border tiles that blend this terrain into another. |

Each is a set of ready-to-use lossless WebPs plus a `metadata.json` describing
every tile. **PixelLab (pixellab.ai/maps) is the source of truth** — delete a
tile sheet you don't like there and it's dropped from the library and
regenerated on the next run (see §6).

---

## 2. The strict render perspective (why everything lines up)

**Every tile is rendered with the same camera**: isometric, 64 px grid cell,
high top-down at **28°**. For ground and transition tiles the walkable top
diamond is **exactly 30 px tall × 64 px wide on every tile** — that identical
footprint is what lets tiles tessellate on the grid and transitions meet
cleanly. Drop any ground tile into a cell and its walkable surface lands in
exactly the same place. One elevation "level" = **16 px** of vertical face —
the ground tile's own face height, and the unit the `levels` field counts in.

> **Outlines:** the generator bakes a dark edge line into the art and can't
> turn it off, so tiles have a subtle interior outline (a coherent hand-drawn
> look). The outer silhouette rim, vertex dots, and edge seams are cleaned in
> post. This is intentional, not a bug.

---

## 3. The heights: `base` through `base_x_5`

- **`base` (base_x_1) — the ground.** The flat terrain you fill areas with.
  Every ground type has **5 base sheets** (~16 tiles each) of natural
  variation so large areas don't look tiled.

- **`base_x_2` … `base_x_5` — props & landmarks.** Free-standing objects of
  that terrain in four size tiers (small → medium → large → huge towering),
  each rendered on a **64×128** canvas with a transparent background, resting
  on a small low patch of its terrain — no cube, no pedestal (deliberate:
  the block-under-every-object look was rejected and regenerated). `levels`
  (2–5) tells you the intended in-world height in ground-levels.

**What to expect inside an elevation sheet:** *variety* — ~16 **different**
objects appropriate to that terrain and tier, e.g. grass gives boulders,
stumps, mushrooms, flowers, saplings, standing stones … scaling up to
towering oaks and monuments at `base_x_5`; stone gives cairns, menhirs,
obelisks, towers; crystal_ice gives crystal spires; snow gives drifts,
snowmen, peaks.

> Elevation tiles are **props/landmarks**, not ground fill — they occupy a
> cell but you don't tile them edge-to-edge like `base`.

---

## 4. Colour normalization (why a type looks like one material)

Left alone, 80 separately-generated grass tiles would each be a *slightly*
different green — patchy and cheap. So every tile is **harmonised**:

1. Each type has one canonical **material colour**. Today that target comes
   from the game's HUD palette (`config.postprocess.palette` — grass and dirt
   are the designer's exact colours; the rest sampled from the HUD), so the
   whole tileset reads as one harmonic set with the UI; without a palette
   entry it's auto-detected from the type's first base sheet.
2. Every tile's matching pixels are pulled to that target — hue, saturation,
   and mean brightness — while keeping texture and shading.
3. The pull is **hue-band targeted**: only the material moves. A grass tile's
   green snaps to the canonical green, but dirt sides, flowers, pebbles, and
   other accents are left untouched — mushroom red, wood brown, crystal blue
   survive. Fire and other light sources are spared entirely.

Consequences you can rely on:

- **Any grass tile matches any other grass tile** — base, elevation, or
  transition. Mix freely; the greens agree.
- **Transitions harmonise *both* sides**, so a grass→stone border tile's grass
  matches your grass fields *and* its stone matches your stone.
- **Elevation props harmonise toward their terrain**, so a tree planted in a
  grass field blends into the field.

The per-type target is recorded in each type's `metadata.json`
(`harmonize_target`) — stable and inspectable.

---

## 5. Transitions — and the data that makes them auto-placeable

Two terrains meeting at a hard diamond edge looks like a seam; a transition
tile is grass-on-one-side, stone-on-the-other, blended in the middle.

**Coverage — full pairwise mesh.** Every type gets a transition to **every
other type** (not just "adjacent" ones), with **5 sheets per pair**, each a
**different border style**: soft ragged, clean sharp, patchy islands, wide
gradual blend, interlocking fingers, gentle wavy. Stored under
`<A>/transitions/<B>/` (one direction per pair).

### What's exposed in metadata (read this instead of opening images)

Full contract: `METADATA.md`. Every tile in a sheet's `metadata.json` carries:

- **`composition`** — the fraction of each material on the tile's top diamond,
  e.g. `{"black_mountain": 0.81, "lightdark_dirt": 0.19}` — the overall mix at
  a glance.

- **`edges`** — the important one for **auto-tiling**. For each of the four
  diamond edges (**NE, SE, SW, NW**): **8 samples along the edge, each
  labelled with the material type-id**, plus a `ratio` and — for a clean
  single split — a `divider` fraction (where along the edge A becomes B):
  ```json
  "NE": { "samples": ["black_mountain","black_mountain","black_mountain",
                       "black_mountain","black_mountain","lightdark_dirt",
                       "lightdark_dirt","lightdark_dirt"],
          "ratio": {"black_mountain":0.625,"lightdark_dirt":0.375},
          "divider": 0.625 }
  ```
  **Neighbour-matching rule:** two tiles fit side-by-side when their shared
  edge agrees. On the iso grid a tile's **SE** edge meets its neighbour's
  **NW** (reversed), and its **NE** meets the neighbour's **SW** (reversed).
  An auto-tiler picks tiles whose edges line up material-for-material —
  seamless borders without hand-checking art.

- **`description`** — a short human sentence, e.g. *"black volcanic rock
  blending to dirt with a small puddle"*.

- **`features`** — detected standout details: `flowers`, `pebbles`, `shiny`,
  `water`, `bare_soil`. Handy for "give me a grass tile with flowers".

Base tiles carry the same fields (uniform edges, `composition` ~100% one
type). Elevation sheets expose a simpler set: **`objects`** (what the sheet
depicts), **`levels`**, and **`face_px`**.

---

## 6. Curating the library (source of truth)

**PixelLab is the source of truth.** Every sheet records a PixelLab `tile_id`.

- Browse and **delete** tiles you don't like in **pixellab.ai/maps**.
- The next run notices the deletion (the `tile_id` 404s), **removes that sheet
  from the repo**, and **regenerates** it — a fresh roll (for elevation, a
  brand-new shuffled set of objects).
- **`raw/` is never edited** — all colour-normalising and metadata are
  re-derived from it, so processing can be re-tuned and re-run at zero
  generation cost.

Curator workflow: **generate → review in the UI → delete the duds →
regenerate**, until a type's library is all keepers.

---

## 7. Things you might have missed

- **A "sheet" ≈ 16 tiles** = one generation call. Counts (5 base sheets/type,
  5 transition sheets/pair, 3 elevation sheets per terrain×height) are in
  `config/tiles2.json`.
- **Ground vs. props.** `base` tiles tessellate edge-to-edge; elevation tiles
  occupy a cell.
- **Reproducibility.** Seeds are derived from ids/indices, so regeneration is
  deterministic where it can be; a re-roll after a deletion intentionally
  varies the seed to give you something new.
- **New terrains extend the mesh.** Adding a ground type automatically means
  it owes a transition to every existing type — the library stays complete.
- **`clear_water`** is a terrain type like any other here (a solid diamond
  tile); animated water/flow is out of scope for tiles2. Glow/night lighting
  IS in scope: see `tiles2/emission.json`.
- **Colour agreement ≠ identical tiles.** Harmonisation aligns the *material*
  palette; texture, detail, and features stay varied so areas look natural.
