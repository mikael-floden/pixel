"""FINISH a regenerated clip so both consumers can see it — the one step every
redo tool must end with.

A clip is PUBLISHED only when all of this holds on its animation object:
  * `directions.<dir>.strip` names a strip built from the CURRENT frames, under
    a content-hashed name (`<name>__<dir>.<sha8>.webp`, previous generation
    kept, cache law), and the SOUTH one is also the top-level `strip`;
  * top-level `frame_paths` is south's list (games2 parseAnims reads only the
    top level and drops a clip with neither frames nor strip: "names no
    frames — ignored");
  * `review` is stamped (anim_review.py; WorldScene plays PROBABLY_GOOD or his
    APPROVED, nothing else) and `light_frames` recomputed (light_frames.py);
  * the piece is re-packed (pack.py — the game reads frames hashed through
    packed/index.json, a missing path is served raw under a stable name).

Paid for 2026-09-15: redo_facing_anim.py popped frame_paths/strip/review off
18 clips it regenerated — every hearth clip among them — and pushed. The game
dropped all 18 at parse; the hearth in the maintainer's house went still and
the stale strips on disk kept showing the wiki the OLD flame. Both gates were
red (38 unjudged, 37 light problems) and nobody ran them before the push.

    python3 scenery/pipeline/finish_clips.py            # every unfinished clip
    python3 scenery/pipeline/finish_clips.py --clips hearths/hearth_001#LIT_2#flame,...
    python3 scenery/pipeline/finish_clips.py --all      # rebuild every strip (slow)
    python3 scenery/pipeline/finish_clips.py --check    # gate: 0 unfinished, all gates green
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from io import BytesIO

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory                                        # noqa: E402
import normalize_anims                                # noqa: E402
import pack                                           # noqa: E402
import viewer_build                                   # noqa: E402
from repair_strips import frames_in                   # noqa: E402

ROOT = factory.ROOT
HERE = os.path.dirname(os.path.abspath(__file__))


def _abs(p):
    return os.path.join(ROOT, p)


def _strip_bytes(frame_dir):
    """One row of the frames, lossless AND exact (repo law), as bytes."""
    names = frames_in(frame_dir)
    if not names:
        return None, 0
    ims = [Image.open(os.path.join(frame_dir, n)).convert("RGBA") for n in names]
    w, h = max(i.width for i in ims), max(i.height for i in ims)
    strip = Image.new("RGBA", (w * len(ims), h), (0, 0, 0, 0))
    for i, im in enumerate(ims):
        strip.paste(im, (i * w + (w - im.width) // 2, (h - im.height) // 2), im)
    buf = BytesIO()
    strip.save(buf, format="WEBP", lossless=True, exact=True, method=6)
    return buf.getvalue(), len(ims)


def _publish_strip(name, direction, frame_paths):
    """Write the strip for one facing under its content hash and return its
    domain-relative path. NEVER deletes a superseded generation: 'one back'
    is measured from the last PUBLISHED state, and two redo rounds in one
    push would have removed the strip every open wiki page still names
    (2026-09-17, 20 strips restored). A hashed name can only ever serve the
    bytes it names; deleting it 404s a page already open."""
    frame_dir = _abs(os.path.dirname(frame_paths[0]))
    data, n = _strip_bytes(frame_dir)
    if not data:
        return None
    anim_parent = os.path.dirname(os.path.dirname(frame_paths[0]))
    if os.path.basename(anim_parent) != "animations":          # flat layout
        anim_parent = os.path.dirname(anim_parent)
    h = hashlib.sha256(data).hexdigest()[:8]
    rel = f"{anim_parent}/{name}__{direction}.{h}.webp"
    if not os.path.exists(_abs(rel)):
        with open(_abs(rel), "wb") as f:
            f.write(data)
    return rel


def _clips(man, rel):
    for name, a in (man.get("animations") or {}).items():
        if isinstance(a, dict):
            yield None, name, a
    for st, sv in (man.get("states") or {}).items():
        if isinstance(sv, dict):
            for name, a in (sv.get("animations") or {}).items():
                if isinstance(a, dict):
                    yield st, name, a


def _wants_light(rel, man, st):
    """light_frames.py's own rule: LIT_* states (and the always-lit legacy
    piece-root clips) of a piece that publishes a light, windows excepted."""
    if rel.split("/", 1)[0] in {"windows"} or not man.get("light"):
        return False
    return st is None or st.upper().startswith("LIT_")


def unfinished():
    """Clips missing a published field at the top level."""
    out = []
    for rel, man in factory.discover():
        for st, name, a in _clips(man, rel):
            need = ["frame_paths", "strip", "review"]
            if _wants_light(rel, man, st):
                need.append("light_frames")
            if not all(a.get(k) for k in need):
                out.append(f"{rel}#{st}#{name}")
    return out


def restrip(clip_ids):
    """Rebuild and record every facing's strip for the named clips."""
    by_piece = {}
    for cid in clip_ids:
        rel, st, name = cid.split("#")
        by_piece.setdefault(rel, []).append((None if st in ("None", "") else st, name))
    done = 0
    for rel, wanted in by_piece.items():
        man = factory.read_manifest(rel)
        if not man:
            continue
        for st, name, a in _clips(man, rel):
            if (st, name) not in wanted:
                continue
            d = a.get("directions")
            if isinstance(d, dict) and d:
                for direction, dv in d.items():
                    if not isinstance(dv, dict) or not dv.get("frame_paths"):
                        continue
                    new = _publish_strip(name, direction, dv["frame_paths"])
                    if new:
                        dv["strip"] = new
                        done += 1
                south = d.get("south") or {}
                if south.get("frame_paths"):
                    a["frame_paths"] = list(south["frame_paths"])
                    a["strip"] = south.get("strip")
            elif a.get("frame_paths"):
                new = _publish_strip(name, "south", a["frame_paths"])
                if new:
                    a["strip"] = new
                    done += 1
        factory.write_manifest(rel, man)
    return done, sorted(by_piece)


