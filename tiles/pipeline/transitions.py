"""Tiles 3.0 TRANSITIONS — the Wang boundary sets between every pair of materials.

One /create-tileset call returns a complete 16-tile Wang set for a pair, and that
single set covers BOTH directions: tile 4 is "A with a B corner", tile 11 is "B with
an A corner". The id is a corner bitmask (NW NE SW SE, bit set = `upper`), so the
index of any pattern is fixed for every set we will ever generate and a placement
routine can index it arithmetically instead of looking anything up.

What varies between the sets of one pair is `raggedness` — the API's "uneven
boundary". Every value tiles seamlessly against every other, so several sets per pair
exist purely so a long shoreline does not repeat. The maintainer picked four values
spread across the useful range.

The two terrains are seeded with `lower_base_tile_id` / `upper_base_tile_id`, the
tile ids of our OWN generated material sheets, so a transition is drawn from the
materials this project already shipped rather than re-invented from a text prompt.

x-to-x is deliberately absent: a Wang set between a material and itself has no
boundary to draw. Same-material sets are a future ELEVATION task, which is what
`slope_size` (the API's "terrain height") is for.
"""
import base64
import io
import json
import os
import sys
import threading
import time
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pixellab_client import PixelLabClient  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "tiles", "transitions")

# The maintainer's four boundary values, from their 5..23 list.
RAGGEDNESS = [5, 11, 17, 23]

# Short MATERIAL descriptions. The block prompts used by the matrix describe an
# isometric solid ("a solid block of ... the sides are ..."); this endpoint wants the
# terrain itself, and feeding it the block prose makes it draw cross-sections.
MATERIALS = {
    "black_rock":         "dark volcanic rock",
    "brown_paving_stone": "brown cut paving stone slabs",
    "dark_mud":           "wet dark mud",
    "deep_water":         "deep dark ocean water",
    "grass":              "lush green grass",
    "grey_paving_stone":  "grey cut paving stone slabs",
    "grey_stone":         "rugged grey mountain rock",
    "ice":                "translucent crystal ice",
    "lava":               "molten glowing lava",
    "light_beach":        "pale sandy beach",
    "light_soil":         "dry light soil",
    "parquet_floor":      "wooden parquet floor",
    "slime":              "thick bubbling slime",
    "snow":               "fresh white snow",
    "water":              "clear calm water",
}

VIEW = "high top-down"      # matches the matrix house format
TILE_PX = 64                # 64 requires mode='pro'
MODE = "pro"
SPREAD_X = 0.5
SLOPE = 0.0                 # flat: elevation is a separate future task
TRANSITION_SIZE = 0.0       # 16-tile Wang set; 1.0 would give 25
USD_FLOOR = 1.50            # stop before the account is emptied
RATE_USD = 0.186            # measured cost of one 64px pro tileset call


def load_bases():
    """tile_id per material, read from the matrix metadata that produced it."""
    import glob
    bases = {}
    for m in MATERIALS:
        src = m
        if m.endswith("paving_stone"):
            src = "paving_stone"
        metas = sorted(glob.glob(os.path.join(REPO, "tiles", "matrix",
                                              f"{src}__over__{src}", "*", "meta.json")))
        if metas:
            bases[m] = json.load(open(metas[0]))["tile_id"]
    return bases


def pairs():
    """Every unordered pair, alphabetical. No self-pairs."""
    names = sorted(MATERIALS)
    return [(a, b) for i, a in enumerate(names) for b in names[i + 1:]]


def slug(a, b, r):
    return os.path.join(OUT, f"{a}__to__{b}", f"r{r:02d}")


def done(a, b, r):
    return os.path.exists(os.path.join(slug(a, b, r), "meta.json"))


def _decode(t):
    im = t.get("image")
    b = im.get("base64") if isinstance(im, dict) else im
    if not isinstance(b, str):
        return None
    from PIL import Image
    return Image.open(io.BytesIO(base64.b64decode(b.split(",")[-1]))).convert("RGBA")


def _wang_id(t):
    """Canonical 0-15 index, computed from the CORNERS rather than the returned id.

    The id field is not always the index: when base tile ids are supplied the two
    pure tiles (all-lower and all-upper) come back identified by the BASE TILE's
    uuid, because those tiles are literally our own material art reused. The corner
    map is authoritative in every case. Bit order NW NE SW SE, high to low, a set
    bit meaning `upper` — verified against the API's own numbering (NW,NE,SE upper
    with SW lower is id 13 = 0b1101).
    """
    c = t.get("corners") or {}
    try:
        return (8 * (c["NW"] == "upper") + 4 * (c["NE"] == "upper")
                + 2 * (c["SW"] == "upper") + 1 * (c["SE"] == "upper"))
    except KeyError:
        return None


