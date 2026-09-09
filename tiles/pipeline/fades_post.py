"""Analyse and publish the fade tiles into the WIKI'S contract: `tiles/fades/index.json`.

TWO RULINGS SHAPE THIS FILE, both maintainer 2026-08-28:

    "You must analyse the image. It's not enough to think your prompt gave you exactly
     what you wanted when it comes to %."

    "Don't make the filter absolute... the image is a visualization of a 3D stone with
     height. So it's ok if some edge contains black_rock and not grass... The black rock
     should try as much as it can to be INSIDE the tile, but you can pass images to me
     even if some edges are black_rock. What I don't want is tiles with 50% grass and
     50% black_rock."

So the edge test is a MEASUREMENT PUBLISHED, not a guillotine. A tall rock whose
silhouette crosses the rim is fine - its base sits inside and the height is drawing. What
still fails: a tile with no clear majority (the 50/50 he named), a tile whose edges are
owned by the WRONG ground (more than half the rim band reads as the minority - that tile
sits well on neither field), and a tile with no real mixture at all (a plain top wearing
a fade label; fine art, wrong tree).

THE OUTPUT IS THE WIKI'S SHAPE, posted by the wiki agent on the board before this data
existed and adopted verbatim rather than negotiated:

    tiles/fades/index.json     schema tiles3/fade-tiles@1
    { schema, pairs: { "<a>__to__<b>": [ { key, file, pct: {"<a>": 62.5, "<b>": 37.5} },
                                          ... ] } }

  - `key` is STABLE for the life of the art - the maintainer's verdicts ride
    live/feedback/tiles.json on it verbatim. It is derived from the sheet directory and
    the tile's position, which never change; the content hash lives only in `file`.
  - THE VERDICTS ARE HONOURED HERE. A key whose status is `rejected` (the wiki's
    "remove" button) is dropped from this index on every publish - the same one-way
    sync every other review state gets. Not doing so is the bug the maintainer hit
    twice ("every fade I have marked remove has not been removed"): 772 verdicts sat
    in the feedback file while the index kept listing the tiles. The art itself stays
    on disk - content-hashed names are harmless and un-rejecting brings it straight
    back - and only the FADE listing is affected: a fade key names a fade tile and
    nothing else, so a verdict here can never reach a tile's other roles.
  - `file` is the full repo-relative path of the shipped bytes ("I never construct
    paths" - wiki). Content-hashed, immutable, current + one previous generation kept.
  - `pct` both grounds by name, 0-100. Extra fields ride along and are ignored by the
    wiki: edge_ground, edge_contact, phrasing, prompt.

The raw generator listing lives in tiles/fades/sheets.json; this file owns index.json.
The EDGE numbers are measured on the exact post/ bytes named in `file` (the border rule
compares the band against the tile's own shipped background). The MIX is measured on the
raw art, because the meter's prototypes were learned from raw generator output and
alignment deliberately shifts the art off that distribution; alignment is a uniform
shift, so the area each ground covers - which is what pct claims - is unchanged by it.
"""

from __future__ import annotations

import glob
import hashlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from PIL import Image

import blends_post as BP
import fade_mix as FM
import palette_snap as PS
import puddle_gate as PG
import tops_post as TP
import transition_render as TR


MIN_REGION_PX = 60   # a side needs this many pixels before its own median is
                     # trustworthy; below it the shift falls back to the measured
                     # art-rendition delta for that ground (art_refs -> clean)


