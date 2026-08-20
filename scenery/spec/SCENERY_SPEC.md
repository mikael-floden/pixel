# Scenery Spec — the v2 grouped factory (S-only, one canvas per piece, tagged)

> "Object" is PixelLab's product term for the store entity a scenery piece
> persists as. **Scenery** = freely placeable, optionally animated set
> dressing: doesn't follow the tile grid, can animate. The maps2 agent places
> it; the maintainer approves/rejects it in the wiki. (v2 replaced the v1
> 8-direction spec 2026-08-12 — git history.)

## The structure (maintainer's design)

1. **Ranked types**, each a group folder `scenery/<group>/`. Rank means
   placement FREQUENCY (how often a world-builder drops one), which is why it
   also decides quantity. 172 groups; 109 carry an explicit `quota` field
   overriding the rank formula (indoor/house detail, mountain-wall decor,
   wall hangings, rare/special caps, demand multipliers, saturation freezes).
2. **Quota** `= max(2, 102 - 2*rank)` unless the group sets `quota`; floor 2
   so every type ships both light versions. The plan total
   (`viewer_data.json → groups`, ~2,125 and shrinking) is a priority
   ordering; the hard stop is `config/factory.json → goal.target_pieces` =
   **1,000 live pieces**.
3. **Two versions of every type**: LIGHTS_OFF (no self-emission) and LIGHTS_ON
   (self-emissive), half/half, interleaved odd/even so both exist from the
   first pair. Each type carries a curated set of visually distinct
   `glow_concepts` (2–9 per type); a lit piece draws one deterministically.
4. **SOUTH only — no rotations** — except groups with `keep_directions`
   (windows keep SE/S/SW: walls face three ways; free on the ≤168 path, and
   every kept facing must pass the edge gate). Animations later, S-only, one
   idle per type (`animation_idea`).
5. **Every created object is tagged `SCENERY`** on PixelLab.
6. **Sizes are real-world**: each type has a `world_height_m` range (64px =
   1.7m human) and an `art_size` canvas; per-piece height is seeded within
   the range and lands in `placement.world_px_height`.

The full catalog (descriptions, variety/modifier axes, glow concepts, ranks)
lives in `config/factory.json → groups`; the `_comment` there is the running
law-book of the maintainer's taste verdicts — read it before changing any
prompt. (Origin: a lore-grounded multi-agent design pass, hand-audited.)

## PixelLab integration (verified live)

One full canvas per piece (v2.1 — multi-candidate batching retired:
icon-grade candidates, stranded review popups, and the broken-pixel-grid bug
all lived there; the first graves were per-pixel mush).

- **≤168px** → `POST /v2/create-8-direction-object` `{description, size,
  view:"low top-down"}` — a real 8-direction object; the loop keeps only
  SOUTH plus any `keep_directions` (the maintainer's "fool PixelLab" rule:
  never rotates, but stays a first-class animatable object). The 8-rotation
  pipeline rejects sizes above 168.
- **>168px** → `POST /v2/create-1-direction-object` `{description, size}` —
  a SINGLE candidate, full canvas, auto-kept, never enters review. This
  endpoint 422s on long descriptions (measured: 2,010 accumulated chars
  killed a whole batch) — the loop trims the piece-specific body to ≤1,000
  chars, never the style laws.
- Either path: **20–40 generations (~$0.09 USD overage) per call**, one call
  per piece; **~$0.16 per piece DELIVERED** after gate re-rolls (measured
  2026-08-15). Poll `GET /v2/objects/{id}` to `completed`.
- `PATCH /v2/objects/{id}/tags` `{tags:["SCENERY"]}` — every piece, both
  paths.
- 1-direction objects carry the art in `storage_urls` (rotation_urls are all
  null); `pixellab_client.sprite_url()` resolves it.
- States (`pipeline/lights_on.py`): `POST /v2/objects/{id}/states` re-renders
  the object with a text edit and saves the result as a sibling object
  sharing `group_id` — how windows get LIGHTS_ON.
- Animations: `POST /v2/objects/{id}/animations` with `mode:'v3'` (cheaper +
  better than 'pro'); **do not pass `directions`** for 1-direction objects —
  they animate their single direction.
- Balance: `GET /v2/balance` → subscription generations + USD credits. Calls
  draw USD overage when the subscription pool is empty.
- Retired but kept in the client for sync tooling: `select-frames` (returns
  `{created_object_ids}` in candidate order), `dismiss-review` (clears a
  stranded review parent).

## The loop (pipeline/loop.py)

One **piece** = one create call (path by size, above), tag, SOUTH download,
lossless-WebP save, manifest write, viewer rebuild, heartbeat. COMMIT per
piece; PUSH at 10 pending pieces or 240 s, whichever first (the deploy's
concurrency group keys on `github.sha` and collapses nothing — push-per-piece
ran ~180 concurrent Docker builds/hour). Several jobs in flight at once
(`budget.parallel_jobs`); `touch scenery/.stop` drains in-flight jobs and
stops.

Deterministic planner (`catalog.py`): pick the group with the LOWEST
Laplace-smoothed fill fraction `(done+1)/(quota+1)` × its `demand` multiplier
(ties → rank). Not absolute fewest-first — it poured pieces into refilled
2-quota groups while trees sat at 30/100. The `+1` smoothing is load-bearing:
without it every brand-new tiny group scores 0 and outranks the big wanted
families. `demand < 1.0` marks always-wanted groups so nature keeps flowing.

Budget gate: subscription pool above the shared 2000 floor OR credits above
`min_usd`; else stop cleanly and resume next pass. Caps: `--max-pieces`
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
re-roll waits for re-review. A fully-rejected group means the group's prompt
failed — fix the config before regeneration, don't re-roll the same mistake.

## Costs at a glance

One call per piece, 20–40 generations; budget with ~$0.16 per piece
delivered (measured 2026-08-15). The shared subscription is PixelLab
**Tier 3**: 10k generations/month for the whole fleet (25 concurrent jobs —
`state_variants.py` runs 8 to leave headroom), minus the fleet's 2000
floor; calls draw USD overage once that pool is spent. Quality is bought
deliberately (AAA, not a coupon hunt). The per-pass cap and both budget
floors bound every run, and generation stops for good at the 1,000-piece
goal — the pace is purely a funding knob the maintainer holds.
