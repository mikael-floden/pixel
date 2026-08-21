"""Build the job list for the isometric transition matrix, and emit it as a shell
script the maintainer runs themselves.

The generation cannot run from this session. The four boundary controls
(boundary_amplitude, boundary_seed, elevation, step_slope) live only on PixelLab's
session-authenticated endpoint; the public /v2 API rejects all four. Driving that
endpoint means holding the maintainer's browser session token, which this agent is
not permitted to do — so the calls are made by the maintainer in Cloud Shell and only
the tile ids come back.

This module owns the part that belongs in the repo: WHICH jobs to run and with what
prompt. --shell prints a self-contained script to paste.

Retrieval is the mirror image: it needs only the API key, costs nothing, and happens
back in this session (see transition_import.py).
"""
import argparse
import json
import os

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "tiles", "transitions")

# Short MATERIAL descriptions. The endpoint wants the terrain named plainly and the
# pair phrased as a transition ("grass to water"); the matrix's isometric-block prose
# makes it draw cross-sections instead.
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

# The house format every existing tile was generated with. Transitions must match it
# exactly or they will not sit correctly beside the material sets.
GEOMETRY = {
    "tile_type": "isometric",
    "tile_feature": "tileset",
    "tile_size": 64,
    "tile_view": "high top-down",
    "tile_view_angle": 28,
    "tile_depth_ratio": 0.5,
    "tile_flat_top_px": 2,
    "outline_mode": "segmentation",
}

# boundary_amplitude is a FRACTION capped at 0.3 by the API (verified: sending 999
# returns "Input should be less than or equal to 0.3"), which matches the web UI's
# 0-30% slider. elevation/step_slope stay at 0 here: raised terrain is the separate
# x-to-x task the maintainer parked for later.
AMP_CAP = 0.3

# MEASURED, not quoted: the isometric tileset endpoint bills ~$0.079 per 16-tile set
# (103 sets cost $8.17). The $0.186 figure used earlier came from /create-tileset, the
# SQUARE top-down model, and overstated this run by 2.4x. A 429 costs nothing at all —
# it is refused before any generation happens.
RATE_USD = 0.079


def pairs():
    """Every unordered pair, alphabetical. No self-pairs — a set between a material
    and itself has no boundary to draw."""
    names = sorted(MATERIALS)
    return [(a, b) for i, a in enumerate(names) for b in names[i + 1:]]


def done_from_account():
    """(pair, amplitude) already generated, read from the PixelLab account.

    The Cloud Shell run can die mid-way — a phone switching apps drops the session —
    so resuming has to work from what actually exists rather than from a local file
    that the interrupted run never wrote. Every generation carries its pair in the
    description and a pair's amplitudes are always run in order, so a pair holding n
    tilesets has the FIRST n amplitudes done.
    """
    import sys as _s
    _s.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from pixellab_client import PixelLabClient
    import transition_import as TI
    c = PixelLabClient()
    rows = TI.listing(c, limit=1000)
    from collections import Counter
    cnt = Counter((r.get("description") or "").strip() for r in rows)
    return cnt


def done_ids():
    """(pair, amp, seed) already generated, from the ids the workflow committed."""
    p = os.path.join(OUT, "tile_ids.json")
    if not os.path.exists(p):
        return set()
    return {(r["a"], r["b"], r["amplitude"], r["seed"])
            for r in json.load(open(p)).get("tiles", [])}


def build(amplitudes, seeds, only=None, skip_done=True, account=None):
    """Jobs for the matrix, in the order the emitted script runs them.

    Resume works on a FLAT index per pair rather than per amplitude: with more than
    one seed a pair has len(amplitudes)*len(seeds) jobs, and counting tiles against
    amplitudes alone made three finished sets look like three finished amplitudes and
    skipped the pair entirely. The emission order here and the flat index below are
    the same thing, which is what makes "the first n are done" true.
    """
    have = done_ids() if skip_done else set()
    jobs = []
    for a, b in pairs():
        if only and f"{a}__to__{b}" not in only:
            continue
        n_done = account.get(f"{MATERIALS[a]} to {MATERIALS[b]}", 0) if account else 0
        k = -1
        for amp in amplitudes:
            if amp > AMP_CAP:
                raise SystemExit(f"amplitude {amp} exceeds the API cap of {AMP_CAP}")
            for seed in seeds:
                k += 1
                if k < n_done:            # generated by an earlier run
                    continue
                if (a, b, amp, seed) in have:
                    continue
                jobs.append({
                    "a": a, "b": b,
                    "description": f"{MATERIALS[a]} to {MATERIALS[b]}",
                    "amplitude": amp, "seed": seed,
                    **GEOMETRY,
                })
    return jobs