def process_two_sided(img, edge_g, other_g, post_map, meter_mask):
    """BOTH grounds get THE postprocessing - substitution onto their own palettes.

    The additive two-sided shift tried first could not deliver this and the maintainer
    caught why on the art: a shift moves a region's MEDIAN onto the palette but keeps
    the region's hue-spread, so a lime grass tuft (huge G-B gap, bright) stayed lime
    beside a world whose every other grass went through substitute(). "I still feel the
    grass is more lime and vibrant and doesn't look like our grass. Are you sure you run
    postprocessing on both ground-types?" We were not - now we are: each ground's region
    (the mix meter's own map decides which is which) gets the house substitution toward
    that ground's anchors - [top] + its approved top_extras, nearest-anchor exactly as
    the textured pass does - then the region's background lands on its clean colour
    integer-exactly. Hue and saturation are SET from the palette, never read off the
    art; only the value relief carries. A fade's grass now looks like the game's grass,
    because it goes through the game's own pipe.

    The wall is never drawn by any fade consumer (wall_is_meaningless); it takes the
    edge region's uniform delta so review strips do not show raw colours below a
    processed top.
    """
    arr = np.array(img.convert("RGBA"), int)
    top = TR.top_face(arr[..., 3] > 0)
    if not top.any() or post_map is None:
        return None
    af = arr.astype(float)
    rgb = af[..., :3]
    other_m = np.zeros_like(top)
    mm = meter_mask & top
    other_m[mm] = post_map[mm] > 0.5
    regions = ((edge_g, top & ~other_m), (other_g, top & other_m))
    out = af.copy()
    edge_delta = np.zeros(3)
    for g, gm in regions:
        if not gm.any():
            continue
        v = PALETTE[g]
        anchors = [PS._hex(v["top"])] + [PS._hex(h) for h in (v.get("top_extras") or [])]
        clean = anchors[0]
        bg = TP.background_of(rgb, gm) if gm.sum() >= 40 else np.median(rgb[gm], 0)
        delta = clean - bg
        if g == edge_g:
            edge_delta = delta
        if len(anchors) == 1:
            px = PS.substitute(af, gm, "%02x%02x%02x" % tuple(int(round(c)) for c in clean))
            if px is not None:
                out[..., :3][gm] = px
        else:
            al = np.clip(rgb + delta, 0, 255)
            A = PG.srgb_to_lab(np.array(anchors, float))
            Pl = PG.srgb_to_lab(al[gm])
            assign = np.linalg.norm(Pl[:, None, :] - A[None, :, :], axis=2).argmin(1)
            for k, anc in enumerate(anchors):
                sub = np.zeros_like(gm)
                sub[gm] = assign == k
                if not sub.any():
                    continue
                px = PS.substitute(af, sub, "%02x%02x%02x" % tuple(int(round(c)) for c in anc))
                if px is not None:
                    out[..., :3][sub] = px
        rgbf = out[..., :3]
        TP.shift_mask_to_clean(rgbf, gm, clean, measure=gm)
    # the wall rides the edge region's delta (never drawn, but strips show it)
    wall = (arr[..., 3] > 0) & ~top
    out[..., :3][wall] = np.clip(out[..., :3][wall] + edge_delta, 0, 255)
    rgbf = out[..., :3]
    TP.rim_suppress(rgbf, top, PS._hex(PALETTE[edge_g]["top"]))
    res = arr.copy()
    res[..., :3] = np.clip(np.rint(rgbf), 0, 255).astype(int)
    return Image.fromarray(res.astype(np.uint8), "RGBA")


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
FADES = os.path.join(ROOT, "fades")
PALETTE = json.load(open(os.path.join(ROOT, "config", "palette.json")))["types"]

MIN_MIX = 0.02      # below this one ground is not visibly present: a plain top, not a fade
MIN_RIM = 0.60      # the edge ground must own at least this share of the rim band -
                    # generous on purpose ("don't make the filter absolute... you can
                    # pass images to me even if some edges are black_rock"); below it
                    # the edges belong to no one ground and the tile sits well nowhere


def sheets():
    out = []
    for mp in sorted(glob.glob(os.path.join(FADES, "*__with__*", "*", "meta.json"))):
        m = json.load(open(mp))
        m["dir"] = os.path.relpath(os.path.dirname(mp), REPO)
        out.append(m)
    return out


