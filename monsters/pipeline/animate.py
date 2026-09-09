"""Animate approved candidates, ONE STATE AT A TIME — idle first.

Maintainer 2026-09-09: "Try to get good at one animation at a time. Start
with idle until you have a good idle for all monsters. An idle is a very,
very calm and still breathing — PixelLab often gives you way too much, or
completely still. You can flip directions: a good SE is also a good SW. Make
sure NE is really NE — PixelLab confuses E and W. Specify the start and/or
end frame so the AI has to begin at a neutral position. Be prepared to redo
A LOT."

How that becomes code:
  - v3 custom animation, one job per direction, `end_frame` = the base
    rotation image, so the clip is pinned neutral → breathing → neutral
    (5 stored frames: base + 4 generated). Same shape as the maintainer's own
    accepted idles ("custom-Calm still idle, breathing", 5 frames).
  - Only S, SE, E, NE, N are GENERATED; SW, W, NW are the horizontal mirrors
    of SE, E, NE — no E/W confusion is possible and it is 5/8 of the cost.
    (Handedness flips for weapon-holders; the maintainer accepted that.)
  - Machine bands, calibrated on his 33 five-frame idles (silhouette XOR
    between consecutive frames / silhouette area: 0.008–0.239, median 0.091;
    centroid drift ≤ 3.8 px for all but two): pass 0.010–0.200 & drift ≤ 4,
    warn to 0.300 / 6 px, fail below 0.005 (frozen), above 0.300 (too
    much), drift > 6, loop not closing, a new canvas-edge touch (overflow),
    or mid-frames whose silhouette matches the MIRRORED base better than
    their own (the body turned the wrong way).
  - Then the sheet gets eyeballed anyway; the machine only narrows what a
    human has to look at.

  python monsters/pipeline/animate.py approve --ids a,b,c     # mark + tag APPROVED
  python monsters/pipeline/animate.py idle [--only a,b] [--dry-run]
  python monsters/pipeline/animate.py redo --state idle --only a --dirs south,east
  python monsters/pipeline/animate.py status [--state idle]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import zlib
from datetime import datetime, timezone

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import candidates as cand  # noqa: E402
import mirror  # noqa: E402
from pixellab_client import DIRECTIONS_8, PixelLabClient, PixelLabError  # noqa: E402

GEN_DIRS = ["south", "south-east", "east", "north-east", "north"]
MIRRORED = {"south-west": "south-east", "west": "east", "north-west": "north-east"}
OPPOSITE = {"east": "west", "west": "east", "south-east": "south-west", "south-west": "south-east",
            "north-east": "north-west", "north-west": "north-east"}

STATES = {
    "idle": {
        "action": ("Calm still idle, breathing very slowly and subtly, chest and shoulders "
                   "rise and fall a little, feet planted, no other movement, ends in the "
                   "same neutral pose it started in"),
        "frames": 4,
        "pin_end": True,
        "band": {"step_pass": (0.010, 0.200), "step_warn": (0.005, 0.300),
                 "drift_pass": 4.0, "drift_warn": 6.0, "loop_max": 0.05},
    },
}
APPROVED_TAG = "APPROVED"
MIN_USD = 5.0


# --- helpers -----------------------------------------------------------------

def seed_for(cid, state, direction, version):
    return (zlib.crc32(f"{cid}:{state}:{direction}:v{version}".encode()) & 0x7FFFFFFF) or 1


def rotation(cid, d):
    return Image.open(os.path.join(cand.cdir(cid), "rotations", d + mirror.ART_EXT)).convert("RGBA")


def anim_dir(cid, state, d):
    return os.path.join(cand.cdir(cid), "animations", state, d)


def load_frames(cid, state, d):
    p = anim_dir(cid, state, d)
    if not os.path.isdir(p):
        return []
    fs = sorted(f for f in os.listdir(p) if f.endswith(mirror.ART_EXT))
    return [Image.open(os.path.join(p, f)).convert("RGBA") for f in fs]


def save_frames(cid, state, d, frames):
    p = anim_dir(cid, state, d)
    if os.path.isdir(p):
        for f in os.listdir(p):
            os.remove(os.path.join(p, f))
    os.makedirs(p, exist_ok=True)
    for i, fr in enumerate(frames):
        mirror._save_png(fr, os.path.join(p, f"{i:02d}.png"))
    strip = Image.new("RGBA", (frames[0].width * len(frames), frames[0].height), (0, 0, 0, 0))
    for i, fr in enumerate(frames):
        strip.alpha_composite(fr, (i * frames[0].width, 0))
    mirror._save_png(strip, os.path.join(cand.cdir(cid), "animations", f"{state}__{d}.png"))


# --- canvas ---------------------------------------------------------------------

def align_to_base(frames, base):
    """v3 returns each direction's clip on ITS OWN padded canvas (measured
    2026-09-09 on a 112 px base: south 148×132, north 128×128, east 140×132)
    at the same pixel scale, frame 0 being the base shifted by some offset.
    Find that offset from frame 0, then crop/pad EVERY frame by it so frame 0
    lands exactly on the base canvas and the clip shares the monster's
    canvas. Returns (frames, cut) — cut = opaque pixels that fell outside the
    base canvas over the whole clip (overflow; 0 for a calm idle)."""
    b0 = base.getbbox(); f0 = frames[0].getbbox()
    if not b0 or not f0:
        return frames, 0
    dx, dy = f0[0] - b0[0], f0[1] - b0[1]
    W, H = base.size
    out, cut = [], 0
    for fr in frames:
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(fr, (-dx, -dy)) if (dx >= 0 and dy >= 0) else canvas.alpha_composite(fr, (max(0, -dx), max(0, -dy)))
        # count what the crop dropped
        total = int((np.asarray(fr)[..., 3] > 0).sum())
        kept = int((np.asarray(canvas)[..., 3] > 0).sum())
        cut += max(0, total - kept)
        out.append(canvas)
    return out, cut


# --- QA ----------------------------------------------------------------------

def _sil(im):
    return np.asarray(im.convert("RGBA"))[..., 3] > 0


def _iou(a, b):
    return (a & b).sum() / max(1, (a | b).sum())


def qa_clip(cid, state, d, frames):
    """Machine verdict for one direction's clip. See module docstring."""
    band = STATES[state]["band"]
    reasons = []
    want = STATES[state]["frames"] + 1
    if len(frames) != want:
        reasons.append(f"{len(frames)} frames, expected {want}")
    if not frames:
        return {"status": "fail", "reasons": reasons}
    base = rotation(cid, d)
    if base.size != frames[0].size:
        reasons.append(f"canvas {frames[0].size} != base {base.size}")
    ops = [_sil(f) for f in frames]
    sil = max(o.sum() for o in ops)
    step = [(ops[i] ^ ops[i + 1]).sum() / sil for i in range(len(ops) - 1)]
    step_mean = float(np.mean(step)) if step else 0.0
    cs = [np.argwhere(o).mean(0) if o.any() else np.zeros(2) for o in ops]
    drift = float(max(np.abs(np.array(cs) - cs[0]).max(1))) if cs else 0.0
    loop = float((ops[0] ^ ops[-1]).sum() / sil)
    # frame 0 must be the pinned base
    b0 = _sil(base)
    pin = _iou(b0, ops[0])
    if pin < 0.98:
        reasons.append(f"frame 0 is not the base rotation (IoU {pin:.2f})")
    # overflow: a frame touching an edge the base does not
    h, w = b0.shape
    def edges(o):
        return (o[0].any(), o[-1].any(), o[:, 0].any(), o[:, -1].any())
    be = edges(b0)
    for i, o in enumerate(ops):
        e = edges(o)
        if any(x and not y for x, y in zip(e, be)):
            reasons.append(f"frame {i} touches a canvas edge the base does not (overflow / wrap risk)")
            break
    # facing: mid frames must match own base better than the mirrored opposite base
    if d in OPPOSITE:
        opp = ImageOps.mirror(rotation(cid, OPPOSITE[d]))
        bo = _sil(opp)
        own = np.mean([_iou(b0, o) for o in ops[1:]])
        other = np.mean([_iou(bo, o) for o in ops[1:]])
        # a symmetric body matches both about equally — only a clear margin means
        # the model actually turned it (Pebblemite: 0.92 vs 0.92 was a false alarm)
        if other > own + 0.05:
            reasons.append(f"body turned the wrong way: matches mirrored {OPPOSITE[d]} ({other:.2f}) better than {d} ({own:.2f})")
    status = "pass"
    lo, hi = band["step_pass"]
    wlo, whi = band["step_warn"]
    if step_mean < wlo:
        reasons.append(f"frozen: silhouette moves {step_mean:.3f} per frame"); status = "fail"
    elif step_mean > whi:
        reasons.append(f"too much: silhouette moves {step_mean:.3f} per frame"); status = "fail"
    elif not (lo <= step_mean <= hi):
        reasons.append(f"motion {step_mean:.3f} outside the calm band {lo}–{hi} — eyeball it"); status = "warn"
    if drift > band["drift_warn"]:
        reasons.append(f"drifts {drift:.1f} px"); status = "fail"
    elif drift > band["drift_pass"]:
        reasons.append(f"drifts {drift:.1f} px — eyeball it"); status = "warn" if status != "fail" else status
    if loop > band["loop_max"]:
        reasons.append(f"loop does not close (last vs first {loop:.3f})"); status = "fail"
    if any(("not the base" in r) or ("wrong way" in r) or ("expected" in r) for r in reasons):
        status = "fail"
    elif any("overflow" in r for r in reasons) and status == "pass":
        # a mere touch of the border loses nothing (align_to_base reports CUT
        # pixels separately, and those do fail); eyeball it
        status = "warn"
    return {"status": status, "step_mean": round(step_mean, 4), "step_max": round(float(max(step)) if step else 0, 4),
            "drift": round(drift, 2), "loop": round(loop, 4), "pin": round(float(pin), 3), "reasons": reasons}


