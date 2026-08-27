"""THE CACHE-SAFETY GATE. Proves the art-immutability law holds, every run.

The maintainer's law, verbatim, and the stake attached to it:

    "You must NEVER EVER EVER introduce a cache bug again. The next time I see a
     cache bug I delete the entire project."

Cache bugs killed his last two projects. The law this gate enforces makes them
structurally impossible here: a regenerable art file's NAME contains the sha1 of its
CONTENT, so the same URL can never serve two different pixels - a stale cache shows a
coherent old version or a 404, never a mix.

Three checks, and every one is falsifiable:

  1. NO MUTABLE NAMES. No file exists under a regenerable pass's old stable-name
     pattern (`<n>_textured.webp`, `post/tile_NN.webp` unhashed). Such a file is a
     future cache bug waiting for its second write.
  2. EVERY REFERENCE RESOLVES. Every art path named by the review manifest and the
     tops/blends indexes exists on disk. A dangling name means an index shipped pointing at
     art that is not there.
  3. HASHES ARE TRUE. Every content-hashed filename re-hashes to its own name. If
     anything ever rewrites a hashed file in place - the one remaining way to
     recreate the bug - this line catches it before the maintainer ever can.

Exit code 1 on any violation. publish.py runs it at the tail of every publish, so a
violation cannot ride a green build.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)

HASHED = re.compile(r"\.([0-9a-f]{8})\.webp$")


def main():
    bad = []

    # 1. no mutable names for regenerable passes
    for f in glob.glob(os.path.join(ROOT, "review", "*", "*_textured.webp")):
        bad.append(f"MUTABLE NAME: {os.path.relpath(f, REPO)}")
    for f in glob.glob(os.path.join(ROOT, "tops", "*", "sheet_*", "post", "*.webp")):
        if not HASHED.search(f):
            bad.append(f"MUTABLE NAME: {os.path.relpath(f, REPO)}")
    for f in glob.glob(os.path.join(ROOT, "blends", "*", "p??", "post", "*.webp")):
        if not HASHED.search(f):
            bad.append(f"MUTABLE NAME: {os.path.relpath(f, REPO)}")

    # 2. every reference resolves
    man = json.load(open(os.path.join(ROOT, "review", "manifest.json")))
    for c in man["cells"].values():
        for e in c["candidates"]:
            for k in ("before", "after", "textured"):
                p = e.get(k)
                if p and not os.path.isfile(os.path.join(REPO, p)):
                    bad.append(f"DANGLING {k}: {p}")
    for tree in ("tops", "blends"):
        ip = os.path.join(ROOT, tree, "index.json")
        if not os.path.isfile(ip):
            continue
        idx = json.load(open(ip))
        for s in idx["sheets"]:
            for pf in s.get("post_files") or []:
                if pf and not os.path.isfile(os.path.join(REPO, s["dir"], "post", pf)):
                    bad.append(f"DANGLING post: {s['dir']}/post/{pf}")

    # 3. hashes are true
    checked = 0
    for f in (glob.glob(os.path.join(ROOT, "review", "*", "*_textured.*.webp"))
              + glob.glob(os.path.join(ROOT, "tops", "*", "sheet_*", "post", "*.webp"))
              + glob.glob(os.path.join(ROOT, "blends", "*", "p??", "post", "*.webp"))):
        m = HASHED.search(f)
        if not m:
            continue
        h8 = hashlib.sha1(open(f, "rb").read()).hexdigest()[:8]
        if h8 != m.group(1):
            bad.append(f"HASH LIE (rewritten in place): {os.path.relpath(f, REPO)} "
                       f"names {m.group(1)}, content is {h8}")
        checked += 1

    if bad:
        print(f"*** CACHE-SAFETY GATE FAILED - {len(bad)} violation(s) ***")
        for b in bad[:20]:
            print("   " + b)
        print("   a violation here IS a cache bug in the making. Do not push.")
        return 1
    print(f"cache-safety gate: OK - 0 mutable names, 0 dangling references, "
          f"{checked} content hashes verified true")
    return 0


if __name__ == "__main__":
    sys.exit(main())