def analyse(sheet, i, name):
    """One raw tile -> (entry, None) or (None, reject-reason). Entry is wiki-shaped."""
    a, b = sheet["dominant"], sheet["minor"]
    d = os.path.join(REPO, sheet["dir"])
    src = os.path.join(d, name)
    if not os.path.isfile(src):
        return None, "missing"

    # 1. THE MIX, measured on the image - the raw art decides which ground owns the
    #    tile. detail=True also hands back the meter's per-pixel map, which is what the
    #    two-sided alignment steers by.
    raw = Image.open(src)
    mix = FM.mix_fraction(raw, a, b, detail=True)
    if mix is None or mix.get("uncertain"):
        return None, "uncertain"
    frac_b = float(mix["frac_b"])

    # 2. THE SIDE A TILE BELONGS ON IS ITS RIM, NOT ITS AREA MAJORITY. The maintainer's
    #    counter-example: big black rocks ON an ice sheet - rock wins the area, but the
    #    edges are ice, so the tile places seamlessly on ICE and nowhere else ("you put
    #    it on black_rock and not on ice even if it's clear the edges are blue"). The
    #    rim's ground is read from the meter's own per-pixel map over the border band
    #    (the outer three erosion rings, the same band every edge rule here uses).
    a2, dia = PG.diamond_of(raw)
    band = None
    if dia is not None:
        band, _core = PG.band_and_core(dia)
        if (band & mix["mask"]).sum() < 40:
            band = None
    if band is None:
        # ~490 sheets draw alpha the staircase detector cannot read (band collapsed to
        # ~20px against a ~940px top face). The meter's own mask is sound there, so the
        # band falls back to the mask's outer three erosion rings - same width, same
        # meaning, measured on the mask that every other number here already trusts.
        mk = mix["mask"]
        er = mk.copy()
        for _ in range(3):
            er = PG.erode(er)
        band = mk & ~er
        if (band & mk).sum() < 40:
            return None, "no rim"
        dia = mk
    rim = band & mix["mask"]
    # THE FIGHT IS DECIDED ON THE LOWER SIDES. The maintainer's camera argument
    # (2026-08-28, drawn on the tile): a tall feature is rendered UPWARD in screen
    # space, so it can overlap the NW/NE edges of the diamond while the ground under
    # it is still the rim ground - "if we could change the camera angle ALL edges
    # would have been ICE". Nothing can occlude the SW/SE edges from behind, so they
    # are the honest witnesses; the upper edges join only when the lower half is too
    # thin to vote.
    try:
        sides = PG.side_of(dia)
        lower = (sides["SW"] | sides["SE"]) & rim
    except Exception:
        lower = np.zeros_like(rim)
    if lower.sum() < 40:
        # generic-mask fallback: the lower edges are the band below the mask's widest
        # row - for a true diamond this IS SW/SE, and for odd alpha it stays the part
        # of the rim nothing tall can occlude (features draw upward).
        widths = dia.sum(1)
        y_mid = int(np.argmax(widths))
        lower = rim.copy()
        lower[:y_mid + 1, :] = False
    vote = lower if lower.sum() >= 40 else rim
    rim_b = float(np.clip(mix["post"][vote], 0, 1).mean())
    edge_ground = b if rim_b > 0.5 else a
    other = a if edge_ground == b else b
    rim_own = rim_b if edge_ground == b else 1.0 - rim_b
    if rim_own < MIN_RIM:
        return None, "edges mixed"
    # reported contact stays WHOLE-band (how much of the full rim is not the edge
    # ground - includes the 3D overlaps, which is honest as a display number)
    whole_b = float(np.clip(mix["post"][rim], 0, 1).mean())
    rim_own_whole = whole_b if edge_ground == b else 1.0 - whole_b

    # 3. ALIGN BOTH SIDES onto their own palette colours; the rim treatment follows the
    #    EDGE ground (that is whose field the tile will sit in).
    clean = TP._hex(PALETTE[edge_ground]["top"])
    post_map = mix["post"] if edge_ground == a else (1.0 - mix["post"])
    aligned = process_two_sided(raw, edge_ground, other, post_map, mix["mask"])
    if aligned is None:
        return None, "no top face"
    post = os.path.join(d, "post")
    os.makedirs(post, exist_ok=True)
    buf = io.BytesIO()
    aligned.save(buf, "WEBP", lossless=True, exact=True)
    data = buf.getvalue()
    h8 = hashlib.sha1(data).hexdigest()[:8]
    hashed = name.replace(".webp", f".{h8}.webp")
    with open(os.path.join(post, hashed), "wb") as fh:
        fh.write(data)
    gens = sorted(glob.glob(os.path.join(post, name.replace(".webp", ".*.webp"))),
                  key=os.path.getmtime, reverse=True)
    for old in gens[2:]:
        os.remove(old)              # current + one previous generation - cache law

    # 3. THE GATE ON THE PUBLISHED BYTES; THE MIX ON THE RAW ART. The border rule is
    #    self-referential (band vs the tile's own background) so it must see exactly
    #    what ships - alignment moves every pixel. The METER is the opposite case: its
    #    prototypes were learned from raw generator output, and alignment deliberately
    #    shifts the art off that distribution, so raw is where its numbers are valid.
    shipped = os.path.join(post, hashed)
    frac_min = min(frac_b, 1.0 - frac_b)
    if frac_min < MIN_MIX:
        return None, "no real mixture"
    m = PG.border_purity(Image.open(shipped), clean_rgb=clean)
    if not m.get("ok"):
        return None, "no diamond"
    # No area-based edge reject here: the rim-coherence gate above already decided the
    # edges, from the meter's map. An "inverted" tile (area majority rock, rim ice) is
    # VALID and places on ice - that is the maintainer's ruling, not an edge failure.

    # THE MAINTAINER'S PCT FORMULA (2026-08-28): "The border is worth a lot!" The
    # edge-fight winner STARTS at 51 and the remaining 49 points scale with the
    # measured top-face area share - pct[E] = 51 + 49*areaE. The ground a tile sits on
    # is therefore ALWAYS the pct majority (">50% in the metadata" true by
    # construction, so placement can never land a tile on the wrong side again), and
    # his worked example lands exactly: area 49.5% ice with an ice rim -> 75% ice.
    # Integers summing to 100, so no label can ever read 51+50 again.
    areaE = frac_b if edge_ground == b else 1.0 - frac_b
    pE = int(round(51.0 + 49.0 * areaE))
    pct = {edge_ground: pE, other: 100 - pE}
    return {
        # STABLE for the life of the art: directory + position. The hash lives in `file`.
        "key": f'{sheet["dir"]}/{name[:-5]}',
        "file": os.path.relpath(shipped, REPO),
        "pct": pct,
        "area_pct": {a: round(100 * (1.0 - frac_b), 1), b: round(100 * frac_b, 1)},
        "edge_ground": edge_ground,
        "edge_contact": round(1.0 - rim_own_whole, 4),
        "border_impurity": m["border_impurity"],
        "phrasing": sheet["phrasing"], "prompt": sheet["prompt"],
    }, None


