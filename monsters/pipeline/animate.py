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
        "pin_end": True,        # end_frame = base → neutral → breathing → neutral
        "keep_first": True,     # base stored as frame 0 (5 frames)
        "band": {"step_pass": (0.010, 0.200), "step_warn": (0.005, 0.300),
                 "drift_pass": 4.0, "drift_warn": 6.0, "loop_max": 0.05},
    },
    # A walk is a FULL CYCLE that repeats without a hitch (maintainer): six free
    # frames, nothing pinned — pinning the base gives neutral→walk→neutral, which
    # is not a loop (his fallback "if you can't get anything sane at all"). The
    # maintainer's own 37 accepted 6-frame walks (measured, east): silhouette
    # step 0.13–0.39 (median 0.22), last→first hand-off 0.5–2.7× a normal step
    # (median 1.47), centroid drift median 2.2 px, x-travel median 1.3 px — they
    # walk IN PLACE; the game moves the sprite.
    "walk": {
        "action": ("walk loop, full walk cycle in place, legs alternate naturally, normal "
                   "calm walking pace, body stays centered, seamless loop whose last frame "
                   "leads straight back into the first, no turning"),
        "frames": 6,
        "pin_end": False,
        "keep_first": False,    # exactly 6 generated frames, the loop is theirs to close
        "band": {"step_pass": (0.100, 0.400), "step_warn": (0.050, 0.550),
                 "drift_pass": 5.0, "drift_warn": 8.0,
                 "loop_ratio_pass": 2.0, "loop_ratio_warn": 2.7,
                 "travel_pass": 4.0, "travel_warn": 7.0},
    },
    # An attack is ONCE-THROUGH (the game paces it to ~700 ms whatever the
    # count) and must land back on the base pose — so BOTH ends are pinned:
    # base → wind-up → strike → base. Every monster words its own strike as a
    # PRESET-STYLE move: "Move Name - mechanical body description, then returns
    # to idle stance", 4 frames — the exact shape of the maintainer's 57
    # accepted attacks (measured: their flash metric is 0.001 median, 51 of 57
    # under 0.15). Free prose ("swings its club in one heavy blow…", 6 frames)
    # got a painted impact effect — yellow club flare, slash arcs, sparks — on
    # most physical strikes (flash median 0.044, 40 of 179 over 0.15) and no
    # negative wording ("plain pixel art, no glow, no sparks…") suppressed it;
    # the preset format did in 15 of 16 probes.
    "attack": {
        "action": "Strike - Quickly lunges forward, strikes once, then returns to idle stance",
        "frames": 4,
        "pin_end": True,
        "keep_first": True,
        "band": {"step_pass": (0.060, 0.900), "step_warn": (0.030, 1.200),
                 "peak_pass": 0.12, "peak_warn": 0.06,
                 "drift_pass": 12.0, "drift_warn": 24.0,
                 "loop_warn": 0.15, "loop_max": 0.40,
                 "flash_warn": 0.04, "flash_max": 0.10},
    },
}
CLAW_SLASH = ("Claw Swipe - Raises one front paw and performs one quick swipe forward, "
              "then returns to idle stance")
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

