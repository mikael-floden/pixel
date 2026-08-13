"""The scenery catalog: 100 ranked types -> a deterministic plan of pieces.

The maintainer's structure (2026-08-12):
  - 100 scenery TYPES, ranked by importance. Each type is a GROUP — a folder
    `scenery/<group>/` holding every generated piece of that type.
  - Quota per type follows the rank: #1 (trees) gets 100 pieces, #2 (stones)
    98, and so on, -2 per rank. Because EVERY type must ship both versions,
    the quota floors at 2 — so `quota(rank) = max(2, 102 - 2*rank)`.
  - Every type is generated in two versions, half and half, interleaved:
    LIGHTS_OFF (no self-emission) and LIGHTS_ON (self-emissive glow). Odd
    piece numbers are LIGHTS_OFF, even are LIGHTS_ON, so both appear from the
    first pair onward.
  - SOUTH only. Scenery never rotates — but pieces <=168px are generated as
    REAL 8-direction PixelLab objects (only SOUTH is kept/stored): the
    maintainer's "fool PixelLab" rule, so every piece stays a first-class
    animatable object. Bigger pieces are single 1-direction objects (the
    8-rotation pipeline caps at 168px). Animations come later (S-only).

Everything here is DETERMINISTIC: the piece list, each piece's variety pick,
glow concept, world height and prompt are all derived from the config + seeded
hashes, so any run (local, Actions, months apart) plans the exact same pieces
and the filesystem alone says what is left to do.
"""

from __future__ import annotations

import zlib


def _seed(*parts) -> int:
    return zlib.crc32(("::".join(str(p) for p in parts)).encode()) % (2 ** 31)


def _pick(options, *seed_parts):
    """Deterministic spread: consecutive indices walk the option list in a
    seeded, group-stable order so variety cycles instead of clumping."""
    if not options:
        return None
    n = len(options)
    idx_part = seed_parts[-1]
    offset = _seed(*seed_parts[:-1]) % n
    stride_candidates = [s for s in range(1, n) if _gcd(s, n) == 1] or [1]
    stride = stride_candidates[_seed(*seed_parts[:-1], "stride") % len(stride_candidates)]
    return options[(offset + idx_part * stride) % n]


def _gcd(a, b):
    while b:
        a, b = b, a % b
    return a


def _scale_phrase(height_m: float) -> str:
    """Human-anchored size cue baked into every prompt. The ONE deletion-worthy
    sin here is broken scale vs the player (maintainer 2026-08-13: "compare
    your work against a human to understand if your scale is reasonable"), so
    every piece tells the model how big it is IN HUMAN TERMS, not metres —
    image models know knees and shoulders far better than SI units. The
    manifest's placement (64px = 1.7m) stays the authoritative render size."""
    if height_m < 0.35:
        return "tiny, ankle-height to an adult person"
    if height_m < 0.75:
        return "small, knee-high to an adult person"
    if height_m < 1.2:
        return "waist-high to an adult person"
    if height_m < 1.9:
        return "about as tall as an adult person"
    if height_m < 3.0:
        return "large, well above head height of a person"
    if height_m < 4.5:
        return "tall, about two people high"
    return "towering, several times the height of a person"


def quota_for(rank: int, rule: dict) -> int:
    return max(int(rule.get("floor", 2)),
               int(rule.get("base", 102)) + int(rule.get("step", -2)) * rank)


def group_quota(group: dict, cfg: dict) -> int:
    return quota_for(int(group["rank"]), cfg.get("quota_rule", {}))


def batch_capacity(art_size: int, cfg: dict) -> int:
    """ONE piece per call — multi-candidate batching is retired (maintainer
    2026-08-13). The shared-canvas candidates behaved like icons, sat in a
    'Review Generated Frames' popup in his UI when a run died mid-select, and
    were where the broken-pixel-grid bug lived (the graves came out as per-
    pixel mush while single-canvas pieces were crisp). Every piece now gets
    the model's full canvas: 8-direction objects for sizes the 8-rotation
    pipeline accepts, single 1-direction objects above that — same 20-40
    generations per call either way."""
    del art_size, cfg
    return 1


def piece_id(group: dict, index: int) -> str:
    return f"{group['prefix']}_{index:03d}"


def piece_spec(cfg: dict, group: dict, index: int) -> dict:
    """The full deterministic spec for piece `index` (1-based) of a group."""
    lights_on = index % 2 == 0            # odd -> LIGHTS_OFF, even -> LIGHTS_ON
    variety = _pick(group.get("variety") or [group["description"]],
                    group["id"], "variety", index)
    glow = _pick(group.get("glow_concepts") or ["softly glowing"],
                 group["id"], "glow", index // 2)
    hmin, hmax = group["world_height_m"]
    span = _seed(group["id"], "height", index) / (2 ** 31)
    height = round(hmin + (hmax - hmin) * span, 2)

    off_clause = cfg["lights"]["off_clause"]
    on_clause = cfg["lights"]["on_clause"]
    scale = _scale_phrase(height)
    if lights_on:
        prompt = f"{group['description']}, {variety}, {scale}, {on_clause}: {glow}"
    else:
        prompt = f"{group['description']}, {variety}, {scale}, {off_clause}"

    nice = variety.strip().rstrip(".")
    name = f"{nice[:1].upper()}{nice[1:]} {index:03d}" + (" · lit" if lights_on else "")
    return {
        "id": piece_id(group, index),
        "group": group["id"],
        "rank": group["rank"],
        "index": index,
        "name": name,
        "lights": "LIGHTS_ON" if lights_on else "LIGHTS_OFF",
        "variety": variety,
        "glow_concept": glow if lights_on else None,
        "prompt": prompt,
        "size": int(group["art_size"]),
        "world_height_m": height,
    }


def plan_group(cfg: dict, group: dict) -> list[dict]:
    return [piece_spec(cfg, group, i) for i in range(1, group_quota(group, cfg) + 1)]


def next_batch(cfg: dict, done_by_group: dict[str, set[str]]) -> tuple[dict, list[dict]] | None:
    """The next batch to generate, derived purely from what exists on disk.

    Fairness rule (deterministic): the group with the FEWEST finished pieces
    that still has quota goes first; ties break by rank. This fills every
    group's first pairs early (the world gets variety fast) while quotas make
    importance win over time. Returns (group, [piece specs]) or None."""
    best = None
    for group in cfg["groups"]:
        done = done_by_group.get(group["id"], set())
        quota = group_quota(group, cfg)
        missing = [i for i in range(1, quota + 1)
                   if piece_id(group, i) not in done]
        if not missing:
            continue
        key = (quota - len(missing), group["rank"])
        if best is None or key < best[0]:
            best = (key, group, missing)
    if best is None:
        return None
    _, group, missing = best
    cap = batch_capacity(int(group["art_size"]), cfg)
    return group, [piece_spec(cfg, group, i) for i in missing[:cap]]


def progress(cfg: dict, done_by_group: dict[str, set[str]]) -> dict:
    total = sum(group_quota(g, cfg) for g in cfg["groups"])
    done = sum(len(v) for v in done_by_group.values())
    return {"scenery_complete": done, "scenery_target": total,
            "groups_total": len(cfg["groups"]),
            "groups_started": sum(1 for g in cfg["groups"]
                                  if done_by_group.get(g["id"]))}
