#!/usr/bin/env python3
"""livecheck — does the RUNNING world hold what spawns.json declares?

A spawn zone's `num` is not what the world seeds. The server cuts the map into
a cols x rows grid of rooms (games2/config/zones.json) and each room seeds its
own slice of every zone that reaches into it, rounded on its own:
`Math.round(num * ownCells / allCells)` (WorldRoom.zoneShare). The terms are
rounded independently, so the slices need not add up to `num`:

- a zone with NO room owning half of it rounds to 0 everywhere and is never
  populated — permanently, since a respawn only follows a death;
- a zone split 50/50 over two rooms rounds to 1+1 and seeds TWICE its num.

So this probe models the split from the same inputs the server uses and, with
--origin, checks the model against the live totals. It exists because the file
said 160 and production held 141 (2026-09-22, the halving push) and nothing in
the pipeline could see the difference: spawns.py --check reads the file alone.

  python3 maps2/pipeline/livecheck.py the_game
  python3 maps2/pipeline/livecheck.py the_game --origin https://nangijala.online
"""
import argparse, json, math, os, sys, urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import spawns

REPO = spawns.REPO
ZONE_CFG = os.path.join(REPO, "games2", "config", "zones.json")
CELL_WU = 32            # games2/shared/src/units.ts — fixed, world units per cell


def grid_for(name):
    """The room grid for a world, or None for one-room worlds (no config entry).

    Mirrors zoneGrid (games2/shared/src/zones.ts): a zone is ceil(cells/cols)
    CELLS wide, so the LAST column/row is the short one when it does not divide."""
    cfg = json.load(open(ZONE_CFG)).get(name)
    if not cfg:
        return None
    w = spawns.load_world(name)
    cols, rows = max(1, int(cfg["cols"])), max(1, int(cfg["rows"]))
    zw, zh = math.ceil(w.w / cols) * CELL_WU, math.ceil(w.h / rows) * CELL_WU
    W, H = w.w * CELL_WU, w.h * CELL_WU
    return [(c * zw, r * zh, min(W, (c + 1) * zw), min(H, (r + 1) * zh))
            for r in range(rows) for c in range(cols)]


def seeded(w, zone, rects):
    """What each room seeds of one zone: [(room, own cells, monsters)].

    `spawn_cells` is the same pre-validated surface list the server resolves,
    and a cell carrying two levels counts twice in BOTH halves of the ratio."""
    cells = spawns.spawn_cells(w, zone)
    n = len(cells)
    out = []
    for i, (x0, y0, x1, y1) in enumerate(rects):
        own = sum(1 for (cx, cy, _l) in cells
                  if x0 <= (cx + 0.5) * CELL_WU < x1 and y0 <= (cy + 0.5) * CELL_WU < y1)
        if not own:
            continue
        # JS Math.round rounds a half UP, which Python's round() does not.
        share = math.floor(zone["num"] * own / n + 0.5) if n else zone["num"]
        out.append((i, own, min(share, own)))
    return out


def live_total(origin, name):
    """Monsters the running world holds, summed over that world's rooms."""
    with urllib.request.urlopen(origin.rstrip("/") + "/api/stats", timeout=30) as r:
        stats = json.load(r)
    rooms = [x for x in stats["rooms"] if x["world"] == name]
    return sum(x["monsters"] for x in rooms), len(rooms)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("world", nargs="?", default="the_game")
    ap.add_argument("--origin", help="also compare against a running server")
    a = ap.parse_args()

    w = spawns.load_world(a.world)
    doc = json.load(open(os.path.join(spawns.world_dir(a.world), "spawns.json")))
    zones = doc.get("zones") or doc.get("spawns") or []
    rects = grid_for(a.world)
    declared = sum(z["num"] for z in zones)

    if rects is None:
        print(f"{a.world}: one room for the map — every zone seeds its num. "
              f"{len(zones)} zone(s), {declared} monsters.")
        return 0

    empty, over, modelled = [], [], 0
    for z in zones:
        rooms = seeded(w, z, rects)
        got = sum(m for _, _, m in rooms)
        modelled += got
        if got == 0:
            empty.append((z, rooms))
        elif got > z["num"]:
            over.append((z, rooms, got))

    print(f"{a.world}: {len(zones)} zone(s) over {len(rects)} room(s)")
    print(f"  declared in spawns.json : {declared}")
    print(f"  the rooms actually seed : {modelled}")
    for z, rooms in empty:
        split = " + ".join(f"room{i} {o * 100 // sum(x[1] for x in rooms)}%" for i, o, _ in rooms)
        print(f"  EMPTY  {z['id']} ({z['monster']}, num {z['num']}): {split} — no room owns half")
    for z, rooms, got in over:
        print(f"  DOUBLE {z['id']} ({z['monster']}): num {z['num']} seeds {got}")

    if a.origin:
        total, nrooms = live_total(a.origin, a.world)
        print(f"  {a.origin} holds      : {total} in {nrooms} room(s)")
        # Per-room counts drift as monsters roam across a border and are
        # transferred; the TOTAL is conserved, so that is what is compared.
        if total != modelled:
            print(f"  MISMATCH: live {total} != modelled {modelled}")
            return 1

    return 1 if (empty or over) else 0


if __name__ == "__main__":
    raise SystemExit(main())
