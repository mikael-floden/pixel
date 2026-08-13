"""The scenery loop (v2.1): one full canvas per piece, S-only, tag-stamped.

ONE PIECE = one PixelLab call (20-40 generations either way):
  - art_size <= 168: `create-8-direction-object` (view "low top-down") and we
    keep ONLY the SOUTH rotation — the maintainer's "fool PixelLab" rule:
    scenery never rotates, but generating it as a real 8-direction object
    keeps every piece a first-class, animatable store citizen instead of an
    icon-grade candidate.
  - art_size > 168 (the 8-rotation pipeline's cap): a SINGLE-candidate
    `create-1-direction-object` — full canvas, auto-kept, never enters review.

Multi-candidate batching (v2.0) is retired: shared-canvas candidates read as
icons, stranded 'Review Generated Frames' popups in the maintainer's UI when
a run died mid-select, and carried the broken-pixel-grid bug (the first
graves came out as per-pixel mush; every single-canvas piece was crisp).

The plan is deterministic (catalog.py): the filesystem alone decides what is
next, so the loop can stop anywhere — mid-day, mid-piece, out of budget — and
the next run continues exactly where it left off. Pieces commit one by one;
pushes go every PUSH_EVERY pieces so a long pass doesn't fire a deploy per
sprite.

Run a bounded chunk (intended for the daily schedule / GitHub Action):
  python scenery/pipeline/loop.py --max-pieces 100 --max-minutes 300
Other flags: --max-batches N, --once (one piece), --no-push, --dry-run,
--no-sync.
"""

from __future__ import annotations

import argparse
import subprocess
import time

import catalog
import coordination
import factory
import viewer_build
from pixellab_client import PixelLabClient, PixelLabError


# --- git --------------------------------------------------------------------

def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=factory.ROOT, capture_output=True,
                          text=True, check=check)


def _current_branch():
    return _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"


def commit_push(message, push=True):
    """Commit only the scenery/ domain + our own heartbeat, push with
    rebase-and-retry backoff (disjoint domain paths rebase cleanly)."""
    _git("add", "-A", ".")
    _git("add", "--", "../coordination/scenery.json", check=False)
    status = _git("status", "--porcelain", "--", ".",
                  "../coordination/scenery.json").stdout.strip()
    if not status:
        return False
    _git("commit", "-m", message)
    if push:
        branch = _current_branch()
        for attempt in range(4):
            r = _git("push", "-u", "origin", branch, check=False)
            if r.returncode == 0:
                break
            _git("fetch", "origin", branch, check=False)
            _git("rebase", f"origin/{branch}", check=False)
            time.sleep(2 ** (attempt + 1))
        else:
            print("  ! push failed after retries:", r.stderr[:200])
    return True


# --- budget -----------------------------------------------------------------

def budget_state(client):
    b = client.balance()
    return {
        "generations": float((b.get("subscription") or {}).get("generations") or 0),
        "usd": float((b.get("credits") or {}).get("usd") or 0),
    }


def can_spend(cfg, state):
    """A batch may run when EITHER budget lane has headroom: the subscription
    pool above the fleet's shared floor, or USD credits above the usd floor.
    Both floors live in config so the maintainer owns the knobs."""
    bud = cfg.get("budget", {})
    if state["generations"] >= float(bud.get("min_generations_remaining", 2000)):
        return True
    return state["usd"] >= float(bud.get("min_usd", 2.0))


# --- one piece ---------------------------------------------------------------

# Commit per piece; push (-> deploy -> reviewable in the wiki) every N pieces.
# 10, not 20: the maintainer reviews WHILE the loop generates (2026-08-13), and
# at ~2.6 min/piece a 20-piece batch left him waiting ~50 minutes for anything
# new to appear. Ten keeps fresh art flowing without a deploy per sprite; the
# deploy workflow's concurrency group collapses rapid pushes anyway.
PUSH_EVERY = 10


