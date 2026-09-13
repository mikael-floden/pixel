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
import collections
import json
import os
import re
import shutil
import sys
import time
import zlib
from datetime import datetime, timezone

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import candidates as cand  # noqa: E402
import postprocess as pp  # noqa: E402
import mirror  # noqa: E402
from pixellab_client import DIRECTIONS_8, PixelLabClient, PixelLabError  # noqa: E402

# A state has a LIVE record (`attack`) and, while a new take on that state is
# being tried, a CANDIDATE record (`attack_try`) that is generated alongside it
# and never shown to the game. Maintainer 2026-09-10: "it's possible to start
# generating an attack v2 without deleting v1 and only switch to v2 once v2 has
# proven it can generate the attack for all directions. Doing it this way can
# make you go back to v1 and try again if you see v2 was not easier at all."
TRY = "_try"


def base_state(slot):
    """The state a slot belongs to: 'attack_v3' and 'attack_try' -> 'attack'.
    Attempts are numbered (`<state>_v<N>`); nothing in candidates is live, so
    a bare state name is only the shape a promoted animation takes."""
    if slot.endswith(TRY):
        return slot[:-len(TRY)]
    m = re.match(r"^(.*)_v\d+$", slot)
    return m.group(1) if m else slot


GEN_DIRS = ["south", "south-east", "east", "north-east", "north"]
MIRRORED = {"south-west": "south-east", "west": "east", "north-west": "north-east"}
ALL_DIRS = GEN_DIRS + list(MIRRORED)
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
    # An attack must STRIKE. Pinning BOTH ends (end_frame = the base) makes
    # v3 interpolate base → … → base, and what comes back is a slow lean out
    # and back — the maintainer, on 39 monsters of it: "95% look like idle
    # animations. No strike/attack at all. The monster just moves slowly
    # forward and back again." So: frame 0 stays pinned to the base (he liked
    # that every clip starts from the idle pose) and THE END IS FREE — the
    # game cuts back to idle after ~700 ms, so the clip does not have to
    # return, and his own 57 accepted attacks mostly do not (loop up to 0.79).
    # 4 generated frames + the base = 5 stored, the shape of his own set.
    "attack": {
        "action": "Strike - Quickly lunges forward and strikes once",
        # PRO, not v3 (maintainer 2026-09-11, comparing his own clips with
        # mine: "you are using V3 with sometimes 9 frames, I was using PRO
        # with often only 4 frames"). Pro fixes its own count at 4, returns
        # the base canvas with no padding, takes no end_frame and no
        # keep_first_frame, and generates a monster's directions in sequence
        # so they agree with one another.
        "mode": "pro",
        "frames": 4,
        "pin_end": False,
        "keep_first": False,
        "band": {"step_pass": (0.080, 0.900), "step_warn": (0.040, 1.200),
                 "peak_pass": 0.15, "peak_warn": 0.08,
                 "reach_pass": 0.30, "reach_warn": 0.14,
                 "travel_pass": 0.12, "travel_warn": 0.20,
                 "drift_pass": 12.0, "drift_warn": 24.0,
                 "flash_warn": 0.04, "flash_max": 0.10},
    },
    # A die must END DEAD. Measured on his own 57 shipped dies (east): 34 are
    # 4 frames; the last frame differs from the first by 0.27–1.41 of the
    # silhouette (median 0.90 — the body is DOWN or GONE) where an idle's loop
    # closes under 0.05; silhouette step median 0.42, up to 0.93; the body's
    # height at the end is a median 0.71 of the start and 10 of 57 end fully
    # transparent. His wording is "faints and fades away" for 30 of them, the
    # rest creature-specific (melts into a puddle, cracks into a crystal pile,
    # burns up) — `die_action` per design carries that. Frame 0 is the base
    # (every clip starts from the idle pose, as his do) and the end is FREE:
    # the game plays a die once into the 1.1 s corpse window and never comes
    # back, so nothing may pin the end.
    "die": {
        "action": "Death - Faints, collapses to the ground and fades away",
        # SIX frames, not the attack's four (A/B on Warmaul south, 2026-09-12):
        # at 4 the model stands still for two frames and drops into a heap on
        # the third; at 6 it staggers, kneels, goes to its hands and lies down;
        # at 8 it pads five standing frames in front of the same 3-frame fall.
        "frames": 6,
        "frame_ladder": [6, 6, 8, 6, 6, 8, 6, 6, 8, 6],
        "pin_end": False,
        "keep_first": True,
        "facing": False,        # a body on the ground matches neither base — that check is noise here
        "band": {"step_pass": (0.100, 0.900), "step_warn": (0.050, 1.200),
                 # the centroid falls with the body: his 57 drift a median 20 px,
                 # p90 38, max 57 on canvases of 64–256 — 35 % / 55 % of the width
                 "drift_pass": 12.0, "drift_warn": 24.0, "drift_rel": (0.35, 0.55),
                 # last frame vs first: his minimum 0.27, p10 0.53
                 "fall_pass": 0.40, "fall_warn": 0.25,
                 "flash_record": True},
        # a die's own ladder: a clip that stays standing asks for a bigger
        # collapse, one that overflowed the canvas asks for a plainer one —
        # never the attack's swing/claw/extreme rungs
        "amplify": [
            "",
            ", a heavy dramatic collapse, the whole body going down onto the ground",
            ", collapses completely and lies flat on the ground, then fades away entirely",
            ", the whole body crumples to the ground and dissolves away to nothing",
        ],
        "calm": [
            "",
            ", a simple slow collapse, nothing added around it",
            ", only the body sinks down, no clouds, no smoke, no effects around it",
        ],
    },
}
# Maintainer 2026-09-10: "on some monsters you have to give a more and more
# extreme prompt until you get the movement you want. It's different for
# different monsters. Some need a prompt telling them to not move so much, some
# need a prompt telling them to swing in an aggressive attack!" and, when a
# fixed set of rungs still left creatures passive: "I said INCREASE the
# extremeness UNTIL you get the animation/movement you want."
#
# So the ladder has no ceiling worth reaching: every failed roll of a direction
# climbs it, and each rung is more extreme than the last — first the creature's
# own logical attack, then a simpler swooshing one, then the hand-written
# EVENT (`attack_extreme`: the shell bursts, the ground erupts), and from there
# the same event amplified further and further. A roll that failed for TOO MUCH
# motion goes the other way instead, into the calm rungs.
AMPLIFY = [
    "",
    ", a big aggressive swing",
    ", a huge aggressive attack with the whole body behind it, wide exaggerated motion",
    ", an extremely violent attack, huge exaggerated motion, the limb thrown far out",
    ", an explosively violent attack, the whole body thrown into it, debris and swoosh lines flying",
    ", the most violent attack imaginable, enormous exaggerated motion, the whole creature launching itself into it, debris exploding outward",
    ", an absurdly over-the-top attack, the creature contorting with the force of it, a huge burst of debris and swoosh lines filling the frame",
]
CALM = [
    "",
    ", a controlled strike, only the striking limb moves and the body stays planted",
    ", a small tight strike, the body barely moves",
]
CLAW_SLASH = ("Claw Swipe - Raises one front paw and performs one quick swipe forward, "
              "white swoosh lines following the claws")
