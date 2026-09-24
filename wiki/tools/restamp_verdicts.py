#!/usr/bin/env python3
"""Carry his animation verdicts across a re-encode (maintainer 2026-09-24:
"Why is ashfall sorted as monster second?!").

A verdict is stamped with the md5 of the strip FILE he judged (first 16 hex;
wiki/build.mjs `h`). When a pipeline rewrites a strip without changing a pixel
— the monsters graduation (33ad7382f) re-encoded every strip it moved, and
re-padded some frames onto a larger canvas — the stamp stops matching and the
wiki reads his verdict as "regenerated since, judge again": 28 of 40 on
Hornmaul, all 40 on the sand scorpling, and his whole working batch fell out
of "in the making" as a result.

For each monsters verdict whose `art` no longer matches the current strip,
this finds the exact blob he judged in git history (by that md5) and compares
PIXELS frame by frame, each frame trimmed to its alpha box so a re-pad does not
count as a change. Identical art -> the stamp moves to the current file.
Anything else is left alone: genuinely new art must be judged again.

  python3 wiki/tools/restamp_verdicts.py            # dry run: report only
  python3 wiki/tools/restamp_verdicts.py --write    # rewrite live/feedback/monsters.json
"""
import hashlib, io, json, os, subprocess, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FB = os.path.join(ROOT, "live", "feedback", "monsters.json")
DATA = os.path.join(ROOT, "wiki", "site", "data.json")

def md5_16(b): return hashlib.md5(b).hexdigest()[:16]

def git(*a, binary=False):
    r = subprocess.run(["git", "-C", ROOT, *a], capture_output=True)
    return r.stdout if binary else r.stdout.decode()

def frames(blob, n):
    im = Image.open(io.BytesIO(blob)).convert("RGBA")
    w, h = im.size
    fw = w // n if n else w
    out = []
    for i in range(n):
        f = im.crop((i * fw, 0, (i + 1) * fw, h))
        box = f.getchannel("A").getbbox()
        out.append((box and f.crop(box).tobytes(), box and (box[2] - box[0], box[3] - box[1])))
    return out

_hist = {}
def history_blob(paths, want):
    """The blob with md5 prefix `want` that ever lived at any of `paths`."""
    for p in paths:
        if p not in _hist:
            revs = git("log", "--format=%H", "--", p).split()
            _hist[p] = revs
        for rev in _hist[p]:
            b = git("show", f"{rev}:{p}", binary=True)
            if b and md5_16(b) == want:
                return b
    return None

def main(write):
    doc = json.load(open(FB))
    entries = doc.get("entries") or {}
    reg = {m["id"]: m for m in json.load(open(DATA))["domains"]["monsters"]}
    moved = kept = missing = 0
    for key, e in entries.items():
        art = e.get("art")
        if not art or key.count("#") != 2:
            continue
        path, st, d = key.split("#")
        m = reg.get(path.split("/")[-1])
        clip = (m or {}).get("animations", {}).get(st, {}).get("dirs", {}).get(d)
        if not clip or not clip.get("strip"):
            continue
        cur = open(os.path.join(ROOT, clip["strip"]), "rb").read()
        now = md5_16(cur)
        if art == now or art == (m or {}).get("artHash"):
            continue
        cid = m["id"]
        name = os.path.basename(clip["strip"])
        old = history_blob([f"monsters/candidates/{cid}/animations/{name}", clip["strip"],
                            f"monsters/{cid}/animations/{name}"], art)
        if old is None:
            missing += 1
            continue
        n = clip.get("frames") or 1
        if frames(old, n) == frames(cur, n):
            print(f"  same pixels  {key}  {art} -> {now}")
            e["art"] = now
            moved += 1
        else:
            kept += 1
    print(f"{moved} verdict(s) carried to the re-encoded file, {kept} left for a new look "
          f"(the art changed), {missing} whose judged file is not in reachable history")
    if write and moved:
        with open(FB, "w") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        print(f"wrote {os.path.relpath(FB, ROOT)}")

if __name__ == "__main__":
    main("--write" in sys.argv)
