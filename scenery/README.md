# Nangijala Scenery

**Scenery** is the game's freely placeable, optionally animated set dressing —
trees, stones, graves, braziers, streetlights… A scenery piece differs from a
tile in two ways that define this domain:

1. **It can be placed anywhere** — it does not have to follow the tile grid
   (tiles are `tiles2/`'s job).
2. **It can animate** — tiles cannot.

Owned by the **scenery agent** (board file `coordination/scenery.json`).
Generated on [PixelLab](https://pixellab.ai); the **maps2 agent** places
scenery in worlds; the game (`games2/`) renders it; the **maintainer**
approves/rejects/comments every piece in the wiki's Scenery section.

> **History:** this directory was `objects/` until 2026-08-12, when the
> scenery agent took over, renamed the domain end to end, and the same day
> replaced the dormant v1 8-direction factory with the **v2 grouped factory**
> below. The 16 deleted first-round props live in git history.

## The v2 factory — the maintainer's structure (2026-08-12)

- **100 ranked TYPES**, each a group folder `scenery/<group>/` (designed in a
  lore-grounded multi-agent pass; ranked so quota tracks how often a
  world-builder actually places the thing).
- **Quota per type follows the rank**: `quota(rank) = max(2, 102 - 2*rank)` —
  #1 `trees/` 100 pieces, #2 `stones/` 98, … floor 2 so EVERY type ships at
  least one lit + one unlit piece. **2,650 pieces total.** One knob
  (`config/factory.json → quota_rule`) grows the bottom half later.
- **LIGHTS_ON / LIGHTS_OFF**: every type is half self-emissive, half not,
  interleaved — odd piece numbers unlit, even lit, each lit piece drawing one
  of the type's curated `glow_concepts`. In this world glow is lore-loaded:
  light is memory being kept (lore/RED_LINE.md).
- **SOUTH only.** Scenery never rotates: pieces are 1-direction PixelLab
  objects — no rotations generated, stored, or paid for. Animations come later
  (S-only), one idle per type (`animation_idea` in the config).
- **Every PixelLab object is tagged `SCENERY`** (the tag is applied by
  `select-frames`' `common_tag` / `PATCH /objects/{id}/tags` at creation).
- **Deterministic**: `pipeline/catalog.py` derives every piece's id, variety,
  glow, height and prompt from seeded hashes — the filesystem alone says what
  is next, so any run resumes exactly where the last one stopped.

### One full canvas per piece (v2.1, maintainer 2026-08-13)

Multi-candidate batching is retired: shared-canvas candidates read as icons,
stranded review popups in the maintainer's UI, and carried the broken-pixel
bug (the first graves came out as per-pixel mush; single-canvas pieces were
crisp). Now every piece gets the model's full attention — quality first, this
is a AAA project:

- **≤168px** → `create-8-direction-object` (view `low top-down`), keeping
  ONLY the SOUTH rotation. Scenery never rotates, but generating as a real
  8-direction object keeps every piece a first-class animatable store
  citizen — the maintainer's "fool PixelLab" rule.
- **>168px** (the 8-rotation cap) → a SINGLE-candidate
  `create-1-direction-object`: full canvas, auto-kept, never enters review
  (tree_001, the crisp birch, was born this way).

Either path costs **20–40 generations (~$0.09 of USD overage) per piece**.
Whole-catalog: ~2,650 calls ≈ 80k generations — months of the Tier-3 pool
plus credits at whatever pace the maintainer funds. The loop's budget floors
make running out a clean pause, never an error.

### Daily rhythm

`.github/workflows/scenery.yml` runs the loop daily (02:30 UTC), capped at
~100 pieces/day (`budget.daily_pieces`). The loop stops cleanly at the budget
floor — subscription pool below `min_generations_remaining` (the fleet's
shared 2000 floor, coordination/PROTOCOL.md) AND credits below `min_usd` —
and simply resumes the next day. Manual pass: Actions → "Scenery factory
loop" → Run workflow.

### Wiki verdicts are standing orders (maintainer, 2026-08-13)

The maintainer's approve/reject clicks in the wiki land in
`live/feedback/objects.json` (committed by the live server — its file, never
edited from here). **A rejection is a standing removal order**: every loop
run starts with `pipeline/feedback.py`, which deletes each rejected piece
from the PixelLab store AND the repo, then the planner refills the freed
slots with fresh rolls in the same pass. Rails: the three legacy pieces are
never auto-deleted, and a verdict older than the piece's last sprite commit
is stale (it judged the slot's PREVIOUS occupant) — the re-roll survives
until re-reviewed. When a whole group is rejected, the group's prompt is
wrong, not the dice — fix `config/factory.json` before the slots refill
(first done 2026-08-13: briar_thickets drew rose arches, cairns drew pebble
columns, anvils fused floating tools, dovecotes read as birdhouses,
fading_relics forgot to be ghosts).

### Pixel-perfect QA is the agent's own duty (maintainer, 2026-08-13)

PixelLab sometimes fails to draw clean deliberate pixels — an "absolute no
go" the agent removes on its own, without waiting for the maintainer's
review. `pipeline/pixel_qa.py` builds zoomed contact sheets of every piece
no one's eyes have cleared (`--sheet`), the agent LOOKS at them, condemns
broken pieces (`--condemn` → deleted from store + repo, slot re-rolls) and
stamps the rest (`--pass-rest`, log in `config/qa_log.json`). This is
deliberately visual: six statistical metrics were calibrated against 213
approved pieces, the 16 known-mush graves and 225 rejected sprites from git
— all overlapped completely (the painterly style is legitimately
gradient-dense), while zoomed inspection separates them every time. Wiki
verdicts count as checked by the maintainer's own eyes (with the same
staleness guard as feedback.py).

### The catalog beyond the first 100 (maintainer, 2026-08-13)

Groups 101–110 carry an explicit `quota` (the rank formula would floor them
at 2): **mountain-wall decor** (`cliff_vines`, `cliff_features` — freely
placeable over the repeating wall tiles), **indoor/house detail** so a house
feels lived in (`tables`, `chairs_and_benches`, `beds`,
`cupboards_and_shelves`, `hearths`, `rugs_and_hides`, `house_clutter`), and
**`wall_hangings`** for the coming mechanic where a room's top walls stay
visible (bottom walls hide to unveil the player) — those pieces render
face-on, pinned to interior walls. Regional identity is the zoom-out goal:
trees/stones variety axes were deepened so maps2 can theme AREAS with
coherent subsets — one region's trees are not another's.

## What a piece is, on disk

```
scenery/<group>/<piece>/
  scenery.json      the manifest (id, group, rank, name, lights, variety,
                    glow_concept, prompt, size, sprite, placement,
                    pixellab_object_id, tags, animations)
  sprite.webp       the SOUTH sprite (lossless WebP; lossless=True AND
                    exact=True — both non-default, both mandatory)
```

Three **legacy pieces** stay at the top level, 8-direction, game-referenced,
frozen — never regenerate them:

| id | what the game does with it |
| --- | --- |
| `campfire` | the spawn bonfire (`burn__south`) — also a real shader light; the tiles2 bonfire *tile* pins its exact light params |
| `grave_cross` | rises where a monster died — the maintainer's own PixelLab object |
| `blood_spatter` | plays on every landed hit — the maintainer's own, stored deliberately TRIMMED (see its manifest's `edited` note) |

### Sizing scenery in the world

Art resolution ≠ world size. Each piece carries `placement.world_px_height`
(from its seeded `world_height_m`; 64px = 1.7m character) — render the sprite
scaled to that height and everything composes at believable scale. Group art
sizes live in the config; heights vary per piece inside the group's range.

## Random horizontal flip — the game's half of the deal

Scenery is generated SOUTH-only, and a south-facing sprite is still itself
mirrored. The maintainer's observation (2026-08-14): placing each piece with a
random horizontal flip doubles the variety of every group for nothing. The 73
trees × 7 variants become 1,022 distinct trees on screen.

Every piece therefore publishes:

```json
"must_be_imbplemented_with_random_hflip": true
```

It is written into each `scenery.json` and republished in `viewer_data.json`, so
a consumer never has to infer it. `loop.py` stamps it at birth, which is what
keeps it true for pieces that do not exist yet.

**It is `false` on 42 pieces and that matters.** The windows carry SE/S/SW
facings and the three legacy pieces carry all eight; for those, left and right
are already meaningful. Mirroring a south-east window produces a south-west one,
which the game would then hang on an east-facing wall. Read the flag per piece.

## Who consumes this domain

- **games2** — bakes `scenery/` into its image (`/assets/scenery/...`); draws
  the three legacy pieces via hardcoded URLs in `WorldScene.ts`.
- **wiki** — `wiki/build.mjs buildObjects()` scans every
  `scenery/<group>/<id>/scenery.json` (groups become the wiki's categories);
  the maintainer approves/rejects/comments pieces there. Internal domain key
  is still `objects` (route slugs are URLs — the wiki agent's call).
- **lore** — `lore/pipeline/build.py` reads the manifests for per-entity lore.
- **maps2** — places scenery in worlds (post a board request for specific
  props; check `viewer_data.json → groups` for what exists).
- **Deploys** — a push touching `scenery/**` auto-deploys the game;
  `.dockerignore` must allowlist the domain (`!scenery`) or assets 404 in prod.

**Light budget rule** for anything emissive (half of all scenery!): the
renderer has **8 world light slots** — `games2/spec/LIGHT_BUDGET.md`; run
`node games2/scripts/check-light-budget.mjs` before shipping worlds placing
glowing scenery. LIGHTS_ON art carries baked glow (self-emission in the
sprite); becoming a real shader light is a separate, budgeted decision made
at placement time (tiles2/emission.json pattern).

## Run it

```bash
pip install -r ../requirements.txt
export PIXELLAB_API_KEY=...            # gitignored .env; NEVER committed

python pipeline/loop.py --dry-run                # see the plan, spend nothing
python pipeline/loop.py --once                   # one piece
python pipeline/loop.py --max-pieces 100         # a daily-sized pass
python pipeline/sync.py --dry-run                # reconcile report
python pipeline/feedback.py --dry-run            # pending wiki rejections
```

Each **piece** (one API call) is generated, downloaded, manifest-written;
the loop rebuilds `viewer_data.json`, refreshes the heartbeat, commits, and
pushes every 20 pieces. `sync.py` keeps PixelLab and the repo in
lockstep: deletion parity (reject-and-delete in the UI propagates here),
loose-pointer pruning, changed-art re-mirror (If-Modified-Since), and an
orphan report for SCENERY-tagged store objects nothing tracks. v2 sync writes
lossless WebP only.

## Browse it

- In-game wiki: the **Scenery** section (`/assets/wiki/site/`) — approval UI.
- `index.html` + `viewer_data.json` — the domain's own gallery with a
  to-scale character comparison (`python -m http.server` in this folder).
- `viewer_data.json → groups` — per-group quota/done progress at a glance.

## Don't

- **Never commit secrets** — `PIXELLAB_API_KEY` lives in a gitignored `.env`.
- Don't regenerate the maintainer's legacy pieces.
- Don't raise `quota_rule` or `budget` knobs on your own — maintainer's call.
- Don't re-pose art locally — PixelLab owns drawing/animation; this domain
  owns orchestration, packaging, QA-of-output, and the viewer.
