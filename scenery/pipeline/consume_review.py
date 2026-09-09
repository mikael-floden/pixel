"""Apply his wiki verdicts on ANIMATIONS and on a state's LIGHT, then clear them.

Two channels, one shape — `overrides["<piece path>#<state>"]`, corrections only,
setting a value back to what was generated deletes the entry:

  live/tuning/scenery_animation.json   {verdict: ANIMATION_APPROVED|ANIMATION_REDO}
      The verdict is per STATE, not per animation name, because that is what he
      watches. It lands on every animation of that state.

  live/tuning/scenery_lighting.json    only the fields he moved, of
      kind / color / strength / radius / flame / embers, applied to that STATE's
      entry in the light block (the piece keeps its own default).

STATE KEYS ARE UPPERCASE HERE, LOWERCASE THERE. scenery writes `states.LIT_4`,
the wiki names the same state `lit_4` and keys its verdicts that way. Matched
case-insensitively rather than renaming either side — both spellings are already
in published data (the wiki says the same in its own comment).

flame/embers are DERIVED from kind, so a correction that moves `kind` re-derives
them; if he moved them explicitly they are his and stay. Otherwise a lantern he
re-files as fire/enclosed would keep throwing sparks and the correction would
look ignored.

HOLD UNTIL THE WIKI HAS REBUILT, the lesson from the type picker: the wiki shows
his correction by reading the live document over its own baked data.json, so
clearing on apply takes it off his screen until the wiki next builds. An entry
retires only once the bake agrees. If the bake cannot answer, it clears rather
than deadlocking.

    python3 scenery/pipeline/consume_review.py --dry-run
    python3 scenery/pipeline/consume_review.py
"""
from __future__ import annotations

import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, light, viewer_build

LIVE = os.path.join(os.path.dirname(factory.ROOT), "live", "tuning")
ANIM_DOC = os.path.join(LIVE, "scenery_animation.json")
LIGHT_DOC = os.path.join(LIVE, "scenery_lighting.json")
WIKI_DATA = os.path.join(os.path.dirname(factory.ROOT), "wiki", "site", "data.json")
PREFIX = "scenery/"
HIS_ANIM = ("ANIMATION_APPROVED", "ANIMATION_REDO")
LIGHT_FIELDS = ("kind", "color", "strength", "radius", "flame", "embers")


def _load(p):
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def _split(key):
    body = key[len(PREFIX):] if key.startswith(PREFIX) else key
    rel, _, st = body.partition("#")
    return rel, (st or None)


def _state_key(man, st):
    """The manifest's spelling of a state the wiki named in another case."""
    if st is None:
        return None
    for k in (man.get("states") or {}):
        if k.lower() == st.lower():
            return k
    return None


def plan_anim():
    doc = _load(ANIM_DOC)
    out = []
    for key, v in sorted(((doc or {}).get("overrides") or {}).items()):
        if not isinstance(v, dict):
            continue
        rel, st = _split(key)
        man = factory.read_manifest(rel)
        verdict = v.get("verdict")
        sk = _state_key(man, st) if man else None
        problem = None
        if verdict not in HIS_ANIM:
            problem = f"verdict {verdict!r} is not one of {HIS_ANIM}"
        elif man is None:
            problem = "no such piece"
        elif st and sk is None:
            problem = f"no such state {st}"
        else:
            c = man if sk is None else man["states"][sk]
            if not (c.get("animations") or {}):
                problem = "that state has no animation"
        out.append((key, rel, sk, verdict, problem))
    return out


def plan_light():
    doc = _load(LIGHT_DOC)
    out = []
    for key, v in sorted(((doc or {}).get("overrides") or {}).items()):
        if not isinstance(v, dict):
            continue
        rel, st = _split(key)
        man = factory.read_manifest(rel)
        fields = {k: v[k] for k in LIGHT_FIELDS if k in v}
        sk = _state_key(man, st) if man else None
        problem = None
        if man is None:
            problem = "no such piece"
        elif not man.get("light"):
            problem = "piece publishes no light block"
        elif st and sk is None:
            problem = f"no such state {st}"
        elif not fields:
            problem = "no light field to apply"
        elif "kind" in fields and fields["kind"] not in light.KINDS:
            problem = f"kind {fields['kind']!r} is not one of {', '.join(light.KINDS)}"
        out.append((key, rel, sk, fields, problem))
    return out


