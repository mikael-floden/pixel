#!/usr/bin/env python3
"""THE FIRST READ HAS A BUDGET (maintainer 2026-09-24). What an agent reads
before it does anything — the law files Claude Code loads into every turn, the
protocol, its inbox, the boards, its domain README — is paid on every run of
every agent, and only one of those files had a gate (games2/CLAUDE.md, 20 KB).
The inbox alone was 314 KB for the games agent. This gates all of it:

  root CLAUDE.md, coordination/PROTOCOL.md      <= 20 KB each
  every coordination/<board>.json               <= 48 KB (board.py prunes it)
  every `board.py inbox <domain>`               <= 16 KB (open requests only)
  every <domain>/README.md                      <= 24 KB, or its size in
                                                   firstread.baseline.json if
                                                   larger: a RATCHET — one over
                                                   24 KB may shrink, never grow
                                                   (split it into <domain>/docs/,
                                                   as games2 did)

Run from anywhere: `python3 coordination/check_firstread.py`; `--baseline`
rewrites the README baseline from the tree (only when a README legitimately
grew under 24 KB or a domain was added). games2/server/test/firstread.test.ts
runs it in the suite. Exit 1 names every file over budget.
"""

from __future__ import annotations

import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
KB = 1024
LAW_MAX = 20 * KB
BOARD_MAX = 48 * KB
INBOX_MAX = 16 * KB
README_MAX = 24 * KB
BASELINE = os.path.join(HERE, "firstread.baseline.json")

sys.path.insert(0, HERE)
import board  # noqa: E402


def size(path):
    return os.path.getsize(path)


def readmes():
    out = {}
    for p in sorted(glob.glob(os.path.join(ROOT, "*", "README.md"))):
        rel = os.path.relpath(p, ROOT)
        out[rel] = size(p)
    return out


def main(argv):
    if "--baseline" in argv:
        with open(BASELINE, "w") as f:
            json.dump({"readme_bytes": readmes()}, f, indent=2, sort_keys=True)
            f.write("\n")
        print(f"baseline written: {BASELINE}")
        return 0
    try:
        with open(BASELINE) as f:
            base = json.load(f).get("readme_bytes", {})
    except (OSError, ValueError):
        base = {}
    over = []
    rows = []

    def check(label, n, cap):
        rows.append((n, cap, label))
        if n > cap:
            over.append(f"{label}: {n} > {cap} bytes")

    for rel in ["CLAUDE.md", "coordination/PROTOCOL.md"]:
        p = os.path.join(ROOT, rel)
        if os.path.exists(p):
            check(rel, size(p), LAW_MAX)
    for p in sorted(glob.glob(os.path.join(HERE, "*.json"))):
        if os.path.basename(p) == "firstread.baseline.json":
            continue
        check(os.path.relpath(p, ROOT), size(p), BOARD_MAX)
    seen = set()
    for b in board._all_boards():
        d = b["domain"]
        if d in seen:
            continue
        seen.add(d)
        check(f"board.py inbox {d}", len(board.inbox_text(d).encode()), INBOX_MAX)
    for rel, n in readmes().items():
        check(rel, n, max(README_MAX, base.get(rel, 0)))
    rows.sort(reverse=True)
    print("first read, largest first (bytes / cap):")
    for n, cap, label in rows[:12]:
        print(f"  {n:7d} / {cap:6d}  {label}{'   <-- OVER' if n > cap else ''}")
    if over:
        print("\nOVER BUDGET:")
        for o in over:
            print("  " + o)
        print("\nA law file: move the measurement and the story to a topic doc, keep the rule and the pointer.")
        print("A board: `python3 coordination/board.py prune <you>` (inbox does it too); close handled requests with `done`.")
        print("A README: split its measurements into <domain>/docs/*.md (games2/CLAUDE.md + games2/docs/ is the pattern).")
        return 1
    print("first read within budget")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
