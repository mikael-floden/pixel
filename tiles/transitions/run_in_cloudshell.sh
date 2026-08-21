#!/usr/bin/env bash
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

DONE=${DONE:-run_done.txt}
touch "$DONE"
echo "resuming: $(wc -l < "$DONE") job(s) already done"

run() {  # a b amp seed description
  KEY="$1 $2 $3 $4"
  # anchored, so seed 1 is not matched by a line for seed 10
  if grep -q "^${KEY} " "$DONE"; then return; fi
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
    if [ -n "$ID" ]; then
      echo "$KEY $ID" | tee -a "$DONE"
    else
      echo "$KEY FAILED_$CODE"        # not recorded, so a re-run retries it
    fi
    sleep 4
    return
  done
  echo "$KEY FAILED_RATELIMIT"        # not recorded, so a re-run retries it
}

echo 'generating 15 tilesets, est $1.19'
run grass light_soil 0.05 1 "lush green grass to dry light soil"
run grass light_soil 0.05 2 "lush green grass to dry light soil"
run grass light_soil 0.05 3 "lush green grass to dry light soil"
run grass light_soil 0.1 1 "lush green grass to dry light soil"
run grass light_soil 0.1 2 "lush green grass to dry light soil"
run grass light_soil 0.1 3 "lush green grass to dry light soil"
run grass light_soil 0.15 1 "lush green grass to dry light soil"
run grass light_soil 0.15 2 "lush green grass to dry light soil"
run grass light_soil 0.15 3 "lush green grass to dry light soil"
run grass light_soil 0.25 1 "lush green grass to dry light soil"
run grass light_soil 0.25 2 "lush green grass to dry light soil"
run grass light_soil 0.25 3 "lush green grass to dry light soil"
run grass light_soil 0.3 1 "lush green grass to dry light soil"
run grass light_soil 0.3 2 "lush green grass to dry light soil"
run grass light_soil 0.3 3 "lush green grass to dry light soil"
