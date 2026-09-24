#!/usr/bin/env python3
"""Shared coordination board — how the domain agents talk to each other
DIRECTLY, with no human in the middle.

The channel is this git repo. Every agent commits to `main`, so the repo is a
durable, async message bus that works even though the agents are only awake when
their own Routine fires. Each agent OWNS `coordination/<domain>.json` (writes
only its own; reads everyone's) — one writer per file, so nothing ever conflicts.

This CLI is the ergonomic front end; it only ever writes the caller's own file
and the caller's own history file. Usage:

    # START of every run — OPEN requests addressed to you + fleet health
    # (and it prunes YOUR board: see "A board does not grow" below):
    python coordination/board.py inbox <you>

    # a partner's board, compactly (current, health, last notes, open requests):
    python coordination/board.py show <them>

    # ask another domain for something (async; they see it on their next run):
    python coordination/board.py post <you> --to <them> --text "..."

    # close a request addressed to you once it is handled (by id, or by a
    # fragment of its text). It leaves the inbox for good, and a note says so:
    python coordination/board.py done <you> <id-or-text>

    # leave a note / status:
    python coordination/board.py note <you> --text "..."

A REQUEST HAS A LIFECYCLE (maintainer 2026-09-24). It is OPEN from `post`
until the receiver runs `done`, or until it is REQUEST_TTL_DAYS old. `inbox`
prints open requests only. Before this every request ever addressed to a
domain was printed on every run of every agent — 314 KB, ~80k tokens, for the
games agent — because nothing was ever closed. A receiver records the close
on ITS OWN board (`handled`: ids), never on the sender's file; the sender's
board archives the request on the sender's next run.

A BOARD DOES NOT GROW. Every command prunes the caller's own board: closed or
expired requests, and notes beyond the last NOTES_KEEP, move to
`coordination/history/<domain>.json` — readable when the past matters, never
in anyone's first read. `coordination/check_firstread.py` gates the sizes.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import glob
import hashlib
import io
import json
import os

DIR = os.path.dirname(os.path.abspath(__file__))
HISTORY_DIR = os.path.join(DIR, "history")
STALE_SECONDS = 2 * 3600  # an agent silent this long is probably down
REQUEST_TTL_DAYS = 7  # an open request nobody closed is stale after this (the fleet runs hourly)
NOTES_KEEP = 10  # notes a board keeps (every `notes*` list); older ones live in history/
NOTES_MAX_BYTES = 16 * 1024  # ...and never more than this much of them: the newest that fit
INBOX_TEXT_CHARS = 300  # an inbox line is a headline; `req <id>` prints the whole request


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
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _all_boards():
    boards = []
    for p in sorted(glob.glob(os.path.join(DIR, "*.json"))):
        if os.path.basename(p) == "firstread.baseline.json":
            continue
        try:
            with open(p) as f:
                b = json.load(f)
            if isinstance(b, dict) and b.get("domain"):
                b["_file"] = os.path.basename(p)[:-5]  # the stem is the write key; `domain` may be shared with a `-github-agent` twin
                boards.append(b)
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


def _age_days(ts):
    """Days since `ts`; None when it cannot be read (a legacy request without one)."""
    try:
        t = datetime.datetime.fromisoformat(ts)
        if t.tzinfo is None:
            t = t.replace(tzinfo=datetime.timezone.utc)
        return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 86400
    except (TypeError, ValueError):
        return None


def _rid(to, text):
    """A request's id: content-derived (addressee + text), so a legacy request
    without one has the same name on every board that sees it, whatever the
    sender's file is called (a `<domain>-github-agent.json` board carries its
    domain's name in `domain`)."""
    return hashlib.sha1(f"{to}|{text}".encode()).hexdigest()[:10]


def _req_fields(sender, r):
    """(id, to, text, at) for a dict or a legacy free-form string request."""
    if isinstance(r, str):
        return _rid("", r), "", r, None
    to = r.get("to", "") or ""
    text = r.get("text", "") or ""
    return r.get("id") or _rid(to, text), to, text, r.get("at")