CACHE = os.path.join(FADES, "analysis_cache.json")


def _fingerprint(path):
    """Cheap identity for a raw tile: size + mtime. A regenerated sheet changes both."""
    try:
        st = os.stat(path)
        return f"{st.st_size}:{int(st.st_mtime)}"
    except OSError:
        return None


def _load_cache():
    """Reuse previous analysis, seeded from the published index on first run.

    THE PASS USED TO REBUILD EVERYTHING EVERY ROUND - 10,000+ tiles, hours per round -
    so while a generation run was in flight NOTHING new ever reached the index and the
    maintainer had nothing to review ("what transition/fade pair can I start reviewing?").
    81 pairs sat generated and invisible. Analysis is per tile and deterministic, so a
    tile whose raw bytes have not changed does not need re-analysing; only new sheets do,
    and a round now finishes in the time it takes to analyse what actually arrived.
    """
    if os.path.isfile(CACHE):
        try:
            return json.load(open(CACHE))
        except Exception:
            pass
    # seed from the published index: those entries were produced by this same pass
    seed = {}
    ip = os.path.join(FADES, "index.json")
    if os.path.isfile(ip):
        try:
            d = json.load(open(ip))
            for ents in (d.get("pairs") or {}).values():
                for e in ents:
                    raw = e["key"] + ".webp"
                    fp = _fingerprint(os.path.join(REPO, raw))
                    if fp:
                        seed[e["key"]] = {"fp": fp, "entry": e}
        except Exception:
            pass
    return seed


FEEDBACK = os.path.join(REPO, "live", "feedback", "tiles.json")
REMOVED = os.path.join(FADES, "removed.json")


