"""Generate one character's full animation set.

Flow:
  1. Paint base body-part layers (PixelLab) — TODO, stubbed for now.
  2. Pose every authored animation against the shared skeleton.
  3. Composite (alpha-over, z-order), pixelate, QA every frame.
  4. Write per-animation strips, a contact sheet, and a manifest.

PixelLab is required for the real paint step, so the generator errors clearly if
PIXELLAB_API_KEY is unset. Use --placeholder to run the deterministic procedural
renderer end-to-end without any network access (what we ship this phase).

Usage:
  python pipeline/generate_character.py --id rowan --desc "freckled farmhand" \
      --archetype villager --placeholder
"""

from __future__ import annotations

import argparse
import json
import os

import compositor
import qa
import skeleton
from pixellab_client import PixelLabClient, PixelLabError

ROOT_DIR = os.path.dirname(os.path.dirname(__file__))
CONFIG_DIR = os.path.join(ROOT_DIR, "config")


def _paint_base_layers(client, char_id, desc, archetype, skel, roles, project):
    """Paint each body-part layer once with PixelLab. STUBBED.

    Returns a callable pose->{layer: RGBA}. Today only --placeholder is wired,
    which uses the procedural renderer. The PixelLab path below is the TODO.
    """
    client.require_key()  # clear failure if the key is missing
    # TODO(phase0): for each body part, call client.generate_image(...) with the
    # archetype/desc prompt + style_ref, remove_background, reduce_colors to the
    # locked palette, then bind the result to skeleton joints so it can be posed.
    raise NotImplementedError(
        "PixelLab-backed painting is stubbed. Run with --placeholder for now, "
        "or implement _paint_base_layers in Phase 0."
    )


def generate(char_id, desc, archetype, placeholder=False):
    skel = skeleton.load_skeleton()
    palette = compositor.load_palette()
    roles = compositor.load_roles()
    with open(os.path.join(CONFIG_DIR, "project.json")) as f:
        project = json.load(f)
    with open(os.path.join(CONFIG_DIR, "animations.json")) as f:
        anims = json.load(f)

    w, h = project["canvas"]["w"], project["canvas"]["h"]
    thr = project["alpha_threshold"]

    if not placeholder:
        client = PixelLabClient()
        _paint_base_layers(client, char_id, desc, archetype, skel, roles, project)
        # (unreached until Phase 0 implements painting)

    out_dir = os.path.join(ROOT_DIR, project["paths"]["characters"], char_id)
    os.makedirs(out_dir, exist_ok=True)

    bind = skel["bind_pose"]
    default_seg = anims.get("defaults", {}).get("segment_frames", 6)
    rows, entries, failures = [], {}, 0

    for name, anim in anims["animations"].items():
        poses = compositor.expand_animation(anim, bind, default_seg)
        frames = [compositor.render_frame(p, skel, roles, palette, w, h, thr) for p in poses]
        for i, fr in enumerate(frames):
            rep = qa.run_qa(fr, w, h, palette,
                            tolerance=project["palette_tolerance"],
                            min_blob_px=project["min_blob_px"])
            if not rep.ok:
                failures += 1
                print(f"  QA FAIL {name}#{i}: {rep.problems}")
        compositor.pack_strip(frames).save(os.path.join(out_dir, f"strip_{name}.png"))
        rows.append(frames)
        entries[name] = {
            "frames": len(frames),
            "loop": anim.get("loop", False),
            "duration_ms": anim.get("duration_ms", 800),
        }

    compositor.pack_grid(rows).save(os.path.join(out_dir, "contact_sheet.png"))
    manifest = {
        "id": char_id, "desc": desc, "archetype": archetype,
        "mode": "placeholder" if placeholder else project["mode"],
    }
    compositor.write_manifest(os.path.join(out_dir, "manifest.json"),
                              {**entries, **{"_meta": manifest}}, {"w": w, "h": h})

    if failures:
        raise SystemExit(f"{failures} frame(s) failed QA for {char_id}")
    print(f"OK: {char_id} -> {out_dir} ({len(rows)} animations)")


def main():
    ap = argparse.ArgumentParser(description="Generate a modular pixel character.")
    ap.add_argument("--id", required=True)
    ap.add_argument("--desc", required=True)
    ap.add_argument("--archetype", required=True)
    ap.add_argument("--placeholder", action="store_true",
                    help="Render with the deterministic procedural rig (no PixelLab).")
    args = ap.parse_args()
    try:
        generate(args.id, args.desc, args.archetype, placeholder=args.placeholder)
    except (PixelLabError, NotImplementedError) as e:
        raise SystemExit(f"error: {e}")


if __name__ == "__main__":
    main()
