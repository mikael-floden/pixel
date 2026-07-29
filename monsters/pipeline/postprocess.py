"""Repair PixelLab wrap-around overflow in mirrored animation frames.

The bug (maintainer-confirmed, both axes): when the generator draws outside
the canvas, the overflow re-appears wrapped to the OPPOSITE edge — usually on
the NEXT frame, sometimes on the same frame. Example: the lava salamander's
flame burst exits the right edge on frame 12 and a flame chunk sits on the
left edge of frame 13.

Detection (per frame, at the monster's NATIVE canvas):
  - a connected component (not the main body) sitting FLUSH against one edge;
  - a candidate target frame (previous, same, or loop-previous) whose content
    is clipped flush against the OPPOSITE edge;
  - seam continuity: translating the strip one native canvas-width/height
    across, its edge line must land on the target's clipped edge line
    (overlap >= ACCEPT_OVERLAP of the strip's edge pixels).
  Guards: strips < MIN_STRIP_PX are ignored (1-px root tips…), targets whose
  clipped line spans > FLUSH_SPAN_MAX of the border are ignored (a pile
  touching both edges makes the seam test meaningless), and
  config/wrap_overrides.json force-accepts/rejects individual cases — that
  file holds the human-reviewed verdicts (e.g. radial spike bursts and water
  droplet clouds LOOK like wraps to the metric but are legitimate art).

Repair:
  - the monster's canvas grows symmetrically (all rotations + every frame of
    every animation share one canvas, centered) by the largest overflow found
    plus a margin, so restored graphics have room;
  - each accepted strip is REMOVED from the frame it wrapped onto and pasted
    into its target frame at the true position beyond the original border;
  - strips / per-direction GIFs / rotating GIFs are rebuilt, and monster.json
    gets `native_size` + a `postprocess` record of pad + applied fixes.

Idempotent: already-padded frames are skipped by detection (it only runs on
native-canvas frames), and a re-mirrored direction (fresh native frames) is
re-detected and re-fixed on the next run. sync.py runs this after mirroring.

Usage:
  python monsters/pipeline/postprocess.py             # all monsters
  python monsters/pipeline/postprocess.py --monster lava_salamander
  python monsters/pipeline/postprocess.py --dry-run   # report only
"""

from __future__ import annotations

import argparse
import json
import os

import numpy as np
from PIL import Image

import mirror
from mirror import ROOT, monster_dir, read_manifest, write_manifest
from pixellab_client import DIRECTIONS_8

OVERRIDES = os.path.join(ROOT, "config", "wrap_overrides.json")
DIE_TRIMS = os.path.join(ROOT, "config", "die_trims.json")

ACCEPT_OVERLAP = 0.75
MIN_STRIP_PX = 3
MIN_FLUSH = 3
FLUSH_SPAN_MAX = 0.60
PAD_MARGIN = 2

SIDES = ("left", "right", "top", "bottom")
OPP = {"left": "right", "right": "left", "top": "bottom", "bottom": "top"}


# --- pixel helpers -----------------------------------------------------------

def _load(fp):
    return np.asarray(Image.open(fp).convert("RGBA"), dtype=np.uint8).copy()


def _save(arr, fp):
    Image.fromarray(arr, "RGBA").save(fp)


def _components(alpha):
    """8-connected labels for a boolean mask (frames are tiny; BFS is fine)."""
    lab = np.zeros(alpha.shape, dtype=np.int32)
    cur = 0
    H, W = alpha.shape
    for y0 in range(H):
        for x0 in range(W):
            if alpha[y0, x0] and lab[y0, x0] == 0:
                cur += 1
                stack = [(y0, x0)]
                lab[y0, x0] = cur
                while stack:
                    y, x = stack.pop()
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            ny, nx = y + dy, x + dx
                            if 0 <= ny < H and 0 <= nx < W \
                                    and alpha[ny, nx] and lab[ny, nx] == 0:
                                lab[ny, nx] = cur
                                stack.append((ny, nx))
    return lab, cur


def _flush_extent(mask, side):
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return 0
    H, W = mask.shape
    if side == "left":
        return int(xs.max()) + 1 if xs.min() == 0 else 0
    if side == "right":
        return W - int(xs.min()) if xs.max() == W - 1 else 0
    if side == "top":
        return int(ys.max()) + 1 if ys.min() == 0 else 0
    return H - int(ys.min()) if ys.max() == H - 1 else 0


