# tiles2 — isometric ground tiles, done right

Second-generation tile system for the game. **Breaking change from `tiles/`**:
this one is organised around a curated list of **specifically-named ground
types**, generated in a loop, with a raw→normalised pipeline so every tile of a
type looks like it belongs, and first-class **transitions** between types.

Part of the multi-domain `pixel` repo (alongside `characters/`, `objects/`,
`maps/`). Everything for this domain lives under `tiles2/`.

## Why specific names

Each subfolder under `tiles2/` is **one ground type** with a deliberately
specific id — `saturated_grass`, `regular_snow`, `normal_dirt`, `stone_mountain`,
`black_mountain`, `clear_water` — **not** the generic "grass". That leaves room to
add `dry_grass`, `jungle_grass`, … later without anyone owning "the one and only
grass".

## House format (every tile)

| setting | value |
|---|---|
| Tile size | **64×64 px** |
| Tile type | **isometric** |
| View preset | **high top-down** |
| Angle | **28.0°** |
| Thickness | **0.50** |
| Top/bottom pixels | **2 px (classic)** |
| Outline | **none** |

`create-tiles-pro` has no outline parameter, so "no outline" is asked for in the
prompt and any residual dark rim is removed in post-process (see below).

## Folder layout (per ground type `<gid>`)

```
tiles2/<gid>/
  metadata.json                 type meta + ref_sprite pointer
  raw/<sheet>/                   raw download — SOURCE OF TRUTH, never edited
    tile_00.png … request.json   (exact prompt + settings + kind: base|transition)
  base/<sheet>/                  post-processed base tiles (normalised)
    tile_00.png …
  transitions/<other>/<sheet>/   post-processed transition tiles  (gid → other)
    tile_00.png …
```

A **sheet** = one `create-tiles-pro` request (~16 tiles).

## The pipeline

1. **generate** (`pipeline/generate.py`) — one request → `raw/<sheet>/` with a
   `request.json` recording the exact prompt, settings, seed, and whether it was a
   **base** sheet (this ground type) or a **transition** sheet (this type → other).
   Raw is *always* kept.
2. **postprocess** (`pipeline/postprocess.py`) — copies each raw sheet into
   `base/` or `transitions/<other>/`, and:
   - **neutralises the outline** — recolours any dark silhouette rim toward the
     tile's interior colour (kept opaque, so no erosion / no seams);
   - **normalises colour to the ref-sprite(s)** so a type's sheets match:
     - *base* → the type's own ref-sprite;
     - *transition* → **both** refs (the "from" type's ref normalises its
       material, the "to" type's ref normalises the other).
   - If a needed **ref-sprite isn't declared yet**, tiles are copied as-is (outline
     still neutralised).
3. **loop** (`pipeline/loop.py`) — each unit picks the next thing to make from the
   filesystem (resumable): **base tiles first** (round-robin across types up to
   `targets.base_sheets_per_type`), then the configured **transitions**. Generates,
   post-processes, commits, pushes. *Not scheduled yet — run manually while we tune.*

### The ref-sprite (how "looks like it belongs" is enforced)

Each `metadata.json` has a `ref_sprite` pointer — a single tile that defines the
type's target **brightness / hue / saturation**:

```json
"ref_sprite": { "sheet": "base_123", "tile": "tile_03.png" }
```

Pick the best-looking raw tile, point `ref_sprite` at it, and re-run
`postprocess.py` — every base tile is normalised to match, and every transition
that touches this type is normalised on this type's side. Because raw is never
touched, you can re-pick the ref or retune the post-process and re-run over
everything at zero API cost.

## Running

```bash
pip install -r ../requirements.txt
export PIXELLAB_API_KEY=...             # gitignored .env

python pipeline/loop.py --dry-run        # show the plan; no API calls
python pipeline/loop.py --once           # generate the next single sheet
python pipeline/loop.py --max-minutes 45 # a bounded pass
python pipeline/postprocess.py           # re-run normalisation from raw (no API)
python pipeline/postprocess.py saturated_grass   # just one type
```

Config: `config/tiles2.json` (house format, ground types, transition pairs,
targets, post-process knobs).

## Status / open items

- **Transition normalisation** splits pixels between the two refs by hue
  (first-pass); refine toward spatial segmentation once we see real output.
- **No-outline** relies on prompt + post-process neutralisation; validate on the
  first real sheet and tune `postprocess.darkness_thresh` if any rim survives.
- Ground-type list and transition pairs are a starting set — edit
  `config/tiles2.json` to add/adjust.
