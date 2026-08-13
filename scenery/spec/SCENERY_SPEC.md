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

## PixelLab integration (verified live, 2026-08-12/13)

v2.1 (maintainer 2026-08-13): ONE full canvas per piece — multi-candidate
batching retired (icon-grade candidates, stranded review popups, and the
broken-pixel-grid bug all lived there; the first graves were per-pixel mush).

- **≤168px** → `POST /v2/create-8-direction-object` `{description, size,
  view:"low top-down"}` — a real 8-direction object; the loop keeps ONLY the
  SOUTH rotation (the maintainer's "fool PixelLab" rule: never rotates, but
  stays a first-class animatable object). The 8-rotation pipeline rejects
  sizes above 168.
- **>168px** → `POST /v2/create-1-direction-object` `{description, size}` —
  a SINGLE candidate, full canvas, auto-kept, never enters review.
- Either path: **20–40 generations (~$0.09 USD overage) per call**, one call
  per piece. Poll `GET /v2/objects/{id}` to `completed`.
- `PATCH /v2/objects/{id}/tags` `{tags:["SCENERY"]}` — every piece, both
  paths.
- (Retired but kept in the client for sync tooling: `select-frames` returns
  `{created_object_ids}` in candidate order; `dismiss-review` clears a
  stranded review parent.)
- 1-direction objects carry the art in `storage_urls` (rotation_urls are all
  null); `pixellab_client.sprite_url()` resolves it.
- Later animations: `POST /v2/objects/{id}/animations` with `mode:'v3'`
  (cheaper + better than 'pro'); **do not pass `directions`** for 1-direction
  objects — they animate their single direction.
- Balance: `GET /v2/balance` → subscription generations + USD credits. Calls
  draw USD overage when the subscription pool is empty.

## The loop (pipeline/loop.py)

One **piece** = one create call (path by size, above), tag, SOUTH download,
lossless-WebP save, manifest write, viewer rebuild, heartbeat, commit —
pushes go every 8 pieces so a pass doesn't fire a deploy per sprite. Deterministic
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

## Wiki verdicts (pipeline/feedback.py)

The maintainer's wiki rejections (`live/feedback/objects.json`, the live
server's file) are STANDING ORDERS: every loop run starts by deleting each
rejected piece from the store and the repo; the planner refills the slots
the same pass. Legacy pieces are never auto-deleted; a verdict older than
the sprite's last commit is stale (it judged the previous roll) and the
re-roll waits for re-review. A fully-rejected group means the group's
prompt failed — fix the config before regeneration, don't re-roll the same
mistake.

## Costs at a glance

One call per piece: the full 2,650 pieces ≈ 80k generations ≈ ~$240 of USD
overage, or months of the Tier-3 pool (10k/month minus the fleet's 2000
floor ≈ ~265 pieces/month) — quality bought deliberately (AAA, not a coupon
hunt). The daily 100-piece cap and both budget floors make the pace purely a
funding knob the maintainer holds.