def _border_line(alpha, side):
    if side == "left":
        return alpha[:, 0]
    if side == "right":
        return alpha[:, -1]
    if side == "top":
        return alpha[0, :]
    return alpha[-1, :]


# --- detection ---------------------------------------------------------------

def _strip_mask(img, side, native):
    """Union of non-main components flush at `side` (native-canvas frame)."""
    W, H = native
    a = img[..., 3] > 8
    if a.sum() < 12:
        return None
    lab, n = _components(a)
    if n < 2:
        return None
    areas = [(lab == i).sum() for i in range(1, n + 1)]
    main_i = int(np.argmax(areas)) + 1
    strip = np.zeros_like(a)
    lim = (W if side in ("left", "right") else H) // 2
    for i in range(1, n + 1):
        if i == main_i:
            continue
        m = lab == i
        if 0 < _flush_extent(m, side) <= lim:
            strip |= m
    return strip if strip.any() else None


def _best_target(frames, f, strip, side, native, guarded=True):
    """Best (overlap, target_frame) for unwrapping `strip` across OPP[side].
    Targets tried: prev, same, loop-prev. `guarded` applies the flush-span
    sanity limits (dropped for human-forced accepts)."""
    W, H = native
    s_line = _border_line(strip, side)
    if s_line.sum() == 0:
        return None
    best = None
    targets = [f - 1, f] + ([len(frames) - 1] if f == 0 else [])
    for tf in targets:
        if not (0 <= tf < len(frames)):
            continue
        timg = frames[tf]
        if timg.shape[1] != W or timg.shape[0] != H:
            continue
        t_line = _border_line(timg[..., 3] > 8, OPP[side])
        if guarded and not (MIN_FLUSH <= t_line.sum()
                            <= FLUSH_SPAN_MAX * len(t_line)):
            continue
        ov = float((s_line & t_line).sum() / s_line.sum())
        if best is None or ov > best[0]:
            best = (ov, tf)
    return best


def detect(frames, native):
    """[{frame, side, target, overlap, strip_px, ext}] for one direction's
    native-canvas frame list."""
    W, H = native
    found = []
    for f, img in enumerate(frames):
        if img.shape[1] != W or img.shape[0] != H:
            continue
        for side in SIDES:
            strip = _strip_mask(img, side, native)
            if strip is None or strip.sum() < MIN_STRIP_PX:
                continue
            best = _best_target(frames, f, strip, side, native)
            if best and best[0] >= ACCEPT_OVERLAP:
                found.append({"frame": f, "side": side, "target": best[1],
                              "overlap": round(best[0], 3),
                              "strip_px": int(strip.sum()),
                              "ext": _flush_extent(strip, side)})
    return found


def _load_overrides():
    if not os.path.exists(OVERRIDES):
        return {"accept": [], "reject": []}
    with open(OVERRIDES) as f:
        return json.load(f)


def _case_id(mid, key, d, fx):
    return f"{mid}/{key}/{d}/f{fx['frame']:02d}/{fx['side']}"


# --- repair ------------------------------------------------------------------

def _recanvas(arr, canvas):
    """Center `arr` onto canvas (cw, ch); canvases share one center."""
    cw, ch = canvas
    h, w = arr.shape[:2]
    if (w, h) == (cw, ch):
        return arr
    out = np.zeros((ch, cw, 4), dtype=np.uint8)
    ox, oy = (cw - w) // 2, (ch - h) // 2
    out[oy:oy + h, ox:ox + w] = arr
    return out


def _apply_fix(cur, tgt, strip, side, native, off):
    """Move strip pixels from `cur` to their true spot on `tgt` (both already
    on the padded canvas; `strip` is a native-canvas mask; `off` = (ox, oy)
    of the native area inside the canvas)."""
    W, H = native
    ox, oy = off
    dx = W if side == "left" else (-W if side == "right" else 0)
    dy = H if side == "top" else (-H if side == "bottom" else 0)
    for y, x in zip(*np.nonzero(strip)):
        ty, tx = oy + y + dy, ox + x + dx
        if 0 <= ty < tgt.shape[0] and 0 <= tx < tgt.shape[1]:
            tgt[ty, tx] = cur[oy + y, ox + x]
        cur[oy + y, ox + x] = 0