def apply_review(keys_seen):
    """key -> True when the maintainer wants this tile OUT of the fade listing.

    A REMOVAL IS REMEMBERED HERE, NOT ONLY IN THE FEEDBACK FILE, and it has to be: the
    two are coupled in a loop that erased 772 verdicts. He marks remove -> this pass
    drops the tile from index.json -> the wiki prunes the feedback entry because the
    tile is no longer listed -> the verdict is gone -> the next publish lists the tile
    again. Measured 2026-09-02: all 772 fade verdicts vanished from the feedback file
    and 770 removed tiles came back, so he reviewed the same tiles twice. Reading the
    feedback file alone cannot fix this, because by the time we read it the verdict is
    already gone.

    So this owns a tombstone list. Precedence, and the middle line is the one that
    matters:

        status "rejected" now   -> removed, and tombstoned so it stays removed
        status set, not rejected -> listed, tombstone cleared (an ACTIVE un-reject)
        no entry at all          -> the tombstone decides

    Absence is NOT approval - it is the wiki having forgotten - so only an explicit
    non-rejected verdict brings a tile back. `keys_seen` bounds the file to tiles that
    still exist, so it cannot grow without limit.
    """
    tomb = set()
    if os.path.isfile(REMOVED):
        try:
            tomb = set(json.load(open(REMOVED)).get("keys") or [])
        except Exception:
            tomb = set()
    status = {}
    if os.path.isfile(FEEDBACK):
        try:
            status = {k: v.get("status")
                      for k, v in (json.load(open(FEEDBACK)).get("entries") or {}).items()
                      if "#" not in k and isinstance(v, dict) and v.get("status")}
        except Exception:
            status = {}
    out, new = {}, 0
    for k in keys_seen:
        st = status.get(k)
        if st == "rejected":
            out[k] = True
            if k not in tomb:
                tomb.add(k); new += 1
        elif st:
            out[k] = False
            tomb.discard(k)
        else:
            out[k] = k in tomb
    tomb &= set(keys_seen)      # forget tiles whose art no longer exists
    doc = {
        "schema": "tiles3/fade-removals@1",
        "_comment": [
            "TILES THE MAINTAINER REMOVED FROM THE FADE LISTING - the durable record.",
            "The wiki prunes a feedback entry once the tile leaves index.json, which",
            "erased 772 verdicts and brought 770 removed tiles back. This file is what",
            "keeps a removal decided. An explicit non-rejected verdict in",
            "live/feedback/tiles.json clears an entry here; absence never does.",
            "The art itself is untouched and only the fade listing is affected.",
        ],
        "n_removed": len(tomb),
        "keys": sorted(tomb),
    }
    tmp = REMOVED + f".{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, REMOVED)
    return out, len(tomb), new


def review_verdicts():
    """key -> status from the maintainer's own feedback file, exact keys only.

    Keys carrying a facet suffix (`<key>#top`, the wiki's "not a detail" verdict) are
    a verdict on one USE of a tile, not on the tile - "the tile itself is untouched" -
    and are never read as one.
    """
    if not os.path.isfile(FEEDBACK):
        return {}
    try:
        d = json.load(open(FEEDBACK))
    except Exception:
        return {}
    return {k: v.get("status") for k, v in (d.get("entries") or {}).items()
            if "#" not in k and isinstance(v, dict) and v.get("status")}


