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
# SLOPES ARE THEIR OWN TREE, not a self-pair hiding in the transition matrix. A slope
# tile is one ground raised into a plateau with a graded edge down to ITSELF (maintainer,
# 2026-08-28: "This is a special slope tile and should be saved in a location so you know
# this is a slope"). Filing them under tiles/transitions/<g>__to__<g> would also feed them
# to the wiki's Transitions roster - every pair minus self - where they would read as a
# transition between a ground and itself, which is not what they are.
SLOPES = os.path.join(REPO, "tiles", "slopes")

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


def pairs(self_only=False):
    """Every unordered pair, alphabetical.

    SELF-PAIRS ARE ONLY MEANINGFUL WHEN THE TERRAIN IS RAISED. Flat, a set between a
    material and itself has no boundary to draw - which is why the transition matrix
    excludes them. With `elevation` > 0 the same material becomes a PLATEAU with a
    cliff down to itself, which is exactly the x-to-x task this module parked for
    later (maintainer, 2026-08-28: "clean grass to clean grass", terrain height 4px).
    """
    names = sorted(MATERIALS)
    if self_only:
        return [(n, n) for n in names]
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


def build(amplitudes, seeds, only=None, skip_done=True, account=None,
          elevation=0, step_slope=0.0, self_only=False):
    """Jobs for the matrix, in the order the emitted script runs them.

    Resume works on a FLAT index per pair rather than per amplitude: with more than
    one seed a pair has len(amplitudes)*len(seeds) jobs, and counting tiles against
    amplitudes alone made three finished sets look like three finished amplitudes and
    skipped the pair entirely. The emission order here and the flat index below are
    the same thing, which is what makes "the first n are done" true.
    """
    have = done_ids() if skip_done else set()
    jobs = []
    for a, b in pairs(self_only=self_only):
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
                # A PLATEAU IS DESCRIBED AS THE MAINTAINER TYPED IT. For a self-pair
                # the rich MATERIALS prose ("lush green grass to lush green grass")
                # gives the model two things to differentiate that are the same; his
                # own wording names the flat top we actually want on both levels.
                desc = (f"clean {a.replace('_', ' ')} to clean {a.replace('_', ' ')}"
                        if a == b else f"{MATERIALS[a]} to {MATERIALS[b]}")
                jobs.append({
                    "a": a, "b": b, "description": desc,
                    "amplitude": amp, "seed": seed,
                    "elevation": elevation, "step_slope": step_slope,
                    **GEOMETRY,
                })
    return jobs


def shell_script(jobs, done="run_done.txt", depth_ratio=None):
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
#
# RE-RUNNING IS SAFE. Every finished job is appended to run_done.txt and skipped on
# the next run, so a token that lapses mid-way, a dropped session, or a script fired
# twice costs nothing. (Not a hypothetical: an earlier run produced no output under
# nohup, was re-triggered several times, and bought ~$8 of duplicates and 48 sets of
# one pair.) run_done.txt is also the machine-readable result - `a b amp seed id` per
# line - so nothing has to be scraped out of run.log.
#   To start over deliberately: rm run_done.txt

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

DONE=${DONE:-__DONE__}
touch "$DONE"
# Carry progress over from the first run, which used the older file name. Without this,
# renaming would silently re-buy every set already paid for.
if [ ! -s "$DONE" ] && [ -s plateau_done.txt ]; then
  cp plateau_done.txt "$DONE"
  echo "carried over $(wc -l < "$DONE") job(s) from plateau_done.txt"
fi
echo "resuming: $(wc -l < "$DONE") job(s) already done"

