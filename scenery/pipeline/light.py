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
  radius = round(1 + 6·strength), NOT capped (the bonfire is the reference, not
    the ceiling) — maps2 world3.light_meta reads exactly `states[<state>]` then
    the top level, so that shape is a contract.

    python3 scenery/pipeline/light.py --check
    python3 scenery/pipeline/light.py --compare
    python3 scenery/pipeline/light.py [--force] <rel> [<rel> ...]
    python3 scenery/pipeline/light.py --fill          # every gap, every piece
    python3 scenery/pipeline/light.py --scale 2 [--write]   # the brightness (core) knob
    python3 scenery/pipeline/light.py --reach   [--write]   # the reach knob, from config
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
REFERENCE = "the spawn bonfire is 1.0 (radius 7) and NOT the maximum; strength 0 is no light"


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
    """Cells. NO CEILING (maintainer 2026-09-06: "I see the campfire as a
    normal light not even near what will be the max in the game"). The 7-cell
    cap came from games2's light-budget spec and is being removed there; maps2
    already reads the published radius as-is. So strength 1.0 is the bonfire,
    and 2.0 is a light twice its reach — the scale is open at the top."""
    return max(0, int(round(1 + 6 * strength)))


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
    reach = cls.get("reach")           # cells; None -> legacy formula
    rad = (lambda s: max(0, int(round(reach * s / base))) if reach is not None and base > 0
           else _radius(s))
    states = {}
    for st, sp in lit_states(man).items():
        p = os.path.join(factory.ROOT, sp)
        if not os.path.exists(p):
            continue
        share, col = _emissive(p)
        ratio = share / med if med > 0 else 1.0
        nudge = 0.8 if ratio < NUDGE_LO else (1.2 if ratio > NUDGE_HI else 1.0)
        s = round(base * nudge, 2)
        states[st] = {"strength": s, "color": col or default_color, "radius": rad(s)}
    if not states:
        return None, "no lit art on disk"
    return {"strength": base, "color": default_color, "radius": rad(base),
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


def scale(factor, write=False):
    """Multiply EVERY strength (piece default and each state) by `factor`,
    recompute radius, keep colour. This is the brightness knob.

    Why multiply the blocks in place rather than re-derive with --force: the
    500 first-pass blocks carry per-state nudges and measured colours that my
    derivation only reproduces on 84% of radii. Scaling preserves their exact
    relative structure — a streetlight stays 0.5 of a bonfire, LIT_3 stays
    0.8 of LIT_1 — and only moves the whole scale. Also updates the group table
    in config so a piece derived later lands on the same scale as the rest.

    The budget cost, so it is decided with eyes open: radius = round(1+6s), so
    x2 takes a streetlight from 4 to 7 cells and a hearth from 5 to 9; every
    camera window then reaches more lights, and maps2's 8-light audit thins
    placements where it overflows."""
    n = 0
    for rel, man in factory.discover():
        L = man.get("light")
        if not L:
            continue
        L["strength"] = round(L["strength"] * factor, 2)
        L["radius"] = _radius(L["strength"])
        for st in (L.get("states") or {}).values():
            st["strength"] = round(st["strength"] * factor, 2)
            st["radius"] = _radius(st["strength"])
        n += 1
        if write:
            factory.write_manifest(rel, man)
    if write:
        cfg_p = os.path.join(factory.ROOT, "config", "factory.json")
        cfg = json.load(open(cfg_p))
        for g in cfg.get("groups", []):
            if isinstance(g, dict) and isinstance(g.get("light"), dict) and "strength" in g["light"]:
                g["light"]["strength"] = round(g["light"]["strength"] * factor, 2)
        json.dump(cfg, open(cfg_p, "w"), indent=2, ensure_ascii=False)
    return n


ANCHOR_GROUP, ANCHOR_REACH = "streetlights", 9    # his number, 2026-09-06


def reach_table(write=False):
    """REACH IS NOT BRIGHTNESS (maintainer 2026-09-06: "A streetlight should
    reach 2x the bonfire, but it doesn't have to be brighter at the core — just
    reach twice as long"). So `radius` stops being a function of `strength`.
    Each group gets an explicit `light.reach` in cells; the anchor is the
    streetlight at 14, and every other group's reach is set in proportion to
    its class strength so the ORDER the first pass decided is kept — a lantern
    post still reaches less than a streetlight, a hearth more. Written into
    config so every number is editable by hand, and light.py reads them from
    there: derive() uses reach for radius and keeps strength for the core.
    round(1+6·strength) survives only as the fallback for a group with no
    reach yet.

    The anchor is the ONE number to turn: every other group is derived from it,
    so changing it rescales the whole table by the same percentage and keeps the
    order. Set to 14 (2x the bonfire) on his first answer and to 9 an hour later
    — "streetlight 14 was a bit overkill... scale down the others with high
    radius by the same %" — which is this line and a re-run, nothing else."""
    cfg_p = os.path.join(factory.ROOT, "config", "factory.json")
    cfg = json.load(open(cfg_p))
    groups = {g["id"]: g for g in cfg.get("groups", []) if isinstance(g, dict) and g.get("id")}
    anchor = groups[ANCHOR_GROUP]["light"]["strength"]
    out = {}
    for gid, g in groups.items():
        L = g.get("light")
        if not isinstance(L, dict) or "strength" not in L:
            continue
        r = int(round(ANCHOR_REACH * L["strength"] / anchor)) if L["strength"] > 0 else 0
        L["reach"] = r
        out[gid] = (L["strength"], r)
    if write:
        cfg["light"]["reach"] = ("cells a group's light reaches, INDEPENDENT of strength (the core). "
                                 "Anchor: streetlights 14 = 2x the bonfire; others in proportion to class "
                                 "strength. Edit per group freely; light.py --reach re-applies.")
        json.dump(cfg, open(cfg_p, "w"), indent=2, ensure_ascii=False)
    return out


def apply_reach(write=False, table=None):
    """Set every block's radius from its group's reach, per state in proportion
    to the state's own strength against the piece default. Strength and colour
    untouched — the core is unchanged, only the reach moves."""
    if table is None:
        table, _, _ = _cfg_light()
    n = 0
    for rel, man in factory.discover():
        L = man.get("light")
        cls = table.get(group_of(rel)) or {}
        if not L or "reach" not in cls:
            continue
        reach, base = int(cls["reach"]), float(L.get("strength") or 0)
        L["radius"] = reach
        for st in (L.get("states") or {}).values():
            k = (float(st.get("strength", base)) / base) if base > 0 else 1.0
            st["radius"] = max(0, int(round(reach * k)))
        n += 1
        if write:
            factory.write_manifest(rel, man)
    return n


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
    if "--reach" in sys.argv:
        dry = "--write" not in sys.argv
        t = reach_table(write=not dry)
        print("reach in cells (anchor: %s at %d; the bonfire is 7):" % (ANCHOR_GROUP, ANCHOR_REACH))
        for g in ("beacons","hearths","braziers","streetlights","torch_posts","lantern_posts",
                  "crystals","waystones","mushrooms","beds"):
            if g in t: print("  %-14s strength %.2f  reach %2d" % (g, *t[g]))
        n = apply_reach(write=not dry, table={g: {"reach": r} for g, (_s, r) in t.items()})
        print("%d pieces %s" % (n, "re-reached" if not dry else "would be (DRY RUN — add --write)"))
        if not dry:
            viewer_build.build(); print("viewer_data.json rebuilt")
        sys.exit(0)
    if "--scale" in sys.argv:
        f = float(sys.argv[sys.argv.index("--scale") + 1])
        dry = "--write" not in sys.argv
        table, _, _ = _cfg_light()
        print("x%.2f would make (strength -> radius cells):" % f)
        for g in ("beacons", "hearths", "braziers", "streetlights", "torch_posts",
                  "lantern_posts", "crystals", "waystones", "mushrooms", "beds"):
            if g in table and "strength" in table[g]:
                s0 = table[g]["strength"]; s1 = round(s0 * f, 2)
                print("  %-14s %.2f -> %.2f   radius %d -> %d" % (g, s0, s1, _radius(s0), _radius(s1)))
        n = scale(f, write=not dry)
        print("%d pieces %s" % (n, "rescaled" if not dry else "would be rescaled (DRY RUN — add --write)"))
        if not dry:
            viewer_build.build(); print("viewer_data.json rebuilt")
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
