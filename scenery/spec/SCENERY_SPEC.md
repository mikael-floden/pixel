# Scenery Spec — the v2 grouped factory (S-only, batched, tagged)

> v2, 2026-08-12 — replaces the v1 8-direction spec (git history). "Object"
> below is PixelLab's product term for the store entity a scenery piece
> persists as. **Scenery** = freely placeable, optionally animated set
> dressing: doesn't follow the tile grid, can animate. The maps2 agent places
> it; the maintainer approves/rejects it in the wiki.

## The structure (maintainer's design)

1. **100 ranked types**, each a group folder `scenery/<group>/`. Rank means
   placement FREQUENCY (how often a world-builder drops one), which is why it
   also decides quantity.
2. **Quota** `= max(2, 102 - 2*rank)`: trees 100, stones 98, … floor 2 so
   every type ships both light versions. 2,650 pieces total.
3. **Two versions of every type**: LIGHTS_OFF (no self-emission) and LIGHTS_ON
   (self-emissive), half/half, interleaved odd/even so both exist from the
   first pair. Each type carries 4–8 curated, visually distinct
   `glow_concepts`; a lit piece draws one deterministically.
4. **SOUTH only** — no rotations, ever. Animations later, S-only, one idle
   per type (`animation_idea`).
5. **Every created object is tagged `SCENERY`** on PixelLab.
6. **Sizes are real-world**: each type has a `world_height_m` range (64px =
   1.7m human) and an `art_size` canvas; per-piece height is seeded within
   the range and lands in `placement.world_px_height`.

The full catalog (descriptions, variety axes, glow concepts, ranks) lives in
`config/factory.json → groups`, produced by a lore-grounded multi-agent
design pass (10 themed drafts × 10 → 3-lens ranking with the world-density
lens weighted double → adversarial verify → synthesis) and hand-audited.

## PixelLab integration (verified live, 2026-08-12)

- `POST /v2/create-1-direction-object` `{description, size, view:"top-down",
  item_descriptions:[...]}` → `{object_id, background_job_id}`. Costs
  **20–40 generations per call**, but the effective size decides how many
  candidate objects ONE call produces: ≤42px → 64, ≤85 → 16, ≤170 → 4,
  else 1 — each candidate drawn from its own `item_descriptions` entry.
  Measured: a 16-piece 64px call = **$0.09** in USD-credit overage.
- Poll `GET /v2/objects/{id}` → status `review` (multi-candidate) or
  `completed` (single).
- `POST /v2/objects/{id}/select-frames` `{indices, common_tag:"SCENERY"}` →
  `{created_object_ids: [...]}` in candidate order — every kept candidate
  becomes its own completed object, already tagged.
- `PATCH /v2/objects/{id}/tags` `{tags:["SCENERY"]}` — the single-candidate
  path tags explicitly.
- 1-direction objects carry the art in `storage_urls` (rotation_urls are all
  null); `pixellab_client.sprite_url()` resolves it.
- Later animations: `POST /v2/objects/{id}/animations` with `mode:'v3'`
  (cheaper + better than 'pro'); **do not pass `directions`** for 1-direction
  objects — they animate their single direction.
- Balance: `GET /v2/balance` → subscription generations + USD credits. Calls
  draw USD overage when the subscription pool is empty.

## The loop (pipeline/loop.py)

One **batch** = one create call (up to `max_batch`=16 pieces of one group at
the group's art size), then select+tag, download, lossless-WebP save,
manifest write, viewer rebuild, heartbeat, commit, push. Deterministic
planner (`catalog.py`): the group with the fewest finished pieces that still
has quota goes first (tie → rank) — early variety, importance wins over time.
Budget gate: subscription pool above the shared 2000 floor OR credits above
`min_usd`; else stop cleanly and retry next day. Caps: `--max-pieces`
(default `budget.daily_pieces` = 100), `--max-minutes`, `--max-batches`,
`--once`, `--dry-run`.

Failure honesty: a batch that can't map candidates to pieces RAISES (never
guesses); a piece without a downloaded sprite is re-planned next run;
`sync.py` reports SCENERY-tagged store orphans instead of adopting or
deleting them.

## Sync (pipeline/sync.py)

Deletion parity (UI delete → repo delete), loose-pointer prune, changed-art
re-mirror via If-Modified-Since, orphan report. Writes lossless WebP only.

## Costs at a glance

~680 calls for the full 2,650 pieces ≈ 20k generations ≈ 2 months of the
Tier-3 subscription pool (10k/month) — or ~$60 of USD credits at the measured
overage rate. The daily 100-piece cap spreads it and leaves the shared pool
headroom the moment the monthly generations reset.