def run_piece(client, cfg, group, spec, push=True):
    """Generate ONE piece end-to-end. Returns the piece id (or raises)."""
    tag = (cfg.get("tag") or "SCENERY").upper()
    size = int(spec["size"])
    desc = f"{spec['prompt']}, {cfg['style_base']}"
    print(f"piece: {group['id']}/{spec['id']} ({size}px, {spec['lights']})")

    if size <= 168:
        oid = client.create_object(desc, size=size,
                                   view=cfg.get("view", "low top-down"))
        pixellab_directions = 8
    else:
        resp = client.create_1d_batch(desc, size)   # single candidate, auto-kept
        oid = resp.get("object_id") or resp.get("id")
        if not oid:
            raise PixelLabError(f"create returned no object_id: {str(resp)[:200]}")
        pixellab_directions = 1

    detail = client.wait_object(oid, want=("completed",))
    client.set_tags(oid, [tag])
    url = (detail.get("rotation_urls") or {}).get("south") or client.sprite_url(detail)
    img = client._download(url) if url else None
    if img is None:
        raise PixelLabError(f"{spec['id']}: no downloadable SOUTH sprite (object {oid})")

    img = factory._normalize(img, size)
    rel = f"{group['id']}/{spec['id']}"
    factory.save_webp(img, f"{factory.piece_dir(rel)}/sprite.webp")
    factory.write_manifest(rel, {
        "format": "scenery-piece@2",
        "id": spec["id"],
        "group": group["id"],
        "rank": group["rank"],
        "index": spec["index"],
        "name": spec["name"],
        "lights": spec["lights"],
        "variety": spec["variety"],
        "glow_concept": spec["glow_concept"],
        "prompt": spec["prompt"],
        "view": cfg.get("view", "low top-down"),
        "direction": "south",
        "size": size,
        "sprite": f"{rel}/sprite.webp",
        "placement": factory.placement(cfg, spec["world_height_m"]),
        "pixellab_object_id": oid,
        "pixellab_directions": pixellab_directions,
        "tags": [tag],
        "status": "complete",
        "animations": {},
        "source": ("pixellab.ai create-8-direction-object (SOUTH kept, S-only domain)"
                   if pixellab_directions == 8 else
                   "pixellab.ai create-1-direction-object (single, S-only)"),
    })

    viewer_build.build()
    coordination.publish(
        current=f"generated {rel}",
        progress=catalog.progress(cfg, factory.done_by_group()),
        budget_remaining=budget_state(client)["generations"])
    commit_push(f"scenery: {group['id']} +1 ({spec['id']}, "
                f"{'lit' if spec['lights'] == 'LIGHTS_ON' else 'unlit'})", push=push)
    return spec["id"]


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Run the scenery factory loop (v2).")
    ap.add_argument("--max-pieces", type=int, default=None,
                    help="Stop after this many pieces (default: config budget.daily_pieces).")
    ap.add_argument("--max-batches", type=int, default=0, help="0 = unlimited")
    ap.add_argument("--max-minutes", type=float, default=0, help="0 = unlimited")
    ap.add_argument("--once", action="store_true", help="One batch and exit.")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the next batches without calling PixelLab.")
    ap.add_argument("--no-sync", action="store_true",
                    help="Skip the pre-run repo<->PixelLab reconcile.")
    args = ap.parse_args()

    cfg = factory.load_config()
    max_pieces = args.max_pieces if args.max_pieces is not None \
        else int(cfg.get("budget", {}).get("daily_pieces", 100))

    if args.dry_run:
        done = factory.done_by_group()
        print("progress:", catalog.progress(cfg, done))
        shown = 0
        retired = factory.load_retired()
        while shown < max_pieces:
            nxt = catalog.next_batch(cfg, done, retired)
            if nxt is None:
                print("(catalog complete)")
                break
            group, specs = nxt
            print(f"  next: {group['id']} -> {', '.join(s['id'] for s in specs)}")
            done.setdefault(group["id"], set()).update(s["id"] for s in specs)
            shown += len(specs)
        return

    client = PixelLabClient()

    if not args.no_sync:
        try:
            import sync
            sync.reconcile_light(client, push=not args.no_push, quiet=True)
        except Exception as e:
            print(f"pre-run reconcile skipped ({e})")

    # The maintainer's wiki verdicts are STANDING ORDERS (2026-08-13): every
    # run starts by deleting whatever he rejected (store + repo), and the
    # planner refills those slots with fresh rolls in this very pass.
    try:
        import feedback
        removed = feedback.apply_rejections(client)
        if removed:
            viewer_build.build()
            commit_push(f"scenery: remove {len(removed)} rejected piece(s) "
                        f"(wiki verdicts)", push=not args.no_push)
    except Exception as e:
        print(f"! wiki-feedback cleanup failed ({e}) — continuing to generation")

    peers = coordination.read_peers()
    print("peers:", coordination.peer_summary(peers))
    for dom, s in peers.items():
        for req in s.get("requests", []) or []:
            # Boards vary: requests are dicts ({to, text, at}) on most, bare
            # strings on some — read both, never crash on a peer's format.
            if isinstance(req, dict) and req.get("to") == coordination.DOMAIN:
                print(f"  » request from {dom}: {str(req.get('text'))[:200]}")

    state = budget_state(client)
    print(f"scenery loop starting — subscription {state['generations']:.0f} generations, "
          f"${state['usd']:.2f} credits")
    coordination.publish(current="startup",
                         progress=catalog.progress(cfg, factory.done_by_group()),
                         budget_remaining=state["generations"], health="running")

    start = time.monotonic()
    pieces = 0
    batches = 0
    # A failed piece is SKIPPED for the rest of this run, never fatal: PixelLab
    # jobs fail flakily (measured 2026-08-13: a content-policy false positive on
    # an innocent moss-mound prompt, $0.00 charged, killed a 330-minute window
    # after 59 pieces under the old run-fatal rule). The skipped piece simply
    # retries on the NEXT run — nothing was written, so the deterministic
    # planner offers it again. Only a STREAK of failures (a real outage, an
    # exhausted account) stops the run.
    skipped: dict[str, set] = {}
    consec_fail = 0
    MAX_CONSEC_FAIL = 5
    stop_reason = "nothing left to generate"
    while True:
        state = budget_state(client)
        if not can_spend(cfg, state):
            stop_reason = (f"budget floor (subscription {state['generations']:.0f} gens, "
                           f"${state['usd']:.2f})")
            break
        done = factory.done_by_group()
        for gid, ids in skipped.items():
            done.setdefault(gid, set()).update(ids)
        retired = factory.load_retired()
        nxt = catalog.next_batch(cfg, done, retired)
        if nxt is None:
            stop_reason = "catalog complete" if not skipped else                 f"catalog complete except {sum(len(v) for v in skipped.values())} skipped piece(s)"
            break
        group, specs = nxt
        room = max_pieces - pieces
        if room <= 0:
            stop_reason = f"piece cap ({max_pieces})"
            break
        specs = specs[:room]
        try:
            push_now = (not args.no_push) and ((pieces + 1) % PUSH_EVERY == 0)
            run_piece(client, cfg, group, specs[0], push=push_now)
            consec_fail = 0
        except PixelLabError as e:
            consec_fail += 1
            skipped.setdefault(group["id"], set()).add(specs[0]["id"])
            print(f"  ! piece {group['id']}/{specs[0]['id']} failed "
                  f"({consec_fail} in a row) — skipped for this run, retries next run: "
                  f"{str(e)[:160]}")
            if consec_fail >= MAX_CONSEC_FAIL:
                stop_reason = (f"{MAX_CONSEC_FAIL} consecutive failures — likely an "
                               f"outage; last: {str(e)[:100]}")
                break
            continue
        pieces += 1
        batches += 1
        print(f"  = {pieces} piece(s) this run")
        if args.once or (args.max_batches and batches >= args.max_batches):
            stop_reason = "batch cap"
            break
        if args.max_minutes and (time.monotonic() - start) / 60 >= args.max_minutes:
            stop_reason = "time budget"
            break

    state = budget_state(client)
    health = "idle" if can_spend(cfg, state) or stop_reason == "catalog complete" \
        else "stopped"
    coordination.publish(current=f"idle after {pieces} piece(s) — {stop_reason}",
                         progress=catalog.progress(cfg, factory.done_by_group()),
                         budget_remaining=state["generations"], health=health)
    commit_push(f"scenery heartbeat: {health} ({pieces} piece(s), {stop_reason})",
                push=not args.no_push)
    print(f"done — {pieces} piece(s) in {batches} batch(es); stopped: {stop_reason}")


if __name__ == "__main__":
    main()
