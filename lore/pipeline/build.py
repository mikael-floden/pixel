#!/usr/bin/env python3
"""Build lore/lore.json and check the canon against the live repo.

Two jobs, and the second is the important one.

1. Roll up `lore/entries/*/entry.json` and `lore/entities/<domain>/<id>.json`
   into a single `lore/lore.json` (format `pixel-lore@1`) that `wiki/build.mjs`
   can read with one `readJson` call.

2. Verify every claim the lore makes about the rest of the repo. Other agents
   delete, rename and regenerate their entities continuously; this is how the
   lore agent finds out. Every dangling reference and every drifted display
   name is reported.

Exit code is 0 when the canon is whole, 1 when it is not. Nothing is written
outside `lore/`.

    python3 lore/pipeline/build.py            # build + check
    python3 lore/pipeline/build.py --check    # check only, write nothing
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

LORE = Path(__file__).resolve().parent.parent
ROOT = LORE.parent

# The wiki reserves the height of the LONGEST short description in a domain, so
# one long entry makes every page in that domain that tall. Our descriptions
# now REPLACE the owning domain's, so the guarantee we need is simply: never be
# longer than the longest text that domain already ships. Then substituting
# ours can never grow the layout by a single pixel.
#
# The cap is therefore measured from the live repo per domain (see
# domain_caps()), not hardcoded — it stays correct when other agents rewrite
# their own copy. FALLBACK_CAP applies only to a domain with no text at all.
FALLBACK_CAP = 120
MAX_SUMMARY = 200

# The wiki inserts every string as a text node: markup ships as literal
# characters. Catch the syntaxes a writer reaches for by reflex.
MARKUP = re.compile(r"\[\[|\]\]|<[a-zA-Z/]|\*\*|^#{1,6}\s|^\s*[-*]\s", re.M)

ID_RE = re.compile(r"^[a-z0-9_-]+$")

# Every entry carries an icon. One that names none falls back to this.
DEFAULT_ICON = "rune"


def icon_path(icon_id: str) -> str:
    return f"lore/icons/{icon_id}.png"


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as exc:
        raise SystemExit(f"FATAL: {path} is not valid JSON: {exc}")


def as_list(doc, key: str) -> list:
    """Rosters are sometimes a bare list, sometimes {key: [...]}."""
    if doc is None:
        return []
    if isinstance(doc, list):
        return doc
    value = doc.get(key)
    return value if isinstance(value, list) else []


# ---------------------------------------------------------------- live repo

def live_descriptions() -> dict[str, list[str]]:
    """The short descriptions each domain ships today, per wiki domain.

    Used to derive the layout budget: our replacement text must never be longer
    than the longest string the domain already renders in that slot.
    """
    out: dict[str, list[str]] = {}

    monsters = read_json(ROOT / "monsters" / "config" / "roster.json")
    out["monsters"] = [m["lore"] for m in as_list(monsters, "monsters") if m.get("lore")]

    items = read_json(ROOT / "items" / "config" / "roster.json")
    out["items"] = [i["description"] for i in as_list(items, "items") if i.get("description")]

    chars = read_json(ROOT / "characters2" / "metadata.json") or {}
    record = chars.get("characters", chars) if isinstance(chars, dict) else {}
    out["characters"] = [
        r["lore"] for r in record.values() if isinstance(r, dict) and r.get("lore")
    ]

    objects_dir = ROOT / "objects"
    out["objects"] = []
    if objects_dir.is_dir():
        for child in sorted(p for p in objects_dir.iterdir() if p.is_dir()):
            meta = read_json(child / "object.json") or {}
            if meta.get("description"):
                out["objects"].append(meta["description"])

    tiles = read_json(ROOT / "tiles2" / "config" / "tiles2.json")
    out["tiles"] = [
        t["description"] for t in as_list(tiles, "ground_types") if t.get("description")
    ]

    return out


def domain_caps() -> dict[str, int]:
    """Per-domain character budget for our short description."""
    return {
        domain: (max(len(t) for t in texts) if texts else FALLBACK_CAP)
        for domain, texts in live_descriptions().items()
    }


def live_ids() -> dict[str, dict[str, str]]:
    """The ids that actually exist right now, per wiki domain -> {id: name}.

    Read from each domain's own source of truth. A domain that is missing (or
    has been retired) yields an empty map rather than an error: absence is a
    fact about the repo, not a failure of this tool.
    """
    ids: dict[str, dict[str, str]] = {}

    monsters = read_json(ROOT / "monsters" / "config" / "roster.json")
    ids["monsters"] = {
        m["id"]: m.get("name", m["id"]) for m in as_list(monsters, "monsters") if m.get("id")
    }

    items = read_json(ROOT / "items" / "config" / "roster.json")
    ids["items"] = {
        i["id"]: i.get("name", i["id"]) for i in as_list(items, "items") if i.get("id")
    }

    chars = read_json(ROOT / "characters2" / "metadata.json") or {}
    record = chars.get("characters", chars) if isinstance(chars, dict) else {}
    ids["characters"] = {
        cid: (rec or {}).get("display_name", cid)
        for cid, rec in record.items()
        if isinstance(rec, dict)
    }

    objects_dir = ROOT / "objects"
    ids["objects"] = {}
    if objects_dir.is_dir():
        for child in sorted(p for p in objects_dir.iterdir() if p.is_dir()):
            meta = read_json(child / "object.json")
            if meta:
                ids["objects"][child.name] = meta.get("name", child.name)

    tiles = read_json(ROOT / "tiles2" / "config" / "tiles2.json")
    ids["tiles"] = {
        t["id"]: t.get("name", t["id"]) for t in as_list(tiles, "ground_types") if t.get("id")
    }

    return ids


# ---------------------------------------------------------------- lore files

def load_entries() -> list[dict]:
    out = []
    base = LORE / "entries"
    if not base.is_dir():
        return out
    for child in sorted(base.iterdir()):
        entry = read_json(child / "entry.json")
        if entry is None:
            continue
        entry["_src"] = f"lore/entries/{child.name}/entry.json"
        entry["_folder"] = child.name
        out.append(entry)
    return out


def load_entities() -> list[dict]:
    out = []
    base = LORE / "entities"
    if not base.is_dir():
        return out
    for domain_dir in sorted(base.iterdir()):
        if not domain_dir.is_dir():
            continue
        for path in sorted(domain_dir.glob("*.json")):
            rec = read_json(path)
            if rec is None:
                continue
            rec["_src"] = f"lore/entities/{domain_dir.name}/{path.name}"
            rec["_folder_domain"] = domain_dir.name
            rec["_stem"] = path.stem
            out.append(rec)
    return out


# ---------------------------------------------------------------- validation

def check_text(where: str, label: str, text: str, limit: int, problems: list[str]) -> None:
    if len(text) > limit:
        problems.append(f"{where}: {label} is {len(text)} chars, limit {limit}")
    if MARKUP.search(text):
        problems.append(
            f"{where}: {label} contains markup — the wiki renders plain text nodes only"
        )


def validate(entries, entities, live, caps) -> tuple[list[str], list[str], list[str]]:
    problems: list[str] = []
    drift: list[str] = []
    hidden: list[str] = []

    lore_ids = {e.get("id") for e in entries}
    # An entity we have written a `lore` array for has a story to read. The wiki
    # HIDES a cross-reference whose target has none — landing a reader on a stat
    # sheet after they chose "read next" is worse than not offering the link.
    # So a ref to a story-less target is not broken, it is just dead weight, and
    # we want to hear about it here rather than from the wiki agent.
    with_story = {
        dom: {i for i, rec in recs.items() if rec.get("lore")}
        for dom, recs in (
            (d, {r["id"]: r for r in entities if r.get("domain") == d})
            for d in {r.get("domain") for r in entities}
        )
    }

    def check_related(where: str, related) -> None:
        for ref in related or []:
            domain, rid = ref.get("domain"), ref.get("id")
            if not domain or not rid:
                problems.append(f"{where}: malformed related entry {ref!r}")
                continue
            if domain == "lore":
                if rid not in lore_ids:
                    problems.append(f"{where}: references lore/{rid}, which does not exist")
            elif domain in live:
                if rid not in live[domain]:
                    problems.append(
                        f"{where}: references {domain}/{rid}, which is GONE from the repo"
                    )
                elif rid not in with_story.get(domain, set()):
                    hidden.append(
                        f"{where}: links to {domain}/{rid}, which has no lore of its own — "
                        f"the wiki HIDES this link until it does"
                    )
            else:
                problems.append(f"{where}: unknown domain {domain!r} in related")

    for e in entries:
        where = e["_src"]
        eid = e.get("id")
        if not eid or not ID_RE.match(eid):
            problems.append(f"{where}: id {eid!r} must match [a-z0-9_-]+")
        elif eid != e["_folder"]:
            problems.append(f"{where}: id {eid!r} does not match folder {e['_folder']!r}")
        if not e.get("name"):
            problems.append(f"{where}: missing name")
        summary = e.get("summary", "")
        if not summary:
            problems.append(f"{where}: missing summary")
        else:
            check_text(where, "summary", summary, MAX_SUMMARY, problems)
        body = e.get("body")
        if not isinstance(body, list) or not body:
            problems.append(f"{where}: body must be a non-empty array of paragraphs")
        else:
            for n, para in enumerate(body):
                if not isinstance(para, str):
                    problems.append(f"{where}: body[{n}] is not a string")
                elif MARKUP.search(para):
                    problems.append(f"{where}: body[{n}] contains markup")
        icon = e.get("icon", DEFAULT_ICON)
        if not ID_RE.match(icon):
            problems.append(f"{where}: icon {icon!r} must match [a-z0-9_-]+")
        elif not (ROOT / icon_path(icon)).is_file():
            problems.append(
                f"{where}: icon {icon!r} has no art at {icon_path(icon)} — "
                f"add the 48x48 png or drop the field to fall back to {DEFAULT_ICON!r}"
            )
        check_related(where, e.get("related"))

    for rec in entities:
        where = rec["_src"]
        domain, rid = rec.get("domain"), rec.get("id")
        if domain != rec["_folder_domain"]:
            problems.append(
                f"{where}: domain {domain!r} does not match folder {rec['_folder_domain']!r}"
            )
        if rid != rec["_stem"]:
            problems.append(f"{where}: id {rid!r} does not match filename {rec['_stem']!r}")
        if domain not in live:
            problems.append(f"{where}: unknown domain {domain!r}")
        elif rid not in live[domain]:
            problems.append(
                f"{where}: {domain}/{rid} is GONE from the repo — it went Quiet, delete this file"
            )
        else:
            # Display names drift; ids do not. Report so prose can be re-read.
            seen, actual = rec.get("name_seen"), live[domain][rid]
            if seen and seen != actual:
                drift.append(
                    f"{where}: name drifted {seen!r} -> {actual!r} "
                    f"(check any prose that quotes the old name)"
                )
        desc = rec.get("description", "")
        if not desc:
            problems.append(f"{where}: missing description (the short line under the name)")
        else:
            cap = caps.get(domain, FALLBACK_CAP)
            if len(desc) > cap:
                problems.append(
                    f"{where}: description is {len(desc)} chars but the {domain} layout "
                    f"budget is {cap} (the longest that domain ships today) — "
                    f"a longer one makes EVERY {domain} page taller"
                )
            if MARKUP.search(desc):
                problems.append(f"{where}: description contains markup")
        lore = rec.get("lore")
        if lore is not None and (not isinstance(lore, list) or not lore):
            problems.append(f"{where}: lore must be a non-empty array of paragraphs")
        for n, para in enumerate(lore or []):
            if not isinstance(para, str):
                problems.append(f"{where}: lore[{n}] is not a string")
            elif MARKUP.search(para):
                problems.append(f"{where}: lore[{n}] contains markup")
        check_related(where, rec.get("related"))

    return problems, drift, hidden


# ---------------------------------------------------------------- rollup

def build(entries, entities, budget) -> dict:
    by_domain: dict[str, dict[str, dict]] = {}
    for rec in entities:
        payload = {"description": rec["description"]}
        if rec.get("lore"):
            payload["lore"] = rec["lore"]
        if rec.get("related"):
            payload["related"] = rec["related"]
        by_domain.setdefault(rec["domain"], {})[rec["id"]] = payload

    published = []
    for e in sorted(entries, key=lambda x: (x.get("chapter") or 999, x.get("id", ""))):
        icon = e.get("icon", DEFAULT_ICON)
        out = {
            "id": e["id"],
            "name": e["name"],
            "path": f"lore/entries/{e['id']}",
            "icon": icon_path(icon),
            "icon_id": icon,
            "category": e.get("category", "chapter"),
            "summary": e["summary"],
            "body": e["body"],
            "related": e.get("related", []),
            "tags": e.get("tags", []),
        }
        if e.get("chapter") is not None:
            out["chapter"] = e["chapter"]
        cover = LORE / "entries" / e["id"] / "cover.png"
        out["preview"] = f"lore/entries/{e['id']}/cover.png" if cover.is_file() else None
        published.append(out)

    return {
        "format": "pixel-lore@1",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": (
            "Authored by the lore agent, keyed by the owning domain's folder id. "
            "entities.<domain>.<id>.description is the SHORT line shown under the "
            "entity's name — it REPLACES the domain's own description, and is "
            "guaranteed never to be longer than the longest text that domain "
            "already ships, so substituting it cannot grow the layout. "
            "entities.<domain>.<id>.lore is the LONG read-more text, an array of "
            "paragraphs, shown only if the reader expands it; no length limit. "
            "'entries' are standalone articles (chapters, peoples, places). "
            "Plain text only — no markup. Cross-references are {domain, id} pairs. "
            "Every entry carries an 'icon' (repo-relative path to a 48x48 png) — "
            "draw it at whole multiples of 48 with image-rendering: pixelated, "
            "never at a fractional width. See lore/icons/icons.json."
        ),
        "layout_budget": budget,
        "default_icon": icon_path(DEFAULT_ICON),
        "entities": by_domain,
        "entries": published,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="validate only, write nothing")
    args = ap.parse_args()

    entries, entities = load_entries(), load_entities()
    live, caps = live_ids(), domain_caps()
    problems, drift, hidden = validate(entries, entities, live, caps)

    for line in drift:
        print(f"DRIFT   {line}")
    for line in hidden:
        print(f"HIDDEN  {line}")
    for line in problems:
        print(f"BROKEN  {line}")

    counts = " · ".join(f"{d} {len(v)}" for d, v in sorted(live.items()))
    covered: dict[str, int] = {}
    longest: dict[str, int] = {}
    for rec in entities:
        d = rec.get("domain", "?")
        covered[d] = covered.get(d, 0) + 1
        longest[d] = max(longest.get(d, 0), len(rec.get("description", "")))
    print(
        f"\nlore: {len(entries)} entries, {len(entities)} entity records\n"
        f"repo: {counts}"
    )
    for d in sorted(covered):
        print(
            f"  {d}: {covered[d]}/{len(live.get(d, {}))} covered · "
            f"longest description {longest[d]} / budget {caps.get(d, FALLBACK_CAP)}"
        )

    if problems:
        print(f"\nCANON BROKEN — {len(problems)} problem(s). Nothing written.")
        return 1

    if args.check:
        print("\nCanon whole. (--check: nothing written.)")
        return 0

    out = LORE / "lore.json"
    out.write_text(
        json.dumps(build(entries, entities, caps), indent=2) + "\n", encoding="utf-8"
    )
    print(f"\nCanon whole. Wrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