def _run(script, *args):
    r = subprocess.run([sys.executable, os.path.join(HERE, script), *args],
                       cwd=os.path.dirname(ROOT), capture_output=True, text=True)
    tail = (r.stdout.strip().splitlines() or [""])[-1]
    print(f"  {script} {' '.join(args)}: {tail}")
    return r.returncode


def finish(clip_ids):
    """The whole chain for the named clips. Returns True when the gate is green."""
    n, pieces = restrip(clip_ids)
    print(f"finish: {len(clip_ids)} clip(s), {n} strip(s) published under content hashes")
    _run("normalize_anims.py", "--write")
    _run("anim_review.py", "--write")
    _run("light_frames.py", "--write")
    if pieces:
        pack.refresh(ids=pieces, log=lambda m: print(f"  {m}"))
    viewer_build.build()
    return check()


def check():
    left = unfinished()
    unread = normalize_anims.unreadable()
    ok = not left and not unread
    for cid in left[:20]:
        print(f"  unfinished: {cid}")
    for cid in unread[:20]:
        print(f"  unreadable: {cid}")
    ok &= _run("anim_review.py", "--check") == 0
    ok &= _run("light_frames.py", "--check") == 0
    ok &= _run("pack.py", "--check") == 0
    print(f"{'PASS' if ok else 'FAIL'} — {len(left)} unfinished, {len(unread)} unreadable")
    return ok


def main(argv):
    if "--check" in argv:
        return 0 if check() else 1
    if "--clips" in argv:
        ids = argv[argv.index("--clips") + 1].split(",")
    elif "--all" in argv:
        ids = [f"{rel}#{st}#{name}" for rel, man in factory.discover()
               for st, name, _ in _clips(man, rel)]
    else:
        ids = unfinished()
    if not ids:
        print("nothing unfinished")
        return 0 if check() else 1
    return 0 if finish(ids) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
