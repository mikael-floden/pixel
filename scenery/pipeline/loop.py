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
import os
import shutil
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
    _git("add", "--", "../wiki/first_seen.json", check=False)
    status = _git("status", "--porcelain", "--", ".",
                  "../coordination/scenery.json", "../wiki/first_seen.json").stdout.strip()
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


def push_only():
    """Push whatever is already committed (rebase-and-retry backoff)."""
    branch = _current_branch()
    for attempt in range(4):
        r = _git("push", "-u", "origin", branch, check=False)
        if r.returncode == 0:
            return True
        _git("fetch", "origin", branch, check=False)
        _git("rebase", f"origin/{branch}", check=False)
        time.sleep(2 ** (attempt + 1))
    print("  ! push failed after retries:", r.stderr[:200])
    return False


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

# COMMIT every piece; PUSH in small batches, on a short timer.
#
# The maintainer reviews live, so art must not sit unpushed — but push-per-
# piece was actively harmful: nangijala-deploy's concurrency group is keyed by
# github.sha, so it collapses NOTHING (my earlier note here was wrong). Every
# push ran its own full Docker build to completion; at 3 pieces/min that is
# ~180 concurrent image builds an hour, and an older build finishing last can
# briefly regress the live site.
#
# His rule (2026-08-13), raised to ten after seeing the deploy load — "batch 10
# scenery objects/push. This will make the builder more sane": flush when 10
# pieces are pending OR PUSH_MAX_WAIT_S has passed, whichever comes first. At
# ~3 pieces/min a full batch takes ~3.5 minutes, so the timer only fires when
# generation itself is slow (end of a run, a burst of failures) — art never
# sits, and the builder runs roughly one deploy at a time instead of nine. The
# per-piece COMMIT is unconditional, so a killed runner can lose at most the
# pushes, never the work.
STOP_FILE = os.path.join(factory.ROOT, ".stop")   # see the drain gate below
PUSH_EVERY = 1          # legacy serial path (--once) pushes immediately
PUSH_BATCH = 10         # pieces per push in the parallel pipeline
PUSH_MAX_WAIT_S = 240   # ...or this long, whichever comes first


def submit_piece(client, cfg, group, spec):
    """Queue ONE piece's PixelLab job; return (object_id, directions). The
    parallel loop keeps several of these in flight — PixelLab generates
    concurrently, so the loop must never wait on one job before submitting
    the next (maintainer: "you are the bottleneck", 2026-08-13)."""
    size = int(spec["size"])
    desc = f"{spec['prompt']}, {cfg['style_base']}"
    # The 1-direction endpoint 422s on long descriptions (measured 2026-08-14:
    # accumulated rules reached 2010 chars and killed a whole test batch). Trim
    # the piece-specific tail rather than the style laws, which must survive.
    LIMIT = 1000
    if len(desc) > LIMIT:
        # Trim the BODY (description/variety/modifier) and keep the tail. The
        # first version cut the raw tail off `prompt`, which is precisely where
        # the scale anchor and the LIGHTS_ON/OFF clause live — so every long
        # prompt silently shipped with no size cue and no lights promise. That
        # is how cliff_roots came out as a hero mega-root instead of the small
        # detail it is configured to be (maintainer 2026-08-14: "I'm thinking
        # small subtile detail at the mountain wall. Not a huge mega tree
        # root."). Style laws and tail both survive; only the body gives way.
        tail = spec.get("prompt_tail") or ""
        keep = LIMIT - len(cfg["style_base"]) - len(tail) - 2
        body = spec.get("prompt_body") or spec["prompt"]
        desc = f"{body[:max(0, keep)].rstrip(' ,;—-')}{tail}, {cfg['style_base']}"
        print(f"  ~ prompt trimmed to {len(desc)} chars for {spec['id']}")
    if size <= 168:
        return client.submit_object(desc, size=size,
                                    view=cfg.get("view", "low top-down")), 8
    resp = client.create_1d_batch(desc, size)       # single candidate, auto-kept
    oid = resp.get("object_id") or resp.get("id")
    if not oid:
        raise PixelLabError(f"create returned no object_id: {str(resp)[:200]}")
    return oid, 1