run() {  # a b amp seed elevation step_slope description
  KEY="$1 $2 $3 $4 $5 $6"
  # anchored, so seed 1 is not matched by a line for seed 10
  if grep -q "^${KEY} " "$DONE"; then return; fi
  for TRY in 1 2 3 4 5; do
    R=$(curl -s -w '\n%{http_code}' -X POST https://api.pixellab.ai/tiles/create \
      -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
      -d "{\"description\":\"$7\",\"tile_type\":\"isometric\",\"tile_feature\":\"tileset\",\"tile_size\":64,\"tile_view\":\"high top-down\",\"tile_view_angle\":28,\"tile_depth_ratio\":__DEPTH__,\"tile_flat_top_px\":2,\"outline_mode\":\"segmentation\",\"boundary_amplitude\":$3,\"boundary_seed\":$4,\"elevation\":$5,\"step_slope\":$6}")
    CODE=$(echo "$R" | tail -1)
    if [ "$CODE" = 401 ] || [ "$CODE" = 403 ]; then
      echo 'TOKEN EXPIRED - stopping'; exit 1
    fi
    # 429 is the API pacing us, not a failure: wait and retry the SAME job
    if [ "$CODE" = 429 ]; then
      echo "  rate limited, waiting $((TRY*15))s"; sleep $((TRY*15)); continue
    fi
    ID=$(echo "$R" | head -1 | grep -o '"tile_id":"[^"]*' | cut -d'"' -f4)
    if [ -n "$ID" ]; then
      echo "$KEY $ID" | tee -a "$DONE"
    else
      echo "$KEY FAILED_$CODE"        # not recorded, so a re-run retries it
      # THE FIRST JOB IS A PROBE. A plateau run sends parameter VALUES the flat matrix
      # never did (elevation > 0, a non-zero step_slope), and a rejected value fails
      # identically for every job in the list - a wasted trip for someone driving this
      # from a phone. With nothing yet recorded, stop and print what the API actually
      # said, which is the one thing needed to fix it.
      if [ "$(wc -l < "$DONE")" -eq 0 ]; then
        echo "--- FIRST JOB FAILED, stopping before spending more. API said:"
        echo "$R" | head -1
        exit 1
      fi
    fi
    sleep 4
    return
  done
  echo "$KEY FAILED_RATELIMIT"        # not recorded, so a re-run retries it
}
"""
    head = header.replace("__DONE__", done).replace(
        "__DEPTH__", str(GEOMETRY["tile_depth_ratio"] if depth_ratio is None
                         else depth_ratio))
    lines = [head, f"echo 'generating {len(jobs)} tilesets, est ${len(jobs)*RATE_USD:.2f}'"]
    for j in jobs:
        lines.append(f"run {j['a']} {j['b']} {j['amplitude']} {j['seed']} "
                     f"{j.get('elevation', 0)} {j.get('step_slope', 0)} "
                     f"\"{j['description']}\"")
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--amplitudes", default="0.05,0.11,0.17,0.23")
    ap.add_argument("--seeds", default="1")
    # PLATEAUS: the x-to-x task, run with the maintainer's own web-UI settings
    # (2026-08-28 screenshots): uneven boundary 14%, terrain height 4px, edge
    # steepness mid-slope, thickness 0%, 2px flat top, no outline, 28 degrees.
    ap.add_argument("--slope", "--plateau", dest="slope", action="store_true",
                    help="SLOPE tiles: one ground raised into a plateau with a graded "
                         "edge down to itself, 15 boundary shapes per ground")
    ap.add_argument("--elevation", type=int, default=4, help="terrain height in px")
    ap.add_argument("--step-slope", type=float, default=0.55, help="edge steepness")
    ap.add_argument("--depth-ratio", type=float, default=None,
                    help="tile thickness; 0 = flat top face only")
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
    if a.slope:
        amps = [float(x) for x in a.amplitudes.split(",") if x.strip()] \
            if a.amplitudes != ap.get_default("amplitudes") else [0.14]
        # 15 BOUNDARY SHAPES PER GROUND (maintainer, 2026-08-28 — raised from 8 while
        # the first run was still going). Seeds are stable and the shell resumes from
        # plateau_done.txt on an exact key, so re-running the same script after a raise
        # generates only the new seeds and never re-buys the old ones.
        seeds = seeds if a.seeds != ap.get_default("seeds") else list(range(1, 16))
    jobs = build(amps, seeds, only, skip_done=not a.all, account=acct,
                 elevation=a.elevation if a.slope else 0,
                 step_slope=a.step_slope if a.slope else 0.0,
                 self_only=a.slope)
    out_dir = SLOPES if a.slope else OUT
    os.makedirs(out_dir, exist_ok=True)
    json.dump({"jobs": jobs}, open(os.path.join(out_dir, "jobs.json"), "w"), indent=1)
    if a.shell:
        path = os.path.join(out_dir, "run_slopes.sh" if a.slope
                            else "run_in_cloudshell.sh")
        depth = a.depth_ratio if a.depth_ratio is not None else (0.0 if a.slope else None)
        open(path, "w").write(shell_script(
            jobs, done=("slope_done.txt" if a.slope else "run_done.txt"),
            depth_ratio=depth) + "\n")
        print(f"wrote {path}  ({len(jobs)} jobs, est ${len(jobs)*RATE_USD:.2f})")
    else:
        print(f"pairs {len(pairs())}  amplitudes {amps}  seeds {seeds}")
        print(f"jobs written: {len(jobs)}   est cost ${len(jobs)*RATE_USD:.2f}")
