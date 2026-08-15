"""Give EVERY non-tree, non-window piece the state treatment trees have.

Maintainer, 2026-08-15: "For all scenery that is not a TREE or WINDOW
(everything else). Should have the exact additional state logic that the trees
have now. The only exception: if the scenery is a LIT scenery now it will get 3
more LIT versions and 2 more UNLIT versions. If the scenery is UNLIT today it
will get 3 more UNLIT versions and 2 more lit versions."

So every piece ends at SIX states — four in its own lighting condition (the
existing art plus three) and two in the opposite. A lit brazier gains three more
lit braziers and two cold ones; a dark barrel gains three more dark barrels and
two glowing ones.

WHY THIS IS NOT tree_variants WITH A DIFFERENT LIST. That module's prompts say
"the tree" in every rung and its glow clauses name the glow they want removed —
which is the exact noun-negation trap the maintainer taught me on the window
prompt ("I dont mention things like 'the stone', 'the woodgrain'. Those word
will get this AI to start painting"). Trees are also one shape; this runs over
barrels, cairns, lamps, beds, boats, moss patches and waterfalls with ONE
ladder, so no rung may name an object, a material or a part. The gates are
imported from tree_variants unchanged — those are measurement, not language,
and they were calibrated on 438 of his verdicts.

    python3 pipeline/state_variants.py --dry-run
    python3 pipeline/state_variants.py --limit 5        # a pilot
    python3 pipeline/state_variants.py                  # the whole domain
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

import factory
import prompts_generic as P
import tree_variants as tv
import viewer_build
from pixellab_client import PixelLabClient, PixelLabError
from PIL import Image

# EXCLUDED BY THE TASK. Trees already have this (10 unlit + 4 lit); windows are
# a genuine LIGHTS_OFF/LIGHTS_ON pair whose two states must stay pixel-aligned
# for the game's crossfade, so extra variants would break the mechanic.
SKIP_TYPES = {"TREE", "WINDOW"}

LIT = [f"LIT_{i}" for i in range(1, 5)]
NOT_LIT = [f"NOT_LIT_{i}" for i in range(1, 5)]

PARALLEL = 8            # Tier 3 allows 25 concurrent; leave headroom
COMMIT_EVERY = 25       # "Commmit often" — roughly every 4-5 finished pieces
MAX_PROMPT_TRIES = len(P.LADDER)
MIN_USD = 0.40          # stop before a run starts failing on empty credit
ERROR_STOP = 6          # consecutive submit errors that mean "stop, something is wrong"


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _git(*a, check=True):
    return subprocess.run(["git", *a], cwd=factory.ROOT, capture_output=True,
                          text=True, check=check)


def _rebase_in_progress():
    """Never commit into someone else's half-finished rebase — it stages
    conflict markers as art. Same guard as loop.py, same reason."""
    for p in ("rebase-merge", "rebase-apply"):
        r = _git("rev-parse", "--git-path", p, check=False).stdout.strip()
        if r and os.path.exists(os.path.join(factory.ROOT, r)):
            return True
    return False


def commit_push(message, push=True):
    if _rebase_in_progress():
        print("  ! rebase in progress — skipping this commit, art is on disk")
        return False
    _git("add", "-A", ".")
    _git("add", "--", "../wiki/first_seen.json", check=False)
    if not _git("status", "--porcelain", "--", ".").stdout.strip():
        return False
    _git("commit", "-m", message)
    if push:
        for attempt in range(4):
            if _git("push", "-u", "origin", "main", check=False).returncode == 0:
                return True
            _git("fetch", "origin", "main", check=False)
            _git("rebase", "origin/main", check=False)
            if _rebase_in_progress():          # conflicted — back out, try later
                _git("rebase", "--abort", check=False)
                print("  ! push rebase conflicted — will retry on the next commit")
                return False
            time.sleep(2 ** attempt)
        print("  ! push failed after retries")
    return True


def in_scope(cfg):
    """Every piece that must end up with six states, and what it still needs."""
    types = {g["id"]: g.get("type") for g in cfg.get("groups", [])}
    out = []
    for rel, man in factory.discover():
        # LEGACY TOP-LEVEL PIECES ARE FROZEN. campfire, grave_cross and
        # blood_spatter are referenced by the game by name and two of them are
        # the maintainer's own hand-made objects; feedback.py refuses to delete
        # them and this must equally refuse to touch them.
        if "/" not in rel:
            continue
        group = rel.split("/")[0]
        if (man.get("type") or types.get(group) or "OTHER") in SKIP_TYPES:
            continue
        if not man.get("pixellab_object_id"):
            continue
        anchor, todo = plan_for(man)
        if todo:
            out.append((rel, man, anchor, todo))
    return out


def plan_for(man):
    """(anchor state, [states still missing]) for one piece.

    The ANCHOR is the existing art and is never regenerated. It is found by
    SPRITE IDENTITY rather than by the `lights` field, because `lights` is
    unreliable here: pieces that already went through a variant pass carry
    lights=null on purpose (a piece with both lit and unlit states has no
    single lighting), and a handful never had it set. The art is the truth."""
    states = man.get("states") or {}
    anchor = next((s.upper() for s, v in states.items()
                   if (v or {}).get("sprite") == man.get("sprite")), None)
    if anchor is None:
        anchor = "LIT_1" if (man.get("lights") or "").upper() == "LIGHTS_ON" else "NOT_LIT_1"
    own_lit = anchor.startswith("LIT_")
    # His rule: four in your own condition, two in the opposite.
    targets = (LIT + NOT_LIT[:2]) if own_lit else (NOT_LIT + LIT[:2])
    have = {s.upper() for s in states}
    return anchor, [s for s in targets if s != anchor and s not in have]


def ensure_anchor(rel, man, anchor):
    """Write the anchor into `states` BEFORE generating anything.

    THE RESUME BUG THIS EXISTS TO PREVENT, and it is not subtle. plan_for finds
    the anchor by sprite identity and falls back to `lights`. Nothing used to
    write the anchor entry, so on a resumed run no state matched the piece
    sprite — and by then finalize had called demote_piece_lights, which nulls
    `lights` on any piece holding both lit and unlit states. Null falls to the
    NOT_LIT branch, so every LIGHTS_ON piece silently changed anchor on the
    second run: it would plan NOT_LIT_3, NOT_LIT_4 and LIT_1 on top of the five
    it already had, ending at EIGHT states with an inverted split and ordering
    roughly 1,029 generations nobody asked for — about a hundred dollars.

    A 3,220-state run WILL be interrupted and resumed, so this is not a corner
    case; it is the normal path. Persisting the anchor makes plan_for
    idempotent, which is the property the whole resumable design rests on."""
    states = dict(man.get("states") or {})
    if anchor in states:
        return man
    states[anchor] = {"sprite": man["sprite"],
                      "pixellab_object_id": man.get("pixellab_object_id"),
                      "generated_at": man.get("generated_at") or _now()}
    man["states"] = {k: states[k] for k in sorted(states)}
    factory.write_manifest(rel, man)
    return man


def glow_for(man, cfg, state):
    """Which glow concept a LIT state should draw, from the group's own pool.

    Same idea as the tree pass: the piece's own concept leads, siblings get a
    DIFFERENT one so two lit variants are not near-twins."""
    pool = []
    for g in cfg.get("groups", []):
        if g["id"] == man.get("group"):
            pool = list(g.get("glow_concepts") or [])
            break
    own = man.get("glow_concept")
    if not pool:
        return own
    others = [g for g in pool if g != own] or pool
    idx = int(state.rsplit("_", 1)[-1]) if state.rsplit("_", 1)[-1].isdigit() else 1
    if idx == 1 and own:
        return own
    seed = factory._seed(man["id"], "glow")
    return others[(seed + idx) % len(others)]


def prompt_for(state, anchor, glow, attempt=0):
    """A ladder rung, a preservation clause, and — only when the state CROSSES
    lighting conditions — one clause naming that change.

    A same-condition variant gets no lighting clause: there is nothing to
    change, and the pilot showed that saying anything at all about light is
    read as a palette instruction and turns wood to stone."""
    parts = [P.LADDER[min(attempt, len(P.LADDER) - 1)], P.PRESERVE]
    want_lit = state.startswith("LIT_")
    anchor_lit = anchor.startswith("LIT_")
    if want_lit and not anchor_lit:
        parts.append(P.MAKE_LIT + (f" {glow}." if glow else ""))
    elif not want_lit and anchor_lit:
        parts.append(P.MAKE_UNLIT)
    return " ".join(p for p in parts if p)


def finalize(client, rel, man, state, oid, source_img, siblings, glow_used):
    """Gate the new art against the source AND every sibling, then write it."""
    detail = client.get_object(oid)
    url = client.sprite_url(detail)
    if not url:
        raise PixelLabError(f"{rel}/{state}: state object has no sprite")
    size = int(man.get("size") or 64)
    # A CDN URL can 404 for a few seconds after a job completes (the client
    # already retries, then gives up and returns None). Letting that None reach
    # .convert() raises AttributeError, which NOTHING here catches — it kills
    # the whole unattended run and abandons every paid job still in flight.
    # Raising PixelLabError instead routes it into the normal retry path.
    raw = client._download(url)
    if raw is None:
        raise PixelLabError(f"RETRY {rel}/{state}: sprite download came back empty")
    img = factory._normalize(raw.convert("RGBA"), size)

    diff = tv.difference(source_img, img)
    if diff < tv.MIN_DIFFERENCE:
        client.delete_object(oid)
        raise PixelLabError(f"RETRY {rel}/{state}: near-copy of the original "
                            f"({diff:.0%} different, need {tv.MIN_DIFFERENCE:.0%})")
    sd = tv.structural_difference(source_img, img)
    if sd < tv.SIBLING_MIN:
        client.delete_object(oid)
        raise PixelLabError(f"RETRY {rel}/{state}: same structure as the original "
                            f"({sd:.2f}, need {tv.SIBLING_MIN:.2f})")
    for other, opath in siblings.items():
        try:
            osd = tv.structural_difference(img, Image.open(opath).convert("RGBA"))
        except OSError:
            continue
        if osd < tv.SIBLING_MIN:
            client.delete_object(oid)
            raise PixelLabError(f"RETRY {rel}/{state}: too close to {other} "
                                f"(structure {osd:.2f}, need {tv.SIBLING_MIN:.2f})")

    out = f"{tv.state_dir(rel, state)}/sprite.webp"
    factory.save_webp(img, os.path.join(factory.ROOT, out))
    try:
        client.set_tags(oid, ["SCENERY"])
    except PixelLabError:
        pass

    # RE-READ before merging: several states of one piece are in flight at once
    # and each holds the manifest as it looked at submit time. Writing that
    # stale copy back silently drops whatever its siblings finished meanwhile
    # (measured on the first tree batch: 10 of 14 states lost).
    fresh = factory.read_manifest(rel) or man
    st = dict(fresh.get("states") or {})
    st[state] = {"sprite": out,
                 "pixellab_object_id": oid,
                 "generated_at": _now(),
                 "glow_concept": glow_used,
                 "difference_from_source": round(diff, 4),
                 "glow_score": round(tv.glow_score(img), 4)}
    fresh["states"] = {k: st[k] for k in sorted(st)}
    tv.demote_piece_lights(fresh)
    factory.write_manifest(rel, fresh)
    return diff


def balance(client):
    try:
        return float(client._request(
            "GET", "https://api.pixellab.ai/v2/balance")["credits"]["usd"])
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="only N pieces")
    ap.add_argument("--groups", default="", help="comma-separated group ids")
    ap.add_argument("--max-minutes", type=float, default=0.0)
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    cfg = factory.load_config()
    work = in_scope(cfg)
    if args.groups:
        want = {g.strip() for g in args.groups.split(",") if g.strip()}
        work = [w for w in work if w[0].split("/")[0] in want]
    if args.limit:
        work = work[:args.limit]

    # Persist every anchor FIRST, before a single job is submitted. Costs
    # nothing, and it is what makes plan_for idempotent across resumes.
    if not args.dry_run:
        work = [(rel, ensure_anchor(rel, man, anchor), anchor, todo_)
                for rel, man, anchor, todo_ in work]
    todo = [(rel, man, anchor, st) for rel, man, anchor, todo_ in work for st in todo_]
    print(f"{len(work)} piece(s) need states; {len(todo)} state(s) to generate")
    if args.dry_run:
        for rel, man, anchor, todo_ in work[:25]:
            print(f"  {rel:<44} anchor={anchor:<10} needs {todo_}")
        if len(work) > 25:
            print(f"  … +{len(work) - 25} more piece(s)")
        return 0
    if not todo:
        return 0

    client = PixelLabClient()
    bal = balance(client)
    print(f"balance ${bal:.2f}" if bal is not None else "balance unknown")
    if bal is not None and bal < MIN_USD:
        print("credits exhausted — stopping before spending")
        return 0

    queue = list(todo)
    flight = []        # [rel, state, oid, attempt, src, man, anchor, glow]
    ok = fail = since_commit = 0
    errors = 0
    deadline = time.monotonic() + args.max_minutes * 60 if args.max_minutes else None
    stop_file = os.path.join(factory.ROOT, ".stop")

    def siblings_of(rel, state):
        """Every OTHER state's art for this piece, for the near-twin gate."""
        m = factory.read_manifest(rel) or {}
        out = {}
        for s, v in (m.get("states") or {}).items():
            if s.upper() == state.upper():
                continue
            p = os.path.join(factory.ROOT, (v or {}).get("sprite") or "")
            if os.path.exists(p):
                out[s] = p
        return out

    throttled = 0          # consecutive passes where 429 blocked every submit
    while queue or flight:
        drain = os.path.exists(stop_file) or (deadline and time.monotonic() > deadline)
        # THE LOOP MUST BE ABLE TO END. When submission stops for any reason —
        # the stop file, the deadline, the error breaker, exhausted credit —
        # the queue stays non-empty while flight drains to nothing, and the
        # `if flight: sleep` at the bottom then never fires: a tight spin at
        # 100% CPU writing an unbounded log, forever, on an unattended run.
        if not flight and (drain or errors >= ERROR_STOP):
            print(f"stopping with {len(queue)} state(s) not started "
                  f"({'drain' if drain else 'error breaker'}) — resumable")
            break
        if not flight and throttled >= 20:
            print(f"stopping: PixelLab has refused new jobs {throttled} passes "
                  f"running; {len(queue)} state(s) left, resumable")
            break
        before = len(flight)
        while queue and len(flight) < PARALLEL and not drain and errors < ERROR_STOP:
            rel, man, anchor, state = queue.pop(0)
            # A glow concept is only USED when the state crosses from dark to
            # lit — a lit->lit variant keeps the light it already has and gets
            # no lighting clause at all. Computing one anyway meant finalize
            # recorded a glow_concept in the manifest that no prompt ever saw,
            # so "concept X is ugly" could be traced back to art that was never
            # drawn from it.
            crossing_to_lit = state.startswith("LIT_") and not anchor.startswith("LIT_")
            glow = glow_for(man, cfg, state) if crossing_to_lit else None
            try:
                src = Image.open(os.path.join(factory.ROOT, man["sprite"])).convert("RGBA")
            except OSError:
                fail += 1
                continue
            p = prompt_for(state, anchor, glow, 0)
            try:
                oid = tv.submit(client, man["pixellab_object_id"], p, state)
                flight.append([rel, state, oid, 0, src, man, anchor, glow])
                errors = 0
                print(f"» {rel} {state} ({len(flight)} in flight, "
                      f"{ok + fail}/{len(todo)} done)", flush=True)
            except PixelLabError as e:
                msg = str(e)
                if "429" in msg or "concurrent" in msg:
                    # Not our fault and not fatal: the account's job slots are
                    # full. Put it back and let the pipeline drain a little.
                    queue.insert(0, (rel, man, anchor, state))
                    break
                errors += 1
                fail += 1
                print(f"  x {rel} {state}: {msg[:150]}", flush=True)

        # A 429 means the ACCOUNT's job slots are full — not our error, and the
        # item goes back on the queue. But it must still be BOUNDED, or a
        # permanently-full account spins here forever submitting nothing.
        throttled = throttled + 1 if (queue and len(flight) == before
                                      and not drain) else 0
        if errors >= ERROR_STOP:
            print(f"  ! {errors} consecutive submit errors — stopping, "
                  f"draining {len(flight)} in flight")

        still = []
        for entry in flight:
            rel, state, oid, attempt, src, man, anchor, glow = entry
            try:
                status = client.get_object(oid).get("status")
            except PixelLabError:
                still.append(entry)
                continue
            if status not in ("completed", "failed"):
                still.append(entry)
                continue
            retry = False
            if status == "completed":
                try:
                    d = finalize(client, rel, man, state, oid, src,
                                 siblings_of(rel, state), glow)
                    ok += 1
                    since_commit += 1
                    print(f"  = {rel} {state} ({d:.0%} different)", flush=True)
                except PixelLabError as e:
                    retry = str(e).startswith("RETRY ")
                    print(f"  ~ {str(e)[:140]}", flush=True)
                    if not retry:
                        fail += 1
            else:
                retry = True
            if retry:
                nxt = attempt + 1
                if nxt >= MAX_PROMPT_TRIES:
                    fail += 1
                    print(f"  x {rel} {state}: gave up after {MAX_PROMPT_TRIES} prompts",
                          flush=True)
                    continue
                # A gate retry must obey the same brakes as a fresh submit —
                # otherwise the stop file, the deadline and an empty wallet all
                # stop NEW work while retries keep quietly ordering paid jobs.
                if drain or errors >= ERROR_STOP:
                    queue.append((rel, man, anchor, state))   # resume owns it
                    continue
                try:
                    entry[2] = tv.submit(client, man["pixellab_object_id"],
                                         prompt_for(state, anchor, glow, nxt), state)
                    entry[3] = nxt
                    still.append(entry)
                except PixelLabError as e:
                    if "429" in str(e) or "concurrent" in str(e):
                        # DO NOT keep the old object id. The gate already
                        # DELETED it, so polling it 404s forever and the entry
                        # holds a flight slot that never clears — which also
                        # means the run can never finish. Hand it back to the
                        # queue instead, where a fresh submit will be made.
                        queue.append((rel, man, anchor, state))
                    else:
                        fail += 1
        flight = still

        if since_commit >= COMMIT_EVERY:
            viewer_build.build()
            # Only reset the counter if the commit actually happened. It can
            # refuse (a rebase in progress), and resetting anyway meant those
            # states stopped counting toward the next commit AND toward the
            # tail commit — so a whole batch could sit uncommitted at the end
            # of the run, which is exactly what "commit often" is for.
            if commit_push(f"scenery: +{since_commit} state variants "
                           f"({ok}/{len(todo)} this run)", push=not args.no_push):
                since_commit = 0
            b = balance(client)
            if b is not None:
                print(f"  balance ${b:.2f}", flush=True)
                if b < MIN_USD:
                    print("  credits exhausted — draining and stopping")
                    queue = []
        if flight:
            time.sleep(8)

    viewer_build.build()
    if since_commit:
        commit_push(f"scenery: +{since_commit} state variants "
                    f"({ok}/{len(todo)} this run)", push=not args.no_push)
    print(f"\nstate variants: {ok} ok, {fail} failed, {len(queue)} not started")
    return 0


if __name__ == "__main__":
    sys.exit(main())
