#!/usr/bin/env python3
"""REDO AN ANIMATION ON THE FACINGS HE MARKED — his review IS the work list.

Maintainer 2026-09-15: "I did a review on Hearth objects, but don't want to write
to you on every object where SE or SW doesn't have any animation (it shows as if
the animation only have 1 frame). I also want you to redo some animations where
the entire Hearth was moving and not only the fire."

TWO FAULTS, ONE OPERATION. Either a state ships south-east and south-west stills
while its animation covers `south` alone — the game then draws the still on those
facings, which is exactly "as if the animation only has one frame" — or the clip
is there and the whole piece moves instead of the fire. Both are "generate this
animation for these directions", which is the single call PixelLab has: extend
the EXISTING animation group with the directions wanted and download the group
back whole. Never post a second animation (flame_facings.py, 2026-08-28: it
leaves a piece with two whose wording drifts apart).

HIS REVIEW IS THE INPUT, so he never has to list them. `--from-feedback` reads
live/feedback/objects.json for `status: "redo"` entries keyed
<piece>#<state>#<direction> and does those exact directions; `--missing` does the
whole class, which is 332 state-clips across 51 groups today.

THE PROMPT IS THE ONLY LEVER ON HOW MUCH MOVES. animate_object has no motion
strength — `animation_description` is the whole instrument. His note decides the
wording, and the rule from the window prompts holds: never name the things that
must stay still ("the stone", "the woodgrain") or the model starts painting them
(maintainer 2026-08-14). "Animate the flame only. Nothing else moves." is the
whole of it.

    python3 pipeline/redo_facing_anim.py --from-feedback --dry-run
    python3 pipeline/redo_facing_anim.py --from-feedback
    python3 pipeline/redo_facing_anim.py --missing --dry-run
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import threading
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory                                        # noqa: E402
import viewer_build                                   # noqa: E402
import finish_clips                                   # noqa: E402
import animate_trees as A                             # noqa: E402
from pixellab_client import PixelLabClient, PixelLabError, V2_BASE  # noqa: E402

FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback", "objects.json")
ALL3 = ("south-west", "south", "south-east")
EIGHT_DIR_MAX = 168          # over this a piece is 1-direction: no facings exist
FRAME_COUNT = 4              # + keep_first_frame = 5 frames, 3 generations
USD_PER_GEN = 0.012
PARALLEL = 4  # 8 in parallel got 5-retry API failures on 28 of 40
_LOCKS = defaultdict(threading.Lock)

# A note that asks for LESS MOVEMENT, not for more frames. His own words on the
# hearths: "Less motion on non fire", "Less extreme franes".
LESS_MOTION = re.compile(
    r"less\s+(motion|extreme)|only\s+(\w+\s+)?(fire|light|flame)|not\s+only\s+the\s+fire"
    r"|too?\s+much\s+(movement|motion|colou?r)|doesn'?t\s+glow|too?\s+shiny", re.I)
# His 2026-09-18 notes, verbatim, that the old pattern read as a plain extend:
# "Only light should change!", "To much movement that is not the fire",
# "To much color change! This flower doesn't glow!", "To Shiny". Every one is
# a brief for LESS, and an extend would have carried the wording he rejected.
# ...and one that says the facing has no clip at all.
NO_CLIP = re.compile(r"not enough frames|only one|one frame|no animation", re.I)
# THE WORDING THAT MEASURES 0.0, not the one that sounds like it should work.
# "Animate the flame only" is what these clips already carried and what he
# rejected; "Animate the flame only. Nothing else moves." took four hearths from
# rejected to 0.0029-0.1262 — three of them only just under his 0.10 line and one
# still over it. The long brief below is the domain's own motion wording (the one
# on hearth_001 LIT_3, which scored 0.0 on the same measure): it never names a
# material that must hold still — his rule, naming them makes the model paint
# them — and instead says EVERYTHING else is copied pixel for pixel.
FLAME_BRIEF = (
    "This is the same picture in every frame. ONLY the flame flickers. It is lit and clearly "
    "visible in every frame, including the first. It stays exactly the same size and shape in "
    "every frame: it never grows and never spreads, only its inner detail shifts. Nothing is "
    "added or removed anywhere: every object appears in every frame, the same number of them, in "
    "the same places, at the same size. Everything else is copied from the first frame exactly, "
    "pixel for pixel: same shape, size, position and colour, no outline redrawn. The last frame "
    "matches the first exactly.")
STILL_PROMPT = {"flame": FLAME_BRIEF, "motion": FLAME_BRIEF, "wind": FLAME_BRIEF}


def _clip(man, state, name):
    return (((man.get("states") or {}).get(state) or {}).get("animations") or {}).get(name)


def _have_dirs(a):
    """The directions this clip actually has frames for. The old shape stored a
    south-only clip as a LIST of names with the frames at the animation root;
    the current one is {direction: {frames, frame_paths}}."""
    d = (a or {}).get("directions")
    if isinstance(d, dict):
        # ONE FRAME IS NOT A CLIP. The wiki draws the still for such a facing
        # and he reads it as "an animation with only 1 frame" (2026-09-18).
        return {k for k, v in d.items() if (v or {}).get("frames", 0) >= 2}
    if isinstance(d, list):
        return set(d)
    return set()


SUBJECT_RE = re.compile(r"\bONLY\b[^.]*\.", re.I)


# A SECOND PASS MUST ASK DIFFERENTLY. The endpoint takes no seed (422
# extra_forbidden, probed 2026-09-18) and the same description returns the
# same frames: pass 2 of the facing sweep "redid" 81 clips and changed zero
# bytes ($1.46 for 81 clips where pass 1 cost $8 for 325), and barrel_007
# measured an identical 0.8091 on both of its "rounds". So each round has its
# own wording — same subject, different sentence — and a round's brief is the
# template for that round.
STILL_TEMPLATES = (
    FLAME_BRIEF,                                   # round 1: the hearth_001 LIT_3 wording
    ("A completely still picture, identical in every frame, except for one thing. "
     "ONLY the flame flickers. Every other pixel of every frame is the exact pixel of "
     "the first frame: nothing else drifts, breathes, sways, bends, brightens or "
     "darkens, nothing is redrawn, nothing appears or disappears, and no outline "
     "moves by even one pixel. The last frame is the first frame again."),
    ("Five frames of one unchanging picture. The single moving thing: ONLY the flame "
     "flickers, inside its own outline, never larger, never smaller, never elsewhere. "
     "Everything around it is frozen — copied from frame one exactly, pixel for pixel, "
     "the same colours, the same edges, the same shapes, the same positions — and the "
     "final frame equals the first so the loop closes."),
)


def brief_for(a, name, variant=0):
    """The brief for a clip: config/redo_prompts.json if he or I wrote one,
    else the clip's OWN subject — the 'ONLY the ... .' sentence of its
    existing description — set into round `variant`'s template (name no
    material that must hold still; everything else copied from the first
    frame pixel for pixel). A generic flame brief is the last resort: sent to
    a barrel of water, a skull and a bush on 09-15 it measured 0.16-0.81, and
    the same wording with the right subject 0.003."""
    template = STILL_TEMPLATES[variant % len(STILL_TEMPLATES)]
    m = SUBJECT_RE.search((a or {}).get("description") or "")
    if m:
        return template.replace("ONLY the flame flickers.", m.group(0).strip(), 1)
    return template


def _state_key(man, st):
    for k in (man.get("states") or {}):
        if k.lower() == st.lower():
            return k
    return None


def from_feedback():
    """[(rel, state, anim, dirs, prompt, why)] — exactly what he marked redo."""
    if not os.path.exists(FEEDBACK):
        return []
    doc = json.load(open(FEEDBACK, encoding="utf-8"))
    ent = doc.get("entries") or doc.get("overrides") or {}
    want = defaultdict(set)
    notes = {}
    for key, v in ent.items():
        if (v or {}).get("status") != "redo":
            continue
        body = key[len("scenery/"):] if key.startswith("scenery/") else key
        parts = body.split("#")
        if len(parts) != 3:
            continue                       # a piece- or state-level rejection is not this tool's
        rel, st, dirn = parts
        if dirn not in ALL3:
            continue
        man = factory.read_manifest(rel)
        if not man:
            continue
        state = _state_key(man, st)
        if not state:
            continue
        for name in ((man["states"][state].get("animations") or {})):
            want[(rel, state, name)].add(dirn)
            notes[(rel, state, name, dirn)] = (v.get("note") or "")
    out = []
    for (rel, state, name), dirs in sorted(want.items()):
        joined = " | ".join(notes.get((rel, state, name, d), "") for d in sorted(dirs))
        # A note asking for LESS is briefed with the clip's OWN subject (or
        # his per-clip brief), never the generic flame: "This flower doesn't
        # glow!" on an unlit flower stand is a brief about petals, not fire.
        a = _clip(factory.read_manifest(rel) or {}, state, name) or {}
        prompt = (clip_prompts().get(f"{rel}#{state}#{name}") or brief_for(a, name)) if LESS_MOTION.search(joined) else None
        out.append((rel, state, name, sorted(dirs), prompt, joined.strip(" |")))
    return out


def missing():
    """[(rel, state, anim, dirs, None, why)] — every clip short of a facing the
    state actually ships. This is the class his five hearth reports sample."""
    out = []
    for p in sorted(glob.glob(os.path.join(factory.ROOT, "*", "*", "scenery.json"))):
        rel = os.path.relpath(os.path.dirname(p), factory.ROOT)
        man = json.load(open(p, encoding="utf-8"))
        if int(man.get("size") or 64) > EIGHT_DIR_MAX:
            continue                        # 1-direction piece: no facing exists to animate
        for state, e in sorted((man.get("states") or {}).items()):
            ships = {d for d in (e.get("rotations") or {}) if d in ALL3 and d != "south"}
            for name, a in sorted((e.get("animations") or {}).items()):
                if not a.get("group_id") or not e.get("pixellab_object_id"):
                    continue
                gap = sorted(ships - _have_dirs(a))
                if gap:
                    # NOT an extend with the group's carried wording: the new
                    # facing is briefed like a redo, with the clip's own subject
                    # in the wording that holds a piece still, so the second
                    # pass he ordered ("if not, regenerate") is the exception.
                    prompt = clip_prompts().get(f"{rel}#{state}#{name}") or brief_for(a, name)
                    out.append((rel, state, name, gap, prompt, "no clip on that facing"))
    return out


def flagged_bad(variant=0):
    """[(rel, state, anim, dirs, prompt, why)] — every clip THIS DOMAIN already
    calls ANIMATION_PROBABLY_BAD, redone on every facing it has, briefed with
    round `variant`'s wording (a repeat of the last wording returns the last
    frames — see STILL_TEMPLATES).

    His second complaint needs no reporting either: anim_review.py already
    measures exactly it — "as soon as the root moves it looks wrong" — as the
    share of the object's bottom 15% whose silhouette changes, and 298 clips are
    over the 0.10 line today. A clip he marked by hand is one of those; the rest
    are the same fault nobody has walked past yet."""
    out = []
    for p in sorted(glob.glob(os.path.join(factory.ROOT, "*", "*", "scenery.json"))):
        rel = os.path.relpath(os.path.dirname(p), factory.ROOT)
        man = json.load(open(p, encoding="utf-8"))
        for state, e in sorted((man.get("states") or {}).items()):
            for name, a in sorted((e.get("animations") or {}).items()):
                if a.get("review") != "ANIMATION_PROBABLY_BAD":
                    continue
                if not a.get("group_id") or not e.get("pixellab_object_id"):
                    continue
                # EVERY FACING THE STATE SHIPS, not only the ones the clip has:
                # a facing PixelLab dropped (2 of 3 came back) was never asked
                # for again by any later pass, and five stood as stills for a
                # day (2026-09-18, "1 frame is not an animation!").
                ships = {d for d in (e.get("rotations") or {}) if d in ALL3}
                dirs = sorted(_have_dirs(a) | ships | {"south"})
                m = a.get("review_metrics") or {}
                # THE BRIEF MUST NAME THE PIECE'S OWN MOVING THING. The 09-15
                # round sent STILL_PROMPT ("ONLY the flame flickers") to a barrel
                # of water, a skull's eye-light, a bush's leaves and a cairn's
                # ripple — 0.16-0.81 on the outline rule, wording notwithstanding.
                # config/redo_prompts.json carries the per-clip subject; the
                # generic flame brief is the fallback, not the rule.
                prompt = clip_prompts().get(f"{rel}#{state}#{name}") or brief_for(a, name, variant)
                out.append((rel, state, name, dirs, prompt,
                            f"outline {m.get('base_outline', m.get('base'))} of 0.10"))
    return out


def clip_prompts():
    p = os.path.join(factory.ROOT, "config", "redo_prompts.json")
    try:
        with open(p, encoding="utf-8") as f:
            return {k: v for k, v in json.load(f).items() if not k.startswith("_")}
    except (OSError, ValueError):
        return {}


def one(client, rel, state, name, dirs, prompt):
    """Extend/redo `name` on `dirs` and rewrite the clip from what comes back."""
    try:
        man = factory.read_manifest(rel) or {}
        ent = (man.get("states") or {}).get(state) or {}
        a = (ent.get("animations") or {}).get(name) or {}
        oid, gid = ent.get("pixellab_object_id"), a.get("group_id")
        if not oid or not gid:
            return (rel, state, name, 0, "no object/group id")
        size = int(man.get("size") or 64)
        payload = {"animation_group_id": gid, "directions": list(dirs),
                   "frame_count": FRAME_COUNT, "mode": "v3", "keep_first_frame": True}
        # ALWAYS OVERWRITE, because the STORE decides what exists and it knows
        # more than the manifest does. Extending is the only call and it refuses
        # a direction it already has — 409 "directions already exist in group:
        # ['south-east']. Pass replace_existing=true to overwrite." — and the
        # manifest can say a facing is absent while PixelLab still holds it: a
        # partial download had lost the local copy, so the restore asked to ADD
        # what the store already had and was refused. Overwriting a direction
        # that is genuinely new costs nothing, so it is unconditional.
        payload["replace_existing"] = True
        if prompt:
            # Replaces the group's description; without it the API carries the
            # old wording across, which is the wording he rejected.
            payload["animation_description"] = prompt
        r = client._request("POST", f"{V2_BASE}/objects/{oid}/animations", json=payload)
        for j in (r.get("background_job_ids") or []):
            try:
                client.wait_job(j, timeout=900)
            except PixelLabError:
                pass
        want = len(_have_dirs(a) | set(dirs))
        frames = client.download_object_animation(oid, gid, expected=want, wait=600)
        if not frames:
            return (rel, state, name, 0, "no frames came back")
        base = A.anim_dir(rel, state, man, name)
        for old in glob.glob(os.path.join(factory.ROOT, base, "*.webp")):
            os.remove(old)                 # flat south-only frames cannot coexist
        had = set(_have_dirs(a))
        # A PARTIAL DOWNLOAD MUST NEVER DELETE A FACING THAT WORKS. The client
        # accepts whatever has landed when a direction stops arriving (its stall
        # rule, which is right — waiting out 10 minutes for a stuck job costs the
        # whole pass), so a redo can come back with two of three. Rewriting
        # `directions` from that alone is how hearth_900 LIT_1 lost its
        # south-west clip on a re-roll that had gone 5/5/5 the run before. So the
        # old entries survive and only what came back is replaced.
        made = dict((a.get("directions") or {}) if isinstance(a.get("directions"), dict) else {})
        for d, imgs in frames.items():
            imgs = [factory._normalize(im.convert("RGBA"), size) for im in imgs]
            paths = []
            for i, im in enumerate(imgs):
                fp = f"{base}/{d}/{i:02d}.webp"
                factory.save_webp(im, os.path.join(factory.ROOT, fp))
                paths.append(fp)
            made[d] = {"frames": len(paths), "frame_paths": paths}
        with _LOCKS[rel]:
            man = factory.read_manifest(rel) or {}
            states = dict(man.get("states") or {})
            ent = dict(states.get(state) or {})
            anims = dict(ent.get("animations") or {})
            a = dict(anims.get(name) or {})
            a["directions"] = made
            a["frame_count"] = max(v["frames"] for v in made.values())
            a.pop("frame_paths", None)
            a.pop("strip", None)
            if prompt:
                a["description"] = prompt
            # HIS VERDICT IS SPENT ON THE OLD ART. The clip is new, so the
            # classification and his review of it are both about a picture that
            # no longer exists (consume_verdicts.py's hash rule says the same).
            a.pop("review", None)
            a.pop("review_metrics", None)
            a["generated_at"] = A._now()
            anims[name] = a
            ent["animations"] = anims
            states[state] = ent
            man["states"] = states
            factory.write_manifest(rel, man)
        lost = sorted(had - set(made))
        if lost:
            return (rel, state, name, len(made), f"ok but LOST {','.join(lost)} — re-run it")
        short = sorted(d for d in dirs if d not in frames)
        if short:
            return (rel, state, name, len(made), f"ok but {','.join(short)} did not come back")
        return (rel, state, name, len(made), "ok")
    except PixelLabError as e:
        # The status matters: "failed after 5 retries" alone hid that the 33
        # refusals of 2026-09-18 were throttling (a direct POST to one of the
        # "always refused" objects returned 200 a minute later), not the object.
        return (rel, state, name, 0, f"FAILED: {str(e)[:260]}")
    except Exception as e:                  # noqa: BLE001
        return (rel, state, name, 0, f"ERROR: {type(e).__name__}: {str(e)[:220]}")


def main():
    ap = argparse.ArgumentParser(description="Redo scenery animations per facing.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-feedback", action="store_true", help="his redo verdicts")
    src.add_argument("--missing", action="store_true", help="every facing with no clip")
    src.add_argument("--bad", action="store_true", help="every clip classed ANIMATION_PROBABLY_BAD")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--min-usd", type=float, default=2.0)
    ap.add_argument("--only", default=None,
                    help="comma-separated clip ids <group>/<piece>#<STATE>#<anim>; the selector is filtered to these")
    ap.add_argument("--rounds", type=int, default=1,
                    help="after each round, redo again only the clips still over the outline line (maintainer 2026-09-17: "
                         "'give them 2 new rounds if they need it')")
    ap.add_argument("--variant", type=int, default=0,
                    help="which STILL_TEMPLATES wording the first round uses (later rounds advance it); "
                         "a pass that repeats the clip's current wording regenerates nothing")
    args = ap.parse_args()

    def select():
        todo = (from_feedback() if args.from_feedback
                else flagged_bad(args.variant) if args.bad else missing())
        if args.only:
            keep = set(args.only.split(","))
            todo = [t for t in todo if f"{t[0]}#{t[1]}#{t[2]}" in keep]
        if args.limit:
            todo = todo[:args.limit]
        return todo

    todo = select()
    targets = {f"{t[0]}#{t[1]}#{t[2]}" for t in todo}
    gens = sum(len(t[3]) for t in todo) * 3
    print(f"{len(todo)} clip(s), {sum(len(t[3]) for t in todo)} direction(s) "
          f"~{gens} generations x ${USD_PER_GEN} = about ${gens * USD_PER_GEN:.2f}")
    for rel, state, name, dirs, prompt, why in todo[:40]:
        print(f"  {rel:<28} {state:<10} {name:<7} {','.join(dirs):<24} "
              f"{'RE-PROMPT' if prompt else 'extend':<9} {why[:44]}")
    if len(todo) > 40:
        for g, n in Counter(t[0].split('/')[0] for t in todo).most_common(10):
            print(f"    ... {g:<24} {n}")
    if args.dry_run or not todo:
        return 0

    client = PixelLabClient()
    bal = (client.balance().get("credits") or {}).get("usd")
    if bal is not None and bal < args.min_usd:
        print(f"balance ${bal:.2f} under the ${args.min_usd:.2f} floor — stopping")
        return 1
    for rnd in range(1, args.rounds + 1):
        if rnd > 1:
            # A LATER ROUND REDOES ONLY WHAT THE LAST ONE LEFT OVER THE LINE:
            # finish_clips has just re-measured every redone clip, so the
            # PROBABLY_BAD set is current, and only the original targets count.
            # ...AND ASKS IN NEW WORDS: the endpoint has no seed, so the same
            # description returns the same frames (pass 2 of the 09-18 sweep
            # changed zero bytes). Each round advances the template.
            todo = [t for t in flagged_bad(args.variant + rnd - 1) if f"{t[0]}#{t[1]}#{t[2]}" in targets]
            if not todo:
                print(f"\nround {rnd}: nothing left over the line")
                break
            print(f"\nround {rnd}: {len(todo)} clip(s) still over the line — wording variant {(args.variant + rnd - 1) % len(STILL_TEMPLATES)}")
        ok, done = 0, []
        with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
            futs = [pool.submit(one, client, r, s, n, d, p) for r, s, n, d, p, _ in todo]
            for f in as_completed(futs):
                rel, state, name, n, how = f.result()
                ok += how == "ok"
                # ANY FACING THAT LANDED NEEDS FINISHING. A clip that came back
                # 2 of 3 has new frames under its stable names and stale or no
                # strips; skipping it left 3 clips unfinished, the gate red and
                # the second pass unrun (2026-09-18 sweep, 5 of 330).
                if n > 0:
                    done.append(f"{rel}#{state}#{name}")
                print(f"  {'=' if how == 'ok' else '!'} {rel} {state} {name}: {n} direction(s) {how}")
        print(f"\n{ok}/{len(todo)} clip(s) redone")
        # A REDONE CLIP IS NOT PUBLISHED UNTIL IT IS FINISHED. This tool pops
        # frame_paths/strip/review off the clip (they described the old art)
        # and parseAnims drops a clip with neither frames nor strip at the top
        # level: 18 clips — every hearth among them — shipped that way on
        # 2026-09-15 and the hearth in his house went still. finish_clips
        # publishes hashed strips, lifts the fields, stamps the review,
        # recomputes light_frames, re-packs, rebuilds the viewer and runs the
        # gate; a red gate is a failed run.
        if done and not finish_clips.finish(done):
            return 1
    left = [t for t in flagged_bad() if f"{t[0]}#{t[1]}#{t[2]}" in targets]
    print(f"\n{len(targets) - len(left)}/{len(targets)} target clip(s) now under the line; "
          f"{len(left)} still over it")
    for rel, state, name, _, _, why in left:
        print(f"  still over: {rel} {state} {name} — {why}")
    viewer_build.build()
    return 0


if __name__ == "__main__":
    sys.exit(main())
