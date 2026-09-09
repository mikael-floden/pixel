"""Apply the light-kind corrections he makes in the wiki, then clear them.

Him, 2026-09-08, to the wiki agent: "The Scenery have added light metadata that
explains what kind of light this is when LIT. I want to be able to see this and
edit/change this when doing a review."

WHY HIS EYE OUTRANKS MINE HERE. I classified all 500 lit pieces by looking at
the art, and the hard cases are genuinely hard: brazier_010's white plume is
smoke off spent coals, not a flame; torch_post_007 reads as a red orb until you
zoom and see embers through a bound head; tree_046's root lights could be
candles or fungi. I called those. He overrules them, and the correction has to
be free — no regeneration, just a word.

Input:  live/tuning/scenery_light_kinds.json, schema
        pixel-wiki-scenery-light-kinds@1 — overrides keyed EITHER
          "scenery/<group>/<piece>"          -> the piece's kind
          "scenery/<group>/<piece>#<STATE>"  -> that state's kind
        value {kind: "<one of light.KINDS>", was: "<what it said>", updated_at}
        A state key wins over its piece; absent means the current value stands.

The two booleans are re-derived, never taken from the document: `flame` follows
the kind, and `embers` is fire/open or fire/ember only — a lantern he re-files
as fire/enclosed must stop throwing sparks in the same run, or the correction
looks ignored.

HOLD UNTIL THE WIKI HAS REBUILT, the lesson from the type picker: the wiki shows
his correction by reading the live document over its own baked data.json, so
clearing an entry the moment the manifest changes takes the correction off his
screen until the wiki next builds. He caught that ("a lot of scenery I changed
... are still listed under mountain walls"). An entry retires only once the
wiki's bake agrees. If the wiki does not publish `kind` at all, holding would
deadlock forever, so that case clears immediately and says so.

    python3 scenery/pipeline/consume_kinds.py --dry-run
    python3 scenery/pipeline/consume_kinds.py
"""
from __future__ import annotations

import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, light, viewer_build

KINDS_DOC = os.path.join(os.path.dirname(factory.ROOT), "live", "tuning",
                         "scenery_light_kinds.json")
WIKI_DATA = os.path.join(os.path.dirname(factory.ROOT), "wiki", "site", "data.json")
PREFIX = "scenery/"


def _load():
    if not os.path.exists(KINDS_DOC):
        return None
    with open(KINDS_DOC) as f:
        return json.load(f)


def plan():
    """[(key, rel, state_or_None, kind, problem_or_None)]"""
    doc = _load()
    if not doc:
        return []
    out = []
    for key, v in sorted((doc.get("overrides") or {}).items()):
        if not isinstance(v, dict):
            continue
        body = key[len(PREFIX):] if key.startswith(PREFIX) else key
        rel, _, state = body.partition("#")
        state = state.upper() or None
        kind = v.get("kind")
        problem = None
        man = factory.read_manifest(rel)
        if kind not in light.KINDS:
            problem = f"kind {kind!r} is not one of {', '.join(light.KINDS)}"
        elif man is None:
            problem = "no such piece"
        elif not man.get("light"):
            problem = "piece publishes no light block"
        elif state and state not in ((man["light"].get("states")) or {}):
            problem = f"no light entry for state {state}"
        out.append((key, rel, state, kind, problem))
    return out


def apply(jobs, dry):
    done = []
    for key, rel, state, kind, problem in jobs:
        if problem:
            continue
        man = factory.read_manifest(rel)
        target = man["light"]["states"][state] if state else man["light"]
        if target.get("kind") == kind:
            done.append((key, rel, state, kind, True))
            continue
        target["kind"] = kind
        target.update(light.flags_for(kind))
        if not dry:
            factory.write_manifest(rel, man)
            # Re-stamp the piece so an inherited state's flags follow a changed
            # piece kind, rather than keeping the ones they were derived from.
            light.apply_kinds(write=True)
        done.append((key, rel, state, kind, False))
    return done


def _baked_kinds():
    """{rel: kind} as the WIKI currently believes. None when it publishes no
    kind at all — then holding would never end."""
    try:
        with open(WIKI_DATA) as f:
            objs = json.load(f)["domains"]["objects"]
    except Exception:
        return None
    got = {}
    for o in objs:
        if not (isinstance(o, dict) and str(o.get("path", "")).startswith(PREFIX)):
            continue
        k = (o.get("light") or {}).get("kind")
        if k:
            got[o["path"][len(PREFIX):]] = k
    return got or None


def clear(spent, dry):
    doc = _load()
    if not doc or dry or not spent:
        return 0
    ov = doc.get("overrides") or {}
    n = sum(1 for k in spent if ov.pop(k, None) is not None)
    doc["overrides"] = ov
    with open(KINDS_DOC, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return n


def main():
    dry = "--dry-run" in sys.argv
    jobs = plan()
    if not jobs:
        print("no light-kind corrections standing")
        return 0
    for key, rel, state, kind, problem in jobs:
        if problem:
            print(f"SKIP {key:<52} {problem}")
    done = apply(jobs, dry)
    for key, rel, state, kind, already in done:
        print("%-52s -> %-14s%s" % (key, kind, "  (already)" if already else ""))
    baked = _baked_kinds()
    if baked is None:
        print("\nthe wiki publishes no light kind yet — clearing without the hold")
        spent = [d[0] for d in done]
    else:
        spent = [d[0] for d in done if baked.get(d[1]) == d[3] or d[2]]
        held = len(done) - len(spent)
        if held:
            print("\nholding %d: the wiki's data.json still shows the old kind, and "
                  "clearing now would take the correction off his screen" % held)
    cleared = clear(spent, dry)
    print("\n%d correction(s) applied%s; %d cleared"
          % (len(done), " (DRY RUN)" if dry else "", cleared))
    if not dry and done:
        viewer_build.build()
        print("viewer_data.json rebuilt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