def _handled_everywhere(boards):
    """Every id any receiver has closed (their own `handled` lists)."""
    ids = set()
    for b in boards:
        for h in b.get("handled", []) or []:
            if isinstance(h, dict) and h.get("id"):
                ids.add(h["id"])
    return ids


def _is_open(sender, r, handled_ids):
    rid, _to, _text, at = _req_fields(sender, r)
    if rid in handled_ids:
        return False
    if isinstance(r, str):
        return False  # legacy free-form: every one of them predates the lifecycle
    age = _age_days(at)
    return age is not None and age <= REQUEST_TTL_DAYS


def _history_load(domain):
    try:
        with open(os.path.join(HISTORY_DIR, f"{domain}.json")) as f:
            h = json.load(f)
    except (OSError, ValueError):
        h = {}
    h.setdefault("domain", domain)
    h.setdefault("requests", [])
    h.setdefault("notes", [])
    return h


def _history_save(domain, h):
    os.makedirs(HISTORY_DIR, exist_ok=True)
    with open(os.path.join(HISTORY_DIR, f"{domain}.json"), "w") as f:
        json.dump(h, f, indent=2, ensure_ascii=False)
        f.write("\n")


def prune_own(domain, boards=None, write=True):
    """Move closed/expired requests and old notes off `domain`'s board into its
    history file, and drop `handled` ids whose request is gone from every
    board. Returns (requests_moved, notes_moved). Writes only the caller's
    own two files."""
    boards = boards if boards is not None else _all_boards()
    d = _load(domain)
    handled_ids = _handled_everywhere(boards)
    keep, gone = [], []
    for r in d.get("requests", []) or []:
        if _is_open(domain, r, handled_ids):
            keep.append(r)
        else:
            rid, to, text, at = _req_fields(domain, r)
            why = "handled" if rid in handled_ids else "expired"
            gone.append({"id": rid, "to": to, "text": text, "at": at, "closed_at": _now(), "why": why})
    note_keys = [k for k, v in d.items() if k.startswith("notes") and isinstance(v, list)]
    overflow = {}  # key -> the notes that leave
    kept_n = {}  # key -> how many of the newest stay
    for k in note_keys:
        v = d[k]
        keep_n, size = 0, 0
        for n in reversed(v):  # newest first, while both budgets hold
            size += len(json.dumps(n, ensure_ascii=False).encode())
            if keep_n >= NOTES_KEEP or (size > NOTES_MAX_BYTES and keep_n > 0):
                break
            keep_n += 1
        if keep_n < len(v):
            overflow[k] = v[:-keep_n] if keep_n else v[:]
            kept_n[k] = keep_n
    old_notes = [n for v in overflow.values() for n in v]
    # An ack outlives its request by nothing: once no board carries the id, drop it.
    live_ids = set()
    for b in boards:
        if b.get("domain") == domain:
            continue
        for r in b.get("requests", []) or []:
            live_ids.add(_req_fields(b.get("domain", ""), r)[0])
    handled_kept = [h for h in (d.get("handled", []) or []) if isinstance(h, dict) and h.get("id") in live_ids]
    changed = bool(gone or old_notes) or len(handled_kept) != len(d.get("handled", []) or [])
    if changed and write:
        d["requests"] = keep
        for k, v in overflow.items():
            d[k] = d[k][-kept_n[k]:] if kept_n[k] else []
        if "handled" in d or handled_kept:
            d["handled"] = handled_kept
        h = _history_load(domain)
        h["requests"].extend(gone)
        for k, v in overflow.items():
            h.setdefault(k, []).extend(v)
        _history_save(domain, h)
        _save(domain, d)
    return len(gone), len(old_notes)


