"""Deterministic compositor + pixelizer + animation expander.

THE RULE lives here: layers are combined by alpha-over in z-order, nothing else.
Everything in this file is pure and deterministic — same input, same pixels —
so QA can be trusted and diffs stay meaningful.

Run `python pipeline/compositor.py` to exercise the whole deterministic path
without touching PixelLab: a synthetic pixelate+QA check, then a real contact
sheet rendered from the authored animations.
"""

from __future__ import annotations

import json
import os

import numpy as np
from PIL import Image

import qa
import skeleton

CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config")
ROOT_DIR = os.path.dirname(os.path.dirname(__file__))


# --- palette ----------------------------------------------------------------

def _hex_to_rgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def load_palette(path=None):
    """Load palette.json -> {hex: (r, g, b)} for every ramp color."""
    path = path or os.path.join(CONFIG_DIR, "palette.json")
    with open(path) as f:
        pal = json.load(f)
    return {h: _hex_to_rgb(h) for h in pal["ramp"]}


def load_roles(path=None):
    """Role name -> (r, g, b), for the procedural renderer."""
    path = path or os.path.join(CONFIG_DIR, "palette.json")
    with open(path) as f:
        pal = json.load(f)
    return {name: _hex_to_rgb(h) for name, h in pal["roles"].items()}


# --- compositing ------------------------------------------------------------

def composite(layers, z_order):
    """Alpha-over the named layers in z-order. Missing layers (e.g. hidden by
    equipped gear) are simply skipped."""
    base = None
    for name in z_order:
        layer = layers.get(name)
        if layer is None:
            continue
        layer = layer.convert("RGBA")
        if base is None:
            base = Image.new("RGBA", layer.size, (0, 0, 0, 0))
        base = Image.alpha_composite(base, layer)
    if base is None:
        raise ValueError("composite() got no drawable layers")
    return base


# --- pixelate ---------------------------------------------------------------

def _nearest_palette(rgb_arr, palette_rgb):
    """Vectorized nearest-palette snap. rgb_arr: (N,3); returns (N,3)."""
    diff = rgb_arr[:, None, :].astype(np.int32) - palette_rgb[None, :, :]
    idx = (diff * diff).sum(axis=2).argmin(axis=1)
    return palette_rgb[idx]


def pixelate(rgba, w, h, palette, alpha_threshold=128, outline_role_rgb=None):
    """Downscale NEAREST -> binary alpha -> snap to palette -> 1px dark outline.

    The SAME function must be applied to every frame so the whole strip shares
    one look. `palette` is {hex: rgb}; `outline_role_rgb` is the dark color used
    for the selective silhouette outline (defaults to the darkest palette color).
    """
    img = rgba.convert("RGBA").resize((w, h), Image.NEAREST)
    arr = np.array(img)

    palette_rgb = np.array(list(palette.values()), dtype=np.uint8)
    if outline_role_rgb is None:
        lum = palette_rgb.astype(np.int32).sum(axis=1)
        outline_role_rgb = tuple(int(c) for c in palette_rgb[lum.argmin()])

    # Binary alpha.
    opaque = arr[:, :, 3] >= alpha_threshold
    arr[:, :, 3] = np.where(opaque, 255, 0).astype(np.uint8)

    # Snap opaque RGB to the nearest palette color.
    if opaque.any():
        snapped = _nearest_palette(arr[opaque][:, :3], palette_rgb)
        arr[opaque, 0:3] = snapped

    # Selective dark outline: any transparent pixel 4-adjacent to an opaque
    # pixel becomes the outline color. This rims the silhouette without
    # touching interior shading.
    pad = np.pad(opaque, 1, mode="constant", constant_values=False)
    neighbor = (
        pad[0:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, 0:-2] | pad[1:-1, 2:]
    )
    edge = neighbor & ~opaque
    arr[edge, 0] = outline_role_rgb[0]
    arr[edge, 1] = outline_role_rgb[1]
    arr[edge, 2] = outline_role_rgb[2]
    arr[edge, 3] = 255

    return Image.fromarray(arr, "RGBA")


# --- animation expansion ----------------------------------------------------

def _interp(a, b, s):
    pose = {}
    for k in skeleton.POSE_FIELDS:
        pose[k] = a[k] + (b[k] - a[k]) * s
    for k in skeleton.NON_INTERP_FIELDS:
        pose[k] = a[k]  # discrete: carry the start value, never blend
    return pose


def _smoothstep(t):
    return t * t * (3.0 - 2.0 * t)


def expand_animation(anim, bind, default_segment=6):
    """Expand keyframes into per-frame poses with smoothstep easing.

    Each segment emits `segment_frames` poses from keyframe[i] up to (but not
    including) keyframe[i+1]. loop=True appends a closing segment back to
    keyframe[0]; otherwise the final keyframe is appended so it is shown once.
    """
    kfs = [skeleton.merge_pose(bind, k) for k in anim["keyframes"]]
    seg = anim.get("segment_frames", default_segment)
    loop = anim.get("loop", False)

    seq = kfs + [kfs[0]] if loop else list(kfs)
    frames = []
    for i in range(len(seq) - 1):
        a, b = seq[i], seq[i + 1]
        for f in range(seg):
            frames.append(_interp(a, b, _smoothstep(f / seg)))
    if not loop:
        frames.append(seq[-1])
    return frames


