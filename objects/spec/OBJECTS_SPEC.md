# Objects Spec — Pixel Object Factory

## Goal

An automated, resumable loop that produces good-looking, **game-ready pixel-art
objects** (props / tools / items) via the PixelLab API, in the *Grave Seasons* /
Stardew Valley style. It is a sibling domain to `characters/` and `maps/` and
stays entirely inside `objects/`.

## Definitions

- **Object** — one prop/tool/item, stored as a self-contained folder
  `objects/<id>/`. Examples: chest, gold coin, rock, bird, sword, shovel, tree,
  torch, potion, well.
- **Base sprite** — the object's single canonical image, generated from text with
  `generate-image-pixflux`, transparent (`no_background`), facing `south`.
- **Rotation** — the same object turned to another direction with `rotate`
  (4- or 8-direction sets). Optional, per object.
- **Animation** — a short looping clip generated with `animate-with-text` from a
  text *action* (spin, open, sway, flicker, flap…). Optional, per object.

## Why these three tools

PixelLab exposes different capabilities for characters vs. arbitrary art. Objects
aren't bipedal, so the character rig/`animate-character` path doesn't apply. The
**image tools** do:

| Need              | Endpoint (`/v1`)              | Cost   | Notes |
|-------------------|-------------------------------|--------|-------|
| Base sprite       | `generate-image-pixflux`      | 1 gen  | text → one sprite; `no_background`, `view`, `outline/shading/detail`, `isometric` |
| Rotated views     | `rotate`                      | 1 gen  | one sprite → one target direction/view |
| Animation         | `animate-with-text`           | 1 gen  | one sprite → a few frames from a text action |

We deliberately **only** build what these support, and we lean into what they do
well:

- **Transparent single-asset sprites** (`no_background=true`) — drop-in game art.
- **`view`** per object: `low top-down` for world props, `side` for held tools /
  side-scroller items (sword, torch, bird).
- **`isometric`** and **`outline`/`shading`/`detail`** knobs for style control.
- **Rotation** for directional props (a barrel, a sign post) via the same
  direction vocabulary characters use.
- **Text animation** for the motions objects actually need — no skeleton required.

We **don't** attempt things PixelLab objects can't do: no per-part rigging, no
layered/compositing objects, no multi-object scenes in one sprite (that's the
`maps/` domain's job).

## Verified PixelLab integration

All three endpoints are **synchronous** on the `/v1` API (base
`https://api.pixellab.ai/v1`, `Authorization: Bearer $PIXELLAB_API_KEY`) — the
POST returns the finished art inline; there is no background job to poll (that's a
`/v2` character-endpoint concern).

- `POST /generate-image-pixflux` → `{ "image": {"type":"base64","base64": <PNG>}, "usage": {"generations": 1} }`.
  Params used: `description`, `image_size {width,height}`, `no_background`, `view`,
  `direction`, `outline`, `shading`, `detail`, `isometric`, `negative_description`,
  `text_guidance_scale`, `seed`.
- `POST /rotate` → `{ "image": {...}, "usage": {...} }`. Params: `from_image`
  (Base64Image), `image_size`, `from_view`/`to_view`, `from_direction`/`to_direction`,
  `isometric`, `seed`.
- `POST /animate-with-text` → `{ "images": [ {...}, ... ], "usage": {...} }`.
  Params: `reference_image`, `description`, `action`, `image_size`, `view`,
  `direction`, `n_frames`, `seed`. **Requires `image_size` ≥ 64×64** (smaller
  422s), so any animated object is generated at ≥ 64×64. Frame 0 is the reference
  pose; the endpoint may return fewer frames than requested — we keep what comes
  back.

Response images are PNG-encoded base64 (decoded straight to Pillow), unlike the
character animate endpoint's raw `rgba_bytes`.

## Object model (`config/objects.json`)

- `defaults` — view/outline/shading/detail/no_background/guidance/negative applied
  to every object unless overridden.
- `catalog` — the curated objects. Each: `id`, `name`, `category`, `description`,
  `size [w,h]`, optional `view`/`direction`, `rotations` (0/4/8), `animations`
  (a list of `animation_library` keys or inline `{key, action, n_frames, view}`).
- `animation_library` — reusable motions (spin, open, glint, flicker, burn, sway,
  flap, flutter, swim, bob, pulse, ripple, bubble). `action` is kept to one short
  phrase — extra words confuse the model.
- `procedural` — `kinds` × `adjectives` used to synthesize further objects once
  the catalog is exhausted, up to `targets.num_objects`. Deterministic in the
  object index (seeded), so re-runs are reproducible.

## Realism rule — world scale (objects must fit beside characters)

An object's **art resolution is not its world size.** Every object declares a
real-world height `world_height_m` (per-object, or a `scale.category_height_m`
fallback), and the loop derives the pixel height it should occupy in-world:

```
world_px_height = round(world_height_m * character_height_px / character_height_m)
```

with the character reference in `config/objects.json → scale`
(`character_height_px = 64`, `character_height_m = 1.7`). This lands in every
manifest's `placement`, and the game renders each sprite scaled to
`world_px_height` beside a 64px character — so a coin (~0.22m → ~8px) is tiny and
an oak (~6m → ~226px) towers. It's a **rule, not a suggestion**: nothing ships
without a `placement`, and `factory.refresh_placement` re-derives it for every
existing object at loop startup (zero PixelLab cost) whenever the scale rule or a
world height changes. The viewer shows each object to scale against a character
silhouette.

## Loop algorithm

The next unit is derived purely from the filesystem, so the loop is resumable and
each unit commits + pushes:

```
for object in (catalog then procedural up to targets.num_objects):
    if no sprite.png            -> generate base           (pixflux)
    else for each rotation dir  -> if missing, generate it (rotate)
    else for each animation     -> if missing, generate it (animate-with-text)
-> all objects complete
```

One unit = one generation. After each: repackage, rebuild `viewer_data.json`,
commit, push. Order (base → rotations → animations) guarantees an animation always
has its base sprite as a reference.

## QA

- **Animations** are validated before shipping: every frame must be non-blank and
  the clip must actually move (frames differ from frame 0). `animate-with-text`
  occasionally returns a transparent or frozen clip; we retry with a fresh seed
  (up to 3 attempts) and, if still bad, keep the best effort but set
  `animations.<key>.ok = false` and a `note`, so it's visible rather than
  silently broken.
- **Sizes** are normalized: every rotation/frame of an object is centered on the
  object's declared `size`, so all of an object's art shares one canvas.

## Packaging

Per object: `sprite.png`; `rotations/<dir>.png` (incl. `south` = base);
`animations/<key>/NN.png` frames + `animations/<key>.png` horizontal sprite-sheet
strip (game-ready) + `animations/<key>.gif` (transparent looping preview).
`object.json` indexes it all; `viewer_build.py` rolls every object into
`viewer_data.json` for `index.html`.

## Source of truth

Unlike characters (where PixelLab stores the character and `sync.py` mirrors UI
edits back), the object image tools are **stateless** — there is no server-side
object to fetch. The **repo is authoritative**; regenerating is a fresh draw. The
loop only ever creates *missing* assets, so committed hand-edits are never
overwritten.

## Cost model

base (1) + rotations (0/3/7 — `south` is a free copy) + animations (1 each). A
plain prop ≈ 1 gen; a 4-dir prop ≈ 4; an animated prop ≈ 2; a fully-featured
object (8-dir + a couple of animations) ≈ 10. The loop is budget-aware and stops
above `budget.min_generations_remaining`.
