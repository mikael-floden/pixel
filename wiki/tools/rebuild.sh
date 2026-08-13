#!/usr/bin/env bash
# Refresh EVERYTHING the wiki derives from the art domains, in the one order
# that is actually correct.
#
# The dependency is circular and that is what bit us on 2026-08-13:
#
#   build.mjs        reads monsters/, characters2/, scenery/ … and art_bounds.json
#   art-bounds.py    reads wiki/site/data.json  ← written by build.mjs
#
# So when a domain grows, ONE pass is never enough. Run build first and
# art-bounds.py still measures yesterday's entity list; run art-bounds.py first
# and build.mjs still folds in yesterday's boxes. The 33 monsters imported that
# morning got a data.json rebuild without the second pass, so none of them had a
# measured content box — and an unmeasured clip is drawn at whole-FRAME size,
# transparent padding and all. Cragback asked the viewer for a 472px canvas on a
# 426px stage and grew a scrollbar; Diretusk and Rimeshard, measured back in
# July, sat neatly inside it. It also seeded their LEVELS off a zero area, which
# is how a rabbit came to outrank a bear.
#
#   pass 1  build.mjs      → data.json knows the new entities
#   pass 2  art-bounds.py  → measures them, sizes the shared stage box
#   pass 3  build.mjs      → folds the new bb/boxes back into data.json
#
# Idempotent: a second run of a clean tree changes only the timestamps.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== pass 1/3: build (discover art) =="
node wiki/build.mjs --games2 games2

echo
echo "== pass 2/3: measure art bounds =="
python3 wiki/tools/art-bounds.py

echo
echo "== pass 3/3: build (fold the measurements in) =="
node wiki/build.mjs --games2 games2

echo
echo "== verify =="
node wiki/tools/check-artbounds.mjs