# --- packing ----------------------------------------------------------------

def pack_strip(frames):
    """Lay frames left-to-right into one horizontal strip."""
    if not frames:
        raise ValueError("pack_strip() got no frames")
    w, h = frames[0].size
    strip = Image.new("RGBA", (w * len(frames), h), (0, 0, 0, 0))
    for i, fr in enumerate(frames):
        strip.paste(fr, (i * w, 0))
    return strip


def pack_grid(rows):
    """Pack a list of frame-lists into a grid: rows=animation, cols=frame."""
    if not rows:
        raise ValueError("pack_grid() got no rows")
    w, h = rows[0][0].size
    cols = max(len(r) for r in rows)
    grid = Image.new("RGBA", (w * cols, h * len(rows)), (0, 0, 0, 0))
    for ry, row in enumerate(rows):
        for cx, fr in enumerate(row):
            grid.paste(fr, (cx * w, ry * h))
    return grid


def write_manifest(path, entries, canvas):
    """Write a JSON manifest describing each packed animation."""
    manifest = {"canvas": canvas, "animations": entries}
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest


# --- frame rendering (procedural placeholder path) --------------------------

def render_frame(pose, skel, roles, palette, w, h, alpha_threshold=128):
    """Pose -> layered parts -> composite -> facing flip -> pixelate. One frame."""
    layers = skeleton.render_pose(pose, skel, roles)
    flat = composite(layers, skel["z_order"])
    if pose.get("facing", 1) == -1:
        flat = flat.transpose(Image.FLIP_LEFT_RIGHT)
    return pixelate(flat, w, h, palette, alpha_threshold=alpha_threshold)


# --- self-test / contact sheet ---------------------------------------------

def _synthetic_pixelate_qa_test(palette, w, h):
    """Prove pixelate+QA on a synthetic blob with no skeleton involved."""
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    # A soft off-palette gradient blob in the middle.
    yy, xx = np.mgrid[0:h, 0:w]
    inside = (xx - w / 2) ** 2 + (yy - h / 2) ** 2 <= (min(w, h) / 3) ** 2
    arr[inside] = [123, 201, 77, 255]      # arbitrary off-palette green
    arr[inside & (xx > w / 2)] = [44, 60, 130, 200]  # second off-palette region
    raw = Image.fromarray(arr, "RGBA")
    out = pixelate(raw, w, h, palette)
    report = qa.run_qa(out, w, h, palette)
    return out, report


def main():
    skel = skeleton.load_skeleton()
    palette = load_palette()
    roles = load_roles()
    with open(os.path.join(CONFIG_DIR, "project.json")) as f:
        project = json.load(f)
    with open(os.path.join(CONFIG_DIR, "animations.json")) as f:
        anims = json.load(f)

    w, h = project["canvas"]["w"], project["canvas"]["h"]
    thr = project["alpha_threshold"]
    preview_dir = os.path.join(ROOT_DIR, project["paths"]["preview"])
    os.makedirs(preview_dir, exist_ok=True)

    print("== synthetic pixelate + QA ==")
    synth, report = _synthetic_pixelate_qa_test(palette, w, h)
    synth.resize((w * 4, h * 4), Image.NEAREST).save(
        os.path.join(preview_dir, "synthetic.png"))
    print("  synthetic QA:", "PASS" if report.ok else "FAIL")
    if not report.ok:
        for p in report.problems:
            print("   -", p)

    print("== render animations -> contact sheet ==")
    bind = skel["bind_pose"]
    default_seg = anims.get("defaults", {}).get("segment_frames", 6)
    rows = []
    manifest_entries = {}
    failures = 0
    for name, anim in anims["animations"].items():
        frames_poses = expand_animation(anim, bind, default_seg)
        frames = [render_frame(p, skel, roles, palette, w, h, thr) for p in frames_poses]
        for i, fr in enumerate(frames):
            rep = qa.run_qa(fr, w, h, palette)
            if not rep.ok:
                failures += 1
                print(f"  QA FAIL {name}#{i}: {rep.problems}")
        rows.append(frames)
        manifest_entries[name] = {
            "frames": len(frames),
            "segment_frames": anim.get("segment_frames", default_seg),
            "loop": anim.get("loop", False),
            "duration_ms": anim.get("duration_ms", 800),
        }
        # Per-animation strip for downstream use.
        pack_strip(frames).save(os.path.join(preview_dir, f"strip_{name}.png"))

    sheet = pack_grid(rows)
    sheet.save(os.path.join(preview_dir, "contact_sheet.png"))
    sheet.resize((sheet.width * 3, sheet.height * 3), Image.NEAREST).save(
        os.path.join(preview_dir, "contact_sheet_3x.png"))
    write_manifest(os.path.join(preview_dir, "manifest.json"),
                   manifest_entries, {"w": w, "h": h})

    print(f"  animations: {len(rows)}  frame QA failures: {failures}")
    print(f"  wrote {os.path.join(preview_dir, 'contact_sheet.png')}")
    print("DONE" if failures == 0 and report.ok else "DONE (with QA failures)")
    return 0 if failures == 0 and report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
