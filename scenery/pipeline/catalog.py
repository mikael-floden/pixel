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
    manifest's placement (64px = 1.7m) stays the authoritative render size.

    NEVER name a person as a NOUN here. The first phrasing ended every prompt
    with "...to an adult person", and moss_clump_001 (48px) came back as a
    pixel-art BOY: given a vague subject and a small canvas the model drew the
    measuring stick instead of the thing. Height is now purely adjectival
    ("knee-high", "twice human height") — same anchor, nothing to render."""
    if height_m < 0.35:
        return "tiny, only ankle-high"
    if height_m < 0.75:
        return "small, knee-high"
    if height_m < 1.2:
        return "waist-high"
    if height_m < 1.9:
        return "roughly six feet tall, human height"
    if height_m < 3.0:
        return "large, twice human height"
    if height_m < 4.5:
        return "tall, about three times human height"
    return "towering, many times human height"


def _group_scale_phrase(group: dict, height_m: float) -> str:
    """A group may override the size cue with its own ladder.

    The default ladder measures a prop STANDING ON THE GROUND ("knee-high",
    "waist-high"), which is exactly wrong for something mounted on a wall: a
    1.0m window is not "waist-high", it is a window about two thirds of a
    person tall, and the ground-relative phrasing invites the model to draw it
    down at waist level. Groups set `scale_phrases` as [[max_height_m, phrase],
    ...] to describe their own size instead."""
    ladder = group.get("scale_phrases")
    if not ladder:
        return _scale_phrase(height_m)
    for entry in ladder:
        if height_m < float(entry[0]):
            return str(entry[1])
    return str(ladder[-1][1])


def quota_for(rank: int, rule: dict) -> int:
    return max(int(rule.get("floor", 2)),
               int(rule.get("base", 102)) + int(rule.get("step", -2)) * rank)


def group_quota(group: dict, cfg: dict) -> int:
    # Groups added beyond the original 100 (indoor/house detail, mountain-wall
    # decor) carry an explicit `quota` — the rank formula would floor them at 2.
    # An explicit 0 retires a group outright (rail_carts: concept rejected by
    # the maintainer three times), so the check is presence, not truthiness.
    if "quota" in group:
        return int(group["quota"])
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
    # Half-and-half LIGHTS_ON/LIGHTS_OFF is the domain default, but a group can
    # pin itself: windows are generated "lights off inside the house (they are
    # not home)" (maintainer 2026-08-14), so a lit variant would be wrong art,
    # not just an unwanted one.
    forced = (group.get("lights") or "").upper()
    lights_on = (index % 2 == 0) if not forced else (forced == "LIGHTS_ON")
    variety = _pick(group.get("variety") or [group["description"]],
                    group["id"], "variety", index)
    glow = _pick(group.get("glow_concepts") or ["softly glowing"],
                 group["id"], "glow", index // 2)
    hmin, hmax = group["world_height_m"]
    span = _seed(group["id"], "height", index) / (2 ** 31)
    height = round(hmin + (hmax - hmin) * span, 2)

    off_clause = cfg["lights"]["off_clause"]
    on_clause = cfg["lights"]["on_clause"]
    scale = _group_scale_phrase(group, height)
    # SECOND VARIATION AXIS (maintainer 2026-08-14: "I don't want to get the
    # same images over and over"): an independent composition modifier, cycled
    # on its own stride, multiplies each variety into dozens of visually
    # distinct pieces. Groups name a shared pool (config modifier_pools) or
    # carry their own `modifiers`; groups with neither are unchanged.
    pool = group.get("modifiers") or cfg.get("modifier_pools", {}).get(
        group.get("modifier_pool") or "", [])
    mod = _pick(pool, group["id"], "modifier", index) if pool else None
    body = f"{group['description']}, {variety}" + (f", {mod}" if mod else "")
    # The tail carries the two clauses that must NEVER be lost to the 1000-char
    # trim: the human-anchored size cue and the lights promise. Handed to the
    # runner separately so it trims the body instead (see loop.submit_piece).
    tail = f", {scale}, {on_clause}: {glow}" if lights_on else f", {scale}, {off_clause}"
    prompt = f"{body}{tail}"

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
        "modifier": mod,
        "glow_concept": glow if lights_on else None,
        "prompt": prompt,
        "prompt_body": body,
        "prompt_tail": tail,
        "size": int(group["art_size"]),
        "world_height_m": height,
    }


def plan_group(cfg: dict, group: dict) -> list[dict]:
    return [piece_spec(cfg, group, i) for i in range(1, group_quota(group, cfg) + 1)]


def next_indices(group: dict, done: set[str], retired: set[str], want: int) -> list[int]:
    """The next `want` FRESH indices for a group.

    Ids are never recycled: an index whose piece was deleted (rejected by the
    maintainer, or condemned by the agent's QA) is retired, and the group
    grows past its quota's index range to find clean numbers. Parity carries
    the LIGHTS_ON/LIGHTS_OFF promise (even = lit), so a replacement takes the
    next free index on whichever side is currently under-represented — half
    and half survives any amount of re-rolling."""
    lit = sum(1 for p in done if p.split("_")[-1].isdigit()
              and int(p.split("_")[-1]) % 2 == 0)
    unlit = len(done) - lit
    out, i = [], 1
    while len(out) < want:
        want_even = lit <= unlit          # even index == LIGHTS_ON
        cand = None
        j = i
        while cand is None:
            pid = piece_id(group, j)
            if pid not in done and pid not in retired and j not in out \
                    and (j % 2 == 0) == want_even:
                cand = j
            j += 1
            if j > 10000:                 # unreachable guard
                return out
        out.append(cand)
        if cand % 2 == 0:
            lit += 1
        else:
            unlit += 1
    return out


def next_batch(cfg: dict, done_by_group: dict[str, set[str]],
               retired_by_group: dict[str, set[str]] | None = None
               ) -> tuple[dict, list[dict]] | None:
    """The next batch to generate, derived purely from what exists on disk.

    Fairness rule (deterministic): the group with the FEWEST finished pieces
    that still has quota goes first; ties break by rank. This fills every
    group's first pairs early (the world gets variety fast) while quotas make
    importance win over time. Returns (group, [piece specs]) or None."""
    retired_by_group = retired_by_group or {}
    best = None
    for group in cfg["groups"]:
        done = done_by_group.get(group["id"], set())
        quota = group_quota(group, cfg)
        if len(done) >= quota:
            continue
        # PROPORTIONAL fairness (maintainer 2026-08-14: "we don't have nearly
        # enough" outdoor nature): fill by fraction-of-quota, not raw count.
        # Absolute fewest-first kept pouring pieces into refilled 2-quota
        # groups while trees sat at 30/100; by ratio, the big nature groups
        # absorb most of every pass once all groups are seeded — which is
        # exactly how often a world-builder reaches for each type.
        # ALWAYS-WANTED groups (maintainer 2026-08-14: "Trees are ofc always
        # welcomed") carry a `demand` multiplier below 1.0, which makes them
        # read as emptier than they are and keeps a steady stream flowing no
        # matter what else is unfilled. Stateless, so every run agrees.
        # Laplace-smoothed fill fraction: (done+1)/(quota+1). Without the +1 a
        # brand-new group scores a flat 0 whatever its size, so every freshly
        # added 3-piece special outranked trees and the mountain walls — the
        # maintainer watched a whole run go to types he had just declared full
        # (2026-08-14). Smoothed, a 0/3 group sits at 0.25 while a 0/70 group
        # sits at 0.014, so BIG wanted families lead, small specials trickle.
        key = ((len(done) + 1) / (quota + 1) * float(group.get("demand", 1.0)),
               group["rank"])
        if best is None or key < best[0]:
            best = (key, group, done)
    if best is None:
        return None
    _, group, done = best
    cap = batch_capacity(int(group["art_size"]), cfg)
    idxs = next_indices(group, done, retired_by_group.get(group["id"], set()), cap)
    return group, [piece_spec(cfg, group, i) for i in idxs]


def progress(cfg: dict, done_by_group: dict[str, set[str]]) -> dict:
    total = sum(group_quota(g, cfg) for g in cfg["groups"])
    done = sum(len(v) for v in done_by_group.values())
    return {"scenery_complete": done, "scenery_target": total,
            "groups_total": len(cfg["groups"]),
            "groups_started": sum(1 for g in cfg["groups"]
                                  if done_by_group.get(g["id"]))}