def process_monster(mid, dry_run=False):
    meta = read_manifest(mid)
    if not meta:
        return None
    pp = meta.get("postprocess") or {}
    native = tuple(pp.get("native_size") or
                   (meta["size"]["width"], meta["size"]["height"]))
    ov = _load_overrides()
    mdir = monster_dir(mid)

    # -- detect on native-canvas frames --------------------------------------
    plan = {}
    for key in meta.get("animations", {}):
        for d in DIRECTIONS_8:
            fdir = os.path.join(mdir, "animations", key, d)
            if not os.path.isdir(fdir):
                continue
            files = sorted(f for f in os.listdir(fdir) if f.endswith(".png"))
            frames = [_load(os.path.join(fdir, f)) for f in files]
            fixes = []
            for fx in detect(frames, native):
                cid = _case_id(mid, key, d, fx)
                if cid in ov.get("reject", []):
                    continue
                fixes.append(fx)
            for cid in ov.get("accept", []):
                pmid, pkey, pd, pf, pside = cid.split("/")
                if (pmid, pkey, pd) != (mid, key, d):
                    continue
                f_i = int(pf[1:])
                if any(fx["frame"] == f_i and fx["side"] == pside for fx in fixes):
                    continue
                img = frames[f_i]
                if img.shape[1] != native[0] or img.shape[0] != native[1]:
                    continue
                strip = _strip_mask(img, pside, native)
                if strip is None:
                    continue
                best = _best_target(frames, f_i, strip, pside, native, guarded=False)
                if best is None:
                    continue
                fixes.append({"frame": f_i, "side": pside, "target": best[1],
                              "overlap": round(best[0], 3),
                              "strip_px": int(strip.sum()),
                              "ext": _flush_extent(strip, pside),
                              "forced": True})
            if fixes:
                plan[(key, d)] = (files, frames, fixes)

    prev_pad = tuple(pp.get("pad") or (0, 0))
    need_x = max([fx["ext"] + PAD_MARGIN for (_, _, fs) in plan.values()
                  for fx in fs if fx["side"] in ("left", "right")] or [0])
    need_y = max([fx["ext"] + PAD_MARGIN for (_, _, fs) in plan.values()
                  for fx in fs if fx["side"] in ("top", "bottom")] or [0])
    pad = (max(prev_pad[0], need_x), max(prev_pad[1], need_y))
    if not plan and pad == prev_pad:
        return None
    canvas = (native[0] + 2 * pad[0], native[1] + 2 * pad[1])
    n_fixes = sum(len(fs) for (_, _, fs) in plan.values())
    print(f"{mid}: {n_fixes} wrap fix(es), canvas {native[0]}x{native[1]} -> "
          f"{canvas[0]}x{canvas[1]} (pad {pad[0]},{pad[1]})")
    for (key, d), (_files, _frames, fixes) in sorted(plan.items()):
        for fx in fixes:
            print(f"    {key}/{d} f{fx['frame']:02d} {fx['side']:6s} "
                  f"-> f{fx['target']:02d}  px={fx['strip_px']} ov={fx['overlap']}")
    if dry_run:
        return {"fixes": n_fixes}

    # -- apply: every asset onto the shared canvas, then move strips ---------
    off = ((canvas[0] - native[0]) // 2, (canvas[1] - native[1]) // 2)
    touched_keys = set()
    for key, a in meta.get("animations", {}).items():
        for d in DIRECTIONS_8:
            fdir = os.path.join(mdir, "animations", key, d)
            if not os.path.isdir(fdir):
                continue
            files = sorted(f for f in os.listdir(fdir) if f.endswith(".png"))
            frames = [_load(os.path.join(fdir, f)) for f in files]
            fixes = plan.get((key, d), (None, None, []))[2]
            strips = [(fx, _strip_mask(frames[fx["frame"]], fx["side"], native))
                      for fx in fixes]
            frames = [_recanvas(fr, canvas) for fr in frames]
            for fx, strip in strips:
                if strip is not None:
                    _apply_fix(frames[fx["frame"]], frames[fx["target"]],
                               strip, fx["side"], native, off)
            for fp, fr in zip(files, frames):
                _save(fr, os.path.join(fdir, fp))
            touched_keys.add(key)

    for d, rel in (meta.get("rotations") or {}).items():
        p = os.path.join(ROOT, rel)
        _save(_recanvas(_load(p), canvas), p)
    sp = os.path.join(mdir, "sprite.png")
    if os.path.exists(sp):
        _save(_recanvas(_load(sp), canvas), sp)

    # -- rebuild derived assets ----------------------------------------------
    for key in touched_keys:
        a = meta["animations"][key]
        frames_by_dir = {}
        for d in list(a.get("directions") or {}):
            fdir = os.path.join(mdir, "animations", key, d)
            files = sorted(f for f in os.listdir(fdir) if f.endswith(".png"))
            frs = [Image.open(os.path.join(fdir, f)).convert("RGBA") for f in files]
            frames_by_dir[d] = frs
            mirror._save_strip(frs, os.path.join(mdir, "animations", f"{key}__{d}.png"))
            mirror._save_gif(frs, os.path.join(mdir, "animations", f"{key}__{d}.gif"))
        mirror.save_rotating_gif(
            frames_by_dir, os.path.join(mdir, "animations", f"{key}__rotating.gif"))

    applied = pp.get("fixes") or []
    seen = {(f["key"], f["dir"], f["frame"], f["side"]) for f in applied}
    for (key, d), (_files, _frames, fixes) in plan.items():
        for fx in fixes:
            if (key, d, fx["frame"], fx["side"]) not in seen:
                applied.append({"key": key, "dir": d, **fx})
    meta["size"] = {"width": canvas[0], "height": canvas[1]}
    meta["native_size"] = {"width": native[0], "height": native[1]}
    meta["pad"] = {"x": pad[0], "y": pad[1]}
    meta["postprocess"] = {"native_size": list(native), "pad": list(pad),
                           "fixes": applied}
    write_manifest(mid, meta)
    return {"fixes": n_fixes, "canvas": canvas}


# --- die-tail cloud trim -----------------------------------------------------
#
# PixelLab sometimes replaces the end of a fade-away die animation with big
# off-animation cloud/mist frames (occasionally followed by more garbage: a
# tornado, or the monster standing alive again). Cuts are HUMAN-ADJUDICATED
# and pinned in config/die_trims.json — automated metrics cannot reliably
# separate these clouds from intended dissolve art (same palette, same
# posterization), so the pipeline only auto-FLAGS suspicious tails for review
# and applies the pinned cuts. Pins are guarded by the direction's take id
# (`sub`) and original frame count, so a regenerated animation is re-reviewed
# instead of blindly cut.

def _die_trim_flag(areas):
    """True if a die tail looks suspicious (collapse-then-rebound): review it."""
    if len(areas) < 4:
        return False
    base = max(1, int(np.median(areas[:3])))
    lo = min(areas[2:]) / base
    return lo < 0.4 and areas[-1] / base > 0.7


# A die animation FADES AWAY (maintainer rule): once the monster has
# substantially dissolved (area below LOWBAR of its starting size), adding
# pixels back is wrong — the generator re-growing the monster. From that point
# every frame must keep fading (small tolerance for settling dust); frames
# that regrow are cut, while later frames that continue the fade (or are
# empty) are kept so the animation still ends gone.
DIE_LOWBAR = 0.35
DIE_EPS_FRAC = 0.015
DIE_MIN_KEEP = 3


def _auto_cut(areas):
    """Original-index drop list enforcing fade-away monotonicity."""
    n = len(areas)
    if n < 4:
        return []
    base = max(1, int(np.median(areas[:3])))
    eps = max(4, int(DIE_EPS_FRAC * base))
    lowbar = DIE_LOWBAR * base
    faded = False
    run_min = None
    drop = []
    for i, a in enumerate(areas):
        if not faded:
            if i >= 2 and a <= lowbar:
                faded = True
                run_min = a
            continue
        if a > run_min + eps:
            drop.append(i)
        else:
            run_min = min(run_min, a)
    while len(areas) - len(drop) < DIE_MIN_KEEP and drop:
        drop.pop()
    return drop


def trim_die_tails(mid, dry_run=False):
    meta = read_manifest(mid)
    if not meta or "die" not in (meta.get("animations") or {}):
        return 0
    cuts, reviewed_ok = {}, set()
    if os.path.exists(DIE_TRIMS):
        with open(DIE_TRIMS) as f:
            doc = json.load(f)
        cuts = doc["cuts"]
        reviewed_ok = set(doc.get("reviewed_ok") or [])
    pp = meta.get("postprocess") or {}
    applied = pp.get("die_trim") or {}
    mdir = monster_dir(mid)
    a = meta["animations"]["die"]
    removed_total = 0
    touched = False
    for d, rec in sorted((a.get("directions") or {}).items()):
        fdir = os.path.join(mdir, "animations", "die", d)
        files = sorted(f for f in os.listdir(fdir) if f.endswith(".png"))
        pin = cuts.get(f"{mid}/{d}")
        if pin:
            if rec.get("sub") != pin.get("sub"):
                print(f"  !! {mid}: die/{d} was REGENERATED on PixelLab — trim pin "
                      f"stale, review the new tail (config/die_trims.json)")
            elif len(files) == pin["of"]:
                keep = [f for i, f in enumerate(files) if i not in set(pin["drop"])]
                print(f"  {mid}: die/{d} cutting frame(s) "
                      f"{','.join(f'f{i:02d}' for i in pin['drop'])} "
                      f"({len(files)} -> {len(keep)})")
                removed_total += len(files) - len(keep)
                if not dry_run:
                    frames = [Image.open(os.path.join(fdir, f)).convert("RGBA")
                              for f in keep]
                    for f in files:
                        os.remove(os.path.join(fdir, f))
                    for i, fr in enumerate(frames):
                        fr.save(os.path.join(fdir, f"{i:02d}.png"))
                    rec["frames"] = len(frames)
                    rec["frame_paths"] = [
                        os.path.join(mid, "animations", "die", d, f"{i:02d}.png")
                        for i in range(len(frames))]
                    mirror._save_strip(frames, os.path.join(
                        mdir, "animations", f"die__{d}.png"))
                    mirror._save_gif(frames, os.path.join(
                        mdir, "animations", f"die__{d}.gif"))
                    applied[d] = {"dropped": pin["drop"], "sub": pin.get("sub")}
                    touched = True
            elif d not in applied:
                print(f"  !! {mid}: die/{d} has {len(files)} frames, pin expects "
                      f"{pin['of']} — skipped")
            files = sorted(f for f in os.listdir(fdir) if f.endswith(".png"))
        # fade-away monotonicity (runs on the current frames, after any pin):
        # once faded below LOWBAR, frames that ADD pixels are the re-appear
        # bug and are cut automatically
        if f"{mid}/{d}" in reviewed_ok:
            continue
        areas = []
        for f in files:
            im = np.asarray(Image.open(os.path.join(fdir, f)).convert("RGBA"))
            areas.append(int((im[..., 3] > 8).sum()))
        drop = _auto_cut(areas)
        if not drop:
            continue
        print(f"  {mid}: die/{d} auto-cut re-appearing frame(s) "
              f"{','.join(f'f{i:02d}' for i in drop)} "
              f"({len(files)} -> {len(files) - len(drop)})")
        removed_total += len(drop)
        if not dry_run:
            keep = [f for i, f in enumerate(files) if i not in set(drop)]
            frames = [Image.open(os.path.join(fdir, f)).convert("RGBA") for f in keep]
            for f in files:
                os.remove(os.path.join(fdir, f))
            for i, fr in enumerate(frames):
                fr.save(os.path.join(fdir, f"{i:02d}.png"))
            rec["frames"] = len(frames)
            rec["frame_paths"] = [
                os.path.join(mid, "animations", "die", d, f"{i:02d}.png")
                for i in range(len(frames))]
            mirror._save_strip(frames, os.path.join(mdir, "animations", f"die__{d}.png"))
            mirror._save_gif(frames, os.path.join(mdir, "animations", f"die__{d}.gif"))
            auto = applied.get(d) or {}
            auto["auto_dropped"] = sorted(set(auto.get("auto_dropped") or []) | set(drop))
            applied[d] = auto
            touched = True
    if touched and not dry_run:
        frames_by_dir = {}
        for d in a["directions"]:
            fdir = os.path.join(mdir, "animations", "die", d)
            frames_by_dir[d] = [Image.open(os.path.join(fdir, f)).convert("RGBA")
                                for f in sorted(os.listdir(fdir)) if f.endswith(".png")]
        mirror.save_rotating_gif(frames_by_dir,
                                 os.path.join(mdir, "animations", "die__rotating.gif"))
        pp["die_trim"] = applied
        meta["postprocess"] = pp
        write_manifest(mid, meta)
    return removed_total


def main():
    ap = argparse.ArgumentParser(description="Repair wrap-around overflow artifacts.")
    ap.add_argument("--monster", help="only this monster id")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    total = trimmed = 0
    for mid in sorted(os.listdir(ROOT)):
        if args.monster and mid != args.monster:
            continue
        if not os.path.exists(os.path.join(ROOT, mid, "monster.json")):
            continue
        r = process_monster(mid, dry_run=args.dry_run)
        if r:
            total += r["fixes"]
        trimmed += trim_die_tails(mid, dry_run=args.dry_run)
    print(f"total: {total} wrap fix(es), {trimmed} die frame(s) trimmed"
          f"{' (dry run)' if args.dry_run else ''}")


if __name__ == "__main__":
    main()
