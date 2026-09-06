"""How strong a lit piece shines — derive, check and compare the `light` block.

Maintainer 2026-09-06: the maps agent wrote a `light` block into 500 manifests
(strength relative to the spawn bonfire, colour measured from the LIT art,
radius in cells) and handed the field to this domain: "You have the
responsibility to maintain this and make it work if you, let's say, add a new
scenery object that also needs light."

WHAT OWNING IT MEANS. The maps pass was a one-off script that lives nowhere in
the repo, so a new lit piece would simply have no block — and maps2's light
budget audits a piece with no block at the bonfire's radius 7, which turns a
candle into a bonfire and blows the 8-light window. So:

  - THE CLASS TABLE LIVES IN config/factory.json (`groups[].light`), one entry
    per group: strength by what the thing IS (beacon 0.9 … candle 0.05) and the
    group's default colour. A group with lit art and no entry is REFUSED, loudly.
  - THIS TOOL DERIVES A BLOCK for any piece from that table plus its own art,
    and FILLS GAPS ONLY: the 500 existing blocks are the maintainer-reviewed
    reference and are never rewritten unless --force is passed. Same law as the
    art itself — loops create only what is missing.
  - `--check` is the gate: every lit-capable piece and every LIT state has an
    entry. Run at the end of every generation pass.
  - `--compare` scores this derivation against the existing blocks so its
    fidelity is measured, not asserted (see the numbers in the docstring of
    compare()).

THE DERIVATION, measured back out of the 500 (the README's prose rule was not
quite what was run):
  strength(state) = class × nudge, nudge ∈ {0.8, 1.0, 1.2} by the state's
    emissive pixel share against the group's median share — below 0.6× the
    median 0.8, above 1.3× 1.2, else 1.0. Fitted on 1,318 states: 789 agree
    exactly; the rest sit in the fuzzy middle band and differ by one step.
  colour(state) = brightness-weighted mean of the bright saturated pixels
    (V ≥ 0.8, S ≥ 0.2), NORMALISED so the brightest channel is 255 — every one
    of their 1,318 colours has a channel at ff, which is the tell: colour
    carries hue, strength carries brightness. Too few such pixels and the
    group default is used, which is why soulstone_016 sits at the group purple
    on all five states.
  radius = round(1 + 6·strength), capped at 7 — maps2 world3.light_meta reads
    exactly `states[<state>]` then the top level, so that shape is a contract.

    python3 scenery/pipeline/light.py --check
    python3 scenery/pipeline/light.py --compare
    python3 scenery/pipeline/light.py [--force] <rel> [<rel> ...]
    python3 scenery/pipeline/light.py --fill          # every gap, every piece
"""
from __future__ import annotations

import collections, json, os, statistics, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, viewer_build

V_MIN, S_MIN = 0.8, 0.2          # what counts as an emissive pixel
MIN_EMISSIVE_PX = 24             # fewer than this and the colour is not trusted
NUDGE_LO, NUDGE_HI = 0.6, 1.3    # share / group median -> 0.8 | 1.0 | 1.2
REFERENCE = "the spawn bonfire is 1.0 (radius 7); strength 0 is no light"


def _cfg_light():
    cfg = factory.load_config()
    table = {g["id"]: g.get("light") for g in cfg.get("groups", [])
             if isinstance(g, dict) and g.get("id")}
    defaults = cfg.get("light") or {}
    return table, defaults.get("warm", "#ffb45c"), defaults.get("cool", "#9fe4ff")


def _emissive(path):
    """(share of opaque pixels that glow, normalised mean colour or None)."""
    a = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255
    rgb, al = a[..., :3], a[..., 3]
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    opaque = al > 0.5
    em = opaque & (mx >= V_MIN) & (sat >= S_MIN)
    n = int(em.sum())
    share = n / max(int(opaque.sum()), 1)
    if n < MIN_EMISSIVE_PX:
        return share, None
    w = mx[em]
    c = (rgb[em] * w[:, None]).sum(0) / w.sum()
    c = c / c.max()
    return share, "#%02x%02x%02x" % tuple(int(round(x * 255)) for x in c)


def _radius(strength):
    return min(7, max(0, int(round(1 + 6 * strength))))


def lit_states(man):
    """{state_key: sprite_rel} for everything that shines. Legacy two-state
    pieces (`lights: LIGHTS_ON`) shine as a single LIGHTS_ON entry keyed the
    way maps2 already reads them."""
    out = {}
    for k, v in (man.get("states") or {}).items():
        if k.upper().startswith("LIT_") and isinstance(v, dict) and v.get("sprite"):
            out[k] = v["sprite"]
    if not out and man.get("lights") == "LIGHTS_ON":
        # A legacy piece flagged LIGHTS_ON with no states (chess_table_006, a
        # table with a candle) is ALWAYS lit: its own sprite is the lit art, so
        # that is the right thing to measure — not a fallback.
        out["LIGHTS_ON"] = man.get("sprite")
    return out


def group_of(rel):
    return rel.split("/", 1)[0] if "/" in rel else rel


def _group_median_share(group, table_cache):
    """Median emissive share across every lit state in the group — the nudge's
    yardstick. Cached per run; a one-piece group is its own median."""
    if group in table_cache:
        return table_cache[group]
    shares = []
    for rel, man in factory.discover():
        if group_of(rel) != group:
            continue
        for st, sp in lit_states(man).items():
            p = os.path.join(factory.ROOT, sp)
            if os.path.exists(p):
                shares.append(_emissive(p)[0])
    table_cache[group] = statistics.median(shares) if shares else 0.0
    return table_cache[group]


