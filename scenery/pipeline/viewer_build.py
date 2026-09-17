"""Build the scenery viewer manifest (scenery/viewer_data.json) from the tree.

The static `scenery/index.html` reads this file and lets you browse every piece
from a phone. v2: pieces live in ranked GROUPS (scenery/<group>/<id>/); each
piece's `category` is its group so the viewer's category filter doubles as the
group browser. Legacy top-level pieces keep their own category. Paths are
domain-relative so it works on GitHub Pages and locally.
"""

from __future__ import annotations

import hashlib
import json
import os

import catalog
import factory


def _art_hash(rel_path):
    """md5[:16] of a sprite — the SAME digest the wiki records on a verdict.

    A verdict stores the hash of the art it was made against. Publishing the
    CURRENT hash lets any consumer tell, with no extra bookkeeping, whether a
    verdict still describes the art on screen. When they differ the art has
    been regenerated since, so the verdict is spent and must not keep showing
    as an outstanding rejection (maintainer 2026-08-14: "You must consume that
    review so the comment and reject is not still present in the wiki for me").
    This is why it is a published hash rather than a consumed-list: a list has
    to be maintained and can drift, a hash comparison cannot."""
    try:
        with open(os.path.join(ROOT, rel_path), "rb") as f:
            return hashlib.md5(f.read()).hexdigest()[:16]
    except OSError:
        return None

ROOT = factory.ROOT
DATA_PATH = os.path.join(ROOT, "viewer_data.json")


def _types_by_group(cfg):
    """group id -> TYPE, and refuse to build if any group is missing or wrong.

    The scenery domain OWNS this taxonomy (maintainer 2026-08-14: "the type is
    your responsibility the very second he commits"). The wiki filters on it and
    pages through a filtered set, so an untyped group silently becomes OTHER and
    its pieces vanish from the filter the maintainer is browsing. Failing the
    build is the only thing that keeps a NEW group from shipping untyped —
    a default would rot quietly."""
    allowed = set((cfg.get("types") or {}).get("values") or [])
    out, bad = {}, []
    for g in cfg.get("groups", []):
        t = g.get("type")
        if t not in allowed:
            bad.append(f"{g['id']}={t!r}")
        out[g["id"]] = t
    if bad:
        raise ValueError(
            "scenery groups with a missing/unknown `type` (add one to "
            f"config/factory.json, allowed: {sorted(allowed)}): {', '.join(bad)}")
    return out


_GROUPS_BY_ID = None


def _group_field(group_id, field):
    """A group's own value for a field a piece may override — the `type`
    pattern, so a piece minted before the field existed still publishes it."""
    global _GROUPS_BY_ID
    if _GROUPS_BY_ID is None:
        _GROUPS_BY_ID = {g["id"]: g for g in factory.load_config().get("groups", [])}
    return (_GROUPS_BY_ID.get(group_id) or {}).get(field)


