"""characters2 HD candidates — high-detail STATE versions of the two heroes, for
the maintainer to choose the next base models from.

Maintainer 2026-09-13: "generate 10 high detail versions of the boy and 10 of
the girl … I also want the girl to look better. I generated them as states.
Once I'm happy and have selected the new versions it's time to regenerate the
animations. I will select what version will be the final characters."

A candidate is a PixelLab STATE of a pinned hero (POST /create-character-state):
one text edit applied consistently to all 8 rotations and saved as a sibling
character in the hero's group_id, so it appears beside the hero in the PixelLab
UI, where he picks. Picking = re-pointing config.json:pixellab_characters at the
winner's id and regenerating its animations there (sync.py then mirrors it like
any hero; README "HD candidate states"). The pinned characters are never
touched, nothing here carries the NPC tag, so the NPC mirror ignores it all.

  python characters2/pipeline/states.py plan                # exists / missing / cost so far
  python characters2/pipeline/states.py generate            # create the missing candidates (resumable)
  python characters2/pipeline/states.py generate --limit 1  # one, to read the price before the rest
  python characters2/pipeline/states.py generate --slots 11-20   # just a range of slots
  python characters2/pipeline/states.py mirror              # download every candidate + sheets + index

Resumable and never doubled: what exists is read from PixelLab (the hero's
group siblings whose state_name starts with "HD ") and from disk, never from
memory, so a re-run after a dead container creates only the missing slots.
Seeds derive from (hero, slot), so a re-run reproduces. The pool's generation
quota reads 0.0; this runs on the USD credits and stops below --min-usd, which
is the other domains' share of the same pool.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import shutil
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pixellab_client import DIRECTIONS_8, V2, PixelLabClient, PixelLabError   # noqa: E402
from sync import HUMANS, load_config, save_image, _read_json, _write_json  # noqa: E402

CANDIDATES = os.path.join(HUMANS, "_hd_candidates")   # "_" keeps it out of the wiki and the game manifest
INDEX = os.path.join(CANDIDATES, "index.json")
FORMAT = "characters2-hd-candidates@1"
PREFIX = "HD "            # every state this script creates is named "HD <slot> <brief>[ P]"
EXT = ".webp"

# --- the briefs ---------------------------------------------------------------
# Five edit briefs per hero x {free palette, palette snapped to the hero's own
# colours} = ten slots. The snap (use_color_palette_from_reference) is a real
# axis, not a repeat: it forbids colour drift — the maintainer's own HD take grew
# gold clasps and sandal straps on the girl — at the price of fewer shading
# tones. Every brief restates the locked design (the girl barefoot, bare-handed,
# plain band top + briefs in brown/black/grey/white, no blue; the boy shirtless
# in his plain dark briefs, no gear) because a state edit invents freely
# otherwise, and "the girl to look better" is carried by the face / figure /
# hair briefs rather than by a different design.

GIRL_RULES = (
    " Keep the exact same pose, silhouette, proportions, camera view and canvas, and"
    " the same skin, hair and cloth colours. She stays barefoot with bare hands: no"
    " shoes, sandals, ankle wraps, gloves, bracers, jewellery, straps, buckles, clasps"
    " or metal. Her clothing is only the plain cloth band top and plain briefs, in"
    " brown, black, grey or white only — absolutely no blue cloth, nothing added.")
BOY_RULES = (
    " Keep the exact same pose, silhouette, proportions, camera view and canvas, and"
    " the same skin, hair and cloth colours. He stays shirtless and barefoot with bare"
    " hands, wearing only his plain dark briefs: no shoes, gloves, bracers, jewellery,"
    " straps, belts, weapons or gear of any kind; only black, brown, grey or white on"
    " the cloth — absolutely no blue, nothing added.")

BRIEFS = {
    "default_girl": {
        "refined": (
            "High detail version of this character: the same design redrawn with fine"
            " detail. Individual dark brown hair strands with soft highlights; a sharper"
            " face with defined brows, expressive fierce eyes, cheekbones and a small"
            " confident mouth; subtle muscle definition on the arms, abs and legs; more"
            " shading steps on the skin with soft highlights and shadows; visible woven"
            " texture on the plain top and briefs." + GIRL_RULES),
        "face": (
            "High detail version with a strikingly beautiful, fierce heroine face:"
            " large expressive eyes with defined lashes and brows, high cheekbones, a"
            " small nose, full lips with a confident half-smile, a clean jawline and"
            " smooth skin shading with soft highlights. Hair drawn as glossy dark brown"
            " strands with highlights. The body keeps its athletic build, with cleaner"
            " anatomy and more shading tones." + GIRL_RULES),
        "figure": (
            "High detail version with a more heroic, athletic figure: lean defined"
            " muscles on the shoulders, arms, abs, thighs and calves, a strong upright"
            " posture, a balanced readable silhouette, skin rendered with more shading"
            " tones and highlights, and the face sharpened with fierce determined eyes"
            " and defined brows." + GIRL_RULES),
        "hair": (
            "High detail version with richer hair: a full glossy dark brown high"
            " ponytail with volume, individual strands and highlights and a few loose"
            " strands framing the face; the face refined with expressive fierce eyes,"
            " defined brows and a confident mouth; more shading tones on skin and"
            " cloth." + GIRL_RULES),
        "shading": (
            "High detail version with painterly pixel-art shading: four to five tones"
            " per material, soft light from the upper left, warm highlights on skin and"
            " hair, a subtle rim light along the silhouette, a crisp single-colour dark"
            " outline, and the face and anatomy cleanly refined." + GIRL_RULES),
    },
    "default_boy": {
        "refined": (
            "High detail version of this character: the same design redrawn with fine"
            " detail. Tousled dark brown hair drawn as individual strands with"
            " highlights; a sharper handsome face with a strong jaw, defined brows,"
            " piercing eyes and a slight determined smirk; defined chest, abs, shoulders"
            " and arms; more shading steps on the skin with soft highlights and shadows;"
            " visible cloth texture on the plain briefs." + BOY_RULES),
        "face": (
            "High detail version with a striking, handsome, fierce hero face: sharp"
            " intelligent eyes with defined brows, a strong jawline, a straight nose,"
            " a confident slightly smirking mouth and smooth skin shading with soft"
            " highlights. Hair drawn as windswept dark brown strands with highlights."
            " The body keeps its athletic build, with cleaner anatomy and more shading"
            " tones." + BOY_RULES),
        "figure": (
            "High detail version with a more heroic, athletic figure: broad strong"
            " shoulders, defined chest, abs, arms, thighs and calves, a lean powerful"
            " frame, a self-assured upright posture, a balanced readable silhouette,"
            " skin rendered with more shading tones and highlights, and the face"
            " sharpened with piercing determined eyes." + BOY_RULES),
        "hair": (
            "High detail version with richer hair: short-to-medium tousled dark brown"
            " hair, windswept and slightly messy, drawn as individual strands with"
            " highlights and depth; the face refined with sharp eyes, defined brows and"
            " a determined smirk; more shading tones on skin and cloth." + BOY_RULES),
        "shading": (
            "High detail version with painterly pixel-art shading: four to five tones"
            " per material, soft light from the upper left, warm highlights on skin and"
            " hair, a subtle rim light along the silhouette, a crisp single-colour dark"
            " outline, and the face and anatomy cleanly refined." + BOY_RULES),
    },
}
BRIEF_ORDER = ("refined", "face", "figure", "hair", "shading")

# Slots 11-20: THE MAINTAINER'S OWN PROMPT, VERBATIM (2026-09-13: "My prompt was
# 'High detail version' and my version looks best. Generate 10 more with my
# prompt"), free palette like his own take, ten seeds. His wording is the design
# lock there, not the briefs above; the ten are a seed spread of it.
YOURS = {
    "default_girl": "High detail version, new face and hair, don't change her cloth. Bikini only.",
    "default_boy": "High detail version, don't change his cloth. Speedos only.",
}
# 2026-09-13 (later): "15 more girls. Same prompt" — the girl carries 25 of
# these slots (HD 11-35), the boy 10 (HD 11-20).
YOURS_COUNT = {"default_girl": 25, "default_boy": 10}


def _slot(hero, n, brief, snap, edit):
    return {"slot": n, "brief": brief, "palette_snap": snap,
            "state_name": f"{PREFIX}{n:02d} {brief}{' P' if snap else ''}",
            "seed": int(hashlib.sha1(f"{hero}/{n}".encode()).hexdigest()[:7], 16),
            "edit_description": edit}


def slots(hero):
    """The (slot, brief, palette_snap, state_name, seed) rows of one hero:
    01-10 the five briefs, odd free and even snapped to the hero's palette;
    11-N the maintainer's prompt (`yours`), free, one seed each (N = 10 +
    YOURS_COUNT[hero]: the girl 35, the boy 20)."""
    out = []
    n = 0
    for brief in BRIEF_ORDER:
        for snap in (False, True):
            n += 1
            out.append(_slot(hero, n, brief, snap, BRIEFS[hero][brief]))
    for _ in range(YOURS_COUNT[hero]):
        n += 1
        out.append(_slot(hero, n, "yours", False, YOURS[hero]))
    return out


# --- discovery (PixelLab + disk, never memory) --------------------------------

def pinned():
    return load_config().get("pixellab_characters") or {}


def group_siblings(client, listing, hero_id, hero_detail):
    gid = hero_detail.get("group_id")
    if not gid:
        return []
    return [c for c in listing if c.get("group_id") == gid and c.get("id") != hero_id]


def _id8(cid):
    return cid[:8]


def _now():
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def state_path(hero, cid):
    return os.path.join(CANDIDATES, hero, _id8(cid), "state.json")


def survey(client):
    """{hero: {"id", "detail", "siblings": [...], "by_name": {state_name: [sib]}}}."""
    listing = client.list_characters()
    out = {}
    for hero, hid in pinned().items():
        detail = client.get_character(hid)
        sibs = group_siblings(client, listing, hid, detail)
        by_name = {}
        for s in sibs:
            by_name.setdefault(s.get("state_name") or "", []).append(s)
        out[hero] = {"id": hid, "detail": detail, "siblings": sibs, "by_name": by_name}
    return out


# --- generate -----------------------------------------------------------------

def _parse_slots(spec):
    """'11-20' / '3,7,12' -> set of slot numbers; None when unset."""
    if not spec:
        return None
    out = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        elif part:
            out.add(int(part))
    return out


def generate(client, args):
    sv = survey(client)
    heroes = [h for h in pinned() if not args.hero or h == args.hero]
    todo = []
    wanted = _parse_slots(args.slots)
    for hero in heroes:
        for row in slots(hero):
            if wanted is not None and row["slot"] not in wanted:
                continue
            have = sv[hero]["by_name"].get(row["state_name"]) or []
            live = [s for s in have if (s.get("status") or "completed") != "failed"]
            if live:
                continue
            todo.append((hero, row, have))
    if args.limit:
        todo = todo[:args.limit]
    if not todo:
        print("nothing to create — every slot exists on PixelLab (run `mirror`).")
        return
    credits = client.usd_credits()
    print(f"credits: ${credits:.2f} | floor ${args.min_usd:.2f} | {len(todo)} slot(s) to create, "
          f"{args.parallel} at a time")
    spent = 0.0
    for i in range(0, len(todo), args.parallel):
        batch = todo[i:i + args.parallel]
        jobs = []
        for hero, row, failed in batch:
            credits = client.usd_credits()
            if credits < args.min_usd:
                print(f"! credits ${credits:.2f} below the floor ${args.min_usd:.2f} — stopping "
                      f"(spent ${spent:.2f} this run). Re-run to resume.")
                return
            for f in failed:                      # a failed sibling of this name: replace it
                print(f"  · deleting failed state {f['id']} ({row['state_name']})")
                client.delete_character(f["id"])
            hid = sv[hero]["id"]
            resp = client.create_character_state(
                hid, row["edit_description"], seed=row["seed"], state_name=row["state_name"],
                use_color_palette_from_reference=row["palette_snap"])
            cid = resp.get("character_id")
            usage = resp.get("usage") or {}
            usd = usage.get("usd")
            spent += float(usd or 0)
            rec = {**row, "hero": hero, "source_character_id": hid,
                   "pixellab_character_id": cid, "background_job_id": resp.get("background_job_id"),
                   "usage": usage, "created_at": _now(), "origin": "characters2-assistant",
                   "status": "queued"}
            _write_json(state_path(hero, cid), rec)
            jobs.append((hero, row, cid, resp.get("background_job_id")))
            print(f"+ {hero} {row['state_name']!r} seed={row['seed']} snap={row['palette_snap']} "
                  f"-> {cid} | usage {json.dumps(usage)}")
        for hero, row, cid, job in jobs:
            rec = _read_json(state_path(hero, cid), {}) or {}
            try:
                j = client.wait_job(job, timeout=args.job_timeout)
                rec["status"] = "completed"
                # the price is on the finished JOB, not on the create response
                # (which answers usage {} — measured 2026-09-13: $0.12 a state)
                rec["usage"] = j.get("usage") or rec.get("usage") or {}
            except PixelLabError as e:
                rec["status"] = "failed"; rec["error"] = str(e)[:300]
                print(f"  ! {hero} {row['state_name']!r} FAILED: {e}")
            _write_json(state_path(hero, cid), rec)
        print(f"  batch done | spent ${spent:.2f} this run | credits ${client.usd_credits():.2f}")
    print(f"created {len(todo)} state(s) for ${spent:.2f}. Now: states.py mirror")


# --- mirror + sheets + index ----------------------------------------------------

def mirror_candidate(client, hero, sib, origin, row=None):
    """Download one sibling's 8 rotations into _hd_candidates/<hero>/<id8>/ as
    lossless WebP (+ preview strip), merge the creation record, return the
    index row. Skips the download when every rotation URL already matches."""
    cid = sib["id"]
    folder = os.path.join(CANDIDATES, hero, _id8(cid))
    os.makedirs(folder, exist_ok=True)
    spath = os.path.join(folder, "state.json")
    rec = _read_json(spath, {}) or {}
    if row:
        for k in ("slot", "brief", "palette_snap", "seed", "edit_description"):
            rec.setdefault(k, row[k])
    detail = client.get_character(cid)
    urls = {d: u for d, u in (detail.get("rotation_urls") or {}).items() if u}
    status = detail.get("status") or "completed"
    if rec.get("background_job_id") and not (rec.get("usage") or {}).get("usd"):
        try:                                     # backfill the price from the job record
            j = client._request("GET", f"{V2}/background-jobs/{rec['background_job_id']}")
            if j.get("usage"):
                rec["usage"] = j["usage"]
        except PixelLabError:
            pass
    changed = False
    if status == "completed" and urls:
        need = [d for d in DIRECTIONS_8 if d in urls
                and ((rec.get("rotations") or {}).get(d) != urls[d]
                     or not os.path.exists(os.path.join(folder, d + EXT)))]
        if need:
            imgs = client.character_rotations(cid)
            for d in need:
                if d in imgs:
                    save_image(imgs[d], os.path.join(folder, d + EXT)); changed = True
        rec["rotations"] = urls
        strip = _strip(folder)
        if strip is not None:
            save_image(strip, os.path.join(folder, "preview" + EXT))
    rec.update({
        "hero": hero, "pixellab_character_id": cid, "state_name": detail.get("state_name"),
        "pixellab_name": detail.get("name"), "group_id": detail.get("group_id"),
        "size": [detail.get("size", {}).get("width"), detail.get("size", {}).get("height")],
        "style_settings": detail.get("style_settings"), "created_on_pixellab": detail.get("created_at"),
        "status": status, "origin": rec.get("origin") or origin,
        "animation_count": detail.get("animation_count"),
    })
    _write_json(spath, rec)
    return rec, changed


def _strip(folder):
    imgs = [Image.open(os.path.join(folder, d + EXT)).convert("RGBA")
            for d in DIRECTIONS_8 if os.path.exists(os.path.join(folder, d + EXT))]
    if not imgs:
        return None
    w = max(i.width for i in imgs); h = max(i.height for i in imgs)
    strip = Image.new("RGBA", (w * len(imgs), h), (0, 0, 0, 0))
    for i, im in enumerate(imgs):
        strip.alpha_composite(im, (i * w, 0))
    return strip


def _font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _sheet(hero, base_folder, rows):
    """One tall contact sheet: the pinned hero first, then every candidate — the
    8-direction strip at 2x under a label line. Long and narrow on purpose:
    the maintainer reviews on a PHONE, so it scrolls and pinch-zooms."""
    scale, pad, label_h, bg = 2, 8, 30, (58, 58, 62, 255)
    strips = []
    for label, folder in rows:
        s = _strip(folder)
        if s is not None:
            strips.append((label, s.resize((s.width * scale, s.height * scale), Image.NEAREST)))
    if not strips:
        return None
    w = max(s.width for _, s in strips) + 2 * pad
    row_h = max(s.height for _, s in strips) + label_h + pad
    sheet = Image.new("RGBA", (w, row_h * len(strips) + pad), bg)
    draw = ImageDraw.Draw(sheet)
    font = _font(20)
    for i, (label, s) in enumerate(strips):
        y = pad + i * row_h
        draw.text((pad, y), label, fill=(245, 245, 240, 255), font=font)
        sheet.alpha_composite(s, (pad, y + label_h))
    return sheet


def _publish_hashed(folder, stem, img, prev_name):
    """Write `stem.<sha8>.webp`, never a stable name (the cache law), keep the
    previous one, drop older siblings. Returns (current, previous)."""
    tmp = os.path.join(folder, f".{stem}.tmp.webp")
    save_image(img, tmp)
    with open(tmp, "rb") as f:
        sha8 = hashlib.sha256(f.read()).hexdigest()[:8]
    name = f"{stem}.{sha8}.webp"
    dst = os.path.join(folder, name)
    if os.path.exists(dst):
        os.remove(tmp)
    else:
        os.replace(tmp, dst)
    prev = prev_name if prev_name and prev_name != name else None
    if prev_name and prev_name != name and not os.path.exists(os.path.join(folder, prev_name)):
        prev = None
    for fn in os.listdir(folder):
        if fn.startswith(stem + ".") and fn.endswith(".webp") and fn not in (name, prev):
            os.remove(os.path.join(folder, fn))
    return name, prev


def mirror(client, args):
    sv = survey(client)
    index = _read_json(INDEX, {}) or {}
    heroes_out = {}
    spent_total = 0.0
    for hero, info in sv.items():
        if args.hero and hero != args.hero:
            continue
        my_rows = {r["state_name"]: r for r in slots(hero)}
        cands = []
        changed_any = False
        for sib in sorted(info["siblings"], key=lambda s: s.get("created_at") or ""):
            name = sib.get("state_name") or ""
            origin = "characters2-assistant" if name.startswith(PREFIX) else "maintainer"
            rec, changed = mirror_candidate(client, hero, sib, origin, my_rows.get(name))
            changed_any |= changed
            cands.append(rec)
            usd = (rec.get("usage") or {}).get("usd")
            if usd:
                spent_total += float(usd)
            print(f"  {hero} {name!r:22} {_id8(sib['id'])} {rec['status']:9} "
                  f"{'(new files)' if changed else ''}")
        # true mirror: a candidate deleted in the PixelLab UI leaves the tree too
        hero_dir = os.path.join(CANDIDATES, hero)
        keep = {_id8(s["id"]) for s in info["siblings"]}
        for fn in (sorted(os.listdir(hero_dir)) if os.path.isdir(hero_dir) else []):
            p = os.path.join(hero_dir, fn)
            if os.path.isdir(p) and fn not in keep:
                shutil.rmtree(p); print(f"  {hero}: pruned {fn} (no longer on PixelLab)")
        # order: the maintainer's own takes first, then mine by slot
        cands.sort(key=lambda r: (r.get("origin") != "maintainer", r.get("slot") or 0,
                                  r.get("created_on_pixellab") or ""))
        hero_folder = os.path.join(CANDIDATES, hero)
        os.makedirs(hero_folder, exist_ok=True)
        # plain ASCII + "·" only: Pillow's bundled font draws an em dash as tofu
        rows = [(f"{hero} · the pinned hero today · {_id8(info['id'])} · low detail",
                 os.path.join(HUMANS, hero, "base"))]
        for r in cands:
            lab = (f"{r.get('state_name')}  ·  {_id8(r['pixellab_character_id'])}  ·  "
                   f"{'maintainer' if r.get('origin') == 'maintainer' else 'seed ' + str(r.get('seed'))}"
                   + ("  ·  palette snapped" if r.get("palette_snap") else "")
                   + (f"  ·  {r['status']}" if r.get("status") != "completed" else ""))
            rows.append((lab, os.path.join(hero_folder, _id8(r["pixellab_character_id"]))))
        sheet = _sheet(hero, os.path.join(HUMANS, hero, "base"), rows)
        prev_rec = (index.get("heroes") or {}).get(hero) or {}
        sheet_name, sheet_prev = (None, None)
        if sheet is not None:
            sheet_name, sheet_prev = _publish_hashed(hero_folder, "sheet", sheet,
                                                     os.path.basename(prev_rec.get("sheet") or ""))
        heroes_out[hero] = {
            "pixellab_character_id": info["id"],
            "group_id": info["detail"].get("group_id"),
            "sheet": f"{hero}/{sheet_name}" if sheet_name else None,
            "sheet_prev": f"{hero}/{sheet_prev}" if sheet_prev else None,
            "candidates": [{
                "folder": f"{hero}/{_id8(r['pixellab_character_id'])}",
                "pixellab_character_id": r["pixellab_character_id"],
                "state_name": r.get("state_name"),
                "origin": r.get("origin"),
                "slot": r.get("slot"), "brief": r.get("brief"),
                "palette_snap": r.get("palette_snap"), "seed": r.get("seed"),
                "usage_usd": (r.get("usage") or {}).get("usd"),
                "status": r.get("status"),
                "rotations": sum(1 for d in DIRECTIONS_8
                                 if os.path.exists(os.path.join(hero_folder, _id8(r["pixellab_character_id"]), d + EXT))),
                "created_on_pixellab": r.get("created_on_pixellab"),
            } for r in cands],
        }
        print(f"{hero}: {len(cands)} candidate(s) mirrored; sheet {sheet_name}")
    if args.hero:                                   # keep the other hero's block
        for h, blk in (index.get("heroes") or {}).items():
            heroes_out.setdefault(h, blk)
    _write_json(INDEX, {
        "format": FORMAT,
        "_comment": "High-detail STATE candidates of the two heroes (states.py). Each is a "
                    "PixelLab sibling of the pinned hero (same group_id); the maintainer "
                    "picks in the PixelLab UI, then config.json:pixellab_characters is "
                    "re-pointed and the animations regenerated. Never loaded by the game "
                    "or the wiki (the _ prefix). Sheets are content-hashed, current + prev.",
        "updated_at": _now(),
        "usd_spent_by_assistant": round(spent_total, 4),
        "heroes": heroes_out,
    })
    print(f"index written: {os.path.relpath(INDEX, os.getcwd())} | assistant states so far ${spent_total:.2f}")


# --- plan ---------------------------------------------------------------------

def plan(client, args):
    sv = survey(client)
    print(f"credits: ${client.usd_credits():.2f} | generations: {client.generations_remaining():.1f}")
    for hero, info in sv.items():
        print(f"\n{hero}  pinned {info['id']}  group {info['detail'].get('group_id')}")
        for name, sibs in info["by_name"].items():
            if not name.startswith(PREFIX):
                for s in sibs:
                    print(f"  maintainer's  {name!r:24} {s['id']}  {s.get('status')}  anims={s.get('animation_count')}")
        for row in slots(hero):
            have = info["by_name"].get(row["state_name"]) or []
            if have:
                for s in have:
                    rec = _read_json(state_path(hero, s["id"]), {}) or {}
                    usd = (rec.get("usage") or {}).get("usd")
                    print(f"  {row['state_name']:18} {s['id']}  {s.get('status'):9}"
                          f"  ${usd:.3f}" if usd is not None else
                          f"  {row['state_name']:18} {s['id']}  {s.get('status')}")
            else:
                print(f"  {row['state_name']:18} — missing (seed {row['seed']}, "
                      f"{'palette snapped' if row['palette_snap'] else 'free palette'})")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("cmd", choices=("plan", "generate", "mirror"))
    ap.add_argument("--hero", default=None, help="default_boy | default_girl (default: both)")
    ap.add_argument("--limit", type=int, default=0, help="generate at most N states this run")
    ap.add_argument("--slots", default=None, help="only these slot numbers, e.g. 11-20 or 3,7")
    ap.add_argument("--parallel", type=int, default=5, help="states in flight at once (PixelLab caps the account at 20)")
    ap.add_argument("--min-usd", type=float, default=30.0,
                    help="stop when the USD credits fall below this (the other domains' share)")
    ap.add_argument("--job-timeout", type=int, default=1200)
    args = ap.parse_args()
    client = PixelLabClient()
    {"plan": plan, "generate": generate, "mirror": mirror}[args.cmd](client, args)


if __name__ == "__main__":
    main()
