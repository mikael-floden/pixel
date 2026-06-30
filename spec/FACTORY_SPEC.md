# Factory Spec — Modular Pixel Character Factory

## Goal

An automated loop that produces good-looking, **modular**, game-ready pixel
characters (style: *Grave Seasons* / Stardew Valley) via the PixelLab API, so we
can evaluate several **skeletons** and commit to a winner later.

## Definitions

- **Skeleton** — a generation-parameter profile we want to test. Axes: pixel-art
  style, camera `view`, number of directions, `width`×`height`, frames per
  animation, outline/shading/detail, body `template_id`. Each skeleton is a
  folder under `skeletons/`; all characters in it share that profile.
- **Character** — a base figure created with `create-character-v3` (8 rotations).
- **Animation** — a motion generated with `animate-character` (text action),
  per direction, at the skeleton's frame count.
- **Gear** — modular item sprites per slot, generated once per skeleton and
  reused across its roster.

## Gear / equipment (PixelLab-native)

We deliberately limit gear to **what PixelLab actually supports**: changing a
character's outfit via **transfer-outfit** (the `transfer-outfit-v2` API, the
same tool as Transfer Outfit Pro). There is **no per-layer / z-order
compositing** — equipping a piece **bakes it onto the animation frames**.

- Each gear piece is generated once as an **item icon** (via `create-image-pixflux`),
  which doubles as the **outfit reference**.
- "Equipping" = `transfer-outfit-v2(reference=icon, frames=animation frames)` →
  a worn variant of that animation. Frames-per-call scale with size
  (≤64px: 15, 65–80px: 8, 81–256px: 3), so we chunk and stitch.
- Equippable slots: **pants, boots, gloves, armor/tunic, helmet/hat** (3 items
  each). `base_body` and `head` come from character creation.
- Equipping is expensive (one generation per ≤3-frame chunk per animation per
  direction), so during exploration we only equip the animations in
  `config.equip.animations` on the reference character. A winning skeleton can
  be equipped fully.

## Animation set (25)

stand, walk, run, jump, crouch, fall, kick_stand, punch_stand, kick_crouch,
punch_crouch, kick_air, punch_air, punch_run, kick_run, land_low, land_med,
land_high, hit_front_high/mid/low, hit_behind_high/mid/low, hit_crouch_front,
hit_crouch_behind. Action descriptions live in `config/factory.json`; front hits
recoil backward, behind hits pitch forward, landings deepen with height.

## Loop algorithm

Per skeleton, in order: create 10 base characters → animate each across **all of
the character's orientations** → generate 3 gear icons per equippable slot →
equip gear onto the reference character's configured animations → mark complete →
next skeleton. The next unit of work is derived from the filesystem, so the loop
is resumable and each unit commits + pushes to `main`. It stops cleanly when
generations run low.

## Manual edits & sync (PixelLab is source of truth)

A character's art lives on PixelLab under its `character_id`. You can refine any
animation/direction by hand in the PixelLab web app; then `pipeline/sync.py`
mirrors the live state back into the repo (downloads frames, repackages strips +
GIFs, updates the manifest, pushes to `main`). Sync costs **zero generations**.
The loop only ever *creates missing* animations, so it never overwrites hand
edits. If a type has duplicate animation groups, sync keeps the one covering the
most directions.

## PixelLab integration (verified)

- `create-character-v3` → `{character_id, background_job_id}`; poll the job, then
  `GET /characters/{id}` for `rotation_urls` (PNG per direction). ~3 generations.
- `animate-character` → `{background_job_ids:[per direction]}`; each job's
  `last_response.images` is a list of `{width, height?, base64 rgba_bytes}`.
  ~1 generation per direction.
- `create-image-pixflux` → synchronous `{image: base64}`; used for gear with the
  character portrait as `color_image` for palette consistency. 1 generation.
- Auth: `Authorization: Bearer $PIXELLAB_API_KEY`.

## Packaging

Per animation: per-direction frame **strips** (PNG, game-ready) + a
dark-background **GIF** (mobile preview). Base art as per-direction PNGs +
`portrait.png`. `viewer_build.py` rolls everything into `viewer_data.json` for
the `index.html` mobile viewer.

## Mobile testing

GIFs are viewable directly in the GitHub mobile app. For a richer experience,
enable GitHub Pages (`main` / root) and open `index.html`.

## Cost model

~28 generations per side-view character (base + 25 east-only animations) + ~15
per skeleton for gear ≈ ~295 per fully-built skeleton of 10. Budget-aware loop.