def cmd_inbox(domain, write=True):
    boards = _all_boards()
    moved_r, moved_n = prune_own(domain, boards, write=write)
    if moved_r or moved_n:
        print(f"(your board: {moved_r} closed/expired request(s) and {moved_n} old note(s) moved to history/{domain}.json)")
    mine = _load(domain)
    my_handled = {h.get("id") for h in (mine.get("handled", []) or []) if isinstance(h, dict)}
    print(f"== board: inbox for '{domain}' — OPEN requests only (closed with `done`, or older than {REQUEST_TTL_DAYS} days, are not shown) ==")
    requests_for_me = 0
    hidden = 0
    for b in boards:
        src = b.get("domain")
        if src == domain:
            continue
        flag = "  (STALE — agent may be down)" if _is_stale(b.get("updated_at")) else ""
        print(f"- {src}: {b.get('health', '?')}, updated {b.get('updated_at', '?')}, "
              f"budget {b.get('budget_remaining')}{flag}")
        for r in b.get("requests", []) or []:
            rid, to, text, at = _req_fields(src, r)
            addressed = (to == domain) if not isinstance(r, str) else (domain.lower() in r[:120].lower())
            if not addressed:
                continue
            if rid in my_handled or not _is_open(src, r, set()):
                hidden += 1
                continue
            requests_for_me += 1
            head = text if len(text) <= INBOX_TEXT_CHARS else text[:INBOX_TEXT_CHARS] + f" …[`board.py req {rid}` for the rest]"
            print(f"    >> REQUEST {rid} from {src} ({(at or '?')[:10]}): {head}")
    if not requests_for_me:
        print("  (no open requests addressed to you)")
    if hidden:
        print(f"  ({hidden} request(s) to you already handled or older than {REQUEST_TTL_DAYS} days are not shown; history in coordination/history/)")
    print(f"  reminder: handle, then `board.py done {domain} <id>` so it leaves the inbox for good.")


def cmd_show(domain, notes_n=3):
    d = _load(domain)
    boards = _all_boards()
    handled_ids = _handled_everywhere(boards)
    print(f"== board: {domain} — {d.get('health', '?')}, updated {d.get('updated_at', '?')}{'  (STALE)' if _is_stale(d.get('updated_at')) else ''} ==")
    cur = d.get("current")
    print("current: " + (json.dumps(cur, ensure_ascii=False) if not isinstance(cur, str) else cur))
    notes = d.get("notes", []) or []
    if notes:
        print(f"last {min(notes_n, len(notes))} of {len(notes)} note(s):")
        for n in notes[-notes_n:]:
            s = n if isinstance(n, str) else json.dumps(n, ensure_ascii=False)
            print("  - " + (s if len(s) <= 600 else s[:600] + " …"))
    open_reqs = [r for r in (d.get("requests", []) or []) if _is_open(domain, r, handled_ids)]
    if open_reqs:
        print(f"open requests it posted ({len(open_reqs)}):")
        for r in open_reqs:
            rid, to, text, at = _req_fields(domain, r)
            print(f"  - {rid} -> {to} ({(at or '?')[:10]}): {text if len(text) <= 300 else text[:300] + ' …'}")


def cmd_post(domain, to, text):
    d = _load(domain)
    d.setdefault("requests", []).append({"id": _rid(to, text), "to": to, "text": text, "at": _now()})
    _save(domain, d)
    prune_own(domain)
    print(f"posted request: {domain} -> {to}: {text}")


def cmd_note(domain, text):
    d = _load(domain)
    d.setdefault("notes", []).append(f"[{_now()}] {text}")
    _save(domain, d)
    prune_own(domain)
    print(f"noted on {domain}: {text}")


