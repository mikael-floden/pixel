#!/usr/bin/env python3
"""Content hashes for every audio file the game can fetch.

WHY (game agent, 2026-08-22): "7.8 of the remaining 8.7 MB is audio — the
composer's stamper still uses ?v, so sounds and music re-download on every
deploy." Correct, and it is a property of the TOKEN, not of the stamper. The
server grants `immutable` only when `?v` equals its own GIT_SHA
(server/src/cachepolicy.ts), so the url of an unchanged bed necessarily
changes every deploy and the browser necessarily re-fetches it. Measured here:
42 live beds, 67.4 MB of .ogg, ~110 kbit/s each — a load pulling five of them
is the 7.8 MB.

A CONTENT HASH IS THE RIGHT TOKEN, and it is strictly safer than a build sha:
the url changes if and only if the bytes change, so a stale `immutable` grant
is not merely unlikely but unconstructable. (A wrong sha, by contrast, is only
safe because the sha happens to move often enough.)

This file is COMMITTED DATA, not a build step — same as tracks.json. The
server reads it once at boot and the client stamps from it, so the two can
never disagree with each other. The danger is both agreeing while the FILES
have moved on, which would freeze changed bytes behind an unchanged url, so
`--check` re-hashes the disk and fails on any drift; CI runs it.

Run:  python3 games2/composer/scripts/audio-hashes.py [--check]
        --check   verify the committed manifest against the files, write nothing
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # games2/
REPO = ROOT.parent
OUT = ROOT / "composer" / "audio-hashes.json"
AUDIO = {".ogg", ".m4a", ".mp3", ".wav"}

# Keyed by the path UNDER /assets, because that is what the server sees on the
# request and what the engine builds its urls from. Anything not served from
# /assets cannot be cache-stamped and is not listed.
MOUNTS = {
    "composer/music": ROOT / "composer" / "music",
    "composer/foley": ROOT / "composer" / "foley",
    "sounds": REPO / "sounds",
    "music": REPO / "music",
}

# 8 hex chars = 4 bytes. Collisions would have to happen BETWEEN TWO VERSIONS OF
# ONE FILE to matter (the manifest is keyed by path), so the birthday bound is
# over a handful of revisions, not over the whole library: ~1 in 4 billion per
# pair. A longer hash only lengthens every url.
LEN = 8


def digest(p: Path) -> str:
    h = hashlib.blake2b(digest_size=16)
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:LEN]


def scan() -> dict[str, str]:
    out: dict[str, str] = {}
    for mount, base in MOUNTS.items():
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            # A .wav master is kept in the repo and kept OUT of the image by
            # .dockerignore, so the game can never fetch one — listing it would
            # promise a url that 404s.
            if not p.is_file() or p.suffix not in AUDIO or p.suffix == ".wav":
                continue
            out[f"{mount}/{p.relative_to(base).as_posix()}"] = digest(p)
    return out


def main() -> int:
    check = "--check" in sys.argv
    found = scan()
    if check:
        if not OUT.exists():
            print(f"FAIL {OUT.name} does not exist — run without --check")
            return 1
        have = json.loads(OUT.read_text()).get("hashes", {})
        missing = sorted(set(found) - set(have))
        extra = sorted(set(have) - set(found))
        changed = sorted(k for k in set(found) & set(have) if found[k] != have[k])
        for label, ks in (("not listed", missing), ("listed but gone", extra),
                          ("BYTES CHANGED", changed)):
            for k in ks[:10]:
                print(f"  {label}: {k}")
            if len(ks) > 10:
                print(f"  ... and {len(ks) - 10} more {label}")
        bad = len(missing) + len(extra) + len(changed)
        # CHANGED is the dangerous one: the manifest and the client would agree
        # on a url that no longer denotes those bytes, which is the one way this
        # scheme can serve a stale file for a year.
        print(f"{'FAIL' if bad else 'OK'} {len(found)} audio file(s), {bad} drifted")
        return 1 if bad else 0
    OUT.write_text(json.dumps({
        "format": "pixel-composer-audio-hashes@1",
        "_comment": "path under /assets -> short content hash. The engine stamps "
                    "?v=<hash> so a url changes exactly when the bytes do; the "
                    "server may grant immutable on a match. Regenerate with "
                    "games2/composer/scripts/audio-hashes.py; CI runs --check.",
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "hash": f"blake2b/{LEN}",
        "hashes": found,
    }, indent=1, sort_keys=True) + "\n")
    size = sum(len(k) + LEN for k in found)
    print(f"wrote {OUT.relative_to(REPO)}: {len(found)} audio file(s), ~{size / 1024:.0f} KB of map")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
