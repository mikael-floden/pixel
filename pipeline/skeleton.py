"""Skeleton kinematics + a deterministic procedural part renderer.

THE RULE: every body part is drawn on the SAME 48x64 canvas, posed by the SAME
skeleton, transparent everywhere else. This module owns the skeleton (joint
solve) and a placeholder rasterizer that draws each part as a flat capsule so we
can preview poses and run QA before PixelLab ever paints a pixel. When PixelLab
is wired in, it replaces `render_pose` while every joint position below stays the
source of truth for where the painted art must land.

Angles are ABSOLUTE world degrees: 0=+x (forward/right), 90=down, -90=up.
Poses are authored facing right; left-facing is a final horizontal flip, so we
never interpolate `facing`.
"""

from __future__ import annotations

import json
import math
import os

from PIL import Image, ImageDraw

# Numeric pose fields that interpolate between keyframes.
POSE_FIELDS = [
    "rootx", "rooty", "torso_a", "head_tilt",
    "back_upper_arm", "back_fore_arm", "front_upper_arm", "front_fore_arm",
    "back_thigh", "back_shin", "front_thigh", "front_shin",
    "ponytail",
]
# Discrete fields that are carried, never blended.
NON_INTERP_FIELDS = ["facing"]

_CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config")


def load_skeleton(path=None):
    path = path or os.path.join(_CONFIG_DIR, "skeleton.json")
    with open(path) as f:
        return json.load(f)


def merge_pose(bind, overrides):
    """A keyframe only lists the fields it changes; merge it onto the bind pose."""
    pose = dict(bind)
    pose.update(overrides or {})
    return pose


# --- geometry helpers -------------------------------------------------------

def _dir(angle_deg):
    r = math.radians(angle_deg)
    return (math.cos(r), math.sin(r))


def _step(p, angle_deg, length):
    d = _dir(angle_deg)
    return (p[0] + d[0] * length, p[1] + d[1] * length)


def _add(p, v):
    return (p[0] + v[0], p[1] + v[1])


def resolve_joints(pose, skel):
    """Solve every joint position (in canvas pixels) for a pose.

    Returns a dict with shared joints plus a `back`/`front` limb chain each.
    This is the contract PixelLab art must honour: paint the part, land it here.
    """
    b = skel["bones"]
    pelvis = (pose["rootx"], pose["rooty"])
    shoulder = _step(pelvis, pose["torso_a"], b["torso"])

    head_a = pose["torso_a"] + pose["head_tilt"]
    neck_end = _step(shoulder, head_a, b["neck"])
    head = _step(neck_end, head_a, b["head_r"])
    hair_tip = _step(head, pose["ponytail"], b["head_r"] + 7)

    # Front/back depth separation is perpendicular to the torso.
    off = skel["depth_offset_px"]
    perp = _dir(pose["torso_a"] + 90)
    front_shift = (perp[0] * off, perp[1] * off)
    back_shift = (-perp[0] * off, -perp[1] * off)

    def arm(prefix, shift):
        s = _add(shoulder, shift)
        elbow = _step(s, pose[prefix + "_upper_arm"], b["upper_arm"])
        hand = _step(elbow, pose[prefix + "_fore_arm"], b["fore_arm"])
        return {"shoulder": s, "elbow": elbow, "hand": hand}

    def leg(prefix, shift):
        hip = _add(pelvis, shift)
        knee = _step(hip, pose[prefix + "_thigh"], b["thigh"])
        ankle = _step(knee, pose[prefix + "_shin"], b["shin"])
        toe = _step(ankle, 0, b["foot"])  # foot is flat-forward; flip handles facing
        return {"hip": hip, "knee": knee, "ankle": ankle, "toe": toe}

    return {
        "pelvis": pelvis,
        "shoulder": shoulder,
        "neck_end": neck_end,
        "head": head,
        "hair_tip": hair_tip,
        "back": {**arm("back", back_shift), **leg("back", back_shift)},
        "front": {**arm("front", front_shift), **leg("front", front_shift)},
    }


# --- placeholder rasterizer -------------------------------------------------

def _darken(rgb, factor):
    return tuple(max(0, min(255, int(round(c * factor)))) for c in rgb)


def _layer(skel):
    return Image.new("RGBA", (skel["canvas"]["w"], skel["canvas"]["h"]), (0, 0, 0, 0))


def _capsule(img, p0, p1, width, rgb):
    """A thick line with round caps = one bone drawn as a solid limb."""
    d = ImageDraw.Draw(img)
    fill = rgb + (255,)
    p0 = (round(p0[0]), round(p0[1]))
    p1 = (round(p1[0]), round(p1[1]))
    d.line([p0, p1], fill=fill, width=width)
    r = width / 2.0
    for p in (p0, p1):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=fill)


def _disc(img, c, r, rgb):
    d = ImageDraw.Draw(img)
    d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=rgb + (255,))


def render_pose(pose, skel, roles, back_darken=None):
    """Draw the posed character as one transparent RGBA layer per body part.

    `roles` maps role name -> (r, g, b). Returns {layer_name: RGBA Image}. The
    caller composites these in skeleton z-order; gear equips by dropping the
    layers its slot hides.
    """
    back_darken = skel["back_darken"] if back_darken is None else back_darken
    J = resolve_joints(pose, skel)
    b = skel["bones"]

    def shade(role, back):
        rgb = roles[role]
        return _darken(rgb, back_darken) if back else rgb

    def arm_layer(side, back):
        img = _layer(skel)
        a = J[side]
        _capsule(img, a["shoulder"], a["elbow"], 5, shade("shirt", back))
        _capsule(img, a["elbow"], a["hand"], 4, shade("skin", back))
        _disc(img, a["hand"], 2, shade("skin", back))
        return img

    def leg_layer(side, back):
        img = _layer(skel)
        lg = J[side]
        _capsule(img, lg["hip"], lg["knee"], 6, shade("pants", back))
        _capsule(img, lg["knee"], lg["ankle"], 5, shade("pants", back))
        _capsule(img, lg["ankle"], lg["toe"], 4, shade("boots", back))
        return img

    # torso
    torso_img = _layer(skel)
    _capsule(torso_img, J["pelvis"], J["shoulder"], 9, roles["shirt"])

    # hair (behind head): a slightly larger disc + the ponytail tail
    hair_img = _layer(skel)
    hc = (J["head"][0] - 1, J["head"][1] - 1)
    _disc(hair_img, hc, b["head_r"] + 1, roles["hair"])
    _capsule(hair_img, J["head"], J["hair_tip"], 3, roles["hair"])

    # head + neck
    head_img = _layer(skel)
    _capsule(head_img, J["shoulder"], J["neck_end"], 4, roles["skin"])
    _disc(head_img, J["head"], b["head_r"], roles["skin"])

    return {
        "back_arm": arm_layer("back", True),
        "back_leg": leg_layer("back", True),
        "torso": torso_img,
        "hair": hair_img,
        "head": head_img,
        "front_leg": leg_layer("front", False),
        "front_arm": arm_layer("front", False),
    }