def cmd_done(domain, ref):
    """Close a request addressed to `domain`: by id, or by a fragment of its text."""
    boards = _all_boards()
    mine = _load(domain)
    my_handled = {h.get("id") for h in (mine.get("handled", []) or []) if isinstance(h, dict)}
    hits = []
    for b in boards:
        src = b.get("domain")
        if src == domain:
            continue
        for r in b.get("requests", []) or []:
            rid, to, text, at = _req_fields(src, r)
            if to != domain or rid in my_handled:
                continue
            if rid.startswith(ref) or ref.lower() in text.lower():
                hits.append((rid, src, text))
    if not hits:
        print(f"no open request to {domain} matches {ref!r}")
        return 1
    if len(hits) > 1 and not any(h[0] == ref for h in hits):
        print(f"{len(hits)} open requests match {ref!r}; name one by id:")
        for rid, src, text in hits:
            print(f"  {rid} from {src}: {text[:120]}")
        return 1
    rid, src, text = next((h for h in hits if h[0] == ref), hits[0])
    mine.setdefault("handled", []).append({"id": rid, "from": src, "at": _now(), "text": text[:160]})
    mine.setdefault("notes", []).append(f"[{_now()}] done ({rid}, from {src}): {text[:160]}")
    _save(domain, mine)
    prune_own(domain)
    print(f"closed {rid} from {src}: {text[:160]}")
    return 0


def cmd_req(ref):
    """One request in full, by id (or its prefix), from whichever board holds it."""
    for b in _all_boards():
        src = b.get("domain")
        for r in b.get("requests", []) or []:
            rid, to, text, at = _req_fields(src, r)
            if rid.startswith(ref):
                print(f"== request {rid}: {src} -> {to} ({at or '?'}) ==")
                print(text)
                return 0
    print(f"no request on any board starts with {ref!r} (closed ones: coordination/history/)")
    return 1


def inbox_text(domain):
    """The inbox as text, WITHOUT writing anything (the size gate reads this)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        cmd_inbox(domain, write=False)
    return buf.getvalue()


def main():
    global REQUEST_TTL_DAYS
    ap = argparse.ArgumentParser(description="Cross-agent coordination board.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_in = sub.add_parser("inbox", help="OPEN requests addressed to you + fleet health (prunes your own board)")
    p_in.add_argument("domain")
    p_show = sub.add_parser("show", help="a board, compactly: current, health, last notes, open requests")
    p_show.add_argument("domain")
    p_post = sub.add_parser("post", help="ask another domain for something")
    p_post.add_argument("domain")
    p_post.add_argument("--to", required=True)
    p_post.add_argument("--text", required=True)
    p_done = sub.add_parser("done", help="close a request addressed to you (by id or a text fragment)")
    p_done.add_argument("domain")
    p_done.add_argument("ref")
    p_req = sub.add_parser("req", help="print one request in full, by id")
    p_req.add_argument("id")
    p_note = sub.add_parser("note", help="leave a note / status")
    p_note.add_argument("domain")
    p_note.add_argument("--text", required=True)
    p_prune = sub.add_parser("prune", help="archive your closed/expired requests and old notes (inbox does this too)")
    p_prune.add_argument("domain", nargs="?")
    p_prune.add_argument("--all", action="store_true", help="every board (a one-time migration, maintainer's order only)")
    p_prune.add_argument("--ttl", type=int, default=REQUEST_TTL_DAYS, help="with --all: requests older than this many days are archived")
    args = ap.parse_args()

    if args.cmd == "inbox":
        cmd_inbox(args.domain)
    elif args.cmd == "show":
        cmd_show(args.domain)
    elif args.cmd == "post":
        cmd_post(args.domain, args.to, args.text)
    elif args.cmd == "done":
        raise SystemExit(cmd_done(args.domain, args.ref))
    elif args.cmd == "req":
        raise SystemExit(cmd_req(args.id))
    elif args.cmd == "note":
        cmd_note(args.domain, args.text)
    elif args.cmd == "prune":
        if args.all:
            # THE LIFECYCLE'S INTRODUCTION (2026-09-24, maintainer): every board
            # is pruned once by whoever runs this, with a short TTL — nothing
            # posted before there was a way to close it can be open now.
            REQUEST_TTL_DAYS = args.ttl
            for b in _all_boards():
                stem = b["_file"]
                r, n = prune_own(stem)
                print(f"{stem}: {r} request(s) and {n} note(s) moved to history/{stem}.json")
        else:
            r, n = prune_own(args.domain)
            print(f"{args.domain}: {r} request(s) and {n} note(s) moved to history/{args.domain}.json")


if __name__ == "__main__":
    main()