def derive(rel, man, cache):
    """A complete `light` block for this piece, or (None, reason)."""
    table, warm, cool = _cfg_light()
    g = group_of(rel)
    cls = table.get(g)
    if not cls or "strength" not in cls:
        return None, f"group {g!r} has no `light` entry in config/factory.json — add one"
    base = float(cls["strength"])
    default_color = cls.get("color") or warm
    med = _group_median_share(g, cache)
    states = {}
    for st, sp in lit_states(man).items():
        p = os.path.join(factory.ROOT, sp)
        if not os.path.exists(p):
            continue
        share, col = _emissive(p)
        ratio = share / med if med > 0 else 1.0
        nudge = 0.8 if ratio < NUDGE_LO else (1.2 if ratio > NUDGE_HI else 1.0)
        s = round(base * nudge, 2)
        states[st] = {"strength": s, "color": col or default_color, "radius": _radius(s)}
    if not states:
        return None, "no lit art on disk"
    return {"strength": base, "color": default_color, "radius": _radius(base),
            "reference": REFERENCE, "states": states}, None


def ensure(rel, force=False, cache=None, write=True):
    """Give `rel` a light block if it shines and has none (or if force).
    Returns (status, detail). Never rewrites an existing block without force."""
    cache = cache if cache is not None else {}
    man = factory.read_manifest(rel)
    if man is None:
        return "no manifest", None
    if not lit_states(man):
        return "unlit", None
    existing = man.get("light")
    if existing and not force:
        missing = [s for s in lit_states(man) if s not in (existing.get("states") or {})]
        if not missing:
            return "has block", None
        # New LIT state on a piece that already has a block: add just that
        # state's entry, leave the reviewed ones alone.
        block, why = derive(rel, man, cache)
        if not block:
            return "REFUSED", why
        for s in missing:
            existing.setdefault("states", {})[s] = block["states"][s]
        if write:
            factory.write_manifest(rel, man)
        return "added states", missing
    block, why = derive(rel, man, cache)
    if not block:
        return "REFUSED", why
    man["light"] = block
    if write:
        factory.write_manifest(rel, man)
    return "written" if not existing else "rewritten", list(block["states"])


def check():
    """The gate: every lit piece and every LIT state carries an entry."""
    bad = []
    for rel, man in factory.discover():
        ls = lit_states(man)
        if not ls:
            continue
        L = man.get("light")
        if not L:
            bad.append((rel, "no light block")); continue
        for s in ls:
            if s not in (L.get("states") or {}):
                bad.append((rel, f"state {s} has no entry"))
    return bad


def compare():
    """Score this derivation against the existing (maps-written) blocks.
    What matters to the light budget is the RADIUS a placement gets, so that is
    the headline; strength class and colour family are reported beside it."""
    cache = {}
    n = radius_ok = strength_ok = family_ok = pieces = 0
    off_by = collections.Counter()
    for rel, man in factory.discover():
        L = man.get("light")
        if not L or not lit_states(man):
            continue
        mine, why = derive(rel, man, cache)
        if not mine:
            continue
        pieces += 1
        for st, theirs in (L.get("states") or {}).items():
            m = mine["states"].get(st)
            if not m:
                continue
            n += 1
            radius_ok += (m["radius"] == theirs.get("radius"))
            off_by[m["radius"] - int(theirs.get("radius", 0))] += 1
            strength_ok += abs(m["strength"] - float(theirs.get("strength", 0))) < 0.005
            fam = lambda c: "warm" if int(c[1:3], 16) >= int(c[5:7], 16) else "cool"
            family_ok += (fam(m["color"]) == fam(theirs.get("color", "#ffb45c")))
    return dict(pieces=pieces, states=n, radius_match=radius_ok, strength_exact=strength_ok,
                colour_family=family_ok, radius_off_by=dict(sorted(off_by.items())))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if "--check" in sys.argv:
        bad = check()
        for rel, why in bad[:30]:
            print(f"  {rel:<44} {why}")
        print(f"{len(bad)} problem(s)" if bad else "PASS — every lit piece and state has a light entry")
        sys.exit(1 if bad else 0)
    if "--compare" in sys.argv:
        r = compare()
        print(f"{r['pieces']} pieces, {r['states']} states scored against the existing blocks")
        print(f"  radius identical      : {r['radius_match']} / {r['states']}  "
              f"({100 * r['radius_match'] // max(r['states'], 1)}%)   off-by: {r['radius_off_by']}")
        print(f"  strength exact (2dp)  : {r['strength_exact']} / {r['states']}")
        print(f"  colour warm/cool same : {r['colour_family']} / {r['states']}")
        sys.exit(0)
    force = "--force" in sys.argv
    if "--fill" in sys.argv:
        args = [rel for rel, man in factory.discover() if lit_states(man)]
    if not args:
        sys.exit(__doc__)
    cache, counts = {}, collections.Counter()
    for rel in args:
        status, detail = ensure(rel, force=force, cache=cache)
        counts[status] += 1
        if status not in ("has block", "unlit"):
            print(f"  {rel:<44} {status}  {detail or ''}")
    print(dict(counts))
    if counts["written"] or counts["rewritten"] or counts["added states"]:
        viewer_build.build()
        print("viewer_data.json rebuilt")