def shell_script(jobs):
    """A self-contained Cloud Shell script for `jobs`.

    Prints one tile id per line as `a b amp seed id` so the whole run can be pasted
    straight back, and stops on the first auth failure instead of hammering a lapsed
    token through the rest of the list.
    """
    header = r"""#!/usr/bin/env bash
# Usage in Cloud Shell:
#   export RAW='<paste the whole cookie line from the bookmarklet>'
#   nohup bash run_in_cloudshell.sh > run.log 2>&1 &
#   tail -f run.log        # ctrl-C stops watching, NOT the run
# RAW may be the entire document.cookie dump or a bare eyJ... token.
# nohup matters: a phone switching apps drops the Cloud Shell session, and without
# it the run dies with it. Detached, it keeps going and you reattach with tail.

TOK=$(RAW="$RAW" python3 -c "
import json,os,re,urllib.parse
raw=os.environ.get('RAW','').strip()
t=raw if raw.startswith('eyJ') else None
if not t:
    m=re.search(r'supabase-auth-token=([^;]+)',raw)
    if m:
        try: t=json.loads(urllib.parse.unquote(m.group(1)))[0]
        except Exception: pass
if not t:
    m=re.search(r'(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)',raw)
    t=m.group(1) if m else ''
print(t)")
[ -z "$TOK" ] && { echo 'no token found in $RAW'; exit 1; }
echo "token ok (${#TOK} chars)"

run() {  # a b amp seed description
  for TRY in 1 2 3 4 5; do
    R=$(curl -s -w '\n%{http_code}' -X POST https://api.pixellab.ai/tiles/create \
      -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
      -d "{\"description\":\"$5\",\"tile_type\":\"isometric\",\"tile_feature\":\"tileset\",\"tile_size\":64,\"tile_view\":\"high top-down\",\"tile_view_angle\":28,\"tile_depth_ratio\":0.5,\"tile_flat_top_px\":2,\"outline_mode\":\"segmentation\",\"boundary_amplitude\":$3,\"boundary_seed\":$4,\"elevation\":0,\"step_slope\":0}")
    CODE=$(echo "$R" | tail -1)
    if [ "$CODE" = 401 ] || [ "$CODE" = 403 ]; then
      echo 'TOKEN EXPIRED - stopping'; exit 1
    fi
    # 429 is the API pacing us, not a failure: wait and retry the SAME job
    if [ "$CODE" = 429 ]; then
      echo "  rate limited, waiting $((TRY*15))s"; sleep $((TRY*15)); continue
    fi
    ID=$(echo "$R" | head -1 | grep -o '"tile_id":"[^"]*' | cut -d'"' -f4)
    echo "$1 $2 $3 $4 ${ID:-FAILED_$CODE}"
    sleep 4
    return
  done
  echo "$1 $2 $3 $4 FAILED_RATELIMIT"
}
"""
    lines = [header, f"echo 'generating {len(jobs)} tilesets, est ${len(jobs)*RATE_USD:.2f}'"]
    for j in jobs:
        lines.append(f"run {j['a']} {j['b']} {j['amplitude']} {j['seed']} "
                     f"\"{j['description']}\"")
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--amplitudes", default="0.05,0.11,0.17,0.23")
    ap.add_argument("--seeds", default="1")
    ap.add_argument("--only", default="", help="comma-separated a__to__b, for a test run")
    ap.add_argument("--all", action="store_true", help="ignore what is already generated")
    ap.add_argument("--shell", action="store_true", help="print the Cloud Shell script")
    ap.add_argument("--resume", action="store_true",
                    help="skip what the PixelLab account already has")
    a = ap.parse_args()
    amps = [float(x) for x in a.amplitudes.split(",") if x.strip()]
    seeds = [int(x) for x in a.seeds.split(",") if x.strip()]
    only = {x.strip() for x in a.only.split(",") if x.strip()} or None
    acct = done_from_account() if a.resume else None
    jobs = build(amps, seeds, only, skip_done=not a.all, account=acct)
    os.makedirs(OUT, exist_ok=True)
    json.dump({"jobs": jobs}, open(os.path.join(OUT, "jobs.json"), "w"), indent=1)
    if a.shell:
        path = os.path.join(OUT, "run_in_cloudshell.sh")
        open(path, "w").write(shell_script(jobs) + "\n")
        print(f"wrote {path}  ({len(jobs)} jobs, est ${len(jobs)*RATE_USD:.2f})")
    else:
        print(f"pairs {len(pairs())}  amplitudes {amps}  seeds {seeds}")
        print(f"jobs written: {len(jobs)}   est cost ${len(jobs)*RATE_USD:.2f}")
