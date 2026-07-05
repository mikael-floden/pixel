# tiles2 — designer's guide

For **map designers** and **game designers**. This explains what the tile library
gives you, how the pieces fit together, and what data you can read *without opening
a single PNG*. (Engineers: see `../README.md` for the pipeline and
`ELEVATION.md` for the height calibration.)

---

## 1. The big picture

tiles2 is a library of **isometric terrain tiles** for a top-down RPG map. It is
organised around **specifically-named ground types** — `saturated_grass`,
`regular_snow`, `lightdark_dirt`, `stone_mountain`, `black_mountain`,
`clear_water`, `wooden_balcony`, `light_sand`, `crystal_ice` — rather than a
generic "grass", so new variants (`dry_grass`, `jungle_grass`, …) can be added
later without clashing.

Everything a designer needs comes in three flavours, per type:

| Flavour | Where | What it is |
|---|---|---|
| **Ground** (`base`, a.k.a. base_x_1) | `<type>/base/` | The flat, walkable surface tile. |
| **Elevation** (`base_x_2 … base_x_5`) | `<type>/base_x_N/` | Taller blocks & props of that terrain (2–5 levels high). |
| **Transitions** | `<type>/transitions/<other>/` | Border tiles that blend this terrain into another. |

Each of these is a set of ready-to-use PNGs plus a `metadata.json` describing
every tile. **PixelLab (pixellab.ai/maps) is the source of truth** — delete a tile
sheet you don't like there and it's dropped from the library and regenerated on the
next run (see §6).

---

## 2. The strict render perspective (why everything lines up)

**Every single tile — ground, elevation, and transition — is rendered with the
exact same camera and geometry.** This is deliberate and non-negotiable, because
it's what lets tiles tessellate on a grid, transitions meet cleanly, and elevation
blocks stack pixel-perfectly.

| Property | Value | Why it matters to you |
|---|---|---|
| Projection | **isometric diamond** | Standard staggered-diamond map grid. |
| Tile width | **64 px** | The grid cell width. |
| View | **high top-down, angle 28°** | Fixed camera — no tile is drawn from a different angle. |
| Diamond top | **exactly 30 px tall × 64 px wide** | The footprint that tiles snap to; identical on *every* tile. |
| Flat-top | **2 px classic point** | The diamond's crisp N/S points. |
| One elevation "level" | **16 px of vertical face** | The vertical step between stacked levels. |

The key invariant: **the diamond top never changes.** A 5-level tower and a flat
grass tile have the *identical* 64×30 top diamond — only the amount of side face
below it differs. That's why you can drop any tile into the same grid cell and its
walkable top surface lands in exactly the same place.

> **Outlines:** the generator bakes a dark edge line into the art and can't turn it
> off, so tiles have a subtle interior outline (a coherent hand-drawn look). The
> outer silhouette rim is softened in post. This is intentional, not a bug.

---

## 3. The heights: `base` through `base_x_5`

Think of a map as having **elevation levels**. One level = 16 px of tile face.

- **`base` (base_x_1) — the ground.** 1 level tall (16 px face). This is your flat
  terrain: the walkable floor you fill areas with. Every ground type has **5 base
  sheets** (~16 tiles each) of natural variation so large areas don't look tiled.

- **`base_x_2` … `base_x_5` — elevation & props.** Taller versions of the *same*
  terrain, **2 / 3 / 4 / 5 levels** tall. Crucially, **stacking is pixel-perfect**:
  a `base_x_3` tile is visually identical to three `base_x_1` tiles stacked, so you
  can build cliffs, plateaus, and raised areas that align exactly, or drop a single
  tall tile as a landmark.

| Tile | Levels | Face height | Canvas | Use it for |
|---|---|---|---|---|
| `base` (x1) | 1 | 16 px | 64×64 | Flat ground, the walkable floor |
| `base_x_2` | 2 | 32 px | 64×128 | Low steps, rocks, bushes, stumps, mushroom clumps |
| `base_x_3` | 3 | 48 px | 64×128 | Mid props: trees, spires, standing stones, cairns |
| `base_x_4` | 4 | 64 px | 64×128 | Tall trees, towers, cliffs, large crystals |
| `base_x_5` | 5 | 80 px | 64×128 | Towering landmarks: giant trees, monuments, peaks |

**What to expect inside each elevation sheet:** *variety*. An elevation sheet is
**not** 16 copies of one object — it's ~16 **different** objects appropriate to that
terrain and height, e.g. for grass: boulders, tree stumps, glowing/red mushrooms,
lavender, tulips, ferns, exposed roots, saplings, standing stones, bird nests …;
scaling up to towering oaks and monuments at `base_x_5`. Stone gives cairns,
menhirs, obelisks, fortress towers; crystal_ice gives crystal spires and ice
pillars; snow gives drifts, snowmen, snow-capped peaks. Each sits on a block of its
terrain so it reads as part of the world.

> The elevation objects are **props/landmarks**, not ground fill — they occupy a
> cell but you don't tile them edge-to-edge like `base`.

---

## 4. Colour normalization (why a type looks like one material)

Left alone, 80 separately-generated grass tiles would each be a *slightly*
different green — and a map built from them looks patchy and cheap. So every tile
is **harmonised**:

1. For each type we auto-detect its **dominant material colour** from its first
   base sheet (the "true" green for grass, white for snow, grey for stone…).
2. Every tile's matching pixels are pulled to that **exact target** — hue,
   saturation, and mean brightness — while keeping their texture and shading.
