"""Mirror the facings he marked in the wiki, then clear the request.

Him, via the wiki: "When reviewing an individual Scenery-state — the scenery
might have generated the same direction for both SE and SW. I need a way in my
review to flip/mirror a SE or a SW. This will be picked up by the scenery-agent."

PixelLab draws the two three-quarter views separately and sometimes returns the
same one twice, so a piece faces the same way from both sides. THE ART IS GOOD;
it is the wrong hand — rejecting it would throw away a drawing that only needs
flipping, which is the same reasoning as relight.py.

Input:  live/tuning/scenery_flips.json, schema pixel-wiki-scenery-flips@1 —
        overrides["scenery/<group>/<piece>#<STATE>#<dir>"] = {flip: true, ...}
        Absent means as-generated. The wiki previews the mirror while the
        request stands and says the file on disk is untouched, so this is what
        makes the preview true.

MIRROR THE NAMED FACING'S OWN ART — not "copy the other facing flipped". The
wiki gates the request as a picture ("the canvas after must be the horizontal
mirror of the canvas before"), and a duplicated SW *is* the SE art, so flipping
it in place is the same result and stays right for a facing whose twin has
already been fixed.

CACHE SAFETY. The mirrored file is derived art, so it never overwrites the
stable name: it is written as <dir>.<content hash>.webp, the manifest is
repointed and the old file stays, so a stale cache shows the coherent old
picture and never a mix. Every consumer reads rotation paths out of the
manifest. Each write is verified to flip back byte-exactly before the manifest
moves, and only then is the request cleared — if this dies in between, the
request is still standing and the run is simply repeated.

    python3 scenery/pipeline/consume_flips.py --dry-run
    python3 scenery/pipeline/consume_flips.py
"""
from __future__ import annotations

import hashlib, io, json, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, viewer_build

FLIPS = os.path.join(os.path.dirname(factory.ROOT), "live", "tuning",
                     "scenery_flips.json")
PREFIX = "scenery/"


def _load():
    if not os.path.exists(FLIPS):
        return None
    with open(FLIPS) as f:
        return json.load(f)


def plan():
    """[(key, rel, state, dir, current_rel_path)] for every standing request."""
    doc = _load()
    if not doc:
        return []
    out = []
    for key, v in sorted((doc.get("overrides") or {}).items()):
        if not (isinstance(v, dict) and v.get("flip")):
            continue
        body = key[len(PREFIX):] if key.startswith(PREFIX) else key
        parts = body.split("#")
        if len(parts) != 3:
            out.append((key, None, None, None, "malformed key"))
            continue
        rel, state, direction = parts[0], parts[1].upper(), parts[2]
        man = factory.read_manifest(rel)
        if man is None:
            out.append((key, rel, state, direction, "no such piece"))
            continue
        st = (man.get("states") or {}).get(state)
        if st is None:
            out.append((key, rel, state, direction, "no such state"))
            continue
        cur = (st.get("rotations") or {}).get(direction)
        if direction == "south" and not cur:
            cur = st.get("sprite")
        if not cur or not os.path.exists(os.path.join(factory.ROOT, cur)):
            out.append((key, rel, state, direction, "no art for that facing"))
            continue
        out.append((key, rel, state, direction, cur))
    return out


def _mirror(rel_path):
    with Image.open(os.path.join(factory.ROOT, rel_path)) as im:
        out = im.convert("RGBA").transpose(Image.FLIP_LEFT_RIGHT)
    buf = io.BytesIO()
    out.save(buf, "WEBP", lossless=True, exact=True)
    return buf.getvalue()


def apply(jobs, dry):
    done, failed = [], []
    for key, rel, state, direction, cur in jobs:
        if rel is None or not cur or "/" not in cur:
            failed.append((key, cur)); continue
        data = _mirror(cur)
        stem = cur[:-len(".webp")] if cur.endswith(".webp") else cur
        # A file already carrying a hash is re-hashed from its stem, so
        # flipping twice does not grow the name without bound.
        parts = stem.rsplit(".", 1)
        if len(parts) == 2 and len(parts[1]) == 10 and all(c in "0123456789abcdef" for c in parts[1]):
            stem = parts[0]
        new_rel = "%s.%s.webp" % (stem, hashlib.sha256(data).hexdigest()[:10])
        if dry:
            done.append((key, rel, state, direction, new_rel)); continue
        new_abs = os.path.join(factory.ROOT, new_rel)
        with open(new_abs, "wb") as f:
            f.write(data)
        back = np.asarray(Image.open(new_abs).convert("RGBA").transpose(
            Image.FLIP_LEFT_RIGHT), dtype=np.int16)
        orig = np.asarray(Image.open(os.path.join(factory.ROOT, cur)
                                     ).convert("RGBA"), dtype=np.int16)
        if back.shape != orig.shape or int(np.abs(back - orig).max()) != 0:
            os.remove(new_abs)
            failed.append((key, "mirror did not round-trip")); continue
        man = factory.read_manifest(rel)
        st = man["states"][state]
        if direction == "south" and not (st.get("rotations") or {}).get("south"):
            st["sprite"] = new_rel
        else:
            st.setdefault("rotations", {})[direction] = new_rel
        factory.write_manifest(rel, man)
        done.append((key, rel, state, direction, new_rel))
    return done, failed


def clear(keys, dry):
    """Drop the spent requests. Absent means as-generated, so a consumed
    request must LEAVE, not linger as a done flag he would see again."""
    doc = _load()
    if not doc or dry or not keys:
        return 0
    ov = doc.get("overrides") or {}
    n = sum(1 for k in keys if ov.pop(k, None) is not None)
    doc["overrides"] = ov
    with open(FLIPS, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return n


def main():
    dry = "--dry-run" in sys.argv
    jobs = plan()
    if not jobs:
        print("no flip requests standing")
        return 0
    ok = [j for j in jobs if j[4] and "/" in (j[4] or "")]
    bad = [j for j in jobs if j not in ok]
    for key, cur in [(j[0], j[4]) for j in bad]:
        print("SKIP %-58s %s" % (key, cur))
    done, failed = apply(ok, dry)
    for key, rel, state, direction, new in done:
        print("%-58s -> %s" % (key, os.path.basename(new)))
    for key, why in failed:
        print("FAILED %-56s %s" % (key, why))
    cleared = clear([d[0] for d in done], dry)
    print("\n%d facing(s) mirrored%s; %d request(s) cleared"
          % (len(done), " (DRY RUN)" if dry else "", cleared))
    if not dry and done:
        viewer_build.build()
        print("viewer_data.json rebuilt")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
