# Modular Pixel Character Factory — Design Spec

A pipeline that produces Grave Seasons / Stardew-style **side-view** pixel
characters as **layered sprites that all share ONE skeleton**, so animations and
gear amortize across the whole roster. A drawing backend (PixelLab) paints the
pixels; **this repo owns the skeleton, the pose library, the compositing, and the
QA.**

## The Rule (architecture — never break it)

> Every layer — each body part and each gear piece — is rendered on the **SAME
> canvas**, posed by the **SAME skeleton**, transparent everywhere else.
> Compositing = **alpha-over in z-order**. Gear "equips" by **hiding the base
> layers it covers**.

Because the skeleton is shared, a pose authored once drives every character, and
a gear piece painted once for an archetype re-uses across all characters of that
archetype. That is the entire economic argument for the factory.

## Canvas & Skeleton

- Canvas **48×64**, `center_x=24`, `ground_y=58`. Image **y grows downward**.
- Angles in **degrees**: `0=+x` (forward/right), `90=down`, `-90=up`.
- Bone lengths: torso 13, neck 3, head_r 6, upper_arm 8, fore_arm 7, thigh 11,
  shin 10, foot 6.
- **Bind pose** is a relaxed, asymmetric standing stance (NOT a T-pose): torso
  up (`-90`), arms ~90 (hanging) with slight front/back asymmetry, legs ~90 with
  one knee forward and one back.
- Front/back limb pairs are offset **±1.8px perpendicular to the torso** for
  depth separation; **back limbs render ~14% darker**.
- **z-order:** `back_arm, back_leg, torso, hair, head, front_leg, front_arm`.
- **slot_hides:** `helm→[head,hair]`, `body→[torso]`, `pants→[thigh]`,
  `boots→[foot,shin]`, `gloves→[hand]`.

All bone angles in poses are **absolute world angles**. Poses are authored facing
right; left-facing is a final horizontal flip, so `facing` is never interpolated.

## Poses & Animations

A **pose** is: `rootx, rooty, torso_a, head_tilt`, back/front `upper_arm` +
`fore_arm`, back/front `thigh` + `shin`, `ponytail`, `facing`.

An **animation** is: `keyframes, segment_frames, loop, duration_ms`. Expansion:
- Each keyframe lists only the fields it changes vs the bind pose (merged at
  expand time).
- Between consecutive keyframes, ease `t` with **smoothstep** (`t²(3−2t)`) then
  **linearly interpolate** every numeric field. `facing` is carried, not blended.
- `loop=true` appends a closing segment back to `keyframe[0]`.

### Starter set (25 animations)

`stand, walk, run, jump, crouch, fall, kick_stand, punch_stand, kick_crouch,
punch_crouch, kick_air, punch_air, punch_run, kick_run, land_low, land_med,
land_high, hit_front_high, hit_front_mid, hit_front_low, hit_behind_high,
hit_behind_mid, hit_behind_low, hit_crouch_front, hit_crouch_behind`.

Authoring principles: anticipation → action → recovery; proper walk/run passing
cycles; **front hits recoil backward** (torso angle goes more negative), **behind
hits pitch forward** (torso toward −60); landings absorb deeper with height.

## Compositor (deterministic)

`pipeline/compositor.py`, PIL + numpy, pure functions:
- `load_palette(path) → {hex: rgb}` (+ `load_roles` for the renderer).
- `composite(layers, z_order)` — alpha-over; missing/hidden layers are skipped.
- `pixelate(rgba, w, h, palette)` — **downscale NEAREST → binary alpha → snap
  each opaque pixel to the nearest palette color → 1px selective dark outline**.
  The **same** pixelate is applied to every frame.
- `expand_animation(anim, bind)`, `pack_strip`, `pack_grid` (rows=animation,
  cols=frame), `write_manifest`.

`pipeline/skeleton.py` owns the joint solve (`resolve_joints`) and a **procedural
placeholder rasterizer** (`render_pose`) that draws each part as a flat capsule.
This proves the layered/posed/composited path before PixelLab exists and is what
PixelLab later replaces — the joint positions remain the contract for where
painted art must land.

## QA (must pass before committing assets)

`pipeline/qa.py` validates every final frame:
1. correct size, 2. non-empty, 3. clean transparent 1px border, 4. no
stray/isolated opaque blobs (`< min_blob_px`), 5. every opaque pixel within
tolerance of the locked palette.

## PixelLab Client

`pipeline/pixellab_client.py` — thin wrapper, base URL
`https://api.pixellab.ai/v2`, key from `PIXELLAB_API_KEY`, **Bearer** auth
(verify against docs). All endpoints **stubbed** with clear TODOs:
`generate_image, animate_skeleton, animate_text, remove_background,
reduce_colors, transfer_outfit`. Generators error clearly if the key is unset.

## Generators

- `generate_character.py --id --desc --archetype` — paints base layers (PixelLab,
  TODO), then poses every animation, composites, pixelates, QAs, and writes
  strips + contact sheet + manifest. `--placeholder` runs the deterministic rig
  with no network.
- `generate_gear.py --id --slot --archetype --desc` — gear generated **once per
  archetype**, reused across its characters; demonstrates equip-and-hide.

`project.json` `mode`: **`redraw`** (default — paint each variant) vs **`rig`**
(future amortized re-pose of painted layers — TODO).

## Palette

Placeholder cozy farming-sim palette (~18 hex: warm skin/hair/cloth + dark
outline, each material with a ~14% darker shadow twin). **Lock it from the pilot
sprite** (`locked=true`) once the first character is approved, then never recolor
mid-roster.

## Guardrails

Never commit secrets · pass `qa.py` before committing assets · keep the palette
locked once set · commit assets (not gitignored) · small PRs.

## Phases

- **Phase 0 (next):** set `PIXELLAB_API_KEY`, allow `api.pixellab.ai` egress,
  implement `_paint_base_layers` / `_paint_gear` and the client TODOs, paint the
  pilot character, lock the palette from it.
- **Later:** roll out the roster + gear per archetype; evaluate `rig` mode.
