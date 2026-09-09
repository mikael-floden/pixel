"""Author characters2/retouch.json: erase the object PixelLab hallucinated into
the heroes' pick-up animation (see retouch.py for why the patch layer exists).

The generator drew a DIFFERENT object per direction — white scroll (S), brown
pebble (SE), white disc (E), dark pot (NE), blue crystal (N) for the boy; white
pebble, blue stone, dark bar, orange pebble, grey pebble for the girl — first on
the ground, then in the hand. W/NW/SW are exact mirrors of E/NE/SE on PixelLab,
so only five directions are ruled; the mirrors are derived.

Per frame, RULES lists boxes [x0, y0, x1, y1] (inclusive) around the object.
Inside a box the tool erases: colours FOREIGN to the hero (never seen ≥20× in
the hero's object-free animations — the item's own palette), colours listed
explicitly (the pot is drawn in his hair grey, the scroll in eye white: colours
detection cannot see), components not connected to the body (the object lying
on the ground), and then the object's near-black outline — outline pixels next
to erased ones that no longer touch any body pixel. Holes left inside the body
(a pebble inside a closed fist) are inpainted from their neighbours; body that
now borders transparency gets a black outline back. Everything outside a box is
untouched; skin is never erased (it is an established colour).

  python characters2/pipeline/retouch_author.py --src <pristine humans/ tree>
  python characters2/pipeline/retouch_author.py            # source = PixelLab (API)

Writes retouch.json AND the retouched frames into humans/ (it holds the pristine
source, so it can; sync.py re-applies the patch on later downloads). Review the
result in the animation viewer before committing.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter

import numpy as np
from PIL import Image

from pixellab_client import PixelLabClient
from retouch import FORMAT, SPEC, frame_key, pixel_sha
from sync import HUMANS, ROOT, _assign_slugs, _read_json, frame_ext, load_config, save_image

W = H = 112
CANON = ["south", "south-east", "east", "north-east", "north"]
MIRROR = {"east": "west", "north-east": "north-west", "south-east": "south-west"}
STATE = "pickup"                        # animation_map.json state carrying the object
# States whose art has NO object in hand — the hero's own palette is learned from them.
CLEAN_STATES = ["idle", "walk", "run", "jump", "kick", "punch", "hurt", "die"]


def B(*box, **k):
    return dict(box=list(box), **k)


POT = [(57, 42, 45), (132, 147, 148)]                  # boy NE pot: hair grey + highlight
POT_RIM = POT + [(43, 32, 35), (49, 36, 40)]           # + the rim shades once it is lifted
DISC = [(253, 244, 245), (54, 70, 73), (83, 107, 113), (60, 79, 84),
        (114, 141, 143), (44, 62, 70), (69, 94, 99)]   # boy E disc: eye white + slates
WHITE = [(253, 244, 245)]                              # boy S scroll = his eye white
WHITE_G = [(252, 240, 240), (207, 185, 186), (192, 163, 144)]   # girl S pebble = her eye white
BAR = [(38, 31, 43), (17, 18, 21)]                     # girl E bar = a bikini shade

RULES = {
    ("default_boy", "south"): {
        5: [B(50, 84, 64, 101)],
        6: [B(50, 84, 60, 105, colors=WHITE), B(48, 96, 62, 104, all=True)],   # scroll + its stand
        7: [B(50, 72, 60, 105, colors=WHITE)],
        8: [B(52, 67, 62, 78, colors=WHITE)]},
    ("default_boy", "south-east"): {
        **{i: [B(68, 89, 77, 97)] for i in (1, 2, 3, 4, 5)},
        6: [B(68, 89, 77, 98)], 7: [B(68, 84, 76, 92)], 8: [B(69, 70, 77, 81)],
        9: [B(71, 61, 79, 70)], 10: [B(75, 54, 84, 63)]},
    ("default_boy", "east"): {
        **{i: [B(69, 89, 82, 97)] for i in (2, 3, 4)},
        5: [B(70, 84, 86, 97, colors=DISC)], 6: [B(66, 88, 80, 97, colors=DISC)],
        8: [B(70, 66, 86, 78, colors=DISC + POT)], 9: [B(66, 55, 80, 70, colors=DISC + POT)],
        10: [B(66, 49, 80, 63, colors=DISC + POT)]},
    ("default_boy", "north-east"): {
        **{i: [B(65, 82, 86, 97)] for i in (1, 2, 3)},
        4: [B(70, 82, 86, 97, colors=POT)], 5: [B(70, 81, 88, 97, colors=POT)],
        6: [B(63, 78, 86, 97, colors=POT)], 7: [B(62, 78, 82, 95, colors=POT)],
        8: [B(69, 58, 86, 76, colors=POT_RIM)], 9: [B(69, 50, 87, 72, colors=POT_RIM)],
        10: [B(70, 46, 87, 67, colors=POT_RIM)]},
    ("default_boy", "north"): {
        5: [B(67, 83, 82, 93)], 6: [B(66, 78, 86, 95)], 7: [B(66, 76, 88, 95)],
        8: [B(66, 75, 88, 95)], 10: [B(70, 44, 78, 52)]},
    ("default_girl", "south"): {
        5: [B(50, 92, 62, 101, colors=WHITE_G)], 6: [B(46, 86, 62, 100, colors=WHITE_G)]},
    ("default_girl", "south-east"): {
        **{i: [B(69, 91, 81, 99)] for i in (2, 3, 4)},
        5: [B(69, 89, 82, 99)], 6: [B(68, 91, 81, 99)], 7: [B(68, 83, 81, 92)],
        8: [B(68, 72, 80, 81)], 9: [B(69, 58, 80, 69)], 10: [B(66, 49, 77, 60)]},
    ("default_girl", "east"): {
        1: [B(68, 84, 84, 93)], 2: [B(62, 75, 89, 98)],                      # bar + sparkles
        6: [B(66, 86, 82, 97, colors=BAR), B(88, 77, 92, 81)],
        7: [B(62, 76, 82, 95, colors=BAR)], 8: [B(64, 66, 86, 78, colors=BAR)],
        9: [B(66, 58, 86, 72, colors=BAR)], 10: [B(68, 49, 86, 62, colors=BAR), B(70, 81, 75, 86)]},
    ("default_girl", "north-east"): {
        **{i: [B(73, 86, 80, 94)] for i in (1, 2, 3)},
        4: [B(72, 85, 81, 95)], 8: [B(72, 60, 84, 72)], 9: [B(72, 54, 86, 66)],
        10: [B(70, 48, 84, 60)]},
    ("default_girl", "north"): {
        4: [B(72, 83, 83, 93)], 6: [B(70, 84, 84, 95)], 7: [B(68, 80, 84, 92)],
        8: [B(64, 72, 80, 84)]},
}


# --- helpers ----------------------------------------------------------------

def _load(path):
    return np.array(Image.open(path).convert("RGBA"), dtype=np.uint8)


def hero_states(hero):
    m = _read_json(os.path.join(ROOT, "animation_map.json"), {}) or {}
    return {**(m.get("states") or {}), **((m.get("overrides") or {}).get(hero) or {})}


def established(hero):
    """Colours seen ≥20× across the hero's object-free animations + rotations.
    (Exact-match palette: the generator reuses the hero's palette faithfully,
    and a hallucinated object almost never lands on one of these colours.)"""
    states = hero_states(hero)
    pal = Counter()
    for st in CLEAN_STATES:
        adir = os.path.join(HUMANS, hero, "animations", states.get(st, ""))
        if not os.path.isdir(adir):
            continue
        for d in os.listdir(adir):
            ddir = os.path.join(adir, d)
            if not os.path.isdir(ddir):
                continue
            for fn in os.listdir(ddir):
                if fn.endswith(frame_ext()):
                    a = _load(os.path.join(ddir, fn))
                    pal.update(map(tuple, a[a[..., 3] > 0].tolist()))
    base = os.path.join(HUMANS, hero, "base")
    for fn in os.listdir(base):
        if fn.endswith(frame_ext()) and not fn.startswith("preview"):
            a = _load(os.path.join(base, fn))
            pal.update(map(tuple, a[a[..., 3] > 0].tolist()))
    return {c for c, n in pal.items() if n >= 20}


def components(mask):
    """8-connected component labels of a bool mask (0 = background)."""
    lab = np.zeros(mask.shape, int)
    n = 0
    for y, x in zip(*np.nonzero(mask)):
        if lab[y, x]:
            continue
        n += 1
        lab[y, x] = n
        stack = [(y, x)]
        while stack:
            cy, cx = stack.pop()
            for ny in (cy - 1, cy, cy + 1):
                for nx in (cx - 1, cx, cx + 1):
                    if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = n
                        stack.append((ny, nx))
    return lab, n


def n8(m):
    r = np.zeros_like(m)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy or dx:
                r |= np.roll(np.roll(m, dy, 0), dx, 1)
    return r


def n4count(m):
    return (np.roll(m, 1, 0).astype(int) + np.roll(m, -1, 0) + np.roll(m, 1, 1) + np.roll(m, -1, 1))


def retouch_frame(a, ops, est):
    """Apply the box rules to one RGBA array; returns (array, erased_count)."""
    a = a.copy()
    op = a[..., 3] > 0
    black = op & (a[..., :3].max(axis=2) <= 10)
    lab, n = components(op)
    main = int(np.argmax(np.bincount(lab.ravel())[1:])) + 1 if n else 0
    flat = [tuple(p) for p in a.reshape(-1, 4).tolist()]
    is_est = np.array([p in est for p in flat]).reshape(H, W)
    erased = np.zeros((H, W), bool)
    for o in ops:
        x0, y0, x1, y1 = o["box"]
        box = np.zeros((H, W), bool)
        box[y0:y1 + 1, x0:x1 + 1] = True
        cols = {tuple(c) for c in o.get("colors", [])}
        listed = np.array([p[:3] in cols for p in flat]).reshape(H, W) if cols else np.zeros((H, W), bool)
        e = box & op & ((~is_est & ~black) | listed | (lab != main))
        if o.get("all"):
            e = box & op
        # the object's outline: near-black next to erased pixels with no body left to outline
        for _ in range(60):
            body = op & ~erased & ~e & ~black
            dep = box & black & ~e & ~erased & n8(e | erased) & ~n8(body)
            if not dep.any():
                break
            e |= dep
        erased |= e
    a[erased] = 0
    op = a[..., 3] > 0
    # inpaint 1-px holes inside the body (an object pixel that sat inside a closed fist)
    for _ in range(3):
        body = op & (a[..., :3].max(axis=2) > 10)
        holes = erased & ~op & (n4count(body) >= 3)
        if not holes.any():
            break
        for y, x in zip(*np.nonzero(holes)):
            nb = [tuple(a[y + dy, x + dx]) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                  if (dy or dx) and 0 <= y + dy < H and 0 <= x + dx < W and body[y + dy, x + dx]]
            a[y, x] = Counter(nb).most_common(1)[0][0]
        op = a[..., 3] > 0
    # outline repair: body now touching transparency gets its black outline back
    body = op & (a[..., :3].max(axis=2) > 10)
    a[erased & ~op & n8(body)] = (0, 0, 0, 255)
    return a, int(erased.sum())


def mirror_ops(ops):
    return [{**o, "box": [W - 1 - o["box"][2], o["box"][1], W - 1 - o["box"][0], o["box"][3]]} for o in ops]


def patch_entry(src, out):
    """Diff two RGBA arrays into the retouch.json span format."""
    erase, paint = [], []
    for y in range(H):
        row_e = (src[y, :, 3] > 0) & (out[y, :, 3] == 0)
        row_p = (out[y, :, 3] > 0) & np.any(src[y] != out[y], axis=1)
        for mask, sink, colour in ((row_e, erase, False), (row_p, paint, True)):
            x = 0
            while x < W:
                if not mask[x]:
                    x += 1
                    continue
                x0 = x
                while x + 1 < W and mask[x + 1] and (not colour or (out[y, x + 1] == out[y, x0]).all()):
                    x += 1
                sink.append([y, x0, x] + ([out[y, x0].tolist()] if colour else []))
                x += 1
    return erase, paint


# --- sources ----------------------------------------------------------------

def source_frames_local(src_root, hero, slug):
    d = os.path.join(src_root, hero, "animations", slug)
    out = {}
    for dd in os.listdir(d):
        ddir = os.path.join(d, dd)
        if os.path.isdir(ddir):
            idx = sorted(int(os.path.splitext(f)[0]) for f in os.listdir(ddir)
                         if os.path.splitext(f)[0].isdigit())
            out[dd] = [_load(os.path.join(ddir, f"{i}{frame_ext()}")) for i in idx]
    return out


def source_frames_api(client, cid, slug):
    detail = client.get_character(cid)
    anims = detail.get("animations") or []
    types = [a.get("animation_type") or a.get("animation_group_id") for a in anims]
    slugs = _assign_slugs([t for t in types if t])
    for a in anims:
        atype = a.get("animation_type") or a.get("animation_group_id")
        if slugs.get(atype) != slug:
            continue
        out = {}
        for dp in a.get("directions") or []:
            urls = [u for u in (dp.get("frames") or []) if u]
            if dp.get("direction") and urls:
                out[dp["direction"]] = [np.array(client.download_image(u), dtype=np.uint8) for u in urls]
        return out
    raise SystemExit(f"{cid}: animation {slug!r} not found on PixelLab")


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--src", help="pristine humans/-layout tree to author from (default: PixelLab API)")
    ap.add_argument("--dry", action="store_true", help="write nothing, just report")
    args = ap.parse_args()
    pins = load_config().get("pixellab_characters") or {}
    client = None if args.src else PixelLabClient()
    spec = {"format": FORMAT,
            "_comment": ("Pixel patches sync.py applies on top of the PixelLab mirror, pinned to the "
                         "sha of the frame they were authored for (retouch.py). Authored by "
                         "pipeline/retouch_author.py — edit its RULES and re-run; never hand-edit."),
            "frames": {}}
    ext = frame_ext()
    total_frames = total_px = 0
    for hero in pins:
        slug = hero_states(hero).get(STATE)
        if not slug:
            raise SystemExit(f"{hero}: animation_map.json has no {STATE!r} state")
        est = established(hero)
        frames = (source_frames_local(args.src, hero, slug) if args.src
                  else source_frames_api(client, pins[hero], slug))
        results = {}
        for d in CANON:
            rules = RULES.get((hero, d), {})
            for i, src in enumerate(frames.get(d, [])):
                if i not in rules:
                    continue
                out, n = retouch_frame(src, rules[i], est)
                results[(d, i)] = (src, out)
                m = MIRROR.get(d)
                if m and i < len(frames.get(m, [])):
                    msrc = frames[m][i]
                    if (msrc == src[:, ::-1]).all():
                        results[(m, i)] = (msrc, out[:, ::-1])
                    else:          # not a mirror on PixelLab any more: rule it directly
                        results[(m, i)] = (msrc, retouch_frame(msrc, mirror_ops(rules[i]), est)[0])
        for (d, i), (src, out) in sorted(results.items()):
            erase, paint = patch_entry(src, out)
            if not erase and not paint:
                continue
            key = frame_key("humans", hero, slug, d, i)
            spec["frames"][key] = {"source_sha256": pixel_sha(Image.fromarray(src, "RGBA")),
                                   "result_sha256": pixel_sha(Image.fromarray(out, "RGBA")),
                                   "erase": erase, "paint": paint}
            total_frames += 1
            total_px += sum(x1 - x0 + 1 for _, x0, x1 in erase)
            if not args.dry:
                save_image(Image.fromarray(out, "RGBA"), os.path.join(ROOT, key + ext))
        print(f"{hero}: {sum(1 for k in spec['frames'] if k.startswith('humans/' + hero + '/'))} frames patched")
    if not args.dry:
        with open(SPEC, "w") as f:
            json.dump(spec, f, indent=1)
            f.write("\n")
    print(f"{'(dry) ' if args.dry else ''}retouch.json: {total_frames} frames, {total_px} px erased")


if __name__ == "__main__":
    main()
