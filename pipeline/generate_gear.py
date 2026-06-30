"""Generate ONE gear piece for an archetype, reusable across its characters.

Gear is authored once per (archetype, slot) and amortized: because every
character shares the skeleton, the same posed gear art drops onto any character
of that archetype. Equipping = compositing the gear layer in z-order and hiding
the base layers its slot covers (skeleton.slot_hides).

PixelLab paints the gear; that step is stubbed, so the generator errors clearly
if PIXELLAB_API_KEY is unset. --placeholder draws a deterministic stand-in gear
layer so the equip/hide path can be exercised without network access.

Usage:
  python pipeline/generate_gear.py --id straw_hat --slot helm \
      --archetype villager --desc "wide straw sun hat" --placeholder
"""

from __future__ import annotations

import argparse
import json
import os

from PIL import Image, ImageDraw

import compositor
import qa
import skeleton
from pixellab_client import PixelLabClient, PixelLabError

ROOT_DIR = os.path.dirname(os.path.dirname(__file__))
CONFIG_DIR = os.path.join(ROOT_DIR, "config")


def _placeholder_gear_layer(slot, pose, skel, roles):
    """A crude deterministic gear silhouette per slot, posed on the skeleton.

    Stand-in only — PixelLab replaces this. It exists so we can validate the
    equip-and-hide compositing path end-to-end.
    """
    J = skeleton.resolve_joints(pose, skel)
    img = Image.new("RGBA", (skel["canvas"]["w"], skel["canvas"]["h"]), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    accent = roles["accent"] + (255,)
    b = skel["bones"]

    if slot == "helm":
        c = J["head"]
        r = b["head_r"] + 2
        d.ellipse([c[0] - r, c[1] - r - 2, c[0] + r, c[1]], fill=accent)
    elif slot == "body":
        compositor_capsule(d, J["pelvis"], J["shoulder"], 11, accent)
    elif slot == "pants":
        for side in ("front", "back"):
            compositor_capsule(d, J[side]["hip"], J[side]["knee"], 7, accent)
    elif slot == "boots":
        for side in ("front", "back"):
            compositor_capsule(d, J[side]["ankle"], J[side]["toe"], 5, accent)
            compositor_capsule(d, J[side]["knee"], J[side]["ankle"], 6, accent)
    elif slot == "gloves":
        for side in ("front", "back"):
            h = J[side]["hand"]
            d.ellipse([h[0] - 3, h[1] - 3, h[0] + 3, h[1] + 3], fill=accent)
    return img


def compositor_capsule(d, p0, p1, width, fill):
    p0 = (round(p0[0]), round(p0[1]))
    p1 = (round(p1[0]), round(p1[1]))
    d.line([p0, p1], fill=fill, width=width)
    r = width / 2.0
    for p in (p0, p1):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=fill)


def _paint_gear(client, gear_id, slot, archetype, desc):
    """Paint the gear once with PixelLab. STUBBED."""
    client.require_key()
    # TODO(phase0): client.generate_image(prompt=desc, ...) -> remove_background
    # -> reduce_colors to locked palette -> bind to skeleton joints for posing.
    raise NotImplementedError(
        "PixelLab-backed gear painting is stubbed. Use --placeholder for now, "
        "or implement _paint_gear in Phase 0."
    )


def generate(gear_id, slot, archetype, desc, placeholder=False):
    skel = skeleton.load_skeleton()
    palette = compositor.load_palette()
    roles = compositor.load_roles()
    with open(os.path.join(CONFIG_DIR, "project.json")) as f:
        project = json.load(f)
    with open(os.path.join(CONFIG_DIR, "animations.json")) as f:
        anims = json.load(f)

    if slot not in skel["slot_hides"]:
        raise SystemExit(f"unknown slot '{slot}'; valid: {list(skel['slot_hides'])}")

    w, h = project["canvas"]["w"], project["canvas"]["h"]
    thr = project["alpha_threshold"]

    if not placeholder:
        _paint_gear(PixelLabClient(), gear_id, slot, archetype, desc)

    out_dir = os.path.join(ROOT_DIR, project["paths"]["gear"], archetype, gear_id)
    os.makedirs(out_dir, exist_ok=True)

    bind = skel["bind_pose"]
    default_seg = anims.get("defaults", {}).get("segment_frames", 6)

    # Render the gear over a stand-in body for a single representative pose so a
    # reviewer can eyeball the equip-and-hide behaviour.
    demo = compositor.expand_animation(anims["animations"]["stand"], bind, default_seg)[0]
    base_layers = skeleton.render_pose(demo, skel, roles)
    gear_layer = _placeholder_gear_layer(slot, demo, skel, roles)

    # Equip: hide the base layers this slot covers, then add the gear on top.
    hidden = set(skel["slot_hides"][slot])
    layer_for_part = {
        "head": "head", "hair": "hair", "torso": "torso",
        "thigh": "front_leg", "shin": "front_leg", "foot": "front_leg",
        "hand": "front_arm",
    }
    kept = dict(base_layers)
    for part in hidden:
        lname = layer_for_part.get(part)
        if lname in kept:
            kept[lname] = None
    kept["gear"] = gear_layer
    z = [n for n in skel["z_order"]] + ["gear"]
    kept = {k: v for k, v in kept.items() if v is not None}

    equipped = compositor.composite(kept, z)
    if demo.get("facing", 1) == -1:
        equipped = equipped.transpose(Image.FLIP_LEFT_RIGHT)
    equipped = compositor.pixelate(equipped, w, h, palette, alpha_threshold=thr)

    rep = qa.run_qa(equipped, w, h, palette,
                    tolerance=project["palette_tolerance"],
                    min_blob_px=project["min_blob_px"])
    equipped.save(os.path.join(out_dir, "equipped_preview.png"))

    # Also save the bare gear layer (pixelated) as the reusable asset.
    bare = compositor.pixelate(gear_layer, w, h, palette, alpha_threshold=thr)
    bare.save(os.path.join(out_dir, "gear.png"))

    compositor.write_manifest(os.path.join(out_dir, "manifest.json"), {
        "id": gear_id, "slot": slot, "archetype": archetype, "desc": desc,
        "hides": list(hidden), "mode": "placeholder" if placeholder else project["mode"],
    }, {"w": w, "h": h})

    if not rep.ok:
        raise SystemExit(f"gear QA failed for {gear_id}: {rep.problems}")
    print(f"OK: gear {gear_id} ({slot}) -> {out_dir}; hides {sorted(hidden)}")


def main():
    ap = argparse.ArgumentParser(description="Generate a reusable gear piece.")
    ap.add_argument("--id", required=True)
    ap.add_argument("--slot", required=True)
    ap.add_argument("--archetype", required=True)
    ap.add_argument("--desc", required=True)
    ap.add_argument("--placeholder", action="store_true",
                    help="Draw a deterministic stand-in gear (no PixelLab).")
    args = ap.parse_args()
    try:
        generate(args.id, args.slot, args.archetype, args.desc, placeholder=args.placeholder)
    except (PixelLabError, NotImplementedError) as e:
        raise SystemExit(f"error: {e}")


if __name__ == "__main__":
    main()