SIMPLE_LUNGE = ("Lunge Attack - Throws its whole body forward in one fast lunge, "
                "white swoosh lines trailing behind it")
FRAME_LADDER = [4, 6, 4, 8, 4, 6, 4, 8, 6, 4]
MAX_TRIES = 10          # "keep retrying maybe 10 times before you give up the entire animation"
TOO_LITTLE = ("no strike", "just a lean", "weak strike", "frozen", "shallow strike", "outside the calm band",
              "still standing", "barely falls")
TOO_MUCH = ("too much", "drifts", "walks across", "slides across", "wrapped around",
            "outside the frame", "out of frame", "outside the screen", "goes outside")


def rung_for(prev_rung, reasons):
    """Which way the ladder moves after a failed roll: a passive clip climbs,
    a wild one steps down into the calm rungs."""
    text = " ".join(reasons or [])
    up = sum(k in text for k in TOO_LITTLE)
    down = sum(k in text for k in TOO_MUCH)
    if down > up:
        return max(prev_rung - 1, -len(CALM) + 1)
    return min(prev_rung + 1, len(AMPLIFY) - 1 + 3)


def ladder_action(cid, rung, base_action, state="attack"):
    """The wording for a rung. Climbing goes: the creature's own attack, the
    same amplified, a SIMPLER swooshing attack, then its hand-written EXTREME
    event, and from there that event amplified without end. Negative rungs
    calm the creature's own attack down instead. A state with its own rungs
    (`amplify`/`calm` on its STATES entry — die) climbs those and never
    borrows the attack's swing, claw or extreme event."""
    own = STATES.get(state) or {}
    if own.get("amplify"):
        amp, calm = own["amplify"], own.get("calm") or CALM
        if rung < 0:
            return base_action + calm[min(-rung, len(calm) - 1)]
        return base_action + amp[min(rung, len(amp) - 1)]
    extreme = design_flag(cid, "attack_extreme")
    simple = CLAW_SLASH if design_flag(cid, "claws") else SIMPLE_LUNGE
    if rung < 0:
        return base_action + CALM[min(-rung, len(CALM) - 1)]
    if rung == 0:
        return base_action
    if rung == 1:
        return base_action + AMPLIFY[1]
    if rung == 2:
        return simple + AMPLIFY[1]
    if not extreme:
        return base_action + AMPLIFY[min(rung - 1, len(AMPLIFY) - 1)]
    if rung == 3:
        return extreme
    return extreme + AMPLIFY[min(rung - 2, len(AMPLIFY) - 1)]


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