def run_piece(client, cfg, group, spec, push=True):
    """Generate ONE piece end-to-end (serial path: --once). Returns piece id."""
    print(f"piece: {group['id']}/{spec['id']} ({int(spec['size'])}px, {spec['lights']})")
    oid, pixellab_directions = submit_piece(client, cfg, group, spec)
    detail = client.wait_object(oid, want=("completed",))
    return finalize_piece(client, cfg, group, spec, oid, pixellab_directions,
                          detail, push=push)


def finalize_piece(client, cfg, group, spec, oid, pixellab_directions, detail,
                   push=True):
    """Tag, download SOUTH, save, manifest, viewer, heartbeat, commit+push."""
    tag = (cfg.get("tag") or "SCENERY").upper()
    size = int(spec["size"])
    client.set_tags(oid, [tag])
    url = (detail.get("rotation_urls") or {}).get("south") or client.sprite_url(detail)
    img = client._download(url) if url else None
    if img is None:
        raise PixelLabError(f"{spec['id']}: no downloadable SOUTH sprite (object {oid})")

    # THE GATE: art the model drew small and upscaled never reaches his queue.
    ones = factory.single_pixel_fraction(img)
    gate_min = factory.pixel_grid_min(size)
    if ones is not None and ones < gate_min:
        try:
            client.delete_object(oid)
        except Exception:
            pass
        print(f"  x GATE {group['id']}/{spec['id']}: pixels too big "
              f"(single-px {ones:.3f} < {gate_min} at {size}px) — re-rolling")
        raise PixelLabError(
            f"GATE {spec['id']}: PIXEL GRID FAIL (single-pixel fraction "
            f"{ones:.3f} < {gate_min} at {size}px) — upscaled art, not saved")

    # THE EDGE GATE: art the frame cuts off never reaches his queue either.
    bleed = factory.edge_bleed(img)
    if bleed > factory.EDGE_BLEED_MAX:
        try:
            client.delete_object(oid)
        except Exception:
            pass
        print(f"  x GATE {group['id']}/{spec['id']}: cropped at the canvas edge "
              f"({bleed:.0%} of a border is art) — re-rolling")
        raise PixelLabError(
            f"GATE {spec['id']}: EDGE CROP ({bleed:.0%} of a border is opaque, "
            f"max {factory.EDGE_BLEED_MAX:.0%}) — cut-off art, not saved")

    img = factory._normalize(img, size)
    rel = f"{group['id']}/{spec['id']}"
    factory.save_webp(img, f"{factory.piece_dir(rel)}/sprite.webp")

    # MULTI-DIRECTION GROUPS. The domain is SOUTH-only because scenery never
    # rotates, but a window is mounted on a WALL and the game has walls facing
    # three ways: "I want you to generate the window with SE, S and SW. We will
    # need all 3 directions in the game" (maintainer 2026-08-14). The <=168px
    # path already generates a real 8-direction object and throws seven
    # rotations away, so the extra facings cost NOTHING — same one generation.
    # Every kept facing gets placed, so every kept facing must pass the edge
    # gate; the pixel-grid gate already ran on SOUTH, which is representative.
    rotations = {}
    keep = [d for d in (group.get("keep_directions") or []) if d != "south"]
    if keep and pixellab_directions == 8:
        have = client.download_object_rotations(oid)
        missing = [d for d in keep if d not in have]
        if missing:
            raise PixelLabError(
                f"{spec['id']}: object {oid} is missing rotation(s) {missing}")
        for d in keep:
            rot = have[d]
            rbleed = factory.edge_bleed(rot)
            if rbleed > factory.EDGE_BLEED_MAX:
                try:
                    client.delete_object(oid)
                except Exception:
                    pass
                shutil.rmtree(factory.piece_dir(rel), ignore_errors=True)
                print(f"  x GATE {group['id']}/{spec['id']}: {d} facing cropped "
                      f"({rbleed:.0%} of a border is art) — re-rolling")
                raise PixelLabError(
                    f"GATE {spec['id']}: EDGE CROP on {d} ({rbleed:.0%} of a "
                    f"border is opaque, max {factory.EDGE_BLEED_MAX:.0%})")
            factory.save_webp(factory._normalize(rot, size),
                              f"{factory.piece_dir(rel)}/rotations/{d}.webp")
            rotations[d] = f"{rel}/rotations/{d}.webp"
        rotations["south"] = f"{rel}/sprite.webp"

    from datetime import datetime, timezone
    factory.write_manifest(rel, {
        "format": "scenery-piece@2",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "id": spec["id"],
        "group": group["id"],
        "rank": group["rank"],
        "index": spec["index"],
        "name": spec["name"],
        "lights": spec["lights"],
        "variety": spec["variety"],
        "modifier": spec.get("modifier"),
        "glow_concept": spec["glow_concept"],
        "prompt": spec["prompt"],
        "view": cfg.get("view", "low top-down"),
        "direction": "south",
        # `sprite` stays SOUTH so every existing consumer keeps working; a
        # multi-direction piece additionally publishes `rotations`.
        "directions": sorted(rotations) if rotations else ["south"],
        "rotations": rotations or None,
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

    factory.record_first_seen(rel)
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
    ap.add_argument("--parallel", type=int, default=0,
                    help="PixelLab jobs in flight at once (default: config "
                         "budget.parallel_jobs, 8).")
    ap.add_argument("--plan", default=None,
                    help="Explicit allocation 'group:count,group:count' — the "
                         "run generates exactly this mix (star-weighted runs), "
                         "bypassing quota fairness. Fresh ids + retirement "
                         "still apply.")
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
        # His "we have enough of these" notes are quota law — apply before
        # planning so a saturated group never takes another slot.
        sat = feedback.saturated_groups()
        if sat:
            done_now = factory.done_by_group()
            changed = []
            for gid, notes in sat.items():
                grp = next((x for x in cfg["groups"] if x["id"] == gid), None)
                if grp is None:
                    continue
                have = len(done_now.get(gid, set()))
                if grp.get("quota") != have:
                    grp["quota"] = have
                    grp["_saturated"] = (f"maintainer said enough ({len(notes)} note(s)) "
                                         f"— frozen at {have}")
                    changed.append(gid)
            if changed:
                import json as _json
                with open(factory.CONFIG, "w") as f:
                    _json.dump(cfg, f, indent=2, ensure_ascii=False)
                    f.write("\n")
                print(f"  saturation: froze {len(changed)} group(s): {', '.join(changed)}")
            # ...and PURGE their unreviewed pieces. A freeze that leaves
            # already-generated pieces in his queue makes him hand-reject the
            # very type he just declared full — his "you keep generating the
            # same shit on me" (2026-08-14) was exactly this backlog, not new
            # generation. Anything he has already judged is untouched.
            import feedback as _fb
            judged = set(_fb.load_entries())
            frozen_ids = {x["id"] for x in cfg["groups"]
                          if x.get("_saturated") or x.get("_throttled") or x.get("_retired")}
            purge = [rel for rel, _m in factory.discover()
                     if "/" in rel and rel.split("/")[0] in frozen_ids
                     and f"scenery/{rel}" not in judged]
            if purge:
                import pixel_qa as _qa
                _qa.condemn(client, purge)
                print(f"  queue purge: removed {len(purge)} unreviewed piece(s) "
                      f"from frozen groups so they never reach his review queue")
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
    # THE PARALLEL PIPELINE (maintainer, 2026-08-13: "don't wait for one object
    # until you ask PixelLab to generate more... You are the bottleneck").
    # PixelLab generates jobs concurrently, so the loop keeps up to
    # budget.parallel_jobs creates in flight at once and finalizes each the
    # moment it completes — submit, poll, finalize, push, forever. Serial
    # completion order is NOT preserved (nor needed: every piece is
    # independent and ids are assigned at submit time).
    #
    # A failed piece is SKIPPED for this run, never fatal: PixelLab fails
    # flakily (measured: a content-filter false positive on an innocent
    # moss-mound prompt once killed a 330-minute window). The planner offers
    # the slot again next run. Only a STREAK of failures with no successes
    # in between (a real outage) stops the run.
    skipped: dict[str, set] = {}
    consec_fail = 0
    MAX_CONSEC_FAIL = 6
    PARALLEL = max(1, int(args.parallel or cfg.get("budget", {}).get("parallel_jobs", 8)))
    if args.once:
        PARALLEL = 1
    POLL_S = 5
    in_flight = []        # [{spec, group, oid, dirs, at}]
    plan_alloc = None
    if args.plan:
        plan_alloc = {}
        for part in args.plan.split(","):
            gid, n = part.split(":")
            plan_alloc[gid.strip()] = int(n)
        print(f"star plan: {sum(plan_alloc.values())} pieces across "
              f"{len(plan_alloc)} groups")
    submitted = 0
    pending_push = 0
    last_push = time.monotonic()
    stop_reason = "nothing left to generate"
    stop_submitting = None
    last_budget = 0.0
    print(f"parallel pipeline: up to {PARALLEL} PixelLab jobs in flight")
    while True:
        # --- budget gate (rechecked at most every 60s, not per cycle) -------
        if stop_submitting is None and time.monotonic() - last_budget > 60:
            last_budget = time.monotonic()
            state = budget_state(client)
            if not can_spend(cfg, state):
                stop_submitting = (f"budget floor (subscription "
                                   f"{state['generations']:.0f} gens, ${state['usd']:.2f})")
        # --- time / cap gates ----------------------------------------------
        if stop_submitting is None and args.max_minutes \
                and (time.monotonic() - start) / 60 >= args.max_minutes:
            stop_submitting = "time budget"
        if stop_submitting is None and submitted >= max_pieces:
            stop_submitting = f"piece cap ({max_pieces})"
        # GRACEFUL DRAIN: `touch scenery/.stop` and the loop stops submitting
        # but still finishes every job already in flight, so a pause costs no
        # paid-for art and leaves no untagged orphans in the PixelLab store
        # (maintainer 2026-08-14: "You can pause the generation when the ones
        # already generating has completed"). SIGTERM cannot do this — it drops
        # the in-flight jobs on the floor.
        if stop_submitting is None and os.path.exists(STOP_FILE):
            stop_submitting = "stop file (scenery/.stop) — draining in flight"
        # THE GOAL (maintainer 2026-08-14): stop at 1000 live pieces, full stop.
        goal = int((cfg.get("goal") or {}).get("target_pieces") or 0)
        if stop_submitting is None and goal:
            live = sum(len(v) for v in factory.done_by_group().values())
            if live + len(in_flight) >= goal:
                stop_submitting = f"GOAL REACHED — {live} live pieces of {goal}"
        # --- keep the pipeline full ----------------------------------------
        while stop_submitting is None and len(in_flight) < PARALLEL \
                and submitted < max_pieces:
            done = factory.done_by_group()
            for gid, ids in skipped.items():
                done.setdefault(gid, set()).update(ids)
            for f in in_flight:
                done.setdefault(f["group"]["id"], set()).add(f["spec"]["id"])
            if plan_alloc is not None:
                # star-weighted mode: next group = largest remaining allocation
                # (deterministic tie-break by name); indices via the normal
                # fresh-id machinery, retirement honored, quota bypassed.
                live = [(n, gid) for gid, n in plan_alloc.items() if n > 0]
                if not live:
                    stop_submitting = "plan complete"
                    break
                _, gid = max(live, key=lambda t: (t[0], t[1]))
                group = next(x for x in cfg["groups"] if x["id"] == gid)
                idxs = catalog.next_indices(
                    group, done.get(gid, set()),
                    factory.load_retired().get(gid, set()), 1)
                if not idxs:
                    plan_alloc[gid] = 0
                    continue
                spec = catalog.piece_spec(cfg, group, idxs[0])
                plan_alloc[gid] -= 1
            else:
                nxt = catalog.next_batch(cfg, done, factory.load_retired())
                if nxt is None:
                    stop_submitting = "catalog complete"
                    break
                group, specs = nxt
                spec = specs[0]
            try:
                oid, dirs = submit_piece(client, cfg, group, spec)
            except PixelLabError as e:
                consec_fail += 1
                skipped.setdefault(group["id"], set()).add(spec["id"])
                print(f"  ! submit {group['id']}/{spec['id']} failed "
                      f"({consec_fail} since last success): {str(e)[:140]}")
                if consec_fail >= MAX_CONSEC_FAIL:
                    stop_submitting = f"{MAX_CONSEC_FAIL} failures in a row on submit"
                break
            submitted += 1
            in_flight.append({"spec": spec, "group": group, "oid": oid,
                              "dirs": dirs, "at": time.monotonic()})
            print(f"» {group['id']}/{spec['id']} submitted "
                  f"({len(in_flight)} in flight, {submitted} total)")
        # --- drain: poll everything in flight ------------------------------
        still = []
        for f in in_flight:
            try:
                o = client.get_object(f["oid"])
                st = o.get("status")
            except PixelLabError as e:
                st = None
                o = {}
                if time.monotonic() - f["at"] > 1500:
                    st = "failed"
            if st == "completed":
                try:
                    finalize_piece(client, cfg, f["group"], f["spec"], f["oid"],
                                   f["dirs"], o, push=False)   # commit now, push in batches
                    pieces += 1
                    batches += 1
                    pending_push += 1
                    consec_fail = 0
                    mins = (time.monotonic() - start) / 60
                    print(f"  = {pieces} done in {mins:.1f} min "
                          f"({pieces / mins if mins else 0:.1f}/min)")
                except PixelLabError as e:
                    # A gate rejection is the system WORKING: the piece was
                    # upscaled and died as designed. Only real errors (network,
                    # API, missing sprite) count toward the outage breaker —
                    # otherwise a strict gate stalls the run it is protecting
                    # (measured 2026-08-14: six gate kills in a row ended a
                    # 110-piece pass after three deliveries).
                    if not str(e).startswith("GATE "):
                        consec_fail += 1
                        print(f"  ! finalize {f['group']['id']}/{f['spec']['id']} "
                              f"failed: {str(e)[:140]}")
                    skipped.setdefault(f["group"]["id"], set()).add(f["spec"]["id"])
            elif st == "failed" or (time.monotonic() - f["at"]) > 1500:
                consec_fail += 1
                skipped.setdefault(f["group"]["id"], set()).add(f["spec"]["id"])
                print(f"  ! {f['group']['id']}/{f['spec']['id']} "
                      f"{'failed' if st == 'failed' else 'timed out'} "
                      f"({consec_fail} since last success)")
            else:
                still.append(f)
        in_flight = still
        # flush: 5 pieces pending, or too long since the last push
        if pending_push and not args.no_push \
                and (pending_push >= PUSH_BATCH
                     or time.monotonic() - last_push >= PUSH_MAX_WAIT_S):
            push_only()
            print(f"  ^ pushed {pending_push} piece(s)")
            pending_push = 0
            last_push = time.monotonic()
        if consec_fail >= MAX_CONSEC_FAIL and stop_submitting is None:
            stop_submitting = (f"{MAX_CONSEC_FAIL} failures with no success between "
                               f"— likely an outage")
        # --- exit when the pipeline is empty and nothing more may enter ----
        if stop_submitting is not None and not in_flight:
            stop_reason = stop_submitting
            break
        if args.once and pieces >= 1:
            stop_reason = "batch cap"
            break
        if args.max_batches and batches >= args.max_batches:
            stop_reason = "batch cap"
            break
        time.sleep(POLL_S)

    if pending_push and not args.no_push:
        push_only()
        print(f"  ^ pushed final {pending_push} piece(s)")
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