def generate(client, a, b, r, bases, timeout=900):
    """One pair at one raggedness -> 16 webp tiles + meta.json. Returns usd spent."""
    d = slug(a, b, r)
    os.makedirs(d, exist_ok=True)
    payload = {
        "lower_description": MATERIALS[a],
        "upper_description": MATERIALS[b],
        "tile_size": {"width": TILE_PX, "height": TILE_PX},
        "mode": MODE,
        "view": VIEW,
        "raggedness": r / 100.0,
        "slope_size": SLOPE,
        "spread_x": SPREAD_X,
        "transition_size": TRANSITION_SIZE,
        # deterministic per (pair, raggedness) so a re-run reproduces the same art.
        # NOT hash(): Python randomises string hashing per process, so that would
        # hand a different seed to every run and silently defeat reproducibility.
        "seed": zlib.crc32(f"{a}|{b}|{r}".encode()) % 2_000_000_000,
    }
    if a in bases:
        payload["lower_base_tile_id"] = bases[a]
    if b in bases:
        payload["upper_base_tile_id"] = bases[b]

    resp = client._post("/create-tileset", payload)
    tsid = resp.get("tileset_id")
    job = resp.get("background_job_id")
    if job:
        client.wait_job(job, timeout=timeout)
    rec = client._get(f"/tilesets/{tsid}")
    ts = rec.get("tileset") or {}
    tiles = ts.get("tiles") or []
    if not tiles:
        raise RuntimeError(f"{a}->{b} r{r}: no tiles returned (tileset {tsid})")

    index = {}
    for t in tiles:
        img = _decode(t)
        if img is None:
            continue
        tid = _wang_id(t)
        if tid is None:
            continue
        # LOSSLESS WebP, the project image format. exact=True keeps the RGB under
        # fully transparent pixels; without both flags this silently goes lossy.
        img.save(os.path.join(d, f"tile_{tid:02d}.webp"),
                 "WEBP", lossless=True, exact=True)
        index[tid] = {
            "corners": t.get("corners"),
            "file": f"tile_{tid:02d}.webp",
            "from_base_tile": not str(t.get("id", "")).isdigit(),
        }
    # NOT a balance delta: with several workers in flight a delta captures other
    # workers' spend too (the smoke test billed set 2 at $0.372, exactly double).
    u = (rec.get("usage") or resp.get("usage") or {})
    spent = float(u.get("usd") or 0.0) or RATE_USD
    json.dump({
        "lower": a, "upper": b, "raggedness_pct": r,
        "tileset_id": tsid, "n_tiles": len(index),
        "complete": sorted(index) == list(range(16)),
        "usd": round(spent, 4),
        "settings": {k: v for k, v in payload.items() if k != "seed"},
        "seed": payload["seed"],
        "tiles": {str(k): v for k, v in sorted(index.items())},
        "note": ("id is the corner bitmask NW NE SW SE with a set bit meaning `upper` "
                 f"({b}); id 0 is all {a}, id 15 all {b}. Both directions live in this "
                 "one set."),
    }, open(os.path.join(d, "meta.json"), "w"), indent=1)
    return spent


def run(concurrency=4, limit=None, only_pair=None):
    client = PixelLabClient()
    client.require_key()
    bases = load_bases()
    todo = [(a, b, r) for (a, b) in pairs() for r in RAGGEDNESS if not done(a, b, r)]
    if only_pair:
        todo = [t for t in todo if f"{t[0]}__to__{t[1]}" == only_pair]
    if limit:
        todo = todo[:limit]
    print(f"{len(todo)} sets to generate; ${client.credits_usd():.2f} credits", flush=True)

    lock = threading.Lock()
    state = {"done": 0, "usd": 0.0, "fail": 0, "stop": False}

    def worker():
        while True:
            with lock:
                if state["stop"] or not todo:
                    return
                a, b, r = todo.pop(0)
            try:
                if client.credits_usd() < USD_FLOOR:
                    with lock:
                        state["stop"] = True
                        print(f"STOPPING: credits below ${USD_FLOOR}", flush=True)
                    return
                spent = generate(client, a, b, r, bases)
                with lock:
                    state["done"] += 1
                    state["usd"] += spent
                    print(f"[{state['done']}] {a}__to__{b} r{r:02d}  "
                          f"${spent:.3f}  total ${state['usd']:.2f}", flush=True)
            except Exception as e:
                with lock:
                    state["fail"] += 1
                    print(f"FAIL {a}__to__{b} r{r:02d}: {str(e)[:160]}", flush=True)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(concurrency)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print(f"\ndone={state['done']} failed={state['fail']} spent=${state['usd']:.2f} "
          f"credits left ${client.credits_usd():.2f}", flush=True)
    return state


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--pair", default=None)
    ap.add_argument("--plan", action="store_true")
    a = ap.parse_args()
    if a.plan:
        ps = pairs()
        todo = [(x, y, r) for (x, y) in ps for r in RAGGEDNESS if not done(x, y, r)]
        print(f"materials {len(MATERIALS)}  pairs {len(ps)}  values {RAGGEDNESS}")
        print(f"sets total {len(ps)*len(RAGGEDNESS)}  remaining {len(todo)}")
        print(f"est cost ${len(todo)*0.186:.2f}")
    else:
        run(concurrency=a.concurrency, limit=a.limit, only_pair=a.pair)
