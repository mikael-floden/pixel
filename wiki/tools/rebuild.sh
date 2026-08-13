#!/usr/bin/env bash
# Refresh everything the wiki derives from the art domains. ONE pass now:
# build.mjs measures the art itself (wiki/tools/webp-pixels.mjs) and
# art_bounds.json is only its content-hash cache, so the circular
# build→measure→build dance this script used to choreograph is gone — and with
# it the failure where art pushed between the passes shipped unmeasured (the
# 2026-08-13 monster-viewer scrollbar). The same measurement runs inside every
# deploy's image build, so pushes are self-measuring; this script is for
# refreshing the committed cache and running the proofs locally.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== build (measures any new/changed art) =="
node wiki/build.mjs --games2 games2

echo
echo "== verify =="
node wiki/tools/check-artbounds.mjs
node wiki/tools/check-pixels.mjs
