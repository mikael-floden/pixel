"""Scale / proportion contract for scene-based maps.

A believable map keeps one shared scale: a character stands ~`CHAR_FRAC` of the
screen height, props are sized as a multiple of the character (a tree ~1.3x, a
chest ~0.45x), and props sit on a y-sorted layer so depth reads correctly. This
module centralises those numbers and validates the config against the objects
agent's actual catalog so the loop never places a prop that doesn't exist.
"""

from __future__ import annotations

import props as props_mod

# On the rendered world canvas, the character body is this fraction of height.
CHAR_FRAC = 0.20
# Default prop size as a multiple of the character height, when a zone/prop
# doesn't specify one.
DEFAULT_PROP_SCALE = 1.2


def character_px(world_height):
    return max(24, round(world_height * CHAR_FRAC))


def prop_height(prop_scale, world_height):
    return max(8, round(character_px(world_height) * prop_scale))


def validate_config(cfg):
    """Returns (ok, issues[]). Checks every zone references props that exist in
    the objects agent's catalog and that scales are sane."""
    issues = []
    have = set(props_mod.available())
    scales = cfg.get("prop_scale", {})
    for z in cfg.get("zones", []):
        for pid in z.get("props", []):
            if pid not in have:
                issues.append(f"zone '{z['id']}' references prop '{pid}' not in "
                              f"/objects (available: {sorted(have)})")
            s = scales.get(pid, DEFAULT_PROP_SCALE)
            if not (0.2 <= s <= 4.0):
                issues.append(f"prop '{pid}' scale {s} out of [0.2, 4.0]")
    return (not issues), issues


def summary(cfg):
    return (f"scene scale: character ~= {int(CHAR_FRAC*100)}% of screen height; "
            f"props sized relative to character; y-sorted for depth")