def unwrap_clip(frames, base_size):
    """SAVE a clip that rendered past the canvas edge instead of failing it.
    PixelLab wraps overflow to the opposite edge, usually on the next frame
    (maintainer 2026-09-09: "pixels rendered outside the frame will pop up in
    the next frame on the other side") — the shipped monsters have had a
    repair pass for this since sync; candidates now get the same one. The
    canvas grows, each wrapped strip is lifted off the frame it landed on and
    pasted back beyond the true border of the frame it belongs to.
    Returns (frames, pad, n_fixes)."""
    arrs = [np.asarray(f.convert("RGBA")) for f in frames]
    W, H = base_size
    if any(a.shape[1] != W or a.shape[0] != H for a in arrs):
        return frames, 0, 0                      # not on the native canvas
    fixes = pp.detect(arrs, (W, H))
    if not fixes:
        return frames, 0, 0
    pad = min(64, max(f["ext"] for f in fixes) + 2)
    padded = [pp._recanvas(a.copy(), (W + 2 * pad, H + 2 * pad)) for a in arrs]
    n = 0
    for fx in fixes:
        strip = pp._strip_mask(arrs[fx["frame"]], fx["side"], (W, H))
        if strip is None:
            continue
        pp._apply_fix(padded[fx["frame"]], padded[fx["target"]], strip,
                      fx["side"], (W, H), (pad, pad))
        n += 1
    return [Image.fromarray(a, "RGBA") for a in padded], pad, n


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
    0.12–0.7 (measured on 179 free-prose attacks vs the maintainer's 57:
    median 0.001, the 11 over 0.10 are his aura/flame monsters). Blind to
    orange/yellow fire bursts by design — counting vivid pixels flagged a
    third of his accepted set — so fx monsters are eyeballed on the page."""
    a = [np.asarray(f.convert("RGBA")) for f in frames]
    def bright(x):
        rgb = x[..., :3].astype(int); al = x[..., 3] > 0
        white = (rgb.min(-1) >= 200) & al   # near-white AND the pale cream swoosh (245,240,210)
        yellow = (rgb[..., 0] >= 225) & (rgb[..., 1] >= 200) & (rgb[..., 2] <= 130) & al
        cyan = (rgb[..., 2] >= 225) & (rgb[..., 1] >= 200) & (rgb[..., 0] <= 150) & al   # the cyan slash arc
        return (white | yellow | cyan).sum()
    area = max(1, int((a[0][..., 3] > 0).sum())); b0 = bright(a[0])
    return float(max((bright(x) - b0) / area for x in a[1:])) if len(a) > 1 else 0.0


def _dilate(m):
    o = m.copy()
    o[1:, :] |= m[:-1, :]; o[:-1, :] |= m[1:, :]
    o[:, 1:] |= m[:, :-1]; o[:, :-1] |= m[:, 1:]
    return o


def _wrapped(op):
    """True when the silhouette touches both opposite edges with a gap between:
    PixelLab drew past the canvas and the overflow reappeared on the other side
    (maintainer 2026-09-09: "pixels rendered outside the frame will pop up in
    the next frame on the other side")."""
    def split(o):
        return bool(len(o) and o[0] and o[-1] and (~o).any())
    return split(op.any(0)) or split(op.any(1))


def _reach(ops, base_op, cap=48):
    """Does it STRIKE or just lean? A strike puts pixels FAR outside the base
    silhouette (a limb or weapon extends); a lean translates the whole body,
    so every new pixel hugs the base outline. reach = the 95th-percentile
    distance of new pixels from the base, over the base's short side.
    Measured on the maintainer's 57 accepted attacks (east): median 0.45,
    p25 0.34, p10 0.23, minimum 0.14 — against 0.26 median for the 39
    lean-shaped ones he rejected. FAIL is set at his floor of 0.14, not at
    his p10: between there and the 0.30 pass line the clip is a real but
    modest strike (an armoured elephant driving its head down is not going to
    reach like a club swing) and the call is his on the review page, not the
    machine's. Distance by successive dilation (no scipy)."""
    d = np.full(base_op.shape, cap, np.int16); cur = base_op.copy(); d[base_op] = 0
    for k in range(1, cap):
        nxt = _dilate(cur); ring = nxt & ~cur
        if not ring.any():
            break
        d[ring] = k; cur = nxt
    ys, xs = np.where(base_op)
    if not len(ys):
        return 0.0
    scale = min(ys.max() - ys.min() + 1, xs.max() - xs.min() + 1) or 1
    out = [float(np.percentile(d[o & ~base_op], 95)) if (o & ~base_op).any() else 0.0 for o in ops[1:]]
    return (max(out) / scale) if out else 0.0


def frames_for(rolls, state="attack"):
    """How many frames this roll asks PixelLab for: the state's own ladder when
    it has one (die), else FRAME_LADDER."""
    ladder = (STATES.get(state) or {}).get("frame_ladder") or FRAME_LADDER
    return ladder[(max(1, int(rolls or 1)) - 1) % len(ladder)]


def _facing_walk(cid, frames):
    """How far the clip TURNS while it plays: for each frame, which of the 8
    base rotations its silhouette matches best, as a step count around the
    compass. The maintainer rejects this by eye — "the direction flips between
    E and S in the middle of the animation", "the head ends up in the butt" —
    so it is measured here instead of reaching him."""
    try:
        bases = [_sil(on_canvas(rotation(cid, b), frames[0].size)) for b in ALL_DIRS]
    except Exception:
        return 0
    idx = []
    for f in frames:
        o = _sil(f)
        idx.append(int(np.argmax([_iou(o, b) for b in bases])))
    steps = [min((a - b) % 8, (b - a) % 8) for a, b in zip(idx, idx[1:])]
    return max(steps) if steps else 0


def qa_clip(cid, state, d, frames, pinned=None, claw_take=False, want_frames=None):
    """Machine verdict for one direction's clip. See module docstring."""
    band = STATES[base_state(state)]["band"]
    reasons = []
    spec = STATES[base_state(state)]
    if pinned is None:
        pinned = spec.get("keep_first", True)
    # PRO picks its own length — the maintainer's own shipped attacks run 4, 6,
    # 9 and 16 frames — so only a v3-mode clip has a count to check against.
    # (Measured 2026-09-11: gating pro on 4 threw away 45 perfectly good clips
    # in one round, the entire round's spend.)
    want = (want_frames or spec["frames"]) + (1 if pinned else 0)
    if spec.get("mode") != "pro" and len(frames) != want:
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
    if d in OPPOSITE and spec.get("facing", True):
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
    if design_flag(cid, f"{base_state(state)}_slow"):
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
    rel = band.get("drift_rel") or ((0.08, 0.15) if "peak_pass" in band else (0.03, 0.05))
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
    flash = _flash(frames) if ("flash_max" in band or band.get("flash_record")) else 0.0
    # RECORDED, NEVER GATED: this measure agrees with him on three of his
    # redo notes and then rates a direction he APPROVED (Cragtroll east) worse
    # than all of them. Facing is his call — "I don't trust your eyes to
    # correct this. Let this be something only I can correct" — so the number
    # goes on the record and on the review page, and rejects nothing.
    turn = _facing_walk(cid, frames) if "reach_pass" in band else None
    if any(_wrapped(o) for o in ops):
        reasons.append("wrapped around the canvas edge: the body is drawn in two pieces"); status = "fail"
    if "reach_pass" in band:
        rch = _reach(ops, _sil(base))
        if claw_take:
            # the maintainer asks for these takes: "a claw attack with swoosh
            # lines often works", "the crab's shell explodes in a powerful
            # attack". Their drama is drawn AT the body — a burst, a swoosh,
            # flying shards — so the limb-extension measure undervalues them
            # (Tide Crab's bursting shell reads as a real attack and scores
            # 0.08). For these wordings the effect IS the strike, so whichever
            # is larger stands.
            rch = max(rch, flash)
        if rch < band["reach_warn"]:
            reasons.append(f"no strike, just a lean: nothing reaches past {rch:.2f} of the body"); status = "fail"
        elif rch < band["reach_pass"]:
            reasons.append(f"shallow strike: reach {rch:.2f} — eyeball it"); status = "warn" if status != "fail" else status
    else:
        rch = None
    if "fall_pass" in band:
        # a die must END DEAD: the last frame is the body down or gone, never
        # the pose it started in (his 57: last vs first 0.27–1.41, median 0.90)
        if loop < band["fall_warn"]:
            reasons.append(f"still standing: the last frame is only {loop:.2f} of the silhouette away from the first — no collapse"); status = "fail"
        elif loop < band["fall_pass"]:
            reasons.append(f"barely falls: last vs first {loop:.2f} — eyeball it"); status = "warn" if status != "fail" else status
    if "loop_max" in band and loop > band["loop_max"]:
        reasons.append(f"loop does not close (last vs first {loop:.3f})"); status = "fail"
    elif "loop_warn" in band and loop > band["loop_warn"]:
        # the game cuts back to idle after an attack; the maintainer's own
        # accepted attacks return only partly (loop up to 0.79) — eyeball it
        reasons.append(f"does not quite return (last vs first {loop:.3f}) — eyeball it"); status = "warn" if status != "fail" else status
    if "flash_max" in band:
        fmax, fwarn = band["flash_max"], band["flash_warn"]
        if claw_take:
            fmax, fwarn = 0.45, 0.35   # the swoosh IS the attack he asked for
        elif design_flag(cid, "fx"):
            fmax, fwarn = fmax * 5, fwarn * 6   # the effect IS the attack; only an explosion fails
        if flash > fmax:
            reasons.append(f"painted effect: {flash:.2f} of the body in new bright pixels (flare/slash arc)"); status = "fail"
        elif flash > fwarn:
            reasons.append(f"some bright effect pixels ({flash:.2f}) — eyeball it"); status = "warn" if status != "fail" else status
    if "loop_ratio_pass" in band and not pinned:
        if loop_ratio > band["loop_ratio_warn"]:
            reasons.append(f"last→first hand-off is {loop_ratio:.1f}× a normal step — the loop hitches"); status = "fail"
        elif loop_ratio > band["loop_ratio_pass"]:
            reasons.append(f"last→first hand-off {loop_ratio:.1f}× a step — eyeball the loop"); status = "warn" if status != "fail" else status
    if "travel_pass" in band and "reach_pass" in band:
        # an attack does not travel: the game moves the sprite, the clip does
        # not. His own 57 accepted attacks move the body a median 4% of its
        # width, 10% at the 90th, 16% at the very worst (Plague Hound's dash).
        t_pass, t_warn = band["travel_pass"] * W0, band["travel_warn"] * W0
        if travel > t_warn:
            reasons.append(f"slides across the canvas: {travel:.0f} px of travel, not a strike"); status = "fail"
        elif travel > t_pass:
            reasons.append(f"{travel:.0f} px of travel — eyeball it"); status = "warn" if status != "fail" else status
    elif "travel_pass" in band:
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
            "reach": (round(rch, 3) if rch is not None else None), "turn": turn,
            "end_area": round(float(ops[-1].sum() / max(1, ops[0].sum())), 3),
            "canvas": list(frames[0].size), "reasons": reasons}


# --- manifest ------------------------------------------------------------------