def apply_anim(jobs, dry):
    done = []
    for key, rel, sk, verdict, problem in jobs:
        if problem:
            continue
        man = factory.read_manifest(rel)
        c = man if sk is None else man["states"][sk]
        names = []
        for name, a in (c.get("animations") or {}).items():
            if isinstance(a, dict) and a.get("review") != verdict:
                a["review"] = verdict
                names.append(name)
        if names and not dry:
            factory.write_manifest(rel, man)
        done.append((key, rel, sk, verdict, names))
    return done


def apply_light(jobs, dry):
    done = []
    for key, rel, sk, fields, problem in jobs:
        if problem:
            continue
        man = factory.read_manifest(rel)
        L = man["light"]
        target = L if sk is None else (L.setdefault("states", {}).setdefault(sk, {}))
        target.update(fields)
        # flame/embers follow kind unless he moved them himself
        if "kind" in fields:
            derived = light.flags_for(fields["kind"])
            for k, val in derived.items():
                if k not in fields:
                    target[k] = val
        if not dry:
            factory.write_manifest(rel, man)
        done.append((key, rel, sk, fields))
    return done


def _baked():
    try:
        with open(WIKI_DATA) as f:
            return json.load(f)["domains"]["objects"]
    except Exception:
        return None


def _wiki_agrees_anim(objs, rel, sk, verdict):
    if objs is None:
        return True
    for o in objs:
        if o.get("path") == PREFIX + rel:
            a = (o.get("animations") or {})
            for k, v in a.items():
                if sk is None or k.lower() == sk.lower():
                    return v.get("animState") == verdict
            return False
    return False


def _wiki_agrees_light(objs, rel, sk, fields):
    if objs is None:
        return True
    for o in objs:
        if o.get("path") == PREFIX + rel:
            L = (o.get("light") or {})
            src = ((L.get("states") or {}).get(sk) or (L.get("states") or {}).get((sk or "").lower())
                   or {}) if sk else L
            return all(src.get(k) == v or L.get(k) == v for k, v in fields.items())
    return False


def clear(path, keys, dry):
    doc = _load(path)
    if not doc or dry or not keys:
        return 0
    ov = doc.get("overrides") or {}
    n = sum(1 for k in keys if ov.pop(k, None) is not None)
    doc["overrides"] = ov
    with open(path, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return n


def main():
    dry = "--dry-run" in sys.argv
    a_jobs, l_jobs = plan_anim(), plan_light()
    if not a_jobs and not l_jobs:
        print("no animation or lighting verdicts standing")
        return 0
    for key, rel, sk, verdict, problem in a_jobs:
        if problem:
            print(f"SKIP {key:<52} {problem}")
    for key, rel, sk, fields, problem in l_jobs:
        if problem:
            print(f"SKIP {key:<52} {problem}")
    a_done = apply_anim(a_jobs, dry)
    l_done = apply_light(l_jobs, dry)
    for key, rel, sk, verdict, names in a_done:
        print("%-52s %-24s %s" % (key, verdict, ", ".join(names) or "(already)"))
    for key, rel, sk, fields in l_done:
        print("%-52s light %s" % (key, fields))
    objs = _baked()
    if objs is None:
        print("\nthe wiki's data.json is unreadable — clearing without the hold")
    a_spent = [d[0] for d in a_done if _wiki_agrees_anim(objs, d[1], d[2], d[3])]
    l_spent = [d[0] for d in l_done if _wiki_agrees_light(objs, d[1], d[2], d[3])]
    held = (len(a_done) - len(a_spent)) + (len(l_done) - len(l_spent))
    if held:
        print("\nholding %d: the wiki's data.json has not rebuilt with it yet, and "
              "clearing now would take the correction off his screen" % held)
    n = clear(ANIM_DOC, a_spent, dry) + clear(LIGHT_DOC, l_spent, dry)
    print("\n%d animation + %d lighting verdict(s) applied%s; %d cleared"
          % (len(a_done), len(l_done), " (DRY RUN)" if dry else "", n))
    if not dry and (a_done or l_done):
        viewer_build.build()
        print("viewer_data.json rebuilt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