# --- manifest ------------------------------------------------------------------

def _anim_record(man, state):
    return man.setdefault("animations", {}).setdefault(state, {"directions": {}, "action": STATES[state]["action"]})


def write_manifest(cid, man):
    with open(cand.manifest_path(cid), "w") as f:
        json.dump(man, f, indent=2, ensure_ascii=False)
        f.write("\n")


# --- generation ----------------------------------------------------------------

def mirror_direction(cid, state, d):
    src = MIRRORED[d]
    frames = load_frames(cid, state, src)
    if not frames:
        return None
    flipped = [ImageOps.mirror(f) for f in frames]
    save_frames(cid, state, d, flipped)
    return flipped


def generate_state(client, cid, state, dirs, version, verbose=True):
    """Start one job per direction, wait, download the LAST take of each,
    QA, save, then mirror the three western directions from their eastern
    twins. Returns {direction: qa}."""
    man = cand.load_manifest(cid)
    rec = _anim_record(man, state)
    spec = STATES[state]
    jobs = {}
    for d in dirs:
        seed = seed_for(cid, state, d, version)
        end = rotation(cid, d) if spec["pin_end"] else None
        job = client.animate_v3(man["pixellab_id"], state, spec["action"], d,
                                frame_count=spec["frames"], end_frame=end, seed=seed)
        jobs[d] = job
        if verbose:
            print(f"  {cid:16s} {state} {d:11s} job {job} seed {seed}", flush=True)
    for d, job in jobs.items():
        if job:
            try:
                client.wait_job(job, timeout=900)
            except PixelLabError as e:
                print(f"  {cid} {d}: {e}")
    return collect_state(client, cid, state, dirs, version, verbose)