def design_flag(cid, key):
    for c in cand.load_cfg()["candidates"]:
        if c["id"] == cid:
            return c.get(key)
    return None


def intensity_of(man, slot):
    """Deprecated monster-level dial, kept so old manifests still read."""
    return int(((man.get("animations") or {}).get(slot) or {}).get("intensity", 0))


def state_action(cid, state, man=None):
    """The action text for this monster's state: the design's `<state>_action`
    override if it has one (a cobra slithers, a crab scuttles, a wraith
    glides — the maintainer words per creature, "jumps like a frog"), else the
    state's default. The ESCALATION lives in `ladder_action`, per direction,
    not here — this is rung 0."""
    slot, state = state, base_state(state)
    base = STATES[state]["action"]
    for c in cand.load_cfg()["candidates"]:
        if c["id"] == cid and c.get(f"{state}_action"):
            base = c[f"{state}_action"]; break
    return base


def _anim_record(man, slot):
    """The live record keeps the wording it was GENERATED with — a config
    reword must not silently invalidate art the maintainer already approved.
    Only a `_try` record tracks the current config text; promoting it is what
    moves the new wording into the live state."""
    rec = man.setdefault("animations", {}).setdefault(slot, {"directions": {}})
    if slot.endswith(TRY) or not rec.get("action"):
        rec["action"] = state_action(man["id"], slot, man)
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
    spec = STATES[base_state(state)]
    jobs, actions, tries, counts, rungs = {}, {}, {}, {}, {}
    # ONE frame count for the whole monster's state. A state whose directions
    # disagree about their length is not one animation: every viewer that
    # slices the strip by a single count draws two monsters sliding past each
    # other (measured 2026-09-10 — 21 of 39 monsters, straight into the wiki).
    # The ladder still walks the count, but it walks it for the whole monster.
    _prev = [(q.get("rolls") or 1) for d, q in (rec.get("directions") or {}).items()
             if d in dirs and q.get("status") == "fail" and not q.get("mirrored")]
    if spec.get("mode") == "pro":
        # ONE call for the whole monster: PRO generates the directions in
        # SEQUENCE, each using the finished ones as reference, which is what
        # makes its views agree with one another — and it fixes its own frame
        # count at 4. So every direction of a monster shares one wording: the
        # rung its worst direction has climbed to.
        rung = None
        for d in dirs:
            old = rec["directions"].get(d, {})
            r = old.get("rung", 0)
            if old.get("status") == "fail":
                r = rung_for(r, old.get("reasons"))
            # the loudest direction sets the wording — and a NEGATIVE rung must
            # be reachable (a `max` seeded with 0 pinned every PRO roll at the
            # plain attack: a clip that failed for drifting could never calm)
            rung = r if rung is None else max(rung, r)
            tries[d] = (old.get("rolls", 0) + 1) if old.get("status") == "fail" else 1
        rung = rung or 0
        if spec.get("ladder_restart"):
            rung = 0        # a new generator starts from the design's own words
        action = ladder_action(cid, rung, rec["action"], base_state(state))
        for d in dirs:
            actions[d], rungs[d], counts[d] = action, rung, spec["frames"]
        ids = client.animate_pro(man["pixellab_id"], action, dirs, name=state,
                                 seed=seed_for(cid, state, "all", version))
        if verbose:
            print(f"  {cid:16s} {state} PRO {len(dirs)} dir(s) rung {rung:+d} "
                  f"job {(ids or [None])[0]}", flush=True)
        for j in ids:
            try:
                client.wait_job(j, timeout=3600)
            except PixelLabError as e:
                print(f"  {cid}: {e}", flush=True)
        return collect_state(client, cid, state, dirs, version, verbose, pin=pin,
                             actions=actions, tries=tries, counts=counts, rungs=rungs)
    keep = collections.Counter(
        n for d, n in frame_counts(cid, state).items()
        if d in GEN_DIRS and (rec.get("directions", {}).get(d, {}).get("status") in ("pass", "warn")))
    nf = keep.most_common(1)[0][0] - 1 if keep else frames_for(max(_prev) + 1 if _prev else 1, base_state(state))
    for d in dirs:
        seed = seed_for(cid, state, d, version)
        pinned = spec["pin_end"] or pin
        end = rotation(cid, d) if pinned else None
        old = rec["directions"].get(d, {})
        # every failed roll of THIS direction climbs the ladder one rung —
        # more extreme until the movement is there (or calmer, if the last
        # roll was wild). The rung, not a monster-wide dial, is the escalation.
        rung = old.get("rung", 0)
        if old.get("status") == "fail":
            rung = rung_for(rung, old.get("reasons"))
        rungs[d] = rung
        tries[d] = (old.get("rolls", 0) + 1) if old.get("status") == "fail" else 1
        action = ladder_action(cid, rung, rec["action"], base_state(state))
        actions[d] = action
        counts[d] = nf
        job = client.animate_v3(man["pixellab_id"], state, action, d,
                                frame_count=nf, end_frame=end, seed=seed,
                                keep_first=spec.get("keep_first", True) or pin)
        jobs[d] = job
        if verbose:
            print(f"  {cid:16s} {state} {d:11s} job {job} {nf}f roll {tries[d]} rung {rungs[d]:+d}", flush=True)
    groups = {}
    for d, job in jobs.items():
        if job:
            try:
                j = client.wait_job(job, timeout=900)
                groups[d] = (j.get("last_response") or {}).get("animation_group_id")
            except PixelLabError as e:
                print(f"  {cid} {d}: {e}")
    return collect_state(client, cid, state, dirs, version, verbose, pin=pin, actions=actions, tries=tries, groups=groups, counts=counts, rungs=rungs)


