# `tiles/tops/` — top-only ground tiles

**Nothing in this tree is an "x over y" tile, and none of it may ever be offered as
one.** These sheets are judged on the top surface alone; their wall and overhang are
unjudged and unusable, because no prompt here asks for a transition, an edge or a tuft
(maintainer brief 2026-08-27: *"the wall and overhang is 100% unimportant"*).

The isolation is structural, in four places, so a consumer cannot pick this up by
accident: the tree is not `tiles/matrix/` or `tiles/review/`; no directory name carries
`__over__`, the substring every consumer keys on today; every `meta.json` and
`index.json` carries `kind: "top_only"` and `wall_is_meaningless: true`; and the index
is its own schema, `tiles3/tops@1`, not a review manifest. A path here never resolves
against `tiles/review/manifest.json` — nothing in it is a cell.

    tiles/tops/index.json                                   every sheet, ground, flavour, prompt, seed
    tiles/tops/<ground>/sheet_<nn>_<flavour>_<seed>/        16 lossless WebP tiles + meta.json

Two flavours, 3 sheets each per ground, one axis between them — density:

| flavour | what it is for | what the prompt says |
|---|---|---|
| `subtle` | a base-tile-set member: a field of it must not show where the repeat starts | quiet, even, little variation |
| `detail` | a showpiece placed once in a while, never tiled across an area | rich, varied, lots of detail |

`mean_colours` / `mean_dominant_share` in the index measure the TOP FACE only
(`transition_render.top_face`), so they rank the two flavours on the thing being sold.
(Reference: a deliberately flat matrix top is 4 colours / 0.95 dominant, a textured base
candidate 9-14 / 0.30-0.67.)

Prompts: `tiles/config/tops.json` (`tiles3/tops-prompts@1`) — one source of truth, with
the reason each one reads the way it does. Generator: `tiles/pipeline/tops.py`; format is
`matrix.FIXED`, imported, never retyped. $0.096 per 16-tile sheet, 90 sheets ≈ $8.64.

    python3 tiles/pipeline/tops.py --dry-run