def build():
    _ensure_vents()
    placed = _placed_states()
    cfg = factory.load_config()
    types_by_group = _types_by_group(cfg)
    pieces, categories = [], {}
    for rel, meta in factory.discover():
        grouped = "/" in rel
        cat = rel.split("/", 1)[0] if grouped else meta.get("category", "legacy")
        anims = []
        for key, a in (meta.get("animations") or {}).items():
            dirs = a.get("directions") or {}
            south = dirs.get("south") or (next(iter(dirs.values())) if dirs else {})
            anims.append({
                "key": key,
                "description": a.get("description"),
                "frames": south.get("frames"),
                "preview_gif": south.get("gif"),
                "directions": {d: v.get("gif") for d, v in dirs.items() if v.get("gif")},
                # MAY THE GAME PLAY IT? Rebuilt by hand here, so anything the
                # review adds has to be listed or it is silently dropped —
                # `review` was, for the three piece-root animations, while every
                # per-state one rode through on the states spread.
                "review": a.get("review"),
                "review_metrics": a.get("review_metrics"),
                # PER-FRAME LIGHT (light_frames.py): intensity + centre offset per
                # frame, per direction, so the light breathes with the art.
                "light_frames": {d: v.get("light_frames") for d, v in dirs.items()
                                 if v.get("light_frames")} or a.get("light_frames"),
            })
        categories[cat] = categories.get(cat, 0) + 1
        pieces.append({
            "id": meta.get("id", rel.split("/")[-1]),
            "rel": rel,
            "name": meta.get("name", rel),
            "category": cat,
            "lights": meta.get("lights"),
            # HOW STRONG IT SHINES (config `light`, derived by pipeline/light.py).
            # Published whole so the wiki and the game read the same block the
            # maps2 light budget reads from the manifest, never a re-derivation.
            "light": meta.get("light"),
            "description": meta.get("prompt") or meta.get("description", ""),
            "view": meta.get("view"),
            "size": meta.get("size"),
            "placement": meta.get("placement"),
            "status": meta.get("status"),
            # WHEN THE ART WAS MADE. The wiki sorts the maintainer's review
            # queue newest-first and used to derive this from git, which the
            # deploy image cannot do — it has no .git, so anything landing
            # between cache commits fell back to "first build that saw it"
            # (wiki agent's ask, 2026-08-14). Stamped at birth, backfilled from
            # each sprite's LAST commit for the pieces that predate the field.
            "generated_at": meta.get("generated_at"),
            "pixellab_object_id": meta.get("pixellab_object_id"),
            "sprite": meta.get("sprite", f"{rel}/sprite.webp"),
            "art_hash": _art_hash(meta.get("sprite", f"{rel}/sprite.webp")),
            # The TYPE this domain owns (config `types`). Published per piece so
            # a consumer never has to join against the catalog to filter by it.
            # A piece may override its group; otherwise it inherits.
            "type": meta.get("type") or types_by_group.get(cat) or "OTHER",
            # WHERE it may be placed, WHAT it is, and WHERE an effect comes out
            # of it (2026-09-13). `mount`/`fixture` are the placement tag the
            # game and the ambient agent read instead of matching group names;
            # `vent` is the flue mouth in frame px from the canvas centre, the
            # light_frames convention, measured per STATE by pipeline/vent.py
            # (the per-state copies ride the `states` spread below).
            **({"mount": meta.get("mount") or _group_field(cat, "mount")}
               if (meta.get("mount") or _group_field(cat, "mount")) else {}),
            **({"fixture": meta.get("fixture") or _group_field(cat, "fixture")}
               if (meta.get("fixture") or _group_field(cat, "fixture")) else {}),
            **({"vent": meta["vent"]} if meta.get("vent") else {}),
            # WHICH STATES THE WORLD ACTUALLY PLACES, and how many of each
            # ({"LIT_2": 1, "LIT_3": 1}); ABSENT means this piece is in no
            # published world. The domain publishes every state a piece has and
            # the world picks one or two, so a review cannot tell which of them
            # is in the game — he tuned a hearth's LIT_1 light, it applied and
            # deployed correctly, and nothing changed in the game because the
            # world places that hearth as LIT_2 and LIT_3 only (2026-09-15).
            # 1319 LIT states published, 77 placed: without this the odds are
            # against any given review being visible.
            **({"placed": placed[rel]} if placed.get(rel) else {}),
            # A SOUTH-only piece may be mirrored horizontally at placement time,
            # which doubles the variety of every group for free (maintainer's
            # idea, 2026-08-14). FALSE on pieces that carry facings: flipping a
            # south-east window yields a south-west one.
            "must_be_imbplemented_with_random_hflip":
                meta.get("must_be_imbplemented_with_random_hflip", True),
            # DOES THE PLAYER WALK INTO IT, OR OVER IT? (maintainer 2026-08-30:
            # "I want a way to mark an object as collision-less / no collision.
            # This can be a carpet for example ... add that as a field to the
            # object so the game knows about it.") TRUE for almost everything —
            # a player should not walk through a well — and FALSE for flat floor
            # coverings: rugs, hides, mats, a doormat. The wiki writes his
            # corrections to live/tuning/scenery_collision.json and
            # apply_collision.py bakes them in, so his mark always wins over the
            # default this domain guesses.
            "collision": meta.get("collision", True),
            # THE SHAPE ITS HITBOX WANTS: "rect" or "ellipse" (maintainer
            # 2026-08-30 -- a bookshelf or bed needs a rectangle so it can sit
            # flush in a corner; the wiki agent: "the map agent can only use it
            # if the shape is in the record"). This is the DEFAULT this domain
            # derives from the piece; the authority is the `shape` on each box
            # in live/tuning/scenery_hitbox.json once he has tuned it.
            "hitbox_shape": meta.get("hitbox_shape", "ellipse"),
            "rotations": meta.get("rotations") or {},
            # LIGHTING STATES, when a piece has more than one. Windows ship
            # "lights_off" (the default, and what `sprite` points at) and
            # "lights_on"; each carries its own sprite + rotations, generated as
            # a text edit of the same art so the two are PIXEL-ALIGNED. The game
            # crossfades between them on interior brightness, which only reads
            # right because the silhouettes match exactly — so a viewer should
            # switch states in place, the way it switches animations, rather
            # than treating them as separate pieces.
            "states": {
                k: {**v, "art_hash": _art_hash(v.get("sprite", ""))}
                for k, v in (meta.get("states") or {}).items()
            },
            "animations": anims,
        })

    done = factory.done_by_group()
    target = sum(catalog.group_quota(g, cfg) for g in cfg.get("groups", []))
    data = {
        "title": "Nangijala Scenery",
        "scenery_count": len(pieces),
        "target_count": target + sum(1 for r, _ in factory.discover() if "/" not in r),
        "scale": cfg.get("scale"),
        "groups": [{
            "rank": g["rank"], "id": g["id"], "name": g["name"],
            "type": g.get("type"),
            "quota": catalog.group_quota(g, cfg),
            "done": len(done.get(g["id"], set())),
        } for g in cfg.get("groups", [])],
        "categories": categories,
        "scenery": pieces,
    }
    with open(DATA_PATH, "w") as f:
        json.dump(data, f, indent=2)
    _pack_placed()
    return data


