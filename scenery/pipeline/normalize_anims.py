"""ONE animation shape for every consumer: the game reads the TOP LEVEL.

games2 scenery3.ts parseAnims reads `a.frame_paths`, `a.strip` and
`a.light_frames` on the animation object and ignores the clip otherwise
("names no frames"). This domain has published three shapes — frame_paths at
the top, `directions` as a list of names with frames at the top, and
`directions` as a dict with everything per direction — and the third was
invisible to the game since it was introduced: 169 clips, including
brazier_008's flame, which the map agent ranked as "animates well" off a
`review` verdict on a clip the game could not find (2026-09-10).

So every animation object now ALSO carries, at the top level, the SOUTH
direction's frame_paths, strip and light_frames (first direction if there is
no south). `directions` keeps the per-direction detail for the facings. Nothing
is removed; a consumer that reads either shape gets the same clip.

Idempotent and always recomputed from `directions`, so a regenerated clip
re-normalises on the next run.

    python3 scenery/pipeline/normalize_anims.py [--write]
"""
from __future__ import annotations
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory

ROOT = factory.ROOT


def _south(d):
    return d.get("south") or (next(iter(d.values())) if d else None)


def _strip_for(rel_dir, name, key):
    """The on-disk strip the wiki resolves by name, as a domain-relative path,
    or None if it is not there — never a path to a file that does not exist."""
    p = f"{rel_dir}/animations/{name}__{key}.webp"
    return p if os.path.exists(os.path.join(ROOT, p)) else None


def normalize(man, rel):
    changed = 0
    def fix(container, state):
        nonlocal changed
        for name, a in (container.get("animations") or {}).items():
            if not isinstance(a, dict):
                continue
            d = a.get("directions")
            if not isinstance(d, dict) or not d:
                continue
            key = "south" if "south" in d else next(iter(d))
            s = d[key] or {}
            fps = s.get("frame_paths") or []
            # the state folder, or the piece root for the anchor state
            rel_dir = os.path.dirname(fps[0]).rsplit("/animations", 1)[0] if fps else None
            want = {
                "frame_paths": fps,
                "strip": s.get("strip") or (_strip_for(rel_dir, name, key) if rel_dir else None),
                "light_frames": s.get("light_frames"),
            }
            for k, v in want.items():
                if v is not None and a.get(k) != v:
                    a[k] = v; changed += 1
    fix(man, None)
    for st, sv in (man.get("states") or {}).items():
        if isinstance(sv, dict):
            fix(sv, st)
    return changed


def unreadable():
    """Clips the game would drop: no top-level frame_paths and no strip."""
    out = []
    for rel, man in factory.discover():
        def scan(c, state):
            for name, a in (c.get("animations") or {}).items():
                if isinstance(a, dict) and not (a.get("frame_paths") or a.get("strip")):
                    out.append(f"{rel}#{state}#{name}")
        scan(man, None)
        for st, sv in (man.get("states") or {}).items():
            if isinstance(sv, dict): scan(sv, st)
    return out


if __name__ == "__main__":
    write = "--write" in sys.argv
    before = len(unreadable())
    n = 0
    for rel, man in factory.discover():
        c = normalize(man, rel)
        if c and write:
            factory.write_manifest(rel, man)
        n += c
    after = len(unreadable()) if write else before
    print(f"{n} field(s) lifted to the top level{'' if write else ' (DRY RUN)'}; "
          f"clips the game cannot read: {before} -> {after}")