def main():
    cache = _load_cache()
    fresh, reused, removed = 0, 0, 0
    candidates, rejected, n_valid = [], {}, 0
    for sheet in sheets():
        pk = f'{sheet["dominant"]}__to__{sheet["minor"]}'
        for i, name in enumerate(sheet["tiles"]):
            key = f'{sheet["dir"]}/{name[:-5]}'
            fp = _fingerprint(os.path.join(REPO, sheet["dir"], name))
            hit = cache.get(key)
            if hit and fp and hit.get("fp") == fp:
                reused += 1
                e, why = hit.get("entry"), hit.get("why")
            else:
                # A TILE THAT EXPLODES IS A REJECTED TILE, NOT A DEAD PUBLISH. One
                # unpack error inside the meter aborted the entire run, so the index was
                # never rewritten and the maintainer's removals silently stopped landing
                # while every status check still read "applied". Analysis is per tile and
                # independent; failure belongs to the tile.
                try:
                    e, why = analyse(sheet, i, name)
                except Exception as ex:
                    e, why = None, f"analysis failed: {type(ex).__name__}"
                fresh += 1
                cache[key] = {"fp": fp, "entry": e, "why": why}
            if e is None:
                rejected[why] = rejected.get(why, 0) + 1
            else:
                candidates.append((pk, key, e))

    # The review is applied to everything that PASSED the gate, in one place, and the
    # removals are remembered (see apply_review) so a verdict survives the wiki pruning
    # its own entry.
    drop, n_tomb, n_new = apply_review([k for _, k, _ in candidates])
    pairs = {}
    for pk, key, e in candidates:
        if drop.get(key):
            removed += 1                # the maintainer said remove; the art stays on disk
        else:
            pairs.setdefault(pk, []).append(e)
            n_valid += 1
    for pk in pairs:
        first = pk.split("__to__")[0]
        pairs[pk].sort(key=lambda e: -e["pct"][first])
    doc = {
        "schema": "tiles3/fade-tiles@1",
        "kind": "fade_top_only", "use_for": "transition", "wall_is_meaningless": True,
        "_comment": [
            "VALID fade tiles only, per the maintainer's rules: never 50/50, both",
            "grounds visibly present, and a rim that coherently belongs to ONE ground.",
            "PLACE BY edge_ground, NOT by pct majority: edge_ground is the ground the",
            "RIM belongs to, and a tile can be area-majority rock while sitting on ice",
            "(big rocks ON an ice sheet - maintainer ruling 2026-08-28). edge_contact",
            "is the share of rim NOT the edge ground, 0 = fully clean; moderate contact",
            "is allowed (tall features have height).",
            "pct is MEASURED from the published bytes named in `file`, never taken from",
            "the prompt. `key` is stable for the life of the art; verdicts ride on it.",
            "Rejected tiles stay on disk (raw sheets are never deleted) but are not",
            "listed here and should not be shown.",
            "REVIEW IS HONOURED: a key marked rejected in live/feedback/tiles.json",
            "(the wiki's remove button) is dropped from this index on every publish,",
            "and the removal is REMEMBERED in tiles/fades/removed.json - the wiki",
            "prunes its own entry once a tile leaves this index, which erased 772",
            "verdicts and brought 770 removed tiles back. Only the fade listing is",
            "affected; the art and the tile's other roles are untouched. An explicit",
            "approve brings a tile back; its entry merely going missing does not.",
        ],
        "review": {
            "source": "live/feedback/tiles.json entries[<key>].status, plus the durable "
                      "record in tiles/fades/removed.json",
            "rule": "rejected -> removed and remembered; an explicit non-rejected status "
                    "-> listed and the memory cleared; no entry -> the memory decides",
            "n_removed_by_review": removed,
            "n_remembered": n_tomb,
            "n_new_this_publish": n_new,
        },
        "classifier": FM.DESCRIPTION,
        "n_valid": n_valid,
        "n_rejected": rejected,
        "pairs": pairs,
    }
    ctmp = CACHE + f".{os.getpid()}.tmp"
    with open(ctmp, "w") as f:
        json.dump(cache, f)
    os.replace(ctmp, CACHE)
    print(f"analysed {fresh} new tiles, reused {reused} from cache")
    dst = os.path.join(FADES, "index.json")
    tmp = f"{dst}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, dst)
    print(f"valid: {n_valid}   rejected: {sum(rejected.values())}  {rejected}")
    print(f"removed by the maintainer's review: {removed} "
          f"({n_new} new this run; {n_tomb} remembered in removed.json)")
    for pk in sorted(pairs)[:8]:
        first = pk.split("__to__")[0]
        ps = [e["pct"][first] for e in pairs[pk]]
        print(f"  {pk}: {len(ps)} tiles, {first} {max(ps):.0f}%..{min(ps):.0f}%")


if __name__ == "__main__":
    main()
