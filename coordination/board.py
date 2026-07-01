#!/usr/bin/env python3
"""Shared coordination board — how the domain agents (characters / objects / maps)
talk to each other DIRECTLY, with no human in the middle.

The channel is this git repo. Every agent commits to `main`, so the repo is a
durable, async message bus that works even though the agents are only awake when
their own Routine fires. Each agent OWNS `coordination/<domain>.json` (writes
only its own; reads everyone's) — one writer per file, so nothing ever conflicts.

This CLI is just the ergonomic front end; it only ever writes the caller's own
file. Usage:

    # START of every run — read messages addressed to you + fleet health:
    python coordination/board.py inbox <you>

    # ask another domain for something (async; they see it on their next run):
    python coordination/board.py post <you> --to <them> --text "..."

    # leave a note / acknowledge you handled an incoming request:
    python coordination/board.py note <you> --text "done: ..."

Example round trip (no human relay):
    maps:       post maps --to characters --text "town tiles are 32px"
    characters: inbox characters        # sees the request on its next run
    characters: note characters --text "ack: added a 32px skeleton for maps"
    maps:       inbox maps               # sees characters' note next run
"""

from __future__ import annotations

import argparse
import datetime
import glob
import json
import os

DIR = os.path.dirname(os.path.abspath(__file__))
STALE_SECONDS = 2 * 3600  # an agent silent this long is probably down


def _path(domain):
    return os.path.join(DIR, f"{domain}.json")


def _load(domain):
    try:
        with open(_path(domain)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"domain": domain, "notes": [], "requests": []}


def _save(domain, data):
    with open(_path(domain), "w") as f:
        json.dump(data, f, indent=2)


def _all_boards():
    boards = []
    for p in sorted(glob.glob(os.path.join(DIR, "*.json"))):
        try:
            with open(p) as f:
                boards.append(json.load(f))
        except (OSError, ValueError):
            pass
    return boards


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _is_stale(ts):
    try:
        t = datetime.datetime.fromisoformat(ts)
        return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() > STALE_SECONDS
    except (TypeError, ValueError):
        return True


def cmd_inbox(domain):
    print(f"== board: inbox for '{domain}' ==")
    requests_for_me = 0
    for b in _all_boards():
        src = b.get("domain")
        if src == domain:
            continue
        flag = "  (STALE — agent may be down)" if _is_stale(b.get("updated_at")) else ""
        print(f"- {src}: {b.get('health', '?')}, updated {b.get('updated_at', '?')}, "
              f"budget {b.get('budget_remaining')}{flag}")
        for r in b.get("requests", []):
            if r.get("to") == domain:
                requests_for_me += 1
                print(f"    >> REQUEST from {src}: {r.get('text')}")
    if not requests_for_me:
        print("  (no requests addressed to you)")
    print("  reminder: after acting, record it with `board.py note "
          f"{domain} --text \"...\"` so the asker sees it handled.")


def cmd_post(domain, to, text):
    d = _load(domain)
    d.setdefault("requests", []).append({"to": to, "text": text, "at": _now()})
    _save(domain, d)
    print(f"posted request: {domain} -> {to}: {text}")


def cmd_note(domain, text):
    d = _load(domain)
    d.setdefault("notes", []).append(f"[{_now()}] {text}")
    _save(domain, d)
    print(f"noted on {domain}: {text}")


def main():
    ap = argparse.ArgumentParser(description="Cross-agent coordination board.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_in = sub.add_parser("inbox", help="show requests addressed to you + fleet health")
    p_in.add_argument("domain")
    p_post = sub.add_parser("post", help="ask another domain for something")
    p_post.add_argument("domain")
    p_post.add_argument("--to", required=True)
    p_post.add_argument("--text", required=True)
    p_note = sub.add_parser("note", help="leave a note / acknowledge")
    p_note.add_argument("domain")
    p_note.add_argument("--text", required=True)
    args = ap.parse_args()

    if args.cmd == "inbox":
        cmd_inbox(args.domain)
    elif args.cmd == "post":
        cmd_post(args.domain, args.to, args.text)
    elif args.cmd == "note":
        cmd_note(args.domain, args.text)


if __name__ == "__main__":
    main()
