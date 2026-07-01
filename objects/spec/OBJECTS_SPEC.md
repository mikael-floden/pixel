# Objects Spec — Pixel Object Factory (persistent 8-direction objects)

## Goal

An automated, resumable loop that produces **game-ready pixel-art objects** —
props, tools and items that make a *Grave Seasons*-style map come alive (trees,
chests, coins, torches, wells, mushrooms, barrels…). Every object is a **real,
persistent PixelLab object**: it shows in the PixelLab **create-object** web tool
(so a human can regenerate it if it looks bad), it animates, and it **syncs back**
into this repo. This is the object analogue of the character system.

## What every object is

- A **persistent 8-direction object** created with `create-8-direction-object`
  (returns a `pixellab_object_id`; 8 rotations). **Always 8 directions.**
- Sized for its **type**: `size` (32–256, a single square int) scales with the
  object — a coin ~48px, a chest ~64px, an oak ~128px.
- Carries exactly **3 animations chosen to fit it** (chest → open/close/rattle,
  coin → spin/flip/bounce, tree → sway/rustle/shake…), each generated across
  **all 8 directions** at **max frames (16, mode v3)**.
- Drawn in the shared **Grave Seasons** style (`style_base`, selective outline,
  painterly shading).

## Realism rule — world scale

Art size ≠ world size. Each object declares a real-world height `world_height_m`
(or a `scale.category_height_m` fallback); the loop derives
`world_px_height = round(world_height_m * character_height_px / character_height_m)`
(reference: 64px = 1.7m) into each manifest's `placement`. A game renders the
sprite scaled to `world_px_height` beside a 64px character, so a coin (~8px) is
tiny and an oak (~226px) towers. Nothing ships without a `placement`.

## PixelLab integration (verified, v2)

- `POST /create-8-direction-object` `{description, size, view}` →
  `{object_id, background_job_id}`; poll the job, then `GET /objects/{id}` for
  `rotation_urls` (8 PNGs).
- `POST /objects/{id}/animations` `{animation_description, frame_count,
  directions}` → `{animation_group_id}`; frames land **asynchronously per
  direction** — poll `GET /objects/{id}` until all 8 directions of the group have
  `storage_urls.frames`, then download. `frame_count`: even 4–16 (v3), max **16**.
  **Pass all 8 directions** — omitting it animates a single direction (the bug we
  hit first).
- `GET /objects` (list), `GET /objects/{id}` (detail), `DELETE /objects/{id}`.
- There is **no** object *create* on `/objects` itself (`POST /objects` → 405)
  and the character endpoints only make humanoids — `create-8-direction-object`
  is the one true object-create path.
- Auth: `Authorization: Bearer $PIXELLAB_API_KEY`. Balance/generations on
  `/v2/balance`.

## Loop algorithm

The next unit is derived from the filesystem (resumable); each unit commits +
pushes:

```
for object in (catalog then procedural up to targets.num_objects):
    if no sprite.png                 -> create the 8-direction object   (1 unit)
    else for each of its 3 anims     -> if missing, animate all 8 dirs  (1 unit each)
-> all objects complete
```

Every pass also (zero-cost): `sync` mirrors any PixelLab-side regenerations /
deletions in, and `refresh_placement` re-derives world scale.

## Sync (PixelLab is the source of truth)

`sync.py` mirrors each tracked object (`pixellab_object_id`) from PixelLab into
the repo — rotations + animations — only re-downloading frames whose
`Last-Modified` changed (`If-Modified-Since` → 304 skip), exactly like the
characters agent. **Regenerate an object in the create-object web tool → sync
pulls it down.** Deletion parity: an object removed on PixelLab is removed from
the repo (and vice-versa via `--restyle`), so there are never loose pointers.

## Packaging

Per object: `sprite.png` (south) + `rotations/<dir>.png` (8). Per animation, per
direction: `animations/<key>/<dir>/NN.png` frames + `animations/<key>__<dir>.png`
strip + `animations/<key>__<dir>.gif` preview. `object.json` indexes it all;
`viewer_build.py` rolls everything into `viewer_data.json` for `index.html`.

## Cost model

base (8 rotations) + 3 animations × 8 directions × up to 16 frames. This is the
heaviest domain per object, so the loop is budget-aware (floor **2000**, shared
pool — see `coordination/PROTOCOL.md`) and runs durably on GitHub Actions.