def collect_state(client, cid, state, dirs, version, verbose=True, pin=False, actions=None, tries=None, groups=None, counts=None, rungs=None):
    """Download the LAST take of each direction from PixelLab, align it to the
    base canvas, QA, save, mirror. Used after generation and by `fetch`.
    `actions` = {direction: action text} when a direction was made from other
    words than the state's (claw fallback); otherwise the recorded one.
    `groups` = {direction: animation_group_id} of the jobs just run — the take
    is picked by that id. PixelLab's animation list is NOT in creation order
    (measured 2026-09-09: a re-roll's `[-1]` re-downloaded the previous take
    three monsters in a row, verdict unchanged to four decimals, $0.25 of
    clips never looked at); `[-1]` is only the fallback for `fetch`."""
    man = cand.load_manifest(cid)
    rec = _anim_record(man, state)
    spec = STATES[base_state(state)]
    actions = dict(actions or {})
    for d in dirs:
        actions.setdefault(d, rec["directions"].get(d, {}).get("action") or rec["action"])
    takes_by_action = {a: client.animation_takes(man["pixellab_id"], a) for a in set(actions.values())}
    out = {}
    for d in dirs:
        cands = takes_by_action[actions[d]].get(d) or []
        want = (groups or {}).get(d)
        if want:
            cands = [t for t in cands if t["group"] == want] or []
        if not cands:
            out[d] = {"status": "fail", "reasons": ["no frames returned" + (f" for job group {want[:8]}" if want else "")]}
            continue
        urls, group = cands[-1]["urls"], cands[-1]["group"]
        frames = [f for f in client.download_many(urls) if f is not None]
        if len(frames) != len(urls):
            out[d] = {"status": "fail", "reasons": [f"downloaded {len(frames)}/{len(urls)} frames"]}
            continue
        pinned = spec.get("keep_first", True) or pin
        base_img = rotation(cid, d)
        frames, upad, nfix = unwrap_clip(frames, base_img.size)
        frames, pad = align_to_base(frames, base_img, pinned=pinned)
        save_frames(cid, state, d, frames)
        qa = qa_clip(cid, state, d, frames, pinned=pinned,
                     claw_take=(rungs or {}).get(d, 0) >= 2,
                     want_frames=(counts or {}).get(d))
        if pin:
            qa["pinned"] = True
            qa["reasons"].append("PINNED fallback: base → walk → base, not a seamless loop (maintainer's last resort)")
        qa.update({"sub": client.sub_id(urls[0]), "group": group, "takes": len(cands), "version": version, "mirrored": False,
                   "action": actions[d], "intensity": intensity_of(man, state),
                   "rolls": (tries or {}).get(d, 1), "frames": len(frames),
                   "rung": (rungs or {}).get(d, 0),
                   "unwrapped": nfix or None, "tries": (tries or {}).get(d, rec["directions"].get(d, {}).get("tries", 1)),
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
    rec["frame_paths"] = {d: [os.path.join(cid, "animations", state, d, f)
                              for f in sorted(os.listdir(anim_dir(cid, state, d)))
                              if f.endswith(mirror.ART_EXT)]
                          for d in rec["directions"] if os.path.isdir(anim_dir(cid, state, d))}
    rec["strips"] = {d: os.path.join(cid, "animations", f"{state}__{d}{mirror.ART_EXT}") for d in rec["directions"]}
    write_manifest(cid, man)
    return out


def frame_counts(cid, slot):
    """{direction: frames on disk} for a slot."""
    out = {}
    for d in ALL_DIRS:
        p = anim_dir(cid, slot, d)
        if os.path.isdir(p):
            out[d] = len([f for f in os.listdir(p) if f.endswith(mirror.ART_EXT)])
    return out


def needed_dirs(man, slot, redo=None):
    rec = (man.get("animations") or {}).get(slot) or {"directions": {}}
    if redo:
        return list(redo)
    # directions that disagree about their length are not one animation — but
    # only the odd ones out are redone, at the count the working ones use
    counts = frame_counts(man["id"], slot)
    gen = {d: n for d, n in counts.items() if d in GEN_DIRS}
    if len(set(gen.values())) > 1:
        good = collections.Counter(n for d, n in gen.items()
                                   if rec["directions"].get(d, {}).get("status") in ("pass", "warn"))
        target = (good or collections.Counter(gen.values())).most_common(1)[0][0]
        odd = [d for d in GEN_DIRS if gen.get(d) not in (None, target)]
        missing = [d for d in GEN_DIRS if d not in gen]
        failing = [d for d in GEN_DIRS if rec["directions"].get(d, {}).get("status") == "fail"]
        return sorted(set(odd + missing + failing), key=GEN_DIRS.index)
    # a changed action text means the clips on disk were made from other words
    # — regenerate the whole slot (the takes are keyed by that text). A state
    # is ONE take across all eight directions, never a mix of wordings.
    if rec["directions"] and rec.get("action") and rec["action"] != state_action(man["id"], slot):
        return [d for d in GEN_DIRS if rec["directions"].get(d, {}).get("action") in (None, rec["action"])] or list(GEN_DIRS)
    # a direction that has already been rolled MAX_TRIES times is not worth
    # another roll — the attack CONCEPT is wrong, not the dice (maintainer:
    # "keep retrying maybe 10 times before you give up the entire animation")
    return [d for d in GEN_DIRS
            if rec["directions"].get(d, {}).get("status") in (None, "fail")
            and (rec["directions"].get(d, {}).get("rolls") or 0) < MAX_TRIES]


def cmd_state(args, state):
    cfg = cand.load_cfg()
    if getattr(args, "pro", False):
        # THE ESCAPE FOR A BODY v3 WILL NOT CHANGE (measured 2026-09-13, Shellet
        # south): v3 interpolating from the pinned base kept a flat body intact
        # through six rolls and every rung of wording, and an empty end_frame
        # only cut to nothing on the last frame; PRO drew the shell cracking
        # apart and the turtle melting into a puddle that shrinks away, 16
        # frames, ~$0.19 a direction. PRO takes no pins and fixes its own
        # count, so keep_first is off and the ladder restarts at the design's
        # own words. Regenerate a monster's five directions together — one
        # count across the state, and PRO makes its views agree.
        spec = STATES[base_state(state)]
        spec["mode"], spec["keep_first"], spec["ladder_restart"] = "pro", False, True
    ids = args.only.split(",") if args.only else [c["id"] for c in cfg["candidates"]
                                                  if (cand.load_manifest(c["id"]) or {}).get("review") == "approved"]
    redo = args.dirs.split(",") if getattr(args, "dirs", None) else None
    plan, reworded = [], []
    for cid in ids:
        man = cand.load_manifest(cid)
        if not man:
            print(f"{cid}: no candidate"); continue
        # turn the wording dial before deciding what to regenerate: a monster
        # whose last round came back limp asks louder this time (and the whole
        # monster is redone at the new setting, so its eight directions stay
        # one take — maintainer: "you might have to redo the entire prompt
        # (all directions) in order to get a full 8 set that is valid")
        rec_now = (man.get("animations") or {}).get(state) or {}
        if (base_state(state) == state and rec_now.get("directions")
                and rec_now.get("action") and rec_now["action"] != state_action(cid, state)):
            # the config asks for a DIFFERENT take on a state that already has
            # art. Rewriting the live state in place would leave it half old
            # wording, half new until the sweep finished — build it in the try
            # slot and promote it when every direction is there (maintainer).
            reworded.append(cid); continue
        dirs = needed_dirs(man, state, redo)
        if dirs:
            plan.append((cid, dirs))
    if reworded:
        print(f"{len(reworded)} monster(s) have live {state} art made from other words "
              f"({', '.join(reworded[:4])}{'…' if len(reworded) > 4 else ''}).\n"
              f"  Build the new take alongside it:  animate.py {state} --try\n"
              f"  then, once every direction is there:  animate.py promote --state {state}")
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
        # every regeneration clears the direction's old takes on PixelLab first —
        # a direction is only regenerated when missing, failed or reworded, so
        # nothing kept is lost and the record never accumulates rejected rolls
        old_actions = {rec["directions"].get(d, {}).get("action") for d in dirs} | {rec["action"], CLAW_SLASH}
        for a in old_actions:
            if not a:
                continue
            try:
                takes = client.animation_takes(man["pixellab_id"], a)
            except PixelLabError as e:
                print(f"  {cid}: takes not listed ({e})"); continue
            for d in dirs:
                for t in takes.get(d) or []:
                    try:
                        client.delete_animation(man["pixellab_id"], group_id=t["group"], direction=d)
                    except PixelLabError as e:
                        print(f"  {cid} {d}: old take not deleted ({e})")
        try:
            generate_state(client, cid, state, dirs, version, pin=bool(getattr(args, "pin", False)))
        except PixelLabError as e:
            print(f"  {cid}: FAILED — {e}", flush=True)
        cand.rebuild_index(cfg)
    # his notes are consumed by the regeneration they asked for — clear them
    # here so he never reads an old comment under a new clip
    try:
        migrate_feedback_slots(verbose=False)
        cmd_prune_feedback(argparse.Namespace(dry_run=False))
    except Exception as e:
        print(f"  feedback not tidied ({e})")
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
            new = qa_clip(cid, args.state, d, frames,
                          pinned=(True if q.get("pinned") else None),
                          claw_take=(q.get("rung") or 0) >= 2,
                          want_frames=(len(frames) - (1 if STATES[base_state(args.state)].get("keep_first", True) else 0)))
            if q.get("pinned"):
                new["pinned"] = True
                new["reasons"].append("PINNED fallback: base → walk → base, not a seamless loop (maintainer's last resort)")
            # the ladder's state lives on the verdict — a re-QA must never drop
            # it, or every sweep restarts at rung one with the same wording
            keep = {k: q[k] for k in ("sub", "group", "takes", "version", "mirrored",
                                      "generated_at", "action", "tries", "rolls",
                                      "intensity", "frames", "manual", "rung") if k in q}
            rec["directions"][d] = {**new, **keep}
            for md, src in MIRRORED.items():
                if src == d and rec["directions"][d]["status"] != "fail":
                    # (re)create the mirror — it was skipped if the source failed at generation time
                    if mirror_direction(cid, args.state, md):
                        rec["directions"][md] = dict(rec["directions"][d], mirrored=True, source=src)
                        rec.setdefault("frame_paths", {})[md] = [
                            os.path.join(cid, "animations", args.state, md, f)
                            for f in sorted(os.listdir(anim_dir(cid, args.state, md)))
                            if f.endswith(mirror.ART_EXT)]
                        rec.setdefault("strips", {})[md] = os.path.join(cid, "animations", f"{args.state}__{md}{mirror.ART_EXT}")
        write_manifest(cid, man)
    cand.rebuild_index(cfg)


def _slot_takes_delete(client, man, rec, verbose=True):
    """Delete every PixelLab take a record points at (its own wording per
    direction). Approved art is NOT sacred: when a state is replaced by a
    different attack, the directions it replaces have to go, or the character
    carries two contradictory attacks and sync cannot tell which is the state
    (maintainer 2026-09-10)."""
    n = 0
    for d, q in list((rec.get("directions") or {}).items()):
        gid = q.get("group")
        if not gid or q.get("mirrored"):
            continue
        try:
            client.delete_animation(man["pixellab_id"], group_id=gid, direction=d); n += 1
        except PixelLabError as e:
            print(f"  {man['id']} {d}: take not deleted ({e})")
    if verbose:
        print(f"  {man['id']}: deleted {n} take(s) on PixelLab")
    return n


def _slot_files_delete(cid, slot, dirs):
    for d in dirs:
        p = anim_dir(cid, slot, d)
        if os.path.isdir(p):
            shutil.rmtree(p)
        strip = os.path.join(cand.cdir(cid), "animations", f"{slot}__{d}{mirror.ART_EXT}")
        if os.path.exists(strip):
            os.remove(strip)


FEEDBACK = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                        "live", "feedback", "monsters.json")


def cmd_review(args):
    """Read HIS verdicts out of live/feedback/monsters.json and apply them to a
    slot: 'redo' and 'rejected' become fails carrying his note, so the next
    sweep re-rolls exactly those directions and the ladder climbs from what he
    said. Keys are 'monsters/<id>#<slot>#<direction>'. He decides; this only
    carries the decision into the pipeline."""
    cfg = cand.load_cfg()
    try:
        entries = (json.load(open(FEEDBACK)) or {}).get("entries") or {}
    except FileNotFoundError:
        print(f"no feedback at {FEEDBACK}"); return
    want = args.state
    marked = cleared = 0
    per = {}
    for key, v in entries.items():
        if "#" not in key:
            continue
        path, _, rest = key.partition("#")
        slot, _, d = rest.partition("#")
        cid = path.split("/")[-1]
        if slot != want or d not in ALL_DIRS:
            continue
        per.setdefault(cid, {})[d] = v
    for cid, dirs in sorted(per.items()):
        man = cand.load_manifest(cid)
        rec = (man.get("animations") or {}).get(want) if man else None
        if not rec:
            continue
        touched = False
        for d, v in dirs.items():
            q = rec["directions"].get(d)
            if not q:
                continue
            st = (v.get("status") or "").lower()
            note = (v.get("note") or "").strip()
            made, said = q.get("generated_at"), v.get("updated_at")
            if made and said and made > said:
                # already acted on: this direction was regenerated AFTER he
                # wrote the note, so re-applying it would fail fresh art for a
                # defect in a clip that no longer exists. prune-feedback drops
                # the entry; nothing to do here.
                continue
            if st in ("redo", "rejected"):
                src = MIRRORED.get(d)           # a mirror is fixed by redoing its source
                tgt = rec["directions"].get(src) if src else None
                for qq, dd in ((q, d),) + (((tgt, src),) if tgt else ()):
                    if qq.get("status") == "fail" and qq.get("maintainer") == note:
                        continue
                    qq["status"] = "fail"
                    qq["maintainer"] = note or st
                    qq["reasons"] = [f"HE says redo: {note or st}"] + [r for r in (qq.get("reasons") or [])
                                                                      if "HE says redo" not in r]
                    marked += 1
                print(f"  {cid} {d}: redo — {note[:70] or st}" + (f"  (+ mirror {src})" if src else ""))
                touched = True
            elif st == "approved" and q.get("status") == "fail":
                q["status"] = "warn"; q["maintainer"] = "approved"
                q["reasons"] = ["HE approved it"]; cleared += 1; touched = True
        if touched:
            write_manifest(cid, man)
    print(f"{marked} direction(s) marked for redo, {cleared} approved despite the machine")
    cand.rebuild_index(cfg)


def _feedback_doc():
    try:
        return json.load(open(FEEDBACK))
    except FileNotFoundError:
        return None


def _write_feedback(doc):
    with open(FEEDBACK, "w") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
        f.write("\n")


def migrate_feedback_slots(verbose=True):
    """A slot rename must carry HIS verdicts with it. Renaming `attack` to
    `attack_v1` (2026-09-11) orphaned 49 of them — including approvals, which
    are his picks and must never be lost — because the key holds the slot
    name: `monsters/<id>#<slot>#<direction>`."""
    doc = _feedback_doc()
    if not doc:
        return 0
    entries = doc.get("entries") or {}
    moved = 0
    for key in list(entries):
        if "#" not in key:
            continue
        path, _, rest = key.partition("#")
        slot, _, d = rest.partition("#")
        cid = path.split("/")[-1]
        if slot not in STATES or d not in ALL_DIRS:
            continue
        if os.path.isdir(anim_dir(cid, slot, d)):
            continue                              # the slot still exists as named
        for n in range(1, 9):                     # find where that art went
            cand_slot = f"{slot}_v{n}"
            if os.path.isdir(anim_dir(cid, cand_slot, d)):
                new = f"{path}#{cand_slot}#{d}"
                if new not in entries:
                    entries[new] = entries[key]
                    if verbose:
                        print(f"  moved {key} -> {cand_slot}")
                    moved += 1
                entries.pop(key, None)
                break
    if moved:
        doc["entries"] = entries
        _write_feedback(doc)
    return moved


def cmd_migrate_feedback(args):
    n = migrate_feedback_slots()
    print(f"{n} verdict(s) followed their slot's rename")


def cmd_prune_feedback(args):
    """Delete a redo verdict once the art it judged HAS BEEN REGENERATED. His
    note has done its job at that point and only misleads: he sees his own old
    words under a clip that no longer exists (2026-09-11: "I can still see my
    old comment even when you have acted on it and generated a new animation.
    My comment is obsolete and should be removed when you act on the review").
    Same lifecycle the tiles agent already follows. An APPROVAL is never
    pruned — that is his pick, and it has to outlive the review."""
    try:
        doc = json.load(open(FEEDBACK))
    except FileNotFoundError:
        print(f"no feedback at {FEEDBACK}"); return
    entries = doc.get("entries") or {}
    drop = []
    for key, v in entries.items():
        if (v.get("status") or "").lower() not in ("redo", "rejected") or "#" not in key:
            continue
        path, _, rest = key.partition("#")
        slot, _, d = rest.partition("#")
        cid = path.split("/")[-1]
        man = cand.load_manifest(cid)
        q = (((man or {}).get("animations") or {}).get(slot, {}).get("directions") or {}).get(d)
        if not q:
            # the art it judged is gone entirely (a discarded attempt): the
            # note cannot mean anything any more
            if man and not os.path.isdir(anim_dir(cid, slot, d)):
                drop.append((key, "gone", v.get("updated_at") or ""))
            continue
        made, said = q.get("generated_at"), v.get("updated_at")
        if made and said and made > said:          # both ISO-8601 UTC
            drop.append((key, made, said))
    for key, made, said in drop:
        entries.pop(key, None)
        print(f"  pruned {key}  (judged {said[:19]}, regenerated {made[:19]})")
    if drop and not args.dry_run:
        doc["entries"] = entries
        with open(FEEDBACK, "w") as f:
            json.dump(doc, f, indent=1, ensure_ascii=False)
            f.write("\n")
    print(f"{len(drop)} obsolete verdict(s){' (dry run)' if args.dry_run else ' removed'}; "
          f"{len(entries)} left")


def cmd_unwrap(args):
    """Repair wrap-around overflow on clips ALREADY on disk and re-verdict
    them: a clip that rendered past the canvas is art worth saving, not a
    reject (maintainer 2026-09-11: "we still need to try and save the
    animations that did render outside"). Mirrors are rebuilt from the
    repaired sources. No generation."""
    cfg = cand.load_cfg()
    slot = args.state
    ids = args.only.split(",") if args.only else [c["id"] for c in cfg["candidates"]]
    fixed = rescued = 0
    for cid in ids:
        man = cand.load_manifest(cid) or {}
        rec = (man.get("animations") or {}).get(slot)
        if not rec:
            continue
        touched = False
        for d in GEN_DIRS:
            q = rec["directions"].get(d)
            frames = load_frames(cid, slot, d)
            if not q or not frames:
                continue
            base = rotation(cid, d)
            out, pad, n = unwrap_clip(frames, base.size)
            if not n:
                continue
            was = q.get("status")
            save_frames(cid, slot, d, out)
            new = qa_clip(cid, slot, d, out, pinned=bool(q.get("pinned")),
                          claw_take=(q.get("rung") or 0) >= 2)
            new.update({k: q[k] for k in ("sub", "group", "takes", "version", "action",
                                          "rung", "rolls", "generated_at") if k in q})
            new["unwrapped"] = n
            rec["directions"][d] = new
            fixed += n
            rescued += (was == "fail" and new["status"] != "fail")
            print(f"  {cid} {d}: {n} wrap fix(es), canvas +{pad} px — {was} -> {new['status']}")
            for md, src in MIRRORED.items():
                if src == d and new["status"] != "fail" and mirror_direction(cid, slot, md):
                    rec["directions"][md] = dict(new, mirrored=True, source=src)
            touched = True
        if touched:
            rec["frame_paths"] = {d: [os.path.join(cid, "animations", slot, d, f)
                                      for f in sorted(os.listdir(anim_dir(cid, slot, d)))
                                      if f.endswith(mirror.ART_EXT)]
                                  for d in rec["directions"] if os.path.isdir(anim_dir(cid, slot, d))}
            write_manifest(cid, man)
    print(f"{fixed} wrap fix(es); {rescued} direction(s) rescued from fail")
    cand.rebuild_index(cfg)


def cmd_settle(args):
    """When the intensity dial is maxed and a direction still only scores
    SHALLOW (reach above the maintainer's own accepted floor of 0.15 but under
    the pass line), stop burning rolls on it: downgrade the fail to a warn so
    the state can complete and HE can judge it on the review page. His own
    accepted set goes as low as 0.14 (Gray Brute) and 0.24 (Stone Turtle) —
    compact bodies with short limbs cannot reach as far as a club swing."""
    cfg = cand.load_cfg()
    slot = args.state
    ids = args.only.split(",") if args.only else [c["id"] for c in cfg["candidates"]]
    n = 0
    for cid in ids:
        man = cand.load_manifest(cid) or {}
        rec = (man.get("animations") or {}).get(slot)
        if not rec or intensity_of(man, slot) < max(INTENSITY):
            continue
        for d, q in (rec.get("directions") or {}).items():
            if q.get("status") != "fail" or q.get("mirrored"):
                continue
            hard = [r for r in (q.get("reasons") or [])
                    if not r.startswith(("no strike, just a lean", "shallow strike"))
                    and ("eyeball" not in r) and ("canvas grown" not in r)]
            if hard or (q.get("reach") or 0) < args.min_reach:
                continue
            q["status"] = "warn"; q["manual"] = True
            q["reasons"].append(f"settled: dial maxed, reach {q.get('reach')} is above the accepted floor {args.min_reach} — maintainer's call")
            n += 1
        write_manifest(cid, man)
    print(f"settled {n} shallow direction(s) to warn")
    cand.rebuild_index(cfg)


def cmd_promote(args):
    """The _try variant becomes the state. Refuses anything incomplete: a state
    must be ONE take across all eight directions, never a mix of wordings."""
    cfg = cand.load_cfg()
    state, slot = args.state, (getattr(args, "src", None) or args.state + TRY)
    ids = args.only.split(",") if args.only else [c["id"] for c in cfg["candidates"]
                                                  if (cand.load_manifest(c["id"]) or {}).get("review") == "approved"]
    ok = [c["id"] for c in cfg["candidates"] if c["id"] in ids]
    ready, blocked = [], []
    for cid in ok:
        man = cand.load_manifest(cid) or {}
        tr = (man.get("animations") or {}).get(slot)
        if not tr:
            blocked.append((cid, "no try variant")); continue
        bad = [d for d in ALL_DIRS if (tr["directions"].get(d) or {}).get("status") not in
               (("pass", "warn") if args.allow_warn else ("pass",))]
        if bad:
            blocked.append((cid, f"{len(bad)} direction(s) not ready: {','.join(bad)}")); continue
        ready.append(cid)
    for cid, why in blocked:
        print(f"  SKIP {cid}: {why}")
    print(f"promote {state}: {len(ready)} ready, {len(blocked)} blocked")
    if not ready:
        return
    client = PixelLabClient(); client.require_key()
    for cid in ready:
        man = cand.load_manifest(cid)
        live = (man.get("animations") or {}).get(state) or {"directions": {}}
        _slot_takes_delete(client, man, live)
        _slot_files_delete(cid, state, list(live.get("directions") or ALL_DIRS))
        for d in ALL_DIRS:                       # try frames + strips take the live names
            src, dst = anim_dir(cid, slot, d), anim_dir(cid, state, d)
            if os.path.isdir(src):
                os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.move(src, dst)
            ss = os.path.join(cand.cdir(cid), "animations", f"{slot}__{d}{mirror.ART_EXT}")
            if os.path.exists(ss):
                shutil.move(ss, os.path.join(cand.cdir(cid), "animations", f"{state}__{d}{mirror.ART_EXT}"))
        tr = man["animations"].pop(slot)
        tr["frame_paths"] = {d: [os.path.join(cid, "animations", state, d, f)
                                 for f in sorted(os.listdir(anim_dir(cid, state, d)))
                                 if f.endswith(mirror.ART_EXT)]
                             for d in tr["directions"] if os.path.isdir(anim_dir(cid, state, d))}
        tr["strips"] = {d: os.path.join(cid, "animations", f"{state}__{d}{mirror.ART_EXT}") for d in tr["directions"]}
        tr["promoted_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        man["animations"][state] = tr
        write_manifest(cid, man)
        print(f"  {cid}: {state} <- try ({tr['action'][:48]})", flush=True)
    cand.rebuild_index(cfg)


def cmd_discard(args):
    """Throw the _try variant away; the live state is untouched."""
    cfg = cand.load_cfg()
    state, slot = args.state, (getattr(args, "src", None) or args.state + TRY)
    ids = args.only.split(",") if args.only else [c["id"] for c in cfg["candidates"]]
    client = PixelLabClient(); client.require_key()
    n = 0
    for cid in ids:
        man = cand.load_manifest(cid) or {}
        tr = (man.get("animations") or {}).get(slot)
        if not tr:
            continue
        _slot_takes_delete(client, man, tr)
        _slot_files_delete(cid, slot, list(tr.get("directions") or ALL_DIRS))
        man["animations"].pop(slot); write_manifest(cid, man); n += 1
        print(f"  {cid}: discarded {slot}")
    print(f"discarded {n} try variant(s)")
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
        g.add_argument("--try", dest="use_try", action="store_true",
                       help="build the NEXT ATTEMPT at this state alongside the others (nothing in candidates is live; he picks)")
        g.add_argument("--slot", help="write to this slot exactly, e.g. attack_v3")
        g.add_argument("--pro", action="store_true", help="PRO mode for this run: no pins, its own frame count, the ladder restarts (the escape for a body v3 will not change)")
        g.set_defaults(func=lambda a, st=st: cmd_state(a, a.slot or (st + (TRY if a.use_try else ""))))
    r = sub.add_parser("redo"); r.add_argument("--state", default="idle"); r.add_argument("--only", required=True)
    r.add_argument("--dirs", required=True); r.add_argument("--min-usd", type=float, default=MIN_USD)
    r.add_argument("--pin", action="store_true", help="pin start+end to the base (the maintainer's fallback for a clip that never loops)")
    r.add_argument("--try", dest="use_try", action="store_true")
    r.add_argument("--pro", action="store_true", help="PRO mode for this run (see the state command)")
    r.set_defaults(func=lambda a: cmd_state(a, a.state + (TRY if a.use_try else "")), dry_run=False)
    f = sub.add_parser("fetch", help="re-download + re-QA the last takes already on PixelLab (no generation)")
    f.add_argument("--state", default="idle"); f.add_argument("--only", required=True); f.add_argument("--dirs")
    f.set_defaults(func=cmd_fetch)
    q = sub.add_parser("requal", help="re-run the machine verdict from disk"); q.add_argument("--state", default="idle"); q.add_argument("--only"); q.set_defaults(func=cmd_requal)
    s = sub.add_parser("status"); s.add_argument("--state", default="idle"); s.set_defaults(func=cmd_status)
    pr = sub.add_parser("promote", help="a complete _try variant REPLACES the live state: the old directions are deleted on PixelLab and on disk")
    pr.add_argument("--state", required=True); pr.add_argument("--only")
    pr.add_argument("--from", dest="src", help="the attempt to promote, e.g. attack_v3 (default: <state>_try)")
    pr.add_argument("--allow-warn", action="store_true", help="promote when every direction is pass or warn (default: no fails, no gaps)")
    pr.set_defaults(func=cmd_promote)
    mf = sub.add_parser("migrate-feedback", help="carry his verdicts across a slot rename")
    mf.set_defaults(func=cmd_migrate_feedback)
    pf = sub.add_parser("prune-feedback", help="drop his redo notes whose art has since been regenerated")
    pf.add_argument("--dry-run", action="store_true"); pf.set_defaults(func=cmd_prune_feedback)
    rv = sub.add_parser("review", help="apply HIS wiki verdicts to a slot (redo -> fail, with his note)")
    rv.add_argument("--state", required=True); rv.set_defaults(func=cmd_review)
    uw = sub.add_parser("unwrap", help="repair clips that rendered past the canvas edge (no generation)")
    uw.add_argument("--state", required=True); uw.add_argument("--only"); uw.set_defaults(func=cmd_unwrap)
    se = sub.add_parser("settle", help="a maxed-out dial stops the loop: shallow-but-real strikes become warns for the maintainer to judge")
    se.add_argument("--state", required=True); se.add_argument("--only")
    se.add_argument("--min-reach", type=float, default=0.15, help="the maintainer's own accepted floor")
    se.set_defaults(func=cmd_settle)
    dc = sub.add_parser("discard", help="throw the _try variant away and keep the live state")
    dc.add_argument("--state", required=True); dc.add_argument("--only")
    dc.add_argument("--from", dest="src", help="the attempt to discard, e.g. attack_v2")
    dc.set_defaults(func=cmd_discard)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
