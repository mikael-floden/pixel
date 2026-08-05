# tiles2 tile metadata — the contract for consumers (maps2 et al.)

**tiles2 owns this metadata.** Every base and transition tile ships with per-tile
`edges` + `composition` in its sheet's `metadata.json`, computed against the
harmonized canonical material colors. A tile is **not "done"** until this exists —
`postprocess` records `metadata_complete: true` per sheet and warns loudly on any
gap. So consumers can read it directly and never need to re-derive from pixels.

## Where it lives

```
<type>/base/<sheet>/metadata.json            # base (ground) tiles
<type>/transitions/<other>/<sheet>/metadata.json   # <type> → <other> transitions
<type>/base_x_N/<sheet>/metadata.json        # elevation (see note below)
```

Each `metadata.json` describes one sheet (~16 tiles):

```json
{
  "schema": "tiles2/sheet@1",
  "sheet": "trans_saturated_grass_123", "ground_type": "lightdark_dirt",
  "kind": "transition", "transition_to": "saturated_grass",
  "tile_id": "…", "count": 16, "metadata_complete": true,
  "tiles": [ { …per-tile… }, … ]
}
```

## Per-tile fields (base + transition)

* **`composition`** — fraction of each material over the tile's TOP diamond, e.g.
  `{"lightdark_dirt": 0.62, "saturated_grass": 0.38}`. Materials are type-ids.
* **`edges`** — for each diamond edge `NE`, `SE`, `SW`, `NW`:
  ```json
  "NE": { "samples": ["dirt","dirt","dirt","dirt","dirt","grass","grass","grass"],
          "ratio": {"dirt":0.625,"grass":0.375}, "divider": 0.625 }
  ```
  `samples` = 8 material-ids sampled along the edge (ordered along the edge);
  `ratio` = material fractions; `divider` = split fraction (present only for a
  clean single A|B split).
  **Neighbour-matching (Wang / corner):** on the iso grid a tile's `SE` edge meets
  its neighbour's `NW` **reversed**, and `NE` meets the neighbour's `SW`
  **reversed**. So two tiles abut seamlessly iff `A.SE == reverse(B.NW)` and
  `A.NE == reverse(B.SW)` material-for-material.
* **`features`** — standout details detected on the top: any of
  `flowers`, `pebbles`, `shiny`, `water`, `bare_soil`.
* **`description`** — short human string (e.g. "dirt blending to grass with pebbles").

## Elevation tiles (`base_x_2..5`) are different

Elevation tiles are **props/landmarks placed on a cell**, not edge-tiled borders,
so they carry **placement** metadata instead of edge codes:
`ground_type` (the terrain they sit on), `levels`, `face_px`, and `objects`
(what the sheet depicts). Edge/corner matching does not apply to them.

## Geometry (shared by every tile)

Isometric diamond, 64px wide, view angle 28°, **30px diamond top**, **16px per
elevation level** (base_x_1 face = 16px; base_x_N face = N·16px). All tiles share
this exactly, which is what makes the edge samples comparable across tiles.

## If you need a different encoding

If a consumer needs the edge data in another form (e.g. a single corner-code per
corner for Wang tiling, or a coarser/finer sample count), that's a tiles2
responsibility — ask on the coordination board and we'll add it here rather than
have you re-derive from pixels.