def collect_state(client, cid, state, dirs, version, verbose=True):
    """Download the LAST take of each direction from PixelLab, align it to the
    base canvas, QA, save, mirror. Used after generation and by `fetch`."""
    man = cand.load_manifest(cid)
    rec = _anim_record(man, state)
    spec = STATES[state]
    takes = client.animation_takes(man["pixellab_id"], spec["action"])
    out = {}
    for d in dirs:
        cands = takes.get(d) or []
        if not cands:
            out[d] = {"status": "fail", "reasons": ["no frames returned"]}
            continue
        urls = cands[-1]
        frames = [f for f in client.download_many(urls) if f is not None]
        if len(frames) != len(urls):
            out[d] = {"status": "fail", "reasons": [f"downloaded {len(frames)}/{len(urls)} frames"]}
            continue
        frames, cut = align_to_base(frames, rotation(cid, d))
        save_frames(cid, state, d, frames)
        qa = qa_clip(cid, state, d, frames)
        if cut:
            qa["reasons"].append(f"{cut} px of motion fell outside the base canvas (overflow)")
            qa["status"] = "fail" if cut > 20 else ("warn" if qa["status"] == "pass" else qa["status"])
        qa["cut"] = cut
        qa.update({"sub": client.sub_id(urls[0]), "takes": len(cands), "version": version, "mirrored": False,
                   "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        rec["directions"][d] = qa
        out[d] = qa
        if verbose:
            print(f"  {cid:16s} {state} {d:11s} v{version} {qa['status']:4s} step={qa.get('step_mean')} drift={qa.get('drift')} loop={qa.get('loop')} {qa['reasons']}", flush=True)
    # mirrors follow their source
    for d, src in MIRRORED.items():
        if src in out and rec["directions"].get(src, {}).get("status") != "fail":
            frames = mirror_direction(cid, state, d)
            if frames:
                rec["directions"][d] = dict(rec["directions"][src], mirrored=True, source=src)
    rec["frame_paths"] = {d: [os.path.join(cid, "animations", state, d, f"{i:02d}{mirror.ART_EXT}")
                              for i in range(spec["frames"] + 1)] for d in rec["directions"]}
    rec["strips"] = {d: os.path.join(cid, "animations", f"{state}__{d}{mirror.ART_EXT}") for d in rec["directions"]}
    write_manifest(cid, man)
    return out


def needed_dirs(man, state, redo=None):
    rec = (man.get("animations") or {}).get(state) or {"directions": {}}
    if redo:
        return list(redo)
    return [d for d in GEN_DIRS if rec["directions"].get(d, {}).get("status") in (None, "fail")]


def cmd_state(args, state):
    cfg = cand.load_cfg()
    ids = args.only.split(",") if args.only else [c["id"] for c in cfg["candidates"]
                                                  if (cand.load_manifest(c["id"]) or {}).get("review") == "approved"]
    redo = args.dirs.split(",") if getattr(args, "dirs", None) else None
    plan = []
    for cid in ids:
        man = cand.load_manifest(cid)
        if not man:
            print(f"{cid}: no candidate"); continue
        dirs = needed_dirs(man, state, redo)
        if dirs:
            plan.append((cid, dirs))
    print(f"{state}: {sum(len(d) for _, d in plan)} direction(s) over {len(plan)} monster(s)")
    for cid, dirs in plan:
        print(f"  {cid}: {dirs}")
    if args.dry_run or not plan:
        return
    client = PixelLabClient()
    client.require_key()
    for cid, dirs in plan:
        usd = client.usd_credits()
        if usd < args.min_usd:
            print(f"STOP: ${usd:.2f} < floor ${args.min_usd:.2f}"); break
        man = cand.load_manifest(cid)
        rec = _anim_record(man, state)
        version = max([v.get("version", 0) for v in rec["directions"].values()] + [0]) + 1
        if redo:
            # a redo replaces the take: delete the old direction on PixelLab first
            for d in dirs:
                try:
                    client.delete_animation(man["pixellab_id"], animation_type=f"custom-{state}", direction=d)
                except PixelLabError as e:
                    print(f"  {cid} {d}: old take not deleted ({e})")
        try:
            generate_state(client, cid, state, dirs, version)
        except PixelLabError as e:
            print(f"  {cid}: FAILED — {e}", flush=True)
        cand.rebuild_index(cfg)
    print(f"credits left: ${client.usd_credits():.2f}")


def cmd_approve(args):
    cfg = cand.load_cfg()
    ids = set(args.ids.split(","))
    client = PixelLabClient()
    tag = cfg.get("defaults", {}).get("candidate_tag", "MONSTER_CANDIDATE")
    for c in cfg["candidates"]:
        man = cand.load_manifest(c["id"])
        if not man:
            continue
        if c["id"] in ids:
            man["review"] = "approved"
            man["approved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            try:
                client.set_character_tags(man["pixellab_id"], [tag, APPROVED_TAG])
            except PixelLabError as e:
                print(f"  {c['id']}: tag failed ({e})")
        elif man.get("review") == "pending":
            man["review"] = "not_picked"
        write_manifest(c["id"], man)
    missing = ids - {c["id"] for c in cfg["candidates"]}
    if missing:
        print("unknown ids:", sorted(missing))
    cand.rebuild_index(cfg)
    print(f"approved {len(ids - missing)}")


def cmd_fetch(args):
    cfg = cand.load_cfg()
    client = PixelLabClient()
    dirs = args.dirs.split(",") if args.dirs else GEN_DIRS
    for cid in args.only.split(","):
        man = cand.load_manifest(cid)
        rec = _anim_record(man, args.state)
        version = max([v.get("version", 0) for v in rec["directions"].values()] + [0]) or 1
        collect_state(client, cid, args.state, dirs, version)
    cand.rebuild_index(cfg)


def cmd_requal(args):
    """Re-run the machine verdict on the frames already on disk (no network)."""
    cfg = cand.load_cfg()
    ids = args.only.split(",") if args.only else [c["id"] for c in cfg["candidates"]]
    for cid in ids:
        man = cand.load_manifest(cid)
        rec = ((man or {}).get("animations") or {}).get(args.state)
        if not rec:
            continue
        for d, q in rec["directions"].items():
            if q.get("mirrored"):
                continue
            frames = load_frames(cid, args.state, d)
            if not frames:
                continue
            new = qa_clip(cid, args.state, d, frames)
            if q.get("cut"):
                new["reasons"].append(f"{q['cut']} px of motion fell outside the base canvas (overflow)")
                new["status"] = "fail" if q["cut"] > 20 else ("warn" if new["status"] == "pass" else new["status"])
            keep = {k: q[k] for k in ("sub", "takes", "version", "mirrored", "generated_at", "cut") if k in q}
            rec["directions"][d] = {**new, **keep}
            for md, src in MIRRORED.items():
                if src == d and rec["directions"][d]["status"] != "fail":
                    # (re)create the mirror — it was skipped if the source failed at generation time
                    if mirror_direction(cid, args.state, md):
                        rec["directions"][md] = dict(rec["directions"][d], mirrored=True, source=src)
                        rec.setdefault("frame_paths", {})[md] = [os.path.join(cid, "animations", args.state, md, f"{i:02d}{mirror.ART_EXT}") for i in range(STATES[args.state]["frames"] + 1)]
                        rec.setdefault("strips", {})[md] = os.path.join(cid, "animations", f"{args.state}__{md}{mirror.ART_EXT}")
        write_manifest(cid, man)
    cand.rebuild_index(cfg)


def cmd_status(args):
    cfg = cand.load_cfg()
    state = args.state
    tot = ok = 0
    for c in cfg["candidates"]:
        man = cand.load_manifest(c["id"])
        if not man or man.get("review") != "approved":
            continue
        rec = (man.get("animations") or {}).get(state) or {"directions": {}}
        cells = []
        for d in DIRECTIONS_8:
            r = rec["directions"].get(d)
            cells.append("·" if not r else {"pass": "P", "warn": "w", "fail": "F"}.get(r["status"], "?") + ("m" if r.get("mirrored") else ""))
        done = all(rec["directions"].get(d, {}).get("status") in ("pass", "warn") for d in DIRECTIONS_8)
        tot += 1; ok += done
        print(f"{c['id']:18s} {' '.join(f'{x:2s}' for x in cells)}  {'DONE' if done else ''}")
    print(f"\n{ok}/{tot} approved monsters have a complete {state}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("approve"); a.add_argument("--ids", required=True); a.set_defaults(func=cmd_approve)
    for st in STATES:
        g = sub.add_parser(st, help=f"generate {st} for approved monsters (resumable)")
        g.add_argument("--only"); g.add_argument("--dry-run", action="store_true")
        g.add_argument("--min-usd", type=float, default=MIN_USD)
        g.set_defaults(func=lambda a, st=st: cmd_state(a, st))
    r = sub.add_parser("redo"); r.add_argument("--state", default="idle"); r.add_argument("--only", required=True)
    r.add_argument("--dirs", required=True); r.add_argument("--min-usd", type=float, default=MIN_USD)
    r.set_defaults(func=lambda a: cmd_state(a, a.state), dry_run=False)
    f = sub.add_parser("fetch", help="re-download + re-QA the last takes already on PixelLab (no generation)")
    f.add_argument("--state", default="idle"); f.add_argument("--only", required=True); f.add_argument("--dirs")
    f.set_defaults(func=cmd_fetch)
    q = sub.add_parser("requal", help="re-run the machine verdict from disk"); q.add_argument("--state", default="idle"); q.add_argument("--only"); q.set_defaults(func=cmd_requal)
    s = sub.add_parser("status"); s.add_argument("--state", default="idle"); s.set_defaults(func=cmd_status)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
