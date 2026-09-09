"""Re-file pieces he has put in the wrong group, then clear the correction.

Him, via the wiki: "I can see some scenery in the group 'Mountain wall' is not
mountain wall and I can't change type when doing the review. I need a change
type button."

A piece's type is normally its GROUP's type (config `types`), which is right
until a piece lands in a group it does not belong to. viewer_build already
prefers a per-piece `type` on the manifest over the group's, so re-filing is
setting that one field — no art moves, nothing regenerates, the piece keeps its
folder, its verdicts and its hitboxes.

Input:  live/tuning/scenery_types.json, schema pixel-wiki-scenery-types@1 —
        overrides["scenery/<group>/<piece>"] = {type, was, updated_at}
        Choosing this domain's own tag deletes the entry in the wiki, so the
        file only ever lists what is wrong.

THE WIKI ALREADY SHOWS HIM THE CORRECTION — its chips, counts, filters and
‹ › walk all read this file, so a re-filed piece leaves the wrong group on his
screen immediately. Consuming it here is what makes the change outlive the live
document, and clearing the entry afterwards is what stops it being re-applied
forever after the manifest already says it.

    python3 scenery/pipeline/consume_types.py --dry-run
    python3 scenery/pipeline/consume_types.py
"""
from __future__ import annotations

import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, viewer_build

TYPES = os.path.join(os.path.dirname(factory.ROOT), "live", "tuning",
                     "scenery_types.json")
WIKI_DATA = os.path.join(os.path.dirname(factory.ROOT), "wiki", "site", "data.json")
PREFIX = "scenery/"


def baked_types():
    """What the WIKI currently believes, from its own built data.json.

    Why this is consulted before clearing anything: the wiki shows him the
    correct group by reading this live document ON TOP OF its baked data. Its
    data.json is rebuilt on the wiki's own schedule, not mine. Clearing an entry
    the moment the manifest is re-filed therefore removes the only thing holding
    the correction on his screen, and the piece SNAPS BACK to the wrong group
    until the wiki next rebuilds. Which is exactly what he saw: "a lot of
    scenery I changed to not be mountain wall are still listed under mountain
    walls" — his 30 corrections were applied and pushed, and I had deleted the
    overrides while the wiki's bake still said MOUNTAIN_WALL 71.

    So an entry is spent only once the wiki's own data agrees with the manifest.
    Re-applying is idempotent, so keeping it costs nothing and the entry retires
    itself on the first run after the wiki rebuilds."""
    try:
        with open(WIKI_DATA) as f:
            objs = json.load(f)["domains"]["objects"]
    except Exception:
        return None                      # not checked out: fall back to clearing
    return {o["path"][len(PREFIX):]: o.get("type") for o in objs
            if isinstance(o, dict) and str(o.get("path", "")).startswith(PREFIX)}


def _load():
    if not os.path.exists(TYPES):
        return None
    with open(TYPES) as f:
        return json.load(f)


def plan():
    """[(key, rel, new_type, was, problem_or_None)]"""
    doc = _load()
    if not doc:
        return []
    cfg = factory.load_config()
    allowed = set((cfg.get("types") or {}).get("values") or [])
    out = []
    for key, v in sorted((doc.get("overrides") or {}).items()):
        if not isinstance(v, dict):
            continue
        rel = key[len(PREFIX):] if key.startswith(PREFIX) else key
        new = v.get("type")
        problem = None
        if not isinstance(new, str) or not new:
            problem = "no type given"
        elif allowed and new not in allowed:
            # He can only pick from the domain's own list in the UI, so this
            # means the taxonomy moved under an old entry — report, never guess.
            problem = "type %r is not in config `types`" % new
        elif factory.read_manifest(rel) is None:
            problem = "no such piece"
        out.append((key, rel, new, v.get("was"), problem))
    return out


def apply(jobs, dry):
    done = []
    for key, rel, new, was, problem in jobs:
        if problem:
            continue
        man = factory.read_manifest(rel)
        if man.get("type") == new:
            done.append((key, rel, new, was, True))    # already re-filed
            continue
        if not dry:
            man["type"] = new
            factory.write_manifest(rel, man)
        done.append((key, rel, new, was, False))
    return done


def clear(keys, dry):
    doc = _load()
    if not doc or dry or not keys:
        return 0
    ov = doc.get("overrides") or {}
    n = sum(1 for k in keys if ov.pop(k, None) is not None)
    doc["overrides"] = ov
    with open(TYPES, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return n


def main():
    dry = "--dry-run" in sys.argv
    jobs = plan()
    if not jobs:
        print("no type corrections standing")
        return 0
    for key, rel, new, was, problem in jobs:
        if problem:
            print("SKIP %-52s %s" % (key, problem))
    done = apply(jobs, dry)
    for key, rel, new, was, already in done:
        print("%-52s %s -> %s%s" % (rel, was or "(group default)", new,
                                    "  (already)" if already else ""))
    # Only retire an entry the wiki has caught up with — see baked_types().
    baked = baked_types()
    if baked is None:
        spent = [d[0] for d in done]
    else:
        spent = [d[0] for d in done if baked.get(d[1]) == d[2]]
        held = len(done) - len(spent)
        if held:
            print("\nholding %d correction(s): the wiki's data.json still shows the "
                  "old group, and clearing now would snap them back on his screen"
                  % held)
    cleared = clear(spent, dry)
    print("\n%d piece(s) re-filed%s; %d correction(s) cleared"
          % (len(done), " (DRY RUN)" if dry else "", cleared))
    if not dry and done:
        viewer_build.build()
        print("viewer_data.json rebuilt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