def align_to_base(frames, base, pinned=True):
    """v3 returns each direction's clip on ITS OWN padded canvas (measured
    2026-09-09 on a 112 px base: south 148×132, north 128×128, east 140×132)
    at the same pixel scale — padded symmetrically around the base canvas
    (every pinned frame-0 offset equalled ((W'-W)/2, (H'-H)/2)). Re-canvas
    every frame so the base sits where it sat, on the SMALLEST canvas that
    holds all the motion: the base canvas grown by an equal pad on all
    sides. Nothing is ever cut — a stride or a bob that leaves the base
    canvas is normal (sync's postprocess grows canvases the same way for the
    shipped 57) and the game centres one canvas per monster.
    Returns (frames, pad)."""
    W, H = base.size
    if pinned:
        b0 = base.getbbox(); f0 = frames[0].getbbox()
        if not b0 or not f0:
            return frames, 0
        dx, dy = f0[0] - b0[0], f0[1] - b0[1]
    else:
        dx, dy = (frames[0].width - W) // 2, (frames[0].height - H) // 2
    # how far does any opaque pixel reach beyond the base window?
    pad = 0
    for fr in frames:
        bb = fr.getbbox()
        if not bb:
            continue
        pad = max(pad, dx - bb[0], dy - bb[1], bb[2] - (dx + W), bb[3] - (dy + H))
    pad = max(0, int(pad))
    out = []
    for fr in frames:
        canvas = Image.new("RGBA", (W + 2 * pad, H + 2 * pad), (0, 0, 0, 0))
        canvas.alpha_composite(fr, (pad - dx, pad - dy)) if (pad - dx >= 0 and pad - dy >= 0) else None
        if pad - dx < 0 or pad - dy < 0:
            # source window starts inside the padded clip: crop first, then paste
            crop = fr.crop((max(0, dx - pad), max(0, dy - pad), fr.width, fr.height))
            canvas.alpha_composite(crop, (max(0, pad - dx), max(0, pad - dy)))
        out.append(canvas)
    return out, pad


