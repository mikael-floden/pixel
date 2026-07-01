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
- **Character** — an **undressed** base figure created with `create-character-v3`
  (8 rotations): a neutral body (plain underclothes) ready to be dressed.
- **Animation** — a motion generated with `animate-character` (text action),
  per direction, at the skeleton's frame count.
- **Outfit ("dress")** — one full clothing change (swim trunks → godly armor),
  created as a PixelLab character **state** ("wearing X").

## Outfits / dressing (PixelLab-native, source of truth)

We deliberately limit clothing to **what PixelLab actually supports**. PixelLab
has no per-slot gear or layer compositing; it changes a character's whole outfit
by creating a **state** of the character. So:

- The **base character is undressed** — this counts as the first dress,
  `undressed` (the base rotations + animations).
- A **dress** = `create-character-state(character_id, edit_description="wearing
  X")` → a **sibling character** stored on PixelLab (shares the base's
  `group_id`), visible/editable in the UI and syncable. Real dresses come from
  `config.dress_pool`.
- Every dress **regenerates its own animations** (via `animate-character` on the
  state). There is **one outfit at a time** — no combining pants + boots + hat.
- **Every character gets every dress, and every dress has every animation.**
  Adding a dress fans out to all characters; adding an animation fans out to all
  characters and all dresses.

## Animation set (25)

stand, walk, run, jump, crouch, fall, kick_stand, punch_stand, kick_crouch,
punch_crouch, kick_air, punch_air, punch_run, kick_run, land_low, land_med,
land_high, hit_front_high/mid/low, hit_behind_high/mid/low, hit_crouch_front,
hit_crouch_behind. Action descriptions live in `config/factory.json`; front hits
recoil backward, behind hits pitch forward, landings deepen with height.

## Loop algorithm

Caps per skeleton: 5 characters, 5 animations (start idle+walk), 5 dresses.
Invariant: every character has every animation undressed, and every dress (all
characters get every dress) has every animation.

- **Phase A — bootstrap:** create 5 skeletons; each gets 5 undressed characters
  animated with idle+walk across its 4/8 directions. A skeleton spawns the next
  once it has 5 complete characters.
- **Phase B — append:** once 5 skeletons exist, append to existing skeletons,
  fanning out: +animation (all characters + all dresses), +dress (all
  characters), +character (all animations + dresses) — up to the caps.

The next unit is derived from the filesystem (`fill_next`), so the loop is
resumable and each unit commits + pushes to `main`. It stops cleanly when
generations run low.

## Manual edits & sync (PixelLab is source of truth)

A character's art lives on PixelLab under its `character_id`. You can refine any
animation/direction by hand in the PixelLab web app; then `pipeline/sync.py`
mirrors the live state back into the repo (downloads frames, repackages strips +
GIFs, updates the manifest, pushes to `main`). Sync costs **zero generations**.
The loop only ever *creates missing* animations, so it never overwrites hand
edits. If a type has duplicate animation groups, sync keeps the one covering the
most directions. Sync also mirrors each character's **outfits** (sibling states
by `group_id`) — rotations + animations — so UI-created outfits flow in too.

## PixelLab integration (verified)

- `create-character-v3` → `{character_id, background_job_id}`; poll the job, then
  `GET /characters/{id}` for `rotation_urls` (PNG per direction). ~3 generations.
- `animate-character` → `{background_job_ids:[per direction]}`; each job's
  `last_response.images` is a list of `{width, height?, base64 rgba_bytes}`.
  ~1 generation per direction.
- `create-character-state` → `{character_id, background_job_id}`; a dressed
  sibling character (shared `group_id`). Poll, then animate it like any
  character. ~3 generations for rotations + animations.
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

A character ≈ 3 (base rotations) + (animations × directions) generations. Each
outfit ≈ the same again (its own state rotations + animations). So cost scales
with directions × animations × outfits — which is why exploration uses a reduced
direction/animation/outfit scope and only the winning skeleton goes full. The
loop is budget-aware and stops above `budget.min_generations_remaining`.
