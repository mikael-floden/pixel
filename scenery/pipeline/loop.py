"""The scenery loop (v2): batched, S-only, tag-stamped, fully resumable.

One BATCH = one create-1-direction-object call carrying up to `max_batch`
per-piece prompts (`item_descriptions`) on one canvas — the API yields multiple
candidate objects per call at small sizes (<=42px -> 64, <=85 -> 16,
<=170 -> 4, else 1), which is what makes a 2,650-piece catalog affordable
(~2-8 generations per piece instead of 20-40). select-frames turns every
candidate into its own completed PixelLab object and tags them all
`SCENERY` in the same call.

The plan is deterministic (catalog.py): the filesystem alone decides what is
next, so the loop can stop anywhere — mid-day, mid-batch, out of budget — and
the next run continues exactly where it left off.

Run a bounded chunk (intended for the daily schedule / GitHub Action):
  python scenery/pipeline/loop.py --max-pieces 100 --max-minutes 300
Other flags: --max-batches N, --once (one batch), --no-push, --dry-run,
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


# --- one batch --------------------------------------------------------------

def _extract_created(resp):
    """The objects created by select-frames, in candidate-index order.
    Tolerant of shape: a list, {objects: [...]}, {object_ids: [...]},
    {created: [...]} — entries either ids or {id: ...} records."""
    if resp is None:
        return []
    raw = resp
    if isinstance(resp, dict):
        for key in ("created_object_ids", "objects", "created_objects", "object_ids",
                    "created", "ids"):
            if isinstance(resp.get(key), list):
                raw = resp[key]
                break
        else:
            raw = []
    out = []
    for entry in raw:
        if isinstance(entry, str):
            out.append(entry)
        elif isinstance(entry, dict) and entry.get("id"):
            out.append(entry["id"])
    return out


def run_batch(client, cfg, group, specs, push=True):
    """Execute one batch end-to-end. Returns the piece ids written."""
    tag = (cfg.get("tag") or "SCENERY").upper()
    size = int(group["art_size"])
    desc = catalog.full_description(cfg, group)
    prompts = [s["prompt"] for s in specs]
    label = f"{group['id']} {specs[0]['id']}..{specs[-1]['id']}"
    print(f"batch: {label} ({len(specs)} piece(s) @ {size}px)")

    resp = client.create_1d_batch(desc, size, item_descriptions=prompts)
    parent_id = resp.get("object_id") or resp.get("id")
    if not parent_id:
        raise PixelLabError(f"create returned no object_id: {str(resp)[:200]}")
    parent = client.wait_object(parent_id)

    if parent.get("status") == "review":
        sel = client.select_frames(parent_id, list(range(len(specs))), common_tag=tag)
        created = _extract_created(sel)
        if len(created) != len(specs):
            raise PixelLabError(
                f"select-frames created {len(created)} object(s) for {len(specs)} "
                f"candidate(s) — refusing to guess the mapping. Raw: {str(sel)[:400]}")
        pairs = list(zip(specs, created))
    else:
        # Single-candidate path: the parent IS the piece.
        if len(specs) != 1:
            raise PixelLabError(
                f"expected review status for a {len(specs)}-piece batch, got "
                f"'{parent.get('status')}'")
        client.set_tags(parent_id, [tag])
        pairs = [(specs[0], parent_id)]

    written = []
    for spec, oid in pairs:
        detail = client.wait_object(oid, want=("completed",))
        url = client.sprite_url(detail)
        img = client._download(url) if url else None
        if img is None:
            print(f"  ! {spec['id']}: no downloadable sprite (object {oid}) — skipped, "
                  f"will be re-planned")
            continue
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
            "view": cfg.get("view", "top-down"),
            "direction": "south",
            "size": size,
            "sprite": f"{rel}/sprite.webp",
            "placement": factory.placement(cfg, spec["world_height_m"]),
            "pixellab_object_id": oid,
            "tags": [tag],
            "status": "complete",
            "animations": {},
            "source": "pixellab.ai create-1-direction-object (batched, S-only)",
        })
        written.append(spec["id"])

    if written:
        viewer_build.build()
        done = factory.done_by_group()
        coordination.publish(
            current=f"generated {label}",
            progress=catalog.progress(cfg, done),
            budget_remaining=budget_state(client)["generations"])
        lit = sum(1 for s in specs if s["id"] in written and s["lights"] == "LIGHTS_ON")
        commit_push(f"scenery: {group['id']} +{len(written)} "
                    f"({written[0]}..{written[-1]}, {lit} lit)", push=push)
    return written


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
        while shown < max_pieces:
            nxt = catalog.next_batch(cfg, done)
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
    stop_reason = "nothing left to generate"
    while True:
        state = budget_state(client)
        if not can_spend(cfg, state):
            stop_reason = (f"budget floor (subscription {state['generations']:.0f} gens, "
                           f"${state['usd']:.2f})")
            break
        nxt = catalog.next_batch(cfg, factory.done_by_group())
        if nxt is None:
            stop_reason = "catalog complete"
            break
        group, specs = nxt
        room = max_pieces - pieces
        if room <= 0:
            stop_reason = f"piece cap ({max_pieces})"
            break
        specs = specs[:room]
        try:
            written = run_batch(client, cfg, group, specs, push=not args.no_push)
        except PixelLabError as e:
            print(f"  ! batch failed: {e}")
            stop_reason = f"batch error: {str(e)[:120]}"
            break
        pieces += len(written)
        batches += 1
        print(f"  = {pieces} piece(s) in {batches} batch(es) this run")
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
