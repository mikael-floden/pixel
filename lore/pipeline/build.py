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

# House limits from lore/canon/CONSTRAINTS.md section 6. The wiki reserves the
# height of the longest blurb in a domain, so one long entry inflates every
# page in that domain.
MAX_BLURB = 200
MAX_SUMMARY = 200

# The wiki inserts every string as a text node: markup ships as literal
# characters. Catch the syntaxes a writer reaches for by reflex.
MARKUP = re.compile(r"\[\[|\]\]|<[a-zA-Z/]|\*\*|^#{1,6}\s|^\s*[-*]\s", re.M)

ID_RE = re.compile(r"^[a-z0-9_-]+$")


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


def validate(entries, entities, live) -> tuple[list[str], list[str]]:
    problems: list[str] = []
    drift: list[str] = []

    lore_ids = {e.get("id") for e in entries}

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
        blurb = rec.get("blurb", "")
        if not blurb:
            problems.append(f"{where}: missing blurb")
        else:
            check_text(where, "blurb", blurb, MAX_BLURB, problems)
        for n, para in enumerate(rec.get("story") or []):
            if not isinstance(para, str):
                problems.append(f"{where}: story[{n}] is not a string")
            elif MARKUP.search(para):
                problems.append(f"{where}: story[{n}] contains markup")
        check_related(where, rec.get("related"))

    return problems, drift


# ---------------------------------------------------------------- rollup

def build(entries, entities) -> dict:
    by_domain: dict[str, dict[str, dict]] = {}
    for rec in entities:
        payload = {"lore": rec["blurb"]}
        if rec.get("story"):
            payload["story"] = rec["story"]
        if rec.get("related"):
            payload["related"] = rec["related"]
        by_domain.setdefault(rec["domain"], {})[rec["id"]] = payload

    published = []
    for e in sorted(entries, key=lambda x: (x.get("chapter") or 999, x.get("id", ""))):
        out = {
            "id": e["id"],
            "name": e["name"],
            "path": f"lore/entries/{e['id']}",
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
            "Authored by the lore agent. 'entities' are per-entity blurbs keyed by "
            "the owning domain's folder id — merge them where a domain has no text "
            "of its own; the domain's own copy always wins. 'entries' are "
            "standalone lore articles (chapters, peoples, places). Plain text "
            "only. Cross-references are {domain, id} pairs."
        ),
        "entities": by_domain,
        "entries": published,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="validate only, write nothing")
    args = ap.parse_args()

    entries, entities = load_entries(), load_entities()
    live = live_ids()
    problems, drift = validate(entries, entities, live)

    for line in drift:
        print(f"DRIFT   {line}")
    for line in problems:
        print(f"BROKEN  {line}")

    counts = " · ".join(f"{d} {len(v)}" for d, v in sorted(live.items()))
    print(
        f"\nlore: {len(entries)} entries, {len(entities)} entity records\n"
        f"repo: {counts}"
    )

    if problems:
        print(f"\nCANON BROKEN — {len(problems)} problem(s). Nothing written.")
        return 1

    if args.check:
        print("\nCanon whole. (--check: nothing written.)")
        return 0

    out = LORE / "lore.json"
    out.write_text(json.dumps(build(entries, entities), indent=2) + "\n", encoding="utf-8")
    print(f"\nCanon whole. Wrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