def _placed_states():
    """{piece: {state: count}} from the published worlds, or {} if they are not
    on disk — a publish never fails or waits on another domain's file."""
    try:
        import pack
        return pack.placed_states()
    except Exception as e:  # noqa: BLE001
        print(f"  ! placement join skipped ({e}) — pieces publish no `placed`")
        return {}


def _ensure_vents():
    """THE FLUE MOUTH FOLLOWS THE ART, like the packed layer does. Every
    pipeline script ends in build(), so a state generated this run is measured
    in the same unit that generated it and no consumer ever sees a chimney
    state without its `vent`. Fill-only (a state that has one is skipped) and
    never fatal: a piece that cannot be measured publishes no vent rather than
    failing a publish."""
    try:
        import vent
        r = vent.run(log=lambda *a: None)
        if r.get("wrote"):
            print(f"  vents: measured {r['wrote']} new state mouth(s)")
    except Exception as e:  # noqa: BLE001
        print(f"  ! vent measurement skipped ({e}) — states keep whatever they have")


def _pack_placed():
    """THE PACKED LAYER FOLLOWS THE ART (scenery-assistant 2026-09-12). games2
    draws every placed piece from <piece>/packed/ (pipeline/pack.py, README
    "THE PACKED LAYER"), and every pipeline script that touches art ends in
    build() — so this is the one place a regenerated placed piece is re-cut
    for the game, in the same unit that regenerated it. Incremental (a family
    whose raw bytes match its index is skipped: ~1 s over the 192 placed
    pieces when nothing changed; a re-rolled piece costs its own encodes) and
    never fatal: a piece that fails to pack draws raw, which is correct, just
    bigger. Pieces the worlds place AFTER this ran are the workflow's
    (.github/workflows/scenery-pack.yml)."""
    try:
        import pack
        r = pack.refresh(jobs=1, log=lambda *a: None)
        if r["touched"]:
            print(f"  packed: {len(r['touched'])} placed piece(s) re-cut for the game "
                  f"({', '.join(r['touched'][:6])}{', ...' if len(r['touched']) > 6 else ''})")
    except Exception as e:  # noqa: BLE001 — packing must never fail a publish
        print(f"  ! pack skipped ({e}) — placed pieces draw raw until pipeline/pack.py runs")
    # THE RETIREMENT CONTRACT rides on every publish: the world (maps2) and the
    # game's gate read scenery/retired.json to drop or re-state placements of
    # art a wiki verdict removed, instead of waiting for a run that notices.
    try:
        import retired
        retired.publish()
    except Exception as e:  # noqa: BLE001 — never fails a publish either
        print(f"  ! retired.json not republished ({e}) — run pipeline/retired.py")


if __name__ == "__main__":
    d = build()
    print(f"viewer_data.json: {d['scenery_count']} piece(s) of {d['target_count']} planned")