3. The pull is **hue-band targeted**: only the material moves. A grass tile's green
   snaps to the canonical green, but its **dirt sides, flowers, pebbles, and other
   accents are left untouched**. Mushroom red, wood brown, crystal blue survive.

Consequences you can rely on:

- **Any grass tile matches any other grass tile** — base, elevation, or transition.
  Mix them freely; the greens agree.
- **Transitions harmonise *both* sides**, so a grass→stone border tile's grass
  matches your grass fields *and* its stone matches your stone. Both neighbours
  line up in colour, not just shape.
- **Elevation tiles harmonise toward their terrain** (grass blocks → your grass
  green, stone → your stone grey, ice → your ice blue), so a tree-topped block
  planted in a grass field blends into the field.

The per-type target colour is recorded in each type's `metadata.json`
(`harmonize_target`), so it's stable and inspectable.

---

## 5. Transitions — and the data that makes them auto-placeable

**Reasoning:** two terrains meeting at a hard diamond edge looks like a seam. A
transition tile is grass-on-one-side, stone-on-the-other, blended in the middle, so
the border reads as natural ground.

**Coverage — full pairwise mesh.** Every type gets a transition to **every other
type** (not just "adjacent" ones), with **5 sheets per pair**, each a **different
border style**: soft ragged, clean sharp, patchy islands, wide gradual blend,
interlocking fingers, gentle wavy. So whatever two terrains you put next to each
other, and whatever border feel you want, there's a tile for it. Stored under
`<A>/transitions/<B>/`.

### What's exposed in metadata (read this instead of opening PNGs)

Every tile in a sheet's `metadata.json` carries machine-readable placement data:

- **`composition`** — the fraction of each material on the tile's top diamond, e.g.
  `{"black_mountain": 0.81, "lightdark_dirt": 0.19}`. Tells you the overall mix at a
  glance (is this "mostly A with a bit of B", or a 50/50 blend?).

- **`edges`** — the important one for **auto-tiling**. For each of the four diamond
  edges (**NE, SE, SW, NW**) you get **8 samples along the edge, each labelled with
  the material type-id**, plus a `ratio` and — for a clean single split — a
  `divider` fraction (where along the edge A becomes B). Example:
  ```json
  "NE": { "samples": ["black_mountain","black_mountain","black_mountain",
                       "black_mountain","black_mountain","lightdark_dirt",
                       "lightdark_dirt","lightdark_dirt"],
          "ratio": {"black_mountain":0.625,"lightdark_dirt":0.375},
          "divider": 0.625 }
  ```
  **Neighbour-matching rule:** two tiles fit side-by-side when their shared edge
  agrees. On the iso grid a tile's **SE** edge meets its neighbour's **NW**
  (reversed), and its **NE** meets the neighbour's **SW** (reversed). So a map
  auto-tiler can pick transition tiles whose edges line up material-for-material,
  guaranteeing seamless borders without hand-checking art.

- **`description`** — a short human sentence so you can place a tile without opening
  it, e.g. *"black volcanic rock blending to dirt with a small puddle"*.

- **`features`** — detected standout details on the tile: `flowers`, `pebbles`,
  `shiny`, `water`, `bare_soil`. Handy for "give me a grass tile with flowers".

Base (ground) tiles carry the same fields, but since they're one material their
edges are uniform and `composition` is ~100% one type — the edge data really earns
its keep on transitions.

Elevation sheets expose a different, simpler set: **`objects`** (the list of things
that sheet's tiles depict), **`levels`**, and **`face_px`** — so you know what a
sheet contains and how tall it stands.

---

## 6. Curating the library (source of truth)

**PixelLab is the source of truth.** Every sheet records a PixelLab `tile_id`.

- Browse and **delete** tiles you don't like in **pixellab.ai/maps**.
- The next generation run notices the deletion (the `tile_id` 404s), **removes that
  sheet from the repo**, and **regenerates** it — a fresh roll to replace what you
  cut (for elevation, a brand-new shuffled set of objects).
- **`raw/` is never edited** — it's the untouched download. All colour-normalising
  and metadata are re-derived from it, so processing can be re-tuned and re-run at
  zero generation cost.

So your workflow as a curator is simply: **generate → review in the UI → delete the
duds → regenerate**, repeating until a type's library is all keepers.

---

## 7. Things you might have missed

- **A "sheet" ≈ 16 tiles** = one generation call. Counts (5 base sheets/type, 5
  transition sheets/pair, 3 elevation sheets per terrain×height) are in
  `config/tiles2.json`.
- **Ground vs. props.** `base` tiles tessellate edge-to-edge as terrain. Elevation
  tiles are landmarks/obstacles that occupy a cell — don't expect them to tile like
  ground.
- **Stacking anchors on the top diamond.** When you place elevation, align by the
  64×30 top diamond (the walkable surface) — the face below just fills down toward
  the ground and is occluded by whatever's in front.
- **Reproducibility.** Seeds are derived from ids/indices, so regenerating is
  deterministic where it can be; a re-roll after a deletion intentionally varies the
  seed to give you something new.
- **New terrains extend the mesh.** Adding a ground type automatically means it owes
  a transition to every existing type — the library stays complete.
- **`clear_water`** is a terrain type like any other here (still a solid diamond
  tile); animated water/flow is out of scope for tiles2.
- **Colour agreement ≠ identical tiles.** Harmonisation aligns the *material*
  palette; texture, detail, and features stay varied so areas still look natural.