def on_canvas(base, size):
    """The base rotation centred on a (possibly padded) canvas of `size`."""
    if base.size == size:
        return base
    c = Image.new("RGBA", size, (0, 0, 0, 0))
    c.alpha_composite(base, ((size[0] - base.width) // 2, (size[1] - base.height) // 2))
    return c


# --- QA ----------------------------------------------------------------------

def _sil(im):
    return np.asarray(im.convert("RGBA"))[..., 3] > 0


def _iou(a, b):
    return (a & b).sum() / max(1, (a | b).sum())


def _flash(frames):
    """Painted-effect detector: the largest gain of near-white or bright-yellow
    opaque pixels in any frame over frame 0, as a share of the base silhouette.
    A body-only strike stays under 0.02; an impact flare or slash arc is
    0.15–0.7 (measured on 179 free-prose attacks vs the maintainer's 57)."""
    a = [np.asarray(f.convert("RGBA")) for f in frames]
    def bright(x):
        rgb = x[..., :3].astype(int); al = x[..., 3] > 0
        white = (rgb.min(-1) >= 225) & al
        yellow = (rgb[..., 0] >= 225) & (rgb[..., 1] >= 200) & (rgb[..., 2] <= 130) & al
        return (white | yellow).sum()
    area = max(1, int((a[0][..., 3] > 0).sum())); b0 = bright(a[0])
    return float(max((bright(x) - b0) / area for x in a[1:])) if len(a) > 1 else 0.0


def qa_clip(cid, state, d, frames, pinned=None):
    """Machine verdict for one direction's clip. See module docstring."""
    band = STATES[state]["band"]
    reasons = []
    spec = STATES[state]
    if pinned is None:
        pinned = spec.get("keep_first", True)
    want = spec["frames"] + (1 if pinned else 0)
    if len(frames) != want:
        reasons.append(f"{len(frames)} frames, expected {want}")
    if not frames:
        return {"status": "fail", "reasons": reasons}
    base = on_canvas(rotation(cid, d), frames[0].size)
    pad = (frames[0].width - rotation(cid, d).width) // 2
    ops = [_sil(f) for f in frames]
    sil = max(o.sum() for o in ops)
    step = [(ops[i] ^ ops[i + 1]).sum() / sil for i in range(len(ops) - 1)]
    step_mean = float(np.mean(step)) if step else 0.0
    cs = [np.argwhere(o).mean(0) if o.any() else np.zeros(2) for o in ops]
    drift = float(max(np.abs(np.array(cs) - cs[0]).max(1))) if cs else 0.0
    loop = float((ops[0] ^ ops[-1]).sum() / sil)
    b0 = _sil(base)
    pin = _iou(b0, ops[0])
    if pinned and pin < 0.98:
        # frame 0 must be the pinned base
        reasons.append(f"frame 0 is not the base rotation (IoU {pin:.2f})")
    xs = [np.argwhere(o)[:, 1].mean() if o.any() else 0 for o in ops]
    travel = float(max(xs) - min(xs))
    loop_ratio = float(loop / step_mean) if step_mean > 1e-6 else 0.0
    # facing: mid frames must match own base better than the mirrored opposite base
    if d in OPPOSITE:
        opp = ImageOps.mirror(on_canvas(rotation(cid, OPPOSITE[d]), frames[0].size))
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
    if design_flag(cid, f"{state}_slow"):
        # a crawl or a ripple moves less silhouette than a stride (the
        # maintainer's own tree_stump walk: 0.008 per frame, accepted)
        lo, wlo = lo * 0.4, wlo * 0.4
    if step_mean < wlo:
        reasons.append(f"frozen: silhouette moves {step_mean:.3f} per frame"); status = "fail"
    elif step_mean > whi:
        reasons.append(f"too much: silhouette moves {step_mean:.3f} per frame"); status = "fail"
    elif not (lo <= step_mean <= hi):
        reasons.append(f"motion {step_mean:.3f} outside the calm band {lo}–{hi} — eyeball it"); status = "warn"
    # drift scales with the body: a 240 px giant bobbing 7 px is the same 3 %
    # as a 112 px goblin bobbing 3 (the maintainer's 37 walks: median 2.2 px,
    # max 13 on a 256 px canvas)
    W0 = rotation(cid, d).width
    rel = (0.08, 0.15) if "peak_pass" in band else (0.03, 0.05)
    d_pass, d_warn = max(band["drift_pass"], rel[0] * W0), max(band["drift_warn"], rel[1] * W0)
    if drift > d_warn:
        reasons.append(f"drifts {drift:.1f} px (> {d_warn:.0f})"); status = "fail"
    elif drift > d_pass:
        reasons.append(f"drifts {drift:.1f} px — eyeball it"); status = "warn" if status != "fail" else status
    if "peak_pass" in band:
        peak = float(max((ops[0] ^ o).sum() / sil for o in ops[1:])) if len(ops) > 1 else 0.0
        if peak < band["peak_warn"]:
            reasons.append(f"no strike: peak {peak:.3f} of the silhouette away from the base"); status = "fail"
        elif peak < band["peak_pass"]:
            reasons.append(f"weak strike: peak {peak:.3f} — eyeball it"); status = "warn" if status != "fail" else status
    if "loop_max" in band and loop > band["loop_max"]:
        reasons.append(f"loop does not close (last vs first {loop:.3f})"); status = "fail"
    elif "loop_warn" in band and loop > band["loop_warn"]:
        # the game cuts back to idle after an attack; the maintainer's own
        # accepted attacks return only partly (loop up to 0.79) — eyeball it
        reasons.append(f"does not quite return (last vs first {loop:.3f}) — eyeball it"); status = "warn" if status != "fail" else status
    flash = _flash(frames) if "flash_max" in band else 0.0
    if "flash_max" in band and not design_flag(cid, "fx"):
        if flash > band["flash_max"]:
            reasons.append(f"painted effect: {flash:.2f} of the body in new bright pixels (flare/slash arc)"); status = "fail"
        elif flash > band["flash_warn"]:
            reasons.append(f"some bright effect pixels ({flash:.2f}) — eyeball it"); status = "warn" if status != "fail" else status
    if "loop_ratio_pass" in band and not pinned:
        if loop_ratio > band["loop_ratio_warn"]:
            reasons.append(f"last→first hand-off is {loop_ratio:.1f}× a normal step — the loop hitches"); status = "fail"
        elif loop_ratio > band["loop_ratio_pass"]:
            reasons.append(f"last→first hand-off {loop_ratio:.1f}× a step — eyeball the loop"); status = "warn" if status != "fail" else status
    if "travel_pass" in band:
        t_pass, t_warn = max(band["travel_pass"], 0.03 * W0), max(band["travel_warn"], 0.05 * W0)
        if travel > t_warn:
            reasons.append(f"walks across the canvas: {travel:.1f} px of x-travel (should be in place)"); status = "fail"
        elif travel > t_pass:
            reasons.append(f"{travel:.1f} px of x-travel — eyeball it"); status = "warn" if status != "fail" else status
    if any(("not the base" in r) or ("wrong way" in r) or ("expected" in r) for r in reasons):
        status = "fail"
    if pad > 0:
        reasons.append(f"canvas grown by {pad} px a side to hold the motion")
    return {"status": status, "step_mean": round(step_mean, 4), "step_max": round(float(max(step)) if step else 0, 4),
            "drift": round(drift, 2), "loop": round(loop, 4), "loop_ratio": round(loop_ratio, 2),
            "travel": round(travel, 2), "pin": round(float(pin), 3), "pad": pad, "flash": round(flash, 3),
            "peak": (round(peak, 4) if "peak_pass" in band else None),
            "canvas": list(frames[0].size), "reasons": reasons}


# --- manifest ------------------------------------------------------------------

def design_flag(cid, key):
    for c in cand.load_cfg()["candidates"]:
        if c["id"] == cid:
            return c.get(key)
    return None


def state_action(cid, state):
    """The action text for this monster's state: the design's `<state>_action`
    override if it has one (a cobra slithers, a crab scuttles, a wraith
    glides — the maintainer words per creature, "jumps like a frog"), else
    the state's default."""
    for c in cand.load_cfg()["candidates"]:
        if c["id"] == cid and c.get(f"{state}_action"):
            return c[f"{state}_action"]
    return STATES[state]["action"]


def _anim_record(man, state):
    rec = man.setdefault("animations", {}).setdefault(state, {"directions": {}})
    rec["action"] = state_action(man["id"], state)
    return rec


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


def generate_state(client, cid, state, dirs, version, verbose=True, pin=False):
    """Start one job per direction, wait, download the LAST take of each,
    QA, save, then mirror the three western directions from their eastern
    twins. Returns {direction: qa}."""
    man = cand.load_manifest(cid)
    rec = _anim_record(man, state)
    spec = STATES[state]
    jobs, actions, tries = {}, {}, {}
    for d in dirs:
        seed = seed_for(cid, state, d, version)
        pinned = spec["pin_end"] or pin
        end = rotation(cid, d) if pinned else None
        action = rec["action"]
        old = rec["directions"].get(d, {})
        tries[d] = (old.get("tries", 1) + 1) if (old.get("action") == action and old.get("status") == "fail") else 1
        if state == "attack" and tries[d] >= 3 and design_flag(cid, "claws"):
            # maintainer 2026-09-09: "if the monster has claws, a claw slash
            # usually works" — the worded strike failed twice, use that
            action = CLAW_SLASH
        actions[d] = action
        job = client.animate_v3(man["pixellab_id"], state, action, d,
                                frame_count=spec["frames"], end_frame=end, seed=seed,
                                keep_first=spec.get("keep_first", True) or pin)
        jobs[d] = job
        if verbose:
            print(f"  {cid:16s} {state} {d:11s} job {job} seed {seed}", flush=True)
    for d, job in jobs.items():
        if job:
            try:
                client.wait_job(job, timeout=900)
            except PixelLabError as e:
                print(f"  {cid} {d}: {e}")
    return collect_state(client, cid, state, dirs, version, verbose, pin=pin, actions=actions, tries=tries)


def collect_state(client, cid, state, dirs, version, verbose=True, pin=False, actions=None, tries=None):
    """Download the LAST take of each direction from PixelLab, align it to the
    base canvas, QA, save, mirror. Used after generation and by `fetch`.
    `actions` = {direction: action text} when a direction was made from other
    words than the state's (claw fallback); otherwise the recorded one."""
    man = cand.load_manifest(cid)
    rec = _anim_record(man, state)
    spec = STATES[state]
    actions = dict(actions or {})
    for d in dirs:
        actions.setdefault(d, rec["directions"].get(d, {}).get("action") or rec["action"])
    takes_by_action = {a: client.animation_takes(man["pixellab_id"], a) for a in set(actions.values())}
    out = {}
    for d in dirs:
        cands = takes_by_action[actions[d]].get(d) or []
        if not cands:
            out[d] = {"status": "fail", "reasons": ["no frames returned"]}
            continue
        urls, group = cands[-1]["urls"], cands[-1]["group"]
        frames = [f for f in client.download_many(urls) if f is not None]
        if len(frames) != len(urls):
            out[d] = {"status": "fail", "reasons": [f"downloaded {len(frames)}/{len(urls)} frames"]}
            continue
        pinned = spec.get("keep_first", True) or pin
        frames, pad = align_to_base(frames, rotation(cid, d), pinned=pinned)
        save_frames(cid, state, d, frames)
        qa = qa_clip(cid, state, d, frames, pinned=pinned)
        if pin:
            qa["pinned"] = True
            qa["reasons"].append("PINNED fallback: base → walk → base, not a seamless loop (maintainer's last resort)")
        qa.update({"sub": client.sub_id(urls[0]), "group": group, "takes": len(cands), "version": version, "mirrored": False,
                   "action": actions[d], "tries": (tries or {}).get(d, rec["directions"].get(d, {}).get("tries", 1)),
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
    nfr = spec["frames"] + (1 if spec.get("keep_first", True) else 0)
    rec["frame_paths"] = {d: [os.path.join(cid, "animations", state, d, f"{i:02d}{mirror.ART_EXT}")
                              for i in range(nfr)] for d in rec["directions"]}
    rec["strips"] = {d: os.path.join(cid, "animations", f"{state}__{d}{mirror.ART_EXT}") for d in rec["directions"]}
    write_manifest(cid, man)
    return out


def needed_dirs(man, state, redo=None):
    rec = (man.get("animations") or {}).get(state) or {"directions": {}}
    if redo:
        return list(redo)
    # a changed action text means the clips on disk were made from other
    # words — regenerate the whole state (the takes are keyed by that text)
    if rec["directions"] and rec.get("action") and rec["action"] != state_action(man["id"], state):
        return [d for d in GEN_DIRS if rec["directions"].get(d, {}).get("action") in (None, rec["action"])] or list(GEN_DIRS)
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
        # a reworded state: the old takes are keyed by the old text — delete them
        reworded = any(rec["directions"].get(d, {}).get("action") not in (None, rec["action"], CLAW_SLASH) for d in dirs)
        if redo or reworded:
            # a redo replaces the take: delete the old direction on PixelLab first
            for d in dirs:
                old_group = rec["directions"].get(d, {}).get("group")
                if not old_group:
                    continue
                try:
                    client.delete_animation(man["pixellab_id"], group_id=old_group, direction=d)
                except PixelLabError as e:
                    print(f"  {cid} {d}: old take not deleted ({e})")
        try:
            generate_state(client, cid, state, dirs, version, pin=bool(getattr(args, "pin", False)))
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
        for d, q in list(rec["directions"].items()):
            if q.get("mirrored") or q.get("manual"):
                continue
            frames = load_frames(cid, args.state, d)
            if not frames:
                continue
            new = qa_clip(cid, args.state, d, frames, pinned=(True if q.get("pinned") else None))
            if q.get("pinned"):
                new["pinned"] = True
                new["reasons"].append("PINNED fallback: base → walk → base, not a seamless loop (maintainer's last resort)")
            keep = {k: q[k] for k in ("sub", "group", "takes", "version", "mirrored", "generated_at", "action") if k in q}
            rec["directions"][d] = {**new, **keep}
            for md, src in MIRRORED.items():
                if src == d and rec["directions"][d]["status"] != "fail":
                    # (re)create the mirror — it was skipped if the source failed at generation time
                    if mirror_direction(cid, args.state, md):
                        rec["directions"][md] = dict(rec["directions"][d], mirrored=True, source=src)
                        nfr = STATES[args.state]["frames"] + (1 if STATES[args.state].get("keep_first", True) else 0)
                        rec.setdefault("frame_paths", {})[md] = [os.path.join(cid, "animations", args.state, md, f"{i:02d}{mirror.ART_EXT}") for i in range(nfr)]
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
    r.add_argument("--pin", action="store_true", help="pin start+end to the base (the maintainer's fallback for a clip that never loops)")
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
